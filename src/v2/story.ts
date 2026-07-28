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
 *    type carries `acceptanceItems[].evidence` and `amendments`, and
 *    `checkpoint`/`checkScope` read/describe them, but the §9 contract
 *    lists no method that ever WRITES either field. Without some write
 *    path, `checkpoint(complete)` could never succeed and `amendments`
 *    could never be non-empty. Both new methods mirror `pin.ts`'s
 *    `attachEvidence` shape/spirit as closely as the different schema
 *    allows.
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
  evidence: { receiptId: string } | { waiver: true; sourceMessageId: string; signature?: string } | null
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
   * internally consistent, matching v1's `StoryStatus` precedent
   * (`src/goals.ts`: `"pending" | "in_progress" | "complete" | "failed" |
   * "blocked"`), which already treats `"failed"` and `"blocked"` as
   * distinct terminal states.
   */
  status: "pending" | "active" | "complete" | "blocked" | "failed"
  /**
   * ADDED — wave-4 cross-file dependency (`wiring/tools.ts`'s FR-020
   * "time-valid receipt" check: a receipt observed BEFORE the story started
   * shouldn't count as evidence for it). ISO-8601 timestamp set the moment
   * this story's status transitions to `"active"` — in `createPlan` for the
   * first story, and in `checkpoint`'s successor-promotion for every story
   * promoted afterward. Deliberately OPTIONAL so a `plan.json` written
   * before this field existed still validates on load (`isStoryV2` accepts
   * it absent); a missing `startedAt` means "unknown, don't enforce the
   * time bound" to any consumer, not an error.
   */
  startedAt?: string
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

function isAmendment(value: unknown): value is { reason: string; ts: string } {
  return isRecord(value) && typeof value.reason === "string" && typeof value.ts === "string"
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
  // `startedAt` is optional (added after the original schema shipped): a
  // plan.json written before this field existed has no key at all here,
  // which must still validate — only reject it when PRESENT but non-string.
  if (value.startedAt !== undefined && typeof value.startedAt !== "string") return false
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

  createPlan(
    sessionID: string,
    confirmed: Array<{ text: string; acceptanceItems: string[]; scopeGlobs: string[]; verifiers: string[] }>,
  ): PlanV2 {
    this.archiveV1IfPresent()
    if (confirmed.length === 0) throw new Error("a story plan requires at least one story")

    const now = new Date().toISOString()
    const stories: StoryV2[] = confirmed.map((input, index) => {
      const storyId = `S${index + 1}`
      const status: StoryV2["status"] = index === 0 ? "active" : "pending"
      return {
        id: storyId,
        text: requireNonBlank(input.text, `stories[${index}].text`),
        acceptanceItems: input.acceptanceItems.map((text, itemIndex) => ({
          id: `A${itemIndex + 1}`,
          text: requireNonBlank(text, `stories[${index}].acceptanceItems[${itemIndex}]`),
          evidence: null,
        })),
        scopeGlobs: [...input.scopeGlobs],
        verifiers: [...input.verifiers],
        assumptions: [],
        rejectedAlternatives: [],
        amendments: [],
        status,
        // Set only for the story that becomes active at creation — pending
        // stories have no `startedAt` until `checkpoint` promotes them.
        ...(status === "active" ? { startedAt: now } : {}),
      }
    })

    const plan: PlanV2 = {
      schemaVersion: 2,
      stories,
      finalStoryId: stories[stories.length - 1].id,
      createdAt: now,
    }
    if (!isPlanV2(plan)) throw new Error("internal error: constructed plan failed schema validation")

    // Archive an existing plan before replacing it. `createPlan` used to
    // overwrite unconditionally while `clearPlan` archived -- so a second
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

  getActiveStory(sessionID: string): StoryV2 | null {
    const plan = this.getPlan(sessionID)
    if (!plan) return null
    return plan.stories.find((story) => story.status === "active") ?? null
  }

  /**
   * ADDED — not in the §9 contract's method list (see header comment).
   * Attaches (or clears, when `evidence` is `null`) an acceptance item's
   * evidence pointer and persists immediately — `StoryEngine` exposes no
   * separate public `persist()` the way `PinStore` does, so there is no
   * other way for a caller to flush the change to disk. (`pin.ts`'s own
   * `attachEvidence` also auto-persists now — wave-4 fix — so both
   * modules' `attachEvidence` share the same "every mutation leaves memory
   * and disk consistent" contract.) Unknown session/story/item ids are
   * no-ops, never throw (mirrors `pin.ts`'s convention).
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
   * `verifiers`. Throws on an unknown session/story (an amendment against
   * a story that does not exist is a caller bug, unlike a missing-evidence
   * read which is expected to be a common no-op).
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

  // -- FR-021: scope watchdog -----------------------------------------------

  /**
   * Returns a scope-drift finding-shaped object when `mutatedPath` falls
   * outside the active story's `scopeGlobs`, or `null` when it is in scope
   * (including the "no scope declared" case — an empty `scopeGlobs` array
   * is read as "no constraint", not "matches nothing"). At most one per
   * turn is the composer's job (FR-004 cap table), not this method's — it
   * always returns a finding when out of scope and lets the caller decide
   * whether to render it.
   *
   * `opts.scopeGlobsMatchedZero` (see header comment for why this
   * parameter exists beyond the two-argument contract signature): when
   * `true`, the recommended `offer` is `"amend"` first (the spec's
   * branch-switch/typo edge case — folding or reverting a mutation against
   * globs that match nothing in the worktree makes no sense, the globs
   * themselves are what's wrong). Otherwise the recommended `offer` is
   * `"fold"` (judgment call: the least-disruptive default for an ordinary
   * single-mutation drift). `offer` is a single recommended action, not
   * the full menu — the composer/wiring renders fold/amend/revert as the
   * full set of choices in the directive text regardless of which one is
   * recommended here.
   */
  checkScope(
    sessionID: string,
    mutatedPath: string,
    opts?: { scopeGlobsMatchedZero?: boolean },
  ): { family: "scope-watchdog"; offer: "fold" | "amend" | "revert"; scopeGlobsMatchedZero: boolean } | null {
    this.archiveV1IfPresent()
    const story = this.getActiveStory(sessionID)
    if (!story) return null
    if (story.scopeGlobs.length === 0) return null

    const inScope = story.scopeGlobs.some((glob) => matchesGlob(mutatedPath, glob))
    if (inScope) return null

    const scopeGlobsMatchedZero = opts?.scopeGlobsMatchedZero ?? false
    return {
      family: "scope-watchdog",
      offer: scopeGlobsMatchedZero ? "amend" : "fold",
      scopeGlobsMatchedZero,
    }
  }

  // -- FR-019/FR-020: checkpoint --------------------------------------------

  /**
   * FR-019/FR-020: throws (naming the specific acceptance item id) when
   * `status === "complete"` and any acceptance item lacks evidence.
   *
   * Also throws (naming both the requested and the actual active story id)
   * when `status === "complete"` and `storyId` is not the plan's CURRENT
   * active story — completing a non-active story directly would silently
   * strand the plan, since successor-promotion below only fires off of
   * `wasActive`. This check runs before evidence validation.
   *
   * Evidence-shape enforcement performed HERE (structural only — see the
   * module header's "waiver-provenance boundary" note repeated below):
   *  - `{ receiptId }`: the id must be non-blank. For the plan's
   *    `finalStoryId`, `opts.isValidReceipt` is MANDATORY in effect — if
   *    omitted, the receipt cannot be proven "observed" and the checkpoint
   *    is rejected (FR-020: "the final verification story MUST require an
   *    OBSERVED ... receipt"). For any other story, `opts.isValidReceipt`
   *    is consulted only if the caller supplied it (defense in depth) —
   *    FR-019's bar for non-final stories is merely "an evidence pointer
   *    exists", the "observed" requirement is FR-020's, and FR-020 is
   *    explicitly scoped to "the final verification story".
   *  - `{ waiver: true, sourceMessageId }`: valid only STRUCTURALLY here
   *    (`sourceMessageId` is a non-empty string). Whether that message id
   *    actually names a real user-authored chat message — as opposed to,
   *    e.g., a string the model invented inside its own tool-call
   *    arguments — is NOT decided in this module, because this module has
   *    no access to the message stream. See the module header and this
   *    wave's final report for the exact boundary: wiring MUST NOT call
   *    `attachEvidence` with a waiver whose `sourceMessageId` it has not
   *    independently traced to a real `role: "user"` message. A
   *    model-issued waiver that wiring correctly refuses to attach simply
   *    leaves that item's `evidence` at `null`, which this method already
   *    rejects via the "no evidence" branch below (Dataset row 6).
   *
   * On success, the story's status is set. When a NON-final story
   * transitions to `"complete"`, the next `"pending"` story (in array
   * order) is promoted to `"active"` — the contract exposes no separate
   * `next()`-style method, so `checkpoint` is the only place this
   * transition can happen.
   *
   * Nothing is persisted (or mutated in memory) until every item has been
   * validated, so a thrown error leaves the plan file byte-for-byte
   * unchanged (BDD: "Checkpoint rejected when a criterion lacks evidence").
   */
  checkpoint(
    sessionID: string,
    storyId: string,
    status: "complete" | "failed" | "blocked",
    opts: { isValidReceipt?: (receiptId: string) => boolean },
  ): void {
    this.archiveV1IfPresent()
    const plan = this.getPlan(sessionID)
    if (!plan) throw new Error(`no story plan for session ${sessionID}`)
    const story = plan.stories.find((candidate) => candidate.id === storyId)
    if (!story) throw new Error(`unknown story: ${storyId}`)

    if (status === "complete") {
      // Successor-promotion below is gated on `wasActive` — completing a
      // story that is NOT the plan's current active story (e.g. a
      // "pending" one, completed directly out of order) would silently
      // strand the plan: the real active story stays active forever,
      // nothing downstream ever gets promoted, and the story just marked
      // "complete" sits there having skipped the queue. Reject it up front,
      // naming both ids so the caller can see exactly what went wrong.
      const currentActive = plan.stories.find((candidate) => candidate.status === "active")
      if (!currentActive || currentActive.id !== storyId) {
        throw new Error(
          `cannot complete story ${storyId}: it is not the plan's current active story ` +
            `(active story is ${currentActive ? currentActive.id : "none"})`,
        )
      }

      const isFinal = storyId === plan.finalStoryId
      for (const item of story.acceptanceItems) {
        if (!item.evidence) {
          throw new Error(`cannot complete story ${storyId}: acceptance item ${item.id} has no evidence`)
        }
        if ("receiptId" in item.evidence) {
          const receiptId = item.evidence.receiptId
          if (!receiptId || !receiptId.trim()) {
            throw new Error(`cannot complete story ${storyId}: acceptance item ${item.id} has a blank receipt id`)
          }
          if (isFinal) {
            const observed = opts.isValidReceipt ? opts.isValidReceipt(receiptId) : false
            if (!observed) {
              throw new Error(
                `cannot complete story ${storyId}: acceptance item ${item.id}'s receipt ${receiptId} is not an observed receipt`,
              )
            }
          } else if (opts.isValidReceipt && !opts.isValidReceipt(receiptId)) {
            throw new Error(
              `cannot complete story ${storyId}: acceptance item ${item.id}'s receipt ${receiptId} is not an observed receipt`,
            )
          }
        } else {
          if (item.evidence.waiver !== true || typeof item.evidence.sourceMessageId !== "string" || !item.evidence.sourceMessageId.trim()) {
            throw new Error(`cannot complete story ${storyId}: acceptance item ${item.id} has a malformed waiver`)
          }
        }
      }
    }

    const wasActive = story.status === "active"
    story.status = status
    if (status === "complete" && wasActive) {
      const next = plan.stories.find((candidate) => candidate.status === "pending")
      if (next) {
        next.status = "active"
        next.startedAt = new Date().toISOString()
      }
    }

    this.persistPlan(sessionID)
  }

  // -- Plan clear (human-facing escape hatch) --------------------------------

  /**
   * Reversibly archives (never deletes) the session's current plan entry —
   * the human-facing escape hatch for abandoning/resetting a plan (invoked
   * via `/elicify-vertex-plan-clear` or a direct natural-language request,
   * never proactively offered by the composer/findings system). Mirrors
   * `archiveV1IfPresent`'s never-destroy convention, adapted for a single
   * entry inside the shared multi-session `plan.json` file rather than a
   * whole-file migration: the plan is serialized to its own file under
   * `archive/`, then the session's key is dropped from `plan.json` (leaving
   * every other session's entry untouched). Returns `false` (no-op) when
   * the session has no plan to clear.
   */
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
