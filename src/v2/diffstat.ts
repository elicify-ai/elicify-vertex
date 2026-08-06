/**
 * elicify-vertex v2 — the verifier's file-level evidence (`diffSummary`).
 *
 * Extracted from `plugin.ts` (where `computeBoundedDiffStat` and
 * `formatChangedPathsSummary` were a module-private function and a closure
 * inside the plugin factory, i.e. untestable) as part of BACKLOG B-3.
 *
 * ---------------------------------------------------------------------------
 * B-3, THE REPRODUCED FAILURE THIS MODULE EXISTS TO STOP.
 *
 * In the audited field session the verifier ran once and logged
 * `verifier:field-dropped {field:"diffSummary"}` — it judged a completed plan
 * with NO file evidence at all. The chain, measured end to end:
 *
 *  1. the project under test was NOT a git repository, so `git diff --stat`
 *     exited non-zero, `execFileSync` threw, and the old catch returned `""`
 *     — silently, with no reason recorded anywhere;
 *  2. the caller fell back to a comma-joined list of ABSOLUTE paths, so the
 *     raw field was never empty and nothing looked wrong;
 *  3. that list went through the FR-031 secret scan
 *     (`scanDiffSummaryField`), which — finding no `@@` hunk header — treated
 *     the WHOLE blob as one removal unit, and the entropy rule (>= 3.95
 *     bits/char over whitespace-separated tokens of >= 32 chars) fired on the
 *     long absolute paths. Measured on the real strings:
 *
 *       "/workspace/vertextest4/src/games/memory.js,"   43 chars  3.979 bits
 *       "/workspace/vertextest4/src/games/index.html,"  44 chars  4.190 bits
 *       "/workspace/vertextest4/src/games/breakout.js"  44 chars  3.971 bits
 *
 *     One trip emptied the single unit, so the entire field was dropped. The
 *     harness's own secret redaction ate its own file list.
 *
 * Two independent properties fix that here (the third, per-LINE scanning of a
 * hunk-less field, lives in `verifier.ts` where the scan does):
 *
 *  - paths are emitted WORKSPACE-RELATIVE. Measured on the same files:
 *    "src/games/breakout.js" is 21 chars and "src/games/memory.js," is 20 —
 *    both under the entropy rule's 32-char token floor, so they are never
 *    even scored. (Their entropy, 3.785 and 3.546 bits/char, is beside the
 *    point: the floor is what makes this robust rather than lucky.)
 *  - one path per LINE, each indented by two spaces, instead of one
 *    comma-joined line. Two reasons, both load-bearing: the scan's removal
 *    unit for a hunk-less field is a line, so a single suspicious path can
 *    now cost one line instead of the whole field; and the scan's
 *    adjacent-unit boundary check concatenates neighbouring units with their
 *    newlines stripped, which would FUSE two bare paths into one long token
 *    ("src/a.jssrc/b.js") and hand the entropy rule back exactly the input it
 *    just lost. The leading indent survives that concatenation as
 *    whitespace, so the tokens stay separate.
 *
 * A real `git diff --stat` never had this problem — its `++++`/`----` runs
 * measure 0.732 bits/char and its longest token is the `+/-` bar — which is
 * why this only ever bit outside a repository.
 */

import { execFileSync } from "node:child_process"
import { isAbsolute, relative as relativePath, sep as pathSep } from "node:path"

/** Does this relative path climb OUT of the directory it is relative to?
 * `".."` and `"../x"` do; `"..foo"` (a file whose name starts with two dots)
 * does not, which a bare `startsWith("..")` would get wrong. */
function escapesRoot(rel: string): boolean {
  return rel === ".." || rel.startsWith(`..${pathSep}`) || rel.startsWith("../")
}

/** Markers `changedPathsFromTool` records for a mutation whose path is not
 * knowable (a bash edit, a patch, an in-place edit). Not paths: never handed
 * to git, but still worth showing the verifier in the fallback list. */
export const NON_PATH_MUTATION_MARKERS = new Set(["edit-mutation", "patch-mutation", "bash-mutation"])

const GIT_TIMEOUT_MS = 2000
const DIFF_STAT_MAX_CHARS = 4000
/** Cap on the untracked-file list. A fresh repo with no `.gitignore` can have
 * thousands; the verifier needs the shape of the change, not an inventory. */
const MAX_UNTRACKED_LISTED = 50

/**
 * The verifier's file-level evidence, plus — B-3 fix (d) — the REASON it is
 * thin when it is thin.
 *
 * The old contract was a bare `string`, so "here is the diff" and "there is
 * no diff and here is a path list instead" were the same value with no way
 * to tell them apart. The verifier then judged around a hole it could not
 * see. `unavailableReason` is set exactly when `text` is NOT a real git diff,
 * and is carried into the payload as its own field so the judge can cite it.
 */
export interface DiffStatResult {
  /** The diff summary, or `""` when git produced nothing usable. */
  text: string
  /** Present only when `text` is not a real git diff. Fixed prose, chosen
   * from the constants below — never interpolated with a path or any other
   * host string, so it cannot itself trip the payload's secret scan and
   * vanish, which would recreate the silent hole this field exists to end. */
  unavailableReason?: string
}

export const DIFF_UNAVAILABLE_NOT_A_REPO =
  "no diff: the workspace is not a git repository (`git rev-parse --is-inside-work-tree` says no), so no `git diff` could be produced. The changed-path list is the only file-level evidence available — do not read the absence of a diff as evidence that nothing changed."

export const DIFF_UNAVAILABLE_GIT_FAILED =
  "no diff: `git diff --stat` could not be run in the workspace (git missing, timed out, or errored). The changed-path list is the only file-level evidence available — do not read the absence of a diff as evidence that nothing changed."

export const DIFF_UNAVAILABLE_NO_CHANGES =
  "no diff: this IS a git repository, and git reports no tracked modification and no untracked file for the recorded paths — the work may already be committed, or reverted. Check with git before crediting or faulting a claim."

function runGit(args: string[], cwd: string): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      // Node inherits the child's stderr by default for execFileSync, so it
      // is written STRAIGHT to the terminal running opencode — past the TUI's
      // renderer, which then has no idea the screen changed and draws over a
      // corrupted frame. Outside a git repo `git diff` prints a warning plus
      // its entire usage page (measured: 7,393 bytes) to stderr, so pointing
      // the harness at a non-repo folder wrecked the display on every idle.
      // The `catch` below swallowed the exception but never the output, which
      // is why the event log looked perfectly healthy throughout.
      stdio: ["ignore", "pipe", "pipe"],
    })
  } catch {
    return undefined
  }
}

/**
 * A path as the verifier should read it: relative to the workspace root.
 *
 * Non-absolute input (already relative, or one of the mutation markers) is
 * returned unchanged. An absolute path that resolves OUTSIDE the workspace is
 * also returned unchanged — a `../../..` chain is longer and less readable
 * than the absolute form, and shortening is a readability fix, not a
 * correctness one.
 */
export function toWorkspaceRelative(path: string, cwd: string): string {
  if (!isAbsolute(path)) return path
  const rel = relativePath(cwd, path)
  if (rel.length === 0 || isAbsolute(rel) || escapesRoot(rel)) return path
  return rel
}

/**
 * The fallback file-level evidence: the paths the ledger recorded, one per
 * indented line, workspace-relative. See this module's header for why the
 * shape (relative + one per line + indented) is the fix and not cosmetics.
 */
export function formatChangedPathsSummary(paths: readonly string[], cwd: string): string {
  if (paths.length === 0) return "no changed paths recorded"
  const lines = paths.map((p) => `  ${toWorkspaceRelative(p, cwd)}`)
  return ["changed paths (no diff available):", ...lines].join("\n")
}

/**
 * FIX #7 (verifier payload richness): a bounded `git diff --stat` for the
 * currently changed paths, invoked at verifier-invocation time only
 * (`session.idle`, which FR-009 does NOT list among the prohibited hot
 * paths — only `tool.execute.after`/`system.transform` are). Never throws:
 * a missing `git` binary, a non-repo `cwd`, or a timeout all degrade to an
 * empty `text` — but now with a STATED `unavailableReason` (B-3 fix (b)),
 * because the silent `""` is precisely what let the verifier judge a
 * completed plan with no file evidence and no record of why.
 *
 * Two gaps the old version had, both closed here:
 *
 *  - **not a repository.** Probed once with `git rev-parse
 *    --is-inside-work-tree` rather than inferred from a `git diff` failure,
 *    so "there is no repo here" is distinguishable from "git broke".
 *  - **untracked files.** `git diff --stat` shows NOTHING for a file that has
 *    never been added — so a session that created ten new files in a real
 *    repository produced an empty diff and the same silent hole. They are
 *    listed separately via `git ls-files --others --exclude-standard`, which
 *    is only run when the ledger recorded paths to scope it to (unscoped, it
 *    would enumerate every untracked file in the repo).
 *
 * This is a `--stat` summary, not full hunks — a size-capped full `git diff`
 * for the changed paths is a reasonable follow-up if the verifier needs more
 * than file-level shape, but is not implemented here.
 */
export function computeBoundedDiffStat(cwd: string, changedPaths: readonly string[]): DiffStatResult {
  const insideWorkTree = runGit(["rev-parse", "--is-inside-work-tree"], cwd)
  if (insideWorkTree === undefined || insideWorkTree.trim() !== "true") {
    return { text: "", unavailableReason: DIFF_UNAVAILABLE_NOT_A_REPO }
  }

  // Relative pathspecs only: git resolves them against `cwd`, they are what
  // the diff prints back anyway, and an absolute path pointing outside the
  // repo makes git exit `fatal:` and take the whole summary down with it.
  const pathspecs = changedPaths
    .filter((p) => !NON_PATH_MUTATION_MARKERS.has(p))
    .map((p) => toWorkspaceRelative(p, cwd))
    .filter((p) => !isAbsolute(p) && !escapesRoot(p))

  const stat = runGit(pathspecs.length > 0 ? ["diff", "--stat", "--", ...pathspecs] : ["diff", "--stat"], cwd)
  if (stat === undefined) return { text: "", unavailableReason: DIFF_UNAVAILABLE_GIT_FAILED }

  const untracked =
    pathspecs.length > 0 ? (runGit(["ls-files", "--others", "--exclude-standard", "--", ...pathspecs], cwd) ?? "") : ""

  const sections: string[] = []
  if (stat.trim().length > 0) sections.push(stat.trim())

  const untrackedPaths = untracked
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  if (untrackedPaths.length > 0) {
    const shown = untrackedPaths.slice(0, MAX_UNTRACKED_LISTED)
    const overflow = untrackedPaths.length - shown.length
    // Same indent-per-line shape as `formatChangedPathsSummary`, for the same
    // two reasons (per-line removal unit; no token fusion across the
    // adjacent-unit boundary check). See this module's header.
    sections.push(
      [
        "new files, untracked — `git diff --stat` never lists these, so their content is NOT in the diff above:",
        ...shown.map((p) => `  ${p}`),
        ...(overflow > 0 ? [`  … and ${overflow} more`] : []),
      ].join("\n"),
    )
  }

  if (sections.length === 0) return { text: "", unavailableReason: DIFF_UNAVAILABLE_NO_CHANGES }

  const joined = sections.join("\n")
  const text = joined.length > DIFF_STAT_MAX_CHARS ? `${joined.slice(0, DIFF_STAT_MAX_CHARS)}\n… (truncated)` : joined
  return { text }
}
