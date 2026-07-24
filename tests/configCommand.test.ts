import { describe, expect, it } from "vitest"
import {
  ElicifyVertexPlugin,
  VERIFICATION_CONTRACT,
  elicifyVertexSlashTemplate,
  formatActivateCue,
  formatGateContinuationText,
} from "../src/index.js"

describe("ElicifyVertexPlugin.config", () => {
  it("registers /elicify-vertex with full behavioral contract in the slash template", async () => {
    const hooks = await ElicifyVertexPlugin({} as any, undefined)
    const input: { command: Record<string, any> } = { command: {} }
    await hooks.config!(input as any)
    expect(input.command["elicify-vertex"]).toBeDefined()
    expect(input.command["elicify-vertex"].template).toContain("[vertex:contract]")
    expect(input.command["elicify-vertex"].template).toContain("Verification reminder")
    expect(input.command["elicify-vertex"].template.length).toBeGreaterThan(400)
    expect(input.command["elicify-vertex"].prompt).toBeUndefined()
    expect(input.command.vertex).toBeUndefined()
    expect(elicifyVertexSlashTemplate()).toContain(VERIFICATION_CONTRACT.slice(0, 40))
  })

  it("slash activation enables harness; system inject is dynamic not full static contract every turn", async () => {
    const hooks = await ElicifyVertexPlugin({} as any, undefined)
    const sessionID = "slash-session"
    await hooks["command.execute.before"]!({
      command: "elicify-vertex",
      sessionID,
      arguments: "verify this",
    }, { parts: [] })
    // User message after slash (any agent) — use implement so stop-mode guidance injects
    const parts = [{ type: "text", text: "implement the parser fix" } as any]
    await hooks["chat.message"]!({ sessionID, agent: "build" } as any, {
      message: {} as any,
      parts,
    })
    expect(parts.map((p: any) => p.text).join("")).toContain("[vertex] harness on")

    const output = { system: [] as string[] }
    await hooks["experimental.chat.system.transform"]!({ sessionID, model: {} as any }, output)
    const sys = output.system.join("\n")
    // Dynamic mode guidance may appear; full static contract must NOT be re-injected every turn
    expect(sys).toContain("verification-advisory")
    expect(sys).not.toContain("A passing test is not evidence until you have confirmed the test can fail")
  })

  it("does not overwrite a user-provided elicify-vertex command", async () => {
    const hooks = await ElicifyVertexPlugin({} as any, undefined)
    const userCommand = {
      description: "user override",
      template: "user template",
    }
    const input: { command: Record<string, any> } = {
      command: { "elicify-vertex": userCommand },
    }

    await hooks.config!(input as any)

    expect(input.command["elicify-vertex"]).toBe(userCommand)
  })

  it("initializes input.command when missing", async () => {
    const hooks = await ElicifyVertexPlugin({} as any, undefined)
    const input: { command?: Record<string, any> } = {}

    await hooks.config!(input as any)

    expect(input.command).toBeDefined()
    expect(input.command!["elicify-vertex"]).toBeDefined()
  })

  it("exposes create/next/checkpoint/status goal commands through the config hook", async () => {
    const hooks = await ElicifyVertexPlugin({} as any, undefined)
    const input: { command: Record<string, any> } = { command: {} }
    await hooks.config!(input as any)

    for (const name of [
      "elicify-vertex-goal-create",
      "elicify-vertex-goal-next",
      "elicify-vertex-goal-checkpoint",
      "elicify-vertex-goal-status",
    ]) {
      expect(input.command[name]?.description).toEqual(expect.any(String))
      expect(input.command[name]?.template).toEqual(expect.any(String))
      expect(input.command[name]?.prompt).toBeUndefined()
    }
  })

  it("does not overwrite user-provided goal commands", async () => {
    const hooks = await ElicifyVertexPlugin({} as any, undefined)
    const userCommand = { description: "custom", template: "custom template" }
    const input = { command: { "elicify-vertex-goal-next": userCommand } }
    await hooks.config!(input as any)
    expect(input.command["elicify-vertex-goal-next"]).toBe(userCommand)
  })

  it("registers all four typed goal tools", async () => {
    const hooks = await ElicifyVertexPlugin({} as any, undefined)
    expect(Object.keys(hooks.tool ?? {})).toEqual(expect.arrayContaining([
      "elicify_vertex_goal_create",
      "elicify_vertex_goal_next",
      "elicify_vertex_goal_checkpoint",
      "elicify_vertex_goal_status",
    ]))
  })

  it("activates from the actual slash-command lifecycle and stays active for later messages", async () => {
    const hooks = await ElicifyVertexPlugin({} as any, undefined)
    const sessionID = "slash-session-persist"
    await hooks["command.execute.before"]!({
      command: "elicify-vertex",
      sessionID,
      arguments: "verify this",
    }, { parts: [] })
    await hooks["chat.message"]!({ sessionID, agent: "build" } as any, {
      message: {} as any,
      parts: [{ type: "text", text: "implement the fix now" } as any],
    })

    for (const text of ["implement first follow-up", "implement later ordinary message"]) {
      await hooks["chat.message"]!({ sessionID, agent: "build" } as any, {
        message: {} as any,
        parts: [{ type: "text", text } as any],
      })
      const output = { system: [] as string[] }
      await hooks["experimental.chat.system.transform"]!({ sessionID, model: {} as any }, output)
      // Still active: dynamic stop-mode guidance present; full static contract absent
      expect(output.system.join("\n")).toMatch(/verification-advisory|verification-required/)
      expect(output.system.join("\n")).not.toContain(
        "A passing test is not evidence until you have confirmed the test can fail",
      )
    }
  })
})

describe("ElicifyVertexPlugin.chat.message activation gate", () => {
  /** Active if harness injects dynamic directives or shows activate cue. */
  async function gateActiveFor(
    sessionID: string,
    agent: string | undefined,
    text: string,
  ): Promise<boolean> {
    const hooks = await ElicifyVertexPlugin({} as any, undefined)
    const parts = [{ type: "text", text } as any]
    await hooks["chat.message"]!(
      { sessionID, agent } as any,
      {
        message: {} as any,
        parts,
      },
    )
    const fakeOutput: { system: string[] } = { system: [] }
    await hooks["experimental.chat.system.transform"]!(
      { sessionID, model: {} as any },
      fakeOutput,
    )
    const sys = fakeOutput.system.join("\n")
    const cue = parts.map((p: any) => p.text).join("")
    return (
      cue.includes("[vertex] harness on")
      || sys.includes("vertex-directives")
      || sys.includes("verification-")
    )
  }

  it("activates when the agent is the elicify-vertex-agent", async () => {
    // Use implement so stop-mode guidance is present even without static contract
    const active = await gateActiveFor("s1", "elicify-vertex-agent", "implement the feature")
    expect(active).toBe(true)
  })

  it("activates when the user message STARTS with the trigger", async () => {
    const active = await gateActiveFor("s2", "build", "/elicify-vertex please implement the fix")
    expect(active).toBe(true)
  })

  it("does NOT activate on the retired /vertex alias", async () => {
    expect(await gateActiveFor("s2-alias", "build", "/vertex please verify")).toBe(false)
  })

  it("activates with leading whitespace before the trigger", async () => {
    const active = await gateActiveFor("s3", "build", "   /elicify-vertex implement go")
    expect(active).toBe(true)
  })

  it("activates when the trigger is the first token on a new line", async () => {
    const active = await gateActiveFor("s4", "build", "previous context\n/elicify-vertex implement now")
    expect(active).toBe(true)
  })

  it("does NOT activate on a question mentioning the trigger mid-sentence", async () => {
    const active = await gateActiveFor("s5", "build", "is the /elicify-vertex plugin working?")
    expect(active).toBe(false)
  })

  it("does NOT activate when the trigger is mid-sentence on a new line", async () => {
    const active = await gateActiveFor("s6", "build", "Please /elicify-vertex verify this")
    expect(active).toBe(false)
  })

  it("deactivates when the user switches from the vertex agent to another", async () => {
    const hooks = await ElicifyVertexPlugin({} as any, undefined)
    const sessionID = "s7"

    await hooks["chat.message"]!(
      { sessionID, agent: "elicify-vertex-agent" } as any,
      {
        message: {} as any,
        parts: [{ type: "text", text: "implement start" } as any],
      },
    )

    await hooks["chat.message"]!(
      { sessionID, agent: "build" } as any,
      {
        message: {} as any,
        parts: [{ type: "text", text: "now on build" } as any],
      },
    )
    const output = { system: [] as string[] }
    await hooks["experimental.chat.system.transform"]!(
      { sessionID, model: {} as any },
      output,
    )
    expect(output.system.some((s) => s.includes("vertex-directives"))).toBe(false)
  })
})

describe("user-visible harness cues", () => {
  it("formatActivateCue is a single redacted status line", () => {
    const line = formatActivateCue({
      stopMode: "deep",
      taskMode: "debugging",
      agent: "elicify-vertex-agent",
    })
    expect(line).toMatch(/^\[vertex\] harness on · stopMode=deep · task=debugging · elicify-vertex-agent$/)
    expect(line.includes("\n")).toBe(false)
  })

  it("formatGateContinuationText leads with a short headline then full reason", () => {
    const text = formatGateContinuationText(
      "[vertex:stop-block] You appear to be stopping without verification. (Block 1/3)",
    )
    expect(text.startsWith("[vertex] completion paused · verification required")).toBe(true)
    expect(text).toContain("[vertex:stop-block]")
    expect(text).toContain("Block 1/3")
  })

  it("appends activate cue once on first harness activation, not on later turns", async () => {
    const hooks = await ElicifyVertexPlugin({} as any, undefined)
    const sessionID = "cue-once"
    const parts1 = [{ type: "text", text: "hello" } as any]
    await hooks["chat.message"]!(
      { sessionID, agent: "elicify-vertex-agent" } as any,
      { message: {} as any, parts: parts1 },
    )
    const joined1 = parts1.map((p: any) => p.text).join("")
    expect(joined1).toContain("[vertex] harness on")
    expect(joined1).toContain("stopMode=")

    const parts2 = [{ type: "text", text: "second message" } as any]
    await hooks["chat.message"]!(
      { sessionID, agent: "elicify-vertex-agent" } as any,
      { message: {} as any, parts: parts2 },
    )
    const joined2 = parts2.map((p: any) => p.text).join("")
    expect(joined2).not.toContain("[vertex] harness on")
  })

  it("re-shows activate cue after deactivate then reactivate", async () => {
    const hooks = await ElicifyVertexPlugin({} as any, undefined)
    const sessionID = "cue-reactivate"
    const p1 = [{ type: "text", text: "a" } as any]
    await hooks["chat.message"]!(
      { sessionID, agent: "elicify-vertex-agent" } as any,
      { message: {} as any, parts: p1 },
    )
    expect(p1.map((p: any) => p.text).join("")).toContain("[vertex] harness on")

    await hooks["chat.message"]!(
      { sessionID, agent: "build" } as any,
      { message: {} as any, parts: [{ type: "text", text: "leave" } as any] },
    )

    const p2 = [{ type: "text", text: "back" } as any]
    await hooks["chat.message"]!(
      { sessionID, agent: "elicify-vertex-agent" } as any,
      { message: {} as any, parts: p2 },
    )
    expect(p2.map((p: any) => p.text).join("")).toContain("[vertex] harness on")
  })

  it("gate continuation prompt uses user-visible gate formatting", async () => {
    const prompts: string[] = []
    const hooks = await ElicifyVertexPlugin(
      {
        client: {
          session: {
            prompt: async (req: any) => {
              prompts.push(String(req?.body?.parts?.[0]?.text ?? ""))
              return {}
            },
          },
        },
        directory: "/work",
        worktree: "/work",
      } as any,
      undefined,
    )
    const sessionID = "gate-visible"
    await hooks["chat.message"]!(
      { sessionID, agent: "elicify-vertex-agent" } as any,
      { message: {} as any, parts: [{ type: "text", text: "deep implement the plan" } as any] },
    )
    await hooks["tool.execute.after"]!(
      { tool: "edit", sessionID, callID: "e", args: { filePath: "src/a.ts" } },
      { title: "e", output: "ok", metadata: {} },
    )
    await hooks["experimental.text.complete"]!(
      { sessionID, messageID: "m", partID: "p" },
      { text: "All done." },
    )
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID } } as any })
    expect(prompts.length).toBe(1)
    expect(prompts[0]).toContain("[vertex] completion paused · verification required")
    expect(prompts[0]).toContain("[vertex:stop-block]")
  })
})
