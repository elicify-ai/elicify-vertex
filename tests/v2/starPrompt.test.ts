/**
 * The one-time GitHub-star ask — agent-driven, harness-recorded (B-6).
 *
 * THE BUG THIS EXISTS FOR, PART 1. Consent was written `"prompted"` at ARM
 * time, before the model had done anything. The consent file then said
 * "prompted" on a machine where the user had never been prompted — and because
 * the marker is machine-wide and durable, the ask could never happen again.
 *
 * PART 2. The fix for part 1 was a runtime loop: arm on a quiet turn, inject a
 * system directive, retry, and write `"gave-up"` after three failures. On
 * weaker models the ask was never made at all, so the loop only ever spent its
 * three injections and then permanently cancelled — via `gave-up` — an ask
 * nobody had made. Both `"prompted"` and `"gave-up"` record a MACHINE's
 * behaviour in a file that is supposed to record a USER's decision, so both
 * must read as NO RECORD AT ALL. Same reasoning, same branch.
 *
 * The loop is gone. The ask now lives in the agent prompt, gated by the
 * read-only `elicify_vertex_star_status` tool; the harness's only remaining
 * job is to OBSERVE a real `question` call about our repo and record `asked`.
 *
 * `starConsentPath()` honours `XDG_CONFIG_HOME`, so every test here runs
 * against its own throwaway config root and never touches the real machine.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ElicifyVertexPluginV2 } from "../../src/v2/plugin.js"
import { readStarConsent, starConsentPath } from "../../src/v2/wiring/tools.js"
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
  /** Continuation texts sent to the parent session (no agent tag). */
  sent: () => string[]
  /** Run a system.transform, as the host does at the start of the next turn. */
  transform: () => Promise<string>
  /** Call the read-only status tool and return its `consent` value. */
  status: () => Promise<string>
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

  const transform = async (): Promise<string> => {
    const out = { system: [] as string[] }
    await hooks["experimental.chat.system.transform"]!(
      { sessionID: sid, model: { providerID: "anthropic", id: "claude-opus-4" } } as never,
      out,
    )
    return out.system.join("\n")
  }
  const status = async (): Promise<string> => {
    const raw = await (
      hooks.tool as unknown as Record<string, { execute: (a: unknown, c: unknown) => Promise<string> }>
    ).elicify_vertex_star_status.execute({}, { sessionID: sid })
    return JSON.parse(raw).consent
  }
  return { hooks, sid, sent, transform, status }
}

async function userTurn(h: Harness, text: string): Promise<void> {
  await h.hooks["chat.message"]!(
    { sessionID: h.sid, agent: "elicify-vertex-agent", model: { providerID: "anthropic", modelID: "claude-opus-4" } } as never,
    { message: { id: `m${Math.random()}` } as never, parts: [{ type: "text", text } as never] },
  )
}

async function idle(h: Harness): Promise<void> {
  await h.hooks.event!({ event: { type: "session.idle", properties: { sessionID: h.sid } } as never })
  await h.transform()
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

function plant(contents: string): void {
  mkdirSync(dirname(starConsentPath()), { recursive: true })
  writeFileSync(starConsentPath(), contents)
}

describe("elicify_vertex_star_status — the read-only check the agent prompt calls", () => {
  it('reports "none" on a machine that was never asked', async () => {
    const h = await harness()
    expect(await h.status()).toBe("none")
  })

  it("stars NOTHING and records NOTHING — calling it must leave no trace", async () => {
    const h = await harness()
    expect(await h.status()).toBe("none")
    expect(await h.status()).toBe("none")
    expect(existsSync(starConsentPath()), "the status check must never write consent").toBe(false)
  })

  it.each(["asked", "yes", "declined"])('reports a real recorded decision: %s', async (state) => {
    plant(JSON.stringify({ state }))
    const h = await harness()
    expect(await h.status()).toBe(state)
  })

  // Deliberately NOT by calling `elicify_vertex_star` — that runs a real `gh`
  // subprocess against the live GitHub account of whoever runs the suite.
  it('stops reporting "none" once an ask has been observed', async () => {
    const h = await harness()
    await questionTool(h, OUR_ASK)
    expect(await h.status()).toBe("asked")
  })
})

// ---------------------------------------------------------------------------
// The two markers that are NOT user decisions. Both must read as no record.
// ---------------------------------------------------------------------------
describe("legacy markers are NO RECORD — the machines the defects were measured on", () => {
  // MAJ-007: the arm-time build wrote "prompted" before the model had done
  // anything. Honouring it leaves the fix inert on exactly those machines.
  it("ignores a legacy bare 'prompted' marker and asks anyway", async () => {
    plant("prompted")
    expect(readStarConsent(), "legacy arm-time burn is not a real ask").toBeNull()

    const h = await harness()
    expect(await h.status(), "an arm-time marker must not suppress the ask").toBe("none")
  })

  // B-6: the twin. `gave-up` recorded that a MODEL failed to follow an
  // instruction the user never saw — terminal, machine-wide, and produced by
  // nobody's decision. Same branch, same reasoning as "prompted".
  it("ignores a legacy bare 'gave-up' marker and asks anyway", async () => {
    plant("gave-up")
    expect(readStarConsent(), "a model's failure is not a user decision").toBeNull()

    const h = await harness()
    expect(await h.status(), "a gave-up marker must not suppress the ask").toBe("none")
  })

  // The JSON shape the retry loop actually wrote to disk, `attempts` and all.
  it("ignores a legacy JSON gave-up record, attempts field included", async () => {
    plant(JSON.stringify({ state: "gave-up", attempts: 4 }))
    expect(readStarConsent(), "a model's failure is not a user decision").toBeNull()

    const h = await harness()
    expect(await h.status(), "a gave-up record must not suppress the ask").toBe("none")
  })

  it("ignores a legacy JSON prompted record", async () => {
    plant(JSON.stringify({ state: "prompted", attempts: 2 }))
    expect(readStarConsent()).toBeNull()

    const h = await harness()
    expect(await h.status()).toBe("none")
  })

  // Guard the guard: the legacy branch must not swallow real decisions.
  it("still honours a real decision carrying a stale attempts field", async () => {
    plant(JSON.stringify({ state: "declined", attempts: 3 }))
    expect(readStarConsent()).toBe("declined")

    const h = await harness()
    expect(await h.status()).toBe("declined")
  })
})

describe("the one-shot is spent only on an OBSERVED ask", () => {
  it("writes nothing across an ordinary session", async () => {
    const h = await harness()
    await userTurn(h, "/elicify-vertex\n\nbuild the thing")
    await idle(h)
    expect(existsSync(starConsentPath()), "an ordinary session must not burn the one-shot").toBe(false)
  })

  // The exact live failure: the model used its one question call for something
  // else. That must NOT count, and must not burn the one-shot.
  it("does not count an unrelated question call", async () => {
    const h = await harness()
    await userTurn(h, "/elicify-vertex\n\nbuild the thing")
    await questionTool(h, OTHER_ASK)
    expect(readStarConsent()).toBeNull()
    expect(await h.status()).toBe("none")
  })

  it.each(STAR_WORD_ASKS)("does not count a question that merely says 'star': %j", async (args) => {
    const h = await harness()
    await userTurn(h, "/elicify-vertex\n\nbuild the thing")
    await questionTool(h, args)
    expect(readStarConsent(), "only OUR ask may spend the one-shot").toBeNull()
  })

  // WITHOUT the harness arming anything. There is no arm step any more, so the
  // observation must fire on the agent's own initiative or nothing ever writes
  // `asked` and the agent re-asks every single session.
  it("records `asked` on the agent's own question, with no arming step at all", async () => {
    const h = await harness()
    await questionTool(h, OUR_ASK)
    expect(readStarConsent()).toBe("asked")
    expect(await h.status()).toBe("asked")
  })

  it("persists a readable record with a known state and no attempts field", async () => {
    const h = await harness()
    await userTurn(h, "/elicify-vertex\n\nbuild the thing")
    await questionTool(h, OUR_ASK)
    const record = JSON.parse(readFileSync(starConsentPath(), "utf8"))
    expect(record).toEqual({ state: "asked" })
  })

  it("does not overwrite an existing decision when the question is asked again", async () => {
    plant(JSON.stringify({ state: "yes" }))
    const h = await harness()
    await questionTool(h, OUR_ASK)
    expect(readStarConsent()).toBe("yes")
  })
})

// ---------------------------------------------------------------------------
// B-6: the runtime nagging loop is GONE. These are the regression tests that
// keep it from growing back.
// ---------------------------------------------------------------------------
describe("no runtime nagging", () => {
  it("never injects a star directive into the system prompt", async () => {
    const h = await harness()
    await userTurn(h, "/elicify-vertex\n\nbuild the thing")
    expect(await h.transform()).not.toContain("elicify-ai/elicify-vertex")
    await idle(h)
    expect(await h.transform()).not.toContain("elicify-ai/elicify-vertex")
  })

  it("never injects a star directive however many quiet turns pass", async () => {
    const h = await harness()
    for (let i = 0; i < 6; i++) {
      await userTurn(h, "carry on")
      await idle(h)
      expect(await h.transform()).not.toContain("elicify-ai/elicify-vertex")
    }
  })

  it("is NEVER sent as a continuation", async () => {
    const h = await harness()
    await userTurn(h, "/elicify-vertex\n\nbuild the thing")
    await idle(h)
    expect(h.sent().filter((t) => t.includes("star elicify-ai"))).toHaveLength(0)
  })

  it("never writes a terminal state on its own — only no-file or an observed ask", async () => {
    const h = await harness()
    for (let i = 0; i < 6; i++) {
      await userTurn(h, "carry on")
      await idle(h)
    }
    expect(readStarConsent(), "nothing may give up on the user's behalf").toBeNull()
    expect(await h.status()).toBe("none")
  })
})
