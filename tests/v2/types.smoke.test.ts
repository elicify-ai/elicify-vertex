import { describe, expect, it, vi } from "vitest"
import type { EventLogger, OpencodeClient, Profile } from "../../src/v2/types.js"

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

  it("Profile is the standard/frontier union", () => {
    const p1: Profile = "standard"
    const p2: Profile = "frontier"
    expect([p1, p2]).toEqual(["standard", "frontier"])
  })
})
