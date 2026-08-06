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
import { changedPathsFromTool, isMutatingBashCommand } from "../src/index.js"

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

  it("maps a mutating bash command to the bash-mutation marker", () => {
    expect(changedPathsFromTool("bash", { command: "git commit -m wip" })).toContain("bash-mutation")
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
