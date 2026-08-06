/**
 * Wave-3 wiring — `event(session.idle)` FR-015 decision tree.
 *
 * v1's `EvidenceLedger` (imported, not reimplemented per the task brief) is
 * reused wholesale for the zero-criteria fallback (CRIT-003 — "the most
 * safety-critical fallback in the whole spec"): the SAME ledger instance is
 * driven in parallel with v2's own bookkeeping (`recordChangedFiles` /
 * `recordVerification` from `tool.execute.after`, `reset` from
 * `chat.message`), so `shouldBlockStop` sees exactly the state v1 would.
 *
 * HANDOVER.md redesign (2026-07-29, points 2/4/8/9) — the completion model
 * changed fundamentally:
 *  - The completion VERIFIER is now the sole arbiter of story/plan completion.
 *    It runs here, at idle, over every story that CLAIMED complete since its
 *    last audit (`handleVerifierAudit`) — no longer gated behind the
 *    deterministic state it exists to rescue (the old `appendVerifierCloseOut`
 *    could only run once every story was already `complete`, so a session
 *    stalled on the deterministic gate — exactly the failure it existed
 *    for — never saw a verifier at all: the 894-message field session ended
 *    5/5 blocked with 0 audits).
 *  - Verifier verdicts are structured per acceptance item and are APPLIED:
 *    a failed claim reverts the story to `active` with named gaps, and the
 *    continuation names those gaps per story (point 8).
 *  - The gate defers ALL nudging while a `task`-tool delegation is in
 *    flight or a child session is still busy, and pauses auto-continuations
 *    after a capped run of continuations that produced no observable
 *    activity (point 9, `wiring/watchdog.ts`).
 *
 * v1's promise-no-act detector is deliberately NOT ported here: it is not
 * named by FR-015, by the module contracts doc's "Reused v1 primitives"
 * list, or by the task brief's session.idle bullet — porting it would be
 * scope creep into a mechanism the spec does not ask this wave to carry
 * forward, so it is left out on purpose (documented, not a silent gap).
 * (It was later ported anyway — see `handlePromiseNoAct` — and the
 * redesign keeps it.)
 */
import { existsSync } from "node:fs"
import { resolve as resolvePath, sep } from "node:path"

import { detectPromiseNoAct, shouldBlockPromiseNoAct } from "../../index.js"
import type { EvidenceLedger } from "../../index.js"
import { classifyFileKind, formatChangedPathsForReason, formatGateContinuationText } from "../../index.js"
import { verifyWaiverSignature } from "../../goals.js"
import { holdoutSuppresses, logHoldoutSuppress } from "../../measurement.js"
import type { InjectionComposer } from "../composer.js"
import type { DiffStatResult } from "../diffstat.js"
import type { EventLogger, OpencodeClient } from "../types.js"
import type { PhaseEngine } from "../phase.js"
import type { PinStore } from "../pin.js"
import type { StoryEngine } from "../story.js"
import { resolveVerifier } from "../resolve.js"
import { runVerifier, buildVerifierPayload, type VerifierStoryVerdict } from "../verifier.js"
import type { VerifierItemNote, PlanV2, StoryV2 } from "../story.js"
import type { SelfCreatedSessions } from "../subturn.js"
import type { ManifestCache } from "./manifest.js"
import { incompletePlanFinding } from "./findings.js"
import { bindSession } from "./logger.js"
import { nextInstanceId, type V2SessionState } from "./state.js"
import { parsePathAbsenceClaim } from "./pathClaim.js"
import { judgePause, PAUSE_JUDGE_DELAY_MS } from "../pauseJudge.js"
import { evaluateStall, hasBusyChildren, type DelegationTracker } from "./watchdog.js"

export interface GateContext {
  client: OpencodeClient
  logger: EventLogger
  phaseEngine: PhaseEngine
  pinStore: PinStore
  storyEngine: StoryEngine
  evidenceLedger: EvidenceLedger
  selfCreated: SelfCreatedSessions
  manifests: ManifestCache
  states: Map<string, V2SessionState>
  /**
   * Every session id currently gate-active (mirrors v1's
   * `SessionGate.activeSessionIDs()`). Read ONLY to emit the degraded-
   * attribution advisory (`gate:multi-session-advisory`) — never to decide
   * whether to enforce. See `handleSessionIdle` for why.
   */
  activeSessionIDs: () => string[]
  maxCriteriaBlocks: number
  verifierEnabled: boolean
  isValidReceipt: (sessionID: string, receiptID: string) => boolean
  /** Recent verifier output summaries this session, for the verifier payload (best-effort, bounded). */
  recentVerifierSummaries: (sessionID: string) => string[]
  /** B-3: file-level evidence for the verifier payload, plus the stated
   * reason when there is no real diff behind it (not a repo, git failed, no
   * change recorded). The reason is carried into the payload as its own
   * field so the judge CITES the hole instead of judging around it. */
  diffSummary: (sessionID: string) => DiffStatResult
  /** `promptContinuation` opens a new composer turn per dispatched
   * continuation — see that function for the rationale and the reverted
   * alternatives. */
  composer: InjectionComposer
  /** Redesign point 9: defers all idle nudging while a `task`-tool
   * delegation is mid-flight for the session (backed by a best-effort
   * busy-children probe — see `wiring/watchdog.ts`). */
  delegation: DelegationTracker
  /** Redesign point 9: pause auto-continuations after this many consecutive
   * continuations produced no observable activity. <= 0 disables. */
  maxNoProgressTurns: number
  /** FR-007: cap consecutive verifier reverts per story, then escalate. <=0 disables. */
  maxStoryReaudits: number
  /** FR-060/FR-061: surfaces gate fires and health signals to the operator.
   * Optional so existing callers and tests need no change; when absent the
   * gate simply reports nothing, exactly as before. */
  visibility?: {
    notify(kind: "directive" | "gate" | "health", input: Record<string, unknown> & { message: string }): Promise<void>
  }
}

/** MIN-006: per-session dispatch counter so a late-settling prompt cannot
 * release a newer continuation's in-flight guard. */
const continuationTicket = new Map<string, number>()

const CONTINUATION_TIMEOUT_MS = 30_000
const CONTINUATION_TIMEOUT_ERROR = "vertex-v2-continuation-timeout"

async function promptContinuation(
  ctx: GateContext,
  sid: string,
  text: string,
): Promise<void> {
  if (!ctx.client?.session?.prompt) {
    // Parity with src/index.ts's attemptGateContinuation: a missing
    // session.prompt must never fail silently — it means the idle gate can
    // no longer enforce anything for this session, which is exactly the
    // kind of failure an operator needs surfaced, not swallowed.
    ctx.logger("gate:continuation-failed", { sessionID: sid, reason: "session.prompt unavailable" })
    void ctx.visibility?.notify("health", {
      sessionID: sid,
      family: "gate:continuation-failed",
      message: "the idle gate cannot enforce anything: session.prompt is unavailable",
      variant: "error",
    })
    console.error("[vertex-v2] session.prompt unavailable; cannot enforce idle gate")
    return
  }
  // The working model must read a continuation as an INSTRUCTION, not as an
  // automated nag it can discount. Continuations are already dispatched
  // through `session.prompt`, so they arrive as user-role messages; the
  // `[vertex:...]` marker was the only thing advertising the harness as their
  // author. Strip it from what the model sees.
  //
  // Applied to EVERY continuation family, not just the verifier's: they share
  // one channel and one authority argument, and stripping some while leaving
  // others teaches the model that a bracketed prefix means "safe to discount".
  //
  // The marker is not discarded — it is logged as the family, which is how an
  // operator still tells harness steering from their own words when reading a
  // transcript. Nothing recorded the dispatched text before this.
  // Two things advertise the harness: `formatGateContinuationText`'s
  // "[vertex] completion paused …" headline, and the `[vertex:family]` token
  // on the directive itself. Both go.
  const family = /\[vertex:([a-z-]+)\]/.exec(text)?.[1] ?? "unmarked"
  const dispatchText = text
    .replace(/^\[vertex\][^\n]*\n+/, "")
    .replace(/\[vertex:[a-z-]+\]\s*/g, "")
    .trim()
  ctx.logger("gate:continuation-dispatched", {
    sessionID: sid,
    family,
    chars: dispatchText.length,
    text: dispatchText.slice(0, 500),
  })
  const state = ctx.states.get(sid)
  // MIN-006 (code review): a prompt that timed out and settles LATER must not
  // release the guard of a newer continuation. Each dispatch takes a ticket;
  // the late settler only releases if its ticket is still the current one.
  const ticket = (continuationTicket.get(sid) ?? 0) + 1
  continuationTicket.set(sid, ticket)
  if (state) {
    state.idleContinuationInFlight = true
    // M4: recorded so the reentrant `chat.message` this prompt causes can be
    // recognised as our own echo rather than as user intent.
    state.lastContinuationText = dispatchText
  }

  // A dispatched continuation is a fresh prompt, so it opens a new turn in
  // the same sense a user message does — per-family spend resets, phase and
  // pins do not (those stay gated on real user intent).
  //
  // History worth keeping: an earlier change made this DEFERRED, and a
  // separate change advanced the turn on every tool result, both on the
  // belief that `turnIndex` was "frozen" during long autonomous runs. That
  // diagnosis was wrong. In the session that prompted it there was exactly
  // ONE activated user message, so `turnIndex == 1` was correct, and the
  // ~250 `per-turn-cap:dropped` events were the cap working as designed.
  // Live-host measurement then showed `system.transform` fires after every
  // tool result, so a per-step advance ran the index 1 -> 4 inside a single
  // reply cycle and collapsed every cap and cooldown into per-step. Both
  // changes were reverted. The real, still-open issue is a design one: a
  // 90-minute agent turn gets one nudge per family for its whole duration,
  // which wants a deliberate cadence decision, not a turn-boundary hack.
  ctx.composer.newTurn(sid)

  // FR-060: a dispatched continuation IS the gate firing. Without this the
  // "gates" visibility mode — sold as "the signals you must not miss" — had
  // no gate to report and showed almost nothing.
  void ctx.visibility?.notify("gate", {
    sessionID: sid,
    family: "gate",
    message: text.split("\n").find((l) => l.trim()) ?? "harness gate fired",
    variant: "warning",
  })
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  // FR-012: a timeout here is NOT a delivery failure.
  //
  // `session.prompt` resolves only when the whole assistant turn ENDS, so any
  // continuation that provokes real work necessarily outruns a 30s race. In
  // the audited session this fired 9 times — once per verifier audit — and every
  // one was logged `gate:continuation-failed`, yet the transcript shows each
  // continuation arriving as a user message the agent then reacted to. The
  // directives were delivered; the harness was mis-reporting its own success
  // as an outage, which would mask a real one.
  //
  // Two consequences are fixed here:
  //  1. A timeout is logged as `gate:continuation-slow` (informational) and
  //     raises no health alarm. A genuine rejection still logs
  //     `gate:continuation-failed`.
  //  2. `idleContinuationInFlight` is NOT cleared on the timeout path. That
  //     flag is documented in `handleSessionIdle` as "the only thing standing
  //     between a continuation and its own echo"; releasing it at 30s while
  //     the turn is still streaming re-opens the gate mid-flight. It is now
  //     cleared only when the prompt actually settles — and by the next real
  //     `chat.message`, which is the turn boundary that genuinely ends it.
  let settled = false
  const release = (): void => {
    settled = true
    // Only the CURRENT dispatch may clear the flag (MIN-006).
    if (state && continuationTicket.get(sid) === ticket) {
      state.idleContinuationInFlight = false
      state.lastContinuationText = null
    }
  }
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error(CONTINUATION_TIMEOUT_ERROR)), CONTINUATION_TIMEOUT_MS)
    })
    // CRIT-002 (code review): `session.prompt` may throw SYNCHRONOUSLY. That
    // throw never reaches the `.then`/`.catch` below, so with the guard
    // released only there, one sync throw left `idleContinuationInFlight`
    // stuck true — and `plugin.ts`'s `chat.message` returns early while it is
    // set, so the whole harness went inert for the session with no log. The
    // promise is therefore constructed inside its own try, and every
    // non-timeout exit releases the guard.
    let prompt: Promise<unknown>
    try {
      prompt = Promise.resolve(
        ctx.client.session.prompt({ path: { id: sid }, body: { parts: [{ type: "text", text: dispatchText }] } } as never),
      )
    } catch (syncErr) {
      release()
      throw syncErr
    }
    await Promise.race([
      prompt.then(
        (value: unknown) => {
          release()
          return value
        },
        (err: unknown) => {
          release()
          throw err
        },
      ),
      timeoutPromise,
    ])
  } catch (err) {
    const isTimeout = err instanceof Error && err.message === CONTINUATION_TIMEOUT_ERROR
    if (isTimeout) {
      ctx.logger("gate:continuation-slow", { sessionID: sid, afterMs: CONTINUATION_TIMEOUT_MS })
    } else {
      // Fail-open (v1 invariant): a failed prompt never throws into the host,
      // but a genuine failure is always logged and echoed to stderr.
      ctx.logger("gate:continuation-failed", { sessionID: sid, reason: "session.prompt failed" })
      void ctx.visibility?.notify("health", {
        sessionID: sid,
        family: "gate:continuation-failed",
        message: "the idle gate could not dispatch its continuation: session.prompt failed",
        variant: "error",
      })
      console.error("[vertex-v2] session.prompt", err)
    }
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle)
    // Only the TIMEOUT path leaves the guard held (the turn is still
    // streaming and the guard is the sole defence against the continuation
    // echoing itself — see `handleSessionIdle`). Every other exit released it
    // above, and `resetTurnState` clears it on the next real user message so
    // a never-settling prompt cannot wedge the session forever.
    if (settled && state && continuationTicket.get(sid) === ticket) state.idleContinuationInFlight = false
  }
}

/**
 * Redesign point 9 (stall detection): every continuation the gate wants to
 * dispatch goes through here instead of calling `promptContinuation`
 * directly. Before dispatching, the session's activity marker is compared
 * against the marker recorded at the PREVIOUS continuation: an unchanged
 * marker means the model spent the whole intervening turn without a single
 * tool call — one no-progress continuation. Once `ctx.maxNoProgressTurns`
 * of those stack up consecutively, the gate pauses itself (`stallPaused`,
 * cleared by the next real user message in `resetTurnState`) and surfaces
 * ONE health notification instead of nudging forever — the exact
 * 19-identical-warnings-never-corrected failure the field session showed.
 *
 * Returns `true` iff a continuation was actually dispatched.
 */
/**
 * Per-idle dispatch bookkeeping.
 *
 * G002 — the harness must not speak while the worker is still working. Every
 * branch runs off `session.idle`, but nothing checked that the turn had
 * actually CONCLUDED by the time a message went out: the model can start
 * working again between idle firing and a branch deciding to dispatch, and
 * the user then sees the harness interrupt an attempt to collect the very
 * proof it asked for. The pause judge already re-checks `activityMarker`;
 * this generalises it to every branch.
 *
 * G003 — at most one continuation per idle. True today only because each
 * branch returns early after dispatching; recorded explicitly so a future
 * branch cannot quietly break it.
 */
const idleDispatch = new Map<string, { marker: number; spoken: boolean }>()

/** Called at the top of every `session.idle`, before any branch runs. */
export function beginIdleTurn(sid: string, marker: number): void {
  idleDispatch.set(sid, { marker, spoken: false })
}

/** Live entry count — test-only observability for the unbounded-growth fix. */
export function idleTurnCount(): number {
  return idleDispatch.size
}

export function forgetIdleTurn(sid: string): void {
  idleDispatch.delete(sid)
}

/** Exported for the `spoken`-latch test; not part of the plugin surface. */
export async function dispatchContinuation(ctx: GateContext, sid: string, state: V2SessionState, text: string): Promise<boolean> {
  const turn = idleDispatch.get(sid)
  if (turn) {
    if (turn.spoken) {
      ctx.logger("gate:dispatch-suppressed", { sessionID: sid, reason: "already spoke this idle" })
      return false
    }
    if (state.activityMarker !== turn.marker) {
      // The worker resumed after idle fired. Whatever this branch decided, it
      // decided it about a turn that is no longer over.
      ctx.logger("gate:dispatch-suppressed", { sessionID: sid, reason: "turn resumed since idle" })
      return false
    }
    turn.spoken = true
  }
  return dispatchContinuationInner(ctx, sid, state, text)
}

async function dispatchContinuationInner(
  ctx: GateContext,
  sid: string,
  state: V2SessionState,
  text: string,
): Promise<boolean> {
  const verdict = evaluateStall({
    activityMarker: state.activityMarker,
    markerAtLastContinuation: state.markerAtLastContinuation,
    consecutiveNoProgress: state.consecutiveNoProgress,
    maxNoProgressTurns: ctx.maxNoProgressTurns,
  })
  state.consecutiveNoProgress = verdict.nextConsecutiveNoProgress
  state.markerAtLastContinuation = state.activityMarker
  if (verdict.stalled) {
    state.stallPaused = true
    ctx.logger("gate:stall-paused", { sessionID: sid, consecutiveNoProgress: state.consecutiveNoProgress })
    void ctx.visibility?.notify("health", {
      sessionID: sid,
      family: "gate:stall-paused",
      message:
        `auto-continuations paused: ${state.consecutiveNoProgress} consecutive continuations produced no ` +
        `observable work — the session appears stalled and will not be nudged again until your next message`,
      variant: "error",
    })
    return false
  }
  if (verdict.noProgress) {
    ctx.logger("gate:no-progress", { sessionID: sid, consecutiveNoProgress: state.consecutiveNoProgress })
  }
  await promptContinuation(ctx, sid, text)
  return true
}

function narrowestPrescription(ctx: GateContext, state: V2SessionState, sid: string, storyVerifiers: readonly string[] | null): string {  const changedPaths = ctx.evidenceLedger.getChangedPaths(sid).filter((p) => !p.endsWith("-mutation"))
  const manifest = ctx.manifests.get(state.workspaceRoot)
  const resolution = resolveVerifier(
    { changedPaths, storyVerifiers },
    { readManifest: () => manifest },
  )
  if (!resolution.command) {
    ctx.logger("resolution:none", { sessionID: sid, changedPaths })
    return "a relevant test, lint, typecheck, build, check, validate, verify, or HTTP probe command covering the changed paths"
  }
  return resolution.command
}

/**
 * STAGE 1 of the two-stage idle completion gate
 * (`docs/REQUIREMENTS-IDLE-COMPLETION-GATE.md`).
 *
 * Before this existed, `getPlan()` was read in this file ONLY inside
 * `appendVerifierCloseOut`, to decide whether the verifier was *permitted* to
 * run — never to *demand* completion. So a plan whose stories were all
 * still `pending` closed silently whenever the other three checks happened
 * to pass (no pinned criteria, no unverified changed files), which is
 * exactly what a real 517-message session did with 5 of 6 stories
 * untouched.
 *
 * Design decisions, each one an open question the requirement left to the
 * implementer:
 *
 *  - **Ordering.** Checked FIRST, ahead of promise-no-act. The requirement's
 *    headline is that deterministic validation runs first and story
 *    completion is "chief among" those checks, and an open story roster
 *    strictly dominates a promise-no-act hit as a continuation: it names
 *    the same "you are not done" fact plus which stories, their status, and
 *    the evidence that would close the active one. Firing short-circuits
 *    the rest of the FR-015 tree exactly as promise-no-act does, so one
 *    idle event still produces at most one continuation.
 *
 *  - **Cap (open question 1): warn-then-allow, v1 parity.** Blocking
 *    indefinitely was rejected — every other gate in v1 and v2 warns
 *    `maxCriteriaBlocks` times and then goes quiet, and a gate that can
 *    never be satisfied is a gate the operator has to disable. The counter
 *    reused is `state.criteriaBlocks`, deliberately SHARED with the
 *    criteria-replay branch rather than adding a second knob: both are
 *    "the deterministic completion contract is unmet" blocks, v1 itself
 *    runs one shared `maxStopBlocks` budget across its gate families, and
 *    `resetTurnState` already zeroes this counter on every real user
 *    message (and correctly does NOT zero it for the reentrant
 *    `chat.message` our own continuation causes — see plugin.ts's
 *    `idleContinuationInFlight` branch), which is precisely the per-turn
 *    budget AC-5 asks for. Consequence, accepted knowingly: within one turn
 *    the two branches draw on one budget, so a plan that spends it can
 *    leave the criteria branch quiet for the rest of that turn.
 *
 *  - **Past the cap we stop NUDGING, but the verifier still cannot run.** The
 *    early return below is skipped once capped, so the rest of the tree
 *    (zero-criteria fallback, phase close) runs normally — but
 *    `appendVerifierCloseOut` independently requires the plan's final story to
 *    be `complete`, and `StoryEngine.checkpoint` now REJECTS completing the
 *    final story unless every OTHER story is already `complete` too (see
 *    `story.ts`'s `checkpoint`, the `isFinal` branch — added for
 *    `docs/CODE-ISSUES-FROM-PROMPT-AUDIT.md` C-11). That check exists
 *    because `checkpoint`'s successor-promotion is a first-`"pending"`-match
 *    scan, not strict index order, so an earlier story checkpointed
 *    `blocked`/`failed` directly while still `"pending"` — nothing requires
 *    `blocked`/`failed` transitions to target the active story — can be
 *    skipped by promotion and left permanently unresolved while later
 *    stories reach `complete` on their own; "final complete only when every
 *    earlier story completed" is therefore true because `checkpoint`
 *    enforces it directly, not merely as a structural side effect of
 *    promotion order. AC-3 holds on that basis.
 *
 *  - **Scope (open question 2): no abandonment is inferred.** Nothing here
 *    tries to detect that the user "moved on". That reuses the scope
 *    watchdog's existing opinion: `StoryEngine.checkScope` surfaces a
 *    mutation outside the story's globs and offers fold/amend/revert — it
 *    never treats the drift as consent to drop the story — and
 *    `clearPlan`'s own doc comment makes abandonment a human-initiated
 *    escape hatch that the findings system must never proactively offer.
 *    Guessing "unrelated request" from message text would be exactly the
 *    inference those two refuse to make. The in-contract outs are named in
 *    the directive text instead (checkpoint `blocked`/`failed` with a
 *    reason), and the cap bounds the cost of being wrong.
 *
 * Returns `true` iff it dispatched a continuation (caller must skip the
 * rest of the FR-015 tree for this idle event).
 */
async function handleIncompletePlan(ctx: GateContext, sid: string, state: V2SessionState): Promise<boolean> {
  const plan = ctx.storyEngine.getPlan(sid)
  if (!plan) return false

  // The requirement's literal bar: "any story is not `complete`". Terminal-
  // but-not-complete statuses (`blocked`/`failed`) count as open too — they
  // are named with their status in the directive rather than silently
  // treated as settled, since `checkpoint` requires no evidence for them and
  // would otherwise be a one-call escape from the whole gate.
  const incomplete = plan.stories.filter((story) => story.status !== "complete")
  if (incomplete.length === 0) return false

  const openStoryIds = incomplete.map((story) => story.id).join(",")

  if (holdoutSuppresses(sid, "plan-incomplete")) {
    logHoldoutSuppress(sid, "v2 plan-incomplete stop-block skipped (holdout arm=off)", { family: "plan-incomplete" })
    return false
  }

  if (state.criteriaBlocks >= ctx.maxCriteriaBlocks) {
    ctx.logger("gate:plan-incomplete-capped", { sessionID: sid, openStoryIds, openCount: incomplete.length })
    return false // past cap — allow through, warn only (v1 parity)
  }
  state.criteriaBlocks += 1

  const finding = incompletePlanFinding({
    instanceId: nextInstanceId(state),
    totalStories: plan.stories.length,
    incomplete,
    activeStories: ctx.storyEngine.getActiveStories(sid),
  })
  ctx.logger("gate:plan-incomplete", {
    sessionID: sid,
    openStoryIds,
    openCount: incomplete.length,
    totalStories: plan.stories.length,
    instanceId: finding.instanceId,
  })

  const reason = [
    `[vertex:plan-incomplete] ${finding.observation}`,
    `Diagnosis: ${finding.diagnosis}`,
    `Do now: ${finding.prescription}`,
  ].join("\n")
  await dispatchContinuation(ctx, sid, state, formatGateContinuationText(reason))
  return true
}

/**
 * Promise-no-act port (v1 parity — this was deliberately NOT carried into
 * v2 at wave-3 time, per this file's original header comment; ported now
 * because a real long-running session showed the model closing a turn on
 * "the rest of the criteria are deferred/tracked" language, which nothing
 * in v2 detected). Reuses v1's `detectPromiseNoAct`/`shouldBlockPromiseNoAct`
 * verbatim against `state.lastAssistantText` (the last text produced by
 * `experimental.text.complete`, cleared on the next tool call by
 * `plugin.ts`'s `tool.execute.after` so stale pre-tool-call text can never
 * be checked here — mirrors v1's own `lastAssistantText.delete(sid)`).
 *
 * Checked FIRST in `handleSessionIdle`, before the criteria/zero-criteria
 * branches — matching v1's ordering, where a promise-no-act hit takes
 * precedence over (and short-circuits) the unverified-changes check.
 *
 * Reuses `EvidenceLedger.incrementPromiseBlocks`/`getPromiseBlocks` (v1's
 * own counter, already driven in parallel by this module) rather than
 * adding a new field to `V2SessionState`, and `ctx.maxCriteriaBlocks` as the
 * cap — v1 uses one shared `maxStopBlocks` value across both promise-no-act
 * and criteria blocks; v2 already threads the equivalent single cap value
 * through `GateContext` for the criteria branch, so reusing it here keeps
 * one cap knob instead of introducing a second, independently-configured one.
 *
 * Returns `true` iff it fired a continuation (caller must skip the rest of
 * the FR-015 tree for this idle event, matching v1's early return).
 */
async function handlePromiseNoAct(ctx: GateContext, sid: string, state: V2SessionState): Promise<boolean> {
  const lastText = state.lastAssistantText
  if (!lastText) return false

  const changed = ctx.evidenceLedger.hasChangedFiles(sid)
  const verified = ctx.evidenceLedger.hasVerification(sid)
  if (!shouldBlockPromiseNoAct(lastText, changed, verified)) return false

  if (holdoutSuppresses(sid, "promise-no-act")) {
    logHoldoutSuppress(sid, "v2 promise-no-act block skipped (holdout arm=off)", { family: "promise-no-act" })
    return false
  }

  const count = ctx.evidenceLedger.incrementPromiseBlocks(sid)
  if (count > ctx.maxCriteriaBlocks) {
    return false // past cap: allow through with no further prompt (v2's established convention — see handleZeroCriteriaFallback)
  }

  const hits = detectPromiseNoAct(lastText)
  const labels = hits.map((h) => h.label).join(", ")
  const reason = `[vertex:promise-no-act] Your last message states an intent to do further work (${labels}) after changing files, without doing it. Do that work now with tool calls. End the turn only when the work is complete, or ask the user a direct question if you are blocked on input only they can provide.`
  await dispatchContinuation(ctx, sid, state, reason)
  return true
}

/**
 * A turn ended with nothing done. Do NOT judge that here — arm a timer.
 *
 * This replaced a phrase detector that was wrong in both directions inside two
 * live sessions: silent on "Let me lay out the plan and execute", and nudging
 * "Green-light this and I'll create the plan and start" — a model correctly
 * pausing for the approval the agent contract *requires* before a plan is
 * recorded. See `pauseJudge.ts` for why a word list cannot answer this.
 *
 * The structural pre-filter survives, because it is free and it is what keeps
 * the model call rare: no plan, nothing changed, not quick mode. What is gone
 * is any attempt to read intent from the text. `session.idle` fires the moment
 * a turn ends, which is not evidence of anything — a human reading the reply
 * looks exactly like a stall. Only real silence is evidence, so the question
 * is deferred to `PAUSE_JUDGE_DELAY_MS` of it, and any activity cancels.
 */
function armPauseJudge(ctx: GateContext, sid: string, state: V2SessionState): boolean {
  // Every branch below used to return silently, so "nothing fired" was
  // indistinguishable from "fired and decided not to act" — a real question a
  // user asked that the logs could not answer. Each refusal now names itself.
  const decline = (reason: string): boolean => {
    ctx.logger("pause:not-armed", { sessionID: sid, reason })
    return false
  }
  if (!state.lastAssistantText) return decline("no assistant text")
  // MAJ-003: `VERTEX_VERIFIER=0` is the documented way to switch the verifier
  // off, and this drives the same agent. It must obey the same switch.
  if (!ctx.verifierEnabled) return decline("verifier disabled")
  // MAJ-005: every other dispatching branch honours the holdout; the deleted
  // branch did too. Without it the "off" arm receives nudges and the A/B
  // measurement for this family is corrupted.
  if (holdoutSuppresses(sid, "promise-no-act")) return decline("holdout off-arm")
  if (ctx.evidenceLedger.hasChangedFiles(sid)) return decline("files changed") // promise-no-act's job
  if (ctx.storyEngine.getPlan(sid)) return decline("plan exists") // handleIncompletePlan's job
  // `>=`, not `>`: the increment happens after the model call, so `>` armed
  // one extra judgement per turn purely to discard its verdict at the cap.
  if (state.statedIntentNudges >= ctx.maxCriteriaBlocks) return decline("nudge cap reached")

  // Re-arming on every idle would let a chatty session hold the timer open
  // forever without it ever expiring. One armed timer per session; the
  // activity marker recorded with it is how expiry tells silence from work.
  if (pauseTimers.has(sid) || pauseInFlight.has(sid)) return decline("already armed or in flight")

  const armedAtMarker = state.activityMarker
  try {
    armTimer(ctx, sid, state, armedAtMarker)
  } catch {
    // `handleSessionIdle` is awaited unguarded by the event hook, so anything
    // thrown here reaches the host. Arming is best-effort: losing one pause
    // judgement is invisible, breaking the idle tree is not.
  }
  return false // arming is not a continuation; the rest of the idle tree runs
}

function armTimer(ctx: GateContext, sid: string, state: V2SessionState, armedAtMarker: number): void {
  const armedAtEpoch = currentPauseEpoch(sid)
  const timer = setTimeout(() => {
    pauseTimers.delete(sid)
    pauseInFlight.add(sid)
    void runPauseJudge(ctx, sid, state, armedAtMarker, armedAtEpoch).finally(() => pauseInFlight.delete(sid))
  }, PAUSE_JUDGE_DELAY_MS)
  // Never hold the host process open for this.
  if (typeof timer.unref === "function") timer.unref()
  pauseTimers.set(sid, timer)
  ctx.logger("pause:armed", { sessionID: sid, afterMs: PAUSE_JUDGE_DELAY_MS })
}

/** Timers are per session and cancelled by any activity — see `cancelPauseJudge`. */
const pauseTimers = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * CRIT-001. Clearing the timer cannot stop a judgement that has already
 * started, and the judgement takes a model call — so between "timer fires" and
 * "nudge dispatched" the user can send a message the harness then talks over.
 * Reproduced: the user typed "Actually forget that" while the judge was in
 * flight, and the harness still told the model to resume the abandoned work.
 * That is the exact failure this feature exists to prevent, reappearing as a
 * race instead of a phrasing bug.
 *
 * So cancellation bumps a per-session epoch. The judge captures it at arm time
 * and re-checks it after every await; a bump means "the world moved on" and
 * the whole run is abandoned, including after the verdict is known.
 */
const pauseEpochs = new Map<string, number>()

/** In-flight guard (MAJ-002): the map entry above is deleted when the timer
 *  FIRES, so without this the next idle re-arms while the first judge is still
 *  running — two subturns for one session, both able to dispatch. */
const pauseInFlight = new Set<string>()

function currentPauseEpoch(sid: string): number {
  return pauseEpochs.get(sid) ?? 0
}

/**
 * Any real activity means this was not a pause. Called from the hooks that
 * observe work and user input, so a timer never outlives the silence it was
 * measuring.
 */
export function cancelPauseJudge(sid: string): void {
  // Bump FIRST and unconditionally: a judge already in flight has no timer to
  // clear, and it is exactly the case that needs cancelling.
  pauseEpochs.set(sid, currentPauseEpoch(sid) + 1)
  const timer = pauseTimers.get(sid)
  if (!timer) return
  clearTimeout(timer)
  pauseTimers.delete(sid)
}

/**
 * The timer fired. Confirm the session really is still silent, ask the judge,
 * and nudge ONLY on an explicit "stopped-mid-work". Every other outcome —
 * awaiting-user, unavailable, malformed, thrown — is silence.
 */
async function runPauseJudge(
  ctx: GateContext,
  sid: string,
  state: V2SessionState,
  armedAtMarker: number,
  armedAtEpoch: number,
): Promise<void> {
  /** The world moved on while we were thinking — see `pauseEpochs`. */
  const stale = (): boolean =>
    currentPauseEpoch(sid) !== armedAtEpoch ||
    !state.active ||
    state.stallPaused ||
    state.idleContinuationInFlight ||
    state.activityMarker !== armedAtMarker ||
    ctx.evidenceLedger.hasChangedFiles(sid) ||
    ctx.storyEngine.getPlan(sid) !== null
  try {
    if (stale()) {
      ctx.logger("pause:cancelled", { sessionID: sid, reason: "activity after arming" })
      return
    }
    const lastText = state.lastAssistantText
    if (!lastText) return
    if (!state.modelId) return
    const [providerID, ...rest] = state.modelId.split("/")
    const modelID = rest.join("/")
    if (!providerID || !modelID) return

    const verdict = await judgePause({
      client: ctx.client,
      selfCreated: ctx.selfCreated,
      logger: ctx.logger,
      parentSessionID: sid,
      lastAssistantText: lastText,
      recentTranscript: (await fetchVerifierTranscriptFields(ctx.client, sid)).recentTranscript,
      sessionModel: { providerID, modelID },
    })

    ctx.logger("pause:verdict", { sessionID: sid, verdict: verdict ?? "none" })
    if (verdict !== "stopped-mid-work") return // awaiting-user, or unreadable: stay silent

    // CRIT-001: the judgement took a model call. Re-validate immediately
    // before speaking — a verdict about a message the user has already moved
    // past is worse than no verdict at all.
    if (stale()) {
      ctx.logger("pause:cancelled", { sessionID: sid, reason: "session moved on during judgement" })
      return
    }

    state.statedIntentNudges += 1
    if (state.statedIntentNudges > ctx.maxCriteriaBlocks) return
    await dispatchContinuation(
      ctx,
      sid,
      state,
      "[vertex:stalled] This turn ended part-way through work you had started, with no question for the user " +
        "and nothing to respond to. Continue and finish it. If it is a multi-story build, propose the plan and " +
        "get agreement before recording it.",
    )
  } catch {
    // Fail-open: a background timer must never throw into the host.
  }
}

/** FR-015 zero-criteria fallback: v1's `EvidenceLedger.shouldBlockStop`, verbatim semantics, reused not reimplemented. */
async function handleZeroCriteriaFallback(ctx: GateContext, sid: string, state: V2SessionState): Promise<void> {
  if (!ctx.evidenceLedger.shouldBlockStop(sid)) return

  if (holdoutSuppresses(sid)) {
    logHoldoutSuppress(sid, "v2 zero-criteria stop-block skipped (holdout arm=off)")
    return
  }

  const blocks = ctx.evidenceLedger.getStopBlocks(sid)
  if (blocks >= ctx.maxCriteriaBlocks) {
    return // past cap: allow through with no further prompt (v1 parity — warn-then-allow)
  }

  ctx.evidenceLedger.incrementStopBlocks(sid)
  const changedList = formatChangedPathsForReason(ctx.evidenceLedger.getChangedPaths(sid))
  const activeStory = ctx.storyEngine.getActiveStory(sid)
  const command = narrowestPrescription(ctx, state, sid, activeStory?.verifiers ?? null)
  const reason = `[vertex:stop-block] No acceptance criteria were captured for this session. Changed this turn: ${changedList} — no successful verification observed since the latest change. Run ${command} now and cite its observed result.`
  await dispatchContinuation(ctx, sid, state, formatGateContinuationText(reason))
}

/** FR-015 criteria-pinned branch: replay each criterion, block only when >=1 lacks evidence. */
async function handleCriteriaReplay(ctx: GateContext, sid: string, state: V2SessionState): Promise<boolean> {
  // FR-015 scopes the whole criteria-pinned branch to "deep tasks with
  // mutations", and FR-016 makes both exemptions unconditional ("Quick and
  // normal modes MUST never hard-block; docs-only changes MUST never
  // block"). handleZeroCriteriaFallback gets these for free by reusing
  // EvidenceLedger.shouldBlockStop verbatim; this branch has to apply the
  // same two gates itself, and does so BEFORE ever looking at criteria
  // evidence — an exempt session should not hard-block no matter how many
  // criteria are unmet.
  if (ctx.evidenceLedger.getMode(sid) !== "deep") return true
  const changedPaths = ctx.evidenceLedger.getChangedPaths(sid).filter((p) => !p.endsWith("-mutation"))
  if (changedPaths.length > 0 && changedPaths.every((p) => classifyFileKind(p) === "docs")) return true

  const criteria = ctx.pinStore.get(sid)
  const unmet = criteria.find((c) => {
    if (!c.evidence) return true
    // Waiver-typed evidence USED to be trusted here, on the grounds that
    // tools.ts validates `waiverSourceMessageId` against a real chat message at
    // attach time. That reasoning only holds if nothing else can write a waiver
    // -- and `pins.json` is an ordinary file. An audit wrote
    // `{"waiver":true,"sourceMessageId":"msg_i_made_this_up"}` over every
    // criterion and the gate went silent (measured: continuations 1 -> 0). It
    // was the cheapest forgery in the system: no receipt to clone, no worktree
    // digest to satisfy. Waivers are now signed at attach time and
    // re-validated here, exactly like receipts. Receipt-typed evidence is
    // only as good as the receipt still being observable right now: without
    // this, a criterion with a non-null receiptId is trusted forever, even
    // after a process restart drops the underlying VerificationReceiptStore
    // entry (a real evidence-forging/staleness gap) — so re-validate it via
    // the injected isValidReceipt and treat a stale/unknown receipt as
    // unevidenced.
    if ("receiptId" in c.evidence) return !ctx.isValidReceipt(sid, c.evidence.receiptId)
    return !verifyWaiverSignature(
      { sessionID: sid, criterionId: c.id, sourceMessageId: c.evidence.sourceMessageId },
      c.evidence.signature,
    )
  })
  if (!unmet) return true // all evidenced (or zero pins handled by caller) — eligible to close

  if (holdoutSuppresses(sid, "criteria-gate")) {
    logHoldoutSuppress(sid, "v2 criteria stop-block skipped (holdout arm=off)", { family: "criteria-gate" })
    return false
  }

  if (state.criteriaBlocks >= ctx.maxCriteriaBlocks) {
    return false // past cap — allow through, warn only
  }

  state.criteriaBlocks += 1
  const activeStory = ctx.storyEngine.getActiveStory(sid)
  const command = narrowestPrescription(ctx, state, sid, activeStory?.verifiers ?? null)
  const reason = `[vertex:criteria-block] Unmet acceptance criterion ${unmet.id}: "${unmet.text}" — no evidence recorded. Run ${command} and cite its observed result, or explain why this criterion no longer applies.`
  await dispatchContinuation(ctx, sid, state, formatGateContinuationText(reason))
  return false
}

/**
 * `docs/VERIFIER-PROMPT.md` §5: bounded window of recent turns (both roles)
 * folded into `recentTranscript`. Char-capped downstream by
 * `buildVerifierPayload` (`VERIFIER_TRANSCRIPT_FIELD_CHAR_CAP`, 4000 chars) — this
 * turn-count is a soft pre-filter, not the real bound. Judgment call: no
 * number is given in the design doc beyond "the last few turns"; 8 messages
 * (roughly 4 exchanges) is picked to comfortably carry an earlier hedge or
 * admitted shortcut a couple of turns back, while the char cap is what
 * actually keeps the payload bounded regardless of this constant.
 */
const VERIFIER_RECENT_TRANSCRIPT_TURN_WINDOW = 8

/**
 * Structural shape of one `client.session.messages` entry. Deliberately
 * loose (both `info`/`message` naming and an optional `parts` array) to
 * mirror `wiring/tools.ts`'s own `isUserMessage`/`ClientMessage` handling of
 * the same SDK call — that helper is not exported, so this is a parallel,
 * intentionally-identical shape rather than a shared import (this module's
 * SCOPE does not include editing `tools.ts`).
 */
interface VerifierTranscriptEntry {
  info?: { id?: string; role?: string }
  message?: { id?: string; role?: string }
  parts?: Array<{ type?: string; text?: unknown }>
}

function isFieldsStyle(value: unknown): value is { data?: unknown; error?: unknown } {
  return typeof value === "object" && value !== null && ("data" in value || "error" in value)
}

function extractEntryText(entry: VerifierTranscriptEntry): string {
  return (entry.parts ?? [])
    .filter((p): p is { type: string; text: string } => !!p && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n")
}

/**
 * `docs/VERIFIER-PROMPT.md` §5: fetches the parent session's own last assistant
 * message (verbatim) and a bounded recent-turn window (both roles, compact
 * `role: text` format) to feed `buildVerifierPayload`'s new `lastResponse`/
 * `recentTranscript` raw fields. Uses the exact same `client.session.messages`
 * call shape already proven working elsewhere in this codebase
 * (`wiring/tools.ts:58`'s `isUserMessage`, for waiver-provenance validation)
 * — not new capability.
 *
 * Fails open on any fetch/shape problem (empty strings, never throws),
 * matching this module's "advisory, never gating" posture for the verifier as a
 * whole: a transcript fetch failure must degrade the verifier's input, not
 * break the close-out path that calls this.
 */
async function fetchVerifierTranscriptFields(
  client: OpencodeClient,
  sid: string,
): Promise<{ lastResponse: string; recentTranscript: string }> {
  const empty = { lastResponse: "", recentTranscript: "" }
  try {
    const raw = await client.session.messages({ path: { id: sid } } as never)
    const list = isFieldsStyle(raw) ? raw.data : raw
    if (!Array.isArray(list)) return empty

    const turns = (list as VerifierTranscriptEntry[])
      .map((entry) => {
        const info = entry.info ?? entry.message
        const role = info?.role
        if (role !== "user" && role !== "assistant") return null
        const text = extractEntryText(entry)
        if (!text) return null
        return { role, text }
      })
      .filter((t): t is { role: "user" | "assistant"; text: string } => t !== null)

    let lastResponse = ""
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].role === "assistant") {
        lastResponse = turns[i].text
        break
      }
    }

    const recentTranscript = turns
      .slice(-VERIFIER_RECENT_TRANSCRIPT_TURN_WINDOW)
      .map((t) => `${t.role}: ${t.text}`)
      .join("\n")

    return { lastResponse, recentTranscript }
  } catch {
    return empty
  }
}

/**
 * Redesign point 4/8: renders the plan for the verifier payload's `plan` field —
 * the whole plan for context, with the stories to audit named up front. The
 * verifier reads this, then verifies the claims against the worktree itself
 * (its own read/grep/glob/bash), so the digest's job is precision, not
 * persuasion: statuses, the task decomposition (id/dependsOn/status), the
 * acceptance items that ARE the contract, and declared verifiers, verbatim.
 *
 * 2026-07-30 task/DAG redesign: the old stored `StoryV2.wave` field is GONE
 * — waves are computed from the task DAG as topological levels, never stored
 * or input — so the digest now renders each story's TASKS (with their own
 * `dependsOn`) instead of a wave number, handing the verifier the same
 * dependency structure the engine promotes by. The verifier still audits STORIES
 * (acceptance items are the contract); a story becomes auditable when all its
 * tasks complete, which is exactly when `handleVerifierAudit` picks it up.
 *
 * FR-011 (P0 — `docs/VERIFIER-RELIABILITY-FIXES-SPEC.md` US-9 AS1): the digest
 * MUST open with the ABSOLUTE worktree root. Every path the plan carries
 * (acceptance items, `verifiers:` lines, scope globs) is written relative to
 * the worktree, and the verifier runs in a child session whose cwd it cannot see
 * in the payload. In the audited session (`ses_04dc77bdaffej8SFJvYm5yO0CW`)
 * that gap produced the signature fabrication: the verifier asserted
 * "research/x.json does not exist" about a file that DID exist, because a bare
 * relative path is unresolvable text unless you know what it is relative to.
 * One line of context turns every path in the digest into something the verifier
 * can actually `read`/`ls`, which is the precondition for the prompt's
 * "observe before you claim absence" rule to be followable at all.
 *
 * MIN-002 / FR-006: the stories UNDER AUDIT render first. The digest is
 * truncated at `VERIFIER_PLAN_FIELD_CHAR_CAP` from the END, so plan order alone
 * decided what survived — and in the audited session the truncation removed
 * exactly the `verifiers:` lines of the later stories, after which the verifier
 * FAILed those stories citing the content the cap had removed ("S5 has no
 * independent verifier set in the digest"). Ordering audited stories first
 * makes truncation structurally incapable of dropping the contract being
 * audited; it can now only shed unaudited context, which is what context is
 * for. Relative order WITHIN each group is preserved so the DAG still reads
 * top-to-bottom.
 */
function renderPlanDigest(plan: PlanV2, auditIds: ReadonlySet<string>, workspaceRoot: string): string {
  const lines: string[] = [
    `Worktree root (all paths below are relative to this): ${workspaceRoot}`,
    `Plan: ${plan.stories.length} stories. Audit these claimed-complete stories: ${[...auditIds].join(", ")}.`,
  ]
  const ordered = [
    ...plan.stories.filter((story) => auditIds.has(story.id)),
    ...plan.stories.filter((story) => !auditIds.has(story.id)),
  ]
  ordered.forEach((story) => {
    const claimed = story.completedAt ? `, claimed complete at ${story.completedAt}` : ""
    const storyDeps = story.dependsOn.length > 0 ? `, dependsOn: ${story.dependsOn.join("+")}` : ""
    lines.push(`${story.id} (${story.status}${claimed}${storyDeps}): "${story.text}"`)
    for (const task of story.tasks) {
      const taskDeps = task.dependsOn.length > 0 ? `, dependsOn: ${task.dependsOn.join("+")}` : ""
      lines.push(`  ${task.id} (${task.status}${taskDeps}): ${task.text}`)
    }
    for (const item of story.acceptanceItems) {
      lines.push(`  ${item.id}: ${item.text}`)
    }
    if (story.verifiers.length > 0) {
      lines.push(`  verifiers: ${story.verifiers.join(" && ")}`)
    }
  })
  return lines.join("\n")
}

/**
 * Redesign point 8: the revert continuation is where the verifier's structured
 * verdict becomes constructive, per-story detail — "story S2 not delivered;
 * A3, A4 still missing, and here is what the verifier saw" — instead of a
 * generic "the plan is not done" reminder.
 */
function formatVerifierReverts(plan: PlanV2, verdicts: readonly VerifierStoryVerdict[]): string {
  const lines: string[] = [
    "[vertex:verifier] The completion verifier independently audited your claimed stories against the worktree and found them NOT delivered.",
  ]
  for (const verdict of verdicts.filter((v) => !v.pass)) {
    const story = plan.stories.find((s) => s.id === verdict.storyId)
    lines.push(`Story ${verdict.storyId}${story ? ` — "${story.text}"` : ""} is re-opened: ${verdict.summary}`)
    for (const item of verdict.items.filter((i) => !i.met)) {
      const acceptance = story?.acceptanceItems.find((a) => a.id === item.itemId)
      lines.push(`  ${item.itemId}${acceptance ? ` ("${acceptance.text}")` : ""} — ${item.note}`)
    }
  }
  lines.push(
    "Fix exactly the named items, run each story's declared verifiers as standalone commands (never ';'-chained " +
      "or piped — that hides the real exit code) and read their output, then checkpoint each reverted task complete " +
      "again (elicify_vertex_plan_checkpoint with the taskId) — the story auto-completes when all its tasks are done, " +
      "and the verifier re-audits it. Do not re-claim without new evidence — the verifier re-audits every claim.",
  )
  return lines.join("\n")
}

/**
 * Redesign points 2/4 — THE ARBITER. Replaces the old `appendVerifierCloseOut`,
 * which could only run after every story had already reached `complete`
 * through the deterministic gate — i.e. it could never fire in the one
 * situation it existed for (a session stalled on that gate). This stage runs
 * at EVERY idle in which at least one story has claimed `complete` since its
 * last audit, hands those claims to the tool-using verifier, and APPLIES the
 * structured verdicts:
 *
 *  - failed claim   -> `StoryEngine.applyVerifierVerdicts` reverts the story to
 *    `active`, and a constructive continuation names the unmet items
 *    (returns true — the rest of the tree skips this idle).
 *  - all claims pass -> silent for intermediate stories; a single close-out
 *    line only when the WHOLE plan is settled and the final story's claim
 *    just passed (returns true).
 *  - verifier unavailable/malformed -> fail open (claims stand, a health
 *    notification says the audit did not happen), exactly the posture the
 *    verifier has always had.
 *
 * A story needs auditing when it is `complete` and either carries no verifier
 * stamp at all or was re-claimed (`completedAt`) after its latest stamp —
 * so a verifierd-and-passed plan never re-audits, and a re-claimed story
 * always does.
 */
/** FR-007 — per-story consecutive-revert counter, process-local in
 * `V2SessionState` (deliberately NOT in `plan.json`: that would be a
 * `StoryV2` schema change, and the cap is a courtesy bound, not a safety
 * control). Reset by `resetTurnState` on a real user message. */
function reaudits(state: V2SessionState, storyId: string): number {
  return state.storyReaudits?.[storyId] ?? 0
}
function clearReaudit(state: V2SessionState, storyId: string): void {
  if (!state.storyReaudits?.[storyId]) return
  const next = { ...state.storyReaudits }
  delete next[storyId]
  state.storyReaudits = next
}
function bumpReaudit(state: V2SessionState, storyId: string): void {
  state.storyReaudits = { ...(state.storyReaudits ?? {}), [storyId]: reaudits(state, storyId) + 1 }
}

/**
 * MAJ-003 — a verdict the harness declines to APPLY must still be bounded.
 *
 * Both non-applying paths (FR-005 contradictory, FR-014 unverified) used to
 * `return false` without stamping the story, so the audit selector's
 * `!story.verifier` test re-selected it on the very next idle — a full verifier
 * subturn per idle, forever, with FR-007's cap never reached because it is
 * enforced further down. Measured before this fix: 8 subturns over 8 idles.
 *
 * Stamping records WHY the verdict was not applied (so the state is
 * inspectable) and bumping the counter lets the cap eventually escalate to
 * the operator, which is the intended terminal state.
 */
function boundUnappliedVerdicts(
  ctx: GateContext,
  sid: string,
  state: V2SessionState,
  verdicts: readonly VerifierStoryVerdict[],
  reason: "contradictory" | "unverified" | "capped",
): void {
  for (const verdict of verdicts) {
    bumpReaudit(state, verdict.storyId)
  }
  try {
    ctx.storyEngine.applyVerifierVerdicts(
      sid,
      verdicts.map((v) => ({
        storyId: v.storyId,
        // Never revert on an unapplied verdict — the point is to record that
        // the harness did NOT act on it, not to act on it by another route.
        // C2: `pass: true` was doing double duty here and laundering the
        // refusal into an audit pass; `unapplied` carries the "do not
        // transition" meaning now, and `pass` reports what the verifier said.
        pass: v.pass,
        summary: `verdict not applied (${reason}): ${v.summary}`,
        items: v.items,
        unapplied: reason,
      })),
    )
  } catch {
    // Fail-open: bounding is best-effort bookkeeping, never a new throw path.
  }
}

/**
 * FR-001 — drop the individual `met:false` items whose note asserts a path is
 * absent when that path demonstrably exists inside the worktree.
 *
 * Deliberately item-level and path-only. A story-level "all verifiers passed"
 * veto was withdrawn (grill round 2, C-2) because a story's verifiers can pass
 * while its acceptance items are genuinely unmet — S1's `test -f *.md` passes
 * on a sourceless stub, and "missing `## Sources`" was a CORRECT failure. A
 * path check can only ever contradict a path claim, so this cannot suppress a
 * content finding. Nothing is executed (FR-001a): `verifiers` and every other
 * plan.json string are LLM-authored, so the check is `fs.existsSync` on a
 * root-confined path and nothing else.
 */
function applyPathVeto(
  ctx: GateContext,
  sid: string,
  state: V2SessionState,
  verdict: VerifierStoryVerdict,
): { verdict: VerifierStoryVerdict; contradicted: string[] } {
  if (verdict.pass) return { verdict, contradicted: [] }
  const root = state.workspaceRoot
  const contradicted: string[] = []
  // CR-8: identity of the items this veto actually disproved. `itemId` cannot
  // serve as the key — it is LLM-authored and not unique.
  const contradictedItems = new Set<VerifierItemNote>()

  const items = verdict.items.map((item) => {
    if (item.met) return item
    const { paths } = parsePathAbsenceClaim(item.note)
    if (paths.length === 0) return item
    // C-3 rule 4: a multi-path note is only contradicted when EVERY named
    // path exists — "No src/App.tsx, src/App.jsx, …" with two present and two
    // absent is a true claim about the absent ones.
    let allExist = true
    for (const candidate of paths) {
      const resolved = resolvePath(root, candidate)
      // Never check outside the worktree: a `..` escape or absolute path is
      // ignored, not followed.
      if (!resolved.startsWith(resolvePath(root) + sep) && resolved !== resolvePath(root)) {
        allExist = false
        break
      }
      if (!existsSync(resolved)) {
        allExist = false
        break
      }
    }
    if (!allExist) return item
    contradicted.push(item.itemId)
    ctx.logger("verifier:contradicted", { sessionID: sid, storyId: verdict.storyId, itemId: item.itemId, paths })
    // MIN-003 (code review): FR-001b says the stamp must RETAIN the original
    // items plus the marker. Flipping `met` to true here rewrote the verifier's
    // finding in the durable record; the note is annotated instead so a reader
    // sees both what the verifier claimed and that the harness disproved it.
    // `contradictedItemIds` on the stamp remains the machine-readable signal.
    const annotated = { ...item, note: `${item.note} [harness: contradicted — path(s) exist: ${paths.join(", ")}]` }
    contradictedItems.add(annotated)
    return annotated
  })

  if (contradicted.length === 0) return { verdict, contradicted }
  // FR-001 AS2: every failing item was individually disproven, so the story's
  // pass is re-derived — but FR-001b requires the result stay distinguishable
  // from a genuine verifier pass (see `applyVerifierVerdicts`'s `contradictedItemIds`).
  // A story passes only when EVERY failing item was individually disproven.
  // Derived from the contradiction set because `met` is deliberately left
  // untouched above (MIN-003).
  // CR-8 (round 5): `verdict.items` is LLM-authored and has NO uniqueness
  // guarantee on `itemId`. Matching by id through a Set let one disproven path
  // claim clear a DIFFERENT item that merely shared the id — laundering a
  // genuine content failure into a harness-derived pass, which is the exact
  // outcome FR-001 was narrowed to prevent. Match by identity instead: the
  // veto records the item objects it actually disproved.
  const stillFailing = items.some((i) => !i.met && !contradictedItems.has(i))
  return { verdict: { ...verdict, items, pass: !stillFailing }, contradicted }
}

/**
 * C2 — the settled-but-never-audited close-out.
 *
 * A bounding stamp (`verifier.unapplied`) stops the audit selector from re-running
 * the verifier on that story, which is its whole point. The consequence is that
 * once every story is complete and stamped, `handleVerifierAudit` returns early
 * and the plan's real close-out — the one that reports the audit result — is
 * never reached. While the bounding stamp said `pass: true`, that did not show:
 * the story counted toward `allPassed` and the run ended claiming the verifier had
 * independently verified everything. With `pass` now telling the truth, the
 * same path would instead end in SILENCE, which is a different way of not
 * telling the operator that a story was never checked.
 *
 * So say it. This fires at the early return, the only place reachable once the
 * selector is empty, and only when at least one stamp is a bounding stamp — a
 * genuinely all-passed plan still returns false here and gets its close-out
 * from the audit that settled it.
 */
/**
 * `itemId` is LLM-authored: "A1", "a1", "A1.", "A-1" all mean the same
 * acceptance item. Compare on the alphanumerics only, so the substantiation
 * rules below turn on whether the judge named a DECLARED item, never on how
 * it punctuated the id.
 */
function normalizeItemId(id: string): string {
  return id.trim().toLowerCase().replace(/[^a-z0-9]/g, "")
}

/**
 * Is this verdict backed by something, or invented?
 *
 * A failing verdict must name the acceptance items it failed and say why. That
 * is what distinguishes judgement from fabrication — not whether a shell
 * command ran. A passing verdict with every item met costs nothing to apply.
 *
 * B-3b (operator ruling, 2026-08-06) — "the judge should not go by exit codes
 * … the judge needs simply to judge if the goal was achieved, all stories
 * delivered, and generally validated". The prompt half of that lives in
 * `VERIFIER_SYSTEM_PROMPT`; this is the half that binds. Two rules, both
 * turning on the story's DECLARED acceptance items, because those are the
 * contract the ruling names — and both are exactly the shape a
 * verdict-from-a-command-result takes:
 *
 *  - A FAILURE must name a declared acceptance item. `{itemId: "verifier",
 *    met: false, note: "npm test exited 1"}` fails a story on the shell rather
 *    than on its contract; the old rule accepted it because the note was
 *    non-empty. At least ONE failing item must be a declared one — not all of
 *    them, so an extra observation the judge volunteers alongside a real
 *    finding never discards the finding.
 *  - A PASS must have judged every declared acceptance item. A green suite
 *    plus one blanket `{itemId: "A1", met: true}` on a three-item story is
 *    a verdict about the command, not about the story; the two unexamined
 *    items are precisely where "delivered" and "the tests are green" diverge.
 *
 * `story` is optional and a story with NO declared acceptance items skips both
 * rules: there is nothing to name and nothing to cover, so the pre-B-3b
 * behaviour stands rather than freezing such a story permanently (the worker
 * is separately told to amend it — `findings.ts`).
 */
function verdictIsSubstantiated(v: VerifierStoryVerdict, story?: StoryV2): boolean {
  // ORDER MATTERS. `[].every()` is vacuously TRUE, so testing `pass` first
  // made a `pass:true` with no items read as substantiated — the same
  // vacuous-truth trap that let an empty `items` array bypass the old floor.
  // Nothing behind the verdict means unsubstantiated, whichever way it points.
  if (v.items.length === 0) return false
  const declared = new Set((story?.acceptanceItems ?? []).map((i) => normalizeItemId(i.id)))
  if (v.pass && v.items.every((i) => i.met)) {
    if (declared.size === 0) return true
    const judged = new Set(v.items.map((i) => normalizeItemId(i.itemId)))
    return [...declared].every((id) => judged.has(id))
  }
  // Every failed item must carry a reason. An empty note is an assertion, not
  // a finding.
  const failing = v.items.filter((i) => !i.met)
  if (!failing.every((i) => (i.note ?? "").trim().length > 0)) return false
  // `pass:false` with nothing failing is FR-005's contradictory case, bounded
  // (and logged) further down as `"contradictory"`. Leave it to that branch
  // rather than relabelling it here.
  if (failing.length === 0) return true
  if (declared.size === 0) return true
  return failing.some((i) => declared.has(normalizeItemId(i.itemId)))
}

/**
 * Has the code moved since this verdict was formed?
 *
 * A verdict is a SNAPSHOT. The only freshness test used to be
 * `verifiedAt < completedAt`, which never fires when an ALREADY-COMPLETE story
 * is edited — and that is the common case, because the harness's own nudges
 * ask the model to go fix things. Measured live: the verifier failed two
 * stories at 06:43:46 naming specific defects, the model fixed both at
 * 06:44:46, and the harness re-litigated the dead verdict until the session
 * was abandoned. Both of its claims were false by then; the worker was right.
 *
 * So a mutation observed after `verifiedAt` retires the verdict. The story is
 * re-audited rather than argued about — which makes "who is right" settle
 * itself instead of becoming a standoff.
 */
function verdictOutdatedByEdits(ctx: GateContext, sid: string, state: V2SessionState, story: StoryV2): boolean {
  const verdict = story.verifier
  const verifiedAt = verdict?.verifiedAt
  if (!verdict || !verifiedAt) return false

  // A CLEAN PASS IS TERMINAL. Re-judging a story that already passed lets an
  // oscillating verifier flip it, and `clearReaudit` on a pass resets the
  // streak — so the cap could never trip: revert, fix, pass, edit, revert,
  // unbounded. It also made the settled-plan close-out re-fire on any later
  // file touch (measured: 3 close-outs for 2 post-settlement edits), which is
  // the "harness will not shut up" failure this change exists to end.
  if (verdict.pass && verdict.unapplied === undefined) return false

  // THE CAP STILL BINDS. Without this, staleness re-audited a bounded story on
  // every idle that followed any edit — measured at 5 verifier subturns over 5
  // rounds with `unapplied` stuck and the cap never firing, which is exactly
  // the unbounded audit loop `maxStoryReaudits` was added to stop.
  // `ctx.maxStoryReaudits > 0` FIRST. `<= 0` is the documented way to DISABLE
  // the cap (GateContext doc, CR-15 in plugin.ts, spec US-7 AS-4), and the
  // revert path at the bottom of this file already spells it that way. Without
  // it, `0` disabled staleness instead of the cap — handing an operator who
  // turned the cap off the original live bug back, unbounded.
  if (ctx.maxStoryReaudits > 0 && reaudits(state, story.id) >= ctx.maxStoryReaudits) return false

  // SCOPE LIMIT, stated rather than implied: the ledger is turn-scoped and
  // in-memory, so it is empty after a user message and after a host restart.
  // A verdict therefore never goes stale ACROSS a turn — only within the one
  // where the fix landed, which is the case that looped. Widening this needs
  // durable mutation timestamps, not a change here.
  const lastMutationAt = ctx.evidenceLedger.getLastMutationAt(sid)
  // `<=`, not `<`. Both stamps are millisecond ISO strings, so an edit landing
  // in the same millisecond as the verdict is indistinguishable from one
  // landing just after it. Ambiguity resolves toward RE-AUDITING: the cost is
  // one extra audit, versus escalating a verdict the code may already have
  // moved past — which is the standoff this exists to end.
  return lastMutationAt !== null && verifiedAt <= lastMutationAt
}

async function emitUnauditedEscalation(
  ctx: GateContext,
  sid: string,
  state: V2SessionState,
  plan: PlanV2,
): Promise<boolean> {
  // (guard moved below, once the unresolved set is known)
  if (!plan.stories.every((story) => story.status === "complete" && story.verifier !== undefined)) return false
  // (A guard for stale verdicts stood here and was provably dead: the audit
  // selector includes any stale story, so `unverifiedStories` is non-empty and
  // this function is never reached in that case. Removed rather than left as
  // decoration.)
  // A capped story WAS audited — the verifier failed it and the harness stopped
  // reverting. Reporting it as "never verified" would be false, so the two
  // groups are named separately.
  const unverified = plan.stories.filter((s2) => s2.verifier?.unapplied !== undefined && s2.verifier.unapplied !== "capped")
  const disputed = plan.stories.filter((s2) => s2.verifier?.unapplied === "capped")
  const unaudited = [...unverified, ...disputed].map((story) => story.id)
  if (unaudited.length === 0) return false

  // FIX 2: speak once per unresolved SET, not once per turn. Every
  // continuation starts a turn, so a per-turn guard let this repeat forever
  // against a state nothing could move.
  const signature = `${plan.revision ?? 0}:${unaudited.join(",")}`
  if (state.unauditedEscalatedFor === signature) return false
  ctx.logger("verifier:unaudited-escalation", { sessionID: sid, stories: unaudited })
  const clauses: string[] = []
  if (unverified.length > 0) {
    clauses.push(
      `the completion verifier produced no usable verdict for ${unverified.map((s2) => s2.id).join(", ")}, so ` +
        "those stories were NOT verified against the worktree",
    )
  }
  if (disputed.length > 0) {
    clauses.push(
      `the verifier repeatedly failed ${disputed.map((s2) => s2.id).join(", ")} and the re-audit cap was reached, so ` +
        "the harness stopped re-opening them — those stories are DISPUTED, not confirmed",
    )
  }
  const dispatched = await dispatchContinuation(
    ctx,
    sid,
    state,
    `[vertex:verifier] Every story of the plan is complete, but ${clauses.join("; and ")}. Report what was delivered, ` +
      `the commands you ran and the results you observed, state explicitly that ${unaudited.join(", ")} did not pass ` +
      "audit, then stop.",
  )
  // MAJ-4 (grill round 3): spend the once-only flag ONLY on a dispatch that
  // actually happened. Setting it beforehand meant a stall-paused or refused
  // dispatch burned the single escalation and the run ended in silence — the
  // very outcome this branch exists to prevent.
  if (dispatched) state.unauditedEscalatedFor = signature
  return dispatched
}

async function handleVerifierAudit(ctx: GateContext, sid: string, state: V2SessionState): Promise<boolean> {
  if (!ctx.verifierEnabled) return false
  const plan = ctx.storyEngine.getPlan(sid)
  if (!plan) return false
  if (!state.modelId) return false

  const unverifiedStories = plan.stories.filter(
    (story) =>
      story.status === "complete" &&
      (!story.verifier ||
        (story.completedAt !== undefined && story.verifier.verifiedAt < story.completedAt) ||
        // The code moved under the verdict — re-audit rather than re-litigate.
        verdictOutdatedByEdits(ctx, sid, state, story)),
  )
  // NO bump here. `boundUnappliedVerdicts` already bumps once per bounded
  // verdict and the revert path bumps once per failing one, so counting the
  // selection too would double-charge a staleness re-audit and halve the
  // effective cap. The selector's job is to READ the cap, not to charge it.
  if (unverifiedStories.length === 0) return emitUnauditedEscalation(ctx, sid, state, plan)

  const [providerID, ...rest] = state.modelId.split("/")
  const modelID = rest.join("/")
  if (!providerID || !modelID) return false

  const auditIds = new Set(unverifiedStories.map((story) => story.id))
  const criteria = ctx.pinStore.get(sid).map((c) => c.text)
  const verifierSummaries = ctx.recentVerifierSummaries(sid)
  const diff = ctx.diffSummary(sid)
  const { lastResponse, recentTranscript } = await fetchVerifierTranscriptFields(ctx.client, sid)
  const payload = buildVerifierPayload(
    {
      criteria,
      diffSummary: diff.text,
      // B-3 (d): when there is no real diff behind `diffSummary`, say WHY in
      // the payload. A silent absence is what let the audited session's
      // verdict form with no file evidence at all.
      ...(diff.unavailableReason === undefined ? {} : { diffSummaryUnavailable: diff.unavailableReason }),
      verifierSummaries,
      lastResponse,
      recentTranscript,
      // FR-011: the verifier cannot resolve the digest's relative paths without
      // the root it is told they are relative to.
      plan: renderPlanDigest(plan, auditIds, state.workspaceRoot),
    },
    bindSession(sid, ctx.logger),
  )

  const result = await runVerifier(
    ctx.client,
    { selfCreated: ctx.selfCreated, logger: bindSession(sid, ctx.logger) },
    {
      parentSessionID: sid,
      sessionModel: { providerID, modelID },
      payload,
    },
  )

  if (!result.verdict) {
    // FR-061: a verifier that silently does not run is indistinguishable from a
    // verifier that passed. Say so.
    void ctx.visibility?.notify("health", {
      sessionID: sid,
      family: "verifier:unavailable",
      message: `the completion verifier did not run (${result.reason ?? "unknown"}) — claimed stories are unverified`,
      variant: "warning",
    })
    // CHARGE THE ROUND. Every other exit from this function reaches a bump —
    // `boundUnappliedVerdicts` for a bounded verdict, the revert path for a
    // failing one. These two returns predate both, so a story that keeps being
    // re-selected by staleness got a free verifier subturn on every idle
    // forever. Measured: 6 extra subturns over 6 rounds with the counter stuck
    // at 1. Charged here, and NOT at selection, so the ordinary revert path is
    // not double-billed.
    for (const storyId of auditIds) bumpReaudit(state, storyId)
    return false
  }

  // Verdicts for stories outside the audit set are dropped, not applied —
  // the verifier was told what to audit; anything else it chose to opine on is
  // not grounded in this run's payload.
  const onTarget = result.verdict.stories.filter((v) => auditIds.has(v.storyId))
  if (onTarget.length === 0) {
    ctx.logger("verifier:off-target", {
      sessionID: sid,
      requested: [...auditIds],
      received: result.verdict.stories.map((v) => v.storyId),
    })
    // Same reasoning as the `!result.verdict` return above: an off-target
    // verdict is a round spent, or a verifier that never names the right story
    // buys unlimited subturns.
    for (const storyId of auditIds) bumpReaudit(state, storyId)
    return false
  }

  // FR-014 — the tool-call floor. The audited session's verifier fabricated
  // filesystem claims it never looked at; a live probe reproduced it in 9.8s
  // and showed that when the verifier DOES observe, it is right. A `met:false`
  // the verifier produced without a single tool call is therefore unverified,
  // not evidence — and unlike FR-001 this covers CONTENT claims too (29 of
  // the 49 recovered real notes are content-only, the class no path check can
  // ever contradict). Fail-open: an unreadable child session applies the
  // verdict exactly as before.
  // FR-014 — the tool-call floor. Reads the flag `runSubturn` captured BEFORE
  // it deleted the child session (code review MAJ-004: a gate-side read always
  // saw a deleted session, so this floor never fired against a real host).
  // `undefined` means "could not tell" and fails open, exactly as before.
  const observed = result.observedToolCall
  // CR-4 (round 5): the trigger was `some(item => !item.met)`, which is
  // VACUOUSLY FALSE for a verdict with an empty `items` array — so the most
  // unsubstantiated verdict of all (a `pass:false` with no items at all,
  // produced without a single tool call) sailed past the floor and reverted
  // the story. `isVerifierVerdictShape` accepts `items: []`, FR-005 is gated on
  // `items.length > 0`, and `applyPathVeto` maps an empty array, so nothing
  // downstream caught it either. Any unobserved verdict that would COST
  // something — a failing story, or one with nothing backing it — is bounded.
  // FIX 1 — THE VERIFIER JUDGES; IT DOES NOT JUST RUN COMMANDS.
  //
  // This floor used to discard any failing verdict produced without a tool
  // call. That is the wrong test. The verifier is handed the plan digest,
  // the acceptance criteria, the diff summary, the verifier output and the
  // session transcript — reading that evidence IS the work, and the
  // transcript is the LEADING evidence, not the shell.
  //
  // Measured cost of the old rule (live session, 09:14:58): the verifier read
  // the payload, judged all five stories unmet, and wrote per-item notes
  // saying why. The verdict was thrown away for want of an `ls`, every story
  // froze at `complete / pass=false / unapplied=unverified`, and two branches
  // argued about that state for the rest of the session.
  //
  // The real risk — a verdict invented about work nobody looked at — is
  // caught by SUBSTANTIATION, and by `applyPathVeto`, which independently
  // checks the worktree whenever the verifier claims a path is missing. That
  // is the defence that actually works; a tool call proves nothing about
  // whether the verdict was reasoned.
  const storyById = new Map(plan.stories.map((s) => [s.id, s]))
  const unsubstantiated = onTarget.some((v) => !verdictIsSubstantiated(v, storyById.get(v.storyId)))
  if (unsubstantiated) {
    ctx.logger("verifier:unverified", { sessionID: sid, stories: onTarget.map((v) => v.storyId) })
    void ctx.visibility?.notify("health", {
      sessionID: sid,
      family: "verifier:unverified",
      // B-3b: the old wording ("failed stories without observing the
      // worktree") described the deleted tool-call floor, not the rule that
      // actually fires here.
      message:
        "the completion verifier's verdict is not substantiated against the story's acceptance items — verdict not applied",
      variant: "warning",
    })
    // MAJ-003: this drop-path must still count toward the re-audit cap and
    // stamp the story, or the audit selector re-selects it every idle forever
    // (measured: 8 verifier subturns over 8 idles, cap never firing).
    // CR-5 (round 5): bound only the verdicts this floor is ABOUT. It used to
    // sweep the whole batch, so a story the verifier PASSED with every item met
    // was stamped `unapplied:"unverified"` too — which bars it from
    // `allPassed` AND from re-audit (the selector skips a stamped story), so
    // it could never become verified for the rest of the run. A passing,
    // fully-met verdict costs nothing to apply and is not what the tool-call
    // floor exists to stop.
    // B-3b: `!verdictIsSubstantiated(...)` FIRST, or the new pass rule is
    // inert — a `pass:true` that skipped acceptance items satisfies every
    // clause below and would be applied by the very branch that just refused
    // the batch. The remaining clauses are unchanged and still decide the
    // failing/empty/partial shapes.
    const unsubstantiated = onTarget.filter(
      (v) => !verdictIsSubstantiated(v, storyById.get(v.storyId)) || !v.pass || v.items.length === 0 || v.items.some((i) => !i.met),
    )
    const substantiated = onTarget.filter((v) => !unsubstantiated.includes(v))
    boundUnappliedVerdicts(ctx, sid, state, unsubstantiated, "unverified")
    if (substantiated.length > 0) {
      // A clean pass in the same batch still applies, so a story the verifier
      // genuinely confirmed is not held hostage by a sibling's bad verdict.
      try {
        ctx.storyEngine.applyVerifierVerdicts(sid, substantiated)
      } catch {
        // Fail-open: applying the clean subset is best-effort.
      }
    }
    return false
  }
  if (observed === undefined) {
    ctx.logger("verifier:crosscheck-inconclusive", { sessionID: sid, reason: "child session parts unreadable" })
  }

  // FR-001 + FR-005 — reconcile each verdict against deterministic fact
  // BEFORE applying it. Both rules are per story so one bad verdict can never
  // discard a sibling's correct finding (grill round 2, M-9).
  const reconciled: VerifierStoryVerdict[] = []
  const contradictedByStory = new Map<string, string[]>()
  for (const verdict of onTarget) {
    // FR-005: `pass:false` while every listed item is `met:true` is
    // self-contradictory. Drop THIS story's verdict (never repair it into a
    // pass the verifier did not give), leave the story untouched, and let the
    // re-audit cap bound the retry.
    if (!verdict.pass && verdict.items.length > 0 && verdict.items.every((i) => i.met)) {
      ctx.logger("verifier:verdict-contradictory", { sessionID: sid, storyId: verdict.storyId })
      // MAJ-003: bound it — bump the cap AND stamp the story, otherwise the
      // audit selector (`!story.verifier`) re-selects it on every subsequent
      // idle and the verifier is re-run forever with no exit.
      boundUnappliedVerdicts(ctx, sid, state, [verdict], "contradictory")
      continue
    }

    const { verdict: checked, contradicted } = applyPathVeto(ctx, sid, state, verdict)
    if (contradicted.length > 0) contradictedByStory.set(verdict.storyId, contradicted)
    reconciled.push(checked)
  }
  if (reconciled.length === 0) return false

  // FR-007 — cap consecutive reverts per story. A disputed story is escalated
  // to the operator instead of looping: the audited session ran 9 audit
  // cycles and 82 checkpoints over 10 tasks with no exit.
  const applicable: VerifierStoryVerdict[] = []
  for (const verdict of reconciled) {
    if (!verdict.pass && reaudits(state, verdict.storyId) >= ctx.maxStoryReaudits && ctx.maxStoryReaudits > 0) {
      ctx.logger("verifier:reaudit-capped", { sessionID: sid, storyId: verdict.storyId, reverts: reaudits(state, verdict.storyId) })
      void ctx.visibility?.notify("health", {
        sessionID: sid,
        family: "verifier:reaudit-capped",
        message: `story ${verdict.storyId} has been re-opened by the verifier ${reaudits(state, verdict.storyId)} times — not reverting again; resolve it or amend the story`,
        variant: "error",
      })
      // M3 (grill round 2): the cap used to `continue` here WITHOUT stamping,
      // which stopped the revert but not the loop. `story.verifier` kept its
      // previous stamp, whose `verifiedAt` predates the `completedAt` written
      // when the story was re-completed, so the audit selector re-selected it
      // on the very next idle — a full verifier subturn every idle, forever, the
      // exact runaway FR-007 exists to end. Stamping it bounds the selector;
      // marking it `capped` keeps it out of the close-out's `allPassed`.
      boundUnappliedVerdicts(ctx, sid, state, [verdict], "capped")
      continue
    }
    // MIN-004: the cap is on CONSECUTIVE reverts, so a pass clears the streak.
    // Without this it was cumulative-per-turn and would escalate a story that
    // had recovered in between.
    if (verdict.pass) clearReaudit(state, verdict.storyId)
    else bumpReaudit(state, verdict.storyId)
    applicable.push(verdict)
  }
  if (applicable.length === 0) return false

  const applied = ctx.storyEngine.applyVerifierVerdicts(sid, applicable, contradictedByStory)

  if (applied.reverted.length > 0) {
    return dispatchContinuation(ctx, sid, state, formatGateContinuationText(formatVerifierReverts(plan, applicable)))
  }

  // Close-out fires when the WHOLE plan is settled and EVERY story carries a
  // passing verifier stamp — not only when the final story was in this audit's
  // set. `applyVerifierVerdicts` stamps `story.verifier` in place on the plan
  // object this closure holds, so `plan` already reflects the fresh stamps;
  // a story verifierd-pass in an earlier audit keeps its stamp, so staggered
  // audits (final passes first, a non-final story passes in a later audit)
  // still produce the close-out line on the audit that settles the plan.
  // It cannot re-fire on a later idle: once every story is complete with a
  // passing stamp, none is "unverifiedStories", so this function returns early before
  // reaching here.
  const settled = plan.stories.every((story) => story.status === "complete")
  // C2: a bounding stamp (`unapplied`) is NOT a pass. It records that the
  // harness refused to act on an unusable verdict, so the story has never
  // actually been audited — counting it here let an unverified story satisfy
  // "every story passed" and produce the independently-verified close-out.
  const allPassed = plan.stories.every((story) => story.verifier?.pass === true && story.verifier.unapplied === undefined)
  if (settled && allPassed) {
    // FR-001b: a pass the HARNESS re-derived (by contradicting the verifier's
    // path claims) must not be reported as "the verifier independently
    // verified" — that would launder a harness override into an audit
    // result. Name those stories instead.
    const vetoed = plan.stories.filter((s2) => (s2.verifier?.contradictedItemIds?.length ?? 0) > 0).map((s2) => s2.id)
    const line =
      vetoed.length === 0
        ? "[vertex:verifier] The completion verifier independently verified every story of the plan against the worktree — " +
          "all claims passed audit. Report what was delivered, the commands you ran and the results you observed, then stop."
        : "[vertex:verifier] Every story of the plan is complete. The verifier verified all of them except " +
          `${vetoed.join(", ")}, where the harness overruled a verifier claim that a file was missing when it demonstrably exists ` +
          "(those items were not independently confirmed by the verifier). Report what was delivered, the commands you ran and " +
          "the results you observed, then stop."
    return dispatchContinuation(ctx, sid, state, line)
  }
  return false
}

/**
 * Direct-membership-only parent lookup for the `selfCreated` filter below.
 *
 * `SelfCreatedSessions.isSelfCreated` checks the id itself against the
 * recorded set BEFORE ever calling `resolveParent` (see `subturn.ts`), and
 * the only sessions this harness creates are the verifier and intake subturns —
 * direct children, recorded by id, never nested further (`wiring/state.ts`'s
 * `SelfCreatedGuard` doc says the same). `GateContext` carries no
 * parent-lookup function, so supplying one here would mean inventing a seam
 * `plugin.ts` does not fill; the direct-id check covers every case that
 * actually occurs. The defensive grandchild case is noted, not silently
 * claimed as covered.
 */
const NO_PARENT_LOOKUP = (): string | null => null

/**
 * Full FR-015 decision tree for `event(session.idle)`. Caller is
 * responsible for the FR-036 self-created-session early return before
 * calling this.
 *
 * ── ENFORCEMENT IS PER-SESSION ────────────────────────────────────────────
 * This function used to return early — skipping promise-no-act, the
 * stop-block continuation, the criteria replay and the verifier — whenever
 * `ctx.activeSessionIDs().length > 1`. That came from spec FR-015's
 * multi-session advisory clause (review MIN-007), whose stated premise was:
 * with two sessions active, `file.edited` attribution is suppressed, "so
 * evidence cannot accrue", therefore the gate must not block.
 *
 * That premise does not hold in v2, and the guard was removed for it:
 *
 *  - Multi-session only suppresses ONE input: `plugin.ts`'s `file.edited`
 *    branch (`event()`, mirroring v1's `src/index.ts` `file.edited` handler),
 *    which requires exactly one active session before calling
 *    `recordChangedFiles` / `verificationReceipts.invalidate`.
 *  - That input feeds the CHANGE side of the ledger only. Every EVIDENCE
 *    input — `parseVerification` in `tool.execute.after`, checkpoint
 *    receipts, criterion evidence — is carried on a hook payload that names
 *    its own session id, so it still accrues normally with any number of
 *    sessions active.
 *  - Suppressing changes can therefore only make the gate quieter, never
 *    produce a block the model cannot satisfy. There was no unsatisfiable-
 *    block hazard for the bail-out to prevent, while the bail-out itself
 *    disabled promise-no-act, the stop-block and the verifier for BOTH
 *    sessions the moment a second one existed (waves-review MAJ-007).
 *  - v1 never had this bail-out either: `src/index.ts`'s `session.idle`
 *    handler checks only `gate.isActive(sid)` and the in-flight set. The
 *    session-count test lives solely in its `file.edited` branch.
 *
 * What the guard's real intent WAS — telling the operator that attribution
 * is degraded — is preserved below: the advisory still logs and still sets
 * `needsCriteriaReinject`. It just no longer suppresses anything.
 *
 * Everything this function then touches is session-keyed (`EvidenceLedger`,
 * `PinStore`, `StoryEngine`'s per-session `plan.json` entry, `PhaseEngine`,
 * `InjectionComposer`, `holdoutSuppresses`, `V2SessionState`), and this
 * module holds no mutable module-level state, so two sessions running this
 * concurrently cannot read or clobber each other's decisions.
 */
export async function handleSessionIdle(ctx: GateContext, sid: string): Promise<void> {
  const state = ctx.states.get(sid)
  if (!state || !state.active) return

  // Re-entrancy, per session. `promptContinuation` sets this flag while its
  // `session.prompt` is outstanding, and that prompt re-enters the host's
  // `chat.message`/`session.idle` path for THIS session. `plugin.ts`'s
  // `event()` already checks it, but with the multi-session bail-out gone
  // this is the only thing standing between a continuation and its own echo,
  // so the gate enforces it itself rather than trusting one caller. It is a
  // per-session flag, so a busy session never gates an idle peer.
  if (state.idleContinuationInFlight) return

  // AFTER the re-entrancy guard, not before. Stamping the turn on an idle the
  // gate is about to abandon overwrote the marker of the turn still in flight,
  // so the `spoken`/marker checks in `dispatchContinuation` were comparing
  // against a turn that never ran.
  beginIdleTurn(sid, state.activityMarker)

  // Redesign point 9 (stall): the gate paused itself after a run of
  // continuations that produced no observable activity. It stays silent
  // until the next real user message re-arms it (`resetTurnState`) — nudging
  // harder is precisely the failure this exists to stop.
  if (state.stallPaused) return

  // Redesign point 9 (task-blocking awareness): never nudge a parent that is
  // legitimately waiting on its own `task`-tool delegation. The tracker is the
  // cheap synchronous answer; the busy-children probe is the ground-truth
  // cross-check that ALSO repairs a stale tracker entry (a `task` whose
  // `tool.execute.after` the host dropped, or an inconsistent callID between
  // the before/after hooks). So when the tracker reports in-flight we still
  // probe, and defer ONLY if the probe confirms a busy child — otherwise the
  // stale entry is logged and the gate proceeds. A tracker positive never
  // silences the gate on its own. Both fail open.
  if (ctx.delegation.hasInFlightDelegation(sid)) {
    if (await hasBusyChildren(ctx.client, sid)) {
      ctx.logger("gate:delegation-defer", { sessionID: sid, via: "tracker+probe" })
      return
    }
    ctx.logger("gate:delegation-stale", { sessionID: sid })
  } else if (await hasBusyChildren(ctx.client, sid)) {
    ctx.logger("gate:delegation-defer", { sessionID: sid, via: "probe" })
    return
  }

  // Degraded-attribution ADVISORY (never a suppression — see doc above).
  //
  // FR-036: a session the harness itself created (verifier/intake subturn) is
  // not a peer user session. If one ever reaches this list, it must not make
  // its own parent look multi-session — that would fire a spurious
  // criteria-reinject on every verifier close-out, and under the old bail-out
  // would have let a single user session silently disable its own gate.
  // `plugin.ts` keeps child sessions out of `states` today (every hook that
  // creates state returns early for `isSelf`), so this filter is
  // belt-and-braces on an injected callback the gate does not own.
  const peerSessionIDs = ctx.activeSessionIDs().filter(
    (id) => !ctx.selfCreated.isSelfCreated(id, NO_PARENT_LOOKUP),
  )
  if (peerSessionIDs.length > 1) {
    ctx.logger("gate:multi-session-advisory", { sessionID: sid, activeSessionCount: peerSessionIDs.length })
    state.needsCriteriaReinject = true // advisory surface on the next transform
  }

  // THE ARBITER (redesign point 2) — first among the content branches: verifier
  // every story that claimed complete since its last audit, applying verdicts
  // (reverting over-claimed stories with named gaps) BEFORE any deterministic
  // nudge is composed, so the rest of the tree sees post-audit plan state.
  if (await handleVerifierAudit(ctx, sid, state)) return

  // STAGE 1 (deterministic completion) — ahead of every other remaining
  // branch, including promise-no-act. See `handleIncompletePlan` for the
  // ordering, cap and scope decisions this encodes.
  if (await handleIncompletePlan(ctx, sid, state)) return

  // v1 ordering: promise-no-act is checked BEFORE the criteria/zero-criteria
  // branches and short-circuits the rest of the tree when it fires.
  if (await handlePromiseNoAct(ctx, sid, state)) return

  // ...and the case promise-no-act cannot see, because it requires changed
  // files: a turn that ended with nothing done. Never judged here — this only
  // arms a timer and always returns false, so the rest of the tree still runs.
  armPauseJudge(ctx, sid, state)

  const criteria = ctx.pinStore.get(sid)
  const activeStory = ctx.storyEngine.getActiveStory(sid)
  // getActiveStory() returns null once the plan's final story is checkpointed
  // "complete" (nothing is "active" anymore) — fall back to the plan's final
  // story so the just-completed plan still resolves to a real phase slot at
  // idle instead of a fresh, untouched "null" slot that can never read
  // "elevate" (CRIT-001 follow-up).
  const storyId = activeStory?.id ?? ctx.storyEngine.getPlan(sid)?.finalStoryId ?? null

  let criteriaAllEvidenced: boolean
  if (criteria.length === 0) {
    await handleZeroCriteriaFallback(ctx, sid, state)
    criteriaAllEvidenced = !ctx.evidenceLedger.hasChangedFiles(sid) || ctx.evidenceLedger.hasVerification(sid)
  } else {
    criteriaAllEvidenced = await handleCriteriaReplay(ctx, sid, state)
  }

  const unverifiedChangesExist = ctx.evidenceLedger.hasChangedFiles(sid) && !ctx.evidenceLedger.hasVerification(sid)
  // The phase engine's close arc no longer gates the verifier — the arbiter
  // above runs on claims directly. `onIdle` still drives the phase machine
  // itself (elevate/close transitions feed the composer).
  ctx.phaseEngine.onIdle(sid, storyId, {
    criteriaAllEvidenced,
    hasPins: criteria.length > 0,
    unverifiedChangesExist,
  })
}
