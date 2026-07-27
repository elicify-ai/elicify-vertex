import { describe, expect, it } from "vitest"
import {
  observedCoversPrescribed,
  parseSubcommands,
  runnerEquivalent,
  subCommandCovers,
  targetCovers,
  targetsCover,
  WHOLE_SUITE_ALIASES,
} from "../../src/v2/coverage.js"

// ---------------------------------------------------------------------------
// FR-033 / FR-034 / FR-035 / FR-036 — the spec's Examples table, verbatim.
// (Test ids 43/44/45: covering_verifier_not_a_gap, subset_verifier_is_a_gap,
// whole_suite_command_covers_narrower.)
// ---------------------------------------------------------------------------

describe("covering_verifier_not_a_gap (Scenario Outline: A covering verifier is not a relevance gap)", () => {
  it("row 1: recursive superset — `go test ./...` covers `go test ./internal/auth/...`", () => {
    expect(observedCoversPrescribed("go test ./internal/auth/...", "go test ./...")).toBe(true)
  })

  it("row 2: the real field case — whole-suite test + build covers two narrow tests", () => {
    expect(
      observedCoversPrescribed(
        "go test ./internal/a/... && go test ./internal/b/...",
        "go build ./... && go test ./... -count=1",
      ),
    ).toBe(true)
  })

  it("row 2 (extended field case): a prescribed `go build ./...` is covered by the observed build, with redirection noise", () => {
    expect(
      observedCoversPrescribed(
        "go test ./internal/a/... && go test ./internal/b/... && go build ./...",
        "go build ./... && go test ./... -count=1 2>&1",
      ),
    ).toBe(true)
  })

  it("row 3: whole-suite command — `npm test` covers `npx vitest run tests/lexer.test.ts`", () => {
    expect(observedCoversPrescribed("npx vitest run tests/lexer.test.ts", "npm test")).toBe(true)
  })

  it("row 4: identical commands cover", () => {
    expect(
      observedCoversPrescribed("npx vitest run tests/lexer.test.ts", "npx vitest run tests/lexer.test.ts"),
    ).toBe(true)
  })

  it("row 5: observed is a strict subset — `go test ./internal/auth/...` does NOT cover `go test ./...`", () => {
    expect(observedCoversPrescribed("go test ./...", "go test ./internal/auth/...")).toBe(false)
  })

  it("row 6: disjoint targets — `go test ./internal/b/...` does NOT cover `go test ./internal/a/...`", () => {
    expect(observedCoversPrescribed("go test ./internal/a/...", "go test ./internal/b/...")).toBe(false)
  })

  it("row 7: unrelated toolchain — `cargo build` does NOT cover `go test ./internal/a/...`", () => {
    expect(observedCoversPrescribed("go test ./internal/a/...", "cargo build")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// FR-036 — building is not testing. The single most important non-equivalence.
// ---------------------------------------------------------------------------

describe("go build never covers go test (FR-036)", () => {
  it("`go build ./...` does NOT cover a prescribed `go test ./x/...`, however broad its target", () => {
    expect(observedCoversPrescribed("go test ./x/...", "go build ./...")).toBe(false)
  })

  it("nor does a bare `go build` with no targets at all", () => {
    expect(observedCoversPrescribed("go test ./x/...", "go build")).toBe(false)
  })

  it("but `go build ./...` does cover a prescribed `go build ./x/...` (same runner, broader target)", () => {
    expect(observedCoversPrescribed("go build ./x/...", "go build ./...")).toBe(true)
  })

  it("and `go test` is not runner-equivalent to `go build` at the runner level either", () => {
    expect(runnerEquivalent("go build", "go test")).toBe(false)
    expect(runnerEquivalent("go test", "go build")).toBe(false)
  })

  it("no WHOLE_SUITE_ALIASES entry groups `go build` with `go test`", () => {
    for (const group of WHOLE_SUITE_ALIASES) {
      const hasBuild = group.includes("go build")
      const hasTest = group.includes("go test")
      expect(hasBuild && hasTest).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// FR-036a — compound commands, redirections, pipes.
// ---------------------------------------------------------------------------

describe("FR-036a: pipelines, redirections and compound separators", () => {
  it("a piped observed command still covers a narrower prescribed one", () => {
    expect(observedCoversPrescribed("go test ./internal/auth/...", "go test ./... | tail -50")).toBe(true)
  })

  it("piping does not launder a narrower observed command into a covering one", () => {
    expect(observedCoversPrescribed("go test ./...", "go test ./internal/a/... | tail -50")).toBe(false)
  })

  it("`||` splits into sub-commands rather than being read as a pipe", () => {
    expect(parseSubcommands("npm run lint || npm test")).toEqual([
      { runner: "npm run lint", targets: [], narrowing: [], nonExecuting: false },
      { runner: "npm test", targets: [], narrowing: [], nonExecuting: false },
    ])
  })

  it("`;` splits into sub-commands", () => {
    expect(parseSubcommands("npm test; npx vitest run tests/a.test.ts")).toEqual([
      { runner: "npm test", targets: [], narrowing: [], nonExecuting: false },
      { runner: "npx vitest run", targets: ["tests/a.test.ts"], narrowing: [], nonExecuting: false },
    ])
  })

  it("`&&` splits, redirections and unlisted flags are stripped from targets", () => {
    expect(parseSubcommands("go build ./... && go test ./... -count=1 2>&1")).toEqual([
      { runner: "go build", targets: ["./..."], narrowing: [], nonExecuting: false },
      { runner: "go test", targets: ["./..."], narrowing: [], nonExecuting: false },
    ])
  })

  it("a bare redirection operator also consumes its filename", () => {
    expect(parseSubcommands("go test ./... > /dev/null")).toEqual([{ runner: "go test", targets: ["./..."], narrowing: [], nonExecuting: false }])
    expect(parseSubcommands("go test ./... 2> errors.log")).toEqual([{ runner: "go test", targets: ["./..."], narrowing: [], nonExecuting: false }])
  })

  it("only the head of a pipeline survives", () => {
    expect(parseSubcommands("go test ./... | tail -50")).toEqual([{ runner: "go test", targets: ["./..."], narrowing: [], nonExecuting: false }])
  })

  it("leading environment assignments are shell plumbing, not runner words", () => {
    expect(parseSubcommands("CI=1 GOFLAGS=-mod=mod go test ./...")).toEqual([
      { runner: "go test", targets: ["./..."], narrowing: [], nonExecuting: false },
    ])
    expect(observedCoversPrescribed("go test ./internal/auth/...", "CI=1 go test ./...")).toBe(true)
  })

  it("runners normalise case and collapsed whitespace", () => {
    expect(parseSubcommands("GO   TEST  ./...")).toEqual([{ runner: "go test", targets: ["./..."], narrowing: [], nonExecuting: false }])
  })

  it("presentation-only flags never terminate the runner scan or become targets", () => {
    expect(parseSubcommands("npx vitest run --reporter=verbose --silent")).toEqual([
      { runner: "npx vitest run", targets: [], narrowing: [], nonExecuting: false },
    ])
  })
})

// ---------------------------------------------------------------------------
// FR-034 / FR-035 — target coverage is segment-aware and directional.
// ---------------------------------------------------------------------------

describe("targetCovers: segment-aware, not string-prefix", () => {
  it("`src/a` does NOT cover `src/ab` (shared character prefix, unrelated directories)", () => {
    expect(targetCovers("src/a", "src/ab")).toBe(false)
  })

  it("`src/a/...` does NOT cover `src/ab` either — recursion is per segment", () => {
    expect(targetCovers("src/a/...", "src/ab")).toBe(false)
    expect(targetCovers("src/a/**", "src/ab/x.test.ts")).toBe(false)
  })

  it("`src/a/...` covers `src/a`, `src/a/b` and `src/a/b/c.ts`", () => {
    expect(targetCovers("src/a/...", "src/a")).toBe(true)
    expect(targetCovers("src/a/...", "src/a/b")).toBe(true)
    expect(targetCovers("src/a/...", "src/a/b/c.ts")).toBe(true)
  })

  it("a trailing `**` is a recursive wildcard", () => {
    expect(targetCovers("src/ab/**", "src/ab/x.test.ts")).toBe(true)
    expect(targetCovers("**", "anything/at/all.ts")).toBe(true)
  })

  it("`./...` is universal", () => {
    expect(targetCovers("./...", "./internal/auth/...")).toBe(true)
    expect(targetCovers("./...", "tests/lexer.test.ts")).toBe(true)
  })

  it("identical targets cover, in either recursion mode", () => {
    expect(targetCovers("tests/lexer.test.ts", "tests/lexer.test.ts")).toBe(true)
    expect(targetCovers("./internal/auth/...", "./internal/auth/...")).toBe(true)
  })

  it("a non-recursive target cannot stand in for a recursive prescribed one", () => {
    expect(targetCovers("./internal/auth", "./internal/auth/...")).toBe(false)
  })

  it("a narrower target never covers a broader one", () => {
    expect(targetCovers("./internal/auth/...", "./...")).toBe(false)
    expect(targetCovers("src/a/b/...", "src/a/...")).toBe(false)
  })

  it("leading `./` and trailing `/` are normalised away", () => {
    expect(targetCovers("./src/a/", "src/a")).toBe(true)
    expect(targetCovers("src/a", "./src/a")).toBe(true)
  })
})

describe("targetsCover (FR-034 / FR-035)", () => {
  it("an empty observed target list is a whole-suite run and covers everything", () => {
    expect(targetsCover([], ["./internal/auth/..."])).toBe(true)
    expect(targetsCover([], [])).toBe(true)
  })

  it("a narrowed observed run does NOT cover a whole-suite prescribed run", () => {
    // The spec's literal `every p in P` is vacuously true here; that would be a
    // false cover in exactly the direction FR-035 forbids.
    expect(targetsCover(["tests/a.test.ts"], [])).toBe(false)
  })

  it("a universal observed target does cover a whole-suite prescribed run", () => {
    expect(targetsCover(["./..."], [])).toBe(true)
    expect(targetsCover(["**"], [])).toBe(true)
  })

  it("every prescribed target must find a covering observed target", () => {
    expect(targetsCover(["./..."], ["./internal/a/...", "./internal/b/..."])).toBe(true)
    expect(targetsCover(["./internal/a/..."], ["./internal/a/...", "./internal/b/..."])).toBe(false)
  })

  it("targets may be covered by different observed arguments", () => {
    expect(targetsCover(["./internal/a/...", "./internal/b/..."], ["./internal/a/x", "./internal/b/y"])).toBe(true)
  })

  it("command level: a whole-suite prescribed run is not covered by a narrow observed run", () => {
    expect(observedCoversPrescribed("npm test", "npx vitest run tests/lexer.test.ts")).toBe(false)
  })

  it("command level: `src/a` must not cover `src/ab`", () => {
    expect(observedCoversPrescribed("npx vitest run src/ab", "npx vitest run src/a")).toBe(false)
    expect(observedCoversPrescribed("npx vitest run src/ab/x.test.ts", "npx vitest run src/ab/**")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// FR-036 — runner equivalence is fail-closed.
// ---------------------------------------------------------------------------

describe("runnerEquivalent (FR-036)", () => {
  it("identical runners are equivalent", () => {
    expect(runnerEquivalent("go test", "go test")).toBe(true)
    expect(runnerEquivalent("GO TEST", "go   test")).toBe(true)
  })

  it("the JS whole-suite class is interchangeable", () => {
    expect(runnerEquivalent("npm test", "npx vitest run")).toBe(true)
    expect(runnerEquivalent("npx jest", "npm test")).toBe(true)
    expect(runnerEquivalent("npm run test", "npx vitest")).toBe(true)
    expect(runnerEquivalent("yarn test", "pnpm test")).toBe(true)
  })

  it("the Python class is interchangeable", () => {
    expect(runnerEquivalent("pytest", "python3 -m pytest")).toBe(true)
    expect(runnerEquivalent("python -m pytest", "uv run pytest")).toBe(true)
  })

  it("classes never bleed into each other (cross-ecosystem)", () => {
    expect(runnerEquivalent("npm test", "pytest")).toBe(false)
    expect(runnerEquivalent("go test", "cargo test")).toBe(false)
    expect(runnerEquivalent("cargo test", "cargo build")).toBe(false)
  })

  it("a runner absent from the table matches only itself (fail-closed)", () => {
    expect(runnerEquivalent("make verify", "make verify")).toBe(true)
    expect(runnerEquivalent("make verify", "make test")).toBe(false)
    expect(runnerEquivalent("make verify", "npm test")).toBe(false)
  })

  it("an empty runner is never equivalent to anything, including another empty runner", () => {
    expect(runnerEquivalent("", "")).toBe(false)
    expect(runnerEquivalent("", "npm test")).toBe(false)
    expect(runnerEquivalent("go test", "   ")).toBe(false)
  })

  it("WHOLE_SUITE_ALIASES groups `npm test` with the vitest/jest invocations", () => {
    const jsGroup = WHOLE_SUITE_ALIASES.find((group) => group.includes("npm test"))
    expect(jsGroup).toBeDefined()
    expect(jsGroup).toContain("npx vitest run")
    expect(jsGroup).toContain("npx jest")
  })
})

// ---------------------------------------------------------------------------
// Parser shapes that could otherwise fail OPEN.
// ---------------------------------------------------------------------------

describe("unknown and opaque command shapes fail closed", () => {
  it("an unknown runner covers an identical unknown runner", () => {
    expect(observedCoversPrescribed("make verify", "make verify")).toBe(true)
  })

  it("an unknown runner does not cover a different unknown runner", () => {
    expect(observedCoversPrescribed("make verify", "make lint")).toBe(false)
  })

  it("a script path with no program word becomes an opaque runner matching only itself", () => {
    expect(parseSubcommands("./scripts/ci.sh")).toEqual([{ runner: "./scripts/ci.sh", targets: [], narrowing: [], nonExecuting: false }])
    expect(observedCoversPrescribed("./scripts/ci.sh", "./scripts/ci.sh")).toBe(true)
    expect(observedCoversPrescribed("./scripts/ci.sh", "./scripts/lint.sh")).toBe(false)
  })

  it("`./gradlew test` does not cover `./gradlew build` (opaque runners keep their arguments)", () => {
    expect(observedCoversPrescribed("./gradlew build", "./gradlew test")).toBe(false)
    expect(observedCoversPrescribed("./gradlew build", "./gradlew build")).toBe(true)
  })

  it("`-m` values name the program, so `python -m pytest` cannot cover `python -m mypy`", () => {
    expect(parseSubcommands("python -m pytest")).toEqual([{ runner: "python -m pytest", targets: [], narrowing: [], nonExecuting: false }])
    expect(observedCoversPrescribed("python -m mypy src/", "python -m pytest")).toBe(false)
  })

  it("`python3 -m pytest` does cover a narrower prescribed pytest run", () => {
    expect(observedCoversPrescribed("pytest tests/unit", "python3 -m pytest")).toBe(true)
  })

  it("a marker-filtered pytest run is treated as its own runner (false gap, never a false cover)", () => {
    expect(parseSubcommands("pytest -m slow")).toEqual([{ runner: "pytest -m slow", targets: [], narrowing: [], nonExecuting: false }])
    expect(observedCoversPrescribed("pytest", "pytest -m slow")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Empty / degenerate input.
// ---------------------------------------------------------------------------

describe("empty and degenerate input", () => {
  it("parseSubcommands returns nothing for empty or whitespace-only input", () => {
    expect(parseSubcommands("")).toEqual([])
    expect(parseSubcommands("   ")).toEqual([])
    expect(parseSubcommands(" && ; || ")).toEqual([])
  })

  it("parseSubcommands drops a fragment that is pure redirection noise", () => {
    expect(parseSubcommands("npm test && 2>&1")).toEqual([{ runner: "npm test", targets: [], narrowing: [], nonExecuting: false }])
  })

  it("an empty prescribed or observed command never covers", () => {
    expect(observedCoversPrescribed("", "go test ./...")).toBe(false)
    expect(observedCoversPrescribed("go test ./...", "")).toBe(false)
    expect(observedCoversPrescribed("", "")).toBe(false)
    expect(observedCoversPrescribed("   ", "   ")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Composition: every prescribed sub-command must be covered; extras are free.
// ---------------------------------------------------------------------------

describe("observedCoversPrescribed composition", () => {
  it("one uncovered prescribed sub-command sinks the whole command", () => {
    expect(observedCoversPrescribed("go test ./... && npm test", "go test ./...")).toBe(false)
  })

  it("both prescribed sub-commands covered by different observed sub-commands", () => {
    expect(observedCoversPrescribed("go test ./... && npm test", "npm test && go test ./...")).toBe(true)
  })

  it("extra observed sub-commands are free", () => {
    expect(observedCoversPrescribed("npm test", "npm run lint && npm test && npm run build")).toBe(true)
  })

  it("subCommandCovers is the per-pair primitive", () => {
    expect(
      subCommandCovers({ runner: "go test", targets: ["./..."], narrowing: [], nonExecuting: false }, { runner: "go test", targets: ["./x/..."], narrowing: [], nonExecuting: false }),
    ).toBe(true)
    expect(
      subCommandCovers({ runner: "go build", targets: ["./..."], narrowing: [], nonExecuting: false }, { runner: "go test", targets: ["./x/..."], narrowing: [], nonExecuting: false }),
    ).toBe(false)
  })
})

// ===========================================================================
// Narrowing selectors — closes the fail-open where a filtered run scored as
// covering the full prescribed suite (would mint a receipt for work not done).
// ===========================================================================

describe("narrowing selectors", () => {
  it("a -run selector does NOT cover an unfiltered prescribed suite", () => {
    expect(observedCoversPrescribed("go test ./...", "go test -run TestFoo ./...")).toBe(false)
    expect(observedCoversPrescribed("go test ./...", "go test -run=TestFoo ./...")).toBe(false)
  })

  it("an unfiltered observed run still covers a filtered prescription (broader is fine)", () => {
    expect(observedCoversPrescribed("go test -run TestFoo ./...", "go test ./...")).toBe(true)
  })

  it("an identical selector on both sides covers", () => {
    expect(observedCoversPrescribed("go test -run TestFoo ./...", "go test -run TestFoo ./...")).toBe(true)
  })

  it("a different selector does not cover", () => {
    expect(observedCoversPrescribed("go test -run TestBar ./...", "go test -run TestFoo ./...")).toBe(false)
  })

  it.each([
    ["-t", 'npx vitest run -t "case" src/'],
    ["--testNamePattern", "npx jest --testNamePattern=x src/"],
    ["-k", "pytest -k slow tests/"],
    ["--filter", "cargo test --filter foo"],
    ["--grep", "npx mocha --grep x test/"],
  ])("%s is treated as narrowing", (_label, observed) => {
    const prescribed = observed.replace(/\s+(-t|--testNamePattern=x|-k|--filter|--grep)(\s+\S+)?/, " ")
    expect(observedCoversPrescribed(prescribed, observed)).toBe(false)
  })

  it("-count=1 is NOT narrowing (the spec's own worked example must still cover)", () => {
    expect(
      observedCoversPrescribed(
        "go test ./internal/a/... && go test ./internal/b/... && go build ./...",
        "go build ./... && go test ./... -count=1 2>&1",
      ),
    ).toBe(true)
  })

  it("a selector flag with a missing value still counts as narrowing (fail-closed)", () => {
    expect(observedCoversPrescribed("go test ./...", "go test ./... -run")).toBe(false)
  })
})

// ===========================================================================
// Found by the adversarial UAT plan (Opus), both measured on the live build
// before being fixed here.
//
// O-01 was EVIDENCE FABRICATION: `cd internal/calc && go test ./...` scored as
// covering `go test ./internal/...`, because `./...` parsed as "the whole
// tree" while the `cd` had already narrowed it to one package. A receipt was
// minted for sibling packages that never ran.
//
// O-02 was the opposite failure: `bash -lc "go test ./..."` parsed with runner
// `bash`, matched no prescription, and starved a legitimate full-suite run of
// evidence -- the D1 direction. Worse, the verdict flipped on unrelated state:
// with no prescription present the same command minted a receipt.
// ===========================================================================

describe("working-directory changes make targets incomparable (O-01)", () => {
  it("refuses a cd-prefixed run against a root-relative prescription", () => {
    expect(observedCoversPrescribed("go test ./internal/...", "cd internal/calc && go test ./...")).toBe(false)
  })

  it("refuses regardless of which directory-changing builtin is used", () => {
    for (const runner of ["cd", "pushd", "chdir"]) {
      expect(
        observedCoversPrescribed("go test ./...", `${runner} sub && go test ./...`),
        `${runner} must not be trusted`,
      ).toBe(false)
    }
  })

  it("still covers when no directory change is involved (discrimination)", () => {
    // Without this, "always return false" would satisfy the two tests above
    // while silently reintroducing D1 evidence starvation.
    expect(observedCoversPrescribed("go test ./internal/...", "go test ./...")).toBe(true)
  })
})

describe("shell wrappers are unwrapped (O-02)", () => {
  it("credits `bash -lc \"<verifier>\"` as the verifier it actually runs", () => {
    expect(observedCoversPrescribed("go test ./...", 'bash -lc "go test ./..."')).toBe(true)
    expect(observedCoversPrescribed("go test ./internal/...", `sh -c 'go test ./...'`)).toBe(true)
  })

  it("does not let the wrapper launder a NARROWED run into a full-suite pass", () => {
    // The unwrap must expose the inner command to the normal rules, not bypass
    // them -- otherwise it becomes a fabrication vector of its own.
    expect(observedCoversPrescribed("go test ./...", 'sh -c "go test -run TestAdd ./..."')).toBe(false)
    expect(observedCoversPrescribed("go test ./...", 'bash -lc "go build ./..."')).toBe(false)
  })

  it("does not let the wrapper launder a cd-prefixed run either", () => {
    expect(observedCoversPrescribed("go test ./internal/...", 'bash -lc "cd internal/calc && go test ./..."')).toBe(false)
  })
})
