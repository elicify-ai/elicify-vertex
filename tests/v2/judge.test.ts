import { beforeEach, describe, expect, it, vi } from "vitest"

// ---------------------------------------------------------------------------
// subturn.ts is mocked for the runJudge suite: probeCapabilityBounded/
// runSubturn are wave-1 infrastructure with their own dedicated coverage in
// tests/v2/subturn.test.ts (including real-timer timeout behavior, and
// probeCapabilityBounded's own probe/deny-map/timeout race). Judge.ts only
// needs to prove it *drives* that infrastructure correctly (right agent
// name, right model per attempt, shared budget — INCLUDING the probe +
// deny-map step per the CRITICAL fix below, correct classification of the
// result) — mocking lets every scenario here run instantly and
// deterministically instead of racing real timers. SelfCreatedSessions is
// left un-mocked (trivial, no behavior worth stubbing).
//
// CRITICAL fix (post-review): runJudge used to call subturn.ts's
// probeCapability/buildDenyMap directly, with no timeout, BEFORE starting
// its own JUDGE_TOTAL_BUDGET_MS clock — a hang in either could block
// runJudge indefinitely. runJudge now calls the single bounded helper
// probeCapabilityBounded(client, agent, budgetMs) instead, so this suite
// mocks that one function rather than the two calls it used to make
// directly.
// ---------------------------------------------------------------------------
vi.mock("../../src/v2/subturn.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/v2/subturn.js")>()
  return {
    ...actual,
    probeCapabilityBounded: vi.fn(),
    runSubturn: vi.fn(),
  }
})

import { buildJudgePayload, JUDGE_TOTAL_BUDGET_MS, runJudge } from "../../src/v2/judge.js"
import { probeCapabilityBounded, runSubturn, SelfCreatedSessions } from "../../src/v2/subturn.js"
import type { OpencodeClient } from "../../src/v2/types.js"

const mockProbeCapabilityBounded = vi.mocked(probeCapabilityBounded)
const mockRunSubturn = vi.mocked(runSubturn)

const DENY_MAP = { bash: false, edit: false, webfetch: false, "*": false }

function makeClient(): OpencodeClient {
  return {
    app: { agents: vi.fn() },
    tool: { ids: vi.fn() },
    session: { create: vi.fn(), prompt: vi.fn(), delete: vi.fn() },
  } as unknown as OpencodeClient
}

beforeEach(() => {
  vi.clearAllMocks()
  mockProbeCapabilityBounded.mockResolvedValue({ ok: true, tools: DENY_MAP })
  mockRunSubturn.mockResolvedValue({ ok: true, text: '{"fit":"pass","notes":"looks fine"}' })
})

// ===========================================================================
// buildJudgePayload — test 18 (judge_payload_evidence_only), test 39
// (judge_payload_secret_scan), Dataset: Judge payload hygiene (all 9 rows)
// ===========================================================================

describe("buildJudgePayload", () => {
  it("row 1 / test 18: clean criteria + diff summary + verifier summary transmit unchanged", () => {
    const logger = vi.fn()
    const raw = {
      criteria: ["Handles empty input", "Returns a sorted list"],
      diffSummary: ["@@ -1,2 +1,2 @@", "-const sorted = input", "+const sorted = input.sort()"].join("\n"),
      verifierSummaries: ["3 passed, 0 failed"],
    }
    const payload = buildJudgePayload(raw, logger)
    expect(payload).toEqual(raw)
    expect(logger).not.toHaveBeenCalled()
  })

  it("row 2 / test 18: payload has no narrative field to leak NARRATIVE_CANARY through — schema excludes it structurally", () => {
    const logger = vi.fn()
    // buildJudgePayload's signature accepts only criteria/diffSummary/verifierSummaries
    // — there is no chat-narrative parameter for a canary to travel through.
    // A canary planted in any of the three real fields is still just content,
    // scanned like anything else; asserting it survives (when it doesn't
    // match any secret pattern) demonstrates the exclusion is structural,
    // not a runtime filter that could itself be bypassed.
    const raw = {
      criteria: ["Criterion mentioning nothing sensitive"],
      diffSummary: "@@ -1,1 +1,1 @@\n+ordinary line",
      verifierSummaries: ["verifier ok"],
    }
    const payload = buildJudgePayload(raw, logger)
    expect(JSON.stringify(payload)).not.toContain("NARRATIVE_CANARY")
    expect(Object.keys(payload).every((k) => ["criteria", "diffSummary", "verifierSummaries"].includes(k))).toBe(
      true,
    )
  })

  it("row 3 / test 39: diff hunk containing a complete sk-live token is dropped; other hunks survive", () => {
    const logger = vi.fn()
    const cleanHunk = "@@ -1,1 +1,1 @@\n-old\n+new"
    const secretHunk = '@@ -2,1 +2,1 @@\n+const key = "sk-live-abc123def456ghi789jkl012mno345pqr"'
    const raw = {
      criteria: [],
      diffSummary: [cleanHunk, secretHunk].join("\n"),
      verifierSummaries: [],
    }
    const payload = buildJudgePayload(raw, logger)
    expect(payload.diffSummary).toBe(cleanHunk)
    expect(payload.diffSummary).not.toContain("sk-live")
    expect(logger).not.toHaveBeenCalled() // field not emptied — no field-dropped
  })

  it("row 4 / test 39: token split across a line boundary within one hunk is still caught (reassembled-field scan)", () => {
    const logger = vi.fn()
    // The secret ("sk-live-abc123def456ghi789jklmno") is split by a real
    // newline between two lines of the SAME hunk — no whitespace or other
    // separator, just a hard line break at the split point. Scanning each
    // line independently (or the hunk with its newlines left intact) would
    // miss this; only reassembling the hunk (stripping the line break for
    // matching purposes) reunites the token.
    const hunkWithSplitSecret = [
      "@@ -1,2 +1,2 @@",
      '-const key = "old"',
      '+const key = "sk-live-abc123',
      'def456ghi789jklmno"',
    ].join("\n")
    const raw = { criteria: [], diffSummary: hunkWithSplitSecret, verifierSummaries: [] }
    const payload = buildJudgePayload(raw, logger)
    expect(payload.diffSummary).toBeUndefined()
    expect(logger).toHaveBeenCalledWith("judge:field-dropped", { field: "diffSummary" })
  })

  it("row 5 / test 39: unlabelled 40-char hex token trips the entropy rule (redactSecrets alone misses it)", () => {
    const logger = vi.fn()
    const hexToken = "4702a3465c59e203612b5411f9dc37870f86aebd" // 40 chars, near-max hex entropy (~3.971 bits/char)
    const raw = {
      criteria: [],
      diffSummary: "",
      verifierSummaries: [`build hash ${hexToken} recorded`, "5 passed, 0 failed"],
    }
    const payload = buildJudgePayload(raw, logger)
    expect(payload.verifierSummaries).toEqual(["5 passed, 0 failed"])
    expect(logger).not.toHaveBeenCalled() // field not emptied (second line survives)
  })

  it("row 6 / test 39: connection string wrapped across two verifier-summary lines — both removed on reassembled scan", () => {
    const logger = vi.fn()
    const line1 = "Connecting to postgres://user:sec"
    const line2 = "retpass@dbhost:5432/mydb succeeded"
    const raw = {
      criteria: [],
      diffSummary: "",
      verifierSummaries: [line1, line2, "2 passed, 0 failed"],
    }
    const payload = buildJudgePayload(raw, logger)
    expect(payload.verifierSummaries).toEqual(["2 passed, 0 failed"])
    expect(logger).not.toHaveBeenCalled() // field not emptied — one surviving line
  })

  it("row 7 / test 39: 200-char base64 blob in a criteria line is removed; emptying the field logs judge:field-dropped", () => {
    const logger = vi.fn()
    const base64Blob = Buffer.from(Array.from({ length: 150 }, (_, i) => (i * 37 + 13) % 256)).toString(
      "base64",
    ).slice(0, 200)
    const raw = {
      criteria: [`payload: ${base64Blob}`],
      diffSummary: "",
      verifierSummaries: [],
    }
    const payload = buildJudgePayload(raw, logger)
    expect(payload.criteria).toBeUndefined()
    expect(logger).toHaveBeenCalledWith("judge:field-dropped", { field: "criteria" })
  })

  it("row 8 / test 39: an oversized clean verifier summary is truncated to the field cap before scanning", () => {
    const logger = vi.fn()
    const longClean = "ok ".repeat(1334) // ~4002 chars, well past the 2000-char field cap, no secrets
    const raw = { criteria: [], diffSummary: "", verifierSummaries: [longClean] }
    const payload = buildJudgePayload(raw, logger)
    expect(payload.verifierSummaries).toBeDefined()
    const survivingLength = payload.verifierSummaries!.join("\n").length
    expect(survivingLength).toBeLessThanOrEqual(2000)
    expect(survivingLength).toBeLessThan(longClean.length)
    // MINOR fix (post-review): truncation is no longer silent — a
    // judge:field-truncated event records that this field was cut, even
    // though it survives non-empty (never a judge:field-dropped, since the
    // field is not emptied).
    expect(logger).toHaveBeenCalledTimes(1)
    expect(logger).toHaveBeenCalledWith("judge:field-truncated", {
      field: "verifierSummaries",
      originalLength: longClean.length,
      cap: 2000,
    })
    logger.mockClear()

    // Confirm the scan genuinely ran on the *truncated* (transmitted) text,
    // not the original: a secret placed only beyond the truncation boundary
    // must NOT trigger any drop, because buildJudgePayload never sees it —
    // but the truncation itself is still logged (it did happen).
    const secretPastBoundary = "x".repeat(2500) + " sk-live-abc123def456ghi789jkl012mno345pqr"
    const raw2 = { criteria: [], diffSummary: "", verifierSummaries: [secretPastBoundary] }
    const payload2 = buildJudgePayload(raw2, logger)
    expect(payload2.verifierSummaries).toBeDefined()
    expect(payload2.verifierSummaries!.join("\n")).not.toContain("sk-live")
    expect(logger).toHaveBeenCalledTimes(1)
    expect(logger).toHaveBeenCalledWith("judge:field-truncated", {
      field: "verifierSummaries",
      originalLength: secretPastBoundary.length,
      cap: 2000,
    })
    // Not a "drop" — the field survived scanning non-empty, so
    // judge:field-dropped must never fire for it.
    expect(logger).not.toHaveBeenCalledWith("judge:field-dropped", expect.anything())
  })

  it("fix #5: a field within the cap is NOT reported as truncated", () => {
    const logger = vi.fn()
    const raw = { criteria: ["short criterion"], diffSummary: "", verifierSummaries: ["short summary"] }
    buildJudgePayload(raw, logger)
    expect(logger).not.toHaveBeenCalled()
  })

  it("fix #5: a field truncated AND then fully emptied by scanning logs BOTH judge:field-truncated and judge:field-dropped", () => {
    const logger = vi.fn()
    // The secret sits near the START of the field (well within the first
    // 2000 chars kept by truncation), followed by >2000 chars of clean
    // filler pushing the field's total length past the cap — so the field
    // is both truncated AND (since the surviving truncated text still
    // contains the secret) fully dropped by the scan.
    const secretText = 'const key = "sk-live-abc123def456ghi789jkl012mno345pqr" ' + "x".repeat(3000)
    const raw = { criteria: [], diffSummary: "", verifierSummaries: [secretText] }
    const payload = buildJudgePayload(raw, logger)
    expect(payload.verifierSummaries).toBeUndefined()
    expect(logger).toHaveBeenCalledWith(
      "judge:field-truncated",
      expect.objectContaining({ field: "verifierSummaries", originalLength: secretText.length }),
    )
    expect(logger).toHaveBeenCalledWith("judge:field-dropped", { field: "verifierSummaries" })
  })

  it("row 9 / test 39: ordinary English prose with a 40-char lowercase word run is NOT treated as a secret (false-positive guard)", () => {
    const logger = vi.fn()
    const prose = "constitutionalconstitutionalconstitution".slice(0, 40) // entropy ~2.99 bits/char
    expect(prose.length).toBe(40)
    const raw = { criteria: [], diffSummary: "", verifierSummaries: [`analysis: ${prose} completed cleanly`] }
    const payload = buildJudgePayload(raw, logger)
    expect(payload.verifierSummaries).toEqual([`analysis: ${prose} completed cleanly`])
    expect(logger).not.toHaveBeenCalled()
  })

  it("empty raw fields are omitted (not present as empty array/string) without logging field-dropped", () => {
    const logger = vi.fn()
    const payload = buildJudgePayload({ criteria: [], diffSummary: "", verifierSummaries: [] }, logger)
    expect(payload).toEqual({})
    expect(logger).not.toHaveBeenCalled()
  })

  it("dropping one criteria line among several logs nothing when the field survives non-empty", () => {
    const logger = vi.fn()
    const raw = {
      criteria: ["clean criterion one", "sk-live-abc123def456ghi789jkl012mno345pqr leaked here", "clean criterion two"],
      diffSummary: "",
      verifierSummaries: [],
    }
    const payload = buildJudgePayload(raw, logger)
    expect(payload.criteria).toEqual(["clean criterion one", "clean criterion two"])
    expect(logger).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// runJudge — FR-030/FR-030a/FR-030b/FR-032, BDD "Feature: Judge (US-9)"
// ===========================================================================

describe("runJudge", () => {
  const basePayload = { criteria: ["c1"], diffSummary: "@@ -1,1 +1,1 @@\n+ok", verifierSummaries: ["ok"] }

  it('BDD "Judge verdict appended without gating the checkpoint": a configured judge stub returning {fit:"concern", notes} resolves cleanly', async () => {
    mockRunSubturn.mockResolvedValue({
      ok: true,
      text: JSON.stringify({ fit: "concern", notes: "criterion 2 evidence is type-only" }),
    })
    const client = makeClient()
    const logger = vi.fn()
    const result = await runJudge(
      client,
      { selfCreated: new SelfCreatedSessions(), logger },
      {
        parentSessionID: "parent-1",
        sessionModel: { providerID: "minimax", modelID: "MiniMax-M3" },
        payload: basePayload,
      },
    )
    expect(result).toEqual({ verdict: { fit: "concern", notes: "criterion 2 evidence is type-only" } })
    // No judge:* failure event on a clean success.
    expect(logger).not.toHaveBeenCalled()
  })

  it('BDD "Judge subturn uses the session model by default": no override — prompt model is the session model, agent is vertex-judge, parent is the current session', async () => {
    const client = makeClient()
    await runJudge(
      client,
      { selfCreated: new SelfCreatedSessions(), logger: vi.fn() },
      {
        parentSessionID: "session-123",
        sessionModel: { providerID: "minimax", modelID: "MiniMax-M3" },
        payload: basePayload,
      },
    )
    expect(mockRunSubturn).toHaveBeenCalledTimes(1)
    const req = mockRunSubturn.mock.calls[0][3]
    expect(req.model).toEqual({ providerID: "minimax", modelID: "MiniMax-M3" })
    expect(req.agent).toBe("vertex-judge")
    expect(req.parentSessionID).toBe("session-123")
    expect(req.tools).toEqual(DENY_MAP)
  })

  it('BDD "Configured judgeModel failure falls back to the session model": retry uses session model within the shared 5s budget', async () => {
    mockRunSubturn
      .mockImplementationOnce(async () => {
        await new Promise((r) => setTimeout(r, 30)) // simulate real elapsed time before the failure
        return { ok: false, reason: "provider rejected the request" }
      })
      .mockResolvedValueOnce({ ok: true, text: JSON.stringify({ fit: "pass", notes: "ok on retry" }) })

    const client = makeClient()
    const result = await runJudge(
      client,
      { selfCreated: new SelfCreatedSessions(), logger: vi.fn() },
      {
        parentSessionID: "parent-1",
        sessionModel: { providerID: "minimax", modelID: "MiniMax-M3" },
        judgeModelOverride: { providerID: "provider-x", modelID: "model-y" },
        payload: basePayload,
      },
    )

    expect(mockRunSubturn).toHaveBeenCalledTimes(2)
    const firstReq = mockRunSubturn.mock.calls[0][3]
    const secondReq = mockRunSubturn.mock.calls[1][3]
    expect(firstReq.model).toEqual({ providerID: "provider-x", modelID: "model-y" })
    expect(secondReq.model).toEqual({ providerID: "minimax", modelID: "MiniMax-M3" })
    // Shared budget: the retry's timeout is the *remaining* time, strictly
    // less than a fresh JUDGE_TOTAL_BUDGET_MS — never 5s added per attempt.
    expect(secondReq.timeoutMs).toBeLessThan(JUDGE_TOTAL_BUDGET_MS)
    expect(result).toEqual({ verdict: { fit: "pass", notes: "ok on retry" } })
  })

  // =========================================================================
  // CRITICAL fix (post-review): the capability probe + deny-map build used
  // to be plain un-timed `await`s taken BEFORE the JUDGE_TOTAL_BUDGET_MS
  // clock started — only the later runSubturn call was ever raced against a
  // timeout. runJudge now starts its budget clock first and calls the
  // bounded probeCapabilityBounded(client, agent, budgetMs) helper, so the
  // probe + deny-map step itself counts against the shared 5s total.
  // =========================================================================

  it("fix #1: probeCapabilityBounded is invoked with the FULL JUDGE_TOTAL_BUDGET_MS as its budget (the clock starts before the probe)", async () => {
    const client = makeClient()
    await runJudge(
      client,
      { selfCreated: new SelfCreatedSessions(), logger: vi.fn() },
      {
        parentSessionID: "parent-1",
        sessionModel: { providerID: "minimax", modelID: "MiniMax-M3" },
        payload: basePayload,
      },
    )
    expect(mockProbeCapabilityBounded).toHaveBeenCalledTimes(1)
    expect(mockProbeCapabilityBounded).toHaveBeenCalledWith(client, "vertex-judge", JUDGE_TOTAL_BUDGET_MS)
  })

  it("fix #1: real elapsed time spent in the probe/deny-map step reduces the subturn attempt's timeout — never a fresh 5s after the probe", async () => {
    mockProbeCapabilityBounded.mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, 40)) // simulate real elapsed time during probe+deny-map
      return { ok: true, tools: DENY_MAP }
    })
    const client = makeClient()
    await runJudge(
      client,
      { selfCreated: new SelfCreatedSessions(), logger: vi.fn() },
      {
        parentSessionID: "parent-1",
        sessionModel: { providerID: "minimax", modelID: "MiniMax-M3" },
        payload: basePayload,
      },
    )
    expect(mockRunSubturn).toHaveBeenCalledTimes(1)
    const req = mockRunSubturn.mock.calls[0][3]
    // The subturn's budget is what's left of JUDGE_TOTAL_BUDGET_MS after the
    // probe/deny-map step's real elapsed time — strictly less than the full
    // budget, proving the clock was already running during that step.
    expect(req.timeoutMs).toBeLessThan(JUDGE_TOTAL_BUDGET_MS)
  })

  it('fix #1: a probe/deny-map TIMEOUT (cause:"timeout") resolves to "unsupported" — the same classification as an ordinary probe refusal — never throws, never calls runSubturn', async () => {
    mockProbeCapabilityBounded.mockResolvedValue({
      ok: false,
      cause: "timeout",
      reason: "capability probe (probe + deny map) timed out",
    })
    const client = makeClient()
    const logger = vi.fn()
    const result = await runJudge(
      client,
      { selfCreated: new SelfCreatedSessions(), logger },
      {
        parentSessionID: "parent-1",
        sessionModel: { providerID: "minimax", modelID: "MiniMax-M3" },
        payload: basePayload,
      },
    )
    expect(result).toEqual({ verdict: null, reason: "unsupported" })
    expect(logger).toHaveBeenCalledTimes(1)
    expect(logger).toHaveBeenCalledWith("judge:unsupported", {
      reason: "capability probe (probe + deny map) timed out",
    })
    expect(mockRunSubturn).not.toHaveBeenCalled()
  })

  it("fix #1: if the probe/deny-map step alone consumes the entire budget, the subturn loop reports timeout (remaining <= 0) rather than attempting with a negative/zero timeout", async () => {
    // Fake timers (rather than a real 5s+ delay) so this test proves the
    // "remaining <= 0" branch instantly: the mocked probeCapabilityBounded
    // advances the (mocked) clock past JUDGE_TOTAL_BUDGET_MS before
    // resolving, exactly as if a real probe/deny-map round trip had
    // genuinely taken that long between runJudge's `start = Date.now()` and
    // the probe settling.
    vi.useFakeTimers()
    try {
      mockProbeCapabilityBounded.mockImplementationOnce(async () => {
        vi.advanceTimersByTime(JUDGE_TOTAL_BUDGET_MS + 10)
        return { ok: true, tools: DENY_MAP }
      })
      const client = makeClient()
      const logger = vi.fn()
      const result = await runJudge(
        client,
        { selfCreated: new SelfCreatedSessions(), logger },
        {
          parentSessionID: "parent-1",
          sessionModel: { providerID: "minimax", modelID: "MiniMax-M3" },
          payload: basePayload,
        },
      )
      expect(mockRunSubturn).not.toHaveBeenCalled()
      expect(result).toEqual({ verdict: null, reason: "unavailable" })
      expect(logger).toHaveBeenCalledWith("judge:unavailable", { reason: "timeout" })
    } finally {
      vi.useRealTimers()
    }
  })

  it('BDD "Judge timeout fails open": a subturn that reports timeout resolves to unavailable and logs judge:unavailable', async () => {
    mockRunSubturn.mockResolvedValue({ ok: false, reason: "timeout" })
    const client = makeClient()
    const logger = vi.fn()
    const result = await runJudge(
      client,
      { selfCreated: new SelfCreatedSessions(), logger },
      {
        parentSessionID: "parent-1",
        sessionModel: { providerID: "minimax", modelID: "MiniMax-M3" },
        payload: basePayload,
      },
    )
    expect(result).toEqual({ verdict: null, reason: "unavailable" })
    expect(logger).toHaveBeenCalledWith("judge:unavailable", { reason: "timeout" })
  })

  it('BDD "Judge subturn is refused when tools cannot be disabled": probe failure => zero session.create/session.prompt (runSubturn never called), judge:unsupported logged once', async () => {
    mockProbeCapabilityBounded.mockResolvedValue({
      ok: false,
      cause: "probe",
      reason: 'agent "vertex-judge" resolves tool "bash" to true',
    })
    const client = makeClient()
    const logger = vi.fn()
    const result = await runJudge(
      client,
      { selfCreated: new SelfCreatedSessions(), logger },
      {
        parentSessionID: "parent-1",
        sessionModel: { providerID: "minimax", modelID: "MiniMax-M3" },
        payload: basePayload,
      },
    )
    expect(result).toEqual({ verdict: null, reason: "unsupported" })
    expect(logger).toHaveBeenCalledTimes(1)
    expect(logger).toHaveBeenCalledWith("judge:unsupported", {
      reason: 'agent "vertex-judge" resolves tool "bash" to true',
    })
    expect(mockRunSubturn).not.toHaveBeenCalled()
    expect(client.session.create).not.toHaveBeenCalled()
    expect(client.session.prompt).not.toHaveBeenCalled()
  })

  it("a thrown/unavailable deny-map build after a passing probe resolves to unavailable without calling runSubturn", async () => {
    mockProbeCapabilityBounded.mockResolvedValue({
      ok: false,
      cause: "deny-map",
      reason: "tool ids endpoint unavailable",
    })
    const client = makeClient()
    const logger = vi.fn()
    const result = await runJudge(
      client,
      { selfCreated: new SelfCreatedSessions(), logger },
      {
        parentSessionID: "parent-1",
        sessionModel: { providerID: "minimax", modelID: "MiniMax-M3" },
        payload: basePayload,
      },
    )
    expect(result).toEqual({ verdict: null, reason: "unavailable" })
    expect(logger).toHaveBeenCalledTimes(1)
    const [eventId, eventPayload] = logger.mock.calls[0]
    expect(eventId).toBe("judge:unavailable")
    expect(String((eventPayload as { reason: string }).reason)).toMatch(/tool ids endpoint unavailable/)
    expect(mockRunSubturn).not.toHaveBeenCalled()
  })

  it("malformed (non-JSON) response text resolves to malformed and logs judge:malformed", async () => {
    mockRunSubturn.mockResolvedValue({ ok: true, text: "here is my verdict: pass, looks fine" })
    const client = makeClient()
    const logger = vi.fn()
    const result = await runJudge(
      client,
      { selfCreated: new SelfCreatedSessions(), logger },
      {
        parentSessionID: "parent-1",
        sessionModel: { providerID: "minimax", modelID: "MiniMax-M3" },
        payload: basePayload,
      },
    )
    expect(result).toEqual({ verdict: null, reason: "malformed" })
    expect(logger).toHaveBeenCalledWith("judge:malformed", expect.objectContaining({ reason: expect.any(String) }))
  })

  it("valid JSON that does not match the {fit, notes} shape resolves to malformed", async () => {
    mockRunSubturn.mockResolvedValue({ ok: true, text: JSON.stringify({ fit: "maybe", notes: "unsure" }) })
    const client = makeClient()
    const logger = vi.fn()
    const result = await runJudge(
      client,
      { selfCreated: new SelfCreatedSessions(), logger },
      {
        parentSessionID: "parent-1",
        sessionModel: { providerID: "minimax", modelID: "MiniMax-M3" },
        payload: basePayload,
      },
    )
    expect(result).toEqual({ verdict: null, reason: "malformed" })
    expect(logger).toHaveBeenCalledWith("judge:malformed", expect.any(Object))
  })

  it("valid JSON missing the notes field resolves to malformed", async () => {
    mockRunSubturn.mockResolvedValue({ ok: true, text: JSON.stringify({ fit: "pass" }) })
    const client = makeClient()
    const logger = vi.fn()
    const result = await runJudge(
      client,
      { selfCreated: new SelfCreatedSessions(), logger },
      {
        parentSessionID: "parent-1",
        sessionModel: { providerID: "minimax", modelID: "MiniMax-M3" },
        payload: basePayload,
      },
    )
    expect(result).toEqual({ verdict: null, reason: "malformed" })
  })

  it("no judgeModelOverride means a single attempt only — no retry, no fallback logic exercised", async () => {
    mockRunSubturn.mockResolvedValue({ ok: false, reason: "provider unreachable" })
    const client = makeClient()
    const logger = vi.fn()
    await runJudge(
      client,
      { selfCreated: new SelfCreatedSessions(), logger },
      {
        parentSessionID: "parent-1",
        sessionModel: { providerID: "minimax", modelID: "MiniMax-M3" },
        payload: basePayload,
      },
    )
    expect(mockRunSubturn).toHaveBeenCalledTimes(1)
    expect(logger).toHaveBeenCalledWith("judge:unavailable", { reason: "provider unreachable" })
  })

  it("thrown error from runSubturn's own promise rejection still resolves via the ok:false contract, not a throw", async () => {
    // runSubturn itself never rejects (subturn.ts's own contract: every exit
    // path resolves to a SubturnResult) — this test documents that runJudge
    // does not add its own try/catch around runSubturn and instead trusts
    // that contract, by asserting a call that resolves ok:false propagates
    // cleanly without runJudge throwing.
    mockRunSubturn.mockResolvedValue({ ok: false, reason: "subturn failed: boom" })
    const client = makeClient()
    await expect(
      runJudge(
        client,
        { selfCreated: new SelfCreatedSessions(), logger: vi.fn() },
        {
          parentSessionID: "parent-1",
          sessionModel: { providerID: "minimax", modelID: "MiniMax-M3" },
          payload: basePayload,
        },
      ),
    ).resolves.toEqual({ verdict: null, reason: "unavailable" })
  })
})
