/** FR-028/FR-029 — model-conditioned dosing.
 *
 * Resolves a coarse "profile" (`standard` | `frontier`) from a model id via
 * suffix-tolerant matching, and looks up how hard a directive family should
 * be dosed under that profile per the FR-029 5x2 matrix.
 *
 * Pure/injectable: no logging, no disk, no process env reads. The caller
 * (wave-3 wiring) is responsible for reading the model id off
 * `experimental.chat.system.transform` (preferred) / `chat.message`
 * (fallback), calling `resolveProfile` once per session init, stamping the
 * resolved profile on every subsequent event, and logging
 * `dosing:unknown-model` with the raw id when `unknown` is true.
 */

export type Profile = "standard" | "frontier"

export interface DosingResolution {
  profile: Profile
  unknown: boolean
  rawModelId: string | null
}

/**
 * Built-in profile table, from the spec's worked examples (Dosing outline,
 * Dataset: Dosing profiles rows 1-3). Keys are the canonical "providerID/modelID"
 * suffix that a caller-supplied model id is matched against.
 */
const BUILTIN_PROFILE_TABLE: Readonly<Record<string, Profile>> = {
  "anthropic/claude-fable-5": "frontier",
  "minimax/MiniMax-M3": "standard",
}

/**
 * Suffix-tolerant match: `modelId` resolves via `key` when `modelId` is
 * exactly `key` or ends with `/` + `key` (e.g. `openrouter/anthropic/claude-fable-5`
 * matches key `anthropic/claude-fable-5`). Case-sensitive — model ids
 * (especially `MiniMax-M3`) are not reliably case-normalized across
 * providers, and the spec's worked examples preserve casing verbatim.
 */
function matchesKey(modelId: string, key: string): boolean {
  return modelId === key || modelId.endsWith("/" + key)
}

function lookupProfile(
  modelId: string,
  table: Readonly<Record<string, Profile>>,
): Profile | null {
  for (const key of Object.keys(table)) {
    if (matchesKey(modelId, key)) return table[key]
  }
  return null
}

/**
 * Resolve a model id to a dosing profile.
 *
 * Suffix-tolerant match over a small built-in table plus an optional
 * caller-supplied override table (checked first, so callers can repoint a
 * built-in entry or add new ones without editing this module). Unmapped or
 * null model id falls back to `standard` with `unknown: true`.
 */
export function resolveProfile(
  modelId: string | null,
  overrideTable?: Record<string, Profile>,
): DosingResolution {
  if (modelId === null) {
    return { profile: "standard", unknown: true, rawModelId: null }
  }

  const overrideMatch = overrideTable ? lookupProfile(modelId, overrideTable) : null
  if (overrideMatch !== null) {
    return { profile: overrideMatch, unknown: false, rawModelId: modelId }
  }

  const builtinMatch = lookupProfile(modelId, BUILTIN_PROFILE_TABLE)
  if (builtinMatch !== null) {
    return { profile: builtinMatch, unknown: false, rawModelId: modelId }
  }

  return { profile: "standard", unknown: true, rawModelId: modelId }
}

export type DirectiveFamily =
  | "phase-procedure"
  | "verification-prescription"
  | "falsification"
  | "anomaly-interrupt"
  | "elevate"

export type Dose =
  | "full"
  | "nudge-after-compliance"
  | "on-relevance-gap"
  | "on-new-tests-only"
  | "rubric-and-taste-only"

/**
 * FR-029's 5x2 matrix, exact cells from the spec table:
 *
 * | Directive family              | standard                   | frontier                            |
 * |--------------------------------|-----------------------------|--------------------------------------|
 * | Phase procedure                | full scaffold, every task   | one-line nudge after first compliance|
 * | Verification prescription      | always, exact resolved cmd  | only on a relevance gap              |
 * | Falsification / pre-commitment | on turns introducing new tests | every execute-entry turn (primary lever, i.e. full) |
 * | Anomaly interrupt              | full                         | full (floor — never reduced)         |
 * | Elevate                        | full checklist               | rubric + taste pass only             |
 *
 * Families not in this table (e.g. scope-watchdog, plan-proposal) are not
 * governed by FR-029 and always dose "full" under both profiles — the
 * explicit floor from the module contract.
 */
const DOSE_MATRIX: Readonly<Record<DirectiveFamily, Readonly<Record<Profile, Dose>>>> = {
  "phase-procedure": {
    standard: "full",
    frontier: "nudge-after-compliance",
  },
  "verification-prescription": {
    standard: "full",
    frontier: "on-relevance-gap",
  },
  falsification: {
    standard: "on-new-tests-only",
    // "every execute-entry turn" is the primary lever under frontier — i.e.
    // never suppressed, the strongest dose available. Modeled as "full" so
    // the FR-029 floor ("frontier MUST NOT reduce falsification below full")
    // is structurally satisfied rather than merely asserted.
    frontier: "full",
  },
  "anomaly-interrupt": {
    standard: "full",
    frontier: "full",
  },
  elevate: {
    standard: "full",
    frontier: "rubric-and-taste-only",
  },
}

/**
 * Look up the dose for a directive family under a profile.
 *
 * Families outside the FR-029 matrix (any string not in `DirectiveFamily`)
 * always dose "full" regardless of profile — the explicit floor from the
 * module contract ("other composer families ... are NOT in the FR-029
 * matrix -> dose 'full' under both profiles unconditionally").
 */
export function doseFor(family: DirectiveFamily | string, profile: Profile): Dose {
  const row = (DOSE_MATRIX as Record<string, Readonly<Record<Profile, Dose>> | undefined>)[family]
  if (!row) return "full"
  return row[profile]
}
