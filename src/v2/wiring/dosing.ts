/**
 * Wave-3 wiring — applies `dosing.ts`'s FR-029 matrix to a candidate
 * `Finding` before it reaches the composer.
 *
 * `dosing.doseFor` operates on the five `DirectiveFamily` keys named in the
 * FR-029 table; wiring's own `Finding.family` strings are more granular
 * (`"intake-scaffold"` / `"plan-proposal"` both fall under "phase
 * procedure", etc.) — `DOSING_FAMILY_MAP` bridges the two. Families with no
 * entry are not governed by FR-029 and pass through unchanged (the explicit
 * "full" floor for unlisted families).
 *
 * Judgment calls (documented, not silently assumed — the spec states each
 * dose's *intent* but not a mechanical algorithm for several of them):
 *   - `nudge-after-compliance`: "suppressed after the first observed
 *     compliance" is read as PERSISTENT for the rest of the session (once
 *     `state.compliedFamiliesEver` has the family, the finding is dropped
 *     entirely), not just decayed for one turn the way `composer.ts`'s own
 *     per-turn decay works — the two mechanisms are complementary, not
 *     duplicated: composer's decay handles the standard-profile "one-line
 *     reminder after compliance" case; this suppression is frontier-only and
 *     stronger. BEFORE the first compliance, the finding is reduced to a
 *     one-line nudge (US-8 AS2: "the scaffold is suppressed to a one-line
 *     nudge"), not returned as the full O-D-P-E object unmodified (MAJOR
 *     fix, post-review — the prior code returned `finding` verbatim
 *     pre-compliance, making frontier byte-identical to standard until the
 *     very first compliance). The reduced form mirrors `composer.ts`'s own
 *     decay-form convention as closely as this module's `Finding` shape
 *     allows: `renderDecayForm` (private to `composer.ts`, not exported) is
 *     just the `prescription` text, collapsed to one line, with no
 *     Observation/Diagnosis/Example slots — `toOneLineNudge` below
 *     reimplements that exact collapsing transform (same pattern
 *     `story.ts` already uses for a different private helper it can't
 *     import — see that file's `FENCE_DELIMITER_RE` comment), and
 *     `observation`/`diagnosis`/`example` are cleared rather than merely
 *     shortened so the *content* is reduced to one meaningful line even
 *     though `composer.ts`'s `renderFullForm` (which is what wiring's
 *     current `composer.render` call site invokes, since it always passes
 *     `priorCompliance: () => false` — a `plugin.ts` concern, not this
 *     module's, noted in the final report) still prints an `Observed:` /
 *     `Diagnosis:` label per finding regardless of whether the field text is
 *     empty.
 *   - `on-relevance-gap`: approximated as "at least one verification has
 *     already succeeded this turn, yet unresolved changes remain" (i.e. a
 *     verifier ran and something changed after it) rather than a precise
 *     path-coverage diff, since neither `EvidenceLedger` nor `resolve.ts`
 *     expose which specific paths a past verification covered.
 *   - `on-new-tests-only`: approximated as "a changed path this turn looks
 *     like a test file" (basename convention / `tests?/` directory).
 *   - `rubric-and-taste-only`: the elevate finding's O-D-P text is replaced
 *     with a short rubric-plus-taste-pass instruction, dropping the full
 *     per-criterion replay (which is what "full checklist" vs "rubric only"
 *     distinguishes per the FR-029 table's own wording).
 */
import type { Finding } from "../composer.js"
import { doseFor, type DirectiveFamily, type Profile } from "../dosing.js"
import type { V2SessionState } from "./state.js"

const DOSING_FAMILY_MAP: Record<string, DirectiveFamily> = {
  "intake-scaffold": "phase-procedure",
  "plan-proposal": "phase-procedure",
  "verify-gap": "verification-prescription",
  "pre-commitment": "falsification",
  "anomaly-interrupt": "anomaly-interrupt",
  elevate: "elevate",
}

/** Mirrors `composer.ts`'s own (private, unexported) `renderDecayForm`: the
 * prescription text alone, trimmed and collapsed to a single line — no
 * Observation/Diagnosis/Example content. Reimplemented locally rather than
 * imported since it is not part of `composer.ts`'s exported surface (same
 * pattern `story.ts` already follows for its own copy of a different
 * private helper it can't import; see that file's `FENCE_DELIMITER_RE`
 * comment). */
function toOneLineNudge(text: string): string {
  return text.trim().replace(/\s*\r?\n\s*/g, " ")
}

export function applyDosing(finding: Finding, profile: Profile, state: V2SessionState): Finding | null {
  const mapped = DOSING_FAMILY_MAP[finding.family]
  if (!mapped) return finding

  const dose = doseFor(mapped, profile)
  switch (dose) {
    case "full":
      return finding
    case "nudge-after-compliance": {
      // Persistent post-compliance suppression (unchanged, correct per
      // spec: "suppressed after the first observed compliance").
      if (state.compliedFamiliesEver.has(finding.family)) return null
      // MAJOR fix, post-review: pre-compliance, reduce the finding to a
      // one-line nudge instead of returning the full O-D-P-E object
      // unmodified (US-8 AS2). `observation`/`diagnosis`/`example` are
      // cleared (not just shortened) and `prescription` is collapsed to one
      // line via `toOneLineNudge`, mirroring `composer.ts`'s own decay-form
      // convention/shape as closely as this module can without editing
      // `composer.ts` (see the module doc comment's judgment-call note on
      // why `renderFullForm`'s `Observed:`/`Diagnosis:` labels still print
      // for now — that is `plugin.ts`'s / `composer.ts`'s call site, out of
      // this module's scope).
      return {
        ...finding,
        observation: "",
        diagnosis: "",
        prescription: toOneLineNudge(finding.prescription),
        example: undefined,
      }
    }
    case "on-relevance-gap":
      return state.everVerifiedThisTurn ? finding : null
    case "on-new-tests-only":
      return state.turnIntroducedNewTestFile ? finding : null
    case "rubric-and-taste-only":
      return {
        ...finding,
        observation: "Deep task's bound verifier passed.",
        diagnosis: "Frontier profile: elevate is dosed to a rubric-and-taste pass, not the full checklist.",
        prescription:
          "Run a rubric check of the diff against the pinned criteria, then a taste pass from a reviewer's stance.",
      }
    default:
      return finding
  }
}
