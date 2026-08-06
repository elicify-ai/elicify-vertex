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

    const intake = cfgInput.agent!["vertex-intake"] as { permission: Record<string, string> }
    // The load-bearing entry: live-host testing showed the `tools` map is
    // ignored entirely and ONLY `permission: {"*": "deny"}` resolves the
    // agent to zero enabled tools (see config.ts's module header).
    expect(intake.permission["*"]).toBe("deny")
    // Kept alongside the wildcard because probeCapability requires a rule
    // *naming* each of these three to prove denial on read-back.
    expect(intake.permission.edit).toBe("deny")
    expect(intake.permission.bash).toBe("deny")
    expect(intake.permission.webfetch).toBe("deny")
    // FR-008 AS2: `intake.maxSteps` is deliberately NOT asserted here — see
    // the advisory-field test below for the probe evidence.
  })

  it("registers vertex-verifier with the HANDOVER.md point-3 read-only tool grant: read/grep/glob/list/bash allow, edit/write/webfetch/task deny", async () => {
    const cfgInput: { command?: Record<string, unknown>; agent?: Record<string, unknown> } = {}
    await applyV2Config(cfgInput as never, {} as OpencodeClient, "elicify-vertex")

    const verifier = cfgInput.agent!["vertex-verifier"] as { permission: Record<string, string> }
    // Base stays deny-everything; the five read-only tools are the explicit
    // carve-out (bash so the verifier can re-run declared verifiers itself).
    expect(verifier.permission["*"]).toBe("deny")
    for (const allowed of ["read", "grep", "glob", "list", "bash"]) {
      expect(verifier.permission[allowed]).toBe("allow")
    }
    // Explicit deny entries are what VERIFIER_PROBE_POLICY's denyPermissions
    // read back to prove the denial.
    for (const denied of ["edit", "write", "webfetch", "task"]) {
      expect(verifier.permission[denied]).toBe("deny")
    }
  })

  // FR-008 (US-8 AS1/AS2, TDD row 26). The live probe of 2026-08-03
  // (spec Findings/FR-008) settled this empirically: `opencode debug agent`
  // resolves `maxSteps: None` for BOTH registrations on opencode 1.18.x,
  // and the verifier nonetheless ran 3 steps with 2 real tool calls. The
  // previous two assertions here (`toBe(12)` / `toBe(1)`) therefore asserted
  // a resolved value the host does not honour — exactly what AS2 forbids —
  // and are gone. What IS assertable is the shape: the field may be present
  // (advisory, correct per the SDK type) or absent, and either way the
  // capability control of record is the `permission` block.
  it("FR-008: maxSteps is advisory only — no resolved value is asserted, permission stays the control", async () => {
    const cfgInput: { command?: Record<string, unknown>; agent?: Record<string, unknown> } = {}
    await applyV2Config(cfgInput as never, {} as OpencodeClient, "elicify-vertex")

    for (const name of ["vertex-verifier", "vertex-intake"]) {
      const agent = cfgInput.agent![name] as { maxSteps?: number; permission: Record<string, string> }
      if (agent.maxSteps !== undefined) expect(typeof agent.maxSteps).toBe("number")
      expect(agent.permission["*"]).toBe("deny")
    }
  })

  it("static tools maps: intake's is fully denied; the verifier's true entries are exactly the point-3 allowlist", async () => {
    const cfgInput: { command?: Record<string, unknown>; agent?: Record<string, unknown> } = {}
    await applyV2Config(cfgInput as never, {} as OpencodeClient, "elicify-vertex")

    const verifier = cfgInput.agent!["vertex-verifier"] as { tools: Record<string, boolean> }
    const intake = cfgInput.agent!["vertex-intake"] as { tools: Record<string, boolean> }
    // The tools map is not the control of record (the host ignores it), but
    // it must never contradict the permission block if a host DOES honour it.
    expect(Object.values(intake.tools).every((v) => v === false)).toBe(true)
    const enabled = Object.entries(verifier.tools)
      .filter(([, v]) => v === true)
      .map(([k]) => k)
      .sort()
    expect(enabled).toEqual(["bash", "glob", "grep", "list", "read"])
    expect(verifier.tools["*"]).toBe(false)
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
      onScopeAmended: () => {},
    })

    const cfgInput: { command?: Record<string, unknown>; agent?: Record<string, unknown> } = {}
    await applyV2Config(cfgInput as never, {} as OpencodeClient, "elicify-vertex")
    const verifier = cfgInput.agent!["vertex-verifier"] as { tools: Record<string, boolean> }

    const missing = Object.keys(tools).filter((name) => !(name in verifier.tools))
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
      onScopeAmended: () => {},
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
