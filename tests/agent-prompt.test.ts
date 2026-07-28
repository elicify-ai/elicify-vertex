import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const agentPrompt = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../agents/elicify-vertex-agent.md"),
  "utf8",
)
const behavior = agentPrompt.match(/<vertex_behavior>([\s\S]*?)<\/vertex_behavior>/)?.[1] ?? ""

describe("elicify-vertex-agent prompt structure", () => {
  it("keeps the static contract out of legacy and per-signal wrapper blocks", () => {
    expect(agentPrompt).not.toContain("<verification_contract>")
    expect(agentPrompt).not.toContain("<vertex_operating_mode>")
  })

  it("keeps one behavior surface and routes procedures to the plugin", () => {
    expect(agentPrompt.match(/<vertex_behavior>/g) ?? []).toHaveLength(1)
    expect(agentPrompt).not.toContain("operating mode below")
    expect(agentPrompt).toContain("plugin-injected procedure")
  })

  it("keeps the verification hierarchy concise and actionable", () => {
    expect(behavior).toContain("observed passing")
    expect(behavior).toContain("tsc counts")
    expect(behavior).toContain("user-facing")
    expect((behavior.match(/^\s*-\s/gm) ?? [])).toHaveLength(4)
  })
  it("retains the verify-before-and-after discipline", () => {
    expect(behavior).toMatch(/verify\s+before\s+and\s+after/i)
    expect(behavior).toContain("Write/Edit success is authoring")
  })
})

// ===========================================================================
// The prompt must not name tools that do not exist.
//
// The greenfield cut removed v1's `elicify_vertex_goal_*` tools, and the prompt
// went on documenting them — five tool names, a slash-command family, a
// `goals.json` path, and argument shapes (`stories[{title, objective}]`) that
// no longer matched the real schema. The suite stayed green throughout, because
// the tests above assert on STRUCTURE (section names, bullet counts, phrasing)
// and nothing checked the prompt's claims against the code.
//
// A live session survived only because the model ignored its instructions and
// used the real tool list. This test exists so the next drift fails loudly.
// ===========================================================================

describe("the prompt's tool contract matches the code", () => {
  const toolsSource = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../src/v2/wiring/tools.ts"),
    "utf8",
  )
  const registered = new Set(
    [...toolsSource.matchAll(/(elicify_vertex_plan_\w+):/g)].map((m) => m[1]),
  )

  it("names only tools that are actually registered", () => {
    const named = new Set([...agentPrompt.matchAll(/elicify_vertex_\w+/g)].map((m) => m[0]))
    expect(registered.size, "PRE: tools.ts must register something").toBeGreaterThan(0)
    const phantom = [...named].filter((name) => !registered.has(name))
    expect(phantom, "the prompt names tools that do not exist").toEqual([])
  })

  it("names every registered tool (no silently undocumented tool)", () => {
    const missing = [...registered].filter((name) => !agentPrompt.includes(name))
    expect(missing, "registered tools the prompt never mentions").toEqual([])
  })

  it("does not resurrect the removed v1 API", () => {
    expect(agentPrompt).not.toContain("elicify_vertex_goal_")
    expect(agentPrompt).not.toContain("/elicify-vertex-goal-")
    expect(agentPrompt).not.toContain("goals.json")
  })

  it("points at the current state directory", () => {
    expect(agentPrompt).toContain(".opencode/elicify-vertex")
    expect(agentPrompt).not.toMatch(/[^.]\.elicify-vertex\//)
  })
})
