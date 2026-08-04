/**
 * Pure formatters and ledger helpers that are LIVE in v2 wiring but lost their
 * only tests when the v1 plugin's test files were deleted. Re-homed here; none
 * of these cases touched the v1 plugin.
 *
 *   formatChangedPathsForReason  3 call sites (gate.ts)
 *   formatGateContinuationText   7 call sites (gate.ts)
 *   formatActivateCue            3 call sites (plugin.ts)
 *   EvidenceLedger.markRepeatFired  2 call sites (plugin.ts)
 */
import { describe, expect, it } from "vitest"
import {
  EvidenceLedger,
  formatActivateCue,
  formatChangedPathsForReason,
  formatGateContinuationText,
} from "../src/index.js"

describe("formatChangedPathsForReason", () => {
  it("names the paths", () => {
    expect(formatChangedPathsForReason(["src/a.ts", "src/b.ts"])).toBe("src/a.ts, src/b.ts")
  })

  it("labels the pseudo-path markers rather than leaking them raw", () => {
    expect(formatChangedPathsForReason(["bash-mutation"])).toBe("(shell mutation)")
    expect(formatChangedPathsForReason(["edit-mutation"])).toBe("(file edit)")
    expect(formatChangedPathsForReason(["patch-mutation"])).toBe("(patch)")
  })

  it("falls back to a generic label when nothing is known", () => {
    expect(formatChangedPathsForReason([])).toBe("files changed")
  })

  it("caps the list and says how many more there are", () => {
    const out = formatChangedPathsForReason(["a", "b", "c", "d", "e", "f", "g"], 3)
    expect(out).toContain("a, b, c")
    expect(out).toMatch(/\+\s*4|4 more/)
  })
})

describe("formatGateContinuationText", () => {
  // The headline branch is invisible to the gate tests, which strip it.
  it("selects the promise headline", () => {
    expect(formatGateContinuationText("[vertex:promise-no-act] finish it")).toContain("unfinished work signaled")
  })

  it("selects the verification headline for a stop-block", () => {
    expect(formatGateContinuationText("[vertex:stop-block] run the tests")).toContain("verification required")
  })

  it("falls back to the plain headline", () => {
    const out = formatGateContinuationText("[vertex:plan-incomplete] two stories open")
    expect(out).toContain("[vertex] completion paused")
    expect(out).not.toContain("verification required")
  })

  it("keeps the reason body after the headline", () => {
    expect(formatGateContinuationText("do the thing")).toMatch(/\n\ndo the thing$/)
  })

  it("redacts a secret in the reason", () => {
    const out = formatGateContinuationText("token ghp_abcdefghijklmnopqrstuvwxyz0123456789 leaked")
    expect(out).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789")
  })
})

describe("formatActivateCue", () => {
  it("states the mode and agent", () => {
    const cue = formatActivateCue({ stopMode: "deep", agent: "elicify-vertex-agent" } as never)
    expect(cue).toContain("[vertex] harness on")
    expect(cue).toContain("deep")
  })

  it("redacts a secret that reaches the cue", () => {
    const cue = formatActivateCue({
      stopMode: "quick",
      agent: "AKIAIOSFODNN7EXAMPLE",
    } as never)
    expect(cue).not.toContain("AKIAIOSFODNN7EXAMPLE")
  })
})

describe("EvidenceLedger.markRepeatFired", () => {
  it("fires once per signature, then suppresses", () => {
    const l = new EvidenceLedger()
    l.reset("s1")
    expect(l.markRepeatFired("s1", "sig-a")).toBe(true)
    expect(l.markRepeatFired("s1", "sig-a")).toBe(false)
  })

  it("tracks signatures independently", () => {
    const l = new EvidenceLedger()
    l.reset("s1")
    expect(l.markRepeatFired("s1", "sig-a")).toBe(true)
    expect(l.markRepeatFired("s1", "sig-b")).toBe(true)
  })

  it("does not throw when the session has no ledger", () => {
    expect(() => new EvidenceLedger().markRepeatFired("nope", "sig")).not.toThrow()
  })
})
