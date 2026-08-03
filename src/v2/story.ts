/**
 * Vertex 2 — story.ts (US-5: FR-017 through FR-022, FR-018/018a/018b).
 *
 * Owns two on-disk concerns under `.opencode/elicify-vertex/`:
 *
 *  1. `plan.json` — the v2 story contract plan, session-keyed
 *     (`Record<sessionID, PlanV2>`), written under the SAME shared
 *     directory lock `pin.ts` exports (`acquireStateLock`, imported not
 *     reimplemented, per the module-contracts doc's explicit instruction).
 *  2. Detecting and archiving a stale v1 `goals.json` (FR-022) — reversibly,
 *     byte-identical, via an atomic rename (never copy+delete), never
 *     touching anything already under `archive/`.
 *
 * Plus the FR-018/018a/018b intake pre-filter and multi-story classifier:
 * a cost-gated (`TRIVIAL_ASK_RE`), subturn-first (`vertex-intake`,
 * `subturn.ts`'s `runSubturn`), heuristic-fallback (`SEQUENCING_WORDS` /
 * `IMPERATIVE_VERBS`) classification with a 5s total internal budget.
 *
 * ---------------------------------------------------------------------
 * Documented deviations from `docs/vertex2-module-contracts.md` §9
 * (each one is restated in this wave's final report, per that doc's own
 * "flag the conflict" instruction when the spec and the contract disagree,
 * or when the contract's public surface has a gap this module must fill
 * to be usable at all):
 *
 *  - `attachEvidence` and `amendStory` are ADDED. The contract's `StoryV2`
 *    type carries `acceptanceItems[].evidence` and `amendments`, but the
 *    §9 contract lists no method that ever WRITES either field. Both
 *    methods mirror `pin.ts`'s `attachEvidence` shape/spirit as closely as
 *    the different schema allows. NOTE (HANDOVER.md redesign point 1):
 *    `attachEvidence` is now a LEGACY write path — `checkpoint` no longer
 *    reads or requires per-item evidence (see its doc comment), so nothing
 *    new should call it; it stays only so pre-redesign plan.json files
 *    with attached evidence still round-trip.
 *  - `checkScope` takes an additional optional third parameter
 *    (`opts?: { scopeGlobsMatchedZero?: boolean }`). The spec's edge case
 *    ("Story scope globs stop matching after a branch switch ... the
 *    directive text offers `amend` first when the plan's globs match
 *    **zero** files in the worktree") requires knowing whether the globs
 *    match anything **in the worktree as a whole**, which `checkScope`'s
 *    two-argument contract signature (`sessionID`, `mutatedPath`) cannot
 *    determine on its own without either (a) doing real fs/glob work
 *    inside this module — breaking the "pure, injectable, no real fs
 *    inside pure functions" convention `resolve.ts` established — or
 *    (b) accepting caller-supplied data, which is that same convention's
 *    actual solution (`resolve.ts`'s `ResolveDeps.readManifest`). This
 *    module follows (b). Omitting the option defaults
 *    `scopeGlobsMatchedZero` to `false` (the common single-mutation-drift
 *    case), so existing two-argument call sites keep compiling and behave
 *    exactly as the contract's two-argument signature implies.
 *  - `classifyMultiStory` calls `subturn.ts`'s `probeCapability` and
 *    `buildDenyMap` internally, even though the §9 contract's `deps`
 *    parameter (`{ selfCreated, logger }`) has no slot for a pre-built
 *    deny map or a cached probe result. This is not optional: FR-030b
 *    (review CRIT-002) requires the deny-all capability probe to run,
 *    and be honoured, before ANY subturn — including the intake one — is
 *    issued ("intake:unsupported" is the intake-side twin of
 *    "judge:unsupported" throughout FR-030b's text and the Integration
 *    Boundaries table: "Same probe dependency as the judge"). More
 *    directly, `subturn.ts`'s own `runSubturn` doc comment names the
 *    caller responsible for this by module: "Does NOT call
 *    probeCapability — that is the caller's (judge.ts / story.ts)
 *    responsibility to run first". This module IS that caller. Because
 *    the given `deps` shape has no seam for a caller-cached deny map or
 *    probe result, both are re-computed on every non-trivial
 *    `classifyMultiStory` call rather than cached once per process (the
 *    FR-030b ideal) — flagged in the wave-2 report as a follow-up for
 *    wave-3 wiring, which could extend `deps` with an optional
 *    pre-verified capability to skip the redundant `client.app.agents()`
 *    round trip.
 * ---------------------------------------------------------------------
 * 2026-07-29 redesign (HANDOVER.md "Agreed redesign direction" points 1,
 * 5, 6): `checkpoint` is now a bare completion CLAIM — the per-acceptance-
 * item receipt/waiver citation (and `opts.isValidReceipt`) was removed
 * after a real session showed the model fabricating plausible receipt ids
 * 13 times in a row, then blocking every story rather than completing it.
 * Verification moved OUT of this module to an independent completion judge
 * (runs at session.idle with real tools), whose per-story verdicts arrive
 * here via `applyJudgeVerdicts` and can REVERT an over-claimed story back
 * to "active".
 *
 * 2026-07-30 redesign (task/DAG completion model, supersedes the wave
 * model above): the atomic execution unit is now the TASK, not the story.
 * Each story MUST decompose into ≥1 `Task`; the model declares each task's
 * `dependsOn` (other task ids, cross-story allowed) and an optional
 * story-level `dependsOn` (other story ids — every task in this story
 * then depends on every task of those predecessors). The engine COMPUTES
 * parallel waves from that dependency DAG as topological levels
 * (longest-path layering: `level(t) = 0` if no deps, else
 * `1 + max(level(dep))`). All level-0 tasks start `"active"` at once;
 * `checkpoint` operates on a TASK id and, whenever no task remains active
 * anywhere, promotes every pending task at the next-lowest pending level
 * to active. Story status becomes DERIVED from its tasks (stored, but
 * never input): all tasks complete → complete; any active → active; else
 * failed/blocked/pending by the worst terminal task. The old stored
 * `StoryV2.wave` field and `waveOf` helper are GONE — waves are computed,
 * never stored or input, so a reader never has to trust a stale number.
 * The C-11 final-story guard is now naturally enforced by the DAG (a
 * final story that depends on its siblings cannot have all tasks complete
 * until those siblings are done), so no redundant guard is kept.
 * ---------------------------------------------------------------------
 * 2026-08-03 judge-reliability fixes (docs/JUDGE-RELIABILITY-FIXES-SPEC.md,
 * FR-002/002a-d, FR-003, FR-004). All three are grounded in one audited live
 * session (`ses_04dc77bdaffej8SFJvYm5yO0CW`):
 *
 *  - FR-002 (concurrent-write data loss). Two plugin runtimes drove that
 *    session and both wrote `plan.json`; a judge stamp provably written at
 *    10:26:28 is ABSENT from the final file, and S6 carries no stamp at all.
 *    Cause: `getPlan` cached the session's plan forever, mutations were
 *    applied to that cached object, and `persistPlan` then did
 *    `file = {...file, [sessionID]: current}` under a lock that protected
 *    only the WRITE — so a stale cache silently overwrote a peer's stamp.
 *    Every mutation now routes through the private `mutate` seam below,
 *    which takes the lock ONCE, re-reads `plan.json`, reconciles the disk
 *    state into the cached object **in place**, runs the mutation, writes,
 *    and releases. Four constraints two grill rounds established, each of
 *    which kills the naive version of this fix:
 *      C4  — re-hydrating inside `persistPlan` would DISCARD the caller's
 *            own mutation (mutations are applied before persist is called),
 *            so the re-read must happen BEFORE the mutation, not after.
 *      M-5 — `acquireStateLock` is NOT reentrant (it throws on EEXIST) and
 *            `archiveV1IfPresent` takes the SAME lock at the top of
 *            `createPlan`/`checkScope`/`checkpoint`; every such call is
 *            therefore hoisted ABOVE its `mutate`, and `archiveV1IfPresent`
 *            additionally skips re-acquiring when this engine already holds
 *            the lock (`lockHeld`), so the deadlock-throw is structurally
 *            impossible rather than merely avoided by call ordering.
 *      M-5 — merging on-disk state into a CLEARED or REPLACED plan would
 *            resurrect deleted stories, hence the three `mutate` modes
 *            (`merge` | `replace` | `delete`); only `merge` reconciles.
 *      gate.ts:742-753 documents a load-bearing OBJECT IDENTITY assumption
 *            (`applyJudgeVerdicts` stamps in place on the plan object the
 *            gate closure already holds, and the close-out then re-reads
 *            `plan.stories`). Reconciliation therefore assigns field-by-
 *            field into the existing plan/story/task objects and splices
 *            arrays in place — it never swaps a reference.
 *  - FR-002c/FR-010: `acquireStateLock` throws rather than waits, so
 *    `mutate` retries with bounded jittered backoff and, on exhaustion,
 *    logs and ABORTS THE WRITE. It never throws into the host.
 *  - FR-002d: `PlanV2.revision` is a per-session monotonic write counter —
 *    the signal that defines when `plan:concurrent-merge` fires. Coerced at
 *    the disk boundary for revision-less files exactly like `dependsOn`.
 *  - FR-003 (checkpoint idempotency). 23 of 82 checkpoint calls in the
 *    audited session failed with "cannot complete task X: it is not active"
 *    because the harness's own revert directive orders "checkpoint each
 *    reverted task complete again". Re-completing an ALREADY-COMPLETE task
 *    is now a logged no-op that mutates nothing (and skips the disk write
 *    entirely); pending/blocked/failed still throw — those are genuine
 *    out-of-order claims, not re-claims.
 *  - FR-004 (a reopened story can be re-audited). `reopenStory` cleared
 *    `story.completedAt` while the gate's audit filter (gate.ts:794)
 *    requires `completedAt !== undefined` — so a story reopened while
 *    `complete` (observed 3x: `previousStatus: complete -> newStatus:
 *    complete`) became permanently invisible to the judge. It now stamps a
 *    FRESH `completedAt` whenever the derived status is still `complete`.
 * ---------------------------------------------------------------------
 */

import { randomUUID } from "node:crypto"
import * as fsNode from "node:fs"
import { join } from "node:path"

import { redactForDisk } from "../redaction.js"
import { acquireStateLock } from "./pin.js"
import { SelfCreatedSessions, buildDenyMap, probeCapability, runSubturn } from "./subturn.js"
import type { EventLogger, OpencodeClient } from "./types.js"

/** Same fs-seam pattern `pin.ts` established (see that file's header comment
 * for why `vi.spyOn` cannot target `node:fs`'s namespace import directly on
 * this project's vitest/Node combination) — each v2 module that needs fault
 * injection owns its own copy rather than sharing `pin.ts`'s instance. */
export const fsIO = {
  existsSync: fsNode.existsSync,
  mkdirSync: fsNode.mkdirSync,
  readFileSync: fsNode.readFileSync,
  writeFileSync: fsNode.writeFileSync,
  renameSync: fsNode.renameSync,
  chmodSync: fsNode.chmodSync,
  unlinkSync: fsNode.unlinkSync,
}

/**
 * FR-002c seam (same rationale as `fsIO`): the lock acquisition and the
 * backoff sleep `mutate` performs, behind an injectable indirection so a
 * test can force contention without racing a real second process, and can
 * collapse the backoff to zero instead of spending real wall-clock seconds.
 * `archiveV1IfPresent` deliberately does NOT go through this seam — its lock
 * is a different concern (an atomic rename of a v1 file) and keeping it on
 * the raw import lets a contention test isolate `mutate`.
 */
export const lockIO = {
  acquire(stateDir: string): { release(): void } {
    return acquireStateLock(stateDir)
  },
  /**
   * Synchronous sleep. Everything on this path is synchronous (the story
   * tools are sync, and `plan.json` is written from inside `checkpoint`), so
   * a promise-based delay is not available; `Atomics.wait` on a throwaway
   * `SharedArrayBuffer` is the standard way to block a Node main thread for
   * a bounded time. If it is unavailable for any reason the retry simply
   * happens immediately rather than failing — a degraded retry beats a
   * thrown error (FR-010).
   *
   * MIN-005 (code review, 2026-08-03) — THIS BLOCKS THE HOST'S EVENT LOOP.
   * The plugin runs in-process inside opencode, so every millisecond spent
   * here freezes the whole server, not just this call. An async sleep is the
   * only way to avoid that and is NOT available: all seven `mutate` callers
   * (`createPlan`, `checkpoint`, `applyJudgeVerdicts`, `reopenStory`,
   * `clearPlan`, `amendStory`, `attachEvidence`) are synchronous methods,
   * called synchronously from `wiring/tools.ts`, `wiring/gate.ts` and
   * `plugin.ts`, so making this awaitable means turning the whole
   * StoryEngine mutation surface async across four modules — a change no
   * bounded-blocking defect justifies. The blocking is capped instead — see
   * `MUTATE_LOCK_MAX_BLOCK_MS` below for the budget and the trade-off it
   * buys.
   */
  sleep(ms: number): void {
    if (!(ms > 0)) return
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
    } catch {
      /* no blocking primitive available — retry without waiting */
    }
  },
}

/**
 * FR-002c: `acquireStateLock` THROWS on contention (EEXIST) rather than
 * waiting, and a peer's critical section is a couple of milliseconds of
 * read-modify-write, so a short bounded retry converts almost every real
 * collision into a successful write. Spec wording: "bounded jittered retry
 * (5 x 100ms), then log and abort the write — NEVER throw into the host".
 * One initial attempt plus `MUTATE_LOCK_RETRIES` retries, each preceded by
 * a jittered `0.5x..1.5x` backoff, and the common case is one uncontended
 * attempt with no sleep at all.
 *
 * MIN-005 (code review, 2026-08-03): the spec's literal `100ms` unit made
 * the worst case ~750ms of `Atomics.wait` — a three-quarter-second freeze of
 * the HOST's event loop (see `lockIO.sleep`) inside a synchronous tool call,
 * paid whenever the lock is genuinely stuck. The retry COUNT is kept (it is
 * the spec's bound and what the FR-002c tests assert); the unit drops to
 * `MUTATE_LOCK_BACKOFF_MS`, and `MUTATE_LOCK_MAX_BLOCK_MS` hard-caps the
 * SUM of the backoffs regardless of what the unit is later set to:
 *   5 retries x 6ms x 1.5 jitter = 45ms worst case, clamped at 50ms.
 *
 * The trade-off, stated precisely: a peer critical section longer than
 * ~45ms is no longer waited out, so the write aborts (logged
 * `plan:lock-contended` + `plan:write-aborted`) where it previously had up
 * to 750ms to succeed. That is the right side of the trade because (a) the
 * critical section is one small-file read + parse + in-place merge + atomic
 * rename — single-digit milliseconds, so 45ms already covers several
 * consecutive peer writes; (b) an aborted write is NOT lost work — the
 * mutation still applies in memory, the session keeps running, and the next
 * mutation re-reads and re-persists it (`revision` keeps the merge ordered);
 * (c) a lock held longer than that is usually a crashed peer, which no
 * amount of blocking fixes — `pin.ts` reclaims it as stale after 30s
 * anyway; and (d) blocking the host's event loop degrades every OTHER
 * session on the machine, while aborting degrades only this write.
 */
const MUTATE_LOCK_RETRIES = 5
const MUTATE_LOCK_BACKOFF_MS = 6
/** MIN-005: hard ceiling on the TOTAL synchronous block one `mutate` may
 * impose on the host event loop. Each backoff is clamped to the remaining
 * budget (and to a 1ms floor, so a retry never degenerates into a busy
 * spin that hammers the filesystem). */
const MUTATE_LOCK_MAX_BLOCK_MS = 50

// ---------------------------------------------------------------------------
// Public types (module-contracts.md §9)
// ---------------------------------------------------------------------------

export interface AcceptanceItem {
  id: string
  text: string
  /**
   * DEPRECATED (HANDOVER.md redesign point 1): per-item receipt/waiver
   * citations are no longer required, read, or reset by anything in this
   * module — `checkpoint` is now a bare claim and the completion judge
   * (via `applyJudgeVerdicts`) is the sole arbiter of whether the claim
   * was real. The field stays in the type, and the validators keep
   * accepting it, because plan.json files written before the redesign
   * carry it and must still load. Nothing here writes it anymore;
   * `attachEvidence` survives only as a legacy path for those old plans.
   */
  evidence: { receiptId: string } | { waiver: true; sourceMessageId: string; signature?: string } | null
}

/** HANDOVER.md redesign point 5: the completion judge's per-acceptance-item
 * note — which criteria are met, which aren't, and what's specifically
 * missing — so wiring can render per-story detail ("S2 not delivered — A3,
 * A4 still missing") instead of a generic nudge. */
export interface JudgeItemNote {
  itemId: string
  met: boolean
  note: string
}

/** The latest completion-judge audit stamped onto a story by
 * `applyJudgeVerdicts`. Stamps are history, not state: a story carries its
 * most recent verdict even after a later status change, so wiring can
 * always say WHY a story is where it is. */
export interface StoryJudgeStamp {
  pass: boolean
  summary: string
  items: JudgeItemNote[]
  judgedAt: string
  /**
   * FR-001b (2026-08-03): the ids of `met:false` items the HARNESS overruled
   * before this verdict was applied — the gate's path-existence cross-check
   * drops an item whose note claims a file is missing when that file
   * demonstrably exists, and re-derives `pass: true` when EVERY failing item
   * of the story was individually disproven.
   *
   * Absent (or empty) therefore means "a genuine, unmodified judge verdict".
   * The distinction is load-bearing: the plan close-out must never claim the
   * judge "independently verified" a story whose pass the harness derived —
   * the judge actually failed it and was overruled on deterministic grounds.
   * Optional on disk so plans written before this field existed still load
   * (mirrors `dependsOn`/`revision`).
   */
  contradictedItemIds?: string[]
}

/**
 * 2026-07-30 task/DAG redesign: the ATOMIC execution unit. A story is a
 * container for one or more tasks; fan-out reads tasks (one subagent per
 * active task), and `checkpoint` operates on a task id. `id` is GLOBALLY
 * unique within the plan, auto-assigned by the engine as `${storyId}.T${n}`
 * (e.g. "S1.T2") so the model can predict the ids and reference them in
 * other tasks' `dependsOn` before the plan is even created. `dependsOn`
 * names other TASK ids (cross-story allowed); it may also name a STORY id,
 * which the engine expands to "depends on every task of that story".
 */
export type TaskStatus = "pending" | "active" | "complete" | "blocked" | "failed"

export interface Task {
  id: string
  text: string
  /** Other TASK ids (cross-story allowed) and/or STORY ids. The engine
   * expands any story id to all of that story's task ids when building the
   * dependency DAG. Empty array = no deps → level 0 → active at create. */
  dependsOn: string[]
  status: TaskStatus
  /** ISO-8601 set the moment this task transitions to `"active"` (at
   * createPlan for level-0 tasks, at checkpoint's level-promotion
   * afterwards, at judge-revert, and at reopen). Optional so a task.json
   * written before activation still validates. */
  startedAt?: string
  /** ISO-8601 set on every `checkpoint(..., "complete", ...)`; cleared on
   * any non-complete outcome, judge revert, or reopen. */
  completedAt?: string
}

export interface StoryV2 {
  id: string
  text: string
  acceptanceItems: AcceptanceItem[]
  scopeGlobs: string[]
  verifiers: string[]
  assumptions: string[]
  rejectedAlternatives: string[]
  amendments: Array<{ reason: string; ts: string }>
  /**
   * DEVIATION from the literal §9 contract: the contract's `StoryV2.status`
   * field type is `"pending" | "active" | "complete" | "blocked"` — no
   * `"failed"` — but the SAME contract's `checkpoint` method signature,
   * three lines below it in the same document, is
   * `status: "complete" | "failed" | "blocked"`. Those two cannot both be
   * literally true: a `checkpoint(..., "failed", ...)` call has to store
   * that status somewhere. `"failed"` is added here to make the two
   * internally consistent, matching v1's `StoryStatus` precedent.
   *
   * 2026-07-30: story status is now DERIVED from its tasks (and stored):
   * all tasks complete → complete; any task active → active; else the
   * worst terminal task (failed beats blocked) or pending. It is recomputed
   * by `recomputeStoryStatuses` after every checkpoint / judge verdict /
   * reopen, never input by the caller.
   */
  status: "pending" | "active" | "complete" | "blocked" | "failed"
  /**
   * ADDED — wave-4 cross-file dependency (`wiring/tools.ts`'s FR-020
   * "time-valid receipt" check: a receipt observed BEFORE the story started
   * shouldn't count as evidence for it). ISO-8601 timestamp set the moment
   * this story's status transitions to `"active"` (when its first task
   * activates). Deliberately OPTIONAL so a `plan.json` written before this
   * field existed still validates on load (`isStoryV2` accepts it absent).
   */
  startedAt?: string
  /**
   * ADDED (HANDOVER.md redesign point 1): ISO-8601 timestamp set when the
   * story becomes `"complete"` (all its tasks complete). Cleared when a
   * judge verdict reverts the story to `"active"` (or when a task is
   * checkpointed to a non-complete status / reopened).
   */
  completedAt?: string
  /**
   * ADDED (HANDOVER.md redesign points 1/5): the latest completion-judge
   * audit of this story. Written only by `applyJudgeVerdicts`.
   */
  judge?: StoryJudgeStamp
  /**
   * ADDED (2026-07-30 task/DAG redesign): the atomic execution units this
   * story decomposes into. REQUIRED (≥1) — a story with no tasks is a
   * model error; decomposition is the whole point of the redesign. The
   * engine assigns each task's `id` (`${storyId}.T${n}`) and initial
   * `status` ("pending"); the model supplies `text` and optional
   * `dependsOn` only.
   */
  tasks: Task[]
  /**
   * ADDED (2026-07-30 task/DAG redesign): STORY-level dependency — references
   * other STORY ids. Semantics: every task in THIS story implicitly depends
   * on every task of the named predecessor stories (the story cannot start
   * until those stories are fully done). The engine bakes these into the
   * task DAG as edges, so topological-level promotion honours them
   * automatically. Default `[]`; optional on disk so a plan.json written
   * before this field existed still loads (treated as `[]`).
   */
  dependsOn: string[]
}

export interface PlanV2 {
  schemaVersion: 2
  stories: StoryV2[]
  finalStoryId: string
  createdAt: string
  /**
   * ADDED (FR-002d, 2026-08-03): a per-session MONOTONIC write counter,
   * bumped by exactly one on every successful `plan.json` write for this
   * session. It exists to answer one question the old code could not ask at
   * all: "did somebody else write this session's entry since I last read
   * it?" — the trigger condition for `plan:concurrent-merge`. Comparing
   * whole plan bodies would be both expensive and wrong (a peer can write a
   * body identical to ours), and mtimes are shared by every session in the
   * one file.
   *
   * OPTIONAL in the in-memory type, unlike `StoryV2.dependsOn` (which the
   * spec names as the coercion precedent): the coercion at the disk boundary
   * is identical (absent → `0` in `coerceLoadedPlan`) and the engine always
   * writes the field, but a REQUIRED field would break the externally
   * constructed `PlanV2` literals that already exist outside this module
   * (`tests/v2/gate.test.ts:276`) for no behavioral gain. Every read inside
   * this module therefore goes through `?? 0`.
   */
  revision?: number
}

// ---------------------------------------------------------------------------
// Validation (FR-017: plans MUST validate on read and write)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

function isAcceptanceItem(value: unknown): value is AcceptanceItem {
  if (!isRecord(value)) return false
  if (typeof value.id !== "string" || typeof value.text !== "string") return false
  if (value.evidence === null) return true
  if (!isRecord(value.evidence)) return false
  if (typeof value.evidence.receiptId === "string") return true
  if (value.evidence.waiver === true && typeof value.evidence.sourceMessageId === "string") return true
  return false
}

const STORY_STATUSES = new Set(["pending", "active", "complete", "blocked", "failed"])

/** 2026-07-30: the task status union, kept in its own set so `isTask` can
 * validate a task's `status` independently of the story-level union (they
 * happen to share the same five values today, but the model's vocabulary
 * for a task is its own contract). */
const TASK_STATUSES = new Set(["pending", "active", "complete", "blocked", "failed"])

function isAmendment(value: unknown): value is { reason: string; ts: string } {
  return isRecord(value) && typeof value.reason === "string" && typeof value.ts === "string"
}

function isJudgeItemNote(value: unknown): value is JudgeItemNote {
  return (
    isRecord(value) &&
    typeof value.itemId === "string" &&
    typeof value.met === "boolean" &&
    typeof value.note === "string"
  )
}

function isStoryJudgeStamp(value: unknown): value is StoryJudgeStamp {
  if (!isRecord(value)) return false
  if (typeof value.pass !== "boolean") return false
  if (typeof value.summary !== "string") return false
  if (!Array.isArray(value.items) || !value.items.every(isJudgeItemNote)) return false
  if (typeof value.judgedAt !== "string") return false
  // FR-001b: optional on disk (stamps written before the field existed must
  // still load); reject only a PRESENT-but-wrong-shaped value.
  if (value.contradictedItemIds !== undefined && !isStringArray(value.contradictedItemIds)) return false
  return true
}

/** 2026-07-30 task validator: a Task needs a non-blank id and text, a string[]
 * `dependsOn`, a valid `status`, and (when present) string `startedAt`/
 * `completedAt`. `dependsOn` is REQUIRED as an array (the engine always
 * writes it; an old task without it is malformed, and there are no old
 * tasks — tasks ship with this redesign). */
function isTask(value: unknown): value is Task {
  if (!isRecord(value)) return false
  if (typeof value.id !== "string" || value.id.trim() === "") return false
  if (typeof value.text !== "string" || value.text.trim() === "") return false
  if (!isStringArray(value.dependsOn)) return false
  if (typeof value.status !== "string" || !TASK_STATUSES.has(value.status)) return false
  if (value.startedAt !== undefined && typeof value.startedAt !== "string") return false
  if (value.completedAt !== undefined && typeof value.completedAt !== "string") return false
  return true
}

function isStoryV2(value: unknown): value is StoryV2 {
  if (!isRecord(value)) return false
  if (typeof value.id !== "string" || typeof value.text !== "string") return false
  if (!Array.isArray(value.acceptanceItems) || !value.acceptanceItems.every(isAcceptanceItem)) return false
  if (!isStringArray(value.scopeGlobs)) return false
  if (!isStringArray(value.verifiers)) return false
  if (!isStringArray(value.assumptions)) return false
  if (!isStringArray(value.rejectedAlternatives)) return false
  if (!Array.isArray(value.amendments) || !value.amendments.every(isAmendment)) return false
  if (typeof value.status !== "string" || !STORY_STATUSES.has(value.status)) return false
  // 2026-07-30: `tasks` is REQUIRED (non-empty, all valid). A plan written
  // before this redesign has no tasks and is rejected on load — that is the
  // intended hard cutover (this IS the redesign).
  if (!Array.isArray(value.tasks) || value.tasks.length === 0 || !value.tasks.every(isTask)) return false
  // `dependsOn` (story-level) is optional on disk for back-compat with
  // plans that predate the field; treat absent as []. Reject only a
  // PRESENT-but-wrong-shaped value.
  if (value.dependsOn !== undefined && !isStringArray(value.dependsOn)) return false
  // `startedAt` / `completedAt` / `judge` are likewise optional — old plans
  // lack them and must still load; reject only a PRESENT-but-wrong-shaped
  // value.
  if (value.startedAt !== undefined && typeof value.startedAt !== "string") return false
  if (value.completedAt !== undefined && typeof value.completedAt !== "string") return false
  if (value.judge !== undefined && !isStoryJudgeStamp(value.judge)) return false
  return true
}

function isPlanV2(value: unknown): value is PlanV2 {
  if (!isRecord(value)) return false
  if (value.schemaVersion !== 2) return false
  if (!Array.isArray(value.stories) || value.stories.length === 0) return false
  if (!value.stories.every(isStoryV2)) return false
  const stories = value.stories as StoryV2[]
  const ids = new Set(stories.map((s) => s.id))
  if (ids.size !== stories.length) return false
  if (typeof value.finalStoryId !== "string" || !ids.has(value.finalStoryId)) return false
  if (typeof value.createdAt !== "string") return false
  // FR-002d: `revision` is optional on disk (every plan.json written before
  // 2026-08-03 lacks it and MUST still load — `coerceLoadedPlan` fills the
  // absent case with 0 at the disk boundary). Reject only a PRESENT-but-
  // wrong-shaped value, same discrimination the story-level `dependsOn`,
  // `startedAt`, `completedAt` and `judge` fields already get.
  if (value.revision !== undefined && (typeof value.revision !== "number" || !Number.isFinite(value.revision))) {
    return false
  }
  return true
}

/**
 * FR-002d back-compat coercion, applied at the ONE place a pre-2026-08-03
 * on-disk shape can reach memory (`hydrateFromDisk` and `mutate`'s re-read
 * both funnel through here). Mirrors the story-level `dependsOn` coercion
 * this file already performed: the validators ACCEPT the field's absence,
 * and the boundary fills it, so nothing downstream has to know that older
 * files exist. A revision-less plan reads as revision 0, so the very first
 * write by a current engine takes it to 1 and conflict detection starts
 * working from that moment on — no migration, no rewrite-on-read.
 */
function coerceLoadedPlan(plan: PlanV2): PlanV2 {
  for (const story of plan.stories) {
    if (story.dependsOn === undefined) story.dependsOn = []
  }
  if (typeof plan.revision !== "number" || !Number.isFinite(plan.revision)) plan.revision = 0
  return plan
}

// ---------------------------------------------------------------------------
// FR-002: in-place reconciliation (object identity is load-bearing)
//
// `gate.ts:742-753` holds the plan object across `applyJudgeVerdicts` and
// then re-reads `plan.stories` to decide the close-out. A reconciliation
// that REPLACED the cached plan with the freshly-parsed disk copy would
// silently break that close-out, so these helpers copy the disk state
// FIELD-BY-FIELD into the objects that already exist and splice the arrays
// in place. Matching by id (not index) keeps a story/task object stable even
// when a peer inserted or removed a sibling. Disk order wins for the array
// order; objects that exist only on disk are adopted as-is.
// ---------------------------------------------------------------------------

/**
 * FR-004 helper: an ISO-8601 completion stamp guaranteed to sort STRICTLY
 * after an existing judge stamp. The gate's audit filter is a string
 * comparison (`story.judge.judgedAt < story.completedAt`, `gate.ts:794`), and
 * ISO-8601 UTC strings sort lexicographically, so an equal timestamp — which
 * a same-millisecond audit-then-reopen produces — reads as "not re-claimed"
 * and hides the story from the judge again. Falls back to `now` whenever
 * there is no prior stamp or it cannot be parsed (never throws, never
 * produces `Invalid Date`).
 */
function freshCompletionStamp(now: string, judgedAt: string | undefined): string {
  if (judgedAt === undefined || now > judgedAt) return now
  const parsed = Date.parse(judgedAt)
  if (!Number.isFinite(parsed)) return now
  return new Date(parsed + 1).toISOString()
}

function assignTaskInPlace(target: Task, source: Task): void {
  target.text = source.text
  target.dependsOn = source.dependsOn
  target.status = source.status
  target.startedAt = source.startedAt
  target.completedAt = source.completedAt
}

function assignStoryInPlace(target: StoryV2, source: StoryV2): void {
  target.text = source.text
  target.acceptanceItems = source.acceptanceItems
  target.scopeGlobs = source.scopeGlobs
  target.verifiers = source.verifiers
  target.assumptions = source.assumptions
  target.rejectedAlternatives = source.rejectedAlternatives
  target.amendments = source.amendments
  target.status = source.status
  target.startedAt = source.startedAt
  target.completedAt = source.completedAt
  target.judge = source.judge
  target.dependsOn = source.dependsOn ?? []
  const existingById = new Map(target.tasks.map((task) => [task.id, task]))
  const merged = source.tasks.map((incoming) => {
    const existing = existingById.get(incoming.id)
    if (!existing) return incoming
    assignTaskInPlace(existing, incoming)
    return existing
  })
  target.tasks.splice(0, target.tasks.length, ...merged)
}

function assignPlanInPlace(target: PlanV2, source: PlanV2): void {
  target.finalStoryId = source.finalStoryId
  target.createdAt = source.createdAt
  target.revision = source.revision ?? 0
  const existingById = new Map(target.stories.map((story) => [story.id, story]))
  const merged = source.stories.map((incoming) => {
    const existing = existingById.get(incoming.id)
    if (!existing) return incoming
    assignStoryInPlace(existing, incoming)
    return existing
  })
  target.stories.splice(0, target.stories.length, ...merged)
}

function requireNonBlank(value: string, name: string): string {
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${name} must not be blank`)
  return trimmed
}

/** JSON.parse throws a bare SyntaxError (no `.code`) — describe it by
 * message for logging (same helper pattern as `pin.ts`'s `describeParseError`). */
function describeParseError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ---------------------------------------------------------------------------
// Minimal glob matcher (FR-021) — `**`, `*`, `?`, literal segments only.
//
// Judgment call: the spec never defines a glob grammar for `scopeGlobs`.
// This project has zero runtime dependencies (no `minimatch`/`micromatch`
// in package.json), so this is a small hand-rolled subset covering the
// conventional cases the spec's own examples use (`src/parser/**`). No
// brace expansion (`{a,b}`) or character classes (`[abc]`) — documented
// limitation, not silently assumed.
// ---------------------------------------------------------------------------

function globToRegExp(glob: string): RegExp {
  let pattern = "^"
  let i = 0
  while (i < glob.length) {
    const c = glob[i]
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          pattern += "(?:.*/)?"
          i += 3
          continue
        }
        pattern += ".*"
        i += 2
        continue
      }
      pattern += "[^/]*"
      i += 1
      continue
    }
    if (c === "?") {
      pattern += "[^/]"
      i += 1
      continue
    }
    if (".+^${}()|[]\\".includes(c)) {
      pattern += `\\${c}`
      i += 1
      continue
    }
    pattern += c
    i += 1
  }
  pattern += "$"
  return new RegExp(pattern)
}

function normalizePath(path: string): string {
  return path.replace(/^\.\/+/, "")
}

function matchesGlob(path: string, glob: string): boolean {
  return globToRegExp(normalizePath(glob)).test(normalizePath(path))
}

// ---------------------------------------------------------------------------
// StoryEngine
// ---------------------------------------------------------------------------

/**
 * FR-003: what a `checkpoint` call reports back. Before this existed the
 * ONLY corrective signal the model received was the thrown error's
 * "(currently active: …)" tail; making the already-complete case succeed
 * would have removed that signal entirely, so it moves here and is reported
 * on every call, thrown or not.
 */
export interface CheckpointResult {
  /** `true` when the call was an already-complete re-claim: no plan
   * mutation, no disk write, `checkpoint:idempotent-noop` logged. */
  idempotent: boolean
  /** The task ids active AFTER this call — i.e. what the model should be
   * working on now, including anything the level-promotion just activated. */
  activeTaskIds: string[]
}

/**
 * FR-002a. Which reconciliation a mutation wants:
 *  - `merge`   (default) — re-read `plan.json` and fold a peer's changes
 *    into the cached plan IN PLACE before applying this mutation. The
 *    ordering matters and is the round-1 C4 finding: reconciling AFTER the
 *    mutation (e.g. inside `persistPlan`) would discard the caller's own
 *    write, which is why "re-hydrate in persistPlan" was rejected.
 *  - `replace` (`createPlan`) — this session's entry is being overwritten
 *    wholesale; folding the disk copy in would resurrect the very stories
 *    the create is replacing.
 *  - `delete`  (`clearPlan`) — this session's entry is being removed;
 *    folding the disk copy in would resurrect the cleared plan.
 */
type MutateMode = "merge" | "replace" | "delete"

/** What a `mutate` callback reports: its own return value, plus whether it
 * actually changed anything. `changed: false` skips the disk write entirely
 * (FR-003 — an idempotent no-op must leave the file untouched). */
interface MutateOutcome<T> {
  changed: boolean
  result: T
}

export class StoryEngine {
  private readonly stateDir: string
  private readonly planPath: string
  private readonly goalsPath: string
  private readonly archiveDir: string
  private readonly logger: EventLogger
  private readonly plans = new Map<string, PlanV2>()
  /**
   * FR-002b: `acquireStateLock` is NOT reentrant — a second acquisition from
   * the same process throws `state directory is locked by another process`,
   * which would surface as a spurious hard failure inside `checkpoint`. This
   * flag records that THIS engine is already inside its own critical
   * section, so the two paths that can be reached from within one
   * (`archiveV1IfPresent`, and a nested `mutate`) run lock-free instead of
   * deadlock-throwing. It is not a substitute for hoisting the archival call
   * above `mutate` — both are in force, because the hoist is the contract
   * and this is the guard that keeps a future call-order change from
   * re-introducing the bug.
   */
  private lockHeld = false

  constructor(opts: { stateDir: string; logger: EventLogger }) {
    this.stateDir = opts.stateDir
    this.planPath = join(this.stateDir, "plan.json")
    this.goalsPath = join(this.stateDir, "goals.json")
    this.archiveDir = join(this.stateDir, "archive")
    this.logger = opts.logger
  }

  // -- FR-022: v1 archival -----------------------------------------------

  /**
   * Detects a v1 `goals.json` (`schemaVersion` absent — including an
   * unparseable file, treated as "cannot prove it's v2" — or exactly `1`)
   * and moves it to `archive/goals.<ISO-8601-timestamp>.json` via a single
   * atomic rename (never copy+delete), byte-identical, never touching any
   * existing file under `archive/`. Returns `true` iff an archive happened.
   *
   * Called automatically at the top of every mutating story-tool method
   * (`proposePlan`, `createPlan`, `checkScope`, `checkpoint`) — "when any
   * story tool runs" per the BDD scenario — as well as being exported
   * standalone so wiring can call it eagerly (e.g. at session activation)
   * to word the "a new plan is required" response itself; this module
   * only reports the boolean, it does not compose that user-facing text.
   *
   * FR-002b: this method takes the SAME non-reentrant lock `mutate` takes.
   * Every caller inside this class keeps it hoisted ABOVE its `mutate` call,
   * and — belt and braces — it skips the acquisition entirely when this
   * engine already holds the lock, which is the "lock-free inner variant"
   * the spec offers as the alternative. Without one of the two, wrapping
   * `checkpoint` in a lock would deadlock-throw straight into the host.
   */
  archiveV1IfPresent(): boolean {
    if (!fsIO.existsSync(this.goalsPath)) return false

    let raw: string
    try {
      raw = fsIO.readFileSync(this.goalsPath, "utf8")
    } catch {
      return false
    }
    let schemaVersion: unknown
    try {
      const parsed: unknown = JSON.parse(raw)
      schemaVersion = isRecord(parsed) ? parsed.schemaVersion : undefined
    } catch {
      schemaVersion = undefined // corrupt/unparseable — treated as "absent", still archived
    }
    if (schemaVersion !== undefined && schemaVersion !== 1) return false // a v2+ file: not ours to touch

    const lock = this.lockHeld ? null : acquireStateLock(this.stateDir)
    try {
      if (!fsIO.existsSync(this.goalsPath)) return false // raced away by another process
      fsIO.mkdirSync(this.archiveDir, { recursive: true, mode: 0o700 })
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
      let archivePath = join(this.archiveDir, `goals.${timestamp}.json`)
      let suffix = 0
      while (fsIO.existsSync(archivePath)) {
        suffix += 1
        archivePath = join(this.archiveDir, `goals.${timestamp}-${suffix}.json`)
      }
      fsIO.renameSync(this.goalsPath, archivePath)
      // No dedicated event name is listed for FR-022 in the module-contracts
      // "measurement.ts extension" section's new-event-type list — this is
      // an addition for observability, documented here rather than silently
      // omitted; wave-3 wiring may map it to a real measurement.ts writer or
      // drop it.
      this.logger("story:v1-archived", { archivePath })
      return true
    } finally {
      lock?.release()
    }
  }

  // -- Plan lifecycle -------------------------------------------------------

  proposePlan(sessionID: string, stories: Array<{ text: string; acceptanceItems: string[] }>): { proposalText: string } {
    this.archiveV1IfPresent()
    void sessionID // no plan file is written before the create tool is invoked (BDD: US-5 scenario 1)
    const lines: string[] = ["Proposed story plan:"]
    stories.forEach((story, index) => {
      lines.push(`${index + 1}. ${story.text}`)
      for (const item of story.acceptanceItems) {
        lines.push(`   - ${item}`)
      }
    })
    lines.push("", "Confirm this plan to create it, or ask for changes to the split first.")
    return { proposalText: lines.join("\n") }
  }

  /**
   * 2026-07-30 task/DAG redesign. Each confirmed story MUST decompose into
   * ≥1 task; the engine assigns each task a globally-unique id
   * (`${storyId}.T${n}`) and initial `status: "pending"`. It then validates
   * that every `dependsOn` (task- or story-level) resolves to a real story
   * or task (a dangling id is a model error — throw naming the id BEFORE
   * any disk write), computes topological levels over the task DAG
   * (longest-path layering; a cycle throws `plan dependency cycle: ...`
   * naming the cycle), and activates every level-0 task (with
   * `startedAt = now`). Story statuses are derived from their tasks.
   *
   * Story ids are deterministic (`S1..Sn` in order) and task ids are
   * deterministic (`S{i}.T{j}`), so the MODEL can compute the ids before
   * create runs and reference them in other tasks' `dependsOn`. A
   * story-level `dependsOn` names OTHER STORY ids and is expanded by the
   * engine to "every task in this story depends on every task of the
   * named predecessors" — the DAG then enforces it for free, which is why
   * the old C-11 final-story guard is no longer needed.
   */
  createPlan(
    sessionID: string,
    confirmed: Array<{
      text: string
      acceptanceItems: string[]
      tasks: Array<{ text: string; dependsOn?: string[] }>
      scopeGlobs?: string[]
      verifiers?: string[]
      dependsOn?: string[]
    }>,
  ): PlanV2 {
    this.archiveV1IfPresent()
    if (confirmed.length === 0) throw new Error("a story plan requires at least one story")

    const now = new Date().toISOString()
    const stories: StoryV2[] = confirmed.map((input, index) => {
      const storyId = `S${index + 1}`
      if (!Array.isArray(input.tasks) || input.tasks.length === 0) {
        throw new Error(`stories[${index}].tasks must contain at least one task`)
      }
      const tasks: Task[] = input.tasks.map((taskInput, taskIndex) => {
        const rawDeps = Array.isArray(taskInput.dependsOn) ? taskInput.dependsOn : []
        if (!rawDeps.every((dep) => typeof dep === "string")) {
          throw new Error(`stories[${index}].tasks[${taskIndex}].dependsOn must be an array of strings`)
        }
        return {
          id: `${storyId}.T${taskIndex + 1}`,
          text: requireNonBlank(taskInput.text, `stories[${index}].tasks[${taskIndex}].text`),
          dependsOn: [...rawDeps],
          status: "pending",
        }
      })
      return {
        id: storyId,
        text: requireNonBlank(input.text, `stories[${index}].text`),
        acceptanceItems: input.acceptanceItems.map((text, itemIndex) => ({
          id: `A${itemIndex + 1}`,
          text: requireNonBlank(text, `stories[${index}].acceptanceItems[${itemIndex}]`),
          evidence: null,
        })),
        // UAT finding: the host does not reliably apply the tool schema's
        // `.default([])` for an omitted optional array arg — a real model
        // that simply leaves scopeGlobs/verifiers out reaches here with
        // `undefined`. Defend at the point of use rather than trust the
        // caller's type.
        scopeGlobs: [...(input.scopeGlobs ?? [])],
        verifiers: [...(input.verifiers ?? [])],
        assumptions: [],
        rejectedAlternatives: [],
        amendments: [],
        // Story-level deps default to [] and are baked into the task DAG by
        // buildGraph. Stored explicitly so the on-disk plan is self-describing.
        dependsOn: [...(input.dependsOn ?? [])],
        status: "pending",
        tasks,
      }
    })

    stories.forEach((story, index) => {
      if (story.acceptanceItems.length === 0) {
        throw new Error(`stories[${index}].acceptanceItems must contain at least one item`)
      }
    })

    const plan: PlanV2 = {
      schemaVersion: 2,
      stories,
      finalStoryId: stories[stories.length - 1].id,
      createdAt: now,
    }

    // Validate deps resolve + task ids are globally unique BEFORE computing
    // levels (and before any disk write) — a dangling reference or a
    // duplicate task id is a model error, not a corrupt plan.
    this.validateDepsResolve(plan)
    // Compute topological levels; throws `plan dependency cycle: ...` on a
    // cycle, again before any disk write (byte-for-byte-unchanged invariant).
    const levels = this.computeLevels(plan)

    // All level-0 tasks (no story/task deps) start ACTIVE at once — that IS
    // wave 0, the parallel fan-out the model reads via getActiveTasks.
    for (const story of plan.stories) {
      for (const task of story.tasks) {
        if (levels.get(task.id) === 0) {
          task.status = "active"
          task.startedAt = now
        }
      }
    }
    // Derive (and store) every story's status from its now-active/pending
    // tasks. activationTs keeps a newly-active story's startedAt consistent
    // with the tasks that activated it.
    this.recomputeStoryStatuses(plan, { activationTs: now })

    if (!isPlanV2(plan)) throw new Error("internal error: constructed plan failed schema validation")

    // FR-002a: mode `"replace"`. A create REPLACES this session's entry
    // wholesale, so `mutate` must NOT reconcile the on-disk copy into it —
    // merging would resurrect exactly the stories this call is discarding
    // (and which the archive below is the recovery path for). Note the
    // `archiveV1IfPresent` call at the top of this method is already above
    // the lock (FR-002b).
    return this.mutate(
      sessionID,
      () => {
        // Archive an existing plan before replacing it. `createPlan` used to
        // overwrite unconditionally while `clearPlan` archived — so a second
        // `elicify_vertex_plan_create` call silently discarded the user's
        // stories, their acceptance items AND their attached evidence, with
        // no log and nothing to recover. Losing a contract is exactly as bad
        // as losing the evidence for it.
        const existing = this.plans.get(sessionID) ?? null
        if (existing && existing.stories.length > 0) {
          this.logger("plan:replaced", {
            sessionID,
            replacedStories: existing.stories.length,
            replacedStatuses: existing.stories.map((story) => story.status).join(","),
          })
          this.archivePlan(sessionID, existing)
        }
        this.plans.set(sessionID, plan)
        return { changed: true, result: plan }
      },
      "replace",
    )
  }

  getPlan(sessionID: string): PlanV2 | null {
    if (!this.plans.has(sessionID)) this.hydrateFromDisk(sessionID)
    return this.plans.get(sessionID) ?? null
  }

  /**
   * 2026-07-30: the primary fan-out read — ALL tasks with `status: "active"`
   * across every story, in stable order (story-array order, then task-array
   * order within a story). This is what `elicify_vertex_plan_next` returns
   * and what the model dispatches one `task`-tool subagent against per
   * element.
   */
  getActiveTasks(sessionID: string): Task[] {
    const plan = this.getPlan(sessionID)
    if (!plan) return []
    const out: Task[] = []
    for (const story of plan.stories) {
      for (const task of story.tasks) {
        if (task.status === "active") out.push(task)
      }
    }
    return out
  }

  /**
   * 2026-07-30: stories that have ≥1 ACTIVE task — the back-compat read for
   * callers (gate.ts/findings.ts/plugin.ts) that still reason at story
   * granularity. A story with all tasks pending has none active and reads
   * as not-active here even before its first task is promoted.
   */
  getActiveStories(sessionID: string): StoryV2[] {
    const plan = this.getPlan(sessionID)
    if (!plan) return []
    return plan.stories.filter((story) => story.tasks.some((task) => task.status === "active"))
  }

  /** Back-compat for singular callers: the FIRST story with an active task,
   * or null. Kept so pre-task callers (plugin.ts/gate.ts) keep compiling. */
  getActiveStory(sessionID: string): StoryV2 | null {
    return this.getActiveStories(sessionID)[0] ?? null
  }

  /**
   * ADDED — not in the §9 contract's method list (see header comment).
   * LEGACY (HANDOVER.md redesign point 1): per-item evidence citations are
   * no longer part of the completion contract — `checkpoint` never reads
   * this field and the completion judge supersedes it. This method remains
   * only so pre-redesign plans with attached evidence still round-trip
   * through memory and disk; new wiring should not call it.
   */
  attachEvidence(sessionID: string, storyId: string, itemId: string, evidence: AcceptanceItem["evidence"]): void {
    if (!this.getPlan(sessionID)) return
    // FR-002: the lookups run INSIDE `mutate` so they see the reconciled
    // plan, not a cache a peer instance has already moved past. An unknown
    // story/item reports `changed: false`, which skips the disk write.
    this.mutate(sessionID, (plan) => {
      const story = plan?.stories.find((candidate) => candidate.id === storyId)
      const item = story?.acceptanceItems.find((candidate) => candidate.id === itemId)
      if (!item) return { changed: false, result: undefined }
      item.evidence = evidence
      return { changed: true, result: undefined }
    })
  }

  /**
   * ADDED — not in the §9 contract's method list (see header comment).
   * Records a scope amendment (the "amend" arm of `checkScope`'s
   * fold/amend/revert offer) and optionally updates `scopeGlobs`/
   * `verifiers`. Throws on an unknown session/story.
   */
  amendStory(sessionID: string, storyId: string, opts: { reason: string; scopeGlobs?: string[]; verifiers?: string[] }): void {
    if (!this.getPlan(sessionID)) throw new Error(`no story plan for session ${sessionID}`)
    this.mutate(sessionID, (plan) => {
      const story = plan?.stories.find((candidate) => candidate.id === storyId)
      if (!story) throw new Error(`unknown story: ${storyId}`)

      const reason = requireNonBlank(opts.reason, "amendment reason")
      story.amendments.push({ reason, ts: new Date().toISOString() })
      if (opts.scopeGlobs) story.scopeGlobs = [...opts.scopeGlobs]
      if (opts.verifiers) story.verifiers = [...opts.verifiers]
      return { changed: true, result: undefined }
    })
  }

  /**
   * 2026-07-30 task/DAG redesign. Reopens a story by re-activating its
   * not-complete tasks per the DAG level rule: a task whose effective deps
   * are ALL `"complete"` goes `"active"` (fresh `startedAt`); otherwise it
   * goes `"pending"` and waits for `checkpoint`'s level-promotion to
   * activate it once its predecessors finish. Complete tasks are LEFT
   * complete (re-audit only re-does the work the judge flunked — but see
   * `applyJudgeVerdicts`, which is what re-opens complete tasks after a
   * failed verdict; `reopenStory` is the model-facing resume path for a
   * blocked/failed story).
   *
   * The old "only a blocked/failed story may be reopened" precondition is
   * GONE: `reopenStory` now also targets a story whose status a failed
   * judge verdict already reverted to `"active"` (the model resumes it), or
   * any story the model genuinely wants to resume. It simply re-activates
   * the story's not-complete tasks per the DAG rule and recomputes status.
   *
   * `completedAt` (task and story) is cleared for re-activated tasks; the
   * reopen itself is recorded as a story amendment for audit. Acceptance-
   * item `evidence` is deliberately NOT reset (deprecated, superseded by
   * `StoryV2.judge`). Throws on an unknown session/story; never a silent
   * no-op.
   *
   * FR-004 (2026-08-03) — a reopened story can be RE-AUDITED. Observed 3x in
   * the audited session: `story:reopened {previousStatus: "complete",
   * newStatus: "complete"}`. When every task is already complete this loop
   * changes nothing (complete tasks are skipped by design), the derived
   * status stays `"complete"`, and `recomputeStoryStatuses` will NOT restamp
   * `completedAt` because it only stamps on a `prev !== complete -> complete`
   * TRANSITION. The story was therefore left `complete` with
   * `completedAt: undefined`, and the gate's audit filter (`gate.ts:794`)
   * requires `completedAt !== undefined` — the story became permanently
   * invisible to the judge. FR-003's idempotent no-op is explicitly NOT the
   * mechanism here: there is no incomplete task left to re-checkpoint. So a
   * still-`complete` story gets a FRESH `completedAt` stamped below, which
   * makes it audit-eligible immediately with no further checkpoint.
   */
  reopenStory(sessionID: string, storyId: string, opts: { reason: string }): void {
    if (!this.getPlan(sessionID)) throw new Error(`no story plan for session ${sessionID}`)

    this.mutate(sessionID, (plan) => {
      const story = plan?.stories.find((candidate) => candidate.id === storyId)
      if (!plan || !story) throw new Error(`unknown story: ${storyId}`)

      const reason = requireNonBlank(opts.reason, "reopen reason")
      const previousStatus = story.status
      const graph = this.buildGraph(plan)
      const now = new Date().toISOString()

      for (const task of story.tasks) {
        // Complete tasks stay complete — re-audit re-opens them via
        // applyJudgeVerdicts, not here.
        if (task.status === "complete") continue
        const deps = graph.deps.get(task.id) ?? new Set<string>()
        let allDepsComplete = true
        for (const depId of deps) {
          if (this.taskStatus(plan, depId) !== "complete") {
            allDepsComplete = false
            break
          }
        }
        if (allDepsComplete) {
          task.status = "active"
          task.startedAt = now
          task.completedAt = undefined
        } else {
          // A predecessor task/story is still incomplete — rejoin the queue
          // and let checkpoint's level-promotion activate it in order.
          task.status = "pending"
          task.startedAt = undefined
          task.completedAt = undefined
        }
      }

      story.completedAt = undefined
      story.amendments.push({ reason: `reopened from ${previousStatus}: ${reason}`, ts: now })
      this.recomputeStoryStatuses(plan, { activationTs: now })
      // FR-004: nothing was re-activated (every task was already complete),
      // so the story is still `complete` — re-stamp `completedAt` so the
      // audit filter selects it again on the very next idle. The stamp must
      // also be strictly LATER than any existing judge stamp, because that
      // filter is `judge.judgedAt < completedAt`: the audit and the reopen
      // can land inside the same millisecond, and an equal timestamp would
      // silently reproduce the bug this requirement exists to kill.
      if (story.status === "complete") story.completedAt = freshCompletionStamp(now, story.judge?.judgedAt)
      this.logger("story:reopened", { sessionID, storyId, previousStatus, newStatus: story.status })
      return { changed: true, result: undefined }
    })
  }

  // -- FR-021: scope watchdog -----------------------------------------------

  /**
   * Returns a scope-drift finding-shaped object when `mutatedPath` falls
   * outside EVERY active-task story's `scopeGlobs`, or `null` when it is
   * in scope. 2026-07-30: "active story" now means a story with ≥1 ACTIVE
   * TASK (the unit of work in flight); with several such stories active at
   * once, a mutation is in scope when it matches ANY of their globs. An
   * active-task story with empty `scopeGlobs` imposes no constraint — but
   * does NOT whitelist: if at least one active-task story declares globs,
   * the path must match one of those stories' globs. `null` is also
   * returned when no task is active, or when every active-task story has
   * empty globs.
   *
   * `opts.scopeGlobsMatchedZero`: when `true`, the recommended `offer` is
   * `"amend"` first (the branch-switch/typo edge case — folding/reverting
   * against globs that match nothing in the worktree makes no sense).
   * Otherwise the recommended `offer` is `"fold"`.
   */
  checkScope(
    sessionID: string,
    mutatedPath: string,
    opts?: { scopeGlobsMatchedZero?: boolean },
  ): { family: "scope-watchdog"; offer: "fold" | "amend" | "revert"; scopeGlobsMatchedZero: boolean } | null {
    this.archiveV1IfPresent()
    const activeTaskStories = this.getActiveStories(sessionID)
    if (activeTaskStories.length === 0) return null
    const scoped = activeTaskStories.filter((story) => story.scopeGlobs.length > 0)
    if (scoped.length === 0) return null

    const inScope = scoped.some((story) => story.scopeGlobs.some((glob) => matchesGlob(mutatedPath, glob)))
    if (inScope) return null

    const scopeGlobsMatchedZero = opts?.scopeGlobsMatchedZero ?? false
    return {
      family: "scope-watchdog",
      offer: scopeGlobsMatchedZero ? "amend" : "fold",
      scopeGlobsMatchedZero,
    }
  }

  // -- FR-019/FR-020: checkpoint (TASK-level) ------------------------------

  /**
   * 2026-07-30 task/DAG redesign: checkpoint operates on a TASK id (the
   * atomic unit). It is still a CLAIM, not a proof — the completion judge
   * audits stories at session.idle. What is enforced here, all structural,
   * all BEFORE any mutation (a thrown error still leaves the plan file
   * byte-for-byte unchanged):
   *  - `"complete"` requires the task to currently be `"active"` —
   *    completing a pending/blocked task would skip the DAG's activation
   *    bookkeeping; the error names the task and the currently active ids.
   *  - `"blocked"`/`"failed"` carry no active-task requirement (mirrors
   *    the old story-level rule), and an optional `opts.reason` is appended
   *    to the parent STORY's amendments (`"blocked: <reason>"` /
   *    `"failed: <reason>"`) so the judge and wiring can see WHY.
   *
   * After the task's status is set: the parent story is recomputed (if all
   * its tasks are now `"complete"`, the story auto-completes with
   * `completedAt` stamped); then, if NO task remains `"active"` ANYWHERE,
   * every pending task at the next-lowest pending topological level is
   * promoted to `"active"` at once (fresh `startedAt`), and the affected
   * stories are recomputed to `"active"`. Story `dependsOn` are baked into
   * the DAG levels, so promotion by level honours them automatically — no
   * separate C-11 final-story guard is needed (a final story that depends
   * on its siblings cannot have all tasks complete until they are).
   *
   * FR-003 (2026-08-03) — IDEMPOTENCY. 23 of the audited session's 82
   * checkpoint calls died on `cannot complete task X: it is not active`,
   * because the harness's own revert directive orders the model to
   * "checkpoint each reverted task complete again" and a peer instance (or
   * the model's own retry) had already done so. Re-completing a task that is
   * ALREADY `"complete"` is therefore a no-op success: nothing mutates, no
   * disk write happens at all, and `checkpoint:idempotent-noop` is logged.
   * The three genuinely out-of-order claims still throw — a `"pending"`
   * task never activated, and a `"blocked"`/`"failed"` task must be reopened
   * first. E8: the no-op deliberately touches NEITHER the task's/story's
   * `completedAt` NOR the judge stamp, so a failed audit cannot be laundered
   * by re-claiming the task.
   *
   * Returns the task ids that are active AFTER the call (FR-003 / round-2
   * m-16): the thrown error string used to be the ONLY channel telling the
   * model what it should be working on instead, so the no-op has to carry
   * that information some other way.
   */
  checkpoint(
    sessionID: string,
    taskId: string,
    status: "complete" | "failed" | "blocked",
    opts?: { reason?: string },
  ): CheckpointResult {
    // FR-002b: hoisted ABOVE `mutate` — it takes the same non-reentrant lock.
    this.archiveV1IfPresent()
    if (!this.getPlan(sessionID)) throw new Error(`no story plan for session ${sessionID}`)

    return this.mutate<CheckpointResult>(sessionID, (plan) => {
      if (!plan) throw new Error(`no story plan for session ${sessionID}`)

      let targetTask: Task | undefined
      let targetStory: StoryV2 | undefined
      for (const story of plan.stories) {
        const task = story.tasks.find((candidate) => candidate.id === taskId)
        if (task) {
          targetTask = task
          targetStory = story
          break
        }
      }
      if (!targetTask || !targetStory) throw new Error(`unknown task: ${taskId}`)

      if (status === "complete") {
        // FR-003: an already-complete task is a RE-CLAIM, not an
        // out-of-order claim. Succeed without mutating anything — this
        // branch must stay ABOVE the not-active throw below, since
        // `"complete"` is itself a non-active status.
        if (targetTask.status === "complete") {
          this.logger("checkpoint:idempotent-noop", { sessionID, taskId, storyId: targetStory.id })
          return {
            changed: false,
            result: { idempotent: true, activeTaskIds: this.activeTaskIds(plan) },
          }
        }
        // Completing a non-active task would silently strand the DAG's
        // activation bookkeeping — the task would skip its level's activation
        // while real active tasks stay active elsewhere.
        if (targetTask.status !== "active") {
          const activeIds = this.activeTaskIds(plan)
          throw new Error(
            `cannot complete task ${taskId}: it is not active ` +
              `(currently active: ${activeIds.length > 0 ? activeIds.join(", ") : "none"})`,
          )
        }
      }

      // --- All validation passed; mutate. ---
      targetTask.status = status
      if (status === "complete") {
        targetTask.completedAt = new Date().toISOString()
      } else {
        // A non-complete outcome withdraws any earlier completion claim.
        targetTask.completedAt = undefined
        if (opts?.reason) {
          targetStory.amendments.push({ reason: `${status}: ${opts.reason}`, ts: new Date().toISOString() })
        }
      }

      // Recompute the affected story (the checkpointed task's parent) so a
      // story whose last task just completed reads "complete" immediately.
      this.recomputeStoryStatuses(plan)

      // Level-promotion (the task analog of the old wave-promotion): whenever
      // NO task remains active anywhere — for any reason (complete / blocked
      // / failed) — activate every pending task at the next-lowest pending
      // topological level. All such tasks are independent by construction
      // (same level), so activating them together IS the parallel wave.
      if (!this.anyActiveTask(plan)) {
        const activationTs = this.promoteNextLevel(plan)
        if (activationTs !== null) {
          this.recomputeStoryStatuses(plan, { activationTs })
        }
      }

      return { changed: true, result: { idempotent: false, activeTaskIds: this.activeTaskIds(plan) } }
    })
  }

  /**
   * HANDOVER.md redesign points 1/5 (+ 2026-07-30 task re-open): the
   * completion judge is the sole arbiter of whether a checkpoint's claim
   * was real. It hands its per-story verdicts here; this method stamps
   * each one onto its story (`StoryV2.judge`) and enforces the verdict:
   *  - pass on a `"complete"` story: confirmed — status untouched, id in
   *    `passed`.
   *  - fail on a `"complete"` story: REVERT. The story goes back to
   *    `"active"` (fresh `startedAt`, `completedAt` cleared) AND its
   *    `"complete"` tasks are re-opened to `"active"` (fresh task
   *    `startedAt`, task `completedAt` cleared) — re-audit requires
   *    re-doing the work, so the claim's evidence is withdrawn; id in
   *    `reverted`.
   *  - any verdict on a non-`"complete"` story: the stamp is recorded
   *    (still useful audit information) but nothing transitions, and
   *    `judge:verdict-not-enforced` names the story so the no-op is visible
   *    in the log rather than inferable only from an empty audit summary
   *    (FR-009 / MAJ-008).
   * Unknown story ids are collected into `unknown` and NEVER throw. Persists
   * once at the end and logs `story:judge-audit`. Throws only when the
   * session has no plan at all.
   *
   * FR-001b (2026-08-03): `contradictedByStory` carries, per story id, the
   * ids of `met:false` items the HARNESS overruled — the gate's
   * path-existence cross-check drops an item claiming a file is missing when
   * that file demonstrably exists, and re-derives `pass: true` when every
   * failing item of a story was disproven that way. Those ids are recorded
   * on the stamp so a harness-derived pass stays distinguishable from a
   * genuine judge pass forever after (the close-out must not claim the judge
   * "independently verified" a story it actually failed). The parameter is
   * OPTIONAL: two-argument callers are unchanged and their stamps carry no
   * `contradictedItemIds` at all, which is exactly the "genuine verdict"
   * encoding.
   *
   * FR-002: the whole loop runs inside `mutate`, so a peer instance's stamps
   * written since this engine last read `plan.json` are folded in first
   * rather than overwritten — the audited session lost a stamp written at
   * 10:26:28 precisely here. Object identity is preserved across that
   * reconciliation because `gate.ts:742-753` holds this plan object and
   * re-reads `plan.stories` after this call returns.
   */
  applyJudgeVerdicts(
    sessionID: string,
    verdicts: Array<{ storyId: string; pass: boolean; summary: string; items: JudgeItemNote[] }>,
    contradictedByStory?: ReadonlyMap<string, string[]>,
  ): { reverted: string[]; passed: string[]; unknown: string[] } {
    if (!this.getPlan(sessionID)) throw new Error(`no story plan for session ${sessionID}`)

    const outcome = this.mutate(sessionID, (plan) => {
      if (!plan) throw new Error(`no story plan for session ${sessionID}`)

      const reverted: string[] = []
      const passed: string[] = []
      const unknown: string[] = []
      const judgedAt = new Date().toISOString()
      let stamped = 0

      for (const verdict of verdicts) {
        const story = plan.stories.find((candidate) => candidate.id === verdict.storyId)
        if (!story) {
          unknown.push(verdict.storyId)
          continue
        }
        // Copy the items defensively — the stamp becomes part of the
        // persisted plan and must not alias the judge module's array.
        const contradicted = contradictedByStory?.get(verdict.storyId)
        story.judge = {
          pass: verdict.pass,
          summary: verdict.summary,
          items: verdict.items.map((item) => ({ ...item })),
          judgedAt,
          // Absent (not `[]`) when the harness overruled nothing, so the
          // on-disk shape of an untouched verdict is byte-identical to what
          // pre-FR-001b engines wrote.
          ...(contradicted && contradicted.length > 0 ? { contradictedItemIds: [...contradicted] } : {}),
        }
        stamped += 1
        if (verdict.pass && story.status === "complete") {
          passed.push(story.id)
        } else if (!verdict.pass && story.status === "complete") {
          // 2026-07-30: re-open the story's complete TASKS too — re-audit
          // requires re-doing the work, so a reverted claim withdraws the
          // task-level completion as well as the story-level one.
          story.status = "active"
          story.startedAt = judgedAt
          story.completedAt = undefined
          for (const task of story.tasks) {
            if (task.status === "complete") {
              task.status = "active"
              task.startedAt = judgedAt
              task.completedAt = undefined
            }
          }
          reverted.push(story.id)
        } else {
          // FR-009 (MAJ-008, code review 2026-08-03): the stamp is recorded
          // but the verdict enforces NOTHING, because the story is no longer
          // `"complete"` — the gate selects only complete stories, so this
          // means a peer instance, a `reopenStory`, or a `blocked`/`failed`
          // checkpoint moved it between selection and application. Without
          // this event the audit reads `{passed:[], reverted:[], unknown:[]}`
          // with no story named anywhere, which is indistinguishable from
          // "the judge returned nothing" — exactly the invisible-skip class
          // FR-009 exists to close. It is logged per story rather than folded
          // into `story:judge-audit` below, which is a summary of TRANSITIONS
          // and has no slot for a per-story reason.
          this.logger("judge:verdict-not-enforced", {
            sessionID,
            storyId: story.id,
            status: story.status,
            pass: verdict.pass,
          })
        }
      }

      // Every verdict named an unknown story (or there were none): nothing
      // was stamped, so there is nothing to write.
      return { changed: stamped > 0, result: { reverted, passed, unknown } }
    })

    this.logger("story:judge-audit", { sessionID, ...outcome })
    return outcome
  }

  // -- DAG / level machinery (2026-07-30) ----------------------------------

  /**
   * Validates that every `dependsOn` (task- and story-level) resolves to a
   * real story id or task id, and that task ids are globally unique across
   * the plan. Throws (naming the dangling id / duplicate) BEFORE any disk
   * write. A dep may name a STORY (expanded by `buildGraph` to all of that
   * story's tasks) or a TASK — both are accepted so the model can express
   * either granularity.
   */
  private validateDepsResolve(plan: PlanV2): void {
    const storyIds = new Set(plan.stories.map((story) => story.id))
    const taskIds = new Set<string>()
    const seenTaskIds = new Set<string>()
    for (const story of plan.stories) {
      for (const task of story.tasks) {
        taskIds.add(task.id)
        if (seenTaskIds.has(task.id)) {
          throw new Error(`duplicate task id: ${task.id} (task ids must be globally unique within the plan)`)
        }
        seenTaskIds.add(task.id)
      }
    }
    plan.stories.forEach((story, storyIndex) => {
      const storyDeps = story.dependsOn ?? []
      storyDeps.forEach((dep) => {
        if (!storyIds.has(dep) && !taskIds.has(dep)) {
          throw new Error(`stories[${storyIndex}].dependsOn references unknown story or task: ${dep}`)
        }
      })
      story.tasks.forEach((task, taskIndex) => {
        task.dependsOn.forEach((dep) => {
          if (!storyIds.has(dep) && !taskIds.has(dep)) {
            throw new Error(`stories[${storyIndex}].tasks[${taskIndex}].dependsOn references unknown story or task: ${dep}`)
          }
        })
      })
    })
  }

  /**
   * Builds the effective task-dependency graph: for each task, the set of
   * TASK ids it depends on, with story-level `dependsOn` and any story-id
   * references in a task's `dependsOn` expanded to that story's task ids.
   * Iteration order is deterministic (story-array, then task-array, then
   * array order within each `dependsOn`), so cycle-error messages and level
   * tie-breaking are stable across runs.
   */
  private buildGraph(plan: PlanV2): {
    deps: Map<string, Set<string>>
    taskOf: Map<string, { task: Task; storyId: string }>
  } {
    const tasksByStory = new Map<string, Task[]>()
    const taskOf = new Map<string, { task: Task; storyId: string }>()
    for (const story of plan.stories) {
      tasksByStory.set(story.id, story.tasks)
      for (const task of story.tasks) {
        taskOf.set(task.id, { task, storyId: story.id })
      }
    }
    const resolveDep = (dep: string): string[] => {
      // A task id reference is a single edge; a story id reference expands
      // to every task of that story. Both are validated to resolve already.
      if (taskOf.has(dep)) return [dep]
      const tasks = tasksByStory.get(dep)
      return tasks ? tasks.map((task) => task.id) : []
    }

    const deps = new Map<string, Set<string>>()
    for (const story of plan.stories) {
      const storyDepEdges: string[] = []
      for (const dep of story.dependsOn ?? []) {
        storyDepEdges.push(...resolveDep(dep))
      }
      for (const task of story.tasks) {
        const edges = new Set<string>()
        for (const dep of task.dependsOn) {
          for (const resolved of resolveDep(dep)) edges.add(resolved)
        }
        // Story-level deps apply to EVERY task in this story.
        for (const resolved of storyDepEdges) edges.add(resolved)
        deps.set(task.id, edges)
      }
    }
    return { deps, taskOf }
  }

  /** Look up a task's status by id across all stories (undefined if unknown). */
  private taskStatus(plan: PlanV2, taskId: string): TaskStatus | undefined {
    for (const story of plan.stories) {
      const task = story.tasks.find((candidate) => candidate.id === taskId)
      if (task) return task.status
    }
    return undefined
  }

  /**
   * Longest-path layering over the task DAG: `level(t) = 0` if no deps,
   * else `1 + max(level(dep))`. Tasks at the same level are independent —
   * that level IS a wave. Detects cycles via DFS colouring and throws
   * `plan dependency cycle: A -> B -> ... -> A` naming the cycle. The plan
   * is cycle-free by construction after `createPlan`'s validation, so this
   * only throws when a caller hands in an inconsistent plan (defensive).
   */
  private computeLevels(plan: PlanV2): Map<string, number> {
    const { deps } = this.buildGraph(plan)
    const levels = new Map<string, number>()
    const WHITE = 0,
      GRAY = 1,
      BLACK = 2
    const color = new Map<string, number>()
    const stack: string[] = []

    const visit = (id: string): number => {
      const c = color.get(id) ?? WHITE
      if (c === BLACK) return levels.get(id)!
      if (c === GRAY) {
        // Revisited a node on the current DFS path — extract the cycle.
        const start = stack.indexOf(id)
        const cycle = stack.slice(start).concat(id)
        throw new Error(`plan dependency cycle: ${cycle.join(" -> ")}`)
      }
      color.set(id, GRAY)
      stack.push(id)
      let max = -1
      for (const dep of deps.get(id) ?? []) {
        const depLevel = visit(dep)
        if (depLevel > max) max = depLevel
      }
      stack.pop()
      const level = max + 1
      levels.set(id, level)
      color.set(id, BLACK)
      return level
    }

    for (const story of plan.stories) {
      for (const task of story.tasks) visit(task.id)
    }
    return levels
  }

  // -- Story-status derivation + promotion (2026-07-30) --------------------

  /**
   * Derives a story's status from its tasks:
   *  - all tasks `"complete"`           → `"complete"`
   *  - any task `"active"`              → `"active"`
   *  - any task `"failed"`              → `"failed"`
   *  - any task `"blocked"`             → `"blocked"`
   *  - otherwise (complete + pending)   → `"pending"` (waiting on deps)
   * The order is deliberate: a story still in flight (an active task) is
   * "active" even if a sibling task already failed; only when nothing is
   * active does the worst terminal task win.
   */
  private deriveStoryStatus(story: StoryV2): StoryV2["status"] {
    const tasks = story.tasks
    if (tasks.length === 0) return "pending" // defensive — validators forbid empty tasks
    if (tasks.every((task) => task.status === "complete")) return "complete"
    if (tasks.some((task) => task.status === "active")) return "active"
    if (tasks.some((task) => task.status === "failed")) return "failed"
    if (tasks.some((task) => task.status === "blocked")) return "blocked"
    return "pending"
  }

  /**
   * Recomputes and stores EVERY story's derived status, managing the
   * story-level `startedAt`/`completedAt` timestamps consistently:
   *  - newly-active (prev !== active → active): `startedAt = activationTs ?? now`
   *  - pending: `startedAt = undefined`
   *  - newly-complete (prev !== complete → complete): `completedAt = now`
   *  - non-complete: `completedAt = undefined`
   * Called after every checkpoint / promotion / reopen. Idempotent for
   * stories whose status did not change (their timestamps are untouched).
   */
  private recomputeStoryStatuses(plan: PlanV2, opts: { activationTs?: string } = {}): void {
    const now = new Date().toISOString()
    for (const story of plan.stories) {
      const prev = story.status
      const next = this.deriveStoryStatus(story)
      if (next === "active" && prev !== "active") {
        story.startedAt = opts.activationTs ?? now
      } else if (next === "pending") {
        story.startedAt = undefined
      }
      if (next === "complete" && prev !== "complete") {
        story.completedAt = now
      } else if (next !== "complete") {
        story.completedAt = undefined
      }
      story.status = next
    }
  }

  private anyActiveTask(plan: PlanV2): boolean {
    for (const story of plan.stories) {
      for (const task of story.tasks) {
        if (task.status === "active") return true
      }
    }
    return false
  }

  private activeTaskIds(plan: PlanV2): string[] {
    const out: string[] = []
    for (const story of plan.stories) {
      for (const task of story.tasks) {
        if (task.status === "active") out.push(task.id)
      }
    }
    return out
  }

  /**
   * Promotes the next wave: the minimum pending topological level. Sets
   * every pending task at that level to `"active"` with a shared fresh
   * `startedAt`, and returns that timestamp so the caller can feed it to
   * `recomputeStoryStatuses` (keeping the newly-active stories' startedAt
   * consistent with their tasks'). Returns `null` when no pending task
   * remains (plan exhausted). No-op-safe: callers only invoke this when
   * `anyActiveTask` is already false.
   */
  private promoteNextLevel(plan: PlanV2): string | null {
    // Activation is DEPENDENCY-COMPLETION-based, not raw-topological-level-based:
    // a pending task activates only when EVERY task it depends on (its own
    // task deps PLUS the implicit edges from its story's `dependsOn`) is
    // `"complete"`. Topological levels are still computed at `createPlan` for
    // cycle detection, but activation cannot use raw levels: if a level-0 task
    // is BLOCKED (not pending, not complete), level-based promotion would scan
    // past it and wrongly activate its level-1 dependents — letting a story
    // reach `"complete"` while a dependency it relied on is unresolved. The
    // completion check is what carries the C-11 invariant ("the plan's
    // 'everything is done' signal must be trustworthy") into the task/DAG
    // model: a dependent task stays `"pending"` until its blocker is reopened
    // and completed, so the plan stalls visibly instead of false-completing.
    const { deps, taskOf } = this.buildGraph(plan)
    const ready: Task[] = []
    for (const [taskId, depIds] of deps) {
      const entry = taskOf.get(taskId)
      if (!entry || entry.task.status !== "pending") continue
      let allDepsComplete = true
      for (const depId of depIds) {
        if (this.taskStatus(plan, depId) !== "complete") {
          allDepsComplete = false
          break
        }
      }
      if (allDepsComplete) ready.push(entry.task)
    }
    if (ready.length === 0) return null
    const ts = new Date().toISOString()
    for (const task of ready) {
      task.status = "active"
      task.startedAt = ts
    }
    return ts
  }

  // -- Plan clear (human-facing escape hatch) --------------------------------

  /**
   * Reversibly archives (never deletes) the session's current plan entry —
   * the human-facing escape hatch for abandoning/resetting a plan. Mirrors
   * `archiveV1IfPresent`'s never-destroy convention. Returns `false`
   * (no-op) when the session has no plan to clear.
   */
  clearPlan(sessionID: string): boolean {
    const plan = this.getPlan(sessionID)
    if (!plan) return false

    // FR-002a: mode `"delete"`. The archive copy and the entry removal now
    // happen under ONE lock acquisition instead of two (the old code took
    // the lock for the archive, released it, then `persistPlan` took it
    // again — a window in which a peer could re-write the entry we are about
    // to drop). Reconciliation is skipped: folding the disk copy back into a
    // plan we are deleting is exactly the "resurrect a cleared plan" case.
    // The archive write stays INLINE (rather than delegating to the
    // best-effort `archivePlan`) because a failed copy must abort the clear:
    // this method's contract is "reversibly archives, never deletes".
    this.mutate(
      sessionID,
      () => {
        this.writeArchiveCopy(sessionID, plan)
        this.plans.delete(sessionID)
        return { changed: true, result: undefined }
      },
      "delete",
    )
    this.logger("story:plan-cleared", { sessionID })
    return true
  }

  /** Write a plan to `archive/plan.<session>.<ts>.json`, never overwriting an
   * existing file (`wx` + a numeric suffix). Throws on failure; callers that
   * must not be blocked by a failed copy go through `archivePlan`. */
  private writeArchiveCopy(sessionID: string, plan: PlanV2): void {
    fsIO.mkdirSync(this.archiveDir, { recursive: true, mode: 0o700 })
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
    let archivePath = join(this.archiveDir, `plan.${sessionID}.${timestamp}.json`)
    let suffix = 0
    while (fsIO.existsSync(archivePath)) {
      suffix += 1
      archivePath = join(this.archiveDir, `plan.${sessionID}.${timestamp}-${suffix}.json`)
    }
    fsIO.writeFileSync(archivePath, `${JSON.stringify(redactForDisk(plan), null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    })
  }

  /** Best-effort archive used by `createPlan`'s replace path — a plan
   * discarded by a second create is exactly as unrecoverable as one that was
   * cleared, but failing to keep the copy must not fail the create. */
  private archivePlan(sessionID: string, plan: PlanV2): void {
    try {
      this.writeArchiveCopy(sessionID, plan)
    } catch (error) {
      // Best-effort: failing to keep a copy must not block the caller, but it
      // must not be silent either.
      this.logger("plan:archive-failed", { sessionID, reason: (error as Error).message })
    }
  }

  // -- Persistence -----------------------------------------------------------

  private hydrateFromDisk(sessionID: string): void {
    let raw: string
    try {
      if (!fsIO.existsSync(this.planPath)) return
      raw = fsIO.readFileSync(this.planPath, "utf8")
    } catch {
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return
    }
    if (!isRecord(parsed)) return
    const entry = parsed[sessionID]
    if (!isPlanV2(entry)) return
    // Back-compat coercion at the disk boundary: a story-level `dependsOn`
    // is OPTIONAL on disk (plans written before the 2026-07-30 task/DAG
    // redesign predate the field), and so is `revision` (FR-002d — plans
    // written before 2026-08-03). `coerceLoadedPlan` fills both. (Task
    // `dependsOn` is NOT coerced: tasks ship with the DAG redesign, so an
    // absent task dependsOn is a malformed task and already rejected by
    // isTask above.)
    this.plans.set(sessionID, coerceLoadedPlan(entry))
  }

  // -- FR-002: the single read-modify-write seam ---------------------------

  /**
   * FR-002. THE one path through which every plan mutation reaches disk.
   *
   * Acquires the shared state lock ONCE (with the FR-002c bounded retry),
   * re-reads `plan.json`, reconciles the on-disk state into the cached plan
   * IN PLACE, runs `fn`, writes, releases. The ordering is the entire point:
   * the audited session lost a judge stamp because the mutation happened
   * first and the lock only ever covered the write, so a stale cache
   * clobbered a peer's entry. Round-1 C4 also rules out the obvious
   * alternative — re-hydrating inside `persistPlan` (i.e. after the
   * mutation) would discard the caller's own change.
   *
   * Failure posture (FR-010, no new throw reaches the host):
   *  - lock contention exhausted → apply the mutation in memory so this
   *    session keeps working, ABORT the write, log `plan:write-aborted`;
   *  - `plan.json` unparseable → unchanged pre-fix behavior (log
   *    `story:disk-corrupt` and throw before `fn` runs, so nothing is
   *    mutated and no other session's entry is destroyed);
   *  - `fn` throws (an invalid checkpoint, an unknown story) → the throw
   *    propagates exactly as before and no write happens, preserving the
   *    "a rejected call leaves the plan entry unchanged" invariant;
   *  - `fn` reports `changed: false` → no write at all (FR-003).
   */
  private mutate<T>(sessionID: string, fn: (plan: PlanV2 | null) => MutateOutcome<T>, mode: MutateMode = "merge"): T {
    // FR-002b: already inside this engine's critical section — re-acquiring
    // the non-reentrant lock would throw. Run the same read-modify-write
    // body under the lock we already hold.
    if (this.lockHeld) return this.runMutation(sessionID, fn, mode)

    const lock = this.acquireLockWithRetry(sessionID)
    if (!lock) {
      const outcome = fn(this.plans.get(sessionID) ?? null)
      if (outcome.changed) {
        this.logger("plan:write-aborted", { sessionID, reason: "state lock contended", retries: MUTATE_LOCK_RETRIES })
      }
      return outcome.result
    }
    this.lockHeld = true
    try {
      return this.runMutation(sessionID, fn, mode)
    } finally {
      this.lockHeld = false
      lock.release()
    }
  }

  /** The lock-free body of `mutate` (see that method for the contract). */
  private runMutation<T>(sessionID: string, fn: (plan: PlanV2 | null) => MutateOutcome<T>, mode: MutateMode): T {
    const file = this.readPlanFile(sessionID)
    if (mode === "merge") this.reconcileWithDisk(sessionID, file[sessionID])
    const outcome = fn(this.plans.get(sessionID) ?? null)
    if (!outcome.changed) return outcome.result
    this.persistPlan(sessionID, file)
    return outcome.result
  }

  /**
   * FR-002c. `acquireStateLock` throws on contention instead of waiting, so
   * a peer's few-millisecond critical section would otherwise surface as a
   * hard failure inside `checkpoint`. Retry a bounded number of times with
   * jittered backoff (the jitter keeps two colliding instances from
   * re-colliding in lockstep); return `null` — never throw — when the budget
   * is spent, leaving the caller to abort the write.
   *
   * MIN-005: `blockedMs` accumulates every millisecond this method asks the
   * host's event loop to stand still and clamps the next backoff to what is
   * left of `MUTATE_LOCK_MAX_BLOCK_MS` (never below 1ms — a 0ms "sleep"
   * would turn the remaining retries into a filesystem busy-spin). The
   * `attempts` field on `plan:lock-contended` is joined by `blockedMs` so an
   * operator can see the budget was spent, not merely that the lock was
   * busy.
   */
  private acquireLockWithRetry(sessionID: string): { release(): void } | null {
    let blockedMs = 0
    for (let attempt = 0; attempt <= MUTATE_LOCK_RETRIES; attempt += 1) {
      try {
        return lockIO.acquire(this.stateDir)
      } catch (error) {
        if (attempt === MUTATE_LOCK_RETRIES) {
          this.logger("plan:lock-contended", {
            sessionID,
            attempts: attempt + 1,
            blockedMs: Math.round(blockedMs),
            reason: error instanceof Error ? error.message : String(error),
          })
          return null
        }
        const jittered = MUTATE_LOCK_BACKOFF_MS * (0.5 + Math.random())
        const budgeted = Math.max(1, Math.min(jittered, MUTATE_LOCK_MAX_BLOCK_MS - blockedMs))
        blockedMs += budgeted
        lockIO.sleep(budgeted)
      }
    }
    return null
  }

  /**
   * Reads and validates the whole `plan.json`, entry by entry. Lock-free:
   * only ever called from inside `mutate`'s critical section (or from
   * `runMutation` under a lock the caller already holds).
   */
  private readPlanFile(sessionID: string): Record<string, PlanV2> {
    const file: Record<string, PlanV2> = {}
    if (!fsIO.existsSync(this.planPath)) return file
    const raw = fsIO.readFileSync(this.planPath, "utf8")
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      // Genuinely unparseable JSON (NOT merely schema-invalid) — this file
      // may hold every OTHER session's plan. Proceeding from an empty base
      // here (the pre-2026-07 behavior) would silently overwrite all of them
      // with just this session's own plan on the write below, with zero log
      // and zero error. Log distinctly and abort: unlike `pin.ts`'s
      // `persist()`, nothing here catches this, so it propagates straight
      // out of the calling `checkpoint()` / `createPlan()` /
      // `attachEvidence()` / `amendStory()` call — failing loudly is exactly
      // what we want, since destroying other sessions' data is worse than a
      // failed write for this one. Because the read now happens BEFORE the
      // mutation runs, the in-memory plan is left untouched too.
      this.logger("story:disk-corrupt", { sessionID, path: this.planPath, reason: describeParseError(error) })
      throw new Error(
        `plan.json is corrupt (unparseable JSON) — aborting write to avoid destroying other sessions' data: ${describeParseError(error)}`,
      )
    }
    // Parseable but schema-invalid (per-key): a shape this module understands
    // and can safely disregard entry-by-entry (not "someone else's unreadable
    // data") — degrade gracefully, same as before.
    if (isRecord(parsed)) {
      for (const [sid, value] of Object.entries(parsed)) {
        if (isPlanV2(value)) file[sid] = coerceLoadedPlan(value)
      }
    }
    return file
  }

  /**
   * FR-002 (merge mode only): fold the on-disk entry into the cached plan
   * BEFORE the mutation runs.
   *
   * The trigger is `revision` (FR-002d), not a body comparison: a strictly
   * higher on-disk revision means somebody else wrote this session's entry
   * since we last did, which is precisely the condition the audited session
   * hit and silently lost a stamp to. An EQUAL revision is our own last
   * write (nothing to do), and a LOWER one means our cache is ahead — which
   * happens legitimately after a contention-aborted write — so the disk copy
   * must not be allowed to roll us back.
   *
   * The assignment is field-by-field into the existing objects (see
   * `assignPlanInPlace`): `gate.ts:742-753` holds this plan object across
   * `applyJudgeVerdicts` and re-reads `plan.stories` afterwards, so swapping
   * the reference would silently break the plan close-out.
   */
  private reconcileWithDisk(sessionID: string, onDisk: PlanV2 | undefined): void {
    if (!onDisk) return
    const cached = this.plans.get(sessionID)
    if (!cached) {
      // Not hydrated yet — adopt the disk copy wholesale. Nobody can hold a
      // reference to a plan this engine has never handed out, and this is
      // not a conflict, so no `plan:concurrent-merge`.
      this.plans.set(sessionID, onDisk)
      return
    }
    if (cached === onDisk) return
    const cachedRevision = cached.revision ?? 0
    const diskRevision = onDisk.revision ?? 0
    if (diskRevision <= cachedRevision) return
    assignPlanInPlace(cached, onDisk)
    this.logger("plan:concurrent-merge", {
      sessionID,
      cachedRevision,
      diskRevision,
      stories: cached.stories.length,
    })
  }

  /**
   * FR-002: the LOCK-FREE inner write, called only by `runMutation` (which
   * holds the lock and supplies the `file` it already read). Bumps this
   * session's `revision` past both its own and the on-disk value so the
   * counter stays monotonic even across a `replace` that discarded a
   * higher-revision entry.
   */
  private persistPlan(sessionID: string, file: Record<string, PlanV2>): void {
    let next = file
    const current = this.plans.get(sessionID)
    if (current) {
      current.revision = Math.max(current.revision ?? 0, file[sessionID]?.revision ?? 0) + 1
      next = { ...file, [sessionID]: current }
    } else if (sessionID in file) {
      next = { ...file }
      delete next[sessionID]
    }
    this.atomicWrite(next)
  }

  /** Atomic write: `wx` temp file + rename, mode 0600 (pattern reference: `src/goals.ts`, `pin.ts`). */
  private atomicWrite(file: Record<string, PlanV2>): void {
    fsIO.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 })
    const tmpPath = join(this.stateDir, `.plan.${process.pid}.${randomUUID()}.tmp`)
    try {
      fsIO.writeFileSync(tmpPath, `${JSON.stringify(redactForDisk(file), null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      })
      fsIO.renameSync(tmpPath, this.planPath)
      fsIO.chmodSync(this.planPath, 0o600)
    } finally {
      if (fsIO.existsSync(tmpPath)) fsIO.unlinkSync(tmpPath)
    }
  }
}

// ---------------------------------------------------------------------------
// Intake classification (FR-018 / FR-018a / FR-018b)
// ---------------------------------------------------------------------------

/**
 * FR-018a, copied VERBATIM from the spec's code block. The spec gives no
 * literal Korean pattern for this constant (contrast `SEQUENCING_WORDS` /
 * `IMPERATIVE_VERBS` below, which the spec DOES spell out in Korean) — it
 * only says "plus the Korean read-only/typo equivalents" in prose. The
 * trailing Korean alternation is therefore a constructed addition, not a
 * verbatim transcription; see this wave's final report for that judgment
 * call. It covers only the two categories the prose names (typo-fix,
 * read-only), grounded in v1's existing Korean detector vocabulary
 * (`src/index.ts`'s `QUICK_RE`/`DEEP_RE`/`NORMAL_RE`: 수정 = fix/correct,
 * 설명 = explain, 확인 = check) rather than invented from nothing.
 */
export const TRIVIAL_ASK_RE =
  /^(\s*(fix|correct)\s+(a\s+)?typos?\b|\s*rename\s+\S+\s+to\s+\S+\s*$|\s*(what|where|why|how|who|when)\b.*\?\s*$|\s*(read|show|open|print|explain|describe)\b[^.;\n]*$|\s*(bump|pin)\s+\S+\s+to\s+\S+\s*$|\s*오타\s*(를)?\s*(수정|고쳐|고치)|\s*(보여줘|열어줘|출력해줘|설명해줘|알려줘|읽어줘))/i

/** FR-018, copied VERBATIM (English clause + the Korean set, combined via a
 * single top-level alternation — the spec states them as two fragments
 * joined by "plus", this is that same union as one `RegExp`). */
export const SEQUENCING_WORDS =
  /\b(first|then|next|after that|afterwards|finally|also|additionally|and then|followed by)\b|(먼저|그다음|그리고 나서|그리고|마지막으로|이후에)/i

/** FR-018, copied VERBATIM. The spec's Korean list (`추가|구현|수정|리팩터|마이그레이션|삭제|변경|작성`)
 * is given as a bare alternation with no anchor; since an "imperative
 * outcome" is defined as "a top-level clause ... whose FIRST token
 * matches `IMPERATIVE_VERBS`", this module anchors the Korean group to the
 * clause start (`^`) the same way the English group already is —
 * documented judgment call, not a silent structural change to the given
 * substrings themselves. */
export const IMPERATIVE_VERBS =
  /^(add|build|create|implement|fix|refactor|migrate|remove|delete|rename|update|upgrade|write|wire|test|document|split|extract|optimi[sz]e|revert)\b|^(추가|구현|수정|리팩터|마이그레이션|삭제|변경|작성)/i

/** A fenced code block delimiter — a line whose trimmed start is 3+
 * backticks (same convention as `artifacts.ts`'s `scanLines`, reimplemented
 * locally rather than imported since it is a small private helper there,
 * not part of that module's exported surface). */
const FENCE_DELIMITER_RE = /^\s*`{3,}/

/** Strips fenced code block content (and the delimiter lines themselves)
 * before heuristic pattern matching — FR-018: "an occurrence inside a
 * fenced code block ... does not count" (dataset row 9). Only affects
 * PATTERN MATCHING inside this module; the raw `askText` passed to the
 * classification subturn is untouched (the fenced content may still be
 * relevant evidence for an LLM classifier even though it should not drive
 * the deterministic regex heuristic). */
function stripFencedBlocks(text: string): string {
  const lines = text.split(/\r\n|\r|\n/)
  const kept: string[] = []
  let inFence = false
  for (const line of lines) {
    if (FENCE_DELIMITER_RE.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    kept.push(line)
  }
  return kept.join("\n")
}

/**
 * Heuristic fallback only (FR-018) — used when the classification subturn
 * fails/times out. `true` when either:
 *  - `SEQUENCING_WORDS` matches anywhere (fence-aware), or
 *  - the text splits into >=2 "top-level clauses" (spec: split on `.`,
 *    `;`, newline, and a `SEQUENCING_WORDS` match) whose first token
 *    matches `IMPERATIVE_VERBS`.
 *
 * Judgment call (documented, not silent): the split-delimiter set is
 * extended to also cut on a bare `and` (word-boundary). Reasoning: under
 * the spec's own literal delimiter list, "add caching and fix the flaky
 * test" (Dataset: Intake pre-filter row 5) is exactly ONE top-level clause
 * ("and" alone is not a `SEQUENCING_WORDS` match — only "and then" is), so
 * it would produce 1 imperative outcome, not the "(2 imperative verbs)"
 * the dataset's own Notes column claims for that row. Splitting on bare
 * `and` too — the natural degenerate form of the already-enumerated "and
 * then" — reconciles FR-018's prose with its own worked example without
 * inventing a new sequencing word or changing the enumerated regex
 * constants themselves.
 */
export function classifyMultiStoryHeuristic(askText: string): boolean {
  const text = stripFencedBlocks(askText)
  if (SEQUENCING_WORDS.test(text)) return true

  const clauses = text.split(/[.;\n]+|\band\b/i)
  let imperativeCount = 0
  for (const raw of clauses) {
    const clause = raw.trim()
    if (!clause) continue
    if (IMPERATIVE_VERBS.test(clause)) imperativeCount += 1
  }
  return imperativeCount >= 2
}

export interface ClassifyResult {
  multiStory: boolean
  source: "subturn" | "heuristic" | "skipped"
}

/**
 * Raised from the spec's literal 5000ms for the same reason as judge.ts's
 * `JUDGE_TOTAL_BUDGET_MS` (see that constant's comment): once the FR-030b
 * capability probe started passing, live runs showed the intake subturn
 * consuming the whole 5s on the model round-trip and logging
 * `intake:classify-fallback {reason:"timeout"}` every time — so the
 * subturn-first design silently degraded to the heuristic classifier on
 * every real ask. `VERTEX_INTAKE_BUDGET_MS` overrides it (values <= 0 or
 * unparseable fall back to the default).
 *
 * Intake is on the critical path of a user's first turn (unlike the judge,
 * which runs at idle), so this default is deliberately lower than the
 * judge's: a wrong-but-fast heuristic classification is a better failure
 * mode here than a long stall before the assistant responds.
 */
const DEFAULT_INTAKE_SUBTURN_TIMEOUT_MS = 15_000

function resolveIntakeTimeoutMs(): number {
  const raw = Number(process.env.VERTEX_INTAKE_BUDGET_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_INTAKE_SUBTURN_TIMEOUT_MS
}

export const INTAKE_SUBTURN_TIMEOUT_MS = resolveIntakeTimeoutMs()
const INTAKE_AGENT_NAME = "vertex-intake"

const INTAKE_SYSTEM_PROMPT =
  'You are vertex-intake, a zero-tool classification-only subagent. You will be given a single raw user task ' +
  'ask and nothing else. Decide whether it describes two or more distinct, separately-completable outcomes ' +
  '("multi-story") or a single outcome, however large ("single-story"). Reply with exactly one JSON object of ' +
  'the form {"multiStory": true} or {"multiStory": false} and nothing else — no prose, no markdown fences.'

function describeClassifyError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/** Tolerant parse of the intake subturn's `{"multiStory": boolean}` reply —
 * accepts a fenced or prose-wrapped response by falling back to a regex
 * extraction when `JSON.parse` on the trimmed/unfenced text fails. Returns
 * `null` on anything unparseable (treated as a malformed response by the
 * caller, which falls back to the heuristic). */
function parseMultiStoryVerdict(text: string): boolean | null {
  const unfenced = text
    .trim()
    .replace(/^```[a-zA-Z]*\n?/, "")
    .replace(/```\s*$/, "")
    .trim()
  try {
    const parsed: unknown = JSON.parse(unfenced)
    if (isRecord(parsed) && typeof parsed.multiStory === "boolean") return parsed.multiStory
  } catch {
    // fall through to the regex extraction below
  }
  const match = /"multiStory"\s*:\s*(true|false)/i.exec(text)
  if (match) return match[1].toLowerCase() === "true"
  return null
}

/**
 * FR-018/018a/018b: skip (`source: "skipped"`, no client call at all) when
 * `askText` matches `TRIVIAL_ASK_RE`. Otherwise runs the deny-all
 * capability probe (`subturn.ts`'s `probeCapability`, agent
 * `"vertex-intake"` — see the module header's deviation note for why this
 * module, not wiring, is responsible for that call) and, if it passes,
 * issues the classification subturn via `runSubturn` with a 5s total
 * internal budget. On probe failure, subturn failure, timeout, or a
 * malformed response, falls back to `classifyMultiStoryHeuristic` and
 * `source: "heuristic"`.
 *
 * Per the contract: this function makes exactly ONE classification
 * attempt per call and does NOT self-throttle the once-per-task /
 * `VERTEX_INTAKE_SUBTURN_MAX`-per-session caps (FR-018b) — those need
 * session-lifetime state that lives in wiring's ledger, not here. Callers
 * decide whether to call this function at all for a given user message.
 */
export async function classifyMultiStory(
  client: OpencodeClient,
  deps: { selfCreated: SelfCreatedSessions; logger: EventLogger },
  opts: { parentSessionID: string; sessionModel: { providerID: string; modelID: string }; askText: string },
): Promise<ClassifyResult> {
  if (TRIVIAL_ASK_RE.test(stripFencedBlocks(opts.askText))) {
    deps.logger("intake:classify-skipped", { sessionID: opts.parentSessionID })
    return { multiStory: false, source: "skipped" }
  }

  let probe
  try {
    probe = await probeCapability(client, INTAKE_AGENT_NAME)
  } catch (err) {
    probe = { ok: false, reason: `probeCapability threw: ${describeClassifyError(err)}` }
  }
  if (!probe.ok) {
    deps.logger("intake:unsupported", { sessionID: opts.parentSessionID, reason: probe.reason ?? "unknown" })
    return { multiStory: classifyMultiStoryHeuristic(opts.askText), source: "heuristic" }
  }

  let tools: Record<string, boolean>
  try {
    tools = await buildDenyMap(client)
  } catch (err) {
    deps.logger("intake:unsupported", {
      sessionID: opts.parentSessionID,
      reason: `buildDenyMap failed: ${describeClassifyError(err)}`,
    })
    return { multiStory: classifyMultiStoryHeuristic(opts.askText), source: "heuristic" }
  }

  const result = await runSubturn(client, deps.selfCreated, deps.logger, {
    parentSessionID: opts.parentSessionID,
    agent: INTAKE_AGENT_NAME,
    model: opts.sessionModel,
    system: INTAKE_SYSTEM_PROMPT,
    parts: [{ type: "text", text: opts.askText }],
    tools,
    timeoutMs: INTAKE_SUBTURN_TIMEOUT_MS,
  })

  if (!result.ok) {
    deps.logger("intake:classify-fallback", { sessionID: opts.parentSessionID, reason: result.reason })
    return { multiStory: classifyMultiStoryHeuristic(opts.askText), source: "heuristic" }
  }

  const verdict = parseMultiStoryVerdict(result.text)
  if (verdict === null) {
    deps.logger("intake:classify-fallback", { sessionID: opts.parentSessionID, reason: "malformed subturn response" })
    return { multiStory: classifyMultiStoryHeuristic(opts.askText), source: "heuristic" }
  }

  return { multiStory: verdict, source: "subturn" }
}
