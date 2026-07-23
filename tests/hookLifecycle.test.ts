import { describe, expect, it, vi } from "vitest"

import {
  ElicifyVertexPlugin,
  changedPathsFromTool,
  isMutatingBashCommand,
} from "../src/index.js"
import * as measurement from "../src/measurement.js"

function pluginInput(prompt = vi.fn(async () => ({}))) {
  return {
    client: { session: { prompt } },
    directory: "/work",
    worktree: "/work",
  } as any
}

async function activate(hooks: Awaited<ReturnType<typeof ElicifyVertexPlugin>>, sessionID: string, text: string) {
  await hooks["chat.message"]!({ sessionID, agent: "elicify-vertex-agent" } as any, {
    message: {} as any,
    parts: [{ type: "text", text } as any],
  })
}

async function completeText(hooks: Awaited<ReturnType<typeof ElicifyVertexPlugin>>, sessionID: string, text: string) {
  await hooks["experimental.text.complete"]!({
    sessionID,
    messageID: `msg-${sessionID}`,
    partID: `part-${sessionID}`,
  }, { text })
}

describe("final-response promise lifecycle", () => {
  it("clears stale assistant text and evaluates the current completed response", async () => {
    const prompt = vi.fn(async () => ({}))
    const hooks = await ElicifyVertexPlugin(pluginInput(prompt), undefined)
    const sessionID = "promise-current"

    await activate(hooks, sessionID, "fix the parser") // normal mode: advisory only
    await completeText(hooks, sessionID, "TODO: I will finish this later.")

    // A new prompt clears the previous response. messages.transform must not
    // repopulate it from history before the current model response.
    await activate(hooks, sessionID, "fix the parser")
    await hooks["experimental.chat.messages.transform"]!({}, {
      messages: [{
        info: { id: "old", sessionID, role: "assistant" } as any,
        parts: [{ type: "text", text: "TODO: stale promise later" } as any],
      }],
    })
    await hooks["tool.execute.after"]!({
      tool: "edit",
      sessionID,
      callID: "edit-1",
      args: { filePath: "src/index.ts" },
    }, { title: "edit", output: "updated", metadata: {} })
    await completeText(hooks, sessionID, "The requested edit is complete.")
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID } } as any })
    expect(prompt).not.toHaveBeenCalled()

    await activate(hooks, sessionID, "fix the parser")
    await hooks["tool.execute.after"]!({
      tool: "edit",
      sessionID,
      callID: "edit-2",
      args: { filePath: "src/index.ts" },
    }, { title: "edit", output: "updated", metadata: {} })
    await completeText(hooks, sessionID, "TODO: I will add the test later.")
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID } } as any })
    expect(prompt).toHaveBeenCalledTimes(1)
    const request = (prompt.mock.calls as unknown as Array<[any]>)[0]?.[0]
    expect(request.body.parts[0].text).toContain("vertex:promise-no-act")
  })

  it("does not let an earlier passing verifier excuse promised remaining work", async () => {
    const prompt = vi.fn(async () => ({}))
    const hooks = await ElicifyVertexPlugin(pluginInput(prompt), undefined)
    const sessionID = "promise-after-test"
    await activate(hooks, sessionID, "fix the parser")
    await hooks["tool.execute.after"]!({
      tool: "edit",
      sessionID,
      callID: "edit",
      args: { filePath: "src/index.ts" },
    }, { title: "edit", output: "updated", metadata: {} })
    await hooks["tool.execute.after"]!({
      tool: "bash",
      sessionID,
      callID: "verify",
      args: { command: "npm test" },
    }, { title: "tests", output: "217 passed", metadata: { exit: 0 } })
    await completeText(hooks, sessionID, "I will implement the missing cache next.")
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID } } as any })
    expect(prompt).toHaveBeenCalledTimes(1)
  })
})

describe("mutation matrix", () => {
  it.each([
    ["mkdir generated", true],
    ["sed -i 's/a/b/' file.ts", true],
    ["tee out.txt", true],
    ["npm run build", true],
    ["git commit -m 'msg'", true],
    ["git add src/index.ts", true],
    ["echo hello > out.txt", true],
    ["printf 'x' >> out.txt", true],
    ["cat preamble.txt > dest.txt", true],
    ["python -c \"open('f','w').write('x')\"", true],
    ["python3 -c \"open('f').write('x')\"", true],
    ["node -e \"require('fs').writeFileSync('f','x')\"", true],
    ["node -p \"require('fs').appendFileSync('f','x')\"", true],
    ["echo pytest", false],
    ["npm test", false],
    ["git status", false],
    ["git log --oneline", false],
    ["cat README.md", false],
    ["cmd 2>&1", false],
    ["npm test >&2", false],
    // Device sinks are not workspace mutations (live F1 false positive).
    ["cat ~/.config/.elicify-vertex-consent 2>/dev/null", false],
    ["echo x >/dev/null", false],
    ["echo x 2>/dev/null", false],
    ["cmd >/dev/null 2>&1", false],
    ["printf hi 1>/dev/stdout", false],
    ["printf hi 2>/dev/stderr", false],
    ["python -c \"print(open('f').read())\"", false],
    ["node -e \"console.log(require('fs').readFileSync('f','utf8'))\"", false],
  ] as const)("isMutatingBashCommand(%j) → %s", (command, expected) => {
    expect(isMutatingBashCommand(command)).toBe(expected)
  })

  it("changedPathsFromTool maps bash mutations to bash-mutation", () => {
    expect(changedPathsFromTool("bash", { command: "echo x > f" })).toEqual(["bash-mutation"])
    expect(changedPathsFromTool("bash", { command: "echo x" })).toEqual([])
    expect(changedPathsFromTool("bash", { command: "cat f 2>/dev/null" })).toEqual([])
    expect(changedPathsFromTool("edit", { filePath: "a.ts" })).toEqual(["a.ts"])
  })
})

describe("mutation observation", () => {
  it.each([
    ["apply_patch", { patchText: "*** Begin Patch\n*** Update File: src/index.ts\n@@\n-old\n+new\n*** End Patch" }],
    ["bash", { command: "mkdir generated" }],
    ["bash-redirect", { command: "echo x > generated.txt" }],
    ["bash-git-commit", { command: "git commit -m done" }],
  ])("hard-blocks deep unverified work changed through %s", async (label, args) => {
    const prompt = vi.fn(async () => ({}))
    const hooks = await ElicifyVertexPlugin(pluginInput(prompt), undefined)
    const sessionID = `mutation-${label}`
    const tool = label.startsWith("bash") ? "bash" : label
    await activate(hooks, sessionID, "deep implement the plan")
    await hooks["tool.execute.after"]!({ tool, sessionID, callID: "change", args }, {
      title: "change",
      output: "done",
      metadata: tool === "bash" ? { exit: 0 } : {},
    })
    await completeText(hooks, sessionID, "Work is complete.")
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID } } as any })
    expect(prompt).toHaveBeenCalledTimes(1)
    const request = (prompt.mock.calls as unknown as Array<[any]>)[0]?.[0]
    expect(request.body.parts[0].text).toContain("vertex:stop-block")
  })

  it("does not treat 2>/dev/null probes as mutations that poison docs-only stop", async () => {
    // Live F1: agent first-run `cat … 2>/dev/null` was classified bash-mutation
    // (kind=other), so a later NOTES.md-only edit still hard-blocked.
    const prompt = vi.fn(async () => ({}))
    const hooks = await ElicifyVertexPlugin(pluginInput(prompt), undefined)
    const sessionID = "docs-only-after-devnull"
    await activate(hooks, sessionID, "deep implement thorough docs update")
    await hooks["tool.execute.after"]!({
      tool: "bash",
      sessionID,
      callID: "probe",
      args: { command: "cat ~/.config/.elicify-vertex-consent 2>/dev/null" },
    }, { title: "probe", output: "yes\n", metadata: { exit: 0 } })
    await hooks["tool.execute.after"]!({
      tool: "edit",
      sessionID,
      callID: "docs",
      args: { filePath: "NOTES.md" },
    }, { title: "edit", output: "updated", metadata: {} })
    await completeText(hooks, sessionID, "Updated NOTES.md only.")
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID } } as any })
    expect(prompt).not.toHaveBeenCalled()
  })

  it("observes host file.edited events", async () => {
    const prompt = vi.fn(async () => ({}))
    const hooks = await ElicifyVertexPlugin(pluginInput(prompt), undefined)
    const sessionID = "file-event"
    await activate(hooks, sessionID, "deep implement the plan")
    await hooks.event!({ event: { type: "file.edited", properties: { file: "src/generated.ts" } } as any })
    await completeText(hooks, sessionID, "Work is complete.")
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID } } as any })
    expect(prompt).toHaveBeenCalledTimes(1)
  })

  it("does not attribute a sessionless file.edited event when several sessions are active", async () => {
    const prompt = vi.fn(async () => ({}))
    const hooks = await ElicifyVertexPlugin(pluginInput(prompt), undefined)
    await activate(hooks, "editor", "deep implement the plan")
    await activate(hooks, "innocent", "deep review the plan")
    await hooks.event!({ event: { type: "file.edited", properties: { file: "src/other.ts" } } as any })
    await completeText(hooks, "innocent", "Review complete.")
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "innocent" } } as any })
    expect(prompt).not.toHaveBeenCalled()
  })

  it("preserves mutation evidence across a gate-generated continuation prompt", async () => {
    let hooks: Awaited<ReturnType<typeof ElicifyVertexPlugin>>
    const prompt = vi.fn(async (request: any) => {
      await hooks["chat.message"]!({ sessionID: "continuation", agent: "elicify-vertex-agent" } as any, {
        message: {} as any,
        parts: request.body.parts,
      })
      return {}
    })
    hooks = await ElicifyVertexPlugin(pluginInput(prompt), undefined)
    await activate(hooks, "continuation", "deep implement the plan")
    await hooks["tool.execute.after"]!({
      tool: "edit",
      sessionID: "continuation",
      callID: "edit",
      args: { filePath: "src/index.ts" },
    }, { title: "edit", output: "done", metadata: {} })

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await completeText(hooks, "continuation", `Unverified completion attempt ${attempt}.`)
      await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "continuation" } } as any })
      expect(prompt).toHaveBeenCalledTimes(attempt)
    }
  })
})

describe("gate continuation + prompt failure (H1/H7)", () => {
  it("does not claim block when session.prompt is missing; keeps queue for system.transform", async () => {
    const fires: Array<{ decision: string; would_block?: boolean; reason?: string }> = []
    const spy = vi.spyOn(measurement, "logGateFire").mockImplementation((_sid, payload) => {
      fires.push(payload as any)
      return {} as any
    })
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const hooks = await ElicifyVertexPlugin({ directory: "/work", worktree: "/work" } as any, undefined)
      const sessionID = "no-client"
      await activate(hooks, sessionID, "deep implement the plan")
      await hooks["tool.execute.after"]!({
        tool: "edit",
        sessionID,
        callID: "edit",
        args: { filePath: "src/index.ts" },
      }, { title: "edit", output: "done", metadata: {} })
      await completeText(hooks, sessionID, "Done.")
      await hooks.event!({ event: { type: "session.idle", properties: { sessionID } } as any })

      expect(fires.some((f) => f.decision === "block")).toBe(false)
      expect(fires.some((f) => f.decision === "allow" && f.would_block === true)).toBe(true)
      expect(errSpy).toHaveBeenCalled()

      const sys = { system: [] as string[] }
      await hooks["experimental.chat.system.transform"]!({ sessionID, model: {} as any }, sys)
      expect(sys.system.join("\n")).toContain("vertex:stop-block")
    } finally {
      spy.mockRestore()
      errSpy.mockRestore()
    }
  })

  it("on prompt throw: allow+would_block, clears continuation flag, keeps queue", async () => {
    const fires: Array<{ decision: string; would_block?: boolean; reason?: string }> = []
    const spy = vi.spyOn(measurement, "logGateFire").mockImplementation((_sid, payload) => {
      fires.push(payload as any)
      return {} as any
    })
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const prompt = vi.fn(async () => {
        throw new Error("prompt boom")
      })
      const hooks = await ElicifyVertexPlugin(pluginInput(prompt), undefined)
      const sessionID = "prompt-fail"
      await activate(hooks, sessionID, "deep implement the plan")
      await hooks["tool.execute.after"]!({
        tool: "edit",
        sessionID,
        callID: "edit",
        args: { filePath: "src/index.ts" },
      }, { title: "edit", output: "done", metadata: {} })
      await completeText(hooks, sessionID, "Done.")
      await hooks.event!({ event: { type: "session.idle", properties: { sessionID } } as any })

      expect(fires.some((f) => f.decision === "block")).toBe(false)
      expect(fires.some((f) => f.decision === "allow" && f.reason === "session.prompt failed")).toBe(true)

      // Flag cleared → next user message resets ledger (mutation evidence lost for gate).
      await activate(hooks, sessionID, "deep implement more")
      await completeText(hooks, sessionID, "Still done.")
      await hooks.event!({ event: { type: "session.idle", properties: { sessionID } } as any })
      expect(prompt).toHaveBeenCalledTimes(1)

      // Queue survived the failed prompt for next system.transform (enqueued before prompt).
      const sys = { system: [] as string[] }
      await hooks["experimental.chat.system.transform"]!({ sessionID, model: {} as any }, sys)
      expect(sys.system.join("\n")).toContain("vertex:stop-block")
    } finally {
      spy.mockRestore()
      errSpy.mockRestore()
    }
  })

  it("leaves continuation flag set until chat.message after successful prompt", async () => {
    let hooks: Awaited<ReturnType<typeof ElicifyVertexPlugin>>
    let sawContinuation = false
    const prompt = vi.fn(async (request: any) => {
      await hooks["chat.message"]!({ sessionID: "flag-lifetime", agent: "elicify-vertex-agent" } as any, {
        message: {} as any,
        parts: request.body.parts,
      })
      sawContinuation = true
      return {}
    })
    hooks = await ElicifyVertexPlugin(pluginInput(prompt), undefined)
    await activate(hooks, "flag-lifetime", "deep implement the plan")
    await hooks["tool.execute.after"]!({
      tool: "edit",
      sessionID: "flag-lifetime",
      callID: "edit",
      args: { filePath: "src/index.ts" },
    }, { title: "edit", output: "done", metadata: {} })
    await completeText(hooks, "flag-lifetime", "Done without verify.")
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "flag-lifetime" } } as any })
    expect(sawContinuation).toBe(true)
    expect(prompt).toHaveBeenCalledTimes(1)

    // Evidence still present → second idle still blocks.
    await completeText(hooks, "flag-lifetime", "Still done.")
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "flag-lifetime" } } as any })
    expect(prompt).toHaveBeenCalledTimes(2)
  })
})

describe("system-transform directive delivery (H5)", () => {
  it("injects each queued directive only for the matching session via system.transform", async () => {
    const hooks = await ElicifyVertexPlugin(pluginInput(), undefined)
    await activate(hooks, "s1", "fix one")
    await activate(hooks, "s2", "fix two")
    hooks.enqueue("s1", { id: "only-s1", text: "private to s1" })
    hooks.enqueue("s2", { id: "only-s2", text: "private to s2" })

    const out1 = { system: [] as string[] }
    await hooks["experimental.chat.system.transform"]!({ sessionID: "s1", model: {} as any }, out1)
    const out2 = { system: [] as string[] }
    await hooks["experimental.chat.system.transform"]!({ sessionID: "s2", model: {} as any }, out2)

    expect(out1.system.join("\n")).toContain("only-s1")
    expect(out1.system.join("\n")).not.toContain("only-s2")
    expect(out2.system.join("\n")).toContain("only-s2")
    expect(out2.system.join("\n")).not.toContain("only-s1")
  })

  it("messages.transform does not drain the directive queue", async () => {
    const hooks = await ElicifyVertexPlugin(pluginInput(), undefined)
    await activate(hooks, "s1", "fix one")
    hooks.enqueue("s1", { id: "keep-me", text: "must survive messages.transform" })

    const messages = {
      messages: [
        { info: { id: "m1", sessionID: "s1", role: "user" } as any, parts: [] as any[] },
      ],
    }
    await hooks["experimental.chat.messages.transform"]!({}, messages)
    expect(messages.messages[0].parts).toEqual([])

    const sys = { system: [] as string[] }
    await hooks["experimental.chat.system.transform"]!({ sessionID: "s1", model: {} as any }, sys)
    expect(sys.system.join("\n")).toContain("keep-me")
  })

  it("preserves queued directives across compaction", async () => {
    const hooks = await ElicifyVertexPlugin(pluginInput(), undefined)
    await activate(hooks, "s1", "fix one")
    hooks.enqueue("s1", { id: "after-compaction", text: "deliver after compaction" })
    await hooks["experimental.session.compacting"]!({ sessionID: "s1" }, { context: [] })

    const during = { system: [] as string[] }
    await hooks["experimental.chat.system.transform"]!({ sessionID: "s1", model: {} as any }, during)
    expect(during.system.join("\n")).not.toContain("after-compaction")

    await hooks.event!({ event: { type: "session.compacted", properties: { sessionID: "s1" } } as any })
    const after = { system: [] as string[] }
    await hooks["experimental.chat.system.transform"]!({ sessionID: "s1", model: {} as any }, after)
    expect(after.system.join("\n")).toContain("after-compaction")
  })

  it("releases queued directives on the next message when compaction does not complete", async () => {
    const hooks = await ElicifyVertexPlugin(pluginInput(), undefined)
    await activate(hooks, "s1", "fix one")
    hooks.enqueue("s1", { id: "after-failed-compaction", text: "still deliver this" })
    await hooks["experimental.session.compacting"]!({ sessionID: "s1" }, { context: [] })
    const during = { system: [] as string[] }
    await hooks["experimental.chat.system.transform"]!({ sessionID: "s1", model: {} as any }, during)
    expect(during.system.join("\n")).not.toContain("after-failed-compaction")

    await activate(hooks, "s1", "continue after failed compaction")
    const resumed = { system: [] as string[] }
    await hooks["experimental.chat.system.transform"]!({ sessionID: "s1", model: {} as any }, resumed)
    expect(resumed.system.join("\n")).toContain("after-failed-compaction")
  })
})

describe("post-verify mutation freshness", () => {
  it("blocks deep stop after verify-then-edit (ledger matches receipt invalidation)", async () => {
    const prompt = vi.fn(async () => ({}))
    const hooks = await ElicifyVertexPlugin(pluginInput(prompt), { maxStopBlocks: 3 })
    const sessionID = "verify-then-edit"
    await activate(hooks, sessionID, "deep implement the plan")
    await hooks["tool.execute.after"]!({
      tool: "bash",
      sessionID,
      callID: "v1",
      args: { command: "npm test" },
    }, { title: "t", output: "10 passed", metadata: { exit: 0 } })
    await hooks["tool.execute.after"]!({
      tool: "edit",
      sessionID,
      callID: "e1",
      args: { filePath: "src/index.ts" },
    }, { title: "e", output: "ok", metadata: {} })
    await completeText(hooks, sessionID, "Done.")
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID } } as any })
    expect(prompt).toHaveBeenCalled()
    const request = (prompt.mock.calls as unknown as Array<[any]>)[0]?.[0]
    expect(String(request?.body?.parts?.[0]?.text ?? "")).toContain("vertex:stop-block")
  })

  it("allows deep stop when edit-then-verify", async () => {
    const prompt = vi.fn(async () => ({}))
    const hooks = await ElicifyVertexPlugin(pluginInput(prompt), undefined)
    const sessionID = "edit-then-verify"
    await activate(hooks, sessionID, "deep implement the plan")
    await hooks["tool.execute.after"]!({
      tool: "edit",
      sessionID,
      callID: "e1",
      args: { filePath: "src/index.ts" },
    }, { title: "e", output: "ok", metadata: {} })
    await hooks["tool.execute.after"]!({
      tool: "bash",
      sessionID,
      callID: "v1",
      args: { command: "npm test" },
    }, { title: "t", output: "10 passed", metadata: { exit: 0 } })
    await completeText(hooks, sessionID, "Done.")
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID } } as any })
    expect(prompt).not.toHaveBeenCalled()
  })
})

describe("cap warn and holdout idle", () => {
  it("warns and stops re-prompting after maxStopBlocks", async () => {
    const prompt = vi.fn(async () => ({}))
    const fires: Array<Record<string, unknown>> = []
    const spy = vi.spyOn(measurement, "logGateFire").mockImplementation((_sid, payload) => {
      fires.push(payload as Record<string, unknown>)
    })
    try {
      const hooks = await ElicifyVertexPlugin(pluginInput(prompt), { maxStopBlocks: 1 })
      const sessionID = "cap-warn"
      await activate(hooks, sessionID, "deep implement the plan")
      await hooks["tool.execute.after"]!({
        tool: "edit",
        sessionID,
        callID: "e",
        args: { filePath: "src/a.ts" },
      }, { title: "e", output: "ok", metadata: {} })
      await completeText(hooks, sessionID, "Done.")
      await hooks.event!({ event: { type: "session.idle", properties: { sessionID } } as any })
      expect(prompt).toHaveBeenCalledTimes(1)
      await completeText(hooks, sessionID, "Still done.")
      await hooks.event!({ event: { type: "session.idle", properties: { sessionID } } as any })
      expect(prompt).toHaveBeenCalledTimes(1)
      expect(fires.some((f) => f.decision === "warn")).toBe(true)
      const sys = { system: [] as string[] }
      await hooks["experimental.chat.system.transform"]!({ sessionID, model: {} as any }, sys)
      expect(sys.system.join("\n")).toMatch(/stop-warning/)
    } finally {
      spy.mockRestore()
    }
  })

  it("suppresses stop gate under holdout off-arm without claiming block", async () => {
    const prompt = vi.fn(async () => ({}))
    const off = Array.from({ length: 5000 }, (_, i) => `holdout-${i}`).find(
      (s) => measurement.holdoutArm(s) === "off",
    )!
    const prev = process.env.VERTEX_HOLDOUT
    process.env.VERTEX_HOLDOUT = "1"
    const fires: Array<Record<string, unknown>> = []
    const spy = vi.spyOn(measurement, "logGateFire").mockImplementation((_sid, payload) => {
      fires.push(payload as Record<string, unknown>)
    })
    try {
      const hooks = await ElicifyVertexPlugin(pluginInput(prompt), undefined)
      await activate(hooks, off, "deep implement the plan")
      await hooks["tool.execute.after"]!({
        tool: "edit",
        sessionID: off,
        callID: "e",
        args: { filePath: "src/a.ts" },
      }, { title: "e", output: "ok", metadata: {} })
      await completeText(hooks, off, "Done.")
      await hooks.event!({ event: { type: "session.idle", properties: { sessionID: off } } as any })
      expect(prompt).not.toHaveBeenCalled()
      expect(fires.some((f) => f.decision === "allow" && f.would_block === true)).toBe(true)
    } finally {
      spy.mockRestore()
      if (prev === undefined) delete process.env.VERTEX_HOLDOUT
      else process.env.VERTEX_HOLDOUT = prev
    }
  })
})
