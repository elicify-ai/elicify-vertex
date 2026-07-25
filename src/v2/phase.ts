/**
 * elicify-vertex v2 — phase engine (FR-001, FR-002)
 * --------------------------------------------------------------------------
 * Tracks each session (and, when a plan is active, each of its stories)
 * through the four reachable phases `intake -> execute -> elevate -> close`
 * per the exact nine-arc transition table in docs/vertex2-spec.md (FR-001).
 *
 * Scoping (FR-001 "Scoping" / review MAJ-004): when a plan is active, phase
 * is tracked per active story; the session-level phase (`getPhase(sessionID)`
 * with no `storyId`) reads as whichever story was most recently touched by
 * `onMutation`/`onVerifierOutcome`, or rebound by `onStoryAdvance`. With no
 * plan active, callers pass `storyId: null` throughout and the session has a
 * single phase.
 *
 * This module takes an injected `EventLogger` (never imports measurement.ts
 * directly) per the shared logging convention in
 * docs/vertex2-module-contracts.md so it stays testable without a real event
 * sink. Every logged transition also emits a `"phase_transition"` event via
 * the injected logger with the same fields as the recorded
 * `PhaseTransitionEvent`.
 */

/** Shared logging convention (docs/vertex2-module-contracts.md): every v2
 * module takes an injected logger rather than importing measurement.ts. */
export type EventLogger = (eventType: string, payload: Record<string, unknown>) => void

export type Phase = "intake" | "execute" | "elevate" | "close"

export interface PhaseTransitionEvent {
  sessionID: string
  storyId: string | null
  from: Phase
  to: Phase
  trigger: string // e.g. "T1", "T3", "T7" — matches the FR-001 transition table row id
  ts: string // ISO-8601
}

/** Sentinel key for "no active story" (no plan). `Map` supports `null` keys
 * natively, so we key the per-session phase map by `string | null` directly
 * rather than a magic string sentinel. */
type StoryKey = string | null

interface SessionRecord {
  /** Per-(story|no-plan) phase. Keys are only created once a story/no-plan
   * slot is actually touched by onMutation/onVerifierOutcome/onStoryAdvance
   * — an untouched key implicitly reads as "intake" (see getPhaseForKey). */
  phases: Map<StoryKey, Phase>
  /** The story (or null for "no plan") most recently touched by
   * onMutation/onVerifierOutcome, or rebound by onStoryAdvance. Used to
   * resolve getPhase(sessionID) with no storyId argument ("the active
   * story's phase" per FR-001's scoping paragraph). */
  activeStoryId: string | null
}

export class PhaseEngine {
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly transitionLogs = new Map<string, PhaseTransitionEvent[]>()

  constructor(private readonly logger: EventLogger) {}

  /** T1: session activated + first user message. */
  activate(sessionID: string): void {
    const session = this.getOrCreate(sessionID)
    const prev = this.getPhaseForKey(session, null)
    this.logTransition(sessionID, null, prev, "intake", "T1")
  }

  /**
   * T2/T9: new user message. Resets phase to intake for every
   * story/no-plan slot under this session that isn't already intake. Does
   * NOT touch pins — that's pin.ts's job, called separately by wiring.
   * Safe to call on an unknown/uninitialized session id: it is lazily
   * created (with no tracked slots), so the loop below is a no-op and the
   * call never throws.
   */
  onUserMessage(sessionID: string): void {
    const session = this.getOrCreate(sessionID)
    for (const [key, prev] of session.phases) {
      if (prev === "intake") continue
      const trigger = prev === "close" ? "T9" : "T2"
      session.phases.set(key, "intake")
      this.logTransition(sessionID, key, prev, "intake", trigger)
    }
  }

  /** T3 (intake->execute) and T6 (elevate->execute). storyId null when no active plan. */
  onMutation(sessionID: string, storyId: string | null): void {
    const session = this.getOrCreate(sessionID)
    const prev = this.getPhaseForKey(session, storyId)
    session.activeStoryId = storyId

    if (prev === "intake") {
      session.phases.set(storyId, "execute")
      this.logTransition(sessionID, storyId, "intake", "execute", "T3")
    } else if (prev === "elevate") {
      session.phases.set(storyId, "execute")
      this.logTransition(sessionID, storyId, "elevate", "execute", "T6")
    }
    // prev is "execute" or "close": no table arc for a mutation from those
    // sources — no-op, no transition recorded.
  }

  /** T4/T5. coversFinalStory: true when no plan is active OR the passing verifier covers the plan's final story. */
  onVerifierOutcome(
    sessionID: string,
    storyId: string | null,
    opts: { success: boolean; coversFinalStory: boolean },
  ): void {
    const session = this.getOrCreate(sessionID)
    const prev = this.getPhaseForKey(session, storyId)
    session.activeStoryId = storyId

    if (prev !== "execute") return // T4/T5 both require source "execute" — no-op otherwise.

    if (opts.success && opts.coversFinalStory) {
      session.phases.set(storyId, "elevate")
      this.logTransition(sessionID, storyId, "execute", "elevate", "T4")
    } else if (!opts.success) {
      // T5: no transition, but the outcome is recorded.
      this.logTransition(sessionID, storyId, "execute", "execute", "T5")
    }
    // success && !coversFinalStory (an intermediate story's verifier goes
    // green): not T4 (final story not covered) and not T5 (it didn't fail)
    // — no arc in the table, so no-op/no log; phase stays "execute".
  }

  /** T8: non-final story checkpoints complete; rebinds phase to execute for the next story. */
  onStoryAdvance(sessionID: string, fromStoryId: string, toStoryId: string): void {
    const session = this.getOrCreate(sessionID)
    void fromStoryId // identifies the completing story; the arc's source phase for the LOGGED event is the *target* story's (toStoryId) own real prior phase, read below — not fromStoryId's, and not hardcoded.
    // Read toStoryId's actual current phase BEFORE overwriting it. Table row:
    // "T8 | execute | non-final story checkpoints complete | execute (rebound
    // to the next story)" describes the common case where the target story is
    // still at its default "intake" (or was already "execute"), but the
    // logged `from` must reflect whatever the target story's real state was —
    // e.g. "elevate" if toStoryId had itself already reached elevate before
    // being rebound here.
    const prevForTarget = this.getPhaseForKey(session, toStoryId)
    session.phases.set(toStoryId, "execute")
    session.activeStoryId = toStoryId
    // Per the BDD scenario ("Active plan scopes the phase to the active
    // story"), the arc is recorded against the *next* story (toStoryId).
    this.logTransition(sessionID, toStoryId, prevForTarget, "execute", "T8")
  }

  /** T7. Returns true iff the session transitioned to close. */
  onIdle(
    sessionID: string,
    storyId: string | null,
    opts: { criteriaAllEvidenced: boolean; hasPins: boolean; unverifiedChangesExist: boolean },
  ): boolean {
    const session = this.getOrCreate(sessionID)
    const prev = this.getPhaseForKey(session, storyId)
    if (prev !== "elevate") return false

    const shouldClose = opts.hasPins ? opts.criteriaAllEvidenced : !opts.unverifiedChangesExist
    if (!shouldClose) return false

    session.phases.set(storyId, "close")
    this.logTransition(sessionID, storyId, "elevate", "close", "T7")
    return true
  }

  getPhase(sessionID: string, storyId?: string | null): Phase {
    const session = this.sessions.get(sessionID)
    if (!session) return "intake"
    if (storyId !== undefined) return this.getPhaseForKey(session, storyId)
    return this.getPhaseForKey(session, session.activeStoryId)
  }

  getTransitionLog(sessionID: string): readonly PhaseTransitionEvent[] {
    return [...(this.transitionLogs.get(sessionID) ?? [])]
  }

  reset(sessionID: string): void {
    this.sessions.delete(sessionID)
    this.transitionLogs.delete(sessionID)
  }

  // --- internals ---

  private getOrCreate(sessionID: string): SessionRecord {
    let session = this.sessions.get(sessionID)
    if (!session) {
      session = { phases: new Map(), activeStoryId: null }
      this.sessions.set(sessionID, session)
    }
    return session
  }

  private getPhaseForKey(session: SessionRecord, key: StoryKey): Phase {
    return session.phases.get(key) ?? "intake"
  }

  private logTransition(sessionID: string, storyId: string | null, from: Phase, to: Phase, trigger: string): void {
    const ts = new Date().toISOString()
    const event: PhaseTransitionEvent = { sessionID, storyId, from, to, trigger, ts }
    const arr = this.transitionLogs.get(sessionID)
    if (arr) arr.push(event)
    else this.transitionLogs.set(sessionID, [event])
    this.logger("phase_transition", { sessionID, storyId, from, to, trigger, ts })
  }
}
