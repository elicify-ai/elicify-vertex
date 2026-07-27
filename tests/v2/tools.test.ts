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
  const stateDir = join(root, ".elicify-vertex")
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

    const planPath = join(root, ".elicify-vertex", "plan.json")
    expect(readFileSync(planPath, "utf8")).not.toContain("vrf_totally_made_up")
  })
})
