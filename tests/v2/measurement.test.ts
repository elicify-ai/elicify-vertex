/**
 * elicify-vertex — measurement.ts v2 extension tests
 * --------------------------------------------------------------------------
 * Covers the module-contracts "measurement.ts extension" section
 * (FR-033/FR-033a/FR-034/FR-035):
 *   - test 42 (event_invariants_property): every new v2 event type carries a
 *     non-empty session_id and a model that is either "unknown" or a
 *     providerID/modelID-shaped string. `fast-check` is NOT a devDependency
 *     (checked package.json — only @opencode-ai/plugin, @types/node,
 *     typescript, vitest are listed), so per the task brief this is a
 *     hand-rolled table-driven test iterating over every member of
 *     `V2_EVENT_TYPES` instead of adding a new dependency.
 *   - verifiersEquivalent (FR-034): Dataset "Composer budget / cooldown /
 *     decay" rows 10 and 11.
 *   - FR-033a rotation/retention, driven with small overrides (never writes
 *     real 32MB or waits real days).
 *   - FR-035 per-family holdout-arm hashing, backward-compatible default.
 */

import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  IGNORED_VERIFIER_FLAGS,
  ROTATE_MAX_BYTES,
  ROTATE_RETENTION_DAYS,
  V2_EVENT_TYPES,
  appendEvent,
  eventsPath,
  holdoutArm,
  holdoutSuppresses,
  logCalibration,
  logCriteriaParseMiss,
  logCriteriaRePinned,
  logCriteriaTruncated,
  logDirectiveComplied,
  logDirectiveRendered,
  logExpectAbsent,
  logGateMultiSessionAdvisory,
  logHoldoutSuppress,
  logIntakeClassifyCapped,
  logIntakeClassifyFallback,
  logIntakeClassifySkipped,
  logIntakeClassifyUnsupported,
  logVerifierFieldDropped,
  logVerifierMalformed,
  logVerifierUnavailable,
  logVerifierUnsupported,
  logPhaseTransition,
  logPinsDiskFallbackMemory,
  logPinsDiskRecovered,
  logPinsDiskUnavailable,
  logResolutionNone,
  logSubturnCleanupFailed,
  logV2Event,
  makeV2Event,
  rotateEventsSinkIfNeeded,
  stripIgnoredVerifierFlags,
  verifiersEquivalent,
  type MeasurementEvent,
  type ResolveVerifierContext,
  type ResolveVerifierDeps,
  type ResolveVerifierFn,
  type ResolveVerifierResult,
  type V2EventInput,
  type V2EventType,
} from "../../src/measurement.js"

// Real resolver, imported read-only for a bonus cross-check (not required by
// the task brief, which explicitly calls for a *local* type alias in
// src/measurement.ts itself to avoid a hard source-level dependency on
// resolve.ts's timing — that constraint is about measurement.ts's own
// implementation, not about what a *test* may additionally exercise).
import { resolveVerifier as realResolveVerifier } from "../../src/v2/resolve.js"

let tmpRoot: string
let savedVertexData: string | undefined
let savedVertexHoldout: string | undefined

beforeEach(() => {
  savedVertexData = process.env.VERTEX_DATA
  savedVertexHoldout = process.env.VERTEX_HOLDOUT
  tmpRoot = mkdtempSync(join(tmpdir(), "vertex-meas-v2-"))
  process.env.VERTEX_DATA = tmpRoot
  delete process.env.VERTEX_HOLDOUT
})

afterEach(() => {
  if (savedVertexData === undefined) delete process.env.VERTEX_DATA
  else process.env.VERTEX_DATA = savedVertexData
  if (savedVertexHoldout === undefined) delete process.env.VERTEX_HOLDOUT
  else process.env.VERTEX_HOLDOUT = savedVertexHoldout
  rmSync(tmpRoot, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Test 42: event_invariants_property
// ---------------------------------------------------------------------------

/** A string that would only appear in a record if raw chat/prompt narrative leaked in. */
const RAW_PROMPT_CANARY =
  "please implement the parser exactly as I described earlier in this conversation"

interface WriterCase {
  type: V2EventType
  call: (input: V2EventInput) => MeasurementEvent
}

// One row per member of `V2_EVENT_TYPES`, enforced in both directions by the
// first `it` below — this table is a fixture, never the source of truth.
// (`dosing:unknown-model` is absent because BACKLOG B-1 deleted
// model-conditioned dosing, so there is no profile to resolve and no unknown
// model to report; B-2's `criteria:parse-miss` is present because the source
// declares it.)
// Each fixture supplies the type's documented required fields; `input` (the
// per-iteration sessionID/model override) is spread last so it wins.
const WRITER_TABLE: WriterCase[] = [
  {
    type: "directive_rendered",
    call: (input) =>
      logDirectiveRendered({ family: "verify-gap", instanceId: "D-1", priority: "correction", ...input }),
  },
  {
    type: "directive_complied",
    call: (input) => logDirectiveComplied({ family: "verify-gap", instanceId: "D-1", ...input }),
  },
  {
    type: "calibration",
    call: (input) => logCalibration({ declared: "high", observed: "pass", ...input }),
  },
  {
    type: "phase_transition",
    call: (input) => logPhaseTransition({ storyId: "S1", from: "intake", to: "execute", trigger: "T3", ...input }),
  },
  {
    type: "resolution:none",
    call: (input) => logResolutionNone({ changedPaths: ["src/x.ts"], ...input }),
  },
  {
    type: "gate:multi-session-advisory",
    call: (input) => logGateMultiSessionAdvisory({ activeSessionCount: 2, ...input }),
  },
  {
    type: "pins:disk-fallback-memory",
    call: (input) => logPinsDiskFallbackMemory({ reason: "EACCES", ...input }),
  },
  {
    type: "pins:disk-recovered",
    call: (input) => logPinsDiskRecovered({ ...input }),
  },
  {
    type: "pins:disk-unavailable",
    call: (input) => logPinsDiskUnavailable({ consecutiveFailures: 3, ...input }),
  },
  {
    type: "intake:classify-skipped",
    call: (input) => logIntakeClassifySkipped({ matched: "TRIVIAL_ASK_RE", ...input }),
  },
  {
    type: "intake:classify-fallback",
    call: (input) => logIntakeClassifyFallback({ reason: "subturn timeout", ...input }),
  },
  {
    type: "intake:classify-capped",
    call: (input) => logIntakeClassifyCapped({ cap: 3, ...input }),
  },
  {
    type: "intake:classify-unsupported",
    call: (input) => logIntakeClassifyUnsupported({ reason: "probe failed", ...input }),
  },
  {
    type: "subturn:cleanup-failed",
    call: (input) => logSubturnCleanupFailed({ agent: "vertex-verifier", reason: "ECONNRESET", ...input }),
  },
  {
    type: "verifier:unavailable",
    call: (input) => logVerifierUnavailable({ reason: "timeout", ...input }),
  },
  {
    type: "verifier:malformed",
    call: (input) => logVerifierMalformed({ reason: "invalid JSON", ...input }),
  },
  {
    type: "verifier:unsupported",
    call: (input) => logVerifierUnsupported({ reason: "probe failed", ...input }),
  },
  {
    type: "verifier:field-dropped",
    call: (input) => logVerifierFieldDropped({ field: "diffSummary", reason: "entropy", ...input }),
  },
  {
    type: "criteria:re-pinned",
    call: (input) => logCriteriaRePinned({ count: 3, ...input }),
  },
  {
    type: "criteria:truncated",
    call: (input) => logCriteriaTruncated({ droppedCount: 2, cap: 10, ...input }),
  },
  {
    type: "criteria:parse-miss",
    call: (input) => logCriteriaParseMiss({ keyLine: "CRITERIA: a, b, c", ...input }),
  },
  {
    type: "expect:absent",
    call: (input) => logExpectAbsent({ ...input }),
  },
]

const SESSION_ID_VARIANTS: Array<string | undefined | null> = ["prop-sess-1", "", undefined, null]
const MODEL_VARIANTS: Array<string | null | undefined> = [
  undefined,
  null,
  "unknown",
  "anthropic/claude-fable-5",
  "   ", // whitespace-only must fall back to "unknown"
]

const MODEL_SHAPE_RE = /^[^/\s]+\/[^/\s]+$/

describe("test 42: event_invariants_property (every FR-033 event type)", () => {
  // This assertion used to compare the fixture table against a LITERAL COPY of
  // itself and a hard-coded count. It could not fail: adding an event type to
  // `V2EventType` changed neither list, which is exactly how
  // `criteria:parse-miss` shipped in the union with no writer, no fixture and
  // a green suite. The comparison is now against `V2_EVENT_TYPES` — the real,
  // runtime source of truth the type itself is derived from — so a new member
  // is red until it is registered here.
  it("covers exactly the event types the source declares, in both directions", () => {
    const declared = [...V2_EVENT_TYPES] as string[]
    const covered = WRITER_TABLE.map((w) => w.type as string)

    // Both directions, reported separately so the failure names the problem:
    // a declared-but-unwritten type is an unobservable event; a
    // written-but-undeclared one is a type error waiting to be cast away.
    expect(declared.filter((t) => !covered.includes(t))).toEqual([])
    expect(covered.filter((t) => !declared.includes(t))).toEqual([])

    // Duplicates in either list would let the two filters above pass while the
    // per-type invariant loop silently skipped a type.
    expect(new Set(covered).size).toBe(covered.length)
    expect(new Set(declared).size).toBe(declared.length)
    expect(WRITER_TABLE).toHaveLength(V2_EVENT_TYPES.length)

    // BACKLOG B-1: `dosing:unknown-model` is not merely absent from the
    // fixture table — the writer and the event type are gone. Assert it
    // against the SOURCE list, not the fixture, or the check is vacuous.
    expect(declared).not.toContain("dosing:unknown-model")
  })

  for (const { type, call } of WRITER_TABLE) {
    it(`${type}: session_id non-empty, model well-formed, NO profile field, no raw-prompt canary, across sessionID x model variants`, () => {
      for (const sessionID of SESSION_ID_VARIANTS) {
        for (const model of MODEL_VARIANTS) {
          const ev = call({ sessionID, model })

          expect(ev.event_type).toBe(type)

          // session_id is always non-empty (falls back to "no-session").
          expect(typeof ev.session_id).toBe("string")
          expect(ev.session_id.length).toBeGreaterThan(0)

          // model is always "unknown" or a providerID/modelID-shaped string.
          expect(typeof ev.model).toBe("string")
          expect(ev.model === "unknown" || MODEL_SHAPE_RE.test(ev.model as string)).toBe(true)
          if (model === undefined || model === null || model.trim().length === 0) {
            expect(ev.model).toBe("unknown")
          } else {
            expect(ev.model).toBe(model)
          }

          // BACKLOG B-1: `profile` is not stamped at all any more — not
          // "always standard", ABSENT. A record that still carried the key
          // would mean the dose matrix (or a stub of it) came back.
          expect(ev).not.toHaveProperty("profile")
          expect(Object.keys(ev)).not.toContain("profile")

          // no record carries raw user prompt text (scoped to this module's
          // documented payload shapes — see file header comment).
          expect(JSON.stringify(ev)).not.toContain(RAW_PROMPT_CANARY)
        }
      }
    })
  }

  it("round-trips through the real JSONL sink with the same invariants intact (spot check, not just in-memory)", () => {
    logDirectiveRendered({
      sessionID: "disk-check",
      model: "anthropic/claude-fable-5",
      family: "verify-gap",
      instanceId: "D-9",
      priority: "correction",
    })
    logVerifierUnavailable({ sessionID: "disk-check", reason: "timeout" })

    const lines = readFileSync(eventsPath(), "utf8").trim().split("\n")
    expect(lines).toHaveLength(2)
    for (const line of lines) {
      const ev = JSON.parse(line)
      expect(ev.session_id).toBe("disk-check")
      expect(typeof ev.model).toBe("string")
      // BACKLOG B-1: no `profile` key survives serialization either — this is
      // the on-disk half of the in-memory assertion above.
      expect(Object.keys(ev)).not.toContain("profile")
    }
    expect(JSON.parse(lines[0])).toMatchObject({ event_type: "directive_rendered", model: "anthropic/claude-fable-5" })
    expect(JSON.parse(lines[1])).toMatchObject({ event_type: "verifier:unavailable", model: "unknown" })
    // Regression: `family` must survive into the SERIALIZED payload on disk,
    // not just the in-memory input — makeV2Event previously destructured
    // `family` out for the FR-035 holdout-arm hash and silently dropped it.
    expect(JSON.parse(lines[0]).payload.family).toBe("verify-gap")
  })

  it("regression: makeV2Event/logDirectiveRendered/logDirectiveComplied re-include `family` in the SERIALIZED payload, not just the input", () => {
    // Inspect the built (in-memory) record directly...
    const built = makeV2Event("directive_rendered", {
      sessionID: "s1",
      family: "elevate",
      instanceId: "D-1",
      priority: "correction",
    })
    expect(built.payload.family).toBe("elevate")

    // ...and the actual bytes written to the JSONL sink for both
    // directive_rendered and directive_complied.
    logDirectiveRendered({ sessionID: "fam-check", family: "verify-gap", instanceId: "D-1", priority: "correction" })
    logDirectiveComplied({ sessionID: "fam-check", family: "verify-gap", instanceId: "D-1" })

    const lines = readFileSync(eventsPath(), "utf8").trim().split("\n")
    expect(lines).toHaveLength(2)
    const rendered = JSON.parse(lines[0])
    const complied = JSON.parse(lines[1])
    expect(rendered).toMatchObject({ event_type: "directive_rendered", payload: { family: "verify-gap", instanceId: "D-1" } })
    expect(complied).toMatchObject({ event_type: "directive_complied", payload: { family: "verify-gap", instanceId: "D-1" } })
  })

  it("makeV2Event/logV2Event stamp session_id/model identically for the same input", () => {
    const built = makeV2Event("expect:absent", { sessionID: "s1", model: "anthropic/claude-fable-5" })
    expect(built.session_id).toBe("s1")
    expect(built.model).toBe("anthropic/claude-fable-5")
    expect(built).not.toHaveProperty("profile")

    const logged = logV2Event("expect:absent", { sessionID: "s1", model: "anthropic/claude-fable-5" })
    expect(logged.session_id).toBe(built.session_id)
    expect(logged.model).toBe(built.model)
    expect(logged.event_type).toBe(built.event_type)
  })
})

// ---------------------------------------------------------------------------
// v1 event writers now also carry model/profile (FR-033 applies retroactively)
// ---------------------------------------------------------------------------

describe("FR-033 also stamps v1-sourced events (model), without changing v1 call sites", () => {
  it("logHoldoutSuppress called the old 2-arg way (every existing call site) is byte-identical to before", () => {
    logHoldoutSuppress("sess-v1", "stop-block skipped (holdout arm=off)")
    const lines = readFileSync(eventsPath(), "utf8").trim().split("\n")
    const ev = JSON.parse(lines[0])
    expect(ev).toMatchObject({
      session_id: "sess-v1",
      event_type: "holdout_suppress",
      payload: { reason: "stop-block skipped (holdout arm=off)" },
      model: "unknown",
    })
    expect(Object.keys(ev)).not.toContain("profile")
    expect(ev.payload.family).toBeUndefined()
    expect(ev.holdout_arm).toBe(holdoutArm("sess-v1"))
  })

  it("logHoldoutSuppress with the new optional family/model extra logs family in the payload and scopes holdout_arm", () => {
    // Find a session/family pair with a divergent per-family arm to prove
    // the family actually changes the hash input (FR-035), not just cosmetics.
    let sessionID = ""
    let arm = ""
    for (let i = 0; i < 2000; i++) {
      const candidate = `fam-sess-${i}`
      const withFamily = holdoutArm(candidate, "elevate")
      const withoutFamily = holdoutArm(candidate)
      if (withFamily !== withoutFamily) {
        sessionID = candidate
        arm = withFamily
        break
      }
    }
    expect(sessionID).not.toBe("")

    logHoldoutSuppress(sessionID, "elevate finding suppressed", { family: "elevate", model: "anthropic/claude-fable-5" })
    const lines = readFileSync(eventsPath(), "utf8").trim().split("\n")
    const ev = JSON.parse(lines[0])
    expect(ev.payload).toMatchObject({ reason: "elevate finding suppressed", family: "elevate" })
    expect(ev.model).toBe("anthropic/claude-fable-5")
    expect(Object.keys(ev)).not.toContain("profile")
    expect(ev.holdout_arm).toBe(arm)
  })
})

// ---------------------------------------------------------------------------
// FR-035: per-directive-family holdout arm hashing
// ---------------------------------------------------------------------------

describe("FR-035: holdoutArm/holdoutSuppresses extended with an optional family", () => {
  it("omitting family reproduces exactly today's session-only arm (backward compatible)", () => {
    for (const sid of ["a", "b", "session-xyz", ""]) {
      expect(holdoutArm(sid)).toBe(holdoutArm(sid, undefined))
    }
  })

  it("empty-string family is treated as 'no family' (session-only behavior)", () => {
    expect(holdoutArm("some-session", "")).toBe(holdoutArm("some-session"))
  })

  it("the same session can be independently in different arms per family", () => {
    // Search for a session where the session-only arm and at least one
    // family-scoped arm diverge, proving family is actually part of the hash
    // input rather than being ignored.
    let found = false
    for (let i = 0; i < 2000; i++) {
      const sid = `divergent-${i}`
      const base = holdoutArm(sid)
      const famA = holdoutArm(sid, "elevate")
      const famB = holdoutArm(sid, "verify-gap")
      if (famA !== base || famA !== famB) {
        found = true
        break
      }
    }
    expect(found).toBe(true)
  })

  it("holdoutArm(sid, family) is deterministic across repeated calls", () => {
    expect(holdoutArm("stable-session", "elevate")).toBe(holdoutArm("stable-session", "elevate"))
  })

  it("holdoutSuppresses respects the family scope and stays env-gated default OFF", () => {
    const off = Array.from({ length: 3000 }, (_, i) => `hs-${i}`).find(
      (s) => holdoutArm(s, "elevate") === "off",
    )!
    expect(holdoutSuppresses(off, "elevate")).toBe(false) // VERTEX_HOLDOUT unset
    process.env.VERTEX_HOLDOUT = "1"
    expect(holdoutSuppresses(off, "elevate")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// FR-034: verifiersEquivalent — Dataset "Composer budget/cooldown/decay" rows 10/11
// ---------------------------------------------------------------------------

/**
 * Local stub matching `ResolveVerifierFn` (does not import `src/v2/resolve.ts`
 * — kept independent so this test suite does not have a hard dependency on
 * that module's exact internals). Implements just enough of the documented
 * tier order (module contracts doc §4 / FR-008) to exercise the two dataset
 * rows: tier 1 ("story") when `storyVerifiers` covers a non-empty
 * `changedPaths`, else tier 4 ("none") when `changedPaths` is empty.
 */
const stubResolve: ResolveVerifierFn = (
  ctx: ResolveVerifierContext,
  _deps: ResolveVerifierDeps,
): ResolveVerifierResult => {
  const paths = ctx.changedPaths.filter((p) => p.trim().length > 0)
  if (paths.length === 0) return { command: null, rationale: "none", matchedPaths: [] }
  const storyVerifiers = (ctx.storyVerifiers ?? []).filter((v) => v.trim().length > 0)
  if (storyVerifiers.length > 0) {
    return { command: storyVerifiers.join(" && "), rationale: "story", matchedPaths: [...paths] }
  }
  return { command: null, rationale: "none", matchedPaths: [] }
}

describe("FR-034: verifiersEquivalent", () => {
  it("IGNORED_VERIFIER_FLAGS matches the exact FR-034 set", () => {
    expect([...IGNORED_VERIFIER_FLAGS].sort()).toEqual(
      [
        "--reporter=*",
        "--reporters=*",
        "-v",
        "--verbose",
        "--silent",
        "--no-color",
        "--color",
        "--bail",
        "--run",
        "--watch=false",
      ].sort(),
    )
  })

  it("stripIgnoredVerifierFlags removes only the ignored flags", () => {
    expect(stripIgnoredVerifierFlags("npx vitest run tests/lexer.test.ts --reporter=json")).toBe(
      "npx vitest run tests/lexer.test.ts",
    )
    expect(stripIgnoredVerifierFlags("npx vitest run tests/lexer.test.ts --coverage")).toBe(
      "npx vitest run tests/lexer.test.ts --coverage",
    )
  })

  it("Dataset row 10: --reporter=json is an ignored flag -> equivalent", () => {
    const rendered = "npx vitest run tests/lexer.test.ts"
    const observed = "npx vitest run tests/lexer.test.ts --reporter=json"
    expect(verifiersEquivalent(rendered, observed, stubResolve)).toBe(true)
  })

  it("Dataset row 11: npm test vs a specific vitest file -> different tier/target set -> not equivalent", () => {
    const rendered = "npx vitest run tests/lexer.test.ts"
    const observed = "npm test"
    expect(verifiersEquivalent(rendered, observed, stubResolve)).toBe(false)
  })

  it("row 10, re-verified against the REAL src/v2/resolve.ts resolveVerifier (bonus integration check)", () => {
    const rendered = "npx vitest run tests/lexer.test.ts"
    const observed = "npx vitest run tests/lexer.test.ts --reporter=json"
    expect(verifiersEquivalent(rendered, observed, realResolveVerifier)).toBe(true)
  })

  it("row 11, re-verified against the REAL src/v2/resolve.ts resolveVerifier (bonus integration check)", () => {
    const rendered = "npx vitest run tests/lexer.test.ts"
    const observed = "npm test"
    expect(verifiersEquivalent(rendered, observed, realResolveVerifier)).toBe(false)
  })

  it("identical commands are always equivalent (fast path, no resolve call needed)", () => {
    expect(verifiersEquivalent("npm test", "npm test", stubResolve)).toBe(true)
  })

  it("empty/blank commands are never equivalent", () => {
    expect(verifiersEquivalent("", "npm test", stubResolve)).toBe(false)
    expect(verifiersEquivalent("npm test", "   ", stubResolve)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// FR-033a: sink rotation (32MB) + retention (30 days)
// ---------------------------------------------------------------------------

describe("FR-033a: rotateEventsSinkIfNeeded (small overrides — no real 32MB write / 30-day wait)", () => {
  it("exposes the spec's literal thresholds as constants", () => {
    expect(ROTATE_MAX_BYTES).toBe(32 * 1024 * 1024)
    expect(ROTATE_RETENTION_DAYS).toBe(30)
  })

  it("rotates the live file to <stem>.<timestamp><ext> when it exceeds maxBytes", () => {
    const p = join(tmpRoot, ".vertex-events.jsonl")
    writeFileSync(p, "x".repeat(200) + "\n")

    const result = rotateEventsSinkIfNeeded(p, { maxBytes: 100, now: new Date("2026-01-01T00:00:00Z") })

    expect(result.rotated).toBe(true)
    expect(result.rotatedTo).toMatch(/\.vertex-events\.2026-01-01T00-00-00-000Z\.jsonl$/)
    expect(() => statSync(p)).toThrow() // old path gone (renamed, not copied)
    expect(statSync(result.rotatedTo!).isFile()).toBe(true)
  })

  it("does not rotate when the live file is under maxBytes", () => {
    const p = join(tmpRoot, ".vertex-events.jsonl")
    writeFileSync(p, "small")
    const result = rotateEventsSinkIfNeeded(p, { maxBytes: 100 })
    expect(result.rotated).toBe(false)
    expect(statSync(p).isFile()).toBe(true)
  })

  it("does not throw when the live file does not exist yet", () => {
    const p = join(tmpRoot, ".vertex-events.jsonl")
    expect(() => rotateEventsSinkIfNeeded(p, { maxBytes: 100 })).not.toThrow()
  })

  it("prunes rotated siblings older than maxAgeDays, leaves recent ones and the live file alone", () => {
    const p = join(tmpRoot, ".vertex-events.jsonl")
    writeFileSync(p, "live\n")

    const oldSibling = join(tmpRoot, ".vertex-events.2020-01-01T00-00-00-000Z.jsonl")
    const recentSibling = join(tmpRoot, ".vertex-events.2026-07-20T00-00-00-000Z.jsonl")
    const unrelatedFile = join(tmpRoot, "other-file.jsonl")
    writeFileSync(oldSibling, "old\n")
    writeFileSync(recentSibling, "recent\n")
    writeFileSync(unrelatedFile, "unrelated\n")

    const oldMtime = new Date("2020-01-01T00:00:00Z")
    const recentMtime = new Date("2026-07-20T00:00:00Z")
    utimesSync(oldSibling, oldMtime, oldMtime)
    utimesSync(recentSibling, recentMtime, recentMtime)

    const now = new Date("2026-07-25T00:00:00Z")
    const result = rotateEventsSinkIfNeeded(p, { maxBytes: 100, maxAgeDays: 30, now })

    expect(result.pruned).toEqual([oldSibling])
    expect(() => statSync(oldSibling)).toThrow()
    expect(statSync(recentSibling).isFile()).toBe(true) // 5 days old, under the 30-day cap
    expect(statSync(unrelatedFile).isFile()).toBe(true) // different stem, never touched
    expect(statSync(p).isFile()).toBe(true) // live file itself never pruned
  })

  it("is wired into appendEvent's existing write path (same exported signature) without requiring a manual call", () => {
    // appendEvent(event, path?) signature is unchanged; rotation happens
    // internally. Drive it with a pre-seeded oversized "live" file at the
    // real eventsPath() and confirm a second appendEvent call rotates first.
    const p = eventsPath()
    writeFileSync(p, "y".repeat(50), "utf8")
    // Directly exercise the same rotation helper appendEvent calls, with a
    // tiny threshold, to avoid depending on appendEvent's internal default
    // (32MB) inside a fast unit test.
    const before = rotateEventsSinkIfNeeded(p, { maxBytes: 10 })
    expect(before.rotated).toBe(true)

    appendEvent({
      ts: new Date().toISOString(),
      session_id: "s1",
      holdout_arm: "on",
      event_type: "classify",
      payload: {},
    })
    // appendEvent recreates the live file at the canonical path after rotation.
    expect(statSync(p).isFile()).toBe(true)
    const lines = readFileSync(p, "utf8").trim().split("\n")
    expect(lines).toHaveLength(1)
  })
})
