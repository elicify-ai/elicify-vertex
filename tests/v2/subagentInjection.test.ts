import { describe, expect, it } from "vitest"

import { SUBAGENT_INJECTION_PREAMBLE, injectSubagentPreamble } from "../../src/v2/wiring/subagentInjection.js"

// ===========================================================================
// wiring/subagentInjection.ts — C-7 (docs/CODE-ISSUES-FROM-PROMPT-AUDIT.md,
// design in docs/SUBAGENT-INJECTION-DRAFT.md).
//
// The one detail that has already burned someone (SUBAGENT-INJECTION-DRAFT's
// "Feasibility" section, probed empirically against opencode 1.18.4):
// opencode hands `tool.execute.before` and the task executor the SAME `args`
// object reference. Mutating a property on it (`args.prompt = ...`) reaches
// the subagent. REASSIGNING the local `args` binding
// (`args = {...args, prompt: ...}`) is silently discarded — the caller's
// object is left untouched and the subagent runs the ORIGINAL, unmutated
// prompt with no error anywhere. Every test below is written to catch a
// regression to the reassignment form, not just to exercise the happy path.
// ===========================================================================

describe("injectSubagentPreamble", () => {
  it("mutates the SAME object reference in place, not a new object", () => {
    const args: Record<string, unknown> = { prompt: "delegate: fix the flaky test", description: "d" }
    const sameRef = args // the reference the caller keeps holding, exactly like plugin.ts's `toolOutput.args`

    const result = injectSubagentPreamble(args)

    expect(result).toBe(true)
    // Identity: still the exact object the caller passed in.
    expect(args).toBe(sameRef)
    // The mutation is visible THROUGH that same reference — this is the
    // property a reassignment-based "fix" would silently break.
    expect(sameRef.prompt).toBe(`${SUBAGENT_INJECTION_PREAMBLE}\n\ndelegate: fix the flaky test`)
  })

  it("prepends the preamble ahead of the original prompt text, separated by a blank line", () => {
    const args: Record<string, unknown> = { prompt: "original task text" }
    injectSubagentPreamble(args)
    expect(args.prompt).toBe(`${SUBAGENT_INJECTION_PREAMBLE}\n\noriginal task text`)
  })

  it("returns false and does not throw when args.prompt is missing entirely", () => {
    const args: Record<string, unknown> = { description: "no prompt field at all" }
    expect(() => injectSubagentPreamble(args)).not.toThrow()
    expect(injectSubagentPreamble(args)).toBe(false)
    expect(args).toEqual({ description: "no prompt field at all" }) // untouched
  })

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a number", 42],
    ["an object", { nested: true }],
    ["an array", ["x"]],
  ])("returns false without throwing when args.prompt is %s (not a string)", (_label, value) => {
    const args: Record<string, unknown> = { prompt: value }
    expect(() => injectSubagentPreamble(args)).not.toThrow()
    expect(injectSubagentPreamble(args)).toBe(false)
    expect(args.prompt).toBe(value) // left exactly as it was, defensively
  })

  // MUTATION-STYLE NEGATIVE TEST — the specific failure mode already
  // reproduced once in the feasibility probe, replayed here as the real
  // plugin.ts call-site shape:
  //   const args = (toolOutput?.args ?? {}) as Record<string, unknown>
  //   injectSubagentPreamble(args)
  // The task executor reads `toolOutput.args.prompt` afterward, NOT the
  // hook's own local `args` binding. If `injectSubagentPreamble` were
  // "simplified" to `args = { ...args, prompt: PREAMBLE + "\n\n" + args.prompt }`
  // (reassigning the parameter instead of mutating the property in place),
  // this test fails: `toolOutput.args` — the object the executor actually
  // reads — would never be touched, even though the function still returns
  // `true`. That silent, no-error failure is exactly what the probe found
  // and what this test exists to catch a regression to.
  it("would fail if the implementation reassigned `args` instead of mutating it in place", () => {
    const toolOutput = {
      args: { prompt: "run the migration", subagent_type: "general-purpose" } as Record<string, unknown>,
    }
    const liveArgsHeldByCaller = toolOutput.args // same reference plugin.ts's hook would hold

    const returned = injectSubagentPreamble(liveArgsHeldByCaller)

    expect(returned).toBe(true)
    // The assertion a reassignment regression breaks: the executor-visible
    // object (`toolOutput.args`, never reassigned by the caller) must carry
    // the injected text. A reassignment implementation leaves this as the
    // original, un-prefixed string.
    expect(toolOutput.args.prompt).toContain(SUBAGENT_INJECTION_PREAMBLE)
    expect(toolOutput.args.prompt).toContain("run the migration")
  })

  it("the exported preamble carries the approved draft text (spot-checks, not a brittle full snapshot)", () => {
    expect(SUBAGENT_INJECTION_PREAMBLE).toMatch(
      /^You are executing one bounded unit of work delegated under the elicify-vertex/,
    )
    expect(SUBAGENT_INJECTION_PREAMBLE).toContain(
      "You cannot mint a verification receipt; only the parent session can.",
    )
    expect(SUBAGENT_INJECTION_PREAMBLE).toContain("Keep your RETURN terse.")
    // Orchestrator-only sections must NOT be present — SUBAGENT-INJECTION-
    // DRAFT.md §1's table explicitly excludes fan_out_agents/plan_gate/interview
    // from what a subagent receives.
    expect(SUBAGENT_INJECTION_PREAMBLE).not.toContain("fan_out_agents")
    expect(SUBAGENT_INJECTION_PREAMBLE.toLowerCase()).not.toContain("question tool")
  })
})
