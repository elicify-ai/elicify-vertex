import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import type { Agent } from "@opencode-ai/sdk"

import { ElicifyVertexPlugin } from "../../src/index.js"
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
  workDir = mkdtempSync(join(tmpdir(), "vertex-v2-plugin-test-"))
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

async function transform(hooks: Hooks, sessionID: string): Promise<{ system: string[] }> {
  const out = { system: [] as string[] }
  await hooks["experimental.chat.system.transform"]!(
    { sessionID, model: { providerID: "anthropic", id: "claude-fable-5" } as never },
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

  it("a receipt surfaced via tool output round-trips as a valid checkpoint receiptId", async () => {
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "receipt-checkpoint-session"

    await activate(hooks, sid, "refactor the auth database migration end to end")
    await toolAfter(hooks, sid, "edit", { filePath: "src/foo.ts" }, "updated")

    // Plan must exist (and the story must have started) BEFORE the
    // verifying command runs — isFreshReceipt (tools.ts) correctly rejects a
    // receipt observed earlier than the story's own startedAt (FR-020: a
    // receipt must not predate the story it's evidence for).
    const plan = await hooks.tool!.elicify_vertex_plan_create!.execute!(
      { stories: [{ text: "do it", acceptanceItems: ["A1"], scopeGlobs: [], verifiers: [] }] } as never,
      { sessionID: sid } as never,
    )
    const storyId = JSON.parse(plan as string).stories[0].id
    const itemId = JSON.parse(plan as string).stories[0].acceptanceItems[0].id

    const toolOutput = { title: "bash", output: "20 passed", metadata: { exit: 0 } }
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: sid, callID: "bash-1", args: { command: "npx vitest run" } } as never,
      toolOutput as never,
    )
    const match = toolOutput.output.match(/\[vertex:verification-receipt\] (\S+)/)
    expect(match).not.toBeNull()
    const receiptId = match![1]

    const checkpointResult = await hooks.tool!.elicify_vertex_plan_checkpoint!.execute!(
      { storyId, status: "complete", items: [{ id: itemId, receiptId }] } as never,
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
      .filter((text: string) => text.includes("vertex:promise-no-act"))
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

describe("test 52: kill_switch_restores_v1", () => {
  it("VERTEX_V2=0 makes src/plugin.ts's server behaviourally identical to importing ElicifyVertexPlugin directly, and touches no .elicify-vertex/ file", async () => {
    process.env.VERTEX_V2 = "0"

    const promptA = vi.fn(async () => ({}))
    const promptB = vi.fn(async () => ({}))
    const inputA = { client: { session: { prompt: promptA } }, directory: workDir, worktree: workDir } as unknown as PluginInput
    const inputB = { client: { session: { prompt: promptB } }, directory: workDir, worktree: workDir } as unknown as PluginInput

    const hooksFromSwitch = await server(inputA, undefined)
    const hooksFromV1Direct = await ElicifyVertexPlugin(inputB, undefined)

    const sid = "kill-switch-session"
    for (const hooks of [hooksFromSwitch, hooksFromV1Direct]) {
      await activate(hooks as Hooks, sid, "implement the production database migration")
      await toolAfter(hooks as Hooks, sid, "edit", { filePath: "src/baz.ts" }, "updated")
      await idle(hooks as Hooks, sid)
    }

    expect(promptA.mock.calls.length).toBe(promptB.mock.calls.length)
    expect(promptA.mock.calls.length).toBeGreaterThan(0)
    const bodyA = (promptA.mock.calls[0] as unknown as [{ body: { parts: Array<{ text: string }> } }])[0].body
    const bodyB = (promptB.mock.calls[0] as unknown as [{ body: { parts: Array<{ text: string }> } }])[0].body
    expect(bodyA.parts[0].text).toBe(bodyB.parts[0].text)

    expect(existsSync(join(workDir, ".elicify-vertex"))).toBe(false)
  })

  it("plugin option engine:'v1' has the same effect as the env var", async () => {
    const prompt = vi.fn(async () => ({}))
    const input = { client: { session: { prompt } }, directory: workDir, worktree: workDir } as unknown as PluginInput
    const hooks = await server(input, { engine: "v1" })
    const sid = "engine-option-session"
    await activate(hooks, sid, "implement the production database migration")
    await toolAfter(hooks, sid, "edit", { filePath: "src/qux.ts" }, "updated")
    await idle(hooks, sid)
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(existsSync(join(workDir, ".elicify-vertex"))).toBe(false)
  })
})
