/**
 * `elicify_vertex_plan_*` tool wiring after the 2026-07-30 task/DAG redesign
 * (supersedes the wave model; preserves HANDOVER.md points 1 and 5).
 *
 * The atomic unit surfaced to the model is now the TASK. These tests drive
 * the real tool `execute` over a real `StoryEngine` / `PinStore` /
 * `PhaseEngine` on a real temp worktree and pin down, all the way through
 * the JSON the model actually sees:
 *   - create: each story MUST decompose into ≥1 task (+ optional task and
 *     story dependsOn); waves are computed from the DAG, never input;
 *   - next: returns the active TASKS as a JSON array, each enriched with its
 *     parent storyId/storyText, so the model can fan out one subagent per
 *     element;
 *   - checkpoint: takes `{ taskId, status, reason? }`; a story auto-completes
 *     when all its tasks are done; the phase engine is rebound to `execute`
 *     for every story newly activated by promotion;
 *   - a refused checkpoint leaves plan.json byte-for-byte unchanged;
 *   - reopen, status, clear round out the surface.
 *
 * checkpoint remains a CLAIM (HANDOVER.md point 1): no receipt, no waiver,
 * no evidence — the completion verifier audits the claim at session.idle.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { PhaseEngine } from "../../src/v2/phase.js"
import { PinStore } from "../../src/v2/pin.js"
import { StoryEngine, lockIO, type PlanV2 } from "../../src/v2/story.js"
import type { OpencodeClient } from "../../src/v2/types.js"
import { buildPlanTools } from "../../src/v2/wiring/tools.js"
import { freshSessionState, type V2SessionState } from "../../src/v2/wiring/state.js"

const SESSION = "s1"
const roots: string[] = []

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "vertex-tools-"))
  roots.push(root)
  return root
}

/** Minimal client: `PlanToolsDeps` still requires one, but no plan tool
 * touches it anymore — the waiver-provenance path that read
 * `session.messages` was deleted with the citation contract. */
const client = { session: { messages: async () => ({ data: [] }) } } as unknown as OpencodeClient

interface Harness {
  storyEngine: StoryEngine
  tools: ReturnType<typeof buildPlanTools>
  phaseEngine: PhaseEngine
}

/** Build the whole wiring over one worktree. */
function boot(root: string): Harness {
  const stateDir = join(root, ".opencode", "elicify-vertex")
  const logger = (): void => {}
  const storyEngine = new StoryEngine({ stateDir, logger })
  const states = new Map<string, V2SessionState>([[SESSION, freshSessionState(root)]])
  const phaseEngine = new PhaseEngine(logger)
  const tools = buildPlanTools({
    storyEngine,
    pinStore: new PinStore({ stateDir, logger }),
    client,
    states,
    phaseEngine,
    onPlanCreated: () => {},
  })
  return { storyEngine, tools, phaseEngine }
}

/** Input shape for `elicify_vertex_plan_create` — each story MUST carry tasks. */
interface CreateStory {
  text: string
  acceptanceItems: string[]
  tasks: Array<{ text: string; dependsOn?: string[] }>
  scopeGlobs?: string[]
  verifiers?: string[]
  dependsOn?: string[]
}

async function createStories(harness: Harness, stories: CreateStory[]): Promise<void> {
  await harness.tools.elicify_vertex_plan_create.execute(
    {
      stories: stories.map((story) => ({
        scopeGlobs: [],
        verifiers: [],
        dependsOn: [],
        ...story,
        tasks: story.tasks.map((task) => ({ dependsOn: [], ...task })),
      })),
    },
    { sessionID: SESSION } as never,
  )
}

/** Drive `elicify_vertex_plan_checkpoint` and return the parsed plan it
 * hands back — callers assert on the RETURNED plan (what the model sees). */
async function checkpoint(
  harness: Harness,
  taskId: string,
  status: "complete" | "failed" | "blocked",
  reason?: string,
): Promise<PlanV2> {
  const raw = (await harness.tools.elicify_vertex_plan_checkpoint.execute(
    { taskId, status, ...(reason !== undefined ? { reason } : {}) },
    { sessionID: SESSION } as never,
  )) as string
  return JSON.parse(raw) as PlanV2
}

async function blockTask(harness: Harness, taskId: string, reason?: string): Promise<PlanV2> {
  return checkpoint(harness, taskId, "blocked", reason)
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

// ===========================================================================
// checkpoint is a bare completion claim, now on a TASK (redesign point 1,
// task/DAG model).
// ===========================================================================

describe("checkpoint is a bare completion claim on a task", () => {
  // MUTATION PROOF: re-introduce any evidence requirement into the
  // checkpoint tool's `execute` -> this call has nothing to cite and the
  // test goes RED.
  it("completes a task with NO evidence; the parent story auto-completes when its last task is done", async () => {
    const harness = boot(temporaryRoot())
    await createStories(harness, [
      { text: "two-task story", acceptanceItems: ["one"], tasks: [{ text: "a" }, { text: "b" }] },
    ])

    const afterFirst = await checkpoint(harness, "S1.T1", "complete")
    expect(afterFirst.stories[0].status).toBe("active") // S1.T2 still active
    expect(afterFirst.stories[0].tasks.map((t) => t.status)).toEqual(["complete", "active"])
    expect(typeof afterFirst.stories[0].tasks[0].completedAt).toBe("string")

    const afterSecond = await checkpoint(harness, "S1.T2", "complete")
    expect(afterSecond.stories[0].status).toBe("complete") // auto-completed
    expect(typeof afterSecond.stories[0].completedAt).toBe("string")
  })

  // MUTATION PROOF: gate level-promotion in story.ts's checkpoint on the
  // completing task only -> S2.T1 never activates and the assertion goes RED.
  it("promotes the next DAG level (across stories) only when no task remains active", async () => {
    const harness = boot(temporaryRoot())
    await createStories(harness, [
      { text: "S1", acceptanceItems: ["one"], tasks: [{ text: "a" }] },
      { text: "S2", acceptanceItems: ["two"], tasks: [{ text: "b", dependsOn: ["S1.T1"] }, { text: "c", dependsOn: ["S1.T1"] }] },
      { text: "S3", acceptanceItems: ["four"], tasks: [{ text: "d", dependsOn: ["S2.T1", "S2.T2"] }] },
    ])

    const afterS1 = await checkpoint(harness, "S1.T1", "complete")
    expect(afterS1.stories.map((s) => s.status)).toEqual(["complete", "active", "pending"])

    const afterS2T1 = await checkpoint(harness, "S2.T1", "complete")
    expect(afterS2T1.stories[2].tasks[0].status).toBe("pending") // S2.T2 still active

    const afterS2T2 = await checkpoint(harness, "S2.T2", "complete")
    expect(afterS2T2.stories[2].tasks[0].status).toBe("active") // S3.T1 promoted
  })

  // MUTATION PROOF: drop the amendments push for non-complete checkpoints in
  // story.ts -> the amendment assertion goes RED.
  it("records the reason of a blocked task checkpoint as an amendment on the parent story", async () => {
    const harness = boot(temporaryRoot())
    await createStories(harness, [
      { text: "story one", acceptanceItems: ["one"], tasks: [{ text: "a" }, { text: "b" }] },
    ])

    const plan = await blockTask(harness, "S1.T1", "waiting on the upstream API")

    expect(plan.stories[0].tasks[0].status).toBe("blocked")
    expect(plan.stories[0].amendments.map((a) => a.reason)).toEqual(["blocked: waiting on the upstream API"])
    expect(plan.stories[0].tasks[0].completedAt).toBeUndefined()
    // S1.T2 is still active, so the story is not blocked overall.
    expect(plan.stories[0].status).toBe("active")
  })
})

// ===========================================================================
// plan_next returns the active TASKS (one subagent per element), each with
// its parent story id/text for context.
// ===========================================================================

describe("plan_next returns the active tasks", () => {
  // MUTATION PROOF: revert the next tool to return getActiveStories ->
  // the parsed value's elements have no `taskId`/`text` task shape and the
  // shape assertion goes RED.
  it("returns a JSON array of active TASKS, each enriched with storyId/storyText", async () => {
    const harness = boot(temporaryRoot())
    await createStories(harness, [
      { text: "parser", acceptanceItems: ["a"], tasks: [{ text: "t1" }, { text: "t2" }] },
      { text: "cli", acceptanceItems: ["b"], tasks: [{ text: "t3", dependsOn: ["S1.T1"] }] },
    ])

    const raw = (await harness.tools.elicify_vertex_plan_next.execute({}, { sessionID: SESSION } as never)) as string
    const active = JSON.parse(raw) as Array<{ id: string; status: string; storyId: string; storyText: string }>

    expect(Array.isArray(active)).toBe(true)
    // S1.T1, S1.T2 are level 0; S2.T1 depends on S1.T1 -> pending.
    expect(active.map((t) => t.id)).toEqual(["S1.T1", "S1.T2"])
    expect(active.every((t) => t.status === "active")).toBe(true)
    expect(active.every((t) => t.storyId === "S1")).toBe(true)
    expect(active.every((t) => t.storyText === "parser")).toBe(true)
  })

  it("returns [] when no task is active (e.g. every task waiting on a predecessor)", async () => {
    const harness = boot(temporaryRoot())
    await createStories(harness, [
      { text: "S1", acceptanceItems: ["a"], tasks: [{ text: "a" }] },
      { text: "S2", acceptanceItems: ["b"], tasks: [{ text: "b", dependsOn: ["S1.T1"] }] },
    ])
    // Complete S1.T1 -> S2.T1 promotes. Then complete S2.T1 -> nothing active.
    await checkpoint(harness, "S1.T1", "complete")
    await checkpoint(harness, "S2.T1", "complete")

    const raw = (await harness.tools.elicify_vertex_plan_next.execute({}, { sessionID: SESSION } as never)) as string
    expect(JSON.parse(raw)).toEqual([])
  })
})

// ===========================================================================
// plan_create: tasks are required, dependsOn drives the computed waves, and
// the wave argument is GONE. Plus the reflective planning challenge still
// rides first in the returned JSON.
// ===========================================================================

describe("plan_create requires tasks and computes waves from the DAG", () => {
  // MUTATION PROOF: drop the `.min(1)` on the tasks schema (or make createPlan
  // accept empty tasks) -> the create succeeds and this rejects-assertion RED.
  it("rejects a story with no tasks and creates no plan", async () => {
    const harness = boot(temporaryRoot())
    await expect(
      harness.tools.elicify_vertex_plan_create.execute(
        {
          stories: [
            { text: "no tasks", acceptanceItems: ["a"], scopeGlobs: [], verifiers: [], dependsOn: [], tasks: [] },
          ],
        },
        { sessionID: SESSION } as never,
      ),
    ).rejects.toThrow(/at least one task/)
    expect(harness.storyEngine.getPlan(SESSION)).toBeNull()
  })

  it("rejects a dangling task dependsOn and creates no plan", async () => {
    const harness = boot(temporaryRoot())
    await expect(
      harness.tools.elicify_vertex_plan_create.execute(
        {
          stories: [
            {
              text: "bad dep",
              acceptanceItems: ["a"],
              scopeGlobs: [],
              verifiers: [],
              dependsOn: [],
              tasks: [{ text: "t", dependsOn: ["S1.T9"] }],
            },
          ],
        },
        { sessionID: SESSION } as never,
      ),
    ).rejects.toThrow(/unknown story or task: S1\.T9/)
    expect(harness.storyEngine.getPlan(SESSION)).toBeNull()
  })

  it("rejects a dependency cycle and creates no plan", async () => {
    const harness = boot(temporaryRoot())
    await expect(
      harness.tools.elicify_vertex_plan_create.execute(
        {
          stories: [
            {
              text: "cycle",
              acceptanceItems: ["a"],
              scopeGlobs: [],
              verifiers: [],
              dependsOn: [],
              tasks: [
                { text: "a", dependsOn: ["S1.T2"] },
                { text: "b", dependsOn: ["S1.T1"] },
              ],
            },
          ],
        },
        { sessionID: SESSION } as never,
      ),
    ).rejects.toThrow(/plan dependency cycle:/)
    expect(harness.storyEngine.getPlan(SESSION)).toBeNull()
  })

  it("story-dependsOn-story gates a successor story's tasks until the predecessor is fully done", async () => {
    const harness = boot(temporaryRoot())
    await createStories(harness, [
      { text: "S1", acceptanceItems: ["a"], tasks: [{ text: "a" }, { text: "b" }] },
      { text: "S2", acceptanceItems: ["c"], dependsOn: ["S1"], tasks: [{ text: "c" }] },
    ])

    const plan = harness.storyEngine.getPlan(SESSION)!
    expect(plan.stories[0].tasks.map((t) => t.status)).toEqual(["active", "active"])
    expect(plan.stories[1].tasks.map((t) => t.status)).toEqual(["pending"]) // gated by story dep

    // Completing only one S1 task keeps S2 gated.
    await checkpoint(harness, "S1.T1", "complete")
    expect(harness.storyEngine.getPlan(SESSION)!.stories[1].tasks[0].status).toBe("pending")
    // Completing the other activates S2.T1.
    await checkpoint(harness, "S1.T2", "complete")
    expect(harness.storyEngine.getPlan(SESSION)!.stories[1].tasks[0].status).toBe("active")
  })
})

// ===========================================================================
// The reflective planning challenge (AC-1..AC-5) — unchanged apparatus, still
// rides FIRST in the create tool's JSON return, still writes nothing to disk.
// ===========================================================================

interface CreatedPlan {
  raw: string
  parsed: { planningChallenge?: string[]; schemaVersion?: number; stories?: Array<{ id: string }>; finalStoryId?: string }
  challenge: string
  challengeLines: string[]
}

async function createPlanVia(
  harness: Harness,
  stories: Array<{ text: string; acceptanceItems: string[]; tasks: Array<{ text: string }> }>,
): Promise<CreatedPlan> {
  const raw = (await harness.tools.elicify_vertex_plan_create.execute(
    {
      stories: stories.map((story) => ({
        ...story,
        scopeGlobs: [],
        verifiers: [],
        dependsOn: [],
        tasks: story.tasks.map((task) => ({ text: task.text, dependsOn: [] })),
      })),
    },
    { sessionID: SESSION } as never,
  )) as string
  const parsed = JSON.parse(raw) as CreatedPlan["parsed"]
  const challengeLines = parsed.planningChallenge ?? []
  return { raw, parsed, challenge: challengeLines.join("\n"), challengeLines }
}

describe("plan_create returns a reflective planning challenge", () => {
  it("asks what the plan is grounded in and NAMES the remedy with exact tool calls (AC-1, AC-2b)", async () => {
    const harness = boot(temporaryRoot())
    const { challenge } = await createPlanVia(harness, [
      { text: "build the admin console", acceptanceItems: ["it works"], tasks: [{ text: "scaffold" }] },
      { text: "wire the approval workflow", acceptanceItems: ["done"], tasks: [{ text: "wire" }] },
    ])

    expect(challenge).toMatch(/grounded, or guessed/i)
    expect(challenge).toMatch(/research and user interview/i)
    expect(challenge).toMatch(/unknowns/i)
    expect(challenge).toMatch(/question tool/i)
    expect(challenge).toMatch(/research it/i)
    expect(challenge).toContain("elicify_vertex_plan_clear")
    expect(challenge).toContain("elicify_vertex_plan_create")
    expect(challenge).toMatch(/archived/i)
    expect(challenge).toMatch(/never deleted/i)
  })

  it("names the stories whose acceptance items are vague (AC-2)", async () => {
    const harness = boot(temporaryRoot())
    const { challenge } = await createPlanVia(harness, [
      { text: "port the parser", acceptanceItems: ["npx vitest run tests/parser.test.ts exits 0"], tasks: [{ text: "port" }] },
      { text: "ship a mature UI", acceptanceItems: ["it works", "looks good"], tasks: [{ text: "ship" }] },
    ])

    expect(challenge).toMatch(/S2 \(ship a mature UI\)/)
    expect(challenge).toContain('"it works"')
    expect(challenge).toContain('"looks good"')
    expect(challenge).not.toMatch(/S1 \(port the parser\)/)
  })

  it("gives a trivial plan the short form (AC-4)", async () => {
    const trivial = await createPlanVia(boot(temporaryRoot()), [
      { text: "fix the off-by-one", acceptanceItems: ["npx vitest run exits 0 with 3 tests passing"], tasks: [{ text: "fix" }] },
    ])
    expect(trivial.challenge).not.toContain("elicify_vertex_plan_clear")
    expect(trivial.challengeLines.length).toBeLessThan(4)
    expect(trivial.challenge).toMatch(/guessed/i)
  })

  it("still returns a parseable plan and writes nothing extra to plan.json (AC-3, AC-5)", async () => {
    const root = temporaryRoot()
    const harness = boot(root)
    const created = await createPlanVia(harness, [
      { text: "story one", acceptanceItems: ["it works"], tasks: [{ text: "do" }] },
      { text: "story two", acceptanceItems: ["fine"], tasks: [{ text: "do" }] },
    ])

    expect(created.parsed.schemaVersion).toBe(2)
    expect(created.parsed.stories?.map((story) => story.id)).toEqual(["S1", "S2"])
    expect(created.parsed.finalStoryId).toBe("S2")
    expect(harness.storyEngine.getPlan(SESSION)?.stories[0].status).toBe("active")

    const persisted = readFileSync(join(root, ".opencode", "elicify-vertex", "plan.json"), "utf8")
    expect(persisted).not.toContain("planningChallenge")
    expect(persisted).not.toContain("grounded")
  })
})

// ===========================================================================
// A refused checkpoint leaves plan.json byte-for-byte unchanged — validation
// happens BEFORE any mutation.
// ===========================================================================

describe("a refused checkpoint leaves plan.json byte-for-byte unchanged", () => {
  // MUTATION PROOF: move the not-active guard below the status mutation in
  // story.ts -> the out-of-order complete succeeds, mutates the file, and RED.
  it("refuses to complete a task that is not active, and writes nothing", async () => {
    const root = temporaryRoot()
    const harness = boot(root)
    await createStories(harness, [
      {
        text: "story one",
        acceptanceItems: ["one"],
        tasks: [{ text: "first" }, { text: "second", dependsOn: ["S1.T1"] }],
      },
    ])
    const planPath = join(root, ".opencode", "elicify-vertex", "plan.json")
    const before = readFileSync(planPath, "utf8")

    await expect(checkpoint(harness, "S1.T2", "complete")).rejects.toThrow(/not active/)

    expect(readFileSync(planPath, "utf8")).toBe(before)
    expect(harness.storyEngine.getPlan(SESSION)?.stories[0].tasks.map((t) => t.status)).toEqual(["active", "pending"])
  })
})

// ===========================================================================
// T8 (FR-001), task/wave-aware: when promotion activates a story's first
// task, the checkpoint tool rebinds that story's phase to `execute` so its
// slot does not read a stale default until its first mutation.
// ===========================================================================

describe("phase rebinding when a story's first task activates", () => {
  // MUTATION PROOF: in the checkpoint tool, rebind only stories that were
  // already active (drop the `!activeBefore.has` guard) -> S2's phase is never
  // touched and stays "intake" -> RED.
  it("rebinds phase to execute for every story newly activated by promotion", async () => {
    const harness = boot(temporaryRoot())
    await createStories(harness, [
      { text: "S1", acceptanceItems: ["one"], tasks: [{ text: "a" }] },
      { text: "S2", acceptanceItems: ["two"], tasks: [{ text: "b", dependsOn: ["S1.T1"] }] },
    ])
    expect(harness.phaseEngine.getPhase(SESSION, "S2")).toBe("intake")

    await checkpoint(harness, "S1.T1", "complete")

    expect(harness.phaseEngine.getPhase(SESSION, "S2")).toBe("execute")
  })

  // MUTATION PROOF: drop the `activeBefore` diff so phase is rebound for EVERY
  // active story after a checkpoint -> S1.T2's story phase is forced back and RED.
  it("does NOT rebind a story that was already active before the checkpoint", async () => {
    const harness = boot(temporaryRoot())
    await createStories(harness, [
      { text: "S1", acceptanceItems: ["a"], tasks: [{ text: "a" }, { text: "b" }] },
    ])
    // Drive S1 past execute while both its tasks are active.
    harness.phaseEngine.onMutation(SESSION, "S1")
    harness.phaseEngine.onVerifierOutcome(SESSION, "S1", { success: true, coversFinalStory: true })
    expect(harness.phaseEngine.getPhase(SESSION, "S1")).toBe("elevate")

    // Completing S1.T1 leaves S1.T2 active, so S1 is still an active-task story;
    // its phase must be left where the verifier arc put it.
    await checkpoint(harness, "S1.T1", "complete")
    expect(harness.phaseEngine.getPhase(SESSION, "S1")).toBe("elevate")
  })
})

// ===========================================================================
// elicify_vertex_plan_reopen (C-6): the recovery path for a blocked story,
// driven through the tool's own execute. reopenStory now re-activates a
// story's not-complete tasks per the DAG level rule.
// ===========================================================================

describe("elicify_vertex_plan_reopen tool", () => {
  it("is registered in the tool map alongside the other plan tools and the star tool", () => {
    const harness = boot(temporaryRoot())
    expect(Object.keys(harness.tools).sort()).toEqual([
      "elicify_vertex_plan_checkpoint",
      "elicify_vertex_plan_clear",
      "elicify_vertex_plan_create",
      "elicify_vertex_plan_next",
      "elicify_vertex_plan_reopen",
      "elicify_vertex_plan_status",
      "elicify_vertex_star",
    ])
  })

  it("reopens a blocked story, called through the tool's execute (not storyEngine.reopenStory directly)", async () => {
    const harness = boot(temporaryRoot())
    await createStories(harness, [{ text: "story one", acceptanceItems: ["one"], tasks: [{ text: "a" }] }])
    await blockTask(harness, "S1.T1")
    expect(harness.storyEngine.getPlan(SESSION)?.stories[0].status).toBe("blocked")

    const raw = (await harness.tools.elicify_vertex_plan_reopen.execute(
      { storyId: "S1", reason: "the missing dependency now exists" },
      { sessionID: SESSION } as never,
    )) as string
    const parsed = JSON.parse(raw) as { storyId: string; newStatus: string; becameActive: boolean }

    expect(parsed.newStatus).toBe("active")
    expect(parsed.becameActive).toBe(true)
    expect(harness.storyEngine.getPlan(SESSION)?.stories[0].status).toBe("active")
    expect(harness.storyEngine.getActiveTasks(SESSION).map((t) => t.id)).toEqual(["S1.T1"])
  })

  it("errors on an unknown storyId, mirroring StoryEngine.reopenStory's own error", async () => {
    const harness = boot(temporaryRoot())
    await createStories(harness, [{ text: "story one", acceptanceItems: ["one"], tasks: [{ text: "a" }] }])
    await expect(
      harness.tools.elicify_vertex_plan_reopen.execute(
        { storyId: "S99", reason: "does not matter" },
        { sessionID: SESSION } as never,
      ),
    ).rejects.toThrow(/unknown story: S99/)
  })

  it("resumes with a fresh startedAt and a recorded amendment, and leaves acceptance evidence untouched", async () => {
    const harness = boot(temporaryRoot())
    await createStories(harness, [{ text: "story one", acceptanceItems: ["one"], tasks: [{ text: "a" }] }])
    harness.storyEngine.attachEvidence(SESSION, "S1", "A1", { receiptId: "vrf_legacy" })
    await blockTask(harness, "S1.T1")
    await harness.tools.elicify_vertex_plan_reopen.execute(
      { storyId: "S1", reason: "the dependency now exists" },
      { sessionID: SESSION } as never,
    )

    const story = harness.storyEngine.getPlan(SESSION)!.stories[0]
    expect(story.status).toBe("active")
    expect(story.tasks[0].status).toBe("active")
    expect(typeof story.tasks[0].startedAt).toBe("string")
    expect(story.completedAt).toBeUndefined()
    expect(story.amendments.map((a) => a.reason)).toContain("reopened from blocked: the dependency now exists")
    expect(story.acceptanceItems[0].evidence).toEqual({ receiptId: "vrf_legacy" })
  })

  // C-12: a story whose phase reached "close" before it blocked is back at
  // "execute" after reopen (the tool calls onStoryAdvance to force the slot).
  it("a story whose phase reached close before it blocked is back at execute after reopen", async () => {
    const harness = boot(temporaryRoot())
    await createStories(harness, [{ text: "the only story", acceptanceItems: ["done"], tasks: [{ text: "a" }] }])

    harness.phaseEngine.onMutation(SESSION, "S1")
    harness.phaseEngine.onVerifierOutcome(SESSION, "S1", { success: true, coversFinalStory: true })
    harness.phaseEngine.onIdle(SESSION, "S1", { criteriaAllEvidenced: true, hasPins: true, unverifiedChangesExist: false })
    expect(harness.phaseEngine.getPhase(SESSION, "S1")).toBe("close")

    await blockTask(harness, "S1.T1")
    await harness.tools.elicify_vertex_plan_reopen.execute(
      { storyId: "S1", reason: "root cause identified and resolved" },
      { sessionID: SESSION } as never,
    )

    expect(harness.storyEngine.getActiveTasks(SESSION).map((t) => t.id)).toEqual(["S1.T1"])
    expect(harness.phaseEngine.getPhase(SESSION, "S1")).toBe("execute")
  })
})

// ===========================================================================
// C-6 end-to-end through the real tool surface: a blocked final story can be
// reopened and re-completed, and the plan reaches all-complete.
// ===========================================================================

describe("C-6 end-to-end: a blocked final story can be reopened and the plan reaches all-complete", () => {
  it("recovers a plan stuck on a blocked final story via elicify_vertex_plan_reopen", async () => {
    const harness = boot(temporaryRoot())
    await createStories(harness, [
      { text: "story one", acceptanceItems: ["one"], tasks: [{ text: "a" }] },
      { text: "story two (final)", acceptanceItems: ["two"], dependsOn: ["S1"], tasks: [{ text: "b" }] },
    ])

    await checkpoint(harness, "S1.T1", "complete")
    expect(harness.storyEngine.getPlan(SESSION)?.finalStoryId).toBe("S2")
    expect(harness.storyEngine.getActiveTasks(SESSION).map((t) => t.id)).toEqual(["S2.T1"])

    await blockTask(harness, "S2.T1")
    expect(harness.storyEngine.getActiveTasks(SESSION)).toEqual([])

    const reopenRaw = (await harness.tools.elicify_vertex_plan_reopen.execute(
      { storyId: "S2", reason: "the blocking dependency shipped upstream" },
      { sessionID: SESSION } as never,
    )) as string
    expect((JSON.parse(reopenRaw) as { newStatus: string }).newStatus).toBe("active")

    await checkpoint(harness, "S2.T1", "complete")

    const finalPlan = harness.storyEngine.getPlan(SESSION)
    expect(finalPlan?.stories.map((s) => s.status)).toEqual(["complete", "complete"])
  })
})

// ===========================================================================
// plan_status / plan_clear round out the surface — status returns the whole
// plan (now including tasks); clear archives + drops the session entry.
// ===========================================================================

describe("plan_status and plan_clear", () => {
  it("plan_status returns the whole plan, including each story's tasks and their statuses", async () => {
    const harness = boot(temporaryRoot())
    await createStories(harness, [
      { text: "S1", acceptanceItems: ["a"], tasks: [{ text: "a" }, { text: "b", dependsOn: ["S1.T1"] }] },
    ])

    const raw = (await harness.tools.elicify_vertex_plan_status.execute({}, { sessionID: SESSION } as never)) as string
    const plan = JSON.parse(raw) as PlanV2

    expect(plan.schemaVersion).toBe(2)
    expect(plan.stories[0].tasks.map((t) => [t.id, t.status])).toEqual([
      ["S1.T1", "active"],
      ["S1.T2", "pending"],
    ])
  })

  it("plan_clear archives the plan and drops the session entry; a follow-up status is null", async () => {
    const harness = boot(temporaryRoot())
    await createStories(harness, [{ text: "S1", acceptanceItems: ["a"], tasks: [{ text: "a" }] }])

    const raw = (await harness.tools.elicify_vertex_plan_clear.execute({}, { sessionID: SESSION } as never)) as string
    expect(JSON.parse(raw)).toEqual({ planCleared: true, pinsCleared: false })

    const statusRaw = (await harness.tools.elicify_vertex_plan_status.execute({}, { sessionID: SESSION } as never)) as string
    expect(JSON.parse(statusRaw)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// MAJ-1 / C3 (grill round 3) — a write that did not reach disk must not be
// reported as a success.
//
// C3 added `consumeWriteAbort`, but wired it into `checkpoint` only. An
// aborted `plan_create` still returned the new plan while the OLD one sat on
// disk (it comes back on the next hydrate), and an aborted `plan_clear` still
// returned `planCleared: true` against a plan that was never removed.
// ---------------------------------------------------------------------------
describe("MAJ-1: the plan tools surface an aborted write", () => {
  /** Make every lock acquisition fail, the way a peer instance holding it does. */
  function jamTheLock(): () => void {
    const acquire = vi.spyOn(lockIO, "acquire").mockImplementation(() => {
      throw new Error("elicify-vertex state directory is locked by another process")
    })
    const sleep = vi.spyOn(lockIO, "sleep").mockImplementation(() => {})
    return () => {
      acquire.mockRestore()
      sleep.mockRestore()
    }
  }

  it("checkpoint reports persisted:false", async () => {
    const h = boot(temporaryRoot())
    await createStories(h, [{ text: "ship", acceptanceItems: ["A1"], tasks: [{ text: "do it" }] }])
    const release = jamTheLock()
    const out = JSON.parse(
      (await h.tools.elicify_vertex_plan_checkpoint.execute({ taskId: "S1.T1", status: "complete" }, { sessionID: SESSION } as never)) as string,
    ) as { persisted?: boolean; warning?: string }
    release()
    expect(out.persisted).toBe(false)
    expect(out.warning).toMatch(/could NOT be written to disk/)
  })

  it("plan_clear reports persisted:false instead of a bare planCleared:true", async () => {
    const h = boot(temporaryRoot())
    await createStories(h, [{ text: "ship", acceptanceItems: ["A1"], tasks: [{ text: "do it" }] }])
    const release = jamTheLock()
    const out = JSON.parse(
      (await h.tools.elicify_vertex_plan_clear.execute({}, { sessionID: SESSION } as never)) as string,
    ) as { planCleared?: boolean; persisted?: boolean; warning?: string }
    release()
    expect(out.persisted).toBe(false)
    expect(out.warning).toMatch(/still on disk and will reappear/)
  })

  it("plan_create reports persisted:false instead of returning the plan as saved", async () => {
    const h = boot(temporaryRoot())
    const release = jamTheLock()
    const out = JSON.parse(
      (await h.tools.elicify_vertex_plan_create.execute(
        { stories: [{ text: "ship", acceptanceItems: ["A1"], scopeGlobs: [], verifiers: [], dependsOn: [], tasks: [{ text: "do it", dependsOn: [] }] }] },
        { sessionID: SESSION } as never,
      )) as string,
    ) as { persisted?: boolean; warning?: string }
    release()
    expect(out.persisted).toBe(false)
    expect(out.warning).toMatch(/could NOT be written to disk/)
  })

  // MAJ-2: the flag is per-mutation, not a sticky session property. An
  // aborted reopen used to make the NEXT checkpoint — which persisted fine —
  // tell the model to re-run a write that had already landed.
  it("does not report a stale abort against a later write that succeeded", async () => {
    const h = boot(temporaryRoot())
    await createStories(h, [{ text: "ship", acceptanceItems: ["A1"], tasks: [{ text: "do it" }, { text: "and this" }] }])
    const release = jamTheLock()
    h.storyEngine.checkpoint(SESSION, "S1.T1", "complete") // aborts
    release()

    const out = JSON.parse(
      (await h.tools.elicify_vertex_plan_checkpoint.execute({ taskId: "S1.T2", status: "complete" }, { sessionID: SESSION } as never)) as string,
    ) as { persisted?: boolean }
    expect(out.persisted).toBeUndefined()
  })
})
