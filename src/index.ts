/**
 * elicify-vertex
 * --------------------------------------------------------------------------
 * An opencode plugin that injects harness directives into the **LLM input**
 * via the official `chat.system.transform` and `chat.messages.transform` hooks.
 *
 * What it does
 * ------------
 * Makes the model prove its work before claiming done. Enforces verification,
 * evidence, and communication discipline as procedure — not as luck.
 *
 * Gating
 * ------
 * The plugin is always *loaded* but only *active* for sessions where:
 *   - the active agent is `elicify-vertex-helmsman`, OR
 *   - the user invoked the `/vertex` skill.
 * Other agents (build, plan, etc.) get zero injection and zero overhead.
 *
 * How it works
 * ------------
 * opencode's SDK exposes two transform hooks:
 *
 *   1. `experimental.chat.system.transform`  — append to the system prompt
 *      for the next turn. Has `sessionID` in its input. **Recommended.**
 *   2. `experimental.chat.messages.transform` — rewrite the full messages
 *      array. Does **not** expose `sessionID` in current typings; treat as
 *      a global, last-resort hook.
 *
 * This plugin implements both, with a tiny per-session queue so any hook
 * (Stop, PostToolUse, custom events) can enqueue a directive and have it
 * land as a *system instruction* on the next LLM call.
 *
 * Inspired by the behavioral patterns of Claude Fable 5 — but stands on its
 * own as a model-agnostic verification harness.
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

export interface ElicifyVertexOptions {
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
   * every turn. Use this for the vertex contract block. Return []
   * to disable. Default: a minimal verification-reminder.
   */
  readonly systemDirectives?: () => readonly Directive[]

  /**
   * Agent name that activates the plugin for a session. When the active
   * agent matches this name, the plugin injects directives. Default:
   * "elicify-vertex-helmsman".
   */
  readonly activeAgent?: string

  /**
   * Skill trigger text that activates the plugin for a session. When the
   * user's message contains this string, the plugin activates. Default:
   * "/vertex".
   */
  readonly activeSkillTrigger?: string
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
// Session activation gate
// ---------------------------------------------------------------------------

/**
 * Tracks which sessions have the vertex agent or skill active.
 * The `chat.message` hook sets/clears flags; the transform hooks read them.
 */
class SessionGate {
  private readonly active = new Set<string>()

  activate(sessionID: string): void {
    if (sessionID) this.active.add(sessionID)
  }

  deactivate(sessionID: string): void {
    this.active.delete(sessionID)
  }

  isActive(sessionID: string | undefined): boolean {
    return !!sessionID && this.active.has(sessionID)
  }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const DEFAULT_BLOCK = `[vertex] Verification reminder: before reporting a task as done,
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
      id: "vertex:contract",
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
  return `<vertex-directives ts="${stamp}">\n${body}\n</vertex-directives>`
}

// ---------------------------------------------------------------------------
// Plugin entrypoint
// ---------------------------------------------------------------------------

/**
 * Opencode plugin entrypoint. Wire it in `opencode.json`:
 *
 *   { "plugin": ["elicify-vertex"] }
 *
 * The plugin is always loaded but only injects directives for sessions
 * where the active agent is `elicify-vertex-helmsman` or the `/vertex`
 * skill was invoked. Other sessions get zero overhead.
 */
export const ElicifyVertexPlugin: Plugin = async (ctx) => {
  const opts: Required<ElicifyVertexOptions> = {
    maxPerSession: 16,
    wireMessagesTransform: true,
    systemDirectives: defaultDirectives,
    activeAgent: "elicify-vertex-helmsman",
    activeSkillTrigger: "/vertex",
    ...(ctx as unknown as ElicifyVertexOptions),
  }

  const queue = new DirectiveQueue(opts.maxPerSession)
  const gate = new SessionGate()
  const alwaysOn = () => opts.systemDirectives().map((d) => ({ ...d }))

  return {
    /**
     * Session gate: check the active agent and message text on every user
     * message. If the agent is the Helmsman or the message contains the
     * skill trigger, activate the session. If the agent changed to something
     * else, deactivate.
     */
    async "chat.message"(input, output) {
      try {
        const agent = input.agent
        const text = (output.parts || [])
          .filter((p) => p && p.type === "text" && typeof (p as any).text === "string")
          .map((p) => (p as any).text)
          .join("\n")

        if (agent === opts.activeAgent || text.includes(opts.activeSkillTrigger)) {
          gate.activate(input.sessionID)
        } else if (agent && agent !== opts.activeAgent) {
          // User switched to a different agent — deactivate
          gate.deactivate(input.sessionID)
        }
      } catch {}
    },

    /**
     * Optional companion API: enqueue a directive for a session. The
     * directive will only be injected if the session is active (the
     * Helmsman agent is selected or /vertex was invoked).
     */
    enqueue(sessionID: string, directive: Directive): void {
      queue.enqueue(sessionID, directive)
    },

    /**
     * Append queued + always-on directives to the system prompt for the
     * next LLM call — but ONLY if the session is vertex-active.
     * This is the **SDK-native, correct** place to inject post-tool
     * evidence, stop-block reminders, and per-session instructions.
     */
    async "experimental.chat.system.transform"(input, output) {
      const sessionID = input.sessionID
      if (!gate.isActive(sessionID)) return
      const queued = sessionID ? queue.drain(sessionID) : []
      const combined: Directive[] = [...alwaysOn(), ...queued]
      const block = formatDirectives(combined)
      if (!block) return
      output.system = [...output.system, block]
    },

    /**
     * Optional fallback: rewrite the messages array so any undrained
     * directives from ACTIVE sessions still reach the LLM. Directives
     * from inactive sessions are silently dropped.
     *
     * The SDK does not currently expose `sessionID` to this hook, so we
     * drain globally and filter by the gate. This is intentionally
     * lossy — prefer system.transform.
     */
    ...(opts.wireMessagesTransform
      ? {
          async "experimental.chat.messages.transform"(_input, output) {
            const undrained = queue.drainAll()
            const active = undrained.filter((d) => gate.isActive(d.sessionID))
            if (active.length === 0) return
            const block = formatDirectives(active)
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

export default ElicifyVertexPlugin
