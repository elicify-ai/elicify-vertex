import { describe, expect, it, vi } from "vitest"

import { PhaseEngine, type EventLogger, type PhaseTransitionEvent } from "../../src/v2/phase.js"

// ---------------------------------------------------------------------------
// Tests 1, 2, 3 and the phase-scoping slice of 49 (docs/vertex2-spec.md
// Test Implementation Order table):
//   1  phase_transitions_on_mutation  — every arc of the FR-001 9-arc table,
//      incl. timestamps and the elevate -> close arc
//   2  phase_verify_pass_fail_paths   — pass -> elevate, fail -> execute,
//      mutation -> execute
//   3  phase_reset_keeps_pins         — new user message resets phase
//      (pins themselves are pin.ts's job — not exercised here)
//   49 (phase-only slice) phase_and_elevate_per_story — two stories under one
//      session have independent phases; onStoryAdvance rebinds phase for the
//      next story without touching unrelated sessions
// ---------------------------------------------------------------------------

const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

function makeEngine() {
  const logger: EventLogger = vi.fn()
  const engine = new PhaseEngine(logger)
  return { engine, logger: logger as unknown as ReturnType<typeof vi.fn> }
}

function lastEvent(engine: PhaseEngine, sessionID: string): PhaseTransitionEvent {
  const log = engine.getTransitionLog(sessionID)
  const evt = log[log.length - 1]
  if (!evt) throw new Error(`no transition logged for ${sessionID}`)
  return evt
}

describe("PhaseEngine — FR-001 nine-arc transition table (test 1: phase_transitions_on_mutation)", () => {
  it("T1: activate() transitions (none) -> intake and records a timestamped event", () => {
    const { engine, logger } = makeEngine()
    engine.activate("s1")

    expect(engine.getPhase("s1")).toBe("intake")
    const evt = lastEvent(engine, "s1")
    expect(evt).toMatchObject({ sessionID: "s1", storyId: null, from: "intake", to: "intake", trigger: "T1" })
    expect(evt.ts).toMatch(ISO_8601)
    expect(logger).toHaveBeenCalledWith("phase_transition", expect.objectContaining({ trigger: "T1", to: "intake" }))
  })

  it("T3: intake -> execute on first mutating tool call", () => {
    const { engine } = makeEngine()
    engine.activate("s1")
    engine.onMutation("s1", null)

    expect(engine.getPhase("s1")).toBe("execute")
    const evt = lastEvent(engine, "s1")
    expect(evt).toMatchObject({ sessionID: "s1", storyId: null, from: "intake", to: "execute", trigger: "T3" })
    expect(evt.ts).toMatch(ISO_8601)
  })

  it("T4: execute -> elevate when a bound verifier passes and covers the final story (or no plan active)", () => {
    const { engine } = makeEngine()
    engine.activate("s1")
    engine.onMutation("s1", null)
    engine.onVerifierOutcome("s1", null, { success: true, coversFinalStory: true })

    expect(engine.getPhase("s1")).toBe("elevate")
    const evt = lastEvent(engine, "s1")
    expect(evt).toMatchObject({ from: "execute", to: "elevate", trigger: "T4" })
  })

  it("T5: verifier failing records execute -> execute (no transition, but recorded)", () => {
    const { engine } = makeEngine()
    engine.activate("s1")
    engine.onMutation("s1", null)
    engine.onVerifierOutcome("s1", null, { success: false, coversFinalStory: false })

    expect(engine.getPhase("s1")).toBe("execute") // unchanged
    const evt = lastEvent(engine, "s1")
    expect(evt).toMatchObject({ from: "execute", to: "execute", trigger: "T5" })
  })

  it("T6: elevate -> execute on a new mutating tool call", () => {
    const { engine } = makeEngine()
    engine.activate("s1")
    engine.onMutation("s1", null)
    engine.onVerifierOutcome("s1", null, { success: true, coversFinalStory: true })
    expect(engine.getPhase("s1")).toBe("elevate")

    engine.onMutation("s1", null)
    expect(engine.getPhase("s1")).toBe("execute")
    const evt = lastEvent(engine, "s1")
    expect(evt).toMatchObject({ from: "elevate", to: "execute", trigger: "T6" })
  })

  it("T7: elevate -> close on session.idle with every pinned criterion evidenced", () => {
    const { engine } = makeEngine()
    engine.activate("s1")
    engine.onMutation("s1", null)
    engine.onVerifierOutcome("s1", null, { success: true, coversFinalStory: true })

    const closed = engine.onIdle("s1", null, {
      criteriaAllEvidenced: true,
      hasPins: true,
      unverifiedChangesExist: false,
    })

    expect(closed).toBe(true)
    expect(engine.getPhase("s1")).toBe("close")
    const evt = lastEvent(engine, "s1")
    expect(evt).toMatchObject({ from: "elevate", to: "close", trigger: "T7" })
    expect(evt.ts).toMatch(ISO_8601)
  })

  it("T7 zero-pins fallback: elevate -> close when there are no unverified changes", () => {
    const { engine } = makeEngine()
    engine.activate("s1")
    engine.onMutation("s1", null)
    engine.onVerifierOutcome("s1", null, { success: true, coversFinalStory: true })

    const closed = engine.onIdle("s1", null, {
      criteriaAllEvidenced: false,
      hasPins: false,
      unverifiedChangesExist: false,
    })

    expect(closed).toBe(true)
    expect(engine.getPhase("s1")).toBe("close")
  })

  it("T7 does not fire when criteria are unmet (stays elevate, returns false)", () => {
    const { engine } = makeEngine()
    engine.activate("s1")
    engine.onMutation("s1", null)
    engine.onVerifierOutcome("s1", null, { success: true, coversFinalStory: true })

    const closed = engine.onIdle("s1", null, {
      criteriaAllEvidenced: false,
      hasPins: true,
      unverifiedChangesExist: false,
    })

    expect(closed).toBe(false)
    expect(engine.getPhase("s1")).toBe("elevate")
  })

  it("T8: non-final story checkpoint rebinds phase to execute for the next story, recorded against it — `from` reflects the target story's REAL prior phase (freshly-created story-2 defaults to intake, not a hardcoded 'execute')", () => {
    const { engine } = makeEngine()
    engine.activate("s1")
    engine.onMutation("s1", "story-1") // T3 for story-1

    engine.onStoryAdvance("s1", "story-1", "story-2")

    expect(engine.getPhase("s1", "story-2")).toBe("execute")
    expect(engine.getPhase("s1")).toBe("execute") // session-level reads as active story's phase
    const evt = lastEvent(engine, "s1")
    // story-2 was never touched before this call, so its real prior phase is
    // the default "intake" — NOT the previously-hardcoded "execute".
    expect(evt).toMatchObject({ sessionID: "s1", storyId: "story-2", from: "intake", to: "execute", trigger: "T8" })
  })

  it("T8 logs the target story's REAL prior phase as `from`, proving it reads live state rather than a hardcoded constant (target story-2 already reached elevate)", () => {
    const { engine } = makeEngine()
    engine.activate("s1")
    // Independently advance story-2 all the way to "elevate" before it is
    // ever the *target* of an onStoryAdvance rebind.
    engine.onMutation("s1", "story-2")
    engine.onVerifierOutcome("s1", "story-2", { success: true, coversFinalStory: true })
    expect(engine.getPhase("s1", "story-2")).toBe("elevate")

    // story-1 checkpoints complete, advancing into story-2 — whose real prior
    // phase is "elevate", neither "execute" (the old hardcoded value) nor
    // "intake" (the freshly-created default from the sibling test above).
    engine.onStoryAdvance("s1", "story-1", "story-2")

    expect(engine.getPhase("s1", "story-2")).toBe("execute") // rebound to execute regardless
    const evt = lastEvent(engine, "s1")
    expect(evt).toMatchObject({ sessionID: "s1", storyId: "story-2", from: "elevate", to: "execute", trigger: "T8" })
  })

  it("T9: new user message from close resets to intake (labelled distinctly from plain T2)", () => {
    const { engine } = makeEngine()
    engine.activate("s1")
    engine.onMutation("s1", null)
    engine.onVerifierOutcome("s1", null, { success: true, coversFinalStory: true })
    engine.onIdle("s1", null, { criteriaAllEvidenced: true, hasPins: true, unverifiedChangesExist: false })
    expect(engine.getPhase("s1")).toBe("close")

    engine.onUserMessage("s1")

    expect(engine.getPhase("s1")).toBe("intake")
    const evt = lastEvent(engine, "s1")
    expect(evt).toMatchObject({ from: "close", to: "intake", trigger: "T9" })
  })

  it("T2: new user message from any non-close phase resets to intake", () => {
    const { engine } = makeEngine()
    engine.activate("s1")
    engine.onMutation("s1", null) // now execute

    engine.onUserMessage("s1")

    expect(engine.getPhase("s1")).toBe("intake")
    const evt = lastEvent(engine, "s1")
    expect(evt).toMatchObject({ from: "execute", to: "intake", trigger: "T2" })
  })

  it("walks every arc T1-T9 in one session and asserts the full recorded sequence with timestamps", () => {
    const { engine } = makeEngine()

    engine.activate("s1") // T1
    engine.onMutation("s1", null) // T3
    engine.onVerifierOutcome("s1", null, { success: false, coversFinalStory: false }) // T5
    engine.onVerifierOutcome("s1", null, { success: true, coversFinalStory: true }) // T4
    engine.onMutation("s1", null) // T6
    engine.onVerifierOutcome("s1", null, { success: true, coversFinalStory: true }) // T4 again
    engine.onIdle("s1", null, { criteriaAllEvidenced: true, hasPins: true, unverifiedChangesExist: false }) // T7
    engine.onUserMessage("s1") // T9 (from close)

    const log = engine.getTransitionLog("s1")
    expect(log.map((e) => e.trigger)).toEqual(["T1", "T3", "T5", "T4", "T6", "T4", "T7", "T9"])
    for (const evt of log) expect(evt.ts).toMatch(ISO_8601)

    // A separate session drives T8 (needs a multi-story plan) and T2 (from a
    // non-close phase) — covered in dedicated tests above so every one of the
    // nine table rows (T1-T9) is exercised somewhere in this file.
  })
})

describe("PhaseEngine — pass/fail verifier paths (test 2: phase_verify_pass_fail_paths)", () => {
  it("pass -> elevate only when coversFinalStory is true", () => {
    const { engine } = makeEngine()
    engine.activate("s1")
    engine.onMutation("s1", null)

    engine.onVerifierOutcome("s1", null, { success: true, coversFinalStory: false })

    // Intermediate-story green: not T4 (final story not covered) and not T5
    // (it didn't fail) — no arc applies, phase stays execute, nothing logged.
    expect(engine.getPhase("s1")).toBe("execute")
    const log = engine.getTransitionLog("s1")
    expect(log[log.length - 1]?.trigger).not.toBe("T4")
    expect(log.some((e) => e.to === "elevate")).toBe(false)
  })

  it("pass with coversFinalStory: true elevates", () => {
    const { engine } = makeEngine()
    engine.activate("s1")
    engine.onMutation("s1", null)

    engine.onVerifierOutcome("s1", null, { success: true, coversFinalStory: true })

    expect(engine.getPhase("s1")).toBe("elevate")
  })

  it("fail always stays execute regardless of coversFinalStory", () => {
    const { engine } = makeEngine()
    engine.activate("s1")
    engine.onMutation("s1", null)

    engine.onVerifierOutcome("s1", null, { success: false, coversFinalStory: true })

    expect(engine.getPhase("s1")).toBe("execute")
  })

  it("mutation after a fail-recorded execute stays execute (no-op, not a table arc)", () => {
    const { engine } = makeEngine()
    engine.activate("s1")
    engine.onMutation("s1", null)
    engine.onVerifierOutcome("s1", null, { success: false, coversFinalStory: false })

    engine.onMutation("s1", null) // still "execute" as source -> no arc, no-op

    expect(engine.getPhase("s1")).toBe("execute")
    const log = engine.getTransitionLog("s1")
    expect(log).toHaveLength(3) // T1, T3, T5 — the trailing no-op mutation adds nothing
    expect(log.map((e) => e.trigger)).toEqual(["T1", "T3", "T5"])
  })

  it("verifier outcome while in intake (no prior mutation) is a no-op — T4/T5 require source execute", () => {
    const { engine } = makeEngine()
    engine.activate("s1")

    engine.onVerifierOutcome("s1", null, { success: true, coversFinalStory: true })
    expect(engine.getPhase("s1")).toBe("intake")

    engine.onVerifierOutcome("s1", null, { success: false, coversFinalStory: false })
    expect(engine.getPhase("s1")).toBe("intake")

    const log = engine.getTransitionLog("s1")
    expect(log).toHaveLength(1) // only T1 — neither verifier call produced an arc
  })
})

describe("PhaseEngine — reset semantics (test 3: phase_reset_keeps_pins)", () => {
  it("onUserMessage resets an elevate phase to intake (pins themselves are pin.ts's job, not exercised here)", () => {
    const { engine } = makeEngine()
    engine.activate("s1")
    engine.onMutation("s1", null)
    engine.onVerifierOutcome("s1", null, { success: true, coversFinalStory: true })
    expect(engine.getPhase("s1")).toBe("elevate")

    engine.onUserMessage("s1")

    expect(engine.getPhase("s1")).toBe("intake")
  })

  it("onUserMessage does not throw and yields intake on an unknown/uninitialized session id", () => {
    const { engine } = makeEngine()

    expect(() => engine.onUserMessage("never-seen")).not.toThrow()
    expect(engine.getPhase("never-seen")).toBe("intake")
    expect(engine.getTransitionLog("never-seen")).toEqual([])
  })

  it("onUserMessage on a session already at intake is a no-op (no spurious log entry)", () => {
    const { engine } = makeEngine()
    engine.activate("s1")
    const before = engine.getTransitionLog("s1").length

    engine.onUserMessage("s1")

    expect(engine.getPhase("s1")).toBe("intake")
    expect(engine.getTransitionLog("s1")).toHaveLength(before)
  })

  it("getPhase on a totally unknown session defaults to intake without throwing", () => {
    const { engine } = makeEngine()
    expect(() => engine.getPhase("ghost")).not.toThrow()
    expect(engine.getPhase("ghost")).toBe("intake")
  })
})

describe("PhaseEngine — per-story scoping (test 49 phase slice: phase_and_elevate_per_story)", () => {
  it("two stories under one session have independent phases", () => {
    const { engine } = makeEngine()
    engine.activate("s1")

    engine.onMutation("s1", "story-A") // story-A: intake -> execute
    expect(engine.getPhase("s1", "story-A")).toBe("execute")
    expect(engine.getPhase("s1", "story-B")).toBe("intake") // untouched, independent

    engine.onVerifierOutcome("s1", "story-A", { success: true, coversFinalStory: true }) // story-A -> elevate
    expect(engine.getPhase("s1", "story-A")).toBe("elevate")
    expect(engine.getPhase("s1", "story-B")).toBe("intake") // still untouched

    engine.onMutation("s1", "story-B") // story-B: intake -> execute, independently
    expect(engine.getPhase("s1", "story-B")).toBe("execute")
    expect(engine.getPhase("s1", "story-A")).toBe("elevate") // unaffected by story-B's mutation
  })

  it("session-level getPhase (no storyId) reads as the active story's phase", () => {
    const { engine } = makeEngine()
    engine.activate("s1")
    engine.onMutation("s1", "story-A")
    expect(engine.getPhase("s1")).toBe("execute") // story-A is active

    // Rebind "active story" to story-B via a call that produces no phase arc
    // itself (T4/T5 require source execute; story-B is still untouched
    // "intake", so this is a no-op transition-wise) — isolates the active-
    // story rebind from any transition side effect.
    engine.onVerifierOutcome("s1", "story-B", { success: false, coversFinalStory: false })
    expect(engine.getPhase("s1", "story-B")).toBe("intake") // untouched, no arc fired
    expect(engine.getPhase("s1")).toBe("intake") // now reads story-B's (the active story's) phase
    expect(engine.getPhase("s1", "story-A")).toBe("execute") // story-A itself is unaffected
  })

  it("BDD: active plan scopes the phase to the active story — story 1 checkpoints complete moves session phase to story 2's execute, not elevate", () => {
    const { engine } = makeEngine()
    engine.activate("s1")
    engine.onMutation("s1", "story-1")
    // story-1 is non-final: its verifier goes green but does not cover the
    // plan's final story, so no elevate — it simply checkpoints and the plan
    // advances (US-7 AS-4 / BDD "Active plan scopes the phase to the active story").
    engine.onVerifierOutcome("s1", "story-1", { success: true, coversFinalStory: false })
    expect(engine.getPhase("s1", "story-1")).toBe("execute")

    engine.onStoryAdvance("s1", "story-1", "story-2")

    expect(engine.getPhase("s1")).toBe("execute") // story 2's phase, not elevate
    expect(engine.getPhase("s1", "story-2")).toBe("execute")
    const log = engine.getTransitionLog("s1")
    const t8 = log[log.length - 1]
    expect(t8).toMatchObject({ storyId: "story-2", trigger: "T8" }) // arc recorded against story 2
  })

  it("onStoryAdvance rebinds phase for the next story without touching phase state of unrelated sessions", () => {
    const { engine } = makeEngine()
    engine.activate("s1")
    engine.activate("s2")
    engine.onMutation("s1", "story-1")
    engine.onMutation("s2", "story-X")
    engine.onVerifierOutcome("s2", "story-X", { success: true, coversFinalStory: true }) // s2 -> elevate

    engine.onStoryAdvance("s1", "story-1", "story-2")

    // s1 correctly rebound.
    expect(engine.getPhase("s1", "story-2")).toBe("execute")
    // s2 (an unrelated session) is completely untouched.
    expect(engine.getPhase("s2", "story-X")).toBe("elevate")
    expect(engine.getTransitionLog("s2").some((e) => e.sessionID !== "s2")).toBe(false)
  })

  it("reset() clears all phase state and transition log for a session only", () => {
    const { engine } = makeEngine()
    engine.activate("s1")
    engine.onMutation("s1", null)
    engine.activate("s2")
    engine.onMutation("s2", null)

    engine.reset("s1")

    expect(engine.getPhase("s1")).toBe("intake") // back to default (unknown session)
    expect(engine.getTransitionLog("s1")).toEqual([])
    expect(engine.getPhase("s2")).toBe("execute") // untouched
    expect(engine.getTransitionLog("s2").length).toBeGreaterThan(0)
  })

  it("getPhase distinguishes an explicit null storyId (no-plan slot) from an omitted storyId (active story)", () => {
    const { engine } = makeEngine()
    engine.activate("s1")
    engine.onMutation("s1", "story-1") // active story becomes "story-1"

    expect(engine.getPhase("s1", "story-1")).toBe("execute")
    expect(engine.getPhase("s1", null)).toBe("intake") // the no-plan slot was never touched
    expect(engine.getPhase("s1")).toBe("execute") // omitted -> active story's phase
  })
})
