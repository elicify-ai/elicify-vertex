/**
 * elicify-vertex — integration tests: FR-035 family holdout + FR-022 reversible archival
 * --------------------------------------------------------------------------
 * TDD Plan tests 31 (`family_holdout_suppression`) and 53 (`archival_is_reversible`,
 * integration variant), driven through the REAL WIRED v2 plugin (`ElicifyVertexPluginV2`)
 * rather than by calling `src/measurement.ts` or `src/v2/story.ts` internals directly.
 *
 * BDD scenarios covered (docs/vertex2-spec.md):
 *   - "Directive-family holdout suppresses rendering" (Feature: Measurement, US-10)
 *   - "Archival is reversible and never destructive" (Feature: Rollout and rollback, US-11)
 *
 * Test-42/13-style unit coverage for these already exists (`tests/v2/measurement.test.ts`
 * FR-035 describe block; `tests/v2/story.test.ts`'s `story_v1_archival` describe block) —
 * this file intentionally does NOT re-test the pure hash function or `StoryEngine` in
 * isolation. It proves the same properties survive real hook wiring: a real
 * `experimental.chat.system.transform` render pass for test 31, and a real
 * `elicify_vertex_plan_create` tool call (`hooks.tool`) for test 53.
 *
 * Per the wave-4 brief for Part A: this file does NOT modify anything under `src/`. Any
 * behavior that looks like a real bug is written up as a test marked `KNOWN BUG` with an
 * explanation, never silently fixed here.
 *
 * ---------------------------------------------------------------------------
 * Harness pattern REPLICATED (copied, not imported) from
 * `tests/v2/plugin.integration.test.ts` — see that file's own header comment
 * for the rationale (SDK `{data,error}` fields-style stub shape).
 * ---------------------------------------------------------------------------
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import type { Hooks, PluginInput, ToolContext } from "@opencode-ai/plugin"
import type { Agent } from "@opencode-ai/sdk"

import { ElicifyVertexPlugin } from "../../src/index.js"
import { eventsPath, holdoutArm } from "../../src/measurement.js"
import { ElicifyVertexPluginV2 } from "../../src/v2/plugin.js"

// ---------------------------------------------------------------------------
// Shared stub client — copied from tests/v2/plugin.integration.test.ts.
// ---------------------------------------------------------------------------

function denyAllAgent(name: string): Agent {
  return {
    name,
    mode: "subagent",
    builtIn: false,
    permission: { edit: "deny", bash: { "*": "deny" }, webfetch: "deny" },
    tools: { bash: false, edit: false, write: false, webfetch: false, read: false, "*": false },
    options: {},
  } as Agent
}

interface StubClient {
  app: { agents: ReturnType<typeof vi.fn> }
  tool: { ids: ReturnType<typeof vi.fn> }
  session: {
    create: ReturnType<typeof vi.fn>
    prompt: ReturnType<typeof vi.fn>
    delete: ReturnType<typeof vi.fn>
    messages: ReturnType<typeof vi.fn>
  }
  created: Array<{ id: string; parentID: string | null }>
}

function makeStubClient(opts: { promptText?: (agent: string | undefined) => string } = {}): StubClient {
  const created: Array<{ id: string; parentID: string | null }> = []
  let counter = 0

  const sessionCreate = vi.fn(async (args: { body?: { parentID?: string | null } }) => {
    const parentID = args?.body?.parentID ?? null
    counter += 1
    const id = `subturn-child-${counter}`
    created.push({ id, parentID })
    return { data: { id }, error: undefined }
  })
  const sessionPrompt = vi.fn(async (args: { body?: { agent?: string } }) => {
    const text = opts.promptText ? opts.promptText(args?.body?.agent) : '{"multiStory":false}'
    return { data: { info: {}, parts: [{ type: "text", text }] }, error: undefined }
  })
  const sessionDelete = vi.fn(async () => ({ data: {}, error: undefined }))
  const sessionMessages = vi.fn(async () => ({ data: [], error: undefined }))
  const appAgents = vi.fn(async () => ({
    data: [denyAllAgent("vertex-judge"), denyAllAgent("vertex-intake")],
    error: undefined,
  }))
  const toolIds = vi.fn(async () => ({ data: ["bash", "edit", "write", "webfetch", "read"], error: undefined }))

  return {
    app: { agents: appAgents },
    tool: { ids: toolIds },
    session: { create: sessionCreate, prompt: sessionPrompt, delete: sessionDelete, messages: sessionMessages },
    created,
  }
}

let workDir: string

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "vertex-v2-rollback-test-"))
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
  delete process.env.VERTEX_V2
  delete process.env.VERTEX_JUDGE
})

function pluginInput(client: unknown): PluginInput {
  return { client, directory: workDir, worktree: workDir } as unknown as PluginInput
}

async function activate(hooks: Hooks, sessionID: string, text: string, model?: { providerID: string; id: string }) {
  await hooks["chat.message"]!(
    { sessionID, agent: "elicify-vertex-agent", model: model ? { providerID: model.providerID, modelID: model.id } : undefined } as never,
    { message: {} as never, parts: [{ type: "text", text } as never] },
  )
}

/**
 * DEVIATION from the copied pattern's own `transform()` helper: the source
 * file hardcodes `anthropic/claude-fable-5`, which `src/v2/dosing.ts`'s
 * `BUILTIN_PROFILE_TABLE` maps to the "frontier" profile — under frontier,
 * `wiring/dosing.ts`'s `applyDosing` rewrites the elevate finding's O-D-P
 * text to a short rubric-and-taste form ("Deep task's bound verifier
 * passed."), which is an orthogonal FR-029 concern this file is not testing.
 * Using `minimax/MiniMax-M3` (the OTHER model in that same built-in table,
 * explicitly mapped to "standard") keeps the elevate finding in its full
 * FR-035-relevant form so the holdout assertion below is not confounded by
 * dosing. Documented here rather than silently diverging from the source
 * pattern.
 */
async function transform(hooks: Hooks, sessionID: string): Promise<{ system: string[] }> {
  const out = { system: [] as string[] }
  await hooks["experimental.chat.system.transform"]!(
    { sessionID, model: { providerID: "minimax", id: "MiniMax-M3" } as never },
    out,
  )
  return out
}

async function toolAfter(
  hooks: Hooks,
  sessionID: string,
  tool: string,
  args: Record<string, unknown>,
  output: string,
  metadata: Record<string, unknown> = {},
) {
  await hooks["tool.execute.after"]!(
    { tool, sessionID, callID: `${tool}-${Math.random()}`, args } as never,
    { title: tool, output, metadata } as never,
  )
}

async function completeText(hooks: Hooks, sessionID: string, text: string) {
  await hooks["experimental.text.complete"]!(
    { sessionID, messageID: `msg-${sessionID}`, partID: `part-${sessionID}` } as never,
    { text },
  )
}

// ===========================================================================
// Test 31: family_holdout_suppression (FR-035, BDD "Directive-family holdout
// suppresses rendering")
//
// src/v2/plugin.ts's system.transform handler filters EVERY candidate
// Finding through `holdoutSuppresses(sid, f.family)` before composing (see
// plugin.ts lines ~528-538), so the "elevate" family finding built by
// wiring/findings.ts's elevateFinding() is exactly the generic mechanism
// FR-035 requires, not a special case — this test exercises it end to end.
// ===========================================================================

describe("test 31: family_holdout_suppression", () => {
  // Deterministic brute-force search (holdoutArm's hash is
  // SHA-256("holdout|" + sessionId + "|" + family)-based per src/measurement.ts) for a
  // session id that lands in the 'off' arm specifically for family "elevate" —
  // same technique tests/v2/measurement.test.ts's FR-035 describe block already
  // uses for a *divergent* arm; here we search for the *specific* arm the BDD
  // scenario names ("off").
  let offArmSessionID: string

  beforeAll(() => {
    for (let i = 0; i < 20000; i++) {
      const candidate = `vertex-elevate-holdout-sess-${i}`
      if (holdoutArm(candidate, "elevate") === "off") {
        offArmSessionID = candidate
        return
      }
    }
    throw new Error("could not find a session id in the 'off' holdout arm for family 'elevate' within 20000 tries")
  })

  let savedHoldoutEnv: string | undefined
  let savedDataEnv: string | undefined
  let dataRoot: string

  beforeEach(() => {
    savedHoldoutEnv = process.env.VERTEX_HOLDOUT
    savedDataEnv = process.env.VERTEX_DATA
    dataRoot = mkdtempSync(join(tmpdir(), "vertex-v2-events-"))
    process.env.VERTEX_DATA = dataRoot
  })

  afterEach(() => {
    if (savedHoldoutEnv === undefined) delete process.env.VERTEX_HOLDOUT
    else process.env.VERTEX_HOLDOUT = savedHoldoutEnv
    if (savedDataEnv === undefined) delete process.env.VERTEX_DATA
    else process.env.VERTEX_DATA = savedDataEnv
    rmSync(dataRoot, { recursive: true, force: true })
  })

  /** Deep session, pinned criteria, passing bound verifier -> elevate finding candidate. */
  async function driveToElevateCandidate(hooks: Hooks, sid: string) {
    // DEEP_RE ("migration", "database") -> deep mode, matching test 41's own ask text.
    await activate(hooks, sid, "implement the production database migration")
    await toolAfter(hooks, sid, "edit", { filePath: "src/deep.ts" }, "updated")
    await completeText(hooks, sid, "CRITERIA:\n1. migration runs cleanly\n2. rollback path is documented")
    // Drains the pre-commitment finding queued by the intake->execute
    // transition and resets state.precommitmentPending (FR-023a: offered at
    // most once per phase entry) so it cannot leak into the assertion below.
    await transform(hooks, sid)
    // exit 0 + a recognized verifier command -> phase execute -> elevate
    // (phaseEngine.onVerifierOutcome, plugin.ts ~line 379-381), setting
    // state.elevatePending = true for the NEXT system.transform render.
    await toolAfter(hooks, sid, "bash", { command: "npx vitest run" }, "12 passed", { exit: 0 })
  }

  it("VERTEX_HOLDOUT=1 + an off-arm session suppresses the elevate finding entirely (nothing injected)", async () => {
    process.env.VERTEX_HOLDOUT = "1"
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)

    await driveToElevateCandidate(hooks, offArmSessionID)

    const rendered = await transform(hooks, offArmSessionID)
    const renderedText = rendered.system.join("\n")
    // The elevate finding's full-form observation text (wiring/findings.ts's
    // elevateFinding()) must not appear anywhere in what was injected.
    expect(renderedText).not.toContain("bound verifier passed on a deep task")
    expect(renderedText).not.toContain("finish well")
  })

  it("logs holdout_suppress with family: 'elevate' when the elevate finding is suppressed", async () => {
    process.env.VERTEX_HOLDOUT = "1"
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)

    await driveToElevateCandidate(hooks, offArmSessionID)
    await transform(hooks, offArmSessionID)

    expect(existsSync(eventsPath())).toBe(true)
    const lines = readFileSync(eventsPath(), "utf8").trim().split("\n").filter(Boolean)
    const events = lines.map(
      (l) => JSON.parse(l) as { event_type: string; session_id: string; payload: Record<string, unknown> },
    )
    const suppress = events.find((e) => e.event_type === "holdout_suppress" && e.payload.family === "elevate")
    expect(suppress).toBeDefined()
    expect(suppress?.session_id).toBe(offArmSessionID)
    expect(suppress?.payload.reason).toContain("elevate")
  })

  // Positive control (ruling out competing explanations, per the debugging
  // investigation protocol): the SAME off-arm session id, same flow, but
  // VERTEX_HOLDOUT left unset (default OFF per measurement.ts's module
  // header — "defaults OFF, so the default gate behaviour is identical to
  // before this layer existed"). This proves the absence above is actually
  // caused by holdout suppression and not by some unrelated reason the
  // elevate finding might fail to fire (e.g. a wiring mistake that would
  // make BOTH tests pass vacuously).
  it("control: same off-arm session id with VERTEX_HOLDOUT unset renders the elevate finding normally", async () => {
    delete process.env.VERTEX_HOLDOUT
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)

    await driveToElevateCandidate(hooks, offArmSessionID)

    const rendered = await transform(hooks, offArmSessionID)
    const renderedText = rendered.system.join("\n")
    expect(renderedText).toContain("bound verifier passed on a deep task")

    if (existsSync(eventsPath())) {
      const lines = readFileSync(eventsPath(), "utf8").trim().split("\n").filter(Boolean)
      const events = lines.map((l) => JSON.parse(l) as { event_type: string; payload: Record<string, unknown> })
      expect(
        events.find((e) => e.event_type === "holdout_suppress" && e.payload.family === "elevate"),
      ).toBeUndefined()
    }
  })
})

// ===========================================================================
// Test 53: archival_is_reversible (integration variant, FR-022, BDD
// "Archival is reversible and never destructive")
//
// Unlike tests/v2/story.test.ts's `story_v1_archival` describe block (which
// calls `StoryEngine.archiveV1IfPresent()` directly), this drives the SAME
// behavior through the real wired plugin: a genuine `elicify_vertex_plan_create`
// tool call via `hooks.tool` — exactly the call path a model would take,
// per src/v2/wiring/tools.ts's `createTool.execute` -> `storyEngine.createPlan()`
// -> `archiveV1IfPresent()`.
// ===========================================================================

describe("test 53: archival_is_reversible (integration)", () => {
  function makeToolContext(sessionID: string): ToolContext {
    return {
      sessionID,
      messageID: "m1",
      agent: "elicify-vertex-agent",
      directory: workDir,
      worktree: workDir,
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {},
    }
  }

  it("a real elicify_vertex_plan_create call archives a v1 goals.json byte-identically (rename, not copy), and the session continues without further touching archive/", async () => {
    const stateDir = join(workDir, ".elicify-vertex")
    mkdirSync(stateDir, { recursive: true })
    const goalsPath = join(stateDir, "goals.json")

    const nowIso = new Date().toISOString()
    const v1Plan = {
      schemaVersion: 1,
      revision: 1,
      brief: "test-53-known-content: migrate the legacy auth store",
      status: "active",
      activeStoryId: "G001",
      createdAt: nowIso,
      updatedAt: nowIso,
      stories: [
        {
          id: "G001",
          ordinal: 1,
          kind: "work",
          title: "Story One",
          objective: "Do the work",
          status: "in_progress",
          evidence: null,
          startedAt: nowIso,
          completedAt: null,
          verification: null,
        },
        {
          id: "G002",
          ordinal: 2,
          kind: "verification",
          title: "Final verification",
          objective: "Verify everything",
          status: "pending",
          evidence: null,
          startedAt: null,
          completedAt: null,
          verification: null,
        },
      ],
    }
    const originalContents = JSON.stringify(v1Plan, null, 2)
    writeFileSync(goalsPath, originalContents, "utf8")

    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "archival-integration-session"
    const toolCtx = makeToolContext(sid)

    // Drive the REAL plan-create tool, not StoryEngine directly.
    const createResult = await hooks.tool!.elicify_vertex_plan_create!.execute(
      { stories: [{ text: "New v2 story", acceptanceItems: ["it works"], scopeGlobs: [], verifiers: [] }] },
      toolCtx,
    )
    const createText = typeof createResult === "string" ? createResult : createResult.output
    expect(JSON.parse(createText).schemaVersion).toBe(2)

    // v1's file is GONE — archival is a rename, never a copy.
    expect(existsSync(goalsPath)).toBe(false)

    const archiveDir = join(stateDir, "archive")
    expect(existsSync(archiveDir)).toBe(true)
    const archiveEntriesAfterCreate = readdirSync(archiveDir).filter((f) => /^goals\..*\.json$/.test(f))
    expect(archiveEntriesAfterCreate.length).toBe(1)
    const archivedPath = join(archiveDir, archiveEntriesAfterCreate[0])
    expect(readFileSync(archivedPath, "utf8")).toBe(originalContents) // byte-identical

    // "the session then runs to completion": drive a further, ordinary turn
    // (which also triggers storyEngine.checkScope -> archiveV1IfPresent()
    // again, since every mutating story-tool method calls it at its top).
    // The archive must remain untouched: no new entry, no truncation.
    await activate(hooks, sid, "continue the auth migration story")
    await toolAfter(hooks, sid, "edit", { filePath: "src/after-archive.ts" }, "updated")

    const archiveEntriesAfterTurn = readdirSync(archiveDir).filter((f) => /^goals\..*\.json$/.test(f))
    expect(archiveEntriesAfterTurn.length).toBe(1)
    expect(archiveEntriesAfterTurn[0]).toBe(archiveEntriesAfterCreate[0]) // same file, not replaced
    expect(readFileSync(archivedPath, "utf8")).toBe(originalContents) // still byte-identical, never truncated

    // Restore: rename the archived file back to goals.json (the operator
    // action FR-022/FR-037's rollback path documents).
    renameSync(archivedPath, goalsPath)
    expect(existsSync(goalsPath)).toBe(true)
    expect(readFileSync(goalsPath, "utf8")).toBe(originalContents)

    // v1 compatibility: under VERTEX_V2=0, a FRESH import of ElicifyVertexPlugin
    // (v1) reads the restored file through the real v1 tool
    // (elicify_vertex_goal_status) and must load it successfully — proving
    // the restored file is not just byte-identical but still structurally
    // valid against v1's own strict validatePlan().
    process.env.VERTEX_V2 = "0"
    const v1Client = { session: { prompt: vi.fn(async () => ({})) } }
    const v1Hooks = await ElicifyVertexPlugin(
      { client: v1Client, directory: workDir, worktree: workDir } as unknown as PluginInput,
      undefined,
    )
    const v1Status = await v1Hooks.tool!.elicify_vertex_goal_status!.execute({}, toolCtx)
    const v1StatusText = typeof v1Status === "string" ? v1Status : v1Status.output
    const parsed = JSON.parse(v1StatusText)
    expect(parsed).not.toBeNull()
    expect(parsed.schemaVersion).toBe(1)
    expect(parsed.brief).toBe(v1Plan.brief)
    expect(parsed.stories).toHaveLength(2)
  })

  it("does not archive a v2 (schemaVersion 2+) goals.json — not ours to touch", async () => {
    const stateDir = join(workDir, ".elicify-vertex")
    mkdirSync(stateDir, { recursive: true })
    const goalsPath = join(stateDir, "goals.json")
    const v2ish = JSON.stringify({ schemaVersion: 2, note: "not a v1 file" })
    writeFileSync(goalsPath, v2ish, "utf8")

    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "archival-v2-noop-session"
    const toolCtx = makeToolContext(sid)

    await hooks.tool!.elicify_vertex_plan_create!.execute(
      { stories: [{ text: "Another story", acceptanceItems: ["done"], scopeGlobs: [], verifiers: [] }] },
      toolCtx,
    )

    // goals.json (schemaVersion 2) is untouched; no archive/ directory was created for it.
    expect(existsSync(goalsPath)).toBe(true)
    expect(readFileSync(goalsPath, "utf8")).toBe(v2ish)
    const archiveDir = join(stateDir, "archive")
    if (existsSync(archiveDir)) {
      expect(readdirSync(archiveDir).filter((f) => /^goals\..*\.json$/.test(f))).toHaveLength(0)
    }
  })
})
