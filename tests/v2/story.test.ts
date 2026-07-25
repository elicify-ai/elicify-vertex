import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import {
  IMPERATIVE_VERBS,
  SEQUENCING_WORDS,
  StoryEngine,
  TRIVIAL_ASK_RE,
  classifyMultiStory,
  classifyMultiStoryHeuristic,
  type PlanV2,
} from "../../src/v2/story.js"
import { SelfCreatedSessions } from "../../src/v2/subturn.js"
import type { OpencodeClient } from "../../src/v2/types.js"

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const roots: string[] = []

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "vertex-story-"))
  roots.push(root)
  return root
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function engine(stateDir: string, logger = vi.fn()): { engine: StoryEngine; logger: ReturnType<typeof vi.fn> } {
  return { engine: new StoryEngine({ stateDir, logger }), logger }
}

/** Minimal confirmed-story input builder for `createPlan`. */
function story(
  overrides: Partial<{ text: string; acceptanceItems: string[]; scopeGlobs: string[]; verifiers: string[] }> = {},
) {
  return {
    text: "do the thing",
    acceptanceItems: ["it works"],
    scopeGlobs: [] as string[],
    verifiers: [] as string[],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Test 13: story_v1_archival (FR-022)
// ---------------------------------------------------------------------------

describe("story_v1_archival (test 13, FR-022)", () => {
  it("archives a schemaVersion:1 goals.json byte-identically via atomic rename, never deleted", () => {
    const stateDir = temporaryRoot()
    mkdirSync(stateDir, { recursive: true })
    const goalsPath = join(stateDir, "goals.json")
    const originalBytes = Buffer.from(
      `${JSON.stringify({ schemaVersion: 1, revision: 1, brief: "legacy plan", stories: [] }, null, 2)}\n`,
    )
    writeFileSync(goalsPath, originalBytes)

    const { engine: se } = engine(stateDir)
    const archived = se.archiveV1IfPresent()

    expect(archived).toBe(true)
    expect(existsSync(goalsPath)).toBe(false)
    const archiveDir = join(stateDir, "archive")
    const files = readdirSync(archiveDir)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^goals\..*\.json$/)
    const archivedBytes = readFileSync(join(archiveDir, files[0]))
    expect(archivedBytes.equals(originalBytes)).toBe(true)
  })

  it("is a no-op (returns false) when no goals.json is present", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    expect(se.archiveV1IfPresent()).toBe(false)
  })

  it("does not archive a schemaVersion:2+ goals.json", () => {
    const stateDir = temporaryRoot()
    mkdirSync(stateDir, { recursive: true })
    const goalsPath = join(stateDir, "goals.json")
    writeFileSync(goalsPath, JSON.stringify({ schemaVersion: 2, stories: [] }))

    const { engine: se } = engine(stateDir)
    expect(se.archiveV1IfPresent()).toBe(false)
    expect(existsSync(goalsPath)).toBe(true)
  })

  it("archives a corrupt/unparseable goals.json (schemaVersion cannot be proven non-v1)", () => {
    const stateDir = temporaryRoot()
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, "goals.json"), "{ not valid json ")

    const { engine: se } = engine(stateDir)
    expect(se.archiveV1IfPresent()).toBe(true)
  })

  it("never deletes or overwrites an existing file under archive/ on a later archival", () => {
    const stateDir = temporaryRoot()
    mkdirSync(stateDir, { recursive: true })
    const archiveDir = join(stateDir, "archive")
    mkdirSync(archiveDir, { recursive: true })
    writeFileSync(join(archiveDir, "goals.2020-01-01T00-00-00-000Z.json"), "old archived content")

    writeFileSync(join(stateDir, "goals.json"), JSON.stringify({ schemaVersion: 1, stories: [] }))
    const { engine: se } = engine(stateDir)
    se.archiveV1IfPresent()

    const files = readdirSync(archiveDir)
    expect(files).toContain("goals.2020-01-01T00-00-00-000Z.json")
    expect(readFileSync(join(archiveDir, "goals.2020-01-01T00-00-00-000Z.json"), "utf8")).toBe("old archived content")
    expect(files.length).toBeGreaterThanOrEqual(2)
  })

  it("is idempotent — a second call after archival is a no-op", () => {
    const stateDir = temporaryRoot()
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, "goals.json"), JSON.stringify({ schemaVersion: 1, stories: [] }))
    const { engine: se } = engine(stateDir)

    expect(se.archiveV1IfPresent()).toBe(true)
    expect(se.archiveV1IfPresent()).toBe(false)
  })

  it("runs automatically as a side effect of createPlan/checkpoint/checkScope ('any story tool runs')", () => {
    const stateDir = temporaryRoot()
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, "goals.json"), JSON.stringify({ schemaVersion: 1, stories: [] }))
    const { engine: se } = engine(stateDir)

    se.createPlan("s1", [story()])

    expect(existsSync(join(stateDir, "goals.json"))).toBe(false)
    expect(readdirSync(join(stateDir, "archive"))).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Test 12: story_schema_v2_validation — plan creation, schema, getters
// ---------------------------------------------------------------------------

describe("story_schema_v2_validation (test 12, FR-017)", () => {
  it("createPlan builds a schemaVersion:2 plan with the first story active and the rest pending", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)

    const plan = se.createPlan("s1", [
      story({ text: "parser", acceptanceItems: ["handles nesting"], scopeGlobs: ["src/parser/**"] }),
      story({ text: "cli", acceptanceItems: ["wires the flag"] }),
    ])

    expect(plan.schemaVersion).toBe(2)
    expect(plan.stories).toHaveLength(2)
    expect(plan.stories[0].status).toBe("active")
    expect(plan.stories[1].status).toBe("pending")
    expect(plan.finalStoryId).toBe(plan.stories[1].id)
    expect(plan.stories[0].acceptanceItems[0].evidence).toBeNull()
    expect(typeof plan.createdAt).toBe("string")
  })

  it("rejects an empty story list", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    expect(() => se.createPlan("s1", [])).toThrow(/at least one story/)
  })

  it("persists to disk and survives a simulated restart (fresh StoryEngine instance)", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    const created = se.createPlan("s1", [story({ text: "only story" })])

    const restarted = new StoryEngine({ stateDir, logger: vi.fn() })
    expect(restarted.getPlan("s1")).toEqual(created)
    expect(restarted.getActiveStory("s1")?.id).toBe(created.stories[0].id)
  })

  it("getPlan/getActiveStory return null for an unknown session, never throw", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    expect(se.getPlan("unknown")).toBeNull()
    expect(se.getActiveStory("unknown")).toBeNull()
  })

  it("ignores a corrupt on-disk plan.json rather than crashing (validated on read)", () => {
    const stateDir = temporaryRoot()
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, "plan.json"), JSON.stringify({ s1: { schemaVersion: 2, stories: "not an array" } }))

    const { engine: se } = engine(stateDir)
    expect(se.getPlan("s1")).toBeNull()
  })

  it("attachEvidence updates the matching item and persists; unknown ids are no-ops", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    const plan = se.createPlan("s1", [story({ acceptanceItems: ["a", "b"] })])
    const storyId = plan.stories[0].id

    se.attachEvidence("s1", storyId, "A1", { receiptId: "vrf_1" })
    expect(se.getPlan("s1")!.stories[0].acceptanceItems[0].evidence).toEqual({ receiptId: "vrf_1" })

    expect(() => se.attachEvidence("unknown-session", storyId, "A1", { receiptId: "x" })).not.toThrow()
    expect(() => se.attachEvidence("s1", "unknown-story", "A1", { receiptId: "x" })).not.toThrow()
    expect(() => se.attachEvidence("s1", storyId, "unknown-item", { receiptId: "x" })).not.toThrow()

    // Survives restart — proves the attachEvidence write was actually persisted.
    const restarted = new StoryEngine({ stateDir, logger: vi.fn() })
    expect(restarted.getPlan("s1")!.stories[0].acceptanceItems[0].evidence).toEqual({ receiptId: "vrf_1" })
  })

  it("amendStory appends a timestamped reason and can update scopeGlobs", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    const plan = se.createPlan("s1", [story({ scopeGlobs: ["src/parser/**"] })])
    const storyId = plan.stories[0].id

    se.amendStory("s1", storyId, { reason: "branch switched, globs stale", scopeGlobs: ["src/**"] })

    const after = se.getPlan("s1")!.stories[0]
    expect(after.amendments).toHaveLength(1)
    expect(after.amendments[0].reason).toBe("branch switched, globs stale")
    expect(typeof after.amendments[0].ts).toBe("string")
    expect(after.scopeGlobs).toEqual(["src/**"])
  })

  it("amendStory throws on an unknown story", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    se.createPlan("s1", [story()])
    expect(() => se.amendStory("s1", "S99", { reason: "x" })).toThrow(/unknown story/)
  })
})

// ---------------------------------------------------------------------------
// CRITICAL fix: a corrupt plan.json must not silently destroy other
// sessions' data on the next write (persistPlan).
// ---------------------------------------------------------------------------

describe("story_disk_corrupt_on_write (CRITICAL fix, persistPlan)", () => {
  it("(a) a genuinely corrupt (unparseable) plan.json aborts the write, logs story:disk-corrupt, and leaves the file untouched", () => {
    const stateDir = temporaryRoot()
    mkdirSync(stateDir, { recursive: true })
    const planPath = join(stateDir, "plan.json")
    const corruptBytes = '{ "session-other": { "schemaVersion": 2, not valid json at all'
    writeFileSync(planPath, corruptBytes)
    const logger = vi.fn()
    const { engine: se } = engine(stateDir, logger)

    // createPlan() -> persistPlan(): must NOT silently proceed from an empty
    // base and overwrite session-other's (unreadable) plan with only s1's.
    expect(() => se.createPlan("s1", [story()])).toThrow(/corrupt/i)

    expect(readFileSync(planPath, "utf8")).toBe(corruptBytes) // byte-for-byte untouched
    expect(logger).toHaveBeenCalledWith(
      "story:disk-corrupt",
      expect.objectContaining({ sessionID: "s1", path: planPath }),
    )
  })

  it("(a) the same abort applies to checkpoint()'s persistPlan call, not just createPlan()'s", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    const plan = se.createPlan("s1", [story({ acceptanceItems: ["A1"] })])
    const storyId = plan.stories[0].id
    se.attachEvidence("s1", storyId, "A1", { receiptId: "vrf_1" })
    const planPath = join(stateDir, "plan.json")

    // Corrupt the file out from under the engine (simulating another
    // process/session's write gone bad) and confirm checkpoint() fails
    // loudly rather than clobbering it. `se` already holds s1 in memory
    // from createPlan/attachEvidence above; persistPlan always re-reads the
    // ON-DISK file fresh before writing, regardless of what's cached.
    const corruptBytes = "{ this is not json "
    writeFileSync(planPath, corruptBytes)

    expect(() => se.checkpoint("s1", storyId, "complete", { isValidReceipt: () => true })).toThrow(/corrupt/i)
    expect(readFileSync(planPath, "utf8")).toBe(corruptBytes) // still untouched
  })

  it("(b) a schema-invalid-but-parseable plan.json still degrades gracefully (no regression): invalid entries are dropped, the write proceeds", () => {
    const stateDir = temporaryRoot()
    mkdirSync(stateDir, { recursive: true })
    const planPath = join(stateDir, "plan.json")
    // Valid JSON, but "session-other"'s value fails isPlanV2 (stories is not an array).
    writeFileSync(planPath, JSON.stringify({ "session-other": { schemaVersion: 2, stories: "not an array" } }))
    const logger = vi.fn()
    const { engine: se } = engine(stateDir, logger)

    expect(() => se.createPlan("s1", [story()])).not.toThrow()

    expect(logger).not.toHaveBeenCalledWith("story:disk-corrupt", expect.anything())
    const onDisk = JSON.parse(readFileSync(planPath, "utf8")) as Record<string, unknown>
    expect(onDisk.s1).toBeDefined()
    // The pre-existing schema-invalid entry is dropped (per-key filtering,
    // unchanged behavior) rather than blocking this session's write.
    expect(onDisk["session-other"]).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// MINOR fix: checkpoint(complete) must require storyId to be the plan's
// current active story, or successor-promotion can silently strand the plan.
// ---------------------------------------------------------------------------

describe("story_checkpoint_requires_active_story (MINOR fix)", () => {
  it("throws, naming both the requested and the actual active story id, when completing a non-active (pending) story directly", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    const plan = se.createPlan("s1", [
      story({ text: "story one", acceptanceItems: ["A1"] }),
      story({ text: "story two", acceptanceItems: ["A1"] }),
    ])
    const firstId = plan.stories[0].id // active
    const secondId = plan.stories[1].id // pending — not the active story
    se.attachEvidence("s1", secondId, "A1", { receiptId: "vrf_1" })

    expect(() => se.checkpoint("s1", secondId, "complete", { isValidReceipt: () => true })).toThrow(
      new RegExp(secondId),
    )
    expect(() => se.checkpoint("s1", secondId, "complete", { isValidReceipt: () => true })).toThrow(
      new RegExp(firstId),
    )

    // Nothing changed: first story is still active, second still pending —
    // the plan was NOT silently stranded.
    const after = se.getPlan("s1")!
    expect(after.stories[0].status).toBe("active")
    expect(after.stories[1].status).toBe("pending")
  })

  it("still allows completing the actual active story (no false-positive rejection)", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    const plan = se.createPlan("s1", [story({ acceptanceItems: ["A1"] })])
    const storyId = plan.stories[0].id
    se.attachEvidence("s1", storyId, "A1", { receiptId: "vrf_1" })

    expect(() => se.checkpoint("s1", storyId, "complete", { isValidReceipt: () => true })).not.toThrow()
    expect(se.getPlan("s1")!.stories[0].status).toBe("complete")
  })

  it("does not gate 'failed'/'blocked' transitions on being the active story (only 'complete' is checked)", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    const plan = se.createPlan("s1", [
      story({ text: "story one", acceptanceItems: ["A1"] }),
      story({ text: "story two", acceptanceItems: ["A1"] }),
    ])
    const secondId = plan.stories[1].id // pending, not active

    expect(() => se.checkpoint("s1", secondId, "blocked", {})).not.toThrow()
    expect(se.getPlan("s1")!.stories[1].status).toBe("blocked")
  })
})

// ---------------------------------------------------------------------------
// MAJOR fix (supporting wiring/tools.ts's FR-020 time-valid-receipt check):
// StoryV2.startedAt is set on activation and survives persist/load.
// ---------------------------------------------------------------------------

describe("story_started_at (MAJOR fix, wave-4 cross-file dependency)", () => {
  it("is set to an ISO-8601 timestamp on the first story when the plan is created; pending stories have none yet", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    const before = Date.now()
    const plan = se.createPlan("s1", [story(), story()])
    const after = Date.now()

    expect(plan.stories[0].status).toBe("active")
    expect(typeof plan.stories[0].startedAt).toBe("string")
    const startedMs = Date.parse(plan.stories[0].startedAt!)
    expect(startedMs).toBeGreaterThanOrEqual(before)
    expect(startedMs).toBeLessThanOrEqual(after)

    expect(plan.stories[1].status).toBe("pending")
    expect(plan.stories[1].startedAt).toBeUndefined()
  })

  it("is set on the successor story when checkpoint's successor-promotion activates it", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    const plan = se.createPlan("s1", [story({ acceptanceItems: ["A1"] }), story({ acceptanceItems: ["A1"] })])
    const firstId = plan.stories[0].id
    se.attachEvidence("s1", firstId, "A1", { receiptId: "vrf_1" })

    expect(se.getPlan("s1")!.stories[1].startedAt).toBeUndefined()
    se.checkpoint("s1", firstId, "complete", { isValidReceipt: () => true })

    const after = se.getPlan("s1")!
    expect(after.stories[1].status).toBe("active")
    expect(typeof after.stories[1].startedAt).toBe("string")
  })

  it("survives a persist/load round-trip (fresh StoryEngine instance)", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    const plan = se.createPlan("s1", [story()])
    const startedAt = plan.stories[0].startedAt
    expect(typeof startedAt).toBe("string")

    const restarted = new StoryEngine({ stateDir, logger: vi.fn() })
    expect(restarted.getPlan("s1")!.stories[0].startedAt).toBe(startedAt)
  })

  it("a plan.json written before this field existed (no startedAt key at all) still validates on load — treated as unknown, not an error", () => {
    const stateDir = temporaryRoot()
    mkdirSync(stateDir, { recursive: true })
    const legacyPlan = {
      schemaVersion: 2,
      stories: [
        {
          id: "S1",
          text: "legacy story",
          acceptanceItems: [],
          scopeGlobs: [],
          verifiers: [],
          assumptions: [],
          rejectedAlternatives: [],
          amendments: [],
          status: "active",
          // no startedAt field at all — pre-dates the field's existence
        },
      ],
      finalStoryId: "S1",
      createdAt: new Date().toISOString(),
    }
    writeFileSync(join(stateDir, "plan.json"), JSON.stringify({ s1: legacyPlan }))

    const { engine: se } = engine(stateDir)
    const plan = se.getPlan("s1")

    expect(plan).not.toBeNull()
    expect(plan!.stories[0].startedAt).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Test 14: story_scope_watchdog_globs (FR-021)
// ---------------------------------------------------------------------------

describe("story_scope_watchdog_globs (test 14, FR-021)", () => {
  it("returns null for a mutation inside scope", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    se.createPlan("s1", [story({ scopeGlobs: ["src/parser/**"] })])

    expect(se.checkScope("s1", "src/parser/lexer.ts")).toBeNull()
  })

  it("returns a scope-watchdog finding offering fold-first for an ordinary out-of-scope mutation", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    se.createPlan("s1", [story({ scopeGlobs: ["src/parser/**"] })])

    const finding = se.checkScope("s1", "src/cli.ts")
    expect(finding).toEqual({ family: "scope-watchdog", offer: "fold", scopeGlobsMatchedZero: false })
  })

  it("returns null when the active story declares no scope constraint (empty scopeGlobs)", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    se.createPlan("s1", [story({ scopeGlobs: [] })])
    expect(se.checkScope("s1", "anything.ts")).toBeNull()
  })

  it("returns null when there is no active story", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    expect(se.checkScope("no-plan-session", "src/cli.ts")).toBeNull()
  })

  it("offers amend first when the caller reports the scope globs match zero files in the worktree (branch-switch/typo edge case)", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    se.createPlan("s1", [story({ scopeGlobs: ["src/parsr/**"] })]) // typo'd glob

    const finding = se.checkScope("s1", "src/cli.ts", { scopeGlobsMatchedZero: true })
    expect(finding).toEqual({ family: "scope-watchdog", offer: "amend", scopeGlobsMatchedZero: true })
  })
})

// ---------------------------------------------------------------------------
// Test 12/15 + Dataset: Checkpoint evidence validation (6 rows)
// ---------------------------------------------------------------------------

describe("checkpoint evidence validation — Dataset (6 rows) + test 12/15", () => {
  function planWithTwoStories(se: StoryEngine): PlanV2 {
    return se.createPlan("s1", [
      story({ text: "story one", acceptanceItems: ["A1", "A2"] }),
      story({ text: "final story", acceptanceItems: ["A1"] }),
    ])
  }

  it("row 1: both items receipted on the FINAL story, isValidReceipt true -> accepted, status complete", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    const plan = se.createPlan("s1", [story({ acceptanceItems: ["A1", "A2"] })]) // single story == final story
    const storyId = plan.stories[0].id
    se.attachEvidence("s1", storyId, "A1", { receiptId: "vrf_1" })
    se.attachEvidence("s1", storyId, "A2", { receiptId: "vrf_2" })

    expect(() =>
      se.checkpoint("s1", storyId, "complete", { isValidReceipt: (id) => id === "vrf_1" || id === "vrf_2" }),
    ).not.toThrow()
    expect(se.getPlan("s1")!.stories[0].status).toBe("complete")
  })

  it("row 2: A1 receipted, A2 has no evidence -> throws naming A2, plan file unchanged", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    const plan = se.createPlan("s1", [story({ acceptanceItems: ["A1", "A2"] })])
    const storyId = plan.stories[0].id
    se.attachEvidence("s1", storyId, "A1", { receiptId: "vrf_1" })
    const beforeBytes = readFileSync(join(stateDir, "plan.json"))

    // isValidReceipt returns true for A1's receipt so A1 passes structurally
    // (this single-story plan is also the final story) — isolating the
    // failure to A2's missing evidence, per the dataset row's intent.
    expect(() => se.checkpoint("s1", storyId, "complete", { isValidReceipt: () => true })).toThrow(/A2/)
    expect(se.getPlan("s1")!.stories[0].status).toBe("active") // unchanged
    expect(readFileSync(join(stateDir, "plan.json")).equals(beforeBytes)).toBe(true)
  })

  it("row 3: explicit user waiver recorded -> accepted", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    const plan = se.createPlan("s1", [story({ acceptanceItems: ["A1"] })])
    const storyId = plan.stories[0].id
    se.attachEvidence("s1", storyId, "A1", { waiver: true, sourceMessageId: "msg_user_42" })

    expect(() => se.checkpoint("s1", storyId, "complete", {})).not.toThrow()
    expect(se.getPlan("s1")!.stories[0].status).toBe("complete")
  })

  it("row 4: an invented receipt id on the FINAL story throws 'not observed' (v1 rule kept)", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    const plan = se.createPlan("s1", [story({ acceptanceItems: ["A1"] })]) // single story == final
    const storyId = plan.stories[0].id
    se.attachEvidence("s1", storyId, "A1", { receiptId: "vrf_invented" })

    expect(() => se.checkpoint("s1", storyId, "complete", { isValidReceipt: () => false })).toThrow(
      /not an observed receipt/,
    )
    // Also throws when no isValidReceipt is supplied at all for the final story — cannot prove "observed".
    expect(() => se.checkpoint("s1", storyId, "complete", {})).toThrow(/not an observed receipt/)
  })

  it("row 5: no evidence at all, status=blocked -> accepted (evidence not required for a non-complete terminal status)", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    const plan = se.createPlan("s1", [story({ acceptanceItems: ["A1", "A2"] })])
    const storyId = plan.stories[0].id

    expect(() => se.checkpoint("s1", storyId, "blocked", {})).not.toThrow()
    expect(se.getPlan("s1")!.stories[0].status).toBe("blocked")
  })

  it("row 6: a model-issued waiver (never attached because wiring refused it) is rejected — item still has no evidence", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    const plan = se.createPlan("s1", [story({ acceptanceItems: ["A1"] })])
    const storyId = plan.stories[0].id

    // Simulates correct wiring behavior: the model tried to author its own waiver
    // inside a tool call's arguments (not a real chat message), wiring's
    // provenance check refuses to call attachEvidence at all, so evidence stays
    // null and checkpoint rejects it via the ordinary "no evidence" path — this
    // module never sees the model's fabricated waiver object.
    expect(() => se.checkpoint("s1", storyId, "complete", {})).toThrow(/A1/)
  })

  it("row 6b: story.ts's own structural floor rejects a malformed waiver even if a caller bypasses TypeScript and attaches one directly", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    const plan = se.createPlan("s1", [story({ acceptanceItems: ["A1"] })])
    const storyId = plan.stories[0].id
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    se.attachEvidence("s1", storyId, "A1", { waiver: true, sourceMessageId: "" } as any)

    expect(() => se.checkpoint("s1", storyId, "complete", {})).toThrow(/malformed waiver/)
  })

  it("non-final story: a receipted item is accepted with no isValidReceipt supplied (FR-019 only requires 'evidence exists', not 'observed')", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    const plan = planWithTwoStories(se)
    const firstId = plan.stories[0].id
    se.attachEvidence("s1", firstId, "A1", { receiptId: "vrf_unverified" })
    se.attachEvidence("s1", firstId, "A2", { receiptId: "vrf_unverified_2" })

    expect(() => se.checkpoint("s1", firstId, "complete", {})).not.toThrow()
    // Completing the (non-final) first story promotes the second to active.
    const after = se.getPlan("s1")!
    expect(after.stories[0].status).toBe("complete")
    expect(after.stories[1].status).toBe("active")
  })

  it("unknown story id throws", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    se.createPlan("s1", [story()])
    expect(() => se.checkpoint("s1", "S99", "complete", {})).toThrow(/unknown story/)
  })

  it("no plan for the session throws", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    expect(() => se.checkpoint("no-plan", "S1", "complete", {})).toThrow(/no story plan/)
  })
})

// ---------------------------------------------------------------------------
// Regex constants — literal spec examples (self-check before dataset use)
// ---------------------------------------------------------------------------

describe("TRIVIAL_ASK_RE / SEQUENCING_WORDS / IMPERATIVE_VERBS — literal spec examples", () => {
  it("TRIVIAL_ASK_RE matches the spec's trivial-ask examples", () => {
    expect(TRIVIAL_ASK_RE.test("fix typo in readme")).toBe(true)
    expect(TRIVIAL_ASK_RE.test("rename fooBar to foo_bar")).toBe(true)
    expect(TRIVIAL_ASK_RE.test("where is the lexer defined?")).toBe(true)
    expect(TRIVIAL_ASK_RE.test("bump lodash to 4.17.21")).toBe(true)
    expect(TRIVIAL_ASK_RE.test("show me the config file")).toBe(true)
  })

  it("TRIVIAL_ASK_RE does NOT match non-trivial asks", () => {
    expect(TRIVIAL_ASK_RE.test("refactor auth end-to-end")).toBe(false)
    expect(TRIVIAL_ASK_RE.test("add caching and fix the flaky test")).toBe(false)
    expect(TRIVIAL_ASK_RE.test("first add the parser, then wire the CLI")).toBe(false)
  })

  it("SEQUENCING_WORDS matches English and Korean sequencing markers, word-boundary and case-insensitive", () => {
    expect(SEQUENCING_WORDS.test("first add the parser, then wire the CLI")).toBe(true)
    expect(SEQUENCING_WORDS.test("FIRST do this")).toBe(true)
    expect(SEQUENCING_WORDS.test("먼저 파서를 추가하고 그다음 CLI를 연결해줘")).toBe(true)
    expect(SEQUENCING_WORDS.test("a firstclass citizen")).toBe(false) // word-boundary: "first" inside "firstclass" doesn't count
  })

  it("IMPERATIVE_VERBS matches an imperative-led clause at the start only", () => {
    expect(IMPERATIVE_VERBS.test("add the parser")).toBe(true)
    expect(IMPERATIVE_VERBS.test("추가 파서")).toBe(true)
    expect(IMPERATIVE_VERBS.test("the parser needs adding")).toBe(false) // not clause-initial
  })
})

describe("classifyMultiStoryHeuristic", () => {
  it("row 7: a sequencing word alone is sufficient", () => {
    expect(classifyMultiStoryHeuristic("first add the parser, then wire the CLI")).toBe(true)
  })

  it("row 8: Korean sequencing words are recognized", () => {
    expect(classifyMultiStoryHeuristic("먼저 파서를 추가하고 그다음 CLI를 연결해줘")).toBe(true)
  })

  it("row 9: a sequencing word inside a fenced code block does not count (fence-aware)", () => {
    const fenced = ["do a single thing with this snippet:", "```", "if (x) { then(); }", "```"].join("\n")
    expect(classifyMultiStoryHeuristic(fenced)).toBe(false)
  })

  it("row 5/6-style: >=2 imperative-led clauses joined by a bare 'and' are counted as multi-story", () => {
    expect(classifyMultiStoryHeuristic("add caching and fix the flaky test")).toBe(true)
    expect(classifyMultiStoryHeuristic("migrate the DB and update the client")).toBe(true)
  })

  it("a single imperative clause is not multi-story", () => {
    expect(classifyMultiStoryHeuristic("refactor auth end-to-end")).toBe(false)
  })

  it("rambling non-imperative prose is not multi-story", () => {
    expect(
      classifyMultiStoryHeuristic(
        "I was wondering whether the lexer handles nested comments correctly in every edge case we might hit",
      ),
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Test 38 + Dataset: Intake pre-filter and classification heuristics (14 rows)
// ---------------------------------------------------------------------------

interface StubAgent {
  name: string
  mode: string
  permission: { edit: string; bash: Record<string, string>; webfetch: string }
  tools: Record<string, boolean>
  options: Record<string, unknown>
}

function supportedIntakeAgent(): StubAgent {
  return {
    name: "vertex-intake",
    mode: "subagent",
    permission: { edit: "deny", bash: { "*": "deny" }, webfetch: "deny" },
    tools: { bash: false, edit: false, webfetch: false },
    options: {},
  }
}

function makeIntakeClient(
  opts: {
    supported?: boolean
    promptImpl?: (args: unknown) => Promise<unknown>
  } = {},
) {
  const supported = opts.supported ?? true
  const agents = supported ? [supportedIntakeAgent()] : []
  const agentsFn = vi.fn(async () => ({ data: agents, error: undefined }))
  const toolIdsFn = vi.fn(async () => ({ data: ["bash", "edit", "webfetch"], error: undefined }))
  const createFn = vi.fn(async () => ({ data: { id: "intake-child-1" }, error: undefined }))
  const promptFn = vi.fn(
    opts.promptImpl ??
      (async (_args: unknown) => ({
        data: { parts: [{ type: "text", text: '{"multiStory":true}' }] },
        error: undefined,
      })),
  )
  const deleteFn = vi.fn(async () => ({ data: {}, error: undefined }))

  const client = {
    app: { agents: agentsFn },
    tool: { ids: toolIdsFn },
    session: { create: createFn, prompt: promptFn, delete: deleteFn },
  }
  return client as unknown as OpencodeClient & {
    app: { agents: typeof agentsFn }
    tool: { ids: typeof toolIdsFn }
    session: { create: typeof createFn; prompt: typeof promptFn; delete: typeof deleteFn }
  }
}

function classifyDeps(logger = vi.fn()) {
  return { deps: { selfCreated: new SelfCreatedSessions(), logger }, logger }
}

const SESSION_MODEL = { providerID: "anthropic", modelID: "claude-test" }

describe("intake_prefilter_and_heuristics (test 38, Dataset: 14 rows)", () => {
  it("row 1: 'fix typo in readme' — trivial, no client call, intake:classify-skipped logged", async () => {
    const client = makeIntakeClient()
    const { deps, logger } = classifyDeps()

    const result = await classifyMultiStory(client, deps, {
      parentSessionID: "s1",
      sessionModel: SESSION_MODEL,
      askText: "fix typo in readme",
    })

    expect(result).toEqual({ multiStory: false, source: "skipped" })
    expect(client.session.create).not.toHaveBeenCalled()
    expect(client.session.prompt).not.toHaveBeenCalled()
    expect(logger).toHaveBeenCalledWith("intake:classify-skipped", { sessionID: "s1" })
  })

  it("row 2: 'rename fooBar to foo_bar' — trivial, skipped", async () => {
    const client = makeIntakeClient()
    const { deps } = classifyDeps()
    const result = await classifyMultiStory(client, deps, {
      parentSessionID: "s1",
      sessionModel: SESSION_MODEL,
      askText: "rename fooBar to foo_bar",
    })
    expect(result.source).toBe("skipped")
    expect(client.session.prompt).not.toHaveBeenCalled()
  })

  it("row 3: 'where is the lexer defined?' — trivial, skipped", async () => {
    const client = makeIntakeClient()
    const { deps } = classifyDeps()
    const result = await classifyMultiStory(client, deps, {
      parentSessionID: "s1",
      sessionModel: SESSION_MODEL,
      askText: "where is the lexer defined?",
    })
    expect(result.source).toBe("skipped")
    expect(client.session.prompt).not.toHaveBeenCalled()
  })

  it("row 4: 'refactor auth end-to-end' (24 chars, short but non-trivial) reaches the classifier and issues a subturn", async () => {
    const client = makeIntakeClient({
      promptImpl: async () => ({ data: { parts: [{ type: "text", text: '{"multiStory":true}' }] }, error: undefined }),
    })
    const { deps } = classifyDeps()

    const result = await classifyMultiStory(client, deps, {
      parentSessionID: "s1",
      sessionModel: SESSION_MODEL,
      askText: "refactor auth end-to-end",
    })

    expect(client.session.prompt).toHaveBeenCalledTimes(1)
    const promptArgs = client.session.prompt.mock.calls[0][0] as { body: { agent: string } }
    expect(promptArgs.body.agent).toBe("vertex-intake")
    expect(result).toEqual({ multiStory: true, source: "subturn" })
  })

  it("row 5: 'add caching and fix the flaky test' issues a subturn; the heuristic independently also says multi-story", async () => {
    const client = makeIntakeClient({
      promptImpl: async () => ({ data: { parts: [{ type: "text", text: '{"multiStory":true}' }] }, error: undefined }),
    })
    const { deps } = classifyDeps()
    const askText = "add caching and fix the flaky test"

    const result = await classifyMultiStory(client, deps, { parentSessionID: "s1", sessionModel: SESSION_MODEL, askText })

    expect(client.session.prompt).toHaveBeenCalledTimes(1)
    expect(result.source).toBe("subturn")
    expect(classifyMultiStoryHeuristic(askText)).toBe(true)
  })

  it("row 6: 'migrate the DB and update the client' issues a subturn", async () => {
    const client = makeIntakeClient()
    const { deps } = classifyDeps()
    const result = await classifyMultiStory(client, deps, {
      parentSessionID: "s1",
      sessionModel: SESSION_MODEL,
      askText: "migrate the DB and update the client",
    })
    expect(client.session.prompt).toHaveBeenCalledTimes(1)
    expect(result.source).toBe("subturn")
  })

  it("row 7: sequencing word — when the subturn fails, the heuristic fallback decides multi-story and intake:classify-fallback is logged", async () => {
    const client = makeIntakeClient({ promptImpl: async () => ({ data: undefined, error: "boom" }) })
    const { deps, logger } = classifyDeps()

    const result = await classifyMultiStory(client, deps, {
      parentSessionID: "s1",
      sessionModel: SESSION_MODEL,
      askText: "first add the parser, then wire the CLI",
    })

    expect(result).toEqual({ multiStory: true, source: "heuristic" })
    expect(logger).toHaveBeenCalledWith("intake:classify-fallback", expect.objectContaining({ sessionID: "s1" }))
  })

  it("row 8: Korean sequencing — heuristic fallback on subturn failure returns multi-story", async () => {
    const client = makeIntakeClient({ promptImpl: async () => ({ data: undefined, error: "boom" }) })
    const { deps } = classifyDeps()
    const result = await classifyMultiStory(client, deps, {
      parentSessionID: "s1",
      sessionModel: SESSION_MODEL,
      askText: "먼저 파서를 추가하고 그다음 CLI를 연결해줘",
    })
    expect(result).toEqual({ multiStory: true, source: "heuristic" })
  })

  it("row 9: a sequencing word only inside a fenced code block is not counted — classification driven by the rest of the text", async () => {
    const client = makeIntakeClient({
      promptImpl: async () => ({ data: { parts: [{ type: "text", text: '{"multiStory":false}' }] }, error: undefined }),
    })
    const { deps } = classifyDeps()
    const askText = [
      "investigate why the parser stalls on this input:",
      "```",
      "if (x) { then(); }",
      "```",
      "no further changes needed.",
    ].join("\n")

    const result = await classifyMultiStory(client, deps, { parentSessionID: "s1", sessionModel: SESSION_MODEL, askText })

    // Non-trivial ("investigate" is not a TRIVIAL_ASK_RE verb and the text
    // does not end in "?"), so the subturn IS issued.
    expect(client.session.prompt).toHaveBeenCalledTimes(1)
    expect(result.source).toBe("subturn")
    // And directly on the heuristic: the fenced "then" must not trigger it.
    expect(classifyMultiStoryHeuristic(askText)).toBe(false)
  })

  it("row 10: a long rambling single-story question issues exactly one subturn and returns multiStory:false", async () => {
    const client = makeIntakeClient({
      promptImpl: async () => ({ data: { parts: [{ type: "text", text: '{"multiStory":false}' }] }, error: undefined }),
    })
    const { deps } = classifyDeps()
    const askText = `${"I keep wondering about how the tokenizer behaves under deeply nested expressions and whether it handles unicode identifiers correctly in every code path we support, especially when comments are interleaved with string literals that themselves contain escaped quote characters ".repeat(4)}?`

    const result = await classifyMultiStory(client, deps, { parentSessionID: "s1", sessionModel: SESSION_MODEL, askText })

    expect(client.session.prompt).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ multiStory: false, source: "subturn" })
  })

  it("row 11: an ask with attached-file content already excluded by the caller classifies on the text-only portion", async () => {
    const client = makeIntakeClient({
      promptImpl: async () => ({ data: { parts: [{ type: "text", text: '{"multiStory":false}' }] }, error: undefined }),
    })
    const { deps } = classifyDeps()
    // Caller (wiring) is responsible for excluding attached file parts before
    // building askText (FR-018a) — this module only ever sees the resulting
    // flat string, so the test constructs it the way wiring would. Deliberately
    // non-trivial (unlike a bare "explain ..." ask, which would match
    // TRIVIAL_ASK_RE and never reach the subturn at all) so this test actually
    // exercises the subturn call path.
    const askText = "add tests for this file and fix the failing edge cases"

    const result = await classifyMultiStory(client, deps, { parentSessionID: "s1", sessionModel: SESSION_MODEL, askText })
    const promptArgs = client.session.prompt.mock.calls[0][0] as { body: { parts: Array<{ text: string }> } }
    expect(promptArgs.body.parts).toEqual([{ type: "text", text: askText }])
    expect(result.source).toBe("subturn")
  })

  it("rows 12/13: this module does not self-throttle — each call issues its own subturn attempt (once-per-task/session caps are wiring's ledger, not this module's)", async () => {
    const client = makeIntakeClient()
    const { deps } = classifyDeps()

    await classifyMultiStory(client, deps, { parentSessionID: "s1", sessionModel: SESSION_MODEL, askText: "refactor auth end-to-end" })
    await classifyMultiStory(client, deps, { parentSessionID: "s1", sessionModel: SESSION_MODEL, askText: "refactor billing end-to-end" })

    // Both calls issued a subturn — proves no internal per-task/session cap
    // state exists here; a real harness must call this function at most
    // once per task and enforce VERTEX_INTAKE_SUBTURN_MAX itself.
    expect(client.session.prompt).toHaveBeenCalledTimes(2)
  })

  it("row 14: a subturn that never resolves falls back to the heuristic within the 5s total budget, logging intake:classify-fallback", async () => {
    vi.useFakeTimers()
    const client = makeIntakeClient({ promptImpl: () => new Promise(() => {}) })
    const { deps, logger } = classifyDeps()

    const resultPromise = classifyMultiStory(client, deps, {
      parentSessionID: "s1",
      sessionModel: SESSION_MODEL,
      askText: "first add the parser, then wire the CLI",
    })
    await vi.advanceTimersByTimeAsync(5000)
    const result = await resultPromise

    expect(result).toEqual({ multiStory: true, source: "heuristic" })
    expect(logger).toHaveBeenCalledWith(
      "intake:classify-fallback",
      expect.objectContaining({ sessionID: "s1", reason: "timeout" }),
    )
    // session.delete still runs on the timeout exit path (subturn.ts's own FR-038 contract).
    expect(client.session.delete).toHaveBeenCalledTimes(1)
  })
})

describe("intake capability probe (FR-030b, story.ts's obligation as the caller)", () => {
  it("when the vertex-intake agent is unsupported, no session.create/prompt is issued and intake:unsupported is logged, then falls back to the heuristic", async () => {
    const client = makeIntakeClient({ supported: false })
    const { deps, logger } = classifyDeps()

    const result = await classifyMultiStory(client, deps, {
      parentSessionID: "s1",
      sessionModel: SESSION_MODEL,
      askText: "first add the parser, then wire the CLI",
    })

    expect(client.session.create).not.toHaveBeenCalled()
    expect(client.session.prompt).not.toHaveBeenCalled()
    expect(logger).toHaveBeenCalledWith("intake:unsupported", expect.objectContaining({ sessionID: "s1" }))
    expect(result).toEqual({ multiStory: true, source: "heuristic" })
  })

  it("a malformed subturn response falls back to the heuristic and logs intake:classify-fallback", async () => {
    const client = makeIntakeClient({ promptImpl: async () => ({ data: { parts: [{ type: "text", text: "not json at all" }] }, error: undefined }) })
    const { deps, logger } = classifyDeps()

    const result = await classifyMultiStory(client, deps, {
      parentSessionID: "s1",
      sessionModel: SESSION_MODEL,
      askText: "first add the parser, then wire the CLI",
    })

    expect(result).toEqual({ multiStory: true, source: "heuristic" })
    expect(logger).toHaveBeenCalledWith(
      "intake:classify-fallback",
      expect.objectContaining({ reason: "malformed subturn response" }),
    )
  })
})
