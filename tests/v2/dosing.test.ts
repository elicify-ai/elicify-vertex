import { describe, expect, it } from "vitest"
import {
  doseFor,
  resolveProfile,
  type DirectiveFamily,
  type Dose,
  type Profile,
} from "../../src/v2/dosing.js"

// ---------------------------------------------------------------------------
// Test 16: dosing_profile_resolution
// Suffix normalization + default fallback. The "stamped on every subsequent
// event" assertion (Acceptance Scenario 1 / the event-stream BDD scenario)
// requires a real event stream and belongs to wave-3/4 integration tests —
// this file only exercises the pure resolution function.
// ---------------------------------------------------------------------------

describe("resolveProfile (test 16: dosing_profile_resolution)", () => {
  // Dataset: Dosing profiles (all 5 rows)
  it("row 1: anthropic/claude-fable-5 -> frontier", () => {
    expect(resolveProfile("anthropic/claude-fable-5")).toEqual({
      profile: "frontier",
      unknown: false,
      rawModelId: "anthropic/claude-fable-5",
    })
  })

  it("row 2: openrouter/anthropic/claude-fable-5 -> frontier (suffix-tolerant)", () => {
    expect(resolveProfile("openrouter/anthropic/claude-fable-5")).toEqual({
      profile: "frontier",
      unknown: false,
      rawModelId: "openrouter/anthropic/claude-fable-5",
    })
  })

  it("row 3: minimax/MiniMax-M3 -> standard (mapped, non-frontier)", () => {
    expect(resolveProfile("minimax/MiniMax-M3")).toEqual({
      profile: "standard",
      unknown: false,
      rawModelId: "minimax/MiniMax-M3",
    })
  })

  it("row 4: x/tiny-7b -> unknown -> standard, raw id preserved", () => {
    expect(resolveProfile("x/tiny-7b")).toEqual({
      profile: "standard",
      unknown: true,
      rawModelId: "x/tiny-7b",
    })
  })

  it("row 5: absent (null) model id -> unknown -> standard, rawModelId null", () => {
    expect(resolveProfile(null)).toEqual({
      profile: "standard",
      unknown: true,
      rawModelId: null,
    })
  })

  // Additional coverage beyond the dataset: suffix matching must anchor on a
  // path boundary, not a bare substring, and an unrelated model must not
  // accidentally match.
  it("does not match on a bare substring without a path-separator boundary", () => {
    // "not-anthropic/claude-fable-5-pro" contains the built-in key as a
    // substring but not as a "/"-delimited suffix, so it must be unknown.
    const result = resolveProfile("not-anthropic/claude-fable-5-pro")
    expect(result.unknown).toBe(true)
    expect(result.profile).toBe("standard")
  })

  it("matches exactly on the bare key with no prefix segments", () => {
    expect(resolveProfile("anthropic/claude-fable-5").unknown).toBe(false)
  })

  it("caller-supplied override table is consulted and takes precedence over the built-in table", () => {
    const overrides: Record<string, Profile> = {
      "anthropic/claude-fable-5": "standard", // repoints a built-in entry
      "custom-provider/custom-model": "frontier", // net-new entry
    }
    expect(resolveProfile("anthropic/claude-fable-5", overrides)).toEqual({
      profile: "standard",
      unknown: false,
      rawModelId: "anthropic/claude-fable-5",
    })
    expect(resolveProfile("custom-provider/custom-model", overrides)).toEqual({
      profile: "frontier",
      unknown: false,
      rawModelId: "custom-provider/custom-model",
    })
  })

  it("override table also matches suffix-tolerantly", () => {
    const overrides: Record<string, Profile> = {
      "custom-provider/custom-model": "frontier",
    }
    const result = resolveProfile("some-gateway/custom-provider/custom-model", overrides)
    expect(result).toEqual({
      profile: "frontier",
      unknown: false,
      rawModelId: "some-gateway/custom-provider/custom-model",
    })
  })

  it("an unmapped model id with an override table present still falls back to unknown/standard", () => {
    const overrides: Record<string, Profile> = { "some/other-model": "frontier" }
    expect(resolveProfile("totally/unmapped-model", overrides)).toEqual({
      profile: "standard",
      unknown: true,
      rawModelId: "totally/unmapped-model",
    })
  })
})

// ---------------------------------------------------------------------------
// Test 17: dosing_render_matrix
// Scenario Outline: Same finding, different profile, different dose.
// All 10 cells of the Examples table (5 families x 2 profiles).
// ---------------------------------------------------------------------------

describe("doseFor (test 17: dosing_render_matrix)", () => {
  const cases: Array<{ family: DirectiveFamily; profile: Profile; expected: Dose; label: string }> = [
    {
      family: "phase-procedure",
      profile: "standard",
      expected: "full",
      label: "phase procedure / standard -> full scaffold, every task",
    },
    {
      family: "phase-procedure",
      profile: "frontier",
      expected: "nudge-after-compliance",
      label: "phase procedure / frontier -> one-line nudge, suppressed after first compliance",
    },
    {
      family: "verification-prescription",
      profile: "standard",
      expected: "full",
      label: "verification prescription / standard -> always, exact resolved command",
    },
    {
      family: "verification-prescription",
      profile: "frontier",
      expected: "on-relevance-gap",
      label: "verification prescription / frontier -> only on a relevance gap",
    },
    {
      family: "falsification",
      profile: "standard",
      expected: "on-new-tests-only",
      label: "falsification / standard -> on new tests",
    },
    {
      family: "falsification",
      profile: "frontier",
      expected: "full",
      label: "falsification / frontier -> every execute-entry turn (primary lever) = full",
    },
    {
      family: "anomaly-interrupt",
      profile: "standard",
      expected: "full",
      label: "anomaly interrupt / standard -> full",
    },
    {
      family: "anomaly-interrupt",
      profile: "frontier",
      expected: "full",
      label: "anomaly interrupt / frontier -> full (FR-029 floor)",
    },
    {
      family: "elevate",
      profile: "standard",
      expected: "full",
      label: "elevate / standard -> full checklist",
    },
    {
      family: "elevate",
      profile: "frontier",
      expected: "rubric-and-taste-only",
      label: "elevate / frontier -> rubric + taste pass only",
    },
  ]

  it.each(cases)("$label", ({ family, profile, expected }) => {
    expect(doseFor(family, profile)).toBe(expected)
  })

  it("covers exactly the 5 families x 2 profiles = 10 cells of the Examples table", () => {
    expect(cases).toHaveLength(10)
  })
})

describe("doseFor: families outside the FR-029 matrix (explicit floor)", () => {
  const outOfMatrixFamilies = ["scope-watchdog", "plan-proposal", "pre-commitment", "some-future-family"]

  for (const family of outOfMatrixFamilies) {
    it(`"${family}" doses "full" under standard`, () => {
      expect(doseFor(family, "standard")).toBe("full")
    })

    it(`"${family}" doses "full" under frontier`, () => {
      expect(doseFor(family, "frontier")).toBe("full")
    })
  }
})

describe("doseFor: FR-029 floor is never inverted for frontier", () => {
  it("frontier never reduces anomaly-interrupt below full", () => {
    expect(doseFor("anomaly-interrupt", "frontier")).toBe("full")
  })

  it("frontier never reduces falsification below full", () => {
    expect(doseFor("falsification", "frontier")).toBe("full")
  })
})
