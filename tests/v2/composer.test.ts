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

// ===========================================================================
// D4 — turn advancement per assistant reply cycle (FR-051, FR-052; US-14)
//
// Field evidence this fixes: a 1h34m unattended session held `turnIndex` at 1
// for its last 43 minutes and logged 250 `per-turn-cap:dropped` against 5
// `directive_rendered` — a ~2% delivery rate — because `newTurn()` was only
// ever called for a genuinely new USER message (and, later, for a gate
// continuation that in that session never dispatched).
//



/** `turnIndex` stamped on each `directive_rendered`, in order — the composer's
 * own observable record of which turn a directive was delivered under. */


// ===========================================================================
// Turn boundaries.
//
// REPLACES four "D4" blocks that exercised a deferred `requestNewTurn()`
// mode. That mode was REVERTED and its machinery deleted: live-host
// measurement showed `experimental.chat.system.transform` fires after every
// tool result, so advancing per reply cycle / per tool call ran the index
// 1 -> 4 within ONE reply cycle and collapsed every per-turn cap and
// cooldown into per-step. The premise was also wrong — the field session had
// exactly one activated user message, so `turnIndex == 1` was correct.
//
// A turn is a PROMPT boundary: a user message, or a gate-dispatched
// continuation. These tests pin that.
// ===========================================================================

describe("turn boundaries: a turn is a prompt, not an agent-loop step", () => {
  const finding = (id: string): Finding => ({
    family: "scope-watchdog", // DEFAULT_FAMILY_CAPS: 1 per turn
    priority: "correction",
    observation: "o",
    diagnosis: "d",
    prescription: "p",
    instanceId: id,
  })

  it("many render() calls inside one turn do NOT advance it — the cap holds", () => {
    const composer = new InjectionComposer({ logger: vi.fn() })
    composer.newTurn("s")

    const rendered: string[][] = []
    for (let i = 0; i < 5; i++) {
      rendered.push(composer.render("s", [finding(`F-${i}`)], { priorCompliance: () => false }).renderedFamilies)
    }

    // Cap is 1/turn: exactly one render across all five invocations.
    expect(rendered.flat()).toEqual(["scope-watchdog"])
  })

  it("a new prompt boundary DOES advance the turn, freeing the cap again", () => {
    const composer = new InjectionComposer({ logger: vi.fn() })

    composer.newTurn("s")
    const first = composer.render("s", [finding("A")], { priorCompliance: () => false })
    const blocked = composer.render("s", [finding("B")], { priorCompliance: () => false })

    composer.newTurn("s") // next prompt
    const second = composer.render("s", [finding("C")], { priorCompliance: () => false })

    expect(first.renderedFamilies).toEqual(["scope-watchdog"])
    expect(blocked.dropped).toEqual([{ family: "scope-watchdog", reason: "per-turn-cap" }])
    expect(second.renderedFamilies).toEqual(["scope-watchdog"])
  })

  it("turn advancement is per session", () => {
    const composer = new InjectionComposer({ logger: vi.fn() })
    composer.newTurn("a")
    composer.newTurn("a")
    composer.newTurn("b")

    expect(composer.render("a", [finding("X")], { priorCompliance: () => false }).renderedFamilies).toEqual([
      "scope-watchdog",
    ])
    expect(composer.render("b", [finding("Y")], { priorCompliance: () => false }).renderedFamilies).toEqual([
      "scope-watchdog",
    ])
  })
})

// ===========================================================================
// B-2 follow-up — `blockedBeforeBudget`: the predicate producers use to
// decide whether building a finding is worth anything.
//
// It replaces B-2's `currentTurn()`, which producers used as a stand-in for
// "has this family rendered yet this turn". A turn index does not answer that
// question — it moves at the turn boundary, not at a render — and the
// producer that trusted it went silent for the rest of the turn the first
// time its finding lost the 2-slot budget.
// ===========================================================================

describe("blockedBeforeBudget", () => {
  const f = (family: string, priority: Finding["priority"] = "correction") => makeFinding({ family, priority })

  it("is false before anything renders, and true only once the family's cap is spent", () => {
    const composer = new InjectionComposer({ logger: vi.fn() })
    composer.newTurn("s1")

    expect(composer.blockedBeforeBudget("s1", "verify-gap")).toBe(false)
    composer.render("s1", [f("verify-gap")], never)
    expect(composer.blockedBeforeBudget("s1", "verify-gap"), "cap 3: two left").toBe(false)
    composer.render("s1", [f("verify-gap")], never)
    composer.render("s1", [f("verify-gap")], never)
    expect(composer.blockedBeforeBudget("s1", "verify-gap"), "cap 3 spent").toBe(true)

    // Exactly the ruling the composer itself would make on the next finding.
    const r = composer.render("s1", [f("verify-gap")], never)
    expect(r.dropped).toEqual([{ family: "verify-gap", reason: "per-turn-cap" }])
  })

  it("a BUDGET drop does NOT block — that is the case the caller must re-offer", () => {
    // THE B-2 BUG, in one assertion. `intake-scaffold` is phase-guidance and
    // loses the 2-slot budget to two corrections; it has rendered nothing, so
    // its cap is untouched and the producer must be told to try again.
    const composer = new InjectionComposer({ logger: vi.fn() })
    composer.newTurn("s1")

    const r = composer.render(
      "s1",
      [f("anomaly-interrupt"), f("scope-watchdog"), f("intake-scaffold", "phase-guidance")],
      never,
    )
    expect(r.dropped).toEqual([{ family: "intake-scaffold", reason: "budget" }])
    expect(composer.blockedBeforeBudget("s1", "intake-scaffold")).toBe(false)

    // ...and the re-offer lands, in the same turn.
    expect(composer.render("s1", [f("intake-scaffold", "phase-guidance")], never).renderedFamilies).toEqual([
      "intake-scaffold",
    ])
  })

  it("clears at the next turn boundary, on both paths that advance it", () => {
    const composer = new InjectionComposer({ logger: vi.fn() })
    composer.newTurn("s1")
    composer.render("s1", [f("scope-watchdog")], never)
    expect(composer.blockedBeforeBudget("s1", "scope-watchdog")).toBe(true)

    composer.newTurn("s1") // a user message, or a gate continuation: same call
    expect(composer.blockedBeforeBudget("s1", "scope-watchdog")).toBe(false)
  })

  it("also reports a cooldown block, so a configured cooldown cannot re-open the flood", () => {
    const composer = new InjectionComposer({ logger: vi.fn(), cooldowns: { "scope-watchdog": 3 } })
    composer.newTurn("s1")
    composer.render("s1", [f("scope-watchdog")], never)

    composer.newTurn("s1")
    expect(composer.blockedBeforeBudget("s1", "scope-watchdog"), "cap refilled, cooldown has not").toBe(true)
    expect(composer.render("s1", [f("scope-watchdog")], never).dropped).toEqual([
      { family: "scope-watchdog", reason: "cooldown" },
    ])

    composer.newTurn("s1")
    composer.newTurn("s1")
    expect(composer.blockedBeforeBudget("s1", "scope-watchdog")).toBe(false)
  })

  it("is per session and per family", () => {
    const composer = new InjectionComposer({ logger: vi.fn() })
    composer.newTurn("a")
    composer.newTurn("b")
    composer.render("a", [f("scope-watchdog")], never)

    expect(composer.blockedBeforeBudget("a", "scope-watchdog")).toBe(true)
    expect(composer.blockedBeforeBudget("b", "scope-watchdog")).toBe(false)
    expect(composer.blockedBeforeBudget("a", "verify-gap")).toBe(false)
    // A family with no cap-table entry is never blocked by the cap.
    expect(composer.blockedBeforeBudget("a", "story-completion")).toBe(false)
  })
})

// ===========================================================================
// FR-061 — directive:starved, RE-BASED.
//
// The old detector counted `rendered + dropped` in ONE `render()` call and
// needed `attempted >= 5` at a >=90% drop rate. Every drop it counted was a
// per-turn-cap drop minted by a producer re-offering a finding the composer
// had already committed to discarding, so it read loudest exactly when the
// model had been told everything its caps allowed — and once the producers
// started asking `blockedBeforeBudget` first, the maximum `attempted` fell to
// 4 and it could never fire again. It had no test. These are that test, for
// the quantity that actually means starvation: a family the composer was
// offered again and again across a whole turn, that survived cap and cooldown
// every time, and that the 2-slot budget trim threw away until the turn ended
// without the model ever seeing it.
// ===========================================================================

describe("FR-061 starvation (RenderResult.starved)", () => {
  const f = (family: string, priority: Finding["priority"] = "correction") => makeFinding({ family, priority })

  /** Two corrections that hold both slots without ever capping out. */
  const twoBlockers = () => [f("no-cap-a"), f("no-cap-b")]

  it("reports a family the turn lost THREE times and never rendered, at the turn boundary", () => {
    const logger = vi.fn()
    const composer = new InjectionComposer({ logger })
    composer.newTurn("s1")

    for (let invocation = 1; invocation <= 3; invocation++) {
      const r = composer.render("s1", [...twoBlockers(), f("pinned-criteria-reinject", "enrichment")], never)
      expect(r.dropped).toEqual([{ family: "pinned-criteria-reinject", reason: "budget" }])
      // Mid-turn the question is undecided: the very next invocation could
      // still deliver it. Nothing is reported yet.
      expect(r.starved, `invocation ${invocation}`).toEqual([])
    }
    expect(logger).not.toHaveBeenCalledWith("directive:starved", expect.anything())

    // The turn ends. NOW it is decidable, and the verdict is logged there and
    // then — it does not depend on anyone collecting it.
    composer.newTurn("s1")
    expect(logger).toHaveBeenCalledWith(
      "directive:starved",
      expect.objectContaining({ sessionID: "s1", family: "pinned-criteria-reinject", budgetDrops: 3, turnIndex: 1 }),
    )

    // ...and it is handed to the caller once, by the next render.
    expect(composer.render("s1", [], never).starved).toEqual([
      { family: "pinned-criteria-reinject", budgetDrops: 3 },
    ])
    expect(composer.render("s1", [], never).starved, "handed over exactly once").toEqual([])
  })

  it("stays silent when the turn lost it only TWICE", () => {
    const logger = vi.fn()
    const composer = new InjectionComposer({ logger })
    composer.newTurn("s1")

    for (let i = 0; i < 2; i++) {
      composer.render("s1", [...twoBlockers(), f("pinned-criteria-reinject", "enrichment")], never)
    }
    composer.newTurn("s1")

    expect(logger).not.toHaveBeenCalledWith("directive:starved", expect.anything())
    expect(composer.render("s1", [], never).starved).toEqual([])
  })

  it("does NOT report a family that reached the model — crowded is not starved", () => {
    const logger = vi.fn()
    const composer = new InjectionComposer({ logger })
    composer.newTurn("s1")

    // Ten straight losses...
    for (let i = 0; i < 10; i++) {
      const r = composer.render("s1", [...twoBlockers(), f("story-completion", "phase-guidance")], never)
      expect(r.dropped).toEqual([{ family: "story-completion", reason: "budget" }])
    }
    // ...then it wins a slot on the eleventh. `story-completion` has no cap
    // entry, so nothing but the budget was ever stopping it.
    expect(
      composer.render("s1", [f("no-cap-a"), f("story-completion", "phase-guidance")], never).renderedFamilies,
    ).toContain("story-completion")

    composer.newTurn("s1")
    expect(logger).not.toHaveBeenCalledWith("directive:starved", expect.anything())
    expect(composer.render("s1", [], never).starved).toEqual([])
  })

  it("counts BUDGET losses only — cap and cooldown drops are not starvation", () => {
    // This is the whole re-basing, as an assertion. `scope-watchdog` is cap 1:
    // once it has rendered, every later offer is a per-turn-cap drop, which
    // means the model HAS been told. Counting those is what made the old
    // detector read loudest when the harness was working correctly.
    const logger = vi.fn()
    const composer = new InjectionComposer({ logger })
    composer.newTurn("s1")

    expect(composer.render("s1", [f("scope-watchdog")], never).renderedFamilies).toEqual(["scope-watchdog"])
    for (let i = 0; i < 20; i++) {
      expect(composer.render("s1", [f("scope-watchdog")], never).dropped).toEqual([
        { family: "scope-watchdog", reason: "per-turn-cap" },
      ])
    }
    composer.newTurn("s1")
    expect(logger).not.toHaveBeenCalledWith("directive:starved", expect.anything())

    // A family a caller has DISABLED with a cap of 0 renders nothing, ever, so
    // "it never rendered this turn" is true of it by construction. It is
    // switched off, not starved — and this is the one cap case whose drops are
    // not accompanied by a render, i.e. the one a `dropped`-counting
    // implementation would get wrong.
    const disabledLogger = vi.fn()
    const disabled = new InjectionComposer({ logger: disabledLogger, familyCaps: { "verify-gap": 0 } })
    disabled.newTurn("s3")
    for (let i = 0; i < 20; i++) {
      expect(disabled.render("s3", [f("verify-gap")], never).dropped).toEqual([
        { family: "verify-gap", reason: "per-turn-cap" },
      ])
    }
    disabled.newTurn("s3")
    expect(disabledLogger).not.toHaveBeenCalledWith("directive:starved", expect.anything())

    // ...and a family blocked purely by COOLDOWN, likewise: it is suppressed
    // on purpose, and it rendered in the turn the cooldown started from.
    const coolLogger = vi.fn()
    const cooling = new InjectionComposer({ logger: coolLogger, cooldowns: { "no-cap-a": 50 } })
    cooling.newTurn("s2")
    cooling.render("s2", [f("no-cap-a")], never)
    cooling.newTurn("s2")
    for (let i = 0; i < 20; i++) {
      expect(cooling.render("s2", [f("no-cap-a")], never).dropped).toEqual([
        { family: "no-cap-a", reason: "cooldown" },
      ])
    }
    cooling.newTurn("s2")
    expect(coolLogger).not.toHaveBeenCalledWith("directive:starved", expect.anything())
  })

  it("counts per turn, not per session — losses do not accumulate across turns", () => {
    const logger = vi.fn()
    const composer = new InjectionComposer({ logger })
    const lose = () => composer.render("s1", [...twoBlockers(), f("elevate", "phase-guidance")], never)

    // Two losses per turn, over four turns: eight in total, none reported.
    for (let turn = 0; turn < 4; turn++) {
      composer.newTurn("s1")
      lose()
      lose()
    }
    composer.newTurn("s1")
    expect(logger).not.toHaveBeenCalledWith("directive:starved", expect.anything())
  })

  it("is per session and per family", () => {
    const logger = vi.fn()
    const composer = new InjectionComposer({ logger })
    composer.newTurn("a")
    composer.newTurn("b")

    for (let i = 0; i < 3; i++) {
      composer.render("a", [...twoBlockers(), f("elevate", "phase-guidance")], never)
      composer.render("a", [...twoBlockers(), f("pre-commitment", "phase-guidance")], never)
      composer.render("b", [...twoBlockers(), f("elevate", "phase-guidance")], never)
    }
    // Session b's turn has not ended, so its own count is still open.
    composer.newTurn("a")

    expect(composer.render("a", [], never).starved).toEqual([
      { family: "elevate", budgetDrops: 3 },
      { family: "pre-commitment", budgetDrops: 3 },
    ])
    expect(composer.render("b", [], never).starved).toEqual([])
    expect(logger).not.toHaveBeenCalledWith("directive:starved", expect.objectContaining({ sessionID: "b" }))
  })
})

// ===========================================================================
// FIX 2 — claimOncePerTurn.
//
// Wiring kept two "already logged this turn" booleans (`expect:absent`,
// `criteria:parse-miss`) that only `resetTurnState` cleared. There are TWO
// turn boundaries and `resetTurnState` is on one of them, so every
// continuation turn of an unattended run inherited a spent flag. The latch
// lives on the composer's clock now, which both boundaries advance.
// ===========================================================================

describe("claimOncePerTurn", () => {
  it("grants the first claim of a turn and refuses every later one", () => {
    const composer = new InjectionComposer({ logger: vi.fn() })
    composer.newTurn("s1")

    expect(composer.claimOncePerTurn("s1", "expect:absent")).toBe(true)
    expect(composer.claimOncePerTurn("s1", "expect:absent")).toBe(false)
    expect(composer.claimOncePerTurn("s1", "expect:absent")).toBe(false)
  })

  it("re-arms on a turn advance — the boundary a gate continuation also crosses", () => {
    const composer = new InjectionComposer({ logger: vi.fn() })
    composer.newTurn("s1")
    expect(composer.claimOncePerTurn("s1", "criteria:parse-miss")).toBe(true)
    expect(composer.claimOncePerTurn("s1", "criteria:parse-miss")).toBe(false)

    composer.newTurn("s1")
    expect(composer.claimOncePerTurn("s1", "criteria:parse-miss")).toBe(true)
  })

  it("keys are independent of each other, of the session, and of rendering", () => {
    const composer = new InjectionComposer({ logger: vi.fn() })
    composer.newTurn("s1")
    composer.newTurn("s2")

    expect(composer.claimOncePerTurn("s1", "expect:absent")).toBe(true)
    expect(composer.claimOncePerTurn("s1", "criteria:parse-miss")).toBe(true)
    expect(composer.claimOncePerTurn("s2", "expect:absent")).toBe(true)

    // A render is NOT a turn boundary: a latch spent before one is still spent
    // after it. (This is the B-2 confusion the latch must never re-introduce —
    // `blockedBeforeBudget` is the render question, this is not.)
    composer.render("s1", [makeFinding({ family: "verify-gap", priority: "correction" })], never)
    expect(composer.claimOncePerTurn("s1", "expect:absent")).toBe(false)
  })

  it("works before the first newTurn — turn 0 is a turn", () => {
    const composer = new InjectionComposer({ logger: vi.fn() })
    expect(composer.claimOncePerTurn("fresh", "expect:absent")).toBe(true)
    expect(composer.claimOncePerTurn("fresh", "expect:absent")).toBe(false)
  })
})
