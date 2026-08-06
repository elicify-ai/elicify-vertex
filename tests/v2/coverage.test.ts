import { describe, expect, it } from "vitest"
import {
  isNonExecutingCommand,
  observedCoversPrescribed,
  parseSubcommands,
  runnerEquivalent,
  subCommandCovers,
  targetCovers,
  targetsCover,
  verifyGapComplied,
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

// ===========================================================================
// Cargo subset selection (found by the polyglot-resolver workstream).
//
// `cargo test -p mycrate` parsed as a bare whole-suite `cargo test`: the crate
// name is not path-shaped, so it became neither a target nor a flag value, and
// one crate's tests were credited as covering an entire workspace.
//
// The fix had to be runner-scoped, not global -- `--workspace` narrows for
// npm/pnpm (one workspace of many) but BROADENS for cargo (all crates). A
// global entry would have suppressed every legitimate `cargo test --workspace`
// receipt: evidence starvation, the same direction as the `-n` bug.
// ===========================================================================

describe("cargo subset flags are narrowing, but --workspace is not", () => {
  it("refuses a single-crate run as evidence for the workspace", () => {
    for (const observed of ["cargo test -p mycrate", "cargo test --package mycrate", "cargo test --lib"]) {
      expect(observedCoversPrescribed("cargo test", observed), observed).toBe(false)
    }
  })

  it("still credits a genuine whole-workspace cargo run (discrimination)", () => {
    expect(observedCoversPrescribed("cargo test", "cargo test")).toBe(true)
    expect(observedCoversPrescribed("cargo test", "cargo test --workspace")).toBe(true)
  })

  it("keeps npm's OPPOSITE meaning of --workspace intact", () => {
    // npm --workspace selects ONE of many, so it must still narrow.
    expect(observedCoversPrescribed("npm test", "npm test --workspace pkg-a")).toBe(false)
    expect(observedCoversPrescribed("npm test", "npm test")).toBe(true)
  })
})

// ===========================================================================
// `||` on the observed side — previously UNGUARDED.
//
// coverage.ts's own header calls this "the single worst failure mode in this
// codebase": `A || B` exits 0 whether A passed or B did, so you cannot tell
// which ran, and crediting either fabricates a receipt. The drop was
// implemented, but deleting it left the entire 1054-test suite green — the
// nearby `parseSubcommands` test exercises splitting only, and reads as though
// the behaviour were covered.
// ===========================================================================

describe("alternation on the observed side covers nothing", () => {
  it("refuses `lint || test` even though the test half matches", () => {
    expect(observedCoversPrescribed("npm test", "npm run lint || npm test")).toBe(false)
    expect(observedCoversPrescribed("go test ./...", "go build ./... || go test ./...")).toBe(false)
  })

  it("still credits the same command without the alternation (discrimination)", () => {
    expect(observedCoversPrescribed("npm test", "npm run lint && npm test")).toBe(true)
  })
})

// A prescribed selector must be compared literally, not derived by regex.
// The previous `it.each` row for `--testNamePattern` built its prescription with
// `observed.replace(/\s+(-t|--testNamePattern=x|…)(\s+\S+)?/, " ")`, whose greedy
// optional group also swallowed the ` src/` TARGET. The row therefore went false
// because of target mismatch, and deleting `--testNamePattern` from
// NARROWING_FLAGS left the whole suite green.
describe("--testNamePattern is a real narrowing selector", () => {
  it("does not credit a name-filtered run for the unfiltered suite", () => {
    expect(observedCoversPrescribed("npx jest src/", "npx jest --testNamePattern=x src/")).toBe(false)
  })

  it("credits the unfiltered run (discrimination: targets are identical)", () => {
    expect(observedCoversPrescribed("npx jest src/", "npx jest src/")).toBe(true)
  })
})

// ===========================================================================
// Second-round review findings — all four were introduced by the FIRST round's
// fixes, which is why they are pinned individually here.
// ===========================================================================

describe("a run outside the worktree evidences nothing inside it", () => {
  // `..` popped an empty stack, so "above the repo" silently became "the repo":
  // `cd .. && npm test` -- a run in the PARENT directory -- minted a receipt.
  // MUTATION: make joinDir's `..` branch `out.pop()` again -> red.
  it("refuses a cd that escapes above the root", () => {
    for (const observed of ["cd .. && npm test", "cd ../../../.. && npm test", "cd ../sibling && npm test"]) {
      expect(observedCoversPrescribed("npm test", observed), observed).toBe(false)
    }
  })

  it("refuses an absolute cd", () => {
    expect(observedCoversPrescribed("npm test", "cd /tmp/elsewhere && npm test")).toBe(false)
  })

  it("still credits a cd that stays inside (discrimination)", () => {
    expect(observedCoversPrescribed("go test ./internal/auth/...", "cd internal && go test ./auth/...")).toBe(true)
  })
})

describe("a bare root run does not cover a cd-scoped prescription", () => {
  // The mirror of the -w workspace rule: `cd backend && npm test` is prescribed
  // precisely because the root script does not necessarily enter backend/.
  it("refuses bare `npm test` against `cd backend && npm test`", () => {
    expect(observedCoversPrescribed("cd backend && npm test", "npm test")).toBe(false)
  })

  it("credits the verbatim prescription (discrimination)", () => {
    expect(observedCoversPrescribed("cd backend && npm test", "cd backend && npm test")).toBe(true)
  })
})

describe("a version probe chained before a real suite still counts", () => {
  // `every` missed `--collect-only && echo done`; `some` then condemned
  // `node --version && npm test`. Shell plumbing is filtered out instead, so
  // neither direction is wrong.
  it("does not treat a chain containing a real suite as non-executing", () => {
    expect(isNonExecutingCommand("node --version && npm test")).toBe(false)
    expect(isNonExecutingCommand("python3 --version && pytest")).toBe(false)
  })

  it("still catches a chain that only lists tests", () => {
    expect(isNonExecutingCommand("pytest --collect-only && echo done")).toBe(true)
    expect(isNonExecutingCommand("npx jest --listTests && true")).toBe(true)
  })
})

describe("-C after a pipe is a display flag, not a directory change", () => {
  it("credits a verifier whose output is grepped with -C", () => {
    expect(observedCoversPrescribed("npm test", "npm test 2>&1 | grep -C 3 FAIL")).toBe(true)
  })

  it("still refuses go -C in the command head (discrimination)", () => {
    expect(observedCoversPrescribed("go -C services/api test ./...", "go -C other build ./...")).toBe(false)
  })
})

// ===========================================================================
// FR-013 — absolute/relative path normalisation against the worktree root.
// (Spec dataset rows 30 and 31, docs/VERIFIER-RELIABILITY-FIXES-SPEC.md.)
//
// Grounding: in the audited session (`ses_04dc77bdaffej8SFJvYm5yO0CW`) the
// agent ran each story's declared verifiers one at a time, spelling the paths
// absolutely, while the plan declared them relatively. Every comparison scored
// disjoint, producing **146 `verify:relevance-gap` events and ZERO receipts**.
// Every fixture below is that shape, verbatim.
//
// The safety contract is asserted alongside: normalisation may only make two
// SPELLINGS of one path agree. It must never turn an unrelated command into a
// cover, and it must never rescue a run outside the worktree.
// ===========================================================================

const WORKTREE = "/workspace/vertextest2"

describe("FR-013: absolute observed path matches relative declared verifier (dataset row 31)", () => {
  it("credits the exact field shape once a root is supplied", () => {
    // MUTATION: drop the third argument -> red (this is the 146-gap case).
    expect(
      observedCoversPrescribed(
        "test -f research/crispr-gene-editing.md",
        `test -f ${WORKTREE}/research/crispr-gene-editing.md`,
        WORKTREE,
      ),
    ).toBe(true)
  })

  it("normalises the PRESCRIBED side too — either side may be the absolute one", () => {
    expect(
      observedCoversPrescribed(
        `test -f ${WORKTREE}/research/crispr-gene-editing.md`,
        "test -f research/crispr-gene-editing.md",
        WORKTREE,
      ),
    ).toBe(true)
  })

  it("normalises recursive absolute targets", () => {
    expect(observedCoversPrescribed("go test ./internal/auth/...", `go test ${WORKTREE}/...`, WORKTREE)).toBe(true)
    expect(observedCoversPrescribed(`go test ${WORKTREE}/internal/...`, "go test ./internal/auth/...", WORKTREE)).toBe(
      false,
    )
  })

  it("tolerates a trailing slash on the root", () => {
    expect(
      observedCoversPrescribed("test -f research/a.md", `test -f ${WORKTREE}/research/a.md`, `${WORKTREE}/`),
    ).toBe(true)
  })

  it("keeps the previous behaviour when NO root is supplied", () => {
    // The regression this whole requirement is about: without a root the two
    // spellings are still disjoint, which is why the old two-argument call
    // sites minted nothing.
    expect(
      observedCoversPrescribed(
        "test -f research/crispr-gene-editing.md",
        `test -f ${WORKTREE}/research/crispr-gene-editing.md`,
      ),
    ).toBe(false)
  })
})

describe("FR-013: normalisation does not blanket-accept", () => {
  it("an UNRELATED command still reports a relevance gap", () => {
    // Different runner entirely — the story verifier is a file assertion, the
    // agent ran a linter.
    expect(observedCoversPrescribed("test -f research/a.md", "npx eslint .", WORKTREE)).toBe(false)
    // Same runner, different file.
    expect(
      observedCoversPrescribed("test -f research/a.md", `test -f ${WORKTREE}/research/b.md`, WORKTREE),
    ).toBe(false)
    // Same runner, the root itself rather than the declared file.
    expect(observedCoversPrescribed("test -f research/a.md", `test -f ${WORKTREE}`, WORKTREE)).toBe(false)
  })

  it("an absolute path OUTSIDE the root is still disjoint", () => {
    expect(observedCoversPrescribed("test -f research/a.md", "test -f /other/repo/research/a.md", WORKTREE)).toBe(false)
    // A sibling directory sharing the root's prefix must not be swallowed:
    // `/workspace/vertextest22` is not inside `/workspace/vertextest2`.
    expect(
      observedCoversPrescribed("test -f research/a.md", `test -f ${WORKTREE}2/research/a.md`, WORKTREE),
    ).toBe(false)
  })

  it("a run outside the worktree is still refused with a root supplied", () => {
    expect(observedCoversPrescribed("npm test", "cd /tmp/elsewhere && npm test", WORKTREE)).toBe(false)
    expect(observedCoversPrescribed("npm test", "cd .. && npm test", WORKTREE)).toBe(false)
  })

  it("a narrowed run is still not a cover, absolutely spelled", () => {
    expect(observedCoversPrescribed("go test ./...", `go test -run TestFoo ${WORKTREE}/...`, WORKTREE)).toBe(false)
  })

  it("a non-executing run is still not a cover, absolutely spelled", () => {
    expect(observedCoversPrescribed("pytest tests/unit", `pytest --collect-only ${WORKTREE}/tests/unit`, WORKTREE)).toBe(
      false,
    )
  })
})

describe("FR-013: an absolute cd is resolved against the root", () => {
  it("`cd <root>` is the repo root, not 'outside the worktree'", () => {
    expect(observedCoversPrescribed("npm test", `cd ${WORKTREE} && npm test`, WORKTREE)).toBe(true)
  })

  it("`cd <root>/backend` is the same as `cd backend`", () => {
    expect(observedCoversPrescribed("cd backend && npm test", `cd ${WORKTREE}/backend && npm test`, WORKTREE)).toBe(true)
  })

  it("an absolute cd REPLACES the directory rather than appending to it", () => {
    // `cd backend && cd <root> && npm test` runs at the ROOT, so it must not
    // cover a prescription scoped to `backend`.
    expect(
      observedCoversPrescribed("cd backend && npm test", `cd backend && cd ${WORKTREE} && npm test`, WORKTREE),
    ).toBe(false)
  })

  it("an absolute target stays cwd-independent when a cd is also present", () => {
    // `/root/research/a.md` names the same file whatever directory the command
    // runs in — it must NOT be re-rooted to `backend/research/a.md`.
    expect(
      observedCoversPrescribed(
        "test -f research/a.md",
        `cd backend && test -f ${WORKTREE}/research/a.md`,
        WORKTREE,
      ),
    ).toBe(true)
    expect(
      observedCoversPrescribed(
        "test -f backend/research/a.md",
        `cd backend && test -f ${WORKTREE}/research/a.md`,
        WORKTREE,
      ),
    ).toBe(false)
  })
})

describe("FR-013: parseSubcommands rebases absolute targets only when asked", () => {
  it("leaves the parse byte-identical with no root", () => {
    expect(parseSubcommands(`test -f ${WORKTREE}/research/a.md`)).toEqual([
      // CRIT-2 (round 4): the file-test operator is part of the runner
      // identity now, so `test -f` and `test -n` cannot cover each other.
      { runner: "test -f", targets: [`${WORKTREE}/research/a.md`], narrowing: [], nonExecuting: false },
    ])
  })

  it("rebases onto the root when one is supplied", () => {
    expect(parseSubcommands(`test -f ${WORKTREE}/research/a.md`, WORKTREE)).toEqual([
      { runner: "test -f", targets: ["research/a.md"], narrowing: [], nonExecuting: false },
    ])
  })

  it("maps the root itself to '.', never to a universal target", () => {
    expect(parseSubcommands(`test -d ${WORKTREE}`, WORKTREE)).toEqual([
      { runner: "test -d", targets: ["."], narrowing: [], nonExecuting: false },
    ])
  })

  it("ignores a relative or empty root (nothing to anchor against)", () => {
    expect(parseSubcommands(`test -f ${WORKTREE}/research/a.md`, "")).toEqual(
      parseSubcommands(`test -f ${WORKTREE}/research/a.md`),
    )
    expect(parseSubcommands(`test -f ${WORKTREE}/research/a.md`, "workspace/vertextest2")).toEqual(
      parseSubcommands(`test -f ${WORKTREE}/research/a.md`),
    )
  })
})

describe("FR-013 AS1: one declared verifier of six is creditable on its own (dataset row 30)", () => {
  // The plugin's prescription block picks the FIRST declared verifier the
  // observed command covers, instead of `join(" && ")`-ing all six into a
  // single prescription that only a six-in-one command could satisfy. This
  // asserts the coverage-level contract that choice depends on: each verifier
  // is independently matchable, and the joined form is not.
  const declared = [
    "test -f research/crispr-gene-editing.md",
    "test -f research/renewable-energy.json",
    "test -f research/space-exploration.json",
    "test -f research/quantum-computing.md",
    "test -f research/ocean-acidification.md",
    "test -f research/urban-agriculture.md",
  ]

  it("each verifier is credited by the single command that runs it", () => {
    for (const verifier of declared) {
      const observed = verifier.replace("research/", `${WORKTREE}/research/`)
      expect(
        declared.find((candidate) => observedCoversPrescribed(candidate, observed, WORKTREE)),
        observed,
      ).toBe(verifier)
    }
  })

  it("the OLD `&&`-joined prescription is what could never be covered", () => {
    // MUTATION: revert plugin.ts to `storyVerifiers.join(" && ")` -> the
    // prescription becomes this, and every one-at-a-time run is a gap.
    expect(
      observedCoversPrescribed(
        declared.join(" && "),
        `test -f ${WORKTREE}/research/crispr-gene-editing.md`,
        WORKTREE,
      ),
    ).toBe(false)
    // ...while the six-in-one command nobody runs would have satisfied it.
    expect(observedCoversPrescribed(declared.join(" && "), declared.join(" && "), WORKTREE)).toBe(true)
  })

  it("a run of a DIFFERENT story's verifier still matches nothing", () => {
    expect(
      declared.find((candidate) => observedCoversPrescribed(candidate, `test -f ${WORKTREE}/notes/unrelated.md`, WORKTREE)),
    ).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// C4 (grill round 2) — a bare directory operand is still the command's subject.
//
// `isPathShaped` requires a `/`, `.` or `*`. A prescribed `test -d research`
// therefore parsed to `{runner:"test", targets:[]}`, and a target-less
// sub-command covers anything with the same runner — so an observed
// `test -d src` minted a receipt asserting `research` had been verified.
// `test -f package.json` hid the bug: the dot made it path-shaped.
// ---------------------------------------------------------------------------
describe("C4 — bare-word operands of filesystem predicates", () => {
  it("keeps a bare directory as a target", () => {
    expect(parseSubcommands("test -d research")[0].targets).toEqual(["research"])
  })

  it("does NOT credit a different directory", () => {
    expect(observedCoversPrescribed("test -d research", "test -d src")).toBe(false)
  })

  it("still credits the identical assertion", () => {
    expect(observedCoversPrescribed("test -d research", "test -d research")).toBe(true)
  })

  it("does not treat a non-predicate runner's bare word as a path", () => {
    // The reason `isPathShaped` could not simply be widened: `toSubCommand`
    // uses it to find where the runner ends.
    expect(parseSubcommands("npm run build")[0].targets).toEqual([])
    expect(observedCoversPrescribed("npm run build", "npm run build")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Round-4 CRIT-1/CRIT-2 — false receipts from commands that assert nothing.
//
// A round-3 review reported these runners as dead code and they were removed;
// that was a regression. `toSubCommand`'s runner-word loop only swallows the
// operand of a BARE `ls research` — it stops at the first flag, so the flagged
// spelling (the common one) reaches the target filter. Dropping the operand
// there yields `targets: []`, which `targetsCover` treats as universal.
// ---------------------------------------------------------------------------
describe("CRIT-1: flagged path-runner invocations keep their operand", () => {
  const CASES: Array<[string, string, boolean]> = [
    ["ls -la research", "ls -la src", false],
    ["ls -la research", "ls -la", false],
    ["ls -la research", "ls -la research", true],
    ["stat -c %s research", "stat -c %s src", false],
    ["stat -c %s research", "stat -c %s research", true],
    ["readlink -f research", "readlink -f build", false],
    ["realpath research", "realpath src", false],
    // The originally-reported C4 shape, in bash's idiomatic spelling.
    ["[[ -d research ]]", "[[ -d src ]]", false],
    ["[[ -d research ]]", "[[ -d research ]]", true],
  ]
  for (const [prescribed, observed, expected] of CASES) {
    it(`${expected ? "credits" : "refuses"}: ${prescribed} <- ${observed}`, () => {
      expect(observedCoversPrescribed(prescribed, observed)).toBe(expected)
    })
  }
})

// ---------------------------------------------------------------------------
// CRIT-2 — a string test is not a filesystem assertion.
//
// `test -n <path>` and bare `test <path>` touch no filesystem and always exit
// 0. Gating only BARE operands left this open for every operand with a dot or
// a slash, i.e. nearly every real file. The operator is part of WHICH
// assertion was made, so it belongs in the runner identity.
// ---------------------------------------------------------------------------
describe("CRIT-2: the file-test operator is part of the runner identity", () => {
  const CASES: Array<[string, string, boolean]> = [
    ["test -f package.json", "test -n package.json", false],
    ["test -e research/x.md", "test -n research/x.md", false],
    ["test -f package.json", "test package.json", false],
    ["test -d research", "test -n research", false],
    ["test -f package.json", "test -f package.json", true],
    ["test -d research", "test -d research", true],
    // Quoting is shell syntax, not part of the path.
    ['test -d "research"', "test -d research", true],
  ]
  for (const [prescribed, observed, expected] of CASES) {
    it(`${expected ? "credits" : "refuses"}: ${prescribed} <- ${observed}`, () => {
      expect(observedCoversPrescribed(prescribed, observed)).toBe(expected)
    })
  }

  it("carries the operator into the parsed runner", () => {
    expect(parseSubcommands("test -f package.json")[0].runner).toBe("test -f")
    expect(parseSubcommands("test -d research")[0].runner).toBe("test -d")
    // Every non-file-test spelling collapses to one identity, so `test -n`,
    // bare `test` and `test -z` are all distinct from `test -f` and cover no
    // filesystem assertion at all.
    expect(parseSubcommands("test -n package.json")[0].runner).toBe("test (none)")
    expect(parseSubcommands("test package.json")[0].runner).toBe("test (none)")
  })
})

// ---------------------------------------------------------------------------
// MAJ-7 (round 4) — the verify-gap compliance credit, extracted from
// `plugin.ts` so it can be tested at all. It went unguarded because it was
// inline in a hook: a mutant removing the `storyScoped` gate survived.
// ---------------------------------------------------------------------------
describe("verifyGapComplied", () => {
  const STORY = "test -f research/a.md && test -f research/b.md"
  const MIXED = "go test ./... && npm test"

  it("credits full coverage regardless of scope", () => {
    expect(verifyGapComplied(STORY, STORY, { storyScoped: true })).toBe(true)
    expect(verifyGapComplied(MIXED, MIXED, { storyScoped: false })).toBe(true)
  })

  it("credits ONE of a story's independent verifiers", () => {
    expect(verifyGapComplied(STORY, "test -f research/a.md", { storyScoped: true })).toBe(true)
    expect(verifyGapComplied(STORY, "test -f research/b.md", { storyScoped: true })).toBe(true)
  })

  // The invariant `resolve.ts` states explicitly: a Go suite is blind to a
  // TypeScript change and vice versa. Crediting half would mark the family
  // complied on the strength of a check that never looked at the changed
  // code — running the Go half would count as answering the TypeScript nudge.
  it("refuses one half of a MIXED-ECOSYSTEM prescription", () => {
    expect(verifyGapComplied(MIXED, "go test ./...", { storyScoped: false })).toBe(false)
    expect(verifyGapComplied(MIXED, "npm test", { storyScoped: false })).toBe(false)
  })

  it("defaults to the strict reading when scope is unknown", () => {
    expect(verifyGapComplied(STORY, "test -f research/a.md")).toBe(false)
  })

  it("still refuses an unrelated command", () => {
    expect(verifyGapComplied(STORY, "npx eslint .", { storyScoped: true })).toBe(false)
  })
})

// CR-10 (round 5) — a NEGATED file test asserts the opposite of the
// prescription it was crediting. `test ! -f x` succeeds precisely when the
// file is absent; it was minting a receipt claiming the file was verified
// present. `!` is neither a flag nor path-shaped, so the runner-word loop
// absorbs it — the negation has to be looked for on both sides of the split.
describe("CR-10: a negated file test never credits the positive one", () => {
  const CASES: Array<[string, string, boolean]> = [
    ["test -f package.json", "test ! -f package.json", false],
    ["test -d research", "test ! -d research", false],
    ["[[ -d research ]]", "[[ ! -d research ]]", false],
    ["test ! -f x.md", "test ! -f x.md", true],
    ["test -f package.json", "test -f package.json", true],
  ]
  for (const [prescribed, observed, expected] of CASES) {
    it(`${expected ? "credits" : "refuses"}: ${prescribed} <- ${observed}`, () => {
      expect(observedCoversPrescribed(prescribed, observed)).toBe(expected)
    })
  }
})

// ===========================================================================
// FIX 1 — `npm run <script>` sat in NO equivalence class, so only a
// byte-identical spelling covered it. MEASURED, before the fix:
//
//   prescribed "npm run check" <= covered by ["npm run check",
//                                             "npm run check --silent"]
//   prescribed "npm run build" <= covered by ["npm run build"]
//
// `resolve.ts` prescribes `npm run <script>` unconditionally — it cannot know
// which package manager the repo uses — so in a pnpm or yarn repo the agent's
// perfectly correct `pnpm check` scored as a relevance gap. That costs more than
// a receipt: `plugin.ts` folds the gap into `success`, so the run is recorded as
// FAILED and the story stays open. Before B-4 widened tier 3 there was no
// prescription at all and the very same run minted a receipt.
//
// WHERE THE LINE IS DRAWN: same script name, different launcher. Nothing below
// makes two different scripts, two different workspaces, or a package-manager
// subcommand interchangeable.
// ===========================================================================

describe("FIX 1: one script, every package manager (the covering half)", () => {
  const COVERS: Array<[string, string]> = [
    ["npm run check", "npm run check"],
    ["npm run check", "pnpm run check"],
    ["npm run check", "pnpm check"],
    ["npm run check", "yarn run check"],
    ["npm run check", "yarn check"],
    ["npm run check", "bun run check"],
    ["npm run check", "npm run-script check"],
    ["npm run check", "npm run check --silent"],
    ["npm run check", "npm --silent run check"],
    ["npm run check", "CI=1 pnpm run check 2>&1 | tail -5"],
    ["npm run check", "cd . && yarn check"],
    ["npm run build", "yarn build"],
    ["npm run build", "pnpm build"],
    ["npm run typecheck", "bun run typecheck"],
    // The whole-suite alias class keeps working through the same identity.
    ["npm test", "pnpm test"],
    ["npm test", "bun test"],
    ["npm test", "yarn run test"],
    ["npm test", "npx vitest run"],
  ]
  for (const [prescribed, observed] of COVERS) {
    it(`credits: ${prescribed} <- ${observed}`, () => {
      expect(observedCoversPrescribed(prescribed, observed)).toBe(true)
    })
  }

  it("a whole-suite run through ANY package manager covers a narrow tier-2 prescription", () => {
    // `resolve.ts`'s basename tier prescribes a single test file; running the
    // whole suite is broader and must count — through pnpm/yarn/bun too, or the
    // `WHOLE_SUITE_WHEN_BARE` privilege stops at npm.
    const prescribed = "npx vitest run tests/lexer.test.ts"
    for (const observed of ["npm test", "pnpm test", "yarn test", "bun run test"]) {
      expect(observedCoversPrescribed(prescribed, observed), observed).toBe(true)
    }
    // A non-whole-suite script is still not a whole-suite run.
    expect(observedCoversPrescribed(prescribed, "pnpm build")).toBe(false)
    expect(observedCoversPrescribed(prescribed, "pnpm check")).toBe(false)
  })
})

describe("FIX 1: the widening stops at the script NAME (the fail-closed half)", () => {
  const REFUSES: Array<[string, string]> = [
    // A different script is not evidence for this one.
    ["npm run check", "npm test"],
    ["npm run check", "npm run build"],
    ["npm run build", "npm run check"],
    ["npm run check", "npx vitest run"],
    ["npm run check", "pnpm build"],
    // A package manager's OWN subcommand is not a script (`npm ci` installs).
    ["npm run ci", "npm ci"],
    ["npm run install", "pnpm install"],
    ["npm run publish", "npm publish"],
    ["npm test", "npm ci"],
    // `npx`/`dlx` run a BINARY, so they are never "the script of that name".
    ["npm run vitest", "npx vitest"],
    ["npm run vitest", "pnpm dlx vitest"],
    // Extra runner words mean this is not a plain script invocation.
    ["npm run vitest", "yarn vitest run"],
    // Cross-ecosystem stays impossible.
    ["npm run check", "pytest"],
    ["pytest", "pnpm check"],
  ]
  for (const [prescribed, observed] of REFUSES) {
    it(`refuses: ${prescribed} <- ${observed}`, () => {
      expect(observedCoversPrescribed(prescribed, observed)).toBe(false)
    })
  }
})

describe("FIX 1: a workspace selector is one run spelled several ways", () => {
  const PRESCRIBED = "npm run check -w packages/api"

  it("credits the long spelling of the same selector", () => {
    expect(observedCoversPrescribed(PRESCRIBED, "npm run check --workspace packages/api")).toBe(true)
    expect(observedCoversPrescribed(PRESCRIBED, "npm run check --workspace=packages/api")).toBe(true)
  })

  it("credits the `cd` spelling — the shape an agent actually types in a monorepo", () => {
    expect(observedCoversPrescribed(PRESCRIBED, "cd packages/api && npm run check")).toBe(true)
    expect(observedCoversPrescribed(PRESCRIBED, "cd packages/api && pnpm check")).toBe(true)
  })

  it("still refuses a bare root run — a root script need not enter the workspace", () => {
    expect(observedCoversPrescribed(PRESCRIBED, "npm run check")).toBe(false)
    expect(observedCoversPrescribed(PRESCRIBED, "pnpm check")).toBe(false)
  })

  it("still refuses a DIFFERENT workspace, in either spelling", () => {
    expect(observedCoversPrescribed(PRESCRIBED, "npm run check -w packages/web")).toBe(false)
    expect(observedCoversPrescribed(PRESCRIBED, "cd packages/web && npm run check")).toBe(false)
  })

  it("still refuses a narrowed run against an unnarrowed prescription (direction preserved)", () => {
    expect(observedCoversPrescribed("npm run check", PRESCRIBED)).toBe(false)
    expect(observedCoversPrescribed("npm test", "npm test -w packages/api")).toBe(false)
    expect(observedCoversPrescribed("npm test", "cd packages/api && npm test")).toBe(false)
  })

  it("the selector's value is a workspace, not a path target", () => {
    // Leaving `packages/api` in `targets` is what made the `cd` spelling
    // impossible to credit: it demanded a path argument that the honest
    // equivalent never produces.
    expect(parseSubcommands(PRESCRIBED)).toEqual([
      { runner: "npm run check", targets: [], narrowing: ["-w=packages/api"], nonExecuting: false },
    ])
  })
})
