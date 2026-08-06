/**
 * Wave-3 wiring — real (bounded) filesystem-backed `Manifest` reader for
 * `resolve.ts`'s `ResolveDeps.readManifest()`.
 *
 * `resolve.ts` itself is pure/injectable and never touches the filesystem;
 * wiring supplies the manifest. FR-008 calls this "a per-turn cached
 * manifest", so results are memoized per `workspaceRoot` and only rebuilt
 * once `invalidate()` is called (wiring calls it once per `chat.message`,
 * i.e. once per turn) — this keeps the read out of the `tool.execute.after`/
 * `experimental.chat.system.transform` hot-path budget (SC-003).
 *
 * Deliberately NOT a full glob engine (this project has zero runtime
 * dependencies, matching `story.ts`'s own minimal-glob judgment call for
 * `scopeGlobs`): workspace globs support only a single trailing `*`
 * (`"packages/*"`), which covers the conventional npm/pnpm workspace layout
 * the spec's own dataset row 9 uses. The test-file scan is depth- and
 * count-bounded so a pathological repo layout cannot blow the latency
 * budget or run forever.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import { join, relative } from "node:path"

import type { Manifest, ProjectRoot } from "../resolve.js"

const SKIP_DIR_NAMES = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".elicify-vertex",
  ".vite",
])
const TEST_FILE_RE = /\.(?:test|spec)\.[^./]+$/

/**
 * Manifest filenames that mark the root of a non-npm project, and the ecosystem
 * each implies. Collected on the SAME bounded walk as the test-file scan rather
 * than a second traversal, because this read sits on the per-turn latency budget
 * (SC-003).
 *
 * Without this, `resolve.ts`'s per-ecosystem scoping is inert in production: it
 * falls back to the repo root for every non-npm ecosystem. That is still correct
 * for a single-module repo and never cross-ecosystem, but a nested Go module or
 * a Cargo workspace member resolves to a command that is too broad.
 */
const PROJECT_ROOT_FILES: ReadonlyMap<string, ProjectRoot["ecosystem"]> = new Map([
  ["go.mod", "go"],
  ["pyproject.toml", "python"],
  ["setup.cfg", "python"],
  ["pytest.ini", "python"],
  ["tox.ini", "python"],
  ["Cargo.toml", "rust"],
])
const MAX_FILES_SCANNED = 5000
const MAX_SCAN_DEPTH = 8

interface PackageJsonShape {
  scripts: Record<string, string>
  workspaces?: string[]
}

function readPackageJson(dir: string): PackageJsonShape | null {
  try {
    const raw = readFileSync(join(dir, "package.json"), "utf8")
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return null
    const obj = parsed as Record<string, unknown>
    const scripts =
      obj.scripts && typeof obj.scripts === "object" ? (obj.scripts as Record<string, string>) : {}
    const rawWorkspaces = obj.workspaces
    let workspaces: string[] | undefined
    if (Array.isArray(rawWorkspaces)) {
      workspaces = rawWorkspaces.filter((w): w is string => typeof w === "string")
    } else if (rawWorkspaces && typeof rawWorkspaces === "object" && Array.isArray((rawWorkspaces as { packages?: unknown }).packages)) {
      workspaces = ((rawWorkspaces as { packages: unknown[] }).packages).filter(
        (w): w is string => typeof w === "string",
      )
    }
    return { scripts, workspaces }
  } catch {
    return null
  }
}

/** Single trailing `*` only (e.g. `"packages/*"`); literal directories pass through unchanged. */
function expandWorkspaceGlob(root: string, glob: string): string[] {
  if (!glob.includes("*")) {
    return existsSync(join(root, glob)) ? [glob] : []
  }
  const starIdx = glob.indexOf("*")
  const prefix = glob.slice(0, starIdx).replace(/\/$/, "")
  const baseDir = join(root, prefix)
  if (!existsSync(baseDir)) return []
  try {
    return readdirSync(baseDir)
      .filter((name) => {
        try {
          return statSync(join(baseDir, name)).isDirectory()
        } catch {
          return false
        }
      })
      .map((name) => (prefix ? `${prefix}/${name}` : name))
  } catch {
    return []
  }
}

function scanRepo(root: string): { testFiles: string[]; projectRoots: ProjectRoot[] } {
  const results: string[] = []
  const projectRoots: ProjectRoot[] = []
  let scanned = 0
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_SCAN_DEPTH || scanned > MAX_FILES_SCANNED) return
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      if (scanned > MAX_FILES_SCANNED) return
      scanned += 1
      const full = join(dir, name)
      let stat: ReturnType<typeof statSync>
      try {
        stat = statSync(full)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        if (name.startsWith(".") || SKIP_DIR_NAMES.has(name)) continue
        walk(full, depth + 1)
      } else if (stat.isFile()) {
        if (TEST_FILE_RE.test(name)) {
          results.push(relative(root, full).split("\\").join("/"))
        }
        const ecosystem = PROJECT_ROOT_FILES.get(name)
        if (ecosystem) {
          // "" is the repo root itself, matching `workspaces[].root` convention.
          projectRoots.push({ ecosystem, root: relative(root, dir).split("\\").join("/") })
        }
      }
    }
  }
  walk(root, 0)
  return { testFiles: results, projectRoots }
}

/**
 * Every absolute spelling of this worktree: the real path first, then the one
 * the session was configured with if it differs.
 *
 * `resolve.ts` compares changed paths against these to decide what is inside the
 * worktree, and the two sides do not have to agree on a spelling: opencode's
 * `edit`/`write` tools report the REALPATH of the file they touched, while the
 * session's root is whatever the user opened — which may be a symlink (a linked
 * worktree, `/var` -> `/private/var`, a container bind mount). One spelling on
 * each side and no link between them means every changed path looks like it is
 * outside the repo, and the session resolves to `none` for good.
 *
 * Falls back to the given root when the path cannot be resolved (it may not
 * exist in a unit test): a missing directory is not a reason to throw out of a
 * manifest read.
 */
function rootSpellings(workspaceRoot: string): { root: string; aliases: string[] } {
  let real = workspaceRoot
  try {
    real = realpathSync(workspaceRoot)
  } catch {
    real = workspaceRoot
  }
  return { root: real, aliases: real === workspaceRoot ? [] : [workspaceRoot] }
}

export function buildManifest(workspaceRoot: string): Manifest {
  const rootPkg = readPackageJson(workspaceRoot)
  const scripts = rootPkg?.scripts ?? {}
  const workspaces: Array<{ root: string; scripts: Record<string, string> }> = []
  for (const glob of rootPkg?.workspaces ?? []) {
    for (const wsRoot of expandWorkspaceGlob(workspaceRoot, glob)) {
      const pkg = readPackageJson(join(workspaceRoot, wsRoot))
      if (pkg) workspaces.push({ root: wsRoot, scripts: pkg.scripts })
    }
  }
  const { testFiles, projectRoots } = scanRepo(workspaceRoot)
  const { root, aliases } = rootSpellings(workspaceRoot)
  return { scripts, workspaceRoot: root, workspaceRootAliases: aliases, testFiles, workspaces, projectRoots }
}

/** Per-turn manifest cache, keyed by workspace root. `invalidate()` is
 * called once per `chat.message` so a turn's resolutions share one fs scan. */
export class ManifestCache {
  private readonly cache = new Map<string, Manifest>()

  get(workspaceRoot: string): Manifest {
    let manifest = this.cache.get(workspaceRoot)
    if (!manifest) {
      manifest = buildManifest(workspaceRoot)
      this.cache.set(workspaceRoot, manifest)
    }
    return manifest
  }

  invalidate(workspaceRoot?: string): void {
    if (workspaceRoot) this.cache.delete(workspaceRoot)
    else this.cache.clear()
  }
}
