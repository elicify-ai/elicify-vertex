import { describe, expect, it } from "vitest"

import type { OpencodeClient } from "../../src/v2/types.js"
import { DelegationTracker, evaluateStall, hasBusyChildren } from "../../src/v2/wiring/watchdog.js"

// ===========================================================================
// wiring/watchdog.ts — HANDOVER.md "Agreed redesign direction" point 9.
//
// The property under test throughout is fail-open: every malformed input,
// missing host method, or unexpected response shape must degrade to the
// pre-watchdog behavior (gate fires as before), never throw and never wedge
// the gate behind a stuck "blocked" answer. Half the cases below exist to
// pin that, not the happy path.
// ===========================================================================

describe("DelegationTracker", () => {
  it("reports in-flight between noteTaskCall and noteTaskDone, false after done", () => {
    const t = new DelegationTracker()
    expect(t.hasInFlightDelegation("s1")).toBe(false)

    t.noteTaskCall("s1", "call-1")
    expect(t.hasInFlightDelegation("s1")).toBe(true)

    t.noteTaskDone("s1", "call-1")
    expect(t.hasInFlightDelegation("s1")).toBe(false)
  })

  it("stays in-flight until ALL overlapping calls return", () => {
    const t = new DelegationTracker()
    t.noteTaskCall("s1", "call-1")
    t.noteTaskCall("s1", "call-2")

    t.noteTaskDone("s1", "call-1")
    expect(t.hasInFlightDelegation("s1")).toBe(true)

    t.noteTaskDone("s1", "call-2")
    expect(t.hasInFlightDelegation("s1")).toBe(false)
  })

  it("keys by session when callID is undefined, with a per-session refcount", () => {
    const t = new DelegationTracker()
    t.noteTaskCall("s1", undefined)
    t.noteTaskCall("s1", undefined)
    expect(t.hasInFlightDelegation("s1")).toBe(true)

    t.noteTaskDone("s1", undefined)
    expect(t.hasInFlightDelegation("s1")).toBe(true) // one still open

    t.noteTaskDone("s1", undefined)
    expect(t.hasInFlightDelegation("s1")).toBe(false)
  })

  it("treats done-without-call as a safe no-op (fail-open, never negative, never throws)", () => {
    const t = new DelegationTracker()
    expect(() => t.noteTaskDone("s1", "call-never-seen")).not.toThrow()
    expect(() => t.noteTaskDone("s1", undefined)).not.toThrow()
    expect(t.hasInFlightDelegation("s1")).toBe(false)

    // An unmatched done must not cancel a REAL in-flight call.
    t.noteTaskCall("s1", "call-1")
    t.noteTaskDone("s1", "call-other")
    expect(t.hasInFlightDelegation("s1")).toBe(true)

    // And an extra undefined-keyed done must not underflow the refcount.
    t.noteTaskDone("s1", undefined)
    expect(t.hasInFlightDelegation("s1")).toBe(true)
  })

  it("isolates sessions from each other", () => {
    const t = new DelegationTracker()
    t.noteTaskCall("s1", "call-1")
    expect(t.hasInFlightDelegation("s2")).toBe(false)

    t.noteTaskDone("s2", "call-1") // call-1 belongs to s1; done reported against s2 still clears by callID
    expect(t.hasInFlightDelegation("s1")).toBe(false)
  })

  it("clearSession removes every in-flight entry for that session (stale-entry repair)", () => {
    // Pins the defect fix: a `task` whose tool.execute.after the host dropped
    // leaves a stale entry; clearSession (called on a real user message) wipes
    // both the callID-keyed and the session-refcount entries for that session.
    const t = new DelegationTracker()
    t.noteTaskCall("s1", "call-1")
    t.noteTaskCall("s1", undefined) // session-refcount path
    t.noteTaskCall("s2", "call-2")
    expect(t.hasInFlightDelegation("s1")).toBe(true)
    expect(t.hasInFlightDelegation("s2")).toBe(true)

    t.clearSession("s1")
    expect(t.hasInFlightDelegation("s1")).toBe(false)
    // s2's entry is untouched.
    expect(t.hasInFlightDelegation("s2")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// hasBusyChildren — the client stub is deliberately shaped per-case because
// the whole point is that the SDK type does NOT guarantee this surface; the
// function must survive whatever it is handed.
// ---------------------------------------------------------------------------

function clientWith(session: unknown): OpencodeClient {
  return { session } as unknown as OpencodeClient
}

describe("hasBusyChildren", () => {
  it("returns true when a child session's status entry is {type:'busy'}", async () => {
    const client = clientWith({
      children: async () => ({ data: [{ id: "child-1" }, { id: "child-2" }] }),
      status: async () => ({ data: { "child-1": { type: "idle" }, "child-2": { type: "busy" } } }),
    })
    await expect(hasBusyChildren(client, "parent")).resolves.toBe(true)
  })

  it("accepts the bare-string 'busy' status shape", async () => {
    const client = clientWith({
      children: async () => ({ data: [{ id: "child-1" }] }),
      status: async () => ({ data: { "child-1": "busy" } }),
    })
    await expect(hasBusyChildren(client, "parent")).resolves.toBe(true)
  })

  it("accepts bare-array children and a bare status map (no {data} wrapper)", async () => {
    const client = clientWith({
      children: async () => [{ id: "child-1" }],
      status: async () => ({ "child-1": { type: "busy" } }),
    })
    await expect(hasBusyChildren(client, "parent")).resolves.toBe(true)
  })

  it("returns false when every child is idle", async () => {
    const client = clientWith({
      children: async () => ({ data: [{ id: "child-1" }, { id: "child-2" }] }),
      status: async () => ({ data: { "child-1": { type: "idle" }, "child-2": { type: "idle" } } }),
    })
    await expect(hasBusyChildren(client, "parent")).resolves.toBe(false)
  })

  it("returns false when the session has no children (and never calls status)", async () => {
    let statusCalled = false
    const client = clientWith({
      children: async () => ({ data: [] }),
      status: async () => {
        statusCalled = true
        return { data: {} }
      },
    })
    await expect(hasBusyChildren(client, "parent")).resolves.toBe(false)
    expect(statusCalled).toBe(false)
  })

  it("returns false when client.session lacks children/status methods", async () => {
    await expect(hasBusyChildren(clientWith({}), "parent")).resolves.toBe(false)
    await expect(hasBusyChildren(clientWith({ children: async () => [{ id: "c" }] }), "parent")).resolves.toBe(false)
    await expect(hasBusyChildren({} as OpencodeClient, "parent")).resolves.toBe(false)
  })

  it("returns false when children() throws", async () => {
    const client = clientWith({
      children: async () => {
        throw new Error("host exploded")
      },
      status: async () => ({ data: {} }),
    })
    await expect(hasBusyChildren(client, "parent")).resolves.toBe(false)
  })

  it("returns false when status() throws", async () => {
    const client = clientWith({
      children: async () => ({ data: [{ id: "child-1" }] }),
      status: async () => {
        throw new Error("host exploded")
      },
    })
    await expect(hasBusyChildren(client, "parent")).resolves.toBe(false)
  })

  it("returns false on malformed payloads instead of throwing", async () => {
    const weird = clientWith({
      children: async () => ({ data: "not-an-array" }),
      status: async () => null,
    })
    await expect(hasBusyChildren(weird, "parent")).resolves.toBe(false)

    // Children with unusable id fields are skipped; a valid busy one still counts.
    const mixed = clientWith({
      children: async () => ({ data: [{ noId: true }, 42, { id: "child-1" }] }),
      status: async () => ({ data: { "child-1": { type: "busy" } } }),
    })
    await expect(hasBusyChildren(mixed, "parent")).resolves.toBe(true)
  })

  it("returns false when a child's status entry is an unexpected shape", async () => {
    const client = clientWith({
      children: async () => ({ data: [{ id: "child-1" }] }),
      status: async () => ({ data: { "child-1": 42 } }),
    })
    await expect(hasBusyChildren(client, "parent")).resolves.toBe(false)
  })
})

// ---------------------------------------------------------------------------
// evaluateStall — pure; the arithmetic is the reference's
// increment/reset/cap with marker equality as the progress test.
// ---------------------------------------------------------------------------

describe("evaluateStall", () => {
  const base = { activityMarker: 5, markerAtLastContinuation: 5, consecutiveNoProgress: 0, maxNoProgressTurns: 3 }

  it("counts no-progress when the marker is unchanged since the last continuation", () => {
    expect(evaluateStall(base)).toEqual({ noProgress: true, nextConsecutiveNoProgress: 1, stalled: false })
  })

  it("increments an existing streak", () => {
    const verdict = evaluateStall({ ...base, consecutiveNoProgress: 1 })
    expect(verdict).toEqual({ noProgress: true, nextConsecutiveNoProgress: 2, stalled: false })
  })

  it("resets the streak to 0 when the marker moved", () => {
    const verdict = evaluateStall({ ...base, activityMarker: 9, consecutiveNoProgress: 2 })
    expect(verdict).toEqual({ noProgress: false, nextConsecutiveNoProgress: 0, stalled: false })
  })

  it("reports stalled exactly when the incremented count reaches the cap (cap 3: third turn)", () => {
    expect(evaluateStall({ ...base, consecutiveNoProgress: 0 }).stalled).toBe(false) // 1st
    expect(evaluateStall({ ...base, consecutiveNoProgress: 1 }).stalled).toBe(false) // 2nd
    expect(evaluateStall({ ...base, consecutiveNoProgress: 2 }).stalled).toBe(true) // 3rd — boundary
    expect(evaluateStall({ ...base, consecutiveNoProgress: 3 }).stalled).toBe(true) // past cap stays stalled
  })

  it("never stalls when maxNoProgressTurns is 0 (cap disabled), but still tracks the count", () => {
    const verdict = evaluateStall({ ...base, maxNoProgressTurns: 0, consecutiveNoProgress: 99 })
    expect(verdict).toEqual({ noProgress: true, nextConsecutiveNoProgress: 100, stalled: false })
  })

  it("never stalls on a negative cap either", () => {
    const verdict = evaluateStall({ ...base, maxNoProgressTurns: -1, consecutiveNoProgress: 5 })
    expect(verdict.stalled).toBe(false)
  })

  it("does not stall when progress resets the streak, even if the stored count was at the cap", () => {
    const verdict = evaluateStall({ ...base, activityMarker: 6, consecutiveNoProgress: 2 })
    expect(verdict).toEqual({ noProgress: false, nextConsecutiveNoProgress: 0, stalled: false })
  })
})
