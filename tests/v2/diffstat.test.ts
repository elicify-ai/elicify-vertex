/**
 * elicify-vertex v2 — `src/v2/diffstat.ts` (BACKLOG B-3).
 *
 * These drive REAL git against REAL temporary directories: the whole defect
 * B-3 records is about what git does when the workspace is not what the code
 * assumed (not a repository at all; a repository whose changes are all
 * untracked), and a mocked `execFileSync` would have agreed with the
 * assumption instead of exposing it.
 *
 * Every test here is a mutation guard — each fails if the specific fix it
 * covers is removed. See this file's cases for which is which, and
 * `diffstat.ts`'s header for the measured failure.
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  CHANGED_PATHS_HEADER,
  computeBoundedDiffStat,
  DIFF_UNAVAILABLE_GIT_FAILED,
  DIFF_UNAVAILABLE_NOT_A_REPO,
  DIFF_UNAVAILABLE_NO_CHANGES,
  DIFF_UNAVAILABLE_UNATTRIBUTED,
  formatChangedPathsSummary,
  hasUnattributedMutation,
  isPathListAnnouncementOnly,
  realChangedPaths,
  toWorkspaceRelative,
  UNATTRIBUTED_MUTATION_NOTE,
  UNTRACKED_FILES_HEADER,
} from "../../src/v2/diffstat.js"

/** Identity in the ENV, not in a config file: the temp repo has no user
 * config and `git commit` refuses without one. Only the test helper needs
 * it — `computeBoundedDiffStat` itself only ever runs read-only git. */
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "vertex test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "vertex test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"] })
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vertex-diffstat-"))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function initRepo(): void {
  git(dir, "init", "-q")
  git(dir, "config", "commit.gpgsign", "false")
}

function write(rel: string, text: string): string {
  const abs = join(dir, rel)
  mkdirSync(join(abs, ".."), { recursive: true })
  writeFileSync(abs, text)
  return abs
}

// ===========================================================================
// (a) workspace-relative paths — the fix that kills the entropy drop
// ===========================================================================

describe("toWorkspaceRelative", () => {
  it("shortens an absolute path inside the workspace", () => {
    expect(toWorkspaceRelative("/workspace/vertextest4/src/games/breakout.js", "/workspace/vertextest4")).toBe(
      "src/games/breakout.js",
    )
  })

  it("leaves a path OUTSIDE the workspace absolute (a ../../ chain is longer and less readable, not more correct)", () => {
    expect(toWorkspaceRelative("/etc/hosts", "/workspace/vertextest4")).toBe("/etc/hosts")
  })

  it("leaves an already-relative path and the non-path mutation markers untouched", () => {
    expect(toWorkspaceRelative("src/a.ts", "/workspace/x")).toBe("src/a.ts")
    expect(toWorkspaceRelative("bash-mutation", "/workspace/x")).toBe("bash-mutation")
  })

  it("does not mistake a file whose NAME starts with two dots for an escaping path", () => {
    expect(toWorkspaceRelative("/workspace/x/..hidden.js", "/workspace/x")).toBe("..hidden.js")
  })
})

describe("formatChangedPathsSummary — B-3 fix (a)", () => {
  const FIELD_PATHS = [
    "/workspace/vertextest4/src/games/memory.js",
    "/workspace/vertextest4/src/games/index.html",
    "/workspace/vertextest4/src/games/breakout.js",
  ]

  it("emits workspace-relative paths, one per indented line — never the absolute comma-joined list", () => {
    const out = formatChangedPathsSummary(FIELD_PATHS, "/workspace/vertextest4")
    expect(out).not.toContain("/workspace/vertextest4")
    expect(out.split("\n")).toEqual([
      "changed paths (no diff available):",
      "  src/games/memory.js",
      "  src/games/index.html",
      "  src/games/breakout.js",
    ])
  })

  it("every emitted path token stays under the entropy rule's 32-char floor for this measured input", () => {
    // The floor is what makes fix (a) robust rather than lucky: a token
    // shorter than ENTROPY_MIN_TOKEN_LENGTH (32) is never even scored, so
    // its entropy is irrelevant. The absolute originals were 42-44 chars and
    // scored 3.910-4.190 bits/char against a 3.95 threshold.
    for (const line of formatChangedPathsSummary(FIELD_PATHS, "/workspace/vertextest4").split("\n").slice(1)) {
      for (const token of line.split(/\s+/).filter((t) => t.length > 0)) {
        expect(token.length).toBeLessThan(32)
      }
    }
  })

  it("keeps the non-path mutation markers (they are evidence too, just not paths)", () => {
    expect(formatChangedPathsSummary(["bash-mutation"], "/workspace/x")).toContain("  bash-mutation")
  })

  it("says so when the ledger recorded nothing", () => {
    expect(formatChangedPathsSummary([], "/workspace/x")).toBe("no changed paths recorded")
  })
})

// ===========================================================================
// (c) isPathListAnnouncementOnly — an emptied list is ABSENT, not empty
//
// `toWorkspaceRelative` deliberately leaves a path that resolves OUTSIDE the
// workspace root absolute, and relativising against a root of "/" only strips
// the leading slash. Either way the path lines keep the length and entropy
// that trip the verifier's own secret scan, which then deletes every path and
// keeps the header — a colon and a promise of a file list containing nothing,
// shipped as a DEFINED field so the insufficient-evidence guard cannot see it.
// ===========================================================================

describe("isPathListAnnouncementOnly — B-3 fix (c)", () => {
  it("says yes to a header with every path stripped out", () => {
    expect(isPathListAnnouncementOnly(CHANGED_PATHS_HEADER)).toBe(true)
    expect(isPathListAnnouncementOnly(UNTRACKED_FILES_HEADER)).toBe(true)
    expect(isPathListAnnouncementOnly(`${CHANGED_PATHS_HEADER}\n\n${UNTRACKED_FILES_HEADER}\n`)).toBe(true)
    expect(isPathListAnnouncementOnly(`${UNTRACKED_FILES_HEADER}\n  … and 37 more`)).toBe(true)
  })

  it("says no the moment ONE real path survives — otherwise the fix would recreate B-3 itself", () => {
    expect(isPathListAnnouncementOnly(`${CHANGED_PATHS_HEADER}\n  src/a.ts`)).toBe(false)
    expect(isPathListAnnouncementOnly(`${UNTRACKED_FILES_HEADER}\n  src/b.ts\n  … and 3 more`)).toBe(false)
  })

  it("says no to anything that is not a path-list announcement at all", () => {
    // Narrow on purpose: no header means this predicate has no opinion, so a
    // real `git diff --stat`, an empty field, or arbitrary prose is never
    // reclassified as "an empty list".
    expect(isPathListAnnouncementOnly("")).toBe(false)
    expect(isPathListAnnouncementOnly("\n\n")).toBe(false)
    expect(isPathListAnnouncementOnly(" src/v2/plugin.ts | 42 ++--\n 1 file changed")).toBe(false)
    expect(isPathListAnnouncementOnly("no changed paths recorded")).toBe(false)
  })

  it("the header it matches is the header formatChangedPathsSummary actually prints", () => {
    // The two must not drift: a renamed header would silently turn the check
    // back off and restore the defect with no test failing anywhere else.
    expect(formatChangedPathsSummary(["src/a.ts"], "/workspace/x").split("\n")[0]).toBe(CHANGED_PATHS_HEADER)
  })
})

// ===========================================================================
// (b) computeBoundedDiffStat — a stated reason instead of a silent ""
// ===========================================================================

describe("computeBoundedDiffStat — B-3 fix (b)", () => {
  it("REGRESSION (the field failure): outside a git repository it returns the explicit not-a-repo reason, never a silent empty string", () => {
    // The measured root cause: the project under test was not a repo, git
    // exited non-zero, and the old catch returned "" with no record of why.
    const result = computeBoundedDiffStat(dir, [join(dir, "src/games/breakout.js")])
    expect(result.text).toBe("")
    expect(result.unavailableReason).toBe(DIFF_UNAVAILABLE_NOT_A_REPO)
    expect(result.unavailableReason).toContain("not a git repository")
  })

  it("distinguishes 'no repository' from 'git broke' — the not-a-repo reason is NOT the generic git-failed one", () => {
    // Mutation guard for the `rev-parse --is-inside-work-tree` probe: delete
    // it and a non-repo falls through to the `git diff` failure path, which
    // reports DIFF_UNAVAILABLE_GIT_FAILED instead.
    const result = computeBoundedDiffStat(dir, [])
    expect(result.unavailableReason).not.toBe(DIFF_UNAVAILABLE_GIT_FAILED)
  })

  it("in a real repository, a modified tracked file produces a real --stat", () => {
    initRepo()
    const abs = write("src/app.ts", "const a = 1\n")
    git(dir, "add", "-A")
    git(dir, "commit", "-q", "-m", "init")
    writeFileSync(abs, "const a = 1\nconst b = 2\n")

    const result = computeBoundedDiffStat(dir, [abs])
    expect(result.unavailableReason).toBeUndefined()
    expect(result.text).toContain("src/app.ts")
    expect(result.text).toContain("|")
  })

  it("lists UNTRACKED new files, which `git diff --stat` shows nothing for", () => {
    // The gap that would have recurred inside a real repository: a session
    // that only creates new files has an empty `git diff --stat`, so the old
    // code returned "" and the verifier again judged with no file evidence.
    initRepo()
    git(dir, "commit", "-q", "-m", "init", "--allow-empty")
    const abs = write("src/games/breakout.js", "// brand new file\n")

    const result = computeBoundedDiffStat(dir, [abs])
    expect(result.unavailableReason).toBeUndefined()
    expect(result.text).toContain("src/games/breakout.js")
    expect(result.text).toContain("untracked")
  })

  it("untracked paths are listed one per indented line, so the payload scan can drop one without losing the field", () => {
    initRepo()
    git(dir, "commit", "-q", "-m", "init", "--allow-empty")
    const a = write("src/games/breakout.js", "// new\n")
    const b = write("src/games/memory.js", "// new\n")

    const lines = computeBoundedDiffStat(dir, [a, b]).text.split("\n")
    expect(lines).toContain("  src/games/breakout.js")
    expect(lines).toContain("  src/games/memory.js")
  })

  it("in a clean repository it says the repo is clean — a DIFFERENT fact from 'there is no repo'", () => {
    initRepo()
    write("src/app.ts", "const a = 1\n")
    git(dir, "add", "-A")
    git(dir, "commit", "-q", "-m", "init")

    const result = computeBoundedDiffStat(dir, [join(dir, "src/app.ts")])
    expect(result.text).toBe("")
    expect(result.unavailableReason).toBe(DIFF_UNAVAILABLE_NO_CHANGES)
  })

  it("a recorded path pointing OUTSIDE the repo does not take the whole summary down with it", () => {
    // git exits `fatal:` on a pathspec outside the work tree, and the old
    // code's single try/catch turned that into the same silent "".
    initRepo()
    const abs = write("src/app.ts", "const a = 1\n")
    git(dir, "add", "-A")
    git(dir, "commit", "-q", "-m", "init")
    writeFileSync(abs, "const a = 1\nconst b = 2\n")

    const result = computeBoundedDiffStat(dir, ["/etc/hosts", abs])
    expect(result.text).toContain("src/app.ts")
  })

  it("the non-path mutation markers are never handed to git as pathspecs", () => {
    initRepo()
    const abs = write("src/app.ts", "const a = 1\n")
    git(dir, "add", "-A")
    git(dir, "commit", "-q", "-m", "init")
    writeFileSync(abs, "const a = 1\nconst b = 2\n")

    // "bash-mutation" as a pathspec would make git exit `fatal: ... did not
    // match any files` and lose the real diff alongside it.
    const result = computeBoundedDiffStat(dir, ["bash-mutation", abs])
    expect(result.text).toContain("src/app.ts")
  })
})

// ===========================================================================
// THE THIRD STATE: "something changed and we cannot say what"
// ===========================================================================
//
// Before this, an all-marker changed-path list filtered down to `[]` at every
// call site — byte-identical to a turn that genuinely changed nothing. That
// equivalence is what amplified the bash-attribution bug into a blind harness:
// `hasChangedFiles` was TRUE while the filtered list was EMPTY, so the verifier
// was handed silence and told nothing was wrong with it.

describe("the unattributed-mutation state is distinguishable from a clean turn", () => {
  it("separates the three states", () => {
    expect(realChangedPaths([])).toEqual([])
    expect(hasUnattributedMutation([])).toBe(false)

    expect(realChangedPaths(["/w/a.ts"])).toEqual(["/w/a.ts"])
    expect(hasUnattributedMutation(["/w/a.ts"])).toBe(false)

    // State 3 — the one that used to be indistinguishable from state 1.
    expect(realChangedPaths(["bash-mutation"])).toEqual([])
    expect(hasUnattributedMutation(["bash-mutation"])).toBe(true)
    expect(hasUnattributedMutation(["/w/a.ts", "bash-mutation"])).toBe(true)
  })

  it("does not claim git was asked about paths when there were none", () => {
    // `DIFF_UNAVAILABLE_NO_CHANGES` says git "reports no tracked modification
    // and no untracked file FOR THE RECORDED PATHS" — a false statement, and a
    // reassuring one, when the only record was a pathless marker.
    initRepo()
    write("src/app.ts", "const a = 1\n")
    git(dir, "add", "-A")
    git(dir, "commit", "-q", "-m", "init")

    const result = computeBoundedDiffStat(dir, ["bash-mutation"])
    expect(result.text).toBe("")
    expect(result.unavailableReason).toBe(DIFF_UNAVAILABLE_UNATTRIBUTED)
    expect(result.unavailableReason).not.toBe(DIFF_UNAVAILABLE_NO_CHANGES)
  })

  it("still says NO_CHANGES for a genuinely clean turn", () => {
    initRepo()
    write("src/app.ts", "const a = 1\n")
    git(dir, "add", "-A")
    git(dir, "commit", "-q", "-m", "init")

    expect(computeBoundedDiffStat(dir, []).unavailableReason).toBe(DIFF_UNAVAILABLE_NO_CHANGES)
  })

  it("tells the verifier a real diff is INCOMPLETE when a marker rode along with it", () => {
    initRepo()
    const abs = write("src/app.ts", "const a = 1\n")
    git(dir, "add", "-A")
    git(dir, "commit", "-q", "-m", "init")
    writeFileSync(abs, "const a = 1\nconst b = 2\n")

    const result = computeBoundedDiffStat(dir, [abs, "bash-mutation"])
    expect(result.text).toContain("src/app.ts")
    expect(result.text).toContain(UNATTRIBUTED_MUTATION_NOTE)
  })

  it("labels the marker in the fallback path list instead of leaving it to read as a filename", () => {
    const summary = formatChangedPathsSummary(["bash-mutation"], "/workspace/x")
    expect(summary).toContain("  bash-mutation")
    expect(summary).toContain(UNATTRIBUTED_MUTATION_NOTE)
  })

  it("adds no note when every recorded entry is a real path", () => {
    expect(formatChangedPathsSummary(["/workspace/x/src/a.ts"], "/workspace/x")).not.toContain(
      UNATTRIBUTED_MUTATION_NOTE,
    )
  })

  it("does not let the note keep an emptied path list looking populated", () => {
    // B-3's guard: if the payload's secret scan deletes every path line, what
    // is left must still read as ABSENT. Prose about the list is not the list.
    expect(isPathListAnnouncementOnly(`${CHANGED_PATHS_HEADER}\n${UNATTRIBUTED_MUTATION_NOTE}`)).toBe(true)
    expect(isPathListAnnouncementOnly(`${CHANGED_PATHS_HEADER}\n  src/a.ts\n${UNATTRIBUTED_MUTATION_NOTE}`)).toBe(false)
  })
})
