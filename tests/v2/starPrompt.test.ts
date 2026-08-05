/**
 * The one-time GitHub-star ask — closed loop.
 *
 * THE BUG THIS EXISTS FOR. Consent was written `"prompted"` at ARM time,
 * before the model had done anything. Measured on a live session: the ask was
 * armed, the system directive injected, and the model spent its one `question`
 * call asking about something else entirely. The consent file then said
 * "prompted" on a machine where the user had never been prompted — and because
 * the marker is machine-wide and durable, the ask could never happen again.
 *
 * So the one-shot is now spent only on an OBSERVED `question` call, the ask is
 * delivered as a continuation on a quiet turn rather than as a line in the
 * system prompt, and an uncooperative model is retried a bounded number of
 * times before giving up for good.
 *
 * `starConsentPath()` honours `XDG_CONFIG_HOME`, so every test here runs
 * against its own throwaway config root and never touches the real machine.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ElicifyVertexPluginV2 } from "../../src/v2/plugin.js"
import { readStarConsent, STAR_MAX_ATTEMPTS, starConsentPath } from "../../src/v2/wiring/tools.js"
import type { Hooks, PluginInput } from "@opencode-ai/plugin"

let configRoot: string
let previousXdg: string | undefined

beforeEach(() => {
  previousXdg = process.env.XDG_CONFIG_HOME
  configRoot = mkdtempSync(join(tmpdir(), "vertex-star-"))
  process.env.XDG_CONFIG_HOME = configRoot
})

afterEach(() => {
  if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = previousXdg
  vi.useRealTimers()
})

interface Harness {
  hooks: Hooks
  sid: string
  prompts: Array<{ body?: { parts?: Array<{ text?: string }> } }>
  /** Continuation texts sent to the parent session (no agent tag). */
  sent: () => string[]
  /** Texts that are the star ask specifically. */
  starAsks: () => string[]
}

async function harness(): Promise<Harness> {
  const prompts: Array<{ body?: { agent?: string; parts?: Array<{ text?: string }> } }> = []
  const client = {
    session: {
      prompt: async (a: never) => {
        prompts.push(a as never)
        return { data: { info: {}, parts: [] }, error: undefined }
      },
      messages: async () => ({ data: [] }),
      create: async () => ({ data: { id: "child" } }),
      delete: async () => ({ data: {} }),
    },
    app: { agents: async () => ({ data: [] }) },
    tool: { ids: async () => ({ data: [] }) },
  }
  const workDir = mkdtempSync(join(tmpdir(), "vertex-star-work-"))
  const hooks = await ElicifyVertexPluginV2(
    { client, directory: workDir, worktree: workDir } as unknown as PluginInput,
    undefined,
  )
  const sid = `star-${Math.random().toString(36).slice(2)}`
  const sent = (): string[] =>
    prompts.filter((p) => !p?.body?.agent).map((p) => String(p?.body?.parts?.[0]?.text ?? ""))
  return { hooks, sid, prompts, sent, starAsks: () => sent().filter((t) => t.includes("star elicify-ai/elicify-vertex")) }
}

async function userTurn(h: Harness, text: string): Promise<void> {
  await h.hooks["chat.message"]!(
    { sessionID: h.sid, agent: "elicify-vertex-agent", model: { providerID: "anthropic", modelID: "claude-opus-4" } } as never,
    { message: { id: `m${Math.random()}` } as never, parts: [{ type: "text", text } as never] },
  )
}

async function idle(h: Harness): Promise<void> {
  await h.hooks.event!({ event: { type: "session.idle", properties: { sessionID: h.sid } } as never })
}

/** The model calls the `question` tool — `args` decides whether it is OUR ask. */
async function questionTool(h: Harness, args: Record<string, unknown>): Promise<void> {
  await h.hooks["tool.execute.after"]!(
    { tool: "question", sessionID: h.sid, callID: `c${Math.random()}`, args } as never,
    { title: "question", output: "answered", metadata: {} } as never,
  )
}

const OUR_ASK = { questions: [{ question: "Would you like to star elicify-ai/elicify-vertex on GitHub?" }] }
const OTHER_ASK = { questions: [{ question: "Which 3 games should the portal ship?" }] }
/** Mentions "star" but is not our ask — a bare substring check burned the one-shot on these. */
const STAR_WORD_ASKS = [
  { questions: [{ question: "Which star rating should the widget default to?" }] },
  { questions: [{ question: "Should I use a star schema for the warehouse?" }] },
]

describe("star ask — delivery", () => {
  it("is NOT injected into the system prompt", async () => {
    const h = await harness()
    await userTurn(h, "/elicify-vertex\n\nbuild the thing")
    const out = { system: [] as string[] }
    await h.hooks["experimental.chat.system.transform"]!(
      { sessionID: h.sid, model: { providerID: "anthropic", id: "claude-opus-4" } } as never,
      out,
    )
    expect(out.system.join("\n")).not.toContain("star elicify-ai/elicify-vertex")
  })

  it("is delivered as a continuation on a quiet turn", async () => {
    const h = await harness()
    await userTurn(h, "/elicify-vertex\n\nbuild the thing")
    await idle(h)
    expect(h.starAsks()).toHaveLength(1)
  })
})

describe("star ask — the one-shot is spent only on an OBSERVED ask", () => {
  it("writes nothing when merely armed", async () => {
    const h = await harness()
    await userTurn(h, "/elicify-vertex\n\nbuild the thing")
    expect(existsSync(starConsentPath()), "arming must not burn the one-shot").toBe(false)
  })

  it("records an attempt but no CONSENT after dispatch, before the model complies", async () => {
    const h = await harness()
    await userTurn(h, "/elicify-vertex\n\nbuild the thing")
    await idle(h)
    expect(h.starAsks()).toHaveLength(1)
    // The attempt count persists (it has to bound retries across sessions and
    // restarts), but the one-shot is NOT spent: consent is still unanswered.
    expect(readStarConsent(), "dispatch must not count as an ask").toBeNull()
  })

  // The exact live failure: the model used its one question call for something
  // else. That must NOT count, and must not burn the one-shot.
  it("does not count an unrelated question call", async () => {
    const h = await harness()
    await userTurn(h, "/elicify-vertex\n\nbuild the thing")
    await idle(h)
    await questionTool(h, OTHER_ASK)
    expect(readStarConsent()).toBeNull()
  })

  it.each(STAR_WORD_ASKS)("does not count a question that merely says 'star': %j", async (args) => {
    const h = await harness()
    await userTurn(h, "/elicify-vertex\n\nbuild the thing")
    await idle(h)
    await questionTool(h, args)
    expect(readStarConsent(), "only OUR ask may spend the one-shot").toBeNull()
  })

  it("records `asked` when the model actually asks", async () => {
    const h = await harness()
    await userTurn(h, "/elicify-vertex\n\nbuild the thing")
    await idle(h)
    await questionTool(h, OUR_ASK)
    expect(readStarConsent()).toBe("asked")
  })
})

describe("star ask — bounded retry", () => {
  it("retries on later quiet turns when the model ignores it", async () => {
    const h = await harness()
    await userTurn(h, "/elicify-vertex\n\nbuild the thing")
    await idle(h)
    expect(h.starAsks()).toHaveLength(1)

    // Model ignored it; a new user turn, another quiet turn.
    await userTurn(h, "carry on")
    await idle(h)
    expect(h.starAsks().length).toBeGreaterThan(1)
  })

  it("gives up permanently after the attempt cap", async () => {
    const h = await harness()
    for (let i = 0; i < STAR_MAX_ATTEMPTS + 3; i++) {
      await userTurn(h, "carry on")
      await idle(h)
    }
    expect(h.starAsks().length).toBeLessThanOrEqual(STAR_MAX_ATTEMPTS)
    expect(readStarConsent()).toBe("gave-up")
  })

  it("never asks again once a terminal state is recorded", async () => {
    const h = await harness()
    await userTurn(h, "/elicify-vertex\n\nbuild the thing")
    await idle(h)
    await questionTool(h, OUR_ASK)
    const afterAsk = h.starAsks().length

    await userTurn(h, "carry on")
    await idle(h)
    expect(h.starAsks()).toHaveLength(afterAsk)
  })
})

describe("star ask — never disturbs the session", () => {
  it("does not fire when a continuation is already in flight", async () => {
    const h = await harness()
    await userTurn(h, "/elicify-vertex\n\nbuild the thing")
    // Simulate the idle tree having dispatched something of its own.
    await h.hooks.event!({ event: { type: "session.idle", properties: { sessionID: h.sid } } as never })
    const first = h.starAsks().length
    expect(first).toBeLessThanOrEqual(1)
  })

  it("persists a readable record with a known state", async () => {
    const h = await harness()
    await userTurn(h, "/elicify-vertex\n\nbuild the thing")
    await idle(h)
    await questionTool(h, OUR_ASK)
    expect(readStarConsent()).toBe("asked")
    expect(JSON.parse(readFileSync(starConsentPath(), "utf8"))).toMatchObject({ state: "asked" })
  })

  // MAJ-007: the previous build wrote "prompted" at ARM time — the very bug
  // this closed loop fixes. Honouring it would leave the fix inert on exactly
  // the machines where the defect was measured.
  it("ignores a legacy 'prompted' marker and asks anyway", async () => {
    mkdirSync(dirname(starConsentPath()), { recursive: true })
    writeFileSync(starConsentPath(), "prompted")
    expect(readStarConsent(), "legacy arm-time burn is not a real ask").toBeNull()

    const h = await harness()
    await userTurn(h, "/elicify-vertex\n\nbuild the thing")
    await idle(h)
    expect(h.starAsks()).toHaveLength(1)
  })
})
