/**
 * The `idleDispatch` lifecycle — WIRING, not helpers.
 *
 * The first attempt at covering this asserted that `Map.delete` works:
 * it called `beginIdleTurn` and `forgetIdleTurn` directly and checked the
 * count went back down. Deleting the `forgetIdleTurn(endedSid)` call in
 * `plugin.ts` left it green, so it covered nothing — the same vacuous pattern
 * it was written to remove. These tests drive the plugin's own `event` hook,
 * so they die when the wiring dies.
 */
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { ElicifyVertexPluginV2 } from "../../src/v2/plugin.js"
import { idleTurnCount } from "../../src/v2/wiring/gate.js"
import type { Hooks, PluginInput } from "@opencode-ai/plugin"

async function plugin(): Promise<{ hooks: Hooks; sid: string }> {
  const client = {
    session: {
      prompt: async () => ({ data: { info: {}, parts: [] }, error: undefined }),
      messages: async () => ({ data: [] }),
      create: async () => ({ data: { id: "child" } }),
      delete: async () => ({ data: {} }),
    },
    app: { agents: async () => ({ data: [] }) },
    tool: { ids: async () => ({ data: [] }) },
  }
  const work = mkdtempSync(join(tmpdir(), "vertex-idle-"))
  const hooks = await ElicifyVertexPluginV2(
    { client, directory: work, worktree: work } as unknown as PluginInput,
    undefined,
  )
  return { hooks, sid: `idle-${Math.random().toString(36).slice(2)}` }
}

async function activate(h: { hooks: Hooks; sid: string }): Promise<void> {
  await h.hooks["chat.message"]!(
    {
      sessionID: h.sid,
      agent: "elicify-vertex-agent",
      model: { providerID: "anthropic", modelID: "claude-opus-4" },
    } as never,
    { message: { id: "m1" } as never, parts: [{ type: "text", text: "/elicify-vertex\n\nbuild it" } as never] },
  )
}

const fire = async (h: { hooks: Hooks; sid: string }, type: string): Promise<void> => {
  await h.hooks.event!({ event: { type, properties: { sessionID: h.sid } } as never })
}

describe("idleDispatch lifecycle (through the plugin's event hook)", () => {
  it.each(["session.deleted", "session.error"])("releases the entry on %s", async (endEvent) => {
    const h = await plugin()
    await activate(h)
    const before = idleTurnCount()
    await fire(h, "session.idle")
    expect(idleTurnCount(), "an idle turn must be tracked while it is live").toBe(before + 1)

    await fire(h, endEvent)
    expect(idleTurnCount(), `${endEvent} must release the entry, or the map grows forever`).toBe(before)
  })

  it("does not accumulate one entry per session seen", async () => {
    const before = idleTurnCount()
    for (let i = 0; i < 25; i++) {
      const h = await plugin()
      await activate(h)
      await fire(h, "session.idle")
      await fire(h, "session.deleted")
    }
    expect(idleTurnCount(), "25 completed sessions must leave nothing behind").toBe(before)
  })
})
