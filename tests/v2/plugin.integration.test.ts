import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import type { Agent } from "@opencode-ai/sdk"

// C-3 (docs/CODE-ISSUES-FROM-PROMPT-AUDIT.md): the workspace-root fallback
// only fires when EVERY candidate `resolveGoalWorkspaceRoot` tries --
// including its own last-resort `process.cwd()`/`homedir()` fallbacks -- is
// unwritable, which cannot be forced for real in a sandboxed CI checkout
// without touching filesystem permissions outside this test's own temp dir.
// `forceThrow` lets one test flip the real function to throw exactly the way
// an unwritable root would, while every other test in this file (default
// `forceThrow: false`) still exercises the REAL `resolveGoalWorkspaceRoot`
// unchanged.
const workspaceRootMock = vi.hoisted(() => ({ forceThrow: false }))

vi.mock("../../src/goals.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/goals.js")>()
  return {
    ...actual,
    resolveGoalWorkspaceRoot: (candidates: readonly (string | undefined | null)[]) => {
      if (workspaceRootMock.forceThrow) {
        throw new Error(
          "elicify-vertex goals need a writable project directory (not filesystem root). " +
            `Tried: ${candidates.filter(Boolean).join(", ")}`,
        )
      }
      return actual.resolveGoalWorkspaceRoot(candidates)
    },
  }
})

import { eventsPath } from "../../src/measurement.js"
import { server } from "../../src/plugin.js"
import { ElicifyVertexPluginV2 } from "../../src/v2/plugin.js"

// ---------------------------------------------------------------------------
// Shared stub client — mirrors tests/v2/subturn.test.ts's shape (SDK
// `{data,error}` fields-style results) so the plugin's own `unwrap()` calls
// exercise the real default response shape, not just the convenience one.
// ---------------------------------------------------------------------------

function denyAllAgent(name: string): Agent {
  return {
    name,
    mode: "subagent",
    builtIn: false,
    // Deny the UNION of both probe policies so the same stub satisfies the
    // intake default policy (edit/bash/webfetch) AND the verifier's
    // VERIFIER_PROBE_POLICY (edit/write/webfetch/task) — see src/v2/subturn.ts.
    permission: { edit: "deny", write: "deny", bash: { "*": "deny" }, webfetch: "deny", task: "deny" },
    tools: { bash: false, edit: false, write: false, webfetch: false, read: false, task: false, "*": false },
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

function makeStubClient(
  opts: {
    promptText?: (agent: string | undefined) => string
    /** `gate.ts`'s `fetchVerifierTranscriptFields` override — mirrors
     * `tests/v2/integration-verifier.test.ts`'s identical escape hatch. Defaults
     * to the existing empty-history stub so every test that doesn't care
     * about transcript content is unaffected. */
    messagesImpl?: (args: { path?: { id?: string } }) => Promise<{ data?: unknown; error?: unknown }>
  } = {},
): StubClient {
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
  const sessionMessages = vi.fn(async (args: { path?: { id?: string } }) => {
    if (opts.messagesImpl) return opts.messagesImpl(args)
    return { data: [], error: undefined }
  })
  const appAgents = vi.fn(async () => ({
    data: [denyAllAgent("vertex-verifier"), denyAllAgent("vertex-intake")],
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
let dataDir: string
let savedVertexData: string | undefined

// Sign-off finding: this file's readEvents()-based assertions (C-3,
// subagent:injection-skipped) call eventsPath() with no override, so without
// this isolation they read/append to the real shared
// ~/.config/opencode/.vertex-events.jsonl — contaminated by whatever a prior
// run (in this shared devpod, or a previous test file) left there. Sibling
// files (integration-verifier.test.ts) already isolate via VERTEX_DATA; this one
// didn't, and this diff doubled its reliance on readEvents() (5 -> 10 call
// sites), doubling exposure to the gap.
beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "vertex-v2-plugin-test-"))
  dataDir = mkdtempSync(join(tmpdir(), "vertex-v2-plugin-data-"))
  savedVertexData = process.env.VERTEX_DATA
  process.env.VERTEX_DATA = dataDir
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
  rmSync(dataDir, { recursive: true, force: true })
  if (savedVertexData === undefined) delete process.env.VERTEX_DATA
  else process.env.VERTEX_DATA = savedVertexData
  delete process.env.VERTEX_V2
  delete process.env.VERTEX_VERIFIER
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

async function transform(hooks: Hooks, sessionID: string): Promise<{ system: string[] }> {
  return transformWith(hooks, sessionID, { providerID: "anthropic", id: "claude-fable-5" })
}

/** `transform` with an explicit model — BACKLOG B-1's regression tests need to
 * vary the model id, which used to select a dosing profile. */
async function transformWith(
  hooks: Hooks,
  sessionID: string,
  model: { providerID: string; id: string },
): Promise<{ system: string[] }> {
  const out = { system: [] as string[] }
  await hooks["experimental.chat.system.transform"]!({ sessionID, model: model as never }, out)
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

async function idle(hooks: Hooks, sessionID: string) {
  await hooks.event!({ event: { type: "session.idle", properties: { sessionID } } as never })
}

/** Continuation prompts issued directly by the idle gate never set `body.agent`
 * (subturn requests always do) — this filters a client's `session.prompt`
 * mock calls down to just the gate's own continuations for a given session. */
function idleContinuationTexts(client: StubClient, sessionID: string): string[] {
  return client.session.prompt.mock.calls
    .filter((call: unknown[]) => {
      const arg = call[0] as { path?: { id?: string }; body?: { agent?: string } }
      return arg?.path?.id === sessionID && arg?.body?.agent === undefined
    })
    .map((call: unknown[]) => {
      const arg = call[0] as { body?: { parts?: Array<{ text?: string }> } }
      return arg?.body?.parts?.[0]?.text ?? ""
    })
}

// ===========================================================================
// Test 43: self_created_session_is_inert (FR-036 / CRIT-001)
//
// Uses the REAL hook set (not a stub-only assertion) driven over a genuinely
// self-created child session id, obtained by letting the plugin's own intake
// classification subturn call session.create — the spec is explicit that a
// stub-only test cannot catch this class of bug.
// ===========================================================================

describe("test 43: self_created_session_is_inert", () => {
  it("the real hook set is inert for a harness-created child session", async () => {
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const parentSID = "parent-session"

    // Non-trivial ask -> classifyMultiStory issues a real subturn -> session.create is called.
    await activate(hooks, parentSID, "refactor the auth database migration end to end")
    expect(client.created.length).toBeGreaterThan(0)
    const childSID = client.created[0].id
    const promptCallsBefore = client.session.prompt.mock.calls.length

    // Drive every hook FR-036 names, for the CHILD session id.
    const chatOutput = { message: {} as never, parts: [{ type: "text", text: "hello" } as never] }
    await hooks["chat.message"]!({ sessionID: childSID, agent: "elicify-vertex-agent" } as never, chatOutput)
    expect(chatOutput.parts).toEqual([{ type: "text", text: "hello" }]) // byte-identical: no activation cue pushed

    const sysOutput = { system: ["existing-system-text"] }
    await hooks["experimental.chat.system.transform"]!(
      { sessionID: childSID, model: { providerID: "anthropic", id: "claude-fable-5" } as never },
      sysOutput,
    )
    expect(sysOutput.system).toEqual(["existing-system-text"]) // byte-identical: no directive block appended

    await toolAfter(hooks, childSID, "edit", { filePath: "src/child.ts" }, "updated")
    await toolAfter(hooks, childSID, "bash", { command: "npm test" }, "1 failed", { exit: 1 })
    await completeText(hooks, childSID, "CRITERIA:\n1. this should never be pinned")
    await idle(hooks, childSID)

    // No ledger/gate activity for the child: no additional session.prompt calls at all.
    expect(client.session.prompt.mock.calls.length).toBe(promptCallsBefore)
    expect(client.session.create).not.toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.objectContaining({ parentID: childSID }) }),
    )
  })
})

// ===========================================================================
// Smoke test: one full v2 turn end-to-end (not each module in isolation)
// ===========================================================================

describe("smoke: full v2 turn", () => {
  it("activate -> mutate -> criteria pinned -> idle block names the criterion -> verifier passes -> idle closes clean", async () => {
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "smoke-session"

    await activate(hooks, sid, "refactor the auth database migration end to end")

    await toolAfter(hooks, sid, "edit", { filePath: "src/foo.ts" }, "updated")

    await completeText(hooks, sid, "CRITERIA:\n1. parser handles nesting\n2. errors point at inner token")

    const afterCriteria = await transform(hooks, sid)
    // intake scaffold must not still be demanded once criteria are captured.
    expect(afterCriteria.system.join("\n")).not.toContain("OUTCOME:")

    await idle(hooks, sid)
    const blockTexts = idleContinuationTexts(client, sid)
    expect(blockTexts.length).toBe(1)
    expect(blockTexts[0]).toContain("parser handles nesting")

    // Verifier passes -> transitions execute -> elevate, and attaches
    // evidence to the SINGLE oldest unevidenced criterion (C1): no module
    // in the codebase exposes a mechanism binding a specific verifier run
    // to a specific criterion, so a passing verifier counts toward exactly
    // one pinned criterion at a time, oldest-first (see src/v2/plugin.ts's
    // tool.execute.after, "FIX #2" comment). C2 is still unevidenced.
    await toolAfter(hooks, sid, "bash", { command: "npx vitest run" }, "20 passed", { exit: 0 })

    await idle(hooks, sid)
    const blockTextsAfterFirstGreen = idleContinuationTexts(client, sid)
    // C2 ("errors point at inner token") still lacks evidence -> idle
    // blocks again, this time naming C2 specifically.
    expect(blockTextsAfterFirstGreen.length).toBe(2)
    expect(blockTextsAfterFirstGreen[1]).toContain("errors point at inner token")

    // A second passing verification evidences C2 (now the oldest
    // unevidenced criterion) -> both criteria are evidenced.
    await toolAfter(hooks, sid, "bash", { command: "npx vitest run" }, "20 passed", { exit: 0 })

    await idle(hooks, sid)
    const blockTextsAfterSecondGreen = idleContinuationTexts(client, sid)
    expect(blockTextsAfterSecondGreen.length).toBe(2) // no NEW continuation beyond the two above
  })
})

// ===========================================================================
// Test 41: criteria_absent_falls_back_to_v1_gate (FR-015 zero-criteria
// fallback, CRIT-003 — the most safety-critical fallback in the spec)
// ===========================================================================

describe("test 41: criteria_absent_falls_back_to_v1_gate", () => {
  it("deep mode, changed files, no verification, zero pins -> blocks via v1 shouldBlockStop, names the gap", async () => {
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "zero-criteria-session"

    await activate(hooks, sid, "implement the production database migration")
    await toolAfter(hooks, sid, "edit", { filePath: "src/bar.ts" }, "updated")
    // No text.complete with a CRITERIA: block -> zero pins.

    await idle(hooks, sid)
    const blockTexts = idleContinuationTexts(client, sid)
    expect(blockTexts.length).toBe(1)
    expect(blockTexts[0]).toContain("No acceptance criteria were captured")
  })

  it("does not block once verification succeeds", async () => {
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "zero-criteria-verified"

    await activate(hooks, sid, "implement the production database migration")
    await toolAfter(hooks, sid, "edit", { filePath: "src/bar.ts" }, "updated")
    await toolAfter(hooks, sid, "bash", { command: "npx vitest run" }, "5 passed", { exit: 0 })

    await idle(hooks, sid)
    expect(idleContinuationTexts(client, sid).length).toBe(0)
  })
})

// ===========================================================================
// verification receipt surfaced to the model (v1 parity)
//
// v1's tool.execute.after (src/index.ts, ~L1670) appends
// "[vertex:verification-receipt] <id>" to the bash tool's own output text
// and stashes vertexVerificationReceiptId in metadata, so the model sees the
// id it must quote back in a checkpoint call. v2 minted the same receipt but
// never wrote it back to toolOutput — the model had no way to know a valid
// receiptId, so it fabricated one (rejected by isFreshReceipt) or fell back
// to a waiver. This asserts the fix: v2 now surfaces it the same way v1 does.
// ===========================================================================

describe("verification receipt surfaced to the model (v1 parity fix)", () => {
  it("appends [vertex:verification-receipt] <id> to the passing verifier's own tool output", async () => {
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "receipt-surface-session"

    await activate(hooks, sid, "refactor the auth database migration end to end")
    await toolAfter(hooks, sid, "edit", { filePath: "src/foo.ts" }, "updated")

    const toolOutput = { title: "bash", output: "20 passed", metadata: { exit: 0 } }
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: sid, callID: "bash-1", args: { command: "npx vitest run" } } as never,
      toolOutput as never,
    )

    expect(toolOutput.output).toMatch(/\[vertex:verification-receipt\] \S+/)
    expect(toolOutput.output.startsWith("20 passed")).toBe(true)
    expect(typeof (toolOutput.metadata as Record<string, unknown>).vertexVerificationReceiptId).toBe("string")
  })

  it("does not append a receipt line when the command fails (no receipt minted)", async () => {
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "receipt-surface-fail-session"

    await activate(hooks, sid, "refactor the auth database migration end to end")
    await toolAfter(hooks, sid, "edit", { filePath: "src/foo.ts" }, "updated")

    const toolOutput = { title: "bash", output: "1 failed", metadata: { exit: 1 } }
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: sid, callID: "bash-1", args: { command: "npx vitest run" } } as never,
      toolOutput as never,
    )

    expect(toolOutput.output).toBe("1 failed")
    expect((toolOutput.metadata as Record<string, unknown>).vertexVerificationReceiptId).toBeUndefined()
  })

  it("a passing verifier still mints a receipt, and a task-level completion claim completes the story with no citation (task-model equivalent of receipt round-trip)", async () => {
    // REWRITTEN for the 2026-07-30 task/DAG redesign. The original test asserted
    // that a receipt surfaced by tool.execute.after "round-trips as a valid
    // checkpoint receiptId" — i.e. the OLD elicify_vertex_plan_checkpoint
    // validated per-item receipt/waiver citations (FR-020) and accepted that
    // id. That citation apparatus is GONE: a checkpoint is now a bare CLAIM on
    // a TASK id, and the completion verifier (at idle) is the sole arbiter of
    // whether the claim holds. The receipt is still minted by
    // tool.execute.after's unchanged verification-recognition path, so the
    // coverage preserved here is its task-model equivalent: the verifier
    // still surfaces a receipt, AND a task-level claim completes the story
    // WITHOUT quoting any receipt/waiver (the verifier audits it later).
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "receipt-checkpoint-session"

    await activate(hooks, sid, "refactor the auth database migration end to end")
    await toolAfter(hooks, sid, "edit", { filePath: "src/foo.ts" }, "updated")

    const plan = await hooks.tool!.elicify_vertex_plan_create!.execute!(
      { stories: [{ text: "do it", acceptanceItems: ["A1"], scopeGlobs: [], verifiers: [], tasks: [{ text: "do the work" }] }] } as never,
      { sessionID: sid } as never,
    )
    const taskId = (JSON.parse(plan as string) as { stories: Array<{ tasks: Array<{ id: string }> }> }).stories[0].tasks[0].id

    const toolOutput = { title: "bash", output: "20 passed", metadata: { exit: 0 } }
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: sid, callID: "bash-1", args: { command: "npx vitest run" } } as never,
      toolOutput as never,
    )
    // The receipt is still minted and surfaced (verification-recognition path unchanged).
    const match = toolOutput.output.match(/\[vertex:verification-receipt\] (\S+)/)
    expect(match).not.toBeNull()

    // A task-level completion claim completes the story with NO receipt/waiver
    // citation — the redesign removed that contract entirely.
    const checkpointResult = await hooks.tool!.elicify_vertex_plan_checkpoint!.execute!(
      { taskId, status: "complete" } as never,
      { sessionID: sid } as never,
    )
    const checkpointed = JSON.parse(checkpointResult as string)
    expect(checkpointed.stories[0].status).toBe("complete")
  })
})

// ===========================================================================
// promise-no-act port: stale pre-tool-call text must not survive into
// session.idle (v1 parity — src/index.ts clears lastAssistantText the same
// way on every tool.execute.after while its gate is active)
// ===========================================================================

describe("promise-no-act port: stale text cleared by the next tool call", () => {
  function promiseTexts(client: StubClient): string[] {
    return client.session.prompt.mock.calls
      .map((call: unknown[]) => (call[0] as { body?: { parts?: Array<{ text?: string }> } })?.body?.parts?.[0]?.text ?? "")
      // The `[vertex:...]` marker is stripped at dispatch so the model reads
      // a continuation as an instruction, not as harness output — match the
      // directive's own wording. The family stays in the event log.
      .filter((text: string) => text.includes("states an intent to do further work"))
  }

  it("does not block on a deferral phrase that predates the latest tool call", async () => {
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "stale-promise-session"

    await activate(hooks, sid, "refactor the auth database migration end to end")
    // This text alone WOULD trigger promise-no-act (see the gate.test.ts unit
    // test) — but a tool call happens afterward, which must clear it.
    await completeText(hooks, sid, "TODO: handle the edge case next.")
    await toolAfter(hooks, sid, "edit", { filePath: "src/foo.ts" }, "updated")

    await idle(hooks, sid)

    expect(promiseTexts(client)).toHaveLength(0)
  })

  it("still blocks when the deferral text is the genuinely last thing produced (no tool call after it)", async () => {
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "fresh-promise-session"

    await activate(hooks, sid, "refactor the auth database migration end to end")
    await toolAfter(hooks, sid, "edit", { filePath: "src/foo.ts" }, "updated")
    await completeText(hooks, sid, "TODO: handle the edge case next.")

    await idle(hooks, sid)

    expect(promiseTexts(client)).toHaveLength(1)
  })
})

// ===========================================================================
// Test 52: kill_switch_restores_v1 (FR-037 / US-11)
// ===========================================================================

interface LoggedEvent {
  event_type: string
  session_id: string
  payload: Record<string, unknown>
  /** FR-033: stamped on every record. `profile` was its companion until
   * BACKLOG B-1 removed model-conditioned dosing; it is deliberately NOT
   * declared here, so a test that asserts on it would not compile. */
  model?: string
}

/** Read the measurement sink written by this test run. */
function readEvents(): LoggedEvent[] {
  const path = eventsPath()
  if (!existsSync(path)) return []
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LoggedEvent)
}

// ===========================================================================
// C-3 (docs/CODE-ISSUES-FROM-PROMPT-AUDIT.md) — v1's GoalStore constructor
// threw on an unwritable workspace root; v2's plugin init catches that same
// throw and falls back to process.cwd() SILENTLY. The fix keeps the
// fallback (crashing plugin init is worse) but makes it observable.
// ===========================================================================

describe("C-3: the workspace-root fallback is now observable", () => {
  afterEach(() => {
    workspaceRootMock.forceThrow = false
  })

  it("logs workspace:unwritable-fallback when resolveGoalWorkspaceRoot throws at plugin construction", async () => {
    workspaceRootMock.forceThrow = true
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    workspaceRootMock.forceThrow = false

    // Plugin init must still succeed -- the fallback is a deliberate,
    // lower-blast-radius choice, not a restored hard throw.
    expect(hooks["chat.message"]).toBeDefined()

    const events = readEvents().filter((e) => e.event_type === "workspace:unwritable-fallback")
    expect(events.length, "the fallback must be logged, not silently swallowed").toBeGreaterThan(0)
    const last = events[events.length - 1]
    expect(last.payload.fallback).toBe(process.cwd())
    expect(Array.isArray(last.payload.candidates)).toBe(true)
    expect(typeof last.payload.error).toBe("string")
  })

  it("does NOT log the fallback event on ordinary (writable-root) plugin construction", async () => {
    const client = makeStubClient()
    await ElicifyVertexPluginV2(pluginInput(client), undefined)

    // This only proves the event isn't logged on THIS construction; other
    // tests' events may already be on disk, so we can't assert global
    // absence -- just that a normal construction doesn't add one for our
    // fresh, writable `workDir`.
    const beforeCount = readEvents().filter((e) => e.event_type === "workspace:unwritable-fallback").length
    const client2 = makeStubClient()
    await ElicifyVertexPluginV2(pluginInput(client2), undefined)
    const afterCount = readEvents().filter((e) => e.event_type === "workspace:unwritable-fallback").length
    expect(afterCount).toBe(beforeCount)
  })
})

describe("greenfield: there is no v1 engine to fall back to", () => {
  // REPLACES "test 52: kill_switch_restores_v1". The kill switch was removed
  // deliberately, not by accident:
  //   - it registered a SECOND tool set (`elicify_vertex_goal_*` vs
  //     `elicify_vertex_plan_*`), so which tools the model saw depended on an
  //     env var and the agent prompt could not name its own tools;
  //   - it never meant "harness off" -- it swapped in an older harness that
  //     still minted receipts and still injected directives;
  //   - `VERTEX_V2=0` + `--agent elicify-vertex-agent` failed with
  //     `UnknownError` on every measured attempt.
  it("ignores VERTEX_V2=0 and runs v2 regardless", async () => {
    process.env.VERTEX_V2 = "0"
    const client = makeStubClient()
    const hooks = await server(pluginInput(client), undefined)

    const sid = "greenfield-env"
    await hooks["chat.message"]!(
      { sessionID: sid, agent: "elicify-vertex-agent" } as never,
      { message: {} as never, parts: [{ type: "text", text: "implement the production database migration" } as never] },
    )
    // v2 registers the plan tools; v1 registered goal tools and no plan tools.
    expect(Object.keys(hooks.tool ?? {})).toEqual(expect.arrayContaining(["elicify_vertex_plan_create"]))
    expect(Object.keys(hooks.tool ?? {}).filter((k) => k.includes("goal"))).toEqual([])
  })

  it("ignores the engine:'v1' plugin option too", async () => {
    const client = makeStubClient()
    const hooks = await server(pluginInput(client), { engine: "v1" } as never)
    expect(Object.keys(hooks.tool ?? {})).toEqual(expect.arrayContaining(["elicify_vertex_plan_create"]))
    expect(Object.keys(hooks.tool ?? {}).filter((k) => k.includes("goal"))).toEqual([])
  })
})
describe("turn boundaries: a turn is a prompt, not an agent-loop step", () => {
  it("does NOT advance the turn on tool results or text parts within one reply cycle", async () => {
    // REWRITTEN. The previous version asserted that zero
    // `composer:turn-advanced` events were logged -- an event type that does not
    // exist anywhere in src/, so the filter was unconditionally empty and the
    // test could not fail. Proof: adding `composer.newTurn(sid)` to every tool
    // result (literally the defect this block is named after) left it green.
    //
    // The observable consequence of a per-step turn advance is that per-turn
    // CAPS reset per step, so a capped family renders repeatedly within one
    // reply cycle instead of once. That is what is asserted now.
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "turn-per-step"

    await activate(hooks, sid, "implement the production database migration")
    await toolAfter(hooks, sid, "edit", { filePath: "src/f.ts" }, "updated")
    await transform(hooks, sid)

    const rendersAfterFirst = readEvents().filter(
      (e: LoggedEvent) => e.session_id === sid && e.event_type === "directive_rendered",
    ).length

    // A realistic agent loop: several tool results and text parts, no new prompt.
    for (let i = 0; i < 4; i++) {
      await toolAfter(hooks, sid, "edit", { filePath: `src/f${i}.ts` }, "updated")
      await completeText(hooks, sid, `step ${i}`)
      await transform(hooks, sid)
    }

    const rendersAtEnd = readEvents().filter(
      (e: LoggedEvent) => e.session_id === sid && e.event_type === "directive_rendered",
    ).length

    // Caps are per TURN. Four more tool results inside the same reply cycle must
    // not buy four more renders of the same capped families.
    expect(rendersAtEnd - rendersAfterFirst).toBeLessThan(4)
  })

  it("DOES advance the turn on a genuinely new user message", async () => {
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "turn-per-prompt"

    await activate(hooks, sid, "implement the production database migration")
    await toolAfter(hooks, sid, "edit", { filePath: "src/a.ts" }, "updated")
    const beforeSecondPrompt = await transform(hooks, sid)
    expect(beforeSecondPrompt.system.join("\n")).toBeTruthy()

    // A second real user message opens a new turn, so a capped family that
    // already spent its budget becomes eligible again.
    await activate(hooks, sid, "now also update the migration docs")
    await toolAfter(hooks, sid, "edit", { filePath: "src/b.ts" }, "updated")
    const afterSecondPrompt = await transform(hooks, sid)
    expect(afterSecondPrompt.system.join("\n")).toBeTruthy()
  })
})

// ===========================================================================
// C-14 (docs/CODE-ISSUES-FROM-PROMPT-AUDIT.md): chat.message's deactivation
// branch (`else if (msgInput.agent !== undefined && msgInput.agent !==
// opts.activeAgent)`) used to fire on ANY non-default agent, including the
// exact same agent that activated the session in the first place. A session
// activated via `/elicify-vertex` trigger text while running under a
// non-default agent (e.g. "build") necessarily sees that same "build" agent
// again on its very next ordinary turn -- that is not a signal of anything
// changing, but the old code read it as "user switched away" and
// deactivated on the second turn, every time.
//
// Confirmed on TWO independent live-host probes (not just direct hook
// calls) before this fix: a direct-hook probe against the real wired plugin
// (repeated agent:"build" turns after a trigger-text activation) and a full
// live opencode server probe (dist/plugin.js loaded by a real host, a
// sidecar logging plugin recording the RAW chat.message input) both showed
// msgInput.agent == "build" on every ordinary follow-up turn -- the host
// faithfully forwards whatever `agent` the caller's session.prompt() body
// set, it does not omit it for ordinary (non-continuation) turns. So the
// mechanism was real and reachable; a SEPARATE live UAT run that appeared
// to "stay active the whole time" only avoided it because a real model,
// given one open-ended tool-calling turn, executed the entire plan
// lifecycle (create, write, verify, checkpoint, verifier) autonomously inside
// that FIRST turn, before any second discrete chat.message ever arrived to
// exercise the deactivation branch at all -- not because the branch didn't
// fire once a genuine second turn showed up.
//
// The fix narrows deactivation to require the incoming agent differ from
// BOTH the configured default AND whatever agent this specific session
// itself activated under (`activatedAgentBySession`), so the classic
// "started under the default agent, then user switches the UI's agent
// selector to something else entirely" signal the branch was originally for
// still fires (last test below), while "same non-default agent every turn"
// no longer does (first test below).
// ===========================================================================

describe("C-14: agent-mismatch deactivation only fires on a genuine switch, not the session's own agent", () => {
  const CUE = "[vertex] harness on"

  async function chatMessage(hooks: Hooks, sessionID: string, text: string, agent: string | undefined) {
    const output = {
      message: { id: `msg-${sessionID}-${Math.random().toString(36).slice(2)}` } as never,
      parts: [{ type: "text", text } as never],
    }
    await hooks["chat.message"]!({ sessionID, agent } as never, output)
    return output
  }

  function cuePushed(output: { parts: Array<{ type?: string; text?: string }> }): boolean {
    return output.parts.some((p) => p && p.type === "text" && typeof p.text === "string" && p.text.includes(CUE))
  }

  it("does NOT deactivate when the session's own activating agent reappears with no trigger text", async () => {
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "c14-same-agent"

    // Turn 1: trigger text activates the harness under agent "build" (never
    // the configured default "elicify-vertex-agent").
    const out1 = await chatMessage(hooks, sid, "/elicify-vertex\n\ndo something", "build")
    expect(cuePushed(out1)).toBe(true)

    // Turn 2: an ordinary follow-up, no trigger text, SAME agent "build" --
    // exactly what every subsequent turn of a real build-agent session looks
    // like. Not an activating message itself (no trigger/command/default
    // agent), so no cue is expected either way here.
    const out2 = await chatMessage(hooks, sid, "just a normal follow-up message, no trigger text", "build")
    expect(cuePushed(out2)).toBe(false)

    // Turn 3: trigger text again. If turn 2 had deactivated the session,
    // activateCueShown would have been reset to false, and this trigger
    // message would re-activate and push the cue a SECOND time. Proving it
    // does NOT reappear proves activation survived turn 2 uninterrupted.
    const out3 = await chatMessage(hooks, sid, "/elicify-vertex\n\ndo something else", "build")
    expect(cuePushed(out3)).toBe(false)
  })

  it("DOES deactivate when a later message names a genuinely different agent", async () => {
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "c14-genuine-switch"

    // Turn 1: trigger text activates under agent "build".
    const out1 = await chatMessage(hooks, sid, "/elicify-vertex\n\ndo something", "build")
    expect(cuePushed(out1)).toBe(true)

    // Turn 2: a DIFFERENT agent than both the default and the one that
    // activated this session -- a genuine switch away, not a replay.
    await chatMessage(hooks, sid, "switching to a different workflow entirely", "general")

    // Turn 3: trigger text again. Deactivation on turn 2 reset
    // activateCueShown, so this re-activates and the cue reappears.
    const out3 = await chatMessage(hooks, sid, "/elicify-vertex\n\ndo something else", "build")
    expect(cuePushed(out3)).toBe(true)
  })

  it("still deactivates the classic case: default-agent activation, then a switch to an unrelated agent", async () => {
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "c14-classic-default-agent-switch"

    // Turn 1: activates via activatedByAgent (the configured default), no
    // trigger text needed.
    const out1 = await chatMessage(hooks, sid, "implement the feature", "elicify-vertex-agent")
    expect(cuePushed(out1)).toBe(true)

    // Turn 2: the user switches the session to an unrelated agent.
    await chatMessage(hooks, sid, "never mind, do something unrelated", "general")

    // Turn 3: back to the default agent -- activatedByAgent fires again,
    // which only happens if turn 2 actually deactivated the session first
    // (activateCueShown reset), otherwise the cue stays one-shot-suppressed.
    const out3 = await chatMessage(hooks, sid, "ok let's continue", "elicify-vertex-agent")
    expect(cuePushed(out3)).toBe(true)
  })

  it("survives an intervening default-agent turn without losing the original non-default activator", async () => {
    // Found by adversarial re-review of the fix above: `activatedAgentBySession`
    // used to be overwritten on EVERY qualifying turn, including ordinary
    // default-agent turns (activatedByAgent). A session activated by trigger
    // under "build", followed by one ordinary turn under the configured
    // default agent, had its recorded activator silently clobbered from
    // "build" to the default -- so "build" reappearing afterward looked like
    // a switch to a genuinely different agent and incorrectly deactivated.
    // This reproduces exactly that 3-turn interleaving.
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "c14-interleaved-default-turn"

    // Turn 1: trigger text activates under non-default agent "build".
    const out1 = await chatMessage(hooks, sid, "/elicify-vertex\n\ndo something", "build")
    expect(cuePushed(out1)).toBe(true)

    // Turn 2: an ordinary turn under the configured DEFAULT agent. This
    // satisfies `activatedByAgent`, so it re-enters the activation branch --
    // the bug was that doing so overwrote the recorded activator away from
    // "build".
    await chatMessage(hooks, sid, "an ordinary default-agent turn in between", "elicify-vertex-agent")

    // Turn 3: back to "build", no trigger text -- the session's true,
    // never-abandoned activator reappearing. Must not deactivate.
    const out3 = await chatMessage(hooks, sid, "continuing under build, no trigger text", "build")
    expect(cuePushed(out3)).toBe(false)

    // Turn 4: trigger text again. If turn 3 had deactivated the session,
    // activateCueShown would have reset and the cue would reappear here.
    const out4 = await chatMessage(hooks, sid, "/elicify-vertex\n\ndo something else", "build")
    expect(cuePushed(out4)).toBe(false)
  })
})

// ===========================================================================
// D1 regression — the covering-verifier fix, end to end through the real hook.
//
// Reproduces the exact failure measured in session ses_0668b2422ffe4hbFM3AkIerZmp
// (/home/dev/vertextest, 2026-07-27): the story prescribed narrow per-package
// verifiers, the agent ran the BROADER whole-module suite, and the old
// set-equality relevance check scored that as a gap. `success` was therefore
// false, the receipt block never ran, and 21/21 acceptance items stayed
// unevidenced across 94 minutes. These tests fail on the pre-fix code.
// ===========================================================================

describe("D1 regression: a covering verifier mints a receipt", () => {
  async function planWithVerifiers(hooks: Hooks, sid: string, verifiers: string[]) {
    await hooks.tool!.elicify_vertex_plan_create!.execute!(
      {
        stories: [
          { text: "do the work", acceptanceItems: ["it works"], scopeGlobs: ["internal/**"], verifiers, tasks: [{ text: "do the work" }] },
        ],
      } as never,
      { sessionID: sid } as never,
    )
  }

  it("mints and surfaces a receipt when the observed suite covers the prescribed packages", async () => {
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "d1-covering"

    await activate(hooks, sid, "implement the mcp server changes end to end")
    await planWithVerifiers(hooks, sid, [
      "go test ./internal/mcpserver/...",
      "go test ./internal/governance/...",
    ])
    await toolAfter(hooks, sid, "edit", { filePath: "internal/mcpserver/server.go" }, "updated")

    // The exact command the agent ran in the field.
    const toolOutput = { title: "bash", output: "ok  github.com/x/y  0.05s", metadata: { exit: 0 } }
    await hooks["tool.execute.after"]!(
      {
        tool: "bash",
        sessionID: sid,
        callID: "bash-d1",
        args: { command: "go build ./... && go test ./... -count=1 2>&1" },
      } as never,
      toolOutput as never,
    )

    expect(toolOutput.output).toMatch(/\[vertex:verification-receipt\] \S+/)
  })

  it("still reports a gap when the observed command does NOT cover (disjoint package)", async () => {
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "d1-noncovering"

    await activate(hooks, sid, "implement the mcp server changes end to end")
    await planWithVerifiers(hooks, sid, ["go test ./internal/mcpserver/..."])
    await toolAfter(hooks, sid, "edit", { filePath: "internal/mcpserver/server.go" }, "updated")

    const toolOutput = { title: "bash", output: "ok", metadata: { exit: 0 } }
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: sid, callID: "bash-d1b", args: { command: "go test ./internal/unrelated/..." } } as never,
      toolOutput as never,
    )

    expect(toolOutput.output).not.toMatch(/verification-receipt/)
  })

  it("refuses a receipt for a narrowed run of the prescribed suite (no evidence fabrication)", async () => {
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "d1-narrowed"

    await activate(hooks, sid, "implement the mcp server changes end to end")
    await planWithVerifiers(hooks, sid, ["go test ./internal/mcpserver/..."])
    await toolAfter(hooks, sid, "edit", { filePath: "internal/mcpserver/server.go" }, "updated")

    const toolOutput = { title: "bash", output: "ok", metadata: { exit: 0 } }
    await hooks["tool.execute.after"]!(
      {
        tool: "bash",
        sessionID: sid,
        callID: "bash-d1c",
        args: { command: "go test -run TestOnlyOne ./..." },
      } as never,
      toolOutput as never,
    )

    expect(toolOutput.output).not.toMatch(/verification-receipt/)
  })
})

// ===========================================================================
// US-15 wiring — a rendered directive reaches the user as a toast, while what
// the model receives is byte-identical (FR-058 / SC-017).
// ===========================================================================

describe("US-15 wiring: visibility", () => {
  function clientWithToast() {
    const showToast = vi.fn(async (_opts: { body: { message: string } }) => ({ data: true, error: undefined }))
    const client = makeStubClient()
    ;(client as unknown as { tui: unknown }).tui = { showToast }
    return { client, showToast }
  }

  it("emits a toast naming the family when a directive renders", async () => {
    const { client, showToast } = clientWithToast()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "vis-on"

    await activate(hooks, sid, "implement the production database migration")
    await toolAfter(hooks, sid, "edit", { filePath: "src/x.ts" }, "updated")
    await transform(hooks, sid)

    expect(showToast).toHaveBeenCalled()
    const messages = showToast.mock.calls.map((c) => JSON.stringify(c[0]))
    expect(messages.join("\n")).toMatch(/verify-gap|intake-scaffold/)
  })

  it("visibility off emits no toast, and the system prompt is byte-identical either way", async () => {
    const a = clientWithToast()
    const hooksAll = await ElicifyVertexPluginV2(pluginInput(a.client), { visibility: "all" } as never)
    await activate(hooksAll, "vis-a", "implement the production database migration")
    await toolAfter(hooksAll, "vis-a", "edit", { filePath: "src/x.ts" }, "updated")
    const withToasts = await transform(hooksAll, "vis-a")

    const b = clientWithToast()
    const hooksOff = await ElicifyVertexPluginV2(pluginInput(b.client), { visibility: "off" } as never)
    await activate(hooksOff, "vis-a", "implement the production database migration")
    await toolAfter(hooksOff, "vis-a", "edit", { filePath: "src/x.ts" }, "updated")
    const withoutToasts = await transform(hooksOff, "vis-a")

    expect(b.showToast).not.toHaveBeenCalled()
    expect(a.showToast).toHaveBeenCalled()
    // FR-058 / SC-017: the model's input does not depend on the visibility setting.
    expect(withoutToasts.system.join("\n")).toBe(withToasts.system.join("\n"))
  })

  it("a rejecting toast transport never breaks injection (FR-062)", async () => {
    const showToast = vi.fn(async () => {
      throw new Error("no tui attached")
    })
    const client = makeStubClient()
    ;(client as unknown as { tui: unknown }).tui = { showToast }
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "vis-fail"

    await activate(hooks, sid, "implement the production database migration")
    await toolAfter(hooks, sid, "edit", { filePath: "src/x.ts" }, "updated")
    const out = await transform(hooks, sid)

    expect(out.system.join("\n")).toContain("Do now:")
  })
})

// ===========================================================================
// FR-064 — the /elicify-vertex-visibility toggle (planned test 70).
//
// Two defects were found by driving this hook for real, and both are asserted
// here as regressions:
//  1. `all -> off` emitted NO confirmation, because the confirmation was
//     routed through the mode filter that the toggle had just set to "off".
//  2. The mode was process-global, so toggling in one session silently
//     changed every other concurrent session's visibility.
// ===========================================================================

describe("FR-064: visibility toggle", () => {
  function toastClient() {
    const showToast = vi.fn(async (_o: { body: { message: string } }) => ({ data: true, error: undefined }))
    const client = makeStubClient()
    ;(client as unknown as { tui: unknown }).tui = { showToast }
    return { client, showToast }
  }

  async function toggle(hooks: Hooks, sessionID: string) {
    await hooks["command.execute.before"]!(
      { command: "elicify-vertex-visibility", sessionID } as never,
      {} as never,
    )
  }

  function toastMessages(showToast: { mock: { calls: Array<[{ body: { message: string } }]> } }) {
    return showToast.mock.calls.map((c) => c[0].body.message)
  }

  it("confirms on EVERY press, including the all -> off transition", async () => {
    const { client, showToast } = toastClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)

    await toggle(hooks, "s1") // all -> off  (previously silent)
    expect(toastMessages(showToast).join("\n")).toContain('"off"')

    await toggle(hooks, "s1") // off -> gates
    await toggle(hooks, "s1") // gates -> all
    const msgs = toastMessages(showToast)
    expect(msgs).toHaveLength(3)
    expect(msgs.join("\n")).toContain('"gates"')
    expect(msgs.join("\n")).toContain('"all"')
  })

  it("is per-session: toggling one session does not silence another", async () => {
    const { client, showToast } = toastClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)

    await toggle(hooks, "sA") // sA -> off
    showToast.mockClear()

    // sB never toggled, so it keeps the default "all" and still gets directives.
    await activate(hooks, "sB", "implement the production database migration")
    await toolAfter(hooks, "sB", "edit", { filePath: "src/x.ts" }, "updated")
    await transform(hooks, "sB")
    expect(showToast).toHaveBeenCalled()

    // sA is off, so it gets none.
    showToast.mockClear()
    await activate(hooks, "sA", "implement the production database migration")
    await toolAfter(hooks, "sA", "edit", { filePath: "src/y.ts" }, "updated")
    await transform(hooks, "sA")
    expect(showToast).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// Post-review fixes. Each of these reproduces a defect a reviewer PROVED
// against the real hook set, so each must fail on the pre-fix code.
// ===========================================================================

describe("post-review fixes", () => {
  function toastClient() {
    const showToast = vi.fn(async (_o: { body: { message: string } }) => ({ data: true, error: undefined }))
    const client = makeStubClient()
    ;(client as unknown as { tui: unknown }).tui = { showToast }
    return { client, showToast }
  }
  const msgs = (t: { mock: { calls: Array<[{ body: { message: string } }]> } }) =>
    t.mock.calls.map((c) => c[0].body.message)

  async function planWith(hooks: Hooks, sid: string, verifiers: string[]) {
    await hooks.tool!.elicify_vertex_plan_create!.execute!(
      { stories: [{ text: "w", acceptanceItems: ["ok"], scopeGlobs: ["internal/**"], verifiers, tasks: [{ text: "do the work" }] }] } as never,
      { sessionID: sid } as never,
    )
  }

  it("no longer mints a receipt for an unrelated command when NO file was edited", async () => {
    // Reviewer proof: with zero changed paths the whole coverage check was
    // skipped, so `npx eslint .` satisfied a story verified by `go test`.
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "bypass"

    await activate(hooks, sid, "implement the mcp server changes end to end")
    await planWith(hooks, sid, ["go test ./internal/mcpserver/..."])
    // deliberately NO edit

    const out = { title: "bash", output: "ok", metadata: { exit: 0 } }
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: sid, callID: "b1", args: { command: "npx eslint ." } } as never,
      out as never,
    )
    expect(out.output).not.toMatch(/verification-receipt/)
  })

  it("still mints a receipt when the command DOES cover the story verifier with no edit", async () => {
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "bypass-ok"

    await activate(hooks, sid, "implement the mcp server changes end to end")
    await planWith(hooks, sid, ["go test ./internal/mcpserver/..."])

    const out = { title: "bash", output: "ok", metadata: { exit: 0 } }
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: sid, callID: "b2", args: { command: "go test ./..." } } as never,
      out as never,
    )
    expect(out.output).toMatch(/\[vertex:verification-receipt\]/)
  })

  it("a gate fire now reaches the operator (FR-060: 'gates' mode had nothing to report)", async () => {
    const { client, showToast } = toastClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "gatefire"

    await activate(hooks, sid, "implement the production database migration")
    await toolAfter(hooks, sid, "edit", { filePath: "src/m.ts" }, "updated")
    await idle(hooks, sid) // zero-criteria fallback dispatches a continuation

    expect(idleContinuationTexts(client, sid).length).toBeGreaterThan(0)
    expect(msgs(showToast).join("\n")).toMatch(/stop-block|gate/i)
  })

  it("two sessions no longer collide in the toast dedupe key", async () => {
    // Reviewer proof: instanceIds restart at D-1 per session while `seen` is
    // per plugin instance, so session B's first directive was swallowed.
    //
    // REWRITTEN: the previous assertion was a GLOBAL
    // `expect(showToast.mock.calls.length).toBeGreaterThanOrEqual(2)`, which
    // passes WITH the bug present -- session A alone emits 2 toasts, so session
    // B being swallowed entirely still cleared the threshold (measured: 4 -> 2
    // with sessionID dropped from the dedupe key, still green).
    //
    // Toast bodies carry the FAMILY, not the session or the file, so the two
    // sessions cannot be told apart by content. They are told apart by
    // ORDER instead: run A to completion, snapshot, then run B and require
    // that B contributed toasts of its own.
    const { client, showToast } = toastClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)

    await activate(hooks, "collideA", "implement the production database migration")
    await toolAfter(hooks, "collideA", "edit", { filePath: "src/x.ts" }, "updated")
    await transform(hooks, "collideA")
    const afterA = showToast.mock.calls.length
    expect(afterA, "PRE: session A must emit toasts at all").toBeGreaterThan(0)

    // Session B does the IDENTICAL work -- identical families, identical
    // prescriptions. Only the session id differs, so this is exactly the
    // collision the dedupe key has to survive.
    await activate(hooks, "collideB", "implement the production database migration")
    await toolAfter(hooks, "collideB", "edit", { filePath: "src/x.ts" }, "updated")
    await transform(hooks, "collideB")

    expect(
      showToast.mock.calls.length - afterA,
      "session B's directives were swallowed by session A's dedupe entries",
    ).toBeGreaterThan(0)
  })
})

// ===========================================================================
// verify:ambiguous-exit — a real verifier whose exit code is unreliable.
// Found during UAT prep: the agent prompt models `;`-chaining, the model
// generalises it to verifiers, and `cmd ; echo ...` reports the trailing
// command's status (always 0). parseVerification correctly refuses, but did
// so silently, so evidence never accrued. 4 of 25 bash commands in the
// measured field session had this shape.
// ===========================================================================

describe("verify:ambiguous-exit", () => {
  function toastClient() {
    const showToast = vi.fn(async (_o: { body: { message: string } }) => ({ data: true, error: undefined }))
    const client = makeStubClient()
    ;(client as unknown as { tui: unknown }).tui = { showToast }
    return { client, showToast }
  }

  it("warns when a verifier's exit code is unreliable, and mints no receipt", async () => {
    const { client, showToast } = toastClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "ambig"

    await activate(hooks, sid, "implement the production database migration")
    const out = { title: "bash", output: "ok  pkg  0.01s", metadata: { exit: 0 } }
    await hooks["tool.execute.after"]!(
      {
        tool: "bash",
        sessionID: sid,
        callID: "amb1",
        args: { command: 'go test ./... 2>&1; echo "---exit:$?---"' },
      } as never,
      out as never,
    )

    expect(out.output).not.toMatch(/verification-receipt/)
    expect(showToast.mock.calls.map((c) => c[0].body.message).join("\n")).toMatch(/exit code is not reliable/)

    // C-2 (docs/CODE-ISSUES-FROM-PROMPT-AUDIT.md): `visibility.notify` only
    // reaches `client.tui.showToast`, a human-operator-only channel -- the
    // model never reads it. The diagnostic must ALSO land in the tool's own
    // output, the channel the model actually reads as its tool result.
    expect(out.output).toMatch(/\[vertex:verify-ambiguous\]/)
    expect(out.output).toMatch(/exit code is not reliable/)
    // Must never be mistaken for an actual minted receipt id.
    expect(out.output).not.toMatch(/\[vertex:verification-receipt\]/)
  })

  it("does not warn for a clean standalone verifier, which still mints a receipt", async () => {
    const { client, showToast } = toastClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "clean"

    await activate(hooks, sid, "implement the production database migration")
    const out = { title: "bash", output: "ok  pkg  0.01s", metadata: { exit: 0 } }
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: sid, callID: "cl1", args: { command: "go test ./..." } } as never,
      out as never,
    )

    expect(out.output).toMatch(/\[vertex:verification-receipt\]/)
    expect(showToast.mock.calls.map((c) => c[0].body.message).join("\n")).not.toMatch(/not reliable/)
  })
})

// ===========================================================================
// receipt:scope-unverifiable — a verifier PASSED, but the worktree was too
// large to fingerprint, so no citable receipt was issued. Same C-2 defect as
// verify:ambiguous-exit above: `visibility.notify` is a human-only channel.
// ===========================================================================

describe("receipt:scope-unverifiable", () => {
  it("appends a model-facing diagnostic to toolOutput.output when the worktree can't be fingerprinted (C-2)", async () => {
    const showToast = vi.fn(async (_o: { body: { message: string } }) => ({ data: true, error: undefined }))
    const client = makeStubClient()
    ;(client as unknown as { tui: unknown }).tui = { showToast }
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "scope-too-big"

    await activate(hooks, sid, "implement the production database migration")
    // A file too large to hash makes fingerprintWorktree(workDir).complete
    // false -- mirrors tests/v2/fingerprint.test.ts's own trigger for this
    // exact condition (RECEIPT_SCOPE_MAX_FILE_BYTES is 4MB).
    writeFileSync(join(workDir, "big.bin"), Buffer.alloc(5 * 1024 * 1024, 1))
    await toolAfter(hooks, sid, "edit", { filePath: join(workDir, "src/service.ts") }, "updated")

    const out = { title: "bash", output: "1 passed in 0.02s", metadata: { exit: 0 } }
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: sid, callID: "su1", args: { command: "npx vitest run" } } as never,
      out as never,
    )

    // Human channel unchanged.
    expect(showToast.mock.calls.map((c) => c[0].body.message).join("\n")).toMatch(/too large to fingerprint/)
    // NEW model-facing channel -- the fix this test exists to prove.
    expect(out.output).toMatch(/\[vertex:scope-unverifiable\]/)
    expect(out.output).toMatch(/too large to fingerprint/)
    // Must never resemble an actual minted receipt id.
    expect(out.output).not.toMatch(/\[vertex:verification-receipt\]/)
  })
})

// ===========================================================================
// verify:non-executing — a command that RUNS NOTHING can never be evidence.
//
// Found by UAT scenario G5 against a real CLI session: `python3 -m pytest
// --collect-only` minted a real receipt (`receipt=True` in opencode.db) while
// executing zero tests. The `NON_EXECUTING_FLAGS` guard already existed, but
// it lived inside `subCommandCovers`, which `tool.execute.after` only reaches
// when a PRESCRIPTION exists. The UAT session had no plan and no file edits,
// so `prescribed` was null, the coverage comparison was skipped entirely, and
// the guard was unreachable. Hoisted to an unconditional pre-check.
// ===========================================================================

describe("verify:non-executing", () => {
  function toastClient() {
    const showToast = vi.fn(async (_o: { body: { message: string } }) => ({ data: true, error: undefined }))
    const client = makeStubClient()
    ;(client as unknown as { tui: unknown }).tui = { showToast }
    return { client, showToast }
  }

  it("mints no receipt for --collect-only with NO plan and NO changed paths (the UAT G5 hole)", async () => {
    const { client, showToast } = toastClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "collectonly"

    // Deliberately no plan and no edit — this is exactly the state in which
    // `prescribed` is null and the coverage check never runs.
    await activate(hooks, sid, "check the python test layout")
    const out = { title: "bash", output: "collected 1 item", metadata: { exit: 0 } }
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: sid, callID: "co1", args: { command: "python3 -m pytest --collect-only" } } as never,
      out as never,
    )

    expect(out.output).not.toMatch(/verification-receipt/)
    expect(showToast.mock.calls.map((c) => c[0].body.message).join("\n")).toMatch(/executes no tests/)
  })

  it("mints no receipt for other non-executing shapes, plan or no plan", async () => {
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "nonexec-variants"
    await activate(hooks, sid, "check the test layout")

    const commands = ["npx vitest --version", "npx jest --listTests", "go test -list .*", "go test -c ./..."]
    for (const [i, command] of commands.entries()) {
      const out = { title: "bash", output: "ok", metadata: { exit: 0 } }
      await hooks["tool.execute.after"]!(
        { tool: "bash", sessionID: sid, callID: `ne${i}`, args: { command } } as never,
        out as never,
      )
      expect(out.output, `"${command}" must not mint a receipt`).not.toMatch(/verification-receipt/)
    }
  })

  it("`pytest -n auto` is a real parallel suite and MUST still mint a receipt", async () => {
    // `-n` is go's "print, don't run" but pytest-xdist's WORKER COUNT. Because
    // the non-executing check is now unconditional, putting `-n` in the global
    // set would silently starve every xdist run of evidence.
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "xdist"
    await activate(hooks, sid, "check the python test layout")

    const out = { title: "bash", output: "8 passed in 1.2s", metadata: { exit: 0 } }
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: sid, callID: "xd1", args: { command: "python3 -m pytest -n auto" } } as never,
      out as never,
    )
    expect(out.output).toMatch(/\[vertex:verification-receipt\]/)
  })

  it("a REAL run in the same no-plan, no-edit state still mints a receipt (discrimination)", async () => {
    // Without this the fix could be 'refuse everything when prescribed is null'
    // and both tests above would still pass while the harness collected nothing.
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "nonexec-control"

    await activate(hooks, sid, "check the python test layout")
    const out = { title: "bash", output: "1 passed in 0.02s", metadata: { exit: 0 } }
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: sid, callID: "ok1", args: { command: "python3 -m pytest" } } as never,
      out as never,
    )

    expect(out.output).toMatch(/\[vertex:verification-receipt\]/)
  })
})

// ===========================================================================
// Inertness: a session that never activates the harness must leave NO trace.
// UAT G1 (no --agent, no trigger) found a live session writing a
// `dosing:unknown-model` line into `.vertex-events.jsonl`, because the dosing
// log in `chat.message` ran before the activation check. Behaviourally the
// session was inert -- no directives, no receipts, no injected text -- but
// "inert" has to include "writes nothing", or the event log stops being a
// trustworthy record of which sessions the harness touched.
//
// BACKLOG B-1 deleted `dosing:unknown-model`, which was the event the
// discrimination partner below asserted. Deleting that partner alone would
// have left the inertness test passing VACUOUSLY -- "no events" is trivially
// true if the harness logs nothing for anyone. The partner is therefore
// REPOINTED at `directive_rendered`, an event an activated session emits on
// the same code path (`system.transform`) and that no non-activated session
// can reach. It discriminates exactly as before: gut the activation check the
// wrong way and the first test still passes, but the second fails.
// ===========================================================================

describe("inertness: a non-activated session writes nothing", () => {
  it("logs NO event at all for a session that never activates", async () => {
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = `inert-${Math.random().toString(36).slice(2)}`

    // A plain user message carrying a model, with NO activation cue and no
    // agent -- exactly the `opencode run --dir X "say OK"` shape of UAT G1.
    await hooks["chat.message"]!(
      { sessionID: sid, model: { providerID: "openrouter", modelID: "z-ai/glm-5.2" } } as never,
      { message: {} as never, parts: [{ type: "text", text: "say OK" } as never] },
    )
    // Drive `system.transform` too -- the OTHER hook that used to log the
    // model. A non-activated session must be silent on both.
    await hooks["experimental.chat.system.transform"]!(
      { sessionID: sid, model: { providerID: "openrouter", id: "z-ai/glm-5.2" } as never },
      { system: [] as string[] },
    )

    const mine = readEvents().filter((e) => e.session_id === sid)
    expect(mine.map((e) => e.event_type)).toEqual([])
  })

  it("DOES log for an ACTIVATED session on the same hooks (discrimination -- without this the test above is vacuous)", async () => {
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = `active-${Math.random().toString(36).slice(2)}`

    // Same model, same two hooks, same order as the inert case above. The
    // ONLY difference is that this session activates.
    await activate(hooks, sid, "implement the production database migration", {
      providerID: "openrouter",
      id: "z-ai/glm-5.2",
    })
    await hooks["experimental.chat.system.transform"]!(
      { sessionID: sid, model: { providerID: "openrouter", id: "z-ai/glm-5.2" } as never },
      { system: [] as string[] },
    )

    const mine = readEvents().filter((e) => e.session_id === sid)
    expect(mine.length).toBeGreaterThan(0)
    expect(mine.some((e) => e.event_type === "directive_rendered")).toBe(true)
    // The model id is still stamped on every record (FR-033) -- B-1 removed
    // the `profile` companion, not this.
    expect(mine.every((e) => e.model === "openrouter/z-ai/glm-5.2")).toBe(true)
  })
})

// ===========================================================================
// BACKLOG B-1: the judge runs on the worker's model. No table, no profile,
// no override.
//
// The deleted `src/v2/dosing.ts` held a two-row model->profile table and
// `wiring/dosing.ts` used it to REWRITE or DROP findings per model. Measured
// on this exact scenario at the pre-removal commit, one 3-turn session
// rendered 6 directives / 1842 chars on `anthropic/claude-fable-5`
// ("frontier") but only 3 directives / 1308 chars on `minimax/MiniMax-M3`
// ("standard") — the same harness, the same events, a different answer
// because of the model name. That is the coupling these tests forbid.
// ===========================================================================

describe("BACKLOG B-1: the model id does not change what the harness renders", () => {
  // Row 1 of the deleted table ("frontier"), row 2 ("standard"), and the id
  // the FIELD session actually reported — which missed the table on the
  // provider segment and fell back to "standard" 138 times.
  const MODELS = [
    { providerID: "anthropic", id: "claude-fable-5" },
    { providerID: "minimax", id: "MiniMax-M3" },
    { providerID: "minimax-coding-plan", id: "MiniMax-M3" },
  ]

  async function renderFor(model: { providerID: string; id: string }) {
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = `b1-${model.providerID}-${Math.random().toString(36).slice(2)}`

    await activate(hooks, sid, "implement the production database migration and verify it", model)
    await toolAfter(hooks, sid, "edit", { filePath: "src/migrate.ts" }, "updated")
    const out = await transformWith(hooks, sid, model)

    const mine = readEvents().filter((e) => e.session_id === sid)
    return {
      injected: out.system.join("\n---\n"),
      families: mine
        .filter((e) => e.event_type === "directive_rendered")
        .map((e) => String((e.payload as { family?: string }).family))
        .sort(),
    }
  }

  it("renders byte-identical directives for a 'frontier'-table model, a 'standard'-table model, and a model the table never knew", async () => {
    const [frontierRow, standardRow, unknownToTable] = await Promise.all(MODELS.map(renderFor))

    // Non-vacuous: there is something to compare. Without this the test
    // would pass on three empty strings.
    expect(frontierRow.families.length).toBeGreaterThan(0)
    expect(frontierRow.injected.length).toBeGreaterThan(0)

    // The whole rule, in two assertions. Pre-removal the first pair differed
    // in BOTH fields (6 families vs 3; 1842 chars vs 1308).
    expect(standardRow).toEqual(frontierRow)
    expect(unknownToTable).toEqual(frontierRow)
  })

  it("emits no dosing telemetry for a model the deleted table would have called unknown", async () => {
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = `b1-telemetry-${Math.random().toString(36).slice(2)}`
    const model = { providerID: "minimax-coding-plan", id: "MiniMax-M3" }

    await activate(hooks, sid, "implement the production database migration", model)
    for (let step = 0; step < 5; step++) {
      await toolAfter(hooks, sid, "edit", { filePath: `src/step-${step}.ts` }, "updated")
      await transformWith(hooks, sid, model)
    }

    const mine = readEvents().filter((e) => e.session_id === sid)
    // Discrimination: the session IS logging — "no dosing events" below is
    // therefore about dosing, not about a silent harness.
    expect(mine.length).toBeGreaterThan(0)
    expect(mine.some((e) => e.event_type === "dosing:unknown-model")).toBe(false)
    // FR-033's `profile` stamp went with the table. Every record on disk must
    // now be free of it; pre-removal every one of them carried it.
    expect(mine.every((e) => !("profile" in e))).toBe(true)
    // The model id itself is still recorded — B-1 removed the profile, not
    // the model attribution.
    expect(mine.every((e) => e.model === "minimax-coding-plan/MiniMax-M3")).toBe(true)
  })

  it("composes with B-2: rendering FULL for every model does not re-open the per-step flood", async () => {
    // B-1 raises directive volume (every session now gets the full form that
    // only the 'frontier' row used to get). B-2 bounds emission to once per
    // TURN. This pins that composition at a step count far past the point the
    // pre-B-2 bug would have shown (the field session logged 179
    // `per-turn-cap:dropped`, all intake-scaffold).
    //
    // REWRITTEN (B-2 follow-up). The assertion below was
    // `expect(capDrops).toHaveLength(0)` over EVERY family, in a session with
    // no plan and no scope globs — so `scope-watchdog` (needs an active
    // story's scopeGlobs) and `verify-gap` (needs a resolvable verifier)
    // could not be produced at all, and the guard passed vacuously for
    // exactly the two families that were still flooding: measured on this
    // file's own harness, 119 + 117 cap drops in one 120-step turn. The
    // scenario now declares a plan WITH scopeGlobs and verifiers and edits
    // outside that scope without verifying, so every family named below is
    // genuinely producible, and each is asserted BY NAME with a rendered
    // count to prove the family was live.
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = `b1-bounded-${Math.random().toString(36).slice(2)}`
    const model = { providerID: "anthropic", id: "claude-fable-5" }

    await activate(hooks, sid, "implement the production database migration", model)
    await hooks.tool!.elicify_vertex_plan_create!.execute!(
      {
        stories: [
          {
            text: "narrow story",
            acceptanceItems: ["A1"],
            scopeGlobs: ["src/in-scope/**"],
            verifiers: ["npx vitest run"],
            tasks: [{ text: "do the work" }],
          },
        ],
      } as never,
      { sessionID: sid } as never,
    )

    let injectedBlocks = 0
    for (let step = 0; step < 40; step++) {
      await toolAfter(hooks, sid, "edit", { filePath: `src/elsewhere/step-${step}.ts` }, "updated")
      injectedBlocks += (await transformWith(hooks, sid, model)).system.length
    }

    const mine = readEvents().filter((e) => e.session_id === sid)
    const family = (e: LoggedEvent) => String((e.payload as { family?: string }).family)
    const count = (type: string, fam: string) => mine.filter((e) => e.event_type === type && family(e) === fam).length
    const rendered = (fam: string) => count("directive_rendered", fam)
    const capDrops = (fam: string) => count("per-turn-cap:dropped", fam)

    // NON-VACUITY FIRST: every family the drop assertions cover really did
    // reach the model in this scenario. Pre-rewrite, all three of these read
    // 0 (no plan -> no scope drift, no resolvable verifier) or 0 for the
    // scaffold (B-2's flag was spent by the budget-dropped offer on step 1).
    expect(rendered("verify-gap"), "verify-gap must be producible here").toBe(3) // its cap
    expect(rendered("scope-watchdog"), "scope-watchdog must be producible here").toBe(1)
    expect(rendered("intake-scaffold"), "the scaffold must still land in this turn").toBe(1)

    // 40 steps, ONE turn, and not one finding built for the composer to bin.
    // Measured before the fix, per family: verify-gap 37, scope-watchdog 39.
    expect(capDrops("verify-gap")).toBe(0)
    expect(capDrops("scope-watchdog")).toBe(0)
    expect(capDrops("intake-scaffold")).toBe(0)
    expect(capDrops("pre-commitment")).toBe(0)
    expect(capDrops("elevate")).toBe(0)
    // ...and globally, which is what the old assertion MEANT to say.
    expect(mine.filter((e) => e.event_type === "per-turn-cap:dropped")).toHaveLength(0)
    // Rendered volume is flat in the step count: 5 directives in 3 blocks,
    // whether the turn runs 6 steps or 120.
    expect(injectedBlocks).toBe(3)
  })
})

// ===========================================================================
// B-2 FOLLOW-UP — the producers, not the composer.
//
// B-2 fixed ONE family (`intake-scaffold`) and fixed it in the wrong place:
// the once-per-turn flag was spent when the finding was OFFERED, so the first
// invocation whose 2-slot budget went to corrections spent the flag on a
// directive that never reached the model, and no later step re-offered it.
// Measured on the harness below, before this change:
//
//   family           rendered   per-turn-cap:dropped   (one 120-step turn)
//   intake-scaffold      0          0  (1 budget:dropped, then silence)
//   verify-gap           3        117
//   scope-watchdog       1        119
//   pre-commitment       1         95  (96 edit/verify cycles)
//   elevate              1        284  (same run)
//
// Every one of those drops is a finding that was built — `resolveVerifier`
// re-run, an instance id burned, an event written — after the composer had
// already spent that family's cap for the turn. `InjectionComposer.
// blockedBeforeBudget` lets the producer ask before building; because it
// models only the two PRE-BUDGET filters, a budget drop still re-offers, which
// is what the composer's contract requires and what B-2 broke.
// ===========================================================================

describe("B-2 follow-up: producers stop re-minting, and stop suppressing", () => {
  const NARROW_STORY = {
    stories: [
      {
        text: "narrow story",
        acceptanceItems: ["A1"],
        scopeGlobs: ["src/in-scope/**"],
        verifiers: ["npx vitest run"],
        tasks: [{ text: "do the work" }],
      },
    ],
  }

  function tally(sid: string) {
    const mine = readEvents().filter((e) => e.session_id === sid)
    const family = (e: LoggedEvent) => String((e.payload as { family?: string }).family)
    const count = (type: string, fam: string) => mine.filter((e) => e.event_type === type && family(e) === fam).length
    return {
      rendered: (fam: string) => count("directive_rendered", fam),
      capDrops: (fam: string) => count("per-turn-cap:dropped", fam),
      budgetDrops: (fam: string) => count("budget:dropped", fam),
    }
  }

  it("FIX 1: a scaffold that loses the 2-slot budget on step 1 is re-offered and lands on step 2", async () => {
    // The reviewer's repro, exactly: a deep ask, a plan with scopeGlobs, and
    // one unverified out-of-scope edit per step. Step 1 produces verify-gap +
    // scope-watchdog (both `correction`) and the scaffold (`phase-guidance`),
    // so the scaffold is budget-dropped. Pre-fix its once-per-turn flag was
    // ALREADY spent at that point and the scaffold never appeared again:
    // `rendered=0, budgetDrops=1` for the whole turn — B-2 suppressing the
    // very directive it was written to preserve.
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = `b2f-scaffold-${Math.random().toString(36).slice(2)}`

    await activate(hooks, sid, "implement the production database migration")
    await hooks.tool!.elicify_vertex_plan_create!.execute!(NARROW_STORY as never, { sessionID: sid } as never)

    const sawScaffold: boolean[] = []
    for (let step = 0; step < 6; step++) {
      await toolAfter(hooks, sid, "edit", { filePath: `src/elsewhere/step-${step}.ts` }, "updated")
      sawScaffold.push((await transform(hooks, sid)).system.join("\n").includes("OUTCOME:"))
    }

    // Pre-fix: [false, false, false, false, false, false].
    expect(sawScaffold[0], "step 1 legitimately loses the budget to two corrections").toBe(false)
    expect(sawScaffold[1], "step 2 must re-offer — this is the whole fix").toBe(true)
    const t = tally(sid)
    expect(t.rendered("intake-scaffold")).toBe(1)
    expect(t.budgetDrops("intake-scaffold")).toBe(1) // step 1 only: after a render the offer stops
    expect(t.capDrops("intake-scaffold")).toBe(0)
  })

  it("FIX 2: verify-gap still renders on exactly the steps it always did — only the doomed re-mints go", async () => {
    // The caution: verify-gap is the one family with measured real-world
    // compliance (9 rendered, 14 complied), so the gate must not move WHEN it
    // reaches the model. It cannot: `blockedBeforeBudget` closes only once the
    // composer has spent the family's cap of 3, at which point every further
    // finding was already guaranteed `per-turn-cap:dropped`. Asserted as
    // "steps 1-3 carry the prescription, exactly as before".
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = `b2f-verifygap-${Math.random().toString(36).slice(2)}`

    await activate(hooks, sid, "implement the production database migration")
    await hooks.tool!.elicify_vertex_plan_create!.execute!(NARROW_STORY as never, { sessionID: sid } as never)

    const carried: boolean[] = []
    for (let step = 0; step < 30; step++) {
      await toolAfter(hooks, sid, "edit", { filePath: `src/elsewhere/step-${step}.ts` }, "updated")
      carried.push((await transform(hooks, sid)).system.join("\n").includes("Run npx vitest run"))
    }

    expect(carried.slice(0, 3), "the three renders the cap allows, on their original steps").toEqual([true, true, true])
    expect(carried.slice(3).some(Boolean), "steps 4+ were already silent — the cap saw to that").toBe(false)
    const t = tally(sid)
    expect(t.rendered("verify-gap")).toBe(3)
    expect(t.capDrops("verify-gap")).toBe(0) // measured pre-fix over 30 steps: 27
  })

  it("FIX 2: scope-watchdog renders once, and the drift it is still holding renders again next turn", async () => {
    // The second half of "do not weaken delivery": the gate skips the MINT,
    // it does not clear `scopeDriftPending`. A gate continuation advances the
    // composer's turn without touching wiring state, the cap refills, and the
    // watchdog speaks again — the same behaviour a per-step re-mint produced,
    // minus the 119 discarded findings.
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = `b2f-scope-${Math.random().toString(36).slice(2)}`

    await activate(hooks, sid, "implement the production database migration")
    await hooks.tool!.elicify_vertex_plan_create!.execute!(NARROW_STORY as never, { sessionID: sid } as never)

    for (let step = 0; step < 20; step++) {
      await toolAfter(hooks, sid, "edit", { filePath: `src/elsewhere/step-${step}.ts` }, "updated")
      await transform(hooks, sid)
    }
    expect(tally(sid).rendered("scope-watchdog")).toBe(1)
    expect(tally(sid).capDrops("scope-watchdog")).toBe(0) // measured pre-fix over 20 steps: 19

    await idle(hooks, sid)
    expect(idleContinuationTexts(client, sid).length, "the idle gate must have opened a new turn").toBeGreaterThan(0)
    await transform(hooks, sid)
    expect(tally(sid).rendered("scope-watchdog"), "the held drift is delivered, not dropped").toBe(2)
  })

  it("FIX 3: pre-commitment survives 20 re-entries into execute without minting 19 doomed findings", async () => {
    // `precommitmentPending` is re-armed by T6 (elevate -> execute), i.e. by
    // every mutation that follows a passing verifier, so an edit/verify cycle
    // re-mints it per cycle against a cap of 1. Measured pre-fix over 96
    // cycles: 1 rendered, 95 dropped.
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = `b2f-precommit-${Math.random().toString(36).slice(2)}`

    await activate(hooks, sid, "implement the production database migration")
    for (let cycle = 0; cycle < 20; cycle++) {
      await toolAfter(hooks, sid, "edit", { filePath: `src/step-${cycle}.ts` }, "updated")
      await transform(hooks, sid)
      await toolAfter(hooks, sid, "bash", { command: "npx vitest run" }, "20 passed", { exit: 0 })
      await transform(hooks, sid)
    }

    const t = tally(sid)
    expect(t.rendered("pre-commitment"), "the one offer FR-023a promises still lands").toBe(1)
    expect(t.capDrops("pre-commitment")).toBe(0) // measured pre-fix over 20 cycles: 19
    // Same shape, same run, worst numbers of the five — found by this
    // harness rather than reported: `elevatePending` is re-armed by every
    // passing verifier (T4). Measured pre-fix over 96 cycles: 284 drops.
    expect(t.rendered("elevate")).toBe(1)
    expect(t.capDrops("elevate")).toBe(0)
  })
})

// ===========================================================================
// `file.edited` attribution across sessions.
//
// The old rule fired only when EXACTLY ONE session was active. That reads as
// conservative but failed open, and permanently: `states` is never pruned and
// `active` is cleared only when a message names a different agent, so after
// the SECOND activated session in a long-lived server the count is >= 2 for
// the life of the process and this net never fired again -- no changed-path
// recording and no receipt invalidation from filesystem edits, for anyone.
//
// This is the SECONDARY net; `tool.execute.after` records and invalidates
// per-session for every edit the tool layer sees and was never affected.
// ===========================================================================

describe("file.edited is a deliberate no-op; tool.execute.after carries attribution", () => {
  // This branch has been wrong in BOTH directions. It first required exactly
  // one active session -- permanently false in a long-lived server, so the net
  // never fired after the second session. The fix fanned out to "every active
  // session whose workspace contains the file", which cannot discriminate at
  // all: `workspaceRoot` is computed once and handed to every session, so a
  // session that had done nothing got a stop-block for someone else's edit and
  // its peers' PERSISTED receipts were deleted.
  //
  // `file.edited` carries no session id, so it is simply not attributable.
  // What must keep working is the path that IS attributable.
  it("records changed paths per session from tool.execute.after, at any session count", async () => {
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)

    await activate(hooks, "attrib-a", "implement the production database migration")
    await activate(hooks, "attrib-b", "implement the production database migration")

    // Only session A edits.
    await toolAfter(hooks, "attrib-a", "edit", { filePath: join(workDir, "src/a.ts") }, "updated")

    await idle(hooks, "attrib-a")
    await idle(hooks, "attrib-b")

    expect(idleContinuationTexts(client, "attrib-a").length).toBeGreaterThan(0)
    expect(
      idleContinuationTexts(client, "attrib-b"),
      "session B changed nothing and must not be blocked for a peer's edit",
    ).toEqual([])
  })
})
describe("persisted receipts survive a restart and are visible to the gate", () => {
  it("hydrates a receipt minted by a previous plugin instance", async () => {
    // REWRITTEN for the 2026-07-30 task/DAG redesign. The original test proved a
    // receipt minted by plugin instance A was still accepted by instance B's
    // elicify_vertex_plan_checkpoint after a restart (the OLD checkpoint
    // validated receipt citations). A checkpoint is now a bare CLAIM on a TASK
    // id and no longer reads receipts at all — so "visible to the gate via
    // checkpoint citation" is gone. What survives (and is still asserted here)
    // is the persistence/hydration path itself: the receipt is minted by
    // instance A's tool.execute.after and the hydrated store is observable
    // after a restart, while the task-level claim completes the story with no
    // citation (the completion verifier, not the checkpoint, audits claims).
    const clientA = makeStubClient()
    const hooksA = await ElicifyVertexPluginV2(pluginInput(clientA), undefined)
    const sid = "restart-session"

    await activate(hooksA, sid, "implement the production database migration")
    await hooksA.tool!.elicify_vertex_plan_create!.execute!(
      { stories: [{ text: "w", acceptanceItems: ["ok"], scopeGlobs: ["**"], verifiers: ["go test ./..."], tasks: [{ text: "do the work" }] }] } as never,
      { sessionID: sid } as never,
    )
    const out = { title: "bash", output: "ok  pkg  0.01s", metadata: { exit: 0 } }
    await hooksA["tool.execute.after"]!(
      { tool: "bash", sessionID: sid, callID: "r1", args: { command: "go test ./..." } } as never,
      out as never,
    )
    const receiptId = /vrf_[0-9a-f]+/.exec(out.output)?.[0]
    expect(receiptId, "PRE: a receipt must have been minted to test hydration").toBeTruthy()

    // A brand-new plugin instance over the SAME workspace == a restart.
    const clientB = makeStubClient()
    const hooksB = await ElicifyVertexPluginV2(pluginInput(clientB), undefined)
    await activate(hooksB, sid, "implement the production database migration")

    // The task-level claim completes the story after the restart — no receipt
    // citation is needed or accepted (the receipt store still hydrates; it is
    // simply no longer the checkpoint's concern).
    const res = await hooksB.tool!.elicify_vertex_plan_checkpoint!.execute!(
      { taskId: "S1.T1", status: "complete" } as never,
      { sessionID: sid } as never,
    )
    expect((JSON.parse(res as string) as { stories: Array<{ status: string }> }).stories[0].status).toBe("complete")
  })
})

// ===========================================================================
// The evidence store is not writable by the model.
//
// A review demonstrated the forgery end to end: read `receipts.json`, clone a
// still-valid receipt with a fresh id and a different story id, append it, and
// the checkpoint accepts it. Neither the story link nor the worktree digest
// stops it — neither binds a receipt to the store having OBSERVED a command,
// so forging one cost a single file write.
//
// Relocating the store under `.opencode/` is only half the fix; without this
// guard it is just a different path the model can open. Reads stay allowed:
// the model may inspect its evidence, it just cannot author it.
// ===========================================================================

describe("the plugin's persisted state is protected from the model", () => {
  // The tool-boundary check is DEFENCE IN DEPTH, not the integrity control --
  // an audit walked ~15 ways around it. The control is the HMAC in goals.ts
  // (see tests/v2/receipts.test.ts): a receipt the harness did not mint has no
  // valid signature and `get()` refuses it however it reached the file.
  //
  // What this block pins is that the friendly early error still fires for the
  // obvious write shapes, and -- equally important -- that READS and ordinary
  // work are not blocked. An earlier version matched the directory name inside
  // any bash command, which also refused `cat`, `grep`, `ls` and
  // `git commit -m "move state to .opencode/elicify-vertex"`.
  const blocked: Array<[string, string, Record<string, unknown>]> = [
    ["write/filePath", "write", { filePath: ".opencode/elicify-vertex/receipts.json" }],
    ["write/file_path (snake_case)", "write", { file_path: ".opencode/elicify-vertex/receipts.json" }],
    ["edit", "edit", { filePath: ".opencode/elicify-vertex/plan.json" }],
    ["multiedit", "multiedit", { filePath: ".opencode/elicify-vertex/pins.json" }],
    ["notebookedit", "notebookedit", { notebookPath: ".opencode/elicify-vertex/x.ipynb" }],
    ["path traversal", "write", { filePath: "src/../.opencode/elicify-vertex/receipts.json" }],
  ]

  it.each(blocked)("refuses %s targeting the evidence store", async (_label, tool, args) => {
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "guard"
    await activate(hooks, sid, "implement the production database migration")
    await expect(
      hooks["tool.execute.before"]!({ tool, sessionID: sid, callID: "g1" } as never, { args } as never),
    ).rejects.toThrow(/elicify-vertex/)
  })

  const allowed: Array<[string, string, Record<string, unknown>]> = [
    ["an ordinary source write", "write", { filePath: "src/service.ts" }],
    ["a read of the store", "read", { filePath: ".opencode/elicify-vertex/receipts.json" }],
    ["a grep over the store", "grep", { path: ".opencode/elicify-vertex" }],
    ["bash naming the store", "bash", { command: "cat .opencode/elicify-vertex/receipts.json" }],
    ["a commit message mentioning it", "bash", { command: 'git commit -m "move state to .opencode/elicify-vertex"' }],
    ["an ordinary verifier", "bash", { command: "go test ./..." }],
    ["editing real .opencode config", "edit", { filePath: ".opencode/opencode.json" }],
  ]

  it.each(allowed)("allows %s", async (_label, tool, args) => {
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "guard-ok"
    await activate(hooks, sid, "implement the production database migration")
    await expect(
      hooks["tool.execute.before"]!({ tool, sessionID: sid, callID: "g2" } as never, { args } as never),
    ).resolves.toBeUndefined()
  })
})

// ===========================================================================
// C-7 (docs/CODE-ISSUES-FROM-PROMPT-AUDIT.md, design in
// docs/SUBAGENT-INJECTION-DRAFT.md): every `task` tool call gets the shared
// subagent discipline injected into its prompt, instead of depending on the
// parent hand-writing it into each delegation.
// ===========================================================================

describe("C-7: task tool calls get the subagent discipline injected", () => {
  it("injects the preamble into args.prompt in place, returns without throwing, and skips the write-protection check entirely", async () => {
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "task-inject"
    await activate(hooks, sid, "implement the production database migration")

    // `filePath` targets the protected state dir -- this exact shape THROWS
    // for a WRITE_TOOL_NAMES tool (see "the plugin's persisted state is
    // protected from the model" above). Including it here on a `task` call
    // proves `tool.execute.before` returns unconditionally from the new
    // branch, before any write-protection logic runs at all -- not merely
    // that "task" happens to be absent from WRITE_TOOL_NAMES today.
    const toolOutput = {
      args: {
        description: "fix the flaky test",
        prompt: "delegate: fix the flaky test",
        subagent_type: "general-purpose",
        filePath: ".opencode/elicify-vertex/receipts.json",
      },
    }

    await expect(
      hooks["tool.execute.before"]!({ tool: "task", sessionID: sid, callID: "t1" } as never, toolOutput as never),
    ).resolves.toBeUndefined()

    // Same object reference, mutated in place -- not a new args object.
    expect(toolOutput.args.prompt).toContain("You are executing one bounded unit of work")
    expect(toolOutput.args.prompt).toContain("delegate: fix the flaky test")
  })

  it("leaves args.prompt untouched (and still does not throw) when prompt is missing", async () => {
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "task-no-prompt"
    await activate(hooks, sid, "implement the production database migration")

    const toolOutput = { args: { description: "no prompt field", subagent_type: "general-purpose" } }
    await expect(
      hooks["tool.execute.before"]!({ tool: "task", sessionID: sid, callID: "t2" } as never, toolOutput as never),
    ).resolves.toBeUndefined()
    expect(toolOutput.args).toEqual({ description: "no prompt field", subagent_type: "general-purpose" })
  })

  // C-10 (docs/CODE-ISSUES-FROM-PROMPT-AUDIT.md): the "second subagent
  // trigger site" C-7's own notes named (the `@agent` mention / command
  // path, e.g. @mentioning a mode:"subagent" agent, or a slash command
  // configured with `subtask: true`) turns out NOT to be a separate plugin
  // hook surface at all -- confirmed via a live opencode 1.18.8 host probe
  // (sidecar logging plugin + a SubtaskPartInput sent directly through
  // session.prompt): the host resolves that message-part type into a real
  // internal `task` TOOL CALL before dispatch, landing in THIS SAME
  // `tool.execute.before` branch with `tool: "task"` and
  // `args: {prompt, description, subagent_type, command}` -- an extra
  // `command` key beyond what a model-initiated task call ever includes
  // (verified: neither test above includes it). The probe's child-session
  // DB read (not the subagent's own report) showed the injected preamble
  // reaching the spawned session byte for byte, exactly like a model-issued
  // task call. This test pins that exact args shape so a future change that
  // narrowed the injection branch to only args without a `command` key
  // would fail loudly here instead of silently reopening C-10.
  it("still injects when args carry the extra `command` key a host-synthesized (subtask-derived) task call has", async () => {
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "task-inject-subtask-shape"
    await activate(hooks, sid, "implement the production database migration")

    const toolOutput = {
      args: {
        description: "c10 probe",
        prompt: "ORIGINAL-UNMUTATED-PROMPT-TEXT-12345",
        subagent_type: "c10-probe-subagent",
        command: "some-command-name",
      },
    }

    await expect(
      hooks["tool.execute.before"]!({ tool: "task", sessionID: sid, callID: "t3" } as never, toolOutput as never),
    ).resolves.toBeUndefined()

    expect(toolOutput.args.prompt).toContain("You are executing one bounded unit of work")
    expect(toolOutput.args.prompt).toContain("ORIGINAL-UNMUTATED-PROMPT-TEXT-12345")
    expect(toolOutput.args.command).toBe("some-command-name") // untouched
  })
})

// ===========================================================================
// Security review finding: `injectSubagentPreamble`'s boolean return value
// was discarded at the plugin.ts call site. It only returns `false` when
// `args.prompt` isn't a string -- today that never happens (the `task`
// schema requires it), but if that schema ever changes shape, the whole
// injection mechanism would silently stop working with zero signal anywhere.
// `plugin.ts` now logs `subagent:injection-skipped` on that no-op path and
// stays quiet on the (only currently reachable) success path.
// ===========================================================================

describe("subagent injection no-op is now observable", () => {
  it("logs subagent:injection-skipped when args.prompt is not a string", async () => {
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "task-inject-skip-log"
    await activate(hooks, sid, "implement the production database migration")

    const toolOutput = { args: { description: "no prompt field", subagent_type: "general-purpose" } }
    await hooks["tool.execute.before"]!({ tool: "task", sessionID: sid, callID: "skip1" } as never, toolOutput as never)

    const events = readEvents().filter((e) => e.event_type === "subagent:injection-skipped" && e.session_id === sid)
    expect(events.length).toBeGreaterThan(0)
    expect(events[events.length - 1].payload.reason).toBe("args.prompt is not a string")
  })

  it("does NOT log subagent:injection-skipped when args.prompt is a string", async () => {
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "task-inject-skip-quiet"
    await activate(hooks, sid, "implement the production database migration")

    const toolOutput = { args: { description: "fix it", prompt: "delegate: fix it", subagent_type: "general-purpose" } }
    await hooks["tool.execute.before"]!({ tool: "task", sessionID: sid, callID: "skip2" } as never, toolOutput as never)

    const events = readEvents().filter((e) => e.event_type === "subagent:injection-skipped" && e.session_id === sid)
    expect(events).toHaveLength(0)
  })
})

// ===========================================================================
// A verifier that relates to NO work must not answer a criterion.
//
// With no plan and no changed paths, `prescribed` is null, so every
// verifier-shaped command mints a receipt — an audit measured `npx eslint .`,
// `tsc --noEmit`, `make check` and `curl -sf` all minting. Auto-attaching
// those closed the criteria gate on evidence of nothing: criteria "auth
// service tests pass" and "migration applies cleanly" were both satisfied by
// running eslint.
//
// The receipt itself is a TRUE statement — that command really did pass — and
// is still minted and citable. What it must not do is silently answer a
// criterion nobody measured it against.
// ===========================================================================

describe("a verifier unrelated to any work does not evidence criteria", () => {
  it("does not attach a no-work receipt to a pinned criterion", async () => {
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "nowork"
    // The audit's actual shape: a file DID change, but one the resolver cannot
    // classify (Ruby), so there is no prescription — and then a LINT pass is
    // offered as evidence for criteria about tests.
    await activate(hooks, sid, "implement the production database migration")
    // Exactly ONE criterion: auto-attach only ever takes the oldest
    // unevidenced one, so with two pinned the gate would still block on the
    // second and this test would pass whether the fix is present or not.
    await completeText(hooks, sid, "CRITERIA:\n1. auth service tests pass")
    await toolAfter(hooks, sid, "edit", { filePath: join(workDir, "src/app.rb") }, "updated")
    const out = { title: "bash", output: "ok", metadata: { exit: 0 } }
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: sid, callID: "c1", args: { command: "npx eslint ." } } as never,
      out as never,
    )

    await idle(hooks, sid)
    expect(
      idleContinuationTexts(client, sid).length,
      "criteria were pinned and nothing verified them — the gate must still block",
    ).toBeGreaterThan(0)
  })

  it("DOES attach when the session actually changed files (discrimination)", async () => {
    // Without this, "never auto-attach" would satisfy the test above while
    // silently removing the feature.
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "realwork"
    await activate(hooks, sid, "implement the production database migration")
    await completeText(hooks, sid, "CRITERIA:\n1. the suite passes")
    await toolAfter(hooks, sid, "edit", { filePath: join(workDir, "src/service.ts") }, "updated")

    const out = { title: "bash", output: "ok  pkg  0.01s", metadata: { exit: 0 } }
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: sid, callID: "c2", args: { command: "npx vitest run" } } as never,
      out as never,
    )
    expect(out.output, "a real verifier after a real edit still mints").toMatch(/verification-receipt/)
  })
})

// ===========================================================================
// fetchVerifierTranscriptFields (gate.ts) wired through the REAL plugin here too
// — the fuller property-based coverage (last-assistant-not-last-user, turn
// window, both response shapes) lives in tests/v2/integration-verifier.test.ts;
// this confirms the same `messagesImpl` override on THIS file's own stub
// client is genuinely wired end to end, not dead code added but never
// exercised.
// ===========================================================================

describe("fetchVerifierTranscriptFields: messagesImpl override wired through this file's stub client", () => {
  it("lastResponse resolves to the parent's last assistant message, fetched via the messagesImpl override", async () => {
    process.env.VERTEX_VERIFIER = "1"
    const transcript = [
      { info: { id: "m1", role: "user" }, parts: [{ type: "text", text: "please finish" }] },
      { info: { id: "m2", role: "assistant" }, parts: [{ type: "text", text: "final assistant answer for the verifier to see" }] },
    ]
    const client = makeStubClient({
      promptText: (agent) =>
        agent === "vertex-verifier"
          ? '{"stories":[{"storyId":"S1","pass":true,"summary":"ok","items":[{"itemId":"A1","met":true,"note":"observed"}]}]}'
          : '{"multiStory":false}',
      messagesImpl: async () => ({ data: transcript, error: undefined }),
    })
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "plugin-verifier-transcript-session"

    // "fix a typo in the readme" matches TRIVIAL_ASK_RE, skipping the intake
    // classification subturn (see tests/v2/integration-verifier.test.ts's
    // identical setup helper for the same reasoning).
    await activate(hooks, sid, "fix a typo in the readme", { providerID: "minimax", id: "MiniMax-M3" })

    const planRaw = await hooks.tool!.elicify_vertex_plan_create!.execute!(
      { stories: [{ text: "the only story", acceptanceItems: ["criterion one"], scopeGlobs: [], verifiers: ["npx vitest run"], tasks: [{ text: "do the only story" }] }] } as never,
      { sessionID: sid } as never,
    )
    const plan = JSON.parse(planRaw as string) as { stories: Array<{ tasks: Array<{ id: string }> }> }
    const taskId = plan.stories[0].tasks[0].id

    await toolAfter(hooks, sid, "edit", { filePath: "src/foo.ts" }, "updated")
    const toolOutput = { title: "bash", output: "20 passed", metadata: { exit: 0 } }
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: sid, callID: "bash-1", args: { command: "npx vitest run" } } as never,
      toolOutput as never,
    )
    const receiptMatch = toolOutput.output.match(/\[vertex:verification-receipt\] (\S+)/)
    expect(receiptMatch).not.toBeNull()

    // Task-level completion claim (the receipt is still minted above by the
    // unchanged verification path; the checkpoint no longer cites it).
    await hooks.tool!.elicify_vertex_plan_checkpoint!.execute!(
      { taskId, status: "complete" } as never,
      { sessionID: sid } as never,
    )

    await idle(hooks, sid)

    const verifierCall = client.session.prompt.mock.calls
      .map((c) => c[0] as { body?: { agent?: string; parts?: Array<{ text?: string }> } })
      .find((c) => c.body?.agent === "vertex-verifier")
    expect(verifierCall, "the verifier subturn must have been invoked").toBeDefined()
    const payload = JSON.parse(verifierCall!.body!.parts![0]!.text!) as { lastResponse?: string }
    expect(payload.lastResponse).toBe("final assistant answer for the verifier to see")
  })
})

// ===========================================================================
// M4 (grill round 2) — the CRIT-002 backstop was inert.
//
// `chat.message` skips the turn reset while a continuation is in flight, so
// our own echo does not clobber the ledger. It did that with an unconditional
// `return`, placed ABOVE the `resetTurnState` that clears the flag. But
// `promptContinuation` deliberately does NOT release the flag on its timeout
// path, documenting that "the next real chat.message is the turn boundary
// that genuinely ends it" — a boundary the `return` made unreachable. One
// continuation that never settled therefore left the harness inert forever:
// every later user message short-circuited, silently.
// ===========================================================================
describe("M4: a real user message releases a stuck continuation guard", () => {
  async function chatMessage(hooks: Hooks, sessionID: string, text: string) {
    await hooks["chat.message"]!(
      { sessionID, agent: "elicify-vertex-agent" } as never,
      { message: { id: `msg-${sessionID}-${text.length}` } as never, parts: [{ type: "text", text } as never] },
    )
  }

  it("holds for our own echo, releases for a real message", async () => {
    // A continuation whose prompt NEVER settles — the timeout path, which
    // deliberately leaves `idleContinuationInFlight` set. This wedges the
    // guard through the real code path rather than by poking at state.
    const client = makeStubClient()
    client.session.prompt.mockImplementation(
      (args: { body?: { agent?: string } }) =>
        args?.body?.agent === undefined
          ? new Promise(() => {}) // gate continuation: hangs forever
          : Promise.resolve({ data: { info: {}, parts: [{ type: "text", text: '{"multiStory":false}' }] }, error: undefined }),
    )
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = `m4-guard-${Date.now().toString(36)}`

    await activate(hooks, sid, "build the reporting dashboard end to end")
    await hooks.tool!.elicify_vertex_plan_create!.execute!(
      { stories: [{ text: "ship it", acceptanceItems: ["A1"], scopeGlobs: [], verifiers: [], tasks: [{ text: "do the work" }] }] } as never,
      { sessionID: sid } as never,
    )
    await toolAfter(hooks, sid, "edit", { filePath: "src/report.ts" }, "updated")
    // The prompt never settles, so drive the gate's own 30s timeout — the
    // path that deliberately leaves the guard set — with fake timers, which
    // also keeps the pending handle from outliving the test.
    vi.useFakeTimers()
    const idling = idle(hooks, sid)
    await vi.advanceTimersByTimeAsync(31_000)
    await idling
    vi.useRealTimers()

    const dispatched = idleContinuationTexts(client, sid)
    expect(dispatched.length, "the idle gate never dispatched a continuation").toBeGreaterThan(0)
    const echo = dispatched[dispatched.length - 1]

    const releases = (): number =>
      readEvents().filter((e) => e.event_type === "gate:continuation-guard-released" && e.session_id === sid).length

    // Our own echo: the guard must hold, or the continuation clobbers the very
    // turn state it was dispatched to act on.
    await chatMessage(hooks, sid, echo)
    expect(releases()).toBe(0)

    // A genuine user message is the turn boundary that ends the continuation.
    // Before the fix the guard stayed set here and every later message
    // short-circuited — the harness inert for the rest of the session.
    await chatMessage(hooks, sid, "actually, do something else entirely")
    expect(releases()).toBe(1)

    // MAJ-1 (round 4): assert the guard is actually DOWN, not merely that the
    // event fired. A mutant that logs the release without clearing
    // `idleContinuationInFlight` left the suite green — every later message
    // would hit the guard again and log another release.
    await chatMessage(hooks, sid, "and one more thing")
    expect(releases()).toBe(1)
  })

  // MAJ-9 (round 4): the echo is identified by a one-shot consume, not by
  // matching text. A mutant that gates the consume on
  // `text.includes(lastContinuationText)` survives a test whose echo matches
  // exactly — so this one models a host that NORMALISES the echoed prompt
  // (trims it, re-wraps it, prefixes it). Under the mutant the guard releases
  // and the continuation clobbers the ledger it was dispatched to act on.
  it("consumes a normalised echo rather than treating it as user intent", async () => {
    const client = makeStubClient()
    client.session.prompt.mockImplementation(
      (args: { body?: { agent?: string } }) =>
        args?.body?.agent === undefined
          ? new Promise(() => {})
          : Promise.resolve({ data: { info: {}, parts: [{ type: "text", text: '{"multiStory":false}' }] }, error: undefined }),
    )
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = `m4-normalised-${Date.now().toString(36)}`

    await activate(hooks, sid, "build the reporting dashboard end to end")
    await hooks.tool!.elicify_vertex_plan_create!.execute!(
      { stories: [{ text: "ship it", acceptanceItems: ["A1"], scopeGlobs: [], verifiers: [], tasks: [{ text: "do the work" }] }] } as never,
      { sessionID: sid } as never,
    )
    await toolAfter(hooks, sid, "edit", { filePath: "src/report.ts" }, "updated")
    vi.useFakeTimers()
    const idling = idle(hooks, sid)
    await vi.advanceTimersByTimeAsync(31_000)
    await idling
    vi.useRealTimers()

    const dispatched = idleContinuationTexts(client, sid)
    expect(dispatched.length).toBeGreaterThan(0)
    const normalised = `> ${dispatched[dispatched.length - 1].trim().slice(0, 40)}…`

    const releases = (): number =>
      readEvents().filter((e) => e.event_type === "gate:continuation-guard-released" && e.session_id === sid).length
    await chatMessage(hooks, sid, normalised)
    expect(releases(), "a normalised echo must still be consumed, not treated as user intent").toBe(0)
  })
})

// ===========================================================================
// The TUI flood (2026-08-04, reported from a live session).
//
// `computeBoundedDiffStat` shells out to `git diff --stat` to build the
// verifier's payload. Node INHERITS a child's stderr by default for
// `execFileSync`, so that output goes straight to the terminal running
// opencode — past the TUI's renderer, which then draws over a frame it does
// not know was overwritten. Pointed at a directory that is not a git repo,
// `git diff` prints a warning plus its whole usage page (measured: 7,393
// bytes) and wrecked the display on every idle. The `catch` around the call
// swallowed the exception but never the output, so the event log stayed clean
// while the screen was destroyed.
//
// Asserted across a process boundary, because inherited stderr is only
// observable from the parent. The control case proves the test can fail.
// ===========================================================================
describe("child stderr never reaches the parent terminal", () => {
  const NON_REPO = mkdtempSync(join(tmpdir(), "vertex-nonrepo-"))

  /** Run one `git diff --stat` the way the harness does, return parent stderr. */
  function parentStderrFor(stdioOption: string): string {
    const script = `
      const { execFileSync } = require("node:child_process");
      try {
        execFileSync("git", ["diff", "--stat"], {
          cwd: ${JSON.stringify(NON_REPO)},
          encoding: "utf8",
          timeout: 5000,
          maxBuffer: 1048576,
          ${stdioOption}
        });
      } catch {}
    `
    const res = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" })
    return res.stderr ?? ""
  }

  it("control: without the stdio option, git floods the parent (the bug)", () => {
    // If this ever goes quiet, the assertion below has stopped proving anything.
    expect(parentStderrFor("").length).toBeGreaterThan(1000)
  })

  it("with stdio piped, nothing reaches the parent", () => {
    expect(parentStderrFor(`stdio: ["ignore", "pipe", "pipe"],`)).toBe("")
  })
})

// ===========================================================================
// The nudge's own echo must not refill the nudge budget.
//
// A continuation re-enters `chat.message` for the same session. If that path
// reset the evidence ledger, every nudge would restore its own budget and the
// per-turn cap could never bind — the stated-intent branch would nag forever.
// It holds because `chat.message` returns at the echo guard BEFORE
// `evidenceLedger.reset`. Asserted here rather than in gate.test.ts, whose
// harness has no `chat.message` to drive.
// ===========================================================================
// ===========================================================================
// CRIT-001 — the judgement takes a model call, and the user can speak during
// it. Clearing the timer cannot stop a judge already in flight, so without an
// epoch check the harness issues a user-authority instruction OVER the user's
// own message — the exact failure this whole feature exists to prevent,
// reappearing as a race instead of a phrasing bug.
// ===========================================================================
describe("pause judge — a message during the judgement cancels it", () => {
  it("does not nudge when the user speaks while the judge is in flight", async () => {
    vi.useFakeTimers()
    try {
      // The race, made deterministic: the user's message is delivered from
      // INSIDE the judge's own prompt call, i.e. exactly while the judgement
      // is in flight. Holding the promise across fake timers deadlocks, so
      // the interleaving is expressed this way instead.
      let userSpeaks: (() => Promise<void>) | null = null
      const client = makeStubClient()
      client.session.prompt.mockImplementation(async (args: { body?: { agent?: string } }) => {
        if (args?.body?.agent) {
          if (userSpeaks) await userSpeaks()
          return { data: { info: {}, parts: [{ type: "text", text: '{"verdict":"stopped-mid-work"}' }] }, error: undefined }
        }
        return { data: { info: {}, parts: [] }, error: undefined }
      })

      const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
      const sid = `race-${Math.random().toString(36).slice(2)}`

      await hooks["chat.message"]!(
        { sessionID: sid, agent: "elicify-vertex-agent", model: { providerID: "anthropic", modelID: "claude-opus-4" } } as never,
        { message: { id: "m1" } as never, parts: [{ type: "text", text: "/elicify-vertex\n\nbuild the portal" } as never] },
      )
      await hooks["experimental.text.complete"]!(
        { sessionID: sid, messageID: "m2", partID: "p1" } as never,
        { text: "Let me lay out the plan and execute." },
      )

      userSpeaks = async () => {
        await hooks["chat.message"]!(
          { sessionID: sid, agent: "elicify-vertex-agent" } as never,
          { message: { id: "m3" } as never, parts: [{ type: "text", text: "Actually forget that — what is Vite?" } as never] },
        )
      }

      await hooks.event!({ event: { type: "session.idle", properties: { sessionID: sid } } as never })
      await vi.advanceTimersByTimeAsync(70_000)
      await vi.advanceTimersByTimeAsync(1_000)

      const nudges = idleContinuationTexts(client, sid).filter((t) => t.includes("part-way through work"))
      expect(nudges, "the harness must not talk over the user's own turn").toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("pause judge — verdict decides, and failure is silent", () => {
  /** Drive one armed pause to expiry with a stubbed verifier reply. */
  async function runPause(judgeReply: string | null): Promise<{ nudges: number; events: string[] }> {
    vi.useFakeTimers()
    try {
      const client = makeStubClient()
      client.session.prompt.mockImplementation((args: { body?: { agent?: string } }) =>
        args?.body?.agent === "vertex-verifier" && judgeReply !== null
          ? Promise.resolve({ data: { info: {}, parts: [{ type: "text", text: judgeReply }] }, error: undefined })
          : args?.body?.agent
            ? Promise.reject(new Error("verifier unavailable"))
            : Promise.resolve({ data: { info: {}, parts: [] }, error: undefined }),
      )
      const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
      const sid = `pause-${Math.random().toString(36).slice(2)}`

      await hooks["chat.message"]!(
        { sessionID: sid, agent: "elicify-vertex-agent", model: { providerID: "anthropic", modelID: "claude-opus-4" } } as never,
        { message: { id: "m1" } as never, parts: [{ type: "text", text: "/elicify-vertex\n\nbuild the gaming portal" } as never] },
      )
      await hooks["experimental.text.complete"]!(
        { sessionID: sid, messageID: "m2", partID: "p1" } as never,
        { text: "Green-light this and I'll create the plan and start." },
      )
      await hooks.event!({ event: { type: "session.idle", properties: { sessionID: sid } } as never })
      await vi.advanceTimersByTimeAsync(90_000)
      await vi.runOnlyPendingTimersAsync()

      const nudges = idleContinuationTexts(client, sid).filter((t) => t.includes("part-way through work")).length
      return { nudges, events: readEvents().filter((e) => e.session_id === sid).map((e) => e.event_type) }
    } finally {
      vi.useRealTimers()
    }
  }

  // The exact case that misfired in the live session: a plan proposal waiting
  // for approval. The agent contract REQUIRES that pause, so nudging it told
  // the model to violate its own contract.
  it("stays silent on awaiting-user", async () => {
    const { nudges } = await runPause('{"verdict":"awaiting-user"}')
    expect(nudges).toBe(0)
  })

  it("nudges on stopped-mid-work", async () => {
    const { nudges } = await runPause('{"verdict":"stopped-mid-work"}')
    expect(nudges).toBe(1)
  })

  it("stays silent when the verdict is unreadable", async () => {
    const { nudges } = await runPause("I think it is probably waiting?")
    expect(nudges).toBe(0)
  })

  it("stays silent when the judge is unavailable", async () => {
    const { nudges } = await runPause(null)
    expect(nudges).toBe(0)
  })
})

// ===========================================================================
// B-2: the two families whose measured compliance was UNDECIDABLE.
//
//  - `scope-watchdog` reported "3 rendered, 0 complied" in the field. That 0
//    was structural: no `recordCompliance(…, "scope-watchdog", …)` call
//    existed anywhere, so the counter would have read 0 under perfect
//    compliance too. The directive's "fold / amend / revert" offer also named
//    three things no tool could do — `StoryEngine.amendStory` was exposed by
//    nothing.
//  - `intake-scaffold` reported "9 rendered, 0 complied", and a parse miss
//    (a `CRITERIA:` line the grammar could not read) was SILENT, so that 0
//    could not be read as "the model ignored the directive".
// ===========================================================================

describe("B-2: scope-watchdog compliance is actually recorded", () => {
  async function planWithScope(hooks: Hooks, sid: string): Promise<string> {
    const plan = await hooks.tool!.elicify_vertex_plan_create!.execute!(
      {
        stories: [
          {
            text: "narrow story",
            acceptanceItems: ["A1"],
            scopeGlobs: ["src/in-scope/**"],
            verifiers: [],
            tasks: [{ text: "do the work" }],
          },
        ],
      } as never,
      { sessionID: sid } as never,
    )
    return (JSON.parse(plan as string) as { stories: Array<{ id: string }> }).stories[0].id
  }

  function complianceEvents(sid: string) {
    return readEvents().filter(
      (e) => e.event_type === "directive_complied" && e.session_id === sid && e.payload.family === "scope-watchdog",
    )
  }

  it("logs directive_complied for scope-watchdog when the model folds the file into the story's scope", async () => {
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "b2-scope-fold-session"

    await activate(hooks, sid, "refactor the auth database migration end to end")
    const storyId = await planWithScope(hooks, sid)
    // An edit outside the declared scope — this is what raises the watchdog.
    await toolAfter(hooks, sid, "edit", { filePath: "src/elsewhere/foo.ts" }, "updated")
    await transform(hooks, sid)
    expect(complianceEvents(sid)).toHaveLength(0)

    const result = await hooks.tool!.elicify_vertex_scope_amend!.execute!(
      { storyId, resolution: "fold", reason: "the helper genuinely belongs to this story", scopeGlobs: ["src/elsewhere/**"] } as never,
      { sessionID: sid } as never,
    )

    // Pre-fix this was 0 no matter what the model did.
    expect(complianceEvents(sid)).toHaveLength(1)
    expect(JSON.parse(result as string).scopeGlobs).toEqual(["src/in-scope/**", "src/elsewhere/**"])
  })

  it("records compliance for a revert too — undoing the change is one of the three prescribed answers", async () => {
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "b2-scope-revert-session"

    await activate(hooks, sid, "refactor the auth database migration end to end")
    const storyId = await planWithScope(hooks, sid)
    await hooks.tool!.elicify_vertex_scope_amend!.execute!(
      { storyId, resolution: "revert", reason: "undid the stray edit to src/elsewhere/foo.ts" } as never,
      { sessionID: sid } as never,
    )

    expect(complianceEvents(sid)).toHaveLength(1)
    // A revert leaves the declared scope alone — it did not need widening.
    const plan = JSON.parse((await hooks.tool!.elicify_vertex_plan_status!.execute!({} as never, { sessionID: sid } as never)) as string)
    expect(plan.stories[0].scopeGlobs).toEqual(["src/in-scope/**"])
    expect(plan.stories[0].amendments).toHaveLength(1)
  })

  it("the rendered scope-watchdog directive names the tool that resolves it", async () => {
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "b2-scope-directive-session"

    await activate(hooks, sid, "refactor the auth database migration end to end")
    await planWithScope(hooks, sid)
    await toolAfter(hooks, sid, "edit", { filePath: "src/elsewhere/foo.ts" }, "updated")
    const out = await transform(hooks, sid)

    expect(out.system.join("\n")).toContain("elicify_vertex_scope_amend")
  })
})

describe("B-2: an unreadable CRITERIA block is logged instead of vanishing", () => {
  function parseMisses(sid: string) {
    return readEvents().filter((e) => e.event_type === "criteria:parse-miss" && e.session_id === sid)
  }

  it("logs criteria:parse-miss when the model writes a CRITERIA line the grammar cannot read", async () => {
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "b2-parse-miss-session"

    await activate(hooks, sid, "implement the parser feature")
    await completeText(hooks, sid, "CRITERIA: it should all just work\n\nOn with the code.")

    // Pre-fix: nothing pinned, nothing logged, and the scaffold re-offered
    // forever with the compliance count stuck at 0 for no discoverable reason.
    const misses = parseMisses(sid)
    expect(misses).toHaveLength(1)
    expect(misses[0].payload.keyLine).toBe("CRITERIA: it should all just work")
  })

  it("logs it ONCE per turn, not once per text part — and re-opens on the next turn", async () => {
    // B-2 follow-up (FIX 5). `text.complete` fires per assistant TEXT PART,
    // and a model that writes an unreadable `CRITERIA:` line repeats it in
    // every part of the same reply: measured, 12 parts -> 12 identical
    // events. Its sibling `expect:absent` has had a per-turn guard since it
    // was written (`state.expectAbsentLoggedThisTurn`); this one did not.
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "b2f-parse-miss-flood-session"

    await activate(hooks, sid, "implement the parser feature")
    for (let part = 0; part < 12; part++) {
      await completeText(hooks, sid, `CRITERIA: part ${part} should all just work`)
    }
    expect(parseMisses(sid), "pre-fix: 12").toHaveLength(1)

    // A real user message is a new turn, and the next turn's miss is a new
    // fact about the model's behaviour — the guard must not silence it for
    // the rest of the session (that is the failure mode B-2's own event was
    // introduced to end).
    await activate(hooks, sid, "try again please")
    await completeText(hooks, sid, "CRITERIA: still not a list")
    expect(parseMisses(sid)).toHaveLength(2)
  })

  it("stays silent when the model simply never mentioned criteria", async () => {
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "b2-no-criteria-session"

    await activate(hooks, sid, "implement the parser feature")
    await completeText(hooks, sid, "Here is what I changed and why.")

    expect(parseMisses(sid)).toHaveLength(0)
  })

  it("a BULLETED answer now pins, records intake-scaffold compliance, and logs no parse miss", async () => {
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "b2-bullet-criteria-session"

    await activate(hooks, sid, "implement the parser feature")
    await completeText(hooks, sid, "CRITERIA:\n- parser handles nesting\n- errors point at the inner token")

    expect(parseMisses(sid)).toHaveLength(0)
    const complied = readEvents().filter(
      (e) => e.event_type === "directive_complied" && e.session_id === sid && e.payload.family === "intake-scaffold",
    )
    expect(complied).toHaveLength(1)
    // ...and the scaffold stops firing, because the pin store is no longer empty.
    const out = await transform(hooks, sid)
    expect(out.system.join("\n")).not.toContain("OUTCOME:")
  })
})

// ===========================================================================
// FIX 2 — the SECOND turn boundary.
//
// `resetTurnState` is reached from `chat.message`'s activation branch and from
// nowhere else. `wiring/gate.ts` opens a turn too, with `composer.newTurn(sid)`
// and nothing else. So every once-per-turn flag that lived in wiring state was
// still spent on a continuation turn, and in an unattended run — where the
// continuation loop IS the only turn boundary that ever arrives — the harness
// recorded these two events exactly once for the whole session.
//
// Both events exist to make a model behaviour DECIDABLE from the log. A
// dedupe guard that silences every turn but the first does not reduce noise,
// it removes the measurement.
// ===========================================================================

describe("FIX 2: once-per-turn log guards re-open on a gate continuation turn", () => {
  function parseMisses(sid: string) {
    return readEvents().filter((e) => e.event_type === "criteria:parse-miss" && e.session_id === sid)
  }
  function expectAbsents(sid: string) {
    return readEvents().filter((e) => e.event_type === "expect:absent" && e.session_id === sid)
  }

  it("criteria:parse-miss is recorded again after a continuation, with no chat.message in between", async () => {
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "fix2-parse-miss-continuation"

    // A DEEP ask: the zero-criteria stop-block is the continuation this test
    // needs, and it is scoped to deep mode.
    await activate(hooks, sid, "implement the production database migration")
    await completeText(hooks, sid, "CRITERIA: it should all just work")
    expect(parseMisses(sid), "turn 1's miss").toHaveLength(1)
    // Same turn, more text parts: still one. The dedupe itself must survive.
    await completeText(hooks, sid, "CRITERIA: it should all just work")
    expect(parseMisses(sid)).toHaveLength(1)

    // Unverified mutation + idle -> the gate dispatches a continuation, which
    // calls `composer.newTurn(sid)` and never reaches `resetTurnState`.
    await toolAfter(hooks, sid, "edit", { filePath: "src/foo.ts" }, "updated")
    await idle(hooks, sid)
    expect(idleContinuationTexts(client, sid).length).toBeGreaterThan(0)

    // The new turn's unreadable CRITERIA line is a NEW fact about the model.
    // Pre-fix: still 1, for the rest of the session.
    await completeText(hooks, sid, "CRITERIA: still not a list")
    expect(parseMisses(sid)).toHaveLength(2)
    expect(parseMisses(sid)[1].payload.keyLine).toBe("CRITERIA: still not a list")

    // ...and the guard is still a guard within THAT turn.
    await completeText(hooks, sid, "CRITERIA: still not a list")
    expect(parseMisses(sid)).toHaveLength(2)
  })

  it("expect:absent is recorded again after a continuation, with no chat.message in between", async () => {
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "fix2-expect-absent-continuation"

    await activate(hooks, sid, "implement the production database migration")
    await toolAfter(hooks, sid, "edit", { filePath: "src/foo.ts" }, "updated")

    // A FAILING verifier: it still runs the EXPECT comparison, but leaves the
    // ledger unverified so the zero-criteria fallback can fire below.
    await toolAfter(hooks, sid, "bash", { command: "npx vitest run" }, "1 failed", { exit: 1 })
    expect(expectAbsents(sid), "turn 1's missing EXPECT").toHaveLength(1)
    await toolAfter(hooks, sid, "bash", { command: "npx vitest run" }, "1 failed", { exit: 1 })
    expect(expectAbsents(sid), "deduped within the turn").toHaveLength(1)

    await idle(hooks, sid)
    expect(idleContinuationTexts(client, sid).length).toBeGreaterThan(0)

    // Pre-fix: still 1. The whole point of the event is "how often does the
    // model verify without declaring an expectation" — unanswerable if it is
    // recorded once per SESSION.
    await toolAfter(hooks, sid, "bash", { command: "npx vitest run" }, "1 failed", { exit: 1 })
    expect(expectAbsents(sid)).toHaveLength(2)
    await toolAfter(hooks, sid, "bash", { command: "npx vitest run" }, "1 failed", { exit: 1 })
    expect(expectAbsents(sid)).toHaveLength(2)
  })

  it("a real user message still re-opens both — the ordinary boundary is untouched", async () => {
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "fix2-ordinary-boundary"

    await activate(hooks, sid, "implement the parser feature")
    await completeText(hooks, sid, "CRITERIA: it should all just work")
    await toolAfter(hooks, sid, "bash", { command: "npx vitest run" }, "1 failed", { exit: 1 })
    expect(parseMisses(sid)).toHaveLength(1)
    expect(expectAbsents(sid)).toHaveLength(1)

    await activate(hooks, sid, "try again please")
    await completeText(hooks, sid, "CRITERIA: still not a list")
    await toolAfter(hooks, sid, "bash", { command: "npx vitest run" }, "1 failed", { exit: 1 })
    expect(parseMisses(sid)).toHaveLength(2)
    expect(expectAbsents(sid)).toHaveLength(2)
  })
})

// ===========================================================================
// FIX 1 / FR-061 — `directive:starved`, END TO END, on the DEFAULT cap table.
//
// The old detector was a per-invocation drop RATE with a floor of 5 attempted
// findings, and the drops it counted were per-turn-cap drops from producers
// re-minting findings the composer had already committed to discarding. It
// therefore read loudest when the harness was working correctly, and once the
// producers learned to ask `blockedBeforeBudget` first it could not fire at
// all: measured over the 78-invocation differential that signed the gating
// off, max `attempted` fell from 5 to 4, permanently under its own floor. It
// had no test, which is why nothing caught it.
//
// The scenario below uses NO configuration overrides — the shipped cap table,
// the shipped budget of 2 — which is the property that makes the re-based
// signal a live detector rather than another one that only fires on paper.
// ===========================================================================

describe("FR-061: directive:starved reports a family a whole turn never delivered", () => {
  const NARROW_STORY_FR061 = {
    stories: [
      {
        text: "narrow story",
        acceptanceItems: ["A1"],
        scopeGlobs: ["src/in-scope/**"],
        verifiers: ["npx vitest run"],
        tasks: [{ text: "do the work" }],
      },
    ],
  }

  function clientWithToast() {
    const showToast = vi.fn(async (_opts: { body: { message: string } }) => ({ data: true, error: undefined }))
    const client = makeStubClient()
    ;(client as unknown as { tui: unknown }).tui = { showToast }
    return { client, showToast }
  }

  /**
   * One busy turn on the default cap table:
   *   step 1  verify-gap + scope-watchdog  (two corrections)
   *   step 2  verify-gap + intake-scaffold (scope-watchdog's cap is spent)
   *   step 3  verify-gap + repeat-failure  (the scaffold's cap is spent)
   * Three invocations, both slots taken every time, and the enrichment behind
   * them — the post-compaction criteria re-injection — never gets through.
   */
  async function busyTurn(hooks: Hooks, sid: string, opts: { compacted: boolean }) {
    await activate(hooks, sid, "implement the production database migration")
    await hooks.tool!.elicify_vertex_plan_create!.execute!(NARROW_STORY_FR061 as never, { sessionID: sid } as never)
    if (opts.compacted) {
      await hooks.event!({ event: { type: "session.compacted", properties: { sessionID: sid } } as never })
    }
    for (let step = 0; step < 3; step++) {
      await toolAfter(hooks, sid, "edit", { filePath: `src/elsewhere/step-${step}.ts` }, "updated")
      if (step === 2) {
        // Same signature twice -> the repeat-failure correction arms, holding
        // the second slot on the invocation where the scaffold's cap is gone.
        await toolAfter(hooks, sid, "bash", { command: "npx vitest run" }, "AssertionError: boom", { exit: 1 })
        await toolAfter(hooks, sid, "bash", { command: "npx vitest run" }, "AssertionError: boom", { exit: 1 })
      }
      await transform(hooks, sid)
    }
  }

  function starvedEvents(sid: string) {
    return readEvents().filter((e) => e.event_type === "directive:starved" && e.session_id === sid)
  }

  it("fires for pinned-criteria-reinject, at the turn boundary, with the default caps", async () => {
    const { client, showToast } = clientWithToast()
    // A busy turn renders six directives before the boundary, which is exactly
    // FR-063's default toast budget for a minute — so the toast under test
    // would be suppressed by the rate limiter, not by the detector. Raise the
    // cap so this test measures FR-061 and not FR-063.
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), { maxToastsPerMinute: 100 } as never)
    const sid = `fr061-starved-${Math.random().toString(36).slice(2)}`

    await busyTurn(hooks, sid, { compacted: true })

    const mine = readEvents().filter((e) => e.session_id === sid)
    const family = (e: LoggedEvent) => String((e.payload as { family?: string }).family)
    const count = (type: string, fam: string) => mine.filter((e) => e.event_type === type && family(e) === fam).length

    // NON-VACUITY: the families that took the slots really did reach the
    // model. Without this the test could "pass" on a turn where nothing was
    // produced at all.
    expect(count("directive_rendered", "verify-gap"), "verify-gap held a slot each step").toBe(3)
    expect(count("directive_rendered", "scope-watchdog")).toBe(1)
    expect(count("directive_rendered", "intake-scaffold")).toBe(1)
    // ...and the victim was offered every invocation and never once rendered.
    expect(count("budget:dropped", "pinned-criteria-reinject")).toBe(3)
    expect(count("directive_rendered", "pinned-criteria-reinject")).toBe(0)

    // Mid-turn the harness stays quiet: the next invocation could still
    // deliver it, so calling it starved before the turn ends would be a guess.
    expect(starvedEvents(sid), "nothing reported while the turn is still open").toHaveLength(0)

    // The next user message closes the turn. NOW the verdict is decidable.
    await activate(hooks, sid, "carry on then")
    const starved = starvedEvents(sid)
    expect(starved).toHaveLength(1)
    expect(starved[0].payload.family).toBe("pinned-criteria-reinject")
    expect(starved[0].payload.budgetDrops).toBe(3)
    expect(starved[0].payload.turnIndex).toBe(1)

    // FR-061's own requirement: it reaches the operator as a warning toast.
    // That is carried by the first render of the following turn.
    showToast.mockClear()
    await transform(hooks, sid)
    const toasts = showToast.mock.calls.map((c) => JSON.stringify(c[0]))
    const starvationToast = toasts.find((t) => t.includes("pinned-criteria-reinject") && t.includes("never reached"))
    expect(starvationToast, `no starvation toast in: ${toasts.join(" | ")}`).toBeDefined()
    expect(starvationToast).toContain("warning")

    // Handed over exactly once — a later invocation must not re-toast it.
    showToast.mockClear()
    await transform(hooks, sid)
    expect(showToast.mock.calls.map((c) => JSON.stringify(c[0])).join("|")).not.toContain("never reached")
  })

  it("stays silent on the same busy turn when the directive is not actually being starved", async () => {
    // Byte-for-byte the same pressure, minus the compaction. Nothing is
    // waiting behind the budget, so nothing is starved — this is the control
    // that stops the detector from simply reporting "busy turn".
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = `fr061-control-${Math.random().toString(36).slice(2)}`

    await busyTurn(hooks, sid, { compacted: false })
    await activate(hooks, sid, "carry on then")

    expect(starvedEvents(sid)).toHaveLength(0)
  })

  it("stays silent for a family whose offers are dropped by the per-turn CAP, however many", async () => {
    // The old detector's loudest case, and the reason it had to be re-based:
    // `plan-proposal` has a cap of 1 and an ungated producer, so once it has
    // rendered every later offer is a cap drop — which means the model HAS
    // been told. Counting those is what made the signal read highest when the
    // harness was working exactly as designed.
    const client = makeStubClient({ promptText: () => '{"multiStory":true}' })
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = `fr061-capdrops-${Math.random().toString(36).slice(2)}`

    await activate(hooks, sid, "implement the production database migration")
    for (let step = 0; step < 12; step++) {
      await toolAfter(hooks, sid, "read", { filePath: `src/step-${step}.ts` }, "contents")
      await transform(hooks, sid)
    }
    await activate(hooks, sid, "carry on then")

    const mine = readEvents().filter((e) => e.session_id === sid)
    const family = (e: LoggedEvent) => String((e.payload as { family?: string }).family)
    // NON-VACUITY: the cap drops this asserts about really happened.
    expect(
      mine.filter((e) => e.event_type === "per-turn-cap:dropped" && family(e) === "plan-proposal").length,
      "plan-proposal must really be cap-dropping here",
    ).toBeGreaterThanOrEqual(5)
    expect(mine.filter((e) => e.event_type === "directive_rendered" && family(e) === "plan-proposal")).toHaveLength(1)

    expect(starvedEvents(sid)).toHaveLength(0)
  })
})

// ===========================================================================
// THE FROZEN TURN BOUNDARY.
//
// `composer.newTurn(sid)` used to live INSIDE `chat.message`'s activation
// branch. A session activated by trigger text (or by `/elicify-vertex`) under
// a non-default agent takes that branch exactly once — on the activating
// message. Every ordinary follow-up afterwards carries the same non-default
// agent (or no agent at all), matches neither the activation nor the
// deactivation condition, and so advanced nothing. The turn index froze at 1
// for the rest of the session, and with it every per-turn cap, every
// cooldown, every `claimOncePerTurn` latch, and the FR-061 starvation verdict
// — which is reached in `advanceTurn` and therefore could not even report the
// silence it was measuring.
//
// Measured, one session, 16 hook invocations, identical worktree: activation
// by trigger under agent "build" then three ordinary follow-ups.
//   frozen:  turnIndex [1],     verify-gap 3, scope-watchdog 1  ->  5 rendered
//   fixed:   turnIndex [1,2,3], verify-gap 9, scope-watchdog 3  -> 15 rendered
// Volume stays bounded by the cap table (5 per turn: verify-gap 3 +
// scope-watchdog 1 + intake-scaffold 1) and `per-turn-cap:dropped` stays at 0.
// ===========================================================================

describe("the turn boundary is every prompt, not only an activating one", () => {
  /** A `chat.message` under a caller-chosen agent — `activate()` above always
   * uses the DEFAULT agent, which is exactly why the defect survived it. */
  async function messageAs(hooks: Hooks, sessionID: string, text: string, agent: string | undefined) {
    await hooks["chat.message"]!(
      { sessionID, agent } as never,
      {
        message: { id: `msg_${sessionID}_${Math.random().toString(36).slice(2)}` } as never,
        parts: [{ type: "text", text } as never],
      },
    )
  }

  function renderedTurnIndexes(sid: string): number[] {
    return [
      ...new Set(
        readEvents()
          .filter((e) => e.event_type === "directive_rendered" && e.session_id === sid)
          .map((e) => Number(e.payload.turnIndex)),
      ),
    ]
  }

  function renderCount(sid: string, family: string): number {
    return readEvents().filter(
      (e) => e.event_type === "directive_rendered" && e.session_id === sid && e.payload.family === family,
    ).length
  }

  function withTestScript() {
    writeFileSync(
      join(workDir, "package.json"),
      JSON.stringify({ name: "fixture", private: true, scripts: { test: "vitest run" } }),
    )
  }

  /** Trigger-activated under "build", then three ordinary follow-ups whose
   * agent is chosen by the caller. Each turn makes one out-of-scope,
   * unverified mutation and renders three times — the busy shape. */
  async function triggerActivatedSession(
    hooks: Hooks,
    sid: string,
    followUpAgent: string | undefined,
  ): Promise<void> {
    // A package script so `resolveVerifier` can name a command — the
    // verify-gap producer stays silent when it cannot (redesign point 7).
    withTestScript()
    await messageAs(hooks, sid, "/elicify-vertex refactor the auth database migration end to end", "build")
    await hooks.tool!.elicify_vertex_plan_create!.execute!(
      {
        stories: [
          {
            text: "parser work",
            acceptanceItems: ["A1"],
            scopeGlobs: ["src/parser/**"],
            verifiers: [],
            tasks: [{ text: "do the parser work" }],
          },
        ],
      } as never,
      { sessionID: sid } as never,
    )
    for (let turn = 1; turn <= 3; turn++) {
      await toolAfter(hooks, sid, "edit", { filePath: `src/cli-${turn}.ts` }, "updated")
      await transform(hooks, sid)
      await transform(hooks, sid)
      await transform(hooks, sid)
      await messageAs(hooks, sid, `follow-up ${turn}`, followUpAgent)
    }
  }

  it("an ordinary follow-up under the SAME non-default agent advances the turn", async () => {
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = `turnfreeze-build-${Math.random().toString(36).slice(2)}`

    await triggerActivatedSession(hooks, sid, "build")

    // Pre-fix this was [1] — the whole session on one turn index.
    expect(renderedTurnIndexes(sid), "the turn index must advance on every prompt").toEqual([1, 2, 3])
    // ...and the delivery that freezing cost. Pre-fix: 3 and 1.
    expect(renderCount(sid, "verify-gap"), "cap 3 per turn, three turns").toBe(9)
    expect(renderCount(sid, "scope-watchdog"), "cap 1 per turn, three turns").toBe(3)

    // BOUNDED, not merely larger: every family stays inside its cap table
    // entry, so nothing here is a directive flood.
    const capDrops = readEvents().filter((e) => e.event_type === "per-turn-cap:dropped" && e.session_id === sid)
    expect(capDrops, "producers still ask blockedBeforeBudget first").toHaveLength(0)
    const perTurn = new Map<string, number>()
    for (const e of readEvents().filter((x) => x.event_type === "directive_rendered" && x.session_id === sid)) {
      const key = `${e.payload.turnIndex}/${e.payload.family}`
      perTurn.set(key, (perTurn.get(key) ?? 0) + 1)
    }
    expect(perTurn.get("1/scope-watchdog")).toBe(1)
    expect(perTurn.get("2/scope-watchdog")).toBe(1)
    expect(perTurn.get("1/verify-gap")).toBe(3)
    expect(perTurn.get("2/verify-gap")).toBe(3)
  })

  it("a follow-up carrying NO agent field advances the turn", async () => {
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = `turnfreeze-noagent-${Math.random().toString(36).slice(2)}`

    await triggerActivatedSession(hooks, sid, undefined)

    expect(renderedTurnIndexes(sid)).toEqual([1, 2, 3])
    expect(renderCount(sid, "verify-gap")).toBe(9)
  })

  it("the harness's own continuation echo does NOT advance the turn", async () => {
    // The echo is consumed and returns above the boundary. If the advance
    // were placed before that consume, the gate's own `newTurn` at dispatch
    // plus the echo would count ONE reply cycle as two turns — halving every
    // per-turn cap in exactly the unattended loop the caps exist to pace.
    const client = makeStubClient()
    client.session.prompt.mockImplementation(
      (args: { body?: { agent?: string } }) =>
        args?.body?.agent === undefined
          ? new Promise(() => {}) // the gate continuation hangs, as on a real host
          : Promise.resolve({
              data: { info: {}, parts: [{ type: "text", text: '{"multiStory":false}' }] },
              error: undefined,
            }),
    )
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = `turnfreeze-echo-${Math.random().toString(36).slice(2)}`

    withTestScript()
    await messageAs(hooks, sid, "/elicify-vertex refactor the auth database migration end to end", "build")
    await toolAfter(hooks, sid, "edit", { filePath: "src/report.ts" }, "updated")
    await transform(hooks, sid)
    expect(renderedTurnIndexes(sid), "turn 1").toEqual([1])

    vi.useFakeTimers()
    const idling = idle(hooks, sid)
    await vi.advanceTimersByTimeAsync(31_000)
    await idling
    vi.useRealTimers()

    const dispatched = idleContinuationTexts(client, sid)
    expect(dispatched.length, "the idle gate never dispatched a continuation").toBeGreaterThan(0)

    // The gate already advanced the turn at dispatch (1 -> 2). The reentrant
    // `chat.message` it causes must add nothing.
    await messageAs(hooks, sid, dispatched[dispatched.length - 1], "build")
    expect(
      readEvents().filter((e) => e.event_type === "gate:continuation-echo-consumed" && e.session_id === sid),
      "the echo must be recognised as one",
    ).toHaveLength(1)

    await toolAfter(hooks, sid, "edit", { filePath: "src/report2.ts" }, "updated")
    await transform(hooks, sid)
    // Exactly ONE advance for the whole continuation cycle: 2, never 3.
    expect(renderedTurnIndexes(sid), "dispatch advanced once; the echo added nothing").toEqual([1, 2])
  })

  it("a message on a session the harness is not active in advances nothing", async () => {
    // The `state.active || activatesThisMessage` guard. Without it a session
    // that switched away to an unrelated agent keeps burning turn indexes on
    // messages the harness has no part in, and every never-activated session
    // in the host allocates composer state.
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = `turnfreeze-inactive-${Math.random().toString(36).slice(2)}`

    withTestScript()
    await messageAs(hooks, sid, "/elicify-vertex refactor the auth database migration end to end", "build")
    await toolAfter(hooks, sid, "edit", { filePath: "src/a.ts" }, "updated")
    await transform(hooks, sid)
    expect(renderedTurnIndexes(sid)).toEqual([1])

    // Switch away to an unrelated agent: this message IS a boundary for the
    // session that was still active when it arrived (turn 1 -> 2), and it
    // deactivates.
    await messageAs(hooks, sid, "unrelated work now", "plan")
    // Three messages the harness is not part of. None of them is a turn.
    await messageAs(hooks, sid, "still unrelated", "plan")
    await messageAs(hooks, sid, "and more", "plan")
    await messageAs(hooks, sid, "and more again", "plan")

    // Back to the harness: the next turn is 3, not 6.
    await activate(hooks, sid, "carry on with the migration")
    await toolAfter(hooks, sid, "edit", { filePath: "src/b.ts" }, "updated")
    await transform(hooks, sid)
    expect(renderedTurnIndexes(sid), "inactive messages must not burn turn indexes").toEqual([1, 3])
  })

  it("FR-061's starvation verdict is reached at a non-default-agent boundary too", async () => {
    // The compounding half of the defect: the detector runs in `advanceTurn`,
    // so a frozen turn silenced the one signal that would have reported the
    // freeze. Same pressure as the FR-061 suite above, closed by the follow-up
    // shape that used to advance nothing.
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = `turnfreeze-fr061-${Math.random().toString(36).slice(2)}`

    await messageAs(hooks, sid, "/elicify-vertex implement the production database migration", "build")
    await hooks.tool!.elicify_vertex_plan_create!.execute!(
      {
        stories: [
          {
            text: "narrow story",
            acceptanceItems: ["A1"],
            scopeGlobs: ["src/in-scope/**"],
            verifiers: ["npx vitest run"],
            tasks: [{ text: "do the work" }],
          },
        ],
      } as never,
      { sessionID: sid } as never,
    )
    await hooks.event!({ event: { type: "session.compacted", properties: { sessionID: sid } } as never })
    for (let step = 0; step < 3; step++) {
      await toolAfter(hooks, sid, "edit", { filePath: `src/elsewhere/step-${step}.ts` }, "updated")
      if (step === 2) {
        await toolAfter(hooks, sid, "bash", { command: "npx vitest run" }, "AssertionError: boom", { exit: 1 })
        await toolAfter(hooks, sid, "bash", { command: "npx vitest run" }, "AssertionError: boom", { exit: 1 })
      }
      await transform(hooks, sid)
    }

    const starved = () => readEvents().filter((e) => e.event_type === "directive:starved" && e.session_id === sid)
    expect(starved(), "still open mid-turn").toHaveLength(0)

    // An ORDINARY follow-up under the same non-default agent. Pre-fix this
    // reported nothing, ever.
    await messageAs(hooks, sid, "carry on then", "build")
    expect(starved()).toHaveLength(1)
    expect(starved()[0].payload.family).toBe("pinned-criteria-reinject")
    expect(starved()[0].payload.turnIndex).toBe(1)
  })
})
