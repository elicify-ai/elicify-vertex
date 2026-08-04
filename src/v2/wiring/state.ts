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
 * until rendered (FR-004's per-invocation budget), and the dosing profile
 * resolved for the session (FR-028).
 */
import type { DosingProfile } from "../../measurement.js"
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
  unauditedEscalated: boolean
  /** True between `experimental.session.compacting` and the matching `session.compacted`. */
  compacting: boolean

  /** Resolved workspace root for `.elicify-vertex/` state (worktree -> directory -> cwd -> $HOME). */
  workspaceRoot: string

  /** Model id last observed (`providerID/modelID`), preferring `system.transform`'s required field over `chat.message`'s optional one. */
  modelId: string | null
  profile: DosingProfile

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
  /** Families with >=1 recorded compliance ever this session (FR-029 "frontier" nudge-after-compliance dose). */
  compliedFamiliesEver: Set<string>
  /** True once a verification has succeeded THIS turn (FR-029 "frontier" verification-prescription relevance-gap approximation). */
  everVerifiedThisTurn: boolean
  /** True once a changed path this turn looks like a test file (FR-029 "standard" falsification on-new-tests-only approximation). */
  turnIntroducedNewTestFile: boolean
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
    idleContinuationInFlight: false,
    lastContinuationText: null,
    unauditedEscalated: false,
    compacting: false,
    workspaceRoot,
    modelId: null,
    profile: "standard",
    classifiedThisTask: false,
    intakeSubturnCount: 0,
    multiStoryPending: false,
    turnExpect: null,
    expectAbsentLoggedThisTurn: false,
    precommitmentPending: false,
    scopeDriftPending: null,
    anomalyPending: null,
    elevatePending: false,
    needsCriteriaReinject: false,
    renderedVerifyGaps: [],
    compliedFamiliesEver: new Set(),
    everVerifiedThisTurn: false,
    turnIntroducedNewTestFile: false,
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
 * lifetime fields (activation, workspace root, intake caps, dosing profile,
 * `multiStoryPending`) are intentionally left untouched. */
export function resetTurnState(state: V2SessionState): void {
  state.turnExpect = null
  state.expectAbsentLoggedThisTurn = false
  state.precommitmentPending = false
  state.scopeDriftPending = null
  state.anomalyPending = null
  state.elevatePending = false
  state.renderedVerifyGaps = []
  state.everVerifiedThisTurn = false
  state.turnIntroducedNewTestFile = false
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
  state.idleContinuationInFlight = false
  state.lastContinuationText = null
  // MAJ-4: the once-only settled-but-unaudited escalation is per PLAN, not
  // per session. It was only ever initialised in `freshSessionState`, so a
  // second unaudited plan in the same session found it already spent and the
  // run ended in silence. A real user message is the right boundary: it is
  // what precedes a new plan.
  state.unauditedEscalated = false
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
