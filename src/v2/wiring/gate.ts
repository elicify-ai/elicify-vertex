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
 * v1's promise-no-act detector is deliberately NOT ported here: it is not
 * named by FR-015, by the module contracts doc's "Reused v1 primitives"
 * list, or by the task brief's session.idle bullet — porting it would be
 * scope creep into a mechanism the spec does not ask this wave to carry
 * forward, so it is left out on purpose (documented, not a silent gap).
 */
import { detectPromiseNoAct, shouldBlockPromiseNoAct } from "../../index.js"
import type { EvidenceLedger } from "../../index.js"
import { classifyFileKind, formatChangedPathsForReason, formatGateContinuationText } from "../../index.js"
import { verifyWaiverSignature } from "../../goals.js"
import { holdoutSuppresses, logHoldoutSuppress } from "../../measurement.js"
import type { InjectionComposer } from "../composer.js"
import type { EventLogger, OpencodeClient } from "../types.js"
import type { PhaseEngine } from "../phase.js"
import type { PinStore } from "../pin.js"
import type { StoryEngine } from "../story.js"
import { resolveVerifier } from "../resolve.js"
import { runJudge, buildJudgePayload, type JudgeVerdict } from "../judge.js"
import type { SelfCreatedSessions } from "../subturn.js"
import type { ManifestCache } from "./manifest.js"
import { incompletePlanFinding } from "./findings.js"
import { bindSession } from "./logger.js"
import { nextInstanceId, type V2SessionState } from "./state.js"

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
  judgeEnabled: boolean
  judgeModelOverride?: { providerID: string; modelID: string }
  isValidReceipt: (sessionID: string, receiptID: string) => boolean
  /** Recent verifier output summaries this session, for the judge payload (best-effort, bounded). */
  recentVerifierSummaries: (sessionID: string) => string[]
  diffSummary: (sessionID: string) => string
  /** `promptContinuation` opens a new composer turn per dispatched
   * continuation — see that function for the rationale and the reverted
   * alternatives. */
  composer: InjectionComposer
  /** FR-060/FR-061: surfaces gate fires and health signals to the operator.
   * Optional so existing callers and tests need no change; when absent the
   * gate simply reports nothing, exactly as before. */
  visibility?: {
    notify(kind: "directive" | "gate" | "health", input: Record<string, unknown> & { message: string }): Promise<void>
  }
}

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
  const state = ctx.states.get(sid)
  if (state) state.idleContinuationInFlight = true

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
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error(CONTINUATION_TIMEOUT_ERROR)), CONTINUATION_TIMEOUT_MS)
    })
    await Promise.race([
      ctx.client.session.prompt({
        path: { id: sid },
        body: { parts: [{ type: "text", text }] },
      } as never),
      timeoutPromise,
    ])
  } catch (err) {
    // Fail-open (v1 invariant): missing/failed prompt never throws into the
    // host — but, mirroring attemptGateContinuation, the failure is always
    // logged (with a reason distinguishing timeout from any other failure)
    // and echoed to stderr before we swallow it.
    const isTimeout = err instanceof Error && err.message === CONTINUATION_TIMEOUT_ERROR
    const reason = isTimeout ? CONTINUATION_TIMEOUT_ERROR : "session.prompt failed"
    ctx.logger("gate:continuation-failed", { sessionID: sid, reason })
    void ctx.visibility?.notify("health", {
      sessionID: sid,
      family: "gate:continuation-failed",
      message: `the idle gate could not dispatch its continuation: ${reason}`,
      variant: "error",
    })
    console.error("[vertex-v2] session.prompt", err)
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle)
    if (state) state.idleContinuationInFlight = false
  }
}

function narrowestPrescription(ctx: GateContext, state: V2SessionState, sid: string, storyVerifiers: readonly string[] | null): string {
  const changedPaths = ctx.evidenceLedger.getChangedPaths(sid).filter((p) => !p.endsWith("-mutation"))
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
 * `appendJudgeCloseOut`, to decide whether the judge was *permitted* to
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
 *  - **Past the cap we stop NUDGING, but the judge still cannot run.** The
 *    early return below is skipped once capped, so the rest of the tree
 *    (zero-criteria fallback, phase close) runs normally — but
 *    `appendJudgeCloseOut` independently requires the plan's final story to
 *    be `complete`, and `StoryEngine.checkpoint` only promotes stories in
 *    order, so "final complete" implies every earlier story completed.
 *    AC-3 therefore holds structurally, not by this function's grace.
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
    activeStory: ctx.storyEngine.getActiveStory(sid),
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
  await promptContinuation(ctx, sid, formatGateContinuationText(reason))
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
  await promptContinuation(ctx, sid, reason)
  return true
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
  await promptContinuation(ctx, sid, formatGateContinuationText(reason))
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
  await promptContinuation(ctx, sid, formatGateContinuationText(reason))
  return false
}

async function appendJudgeCloseOut(ctx: GateContext, sid: string, state: V2SessionState): Promise<void> {
  const plan = ctx.storyEngine.getPlan(sid)
  if (!plan) return
  const finalStory = plan.stories.find((s) => s.id === plan.finalStoryId)
  if (!finalStory || finalStory.status !== "complete") return
  if (!ctx.judgeEnabled) return
  if (!state.modelId) return

  const [providerID, ...rest] = state.modelId.split("/")
  const modelID = rest.join("/")
  if (!providerID || !modelID) return

  const criteria = ctx.pinStore.get(sid).map((c) => c.text)
  const verifierSummaries = ctx.recentVerifierSummaries(sid)
  const diffSummary = ctx.diffSummary(sid)
  const payload = buildJudgePayload({ criteria, diffSummary, verifierSummaries }, bindSession(sid, ctx.logger))

  const result = await runJudge(
    ctx.client,
    { selfCreated: ctx.selfCreated, logger: bindSession(sid, ctx.logger) },
    {
      parentSessionID: sid,
      sessionModel: { providerID, modelID },
      judgeModelOverride: ctx.judgeModelOverride,
      payload,
    },
  )

  if (!result.verdict) {
    // FR-061: a judge that silently does not run is indistinguishable from a
    // judge that passed. Say so.
    void ctx.visibility?.notify("health", {
      sessionID: sid,
      family: "judge:unavailable",
      message: `the completion judge did not run (${result.reason ?? "unknown"}) — no verdict for this plan`,
      variant: "warning",
    })
    return
  }
  const verdict: JudgeVerdict = result.verdict
  await promptContinuation(
    ctx,
    sid,
    `[vertex:judge] fit=${verdict.fit} — ${verdict.notes}`,
  )
}

/**
 * Direct-membership-only parent lookup for the `selfCreated` filter below.
 *
 * `SelfCreatedSessions.isSelfCreated` checks the id itself against the
 * recorded set BEFORE ever calling `resolveParent` (see `subturn.ts`), and
 * the only sessions this harness creates are the judge and intake subturns —
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
 * stop-block continuation, the criteria replay and the judge — whenever
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
 *    disabled promise-no-act, the stop-block and the judge for BOTH
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

  // Degraded-attribution ADVISORY (never a suppression — see doc above).
  //
  // FR-036: a session the harness itself created (judge/intake subturn) is
  // not a peer user session. If one ever reaches this list, it must not make
  // its own parent look multi-session — that would fire a spurious
  // criteria-reinject on every judge close-out, and under the old bail-out
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

  // STAGE 1 (deterministic completion) — ahead of every other branch,
  // including promise-no-act. See `handleIncompletePlan` for the ordering,
  // cap and scope decisions this encodes.
  if (await handleIncompletePlan(ctx, sid, state)) return

  // v1 ordering: promise-no-act is checked BEFORE the criteria/zero-criteria
  // branches and short-circuits the rest of the tree when it fires.
  if (await handlePromiseNoAct(ctx, sid, state)) return

  const criteria = ctx.pinStore.get(sid)
  const activeStory = ctx.storyEngine.getActiveStory(sid)
  // getActiveStory() returns null once the plan's final story is checkpointed
  // "complete" (nothing is "active" anymore) — fall back to the plan's final
  // story so the just-completed plan still resolves to a real phase slot at
  // idle instead of a fresh, untouched "null" slot that can never read
  // "elevate" and therefore can never close/judge (CRIT-001 follow-up).
  const storyId = activeStory?.id ?? ctx.storyEngine.getPlan(sid)?.finalStoryId ?? null

  let criteriaAllEvidenced: boolean
  if (criteria.length === 0) {
    await handleZeroCriteriaFallback(ctx, sid, state)
    criteriaAllEvidenced = !ctx.evidenceLedger.hasChangedFiles(sid) || ctx.evidenceLedger.hasVerification(sid)
  } else {
    criteriaAllEvidenced = await handleCriteriaReplay(ctx, sid, state)
  }

  const unverifiedChangesExist = ctx.evidenceLedger.hasChangedFiles(sid) && !ctx.evidenceLedger.hasVerification(sid)
  const closed = ctx.phaseEngine.onIdle(sid, storyId, {
    criteriaAllEvidenced,
    hasPins: criteria.length > 0,
    unverifiedChangesExist,
  })

  if (closed) {
    await appendJudgeCloseOut(ctx, sid, state)
  }
}
