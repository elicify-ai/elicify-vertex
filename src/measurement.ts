/**
 * elicify-vertex — out-of-band measurement layer
 * --------------------------------------------------------------------------
 * Mirrors the fablize measurement protocol (MEASUREMENT_PROTOCOL.md §2-§7) in
 * TypeScript for an opencode plugin. Writes events to a JSONL ledger that the
 * plugin can never read back into the model context.
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
 * HOLDOUT (MEASUREMENT_PROTOCOL.md §4)
 *   - 20% of sessions are deterministically routed to the 'off' arm.
 *   - The arm is recomputed from a hash of sessionID each call so the same
 *     session always lands in the same arm.
 *   - 'off' arm sessions SKIP the stop gate so we can measure the gate's
 *     effect against a pure baseline.
 *   - The holdout release is env-gated (VERTEX_HOLDOUT=1) and defaults OFF,
 *     so the default gate behaviour is identical to before this layer existed.
 *
 * SUNSET (MEASUREMENT_PROTOCOL.md §7)
 *   - SUNSET_SESSIONS = 50. The collector/exporter is expected to recommend
 *     removing the instrumentation once 50 sessions are reached without a
 *     comparable on/off signal. The constant is exported so the analysis
 *     side can read it.
 *
 * @see /tmp/fablize-deep/docs/MEASUREMENT_PROTOCOL.md
 * @see /tmp/fablize-deep/scripts/shadow/shadow_logger.py
 */

import { createHash } from "node:crypto"
import { appendFileSync, chmodSync, mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { homedir } from "node:os"
import { redactForDisk } from "./redaction.js"

// ---------- constants (mirror fablize/shadow_logger.py:21-24) ----------------

/** §4: 20% of sessions go to the 'off' holdout arm. */
export const HOLDOUT_OFF_FRACTION = 0.2

/** §7: default sunset horizon (sessions). */
export const SUNSET_SESSIONS = 50

/** Holdout arm values (mirrors shadow_logger.py:50). */
export type HoldoutArm = "on" | "off"

/** Event types (MEASUREMENT_PROTOCOL.md §2). */
export type EventType =
  | "gate_fire"
  | "classify"
  | "outcome"
  | "holdout_suppress"
  | "recovery_repeat"

/** Payload schema is intentionally loose — measurement is observational. */
export type EventPayload = Record<string, unknown>

/** A single event as written to events.jsonl. */
export interface MeasurementEvent {
  ts: string
  session_id: string
  holdout_arm: HoldoutArm
  event_type: EventType
  payload: EventPayload
}

// ---------- paths (override via VERTEX_DATA, mirror FABLIZE_DATA) ------------

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

// ---------- holdout (mirror shadow_logger.py:42-50) --------------------------

/**
 * Deterministic per-session holdout arm. Same session_id always returns same
 * arm. Not exposed to the model — purely an out-of-band function.
 */
export function holdoutArm(sessionId: string | undefined | null): HoldoutArm {
  if (!sessionId) return "on"
  const h = createHash("sha256")
    .update("holdout|" + sessionId, "utf8")
    .digest("hex")
  const bucket = parseInt(h.slice(0, 8), 16) / 0xffffffff
  return bucket < HOLDOUT_OFF_FRACTION ? "off" : "on"
}

/**
 * env-gated (default OFF) holdout suppression: returns true only when the
 * env flag is set AND the session is in the 'off' arm. Default behaviour is
 * always 'do not suppress', so the gate is unchanged when the flag is unset.
 * Mirrors gate_stop.py:26-38 + test_shadow_m3.py:46-58.
 */
export function holdoutSuppresses(sessionId: string | undefined | null): boolean {
  if (process.env.VERTEX_HOLDOUT !== "1") return false
  return holdoutArm(sessionId) === "off"
}

// ---------- event logging ---------------------------------------------------

function utcNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z")
}

/** Build an event object. Does NOT write to disk. */
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
  }
}

/**
 * Append one event to events.jsonl (append-only, never rewrites). Failures
 * are swallowed: measurement must never crash the plugin.
 * Mirrors shadow_logger.py:63-69.
 */
export function appendEvent(event: MeasurementEvent, path?: string): string {
  const p = path ?? eventsPath()
  try {
    mkdirSync(dirname(p), { recursive: true, mode: 0o700 })
    const safeEvent = redactForDisk(event)
    appendFileSync(p, JSON.stringify(safeEvent) + "\n", { encoding: "utf8", mode: 0o600 })
    chmodSync(p, 0o600)
  } catch {
    // out-of-band: swallow — never let measurement break the plugin
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

// ---------- typed convenience writers (mirror fablize/shadow_collect.py) -----

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

export function logHoldoutSuppress(
  sessionId: string | undefined | null,
  reason: string,
  path?: string,
): void {
  logEvent(sessionId, "holdout_suppress", { reason }, path)
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
//
// Mirrors shadow_collect.py:40-94 + test_shadow_m3.py:27-43.
