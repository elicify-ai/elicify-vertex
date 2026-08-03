/**
 * elicify-vertex v2 — integration tests: judge subturn through the real
 * wired plugin (wave 4, cluster "judge subturn through the real wired
 * plugin").
 * ---------------------------------------------------------------------------
 * Covers TDD Plan tests 29 (`judge_async_fail_open`), 36
 * (`judge_model_selection_and_fallback`), 51
 * (`judge_verdict_appended_happy_path`) — US-9 / FR-030 / FR-030a / FR-032 —
 * driven against the REAL wired `ElicifyVertexPluginV2` hook set
 * (`event(session.idle)` -> `src/v2/wiring/gate.ts` -> `src/v2/judge.ts` ->
 * `src/v2/subturn.ts`), not a mocked judge module. `makeStubClient` and the
 * driver helpers below are a deliberate copy of `tests/v2/plugin.integration
 * .test.ts`'s own helpers (same `{data,error}` SDK response shape) per the
 * task brief — importing from that file would race its concurrent edits by
 * the other wave-4 agents working the same session.
 *
 * ===========================================================================
 * FIXED (was CONFIRMED BUG). Every test below asserts the SPEC-CORRECT
 * behaviour (US-9 Acceptance Scenarios 1/2/3/4) and now PASSES against the
 * real wiring — this file previously documented a genuine, reproducible
 * defect here, which has since been fixed. Root cause, for the record:
 *
 *   `src/v2/wiring/gate.ts`'s `handleSessionIdle` used to resolve the story
 *   id it hands to `PhaseEngine.onIdle` as bare `activeStory?.id ?? null`.
 *   `StoryEngine.getActiveStory` (`src/v2/story.ts`) only ever returns a
 *   story whose `status === "active"`, and `elicify_vertex_plan_checkpoint`
 *   unconditionally flips even the FINAL story away from "active" on
 *   completion, with no replacement promoted (none remain). So by the time
 *   `appendJudgeCloseOut`'s `finalStory.status === "complete"` precondition
 *   could ever be true, `getActiveStory` was *guaranteed* to return `null`,
 *   `phaseEngine.onIdle` read a phase slot nothing had ever written to,
 *   defaulted to `"intake"` instead of `"elevate"`, and `appendJudgeCloseOut`
 *   was never invoked — the judge was structurally unreachable for every
 *   story-plan session, in either hook-call order (idle-then-checkpoint or
 *   checkpoint-then-idle).
 *
 *   Fixed by falling back to the plan's final story once no story remains
 *   active: `handleSessionIdle` now resolves `storyId` as
 *   `activeStory?.id ?? ctx.storyEngine.getPlan(sid)?.finalStoryId ?? null`
 *   (`gate.ts`, see the comment on that line). The equivalent fix for the
 *   mutation/verifier-outcome call sites in `src/v2/plugin.ts` is
 *   `resolveStoryIdForPhase` (see that function's doc comment — "FIX #1").
 *
 *   The judge MODULE itself (`src/v2/judge.ts`) has always been independently
 *   covered and passing in `tests/v2/judge.test.ts`; this file exercises the
 *   WIRING path end to end and is what now proves the fix holds — these
 *   tests are live regressions: if the fallback above is ever reverted or
 *   narrowed, they fail again.
 * ===========================================================================
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import type { Agent } from "@opencode-ai/sdk"

import { VerificationReceiptStore } from "../../src/goals.js"
import { eventsPath } from "../../src/measurement.js"
import { JUDGE_TOTAL_BUDGET_MS } from "../../src/v2/judge.js"
import { ElicifyVertexPluginV2 } from "../../src/v2/plugin.js"

// ---------------------------------------------------------------------------
// Shared stub client — copied from tests/v2/plugin.integration.test.ts (see
// that file's header comment for why it isn't imported). Extended with a
// `promptImpl` escape hatch so a test can control the judge subturn's
// `session.prompt` response per-call (hang, reject, or return a specific
// verdict) the same way tests/v2/subturn.test.ts's `makeClient` does.
// ---------------------------------------------------------------------------

type PromptArgs = {
  path?: { id?: string }
  body?: { agent?: string; model?: { providerID: string; modelID: string }; parts?: Array<{ text?: string }> }
}
type PromptResult = { data?: unknown; error?: unknown }
type MessagesArgs = { path?: { id?: string } }
type MessagesResult = { data?: unknown; error?: unknown }

/** Structural type for the `vi.spyOn(VerificationReceiptStore.prototype,
 * "record")` spy — loose on purpose so it doesn't fight vitest's own
 * `MockInstance` generic variance; only `.mock.results[].value` is read. */
type ReceiptRecordSpy = { mock: { results: Array<{ value: unknown }> } }

function denyAllAgent(name: string): Agent {
  return {
    name,
    mode: "subagent",
    builtIn: false,
    // Deny the UNION of both probe policies: intake's default
    // (edit/bash/webfetch) and the judge's JUDGE_PROBE_POLICY
    // (edit/write/webfetch/task) — see src/v2/subturn.ts.
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
    promptImpl?: (args: PromptArgs) => Promise<PromptResult>
    /** `gate.ts`'s `fetchJudgeTranscriptFields` override — same escape-hatch
     * pattern as `promptImpl` above. Defaults to the existing empty-history
     * stub (`{data: [], error: undefined}`) so every test that doesn't care
     * about transcript content is unaffected. */
    messagesImpl?: (args: MessagesArgs) => Promise<MessagesResult>
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
  const sessionPrompt = vi.fn(async (args: PromptArgs) => {
    if (opts.promptImpl) return opts.promptImpl(args)
    const text = opts.promptText ? opts.promptText(args?.body?.agent) : '{"multiStory":false}'
    return { data: { info: {}, parts: [{ type: "text", text }] }, error: undefined }
  })
  const sessionDelete = vi.fn(async () => ({ data: {}, error: undefined }))
  const sessionMessages = vi.fn(async (args: MessagesArgs) => {
    if (opts.messagesImpl) return opts.messagesImpl(args)
    return { data: [], error: undefined }
  })
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
let dataDir: string
let savedVertexData: string | undefined

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "vertex-v2-judge-work-"))
  dataDir = mkdtempSync(join(tmpdir(), "vertex-v2-judge-data-"))
  savedVertexData = process.env.VERTEX_DATA
  process.env.VERTEX_DATA = dataDir
  process.env.VERTEX_JUDGE = "1"
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
  rmSync(dataDir, { recursive: true, force: true })
  if (savedVertexData === undefined) delete process.env.VERTEX_DATA
  else process.env.VERTEX_DATA = savedVertexData
  delete process.env.VERTEX_JUDGE
  delete process.env.VERTEX_V2
  vi.useRealTimers()
  vi.restoreAllMocks()
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

async function idle(hooks: Hooks, sessionID: string) {
  await hooks.event!({ event: { type: "session.idle", properties: { sessionID } } as never })
}

/** Calls one of the plugin's `elicify_vertex_plan_*` tools directly (the way
 * the real agent loop would, minus the LLM in front of it), returning the
 * tool's string result. */
async function callTool(hooks: Hooks, name: string, args: unknown, sessionID: string): Promise<string> {
  const def = hooks.tool?.[name]
  if (!def) throw new Error(`tool "${name}" not registered`)
  const result = await def.execute(args as never, { sessionID } as never)
  return typeof result === "string" ? result : JSON.stringify(result)
}

/** Continuation prompts issued directly by the idle gate never set
 * `body.agent` (subturn requests always do) — mirrors
 * tests/v2/plugin.integration.test.ts's identical helper. */
function idleContinuationTexts(client: StubClient, sessionID: string): string[] {
  return client.session.prompt.mock.calls
    .filter((call: unknown[]) => {
      const arg = call[0] as PromptArgs
      return arg?.path?.id === sessionID && arg?.body?.agent === undefined
    })
    .map((call: unknown[]) => {
      const arg = call[0] as PromptArgs
      return arg?.body?.parts?.[0]?.text ?? ""
    })
}

/** `session.prompt` calls the judge subturn specifically issued (agent ===
 * "vertex-judge"), in call order. */
function judgePromptCalls(client: StubClient): PromptArgs[] {
  return client.session.prompt.mock.calls
    .map((call: unknown[]) => call[0] as PromptArgs)
    .filter((arg) => arg?.body?.agent === "vertex-judge")
}

function readEvents(): Array<Record<string, unknown>> {
  const path = eventsPath()
  if (!existsSync(path)) return []
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

/**
 * Drives a session up to "the final story's verifier just went green" —
 * activate (a TRIVIAL_ASK_RE ask, so the intake classification subturn is
 * skipped and doesn't add noise to the session.create/prompt call log) ->
 * create a single-story plan (that story is therefore also `finalStoryId`)
 * -> mutate -> a passing bash verification covering the story's own
 * `verifiers` entry. Returns the ids needed to checkpoint that story, plus
 * the REAL receipt id `tool.execute.after` recorded for the verification
 * (captured via a `vi.spyOn` on `VerificationReceiptStore.prototype.record`
 * — the id is a random UUID minted deep inside plugin.ts's closure, not
 * otherwise observable from outside the hook surface).
 */
async function setUpFinalStoryVerified(
  hooks: Hooks,
  sessionID: string,
  model: { providerID: string; id: string },
  recordSpy: ReceiptRecordSpy,
): Promise<{ storyId: string; taskId: string; itemId: string; receiptId: string }> {
  // "fix a typo in the readme" matches TRIVIAL_ASK_RE -> classifyMultiStory
  // short-circuits to "skipped", issuing zero session.create/prompt calls.
  await activate(hooks, sessionID, "fix a typo in the readme", model)

  const createRaw = await callTool(
    hooks,
    "elicify_vertex_plan_create",
    {
      stories: [
        {
          text: "the only story",
          acceptanceItems: ["criterion one"],
          scopeGlobs: [],
          verifiers: ["npx vitest run"],
          // 2026-07-30 task/DAG redesign: each story MUST decompose into >=1
          // task; a single trivial task is enough — this helper only cares
          // about reaching a claimable final story.
          tasks: [{ text: "do the only story" }],
        },
      ],
    },
    sessionID,
  )
  const plan = JSON.parse(createRaw) as {
    stories: Array<{ id: string; acceptanceItems: Array<{ id: string }>; tasks: Array<{ id: string }> }>
  }
  const storyId = plan.stories[0].id
  const itemId = plan.stories[0].acceptanceItems[0].id
  const taskId = plan.stories[0].tasks[0].id

  await toolAfter(hooks, sessionID, "edit", { filePath: "src/foo.ts" }, "updated")
  await toolAfter(hooks, sessionID, "bash", { command: "npx vitest run" }, "20 passed", { exit: 0 })

  // Setup sanity check (not the behaviour under test): the verified
  // bash command must have actually recorded a receipt. (Under the task-model
  // redesign a checkpoint is a bare CLAIM that no longer cites this receipt,
  // but the receipt is still minted by tool.execute.after's verification
  // recognition — so the spy still observes it here.)
  expect(recordSpy.mock.results.length).toBeGreaterThan(0)
  const lastResult = recordSpy.mock.results[recordSpy.mock.results.length - 1]
  const receiptId = (lastResult.value as { id: string }).id

  return { storyId, taskId, itemId, receiptId }
}

// ===========================================================================
// Test 29: judge_async_fail_open (FR-030 / FR-032)
// ===========================================================================

describe("test 29: judge_async_fail_open", () => {
  it("a judge subturn that hangs past the 5s cap fails open without hanging the test, logs judge:unavailable, and cleans up its child session", async () => {
    const client = makeStubClient({
      promptImpl: async (args) => {
        if (args.body?.agent === "vertex-judge") {
          return new Promise(() => {
            /* never resolves — mirrors tests/v2/subturn.test.ts's hang-past-timeout stub */
          })
        }
        return { data: { info: {}, parts: [{ type: "text", text: '{"multiStory":false}' }] }, error: undefined }
      },
    })
    const recordSpy = vi.spyOn(VerificationReceiptStore.prototype, "record")
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "judge-fail-open-session"

    const { taskId } = await setUpFinalStoryVerified(
      hooks,
      sid,
      { providerID: "minimax", id: "MiniMax-M3" },
      recordSpy,
    )

    const checkpointRaw = await callTool(
      hooks,
      "elicify_vertex_plan_checkpoint",
      { taskId, status: "complete" },
      sid,
    )
    const checkpointed = JSON.parse(checkpointRaw) as { stories: Array<{ status: string }> }
    // Setup sanity check (not the behaviour under test): the checkpoint call
    // itself is pure evidence validation and always succeeds here.
    expect(checkpointed.stories[0].status).toBe("complete")

    vi.useFakeTimers()
    const idlePromise = idle(hooks, sid)
    // Advance well past the judge's total budget so the hang-past-timeout
    // subturn resolves via its own internal timeout instead of really
    // waiting out JUDGE_TOTAL_BUDGET_MS in real time.
    await vi.advanceTimersByTimeAsync(JUDGE_TOTAL_BUDGET_MS + 1000)
    await idlePromise // must not hang the test either way
    vi.useRealTimers()

    const events = readEvents()
    // appendJudgeCloseOut IS reached (see this file's header for the
    // storyId/getActiveStory fallback that makes this so) — the judge
    // subturn is invoked, hangs past its budget, and fails open.
    expect(events.some((e) => e.event_type === "judge:unavailable")).toBe(true)

    // The vertex-judge child session is created and, on the hang-timeout
    // fail-open path, cleaned up.
    expect(client.session.create).toHaveBeenCalledTimes(1)
    expect(client.session.delete).toHaveBeenCalledTimes(1)
  })
})

// ===========================================================================
// Test 36: judge_model_selection_and_fallback (FR-030a)
// ===========================================================================

describe("test 36: judge_model_selection_and_fallback", () => {
  it("(a) defaults to the session's own model when no judgeModel option is configured", async () => {
    const client = makeStubClient({
      promptImpl: async (args) => {
        if (args.body?.agent === "vertex-judge") {
          return {
            data: {
              info: {},
              parts: [
                {
                  type: "text",
                  text: '{"stories":[{"storyId":"S1","pass":true,"summary":"looks fine","items":[{"itemId":"A1","met":true,"note":"observed"}]}]}',
                },
              ],
            },
            error: undefined,
          }
        }
        return { data: { info: {}, parts: [{ type: "text", text: '{"multiStory":false}' }] }, error: undefined }
      },
    })
    const recordSpy = vi.spyOn(VerificationReceiptStore.prototype, "record")
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "judge-model-default-session"

    const { taskId } = await setUpFinalStoryVerified(
      hooks,
      sid,
      { providerID: "minimax", id: "MiniMax-M3" },
      recordSpy,
    )

    const checkpointRaw = await callTool(
      hooks,
      "elicify_vertex_plan_checkpoint",
      { taskId, status: "complete" },
      sid,
    )
    expect((JSON.parse(checkpointRaw) as { stories: Array<{ status: string }> }).stories[0].status).toBe("complete")

    await idle(hooks, sid)

    const calls = judgePromptCalls(client)
    expect(calls.length).toBe(1)
    expect(calls[0]?.body?.model).toEqual({ providerID: "minimax", modelID: "MiniMax-M3" })

    expect(client.session.create).toHaveBeenCalledTimes(1)
    const createArgs = client.session.create.mock.calls[0]?.[0] as { body?: { parentID?: string } } | undefined
    expect(createArgs?.body?.parentID).toBe(sid)

    // Redesign point 2/4: a passed claim on the settled plan dispatches the
    // close-out continuation (the judge verified every story).
    const continuationTexts = idleContinuationTexts(client, sid)
    expect(continuationTexts.some((t) => t.includes("passed audit"))).toBe(true)
  })

  it("(b) falls back to the session model when the configured judgeModel's attempt rejects, appending the verdict on the retry's success", async () => {
    const client = makeStubClient({
      promptImpl: async (args) => {
        if (args.body?.agent !== "vertex-judge") {
          return { data: { info: {}, parts: [{ type: "text", text: '{"multiStory":false}' }] }, error: undefined }
        }
        if (args.body?.model?.providerID === "provider-x") {
          throw new Error("provider-x unavailable")
        }
        return {
          data: {
            info: {},
            parts: [
              {
                type: "text",
                text: '{"stories":[{"storyId":"S1","pass":true,"summary":"fallback worked","items":[{"itemId":"A1","met":true,"note":"observed"}]}]}',
              },
            ],
          },
          error: undefined,
        }
      },
    })
    const recordSpy = vi.spyOn(VerificationReceiptStore.prototype, "record")
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), { judgeModel: "provider-x/model-y" } as never)
    const sid = "judge-model-fallback-session"

    const { taskId } = await setUpFinalStoryVerified(
      hooks,
      sid,
      { providerID: "minimax", id: "MiniMax-M3" },
      recordSpy,
    )

    const checkpointRaw = await callTool(
      hooks,
      "elicify_vertex_plan_checkpoint",
      { taskId, status: "complete" },
      sid,
    )
    expect((JSON.parse(checkpointRaw) as { stories: Array<{ status: string }> }).stories[0].status).toBe("complete")

    await idle(hooks, sid)

    const calls = judgePromptCalls(client)
    expect(calls.length).toBe(2)
    expect(calls[0]?.body?.model).toEqual({ providerID: "provider-x", modelID: "model-y" })
    expect(calls[1]?.body?.model).toEqual({ providerID: "minimax", modelID: "MiniMax-M3" })

    // The retry's pass verdict closes the plan out.
    const continuationTexts = idleContinuationTexts(client, sid)
    expect(continuationTexts.some((t) => t.includes("passed audit"))).toBe(true)
  })
})

// ===========================================================================
// Test 51: judge_verdict_appended_happy_path (FR-030)
// ===========================================================================

describe("test 51: judge_verdict_appended_happy_path", () => {
  it("a failed audit reverts the claimed story to active and dispatches a continuation naming the unmet acceptance item", async () => {
    // Redesign points 2/4/8: the judge is the arbiter. A failing verdict on a
    // claimed-complete story REVERTS it to "active" (the claim is rejected)
    // and dispatches a constructive continuation that names each unmet
    // acceptance item and the judge's note for it — not a generic reminder.
    const client = makeStubClient({
      promptImpl: async (args) => {
        if (args.body?.agent === "vertex-judge") {
          return {
            data: {
              info: {},
              parts: [
                {
                  type: "text",
                  text: JSON.stringify({
                    stories: [
                      {
                        storyId: "S1",
                        pass: false,
                        summary: "the test suite was never run",
                        items: [{ itemId: "A1", met: false, note: "no passing verifier observed for this criterion" }],
                      },
                    ],
                  }),
                },
              ],
            },
            error: undefined,
          }
        }
        return { data: { info: {}, parts: [{ type: "text", text: '{"multiStory":false}' }] }, error: undefined }
      },
    })
    const recordSpy = vi.spyOn(VerificationReceiptStore.prototype, "record")
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "judge-happy-path-session"

    const { storyId, taskId, itemId } = await setUpFinalStoryVerified(
      hooks,
      sid,
      { providerID: "anthropic", id: "claude-fable-5" },
      recordSpy,
    )

    const checkpointRaw = await callTool(
      hooks,
      "elicify_vertex_plan_checkpoint",
      { taskId, status: "complete" },
      sid,
    )
    const checkpointed = JSON.parse(checkpointRaw) as { stories: Array<{ status: string }> }
    // A checkpoint is a claim — it always succeeds; the judge audits it next.
    expect(checkpointed.stories[0].status).toBe("complete")

    await idle(hooks, sid)

    // The failed audit REVERTS the claim: the story is active again, not
    // complete.
    const afterAudit = JSON.parse(await callTool(hooks, "elicify_vertex_plan_status", {}, sid)) as {
      stories: Array<{ id: string; status: string }>
    }
    expect(afterAudit.stories.find((s) => s.id === storyId)?.status).toBe("active")

    // The continuation names the unmet item id and the judge's note verbatim.
    const continuationTexts = idleContinuationTexts(client, sid)
    expect(continuationTexts.some((t) => t.includes("[vertex:judge]"))).toBe(true)
    expect(continuationTexts.some((t) => t.includes(itemId))).toBe(true)
    expect(continuationTexts.some((t) => t.includes("no passing verifier observed for this criterion"))).toBe(true)
  })
})

// ===========================================================================
// Staggered-audit close-out (redesign point 2/4): the close-out continuation
// fires once the WHOLE plan is settled and every story has a passing judge
// stamp — including when stories pass audit in SEPARATE idle audits, not only
// when the final story is in the settling audit's set. Pins the gap a review
// flagged (a final story passing while a non-final one is still unjudged).
// ===========================================================================
describe("judge close-out fires once every story has passed audit, across staggered audits", () => {
  it("final passes in audit 1, non-final passes in audit 2 -> close-out fires on audit 2", async () => {
    let judgeCall = 0
    const client = makeStubClient({
      promptImpl: async (args) => {
        if (args.body?.agent !== "vertex-judge") {
          return { data: { info: {}, parts: [{ type: "text", text: '{"multiStory":false}' }] }, error: undefined }
        }
        // Audit 1 audits only S2 (the final story, the sole unjudged claim at
        // that point because S1 was claimed in the same batch but... see below);
        // audit 2 audits S1. Each returns a pass for the story it was asked
        // about. (The payload's `plan` field names the audit set; call order
        // is deterministic since there is no judgeModel override.)
        judgeCall += 1
        const storyId = judgeCall === 1 ? "S2" : "S1"
        return {
          data: {
            info: {},
            parts: [
              {
                type: "text",
                text: JSON.stringify({
                  stories: [
                    { storyId, pass: true, summary: "ok", items: [{ itemId: "A1", met: true, note: "observed" }] },
                  ],
                }),
              },
            ],
          },
          error: undefined,
        }
      },
    })
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "judge-staggered-session"
    await activate(hooks, sid, "fix a typo in the readme", { providerID: "anthropic", id: "claude-fable-5" })

    await callTool(
      hooks,
      "elicify_vertex_plan_create",
      {
        stories: [
          { text: "non-final story", acceptanceItems: ["nf done"], scopeGlobs: [], verifiers: ["npx vitest run"], tasks: [{ text: "do the non-final story" }] },
          { text: "final story", acceptanceItems: ["f done"], scopeGlobs: [], verifiers: ["npx vitest run"], tasks: [{ text: "do the final story" }] },
        ],
      },
      sid,
    )

    // Claim both stories complete (a claim needs no evidence now). Each story
    // has one task; with no cross-story deps both tasks start active at create,
    // so each can be checkpointed in turn.
    await callTool(hooks, "elicify_vertex_plan_checkpoint", { taskId: "S1.T1", status: "complete" }, sid)
    await callTool(hooks, "elicify_vertex_plan_checkpoint", { taskId: "S2.T1", status: "complete" }, sid)

    // Audit 1: both are unjudged. The judge (stub) returns a pass for "S2"
    // only; the audit set is {S1,S2}, so S1 is left without a stamp -> NOT
    // settled+allPassed -> no close-out yet.
    await idle(hooks, sid)
    let continuations = idleContinuationTexts(client, sid)
    expect(continuations.some((t) => t.includes("passed audit"))).toBe(false)

    // Audit 2: S1 is the sole remaining unjudged claim; it passes -> now every
    // story has a passing stamp -> close-out fires.
    await idle(hooks, sid)
    continuations = idleContinuationTexts(client, sid)
    expect(continuations.some((t) => t.includes("passed audit"))).toBe(true)
  })
})

// ===========================================================================
// fetchJudgeTranscriptFields (gate.ts, docs/JUDGE-PROMPT.md §5) — test-quality
// review finding: this function (and its helpers extractEntryText/
// isFieldsStyle) had ZERO coverage. Proof cited by the reviewer: mutating it
// to select the last USER message instead of the last ASSISTANT message for
// `lastResponse` left the full 1270-test suite green. `fetchJudgeTranscriptFields`
// is not exported (gate.ts's SCOPE deliberately keeps it private — see this
// file's helpers), so these drive it the same way every other test in this
// file does: through the REAL wired hook set, via the new `messagesImpl`
// escape hatch on `client.session.messages`, reading back what actually
// reached the judge subturn's own `session.prompt` call (the JSON-stringified
// payload built by `buildJudgePayload`).
// ===========================================================================

function judgePayloadFromCall(call: PromptArgs | undefined): { lastResponse?: string; recentTranscript?: string } {
  const text = call?.body?.parts?.[0]?.text
  if (typeof text !== "string") throw new Error("no vertex-judge prompt call captured")
  return JSON.parse(text) as { lastResponse?: string; recentTranscript?: string }
}

/** A `client.session.messages` entry in the shape `fetchJudgeTranscriptFields`
 * reads (`JudgeTranscriptEntry` in gate.ts): `info.role` + one text part. */
function entry(role: "user" | "assistant", text: string) {
  return { info: { id: `m-${role}-${Math.random()}`, role }, parts: [{ type: "text", text }] }
}

const passingJudgePromptImpl = async (args: PromptArgs): Promise<PromptResult> => {
  if (args.body?.agent === "vertex-judge") {
    return {
      data: { info: {}, parts: [{ type: "text", text: '{"fit":"pass","summary":"ok","gaps":[]}' }] },
      error: undefined,
    }
  }
  return { data: { info: {}, parts: [{ type: "text", text: '{"multiStory":false}' }] }, error: undefined }
}

describe("fetchJudgeTranscriptFields: lastResponse is the last ASSISTANT message, never the last user message", () => {
  it("a transcript ending on a trailing USER message still resolves lastResponse to the earlier ASSISTANT message", async () => {
    const transcript = [
      entry("user", "please do X"),
      entry("assistant", "the agent's real final response, this is what lastResponse must equal"),
      // Trailing user turn AFTER the assistant's real last response — the
      // exact shape that discriminates "last assistant" from "last user":
      // a buggy `role === "user"` swap would pick THIS text instead. Plain
      // prose (no long underscore-joined token) so a wrong selection shows
      // up as the literal wrong text, not an incidental redaction drop.
      entry("user", "one more thing please also handle the edge case"),
    ]
    const client = makeStubClient({
      promptImpl: passingJudgePromptImpl,
      messagesImpl: async () => ({ data: transcript, error: undefined }),
    })
    const recordSpy = vi.spyOn(VerificationReceiptStore.prototype, "record")
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "judge-transcript-lastresponse-session"

    const { taskId } = await setUpFinalStoryVerified(
      hooks,
      sid,
      { providerID: "minimax", id: "MiniMax-M3" },
      recordSpy,
    )
    await callTool(hooks, "elicify_vertex_plan_checkpoint", { taskId, status: "complete" }, sid)

    await idle(hooks, sid)

    const payload = judgePayloadFromCall(judgePromptCalls(client)[0])
    expect(payload.lastResponse).toBe("the agent's real final response, this is what lastResponse must equal")
    expect(payload.lastResponse).not.toContain("one more thing please also handle the edge case")
  })
})

describe("fetchJudgeTranscriptFields: recentTranscript is truncated to the turn window, not the full history", () => {
  it("with 12 turns and an 8-turn window, only the last 8 survive", async () => {
    // gate.ts's JUDGE_RECENT_TRANSCRIPT_TURN_WINDOW = 8 (not exported — see
    // that file's doc comment on the constant). Zero-padded, fixed-width
    // labels (TURN-00 .. TURN-11) avoid substring collisions between kept and
    // dropped turns (e.g. "TURN-1" would otherwise be a substring of
    // "TURN-10"/"TURN-11").
    const totalTurns = 12
    const windowSize = 8
    const transcript = Array.from({ length: totalTurns }, (_, i) =>
      entry(i % 2 === 0 ? "user" : "assistant", `TURN-${String(i).padStart(2, "0")}`),
    )
    const client = makeStubClient({
      promptImpl: passingJudgePromptImpl,
      messagesImpl: async () => ({ data: transcript, error: undefined }),
    })
    const recordSpy = vi.spyOn(VerificationReceiptStore.prototype, "record")
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "judge-transcript-window-session"

    const { taskId } = await setUpFinalStoryVerified(
      hooks,
      sid,
      { providerID: "minimax", id: "MiniMax-M3" },
      recordSpy,
    )
    await callTool(hooks, "elicify_vertex_plan_checkpoint", { taskId, status: "complete" }, sid)

    await idle(hooks, sid)

    const payload = judgePayloadFromCall(judgePromptCalls(client)[0])
    expect(payload.recentTranscript).toBeDefined()

    const keptStart = totalTurns - windowSize // 4
    const expectedLines = Array.from({ length: windowSize }, (_, j) => {
      const i = keptStart + j
      return `${i % 2 === 0 ? "user" : "assistant"}: TURN-${String(i).padStart(2, "0")}`
    })
    expect(payload.recentTranscript).toBe(expectedLines.join("\n"))

    // The dropped turns (indices 0-3) must not survive truncation at all.
    for (let i = 0; i < keptStart; i++) {
      expect(payload.recentTranscript).not.toContain(`TURN-${String(i).padStart(2, "0")}`)
    }
  })
})

describe("fetchJudgeTranscriptFields: both client.session.messages response shapes parse identically", () => {
  const transcript = [entry("user", "hello"), entry("assistant", "SHAPE_PARITY_RESPONSE")]

  async function driveAndReadPayload(messagesImpl: () => Promise<unknown>): Promise<{ lastResponse?: string; recentTranscript?: string }> {
    const client = makeStubClient({
      promptImpl: passingJudgePromptImpl,
      messagesImpl: messagesImpl as never,
    })
    const recordSpy = vi.spyOn(VerificationReceiptStore.prototype, "record")
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = `judge-transcript-shape-${Math.random().toString(36).slice(2)}`

    const { taskId } = await setUpFinalStoryVerified(
      hooks,
      sid,
      { providerID: "minimax", id: "MiniMax-M3" },
      recordSpy,
    )
    await callTool(hooks, "elicify_vertex_plan_checkpoint", { taskId, status: "complete" }, sid)
    await idle(hooks, sid)
    return judgePayloadFromCall(judgePromptCalls(client)[0])
  }

  it("`{data: [...], error: undefined}`-wrapped response parses correctly (isFieldsStyle branch)", async () => {
    const payload = await driveAndReadPayload(async () => ({ data: transcript, error: undefined }))
    expect(payload.lastResponse).toBe("SHAPE_PARITY_RESPONSE")
  })

  it("a bare array response (no {data,error} wrapper) parses identically (non-isFieldsStyle branch)", async () => {
    const payload = await driveAndReadPayload(async () => transcript)
    expect(payload.lastResponse).toBe("SHAPE_PARITY_RESPONSE")
  })
})

// ===========================================================================
// Sign-off finding: every existing secret-in-lastResponse/recentTranscript
// test in judge.test.ts calls buildJudgePayload directly with a hand-built
// object -- proving redaction works in isolation, never proving a secret
// sitting in a real (mocked) client.session.messages transcript actually gets
// scrubbed once it flows through the REAL fetchJudgeTranscriptFields wiring.
// This closes that gap: the secret lives in the mocked transcript, same as a
// real subagent conversation would carry it, and the assertion reads the
// judge's actual outgoing prompt -- the true blast-radius boundary.
// ===========================================================================

describe("a secret in a real (mocked) transcript is redacted through the full fetch-then-payload path", () => {
  it("a secret in the last ASSISTANT message never reaches the judge's outgoing prompt", async () => {
    const secret = "sk-live-abc123def456ghi789jkl012mno345pqr"
    const transcript = [
      entry("user", "please finish the task"),
      entry("assistant", `I finished the task. Here is the key I used: ${secret}`),
    ]
    const client = makeStubClient({
      promptImpl: passingJudgePromptImpl,
      messagesImpl: async () => ({ data: transcript, error: undefined }),
    })
    const recordSpy = vi.spyOn(VerificationReceiptStore.prototype, "record")
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "judge-transcript-secret-lastresponse-session"

    const { taskId } = await setUpFinalStoryVerified(
      hooks,
      sid,
      { providerID: "minimax", id: "MiniMax-M3" },
      recordSpy,
    )
    await callTool(hooks, "elicify_vertex_plan_checkpoint", { taskId, status: "complete" }, sid)
    await idle(hooks, sid)

    const call = judgePromptCalls(client)[0]
    const rawText = call?.body?.parts?.[0]?.text
    expect(typeof rawText).toBe("string")
    expect(rawText).not.toContain(secret)
    const payload = judgePayloadFromCall(call)
    expect(payload.lastResponse).toBeUndefined()
  })

  it("a secret in one line of recentTranscript is dropped while a clean line in the same transcript survives", async () => {
    const secret = "sk-live-zzz999yyy888xxx777www666vvv555uuu"
    const transcript = [
      entry("user", "clean line that must survive"),
      entry("assistant", `secret: ${secret}`),
      entry("user", "another clean line, also must survive"),
    ]
    const client = makeStubClient({
      promptImpl: passingJudgePromptImpl,
      messagesImpl: async () => ({ data: transcript, error: undefined }),
    })
    const recordSpy = vi.spyOn(VerificationReceiptStore.prototype, "record")
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "judge-transcript-secret-recenttranscript-session"

    const { taskId } = await setUpFinalStoryVerified(
      hooks,
      sid,
      { providerID: "minimax", id: "MiniMax-M3" },
      recordSpy,
    )
    await callTool(hooks, "elicify_vertex_plan_checkpoint", { taskId, status: "complete" }, sid)
    await idle(hooks, sid)

    const call = judgePromptCalls(client)[0]
    const rawText = call?.body?.parts?.[0]?.text
    expect(rawText).not.toContain(secret)
    const payload = judgePayloadFromCall(call)
    expect(payload.recentTranscript).toContain("clean line that must survive")
    expect(payload.recentTranscript).toContain("another clean line, also must survive")
    expect(payload.recentTranscript).not.toContain(secret)
  })
})
