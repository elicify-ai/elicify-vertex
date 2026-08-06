import { describe, expect, it } from "vitest"
import { observedCoversPrescribed } from "../../src/v2/coverage.js"
import type { Manifest, ResolveContext, ResolveDeps } from "../../src/v2/resolve.js"
import { classifyPathEcosystem, resolveVerifier } from "../../src/v2/resolve.js"

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

  it("row 10: outside-worktree exclusion — caller has already filtered the path out, changedPaths arrives empty", () => {
    // ResolveContext.changedPaths is documented as "already filtered to inside the
    // worktree by the caller" — `../outside/x.ts` never reaches resolveVerifier. This
    // test asserts the function behaves correctly given that already-filtered
    // (in this case empty) list: it must never fabricate a command for paths it never
    // saw, and must degrade cleanly to none so the caller can log resolution:none and
    // exclude the path from `Observed:`.
    const result = resolveVerifier(ctx([]), deps({ scripts: { test: "vitest run" } }))
    expect(result).toEqual({ command: null, rationale: "none", matchedPaths: [] })
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

  it("a path OUTSIDE the workspace root is left absolute — never silently rebased into the repo", () => {
    const result = resolveVerifier(
      ctx(["/tmp/elsewhere/x.ts"]),
      deps({ scripts: { test: "vitest run" }, workspaceRoot: "/work/app" }),
    )
    expect(result.matchedPaths).toEqual(["/tmp/elsewhere/x.ts"])
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
