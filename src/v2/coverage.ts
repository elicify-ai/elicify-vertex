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
  "-V",
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
  return current
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

export function changesWorkingDirectory(command: string): boolean {
  // Match the FIRST TOKEN, not the whole runner string: `cd internal/calc`
  // parses as runner "cd" (the arg is path-shaped) but `pushd sub` parses as
  // runner "pushd sub" (the arg is not), so an exact-string check silently
  // missed half the cases.
  return parseSubcommands(command).some((part) => DIRECTORY_CHANGING_RUNNERS.has(part.runner.split(" ")[0]))
}

export function parseSubcommands(command: string): SubCommand[] {
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

  return subCommands
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
  const runnerScoped = RUNNER_NON_EXECUTING_FLAGS.get(runner)

  return {
    runner,
    targets,
    narrowing: extractNarrowing(rest),
    nonExecuting: rest.some((token) => {
      const flag = token.split("=")[0]
      return NON_EXECUTING_FLAGS.has(flag) || runnerScoped?.has(flag) === true
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
function extractNarrowing(tokens: readonly string[]): string[] {
  const found: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (!isFlagToken(token)) continue

    const eq = token.indexOf("=")
    if (eq > 0) {
      const name = token.slice(0, eq)
      if (NARROWING_FLAGS.has(name)) found.push(`${name}=${token.slice(eq + 1)}`)
      continue
    }

    if (!NARROWING_FLAGS.has(token)) continue
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
export function subCommandCovers(observed: SubCommand, prescribed: SubCommand): boolean {
  if (!runnerEquivalent(observed.runner, prescribed.runner)) return false
  if (!narrowingAllows(observed.narrowing, prescribed.narrowing)) return false

  // Ran nothing => covers nothing (see NON_EXECUTING_FLAGS).
  if (observed.nonExecuting === true) return false

  // A BARE observed command is only universal for runners that actually run
  // everything when bare. `go test` does not — it runs the cwd package only,
  // so it must never be credited for a prescribed `./internal/auth/...`.
  // A bare-for-bare comparison still covers: it is the identical invocation.
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
  const parts = parseSubcommands(command)
  return parts.length > 0 && parts.every((p) => p.nonExecuting === true)
}

export function observedCoversPrescribed(prescribed: string, observed: string): boolean {
  // A `cd` anywhere in the chain makes every relative target incomparable with
  // a root-relative prescription. Refuse before any target maths.
  if (changesWorkingDirectory(observed)) return false

  const prescribedParts = parseSubcommands(prescribed)
  // `||` operands are dropped from the OBSERVED side: for `A || B` that exited
  // 0 we cannot tell which one ran, so crediting either could mint a receipt
  // for a verifier that never executed (see ALTERNATION_SEPARATOR_RE).
  const observedParts = ALTERNATION_SEPARATOR_RE.test(observed) ? [] : parseSubcommands(observed)
  if (prescribedParts.length === 0 || observedParts.length === 0) return false

  return prescribedParts.every((part) => observedParts.some((candidate) => subCommandCovers(candidate, part)))
}
