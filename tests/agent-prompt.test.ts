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
