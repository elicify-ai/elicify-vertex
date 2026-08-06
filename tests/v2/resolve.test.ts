import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { observedCoversPrescribed } from "../../src/v2/coverage.js"
import type { Manifest, ResolveContext, ResolveDeps } from "../../src/v2/resolve.js"
import { classifyPathEcosystem, isUnsafeScriptBody, resolveVerifier } from "../../src/v2/resolve.js"
import { buildManifest } from "../../src/v2/wiring/manifest.js"

/** Helper: build ResolveDeps from a fixed manifest (or null). */
function deps(manifest: Manifest | null): ResolveDeps {
  return { readManifest: () => manifest }
}

function ctx(changedPaths: string[], storyVerifiers: readonly string[] | null = null): ResolveContext {
  return { changedPaths, storyVerifiers }
}

describe("resolve_tier_table (Scenario Outline: Resolution tiers return the narrowest command)", () => {
  // | story_verifier | changed | test_file | expected | rationale |
  it("row 1: story verifier present -> returns the story verifier, rationale story", () => {
    const result = resolveVerifier(
      ctx(["src/parser/x.ts"], ["npx vitest run tests/parser"]),
      deps({ scripts: {} }),
    )
    expect(result).toEqual({
      command: "npx vitest run tests/parser",
      rationale: "story",
      matchedPaths: ["src/parser/x.ts"],
    })
  })

  it("row 2: no story, basename .test match via manifest -> npx vitest run <test file>, rationale basename", () => {
    const result = resolveVerifier(
      ctx(["src/lexer.ts"]),
      deps({ scripts: {}, testFiles: ["tests/lexer.test.ts"] }),
    )
    expect(result).toEqual({
      command: "npx vitest run tests/lexer.test.ts",
      rationale: "basename",
      matchedPaths: ["src/lexer.ts"],
    })
  })

  it("row 3: no story, basename .spec match (nested source path) -> rationale basename", () => {
    const result = resolveVerifier(
      ctx(["src/util/deep/fmt.ts"]),
      deps({ scripts: {}, testFiles: ["tests/fmt.spec.ts"] }),
    )
    expect(result).toEqual({
      command: "npx vitest run tests/fmt.spec.ts",
      rationale: "basename",
      matchedPaths: ["src/util/deep/fmt.ts"],
    })
  })

  it("row 4: no story, no basename match, package.json has a test script -> npm test, rationale fallback:package-script", () => {
    const result = resolveVerifier(
      ctx(["src/misc.ts"]),
      deps({ scripts: { test: "vitest run" } }),
    )
    expect(result).toEqual({
      command: "npm test",
      rationale: "fallback:package-script",
      matchedPaths: ["src/misc.ts"],
    })
  })
})

describe("resolve_degrades_generic (Ambiguous resolution degrades to generic prescription)", () => {
  it("no story, no convention match, no package scripts -> command null, rationale none, matchedPaths empty", () => {
    const result = resolveVerifier(
      ctx(["src/x.ts"]),
      deps({ scripts: {} }),
    )
    expect(result).toEqual({ command: null, rationale: "none", matchedPaths: [] })
  })

  it("manifest entirely absent (readManifest returns null) -> also degrades to none", () => {
    const result = resolveVerifier(ctx(["src/x.ts"]), deps(null))
    expect(result).toEqual({ command: null, rationale: "none", matchedPaths: [] })
  })
})

describe("Dataset: Narrowest-verifier resolution (fixture layout, all 10 rows)", () => {
  it("row 1: story verifier wins over everything else in the manifest", () => {
    const result = resolveVerifier(
      ctx(["src/parser/x.ts"], ["npx vitest run tests/parser"]),
      // Manifest also contains a would-be basename/package match; story must still win.
      deps({ scripts: { test: "vitest run" }, testFiles: ["tests/x.test.ts"] }),
    )
    expect(result).toEqual({
      command: "npx vitest run tests/parser",
      rationale: "story",
      matchedPaths: ["src/parser/x.ts"],
    })
  })

  it("row 2: basename .test convention", () => {
    const result = resolveVerifier(
      ctx(["src/lexer.ts"]),
      deps({ scripts: {}, testFiles: ["tests/lexer.test.ts"] }),
    )
    expect(result.command).toBe("npx vitest run tests/lexer.test.ts")
    expect(result.rationale).toBe("basename")
    expect(result.matchedPaths).toEqual(["src/lexer.ts"])
  })

  it("row 3: basename .spec convention variant", () => {
    const result = resolveVerifier(
      ctx(["src/util/deep/fmt.ts"]),
      deps({ scripts: {}, testFiles: ["tests/fmt.spec.ts"] }),
    )
    expect(result.command).toBe("npx vitest run tests/fmt.spec.ts")
    expect(result.rationale).toBe("basename")
  })

  it("row 4: package.json fallback (npm test)", () => {
    const result = resolveVerifier(ctx(["src/misc.ts"]), deps({ scripts: { test: "vitest run" } }))
    expect(result.command).toBe("npm test")
    expect(result.rationale).toBe("fallback:package-script")
  })

  it("row 5: multi-path join — both changed files resolve via basename, joined into one command", () => {
    const result = resolveVerifier(
      ctx(["src/a.ts", "src/b.ts"]),
      deps({ scripts: {}, testFiles: ["tests/a.test.ts", "tests/b.test.ts"] }),
    )
    expect(result).toEqual({
      command: "npx vitest run tests/a.test.ts tests/b.test.ts",
      rationale: "basename",
      matchedPaths: ["src/a.ts", "src/b.ts"],
    })
  })

  it("row 6: docs-only exemption — caller never surfaces a docs-only path, so changedPaths arrives empty -> none, no prescription", () => {
    // FR-016's docs-only exemption lives in the v1-preserved idle gate, not in the
    // resolver's own tier logic (FR-008 lists exactly four tiers, none of them
    // "docs"). Judgment call: like row 10's outside-worktree exclusion, the caller is
    // expected to have already excluded README.md-only changes before ever invoking
    // resolution (there is nothing to verify), so this row is exercised the same way:
    // an already-filtered, empty changedPaths list, regardless of manifest contents
    // ("any" in the dataset).
    const result = resolveVerifier(ctx([]), deps({ scripts: { test: "vitest run" }, testFiles: ["tests/whatever.test.ts"] }))
    expect(result).toEqual({ command: null, rationale: "none", matchedPaths: [] })
  })

  it("row 7: empty manifest, no scripts -> generic category list (command null, rationale none)", () => {
    const result = resolveVerifier(ctx(["src/x.ts"]), deps({ scripts: {} }))
    expect(result).toEqual({ command: null, rationale: "none", matchedPaths: [] })
  })

  it("row 8: 12 changed paths -> matchedPaths carries the full list for the composer's display-cap logic", () => {
    const changedPaths = Array.from({ length: 12 }, (_, i) => `src/file${i}.ts`)
    const result = resolveVerifier(ctx(changedPaths), deps({ scripts: { test: "vitest run" } }))
    expect(result.command).toBe("npm test")
    expect(result.rationale).toBe("fallback:package-script")
    expect(result.matchedPaths).toHaveLength(12)
    expect(result.matchedPaths).toEqual(changedPaths)
  })

  it("row 9: monorepo — nearest manifest wins (packages/api's own package.json beats the workspace root)", () => {
    const result = resolveVerifier(
      ctx(["packages/api/src/h.ts"]),
      deps({
        scripts: { test: "vitest run" }, // root package.json also has a test script
        workspaces: [{ root: "packages/api", scripts: { test: "vitest run" } }],
      }),
    )
    expect(result).toEqual({
      command: "npm test -w packages/api",
      rationale: "fallback:package-script",
      matchedPaths: ["packages/api/src/h.ts"],
    })
  })

  it("row 9b: monorepo — path outside any nested workspace falls back to the root manifest", () => {
    const result = resolveVerifier(
      ctx(["src/root-only.ts"]),
      deps({
        scripts: { test: "vitest run" },
        workspaces: [{ root: "packages/api", scripts: { test: "vitest run" } }],
      }),
    )
    expect(result.command).toBe("npm test")
    expect(result.rationale).toBe("fallback:package-script")
  })

  it("row 10: outside-worktree exclusion — the path is EXCLUDED here, and nothing is prescribed for it", () => {
    // This row used to be asserted by handing the resolver an EMPTY path list:
    // empty in, none out, which is equally true of a function that does nothing
    // at all — it could not fail. Row 10 is about a path that IS supplied and
    // lies outside the worktree, which is the case the caller never filters
    // (`ResolveContext.changedPaths`) and which `isInsideAnyRoot` enforces here.
    const result = resolveVerifier(
      ctx(["/home/dev/other-repo/src/x.ts"]),
      deps({ scripts: { test: "vitest run" }, workspaceRoot: "/work/monorepo" }),
    )
    expect(result).toEqual({ command: null, rationale: "none", matchedPaths: [] })

    // ...and the same path INSIDE the root does resolve, so the assertion above
    // is about the bound and not about the manifest being unusable.
    const inside = resolveVerifier(
      ctx(["/work/monorepo/src/x.ts"]),
      deps({ scripts: { test: "vitest run" }, workspaceRoot: "/work/monorepo" }),
    )
    expect(inside.command).toBe("npm test")
    expect(inside.matchedPaths).toEqual(["src/x.ts"])
  })
})

describe("FR-009: the bounded fallback probe tier is GONE (B-4 (b))", () => {
  // `ResolveDeps.fallbackProbe` was never supplied by either production call site
  // (`plugin.ts`'s verify-gap branch, `gate.ts:narrowestPrescription`), so the tier
  // had never executed outside its own unit tests. It was deleted rather than
  // wired: `wiring/manifest.ts:scanRepo` already collects every `*.test.*` /
  // `*.spec.*` in the worktree into `manifest.testFiles` under the same bounds, so
  // a probe honouring those bounds can only return a subset of what tier 2 already
  // saw. FR-009 permitted the probe; it never required it, and it explicitly
  // requires the degraded path to be correct without it.

  it("ResolveDeps carries no probe hook at all — the type is readManifest and nothing else", () => {
    // A compile-time assertion, not a shape count: `keyof ResolveDeps` widening
    // back to include a probe fails this line and the tsc projects together.
    const keys: Array<keyof ResolveDeps> = ["readManifest"]
    const probeless: "readManifest" = keys[0]
    expect(probeless).toBe("readManifest")
    expect(Object.keys(deps({ scripts: {} }))).toEqual(["readManifest"])
  })

  it("the degraded path is still correct with no probe (FR-009: correctness never depended on it)", () => {
    const result = resolveVerifier(ctx(["src/x.ts"]), deps({ scripts: {} }))
    expect(result).toEqual({ command: null, rationale: "none", matchedPaths: [] })
  })

  it("an unrecognised extra dep is inert — nothing in the resolver reaches for a probe", () => {
    // The tier's whole observable signature was "a probe's test files appear in
    // the command". Passing one in the old shape must now change nothing.
    const withStrayProbe = {
      readManifest: () => ({ scripts: {} }) as Manifest,
      fallbackProbe: () => ["live/x.test.ts"],
    }
    const result = resolveVerifier(ctx(["src/x.ts"]), withStrayProbe)
    expect(result.command).toBeNull()
    expect(result.rationale).toBe("none")
  })
})

describe("Additional behavior not covered by the dataset (judgment calls, documented)", () => {
  it("multiple story verifiers are joined with && and all cover the full changed-path set", () => {
    const result = resolveVerifier(
      ctx(["src/a.ts", "src/b.ts"], ["npx vitest run tests/a", "npx eslint src/a.ts"]),
      deps({ scripts: {} }),
    )
    expect(result).toEqual({
      command: "npx vitest run tests/a && npx eslint src/a.ts",
      rationale: "story",
      matchedPaths: ["src/a.ts", "src/b.ts"],
    })
  })

  it("an empty story-verifier array is treated the same as null (falls through to lower tiers)", () => {
    const result = resolveVerifier(ctx(["src/misc.ts"], []), deps({ scripts: { test: "vitest run" } }))
    expect(result.rationale).toBe("fallback:package-script")
  })

  it("blank-only story verifier strings are ignored", () => {
    const result = resolveVerifier(ctx(["src/misc.ts"], ["   "]), deps({ scripts: { test: "vitest run" } }))
    expect(result.rationale).toBe("fallback:package-script")
  })

  it("no changed paths at all -> none regardless of manifest richness", () => {
    const result = resolveVerifier(
      ctx([], ["should not matter"]),
      deps({ scripts: { test: "vitest run" }, testFiles: ["tests/anything.test.ts"] }),
    )
    // Empty changedPaths short-circuits before the story tier is even consulted —
    // there is nothing to resolve a command *for*.
    expect(result).toEqual({ command: null, rationale: "none", matchedPaths: [] })
  })

  it("a basename match only covers the subset of changed paths that actually matched", () => {
    const result = resolveVerifier(
      ctx(["src/a.ts", "src/unmatched.ts"]),
      deps({ scripts: {}, testFiles: ["tests/a.test.ts"] }),
    )
    expect(result.rationale).toBe("basename")
    expect(result.matchedPaths).toEqual(["src/a.ts"])
    expect(result.command).toBe("npx vitest run tests/a.test.ts")
  })
})

// ===========================================================================
// LANGUAGE AWARENESS
//
// The measured defect this section exists to pin: in a polyglot repo the
// resolver had exactly one strategy (a package.json with `scripts.test`), so
//
//   Go change, NO package.json anywhere    -> command=null  rationale=none
//   Go change, repo ALSO has package.json  -> command="npm test"
//   Python change, repo also has package.json -> command="npm test"
//
// The model then correctly ran `go test ./...`, `coverage.ts` compared it
// against `npm test`, the runners are in deliberately different alias classes,
// and the RECEIPT WAS SUPPRESSED. Evidence starvation — the same failure class
// as D1, reached from the prescription side instead of the observation side.
// ===========================================================================

/** A repo that is *also* a JS project — the exact shape that produced the defect. */
const POLYGLOT_NODE_MANIFEST: Manifest = { scripts: { test: "vitest run" } }

describe("language awareness: a change never resolves to another ecosystem's runner (requirement 1)", () => {
  it("REGRESSION — a .go change in a repo that ALSO has package.json resolves to go, not `npm test`", () => {
    const result = resolveVerifier(ctx(["internal/auth/service.go"]), deps(POLYGLOT_NODE_MANIFEST))
    expect(result.command).not.toBe("npm test")
    expect(result).toEqual({
      command: "go test ./...",
      rationale: "fallback:package-script",
      matchedPaths: ["internal/auth/service.go"],
    })
  })

  it("REGRESSION — a .py change in a repo that ALSO has package.json resolves to pytest, not `npm test`", () => {
    const result = resolveVerifier(ctx(["app/models.py"]), deps(POLYGLOT_NODE_MANIFEST))
    expect(result.command).not.toBe("npm test")
    expect(result).toEqual({
      command: "pytest",
      rationale: "fallback:package-script",
      matchedPaths: ["app/models.py"],
    })
  })

  it("REGRESSION — a .rs change in a repo that ALSO has package.json resolves to cargo, not `npm test`", () => {
    const result = resolveVerifier(ctx(["src/lib.rs"]), deps(POLYGLOT_NODE_MANIFEST))
    expect(result.command).not.toBe("npm test")
    expect(result).toEqual({
      command: "cargo test",
      rationale: "fallback:package-script",
      matchedPaths: ["src/lib.rs"],
    })
  })

  it("REGRESSION — a .go change with NO package.json anywhere resolves instead of degrading to none", () => {
    // Previously: command=null, rationale=none. The generic category list is a
    // strictly weaker prescription than the correct one, and it makes the caller's
    // coverage comparison unreachable entirely.
    const result = resolveVerifier(ctx(["main.go"]), deps({ scripts: {} }))
    expect(result).toEqual({
      command: "go test ./...",
      rationale: "fallback:package-script",
      matchedPaths: ["main.go"],
    })
  })

  it("resolves Go with no manifest at all (readManifest returns null)", () => {
    const result = resolveVerifier(ctx(["cmd/server/main.go"]), deps(null))
    expect(result.command).toBe("go test ./...")
  })

  it("never prescribes a BARE `go test` — it would mean only the cwd package (coverage.ts WHOLE_SUITE_WHEN_BARE)", () => {
    const result = resolveVerifier(ctx(["internal/auth/service.go"]), deps(POLYGLOT_NODE_MANIFEST))
    expect(result.command).toBe("go test ./...")
    // And the prescription must NOT be satisfiable by a bare `go test`, which
    // compiles and runs one package while exiting 0.
    expect(observedCoversPrescribed(result.command!, "go test")).toBe(false)
  })

  it("the JS/TS path is untouched: a .ts change in the same polyglot repo still resolves to npm test", () => {
    const result = resolveVerifier(ctx(["src/app.ts"]), deps(POLYGLOT_NODE_MANIFEST))
    expect(result).toEqual({
      command: "npm test",
      rationale: "fallback:package-script",
      matchedPaths: ["src/app.ts"],
    })
  })

  it("story verifiers still win over ecosystem inference (tier-1 precedence preserved)", () => {
    const result = resolveVerifier(
      ctx(["internal/auth/service.go"], ["go test ./internal/auth/..."]),
      deps(POLYGLOT_NODE_MANIFEST),
    )
    expect(result).toEqual({
      command: "go test ./internal/auth/...",
      rationale: "story",
      matchedPaths: ["internal/auth/service.go"],
    })
  })

})

describe("language awareness: nearest ancestor project root scopes the command", () => {
  it("nested go.mod -> the command is scoped to that module, not the repo root", () => {
    const result = resolveVerifier(
      ctx(["services/api/internal/auth/service.go"]),
      deps({
        scripts: { test: "vitest run" },
        projectRoots: [{ ecosystem: "go", root: "services/api" }],
      }),
    )
    expect(result.command).toBe("go test ./services/api/...")
  })

  it("nested pyproject.toml -> pytest is scoped to that package", () => {
    const result = resolveVerifier(
      ctx(["services/ml/train.py"]),
      deps({ scripts: {}, projectRoots: [{ ecosystem: "python", root: "services/ml" }] }),
    )
    expect(result.command).toBe("pytest services/ml")
  })

  it("nested Cargo.toml -> cargo test is pointed at that crate's manifest", () => {
    const result = resolveVerifier(
      ctx(["crates/parser/src/lib.rs"]),
      deps({ scripts: {}, projectRoots: [{ ecosystem: "rust", root: "crates/parser" }] }),
    )
    expect(result.command).toBe("cargo test --manifest-path crates/parser/Cargo.toml")
  })

  it("nearest wins: the deeper of two nested go modules is chosen", () => {
    const result = resolveVerifier(
      ctx(["services/api/tools/gen/main.go"]),
      deps({
        scripts: {},
        projectRoots: [
          { ecosystem: "go", root: "services/api" },
          { ecosystem: "go", root: "services/api/tools/gen" },
        ],
      }),
    )
    expect(result.command).toBe("go test ./services/api/tools/gen/...")
  })

  it("a project root that does not contain the path is ignored (no false scoping)", () => {
    const result = resolveVerifier(
      ctx(["cmd/server/main.go"]),
      deps({ scripts: {}, projectRoots: [{ ecosystem: "go", root: "services/api" }] }),
    )
    expect(result.command).toBe("go test ./...")
  })

  it("a python project root never scopes a go path (roots are per-ecosystem)", () => {
    const result = resolveVerifier(
      ctx(["services/ml/agent.go"]),
      deps({ scripts: {}, projectRoots: [{ ecosystem: "python", root: "services/ml" }] }),
    )
    expect(result.command).toBe("go test ./...")
  })

  it("two distinct go modules changed in one turn produce one sub-command each", () => {
    const result = resolveVerifier(
      ctx(["services/a/x.go", "services/b/y.go"]),
      deps({
        scripts: {},
        projectRoots: [
          { ecosystem: "go", root: "services/a" },
          { ecosystem: "go", root: "services/b" },
        ],
      }),
    )
    expect(result.command).toBe("go test ./services/a/... && go test ./services/b/...")
    expect(result.matchedPaths).toEqual(["services/a/x.go", "services/b/y.go"])
  })
})

describe("language awareness: polyglot changed-path sets (requirement 2 — the `&&` join rule)", () => {
  it("a .go AND a .ts change in one turn prescribe BOTH suites, joined with &&", () => {
    const result = resolveVerifier(
      ctx(["internal/auth/service.go", "src/app.ts"]),
      deps(POLYGLOT_NODE_MANIFEST),
    )
    expect(result).toEqual({
      command: "go test ./... && npm test",
      rationale: "fallback:package-script",
      matchedPaths: ["internal/auth/service.go", "src/app.ts"],
    })
  })

  it("sub-command order follows first appearance in changedPaths (deterministic for a given input)", () => {
    const result = resolveVerifier(
      ctx(["src/app.ts", "internal/auth/service.go"]),
      deps(POLYGLOT_NODE_MANIFEST),
    )
    expect(result.command).toBe("npm test && go test ./...")
  })

  it("the JS/TS group keeps its own narrower basename tier inside a polyglot join", () => {
    const result = resolveVerifier(
      ctx(["src/lexer.ts", "main.go"]),
      deps({ scripts: { test: "vitest run" }, testFiles: ["tests/lexer.test.ts"] }),
    )
    expect(result.command).toBe("npx vitest run tests/lexer.test.ts && go test ./...")
    // Mixed tiers report the broader one — only an all-basename batch is "basename".
    expect(result.rationale).toBe("fallback:package-script")
  })

  it("three ecosystems in one turn all appear in the prescription", () => {
    const result = resolveVerifier(
      ctx(["main.go", "app/models.py", "src/lib.rs"]),
      deps({ scripts: {} }),
    )
    expect(result.command).toBe("go test ./... && pytest && cargo test")
  })

  it("a Go group that resolves alongside a JS group that does NOT still prescribes the Go suite", () => {
    // No package.json test script -> the node group contributes nothing; the Go
    // prescription must survive rather than the whole turn degrading to none.
    const result = resolveVerifier(ctx(["main.go", "src/app.ts"]), deps({ scripts: {} }))
    expect(result).toEqual({
      command: "go test ./...",
      rationale: "fallback:package-script",
      matchedPaths: ["main.go"],
    })
  })

  it("unclassifiable paths ride along with the JS/TS group (today's matchedPaths behaviour preserved)", () => {
    const result = resolveVerifier(ctx(["src/app.ts", "db/schema.sql"]), deps(POLYGLOT_NODE_MANIFEST))
    expect(result).toEqual({
      command: "npm test",
      rationale: "fallback:package-script",
      matchedPaths: ["src/app.ts", "db/schema.sql"],
    })
  })

  it("a set with NO classifiable path at all is treated as JS/TS, exactly as before", () => {
    const result = resolveVerifier(ctx(["db/schema.sql", "Dockerfile"]), deps(POLYGLOT_NODE_MANIFEST))
    expect(result).toEqual({
      command: "npm test",
      rationale: "fallback:package-script",
      matchedPaths: ["db/schema.sql", "Dockerfile"],
    })
  })

  it("unclassifiable paths are NOT claimed when only non-JS ecosystems are in play (fail closed)", () => {
    const result = resolveVerifier(ctx(["main.go", "db/schema.sql"]), deps(POLYGLOT_NODE_MANIFEST))
    expect(result.command).toBe("go test ./...")
    expect(result.matchedPaths).toEqual(["main.go"])
  })
})

describe("language awareness: resolve <-> coverage pairing (requirement 4)", () => {
  /** Resolve, then assert the prescription is non-null and hand it back for pairing. */
  function prescribe(changedPaths: string[], manifest: Manifest | null): string {
    const command = resolveVerifier(ctx(changedPaths), deps(manifest)).command
    expect(command).not.toBeNull()
    return command!
  }

  it("Go (repo-root module): the obvious `go test ./...` — and the spec's build-then-test chain — both cover it", () => {
    const prescribed = prescribe(["internal/auth/service.go"], POLYGLOT_NODE_MANIFEST)
    expect(observedCoversPrescribed(prescribed, "go test ./...")).toBe(true)
    expect(observedCoversPrescribed(prescribed, "go build ./... && go test ./... -count=1 2>&1")).toBe(true)
    expect(observedCoversPrescribed(prescribed, "go test ./... | tail -50")).toBe(true)
  })

  it("Go (repo-root module): a build alone, an npm run, and a single-test filter do NOT cover it", () => {
    const prescribed = prescribe(["internal/auth/service.go"], POLYGLOT_NODE_MANIFEST)
    expect(observedCoversPrescribed(prescribed, "go build ./...")).toBe(false)
    expect(observedCoversPrescribed(prescribed, "npm test")).toBe(false)
    expect(observedCoversPrescribed(prescribed, "go test -run TestOnlyOne ./...")).toBe(false)
  })

  it("Go (nested module): a whole-tree `go test ./...` covers the module-scoped prescription", () => {
    const prescribed = prescribe(["services/api/handler.go"], {
      scripts: {},
      projectRoots: [{ ecosystem: "go", root: "services/api" }],
    })
    expect(prescribed).toBe("go test ./services/api/...")
    expect(observedCoversPrescribed(prescribed, "go test ./...")).toBe(true)
    expect(observedCoversPrescribed(prescribed, "go test ./services/api/...")).toBe(true)
    // A sibling module is not this module.
    expect(observedCoversPrescribed(prescribed, "go test ./services/worker/...")).toBe(false)
    // The runner must stay `go test`, or a build would satisfy a test prescription.
    expect(observedCoversPrescribed(prescribed, "go build ./...")).toBe(false)
    expect(observedCoversPrescribed(prescribed, "go -C services/api build ./...")).toBe(false)
  })

  it("Python: every conventional launcher covers the prescription; a JS suite does not", () => {
    const prescribed = prescribe(["app/models.py"], POLYGLOT_NODE_MANIFEST)
    expect(observedCoversPrescribed(prescribed, "pytest")).toBe(true)
    expect(observedCoversPrescribed(prescribed, "python3 -m pytest")).toBe(true)
    expect(observedCoversPrescribed(prescribed, "uv run pytest")).toBe(true)
    expect(observedCoversPrescribed(prescribed, "npm test")).toBe(false)
    expect(observedCoversPrescribed(prescribed, "pytest --collect-only")).toBe(false)
  })

  it("Python (nested package): a whole-suite `pytest` covers the scoped prescription", () => {
    const prescribed = prescribe(["services/ml/train.py"], {
      scripts: {},
      projectRoots: [{ ecosystem: "python", root: "services/ml" }],
    })
    expect(prescribed).toBe("pytest services/ml")
    expect(observedCoversPrescribed(prescribed, "pytest")).toBe(true)
    expect(observedCoversPrescribed(prescribed, "python3 -m pytest services/ml")).toBe(true)
    expect(observedCoversPrescribed(prescribed, "pytest services/other")).toBe(false)
  })

  it("Rust: `cargo test` covers both the root and the manifest-scoped prescription", () => {
    const rootPrescribed = prescribe(["src/lib.rs"], POLYGLOT_NODE_MANIFEST)
    expect(observedCoversPrescribed(rootPrescribed, "cargo test")).toBe(true)
    expect(observedCoversPrescribed(rootPrescribed, "cargo test 2>&1 | tail -5")).toBe(true)
    expect(observedCoversPrescribed(rootPrescribed, "cargo build")).toBe(false)

    const scopedPrescribed = prescribe(["crates/parser/src/lib.rs"], {
      scripts: {},
      projectRoots: [{ ecosystem: "rust", root: "crates/parser" }],
    })
    expect(scopedPrescribed).toBe("cargo test --manifest-path crates/parser/Cargo.toml")
    expect(observedCoversPrescribed(scopedPrescribed, "cargo test")).toBe(true)
    expect(
      observedCoversPrescribed(scopedPrescribed, "cargo test --manifest-path crates/parser/Cargo.toml"),
    ).toBe(true)
  })

  it("polyglot: the `&&` prescription demands BOTH suites and is satisfied by running both", () => {
    const prescribed = prescribe(["internal/auth/service.go", "src/app.ts"], POLYGLOT_NODE_MANIFEST)
    expect(prescribed).toBe("go test ./... && npm test")
    expect(observedCoversPrescribed(prescribed, "go test ./... && npm test")).toBe(true)
    // FR-036 alias class: any JS whole-suite runner satisfies the npm half.
    expect(observedCoversPrescribed(prescribed, "go test ./... && npx vitest run")).toBe(true)
    // Half the work is not the work.
    expect(observedCoversPrescribed(prescribed, "go test ./...")).toBe(false)
    expect(observedCoversPrescribed(prescribed, "npm test")).toBe(false)
  })

  it("polyglot with a narrower JS tier: running the broader JS suite still covers it", () => {
    const prescribed = prescribe(["src/lexer.ts", "main.go"], {
      scripts: { test: "vitest run" },
      testFiles: ["tests/lexer.test.ts"],
    })
    expect(prescribed).toBe("npx vitest run tests/lexer.test.ts && go test ./...")
    expect(observedCoversPrescribed(prescribed, "npm test && go test ./...")).toBe(true)
    expect(observedCoversPrescribed(prescribed, "npm test")).toBe(false)
  })
})

// ===========================================================================
// B-4 — `resolution:none` fired 65 times in one measured session, including on
// turns carrying real changed paths (`src/games/memory.js`, `index.html`,
// `src/games/breakout.js`).
//
// Tier-by-tier miss: no story verifiers (tier 1); `manifest.testFiles` empty,
// the project genuinely had no test file (tier 2); tier 3 hard-filtered on
// `scripts.test` while the project's package.json declared only `check` and
// `dev`; the FR-009 probe was never supplied by either call site, so it was
// dead code. The harness spent the session reciting a category list.
// ===========================================================================

describe("B-4 (a): tier 3 prescribes an ORDERED preference of scripts, not `test` alone", () => {
  it("THE MEASURED CASE — package.json with only `check` and `dev` resolves to a command, not none", () => {
    const result = resolveVerifier(
      ctx(["src/games/memory.js", "index.html"]),
      deps({ scripts: { check: "tsc --noEmit && eslint .", dev: "vite" } }),
    )
    expect(result.command).toBe("npm run check")
    expect(result.rationale).toBe("fallback:package-script")
    expect(result.matchedPaths).toEqual(["src/games/memory.js", "index.html"])
  })

  it.each([
    ["check", { check: "c", verify: "v", lint: "l", typecheck: "t", build: "b" }],
    ["verify", { verify: "v", lint: "l", typecheck: "t", build: "b" }],
    ["lint", { lint: "l", typecheck: "t", build: "b" }],
    ["typecheck", { typecheck: "t", build: "b" }],
    ["build", { build: "b" }],
  ])("prefers `%s` when it is the best script present", (expected, scripts) => {
    const result = resolveVerifier(ctx(["src/misc.ts"]), deps({ scripts }))
    expect(result.command).toBe(`npm run ${expected}`)
  })

  it("`test` outranks every widened name AND keeps the bare `npm test` spelling", () => {
    // The spelling is load-bearing: only `npm test` sits in
    // `coverage.ts:WHOLE_SUITE_ALIASES`, so `npm run test` would narrow what
    // counts as covering evidence for the single most common verifier there is.
    const result = resolveVerifier(
      ctx(["src/misc.ts"]),
      deps({ scripts: { build: "b", check: "c", test: "vitest run", lint: "l" } }),
    )
    expect(result.command).toBe("npm test")
    expect(observedCoversPrescribed(result.command!, "npx vitest run")).toBe(true)
  })

  it("the preference list is CLOSED — a package.json of only non-verifier scripts still degrades to none", () => {
    // `npm run dev` starts a server that never exits; `start`/`deploy`/`clean`
    // are worse. Prescribing an arbitrary script is worse than prescribing none.
    const result = resolveVerifier(
      ctx(["src/misc.ts"]),
      deps({ scripts: { dev: "vite", start: "node .", deploy: "fly deploy", clean: "rm -rf dist" } }),
    )
    expect(result).toEqual({ command: null, rationale: "none", matchedPaths: [] })
  })

  it("a blank script body does not count as a declared verifier", () => {
    const result = resolveVerifier(ctx(["src/misc.ts"]), deps({ scripts: { check: "   " } }))
    expect(result.command).toBeNull()
  })

  it("the widened prescription pairs with coverage.ts: the same command covers it, a different script does not", () => {
    const prescribed = resolveVerifier(ctx(["src/misc.ts"]), deps({ scripts: { check: "c", build: "b" } })).command!
    expect(prescribed).toBe("npm run check")
    expect(observedCoversPrescribed(prescribed, "npm run check")).toBe(true)
    expect(observedCoversPrescribed(prescribed, "npm run check 2>&1 | tail -20")).toBe(true)
    // Fail closed: running a DIFFERENT script is not evidence for this one.
    expect(observedCoversPrescribed(prescribed, "npm run build")).toBe(false)
    expect(observedCoversPrescribed(prescribed, "npm test")).toBe(false)
  })

  it("PRECEDENCE UNCHANGED — nearest manifest still wins: a nested `check` beats the root's `test`", () => {
    // Widening the script set must not quietly promote the root manifest over
    // the package the change actually lives in (dataset row 9's rule).
    const result = resolveVerifier(
      ctx(["packages/api/src/h.ts"]),
      deps({
        scripts: { test: "vitest run" },
        workspaces: [{ root: "packages/api", scripts: { check: "tsc --noEmit" } }],
      }),
    )
    expect(result.command).toBe("npm run check -w packages/api")
    expect(result.rationale).toBe("fallback:package-script")
  })

  it("a workspace-scoped widened script carries npm's `-w` selector, so a bare root run cannot cover it", () => {
    const prescribed = resolveVerifier(
      ctx(["packages/api/src/h.ts"]),
      deps({ scripts: {}, workspaces: [{ root: "packages/api", scripts: { check: "tsc --noEmit" } }] }),
    ).command!
    expect(prescribed).toBe("npm run check -w packages/api")
    expect(observedCoversPrescribed(prescribed, "npm run check -w packages/api")).toBe(true)
    expect(observedCoversPrescribed(prescribed, "npm run check")).toBe(false)
  })

  it("tier 2 still outranks tier 3 — a basename match beats a widened script", () => {
    const result = resolveVerifier(
      ctx(["src/lexer.ts"]),
      deps({ scripts: { check: "tsc --noEmit" }, testFiles: ["tests/lexer.test.ts"] }),
    )
    expect(result.command).toBe("npx vitest run tests/lexer.test.ts")
    expect(result.rationale).toBe("basename")
  })

  it("tier 1 still outranks tier 3 — a story verifier beats a widened script", () => {
    const result = resolveVerifier(
      ctx(["src/misc.ts"], ["npm run check"]),
      deps({ scripts: { check: "tsc --noEmit" } }),
    )
    expect(result.rationale).toBe("story")
  })

  it("a widened script never crosses ecosystems — a .go change still resolves to go", () => {
    const result = resolveVerifier(ctx(["main.go"]), deps({ scripts: { check: "tsc --noEmit" } }))
    expect(result.command).toBe("go test ./...")
  })
})

describe("B-4 (c): ABSOLUTE changed paths are relativised against manifest.workspaceRoot", () => {
  // opencode's `edit`/`write` tools declare `filePath` as an absolute path and
  // `changedPathsFromTool` passes it through verbatim, so in production nearly
  // every changed path arrives absolute — while `workspaces[].root` and
  // `projectRoots[].root` are bare and repo-relative.

  it("KILLER — a root-level file is not scoped into a workspace whose NAME appears in the absolute prefix", () => {
    // Repo at /work/app, workspace literally named `app`. The old root-unaware
    // heuristic hunted for `/app/` anywhere in the string, found the repo's own
    // directory, and prescribed `npm test -w app` for a file that lives at the
    // root — a workspace selector naming a package the change is not in.
    const result = resolveVerifier(
      ctx(["/work/app/src/x.ts"]),
      deps({
        scripts: { test: "vitest run" },
        workspaceRoot: "/work/app",
        workspaces: [{ root: "app", scripts: { test: "vitest run" } }],
      }),
    )
    expect(result.command).toBe("npm test")
    expect(result.matchedPaths).toEqual(["src/x.ts"])
  })

  it("KILLER — a repo-root Go file is not scoped into a project root whose name appears in the prefix", () => {
    const result = resolveVerifier(
      ctx(["/work/services/main.go"]),
      deps({
        scripts: {},
        workspaceRoot: "/work/services",
        projectRoots: [{ ecosystem: "go", root: "services" }],
      }),
    )
    expect(result.command).toBe("go test ./...")
  })

  it("a genuinely nested absolute path still resolves to its own workspace", () => {
    const result = resolveVerifier(
      ctx(["/work/app/packages/api/src/h.ts"]),
      deps({
        scripts: { test: "vitest run" },
        workspaceRoot: "/work/app",
        workspaces: [{ root: "packages/api", scripts: { test: "vitest run" } }],
      }),
    )
    expect(result.command).toBe("npm test -w packages/api")
    expect(result.matchedPaths).toEqual(["packages/api/src/h.ts"])
  })

  it("the story tier reports relativised matchedPaths too — one coordinate system for every tier", () => {
    const result = resolveVerifier(
      ctx(["/work/app/src/x.ts"], ["npm run check"]),
      deps({ scripts: {}, workspaceRoot: "/work/app" }),
    )
    expect(result.matchedPaths).toEqual(["src/x.ts"])
  })

  it("a path OUTSIDE the workspace root is never silently rebased into the repo", () => {
    // FIX 4 strengthened this from "left absolute" to "excluded entirely": a
    // file in another repo is not this session's business, and leaving it in the
    // set kept it reachable by the marker heuristic below.
    const result = resolveVerifier(
      ctx(["/tmp/elsewhere/x.ts"]),
      deps({ scripts: { test: "vitest run" }, workspaceRoot: "/work/app" }),
    )
    expect(result).toEqual({ command: null, rationale: "none", matchedPaths: [] })
  })

  it("the workspace root itself is never reduced to an empty path", () => {
    const result = resolveVerifier(
      ctx(["/work/app"]),
      deps({ scripts: { test: "vitest run" }, workspaceRoot: "/work/app" }),
    )
    expect(result.matchedPaths).toEqual(["/work/app"])
  })

  it("a manifest with no workspaceRoot is unchanged (unit-test and null-manifest callers)", () => {
    const result = resolveVerifier(ctx(["src/misc.ts"]), deps({ scripts: { test: "vitest run" } }))
    expect(result.matchedPaths).toEqual(["src/misc.ts"])
  })
})

// ===========================================================================
// FIX 1 — the prescription B-4 (a) unlocked was uncoverable in any repo that
// does not use npm. `resolve.ts` emits `npm run <script>` unconditionally
// (nothing in the manifest says which package manager the repo uses), and
// `coverage.ts` matched it only byte-identically, so `pnpm check` against a
// prescribed `npm run check` was a relevance gap — which `plugin.ts` folds into
// `success`, recording a passing verification as FAILED and minting no receipt.
// Before B-4 the same run minted one, because tier 3 returned null.
// ===========================================================================

describe("FIX 1: a widened prescription is coverable by the run a real repo makes", () => {
  function prescribeFor(scripts: Record<string, string>): string {
    const command = resolveVerifier(ctx(["src/games/memory.js"]), deps({ scripts })).command
    expect(command).not.toBeNull()
    return command!
  }

  it("THE FIELD CASE — `{check, dev}`, and the repo is a pnpm repo", () => {
    const prescribed = prescribeFor({ check: "tsc --noEmit && eslint .", dev: "vite" })
    expect(prescribed).toBe("npm run check")
    for (const observed of ["pnpm check", "pnpm run check", "yarn run check", "bun run check", "npm run check -s"]) {
      expect(observedCoversPrescribed(prescribed, observed), observed).toBe(true)
    }
  })

  it("the same holds for every widened script name, not just `check`", () => {
    expect(observedCoversPrescribed(prescribeFor({ build: "tsc" }), "pnpm build")).toBe(true)
    expect(observedCoversPrescribed(prescribeFor({ typecheck: "tsc --noEmit" }), "yarn typecheck")).toBe(true)
    expect(observedCoversPrescribed(prescribeFor({ verify: "make verify" }), "bun run verify")).toBe(true)
  })

  it("and the widening did NOT make a different script count (resolve<->coverage pairing intact)", () => {
    const prescribed = prescribeFor({ check: "tsc --noEmit", build: "tsc" })
    expect(observedCoversPrescribed(prescribed, "npm run build")).toBe(false)
    expect(observedCoversPrescribed(prescribed, "pnpm build")).toBe(false)
    expect(observedCoversPrescribed(prescribed, "npm test")).toBe(false)
    expect(observedCoversPrescribed(prescribed, "npm ci")).toBe(false)
  })

  it("a workspace-scoped prescription is covered by the `cd` spelling of the same run", () => {
    const prescribed = resolveVerifier(
      ctx(["packages/api/src/h.ts"]),
      deps({ scripts: {}, workspaces: [{ root: "packages/api", scripts: { check: "tsc --noEmit" } }] }),
    ).command!
    expect(prescribed).toBe("npm run check -w packages/api")
    expect(observedCoversPrescribed(prescribed, "cd packages/api && pnpm check")).toBe(true)
    // ...and a root-level run of the same script still does not count.
    expect(observedCoversPrescribed(prescribed, "npm run check")).toBe(false)
  })
})

// ===========================================================================
// FIX 2 — precedence. `resolvePackageScript` picked the WORKSPACE first and the
// script second, so a nested package's weakest script beat the root's strongest.
// ===========================================================================

describe("FIX 2: cross-manifest script QUALITY breaks the nearest-manifest tie", () => {
  it("REGRESSION — a nested `build` no longer beats the root's `test`", () => {
    const result = resolveVerifier(
      ctx(["packages/api/src/h.ts"]),
      deps({
        scripts: { test: "vitest run" },
        workspaces: [{ root: "packages/api", scripts: { build: "tsc -p ." } }],
      }),
    )
    // Pre-B-4 this repo prescribed `npm test`; B-4 downgraded it to
    // `npm run build -w packages/api`, which a root `npm test` cannot cover.
    expect(result.command).toBe("npm test")
    expect(observedCoversPrescribed(result.command!, "npm test")).toBe(true)
  })

  it.each([
    ["lint", { lint: "eslint ." }],
    ["typecheck", { typecheck: "tsc --noEmit" }],
    ["build", { build: "tsc -p ." }],
  ])("a nested `%s` (static-only) loses to a root `test`", (_name, nested) => {
    const result = resolveVerifier(
      ctx(["packages/api/src/h.ts"]),
      deps({ scripts: { test: "vitest run" }, workspaces: [{ root: "packages/api", scripts: nested }] }),
    )
    expect(result.command).toBe("npm test")
  })

  it("a root `check` also outranks a nested static-only script", () => {
    const result = resolveVerifier(
      ctx(["packages/api/src/h.ts"]),
      deps({
        scripts: { check: "tsc --noEmit && vitest run" },
        workspaces: [{ root: "packages/api", scripts: { lint: "eslint ." } }],
      }),
    )
    expect(result.command).toBe("npm run check")
  })

  it("NEAREST STILL WINS at equal quality — dataset row 9 and B-4's nested `check` are unchanged", () => {
    const rowNine = resolveVerifier(
      ctx(["packages/api/src/h.ts"]),
      deps({
        scripts: { test: "vitest run" },
        workspaces: [{ root: "packages/api", scripts: { test: "vitest run" } }],
      }),
    )
    expect(rowNine.command).toBe("npm test -w packages/api")

    const nestedCheck = resolveVerifier(
      ctx(["packages/api/src/h.ts"]),
      deps({
        scripts: { test: "vitest run" },
        workspaces: [{ root: "packages/api", scripts: { check: "tsc --noEmit" } }],
      }),
    )
    expect(nestedCheck.command).toBe("npm run check -w packages/api")
  })

  it("nearest still wins between two static-only scripts (quality is a tie-break, not an override)", () => {
    const result = resolveVerifier(
      ctx(["packages/api/src/h.ts"]),
      deps({
        scripts: { build: "tsc -p ." },
        workspaces: [{ root: "packages/api", scripts: { lint: "eslint ." } }],
      }),
    )
    expect(result.command).toBe("npm run lint -w packages/api")
  })

  it("a root script never hijacks a path that is not under it — the root always contains every path", () => {
    // Discrimination: the winner must still be a workspace the path lives in.
    const result = resolveVerifier(
      ctx(["packages/api/src/h.ts"]),
      deps({
        scripts: {},
        workspaces: [
          { root: "packages/api", scripts: { build: "tsc -p ." } },
          { root: "packages/web", scripts: { test: "vitest run" } },
        ],
      }),
    )
    expect(result.command).toBe("npm run build -w packages/api")
  })
})

// ===========================================================================
// FIX 3 — the preference list is closed by NAME, and the BODY was unexamined.
// `{lint: "eslint --fix . && prettier --write ."}` resolved to `npm run lint`,
// which `findings.ts` renders as "Run `npm run lint` and cite its observed
// result" — the harness instructing the agent to rewrite the user's source as a
// side effect of verifying. Prescribing nothing is a survivable degrade
// (`resolution:none`, already logged); mutating the tree is not undoable.
// ===========================================================================

describe("FIX 3: a script that mutates the workspace is never prescribed", () => {
  it("THE CASE — `lint` writes back, so the next safe preference is used instead", () => {
    const result = resolveVerifier(
      ctx(["src/misc.ts"]),
      deps({ scripts: { lint: "eslint --fix . && prettier --write .", build: "tsc -p ." } }),
    )
    expect(result.command).toBe("npm run build")
  })

  it("THE OTHER CASE — a build that deploys is not a verifier", () => {
    const result = resolveVerifier(ctx(["src/misc.ts"]), deps({ scripts: { build: "rm -rf dist && ./deploy.sh" } }))
    expect(result).toEqual({ command: null, rationale: "none", matchedPaths: [] })
  })

  it.each([
    ["eslint write-back", "eslint --fix ."],
    ["prettier write-back", "prettier --write ."],
    ["black rewrites by default", "black ."],
    ["isort rewrites by default", "isort ."],
    ["cargo fmt rewrites by default", "cargo fmt"],
    ["go fmt rewrites by default", "go fmt ./..."],
    ["sed in place", "sed -i 's/a/b/' src/x.ts"],
    ["git history", "vitest run && git commit -am wip"],
    ["publishes", "npm publish"],
    ["deploys", "vite build && fly deploy"],
    ["pushes", "tsc && git push"],
    ["never exits (watch)", "vitest --watch"],
    ["never exits (dev server)", "vite dev"],
    ["never exits (nodemon)", "nodemon src/index.js"],
    ["deletes source", "rm -rf src && tsc"],
  ])("refuses to prescribe a `check` that %s", (_label, body) => {
    const result = resolveVerifier(ctx(["src/misc.ts"]), deps({ scripts: { check: body } }))
    expect(result.command).toBeNull()
  })

  it.each([
    ["a plain type check", "tsc --noEmit"],
    ["a lint that only reports", "eslint ."],
    ["a formatter in --check mode", "prettier --check . && eslint ."],
    ["cargo fmt --check", "cargo fmt --check"],
    ["a build that cleans its own output", "rm -rf dist && tsc -p ."],
    ["a build that cleans a glob under dist", "rm -rf dist/* && tsc -p ."],
    ["a build that copies into dist", "tsc -p . && cp scripts/plugin.cjs dist/plugin.cjs"],
  ])("still prescribes a `check` that is %s (discrimination)", (_label, body) => {
    const result = resolveVerifier(ctx(["src/misc.ts"]), deps({ scripts: { check: body } }))
    expect(result.command).toBe("npm run check")
  })

  it("still prescribes an aggregate whose PARTS are all safe (discrimination, transitively)", () => {
    // Was `{check: "npm run lint && npm run typecheck"}` with neither part
    // declared, i.e. two unresolvable references. Since FIX 1 chases references,
    // the fixture has to be a real package.json for the assertion to mean
    // anything — and now it proves the walk ACCEPTS a safe chain, not just that
    // it rejects an unsafe one.
    const result = resolveVerifier(
      ctx(["src/misc.ts"]),
      deps({ scripts: { check: "npm run lint && npm run typecheck", lint: "eslint .", typecheck: "tsc --noEmit" } }),
    )
    expect(result.command).toBe("npm run check")
  })

  it("an unsafe script in a NESTED workspace does not win over a safe root one", () => {
    const result = resolveVerifier(
      ctx(["packages/api/src/h.ts"]),
      deps({
        scripts: { check: "tsc --noEmit" },
        workspaces: [{ root: "packages/api", scripts: { check: "eslint --fix ." } }],
      }),
    )
    expect(result.command).toBe("npm run check")
  })

  it("a blank body is still not a verifier (the original rule survives)", () => {
    expect(resolveVerifier(ctx(["src/misc.ts"]), deps({ scripts: { check: "   " } })).command).toBeNull()
  })
})

// ===========================================================================
// FIX 4 — this module's documented precondition ("changedPaths are already
// filtered to inside the worktree by the caller") was FALSE:
// `index.ts:changedPathsFromTool` records opencode's raw `filePath` and nothing
// between there and here compares it to the worktree. So an outside path reached
// `normalizeChangedPath`'s marker heuristic, which hunts for `/<root>/` anywhere
// in the string — resurrecting, from another repo, the exact mis-scoping bug
// B-4 (c) killed.
// ===========================================================================

describe("FIX 4: the worktree bound is enforced here, not assumed of the caller", () => {
  it("KILLER — a path in ANOTHER repo is not scoped into this repo's workspace", () => {
    const result = resolveVerifier(
      ctx(["/home/dev/other/packages/api/x.ts"]),
      deps({
        scripts: { test: "vitest run" },
        workspaceRoot: "/work/monorepo",
        workspaces: [{ root: "packages/api", scripts: { check: "tsc --noEmit" } }],
      }),
    )
    expect(result.command).not.toBe("npm run check -w packages/api")
    expect(result).toEqual({ command: null, rationale: "none", matchedPaths: [] })
  })

  it("KILLER — an outside Go path is not scoped into a same-named project root", () => {
    const result = resolveVerifier(
      ctx(["/elsewhere/services/api/main.go"]),
      deps({
        scripts: {},
        workspaceRoot: "/work/monorepo",
        projectRoots: [{ ecosystem: "go", root: "services/api" }],
      }),
    )
    expect(result.command).toBeNull()
  })

  it("an outside path is dropped from a MIXED set, and the inside ones still resolve", () => {
    const result = resolveVerifier(
      ctx(["/work/monorepo/src/a.ts", "/home/dev/other/src/b.ts"]),
      deps({ scripts: { test: "vitest run" }, workspaceRoot: "/work/monorepo" }),
    )
    expect(result.command).toBe("npm test")
    expect(result.matchedPaths).toEqual(["src/a.ts"])
  })

  it("REGRESSION — a story's OWN verifiers survive the bound; only INFERENCE is bounded", () => {
    // The previous wave put the filter ahead of tier 1, so a turn whose every
    // changed path arrived absolute-and-outside threw away the plan's declared
    // verifiers and degraded to `resolution:none` — swapping the strongest
    // prescription this module has for the weakest. The bound exists to stop an
    // outside path being INFERRED into a command; a declared verifier is not
    // inferred from anything.
    const result = resolveVerifier(
      ctx(["/home/dev/other/x.ts"], ["npm test"]),
      deps({ scripts: {}, workspaceRoot: "/work/monorepo" }),
    )
    expect(result.command).toBe("npm test")
    expect(result.rationale).toBe("story")
    // ...and the bound still governs what is REPORTED as covered.
    expect(result.matchedPaths).toEqual([])
  })

  it("...while INFERENCE from the same outside path is still refused", () => {
    // The other half of the same assertion: with no story to defer to, the
    // outside path resolves to nothing at all.
    const result = resolveVerifier(
      ctx(["/home/dev/other/x.ts"]),
      deps({ scripts: { test: "vitest run" }, workspaceRoot: "/work/monorepo" }),
    )
    expect(result).toEqual({ command: null, rationale: "none", matchedPaths: [] })
  })

  it("INSIDE paths are untouched — the filter is a bound, not a narrowing", () => {
    const result = resolveVerifier(
      ctx(["/work/monorepo/packages/api/src/h.ts"]),
      deps({
        scripts: { test: "vitest run" },
        workspaceRoot: "/work/monorepo",
        workspaces: [{ root: "packages/api", scripts: { test: "vitest run" } }],
      }),
    )
    expect(result.command).toBe("npm test -w packages/api")
    expect(result.matchedPaths).toEqual(["packages/api/src/h.ts"])
  })

  it("a SECOND spelling of the root is inside it — one directory, two true names", () => {
    // The session was opened through a symlink; the tool reports the realpath
    // (or the other way round). Without the alias, FIX 4's bound would push
    // every changed path out of the worktree and take the session with it.
    const result = resolveVerifier(
      ctx(["/link/app/src/x.ts"]),
      deps({ scripts: { test: "vitest run" }, workspaceRoot: "/real/app", workspaceRootAliases: ["/link/app"] }),
    )
    expect(result.command).toBe("npm test")
    expect(result.matchedPaths).toEqual(["src/x.ts"])
  })

  it("...and an alias widens nothing else — an unrelated path is still outside", () => {
    const result = resolveVerifier(
      ctx(["/home/dev/other/src/x.ts"]),
      deps({ scripts: { test: "vitest run" }, workspaceRoot: "/real/app", workspaceRootAliases: ["/link/app"] }),
    )
    expect(result).toEqual({ command: null, rationale: "none", matchedPaths: [] })
  })

  it("with NO workspaceRoot the module cannot judge and keeps every path (fail open, as before)", () => {
    const result = resolveVerifier(ctx(["/tmp/elsewhere/x.ts"]), deps({ scripts: { test: "vitest run" } }))
    expect(result.command).toBe("npm test")
    expect(result.matchedPaths).toEqual(["/tmp/elsewhere/x.ts"])
  })

  it("a relative path is never judged outside, whatever the root is", () => {
    const result = resolveVerifier(
      ctx(["src/misc.ts"]),
      deps({ scripts: { test: "vitest run" }, workspaceRoot: "/work/monorepo" }),
    )
    expect(result.command).toBe("npm test")
  })
})

describe("classifyPathEcosystem", () => {
  it("classifies by extension", () => {
    expect(classifyPathEcosystem("internal/auth/service.go")).toBe("go")
    expect(classifyPathEcosystem("app/models.py")).toBe("python")
    expect(classifyPathEcosystem("src/lib.rs")).toBe("rust")
    expect(classifyPathEcosystem("src/app.ts")).toBe("node")
    expect(classifyPathEcosystem("src/app.tsx")).toBe("node")
    expect(classifyPathEcosystem("scripts/build.mjs")).toBe("node")
  })

  it("classifies manifest files by NAME, so a shared .toml suffix never decides", () => {
    expect(classifyPathEcosystem("Cargo.toml")).toBe("rust")
    expect(classifyPathEcosystem("services/ml/pyproject.toml")).toBe("python")
    expect(classifyPathEcosystem("go.mod")).toBe("go")
    expect(classifyPathEcosystem("package.json")).toBe("node")
    expect(classifyPathEcosystem("setup.cfg")).toBe("python")
  })

  it("returns null for anything that does not name an ecosystem", () => {
    expect(classifyPathEcosystem("db/schema.sql")).toBeNull()
    expect(classifyPathEcosystem("Dockerfile")).toBeNull()
    expect(classifyPathEcosystem("config/app.yaml")).toBeNull()
    expect(classifyPathEcosystem("netlify.toml")).toBeNull()
  })
})

// ===========================================================================
// END TO END, on a REAL temp repo, through the REAL manifest reader.
//
// Each unit above can be green while the seam is broken — that is exactly how
// B-4 shipped a prescription that `coverage.ts` could not match. These drive
// `buildManifest` (real fs) -> `resolveVerifier` -> `observedCoversPrescribed`,
// with changed paths spelled the way `changedPathsFromTool` actually spells them
// (absolute), and ask the only question that matters at the plugin boundary:
// would the command an agent really runs in this repo mint a receipt?
// ===========================================================================

describe("E2E (real temp repo): the prescription a repo gets is one its agent can satisfy", () => {
  const roots: string[] = []

  afterEach(() => {
    while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
  })

  function repo(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "vertex-resolve-e2e-"))
    roots.push(root)
    for (const [rel, body] of Object.entries(files)) {
      const full = join(root, rel)
      mkdirSync(join(full, ".."), { recursive: true })
      writeFileSync(full, body)
    }
    return root
  }

  function prescribe(root: string, changed: string[], manifestRoot = root): string | null {
    const manifest = buildManifest(manifestRoot)
    return resolveVerifier(
      { changedPaths: changed.map((rel) => join(root, rel)), storyVerifiers: null },
      { readManifest: () => manifest },
    ).command
  }

  it("FIX 1 REGRESSION — the measured `{check, dev}` repo, verified with pnpm/yarn/bun", () => {
    const root = repo({
      "package.json": '{"name":"neon-arcade","scripts":{"check":"tsc --noEmit","dev":"vite"}}',
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      "index.html": "<!doctype html>",
      "src/games/memory.js": "export const memory = 1\n",
    })

    const prescribed = prescribe(root, ["src/games/memory.js", "index.html"])
    expect(prescribed).toBe("npm run check")

    // The whole point: the run this repo's agent actually makes must COUNT.
    // Each of these scored as a relevance gap before FIX 1, which suppressed the
    // receipt AND recorded the passing command as a failed verification.
    for (const observed of [
      "npm run check",
      "pnpm check",
      "pnpm run check",
      "yarn run check",
      "bun run check",
      "npm run check --silent",
      "pnpm -w run check",
      "pnpm check 2>&1 | tail -20",
    ]) {
      expect(observedCoversPrescribed(prescribed!, observed, root), observed).toBe(true)
    }

    // ...and running something else still does not count.
    for (const observed of ["npm run dev", "npm test", "npx vitest run", "npm ci"]) {
      expect(observedCoversPrescribed(prescribed!, observed, root), observed).toBe(false)
    }
  })

  it("FIX 2 REGRESSION — a real monorepo whose nested package only builds", () => {
    const root = repo({
      "package.json": '{"name":"root","workspaces":["packages/*"],"scripts":{"test":"vitest run"}}',
      "packages/api/package.json": '{"name":"api","scripts":{"build":"tsc -p ."}}',
      "packages/api/src/h.ts": "export const h = 1\n",
    })

    const prescribed = prescribe(root, ["packages/api/src/h.ts"])
    // B-4 prescribed `npm run build -w packages/api` here, which the root suite
    // could not cover; pre-B-4 it prescribed `npm test`, which it can.
    expect(prescribed).toBe("npm test")
    expect(observedCoversPrescribed(prescribed!, "npm test", root)).toBe(true)
    expect(observedCoversPrescribed(prescribed!, "pnpm test", root)).toBe(true)
  })

  it("FIX 2/1 together — a nested package with its own tests keeps the narrower prescription", () => {
    const root = repo({
      "package.json": '{"name":"root","workspaces":["packages/*"],"scripts":{"test":"vitest run"}}',
      "packages/api/package.json": '{"name":"api","scripts":{"test":"vitest run"}}',
      "packages/api/src/h.ts": "export const h = 1\n",
    })

    const prescribed = prescribe(root, ["packages/api/src/h.ts"])
    expect(prescribed).toBe("npm test -w packages/api")
    expect(observedCoversPrescribed(prescribed!, "cd packages/api && npm test", root)).toBe(true)
    expect(observedCoversPrescribed(prescribed!, "npm test", root)).toBe(false)
  })

  it("FIX 3 — a real package.json whose only scripts mutate resolves to nothing at all", () => {
    const root = repo({
      "package.json": '{"name":"x","scripts":{"lint":"eslint --fix .","build":"tsc && npm publish"}}',
      "src/app.ts": "export const a = 1\n",
    })
    expect(prescribe(root, ["src/app.ts"])).toBeNull()
  })

  it("FIX 4 — a SYMLINKED workspace root still resolves, in EITHER spelling", () => {
    const root = repo({
      "package.json": '{"name":"x","scripts":{"check":"tsc --noEmit"}}',
      "src/app.ts": "export const a = 1\n",
    })
    const link = `${root}-link`
    symlinkSync(root, link)
    roots.push(link)

    // The session is rooted at the SYMLINK. A changed path may arrive as the
    // REALPATH (what opencode's tools report) or through the link (what the
    // agent typed). Both name the same file, and FIX 4's worktree bound must not
    // turn a spelling mismatch into `resolution:none` for the whole session.
    expect(prescribe(root, ["src/app.ts"], link)).toBe("npm run check")
    expect(prescribe(link, ["src/app.ts"], link)).toBe("npm run check")
  })

  it("FIX 4 — a real path from ANOTHER repo prescribes nothing for this one", () => {
    const root = repo({
      "package.json": '{"name":"root","workspaces":["packages/*"],"scripts":{"test":"vitest run"}}',
      "packages/api/package.json": '{"name":"api","scripts":{"check":"tsc -p ."}}',
    })
    const other = repo({ "packages/api/x.ts": "export const x = 1\n" })

    const manifest = buildManifest(root)
    const result = resolveVerifier(
      { changedPaths: [join(other, "packages/api/x.ts")], storyVerifiers: null },
      { readManifest: () => manifest },
    )
    expect(result).toEqual({ command: null, rationale: "none", matchedPaths: [] })
  })
})

// ===========================================================================
// FIX 1 (this wave) — the write-back control was bypassed by ONE hop.
//
// `preferredScript` inspected only the NAMED script's own body, and the
// commonest aggregate-script shape in the wild puts the dangerous half one
// reference away. The harness prescribed `npm run check` for
// `{check: "npm run lint:fix && vitest run", "lint:fix": "eslint --fix ."}`,
// i.e. it told the agent to rewrite the user's tree as a verification step —
// the exact instruction the control exists to never give.
// ===========================================================================

/** The command a repo with exactly these scripts is prescribed for a plain source change. */
function prescribeFor(scripts: Record<string, string>): string | null {
  return resolveVerifier(ctx(["src/misc.ts"]), deps({ scripts })).command
}

describe("FIX 1: script references are resolved transitively", () => {
  it("KILLER — `check` is clean, the script it calls rewrites the tree", () => {
    expect(prescribeFor({ check: "npm run lint:fix && vitest run", "lint:fix": "eslint --fix ." })).toBeNull()
  })

  it("KILLER — and the fall-through still finds the next SAFE preference", () => {
    expect(
      prescribeFor({
        check: "npm run lint:fix && vitest run",
        "lint:fix": "eslint --fix .",
        build: "tsc -p .",
      }),
    ).toBe("npm run build")
  })

  it.each([
    ["npm run", "npm run fixit"],
    ["pnpm run", "pnpm run fixit"],
    ["yarn run", "yarn run fixit"],
    ["bun run", "bun run fixit"],
    ["a bare `<pm> <script>`", "pnpm fixit"],
    ["a pnpm workspace-root run", "pnpm -w run fixit"],
    ["npm-run-all", "npm-run-all fixit"],
    ["npm-run-all2", "npm-run-all2 fixit"],
    ["run-s", "run-s fixit"],
    ["run-p", "run-p fixit"],
    ["run-series", "run-series fixit"],
    ["run-parallel", "run-parallel fixit"],
    ["npm-run-all with flags", "npm-run-all -p -c fixit"],
    ["a reference in the SECOND segment", "tsc --noEmit && run-s fixit"],
  ])("follows %s to the script that writes back", (_label, body) => {
    expect(prescribeFor({ check: body, fixit: "eslint --fix ." })).toBeNull()
    // ...and the same shape pointing at a SAFE script is still prescribed, so
    // the assertion above is about the reference and not about the spelling.
    expect(prescribeFor({ check: body, fixit: "tsc --noEmit" })).toBe("npm run check")
  })

  it("expands an `npm-run-all` glob against the manifest's own keys", () => {
    expect(prescribeFor({ check: "npm-run-all lint:*", "lint:js": "eslint --fix ." })).toBeNull()
    expect(prescribeFor({ check: "npm-run-all lint:*", "lint:js": "eslint ." })).toBe("npm run check")
    // A glob matching NOTHING is a reference that cannot be resolved.
    expect(prescribeFor({ check: "npm-run-all lint:*" })).toBeNull()
  })

  it("an UNRESOLVABLE reference is unknown, and unknown is unsafe", () => {
    expect(prescribeFor({ check: "npm run lint && vitest run" })).toBeNull()
  })

  it("a package manager's own SUBCOMMAND is not an unresolvable script", () => {
    // `npm ci` is not `scripts.ci`; refusing it as "unknown" would be a false
    // positive on an extremely ordinary body.
    expect(prescribeFor({ check: "npm ci && vitest run" })).toBe("npm run check")
  })

  it("DEPTH — a chain 8 references deep is still inspected, and 9 is refused as pathological", () => {
    const chain = (length: number, tail: string): Record<string, string> => {
      const scripts: Record<string, string> = { check: "npm run s1" }
      for (let index = 1; index < length; index++) scripts[`s${index}`] = `npm run s${index + 1}`
      scripts[`s${length}`] = tail
      return scripts
    }
    // 8 hops, all safe -> prescribed. 8 hops ending in a write-back -> refused,
    // which is the half that proves the walk actually reached the bottom.
    expect(prescribeFor(chain(8, "tsc --noEmit"))).toBe("npm run check")
    expect(prescribeFor(chain(8, "eslint --fix ."))).toBeNull()
    // 9 hops is past the bound: unknown, therefore unsafe, even though the
    // bottom of this particular chain is harmless.
    expect(prescribeFor(chain(9, "tsc --noEmit"))).toBeNull()
  })

  it("a CYCLE is unsafe on its own merits — running it never returns", () => {
    expect(prescribeFor({ check: "npm run a", a: "npm run check" })).toBeNull()
    expect(prescribeFor({ check: "npm run a", a: "npm run b", b: "npm run a" })).toBeNull()
  })

  it("a DIAMOND is not exponential and is still judged on its parts", () => {
    expect(
      prescribeFor({ check: "run-s left right", left: "npm run leaf", right: "npm run leaf", leaf: "tsc --noEmit" }),
    ).toBe("npm run check")
    expect(
      prescribeFor({
        check: "run-s left right",
        left: "npm run leaf",
        right: "npm run leaf",
        leaf: "prettier --write .",
      }),
    ).toBeNull()
  })
})

describe("FIX 1: a script that shells out to an opaque FILE is unknown, not safe", () => {
  it.each([
    ["bash", "bash scripts/fix-all"],
    ["sh", "sh scripts/fix-all"],
    ["zsh", "zsh scripts/fix-all"],
    ["dash", "dash scripts/fix-all"],
    ["ksh", "ksh scripts/fix-all"],
    ["fish", "fish scripts/fix-all"],
    ["a `.sh` entry point", "scripts/ci.sh"],
    ["an executable relative path", "./scripts/ci"],
    ["an executable parent path", "../scripts/ci"],
    ["an absolute path", "/opt/ci/run"],
  ])("refuses to prescribe a `check` that runs %s", (_label, body) => {
    expect(prescribeFor({ check: body })).toBeNull()
  })

  it("...but an INLINE `bash -c` command is fully visible and is judged on its text", () => {
    expect(prescribeFor({ check: 'bash -c "eslint ."' })).toBe("npm run check")
    expect(prescribeFor({ check: 'bash -lc "eslint ."' })).toBe("npm run check")
    expect(prescribeFor({ check: 'bash -c "eslint --fix ."' })).toBeNull()
  })

  it("...and a spelled-out node_modules binary is a program, not a project script", () => {
    expect(prescribeFor({ check: "./node_modules/.bin/vitest run" })).toBe("npm run check")
  })

  it("WHERE THE LINE IS — an interpreter running a program file is NOT opaque", () => {
    // Refusing every `node scripts/x.mjs` would refuse this repo's own
    // `node scripts/uat-harness.mjs` and re-open the `resolution:none`
    // starvation that widening tier 3 exists to fix. A SHELL script is
    // different in kind: running other commands is its entire job.
    expect(prescribeFor({ check: "node scripts/verify.mjs" })).toBe("npm run check")
    expect(prescribeFor({ check: "python scripts/check.py" })).toBe("npm run check")
  })
})

// ===========================================================================
// FIX 2 — write-back spellings the detector missed, and one it got backwards.
// ===========================================================================

describe("FIX 2: the write-back detector is tool-aware", () => {
  it.each([
    ["prettier's `-w` shorthand", "prettier -w ."],
    ["prettier's `-w` behind npx", "npx prettier -w src"],
    ["biome's --apply", "biome check --apply"],
    ["biome's --apply-unsafe", "biome check --apply-unsafe"],
    ["biome's --unsafe-apply", "biome check --unsafe-apply"],
    ["jest's -u", "jest -u"],
    ["jest --updateSnapshot", "jest --updateSnapshot"],
    ["vitest run -u", "vitest run -u"],
    ["vitest --update", "vitest run --update"],
    ["ava -u", "ava -u"],
    ["cargo insta --accept", "cargo insta --accept"],
    ["--update-snapshot", "vitest run --update-snapshot"],
    ["--updateSnapshots", "vitest run --updateSnapshots"],
    ["--update-snapshots", "vitest run --update-snapshots"],
    ["--snapshot-update", "pytest --snapshot-update"],
    ["--in-place", "taplo format --in-place"],
    ["eslint --fix", "eslint --fix ."],
    ["prettier --write", "prettier --write ."],
    ["sed -i", "sed -i s/a/b/ src/x.ts"],
    ["sed -ri", "sed -ri s/a/b/ src/x.ts"],
    ["perl -pi", "perl -pi -e s/a/b/ src/x.ts"],
  ])("refuses a `check` that rewrites via %s", (_label, body) => {
    expect(isUnsafeScriptBody(body)).toBe(true)
    expect(prescribeFor({ check: body })).toBeNull()
  })

  it("KILLER — `-l` is LINE LENGTH for black/isort/rustfmt, not `--list-different`", () => {
    // Listing `-l` as a read-only format flag made every one of these score
    // SAFE while rewriting every file it touched.
    for (const body of ["black -l 100 .", "isort -l 100 .", "cargo fmt -l", "rustfmt -l 100 src/lib.rs"]) {
      expect(isUnsafeScriptBody(body), body).toBe(true)
    }
  })

  it("`-w` and `-u` stay harmless for the tools where they mean something else", () => {
    // `-w` is jest/vitest's worker count and npm's workspace selector; `-u` is
    // nothing in particular outside a snapshot runner. Over-refusal here is how
    // `resolution:none` starvation comes back.
    for (const body of ["jest -w 4", "vitest run -w 2", "tsc --noEmit -u"]) {
      expect(isUnsafeScriptBody(body), body).toBe(false)
    }
  })

  it.each([
    ["black", "black ."],
    ["isort", "isort ."],
    ["rustfmt", "rustfmt src/lib.rs"],
    ["autopep8", "autopep8 src/x.py"],
    ["yapf", "yapf src/x.py"],
    ["gofmt", "gofmt src/x.go"],
    ["ruff format", "ruff format ."],
    ["dprint fmt", "dprint fmt"],
    ["cargo fmt", "cargo fmt"],
    ["go fmt", "go fmt ./..."],
  ])("%s rewrites by default and is refused", (_label, body) => {
    expect(isUnsafeScriptBody(body)).toBe(true)
  })

  it.each([["--check"], ["--check-only"], ["--diff"], ["--dry-run"], ["--list-different"]])(
    "%s turns a default-writing formatter back into a reporter",
    (flag) => {
      // The read-only table is deliberately tool-agnostic (a formatter added to
      // the table later inherits it), so each entry is pinned the same way.
      expect(isUnsafeScriptBody(`black ${flag} .`)).toBe(false)
    },
  )
})

// ===========================================================================
// FIX 5 — the effectful-command check matched SUBSTRINGS OF ARGUMENTS, so
// perfectly ordinary test invocations were refused and the repo fell back to
// reciting a category list.
// ===========================================================================

describe("FIX 5: effectful COMMANDS are refused, arguments that merely contain the word are not", () => {
  it.each([
    ["a test file named after publishing", "vitest run src/publish.test.ts"],
    ["a vitest project named release", "vitest run --project release"],
    ["a jest pattern naming deploy", "jest --testPathPattern 'deploy'"],
    ["a pytest expression excluding release", "python -m pytest -k 'not release'"],
    ["a node script named verify-release", "node scripts/verify-release.mjs"],
    ["a deselecting pytest marker", "pytest -m 'not upload'"],
    ["a test directory named deploy", "vitest run tests/deploy"],
  ])("still prescribes %s", (_label, body) => {
    expect(isUnsafeScriptBody(body)).toBe(false)
    expect(prescribeFor({ check: body })).toBe("npm run check")
  })

  it.each([
    ["deploy", "fly deploy"],
    ["publish", "wrangler publish"],
    ["release", "gh release create"],
    ["upload", "twine upload dist/x"],
    ["push", "docker push myimage"],
    ["semantic-release", "semantic-release"],
    ["deploy behind npx", "npx wrangler deploy"],
    ["deploy in the second segment", "tsc --noEmit && fly deploy"],
  ])("refuses the effectful command word %s", (_label, body) => {
    expect(isUnsafeScriptBody(body)).toBe(true)
  })

  it.each([
    "commit",
    "push",
    "add",
    "checkout",
    "switch",
    "reset",
    "clean",
    "rebase",
    "merge",
    "tag",
    "stash",
  ])("refuses `git %s`", (subcommand) => {
    expect(isUnsafeScriptBody(`tsc --noEmit && git ${subcommand} .`)).toBe(true)
    // A READ-ONLY git subcommand is not refused, so the assertion above is
    // about the subcommand and not about the word "git".
    expect(isUnsafeScriptBody("tsc --noEmit && git status")).toBe(false)
  })
})

describe("never-exiting shapes (each blocklist entry pinned)", () => {
  it.each([["--watch"], ["--watchAll"], ["--watch-all"], ["--hot"]])("%s never returns", (flag) => {
    expect(isUnsafeScriptBody(`vitest run ${flag}`)).toBe(true)
  })

  it("`--watch=false` is the CI spelling and exits like anything else", () => {
    expect(isUnsafeScriptBody("vitest --watch=false")).toBe(false)
  })

  it.each([
    "nodemon src/index.js",
    "watchexec tsc",
    "http-server dist",
    "live-server dist",
    "serve dist",
    "vite dev",
    "vite serve",
    "webpack dev",
    "webpack serve",
    "snowpack dev",
    "snowpack serve",
    "next dev",
    "nuxt dev",
    "astro dev",
    "remix dev",
    "gatsby dev",
  ])("`%s` starts a long-running process", (body) => {
    expect(isUnsafeScriptBody(body)).toBe(true)
  })
})

describe("`rm` operands (each generated-location entry pinned)", () => {
  it.each([
    "dist",
    "build",
    "out",
    "output",
    "es",
    "esm",
    "cjs",
    "coverage",
    "target",
    "tmp",
    "temp",
    "node_modules",
    ".next",
    ".nuxt",
    ".turbo",
    ".cache",
    ".svelte-kit",
    ".parcel-cache",
    ".vite",
    ".output",
  ])("a build may clean `%s`", (dir) => {
    expect(isUnsafeScriptBody(`rm -rf ${dir} && tsc --noEmit`)).toBe(false)
    expect(isUnsafeScriptBody(`rm -rf ./${dir}/inner && tsc --noEmit`)).toBe(false)
  })

  it("a build may clean its own .tsbuildinfo", () => {
    expect(isUnsafeScriptBody("rm -f tsconfig.tsbuildinfo && tsc --noEmit")).toBe(false)
  })

  it("KILLER — `lib/` is SOURCE in a large share of packages and is no longer a free target", () => {
    // Listing `lib` as a generated location had the harness prescribe a script
    // that deletes the user's source. A false positive costs one prescription;
    // this false negative costs the tree.
    expect(isUnsafeScriptBody("rm -rf lib && tsc -p .")).toBe(true)
    expect(isUnsafeScriptBody("rm -rf libs && tsc -p .")).toBe(true)
  })

  it.each([
    ["rm", "rm -rf src && tsc"],
    ["rmdir", "rmdir src && tsc"],
    ["rimraf", "rimraf src && tsc"],
    ["npx rimraf", "npx rimraf src && tsc"],
    ["shx rm (via the inner rm)", "shx rm -rf src && tsc"],
  ])("%s outside a generated location is refused", (_label, body) => {
    expect(isUnsafeScriptBody(body)).toBe(true)
  })

  it("...and the same wrappers cleaning a GENERATED location are still prescribed", () => {
    expect(isUnsafeScriptBody("shx rm -rf dist && tsc --noEmit")).toBe(false)
    expect(isUnsafeScriptBody("npx rimraf dist && tsc --noEmit")).toBe(false)
  })
})

describe("SCRIPT_QUALITY: which names outrank `nearest manifest wins` (sign-off EXTRA B)", () => {
  it.each([["test", "npm test"], ["check", "npm run check"], ["verify", "npm run verify"]])(
    "a root `%s` beats a nested `build`",
    (name, expected) => {
      // Quality 0 (runs the project's own assertions) overrules nearest-wins;
      // drop the entry and the nested static-only script takes the prescription.
      const result = resolveVerifier(
        ctx(["packages/api/src/h.ts"]),
        deps({
          scripts: { [name]: "vitest run" },
          workspaces: [{ root: "packages/api", scripts: { build: "tsc -p ." } }],
        }),
      )
      expect(result.command).toBe(expected)
    },
  )

  it("...while at EQUAL quality the nearest manifest still wins", () => {
    const result = resolveVerifier(
      ctx(["packages/api/src/h.ts"]),
      deps({
        scripts: { test: "vitest run" },
        workspaces: [{ root: "packages/api", scripts: { test: "vitest run" } }],
      }),
    )
    expect(result.command).toBe("npm test -w packages/api")
  })
})
