/**
 * `isMutatingBashCommand` / `changedPathsFromTool` — the signal the whole idle
 * tree branches on.
 *
 * `hasChangedFiles` is what separates `handlePromiseNoAct` from
 * `handleStatedIntentNoWork`, and what gates the zero-criteria stop block. Both
 * functions are live (`src/v2/plugin.ts`, `src/v2/resolve.ts`), but their only
 * tests lived in `tests/fixes.test.ts` and `tests/hookLifecycle.test.ts`, which
 * were deleted with the v1 plugin — leaving a regression here silent. These
 * cases are re-homed from those files; none of them ever touched v1.
 */
import { describe, expect, it } from "vitest"
import { changedPathsFromBashCommand, changedPathsFromTool, isMutatingBashCommand } from "../src/index.js"

describe("isMutatingBashCommand", () => {
  // MIN-007/008. Package managers were added to the mutation set for the
  // dependency-install case, and the first cut got both directions wrong:
  // `npm i` and any `sudo`-prefixed command were invisible, while a
  // `--dry-run` rehearsal — which writes nothing — counted as real work and
  // could satisfy the evidence floor on its own.
  it.each([
    "npm i",
    "npm i lodash",
    "sudo npm install",
    "sudo rm -rf build",
    "pnpm add -D vitest",
    // MIN-B: only the bare `sudo cmd` form was handled.
    "sudo -u dev rm -rf build",
    "sudo -E npm i",
    // MIN-A: `-n` is --no-verify / --no-clobber here, not a dry run.
    "git commit -n -m wip",
    "cp -n a b",
    "mv -n a b",
  ])("counts %j as a mutation", (cmd) => {
    expect(isMutatingBashCommand(cmd)).toBe(true)
  })

  it.each([
    "npm install --dry-run",
    "npm i --dry-run",
    "git apply --check patch.diff",
    "sudo npm install --dry-run",
  ])("does NOT count the rehearsal %j", (cmd) => {
    expect(isMutatingBashCommand(cmd), "a --dry-run writes nothing").toBe(false)
  })

  it.each([
    "git commit -m wip",
    "cat x; git commit -m y", // segment anchoring: not just the first command
    "rm -rf build",
    "mv a.txt b.txt",
    "cp a.txt b.txt",
    "mkdir -p src/new",
    "touch src/new.ts",
    "echo hello > out.txt", // redirect into the workspace
    "sed -i 's/a/b/' file.ts",
    // A turn that only installs a dependency used to read as "nothing
    // changed" — it writes node_modules and the lockfile.
    "npm install left-pad",
    "pnpm add react",
    "yarn remove lodash",
    "npm ci",
    "bun install",
  ])("treats as a mutation: %s", (cmd) => {
    expect(isMutatingBashCommand(cmd)).toBe(true)
  })

  it.each([
    "git status",
    "git diff --stat",
    "npm test",
    "ls -la",
    "cat package.json",
    "grep -r foo src/",
    "npx vitest run",
    "python3 -c 'print(1)'",
    "curl -s https://example.com", // download without a write target
    "node --version 2>/dev/null", // a probe redirect is not a mutation
  ])("does not treat as a mutation: %s", (cmd) => {
    expect(isMutatingBashCommand(cmd)).toBe(false)
  })

  // Quote-aware segmentation: a mutating verb QUOTED inside another command is
  // an argument, not an action. These were the Fix 1/2/5/6 regressions.
  it.each([
    'python script.py "git add x"',
    'echo "now run git commit -m y"',
    "echo 'git commit -m y'",
  ])("does not fire on a quoted mutation verb: %s", (cmd) => {
    expect(isMutatingBashCommand(cmd)).toBe(false)
  })

  it("never throws on hostile input", () => {
    for (const cmd of ["", "   ", '"', "'", "$(", "`", "a".repeat(5000), ">>>", "|||", ";;;"]) {
      expect(() => isMutatingBashCommand(cmd)).not.toThrow()
    }
  })
})

describe("changedPathsFromTool", () => {
  it("maps an edit to its file path", () => {
    expect(changedPathsFromTool("edit", { filePath: "src/app.ts" })).toContain("src/app.ts")
  })

  it("maps a write to its file path", () => {
    expect(changedPathsFromTool("write", { filePath: "src/new.ts" })).toContain("src/new.ts")
  })

  it("maps a mutating bash command that names no file to the bash-mutation marker", () => {
    expect(changedPathsFromTool("bash", { command: "git commit -m wip" })).toContain("bash-mutation")
  })

  // THE BUG. `changedPathsFromTool('bash', …)` answered EVERY mutating command
  // with the pathless marker, which `NON_PATH_MUTATION_MARKERS` then strips —
  // so a session that wrote its files through bash presented an empty changed
  // -path list to git, to `resolveVerifier`, and to the verifier.
  it("attributes a bash write to the file the command names, not to the marker", () => {
    const paths = changedPathsFromTool("bash", { command: "touch a.js" }, { workspaceRoot: "/w" })
    expect(paths).toEqual(["/w/a.js"])
    expect(paths).not.toContain("bash-mutation")
  })

  it("returns nothing for a read-only bash command", () => {
    expect(changedPathsFromTool("bash", { command: "npm test" })).toEqual([])
  })

  it("returns nothing for a non-mutating tool", () => {
    expect(changedPathsFromTool("read", { filePath: "src/app.ts" })).toEqual([])
  })

  it("never throws on malformed args", () => {
    for (const args of [{}, { filePath: 42 }, { command: null }, { filePath: undefined }]) {
      expect(() => changedPathsFromTool("edit", args as Record<string, unknown>)).not.toThrow()
      expect(() => changedPathsFromTool("bash", args as Record<string, unknown>)).not.toThrow()
    }
  })
})

// ===========================================================================
// BASH PATH ATTRIBUTION
// ===========================================================================
//
// The defect that blinded the harness for a whole live session (ses_0254e14e,
// 29 min, a working web app on :8090): `changedPathsFromTool('bash', …)`
// returned `["bash-mutation"]` for every mutating command, even
// `cat > index.html <<EOF`. Downstream both `plugin.ts` and `diffstat.ts`
// filter markers out to get a usable list, so the list was ALWAYS empty —
// 0 non-empty `changedPaths` in the entire log, 40 x `resolution:none`,
// verdicts unsubstantiated for all five stories.
//
// Every case below dies if the parser is reverted to the marker.

const ROOT = "/w"
const attribute = (command: string): string[] => changedPathsFromBashCommand(command, { workspaceRoot: ROOT })

describe("changedPathsFromBashCommand — attribution", () => {
  it.each([
    ["touch a.js", ["/w/a.js"]],
    ["cat >> app.js", ["/w/app.js"]],
    ["echo x > src/a.js", ["/w/src/a.js"]],
    ["tee index.html", ["/w/index.html"]],
    ['printf "x" > a.txt', ["/w/a.txt"]],
    ["echo x | tee a.txt b.txt", ["/w/a.txt", "/w/b.txt"]],
    // Destination-only heads: `cp a b` changes `b`, not `a`.
    ["cp -n a.js b.js", ["/w/b.js"]],
    ["install -m 755 build/app bin/app", ["/w/bin/app"]],
    ["ln -s ../src/x.ts link.ts", ["/w/link.ts"]],
    // `mv` removes the source AND creates the destination — both changed.
    ["mv old.js new.js", ["/w/old.js", "/w/new.js"]],
    // `chmod`'s first operand is the MODE, not a path.
    ["chmod +x scripts/run.sh", ["/w/scripts/run.sh"]],
    ["chmod 755 scripts/run.sh", ["/w/scripts/run.sh"]],
    // `truncate -s` consumes its size argument.
    ["truncate -s 0 logs/app.log", ["/w/logs/app.log"]],
    // In-place editors: the script/expression is not a file.
    ["sed -i 's/a/b/' src/x.ts", ["/w/src/x.ts"]],
    ["sed -i.bak -e 's/a/b/' src/x.ts src/y.ts", ["/w/src/x.ts", "/w/src/y.ts"]],
    ["perl -pi -e 's/a/b/' src/x.ts", ["/w/src/x.ts"]],
    ["rm -rf dist", ["/w/dist"]],
    // sudo prefixes, in both the bare and the option-carrying form.
    ["sudo -u ci touch a.js", ["/w/a.js"]],
    ["sudo rm -rf build/out.js", ["/w/build/out.js"]],
  ])("attributes %s", (command, expected) => {
    expect(attribute(command)).toEqual(expected)
  })

  it("takes the heredoc's REDIRECT target and never mines its body", () => {
    // The body is the file's CONTENT. `<a href="x" >hi</a>` inside it looks
    // exactly like a redirect once the command is split on newlines, and every
    // such hit would be a fabricated changed path.
    const command = 'cat > index.html <<EOF\n<html><body><a href="x" >hi</a></body></html>\nEOF'
    expect(attribute(command)).toEqual(["/w/index.html"])
  })

  it("does not lose later segments when a `<<` is really just quoted text", () => {
    // No closing delimiter exists, so the `<<` is not a heredoc opener — the
    // rest of the command must still be parsed.
    expect(attribute('echo "a << b" > f.txt\ntouch c.js')).toEqual(["/w/f.txt", "/w/c.js"])
  })

  it("attributes each segment of a compound command separately", () => {
    expect(attribute("cd src; echo hi > b.js; cd ..; touch c.js")).toEqual(["/w/src/b.js", "/w/c.js"])
  })

  it("resolves paths relative to a `cd` prefix, including inside a subshell", () => {
    expect(attribute("cd src && touch a.js")).toEqual(["/w/src/a.js"])
    expect(attribute("(cd sub && touch d.js)")).toEqual(["/w/sub/d.js"])
  })

  it("keeps a quoted path with a space in one piece", () => {
    expect(attribute('echo hi > "my file.txt"')).toEqual(["/w/my file.txt"])
  })

  it("reads `apply_patch`'s targets out of the patch envelope", () => {
    const command = "apply_patch <<'EOF'\n*** Begin Patch\n*** Add File: src/new.ts\n+hello\n*** End Patch\nEOF"
    expect(attribute(command)).toEqual(["/w/src/new.ts"])
  })

  it("spells a bash write the same way an edit call spells it", () => {
    // Both must be absolute and under the worktree, or `resolveVerifier`,
    // `git diff --stat` and the scope watchdog see two different files.
    expect(attribute("touch src/app.ts")).toEqual(changedPathsFromTool("edit", { filePath: "/w/src/app.ts" }))
  })
})

describe("changedPathsFromBashCommand — the marker is the fallback, never the default", () => {
  it.each([
    "npm install",
    "git checkout -- .",
    "git commit -n -m wip",
    // A directory is not a file-level change any verifier resolves from.
    "mkdir -p src",
    // Inline interpreter writes name their file inside a string we do not run.
    "python3 <<PY\nopen('f.txt','w').write('x')\nPY",
    "node -e \"require('fs').writeFileSync('a.txt','x')\"",
    // A download names an output we deliberately do not attribute.
    "curl -o out.json https://example.com/x",
  ])("keeps the marker for %s, which mutates without naming a file", (command) => {
    expect(isMutatingBashCommand(command)).toBe(true)
    expect(attribute(command)).toEqual(["bash-mutation"])
  })

  it("reports BOTH the named path and the marker when only part of the command is attributable", () => {
    // "we know a.js changed AND something else changed we cannot name" is a
    // true statement; collapsing it either way loses information.
    expect(attribute("touch a.js && npm install")).toEqual(["/w/a.js", "bash-mutation"])
  })

  it("never regresses a known mutation into an empty list", () => {
    for (const command of ["npm install", "touch a.js", "git add -A", "echo x > $LOG", "rm -rf dist/*"]) {
      expect(attribute(command).length).toBeGreaterThan(0)
    }
  })
})

describe("changedPathsFromBashCommand — over-extraction filters", () => {
  it.each([
    // Device sinks and kernel pseudo-filesystems are not project changes.
    ["npm run build > /dev/null", "a /dev sink"],
    ["npm run build > /proc/self/fd/1", "a /proc path"],
    // fd duplication is not a file at all.
    ["npm run build 2>&1", "an fd duplication"],
    // An unexpanded expansion is not a path — attributing `$LOG` would put a
    // literal dollar sign in the ledger and in a git pathspec.
    ["npm run build > $LOG", "an unexpanded variable"],
    ["npm run build > ${LOG}", "a braced expansion"],
    ["npm run build > `date`.log", "a command substitution"],
    // An unexpanded glob names a set, not a file.
    ["rm -rf dist/*", "a glob"],
    // A file OUTSIDE the worktree is not a project change. This is the
    // workspace bound, not a `/tmp` blacklist — a workspace that legitimately
    // lives under a temp dir (every integration test here does) is unaffected.
    ["npm run build > /tmp/build.log", "an out-of-worktree log"],
    ["npm run build > ../sibling/out.txt", "a path climbing out of the worktree"],
  ])("does not attribute %s (%s)", (command) => {
    expect(attribute(command)).toEqual(["bash-mutation"])
  })

  it("does not treat a URL as a redirect target", () => {
    expect(attribute("curl -o out.json https://example.com/x")).not.toContain("https://example.com/x")
  })

  it("keeps the out-of-worktree filter OFF when no workspace root is known", () => {
    // Without a root there is nothing to be outside of, and guessing would
    // drop real paths. Relative spellings are preserved verbatim.
    expect(changedPathsFromBashCommand("touch a.js")).toEqual(["a.js"])
  })

  it("caps the attributed list and says so with the marker", () => {
    const many = Array.from({ length: 40 }, (_, i) => `f${i}.txt`).join(" ")
    const paths = attribute(`touch ${many}`)
    expect(paths.length).toBe(33) // 32 paths + the marker
    expect(paths.at(-1)).toBe("bash-mutation")
  })

  it("never throws on adversarial input", () => {
    for (const command of ["touch", ">", ">>", "<<", "cat <<", "cd", "sed -i", "tee", "'", '"', "\\", "cp"]) {
      expect(() => attribute(command)).not.toThrow()
    }
  })
})

describe("changedPathsFromTool — direct path argument keys", () => {
  // WHAT THE HOST DECLARES: read out of the shipped opencode binary (v1.18.x),
  // `edit` is `Struct({filePath, oldString, newString, replaceAll})` and
  // `write` is `Struct({filePath, content})` — `filePath` only, no `path`.
  // The widened list is for the OTHER callers of `tool.execute.after`: user
  // plugin tools and MCP servers, whose argument names are theirs to choose.
  it.each([
    ["filePath", "opencode's own declared key"],
    ["file_path", "Claude Code's spelling"],
    ["path", "the plain spelling a plugin tool may use"],
    ["notebookPath", "a notebook editor"],
    ["notebook_path", "a snake_case notebook editor"],
  ])("reads a direct path from %s (%s)", (key) => {
    expect(changedPathsFromTool("edit", { [key]: "/w/a.ts" })).toEqual(["/w/a.ts"])
    expect(changedPathsFromTool("write", { [key]: "/w/a.ts" })).toEqual(["/w/a.ts"])
  })

  it("prefers opencode's filePath when a tool sends more than one spelling", () => {
    expect(changedPathsFromTool("edit", { filePath: "/w/real.ts", path: "/w/other.ts" })).toEqual(["/w/real.ts"])
  })

  it("still falls back to the edit-mutation marker when no key carries a path", () => {
    expect(changedPathsFromTool("edit", { oldString: "a", newString: "b" })).toEqual(["edit-mutation"])
    expect(changedPathsFromTool("edit", { filePath: "   " })).toEqual(["edit-mutation"])
  })
})
