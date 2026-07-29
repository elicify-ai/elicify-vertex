/**
 * `elicify_vertex_plan_checkpoint` <-> persisted verification receipts
 * (src/v2/wiring/tools.ts's `isFreshReceipt`).
 *
 * `isFreshReceipt` is module-private on purpose, so these tests drive it the
 * way production does: through the real checkpoint tool, over a real
 * `StoryEngine` / `PinStore` / `VerificationReceiptStore` on a real temp
 * worktree. A "process restart" is modelled by rebuilding every stateful
 * object over the same directory — which is exactly what a restart is: the
 * in-memory Maps start empty and only what reached disk survives.
 *
 * The two behaviours under test are opposites, and both matter:
 *   - a legitimately still-valid receipt from an EARLIER process is accepted
 *     (otherwise persistence is inert and the harness re-demands proof), and
 *   - a receipt whose worktree has moved on is REFUSED (otherwise persistence
 *     is an evidence-fabrication vector, which is worse than not persisting).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { VerificationReceiptStore, type VerificationReceipt } from "../../src/goals.js"
import { PhaseEngine } from "../../src/v2/phase.js"
import { PinStore } from "../../src/v2/pin.js"
import { StoryEngine } from "../../src/v2/story.js"
import type { OpencodeClient } from "../../src/v2/types.js"
import { buildPlanTools } from "../../src/v2/wiring/tools.js"
import { freshSessionState, type V2SessionState } from "../../src/v2/wiring/state.js"

const SESSION = "s1"
const roots: string[] = []

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "vertex-tools-"))
  roots.push(root)
  writeFileSync(join(root, "src.ts"), "export const answer = 42\n", "utf8")
  return root
}

/** Minimal client: the checkpoint tool only touches `session.messages` on the
 * waiver path, and none of these tests use a waiver. */
const client = { session: { messages: async () => ({ data: [] }) } } as unknown as OpencodeClient

interface Harness {
  storyEngine: StoryEngine
  receipts: VerificationReceiptStore
  tools: ReturnType<typeof buildPlanTools>
  phaseEngine: PhaseEngine
}

/** Build (or REBUILD, i.e. restart) the whole wiring over one worktree. */
function boot(root: string): Harness {
  const stateDir = join(root, ".opencode", "elicify-vertex")
  const logger = (): void => {}
  const storyEngine = new StoryEngine({ stateDir, logger })
  const receipts = new VerificationReceiptStore()
  const states = new Map<string, V2SessionState>([[SESSION, freshSessionState(root)]])
  const phaseEngine = new PhaseEngine(logger)
  const tools = buildPlanTools({
    storyEngine,
    pinStore: new PinStore({ stateDir, logger }),
    verificationReceipts: receipts,
    client,
    states,
    phaseEngine,
    onPlanCreated: () => {},
  })
  return { storyEngine, receipts, tools, phaseEngine }
}

function mintReceipt(
  receipts: VerificationReceiptStore,
  root: string,
  scope?: { storyId?: string | null; paths?: readonly string[] },
): VerificationReceipt {
  return receipts.record({
    sessionID: SESSION,
    workspaceRoot: root,
    command: "npx vitest run",
    exitCode: 0,
    outcome: "verified",
    outputSummary: "992 passed",
    observedAt: new Date().toISOString(),
    ...(scope ? { scope } : {}),
  })
}

async function checkpoint(harness: Harness, storyId: string, receiptId: string): Promise<void> {
  await harness.tools.elicify_vertex_plan_checkpoint.execute(
    { storyId, status: "complete", items: [{ id: "A1", receiptId }] },
    { sessionID: SESSION } as never,
  )
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("checkpoint with persisted verification receipts", () => {
  // MUTATION PROOF: delete the `deps.verificationReceipts.load(sessionID,
  // state.workspaceRoot)` call in `isFreshReceipt` -> the restarted store
  // never hydrates, `get()` returns null, and the checkpoint throws
  // "not an observed receipt" -> RED.
  it("accepts a receipt observed before a restart when nothing has changed since", async () => {
    const root = temporaryRoot()
    const first = boot(root)
    first.storyEngine.createPlan(SESSION, [
      { text: "ship it", acceptanceItems: ["tests pass"], scopeGlobs: ["src/**"], verifiers: ["npx vitest run"] },
    ])
    const minted = mintReceipt(first.receipts, root)
    expect(minted.scope?.storyId).toBe("S1")

    // --- process restart: fresh engines, same worktree ---
    const second = boot(root)
    await checkpoint(second, "S1", minted.id)

    expect(second.storyEngine.getPlan(SESSION)?.stories[0].status).toBe("complete")
  })

  // MUTATION PROOF: make `VerificationReceiptStore.isStale()` return `false`
  // unconditionally (or delete its `current.digest !== scope.worktreeDigest`
  // comparison) -> the checkpoint succeeds against changed code -> RED. This
  // is the whole reason persistence is safe to ship.
  it("refuses the same receipt after a file in the worktree changed", async () => {
    const root = temporaryRoot()
    const first = boot(root)
    first.storyEngine.createPlan(SESSION, [
      { text: "ship it", acceptanceItems: ["tests pass"], scopeGlobs: ["src/**"], verifiers: ["npx vitest run"] },
    ])
    const minted = mintReceipt(first.receipts, root)

    // The code moves on while no harness process is running.
    writeFileSync(join(root, "src.ts"), "export const answer = 43 // regression\n", "utf8")

    const second = boot(root)
    await expect(checkpoint(second, "S1", minted.id)).rejects.toThrow(/not an observed receipt/i)
    expect(second.storyEngine.getPlan(SESSION)?.stories[0].status).toBe("active")
  })

  // MUTATION PROOF: delete the
  // `if (plan && (receipt.scope?.storyId ?? null) !== storyId) return false`
  // line in `isFreshReceipt` -> S1's receipt closes S2 -> RED.
  //
  // The receipt is minted WHILE S2 is active but explicitly linked to S1, so
  // its `observedAt` sits after S2's `startedAt`. That matters: it means the
  // pre-existing "receipt predates the story" time bound cannot be what
  // rejects it, and the story link is the only thing standing between S1's
  // proof and S2's checkpoint.
  it("refuses a receipt linked to another story, and accepts the one linked to this story", async () => {
    const root = temporaryRoot()
    const harness = boot(root)
    harness.storyEngine.createPlan(SESSION, [
      { text: "story one", acceptanceItems: ["one"], scopeGlobs: [], verifiers: [] },
      { text: "story two", acceptanceItems: ["two"], scopeGlobs: [], verifiers: [] },
    ])

    const forS1 = mintReceipt(harness.receipts, root)
    expect(forS1.scope?.storyId).toBe("S1")
    await checkpoint(harness, "S1", forS1.id)
    expect(harness.storyEngine.getActiveStory(SESSION)?.id).toBe("S2")

    const stillLinkedToS1 = mintReceipt(harness.receipts, root, { storyId: "S1" })
    await expect(checkpoint(harness, "S2", stillLinkedToS1.id)).rejects.toThrow(/not an observed receipt/i)

    const forS2 = mintReceipt(harness.receipts, root)
    expect(forS2.scope?.storyId).toBe("S2")
    await checkpoint(harness, "S2", forS2.id)
    expect(harness.storyEngine.getPlan(SESSION)?.stories[1].status).toBe("complete")
  })

  // MUTATION PROOF: change that same story-link line to
  // `if (plan && receipt.scope?.storyId != null && receipt.scope.storyId !== storyId)`
  // -> an unlinked receipt is accepted under a plan -> RED. A receipt minted
  // on the no-plan path is evidence for the worktree, not for any story, so it
  // must not be able to close one.
  it("refuses a receipt with no story link once a plan exists", async () => {
    const root = temporaryRoot()
    const harness = boot(root)
    harness.storyEngine.createPlan(SESSION, [
      { text: "ship it", acceptanceItems: ["tests pass"], scopeGlobs: [], verifiers: [] },
    ])
    const unlinked = mintReceipt(harness.receipts, root, { storyId: null })

    await expect(checkpoint(harness, "S1", unlinked.id)).rejects.toThrow(/not an observed receipt/i)
  })

  // MUTATION PROOF: revert `VerificationReceiptStore.invalidate()` to
  // memory-only (drop its `this.persist(sessionID)` call) -> the retired
  // receipt is resurrected by the restart and the checkpoint succeeds -> RED.
  it("does not let a restart resurrect a receipt invalidated by a mutation", async () => {
    const root = temporaryRoot()
    const first = boot(root)
    first.storyEngine.createPlan(SESSION, [
      { text: "ship it", acceptanceItems: ["tests pass"], scopeGlobs: [], verifiers: [] },
    ])
    const minted = mintReceipt(first.receipts, root)
    // What plugin.ts does on every mutating tool call / file.edited event.
    first.receipts.invalidate(SESSION)

    const second = boot(root)
    await expect(checkpoint(second, "S1", minted.id)).rejects.toThrow(/not an observed receipt/i)
  })
})

// ===========================================================================
// The reflective planning challenge
// (docs/REQUIREMENTS-CLARIFICATION-BEFORE-PLAN.md, AC-1..AC-5)
// ===========================================================================

interface CreatedPlan {
  raw: string
  parsed: { planningChallenge?: string[]; schemaVersion?: number; stories?: Array<{ id: string }>; finalStoryId?: string }
  /** The challenge lines joined — asserted on by CONTENT, never by length. */
  challenge: string
  challengeLines: string[]
}

async function createPlanVia(
  harness: Harness,
  stories: Array<{ text: string; acceptanceItems: string[] }>,
): Promise<CreatedPlan> {
  const raw = (await harness.tools.elicify_vertex_plan_create.execute(
    { stories: stories.map((story) => ({ ...story, scopeGlobs: [], verifiers: [] })) },
    { sessionID: SESSION } as never,
  )) as string
  const parsed = JSON.parse(raw) as CreatedPlan["parsed"]
  const challengeLines = parsed.planningChallenge ?? []
  return { raw, parsed, challenge: challengeLines.join("\n"), challengeLines }
}

describe("plan_create returns a reflective planning challenge", () => {
  // MUTATION PROOF: delete the `lines.push("If material questions remain, ...")`
  // block at the end of `buildPlanningChallenge` in src/v2/wiring/tools.ts (the
  // three numbered remedies + the closing "Proceeding is also a valid answer"
  // line) -> the question is still asked but the escape route is gone, and this
  // test goes red on `elicify_vertex_plan_clear`. Verified red, then restored.
  it("asks what the plan is grounded in and NAMES the remedy with exact tool calls (AC-1, AC-2b)", async () => {
    const harness = boot(temporaryRoot())
    const { challenge } = await createPlanVia(harness, [
      { text: "build the admin console", acceptanceItems: ["it works"] },
      { text: "wire the approval workflow", acceptanceItems: ["done"] },
    ])

    // AC-1: grounded-or-guessed, research/user interview, unknowns eliminated.
    expect(challenge).toMatch(/grounded, or guessed/i)
    expect(challenge).toMatch(/research and user interview/i)
    expect(challenge).toMatch(/unknowns/i)

    // AC-2b: all three remedies, by their exact tool names.
    expect(challenge).toMatch(/question tool/i)
    expect(challenge).toMatch(/research it/i)
    expect(challenge).toContain("elicify_vertex_plan_clear")
    expect(challenge).toContain("elicify_vertex_plan_create")

    // AC-2b: clearing ARCHIVES, it does not destroy. Verified against
    // src/v2/story.ts (`clearPlan` and `createPlan`'s replace path both call
    // `archivePlan`) as of 57dcc3f -- without this the model reads re-planning
    // as destructive and will not do it.
    expect(challenge).toMatch(/archived/i)
    expect(challenge).toMatch(/never deleted/i)
  })

  // MUTATION PROOF: make `isVagueAcceptanceItem` in src/v2/wiring/tools.ts
  // `return false` unconditionally -> `flagged` is empty, no story is named,
  // and both plans get byte-identical boilerplate -> red on the S2 assertion
  // AND on the two-plans-differ assertion. Verified red, then restored.
  it("names the stories whose acceptance items are vague, and is not identical boilerplate (AC-2)", async () => {
    const harness = boot(temporaryRoot())
    const { challenge } = await createPlanVia(harness, [
      { text: "port the parser", acceptanceItems: ["npx vitest run tests/parser.test.ts exits 0"] },
      { text: "ship a mature UI", acceptanceItems: ["it works", "looks good"] },
    ])

    // The vague story is named, with the offending item quoted back.
    expect(challenge).toMatch(/S2 \(ship a mature UI\)/)
    expect(challenge).toContain('"it works"')
    expect(challenge).toContain('"looks good"')
    // The concrete story is left alone -- being specific means being silent
    // about the parts that are already verifiable.
    expect(challenge).not.toMatch(/S1 \(port the parser\)/)
    expect(challenge).not.toContain("tests/parser.test.ts")
    expect(challenge).toMatch(/2 stories, 3 acceptance items, 2 of which/)

    // A different plan must produce a different challenge, or it is wallpaper.
    const other = boot(temporaryRoot())
    const second = await createPlanVia(other, [
      { text: "migrate auth", acceptanceItems: ["handled"] },
      { text: "delete the shim", acceptanceItems: ["src/shim.ts no longer exists", "npx tsc --noEmit exits 0"] },
    ])
    expect(second.challenge).toMatch(/S1 \(migrate auth\)/)
    expect(second.challenge).not.toBe(challenge)
  })

  // MUTATION PROOF: delete the `if (stories.length <= 1 && flagged.length === 0)`
  // short-form branch in `buildPlanningChallenge` (so every plan falls through to
  // the full challenge) -> the trivial plan gets the remedy list and this test
  // goes red on the `not.toContain("elicify_vertex_plan_clear")` assertion.
  // Verified red, then restored.
  it("gives a trivial plan the short form and the same plan-with-a-vague-item the full one (AC-4)", async () => {
    const trivial = await createPlanVia(boot(temporaryRoot()), [
      { text: "fix the off-by-one", acceptanceItems: ["npx vitest run exits 0 with 3 tests passing"] },
    ])
    // The discrimination, asserted FIRST so it is what a regression trips on:
    // none of the heavyweight apparatus fires on one-shot work.
    expect(trivial.challenge).not.toContain("elicify_vertex_plan_clear")
    expect(trivial.challenge).not.toMatch(/Before you act on this plan/i)
    expect(trivial.challenge).not.toMatch(/do ONE of these now/i)
    expect(trivial.challengeLines.length).toBeLessThan(4)
    // It still asks the AC-1 question, though -- one-shot work is prompted,
    // not taxed. (Phrased form-agnostically: both forms say these, so these
    // assertions cannot be what makes the AC-4 mutation red.)
    expect(trivial.challenge).toMatch(/guessed/i)
    expect(trivial.challenge).toMatch(/research/i)
    expect(trivial.challenge).toMatch(/question tool/i)

    // Same shape of plan, one word of acceptance criterion different: the
    // discrimination is the vagueness of the item, not the story count.
    const vague = await createPlanVia(boot(temporaryRoot()), [{ text: "fix the off-by-one", acceptanceItems: ["it works"] }])
    expect(vague.challenge).toContain("elicify_vertex_plan_clear")
    expect(vague.challenge).toMatch(/S1 \(fix the off-by-one\)/)
  })

  // MUTATION PROOF: change the create tool's return to
  // `${JSON.stringify(plan, null, 2)}\n\n${planningChallenge?.join("\n")}` (the
  // obvious "just append the prose" implementation) -> `JSON.parse` throws and
  // this test goes red, as would scripts/uat-harness.mjs and the three v2
  // integration test files that parse this return value. Verified red, then
  // restored.
  it("still SUCCEEDS and still returns a parseable plan; nothing is written to plan.json (AC-3, AC-5)", async () => {
    const root = temporaryRoot()
    const harness = boot(root)
    const created = await createPlanVia(harness, [
      { text: "story one", acceptanceItems: ["it works"] },
      { text: "story two", acceptanceItems: ["fine"] },
    ])

    // No refusal, no deadlock: the plan exists and the return value is still
    // the plan its callers parse.
    expect(created.parsed.schemaVersion).toBe(2)
    expect(created.parsed.stories?.map((story) => story.id)).toEqual(["S1", "S2"])
    expect(created.parsed.finalStoryId).toBe("S2")
    expect(harness.storyEngine.getPlan(SESSION)?.stories[0].status).toBe("active")

    // AC-5: the challenge is return text only -- no self-reported clarification
    // field reaches the durable record. (Drift guard: the write path lives in
    // story.ts, so this assertion is not the one carrying the mutation proof
    // above; it exists to catch a future attempt to persist the challenge.)
    const persisted = readFileSync(join(root, ".opencode", "elicify-vertex", "plan.json"), "utf8")
    expect(persisted).not.toContain("planningChallenge")
    expect(persisted).not.toContain("grounded")
  })
})

describe("a refused checkpoint leaves no forged evidence in plan.json (R7)", () => {
  // Evidence used to be attached BEFORE `checkpoint` validated it, so a refused
  // checkpoint still wrote the model's claim to disk: the story could never be
  // completed (validation re-runs every attempt) but the durable audit record
  // showed a fabricated receipt id, contradicting story.ts's guarantee that a
  // thrown error leaves the plan byte-for-byte unchanged.
  //
  // MUTATION PROOF: move the `attachEvidence` loop in wiring/tools.ts back above
  // the validation loop -> this test goes red.
  it("does not persist a fabricated receiptId when the checkpoint is rejected", async () => {
    const root = temporaryRoot()
    const h = boot(root)
    await h.tools.elicify_vertex_plan_create.execute(
      { stories: [{ text: "w", acceptanceItems: ["ok"], scopeGlobs: ["**"], verifiers: ["npx vitest run"] }] },
      { sessionID: SESSION } as never,
    )

    await expect(checkpoint(h, "S1", "vrf_totally_made_up")).rejects.toThrow()

    const planPath = join(root, ".opencode", "elicify-vertex", "plan.json")
    expect(readFileSync(planPath, "utf8")).not.toContain("vrf_totally_made_up")
  })
})

// ===========================================================================
// elicify_vertex_plan_reopen (docs/CODE-ISSUES-FROM-PROMPT-AUDIT.md C-6:
// "a blocked/failed story can never be reopened, so a plan with a blocked
// final story can never reach all-complete"). `StoryEngine.reopenStory` was
// implemented and unit-tested, but had no caller anywhere in the wiring
// layer -- these tests drive it the way the model actually would, through
// the tool's own `execute`, never by calling `storyEngine.reopenStory`
// directly.
// ===========================================================================

async function blockStory(harness: Harness, storyId: string): Promise<void> {
  await harness.tools.elicify_vertex_plan_checkpoint.execute(
    { storyId, status: "blocked", items: [] },
    { sessionID: SESSION } as never,
  )
}

describe("elicify_vertex_plan_reopen tool", () => {
  // MUTATION PROOF: delete `elicify_vertex_plan_reopen` from the returned
  // tool map (or from `buildPlanTools` entirely) -> `harness.tools.elicify_vertex_plan_reopen`
  // is `undefined` and this test throws a TypeError before any assertion runs -> RED.
  it("is registered in the tool map alongside the other five plan tools", () => {
    const harness = boot(temporaryRoot())
    expect(Object.keys(harness.tools).sort()).toEqual([
      "elicify_vertex_plan_checkpoint",
      "elicify_vertex_plan_clear",
      "elicify_vertex_plan_create",
      "elicify_vertex_plan_next",
      "elicify_vertex_plan_reopen",
      "elicify_vertex_plan_status",
    ])
  })

  // MUTATION PROOF: replace the tool's `execute` body with a no-op that
  // returns without calling `storyEngine.reopenStory` -> the story's status
  // stays "blocked" and both assertions below go RED.
  it("reopens a blocked story, called through the tool's execute (not storyEngine.reopenStory directly)", async () => {
    const harness = boot(temporaryRoot())
    // Single story: nothing pending to auto-promote (C-16) when it blocks,
    // so "nothing else is active" holds and this stays a clean test of the
    // reopen TOOL's own wiring, not promotion mechanics (covered separately
    // below).
    await harness.tools.elicify_vertex_plan_create.execute(
      { stories: [{ text: "story one", acceptanceItems: ["one"], scopeGlobs: [], verifiers: [] }] },
      { sessionID: SESSION } as never,
    )
    await blockStory(harness, "S1")
    expect(harness.storyEngine.getPlan(SESSION)?.stories[0].status).toBe("blocked")

    const raw = (await harness.tools.elicify_vertex_plan_reopen.execute(
      { storyId: "S1", reason: "the missing dependency now exists" },
      { sessionID: SESSION } as never,
    )) as string
    const parsed = JSON.parse(raw) as { storyId: string; newStatus: string; becameActive: boolean }

    // S1 was the only story and nothing else is active, so it resumes as
    // "active" directly (story.ts's `reopenStory`: "nothing else is active").
    expect(parsed.newStatus).toBe("active")
    expect(parsed.becameActive).toBe(true)
    expect(harness.storyEngine.getPlan(SESSION)?.stories[0].status).toBe("active")
    expect(harness.storyEngine.getActiveStory(SESSION)?.id).toBe("S1")
  })

  // C-16 (docs/CODE-ISSUES-FROM-PROMPT-AUDIT.md): blocking the ACTIVE story
  // now auto-promotes the next pending story (checkpoint's promotion scan
  // fires on any active-slot vacancy, not just "complete") -- so reopening
  // the blocked story afterward finds another story already active and
  // correctly rejoins the queue as "pending" rather than preempting it.
  // MUTATION PROOF: revert story.ts's checkpoint to gate promotion on
  // `status === "complete" && wasActive` -> after blockStory(S1), S2 stays
  // pending (getActiveStory is null) instead of becoming active -> RED.
  it("blocking the active story promotes the next pending one; reopening the blocked story then rejoins as pending", async () => {
    const harness = boot(temporaryRoot())
    await harness.tools.elicify_vertex_plan_create.execute(
      {
        stories: [
          { text: "story one", acceptanceItems: ["one"], scopeGlobs: [], verifiers: [] },
          { text: "story two", acceptanceItems: ["two"], scopeGlobs: [], verifiers: [] },
        ],
      },
      { sessionID: SESSION } as never,
    )
    await blockStory(harness, "S1")
    expect(harness.storyEngine.getPlan(SESSION)?.stories[0].status).toBe("blocked")
    expect(harness.storyEngine.getActiveStory(SESSION)?.id).toBe("S2")

    const raw = (await harness.tools.elicify_vertex_plan_reopen.execute(
      { storyId: "S1", reason: "the missing dependency now exists" },
      { sessionID: SESSION } as never,
    )) as string
    const parsed = JSON.parse(raw) as { storyId: string; newStatus: string; becameActive: boolean }
    expect(parsed.newStatus).toBe("pending")
    expect(parsed.becameActive).toBe(false)
    expect(harness.storyEngine.getActiveStory(SESSION)?.id).toBe("S2")
  })

  // MUTATION PROOF: in story.ts's `reopenStory`, change the `hasActiveStory`
  // branch so a reopened story ALWAYS becomes "active" regardless of another
  // story already being active -> two stories end up "active" at once and
  // `getActiveStory` (which returns the FIRST match) silently hides the bug;
  // this test instead asserts the reopened story's own status is "pending"
  // and that the originally-active story is untouched, so it goes RED.
  it("rejoins the queue as pending when another story is already active, instead of preempting it", async () => {
    const harness = boot(temporaryRoot())
    await harness.tools.elicify_vertex_plan_create.execute(
      {
        stories: [
          { text: "story one", acceptanceItems: ["one"], scopeGlobs: [], verifiers: [] },
          { text: "story two", acceptanceItems: ["two"], scopeGlobs: [], verifiers: [] },
          { text: "story three", acceptanceItems: ["three"], scopeGlobs: [], verifiers: [] },
        ],
      },
      { sessionID: SESSION } as never,
    )
    // S2 blocked directly while still pending (out of order); normal
    // successor-promotion never touches it because it only fires on
    // "complete", so S1 stays active throughout.
    await blockStory(harness, "S2")
    expect(harness.storyEngine.getActiveStory(SESSION)?.id).toBe("S1")

    const raw = (await harness.tools.elicify_vertex_plan_reopen.execute(
      { storyId: "S2", reason: "unblocked" },
      { sessionID: SESSION } as never,
    )) as string
    const parsed = JSON.parse(raw) as { newStatus: string; becameActive: boolean }

    expect(parsed.newStatus).toBe("pending")
    expect(parsed.becameActive).toBe(false)
    expect(harness.storyEngine.getActiveStory(SESSION)?.id).toBe("S1")
    expect(harness.storyEngine.getPlan(SESSION)?.stories[1].status).toBe("pending")
  })

  // MUTATION PROOF: delete the `storyEngine.reopenStory(...)` call in the
  // tool's `execute` (or swallow its error in a try/catch) -> this rejects
  // nothing and the assertion goes RED.
  it("errors on an unknown storyId, mirroring StoryEngine.reopenStory's own error", async () => {
    const harness = boot(temporaryRoot())
    await harness.tools.elicify_vertex_plan_create.execute(
      { stories: [{ text: "story one", acceptanceItems: ["one"], scopeGlobs: [], verifiers: [] }] },
      { sessionID: SESSION } as never,
    )
    await expect(
      harness.tools.elicify_vertex_plan_reopen.execute(
        { storyId: "S99", reason: "does not matter" },
        { sessionID: SESSION } as never,
      ),
    ).rejects.toThrow(/unknown story: S99/)
  })

  // MUTATION PROOF: same as above -- if the tool stopped calling
  // `storyEngine.reopenStory` (or wrapped/reworded its error), reopening a
  // still-"active" story would silently succeed instead of throwing.
  it("errors on a story that is not currently blocked or failed (still active), mirroring StoryEngine's own error", async () => {
    const harness = boot(temporaryRoot())
    await harness.tools.elicify_vertex_plan_create.execute(
      { stories: [{ text: "story one", acceptanceItems: ["one"], scopeGlobs: [], verifiers: [] }] },
      { sessionID: SESSION } as never,
    )
    // S1 is "active" straight out of createPlan -- not a valid reopen source.
    await expect(
      harness.tools.elicify_vertex_plan_reopen.execute(
        { storyId: "S1", reason: "does not matter" },
        { sessionID: SESSION } as never,
      ),
    ).rejects.toThrow(/cannot reopen story S1: status is active/)

    // The rejected reopen must not have mutated anything.
    expect(harness.storyEngine.getPlan(SESSION)?.stories[0].status).toBe("active")
  })

  // MUTATION PROOF: revert story.ts's `reopenStory` to leave prior evidence
  // in place instead of resetting it to `null` -> `checkpoint`'s own
  // "no evidence" branch never fires on the stale item, this stale-evidence
  // guard silently disappears, and the assertion below (a second checkpoint
  // attempt with NO items succeeding) goes from throwing to succeeding,
  // flipping the `.rejects` expectation to RED.
  it("resets acceptance evidence on reopen, so the reopened story must be re-proven before it can complete again", async () => {
    const root = temporaryRoot()
    const harness = boot(root)
    await harness.tools.elicify_vertex_plan_create.execute(
      { stories: [{ text: "story one", acceptanceItems: ["one"], scopeGlobs: ["**"], verifiers: ["npx vitest run"] }] },
      { sessionID: SESSION } as never,
    )
    await blockStory(harness, "S1")
    await harness.tools.elicify_vertex_plan_reopen.execute(
      { storyId: "S1", reason: "unblocked" },
      { sessionID: SESSION } as never,
    )

    // No evidence attached since the reopen -- completing must be refused.
    await expect(
      harness.tools.elicify_vertex_plan_checkpoint.execute(
        { storyId: "S1", status: "complete", items: [] },
        { sessionID: SESSION } as never,
      ),
    ).rejects.toThrow(/has no evidence/)
  })
})

// ===========================================================================
// C-6 end-to-end: the REAL failure mode the fix targets -- a plan whose
// FINAL story blocks while active has nothing downstream to ever promote it,
// so before this tool existed the plan could never reach all-complete. This
// proves the actual scenario, not just the isolated reopen mechanism above.
// ===========================================================================

describe("C-6 end-to-end: a blocked FINAL story can be reopened, re-completed, and the plan reaches all-complete", () => {
  it("recovers a plan stuck on a blocked final story via elicify_vertex_plan_reopen", async () => {
    const root = temporaryRoot()
    const harness = boot(root)
    await harness.tools.elicify_vertex_plan_create.execute(
      {
        stories: [
          { text: "story one", acceptanceItems: ["one"], scopeGlobs: [], verifiers: [] },
          { text: "story two (final)", acceptanceItems: ["two"], scopeGlobs: [], verifiers: [] },
        ],
      },
      { sessionID: SESSION } as never,
    )

    // Complete S1 normally -- successor-promotion activates S2 (the plan's
    // finalStoryId).
    const forS1 = mintReceipt(harness.receipts, root)
    await checkpoint(harness, "S1", forS1.id)
    expect(harness.storyEngine.getPlan(SESSION)?.finalStoryId).toBe("S2")
    expect(harness.storyEngine.getActiveStory(SESSION)?.id).toBe("S2")

    // S2 -- the FINAL story -- blocks while active. Nothing downstream exists
    // to ever promote a successor: before this fix, the plan was stuck here
    // permanently (the idle gate's finalStory.status === "complete" check
    // could never be satisfied).
    await blockStory(harness, "S2")
    expect(harness.storyEngine.getPlan(SESSION)?.stories[1].status).toBe("blocked")
    expect(harness.storyEngine.getActiveStory(SESSION)).toBeNull()

    // Reopen it -- the real recovery path, driven through the tool.
    const reopenRaw = (await harness.tools.elicify_vertex_plan_reopen.execute(
      { storyId: "S2", reason: "the blocking dependency shipped upstream" },
      { sessionID: SESSION } as never,
    )) as string
    const reopened = JSON.parse(reopenRaw) as { newStatus: string }
    expect(reopened.newStatus).toBe("active")
    expect(harness.storyEngine.getActiveStory(SESSION)?.id).toBe("S2")

    // Re-complete it with fresh evidence (reopening cleared the old evidence
    // pointer, so the FR-020 "observed receipt" bar still has to be cleared
    // for real, not skipped because it was reopened).
    const forS2 = mintReceipt(harness.receipts, root)
    await checkpoint(harness, "S2", forS2.id)

    const finalPlan = harness.storyEngine.getPlan(SESSION)
    expect(finalPlan?.stories.map((s) => s.status)).toEqual(["complete", "complete"])
    expect(finalPlan?.stories.every((s) => s.status === "complete")).toBe(true)
  })
})

// ===========================================================================
// C-11 fix (docs/CODE-ISSUES-FROM-PROMPT-AUDIT.md): checkpointTool places no
// restriction on `blocked`/`failed` targeting a non-active storyId, and
// StoryEngine.checkpoint's successor-promotion is a first-"pending"-match
// scan -- so an earlier story blocked out of order can be silently skipped
// while a later story, including the plan's final one, reaches "complete"
// with the earlier one never resolved. Drives the exact audit scenario
// through the real tool surface (elicify_vertex_plan_checkpoint /
// elicify_vertex_plan_reopen), not storyEngine directly.
// ===========================================================================

describe("C-11 end-to-end: an out-of-order blocked story can no longer let the FINAL story silently complete", () => {
  it("S2 blocked out of order, S1 completes (promotion skips to S3=final) -- completing S3 now rejects until S2 is genuinely resolved", async () => {
    const root = temporaryRoot()
    const harness = boot(root)
    await harness.tools.elicify_vertex_plan_create.execute(
      {
        stories: [
          { text: "story one", acceptanceItems: ["one"], scopeGlobs: [], verifiers: [] },
          { text: "story two", acceptanceItems: ["two"], scopeGlobs: [], verifiers: [] },
          { text: "story three (final)", acceptanceItems: ["three"], scopeGlobs: [], verifiers: [] },
        ],
      },
      { sessionID: SESSION } as never,
    )
    expect(harness.storyEngine.getPlan(SESSION)?.finalStoryId).toBe("S3")

    // Block S2 directly while it is still "pending" -- checkpointTool's
    // schema/description impose no active-story requirement for blocked/failed.
    await blockStory(harness, "S2")
    expect(harness.storyEngine.getPlan(SESSION)?.stories[1].status).toBe("blocked")

    // Complete S1 -- successor-promotion skips the blocked S2 and activates
    // S3, the plan's final story, instead (pre-existing, unchanged behavior).
    const forS1 = mintReceipt(harness.receipts, root, { storyId: "S1" })
    await checkpoint(harness, "S1", forS1.id)
    expect(harness.storyEngine.getActiveStory(SESSION)?.id).toBe("S3")

    // Before the C-11 fix, this succeeded: the final story closed the plan
    // while S2 sat permanently blocked. Now it must reject.
    const forS3 = mintReceipt(harness.receipts, root, { storyId: "S3" })
    await expect(checkpoint(harness, "S3", forS3.id)).rejects.toThrow(/S2:blocked/)

    // Proves the gap actually closed: S3 is still active (not silently
    // completed), S2 is still blocked, the plan is not all-complete.
    const afterRejected = harness.storyEngine.getPlan(SESSION)!
    expect(afterRejected.stories.find((s) => s.id === "S3")!.status).toBe("active")
    expect(afterRejected.stories.find((s) => s.id === "S2")!.status).toBe("blocked")
    expect(afterRejected.stories.every((s) => s.status === "complete")).toBe(false)

    // Recovery through the real tool surface: free the active slot, reopen
    // and complete S2, then reopen and complete S3.
    await blockStory(harness, "S3")
    expect(harness.storyEngine.getActiveStory(SESSION)).toBeNull()

    await harness.tools.elicify_vertex_plan_reopen.execute(
      { storyId: "S2", reason: "root cause identified and resolved" },
      { sessionID: SESSION } as never,
    )
    expect(harness.storyEngine.getActiveStory(SESSION)?.id).toBe("S2")
    const forS2 = mintReceipt(harness.receipts, root, { storyId: "S2" })
    await checkpoint(harness, "S2", forS2.id)
    expect(harness.storyEngine.getPlan(SESSION)?.stories[1].status).toBe("complete")

    await harness.tools.elicify_vertex_plan_reopen.execute(
      { storyId: "S3", reason: "resuming final story" },
      { sessionID: SESSION } as never,
    )
    expect(harness.storyEngine.getActiveStory(SESSION)?.id).toBe("S3")
    const forS3Fresh = mintReceipt(harness.receipts, root, { storyId: "S3" })
    await checkpoint(harness, "S3", forS3Fresh.id)

    const finalPlan = harness.storyEngine.getPlan(SESSION)
    expect(finalPlan?.stories.every((s) => s.status === "complete")).toBe(true)
  })
})

describe("C-12: reopening rebinds a phase stuck at close, not just StoryEngine status", () => {
  it("a story whose phase reached close before it blocked is back at execute after reopen", async () => {
    const root = temporaryRoot()
    const harness = boot(root)
    await harness.tools.elicify_vertex_plan_create.execute(
      { stories: [{ text: "the only story", acceptanceItems: ["done"], scopeGlobs: [], verifiers: [] }] },
      { sessionID: SESSION } as never,
    )

    // Drive S1's phase all the way to "close" -- the exact pre-condition
    // C-12 describes: intake -> execute (T3) -> elevate (T4) -> close (T7).
    harness.phaseEngine.onMutation(SESSION, "S1")
    harness.phaseEngine.onVerifierOutcome(SESSION, "S1", { success: true, coversFinalStory: true })
    harness.phaseEngine.onIdle(SESSION, "S1", { criteriaAllEvidenced: true, hasPins: true, unverifiedChangesExist: false })
    expect(harness.phaseEngine.getPhase(SESSION, "S1")).toBe("close")

    // Block it directly from here (mirroring the real trigger: a story can
    // be blocked at any point, including after its phase already closed).
    await blockStory(harness, "S1")
    expect(harness.storyEngine.getPlan(SESSION)?.stories[0].status).toBe("blocked")

    // Before the C-12 fix: reopen only touched StoryEngine, so phase stayed
    // "close" here -- and onMutation is a documented no-op from "close" (no
    // table arc), so nothing downstream could ever have fixed it either.
    await harness.tools.elicify_vertex_plan_reopen.execute(
      { storyId: "S1", reason: "root cause identified and resolved" },
      { sessionID: SESSION } as never,
    )

    expect(harness.storyEngine.getActiveStory(SESSION)?.id).toBe("S1")
    expect(harness.phaseEngine.getPhase(SESSION, "S1")).toBe("execute")
  })
})
