import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { PinStore, acquireStateLock, fsIO, type PinsFile } from "../../src/v2/pin.js"

// Fault injection approach: `src/v2/pin.ts` routes every disk call through a
// small internal `fsIO` object (a plain, mutable wrapper around node:fs)
// instead of calling `node:fs`'s namespace-imported functions directly.
// `import * as fsNode from "node:fs"` produces a synthetic ESM namespace
// object whose properties come back non-configurable under this project's
// vitest/Node combination, so `vi.spyOn(fsNode, "writeFileSync")` throws
// ("Cannot redefine property"). Spying on `fsIO` (a plain object literal)
// works reliably instead. Wave-3/4 agents needing fs fault injection in their
// own v2 modules should use the same seam pattern (export a small mutable
// `{...}` wrapper around the fs calls you use, spy on that).

const roots: string[] = []

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "vertex-pin-"))
  roots.push(root)
  return root
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fsError(code: string): NodeJS.ErrnoException {
  const err = new Error(code) as NodeJS.ErrnoException
  err.code = code
  return err
}

function readPinsFile(stateDir: string): PinsFile {
  return JSON.parse(readFileSync(join(stateDir, "pins.json"), "utf8")) as PinsFile
}

describe("PinStore — happy path persistence (Dataset: Pins persistence #1)", () => {
  it("writes pins.json under the session key with mode 0600", () => {
    const stateDir = temporaryRoot()
    const logger = vi.fn()
    const store = new PinStore({ stateDir, logger })

    const criteria = store.pin("s1", ["parser handles nesting", "errors point at inner token"])

    expect(criteria).toEqual([
      { id: "C1", text: "parser handles nesting", evidence: null },
      { id: "C2", text: "errors point at inner token", evidence: null },
    ])
    const pinsPath = join(stateDir, "pins.json")
    expect(existsSync(pinsPath)).toBe(true)
    expect(statSync(pinsPath).mode & 0o777).toBe(0o600)
    const onDisk = readPinsFile(stateDir)
    expect(onDisk.s1.criteria).toHaveLength(2)
    expect(onDisk.s1.updatedAt).toBeTruthy()

    // Survives a simulated restart (fresh PinStore instance, same stateDir).
    const restarted = new PinStore({ stateDir, logger: vi.fn() })
    restarted.load("s1")
    expect(restarted.get("s1")).toEqual(criteria)

    // No fault-state noise logged on the clean happy path.
    expect(logger).not.toHaveBeenCalledWith("pins:disk-fallback-memory", expect.anything())
    expect(logger).not.toHaveBeenCalledWith("pins:disk-unavailable", expect.anything())
  })

  it("caps criteria at 10 per session, drops extras, and logs criteria:truncated", () => {
    const stateDir = temporaryRoot()
    const logger = vi.fn()
    const store = new PinStore({ stateDir, logger })
    const texts = Array.from({ length: 13 }, (_, i) => `criterion ${i + 1}`)

    const criteria = store.pin("s1", texts)

    expect(criteria).toHaveLength(10)
    expect(criteria.map((c) => c.id)).toEqual(["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8", "C9", "C10"])
    expect(logger).toHaveBeenCalledWith("criteria:truncated", { sessionID: "s1", requested: 13, kept: 10 })
  })

  it("redacts criteria text before storage", () => {
    const stateDir = temporaryRoot()
    const store = new PinStore({ stateDir, logger: vi.fn() })

    const criteria = store.pin("s1", ["token=abcdefghijklmnopqrstuvwxyz stays out of the criterion"])

    expect(criteria[0].text).not.toContain("abcdefghijklmnopqrstuvwxyz")
    expect(criteria[0].text).toContain("[REDACTED]")
    const onDisk = readFileSync(join(stateDir, "pins.json"), "utf8")
    expect(onDisk).not.toContain("abcdefghijklmnopqrstuvwxyz")
  })

  it("logs criteria:re-pinned when a later CRITERIA block replaces a non-empty prior set", () => {
    const stateDir = temporaryRoot()
    const logger = vi.fn()
    const store = new PinStore({ stateDir, logger })

    store.pin("s1", ["first criterion"])
    expect(logger).not.toHaveBeenCalledWith("criteria:re-pinned", expect.anything())

    const replaced = store.pin("s1", ["second criterion", "third criterion"])
    expect(logger).toHaveBeenCalledWith("criteria:re-pinned", { sessionID: "s1", previousCount: 1, newCount: 2 })
    // Full replace: ids restart at C1, old criterion is gone.
    expect(replaced.map((c) => c.text)).toEqual(["second criterion", "third criterion"])
    expect(store.get("s1")).toHaveLength(2)
  })

  it("attachEvidence updates the matching criterion AND persists automatically (matches pin()'s contract)", () => {
    const stateDir = temporaryRoot()
    const store = new PinStore({ stateDir, logger: vi.fn() })
    store.pin("s1", ["criterion one"])

    store.attachEvidence("s1", "C1", { receiptId: "vrf_abc" })
    expect(store.get("s1")[0].evidence).toEqual({ receiptId: "vrf_abc" })

    // No explicit follow-up persist() call — the change must already be on
    // disk. Verify via a fresh instance hydrating from disk.
    const onDisk = readPinsFile(stateDir)
    expect(onDisk.s1.criteria[0].evidence).toEqual({ receiptId: "vrf_abc" })
    const restarted = new PinStore({ stateDir, logger: vi.fn() })
    restarted.load("s1")
    expect(restarted.get("s1")[0].evidence).toEqual({ receiptId: "vrf_abc" })

    // Unknown session / criterion id are no-ops, never throw.
    expect(() => store.attachEvidence("unknown-session", "C1", { receiptId: "x" })).not.toThrow()
    expect(() => store.attachEvidence("s1", "C99", { receiptId: "x" })).not.toThrow()
  })

  it("two sessions writing concurrently both keep their keys (Dataset row 5)", () => {
    const stateDir = temporaryRoot()
    const store = new PinStore({ stateDir, logger: vi.fn() })

    store.pin("session-a", ["a criterion"])
    store.pin("session-b", ["b criterion"])

    const onDisk = readPinsFile(stateDir)
    expect(Object.keys(onDisk).sort()).toEqual(["session-a", "session-b"])
  })
})

describe("PinStore — gc() lifecycle (Dataset: Pins persistence #6, #7)", () => {
  it("drops an entry whose updatedAt is 8 days old and keeps a fresh, known entry", () => {
    const stateDir = temporaryRoot()
    const store = new PinStore({ stateDir, logger: vi.fn() })
    store.pin("fresh-known", ["still relevant"])

    // Seed an 8-day-old entry directly on disk (simulating a prior run).
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
    const onDisk = readPinsFile(stateDir)
    onDisk["old-known"] = { criteria: [{ id: "C1", text: "stale", evidence: null }], updatedAt: eightDaysAgo }
    writeFileSync(join(stateDir, "pins.json"), JSON.stringify(onDisk, null, 2), "utf8")

    store.gc(new Set(["fresh-known", "old-known"]))

    const after = readPinsFile(stateDir)
    expect(after["old-known"]).toBeUndefined()
    expect(after["fresh-known"]).toBeDefined()
  })

  it("drops a fresh entry whose session is unknown to this process", () => {
    const stateDir = temporaryRoot()
    const store = new PinStore({ stateDir, logger: vi.fn() })
    store.pin("known-session", ["kept"])
    store.pin("orphan-session", ["dropped, session unknown"])

    store.gc(new Set(["known-session"])) // orphan-session is absent from the known set

    const after = readPinsFile(stateDir)
    expect(after["orphan-session"]).toBeUndefined()
    expect(after["known-session"]).toBeDefined()
    expect(store.get("orphan-session")).toEqual([])
  })

  it("deletes pins.json entirely when the last remaining entry expires", () => {
    const stateDir = temporaryRoot()
    const store = new PinStore({ stateDir, logger: vi.fn() })
    store.pin("only-session", ["will expire"])
    const pinsPath = join(stateDir, "pins.json")
    expect(existsSync(pinsPath)).toBe(true)

    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
    const onDisk = readPinsFile(stateDir)
    onDisk["only-session"].updatedAt = eightDaysAgo
    writeFileSync(pinsPath, JSON.stringify(onDisk, null, 2), "utf8")

    store.gc(new Set(["only-session"]))

    expect(existsSync(pinsPath)).toBe(false)
    // No orphan temp files left behind either.
    expect(readdirSync(stateDir).filter((name) => name.endsWith(".tmp"))).toEqual([])
  })
})

describe("acquireStateLock (test 37 — pins/lock portion of story_lock_file_stale_recovery)", () => {
  it("a second writer sees the lock held by a live process and throws", () => {
    const stateDir = temporaryRoot()
    const first = acquireStateLock(stateDir)
    try {
      expect(() => acquireStateLock(stateDir)).toThrow(/locked by another process/i)
    } finally {
      first.release()
    }
  })

  it("reclaims a lock file older than 30s left by a dead process (Dataset row 8)", () => {
    const stateDir = temporaryRoot()
    const lockPath = join(stateDir, "state.lock")
    writeFileSync(lockPath, "dead-process", "utf8")
    const old = new Date(Date.now() - 31_000)
    utimesSync(lockPath, old, old)

    const lock = acquireStateLock(stateDir)
    expect(existsSync(lockPath)).toBe(true) // reclaimed = a new lock file owned by us, not "no lock"
    lock.release()
    expect(existsSync(lockPath)).toBe(false)
  })

  it("does not reclaim a lock file younger than 30s", () => {
    const stateDir = temporaryRoot()
    const lockPath = join(stateDir, "state.lock")
    writeFileSync(lockPath, "recent", "utf8")
    const recent = new Date(Date.now() - 5_000)
    utimesSync(lockPath, recent, recent)

    expect(() => acquireStateLock(stateDir)).toThrow(/locked by another process/i)
  })

  it("leaves no partial pins.json and no leftover temp file after a failed write", () => {
    const stateDir = temporaryRoot()
    const store = new PinStore({ stateDir, logger: vi.fn() })
    store.pin("s1", ["first write, succeeds"])
    const pinsPath = join(stateDir, "pins.json")
    const before = readFileSync(pinsPath, "utf8")

    const writeSpy = vi.spyOn(fsIO, "writeFileSync").mockImplementation(() => {
      throw fsError("EACCES")
    })
    store.pin("s1", ["second write, fails"])
    writeSpy.mockRestore()

    // pins.json is untouched (still the pre-failure content) — no partial write.
    expect(readFileSync(pinsPath, "utf8")).toBe(before)
    // No leftover .tmp files in the state directory.
    expect(readdirSync(stateDir).filter((name) => name.endsWith(".tmp"))).toEqual([])
  })
})

describe("pins_write_fault_and_retry (test 40)", () => {
  it("EACCES on first write falls back to memory and logs pins:disk-fallback-memory; criteria still served", () => {
    const stateDir = temporaryRoot()
    const logger = vi.fn()
    const store = new PinStore({ stateDir, logger })

    const writeSpy = vi.spyOn(fsIO, "writeFileSync").mockImplementation(() => {
      throw fsError("EACCES")
    })
    const criteria = store.pin("s1", ["criterion under fault"])
    writeSpy.mockRestore()

    expect(logger).toHaveBeenCalledWith("pins:disk-fallback-memory", { sessionID: "s1", reason: "EACCES" })
    expect(logger).not.toHaveBeenCalledWith("pins:disk-recovered", expect.anything())
    // Criteria remain served from memory despite the disk fault.
    expect(store.get("s1")).toEqual(criteria)
    expect(existsSync(join(stateDir, "pins.json"))).toBe(false)
  })

  it("ENOSPC then a successful retry logs pins:disk-recovered and writes to disk", () => {
    const stateDir = temporaryRoot()
    const logger = vi.fn()
    const store = new PinStore({ stateDir, logger })

    const writeSpy = vi.spyOn(fsIO, "writeFileSync").mockImplementationOnce(() => {
      throw fsError("ENOSPC")
    })
    store.pin("s1", ["first attempt fails"])
    expect(logger).toHaveBeenCalledWith("pins:disk-fallback-memory", { sessionID: "s1", reason: "ENOSPC" })
    writeSpy.mockRestore() // subsequent writeFileSync calls succeed again

    // "the next criteria update" retries the disk write (FR-013).
    store.pin("s1", ["second attempt succeeds"])

    expect(logger).toHaveBeenCalledWith("pins:disk-recovered", { sessionID: "s1" })
    expect(existsSync(join(stateDir, "pins.json"))).toBe(true)
    const onDisk = readPinsFile(stateDir)
    expect(onDisk.s1.criteria[0].text).toBe("second attempt succeeds")
  })

  it("3 consecutive ENOSPC failures log pins:disk-unavailable once and stop retrying for the session", () => {
    const stateDir = temporaryRoot()
    const logger = vi.fn()
    const store = new PinStore({ stateDir, logger })

    const writeSpy = vi.spyOn(fsIO, "writeFileSync").mockImplementation(() => {
      throw fsError("ENOSPC")
    })

    store.pin("s1", ["failure 1"])
    store.pin("s1", ["failure 2"])
    store.pin("s1", ["failure 3"])

    const unavailableCalls = logger.mock.calls.filter(([event]) => event === "pins:disk-unavailable")
    expect(unavailableCalls).toHaveLength(1)
    expect(unavailableCalls[0][1]).toEqual({ sessionID: "s1", reason: "ENOSPC" })
    const fallbackCalls = logger.mock.calls.filter(([event]) => event === "pins:disk-fallback-memory")
    expect(fallbackCalls).toHaveLength(1) // logged on the FIRST failure only

    const callsBeforeRetry = writeSpy.mock.calls.length
    writeSpy.mockRestore() // even if disk were healthy again, no further retries should occur

    const healthySpy = vi.spyOn(fsIO, "writeFileSync")
    store.pin("s1", ["should not attempt a write at all"])
    expect(healthySpy).not.toHaveBeenCalled()
    expect(callsBeforeRetry).toBeGreaterThan(0)

    // Criteria are still served from memory even though disk is permanently unavailable.
    expect(store.get("s1")[0].text).toBe("should not attempt a write at all")
    expect(existsSync(join(stateDir, "pins.json"))).toBe(false)

    const secondUnavailableCalls = logger.mock.calls.filter(([event]) => event === "pins:disk-unavailable")
    expect(secondUnavailableCalls).toHaveLength(1) // still exactly one, ever
  })

  it("a lock acquisition failure (contention) is also routed through the fault state machine", () => {
    const stateDir = temporaryRoot()
    const logger = vi.fn()
    const store = new PinStore({ stateDir, logger })
    const holder = acquireStateLock(stateDir)
    try {
      store.pin("s1", ["blocked by a live lock"])
      expect(logger).toHaveBeenCalledWith("pins:disk-fallback-memory", { sessionID: "s1", reason: "unknown" })
      expect(store.get("s1")[0].text).toBe("blocked by a live lock")
    } finally {
      holder.release()
    }
  })
})

describe("pins_disk_corrupt_on_write (CRITICAL fix: a corrupt pins.json must not silently destroy other sessions' data)", () => {
  it("(a) a genuinely corrupt (unparseable) pins.json aborts the write, logs pins:disk-corrupt, and leaves the file untouched", () => {
    const stateDir = temporaryRoot()
    const pinsPath = join(stateDir, "pins.json")
    const corruptBytes = '{ "session-other": { "criteria": [ not valid json at all'
    writeFileSync(pinsPath, corruptBytes, "utf8")
    const logger = vi.fn()
    const store = new PinStore({ stateDir, logger })

    // pin() -> persist() -> writeToDisk(): must NOT silently proceed from an
    // empty base and overwrite session-other's (unreadable) data with only
    // this session's own entry.
    store.pin("s1", ["criterion under corruption"])

    expect(readFileSync(pinsPath, "utf8")).toBe(corruptBytes) // byte-for-byte untouched
    expect(logger).toHaveBeenCalledWith(
      "pins:disk-corrupt",
      expect.objectContaining({ sessionID: "s1", path: pinsPath }),
    )
    // Routed through the existing fault-tolerance machinery: the write
    // failed loudly (threw) inside writeToDisk, persist() caught it and
    // fell back to memory rather than crashing pin()'s caller.
    expect(logger).toHaveBeenCalledWith("pins:disk-fallback-memory", expect.objectContaining({ sessionID: "s1" }))
    // Criteria for the current session are still served from memory.
    expect(store.get("s1")[0].text).toBe("criterion under corruption")
  })

  it("(b) a schema-invalid-but-parseable pins.json still degrades gracefully (no regression): write proceeds from an empty base, no pins:disk-corrupt", () => {
    const stateDir = temporaryRoot()
    const pinsPath = join(stateDir, "pins.json")
    // Valid JSON, but the shape fails isPinsFile (criteria is not an array).
    writeFileSync(
      pinsPath,
      JSON.stringify({ "session-other": { criteria: "not-an-array", updatedAt: "2020-01-01T00:00:00.000Z" } }),
      "utf8",
    )
    const logger = vi.fn()
    const store = new PinStore({ stateDir, logger })

    store.pin("s1", ["criterion after schema-invalid file"])

    expect(logger).not.toHaveBeenCalledWith("pins:disk-corrupt", expect.anything())
    expect(logger).not.toHaveBeenCalledWith("pins:disk-fallback-memory", expect.anything())
    const onDisk = readPinsFile(stateDir)
    expect(onDisk.s1.criteria[0].text).toBe("criterion after schema-invalid file")
    // The pre-existing schema-invalid blob is dropped (whole-file validation,
    // unchanged behavior) rather than blocking this session's write.
    expect((onDisk as Record<string, unknown>)["session-other"]).toBeUndefined()
  })
})
