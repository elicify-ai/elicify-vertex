/**
 * Wave-4 integration tests — verify-gap, EXPECT/anomaly, elevate, story
 * scope, compliance join, per-story phase.
 *
 * Covers TDD Plan tests 23, 24, 25, 26, 27, 28, 30, 49 against the
 * ALREADY-WIRED `ElicifyVertexPluginV2` plugin (`src/v2/plugin.ts`). This
 * file does not modify anything under `src/` — where the wired behavior
 * appears to diverge from `docs/vertex2-spec.md`, the divergence is
 * demonstrated with `it.fails(...)` (vitest's "expected to fail" test — the
 * wrapper itself is reported as PASSING as long as the inner assertion
 * throws; if a later fix wave makes the assertion true, `it.fails` starts
 * failing, which is the intended signal to flip it back to a normal `it`)
 * rather than by weakening an assertion or touching `src/`.
 *
 * The harness pattern (`makeStubClient`, `pluginInput`, `activate`,
 * `transform`, `toolAfter`, `completeText`, `idle`, `idleContinuationTexts`)
 * is COPIED from `tests/v2/plugin.integration.test.ts` rather than imported
 * — three sibling wave-4 agents are writing their own integration test files
 * in parallel against the same source file, so importing from it while it is
 * under concurrent edit would race.
 *
 * Dosing (FR-028/FR-029): `src/v2/dosing.ts`'s built-in table maps
 * `anthropic/claude-fable-5` (the model `plugin.integration.test.ts`'s
 * shared harness defaults to) to the `frontier` profile, which *reduces* or
 * suppresses several of the directive families this file asserts on
 * (verify-gap -> "only on a relevance gap", elevate -> "rubric + taste pass
 * only", not the full O-D-P-E / criteria-replay text the BDD scenarios and
 * task brief describe). To get the deterministic, undosed "full" form these
 * tests assert against, every `transform()`/`activate()` call in this file
 * defaults to `minimax/MiniMax-M3`, which `dosing.ts`'s table maps to
 * `standard` (Dataset: Dosing profiles, row 3).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import type { Agent } from "@opencode-ai/sdk"

import { ElicifyVertexPluginV2 } from "../../src/v2/plugin.js"
import { eventsPath } from "../../src/measurement.js"

// ---------------------------------------------------------------------------
// Shared stub client — copied from tests/v2/plugin.integration.test.ts (see
// that file's header comment for why it mirrors subturn.test.ts's SDK
// `{data,error}` fields-style shape). One difference: `session.messages`
// here resolves a real `role: "user"` message by default so
// `elicify_vertex_plan_checkpoint`'s waiver-provenance check (src/v2/wiring
// /tools.ts's `isUserMessage`) can be exercised without a bespoke per-test
// stub — none of the other wave-4 files need this, hence not upstreamed.
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
  const sessionMessages = vi.fn(async () => ({
    data: [{ info: { id: "user-msg-1", role: "user" } }],
    error: undefined,
  }))
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
let vertexDataDir: string
let savedVertexData: string | undefined

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "vertex-v2-storyverify-work-"))
  vertexDataDir = mkdtempSync(join(tmpdir(), "vertex-v2-storyverify-events-"))
  savedVertexData = process.env.VERTEX_DATA
  process.env.VERTEX_DATA = vertexDataDir
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
  rmSync(vertexDataDir, { recursive: true, force: true })
  if (savedVertexData === undefined) delete process.env.VERTEX_DATA
  else process.env.VERTEX_DATA = savedVertexData
  delete process.env.VERTEX_V2
  delete process.env.VERTEX_JUDGE
  delete process.env.VERTEX_HOLDOUT
})

function pluginInput(client: unknown): PluginInput {
  return { client, directory: workDir, worktree: workDir } as unknown as PluginInput
}

/** Standard-profile model (Dataset: Dosing profiles row 3) — see file header. */
const STANDARD_MODEL = { providerID: "minimax", id: "MiniMax-M3" }

async function activate(
  hooks: Hooks,
  sessionID: string,
  text: string,
  model: { providerID: string; id: string } = STANDARD_MODEL,
) {
  await hooks["chat.message"]!(
    { sessionID, agent: "elicify-vertex-agent", model: { providerID: model.providerID, modelID: model.id } } as never,
    { message: {} as never, parts: [{ type: "text", text } as never] },
  )
}

async function transform(
  hooks: Hooks,
  sessionID: string,
  model: { providerID: string; id: string } = STANDARD_MODEL,
): Promise<{ system: string[] }> {
  const out = { system: [] as string[] }
  await hooks["experimental.chat.system.transform"]!(
    { sessionID, model: { providerID: model.providerID, id: model.id } } as never,
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
 * (subturn requests always do) — mirrors plugin.integration.test.ts's helper. */
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

function toolContext(sessionID: string) {
  return {
    sessionID,
    messageID: `tool-msg-${sessionID}`,
    agent: "elicify-vertex-agent",
    directory: workDir,
    worktree: workDir,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  } as never
}

interface RawEvent {
  ts: string
  session_id: string
  holdout_arm: string
  event_type: string
  payload: Record<string, unknown>
  model?: string
  profile?: string
}

/** Reads every event appended (via `src/measurement.ts`'s real `appendEvent`)
 * under this test's `VERTEX_DATA`-scoped `.vertex-events.jsonl`. Used to
 * assert `calibration` (test 25), `directive_complied` (test 30), and
 * `phase_transition` (test 26/49) events — genuine out-of-band records, not
 * a mock. */
function readEvents(): RawEvent[] {
  const p = eventsPath()
  if (!existsSync(p)) return []
  return readFileSync(p, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RawEvent)
}

/** Splits `formatDirectives`' `<vertex-directives>` envelope (src/index.ts)
 * back into `{id, text}` blocks, matching its own construction exactly
 * (`[${d.id}]\n${text}` bodies joined by `\n\n---\n\n`). Used by test 30 to
 * recover a rendered finding's `instanceId` from directive text alone —
 * `RenderResult` itself never crosses the `system.transform` hook boundary. */
function parseDirectiveBlocks(system: string[]): Array<{ id: string; text: string }> {
  const joined = system.join("\n")
  const match = /<vertex-directives>\n([\s\S]*?)\n<\/vertex-directives>/.exec(joined)
  if (!match) return []
  return match[1].split("\n\n---\n\n").map((block) => {
    const m = /^\[([^\]]+)\]\n([\s\S]*)$/.exec(block)
    return m ? { id: m[1], text: m[2] } : { id: "", text: block }
  })
}

const DEEP_ASK = "refactor the auth database migration end to end"

// ===========================================================================
// Test 23: verify_gap_end_to_end
// ===========================================================================

describe("test 23: verify_gap_end_to_end", () => {
  it("mutate -> transform() renders a verify-gap directive with all grammar slots and a real resolved command", async () => {
    // Tier-3 fixture (resolve.ts): a package.json with a `test` script, no
    // story verifiers and no matching test-file convention in the worktree,
    // so resolveVerifier degrades to the package-script tier ("npm test").
    writeFileSync(
      join(workDir, "package.json"),
      JSON.stringify({ name: "fixture", private: true, scripts: { test: "vitest run" } }, null, 2),
    )

    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "verify-gap-session"

    await activate(hooks, sid, DEEP_ASK)
    await toolAfter(hooks, sid, "edit", { filePath: "src/lexer.ts" }, "updated")

    const result = await transform(hooks, sid)
    const text = result.system.join("\n")

    expect(text).toContain("Observed:")
    expect(text).toContain("src/lexer.ts")
    expect(text).toContain("Diagnosis:")
    expect(text).toContain("Do now:")
    // Real resolved command from resolve.ts's tier 3 (package-manifest scripts).
    expect(text).toContain("npm test")
  })
})

// ===========================================================================
// Test 24: expect_interrupt_lifecycle
// ===========================================================================

describe("test 24: expect_interrupt_lifecycle", () => {
  it("EXPECT capture -> failing verifier -> anomaly interrupt quotes the expectation and the observed summary", async () => {
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "expect-interrupt-session"

    await activate(hooks, sid, DEEP_ASK)
    await toolAfter(hooks, sid, "edit", { filePath: "src/parser.ts" }, "updated")
    await completeText(hooks, sid, "EXPECT: all 18 tests pass")

    // Failing verifier: exit 1 and a recognizable failure pattern in output.
    await toolAfter(
      hooks,
      sid,
      "bash",
      { command: "npx vitest run" },
      "FAIL tests/parser.test.ts\n2 tests failed",
      { exit: 1 },
    )

    const result = await transform(hooks, sid)
    const text = result.system.join("\n")

    expect(text).toContain('"all 18 tests pass"')
    expect(text).toContain("FAIL tests/parser.test.ts")
    expect(text.toLowerCase()).toContain("what belief is now false")
  })
})

// ===========================================================================
// Test 25: calibration_event_logged
// ===========================================================================

describe("test 25: calibration_event_logged", () => {
  it("EXPECT [high] + passing verifier -> no interrupt, and a calibration event logs {declared: high, observed: pass}", async () => {
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "calibration-session"

    await activate(hooks, sid, DEEP_ASK)
    await toolAfter(hooks, sid, "edit", { filePath: "src/parser.ts" }, "updated")
    await completeText(hooks, sid, "EXPECT [high]: all pass")

    await toolAfter(hooks, sid, "bash", { command: "npx vitest run" }, "20 passed", { exit: 0 })

    const result = await transform(hooks, sid)
    const text = result.system.join("\n")
    expect(text).not.toContain("what belief is now false")
    expect(text).not.toContain("You expected:")

    const calibrationEvents = readEvents().filter(
      (e) => e.event_type === "calibration" && e.session_id === sid,
    )
    expect(calibrationEvents.length).toBeGreaterThanOrEqual(1)
    expect(calibrationEvents[0].payload).toMatchObject({ declared: "high", observed: "pass" })
  })
})

// ===========================================================================
// Test 26 / 49: elevate_once_per_turn + phase_and_elevate_per_story
// ===========================================================================

describe("test 26: elevate_once_per_turn", () => {
  it("green bound verifier -> exactly one elevate directive; a second green run the same turn injects nothing further", async () => {
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "elevate-once-session"

    await activate(hooks, sid, DEEP_ASK)
    await completeText(hooks, sid, "CRITERIA:\n1. parser handles nesting")
    await toolAfter(hooks, sid, "edit", { filePath: "src/parser.ts" }, "updated")
    await toolAfter(hooks, sid, "bash", { command: "npx vitest run" }, "5 passed", { exit: 0 })

    const first = await transform(hooks, sid)
    const firstText = first.system.join("\n")
    expect(firstText).toContain("Replay each criterion against its evidence")
    expect(firstText).toContain("Sweep adjacent findings")
    expect(firstText.toLowerCase()).toContain("taste pass")

    // Second passing verifier in the same turn: phase is already "elevate",
    // so onVerifierOutcome's T4 guard (source must be "execute") no-ops.
    await toolAfter(hooks, sid, "bash", { command: "npx vitest run" }, "5 passed", { exit: 0 })
    const second = await transform(hooks, sid)
    expect(second.system.length).toBe(0)
  })

  it("does not elevate on an intermediate story's green; elevates exactly once when the final story's verifier passes (also test 49: phase is story-scoped, not session-wide)", async () => {
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "three-story-session"

    await activate(hooks, sid, DEEP_ASK)

    const plan = JSON.parse(
      (await hooks.tool!.elicify_vertex_plan_create.execute(
        {
          stories: [
            { text: "story one", acceptanceItems: ["done"], scopeGlobs: [], verifiers: ["npx vitest run tests/s1.test.ts"] },
            { text: "story two", acceptanceItems: ["done"], scopeGlobs: [], verifiers: ["npx vitest run tests/s2.test.ts"] },
            { text: "story three", acceptanceItems: ["done"], scopeGlobs: [], verifiers: ["npx vitest run tests/s3.test.ts"] },
          ],
        },
        toolContext(sid),
      )) as string,
    ) as { finalStoryId: string; stories: Array<{ id: string }> }
    expect(plan.finalStoryId).toBe("S3")

    // Story 1 (active, non-final) goes green.
    await toolAfter(hooks, sid, "edit", { filePath: "src/s1.ts" }, "updated")
    await toolAfter(hooks, sid, "bash", { command: "npx vitest run tests/s1.test.ts" }, "1 passed", { exit: 0 })

    const intermediateResult = await transform(hooks, sid)
    const intermediateText = intermediateResult.system.join("\n")
    expect(intermediateText).not.toContain("Sweep adjacent findings")

    // Advance to the final story via waiver-evidenced checkpoints (FR-020's
    // observed-receipt bar applies only to the FINAL story; a non-final
    // story's acceptance items may be waived).
    await hooks.tool!.elicify_vertex_plan_checkpoint.execute(
      { storyId: "S1", status: "complete", items: [{ id: "A1", waiverSourceMessageId: "user-msg-1" }] },
      toolContext(sid),
    )
    await hooks.tool!.elicify_vertex_plan_checkpoint.execute(
      { storyId: "S2", status: "complete", items: [{ id: "A1", waiverSourceMessageId: "user-msg-1" }] },
      toolContext(sid),
    )

    // Story 3 (final) is now active; its green verifier covers the plan.
    await toolAfter(hooks, sid, "edit", { filePath: "src/s3.ts" }, "updated")
    await toolAfter(hooks, sid, "bash", { command: "npx vitest run tests/s3.test.ts" }, "1 passed", { exit: 0 })

    const finalResult = await transform(hooks, sid)
    const finalText = finalResult.system.join("\n")
    expect(finalText).toContain("Sweep adjacent findings")

    // Story-scoped phase (test 49): the two "intake -> execute" (T3)
    // transitions were recorded against DIFFERENT storyIds (S1, then S3),
    // and the "execute -> elevate" (T4) transition that produced the
    // elevate directive above is recorded against S3 specifically — not a
    // single session-wide phase value.
    const transitions = readEvents().filter((e) => e.event_type === "phase_transition" && e.session_id === sid)
    const storyIdsTouched = new Set(transitions.map((e) => e.payload.storyId))
    expect(storyIdsTouched.has("S1")).toBe(true)
    expect(storyIdsTouched.has("S3")).toBe(true)
    const t4ForS3 = transitions.find(
      (e) => e.payload.storyId === "S3" && e.payload.from === "execute" && e.payload.to === "elevate",
    )
    expect(t4ForS3).toBeDefined()
    // S1 never itself recorded an execute->elevate arc (its green run was
    // non-final, so onVerifierOutcome's T4 branch never fired for S1).
    const t4ForS1 = transitions.find((e) => e.payload.storyId === "S1" && e.payload.to === "elevate")
    expect(t4ForS1).toBeUndefined()
  })

  // -------------------------------------------------------------------------
  // FIXED (T8): src/v2/wiring/tools.ts's checkpointTool now calls
  // PhaseEngine.onStoryAdvance(sessionID, fromStoryId, toStoryId) whenever a
  // non-final story checkpoints complete and StoryEngine promotes a
  // successor to active, logging the T8 phase_transition. Traces to BDD
  // "Intermediate story green does not elevate a multi-story plan"
  // (docs/vertex2-spec.md, US-7) and test 49 (phase_and_elevate_per_story).
  // -------------------------------------------------------------------------

  it(
    "an intermediate story's green verifier renders a story-completion directive naming the next story",
    async () => {
      const client = makeStubClient()
      const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
      const sid = "story-completion-directive-session"

      await activate(hooks, sid, DEEP_ASK)
      await hooks.tool!.elicify_vertex_plan_create.execute(
        {
          stories: [
            { text: "story one", acceptanceItems: ["done"], scopeGlobs: [], verifiers: ["npx vitest run tests/s1.test.ts"] },
            { text: "story two", acceptanceItems: ["done"], scopeGlobs: [], verifiers: ["npx vitest run tests/s2.test.ts"] },
          ],
        },
        toolContext(sid),
      )

      await toolAfter(hooks, sid, "edit", { filePath: "src/s1.ts" }, "updated")
      await toolAfter(hooks, sid, "bash", { command: "npx vitest run tests/s1.test.ts" }, "1 passed", { exit: 0 })

      const result = await transform(hooks, sid)
      const text = result.system.join("\n").toLowerCase()
      // Per the BDD scenario's literal text: "a story-completion directive
      // naming story 2 renders instead" of elevate.
      expect(text).toMatch(/story\s*2|story two/)
      expect(text).toContain("complet")
    },
  )

  it(
    "checkpointing a non-final story complete logs the T8 phase_transition for the newly-active story",
    async () => {
      const client = makeStubClient()
      const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
      const sid = "t8-story-advance-session"

      await activate(hooks, sid, DEEP_ASK)
      await hooks.tool!.elicify_vertex_plan_create.execute(
        {
          stories: [
            { text: "story one", acceptanceItems: ["done"], scopeGlobs: [], verifiers: [] },
            { text: "story two", acceptanceItems: ["done"], scopeGlobs: [], verifiers: [] },
          ],
        },
        toolContext(sid),
      )

      await hooks.tool!.elicify_vertex_plan_checkpoint.execute(
        { storyId: "S1", status: "complete", items: [{ id: "A1", waiverSourceMessageId: "user-msg-1" }] },
        toolContext(sid),
      )

      const transitions = readEvents().filter((e) => e.event_type === "phase_transition" && e.session_id === sid)
      const t8 = transitions.find((e) => e.payload.trigger === "T8")
      expect(t8).toBeDefined()
    },
  )
})

// ===========================================================================
// Test 27: plan_propose_confirm_create
// ===========================================================================

describe("test 27: plan_propose_confirm_create", () => {
  it("multi-story classification -> proposal directive prompts the model to propose a split and call the create tool; no plan file is written first", async () => {
    const client = makeStubClient({
      promptText: (agent) => (agent === "vertex-intake" ? '{"multiStory":true}' : '{"multiStory":false}'),
    })
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "plan-propose-session"

    // Dataset: Intake pre-filter row 5 — short but non-trivial, reaches the
    // classifier regardless of the (stubbed) heuristic outcome.
    await activate(hooks, sid, "add caching and fix the flaky test")

    const result = await transform(hooks, sid)
    const text = result.system.join("\n")

    // The plan-proposal Finding does NOT itself contain a generated story
    // list (StoryEngine.proposePlan is deliberately not auto-called — see
    // src/v2/wiring/findings.ts's module header). Per the task brief, the
    // correct assertion is that the directive TEXT prompts the model to
    // propose the split and invoke the create tool directly.
    expect(text).toContain("Propose a story-by-story split")
    expect(text.toLowerCase()).toContain("confirm")
    expect(text).toContain("elicify_vertex_plan_create")

    // No plan file written before the create tool is invoked.
    expect(existsSync(join(workDir, ".opencode", "elicify-vertex", "plan.json"))).toBe(false)
    const status = await hooks.tool!.elicify_vertex_plan_status.execute({}, toolContext(sid))
    expect(status).toBe("null")
  })
})

// ===========================================================================
// Test 28: scope_directive_no_block
// ===========================================================================

describe("test 28: scope_directive_no_block", () => {
  it("out-of-scope mutation queues a fold/amend/revert directive but never blocks session.idle", async () => {
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "scope-no-block-session"

    await activate(hooks, sid, DEEP_ASK)
    await hooks.tool!.elicify_vertex_plan_create.execute(
      { stories: [{ text: "parser work", acceptanceItems: ["done"], scopeGlobs: ["src/parser/**"], verifiers: [] }] },
      toolContext(sid),
    )

    // In-scope mutation first: discharges the one-shot pre-commitment finding
    // so it does not out-compete scope-watchdog for the render budget later.
    await toolAfter(hooks, sid, "edit", { filePath: "src/parser/a.ts" }, "updated")
    await transform(hooks, sid)

    // Out-of-scope mutation: phase is already "execute" so pre-commitment
    // does not re-fire; only verify-gap (correction) and scope-watchdog
    // (phase-guidance) compete for the budget=2 invocation slots.
    await toolAfter(hooks, sid, "edit", { filePath: "src/cli.ts" }, "updated")

    const result = await transform(hooks, sid)
    const text = result.system.join("\n")
    expect(text).toContain("src/cli.ts")
    expect(text).toContain("fold")
    expect(text).toContain("amend")
    expect(text).toContain("revert")

    // Verify after the last change so v1's zero-criteria fallback (an
    // unrelated blocking path) does not confound "no block for scope alone".
    await toolAfter(hooks, sid, "bash", { command: "npx vitest run" }, "3 passed", { exit: 0 })

    await idle(hooks, sid)
    expect(idleContinuationTexts(client, sid).length).toBe(0)
  })
})

// ===========================================================================
// Test 30: directive_compliance_join
// ===========================================================================

describe("test 30: directive_compliance_join", () => {
  it("the exact prescribed command observed passing in the same turn logs directive_complied referencing the rendered instance id", async () => {
    mkdirSync(join(workDir, "tests"), { recursive: true })
    writeFileSync(join(workDir, "tests", "lexer.test.ts"), 'import { test } from "vitest"\ntest("x", () => {})\n')

    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "compliance-join-session"

    await activate(hooks, sid, DEEP_ASK)
    await toolAfter(hooks, sid, "edit", { filePath: "src/lexer.ts" }, "updated")

    const rendered = await transform(hooks, sid)
    const blocks = parseDirectiveBlocks(rendered.system)
    const verifyGapBlock = blocks.find((b) => b.text.includes("tests/lexer.test.ts"))
    expect(verifyGapBlock).toBeDefined()
    expect(verifyGapBlock!.text).toContain("Do now: Run npx vitest run tests/lexer.test.ts")
    const instanceId = verifyGapBlock!.id
    expect(instanceId).toMatch(/^D-\d+$/)

    // The EXACT prescribed command, observed passing in the same turn.
    await toolAfter(hooks, sid, "bash", { command: "npx vitest run tests/lexer.test.ts" }, "1 passed", { exit: 0 })

    const complied = readEvents().filter(
      (e) => e.event_type === "directive_complied" && e.session_id === sid && e.payload.instanceId === instanceId,
    )
    expect(complied.length).toBeGreaterThanOrEqual(1)
  })

  // ---------------------------------------------------------------------------
  // FIXED: `src/measurement.ts`'s `makeV2Event` now re-includes `family` in
  // the returned payload whenever the input carried one, matching
  // `logHoldoutSuppress`'s existing pattern (measurement.ts:415-416) — a
  // `directive_complied`/`directive_rendered` record can now be queried or
  // aggregated by family from the events log.
  // ---------------------------------------------------------------------------
  it(
    "directive_rendered/directive_complied events persist their family field",
    async () => {
      const client = makeStubClient()
      const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
      const sid = "compliance-family-payload-session"

      await activate(hooks, sid, DEEP_ASK)
      await toolAfter(hooks, sid, "edit", { filePath: "src/util.ts" }, "updated")
      await transform(hooks, sid)

      const rendered = readEvents().filter((e) => e.event_type === "directive_rendered" && e.session_id === sid)
      expect(rendered.length).toBeGreaterThan(0)
      expect(rendered[0].payload.family).toBeDefined()
    },
  )
})
