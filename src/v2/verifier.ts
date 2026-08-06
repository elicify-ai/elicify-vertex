/**
 * Vertex 2 — Tier-3 verifier as an in-loop subturn (US-9, FR-030/FR-030a/FR-031/FR-032;
 * redesigned per HANDOVER.md points 2-4, user decision 2026-07-29).
 *
 * The verifier is now the SOLE ARBITER of story/plan completion (point 2), run
 * at session.idle over stories that CLAIMED complete. It is no longer a
 * zero-tool evidence-summarizer: it gets read-only tools (read/grep/glob/
 * list/bash, point 3 — `subturn.ts`'s `VERIFIER_PROBE_POLICY`) so it can
 * independently re-run a story's declared verifiers rather than trusting
 * the transcript, and it answers with STRUCTURED per-acceptance-item
 * verdicts (point 4 — `{stories: [{storyId, pass, summary, items:
 * [{itemId, met, note}]}]}`) instead of the old prose `{fit, summary,
 * gaps}`. The motivating evidence: a real 894-message field session ended
 * 5/5 stories blocked with genuinely-completed work the harness could not
 * credit, and the zero-tool verifier never fired to rescue it.
 *
 * Two responsibilities, kept in one module because they share the same
 * "evidence only, fail open" posture:
 *
 *  - `buildVerifierPayload` (FR-031, review MAJ-009; extended by
 *    `docs/VERIFIER-PROMPT.md` §5): turns raw criteria/diff/verifier/
 *    lastResponse/recentTranscript text into the five-field payload sent to
 *    the verifier subturn, after a strict scan (secret patterns + a
 *    Shannon-entropy rule, via `redactSecrets`) applied to the *reassembled,
 *    untruncated* field so a secret split across a chunk/line boundary — OR
 *    sitting past where a length cap would otherwise cut — is still caught.
 *    A field emptied by the scan is omitted from the payload entirely. ONLY
 *    AFTER scanning, the surviving (already-scanned) text is truncated to its
 *    cap (`VERIFIER_PAYLOAD_FIELD_CHAR_CAP` for four of the five fields;
 *    `VERIFIER_TRANSCRIPT_FIELD_CHAR_CAP` for `recentTranscript`) and logs
 *    `verifier:field-truncated` (MINOR fix, post-review: this used to be
 *    silent, so a verdict built from truncated evidence was
 *    indistinguishable after the fact from one built from the complete
 *    field). C-9 fix (docs/CODE-ISSUES-FROM-PROMPT-AUDIT.md): this
 *    scan-then-truncate order is deliberately the reverse of the pipeline's
 *    original truncate-then-scan order — see `truncateField`'s doc comment
 *    for why the old order let a secret straddling the cap boundary leak
 *    almost whole. One consequence: `verifier:field-dropped` (the field's scan
 *    removed everything) and `verifier:field-truncated` (the surviving text was
 *    still too long) are now mutually exclusive for a given field within one
 *    call — a fully-dropped field has nothing left to truncate.
 *  - `runVerifier` (FR-030/FR-030a/FR-030b/FR-032): gates on `subturn.ts`'s
 *    `probeCapabilityBounded` (the probe + deny-map build, bounded by the
 *    SAME 5s budget as everything that follows — CRITICAL fix, see that
 *    function's doc comment: the budget clock now starts before the probe,
 *    not after it), then issues at most two `runSubturn` attempts (override
 *    model, then session model on failure) sharing the remainder of that
 *    budget, and classifies the outcome so a caller can fail open without
 *    ever throwing.
 *
 * Both are fail-open by construction: nothing in this file throws out to a
 * caller on a verifier-side problem — every failure mode resolves to a typed
 * "no verdict" result (see the `VerifierRunResult` deviation note below).
 */

import { redactSecrets } from "../redaction.js"
import { VERIFIER_PROBE_POLICY, probeCapabilityBounded, runSubturn, type SelfCreatedSessions, type SubturnResult } from "./subturn.js"
import type { EventLogger, OpencodeClient } from "./types.js"

// ---------------------------------------------------------------------------
// buildVerifierPayload — FR-031
// ---------------------------------------------------------------------------

/**
 * Deviation from `docs/vertex2-module-contracts.md` section 8: the contract
 * declares `interface VerifierPayload { criteria: string[]; diffSummary: string;
 * verifierSummaries: string[] }` with all three fields required. FR-031 and
 * Dataset: Verifier payload hygiene row 7 both require that a field emptied by
 * the strict scan be *omitted* (the key absent, not an empty string/array),
 * which the contract's own required-fields shape cannot express. `VerifierPayload`
 * is therefore `Partial` here — every field is optional, present only when
 * it survived scanning with content. Document this prominently: wave-3 wiring
 * must treat all three keys as possibly-absent when rendering the close-out
 * report / subturn prompt.
 *
 * `docs/VERIFIER-PROMPT.md` §5 adds two more fields on the same terms —
 * `lastResponse` (the parent's last assistant message, verbatim) and
 * `recentTranscript` (a bounded recent window, both roles) — sourced,
 * redacted and capped exactly like the original three (see `gate.ts`'s
 * `appendVerifierCloseOut`, which fetches them via `client.session.messages`
 * and passes them into `buildVerifierPayload` alongside the existing three raw
 * fields). Same absent-when-emptied rule applies.
 *
 * HANDOVER.md point 4 adds a sixth field, `plan`: a rendered plan digest
 * (stories, statuses, acceptance items, declared verifiers) supplied by the
 * caller, so the verifier audits against the plan's own claims rather than a
 * flattened criteria list. Same pipeline as `recentTranscript`
 * (scan-then-truncate via `scanProseField`), with its own 4000-char cap
 * (`VERIFIER_PLAN_FIELD_CHAR_CAP`).
 */
export interface VerifierPayload {
  criteria?: string[]
  diffSummary?: string
  verifierSummaries?: string[]
  lastResponse?: string
  recentTranscript?: string
  plan?: string
}

interface RawVerifierPayload {
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
 * bound for evidence text (a verifier subturn needs a *summary*, not a full
 * transcript) while comfortably exercising the boundary dataset row's
 * 4,000-char oversized input. Applied uniformly to `criteria`,
 * `verifierSummaries`, `diffSummary` and `lastResponse` (`docs/VERIFIER-PROMPT.md`
 * §5: "the existing VERIFIER_PAYLOAD_FIELD_CHAR_CAP ... same cap as every other
 * field"), even though only the verifier-summary row is tested.
 */
const VERIFIER_PAYLOAD_FIELD_CHAR_CAP = 2000

/**
 * `docs/VERIFIER-PROMPT.md` §5's proposed cap for `recentTranscript`: "roughly
 * double [the per-field cap], since it carries multiple turns of nuance
 * rather than one fact. Not measured against anything; a real number to
 * argue with, not a claim." Kept as its own named constant (not derived from
 * `VERIFIER_PAYLOAD_FIELD_CHAR_CAP * 2`) so it can be tuned independently
 * without touching the other four fields' cap.
 */
const VERIFIER_TRANSCRIPT_FIELD_CHAR_CAP = 4000

/**
 * HANDOVER.md point 4: the `plan` field's cap. Originally 4000 chars, copied
 * from `recentTranscript` on a "several turns of nuance" sizing argument —
 * i.e. a guess, never measured against a real digest.
 *
 * FR-006 (docs/VERIFIER-RELIABILITY-FIXES-SPEC.md, User Story 6) raises it to
 * 16000 from a MEASUREMENT, not taste. In the audited live session
 * (`ses_04dc77bdaffej8SFJvYm5yO0CW`) `verifier:field-truncated {plan,
 * originalLength: 6411-6425, cap: 4000}` fired on all 9 audit runs, and the
 * verifier then FAILed stories citing exactly the content the cap had removed
 * ("the verifier command is incomplete in the digest", "S5 has no
 * independent verifier set in the digest") — a self-inflicted false FAIL.
 * The `originalLength` in those events is the POST-scan length; the RAW
 * digest for that 6-story plan measures **7518 chars** (spec round-2 finding
 * m-19). 16000 is ~2.1x the measured raw digest: headroom for a plan roughly
 * twice as large before truncation re-engages, rather than a bound that
 * already binds on the very plan that motivated it.
 *
 * Raising the cap does NOT unbound cost or weaken redaction:
 *  - `VERIFIER_PAYLOAD_RAW_FIELD_SAFETY_CAP` (100_000) still drops a
 *    pathological raw field WHOLE before scanning, so scan cost stays
 *    bounded (US6 AS2's "the bound is raised, not removed").
 *  - the scan still runs on the full reassembled field BEFORE truncation
 *    (C-9 order), so a secret anywhere in the digest is still dropped
 *    (US6 AS3) — a bigger cap only means less scanned-clean text is thrown
 *    away afterward.
 *  - truncation above 16000 still happens and still logs
 *    `verifier:field-truncated`.
 */
const VERIFIER_PLAN_FIELD_CHAR_CAP = 16000

/**
 * C-9 follow-up, cost regression (docs/CODE-ISSUES-FROM-PROMPT-AUDIT.md):
 * scanning the FULL untruncated field — required for C-9's "nothing
 * unscanned reaches the output" guarantee — means scan cost now scales with
 * the RAW field size, not the post-truncation cap. `criteria`/
 * `verifierSummaries`/`diffSummary` are already bounded upstream
 * (`plugin.ts`'s `.slice(-2000)`, `computeBoundedDiffStat`'s 4000-char cap)
 * before they ever reach here, but `lastResponse`/`recentTranscript` are
 * not — `wiring/gate.ts`'s own comment on `VERIFIER_RECENT_TRANSCRIPT_TURN_WINDOW`
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
const VERIFIER_PAYLOAD_RAW_FIELD_SAFETY_CAP = 100_000

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
 * bits/char in practice — see tests/v2/verifier.test.ts — nowhere near this
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
  // CR-2 (round 5): `\r` must go too. Stripping only `\n` left a bare `\r`
  // wherever content was CRLF, and `\r` is whitespace — so it separated
  // tokens for `tripsEntropyScan`'s `split(/\s+/)`, blocked `SECRET_PATTERNS`
  // from matching across a wrap, and broke the invariant this function exists
  // to provide (`dewrap(a + b) === dewrap(a) + dewrap(b)` with the halves
  // fused). Measured: a 40-char hex key wrapped across two CRLF lines was
  // transmitted whole, where the identical LF input was fully redacted.
  return text.replace(/[\r\n]/g, "")
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
 * being dropped when they appear in evidence text — accepted, since a verifier
 * subturn losing one line of context is far cheaper than a leaked secret.
 *
 * Deliberately kept LOCAL to the verifier payload pipeline, not added to
 * `redaction.ts`'s shared `SECRET_PATTERNS` (which also backs
 * `redactForDisk`, used to persist `VerificationReceipt`s — whose `signature`
 * field is itself a bare 64-char hex HMAC digest, and `scope.worktreeDigest`
 * a bare hex hash). Adding this rule there was tried and reverted: it
 * corrupted receipt signatures on every disk write (`atomicWriteJson` in
 * `goals.ts` calls `redactForDisk` on the whole receipts file), breaking
 * `verifyReceiptSignature` for every receipt persisted afterward — 13 tests
 * across `forgery.test.ts`/`receipts.test.ts`/`tools.test.ts`/
 * `plugin.integration.test.ts` failed with "genuine receipt must survive:
 * expected null not to be null" once reproduced. The five verifier-payload
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
 * FR-006a (docs/VERIFIER-RELIABILITY-FIXES-SPEC.md, round-2 finding M-10 —
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
 * session this fired 11x on the `plan` field (`verifier:field-partial-drop
 * {plan, kept:51, dropped:4}`), deleting S1/S2/S3's `verifiers:` lines, after
 * which the verifier FAILed those stories for having no verifiers in the digest.
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
// (superseded by PATHLIKE_AT_JOIN — see CRIT-001 note below)

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
/**
 * Characters that never appear inside a secret token but are ubiquitous in
 * the file paths / identifiers this fix exists to protect. A fused token
 * containing one of these on the LEFT of the join is a path-plus-next-word
 * artifact, not a wrapped secret.
 *
 * CRIT-001 fix (code review, reproduced): the previous discriminator was a
 * fragment-LENGTH bar (each side >= 16 chars). That let a real wrapped secret
 * leak whenever the split was uneven — a 42-char token split 27/15 transmitted
 * BOTH fragments where the pre-fix code redacted them:
 *
 *     pre-fix : criteria: undefined            events: [verifier:field-dropped]
 *     post-fix: criteria: ["sV8kQz3RtY7pLm…","1jK5aZ0eR8uT3iO"]   events: []
 *
 * Length cannot separate the classes (a wrap can be arbitrarily uneven), so
 * the bar is now SHAPE: a secret is continuous random material, whereas the
 * production false positive (`…space-exploration.json` + `S2`) carries `/`
 * and `.` — structure a random token does not have. Erring toward redaction
 * is the correct direction for a payload leaving the process.
 */
/**
 * The join is exonerated ONLY when it looks like "a path token ran into the
 * next line's short leading word" — the exact production false positive
 * (`…/space-exploration.json` + `S2`). Everything else is treated as a
 * possible wrapped secret.
 *
 * Two earlier attempts failed, both reproduced:
 *  - a fragment-LENGTH bar (each side >= 16 chars) leaked an unevenly split
 *    secret (42-char token split 27/15 transmitted both halves);
 *  - a character-CLASS bar (`/ \ . : @ = +` anywhere in a fragment) was far
 *    worse: base64 — the canonical wire form of a random key — is built from
 *    `/` and `+` with `=` padding, so a real 32-byte key leaked a >=16-char
 *    fragment at 19 of its 43 split points.
 *
 * Hence a POSITIVE, anchored shape test instead of a negative char-class one:
 * the left fragment must END in a path-like token (segments joined by `/`, or
 * a dotted filename) and the right fragment must BEGIN with a short
 * identifier-ish word. Random material satisfies neither anchor, so a secret
 * is never exonerated regardless of which characters it happens to contain.
 * The cost is a false drop on two adjacent long random-looking identifiers,
 * which errs toward redaction — the correct direction for a payload leaving
 * the process.
 */
// CR-6 (round 5): a 20-extension allowlist meant the reproduced production
// false positive recurred verbatim for any OTHER extension (`.sql`, `.proto`,
// `.tf`, …) and silently deleted plan-digest lines. Any dotted filename
// counts now; the extension is required to be alphabetic and short so a
// version string or a sentence-ending period does not qualify. The
// `looksLikeWord` check below is the general backstop.
const LEFT_ENDS_IN_PATH = /[\w-]+\.[A-Za-z][A-Za-z0-9]{0,7}$/
const RIGHT_STARTS_SHORT_WORD = /^[A-Za-z][\w-]{0,7}$/

function entropyTokenStraddles(joined: string, joinIdx: number): boolean {
  const re = /\S+/g
  let match: RegExpExecArray | null
  while ((match = re.exec(joined)) !== null) {
    const token = match[0]
    const start = match.index
    const end = start + token.length
    if (token.length < ENTROPY_MIN_TOKEN_LENGTH) continue
    if (!(start < joinIdx && end > joinIdx)) continue
    if (shannonEntropyBitsPerChar(token) < ENTROPY_EFFECTIVE_THRESHOLD_BITS) continue
    // The join is only exonerated when the material immediately around it is
    // structurally path-like. Everything else — including a lopsided wrap —
    // is treated as a possible secret and the pair is dropped.
    const leftFragment = joined.slice(start, joinIdx)
    const rightFragment = joined.slice(joinIdx, end)
    if (LEFT_ENDS_IN_PATH.test(leftFragment) && RIGHT_STARTS_SHORT_WORD.test(rightFragment)) continue
    // Round 4: the anchor above only exonerates a left fragment ending in a
    // FILE EXTENSION, which left the general FR-006a false positive open —
    // "…assigned correctly" + "tests/fixtures/verifier-replay was refreshed"
    // fuse into `correctlytests/fixtures/verifier-replay`, over 32 chars and
    // over the entropy bar, and BOTH innocent lines were dropped. Found by a
    // test written for something else entirely.
    //
    // `looksLikeWord` is the same discriminator C1 uses and a far better one
    // than the anchor: real key material does not decompose into words, and
    // fused prose always does. Applied to BOTH FRAGMENTS, not the whole
    // token: a 43-char base64 key can itself segment into enough pseudo-words
    // to pass (measured — testing the whole token re-opened 32 leaks), while
    // a split key always leaves at least one side that is plainly random.
    if (looksLikeWord(leftFragment) && looksLikeWord(rightFragment)) continue
    return true
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
 *     easy to reason about.
 *
 *     KNOWN, MEASURED LIMIT of that choice: a secret split into THREE or
 *     more units where no two consecutive pieces reach
 *     ENTROPY_MIN_TOKEN_LENGTH is invisible to both passes — e.g. a 44-char
 *     base64 key as [16][6][22] leaks its 16-char head, at 135 of 1005
 *     probed three-way splits. Two-way splits are clean (0 of 5800). Closing
 *     this needs a span pass that attributes an offending token back to the
 *     units it crosses, which is a larger change than C1 called for; it is
 *     recorded here rather than left to be rediscovered.
 *
 *     FR-006a: a pair may only be dropped when the
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
/**
 * C1: is this fragment plausibly a PIECE of the secret it abuts, rather than
 * ordinary text that merely sits next to one?
 *
 * `pairTripsOnJoin` cannot answer this when the neighbor is a confirmed
 * secret. A secret flush against a unit boundary fuses with whatever follows,
 * so a high-entropy token straddles the join no matter what the neighbor says
 * — "…all tests pass" scores identically to a key fragment.
 *
 * The first attempt at this test (>=12 chars, secret alphabet, >=2 character
 * classes) was far too loose — MAJ-5, measured: `Authorization`,
 * `createPlanRequest` and `snake_case_var_1` all matched, so four of five
 * lines were dropped from a field whose first line held a secret, and a
 * 40-char git SHA (a DOCUMENTED false positive of the hex-run rule, no real
 * secret needed) emptied the field outright. That re-created FR-006a, the
 * exact failure this module exists to prevent.
 *
 * So the bar is now structural, not statistical: key material is what does
 * NOT decompose into words. A fragment is treated as secret only when it is
 * long enough to matter, drawn from the secret alphabet, and fails
 * `looksLikeWord` — which segments it on `_`, `-` and camelCase/digit
 * boundaries and asks whether the pieces read like an identifier.
 */
const SECRET_ALPHABET_RUN = /^[A-Za-z0-9+/=_-]+$/
const SECRET_FRAGMENT_MIN_CHARS = 16

/**
 * Does this token decompose into word-shaped segments? `createPlanRequest` ->
 * create|Plan|Request (all >=3 letters) is an identifier; `HUZxXdF2O3ftvnSN`
 * -> HUZx|Xd|F2|O3|ftvn|SN is not. Deliberately generous toward "word": a
 * false "yes" keeps a line that might hold a fragment, a false "no" deletes
 * evidence the verifier needs, and the second failure is the one that has
 * actually hurt in production.
 */
function looksLikeWord(token: string): boolean {
  const segments = token
    // `/` is in `SECRET_ALPHABET_RUN`, so without splitting on it too an
    // all-lowercase path like `tests/fixtures/replay` was read as key
    // material and stripped — the FR-006a class again.
    .split(/[_\-/]|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Za-z])(?=\d)|(?<=\d)(?=[A-Za-z])/)
    .filter((part) => part !== "")
  if (segments.length === 0) return false
  // `+` and `=` are base64-only: no identifier or English word contains them.
  if (/[+=]/.test(token)) return false
  // A word has a vowel. base64url survives the ratio and mean-length bars by
  // segmenting on its own `-`/`_` into plausible-looking runs — but they are
  // runs like `Nvrf`, `fdgb`, `KBCdfv`, which no English word or identifier
  // resembles. Measured: this closed the last 5 leaks in a 12000-split sweep
  // and keeps every prose token the earlier bars were protecting.
  const wordy = segments.filter((part) => /^[A-Za-z]{3,}$/.test(part) && /[aeiouy]/i.test(part))
  // At least half the segments must be real alphabetic runs. Random material
  // fragments into one- and two-character shards; identifiers do not.
  if (wordy.length * 2 < segments.length) return false
  // ...and those runs must be word-LENGTH. Base64 clears the ratio test on
  // 3-4 character pseudo-words (`Txob|Y+f|Dakt|WCr|SX|Rdw` scored 4 of 8 and
  // leaked 20 fragments in a 10840-split probe); real prose does not
  // (`tests|fixtures|verifier|replay` averages 6, `correctly` 9).
  const meanWordLength = wordy.reduce((sum, part) => sum + part.length, 0) / wordy.length
  return meanWordLength >= 4.5
}

/**
 * A long run of nothing but hex digits. Decided BEFORE `looksLikeWord`,
 * because hex fragments segment into convincing pseudo-words — `fceff65ebc6fecde`
 * splits as fceff|65|ebc|6|fecde, three of five "wordy", which is how eight
 * residual leaks survived the structural test. An English word 16+ characters
 * long drawn solely from a-f and digits does not occur.
 */
const LONG_HEX_RUN = /^[0-9a-f]{16,}$/i

function looksLikeSecretFragment(fragment: string): boolean {
  if (fragment.length < SECRET_FRAGMENT_MIN_CHARS) return false
  if (!SECRET_ALPHABET_RUN.test(fragment)) return false
  if (LONG_HEX_RUN.test(fragment)) return true
  return !looksLikeWord(fragment)
}

/**
 * C1/MAJ-5: strip a secret fragment off the edge of a unit that FACES a unit
 * dropped for holding a secret.
 *
 * The first version dropped the whole neighbouring unit, which cascaded: each
 * newly-dropped unit implicated its own neighbour in turn, so one trigger
 * could empty an entire field. Removing just the offending token bounds the
 * damage to that token and makes a cascade structurally impossible — a
 * stripped unit is never added to `toDrop`, so it never implicates anything.
 */
function stripFacingFragment(unit: string, facing: "start" | "end"): string {
  // CRIT-3 (round 4): this used to test the whole `\S+` edge token, so ANY
  // adjacent punctuation defeated it — `"db2e...c139", rest` kept 24 hex
  // characters of a live key, and the shapes that leak (`( [ " ' < ` ; ) ,`)
  // are exactly JSON, markdown and quoted shell output, all of which reach
  // `recentTranscript` / `lastResponse` / `plan`. Locate the maximal
  // secret-alphabet RUN at the facing edge instead, ignoring punctuation
  // around it, and remove only that run.
  // The skip class is punctuation and NEWLINES but not spaces/tabs. Newlines
  // belong in it because `dewrap` removes them before any scan, so a unit
  // beginning `"\n<fragment>"` really is fused to the secret; a SPACE is a
  // genuine separator, and skipping past one would strip a token that was
  // never part of the secret at all. (Examining `dewrap(unit)` instead was
  // tried and is wrong: it returns the unit with its newlines gone, which
  // collapses multi-line diff hunks.)
  const SKIP = "(?:[\\n\\r]|[^\\sA-Za-z0-9+/=_-])*"
  const run =
    facing === "start"
      ? new RegExp(`^${SKIP}([A-Za-z0-9+/=_-]+)`).exec(unit)
      : new RegExp(`([A-Za-z0-9+/=_-]+)${SKIP}$`).exec(unit)
  if (!run || !looksLikeSecretFragment(run[1])) return unit
  const at = unit.indexOf(run[1], facing === "start" ? 0 : unit.length - run[0].length)
  return unit.slice(0, at) + unit.slice(at + run[1].length)
}

function scanUnits(units: string[]): { kept: string[]; anyDropped: boolean } {
  const toDrop = new Set<number>()

  units.forEach((unit, idx) => {
    if (unitTrips(unit)) toDrop.add(idx)
  })

  // The adjacent-pair pass, for two units that are BOTH individually clean.
  for (let i = 0; i + 1 < units.length; i++) {
    if (toDrop.has(i) || toDrop.has(i + 1)) continue
    // Cheap gate first (unchanged), then FR-006a's join-locality check —
    // which only ever runs on the rare pair that already tripped.
    if (unitTrips(units[i] + units[i + 1]) && pairTripsOnJoin(units[i], units[i + 1])) {
      toDrop.add(i)
      toDrop.add(i + 1)
    }
  }

  // C1: a secret wrapped across a unit boundary leaves a fragment in the
  // SURVIVING neighbour that is too short to trip on its own — a 64-char hex
  // key split at 16 drops the 48-char tail and used to keep the 16-char head
  // (measured: 800 of 3425 split points). The pair pass above cannot catch it,
  // because it skips any pair with an already-dropped member.
  //
  // Only the offending EDGE TOKEN is removed, not the unit (MAJ-5), and only
  // units dropped by the passes above seed this — a stripped unit is not
  // dropped, so nothing propagates and a field can never empty itself.
  const seeds = [...toDrop]
  const edited = [...units]
  for (const i of seeds) {
    const secret = dewrap(units[i])
    // Fusion needs BOTH edges non-whitespace: a secret line ending in a space
    // cannot bleed into its neighbour's token.
    if (/\S$/.test(secret) && i + 1 < units.length && !toDrop.has(i + 1)) {
      edited[i + 1] = stripFacingFragment(edited[i + 1], "start")
    }
    if (/^\S/.test(secret) && i - 1 >= 0 && !toDrop.has(i - 1)) {
      edited[i - 1] = stripFacingFragment(edited[i - 1], "end")
    }
  }

  const kept = edited.filter((_, idx) => !toDrop.has(idx))
  return { kept, anyDropped: toDrop.size > 0 }
}

type VerifierFieldName = "criteria" | "verifierSummaries" | "diffSummary" | "lastResponse" | "recentTranscript" | "plan"

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
 * happening, so a verifier verdict formed from truncated (i.e. incomplete)
 * evidence was indistinguishable from one formed from the complete field.
 * Logs a distinct `verifier:field-truncated` event whenever slicing actually
 * occurs. `originalLength` in that event now reports the length of the
 * text being truncated AT THIS POINT — i.e. after any tainted units were
 * already dropped by the scan, not the raw pre-scan field length; when
 * nothing was dropped the two are identical, but when something WAS dropped
 * this is deliberately the smaller, post-scan number, since that's what
 * "truncated" now describes: the size of what actually still needed cutting
 * for transmission, not how big the original raw field happened to be.
 * `verifier:field-truncated` and `verifier:field-dropped` are consequently
 * mutually exclusive per field per call: every call site below returns as
 * soon as scanning empties a field (logging `verifier:field-dropped`) and never
 * reaches this function in that case — there is nothing left to truncate.
 *
 * `cap` defaults to `VERIFIER_PAYLOAD_FIELD_CHAR_CAP` (the four fields that
 * share it never pass this argument); `recentTranscript` passes its own
 * `VERIFIER_TRANSCRIPT_FIELD_CHAR_CAP` explicitly so the logged `cap` value
 * always reflects the bound actually applied.
 */
function truncateField(text: string, field: VerifierFieldName, logger: EventLogger, cap: number = VERIFIER_PAYLOAD_FIELD_CHAR_CAP): string {
  if (text.length <= cap) return text
  logger("verifier:field-truncated", { field, originalLength: text.length, cap })
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
 * Fires `verifier:field-partial-drop` when a scan removed SOME but not ALL of a
 * field's units — the field survives non-empty, but lost content. This is a
 * distinct fact from `verifier:field-dropped` (each field-scanning function
 * still logs that itself, exactly as before, when `kept.length === 0`):
 * before this, a field that lost one line out of three logged nothing at
 * all, so "the assistant never said this" and "it said this and the scan
 * silently removed it" were indistinguishable from the log alone (found by
 * review: a benign sentence like "I made sure no secrets leaked into the log
 * output." trips the pre-existing sensitive-label regex — see
 * `src/redaction.ts`'s `SENSITIVE_LABEL` — and vanished from a multi-line
 * `recentTranscript`/`criteria`/`verifierSummaries` field with zero trace).
 * Never fires when nothing was dropped, and never fires on a full empty
 * (that path is `verifier:field-dropped`'s alone, not duplicated here).
 */
function logPartialDrop(
  units: readonly string[],
  kept: readonly string[],
  anyDropped: boolean,
  field: VerifierFieldName,
  logger: EventLogger,
): void {
  // kept.length === 0 is unreachable here: every call site already returns
  // early on units.length > 0 && kept.length === 0 (the full-drop case,
  // logged as verifier:field-dropped instead) before reaching this call.
  if (!anyDropped) return
  logger("verifier:field-partial-drop", { field, kept: kept.length, dropped: units.length - kept.length })
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
  if (rawLength > VERIFIER_PAYLOAD_RAW_FIELD_SAFETY_CAP) {
    logger("verifier:field-oversized", { field, rawLength, cap: VERIFIER_PAYLOAD_RAW_FIELD_SAFETY_CAP })
    return undefined
  }
  const units = rawLines
  const { kept, anyDropped } = scanUnits(units)
  if (units.length > 0 && kept.length === 0) {
    logger("verifier:field-dropped", { field })
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
  if (rawDiff.length > VERIFIER_PAYLOAD_RAW_FIELD_SAFETY_CAP) {
    logger("verifier:field-oversized", { field: "diffSummary", rawLength: rawDiff.length, cap: VERIFIER_PAYLOAD_RAW_FIELD_SAFETY_CAP })
    return undefined
  }
  const hunks = splitDiffIntoHunks(rawDiff)
  const { kept, anyDropped } = scanUnits(hunks)
  if (hunks.length > 0 && kept.length === 0) {
    logger("verifier:field-dropped", { field: "diffSummary" })
    return undefined
  }
  logPartialDrop(hunks, kept, anyDropped, "diffSummary", logger)
  if (kept.length === 0) return undefined
  const truncated = truncateField(kept.join("\n"), "diffSummary", logger)
  return truncated.length === 0 ? undefined : truncated
}

/**
 * `docs/VERIFIER-PROMPT.md` §5: `lastResponse` and `recentTranscript` go
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
 * `RawVerifierPayload` and in `VerifierPayload`, so this takes a `string` in and
 * rejoins surviving lines with `\n` on the way out instead of returning the
 * array. `cap` is threaded through (not hardcoded) so the same function
 * serves `lastResponse` (`VERIFIER_PAYLOAD_FIELD_CHAR_CAP`), `recentTranscript`
 * (`VERIFIER_TRANSCRIPT_FIELD_CHAR_CAP`) and `plan`
 * (`VERIFIER_PLAN_FIELD_CHAR_CAP`, HANDOVER.md point 4).
 */
export function scanProseField(
  text: string,
  field: "lastResponse" | "recentTranscript" | "plan",
  logger: EventLogger,
  cap: number,
): string | undefined {
  if (text.length > VERIFIER_PAYLOAD_RAW_FIELD_SAFETY_CAP) {
    logger("verifier:field-oversized", { field, rawLength: text.length, cap: VERIFIER_PAYLOAD_RAW_FIELD_SAFETY_CAP })
    return undefined
  }
  const units = text.length === 0 ? [] : text.split("\n")
  const { kept, anyDropped } = scanUnits(units)
  if (units.length > 0 && kept.length === 0) {
    logger("verifier:field-dropped", { field })
    return undefined
  }
  logPartialDrop(units, kept, anyDropped, field, logger)
  if (kept.length === 0) return undefined
  const truncated = truncateField(kept.join("\n"), field, logger, cap)
  return truncated.length === 0 ? undefined : truncated
}

/**
 * FR-031 (extended by `docs/VERIFIER-PROMPT.md` §5): builds the verifier payload
 * from the five raw evidence fields.
 *
 * Each field is scanned in full first — the strict scan (secret patterns via
 * `redactSecrets`, plus a Shannon-entropy rule) runs on the *reassembled,
 * untruncated* field, per FR-031 / Dataset: Verifier payload hygiene — and only
 * the text that survives scanning is then truncated to the field's cap (C-9
 * fix: see `truncateField`'s doc comment for why the order matters — scanning
 * before truncating means a secret straddling the cap boundary is always
 * seen whole). A field emptied by scanning is omitted from the return value
 * and logs `verifier:field-dropped` once. The function only ever sees the five
 * typed fields the caller passes in — there
 * is no free-form chat-narrative parameter for it to leak, so schema
 * exclusion of narrative (Dataset row 2) is structural, not a runtime check;
 * `lastResponse`/`recentTranscript` are themselves prose from the
 * conversation, by §5's explicit design, but they are still just two bounded,
 * scanned, named fields — not an unbounded transcript dump.
 */
export function buildVerifierPayload(raw: RawVerifierPayload, logger: EventLogger): VerifierPayload {
  const payload: VerifierPayload = {}

  const criteria = scanLineField(raw.criteria, "criteria", logger)
  if (criteria) payload.criteria = criteria

  const verifierSummaries = scanLineField(raw.verifierSummaries, "verifierSummaries", logger)
  if (verifierSummaries) payload.verifierSummaries = verifierSummaries

  const diffSummary = scanDiffSummaryField(raw.diffSummary, logger)
  if (diffSummary !== undefined) payload.diffSummary = diffSummary

  const lastResponse = scanProseField(raw.lastResponse, "lastResponse", logger, VERIFIER_PAYLOAD_FIELD_CHAR_CAP)
  if (lastResponse !== undefined) payload.lastResponse = lastResponse

  const recentTranscript = scanProseField(raw.recentTranscript, "recentTranscript", logger, VERIFIER_TRANSCRIPT_FIELD_CHAR_CAP)
  if (recentTranscript !== undefined) payload.recentTranscript = recentTranscript

  const plan = scanProseField(raw.plan, "plan", logger, VERIFIER_PLAN_FIELD_CHAR_CAP)
  if (plan !== undefined) payload.plan = plan

  return payload
}

// ---------------------------------------------------------------------------
// runVerifier — FR-030, FR-030a, FR-030b, FR-032
// ---------------------------------------------------------------------------

/**
 * HANDOVER.md point 4 (user decision, 2026-07-29): one verdict per
 * acceptance item of a story. `note` says what the verifier observed or what
 * is specifically missing — the actionable detail the old prose
 * `fit/summary/gaps` shape could not carry per item.
 */
export interface VerifierItemVerdict {
  itemId: string
  met: boolean
  note: string
}

/** One entry per story the verifier was asked to audit. `pass` requires every
 * listed item `met === true` (enforced by `isVerifierVerdictShape`, not just
 * documented here). */
export interface VerifierStoryVerdict {
  storyId: string
  pass: boolean
  summary: string
  items: VerifierItemVerdict[]
}

/**
 * HANDOVER.md point 4, superseding the `{fit, summary, gaps}` shape (itself
 * a `docs/VERIFIER-PROMPT.md` §4 redesign of the original `{fit, notes}`):
 * structured per-story, per-acceptance-item feedback. The verifier is the sole
 * arbiter of completion (point 2), so its output must name exactly which
 * criteria are met and which are not — a one-sentence `summary` plus a
 * free-form gaps list was not machine-checkable enough to drive
 * continuations ("story S2 not delivered — A3, A4 still missing").
 */
export interface VerifierVerdict {
  stories: VerifierStoryVerdict[]
}

type ModelRef = { providerID: string; modelID: string }

/**
 * Deviation from `docs/vertex2-module-contracts.md` section 8: the contract
 * declares `runVerifier(...): Promise<VerifierVerdict | null>`. A bare `null`
 * cannot distinguish *why* no verdict is available, and the contract's own
 * prose punts on this ("your call... document it in your final report since
 * wave 3 wiring needs to know exactly what you return"). `runVerifier` here
 * returns this discriminated union instead: `{ verdict }` on success, or
 * `{ verdict: null, reason }` with `reason` one of:
 *  - `"unsupported"` — the FR-030b capability probe failed OR the combined
 *    probe + deny-map build did not settle within `VERIFIER_TOTAL_BUDGET_MS`
 *    (CRITICAL fix: a probe that cannot be confirmed in time is treated the
 *    same as one actively refused); zero `session.create`/`session.prompt`
 *    calls were made either way.
 *  - `"unavailable"` — the subturn itself failed (thrown error, timeout, or
 *    the deny map could not be (re)built after a successful probe, for a
 *    reason other than the shared budget expiring).
 *  - `"malformed"` — the subturn returned text that is not valid JSON, or
 *    valid JSON that does not match the `{stories: [...]}` verdict shape
 *    (`isVerifierVerdictShape`).
 * This lets wave-3 wiring log `verifier:unsupported` / `verifier:unavailable` /
 * `verifier:malformed` with the right label without re-deriving it from a
 * bare-null result. `runVerifier` also calls the injected `logger` itself for
 * these three event ids at the point each condition is detected (see the
 * "logging ambiguity" note in the final report) — this mirrors the pattern
 * `subturn.ts` already established for `subturn:cleanup-failed` (the module
 * that detects a condition logs it, rather than deferring to a caller that
 * would have to re-derive the same classification from the reason string).
 *
 * FR-014 (docs/VERIFIER-RELIABILITY-FIXES-SPEC.md, User Story 12) adds
 * `childSessionID`: the id of the subturn session the LAST attempt created,
 * so the gate can apply the tool-call floor — a `met:false` may not be
 * applied unless the verifier child session actually made >= 1 tool call. This
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
export type VerifierRunResult =
  | { verdict: VerifierVerdict; childSessionID?: string; observedToolCall?: boolean }
  | { verdict: null; reason: "unsupported" | "unavailable" | "malformed"; childSessionID?: string; observedToolCall?: boolean }

const VERIFIER_AGENT_NAME = "vertex-verifier"

/** FR-030: total budget shared across the capability probe + deny-map build
 * AND the subturn attempt(s) (override attempt, then its session-model
 * retry) — never a fresh budget per phase or per attempt (CRITICAL fix: the
 * clock now starts before the probe, not just before the subturn).
 *
 * Raised from the spec's literal 5000ms after live-host measurement: with
 * the probe passing, a real verifier subturn against a hosted model
 * (openrouter/z-ai/glm-5.2) consumed the ENTIRE 5s budget on the model
 * round-trip alone and logged `verifier:unavailable {reason:"timeout"}` every
 * time — i.e. the spec's budget made the verifier unreachable in practice, not
 * merely tight. 5s is a plausible bound for a local/cached model and an
 * impossible one for a remote frontier model.
 *
 * `VERTEX_VERIFIER_BUDGET_MS` overrides it (values <= 0 or unparseable fall
 * back to the default) so an operator on a slow provider can raise it
 * further, or drive it back down to the spec's 5000 to reproduce FR-030's
 * literal behaviour. The verifier remains advisory and non-gating, so the cost
 * of a longer budget is bounded latency on an already-idle session, never a
 * blocked turn.
 *
 * The 90s default is set from measurement, not taste. Two full successful
 * verifier runs (probe + child session create + model round-trip + delete)
 * against openrouter/z-ai/glm-5.2 measured **28.8s and 45.6s** — a ~1.6x
 * spread between back-to-back runs of an identical payload, i.e. provider
 * latency here is highly variable rather than tightly clustered. Budgets
 * near the observed cost are therefore actively harmful: they convert that
 * variance into intermittent `verifier:unavailable` timeouts that are
 * indistinguishable from a broken feature (a 30s budget would have passed
 * the first run and failed the second). 90s is ~2x the slowest observation.
 *
 * The 90s figure above was calibrated for the ZERO-TOOL verifier (a single
 * model round-trip). HANDOVER.md point 3 makes the verifier tool-using: it now
 * re-runs a story's declared verifier commands itself over multiple steps
 * (maxSteps 12), and in the field session that motivated the redesign the
 * equivalent verifier runs (`make check`, targeted re-tests) took MINUTES,
 * not seconds — a 90s budget would convert the redesign's core capability
 * into a guaranteed `verifier:unavailable` timeout. The default is therefore
 * raised to 300s.
 *
 * Erring generous is the right asymmetry here: the verifier runs at idle and
 * remains fail-open (a timeout degrades to "no verdict", never a blocked
 * turn), so an over-long budget costs only latency on an already-idle
 * session, while an over-short one silently removes the feature. */
const DEFAULT_VERIFIER_TOTAL_BUDGET_MS = 300_000

function resolveVerifierBudgetMs(): number {
  const raw = Number(process.env.VERTEX_VERIFIER_BUDGET_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_VERIFIER_TOTAL_BUDGET_MS
}

export const VERIFIER_TOTAL_BUDGET_MS = resolveVerifierBudgetMs()

/**
 * HANDOVER.md points 2-4 (user decision, 2026-07-29), superseding the
 * `docs/VERIFIER-PROMPT.md` §4/§5 prompt: the verifier is now an independent
 * completion AUDITOR with read-only tools, not a zero-tool evidence
 * summarizer. Three load-bearing instructions, each tied to a field-session
 * failure:
 *  - verify, don't trust (points 2/3): the 894-message session's claims
 *    were real but the harness credited none of them; the verifier must read
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
 * FR-011 (docs/VERIFIER-RELIABILITY-FIXES-SPEC.md, User Story 9 — P0, the
 * primary root-cause fix) adds a fourth: **observation is required in the
 * NEGATIVE direction too**. The prompt above said only "Read the files a
 * claim references before crediting it" — an obligation attached to
 * `met:true` and nothing else, leaving the far more damaging direction
 * completely unconstrained. The live probe isolated exactly that gap: given
 * only the payload, `runVerifier` returned `pass:false` in **9.8 s** with the
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
 * the verifier cannot observe it must SAY so in the note rather than assert
 * absence. Without the second sentence, a verifier that cannot run a tool has
 * no compliant way to express doubt and will reach for the fabrication
 * again.
 *
 * B-3b (operator ruling, 2026-08-06) adds the criteria the prompt never
 * actually stated. "The judge should not go by exit codes — they are
 * information, but not a real criterion for the judge. The judge needs simply
 * to judge if the goal was achieved, all stories delivered, and generally
 * validated." Before this, the only criterion-shaped sentence in the whole
 * prompt was the re-run-your-verifiers instruction, framed entirely around
 * making an EXIT CODE reliable — so the one thing the judge was told to
 * optimise for was the shell result, and the three things it is actually for
 * (goal, delivery, does it hold up) were never named. Exit codes stay in the
 * payload and stay citable; they stop being the test. The deterministic half
 * of this ruling lives in `wiring/gate.ts` (`verdictIsSubstantiated`): a
 * failure must name a DECLARED acceptance item, and a pass must have judged
 * every one of them — so neither a red command nor a green one can carry a
 * verdict on its own.
 */
const VERIFIER_SYSTEM_PROMPT = [
  "You are an independent completion auditor for a coding plan whose stories have been claimed complete.",
  "You receive a plan digest (stories, their acceptance items, and the verifier commands each story declares), a diff summary, verifier output summaries, and the parent agent's last response plus a short recent transcript, as a JSON object.",
  "THE SESSION TRANSCRIPT IS YOUR LEADING EVIDENCE. It is the record of what was actually asked, decided and done, and you are expected to reason from it — with common sense — rather than treat it as hearsay. Your tools (read, grep, glob, list, bash) are there to CHECK what the transcript leaves doubtful, not to replace reading it.",
  "A verdict reached by reading the evidence carefully is a valid verdict. You are not required to run a command to be believed; you are required to say WHICH acceptance item failed and WHY, in that item's note. An unexplained failure will be discarded.",
  "YOUR CRITERIA ARE THESE THREE AND NOTHING ELSE: was the GOAL of the plan achieved; is EVERY story delivered against the acceptance items it declares; and does that delivery HOLD UP UNDER SCRUTINY rather than merely appear to.",
  "Exit codes, command results and verifier summaries are EVIDENCE you may cite — they are never the test. A failing command does not by itself make an acceptance item unmet: name the acceptance item that is not delivered and say what is missing. A passing command does not by itself make an acceptance item met: an item is met when what it asks for is actually there, which a green suite can be entirely silent about.",
  "Judge every acceptance item of every story you were asked to audit, using that item's own id from the plan digest. A verdict that skips acceptance items, or that fails a story on something the story does not declare, is not a verdict on that story and will be discarded.",
  "Read the files a claim references before crediting it.",
  'The same rule binds in the opposite direction and binds harder: you must not report an item as "met": false on the grounds that a file or directory is missing, empty, or lacks some content unless you have just observed that yourself in this session with read, glob, grep or bash.',
  "The payload is never evidence that something is absent — only that it was not quoted to you.",
  'If you cannot make that observation, say exactly that in the item\'s note (for example "could not verify: no observation of research/x.json") instead of claiming the file or its content does not exist.',
  'Where a story declares verifiers, re-run them with bash when that is feasible within your budget: run each verifier as a standalone command, never chained with ";" and never piped, so its exit code is reliable — then read the output and judge what it actually tells you about the acceptance items. The result informs your verdict; it does not decide it.',
  "You must not modify anything: you have no write or edit capability, and bash is for running verifiers and read-only inspection only.",
  'Respond with exactly one JSON object and nothing else, matching this shape: {"stories": [{"storyId": "S1", "pass": true|false, "summary": "...", "items": [{"itemId": "A1", "met": true|false, "note": "..."}]}]}.',
  "Emit one story entry per story you were asked to audit, and one item entry per acceptance item of that story.",
  "An item's note says what you observed or what is missing. A story's pass is true only when every one of its items is met.",
  "Do not ask questions and do not output anything other than the JSON object.",
].join(" ")

/**
 * Parse the verifier's reply, tolerating the wrappers models actually emit.
 *
 * `JSON.parse(text)` alone rejected a real verifier run in UAT G12 with
 * `verifier:malformed {reason:"response is not valid JSON"}` -- the plan had
 * completed, the subturn had run, and the whole thing was discarded because the
 * model fenced its JSON. A zero-tool agent is instructed to return JSON and
 * usually does, but "usually" is not a contract: markdown fences and a leading
 * sentence are the two most common deviations, and each costs a full verifier
 * budget (up to 90s and a model call) for nothing.
 *
 * Deliberately narrow: strip fences, then take the outermost balanced object.
 * No repair of malformed JSON, no regex extraction of individual fields --
 * shape validation still happens in `isVerifierVerdictShape`, and a reply that is
 * genuinely not a verdict must still be reported as malformed rather than
 * guessed at.
 *
 * Returns `undefined` for "could not parse", which is distinguishable from a
 * successfully parsed `null`.
 */
export function parseVerifierResponse(text: string): unknown {
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

function isVerifierItemVerdictShape(value: unknown): value is VerifierItemVerdict {
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
 *  - `stories` must be a NON-EMPTY array — the verifier is the sole arbiter of
 *    completion (point 2), so an empty audit is never a valid verdict.
 *  - every story needs a non-blank `storyId`, a boolean `pass`, a string
 *    `summary`, and an `items` array of `{itemId (non-blank), met
 *    (boolean), note (string)}` — a wrong per-item shape is rejected, not
 *    coerced, exactly as the old `isVerifierGapShape` rule worked.
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
function isVerifierVerdictShape(value: unknown): value is VerifierVerdict {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  if (!Array.isArray(v.stories) || v.stories.length === 0) return false
  for (const story of v.stories) {
    if (typeof story !== "object" || story === null) return false
    const s = story as Record<string, unknown>
    if (typeof s.storyId !== "string" || s.storyId.trim().length === 0) return false
    if (typeof s.pass !== "boolean") return false
    if (typeof s.summary !== "string") return false
    if (!Array.isArray(s.items) || !s.items.every(isVerifierItemVerdictShape)) return false
    if (s.pass === true && !(s.items as VerifierItemVerdict[]).every((item) => item.met === true)) return false
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
 * verifier's own child sessions — breaking FR-036 (all five hooks must return
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
 * FR-030/FR-030a/FR-030b/FR-032: runs the verifier subturn.
 *
 * 0. CRITICAL fix: the `VERIFIER_TOTAL_BUDGET_MS` budget clock (`start`) now
 *    starts BEFORE step 1, not after it. Previously `probeCapability` and
 *    `buildDenyMap` were plain un-timed `await`s taken before `start` was
 *    read, so a hanging `client.app.agents()`/`client.tool.ids()` could
 *    block this function indefinitely — violating FR-030's literal
 *    "`Promise.race` 5s total including the retry." The probe + deny-map
 *    build now count against the same 5s total as the subturn attempt(s).
 * 1. Runs `subturn.ts`'s `probeCapabilityBounded` (probe, then tool-map
 *    build, raced together against the remaining budget) WITH
 *    `VERIFIER_PROBE_POLICY` (HANDOVER.md point 3): the probe verifies the
 *    registered verifier agent has no capability beyond read/grep/glob/list/
 *    bash (with edit/write/webfetch/task provably denied), and the
 *    resulting allow-aware map from `buildToolPolicyMap` — not a pure deny
 *    map — is what the subturn's `tools` field receives. A failure returns
 *    immediately with zero `session.create`/`session.prompt` calls
 *    (`runSubturn` is never reached). A probe failure OR a timeout both log
 *    `verifier:unsupported` once (a probe that cannot be confirmed in time is
 *    treated identically to one actively refused); a tool-map-build failure
 *    (non-timeout) logs `verifier:unavailable`, unchanged from before this fix.
 *    This module does not receive a pre-cached tool map from the caller
 *    (the contracted signature has no slot for one) — it re-derives it on
 *    every call. See the "deny map caching" note in the final report for
 *    the trade-off this implies.
 * 2. Model = `verifierModelOverride ?? sessionModel` for the first attempt. If
 *    `verifierModelOverride` was set and that attempt's subturn fails (thrown,
 *    timed out, or otherwise `{ok: false}`), retries once with
 *    `sessionModel`. Every attempt draws from the SAME `VERIFIER_TOTAL_BUDGET_MS`
 *    clock started in step 0 — each attempt's `timeoutMs` is whatever is
 *    left of the total, not a fresh budget per attempt.
 * 3. A successful subturn's response text is parsed as JSON and checked
 *    against the `{stories: [...]}` shape (`isVerifierVerdictShape`, HANDOVER.md
 *    point 4); anything else — including BOTH superseded shapes
 *    (`{fit, summary, gaps}` and `{fit, notes}`) — is `"malformed"`, not
 *    thrown.
 * 4. FR-014: every result — success or failure — carries the id of the child
 *    session the last attempt created (`childSessionID`), so the gate can
 *    apply the tool-call floor. See `observeChildSessionID` for why it is
 *    captured by observing the recorder rather than by changing
 *    `runSubturn`'s return type.
 */
export async function runVerifier(
  client: OpencodeClient,
  deps: { selfCreated: SelfCreatedSessions; logger: EventLogger },
  opts: {
    parentSessionID: string
    sessionModel: ModelRef
    verifierModelOverride?: ModelRef
    payload: VerifierPayload
  },
): Promise<VerifierRunResult> {
  const { selfCreated, logger } = deps
  const { parentSessionID, sessionModel, verifierModelOverride, payload } = opts

  const observed: { childSessionID?: string } = {}
  const recordingSelfCreated = observeChildSessionID(selfCreated, observed)

  const start = Date.now()

  const probeResult = await probeCapabilityBounded(client, VERIFIER_AGENT_NAME, VERIFIER_TOTAL_BUDGET_MS, VERIFIER_PROBE_POLICY)
  if (!probeResult.ok) {
    if (probeResult.cause === "deny-map") {
      logger("verifier:unavailable", { reason: `tool policy map unavailable: ${probeResult.reason}` })
      return { verdict: null, reason: "unavailable" }
    }
    // cause is "probe" or "timeout" — both fold to "unsupported" (fix #1:
    // a probe/tool-map timeout is treated the same as an ordinary probe
    // refusal, matching the existing verifier:unsupported log path).
    logger("verifier:unsupported", { reason: probeResult.reason })
    return { verdict: null, reason: "unsupported" }
  }
  const toolsMap = probeResult.tools

  const attempts: ModelRef[] = verifierModelOverride ? [verifierModelOverride, sessionModel] : [sessionModel]
  const parts = [{ type: "text" as const, text: JSON.stringify(payload) }]

  // NOTE: must carry `observedToolCall` (FR-014) — a narrower type here
  // silently strips the flag `runSubturn` captured before deleting the child.
  let last: SubturnResult | null = null

  for (const model of attempts) {
    const remaining = VERIFIER_TOTAL_BUDGET_MS - (Date.now() - start)
    if (remaining <= 0) {
      last = { ok: false, reason: "timeout" }
      break
    }
    last = await runSubturn(client, recordingSelfCreated, logger, {
      parentSessionID,
      agent: VERIFIER_AGENT_NAME,
      model,
      system: VERIFIER_SYSTEM_PROMPT,
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
  // FR-014 (code review MAJ-004): `runSubturn` reads the tool-call fact BEFORE
  // it deletes the child session, so the flag rides on the subturn result. Same
  // absent-vs-undefined discipline as `child` above: "we could not tell" must
  // stay an ABSENT key so the gate fails open on it.
  const toolCall = last?.observedToolCall === undefined ? {} : { observedToolCall: last.observedToolCall }

  if (!last || !last.ok) {
    logger("verifier:unavailable", { reason: last?.reason ?? "unknown" })
    return { verdict: null, reason: "unavailable", ...child, ...toolCall }
  }

  const parsed = parseVerifierResponse(last.text)
  if (parsed === undefined) {
    logger("verifier:malformed", { reason: "response is not valid JSON" })
    return { verdict: null, reason: "malformed", ...child, ...toolCall }
  }

  if (!isVerifierVerdictShape(parsed)) {
    logger("verifier:malformed", { reason: "response does not match {stories: [{storyId, pass, summary, items}]} shape" })
    return { verdict: null, reason: "malformed", ...child, ...toolCall }
  }

  return { verdict: parsed, ...child, ...toolCall }
}
