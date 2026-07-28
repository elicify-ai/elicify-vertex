import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { EvidenceLedger } from "../../src/index.js"
import { holdoutArm } from "../../src/measurement.js"
import type { PlanV2 } from "../../src/v2/story.js"
import { InjectionComposer, type Finding } from "../../src/v2/composer.js"
import { PhaseEngine } from "../../src/v2/phase.js"
import { PinStore } from "../../src/v2/pin.js"
import { StoryEngine } from "../../src/v2/story.js"
import { SelfCreatedSessions } from "../../src/v2/subturn.js"
import type { OpencodeClient } from "../../src/v2/types.js"
import { handleSessionIdle, type GateContext } from "../../src/v2/wiring/gate.js"
import { ManifestCache } from "../../src/v2/wiring/manifest.js"
import { freshSessionState } from "../../src/v2/wiring/state.js"

const roots: string[] = []

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "vertex-gate-"))
  roots.push(root)
  return root
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function harness(opts: { maxCriteriaBlocks?: number; judgeEnabled?: boolean } = {}) {
  const stateDir = temporaryRoot()
  const logger = vi.fn()
  const composer = new InjectionComposer({ logger })
  const evidenceLedger = new EvidenceLedger()
  const pinStore = new PinStore({ stateDir, logger })
  const storyEngine = new StoryEngine({ stateDir, logger })
  const phaseEngine = new PhaseEngine(logger)
  const manifests = new ManifestCache()
  const selfCreated = new SelfCreatedSessions()
  const prompt = vi.fn(async () => ({ data: {}, error: undefined }))
  const client = { session: { prompt } } as unknown as OpencodeClient
  const states = new Map<string, ReturnType<typeof freshSessionState>>()
  // `appendJudgeCloseOut` is the ONLY caller of `recentVerifierSummaries` in
  // gate.ts, and it reads it only after the `judgeEnabled`/`modelId` guards —
  // so "was this mock called?" is an exact, side-effect-free probe of
  // "did the judge stage run?" with no agent/network stubbing.
  const recentVerifierSummaries = vi.fn(() => [] as string[])

  const ctx: GateContext = {
    client,
    logger,
    phaseEngine,
    pinStore,
    storyEngine,
    evidenceLedger,
    selfCreated,
    manifests,
    states,
    activeSessionIDs: () => [...states.entries()].filter(([, s]) => s.active).map(([id]) => id),
    maxCriteriaBlocks: opts.maxCriteriaBlocks ?? 3,
    judgeEnabled: opts.judgeEnabled ?? false,
    isValidReceipt: () => false,
    recentVerifierSummaries,
    diffSummary: () => "",
    composer,
  }
  return {
    ctx,
    composer,
    evidenceLedger,
    logger,
    phaseEngine,
    prompt,
    recentVerifierSummaries,
    selfCreated,
    states,
    stateDir,
    storyEngine,
  }
}

function promiseTexts(prompt: ReturnType<typeof vi.fn>): string[] {
  return prompt.mock.calls
    .map((call) => (call[0] as { body: { parts: Array<{ text: string }> } }).body.parts[0].text)
    .filter((text) => text.includes("vertex:promise-no-act"))
}

/** Every dispatched continuation, paired with the session it was addressed to. */
function continuations(prompt: ReturnType<typeof vi.fn>): Array<{ sid: string; text: string }> {
  return prompt.mock.calls.map((call) => {
    const arg = call[0] as { path: { id: string }; body: { parts: Array<{ text: string }> } }
    return { sid: arg.path.id, text: arg.body.parts[0].text }
  })
}

function loggedEventTypes(logger: ReturnType<typeof vi.fn>): string[] {
  return logger.mock.calls.map((call) => String(call[0]))
}

// ===========================================================================
// Stage-1 deterministic completion gate — plan stories not complete.
// (docs/REQUIREMENTS-IDLE-COMPLETION-GATE.md, AC-1..AC-6)
//
// Every fixture below is built so the story-completion check is the ONLY
// thing that can produce the asserted outcome: `evidenceLedger.reset(deep)`
// with NO changed files makes `shouldBlockStop` false, no pins means the
// criteria-replay branch is never entered, and `lastAssistantText` is left
// null so promise-no-act cannot fire. Tests that deliberately arm a second
// cause say so and assert which continuation won.
// ===========================================================================

/** A session that is active and gate-eligible but has no OTHER block cause. */
function quietSession(h: ReturnType<typeof harness>, sid: string): ReturnType<typeof freshSessionState> {
  const state = freshSessionState(h.stateDir)
  state.active = true
  state.lastAssistantText = null
  h.states.set(sid, state)
  h.evidenceLedger.reset(sid, "deep") // deep, but zero changed files -> shouldBlockStop() === false
  return state
}

/** The evidence session's plan shape: a scaffold story, then untouched successors. */
function createSixStoryStylePlan(h: ReturnType<typeof harness>, sid: string): void {
  h.storyEngine.createPlan(sid, [
    {
      text: "Scaffold the app",
      acceptanceItems: ["dev server boots", "unit tests pass"],
      scopeGlobs: [],
      verifiers: ["npx vitest run tests/scaffold.test.ts"],
    },
    { text: "Sources management page", acceptanceItems: ["source list renders"], scopeGlobs: [], verifiers: [] },
    { text: "End-to-end UAT via Playwright", acceptanceItems: ["uat suite green"], scopeGlobs: [], verifiers: [] },
  ])
}

/** Drive the phase machine to `elevate` for `storyId` so `onIdle` can close (T7). */
function driveToElevate(h: ReturnType<typeof harness>, sid: string, storyId: string | null): void {
  h.phaseEngine.onMutation(sid, storyId)
  h.phaseEngine.onVerifierOutcome(sid, storyId, { success: true, coversFinalStory: true })
}

const planTexts = (prompt: ReturnType<typeof vi.fn>): string[] =>
  continuations(prompt)
    .map((c) => c.text)
    .filter((text) => text.includes("vertex:plan-incomplete"))

describe("handleSessionIdle — stage-1 plan-completion gate", () => {
  it("AC-1/AC-2: dispatches one continuation naming every open story with its status, the active story's declared verifier, and ONLY the acceptance items that lack evidence", async () => {
    const h = harness()
    const sid = "s1"
    quietSession(h, sid)
    createSixStoryStylePlan(h, sid)
    // A1 is evidenced, A2 is not — so "names what still lacks evidence"
    // cannot be satisfied by simply reciting every acceptance item.
    h.storyEngine.attachEvidence(sid, "S1", "A1", { receiptId: "receipt-scaffold" })

    await handleSessionIdle(h.ctx, sid)

    const fired = continuations(h.prompt)
    expect(fired).toHaveLength(1)
    const text = fired[0].text
    expect(fired[0].sid).toBe(sid)
    expect(text).toContain("[vertex:plan-incomplete]")
    // AC-2: which stories are incomplete, and their status.
    expect(text).toContain('S1 (active): "Scaffold the app"')
    expect(text).toContain('S2 (pending): "Sources management page"')
    expect(text).toContain('S3 (pending): "End-to-end UAT via Playwright"')
    // AC-2: what evidence would close the active story — its declared verifier...
    expect(text).toContain("npx vitest run tests/scaffold.test.ts")
    // ...and which acceptance items lack evidence (A2 only, never A1).
    expect(text).toContain('A2: "unit tests pass"')
    expect(text).not.toContain("A1")
    expect(text).not.toContain("dev server boots")
    expect(loggedEventTypes(h.logger)).toContain("gate:plan-incomplete")
  })

  it("AC-2: an active story with no declared verifiers says so instead of inventing a command", async () => {
    const h = harness()
    const sid = "s1"
    quietSession(h, sid)
    h.storyEngine.createPlan(sid, [
      { text: "Unverified story", acceptanceItems: ["something works"], scopeGlobs: [], verifiers: [] },
      { text: "Later story", acceptanceItems: ["later thing"], scopeGlobs: [], verifiers: [] },
    ])

    await handleSessionIdle(h.ctx, sid)

    const texts = planTexts(h.prompt)
    expect(texts).toHaveLength(1)
    expect(texts[0]).toContain("S1 declares no verifiers")
    expect(texts[0]).toContain("amend S1 to declare the verifier you intend to use")
  })

  it("AC-6 discrimination: a fully complete plan is NOT blocked, and the judge stage still runs exactly as before (AC-4)", async () => {
    const h = harness({ judgeEnabled: true })
    const sid = "s1"
    const state = quietSession(h, sid)
    state.modelId = "anthropic/claude-opus-4"
    h.storyEngine.createPlan(sid, [
      { text: "First story", acceptanceItems: ["first done"], scopeGlobs: [], verifiers: ["npm test"] },
      { text: "Final story", acceptanceItems: ["final done"], scopeGlobs: [], verifiers: ["npm test"] },
    ])
    h.storyEngine.attachEvidence(sid, "S1", "A1", { receiptId: "r-1" })
    h.storyEngine.checkpoint(sid, "S1", "complete", { isValidReceipt: () => true })
    h.storyEngine.attachEvidence(sid, "S2", "A1", { receiptId: "r-2" })
    h.storyEngine.checkpoint(sid, "S2", "complete", { isValidReceipt: () => true })
    expect(h.storyEngine.getPlan(sid)!.stories.every((s) => s.status === "complete")).toBe(true)

    // getActiveStory() is null once the final story completes, so the gate
    // resolves the phase slot to finalStoryId — drive THAT slot to elevate.
    driveToElevate(h, sid, "S2")

    await handleSessionIdle(h.ctx, sid)

    expect(continuations(h.prompt)).toHaveLength(0)
    expect(h.recentVerifierSummaries).toHaveBeenCalledTimes(1) // judge stage entered
    expect(state.criteriaBlocks).toBe(0) // no block budget consumed
    expect(loggedEventTypes(h.logger)).not.toContain("gate:plan-incomplete")
  })

  it("AC-3: the judge does NOT run while an earlier story is still open, even though the plan's final story is complete", async () => {
    const h = harness({ judgeEnabled: true })
    const sid = "s1"
    const state = quietSession(h, sid)
    state.modelId = "anthropic/claude-opus-4"
    // Written straight to disk: `checkpoint` promotes stories in order, so
    // this state (final complete, S1 still pending) is unreachable through
    // the tool surface — which is exactly why it isolates the judge gate.
    // Before this requirement, `appendJudgeCloseOut` looked ONLY at the
    // final story, so this plan would have been judged as done.
    const plan: PlanV2 = {
      schemaVersion: 2,
      finalStoryId: "S2",
      createdAt: new Date().toISOString(),
      stories: [
        {
          id: "S1",
          text: "Sources management page",
          acceptanceItems: [{ id: "A1", text: "source list renders", evidence: null }],
          scopeGlobs: [],
          verifiers: [],
          assumptions: [],
          rejectedAlternatives: [],
          amendments: [],
          status: "pending",
        },
        {
          id: "S2",
          text: "End-to-end UAT via Playwright",
          acceptanceItems: [{ id: "A1", text: "uat suite green", evidence: { receiptId: "r-2" } }],
          scopeGlobs: [],
          verifiers: [],
          assumptions: [],
          rejectedAlternatives: [],
          amendments: [],
          status: "complete",
        },
      ],
    }
    writeFileSync(join(h.stateDir, "plan.json"), JSON.stringify({ [sid]: plan }, null, 2), "utf8")
    driveToElevate(h, sid, "S2") // phase would otherwise close and call the judge

    await handleSessionIdle(h.ctx, sid)

    expect(h.recentVerifierSummaries).not.toHaveBeenCalled()
    const texts = planTexts(h.prompt)
    expect(texts).toHaveLength(1)
    expect(texts[0]).toContain('S1 (pending): "Sources management page"')
    // Only S1 is open, so the completed final story is not recited as open.
    expect(texts[0]).not.toContain("S2 (")
  })

  it("AC-5: stops nudging after maxCriteriaBlocks and lets the rest of the idle tree run (warn-then-allow, v1 parity)", async () => {
    const h = harness({ maxCriteriaBlocks: 1 })
    const sid = "s1"
    const state = quietSession(h, sid)
    createSixStoryStylePlan(h, sid)
    // Arm the zero-criteria fallback too, so "the rest of the tree still
    // runs once the plan branch is capped" is observable rather than assumed.
    h.evidenceLedger.recordChangedFiles(sid, "src/app.tsx")

    await handleSessionIdle(h.ctx, sid) // block 1 of 1 -> plan-incomplete
    await handleSessionIdle(h.ctx, sid) // past cap -> falls through to the stop-block

    const texts = continuations(h.prompt).map((c) => c.text)
    expect(texts).toHaveLength(2)
    expect(texts[0]).toContain("vertex:plan-incomplete")
    expect(texts[1]).toContain("vertex:stop-block")
    expect(texts[1]).not.toContain("vertex:plan-incomplete")
    expect(state.criteriaBlocks).toBe(1)
    expect(loggedEventTypes(h.logger)).toContain("gate:plan-incomplete-capped")
  })

  it("an incomplete plan short-circuits the rest of the tree: one idle event produces exactly one continuation, and it is the plan one", async () => {
    const h = harness()
    const sid = "s1"
    const state = quietSession(h, sid)
    createSixStoryStylePlan(h, sid)
    // Arm BOTH other deterministic causes at once.
    state.lastAssistantText = "I changed it.\nTODO: handle the edge case next."
    h.evidenceLedger.recordChangedFiles(sid, "src/app.tsx")

    await handleSessionIdle(h.ctx, sid)

    const texts = continuations(h.prompt).map((c) => c.text)
    expect(texts).toHaveLength(1)
    expect(texts[0]).toContain("vertex:plan-incomplete")
    expect(promiseTexts(h.prompt)).toHaveLength(0)
    expect(texts[0]).not.toContain("vertex:stop-block")
  })

  it("a session with no plan at all is untouched by the new branch", async () => {
    const h = harness()
    const sid = "s1"
    quietSession(h, sid)

    await handleSessionIdle(h.ctx, sid)

    expect(continuations(h.prompt)).toHaveLength(0)
    expect(loggedEventTypes(h.logger)).not.toContain("gate:plan-incomplete")
  })

  it("a story checkpointed blocked still counts as open and is named with that status", async () => {
    const h = harness()
    const sid = "s1"
    quietSession(h, sid)
    h.storyEngine.createPlan(sid, [
      { text: "Blocked story", acceptanceItems: ["cannot be done"], scopeGlobs: [], verifiers: [] },
      { text: "Trailing story", acceptanceItems: ["never started"], scopeGlobs: [], verifiers: [] },
    ])
    h.storyEngine.checkpoint(sid, "S1", "blocked", { isValidReceipt: () => true })
    expect(h.storyEngine.getActiveStory(sid)).toBeNull()

    await handleSessionIdle(h.ctx, sid)

    const texts = planTexts(h.prompt)
    expect(texts).toHaveLength(1)
    expect(texts[0]).toContain('S1 (blocked): "Blocked story"')
    expect(texts[0]).toContain("No story is active")
  })

  it("AC-5: an off-arm holdout session is not blocked by the plan branch, and the rest of the tree still runs", async () => {
    const savedHoldout = process.env.VERTEX_HOLDOUT
    const savedData = process.env.VERTEX_DATA
    process.env.VERTEX_HOLDOUT = "1"
    process.env.VERTEX_DATA = temporaryRoot()
    try {
      let sid: string | null = null
      for (let i = 0; i < 500 && sid === null; i += 1) {
        const candidate = `holdout-session-${i}`
        if (holdoutArm(candidate, "plan-incomplete") === "off") sid = candidate
      }
      expect(sid).not.toBeNull()

      const h = harness()
      const state = quietSession(h, sid!)
      createSixStoryStylePlan(h, sid!)
      h.evidenceLedger.recordChangedFiles(sid!, "src/app.tsx")

      await handleSessionIdle(h.ctx, sid!)

      const texts = continuations(h.prompt).map((c) => c.text)
      expect(texts.filter((t) => t.includes("vertex:plan-incomplete"))).toHaveLength(0)
      expect(texts).toHaveLength(1)
      expect(texts[0]).toContain("vertex:stop-block") // suppression is scoped, not a global mute
      expect(state.criteriaBlocks).toBe(0)
    } finally {
      if (savedHoldout === undefined) delete process.env.VERTEX_HOLDOUT
      else process.env.VERTEX_HOLDOUT = savedHoldout
      if (savedData === undefined) delete process.env.VERTEX_DATA
      else process.env.VERTEX_DATA = savedData
    }
  })
})

// ===========================================================================
// Promise-no-act port (v1 parity — see gate.ts's handlePromiseNoAct doc)
// ===========================================================================

describe("handleSessionIdle — promise-no-act port", () => {
  it("blocks with [vertex:promise-no-act] when the last assistant text defers work after changed files", async () => {
    const { ctx, evidenceLedger, prompt, states, stateDir } = harness()
    const sid = "s1"
    const state = freshSessionState(stateDir)
    state.active = true
    state.lastAssistantText = "I fixed the main bug.\nTODO: handle the edge case next."
    states.set(sid, state)
    evidenceLedger.reset(sid, "deep")
    evidenceLedger.recordChangedFiles(sid, "src/foo.ts")

    await handleSessionIdle(ctx, sid)

    const texts = promiseTexts(prompt)
    expect(texts).toHaveLength(1)
    expect(texts[0]).toContain("todo-marker")
  })

  it("does not block when there were no changed files (nothing to act on yet)", async () => {
    const { ctx, evidenceLedger, prompt, states, stateDir } = harness()
    const sid = "s1"
    const state = freshSessionState(stateDir)
    state.active = true
    state.lastAssistantText = "TODO: handle the edge case next."
    states.set(sid, state)
    evidenceLedger.reset(sid, "deep")

    await handleSessionIdle(ctx, sid)

    expect(promiseTexts(prompt)).toHaveLength(0)
  })

  it("does not block when the tail asks the user a direct question (pause-the-work exemption)", async () => {
    const { ctx, evidenceLedger, prompt, states, stateDir } = harness()
    const sid = "s1"
    const state = freshSessionState(stateDir)
    state.active = true
    state.lastAssistantText = "I'll handle the rest later. Should I proceed with the migration?"
    states.set(sid, state)
    evidenceLedger.reset(sid, "deep")
    evidenceLedger.recordChangedFiles(sid, "src/foo.ts")

    await handleSessionIdle(ctx, sid)

    expect(promiseTexts(prompt)).toHaveLength(0)
  })

  it("stops blocking once the cap is exceeded (shares maxCriteriaBlocks with the criteria-block cap)", async () => {
    const { ctx, evidenceLedger, prompt, states, stateDir } = harness({ maxCriteriaBlocks: 1 })
    const sid = "s1"
    const state = freshSessionState(stateDir)
    state.active = true
    states.set(sid, state)
    evidenceLedger.reset(sid, "deep")
    evidenceLedger.recordChangedFiles(sid, "src/foo.ts")

    state.lastAssistantText = "TODO: fix this later."
    await handleSessionIdle(ctx, sid)

    state.lastAssistantText = "TODO: fix this later, again."
    await handleSessionIdle(ctx, sid)

    expect(promiseTexts(prompt)).toHaveLength(1)
  })

  it("a receipt-backed verified change with only a weak (non-strong) hit is not blocked", async () => {
    const { ctx, evidenceLedger, prompt, states, stateDir } = harness()
    const sid = "s1"
    const state = freshSessionState(stateDir)
    state.active = true
    // "tracking ticket" is a compound word (not a standalone "tracked"/"tracking"
    // needle) per detectPromiseNoAct's boundary rule — no hit at all here.
    state.lastAssistantText = "Filed in the issue-tracker's tracking ticket system for reference."
    states.set(sid, state)
    evidenceLedger.reset(sid, "deep")
    evidenceLedger.recordChangedFiles(sid, "src/foo.ts")
    evidenceLedger.recordVerification(sid, "npx vitest run", 0, "verified")

    await handleSessionIdle(ctx, sid)

    expect(promiseTexts(prompt)).toHaveLength(0)
  })
})

// ===========================================================================
// Turn-freeze fix: promptContinuation advances composer.newTurn() so a
// per-turn-capped finding is not starved for the rest of an unattended
// session (see gate.ts's promptContinuation doc comment).
// ===========================================================================

describe("handleSessionIdle — turn-freeze fix (composer.newTurn on every continuation)", () => {
  it("a per-turn-capped composer finding becomes eligible again after a gate-driven continuation, with no new chat.message ever arriving", async () => {
    const { ctx, composer, evidenceLedger, states, stateDir } = harness()
    const sid = "s1"
    const state = freshSessionState(stateDir)
    state.active = true
    states.set(sid, state)
    // Zero criteria + changed + unverified + deep -> handleZeroCriteriaFallback
    // fires a continuation on every idle call.
    evidenceLedger.reset(sid, "deep")
    evidenceLedger.recordChangedFiles(sid, "src/foo.ts")

    // Simulate the ONE real chat.message this unattended session ever had.
    composer.newTurn(sid)

    const finding: Finding = {
      family: "scope-watchdog", // DEFAULT_FAMILY_CAPS: 1 per turn
      priority: "correction",
      observation: "obs",
      diagnosis: "diag",
      prescription: "presc",
      instanceId: "f1",
    }

    const round1 = composer.render(sid, [finding], { priorCompliance: () => false })
    expect(round1.renderedFamilies).toEqual(["scope-watchdog"])

    const round1Repeat = composer.render(sid, [{ ...finding, instanceId: "f2" }], { priorCompliance: () => false })
    expect(round1Repeat.dropped).toEqual([{ family: "scope-watchdog", reason: "per-turn-cap" }])

    // No new chat.message ever arrives — only the harness's own idle-driven
    // continuation loop keeps the session going, exactly like the real
    // unattended session that surfaced this bug (turnIndex stuck at 7 for
    // ~1.5 hours, 435 per-turn-cap:dropped events).
    await handleSessionIdle(ctx, sid)

    const round2 = composer.render(sid, [{ ...finding, instanceId: "f3" }], { priorCompliance: () => false })
    expect(round2.renderedFamilies).toEqual(["scope-watchdog"])
    expect(round2.dropped).toEqual([])
  })

  it("does not advance the turn when no continuation is actually dispatched (verified, nothing to nudge)", async () => {
    const { ctx, composer, evidenceLedger, states, stateDir } = harness()
    const sid = "s1"
    const state = freshSessionState(stateDir)
    state.active = true
    states.set(sid, state)
    evidenceLedger.reset(sid, "deep")
    evidenceLedger.recordChangedFiles(sid, "src/foo.ts")
    evidenceLedger.recordVerification(sid, "npx vitest run", 0, "verified")

    composer.newTurn(sid)
    const finding: Finding = {
      family: "scope-watchdog",
      priority: "correction",
      observation: "obs",
      diagnosis: "diag",
      prescription: "presc",
      instanceId: "f1",
    }
    composer.render(sid, [finding], { priorCompliance: () => false })
    const cappedBefore = composer.render(sid, [{ ...finding, instanceId: "f2" }], { priorCompliance: () => false })
    expect(cappedBefore.dropped).toEqual([{ family: "scope-watchdog", reason: "per-turn-cap" }])

    await handleSessionIdle(ctx, sid) // verified + no criteria -> no fallback fires, no continuation dispatched

    const stillCapped = composer.render(sid, [{ ...finding, instanceId: "f3" }], { priorCompliance: () => false })
    expect(stillCapped.dropped).toEqual([{ family: "scope-watchdog", reason: "per-turn-cap" }])
  })
})

// ===========================================================================
// Per-session enforcement (replaces the multi-session bail-out).
//
// `handleSessionIdle` used to `return` before any enforcement whenever
// `activeSessionIDs().length > 1`, which silently switched off promise-no-act,
// the stop-block and the judge for EVERY session as soon as a second one
// existed. Enforcement is now per-session; the multi-session signal survives
// only as a log/advisory. See gate.ts's `handleSessionIdle` doc comment.
// ===========================================================================

/** Deep mode + a changed code file + no verification -> zero-criteria stop-block. */
function activateBlockableSession(
  h: ReturnType<typeof harness>,
  sid: string,
  changedPath: string,
): ReturnType<typeof freshSessionState> {
  const state = freshSessionState(h.stateDir)
  state.active = true
  h.states.set(sid, state)
  h.evidenceLedger.reset(sid, "deep")
  h.evidenceLedger.recordChangedFiles(sid, changedPath)
  return state
}

describe("handleSessionIdle — per-session enforcement under concurrent sessions", () => {
  it("two concurrently active sessions each get their own stop-block continuation", async () => {
    const h = harness()
    activateBlockableSession(h, "s1", "src/alpha.ts")
    activateBlockableSession(h, "s2", "src/beta.ts")
    expect(h.ctx.activeSessionIDs()).toEqual(["s1", "s2"])

    await handleSessionIdle(h.ctx, "s1")
    await handleSessionIdle(h.ctx, "s2")

    const fired = continuations(h.prompt).filter((c) => c.text.includes("vertex:stop-block"))
    expect(fired.map((c) => c.sid)).toEqual(["s1", "s2"])
    // Each continuation cites only its OWN session's changed path — no
    // cross-session bleed through the shared EvidenceLedger instance.
    expect(fired[0].text).toContain("src/alpha.ts")
    expect(fired[0].text).not.toContain("src/beta.ts")
    expect(fired[1].text).toContain("src/beta.ts")
    expect(fired[1].text).not.toContain("src/alpha.ts")

    // The multi-session signal survives as an advisory, not a suppression.
    expect(loggedEventTypes(h.logger)).toContain("gate:multi-session-advisory")
  })

  it("neither session suppresses the other: a verified peer does not silence the unverified one", async () => {
    const h = harness()
    activateBlockableSession(h, "verified", "src/alpha.ts")
    h.evidenceLedger.recordVerification("verified", "npx vitest run", 0, "verified")
    activateBlockableSession(h, "unverified", "src/beta.ts")

    await handleSessionIdle(h.ctx, "verified")
    await handleSessionIdle(h.ctx, "unverified")

    const fired = continuations(h.prompt).filter((c) => c.text.includes("vertex:stop-block"))
    expect(fired.map((c) => c.sid)).toEqual(["unverified"])
  })

  it("a promise-no-act deferral in one session blocks only that session", async () => {
    const h = harness()
    const deferring = activateBlockableSession(h, "deferring", "src/alpha.ts")
    deferring.lastAssistantText = "I changed it.\nTODO: handle the edge case next."
    const quiet = activateBlockableSession(h, "quiet", "src/beta.ts")
    quiet.lastAssistantText = null
    h.evidenceLedger.recordVerification("quiet", "npx vitest run", 0, "verified")

    await handleSessionIdle(h.ctx, "deferring")
    await handleSessionIdle(h.ctx, "quiet")

    expect(continuations(h.prompt).map((c) => c.sid)).toEqual(["deferring"])
    expect(promiseTexts(h.prompt)).toHaveLength(1)
  })

  it("one session exhausting its block cap leaves its peer's cap untouched", async () => {
    const h = harness({ maxCriteriaBlocks: 1 })
    activateBlockableSession(h, "noisy", "src/alpha.ts")
    activateBlockableSession(h, "peer", "src/beta.ts")

    await handleSessionIdle(h.ctx, "noisy") // blocks (1 of 1)
    await handleSessionIdle(h.ctx, "noisy") // past cap — silent
    await handleSessionIdle(h.ctx, "peer") // still has its own full budget

    expect(continuations(h.prompt).map((c) => c.sid)).toEqual(["noisy", "peer"])
  })

  it("a session with a continuation in flight is skipped without suppressing its peer", async () => {
    const h = harness()
    const inFlight = activateBlockableSession(h, "in-flight", "src/alpha.ts")
    inFlight.idleContinuationInFlight = true
    activateBlockableSession(h, "peer", "src/beta.ts")

    await handleSessionIdle(h.ctx, "in-flight")
    await handleSessionIdle(h.ctx, "peer")

    expect(continuations(h.prompt).map((c) => c.sid)).toEqual(["peer"])
  })

  it("a self-created child session does not disable its parent's gate or read as multi-session", async () => {
    const h = harness()
    activateBlockableSession(h, "parent", "src/alpha.ts")
    // A judge/intake subturn child leaking into the active list (FR-036):
    // recorded in SelfCreatedSessions exactly as `runSubturn` records it.
    const child = freshSessionState(h.stateDir)
    child.active = true
    h.states.set("judge-child-1", child)
    h.selfCreated.record("judge-child-1", "parent")
    expect(h.ctx.activeSessionIDs()).toEqual(["parent", "judge-child-1"])

    await handleSessionIdle(h.ctx, "parent")

    const fired = continuations(h.prompt).filter((c) => c.text.includes("vertex:stop-block"))
    expect(fired.map((c) => c.sid)).toEqual(["parent"])
    // The parent is still the only real session — no degraded-attribution
    // advisory, and therefore no spurious criteria re-injection.
    expect(loggedEventTypes(h.logger)).not.toContain("gate:multi-session-advisory")
    expect(h.states.get("parent")!.needsCriteriaReinject).toBe(false)
  })
})
