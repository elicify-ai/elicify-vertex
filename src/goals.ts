import { randomUUID } from "node:crypto"
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
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"

import { redactForDisk, redactSecrets } from "./redaction.js"

/** True when path is filesystem root (`/` or `C:\`) — never a project worktree. */
export function isFilesystemRoot(path: string): boolean {
  const resolved = resolve(path)
  const parent = dirname(resolved)
  return parent === resolved
}

/** True when we can create `.elicify-vertex` under this directory. */
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
 * Pick a writable project root for multi-story goal state (`.elicify-vertex/`).
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

export interface VerificationReceipt {
  id: string
  sessionID: string
  workspaceRoot: string
  command: string
  exitCode: 0
  outcome: "verified"
  outputSummary: string
  observedAt: string
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

/** In-memory verified-command receipts. The persisted final checkpoint embeds
 * a sanitized copy of observed receipts rather than caller-authored verify strings. */
export class VerificationReceiptStore {
  private readonly bySession = new Map<string, VerificationReceipt[]>()

  record(input: Omit<VerificationReceipt, "id" | "command" | "outputSummary"> & {
    command: string
    outputSummary: string
  }): VerificationReceipt {
    const receipt: VerificationReceipt = {
      ...input,
      id: `vrf_${randomUUID().replace(/-/g, "")}`,
      command: redactSecrets(input.command).slice(0, 500),
      outputSummary: redactSecrets(input.outputSummary).slice(0, 500),
    }
    const receipts = this.bySession.get(receipt.sessionID) ?? []
    receipts.push(receipt)
    this.bySession.set(receipt.sessionID, receipts.slice(-20))
    return receipt
  }

  get(sessionID: string, receiptID: string): VerificationReceipt | null {
    return this.bySession.get(sessionID)?.find((receipt) => receipt.id === receiptID) ?? null
  }

  invalidate(sessionID: string): void {
    this.bySession.delete(sessionID)
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
    this.stateDirectory = join(this.root, ".elicify-vertex")
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
