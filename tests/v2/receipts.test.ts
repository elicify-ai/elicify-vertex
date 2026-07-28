/**
 * `VerificationReceiptStore` persistence + staleness (src/goals.ts).
 *
 * The defect these cover: receipts used to live in a bare in-memory `Map`, so
 * "come back tomorrow" re-demanded proof of things already proved; and a
 * receipt recorded nothing about WHAT it verified, so "story S1 is verified"
 * was a coincidence of timing rather than a checkable fact.
 *
 * The dangerous half is staleness, not persistence: a receipt from last week
 * that still counts is strictly worse than no persistence at all. Every test
 * below that asserts a REFUSAL is written so that deleting the invalidation
 * logic turns it red — see the per-test comments naming the exact source edit.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import {
  RECEIPTS_SCHEMA_VERSION,
  VerificationReceiptStore,
  fingerprintWorktree,
  type VerificationReceipt,
} from "../../src/goals.js"

const roots: string[] = []

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "vertex-receipts-"))
  roots.push(root)
  // A worktree with at least one real file, so the fingerprint has something
  // to be a fingerprint OF.
  writeFileSync(join(root, "src.ts"), "export const answer = 42\n", "utf8")
  return root
}

function stateDirOf(root: string): string {
  return join(root, ".opencode", "elicify-vertex")
}

function receiptsPathOf(root: string): string {
  return join(stateDirOf(root), "receipts.json")
}

/** A brand-new store instance over the same workspace IS a process restart
 * from the store's point of view: its in-memory Map starts empty and the only
 * thing left is whatever reached disk. */
function restart(events: Array<[string, Record<string, unknown>]> = []): VerificationReceiptStore {
  return new VerificationReceiptStore({ logger: (event, payload) => events.push([event, payload]) })
}

function recordOn(store: VerificationReceiptStore, root: string, overrides: Partial<{
  sessionID: string
  command: string
  scope: { storyId?: string | null; paths?: readonly string[] }
}> = {}): VerificationReceipt {
  return store.record({
    sessionID: overrides.sessionID ?? "s1",
    workspaceRoot: root,
    command: overrides.command ?? "npx vitest run",
    exitCode: 0,
    outcome: "verified",
    outputSummary: "992 passed",
    observedAt: new Date().toISOString(),
    ...(overrides.scope ? { scope: overrides.scope } : {}),
  })
}

/** Writes a plan.json shaped like the one `StoryEngine` persists. */
function writePlan(root: string, sessionID: string, activeStoryId: string, scopeGlobs: string[]): void {
  mkdirSync(stateDirOf(root), { recursive: true })
  writeFileSync(
    join(stateDirOf(root), "plan.json"),
    JSON.stringify({
      [sessionID]: {
        schemaVersion: 2,
        createdAt: new Date().toISOString(),
        finalStoryId: activeStoryId,
        stories: [{ id: activeStoryId, text: "story", status: "active", scopeGlobs, acceptanceItems: [] }],
      },
    }),
    "utf8",
  )
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("VerificationReceiptStore persistence", () => {
  // MUTATION PROOF: delete the `this.persist(input.sessionID)` call at the end
  // of `record()` in src/goals.ts -> nothing reaches disk -> the reloaded
  // store returns null -> RED.
  it("round-trips a receipt across a simulated process restart", () => {
    const root = temporaryRoot()
    const minted = recordOn(restart(), root)

    expect(existsSync(receiptsPathOf(root))).toBe(true)

    const reloaded = restart()
    reloaded.load("s1", root)
    const found = reloaded.get("s1", minted.id)

    expect(found).not.toBeNull()
    expect(found?.id).toBe(minted.id)
    expect(found?.command).toBe("npx vitest run")
    expect(found?.scope?.worktreeDigest).toBe(minted.scope?.worktreeDigest)
  })

  // MUTATION PROOF: in `persist()`, replace the read-modify-write
  // `file.sessions[sessionID] = ...` with a whole-file replacement
  // (`file.sessions = { [sessionID]: ... }`) -> the second session's write
  // erases the first -> RED. Guards the same "never destroy another session's
  // data" property pin.ts and story.ts hold.
  it("writes a versioned file keyed by session, preserving other sessions", () => {
    const root = temporaryRoot()
    recordOn(restart(), root, { sessionID: "sA" })
    recordOn(restart(), root, { sessionID: "sB" })

    const file = JSON.parse(readFileSync(receiptsPathOf(root), "utf8"))
    expect(file.schemaVersion).toBe(RECEIPTS_SCHEMA_VERSION)
    expect(Object.keys(file.sessions).sort()).toEqual(["sA", "sB"])
    expect(file.sessions.sA.receipts).toHaveLength(1)
  })

  // MUTATION PROOF: revert `invalidate()` to memory-only (drop its
  // `this.persist(sessionID)` call) -> the entry survives on disk -> the
  // reloaded store serves it -> RED.
  it("invalidate() retires receipts on disk too, so a restart cannot resurrect them", () => {
    const root = temporaryRoot()
    const store = restart()
    const minted = recordOn(store, root)

    store.invalidate("s1")
    expect(existsSync(receiptsPathOf(root))).toBe(false)

    const reloaded = restart()
    reloaded.load("s1", root)
    expect(reloaded.get("s1", minted.id)).toBeNull()
  })
})

describe("VerificationReceiptStore staleness", () => {
  // MUTATION PROOF: make `isStale()` return `false` unconditionally (or delete
  // its `current.digest !== scope.worktreeDigest` comparison) -> the receipt
  // survives the edit -> RED. This is the fabrication path the rule exists to
  // close: last week's proof for today's code.
  it("refuses a reloaded receipt once a file in the worktree changed", () => {
    const root = temporaryRoot()
    const minted = recordOn(restart(), root)

    // Someone edits the code while no harness process is running.
    writeFileSync(join(root, "src.ts"), "export const answer = 43 // changed\n", "utf8")

    const reloaded = restart()
    reloaded.load("s1", root)
    expect(reloaded.get("s1", minted.id)).toBeNull()
  })

  // MUTATION PROOF: same edit as above. Documents the deliberate choice to
  // fingerprint the WHOLE worktree rather than only `scope.paths` — narrowing
  // invalidation to the declared scope would under-invalidate, because a
  // verifier run exercises far more than the story's declared globs.
  it("refuses a receipt even when the change is outside its declared scope paths", () => {
    const root = temporaryRoot()
    writePlan(root, "s1", "S1", ["src/parser/**"])
    const minted = recordOn(restart(), root)
    expect(minted.scope?.paths).toEqual(["src/parser/**"])

    writeFileSync(join(root, "unrelated.md"), "# notes\n", "utf8")

    const reloaded = restart()
    reloaded.load("s1", root)
    expect(reloaded.get("s1", minted.id)).toBeNull()
  })

  // MUTATION PROOF: delete the `if (!this.isStale(receipt)) return receipt`
  // drop-branch body in `get()` (i.e. stop calling `this.persist(sessionID)`
  // after a stale hit) -> the stale entry stays on disk -> RED.
  it("drops a stale receipt from disk on the lookup that discovers it", () => {
    const root = temporaryRoot()
    const minted = recordOn(restart(), root)
    writeFileSync(join(root, "src.ts"), "export const answer = 44\n", "utf8")

    const reloaded = restart()
    reloaded.load("s1", root)
    expect(reloaded.get("s1", minted.id)).toBeNull()
    expect(existsSync(receiptsPathOf(root))).toBe(false)
  })

  // MUTATION PROOF: relax `isPersistedScope`'s `value.complete === true` to
  // `typeof value.complete === "boolean"` -> the crafted receipt loads, and
  // `isStale` skips the digest check for an incomplete scope -> it is served
  // -> RED. Closes "hand-write a receipt whose freshness is unprovable, and
  // therefore never checked".
  it("refuses a persisted receipt whose scope is marked unprovable", () => {
    const root = temporaryRoot()
    mkdirSync(stateDirOf(root), { recursive: true })
    writeFileSync(
      receiptsPathOf(root),
      JSON.stringify({
        schemaVersion: RECEIPTS_SCHEMA_VERSION,
        sessions: {
          s1: {
            updatedAt: new Date().toISOString(),
            receipts: [
              {
                id: "vrf_forged",
                sessionID: "s1",
                workspaceRoot: root,
                command: "npx vitest run",
                exitCode: 0,
                outcome: "verified",
                outputSummary: "all green, honest",
                observedAt: new Date().toISOString(),
                scope: { storyId: "S1", paths: [], worktreeDigest: "whatever", fileCount: 1, complete: false },
              },
            ],
          },
        },
      }),
      "utf8",
    )

    const store = restart()
    store.load("s1", root)
    expect(store.get("s1", "vrf_forged")).toBeNull()
  })

  // MUTATION PROOF (compound, and deliberately so): a scope-less receipt is
  // stopped by TWO redundant layers, so removing either one alone leaves this
  // green — verified, not assumed. It goes RED when BOTH are removed:
  // `isPersistedReceipt`'s final `return isPersistedScope(value.scope)` ->
  // `return true`, AND `isStale`'s `if (!scope) return true` -> `return false`.
  it("refuses a receipt that carries no scope at all", () => {
    const root = temporaryRoot()
    mkdirSync(stateDirOf(root), { recursive: true })
    const digest = fingerprintWorktree(root).digest
    expect(digest).not.toBe("")
    writeFileSync(
      receiptsPathOf(root),
      JSON.stringify({
        schemaVersion: RECEIPTS_SCHEMA_VERSION,
        sessions: {
          s1: {
            updatedAt: new Date().toISOString(),
            receipts: [
              {
                id: "vrf_noscope",
                sessionID: "s1",
                workspaceRoot: root,
                command: "npx vitest run",
                exitCode: 0,
                outcome: "verified",
                outputSummary: "trust me",
                observedAt: new Date().toISOString(),
              },
            ],
          },
        },
      }),
      "utf8",
    )

    const store = restart()
    store.load("s1", root)
    expect(store.get("s1", "vrf_noscope")).toBeNull()
  })
})

describe("VerificationReceiptStore scope link", () => {
  // MUTATION PROOF: make `readPlanScopeLink` return `{ storyId: null, paths: [] }`
  // unconditionally -> both assertions fail -> RED.
  it("links a receipt to the active story and its declared scope when a plan exists", () => {
    const root = temporaryRoot()
    writePlan(root, "s1", "S7", ["src/**", "tests/**"])

    const minted = recordOn(restart(), root)
    expect(minted.scope?.storyId).toBe("S7")
    expect(minted.scope?.paths).toEqual(["src/**", "tests/**"])
  })

  // MUTATION PROOF: make `record()` skip persistence when
  // `link.storyId === null` (or make `readPlanScopeLink` throw uncaught) ->
  // the no-plan receipt never round-trips -> RED. This is the "must also work
  // for executions with no plan" requirement.
  it("records and persists a receipt with a null story link when there is no plan", () => {
    const root = temporaryRoot()
    const minted = recordOn(restart(), root)

    expect(minted.scope?.storyId).toBeNull()
    expect(minted.scope?.paths).toEqual([])
    expect(minted.scope?.complete).toBe(true)

    const reloaded = restart()
    reloaded.load("s1", root)
    expect(reloaded.get("s1", minted.id)?.id).toBe(minted.id)
  })

  // MUTATION PROOF: delete the `input.scope?.storyId !== undefined` branch in
  // `record()` (always take `link.storyId`) -> the explicit link is ignored
  // -> RED.
  it("honours an explicit caller-supplied story/scope link over the plan lookup", () => {
    const root = temporaryRoot()
    writePlan(root, "s1", "S7", ["src/**"])

    const minted = recordOn(restart(), root, { scope: { storyId: "S1", paths: ["src/parser/x.ts"] } })
    expect(minted.scope?.storyId).toBe("S1")
    expect(minted.scope?.paths).toEqual(["src/parser/x.ts"])
  })
})

describe("VerificationReceiptStore file handling", () => {
  // MUTATION PROOF: delete the `this.archiveReceiptsFile(...)` call in
  // `readFile`'s version-mismatch branch -> nothing lands under archive/ ->
  // RED.
  it("archives (never deletes) a receipts file written by a different schema version", () => {
    const root = temporaryRoot()
    mkdirSync(stateDirOf(root), { recursive: true })
    writeFileSync(receiptsPathOf(root), JSON.stringify({ schemaVersion: 99, sessions: { old: {} } }), "utf8")

    recordOn(restart(), root)

    const archived = readdirSync(join(stateDirOf(root), "archive")).filter((name) => name.startsWith("receipts."))
    expect(archived).toHaveLength(1)
    const preserved = JSON.parse(readFileSync(join(stateDirOf(root), "archive", archived[0]), "utf8"))
    expect(preserved.schemaVersion).toBe(99)
    expect(JSON.parse(readFileSync(receiptsPathOf(root), "utf8")).schemaVersion).toBe(RECEIPTS_SCHEMA_VERSION)
  })

  // MUTATION PROOF: make `readFile` swallow the JSON.parse error and return
  // `empty` instead of throwing `CorruptReceiptsFileError` -> the write
  // proceeds and overwrites the unreadable file -> RED. Same reasoning as
  // pin.ts's `pins:disk-corrupt` branch: other sessions' receipts may be in
  // there.
  it("aborts the write (and logs) rather than clobbering a corrupt receipts file", () => {
    const root = temporaryRoot()
    mkdirSync(stateDirOf(root), { recursive: true })
    writeFileSync(receiptsPathOf(root), "{ not json at all", "utf8")

    const events: Array<[string, Record<string, unknown>]> = []
    recordOn(restart(events), root)

    expect(readFileSync(receiptsPathOf(root), "utf8")).toBe("{ not json at all")
    expect(events.map(([event]) => event)).toContain("receipts:disk-corrupt")
  })

  // MUTATION PROOF: delete the `if (!rootIsDirectory) return { ..., complete:
  // false }` guard in `fingerprintWorktree` -> a missing worktree hashes the
  // empty set, `complete` becomes true, and the receipt is persisted as if it
  // were provable -> RED.
  it("does not persist a receipt whose worktree cannot be fingerprinted", () => {
    const root = temporaryRoot()
    const missing = join(root, "gone")
    const store = restart()
    const minted = store.record({
      sessionID: "s1",
      workspaceRoot: missing,
      command: "npx vitest run",
      exitCode: 0,
      outcome: "verified",
      outputSummary: "nothing to see",
      observedAt: new Date().toISOString(),
    })

    expect(minted.scope?.complete).toBe(false)
    expect(existsSync(join(missing, ".opencode", "elicify-vertex", "receipts.json"))).toBe(false)
  })
})

// ===========================================================================
// Receipt SIGNING — the control that makes forgery inert.
//
// An audit completed a story with ZERO verifier runs: it walked ~15 ways past
// the tool-boundary write filter (`file_path` instead of `filePath`, a path
// inside `patchText`, a symlink to the directory, string concatenation and
// base64 inside a bash command, case differences), hand-wrote a cloned receipt
// with a fresh id and a different story id into `receipts.json`, and the
// checkpoint accepted it after a restart.
//
// A filter has to be exhaustive to work. A signature does not: a receipt the
// harness never minted has no valid HMAC, so `get()` refuses it however it
// arrived. The key lives beside the event log, OUTSIDE the worktree, which is
// what lets the store itself stay in the repo and travel with the project.
// ===========================================================================

describe("receipt signatures", () => {
  // MUTATION PROOF: delete the `verifyReceiptSignature` block in `get()` ->
  // both tests go red. Delete the `signReceipt` call in `record()` -> the
  // "genuine receipt survives" half goes red (nothing signed, nothing
  // verifies), which is the discrimination.
  const SID = "s1"

  function forgeInto(root: string, mutate: (r: Record<string, unknown>) => void): string {
    const file = receiptsPathOf(root)
    const disk = JSON.parse(readFileSync(file, "utf8"))
    const cloned = { ...disk.sessions[SID].receipts[0] }
    mutate(cloned)
    disk.sessions[SID].receipts.push(cloned)
    writeFileSync(file, JSON.stringify(disk), "utf8")
    return cloned.id as string
  }

  it("refuses a forged receipt written directly into the store", () => {
    const root = temporaryRoot()
    const real = recordOn(restart(), root)

    const forgedId = forgeInto(root, (r) => {
      r.id = `vrf_${"f".repeat(32)}`
      r.scope = { ...(r.scope as object), storyId: "S2" }
      r.observedAt = new Date(Date.now() + 1000).toISOString()
    })

    const afterRestart = restart()
    afterRestart.load(SID, root)
    expect(afterRestart.get(SID, forgedId), "a hand-written receipt is not evidence").toBeNull()
    expect(afterRestart.get(SID, real.id), "a genuine receipt survives the restart").not.toBeNull()
  })

  it("refuses a receipt whose signed fields were edited after minting", () => {
    const root = temporaryRoot()
    const real = recordOn(restart(), root)
    const tamperedId = forgeInto(root, (r) => {
      r.id = `vrf_${"e".repeat(32)}`
      r.command = "echo pretend-this-was-a-test-run"
    })

    const afterRestart = restart()
    afterRestart.load(SID, root)
    expect(afterRestart.get(SID, tamperedId)).toBeNull()
    expect(afterRestart.get(SID, real.id)).not.toBeNull()
  })
})
