/**
 * src/v2/resolve.ts — Narrowest-verifier resolution (US-3 / FR-008, FR-009, FR-010).
 *
 * Pure, injectable resolver: given the paths a mutation touched and (optionally) the
 * active story's bound verifiers, returns the narrowest runnable command that verifies
 * those changes. No real fs or subprocess access happens inside `resolveVerifier`
 * itself — the caller supplies a `readManifest()` snapshot (cached per-turn) and may
 * inject a bounded `fallbackProbe` for the ambiguous case (FR-009).
 *
 * Tier order (FR-008):
 *   1. active-story verifiers
 *   2. basename convention (`*.test.*` / `*.spec.*`) matched via the cached manifest
 *   3. package-manifest scripts (nearest manifest wins in a monorepo)
 *   4. generic category list — rationale "none", command null. The caller renders the
 *      generic list text and logs `resolution:none` (FR-010); this module never logs.
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
  /** Already filtered to inside the worktree by the caller (row 10: outside-worktree paths never reach this function). */
  changedPaths: string[]
  storyVerifiers: readonly string[] | null
}

export interface ResolveDeps {
  /** Cached per-turn by the caller — may be called more than once per resolveVerifier call; the caller owns the cache, not this module. */
  readManifest(): Manifest | null
  /**
   * Optional bounded (<=250ms) fallback the caller may inject for the ambiguous case.
   * Omitted in unit tests (fixture-driven, no real fs/subprocess). This module never
   * calls it without a caller-supplied cap — i.e. it is only ever invoked when the
   * caller has chosen to provide it, and only as the very last resort before the
   * generic degrade, never speculatively or more than once per resolveVerifier call.
   *
   * Scoped to the JS/TS group: the globs it is handed are the `*.test.*` / `*.spec.*`
   * basename convention, which is a Node convention. Go/Python/Rust never reach it,
   * so the "at most once per call" guarantee is unchanged by language awareness.
   */
  fallbackProbe?: (globs: string[]) => string[]
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
 * Normalise a changed path to the bare repo-relative form the manifest's roots
 * use.
 *
 * Roots come from `manifest.ts` as `relative(repoRoot, dir)` -- bare and
 * repo-relative ("services/api"). Changed paths do NOT arrive that way:
 * opencode's `edit`/`write` tools declare `filePath` as an ABSOLUTE path and
 * `changedPathsFromTool` passes it through verbatim, and a `./`-prefixed form
 * is equally common. Comparing those against a bare root silently matched
 * nothing, so every nested project root fell back to the repo root -- the
 * scoping feature was inert in production while its unit tests, which feed only
 * bare-relative paths, stayed green. The npm case was worse than inert: it
 * degraded `npm test -w packages/api` to bare `npm test`, re-opening the
 * fabrication the workspace-selector rule exists to close.
 *
 * `workspaceRoot` is unknown here (this module is pure), so an absolute path is
 * reduced by finding the root segment within it rather than by subtraction.
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
 * Tier 3: package-manifest scripts, nearest manifest wins (dataset row 9). Judgment
 * call (undocumented by the spec beyond the single-path row 9 case): when multiple
 * changed paths span different workspaces, the FIRST changed path's nearest workspace
 * decides the command for the whole batch, since `ResolutionResult` carries only one
 * command. "Nearest" walks from the most specific (longest) matching root down to the
 * repo root (`""`), picking the first workspace whose `scripts.test` is usable.
 */
function resolvePackageScript(paths: readonly string[], manifest: Manifest): { command: string } | null {
  if (paths.length === 0) return null

  const workspaces = collectWorkspaces(manifest)
    .filter((workspace) => typeof workspace.scripts.test === "string" && workspace.scripts.test.trim().length > 0)
    .sort((a, b) => b.root.length - a.root.length)

  const primaryPath = paths[0]
  const nearest = workspaces.find((workspace) => isWithinWorkspace(primaryPath, workspace.root))
  if (!nearest) return null

  const command = nearest.root === "" ? "npm test" : `npm test -w ${nearest.root}`
  return { command }
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

/** Tiers 2/3 (+ FR-009 probe) for the JS/TS group — unchanged from the npm-only resolver. */
function resolveNodeGroup(
  paths: readonly string[],
  manifest: Manifest | null,
  deps: ResolveDeps,
): GroupResolution | null {
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

  // FR-009: bounded fallback, last resort before the generic degrade. Only invoked
  // when the caller supplied one — never called speculatively, never called more than
  // once, and this module never applies its own timeout: bounding it is the caller's
  // job (the <=250ms cap lives in the caller's `fallbackProbe` implementation).
  if (deps.fallbackProbe) {
    const globs = paths.flatMap((path) => {
      const base = baseNameNoExt(path)
      return [`**/${base}.test.*`, `**/${base}.spec.*`]
    })
    const found = deps.fallbackProbe(globs)
    if (found.length > 0) {
      const matched = matchBasenameConvention(paths, found)
      if (matched.testFiles.length > 0) {
        return {
          command: `npx vitest run ${matched.testFiles.join(" ")}`,
          rationale: "basename",
          matchedPaths: matched.matchedPaths,
        }
      }
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
  const paths = ctx.changedPaths.filter((path) => path.trim().length > 0)

  if (paths.length === 0) {
    return { command: null, rationale: "none", matchedPaths: [] }
  }

  // Tier 1: active-story verifiers. Story precedence is absolute — a story that
  // declares its own verifiers overrides every ecosystem inference below.
  const storyVerifiers = (ctx.storyVerifiers ?? []).filter((verifier) => verifier.trim().length > 0)
  if (storyVerifiers.length > 0) {
    return { command: storyVerifiers.join(" && "), rationale: "story", matchedPaths: [...paths] }
  }

  const manifest = deps.readManifest()

  const resolutions: GroupResolution[] = []
  for (const group of partitionByEcosystem(paths, manifest)) {
    const resolved =
      group.ecosystem === "node"
        ? resolveNodeGroup(group.paths, manifest, deps)
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
