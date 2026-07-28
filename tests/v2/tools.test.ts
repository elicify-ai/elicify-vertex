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
}

/** Build (or REBUILD, i.e. restart) the whole wiring over one worktree. */
function boot(root: string): Harness {
  const stateDir = join(root, ".opencode", "elicify-vertex")
  const logger = (): void => {}
  const storyEngine = new StoryEngine({ stateDir, logger })
  const receipts = new VerificationReceiptStore()
  const states = new Map<string, V2SessionState>([[SESSION, freshSessionState(root)]])
  const tools = buildPlanTools({
    storyEngine,
    pinStore: new PinStore({ stateDir, logger }),
    verificationReceipts: receipts,
    client,
    states,
    phaseEngine: new PhaseEngine(logger),
    onPlanCreated: () => {},
  })
  return { storyEngine, receipts, tools }
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
