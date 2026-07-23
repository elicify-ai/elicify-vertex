import { describe, expect, it } from "vitest"

import {
  ElicifyVertexPlugin,
  contextForReview,
  isReviewTask,
} from "../src/index.js"

// Item 6 turns fablize's skill-only sentence into an always-routed review
// signal (/tmp/fablize-deep/skills/fablize/SKILL.md:52-54).

describe("isReviewTask", () => {
  it.each([
    "review this pull request",
    "audit the authentication flow",
    "perform a code-review",
    "red-team this implementation",
    "critique the API design",
    "이 코드를 검토해주세요",
    "보안 감사를 수행하세요",
  ])("detects review intent: %s", (prompt) => {
    expect(isReviewTask(prompt)).toBe(true)
  })

  it.each([
    "preview the rendered page",
    "implement the parser",
    "explain the API",
    "run the tests",
  ])("does not misclassify non-review intent: %s", (prompt) => {
    expect(isReviewTask(prompt)).toBe(false)
  })
})

describe("contextForReview", () => {
  it("requires high-recall collection before a separate filtering pass", () => {
    const directive = contextForReview()
    expect(directive.id).toBe("vertex:review-recall")
    expect(directive.text).toContain("report EVERYTHING including low-confidence findings")
    expect(directive.text).toMatch(/COLLECT FOR RECALL/)
    expect(directive.text).toMatch(/FILTER SEPARATELY/)
    expect(directive.text).toMatch(/file:line evidence/i)
    expect(directive.text).toMatch(/confidence label/i)
    expect(directive.text).toMatch(/retained or rejected/i)
  })
})

describe("review-recall system routing", () => {
  async function injected(prompt: string): Promise<string> {
    const hooks = await ElicifyVertexPlugin({} as any, undefined)
    await hooks["chat.message"]!({ sessionID: "s1", agent: "elicify-vertex-agent" } as any, {
      message: {} as any,
      parts: [{ type: "text", text: prompt }],
    })
    const output = { system: [] as string[] }
    await hooks["experimental.chat.system.transform"]!({ sessionID: "s1", model: {} as any }, output)
    return output.system.join("\n")
  }

  it("injects review recall for review prompts", async () => {
    expect(await injected("review this code for correctness")).toContain("vertex:review-recall")
  })

  it("keeps review independent from render grounding", async () => {
    const system = await injected("review the rendered UI dashboard")
    expect(system).toContain("vertex:review-recall")
    expect(system).toContain("vertex:grounding")
  })

  it("keeps review independent from debugging investigation", async () => {
    const system = await injected("audit the failing authentication test")
    expect(system).toContain("vertex:review-recall")
    expect(system).toContain("vertex:investigation")
  })

  it("does not inject review recall into non-review tasks", async () => {
    expect(await injected("implement the parser")).not.toContain("vertex:review-recall")
  })
})
