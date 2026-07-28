import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import {
  accessSync,
  appendFileSync,
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"

import { dataRoot } from "./measurement.js"
import { redactForDisk, redactSecrets } from "./redaction.js"

/** True when path is filesystem root (`/` or `C:\`) — never a project worktree. */
export function isFilesystemRoot(path: string): boolean {
  const resolved = resolve(path)
  const parent = dirname(resolved)
  return parent === resolved
}

/**
 * Directory, relative to the project root, holding EVERYTHING this plugin
 * persists: the story plan, pinned criteria, verification receipts and their
 * archives.
 *
 * It lives under `.opencode/` deliberately. Receipts are the tokens that let a
 * model mark work complete, and a review demonstrated end to end that a model
 * could simply open the receipts file, clone a still-valid receipt with a new
 * id and a different story, and have the checkpoint accept it. Nothing bound a
 * receipt to the store having actually observed a command. Storing evidence in
 * a directory the model is free to edit means the evidence proves nothing.
 *
 * Moving it here is half the fix; the other half is `isProtectedStatePath`
 * below, which the plugin enforces on every write tool. Both are required —
 * relocation alone just moves the file.
 */
export const PLUGIN_STATE_DIR = ".opencode/elicify-vertex"

/**
 * Is this path inside the plugin's protected state directory?
 *
 * Accepts absolute or workspace-relative paths, and normalises `..` so
 * `src/../.opencode/elicify-vertex/receipts.json` cannot slip past.
 */
export function isProtectedStatePath(path: string, workspaceRoot: string): boolean {
  const normalise = (p: string): string => {
    const abs = p.startsWith("/") ? p : join(workspaceRoot, p)
    const out: string[] = []
    for (const part of abs.split("/")) {
      if (part === "" || part === ".") continue
      if (part === "..") out.pop()
      else out.push(part)
    }
    return `/${out.join("/")}`
  }
  const target = normalise(path)
  const guarded = normalise(join(workspaceRoot, PLUGIN_STATE_DIR))
  return target === guarded || target.startsWith(`${guarded}/`)
}

/** True when we can create the plugin state directory under this directory. */
export function isWritableGoalRoot(path: string): boolean {
  if (!path || isFilesystemRoot(path)) return false
  try {
    if (!existsSync(path)) return false
    const st = statSync(path)
    if (!st.isDirectory()) return false
    accessSync(path, constants.W_OK)
    // Prove create+delete of the state dir name without leaving debris when possible.
    const probe = join(path, `.elicify-vertex-write-probe-${process.pid}`)
    mkdirSync(probe, { recursive: true })
    rmProbe(probe)
    return true
  } catch {
    return false
  }
}

function rmProbe(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true })
  } catch {
    /* best-effort cleanup of write probe */
  }
}

/**
 * Pick a writable project root for multi-story goal state (`.opencode/elicify-vertex/`).
 * Never uses filesystem root. Prefers explicit worktree/directory, then cwd,
 * then `$HOME`. Throws a clear error if nothing is usable.
 */
export function resolveGoalWorkspaceRoot(candidates: readonly (string | undefined | null)[]): string {
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const raw of candidates) {
    if (!raw || typeof raw !== "string") continue
    const trimmed = raw.trim()
    if (!trimmed) continue
    const resolved = resolve(trimmed)
    if (seen.has(resolved)) continue
    seen.add(resolved)
    ordered.push(resolved)
  }
  // Always consider process cwd and home as last-resort project anchors.
  for (const fallback of [process.cwd(), homedir()]) {
    const resolved = resolve(fallback)
    if (!seen.has(resolved)) {
      seen.add(resolved)
      ordered.push(resolved)
    }
  }

  for (const candidate of ordered) {
    if (isWritableGoalRoot(candidate)) return candidate
  }

  throw new Error(
    "elicify-vertex goals need a writable project directory (not filesystem root). " +
      "Open or cd into a project folder you can write to, then retry. " +
      `Tried: ${ordered.slice(0, 6).join(", ") || "(none)"}`,
  )
}

export type StoryStatus = "pending" | "in_progress" | "complete" | "failed" | "blocked"
export type PlanStatus = "active" | "complete" | "failed" | "blocked"

/**
 * What a verification receipt is evidence FOR.
 *
 * Product requirement this shape answers, verbatim in substance: *test
 * results must be linked to the plan — per user story it must be validated
 * once — and the verification must be linked to the scope or goal it
 * verifies. This must also work for executions with no plan.*
 *
 *  - `storyId` is the GOAL link. It is the id of the story that was active
 *    when the verification was observed (read from the v2 `plan.json` that
 *    `StoryEngine` writes into the same `.opencode/elicify-vertex/` directory), or
 *    `null` when the session had no plan — the "executions with no plan"
 *    path, which still gets a fully-formed, persistable receipt. Consumers
 *    (`src/v2/wiring/tools.ts`) refuse a receipt minted while story S1 was
 *    active as evidence for story S2, which is what turns "per story,
 *    validated once" into a checkable fact instead of a coincidence of
 *    timing.
 *  - `paths` is the SCOPE link: the declared scope the verification covered
 *    (the active story's `scopeGlobs`, or caller-supplied changed paths).
 *    It is recorded for provenance and audit only — deliberately NOT used to
 *    narrow invalidation, see `worktreeDigest`.
 *  - `worktreeDigest` is the INVALIDATION key, and it is deliberately a
 *    SUPERSET of `paths`: a bounded fingerprint of the entire worktree (see
 *    `fingerprintWorktree`). Narrowing invalidation to `paths` would be an
 *    under-invalidation trap — a verifier run (`npm test`, `tsc`) exercises
 *    far more of the tree than the story's declared globs, so an edit
 *    outside those globs can absolutely break it. Any change anywhere in the
 *    worktree therefore retires the receipt.
 *  - `complete` is `false` when the fingerprint could not be computed in
 *    full (worktree missing, or past `RECEIPT_SCOPE_MAX_FILES` /
 *    `RECEIPT_SCOPE_MAX_HASHED_BYTES`). An incomplete-scope receipt is never
 *    written to disk and is never accepted from disk: freshness that cannot
 *    be proven is not persisted.
 */
export interface VerificationScope {
  storyId: string | null
  paths: string[]
  worktreeDigest: string
  fileCount: number
  complete: boolean
}

/**
 * Secret used to bind a receipt to THIS harness having observed the command.
 *
 * Kept beside the event log, OUTSIDE the project worktree, and never written
 * into `.opencode/`. That separation is the whole point: the evidence store
 * lives in the repo so it travels with the project, while the thing that makes
 * a receipt unforgeable does not.
 *
 * Why this exists at all: an audit walked ~15 ways around the tool-boundary
 * write filter -- `file_path` instead of `filePath`, a path inside `patchText`,
 * a symlink to the state dir, string concatenation and base64 in a bash
 * command, case differences -- and completed a story with zero verifier runs by
 * appending a hand-written receipt. Enumerating every possible writer is a
 * losing game. Signing is not: a receipt the harness did not mint has no valid
 * signature, so every one of those bypasses becomes inert without the filter
 * having to be exhaustive.
 *
 * Failure is CLOSED. If the key cannot be read or created, signing yields null
 * and `verifyReceiptSignature` rejects, so receipts stop being accepted rather
 * than silently becoming unverifiable.
 */
const RECEIPT_KEY_FILE = "receipt-signing.key"
let cachedSecret: Buffer | null = null

function receiptSecret(): Buffer | null {
  if (cachedSecret) return cachedSecret
  try {
    const path = join(dataRoot(), RECEIPT_KEY_FILE)
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    let raw: Buffer
    try {
      raw = readFileSync(path)
    } catch {
      raw = randomBytes(32)
      writeFileSync(path, raw, { mode: 0o600 })
    }
    if (raw.length < 16) return null
    cachedSecret = raw
    return cachedSecret
  } catch {
    return null
  }
}

/** Fields a signature binds. Anything a forger would need to change to make a
 * receipt say something else must be in here. */
function signingPayload(receipt: VerificationReceipt): string {
  return JSON.stringify([
    receipt.id,
    receipt.sessionID,
    resolve(receipt.workspaceRoot),
    receipt.command,
    receipt.exitCode,
    receipt.outcome,
    receipt.observedAt,
    receipt.scope?.storyId ?? null,
    receipt.scope?.worktreeDigest ?? null,
    receipt.scope?.complete ?? null,
  ])
}

export function signReceipt(receipt: VerificationReceipt): string | null {
  const secret = receiptSecret()
  if (!secret) return null
  return createHmac("sha256", secret).update(signingPayload(receipt)).digest("hex")
}

/**
 * Sign a WAIVER, using the same out-of-worktree key as receipts.
 *
 * Waivers were the cheapest forgery left in the system once receipts were
 * signed. `gate.ts` re-validates receipt evidence on every idle but returns
 * "evidenced" for a waiver unconditionally, and `pins.json` / `plan.json` are
 * ordinary files -- so writing `{"waiver":true,"sourceMessageId":"msg_anything"}`
 * over every criterion silenced the gate outright (measured: continuations
 * 1 -> 0). No receipt to clone, no worktree digest to satisfy.
 *
 * The signature binds the waiver to the session, criterion and source message
 * the harness actually validated, so a hand-written one cannot be substituted
 * and a legitimate one cannot be moved to a different criterion.
 */
export function signWaiver(input: { sessionID: string; criterionId: string; sourceMessageId: string }): string | null {
  const secret = receiptSecret()
  if (!secret) return null
  return createHmac("sha256", secret)
    .update(JSON.stringify(["waiver", input.sessionID, input.criterionId, input.sourceMessageId]))
    .digest("hex")
}

export function verifyWaiverSignature(
  input: { sessionID: string; criterionId: string; sourceMessageId: string },
  signature: unknown,
): boolean {
  const expected = signWaiver(input)
  if (!expected || typeof signature !== "string" || signature.length !== expected.length) return false
  try {
    return timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"))
  } catch {
    return false
  }
}

export function verifyReceiptSignature(receipt: VerificationReceipt): boolean {
  const expected = signReceipt(receipt)
  const actual = receipt.signature
  if (!expected || typeof actual !== "string" || actual.length !== expected.length) return false
  try {
    return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"))
  } catch {
    return false
  }
}

export interface VerificationReceipt {
  /**
   * HMAC binding this receipt to the harness that observed the command (see
   * `signReceipt`). Optional in the TYPE so pre-signature receipt literals and
   * v1 `goals.json` records still typecheck; a receipt reaching `get()` without
   * a VALID signature is refused, so absent is never treated as trusted.
   */
  signature?: string
  id: string
  sessionID: string
  workspaceRoot: string
  command: string
  exitCode: 0
  outcome: "verified"
  outputSummary: string
  observedAt: string
  /**
   * ADDED alongside persistence. Optional in the TYPE so receipt literals
   * written before this field existed (v1 call sites, `goals.json` files on
   * disk) still typecheck and still load; `record()` always populates it.
   * A receipt reaching `VerificationReceiptStore.get()` WITHOUT a scope
   * cannot be proven fresh and is therefore refused — absent is never
   * treated as "fine".
   */
  scope?: VerificationScope
}

export interface GoalStory {
  id: string
  ordinal: number
  kind: "work" | "verification"
  title: string
  objective: string
  status: StoryStatus
  evidence: string | null
  startedAt: string | null
  completedAt: string | null
  verification: VerificationReceipt | null
}

export interface GoalPlan {
  schemaVersion: 1
  revision: number
  brief: string
  status: PlanStatus
  activeStoryId: string | null
  createdAt: string
  updatedAt: string
  stories: GoalStory[]
}

export interface GoalStoryInput {
  title: string
  objective: string
}

const STORY_STATUSES = new Set<StoryStatus>(["pending", "in_progress", "complete", "failed", "blocked"])
const PLAN_STATUSES = new Set<PlanStatus>(["active", "complete", "failed", "blocked"])

/** A goals.lock older than this is treated as stale and reclaimed. */
const STALE_LOCK_MS = 30_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function requireNonBlank(value: string, name: string): string {
  const result = value.trim()
  if (!result) throw new Error(`${name} must not be blank`)
  return result
}

function isValidTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && Number.isFinite(Date.parse(value))
}

// ---------------------------------------------------------------------------
// Verification receipts — persisted evidence.
// ---------------------------------------------------------------------------

/** On-disk schema version of `.opencode/elicify-vertex/receipts.json`. Bumping this
 * archives (never deletes) the old file, mirroring how `story.ts` handles a
 * `goals.json` it does not understand. */
export const RECEIPTS_SCHEMA_VERSION = 1
const RECEIPTS_FILE_NAME = "receipts.json"
const RECEIPTS_LOCK_NAME = "receipts.lock"
const MAX_RECEIPTS_PER_SESSION = 20
/** Sessions untouched for this long are pruned on the next write, so the
 * file cannot grow without bound (same 7-day horizon `pin.ts` uses). */
const RECEIPTS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const MAX_SCOPE_PATHS = 50

/**
 * Directory names skipped by the worktree fingerprint. Two rules decided
 * membership: (1) the harness's OWN state must be excluded or every receipt
 * would invalidate itself the moment it is written (`.opencode/elicify-vertex`), and
 * (2) build/dependency output is a derived artifact that a verifier run
 * routinely rewrites — including it would retire every receipt the instant
 * it was minted, which is indistinguishable from having no persistence.
 * Source, tests, config and docs are all still covered.
 */
/**
 * Ignored WHEREVER they appear. These are tool-managed or vendored trees whose
 * contents are never hand-edited source, at any depth: a nested
 * `packages/app/node_modules` is as derived as a root one.
 */
const RECEIPT_SCOPE_IGNORED_ANYWHERE: ReadonlySet<string> = new Set([
  ".git",
  ".gradle",
  ".idea",
  ".mypy_cache",
  ".next",
  ".nuxt",
  ".opencode",
  ".pytest_cache",
  ".turbo",
  ".venv",
  ".vscode",
  "__pycache__",
  "node_modules",
  "venv",
])

/**
 * Ignored ONLY at the repository root, where they are conventionally build
 * output. Matching these by basename at any depth was a fabrication vector:
 * `src/build/compiler.ts` and a Go project's checked-in `vendor/` sources are
 * ordinary source that happens to sit under a directory with a derived-looking
 * name, and edits to them never touched the digest -- so a receipt outlived the
 * code it verified. A nested `dist/` might still be output, but wrongly
 * INCLUDING it only costs a re-verification, while wrongly excluding it
 * attests to code nobody checked.
 */
const RECEIPT_SCOPE_IGNORED_AT_ROOT: ReadonlySet<string> = new Set([
  "build",
  "coverage",
  "dist",
  "out",
  "target",
  "vendor",
])

/** Hard ceilings on the fingerprint walk. Past either one the scope is marked
 * incomplete rather than silently partial — a partial fingerprint would miss
 * exactly the edits it failed to reach, which is under-invalidation, which is
 * the failure mode this whole mechanism exists to prevent. */
const RECEIPT_SCOPE_MAX_FILES = 20_000
const RECEIPT_SCOPE_MAX_HASHED_BYTES = 64 * 1024 * 1024
/** Files above this size are fingerprinted by metadata instead of content, so
 * one large binary/fixture cannot disable persistence for a whole worktree. */
const RECEIPT_SCOPE_MAX_FILE_BYTES = 4 * 1024 * 1024

export interface WorktreeFingerprint {
  /** `sha256` over one sorted `path size sha256(content)` line per file. */
  digest: string
  fileCount: number
  /** `false` when the walk could not cover the whole worktree (missing root,
   * more than `RECEIPT_SCOPE_MAX_FILES` files, or more than
   * `RECEIPT_SCOPE_MAX_HASHED_BYTES` of hashable content). */
  complete: boolean
}

/**
 * Bounded, deterministic fingerprint of a worktree — the durable half of the
 * staleness rule (the in-process half is `invalidate()`, which wiring already
 * calls on every mutation).
 *
 * CONTENT-hashed, not mtime-stamped, and that choice was forced by evidence:
 * an inode+size+mtime fingerprint let a same-size edit through UNDETECTED in
 * test, because Linux stamps file mtimes from a coarse (jiffy-resolution)
 * clock — `answer = 42` -> `answer = 44` inside one tick is byte-different
 * but metadata-identical. That is silent under-invalidation, i.e. a stale
 * receipt that still counts, so metadata alone is not an acceptable basis for
 * evidence. Content hashing is also exact in the other direction: a checkout
 * that rewrites files with identical bytes does NOT retire a receipt, because
 * the code it verified is genuinely unchanged.
 *
 * Symlinks are recorded by name and never followed (no cycles, no escaping
 * the worktree). Lines are sorted before hashing so the digest does not
 * depend on readdir order.
 *
 * Known limits (restated in the report): files larger than
 * `RECEIPT_SCOPE_MAX_FILE_BYTES` fall back to size+inode+mtime, so a
 * same-size, same-tick edit to a >4MB file is still invisible; changes under
 * `RECEIPT_SCOPE_IGNORED_DIRS` are not seen; and anything outside the
 * worktree (a global dependency store, an env var, a remote service) is out
 * of scope entirely.
 */
export function fingerprintWorktree(root: string): WorktreeFingerprint {
  const resolvedRoot = resolve(root)
  let rootIsDirectory = false
  try {
    rootIsDirectory = statSync(resolvedRoot).isDirectory()
  } catch {
    rootIsDirectory = false
  }
  // A worktree we cannot even open is a scope we cannot prove anything
  // about. Report it as incomplete instead of returning the digest of the
  // empty set, which would compare equal to every other unreadable root.
  if (!rootIsDirectory) return { digest: "", fileCount: 0, complete: false }

  const lines: string[] = []
  const pending: string[] = [""]
  let hashedBytes = 0
  let complete = true

  walk: while (pending.length > 0) {
    const relativeDirectory = pending.pop() as string
    let entries
    try {
      entries = readdirSync(join(resolvedRoot, relativeDirectory), { withFileTypes: true })
    } catch {
      continue // unreadable directory — skip it rather than aborting the walk
    }
    for (const entry of entries) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) {
        // Hash the TARGET PATH, not just the fact that a symlink exists.
        // Recording only the name made retargeting invisible: flipping
        // `src/config.ts` from `./good.ts` to `./bad.ts` left the digest
        // unchanged, so a receipt survived a change that swapped the code it
        // attested. Reading THROUGH the link would be worse -- an out-of-tree
        // target reintroduces unbounded walks -- so the link's own content
        // (where it points) is what gets hashed.
        let target = "?"
        try {
          target = readlinkSync(join(resolvedRoot, relativePath))
        } catch {
          target = "unreadable"
        }
        lines.push(`${relativePath} symlink ${target}`)
        continue
      }
      if (entry.isDirectory()) {
        // Ignore by ROOT-RELATIVE PATH, not by basename at any depth. The
        // basename test made real source invisible wherever a directory
        // happened to be called `build`, `out`, `dist`, `target` or `vendor`:
        // an edit to `src/build/compiler.ts`, or to checked-in Go `vendor/`
        // sources, never touched the digest, so a receipt outlived the code it
        // verified.
        const ignored =
          RECEIPT_SCOPE_IGNORED_ANYWHERE.has(entry.name) ||
          (relativeDirectory === "" && RECEIPT_SCOPE_IGNORED_AT_ROOT.has(entry.name))
        if (!ignored) pending.push(relativePath)
        continue
      }
      if (!entry.isFile()) continue
      if (lines.length >= RECEIPT_SCOPE_MAX_FILES) {
        complete = false
        break walk
      }

      const absolutePath = join(resolvedRoot, relativePath)
      let stats
      try {
        stats = statSync(absolutePath, { bigint: true })
      } catch {
        lines.push(`${relativePath} missing`)
        continue
      }
      // Mode is part of a file's meaning: clearing an exec bit breaks a real
      // program with zero content change, and that was invisible.
      const mode = (stats.mode & BigInt(0o7777)).toString(8)
      if (stats.size > BigInt(RECEIPT_SCOPE_MAX_FILE_BYTES)) {
        // Metadata fallback for very large files -- the same size+inode+mtime
        // scheme already proven insufficient for small ones (`42` -> `44` is
        // metadata-identical), and `rsync -a` / `cp -p` / restore-from-backup
        // all preserve mtimes exactly. A large file is therefore UNPROVABLE
        // rather than unchanged: mark the scope incomplete so `isStale` fails
        // closed, instead of quietly attesting what the digest cannot see.
        complete = false
        lines.push(`${relativePath} large ${stats.size} ${stats.ino} ${stats.mtimeNs} ${mode}`)
        continue
      }
      hashedBytes += Number(stats.size)
      if (hashedBytes > RECEIPT_SCOPE_MAX_HASHED_BYTES) {
        complete = false
        break walk
      }
      try {
        const content = createHash("sha256").update(readFileSync(absolutePath)).digest("hex")
        lines.push(`${relativePath} ${stats.size} ${mode} ${content}`)
      } catch {
        lines.push(`${relativePath} unreadable ${stats.size} ${stats.mtimeNs}`)
      }
    }
  }

  if (!complete) return { digest: "", fileCount: lines.length, complete: false }

  lines.sort()
  const hash = createHash("sha256")
  for (const line of lines) hash.update(`${line}\n`)
  return { digest: hash.digest("hex"), fileCount: lines.length, complete: true }
}

interface ReceiptsFileEntry {
  updatedAt: string
  receipts: VerificationReceipt[]
}

interface ReceiptsFile {
  schemaVersion: number
  sessions: Record<string, ReceiptsFileEntry>
}

/** Thrown internally when `receipts.json` is unparseable — the write is then
 * ABORTED rather than clobbering other sessions' receipts with our own
 * (same reasoning as `pin.ts`'s `pins:disk-corrupt` branch). */
class CorruptReceiptsFileError extends Error {}

function isPersistedScope(value: unknown): value is VerificationScope {
  if (!isRecord(value)) return false
  if (value.storyId !== null && typeof value.storyId !== "string") return false
  if (!Array.isArray(value.paths) || value.paths.some((path) => typeof path !== "string")) return false
  if (typeof value.worktreeDigest !== "string" || value.worktreeDigest.trim() === "") return false
  if (!Number.isFinite(value.fileCount)) return false
  // Only `complete: true` scopes are ever written; refusing anything else on
  // read closes the "hand-craft a receipts.json whose scope is unprovable,
  // and therefore never checked" fabrication path.
  return value.complete === true
}

function isPersistedReceipt(value: unknown): value is VerificationReceipt {
  if (!isRecord(value)) return false
  if (typeof value.id !== "string" || !value.id.trim()) return false
  if (typeof value.sessionID !== "string" || !value.sessionID.trim()) return false
  if (typeof value.workspaceRoot !== "string" || !value.workspaceRoot.trim()) return false
  if (typeof value.command !== "string") return false
  if (typeof value.outputSummary !== "string") return false
  if (value.exitCode !== 0 || value.outcome !== "verified") return false
  if (!isValidTimestamp(value.observedAt)) return false
  return isPersistedScope(value.scope)
}

export type ReceiptLogger = (event: string, payload: Record<string, unknown>) => void

export interface VerificationReceiptStoreOptions {
  /** Overrides the state directory otherwise derived from each receipt's own
   * `workspaceRoot` (`<workspaceRoot>/.opencode/elicify-vertex`). Tests use this; the
   * plugin does not need to, which is why `new VerificationReceiptStore()`
   * still persists with no wiring change. */
  stateDir?: string
  logger?: ReceiptLogger
  /**
   * Resolves what a receipt is evidence FOR at record time. The default
   * reads the v2 `plan.json` sitting next to `receipts.json` and returns the
   * ACTIVE story's id plus its declared `scopeGlobs`; with no plan (or an
   * unreadable one) it returns `{ storyId: null, paths: [] }`, which is the
   * supported "execution with no plan" path, not an error.
   */
  resolveScopeLink?: (sessionID: string, stateDir: string) => { storyId: string | null; paths: string[] }
}

/** Default `resolveScopeLink`: shape-probes `plan.json` rather than importing
 * `src/v2/story.ts`, so this v1 module keeps zero dependencies on v2. */
function readPlanScopeLink(sessionID: string, stateDir: string): { storyId: string | null; paths: string[] } {
  const empty = { storyId: null, paths: [] as string[] }
  try {
    const planPath = join(stateDir, "plan.json")
    if (!existsSync(planPath)) return empty
    const parsed: unknown = JSON.parse(readFileSync(planPath, "utf8"))
    if (!isRecord(parsed)) return empty
    const plan = parsed[sessionID]
    if (!isRecord(plan) || !Array.isArray(plan.stories)) return empty
    const active = plan.stories.find((story) => isRecord(story) && story.status === "active")
    if (!isRecord(active) || typeof active.id !== "string") return empty
    const globs = Array.isArray(active.scopeGlobs)
      ? active.scopeGlobs.filter((glob): glob is string => typeof glob === "string")
      : []
    return { storyId: active.id, paths: globs }
  } catch {
    return empty
  }
}

/**
 * Verified-command receipts, persisted to `<workspaceRoot>/.opencode/elicify-vertex/
 * receipts.json` (same directory, same atomic-write discipline and same
 * stale-lock reclaim as `pin.ts`'s `pins.json` and `story.ts`'s `plan.json`).
 *
 * Why persist at all: a receipt that dies with the process means "come back
 * tomorrow" re-demands proof of things already proved. Why persistence is
 * dangerous, and how that is contained: a receipt from last week is NOT
 * evidence that today's code passes, so a stale receipt that still counts is
 * strictly worse than no persistence. Two independent invalidation layers
 * exist, and a receipt must survive BOTH to be served:
 *
 *   1. In-process: wiring already calls `invalidate(sessionID)` on every
 *      mutation. That now clears disk as well as memory, so an edit made in
 *      this process cannot be "recovered" by restarting.
 *   2. Cross-process: every receipt carries `scope.worktreeDigest`, a bounded
 *      fingerprint of the whole worktree at observation time. `get()`
 *      recomputes it on every lookup and drops the receipt on any mismatch —
 *      which covers edits made while no process was running (a `git pull`, a
 *      second agent, a human in an editor).
 *
 * `get()` is the single choke point: every existing caller (wiring's
 * `isValidReceipt`, `tools.ts`'s `isFreshReceipt`, v1's checkpoint tool) gets
 * the staleness check without changing its call site.
 */
export class VerificationReceiptStore {
  private readonly bySession = new Map<string, VerificationReceipt[]>()
  /** Workspace root last seen for a session — the only way `get()`, whose
   * signature carries no root, can find the file to hydrate from. Populated
   * by `record()` and by the explicit `load()` wiring calls after a restart. */
  private readonly rootBySession = new Map<string, string>()
  private readonly hydratedSessions = new Set<string>()
  private readonly stateDirOverride: string | null
  private readonly logger: ReceiptLogger
  private readonly resolveScopeLink: (sessionID: string, stateDir: string) => { storyId: string | null; paths: string[] }

  constructor(options: VerificationReceiptStoreOptions = {}) {
    this.stateDirOverride = options.stateDir ? resolve(options.stateDir) : null
    this.logger = options.logger ?? (() => {})
    this.resolveScopeLink = options.resolveScopeLink ?? readPlanScopeLink
  }

  record(input: Omit<VerificationReceipt, "id" | "command" | "outputSummary" | "scope"> & {
    command: string
    outputSummary: string
    /** Optional explicit link. Wiring may supply the real changed-path scope
     * (and story id) it already knows; omitted, both are resolved from
     * `plan.json` by `resolveScopeLink`. */
    scope?: { storyId?: string | null; paths?: readonly string[] }
  }): VerificationReceipt {
    const workspaceRoot = resolve(input.workspaceRoot)
    const stateDir = this.stateDirFor(workspaceRoot)
    this.rootBySession.set(input.sessionID, workspaceRoot)
    this.hydrate(input.sessionID)

    const link = this.safeScopeLink(input.sessionID, stateDir)
    const fingerprint = fingerprintWorktree(workspaceRoot)
    const declaredPaths = input.scope?.paths ?? link.paths
    const receipt: VerificationReceipt = {
      ...input,
      id: `vrf_${randomUUID().replace(/-/g, "")}`,
      command: redactSecrets(input.command).slice(0, 500),
      outputSummary: redactSecrets(input.outputSummary).slice(0, 500),
      scope: {
        storyId: input.scope?.storyId !== undefined ? input.scope.storyId : link.storyId,
        paths: declaredPaths.slice(0, MAX_SCOPE_PATHS).map((path) => redactSecrets(path).slice(0, 300)),
        worktreeDigest: fingerprint.digest,
        fileCount: fingerprint.fileCount,
        complete: fingerprint.complete,
      },
    }
    // An UNPROVABLE scope must not become a receipt at all.
    //
    // Refusing it at lookup time (the previous behaviour) was worse than either
    // alternative: on a worktree past the file/byte ceiling the harness minted
    // a receipt, appended its id to the tool output telling the model to cite
    // it, and then refused that id at every consumer forever -- same process
    // and every later one. No story on a large monorepo could be closed by a
    // receipt, and the only route left was a waiver. Failing here instead makes
    // the refusal immediate, attributable and visible, rather than a receipt
    // that exists but can never be used.
    if (!fingerprint.complete) {
      this.logger("receipts:scope-unverifiable", {
        sessionID: input.sessionID,
        fileCount: fingerprint.fileCount,
        reason: "worktree too large to fingerprint; no receipt minted",
      })
    }

    // Sign LAST: the signature covers the finished record, including the scope
    // digest, so neither the story link nor the worktree it attests can be
    // edited after the fact.
    const signature = signReceipt(receipt)
    if (signature) receipt.signature = signature
    else this.logger("receipts:unsigned", { sessionID: input.sessionID, receiptId: receipt.id })

    const receipts = this.bySession.get(input.sessionID) ?? []
    receipts.push(receipt)
    this.bySession.set(input.sessionID, receipts.slice(-MAX_RECEIPTS_PER_SESSION))
    if (!fingerprint.complete) {
      this.logger("receipts:scope-unverifiable", {
        sessionID: input.sessionID,
        receiptID: receipt.id,
        fileCount: fingerprint.fileCount,
      })
    }
    this.persist(input.sessionID)
    return receipt
  }

  /**
   * Returns the receipt only if it is still valid RIGHT NOW. A receipt whose
   * worktree fingerprint no longer matches is dropped (memory and disk) and
   * reported as absent, so no caller can accept last week's proof for
   * today's code.
   */
  get(sessionID: string, receiptID: string): VerificationReceipt | null {
    this.hydrate(sessionID)
    const receipt = this.bySession.get(sessionID)?.find((candidate) => candidate.id === receiptID) ?? null
    if (!receipt) return null

    // Provenance BEFORE freshness. Staleness asks "does this still describe the
    // code?"; the signature asks the prior question "did this harness ever
    // observe this command?". Without it, an audit completed a story with zero
    // verifier runs by hand-writing a receipt into the store -- the path filter
    // at the tool boundary had ~15 bypasses, and a filter has to be exhaustive
    // to work while a signature does not.
    if (!verifyReceiptSignature(receipt)) {
      const remaining = (this.bySession.get(sessionID) ?? []).filter((candidate) => candidate.id !== receiptID)
      if (remaining.length > 0) this.bySession.set(sessionID, remaining)
      else this.bySession.delete(sessionID)
      this.logger("receipts:signature-invalid", { sessionID, receiptID })
      this.persist(sessionID)
      return null
    }

    if (!this.isStale(receipt)) return receipt

    const remaining = (this.bySession.get(sessionID) ?? []).filter((candidate) => candidate.id !== receiptID)
    if (remaining.length > 0) this.bySession.set(sessionID, remaining)
    else this.bySession.delete(sessionID)
    this.logger("receipts:stale-dropped", { sessionID, receiptID, observedAt: receipt.observedAt })
    this.persist(sessionID)
    return null
  }

  /**
   * Hydrates a session's persisted receipts from `workspaceRoot`. Needed
   * because `get()`'s two-argument signature carries no workspace, so after a
   * process restart nothing else can tell the store where to look. Callers
   * that hold the session's workspace root (`wiring/tools.ts`; ideally also
   * `plugin.ts`'s `getOrCreateState`, next to `pinStore.load`) call this
   * before the first lookup. Idempotent and never throws.
   */
  load(sessionID: string, workspaceRoot: string): void {
    const resolved = resolve(workspaceRoot)
    if (this.rootBySession.get(sessionID) !== resolved) {
      this.rootBySession.set(sessionID, resolved)
      this.hydratedSessions.delete(sessionID)
    }
    this.hydrate(sessionID)
  }

  /** Retires every receipt for a session — in memory AND on disk, so a
   * mutation-driven invalidation cannot be undone by restarting the process. */
  invalidate(sessionID: string): void {
    this.bySession.delete(sessionID)
    this.persist(sessionID)
  }

  // -- internals ------------------------------------------------------------

  private stateDirFor(workspaceRoot: string): string {
    return this.stateDirOverride ?? join(workspaceRoot, PLUGIN_STATE_DIR)
  }

  private safeScopeLink(sessionID: string, stateDir: string): { storyId: string | null; paths: string[] } {
    try {
      const link = this.resolveScopeLink(sessionID, stateDir)
      return {
        storyId: typeof link.storyId === "string" ? link.storyId : null,
        paths: Array.isArray(link.paths) ? link.paths.filter((path) => typeof path === "string") : [],
      }
    } catch {
      return { storyId: null, paths: [] }
    }
  }

  private isStale(receipt: VerificationReceipt): boolean {
    const scope = receipt.scope
    // No scope at all: unprovable, therefore refused. `record()` always sets
    // one, and `isPersistedReceipt` rejects scope-less entries on read, so
    // this only fires for a receipt handed in from outside this store.
    if (!scope) return true
    // Incomplete scope: never persisted (see `persist`), so this receipt is
    // in-memory-only and still governed by layer 1 (`invalidate` on
    // mutation) exactly as it was before persistence existed.
    // FAIL CLOSED. This returned false ("not stale, serve it"), so a receipt
  // whose scope could not be fingerprinted -- a worktree past the file/byte
  // ceiling -- was treated as permanently fresh. Measured: with an oversized
  // worktree, deleting the entire `src/` tree left the receipt valid. An
  // unprovable scope is exactly the case where evidence must NOT be trusted,
  // and line :618 already takes that view of the current side.
  if (!scope.complete) return true
    const current = fingerprintWorktree(receipt.workspaceRoot)
    if (!current.complete) return true // cannot prove freshness now => refuse
    return current.digest !== scope.worktreeDigest
  }

  private hydrate(sessionID: string): void {
    if (this.hydratedSessions.has(sessionID)) return
    const workspaceRoot = this.rootBySession.get(sessionID)
    if (!workspaceRoot) return
    this.hydratedSessions.add(sessionID)

    let file: ReceiptsFile
    try {
      file = this.readFile(this.stateDirFor(workspaceRoot))
    } catch {
      return // corrupt/unreadable — serve whatever is in memory
    }
    const persisted = file.sessions[sessionID]?.receipts ?? []
    if (persisted.length === 0) return

    const memory = this.bySession.get(sessionID) ?? []
    const known = new Set(memory.map((receipt) => receipt.id))
    const merged = [...memory]
    for (const receipt of persisted) {
      if (!known.has(receipt.id)) merged.push(receipt)
    }
    merged.sort((a, b) => (a.observedAt < b.observedAt ? -1 : a.observedAt > b.observedAt ? 1 : 0))
    this.bySession.set(sessionID, merged.slice(-MAX_RECEIPTS_PER_SESSION))
  }

  /** Read + validate `receipts.json`. Throws `CorruptReceiptsFileError` when
   * the JSON itself is unparseable; archives (never deletes) a file written
   * by a different schema version, mirroring `story.ts`'s v1 archival. */
  private readFile(stateDir: string): ReceiptsFile {
    const empty: ReceiptsFile = { schemaVersion: RECEIPTS_SCHEMA_VERSION, sessions: {} }
    const receiptsPath = join(stateDir, RECEIPTS_FILE_NAME)
    if (!existsSync(receiptsPath)) return empty

    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(receiptsPath, "utf8"))
    } catch (error) {
      throw new CorruptReceiptsFileError((error as Error).message)
    }
    if (!isRecord(parsed)) return empty
    if (parsed.schemaVersion !== RECEIPTS_SCHEMA_VERSION) {
      this.archiveReceiptsFile(stateDir, receiptsPath)
      return empty
    }
    if (!isRecord(parsed.sessions)) return empty

    const sessions: Record<string, ReceiptsFileEntry> = {}
    for (const [sessionID, entry] of Object.entries(parsed.sessions)) {
      if (!isRecord(entry) || !isValidTimestamp(entry.updatedAt) || !Array.isArray(entry.receipts)) continue
      const receipts = entry.receipts.filter(isPersistedReceipt)
      if (receipts.length === 0) continue
      sessions[sessionID] = { updatedAt: entry.updatedAt, receipts }
    }
    return { schemaVersion: RECEIPTS_SCHEMA_VERSION, sessions }
  }

  private archiveReceiptsFile(stateDir: string, receiptsPath: string): void {
    try {
      const archiveDirectory = join(stateDir, "archive")
      mkdirSync(archiveDirectory, { recursive: true, mode: 0o700 })
      const stamp = new Date().toISOString().replace(/[:.]/g, "-")
      let archivePath = join(archiveDirectory, `receipts.${stamp}.json`)
      let suffix = 0
      while (existsSync(archivePath)) {
        suffix += 1
        archivePath = join(archiveDirectory, `receipts.${stamp}-${suffix}.json`)
      }
      renameSync(receiptsPath, archivePath)
      this.logger("receipts:schema-archived", { archivePath })
    } catch (error) {
      this.logger("receipts:archive-failed", { reason: (error as Error).message })
    }
  }

  /**
   * Write this session's receipts through. Never throws: a disk fault
   * degrades to memory-only for the session (the pre-persistence behaviour),
   * it does not fail the verification that produced the receipt.
   */
  private persist(sessionID: string): void {
    const workspaceRoot = this.rootBySession.get(sessionID)
    if (!workspaceRoot) return
    const stateDir = this.stateDirFor(workspaceRoot)
    try {
      withFileLock(join(stateDir, RECEIPTS_LOCK_NAME), () => {
        const file = this.readFile(stateDir)
        // Only receipts whose freshness can actually be re-proven later are
        // written; an incomplete scope on disk would be an unfalsifiable
        // claim, and that is the exact shape of an evidence fabrication.
        const durable = (this.bySession.get(sessionID) ?? []).filter((receipt) => receipt.scope?.complete === true)
        if (durable.length > 0) {
          file.sessions[sessionID] = { updatedAt: new Date().toISOString(), receipts: durable }
        } else {
          delete file.sessions[sessionID]
        }
        this.pruneExpired(file)

        const receiptsPath = join(stateDir, RECEIPTS_FILE_NAME)
        if (Object.keys(file.sessions).length === 0) {
          if (existsSync(receiptsPath)) unlinkSync(receiptsPath)
          return
        }
        atomicWriteJson(stateDir, receiptsPath, `.receipts.`, file)
      })
    } catch (error) {
      const event = error instanceof CorruptReceiptsFileError ? "receipts:disk-corrupt" : "receipts:disk-unavailable"
      this.logger(event, { sessionID, path: join(stateDir, RECEIPTS_FILE_NAME), reason: (error as Error).message })
    }
  }

  private pruneExpired(file: ReceiptsFile): void {
    const cutoff = Date.now() - RECEIPTS_MAX_AGE_MS
    for (const [sessionID, entry] of Object.entries(file.sessions)) {
      const updated = Date.parse(entry.updatedAt)
      if (!Number.isFinite(updated) || updated < cutoff) delete file.sessions[sessionID]
    }
  }
}

/** Atomic write (`wx` temp file + rename, mode 0600) — the same discipline
 * `writePlan` above and `pin.ts`/`story.ts` use. */
function atomicWriteJson(stateDir: string, targetPath: string, tempPrefix: string, value: unknown): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const temporaryPath = join(stateDir, `${tempPrefix}${process.pid}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(redactForDisk(value), null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    })
    renameSync(temporaryPath, targetPath)
    chmodSync(targetPath, 0o600)
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath)
  }
}

/** Dedicated-file variant of `MultiStoryGoalEngine.withLock` (same 30s stale
 * reclaim). Deliberately its own lock file rather than the shared
 * `state.lock` `pin.ts`/`story.ts` take: receipt writes happen inside
 * `StoryEngine.checkpoint`'s validation callback, and reusing their lock
 * there would risk a self-deadlock the moment either module starts holding it
 * across a callback. */
function withFileLock<T>(lockPath: string, operation: () => T): T {
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 })
  let descriptor: number | null = null
  let ownsLock = false
  try {
    try {
      descriptor = openSync(lockPath, "wx", 0o600)
      ownsLock = true
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "EEXIST" || Date.now() - statSync(lockPath).mtimeMs < STALE_LOCK_MS) {
        throw new Error(`elicify-vertex state file is locked by another process: ${lockPath}`)
      }
      unlinkSync(lockPath)
      descriptor = openSync(lockPath, "wx", 0o600)
      ownsLock = true
    }
    return operation()
  } finally {
    if (descriptor !== null) closeSync(descriptor)
    if (ownsLock && existsSync(lockPath)) unlinkSync(lockPath)
  }
}

export class MultiStoryGoalEngine {
  readonly root: string
  readonly stateDirectory: string
  readonly statePath: string
  readonly ledgerPath: string
  private readonly lockPath: string
  private readonly now: () => string

  constructor(root: string, now: () => string = () => new Date().toISOString()) {
    const resolved = resolve(root)
    if (!isWritableGoalRoot(resolved)) {
      throw new Error(
        "elicify-vertex goals need a writable project directory (not filesystem root). " +
          `Refused root: ${resolved}`,
      )
    }
    this.root = resolved
    this.stateDirectory = join(this.root, PLUGIN_STATE_DIR)
    this.statePath = join(this.stateDirectory, "goals.json")
    this.ledgerPath = join(this.stateDirectory, "goals.ledger.jsonl")
    this.lockPath = join(this.stateDirectory, "goals.lock")
    this.now = now
  }

  create(brief: string, stories: readonly GoalStoryInput[], replace = false): GoalPlan {
    return this.withLock(() => {
      if (existsSync(this.statePath) && !replace) {
        throw new Error(`goal plan already exists at ${this.statePath}`)
      }
      if (stories.length === 0) throw new Error("at least one work story is required")
      const cleanStories = stories.map((story, index): GoalStory => ({
        id: `G${String(index + 1).padStart(3, "0")}`,
        ordinal: index + 1,
        kind: "work",
        title: requireNonBlank(story.title, `stories[${index}].title`),
        objective: requireNonBlank(story.objective, `stories[${index}].objective`),
        status: "pending",
        evidence: null,
        startedAt: null,
        completedAt: null,
        verification: null,
      }))
      const finalOrdinal = cleanStories.length + 1
      cleanStories.push({
        id: `G${String(finalOrdinal).padStart(3, "0")}`,
        ordinal: finalOrdinal,
        kind: "verification",
        title: "Final verification",
        objective: "Run the integrated exit proof and checkpoint its observed successful verification receipt.",
        status: "pending",
        evidence: null,
        startedAt: null,
        completedAt: null,
        verification: null,
      })

      if (replace && existsSync(this.statePath)) this.archiveCurrentPlan()
      const timestamp = this.now()
      const plan: GoalPlan = {
        schemaVersion: 1,
        revision: 1,
        brief: requireNonBlank(brief, "brief"),
        status: "active",
        activeStoryId: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        stories: cleanStories,
      }
      this.writePlan(plan)
      this.appendLedger({ event: "plan_created", revision: plan.revision, storyCount: plan.stories.length })
      return plan
    })
  }

  next(): GoalPlan {
    return this.withLock(() => {
      const plan = this.requirePlan()
      if (plan.status !== "active") throw new Error(`goal plan is ${plan.status}; no story can be started`)
      if (plan.activeStoryId) return plan
      const nextStory = plan.stories.find((story) => story.status === "pending")
      if (!nextStory) throw new Error("goal plan has no pending story but is not complete")
      nextStory.status = "in_progress"
      nextStory.startedAt = this.now()
      plan.activeStoryId = nextStory.id
      this.touch(plan)
      this.writePlan(plan)
      this.appendLedger({ event: "story_started", revision: plan.revision, storyID: nextStory.id })
      return plan
    })
  }

  checkpoint(
    storyID: string,
    status: Exclude<StoryStatus, "pending" | "in_progress">,
    evidence: string,
    receipt: VerificationReceipt | null = null,
  ): GoalPlan {
    return this.withLock(() => {
      const plan = this.requirePlan()
      if (plan.status !== "active") throw new Error(`goal plan is ${plan.status}; checkpoints are closed`)
      const story = plan.stories.find((candidate) => candidate.id === storyID)
      if (!story) throw new Error(`unknown story: ${storyID}`)
      if (story.id !== plan.activeStoryId || story.status !== "in_progress") {
        throw new Error(`story ${storyID} is not the active in-progress story`)
      }
      const cleanEvidence = requireNonBlank(evidence, "evidence")
      const checkpointedAt = this.now()

      if (status === "complete" && story.kind === "verification") {
        const previousComplete = plan.stories
          .filter((candidate) => candidate.ordinal < story.ordinal)
          .every((candidate) => candidate.status === "complete")
        if (!previousComplete) throw new Error("final verification cannot complete before every work story")
        if (!receipt || receipt.outcome !== "verified" || receipt.exitCode !== 0) {
          throw new Error("final verification requires an observed successful verification receipt")
        }
        if (resolve(receipt.workspaceRoot) !== this.root) {
          throw new Error("verification receipt belongs to a different workspace")
        }
        if (!story.startedAt || receipt.observedAt < story.startedAt) {
          throw new Error("verification receipt predates the final verification story")
        }
        if (receipt.observedAt > checkpointedAt) {
          throw new Error("verification receipt timestamp is in the future")
        }
        story.verification = receipt
      } else if (receipt) {
        throw new Error("verification receipts are accepted only by the final verification story")
      }

      story.status = status
      story.evidence = cleanEvidence
      story.completedAt = checkpointedAt
      plan.activeStoryId = null
      if (status === "failed" || status === "blocked") {
        plan.status = status
      } else if (story.kind === "verification") {
        plan.status = "complete"
      }
      this.touch(plan)
      this.writePlan(plan)
      this.appendLedger({
        event: "checkpoint",
        revision: plan.revision,
        storyID: story.id,
        status,
        evidence: cleanEvidence,
        verificationReceiptID: receipt?.id ?? null,
      })
      return plan
    })
  }

  status(): GoalPlan | null {
    if (!existsSync(this.statePath)) return null
    return this.readPlan()
  }

  private touch(plan: GoalPlan): void {
    plan.revision += 1
    plan.updatedAt = this.now()
  }

  private requirePlan(): GoalPlan {
    if (!existsSync(this.statePath)) throw new Error(`no goal plan at ${this.statePath}`)
    return this.readPlan()
  }

  private readPlan(): GoalPlan {
    let value: unknown
    try {
      value = JSON.parse(readFileSync(this.statePath, "utf8"))
    } catch (error) {
      throw new Error(`cannot read goal plan ${this.statePath}: ${(error as Error).message}`)
    }
    this.validatePlan(value)
    return value
  }

  private validatePlan(value: unknown): asserts value is GoalPlan {
    if (!isRecord(value) || value.schemaVersion !== 1 || !Number.isInteger(value.revision)) {
      throw new Error("invalid goal plan header")
    }
    if (typeof value.brief !== "string" || typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") {
      throw new Error("invalid goal plan metadata")
    }
    if (typeof value.status !== "string" || !PLAN_STATUSES.has(value.status as PlanStatus)) {
      throw new Error("invalid goal plan status")
    }
    if (value.activeStoryId !== null && typeof value.activeStoryId !== "string") {
      throw new Error("invalid activeStoryId")
    }
    if (!Array.isArray(value.stories) || value.stories.length < 2) throw new Error("invalid goal story list")

    const ids = new Set<string>()
    let activeID: string | null = null
    for (const [index, rawStory] of value.stories.entries()) {
      if (!isRecord(rawStory)
        || typeof rawStory.id !== "string"
        || typeof rawStory.title !== "string"
        || typeof rawStory.objective !== "string"
        || typeof rawStory.status !== "string"
        || !STORY_STATUSES.has(rawStory.status as StoryStatus)
        || rawStory.ordinal !== index + 1
        || (rawStory.kind !== "work" && rawStory.kind !== "verification")) {
        throw new Error(`invalid goal story at index ${index}`)
      }
      if (ids.has(rawStory.id)) throw new Error(`duplicate goal story id: ${rawStory.id}`)
      ids.add(rawStory.id)
      if (rawStory.status === "in_progress") {
        if (activeID) throw new Error("multiple in-progress goal stories")
        activeID = rawStory.id
      }
    }
    const finalStory = value.stories[value.stories.length - 1] as unknown as GoalStory
    if (finalStory.kind !== "verification" || value.stories.slice(0, -1).some((story) => (story as GoalStory).kind !== "work")) {
      throw new Error("final goal story must be the only verification story")
    }
    if ((value.activeStoryId ?? null) !== activeID) throw new Error("activeStoryId does not match in-progress story")
    if (value.status !== "active" && activeID) throw new Error("terminal goal plan contains an active story")
    if (value.status === "complete") {
      if (value.stories.some((story) => (story as GoalStory).status !== "complete")) {
        throw new Error("complete goal plan contains unfinished stories")
      }
      if (!isRecord(finalStory.verification)
        || typeof finalStory.verification.id !== "string" || !finalStory.verification.id.trim()
        || typeof finalStory.verification.sessionID !== "string" || !finalStory.verification.sessionID.trim()
        || typeof finalStory.verification.workspaceRoot !== "string"
        || resolve(finalStory.verification.workspaceRoot) !== this.root
        || typeof finalStory.verification.command !== "string" || !finalStory.verification.command.trim()
        || typeof finalStory.verification.outputSummary !== "string"
        || !isValidTimestamp(finalStory.verification.observedAt)
        || finalStory.verification.outcome !== "verified"
        || finalStory.verification.exitCode !== 0
        || typeof finalStory.evidence !== "string" || !finalStory.evidence.trim()
        || !isValidTimestamp(finalStory.startedAt)
        || !isValidTimestamp(finalStory.completedAt)
        || finalStory.verification.observedAt < finalStory.startedAt
        || finalStory.verification.observedAt > finalStory.completedAt) {
        throw new Error("complete goal plan lacks a successful final verification receipt")
      }
    }
    if ((value.status === "failed" || value.status === "blocked")
      && !value.stories.some((story) => (story as GoalStory).status === value.status)) {
      throw new Error(`goal plan status ${value.status} has no matching story`)
    }
  }

  private writePlan(plan: GoalPlan): void {
    mkdirSync(this.stateDirectory, { recursive: true, mode: 0o700 })
    const temporaryPath = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporaryPath, `${JSON.stringify(redactForDisk(plan), null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      })
      renameSync(temporaryPath, this.statePath)
      chmodSync(this.statePath, 0o600)
    } finally {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath)
    }
  }

  private appendLedger(payload: Record<string, unknown>): void {
    const event = redactForDisk({ ts: this.now(), ...payload })
    appendFileSync(this.ledgerPath, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 })
    chmodSync(this.ledgerPath, 0o600)
  }

  private archiveCurrentPlan(): void {
    const archiveDirectory = join(this.stateDirectory, "archive")
    mkdirSync(archiveDirectory, { recursive: true, mode: 0o700 })
    const archivePath = join(archiveDirectory, `${basename(this.statePath, ".json")}-${Date.now()}.json`)
    copyFileSync(this.statePath, archivePath)
    chmodSync(archivePath, 0o600)
  }

  private withLock<T>(operation: () => T): T {
    mkdirSync(dirname(this.lockPath), { recursive: true, mode: 0o700 })
    let descriptor: number | null = null
    let ownsLock = false
    try {
      try {
        descriptor = openSync(this.lockPath, "wx", 0o600)
        ownsLock = true
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== "EEXIST" || Date.now() - statSync(this.lockPath).mtimeMs < STALE_LOCK_MS) {
          throw new Error("goal plan is being modified by another process")
        }
        unlinkSync(this.lockPath)
        descriptor = openSync(this.lockPath, "wx", 0o600)
        ownsLock = true
      }
      return operation()
    } finally {
      if (descriptor !== null) closeSync(descriptor)
      if (ownsLock && existsSync(this.lockPath)) unlinkSync(this.lockPath)
    }
  }
}
