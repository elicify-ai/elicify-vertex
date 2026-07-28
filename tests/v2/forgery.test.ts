/**
 * ADVERSARIAL suite: every persisted evidence artifact must be unforgeable.
 *
 * Two audits completed stories with ZERO verifier runs, by two different
 * routes, and neither was caught by any existing test:
 *
 *   1. Clone a valid RECEIPT with a fresh id and a different story id into
 *      `receipts.json`. The story link and the worktree digest both held --
 *      neither binds a receipt to the harness having OBSERVED a command.
 *   2. Write `{"waiver":true,"sourceMessageId":"msg_i_made_this_up"}` over
 *      every criterion in `pins.json`. The gate trusted waivers forever, so it
 *      simply went silent (measured: continuations 1 -> 0). Cheaper than (1):
 *      no receipt to clone, no digest to satisfy.
 *
 * The pattern that let both through is the same: unit tests only ever fed the
 * stores their OWN output. Nothing wrote to the files the way an adversary --
 * or a confused model with a `write` tool -- would.
 *
 * So this file always attacks THROUGH THE FILESYSTEM, never through the API,
 * and it is organised by artifact rather than by bug. Adding a new persisted
 * evidence type without signing it should fail here.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { VerificationReceiptStore, signWaiver, verifyWaiverSignature } from "../../src/goals.js"
import { PinStore } from "../../src/v2/pin.js"

const SESSION = "adversary"
const roots: string[] = []

function worktree(): string {
  const root = mkdtempSync(join(tmpdir(), "vertex-forgery-"))
  roots.push(root)
  writeFileSync(join(root, "src.ts"), "export const answer = 42\n", "utf8")
  return root
}

const stateDirOf = (root: string): string => join(root, ".opencode", "elicify-vertex")

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// RECEIPTS
// ---------------------------------------------------------------------------

describe("receipts cannot be forged on disk", () => {
  function mint(store: VerificationReceiptStore, root: string) {
    return store.record({
      sessionID: SESSION,
      workspaceRoot: root,
      command: "go test ./...",
      exitCode: 0,
      outcome: "verified",
      outputSummary: "ok",
      observedAt: new Date().toISOString(),
    })
  }

  function tamper(root: string, mutate: (receipt: Record<string, unknown>) => void): string {
    const file = join(stateDirOf(root), "receipts.json")
    const disk = JSON.parse(readFileSync(file, "utf8"))
    const cloned = { ...disk.sessions[SESSION].receipts[0] }
    mutate(cloned)
    disk.sessions[SESSION].receipts.push(cloned)
    writeFileSync(file, JSON.stringify(disk), "utf8")
    return cloned.id as string
  }

  // Each row is a field an attacker would need to change to make a receipt say
  // something it did not. All must be inside the signature.
  const attacks: Array<[string, (r: Record<string, unknown>) => void]> = [
    ["a fresh id", (r) => { r.id = `vrf_${"f".repeat(32)}` }],
    ["a different story", (r) => { r.id = `vrf_${"e".repeat(32)}`; r.scope = { ...(r.scope as object), storyId: "S999" } }],
    ["a command that never ran", (r) => { r.id = `vrf_${"d".repeat(32)}`; r.command = "echo pretend" }],
    ["a different session", (r) => { r.id = `vrf_${"c".repeat(32)}`; r.sessionID = "someone-else" }],
    ["a future timestamp", (r) => { r.id = `vrf_${"b".repeat(32)}`; r.observedAt = new Date(Date.now() + 9e6).toISOString() }],
    ["a forged worktree digest", (r) => { r.id = `vrf_${"a".repeat(32)}`; r.scope = { ...(r.scope as object), worktreeDigest: "0".repeat(64) } }],
  ]

  it.each(attacks)("refuses a receipt with %s", (_label, mutate) => {
    const root = worktree()
    const real = mint(new VerificationReceiptStore(), root)
    const forgedId = tamper(root, mutate)

    const restarted = new VerificationReceiptStore()
    restarted.load(SESSION, root)
    expect(restarted.get(SESSION, forgedId), "forged receipt must not be evidence").toBeNull()
    // Discrimination: the genuine receipt from the same file still works, so
    // these are not passing because loading is broken.
    expect(restarted.get(SESSION, real.id), "genuine receipt must survive").not.toBeNull()
  })

  it("refuses a receipt invented from nothing", () => {
    const root = worktree()
    mint(new VerificationReceiptStore(), root)
    const file = join(stateDirOf(root), "receipts.json")
    const disk = JSON.parse(readFileSync(file, "utf8"))
    disk.sessions[SESSION].receipts.push({
      id: "vrf_invented",
      sessionID: SESSION,
      workspaceRoot: root,
      command: "go test ./...",
      exitCode: 0,
      outcome: "verified",
      outputSummary: "ok",
      observedAt: new Date().toISOString(),
      scope: { storyId: null, paths: [], worktreeDigest: "x", fileCount: 1, complete: true },
      signature: "0".repeat(64),
    })
    writeFileSync(file, JSON.stringify(disk), "utf8")

    const restarted = new VerificationReceiptStore()
    restarted.load(SESSION, root)
    expect(restarted.get(SESSION, "vrf_invented")).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// WAIVERS
// ---------------------------------------------------------------------------

describe("waivers cannot be forged on disk", () => {
  function pinned(root: string) {
    const store = new PinStore({ stateDir: stateDirOf(root), logger: () => {} })
    store.pin(SESSION, ["auth service tests pass", "migration applies cleanly"])
    return store
  }

  it("refuses a hand-written waiver", () => {
    const root = worktree()
    const store = pinned(root)
    const file = join(stateDirOf(root), "pins.json")
    const disk = JSON.parse(readFileSync(file, "utf8"))
    for (const criterion of disk[SESSION].criteria) {
      criterion.evidence = { waiver: true, sourceMessageId: "msg_i_made_this_up" }
    }
    writeFileSync(file, JSON.stringify(disk), "utf8")

    const restarted = new PinStore({ stateDir: stateDirOf(root), logger: () => {} })
    restarted.load(SESSION)
    for (const criterion of restarted.get(SESSION)) {
      const evidence = criterion.evidence as Record<string, unknown> | null
      expect(
        verifyWaiverSignature(
          { sessionID: SESSION, criterionId: criterion.id, sourceMessageId: String(evidence?.sourceMessageId) },
          evidence?.signature,
        ),
        "a hand-written waiver must not verify",
      ).toBe(false)
    }
    void store
  })

  it("accepts a waiver the harness itself signed (discrimination)", () => {
    const root = worktree()
    const store = pinned(root)
    const criterion = store.get(SESSION)[0]
    const signature = signWaiver({ sessionID: SESSION, criterionId: criterion.id, sourceMessageId: "msg_real" })
    expect(signature).toBeTruthy()
    expect(
      verifyWaiverSignature({ sessionID: SESSION, criterionId: criterion.id, sourceMessageId: "msg_real" }, signature),
    ).toBe(true)
  })

  it("refuses a genuine signature MOVED to another criterion or session", () => {
    // Signing the message alone would let one legitimate waiver silence every
    // criterion at once.
    const root = worktree()
    const store = pinned(root)
    const [first, second] = store.get(SESSION)
    const signature = signWaiver({ sessionID: SESSION, criterionId: first.id, sourceMessageId: "msg_real" })

    expect(
      verifyWaiverSignature({ sessionID: SESSION, criterionId: second.id, sourceMessageId: "msg_real" }, signature),
      "a waiver for one criterion must not cover another",
    ).toBe(false)
    expect(
      verifyWaiverSignature({ sessionID: "other-session", criterionId: first.id, sourceMessageId: "msg_real" }, signature),
      "a waiver must not cross sessions",
    ).toBe(false)
  })
})
