/**
 * src/v2/resolve.ts — Narrowest-verifier resolution (US-3 / FR-008, FR-009, FR-010).
 *
 * Pure, injectable resolver: given the paths a mutation touched and (optionally) the
 * active story's bound verifiers, returns the narrowest runnable command that verifies
 * those changes. No real fs or subprocess access happens inside `resolveVerifier`
 * itself — the caller supplies a `readManifest()` snapshot (cached per-turn).
 *
 * Tier order (FR-008):
 *   1. active-story verifiers
 *   2. basename convention (`*.test.*` / `*.spec.*`) matched via the cached manifest
 *   3. package-manifest scripts (nearest manifest wins in a monorepo)
 *   4. generic category list — rationale "none", command null. The caller renders the
 *      generic list text and logs `resolution:none` (FR-010); this module never logs.
 *
 * ## B-4: `resolution:none` × 65 in one measured session
 *
 * A field session logged `resolution:none` **65 times**, including on turns that
 * carried genuine changed paths (`src/games/memory.js`, `index.html`,
 * `src/games/breakout.js`). Resolution is the step that turns "these paths changed"
 * into "run THIS command", so 65 misses means the verify-gap nudge and the idle
 * stop-block spent the whole session saying "run something relevant" instead of
 * naming a command. Every tier missed, for a different reason:
 *
 *   - tier 1: the session declared no story verifiers.
 *   - tier 2: `manifest.testFiles` was empty — the project genuinely had no
 *     `*.test.*` / `*.spec.*` file anywhere the bounded scan looks.
 *   - tier 3: `resolvePackageScript` HARD-FILTERED on `scripts.test`, and the
 *     project's `package.json` declared only `check` and `dev`. A repo with a
 *     perfectly good `npm run check` was treated as having no verifier at all.
 *   - the FR-009 probe: never supplied by either production call site, so the
 *     branch was dead code (see `resolveNodeGroup` for why it is now gone).
 *
 * Two of those are fixed here: tier 3 now prefers an ORDERED list of script names
 * (`PACKAGE_SCRIPT_PREFERENCE`) rather than demanding `test`, and absolute changed
 * paths are relativised against `manifest.workspaceRoot` before any path matching
 * runs (`relativiseToWorkspaceRoot`) so workspace/project-root scoping compares
 * like with like. Tier 2's miss was not a defect — the repo had no test files.
 *
 * ## What B-4 broke, and what the follow-up fixes
 *
 * Widening tier 3 turned `resolution:none` into a PRESCRIPTION the coverage
 * checker could not match, which is strictly worse: with no prescription an
 * honest verifier run mints a receipt, while an unmatched prescription sets
 * `relevanceGap`, flips `success` to false in `plugin.ts` and records the run as
 * FAILED. Three consequences are addressed here and in `coverage.ts`:
 *
 *   - FIX 1 (`coverage.ts`): `npm run <script>` sat in no equivalence class, so
 *     only a byte-identical spelling covered it — a pnpm repo running
 *     `pnpm check` against a prescribed `npm run check` scored as a gap. Script
 *     invocations now share one identity across npm/pnpm/yarn/bun, with `run`
 *     optional, and a `-w` workspace selector is comparable with the
 *     `cd <workspace> && …` spelling of the same run.
 *   - FIX 2 (`resolvePackageScript`): the workspace decision came entirely before
 *     the script decision, so a nested `build` beat the root's `test`. Script
 *     QUALITY now breaks the tie across manifests; nearest still wins at equal
 *     quality.
 *   - FIX 3 (`preferredScript` / `isUnsafeScriptBody`): the preference list was
 *     closed by NAME with the body unexamined, so `{lint: "eslint --fix ."}` had
 *     the harness instructing the agent to rewrite the user's source as a
 *     verification step. Bodies are inspected; unsafe ones are skipped.
 *   - FIX 4 (`isInsideWorkspaceRoot`): this module's stated precondition
 *     ("already filtered to inside the worktree") was never true of any caller.
 *     It is enforced here now.
 *
 * ## Language awareness (why tiers 2/3 are per-ecosystem)
 *
 * Tiers 2 and 3 used to know exactly one ecosystem: npm. In a polyglot repo that
 * produced a measured, receipt-destroying defect —
 *
 *     changed `internal/auth/service.go`, repo ALSO has a package.json
 *       -> prescribed "npm test"
 *       -> model correctly runs `go test ./...`
 *       -> `coverage.ts:observedCoversPrescribed` sees runner "go test" vs
 *          "npm test" (different alias classes, deliberately) -> no cover
 *       -> receipt SUPPRESSED
 *
 * i.e. evidence starvation, the same failure class as the D1 bug `coverage.ts`
 * exists to fix, arriving by the opposite route: `coverage.ts` (what COUNTS as
 * evidence) was already fluent in Go/Python/Rust while this module (what gets
 * PRESCRIBED) was not. Tiers 2/3 therefore resolve **per changed path**, picking
 * the ecosystem that actually owns the file, and never prescribe one ecosystem's
 * runner for another ecosystem's source file.
 *
 * ## Pairing with `coverage.ts` is part of the contract
 *
 * A prescription the coverage checker cannot match IS the bug above. Every command
 * shape emitted here was chosen so that the obvious correct command the model would
 * run is accepted by `observedCoversPrescribed`, and `tests/v2/resolve.test.ts` pins
 * that pairing explicitly. Two rules fall straight out of `coverage.ts`:
 *
 *   - **Never prescribe a bare `go test`.** `WHOLE_SUITE_WHEN_BARE` deliberately
 *     excludes `go test`, because bare `go test` compiles and runs only the cwd
 *     package. A bare prescription would therefore mean far less than intended and
 *     would only ever be covered by another bare invocation. Go prescriptions here
 *     always carry an explicit recursive target.
 *   - **Never prescribe `go -C <dir> test ./...`.** It is a genuinely correct
 *     shell command, but `parseSubcommands` breaks the runner scan at the leading
 *     `-C` flag and reduces it to runner `"go"` with path-shaped targets — which
 *     an observed `go -C <dir> build ./...` would then *cover*. Prescribing it
 *     would open a build-credited-as-test hole, the exact evidence fabrication
 *     this codebase refuses. Keeping the runner as `go test` is what makes
 *     `go build` non-covering.
 */

/** Ecosystems tier 2/3 can resolve. `null` from `classifyPathEcosystem` means "unclassifiable". */
export type Ecosystem = "node" | "go" | "python" | "rust"

/**
 * A non-npm project root the caller discovered on disk (nearest-ancestor `go.mod`,
 * `pyproject.toml`/`setup.cfg`/`pytest.ini`/`tox.ini`, `Cargo.toml`), expressed as a
 * repo-root-relative directory. `""` means the repo root itself.
 *
 * Supplying these is what lets a nested module be scoped correctly; omitting them is
 * safe and simply means "assume the repo root", which is right for the common
 * single-module layout. `ecosystem: "node"` entries are ignored — npm layout is
 * already carried by `Manifest.scripts` / `Manifest.workspaces`.
 */
export interface ProjectRoot {
  ecosystem: Ecosystem
  root: string
}

export interface ResolutionResult {
  /** null only for the "generic category list" degrade case. */
  command: string | null
  rationale: "story" | "basename" | "fallback:package-script" | "none"
  /** Paths this command actually covers — full list, caller does the display-cap / +N more formatting. */
  matchedPaths: string[]
}

/**
 * Per-turn cached manifest snapshot.
 *
 * DEVIATION FROM `docs/vertex2-module-contracts.md` §4 (flagged per that doc's own
 * instruction — "where this doc and the spec conflict, the spec wins"): the contract's
 * literal `Manifest` shape is `{ scripts: Record<string, string>; workspaceRoot?: string }`,
 * which cannot represent two things FR-008 explicitly requires:
 *   - the basename-convention tier is matched "via a per-turn cached manifest" (FR-008's
 *     own wording) — that requires a listing of known test files, which `scripts` alone
 *     cannot provide.
 *   - dataset row 9's monorepo "nearest manifest wins" requires comparing multiple
 *     package.json files (root + nested workspace), which a single flat `scripts` map
 *     cannot represent, and `readManifest(): Manifest | null` takes no argument to key a
 *     per-directory lookup on.
 *
 * `scripts` and `workspaceRoot` are kept verbatim for contract compatibility.
 * `testFiles`, `workspaces` and `projectRoots` are additive, **optional** fields that
 * carry the extra data the tier algorithm needs; omitting them degrades gracefully
 * (empty/undefined behaves like "no candidates at this tier"). They must stay optional:
 * `measurement.ts`'s `ResolveVerifierManifest` structural mirror only declares
 * `scripts`/`workspaceRoot`, and `tests/v2/measurement.test.ts` assigns the real
 * `resolveVerifier` to `ResolveVerifierFn`, so a required field here would break that
 * assignability.
 */
export interface Manifest {
  /** Root-level `package.json` scripts (e.g. `{ test: "vitest run" }`). */
  scripts: Record<string, string>
  workspaceRoot?: string
  /**
   * OTHER absolute spellings of the same worktree directory — the symlink the
   * session was opened through, a bind mount, `/tmp` vs `/private/tmp`.
   *
   * One directory can have more than one true name, and the two sides of a
   * changed path disagree about which one to use: the session carries the
   * configured root while opencode's tools report the realpath of the file they
   * touched. Since `isInsideWorkspaceRoot` now EXCLUDES paths outside the root
   * (FIX 4), a mismatch would silently push every changed path out of the
   * worktree and take the whole session's resolution down with it. A path under
   * any listed spelling is inside.
   *
   * Optional and additive, like `testFiles`/`workspaces`/`projectRoots`:
   * `measurement.ts`'s structural mirror declares neither, and omitting it means
   * "the root has exactly one name", which is the usual case.
   */
  workspaceRootAliases?: readonly string[]
  /**
   * Known test file paths (e.g. from a per-turn glob cache of `**\/*.test.*` /
   * `**\/*.spec.*`), used by the basename-convention tier. Optional — an absent or
   * empty list simply means the tier has nothing to match against.
   */
  testFiles?: string[]
  /**
   * Nested workspace package manifests for monorepo layouts (e.g.
   * `[{ root: "packages/api", scripts: { test: "vitest run" } }]`), keyed by their
   * root path relative to the repo root. The root-level `scripts` above is treated as
   * the `root: ""` workspace. "Nearest manifest wins" walks from the most specific
   * (longest) matching root down to `""`, picking the first workspace that actually
   * has a usable `test` script.
   */
  workspaces?: Array<{ root: string; scripts: Record<string, string> }>
  /**
   * Non-npm project roots (`go.mod`, `pyproject.toml`/`setup.cfg`/`pytest.ini`/
   * `tox.ini`, `Cargo.toml`) the caller found, so a nested Go module / Python package
   * / Rust crate can be scoped instead of assumed to sit at the repo root.
   *
   * Absent (the default today — `wiring/manifest.ts:buildManifest` does not populate
   * it yet) means every non-npm ecosystem is assumed to be rooted at the repo root.
   * That is correct for the common single-module repo and, crucially, is still never
   * cross-ecosystem: a `.go` change resolves to a Go command either way.
   */
  projectRoots?: readonly ProjectRoot[]
}

export interface ResolveContext {
  /**
   * The paths a mutation touched, as the caller observed them — **NOT** pre-filtered.
   *
   * The old wording here ("already filtered to inside the worktree by the caller")
   * was simply false, and a false stated precondition is worse than none: it is
   * what let the B-4 (c) mis-scoping bug survive its own fix. The real chain is
   * `index.ts:changedPathsFromTool` -> `plugin.ts`'s `tool.execute.after` ->
   * `evidenceLedger.recordChangedFiles`, and it records opencode's raw
   * `args.filePath` verbatim. Nothing in it compares the path to the worktree, so
   * `/home/dev/other/packages/api/x.ts` reaches this module unchanged while the
   * session is rooted at `/work/monorepo`.
   *
   * Dataset row 10 ("outside-worktree paths are excluded") is therefore enforced
   * HERE, in `resolveVerifier`, whenever `manifest.workspaceRoot` is known — see
   * `isInsideWorkspaceRoot`. Callers may still pre-filter; doing so is a no-op.
   */
  changedPaths: string[]
  storyVerifiers: readonly string[] | null
}

export interface ResolveDeps {
  /** Cached per-turn by the caller — may be called more than once per resolveVerifier call; the caller owns the cache, not this module. */
  readManifest(): Manifest | null
}

const TEST_SUFFIX_RE = /^(.*)\.(?:test|spec)\.[^./]+$/

/** Filename (no directory) with the trailing extension stripped, e.g. "src/lexer.ts" -> "lexer". */
function baseNameNoExt(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() ?? filePath
  const idx = base.lastIndexOf(".")
  return idx > 0 ? base.slice(0, idx) : base
}

/** "tests/lexer.test.ts" -> "lexer"; "tests/fmt.spec.ts" -> "fmt"; non-convention names -> null. */
function testFileConventionBase(filePath: string): string | null {
  const base = filePath.split(/[\\/]/).pop() ?? filePath
  const match = TEST_SUFFIX_RE.exec(base)
  return match ? match[1] : null
}

// ===========================================================================
// ECOSYSTEM CLASSIFICATION
// ===========================================================================

/**
 * Files whose *name* pins the ecosystem regardless of extension. Checked before the
 * extension table because `Cargo.toml` and `pyproject.toml` share a `.toml` suffix
 * that means nothing on its own.
 */
const ECOSYSTEM_BY_BASENAME: ReadonlyMap<string, Ecosystem> = new Map<string, Ecosystem>([
  ["go.mod", "go"],
  ["go.sum", "go"],
  ["go.work", "go"],
  ["go.work.sum", "go"],
  ["pyproject.toml", "python"],
  ["setup.py", "python"],
  ["setup.cfg", "python"],
  ["pytest.ini", "python"],
  ["tox.ini", "python"],
  ["conftest.py", "python"],
  ["requirements.txt", "python"],
  ["Pipfile", "python"],
  ["Cargo.toml", "rust"],
  ["Cargo.lock", "rust"],
  ["package.json", "node"],
  ["package-lock.json", "node"],
  ["pnpm-lock.yaml", "node"],
  ["yarn.lock", "node"],
  ["tsconfig.json", "node"],
])

const ECOSYSTEM_BY_EXTENSION: ReadonlyMap<string, Ecosystem> = new Map<string, Ecosystem>([
  [".go", "go"],
  [".py", "python"],
  [".pyi", "python"],
  [".pyx", "python"],
  [".rs", "rust"],
  [".ts", "node"],
  [".tsx", "node"],
  [".mts", "node"],
  [".cts", "node"],
  [".js", "node"],
  [".jsx", "node"],
  [".mjs", "node"],
  [".cjs", "node"],
  [".vue", "node"],
  [".svelte", "node"],
])

/**
 * Which ecosystem owns this file, or `null` when nothing about the path says.
 *
 * `null` is deliberately common (`.md`, `.sql`, `.yaml`, `Dockerfile`, …): an
 * unclassifiable path must never *select* an ecosystem, or a stray `config.yaml`
 * would start prescribing test suites. See `partitionByEcosystem` for how those
 * paths are carried.
 */
export function classifyPathEcosystem(filePath: string): Ecosystem | null {
  const base = filePath.split(/[\\/]/).pop() ?? filePath
  const byName = ECOSYSTEM_BY_BASENAME.get(base)
  if (byName) return byName
  const dot = base.lastIndexOf(".")
  if (dot <= 0) return null
  return ECOSYSTEM_BY_EXTENSION.get(base.slice(dot).toLowerCase()) ?? null
}

/**
 * Matches changed source paths against a pool of candidate test files by basename
 * convention. Returns only the subset of `paths` that matched (matchedPaths) and the
 * deduped list of test files those matches resolved to (for the joined command).
 */
function matchBasenameConvention(
  paths: readonly string[],
  candidateTestFiles: readonly string[],
): { testFiles: string[]; matchedPaths: string[] } {
  const testFileByBase = new Map<string, string>()
  for (const testFile of candidateTestFiles) {
    const base = testFileConventionBase(testFile)
    if (base && !testFileByBase.has(base)) testFileByBase.set(base, testFile)
  }

  const matchedTestFiles: string[] = []
  const matchedPaths: string[] = []
  for (const path of paths) {
    const base = baseNameNoExt(path)
    const testFile = testFileByBase.get(base)
    if (testFile) {
      matchedPaths.push(path)
      if (!matchedTestFiles.includes(testFile)) matchedTestFiles.push(testFile)
    }
  }
  return { testFiles: matchedTestFiles, matchedPaths }
}

interface WorkspaceCandidate {
  root: string
  scripts: Record<string, string>
}

function normalizeRoot(root: string): string {
  return root.replace(/^\.\/+/, "").replace(/\/+$/, "")
}

/**
 * B-4 (c): re-express an ABSOLUTE changed path as the bare repo-relative form the
 * manifest's roots use, by SUBTRACTING the known workspace root.
 *
 * opencode's `edit`/`write` tools declare `filePath` as an absolute path and
 * `changedPathsFromTool` (src/index.ts:558) passes it through verbatim, so in
 * production nearly every changed path arrives absolute — while `workspaces[].root`
 * and `projectRoots[].root` are `relative(repoRoot, dir)`, i.e. bare. Every
 * path-based comparison in this module was therefore comparing two different
 * coordinate systems.
 *
 * `normalizeChangedPath` below is the older, root-unaware workaround: it hunts for
 * `/<root>/` ANYWHERE inside the absolute path. That guesses right often enough to
 * look fine, and wrong in a way that produces a WRONGER prescription than none: for
 * a repo at `/work/app` with a workspace literally named `app`, the root-level file
 * `/work/app/src/x.ts` contains `/app/` and was scoped to `npm test -w app` — a
 * workspace it does not live in. Subtracting the real root removes the guess.
 *
 * Fail-open by design: a path that is not absolute, or that lies outside the root,
 * or a manifest with no `workspaceRoot`, is returned unchanged and falls through to
 * the older marker heuristic. Narrowing this to "under the root" matters — a
 * `/tmp/x.ts` must not be silently rebased into the repo.
 */
export function relativiseToWorkspaceRoot(path: string, workspaceRoot: string | undefined): string {
  if (!path.startsWith("/")) return path
  if (workspaceRoot === undefined) return path
  const base = workspaceRoot.replace(/\/+$/, "")
  if (base === "" || !base.startsWith("/")) return path
  if (!path.startsWith(`${base}/`)) return path
  const rest = path.slice(base.length + 1).replace(/^\/+/, "")
  return rest === "" ? path : rest
}

/**
 * Dataset row 10, enforced instead of assumed (see `ResolveContext.changedPaths`).
 *
 * An ABSOLUTE path that is not under a KNOWN workspace root is not this session's
 * business, and letting it through is not merely useless — it is actively wrong.
 * `normalizeChangedPath`'s marker heuristic hunts for `/<root>/` anywhere in the
 * string, so with the session rooted at `/work/monorepo` an edit to
 * `/home/dev/other/packages/api/x.ts` was reduced to `packages/api/x.ts` and
 * prescribed `npm run check -w packages/api` — a workspace selector naming a
 * package that the change is not merely outside of, but in a different REPO from.
 * That is the exact defect B-4 (c) killed for paths inside the root, arriving by
 * the one route B-4 (c) did not close.
 *
 * Fail-open where it cannot judge, as everywhere else in this module: a relative
 * path, or a manifest with no (or a non-absolute) `workspaceRoot`, is kept. The
 * root itself counts as inside, so a caller that hands over the worktree
 * directory still resolves at the repo root instead of vanishing.
 *
 * The SYMLINK case (a root reached through a link, while the tool reports
 * realpaths) is not a judgment this pure function can make — it is handled by
 * giving it every spelling of the root instead: `wiring/manifest.ts` resolves the
 * real path and records the other one in `Manifest.workspaceRootAliases`, and a
 * path under ANY spelling is inside. Guessing at path equivalence, rather than
 * being told, is what produced the bug above.
 */
export function isInsideWorkspaceRoot(path: string, workspaceRoot: string | undefined): boolean {
  if (!path.startsWith("/")) return true
  if (workspaceRoot === undefined) return true
  const base = workspaceRoot.replace(/\/+$/, "")
  if (base === "" || !base.startsWith("/")) return true
  return path === base || path.startsWith(`${base}/`)
}

/** Every absolute spelling of the worktree root this manifest knows about. */
function workspaceRootSpellings(manifest: Manifest | null): string[] {
  const raw = manifest ? [manifest.workspaceRoot, ...(manifest.workspaceRootAliases ?? [])] : []
  return raw.filter((root): root is string => typeof root === "string" && root.startsWith("/") && root !== "/")
}

/** Inside the worktree under ANY of its names; unknown root => cannot judge => inside. */
function isInsideAnyRoot(path: string, roots: readonly string[]): boolean {
  if (roots.length === 0) return true
  return roots.some((root) => isInsideWorkspaceRoot(path, root))
}

/** Repo-relative form under the first root spelling that actually contains the path. */
function relativiseToAnyRoot(path: string, roots: readonly string[]): string {
  for (const root of roots) {
    const relative = relativiseToWorkspaceRoot(path, root)
    if (relative !== path) return relative
  }
  return path
}

/**
 * Residual normalisation for a path that `relativiseToWorkspaceRoot` could not
 * reduce — no `workspaceRoot` in the manifest (unit tests, `readManifest()` ->
 * null), or a path outside the root. Strips a `./` prefix, and for a still-absolute
 * path falls back to locating the root segment inside it.
 *
 * Kept because dropping it would regress the pre-B-4 behaviour for root-less
 * callers, but it is now the SECOND line of defence, not the first.
 */
function normalizeChangedPath(path: string, root: string): string {
  const cleaned = path.replace(/^\.\/+/, "")
  if (!cleaned.startsWith("/")) return cleaned
  if (root === "") return cleaned
  const marker = `/${root}/`
  const at = cleaned.indexOf(marker)
  return at === -1 ? cleaned : cleaned.slice(at + 1)
}

function isWithinWorkspace(path: string, root: string): boolean {
  if (root === "") return true
  const normalised = normalizeChangedPath(path, root)
  return normalised === root || normalised.startsWith(`${root}/`)
}

function collectWorkspaces(manifest: Manifest): WorkspaceCandidate[] {
  const root: WorkspaceCandidate = { root: "", scripts: manifest.scripts ?? {} }
  const nested = (manifest.workspaces ?? []).map((workspace) => ({
    root: normalizeRoot(workspace.root),
    scripts: workspace.scripts ?? {},
  }))
  return [root, ...nested]
}

/**
 * B-4 (a): the ordered set of `package.json` script names tier 3 will prescribe,
 * best first. First match wins.
 *
 * Tier 3 used to demand `scripts.test` and nothing else. In the measured session
 * (65 × `resolution:none`, see this file's header) the project's `package.json`
 * declared exactly `check` and `dev`, so a repo whose author had provided a
 * one-command verifier was classified as unverifiable and the harness fell back to
 * reciting a category list for the entire session.
 *
 * Why THIS list and this order:
 *   - `test` first, and it keeps its canonical `npm test` spelling, because that is
 *     the only entry `coverage.ts:WHOLE_SUITE_ALIASES` treats as interchangeable
 *     with `npx vitest run` / `npx jest` / `yarn test`. Reaching it through
 *     `npm run test` instead would narrow what counts as covering evidence.
 *   - `check` / `verify` next: by convention these are the project's own aggregate
 *     gate (this repo's own `check`, for instance), so they are stronger evidence
 *     than any single one of their parts.
 *   - `lint` / `typecheck` / `build` last, in ascending order of how little they say
 *     about behaviour. They are still worth prescribing: a build that fails is a
 *     real refutation, and `findings.ts`'s own generic category list already names
 *     lint, typecheck and build as acceptable verifiers.
 *
 * Closed on purpose. Prescribing an arbitrary script would be worse than
 * prescribing nothing — `npm run dev` starts a server that never exits, and `start`,
 * `deploy`, `release`, `clean` and `postinstall` are outright dangerous to suggest
 * as a verification step. A script not on this list is not a verifier.
 */
const PACKAGE_SCRIPT_PREFERENCE: readonly string[] = ["test", "check", "verify", "lint", "typecheck", "build"]

/**
 * How much a script's NAME claims about behaviour. Used only to compare scripts
 * ACROSS manifests (see `resolvePackageScript`); within one manifest the finer
 * ordering of `PACKAGE_SCRIPT_PREFERENCE` decides.
 *
 * Two tiers, not six, because only one distinction is strong enough to overrule
 * "nearest manifest wins":
 *
 *   0 — `test` / `check` / `verify` run the project's own assertions, or the
 *       aggregate gate its author declared as the thing to run.
 *   1 — `lint` / `typecheck` / `build` are static-only. They can refute a change,
 *       but passing one says nothing about behaviour.
 *
 * FIX 2: `resolvePackageScript` picked the WORKSPACE first and the script second,
 * so a nested package's weakest script beat the root's strongest one — root
 * `{test}` + `packages/api: {build}` + a change under `packages/api` prescribed
 * `npm run build -w packages/api`, where before B-4 (a) widened the script set it
 * had prescribed `npm test`. B-4 (a) was supposed to widen what tier 3 can find,
 * not to downgrade what it already found.
 */
const SCRIPT_QUALITY: ReadonlyMap<string, number> = new Map([
  ["test", 0],
  ["check", 0],
  ["verify", 0],
  ["lint", 1],
  ["typecheck", 1],
  ["build", 1],
])

function scriptQuality(name: string): number {
  return SCRIPT_QUALITY.get(name) ?? 1
}

// ---------------------------------------------------------------------------
// FIX 3 — a prescription must never tell the agent to MUTATE the workspace
// ---------------------------------------------------------------------------
//
// `PACKAGE_SCRIPT_PREFERENCE` is closed by NAME, and until now the body behind
// the name was unexamined: any non-blank string qualified. So
// `{lint: "eslint --fix . && prettier --write ."}` — an entirely ordinary
// package.json — resolved to `npm run lint`, which `findings.ts` renders to the
// model as "Run `npm run lint` and cite its observed result". The harness would
// then be the thing that told the agent to rewrite the user's source files, as a
// side effect of *verifying*. `{build: "rm -rf dist && ./deploy.sh"}` is the same
// shape with a deploy on the end.
//
// POSITION TAKEN, and why it is this one rather than the alternatives:
//
//   - Narrowing the NAME list does not work. The offending scripts are called
//     `lint` and `build`; those names are exactly the ones `findings.ts`'s own
//     generic category list already tells the model to run, and dropping them
//     re-opens B-4's `resolution:none` for repos whose only verifier is a build.
//   - Documenting the risk does not work either. A documented instruction to
//     `--fix` the user's tree is still an instruction to `--fix` the user's tree.
//   - So: INSPECT THE BODY, and skip a script whose body carries a write-back
//     marker, falls through to the next preference, and prescribes nothing at all
//     if every candidate is unsafe. Prescribing nothing costs a `resolution:none`
//     (a known, survivable degrade with its own logging); prescribing a mutating
//     command costs the user's working tree, which nothing can undo from here.
//
// The detector is a closed blocklist of shapes that actually occur, not a
// sandbox, and it errs toward REFUSING to prescribe — a false positive here loses
// one prescription, a false negative rewrites files.

/** `--fix` (eslint, stylelint, ruff), `--write` (prettier), `sed -i`. */
const WRITE_BACK_FLAG_RE = /(?:^|\s)(?:--fix|--write|--in-place)(?:[=\s]|$)|\bsed\s+-[A-Za-z]*i\b/

/** Formatters that rewrite files unless explicitly asked not to. */
const DEFAULT_WRITING_FORMATTER_RE = /\b(?:black|isort|rustfmt|ruff\s+format|dprint\s+fmt|cargo\s+fmt|go\s+fmt)\b/

/** Flags that turn a default-writing formatter into a reporter. */
const READ_ONLY_FORMAT_FLAG_RE = /(?:^|\s)(?:--check|--check-only|--diff|--dry-run|-l|--list-different)(?:[=\s]|$)/

/** Commands with effects outside the working tree (or on git history). */
const EFFECTFUL_COMMAND_RE =
  /\b(?:deploy|publish|release|upload)\b|(?:^|\s)push\b|\bgit\s+(?:commit|push|add|checkout|switch|reset|clean|rebase|merge|tag|stash)\b/

/** Scripts that never exit: a verification step that blocks forever is not one. */
const NEVER_EXITING_RE =
  /(?:^|\s)(?:--watch|--watchAll|--watch-all|--hot)(?:[=\s]|$)|\b(?:nodemon|watchexec|http-server|live-server)\b|\b(?:vite|webpack|snowpack)\s+(?:dev|serve)\b|\b(?:next|nuxt|astro|remix|gatsby)\s+dev\b|(?:^|\s)serve(?:\s|$)/

/** Generated locations a build may legitimately delete and regenerate. */
const BUILD_OUTPUT_PATH_RE =
  /^(?:\.\/)?(?:dist|build|out|output|lib|libs|es|esm|cjs|coverage|target|tmp|temp|node_modules|\.next|\.nuxt|\.turbo|\.cache|\.svelte-kit|\.parcel-cache|\.vite|\.output)(?:[/\\].*)?$|\.tsbuildinfo$/

const SHELL_OPERATOR_RE = /^(?:&&|\|\||;|\||&)$/

/**
 * `rm -rf dist` is part of building; `rm -rf src` is not. Any `rm` operand that
 * is not a recognised generated location makes the script unsafe.
 */
function removesOutsideBuildOutput(body: string): boolean {
  const tokens = body.split(/\s+/).filter((token) => token.length > 0)
  for (let index = 0; index < tokens.length; index++) {
    if (!/^(?:rm|rmdir|shx?)$/.test(tokens[index]) && tokens[index] !== "rimraf") continue
    for (let arg = index + 1; arg < tokens.length; arg++) {
      const token = tokens[arg]
      if (SHELL_OPERATOR_RE.test(token)) break
      if (token.startsWith("-")) continue
      if (token === "rm" || token === "rimraf") continue // `shx rm`, `npx rimraf`
      if (!BUILD_OUTPUT_PATH_RE.test(token)) return true
    }
  }
  return false
}

/** Does running this script body change the user's workspace (or never return)? */
export function isUnsafeScriptBody(body: string): boolean {
  const text = body.trim()
  if (text.length === 0) return true
  if (WRITE_BACK_FLAG_RE.test(text)) return true
  if (DEFAULT_WRITING_FORMATTER_RE.test(text) && !READ_ONLY_FORMAT_FLAG_RE.test(text)) return true
  if (EFFECTFUL_COMMAND_RE.test(text)) return true
  if (NEVER_EXITING_RE.test(text)) return true
  if (removesOutsideBuildOutput(text)) return true
  return false
}

/**
 * The highest-preference usable script name in `scripts`, or null when it has
 * none. "Usable" is name-listed AND non-blank AND non-mutating (FIX 3).
 */
function preferredScript(scripts: Record<string, string>): string | null {
  for (const name of PACKAGE_SCRIPT_PREFERENCE) {
    const body = scripts[name]
    if (typeof body === "string" && !isUnsafeScriptBody(body)) return name
  }
  return null
}

/**
 * `test` keeps the bare `npm test` spelling (alias-class membership, above); every
 * other script is reached through `npm run <name>`. A nested workspace appends npm's
 * own `-w <root>` selector, which `coverage.ts` reads as a workspace narrowing and
 * therefore refuses to credit to a bare root-level run.
 */
function packageScriptCommand(script: string, root: string): string {
  const base = script === "test" ? "npm test" : `npm run ${script}`
  return root === "" ? base : `${base} -w ${root}`
}

/**
 * Tier 3: package-manifest scripts, nearest manifest wins (dataset row 9). Judgment
 * call (undocumented by the spec beyond the single-path row 9 case): when multiple
 * changed paths span different workspaces, the FIRST changed path's nearest workspace
 * decides the command for the whole batch, since `ResolutionResult` carries only one
 * command. "Nearest" walks from the most specific (longest) matching root down to the
 * repo root (`""`), picking the first workspace that declares any usable script.
 *
 * PRECEDENCE — "nearest manifest wins, at equal script QUALITY" (FIX 2).
 *
 * B-4 (a) left the workspace decision entirely ahead of the script decision, which
 * was right while tier 3 only ever found `test` (every candidate was the same
 * strength, so nearest was the only axis left) and wrong the moment the script set
 * widened: root `{test}` + `packages/api: {build}` prescribed
 * `npm run build -w packages/api` for a change under `packages/api`, i.e. B-4
 * downgraded a repo that already had a working prescription. `SCRIPT_QUALITY`
 * restores the missing axis with the minimum that fixes it — a strictly stronger
 * ANCESTOR script wins, and at equal strength nearest still wins, so dataset row 9
 * (root `test` vs nested `test` -> nested) and B-4's nested-`check`-beats-root-`test`
 * case are both unchanged.
 */
function resolvePackageScript(paths: readonly string[], manifest: Manifest): { command: string } | null {
  if (paths.length === 0) return null

  const primaryPath = paths[0]
  const candidates = collectWorkspaces(manifest)
    .map((workspace) => ({ root: workspace.root, script: preferredScript(workspace.scripts) }))
    .filter((workspace): workspace is { root: string; script: string } => workspace.script !== null)
    .filter((workspace) => isWithinWorkspace(primaryPath, workspace.root))
    // Best script QUALITY first; at equal quality the nearest (longest) manifest.
    .sort((a, b) => scriptQuality(a.script) - scriptQuality(b.script) || b.root.length - a.root.length)

  const winner = candidates[0]
  if (!winner) return null

  return { command: packageScriptCommand(winner.script, winner.root) }
}

/**
 * Nearest ancestor project root for a non-npm ecosystem, i.e. the longest injected
 * `ProjectRoot` of that ecosystem that contains the path. Defaults to `""` (repo
 * root) when nothing was injected — see `Manifest.projectRoots`.
 */
function nearestProjectRoot(path: string, ecosystem: Ecosystem, manifest: Manifest | null): string {
  const candidates = (manifest?.projectRoots ?? [])
    .filter((entry) => entry.ecosystem === ecosystem)
    .map((entry) => normalizeRoot(entry.root))
    .sort((a, b) => b.length - a.length)
  return candidates.find((root) => isWithinWorkspace(path, root)) ?? ""
}

/**
 * The whole-suite command for a non-npm ecosystem rooted at `root` (repo-root-relative,
 * `""` = repo root). Every shape here is pinned against `coverage.ts` by
 * `tests/v2/resolve.test.ts`:
 *
 *   go     ""            -> `go test ./...`
 *          "services/api"-> `go test ./services/api/...`
 *          (never bare `go test` — see this file's header)
 *   python ""            -> `pytest`
 *          "services/ml" -> `pytest services/ml`
 *   rust   ""            -> `cargo test`
 *          "crates/foo"  -> `cargo test --manifest-path crates/foo/Cargo.toml`
 *
 * KNOWN LIMITATION, accepted deliberately: when a Go module is nested and the repo
 * root is *not* itself a module, `go test ./services/api/...` cannot be run from the
 * repo root at all (Go resolves `./x/...` patterns inside the current module). The
 * two alternatives are both worse — `go -C services/api test ./...` reduces to runner
 * `"go"` under `coverage.ts` and would let a `go build` mint a test receipt, and
 * `cd services/api && go test ./...` is refused outright by
 * `coverage.ts:changesWorkingDirectory`. Keeping the module-scoped `go test` form at
 * least (a) names the right ecosystem and scope in the prescription text and (b) is
 * covered by an observed whole-tree `go test ./...`.
 */
function foreignCommand(ecosystem: Exclude<Ecosystem, "node">, root: string): string {
  switch (ecosystem) {
    case "go":
      return root === "" ? "go test ./..." : `go test ./${root}/...`
    case "python":
      return root === "" ? "pytest" : `pytest ${root}`
    case "rust":
      return root === "" ? "cargo test" : `cargo test --manifest-path ${root}/Cargo.toml`
  }
}

// ===========================================================================
// GROUPING
// ===========================================================================

interface PathGroup {
  ecosystem: Ecosystem
  /** Repo-root-relative project root; only meaningful for non-node ecosystems. */
  root: string
  paths: string[]
  /** Index of this group's first path in the original `changedPaths`, for deterministic ordering. */
  order: number
}

/**
 * Split the changed paths into the groups tiers 2/3 resolve independently.
 *
 * - **node** is always a single group and keeps its own monorepo handling
 *   (`resolvePackageScript`'s "first path's nearest workspace wins"), so its behaviour
 *   is byte-identical to the pre-language-awareness resolver for an all-JS/TS input.
 * - **go / python / rust** are grouped by `(ecosystem, nearest project root)`, so two
 *   Go modules changed in one turn produce two honest sub-commands rather than one
 *   command that silently claims to cover both.
 * - **unclassifiable paths** (`.md`, `.sql`, `.yaml`, …) never select an ecosystem.
 *   They ride along with the node group when node is in play (preserving today's
 *   `matchedPaths` for a `src/a.ts` + `config.yaml` turn); when *no* path is
 *   classifiable at all the whole set becomes the node group (exactly today's
 *   behaviour); and when only non-node ecosystems are in play they are dropped,
 *   because no suite here can honestly claim to verify them.
 */
function partitionByEcosystem(paths: readonly string[], manifest: Manifest | null): PathGroup[] {
  const groups = new Map<string, PathGroup>()
  let sawClassified = false
  let sawNode = false

  paths.forEach((path, index) => {
    const ecosystem = classifyPathEcosystem(path)
    if (ecosystem === null) return
    sawClassified = true
    if (ecosystem === "node") {
      sawNode = true
      return
    }
    const root = nearestProjectRoot(path, ecosystem, manifest)
    const key = `${ecosystem}:${root}`
    const existing = groups.get(key)
    if (existing) existing.paths.push(path)
    else groups.set(key, { ecosystem, root, paths: [path], order: index })
  })

  // The node group is rebuilt from the ORIGINAL path order (not appended) so that
  // `matchBasenameConvention` and `resolvePackageScript` see exactly the sequence the
  // pre-language-awareness resolver saw whenever the input is all-JS/TS.
  const nodePaths = !sawClassified
    ? [...paths]
    : sawNode
      ? paths.filter((path) => {
          const ecosystem = classifyPathEcosystem(path)
          return ecosystem === null || ecosystem === "node"
        })
      : []

  if (nodePaths.length > 0) {
    groups.set("node", {
      ecosystem: "node",
      root: "",
      paths: nodePaths,
      order: paths.indexOf(nodePaths[0]),
    })
  }

  return [...groups.values()].sort((a, b) => a.order - b.order)
}

interface GroupResolution {
  command: string
  rationale: "basename" | "fallback:package-script"
  matchedPaths: string[]
}

/**
 * Tiers 2/3 for the JS/TS group.
 *
 * ## B-4 (b): the FR-009 "bounded fallback probe" tier was DELETED, not wired
 *
 * `ResolveDeps` used to accept an optional `fallbackProbe(globs)` that ran after
 * tier 3 and re-searched the tree for `**\/<base>.test.*` / `**\/<base>.spec.*`.
 * Neither production call site (`plugin.ts`'s verify-gap branch,
 * `gate.ts:narrowestPrescription`) ever supplied one, so the branch had never
 * executed outside its own unit tests, while reading — in a module about
 * evidence — like a safety net that was catching something.
 *
 * It was deleted rather than wired because it is REDUNDANT BY CONSTRUCTION. The
 * only manifest reader in this codebase, `wiring/manifest.ts:scanRepo`, already
 * walks the whole worktree once per turn and collects EVERY file matching
 * `/\.(?:test|spec)\.[^./]+$/` into `manifest.testFiles` — the same convention,
 * the same tree, the same skip list. Any probe honouring those bounds can only
 * return a subset of what tier 2 was already handed, and the probe is reached
 * only when tier 2 found no match in that set. To find anything new it would have
 * to walk MORE of the tree than the cached scan, uncached, inside
 * `tool.execute.after` / `chat.system.transform` — precisely the subprocess/latency
 * spend FR-009 and SC-003 exist to bound, for a case whose defining property is
 * that a full-repo scan already found zero test files.
 *
 * FR-009 permits this fallback ("an optional resolution fallback bounded at 250 ms";
 * "the degraded path MUST remain correct without it") — it never required it. The
 * right place to spend effort on tier-2 recall is `scanRepo`'s bounds, not a second
 * walk behind an interface nobody implements.
 */
function resolveNodeGroup(paths: readonly string[], manifest: Manifest | null): GroupResolution | null {
  if (paths.length === 0) return null

  // Tier 2: basename convention, matched via the cached manifest.
  if (manifest?.testFiles && manifest.testFiles.length > 0) {
    const matched = matchBasenameConvention(paths, manifest.testFiles)
    if (matched.testFiles.length > 0) {
      return {
        command: `npx vitest run ${matched.testFiles.join(" ")}`,
        rationale: "basename",
        matchedPaths: matched.matchedPaths,
      }
    }
  }

  // Tier 3: package-manifest scripts (nearest manifest wins in a monorepo).
  if (manifest) {
    const scriptMatch = resolvePackageScript(paths, manifest)
    if (scriptMatch) {
      return { command: scriptMatch.command, rationale: "fallback:package-script", matchedPaths: [...paths] }
    }
  }

  return null
}

/**
 * FR-008: resolve the narrowest verifier command for a set of already-filtered changed
 * paths. Pure/injectable — no real fs or subprocess access happens in here; `deps`
 * supplies everything this function reads.
 */
export function resolveVerifier(ctx: ResolveContext, deps: ResolveDeps): ResolutionResult {
  const rawPaths = ctx.changedPaths.filter((path) => path.trim().length > 0)

  if (rawPaths.length === 0) {
    return { command: null, rationale: "none", matchedPaths: [] }
  }

  // Read the manifest BEFORE tier 1 (the contract allows it: "may be called more
  // than once per resolveVerifier call", and in production it is a cache hit),
  // because B-4 (c)'s relativisation needs `workspaceRoot` and every tier —
  // including the story tier's `matchedPaths` — must speak one coordinate system.
  const manifest = deps.readManifest()
  // FIX 4: row 10 is ENFORCED here, not assumed of the caller — nothing upstream
  // of this module compares a changed path to the worktree (see
  // `ResolveContext.changedPaths`). Filtering before relativising is what stops an
  // outside-the-repo path from reaching `normalizeChangedPath`'s marker heuristic
  // and being scoped into a same-named workspace of a repo it does not live in.
  const roots = workspaceRootSpellings(manifest)
  const paths = rawPaths
    .filter((path) => isInsideAnyRoot(path, roots))
    .map((path) => relativiseToAnyRoot(path, roots))

  if (paths.length === 0) {
    return { command: null, rationale: "none", matchedPaths: [] }
  }

  // Tier 1: active-story verifiers. Story precedence is absolute — a story that
  // declares its own verifiers overrides every ecosystem inference below.
  // M7 (grill round 2): `verifiers` is LLM-authored and reaches the plan
  // through `tool.schema.string()`, so an element that is not a string is a
  // reachable input, not a theoretical one — and a bare `.trim()` on it throws
  // straight out of a `tool.execute.after` hook, violating the fail-open
  // convention. Filter by type before touching the value.
  const storyVerifiers = (ctx.storyVerifiers ?? []).filter(
    (verifier) => typeof verifier === "string" && verifier.trim().length > 0,
  )
  if (storyVerifiers.length > 0) {
    return { command: storyVerifiers.join(" && "), rationale: "story", matchedPaths: [...paths] }
  }

  const resolutions: GroupResolution[] = []
  for (const group of partitionByEcosystem(paths, manifest)) {
    const resolved =
      group.ecosystem === "node"
        ? resolveNodeGroup(group.paths, manifest)
        : {
            command: foreignCommand(group.ecosystem, group.root),
            // A `go.mod` / `pyproject.toml` / `Cargo.toml` IS the project manifest, so
            // this is tier 3 by any other name. The `rationale` union stays exactly the
            // four documented values: `measurement.ts` mirrors it structurally and
            // `tests/v2/measurement.test.ts` assigns this function to `ResolveVerifierFn`,
            // so widening it would break compilation outside this module.
            rationale: "fallback:package-script" as const,
            matchedPaths: [...group.paths],
          }
    if (resolved) resolutions.push(resolved)
  }

  if (resolutions.length === 0) {
    // Tier 4: generic category list. The caller renders the actual category text and
    // logs `resolution:none` (FR-010) — this module only signals the degrade.
    return { command: null, rationale: "none", matchedPaths: [] }
  }

  // MIXED CHANGED-PATH SETS: join with `&&`.
  //
  // Justification (this is the rule requirement 2 asks to be documented): `coverage.ts`
  // splits a prescription on `&&` and requires EVERY prescribed sub-command to be
  // covered by SOME observed sub-command. So `go test ./... && npx vitest run tests/a.test.ts`
  // reads as "verify both ecosystems", which is exactly correct — a Go suite is blind to
  // a TypeScript change and vice versa, so crediting either alone would mint a receipt
  // for a half-verified turn. `&&` is also literally runnable, and it is already the
  // join the story tier uses for multiple verifiers, so the composer's rendering and the
  // model's reading of it are unchanged. Sub-command order is the first appearance of
  // each group in `changedPaths`, which is deterministic for a given input.
  const matched = new Set(resolutions.flatMap((resolution) => resolution.matchedPaths))
  return {
    command: resolutions.map((resolution) => resolution.command).join(" && "),
    // Report the narrowest tier only when EVERY contributing group achieved it;
    // otherwise the batch as a whole fell back to a project manifest.
    rationale: resolutions.every((resolution) => resolution.rationale === "basename")
      ? "basename"
      : "fallback:package-script",
    // Rebuilt in the caller's original path order so the composer's `Observed:` list
    // reads the same way regardless of how many ecosystems were involved.
    matchedPaths: paths.filter((path) => matched.has(path)),
  }
}
