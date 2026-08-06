import { describe, expect, it, vi } from "vitest"
import type { EventLogger, OpencodeClient } from "../../src/v2/types.js"

describe("v2/types.ts smoke", () => {
  it("EventLogger types a vi.fn() logger and it is callable", () => {
    const logger: EventLogger = vi.fn()
    logger("some:event", { sessionID: "s1" })
    expect(logger).toHaveBeenCalledWith("some:event", { sessionID: "s1" })
  })

  it("OpencodeClient type-checks a minimal stub with the contract-cited methods", () => {
    const client: Pick<OpencodeClient, "session" | "tool" | "app"> = {
      session: { create: vi.fn(), prompt: vi.fn(), delete: vi.fn() } as unknown as OpencodeClient["session"],
      tool: { ids: vi.fn() } as unknown as OpencodeClient["tool"],
      app: { agents: vi.fn() } as unknown as OpencodeClient["app"],
    }
    expect(typeof client.session.create).toBe("function")
  })

  // BACKLOG B-1: the third case here asserted `Profile` was the
  // `standard`/`frontier` union. Its subject no longer exists — dosing
  // profiles are gone, so there is nothing left for a type smoke test to
  // pin. The removal is held by BEHAVIOURAL tests instead, which is where it
  // belongs: `plugin.integration.test.ts`'s "the model id does not change
  // what gets rendered" (no table) and "a configured verifierModel is inert"
  // (no override), and `measurement.test.ts`'s "no event carries a profile
  // field" (no profile stamp).
})
