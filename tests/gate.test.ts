import { describe, expect, it } from "vitest"
import {
  classifyTask,
  contextForMode,
  formatDirectives,
  type Directive,
} from "../src/index.js"
import { EvidenceLedger } from "../src/index.js"

// ---------------------------------------------------------------------------
// Gate core: these tests would have caught the parity gaps flagged by the
// fablize replication analysis. They verify the behaviours that, if wrong,
// cause the harness to be net-negative (the "harness paradox" risk).
// ---------------------------------------------------------------------------

describe("EvidenceLedger", () => {
  it("starts empty: no changes, no verification, no failures", () => {
    const l = new EvidenceLedger()
    l.reset("s1")
    expect(l.hasChangedFiles("s1")).toBe(false)
    expect(l.hasVerification("s1")).toBe(false)
    expect(l.getRepeatFailure("s1")).toBeNull()
    expect(l.summary("s1")).toBeNull()
    expect(l.shouldBlockStop("s1")).toBe(false)
    expect(l.getStopBlocks("s1")).toBe(0)
  })

  it("records a changed file but no verification → blocks", () => {
    const l = new EvidenceLedger()
    l.reset("s1", "deep")
    l.recordChangedFiles("s1")
    expect(l.hasChangedFiles("s1")).toBe(true)
    expect(l.hasVerification("s1")).toBe(false)
    expect(l.shouldBlockStop("s1")).toBe(true)
    expect(l.summary("s1")).toBe("files changed: yes")
  })

  it("records a successful verification → does not block", () => {
    const l = new EvidenceLedger()
    l.reset("s1")
    l.recordChangedFiles("s1")
    l.recordVerification("s1", "npm test", 0, true)
    expect(l.hasVerification("s1")).toBe(true)
    expect(l.shouldBlockStop("s1")).toBe(false)
  })

  it("records a failed verification → still blocks (no success)", () => {
    const l = new EvidenceLedger()
    l.reset("s1", "deep")
    l.recordChangedFiles("s1")
    l.recordVerification("s1", "npm test", 1, false)
    expect(l.shouldBlockStop("s1")).toBe(true)
  })

  it("detects a repeat failure after two matching signatures", () => {
    const l = new EvidenceLedger()
    l.reset("s1")
    l.recordFailure("s1", "1:error: not found")
    expect(l.getRepeatFailure("s1")).toBeNull()
    l.recordFailure("s1", "1:error: not found")
    expect(l.getRepeatFailure("s1")).toEqual({
      signature: "1:error: not found",
      count: 2,
    })
  })

  it("does not repeat-count different signatures", () => {
    const l = new EvidenceLedger()
    l.reset("s1")
    l.recordFailure("s1", "1:error A")
    l.recordFailure("s1", "1:error B")
    expect(l.getRepeatFailure("s1")).toBeNull()
  })

  it("incrementStopBlocks is session-cumulative across resets", () => {
    const l = new EvidenceLedger()
    l.incrementStopBlocks("s1") // pre-existing count
    l.reset("s1") // reset per-turn evidence but keep stopBlocks
    expect(l.getStopBlocks("s1")).toBe(1)
    l.incrementStopBlocks("s1")
    l.reset("s1")
    expect(l.getStopBlocks("s1")).toBe(2)
  })

  it("summary includes verified and failed counts", () => {
    const l = new EvidenceLedger()
    l.reset("s1")
    l.recordChangedFiles("s1")
    l.recordVerification("s1", "cmd1", 0, true)
    l.recordVerification("s1", "cmd2", 0, true)
    l.recordVerification("s1", "cmd3", 1, false)
    expect(l.summary("s1")).toBe("files changed: yes · verified: 2 · failed: 1")
  })

  it("does not block on docs-only changes (mode is captured separately; gate is evidence-based)", () => {
    // Per fablize parity: mode-aware stop policy will check mode separately.
    // This test pins the current EvidenceLedger contract: shouldBlockStop is
    // evidence-based only; the mode gate is additive.
    const l = new EvidenceLedger()
    l.reset("s1")
    l.recordVerification("s1", "true", 0, true)
    expect(l.shouldBlockStop("s1")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Task classifier — used by signal-routed injection.
// fablize parity: classifyTask must put the prompt in the right bucket so
// the right procedure lands in the system transform.
// ---------------------------------------------------------------------------

describe("classifyTask", () => {
  it("detects debugging signals", () => {
    expect(classifyTask("fix the bug in login")).toBe("debugging")
    expect(classifyTask("error in the test")).toBe("debugging")
    expect(classifyTask("traceback when running")).toBe("debugging")
    expect(classifyTask("it's not working")).toBe("debugging")
    expect(classifyTask("fix the broken build")).toBe("debugging")
  })

  it("detects render signals", () => {
    expect(classifyTask("build the HTML page")).toBe("render")
    expect(classifyTask("create an SVG icon")).toBe("render")
    expect(classifyTask("render the chart")).toBe("render")
    expect(classifyTask("fix the game UI")).toBe("render")
    expect(classifyTask("build a dashboard")).toBe("render")
  })

  it("detects build signals", () => {
    expect(classifyTask("implement the parser")).toBe("build")
    expect(classifyTask("refactor the auth module")).toBe("build")
    expect(classifyTask("add a new endpoint")).toBe("build")
    expect(classifyTask("deploy to staging")).toBe("build")
  })

  it("falls back to baseline when no signal matches", () => {
    expect(classifyTask("hello world")).toBe("baseline")
    expect(classifyTask("")).toBe("baseline")
  })
})

// ---------------------------------------------------------------------------
// contextForMode — must return the full anti-bypass procedure, not a
// compressed one-liner (fablize-prompt-comparison subagent, rows 15-18).
// ---------------------------------------------------------------------------

describe("contextForMode", () => {
  it("returns null for baseline and build", () => {
    expect(contextForMode("baseline")).toBeNull()
    expect(contextForMode("build")).toBeNull()
  })

  it("returns a directive with the full investigation procedure for debugging", () => {
    const d = contextForMode("debugging")
    expect(d).not.toBeNull()
    expect(d!.id).toBe("vertex:investigation")
    // Must contain the 6-step discipline, not just a summary
    expect(d!.text).toMatch(/reproduce first/i)
    expect(d!.text).toMatch(/at least three/i)
    expect(d!.text).toMatch(/causal chain/i)
    expect(d!.text).toMatch(/verify before and after/i)
    // Must mention rejected hypotheses (specifically or in list form)
    expect(/rejected hypothesis|rejected\b.*\bhypothesis/i.test(d!.text) || d!.text.toLowerCase().includes("rejected")).toBe(true)
    // Anti-anchoring: must warn against "most visible signal is not root cause"
    expect(d!.text).toMatch(/most visible signal/i)
    // Anti-tautology: must distinguish fix from defect removal
    expect(d!.text).toMatch(/latent/i)
  })

  it("returns a directive with the full grounding procedure for render", () => {
    const d = contextForMode("render")
    expect(d).not.toBeNull()
    expect(d!.id).toBe("vertex:grounding")
    // Must contain the ground loop, not just a summary
    expect(d!.text).toMatch(/RUN IT/i)
    expect(d!.text).toMatch(/OBSERVE/i)
    expect(d!.text).toMatch(/FIX.*OBSERVATION/i)
    // Must distinguish execution from additional testing
    expect(d!.text).toMatch(/MODALITY/i)
    // Must distinguish rendered output from authored output
    expect(d!.text).toMatch(/well-formed and correct/i)
  })
})

// ---------------------------------------------------------------------------
// formatDirectives — preserves anti-bypass contract:
// must wrap directives in a tagged envelope the model cannot forge
// ---------------------------------------------------------------------------

describe("formatDirectives (anti-bypass contract)", () => {
  it("wraps directives in a tagged envelope", () => {
    const out = formatDirectives([{ id: "x", text: "do thing" }])
    expect(out).toMatch(/^<vertex-directives/)
    expect(out).toMatch(/<\/vertex-directives>$/)
    // Must include directive id
    expect(out).toMatch(/\[x/)
  })

  it("returns null for empty input (no spam injection)", () => {
    expect(formatDirectives([])).toBeNull()
  })
})
