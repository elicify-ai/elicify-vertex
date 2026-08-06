import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi, beforeEach } from "vitest"

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
import { cancelPauseJudge } from "../../src/v2/wiring/gate.js"
import { holdoutSuppresses } from "../../src/measurement.js"
import { PAUSE_JUDGE_DELAY_MS } from "../../src/v2/pauseJudge.js"
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
  verifierEnabled?: boolean
  maxNoProgressTurns?: number
  busyChildren?: boolean
  maxStoryReaudits?: number
  /** FR-014: parts returned for the verifier child session (a `tool` part = the verifier observed something). */
  childParts?: Array<{ type: string }>
  /** The verdict the stubbed verifier subturn returns. */
  verifierVerdict?: unknown
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
  // `appendVerifierCloseOut` is the ONLY caller of `recentVerifierSummaries` in
  // gate.ts, and it reads it only after the `verifierEnabled`/`modelId` guards —
  // so "was this mock called?" is an exact, side-effect-free probe of
  // "did the verifier stage run?" with no agent/network stubbing.
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
    verifierEnabled: opts.verifierEnabled ?? false,
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
    // The `[vertex:...]` marker is stripped at dispatch so the model reads
    // a continuation as an instruction, not as harness output — match the
    // directive's own wording. The family stays in the event log.
    .filter((text) => text.includes("states an intent to do further work"))
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

/**
 * Continuation texts belonging to one directive family.
 *
 * The `[vertex:…]` marker is stripped from what the model receives (a
 * continuation must read as an instruction, not as harness output), so the
 * family is no longer recoverable from the text. It comes from the
 * `gate:continuation-dispatched` audit event instead, whose 500-char prefix
 * is matched back to the full dispatched text.
 */
function familyTexts(h: ReturnType<typeof harness>, family: string): string[] {
  const prefixes = h.logger.mock.calls
    .filter((c) => c[0] === "gate:continuation-dispatched" && (c[1] as { family?: string })?.family === family)
    .map((c) => (c[1] as { text: string }).text.slice(0, 60))
  return continuations(h.prompt)
    .map((c) => c.text)
    .filter((t) => prefixes.some((prefix) => t.startsWith(prefix)))
}

/** Same, keeping the session each continuation was addressed to. */
function familyContinuations(h: ReturnType<typeof harness>, family: string): Array<{ sid: string; text: string }> {
  const prefixes = h.logger.mock.calls
    .filter((c) => c[0] === "gate:continuation-dispatched" && (c[1] as { family?: string })?.family === family)
    .map((c) => (c[1] as { text: string }).text.slice(0, 60))
  return continuations(h.prompt).filter((c) => prefixes.some((prefix) => c.text.startsWith(prefix)))
}

const planTexts = (h: ReturnType<typeof harness>): string[] => familyTexts(h, "plan-incomplete")

describe("handleSessionIdle — stage-1 plan-completion gate", () => {
  it("AC-1/AC-2: dispatches one continuation naming every open story with its status, the active story's declared verifier, and the acceptance items the verifier will audit", async () => {
    const h = harness()
    const sid = "s1"
    quietSession(h, sid)
    createSixStoryStylePlan(h, sid)

    await handleSessionIdle(h.ctx, sid)

    const fired = continuations(h.prompt)
    expect(fired).toHaveLength(1)
    const text = fired[0].text
    expect(fired[0].sid).toBe(sid)
    expect(text).toContain("The story plan is not complete")
    // AC-2: which stories are incomplete, and their status.
    expect(text).toContain('S1 (active): "Scaffold the app"')
    expect(text).toContain('S2 (pending): "Sources management page"')
    expect(text).toContain('S3 (pending): "End-to-end UAT via Playwright"')
    // AC-2 (redesign point 8): the active story's declared verifier...
    expect(text).toContain("npx vitest run tests/scaffold.test.ts")
    // ...and EVERY acceptance item the verifier will audit (A1 and A2 — the
    // per-item evidence-citation contract is gone, so the verifier audits all
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

    const texts = planTexts(h)
    expect(texts).toHaveLength(1)
    expect(texts[0]).toContain("S1 declares no verifiers")
    expect(texts[0]).toContain("amend S1 to declare the verifier you intend to use")
  })

  it("AC-6 discrimination: a fully complete plan is NOT blocked, and the verifier stage still runs exactly as before (AC-4)", async () => {
    const h = harness({ verifierEnabled: true })
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
    expect(h.recentVerifierSummaries).toHaveBeenCalledTimes(1) // verifier stage entered
    expect(state.criteriaBlocks).toBe(0) // no block budget consumed
    expect(loggedEventTypes(h.logger)).not.toContain("gate:plan-incomplete")
  })

  it("AC-3 (redesign point 2): the verifier DOES audit a claimed-final story even while an earlier story is still open", async () => {
    // This REVERSES the pre-redesign behavior the old test encoded (the verifier
    // was gated behind every story reaching "complete" deterministically, so
    // it could never rescue exactly this stall). The verifier is now the sole
    // arbiter: it audits any claimed-complete story at idle regardless of the
    // others' states. Here S2 is claimed complete while S1 is still pending
    // — unreachable through the tool surface (checkpoint promotes in order),
    // written straight to disk to isolate the audit gate.
    const h = harness({ verifierEnabled: true })
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
          // S2 is the claimed-complete final story the verifier audits; its task
          // carries the matching complete status + completedAt.
          tasks: [{ id: "S2.T1", text: "run the UAT", dependsOn: [], status: "complete", completedAt: new Date().toISOString() }],
        },
      ],
    }
    writeFileSync(join(h.stateDir, "plan.json"), JSON.stringify({ [sid]: plan }, null, 2), "utf8")

    await handleSessionIdle(h.ctx, sid)

    // The verifier stage ENTERED — it read the verifier summaries to build the
    // audit payload for the claimed S2 (the stub client's probe then fails
    // open, dispatching nothing, but the entry is the reversal's proof).
    expect(h.recentVerifierSummaries).toHaveBeenCalledTimes(1)
    // S1 is still open, so the deterministic plan-incomplete branch still
    // fires for it (the verifier failing open falls through to the rest of the
    // tree).
    const texts = planTexts(h)
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
    expect(texts[0]).toContain("The story plan is not complete")
    expect(texts[1]).toContain("No acceptance criteria were captured")
    expect(texts[1]).not.toContain("The story plan is not complete")
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
    expect(texts[0]).toContain("The story plan is not complete")
    expect(promiseTexts(h.prompt)).toHaveLength(0)
    expect(texts[0]).not.toContain("No acceptance criteria were captured")
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

    const texts = planTexts(h)
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

    const texts = planTexts(h)
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
      expect(familyTexts(h, "plan-incomplete")).toHaveLength(0)
      expect(texts).toHaveLength(1)
      expect(texts[0]).toContain("No acceptance criteria were captured") // suppression is scoped, not a global mute
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
  it("blocks with a promise-no-act continuation when the last assistant text defers work after changed files", async () => {
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
// the stop-block and the verifier for EVERY session as soon as a second one
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

    const fired = familyContinuations(h, "stop-block")
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

    const fired = familyContinuations(h, "stop-block")
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
    // A verifier/intake subturn child leaking into the active list (FR-036):
    // recorded in SelfCreatedSessions exactly as `runSubturn` records it.
    const child = freshSessionState(h.stateDir)
    child.active = true
    h.states.set("verifier-child-1", child)
    h.selfCreated.record("verifier-child-1", "parent")
    expect(h.ctx.activeSessionIDs()).toEqual(["parent", "verifier-child-1"])

    await handleSessionIdle(h.ctx, "parent")

    const fired = familyContinuations(h, "stop-block")
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
    expect(familyTexts(h, "plan-incomplete").length).toBeGreaterThan(0)
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
    expect(familyTexts(h, "plan-incomplete").length).toBeGreaterThan(0)
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
// Verifier-verdict reconciliation (FR-001 / FR-001b / FR-005 / FR-007 / FR-014).
//
// These drive the REAL `handleVerifierAudit` with a stubbed verifier subturn, so the
// assertions are about what the gate DOES with a verdict, not about the model.
// Every fixture is grounded in the audited session
// (`ses_04dc77bdaffej8SFJvYm5yO0CW`): the notes are real shapes the verifier
// actually produced.
// ===========================================================================

/** Stub the verifier subturn end to end: probe passes, verdict is `verdict`, and
 * the child session reports `childParts` (a `tool` part = the verifier looked). */
function stubVerifier(
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
  session.create = vi.fn(async () => ({ data: { id: "verifier-child-1" }, error: undefined }))
  session.delete = vi.fn(async () => {
    childDeleted = true
    return { data: {}, error: undefined }
  })
  session.messages = vi.fn(async (args: { path?: { id?: string } }) =>
    args?.path?.id === "verifier-child-1" && !childDeleted
      ? { data: [{ info: { role: "assistant" }, parts: childParts }], error: undefined }
      : { data: [], error: undefined },
  )
  const prompt = session.prompt as ReturnType<typeof vi.fn>
  session.prompt = vi.fn(async (args: { body?: { agent?: string } }) => {
    if (args?.body?.agent === "vertex-verifier") {
      return { data: { info: {}, parts: [{ type: "text", text: JSON.stringify(verdict) }] }, error: undefined }
    }
    return prompt(args as never)
  })
  const appAgents = vi.fn(async () => ({
    data: [
      {
        name: "vertex-verifier",
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

describe("handleVerifierAudit — verdict reconciliation", () => {
  it("FR-001: a false 'file is missing' claim is contradicted and the story is NOT reverted", async () => {
    const h = harness({ verifierEnabled: true })
    const sid = "s1"
    const state = quietSession(h, sid)
    state.modelId = "anthropic/claude-opus-4"
    // The worktree for this session is the temp stateDir; create the file the
    // verifier will (falsely) claim is absent.
    writeFileSync(join(h.stateDir, "present.md"), "# real content\n", "utf8")
    state.workspaceRoot = h.stateDir
    claimedStory(h, sid)
    stubVerifier(h, {
      stories: [{ storyId: "S1", pass: false, summary: "missing file", items: [{ itemId: "A1", met: false, note: "present.md does not exist on disk" }] }],
    })

    await handleSessionIdle(h.ctx, sid)

    expect(loggedEventTypes(h.logger)).toContain("verifier:contradicted")
    expect(h.storyEngine.getPlan(sid)!.stories[0].status).toBe("complete")
    // FR-001b: the pass is harness-derived, so it must be marked as such.
    expect(h.storyEngine.getPlan(sid)!.stories[0].verifier?.contradictedItemIds).toEqual(["A1"])
  })

  it("FR-001: a CONTENT claim about an existing file is never contradicted — the story still reverts", async () => {
    const h = harness({ verifierEnabled: true })
    const sid = "s1"
    const state = quietSession(h, sid)
    state.modelId = "anthropic/claude-opus-4"
    writeFileSync(join(h.stateDir, "present.md"), "# stub\n", "utf8")
    state.workspaceRoot = h.stateDir
    claimedStory(h, sid)
    // The REAL correct-FAIL shape from the audited session.
    stubVerifier(h, {
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

    expect(loggedEventTypes(h.logger)).not.toContain("verifier:contradicted")
    expect(h.storyEngine.getPlan(sid)!.stories[0].status).toBe("active") // reverted, correctly
  })

  // THE VERIFIER JUDGES; IT DOES NOT JUST RUN COMMANDS.
  //
  // This used to require a tool call before any failing verdict was applied.
  // That test was wrong: the verifier is handed the plan digest, the
  // acceptance criteria, the diff summary and the session transcript — the
  // transcript being its LEADING evidence — and reasoning over that is the
  // work. Measured cost of the old rule in a live session: the verifier
  // judged five stories unmet and wrote per-item reasons; the verdict was
  // discarded for want of an `ls`, every story froze at
  // `complete / unapplied:"unverified"`, and two branches argued about that
  // frozen state until the session was killed.
  //
  // The test is now substantiation, which is what actually separates
  // judgement from fabrication.
  it("applies a SUBSTANTIATED failing verdict even with zero tool calls", async () => {
    const h = harness({ verifierEnabled: true })
    const sid = "s1"
    const state = quietSession(h, sid)
    state.modelId = "anthropic/claude-opus-4"
    state.workspaceRoot = h.stateDir
    claimedStory(h, sid)
    stubVerifier(
      h,
      // SUBSTANTIATED: names the item and says why. No tool call, and that is
      // fine — the reason is the evidence.
      { stories: [{ storyId: "S1", pass: false, summary: "nope", items: [{ itemId: "A1", met: false, note: "not delivered" }] }] },
      [{ type: "text" }],
    )

    await handleSessionIdle(h.ctx, sid)

    expect(loggedEventTypes(h.logger)).not.toContain("verifier:unverified")
    expect(h.storyEngine.getPlan(sid)!.stories[0].status, "a reasoned failure must revert the claim").toBe("active")
  })

  it("bounds a failing verdict whose unmet items carry NO reason", async () => {
    const h = harness({ verifierEnabled: true })
    const sid = "s1"
    const state = quietSession(h, sid)
    state.modelId = "anthropic/claude-opus-4"
    state.workspaceRoot = h.stateDir
    claimedStory(h, sid)
    stubVerifier(h, {
      stories: [{ storyId: "S1", pass: false, summary: "nope", items: [{ itemId: "A1", met: false, note: "" }] }],
    })

    await handleSessionIdle(h.ctx, sid)

    expect(loggedEventTypes(h.logger)).toContain("verifier:unverified")
    expect(h.storyEngine.getPlan(sid)!.stories[0].status, "an unexplained failure must not revert work").toBe("complete")
  })

  it("FR-005: pass:false with every item met is dropped per story, leaving the story untouched", async () => {
    const h = harness({ verifierEnabled: true })
    const sid = "s1"
    const state = quietSession(h, sid)
    state.modelId = "anthropic/claude-opus-4"
    state.workspaceRoot = h.stateDir
    claimedStory(h, sid)
    // The real S2 stamp shape: pass:false while every item is met:true.
    stubVerifier(h, {
      stories: [{ storyId: "S1", pass: false, summary: "contradictory", items: [{ itemId: "A1", met: true, note: "all good" }] }],
    })

    await handleSessionIdle(h.ctx, sid)

    expect(loggedEventTypes(h.logger)).toContain("verifier:verdict-contradictory")
    expect(h.storyEngine.getPlan(sid)!.stories[0].status).toBe("complete")
  })

  // -------------------------------------------------------------------------
  // C2 (grill round 2) — a bounding stamp is NOT an audit pass.
  //
  // `boundUnappliedVerdicts` must write a stamp, or the `!story.verifier` audit
  // selector re-runs the verifier on the story every idle forever (MAJ-003). It
  // used to write `pass: true` to do that, which meant an unusable verdict —
  // one the harness explicitly refused to act on — read downstream as "this
  // story passed audit", including to the close-out's `verifier?.pass === true`
  // gate. The refusal now has its own field.
  // -------------------------------------------------------------------------
  it("C2: an UNVERIFIED verdict is stamped as unapplied, not as a pass", async () => {
    const h = harness({ verifierEnabled: true })
    const sid = "s1"
    const state = quietSession(h, sid)
    state.modelId = "anthropic/claude-opus-4"
    state.workspaceRoot = h.stateDir
    claimedStory(h, sid)
    stubVerifier(
      h,
      // Unsubstantiated: a failure with no reason. THIS is what gets bounded now —
      // not a reasoned verdict that happened to skip the shell.
      { stories: [{ storyId: "S1", pass: false, summary: "nope", items: [] }] },
    )

    await handleSessionIdle(h.ctx, sid)

    const stamp = h.storyEngine.getPlan(sid)!.stories[0].verifier!
    expect(stamp.unapplied).toBe("unverified")
    // The verifier's actual answer is preserved rather than overwritten with a
    // pass the verifier never gave.
    expect(stamp.pass).toBe(false)
    // ...and refusing to apply it still means refusing to REVERT on it.
    expect(h.storyEngine.getPlan(sid)!.stories[0].status).toBe("complete")
  })

  it("C2: a CONTRADICTORY verdict is stamped as unapplied and reverts nothing", async () => {
    const h = harness({ verifierEnabled: true })
    const sid = "s1"
    const state = quietSession(h, sid)
    state.modelId = "anthropic/claude-opus-4"
    state.workspaceRoot = h.stateDir
    claimedStory(h, sid)
    stubVerifier(h, {
      stories: [{ storyId: "S1", pass: false, summary: "contradictory", items: [{ itemId: "A1", met: true, note: "all good" }] }],
    })

    await handleSessionIdle(h.ctx, sid)

    const stamp = h.storyEngine.getPlan(sid)!.stories[0].verifier!
    expect(stamp.unapplied).toBe("contradictory")
    expect(h.storyEngine.getPlan(sid)!.stories[0].status).toBe("complete")
  })

  // MAJ-3 (grill round 3): the close-out guard — the load-bearing half of C2 —
  // had no test at all; reverting `allPassed` left the suite green.
  //
  // Round 5 changed which shape reaches it. The FR-014 floor used to sweep the
  // whole batch, so a story the verifier PASSED with every item met was stamped
  // `unverified` too (CR-5) — now fixed, and a clean pass applies. The shape
  // that remains, and the one worth guarding, is a pass with NOTHING BEHIND
  // IT: `pass: true` with no items, produced without a single tool call.
  // `isVerifierVerdictShape` accepts it (`[].every(...)` is vacuously true), so
  // only this guard stops it satisfying the plan-complete claim.
  it("MAJ-3: an unobserved pass:true with no items does NOT count toward the close-out", async () => {
    const h = harness({ verifierEnabled: true })
    const sid = "s1"
    const state = quietSession(h, sid)
    state.modelId = "anthropic/claude-opus-4"
    state.workspaceRoot = h.stateDir
    claimedStory(h, sid)

    stubVerifier(h, { stories: [{ storyId: "S1", pass: true, summary: "looks fine to me", items: [] }] })
    await handleSessionIdle(h.ctx, sid)

    const stamp = h.storyEngine.getPlan(sid)!.stories[0].verifier!
    expect(stamp.pass).toBe(true)
    expect(stamp.unapplied).toBe("unverified")

    await handleSessionIdle(h.ctx, sid)
    const said = continuations(h.prompt)
      .map((c) => c.text)
      .join("\n")
    expect(said).not.toContain("independently verified")
    expect(said).toContain("S1")
  })

  // CR-5: a story the verifier genuinely passed, in a batch bounded because a
  // SIBLING was unsubstantiated, must still be applied. It used to be stamped
  // `unverified` too, which barred it from `allPassed` AND from re-audit (the
  // selector skips a stamped story), so it could never become verified.
  it("CR-5: a clean passing verdict is applied even when a sibling is bounded", async () => {
    const h = harness({ verifierEnabled: true })
    const sid = "s1"
    const state = quietSession(h, sid)
    state.modelId = "anthropic/claude-opus-4"
    state.workspaceRoot = h.stateDir
    h.storyEngine.createPlan(sid, [
      { text: "Research wave", acceptanceItems: ["x.md cites sources"], scopeGlobs: [], verifiers: [], tasks: [{ text: "write it" }] },
      { text: "Chart wave", acceptanceItems: ["chart renders"], scopeGlobs: [], verifiers: [], tasks: [{ text: "build it" }] },
    ])
    h.storyEngine.checkpoint(sid, "S1.T1", "complete")
    h.storyEngine.checkpoint(sid, "S2.T1", "complete")

    stubVerifier(
      h,
      {
        stories: [
          // S1 unsubstantiated (no items) so it is bounded; a REASONED failure
          // would now simply be applied, which is the point of the new rule.
          { storyId: "S1", pass: false, summary: "no sources", items: [] },
          { storyId: "S2", pass: true, summary: "chart is there", items: [{ itemId: "A1", met: true, note: "verified" }] },
        ],
      },
    )
    await handleSessionIdle(h.ctx, sid)

    const stories = h.storyEngine.getPlan(sid)!.stories
    expect(stories[0].verifier!.unapplied).toBe("unverified")
    expect(stories[1].verifier!.unapplied).toBeUndefined()
    expect(stories[1].verifier!.pass).toBe(true)
  })

  // CR-4: an empty `items` array made the floor's trigger vacuously false, so
  // the least substantiated verdict possible — a bare `pass:false` with no
  // items, produced with zero tool calls — bypassed it and reverted the story.
  it("CR-4: an unobserved pass:false with NO items does not revert the story", async () => {
    const h = harness({ verifierEnabled: true })
    const sid = "s1"
    const state = quietSession(h, sid)
    state.modelId = "anthropic/claude-opus-4"
    state.workspaceRoot = h.stateDir
    claimedStory(h, sid)

    stubVerifier(h, { stories: [{ storyId: "S1", pass: false, summary: "the research files are missing", items: [] }] }, [
      { type: "text" },
    ])
    await handleSessionIdle(h.ctx, sid)

    expect(h.storyEngine.getPlan(sid)!.stories[0].status).toBe("complete")
    expect(loggedEventTypes(h.logger)).toContain("verifier:unverified")
  })

  // CR-8: `itemId` is LLM-authored and not unique. Matching the contradiction
  // set by id let one disproven path claim clear a DIFFERENT item sharing the
  // id, laundering a genuine content failure into a harness-derived pass.
  it("CR-8: a duplicated itemId does not let one veto mask a real failure", async () => {
    const h = harness({ verifierEnabled: true })
    const sid = "s1"
    const state = quietSession(h, sid)
    state.modelId = "anthropic/claude-opus-4"
    writeFileSync(join(h.stateDir, "present.md"), "# real\n", "utf8")
    state.workspaceRoot = h.stateDir
    claimedStory(h, sid)

    stubVerifier(h, {
      stories: [
        {
          storyId: "S1",
          pass: false,
          summary: "mixed",
          items: [
            { itemId: "A1", met: false, note: "present.md does not exist on disk" },
            { itemId: "A1", met: false, note: "no sources are cited anywhere in the document" },
          ],
        },
      ],
    })
    await handleSessionIdle(h.ctx, sid)

    // The path claim is disproven, but the content failure stands, so the
    // story must be REVERTED rather than re-derived into a pass.
    expect(h.storyEngine.getPlan(sid)!.stories[0].status).toBe("active")
  })

  it("C2: a plan settled only by unapplied stamps does NOT get the independently-verified close-out", async () => {
    const h = harness({ verifierEnabled: true })
    const sid = "s1"
    const state = quietSession(h, sid)
    state.modelId = "anthropic/claude-opus-4"
    state.workspaceRoot = h.stateDir
    claimedStory(h, sid)
    stubVerifier(
      h,
      // Unsubstantiated (no items) — the bounded path under the new rule.
      { stories: [{ storyId: "S1", pass: false, summary: "nope", items: [] }] },
    )
    await handleSessionIdle(h.ctx, sid)

    // Second idle: every story is complete and stamped, so the verifier is not
    // re-run. The harness must say the story was never verified rather than
    // claim the verifier confirmed it — or go silent, which is what an
    // `allPassed` that counted the bounding stamp would have produced.
    await handleSessionIdle(h.ctx, sid)

    const said = continuations(h.prompt)
      .map((c) => c.text)
      .join("\n")
    expect(said).not.toContain("independently verified")
    expect(said).toContain("S1")
    expect(said).toMatch(/were NOT verified|remain unverified/)
  })

  // MAJ-4 (round 4): `unauditedEscalated` is per PLAN, not per session. It was
  // initialised only in `freshSessionState`, so a SECOND unaudited plan in the
  // same session found the flag already spent and the run ended in silence —
  // the exact outcome the escalation exists to prevent. A surviving mutant
  // showed the reset had no test.
  it("MAJ-4: a second unaudited plan in the same session still escalates", async () => {
    const h = harness({ verifierEnabled: true })
    const sid = "s1"
    const state = quietSession(h, sid)
    state.modelId = "anthropic/claude-opus-4"
    state.workspaceRoot = h.stateDir

    const unauditedRound = async (): Promise<void> => {
      stubVerifier(
        h,
        // Unsubstantiated, so it is BOUNDED and leaves the story unaudited — a
        // reasoned failure is applied now and would never reach escalation.
        { stories: [{ storyId: "S1", pass: false, summary: "nope", items: [] }] },
        [{ type: "text" }], // verifier observed nothing -> bounding stamp
      )
      await handleSessionIdle(h.ctx, sid)
      await handleSessionIdle(h.ctx, sid) // settled -> escalation
    }

    claimedStory(h, sid)
    await unauditedRound()
    const first = continuations(h.prompt).filter((c) => c.text.includes("did not pass")).length
    expect(first).toBeGreaterThan(0)

    // A real user message begins the next plan — that is the boundary that
    // re-arms the escalation.
    resetTurnState(state)
    claimedStory(h, sid)
    await unauditedRound()

    expect(continuations(h.prompt).filter((c) => c.text.includes("did not pass")).length).toBeGreaterThan(first)
  })

  // MAJ-4 (round 4), other half: the once-only flag must be spent only on a
  // dispatch that HAPPENED. Setting it beforehand meant a stall-paused
  // dispatch burned the single escalation and the run went silent — the
  // outcome the branch exists to prevent.
  it("MAJ-4: a stall-paused escalation is not counted as spent", async () => {
    const h = harness({ verifierEnabled: true, maxNoProgressTurns: 1 })
    const sid = "s1"
    const state = quietSession(h, sid)
    state.modelId = "anthropic/claude-opus-4"
    state.workspaceRoot = h.stateDir
    claimedStory(h, sid)
    stubVerifier(
      h,
      // Unsubstantiated (no items) — the bounded path under the new rule.
      { stories: [{ storyId: "S1", pass: false, summary: "nope", items: [] }] },
    )
    await handleSessionIdle(h.ctx, sid) // bounding stamp written

    // Stall the gate so the escalation's dispatch is refused.
    state.stallPaused = false
    state.consecutiveNoProgress = 99
    state.markerAtLastContinuation = state.activityMarker
    await handleSessionIdle(h.ctx, sid)
    expect(continuations(h.prompt).some((c) => c.text.includes("did not pass"))).toBe(false)

    // Un-stall: the escalation must still be available.
    state.stallPaused = false
    state.consecutiveNoProgress = 0
    state.activityMarker += 1
    await handleSessionIdle(h.ctx, sid)
    expect(continuations(h.prompt).some((c) => c.text.includes("did not pass"))).toBe(true)
  })

  it("FR-007: past the re-audit cap the story is escalated, not reverted again", async () => {
    const h = harness({ verifierEnabled: true, maxStoryReaudits: 1 })
    const sid = "s1"
    const state = quietSession(h, sid)
    state.modelId = "anthropic/claude-opus-4"
    state.workspaceRoot = h.stateDir
    claimedStory(h, sid)
    stubVerifier(h, {
      stories: [{ storyId: "S1", pass: false, summary: "still not done", items: [{ itemId: "A1", met: false, note: "no sources cited" }] }],
    })

    await handleSessionIdle(h.ctx, sid) // revert 1 of 1
    expect(h.storyEngine.getPlan(sid)!.stories[0].status).toBe("active")

    // Re-claim and audit again: the cap is now reached.
    h.storyEngine.checkpoint(sid, "S1.T1", "complete")
    await handleSessionIdle(h.ctx, sid)

    expect(loggedEventTypes(h.logger)).toContain("verifier:reaudit-capped")
    expect(h.storyEngine.getPlan(sid)!.stories[0].status).toBe("complete") // not reverted again
  })

  // M3 (grill round 2): the cap stopped the REVERT but not the LOOP. It
  // `continue`d without stamping, so `story.verifier` kept the stamp from the
  // previous audit — whose `verifiedAt` predates the `completedAt` written when
  // the story was re-completed — and the selector re-picked the story on every
  // subsequent idle, running a full verifier subturn each time. Measured in the
  // field as 5 subturns over 5 idles with no exit.
  it("M3: past the cap the story is stamped, so the verifier is not re-run on later idles", async () => {
    const h = harness({ verifierEnabled: true, maxStoryReaudits: 1 })
    const sid = "s1"
    const state = quietSession(h, sid)
    state.modelId = "anthropic/claude-opus-4"
    state.workspaceRoot = h.stateDir
    claimedStory(h, sid)
    stubVerifier(h, {
      stories: [{ storyId: "S1", pass: false, summary: "still not done", items: [{ itemId: "A1", met: false, note: "no sources cited" }] }],
    })

    const verifierSubturns = (): number =>
      h.prompt.mock.calls.filter((c: unknown[]) => (c[0] as { body?: { agent?: string } })?.body?.agent === "vertex-verifier")
        .length

    await handleSessionIdle(h.ctx, sid) // revert 1 of 1
    h.storyEngine.checkpoint(sid, "S1.T1", "complete")
    await handleSessionIdle(h.ctx, sid) // cap reached
    const atCap = verifierSubturns()

    const stamp = h.storyEngine.getPlan(sid)!.stories[0].verifier!
    expect(stamp.unapplied).toBe("capped")

    // Three more idles with nothing changed: the verifier must not run again.
    await handleSessionIdle(h.ctx, sid)
    await handleSessionIdle(h.ctx, sid)
    await handleSessionIdle(h.ctx, sid)
    expect(verifierSubturns()).toBe(atCap)
  })

  // A capped story WAS audited — saying it was "never verified" would be
  // false. The escalation names it as disputed instead.
  it("M3: the settled-plan escalation calls a capped story disputed, not unverified", async () => {
    const h = harness({ verifierEnabled: true, maxStoryReaudits: 1 })
    const sid = "s1"
    const state = quietSession(h, sid)
    state.modelId = "anthropic/claude-opus-4"
    state.workspaceRoot = h.stateDir
    claimedStory(h, sid)
    stubVerifier(h, {
      stories: [{ storyId: "S1", pass: false, summary: "still not done", items: [{ itemId: "A1", met: false, note: "no sources cited" }] }],
    })
    await handleSessionIdle(h.ctx, sid)
    h.storyEngine.checkpoint(sid, "S1.T1", "complete")
    await handleSessionIdle(h.ctx, sid) // cap reached, stamped
    await handleSessionIdle(h.ctx, sid) // settled -> escalation

    const said = continuations(h.prompt)
      .map((c) => c.text)
      .join("\n")
    expect(said).toContain("DISPUTED")
    expect(said).not.toContain("independently verified")
  })
})

// ===========================================================================
// FR-012 — continuation delivery classification and the in-flight guard.
//
// MAJ-009 (code review): this requirement shipped with zero tests, and its
// implementation produced CRIT-002 (a session that could be wedged forever).
// These pin both halves.
// ===========================================================================
// ===========================================================================
// Continuation authority (2026-08-04).
//
// A continuation is dispatched through `session.prompt`, so it already arrives
// as a user-role message. The `[vertex:...]` marker was the only thing telling
// the model the harness wrote it — and a message read as automated nagging is
// a message the model can discount. It is stripped from what the model sees
// and recorded as the family in the event log, which is how an operator still
// distinguishes harness steering from their own words.
// ===========================================================================
// ===========================================================================
// The pause judge (replaces the phrase detector, 2026-08-04).
//
// A turn ending with nothing done is NOT judged at idle any more. `session.idle`
// fires the instant a turn ends, which is not evidence — a human reading the
// reply looks exactly like a stall. The gate arms a timer instead; only real
// silence earns the model call, and only an explicit "stopped-mid-work"
// verdict earns a nudge.
//
// The detector this replaced was wrong in both directions in two live
// sessions: silent on "Let me lay out the plan and execute", and nudging
// "Green-light this and I'll create the plan and start" — a model correctly
// waiting for the approval the agent contract requires.
// ===========================================================================
// ===========================================================================
// A verdict must not outlive the code it judged (live session, 2026-08-06).
//
// The verifier failed two stories at 06:43:46 naming specific defects. The
// model fixed both at 06:44:46. The harness then re-litigated the dead verdict
// until the session was abandoned — both of its claims were false by then, and
// the worker was right. The only freshness test compared `verifiedAt` against
// `completedAt`, which never moves when an ALREADY-COMPLETE story is edited,
// and editing a complete story is exactly what the harness's own nudges ask
// for.
// ===========================================================================
describe("handleVerifierAudit — a verdict retires when the code moves", () => {
  it("re-audits a story whose files changed after the verdict", async () => {
    const h = harness({ verifierEnabled: true })
    const sid = "s1"
    const state = quietSession(h, sid)
    state.modelId = "anthropic/claude-opus-4"
    state.workspaceRoot = h.stateDir
    claimedStory(h, sid)

    const audits = (): number =>
      h.logger.mock.calls.filter((c) => c[0] === "story:verifier-audit").length

    stubVerifier(h, {
      stories: [{ storyId: "S1", pass: false, summary: "nope", items: [{ itemId: "A1", met: false, note: "missing" }] }],
    })
    await handleSessionIdle(h.ctx, sid)
    const first = audits()
    expect(first, "the first audit must run").toBeGreaterThan(0)

    // The model goes and fixes it — an edit to an ALREADY-COMPLETE story, so
    // `completedAt` does not move and the old freshness test saw nothing.
    h.storyEngine.checkpoint(sid, "S1.T1", "complete")
    h.evidenceLedger.recordChangedFiles(sid, "src/fixed.ts")
    state.idleContinuationInFlight = false
    await handleSessionIdle(h.ctx, sid)

    expect(audits(), "the edit must earn a fresh audit, not a repeat of the old verdict").toBeGreaterThan(first)
  })

  it("does not escalate a verdict the edits have already retired", async () => {
    const h = harness({ verifierEnabled: true })
    const sid = "s1"
    const state = quietSession(h, sid)
    state.modelId = "anthropic/claude-opus-4"
    state.workspaceRoot = h.stateDir
    claimedStory(h, sid)
    stubVerifier(h, { stories: [{ storyId: "S1", pass: false, summary: "nope", items: [] }] })
    await handleSessionIdle(h.ctx, sid)

    h.evidenceLedger.recordChangedFiles(sid, "src/fixed.ts")
    state.idleContinuationInFlight = false
    const escalationsBefore = h.logger.mock.calls.filter((c) => c[0] === "verifier:unaudited-escalation").length
    await handleSessionIdle(h.ctx, sid)

    // A re-audit MAY dispatch its own fresh verdict — that is the point. What
    // must not happen is ESCALATING the retired one, which is the standoff.
    expect(
      h.logger.mock.calls.filter((c) => c[0] === "verifier:unaudited-escalation").length,
      "announcing a dead verdict is the standoff this exists to end",
    ).toBe(escalationsBefore)
  })
})

// ===========================================================================
// The harness must not speak while the worker is still working.
// ===========================================================================
describe("dispatch is gated on a concluded turn", () => {
  // The marker has to move DURING the idle tree — between `beginIdleTurn` and
  // a branch deciding to speak — because that is the real race: the worker
  // resumes while the harness is still making up its mind. Driven here by
  // bumping it from inside the verifier subturn.
  it("suppresses a dispatch when the worker resumed after idle fired", async () => {
    const h = harness({ verifierEnabled: true })
    const sid = "s1"
    const state = quietSession(h, sid)
    state.modelId = "anthropic/claude-opus-4"
    state.workspaceRoot = h.stateDir
    claimedStory(h, sid)
    stubVerifier(h, {
      stories: [{ storyId: "S1", pass: false, summary: "nope", items: [{ itemId: "A1", met: false, note: "missing" }] }],
    })
    // The worker resumes while the AUDIT SUBTURN is in flight. Only the
    // subturn call bumps the marker; the stub's own behaviour is untouched, so
    // the verdict still arrives and the revert would otherwise be dispatched.
    // Bump from the logger, which definitely runs mid-tree: the audit logs
    // `story:verifier-audit` before the revert is dispatched. (Bumping from
    // the prompt stub does not work — `stubVerifier` does not route through
    // it, so the marker never moved and the test passed for the wrong reason.)
    const originalLogger = h.logger.getMockImplementation()
    h.logger.mockImplementation((event: string, payload?: unknown) => {
      if (event === "story:verifier-audit") state.activityMarker += 1
      return originalLogger?.(event, payload)
    })

    await handleSessionIdle(h.ctx, sid)

    // Sanity: the audit really ran, so the assertion below is about
    // suppression and not about the path never executing.
    expect(loggedEventTypes(h.logger), "the audit must have run").toContain("story:verifier-audit")

    // Observable outcome, not an internal event name: nothing was said.
    expect(
      continuations(h.prompt).filter((c) => c.text.includes("independently audited")),
      "the harness must not talk over a resumed turn",
    ).toHaveLength(0)
  })

  it("speaks at most once per idle", async () => {
    const h = harness({})
    const sid = "s1"
    const state = quietSession(h, sid)
    state.lastAssistantText = "I'll add the tests next."
    h.evidenceLedger.recordChangedFiles(sid, "src/app.ts")

    await handleSessionIdle(h.ctx, sid)
    expect(continuations(h.prompt).length).toBeLessThanOrEqual(1)
  })
})

describe("handleSessionIdle — pause judge", () => {
  // The timer map is module-level and keyed by session id, which these tests
  // reuse. Production ids are unique and a fired timer deletes its own entry,
  // but a test that arms and never advances would otherwise block the next.
  beforeEach(() => cancelPauseJudge("s1"))
  afterEach(() => {
    cancelPauseJudge("s1")
    vi.useRealTimers()
  })

  it("does NOT nudge at idle — it only arms a timer", async () => {
    const h = harness({ verifierEnabled: true })
    const sid = "s1"
    const state = quietSession(h, sid)
    state.lastAssistantText = "Let me lay out the plan and execute."

    await handleSessionIdle(h.ctx, sid)

    expect(continuations(h.prompt)).toHaveLength(0)
    expect(loggedEventTypes(h.logger)).toContain("pause:armed")
  })

  // The structural pre-filter is what keeps the model call rare; it must still
  // hold, because each of these cases belongs to another branch.
  it.each([
    ["changed files", (h: ReturnType<typeof harness>, sid: string) => h.evidenceLedger.recordChangedFiles(sid, "src/a.ts")],
    [
      "an existing plan",
      (h: ReturnType<typeof harness>, sid: string) =>
        void h.storyEngine.createPlan(sid, [
          { text: "Ship", acceptanceItems: ["A1"], scopeGlobs: [], verifiers: [], tasks: [{ text: "do" }] },
        ]),
    ],
  ])("does not arm on %s", async (_label, setup) => {
    const h = harness({ verifierEnabled: true })
    const sid = "s1"
    const state = quietSession(h, sid)
    state.lastAssistantText = "Let me lay out the plan and execute."
    setup(h, sid)

    await handleSessionIdle(h.ctx, sid)
    expect(loggedEventTypes(h.logger)).not.toContain("pause:armed")
  })

  it("arms only once, however many idles arrive", async () => {
    const h = harness({ verifierEnabled: true })
    const sid = "s1"
    const state = quietSession(h, sid)
    state.lastAssistantText = "Let me lay out the plan and execute."

    for (let i = 0; i < 5; i++) {
      state.idleContinuationInFlight = false
      await handleSessionIdle(h.ctx, sid)
    }
    expect(h.logger.mock.calls.filter((c) => c[0] === "pause:armed")).toHaveLength(1)
  })

  it("cancelPauseJudge stops a pending judgement", async () => {
    vi.useFakeTimers()
    const h = harness({ verifierEnabled: true })
    const sid = "s1"
    const state = quietSession(h, sid)
    state.lastAssistantText = "Let me lay out the plan and execute."

    await handleSessionIdle(h.ctx, sid)
    cancelPauseJudge(sid) // a message or tool call arrived
    await vi.advanceTimersByTimeAsync(PAUSE_JUDGE_DELAY_MS + 5_000)

    expect(loggedEventTypes(h.logger)).not.toContain("pause:verdict")
    expect(continuations(h.prompt)).toHaveLength(0)
  })

  it("does not judge when activity happened after arming", async () => {
    vi.useFakeTimers()
    const h = harness({ verifierEnabled: true })
    const sid = "s1"
    const state = quietSession(h, sid)
    state.lastAssistantText = "Let me lay out the plan and execute."

    await handleSessionIdle(h.ctx, sid)
    state.activityMarker += 1 // work landed without cancelling the timer
    await vi.advanceTimersByTimeAsync(PAUSE_JUDGE_DELAY_MS + 5_000)

    expect(loggedEventTypes(h.logger)).toContain("pause:cancelled")
    expect(continuations(h.prompt)).toHaveLength(0)
  })

  // MAJ-003: the judge drives the `vertex-verifier` agent, so the documented
  // way to switch the verifier off must switch this off too.
  it("does not arm when the verifier is disabled", async () => {
    const h = harness({ verifierEnabled: false })
    const sid = "s1"
    const state = quietSession(h, sid)
    state.lastAssistantText = "Let me lay out the plan and execute."

    await handleSessionIdle(h.ctx, sid)
    expect(loggedEventTypes(h.logger)).not.toContain("pause:armed")
  })

  // MAJ-005: every other dispatching branch honours the holdout. Without it
  // the "off" arm receives nudges and the A/B measurement is corrupted.
  it("does not arm for a holdout-off session", async () => {
    const previous = process.env.VERTEX_HOLDOUT
    process.env.VERTEX_HOLDOUT = "1"
    try {
      const h = harness({ verifierEnabled: true })
      // Find a session id that lands in the off arm for this holdout config.
      let sid: string | null = null
      for (let i = 0; i < 200 && sid === null; i++) {
        const candidate = `holdout-probe-${i}`
        if (holdoutSuppresses(candidate, "promise-no-act")) sid = candidate
      }
      expect(sid, "no off-arm session id found").not.toBeNull()
      const state = quietSession(h, sid!)
      state.lastAssistantText = "Let me lay out the plan and execute."

      await handleSessionIdle(h.ctx, sid!)
      expect(loggedEventTypes(h.logger)).not.toContain("pause:armed")
    } finally {
      if (previous === undefined) delete process.env.VERTEX_HOLDOUT
      else process.env.VERTEX_HOLDOUT = previous
    }
  })
})

describe("dispatched continuations carry no harness marker", () => {
  it("strips the marker from the text the model receives", async () => {
    const h = harness({ verifierEnabled: true })
    const sid = "s1"
    const state = quietSession(h, sid)
    state.modelId = "anthropic/claude-opus-4"
    state.workspaceRoot = h.stateDir
    claimedStory(h, sid)
    stubVerifier(h, {
      stories: [{ storyId: "S1", pass: false, summary: "not done", items: [{ itemId: "A1", met: false, note: "no sources cited" }] }],
    })

    await handleSessionIdle(h.ctx, sid)

    const texts = continuations(h.prompt).map((c) => c.text)
    expect(texts.length).toBeGreaterThan(0)
    for (const text of texts) {
      expect(text, "no continuation may advertise the harness as its author").not.toMatch(/\[vertex:/)
    }
    // ...but the content still arrives.
    expect(texts.join("\n")).toMatch(/verifier/i)
  })

  it("records the family and the text so the operator can still audit it", async () => {
    const h = harness({ verifierEnabled: true })
    const sid = "s1"
    const state = quietSession(h, sid)
    state.modelId = "anthropic/claude-opus-4"
    state.workspaceRoot = h.stateDir
    claimedStory(h, sid)
    stubVerifier(h, {
      stories: [{ storyId: "S1", pass: false, summary: "not done", items: [{ itemId: "A1", met: false, note: "no sources cited" }] }],
    })

    await handleSessionIdle(h.ctx, sid)

    expect(h.logger).toHaveBeenCalledWith(
      "gate:continuation-dispatched",
      expect.objectContaining({ sessionID: sid, family: "verifier" }),
    )
  })
})

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

describe("verifier re-audit counter — MIN-004", () => {
  it("a PASSING verdict clears that story's consecutive-revert streak", async () => {
    const h = harness({ verifierEnabled: true, maxStoryReaudits: 2 })
    const sid = "s1"
    const state = quietSession(h, sid)
    state.modelId = "anthropic/claude-opus-4"
    state.workspaceRoot = h.stateDir
    claimedStory(h, sid)

    // Revert once.
    stubVerifier(h, {
      stories: [{ storyId: "S1", pass: false, summary: "not done", items: [{ itemId: "A1", met: false, note: "no sources cited" }] }],
    })
    await handleSessionIdle(h.ctx, sid)
    expect(state.storyReaudits.S1).toBe(1)

    // Now it passes: the streak must reset, not accumulate.
    h.storyEngine.checkpoint(sid, "S1.T1", "complete")
    stubVerifier(h, { stories: [{ storyId: "S1", pass: true, summary: "delivered", items: [{ itemId: "A1", met: true, note: "verified" }] }] })
    await handleSessionIdle(h.ctx, sid)

    expect(state.storyReaudits.S1).toBeUndefined()
  })
})

// ===========================================================================
// FR-011 / FR-006 (MIN-002) — the plan digest the verifier is actually sent.
//
// Both requirements are properties of ONE string: the `plan` field of the
// payload dispatched to the `vertex-verifier` subturn. So these read it back off
// the prompt mock rather than re-rendering it — a re-render could agree with a
// broken caller (the whole MAJ-005 finding was that `renderPlanDigest` was
// correct in isolation but the call site never gave it the root).
//
// Grounding (`ses_04dc77bdaffej8SFJvYm5yO0CW`): with bare relative paths in the
// digest the verifier asserted "research/x.json does not exist" about files that
// DID exist, and the 4000-char cap truncated the tail of the plan, after which
// it FAILed stories citing "S5 has no independent verifier set in the digest"
// — the content the cap had removed.
// ===========================================================================

/** The `plan` field of the payload the verifier was actually prompted with. */
function verifierPlanDigest(h: ReturnType<typeof harness>): string {
  const session = h.ctx.client.session as unknown as Record<string, unknown>
  const prompt = session.prompt as ReturnType<typeof vi.fn>
  const call = prompt.mock.calls.find((c) => (c[0] as { body?: { agent?: string } })?.body?.agent === "vertex-verifier")
  expect(call, "the verifier subturn was never prompted").toBeDefined()
  const text = (call![0] as { body: { parts: Array<{ text: string }> } }).body.parts[0].text
  return (JSON.parse(text) as { plan?: string }).plan ?? ""
}

describe("renderPlanDigest — FR-011 absolute worktree root", () => {
  it("states the absolute worktree root as the digest's first line", async () => {
    const h = harness({ verifierEnabled: true })
    const sid = "s1"
    const state = quietSession(h, sid)
    state.modelId = "anthropic/claude-opus-4"
    state.workspaceRoot = h.stateDir
    claimedStory(h, sid, ["test -f research/x.md"])
    stubVerifier(h, {
      stories: [{ storyId: "S1", pass: true, summary: "delivered", items: [{ itemId: "A1", met: true, note: "read it" }] }],
    })

    await handleSessionIdle(h.ctx, sid)

    const digest = verifierPlanDigest(h)
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
    const h = harness({ verifierEnabled: true })
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

    stubVerifier(h, {
      stories: [{ storyId: "S3", pass: true, summary: "delivered", items: [{ itemId: "A1", met: true, note: "read it" }] }],
    })

    await handleSessionIdle(h.ctx, sid)

    const digest = verifierPlanDigest(h)
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
