/**
 * `elicify_vertex_star` — the plugin's one irreversible, outward-facing action.
 *
 * IT HAD NO TESTS AT ALL. Measured before this file existed: deleting the
 * idempotency guard killed 0 of 1639 tests, and planting `{"state":"declined"}`
 * then calling the tool STARRED the repo and rewrote the marker to
 * `{"state":"yes"}` — an explicit user "no" overridden and then erased.
 *
 * Nothing here stars anything: `node:child_process` is mocked, so the real
 * `gh` never runs against whoever's GitHub account is authed on the machine
 * running the suite. The mock is also what lets these tests assert the things
 * that actually matter about the side effect — that it is NOT attempted when
 * consent forbids it, that it goes straight to the `gh` binary rather than
 * through a visible bash call, and that the caller's `GH_TOKEN` is stripped.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { PhaseEngine } from "../../src/v2/phase.js"
import { PinStore } from "../../src/v2/pin.js"
import { StoryEngine } from "../../src/v2/story.js"
import type { OpencodeClient } from "../../src/v2/types.js"
import { buildPlanTools, readStarConsent, starConsentPath, STAR_REPO } from "../../src/v2/wiring/tools.js"

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }))
const { execFileSync } = await import("node:child_process")
const gh = vi.mocked(execFileSync)

const SESSION = "star-tool"
const roots: string[] = []
let previousXdg: string | undefined

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "vertex-star-tool-"))
  roots.push(root)
  return root
}

function tools(): ReturnType<typeof buildPlanTools> {
  const root = temporaryRoot()
  const stateDir = join(root, ".opencode", "elicify-vertex")
  const logger = (): void => {}
  return buildPlanTools({
    storyEngine: new StoryEngine({ stateDir, logger }),
    pinStore: new PinStore({ stateDir, logger }),
    client: { session: { messages: async () => ({ data: [] }) } } as unknown as OpencodeClient,
    states: new Map(),
    phaseEngine: new PhaseEngine(logger),
    onPlanCreated: () => {},
    onScopeAmended: () => {},
  })
}

async function star(): Promise<Record<string, unknown>> {
  const raw = (await tools().elicify_vertex_star.execute({}, { sessionID: SESSION } as never)) as string
  return JSON.parse(raw) as Record<string, unknown>
}

function plant(contents: string): void {
  mkdirSync(dirname(starConsentPath()), { recursive: true })
  writeFileSync(starConsentPath(), contents)
}

function markerOnDisk(): string | null {
  return existsSync(starConsentPath()) ? readFileSync(starConsentPath(), "utf8") : null
}

beforeEach(() => {
  previousXdg = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "vertex-star-cfg-"))
  gh.mockReset()
  gh.mockReturnValue("" as never)
})

afterEach(() => {
  if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = previousXdg
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Consent decides whether the side effect is attempted at all.
// ---------------------------------------------------------------------------

describe("elicify_vertex_star refuses to override a recorded decision", () => {
  // MUTATION PROOF: delete the `prior === "declined"` branch in the star tool
  // -> `gh` is invoked and the marker is rewritten to "yes". Both assertions
  // below go RED.
  it('never stars when the user has DECLINED — and leaves the "no" on disk intact', async () => {
    plant(JSON.stringify({ state: "declined" }))

    const result = await star()

    expect(gh, "an explicit user no must not reach the network").not.toHaveBeenCalled()
    expect(result.starred).toBe(false)
    expect(result.refused).toBe("declined")
    expect(readStarConsent(), "the decision must survive the call").toBe("declined")
    expect(markerOnDisk()).toBe(JSON.stringify({ state: "declined" }))
  })

  // FIX 4's normalisation is load-bearing HERE, not just in the status tool: a
  // case-variant marker used to fall through every equality check and star.
  it("refuses a case-variant decline too", async () => {
    plant(JSON.stringify({ state: "DECLINED" }))

    const result = await star()

    expect(gh).not.toHaveBeenCalled()
    expect(result.refused).toBe("declined")
  })

  // MUTATION PROOF: delete `if (prior === "yes") return ...` (tools.ts's
  // idempotency guard) -> `gh` is called a second time. Previously deleting
  // that line killed 0 of 1639 tests.
  it("is idempotent: a second call stars nothing and reports already: true", async () => {
    plant(JSON.stringify({ state: "yes" }))

    const result = await star()

    expect(gh, "the repo is already starred — nothing to do").not.toHaveBeenCalled()
    expect(result).toEqual({ starred: true, already: true })
  })
})

// ---------------------------------------------------------------------------
// The allowed paths, and what the side effect actually is.
// ---------------------------------------------------------------------------

describe("elicify_vertex_star performs the star itself, hidden", () => {
  it("stars once from `asked` (the normal path: the ask fired, the user said yes)", async () => {
    plant(JSON.stringify({ state: "asked" }))

    const result = await star()

    expect(result).toEqual({ starred: true, already: false })
    expect(gh).toHaveBeenCalledTimes(1)
    const [command, args] = gh.mock.calls[0]
    expect(command, "never a bash tool call — the model must not see gh in the chat").toBe("gh")
    expect(args).toEqual(["api", "--method", "PUT", `/user/starred/${STAR_REPO}`])
    expect(readStarConsent()).toBe("yes")
  })

  // No file at all is still allowed: the observer's phrasing match can miss,
  // and a genuine yes must remain honourable when nothing was recorded.
  it("stars when nothing is recorded yet", async () => {
    const result = await star()

    expect(result).toEqual({ starred: true, already: false })
    expect(gh).toHaveBeenCalledTimes(1)
  })

  it("strips the ambient GH_TOKEN/GITHUB_TOKEN so the user's own gh auth is used", async () => {
    const previous = { gh: process.env.GH_TOKEN, github: process.env.GITHUB_TOKEN }
    process.env.GH_TOKEN = "ghp_ambient_ci_token"
    process.env.GITHUB_TOKEN = "ghp_ambient_actions_token"
    try {
      await star()
    } finally {
      if (previous.gh === undefined) delete process.env.GH_TOKEN
      else process.env.GH_TOKEN = previous.gh
      if (previous.github === undefined) delete process.env.GITHUB_TOKEN
      else process.env.GITHUB_TOKEN = previous.github
    }

    const options = gh.mock.calls[0][2] as { env: Record<string, string>; stdio: string }
    expect(options.env.GH_TOKEN).toBeUndefined()
    expect(options.env.GITHUB_TOKEN).toBeUndefined()
    expect(options.stdio, "no gh output may leak into the chat").toBe("ignore")
  })
})

// ---------------------------------------------------------------------------
// The failing side effect. `gh` missing, not authed, or offline.
// ---------------------------------------------------------------------------

describe("elicify_vertex_star when the gh call fails", () => {
  it("reports starred: false instead of throwing into the host", async () => {
    gh.mockImplementation(() => {
      throw new Error("gh: command not found")
    })

    const result = await star()

    expect(result).toEqual({ starred: false, already: false })
  })

  // Documented behaviour, asserted so it is a decision rather than an accident:
  // consent is recorded even though the star did not land, so a transient
  // network failure cannot turn into the user being asked again forever. The
  // cost is a star we never get; the alternative is the nagging loop B-6
  // deleted.
  it("still records consent, so a transient failure cannot re-open the ask", async () => {
    gh.mockImplementation(() => {
      throw new Error("HTTP 401: Bad credentials")
    })

    await star()

    expect(readStarConsent()).toBe("yes")
  })

  it("does not retry the failed call within the same invocation", async () => {
    gh.mockImplementation(() => {
      throw new Error("offline")
    })

    await star()

    expect(gh).toHaveBeenCalledTimes(1)
  })
})
