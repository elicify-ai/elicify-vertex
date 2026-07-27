import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { EvidenceLedger } from "../../src/index.js"
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

function harness(opts: { maxCriteriaBlocks?: number } = {}) {
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
    judgeEnabled: false,
    isValidReceipt: () => false,
    recentVerifierSummaries: () => [],
    diffSummary: () => "",
    composer,
  }
  return { ctx, composer, evidenceLedger, logger, prompt, selfCreated, states, stateDir }
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
