/**
 * src/v2/coverage.ts — Covering-verifier semantics (D1 / FR-033…FR-037, FR-036a).
 *
 * ## Why this module exists
 *
 * `measurement.ts:824`'s `verifiersEquivalent` decides whether an observed
 * command is "the same verification" as the prescribed one by comparing the
 * resolver's `rationale` plus **set equality** of `matchedPaths`. Set equality
 * can express *identical* and *different*; it cannot express **broader**. So a
 * strictly-superior observed command is scored as a mismatch:
 *
 *   prescribed `go test ./internal/auth/...`
 *   observed   `go test ./...`            -> "relevance gap"
 *
 * Running the whole suite is the single most common thing an agent does, and
 * the gap suppresses the receipt, which breaks the evidence chain outright. In
 * a live session this produced **zero receipts in 94 minutes** of otherwise
 * correct work. That is the bug this module fixes.
 *
 * ## The question this module answers
 *
 * Not "are these the same command?" but: **does the observed command do at
 * least everything the prescribed command would?** Coverage is a partial
 * order, not an equivalence relation, and it is deliberately *directional* —
 * `covers(broad, narrow)` is true while `covers(narrow, broad)` is false
 * (FR-035).
 *
 * ## Design stance: fail closed
 *
 * Every judgment call in here resolves toward "not covered". A false gap costs
 * one redundant verification run; a false *cover* mints a receipt asserting
 * evidence that was never produced, which corrupts the ledger permanently. So
 * an unrecognised runner matches only itself (FR-036), an unparseable command
 * shape becomes an opaque runner that matches only itself, and an empty or
 * unparseable command on either side is never covering.
 *
 * ## Scope
 *
 * Pure and dependency-free by construction: no imports, no I/O, no clock, no
 * logging. It answers one boolean question so that it can be unit-tested
 * exhaustively and reused by both the measurement path and the plan-verify
 * path without dragging either's dependencies along.
 *
 * Pipe handling (FR-036a): a pipeline's altered exit status is *not* this
 * module's concern — that stays with `parseVerification`. Here a pipeline is
 * reduced to its first segment, because `go test ./... | tail -50` verifies
 * exactly what `go test ./...` verifies; the tail is presentation.
 */

// ===========================================================================
// PUBLIC TYPES
// ===========================================================================

/**
 * One sub-command of a (possibly compound) shell command, reduced to the only
 * two things coverage depends on.
 *
 * - `runner` — normalised (lowercased, whitespace-collapsed) leading program
 *   words, e.g. `"go test"`, `"npx vitest run"`, `"pytest"`. This is *what
 *   kind of work* the command does.
 * - `targets` — the path-shaped arguments, e.g. `["./internal/auth/..."]`.
 *   This is *how much* of the repo that work touches. An empty list means
 *   "everything this runner knows about" (FR-034).
 */
export interface SubCommand {
  readonly runner: string
  readonly targets: readonly string[]
  /**
   * Normalised test-SELECTOR expressions present on this sub-command
   * (`-run TestFoo`, `-t "case"`, `-k expr`, …). Empty when the sub-command
   * runs everything its targets name.
   *
   * This exists to close a fail-open that path coverage alone cannot see:
   * `go test -run TestFoo ./...` targets the whole module, so on `targets`
   * evidence it "covers" any prescribed test — while actually executing one
   * test. Minting a receipt for that is precisely the evidence-fabrication
   * this harness exists to prevent, so selectors are compared separately
   * (see `subCommandCovers`).
   *
   * OPTIONAL so a hand-constructed `SubCommand` (tests, direct API use) stays
   * valid; `parseSubcommands` always populates it. Absent is read as "no
   * selectors", which matches what a caller omitting the field means.
   */
  readonly narrowing?: readonly string[]
  /**
   * The sub-command carries a flag meaning "list/count/describe, do not run"
   * (`--collect-only`, `--version`, `--listTests`, …). Such a command verifies
   * nothing while still exiting 0, so it covers nothing. Optional for the same
   * reason as `narrowing`; `parseSubcommands` always sets it.
   */
  readonly nonExecuting?: boolean
  /**
   * Directory this sub-command actually runs in, relative to the repo root
   * ("" = root), set by a preceding `cd`/`pushd` in the same chain.
   *
   * Blanket-refusing every `cd` (the previous rule) stopped a real fabrication
   * but created a starvation trap: `cd backend && npm test` -- the most common
   * monorepo verifier shape -- could never mint a receipt, EVEN WHEN THE MODEL
   * RAN THE PRESCRIPTION VERBATIM. The gate then demanded that exact command
   * and refused to credit it, looping until the block cap gave up. Tracking the
   * directory instead keeps `cd internal/calc && go test ./...` from covering
   * `go test ./internal/...` (its targets normalise to `internal/calc/...`,
   * which is narrower) while letting an honest verbatim run match.
   */
  readonly cwd?: string
}

// ===========================================================================
// LEXICAL TABLES
// ===========================================================================

/**
 * Flags that restrict WHICH tests execute, as opposed to how many times or how
 * loudly. A sub-command carrying one of these runs a strict subset of what its
 * target paths name.
 *
 * Deliberately narrow: `-count=1` (cache-buster), `-v`, `--bail` and friends
 * are NOT selectors and must stay ignorable, or the spec's own worked example
 * (`go build ./... && go test ./... -count=1`) would stop covering. Only flags
 * that filter the test set belong here.
 *
 * Both spellings are handled: `--flag=value` (self-contained) and
 * `--flag value` (consumes the next token).
 */
const NARROWING_FLAGS: ReadonlySet<string> = new Set([
  "-run", // go test
  "-t", // vitest / jest --testNamePattern shorthand
  "--testNamePattern",
  "--test-name-pattern", // node --test
  "-k", // pytest
  "--filter", // cargo / dotnet
  "--grep", // mocha
  "-g", // mocha shorthand
  "--only",
  "--testPathPattern", // jest <= 29
  "--testPathPatterns", // jest 30 renamed it; the singular alone let it through
  "--testPathIgnorePatterns",
  // Flags that restrict the SET without naming a pattern. Reviewers proved
  // each of these mints a receipt while running a strict subset (or none) of
  // the prescribed suite.
  "-short", // go test: skips long tests
  "--changed", // vitest: only changed files
  "--onlyChanged", // jest
  "-o", // jest shorthand for --onlyChanged
  "--onlyFailures",
  "--lf", // pytest: last-failed only
  "--last-failed",
  "--ff",
  "--failed-first",
  "--stepwise",
  "-m", // pytest marker expression (also caught by module-dispatch when leading)
  "--workspace", // npm/pnpm: one workspace of many
  "-w",
  "--project", // vitest: one project of many
  "--shard", // splits the suite across machines
  "--tags", // go build tags can exclude packages
  "-tags",
])

/**
 * Narrowing flags that are narrowing only FOR A SPECIFIC RUNNER, and flags that
 * must be EXEMPTED from the global set for a specific runner.
 *
 * `--workspace` is the cautionary case: for npm/pnpm it selects ONE workspace of
 * many (narrowing, already in the global set), but for cargo it means the WHOLE
 * workspace (broadening). Scoring a full `cargo test --workspace` as narrowed
 * would suppress a legitimate receipt -- the same evidence-starvation direction
 * as the `-n` bug (pytest-xdist worker count vs go's "print, don't run").
 *
 * Cargo's real subset selectors are measured: `cargo test -p mycrate` parsed as
 * a bare whole-suite `cargo test`, because the crate name is not path-shaped and
 * so became neither a target nor a flag value -- one crate minting a receipt for
 * every crate.
 */
const RUNNER_NARROWING_FLAGS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["cargo test", new Set(["-p", "--package", "--bin", "--lib", "--example", "--bench", "--exclude"])],
])

const RUNNER_NON_NARROWING_FLAGS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["cargo test", new Set(["--workspace", "--all"])],
  // `-w` is npm/pnpm's workspace SELECTOR (narrowing, in the global set) but
  // jest/vitest's `--maxWorkers` -- parallelism, not selection. A full
  // `npx jest -w 4` was scored as narrowed and minted nothing.
  ["jest", new Set(["-w"])],
  ["vitest", new Set(["-w"])],
  // `-o` is jest's `--onlyChanged` (narrowing) but go's OUTPUT BINARY PATH and
  // pytest's `--override-ini`; neither restricts what runs.
  ["go test", new Set(["-o"])],
  ["pytest", new Set(["-o"])],
])

/**
 * Runner strings carry their launcher (`jest`, `npx jest`, `yarn jest`,
 * `python3 -m pytest`), so the scoped tables are keyed by TOOL WORD and matched
 * against the runner's tokens. An exact-string key catches `jest` and silently
 * misses `npx jest` -- a half-applied fix that reads as working.
 */
function scopedFlags(table: ReadonlyMap<string, ReadonlySet<string>>, runner: string): ReadonlySet<string> {
  const tokens = new Set(runner.split(/\s+/))
  const merged = new Set<string>()
  for (const [tool, flags] of table) {
    if (tool.split(/\s+/).every((t) => tokens.has(t))) for (const f of flags) merged.add(f)
  }
  return merged
}

/**
 * Flags meaning "do not execute anything" — list, count, or describe tests
 * instead of running them. A sub-command carrying one of these verifies
 * NOTHING, yet exits 0, so without this it would satisfy any prescription
 * whose runner it matches.
 *
 * Proven by review: `pytest --collect-only`, `npx vitest --version` and
 * `npx jest --listTests` each minted a real `vrf_…` receipt through the live
 * hook set. Treated as covering nothing at all.
 */
const NON_EXECUTING_FLAGS: ReadonlySet<string> = new Set([
  "--version",
  "--help",
  "-h",
  "--collect-only",
  "--collectonly",
  "--co",
  "--listTests",
  "--list-tests",
  "--list",
  "--dry-run",
  "--dryRun",
  "--showconfig",
  "--show-config",
])

/**
 * Non-executing flags that are only non-executing FOR A SPECIFIC RUNNER,
 * because the same spelling means something else elsewhere.
 *
 * `go test` takes single-dash flags: `-list <re>` prints matching test names
 * without running them, `-c` compiles the test binary without running it, and
 * `-n` prints the commands it would run. None can be in the global set:
 * `-n` is pytest-xdist's WORKER COUNT, so `pytest -n auto` is a perfectly
 * normal full parallel suite. Because the non-executing check is now
 * unconditional (it no longer requires a prescription to be reached), a
 * global `-n` would silently suppress every xdist receipt — the same
 * evidence-starvation failure D1 was about, just from the opposite direction.
 */
const RUNNER_NON_EXECUTING_FLAGS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["go test", new Set(["-list", "-c", "-n"])],
  // `-V` is only "print the version" for SOME runners. `ctest -V` is the
  // standard VERBOSE full test run and `mvn -V` prints the version and then
  // builds -- both were being suppressed unconditionally, with the operator
  // toasted "executes no tests" about a full suite.
  ["npm", new Set(["-V"])],
  ["npx", new Set(["-V"])],
  ["node", new Set(["-V"])],
])

/**
 * Runners for which a BARE invocation (no path arguments) genuinely means
 * "the whole suite".
 *
 * This is a per-runner property and getting it wrong is the difference between
 * a false gap and a fabricated receipt. `npm test` / `pytest` / `cargo test`
 * run everything when bare. **`go test` does NOT** — bare `go test` compiles
 * and runs only the current directory's package, so it can exit 0 while the
 * prescribed `./internal/auth/...` suite is red. That exact case was proven
 * against a real Go module during review, and it is the toolchain of the field
 * session this whole module exists to fix.
 *
 * Unlisted runners are NOT universal when bare — fail-closed, matching this
 * module's header stance.
 */
const WHOLE_SUITE_WHEN_BARE: ReadonlySet<string> = new Set([
  "npm test",
  "npm run test",
  "yarn test",
  "pnpm test",
  "npx vitest run",
  "npx vitest",
  "vitest run",
  "vitest",
  "npx jest",
  "jest",
  "npx mocha",
  "mocha",
  "pytest",
  "python -m pytest",
  "python3 -m pytest",
  "uv run pytest",
  "poetry run pytest",
  "cargo test",
])

const IGNORED_EXACT_FLAGS: ReadonlySet<string> = new Set([
  "-v",
  "--verbose",
  "--silent",
  "--no-color",
  "--color",
  "--bail",
  "--run",
  "--watch=false",
])

const IGNORED_PREFIX_FLAGS: readonly string[] = ["--reporter=", "--reporters="]

/**
 * Runners that mean "run the whole suite for this ecosystem" and are therefore
 * interchangeable *with each other* (FR-036).
 *
 * Each inner array is one equivalence class. Two runners are runner-equivalent
 * iff they are identical after normalisation **or** they share an entry here.
 * A runner absent from the table matches only itself — fail-closed, so an
 * unknown runner never silently covers something.
 *
 * The critical non-entry: `go build` is nowhere near `go test`. Compiling is
 * not testing, so a build can never cover a prescribed test no matter how
 * broad its target. Likewise the JS class and the Python class are separate
 * arrays, which is what makes cross-ecosystem coverage impossible.
 */
/**
 * Runner words that mean "this command RUNS TESTS", as opposed to linting,
 * type-checking, building or fetching.
 *
 * Needed because `parseVerification` (v1, frozen) treats a wide set of commands
 * as "verification", so with no prescription to compare against, `npx eslint .`,
 * `tsc --noEmit` and `make check` all minted receipts — and auto-attaching
 * those closed the criteria gate on evidence of nothing: an audit pinned "auth
 * service tests pass" and "migration applies cleanly", ran eslint, and the
 * session was allowed to close.
 *
 * A lint pass is a true statement about linting. It is not evidence that tests
 * pass, and only a test runner should be allowed to answer a criterion nobody
 * explicitly measured it against.
 */
const TEST_RUNNER_WORDS: ReadonlySet<string> = new Set([
  "test",
  "tests",
  "vitest",
  "jest",
  "mocha",
  "ava",
  "tap",
  "pytest",
  "unittest",
  "nose2",
  "tox",
  "rspec",
  "minitest",
  "phpunit",
  "pest",
  "ctest",
  "gotestsum",
  "cucumber",
  "playwright",
  "cypress",
])

/**
 * Does this command run tests? Judged on the runner only — flags and targets
 * are irrelevant to the question.
 */
export function isTestRunnerCommand(command: string): boolean {
  const parts = parseSubcommands(command)
  return parts.some((part) => part.runner.split(/\s+/).some((word) => TEST_RUNNER_WORDS.has(word)))
}

export const WHOLE_SUITE_ALIASES: readonly (readonly string[])[] = [
  // JavaScript / TypeScript whole-suite invocations. Per the spec:
  // `npm test` == `npx vitest run` == `npx jest` within a JS project.
  [
    "npm test",
    "npm t",
    "npm run test",
    "yarn test",
    "yarn run test",
    "pnpm test",
    "pnpm run test",
    "npx vitest run",
    "npx vitest",
    "vitest run",
    "vitest",
    "npx jest",
    "jest",
    "npx mocha",
    "mocha",
  ],
  // Python: the same pytest runner reached through different launchers.
  ["pytest", "python -m pytest", "python3 -m pytest", "py -m pytest", "uv run pytest", "poetry run pytest"],
]

/** runner -> index of its equivalence class in `WHOLE_SUITE_ALIASES`. */
const ALIAS_GROUP_BY_RUNNER: ReadonlyMap<string, number> = (() => {
  const map = new Map<string, number>()
  WHOLE_SUITE_ALIASES.forEach((group, index) => {
    for (const runner of group) map.set(normalizeRunner(runner), index)
  })
  return map
})()

/**
 * Flags whose *value* names the program to run rather than an option to it, so
 * the value belongs to the runner. Without this, `python -m pytest` and
 * `python -m mypy` both reduce to runner `"python"` with no targets and would
 * cover each other — a type-check "covering" a test run, which is exactly the
 * class of error this module exists to prevent.
 *
 * Side effect, deliberately accepted: `pytest -m slow` also absorbs into
 * runner `"pytest -m slow"`, which matches only itself. That means a full
 * `pytest` run is not credited as covering a prescribed marker-filtered run.
 * That is a false gap (the safe direction), not a false cover.
 */
const MODULE_DISPATCH_FLAGS: ReadonlySet<string> = new Set(["-m", "--module"])

// ===========================================================================
// TOKENISATION
// ===========================================================================

/** `CI=1 go test ./...` — leading `NAME=value` shell assignments. */
const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/

/** A bare redirection operator (`>`, `>>`, `2>`, `&>`, `<`) — its *next* token is the target. */
const REDIRECT_OPERATOR_RE = /^(?:\d+|&)?(?:>>|>|<)$/

/** A redirection with its target attached (`2>&1`, `>/dev/null`, `&>>log.txt`). */
const REDIRECT_WITH_TARGET_RE = /^(?:\d+|&)?(?:>>|>|<).+$/

/** Compound-command separators. `\|\|` must precede the pipe handling so that
 *  `a || b` splits into two commands rather than being read as a pipeline. */
const COMPOUND_SEPARATOR_RE = /&&|\|\||;/

/**
 * `||` alternation, split out separately because it is the one separator whose
 * operands are NOT all guaranteed to have run.
 *
 * For an observed `A || B` that exited 0, exactly one of A or B succeeded and
 * we cannot tell which: either A succeeded (B never ran), or A failed and B
 * succeeded. Treating both as coverage candidates — which a flat split does —
 * lets a prescribed `B` be credited by a command in which `B` never executed.
 * That mints a receipt for evidence never produced, the single worst failure
 * mode in this codebase, so the fail-closed stance in this module's header
 * requires crediting NEITHER operand.
 *
 * Scoped to the observed side only: on the prescribed side an `||` merely
 * describes what was asked for, and dropping operands there would loosen the
 * requirement rather than tighten it.
 */
const ALTERNATION_SEPARATOR_RE = /\|\|/

function isIgnoredFlag(token: string): boolean {
  if (IGNORED_EXACT_FLAGS.has(token)) return true
  return IGNORED_PREFIX_FLAGS.some((prefix) => token.startsWith(prefix))
}

function isFlagToken(token: string): boolean {
  return token.startsWith("-")
}

/**
 * A token that names a filesystem location rather than a program word or an
 * option value: it contains a separator (`/`), an extension dot (`.`), a glob
 * (`*`), or is Go's bare recursive wildcard `...`.
 *
 * This is a heuristic and it is the right kind of heuristic for a fail-closed
 * design: a *false positive* (a non-path token read as a target) only ever
 * makes coverage harder to establish, because it adds a requirement the
 * observed side must satisfy.
 */
function isPathShaped(token: string): boolean {
  if (token === "...") return true
  return token.includes("/") || token.includes(".") || token.includes("*")
}

/**
 * Drop everything that is shell plumbing rather than verification intent:
 * leading env assignments, redirections (and the filename a bare redirection
 * operator points at), a trailing background `&`, and the presentational flags in
 * `IGNORED_EXACT_FLAGS` / `IGNORED_PREFIX_FLAGS`.
 */
function cleanTokens(tokens: readonly string[]): string[] {
  const cleaned: string[] = []
  let index = 0

  while (index < tokens.length && ENV_ASSIGNMENT_RE.test(tokens[index])) index++

  for (; index < tokens.length; index++) {
    const token = tokens[index]
    if (token === "&") continue
    if (REDIRECT_OPERATOR_RE.test(token)) {
      // `2> file` — the operator and the filename that follows it both go.
      index++
      continue
    }
    if (REDIRECT_WITH_TARGET_RE.test(token)) continue
    if (isIgnoredFlag(token)) continue
    cleaned.push(token)
  }

  return cleaned
}

/** Lowercase + collapse internal whitespace, so `"GO  TEST"` == `"go test"`. */
function normalizeRunner(runner: string): string {
  return runner.trim().replace(/\s+/g, " ").toLowerCase()
}

// ===========================================================================
// PARSING
// ===========================================================================

/**
 * Split a (possibly compound) shell command into the sub-commands coverage
 * reasons about (FR-036a).
 *
 * Handled: `&&`, `;`, `||` separators; pipelines (only the **first** segment
 * survives — `cmd | tail -50` verifies whatever `cmd` verifies); shell
 * redirections; ignored flags; empty fragments.
 *
 * Not handled: quoting. A `;` or `&&` inside a quoted string will split the
 * command. That degrades toward *more* sub-commands, which on the prescribed
 * side means more requirements to satisfy and on the observed side means extra
 * candidates that match nothing — i.e. it fails closed, never open.
 *
 * Sub-command shapes:
 *   - normal:  leading program words become the runner, path-shaped arguments
 *              become targets — `go test ./internal/a/...`
 *   - opaque:  a command that starts with a path or a flag (`./scripts/ci.sh`,
 *              `--help`) has no recognisable program word. Rather than guess,
 *              the entire cleaned token sequence becomes the runner with no
 *              targets, so it is equivalent only to a byte-identical command.
 *              This is what keeps `./gradlew test` from covering
 *              `./gradlew build`.
 */
/**
 * Shell wrappers whose LAST argument is a command string to execute.
 * `bash -lc "go test ./..."` is a real full-suite run, but parsing it
 * literally yields runner `bash`, which matches no prescription — so a
 * legitimate verifier minted NOTHING. That is the D1 evidence-starvation
 * direction, and it flipped on unrelated state: with no prescription present
 * the same command minted a receipt. Unwrap to the inner command instead.
 */
const SHELL_WRAPPER_RE = /^(?:\/usr\/bin\/env\s+)?(?:bash|sh|zsh|dash|ksh)\s+-[a-z]*c\s+(.+)$/s

/**
 * Prefixes that run another command unchanged. `timeout 300 go test ./...`
 * parsed as the runner string "timeout 300 go test ./...", so the numeric
 * argument became part of the runner and the command could not match ANY
 * prescription -- not even itself with a different timeout. `timeout`, `env`
 * and `time` are near-universal in agent-run and CI-derived verifiers, so this
 * was silently starving very ordinary commands.
 *
 * The number is how many of the prefix's OWN positional arguments to drop;
 * flag-shaped tokens and `VAR=value` assignments are skipped generically.
 */
const TRANSPARENT_PREFIXES: ReadonlyMap<string, number> = new Map([
  ["timeout", 1],
  ["time", 0],
  ["nice", 0],
  ["ionice", 0],
  ["stdbuf", 0],
  ["command", 0],
  ["env", 0],
])

function stripTransparentPrefixes(command: string): string {
  let tokens = command.trim().split(/\s+/).filter(Boolean)
  for (let guard = 0; guard < 4 && tokens.length > 1; guard++) {
    const positional = TRANSPARENT_PREFIXES.get(tokens[0])
    if (positional === undefined) break
    let i = 1
    while (i < tokens.length && tokens[i].startsWith("-")) i++
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++
    i += positional
    if (i >= tokens.length) break
    tokens = tokens.slice(i)
  }
  return tokens.join(" ")
}

function unwrapShellWrapper(command: string): string {
  let current = command.trim()
  // Bounded: a wrapper nested more than a few deep is pathological, and an
  // unbounded loop here would be a DoS on a hot path.
  for (let depth = 0; depth < 3; depth++) {
    const m = SHELL_WRAPPER_RE.exec(current)
    if (!m) break
    let inner = m[1].trim()
    const q = inner[0]
    if ((q === '"' || q === "'") && inner.endsWith(q) && inner.length >= 2) {
      inner = inner.slice(1, -1)
    }
    if (!inner) break
    current = inner.trim()
  }
  return stripTransparentPrefixes(current)
}

/**
 * Does the chain change the working directory before running the verifier?
 *
 * `cd internal/calc && go test ./...` parsed literally looks like a WHOLE-TREE
 * run (`./...`), so it was scored as covering `go test ./internal/...` —
 * minting a receipt for sibling packages that never ran. Relative targets after
 * a `cd` are relative to somewhere else entirely, and the prescription is
 * expressed relative to the repo root, so the two are simply not comparable.
 *
 * Fails CLOSED: an unknown working directory means no coverage, never assumed
 * coverage. The cost is a missed receipt on `cd . && …`-style no-ops; the cost
 * of the opposite choice is fabricated evidence, which is the worst defect this
 * codebase can produce.
 */
const DIRECTORY_CHANGING_RUNNERS: ReadonlySet<string> = new Set(["cd", "pushd", "popd", "chdir"])

/**
 * `go -C <dir>` changes directory as surely as `cd`, but `toSubCommand` breaks
 * its runner scan at the leading `-C` and DROPS both the flag and the
 * directory: `go -C other build ./...` reduced to runner "go", targets
 * ["./..."], which then covered a prescribed `go -C services/api test ./...`
 * -- a compile in a different directory credited as a test run. The directory
 * is unrecoverable after parsing, so this shape is refused rather than
 * normalised. The resolver never emits `go -C`; story verifiers are
 * model-authored and pass through verbatim.
 */
export const DIR_CHANGING_FLAG_RE = /(?:^|\s)-C(?:\s|=)/

export function changesWorkingDirectory(command: string): boolean {
  // Match the FIRST TOKEN, not the whole runner string: `cd internal/calc`
  // parses as runner "cd" (the arg is path-shaped) but `pushd sub` parses as
  // runner "pushd sub" (the arg is not), so an exact-string check silently
  // missed half the cases.
  // Strip grouping punctuation: `{ cd other && go test ./...; }` parsed its
  // first runner as "{", so the guard never saw the `cd` at all.
  return parseSubcommands(command).some((part) => {
    const words = part.runner.split(" ").filter((w) => !/^[{}()]+$/.test(w))
    return words.length > 0 && DIRECTORY_CHANGING_RUNNERS.has(words[0])
  })
}

/** Sentinel for a directory OUTSIDE the worktree. `..` popping an empty stack
 * used to clamp silently to the repo root, so `cd .. && npm test` -- a run in
 * the PARENT directory -- was scored as a root run and minted a receipt.
 * Anything outside is incomparable with a root-relative prescription. */
const OUTSIDE_WORKTREE = "\u0000outside"

function joinDir(base: string, next: string): string {
  if (base === OUTSIDE_WORKTREE) return OUTSIDE_WORKTREE
  if (next.startsWith("/")) return OUTSIDE_WORKTREE
  const parts = `${base}/${next}`.split("/").filter((p) => p.length > 0 && p !== ".")
  const out: string[] = []
  for (const part of parts) {
    if (part === "..") {
      if (out.length === 0) return OUTSIDE_WORKTREE
      out.pop()
    } else out.push(part)
  }
  return out.join("/")
}

/**
 * FR-013 — re-express an ABSOLUTE path that lies inside the worktree as a path
 * relative to the worktree root. Returns `null` when the path is not absolute,
 * when it is absolute but lies outside the root, or when no root was supplied.
 *
 * ## Why this exists (measured, not hypothesised)
 *
 * Story verifiers are model-authored and are written relative to the worktree
 * (`test -f research/crispr-gene-editing.md`), because that is how a plan reads.
 * The command the agent actually runs is captured verbatim from the tool call,
 * and agents routinely spell paths absolutely
 * (`test -f /workspace/vertextest2/research/crispr-gene-editing.md`). Those two
 * strings name the SAME FILE and every path-level comparison in this module
 * scored them as disjoint: `["workspace","vertextest2","research","…"]` is not
 * segment-equal to `["research","…"]`.
 *
 * Consequence in the audited session (`ses_04dc77bdaffej8SFJvYm5yO0CW`):
 * **146 `verify:relevance-gap` events and ZERO receipts minted**, while the
 * agent was in fact running the stories' own declared verifiers one at a time.
 * An empty receipt store then starved the judge's cross-check of any data,
 * which is how a path-matching detail became a judge-reliability defect.
 *
 * ## Why it stays fail-closed
 *
 * Only a path under the root is rewritten. `/tmp/elsewhere/x` is left absolute
 * and therefore still matches nothing root-relative — a run outside the
 * worktree is not evidence about the worktree, and `cd /tmp/elsewhere && npm
 * test` must keep failing to cover a prescribed `npm test` (it does). The root
 * itself maps to `"."`, i.e. "this location", never to a universal target — so
 * normalisation can only make two names for one path agree, never widen what a
 * command is credited with. With no root supplied every call returns `null`
 * and the module behaves byte-identically to before.
 */
function rootRelative(path: string, root: string | undefined): string | null {
  if (root === undefined) return null
  // Only an ABSOLUTE root can anchor an absolute path. A relative or empty root
  // would make the prefix test meaningless (every path "starts with" "").
  const base = root.replace(/\/+$/, "")
  if (base === "" || !base.startsWith("/")) return null
  if (!path.startsWith("/")) return null
  if (path === base || path === `${base}/`) return "."
  if (!path.startsWith(`${base}/`)) return null
  const rest = path.slice(base.length + 1).replace(/^\/+/, "")
  return rest === "" ? "." : rest
}

/**
 * Fold `cd` effects into the chain: each surviving sub-command records the
 * directory it runs in, and its relative targets are re-expressed from the repo
 * root. `cd` parts execute nothing, so they are dropped once folded.
 *
 * FR-013 adds the absolute-path axis: when `root` is known, a path under it is
 * rebased onto the root here, in the one place that already owns "re-express
 * this target from the repo root".
 */
function applyDirectoryChanges(parts: SubCommand[], root: string | undefined): SubCommand[] {
  let cwd = ""
  const out: SubCommand[] = []
  for (const part of parts) {
    const words = part.runner.split(" ").filter((w) => !/^[{}()]+$/.test(w))
    if (words.length > 0 && DIRECTORY_CHANGING_RUNNERS.has(words[0])) {
      const dir = part.targets[0] ?? words[1] ?? ""
      const rebased = rootRelative(dir, root)
      // An absolute `cd` REPLACES the working directory, it does not append to
      // it: `cd sub && cd <root>` lands at the root, not at `sub/`. Joining
      // from "" rather than from `cwd` is what encodes that.
      if (rebased !== null) cwd = joinDir("", rebased)
      else if (dir) cwd = joinDir(cwd, dir)
      continue
    }
    // An absolute target is CWD-INDEPENDENT — `/root/a/b.md` names the same file
    // whatever directory the command runs in — so it is rebased here and then
    // exempted from the cwd re-rooting below. Getting that order wrong would
    // turn `cd sub && test -f /root/a.md` into `sub/a.md`, a file that need not
    // exist.
    const rebased = part.targets.map((t) => {
      const rel = rootRelative(t, root)
      return { value: rel ?? t, absolute: rel !== null }
    })
    if (cwd === "") {
      // Leave `cwd` ABSENT at the repo root rather than setting "". Absent and
      // "" mean the same thing to every reader, and omitting it keeps the
      // parsed shape byte-identical for the common case — including when no
      // target was rebased, where the original object is passed through.
      out.push(rebased.some((r) => r.absolute) ? { ...part, targets: rebased.map((r) => r.value) } : part)
      continue
    }
    out.push({
      ...part,
      cwd,
      targets: rebased.map(({ value: t, absolute }) => {
        if (absolute) return t
        if (t.startsWith("/")) return t
        const recursive = t.endsWith("/...")
        const bare = recursive ? t.slice(0, -4) : t
        const joined = joinDir(cwd, bare.replace(/^\.\//, ""))
        // Preserve the leading "./": the prescribed side is parsed with no cwd,
        // so it keeps `./internal/auth/...`. Dropping the prefix here made an
        // honest `cd internal && go test ./auth/...` fail to match it.
        const rooted = joined === "" ? "." : `./${joined}`
        return recursive ? `${rooted}/...` : rooted
      }),
    })
  }
  return out
}

/**
 * `workspaceRoot` is OPTIONAL and defaults to "unknown" (FR-013): callers that
 * have no root — `changesWorkingDirectory`, `isTestRunnerCommand`, direct test
 * use — get exactly the previous parse, and only a caller that supplies a root
 * gains absolute-path normalisation.
 */
export function parseSubcommands(command: string, workspaceRoot?: string): SubCommand[] {
  const subCommands: SubCommand[] = []

  for (const rawPart of unwrapShellWrapper(command).split(COMPOUND_SEPARATOR_RE)) {
    // FR-036a: a pipeline's meaningful command is its head; the rest is
    // formatting. Exit-status semantics of the pipe stay with parseVerification.
    const head = rawPart.split("|")[0]
    const tokens = cleanTokens(head.trim().split(/\s+/).filter(Boolean))
    if (tokens.length === 0) continue

    const parsed = toSubCommand(tokens)
    if (parsed) subCommands.push(parsed)
  }

  return applyDirectoryChanges(subCommands, workspaceRoot)
}

function toSubCommand(tokens: readonly string[]): SubCommand | null {
  const runnerTokens: string[] = []
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index]
    if (isFlagToken(token) || isPathShaped(token)) break
    runnerTokens.push(token)
    index++
  }

  // `python -m pytest`: the flag's value names the program, so it is runner.
  const dispatchFlag = tokens[index]
  const dispatchValue = tokens[index + 1]
  if (
    runnerTokens.length > 0 &&
    dispatchFlag !== undefined &&
    MODULE_DISPATCH_FLAGS.has(dispatchFlag) &&
    dispatchValue !== undefined &&
    !isFlagToken(dispatchValue) &&
    !isPathShaped(dispatchValue)
  ) {
    runnerTokens.push(dispatchFlag, dispatchValue)
    index += 2
  }

  if (runnerTokens.length === 0) {
    // Opaque shape — no program word at the head. Match only ourselves.
    return { runner: normalizeRunner(tokens.join(" ")), targets: [], narrowing: [], nonExecuting: false }
  }

  const rest = tokens.slice(index)

  const targets = rest
    .filter((token) => !isFlagToken(token))
    .filter((token) => isPathShaped(token))

  const runner = normalizeRunner(runnerTokens.join(" "))
  const runnerScoped = scopedFlags(RUNNER_NON_EXECUTING_FLAGS, runner)

  return {
    runner,
    targets,
    narrowing: extractNarrowing(rest, runner),
    nonExecuting: rest.some((token) => {
      const flag = token.split("=")[0]
      return NON_EXECUTING_FLAGS.has(flag) || runnerScoped.has(flag)
    }),
  }
}

/**
 * Collect normalised test-selector expressions (`-run TestFoo`, `-k expr`,
 * `--testNamePattern=x`). Both `--flag=value` and `--flag value` spellings are
 * recognised; the value is included so an identical selector on both sides can
 * be matched exactly.
 *
 * A selector flag whose value is missing or is itself a flag still counts as
 * narrowing (recorded with an empty value) — fail-closed, because an
 * unparseable selector is more likely to restrict the run than to widen it.
 */
function extractNarrowing(tokens: readonly string[], runner: string): string[] {
  const scopedNarrowing = scopedFlags(RUNNER_NARROWING_FLAGS, runner)
  const scopedExempt = scopedFlags(RUNNER_NON_NARROWING_FLAGS, runner)
  const narrows = (flag: string): boolean => {
    if (scopedExempt.has(flag)) return false
    return NARROWING_FLAGS.has(flag) || scopedNarrowing.has(flag)
  }

  const found: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (!isFlagToken(token)) continue

    const eq = token.indexOf("=")
    if (eq > 0) {
      const name = token.slice(0, eq)
      if (narrows(name)) found.push(`${name}=${token.slice(eq + 1)}`)
      continue
    }

    if (!narrows(token)) continue
    const value = tokens[i + 1]
    if (value !== undefined && !isFlagToken(value)) {
      found.push(`${token}=${value}`)
      i++
    } else {
      found.push(`${token}=`)
    }
  }
  return found.sort()
}

// ===========================================================================
// RUNNER EQUIVALENCE
// ===========================================================================

/**
 * FR-036 — two runners describe the same kind of work.
 *
 * True iff identical after normalisation, or both listed in the same entry of
 * `WHOLE_SUITE_ALIASES`. Anything else is false, including every
 * cross-ecosystem pair and — critically — `go build` vs `go test`.
 */
export function runnerEquivalent(a: string, b: string): boolean {
  const left = normalizeRunner(a)
  const right = normalizeRunner(b)
  if (left.length === 0 || right.length === 0) return false
  if (left === right) return true

  const leftGroup = ALIAS_GROUP_BY_RUNNER.get(left)
  if (leftGroup === undefined) return false
  return leftGroup === ALIAS_GROUP_BY_RUNNER.get(right)
}

// ===========================================================================
// TARGET COVERAGE
// ===========================================================================

/**
 * A target argument decomposed into path segments plus whether it recurses.
 *
 * Segments (not raw strings) are the unit of comparison on purpose: plain
 * string prefixing would let `src/a` "cover" `src/ab`, which is wrong — they
 * are unrelated directories that merely share a character prefix.
 */
interface ParsedTarget {
  readonly segments: readonly string[]
  readonly recursive: boolean
}

/**
 * `./internal/auth/...` -> `{ segments: ["internal","auth"], recursive: true }`
 * `./...`               -> `{ segments: [], recursive: true }`  (universal)
 * `tests/lexer.test.ts` -> `{ segments: ["tests","lexer.test.ts"], recursive: false }`
 * `.`                   -> `{ segments: [], recursive: false }` (this package only)
 *
 * Recursion markers are recognised only as whole trailing segments (`/...`,
 * `/**`, or the bare `...` / `**`). A token like `src/a**` is left literal, so
 * it matches only itself — again the fail-closed direction, since guessing at
 * partial-segment glob semantics could easily over-claim.
 */
function parseTarget(raw: string): ParsedTarget {
  let path = raw.trim()
  while (path.startsWith("./")) path = path.slice(2)

  let recursive = false
  if (path === "..." || path === "**") {
    recursive = true
    path = ""
  } else if (path.endsWith("/...")) {
    recursive = true
    path = path.slice(0, -4)
  } else if (path.endsWith("/**")) {
    recursive = true
    path = path.slice(0, -3)
  }

  path = path.replace(/\/+$/, "")
  const segments = path.split("/").filter((segment) => segment.length > 0 && segment !== ".")
  return { segments, recursive }
}

/** A recursive target rooted at the top of the tree — it covers everything. */
function isUniversalTarget(target: ParsedTarget): boolean {
  return target.recursive && target.segments.length === 0
}

function segmentsEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((segment, i) => segment === b[i])
}

/** Segment-wise ancestor test — `["src","a"]` is NOT a prefix of `["src","ab"]`. */
function isSegmentPrefix(ancestor: readonly string[], descendant: readonly string[]): boolean {
  return ancestor.length <= descendant.length && ancestor.every((segment, i) => segment === descendant[i])
}

function parsedTargetCovers(observed: ParsedTarget, prescribed: ParsedTarget): boolean {
  // A recursive observed target covers itself and everything beneath it.
  if (observed.recursive) return isSegmentPrefix(observed.segments, prescribed.segments)
  // A non-recursive observed target runs exactly one location, so it cannot
  // stand in for a prescribed target that recurses into children.
  return !prescribed.recursive && segmentsEqual(observed.segments, prescribed.segments)
}

/**
 * Does a single observed target argument cover a single prescribed one?
 * Exported for direct testing of the segment-awareness contract.
 */
export function targetCovers(observedTarget: string, prescribedTarget: string): boolean {
  return parsedTargetCovers(parseTarget(observedTarget), parseTarget(prescribedTarget))
}

/**
 * FR-034 / FR-035 — does the observed target set reach everything the
 * prescribed target set does?
 *
 * Three cases, and the middle one is the one the spec's literal wording leaves
 * dangerous:
 *
 * 1. **Observed empty** -> true. A path-free invocation (`npm test`, `pytest`)
 *    is a whole-suite run and targets everything for its runner (FR-034).
 * 2. **Prescribed empty, observed non-empty** -> the *prescribed* command was
 *    the whole-suite one, so a narrowed observed run does not cover it. The
 *    spec's `every p in P` phrasing is vacuously true here, which would be a
 *    false cover in exactly the direction FR-035 forbids; we require an
 *    explicit universal observed target (`./...`, `**`) instead.
 * 3. Otherwise every prescribed target needs an observed target that is it or
 *    a recursive ancestor of it.
 */
export function targetsCover(observedTargets: readonly string[], prescribedTargets: readonly string[]): boolean {
  if (observedTargets.length === 0) return true

  const observed = observedTargets.map(parseTarget)
  if (prescribedTargets.length === 0) return observed.some(isUniversalTarget)

  return prescribedTargets
    .map(parseTarget)
    .every((prescribed) => observed.some((candidate) => parsedTargetCovers(candidate, prescribed)))
}

// ===========================================================================
// COVERAGE
// ===========================================================================

/** One observed sub-command covers one prescribed sub-command. */
/** `-w pkg` / `--workspace pkg` — selects WHICH package runs, not which tests. */
const WORKSPACE_SELECTOR_RE = /^(?:-w|--workspace)=/

export function subCommandCovers(observed: SubCommand, prescribed: SubCommand): boolean {
  if (!runnerEquivalent(observed.runner, prescribed.runner)) return false

  // The observed run must happen at or ABOVE the prescribed directory. Running
  // in `backend` cannot evidence a prescription rooted at the repo; running at
  // the repo root can evidence one rooted at `backend`, subject to targets.
  const observedCwd = observed.cwd ?? ""
  const prescribedCwd = prescribed.cwd ?? ""
  // Only for a BARE invocation. Once a sub-command names targets they have
  // already been re-expressed from the repo root by `applyDirectoryChanges`, so
  // they describe the true scope and the directory is redundant --
  // `cd internal && go test ./auth/...` normalises to `./internal/auth/...`
  // and must still cover a prescription written that way. A bare command has
  // no targets to speak for it, so the directory is all there is.
  // A run outside the worktree evidences nothing inside it.
  if (observedCwd === OUTSIDE_WORKTREE) return false

  if (observed.targets.length === 0) {
    // Observed ran somewhere OTHER than at-or-above the prescribed directory.
    if (observedCwd !== "" && observedCwd !== prescribedCwd && !prescribedCwd.startsWith(`${observedCwd}/`)) {
      return false
    }
    // ...and the mirror case: a bare run at the ROOT against a prescription
    // scoped by `cd`. `cd backend && npm test` was prescribed precisely because
    // the root script does not necessarily enter `backend/` -- the same
    // non-recursing-root hazard the `-w` rule below closes for npm workspaces.
    if (observedCwd === "" && prescribedCwd !== "" && prescribed.targets.length === 0) {
      return false
    }
  }
  if (!narrowingAllows(observed.narrowing, prescribed.narrowing)) return false

  // Ran nothing => covers nothing (see NON_EXECUTING_FLAGS).
  if (observed.nonExecuting === true) return false

  // A BARE observed command is only universal for runners that actually run
  // everything when bare. `go test` does not — it runs the cwd package only,
  // so it must never be credited for a prescribed `./internal/auth/...`.
  // A bare-for-bare comparison still covers: it is the identical invocation.
  // A bare whole-suite invocation does not cover a prescription that carries a
  // SELECTOR. Measured: `npm test` was credited as covering
  // `npm test -w packages/api`, but an npm workspace root's `test` script
  // frequently does not recurse -- a receipt asserting `packages/api` was
  // verified by a command that never entered it. This is the same hazard
  // `go test` is excluded from WHOLE_SUITE_WHEN_BARE for, and the resolver only
  // emits `-w` when a workspace layout exists, i.e. exactly when a bare root
  // script is least likely to be the whole suite.
  // WORKSPACE selectors only -- not test selectors. For a test selector,
  // "broader is fine": an unfiltered run genuinely does cover a filtered
  // prescription. A workspace selector is different in kind: an npm workspace
  // root's `test` script frequently does not recurse, so bare `npm test` can
  // exit 0 having entered no workspace at all, and crediting it for
  // `npm test -w packages/api` asserts a package was verified by a command that
  // never touched it. (This is the same hazard `go test` is excluded from
  // WHOLE_SUITE_WHEN_BARE for.)
  const prescribedWorkspaces = (prescribed.narrowing ?? []).filter((n) => WORKSPACE_SELECTOR_RE.test(n))
  if (prescribedWorkspaces.length > 0) {
    const observedWorkspaces = (observed.narrowing ?? []).filter((n) => WORKSPACE_SELECTOR_RE.test(n))
    if (observedWorkspaces.length === 0) return false
  }

  if (observed.targets.length === 0 && !WHOLE_SUITE_WHEN_BARE.has(observed.runner)) {
    return prescribed.targets.length === 0
  }

  return targetsCover(observed.targets, prescribed.targets)
}

/**
 * The observed command must not filter the test set more than the prescribed
 * one did: every selector the observed run applies must also have been applied
 * by the prescription.
 *
 *   observed {}                prescribed {}                -> allowed
 *   observed {}                prescribed {-run=Foo}        -> allowed (broader)
 *   observed {-run=Foo}        prescribed {}                -> REFUSED (narrower)
 *   observed {-run=Foo}        prescribed {-run=Foo}        -> allowed (identical)
 *   observed {-run=Foo}        prescribed {-run=Bar}        -> REFUSED (different subset)
 *
 * Without this, `go test -run TestFoo ./...` would satisfy any prescribed test
 * for the module on path evidence alone, minting a receipt for a single test
 * as though the suite had run.
 */
function narrowingAllows(
  observed: readonly string[] | undefined,
  prescribed: readonly string[] | undefined,
): boolean {
  if (!observed || observed.length === 0) return true
  const allowed = new Set(prescribed ?? [])
  return observed.every((selector) => allowed.has(selector))
}

/**
 * FR-033 — the entry point. `true` when the observed command does at least
 * everything the prescribed command would, i.e. every prescribed sub-command
 * finds *some* observed sub-command that covers it.
 *
 * Note the asymmetry, which is intentional: extra observed sub-commands are
 * free (running more is never a problem), missing ones are fatal.
 *
 * Either side parsing to zero sub-commands (empty string, whitespace, pure
 * redirection noise) returns `false`: there is no evidence that anything was
 * verified, and inventing coverage from nothing is the one error mode this
 * module must never have.
 */
/**
 * Does this command execute nothing? (`--collect-only`, `--version`,
 * `--listTests`, `--dry-run`, …)
 *
 * Exported separately because it is a property of the OBSERVED command ALONE,
 * independent of any prescription. UAT proved why that distinction matters:
 * with no plan and no file edits there is no prescription, so
 * `observedCoversPrescribed` is never called — and
 * `python3 -m pytest --collect-only` minted a real receipt while running zero
 * tests. The caller must refuse these unconditionally, before any coverage
 * comparison.
 */
export function isNonExecutingCommand(command: string): boolean {
  // Sub-commands that are pure shell plumbing and can never BE the verifier.
  // They must not decide the question either way: including them made `every`
  // miss `pytest --collect-only && echo done` (echo executes, so the chain
  // "wasn't" non-executing), while `some` then over-corrected and condemned
  // `node --version && npm test` -- a version probe chained before a real
  // suite, which the harness's own `&&`-joined prescriptions actively induce.
  const NOOP_RUNNERS = new Set(["echo", "true", "false", ":", "printf", "cd", "pushd", "popd"])
  const parts = parseSubcommands(command).filter((p) => !NOOP_RUNNERS.has(p.runner.split(" ")[0]))
  // `some`, NOT `every`: `pytest --collect-only && echo done` slipped past an
  // `every` check, because `echo done` is an ordinary executing sub-command, so
  // the quantifier went false and the guard was skipped entirely -- a real
  // receipt for a chain that ran zero tests. If ANY part lists/describes instead
  // of running, the chain is not evidence.
  // With plumbing removed, EVERY remaining sub-command must be non-executing
  // for the chain to prove nothing.
  return parts.length > 0 && parts.every((p) => p.nonExecuting === true)
}

/**
 * `workspaceRoot` (FR-013, OPTIONAL) is the absolute worktree root that both
 * sides' paths are interpreted against, so an observed
 * `test -f /workspace/vertextest2/research/x.md` can be recognised as the
 * declared `test -f research/x.md`. Both sides are normalised, because either
 * may be the absolutely-spelled one. Omitting it preserves the previous
 * behaviour exactly (`rootRelative` returns `null` for every path), so the
 * callers that genuinely have no session — and every existing test — are
 * unaffected. See `rootRelative` for the 146-gaps/0-receipts measurement that
 * motivated this.
 */
export function observedCoversPrescribed(prescribed: string, observed: string, workspaceRoot?: string): boolean {
  // `go -C` is refused on either side: the directory is unrecoverable after
  // parsing (see DIR_CHANGING_FLAG_RE), so there is nothing to normalise.
  // Plain `cd` is NOT refused -- it is folded into each sub-command's `cwd`.
  // Test only the command HEADS: `-C` after a pipe (`| grep -C 3 FAIL`) is a
  // display flag and cannot affect what ran, but a raw whole-string match
  // refused that entire command -- a routine agent idiom.
  const headOf = (c: string): string => unwrapShellWrapper(c).split("|")[0]
  if (DIR_CHANGING_FLAG_RE.test(headOf(observed)) || DIR_CHANGING_FLAG_RE.test(headOf(prescribed))) return false

  const prescribedParts = parseSubcommands(prescribed, workspaceRoot)
  // `||` operands are dropped from the OBSERVED side: for `A || B` that exited
  // 0 we cannot tell which one ran, so crediting either could mint a receipt
  // for a verifier that never executed (see ALTERNATION_SEPARATOR_RE).
  const observedParts = ALTERNATION_SEPARATOR_RE.test(observed) ? [] : parseSubcommands(observed, workspaceRoot)
  if (prescribedParts.length === 0 || observedParts.length === 0) return false

  return prescribedParts.every((part) => observedParts.some((candidate) => subCommandCovers(candidate, part)))
}
