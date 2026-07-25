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
 * CONFIRMED BUG — every test below asserts the SPEC-CORRECT behaviour (US-9
 * Acceptance Scenarios 1/2/3/4) and FAILS against the current wiring. This is
 * NOT a test-authoring mistake — it is a genuine, reproducible defect that
 * makes the judge feature entirely unreachable through the real hook-driven
 * flow for every story-plan session. Root cause, with exact reproduction:
 *
 *   `src/v2/wiring/gate.ts`'s `handleSessionIdle` recomputes the story id it
 *   hands to `PhaseEngine.onIdle` FRESH on every `session.idle` call:
 *
 *       const activeStory = ctx.storyEngine.getActiveStory(sid)
 *       const storyId = activeStory?.id ?? null
 *       const closed = ctx.phaseEngine.onIdle(sid, storyId, {...})
 *
 *   `StoryEngine.getActiveStory` (`src/v2/story.ts`) only ever returns a
 *   story whose `status === "active"`. The final story's verifier success
 *   (T4: execute -> elevate, recorded in `src/v2/plugin.ts`'s
 *   `tool.execute.after`) is necessarily keyed under that story's OWN id —
 *   the story is still "active" at that moment; there is no other way T4 can
 *   fire. `elicify_vertex_plan_checkpoint` -> `StoryEngine.checkpoint(...,
 *   "complete", ...)` is the ONLY thing that ever flips a story's status
 *   away from "active" — unconditionally, including for the final story,
 *   with no replacement "active" story promoted (none remain).
 *
 *   So by the time `appendJudgeCloseOut`'s OTHER precondition —
 *   `finalStory.status === "complete"` (gate.ts:146-148) — can ever be true,
 *   `getActiveStory` is *guaranteed* to return `null`. Every `session.idle`
 *   from that point on calls `phaseEngine.onIdle(sid, null, ...)`, which
 *   reads the phase keyed at `null` — a slot `onMutation`/`onVerifierOutcome`
 *   never touched (they were always keyed at the story's real id) — so it
 *   defaults to `"intake"`, not `"elevate"`. `onIdle` requires
 *   `prev === "elevate"` to do anything, so it returns `false` on every idle
 *   after the final checkpoint; `closed` is therefore always `false`, and
 *   `appendJudgeCloseOut` (gate.ts:214-216) is never invoked.
 *
 *   The mirror-image ordering (idle BEFORE checkpoint) does not help either:
 *   `onIdle` DOES close the phase in that case (the story is still "active",
 *   its key still reads "elevate"), but `appendJudgeCloseOut`'s own
 *   `finalStory.status !== "complete"` guard (gate.ts:146) then blocks it,
 *   since the checkpoint tool has not run yet. There is no ordering of hook
 *   calls that satisfies both of `appendJudgeCloseOut`'s preconditions at
 *   once — this is a structural bug, not a sequencing accident.
 *
 *   Verified empirically, not just by inspection: a standalone diagnostic
 *   driving the real hooks and reading back `src/measurement.ts`'s own
 *   `phase_transition` event log showed exactly 2 `phase_transition` events
 *   (T3, T4) and zero further transitions or `vertex-judge`
 *   `session.prompt` calls, in BOTH call orders (idle-then-checkpoint and
 *   checkpoint-then-idle).
 *
 *   Likely one-line fix direction (NOT applied here — out of scope for an
 *   integration-test-only wave; this wave was told to write a test and
 *   report a suspected bug, not fix `src/`): resolve `storyId` in
 *   `handleSessionIdle` as `activeStory?.id ?? plan?.finalStoryId ?? null`
 *   (falling back to the plan's final story once no story remains active)
 *   instead of only `activeStory?.id ?? null`.
 *
 *   The judge MODULE itself (`src/v2/judge.ts`) is independently covered and
 *   passing in `tests/v2/judge.test.ts` — this file only exercises the
 *   WIRING path (this wave's explicit target), and that is where the defect
 *   lives. Every failing assertion below is annotated `// BUG:` at the exact
 *   point it demonstrates this — assertions are written to the SPEC, not
 *   weakened to match the buggy behaviour, so these tests become meaningful
 *   regressions the moment the wiring is fixed.
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

/** Structural type for the `vi.spyOn(VerificationReceiptStore.prototype,
 * "record")` spy — loose on purpose so it doesn't fight vitest's own
 * `MockInstance` generic variance; only `.mock.results[].value` is read. */
type ReceiptRecordSpy = { mock: { results: Array<{ value: unknown }> } }

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

function makeStubClient(
  opts: {
    promptText?: (agent: string | undefined) => string
    promptImpl?: (args: PromptArgs) => Promise<PromptResult>
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
): Promise<{ storyId: string; itemId: string; receiptId: string }> {
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
        },
      ],
    },
    sessionID,
  )
  const plan = JSON.parse(createRaw) as { stories: Array<{ id: string; acceptanceItems: Array<{ id: string }> }> }
  const storyId = plan.stories[0].id
  const itemId = plan.stories[0].acceptanceItems[0].id

  await toolAfter(hooks, sessionID, "edit", { filePath: "src/foo.ts" }, "updated")
  await toolAfter(hooks, sessionID, "bash", { command: "npx vitest run" }, "20 passed", { exit: 0 })

  // Setup sanity check (not part of the bug demonstration): the verified
  // bash command must have actually recorded a receipt.
  expect(recordSpy.mock.results.length).toBeGreaterThan(0)
  const lastResult = recordSpy.mock.results[recordSpy.mock.results.length - 1]
  const receiptId = (lastResult.value as { id: string }).id

  return { storyId, itemId, receiptId }
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

    const { storyId, itemId, receiptId } = await setUpFinalStoryVerified(
      hooks,
      sid,
      { providerID: "minimax", id: "MiniMax-M3" },
      recordSpy,
    )

    const checkpointRaw = await callTool(
      hooks,
      "elicify_vertex_plan_checkpoint",
      { storyId, status: "complete", items: [{ id: itemId, receiptId }] },
      sid,
    )
    const checkpointed = JSON.parse(checkpointRaw) as { stories: Array<{ status: string }> }
    // Setup sanity check (not the bug under test): the checkpoint call
    // itself is pure evidence validation and always succeeds here.
    expect(checkpointed.stories[0].status).toBe("complete")

    vi.useFakeTimers()
    const idlePromise = idle(hooks, sid)
    // Advance well past the judge's total 5s budget so a hang-past-timeout
    // subturn (if one is ever actually issued once the wiring bug below is
    // fixed) resolves via its own internal timeout instead of really
    // waiting 5 real seconds.
    await vi.advanceTimersByTimeAsync(JUDGE_TOTAL_BUDGET_MS + 1000)
    await idlePromise // must not hang the test either way
    vi.useRealTimers()

    const events = readEvents()
    // BUG (confirmed — see this file's header): appendJudgeCloseOut is never
    // reached (the storyId/getActiveStory mismatch in
    // src/v2/wiring/gate.ts's handleSessionIdle prevents T7 from ever firing
    // once the final story is checkpointed complete), so the judge subturn
    // is never invoked at all and this event is never logged.
    expect(events.some((e) => e.event_type === "judge:unavailable")).toBe(true)

    // BUG (same root cause): no vertex-judge child session is ever created,
    // so there is nothing to clean up.
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
          return { data: { info: {}, parts: [{ type: "text", text: '{"fit":"pass","notes":"looks fine"}' }] }, error: undefined }
        }
        return { data: { info: {}, parts: [{ type: "text", text: '{"multiStory":false}' }] }, error: undefined }
      },
    })
    const recordSpy = vi.spyOn(VerificationReceiptStore.prototype, "record")
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "judge-model-default-session"

    const { storyId, itemId, receiptId } = await setUpFinalStoryVerified(
      hooks,
      sid,
      { providerID: "minimax", id: "MiniMax-M3" },
      recordSpy,
    )

    const checkpointRaw = await callTool(
      hooks,
      "elicify_vertex_plan_checkpoint",
      { storyId, status: "complete", items: [{ id: itemId, receiptId }] },
      sid,
    )
    expect((JSON.parse(checkpointRaw) as { stories: Array<{ status: string }> }).stories[0].status).toBe("complete")

    await idle(hooks, sid)

    const calls = judgePromptCalls(client)
    // BUG (confirmed — see this file's header): the judge subturn is never
    // issued at all through the real wiring, so there is no vertex-judge
    // session.prompt call to inspect.
    expect(calls.length).toBe(1)
    expect(calls[0]?.body?.model).toEqual({ providerID: "minimax", modelID: "MiniMax-M3" })

    expect(client.session.create).toHaveBeenCalledTimes(1)
    const createArgs = client.session.create.mock.calls[0]?.[0] as { body?: { parentID?: string } } | undefined
    expect(createArgs?.body?.parentID).toBe(sid)
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
        return { data: { info: {}, parts: [{ type: "text", text: '{"fit":"pass","notes":"fallback worked"}' }] }, error: undefined }
      },
    })
    const recordSpy = vi.spyOn(VerificationReceiptStore.prototype, "record")
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), { judgeModel: "provider-x/model-y" } as never)
    const sid = "judge-model-fallback-session"

    const { storyId, itemId, receiptId } = await setUpFinalStoryVerified(
      hooks,
      sid,
      { providerID: "minimax", id: "MiniMax-M3" },
      recordSpy,
    )

    const checkpointRaw = await callTool(
      hooks,
      "elicify_vertex_plan_checkpoint",
      { storyId, status: "complete", items: [{ id: itemId, receiptId }] },
      sid,
    )
    expect((JSON.parse(checkpointRaw) as { stories: Array<{ status: string }> }).stories[0].status).toBe("complete")

    await idle(hooks, sid)

    const calls = judgePromptCalls(client)
    // BUG (confirmed — see this file's header): unreachable through the real
    // wiring, so neither the override attempt nor its session-model retry
    // is ever issued.
    expect(calls.length).toBe(2)
    expect(calls[0]?.body?.model).toEqual({ providerID: "provider-x", modelID: "model-y" })
    expect(calls[1]?.body?.model).toEqual({ providerID: "minimax", modelID: "MiniMax-M3" })

    const continuationTexts = idleContinuationTexts(client, sid)
    expect(continuationTexts.some((t) => t.includes("fallback worked"))).toBe(true)
  })
})

// ===========================================================================
// Test 51: judge_verdict_appended_happy_path (FR-030)
// ===========================================================================

describe("test 51: judge_verdict_appended_happy_path", () => {
  it("a concern verdict never gates the checkpoint, and its notes reach the close-out continuation", async () => {
    const client = makeStubClient({
      promptImpl: async (args) => {
        if (args.body?.agent === "vertex-judge") {
          return {
            data: { info: {}, parts: [{ type: "text", text: '{"fit":"concern","notes":"criterion 2 evidence is type-only"}' }] },
            error: undefined,
          }
        }
        return { data: { info: {}, parts: [{ type: "text", text: '{"multiStory":false}' }] }, error: undefined }
      },
    })
    const recordSpy = vi.spyOn(VerificationReceiptStore.prototype, "record")
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "judge-happy-path-session"

    const { storyId, itemId, receiptId } = await setUpFinalStoryVerified(
      hooks,
      sid,
      { providerID: "anthropic", id: "claude-fable-5" },
      recordSpy,
    )

    const checkpointRaw = await callTool(
      hooks,
      "elicify_vertex_plan_checkpoint",
      { storyId, status: "complete", items: [{ id: itemId, receiptId }] },
      sid,
    )
    const checkpointed = JSON.parse(checkpointRaw) as { stories: Array<{ status: string }> }
    // The story checkpoint is validated purely on evidence (FR-019/FR-020)
    // BEFORE the judge ever runs, so it always succeeds regardless of the
    // eventual verdict — and regardless of the wiring bug below. This
    // assertion passes today.
    expect(checkpointed.stories[0].status).toBe("complete")

    await idle(hooks, sid)

    // BUG (confirmed — see this file's header): appendJudgeCloseOut
    // (src/v2/wiring/gate.ts:142-177) is never reached, so the verdict's
    // notes never reach any session.prompt continuation. Wave 3's report
    // hypothesized the close-out mechanism is a same-session
    // `client.session.prompt` continuation with no `body.agent` set, whose
    // text is `` `[vertex:judge] fit=${verdict.fit} — ${verdict.notes}` ``
    // (gate.ts:172-176) — reading the source confirms that mechanism SHAPE
    // is correct, but it is unreachable dead code given the storyId bug.
    const continuationTexts = idleContinuationTexts(client, sid)
    expect(continuationTexts.some((t) => t.includes("criterion 2 evidence is type-only"))).toBe(true)
    expect(continuationTexts.some((t) => t.startsWith("[vertex:judge] fit=concern"))).toBe(true)
  })
})
