import { describe, expect, it } from "vitest"
import {
  detectPromiseNoAct,
  PROMISE_NO_ACT_LABELS,
} from "../src/index.js"

// ---------------------------------------------------------------------------
// Promise-no-act detector — strictly better than fablize finish-the-work.sh
// (fablize matches only future-intent phrases; we match explicit deferral
// markers, issue-filing intent, follow-up language, and standalone "later".)
// ---------------------------------------------------------------------------

describe("detectPromiseNoAct — explicit deferral markers", () => {
  it("detects 'TODO' marker", () => {
    const hits = detectPromiseNoAct(
      "I implemented the fix and ran the tests.\nTODO: handle the edge case next.",
    )
    expect(hits.some((h) => h.label === "todo-marker")).toBe(true)
  })

  it("detects 'FIXME' marker", () => {
    const hits = detectPromiseNoAct(
      "All tests pass. FIXME: this needs proper error handling.",
    )
    expect(hits.some((h) => h.label === "fixme-marker")).toBe(true)
  })

  it("detects 'XXX' marker", () => {
    const hits = detectPromiseNoAct(
      "Tests pass.\nXXX add retry logic\nDone for now.",
    )
    expect(hits.some((h) => h.label === "xxx-marker")).toBe(true)
  })

  it("detects explicit 'deferred' word", () => {
    const hits = detectPromiseNoAct(
      "Verification was deferred to a later PR. Code is in the commit.",
    )
    expect(hits.some((h) => h.label === "explicit-deferral")).toBe(true)
  })

  it("detects 'tracked' (not part of 'issue tracker' compound word)", () => {
    // 'tracked' as a stand-alone word should hit
    const hits = detectPromiseNoAct("Bug is tracked for next release.")
    expect(hits.some((h) => h.label === "tracked-instead-of-fixed")).toBe(true)

    // 'issue-tracker' / 'issue tracking' should NOT hit (compound)
    const hits2 = detectPromiseNoAct("Filed in the issue-tracker.")
    expect(hits2.some((h) => h.label === "tracked-instead-of-fixed")).toBe(false)
  })

  it("detects 'tracking' as stand-alone word", () => {
    const hits = detectPromiseNoAct("Still tracking the flaky test.")
    expect(hits.some((h) => h.label === "tracked-instead-of-fixed")).toBe(true)
  })

  it("detects 'later' (the most common trailing marker)", () => {
    const hits = detectPromiseNoAct("Tests pass. Will add type hints later.")
    expect(hits.some((h) => h.label === "later-marker")).toBe(true)
  })

  it("detects 'follow up' and 'follow-up'", () => {
    expect(
      detectPromiseNoAct("Implementation looks good, will follow up with tests.").some(
        (h) => h.label === "follow-up",
      ),
    ).toBe(true)
    expect(
      detectPromiseNoAct("Will follow-up on the edge cases.").some(
        (h) => h.label === "follow-up",
      ),
    ).toBe(true)
  })

  it("detects 'in a follow'", () => {
    expect(
      detectPromiseNoAct(
        "Will clean up the unused import in a follow.",
      ).some((h) => h.label === "follow-up"),
    ).toBe(true)
  })

  it("detects 'next iteration'", () => {
    expect(
      detectPromiseNoAct("Optimization will happen next iteration.").some(
        (h) => h.label === "next-iteration",
      ),
    ).toBe(true)
  })

  it("detects 'for tracking purposes'", () => {
    expect(
      detectPromiseNoAct(
        "Filed for tracking purposes. Not in scope.",
      ).some((h) => h.label === "tracking"),
    ).toBe(true)
  })
})

describe("detectPromiseNoAct — issue-filing intent", () => {
  it("detects 'file an issue' (the user's explicit example)", () => {
    const hits = detectPromiseNoAct(
      "This needs more work. I'll file an issue for the team to track.",
    )
    expect(hits.some((h) => h.label === "issue-filing")).toBe(true)
  })

  it("detects 'I'll file' variations", () => {
    expect(
      detectPromiseNoAct(
        "I'll file a follow-up for the broken test.",
      ).some((h) => h.label === "issue-filing"),
    ).toBe(true)
  })
})

describe("detectPromiseNoAct — future-intent pattern (fablize parity)", () => {
  it("detects 'I'll implement next' pattern", () => {
    const hits = detectPromiseNoAct(
      "Tests pass. I'll implement the cache layer next.",
    )
    expect(hits.some((h) => h.label === "future-intent")).toBe(true)
  })

  it("detects 'let me run next' pattern", () => {
    const hits = detectPromiseNoAct(
      "Code is in. Let me run the benchmarks next.",
    )
    expect(hits.some((h) => h.label === "let-me-do-X-next")).toBe(true)
  })

  it("detects 'we should X later' pattern", () => {
    const hits = detectPromiseNoAct(
      "Works for now. We should optimize later.",
    )
    // could match either 'we should' or 'later' — both valid
    expect(hits.length).toBeGreaterThan(0)
  })

  it("detects 'I will write next'", () => {
    const hits = detectPromiseNoAct(
      "Refactor is in. I will write tests next.",
    )
    expect(hits.some((h) => h.label === "future-intent")).toBe(true)
  })
})

describe("detectPromiseNoAct — false-positive guards", () => {
  it("does NOT match 'tracked' inside 'issue tracker' (compound word)", () => {
    const hits = detectPromiseNoAct(
      "Found three stale entries in the issue tracker.",
    )
    expect(hits.filter((h) => h.label === "tracked-instead-of-fixed").length).toBe(0)
  })

  it("does NOT match standalone 'tracked' inside a hyphenated compound", () => {
    // The hyphen keeps it inside one token. 'tracked' is part of
    // 'issue-tracker', so it does NOT trigger.
    const hits = detectPromiseNoAct(
      "Filed in the issue-tracker.",
    )
    expect(hits.filter((h) => h.label === "tracked-instead-of-fixed").length).toBe(0)
  })

  it("'time tracking' (two separate words) DOES trigger — word boundaries are real", () => {
    // 'time' and 'tracking' are separate words separated by a space. 'tracking'
    // is a stand-alone word, not part of a compound — so this SHOULD trigger.
    // The earlier 'does NOT match issue tracker' test is about compound
    // identifiers joined by '-', not about space-separated words.
    const hits = detectPromiseNoAct(
      "Stopped the time tracking integration.",
    )
    expect(hits.filter((h) => h.label === "tracked-instead-of-fixed").length).toBe(1)
  })

  it("does NOT match 'later' as part of a larger word (e.g. 'lateral', 'comply-later-violations')", () => {
    // 'lateral' contains 'later' but not as a stand-alone word
    const hits = detectPromiseNoAct("Lateral movement of data.")
    expect(hits.filter((h) => h.label === "later-marker").length).toBe(0)
  })

  it("does NOT match 'todo' as part of a larger word", () => {
    const hits = detectPromiseNoAct(
      "Implemented the photoalbum and todolist features.",
    )
    expect(hits.filter((h) => h.label === "todo-marker").length).toBe(0)
  })

  it("returns empty array for empty text", () => {
    expect(detectPromiseNoAct("")).toEqual([])
  })

  it("returns empty array for clean completion message", () => {
    const hits = detectPromiseNoAct(
      "All tests pass. The feature is complete and verified.",
    )
    expect(hits).toEqual([])
  })
})

describe("detectPromiseNoAct — comprehensive coverage", () => {
  it("multiple hits on a single message are all returned (for measurement)", () => {
    const hits = detectPromiseNoAct(
      "TODO: FIXME: I'll file an issue later for the follow-up.",
    )
    const labels = hits.map((h) => h.label)
    expect(labels).toContain("todo-marker")
    expect(labels).toContain("fixme-marker")
    expect(labels).toContain("issue-filing")
    expect(labels).toContain("later-marker")
    expect(labels).toContain("follow-up")
  })

  it("PROMISE_NO_ACT_LABELS exposes the full set used by the detector", () => {
    // Sanity: the export exists and is non-empty
    expect(PROMISE_NO_ACT_LABELS.length).toBeGreaterThan(10)
  })

  it("is case-insensitive", () => {
    const hits = detectPromiseNoAct(
      "TODO: handle this LATER. Will File An Issue.",
    )
    expect(hits.length).toBeGreaterThanOrEqual(3)
  })

  it("only inspects the tail (last 600 chars)", () => {
    // TODO buried deep enough that the last-600 window doesn't reach it.
    // We sandwich the marker between two 700-char padding blocks so the
    // tail (last 600 chars) doesn't include the TODO.
    const padded = "x".repeat(700) + " TODO buried in middle " + "x".repeat(700)
    const hits = detectPromiseNoAct(padded)
    expect(hits.some((h) => h.label === "todo-marker")).toBe(false)

    // TODO at the tail (within the last 600 chars) should trigger.
    const padded2 = "x".repeat(500) + " TODO at the tail"
    const hits2 = detectPromiseNoAct(padded2)
    expect(hits2.some((h) => h.label === "todo-marker")).toBe(true)
  })
})
