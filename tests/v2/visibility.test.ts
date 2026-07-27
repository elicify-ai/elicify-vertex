import { afterEach, describe, expect, it, vi } from "vitest"

import type { Finding } from "../../src/v2/composer.js"
import type { OpencodeClient } from "../../src/v2/types.js"
import {
  DEFAULT_MAX_TOASTS_PER_MINUTE,
  VISIBILITY_WINDOW_MS,
  VisibilityNotifier,
  resolveVisibilityMode,
  summarizeFinding,
  type VisibilityEventKind,
  type VisibilityMode,
} from "../../src/v2/visibility.js"

// ---------------------------------------------------------------------------
// Test helpers
//
// The toast stub mirrors the SDK's real resolved shape (`{ data, error }`,
// `responseStyle: "fields"`) so these tests are grounded against what a live
// host actually returns from `client.tui.showToast` — verified in the field to
// resolve `{data: true}` even with no TUI attached.
//
// Time is injected everywhere (`makeClock`): the FR-063 cap window is the only
// time-dependent behaviour in the module, and it is exercised by advancing a
// number, never by a real timer or a sleep.
// ---------------------------------------------------------------------------

interface ToastBody {
  title?: string
  message: string
  variant: string
  duration?: number
}

type ShowToast = (options: { body: ToastBody }) => unknown

const okToast: ShowToast = async () => ({ data: true })

function makeClient(impl: ShowToast = okToast) {
  const showToast = vi.fn(impl)
  const client = { tui: { showToast } } as unknown as OpencodeClient
  return { client, showToast }
}

type ToastSpy = ReturnType<typeof makeClient>["showToast"]

function bodies(spy: ToastSpy): ToastBody[] {
  return spy.mock.calls.map(([options]) => options.body)
}

function messages(spy: ToastSpy): string[] {
  return bodies(spy).map((body) => body.message)
}

function makeClock(start = 1_700_000_000_000) {
  let t = start
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms
    },
  }
}

function loggedEvents(logger: ReturnType<typeof vi.fn>): string[] {
  return logger.mock.calls.map((call) => String(call[0]))
}

const MODES: VisibilityMode[] = ["off", "gates", "all"]
const KINDS: VisibilityEventKind[] = ["directive", "gate", "health"]

/** FR-060's truth table, restated independently of the implementation. */
const EXPECTED_TOASTS: Record<VisibilityMode, Record<VisibilityEventKind, number>> = {
  off: { directive: 0, gate: 0, health: 0 },
  gates: { directive: 0, gate: 1, health: 1 },
  all: { directive: 1, gate: 1, health: 1 },
}

afterEach(() => {
  vi.unstubAllEnvs()
})

// ===========================================================================
// resolveVisibilityMode — FR-057
// ===========================================================================

describe("resolveVisibilityMode (FR-057)", () => {
  it("defaults to \"all\" when neither option nor env says otherwise", () => {
    expect(resolveVisibilityMode(undefined, {})).toBe("all")
    expect(resolveVisibilityMode("", {})).toBe("all")
  })

  it("honours an explicit, valid option value", () => {
    expect(resolveVisibilityMode("off", {})).toBe("off")
    expect(resolveVisibilityMode("gates", {})).toBe("gates")
    expect(resolveVisibilityMode("all", {})).toBe("all")
  })

  it("tolerates casing and surrounding whitespace in the option", () => {
    expect(resolveVisibilityMode("  GATES  ", {})).toBe("gates")
    expect(resolveVisibilityMode("Off", {})).toBe("off")
  })

  it("falls back to \"all\" on an invalid option instead of throwing", () => {
    expect(resolveVisibilityMode("loud", {})).toBe("all")
    expect(resolveVisibilityMode("true", {})).toBe("all")
    expect(resolveVisibilityMode("0", {})).toBe("all")
  })

  it("lets VERTEX_VISIBLE=0 win over every option value", () => {
    expect(resolveVisibilityMode("all", { VERTEX_VISIBLE: "0" })).toBe("off")
    expect(resolveVisibilityMode("gates", { VERTEX_VISIBLE: "0" })).toBe("off")
    expect(resolveVisibilityMode(undefined, { VERTEX_VISIBLE: "0" })).toBe("off")
    expect(resolveVisibilityMode("nonsense", { VERTEX_VISIBLE: " 0 " })).toBe("off")
  })

  it("ignores any VERTEX_VISIBLE value other than the documented 0 kill switch", () => {
    expect(resolveVisibilityMode("gates", { VERTEX_VISIBLE: "1" })).toBe("gates")
    expect(resolveVisibilityMode("gates", { VERTEX_VISIBLE: "all" })).toBe("gates")
    expect(resolveVisibilityMode(undefined, { VERTEX_VISIBLE: "" })).toBe("all")
  })

  it("reads process.env when no env is supplied", () => {
    vi.stubEnv("VERTEX_VISIBLE", "0")
    expect(resolveVisibilityMode("all")).toBe("off")
    vi.stubEnv("VERTEX_VISIBLE", "1")
    expect(resolveVisibilityMode("gates")).toBe("gates")
  })
})

// ===========================================================================
// visibility_mode_governs_toasts — FR-057 / FR-060 / FR-061
// Traces to: BDD "Visibility mode governs which events toast"
// ===========================================================================

describe("visibility_mode_governs_toasts (FR-060)", () => {
  for (const mode of MODES) {
    for (const kind of KINDS) {
      const expected = EXPECTED_TOASTS[mode][kind]
      it(`mode=${mode} kind=${kind} => ${expected} toast(s)`, async () => {
        const { client, showToast } = makeClient()
        const notifier = new VisibilityNotifier({
          client,
          mode,
          logger: vi.fn(),
          now: makeClock().now,
        })

        await notifier.notify(kind, { family: "verify-gap", message: "npx vitest run", instanceId: "i-1" })

        expect(showToast).toHaveBeenCalledTimes(expected)
      })
    }
  }

  it("never reads the clock in \"off\" mode (a disabled notifier is inert)", async () => {
    const now = vi.fn(() => 1)
    const { client, showToast } = makeClient()
    const notifier = new VisibilityNotifier({ client, mode: "off", logger: vi.fn(), now })

    await notifier.notify("health", { family: "judge", message: "judge:unavailable" })

    expect(showToast).not.toHaveBeenCalled()
    expect(now).not.toHaveBeenCalled()
  })

  it("setMode switches the live mode (FR-064 toggle support)", async () => {
    const { client, showToast } = makeClient()
    const notifier = new VisibilityNotifier({ client, mode: "off", logger: vi.fn(), now: makeClock().now })

    await notifier.notify("directive", { family: "verify-gap", message: "npx vitest run" })
    expect(showToast).not.toHaveBeenCalled()
    expect(notifier.mode).toBe("off")

    notifier.setMode("all")
    await notifier.notify("directive", { family: "verify-gap", message: "npx vitest run" })

    expect(notifier.mode).toBe("all")
    expect(showToast).toHaveBeenCalledTimes(1)
  })
})

// ===========================================================================
// rendered_directive_emits_one_toast — FR-058 / FR-059
// Traces to: BDD "A rendered directive emits one toast and an unchanged injection"
// ===========================================================================

describe("rendered_directive_emits_one_toast (FR-059)", () => {
  it("emits exactly one toast naming the family and the prescribed command", async () => {
    const { client, showToast } = makeClient()
    const notifier = new VisibilityNotifier({ client, mode: "all", logger: vi.fn(), now: makeClock().now })

    await notifier.notify("directive", {
      family: "verify-gap",
      message: "npx vitest run tests/lexer.test.ts",
      instanceId: "d-1",
    })

    expect(showToast).toHaveBeenCalledTimes(1)
    const [body] = bodies(showToast)
    expect(body.message).toContain("verify-gap")
    expect(body.message).toContain("npx vitest run tests/lexer.test.ts")
    expect(body.title).toBe("[vertex] directive")
    expect(body.variant).toBe("info")
  })

  it("defaults health and gate events to a warning variant (FR-061)", async () => {
    const { client, showToast } = makeClient()
    const notifier = new VisibilityNotifier({ client, mode: "all", logger: vi.fn(), now: makeClock().now })

    await notifier.notify("health", { family: "judge", message: "judge:unavailable", instanceId: "h-1" })
    await notifier.notify("gate", { family: "plan-gate", message: "plan_create blocked", instanceId: "g-1" })

    expect(bodies(showToast).map((b) => b.variant)).toEqual(["warning", "warning"])
    expect(bodies(showToast).map((b) => b.title)).toEqual(["[vertex] health", "[vertex] gate"])
  })

  it("lets the caller override variant and title, and omits the family prefix when absent", async () => {
    const { client, showToast } = makeClient()
    const notifier = new VisibilityNotifier({ client, mode: "all", logger: vi.fn(), now: makeClock().now })

    await notifier.notify("health", {
      message: "evidence collection dead for 94m",
      variant: "error",
      title: "[vertex] alarm",
    })

    const [body] = bodies(showToast)
    expect(body.message).toBe("evidence collection dead for 94m")
    expect(body.variant).toBe("error")
    expect(body.title).toBe("[vertex] alarm")
  })

  it("summarizeFinding carries family, prescription and instanceId (FR-059)", async () => {
    const finding: Finding = {
      family: "verify-gap",
      priority: "correction",
      observation: "src/lexer.ts changed; last verifier classified types-only",
      diagnosis: "type-check alone does not exercise runtime behavior",
      prescription: "npx vitest run tests/lexer.test.ts",
      instanceId: "d-42",
    }

    expect(summarizeFinding(finding)).toEqual({
      family: "verify-gap",
      message: "npx vitest run tests/lexer.test.ts",
      instanceId: "d-42",
    })

    const { client, showToast } = makeClient()
    const notifier = new VisibilityNotifier({ client, mode: "all", logger: vi.fn(), now: makeClock().now })
    await notifier.notify("directive", summarizeFinding(finding))
    expect(messages(showToast)[0]).toBe("verify-gap: npx vitest run tests/lexer.test.ts")
  })

  it("redacts secrets and truncates over-long toast text", async () => {
    const { client, showToast } = makeClient()
    const notifier = new VisibilityNotifier({ client, mode: "all", logger: vi.fn(), now: makeClock().now })

    await notifier.notify("directive", {
      family: "verify-gap",
      message: `run with api_key="hunter2super-secret" ${"x".repeat(400)}`,
    })

    const [body] = bodies(showToast)
    expect(body.message).not.toContain("hunter2super-secret")
    expect(body.message).toContain("[REDACTED]")
    expect(body.message.length).toBeLessThanOrEqual(240)
  })
})

// ===========================================================================
// toast_failure_is_swallowed — FR-062
// Traces to: BDD "A failing toast never affects harness behaviour"
// ===========================================================================

describe("toast_failure_is_swallowed (FR-062)", () => {
  it("swallows a rejecting showToast and logs it", async () => {
    const logger = vi.fn()
    const { client, showToast } = makeClient(async () => {
      throw new Error("connection refused")
    })
    const notifier = new VisibilityNotifier({ client, mode: "all", logger, now: makeClock().now })

    await expect(notifier.notify("directive", { family: "verify-gap", message: "npx vitest run" })).resolves.toBeUndefined()

    expect(showToast).toHaveBeenCalledTimes(1)
    const failure = logger.mock.calls.find((call) => call[0] === "visibility:toast-failed")
    expect(failure).toBeDefined()
    expect(failure?.[1]).toMatchObject({ kind: "directive", reason: "connection refused" })
  })

  it("swallows a synchronously throwing showToast", async () => {
    const logger = vi.fn()
    const { client } = makeClient(() => {
      throw new Error("no tui attached")
    })
    const notifier = new VisibilityNotifier({ client, mode: "all", logger, now: makeClock().now })

    await expect(notifier.notify("gate", { message: "blocked" })).resolves.toBeUndefined()
    expect(loggedEvents(logger)).toContain("visibility:toast-failed")
  })

  it("treats a fields-style {error} result as a failure without throwing", async () => {
    const logger = vi.fn()
    const { client } = makeClient(async () => ({ data: undefined, error: { message: "bad request" } }))
    const notifier = new VisibilityNotifier({ client, mode: "all", logger, now: makeClock().now })

    await expect(notifier.notify("health", { message: "judge:unavailable" })).resolves.toBeUndefined()

    const failure = logger.mock.calls.find((call) => call[0] === "visibility:toast-failed")
    expect(failure).toBeDefined()
    expect(String((failure?.[1] as { reason?: unknown })?.reason)).toContain("bad request")
  })

  it("handles a client with no tui property at all, logging unavailability once", async () => {
    const logger = vi.fn()
    const notifier = new VisibilityNotifier({
      client: {} as unknown as OpencodeClient,
      mode: "all",
      logger,
      now: makeClock().now,
    })

    await expect(notifier.notify("directive", { family: "verify-gap", message: "npx vitest run" })).resolves.toBeUndefined()
    await expect(notifier.notify("gate", { family: "plan-gate", message: "blocked" })).resolves.toBeUndefined()

    expect(loggedEvents(logger).filter((event) => event === "visibility:unavailable")).toHaveLength(1)
  })

  it("handles a client with a tui object but no showToast function", async () => {
    const logger = vi.fn()
    const notifier = new VisibilityNotifier({
      client: { tui: {} } as unknown as OpencodeClient,
      mode: "all",
      logger,
      now: makeClock().now,
    })

    await expect(notifier.notify("health", { message: "receipt not minted" })).resolves.toBeUndefined()
    expect(loggedEvents(logger)).toContain("visibility:unavailable")
  })

  it("handles no client at all", async () => {
    const notifier = new VisibilityNotifier({ mode: "all", logger: vi.fn(), now: makeClock().now })
    await expect(notifier.notify("health", { message: "verify:relevance-gap" })).resolves.toBeUndefined()
  })

  it("never propagates a throwing logger", async () => {
    const logger = vi.fn(() => {
      throw new Error("sink exploded")
    })
    const { client } = makeClient(async () => {
      throw new Error("connection refused")
    })
    const notifier = new VisibilityNotifier({ client, mode: "all", logger, now: makeClock().now })

    await expect(notifier.notify("directive", { family: "verify-gap", message: "npx vitest run" })).resolves.toBeUndefined()
  })
})

// ===========================================================================
// toasts_capped_and_deduped — FR-063
// Traces to: BDD "Toasts are capped and deduplicated"
// ===========================================================================

describe("toasts_capped_and_deduped — cap (FR-063)", () => {
  it("emits 6 toasts for 10 events in one window, then exactly one summary reporting 4 suppressed", async () => {
    const clock = makeClock()
    const logger = vi.fn()
    const { client, showToast } = makeClient()
    const notifier = new VisibilityNotifier({ client, mode: "all", logger, now: clock.now })

    for (let i = 0; i < 10; i += 1) {
      // Distinct instance ids so dedupe cannot be confused with the cap.
      await notifier.notify("directive", { family: "verify-gap", message: `run ${i}`, instanceId: `d-${i}` })
      clock.advance(100)
    }

    expect(showToast).toHaveBeenCalledTimes(DEFAULT_MAX_TOASTS_PER_MINUTE)
    expect(messages(showToast)).toEqual([
      "verify-gap: run 0",
      "verify-gap: run 1",
      "verify-gap: run 2",
      "verify-gap: run 3",
      "verify-gap: run 4",
      "verify-gap: run 5",
    ])
    expect(loggedEvents(logger).filter((e) => e === "visibility:cap-reached")).toHaveLength(1)

    // The roll-up is deferred so it can report the COMPLETE count: it lands at
    // window close (or on an explicit flush), never once per suppressed item.
    clock.advance(VISIBILITY_WINDOW_MS + 1)
    await notifier.flush()

    expect(showToast).toHaveBeenCalledTimes(DEFAULT_MAX_TOASTS_PER_MINUTE + 1)
    const summaries = bodies(showToast).filter((body) => body.title === "[vertex] visibility")
    expect(summaries).toHaveLength(1)
    expect(summaries[0]?.message).toContain("4")
    expect(summaries[0]?.message).toContain("suppressed")
    expect(logger).toHaveBeenCalledWith("visibility:suppressed-summary", { suppressed: 4, maxToastsPerMinute: 6 })
  })

  it("honours a custom maxToastsPerMinute", async () => {
    const clock = makeClock()
    const { client, showToast } = makeClient()
    const notifier = new VisibilityNotifier({
      client,
      mode: "all",
      logger: vi.fn(),
      maxToastsPerMinute: 2,
      now: clock.now,
    })

    for (let i = 0; i < 5; i += 1) {
      await notifier.notify("gate", { family: "plan-gate", message: `blocked ${i}`, instanceId: `g-${i}` })
    }

    expect(showToast).toHaveBeenCalledTimes(2)
    await notifier.flush()
    expect(messages(showToast)[2]).toContain("3 harness notifications suppressed (cap 2/min)")
  })

  it("still closes the window and reports the roll-up when the cap is 0 (nothing ever emitted)", async () => {
    const clock = makeClock()
    const { client, showToast } = makeClient()
    const notifier = new VisibilityNotifier({
      client,
      mode: "all",
      logger: vi.fn(),
      maxToastsPerMinute: 0,
      now: clock.now,
    })

    await notifier.notify("directive", { family: "f", message: "a", instanceId: "i-1" })
    await notifier.notify("directive", { family: "f", message: "b", instanceId: "i-2" })
    expect(showToast).not.toHaveBeenCalled()

    clock.advance(VISIBILITY_WINDOW_MS + 1)
    await notifier.notify("directive", { family: "f", message: "c", instanceId: "i-3" })

    expect(messages(showToast)).toEqual(["2 harness notifications suppressed (cap 0/min)"])
  })

  it("falls back to the default cap on a nonsensical maxToastsPerMinute", async () => {
    const clock = makeClock()
    const { client, showToast } = makeClient()
    const notifier = new VisibilityNotifier({
      client,
      mode: "all",
      logger: vi.fn(),
      maxToastsPerMinute: Number.NaN,
      now: clock.now,
    })

    for (let i = 0; i < 8; i += 1) {
      await notifier.notify("directive", { family: "f", message: `a${i}`, instanceId: `a-${i}` })
    }

    expect(showToast).toHaveBeenCalledTimes(DEFAULT_MAX_TOASTS_PER_MINUTE)
  })

  it("emits no summary when nothing was suppressed", async () => {
    const clock = makeClock()
    const { client, showToast } = makeClient()
    const notifier = new VisibilityNotifier({ client, mode: "all", logger: vi.fn(), now: clock.now })

    await notifier.notify("directive", { family: "verify-gap", message: "run", instanceId: "d-1" })
    clock.advance(VISIBILITY_WINDOW_MS + 1)
    await notifier.flush()
    await notifier.notify("directive", { family: "verify-gap", message: "run again", instanceId: "d-2" })

    expect(showToast).toHaveBeenCalledTimes(2)
    expect(bodies(showToast).some((body) => body.title === "[vertex] visibility")).toBe(false)
  })

  it("keeps suppressing for the remainder of the window, then resumes when the clock passes 60s", async () => {
    const clock = makeClock()
    const { client, showToast } = makeClient()
    const notifier = new VisibilityNotifier({ client, mode: "all", logger: vi.fn(), now: clock.now })

    for (let i = 0; i < 6; i += 1) {
      await notifier.notify("directive", { family: "verify-gap", message: `run ${i}`, instanceId: `d-${i}` })
    }
    expect(showToast).toHaveBeenCalledTimes(6)

    // Still inside the window: suppressed.
    clock.advance(VISIBILITY_WINDOW_MS - 1)
    await notifier.notify("directive", { family: "verify-gap", message: "late", instanceId: "d-late" })
    expect(showToast).toHaveBeenCalledTimes(6)

    // Window elapsed: the roll-up lands first, then toasting resumes.
    clock.advance(2)
    await notifier.notify("directive", { family: "verify-gap", message: "next window", instanceId: "d-next" })

    expect(showToast).toHaveBeenCalledTimes(8)
    const emitted = bodies(showToast)
    expect(emitted[6]?.title).toBe("[vertex] visibility")
    expect(emitted[6]?.message).toContain("1 harness notification suppressed")
    expect(emitted[7]?.message).toBe("verify-gap: next window")
  })

  it("gives the next window a full budget again", async () => {
    const clock = makeClock()
    const { client, showToast } = makeClient()
    const notifier = new VisibilityNotifier({ client, mode: "all", logger: vi.fn(), now: clock.now })

    for (let i = 0; i < 6; i += 1) {
      await notifier.notify("directive", { family: "f", message: `a${i}`, instanceId: `a-${i}` })
    }
    clock.advance(VISIBILITY_WINDOW_MS + 1)
    for (let i = 0; i < 6; i += 1) {
      await notifier.notify("directive", { family: "f", message: `b${i}`, instanceId: `b-${i}` })
    }

    // 6 + 6 real toasts, and no summary (nothing was ever suppressed).
    expect(showToast).toHaveBeenCalledTimes(12)
    expect(bodies(showToast).some((body) => body.title === "[vertex] visibility")).toBe(false)
  })
})

describe("toasts_capped_and_deduped — dedupe (FR-063)", () => {
  it("suppresses a repeat of the same family + instanceId", async () => {
    const logger = vi.fn()
    const { client, showToast } = makeClient()
    const notifier = new VisibilityNotifier({ client, mode: "all", logger, now: makeClock().now })

    await notifier.notify("directive", { family: "verify-gap", message: "npx vitest run", instanceId: "d-1" })
    await notifier.notify("directive", { family: "verify-gap", message: "npx vitest run", instanceId: "d-1" })

    expect(showToast).toHaveBeenCalledTimes(1)
    expect(loggedEvents(logger)).toContain("visibility:deduped")
  })

  it("does not confuse a different instanceId or a different family", async () => {
    const { client, showToast } = makeClient()
    const notifier = new VisibilityNotifier({ client, mode: "all", logger: vi.fn(), now: makeClock().now })

    await notifier.notify("directive", { family: "verify-gap", message: "a", instanceId: "d-1" })
    await notifier.notify("directive", { family: "verify-gap", message: "b", instanceId: "d-2" })
    await notifier.notify("directive", { family: "intake-scaffold", message: "c", instanceId: "d-1" })

    expect(showToast).toHaveBeenCalledTimes(3)
  })

  it("dedupes across kinds and across a window boundary (same identity, one toast)", async () => {
    const clock = makeClock()
    const { client, showToast } = makeClient()
    const notifier = new VisibilityNotifier({ client, mode: "all", logger: vi.fn(), now: clock.now })

    await notifier.notify("directive", { family: "verify-gap", message: "a", instanceId: "d-1" })
    clock.advance(VISIBILITY_WINDOW_MS + 1)
    await notifier.notify("health", { family: "verify-gap", message: "a", instanceId: "d-1" })

    expect(showToast).toHaveBeenCalledTimes(1)
  })

  it("never dedupes events that carry no instanceId", async () => {
    const { client, showToast } = makeClient()
    const notifier = new VisibilityNotifier({ client, mode: "all", logger: vi.fn(), now: makeClock().now })

    await notifier.notify("health", { family: "judge", message: "judge:unavailable" })
    await notifier.notify("health", { family: "judge", message: "judge:unavailable" })

    expect(showToast).toHaveBeenCalledTimes(2)
  })

  it("does not poison dedupe with events the cap suppressed", async () => {
    const clock = makeClock()
    const { client, showToast } = makeClient()
    const notifier = new VisibilityNotifier({
      client,
      mode: "all",
      logger: vi.fn(),
      maxToastsPerMinute: 1,
      now: clock.now,
    })

    await notifier.notify("directive", { family: "f", message: "first", instanceId: "i-1" })
    await notifier.notify("directive", { family: "f", message: "second", instanceId: "i-2" })
    expect(showToast).toHaveBeenCalledTimes(1)

    clock.advance(VISIBILITY_WINDOW_MS + 1)
    await notifier.notify("directive", { family: "f", message: "second", instanceId: "i-2" })

    // summary for the 1 suppressed event, then the retried event itself.
    expect(messages(showToast)).toEqual([
      "f: first",
      "1 harness notification suppressed (cap 1/min)",
      "f: second",
    ])
  })
})
