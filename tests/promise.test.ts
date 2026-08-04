import { describe, expect, it } from "vitest"
import {
  detectPromiseNoAct,
  PROMISE_NO_ACT_LABELS,
  shouldBlockPromiseNoAct,
} from "../src/index.js"

// ---------------------------------------------------------------------------
// Promise-no-act detector (finish-the-work policy)
// Explicit deferral markers, issue-filing, follow-up, constrained later/
// tracked/tracking (no bare-keyword FPs), and ask-user exemption.
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

  it("detects constrained 'is tracked' / 'tracked for' (not bare tracked)", () => {
    const hits = detectPromiseNoAct("Bug is tracked for next release.")
    expect(hits.some((h) => h.label === "tracked-instead-of-fixed")).toBe(true)

    const hits2 = detectPromiseNoAct("Filed in the issue-tracker.")
    expect(hits2.some((h) => h.label === "tracked-instead-of-fixed")).toBe(false)
  })

  it("detects constrained 'still tracking'", () => {
    const hits = detectPromiseNoAct("Still tracking the flaky test.")
    expect(hits.some((h) => h.label === "tracked-instead-of-fixed")).toBe(true)
  })

  it("detects 'later' only with future intent (will/I'll … later)", () => {
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

describe("detectPromiseNoAct — future-intent pattern", () => {
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
    expect(hits.some((h) => h.label === "future-intent")).toBe(true)
  })

  it("detects 'we should X later' pattern", () => {
    const hits = detectPromiseNoAct(
      "Works for now. We should optimize later.",
    )
    expect(hits.some((h) => h.label === "we-should-X-later")).toBe(true)
  })

  it("detects 'I will write next'", () => {
    const hits = detectPromiseNoAct(
      "Refactor is in. I will write tests next.",
    )
    expect(hits.some((h) => h.label === "future-intent")).toBe(true)
  })
})

describe("detectPromiseNoAct — false-positive guards", () => {
  it("does NOT match 'tracked down'", () => {
    const hits = detectPromiseNoAct("I tracked down the bug and fixed it.")
    expect(hits.filter((h) => h.label === "tracked-instead-of-fixed").length).toBe(0)
  })

  it("does NOT match 'later section' / 'see you later'", () => {
    expect(detectPromiseNoAct("See the later section for details.")).toEqual([])
    expect(detectPromiseNoAct("See you later.")).toEqual([])
  })

  it("does NOT match bare tracking without deferral shape", () => {
    const hits = detectPromiseNoAct("The bug tracking ticket is closed.")
    expect(hits.filter((h) => h.label === "tracked-instead-of-fixed").length).toBe(0)
    expect(hits.filter((h) => h.label === "tracking").length).toBe(0)
  })

  it("does NOT match 'tracked' inside 'issue tracker' (compound word)", () => {
    const hits = detectPromiseNoAct(
      "Found three stale entries in the issue tracker.",
    )
    expect(hits.filter((h) => h.label === "tracked-instead-of-fixed").length).toBe(0)
  })

  it("does NOT match standalone 'tracked' inside a hyphenated compound", () => {
    const hits = detectPromiseNoAct(
      "Filed in the issue-tracker.",
    )
    expect(hits.filter((h) => h.label === "tracked-instead-of-fixed").length).toBe(0)
  })

  it("does NOT match bare 'time tracking' (no constrained shape)", () => {
    const hits = detectPromiseNoAct(
      "Stopped the time tracking integration.",
    )
    expect(hits.filter((h) => h.label === "tracked-instead-of-fixed").length).toBe(0)
  })

  it("does NOT match 'later' as part of a larger word (e.g. 'lateral')", () => {
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

  it("does NOT match harmless 'let me know' or 'we should be done' phrasing", () => {
    expect(detectPromiseNoAct("Let me know if you want more detail.")).toEqual([])
    expect(detectPromiseNoAct("The implementation is complete; we should be done.")).toEqual([])
  })
})

describe("detectPromiseNoAct — multilingual annotations", () => {
  it("detects Korean future intent and identifies its locale", () => {
    const hits = detectPromiseNoAct("테스트는 아직 실행하지 않았습니다. 나중에 진행하겠습니다.")
    expect(hits.some((hit) => hit.locale === "ko" && hit.label === "later-marker")).toBe(true)
    expect(hits.some((hit) => hit.locale === "ko" && hit.label === "future-intent")).toBe(true)
  })

  it("detects Korean tracking language", () => {
    const hits = detectPromiseNoAct("이 문제는 추적하겠습니다.")
    expect(hits).toContainEqual(expect.objectContaining({
      locale: "ko",
      label: "tracked-instead-of-fixed",
    }))
  })
})

describe("shouldBlockPromiseNoAct — completion state", () => {
  it("blocks promised remaining work after file changes when unverified", () => {
    const text = "TODO: add the missing test later."
    expect(shouldBlockPromiseNoAct(text, true)).toBe(true)
    expect(shouldBlockPromiseNoAct(text, true, false)).toBe(true)
    expect(shouldBlockPromiseNoAct(text, false)).toBe(false)
  })

  it("blocks verified work only on STRONG labels (TODO)", () => {
    expect(shouldBlockPromiseNoAct("TODO: add the missing test later.", true, true)).toBe(true)
  })

  it("does NOT block verified soft phrasings (see you later / tracked down)", () => {
    expect(shouldBlockPromiseNoAct("See you later.", true, true)).toBe(false)
    expect(shouldBlockPromiseNoAct("I tracked down the bug.", true, true)).toBe(false)
  })

  it("does NOT block when the tail asks the user (even with later)", () => {
    expect(
      shouldBlockPromiseNoAct(
        "I can ship this later. Would you like me to continue?",
        true,
        false,
      ),
    ).toBe(false)
    expect(
      shouldBlockPromiseNoAct(
        "Should I file an issue for the follow-up, or keep going?",
        true,
        false,
      ),
    ).toBe(false)
  })

  it("does not treat bare trailing OK? as an ask-user exemption", () => {
    expect(shouldBlockPromiseNoAct("TODO remaining.\nOK?", true, false)).toBe(true)
    expect(shouldBlockPromiseNoAct("I will implement the cache next.\nReady?", true, false)).toBe(true)
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

  it("still hits TODO later, I'll implement next, file an issue", () => {
    expect(detectPromiseNoAct("TODO later").some((h) => h.label === "todo-marker")).toBe(true)
    expect(
      detectPromiseNoAct("I'll implement the cache next.").some((h) => h.label === "future-intent"),
    ).toBe(true)
    expect(
      detectPromiseNoAct("Please file an issue for the remaining edge case.").some(
        (h) => h.label === "issue-filing",
      ),
    ).toBe(true)
  })

  it("PROMISE_NO_ACT_LABELS exposes the full set used by the detector", () => {
    expect(PROMISE_NO_ACT_LABELS.length).toBeGreaterThan(10)
  })

  it("is case-insensitive", () => {
    const hits = detectPromiseNoAct(
      "TODO: handle this. Will File An Issue.",
    )
    expect(hits.length).toBeGreaterThanOrEqual(2)
  })

  it("only inspects the tail (last 600 chars)", () => {
    // TODO buried deep enough that the last-600 window doesn't reach it.
    const padded = "x".repeat(700) + " TODO buried in middle " + "x".repeat(700)
    const hits = detectPromiseNoAct(padded)
    expect(hits.some((h) => h.label === "todo-marker")).toBe(false)

    const padded2 = "x".repeat(500) + " TODO at the tail"
    const hits2 = detectPromiseNoAct(padded2)
    expect(hits2.some((h) => h.label === "todo-marker")).toBe(true)
  })
})
