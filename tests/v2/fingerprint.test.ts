/**
 * PROPERTY tests: what the worktree fingerprint must NOT be blind to.
 *
 * `fingerprintWorktree` is the second of two layers keeping a receipt honest.
 * Signing proves the harness minted it; the digest proves the code it attested
 * has not moved on. An audit enumerated five mutations the digest could not
 * see, each of which let a receipt outlive the code it verified:
 *
 *   - an edit under any directory NAMED `build`/`out`/`dist`/`target`/`vendor`,
 *     at any depth (the ignore list matched basenames)
 *   - retargeting a symlink (links were recorded by name only)
 *   - a chmod (mode was not in the digest line)
 *   - an edit to a file over 4 MB (metadata fallback: size+inode+mtime, the
 *     exact scheme already proven insufficient for small files)
 *   - a deletion inside an ignored directory
 *
 * These are written as "mutate X, digest must change" rather than as fixed
 * expected hashes, so they keep working as the implementation changes and they
 * fail for the right reason.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { fingerprintWorktree } from "../../src/goals.js"

const roots: string[] = []

function worktree(): string {
  const root = mkdtempSync(join(tmpdir(), "vertex-fp-"))
  roots.push(root)
  mkdirSync(join(root, "src"), { recursive: true })
  writeFileSync(join(root, "src", "service.ts"), "export const a = 1\n", "utf8")
  return root
}

const digestOf = (root: string): string => fingerprintWorktree(root).digest

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("the fingerprint sees changes that matter", () => {
  it("sees an ordinary edit (baseline)", () => {
    const root = worktree()
    const before = digestOf(root)
    writeFileSync(join(root, "src", "service.ts"), "export const a = 2\n", "utf8")
    expect(digestOf(root)).not.toBe(before)
  })

  it("sees a same-size edit (the original mtime bug)", () => {
    // `42` -> `44`: identical size, identical coarse mtime tick.
    const root = worktree()
    writeFileSync(join(root, "src", "n.ts"), "export const answer = 42\n", "utf8")
    const before = digestOf(root)
    writeFileSync(join(root, "src", "n.ts"), "export const answer = 44\n", "utf8")
    expect(digestOf(root)).not.toBe(before)
  })

  // Directories with derived-looking names that are NOT at the repo root hold
  // ordinary source often enough that ignoring them by basename was a
  // fabrication vector.
  const nested = ["build", "out", "dist", "target", "vendor", "coverage"]
  it.each(nested)("sees an edit under a NESTED directory named %s", (name) => {
    const root = worktree()
    mkdirSync(join(root, "src", name), { recursive: true })
    writeFileSync(join(root, "src", name, "compiler.ts"), "export const x = 1\n", "utf8")
    const before = digestOf(root)
    writeFileSync(join(root, "src", name, "compiler.ts"), 'export const x = 2 // broken\n', "utf8")
    expect(digestOf(root), `an edit under src/${name}/ must be visible`).not.toBe(before)
  })

  it("sees a symlink being retargeted", () => {
    const root = worktree()
    writeFileSync(join(root, "src", "good.ts"), "export const ok = true\n", "utf8")
    writeFileSync(join(root, "src", "bad.ts"), "export const ok = false\n", "utf8")
    symlinkSync("./good.ts", join(root, "src", "current.ts"))
    const before = digestOf(root)

    unlinkSync(join(root, "src", "current.ts"))
    symlinkSync("./bad.ts", join(root, "src", "current.ts"))
    expect(digestOf(root), "retargeting a symlink swaps the code it points at").not.toBe(before)
  })

  it("sees a mode change", () => {
    const root = worktree()
    const script = join(root, "entry.sh")
    writeFileSync(script, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
    const before = digestOf(root)
    chmodSync(script, 0o644)
    expect(digestOf(root), "clearing an exec bit breaks a real program").not.toBe(before)
  })

  it("sees a deletion", () => {
    const root = worktree()
    writeFileSync(join(root, "src", "gone.ts"), "export const g = 1\n", "utf8")
    const before = digestOf(root)
    unlinkSync(join(root, "src", "gone.ts"))
    expect(digestOf(root)).not.toBe(before)
  })

  it("marks the scope INCOMPLETE when a file is too large to hash", () => {
    // The metadata fallback cannot prove a large file is unchanged, and
    // `rsync -a`/`cp -p` preserve mtimes exactly. Unprovable must not read as
    // unchanged: `isStale` fails closed on an incomplete scope.
    const root = worktree()
    writeFileSync(join(root, "big.bin"), Buffer.alloc(5 * 1024 * 1024, 1))
    expect(fingerprintWorktree(root).complete, "a file we cannot hash makes the scope unprovable").toBe(false)
  })
})

describe("the fingerprint ignores what it must", () => {
  // The inverse property: if a verifier's own churn retired every receipt the
  // instant it was minted, persistence would be useless. These must NOT move
  // the digest.
  const alwaysIgnored = ["node_modules", ".git", "__pycache__", ".venv"]
  it.each(alwaysIgnored)("ignores %s at any depth", (name) => {
    const root = worktree()
    mkdirSync(join(root, "packages", "app", name), { recursive: true })
    const before = digestOf(root)
    writeFileSync(join(root, "packages", "app", name, "junk.js"), "whatever\n", "utf8")
    expect(digestOf(root), `${name} is tool-managed at any depth`).toBe(before)
  })

  it("ignores the harness's own state directory", () => {
    // Otherwise writing the receipt would invalidate the receipt.
    const root = worktree()
    const before = digestOf(root)
    mkdirSync(join(root, ".opencode", "elicify-vertex"), { recursive: true })
    writeFileSync(join(root, ".opencode", "elicify-vertex", "receipts.json"), "{}", "utf8")
    expect(digestOf(root)).toBe(before)
  })

  it("still ignores build output at the repo ROOT", () => {
    const root = worktree()
    mkdirSync(join(root, "dist"), { recursive: true })
    const before = digestOf(root)
    writeFileSync(join(root, "dist", "bundle.js"), "compiled\n", "utf8")
    expect(digestOf(root), "root-level dist/ is conventionally output").toBe(before)
  })
})
