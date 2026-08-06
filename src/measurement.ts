/**
 * elicify-vertex — out-of-band measurement layer
 * --------------------------------------------------------------------------
 * Out-of-band measurement protocol for an opencode plugin. Writes events to a
 * JSONL ledger that the plugin can never read back into the model context.
 *
 * OUT-OF-BAND GUARANTEE
 *   This module NEVER injects anything into the model prompt, additionalContext,
 *   system messages, or chat messages. All logging is a side-effect that writes
 *   to a file under the user's config directory. The model cannot see
 *   holdout_arm, gate decisions, or any other measurement text.
 *
 *   If you need to display anything to the model, do it in src/index.ts via
 *   formatDirectives(). DO NOT route model-visible text through this file.
 *
 * HOLDOUT
 *   - 20% of sessions are deterministically routed to the 'off' arm.
 *   - The arm is recomputed from a hash of sessionID each call so the same
 *     session always lands in the same arm.
 *   - 'off' arm sessions SKIP the stop gate so we can measure the gate's
 *     effect against a pure baseline.
 *   - The holdout release is env-gated (VERTEX_HOLDOUT=1) and defaults OFF,
 *     so the default gate behaviour is identical to before this layer existed.
 *
 * SUNSET
 *   - SUNSET_SESSIONS = 50. The collector/exporter is expected to recommend
 *     removing the instrumentation once 50 sessions are reached without a
 *     comparable on/off signal. The constant is exported so the analysis
 *     side can read it.
 */

import { createHash } from "node:crypto"
import { appendFileSync, chmodSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs"
import { basename, dirname, extname, join, resolve } from "node:path"
import { homedir } from "node:os"
import { redactForDisk } from "./redaction.js"

// ---------- constants --------------------------------------------------------

/** §4: 20% of sessions go to the 'off' holdout arm. */
export const HOLDOUT_OFF_FRACTION = 0.2

/** §7: default sunset horizon (sessions). */
export const SUNSET_SESSIONS = 50

/** Holdout arm values. */
export type HoldoutArm = "on" | "off"

/** Event types (MEASUREMENT_PROTOCOL.md §2). */
export type EventType =
  | "gate_fire"
  | "classify"
  | "outcome"
  | "holdout_suppress"
  | "recovery_repeat"

/**
 * Vertex 2 event types (FR-033). Additive to `EventType` — the v1 union above
 * is untouched; `MeasurementEvent.event_type` below accepts either.
 *
 * Declared as a runtime `as const` array rather than a bare type union
 * ON PURPOSE. A union is erased at compile time, so the test that is supposed
 * to prove "every v2 event type has a writer" (test 42) could only ever
 * compare a literal list against another literal list — which it did, and
 * which is why `criteria:parse-miss` sat in the union for a whole round with
 * no writer and no failing test. The array is the single source of truth for
 * BOTH the type and the coverage assertion: adding a member here without
 * registering a writer turns test 42 red.
 */
export const V2_EVENT_TYPES = [
  "directive_rendered",
  "directive_complied",
  "calibration",
  "phase_transition",
  "resolution:none",
  "gate:multi-session-advisory",
  "pins:disk-fallback-memory",
  "pins:disk-recovered",
  "pins:disk-unavailable",
  "intake:classify-skipped",
  "intake:classify-fallback",
  "intake:classify-capped",
  "intake:classify-unsupported",
  "subturn:cleanup-failed",
  "verifier:unavailable",
  "verifier:malformed",
  "verifier:unsupported",
  "verifier:field-dropped",
  "criteria:re-pinned",
  "criteria:truncated",
  /** B-2: an unfenced `CRITERIA:` line the block grammar could not parse.
   * Without it a parse miss is indistinguishable from the model never
   * answering the intake scaffold, and both read as "0 complied". */
  "criteria:parse-miss",
  "expect:absent",
] as const

export type V2EventType = (typeof V2_EVENT_TYPES)[number]

/** Payload schema is intentionally loose — measurement is observational. */
export type EventPayload = Record<string, unknown>

/** A single event as written to .vertex-events.jsonl (see eventsPath()). */
export interface MeasurementEvent {
  ts: string
  session_id: string
  holdout_arm: HoldoutArm
  event_type: EventType | V2EventType
  payload: EventPayload
  /**
   * FR-033: every event carries `model` (a `providerID/modelID` string) or
   * the literal `"unknown"`. Stamped by `makeEvent`/`makeV2Event` — never
   * left unset — so this is optional only at the type level (for maximal
   * backward compatibility with any pre-existing construction path), not at
   * runtime.
   */
  model?: string
}

// ---------- paths (override via VERTEX_DATA) ---------------------------------

function defaultDataRoot(): string {
  return resolve(homedir(), ".config", "opencode")
}

export function dataRoot(): string {
  const env = process.env.VERTEX_DATA
  return resolve(env ? env : defaultDataRoot())
}

export function eventsPath(): string {
  return resolve(dataRoot(), ".vertex-events.jsonl")
}

// ---------- holdout ------------------------------------------

/**
 * Deterministic per-session (optionally per-directive-family, FR-035) holdout
 * arm. Same session_id (+ family, when given) always returns the same arm.
 * Not exposed to the model — purely an out-of-band function.
 *
 * FR-035: extends the original session-only hash with an optional `family`
 * component so a session can be independently in the 'off' arm PER DIRECTIVE
 * FAMILY (e.g. session X off for 'elevate' but on for 'verify-gap'). Omitting
 * `family` (or passing an empty string) reproduces exactly today's
 * session-only hash input — backward compatible with every existing caller
 * and with the v1 regression suite's distribution/determinism assertions.
 */
export function holdoutArm(sessionId: string | undefined | null, family?: string): HoldoutArm {
  if (!sessionId) return "on"
  const hashInput = family ? `holdout|${sessionId}|${family}` : "holdout|" + sessionId
  const h = createHash("sha256")
    .update(hashInput, "utf8")
    .digest("hex")
  const bucket = parseInt(h.slice(0, 8), 16) / 0xffffffff
  return bucket < HOLDOUT_OFF_FRACTION ? "off" : "on"
}

/**
 * env-gated (default OFF) holdout suppression: returns true only when the
 * env flag is set AND the session (optionally scoped to `family`, FR-035) is
 * in the 'off' arm. Default behaviour is always 'do not suppress', so the
 * gate is unchanged when the flag is unset.
 */
export function holdoutSuppresses(sessionId: string | undefined | null, family?: string): boolean {
  if (process.env.VERTEX_HOLDOUT !== "1") return false
  return holdoutArm(sessionId, family) === "off"
}

// ---------- event logging ---------------------------------------------------

function utcNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z")
}

/**
 * Build an event object. Does NOT write to disk.
 *
 * FR-033: `model` is always stamped, even though no v1 call site (this
 * function's signature is unchanged, frozen by `src/index.ts`) can supply it
 * — v1 never resolved a model id, so every v1-sourced event is correctly,
 * deterministically `model: "unknown"`. v2 events are built via `makeV2Event`
 * below, which DOES accept a resolved model.
 */
export function makeEvent(
  sessionId: string | undefined | null,
  eventType: EventType,
  payload: EventPayload,
): MeasurementEvent {
  return {
    ts: utcNow(),
    session_id: sessionId || "no-session",
    holdout_arm: holdoutArm(sessionId),
    event_type: eventType,
    payload,
    model: "unknown",
  }
}

/** FR-033a: rotate the live sink at this many bytes. */
export const ROTATE_MAX_BYTES = 32 * 1024 * 1024

/** FR-033a: delete rotated siblings older than this many days. */
export const ROTATE_RETENTION_DAYS = 30

export interface RotationOptions {
  /** Override for tests — avoid writing 32MB to exercise the size trigger. */
  maxBytes?: number
  /** Override for tests — avoid waiting 30 real days to exercise pruning. */
  maxAgeDays?: number
  /** Override "now" for deterministic age-pruning assertions in tests. */
  now?: Date
}

export interface RotationResult {
  rotated: boolean
  rotatedTo: string | null
  pruned: string[]
}

/**
 * FR-033a: size/age rotation for the JSONL sink, run as a check-before-write
 * so `appendEvent`'s signature never has to change (module contracts doc:
 * "wrap it" rather than alter the existing append path's shape).
 *
 * 1. If the live file at `path` exceeds `maxBytes`, it is renamed (never
 *    copied — a single atomic `renameSync`) to `<stem>.<ISO-timestamp><ext>`
 *    in the same directory, e.g. `.vertex-events.jsonl` (32MB+) becomes
 *    `.vertex-events.2026-07-25T12-00-00-000Z.jsonl`. (The spec's prose
 *    example writes this as `events.<timestamp>.jsonl`; the real sink's
 *    basename is `.vertex-events.jsonl`, not `events.jsonl` — this function
 *    preserves the live file's actual stem rather than hardcoding the
 *    literal word "events", so the rotated name stays visibly related to its
 *    source file and the scheme still works under `VERTEX_DATA`/`path`
 *    overrides that use a different basename, e.g. in tests.)
 * 2. Independently of whether rotation just happened, every sibling file in
 *    the same directory matching `<stem>.*<ext>` (excluding the live file
 *    itself) whose mtime is older than `maxAgeDays` is deleted.
 *
 * Exported standalone (not only invoked from inside `appendEvent`) so tests
 * can drive both behaviours with small thresholds and a fixed `now` instead
 * of writing real 32MB / waiting real days.
 */
export function rotateEventsSinkIfNeeded(path?: string, opts: RotationOptions = {}): RotationResult {
  const p = path ?? eventsPath()
  const maxBytes = opts.maxBytes ?? ROTATE_MAX_BYTES
  const maxAgeDays = opts.maxAgeDays ?? ROTATE_RETENTION_DAYS
  const now = opts.now ?? new Date()
  const result: RotationResult = { rotated: false, rotatedTo: null, pruned: [] }

  const dir = dirname(p)
  const ext = extname(p) || ".jsonl"
  const stem = basename(p, ext)
  const liveBase = basename(p)

  try {
    const stat = statSync(p)
    if (stat.isFile() && stat.size > maxBytes) {
      const stamp = now.toISOString().replace(/[:.]/g, "-")
      const rotatedPath = join(dir, `${stem}.${stamp}${ext}`)
      renameSync(p, rotatedPath)
      result.rotated = true
      result.rotatedTo = rotatedPath
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("[vertex] measurement rotate", p, err)
    }
  }

  try {
    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000
    const entries = readdirSync(dir)
    for (const entry of entries) {
      if (entry === liveBase) continue
      if (!entry.startsWith(stem + ".") || !entry.endsWith(ext)) continue
      const full = join(dir, entry)
      try {
        const st = statSync(full)
        if (!st.isFile()) continue
        if (now.getTime() - st.mtime.getTime() > maxAgeMs) {
          unlinkSync(full)
          result.pruned.push(full)
        }
      } catch {
        // best-effort — another process may have already removed it; not fatal.
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("[vertex] measurement prune", p, err)
    }
  }

  return result
}

/**
 * Append one event to the events JSONL (append-only, never rewrites). Failures
 * are fail-open for the plugin hot path but logged to stderr for operators.
 *
 * FR-033a: performs a rotate-if-oversized + prune-if-stale check immediately
 * before the write, via `rotateEventsSinkIfNeeded` (default thresholds). This
 * function's own signature is unchanged so every existing caller (v1's
 * `logEvent`/`logClassify`/etc., all of `src/index.ts`) keeps working
 * unmodified.
 */
export function appendEvent(event: MeasurementEvent, path?: string): string {
  const p = path ?? eventsPath()
  try {
    mkdirSync(dirname(p), { recursive: true, mode: 0o700 })
    rotateEventsSinkIfNeeded(p)
    const safeEvent = redactForDisk(event)
    appendFileSync(p, JSON.stringify(safeEvent) + "\n", { encoding: "utf8", mode: 0o600 })
    chmodSync(p, 0o600)
  } catch (err) {
    // Fail-open for the plugin hot path, but never silent to the operator.
    console.error("[vertex] measurement appendEvent", p, err)
  }
  return p
}

/** Convenience: build + append in one call. */
export function logEvent(
  sessionId: string | undefined | null,
  eventType: EventType,
  payload: EventPayload,
  path?: string,
): MeasurementEvent {
  const ev = makeEvent(sessionId, eventType, payload)
  appendEvent(ev, path)
  return ev
}

// ---------- typed convenience writers ----------------------------------------

export interface ClassifyPayload extends EventPayload {
  mode: string
  agent?: string
  trigger?: string
  risks?: readonly string[]
  review?: boolean
}

export interface GateFirePayload extends EventPayload {
  decision: "block" | "warn" | "allow"
  changed: boolean
  verified: boolean
  stop_blocks: number
  max_stop_blocks: number
  would_block: boolean
  /** Why a block was not enforced (missing client, prompt failure, etc.). */
  reason?: string
}

export interface RecoveryRepeatPayload extends EventPayload {
  signature: string
  count: number
}

export interface OutcomePayload extends EventPayload {
  reverts?: number
  reinstructions?: number
  rework_files?: number
  commits?: number
}

export function logClassify(
  sessionId: string | undefined | null,
  payload: ClassifyPayload,
  path?: string,
): void {
  logEvent(sessionId, "classify", payload, path)
}

export function logGateFire(
  sessionId: string | undefined | null,
  payload: GateFirePayload,
  path?: string,
): void {
  logEvent(sessionId, "gate_fire", payload, path)
}

export function logRecoveryRepeat(
  sessionId: string | undefined | null,
  payload: RecoveryRepeatPayload,
  path?: string,
): void {
  logEvent(sessionId, "recovery_repeat", payload, path)
}

/**
 * FR-035: `holdout_suppress` MUST be logged "with family" when the
 * suppression decision was family-scoped (BDD "Directive-family holdout
 * suppresses rendering"). `extra` is a new optional parameter inserted
 * *before* the pre-existing `path` parameter — every current call site (both
 * in `src/index.ts` and `tests/measurement.test.ts`) invokes this with
 * exactly 2 positional args (`sessionId, reason`), never a 3rd `path`
 * argument, so this insertion does not change behaviour for any existing
 * caller: `extra` stays `undefined`, the family-aware branch below never
 * runs, and the emitted event is byte-identical to before this change
 * (`model: "unknown"`, session-only `holdout_arm`, exactly as `makeEvent` has
 * always produced).
 */
export function logHoldoutSuppress(
  sessionId: string | undefined | null,
  reason: string,
  extra?: { family?: string; model?: string | null },
  path?: string,
): void {
  const family = extra?.family
  const payload: EventPayload = family ? { reason, family } : { reason }
  const ev = makeEvent(sessionId, "holdout_suppress", payload)
  if (extra) {
    ev.model = extra.model && extra.model.trim().length > 0 ? extra.model : "unknown"
    ev.holdout_arm = holdoutArm(sessionId, family)
  }
  appendEvent(ev, path)
}

export function logOutcome(
  sessionId: string | undefined | null,
  payload: OutcomePayload,
  path?: string,
): void {
  logEvent(sessionId, "outcome", payload, path)
}

// ---------- post-hoc collector (preview, for future A/B analysis) ------------
//
// A future analyser (scripts/collect-outcomes.ts or a sister skill) can read
// events.jsonl + git history + tool transcripts and log `outcome` events.
// This module exposes the building block (logOutcome) but does not itself
// reach into git — the plugin has no business running post-hoc git parsing
// on the hot path. The collector signature is documented here for the
// future implementer:
//
//   async function collectOutcomes(
//     sessionId: string,
//     events: MeasurementEvent[],
//     source: { commits?: Commit[]; userMessages?: string[] },
//   ): Promise<number>  // returns count of outcome events written

// =============================================================================
// Vertex 2 extension — FR-033, FR-033a, FR-034, FR-035
// =============================================================================
//
// Additive only: every export above this line is untouched in name/signature
// (only `MeasurementEvent`'s shape widened with optional fields, `holdoutArm`/
// `holdoutSuppresses` gained a trailing optional `family` param, and
// `makeEvent`/`appendEvent` gained internal — not signature — behaviour).
// v2 modules never import this file directly (module contracts doc's
// "Logging convention": they take an injected `EventLogger`); the wave-3
// wiring agent is the only caller of the writers below.

/**
 * Shared input shape every v2 writer accepts: `{ sessionID, model,
 * ...payload }` (module contracts doc, "measurement.ts extension"). `model`
 * defaults to `"unknown"` when omitted/blank. `family`, when present, scopes
 * both the FR-035 per-family holdout-arm hash AND is carried into the payload
 * (the BDD scenario "Directive-family holdout suppresses rendering" expects
 * `holdout_suppress` logged "with family: elevate" — i.e. visible in the
 * record, not just used internally for the arm hash).
 */
export interface V2EventInput {
  sessionID: string | undefined | null
  model?: string | null
  /** FR-035: directive family, when this event is family-scoped. */
  family?: string
  [key: string]: unknown
}

/**
 * FR-033: build (without writing) a v2 event record. Every v2 writer routes
 * through this so `model`/`session_id`/`holdout_arm` are stamped
 * consistently. Exported (parity with `makeEvent`) so callers/tests can
 * inspect the record before deciding whether to append it (e.g. holdout
 * suppression is a caller decision — this function does not itself suppress
 * anything, it only builds the record).
 */
export function makeV2Event(eventType: V2EventType, input: V2EventInput): MeasurementEvent {
  const { sessionID, model, family, ...rest } = input
  const resolvedModel = model && model.trim().length > 0 ? model : "unknown"
  // `family` is consumed above for the FR-035 per-family holdout-arm hash,
  // but the BDD/FR-033 contract (mirrored by logHoldoutSuppress below) is
  // that a family-scoped event also carries `family` in its own payload —
  // re-include it here rather than letting it silently disappear from every
  // directive_rendered/directive_complied record on disk.
  const payload: EventPayload = family ? { ...rest, family } : rest
  return {
    ts: utcNow(),
    session_id: sessionID || "no-session",
    holdout_arm: holdoutArm(sessionID, family),
    event_type: eventType,
    payload,
    model: resolvedModel,
  }
}

/** Convenience: build + append one v2 event in one call. */
export function logV2Event(eventType: V2EventType, input: V2EventInput, path?: string): MeasurementEvent {
  const ev = makeV2Event(eventType, input)
  appendEvent(ev, path)
  return ev
}

// ---------- typed v2 convenience writers --------------------------------------
//
// One wrapper per member of `V2_EVENT_TYPES` — no more, no fewer; test 42
// asserts that correspondence against the array itself, so a new event type
// without a writer here is a failing test, not a silent gap. (The module
// contracts doc listed 22; `dosing:unknown-model` is gone — BACKLOG B-1
// deleted model-conditioned dosing outright, so there is no profile to
// resolve and no unknown model to report — and B-2's `criteria:parse-miss`
// took the count back to 22.)
// Each is a thin `logV2Event` call with a documentation-only payload shape —
// `V2EventInput`'s index signature still allows extra fields, so these are
// guides, not hard schemas. None of these payload shapes carry a raw-text
// field (e.g. no verbatim user ask/prompt text) — see the `event_invariants_property`
// test (test 42) for why that matters (FR-033's "no record carries raw user
// prompt text" invariant).

export interface DirectiveRenderedInput extends V2EventInput {
  family: string
  instanceId: string
  priority: "correction" | "phase-guidance" | "enrichment"
  /** "full" O-D-P-E grammar vs the FR-006 one-line decay form. */
  form?: "full" | "decay"
}
export function logDirectiveRendered(input: DirectiveRenderedInput, path?: string): MeasurementEvent {
  return logV2Event("directive_rendered", input, path)
}

export interface DirectiveCompliedInput extends V2EventInput {
  family: string
  instanceId: string
}
export function logDirectiveComplied(input: DirectiveCompliedInput, path?: string): MeasurementEvent {
  return logV2Event("directive_complied", input, path)
}

export interface CalibrationInput extends V2EventInput {
  declared: "low" | "med" | "high" | null
  observed: "pass" | "fail"
}
export function logCalibration(input: CalibrationInput, path?: string): MeasurementEvent {
  return logV2Event("calibration", input, path)
}

export interface PhaseTransitionInput extends V2EventInput {
  storyId: string | null
  from: "intake" | "execute" | "elevate" | "close"
  to: "intake" | "execute" | "elevate" | "close"
  /** FR-001 transition table row id, e.g. "T1", "T3", "T7". */
  trigger: string
}
export function logPhaseTransition(input: PhaseTransitionInput, path?: string): MeasurementEvent {
  return logV2Event("phase_transition", input, path)
}

export interface ResolutionNoneInput extends V2EventInput {
  changedPaths?: string[]
}
export function logResolutionNone(input: ResolutionNoneInput, path?: string): MeasurementEvent {
  return logV2Event("resolution:none", input, path)
}

export interface GateMultiSessionAdvisoryInput extends V2EventInput {
  activeSessionCount?: number
}
export function logGateMultiSessionAdvisory(input: GateMultiSessionAdvisoryInput, path?: string): MeasurementEvent {
  return logV2Event("gate:multi-session-advisory", input, path)
}

export interface PinsDiskFallbackMemoryInput extends V2EventInput {
  reason?: string
}
export function logPinsDiskFallbackMemory(input: PinsDiskFallbackMemoryInput, path?: string): MeasurementEvent {
  return logV2Event("pins:disk-fallback-memory", input, path)
}

export type PinsDiskRecoveredInput = V2EventInput
export function logPinsDiskRecovered(input: PinsDiskRecoveredInput, path?: string): MeasurementEvent {
  return logV2Event("pins:disk-recovered", input, path)
}

export interface PinsDiskUnavailableInput extends V2EventInput {
  consecutiveFailures?: number
}
export function logPinsDiskUnavailable(input: PinsDiskUnavailableInput, path?: string): MeasurementEvent {
  return logV2Event("pins:disk-unavailable", input, path)
}

export interface IntakeClassifySkippedInput extends V2EventInput {
  /** Which pre-filter pattern matched (e.g. "TRIVIAL_ASK_RE") — never the raw ask text. */
  matched?: string
}
export function logIntakeClassifySkipped(input: IntakeClassifySkippedInput, path?: string): MeasurementEvent {
  return logV2Event("intake:classify-skipped", input, path)
}

export interface IntakeClassifyFallbackInput extends V2EventInput {
  reason?: string
}
export function logIntakeClassifyFallback(input: IntakeClassifyFallbackInput, path?: string): MeasurementEvent {
  return logV2Event("intake:classify-fallback", input, path)
}

export interface IntakeClassifyCappedInput extends V2EventInput {
  cap?: number
}
export function logIntakeClassifyCapped(input: IntakeClassifyCappedInput, path?: string): MeasurementEvent {
  return logV2Event("intake:classify-capped", input, path)
}

export interface IntakeClassifyUnsupportedInput extends V2EventInput {
  reason?: string
}
export function logIntakeClassifyUnsupported(input: IntakeClassifyUnsupportedInput, path?: string): MeasurementEvent {
  return logV2Event("intake:classify-unsupported", input, path)
}

export interface SubturnCleanupFailedInput extends V2EventInput {
  agent?: string
  reason?: string
}
export function logSubturnCleanupFailed(input: SubturnCleanupFailedInput, path?: string): MeasurementEvent {
  return logV2Event("subturn:cleanup-failed", input, path)
}

export interface VerifierUnavailableInput extends V2EventInput {
  reason?: string
}
export function logVerifierUnavailable(input: VerifierUnavailableInput, path?: string): MeasurementEvent {
  return logV2Event("verifier:unavailable", input, path)
}

export interface VerifierMalformedInput extends V2EventInput {
  reason?: string
}
export function logVerifierMalformed(input: VerifierMalformedInput, path?: string): MeasurementEvent {
  return logV2Event("verifier:malformed", input, path)
}

export interface VerifierUnsupportedInput extends V2EventInput {
  reason?: string
}
export function logVerifierUnsupported(input: VerifierUnsupportedInput, path?: string): MeasurementEvent {
  return logV2Event("verifier:unsupported", input, path)
}

export interface VerifierFieldDroppedInput extends V2EventInput {
  field: "criteria" | "diffSummary" | "verifierSummaries"
  reason?: string
}
export function logVerifierFieldDropped(input: VerifierFieldDroppedInput, path?: string): MeasurementEvent {
  return logV2Event("verifier:field-dropped", input, path)
}

export interface CriteriaRePinnedInput extends V2EventInput {
  count?: number
}
export function logCriteriaRePinned(input: CriteriaRePinnedInput, path?: string): MeasurementEvent {
  return logV2Event("criteria:re-pinned", input, path)
}

export interface CriteriaTruncatedInput extends V2EventInput {
  droppedCount?: number
  cap?: number
}
export function logCriteriaTruncated(input: CriteriaTruncatedInput, path?: string): MeasurementEvent {
  return logV2Event("criteria:truncated", input, path)
}

/**
 * B-2: the model wrote a `CRITERIA:` line the block grammar could not read.
 * `keyLine` is the offending line, already truncated by the caller — it is the
 * model's own answer to the intake scaffold, not user prompt text, and it is
 * the only way to tell a parse miss from a model that never answered.
 */
export interface CriteriaParseMissInput extends V2EventInput {
  keyLine?: string
}
export function logCriteriaParseMiss(input: CriteriaParseMissInput, path?: string): MeasurementEvent {
  return logV2Event("criteria:parse-miss", input, path)
}

export type ExpectAbsentInput = V2EventInput
export function logExpectAbsent(input: ExpectAbsentInput, path?: string): MeasurementEvent {
  return logV2Event("expect:absent", input, path)
}

// ---------- FR-034: directive_complied verifier equivalence ------------------

/** FR-034: flags stripped before comparing two verifier commands for equivalence. */
export const IGNORED_VERIFIER_FLAGS = [
  "--reporter=*",
  "--reporters=*",
  "-v",
  "--verbose",
  "--silent",
  "--no-color",
  "--color",
  "--bail",
  "--run",
  "--watch=false",
] as const

const IGNORED_VERIFIER_EXACT_FLAGS: ReadonlySet<string> = new Set([
  "-v",
  "--verbose",
  "--silent",
  "--no-color",
  "--color",
  "--bail",
  "--run",
  "--watch=false",
])
const IGNORED_VERIFIER_PREFIX_FLAGS: readonly string[] = ["--reporter=", "--reporters="]

function isIgnoredVerifierFlag(token: string): boolean {
  if (IGNORED_VERIFIER_EXACT_FLAGS.has(token)) return true
  return IGNORED_VERIFIER_PREFIX_FLAGS.some((prefix) => token.startsWith(prefix))
}

/** Strip every `IGNORED_VERIFIER_FLAGS` token out of a shell command string. */
export function stripIgnoredVerifierFlags(command: string): string {
  return command
    .split(/\s+/)
    .filter(Boolean)
    .filter((tok) => !isIgnoredVerifierFlag(tok))
    .join(" ")
}

/**
 * Local structural mirror of `src/v2/resolve.ts`'s `ResolveContext` /
 * `ResolveDeps` / `ResolutionResult` / `resolveVerifier` (module contracts
 * doc §4). Defined locally rather than imported: this file was authored in
 * the same wave as `resolve.ts` and the task brief calls for avoiding a hard
 * dependency on that file's existence timing. **Wave-3 wiring should replace
 * this alias with a real `import type { resolveVerifier } from "../v2/resolve.js"`
 * and pass the real function into `verifiersEquivalent` once wiring is
 * assembled** — the shapes below were cross-checked against the actual
 * `src/v2/resolve.ts` that landed during this session and match it exactly
 * (`ResolutionResult.rationale`'s 4-way union, `matchedPaths: string[]`,
 * `ResolveContext.storyVerifiers: readonly string[] | null`), so the swap
 * should be a pure type-only substitution with no logic change required.
 */
export interface ResolveVerifierManifest {
  scripts: Record<string, string>
  workspaceRoot?: string
}
export interface ResolveVerifierContext {
  changedPaths: string[]
  storyVerifiers: readonly string[] | null
}
export interface ResolveVerifierDeps {
  // B-4 (b): the mirrored `fallbackProbe?` is gone with the tier it described.
  // `resolve.ts:resolveNodeGroup` documents why that tier was deleted rather than
  // wired; a mirror of a field that no longer exists is just a second copy of the
  // same dead safety net.
  readManifest(): ResolveVerifierManifest | null
}
export interface ResolveVerifierResult {
  command: string | null
  rationale: "story" | "basename" | "fallback:package-script" | "none"
  matchedPaths: string[]
}
export type ResolveVerifierFn = (ctx: ResolveVerifierContext, deps: ResolveVerifierDeps) => ResolveVerifierResult

const VERIFIER_COMMAND_STOPWORDS: ReadonlySet<string> = new Set([
  "npx",
  "npm",
  "pnpm",
  "yarn",
  "run",
  "test",
  "tests",
  "exec",
  "vitest",
  "jest",
  "mocha",
  "workspace",
  "&&",
])

/**
 * Heuristic extraction of the path-shaped tokens out of a (flag-stripped)
 * verifier command — e.g. `"npx vitest run tests/lexer.test.ts"` ->
 * `["tests/lexer.test.ts"]`; `"npm test"` -> `[]` (no path argument). Used
 * only to build the synthetic `ResolveVerifierContext.changedPaths` below;
 * see `verifiersEquivalent`'s doc comment for why this bridging is needed.
 */
function extractVerifierTargetTokens(strippedCommand: string): string[] {
  return strippedCommand
    .split(/\s+/)
    .filter(Boolean)
    .filter((tok) => !tok.startsWith("-"))
    .filter((tok) => !VERIFIER_COMMAND_STOPWORDS.has(tok.toLowerCase()))
    .filter((tok) => /[./]/.test(tok))
}

/**
 * FR-034: two verifier command strings are equivalent when, after stripping
 * `IGNORED_VERIFIER_FLAGS`, the injected resolver returns the same tier
 * (`rationale`) and the same target path set (`matchedPaths`, order-
 * independent) for both.
 *
 * Bridging note (judgment call — see final report): `resolveVerifier`'s real
 * contract resolves *changed paths* to a *command* (paths -> command), not a
 * command to a tier (command -> tier), so there is no direct call shape for
 * "classify this raw command string I was handed." This function bridges the
 * gap by, per side: extracting the path-shaped tokens out of the (flag-
 * stripped) command via `extractVerifierTargetTokens`, then calling `resolve`
 * with a synthetic `{ changedPaths: <those tokens>, storyVerifiers: [<that
 * stripped command>] }` and an empty manifest (`readManifest: () => null`),
 * and comparing the two `ResolveVerifierResult`s by `rationale` +
 * `matchedPaths` set equality. A fast path short-circuits to `true` when the
 * two flag-stripped strings are byte-identical (covers the common case —
 * Dataset row 10 — without invoking `resolve` at all).
 *
 * Verified against the real `src/v2/resolve.ts` tier-1 ("story") and tier-4
 * ("none", empty `changedPaths`) branches, which is exactly the pair Dataset
 * rows 10/11 exercise: `"npx vitest run tests/lexer.test.ts"` extracts
 * `["tests/lexer.test.ts"]` -> tier "story"; `"npm test"` extracts `[]` ->
 * `resolveVerifier` returns tier "none" immediately (its `paths.length === 0`
 * guard fires before it even looks at `storyVerifiers`) — so the two are
 * correctly non-equivalent by `rationale` mismatch, matching Dataset row 11.
 */
/**
 * @deprecated NO LONGER USED IN PRODUCTION. Both former call sites in
 * `src/v2/plugin.ts` now use `observedCoversPrescribed` (`src/v2/coverage.ts`),
 * because this function's `rationale` + `matchedPaths` SET EQUALITY cannot
 * express "broader": it scored `go test ./...` as not-equivalent to a
 * prescribed `go test ./internal/auth/...`, which suppressed the receipt and
 * produced zero evidence across a 94-minute field session.
 *
 * Kept only so nothing importing the symbol breaks, and because
 * `tests/v2/measurement.test.ts` still pins its historical semantics. Note
 * those tests assert the OPPOSITE of the coverage module by design — e.g.
 * `verifiersEquivalent("npx vitest run tests/lexer.test.ts", "npm test")` is
 * `false` here and `true` under coverage. Do not "reconcile" them; this
 * function records what the old rule did.
 */
export function verifiersEquivalent(rendered: string, observed: string, resolve: ResolveVerifierFn): boolean {
  const strippedRendered = stripIgnoredVerifierFlags(rendered).trim()
  const strippedObserved = stripIgnoredVerifierFlags(observed).trim()
  if (strippedRendered.length === 0 || strippedObserved.length === 0) return false
  if (strippedRendered === strippedObserved) return true

  const deps: ResolveVerifierDeps = { readManifest: () => null }
  const a = resolve(
    { changedPaths: extractVerifierTargetTokens(strippedRendered), storyVerifiers: [strippedRendered] },
    deps,
  )
  const b = resolve(
    { changedPaths: extractVerifierTargetTokens(strippedObserved), storyVerifiers: [strippedObserved] },
    deps,
  )
  if (a.rationale !== b.rationale) return false

  const setA = new Set(a.matchedPaths)
  const setB = new Set(b.matchedPaths)
  if (setA.size !== setB.size) return false
  for (const path of setA) {
    if (!setB.has(path)) return false
  }
  return true
}
