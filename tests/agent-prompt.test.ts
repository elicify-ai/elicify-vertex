import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

import type { OpencodeClient } from "../src/v2/types.js"
import { applyV2Config } from "../src/v2/wiring/config.js"

const here = dirname(fileURLToPath(import.meta.url))
const agentPrompt = readFileSync(resolve(here, "../agents/elicify-vertex-agent.md"), "utf8")

/**
 * The shared behavioural body — everything between the markers. The agent file
 * is the single source; the slash template is generated from it. Identity is
 * the only thing that legitimately differs between the two surfaces.
 */
const behavior = agentPrompt.split("<!-- BEHAVIOR:BEGIN -->")[1]?.split("<!-- BEHAVIOR:END -->")[0]?.trim() ?? ""

async function activateTemplate(): Promise<string> {
  const cfg: { command?: Record<string, { description: string; template: string }> } = {}
  await applyV2Config(cfg, {} as unknown as OpencodeClient, "elicify-vertex")
  return cfg.command?.["elicify-vertex"]?.template ?? ""
}

// ---------------------------------------------------------------------------
// Activation parity.
//
// Observed: `/elicify-vertex` injected four sentences while `--agent
// elicify-vertex-agent` injected 266 lines. Same product, two very different
// contracts, and nothing told the user which one they had. The slash path is
// not allowed to be a quietly weaker mode, so the behavioural body is carried
// byte-identically and only the identity preamble differs.
// ---------------------------------------------------------------------------

describe("activation parity: slash template and agent carry one contract", () => {
  it("extracts a non-trivial shared body from the agent file", () => {
    expect(behavior.length, "BEHAVIOR markers missing or empty").toBeGreaterThan(4000)
  })

  it("carries the agent's behavioural body byte-identically", async () => {
    expect(await activateTemplate()).toContain(behavior)
  })

  it("differs from the agent only by identity", async () => {
    const template = await activateTemplate()
    // The slash path must not adopt the agent's identity...
    expect(template).not.toContain("<identity>")
    expect(template).toContain("keep your own identity")
    // ...and the agent must not carry the slash path's activation preamble.
    expect(agentPrompt).toContain("<identity>")
    expect(agentPrompt).not.toContain("keep your own identity")
    // Nothing else: strip the preamble and the remainder is exactly the body.
    expect(template.slice(template.indexOf(behavior)).trim()).toBe(behavior)
  })

  it("registers the same template from the installer as from the config hook", async () => {
    // The installer wins in practice: the config hook adds commands with `??=`,
    // so a command already on disk is never replaced. If these two disagree,
    // installing the plugin permanently pins whichever the installer wrote.
    const { buildActivateTemplate } = await import("../scripts/register-commands.mjs")
    expect(buildActivateTemplate(resolve(here, ".."))).toBe(await activateTemplate())
  })

  it("keeps the three rules that produced real defects on BOTH paths", async () => {
    // Clarification, verifier shape and completion — §4/§5/§6 of
    // docs/REQUIREMENTS-AGENT-PROMPT.md, each traced to an observed failure.
    for (const surface of [agentPrompt, await activateTemplate()]) {
      expect(surface).toContain("question` tool")
      expect(surface).toContain("single standalone command")
      expect(surface).toContain("elicify_vertex_plan_checkpoint")
    }
  })
})

// ---------------------------------------------------------------------------
// Structure. Deliberately thin: these assertions caught none of the defects
// that mattered, so they guard only the things whose ABSENCE is the defect.
// ---------------------------------------------------------------------------

describe("elicify-vertex-agent prompt structure", () => {
  it("keeps the static contract out of legacy wrapper blocks", () => {
    expect(agentPrompt).not.toContain("<verification_contract>")
    expect(agentPrompt).not.toContain("<vertex_operating_mode>")
    expect(agentPrompt).not.toContain("operating mode below")
  })

  it("routes per-signal procedures to the plugin rather than restating them", () => {
    expect(agentPrompt).toContain("plugin-injected procedure")
  })

  it("carries every phase of the working contract", () => {
    for (const section of [
      "<grounding>",
      "<interview>",
      "<plan_gate>",
      "<planning_in_waves>",
      "<fan_out_agents>",
      "<evidence>",
      "<completion>",
    ]) {
      expect(behavior, `missing ${section}`).toContain(section)
    }
  })

  it("keeps the verification hierarchy actionable", () => {
    const evidence = behavior.match(/<evidence>([\s\S]*?)<\/evidence>/)?.[1] ?? ""
    expect(evidence).toContain("observed passing")
    expect(evidence).toContain("`tsc` counts")
    expect(evidence).toMatch(/user-facing/i)
    expect(evidence).toMatch(/verify \*\*before and after\*\*/i)
    expect(evidence).toContain("authoring, not verifying")
  })

  it("orders grounding before the interview, with the four-level ladder", () => {
    expect(behavior.indexOf("<grounding>")).toBeLessThan(behavior.indexOf("<interview>"))
    const grounding = behavior.match(/<grounding>([\s\S]*?)<\/grounding>/)?.[1] ?? ""
    expect(grounding.match(/^\d\. \*\*/gm) ?? [], "the ladder must have four levels").toHaveLength(4)
  })

  it("gates planning to multi-story implementation rather than all work", () => {
    const gate = behavior.match(/<plan_gate>([\s\S]*?)<\/plan_gate>/)?.[1] ?? ""
    expect(gate).toContain("multi-story implementation")
    expect(gate).toMatch(/conversation|research|explanation/)
  })

  it("requires waves at authoring time, not just at execution time", () => {
    const waves = behavior.match(/<planning_in_waves>([\s\S]*?)<\/planning_in_waves>/)?.[1] ?? ""
    expect(waves).toContain("in waves from the start")
    expect(waves).toMatch(/bare acknowledgement|one-character reply/)
  })

  it("names fan-out, disjoint ownership and the review/fix/sign-off sequence", () => {
    const fanout = behavior.match(/<fan_out_agents>([\s\S]*?)<\/fan_out_agents>/)?.[1] ?? ""
    expect(fanout).toContain("fan out agents")
    expect(fanout).toContain("disjoint file ownership")
    expect(fanout).toMatch(/review agents[\s\S]*fix agents[\s\S]*sign-off/)
    for (const part of ["CONTEXT", "VERTEX", "SCOPE", "DEFINITION OF DONE", "RETURN"]) {
      expect(fanout, `delegation package missing ${part}`).toContain(`**${part}**`)
    }
  })
})

// ---------------------------------------------------------------------------
// <first_run> integrity.
//
// The verifier guidance was once spliced into the MIDDLE of this block: the
// consent question appeared, then several paragraphs of unrelated rules, then
// the yes/no handling. The flow read as broken to anyone (or any model)
// following it top to bottom, and no structural assertion noticed.
// ---------------------------------------------------------------------------

describe("<first_run> consent flow", () => {
  const firstRun = agentPrompt.match(/<first_run>([\s\S]*?)<\/first_run>/)?.[1] ?? ""

  it("sits outside the shared behavioural body", () => {
    expect(firstRun.length).toBeGreaterThan(0)
    expect(behavior).not.toContain("<first_run>")
    expect(behavior).not.toContain(".elicify-vertex-consent")
  })

  it("keeps ask → yes → no contiguous", () => {
    const ask = firstRun.indexOf("Would you like to star")
    const yes = firstRun.indexOf("If yes:")
    const no = firstRun.indexOf("If no:")
    expect(Math.min(ask, yes, no)).toBeGreaterThan(-1)
    expect(ask).toBeLessThan(yes)
    expect(yes).toBeLessThan(no)
    // Nothing unrelated wedged between the question and its handling.
    expect(firstRun.slice(ask, yes)).not.toMatch(/verif|receipt|wave|delegat/i)
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
  const toolsSource = readFileSync(resolve(here, "../src/v2/wiring/tools.ts"), "utf8")
  const registered = new Set([...toolsSource.matchAll(/(elicify_vertex_plan_\w+):/g)].map((m) => m[1]))

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

  it("holds the same contract on the slash path", async () => {
    const template = await activateTemplate()
    const named = new Set([...template.matchAll(/elicify_vertex_\w+/g)].map((m) => m[0]))
    expect([...named].filter((name) => !registered.has(name))).toEqual([])
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
