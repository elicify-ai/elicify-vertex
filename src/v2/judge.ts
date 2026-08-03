/**
 * Vertex 2 — Tier-3 judge as an in-loop subturn (US-9, FR-030/FR-030a/FR-031/FR-032;
 * redesigned per HANDOVER.md points 2-4, user decision 2026-07-29).
 *
 * The judge is now the SOLE ARBITER of story/plan completion (point 2), run
 * at session.idle over stories that CLAIMED complete. It is no longer a
 * zero-tool evidence-summarizer: it gets read-only tools (read/grep/glob/
 * list/bash, point 3 — `subturn.ts`'s `JUDGE_PROBE_POLICY`) so it can
 * independently re-run a story's declared verifiers rather than trusting
 * the transcript, and it answers with STRUCTURED per-acceptance-item
 * verdicts (point 4 — `{stories: [{storyId, pass, summary, items:
 * [{itemId, met, note}]}]}`) instead of the old prose `{fit, summary,
 * gaps}`. The motivating evidence: a real 894-message field session ended
 * 5/5 stories blocked with genuinely-completed work the harness could not
 * credit, and the zero-tool judge never fired to rescue it.
 *
 * Two responsibilities, kept in one module because they share the same
 * "evidence only, fail open" posture:
 *
 *  - `buildJudgePayload` (FR-031, review MAJ-009; extended by
 *    `docs/JUDGE-PROMPT.md` §5): turns raw criteria/diff/verifier/
 *    lastResponse/recentTranscript text into the five-field payload sent to
 *    the judge subturn, after a strict scan (secret patterns + a
 *    Shannon-entropy rule, via `redactSecrets`) applied to the *reassembled,
 *    untruncated* field so a secret split across a chunk/line boundary — OR
 *    sitting past where a length cap would otherwise cut — is still caught.
 *    A field emptied by the scan is omitted from the payload entirely. ONLY
 *    AFTER scanning, the surviving (already-scanned) text is truncated to its
 *    cap (`JUDGE_PAYLOAD_FIELD_CHAR_CAP` for four of the five fields;
 *    `JUDGE_TRANSCRIPT_FIELD_CHAR_CAP` for `recentTranscript`) and logs
 *    `judge:field-truncated` (MINOR fix, post-review: this used to be
 *    silent, so a verdict built from truncated evidence was
 *    indistinguishable after the fact from one built from the complete
 *    field). C-9 fix (docs/CODE-ISSUES-FROM-PROMPT-AUDIT.md): this
 *    scan-then-truncate order is deliberately the reverse of the pipeline's
 *    original truncate-then-scan order — see `truncateField`'s doc comment
 *    for why the old order let a secret straddling the cap boundary leak
 *    almost whole. One consequence: `judge:field-dropped` (the field's scan
 *    removed everything) and `judge:field-truncated` (the surviving text was
 *    still too long) are now mutually exclusive for a given field within one
 *    call — a fully-dropped field has nothing left to truncate.
 *  - `runJudge` (FR-030/FR-030a/FR-030b/FR-032): gates on `subturn.ts`'s
 *    `probeCapabilityBounded` (the probe + deny-map build, bounded by the
 *    SAME 5s budget as everything that follows — CRITICAL fix, see that
 *    function's doc comment: the budget clock now starts before the probe,
 *    not after it), then issues at most two `runSubturn` attempts (override
 *    model, then session model on failure) sharing the remainder of that
 *    budget, and classifies the outcome so a caller can fail open without
 *    ever throwing.
 *
 * Both are fail-open by construction: nothing in this file throws out to a
 * caller on a judge-side problem — every failure mode resolves to a typed
 * "no verdict" result (see the `JudgeRunResult` deviation note below).
 */

import { redactSecrets } from "../redaction.js"
import { JUDGE_PROBE_POLICY, probeCapabilityBounded, runSubturn, type SelfCreatedSessions } from "./subturn.js"
import type { EventLogger, OpencodeClient } from "./types.js"

// ---------------------------------------------------------------------------
// buildJudgePayload — FR-031
// ---------------------------------------------------------------------------

/**
 * Deviation from `docs/vertex2-module-contracts.md` section 8: the contract
 * declares `interface JudgePayload { criteria: string[]; diffSummary: string;
 * verifierSummaries: string[] }` with all three fields required. FR-031 and
 * Dataset: Judge payload hygiene row 7 both require that a field emptied by
 * the strict scan be *omitted* (the key absent, not an empty string/array),
 * which the contract's own required-fields shape cannot express. `JudgePayload`
 * is therefore `Partial` here — every field is optional, present only when
 * it survived scanning with content. Document this prominently: wave-3 wiring
 * must treat all three keys as possibly-absent when rendering the close-out
 * report / subturn prompt.
 *
 * `docs/JUDGE-PROMPT.md` §5 adds two more fields on the same terms —
 * `lastResponse` (the parent's last assistant message, verbatim) and
 * `recentTranscript` (a bounded recent window, both roles) — sourced,
 * redacted and capped exactly like the original three (see `gate.ts`'s
 * `appendJudgeCloseOut`, which fetches them via `client.session.messages`
 * and passes them into `buildJudgePayload` alongside the existing three raw
 * fields). Same absent-when-emptied rule applies.
 *
 * HANDOVER.md point 4 adds a sixth field, `plan`: a rendered plan digest
 * (stories, statuses, acceptance items, declared verifiers) supplied by the
 * caller, so the judge audits against the plan's own claims rather than a
 * flattened criteria list. Same pipeline as `recentTranscript`
 * (scan-then-truncate via `scanProseField`), with its own 4000-char cap
 * (`JUDGE_PLAN_FIELD_CHAR_CAP`).
 */
export interface JudgePayload {
  criteria?: string[]
  diffSummary?: string
  verifierSummaries?: string[]
  lastResponse?: string
  recentTranscript?: string
  plan?: string
}

interface RawJudgePayload {
  criteria: string[]
  diffSummary: string
  verifierSummaries: string[]
  /** Parent's final assistant message, verbatim, before this session went
   * idle. Empty string when unavailable (no messages, fetch failure, or no
   * assistant message yet) — flows through the same "empty in, omitted out"
   * path every other field already uses (see `scanProseField`). */
  lastResponse: string
  /** Bounded recent-turn window (both roles), compact `role: text` per line,
   * already formatted by the caller. Empty string when unavailable. */
  recentTranscript: string
  /** Rendered plan digest (HANDOVER.md point 4): stories, statuses,
   * acceptance items and declared verifiers, formatted by the caller.
   * Empty string when no plan is available. */
  plan: string
}

/**
 * Per-field character cap applied to the *reassembled* field text.
 * Dataset row 8 describes it as "field truncated to the summary cap before
 * scanning; scan runs on the truncated text actually sent" — that was the
 * pipeline's ORIGINAL order, and C-9 (docs/CODE-ISSUES-FROM-PROMPT-AUDIT.md)
 * found it let a secret straddling the cap boundary survive almost whole (the
 * tail that made it match a SECRET_PATTERNS entry, or clear the entropy
 * threshold, got sliced off first). The cap itself is unchanged; only WHEN
 * it's applied moved — see `truncateField`'s doc comment for the corrected
 * scan-then-truncate order. No numeric cap is specified anywhere else in the
 * spec for this payload — FR-031's own text only says the scan "runs on the
 * transmitted bytes, i.e. after any summary truncation" without naming the
 * pipeline stage or the number. Judgment call: 2000 chars/field is a generous
 * bound for evidence text (a judge subturn needs a *summary*, not a full
 * transcript) while comfortably exercising the boundary dataset row's
 * 4,000-char oversized input. Applied uniformly to `criteria`,
 * `verifierSummaries`, `diffSummary` and `lastResponse` (`docs/JUDGE-PROMPT.md`
 * §5: "the existing JUDGE_PAYLOAD_FIELD_CHAR_CAP ... same cap as every other
 * field"), even though only the verifier-summary row is tested.
 */
const JUDGE_PAYLOAD_FIELD_CHAR_CAP = 2000

/**
 * `docs/JUDGE-PROMPT.md` §5's proposed cap for `recentTranscript`: "roughly
 * double [the per-field cap], since it carries multiple turns of nuance
 * rather than one fact. Not measured against anything; a real number to
 * argue with, not a claim." Kept as its own named constant (not derived from
 * `JUDGE_PAYLOAD_FIELD_CHAR_CAP * 2`) so it can be tuned independently
 * without touching the other four fields' cap.
 */
const JUDGE_TRANSCRIPT_FIELD_CHAR_CAP = 4000

/**
 * HANDOVER.md point 4: the `plan` field's cap. Originally 4000 chars, copied
 * from `recentTranscript` on a "several turns of nuance" sizing argument —
 * i.e. a guess, never measured against a real digest.
 *
 * FR-006 (docs/JUDGE-RELIABILITY-FIXES-SPEC.md, User Story 6) raises it to
 * 16000 from a MEASUREMENT, not taste. In the audited live session
 * (`ses_04dc77bdaffej8SFJvYm5yO0CW`) `judge:field-truncated {plan,
 * originalLength: 6411-6425, cap: 4000}` fired on all 9 audit runs, and the
 * judge then FAILed stories citing exactly the content the cap had removed
 * ("the verifier command is incomplete in the digest", "S5 has no
 * independent verifier set in the digest") — a self-inflicted false FAIL.
 * The `originalLength` in those events is the POST-scan length; the RAW
 * digest for that 6-story plan measures **7518 chars** (spec round-2 finding
 * m-19). 16000 is ~2.1x the measured raw digest: headroom for a plan roughly
 * twice as large before truncation re-engages, rather than a bound that
 * already binds on the very plan that motivated it.
 *
 * Raising the cap does NOT unbound cost or weaken redaction:
 *  - `JUDGE_PAYLOAD_RAW_FIELD_SAFETY_CAP` (100_000) still drops a
 *    pathological raw field WHOLE before scanning, so scan cost stays
 *    bounded (US6 AS2's "the bound is raised, not removed").
 *  - the scan still runs on the full reassembled field BEFORE truncation
 *    (C-9 order), so a secret anywhere in the digest is still dropped
 *    (US6 AS3) — a bigger cap only means less scanned-clean text is thrown
 *    away afterward.
 *  - truncation above 16000 still happens and still logs
 *    `judge:field-truncated`.
 */
const JUDGE_PLAN_FIELD_CHAR_CAP = 16000

/**
 * C-9 follow-up, cost regression (docs/CODE-ISSUES-FROM-PROMPT-AUDIT.md):
 * scanning the FULL untruncated field — required for C-9's "nothing
 * unscanned reaches the output" guarantee — means scan cost now scales with
 * the RAW field size, not the post-truncation cap. `criteria`/
 * `verifierSummaries`/`diffSummary` are already bounded upstream
 * (`plugin.ts`'s `.slice(-2000)`, `computeBoundedDiffStat`'s 4000-char cap)
 * before they ever reach here, but `lastResponse`/`recentTranscript` are
 * not — `wiring/gate.ts`'s own comment on `JUDGE_RECENT_TRANSCRIPT_TURN_WINDOW`
 * says outright the turn count is "a soft pre-filter, not the real bound."
 * Measured: a 2MB single-line field takes ~45ms to scan; a
 * 1.37MB/20,000-line field ~270ms.
 *
 * This bounds worst-case cost WITHOUT reintroducing C-9's bug: unlike
 * truncating a field's CONTENT down toward its transmission cap (which risks
 * bisecting a secret sitting near that boundary), a raw field over this cap
 * is dropped WHOLE, before scanning — there is no partial/fragmentary text
 * produced for a bisected secret to hide in either way (a field either gets
 * a full scan and, if it survives, a cap-respecting truncation of the
 * scanned result; or it is entirely omitted). Sized far larger than the real
 * transmission caps (2000/4000 chars) and than any realistic secret token,
 * so it never engages for genuine evidence text — only for a pathological or
 * DoS-shaped input.
 */
const JUDGE_PAYLOAD_RAW_FIELD_SAFETY_CAP = 100_000

/**
 * Standard Shannon entropy, bits per character, over the token's own
 * observed character frequency (order-0, no positional/contextual model).
 */
function shannonEntropyBitsPerChar(token: string): number {
  const freq = new Map<string, number>()
  for (const ch of token) {
    freq.set(ch, (freq.get(ch) ?? 0) + 1)
  }
  const len = token.length
  let bits = 0
  for (const count of freq.values()) {
    const p = count / len
    bits -= p * Math.log2(p)
  }
  return bits
}

const ENTROPY_MIN_TOKEN_LENGTH = 32
const ENTROPY_THRESHOLD_BITS = 4.0

/**
 * A string's maximum possible Shannon entropy is `log2(alphabet size)`. A
 * canonical lowercase-hex alphabet (0-9a-f, 16 symbols) caps at exactly
 * `log2(16) = 4.0` bits/char, reachable *only* with a perfectly uniform
 * digit distribution — which requires the token length to be a multiple of
 * 16. Dataset row 5's 40-character token (40 / 16 = 2.5) cannot be evenly
 * distributed, so even the best-arranged 40-char hex string tops out at
 * ~3.971 bits/char (verified: 8 digits x3 + 8 digits x2 occurrences gives
 * 3.9709505944546684), strictly below a literal `>= 4.0`. A literal
 * comparison would make FR-031's own worked example mathematically
 * unsatisfiable for any hex-alphabet secret of that length. A small
 * tolerance is applied so a near-theoretical-max token (as genuine random
 * hex/base32 secrets are) still trips the rule, while ordinary prose stays
 * safely excluded (row 9's 40-char English word-run measures ~2.99-3.29
 * bits/char in practice — see tests/v2/judge.test.ts — nowhere near this
 * threshold even with the tolerance applied).
 */
const ENTROPY_TOLERANCE_BITS = 0.05
const ENTROPY_EFFECTIVE_THRESHOLD_BITS = ENTROPY_THRESHOLD_BITS - ENTROPY_TOLERANCE_BITS

/**
 * Strip newlines (only) before matching, so a secret/token wrapped across a
 * hard line break — with nothing else separating the two halves — is seen
 * as one continuous run by both the pattern and entropy checks. This is the
 * "reassembled field, not per-chunk" mechanism FR-031 requires. Ordinary
 * intra-line whitespace (spaces/tabs) is left intact so token boundaries
 * elsewhere in the text are unaffected.
 */
function dewrap(text: string): string {
  return text.replace(/\n/g, "")
}

/**
 * Reuses `redactSecrets`'s own `SECRET_PATTERNS` *indirectly*: that array is
 * a private module-level const in `src/redaction.ts` (only `redactSecrets`
 * and `redactForDisk` are exported), and this module must not edit
 * `redaction.ts`. Comparing `redactSecrets(text)` against `text` is an exact
 * (not approximate) proxy for "did any SECRET_PATTERNS entry match" — by
 * construction, `redactSecrets` changes its input if and only if some
 * pattern in that array matched — so this reuses the real pattern list
 * faithfully without duplicating or re-guessing its regexes (which would
 * risk drifting from `redaction.ts` as it evolves).
 */
function tripsPatternScan(text: string): boolean {
  const d = dewrap(text)
  return redactSecrets(d) !== d
}

function tripsEntropyScan(text: string): boolean {
  const tokens = dewrap(text)
    .split(/\s+/)
    .filter((t) => t.length > 0)
  for (const token of tokens) {
    if (token.length < ENTROPY_MIN_TOKEN_LENGTH) continue
    if (shannonEntropyBitsPerChar(token) >= ENTROPY_EFFECTIVE_THRESHOLD_BITS) return true
  }
  return false
}

/**
 * C-15 fix (docs/CODE-ISSUES-FROM-PROMPT-AUDIT.md): `tripsEntropyScan`'s
 * effective threshold (3.95 bits/char, just under hex's theoretical max of
 * exactly 4.0) is reachable only by a near-perfectly-uniform 16-symbol digit
 * distribution. Real random hex strings at the lengths this scans
 * essentially never land that close to uniform (a 20,000-sample Monte Carlo
 * of random 32-char hex found 0/20000 clearing it; 40-char hex cleared only
 * 4/20000) — a concrete previously-leaking example, "our client secret ends
 * up being 8f3ac9d2e1b74c0aa9f2d8e7c1b3a4f6", measures 3.83 bits/char: it
 * reads as obviously random to a human, comfortably below the entropy rule's
 * razor-thin margin. Rather than lower that threshold — which risks new
 * false positives on ordinary long identifiers/camelCase tokens without a
 * large empirical dataset to calibrate a safe cutoff — this adds a direct,
 * unambiguous character-class backstop: a standalone run of 32+ pure-hex
 * characters (the length ENTROPY_MIN_TOKEN_LENGTH already uses) trips
 * regardless of entropy. Natural-language prose does not produce 32+
 * consecutive hex-alphabet characters as one token; the realistic
 * false-positive cost is git full-SHA/hash-shaped IDs (also hex, also long)
 * being dropped when they appear in evidence text — accepted, since a judge
 * subturn losing one line of context is far cheaper than a leaked secret.
 *
 * Deliberately kept LOCAL to the judge payload pipeline, not added to
 * `redaction.ts`'s shared `SECRET_PATTERNS` (which also backs
 * `redactForDisk`, used to persist `VerificationReceipt`s — whose `signature`
 * field is itself a bare 64-char hex HMAC digest, and `scope.worktreeDigest`
 * a bare hex hash). Adding this rule there was tried and reverted: it
 * corrupted receipt signatures on every disk write (`atomicWriteJson` in
 * `goals.ts` calls `redactForDisk` on the whole receipts file), breaking
 * `verifyReceiptSignature` for every receipt persisted afterward — 13 tests
 * across `forgery.test.ts`/`receipts.test.ts`/`tools.test.ts`/
 * `plugin.integration.test.ts` failed with "genuine receipt must survive:
 * expected null not to be null" once reproduced. The five judge-payload
 * fields are all free-form prose/line arrays, never signed/structured data,
 * so the same rule is safe here but not safe as a blanket disk-redaction
 * rule without a schema-aware (key-based) exclusion this fix does not
 * attempt. The equivalent gap in `redactForDisk`-covered disk persistence
 * (measurement.jsonl etc.) is therefore an accepted residual risk, not fixed
 * here — see docs/CODE-ISSUES-FROM-PROMPT-AUDIT.md's C-15 entry.
 */
const HEX_RUN_MIN_LENGTH = 32
const HEX_RUN_RE = new RegExp(`\\b[0-9a-fA-F]{${HEX_RUN_MIN_LENGTH},}\\b`)

function tripsHexRunScan(text: string): boolean {
  return HEX_RUN_RE.test(dewrap(text))
}

function unitTrips(text: string): boolean {
  return tripsPatternScan(text) || tripsEntropyScan(text) || tripsHexRunScan(text)
}

// ---------------------------------------------------------------------------
// FR-006a — the adjacent-pair check must find the offending match ON the join
// ---------------------------------------------------------------------------

/**
 * FR-006a (docs/JUDGE-RELIABILITY-FIXES-SPEC.md, round-2 finding M-10 —
 * ROOT CAUSE REPRODUCED). `scanUnits`' second pass concatenates adjacent
 * units with NO separator and drops BOTH when the concatenation trips. That
 * is correct for a secret hard-wrapped across a line break (C-9, dataset
 * rows 4/6) and catastrophic for everything else, because Shannon entropy is
 * not compositional: gluing two ordinary tokens can manufacture a token that
 * clears the entropy rule when neither side comes close.
 *
 * Reproduced exactly against the audited session's real plan digest — these
 * two adjacent digest lines
 *
 *   "  verifiers: ... jq -e '.kpis | length >= 3' research/space-exploration.json"
 *   "S2 (active): \"Research Wave B — ...\""
 *
 * fuse into the 33-char token `research/space-exploration.jsonS2`. Measured:
 * the path token alone is 31 chars (under `ENTROPY_MIN_TOKEN_LENGTH`, never
 * even scanned) at 3.889 bits/char; appending `S2` adds two symbols the left
 * side does not contain, lifting the fused token to **4.044 bits/char** —
 * over the 3.95 effective threshold. Neither line trips alone. In the audited
 * session this fired 11x on the `plan` field (`judge:field-partial-drop
 * {plan, kept:51, dropped:4}`), deleting S1/S2/S3's `verifiers:` lines, after
 * which the judge FAILed those stories for having no verifiers in the digest.
 *
 * The fix is to require the offending match to actually live ON the join.
 * Two things had to be established to make that a real constraint rather
 * than a no-op:
 *
 *  1. A straddle test alone is VACUOUS for all three scans. The pair check
 *     only runs when neither unit trips alone, and under that precondition
 *     every possible match necessarily crosses the boundary: the entropy
 *     scan's token set changes by exactly one token (the fused one, since
 *     `/\s+/` splitting is local); a `SECRET_PATTERNS` match or a hex run
 *     lying wholly inside one unit would have matched that unit alone (none
 *     of the patterns use lookaround, and a leading/trailing `\b` is
 *     satisfied at a string end, so concatenation can only DESTROY such a
 *     match, never create one). Measured on the real digest: the offending
 *     token `research/space-exploration.jsonS2` does straddle the join, so a
 *     literal "does it straddle?" check leaves the production bug in place.
 *     It is still implemented below — exactly, per match kind — because it
 *     is the correct invariant and it stops being vacuous the moment
 *     `redaction.ts` grows a pattern with lookaround.
 *  2. What actually separates the two classes is WHICH scan trips and HOW
 *     MUCH of the match each side contributes:
 *      - pattern / hex-run matches are shape-specific. Two ordinary prose or
 *        path tokens cannot glue into `postgres://user:pass@host` or a
 *        32-char pure-hex run. A straddling match of either kind is
 *        therefore sufficient to drop the pair (this is what keeps C-9's
 *        dataset rows 4/6 caught).
 *      - an entropy match is a heuristic over a token that, on a join, the
 *        source text never actually contained. It is admitted only when the
 *        split is a plausible mid-token WRAP: each side must contribute at
 *        least `ENTROPY_PAIR_MIN_FRAGMENT_CHARS`. `S2` contributes 2 of 33
 *        characters (6%) and flips the verdict; a wrapped secret contributes
 *        a substantial run of the same random material to both sides.
 *
 * Why a fragment-LENGTH bar and not a fragment-ENTROPY bar: measured, an
 * entropy bar cannot separate the classes at all. 20,000-sample Monte Carlo
 * of random fragments gives mean 3.36 bits/char for 20-char hex and 4.04 for
 * 20-char base64, while the ordinary path token `research/space-exploration.json`
 * measures 3.889 — i.e. real secret fragments routinely score LOWER than the
 * innocent path token this fix exists to protect, so any bar that keeps the
 * production false positive also throws away genuine wrapped hex. Length is
 * the discriminator that survives measurement.
 *
 * Residual risk, accepted and stated: two adjacent lines where the first ends
 * with and the second begins with a >=16-char high-entropy-ish token (e.g.
 * `...space-exploration.json` + `data/renewable-energy.json`, fusing to 57
 * chars at 4.09 bits/char) still drop as a pair. That is far narrower than
 * the reproduced class (which needs only a short next word) and errs toward
 * redaction, which is the correct direction for a payload leaving the
 * process. Exempting the `plan` field instead is explicitly forbidden by
 * FR-006a (it would contradict US6 AS3, "a secret in the plan digest is
 * still redacted").
 */
const ENTROPY_PAIR_MIN_FRAGMENT_CHARS = ENTROPY_MIN_TOKEN_LENGTH / 2

/**
 * Does a `SECRET_PATTERNS` match cross `joinIdx`?
 *
 * `SECRET_PATTERNS` is private to `redaction.ts` (see `tripsPatternScan`),
 * so match offsets are recovered by diffing the redacted string against the
 * original: the common prefix and common suffix bound every changed region.
 * That window is a superset of the individual matches — with matches on both
 * sides of the join but none crossing it, the window would straddle and this
 * returns true. Deliberately left as-is: that configuration is unreachable
 * from `scanUnits` (a match wholly inside one unit means that unit trips
 * alone and the pair is never considered), and erring toward redaction is
 * the safe direction if it ever becomes reachable.
 */
function patternMatchStraddles(joined: string, joinIdx: number): boolean {
  const redacted = redactSecrets(joined)
  if (redacted === joined) return false
  let prefix = 0
  while (prefix < joined.length && prefix < redacted.length && joined[prefix] === redacted[prefix]) prefix++
  let suffix = 0
  while (
    suffix < joined.length - prefix &&
    suffix < redacted.length - prefix &&
    joined[joined.length - 1 - suffix] === redacted[redacted.length - 1 - suffix]
  ) {
    suffix++
  }
  return prefix < joinIdx && joined.length - suffix > joinIdx
}

/** Does a 32+ character hex run (the C-15 backstop) cross `joinIdx`? */
function hexRunStraddles(joined: string, joinIdx: number): boolean {
  const re = new RegExp(HEX_RUN_RE.source, "g")
  let match: RegExpExecArray | null
  while ((match = re.exec(joined)) !== null) {
    if (match.index < joinIdx && match.index + match[0].length > joinIdx) return true
  }
  return false
}

/**
 * Does a high-entropy token cross `joinIdx` with a substantial contribution
 * from BOTH sides — i.e. does the join look like a hard-wrapped token rather
 * than two complete tokens glued together? See
 * `ENTROPY_PAIR_MIN_FRAGMENT_CHARS`' comment for the measurements behind the
 * fragment bar.
 */
function entropyTokenStraddles(joined: string, joinIdx: number): boolean {
  const re = /\S+/g
  let match: RegExpExecArray | null
  while ((match = re.exec(joined)) !== null) {
    const token = match[0]
    const start = match.index
    const end = start + token.length
    if (token.length < ENTROPY_MIN_TOKEN_LENGTH) continue
    if (!(start < joinIdx && end > joinIdx)) continue
    if (joinIdx - start < ENTROPY_PAIR_MIN_FRAGMENT_CHARS) continue
    if (end - joinIdx < ENTROPY_PAIR_MIN_FRAGMENT_CHARS) continue
    if (shannonEntropyBitsPerChar(token) >= ENTROPY_EFFECTIVE_THRESHOLD_BITS) return true
  }
  return false
}

/**
 * FR-006a gate for the adjacent-pair pass: the concatenation tripped, but may
 * the pair be dropped for it? Only when the offending match is genuinely a
 * boundary phenomenon (see `ENTROPY_PAIR_MIN_FRAGMENT_CHARS`).
 *
 * Offsets are computed in DEWRAPPED space because that is the space every
 * scan matches in (`dewrap` strips `\n` only, so
 * `dewrap(a + b) === dewrap(a) + dewrap(b)` and the join index is exactly
 * `dewrap(a).length`).
 */
function pairTripsOnJoin(a: string, b: string): boolean {
  const left = dewrap(a)
  const joined = left + dewrap(b)
  const joinIdx = left.length
  if (joinIdx === 0 || joinIdx === joined.length) return false
  return patternMatchStraddles(joined, joinIdx) || hexRunStraddles(joined, joinIdx) || entropyTokenStraddles(joined, joinIdx)
}

/**
 * Given the ordered removal units of a field (hunks for diffSummary, lines
 * for criteria/verifierSummaries), determine which units to drop.
 *
 * Two passes:
 *  1. Each unit checked alone — covers the common case (dataset rows 3, 5, 7).
 *  2. Each *adjacent* pair (already-individually-clean units only) checked
 *     jointly, concatenated with no separator — covers a secret/token split
 *     exactly at a unit boundary (dataset rows 4, 6: "chunk boundary" /
 *     "wrapped across two terminal lines"). Only adjacent pairs are
 *     considered (not arbitrary N-way spans): every hygiene dataset row
 *     tests a single two-way split, and bounding the reassembly window to
 *     one boundary at a time keeps the algorithm linear and its behavior
 *     easy to reason about. FR-006a: a pair may only be dropped when the
 *     offending match is genuinely ON the join — see `pairTripsOnJoin`,
 *     whose doc comment carries the reproduced production failure this
 *     second condition exists to stop.
 *
 * A unit already dropped individually is excluded from pairwise
 * consideration so an innocent neighbor of a standalone secret is never
 * dragged down with it (the pair "secret-unit + innocent-unit" trivially
 * "trips" because the secret alone does — that must not implicate the
 * innocent unit).
 */
function scanUnits(units: string[]): { kept: string[]; anyDropped: boolean } {
  const toDrop = new Set<number>()

  units.forEach((unit, idx) => {
    if (unitTrips(unit)) toDrop.add(idx)
  })

  for (let i = 0; i + 1 < units.length; i++) {
    if (toDrop.has(i) || toDrop.has(i + 1)) continue
    // Cheap gate first (unchanged), then FR-006a's join-locality check —
    // which only ever runs on the rare pair that already tripped.
    if (unitTrips(units[i] + units[i + 1]) && pairTripsOnJoin(units[i], units[i + 1])) {
      toDrop.add(i)
      toDrop.add(i + 1)
    }
  }

  const kept = units.filter((_, idx) => !toDrop.has(idx))
  return { kept, anyDropped: toDrop.size > 0 }
}

type JudgeFieldName = "criteria" | "verifierSummaries" | "diffSummary" | "lastResponse" | "recentTranscript" | "plan"

/**
 * C-9 fix (docs/CODE-ISSUES-FROM-PROMPT-AUDIT.md — "boundary-truncation
 * fragment leak"): this now runs AFTER scanning, not before. The pipeline
 * used to truncate a field to its cap BEFORE the secret scan ever ran on it,
 * so a secret positioned to straddle that cap boundary had its tail cut off
 * first — the surviving prefix could fall just under a pattern's minimum
 * length (or the entropy threshold) even though almost the entire secret was
 * still sitting in the field, now completely unscanned. Reproduced exactly
 * with a 40-char JWT-shaped string: scanned whole it redacts correctly;
 * truncated to 39 chars first (dropping only the trailing character, which
 * pushed the JWT pattern's third segment one char under its `{8,}` floor)
 * the entire 39-char fragment survived unredacted. Every call site here now
 * scans the FULL untruncated (but still reassembled) field first via
 * `scanUnits`, and only truncates whatever text survives that scan — so
 * nothing unscanned ever reaches the output. Callers therefore invoke this
 * function on the post-scan `kept` text, not the raw field.
 *
 * MINOR fix (post-review, still true under the new order): truncation used
 * to be silent — a field over the cap was sliced with no record of it
 * happening, so a judge verdict formed from truncated (i.e. incomplete)
 * evidence was indistinguishable from one formed from the complete field.
 * Logs a distinct `judge:field-truncated` event whenever slicing actually
 * occurs. `originalLength` in that event now reports the length of the
 * text being truncated AT THIS POINT — i.e. after any tainted units were
 * already dropped by the scan, not the raw pre-scan field length; when
 * nothing was dropped the two are identical, but when something WAS dropped
 * this is deliberately the smaller, post-scan number, since that's what
 * "truncated" now describes: the size of what actually still needed cutting
 * for transmission, not how big the original raw field happened to be.
 * `judge:field-truncated` and `judge:field-dropped` are consequently
 * mutually exclusive per field per call: every call site below returns as
 * soon as scanning empties a field (logging `judge:field-dropped`) and never
 * reaches this function in that case — there is nothing left to truncate.
 *
 * `cap` defaults to `JUDGE_PAYLOAD_FIELD_CHAR_CAP` (the four fields that
 * share it never pass this argument); `recentTranscript` passes its own
 * `JUDGE_TRANSCRIPT_FIELD_CHAR_CAP` explicitly so the logged `cap` value
 * always reflects the bound actually applied.
 */
function truncateField(text: string, field: JudgeFieldName, logger: EventLogger, cap: number = JUDGE_PAYLOAD_FIELD_CHAR_CAP): string {
  if (text.length <= cap) return text
  logger("judge:field-truncated", { field, originalLength: text.length, cap })
  return text.slice(0, cap)
}

/**
 * Splits a diff summary into hunks. A hunk starts at a line matching `/^@@/`
 * (unified-diff hunk header) and runs to the next such line or end of text.
 * Any content before the first hunk header (e.g. a `diff --git`/file-header
 * preamble) is kept as its own leading unit. If no `@@` header is present at
 * all, the whole text is treated as a single hunk (a diff summary need not
 * be literal unified-diff syntax — this module cannot assume it is, so
 * "can't find a hunk boundary" degrades to "the whole field is one unit"
 * rather than silently scanning nothing).
 */
function splitDiffIntoHunks(diffSummary: string): string[] {
  if (diffSummary.length === 0) return []
  const lines = diffSummary.split("\n")
  const hunkStarts: number[] = []
  lines.forEach((line, idx) => {
    if (/^@@/.test(line)) hunkStarts.push(idx)
  })
  if (hunkStarts.length === 0) return [diffSummary]

  const hunks: string[] = []
  if (hunkStarts[0] > 0) {
    hunks.push(lines.slice(0, hunkStarts[0]).join("\n"))
  }
  for (let i = 0; i < hunkStarts.length; i++) {
    const start = hunkStarts[i]
    const end = i + 1 < hunkStarts.length ? hunkStarts[i + 1] : lines.length
    hunks.push(lines.slice(start, end).join("\n"))
  }
  return hunks
}

/**
 * Fires `judge:field-partial-drop` when a scan removed SOME but not ALL of a
 * field's units — the field survives non-empty, but lost content. This is a
 * distinct fact from `judge:field-dropped` (each field-scanning function
 * still logs that itself, exactly as before, when `kept.length === 0`):
 * before this, a field that lost one line out of three logged nothing at
 * all, so "the assistant never said this" and "it said this and the scan
 * silently removed it" were indistinguishable from the log alone (found by
 * review: a benign sentence like "I made sure no secrets leaked into the log
 * output." trips the pre-existing sensitive-label regex — see
 * `src/redaction.ts`'s `SENSITIVE_LABEL` — and vanished from a multi-line
 * `recentTranscript`/`criteria`/`verifierSummaries` field with zero trace).
 * Never fires when nothing was dropped, and never fires on a full empty
 * (that path is `judge:field-dropped`'s alone, not duplicated here).
 */
function logPartialDrop(
  units: readonly string[],
  kept: readonly string[],
  anyDropped: boolean,
  field: JudgeFieldName,
  logger: EventLogger,
): void {
  // kept.length === 0 is unreachable here: every call site already returns
  // early on units.length > 0 && kept.length === 0 (the full-drop case,
  // logged as judge:field-dropped instead) before reaching this call.
  if (!anyDropped) return
  logger("judge:field-partial-drop", { field, kept: kept.length, dropped: units.length - kept.length })
}

/**
 * C-9 fix: scan-then-truncate. `rawLines` is scanned in full — every line is
 * a unit, none of them shortened or dropped by a length cap first — so a
 * secret split across (or sitting past) a would-be truncation boundary is
 * still seen whole by `scanUnits`. Only the SURVIVING (already-scanned)
 * lines are joined and truncated to the field cap; if that truncation lands
 * mid-line, the split-back-into-lines step below can produce one partial
 * trailing line, but that line was already proven secret-free before
 * truncation ever touched it, so this is a purely cosmetic detail (see
 * `truncateField`'s doc comment for the rationale in full).
 */
function scanLineField(rawLines: string[], field: "criteria" | "verifierSummaries", logger: EventLogger): string[] | undefined {
  const rawLength = rawLines.reduce((n, l) => n + l.length + 1, 0)
  if (rawLength > JUDGE_PAYLOAD_RAW_FIELD_SAFETY_CAP) {
    logger("judge:field-oversized", { field, rawLength, cap: JUDGE_PAYLOAD_RAW_FIELD_SAFETY_CAP })
    return undefined
  }
  const units = rawLines
  const { kept, anyDropped } = scanUnits(units)
  if (units.length > 0 && kept.length === 0) {
    logger("judge:field-dropped", { field })
    return undefined
  }
  logPartialDrop(units, kept, anyDropped, field, logger)
  if (kept.length === 0) return undefined
  const truncated = truncateField(kept.join("\n"), field, logger)
  return truncated.length === 0 ? undefined : truncated.split("\n")
}

/** C-9 fix: scan-then-truncate — see `scanLineField`'s doc comment for the
 * rationale; identical shape, applied to diff hunks instead of lines. */
function scanDiffSummaryField(rawDiff: string, logger: EventLogger): string | undefined {
  if (rawDiff.length > JUDGE_PAYLOAD_RAW_FIELD_SAFETY_CAP) {
    logger("judge:field-oversized", { field: "diffSummary", rawLength: rawDiff.length, cap: JUDGE_PAYLOAD_RAW_FIELD_SAFETY_CAP })
    return undefined
  }
  const hunks = splitDiffIntoHunks(rawDiff)
  const { kept, anyDropped } = scanUnits(hunks)
  if (hunks.length > 0 && kept.length === 0) {
    logger("judge:field-dropped", { field: "diffSummary" })
    return undefined
  }
  logPartialDrop(hunks, kept, anyDropped, "diffSummary", logger)
  if (kept.length === 0) return undefined
  const truncated = truncateField(kept.join("\n"), "diffSummary", logger)
  return truncated.length === 0 ? undefined : truncated
}

/**
 * `docs/JUDGE-PROMPT.md` §5: `lastResponse` and `recentTranscript` go
 * through the EXACT SAME pipeline as the original three fields — scan the
 * reassembled, untruncated text first (secret patterns + entropy rule,
 * adjacent-unit boundary check), THEN truncate whatever survives to the
 * field's cap (C-9 fix: see `truncateField`'s doc comment) — not a
 * parallel/different redaction path. Structurally identical to
 * `scanLineField` (same unit choice: split on `\n`, same `scanUnits` call,
 * same scan-then-truncate ordering, same "emptied by the scan -> field
 * omitted" rule), differing only in shape: `scanLineField` takes/returns
 * `string[]` (criteria/verifierSummaries are already line arrays in the
 * payload); these two fields are single prose strings both in
 * `RawJudgePayload` and in `JudgePayload`, so this takes a `string` in and
 * rejoins surviving lines with `\n` on the way out instead of returning the
 * array. `cap` is threaded through (not hardcoded) so the same function
 * serves `lastResponse` (`JUDGE_PAYLOAD_FIELD_CHAR_CAP`), `recentTranscript`
 * (`JUDGE_TRANSCRIPT_FIELD_CHAR_CAP`) and `plan`
 * (`JUDGE_PLAN_FIELD_CHAR_CAP`, HANDOVER.md point 4).
 */
function scanProseField(
  text: string,
  field: "lastResponse" | "recentTranscript" | "plan",
  logger: EventLogger,
  cap: number,
): string | undefined {
  if (text.length > JUDGE_PAYLOAD_RAW_FIELD_SAFETY_CAP) {
    logger("judge:field-oversized", { field, rawLength: text.length, cap: JUDGE_PAYLOAD_RAW_FIELD_SAFETY_CAP })
    return undefined
  }
  const units = text.length === 0 ? [] : text.split("\n")
  const { kept, anyDropped } = scanUnits(units)
  if (units.length > 0 && kept.length === 0) {
    logger("judge:field-dropped", { field })
    return undefined
  }
  logPartialDrop(units, kept, anyDropped, field, logger)
  if (kept.length === 0) return undefined
  const truncated = truncateField(kept.join("\n"), field, logger, cap)
  return truncated.length === 0 ? undefined : truncated
}

/**
 * FR-031 (extended by `docs/JUDGE-PROMPT.md` §5): builds the judge payload
 * from the five raw evidence fields.
 *
 * Each field is scanned in full first — the strict scan (secret patterns via
 * `redactSecrets`, plus a Shannon-entropy rule) runs on the *reassembled,
 * untruncated* field, per FR-031 / Dataset: Judge payload hygiene — and only
 * the text that survives scanning is then truncated to the field's cap (C-9
 * fix: see `truncateField`'s doc comment for why the order matters — scanning
 * before truncating means a secret straddling the cap boundary is always
 * seen whole). A field emptied by scanning is omitted from the return value
 * and logs `judge:field-dropped` once. The function only ever sees the five
 * typed fields the caller passes in — there
 * is no free-form chat-narrative parameter for it to leak, so schema
 * exclusion of narrative (Dataset row 2) is structural, not a runtime check;
 * `lastResponse`/`recentTranscript` are themselves prose from the
 * conversation, by §5's explicit design, but they are still just two bounded,
 * scanned, named fields — not an unbounded transcript dump.
 */
export function buildJudgePayload(raw: RawJudgePayload, logger: EventLogger): JudgePayload {
  const payload: JudgePayload = {}

  const criteria = scanLineField(raw.criteria, "criteria", logger)
  if (criteria) payload.criteria = criteria

  const verifierSummaries = scanLineField(raw.verifierSummaries, "verifierSummaries", logger)
  if (verifierSummaries) payload.verifierSummaries = verifierSummaries

  const diffSummary = scanDiffSummaryField(raw.diffSummary, logger)
  if (diffSummary !== undefined) payload.diffSummary = diffSummary

  const lastResponse = scanProseField(raw.lastResponse, "lastResponse", logger, JUDGE_PAYLOAD_FIELD_CHAR_CAP)
  if (lastResponse !== undefined) payload.lastResponse = lastResponse

  const recentTranscript = scanProseField(raw.recentTranscript, "recentTranscript", logger, JUDGE_TRANSCRIPT_FIELD_CHAR_CAP)
  if (recentTranscript !== undefined) payload.recentTranscript = recentTranscript

  const plan = scanProseField(raw.plan, "plan", logger, JUDGE_PLAN_FIELD_CHAR_CAP)
  if (plan !== undefined) payload.plan = plan

  return payload
}

// ---------------------------------------------------------------------------
// runJudge — FR-030, FR-030a, FR-030b, FR-032
// ---------------------------------------------------------------------------

/**
 * HANDOVER.md point 4 (user decision, 2026-07-29): one verdict per
 * acceptance item of a story. `note` says what the judge observed or what
 * is specifically missing — the actionable detail the old prose
 * `fit/summary/gaps` shape could not carry per item.
 */
export interface JudgeItemVerdict {
  itemId: string
  met: boolean
  note: string
}

/** One entry per story the judge was asked to audit. `pass` requires every
 * listed item `met === true` (enforced by `isJudgeVerdictShape`, not just
 * documented here). */
export interface JudgeStoryVerdict {
  storyId: string
  pass: boolean
  summary: string
  items: JudgeItemVerdict[]
}

/**
 * HANDOVER.md point 4, superseding the `{fit, summary, gaps}` shape (itself
 * a `docs/JUDGE-PROMPT.md` §4 redesign of the original `{fit, notes}`):
 * structured per-story, per-acceptance-item feedback. The judge is the sole
 * arbiter of completion (point 2), so its output must name exactly which
 * criteria are met and which are not — a one-sentence `summary` plus a
 * free-form gaps list was not machine-checkable enough to drive
 * continuations ("story S2 not delivered — A3, A4 still missing").
 */
export interface JudgeVerdict {
  stories: JudgeStoryVerdict[]
}

type ModelRef = { providerID: string; modelID: string }

/**
 * Deviation from `docs/vertex2-module-contracts.md` section 8: the contract
 * declares `runJudge(...): Promise<JudgeVerdict | null>`. A bare `null`
 * cannot distinguish *why* no verdict is available, and the contract's own
 * prose punts on this ("your call... document it in your final report since
 * wave 3 wiring needs to know exactly what you return"). `runJudge` here
 * returns this discriminated union instead: `{ verdict }` on success, or
 * `{ verdict: null, reason }` with `reason` one of:
 *  - `"unsupported"` — the FR-030b capability probe failed OR the combined
 *    probe + deny-map build did not settle within `JUDGE_TOTAL_BUDGET_MS`
 *    (CRITICAL fix: a probe that cannot be confirmed in time is treated the
 *    same as one actively refused); zero `session.create`/`session.prompt`
 *    calls were made either way.
 *  - `"unavailable"` — the subturn itself failed (thrown error, timeout, or
 *    the deny map could not be (re)built after a successful probe, for a
 *    reason other than the shared budget expiring).
 *  - `"malformed"` — the subturn returned text that is not valid JSON, or
 *    valid JSON that does not match the `{stories: [...]}` verdict shape
 *    (`isJudgeVerdictShape`).
 * This lets wave-3 wiring log `judge:unsupported` / `judge:unavailable` /
 * `judge:malformed` with the right label without re-deriving it from a
 * bare-null result. `runJudge` also calls the injected `logger` itself for
 * these three event ids at the point each condition is detected (see the
 * "logging ambiguity" note in the final report) — this mirrors the pattern
 * `subturn.ts` already established for `subturn:cleanup-failed` (the module
 * that detects a condition logs it, rather than deferring to a caller that
 * would have to re-derive the same classification from the reason string).
 *
 * FR-014 (docs/JUDGE-RELIABILITY-FIXES-SPEC.md, User Story 12) adds
 * `childSessionID`: the id of the subturn session the LAST attempt created,
 * so the gate can apply the tool-call floor — a `met:false` may not be
 * applied unless the judge child session actually made >= 1 tool call. This
 * is the only deterministic protection for CONTENT claims (29 of the 49
 * recovered item notes), which FR-001's path check cannot touch by
 * construction.
 *
 * Absent whenever no child session was created (a failed probe returns
 * before `runSubturn` is ever reached) — and present-but-already-deleted is
 * the normal case, since `runSubturn`'s `finally` deletes the child before
 * returning. The gate must therefore treat an unreadable child session as
 * INCONCLUSIVE and fail open (apply the verdict, log the skip), per US12
 * AS3; this field surfaces the id, it does not promise the session still
 * exists.
 */
export type JudgeRunResult =
  | { verdict: JudgeVerdict; childSessionID?: string }
  | { verdict: null; reason: "unsupported" | "unavailable" | "malformed"; childSessionID?: string }

const JUDGE_AGENT_NAME = "vertex-judge"

/** FR-030: total budget shared across the capability probe + deny-map build
 * AND the subturn attempt(s) (override attempt, then its session-model
 * retry) — never a fresh budget per phase or per attempt (CRITICAL fix: the
 * clock now starts before the probe, not just before the subturn).
 *
 * Raised from the spec's literal 5000ms after live-host measurement: with
 * the probe passing, a real judge subturn against a hosted model
 * (openrouter/z-ai/glm-5.2) consumed the ENTIRE 5s budget on the model
 * round-trip alone and logged `judge:unavailable {reason:"timeout"}` every
 * time — i.e. the spec's budget made the judge unreachable in practice, not
 * merely tight. 5s is a plausible bound for a local/cached model and an
 * impossible one for a remote frontier model.
 *
 * `VERTEX_JUDGE_BUDGET_MS` overrides it (values <= 0 or unparseable fall
 * back to the default) so an operator on a slow provider can raise it
 * further, or drive it back down to the spec's 5000 to reproduce FR-030's
 * literal behaviour. The judge remains advisory and non-gating, so the cost
 * of a longer budget is bounded latency on an already-idle session, never a
 * blocked turn.
 *
 * The 90s default is set from measurement, not taste. Two full successful
 * judge runs (probe + child session create + model round-trip + delete)
 * against openrouter/z-ai/glm-5.2 measured **28.8s and 45.6s** — a ~1.6x
 * spread between back-to-back runs of an identical payload, i.e. provider
 * latency here is highly variable rather than tightly clustered. Budgets
 * near the observed cost are therefore actively harmful: they convert that
 * variance into intermittent `judge:unavailable` timeouts that are
 * indistinguishable from a broken feature (a 30s budget would have passed
 * the first run and failed the second). 90s is ~2x the slowest observation.
 *
 * The 90s figure above was calibrated for the ZERO-TOOL judge (a single
 * model round-trip). HANDOVER.md point 3 makes the judge tool-using: it now
 * re-runs a story's declared verifier commands itself over multiple steps
 * (maxSteps 12), and in the field session that motivated the redesign the
 * equivalent verifier runs (`make check`, targeted re-tests) took MINUTES,
 * not seconds — a 90s budget would convert the redesign's core capability
 * into a guaranteed `judge:unavailable` timeout. The default is therefore
 * raised to 300s.
 *
 * Erring generous is the right asymmetry here: the judge runs at idle and
 * remains fail-open (a timeout degrades to "no verdict", never a blocked
 * turn), so an over-long budget costs only latency on an already-idle
 * session, while an over-short one silently removes the feature. */
const DEFAULT_JUDGE_TOTAL_BUDGET_MS = 300_000

function resolveJudgeBudgetMs(): number {
  const raw = Number(process.env.VERTEX_JUDGE_BUDGET_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_JUDGE_TOTAL_BUDGET_MS
}

export const JUDGE_TOTAL_BUDGET_MS = resolveJudgeBudgetMs()

/**
 * HANDOVER.md points 2-4 (user decision, 2026-07-29), superseding the
 * `docs/JUDGE-PROMPT.md` §4/§5 prompt: the judge is now an independent
 * completion AUDITOR with read-only tools, not a zero-tool evidence
 * summarizer. Three load-bearing instructions, each tied to a field-session
 * failure:
 *  - verify, don't trust (points 2/3): the 894-message session's claims
 *    were real but the harness credited none of them; the judge must read
 *    the referenced files and re-run declared verifiers itself. Verifiers
 *    must be run as STANDALONE bash commands — never `;`-chained or piped —
 *    because the field session's deterministic gate correctly refused 19
 *    piped/chained invocations whose exit codes were unreliable.
 *  - modify nothing (point 3's boundary): no write/edit capability exists,
 *    and bash is for verifiers and read-only inspection only.
 *  - structured per-item output (point 4): one story entry per audited
 *    story, one item entry per acceptance item, pass requires every item
 *    met — machine-checkable enough to drive per-story continuations.
 *
 * FR-011 (docs/JUDGE-RELIABILITY-FIXES-SPEC.md, User Story 9 — P0, the
 * primary root-cause fix) adds a fourth: **observation is required in the
 * NEGATIVE direction too**. The prompt above said only "Read the files a
 * claim references before crediting it" — an obligation attached to
 * `met:true` and nothing else, leaving the far more damaging direction
 * completely unconstrained. The live probe isolated exactly that gap: given
 * only the payload, `runJudge` returned `pass:false` in **9.8 s** with the
 * note *"research/x.json does not exist ... ls shows no research/
 * directory"* for a file that existed (probe P1). The same agent, on the
 * same bytes, given a prompt that named what to check, called `bash ls -la`
 * and `read` and returned a correct verdict (P2/P3: 3 steps, 2 real tool
 * calls). Identical bytes, opposite verdicts, differing only in what the
 * prompt demanded — so the defect is the prompt, not the tool wiring
 * (`maxSteps` was disproven, Findings/FR-008). In the audited session 6 of 9
 * audits reverted delivered stories on this class of claim.
 *
 * The two sentences added below are deliberately absolute and name the
 * escape hatch, because "verify, don't trust" plainly did not bind: an
 * absence claim REQUIRES a prior read/glob/grep/bash observation, and when
 * the judge cannot observe it must SAY so in the note rather than assert
 * absence. Without the second sentence, a judge that cannot run a tool has
 * no compliant way to express doubt and will reach for the fabrication
 * again.
 */
const JUDGE_SYSTEM_PROMPT = [
  "You are an independent completion auditor for a coding plan whose stories have been claimed complete.",
  "You receive a plan digest (stories, their acceptance items, and the verifier commands each story declares), a diff summary, verifier output summaries, and the parent agent's last response plus a short recent transcript, as a JSON object.",
  "Do not trust the transcript or the parent's claims — verify them yourself with your read-only tools (read, grep, glob, list, bash).",
  "Read the files a claim references before crediting it.",
  'The same rule binds in the opposite direction and binds harder: you must not report an item as "met": false on the grounds that a file or directory is missing, empty, or lacks some content unless you have just observed that yourself in this session with read, glob, grep or bash.',
  "The payload is never evidence that something is absent — only that it was not quoted to you.",
  'If you cannot make that observation, say exactly that in the item\'s note (for example "could not verify: no observation of research/x.json") instead of claiming the file or its content does not exist.',
  'Where a story declares verifiers, re-run them with bash when that is feasible within your budget: run each verifier as a standalone command, never chained with ";" and never piped, so its exit code is reliable.',
  "You must not modify anything: you have no write or edit capability, and bash is for running verifiers and read-only inspection only.",
  'Respond with exactly one JSON object and nothing else, matching this shape: {"stories": [{"storyId": "S1", "pass": true|false, "summary": "...", "items": [{"itemId": "A1", "met": true|false, "note": "..."}]}]}.',
  "Emit one story entry per story you were asked to audit, and one item entry per acceptance item of that story.",
  "An item's note says what you observed or what is missing. A story's pass is true only when every one of its items is met.",
  "Do not ask questions and do not output anything other than the JSON object.",
].join(" ")

/**
 * Parse the judge's reply, tolerating the wrappers models actually emit.
 *
 * `JSON.parse(text)` alone rejected a real judge run in UAT G12 with
 * `judge:malformed {reason:"response is not valid JSON"}` -- the plan had
 * completed, the subturn had run, and the whole thing was discarded because the
 * model fenced its JSON. A zero-tool agent is instructed to return JSON and
 * usually does, but "usually" is not a contract: markdown fences and a leading
 * sentence are the two most common deviations, and each costs a full judge
 * budget (up to 90s and a model call) for nothing.
 *
 * Deliberately narrow: strip fences, then take the outermost balanced object.
 * No repair of malformed JSON, no regex extraction of individual fields --
 * shape validation still happens in `isJudgeVerdictShape`, and a reply that is
 * genuinely not a verdict must still be reported as malformed rather than
 * guessed at.
 *
 * Returns `undefined` for "could not parse", which is distinguishable from a
 * successfully parsed `null`.
 */
export function parseJudgeResponse(text: string): unknown {
  const attempt = (candidate: string): unknown => {
    try {
      return JSON.parse(candidate)
    } catch {
      return undefined
    }
  }

  const direct = attempt(text.trim())
  if (direct !== undefined) return direct

  // ```json … ``` or ``` … ```
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  if (fenced) {
    const inner = attempt(fenced[1].trim())
    if (inner !== undefined) return inner
  }

  // Outermost balanced object, ignoring braces inside strings.
  const start = text.indexOf("{")
  if (start === -1) return undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === "\\") {
      escaped = true
      continue
    }
    if (ch === '"') inString = !inString
    if (inString) continue
    if (ch === "{") depth++
    else if (ch === "}") {
      depth--
      if (depth === 0) return attempt(text.slice(start, i + 1))
    }
  }
  return undefined
}

function isJudgeItemVerdictShape(value: unknown): value is JudgeItemVerdict {
  if (typeof value !== "object" || value === null) return false
  const item = value as Record<string, unknown>
  return (
    typeof item.itemId === "string" &&
    item.itemId.trim().length > 0 &&
    typeof item.met === "boolean" &&
    typeof item.note === "string"
  )
}

/**
 * HANDOVER.md point 4 shape check. Stricter than the `{fit, summary, gaps}`
 * check it replaces, in ways that are all load-bearing:
 *  - `stories` must be a NON-EMPTY array — the judge is the sole arbiter of
 *    completion (point 2), so an empty audit is never a valid verdict.
 *  - every story needs a non-blank `storyId`, a boolean `pass`, a string
 *    `summary`, and an `items` array of `{itemId (non-blank), met
 *    (boolean), note (string)}` — a wrong per-item shape is rejected, not
 *    coerced, exactly as the old `isJudgeGapShape` rule worked.
 *  - `pass: true` REQUIRES every listed item `met === true`: a pass with an
 *    unmet item is malformed, not a prompt-compliance question — this is
 *    the machine-checkable invariant continuations rely on.
 *  - the superseded `{fit, summary, gaps}` shape (and the older
 *    `{fit, notes}`) has no `stories` key, so both are rejected as
 *    malformed rather than silently accepted — no field-name aliasing or
 *    best-effort fallback to either old shape.
 *  - unknown extra keys (on the verdict, a story, or an item) are
 *    tolerated: models add commentary fields; only the contract keys are
 *    validated.
 */
function isJudgeVerdictShape(value: unknown): value is JudgeVerdict {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  if (!Array.isArray(v.stories) || v.stories.length === 0) return false
  for (const story of v.stories) {
    if (typeof story !== "object" || story === null) return false
    const s = story as Record<string, unknown>
    if (typeof s.storyId !== "string" || s.storyId.trim().length === 0) return false
    if (typeof s.pass !== "boolean") return false
    if (typeof s.summary !== "string") return false
    if (!Array.isArray(s.items) || !s.items.every(isJudgeItemVerdictShape)) return false
    if (s.pass === true && !(s.items as JudgeItemVerdict[]).every((item) => item.met === true)) return false
  }
  return true
}

/**
 * FR-014 plumbing: learn which child session the subturn created, WITHOUT
 * changing `subturn.ts`.
 *
 * `runSubturn` creates the child, calls `selfCreated.record(childID,
 * parentID)`, and deletes it in a `finally` — the id never appears in its
 * return value. The gate needs it to apply the tool-call floor (US12), so
 * this wraps the caller's registry in a delegating view whose `record` also
 * writes the id into `sink`.
 *
 * Why `Object.create` and not a subclass: `SelfCreatedSessions` owns its
 * `ids` Set per instance, so a subclass instance would record child ids into
 * a SECOND registry and the caller's registry would no longer recognise the
 * judge's own child sessions — breaking FR-036 (all five hooks must return
 * early for harness-created sessions), which is a live-session correctness
 * property, not a test detail. Prototype delegation keeps exactly one
 * registry: the override shadows only `record`, forwards to the real
 * instance, and every other member resolves through the prototype chain to
 * the caller's object.
 */
function observeChildSessionID(
  selfCreated: SelfCreatedSessions,
  sink: { childSessionID?: string },
): SelfCreatedSessions {
  const view = Object.create(selfCreated) as SelfCreatedSessions
  const record: SelfCreatedSessions["record"] = (sessionID, parentID) => {
    sink.childSessionID = sessionID
    selfCreated.record(sessionID, parentID)
  }
  Object.defineProperty(view, "record", { value: record, writable: true, configurable: true })
  return view
}

/**
 * FR-030/FR-030a/FR-030b/FR-032: runs the judge subturn.
 *
 * 0. CRITICAL fix: the `JUDGE_TOTAL_BUDGET_MS` budget clock (`start`) now
 *    starts BEFORE step 1, not after it. Previously `probeCapability` and
 *    `buildDenyMap` were plain un-timed `await`s taken before `start` was
 *    read, so a hanging `client.app.agents()`/`client.tool.ids()` could
 *    block this function indefinitely — violating FR-030's literal
 *    "`Promise.race` 5s total including the retry." The probe + deny-map
 *    build now count against the same 5s total as the subturn attempt(s).
 * 1. Runs `subturn.ts`'s `probeCapabilityBounded` (probe, then tool-map
 *    build, raced together against the remaining budget) WITH
 *    `JUDGE_PROBE_POLICY` (HANDOVER.md point 3): the probe verifies the
 *    registered judge agent has no capability beyond read/grep/glob/list/
 *    bash (with edit/write/webfetch/task provably denied), and the
 *    resulting allow-aware map from `buildToolPolicyMap` — not a pure deny
 *    map — is what the subturn's `tools` field receives. A failure returns
 *    immediately with zero `session.create`/`session.prompt` calls
 *    (`runSubturn` is never reached). A probe failure OR a timeout both log
 *    `judge:unsupported` once (a probe that cannot be confirmed in time is
 *    treated identically to one actively refused); a tool-map-build failure
 *    (non-timeout) logs `judge:unavailable`, unchanged from before this fix.
 *    This module does not receive a pre-cached tool map from the caller
 *    (the contracted signature has no slot for one) — it re-derives it on
 *    every call. See the "deny map caching" note in the final report for
 *    the trade-off this implies.
 * 2. Model = `judgeModelOverride ?? sessionModel` for the first attempt. If
 *    `judgeModelOverride` was set and that attempt's subturn fails (thrown,
 *    timed out, or otherwise `{ok: false}`), retries once with
 *    `sessionModel`. Every attempt draws from the SAME `JUDGE_TOTAL_BUDGET_MS`
 *    clock started in step 0 — each attempt's `timeoutMs` is whatever is
 *    left of the total, not a fresh budget per attempt.
 * 3. A successful subturn's response text is parsed as JSON and checked
 *    against the `{stories: [...]}` shape (`isJudgeVerdictShape`, HANDOVER.md
 *    point 4); anything else — including BOTH superseded shapes
 *    (`{fit, summary, gaps}` and `{fit, notes}`) — is `"malformed"`, not
 *    thrown.
 * 4. FR-014: every result — success or failure — carries the id of the child
 *    session the last attempt created (`childSessionID`), so the gate can
 *    apply the tool-call floor. See `observeChildSessionID` for why it is
 *    captured by observing the recorder rather than by changing
 *    `runSubturn`'s return type.
 */
export async function runJudge(
  client: OpencodeClient,
  deps: { selfCreated: SelfCreatedSessions; logger: EventLogger },
  opts: {
    parentSessionID: string
    sessionModel: ModelRef
    judgeModelOverride?: ModelRef
    payload: JudgePayload
  },
): Promise<JudgeRunResult> {
  const { selfCreated, logger } = deps
  const { parentSessionID, sessionModel, judgeModelOverride, payload } = opts

  const observed: { childSessionID?: string } = {}
  const recordingSelfCreated = observeChildSessionID(selfCreated, observed)

  const start = Date.now()

  const probeResult = await probeCapabilityBounded(client, JUDGE_AGENT_NAME, JUDGE_TOTAL_BUDGET_MS, JUDGE_PROBE_POLICY)
  if (!probeResult.ok) {
    if (probeResult.cause === "deny-map") {
      logger("judge:unavailable", { reason: `tool policy map unavailable: ${probeResult.reason}` })
      return { verdict: null, reason: "unavailable" }
    }
    // cause is "probe" or "timeout" — both fold to "unsupported" (fix #1:
    // a probe/tool-map timeout is treated the same as an ordinary probe
    // refusal, matching the existing judge:unsupported log path).
    logger("judge:unsupported", { reason: probeResult.reason })
    return { verdict: null, reason: "unsupported" }
  }
  const toolsMap = probeResult.tools

  const attempts: ModelRef[] = judgeModelOverride ? [judgeModelOverride, sessionModel] : [sessionModel]
  const parts = [{ type: "text" as const, text: JSON.stringify(payload) }]

  let last: { ok: true; text: string } | { ok: false; reason: string } | null = null

  for (const model of attempts) {
    const remaining = JUDGE_TOTAL_BUDGET_MS - (Date.now() - start)
    if (remaining <= 0) {
      last = { ok: false, reason: "timeout" }
      break
    }
    last = await runSubturn(client, recordingSelfCreated, logger, {
      parentSessionID,
      agent: JUDGE_AGENT_NAME,
      model,
      system: JUDGE_SYSTEM_PROMPT,
      parts,
      tools: toolsMap,
      timeoutMs: remaining,
    })
    if (last.ok) break
  }

  // FR-014: `observed.childSessionID` is undefined when no child was ever
  // created (e.g. `session.create` itself failed, or the budget was already
  // spent), and spreading an object with an undefined value would still add
  // the key — so it is spread conditionally, keeping "no child" as an ABSENT
  // key rather than an explicitly-undefined one.
  const child = observed.childSessionID === undefined ? {} : { childSessionID: observed.childSessionID }

  if (!last || !last.ok) {
    logger("judge:unavailable", { reason: last?.reason ?? "unknown" })
    return { verdict: null, reason: "unavailable", ...child }
  }

  const parsed = parseJudgeResponse(last.text)
  if (parsed === undefined) {
    logger("judge:malformed", { reason: "response is not valid JSON" })
    return { verdict: null, reason: "malformed", ...child }
  }

  if (!isJudgeVerdictShape(parsed)) {
    logger("judge:malformed", { reason: "response does not match {stories: [{storyId, pass, summary, items}]} shape" })
    return { verdict: null, reason: "malformed", ...child }
  }

  return { verdict: parsed, ...child }
}
