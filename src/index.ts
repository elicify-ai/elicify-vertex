/**
 * elicify-fable-transform
 * --------------------------------------------------------------------------
 * An opencode plugin that injects harness directives into the **LLM input**
 * via the official `chat.system.transform` and `chat.messages.transform` hooks.
 *
 * Why this plugin exists
 * ----------------------
 * Claude's plugin model lets you return `hookSpecificOutput.additionalContext`
 * from a `PostToolUse` hook — the runtime injects it as a *separate user
 * message* into the model's next turn. That is a strong steering signal.
 *
 * opencode's SDK does not (yet) have an equivalent post-tool injection hook
 * whose output becomes a new message. The closest non-deprecated options are:
 *
 *   1. `experimental.chat.system.transform`  — append to the system prompt
 *      for the next turn. Has `sessionID` in its input. **Recommended.**
 *   2. `experimental.chat.messages.transform` — rewrite the full messages
 *      array. Does **not** expose `sessionID` in current typings; treat as
 *      a global, last-resort hook.
 *   3. `tool.execute.after`  — stamping `output.output` reaches the LLM,
 *      but as the **tool's reply**, not as a directive. Weak steering.
 *
 * This plugin implements (1) and (2) correctly, with a tiny per-session
 * queue so any hook in your plugin (Stop, PostToolUse, custom events) can
 * enqueue a directive and have it land as a *system instruction* on the
 * next LLM call.
 *
 * It is a reference implementation, not a finished product. The default
 * directive is a verification reminder so the plugin is immediately useful
 * in an elicify-fable harness, but the real value is the queue + transform
 * wiring.
 *
 * @see https://opencode.ai/docs/plugins/
 */

import { randomUUID } from "node:crypto"
import type { Plugin } from "@opencode-ai/plugin"

/** Minimal TextPart shape used by `experimental.chat.messages.transform`. */
type TextPart = {
  id: string
  type: "text"
  text: string
  sessionID: string
  messageID: string
  synthetic?: boolean
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single directive to be appended to the LLM's input on the next turn. */
export interface Directive {
  /** Stable id (e.g. "post-tool:evidence" or "stop:block"). */
  readonly id: string
  /** Text the LLM will see as part of the system prompt. */
  readonly text: string
  /** Optional ISO timestamp for ordering + debugging. */
  readonly at?: string
}

export interface ElicifyFableTransformOptions {
  /**
   * Cap on how many directives can be queued per session. Once exceeded,
   * the oldest directive is dropped. Default: 16.
   */
  readonly maxPerSession?: number

  /**
   * If true, also wire `experimental.chat.messages.transform` as a global
   * drain (uses the messages-array rewrite, no sessionID). Default: true.
   * Set false to keep behaviour strictly per-session.
   */
  readonly wireMessagesTransform?: boolean

  /**
   * A producer that returns a list of "always-on" directives to inject on
   * every turn. Use this for the elicify-fable contract block. Return []
   * to disable. Default: a minimal verification-reminder.
   */
  readonly systemDirectives?: () => readonly Directive[]
}

// ---------------------------------------------------------------------------
// Per-session queue
// ---------------------------------------------------------------------------

/**
 * Tiny FIFO queue of directives, keyed by sessionID. Thread-safe in the JS
 * sense — every operation is synchronous and opencode's plugin runtime is
 * single-threaded per session.
 */
class DirectiveQueue {
  private readonly cap: number
  private readonly bySession = new Map<string, Directive[]>()

  constructor(cap: number) {
    this.cap = Math.max(1, cap)
  }

  enqueue(sessionID: string, directive: Directive): void {
    if (!sessionID || !directive?.text) return
    const q = this.bySession.get(sessionID) ?? []
    q.push({ ...directive, at: directive.at ?? new Date().toISOString() })
    while (q.length > this.cap) q.shift()
    this.bySession.set(sessionID, q)
  }

  /** Returns and clears all directives for the session. */
  drain(sessionID: string): Directive[] {
    const q = this.bySession.get(sessionID)
    if (!q || q.length === 0) return []
    this.bySession.delete(sessionID)
    return q
  }

  /** Returns and clears directives across ALL sessions. */
  drainAll(): Array<Directive & { sessionID: string }> {
    const out: Array<Directive & { sessionID: string }> = []
    for (const [sessionID, q] of this.bySession) {
      for (const d of q) out.push({ ...d, sessionID })
      this.bySession.delete(sessionID)
    }
    return out
  }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const DEFAULT_BLOCK = `[elicify-fable] Verification reminder: before reporting a task as done,
- observe the actual output of the change (run the test, render the artifact, hit the endpoint);
- ground any "done" claim in a tool result from this turn, not in intent;
- if a step failed and you cannot fix it, surface that explicitly.
What counts as verification: a Bash tool call (not echo/true/cat) that exited 0 with non-empty stdout. A Write/Edit success message is authoring, not verifying.
A passing test is not evidence until you have confirmed the test can fail. If you did not break the test to verify it detects failure, state that as a caveat.
Automated tests often do not surface real issues. Before claiming something works, control it yourself — run it manually, observe the actual behavior, and if browser tools are available, use them to see the rendered output. Tests are a safety net, not a substitute for looking.
Communicate in a calm, factual tone. Lead with the outcome. Avoid enthusiasm, apology, or performative framing.`

function defaultDirectives(): readonly Directive[] {
  return [
    {
      id: "elicify-fable:contract",
      text: DEFAULT_BLOCK,
    },
  ]
}

/** Format a list of directives as a single block for the system prompt. */
export function formatDirectives(directives: readonly Directive[]): string | null {
  if (directives.length === 0) return null
  const stamp = new Date().toISOString()
  const body = directives
    .map((d) => `[${d.id}${d.at ? ` @ ${d.at}` : ""}]\n${d.text.trim()}`)
    .join("\n\n---\n\n")
  return `<elicify-fable-directives ts="${stamp}">\n${body}\n</elicify-fable-directives>`
}

// ---------------------------------------------------------------------------
// Plugin entrypoint
// ---------------------------------------------------------------------------

/**
 * Opencode plugin entrypoint. Wire it in `opencode.json`:
 *
 *   { "plugin": ["elicify-fable-transform"] }
 *
 * Exposes:
 *   - `enqueue(sessionID, directive)` — call from any other plugin (or from
 *     your own Stop / PostToolUse hooks) to inject a directive on the
 *     next LLM turn.
 *   - `experimental.chat.system.transform` — appends queued + always-on
 *     directives to the system prompt. **This is the correct hook.**
 *   - `experimental.chat.messages.transform` — optional global drain of
 *     all queued directives, written into the last assistant turn. Use
 *     only if `system.transform` is unavailable.
 */
export const ElicifyFableTransformPlugin: Plugin = async (ctx) => {
  const opts: Required<ElicifyFableTransformOptions> = {
    maxPerSession: 16,
    wireMessagesTransform: true,
    systemDirectives: defaultDirectives,
    ...(ctx as unknown as ElicifyFableTransformOptions),
  }

  const queue = new DirectiveQueue(opts.maxPerSession)
  const alwaysOn = () => opts.systemDirectives().map((d) => ({ ...d }))

  return {
    /**
     * Optional companion API exposed on the plugin return value so other
     * plugins (or your own custom hooks) can enqueue directives:
     *
     *   const t = await ElicifyFableTransformPlugin(ctx)
     *   t.enqueue(sessionID, { id: "stop:block", text: "..." })
     *
     * Opencode's plugin API doesn't surface a "shared registry" object
     * between plugins, so in practice each plugin holds its own queue.
     * If you need cross-plugin injection, lift the queue into a separate
     * module and import it from both plugins.
     */
    enqueue(sessionID: string, directive: Directive): void {
      queue.enqueue(sessionID, directive)
    },

    /**
     * Append queued + always-on directives to the system prompt for the
     * next LLM call. This is the **SDK-native, correct** place to inject
     * post-tool evidence, stop-block reminders, and per-session
     * instructions.
     */
    async "experimental.chat.system.transform"(input, output) {
      const sessionID = input.sessionID
      const queued = sessionID ? queue.drain(sessionID) : []
      const combined: Directive[] = [...alwaysOn(), ...queued]
      const block = formatDirectives(combined)
      if (!block) return
      // Append (do not replace) so other plugins' system transforms are
      // preserved.
      output.system = [...output.system, block]
    },

    /**
     * Optional fallback: rewrite the messages array so any undrained
     * directives from sessions whose system.transform did not fire still
     * reach the LLM. Tagged into the last message as a synthetic note.
     *
     * The SDK does not currently expose `sessionID` to this hook, so we
     * drain globally. This is intentionally lossy — prefer system.transform.
     */
    ...(opts.wireMessagesTransform
      ? {
          async "experimental.chat.messages.transform"(_input, output) {
            const undrained = queue.drainAll()
            if (undrained.length === 0) return
            const block = formatDirectives(undrained)
            if (!block) return
            const last = output.messages[output.messages.length - 1]
            if (!last) return
            const part: TextPart = {
              id: `prt_${randomUUID().replace(/-/g, "")}`,
              type: "text",
              text: `\n\n${block}\n`,
              synthetic: true,
              sessionID: last.info.sessionID,
              messageID: last.info.id,
            }
            last.parts.push(part)
          },
        }
      : {}),
  }
}

export default ElicifyFableTransformPlugin
