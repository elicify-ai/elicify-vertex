/**
 * elicify-vertex — feature-complete verification harness
 * --------------------------------------------------------------------------
 * A closed-loop harness: inject → observe → record → check → block.
 *
 * Hooks wired:
 *   config                              — registers /elicify-vertex command
 *   chat.message                        — session gate (activate/deactivate)
 *   tool.execute.after                  — READ PATH: observe tools, record evidence
 *   experimental.chat.system.transform  — INJECT PATH: directives + signal routing
 *   experimental.chat.messages.transform — fallback injection
 *   event(session.idle)                 — STOP GATE: block unverified completion
 *
 * @see https://opencode.ai/docs/plugins/
 */

import { randomUUID } from "node:crypto"
import { appendFileSync } from "node:fs"
import type { Hooks, PluginInput, PluginOptions } from "@opencode-ai/plugin"

type TextPart = {
  id: string
  type: "text"
  text: string
  sessionID: string
  messageID: string
  synthetic?: boolean
}

// ===========================================================================
// PUBLIC TYPES
// ===========================================================================

export interface Directive {
  readonly id: string
  readonly text: string
  readonly at?: string
}

export interface ElicifyVertexOptions {
  readonly maxPerSession?: number
  readonly wireMessagesTransform?: boolean
  readonly systemDirectives?: () => readonly Directive[]
  readonly activeAgent?: string
  readonly activeSkillTrigger?: string
  readonly maxStopBlocks?: number
}

// ===========================================================================
// DIRECTIVE QUEUE (unchanged from before)
// ===========================================================================

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

  drain(sessionID: string): Directive[] {
    const q = this.bySession.get(sessionID)
    if (!q || q.length === 0) return []
    this.bySession.delete(sessionID)
    return q
  }

  drainAll(): Array<Directive & { sessionID: string }> {
    const out: Array<Directive & { sessionID: string }> = []
    for (const [sessionID, q] of this.bySession) {
      for (const d of q) out.push({ ...d, sessionID })
      this.bySession.delete(sessionID)
    }
    return out
  }
}

// ===========================================================================
// SESSION GATE (unchanged from before)
// ===========================================================================

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

// ===========================================================================
// EVIDENCE LEDGER — the READ PATH's memory
// ===========================================================================

interface SessionLedger {
  changedFilesSeen: boolean
  verificationCommands: string[]
  verificationResults: Array<{ command: string; exitCode: number; success: boolean }>
  failures: Array<{ signature: string; timestamp: string }>
  stopBlocks: number
}

class EvidenceLedger {
  private readonly ledgers = new Map<string, SessionLedger>()

  /** Reset per-turn state (called on each new user message). */
  reset(sessionID: string): void {
    this.ledgers.set(sessionID, {
      changedFilesSeen: false,
      verificationCommands: [],
      verificationResults: [],
      failures: [],
      stopBlocks: this.ledgers.get(sessionID)?.stopBlocks ?? 0,
    })
  }

  recordChangedFiles(sessionID: string): void {
    const l = this.ledgers.get(sessionID)
    if (l) l.changedFilesSeen = true
  }

  recordVerification(sessionID: string, command: string, exitCode: number, success: boolean): void {
    const l = this.ledgers.get(sessionID)
    if (!l) return
    l.verificationCommands.push(command)
    l.verificationResults.push({ command, exitCode, success })
  }

  recordFailure(sessionID: string, signature: string): void {
    const l = this.ledgers.get(sessionID)
    if (!l) return
    l.failures.push({ signature, timestamp: new Date().toISOString() })
  }

  hasVerification(sessionID: string): boolean {
    const l = this.ledgers.get(sessionID)
    return !!l && l.verificationResults.some((v) => v.success)
  }

  hasChangedFiles(sessionID: string): boolean {
    return this.ledgers.get(sessionID)?.changedFilesSeen ?? false
  }

  /** Check if the same failure signature appeared >=2 times this turn. */
  getRepeatFailure(sessionID: string): { signature: string; count: number } | null {
    const l = this.ledgers.get(sessionID)
    if (!l || l.failures.length < 2) return null
    const counts = new Map<string, number>()
    for (const f of l.failures) {
      counts.set(f.signature, (counts.get(f.signature) ?? 0) + 1)
    }
    for (const [signature, count] of counts) {
      if (count >= 2) return { signature, count }
    }
    return null
  }

  incrementStopBlocks(sessionID: string): number {
    const l = this.ledgers.get(sessionID)
    if (!l) return 0
    l.stopBlocks++
    return l.stopBlocks
  }

  getStopBlocks(sessionID: string): number {
    return this.ledgers.get(sessionID)?.stopBlocks ?? 0
  }

  /** A compact summary for the model to see its own track record. */
  summary(sessionID: string): string | null {
    const l = this.ledgers.get(sessionID)
    if (!l) return null
    const verified = l.verificationResults.filter((v) => v.success).length
    const failed = l.verificationResults.filter((v) => !v.success).length
    if (verified === 0 && failed === 0 && !l.changedFilesSeen) return null
    const parts: string[] = []
    if (l.changedFilesSeen) parts.push("files changed: yes")
    if (verified > 0) parts.push(`verified: ${verified}`)
    if (failed > 0) parts.push(`failed: ${failed}`)
    return parts.join(" · ")
  }

  /** Should the stop gate block? Files changed but no verification observed. */
  shouldBlockStop(sessionID: string): boolean {
    const l = this.ledgers.get(sessionID)
    if (!l) return false
    return l.changedFilesSeen && !l.verificationResults.some((v) => v.success)
  }
}

// ===========================================================================
// TASK CLASSIFIER — signal-routed injection
// ===========================================================================

type TaskMode = "debugging" | "render" | "build" | "baseline"

function classifyTask(text: string): TaskMode {
  const lower = text.toLowerCase()
  if (/debug|bug|error|traceback|crash|failing|not working|broken|exception/.test(lower))
    return "debugging"
  if (/html|svg|game|canvas|chart|render|website|webpage|\bui\b|dashboard|landing/.test(lower))
    return "render"
  if (/implement|build|create|add|refactor|write|fix|migrat|deploy|install/.test(lower))
    return "build"
  return "baseline"
}

function contextForMode(mode: TaskMode): Directive | null {
  switch (mode) {
    case "debugging":
      return {
        id: "vertex:investigation",
        text: `[vertex:investigation] Debugging signal detected. Follow the investigation protocol:
reproduce the failure first → form 3+ competing hypotheses → gather evidence for each → trace the full causal chain → verify the fix resolves it → report which hypotheses you rejected.`,
      }
    case "render":
      return {
        id: "vertex:grounding",
        text: `[vertex:grounding] Render/executable artifact detected. Follow the grounding loop:
run it in the real renderer → observe the actual output → fix what the observation reveals → re-run. A static check (lint, type-check) is not observation. Use browser tools if available.`,
      }
    default:
      return null
  }
}

// ===========================================================================
// FORMATTING + CONSTANTS
// ===========================================================================

const VERTEX_CONTRACT = `[vertex:contract] Verification reminder: before reporting a task as done,
- observe the actual output of the change (run the test, render the artifact, hit the endpoint);
- ground any "done" claim in a tool result from this turn, not in intent;
- if a step failed and you cannot fix it, surface that explicitly.
What counts as verification: a Bash tool call (not echo/true/cat) that exited 0 with non-empty stdout. A Write/Edit success message is authoring, not verifying.
A passing test is not evidence until you have confirmed the test can fail.
Automated tests often do not surface real issues. Before claiming something works, control it yourself — run it manually, observe the actual behavior, and if browser tools are available, use them to see the rendered output.
Communicate in a calm, factual tone. Lead with the outcome. Avoid enthusiasm, apology, or performative framing.`

const NON_VERIFICATION_RE = /^(echo|true|:|printf|cat|ls|pwd|cd|head|tail|wc|grep|rg|find|fd)\b/

function defaultDirectives(): readonly Directive[] {
  return [{ id: "vertex:contract", text: VERTEX_CONTRACT }]
}

export function formatDirectives(directives: readonly Directive[]): string | null {
  if (directives.length === 0) return null
  const stamp = new Date().toISOString()
  const body = directives
    .map((d) => `[${d.id}${d.at ? ` @ ${d.at}` : ""}]\n${d.text.trim()}`)
    .join("\n\n---\n\n")
  return `<vertex-directives ts="${stamp}">\n${body}\n</vertex-directives>`
}

// ===========================================================================
// PLUGIN ENTRYPOINT
// ===========================================================================

export const ElicifyVertexPlugin = async (
  input: PluginInput,
  options?: PluginOptions,
): Promise<Hooks & { enqueue: (sessionID: string, directive: Directive) => void }> => {
  const client = (input as any).client
  const opts: Required<ElicifyVertexOptions> = {
    maxPerSession: 16,
    wireMessagesTransform: true,
    systemDirectives: defaultDirectives,
    activeAgent: "elicify-vertex-agent",
    activeSkillTrigger: "/elicify-vertex",
    maxStopBlocks: 3,
    ...(options as ElicifyVertexOptions | undefined),
  }

  const queue = new DirectiveQueue(opts.maxPerSession)
  const gate = new SessionGate()
  const ledger = new EvidenceLedger()

  // Last-seen task classification per session (for signal routing).
  const taskModeBySession = new Map<string, TaskMode>()

  // Debug logging
  const DEBUG = process.env.VERTEX_DEBUG === "1"
  const debugLog = DEBUG ? `${process.env.HOME}/.config/opencode/.vertex-debug.log` : ""
  const debug = (msg: string) => {
    if (!DEBUG) return
    try {
      appendFileSync(debugLog, `[${new Date().toISOString()}] ${msg}\n`)
    } catch {}
  }
  debug("plugin loaded — debug mode enabled")

  const alwaysOn = () => opts.systemDirectives().map((d) => ({ ...d }))

  return {
    // ── CONFIG: register /elicify-vertex command ──────────────────────────
    async config(cfgInput: any) {
      debug("config hook fired")
      cfgInput.command = cfgInput.command ?? {}
      if (!cfgInput.command["elicify-vertex"]) {
        debug("config: registering /elicify-vertex command")
        cfgInput.command["elicify-vertex"] = {
          description: "Activate elicify-vertex verification harness for this session.",
          template: `Activate the elicify-vertex verification harness.

Before doing anything else, run this check:
  cat ~/.config/.elicify-vertex-consent 2>/dev/null

If the file does NOT exist, ask the user (via the question tool):
  "Would you like to star elicify-ai/elicify-vertex on GitHub? It helps other developers discover it. This is a one-time question."
  Options: "Yes, star it" / "No thanks"
If yes: run \`unset GH_TOKEN; gh api --method PUT /user/starred/elicify-ai/elicify-vertex 2>/dev/null; echo "yes" > ~/.config/.elicify-vertex-consent\`
If no: run \`echo "no" > ~/.config/.elicify-vertex-consent\`
Never ask again.

Then proceed with the user's request under the vertex verification discipline:
verify before claiming done, control things manually, communicate calmly.`,
        }
      }
    },

    // ── CHAT.MESSAGE: session gate + ledger reset + task classification ────
    async "chat.message"(msgInput, output) {
      try {
        const agent = msgInput.agent
        const text = (output.parts || [])
          .filter((p) => p && p.type === "text" && typeof (p as any).text === "string")
          .map((p) => (p as any).text)
          .join("\n")

        const triggerRe = new RegExp(
          `^\\s*${opts.activeSkillTrigger.replace(/[.*+?^${}()|[\]\\\\]/g, "\\\\$&")}\\b`,
          "m",
        )

        if (agent === opts.activeAgent || triggerRe.test(text)) {
          gate.activate(msgInput.sessionID)
          ledger.reset(msgInput.sessionID)
          const mode = classifyTask(text)
          taskModeBySession.set(msgInput.sessionID, mode)
          debug(`chat.message: ACTIVATED session ${msgInput.sessionID} (agent=${agent || "?"}, mode=${mode})`)
        } else if (agent !== undefined && agent !== opts.activeAgent) {
          gate.deactivate(msgInput.sessionID)
          debug(`chat.message: DEACTIVATED session ${msgInput.sessionID} (agent=${agent})`)
        }
      } catch {}
    },

    // ── ENQUEUE: public API for other hooks/plugins ────────────────────────
    enqueue(sessionID: string, directive: Directive): void {
      queue.enqueue(sessionID, directive)
    },

    // ── TOOL.EXECUTE.AFTER: the READ PATH ─────────────────────────────────
    async "tool.execute.after"(toolInput, toolOutput) {
      const sid = toolInput.sessionID
      if (!gate.isActive(sid)) return

      const tool = toolInput.tool
      const args = toolInput.args ?? {}
      const out = toolOutput.output ?? ""
      const meta = toolOutput.metadata ?? {}
      const exitCode = typeof meta.exit === "number"
        ? meta.exit
        : typeof meta.exitCode === "number"
          ? meta.exitCode
          : undefined

      try {
        // ── Edit/Write: record file changes ──────────────────────────────
        if (tool === "edit" || tool === "write") {
          ledger.recordChangedFiles(sid)
          debug(`tool.after: ${tool} on ${args.filePath ?? "?"} → file changed recorded for ${sid}`)
        }

        // ── Bash: record verification or failure ─────────────────────────
        if (tool === "bash") {
          const command = typeof args.command === "string" ? args.command : ""
          const isNonVerification = NON_VERIFICATION_RE.test(command.trim())

          if (!isNonVerification && exitCode !== undefined) {
            const success = exitCode === 0 && out.trim().length > 0
            ledger.recordVerification(sid, command, exitCode, success)
            debug(`tool.after: bash "${command.slice(0, 60)}" → exit=${exitCode}, verified=${success}`)
          }

          // Failure detection
          if (exitCode !== undefined && exitCode !== 0) {
            const firstErrLine = out.split("\n").find((l) => l.trim()) ?? "unknown error"
            const signature = `${exitCode}:${firstErrLine.slice(0, 80)}`
            ledger.recordFailure(sid, signature)

            // Repeat-failure detection
            const repeat = ledger.getRepeatFailure(sid)
            if (repeat) {
              queue.enqueue(sid, {
                id: "vertex:repeat-failure",
                text: `[vertex:repeat-failure] The same class of failure has repeated ${repeat.count} times. Stop retrying silently — report what failed, what you already tried, and your next hypothesis.`,
              })
              debug(`tool.after: REPEAT FAILURE detected (${repeat.count}x) for ${sid}`)
            } else {
              queue.enqueue(sid, {
                id: "vertex:tool-failure",
                text: `[vertex:tool-failure] A tool call failed (exit ${exitCode}). Do not report completion until it is fixed, isolated as a known baseline, or explicitly documented.`,
              })
              debug(`tool.after: failure recorded for ${sid}`)
            }
          }
        }
      } catch (e) {
        debug(`tool.after: error — ${(e as Error).message}`)
      }
    },

    // ── SYSTEM.TRANSFORM: the INJECT PATH (signal-routed + evidence-aware)
    async "experimental.chat.system.transform"(sysInput, sysOutput) {
      const sid = sysInput.sessionID
      if (!sid || !gate.isActive(sid)) {
        debug(`system.transform: SKIPPED ${sid || "?"} (gate inactive)`)
        return
      }

      const combined: Directive[] = [...alwaysOn()]

      // Signal-routed procedure
      const mode = taskModeBySession.get(sid)
      if (mode) {
        const routed = contextForMode(mode)
        if (routed) combined.push(routed)
      }

      // Evidence summary (let the model see its own track record)
      const summary = ledger.summary(sid)
      if (summary) {
        combined.push({
          id: "vertex:ledger",
          text: `[vertex:ledger] This turn's evidence: ${summary}`,
        })
      }

      // Queued directives (from tool.after failures, stop gate, etc.)
      const queued = queue.drain(sid)
      combined.push(...queued)

      const block = formatDirectives(combined)
      if (!block) return
      sysOutput.system = [...sysOutput.system, block]
      debug(`system.transform: INJECTED ${combined.length} directive(s) into ${sid} (mode=${mode || "none"}, queued=${queued.length})`)
    },

    // ── MESSAGES.TRANSFORM: fallback ──────────────────────────────────────
    ...(opts.wireMessagesTransform
      ? {
          async "experimental.chat.messages.transform"(_msgInput, msgOutput) {
            const undrained = queue.drainAll()
            const active = undrained.filter((d) => gate.isActive(d.sessionID))
            if (active.length === 0) return
            const block = formatDirectives(active)
            if (!block) return
            const last = msgOutput.messages[msgOutput.messages.length - 1]
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

    // ── EVENT: the STOP GATE ──────────────────────────────────────────────
    async event({ event }) {
      try {
        if (event.type !== "session.idle") return
        const sid = event.properties?.sessionID
        if (typeof sid !== "string") return
        if (!gate.isActive(sid)) return

        debug(`event: session.idle for ${sid}`)

        // Check if the model's work is unverified
        if (!ledger.shouldBlockStop(sid)) {
          debug(`event: ${sid} — no block needed (verified or no changes)`)
          return
        }

        const blocks = ledger.getStopBlocks(sid)
        if (blocks >= opts.maxStopBlocks) {
          debug(`event: ${sid} — max stop blocks reached (${blocks}), allowing with warning`)
          queue.enqueue(sid, {
            id: "vertex:stop-warning",
            text: `[vertex:stop-warning] You have claimed done ${blocks} times without observed verification. Proceeding, but this task is recorded as unverified.`,
          })
          return
        }

        const count = ledger.incrementStopBlocks(sid)
        const reason = `[vertex:stop-block] You appear to be stopping, but files were changed this turn without an observed verification command (a Bash call that exited 0 with output). Run a verification command now and cite its output, or explicitly state what remains unverified. (Block ${count}/${opts.maxStopBlocks})`

        queue.enqueue(sid, { id: "vertex:stop-block", text: reason })
        debug(`event: ${sid} — STOP BLOCK ${count}/${opts.maxStopBlocks} (changed files, no verification)`)

        // Re-prompt the model to continue
        if (client?.session?.prompt) {
          await client.session.prompt({
            path: { id: sid },
            body: {
              parts: [{ type: "text", text: reason }],
            },
          })
        }
      } catch (e) {
        debug(`event: error — ${(e as Error).message}`)
      }
    },
  }
}

export default ElicifyVertexPlugin
