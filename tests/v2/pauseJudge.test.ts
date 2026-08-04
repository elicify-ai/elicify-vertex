/**
 * `parsePauseVerdict` — the tolerant reply parser (MIN-007: it had no unit
 * tests; only two clean-JSON strings reached it via integration).
 *
 * This parser is the last thing between a model's prose and a user-authority
 * message, so its bias matters: the prompt is deliberately tilted toward
 * `awaiting-user`, and a parser that resolves ambiguity the other way would
 * quietly undo that.
 */
import { describe, expect, it } from "vitest"

import { parsePauseVerdict } from "../../src/v2/pauseJudge.js"

describe("parsePauseVerdict", () => {
  it.each([
    ['{"verdict":"awaiting-user"}', "awaiting-user"],
    ['{"verdict":"stopped-mid-work"}', "stopped-mid-work"],
    ['{ "verdict" : "awaiting-user" }', "awaiting-user"],
    ['```json\n{"verdict":"stopped-mid-work"}\n```', "stopped-mid-work"],
    ['```\n{"verdict":"awaiting-user"}\n```', "awaiting-user"],
    ['Here is my answer: {"verdict":"awaiting-user"}', "awaiting-user"],
  ])("reads %j", (input, expected) => {
    expect(parsePauseVerdict(input as string)).toBe(expected)
  })

  // A reply naming BOTH verdicts is unreadable, not a vote for whichever came
  // first. Taking the first match inverted the prompt's awaiting-user bias:
  // this exact string used to resolve to stopped-mid-work.
  it("returns null when the reply names both verdicts", () => {
    expect(
      parsePauseVerdict('I would not say {"verdict":"stopped-mid-work"}. Final: {"verdict":"awaiting-user"}'),
    ).toBeNull()
  })

  it("accepts a repeated identical verdict", () => {
    expect(parsePauseVerdict('{"verdict":"awaiting-user"} — to repeat, {"verdict":"awaiting-user"}')).toBe(
      "awaiting-user",
    )
  })

  it.each([
    "",
    "   ",
    "awaiting-user",
    "The assistant is waiting for you.",
    '{"verdict":"maybe"}',
    '{"verdict":true}',
    '{"result":"awaiting-user"}',
    "{ broken json",
  ])("returns null for unreadable input %j", (input) => {
    expect(parsePauseVerdict(input)).toBeNull()
  })

  it("never throws on hostile input", () => {
    for (const s of [" ", "}".repeat(10_000), '{"verdict":', "\\", "```"]) {
      expect(() => parsePauseVerdict(s)).not.toThrow()
    }
  })
})
