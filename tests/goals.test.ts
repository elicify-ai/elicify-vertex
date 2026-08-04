import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import {
  MultiStoryGoalEngine,
  VerificationReceiptStore,
  isFilesystemRoot,
  isWritableGoalRoot,
  resolveGoalWorkspaceRoot,
  type VerificationReceipt,
} from "../src/goals.js"

// Item 5: create → next → checkpoint with receipt-backed final gate
// (not string-only verify / false "all complete" state).

const roots: string[] = []

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "vertex-goals-"))
  roots.push(root)
  return root
}

function tickingClock(): () => string {
  let tick = 0
  return () => new Date(Date.UTC(2026, 6, 23, 12, 0, tick++)).toISOString()
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("resolveGoalWorkspaceRoot", () => {
  it("rejects filesystem root and unwritable anchors", () => {
    expect(isFilesystemRoot("/")).toBe(true)
    expect(isWritableGoalRoot("/")).toBe(false)
    // Prefer an explicit writable temp root over cwd/home noise.
    const root = temporaryRoot()
    expect(resolveGoalWorkspaceRoot(["/", root])).toBe(root)
    expect(resolveGoalWorkspaceRoot([root, "/"])).toBe(root)
  })

  it("falls back to a later writable candidate when earlier ones are root", () => {
    const root = temporaryRoot()
    expect(resolveGoalWorkspaceRoot([undefined, "", "/", root])).toBe(root)
  })

  it("MultiStoryGoalEngine refuses to bind state under filesystem root", () => {
    expect(() => new MultiStoryGoalEngine("/")).toThrow(/writable project directory/i)
  })
})

describe("MultiStoryGoalEngine", () => {
  it("creates a validated sequential plan and appends an explicit final verification story", () => {
    const engine = new MultiStoryGoalEngine(temporaryRoot(), tickingClock())
    const plan = engine.create("Deliver the feature", [
      { title: "Implement", objective: "Build the feature" },
      { title: "Document", objective: "Update usage docs" },
    ])

    expect(plan).toMatchObject({ schemaVersion: 1, revision: 1, status: "active", activeStoryId: null })
    expect(plan.stories).toHaveLength(3)
    expect(plan.stories.map((story) => story.id)).toEqual(["G001", "G002", "G003"])
    expect(plan.stories.at(-1)).toMatchObject({ kind: "verification", status: "pending" })
    expect(statSync(engine.statePath).mode & 0o777).toBe(0o600)
    expect(statSync(engine.ledgerPath).mode & 0o777).toBe(0o600)
  })

  it("requires nonblank structured work stories and explicit replacement", () => {
    const engine = new MultiStoryGoalEngine(temporaryRoot())
    expect(() => engine.create("brief", [])).toThrow(/at least one work story/i)
    expect(() => engine.create("brief", [{ title: "", objective: "work" }])).toThrow(/title must not be blank/i)
    engine.create("brief", [{ title: "one", objective: "work" }])
    expect(() => engine.create("other", [{ title: "two", objective: "work" }])).toThrow(/already exists/i)
    const replacement = engine.create("other", [{ title: "two", objective: "work" }], true)
    expect(replacement.brief).toBe("other")
    expect(existsSync(join(engine.stateDirectory, "archive"))).toBe(true)
  })

  it("starts only one story and returns the same active story on repeated next", () => {
    const engine = new MultiStoryGoalEngine(temporaryRoot(), tickingClock())
    engine.create("brief", [{ title: "one", objective: "work" }])
    const started = engine.next()
    const repeated = engine.next()
    expect(started.activeStoryId).toBe("G001")
    expect(started.stories[0].status).toBe("in_progress")
    expect(repeated.revision).toBe(started.revision)
    expect(repeated.activeStoryId).toBe("G001")
  })

  it("requires evidence and rejects checkpoints for non-active stories", () => {
    const engine = new MultiStoryGoalEngine(temporaryRoot())
    engine.create("brief", [{ title: "one", objective: "work" }])
    engine.next()
    expect(() => engine.checkpoint("G002", "complete", "evidence")).toThrow(/not the active/i)
    expect(() => engine.checkpoint("G001", "complete", " ")).toThrow(/evidence must not be blank/i)
  })

  it("halts as blocked or failed and never reports the plan complete", () => {
    for (const status of ["blocked", "failed"] as const) {
      const engine = new MultiStoryGoalEngine(temporaryRoot())
      engine.create("brief", [{ title: "one", objective: "work" }])
      engine.next()
      const plan = engine.checkpoint("G001", status, `${status} evidence`)
      expect(plan.status).toBe(status)
      expect(plan.status).not.toBe("complete")
      expect(() => engine.next()).toThrow(new RegExp(`plan is ${status}`, "i"))
    }
  })

  it("rejects caller-authored final proof and accepts only a current observed receipt", () => {
    const root = temporaryRoot()
    const engine = new MultiStoryGoalEngine(root, tickingClock())
    engine.create("brief", [{ title: "one", objective: "work" }])
    engine.next()
    engine.checkpoint("G001", "complete", "implementation observed")
    const finalStory = engine.next().stories[1]

    expect(() => engine.checkpoint(finalStory.id, "complete", "trust me")).toThrow(/requires an observed/i)
    const wrongRoot = {
      id: "vrf_wrong",
      sessionID: "s1",
      workspaceRoot: temporaryRoot(),
      command: "npm test",
      exitCode: 0,
      outcome: "verified",
      outputSummary: "10 passed",
      observedAt: "2026-07-23T12:00:10.500Z",
    } satisfies VerificationReceipt
    expect(() => engine.checkpoint(finalStory.id, "complete", "proof", wrongRoot)).toThrow(/different workspace/i)
  })

  it("rejects receipts that predate the final story or arrive in the future", () => {
    const root = temporaryRoot()
    const engine = new MultiStoryGoalEngine(root, tickingClock())
    engine.create("brief", [{ title: "one", objective: "work" }])
    engine.next()
    engine.checkpoint("G001", "complete", "implementation observed")
    const finalPlan = engine.next()
    const startedAt = finalPlan.stories.at(-1)!.startedAt!
    const predated: VerificationReceipt = {
      id: "vrf_old",
      sessionID: "s1",
      workspaceRoot: root,
      command: "npm test",
      exitCode: 0,
      outcome: "verified",
      outputSummary: "ok",
      observedAt: new Date(Date.parse(startedAt) - 1000).toISOString(),
    }
    expect(() => engine.checkpoint(finalPlan.activeStoryId!, "complete", "stale", predated)).toThrow(/predates/i)
    const future: VerificationReceipt = {
      ...predated,
      id: "vrf_future",
      observedAt: new Date(Date.parse(startedAt) + 86_400_000).toISOString(),
    }
    expect(() => engine.checkpoint(finalPlan.activeStoryId!, "complete", "future", future)).toThrow(/future/i)
  })

  it("persists a complete plan only after every story and a successful final receipt", () => {
    const root = temporaryRoot()
    const engine = new MultiStoryGoalEngine(root, tickingClock())
    engine.create("brief", [
      { title: "one", objective: "first" },
      { title: "two", objective: "second" },
    ])
    engine.next()
    engine.checkpoint("G001", "complete", "first complete")
    engine.next()
    engine.checkpoint("G002", "complete", "second complete")
    const finalPlan = engine.next()
    const receipt: VerificationReceipt = {
      id: "vrf_final",
      sessionID: "s1",
      workspaceRoot: root,
      command: "npm test",
      exitCode: 0,
      outcome: "verified",
      outputSummary: "163 passed",
      observedAt: new Date(Date.parse(finalPlan.stories.at(-1)!.startedAt!) + 1).toISOString(),
    }
    const complete = engine.checkpoint(finalPlan.activeStoryId!, "complete", "all exit proofs passed", receipt)

    expect(complete.status).toBe("complete")
    expect(complete.stories.every((story) => story.status === "complete")).toBe(true)
    expect(complete.stories.at(-1)?.verification?.id).toBe("vrf_final")
    expect(new MultiStoryGoalEngine(root).status()).toEqual(complete)
  })

  it("redacts all snapshot and ledger strings at the write boundary", () => {
    const engine = new MultiStoryGoalEngine(temporaryRoot())
    engine.create("password=secret value", [{ title: "one", objective: "Bearer abcdefghijklmnopqrstuvwxyz" }])
    engine.next()
    engine.checkpoint("G001", "complete", "token=another-secret")
    const disk = readFileSync(engine.statePath, "utf8") + readFileSync(engine.ledgerPath, "utf8")
    expect(disk).not.toContain("secret value")
    expect(disk).not.toContain("abcdefghijklmnopqrstuvwxyz")
    expect(disk).not.toContain("another-secret")
    expect(disk).toContain("[REDACTED]")
  })

  it("rejects corrupt state without overwriting it", () => {
    const engine = new MultiStoryGoalEngine(temporaryRoot())
    mkdirSync(engine.stateDirectory, { recursive: true })
    writeFileSync(engine.statePath, "{broken", "utf8")
    expect(() => engine.status()).toThrow(/cannot read goal plan/i)
    expect(readFileSync(engine.statePath, "utf8")).toBe("{broken")
  })

  it("rejects semantically forged completion receipts", () => {
    const engine = new MultiStoryGoalEngine(temporaryRoot())
    const plan = engine.create("brief", [{ title: "one", objective: "work" }])
    plan.status = "complete"
    for (const story of plan.stories) {
      story.status = "complete"
      story.evidence = "claimed evidence"
      story.startedAt = "2026-07-23T12:00:00.000Z"
      story.completedAt = "2026-07-23T12:02:00.000Z"
    }
    plan.stories.at(-1)!.verification = {
      id: "vrf_forged",
      sessionID: "forged-session",
      workspaceRoot: "/different-workspace",
      command: "npm test",
      outcome: "verified",
      exitCode: 0,
      outputSummary: "all passed",
      observedAt: "2026-07-23T12:01:00.000Z",
    }
    writeFileSync(engine.statePath, JSON.stringify(plan), "utf8")
    expect(() => engine.status()).toThrow(/lacks a successful final verification receipt/i)
  })

  it("does not remove a live lock owned by another process", () => {
    const engine = new MultiStoryGoalEngine(temporaryRoot())
    engine.create("brief", [{ title: "one", objective: "work" }])
    const lockPath = join(engine.stateDirectory, "goals.lock")
    writeFileSync(lockPath, "other process", "utf8")
    expect(() => engine.next()).toThrow(/another process/i)
    expect(existsSync(lockPath)).toBe(true)
  })
})

describe("VerificationReceiptStore", () => {
  it("binds receipts to sessions and redacts command/output before storage", () => {
    const store = new VerificationReceiptStore()
    const receipt = store.record({
      sessionID: "s1",
      workspaceRoot: "/work",
      command: "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz'",
      exitCode: 0,
      outcome: "verified",
      outputSummary: "password=secret-value",
      observedAt: "2026-07-23T12:00:00.000Z",
    })
    expect(receipt.command).not.toContain("abcdefghijklmnopqrstuvwxyz")
    expect(receipt.outputSummary).not.toContain("secret-value")
    expect(store.get("s1", receipt.id)).toEqual(receipt)
    expect(store.get("other", receipt.id)).toBeNull()
  })
})
