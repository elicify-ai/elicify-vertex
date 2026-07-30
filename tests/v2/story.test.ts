import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import {
  IMPERATIVE_VERBS,
  INTAKE_SUBTURN_TIMEOUT_MS,
  SEQUENCING_WORDS,
  StoryEngine,
  TRIVIAL_ASK_RE,
  classifyMultiStory,
  classifyMultiStoryHeuristic,
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

/**
 * Minimal confirmed-story input builder for the 2026-07-30 task/DAG
 * `createPlan`. A story MUST decompose into ≥1 task; the helper fills the
 * common defaults (one no-dep task, one acceptance item, empty globs/
 * verifiers) so each test overrides only what it cares about.
 */
function story(
  overrides: Partial<{
    text: string
    acceptanceItems: string[]
    tasks: Array<{ text: string; dependsOn?: string[] }>
    scopeGlobs: string[]
    verifiers: string[]
    dependsOn: string[]
  }> = {},
) {
  return {
    text: "do the thing",
    acceptanceItems: ["it works"],
    tasks: [{ text: "implement it" }],
    scopeGlobs: [] as string[],
    verifiers: [] as string[],
    dependsOn: [] as string[],
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
// (task/DAG model)
// ---------------------------------------------------------------------------

describe("story_schema_v2_validation (test 12, FR-017)", () => {
  it("createPlan builds a schemaVersion:2 plan, assigns task ids S{n}.T{m}, and activates level-0 tasks", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)

    const plan = se.createPlan("s1", [
      story({ text: "parser", acceptanceItems: ["handles nesting"], scopeGlobs: ["src/parser/**"] }),
      story({ text: "cli", acceptanceItems: ["wires the flag"] }),
    ])

    expect(plan.schemaVersion).toBe(2)
    expect(plan.stories).toHaveLength(2)
    expect(plan.stories.map((s) => s.id)).toEqual(["S1", "S2"])
    expect(plan.finalStoryId).toBe("S2")
    // Each story decomposed into the declared task, with a deterministic id.
    expect(plan.stories[0].tasks.map((t) => t.id)).toEqual(["S1.T1"])
    expect(plan.stories[1].tasks.map((t) => t.id)).toEqual(["S2.T1"])
    // No deps anywhere → both tasks are level 0 → both ACTIVE at create.
    expect(plan.stories[0].tasks[0].status).toBe("active")
    expect(plan.stories[1].tasks[0].status).toBe("active")
    expect(plan.stories.map((s) => s.status)).toEqual(["active", "active"])
    expect(plan.stories[0].acceptanceItems[0].evidence).toBeNull()
    expect(typeof plan.createdAt).toBe("string")
  })

  it("rejects an empty story list", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    expect(() => se.createPlan("s1", [])).toThrow(/at least one story/)
  })

  it("rejects a story with no tasks (decomposition is mandatory)", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    expect(() => se.createPlan("s1", [{ text: "x", acceptanceItems: ["a"], tasks: [] }])).toThrow(/at least one task/)
  })

  it("rejects a story with no acceptanceItems", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    expect(() => se.createPlan("s1", [{ text: "x", acceptanceItems: [], tasks: [{ text: "t" }] }])).toThrow(
      /at least one item/,
    )
  })

  // Manual UAT finding preserved: the host does not reliably apply the tool
  // schema's `.default([])` for an omitted optional array arg — a real model
  // that leaves scopeGlobs/verifiers out reaches here with `undefined`.
  it("does not throw when scopeGlobs/verifiers/dependsOn are omitted entirely (real-model UAT crash)", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)

    const plan = se.createPlan("s1", [{ text: "investigate the flaky CI", acceptanceItems: ["root cause"], tasks: [{ text: "dig" }] }])

    expect(plan.stories[0].scopeGlobs).toEqual([])
    expect(plan.stories[0].verifiers).toEqual([])
    expect(plan.stories[0].dependsOn).toEqual([])
  })

  it("persists to disk and survives a simulated restart (fresh StoryEngine instance)", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    const created = se.createPlan("s1", [story({ text: "only story" })])

    const restarted = new StoryEngine({ stateDir, logger: vi.fn() })
    expect(restarted.getPlan("s1")).toEqual(created)
    expect(restarted.getActiveTasks("s1")[0]?.id).toBe(created.stories[0].tasks[0].id)
  })

  it("getPlan/getActiveTasks return null/[] for an unknown session, never throw", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    expect(se.getPlan("unknown")).toBeNull()
    expect(se.getActiveTasks("unknown")).toEqual([])
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
    expect(() => se.attachEvidence("s1", storyId, "unknown-items", { receiptId: "x" })).not.toThrow()

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
// CRITICAL fix (preserved): a corrupt plan.json must not silently destroy
// other sessions' data on the next write (persistPlan).
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
    const taskId = plan.stories[0].tasks[0].id
    const planPath = join(stateDir, "plan.json")

    const corruptBytes = "{ this is not json "
    writeFileSync(planPath, corruptBytes)

    expect(() => se.checkpoint("s1", taskId, "complete")).toThrow(/corrupt/i)
    expect(readFileSync(planPath, "utf8")).toBe(corruptBytes) // still untouched
  })

  it("(b) a schema-invalid-but-parseable plan.json still degrades gracefully (no regression)", () => {
    const stateDir = temporaryRoot()
    mkdirSync(stateDir, { recursive: true })
    const planPath = join(stateDir, "plan.json")
    writeFileSync(planPath, JSON.stringify({ "session-other": { schemaVersion: 2, stories: "not an array" } }))
    const logger = vi.fn()
    const { engine: se } = engine(stateDir, logger)

    expect(() => se.createPlan("s1", [story()])).not.toThrow()

    expect(logger).not.toHaveBeenCalledWith("story:disk-corrupt", expect.anything())
    const onDisk = JSON.parse(readFileSync(planPath, "utf8")) as Record<string, unknown>
    expect(onDisk.s1).toBeDefined()
    expect(onDisk["session-other"]).toBeUndefined()
  })
})

// ===========================================================================
// 2026-07-30 task/DAG redesign: wave computation from the dependency DAG.
// ===========================================================================

describe("DAG wave computation (2026-07-30 task/DAG redesign)", () => {
  it("independent tasks (no deps) are ALL level 0 → all start ACTIVE at create, with startedAt", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    const before = Date.now()
    const plan = se.createPlan("s1", [
      story({
        text: "three independent tasks",
        tasks: [{ text: "a" }, { text: "b" }, { text: "c" }],
      }),
    ])
    const after = Date.now()

    expect(plan.stories[0].tasks.map((t) => t.status)).toEqual(["active", "active", "active"])
    for (const task of plan.stories[0].tasks) {
      expect(typeof task.startedAt).toBe("string")
      const ms = Date.parse(task.startedAt!)
      expect(ms).toBeGreaterThanOrEqual(before)
      expect(ms).toBeLessThanOrEqual(after)
    }
  })

  it("a task that depends on another WAITS: dependent is pending while its predecessor is active", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    const plan = se.createPlan("s1", [
      story({
        text: "pipeline",
        tasks: [
          { text: "first" },
          { text: "second", dependsOn: ["S1.T1"] },
        ],
      }),
    ])

    expect(plan.stories[0].tasks[0].status).toBe("active") // level 0
    expect(plan.stories[0].tasks[1].status).toBe("pending") // level 1, depends on T1
    expect(plan.stories[0].tasks[1].startedAt).toBeUndefined()
  })

  it("longest-path layering: a chain T1 -> T2 -> T3 places each at levels 0/1/2", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    const plan = se.createPlan("s1", [
      story({
        text: "chain",
        tasks: [
          { text: "t1" },
          { text: "t2", dependsOn: ["S1.T1"] },
          { text: "t3", dependsOn: ["S1.T2"] },
        ],
      }),
    ])

    // Only the level-0 task is active at create; the rest wait in order.
    expect(plan.stories[0].tasks.map((t) => t.status)).toEqual(["active", "pending", "pending"])
  })

  it("a diamond (T1 -> {T2,T3} -> T4) fans out T2/T3 together once T1 is done", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    const plan = se.createPlan("s1", [
      story({
        text: "diamond",
        tasks: [
          { text: "t1" },
          { text: "t2", dependsOn: ["S1.T1"] },
          { text: "t3", dependsOn: ["S1.T1"] },
          { text: "t4", dependsOn: ["S1.T2", "S1.T3"] },
        ],
      }),
    ])
    const [t1, t2, t3, t4] = plan.stories[0].tasks

    expect([t1.status, t2.status, t3.status, t4.status]).toEqual(["active", "pending", "pending", "pending"])

    // Complete T1 → no active task remains → promote the next level (T2,T3).
    se.checkpoint("s1", t1.id, "complete")
    const after1 = se.getPlan("s1")!.stories[0].tasks
    expect(after1.map((t) => t.status)).toEqual(["complete", "active", "active", "pending"])

    // Complete T2 alone: T3 is still active, so T4 stays pending.
    se.checkpoint("s1", t2.id, "complete")
    const after2 = se.getPlan("s1")!.stories[0].tasks
    expect(after2.map((t) => t.status)).toEqual(["complete", "complete", "active", "pending"])

    // Complete T3 → no active → promote T4.
    se.checkpoint("s1", t3.id, "complete")
    const after3 = se.getPlan("s1")!.stories[0].tasks
    expect(after3.map((t) => t.status)).toEqual(["complete", "complete", "complete", "active"])
  })

  it("getActiveTasks returns active tasks across stories in stable story-then-task order", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    se.createPlan("s1", [
      story({ text: "s1", tasks: [{ text: "a" }, { text: "b" }] }),
      story({ text: "s2", tasks: [{ text: "c" }] }),
    ])

    expect(se.getActiveTasks("s1").map((t) => t.id)).toEqual(["S1.T1", "S1.T2", "S2.T1"])
  })
})

// ---------------------------------------------------------------------------
// Cross-story task dependencies + story-dependsOn-story.
// ---------------------------------------------------------------------------

describe("cross-story dependencies and story-dependsOn-story", () => {
  it("a task in S2 depending on a task in S1 cannot activate until that task completes", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    const plan = se.createPlan("s1", [
      story({ text: "S1", tasks: [{ text: "t1" }] }),
      story({ text: "S2", tasks: [{ text: "t1", dependsOn: ["S1.T1"] }] }),
    ])
    const s1t1 = plan.stories[0].tasks[0]
    const s2t1 = plan.stories[1].tasks[0]

    // S1.T1 is level 0 (active); S2.T1 is level 1 (pending) — S2 is pending.
    expect(s1t1.status).toBe("active")
    expect(s2t1.status).toBe("pending")
    expect(plan.stories.map((s) => s.status)).toEqual(["active", "pending"])

    se.checkpoint("s1", s1t1.id, "complete")
    const after = se.getPlan("s1")!
    expect(after.stories[0].tasks[0].status).toBe("complete")
    expect(after.stories[1].tasks[0].status).toBe("active") // predecessor done → promoted
    expect(after.stories.map((s) => s.status)).toEqual(["complete", "active"])
  })

  it("story-dependsOn-story: none of S2's tasks activate until every task of S1 is complete", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    const plan = se.createPlan("s1", [
      story({ text: "S1", tasks: [{ text: "a" }, { text: "b" }] }),
      story({ text: "S2", dependsOn: ["S1"], tasks: [{ text: "c" }, { text: "d" }] }),
    ])

    // Both S1 tasks are level 0; all S2 tasks depend (via the story dep) on
    // both S1 tasks → level 1 → pending.
    expect(plan.stories[0].tasks.map((t) => t.status)).toEqual(["active", "active"])
    expect(plan.stories[1].tasks.map((t) => t.status)).toEqual(["pending", "pending"])

    // Complete only ONE of S1's tasks: S2 still waits (the other is active).
    se.checkpoint("s1", plan.stories[0].tasks[0].id, "complete")
    expect(se.getPlan("s1")!.stories[1].tasks.map((t) => t.status)).toEqual(["pending", "pending"])

    // Now complete the other: no active task remains → S2's whole level (c,d) activates.
    se.checkpoint("s1", plan.stories[0].tasks[1].id, "complete")
    const after = se.getPlan("s1")!
    expect(after.stories[0].status).toBe("complete")
    expect(after.stories[1].tasks.map((t) => t.status)).toEqual(["active", "active"])
    expect(after.stories[1].status).toBe("active")
  })

  it("a task-level dependsOn naming a STORY id expands to all of that story's tasks", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    const plan = se.createPlan("s1", [
      story({ text: "S1", tasks: [{ text: "a" }, { text: "b" }] }),
      // S2.T1 depends on the whole story S1 by id.
      story({ text: "S2", tasks: [{ text: "c", dependsOn: ["S1"] }] }),
    ])

    expect(plan.stories[1].tasks[0].status).toBe("pending")
    se.checkpoint("s1", plan.stories[0].tasks[0].id, "complete")
    expect(se.getPlan("s1")!.stories[1].tasks[0].status).toBe("pending") // S1.T2 still active
    se.checkpoint("s1", plan.stories[0].tasks[1].id, "complete")
    expect(se.getPlan("s1")!.stories[1].tasks[0].status).toBe("active") // all of S1 done
  })
})

// ---------------------------------------------------------------------------
// Validation: cycle rejection + dangling-dep rejection (before any disk write).
// ---------------------------------------------------------------------------

describe("createPlan dependency validation", () => {
  it("rejects a task-level cycle, naming the cycle, and writes no plan", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    expect(() =>
      se.createPlan("s1", [
        story({
          text: "cycle",
          tasks: [
            { text: "a", dependsOn: ["S1.T2"] },
            { text: "b", dependsOn: ["S1.T1"] },
          ],
        }),
      ]),
    ).toThrow(/plan dependency cycle:/)
    expect(se.getPlan("s1")).toBeNull()
    // byte-for-byte: no plan.json written.
    expect(existsSync(join(stateDir, "plan.json"))).toBe(false)
  })

  it("rejects a cycle across stories (S1.T1 -> S2.T1 -> S1.T1)", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    expect(() =>
      se.createPlan("s1", [
        story({ text: "S1", tasks: [{ text: "a", dependsOn: ["S2.T1"] }] }),
        story({ text: "S2", tasks: [{ text: "b", dependsOn: ["S1.T1"] }] }),
      ]),
    ).toThrow(/plan dependency cycle:/)
  })

  it("rejects a dangling task dependsOn (unknown id), naming the id", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    expect(() =>
      se.createPlan("s1", [
        story({ text: "S1", tasks: [{ text: "a", dependsOn: ["S1.T9"] }] }),
      ]),
    ).toThrow(/unknown story or task: S1\.T9/)
    expect(se.getPlan("s1")).toBeNull()
  })

  it("rejects a dangling story dependsOn (unknown story id)", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    expect(() =>
      se.createPlan("s1", [story({ text: "S1", dependsOn: ["S9"], tasks: [{ text: "a" }] })]),
    ).toThrow(/unknown story or task: S9/)
  })

  it("rejects a duplicate task id is impossible by construction (auto-assigned), but two stories share no task ids", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    const plan = se.createPlan("s1", [
      story({ text: "S1", tasks: [{ text: "a" }, { text: "b" }] }),
      story({ text: "S2", tasks: [{ text: "c" }] }),
    ])
    const ids = plan.stories.flatMap((s) => s.tasks.map((t) => t.id))
    expect(new Set(ids).size).toBe(ids.length)
  })
})

// ---------------------------------------------------------------------------
// Task-level checkpoint: claim semantics, auto-complete, promotion.
// ---------------------------------------------------------------------------

describe("checkpoint operates on a TASK (2026-07-30)", () => {
  it("completing a task with NO evidence succeeds (claim, not proof) and stamps task.completedAt", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    const plan = se.createPlan("s1", [story({ tasks: [{ text: "a" }, { text: "b" }] })])
    const t1 = plan.stories[0].tasks[0].id

    const before = Date.now()
    se.checkpoint("s1", t1, "complete")
    const after = Date.now()

    const task = se.getPlan("s1")!.stories[0].tasks[0]
    expect(task.status).toBe("complete")
    expect(typeof task.completedAt).toBe("string")
    const ms = Date.parse(task.completedAt!)
    expect(ms).toBeGreaterThanOrEqual(before)
    expect(ms).toBeLessThanOrEqual(after)
  })

  it("a story AUTO-COMPLETES (with story.completedAt) when its LAST active task completes", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    const plan = se.createPlan("s1", [
      story({
        text: "two-task story",
        tasks: [{ text: "a" }, { text: "b" }],
      }),
    ])
    const [t1, t2] = plan.stories[0].tasks.map((t) => t.id)

    se.checkpoint("s1", t1, "complete")
    let storyState = se.getPlan("s1")!.stories[0]
    expect(storyState.status).toBe("active") // t2 still active
    expect(storyState.completedAt).toBeUndefined()

    se.checkpoint("s1", t2, "complete")
    storyState = se.getPlan("s1")!.stories[0]
    expect(storyState.status).toBe("complete")
    expect(typeof storyState.completedAt).toBe("string")
  })

  it("promotes the next level (across stories) only when NO task remains active anywhere", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    const plan = se.createPlan("s1", [
      story({ text: "S1", tasks: [{ text: "a" }] }),
      story({ text: "S2", tasks: [{ text: "b", dependsOn: ["S1.T1"] }, { text: "c", dependsOn: ["S1.T1"] }] }),
      story({ text: "S3", tasks: [{ text: "d", dependsOn: ["S2.T1", "S2.T2"] }] }),
    ])
    const [s1t1] = plan.stories[0].tasks
    const s2 = plan.stories[1].tasks
    const s3 = plan.stories[2].tasks

    // Complete S1.T1 → promote S2's whole level (b,c) together.
    se.checkpoint("s1", s1t1.id, "complete")
    expect(se.getPlan("s1")!.stories[1].tasks.map((t) => t.status)).toEqual(["active", "active"])
    expect(se.getPlan("s1")!.stories[2].tasks[0].status).toBe("pending")

    // Complete S2.T1 alone: S2.T2 still active → S3 NOT promoted.
    se.checkpoint("s1", s2[0].id, "complete")
    expect(se.getPlan("s1")!.stories[2].tasks[0].status).toBe("pending")

    // Complete S2.T2 → no active → promote S3.T1.
    se.checkpoint("s1", s2[1].id, "complete")
    expect(se.getPlan("s1")!.stories[2].tasks[0].status).toBe("active")
    expect(typeof se.getPlan("s1")!.stories[2].tasks[0].startedAt).toBe("string")
  })

  it("completing a non-active (pending) task throws, naming the task and the active ids", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    const plan = se.createPlan("s1", [
      story({
        tasks: [
          { text: "first" },
          { text: "second", dependsOn: ["S1.T1"] },
        ],
      }),
    ])
    const pending = plan.stories[0].tasks[1].id

    expect(() => se.checkpoint("s1", pending, "complete")).toThrow(new RegExp(pending))
    expect(() => se.checkpoint("s1", pending, "complete")).toThrow(/not active/)
    // Nothing changed.
    const after = se.getPlan("s1")!
    expect(after.stories[0].tasks[0].status).toBe("active")
    expect(after.stories[0].tasks[1].status).toBe("pending")
  })

  it("does NOT gate failed/blocked transitions on being an active task (only complete is checked)", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    const plan = se.createPlan("s1", [
      story({
        tasks: [
          { text: "first" },
          { text: "second", dependsOn: ["S1.T1"] },
        ],
      }),
    ])
    const pending = plan.stories[0].tasks[1].id

    expect(() => se.checkpoint("s1", pending, "blocked")).not.toThrow()
    expect(se.getPlan("s1")!.stories[0].tasks[1].status).toBe("blocked")
  })

  // C-11 invariant carried into the task/DAG model: a dependent task CANNOT
  // activate while a dependency it relies on is blocked — promotion is
  // dependency-COMPLETION-based, not raw-topological-level-based. A level
  // scan would skip the blocked predecessor and wrongly activate the
  // successor, letting a plan false-complete with an unresolved dependency.
  it("a blocked dependency holds its dependent task pending until the dependency is reopened and completed", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    const plan = se.createPlan("s1", [
      story({ text: "predecessor", tasks: [{ text: "p" }] }),
      story({ text: "successor", dependsOn: ["S1"], tasks: [{ text: "s" }] }),
    ])
    const p = plan.stories[0].tasks[0].id // S1.T1

    // Block the active predecessor. No task remains active -> promotion runs,
    // but S2.T1's dep (S1.T1) is not complete -> S2.T1 STAYS pending.
    se.checkpoint("s1", p, "blocked", { reason: "upstream missing" })
    const afterBlock = se.getPlan("s1")!
    expect(afterBlock.stories[0].tasks[0].status).toBe("blocked")
    expect(afterBlock.stories[1].tasks[0].status).toBe("pending") // NOT activated
    expect(afterBlock.stories[1].status).toBe("pending")

    // Reopen the predecessor -> its task re-activates (deps vacuously complete).
    se.reopenStory("s1", "S1", { reason: "unblocked" })
    expect(se.getPlan("s1")!.stories[0].tasks[0].status).toBe("active")

    // Complete the predecessor -> now S2.T1's dep is complete -> promoted.
    se.checkpoint("s1", p, "complete")
    expect(se.getPlan("s1")!.stories[1].tasks[0].status).toBe("active")
  })

  it("blocked/failed with a reason record it on the parent STORY as an amendment", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    const plan = se.createPlan("s1", [story({ tasks: [{ text: "a" }] })])
    const t1 = plan.stories[0].tasks[0].id

    se.checkpoint("s1", t1, "blocked", { reason: "verifier exits ambiguous" })
    const blocked = se.getPlan("s1")!.stories[0]
    expect(blocked.status).toBe("blocked")
    expect(blocked.amendments.map((a) => a.reason)).toEqual(["blocked: verifier exits ambiguous"])
    expect(blocked.tasks[0].completedAt).toBeUndefined()

    // A non-complete outcome also clears any earlier task completion claim.
    se.reopenStory("s1", "S1", { reason: "retry" })
    se.checkpoint("s1", t1, "failed", { reason: "attempt blew up" })
    expect(se.getPlan("s1")!.stories[0].amendments.some((a) => a.reason === "failed: attempt blew up")).toBe(true)
  })

  it("blocked/failed without a reason appends no amendment", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    const plan = se.createPlan("s1", [story({ tasks: [{ text: "a" }] })])
    se.checkpoint("s1", plan.stories[0].tasks[0].id, "blocked")
    expect(se.getPlan("s1")!.stories[0].amendments).toHaveLength(0)
  })

  it("unknown task id throws, no plan for the session throws", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    se.createPlan("s1", [story()])
    expect(() => se.checkpoint("s1", "S1.T9", "complete")).toThrow(/unknown task/)
    expect(() => se.checkpoint("no-plan", "S1.T1", "complete")).toThrow(/no story plan/)
  })

  it("a rejected checkpoint leaves the plan file byte-for-byte unchanged (invariant)", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    const plan = se.createPlan("s1", [
      story({
        tasks: [
          { text: "first" },
          { text: "second", dependsOn: ["S1.T1"] },
        ],
      }),
    ])
    const pending = plan.stories[0].tasks[1].id // pending → completing must throw
    const beforeBytes = readFileSync(join(stateDir, "plan.json"))

    expect(() => se.checkpoint("s1", pending, "complete")).toThrow()
    expect(readFileSync(join(stateDir, "plan.json")).equals(beforeBytes)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// applyJudgeVerdicts — a failed verdict reverts a complete story AND re-opens
// its complete tasks (re-audit requires re-doing the work).
// ---------------------------------------------------------------------------

describe("applyJudgeVerdicts re-opens a reverted story's tasks (2026-07-30)", () => {
  const items = [
    { itemId: "A1", met: true, note: "verified via make check" },
    { itemId: "A2", met: false, note: "no such export exists" },
  ]

  it("a passing verdict on a complete story keeps it complete and records the stamp", () => {
    const stateDir = temporaryRoot()
    const { engine: se, logger } = engine(stateDir)
    const plan = se.createPlan("s1", [story({ acceptanceItems: ["A1", "A2"], tasks: [{ text: "a" }] })])
    const storyId = plan.stories[0].id
    const taskId = plan.stories[0].tasks[0].id
    se.checkpoint("s1", taskId, "complete")

    const result = se.applyJudgeVerdicts("s1", [{ storyId, pass: true, summary: "all good", items }])

    expect(result).toEqual({ reverted: [], passed: [storyId], unknown: [] })
    const after = se.getPlan("s1")!.stories[0]
    expect(after.status).toBe("complete")
    expect(after.completedAt).toBeDefined()
    expect(after.judge).toMatchObject({ pass: true, summary: "all good", items })
    expect(typeof after.judge!.judgedAt).toBe("string")
    expect(logger).toHaveBeenCalledWith("story:judge-audit", { sessionID: "s1", passed: [storyId], reverted: [], unknown: [] })
  })

  it("a failing verdict on a complete story REVERTS it: tasks re-opened to active, fresh startedAt, completedAt cleared", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    const plan = se.createPlan("s1", [story({ acceptanceItems: ["A1", "A2"], tasks: [{ text: "a" }, { text: "b" }] })])
    const storyId = plan.stories[0].id
    const [t1, t2] = plan.stories[0].tasks.map((t) => t.id)
    se.checkpoint("s1", t1, "complete")
    se.checkpoint("s1", t2, "complete")
    expect(se.getPlan("s1")!.stories[0].status).toBe("complete")

    const before = Date.now()
    const result = se.applyJudgeVerdicts("s1", [{ storyId, pass: false, summary: "A2 not delivered", items }])
    const after = Date.now()

    expect(result.reverted).toEqual([storyId])
    const reverted = se.getPlan("s1")!.stories[0]
    expect(reverted.status).toBe("active")
    expect(reverted.completedAt).toBeUndefined()
    // BOTH complete tasks were re-opened to active.
    expect(reverted.tasks.map((t) => t.status)).toEqual(["active", "active"])
    expect(reverted.tasks.every((t) => t.completedAt === undefined)).toBe(true)
    expect(reverted.tasks.every((t) => typeof t.startedAt === "string")).toBe(true)
    expect(reverted.tasks.every((t) => Date.parse(t.startedAt!) >= before && Date.parse(t.startedAt!) <= after)).toBe(true)
    expect(reverted.judge).toMatchObject({ pass: false, summary: "A2 not delivered" })
  })

  it("a verdict on a non-complete story records the stamp but changes no status", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    const plan = se.createPlan("s1", [
      story({ text: "S1", tasks: [{ text: "a" }] }),
      story({ text: "S2", tasks: [{ text: "b", dependsOn: ["S1.T1"] }] }),
    ])
    const [s1, s2] = plan.stories.map((s) => s.id)

    const result = se.applyJudgeVerdicts("s1", [
      { storyId: s1, pass: false, summary: "active story audited early", items: [] },
      { storyId: s2, pass: true, summary: "pending story audited early", items: [] },
    ])

    expect(result).toEqual({ reverted: [], passed: [], unknown: [] })
    const after = se.getPlan("s1")!
    expect(after.stories[0].status).toBe("active")
    expect(after.stories[0].judge).toMatchObject({ pass: false })
    expect(after.stories[1].status).toBe("pending")
    expect(after.stories[1].judge).toMatchObject({ pass: true })
  })

  it("unknown story ids are collected into `unknown` and never throw", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    const plan = se.createPlan("s1", [story({ tasks: [{ text: "a" }] })])
    const storyId = plan.stories[0].id
    se.checkpoint("s1", plan.stories[0].tasks[0].id, "complete")

    const result = se.applyJudgeVerdicts("s1", [
      { storyId: "S99", pass: false, summary: "ghost", items: [] },
      { storyId, pass: true, summary: "real", items: [] },
    ])

    expect(result).toEqual({ reverted: [], passed: [storyId], unknown: ["S99"] })
  })

  it("throws when the session has no plan", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    expect(() => se.applyJudgeVerdicts("no-plan", [])).toThrow(/no story plan/)
  })

  it("a reverted story's tasks can be recompleted and rejudged — the full claim/audit/reclaim cycle", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    const plan = se.createPlan("s1", [story({ tasks: [{ text: "a" }] })])
    const storyId = plan.stories[0].id
    const taskId = plan.stories[0].tasks[0].id

    se.checkpoint("s1", taskId, "complete")
    se.applyJudgeVerdicts("s1", [{ storyId, pass: false, summary: "not real", items }])
    expect(se.getPlan("s1")!.stories[0].status).toBe("active")

    se.checkpoint("s1", taskId, "complete")
    const result = se.applyJudgeVerdicts("s1", [{ storyId, pass: true, summary: "now real", items: [] }])
    expect(result.passed).toEqual([storyId])
    expect(se.getPlan("s1")!.stories[0].status).toBe("complete")
    expect(se.getPlan("s1")!.stories[0].judge!.pass).toBe(true)
  })

  it("stamps and reversions survive a restart (fresh StoryEngine instance)", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    const plan = se.createPlan("s1", [story({ acceptanceItems: ["A1", "A2"], tasks: [{ text: "a" }] })])
    const storyId = plan.stories[0].id
    se.checkpoint("s1", plan.stories[0].tasks[0].id, "complete")
    se.applyJudgeVerdicts("s1", [{ storyId, pass: false, summary: "A2 missing", items }])

    const restarted = new StoryEngine({ stateDir, logger: vi.fn() })
    const reloaded = restarted.getPlan("s1")!.stories[0]
    expect(reloaded.status).toBe("active")
    expect(reloaded.completedAt).toBeUndefined()
    expect(reloaded.tasks[0].status).toBe("active")
    expect(reloaded.judge).toMatchObject({ pass: false, summary: "A2 missing", items })
  })
})

// ---------------------------------------------------------------------------
// reopenStory (2026-07-30): re-activates a story's not-complete tasks per
// the DAG level rule; no longer gated on blocked/failed only.
// ---------------------------------------------------------------------------

describe("reopenStory re-activates tasks per the DAG rule", () => {
  it("reopens a blocked story's tasks: a no-dep task goes active (fresh startedAt)", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    const plan = se.createPlan("s1", [story({ tasks: [{ text: "a" }] })])
    const storyId = plan.stories[0].id
    const taskId = plan.stories[0].tasks[0].id

    se.checkpoint("s1", taskId, "blocked")
    expect(se.getPlan("s1")!.stories[0].status).toBe("blocked")

    const before = Date.now()
    se.reopenStory("s1", storyId, { reason: "dependency unblocked" })
    const after = Date.now()

    const reopened = se.getPlan("s1")!.stories[0]
    expect(reopened.status).toBe("active")
    expect(reopened.tasks[0].status).toBe("active")
    expect(reopened.tasks[0].completedAt).toBeUndefined()
    expect(typeof reopened.tasks[0].startedAt).toBe("string")
    const ms = Date.parse(reopened.tasks[0].startedAt!)
    expect(ms).toBeGreaterThanOrEqual(before)
    expect(ms).toBeLessThanOrEqual(after)
  })

  it("reopens a story whose task depends on an incomplete predecessor: the task rejoins as pending", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    const plan = se.createPlan("s1", [
      story({ text: "S1", tasks: [{ text: "a" }] }),
      story({ text: "S2", tasks: [{ text: "b", dependsOn: ["S1.T1"] }] }),
    ])
    const s2 = plan.stories[1]

    // S2.T1 starts pending (depends on S1.T1). Block it out of order, reopen.
    se.checkpoint("s1", s2.tasks[0].id, "blocked")
    expect(se.getPlan("s1")!.stories[1].tasks[0].status).toBe("blocked")

    se.reopenStory("s1", s2.id, { reason: "retry" })
    const reopened = se.getPlan("s1")!.stories[1]
    // S1.T1 still active (not complete) → S2.T1 cannot activate → pending.
    expect(reopened.tasks[0].status).toBe("pending")
    expect(reopened.tasks[0].startedAt).toBeUndefined()
    expect(reopened.status).toBe("pending")
  })

  it("reopen leaves complete tasks complete (re-audit re-opens those via applyJudgeVerdicts, not here)", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    const plan = se.createPlan("s1", [
      story({ tasks: [{ text: "a" }, { text: "b" }] }),
    ])
    const [t1, t2] = plan.stories[0].tasks.map((t) => t.id)

    se.checkpoint("s1", t1, "complete")
    se.checkpoint("s1", t2, "blocked") // story now mixed: complete + blocked
    se.reopenStory("s1", "S1", { reason: "resume" })

    const after = se.getPlan("s1")!.stories[0]
    expect(after.tasks[0].status).toBe("complete") // untouched
    expect(after.tasks[1].status).toBe("active") // deps (none) satisfied → active
  })

  it("records an amendment naming the previous status and logs story:reopened", () => {
    const stateDir = temporaryRoot()
    const { engine: se, logger } = engine(stateDir)
    const plan = se.createPlan("s1", [story({ tasks: [{ text: "a" }] })])
    const storyId = plan.stories[0].id
    se.checkpoint("s1", plan.stories[0].tasks[0].id, "failed")

    se.reopenStory("s1", storyId, { reason: "root cause fixed" })

    const after = se.getPlan("s1")!.stories[0]
    expect(after.amendments[0].reason).toMatch(/reopened from failed/)
    expect(after.amendments[0].reason).toMatch(/root cause fixed/)
    expect(logger).toHaveBeenCalledWith("story:reopened", expect.objectContaining({ sessionID: "s1", storyId, previousStatus: "failed" }))
  })

  it("throws on an unknown session or story", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    se.createPlan("s1", [story()])
    expect(() => se.reopenStory("unknown-session", "S1", { reason: "x" })).toThrow(/no story plan/)
    expect(() => se.reopenStory("s1", "S99", { reason: "x" })).toThrow(/unknown story/)
  })

  it("does NOT reset acceptance-item evidence on reopen (deprecated field, judge stamps supersede it)", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    const plan = se.createPlan("s1", [story({ acceptanceItems: ["A1"], tasks: [{ text: "a" }] })])
    se.attachEvidence("s1", "S1", "A1", { receiptId: "vrf_legacy" })
    se.checkpoint("s1", plan.stories[0].tasks[0].id, "blocked")
    se.reopenStory("s1", "S1", { reason: "retry" })
    expect(se.getPlan("s1")!.stories[0].acceptanceItems[0].evidence).toEqual({ receiptId: "vrf_legacy" })
  })
})

// ---------------------------------------------------------------------------
// C-6 end-to-end (task model): a blocked final story can be reopened and the
// plan still reaches all-complete. The DAG honours story dependsOn, so the
// final story's tasks cannot complete until its siblings are done.
// ---------------------------------------------------------------------------

describe("C-6 end-to-end: a blocked final story can be reopened and the plan reaches all-complete", () => {
  it("recovers a plan stuck on a blocked final story", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    const plan = se.createPlan("s1", [
      story({ text: "S1", tasks: [{ text: "a" }] }),
      story({ text: "S2 final", dependsOn: ["S1"], tasks: [{ text: "b" }] }),
    ])
    const s1t1 = plan.stories[0].tasks[0].id
    const s2t1 = plan.stories[1].tasks[0].id
    expect(plan.finalStoryId).toBe("S2")

    se.checkpoint("s1", s1t1, "complete")
    expect(se.getActiveTasks("s1").map((t) => t.id)).toEqual([s2t1])

    // The final story's task blocks while it is the only active task.
    se.checkpoint("s1", s2t1, "blocked")
    expect(se.getActiveTasks("s1")).toEqual([])
    expect(se.getPlan("s1")!.stories.every((s) => s.status === "complete")).toBe(false)

    se.reopenStory("s1", "S2", { reason: "blocker resolved" })
    expect(se.getActiveTasks("s1").map((t) => t.id)).toEqual([s2t1])

    se.checkpoint("s1", s2t1, "complete")
    expect(se.getPlan("s1")!.stories.map((s) => s.status)).toEqual(["complete", "complete"])
  })
})

// ---------------------------------------------------------------------------
// checkScope across MULTIPLE active-task stories.
// ---------------------------------------------------------------------------

describe("checkScope with multiple active-task stories", () => {
  it("a mutation matching ANY active-task story's globs is in scope", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    se.createPlan("s1", [
      story({ scopeGlobs: ["src/parser/**"], tasks: [{ text: "a" }] }),
      story({ scopeGlobs: ["src/cli/**"], tasks: [{ text: "b" }] }),
    ])

    expect(se.checkScope("s1", "src/parser/lexer.ts")).toBeNull()
    expect(se.checkScope("s1", "src/cli/main.ts")).toBeNull()
  })

  it("a mutation matching NO active-task story's globs is out of scope", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    se.createPlan("s1", [
      story({ scopeGlobs: ["src/parser/**"], tasks: [{ text: "a" }] }),
      story({ scopeGlobs: ["src/cli/**"], tasks: [{ text: "b" }] }),
    ])

    expect(se.checkScope("s1", "docs/readme.md")).toEqual({
      family: "scope-watchdog",
      offer: "fold",
      scopeGlobsMatchedZero: false,
    })
  })

  it("returns null when no task is active anywhere (e.g. a story whose tasks all wait on a predecessor)", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    se.createPlan("s1", [
      story({ scopeGlobs: ["src/parser/**"], tasks: [{ text: "a" }] }),
      // S2's only task depends on S1.T1 → pending → no active-task story for S2.
      story({ scopeGlobs: ["src/cli/**"], tasks: [{ text: "b", dependsOn: ["S1.T1"] }] }),
    ])

    // S1 IS an active-task story, so its globs still apply; but a path
    // matching only S2's globs is out of scope because S2 has no active task.
    expect(se.checkScope("s1", "src/parser/lexer.ts")).toBeNull() // S1 active, matches
    expect(se.checkScope("s1", "src/cli/main.ts")).not.toBeNull() // S2 NOT an active-task story
  })

  it("offers amend first when the caller reports the globs match zero files in the worktree", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    se.createPlan("s1", [story({ scopeGlobs: ["src/parsr/**"], tasks: [{ text: "a" }] })])

    expect(se.checkScope("s1", "src/cli.ts", { scopeGlobsMatchedZero: true })).toEqual({
      family: "scope-watchdog",
      offer: "amend",
      scopeGlobsMatchedZero: true,
    })
  })

  it("returns null when every active-task story has empty globs", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    se.createPlan("s1", [
      story({ scopeGlobs: [], tasks: [{ text: "a" }] }),
      story({ scopeGlobs: [], tasks: [{ text: "b" }] }),
    ])
    expect(se.checkScope("s1", "anything.ts")).toBeNull()
  })

  it("returns null when there is no active task / no plan", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    expect(se.checkScope("no-plan-session", "src/cli.ts")).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// clearPlan — human-facing escape hatch (/elicify-vertex-plan-clear)
// ---------------------------------------------------------------------------

describe("clearPlan (human-facing escape hatch)", () => {
  it("is a no-op returning false when the session has no plan", () => {
    const stateDir = temporaryRoot()
    const { engine: se, logger } = engine(stateDir)
    expect(se.clearPlan("s1")).toBe(false)
    expect(logger).not.toHaveBeenCalledWith("story:plan-cleared", expect.anything())
  })

  it("archives the plan reversibly (never deletes) and removes it from the live plan", () => {
    const stateDir = temporaryRoot()
    const { engine: se, logger } = engine(stateDir)
    const plan = se.createPlan("s1", [story()])

    const cleared = se.clearPlan("s1")

    expect(cleared).toBe(true)
    expect(se.getPlan("s1")).toBeNull()
    expect(logger).toHaveBeenCalledWith("story:plan-cleared", { sessionID: "s1" })

    const archiveDir = join(stateDir, "archive")
    const files = readdirSync(archiveDir).filter((f) => f.startsWith("plan.s1."))
    expect(files).toHaveLength(1)
    const archived = JSON.parse(readFileSync(join(archiveDir, files[0]), "utf8"))
    expect(archived.stories[0].id).toBe(plan.stories[0].id)
  })

  it("clears only the target session's plan, leaving other sessions' plans in plan.json untouched", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    se.createPlan("s1", [story()])
    se.createPlan("s2", [story({ text: "other session's work" })])

    se.clearPlan("s1")

    expect(se.getPlan("s1")).toBeNull()
    expect(se.getPlan("s2")).not.toBeNull()
  })

  it("survives a fresh StoryEngine instance — the clear is durable", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    se.createPlan("s1", [story()])
    se.clearPlan("s1")

    const restarted = new StoryEngine({ stateDir, logger: vi.fn() })
    expect(restarted.getPlan("s1")).toBeNull()
  })
})

// ===========================================================================
// A second `createPlan` must not silently discard the first plan.
// ===========================================================================

describe("createPlan archives the plan it replaces", () => {
  it("keeps a recoverable copy and logs the replacement", () => {
    const events: Array<[string, Record<string, unknown>]> = []
    const root = temporaryRoot()
    const engine = new StoryEngine({
      stateDir: join(root, ".opencode", "elicify-vertex"),
      logger: (event, payload) => events.push([event, payload as Record<string, unknown>]),
    })

    engine.createPlan("s1", [
      {
        text: "migrate the schema",
        acceptanceItems: ["migration applies"],
        scopeGlobs: ["db/**"],
        verifiers: [],
        tasks: [{ text: "write migration" }],
      },
    ])
    engine.createPlan("s1", [
      {
        text: "tidy up",
        acceptanceItems: ["ok"],
        scopeGlobs: ["**"],
        verifiers: [],
        tasks: [{ text: "tidy" }],
      },
    ])

    const archived = readdirSync(join(root, ".opencode", "elicify-vertex", "archive"))
    const planCopies = archived.filter((name) => name.startsWith("plan.s1."))
    expect(planCopies.length, "the replaced plan must be recoverable").toBeGreaterThan(0)
    expect(readFileSync(join(root, ".opencode", "elicify-vertex", "archive", planCopies[0]), "utf8")).toContain(
      "migrate the schema",
    )
    expect(events.map(([event]) => event)).toContain("plan:replaced")
  })

  it("does not archive when there was no prior plan (discrimination)", () => {
    const root = temporaryRoot()
    const engine = new StoryEngine({
      stateDir: join(root, ".opencode", "elicify-vertex"),
      logger: () => {},
    })
    engine.createPlan("fresh", [{ text: "first", acceptanceItems: ["ok"], scopeGlobs: ["**"], verifiers: [], tasks: [{ text: "t" }] }])
    const archiveDir = join(root, ".opencode", "elicify-vertex", "archive")
    const archived = existsSync(archiveDir) ? readdirSync(archiveDir).filter((n) => n.startsWith("plan.fresh.")) : []
    expect(archived, "a first plan replaces nothing").toEqual([])
  })
})

// ---------------------------------------------------------------------------
// plan.json round-trip with the redesign fields: tasks (required),
// dependsOn, completedAt, judge accepted when well-formed, rejected when
// malformed; old plans lacking tasks entirely now FAIL validation (hard
// cutover — tasks ship with this redesign).
// ---------------------------------------------------------------------------

describe("plan.json round-trip with redesign fields", () => {
  it("tasks, dependsOn, completedAt and a judge stamp persist and survive a fresh StoryEngine instance", () => {
    const stateDir = temporaryRoot()
    const { engine: se } = engine(stateDir)
    const plan = se.createPlan("s1", [
      story({
        acceptanceItems: ["A1"],
        tasks: [{ text: "a" }],
        dependsOn: [],
      }),
    ])
    const storyId = plan.stories[0].id
    const taskId = plan.stories[0].tasks[0].id
    se.checkpoint("s1", taskId, "complete")
    se.applyJudgeVerdicts("s1", [{ storyId, pass: true, summary: "verified", items: [{ itemId: "A1", met: true, note: "ok" }] }])

    const restarted = new StoryEngine({ stateDir, logger: vi.fn() })
    const reloaded = restarted.getPlan("s1")!.stories[0]
    expect(reloaded.tasks).toHaveLength(1)
    expect(reloaded.tasks[0].id).toBe(taskId)
    expect(reloaded.dependsOn).toEqual([])
    expect(reloaded.status).toBe("complete")
    expect(typeof reloaded.completedAt).toBe("string")
    expect(reloaded.judge).toMatchObject({ pass: true, summary: "verified", items: [{ itemId: "A1", met: true, note: "ok" }] })
  })

  it("rejects a plan whose story has NO tasks (hard cutover: tasks are required)", () => {
    const stateDir = temporaryRoot()
    mkdirSync(stateDir, { recursive: true })
    const preRedesignPlan = {
      schemaVersion: 2,
      stories: [
        {
          id: "S1",
          text: "pre-task story",
          acceptanceItems: [{ id: "A1", text: "works", evidence: null }],
          scopeGlobs: [],
          verifiers: [],
          assumptions: [],
          rejectedAlternatives: [],
          amendments: [],
          status: "active",
        },
      ],
      finalStoryId: "S1",
      createdAt: new Date().toISOString(),
    }
    writeFileSync(join(stateDir, "plan.json"), JSON.stringify({ s1: preRedesignPlan }))

    const { engine: se } = engine(stateDir)
    expect(se.getPlan("s1")).toBeNull()
  })

  it("accepts a story-level dependsOn that is absent (back-compat: treated as [])", () => {
    const stateDir = temporaryRoot()
    mkdirSync(stateDir, { recursive: true })
    const planNoStoryDeps = {
      schemaVersion: 2,
      stories: [
        {
          id: "S1",
          text: "no story dependsOn key",
          acceptanceItems: [{ id: "A1", text: "works", evidence: null }],
          scopeGlobs: [],
          verifiers: [],
          assumptions: [],
          rejectedAlternatives: [],
          amendments: [],
          status: "active",
          tasks: [{ id: "S1.T1", text: "do it", dependsOn: [], status: "active" }],
        },
      ],
      finalStoryId: "S1",
      createdAt: new Date().toISOString(),
    }
    writeFileSync(join(stateDir, "plan.json"), JSON.stringify({ s1: planNoStoryDeps }))

    const { engine: se } = engine(stateDir)
    const plan = se.getPlan("s1")
    expect(plan).not.toBeNull()
    expect(plan!.stories[0].dependsOn).toEqual([])
  })

  it("rejects a malformed task (present but wrong shape) — the entry is dropped on load", () => {
    const stateDir = temporaryRoot()
    mkdirSync(stateDir, { recursive: true })
    const badPlan = {
      schemaVersion: 2,
      stories: [
        {
          id: "S1",
          text: "bad task",
          acceptanceItems: [],
          scopeGlobs: [],
          verifiers: [],
          assumptions: [],
          rejectedAlternatives: [],
          amendments: [],
          status: "active",
          tasks: [{ id: "S1.T1", text: "", dependsOn: [], status: "active" }], // blank text
        },
      ],
      finalStoryId: "S1",
      createdAt: new Date().toISOString(),
    }
    writeFileSync(join(stateDir, "plan.json"), JSON.stringify({ s1: badPlan }))

    const { engine: se } = engine(stateDir)
    expect(se.getPlan("s1")).toBeNull()
  })

  it("rejects a malformed judge stamp (present but wrong shape)", () => {
    const stateDir = temporaryRoot()
    mkdirSync(stateDir, { recursive: true })
    const badPlan = {
      schemaVersion: 2,
      stories: [
        {
          id: "S1",
          text: "bad judge",
          acceptanceItems: [],
          scopeGlobs: [],
          verifiers: [],
          assumptions: [],
          rejectedAlternatives: [],
          amendments: [],
          status: "complete",
          tasks: [{ id: "S1.T1", text: "ok", dependsOn: [], status: "complete" }],
          judge: { pass: "yes", summary: 42, items: "nope", judgedAt: 123 },
        },
      ],
      finalStoryId: "S1",
      createdAt: new Date().toISOString(),
    }
    writeFileSync(join(stateDir, "plan.json"), JSON.stringify({ s1: badPlan }))

    const { engine: se } = engine(stateDir)
    expect(se.getPlan("s1")).toBeNull()
  })

  it("rejects a task with an invalid status", () => {
    const stateDir = temporaryRoot()
    mkdirSync(stateDir, { recursive: true })
    const badPlan = {
      schemaVersion: 2,
      stories: [
        {
          id: "S1",
          text: "bad status",
          acceptanceItems: [],
          scopeGlobs: [],
          verifiers: [],
          assumptions: [],
          rejectedAlternatives: [],
          amendments: [],
          status: "active",
          tasks: [{ id: "S1.T1", text: "ok", dependsOn: [], status: "not-a-status" }],
        },
      ],
      finalStoryId: "S1",
      createdAt: new Date().toISOString(),
    }
    writeFileSync(join(stateDir, "plan.json"), JSON.stringify({ s1: badPlan }))

    const { engine: se } = engine(stateDir)
    expect(se.getPlan("s1")).toBeNull()
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
    expect(SEQUENCING_WORDS.test("a firstclass citizen")).toBe(false)
  })

  it("IMPERATIVE_VERBS matches an imperative-led clause at the start only", () => {
    expect(IMPERATIVE_VERBS.test("add the parser")).toBe(true)
    expect(IMPERATIVE_VERBS.test("추가 파서")).toBe(true)
    expect(IMPERATIVE_VERBS.test("the parser needs adding")).toBe(false)
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

  it("row 4: 'refactor auth end-to-end' (short but non-trivial) reaches the classifier and issues a subturn", async () => {
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

    expect(client.session.prompt).toHaveBeenCalledTimes(1)
    expect(result.source).toBe("subturn")
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
    const askText = "add tests for this file and fix the failing edge cases"

    const result = await classifyMultiStory(client, deps, { parentSessionID: "s1", sessionModel: SESSION_MODEL, askText })
    const promptArgs = client.session.prompt.mock.calls[0][0] as { body: { parts: Array<{ text: string }> } }
    expect(promptArgs.body.parts).toEqual([{ type: "text", text: askText }])
    expect(result.source).toBe("subturn")
  })

  it("rows 12/13: this module does not self-throttle — each call issues its own subturn attempt", async () => {
    const client = makeIntakeClient()
    const { deps } = classifyDeps()

    await classifyMultiStory(client, deps, { parentSessionID: "s1", sessionModel: SESSION_MODEL, askText: "refactor auth end-to-end" })
    await classifyMultiStory(client, deps, { parentSessionID: "s1", sessionModel: SESSION_MODEL, askText: "refactor billing end-to-end" })

    expect(client.session.prompt).toHaveBeenCalledTimes(2)
  })

  it("row 14: a subturn that never resolves falls back to the heuristic within the total intake budget, logging intake:classify-fallback", async () => {
    vi.useFakeTimers()
    const client = makeIntakeClient({ promptImpl: () => new Promise(() => {}) })
    const { deps, logger } = classifyDeps()

    const resultPromise = classifyMultiStory(client, deps, {
      parentSessionID: "s1",
      sessionModel: SESSION_MODEL,
      askText: "first add the parser, then wire the CLI",
    })
    await vi.advanceTimersByTimeAsync(INTAKE_SUBTURN_TIMEOUT_MS)
    const result = await resultPromise

    expect(result).toEqual({ multiStory: true, source: "heuristic" })
    expect(logger).toHaveBeenCalledWith(
      "intake:classify-fallback",
      expect.objectContaining({ sessionID: "s1", reason: "timeout" }),
    )
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
