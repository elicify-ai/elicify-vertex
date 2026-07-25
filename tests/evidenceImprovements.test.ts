import { describe, expect, it, vi } from "vitest"

import {
  ElicifyVertexPlugin,
  EvidenceLedger,
  formatChangedPathsForReason,
} from "../src/index.js"

// ---------------------------------------------------------------------------
// Teacher-review improvements (evidence-driven behavior):
//   1. repeat-failure per-signature cooldown — the anti-loop guard must not loop
//   2. quick → normal mode promotion when non-docs mutations are observed
//   3. ledger summary injected only when decision-relevant
//   4. stop-block reason names the changed paths
// ---------------------------------------------------------------------------

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

async function bashFail(hooks: Awaited<ReturnType<typeof ElicifyVertexPlugin>>, sessionID: string, callID: string) {
  await hooks["tool.execute.after"]!({
    tool: "bash",
    sessionID,
    callID,
    args: { command: "npm test" },
  }, { title: "tests", output: "error: boom", metadata: { exit: 1 } })
}

async function drainSystem(hooks: Awaited<ReturnType<typeof ElicifyVertexPlugin>>, sessionID: string): Promise<string> {
  const out: { system: string[] } = { system: [] }
  await hooks["experimental.chat.system.transform"]!({ sessionID, model: {} as any }, out)
  return out.system.join("\n")
}

// ---------------------------------------------------------------------------
// 1. Repeat-failure cooldown
// ---------------------------------------------------------------------------

describe("repeat-failure per-signature cooldown", () => {
  it("markRepeatFired fires once per signature, silent afterwards", () => {
    const l = new EvidenceLedger()
    l.reset("s1")
    expect(l.markRepeatFired("s1", "1:error: boom")).toBe(true)
    expect(l.markRepeatFired("s1", "1:error: boom")).toBe(false)
    expect(l.markRepeatFired("s1", "1:error: boom")).toBe(false)
    // A different signature gets its own single shot.
    expect(l.markRepeatFired("s1", "1:error: other")).toBe(true)
  })

  it("cooldown resets on the next prompt (per-turn semantics)", () => {
    const l = new EvidenceLedger()
    l.reset("s1")
    expect(l.markRepeatFired("s1", "sig")).toBe(true)
    l.reset("s1")
    expect(l.markRepeatFired("s1", "sig")).toBe(true)
  })

  it("three identical tool failures inject vertex:repeat-failure exactly once", async () => {
    const hooks = await ElicifyVertexPlugin(pluginInput(), undefined)
    const sid = "cooldown-hooks"
    await activate(hooks, sid, "fix the parser")

    await bashFail(hooks, sid, "f1") // failure 1 → tool-failure directive
    await bashFail(hooks, sid, "f2") // failure 2 → repeat detected → repeat-failure fires
    await bashFail(hooks, sid, "f3") // failure 3 → same signature → cooldown, silent

    const injected = await drainSystem(hooks, sid)
    const repeatMatches = injected.match(/vertex:repeat-failure/g) ?? []
    expect(repeatMatches.length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 2. Evidence-driven mode promotion (quick → normal)
// ---------------------------------------------------------------------------

describe("mode promotion on observed mutation", () => {
  it("quick + non-docs mutation → promoted to normal", () => {
    const l = new EvidenceLedger()
    l.reset("s1", "quick")
    l.recordChangedFiles("s1", "src/index.ts")
    expect(l.getMode("s1")).toBe("normal")
  })

  it("quick + shell mutation (pseudo path, kind=other) → promoted to normal", () => {
    const l = new EvidenceLedger()
    l.reset("s1", "quick")
    l.recordChangedFiles("s1", "bash-mutation")
    expect(l.getMode("s1")).toBe("normal")
  })

  it("quick + docs-only mutation → stays quick (docs-only philosophy)", () => {
    const l = new EvidenceLedger()
    l.reset("s1", "quick")
    l.recordChangedFiles("s1", "README.md")
    expect(l.getMode("s1")).toBe("quick")
  })

  it("never auto-escalates to deep; deep and normal are unchanged", () => {
    const deep = new EvidenceLedger()
    deep.reset("s1", "deep")
    deep.recordChangedFiles("s1", "src/index.ts")
    expect(deep.getMode("s1")).toBe("deep")

    const normal = new EvidenceLedger()
    normal.reset("s1", "normal")
    normal.recordChangedFiles("s1", "src/index.ts")
    expect(normal.getMode("s1")).toBe("normal")
  })

  it("promotion still never hard-blocks (normal is advisory-only)", () => {
    const l = new EvidenceLedger()
    l.reset("s1", "quick")
    l.recordChangedFiles("s1", "src/index.ts")
    expect(l.shouldBlockStop("s1")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 3. Decision-relevant ledger injection
// ---------------------------------------------------------------------------

describe("actionableSummary — inject only when it changes a decision", () => {
  it("changed + unverified → summary present", () => {
    const l = new EvidenceLedger()
    l.reset("s1", "normal")
    l.recordChangedFiles("s1", "src/index.ts")
    expect(l.actionableSummary("s1")).toContain("files changed: yes")
  })

  it("changed + verified → null (nothing left to act on)", () => {
    const l = new EvidenceLedger()
    l.reset("s1", "normal")
    l.recordChangedFiles("s1", "src/index.ts")
    l.recordVerification("s1", "npm test", 0, "verified")
    expect(l.actionableSummary("s1")).toBeNull()
    // The raw state reporter is unchanged — unit surface stays intact.
    expect(l.summary("s1")).toContain("verified: 1")
  })

  it("no changes + risk flags → summary present (risk stays visible)", () => {
    const l = new EvidenceLedger()
    l.reset("s1", "deep", ["production"])
    expect(l.actionableSummary("s1")).toContain("risks: production")
  })

  it("no changes + no risks → null", () => {
    const l = new EvidenceLedger()
    l.reset("s1", "normal")
    expect(l.actionableSummary("s1")).toBeNull()
  })

  it("hook path: vertex:ledger disappears after successful verification", async () => {
    const hooks = await ElicifyVertexPlugin(pluginInput(), undefined)
    const sid = "ledger-conditional"
    await activate(hooks, sid, "fix the parser")

    await hooks["tool.execute.after"]!({
      tool: "edit",
      sessionID: sid,
      callID: "e1",
      args: { filePath: "src/index.ts" },
    }, { title: "edit", output: "updated", metadata: {} })
    expect(await drainSystem(hooks, sid)).toContain("vertex:ledger")

    await hooks["tool.execute.after"]!({
      tool: "bash",
      sessionID: sid,
      callID: "v1",
      args: { command: "npm test" },
    }, { title: "tests", output: "217 passed", metadata: { exit: 0 } })
    expect(await drainSystem(hooks, sid)).not.toContain("vertex:ledger")
  })
})

// ---------------------------------------------------------------------------
// 4. Evidence-rich stop-block
// ---------------------------------------------------------------------------

describe("formatChangedPathsForReason", () => {
  it("maps pseudo markers to readable labels", () => {
    expect(formatChangedPathsForReason(["bash-mutation"])).toBe("(shell mutation)")
    expect(formatChangedPathsForReason(["edit-mutation"])).toBe("(file edit)")
    expect(formatChangedPathsForReason(["patch-mutation"])).toBe("(patch)")
  })

  it("truncates long lists with a +N marker", () => {
    const paths = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts", "g.ts"]
    expect(formatChangedPathsForReason(paths)).toBe("a.ts, b.ts, c.ts, d.ts, e.ts (+2 more)")
  })

  it("falls back when no paths were captured", () => {
    expect(formatChangedPathsForReason([])).toBe("files changed")
  })
})

describe("stop-block names the changed paths", () => {
  it("ledger tracks distinct paths, capped", () => {
    const l = new EvidenceLedger()
    l.reset("s1", "deep")
    l.recordChangedFiles("s1", "src/a.ts")
    l.recordChangedFiles("s1", "src/a.ts") // duplicate ignored
    l.recordChangedFiles("s1", "src/b.ts")
    expect(l.getChangedPaths("s1")).toEqual(["src/a.ts", "src/b.ts"])
    for (let i = 0; i < 20; i++) l.recordChangedFiles("s1", `src/f${i}.ts`)
    expect(l.getChangedPaths("s1").length).toBeLessThanOrEqual(10)
  })

  it("session.prompt continuation text includes the changed file path", async () => {
    const prompt = vi.fn(async () => ({}))
    const hooks = await ElicifyVertexPlugin(pluginInput(prompt), undefined)
    const sid = "stop-block-paths"
    await activate(hooks, sid, "deep thorough task: implement the feature end-to-end")

    await hooks["tool.execute.after"]!({
      tool: "edit",
      sessionID: sid,
      callID: "e1",
      args: { filePath: "src/foo.ts" },
    }, { title: "edit", output: "updated", metadata: {} })

    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: sid } } as any })

    expect(prompt).toHaveBeenCalledTimes(1)
    const text = String((prompt.mock.calls as unknown as Array<[any]>)[0]?.[0]?.body?.parts?.[0]?.text ?? "")
    expect(text).toContain("vertex:stop-block")
    expect(text).toContain("src/foo.ts")
  })
})
