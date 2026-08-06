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

// ===========================================================================
// B-4 — `resolution:none` × 65, on turns with real file edits.
//
// Reproduced here through the REAL reader and the REAL resolver, because the
// defect needed all three of the measured conditions at once and each component
// looked fine on its own: a project with no test file anywhere (tier 2 empty),
// a package.json declaring only `check` and `dev` (tier 3's `scripts.test`
// filter missed), and absolute changed paths straight off opencode's `edit`
// tool. The FR-009 probe that was supposed to be the last resort was never
// supplied by any call site, so the whole thing fell through to `none`.
// ===========================================================================
describe("B-4: the measured `resolution:none` project resolves to a command", () => {
  it("package.json with ONLY `check` and `dev`, no test files, absolute changed paths", () => {
    write("package.json", '{"name":"neon-arcade","scripts":{"check":"tsc --noEmit","dev":"vite"}}')
    write("index.html", "<!doctype html>")
    write("src/games/memory.js", "export const memory = 1\n")
    write("src/games/breakout.js", "export const breakout = 1\n")

    const manifest = buildManifest(root)
    // Preconditions of the measured case, asserted so this test cannot pass for
    // the wrong reason if the fixture drifts.
    expect(manifest.testFiles).toEqual([])
    expect(manifest.scripts.test).toBeUndefined()

    const result = resolveVerifier(
      {
        // Exactly what `changedPathsFromTool` hands over: absolute paths.
        changedPaths: [join(root, "src/games/memory.js"), join(root, "index.html")],
        storyVerifiers: null,
      },
      { readManifest: () => manifest },
    )

    expect(result.command).toBe("npm run check")
    expect(result.rationale).toBe("fallback:package-script")
    expect(result.matchedPaths).toEqual(["src/games/memory.js", "index.html"])
  })

  it("...and a repo with neither test files nor any verifier script still degrades honestly", () => {
    write("package.json", '{"name":"x","scripts":{"dev":"vite"}}')
    write("src/app.js", "export const a = 1\n")

    const result = resolveVerifier(
      { changedPaths: [join(root, "src/app.js")], storyVerifiers: null },
      { readManifest: () => buildManifest(root) },
    )
    expect(result).toEqual({ command: null, rationale: "none", matchedPaths: [] })
  })
})
