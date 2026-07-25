import { describe, expect, it, vi } from "vitest"
import type { Manifest, ResolveContext, ResolveDeps } from "../../src/v2/resolve.js"
import { resolveVerifier } from "../../src/v2/resolve.js"

/** Helper: build ResolveDeps from a fixed manifest (or null), with an optional fallbackProbe. */
function deps(manifest: Manifest | null, fallbackProbe?: (globs: string[]) => string[]): ResolveDeps {
  return { readManifest: () => manifest, fallbackProbe }
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

describe("FR-009: bounded fallback probe (caller-injected, never invoked unbounded by this module)", () => {
  it("is not called at all when an earlier tier already resolves", () => {
    const fallbackProbe = vi.fn(() => ["tests/never.test.ts"])
    const result = resolveVerifier(
      ctx(["src/lexer.ts"]),
      deps({ scripts: {}, testFiles: ["tests/lexer.test.ts"] }, fallbackProbe),
    )
    expect(result.rationale).toBe("basename")
    expect(fallbackProbe).not.toHaveBeenCalled()
  })

  it("is used as the last resort when static tiers are exhausted, and its matches resolve as basename", () => {
    const fallbackProbe = vi.fn((globs: string[]) => {
      expect(globs).toContain("**/x.test.*")
      expect(globs).toContain("**/x.spec.*")
      return ["live/x.test.ts"]
    })
    const result = resolveVerifier(ctx(["src/x.ts"]), deps({ scripts: {} }, fallbackProbe))
    expect(result).toEqual({
      command: "npx vitest run live/x.test.ts",
      rationale: "basename",
      matchedPaths: ["src/x.ts"],
    })
    expect(fallbackProbe).toHaveBeenCalledTimes(1)
  })

  it("degrades to none when fallbackProbe is provided but finds nothing", () => {
    const fallbackProbe = vi.fn(() => [] as string[])
    const result = resolveVerifier(ctx(["src/x.ts"]), deps({ scripts: {} }, fallbackProbe))
    expect(result).toEqual({ command: null, rationale: "none", matchedPaths: [] })
  })

  it("the degraded path remains correct without a fallbackProbe (FR-009: correctness never depends on it)", () => {
    const result = resolveVerifier(ctx(["src/x.ts"]), deps({ scripts: {} } /* no fallbackProbe */))
    expect(result).toEqual({ command: null, rationale: "none", matchedPaths: [] })
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
