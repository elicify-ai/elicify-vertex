import { describe, expect, it } from "vitest"

import {
  findCriteriaKeyLine,
  parseCriteriaBlock,
  parseExpectArtifact,
  compareExpectation,
  type VerifierOutcomeSummary,
} from "../../src/v2/artifacts.js"

function outcome(overrides: Partial<VerifierOutcomeSummary> = {}): VerifierOutcomeSummary {
  return {
    success: true,
    failureClass: null,
    summaryLine: "18 passed",
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Test 10: artifact_parse_criteria
// Traces to: "CRITERIA block is parsed, pinned, and persisted"
// ---------------------------------------------------------------------------

describe("artifact_parse_criteria (test 10)", () => {
  it("parses a CRITERIA block into stable-order criteria", () => {
    const result = parseCriteriaBlock(
      "CRITERIA:\n1. parser handles nesting\n2. errors point at inner token",
    )
    expect(result).not.toBeNull()
    expect(result!.criteria).toEqual([
      "parser handles nesting",
      "errors point at inner token",
    ])
    expect(result!.truncated).toBe(false)
  })

  it("returns null when no CRITERIA block is present", () => {
    expect(parseCriteriaBlock("just some prose, no directive here")).toBeNull()
  })

  // -------------------------------------------------------------------------
  // B-2: bullets. A model that answered the intake scaffold with "- item"
  // used to pin NOTHING and, because the pin store is both the scaffold's
  // emission gate and its only compliance signal, score as non-compliant
  // forever with no event explaining why (9 rendered / 0 complied in the
  // field). These die if `CRITERIA_ITEM_RE` goes back to numbers only.
  // -------------------------------------------------------------------------
  it("B-2: parses a dash-bulleted CRITERIA block (a bullet list is compliance, not silence)", () => {
    const result = parseCriteriaBlock("CRITERIA:\n- parser handles nesting\n- errors point at inner token")
    expect(result).not.toBeNull()
    expect(result!.criteria).toEqual(["parser handles nesting", "errors point at inner token"])
  })

  it("B-2: parses a star-bulleted CRITERIA block", () => {
    const result = parseCriteriaBlock("CRITERIA:\n* first thing\n* second thing")
    expect(result).not.toBeNull()
    expect(result!.criteria).toEqual(["first thing", "second thing"])
  })

  it("B-2: a mixed numbered/bulleted list does not stop at the first bullet", () => {
    const result = parseCriteriaBlock("CRITERIA:\n1. numbered first\n- bulleted second\n2. numbered third")
    expect(result).not.toBeNull()
    expect(result!.criteria).toEqual(["numbered first", "bulleted second", "numbered third"])
  })

  it("B-2: bold prose is still not a bullet — `**done**` after the key parses nothing", () => {
    expect(parseCriteriaBlock("CRITERIA:\n**done** — nothing itemised here")).toBeNull()
  })

  it("B-2: bullets are capped and redacted like numbered items", () => {
    const bullets = Array.from({ length: 12 }, (_, i) => `- item ${i + 1}`).join("\n")
    const result = parseCriteriaBlock(`CRITERIA:\n${bullets}`)
    expect(result!.truncated).toBe(true)
    expect(result!.criteria).toHaveLength(10)
  })

  // -------------------------------------------------------------------------
  // B-2's OTHER half, corrected: the relaxed grammar started pinning
  // NON-criteria. Bullets plus blank-line tolerance meant the parser could
  // bridge a paragraph break and adopt the next list in the reply, whatever it
  // was. Three shapes were measured doing it, and all three are here.
  //
  // Junk pins are not inert: an unmet pinned "criterion" drives the criteria
  // stop-block, is replayed to the verifier as an acceptance criterion, and —
  // because the intake scaffold's emission gate is "the pin store is empty" —
  // a store full of junk permanently closes the gate, so the model can never
  // replace it by answering the scaffold properly.
  //
  // MUTATION PROOF for the block below: turn the blank-line `break` back into
  // `continue`, or drop the "inline remainder must parse as an item" return,
  // and these go RED while every bullet test above stays green.
  // -------------------------------------------------------------------------
  it("does not bridge a blank line into the model's plan bullets", () => {
    const text = [
      "CRITERIA:",
      "1. parser handles nesting",
      "2. errors point at inner token",
      "",
      "Here is how I will do it:",
      "- read the tokenizer",
      "- add a depth counter",
      "- run the suite",
    ].join("\n")

    const result = parseCriteriaBlock(text)

    expect(result).not.toBeNull()
    expect(result!.criteria, "the plan steps are not acceptance criteria").toEqual([
      "parser handles nesting",
      "errors point at inner token",
    ])
  })

  it("stops at the blank line even when the next list is immediately below the key line's items", () => {
    const text = ["CRITERIA:", "- one real criterion", "", "- an unrelated later bullet"].join("\n")

    expect(parseCriteriaBlock(text)!.criteria).toEqual(["one real criterion"])
  })

  it("pins nothing for a prose `Criteria:` line followed by an orientation list", () => {
    const text = [
      "Criteria: I read the request as a refactor with no behaviour change.",
      "",
      "- the module is 800 lines",
      "- there are three callers",
      "- the tests live next door",
    ].join("\n")

    expect(parseCriteriaBlock(text), "prose after the key is a sentence, not a list").toBeNull()
    // ...and the miss is still visible to the caller, which is what B-2 was for.
    expect(findCriteriaKeyLine(text)).toBe("Criteria: I read the request as a refactor with no behaviour change.")
  })

  // The same shape with no blank line to stop it. Contiguity cannot help here,
  // so this is the case the "inline remainder must itself parse as an item"
  // rule exists for.
  //
  // MUTATION PROOF: restore `if (inlineRemainder) tryConsume(inlineRemainder)`
  // (ignoring the failure and reading on) -> the two orientation bullets are
  // pinned as acceptance criteria and this goes RED.
  it("pins nothing when prose after the key runs straight into a list", () => {
    const text = [
      "Criteria: I read the request as a refactor with no behaviour change.",
      "- the module is 800 lines",
      "- there are three callers",
    ].join("\n")

    expect(parseCriteriaBlock(text)).toBeNull()
  })

  it("pins nothing for a review reply's `Criteria:` heading", () => {
    const text = [
      "I reviewed the diff against the usual dimensions.",
      "",
      "Criteria:",
      "",
      "- Correctness: the guard is in the wrong branch",
      "- Tests: none cover the failure path",
      "- Observability: no event on the refusal",
    ].join("\n")

    expect(parseCriteriaBlock(text), "review dimensions are not the task's acceptance criteria").toBeNull()
  })

  // The documented cost of contiguity, asserted rather than discovered: a
  // genuine block padded with a blank line parses as nothing — but LOUDLY,
  // because `findCriteriaKeyLine` still reports the key line and the caller
  // logs `criteria:parse-miss`. A bad pin is silent; this is not.
  it("treats a blank line between the key and its list as a parse miss, not a pin", () => {
    const text = "CRITERIA:\n\n1. parser handles nesting"
    expect(parseCriteriaBlock(text)).toBeNull()
    expect(findCriteriaKeyLine(text)).toBe("CRITERIA:")
  })

  it("still accepts the inline first-item form", () => {
    const result = parseCriteriaBlock("CRITERIA: 1. parser handles nesting\n2. errors point at inner token")
    expect(result!.criteria).toEqual(["parser handles nesting", "errors point at inner token"])
  })

  it("last-block-wins still applies when the later block is an unparseable heading", () => {
    const text = ["CRITERIA:", "1. a real earlier criterion", "", "Criteria: and now some closing prose."].join("\n")
    expect(parseCriteriaBlock(text), "the last occurrence wins even when it is empty").toBeNull()
  })

  // -------------------------------------------------------------------------
  // B-2: a parse miss must be TELLABLE from "the model never answered".
  // -------------------------------------------------------------------------
  it("B-2: findCriteriaKeyLine reports the unparseable key line so the miss can be logged", () => {
    const text = "CRITERIA: everything works\nand then some prose"
    expect(parseCriteriaBlock(text)).toBeNull()
    expect(findCriteriaKeyLine(text)).toBe("CRITERIA: everything works")
  })

  it("B-2: findCriteriaKeyLine returns null when criteria were never mentioned", () => {
    expect(findCriteriaKeyLine("just some prose, no directive here")).toBeNull()
  })

  it("B-2: findCriteriaKeyLine ignores a fenced CRITERIA key (same fence rule as the parser)", () => {
    expect(findCriteriaKeyLine("```\nCRITERIA:\n1. quoted grammar\n```")).toBeNull()
  })

  it("B-2: findCriteriaKeyLine reports the LAST key line and redacts it", () => {
    const text = "CRITERIA: first attempt\nprose\nCRITERIA: token sk-abcdefghijklmnopqrstuvwxyz012345"
    expect(findCriteriaKeyLine(text)).toContain("CRITERIA:")
    expect(findCriteriaKeyLine(text)).not.toContain("sk-abcdefghijklmnopqrstuvwxyz012345")
  })

  it("returns null for an empty/malformed CRITERIA block (no parseable items)", () => {
    expect(parseCriteriaBlock("CRITERIA:\nno numbered items follow")).toBeNull()
  })

  it("is case-insensitive on the key", () => {
    const result = parseCriteriaBlock("criteria:\n1. lowercase key still works")
    expect(result).not.toBeNull()
    expect(result!.criteria).toEqual(["lowercase key still works"])
  })

  it("last-block-wins when the model writes multiple CRITERIA blocks in one reply", () => {
    const text = [
      "CRITERIA:",
      "1. first draft item A",
      "2. first draft item B",
      "",
      "Let me redo that.",
      "CRITERIA:",
      "1. final item A",
      "2. final item B",
      "3. final item C",
    ].join("\n")
    const result = parseCriteriaBlock(text)
    expect(result).not.toBeNull()
    expect(result!.criteria).toEqual(["final item A", "final item B", "final item C"])
  })

  it("is fence-aware: a CRITERIA key inside a fenced code block does not count", () => {
    const text = [
      "Here's the grammar for reference:",
      "```",
      "CRITERIA:",
      "1. this is inside a fence and must not be captured",
      "```",
      "No real criteria block outside the fence.",
    ].join("\n")
    expect(parseCriteriaBlock(text)).toBeNull()
  })

  it("prefers a real block outside a fence over a decoy block inside one", () => {
    const text = [
      "```",
      "CRITERIA:",
      "1. decoy inside fence",
      "```",
      "CRITERIA:",
      "1. real item",
    ].join("\n")
    const result = parseCriteriaBlock(text)
    expect(result).not.toBeNull()
    expect(result!.criteria).toEqual(["real item"])
  })

  it("caps at 10 items and reports truncated: true past the cap", () => {
    const items = Array.from({ length: 12 }, (_, i) => `${i + 1}. item ${i + 1}`)
    const result = parseCriteriaBlock(`CRITERIA:\n${items.join("\n")}`)
    expect(result).not.toBeNull()
    expect(result!.criteria).toHaveLength(10)
    expect(result!.criteria).toEqual(Array.from({ length: 10 }, (_, i) => `item ${i + 1}`))
    expect(result!.truncated).toBe(true)
  })

  it("does not truncate at exactly 10 items", () => {
    const items = Array.from({ length: 10 }, (_, i) => `${i + 1}. item ${i + 1}`)
    const result = parseCriteriaBlock(`CRITERIA:\n${items.join("\n")}`)
    expect(result).not.toBeNull()
    expect(result!.criteria).toHaveLength(10)
    expect(result!.truncated).toBe(false)
  })

  it("redacts secrets found in criteria text", () => {
    const result = parseCriteriaBlock("CRITERIA:\n1. token sk-live-abcdefghijklmnopqrstuvwx must not leak")
    expect(result).not.toBeNull()
    expect(result!.criteria[0]).not.toContain("sk-live-abcdefghijklmnopqrstuvwx")
    expect(result!.criteria[0]).toContain("[REDACTED]")
  })

  it("preserves unicode/Korean criteria text intact", () => {
    const result = parseCriteriaBlock("CRITERIA:\n1. 파서가 중첩을 올바르게 처리한다")
    expect(result).not.toBeNull()
    expect(result!.criteria).toEqual(["파서가 중첩을 올바르게 처리한다"])
  })
})

// ---------------------------------------------------------------------------
// Test 11: artifact_parse_expect_confidence
// Traces to: "EXPECT mismatch fires the interrupt" / "Matching expectation
// logs calibration" / "Absent or malformed EXPECT fails open"
// ---------------------------------------------------------------------------

describe("artifact_parse_expect_confidence (test 11)", () => {
  it("parses EXPECT: text with no inline confidence", () => {
    const result = parseExpectArtifact("EXPECT: all 18 pass")
    expect(result).toEqual({ text: "all 18 pass", declared: null })
  })

  it("is case-insensitive on the key", () => {
    const result = parseExpectArtifact("expect: pass")
    expect(result).toEqual({ text: "pass", declared: null })
  })

  it("returns null for an empty EXPECT: line", () => {
    expect(parseExpectArtifact("EXPECT:")).toBeNull()
  })

  it("last-line-wins when EXPECT is duplicated", () => {
    const text = "EXPECT: first prediction\nEXPECT: second prediction wins"
    expect(parseExpectArtifact(text)).toEqual({
      text: "second prediction wins",
      declared: null,
    })
  })

  it("captures inline confidence when valid", () => {
    expect(parseExpectArtifact("EXPECT [high]: all pass")).toEqual({
      text: "all pass",
      declared: "high",
    })
  })

  it("captures declared: null for an invalid confidence enum, text still usable", () => {
    expect(parseExpectArtifact("EXPECT [90%]: all pass")).toEqual({
      text: "all pass",
      declared: null,
    })
  })

  it("does not treat a standalone CONFIDENCE: line as an artifact (F-09)", () => {
    expect(parseExpectArtifact("CONFIDENCE: high")).toBeNull()
  })

  it("is fence-aware: EXPECT inside a code fence is not captured", () => {
    const text = ["```", "EXPECT: pass", "```"].join("\n")
    expect(parseExpectArtifact(text)).toBeNull()
  })

  // --- compareExpectation: BDD "EXPECT mismatch fires the interrupt quoting the model" ---

  it("mismatch: true when a pass-predicting EXPECT meets a failing outcome", () => {
    const expect_ = parseExpectArtifact("EXPECT: all 18 tests pass")!
    const result = compareExpectation(expect_, outcome({ success: false, summaryLine: "2 failed" }))
    expect(result.mismatch).toBe(true)
    expect(result.calibration).toEqual({ declared: null, observed: "fail" })
  })

  // --- compareExpectation: BDD "Matching expectation logs calibration and stays silent" ---

  it("mismatch: false and calibration logged when a pass-predicting EXPECT meets a passing outcome", () => {
    const expect_ = parseExpectArtifact("EXPECT [high]: all tests pass")!
    const result = compareExpectation(expect_, outcome({ success: true }))
    expect(result.mismatch).toBe(false)
    expect(result.calibration).toEqual({ declared: "high", observed: "pass" })
  })

  it("records declared: null in calibration when confidence was not declared", () => {
    const expect_ = parseExpectArtifact("EXPECT: all tests pass")!
    const result = compareExpectation(expect_, outcome({ success: true }))
    expect(result.calibration).toEqual({ declared: null, observed: "pass" })
  })

  it("symmetric case: a fail-predicting EXPECT that correctly predicts failure is not a mismatch", () => {
    const expect_ = parseExpectArtifact("EXPECT: this will likely fail on the edge case")!
    const result = compareExpectation(expect_, outcome({ success: false }))
    expect(result.mismatch).toBe(false)
    expect(result.calibration).toEqual({ declared: null, observed: "fail" })
  })

  it("symmetric case: a fail-predicting EXPECT that is surprised by a pass IS a mismatch", () => {
    const expect_ = parseExpectArtifact("EXPECT: this will likely fail on the edge case")!
    const result = compareExpectation(expect_, outcome({ success: true }))
    expect(result.mismatch).toBe(true)
    expect(result.calibration).toEqual({ declared: null, observed: "pass" })
  })

  // --- compareExpectation: BDD "Absent or malformed EXPECT fails open" ---

  it("fails open with no calibration when expect is null, regardless of outcome", () => {
    expect(compareExpectation(null, outcome({ success: false }))).toEqual({
      mismatch: false,
      calibration: null,
    })
    expect(compareExpectation(null, outcome({ success: true }))).toEqual({
      mismatch: false,
      calibration: null,
    })
  })

  // --- compareExpectation: negation-awareness (review MAJ finding) ---
  //
  // FAIL_PREDICTION_RE previously flagged any occurrence of "error"/"fail"/
  // "break"/"crash" as a fail prediction, even when immediately negated
  // ("no errors" contains "errors" -> misread as predicting failure). When
  // the verifier then genuinely failed, predicted("fail") === observed("fail")
  // read as a MATCH — silently suppressing the real anomaly interrupt, even
  // though the model's actual prediction ("no errors") was wrong.

  it("negation fix: 'no errors, all green' now correctly detects a mismatch when the verifier fails (previously a false negative)", () => {
    const expect_ = parseExpectArtifact("EXPECT: no errors, all green")!
    const result = compareExpectation(expect_, outcome({ success: false, summaryLine: "3 failed" }))
    expect(result.mismatch).toBe(true)
    expect(result.calibration).toEqual({ declared: null, observed: "fail" })
  })

  it("negation fix: 'no errors, all green' still matches (no mismatch) when the verifier actually passes", () => {
    const expect_ = parseExpectArtifact("EXPECT: no errors, all green")!
    const result = compareExpectation(expect_, outcome({ success: true }))
    expect(result.mismatch).toBe(false)
    expect(result.calibration).toEqual({ declared: null, observed: "pass" })
  })

  it.each([
    ["no crash", "EXPECT: no crash expected here"],
    ["won't fail", "EXPECT: this won't fail"],
    ["shouldn't error", "EXPECT: shouldn't error on empty input"],
    ["doesn't break", "EXPECT: doesn't break existing callers"],
    ["never fails", "EXPECT: this suite never fails"],
    ["isn't broken", "EXPECT: the build isn't broken"],
  ])("negation fix: %s reads as a PASS prediction (mismatch when verifier fails)", (_label, text) => {
    const expect_ = parseExpectArtifact(text)!
    const failing = compareExpectation(expect_, outcome({ success: false }))
    expect(failing.mismatch).toBe(true)
    expect(failing.calibration).toEqual({ declared: null, observed: "fail" })

    const passing = compareExpectation(expect_, outcome({ success: true }))
    expect(passing.mismatch).toBe(false)
    expect(passing.calibration).toEqual({ declared: null, observed: "pass" })
  })

  it("negation fix: an explicit fail-prediction stays a fail-prediction (negation word present but not adjacent to the keyword, and the keyword is not itself negated)", () => {
    const expect_ = parseExpectArtifact("EXPECT: expect this to still fail, that's expected")!
    const matchesFail = compareExpectation(expect_, outcome({ success: false }))
    expect(matchesFail.mismatch).toBe(false)
    expect(matchesFail.calibration).toEqual({ declared: null, observed: "fail" })

    const surprisedByPass = compareExpectation(expect_, outcome({ success: true }))
    expect(surprisedByPass.mismatch).toBe(true)
  })

  it("negation fix: already-negated-pass phrases ('won't pass') are unaffected — still read as fail-predicting, not double-negated back to pass", () => {
    const expect_ = parseExpectArtifact("EXPECT: this won't pass in its current state")!
    const result = compareExpectation(expect_, outcome({ success: false }))
    expect(result.mismatch).toBe(false)
    expect(result.calibration).toEqual({ declared: null, observed: "fail" })
  })

  it("negation fix: no existing non-negated fail-predicting text changes outcome ('will likely fail' / 'expect the build to break')", () => {
    const willFail = parseExpectArtifact("EXPECT: this will likely fail on the edge case")!
    expect(compareExpectation(willFail, outcome({ success: false })).mismatch).toBe(false)
    expect(compareExpectation(willFail, outcome({ success: true })).mismatch).toBe(true)

    const willBreak = parseExpectArtifact("EXPECT: expect the build to break here")!
    expect(compareExpectation(willBreak, outcome({ success: false })).mismatch).toBe(false)
    expect(compareExpectation(willBreak, outcome({ success: true })).mismatch).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Dataset: Artifact parsing (EXPECT / CONFIDENCE / CRITERIA) — all 11 rows
// ---------------------------------------------------------------------------

describe("Dataset: Artifact parsing", () => {
  it("row 1: EXPECT: all 18 pass -> captured", () => {
    expect(parseExpectArtifact("EXPECT: all 18 pass")).toEqual({
      text: "all 18 pass",
      declared: null,
    })
  })

  it("row 2: expect: pass (lowercase) -> captured, case-insensitive key", () => {
    expect(parseExpectArtifact("expect: pass")).toEqual({ text: "pass", declared: null })
  })

  it("row 3: EXPECT: (empty) -> not captured", () => {
    expect(parseExpectArtifact("EXPECT:")).toBeNull()
  })

  it("row 4: two EXPECT lines -> last wins", () => {
    const text = "EXPECT: all pass\nEXPECT: nope, actually all fail this time"
    expect(parseExpectArtifact(text)).toEqual({
      text: "nope, actually all fail this time",
      declared: null,
    })
  })

  it("row 5: EXPECT [high]: all pass -> {text, declared: high}", () => {
    expect(parseExpectArtifact("EXPECT [high]: all pass")).toEqual({
      text: "all pass",
      declared: "high",
    })
  })

  it("row 6: EXPECT [90%]: all pass -> declared: null, text still usable", () => {
    expect(parseExpectArtifact("EXPECT [90%]: all pass")).toEqual({
      text: "all pass",
      declared: null,
    })
  })

  it("row 6b: CONFIDENCE: high on its own line -> ignored, not an artifact", () => {
    expect(parseExpectArtifact("CONFIDENCE: high")).toBeNull()
  })

  it("row 7: CRITERIA:\\n1. a\\n2. b -> 2 pins C1,C2", () => {
    const result = parseCriteriaBlock("CRITERIA:\n1. a\n2. b")
    expect(result).not.toBeNull()
    expect(result!.criteria).toEqual(["a", "b"])
    expect(result!.truncated).toBe(false)
  })

  it("row 8: criteria with 12 items -> 10 pinned, truncation event", () => {
    const items = Array.from({ length: 12 }, (_, i) => `${i + 1}. c${i + 1}`)
    const result = parseCriteriaBlock(`CRITERIA:\n${items.join("\n")}`)
    expect(result).not.toBeNull()
    expect(result!.criteria).toHaveLength(10)
    expect(result!.truncated).toBe(true)
  })

  it("row 9: criteria containing sk-live-... token -> pinned text redacted", () => {
    const result = parseCriteriaBlock(
      "CRITERIA:\n1. rotate key sk-live-abcdefghijklmnopqrstuvwx before ship",
    )
    expect(result).not.toBeNull()
    expect(result!.criteria[0]).not.toContain("sk-live-abcdefghijklmnopqrstuvwx")
    expect(result!.criteria[0]).toContain("[REDACTED]")
  })

  it("row 10: unicode/Korean criteria item -> pinned intact", () => {
    const result = parseCriteriaBlock("CRITERIA:\n1. 유니코드 기준이 손실 없이 저장된다")
    expect(result).not.toBeNull()
    expect(result!.criteria).toEqual(["유니코드 기준이 손실 없이 저장된다"])
  })

  it("row 11: EXPECT inside code fence -> not captured (fence-aware)", () => {
    const text = ["some narrative", "```", "EXPECT: pass", "```", "more narrative"].join("\n")
    expect(parseExpectArtifact(text)).toBeNull()
  })
})
