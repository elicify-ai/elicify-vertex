/**
 * Vertex 2 — pin.ts (FR-012, FR-013, FR-013a)
 *
 * Owns `.elicify-vertex/pins.json`: session-keyed pinned acceptance criteria,
 * always persisted (never conditional on a plan existing), written under the
 * shared `.elicify-vertex/` directory lock (30s staleness reclaim, the same
 * lock `story.ts` uses for `plan.json`). On a disk write fault the store
 * falls back to serving criteria from memory and retries on the next write,
 * per the FR-013 fault state machine. A genuinely unparseable on-disk
 * `pins.json` (as opposed to merely schema-invalid, which degrades
 * gracefully to an empty base) is treated as unreadable OTHER sessions'
 * data, not "no file yet": the write logs `pins:disk-corrupt` and aborts
 * rather than silently overwriting it with only the current session's own
 * entry — routed through the same fault-tolerance machinery as any other
 * write failure.
 *
 * Reimplements the v1 atomic-write / lock pattern from `src/goals.ts` for its
 * own schema — does not import `goals.ts`.
 */

import { randomUUID } from "node:crypto"
import * as fsNode from "node:fs"
import { join } from "node:path"

import { redactForDisk, redactSecrets } from "../redaction.js"

/**
 * fs seam for fault injection in tests. `import * as fsNode from "node:fs"`
 * produces a synthetic ESM namespace object whose properties come back
 * non-configurable under this project's vitest/Node combination, so
 * `vi.spyOn(fsNode, "writeFileSync")` throws ("Cannot redefine property").
 * Routing every disk call through this plain, mutable object lets tests do
 * `vi.spyOn(fsIO, "writeFileSync").mockImplementation(...)` instead. Reuse
 * this seam pattern (or export your own equivalent) in other v2 modules that
 * need fs fault injection.
 */
export const fsIO = {
  existsSync: fsNode.existsSync,
  mkdirSync: fsNode.mkdirSync,
  readFileSync: fsNode.readFileSync,
  writeFileSync: fsNode.writeFileSync,
  renameSync: fsNode.renameSync,
  chmodSync: fsNode.chmodSync,
  unlinkSync: fsNode.unlinkSync,
  openSync: fsNode.openSync,
  closeSync: fsNode.closeSync,
  statSync: fsNode.statSync,
}

/** Shared logging convention (docs/vertex2-module-contracts.md) — every v2
 * module takes an injected logger instead of importing measurement.ts directly. */
export type EventLogger = (eventType: string, payload: Record<string, unknown>) => void

export interface Criterion {
  id: string // "C1", "C2", ... stable per session (positional within the current pin set)
  text: string // redacted before storage
  evidence: { receiptId: string } | { waiver: true; sourceMessageId: string } | null
}

export interface PinsFileEntry {
  criteria: Criterion[]
  updatedAt: string
}

export type PinsFile = Record<string /* sessionID */, PinsFileEntry>

const MAX_CRITERIA = 10
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
const STALE_LOCK_MS = 30_000
const LOCK_FILE_NAME = "state.lock"

// ---------------------------------------------------------------------------
// Shared directory lock — exported standalone so story.ts (wave 2) can reuse
// it for plan.json without reimplementing the pattern.
// ---------------------------------------------------------------------------

/**
 * Acquire the shared `.elicify-vertex/` directory lock. Reclaims a lock file
 * older than 30s. Throws if held by a live writer.
 */
export function acquireStateLock(stateDir: string): { release(): void } {
  fsIO.mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const lockPath = join(stateDir, LOCK_FILE_NAME)
  const descriptor = acquireLockDescriptor(lockPath)
  let released = false
  return {
    release(): void {
      if (released) return
      released = true
      try {
        fsIO.closeSync(descriptor)
      } catch {
        /* already closed */
      }
      try {
        if (fsIO.existsSync(lockPath)) fsIO.unlinkSync(lockPath)
      } catch {
        /* best-effort cleanup */
      }
    },
  }
}

function acquireLockDescriptor(lockPath: string): number {
  try {
    return fsIO.openSync(lockPath, "wx", 0o600)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== "EEXIST") throw error
  }

  // Lock file exists — reclaim it only if stale (mtime older than 30s).
  let mtimeMs: number
  try {
    mtimeMs = fsIO.statSync(lockPath).mtimeMs
  } catch {
    // Vanished between our failed create and the stat — one retry.
    return retryAcquire(lockPath)
  }
  if (Date.now() - mtimeMs < STALE_LOCK_MS) {
    throw new Error(`elicify-vertex state directory is locked by another process: ${lockPath}`)
  }
  try {
    fsIO.unlinkSync(lockPath)
  } catch {
    /* raced away by another reclaimer — fall through to retryAcquire */
  }
  return retryAcquire(lockPath)
}

function retryAcquire(lockPath: string): number {
  try {
    return fsIO.openSync(lockPath, "wx", 0o600)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "EEXIST") {
      throw new Error(`elicify-vertex state directory is locked by another process: ${lockPath}`)
    }
    throw error
  }
}

// ---------------------------------------------------------------------------
// Validation helpers for data read back from disk.
// ---------------------------------------------------------------------------

function isCriterion(value: unknown): value is Criterion {
  if (!value || typeof value !== "object") return false
  const v = value as Record<string, unknown>
  if (typeof v.id !== "string" || typeof v.text !== "string") return false
  if (v.evidence === null) return true
  if (!v.evidence || typeof v.evidence !== "object") return false
  const evidence = v.evidence as Record<string, unknown>
  if (typeof evidence.receiptId === "string") return true
  if (evidence.waiver === true && typeof evidence.sourceMessageId === "string") return true
  return false
}

function isPinsFileEntry(value: unknown): value is PinsFileEntry {
  if (!value || typeof value !== "object") return false
  const v = value as Record<string, unknown>
  if (typeof v.updatedAt !== "string") return false
  if (!Array.isArray(v.criteria)) return false
  return v.criteria.every(isCriterion)
}

function isPinsFile(value: unknown): value is PinsFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  return Object.values(value).every(isPinsFileEntry)
}

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return typeof code === "string" ? code : "unknown"
}

/** JSON.parse throws a bare SyntaxError (no `.code`) — describe it by message
 * for logging, since `errorCode` above would just say "unknown". */
function describeParseError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface FaultState {
  consecutiveFailures: number
  stoppedRetrying: boolean
  usingFallback: boolean
}

// ---------------------------------------------------------------------------
// PinStore
// ---------------------------------------------------------------------------

export class PinStore {
  private readonly stateDir: string
  private readonly pinsPath: string
  private readonly logger: EventLogger
  private readonly entries = new Map<string, PinsFileEntry>()
  private readonly faultState = new Map<string, FaultState>()

  constructor(opts: { stateDir: string; logger: EventLogger }) {
    this.stateDir = opts.stateDir
    this.pinsPath = join(this.stateDir, "pins.json")
    this.logger = opts.logger
  }

  /**
   * Pins new criteria (caps at 10, extras dropped + logs criteria:truncated).
   * Replaces any prior pin set for the session (last CRITERIA block wins —
   * caller passes the full new list). Persists (see disk-fallback behavior
   * below).
   */
  pin(sessionID: string, criteriaTexts: string[]): Criterion[] {
    const existing = this.entries.get(sessionID)
    const hadPrior = !!existing && existing.criteria.length > 0
    const truncated = criteriaTexts.length > MAX_CRITERIA
    const kept = criteriaTexts.slice(0, MAX_CRITERIA)
    const criteria: Criterion[] = kept.map((text, index) => ({
      id: `C${index + 1}`,
      text: redactSecrets(text),
      evidence: null,
    }))
    const updatedAt = new Date().toISOString()
    this.entries.set(sessionID, { criteria, updatedAt })

    if (truncated) {
      this.logger("criteria:truncated", { sessionID, requested: criteriaTexts.length, kept: criteria.length })
    }
    // Judgment call (undocumented ownership in the spec — see final report):
    // pin.ts is the module that performs the "last CRITERIA block wins"
    // replace, so it is the natural emitter of criteria:re-pinned whenever a
    // session's pin set is replaced by a later, non-empty one.
    if (hadPrior) {
      this.logger("criteria:re-pinned", {
        sessionID,
        previousCount: existing!.criteria.length,
        newCount: criteria.length,
      })
    }

    this.persist(sessionID)
    return criteria
  }

  get(sessionID: string): readonly Criterion[] {
    return this.entries.get(sessionID)?.criteria ?? []
  }

  /**
   * Attaches (or clears, when `evidence` is `null`) a criterion's evidence
   * pointer and persists immediately — matching `pin()`'s own
   * auto-persisting behavior, so every mutation method leaves the in-memory
   * and on-disk state consistent by default (a caller never has to
   * remember a separate follow-up `persist()` call for this method
   * specifically; `persist()` remains public for callers that want to force
   * a flush/retry explicitly). Unknown session/criterion id are no-ops,
   * never throw.
   */
  attachEvidence(sessionID: string, criterionId: string, evidence: Criterion["evidence"]): void {
    const entry = this.entries.get(sessionID)
    if (!entry) return
    const criterion = entry.criteria.find((candidate) => candidate.id === criterionId)
    if (!criterion) return
    criterion.evidence = evidence
    entry.updatedAt = new Date().toISOString()
    this.persist(sessionID)
  }

  /**
   * Explicit disk sync point — call after pin()/attachEvidence(). Swallows fs
   * errors internally per FR-013's fallback state machine (memory fallback,
   * pins:disk-fallback-memory / pins:disk-recovered / pins:disk-unavailable
   * after 3 consecutive failures, then stop retrying for the session). Never
   * throws.
   */
  persist(sessionID: string): void {
    const state = this.faultState.get(sessionID) ?? {
      consecutiveFailures: 0,
      stoppedRetrying: false,
      usingFallback: false,
    }
    this.faultState.set(sessionID, state)
    if (state.stoppedRetrying) return // 3 consecutive failures already hit — no further attempts, ever.

    try {
      this.writeToDisk(sessionID)
      if (state.usingFallback) {
        this.logger("pins:disk-recovered", { sessionID })
      }
      state.consecutiveFailures = 0
      state.usingFallback = false
    } catch (error) {
      state.consecutiveFailures += 1
      if (state.consecutiveFailures === 1) {
        state.usingFallback = true
        this.logger("pins:disk-fallback-memory", { sessionID, reason: errorCode(error) })
      }
      if (state.consecutiveFailures >= 3) {
        state.stoppedRetrying = true
        this.logger("pins:disk-unavailable", { sessionID, reason: errorCode(error) })
      }
    }
  }

  /** Hydrate from disk — used on session.compacted re-injection and cold start. */
  load(sessionID: string): void {
    let raw: string
    try {
      if (!fsIO.existsSync(this.pinsPath)) return
      raw = fsIO.readFileSync(this.pinsPath, "utf8")
    } catch {
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return
    }
    if (!isPinsFile(parsed)) return
    const entry = parsed[sessionID]
    if (!entry) return
    this.entries.set(sessionID, { criteria: entry.criteria, updatedAt: entry.updatedAt })
    // A clean hydrate from disk means the disk is reachable again for this session.
    this.faultState.delete(sessionID)
  }

  /**
   * Drop entries >7 days old or belonging to an unknown session with no
   * plan; delete the file when the last entry is dropped.
   *
   * This method is caller-invoked, not run automatically inside pin()/
   * persist() — see the final report for the recommended cadence.
   */
  gc(knownSessionIds: ReadonlySet<string>): void {
    const cutoff = Date.now() - SEVEN_DAYS_MS
    const shouldDrop = (entry: PinsFileEntry, sessionID: string): boolean => {
      const updatedMs = Date.parse(entry.updatedAt)
      const expired = !Number.isFinite(updatedMs) || updatedMs < cutoff
      return expired || !knownSessionIds.has(sessionID)
    }

    // Prune in-memory state too (covers sessions currently in memory-fallback
    // mode whose entries never made it to disk).
    for (const [sessionID, entry] of [...this.entries]) {
      if (shouldDrop(entry, sessionID)) {
        this.entries.delete(sessionID)
        this.faultState.delete(sessionID)
      }
    }

    const lock = acquireStateLock(this.stateDir)
    try {
      if (!fsIO.existsSync(this.pinsPath)) return
      let parsed: unknown
      try {
        parsed = JSON.parse(fsIO.readFileSync(this.pinsPath, "utf8"))
      } catch {
        return // corrupt file — leave it alone rather than destroying unreadable data
      }
      if (!isPinsFile(parsed)) return

      const kept: PinsFile = {}
      let changed = false
      for (const [sessionID, entry] of Object.entries(parsed)) {
        if (shouldDrop(entry, sessionID)) {
          changed = true
          continue
        }
        kept[sessionID] = entry
      }
      if (!changed) return
      if (Object.keys(kept).length === 0) {
        fsIO.unlinkSync(this.pinsPath)
        return
      }
      this.atomicWrite(kept)
    } finally {
      lock.release()
    }
  }

  private writeToDisk(sessionID: string): void {
    const lock = acquireStateLock(this.stateDir)
    try {
      let file: PinsFile = {}
      if (fsIO.existsSync(this.pinsPath)) {
        const raw = fsIO.readFileSync(this.pinsPath, "utf8")
        let parsed: unknown
        try {
          parsed = JSON.parse(raw)
        } catch (error) {
          // Genuinely unparseable JSON (NOT merely schema-invalid) — this
          // file may hold every OTHER session's entries. Proceeding from an
          // empty base here (the old behavior) would silently overwrite all
          // of them with just this session's own entry on the write below,
          // with zero log and zero error. Log distinctly and abort instead:
          // destroying other sessions' data is worse than a transient write
          // failure for this one. `persist()` — the only caller of this
          // method — catches this via its existing fault-tolerance state
          // machine (pins:disk-fallback-memory / pins:disk-unavailable), so
          // the session still falls back to serving criteria from memory
          // rather than crashing the caller (matches `gc()`'s own "leave a
          // corrupt file alone" precedent just above).
          this.logger("pins:disk-corrupt", { sessionID, path: this.pinsPath, reason: describeParseError(error) })
          throw new Error(
            `pins.json is corrupt (unparseable JSON) — aborting write to avoid destroying other sessions' data: ${describeParseError(error)}`,
          )
        }
        // Parseable but schema-invalid: this is a shape this module
        // understands and can safely disregard (not "someone else's
        // unreadable data") — degrade gracefully, same as before.
        if (isPinsFile(parsed)) file = parsed
      }
      const memEntry = this.entries.get(sessionID)
      if (memEntry) {
        file = { ...file, [sessionID]: { criteria: memEntry.criteria, updatedAt: memEntry.updatedAt } }
      } else if (sessionID in file) {
        const rest: PinsFile = { ...file }
        delete rest[sessionID]
        file = rest
      }
      this.atomicWrite(file)
    } finally {
      lock.release()
    }
  }

  /** Atomic write: `wx` temp file + rename, mode 0600 (pattern reference: src/goals.ts). */
  private atomicWrite(file: PinsFile): void {
    fsIO.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 })
    const tmpPath = join(this.stateDir, `.pins.${process.pid}.${randomUUID()}.tmp`)
    try {
      fsIO.writeFileSync(tmpPath, `${JSON.stringify(redactForDisk(file), null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      })
      fsIO.renameSync(tmpPath, this.pinsPath)
      fsIO.chmodSync(this.pinsPath, 0o600)
    } finally {
      if (fsIO.existsSync(tmpPath)) fsIO.unlinkSync(tmpPath)
    }
  }
}
