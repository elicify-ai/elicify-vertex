import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { PinStore } from "../../src/v2/pin.js"
import { StoryEngine } from "../../src/v2/story.js"
import type { OpencodeClient } from "../../src/v2/types.js"
import { applyV2Config } from "../../src/v2/wiring/config.js"
import { buildPlanTools, planSlashCommands } from "../../src/v2/wiring/tools.js"
import { PhaseEngine } from "../../src/v2/phase.js"

const roots: string[] = []

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "vertex-config-"))
  roots.push(root)
  return root
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// planSlashCommands — only /elicify-vertex-plan-clear (plan create/next/
// checkpoint/status are driven by the model calling tools directly, not by
// a human-typed slash command).
// ---------------------------------------------------------------------------

describe("planSlashCommands (2-command design)", () => {
  it("registers only plan-clear and the visibility toggle — never create/next/checkpoint/status", () => {
    const commands = planSlashCommands()
    expect(Object.keys(commands).sort()).toEqual(["elicify-vertex-plan-clear", "elicify-vertex-visibility"])
    expect(commands["elicify-vertex-plan-clear"].template).toContain("elicify_vertex_plan_clear")
  })
})

// ---------------------------------------------------------------------------
// applyV2Config — command + agent registration
// ---------------------------------------------------------------------------

describe("applyV2Config", () => {
  it("registers /elicify-vertex and /elicify-vertex-plan-clear, and no v1/legacy plan sub-commands", async () => {
    const cfgInput: { command?: Record<string, unknown>; agent?: Record<string, unknown> } = {}
    await applyV2Config(cfgInput as never, {} as OpencodeClient, "elicify-vertex")

    expect(Object.keys(cfgInput.command!).sort()).toEqual([
      "elicify-vertex",
      "elicify-vertex-plan-clear",
      "elicify-vertex-visibility",
    ])
  })

  it("registers vertex-intake fully zero-tool (wildcard permission deny), unchanged", async () => {
    const cfgInput: { command?: Record<string, unknown>; agent?: Record<string, unknown> } = {}
    await applyV2Config(cfgInput as never, {} as OpencodeClient, "elicify-vertex")

    const intake = cfgInput.agent!["vertex-intake"] as { permission: Record<string, string>; maxSteps: number }
    // The load-bearing entry: live-host testing showed the `tools` map is
    // ignored entirely and ONLY `permission: {"*": "deny"}` resolves the
    // agent to zero enabled tools (see config.ts's module header).
    expect(intake.permission["*"]).toBe("deny")
    // Kept alongside the wildcard because probeCapability requires a rule
    // *naming* each of these three to prove denial on read-back.
    expect(intake.permission.edit).toBe("deny")
    expect(intake.permission.bash).toBe("deny")
    expect(intake.permission.webfetch).toBe("deny")
    expect(intake.maxSteps).toBe(1)
  })

  it("registers vertex-judge with the HANDOVER.md point-3 read-only tool grant: read/grep/glob/list/bash allow, edit/write/webfetch/task deny, maxSteps 12", async () => {
    const cfgInput: { command?: Record<string, unknown>; agent?: Record<string, unknown> } = {}
    await applyV2Config(cfgInput as never, {} as OpencodeClient, "elicify-vertex")

    const judge = cfgInput.agent!["vertex-judge"] as { permission: Record<string, string>; maxSteps: number }
    // Base stays deny-everything; the five read-only tools are the explicit
    // carve-out (bash so the judge can re-run declared verifiers itself).
    expect(judge.permission["*"]).toBe("deny")
    for (const allowed of ["read", "grep", "glob", "list", "bash"]) {
      expect(judge.permission[allowed]).toBe("allow")
    }
    // Explicit deny entries are what JUDGE_PROBE_POLICY's denyPermissions
    // read back to prove the denial.
    for (const denied of ["edit", "write", "webfetch", "task"]) {
      expect(judge.permission[denied]).toBe("deny")
    }
    // A tool-using judge needs multiple steps (tool calls, THEN a final
    // answer) — 1 step made the granted tools useless.
    expect(judge.maxSteps).toBe(12)
  })

  it("static tools maps: intake's is fully denied; the judge's true entries are exactly the point-3 allowlist", async () => {
    const cfgInput: { command?: Record<string, unknown>; agent?: Record<string, unknown> } = {}
    await applyV2Config(cfgInput as never, {} as OpencodeClient, "elicify-vertex")

    const judge = cfgInput.agent!["vertex-judge"] as { tools: Record<string, boolean> }
    const intake = cfgInput.agent!["vertex-intake"] as { tools: Record<string, boolean> }
    // The tools map is not the control of record (the host ignores it), but
    // it must never contradict the permission block if a host DOES honour it.
    expect(Object.values(intake.tools).every((v) => v === false)).toBe(true)
    const enabled = Object.entries(judge.tools)
      .filter(([, v]) => v === true)
      .map(([k]) => k)
      .sort()
    expect(enabled).toEqual(["bash", "glob", "grep", "list", "read"])
    expect(judge.tools["*"]).toBe(false)
  })

  // Sign-off finding: KNOWN_TOOL_NAMES (this file) is hand-maintained
  // separately from buildPlanTools' actual tool map (wiring/tools.ts) and
  // nothing previously caught the two drifting apart — confirmed live when
  // elicify_vertex_plan_reopen shipped without a matching entry here. The
  // tools deny map is documented as not the real security control (the
  // permission wildcard is), so a missed entry isn't a capability hole today
  // — but it should still fail loudly rather than silently, in case a future
  // host ever does honour it.
  it("the tools deny map names every elicify_vertex_plan_* tool buildPlanTools actually registers", async () => {
    const stateDir = temporaryRoot()
    const logger = vi.fn()
    const tools = buildPlanTools({
      storyEngine: new StoryEngine({ stateDir, logger }),
      pinStore: new PinStore({ stateDir, logger }),
      client: { session: { messages: vi.fn(async () => ({ data: [], error: undefined })) } } as unknown as OpencodeClient,
      states: new Map(),
      phaseEngine: new PhaseEngine(logger),
      onPlanCreated: () => {},
    })

    const cfgInput: { command?: Record<string, unknown>; agent?: Record<string, unknown> } = {}
    await applyV2Config(cfgInput as never, {} as OpencodeClient, "elicify-vertex")
    const judge = cfgInput.agent!["vertex-judge"] as { tools: Record<string, boolean> }

    const missing = Object.keys(tools).filter((name) => !(name in judge.tools))
    expect(missing, "registered plan tools missing from the deny map").toEqual([])
  })
})

// ---------------------------------------------------------------------------
// elicify_vertex_plan_clear tool
// ---------------------------------------------------------------------------

describe("elicify_vertex_plan_clear tool", () => {
  function harness() {
    const stateDir = temporaryRoot()
    const logger = vi.fn()
    const storyEngine = new StoryEngine({ stateDir, logger })
    const pinStore = new PinStore({ stateDir, logger })
    const phaseEngine = new PhaseEngine(logger)
    const client = {
      session: { messages: vi.fn(async () => ({ data: [], error: undefined })) },
    } as unknown as OpencodeClient
    const tools = buildPlanTools({
      storyEngine,
      pinStore,
      client,
      states: new Map(),
      phaseEngine,
      onPlanCreated: () => {},
    })
    return { tools, storyEngine, pinStore }
  }

  it("clears both the plan and pinned criteria for the session, reporting what was cleared", async () => {
    const { tools, storyEngine, pinStore } = harness()
    storyEngine.createPlan("s1", [{ text: "do it", acceptanceItems: ["works"], scopeGlobs: [], verifiers: [], tasks: [{ text: "do it" }] }])
    pinStore.pin("s1", ["a pinned criterion"])

    const result = await tools.elicify_vertex_plan_clear.execute!({}, { sessionID: "s1" } as never)

    expect(JSON.parse(result as string)).toEqual({ planCleared: true, pinsCleared: true })
    expect(storyEngine.getPlan("s1")).toBeNull()
    expect(pinStore.get("s1")).toEqual([])
  })

  it("reports false/false when there was nothing to clear", async () => {
    const { tools } = harness()
    const result = await tools.elicify_vertex_plan_clear.execute!({}, { sessionID: "s1" } as never)
    expect(JSON.parse(result as string)).toEqual({ planCleared: false, pinsCleared: false })
  })

  it("does not disturb another session's plan/pins", async () => {
    const { tools, storyEngine, pinStore } = harness()
    storyEngine.createPlan("s1", [{ text: "s1 work", acceptanceItems: ["works"], scopeGlobs: [], verifiers: [], tasks: [{ text: "s1 work" }] }])
    storyEngine.createPlan("s2", [{ text: "s2 work", acceptanceItems: ["works"], scopeGlobs: [], verifiers: [], tasks: [{ text: "s2 work" }] }])
    pinStore.pin("s2", ["s2's criterion"])

    await tools.elicify_vertex_plan_clear.execute!({}, { sessionID: "s1" } as never)

    expect(storyEngine.getPlan("s2")).not.toBeNull()
    expect(pinStore.get("s2")).toHaveLength(1)
  })
})
