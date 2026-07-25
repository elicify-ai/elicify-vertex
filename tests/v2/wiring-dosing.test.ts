import { describe, expect, it } from "vitest"

import type { Finding } from "../../src/v2/composer.js"
import { applyDosing } from "../../src/v2/wiring/dosing.js"
import { freshSessionState } from "../../src/v2/wiring/state.js"

// ===========================================================================
// wiring/dosing.ts — applyDosing (FR-029 matrix applied to a candidate
// Finding before it reaches the composer)
//
// MAJOR fix (post-review): the "nudge-after-compliance" case used to return
// the FULL O-D-P-E finding, byte-identical, until the first compliance —
// contradicting US-8 AS2 ("the scaffold is suppressed to a one-line nudge").
// This suite covers the reduced pre-compliance form, the unchanged
// post-compliance suppression, and (as regression coverage) the other
// dose branches.
// ===========================================================================

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    family: "intake-scaffold",
    priority: "phase-guidance",
    observation: "No plan.json exists yet for this session.",
    diagnosis: "Intake phase procedure has not been run.",
    prescription: "Call story.createPlan with the confirmed story split.\nThen re-check scope.",
    example: "story.createPlan({ stories: [...] })",
    instanceId: "D-1",
    ...overrides,
  }
}

describe("applyDosing", () => {
  it("a family absent from DOSING_FAMILY_MAP passes through unchanged under either profile (explicit 'full' floor)", () => {
    const finding = makeFinding({ family: "scope-watchdog" })
    const state = freshSessionState("/tmp/x")
    expect(applyDosing(finding, "standard", state)).toBe(finding)
    expect(applyDosing(finding, "frontier", state)).toBe(finding)
  })

  it("dose 'full' (standard profile, phase-procedure family) passes the finding through unchanged", () => {
    const finding = makeFinding()
    const state = freshSessionState("/tmp/x")
    expect(applyDosing(finding, "standard", state)).toBe(finding)
  })

  describe("nudge-after-compliance (frontier profile, phase-procedure family: intake-scaffold / plan-proposal)", () => {
    it("BEFORE compliance: returns a REDUCED one-line-nudge form, not the full finding unmodified", () => {
      const finding = makeFinding()
      const state = freshSessionState("/tmp/x")
      const result = applyDosing(finding, "frontier", state)

      expect(result).not.toBeNull()
      expect(result).not.toBe(finding) // a new object, not the original returned verbatim
      expect(result).not.toEqual(finding) // MAJOR fix: must NOT be byte-identical to the full finding

      // Reduced content: Observation/Diagnosis/Example cleared, matching
      // composer.ts's own decay-form convention (prescription-only).
      expect(result!.observation).toBe("")
      expect(result!.diagnosis).toBe("")
      expect(result!.example).toBeUndefined()

      // Prescription collapsed to a single line (internal newlines removed),
      // same collapsing transform as composer.ts's renderDecayForm.
      expect(result!.prescription).not.toContain("\n")
      expect(result!.prescription).toBe("Call story.createPlan with the confirmed story split. Then re-check scope.")

      // Identity fields preserved.
      expect(result!.family).toBe("intake-scaffold")
      expect(result!.instanceId).toBe("D-1")
      expect(result!.priority).toBe("phase-guidance")
    })

    it("AFTER compliance: suppressed to null (unchanged, correct per spec — persistent for the rest of the session)", () => {
      const finding = makeFinding()
      const state = freshSessionState("/tmp/x")
      state.compliedFamiliesEver.add("intake-scaffold")
      expect(applyDosing(finding, "frontier", state)).toBeNull()
    })

    it("compliance is keyed per granular finding.family, not the shared DirectiveFamily: plan-proposal compliance does not suppress intake-scaffold", () => {
      const intakeFinding = makeFinding({ family: "intake-scaffold", instanceId: "D-1" })
      const planFinding = makeFinding({
        family: "plan-proposal",
        instanceId: "D-2",
        prescription: "Propose a story split for confirmation.",
      })
      const state = freshSessionState("/tmp/x")
      state.compliedFamiliesEver.add("plan-proposal")

      // plan-proposal is suppressed (its own compliance recorded)...
      expect(applyDosing(planFinding, "frontier", state)).toBeNull()
      // ...but intake-scaffold (a DIFFERENT family string, same DOSING_FAMILY_MAP
      // bucket) still renders as a reduced nudge, not suppressed.
      const intakeResult = applyDosing(intakeFinding, "frontier", state)
      expect(intakeResult).not.toBeNull()
      expect(intakeResult!.family).toBe("intake-scaffold")
    })

    it("collapses a prescription with mixed \\r\\n / \\n / trailing-whitespace line breaks to one line, trimmed", () => {
      const finding = makeFinding({
        prescription: "  First step.\r\n  Second step.\n   Third step.  ",
      })
      const state = freshSessionState("/tmp/x")
      const result = applyDosing(finding, "frontier", state)
      expect(result!.prescription).toBe("First step. Second step. Third step.")
    })

    it("a single-line prescription with no internal newlines is preserved verbatim (only trimmed)", () => {
      const finding = makeFinding({ prescription: "  Do the thing now.  " })
      const state = freshSessionState("/tmp/x")
      const result = applyDosing(finding, "frontier", state)
      expect(result!.prescription).toBe("Do the thing now.")
    })
  })

  describe("on-relevance-gap (frontier profile, verification-prescription family: verify-gap)", () => {
    it("renders unchanged when a verification already succeeded this turn (relevance gap present)", () => {
      const finding = makeFinding({ family: "verify-gap" })
      const state = freshSessionState("/tmp/x")
      state.everVerifiedThisTurn = true
      expect(applyDosing(finding, "frontier", state)).toBe(finding)
    })

    it("suppressed to null when no verification has succeeded this turn", () => {
      const finding = makeFinding({ family: "verify-gap" })
      const state = freshSessionState("/tmp/x")
      state.everVerifiedThisTurn = false
      expect(applyDosing(finding, "frontier", state)).toBeNull()
    })
  })

  describe("on-new-tests-only (standard profile, falsification family: pre-commitment)", () => {
    it("renders unchanged when this turn introduced a new test file", () => {
      const finding = makeFinding({ family: "pre-commitment" })
      const state = freshSessionState("/tmp/x")
      state.turnIntroducedNewTestFile = true
      expect(applyDosing(finding, "standard", state)).toBe(finding)
    })

    it("suppressed to null when this turn did not introduce a new test file", () => {
      const finding = makeFinding({ family: "pre-commitment" })
      const state = freshSessionState("/tmp/x")
      state.turnIntroducedNewTestFile = false
      expect(applyDosing(finding, "standard", state)).toBeNull()
    })

    it("frontier profile doses falsification as 'full' (floor) regardless of the new-test-file flag", () => {
      const finding = makeFinding({ family: "pre-commitment" })
      const state = freshSessionState("/tmp/x")
      state.turnIntroducedNewTestFile = false
      expect(applyDosing(finding, "frontier", state)).toBe(finding)
    })
  })

  describe("anomaly-interrupt (floor: full under both profiles)", () => {
    it("standard and frontier both render the anomaly-interrupt finding unchanged", () => {
      const finding = makeFinding({ family: "anomaly-interrupt" })
      const state = freshSessionState("/tmp/x")
      expect(applyDosing(finding, "standard", state)).toBe(finding)
      expect(applyDosing(finding, "frontier", state)).toBe(finding)
    })
  })

  describe("rubric-and-taste-only (frontier profile, elevate family)", () => {
    it("standard profile renders the elevate finding unchanged (full checklist)", () => {
      const finding = makeFinding({ family: "elevate" })
      const state = freshSessionState("/tmp/x")
      expect(applyDosing(finding, "standard", state)).toBe(finding)
    })

    it("frontier profile rewrites the elevate finding's O-D-P text to a rubric-and-taste-pass form", () => {
      const finding = makeFinding({ family: "elevate" })
      const state = freshSessionState("/tmp/x")
      const result = applyDosing(finding, "frontier", state)
      expect(result).not.toBeNull()
      expect(result!.family).toBe("elevate")
      expect(result!.observation).toBe("Deep task's bound verifier passed.")
      expect(result!.prescription).toMatch(/rubric/i)
      expect(result!.prescription).toMatch(/taste/i)
    })
  })
})
