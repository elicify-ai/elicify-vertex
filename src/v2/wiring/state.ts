/**
 * Wave-3 wiring — per-session runtime state for `src/v2/plugin.ts`.
 *
 * None of the v2 modules (phase.ts, pin.ts, story.ts, composer.ts) own this
 * shape — each of them keys its OWN internal per-session state off the
 * session id passed to their methods. This is the wiring-only bookkeeping
 * the spec explicitly assigns to the integration point rather than any
 * single module: activation, intake-subturn frequency caps (FR-018b), the
 * turn-scoped EXPECT artifact (FR-023), phase-entry/event "pending finding"
 * flags the composer needs re-offered every `system.transform` invocation
 * until rendered (FR-004's per-invocation budget), and the model id resolved
 * for the session.
 */
import type { ExpectArtifact } from "../artifacts.js"

export interface PendingScopeDrift {
  path: string
  offer: "fold" | "amend" | "revert"
  scopeGlobsMatchedZero: boolean
}

export interface PendingAnomaly {
  expectText: string
  observedSummary: string
  failureClass: string | null
}

export interface RenderedVerifyGap {
  instanceId: string
  command: string
  /**
   * MAJ-4: was this prescription tier 1 (a story's own declared verifiers)?
   * Only then is its `&&` chain a list of INDEPENDENT checks that may be
   * credited one at a time. A mixed-ecosystem prescription is also
   * `&&`-joined, but there neither half covers the other by design.
   */
  storyScoped?: boolean
}

export interface V2SessionState {
  /** Mirrors v1's `SessionGate` — true once activated this process, until deactivated. */
  active: boolean
  /** One-time user-visible activation cue (mirrors v1's `activateCueShown`). */
  activateCueShown: boolean
  /**
   * How many stated-intent nudges this turn has already spent.
   *
   * Caps nudges from the PAUSE JUDGE (`pauseJudge.ts`), which replaced the
   * phrase-based branch this counter was introduced for.
   *
   * Deliberately NOT the shared `EvidenceLedger.promiseBlocks` counter. That
   * one lives in the evidence ledger, which `chat.message` replaces wholesale
   * on any message that is not recognised as the continuation's own echo — and
   * whether the echo IS recognised depends on whether `session.prompt` has
   * settled yet, i.e. on host timing. Measured against the real wiring: a cap
   * of 2 let 4 nudges through. Session state is not reset by that path, so the
   * bound here is deterministic; `resetTurnState` clears it on a real user
   * message, which is the turn boundary that should restore the budget.
   */
  statedIntentNudges: number
  /** In-flight guard: a `client.session.prompt` idle-gate continuation is pending for this session. */
  idleContinuationInFlight: boolean
  /**
   * M4: the text of the continuation currently in flight, so `chat.message`
   * can tell OUR OWN echo (which must not reset the turn) from a real user
   * message (which must, and which is the turn boundary that releases the
   * guard). `null` whenever nothing is in flight.
   */
  lastContinuationText: string | null
  /**
   * C2: the settled-but-never-audited escalation has already been dispatched
   * for this plan. It fires from `handleVerifierAudit`'s early return, which runs
   * on every subsequent idle, so without this it would repeat forever.
   * Reset by `resetTurnState` (MAJ-4): it was previously initialised only in
   * `freshSessionState`, so a SECOND unaudited plan in the same session found
   * the flag already spent and ended in total silence. The doc here used to
   * claim a new plan reset it; nothing did.
   */
  /**
   * Which unresolved story set has already been escalated, as a stable
   * signature.
   *
   * FIX 2 — THE DEAD END. This was a boolean cleared by `resetTurnState`, and
   * every continuation begins a turn, so the escalation re-fired forever
   * against a state nothing could move: a story stamped
   * `complete / unapplied:"unverified"` cannot become verified (its verdict was
   * already discarded) and cannot be closed. Measured live: four escalations
   * for the same five stories, alternating with plan-incomplete.
   *
   * Keyed by the set now, and deliberately NOT reset per turn — only a change
   * in that set (a re-audit, a new plan) is grounds to speak again.
   */
  unauditedEscalatedFor: string | null
  /** True between `experimental.session.compacting` and the matching `session.compacted`. */
  compacting: boolean

  /** Resolved workspace root for `.elicify-vertex/` state (worktree -> directory -> cwd -> $HOME). */
  workspaceRoot: string

  /** Model id last observed (`providerID/modelID`), preferring `system.transform`'s required field over `chat.message`'s optional one. */
  modelId: string | null

  // -- Intake classification frequency caps (FR-018b) — session-lifetime state
  //    `classifyMultiStory` itself does not self-throttle, per its own module
  //    contract; these two counters are what wiring owns instead.
  classifiedThisTask: boolean
  intakeSubturnCount: number
  /** Set once a subturn (or its heuristic fallback) has flagged this task multi-story; cleared once a plan is created. */
  multiStoryPending: boolean

  // -- EXPECT artifact (FR-023) — expires at turn end.
  turnExpect: ExpectArtifact | null
  expectAbsentLoggedThisTurn: boolean
  /**
   * B-2 follow-up: `criteria:parse-miss` has already been logged this turn.
   *
   * Exactly `expectAbsentLoggedThisTurn`'s job, for exactly its reason —
   * `text.complete` fires once per assistant TEXT PART, and the unreadable
   * `CRITERIA:` line that produces the event is typically repeated in every
   * part of the same reply (measured: 12 parts -> 12 events). The sibling had
   * this guard from the start; this one was written without it.
   */
  criteriaParseMissLoggedThisTurn: boolean

  // NO `intakeScaffoldOfferedForTurn`. B-2 added it (a composer turn index
  // stamped when the scaffold was OFFERED) and it could suppress the scaffold
  // for a whole turn: the finding is `phase-guidance`, so an invocation whose
  // 2-slot budget went to corrections dropped it AFTER the flag was spent, and
  // no later step re-offered it. Wiring has no business tracking "did this
  // render" at all — `InjectionComposer.blockedBeforeBudget` reads the
  // composer's own per-turn spend, which moves on a render and on nothing
  // else, and is correct on the `wiring/gate.ts` continuation path (which
  // advances the composer's turn and never touches this struct) for the same
  // reason B-2's turn index was.

  // -- Phase-entry / one-shot-per-turn pending findings (re-offered every
  //    `system.transform` invocation of the turn until the composer actually
  //    renders them, then cleared; also cleared at the next `chat.message`).
  precommitmentPending: boolean
  scopeDriftPending: PendingScopeDrift | null
  anomalyPending: PendingAnomaly | null
  elevatePending: boolean
  /** Set once after `session.compacted`; cleared once actually rendered (FR-014: exactly once). */
  needsCriteriaReinject: boolean

  // -- FR-034 compliance join: verify-gap prescriptions rendered THIS turn,
  //    checked against observed verifier commands in `tool.execute.after`.
  renderedVerifyGaps: RenderedVerifyGap[]
  // BACKLOG B-1: `compliedFamiliesEver`, `everVerifiedThisTurn` and
  // `turnIntroducedNewTestFile` lived here, and existed ONLY as inputs to the
  // FR-029 dose matrix (`wiring/dosing.ts` was their sole reader). With
  // model-conditioned dosing deleted nothing reads them, so they are gone
  // rather than left write-only: unread state that nothing can observe reads
  // as a capability the harness does not have. The compliance record that
  // survives is `composer.recordCompliance` -> the `directive_complied`
  // event, which is what FR-034's compliance join actually uses.
  /** Single-slot pending repeat-failure finding (mirrors v1's per-signature-once-per-turn cooldown via `EvidenceLedger.markRepeatFired`). */
  repeatFailurePending: { signature: string; count: number } | null

  // -- Criteria idle-gate replay caps (FR-015, "criteria pinned" branch) —
  //    v2's own counter, independent of v1's `EvidenceLedger` stop/promise
  //    block counters (which back the zero-criteria fallback instead).
  criteriaBlocks: number

  // -- Stall detection (HANDOVER.md redesign point 9, adopted from
  //    opencode-goal-plugin's no-progress accounting). `activityMarker` is
  //    monotonic for the session's lifetime and bumped by wiring on every
  //    real unit of agent work (any tool call); the other three are compared
  //    against it at each idle that wants to dispatch a continuation — see
  //    `wiring/watchdog.ts`'s `evaluateStall`.
  activityMarker: number
  /** `activityMarker` as it stood when the last continuation was dispatched. */
  markerAtLastContinuation: number
  /** Consecutive continuation-dispatched idles that produced no activity. */
  consecutiveNoProgress: number
  /** Cap reached: the gate goes silent until the next real user message. */
  stallPaused: boolean

  /** FR-007: consecutive verifier reverts per story id. Process-local by
   * design — persisting it would mean a `StoryV2` schema change, and the cap
   * is a courtesy bound (stop the loop) rather than a safety control. Reset
   * by `resetTurnState` when a real user message re-engages. */
  storyReaudits: Record<string, number>

  /** Last completed assistant text (mirrors v1's `lastAssistantText`, used nowhere safety-critical in v2 wiring today but kept for parity / future use). */
  lastAssistantText: string | null

  /** Monotonic per-session instance-id counter for `Finding.instanceId`. */
  instanceCounter: number
}

export function freshSessionState(workspaceRoot: string): V2SessionState {
  return {
    active: false,
    activateCueShown: false,
    statedIntentNudges: 0,
    idleContinuationInFlight: false,
    lastContinuationText: null,
    unauditedEscalatedFor: null,
    compacting: false,
    workspaceRoot,
    modelId: null,
    classifiedThisTask: false,
    intakeSubturnCount: 0,
    multiStoryPending: false,
    turnExpect: null,
    expectAbsentLoggedThisTurn: false,
    criteriaParseMissLoggedThisTurn: false,
    precommitmentPending: false,
    scopeDriftPending: null,
    anomalyPending: null,
    elevatePending: false,
    needsCriteriaReinject: false,
    renderedVerifyGaps: [],
    repeatFailurePending: null,
    criteriaBlocks: 0,
    activityMarker: 0,
    markerAtLastContinuation: -1,
    consecutiveNoProgress: 0,
    stallPaused: false,
    storyReaudits: {},
    lastAssistantText: null,
    instanceCounter: 0,
  }
}

/** Reset the per-TURN slice of state (called from `chat.message`, mirroring
 * v1's `EvidenceLedger.reset` / `PhaseEngine.onUserMessage` cadence). Session-
 * lifetime fields (activation, workspace root, intake caps, resolved model id,
 * `multiStoryPending`) are intentionally left untouched. */
export function resetTurnState(state: V2SessionState): void {
  state.turnExpect = null
  state.expectAbsentLoggedThisTurn = false
  state.criteriaParseMissLoggedThisTurn = false
  state.precommitmentPending = false
  state.scopeDriftPending = null
  state.anomalyPending = null
  state.elevatePending = false
  state.renderedVerifyGaps = []
  state.repeatFailurePending = null
  // Stall detection (redesign point 9): a real user message is the
  // un-pause signal — the gate went silent because continuations produced
  // no activity, and the user speaking again is exactly the event that
  // should re-arm it. `activityMarker` itself is monotonic and deliberately
  // NOT reset (it is compared by value, not by age).
  // CRIT-002 (code review): the ONLY unconditional release of the in-flight
  // guard. `promptContinuation` deliberately holds it across a timeout (the
  // turn is still streaming), so without this a prompt that never settles —
  // or a synchronous throw — would leave the harness inert for the rest of
  // the session: `plugin.ts`'s `chat.message` returns early while it is set.
  // A real user message is the turn boundary that genuinely ends any
  // outstanding continuation.
  state.statedIntentNudges = 0
  state.idleContinuationInFlight = false
  state.lastContinuationText = null
  // MAJ-3: a real user message ends the turn that text belonged to. It was
  // cleared only by `tool.execute.after`, and `text.complete` skips
  // whitespace-only output — so on a turn with neither, LAST turn's
  // "I'll add the tests next" survived into a freshly-refilled budget and
  // could be nudged all over again. `handlePromiseNoAct` is shielded from
  // this by its changed-files requirement; the stated-intent branch is not,
  // and a no-work turn is exactly where stale text survives.
  state.lastAssistantText = null
  // MAJ-4: the once-only settled-but-unaudited escalation is per PLAN, not
  // per session. It was only ever initialised in `freshSessionState`, so a
  // second unaudited plan in the same session found it already spent and the
  // run ended in silence. A real user message is the right boundary: it is
  // what precedes a new plan.
  state.markerAtLastContinuation = -1
  state.consecutiveNoProgress = 0
  state.stallPaused = false
  state.storyReaudits = {}
  // Per-turn criteria idle-gate replay cap (FR-015 "criteria pinned" branch)
  // — v1 parity: EvidenceLedger.reset() zeroes stopBlocks on every
  // chat.message, so its cap is 3 blocks PER TURN, not 3 ever. Without this
  // reset, criteriaBlocks was session-lifetime: a long session would
  // permanently stop enforcing unevidenced criteria after only 3 blocks in
  // its entire history instead of 3 per turn — safety-critical, not cosmetic.
  state.criteriaBlocks = 0
  // needsCriteriaReinject deliberately NOT reset here — it must survive
  // until actually rendered (FR-014), and a compaction's synthetic
  // auto-continue message is itself a chat.message-shaped event in some
  // hosts; clearing it here would risk losing the one-shot re-injection.
}

export function nextInstanceId(state: V2SessionState): string {
  state.instanceCounter += 1
  return `D-${state.instanceCounter}`
}

/**
 * FR-036 self-created-session guard, built on `subturn.ts`'s
 * `SelfCreatedSessions`. That class needs a synchronous `resolveParent`
 * lookup to walk beyond a single hop (module contract: "resolveParent lets
 * the caller supply a lookup ... without this class owning client access").
 * Since the OpenCode client's parent-lookup is async and hook dispatch is
 * not, wiring cannot query the host synchronously for an ARBITRARY session's
 * parent — but it doesn't need to for the common case: `isSelfCreated`
 * checks `sessionID` itself against the recorded id set FIRST, before ever
 * calling `resolveParent` (see `subturn.ts`), so every session this harness
 * itself created (the only case that actually occurs in this codebase — the
 * verifier/intake subturns never nest a grandchild) is caught with zero calls
 * to `resolveParent`. `resolveParent` is still wired to a real (synchronous,
 * in-memory) child->parent map populated at the moment wiring records a
 * subturn, so the defensive grandchild case in FR-036's text is honoured
 * for any future host behaviour without requiring an async client call
 * inside a hook.
 */
export class SelfCreatedGuard {
  private readonly childToParent = new Map<string, string | null>()

  record(sessionID: string, parentID: string | null): void {
    this.childToParent.set(sessionID, parentID)
  }

  resolveParent = (sessionID: string): string | null => {
    return this.childToParent.get(sessionID) ?? null
  }
}
