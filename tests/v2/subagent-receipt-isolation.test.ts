import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import type { Agent } from "@opencode-ai/sdk"

import { ElicifyVertexPluginV2 } from "../../src/v2/plugin.js"

// ===========================================================================
// docs/CODE-ISSUES-FROM-PROMPT-AUDIT.md, C-4 — "Subagents cannot mint
// receipts, and nothing says so."
//
// `tool.execute.after` (src/v2/plugin.ts, ~L597-601) returns early at
//   const state = states.get(sid); if (!state || !state.active) return
// before ANY receipt-minting logic runs. A session only reaches
// `state.active = true` via `chat.message` (~L442-555), and only along one
// of three activation paths: `activatedByAgent` (message.agent matches the
// configured active agent), `activatedByTrigger` (message text starts with
// the slash trigger), or `activatedByCommand` (a command-activated
// session). A task-tool-spawned subagent session goes through none of
// these -- either it never reaches `chat.message` at all (so it has no
// entry in `states`), or it reaches `chat.message` under a different
// `agent` and non-triggering text (so `state.active` is created but stays
// `false`).
//
// This is INTENTIONAL: it is what forces the main agent (not a delegated
// subagent) to be the one that verifies. The audit's fix is a pinning
// test, not a behavior change -- this file is that test. It must fail if a
// future edit loosens or removes the `!state || !state.active` guard.
//
// Both negative sub-cases exercise the guard's two disjuncts separately:
//   - "absent from the states map"      -> the `!state` arm
//   - "present but never activated"     -> the `!state.active` arm
// A mutation that satisfies only one arm (e.g. dropping `!state` and
// keeping `!state.active`, or vice versa) is still caught by the other.
//
// The positive case is the discriminator per the task brief: without it, a
// harness that mints no receipts for ANYONE (main agent included) would
// pass the negative cases trivially and prove nothing. It runs the exact
// same bash command, in a session that WAS activated via `chat.message`,
// and requires a receipt to actually appear.
// ===========================================================================

// ---------------------------------------------------------------------------
// Helpers below are copied verbatim in shape from tests/v2/plugin.integration
// .test.ts (StubClient / makeStubClient / pluginInput / activate / toolAfter)
// per the task brief's instruction to reuse, not reinvent, that file's
// established mocking pattern. They are not exported from that file, so
// they are reproduced here rather than imported.
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

function makeStubClient(): StubClient {
  const created: Array<{ id: string; parentID: string | null }> = []
  let counter = 0

  const sessionCreate = vi.fn(async (args: { body?: { parentID?: string | null } }) => {
    const parentID = args?.body?.parentID ?? null
    counter += 1
    const id = `subturn-child-${counter}`
    created.push({ id, parentID })
    return { data: { id }, error: undefined }
  })
  const sessionPrompt = vi.fn(async () => ({
    data: { info: {}, parts: [{ type: "text", text: '{"multiStory":false}' }] },
    error: undefined,
  }))
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
  workDir = mkdtempSync(join(tmpdir(), "vertex-v2-subagent-receipt-"))
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
  delete process.env.VERTEX_V2
  delete process.env.VERTEX_JUDGE
})

function pluginInput(client: unknown): PluginInput {
  return { client, directory: workDir, worktree: workDir } as unknown as PluginInput
}

/** Properly activates a session the way the real host does when the active
 * agent is invoked -- matches `activatedByAgent` in chat.message. */
async function activate(hooks: Hooks, sessionID: string, text: string) {
  await hooks["chat.message"]!(
    { sessionID, agent: "elicify-vertex-agent" } as never,
    { message: {} as never, parts: [{ type: "text", text } as never] },
  )
}

/** Drives chat.message the way a session that never activates the harness
 * would -- e.g. a task-tool-spawned subagent's own turn, or an ordinary
 * chat turn under some other agent with no trigger text. None of
 * activatedByAgent/activatedByTrigger/activatedByCommand fire, so
 * getOrCreateState() still creates a V2SessionState entry (chat.message
 * calls it unconditionally at the top), but `active` is never flipped to
 * `true`. This is the "present in the states map but inactive" negative
 * sub-case -- distinct from a session that never reaches chat.message at
 * all (see the "absent from the states map" test, which skips this
 * helper entirely). */
async function driveInactiveChatMessage(hooks: Hooks, sessionID: string, text: string) {
  await hooks["chat.message"]!(
    { sessionID, agent: "some-other-subagent" } as never,
    { message: {} as never, parts: [{ type: "text", text } as never] },
  )
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

// A command shape already proven (in tests/v2/plugin.integration.test.ts's
// "verification receipt surfaced to the model" describe block) to mint a
// receipt for a properly activated session: an edit changes a path, then a
// passing `npx vitest run` (exit 0) is a real, non-relevance-gapped
// verifier for it. Reused verbatim here so the negative and positive cases
// differ in EXACTLY one variable -- activation -- and nothing else.
const VERIFIER_COMMAND = "npx vitest run"
const VERIFIER_OUTPUT = "20 passed"

function receiptIdOf(toolOutput: { metadata: Record<string, unknown> }): unknown {
  return toolOutput.metadata.vertexVerificationReceiptId
}

describe("C-4: subagents (never-activated sessions) cannot mint verification receipts", () => {
  it("negative: a session absent from the states map produces no receipt for an otherwise-passing verifier", async () => {
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "never-touched-session"

    // No chat.message (or any other hook) has EVER been called for this
    // sessionID -- it has no entry in `states` at all. This is the
    // `!state` arm of `if (!state || !state.active) return`. It is also
    // the realistic shape of a task-tool-spawned subagent session: the
    // host never routes a chat.message activation call to it.
    await toolAfter(hooks, sid, "edit", { filePath: "src/foo.ts" }, "updated")

    const toolOutput = { title: "bash", output: VERIFIER_OUTPUT, metadata: { exit: 0 } as Record<string, unknown> }
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: sid, callID: "bash-1", args: { command: VERIFIER_COMMAND } } as never,
      toolOutput as never,
    )

    // Byte-identical output: the hook did nothing at all to this tool call.
    expect(toolOutput.output).toBe(VERIFIER_OUTPUT)
    expect(receiptIdOf(toolOutput)).toBeUndefined()
    expect(toolOutput.output).not.toContain("[vertex:verification-receipt]")
  })

  it("negative: a session present but never activated (active stays false) produces no receipt for an otherwise-passing verifier", async () => {
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "present-but-inactive-session"

    // chat.message DOES fire for this session (so it DOES get an entry in
    // `states`, unlike the previous test) but under an agent that doesn't
    // match the configured active agent, with text that doesn't start
    // with the slash trigger, and no command activation -- so none of
    // activatedByAgent / activatedByTrigger / activatedByCommand are true
    // and `state.active` stays `false`. This is the `!state.active` arm.
    await driveInactiveChatMessage(hooks, sid, "refactor the auth database migration end to end")
    await toolAfter(hooks, sid, "edit", { filePath: "src/foo.ts" }, "updated")

    const toolOutput = { title: "bash", output: VERIFIER_OUTPUT, metadata: { exit: 0 } as Record<string, unknown> }
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: sid, callID: "bash-1", args: { command: VERIFIER_COMMAND } } as never,
      toolOutput as never,
    )

    expect(toolOutput.output).toBe(VERIFIER_OUTPUT)
    expect(receiptIdOf(toolOutput)).toBeUndefined()
    expect(toolOutput.output).not.toContain("[vertex:verification-receipt]")
  })

  it("positive (discriminator): the exact same command, in a properly activated session, DOES produce a receipt", async () => {
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "properly-activated-session"

    // Real activation path: activatedByAgent (message.agent === the
    // configured active agent, "elicify-vertex-agent").
    await activate(hooks, sid, "refactor the auth database migration end to end")
    await toolAfter(hooks, sid, "edit", { filePath: "src/foo.ts" }, "updated")

    const toolOutput = { title: "bash", output: VERIFIER_OUTPUT, metadata: { exit: 0 } as Record<string, unknown> }
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: sid, callID: "bash-1", args: { command: VERIFIER_COMMAND } } as never,
      toolOutput as never,
    )

    // This is the discriminator the task brief calls for: if this
    // assertion fails while the two negative tests above pass, the
    // harness simply never mints receipts for anyone, and the negative
    // tests above would be proving nothing.
    expect(toolOutput.output).toContain("[vertex:verification-receipt]")
    expect(toolOutput.output).toMatch(/\[vertex:verification-receipt\] \S+/)
    expect(typeof receiptIdOf(toolOutput)).toBe("string")
  })
})
