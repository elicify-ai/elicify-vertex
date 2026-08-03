/**
 * FR-001 — the path-existence claim discriminator.
 *
 * WHY THIS EXISTS. In the audited session (`ses_04dc77bdaffej8SFJvYm5yO0CW`)
 * the completion judge reverted genuinely-delivered stories on claims that a
 * file or directory did not exist when it demonstrably did — e.g.
 * `"renewable-energy.md and space-exploration.md are MISSING on disk"` against
 * files that were 4262 B and 3138 B at that moment, and
 * `"the research/ directory does not exist"` against a directory holding 12
 * files. This module decides, for one judge item note, whether the harness may
 * overrule that specific claim by observing the filesystem itself.
 *
 * WHY IT IS DELIBERATELY NARROW (grill round 2, C-3). A naive "does the note
 * contain a path token and a negation" matcher is provably unsafe against the
 * real corpus. The first notes in
 * `tests/fixtures/judge-replay/item-notes.json` are:
 *
 *     research/renewable-energy.md exists (1046 bytes) but contains no URLs
 *     or Sources section
 *
 * — a path token adjacent to a negation, on one of the CORRECT failures. Any
 * matcher loose enough to catch "…md does not exist" also catches that and
 * would re-derive a pass on a real defect, destroying the whole reason the
 * story-level veto was withdrawn. So the rules below are clause-anchored and
 * closed-set, and are validated against all 49 recovered real notes (42 keep /
 * 7 drop) — a matcher that drops a correct-FAIL note fails the suite.
 *
 * WHAT THIS MODULE MUST NEVER DO:
 *  - Execute anything. `verifiers` and every other string in `plan.json` are
 *    LLM-authored and unvalidated (`wiring/tools.ts`'s `tool.schema.string()`,
 *    `story.ts`'s `isStringArray`); running them unattended would hand code
 *    execution to anyone who can write that file (FR-001a).
 *  - Speak to CONTENT. A path check can only ever contradict a path claim;
 *    "no sources cited" / "data is hardcoded" are out of scope by construction
 *    (29 of the 49 real notes are content-only — that class is FR-014's job).
 */

/**
 * Verbs asserting absence, as the predicate of the path itself. Includes the
 * bare trailing form `"research/x.md missing."` — 5 of the 49 real notes use
 * it, and an earlier version that required a copula ("is missing") silently
 * kept all five (caught by the corpus test, not by review).
 */
const ABSENCE_PREDICATE =
  /\b(?:does\s+not\s+exist|doesn't\s+exist|(?:is|are|was|were)\s+missing|missing\b|was\s+not\s+found|were\s+not\s+found|(?:is|are)\s+not\s+present|not\s+present|not\s+found|no\s+such\s+file|absent)\b/i

/** Leading-negation form: "No src/App.tsx", "missing research/x.md". */
const LEADING_ABSENCE = /\b(?:no|missing)\s+(?=[\w./-]*[./][\w./-]*)/i

/**
 * A path-shaped token: contains a `/` or a known file extension, and no shell
 * metacharacters (a token inside a command is naming a command, not a claim).
 */
const PATH_TOKEN = /\b[\w.-]*(?:\/[\w.-]+)+\/?|\b[\w-]+\.(?:md|json|jsx|tsx|ts|js|css|html|ya?ml|toml|txt)\b/g

/**
 * An explicit POSITIVE existence assertion disqualifies the note. The negative
 * lookbehind is load-bearing: "does not exist" / "is not present" contain the
 * same words, and matching them here would make every genuine absence claim
 * unrecognisable (caught by the corpus test on first run).
 */
const EXISTENCE_ASSERTION =
  /(?<!\bnot\s)(?<!\bno\s)\b(?:exists|exist\s+(?:at|in|on)|is\s+present|was\s+found|found\s+at|present\s+on\s+disk)\b/i

/**
 * A second negation NOT attached to the path — the "…exists but contains no
 * URLs…" shape. Any of these means the note is making a content claim in
 * addition to (or instead of) a path claim, so it must not be dropped.
 */
const SECOND_NEGATION = /\b(?:but|however|although|though|yet)\b|\bcontains?\s+no\b|\bhas\s+no\b|\bwithout\b|\bempty\b|\bstub\b|\bhardcoded\b|\bno\s+(?:urls?|sources?|citations?|imports?|charts?|kpis?|tests?|content)\b/i

export interface PathClaim {
  /** Every path the note asserts to be absent. Empty when this is not a path claim. */
  paths: string[]
  /** Why the note was not treated as a pure path-absence claim (for logging). */
  reason?: "no-absence-predicate" | "no-path-token" | "asserts-existence" | "second-negation" | "quoted-command"
}

/** Strip backtick/quote-wrapped spans: a path inside them names a command. */
function stripQuoted(note: string): string {
  return note.replace(/`[^`]*`/g, " ").replace(/"[^"]*"/g, " ").replace(/'[^']*'/g, " ")
}

/**
 * Extract the paths a note asserts to be ABSENT, or explain why it is not a
 * pure path-absence claim. Pure string work: never throws, no fs, no exec.
 */
export function parsePathAbsenceClaim(note: string): PathClaim {
  if (typeof note !== "string" || note.trim() === "") return { paths: [], reason: "no-path-token" }

  // Rule 3: a note that says the path EXISTS is never an absence claim, no
  // matter what else it alleges. This is the correct-FAIL guard.
  if (EXISTENCE_ASSERTION.test(note)) return { paths: [], reason: "asserts-existence" }

  // Rule 2: a second negation means there is a content claim riding along.
  if (SECOND_NEGATION.test(note)) return { paths: [], reason: "second-negation" }

  const bare = stripQuoted(note)
  if (bare.trim() !== note.trim() && !/[\w.-]*\//.test(bare)) {
    // Every path lived inside a quoted command.
    return { paths: [], reason: "quoted-command" }
  }

  // Rule 1: the note must actually predicate absence.
  if (!ABSENCE_PREDICATE.test(bare) && !LEADING_ABSENCE.test(bare)) {
    return { paths: [], reason: "no-absence-predicate" }
  }

  const paths = [...new Set((bare.match(PATH_TOKEN) ?? []).map((p) => p.replace(/[.,;:]+$/, "")))]
  if (paths.length === 0) return { paths: [], reason: "no-path-token" }
  return { paths }
}
