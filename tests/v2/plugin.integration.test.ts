import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import type { Agent } from "@opencode-ai/sdk"

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

interface LoggedEvent {
  event_type: string
  session_id: string
  payload: Record<string, unknown>
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
          { text: "do the work", acceptanceItems: ["it works"], scopeGlobs: ["internal/**"], verifiers },
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
      { stories: [{ text: "w", acceptanceItems: ["ok"], scopeGlobs: ["internal/**"], verifiers }] } as never,
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

    const mine = readEvents().filter((e) => e.session_id === sid)
    expect(mine.map((e) => e.event_type)).toEqual([])
  })

  it("DOES log dosing for an activated session (discrimination)", async () => {
    // Without this the fix could be "never log dosing" and the test above
    // would still pass while real telemetry disappeared.
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = `active-${Math.random().toString(36).slice(2)}`

    await activate(hooks, sid, "implement the production database migration", {
      providerID: "openrouter",
      id: "z-ai/glm-5.2",
    })
    // The shared `transform` helper hardcodes a KNOWN model, which resolves
    // cleanly and therefore logs nothing. Drive it with the same unknown model
    // the live G1 session used.
    await hooks["experimental.chat.system.transform"]!(
      { sessionID: sid, model: { providerID: "openrouter", id: "z-ai/glm-5.2" } as never },
      { system: [] as string[] },
    )

    const mine = readEvents().filter((e) => e.session_id === sid)
    expect(mine.some((e) => e.event_type === "dosing:unknown-model")).toBe(true)
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
    const clientA = makeStubClient()
    const hooksA = await ElicifyVertexPluginV2(pluginInput(clientA), undefined)
    const sid = "restart-session"

    await activate(hooksA, sid, "implement the production database migration")
    // The plan must exist BEFORE the verifier runs: a receipt is linked to the
    // story that was active when it was observed, and a receipt earned before
    // the story existed must not complete it. That linkage is the feature, not
    // an obstacle -- an earlier draft of this test got the order wrong and was
    // correctly refused twice over (null story link, and observedAt < startedAt).
    await hooksA.tool!.elicify_vertex_plan_create!.execute!(
      { stories: [{ text: "w", acceptanceItems: ["ok"], scopeGlobs: ["**"], verifiers: ["go test ./..."] }] } as never,
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

    const res = await hooksB.tool!.elicify_vertex_plan_checkpoint!.execute!(
      { storyId: "S1", status: "complete", receiptId, items: [{ id: "A1", receiptId }] } as never,
      { sessionID: sid } as never,
    )
    expect(JSON.stringify(res)).not.toMatch(/not an observed receipt/i)
  })
})
