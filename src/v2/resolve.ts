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
 */

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
 * `testFiles` and `workspaces` are additive, optional fields that carry the extra data
 * the tier algorithm needs; omitting them degrades gracefully (empty/undefined behaves
 * like "no candidates at this tier").
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

function isWithinWorkspace(path: string, root: string): boolean {
  if (root === "") return true
  return path === root || path.startsWith(`${root}/`)
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
 * FR-008: resolve the narrowest verifier command for a set of already-filtered changed
 * paths. Pure/injectable — no real fs or subprocess access happens in here; `deps`
 * supplies everything this function reads.
 */
export function resolveVerifier(ctx: ResolveContext, deps: ResolveDeps): ResolutionResult {
  const paths = ctx.changedPaths.filter((path) => path.trim().length > 0)

  if (paths.length === 0) {
    return { command: null, rationale: "none", matchedPaths: [] }
  }

  // Tier 1: active-story verifiers.
  const storyVerifiers = (ctx.storyVerifiers ?? []).filter((verifier) => verifier.trim().length > 0)
  if (storyVerifiers.length > 0) {
    return { command: storyVerifiers.join(" && "), rationale: "story", matchedPaths: [...paths] }
  }

  const manifest = deps.readManifest()

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

  // Tier 4: generic category list. The caller renders the actual category text and
  // logs `resolution:none` (FR-010) — this module only signals the degrade.
  return { command: null, rationale: "none", matchedPaths: [] }
}
