/**
 * Wave watchdog — delegation awareness + bounded stall detection for the v2
 * idle gate (HANDOVER.md, "Agreed redesign direction" point 9).
 *
 * This module exists to fix one concrete failure mode: the idle gate fires
 * "you're not done" continuations at a parent session that is legitimately
 * waiting on its own `task`-tool delegation, and it keeps firing them
 * forever even when every continuation produces zero observable activity.
 * Both behaviors were adopted from the opencode-goal-plugin reference
 * (`scratchpad/opencode-goal-plugin/src/server.ts` class `TaskTracker`,
 * `src/state.ts` `recordAssistantProgress`) with deliberate reductions:
 *
 * ADOPTED:
 *  - Deferral while tasks run. The reference tracks `tool.execute.before` /
 *    `tool.execute.after` pairs for the `task` tool and refuses to nag the
 *    parent while a delegation is in flight (`pendingTaskCalls`), backed by
 *    a best-effort live probe of the host's own session tree
 *    (`refreshLiveChildren`'s core: `session.children` + `session.status`).
 *    Here: `DelegationTracker` (the in-flight pair tracking, nothing else)
 *    plus `hasBusyChildren` (the probe, minus the reference's reconciliation
 *    machinery — snapshot idle holds, terminal-unreconciled bookkeeping,
 *    orphan pruning — which exists there to keep a persistent task ledger
 *    authoritative; we keep no ledger, so there is nothing to reconcile).
 *  - Bounded no-progress accounting. The reference pauses auto-continue
 *    after `max_no_progress_turns` consecutive continuation turns that
 *    produced nothing. Here: `evaluateStall`, the same increment/reset/cap
 *    arithmetic over signals this repo already has.
 *
 * DELIBERATELY NOT ADOPTED:
 *  - The `no_progress_token_threshold` / text-similarity comparison. The
 *    reference decides "no progress" by comparing the assistant's latest
 *    text summary against a continuation baseline and checking output-token
 *    counts. That needs per-turn token accounting we don't collect and text
 *    similarity that false-fires on a model that legitimately rephrases, and
 *    false-misses on a model that idles verbosely. This repo's wiring
 *    already owns a strictly better signal: a monotonic activity marker
 *    bumped on every real tool call. Equality of that marker across an idle
 *    boundary is exact — no threshold tuning, no text munging.
 *  - The self-report goal model. The reference's stall counter feeds its
 *    whole completion story (goal status -> "paused", self-reported
 *    evidence, nag escalation). This repo's completion arbiter is the verifier
 *    (HANDOVER points 1-4); the watchdog NEVER decides completion. Its only
 *    output is a continuation-policy verdict: keep nudging, defer, or stop
 *    auto-continuing and surface a stall.
 *
 * Fail-open is the load-bearing convention (same as subturn.ts and the rest
 * of wiring): every host probe failure, missing client method, or unexpected
 * response shape resolves to "not blocked" / "no opinion" — a watchdog bug
 * must degrade to the pre-watchdog behavior (gate fires as before), never
 * wedge the gate or throw out to callers.
 */
import type { OpencodeClient } from "../types.js"

// ---------------------------------------------------------------------------
// 1. Task-blocking awareness
// ---------------------------------------------------------------------------

/**
 * Tracks `task` tool calls that started but have not returned, per parent
 * session, so the idle gate can defer "not done" continuations while a
 * delegated subagent is legitimately mid-delegation.
 *
 * Wiring calls `noteTaskCall` from `tool.execute.before` and `noteTaskDone`
 * from the matching `tool.execute.after` (only for the `task` tool — tool
 * selection stays in wiring, mirroring how the reference's `noteTaskCall`
 * filters `input.tool === "task"` before touching its maps).
 *
 * `callID` is the natural join key but is not guaranteed: some hosts omit it
 * on one or both hooks. When it's absent we fall back to a per-session
 * refcount (the reference keys its fallback the same way, by sessionID).
 * That fallback can over-hold if a host ever drops a `tool.execute.after`,
 * which is exactly why `hasBusyChildren` exists as the independent
 * cross-check — the tracker is the cheap synchronous answer, the probe is
 * the ground-truth repair.
 */
export class DelegationTracker {
  /** callID -> sessionID for pairs where the host supplied a callID. */
  private readonly inFlightByCall = new Map<string, string>()
  /** sessionID -> open-call count for pairs where no callID was supplied. */
  private readonly inFlightBySession = new Map<string, number>()

  /** Record a `task` tool call starting (`tool.execute.before`). */
  noteTaskCall(sessionID: string, callID: string | undefined): void {
    if (callID !== undefined) {
      this.inFlightByCall.set(callID, sessionID)
      return
    }
    this.inFlightBySession.set(sessionID, (this.inFlightBySession.get(sessionID) ?? 0) + 1)
  }

  /**
   * Record the matching `tool.execute.after`. A done with no matching call
   * (hook missed, tracker restarted mid-flight) is a safe no-op — fail-open:
   * over-forgetting only re-enables nudging, which is the pre-watchdog
   * behavior.
   */
  noteTaskDone(sessionID: string, callID: string | undefined): void {
    if (callID !== undefined) {
      this.inFlightByCall.delete(callID)
      return
    }
    const open = this.inFlightBySession.get(sessionID)
    if (open === undefined) return
    if (open <= 1) this.inFlightBySession.delete(sessionID)
    else this.inFlightBySession.set(sessionID, open - 1)
  }

  /** True while any `task` call for this session started but has not returned. */
  hasInFlightDelegation(sessionID: string): boolean {
    if ((this.inFlightBySession.get(sessionID) ?? 0) > 0) return true
    for (const owner of this.inFlightByCall.values()) {
      if (owner === sessionID) return true
    }
    return false
  }

  /**
   * Remove every in-flight entry for this session. The tracker is a cheap
   * heuristic that can over-hold when a host drops a `tool.execute.after` or
   * hands the before/after hooks inconsistent `callID`s (see the module
   * header); the idle gate's `hasBusyChildren` probe repairs that at idle, and
   * this clears the stale entry on a real user message so the next delegation
   * starts from a clean slate. Wiring calls it from the activation turn
   * boundary alongside the rest of the stall reset.
   */
  clearSession(sessionID: string): void {
    this.inFlightBySession.delete(sessionID)
    for (const [call, owner] of this.inFlightByCall) {
      if (owner === sessionID) this.inFlightByCall.delete(call)
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Best-effort live probe: true when the session has a child session that is
 * still busy. Mirrors the core of the reference's `refreshLiveChildren`
 * (`client.session.children({path:{id}})` then `client.session.status()`),
 * reduced to a read-only boolean — we keep no task ledger for it to
 * reconcile, we only need "is anyone still working down there".
 *
 * The SDK's `OpencodeClient` type does not reliably expose `children` /
 * `status` on `client.session` (they exist on the wire; the generated type
 * surface varies by version — same reason the reference casts
 * `client.session` to an ad-hoc shape). So the methods are looked up
 * defensively and BOTH response conventions are accepted: the SDK's
 * fields-style `{ data: ... }` result (see subturn.ts's response-shape
 * note) and bare values (which test stubs and older hosts return). Status
 * entries are accepted as `{type:"busy"}` or the bare string `"busy"`.
 *
 * ANY failure — missing methods, thrown/rejected calls, malformed payloads —
 * resolves false. The probe is a courtesy deferral, never a gate blocker.
 */
export async function hasBusyChildren(client: OpencodeClient, sessionID: string): Promise<boolean> {
  try {
    const session = (client as { session?: unknown }).session as
      | {
          children?: (input: { path: { id: string } }) => Promise<unknown>
          status?: () => Promise<unknown>
        }
      | undefined
    if (!session || typeof session.children !== "function") return false

    let childIDs: string[]
    try {
      const result = await session.children({ path: { id: sessionID } })
      const list = Array.isArray(result) ? result : isRecord(result) && Array.isArray(result.data) ? result.data : []
      childIDs = list.flatMap((child) => (isRecord(child) && typeof child.id === "string" ? [child.id] : []))
    } catch {
      return false
    }
    if (childIDs.length === 0 || typeof session.status !== "function") return false

    let statuses: Record<string, unknown>
    try {
      const result = await session.status()
      if (!isRecord(result)) return false
      statuses = isRecord(result.data) ? result.data : result
    } catch {
      return false
    }

    for (const childID of childIDs) {
      const entry = statuses[childID]
      if (entry === "busy") return true
      if (isRecord(entry) && entry.type === "busy") return true
    }
    return false
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// 2. Stall detection — bounded, deterministic, no LLM
// ---------------------------------------------------------------------------

export interface StallInput {
  /** Monotonic marker bumped by wiring on every real unit of agent activity (tool call). */
  activityMarker: number
  /** The activityMarker value observed at the previous idle that dispatched a continuation. */
  markerAtLastContinuation: number
  /** Consecutive continuation-dispatched idles so far that produced no activity. */
  consecutiveNoProgress: number
  /** Cap: pause after this many consecutive no-progress continuation turns. */
  maxNoProgressTurns: number
}

export interface StallVerdict {
  /** The model was continued but did nothing observable since — count it. */
  noProgress: boolean
  /** consecutiveNoProgress to store (incremented or reset). */
  nextConsecutiveNoProgress: number
  /** Cap reached: wiring should stop auto-continuing and surface a stall instead. */
  stalled: boolean
}

/**
 * The reference's no-progress accounting (`recordAssistantProgress`'s
 * increment/reset/`max_no_progress_turns` cap) with its fuzzy "did anything
 * happen" test replaced by marker equality. A continuation was dispatched at
 * `markerAtLastContinuation`; if `activityMarker` hasn't moved by the next
 * idle, the model spent the whole continuation turn without a single tool
 * call — that is the no-progress signal, and it's exact rather than tuned.
 *
 * Semantics (matching the reference):
 *  - noProgress  -> increment the consecutive count.
 *  - progress    -> reset to 0 (a single productive turn clears the streak;
 *    the cap guards against CONTINUED spinning, not intermittent pauses).
 *  - stalled     -> the incremented count reached `maxNoProgressTurns`.
 *  - `maxNoProgressTurns <= 0` disables the cap entirely (stalled is never
 *    true); the count still tracks so wiring can surface it if it wants.
 *
 * Pure and total: no state, no clock, no throwing.
 */
export function evaluateStall(input: StallInput): StallVerdict {
  const noProgress = input.activityMarker === input.markerAtLastContinuation
  const nextConsecutiveNoProgress = noProgress ? input.consecutiveNoProgress + 1 : 0
  const stalled = input.maxNoProgressTurns > 0 && nextConsecutiveNoProgress >= input.maxNoProgressTurns
  return { noProgress, nextConsecutiveNoProgress, stalled }
}
