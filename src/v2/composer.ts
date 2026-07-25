/** FR-003 through FR-007 — the injection composer ("guide" layer).
 *
 * Renders detector findings into O(bservation)-D(iagnosis)-P(rescription)-
 * E(xample) directives, subject to:
 *   - a budget of 2 rendered directives per `render()` call (== one
 *     `experimental.chat.system.transform` invocation) — FR-004
 *   - a per-family per-turn cap (FR-004 table / `DEFAULT_FAMILY_CAPS`)
 *   - a per-family cooldown expressed in turns (FR-005)
 *   - decay to a one-line reminder after observed compliance (FR-006)
 *   - `redactSecrets` on all rendered text before it is returned (FR-007)
 *
 * Ordering matters and is deliberate (see `render()`): per-turn cap is
 * enforced first (a family that already spent its cap this turn is excluded
 * before the budget trim ever runs), then cooldown, then the findings that
 * survive both are sorted by priority and trimmed to the per-invocation
 * budget. This is what makes the anomaly interrupt survive a turn whose
 * first invocation spent its 2 slots on corrections (BDD "Anomaly interrupt
 * survives a turn whose budget went to corrections"): the anomaly family's
 * per-turn cap is untouched by an earlier invocation rendering *other*
 * families, so it remains eligible in a later invocation of the same turn.
 *
 * The turn index is caller-driven via `newTurn()` — it is NOT wall clock and
 * NOT an invocation counter. One `newTurn()` call corresponds to one
 * `chat.message` (a new user message); many `render()` calls (many
 * `system.transform` invocations) can share the same turn index.
 *
 * Findings dropped for budget/cap/cooldown reasons are logged and reported
 * in `RenderResult.dropped`, but never retained internally — the caller
 * (wiring) must re-detect and re-pass a finding on a later invocation if it
 * is still true. This module does not queue anything across `render()`
 * calls.
 */

import { formatDirectives, type Directive } from "../index.js"
import { redactSecrets } from "../redaction.js"
import type { EventLogger } from "./types.js"

// ===========================================================================
// PUBLIC TYPES
// ===========================================================================

/** Rendering priority. Corrections outrank phase guidance, which outranks
 * enrichment, both when trimming to the per-invocation budget and — via the
 * FR-004 table below — when assigning per-turn caps. */
export type Priority = "correction" | "phase-guidance" | "enrichment"

export interface Finding {
  /** Matches an FR-004 cap-table key when applicable (see `DEFAULT_FAMILY_CAPS`).
   * Families outside the table are uncapped per-turn by default (see
   * `DEFAULT_FAMILY_CAPS` doc comment) and default to `cooldownTurns: 1`. */
  family: string
  priority: Priority
  /** Real observed state — actual paths/commands, not a template. */
  observation: string
  /** Failure-mode taxonomy classification (FR-003). */
  diagnosis: string
  /** Runnable command / concrete next step. */
  prescription: string
  example?: string
  /** Caller-generated, unique per finding instance (FR-034 compliance join). */
  instanceId: string
}

export interface RenderResult {
  /** `null` when nothing was injected this invocation (Dataset row 6: "empty -> silence"). */
  text: string | null
  renderedFamilies: string[]
  dropped: Array<{ family: string; reason: "budget" | "per-turn-cap" | "cooldown" }>
}

/**
 * FR-004's per-family per-turn cap table. Used as the composer's cap table
 * whenever the caller does not supply its own `familyCaps` — passing a
 * `familyCaps` table replaces this default wholesale (see `InjectionComposer`
 * constructor doc), it is not merged with it. Families absent from whichever
 * table is in effect are uncapped per turn (only the per-invocation budget
 * and cooldown still apply to them) — the spec defines a default only for
 * `cooldownTurns` (1), not for the cap, so an unlisted family is treated as
 * "no additional per-turn ceiling beyond the invocation budget itself".
 *
 * `repeat-failure` is capped once here, but its real cap is "1 per failure
 * signature" (FR-004) — the caller achieves that by minting a distinct
 * family string per signature (e.g. `repeat-failure:<signature>`); this
 * module treats `family` as an opaque string and has no signature concept of
 * its own.
 */
export const DEFAULT_FAMILY_CAPS: Record<string, number> = {
  "intake-scaffold": 1, "plan-proposal": 1, "pre-commitment": 1,
  "scope-watchdog": 1, "anomaly-interrupt": 1, "repeat-failure": 1 /* per signature, caller keys the family string per-signature */,
  "verify-gap": 3, "elevate": 1, "pinned-criteria-reinject": 1,
}

// ===========================================================================
// INTERNALS
// ===========================================================================

/** Directives rendered per `render()` call, before priority trimming. */
const INVOCATION_BUDGET = 2

const PRIORITY_RANK: Record<Priority, number> = {
  correction: 0,
  "phase-guidance": 1,
  enrichment: 2,
}

interface SessionState {
  /** Monotonic turn index for this session. 0 until the first `newTurn()`. */
  turnIndex: number
  /** family -> count of directives rendered so far THIS turn (reset on `newTurn()`). */
  turnSpend: Map<string, number>
  /** family -> turn index at which it was last rendered (never reset — cooldown spans turns). */
  lastRenderedTurn: Map<string, number>
  /** family -> turn index at which `recordCompliance` was last called for it. */
  complianceTurn: Map<string, number>
}

function renderFullForm(f: Finding): string {
  const lines = [`Observed: ${f.observation}`, `Diagnosis: ${f.diagnosis}`, `Do now: ${f.prescription}`]
  if (f.example) lines.push(`Example: ${f.example}`)
  return lines.join("\n")
}

/** FR-006 decay form: a single line containing the prescribed command only —
 * no Observation/Diagnosis/Example slots. Internal newlines in the
 * prescription (not expected in practice) are collapsed so the invariant
 * ("single line") holds regardless of finding content. */
function renderDecayForm(f: Finding): string {
  return f.prescription.trim().replace(/\s*\r?\n\s*/g, " ")
}

// ===========================================================================
// COMPOSER
// ===========================================================================

export class InjectionComposer {
  private readonly logger: EventLogger
  private readonly familyCaps: Record<string, number>
  private readonly cooldowns: Record<string, number>
  private readonly sessions = new Map<string, SessionState>()

  constructor(opts: {
    logger: EventLogger
    /** Per-family per-turn cap table — defaults to `DEFAULT_FAMILY_CAPS` when
     * omitted. Passing a table replaces the default wholesale (not merged):
     * a family absent from a caller-supplied table is uncapped per turn,
     * exactly as one absent from `DEFAULT_FAMILY_CAPS` would be. */
    familyCaps?: Record<string, number>
    /** Per-family `cooldownTurns` — unlike `familyCaps`, this defaults
     * per-family: any family not present in the supplied (or omitted) table
     * gets `cooldownTurns: 1`, per FR-005's explicit default. */
    cooldowns?: Record<string, number>
  }) {
    this.logger = opts.logger
    this.familyCaps = opts.familyCaps ?? DEFAULT_FAMILY_CAPS
    this.cooldowns = opts.cooldowns ?? {}
  }

  private getState(sessionID: string): SessionState {
    let state = this.sessions.get(sessionID)
    if (!state) {
      state = { turnIndex: 0, turnSpend: new Map(), lastRenderedTurn: new Map(), complianceTurn: new Map() }
      this.sessions.set(sessionID, state)
    }
    return state
  }

  private capFor(family: string): number {
    const cap = this.familyCaps[family]
    return cap === undefined ? Infinity : cap
  }

  private cooldownFor(family: string): number {
    const cd = this.cooldowns[family]
    return cd === undefined ? 1 : cd
  }

  /** Call once per `chat.message` (new user message). Increments the
   * session's turn index and resets THIS turn's per-family spend counters
   * (per-turn caps are scoped to the new turn; cooldowns are not reset here
   * — they are evaluated against the running turn index so they can span
   * turn boundaries per `cooldownTurns`). */
  newTurn(sessionID: string): void {
    const state = this.getState(sessionID)
    state.turnIndex += 1
    state.turnSpend.clear()
  }

  /** Called by wiring when FR-034 detects a compliance match. Feeds the next
   * `render()`'s decay decision for that family: a compliance recorded at
   * turn T decays rendering of that family at turn T+1 (FR-006 — "after a
   * logged compliance ... in the previous turn"), independent of whatever
   * `opts.priorCompliance` the caller separately passes to `render()` (the
   * two signals are OR'd — either is sufficient to trigger decay). */
  recordCompliance(sessionID: string, family: string, instanceId: string): void {
    const state = this.getState(sessionID)
    state.complianceTurn.set(family, state.turnIndex)
    this.logger("directive_complied", { sessionID, family, instanceId, turnIndex: state.turnIndex })
  }

  private wasCompliantLastTurn(state: SessionState, family: string): boolean {
    const turn = state.complianceTurn.get(family)
    return turn !== undefined && turn === state.turnIndex - 1
  }

  /**
   * One call = one `experimental.chat.system.transform` invocation.
   *
   * Pipeline (order is load-bearing — see module doc comment):
   *   1. Drop findings whose family already spent its per-turn cap this turn.
   *   2. Drop findings whose family is within its `cooldownTurns` window.
   *   3. Sort survivors by priority (correction > phase-guidance > enrichment)
   *      and keep at most `INVOCATION_BUDGET` (2); drop the rest.
   *   4. For each kept finding, decay to the one-line form when
   *      `opts.priorCompliance(family)` is true or a compliance was recorded
   *      for that family last turn; otherwise render the full O-D-P-E form.
   *   5. Pass the assembled envelope through `redactSecrets`.
   *
   * Every drop is logged (`budget:dropped` / `per-turn-cap:dropped` /
   * `cooldown:dropped`) and reported in `RenderResult.dropped`. Dropped
   * findings are never retained across calls — the caller must re-detect and
   * re-pass them on a later invocation if still true.
   */
  render(
    sessionID: string,
    findings: readonly Finding[],
    opts: { priorCompliance: (family: string) => boolean },
  ): RenderResult {
    const state = this.getState(sessionID)
    const dropped: RenderResult["dropped"] = []

    // Provisional per-call spend, keyed by family: `state.turnSpend` only
    // updates once a finding actually renders (at the bottom of this
    // method), so a naive snapshot read here would let two same-family
    // findings arriving in ONE `findings` array both pass the cap check
    // (neither individually exceeds the cap-so-far). Tracking claims made
    // *within this call* alongside the cross-call `state.turnSpend` count
    // keeps the cap correct even when a single invocation is handed several
    // findings from the same capped family.
    const provisionalSpend = new Map<string, number>()
    const notCapped = findings.filter((f) => {
      const already = state.turnSpend.get(f.family) ?? 0
      const claimedThisCall = provisionalSpend.get(f.family) ?? 0
      if (already + claimedThisCall >= this.capFor(f.family)) {
        dropped.push({ family: f.family, reason: "per-turn-cap" })
        this.logger("per-turn-cap:dropped", {
          sessionID,
          family: f.family,
          instanceId: f.instanceId,
          priority: f.priority,
          turnIndex: state.turnIndex,
        })
        return false
      }
      provisionalSpend.set(f.family, claimedThisCall + 1)
      return true
    })

    const notCooling = notCapped.filter((f) => {
      const lastTurn = state.lastRenderedTurn.get(f.family)
      if (lastTurn === undefined) return true
      const cooldown = this.cooldownFor(f.family)
      // Cooldown governs eligibility in turns AFTER the one a family last
      // rendered in — repetition WITHIN the same turn is the per-turn cap's
      // job (Dataset row 3's note: "the cooldown is what carries suppression
      // into later turns"). The `state.turnIndex > lastTurn` guard is load
      // bearing: without it, `turnIndex < lastTurn + cooldownTurns` is
      // trivially true whenever `turnIndex === lastTurn` for any
      // `cooldownTurns >= 1`, which would make a cap > 1 family (verify-gap,
      // cap 3) unable to render a second time in the SAME turn even though
      // its cap explicitly allows up to 3 (Dataset row 9).
      if (state.turnIndex > lastTurn && state.turnIndex < lastTurn + cooldown) {
        dropped.push({ family: f.family, reason: "cooldown" })
        this.logger("cooldown:dropped", {
          sessionID,
          family: f.family,
          instanceId: f.instanceId,
          priority: f.priority,
          turnIndex: state.turnIndex,
          lastRenderedTurn: lastTurn,
          cooldownTurns: cooldown,
        })
        return false
      }
      return true
    })

    const byPriority = [...notCooling].sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority])
    const kept = byPriority.slice(0, INVOCATION_BUDGET)
    const overBudget = byPriority.slice(INVOCATION_BUDGET)
    for (const f of overBudget) {
      dropped.push({ family: f.family, reason: "budget" })
      this.logger("budget:dropped", {
        sessionID,
        family: f.family,
        instanceId: f.instanceId,
        priority: f.priority,
        turnIndex: state.turnIndex,
      })
    }

    const directives: Directive[] = []
    const renderedFamilies: string[] = []
    for (const f of kept) {
      const decay = opts.priorCompliance(f.family) || this.wasCompliantLastTurn(state, f.family)
      directives.push({ id: f.instanceId, text: decay ? renderDecayForm(f) : renderFullForm(f) })
      renderedFamilies.push(f.family)

      state.turnSpend.set(f.family, (state.turnSpend.get(f.family) ?? 0) + 1)
      state.lastRenderedTurn.set(f.family, state.turnIndex)

      this.logger("directive_rendered", {
        sessionID,
        family: f.family,
        instanceId: f.instanceId,
        priority: f.priority,
        decayed: decay,
        turnIndex: state.turnIndex,
      })
    }

    const envelope = formatDirectives(directives)
    return {
      text: envelope === null ? null : redactSecrets(envelope),
      renderedFamilies,
      dropped,
    }
  }
}
