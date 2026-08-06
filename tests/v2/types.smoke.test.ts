import { describe, expect, it, vi } from "vitest"
import type { EventLogger, OpencodeClient } from "../../src/v2/types.js"

describe("v2/types.ts smoke", () => {
  it("EventLogger types a vi.fn() logger and it is callable", () => {
    const logger: EventLogger = vi.fn()
    // A REGISTERED name. This used to read `logger("some:event", …)`, which
    // is the whole reason the event registry was decorative: `EventLogger`
    // took `string`, so an unregistered name compiled everywhere — in the
    // harness as much as here. It takes `V2EventType` now.
    logger("directive_rendered", { sessionID: "s1" })
    expect(logger).toHaveBeenCalledWith("directive_rendered", { sessionID: "s1" })
  })

  it("rejects an event name absent from V2_EVENT_TYPES", () => {
    const logger: EventLogger = vi.fn()
    // @ts-expect-error — an unregistered event name must not compile. If this
    // line ever stops erroring, the registry is decorative again and the
    // `@ts-expect-error` itself turns the suite red.
    logger("some:event", { sessionID: "s1" })
    expect(logger).toHaveBeenCalled()
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
