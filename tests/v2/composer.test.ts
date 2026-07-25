import { describe, expect, it, vi } from "vitest"

import { DEFAULT_FAMILY_CAPS, InjectionComposer, type Finding } from "../../src/v2/composer.js"

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let instanceCounter = 0

function makeFinding(overrides: Partial<Finding> & Pick<Finding, "family" | "priority">): Finding {
  instanceCounter += 1
  return {
    observation: `observed-state-${instanceCounter}`,
    diagnosis: `diagnosis-${instanceCounter}`,
    prescription: `npx vitest run tests/fixture-${instanceCounter}.test.ts`,
    instanceId: `inst-${instanceCounter}`,
    ...overrides,
  }
}

const never = { priorCompliance: () => false }

// ===========================================================================
// Test 4 — composer_renders_odpe_slots
// Traces to: BDD "Verify-gap renders all grammar slots from observed state"
// ===========================================================================

describe("composer_renders_odpe_slots (test 4)", () => {
  it("renders Observed:/Diagnosis:/Do now: from the finding's real observed state", () => {
    const logger = vi.fn()
    const composer = new InjectionComposer({ logger })
    composer.newTurn("s1")

    const f: Finding = {
      family: "verify-gap",
      priority: "correction",
      observation: "src/lexer.ts changed; last verifier classified types-only",
      diagnosis: "type-check alone does not exercise runtime behavior",
      prescription: "npx vitest run tests/lexer.test.ts",
      instanceId: "d-1",
    }

    const result = composer.render("s1", [f], never)

    expect(result.text).not.toBeNull()
    expect(result.text).toContain("Observed: src/lexer.ts changed; last verifier classified types-only")
    expect(result.text).toContain("Diagnosis: type-check alone does not exercise runtime behavior")
    expect(result.text).toContain("Do now: npx vitest run tests/lexer.test.ts")
    expect(result.renderedFamilies).toEqual(["verify-gap"])
    expect(result.dropped).toEqual([])
  })

  it("includes the optional Example: slot only when the finding supplies one", () => {
    const composer = new InjectionComposer({ logger: vi.fn() })
    composer.newTurn("s1")

    const withExample = makeFinding({ family: "verify-gap", priority: "correction", example: "e.g. npm test" })
    const r1 = composer.render("s1", [withExample], never)
    expect(r1.text).toContain("Example: e.g. npm test")

    composer.newTurn("s1")
    const withoutExample = makeFinding({ family: "verify-gap", priority: "correction" })
    const r2 = composer.render("s1", [withoutExample], never)
    expect(r2.text).not.toContain("Example:")
  })
})

// ===========================================================================
// Test 5 — composer_budget_priority
// Traces to: BDD "Budget drops lowest-priority finding"; Dataset rows 1, 2
// ===========================================================================

describe("composer_budget_priority (test 5)", () => {
  it("dataset row 1: correction + guidance + enrichment -> correction, guidance render; enrichment dropped+logged budget:dropped", () => {
    const logger = vi.fn()
    const composer = new InjectionComposer({ logger })
    composer.newTurn("s1")

    const correction = makeFinding({ family: "anomaly-interrupt", priority: "correction" })
    const guidance = makeFinding({ family: "elevate", priority: "phase-guidance" })
    const enrichment = makeFinding({ family: "pinned-criteria-reinject", priority: "enrichment" })

    const result = composer.render("s1", [enrichment, guidance, correction], never)

    expect(result.renderedFamilies).toEqual(["anomaly-interrupt", "elevate"])
    expect(result.dropped).toEqual([{ family: "pinned-criteria-reinject", reason: "budget" }])
    expect(logger).toHaveBeenCalledWith(
      "budget:dropped",
      expect.objectContaining({ family: "pinned-criteria-reinject", instanceId: enrichment.instanceId }),
    )
  })

  it("dataset row 2: 2 corrections + guidance -> the 2 corrections render, guidance dropped (priority within cap)", () => {
    const composer = new InjectionComposer({ logger: vi.fn() })
    composer.newTurn("s1")

    const c1 = makeFinding({ family: "anomaly-interrupt", priority: "correction" })
    const c2 = makeFinding({ family: "scope-watchdog", priority: "correction" })
    const guidance = makeFinding({ family: "elevate", priority: "phase-guidance" })

    const result = composer.render("s1", [guidance, c1, c2], never)

    expect([...result.renderedFamilies].sort()).toEqual(["anomaly-interrupt", "scope-watchdog"])
    expect(result.dropped).toEqual([{ family: "elevate", reason: "budget" }])
  })

  it("a budget-dropped finding is never carried into a later invocation", () => {
    const composer = new InjectionComposer({ logger: vi.fn() })
    composer.newTurn("s1")

    const correction = makeFinding({ family: "anomaly-interrupt", priority: "correction" })
    const guidance = makeFinding({ family: "elevate", priority: "phase-guidance" })
    const enrichment = makeFinding({ family: "pinned-criteria-reinject", priority: "enrichment" })
    composer.render("s1", [correction, guidance, enrichment], never)

    // Caller does not re-pass the dropped enrichment finding.
    const second = composer.render("s1", [], never)
    expect(second.text).toBeNull()
    expect(second.renderedFamilies).toEqual([])
    expect(second.dropped).toEqual([])
  })

  it("exactly 2 directives are injected even when more than 2 findings survive cap/cooldown filtering", () => {
    const composer = new InjectionComposer({ logger: vi.fn() })
    composer.newTurn("s1")
    const findings = [
      makeFinding({ family: "anomaly-interrupt", priority: "correction" }),
      makeFinding({ family: "scope-watchdog", priority: "correction" }),
      makeFinding({ family: "elevate", priority: "phase-guidance" }),
      makeFinding({ family: "pinned-criteria-reinject", priority: "enrichment" }),
    ]
    const result = composer.render("s1", findings, never)
    expect(result.renderedFamilies).toHaveLength(2)
  })
})

// ===========================================================================
// Test 6 — composer_decay_on_compliance
// Traces to: BDD "Compliance decays the next occurrence to one line"; Dataset rows 4, 5
// ===========================================================================

describe("composer_decay_on_compliance (test 6)", () => {
  it("dataset row 4: priorCompliance true -> single-line decay form containing only the command", () => {
    const composer = new InjectionComposer({ logger: vi.fn() })
    composer.newTurn("s1")

    const f = makeFinding({
      family: "verify-gap",
      priority: "correction",
      prescription: "npx vitest run tests/lexer.test.ts",
    })
    const result = composer.render("s1", [f], { priorCompliance: (family) => family === "verify-gap" })

    expect(result.text).not.toBeNull()
    expect(result.text).toContain("npx vitest run tests/lexer.test.ts")
    expect(result.text).not.toContain("Observed:")
    expect(result.text).not.toContain("Diagnosis:")
    expect(result.text).not.toContain("Do now:")
  })

  it("dataset row 5: priorCompliance false -> full Observed/Diagnosis/Do now form (no decay)", () => {
    const composer = new InjectionComposer({ logger: vi.fn() })
    composer.newTurn("s1")

    const f = makeFinding({ family: "verify-gap", priority: "correction" })
    const result = composer.render("s1", [f], { priorCompliance: () => false })

    expect(result.text).toContain("Observed:")
    expect(result.text).toContain("Diagnosis:")
    expect(result.text).toContain("Do now:")
  })

  it("decay is scoped per family: priorCompliance for an unrelated family does not decay this one", () => {
    const composer = new InjectionComposer({ logger: vi.fn() })
    composer.newTurn("s1")
    const f = makeFinding({ family: "verify-gap", priority: "correction" })
    const result = composer.render("s1", [f], { priorCompliance: (family) => family === "some-other-family" })
    expect(result.text).toContain("Observed:")
  })

  it("recordCompliance decays rendering strictly for the immediately-next turn, not turns after that", () => {
    const composer = new InjectionComposer({ logger: vi.fn() })
    composer.newTurn("s1") // turn 1
    composer.recordCompliance("s1", "verify-gap", "prior-instance")

    composer.newTurn("s1") // turn 2 — immediately follows the compliance turn
    const f2 = makeFinding({ family: "verify-gap", priority: "correction" })
    const r2 = composer.render("s1", [f2], never)
    expect(r2.text).not.toContain("Observed:") // decayed via internal compliance record

    composer.newTurn("s1") // turn 3 — compliance was 2 turns ago now, FR-006 says "previous turn" only
    const f3 = makeFinding({ family: "verify-gap", priority: "correction" })
    const r3 = composer.render("s1", [f3], never)
    expect(r3.text).toContain("Observed:") // no longer decays
  })
})

// ===========================================================================
// Test 7 — composer_cooldown (cooldownTurns 1 and 2, spanning a chat.message boundary)
// Traces to: BDD "Cooldown suppresses identical finding across turn boundaries"
// ===========================================================================

describe("composer_cooldown (test 7)", () => {
  it("cooldownTurns: 1 (default) — eligible again immediately at the next turn (no extra suppression beyond the cap's same-turn reset)", () => {
    const logger = vi.fn()
    const composer = new InjectionComposer({ logger }) // default cooldownTurns=1, scope-watchdog cap=1
    composer.newTurn("s1") // turn 1

    const f1 = makeFinding({ family: "scope-watchdog", priority: "correction" })
    const r1 = composer.render("s1", [f1], never)
    expect(r1.renderedFamilies).toEqual(["scope-watchdog"])

    // Same turn, second invocation: blocked by the per-turn cap (cap=1), not cooldown.
    const f1b = makeFinding({ family: "scope-watchdog", priority: "correction" })
    const r1b = composer.render("s1", [f1b], never)
    expect(r1b.renderedFamilies).toEqual([])
    expect(r1b.dropped).toEqual([{ family: "scope-watchdog", reason: "per-turn-cap" }])

    composer.newTurn("s1") // turn 2
    const f2 = makeFinding({ family: "scope-watchdog", priority: "correction" })
    const r2 = composer.render("s1", [f2], never)
    expect(r2.renderedFamilies).toEqual(["scope-watchdog"]) // eligible again, cooldownTurns:1 did not add extra suppression
  })

  it("cooldownTurns: 2 — spans a chat.message boundary (dataset row 8): rendered at T, suppressed at T+1, rendered at T+2", () => {
    const logger = vi.fn()
    const composer = new InjectionComposer({ logger, cooldowns: { "scope-watchdog": 2 } })
    composer.newTurn("s1") // turn T = 1

    const fT = makeFinding({ family: "scope-watchdog", priority: "correction" })
    const rT = composer.render("s1", [fT], never)
    expect(rT.renderedFamilies).toEqual(["scope-watchdog"])

    composer.newTurn("s1") // turn T+1 = 2
    const fT1 = makeFinding({ family: "scope-watchdog", priority: "correction" })
    const rT1 = composer.render("s1", [fT1], never)
    expect(rT1.renderedFamilies).toEqual([])
    expect(rT1.dropped).toEqual([{ family: "scope-watchdog", reason: "cooldown" }])
    expect(logger).toHaveBeenCalledWith(
      "cooldown:dropped",
      expect.objectContaining({ family: "scope-watchdog", cooldownTurns: 2, lastRenderedTurn: 1 }),
    )

    composer.newTurn("s1") // turn T+2 = 3
    const fT2 = makeFinding({ family: "scope-watchdog", priority: "correction" })
    const rT2 = composer.render("s1", [fT2], never)
    expect(rT2.renderedFamilies).toEqual(["scope-watchdog"])
  })
})

// ===========================================================================
// Test 48 — composer_budget_multi_transform
// Traces to: BDD "Anomaly interrupt survives a turn whose budget went to corrections"; Dataset row 7
// ===========================================================================

describe("composer_budget_multi_transform (test 48)", () => {
  it("the anomaly interrupt survives a turn whose first invocation already spent both slots on corrections", () => {
    const composer = new InjectionComposer({ logger: vi.fn() })
    composer.newTurn("s1") // one turn, >=3 system.transform invocations

    // Invocation #1: two corrections spend the whole 2-slot budget.
    const corr1 = makeFinding({ family: "scope-watchdog", priority: "correction" })
    const corr2 = makeFinding({ family: "repeat-failure", priority: "correction" })
    const r1 = composer.render("s1", [corr1, corr2], never)
    expect([...r1.renderedFamilies].sort()).toEqual(["repeat-failure", "scope-watchdog"])
    expect(r1.dropped).toEqual([])

    // Invocation #2: a failing verifier produces an anomaly finding before this invocation.
    // Its per-family per-turn cap (1) is untouched by invocation #1's unrelated families.
    const anomaly = makeFinding({ family: "anomaly-interrupt", priority: "correction" })
    const r2 = composer.render("s1", [anomaly], never)
    expect(r2.renderedFamilies).toEqual(["anomaly-interrupt"])
    expect(r2.dropped).toEqual([])

    // Invocation #3: elevate renders (its own cap unspent); the anomaly family's cap (1)
    // is now spent, so a recurring anomaly finding injects no further anomaly directive.
    const elevate = makeFinding({ family: "elevate", priority: "phase-guidance" })
    const anomalyAgain = makeFinding({ family: "anomaly-interrupt", priority: "correction" })
    const r3 = composer.render("s1", [elevate, anomalyAgain], never)
    expect(r3.renderedFamilies).toEqual(["elevate"])
    expect(r3.dropped).toEqual([{ family: "anomaly-interrupt", reason: "per-turn-cap" }])
  })
})

// ===========================================================================
// Dataset: Composer budget / cooldown / decay — all 11 rows
// ===========================================================================

describe("Dataset: Composer budget / cooldown / decay", () => {
  it("row 1: correction + guidance + enrichment -> correction, guidance render (drop logged)", () => {
    const logger = vi.fn()
    const composer = new InjectionComposer({ logger })
    composer.newTurn("s1")
    const correction = makeFinding({ family: "anomaly-interrupt", priority: "correction" })
    const guidance = makeFinding({ family: "elevate", priority: "phase-guidance" })
    const enrichment = makeFinding({ family: "pinned-criteria-reinject", priority: "enrichment" })
    const result = composer.render("s1", [correction, guidance, enrichment], never)
    expect(result.renderedFamilies).toEqual(["anomaly-interrupt", "elevate"])
    expect(result.dropped).toEqual([{ family: "pinned-criteria-reinject", reason: "budget" }])
  })

  it("row 2: 2 corrections + guidance -> 2 corrections render (priority within cap)", () => {
    const composer = new InjectionComposer({ logger: vi.fn() })
    composer.newTurn("s1")
    const c1 = makeFinding({ family: "anomaly-interrupt", priority: "correction" })
    const c2 = makeFinding({ family: "scope-watchdog", priority: "correction" })
    const guidance = makeFinding({ family: "elevate", priority: "phase-guidance" })
    const result = composer.render("s1", [c1, c2, guidance], never)
    expect([...result.renderedFamilies].sort()).toEqual(["anomaly-interrupt", "scope-watchdog"])
  })

  it("row 3: scope-drift x2 same turn -> 1 total (per-family per-turn cap 1)", () => {
    const composer = new InjectionComposer({ logger: vi.fn() })
    composer.newTurn("s1")
    const first = makeFinding({ family: "scope-watchdog", priority: "correction" })
    const r1 = composer.render("s1", [first], never)
    expect(r1.renderedFamilies).toEqual(["scope-watchdog"])

    const second = makeFinding({ family: "scope-watchdog", priority: "correction" })
    const r2 = composer.render("s1", [second], never)
    expect(r2.renderedFamilies).toEqual([])
    expect(r2.dropped).toEqual([{ family: "scope-watchdog", reason: "per-turn-cap" }])
  })

  it("row 4: verify-gap, complied last turn -> one-line decay form", () => {
    const composer = new InjectionComposer({ logger: vi.fn() })
    composer.newTurn("s1")
    const f = makeFinding({ family: "verify-gap", priority: "correction", prescription: "npm test" })
    const result = composer.render("s1", [f], { priorCompliance: () => true })
    expect(result.text).toContain("npm test")
    expect(result.text).not.toContain("Observed:")
  })

  it("row 5: verify-gap, non-complied last turn -> full O-D-P-E", () => {
    const composer = new InjectionComposer({ logger: vi.fn() })
    composer.newTurn("s1")
    const f = makeFinding({ family: "verify-gap", priority: "correction" })
    const result = composer.render("s1", [f], { priorCompliance: () => false })
    expect(result.text).toContain("Observed:")
    expect(result.text).toContain("Diagnosis:")
    expect(result.text).toContain("Do now:")
  })

  it("row 6: no pending findings -> no envelope injected (empty => silence)", () => {
    const composer = new InjectionComposer({ logger: vi.fn() })
    composer.newTurn("s1")
    const result = composer.render("s1", [], never)
    expect(result.text).toBeNull()
    expect(result.renderedFamilies).toEqual([])
    expect(result.dropped).toEqual([])
  })

  it("row 7: 2 corrections at #1, anomaly at #2, elevate at #3 (one turn) -> 2 corrections, then anomaly, then elevate", () => {
    const composer = new InjectionComposer({ logger: vi.fn() })
    composer.newTurn("s1")
    const r1 = composer.render(
      "s1",
      [makeFinding({ family: "scope-watchdog", priority: "correction" }), makeFinding({ family: "repeat-failure", priority: "correction" })],
      never,
    )
    expect([...r1.renderedFamilies].sort()).toEqual(["repeat-failure", "scope-watchdog"])

    const r2 = composer.render("s1", [makeFinding({ family: "anomaly-interrupt", priority: "correction" })], never)
    expect(r2.renderedFamilies).toEqual(["anomaly-interrupt"])

    const r3 = composer.render("s1", [makeFinding({ family: "elevate", priority: "phase-guidance" })], never)
    expect(r3.renderedFamilies).toEqual(["elevate"])
  })

  it("row 8: scope-drift with cooldownTurns:2 at turn T -> rendered at T, suppressed at T+1, rendered at T+2", () => {
    const composer = new InjectionComposer({ logger: vi.fn(), cooldowns: { "scope-watchdog": 2 } })
    composer.newTurn("s1")
    const rT = composer.render("s1", [makeFinding({ family: "scope-watchdog", priority: "correction" })], never)
    expect(rT.renderedFamilies).toEqual(["scope-watchdog"])

    composer.newTurn("s1")
    const rT1 = composer.render("s1", [makeFinding({ family: "scope-watchdog", priority: "correction" })], never)
    expect(rT1.renderedFamilies).toEqual([])

    composer.newTurn("s1")
    const rT2 = composer.render("s1", [makeFinding({ family: "scope-watchdog", priority: "correction" })], never)
    expect(rT2.renderedFamilies).toEqual(["scope-watchdog"])
  })

  it("row 9: intake + scope + anomaly + elevate + verify-gap x4, all pending in one turn -> each family's FR-004 cap enforced across the turn", () => {
    const composer = new InjectionComposer({ logger: vi.fn() })
    composer.newTurn("s1")

    const r1 = composer.render(
      "s1",
      [makeFinding({ family: "intake-scaffold", priority: "phase-guidance" }), makeFinding({ family: "scope-watchdog", priority: "correction" })],
      never,
    )
    expect([...r1.renderedFamilies].sort()).toEqual(["intake-scaffold", "scope-watchdog"])

    const r2 = composer.render(
      "s1",
      [makeFinding({ family: "anomaly-interrupt", priority: "correction" }), makeFinding({ family: "elevate", priority: "phase-guidance" })],
      never,
    )
    expect([...r2.renderedFamilies].sort()).toEqual(["anomaly-interrupt", "elevate"])

    const r3 = composer.render(
      "s1",
      [makeFinding({ family: "verify-gap", priority: "correction" }), makeFinding({ family: "verify-gap", priority: "correction" })],
      never,
    )
    expect(r3.renderedFamilies).toEqual(["verify-gap", "verify-gap"])

    // A 3rd and 4th verify-gap finding: cap (3) allows exactly one more; the 4th is dropped.
    const r4 = composer.render(
      "s1",
      [makeFinding({ family: "verify-gap", priority: "correction" }), makeFinding({ family: "verify-gap", priority: "correction" })],
      never,
    )
    expect(r4.renderedFamilies).toEqual(["verify-gap"])
    expect(r4.dropped).toEqual([{ family: "verify-gap", reason: "per-turn-cap" }])

    // Across the whole turn: intake<=1, scope<=1, anomaly<=1, elevate<=1, verify-gap<=3.
    const totalVerifyGap =
      r3.renderedFamilies.filter((f) => f === "verify-gap").length + r4.renderedFamilies.filter((f) => f === "verify-gap").length
    expect(totalVerifyGap).toBe(3)
  })

  it("row 10 (FR-034 equivalence stubbed): priorCompliance(true) -> counted as compliance -> decay form", () => {
    // The actual verifier-equivalence matching (reporter-flag stripping etc.) is
    // measurement.ts's job (FR-034); this module only needs to trust whatever
    // boolean the caller's priorCompliance predicate returns.
    const composer = new InjectionComposer({ logger: vi.fn() })
    composer.newTurn("s1")
    const f = makeFinding({ family: "verify-gap", priority: "correction", prescription: "npx vitest run tests/lexer.test.ts" })
    const result = composer.render("s1", [f], { priorCompliance: () => true })
    expect(result.text).toContain("npx vitest run tests/lexer.test.ts")
    expect(result.text).not.toContain("Do now:")
  })

  it("row 11 (FR-034 non-equivalence stubbed): priorCompliance(false) -> not counted -> full form", () => {
    const composer = new InjectionComposer({ logger: vi.fn() })
    composer.newTurn("s1")
    const f = makeFinding({ family: "verify-gap", priority: "correction", prescription: "npx vitest run tests/lexer.test.ts" })
    const result = composer.render("s1", [f], { priorCompliance: () => false })
    expect(result.text).toContain("Do now: npx vitest run tests/lexer.test.ts")
  })
})

// ===========================================================================
// FR-007 — redaction
// ===========================================================================

describe("FR-007: redactSecrets is applied before injection", () => {
  it("redacts a secret embedded in a finding's observation/prescription text", () => {
    const composer = new InjectionComposer({ logger: vi.fn() })
    composer.newTurn("s1")
    const f = makeFinding({
      family: "verify-gap",
      priority: "correction",
      observation: "found AKIAABCDEFGHIJKLMNOP in src/config.ts",
      prescription: "rotate the key, api_key: 'sk-live-abcdefghijklmnop12345'",
    })
    const result = composer.render("s1", [f], never)
    expect(result.text).not.toContain("AKIAABCDEFGHIJKLMNOP")
    expect(result.text).not.toContain("sk-live-abcdefghijklmnop12345")
    expect(result.text).toContain("[REDACTED]")
  })
})

// ===========================================================================
// DEFAULT_FAMILY_CAPS — sanity check against the module contract's literal table
// ===========================================================================

describe("DEFAULT_FAMILY_CAPS", () => {
  it("matches the FR-004 per-turn cap table exactly", () => {
    expect(DEFAULT_FAMILY_CAPS).toEqual({
      "intake-scaffold": 1,
      "plan-proposal": 1,
      "pre-commitment": 1,
      "scope-watchdog": 1,
      "anomaly-interrupt": 1,
      "repeat-failure": 1,
      "verify-gap": 3,
      elevate: 1,
      "pinned-criteria-reinject": 1,
    })
  })

  it("is used as the default cap table when the caller supplies none", () => {
    const composer = new InjectionComposer({ logger: vi.fn() })
    composer.newTurn("s1")
    const a = makeFinding({ family: "verify-gap", priority: "correction" })
    const b = makeFinding({ family: "verify-gap", priority: "correction" })
    const c = makeFinding({ family: "verify-gap", priority: "correction" })
    const d = makeFinding({ family: "verify-gap", priority: "correction" })
    // budget=2 per call, so spread across 2 calls to exercise the cap (3) rather than the budget.
    const r1 = composer.render("s1", [a, b], never)
    const r2 = composer.render("s1", [c, d], never)
    expect(r1.renderedFamilies.length + r2.renderedFamilies.length).toBe(3)
  })
})
