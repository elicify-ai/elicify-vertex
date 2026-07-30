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
  return true
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

export class StoryEngine {
  private readonly stateDir: string
  private readonly planPath: string
  private readonly goalsPath: string
  private readonly archiveDir: string
  private readonly logger: EventLogger
  private readonly plans = new Map<string, PlanV2>()

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

    const lock = acquireStateLock(this.stateDir)
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
      lock.release()
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

    // Archive an existing plan before replacing it. `createPlan` used to
    // overwrite unconditionally while `clearPlan` archived — so a second
    // `elicify_vertex_plan_create` call silently discarded the user's stories,
    // their acceptance items AND their attached evidence, with no log and
    // nothing to recover. Losing a contract is exactly as bad as losing the
    // evidence for it.
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
    this.persistPlan(sessionID)
    return plan
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
    const plan = this.getPlan(sessionID)
    if (!plan) return
    const story = plan.stories.find((candidate) => candidate.id === storyId)
    if (!story) return
    const item = story.acceptanceItems.find((candidate) => candidate.id === itemId)
    if (!item) return
    item.evidence = evidence
    this.persistPlan(sessionID)
  }

  /**
   * ADDED — not in the §9 contract's method list (see header comment).
   * Records a scope amendment (the "amend" arm of `checkScope`'s
   * fold/amend/revert offer) and optionally updates `scopeGlobs`/
   * `verifiers`. Throws on an unknown session/story.
   */
  amendStory(sessionID: string, storyId: string, opts: { reason: string; scopeGlobs?: string[]; verifiers?: string[] }): void {
    const plan = this.getPlan(sessionID)
    if (!plan) throw new Error(`no story plan for session ${sessionID}`)
    const story = plan.stories.find((candidate) => candidate.id === storyId)
    if (!story) throw new Error(`unknown story: ${storyId}`)

    const reason = requireNonBlank(opts.reason, "amendment reason")
    story.amendments.push({ reason, ts: new Date().toISOString() })
    if (opts.scopeGlobs) story.scopeGlobs = [...opts.scopeGlobs]
    if (opts.verifiers) story.verifiers = [...opts.verifiers]
    this.persistPlan(sessionID)
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
   */
  reopenStory(sessionID: string, storyId: string, opts: { reason: string }): void {
    const plan = this.getPlan(sessionID)
    if (!plan) throw new Error(`no story plan for session ${sessionID}`)
    const story = plan.stories.find((candidate) => candidate.id === storyId)
    if (!story) throw new Error(`unknown story: ${storyId}`)

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
    this.logger("story:reopened", { sessionID, storyId, previousStatus, newStatus: story.status })
    this.persistPlan(sessionID)
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
   */
  checkpoint(
    sessionID: string,
    taskId: string,
    status: "complete" | "failed" | "blocked",
    opts?: { reason?: string },
  ): void {
    this.archiveV1IfPresent()
    const plan = this.getPlan(sessionID)
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

    this.persistPlan(sessionID)
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
   *    (still useful audit information) but nothing transitions.
   * Unknown story ids are collected into `unknown` and NEVER throw. Persists
   * once at the end and logs `story:judge-audit`. Throws only when the
   * session has no plan at all.
   */
  applyJudgeVerdicts(
    sessionID: string,
    verdicts: Array<{ storyId: string; pass: boolean; summary: string; items: JudgeItemNote[] }>,
  ): { reverted: string[]; passed: string[]; unknown: string[] } {
    const plan = this.getPlan(sessionID)
    if (!plan) throw new Error(`no story plan for session ${sessionID}`)

    const reverted: string[] = []
    const passed: string[] = []
    const unknown: string[] = []
    const judgedAt = new Date().toISOString()

    for (const verdict of verdicts) {
      const story = plan.stories.find((candidate) => candidate.id === verdict.storyId)
      if (!story) {
        unknown.push(verdict.storyId)
        continue
      }
      // Copy the items defensively — the stamp becomes part of the
      // persisted plan and must not alias the judge module's array.
      story.judge = {
        pass: verdict.pass,
        summary: verdict.summary,
        items: verdict.items.map((item) => ({ ...item })),
        judgedAt,
      }
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
      }
    }

    this.persistPlan(sessionID)
    this.logger("story:judge-audit", { sessionID, passed, reverted, unknown })
    return { reverted, passed, unknown }
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

    const lock = acquireStateLock(this.stateDir)
    try {
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
    } finally {
      lock.release()
    }

    this.plans.delete(sessionID)
    this.persistPlan(sessionID)
    this.logger("story:plan-cleared", { sessionID })
    return true
  }

  /** Write a plan to `archive/plan.<session>.<ts>.json`. Shared by
   * `clearPlan` and by `createPlan`'s replace path — a plan discarded by a
   * second create is exactly as unrecoverable as one that was cleared. */
  private archivePlan(sessionID: string, plan: PlanV2): void {
    try {
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
    // Back-compat coercion: a story-level `dependsOn` is OPTIONAL on disk
    // (plans written before the 2026-07-30 task/DAG redesign predate the
    // field and must still load). The in-memory type requires it, so fill
    // the absent case to [] at the disk boundary — the one place a
    // pre-redesign shape can reach memory. (Task `dependsOn` is NOT coerced:
    // tasks ship with this redesign, so an absent task dependsOn is a
    // malformed task and already rejected by isTask above.)
    for (const story of entry.stories) {
      if (story.dependsOn === undefined) story.dependsOn = []
    }
    this.plans.set(sessionID, entry)
  }

  private persistPlan(sessionID: string): void {
    const lock = acquireStateLock(this.stateDir)
    try {
      let file: Record<string, PlanV2> = {}
      if (fsIO.existsSync(this.planPath)) {
        const raw = fsIO.readFileSync(this.planPath, "utf8")
        let parsed: unknown
        try {
          parsed = JSON.parse(raw)
        } catch (error) {
          // Genuinely unparseable JSON (NOT merely schema-invalid) — this
          // file may hold every OTHER session's plan. Proceeding from an
          // empty base here (the old behavior) would silently overwrite all
          // of them with just this session's own plan on the write below,
          // with zero log and zero error. Log distinctly and abort: unlike
          // `pin.ts`'s `persist()`, nothing here catches this, so it
          // propagates straight out of the calling `checkpoint()` /
          // `createPlan()` / `attachEvidence()` / `amendStory()` call —
          // failing loudly is exactly what we want, since destroying other
          // sessions' data is worse than a failed write for this one.
          this.logger("story:disk-corrupt", { sessionID, path: this.planPath, reason: describeParseError(error) })
          throw new Error(
            `plan.json is corrupt (unparseable JSON) — aborting write to avoid destroying other sessions' data: ${describeParseError(error)}`,
          )
        }
        // Parseable but schema-invalid (per-key): a shape this module
        // understands and can safely disregard entry-by-entry (not
        // "someone else's unreadable data") — degrade gracefully, same as
        // before.
        if (isRecord(parsed)) {
          for (const [sid, value] of Object.entries(parsed)) {
            if (isPlanV2(value)) file[sid] = value
          }
        }
      }
      const current = this.plans.get(sessionID)
      if (current) {
        file = { ...file, [sessionID]: current }
      } else if (sessionID in file) {
        const rest = { ...file }
        delete rest[sessionID]
        file = rest
      }
      this.atomicWrite(file)
    } finally {
      lock.release()
    }
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
