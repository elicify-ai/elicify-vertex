import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { buildManifest } from "../../src/v2/wiring/manifest.js"
import { resolveVerifier } from "../../src/v2/resolve.js"

// ===========================================================================
// `projectRoots` population.
//
// `resolve.ts` gained per-ecosystem, per-project-root resolution, but the
// production manifest reader never populated `projectRoots` -- so the whole
// feature was inert outside its own unit tests: every non-npm ecosystem fell
// back to the repo root. Correct for a single-module repo, too broad for a
// nested Go module or a Cargo workspace member.
//
// These tests drive the REAL reader against a REAL temp repo, then feed its
// output to the REAL resolver, because the defect lived precisely in the seam
// between two components that were each individually green.
// ===========================================================================

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vertex-manifest-"))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function write(rel: string, body: string) {
  const full = join(root, rel)
  mkdirSync(join(full, ".."), { recursive: true })
  writeFileSync(full, body)
}

describe("buildManifest populates projectRoots", () => {
  it("finds nested go/python/rust project roots on the bounded walk", () => {
    write("services/api/go.mod", "module api\n")
    write("web/pyproject.toml", '[project]\nname="w"\n')
    write("crates/engine/Cargo.toml", "[package]\nname='e'\n")

    const found = buildManifest(root).projectRoots ?? []
    expect(found).toEqual(
      expect.arrayContaining([
        { ecosystem: "go", root: "services/api" },
        { ecosystem: "python", root: "web" },
        { ecosystem: "rust", root: "crates/engine" },
      ]),
    )
  })

  it("reports the repo root as \"\", matching the workspaces[].root convention", () => {
    write("go.mod", "module top\n")
    expect(buildManifest(root).projectRoots).toContainEqual({ ecosystem: "go", root: "" })
  })

  it("end to end: a nested Go change resolves to that module, not the repo root", () => {
    // The seam this whole file exists for.
    write("services/api/go.mod", "module api\n")
    write("package.json", '{"scripts":{"test":"vitest run"}}')

    const manifest = buildManifest(root)
    const go = resolveVerifier(
      { changedPaths: ["services/api/main.go"], storyVerifiers: null },
      { readManifest: () => manifest },
    )
    expect(go.command).toBe("go test ./services/api/...")

    // ...and a JS change in the same repo is untouched.
    const js = resolveVerifier(
      { changedPaths: ["src/index.ts"], storyVerifiers: null },
      { readManifest: () => manifest },
    )
    expect(js.command).toBe("npm test")
  })

  it("does not treat a directory named like a manifest as a project root", () => {
    mkdirSync(join(root, "go.mod"), { recursive: true })
    expect(buildManifest(root).projectRoots ?? []).not.toContainEqual({ ecosystem: "go", root: "" })
  })
})
