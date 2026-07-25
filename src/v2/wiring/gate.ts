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
import type { EvidenceLedger } from "../../index.js"
import { classifyFileKind, formatChangedPathsForReason, formatGateContinuationText } from "../../index.js"
import { holdoutSuppresses, logHoldoutSuppress } from "../../measurement.js"
import type { EventLogger, OpencodeClient } from "../types.js"
import type { PhaseEngine } from "../phase.js"
import type { PinStore } from "../pin.js"
import type { StoryEngine } from "../story.js"
import { resolveVerifier } from "../resolve.js"
import { runJudge, buildJudgePayload, type JudgeVerdict } from "../judge.js"
import type { SelfCreatedSessions } from "../subturn.js"
import type { ManifestCache } from "./manifest.js"
import { bindSession } from "./logger.js"
import type { V2SessionState } from "./state.js"

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
  /** Every session id currently gate-active (mirrors v1's `SessionGate.activeSessionIDs()`), for the multi-session advisory rule. */
  activeSessionIDs: () => string[]
  maxCriteriaBlocks: number
  judgeEnabled: boolean
  judgeModelOverride?: { providerID: string; modelID: string }
  isValidReceipt: (sessionID: string, receiptID: string) => boolean
  /** Recent verifier output summaries this session, for the judge payload (best-effort, bounded). */
  recentVerifierSummaries: (sessionID: string) => string[]
  diffSummary: (sessionID: string) => string
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
    console.error("[vertex-v2] session.prompt unavailable; cannot enforce idle gate")
    return
  }
  const state = ctx.states.get(sid)
  if (state) state.idleContinuationInFlight = true
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
    // Waiver-typed evidence is validated at attach-time (tools.ts resolves
    // waiverSourceMessageId against a real chat message before ever calling
    // attachEvidence) — never re-checked here. Receipt-typed evidence is
    // only as good as the receipt still being observable right now: without
    // this, a criterion with a non-null receiptId is trusted forever, even
    // after a process restart drops the underlying VerificationReceiptStore
    // entry (a real evidence-forging/staleness gap) — so re-validate it via
    // the injected isValidReceipt and treat a stale/unknown receipt as
    // unevidenced.
    if ("receiptId" in c.evidence) return !ctx.isValidReceipt(sid, c.evidence.receiptId)
    return false
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

  if (!result.verdict) return
  const verdict: JudgeVerdict = result.verdict
  await promptContinuation(
    ctx,
    sid,
    `[vertex:judge] fit=${verdict.fit} — ${verdict.notes}`,
  )
}

/**
 * Full FR-015 decision tree for `event(session.idle)`. Caller is
 * responsible for the FR-036 self-created-session early return and the
 * in-flight (`idleContinuationInFlight`) guard before calling this.
 */
export async function handleSessionIdle(ctx: GateContext, sid: string): Promise<void> {
  const state = ctx.states.get(sid)
  if (!state || !state.active) return

  const activeSessionIDs = ctx.activeSessionIDs()
  if (activeSessionIDs.length > 1) {
    ctx.logger("gate:multi-session-advisory", { sessionID: sid, activeSessionCount: activeSessionIDs.length })
    state.needsCriteriaReinject = true // best-effort advisory surface on the next transform, never a block
    return
  }

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
