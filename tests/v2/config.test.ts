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
  it("registers exactly elicify-vertex-plan-clear, not create/next/checkpoint/status", () => {
    const commands = planSlashCommands()
    expect(Object.keys(commands)).toEqual(["elicify-vertex-plan-clear"])
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

    expect(Object.keys(cfgInput.command!).sort()).toEqual(["elicify-vertex", "elicify-vertex-plan-clear"])
  })

  it("registers vertex-judge/vertex-intake with the wildcard permission deny that actually delivers zero tools", async () => {
    const cfgInput: { command?: Record<string, unknown>; agent?: Record<string, unknown> } = {}
    await applyV2Config(cfgInput as never, {} as OpencodeClient, "elicify-vertex")

    const judge = cfgInput.agent!["vertex-judge"] as { permission: Record<string, string> }
    const intake = cfgInput.agent!["vertex-intake"] as { permission: Record<string, string> }
    for (const permission of [judge.permission, intake.permission]) {
      // The load-bearing entry: live-host testing showed the `tools` map is
      // ignored entirely and ONLY `permission: {"*": "deny"}` resolves the
      // agent to zero enabled tools (see config.ts's module header).
      expect(permission["*"]).toBe("deny")
      // Kept alongside the wildcard because probeCapability requires a rule
      // *naming* each of these three to prove denial on read-back.
      expect(permission.edit).toBe("deny")
      expect(permission.bash).toBe("deny")
      expect(permission.webfetch).toBe("deny")
    }
  })

  it("never registers an agent whose tools deny map contains an enabled entry", async () => {
    const cfgInput: { command?: Record<string, unknown>; agent?: Record<string, unknown> } = {}
    await applyV2Config(cfgInput as never, {} as OpencodeClient, "elicify-vertex")

    const judge = cfgInput.agent!["vertex-judge"] as { tools: Record<string, boolean> }
    const intake = cfgInput.agent!["vertex-intake"] as { tools: Record<string, boolean> }
    // The tools map is not the control of record (the host ignores it), but
    // it must never contradict the permission block if a host DOES honour it.
    for (const toolsMap of [judge.tools, intake.tools]) {
      expect(Object.values(toolsMap).every((v) => v === false)).toBe(true)
    }
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
      verificationReceipts: { get: () => undefined } as never,
      client,
      states: new Map(),
      phaseEngine,
      onPlanCreated: () => {},
    })
    return { tools, storyEngine, pinStore }
  }

  it("clears both the plan and pinned criteria for the session, reporting what was cleared", async () => {
    const { tools, storyEngine, pinStore } = harness()
    storyEngine.createPlan("s1", [{ text: "do it", acceptanceItems: ["works"], scopeGlobs: [], verifiers: [] }])
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
    storyEngine.createPlan("s1", [{ text: "s1 work", acceptanceItems: ["works"], scopeGlobs: [], verifiers: [] }])
    storyEngine.createPlan("s2", [{ text: "s2 work", acceptanceItems: ["works"], scopeGlobs: [], verifiers: [] }])
    pinStore.pin("s2", ["s2's criterion"])

    await tools.elicify_vertex_plan_clear.execute!({}, { sessionID: "s1" } as never)

    expect(storyEngine.getPlan("s2")).not.toBeNull()
    expect(pinStore.get("s2")).toHaveLength(1)
  })
})
