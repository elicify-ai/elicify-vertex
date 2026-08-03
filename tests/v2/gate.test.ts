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
import { freshSessionState, resetTurnState } from "../../src/v2/wiring/state.js"
import { DelegationTracker } from "../../src/v2/wiring/watchdog.js"

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

function harness(opts: {
  maxCriteriaBlocks?: number
  judgeEnabled?: boolean
  maxNoProgressTurns?: number
  busyChildren?: boolean
  maxStoryReaudits?: number
  /** FR-014: parts returned for the judge child session (a `tool` part = the judge observed something). */
  childParts?: Array<{ type: string }>
  /** The verdict the stubbed judge subturn returns. */
  judgeVerdict?: unknown
} = {}) {
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
  // Optional busy-children probe surface for the delegation-deferral tests:
  // `hasBusyChildren` (watchdog.ts) reads `session.children` + `session.status`.
  const session: Record<string, unknown> = { prompt }
  if (opts.busyChildren) {
    session.children = vi.fn(async () => ({ data: [{ id: "child-1" }], error: undefined }))
    session.status = vi.fn(async () => ({ data: { "child-1": { type: "busy" } }, error: undefined }))
  }
  const client = { session } as unknown as OpencodeClient
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
    // Redesign point 9: a real DelegationTracker (never records a `task`
    // call in these pure gate tests, so it never defers), and a HIGH
    // no-progress cap so the deterministic behaviors under test are not
    // coupled to the new stall semantics (which have their own dedicated
    // tests below).
    delegation: new DelegationTracker(),
    maxNoProgressTurns: opts.maxNoProgressTurns ?? 999,
    maxStoryReaudits: opts.maxStoryReaudits ?? 999,
  }
  return {
    ctx,
    composer,
    delegation: ctx.delegation,
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

/** The evidence session's plan shape: a scaffold story, then untouched successors.
 * Stories are chained via story-level `dependsOn` (S2 -> S1, S3 -> S2) so the
 * task/DAG engine activates them one at a time — the same "S1 active, S2/S3
 * pending" shape the old stored-`wave` field used to give these fixtures for
 * free (waves are now COMPUTED from the DAG, never stored or input). Each
 * story carries one trivial task (the redesign's atomic unit); the assertions
 * here only care about story-level flow. */
function createSixStoryStylePlan(h: ReturnType<typeof harness>, sid: string): void {
  h.storyEngine.createPlan(sid, [
    {
      text: "Scaffold the app",
      acceptanceItems: ["dev server boots", "unit tests pass"],
      scopeGlobs: [],
      verifiers: ["npx vitest run tests/scaffold.test.ts"],
      tasks: [{ text: "scaffold the app" }],
    },
    {
      text: "Sources management page",
      acceptanceItems: ["source list renders"],
      scopeGlobs: [],
      verifiers: [],
      dependsOn: ["S1"],
      tasks: [{ text: "build the sources management page" }],
    },
    {
      text: "End-to-end UAT via Playwright",
      acceptanceItems: ["uat suite green"],
      scopeGlobs: [],
      verifiers: [],
      dependsOn: ["S2"],
      tasks: [{ text: "run the end-to-end UAT" }],
    },
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
  it("AC-1/AC-2: dispatches one continuation naming every open story with its status, the active story's declared verifier, and the acceptance items the judge will audit", async () => {
    const h = harness()
    const sid = "s1"
    quietSession(h, sid)
    createSixStoryStylePlan(h, sid)

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
    // AC-2 (redesign point 8): the active story's declared verifier...
    expect(text).toContain("npx vitest run tests/scaffold.test.ts")
    // ...and EVERY acceptance item the judge will audit (A1 and A2 — the
    // per-item evidence-citation contract is gone, so the judge audits all
    // of them; the prescription names them so the model can self-check).
    expect(text).toContain('A1: "dev server boots"')
    expect(text).toContain('A2: "unit tests pass"')
    // Claim language, not citation language.
    expect(text).toContain("claim")
    expect(text).not.toContain("evidence for every acceptance item")
    expect(loggedEventTypes(h.logger)).toContain("gate:plan-incomplete")
  })

  it("AC-2: an active story with no declared verifiers says so instead of inventing a command", async () => {
    const h = harness()
    const sid = "s1"
    quietSession(h, sid)
    h.storyEngine.createPlan(sid, [
      { text: "Unverified story", acceptanceItems: ["something works"], scopeGlobs: [], verifiers: [], tasks: [{ text: "do the unverified work" }] },
      { text: "Later story", acceptanceItems: ["later thing"], scopeGlobs: [], verifiers: [], dependsOn: ["S1"], tasks: [{ text: "do the later work" }] },
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
      { text: "First story", acceptanceItems: ["first done"], scopeGlobs: [], verifiers: ["npm test"], tasks: [{ text: "do the first story" }] },
      { text: "Final story", acceptanceItems: ["final done"], scopeGlobs: [], verifiers: ["npm test"], dependsOn: ["S1"], tasks: [{ text: "do the final story" }] },
    ])
    // 2026-07-30 task/DAG redesign: a checkpoint is a bare CLAIM on a TASK id
    // (no per-item evidence/receipt citation — that apparatus is gone). Each
    // story has one task, so completing S1.T1 auto-completes S1 and promotes
    // S2.T1 to active; completing S2.T1 auto-completes S2 (the final story).
    h.storyEngine.checkpoint(sid, "S1.T1", "complete")
    h.storyEngine.checkpoint(sid, "S2.T1", "complete")
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

  it("AC-3 (redesign point 2): the judge DOES audit a claimed-final story even while an earlier story is still open", async () => {
    // This REVERSES the pre-redesign behavior the old test encoded (the judge
    // was gated behind every story reaching "complete" deterministically, so
    // it could never rescue exactly this stall). The judge is now the sole
    // arbiter: it audits any claimed-complete story at idle regardless of the
    // others' states. Here S2 is claimed complete while S1 is still pending
    // — unreachable through the tool surface (checkpoint promotes in order),
    // written straight to disk to isolate the audit gate.
    const h = harness({ judgeEnabled: true })
    const sid = "s1"
    const state = quietSession(h, sid)
    state.modelId = "anthropic/claude-opus-4"
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
          dependsOn: [],
          status: "pending",
          // 2026-07-30: `tasks` is now REQUIRED by isStoryV2 on load. S1 is
          // pending, so its sole task is pending too (a story with no active
          // task reads as not-active — exactly the "getActiveStory is null"
          // shape this scenario isolates).
          tasks: [{ id: "S1.T1", text: "build the sources page", dependsOn: [], status: "pending" }],
        },
        {
          id: "S2",
          text: "End-to-end UAT via Playwright",
          acceptanceItems: [{ id: "A1", text: "uat suite green", evidence: null }],
          scopeGlobs: [],
          verifiers: [],
          assumptions: [],
          rejectedAlternatives: [],
          amendments: [],
          dependsOn: [],
          status: "complete",
          completedAt: new Date().toISOString(),
          // S2 is the claimed-complete final story the judge audits; its task
          // carries the matching complete status + completedAt.
          tasks: [{ id: "S2.T1", text: "run the UAT", dependsOn: [], status: "complete", completedAt: new Date().toISOString() }],
        },
      ],
    }
    writeFileSync(join(h.stateDir, "plan.json"), JSON.stringify({ [sid]: plan }, null, 2), "utf8")

    await handleSessionIdle(h.ctx, sid)

    // The judge stage ENTERED — it read the verifier summaries to build the
    // audit payload for the claimed S2 (the stub client's probe then fails
    // open, dispatching nothing, but the entry is the reversal's proof).
    expect(h.recentVerifierSummaries).toHaveBeenCalledTimes(1)
    // S1 is still open, so the deterministic plan-incomplete branch still
    // fires for it (the judge failing open falls through to the rest of the
    // tree).
    const texts = planTexts(h.prompt)
    expect(texts).toHaveLength(1)
    expect(texts[0]).toContain('S1 (pending): "Sources management page"')
    // Only S1 is open, so the claimed-but-unaudited final story is not
    // recited as an open story.
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
    // Single-story plan: C-16's fix promotes the next PENDING story whenever
    // the active slot vacates (complete, blocked, or failed alike) -- with a
    // trailing pending story present, blocking S1 would auto-promote it
    // instead of leaving the plan with no active story, which is a
    // different scenario than this test is for. One story leaves nothing to
    // promote, preserving the "no active story" case this test targets.
    h.storyEngine.createPlan(sid, [
      { text: "Blocked story", acceptanceItems: ["cannot be done"], scopeGlobs: [], verifiers: [], tasks: [{ text: "do the blocked work" }] },
    ])
    h.storyEngine.checkpoint(sid, "S1.T1", "blocked")
    expect(h.storyEngine.getActiveStory(sid)).toBeNull()

    await handleSessionIdle(h.ctx, sid)

    const texts = planTexts(h.prompt)
    expect(texts).toHaveLength(1)
    expect(texts[0]).toContain('S1 (blocked): "Blocked story"')
    expect(texts[0]).toContain("No story is active")
  })

  // Sign-off finding: reopenStory/elicify_vertex_plan_reopen (C-6) exist, but
  // nothing told the model about them at the exact moment the harness itself
  // detects the plan is stuck on a blocked/failed story -- the one place C-2's
  // own rationale ("the model reads tool output, not toasts") says this kind
  // of guidance actually has to land.
  it("names elicify_vertex_plan_reopen when the plan is stalled on a blocked/failed story", async () => {
    const h = harness()
    const sid = "s1"
    quietSession(h, sid)
    // Single-story plan: see the previous test's comment -- with a pending
    // trailing story, C-16's fix would auto-promote it instead of leaving
    // the plan genuinely stalled, which is the scenario this test needs.
    h.storyEngine.createPlan(sid, [
      { text: "Blocked story", acceptanceItems: ["cannot be done"], scopeGlobs: [], verifiers: [], tasks: [{ text: "do the blocked work" }] },
    ])
    h.storyEngine.checkpoint(sid, "S1.T1", "blocked")

    await handleSessionIdle(h.ctx, sid)

    const texts = planTexts(h.prompt)
    expect(texts).toHaveLength(1)
    expect(texts[0]).toContain("elicify_vertex_plan_reopen")
    expect(texts[0]).toContain("S1")
  })

  it("does NOT mention elicify_vertex_plan_reopen when no story is active but none is blocked/failed either", async () => {
    const h = harness()
    const sid = "s1"
    quietSession(h, sid)
    // No createPlan call at all -> getActiveStory is null with an EMPTY
    // incomplete list is impossible (handleIncompletePlan wouldn't fire), so
    // exercise the "stalled, but for a different reason" shape instead: a
    // plan whose only story is still pending (never activated), never
    // blocked/failed. Confirms the reopen mention is conditional, not blanket.
    h.storyEngine.createPlan(sid, [
      { text: "Only story", acceptanceItems: ["not started"], scopeGlobs: [], verifiers: [], tasks: [{ text: "do the only work" }] },
    ])
    h.storyEngine.checkpoint(sid, "S1.T1", "blocked")
    // Reopen it back to pending isn't reachable with a single-story plan
    // (reopen always makes it active when nothing else is active) -- so
    // assert the discriminating negative directly against the finding
    // function instead of contorting a plan into an artificial state.
    const { incompletePlanFinding } = await import("../../src/v2/wiring/findings.js")
    const pending = h.storyEngine.getPlan(sid)!.stories[0]
    const finding = incompletePlanFinding({
      instanceId: "x",
      totalStories: 1,
      incomplete: [{ ...pending, status: "pending" }],
      activeStories: [],
    })
    expect(finding.prescription).not.toContain("elicify_vertex_plan_reopen")
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

// ===========================================================================
// Watchdog behaviors (redesign point 9 — wiring/watchdog.ts): the idle gate
// defers nudging while a `task` delegation is in flight, and pauses
// auto-continuations after a capped run of no-progress continuation turns.
// ===========================================================================
describe("handleSessionIdle — watchdog: delegation deferral + stall pause", () => {
  it("defers the gate while a delegation is mid-flight AND a child session is still busy (probe confirms)", async () => {
    // The tracker is the cheap signal, the busy-children probe is the
    // ground truth — deferral requires BOTH (a tracker-positive alone must
    // not silence the gate, see the stale-entry test below).
    const h = harness({ busyChildren: true })
    const sid = "s1"
    quietSession(h, sid)
    createSixStoryStylePlan(h, sid)
    h.delegation.noteTaskCall(sid, "task-call-1")

    await handleSessionIdle(h.ctx, sid)

    expect(continuations(h.prompt)).toHaveLength(0)
    expect(loggedEventTypes(h.logger)).toContain("gate:delegation-defer")
    // The deferral does NOT consume a block budget.
    expect(h.states.get(sid)!.criteriaBlocks).toBe(0)
  })

  it("does NOT defer on a stale tracker entry: a tracker-positive with no busy child proceeds (gate:delegation-stale)", async () => {
    // The defect this pins: a `task` whose tool.execute.after the host dropped
    // (or an inconsistent before/after callID) leaves a stale in-flight entry.
    // The probe returns false (child already finished) and the gate MUST
    // proceed rather than silencing the session forever.
    const h = harness() // bare client -> hasBusyChildren returns false
    const sid = "s1"
    quietSession(h, sid)
    createSixStoryStylePlan(h, sid)
    h.delegation.noteTaskCall(sid, "task-call-1") // never paired with noteTaskDone

    await handleSessionIdle(h.ctx, sid)

    expect(loggedEventTypes(h.logger)).toContain("gate:delegation-stale")
    expect(loggedEventTypes(h.logger)).not.toContain("gate:delegation-defer")
    // The gate proceeded: the plan-incomplete continuation fired.
    expect(continuations(h.prompt).map((c) => c.text).some((t) => t.includes("vertex:plan-incomplete"))).toBe(true)
  })

  it("resumes the gate once the delegation returns and the child goes idle", async () => {
    const h = harness()
    const sid = "s1"
    quietSession(h, sid)
    createSixStoryStylePlan(h, sid)
    // Controllable busy-children probe: the child is busy until the
    // delegation's tool.execute.after fires.
    const session = h.ctx.client.session as unknown as Record<string, unknown>
    let childBusy = true
    session.children = vi.fn(async () => ({ data: [{ id: "child-1" }] }))
    session.status = vi.fn(async () => ({ data: { "child-1": childBusy ? { type: "busy" } : { type: "idle" } } }))
    h.delegation.noteTaskCall(sid, "task-call-1")

    await handleSessionIdle(h.ctx, sid) // tracker + busy child -> deferred
    expect(continuations(h.prompt)).toHaveLength(0)

    h.delegation.noteTaskDone(sid, "task-call-1")
    childBusy = false
    await handleSessionIdle(h.ctx, sid) // tracker clear, child idle -> fires
    expect(continuations(h.prompt).map((c) => c.text).some((t) => t.includes("vertex:plan-incomplete"))).toBe(true)
  })

  it("pauses auto-continuations after maxNoProgressTurns consecutive no-progress idles, then stays silent", async () => {
    const h = harness({ maxNoProgressTurns: 2 })
    const sid = "s1"
    quietSession(h, sid)
    createSixStoryStylePlan(h, sid)

    await handleSessionIdle(h.ctx, sid) // 1st: not no-progress (marker -1) -> dispatch
    await handleSessionIdle(h.ctx, sid) // 2nd: no-progress, count 1, < cap -> dispatch
    expect(continuations(h.prompt)).toHaveLength(2)

    await handleSessionIdle(h.ctx, sid) // 3rd: no-progress, count 2 == cap -> PAUSE, no dispatch
    expect(continuations(h.prompt)).toHaveLength(2)
    expect(h.states.get(sid)!.stallPaused).toBe(true)
    expect(loggedEventTypes(h.logger)).toContain("gate:stall-paused")

    // A 4th idle does nothing at all while paused.
    await handleSessionIdle(h.ctx, sid)
    expect(continuations(h.prompt)).toHaveLength(2)
  })

  it("real activity between idles resets the no-progress streak so the gate never pauses", async () => {
    const h = harness({ maxNoProgressTurns: 2 })
    const sid = "s1"
    const state = quietSession(h, sid)
    createSixStoryStylePlan(h, sid)

    await handleSessionIdle(h.ctx, sid) // dispatch (marker -1 -> 0)
    state.activityMarker += 1 // a real tool call happened
    await handleSessionIdle(h.ctx, sid) // progress -> streak reset, dispatch
    state.activityMarker += 1
    await handleSessionIdle(h.ctx, sid) // progress -> dispatch

    expect(continuations(h.prompt)).toHaveLength(3)
    expect(state.stallPaused).toBe(false)
    expect(loggedEventTypes(h.logger)).not.toContain("gate:stall-paused")
  })
})

// ===========================================================================
// Judge-verdict reconciliation (FR-001 / FR-001b / FR-005 / FR-007 / FR-014).
//
// These drive the REAL `handleJudgeAudit` with a stubbed judge subturn, so the
// assertions are about what the gate DOES with a verdict, not about the model.
// Every fixture is grounded in the audited session
// (`ses_04dc77bdaffej8SFJvYm5yO0CW`): the notes are real shapes the judge
// actually produced.
// ===========================================================================

/** Stub the judge subturn end to end: probe passes, verdict is `verdict`, and
 * the child session reports `childParts` (a `tool` part = the judge looked). */
function stubJudge(
  h: ReturnType<typeof harness>,
  verdict: unknown,
  childParts: Array<{ type: string }> = [{ type: "tool" }],
): void {
  const session = h.ctx.client.session as unknown as Record<string, unknown>
  // Model the REAL host: `runSubturn`'s finally AWAITS session.delete, and a
  // deleted session serves no parts. The FR-014 read must therefore happen
  // inside runSubturn (code review MAJ-004) — a stub that keeps serving parts
  // after delete would hide that the floor never fires in production.
  let childDeleted = false
  session.create = vi.fn(async () => ({ data: { id: "judge-child-1" }, error: undefined }))
  session.delete = vi.fn(async () => {
    childDeleted = true
    return { data: {}, error: undefined }
  })
  session.messages = vi.fn(async (args: { path?: { id?: string } }) =>
    args?.path?.id === "judge-child-1" && !childDeleted
      ? { data: [{ info: { role: "assistant" }, parts: childParts }], error: undefined }
      : { data: [], error: undefined },
  )
  const prompt = session.prompt as ReturnType<typeof vi.fn>
  session.prompt = vi.fn(async (args: { body?: { agent?: string } }) => {
    if (args?.body?.agent === "vertex-judge") {
      return { data: { info: {}, parts: [{ type: "text", text: JSON.stringify(verdict) }] }, error: undefined }
    }
    return prompt(args as never)
  })
  const appAgents = vi.fn(async () => ({
    data: [
      {
        name: "vertex-judge",
        mode: "subagent",
        builtIn: false,
        permission: { edit: "deny", write: "deny", bash: { "*": "deny" }, webfetch: "deny", task: "deny" },
        tools: { bash: true, read: true, glob: true, grep: true, list: true, edit: false, write: false, task: false, "*": false },
        options: {},
      },
    ],
    error: undefined,
  }))
  ;(h.ctx.client as unknown as Record<string, unknown>).app = { agents: appAgents }
  ;(h.ctx.client as unknown as Record<string, unknown>).tool = {
    ids: vi.fn(async () => ({ data: ["bash", "read", "glob", "grep", "list", "edit", "write", "task"], error: undefined })),
  }
}

/** A single-story plan whose only task is already claimed complete. */
function claimedStory(h: ReturnType<typeof harness>, sid: string, verifiers: string[] = []): void {
  h.storyEngine.createPlan(sid, [
    { text: "Research wave", acceptanceItems: ["x.md has cited sources"], scopeGlobs: [], verifiers, tasks: [{ text: "write it" }] },
  ])
  h.storyEngine.checkpoint(sid, "S1.T1", "complete")
}

describe("handleJudgeAudit — verdict reconciliation", () => {
  it("FR-001: a false 'file is missing' claim is contradicted and the story is NOT reverted", async () => {
    const h = harness({ judgeEnabled: true })
    const sid = "s1"
    const state = quietSession(h, sid)
    state.modelId = "anthropic/claude-opus-4"
    // The worktree for this session is the temp stateDir; create the file the
    // judge will (falsely) claim is absent.
    writeFileSync(join(h.stateDir, "present.md"), "# real content\n", "utf8")
    state.workspaceRoot = h.stateDir
    claimedStory(h, sid)
    stubJudge(h, {
      stories: [{ storyId: "S1", pass: false, summary: "missing file", items: [{ itemId: "A1", met: false, note: "present.md does not exist on disk" }] }],
    })

    await handleSessionIdle(h.ctx, sid)

    expect(loggedEventTypes(h.logger)).toContain("judge:contradicted")
    expect(h.storyEngine.getPlan(sid)!.stories[0].status).toBe("complete")
    // FR-001b: the pass is harness-derived, so it must be marked as such.
    expect(h.storyEngine.getPlan(sid)!.stories[0].judge?.contradictedItemIds).toEqual(["A1"])
  })

  it("FR-001: a CONTENT claim about an existing file is never contradicted — the story still reverts", async () => {
    const h = harness({ judgeEnabled: true })
    const sid = "s1"
    const state = quietSession(h, sid)
    state.modelId = "anthropic/claude-opus-4"
    writeFileSync(join(h.stateDir, "present.md"), "# stub\n", "utf8")
    state.workspaceRoot = h.stateDir
    claimedStory(h, sid)
    // The REAL correct-FAIL shape from the audited session.
    stubJudge(h, {
      stories: [
        {
          storyId: "S1",
          pass: false,
          summary: "no sources",
          items: [{ itemId: "A1", met: false, note: "present.md exists (1046 bytes) but contains no URLs or Sources section" }],
        },
      ],
    })

    await handleSessionIdle(h.ctx, sid)

    expect(loggedEventTypes(h.logger)).not.toContain("judge:contradicted")
    expect(h.storyEngine.getPlan(sid)!.stories[0].status).toBe("active") // reverted, correctly
  })

  it("FR-014: a verdict produced with ZERO tool calls is not applied", async () => {
    const h = harness({ judgeEnabled: true })
    const sid = "s1"
    const state = quietSession(h, sid)
    state.modelId = "anthropic/claude-opus-4"
    state.workspaceRoot = h.stateDir
    claimedStory(h, sid)
    stubJudge(
      h,
      { stories: [{ storyId: "S1", pass: false, summary: "nope", items: [{ itemId: "A1", met: false, note: "not delivered" }] }] },
      [{ type: "text" }], // the judge answered without observing anything
    )

    await handleSessionIdle(h.ctx, sid)

    expect(loggedEventTypes(h.logger)).toContain("judge:unverified")
    expect(h.storyEngine.getPlan(sid)!.stories[0].status).toBe("complete") // claim stands
  })

  it("FR-005: pass:false with every item met is dropped per story, leaving the story untouched", async () => {
    const h = harness({ judgeEnabled: true })
    const sid = "s1"
    const state = quietSession(h, sid)
    state.modelId = "anthropic/claude-opus-4"
    state.workspaceRoot = h.stateDir
    claimedStory(h, sid)
    // The real S2 stamp shape: pass:false while every item is met:true.
    stubJudge(h, {
      stories: [{ storyId: "S1", pass: false, summary: "contradictory", items: [{ itemId: "A1", met: true, note: "all good" }] }],
    })

    await handleSessionIdle(h.ctx, sid)

    expect(loggedEventTypes(h.logger)).toContain("judge:verdict-contradictory")
    expect(h.storyEngine.getPlan(sid)!.stories[0].status).toBe("complete")
  })

  it("FR-007: past the re-audit cap the story is escalated, not reverted again", async () => {
    const h = harness({ judgeEnabled: true, maxStoryReaudits: 1 })
    const sid = "s1"
    const state = quietSession(h, sid)
    state.modelId = "anthropic/claude-opus-4"
    state.workspaceRoot = h.stateDir
    claimedStory(h, sid)
    stubJudge(h, {
      stories: [{ storyId: "S1", pass: false, summary: "still not done", items: [{ itemId: "A1", met: false, note: "no sources cited" }] }],
    })

    await handleSessionIdle(h.ctx, sid) // revert 1 of 1
    expect(h.storyEngine.getPlan(sid)!.stories[0].status).toBe("active")

    // Re-claim and audit again: the cap is now reached.
    h.storyEngine.checkpoint(sid, "S1.T1", "complete")
    await handleSessionIdle(h.ctx, sid)

    expect(loggedEventTypes(h.logger)).toContain("judge:reaudit-capped")
    expect(h.storyEngine.getPlan(sid)!.stories[0].status).toBe("complete") // not reverted again
  })
})

// ===========================================================================
// FR-012 — continuation delivery classification and the in-flight guard.
//
// MAJ-009 (code review): this requirement shipped with zero tests, and its
// implementation produced CRIT-002 (a session that could be wedged forever).
// These pin both halves.
// ===========================================================================
describe("promptContinuation — FR-012 delivery classification", () => {
  it("a slow (still-streaming) turn is NOT reported as a delivery failure", async () => {
    const h = harness()
    const sid = "s1"
    quietSession(h, sid)
    createSixStoryStylePlan(h, sid)
    // A prompt that never settles models the real host: session.prompt
    // resolves only when the whole assistant turn ends.
    const session = h.ctx.client.session as unknown as Record<string, unknown>
    session.prompt = vi.fn(() => new Promise(() => {}))

    vi.useFakeTimers()
    try {
      const idle = handleSessionIdle(h.ctx, sid)
      await vi.advanceTimersByTimeAsync(31_000)
      await idle
    } finally {
      vi.useRealTimers()
    }

    expect(loggedEventTypes(h.logger)).toContain("gate:continuation-slow")
    expect(loggedEventTypes(h.logger)).not.toContain("gate:continuation-failed")
  })

  it("a genuine rejection IS reported as a delivery failure", async () => {
    const h = harness()
    const sid = "s1"
    quietSession(h, sid)
    createSixStoryStylePlan(h, sid)
    const session = h.ctx.client.session as unknown as Record<string, unknown>
    session.prompt = vi.fn(async () => {
      throw new Error("host refused")
    })

    await handleSessionIdle(h.ctx, sid)

    expect(loggedEventTypes(h.logger)).toContain("gate:continuation-failed")
    expect(loggedEventTypes(h.logger)).not.toContain("gate:continuation-slow")
  })

  // CRIT-002 regression: the defect that made this requirement dangerous.
  it("a SYNCHRONOUS throw from session.prompt does not wedge the session", async () => {
    const h = harness()
    const sid = "s1"
    const state = quietSession(h, sid)
    createSixStoryStylePlan(h, sid)
    const session = h.ctx.client.session as unknown as Record<string, unknown>
    session.prompt = vi.fn(() => {
      throw new Error("sync throw")
    })

    await handleSessionIdle(h.ctx, sid)

    // Before the fix this stayed true forever, and plugin.ts's chat.message
    // returns early while it is set — the whole harness went inert.
    expect(state.idleContinuationInFlight).toBe(false)
    expect(loggedEventTypes(h.logger)).toContain("gate:continuation-failed")
  })

  it("a real user message clears a guard held by a never-settling prompt", async () => {
    const h = harness()
    const sid = "s1"
    const state = quietSession(h, sid)
    createSixStoryStylePlan(h, sid)
    const session = h.ctx.client.session as unknown as Record<string, unknown>
    session.prompt = vi.fn(() => new Promise(() => {}))

    vi.useFakeTimers()
    try {
      const idle = handleSessionIdle(h.ctx, sid)
      await vi.advanceTimersByTimeAsync(31_000)
      await idle
    } finally {
      vi.useRealTimers()
    }
    // The timeout path deliberately HOLDS the guard (the turn is still
    // streaming and it is the only defence against a continuation echoing
    // itself) — but the next real user message must release it.
    expect(state.idleContinuationInFlight).toBe(true)
    resetTurnState(state)
    expect(state.idleContinuationInFlight).toBe(false)
  })
})

describe("judge re-audit counter — MIN-004", () => {
  it("a PASSING verdict clears that story's consecutive-revert streak", async () => {
    const h = harness({ judgeEnabled: true, maxStoryReaudits: 2 })
    const sid = "s1"
    const state = quietSession(h, sid)
    state.modelId = "anthropic/claude-opus-4"
    state.workspaceRoot = h.stateDir
    claimedStory(h, sid)

    // Revert once.
    stubJudge(h, {
      stories: [{ storyId: "S1", pass: false, summary: "not done", items: [{ itemId: "A1", met: false, note: "no sources cited" }] }],
    })
    await handleSessionIdle(h.ctx, sid)
    expect(state.storyReaudits.S1).toBe(1)

    // Now it passes: the streak must reset, not accumulate.
    h.storyEngine.checkpoint(sid, "S1.T1", "complete")
    stubJudge(h, { stories: [{ storyId: "S1", pass: true, summary: "delivered", items: [{ itemId: "A1", met: true, note: "verified" }] }] })
    await handleSessionIdle(h.ctx, sid)

    expect(state.storyReaudits.S1).toBeUndefined()
  })
})

// ===========================================================================
// FR-011 / FR-006 (MIN-002) — the plan digest the judge is actually sent.
//
// Both requirements are properties of ONE string: the `plan` field of the
// payload dispatched to the `vertex-judge` subturn. So these read it back off
// the prompt mock rather than re-rendering it — a re-render could agree with a
// broken caller (the whole MAJ-005 finding was that `renderPlanDigest` was
// correct in isolation but the call site never gave it the root).
//
// Grounding (`ses_04dc77bdaffej8SFJvYm5yO0CW`): with bare relative paths in the
// digest the judge asserted "research/x.json does not exist" about files that
// DID exist, and the 4000-char cap truncated the tail of the plan, after which
// it FAILed stories citing "S5 has no independent verifier set in the digest"
// — the content the cap had removed.
// ===========================================================================

/** The `plan` field of the payload the judge was actually prompted with. */
function judgePlanDigest(h: ReturnType<typeof harness>): string {
  const session = h.ctx.client.session as unknown as Record<string, unknown>
  const prompt = session.prompt as ReturnType<typeof vi.fn>
  const call = prompt.mock.calls.find((c) => (c[0] as { body?: { agent?: string } })?.body?.agent === "vertex-judge")
  expect(call, "the judge subturn was never prompted").toBeDefined()
  const text = (call![0] as { body: { parts: Array<{ text: string }> } }).body.parts[0].text
  return (JSON.parse(text) as { plan?: string }).plan ?? ""
}

describe("renderPlanDigest — FR-011 absolute worktree root", () => {
  it("states the absolute worktree root as the digest's first line", async () => {
    const h = harness({ judgeEnabled: true })
    const sid = "s1"
    const state = quietSession(h, sid)
    state.modelId = "anthropic/claude-opus-4"
    state.workspaceRoot = h.stateDir
    claimedStory(h, sid, ["test -f research/x.md"])
    stubJudge(h, {
      stories: [{ storyId: "S1", pass: true, summary: "delivered", items: [{ itemId: "A1", met: true, note: "read it" }] }],
    })

    await handleSessionIdle(h.ctx, sid)

    const digest = judgePlanDigest(h)
    // MUTATION: drop the `workspaceRoot` argument at the call site -> red.
    expect(digest.split("\n")[0]).toBe(`Worktree root (all paths below are relative to this): ${h.stateDir}`)
    // The root is an ABSOLUTE path, which is the entire point of AS1: a
    // relative root would leave the digest's paths as unresolvable as before.
    expect(h.stateDir.startsWith("/")).toBe(true)
    // ...and the plan summary still follows it, so nothing was displaced.
    expect(digest.split("\n")[1]).toContain("Audit these claimed-complete stories: S1.")
    // The declared verifier — a bare relative path — is now resolvable.
    expect(digest).toContain("verifiers: test -f research/x.md")
  })
})

describe("renderPlanDigest — FR-006 / MIN-002: audited stories render first", () => {
  it("puts the story under audit ahead of the stories that are not", async () => {
    const h = harness({ judgeEnabled: true })
    const sid = "s1"
    const state = quietSession(h, sid)
    state.modelId = "anthropic/claude-opus-4"
    state.workspaceRoot = h.stateDir

    // Three INDEPENDENT stories, so the DAG activates all three tasks at level
    // 0 and only the one we checkpoint becomes complete. The audited story is
    // deliberately the LAST in plan order — the position truncation eats first.
    h.storyEngine.createPlan(sid, [
      {
        text: "First story",
        acceptanceItems: ["a1 done"],
        scopeGlobs: [],
        verifiers: ["test -f research/first.md"],
        tasks: [{ text: "do the first" }],
      },
      {
        text: "Second story",
        acceptanceItems: ["a2 done"],
        scopeGlobs: [],
        verifiers: ["test -f research/second.md"],
        tasks: [{ text: "do the second" }],
      },
      {
        text: "Third story",
        acceptanceItems: ["a3 done"],
        scopeGlobs: [],
        verifiers: ["test -f research/third.md"],
        tasks: [{ text: "do the third" }],
      },
    ])
    h.storyEngine.checkpoint(sid, "S3.T1", "complete")
    expect(h.storyEngine.getPlan(sid)!.stories.map((s) => s.status)).toEqual(["active", "active", "complete"])

    stubJudge(h, {
      stories: [{ storyId: "S3", pass: true, summary: "delivered", items: [{ itemId: "A1", met: true, note: "read it" }] }],
    })

    await handleSessionIdle(h.ctx, sid)

    const digest = judgePlanDigest(h)
    const s3 = digest.indexOf("S3 (")
    const s1 = digest.indexOf("S1 (")
    const s2 = digest.indexOf("S2 (")
    expect(s3, "S3 must be rendered").toBeGreaterThan(-1)
    // MUTATION: render `plan.stories` in plan order again -> red.
    expect(s3).toBeLessThan(s1)
    expect(s3).toBeLessThan(s2)
    // Relative order WITHIN the non-audited group is preserved, so the DAG
    // still reads top-to-bottom for the context stories.
    expect(s1).toBeLessThan(s2)
    // Every story is still present — ordering must not drop context.
    expect(digest).toContain("verifiers: test -f research/first.md")
    expect(digest).toContain("verifiers: test -f research/third.md")
    // ...and the audited story's contract precedes the unaudited ones', which
    // is what makes truncation-from-the-tail structurally safe.
    expect(digest.indexOf("test -f research/third.md")).toBeLessThan(
      digest.indexOf("test -f research/first.md"),
    )
  })
})
