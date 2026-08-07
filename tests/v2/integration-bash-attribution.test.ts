/**
 * END-TO-END REGRESSION FOR THE FILE-CHANGE ATTRIBUTION DEFECT.
 *
 * THE LIVE FAILURE THIS FILE REPRODUCES (session ses_0254e14e, 29 minutes, a
 * working web app served on :8090). `changedPathsFromTool` answered every
 * mutating bash command with the pathless marker `["bash-mutation"]`, even
 * when the command named its target in plain sight. Both consumers strip
 * markers before use (`NON_PATH_MUTATION_MARKERS`), so the list they saw was
 * always empty. Measured in that session's log:
 *
 *   - 0 non-empty `changedPaths` across ALL sessions
 *   - `hasChangedFiles` TRUE while the filtered list was EMPTY, so the
 *     verify-gap producer ran and then had nothing to reason about
 *   - 40 x `resolution:none {changedPaths: []}` — indistinguishable in the
 *     log from 40 turns that legitimately changed nothing
 *   - `verifier:field-dropped {verifierSummaries}`, plan lost 18 of 63 units
 *   - `verifier:verdict-not-enforced` x4 and `verifier:unverified` for all
 *     five stories; only S4 applied
 *
 * The tests below drive the SHIPPED hook path — the real
 * `ElicifyVertexPluginV2`, its real `tool.execute.after`, its real
 * `experimental.chat.system.transform`, its real `src/measurement.ts` event
 * writer — with bash writes, and assert that the attributed path reaches the
 * ledger AND reaches `resolveVerifier`. The strongest of them asserts on the
 * resolved COMMAND, which tier 2 derives from the changed path's basename: a
 * command naming `tests/lexer.test.ts` can only exist if `src/lexer.ts` made
 * it all the way through.
 *
 * The harness pattern (`makeStubClient`, `pluginInput`, `activate`,
 * `transform`, `toolAfter`, `readEvents`) mirrors
 * `tests/v2/integration-story-verify.test.ts`; see that file's header for why
 * these are copied rather than imported.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import type { Agent } from "@opencode-ai/sdk"

import { eventsPath } from "../../src/measurement.js"
import { ElicifyVertexPluginV2 } from "../../src/v2/plugin.js"

function denyAllAgent(name: string): Agent {
  return {
    name,
    mode: "subagent",
    builtIn: false,
    permission: { edit: "deny", bash: { "*": "deny" }, webfetch: "deny" },
    tools: { bash: false, edit: false, write: false, webfetch: false, read: false, "*": false },
    options: {},
  } as Agent
}

function makeStubClient() {
  const sessionCreate = vi.fn(async () => ({ data: { id: "subturn-child-1" }, error: undefined }))
  const sessionPrompt = vi.fn(async () => ({
    data: { info: {}, parts: [{ type: "text", text: '{"multiStory":false}' }] },
    error: undefined,
  }))
  const sessionDelete = vi.fn(async () => ({ data: {}, error: undefined }))
  const sessionMessages = vi.fn(async () => ({
    data: [{ info: { id: "user-msg-1", role: "user" } }],
    error: undefined,
  }))
  const appAgents = vi.fn(async () => ({
    data: [denyAllAgent("vertex-verifier"), denyAllAgent("vertex-intake")],
    error: undefined,
  }))
  const toolIds = vi.fn(async () => ({ data: ["bash", "edit", "write", "webfetch", "read"], error: undefined }))
  return {
    app: { agents: appAgents },
    tool: { ids: toolIds },
    session: { create: sessionCreate, prompt: sessionPrompt, delete: sessionDelete, messages: sessionMessages },
  }
}

let workDir: string
let vertexDataDir: string
let savedVertexData: string | undefined

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "vertex-v2-bashattr-work-"))
  vertexDataDir = mkdtempSync(join(tmpdir(), "vertex-v2-bashattr-events-"))
  savedVertexData = process.env.VERTEX_DATA
  process.env.VERTEX_DATA = vertexDataDir
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
  rmSync(vertexDataDir, { recursive: true, force: true })
  if (savedVertexData === undefined) delete process.env.VERTEX_DATA
  else process.env.VERTEX_DATA = savedVertexData
})

function pluginInput(client: unknown): PluginInput {
  return { client, directory: workDir, worktree: workDir } as unknown as PluginInput
}

const STANDARD_MODEL = { providerID: "minimax", id: "MiniMax-M3" }

async function activate(hooks: Hooks, sessionID: string, text: string) {
  await hooks["chat.message"]!(
    {
      sessionID,
      agent: "elicify-vertex-agent",
      model: { providerID: STANDARD_MODEL.providerID, modelID: STANDARD_MODEL.id },
    } as never,
    { message: {} as never, parts: [{ type: "text", text } as never] },
  )
}

async function transform(hooks: Hooks, sessionID: string): Promise<string> {
  const out = { system: [] as string[] }
  await hooks["experimental.chat.system.transform"]!(
    { sessionID, model: { providerID: STANDARD_MODEL.providerID, id: STANDARD_MODEL.id } } as never,
    out,
  )
  return out.system.join("\n")
}

async function toolAfter(
  hooks: Hooks,
  sessionID: string,
  tool: string,
  args: Record<string, unknown>,
  output = "",
  metadata: Record<string, unknown> = {},
) {
  await hooks["tool.execute.after"]!(
    { tool, sessionID, callID: `${tool}-${Math.random()}`, args } as never,
    { title: tool, output, metadata } as never,
  )
}

interface RawEvent {
  session_id: string
  event_type: string
  payload: Record<string, unknown>
}

function readEvents(sessionID: string): RawEvent[] {
  const p = eventsPath()
  if (!existsSync(p)) return []
  return readFileSync(p, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RawEvent)
    .filter((e) => e.session_id === sessionID)
}

const DEEP_ASK = "refactor the auth database migration end to end"

/** Tier-2 fixture: a test file whose basename matches the file the bash
 * command writes, so `resolveVerifier` can only name it if the path arrived. */
function writeTierTwoFixture() {
  writeFileSync(
    join(workDir, "package.json"),
    JSON.stringify({ name: "fixture", private: true, scripts: { test: "vitest run" } }, null, 2),
  )
  mkdirSync(join(workDir, "tests"), { recursive: true })
  writeFileSync(join(workDir, "tests", "lexer.test.ts"), "// fixture\n")
}

describe("the live failure: files written through bash", () => {
  it("a bash heredoc write reaches the ledger and resolveVerifier as a real path", async () => {
    writeTierTwoFixture()
    const hooks = await ElicifyVertexPluginV2(pluginInput(makeStubClient()), undefined)
    const sid = "bash-attribution-heredoc"

    await activate(hooks, sid, DEEP_ASK)
    // Exactly the shape the live session used to build its app.
    await toolAfter(hooks, sid, "bash", {
      command: `cat > ${join(workDir, "src", "lexer.ts")} <<'EOF'\nexport const lex = () => 1\nEOF`,
    })

    const text = await transform(hooks, sid)

    // Reached the LEDGER: the finding's observation echoes the recorded list.
    expect(text).toContain("src/lexer.ts")
    // Reached resolveVerifier: tier 2 derives this command from the changed
    // path's basename. It cannot be produced from an empty path list, and it
    // cannot be produced from "bash-mutation".
    expect(text).toContain("npx vitest run tests/lexer.test.ts")
    // The exact outcome the live session logged 40 times.
    expect(readEvents(sid).filter((e) => e.event_type === "resolution:none")).toEqual([])
  })

  it("a relative bash write is attributed against the worktree, like an edit call", async () => {
    writeTierTwoFixture()
    const hooks = await ElicifyVertexPluginV2(pluginInput(makeStubClient()), undefined)
    const sid = "bash-attribution-relative"

    await activate(hooks, sid, DEEP_ASK)
    await toolAfter(hooks, sid, "bash", { command: "mkdir -p src && touch src/lexer.ts" })

    const text = await transform(hooks, sid)
    expect(text).toContain("npx vitest run tests/lexer.test.ts")
    // ABSOLUTE and under the worktree — the same spelling `edit` produces.
    // This is what `plugin.ts` passing `state.workspaceRoot` into the parser
    // buys: without it the ledger holds a bare `src/lexer.ts` that git,
    // `resolveVerifier` and the scope watchdog each resolve against a
    // different notion of "here".
    expect(text).toContain(join(workDir, "src", "lexer.ts"))
  })

  it("a redirect to a file OUTSIDE the worktree is not recorded as a project change", async () => {
    writeTierTwoFixture()
    const hooks = await ElicifyVertexPluginV2(pluginInput(makeStubClient()), undefined)
    const sid = "bash-attribution-outside"

    await activate(hooks, sid, DEEP_ASK)
    await toolAfter(hooks, sid, "bash", {
      command: `touch src/lexer.ts && npm run build > ${join(tmpdir(), "vertex-outside-build.log")}`,
    })

    const text = await transform(hooks, sid)
    expect(text).toContain(join(workDir, "src", "lexer.ts"))
    expect(text).not.toContain("vertex-outside-build.log")
  })

  it("BEFORE/AFTER contrast: the same session used to produce resolution:none with an empty list", async () => {
    // The `edit` path always worked; the `bash` path never did. Running both
    // through the same plugin instance is what makes the regression legible:
    // if attribution is reverted, only the edit half still resolves.
    writeTierTwoFixture()
    const hooks = await ElicifyVertexPluginV2(pluginInput(makeStubClient()), undefined)

    const editSid = "attribution-via-edit"
    await activate(hooks, editSid, DEEP_ASK)
    await toolAfter(hooks, editSid, "edit", { filePath: join(workDir, "src", "lexer.ts") }, "updated")
    const editText = await transform(hooks, editSid)

    const bashSid = "attribution-via-bash"
    await activate(hooks, bashSid, DEEP_ASK)
    await toolAfter(hooks, bashSid, "bash", { command: "echo 'export const lex = () => 1' > src/lexer.ts" })
    const bashText = await transform(hooks, bashSid)

    expect(bashText).toContain("npx vitest run tests/lexer.test.ts")
    expect(editText).toContain("npx vitest run tests/lexer.test.ts")
    expect(readEvents(bashSid).filter((e) => e.event_type === "resolution:none")).toEqual([])
  })
})

describe("a genuinely unattributable mutation is reported as such, not as silence", () => {
  it("logs resolution:unattributed instead of resolution:none with an empty list", async () => {
    writeTierTwoFixture()
    const hooks = await ElicifyVertexPluginV2(pluginInput(makeStubClient()), undefined)
    const sid = "bash-attribution-unattributable"

    await activate(hooks, sid, DEEP_ASK)
    // `npm install` really does mutate and really does name no file.
    await toolAfter(hooks, sid, "bash", { command: "npm install" })
    await transform(hooks, sid)

    const events = readEvents(sid)
    const unattributed = events.filter((e) => e.event_type === "resolution:unattributed")
    expect(unattributed.length).toBeGreaterThan(0)
    expect(unattributed[0].payload.markers).toEqual(["bash-mutation"])
    // The old code logged this as `resolution:none {changedPaths: []}`, which
    // reads exactly like a turn that changed nothing.
    expect(events.filter((e) => e.event_type === "resolution:none")).toEqual([])
  })

  it("still records that SOMETHING changed — the marker is never dropped", async () => {
    writeTierTwoFixture()
    const hooks = await ElicifyVertexPluginV2(pluginInput(makeStubClient()), undefined)
    const sid = "bash-attribution-marker-kept"

    await activate(hooks, sid, DEEP_ASK)
    await toolAfter(hooks, sid, "bash", { command: "npm install" })
    await transform(hooks, sid)

    // A recorded mutation with no attributable path must still hold the phase
    // machine in `execute` — "we cannot name it" is not "it did not happen".
    const phases = readEvents(sid).filter((e) => e.event_type === "phase_transition")
    expect(phases.some((e) => e.payload.to === "execute")).toBe(true)
  })
})
