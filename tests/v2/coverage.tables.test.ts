/**
 * PROPERTY tests over `coverage.ts`'s lexical tables.
 *
 * Why this file exists: a mutation audit found that **34 of 43** entries in
 * `NARROWING_FLAGS` and `NON_EXECUTING_FLAGS` could be DELETED with the entire
 * suite still green. Each entry is a claim that a real command means something
 * specific, and each unguarded one is a fabrication or starvation waiting to
 * happen — `--testPathPatterns`, `-short`, `--changed`, `--lf`, `--shard` and
 * two dozen others were all unpinned.
 *
 * Hand-writing one test per flag is how that gap got there in the first place:
 * the list grows, the tests don't. These iterate the tables instead, so a new
 * entry is covered the moment it is added, and a deleted entry fails.
 *
 * The tables are re-declared here rather than exported from the module. That is
 * deliberate: exporting them would let a single edit change both the behaviour
 * and its test at once, which is exactly the failure mode being guarded
 * against. The duplication is the point — a divergence between this list and
 * the module's list SHOULD fail.
 */
import { describe, expect, it } from "vitest"

import { isNonExecutingCommand, observedCoversPrescribed } from "../../src/v2/coverage.js"

/** Selector flags that restrict WHICH tests run, with a representative runner
 * and a value shape each actually takes in the wild. */
const NARROWING: Array<{ flag: string; base: string; withFlag: string }> = [
  { flag: "-run", base: "go test ./...", withFlag: "go test -run TestFoo ./..." },
  { flag: "-t", base: "npx vitest run", withFlag: "npx vitest run -t case" },
  { flag: "--testNamePattern", base: "npx jest src/", withFlag: "npx jest --testNamePattern=x src/" },
  { flag: "--test-name-pattern", base: "node --test", withFlag: "node --test --test-name-pattern=x" },
  { flag: "-k", base: "pytest", withFlag: "pytest -k expr" },
  { flag: "--filter", base: "cargo test", withFlag: "cargo test --filter foo" },
  { flag: "--grep", base: "npx mocha", withFlag: "npx mocha --grep foo" },
  { flag: "-g", base: "npx mocha", withFlag: "npx mocha -g foo" },
  { flag: "--only", base: "npx vitest run", withFlag: "npx vitest run --only" },
  { flag: "--testPathPattern", base: "npx jest", withFlag: "npx jest --testPathPattern=src" },
  { flag: "--testPathPatterns", base: "npx jest", withFlag: "npx jest --testPathPatterns=src" },
  { flag: "--testPathIgnorePatterns", base: "npx jest", withFlag: "npx jest --testPathIgnorePatterns=e2e" },
  { flag: "-short", base: "go test ./...", withFlag: "go test -short ./..." },
  { flag: "--changed", base: "npx vitest run", withFlag: "npx vitest run --changed" },
  { flag: "--onlyChanged", base: "npx jest", withFlag: "npx jest --onlyChanged" },
  { flag: "--onlyFailures", base: "npx jest", withFlag: "npx jest --onlyFailures" },
  { flag: "--lf", base: "pytest", withFlag: "pytest --lf" },
  { flag: "--last-failed", base: "pytest", withFlag: "pytest --last-failed" },
  { flag: "--ff", base: "pytest", withFlag: "pytest --ff" },
  { flag: "--failed-first", base: "pytest", withFlag: "pytest --failed-first" },
  { flag: "--stepwise", base: "pytest", withFlag: "pytest --stepwise" },
  { flag: "--project", base: "npx vitest run", withFlag: "npx vitest run --project unit" },
  { flag: "--shard", base: "npx vitest run", withFlag: "npx vitest run --shard=1/4" },
  { flag: "--tags", base: "go test ./...", withFlag: "go test --tags integration ./..." },
  { flag: "-tags", base: "go test ./...", withFlag: "go test -tags integration ./..." },
  { flag: "--workspace (npm)", base: "npm test", withFlag: "npm test --workspace pkg-a" },
  { flag: "-w (npm)", base: "npm test", withFlag: "npm test -w pkg-a" },
  { flag: "-p (cargo)", base: "cargo test", withFlag: "cargo test -p mycrate" },
  { flag: "--package (cargo)", base: "cargo test", withFlag: "cargo test --package mycrate" },
  { flag: "--lib (cargo)", base: "cargo test", withFlag: "cargo test --lib" },
  { flag: "--bin (cargo)", base: "cargo test", withFlag: "cargo test --bin server" },
]

/** Flags that list/describe instead of running. */
const NON_EXECUTING: Array<{ flag: string; command: string }> = [
  { flag: "--version", command: "npx vitest --version" },
  { flag: "--help", command: "npx vitest --help" },
  { flag: "-h", command: "npx vitest -h" },
  { flag: "--collect-only", command: "pytest --collect-only" },
  { flag: "--collectonly", command: "pytest --collectonly" },
  { flag: "--co", command: "pytest --co" },
  { flag: "--listTests", command: "npx jest --listTests" },
  { flag: "--list-tests", command: "npx jest --list-tests" },
  { flag: "--list", command: "npx vitest --list" },
  { flag: "--dry-run", command: "npx vitest --dry-run" },
  { flag: "--dryRun", command: "npx vitest --dryRun" },
  { flag: "--showconfig", command: "pytest --showconfig" },
  { flag: "--show-config", command: "pytest --show-config" },
  { flag: "-list (go)", command: "go test -list .* ./..." },
  { flag: "-c (go)", command: "go test -c ./..." },
  { flag: "-n (go)", command: "go test -n ./..." },
]

describe("every NARROWING flag actually narrows", () => {
  it.each(NARROWING)("$flag: a filtered run does not cover the unfiltered suite", ({ base, withFlag }) => {
    expect(observedCoversPrescribed(base, withFlag), `${withFlag} must NOT cover ${base}`).toBe(false)
  })

  // The discrimination half: without the flag the same command DOES cover, so
  // the tests above cannot be passing because of some unrelated mismatch (a
  // wrong runner, a stray target). This is what makes each row meaningful.
  it.each(NARROWING)("$flag: the same command without it does cover (discrimination)", ({ base }) => {
    expect(observedCoversPrescribed(base, base), `${base} must cover itself`).toBe(true)
  })
})

describe("every NON_EXECUTING flag actually means 'ran nothing'", () => {
  it.each(NON_EXECUTING)("$flag executes nothing", ({ command }) => {
    expect(isNonExecutingCommand(command), `${command} must execute nothing`).toBe(true)
  })

  it.each(NON_EXECUTING)("$flag: stripping it leaves an executing command (discrimination)", ({ flag, command }) => {
    // Remove the flag (and a following value if it took one) and the command
    // must become a real run — otherwise the assertion above would hold for
    // reasons unrelated to the flag.
    const bare = command
      .replace(new RegExp(`\\s+${flag.split(" ")[0].replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}(=\\S+)?(\\s+[^-]\\S*)?`), "")
      .trim()
    expect(isNonExecutingCommand(bare), `${bare} should execute`).toBe(false)
  })
})

describe("flags whose meaning INVERTS between runners", () => {
  // Three of these have already caused real bugs: a global entry starved
  // `pytest -n auto`, condemned `cargo test --workspace`, and suppressed
  // `ctest -V` with a toast claiming it ran no tests. Each row pins both sides.
  const inverted: Array<{ label: string; narrowing: [string, string]; broadening: [string, string] }> = [
    {
      label: "-n: pytest worker count vs go 'print, do not run'",
      narrowing: ["go test ./...", "go test -n ./..."],
      broadening: ["pytest", "pytest -n auto"],
    },
    {
      label: "--workspace: npm selects one, cargo means all",
      narrowing: ["npm test", "npm test --workspace pkg-a"],
      broadening: ["cargo test", "cargo test --workspace"],
    },
    {
      label: "-o: jest --onlyChanged vs go output path",
      narrowing: ["npx jest", "npx jest -o"],
      broadening: ["go test ./...", "go test -o /tmp/bin ./..."],
    },
    {
      label: "-w: npm workspace vs jest maxWorkers",
      narrowing: ["npm test", "npm test -w pkg-a"],
      broadening: ["npx jest", "npx jest -w 4"],
    },
  ]

  it.each(inverted)("$label", ({ narrowing, broadening }) => {
    expect(observedCoversPrescribed(narrowing[0], narrowing[1]), `${narrowing[1]} must NOT cover`).toBe(false)
    expect(observedCoversPrescribed(broadening[0], broadening[1]), `${broadening[1]} MUST cover`).toBe(true)
  })

  it("-V is a version probe only for the runners where that is what it means", () => {
    expect(isNonExecutingCommand("npm -V")).toBe(true)
    // ctest -V is the standard VERBOSE full run; mvn -V prints the version then builds.
    expect(isNonExecutingCommand("ctest -V")).toBe(false)
    expect(isNonExecutingCommand("mvn -V test")).toBe(false)
  })
})
