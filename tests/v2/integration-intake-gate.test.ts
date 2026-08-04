/**
 * elicify-vertex v2 — wave-4 integration tests: intake scaffold, criteria
 * pinning, idle gate (TDD Plan tests 19, 20, 21, 22, 45, 46, 50).
 * --------------------------------------------------------------------------
 * Integration tests ONLY, against the already-wired `ElicifyVertexPluginV2`.
 * Nothing under `src/` is modified by this file. Where a test's natural,
 * spec-literal setup turned out to be unreachable via the wired hook/tool
 * surface (a real wiring gap, not a test-authoring mistake), the affected
 * assertion is isolated into its own `it.fails(...)` case with a comment
 * naming the exact file/function suspected — per instructions, the passing
 * assertions are never silently weakened to paper over a discovered gap.
 *
 * Per the task brief: the harness pattern below (stub client, `pluginInput`,
 * `activate`, `transform`, `toolAfter`, `completeText`, `idle`,
 * `idleContinuationTexts`) is REPLICATED (not imported) from
 * `tests/v2/plugin.integration.test.ts` (wave 3's file) to avoid a shared-file
 * edit conflict with the other parallel wave-4 agents doing the same. Trimmed
 * to what this file needs; extended with a small `readEvents`/`compacting`
 * helper this cluster's tests require that wave 3's file didn't need.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import type { Agent } from "@opencode-ai/sdk"

import { ElicifyVertexPluginV2 } from "../../src/v2/plugin.js"
import { eventsPath, type MeasurementEvent } from "../../src/measurement.js"

// ---------------------------------------------------------------------------
// Shared stub client — replicated from tests/v2/plugin.integration.test.ts.
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

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "vertex-v2-intake-gate-test-"))
  dataDir = mkdtempSync(join(tmpdir(), "vertex-v2-intake-gate-events-"))
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
  delete process.env.VERTEX_INTAKE_SUBTURN_MAX
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

/** Not used by wave 3's file — this cluster's test 21 needs the compaction pair. */
async function compacting(hooks: Hooks, sessionID: string) {
  await hooks["experimental.session.compacting"]!({ sessionID } as never, { context: [] } as never)
}

async function compacted(hooks: Hooks, sessionID: string) {
  await hooks.event!({ event: { type: "session.compacted", properties: { sessionID } } as never })
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

/**
 * `ElicifyVertexPluginV2` builds its own internal `EventLogger`
 * (`createSharedV2Logger`, `src/v2/wiring/logger.ts`) with no injection seam
 * on the plugin's public surface (only `client`/`options` are parameters), so
 * the only way an integration test can observe logged events is the real
 * on-disk JSONL sink under `VERTEX_DATA` (`src/measurement.ts`'s
 * `eventsPath()`) — this mirrors `tests/measurement.test.ts`'s own pattern.
 */
function readEvents(sessionID?: string): MeasurementEvent[] {
  if (!existsSync(eventsPath())) return []
  const lines = readFileSync(eventsPath(), "utf8").trim().split("\n").filter(Boolean)
  const all = lines.map((l) => JSON.parse(l) as MeasurementEvent)
  return sessionID ? all.filter((e) => e.session_id === sessionID) : all
}

// ===========================================================================
// Test 19: intake_scaffold_repeats_until_captured (FR-011)
// ===========================================================================

describe("test 19: intake_scaffold_repeats_until_captured", () => {
  it("injects the intake scaffold on each of 3 consecutive turns until a CRITERIA block lands, then stops", async () => {
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "test19-session"

    // BDD "Intake scaffold repeats until criteria are captured" is explicit
    // about THREE CONSECUTIVE TURNS, not three system.transform invocations
    // of one turn — the composer's own per-turn cap (intake-scaffold: 1,
    // FR-004) would make a naive 1-activate/3-transform reading fail for
    // reasons unrelated to FR-011, so each iteration is its own turn.
    for (let turn = 1; turn <= 3; turn++) {
      await activate(hooks, sid, "implement the parser feature") // NORMAL_RE -> mode normal
      const out = await transform(hooks, sid)
      expect(out.system.join("\n")).toContain("OUTCOME:")
    }

    // Still turn 3 — capture criteria now and re-transform within the same turn.
    await completeText(hooks, sid, "CRITERIA:\n1. parser handles nesting\n2. errors point at inner token")
    const after = await transform(hooks, sid)
    expect(after.system.join("\n")).not.toContain("OUTCOME:")
  })
})

// ===========================================================================
// Test 20: criteria_idle_block_names_unmet (FR-015, FR-016)
// ===========================================================================

describe("test 20: criteria_idle_block_names_unmet", () => {
  it("idle block quotes an unmet pinned criterion and prescribes a verifier", async () => {
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "test20-partA-session"

    await activate(hooks, sid, "implement the production database migration") // DEEP_RE -> deep
    await completeText(hooks, sid, "CRITERIA:\n1. parser handles nesting\n2. errors point at inner token")
    await toolAfter(hooks, sid, "edit", { filePath: "src/foo.ts" }, "updated")
    // No verifier run -> neither criterion carries evidence.

    await idle(hooks, sid)
    const blockTexts = idleContinuationTexts(client, sid)
    expect(blockTexts.length).toBe(1)
    // `criteria.find((c) => !c.evidence)` returns the first unmet criterion in
    // pin order — C1 ("parser handles nesting") here, since neither has evidence.
    expect(blockTexts[0]).toContain("parser handles nesting")
    expect(blockTexts[0]).toContain("Run ") // a prescription from resolution, per FR-015
  })

  // FIXED (src/v2/plugin.ts `tool.execute.after`): a single passing verifier
  // used to attach evidence to EVERY currently-unevidenced pinned criterion
  // at once, making a mixed evidenced/unevidenced state (FR-015 Dataset Row
  // 1) unreachable. The fix attaches evidence to only the single OLDEST
  // unevidenced criterion (FIFO) per successful verification — no module
  // defines a real verifier-to-criterion binding (a genuine spec ambiguity),
  // so this is the closest defensible interim interpretation: N unmet
  // criteria now need N distinct passing verifications to all clear.
  it(
    "a passing verifier evidences only the oldest unevidenced criterion, leaving the next one unmet (FR-015 dataset row 1)",
    async () => {
      const client = makeStubClient()
      const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
      const sid = "test20-partB-session"

      await activate(hooks, sid, "implement the production database migration")
      await completeText(hooks, sid, "CRITERIA:\n1. parser handles nesting\n2. errors point at inner token")
      await toolAfter(hooks, sid, "edit", { filePath: "src/foo.ts" }, "updated")
      // One passing verifier evidences C1 (the oldest unmet) only.
      await toolAfter(hooks, sid, "bash", { command: "npx vitest run tests/parser" }, "5 passed", { exit: 0 })

      await idle(hooks, sid)
      const blockTexts = idleContinuationTexts(client, sid)
      // C1 is now evidenced; C2 is still unmet — exactly one block, quoting C2.
      expect(blockTexts.length).toBe(1)
      expect(blockTexts[0]).toContain("errors point at inner token")
    },
  )
})

// ===========================================================================
// Test 21: criteria_compaction_reinjection (FR-014)
// ===========================================================================

describe("test 21: criteria_compaction_reinjection", () => {
  it("re-injects pinned criteria exactly once after session.compacted", async () => {
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "test21-session"

    await activate(hooks, sid, "implement the parser feature")
    await completeText(hooks, sid, "CRITERIA:\n1. parser handles nesting\n2. errors point at inner token")

    await compacting(hooks, sid)
    await compacted(hooks, sid)

    const first = await transform(hooks, sid)
    const firstText = first.system.join("\n")
    expect(firstText).toContain("Session state was just compacted")
    expect(firstText).toContain("C1: parser handles nesting")
    expect(firstText).toContain("C2: errors point at inner token")

    const second = await transform(hooks, sid)
    expect(second.system.join("\n")).not.toContain("Session state was just compacted")
  })
})

// ===========================================================================
// Test 22: quick_session_untouched (FR-011, FR-016)
// ===========================================================================

describe("test 22: quick_session_untouched", () => {
  it("a quick/read-only session sees no intake demand, no block, and no session.prompt continuation", async () => {
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "test22-session"

    // Matches both TRIVIAL_ASK_RE (skips the classification subturn) and
    // classifyStopMode's "quick" default (no readOnlyIntent/DEEP/QUICK/NORMAL
    // keyword hit falls through to the quick default).
    await activate(hooks, sid, "what does this function do?")

    const out = await transform(hooks, sid)
    expect(out.system).toEqual([])

    await idle(hooks, sid)
    expect(idleContinuationTexts(client, sid).length).toBe(0)
    // Nothing in this scenario should ever call session.prompt at all: no
    // classification subturn (TRIVIAL_ASK_RE-skipped) and no idle block.
    expect(client.session.prompt.mock.calls.length).toBe(0)
  })

  // FIXED (src/v2/wiring/gate.ts `handleCriteriaReplay`): FR-016 states
  // "Quick and normal modes MUST never hard-block" as an unconditional
  // functional requirement, and FR-015's criteria-block branch is scoped to
  // "session.idle on deep tasks with mutations" — but `handleCriteriaReplay`
  // (called whenever `pinStore.get(sid).length > 0`, from
  // `handleSessionIdle`) used to never read `evidenceLedger.getMode(sid)`
  // and never check for docs-only-changed-files before blocking; it blocked
  // purely on "does >=1 pinned criterion lack evidence", for ANY mode. It now
  // checks `evidenceLedger.getMode(sid) === "deep"` and the docs-only
  // exemption BEFORE ever looking at criteria evidence (mirroring how
  // `handleZeroCriteriaFallback` gets the same two exemptions for free via
  // `EvidenceLedger.shouldBlockStop`), so a quick-mode session with a
  // spontaneously-pinned, unevidenced criterion and zero mutations no longer
  // gets hard-blocked at idle.
  it(
    "quick mode with pinned-but-unevidenced criteria never hard-blocks at idle (FR-016)",
    async () => {
      const client = makeStubClient()
      const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
      const sid = "test22-quick-with-criteria-session"

      await activate(hooks, sid, "what does this function do?") // quick mode, no mutations
      await completeText(hooks, sid, "CRITERIA:\n1. parser handles nesting")

      await idle(hooks, sid)
      // FR-016: quick mode must never hard-block.
      expect(idleContinuationTexts(client, sid).length).toBe(0)
    },
  )
})

// ===========================================================================
// Test 45: idle_all_criteria_evidenced_closes (FR-001 T7, FR-015)
// ===========================================================================

describe("test 45: idle_all_criteria_evidenced_closes", () => {
  it("closes without blocking, and logs no block-style event, once every pinned criterion carries evidence", async () => {
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "test45-session"

    await activate(hooks, sid, "implement the production database migration") // deep
    await completeText(hooks, sid, "CRITERIA:\n1. parser handles nesting\n2. errors point at inner token")
    await toolAfter(hooks, sid, "edit", { filePath: "src/foo.ts" }, "updated")
    // Evidence now attaches to only the oldest unevidenced criterion per
    // passing verifier (see test 20's fix note) — two distinct passing
    // verifications are needed to evidence both C1 and C2.
    await toolAfter(hooks, sid, "bash", { command: "npx vitest run" }, "20 passed", { exit: 0 })
    await toolAfter(hooks, sid, "bash", { command: "npx vitest run" }, "20 passed", { exit: 0 })

    await idle(hooks, sid)

    expect(idleContinuationTexts(client, sid).length).toBe(0)

    const events = readEvents(sid)
    // No event type in the v2 vocabulary spells "block" — this asserts the
    // absence of anything block-shaped rather than one specific literal name.
    const blockish = events.filter((e) => /block/i.test(String(e.event_type)))
    expect(blockish.length).toBe(0)

    const closeTransition = events.find(
      (e) =>
        e.event_type === "phase_transition" &&
        (e.payload as { from?: string; to?: string })?.from === "elevate" &&
        (e.payload as { from?: string; to?: string })?.to === "close",
    )
    expect(closeTransition).toBeTruthy()
  })
})

// ===========================================================================
// Test 46: precommitment_prompt_on_execute_entry (FR-023a)
// ===========================================================================

describe("test 46: precommitment_prompt_on_execute_entry", () => {
  it("fires once on the first transform after execute entry, does not repeat that turn, and is suppressed once EXPECT exists", async () => {
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "test46-session"

    await activate(hooks, sid, "implement the parser feature")
    // Pin criteria first so the intake scaffold doesn't also compete for this
    // turn's 2-directive invocation budget — isolates the assertion below to
    // the pre-commitment family specifically.
    await completeText(hooks, sid, "CRITERIA:\n1. parser handles nesting\n2. errors point at inner token")

    await toolAfter(hooks, sid, "edit", { filePath: "src/foo.ts" }, "updated") // intake -> execute

    const first = await transform(hooks, sid)
    expect(first.system.join("\n")).toContain("EXPECT [confidence]")

    const second = await transform(hooks, sid)
    expect(second.system.join("\n")).not.toContain("EXPECT [confidence]")

    // A brand-new turn, a fresh mutation, but an EXPECT artifact already
    // exists for this new turn by the time transform() runs.
    await activate(hooks, sid, "implement the parser feature")
    await toolAfter(hooks, sid, "edit", { filePath: "src/bar.ts" }, "updated") // intake -> execute again
    await completeText(hooks, sid, "EXPECT: all tests pass")

    const third = await transform(hooks, sid)
    expect(third.system.join("\n")).not.toContain("EXPECT [confidence]")
  })

  // SUSPECTED BUG (src/v2/wiring/findings.ts `precommitmentFinding` +
  // src/v2/composer.ts `render()`'s decay path): FR-023a and the BDD scenario
  // "Pre-commitment prompt renders on execute entry" both say the composer
  // "MUST render a ONE-LINE pre-commitment prompt". `precommitmentFinding()`
  // builds a standard 3-slot Observation/Diagnosis/Prescription `Finding`
  // like every other family, and composer.ts's ONLY mechanism that collapses
  // a finding to one line is its decay path (prior-turn `recordCompliance`),
  // but no code path in src/v2/plugin.ts ever calls
  // `composer.recordCompliance(sid, "pre-commitment", ...)` — unlike
  // "intake-scaffold", "plan-proposal", and "verify-gap", which all have a
  // compliance-recording call site. So the pre-commitment prompt can never
  // decay and always renders as the full 3-line "Observed:/Diagnosis:/Do
  // now:" block on its one-and-only render, never actually one line.
  it.fails(
    "SUSPECTED BUG: the pre-commitment prompt always renders as a 3-line O-D-P block, never collapses to one line",
    async () => {
      const client = makeStubClient()
      const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
      const sid = "test46-oneline-session"

      await activate(hooks, sid, "implement the parser feature")
      await completeText(hooks, sid, "CRITERIA:\n1. parser handles nesting\n2. errors point at inner token")
      await toolAfter(hooks, sid, "edit", { filePath: "src/foo.ts" }, "updated")

      const out = await transform(hooks, sid)
      const text = out.system.join("\n")
      expect(text).toContain("EXPECT [confidence]")
      // A genuinely one-line rendering would not also carry the O-D-P headers.
      expect(text).not.toContain("Observed:")
      expect(text).not.toContain("Diagnosis:")
    },
  )
})

// ===========================================================================
// Test 50: intake_subturn_frequency_caps (FR-018b)
// ===========================================================================

describe("test 50: intake_subturn_frequency_caps", () => {
  it("issues at most 1 classification subturn per task, and never exceeds VERTEX_INTAKE_SUBTURN_MAX (3) across the whole session", async () => {
    const client = makeStubClient()
    const hooks = await ElicifyVertexPluginV2(pluginInput(client), undefined)
    const sid = "test50-session"
    const ask = "refactor auth end-to-end" // non-trivial, no TRIVIAL_ASK_RE match (spec's own worked example)

    const intakePromptCalls = () =>
      client.session.prompt.mock.calls.filter(
        (call: unknown[]) => (call[0] as { body?: { agent?: string } })?.body?.agent === "vertex-intake",
      )

    // Part 1: 4 consecutive user messages in ONE task -> exactly 1 subturn
    // (no mutation/idle in between, so the session never crosses a new-task
    // boundary — `state.classifiedThisTask` stays true after message 1).
    for (let i = 0; i < 4; i++) {
      await activate(hooks, sid, ask)
    }
    expect(intakePromptCalls().length).toBe(1)

    // Close part 1's task out (mutate -> verify(pass) -> idle drives the
    // phase execute -> elevate -> close, T4 then T7) so the very first
    // iteration of part 2 below is recognized as a genuinely NEW task by
    // src/v2/plugin.ts's `wasClose` check — without this, part 2's first
    // activate() would silently continue part 1's still-open task instead
    // of starting a new one (`state.classifiedThisTask` would stay true from
    // part 1, and the cap check inside `chat.message`'s
    // `if (!state.classifiedThisTask) { ... }` guard would never even run
    // for it — confirmed by tracing intermediate counts against this exact
    // sequence; this is the plugin's real, intentional task-boundary
    // semantics, not a bug).
    await toolAfter(hooks, sid, "edit", { filePath: "src/part1.ts" }, "updated")
    await toolAfter(hooks, sid, "bash", { command: "npx vitest run" }, "1 passed", { exit: 0 })
    await idle(hooks, sid)

    // Part 2: 5 separate NEW TASKS. src/v2/plugin.ts's chat.message handler
    // defines a new-task boundary as "phase was `close` when this user
    // message arrived" (`wasClose`, which resets `classifiedThisTask`) — so
    // each task here is closed out via mutate -> verify(pass) -> idle, which
    // drives the phase execute -> elevate -> close (T4, then T7 with zero
    // pins and a successful verification -> criteriaAllEvidenced).
    for (let task = 0; task < 5; task++) {
      await activate(hooks, sid, ask)
      await toolAfter(hooks, sid, "edit", { filePath: `src/task${task}.ts` }, "updated")
      await toolAfter(hooks, sid, "bash", { command: "npx vitest run" }, "1 passed", { exit: 0 })
      await idle(hooks, sid)
    }

    // 1 (part 1) + up to 2 more (part 2, since the session-wide cap is 3)
    // = 3 total; the remaining 3 of part 2's 5 tasks must be capped.
    expect(intakePromptCalls().length).toBe(3)

    const events = readEvents(sid)
    const capped = events.filter((e) => e.event_type === "intake:classify-capped")
    expect(capped.length).toBe(3)
  })
})
