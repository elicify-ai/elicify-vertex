/** FR-012, FR-023 through FR-026 — deterministic artifact capture from
 * completed assistant text, plus expectation/outcome comparison.
 *
 * Two single-purpose parsers over the assistant's text stream:
 *
 *  - `parseCriteriaBlock` — the `CRITERIA:` block (US-4, FR-012): a numbered
 *    list of acceptance criteria the model commits to at intake.
 *  - `parseExpectArtifact` — the `EXPECT [confidence]:` single line (US-6,
 *    FR-023): a falsifiable prediction the model states before running a
 *    verifier.
 *
 * Both share the same grammar rules (review-mandated, not incidental reuse):
 * fence-aware key detection (an occurrence inside a ``` fenced block is not a
 * real directive — it's the model quoting/explaining the grammar), a
 * case-insensitive line-start key, and last-occurrence-wins when the model
 * emits more than one in the same reply. Neither parser logs anything itself
 * — callers (pin.ts / wiring) own event emission; these functions only
 * report what they found so the caller can decide what to log (e.g.
 * `criteria:truncated`, `expect:absent`).
 *
 * A standalone `CONFIDENCE:` line is deliberately NOT a recognized artifact
 * (review F-09 — the retired two-line grammar). There is exactly one parser
 * for expectation capture; `parseExpectArtifact` only recognizes the
 * single-line `EXPECT [confidence]: <text>` form.
 *
 * Judgment call (documented per the module contract): FR-012's parenthetical
 * groups "fence-aware, case-insensitive keys, last-block-wins, cap 10,
 * **redacted**" as one requirement, and the parsed `Criterion.text` in
 * pin.ts is documented as "redacted before storage" — i.e. redaction is
 * expected to have already happened by the time text reaches pinning. Since
 * `parseCriteriaBlock` is the first point criteria text is extracted from
 * raw model output, this module applies `redactSecrets` here (both to
 * criteria items and to the EXPECT artifact's text, for the same
 * defense-in-depth reason — captured text is echoed back into ledger lines
 * and directive text later, which FR-007 requires be redacted anyway).
 * `redactSecrets` is idempotent on already-clean text, so this is safe even
 * if a caller redacts again downstream.
 */

import { redactSecrets } from "../redaction.js"

// ---------------------------------------------------------------------------
// Shared fence-aware line scanning
// ---------------------------------------------------------------------------

/** A fenced code block delimiter: a line whose trimmed start is 3+ backticks. */
const FENCE_DELIMITER_RE = /^\s*`{3,}/

interface ScannedLine {
  readonly line: string
  /** True for lines that are inside (or are themselves) a ``` fence — never
   * real directive content, excluded from key/grammar matching. */
  readonly fenced: boolean
}

/** Splits `text` into lines, tagging which are inside (or are) a fenced code
 * block so callers can skip them when scanning for directive keys. The fence
 * delimiter line itself is tagged `fenced: true` — it is punctuation, not
 * content, on either side of the toggle. */
function scanLines(text: string): ScannedLine[] {
  const rawLines = text.split(/\r\n|\r|\n/)
  const result: ScannedLine[] = []
  let inFence = false
  for (const line of rawLines) {
    if (FENCE_DELIMITER_RE.test(line)) {
      result.push({ line, fenced: true })
      inFence = !inFence
      continue
    }
    result.push({ line, fenced: inFence })
  }
  return result
}

// ---------------------------------------------------------------------------
// CRITERIA: block (FR-012)
// ---------------------------------------------------------------------------

export interface CriteriaBlock {
  criteria: string[]
  truncated: boolean
}

const CRITERIA_KEY_RE = /^\s*criteria\s*:\s*(.*)$/i
/** Numbered list item: "1. text" or "1) text". Bullets (-, *) are not
 * recognized — the spec's grammar (US-4 AS-1: "CRITERIA: (numbered)") is
 * numbered lists only. */
const CRITERIA_ITEM_RE = /^\s*(\d{1,3})[.)]\s+(.+?)\s*$/

const MAX_CRITERIA = 10

/**
 * Parse the last `CRITERIA:` block in `text` (fence-aware, case-insensitive
 * key, last-block-wins). Returns `null` when no block is found, or when the
 * winning block has zero parseable items (an empty/malformed block does not
 * fall back to an earlier one — "last wins" applies even when the last
 * occurrence is empty, mirroring `parseExpectArtifact`'s same-line
 * semantics).
 *
 * Caps at 10 items; `truncated: true` when more than 10 were present (the
 * first 10, in original order, are kept — the caller logs
 * `criteria:truncated`, this function only reports the flag).
 */
export function parseCriteriaBlock(text: string): CriteriaBlock | null {
  const lines = scanLines(text)

  let startIdx = -1
  let inlineRemainder = ""
  for (let i = 0; i < lines.length; i++) {
    const { line, fenced } = lines[i]
    if (fenced) continue
    const m = CRITERIA_KEY_RE.exec(line)
    if (m) {
      startIdx = i
      inlineRemainder = m[1].trim()
    }
  }
  if (startIdx === -1) return null

  const items: string[] = []
  const tryConsume = (raw: string): boolean => {
    const m = CRITERIA_ITEM_RE.exec(raw)
    if (!m) return false
    items.push(m[2].trim())
    return true
  }

  // Rare inline form: "CRITERIA: 1. foo" — the remainder after the colon on
  // the key line itself is a candidate first item.
  if (inlineRemainder) tryConsume(inlineRemainder)

  for (let i = startIdx + 1; i < lines.length; i++) {
    const { line, fenced } = lines[i]
    if (fenced) break // a code fence ends the list — don't reach past it
    if (line.trim() === "") continue // tolerate blank lines within/after the header
    if (!tryConsume(line)) break
  }

  if (items.length === 0) return null

  const truncated = items.length > MAX_CRITERIA
  const criteria = items.slice(0, MAX_CRITERIA).map((item) => redactSecrets(item))
  return { criteria, truncated }
}

// ---------------------------------------------------------------------------
// EXPECT [confidence]: <text> (FR-023)
// ---------------------------------------------------------------------------

export type DeclaredConfidence = "low" | "med" | "high"

export interface ExpectArtifact {
  text: string
  declared: DeclaredConfidence | null
}

const VALID_CONFIDENCE = new Set<DeclaredConfidence>(["low", "med", "high"])

/** `EXPECT [confidence]: text` — confidence bracket is optional; when
 * present but not one of low|med|high, `declared` is `null` and the text is
 * still captured (FR-023). A standalone `CONFIDENCE:` line never matches
 * this pattern (F-09) — it lacks the leading `expect` key entirely. */
const EXPECT_KEY_RE = /^\s*expect\s*(?:\[\s*([^\]]*?)\s*\])?\s*:\s*(.*)$/i

/**
 * Parse the last `EXPECT [confidence]: <text>` line in `text` (fence-aware,
 * case-insensitive key, last-line-wins). Returns `null` when no such line is
 * found, or when the winning line's text is empty (`EXPECT:` alone) — the
 * caller logs `expect:absent` for both cases, this function only reports
 * `null`.
 */
export function parseExpectArtifact(text: string): ExpectArtifact | null {
  const lines = scanLines(text)

  let winningConfidence: string | undefined
  let winningText: string | undefined
  for (const { line, fenced } of lines) {
    if (fenced) continue
    const m = EXPECT_KEY_RE.exec(line)
    if (m) {
      winningConfidence = m[1]
      winningText = m[2].trim()
    }
  }

  if (winningText === undefined || winningText === "") return null

  let declared: DeclaredConfidence | null = null
  if (winningConfidence !== undefined) {
    const normalized = winningConfidence.trim().toLowerCase()
    if (VALID_CONFIDENCE.has(normalized as DeclaredConfidence)) {
      declared = normalized as DeclaredConfidence
    }
  }

  return { text: redactSecrets(winningText), declared }
}

// ---------------------------------------------------------------------------
// compareExpectation (FR-024, FR-025, FR-026)
// ---------------------------------------------------------------------------

/**
 * A small, versioned taxonomy for `VerifierOutcomeSummary.failureClass`.
 * Not exhaustive and not enforced by this module (the field type stays a
 * plain `string | null` per the module contract) — this is documentation for
 * callers populating the field, e.g. resolve.ts/wiring classifying a
 * verifier's stderr/exit behavior.
 *
 * Example values: "assertion", "type-error", "timeout", "unknown".
 */
export interface VerifierOutcomeSummary {
  success: boolean
  failureClass: string | null
  summaryLine: string
}

export interface CalibrationEvent {
  declared: DeclaredConfidence | null
  observed: "pass" | "fail"
}

/**
 * Words/phrases whose presence flips an expectation's plain-text sense from
 * an implicit pass prediction to an explicit fail prediction (e.g. "this
 * will likely fail", "expect the build to break"). Absent any of these, an
 * EXPECT artifact is read as predicting pass — the overwhelmingly common
 * case in every spec example ("all 18 pass", "all tests pass"). This is a
 * deliberately simple, enumerated heuristic (same style as the spec's own
 * `TRIVIAL_ASK_RE`/`SEQUENCING_WORDS`) rather than deep sentiment analysis —
 * documented as a judgment call, the spec gives worked examples only for the
 * pass-predicting case.
 *
 * Split into two categories (review MAJ finding — negation-blindness):
 *
 *  - `FAIL_KEYWORD_RE` (category A): bare fail-predicting root words
 *    ("fail", "break"/"broken", "crash", "error"). These are negation-
 *    sensitive — "no errors" negates the keyword itself and must NOT read as
 *    a fail prediction, so every match is checked against
 *    `NEGATION_LOOKBEHIND_RE` before counting.
 *  - `NEGATED_PASS_RE` (category B): phrases that already express "will NOT
 *    pass/work" as a single unit ("won't pass", "doesn't pass", ...). These
 *    are fail predictions BY CONSTRUCTION — the negation is part of what
 *    makes them fail-predicting, so they are intentionally NOT run through
 *    the negation-flip logic (that would double-negate them back to "pass").
 */
const FAIL_KEYWORD_RE = /\b(fail(?:s|ing|ed)?|break(?:s|ing)?|broken?|crash(?:es|ing|ed)?|error(?:s|ing|ed)?)\b/gi

const NEGATED_PASS_RE =
  /\b(won'?t\s+(work|pass)|will\s+not\s+(work|pass)|not\s+(going\s+to\s+)?pass|doesn'?t\s+pass|does\s+not\s+pass|shouldn'?t\s+pass)\b/i

/**
 * Matches when the text immediately (within 0-2 intervening words) before a
 * `FAIL_KEYWORD_RE` match is a negation word — "no errors", "won't crash",
 * "shouldn't error", "isn't broken", "doesn't break", "never fails". A
 * category-A keyword preceded by one of these reads as a PASS prediction,
 * not a fail prediction.
 *
 * Deliberately narrow (immediate-preceding-tokens only, not full-sentence
 * negation scope) — matches the dataset's spirit without attempting general
 * sentiment analysis. Left unhandled, as a documented judgment call:
 *   - Double negation ("not unlikely to fail") is not un-flipped back to fail.
 *   - A negation word separated from its keyword by more than ~2 words
 *     ("no, and I really mean it, errors here") is not linked to it.
 * Both are rare/adversarial phrasings absent from the spec's worked examples.
 */
const NEGATION_LOOKBEHIND_RE = /\b(no|not|won'?t|shouldn'?t|isn'?t|doesn'?t|never)\s+(?:\w+\s+){0,2}$/i

function predictedOutcome(expectText: string): "pass" | "fail" {
  // Category B: already-negated-pass phrases are fail predictions by
  // construction — never subject to the negation-flip loop below.
  if (NEGATED_PASS_RE.test(expectText)) return "fail"

  // Category A: bare fail keywords, individually checked for an immediately
  // preceding negation word that flips this specific occurrence back to pass.
  FAIL_KEYWORD_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = FAIL_KEYWORD_RE.exec(expectText)) !== null) {
    const preceding = expectText.slice(0, match.index)
    if (!NEGATION_LOOKBEHIND_RE.test(preceding)) {
      return "fail" // an un-negated fail keyword -> genuine fail prediction
    }
  }
  return "pass"
}

/**
 * FR-024/025/026: compare a captured expectation against an observed
 * verifier outcome.
 *
 * `expect === null` fails open — no comparison is attempted, `calibration`
 * is `null` (the caller logs `expect:absent`). Otherwise a `calibration`
 * event is always returned (`declared` passed through, `observed` derived
 * from `outcome.success`); `mismatch` is `true` only when the expectation's
 * plain-text sense disagrees with the observed outcome — it predicted pass
 * and the verifier failed, or (symmetrically) it predicted fail and the
 * verifier unexpectedly passed.
 */
export function compareExpectation(
  expect: ExpectArtifact | null,
  outcome: VerifierOutcomeSummary,
): { mismatch: boolean; calibration: CalibrationEvent | null } {
  if (expect === null) {
    return { mismatch: false, calibration: null }
  }

  const observed: "pass" | "fail" = outcome.success ? "pass" : "fail"
  const predicted = predictedOutcome(expect.text)
  const mismatch = predicted !== observed

  return {
    mismatch,
    calibration: { declared: expect.declared, observed },
  }
}
