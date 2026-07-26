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

  it("registers vertex-judge/vertex-intake with a deny map naming real built-in tools, not a bare wildcard", async () => {
    const cfgInput: { command?: Record<string, unknown>; agent?: Record<string, unknown> } = {}
    await applyV2Config(cfgInput as never, {} as OpencodeClient, "elicify-vertex")

    const judge = cfgInput.agent!["vertex-judge"] as { tools: Record<string, boolean> }
    const intake = cfgInput.agent!["vertex-intake"] as { tools: Record<string, boolean> }
    for (const toolsMap of [judge.tools, intake.tools]) {
      // Every entry present must be false (deny) — no accidental true.
      expect(Object.values(toolsMap).every((v) => v === false)).toBe(true)
      // Real built-in tool names must be explicitly covered, not just "*".
      for (const name of ["bash", "edit", "write", "read", "glob", "grep", "task", "todowrite", "skill", "webfetch"]) {
        expect(toolsMap[name]).toBe(false)
      }
      // This plugin's own plan tools (including the new clear tool) must be covered too.
      for (const name of [
        "elicify_vertex_plan_create",
        "elicify_vertex_plan_next",
        "elicify_vertex_plan_checkpoint",
        "elicify_vertex_plan_status",
        "elicify_vertex_plan_clear",
      ]) {
        expect(toolsMap[name]).toBe(false)
      }
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
