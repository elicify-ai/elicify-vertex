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

import { buildJudgePayload, JUDGE_TOTAL_BUDGET_MS, runJudge, parseJudgeResponse } from "../../src/v2/judge.js"
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
  mockRunSubturn.mockResolvedValue({ ok: true, text: '{"fit":"pass","summary":"looks fine","gaps":[]}' })
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
      lastResponse: "",
      recentTranscript: "",
    }
    const payload = buildJudgePayload(raw, logger)
    expect(payload).toEqual({
      criteria: raw.criteria,
      diffSummary: raw.diffSummary,
      verifierSummaries: raw.verifierSummaries,
    })
    expect(logger).not.toHaveBeenCalled()
  })

  it("row 2 / test 18: payload has no free-form narrative field to leak NARRATIVE_CANARY through — schema excludes it structurally", () => {
    const logger = vi.fn()
    // buildJudgePayload's signature accepts only the five named fields — there
    // is no free-form chat-narrative parameter for a canary to travel
    // through. A canary planted in any of the real fields is still just
    // content, scanned like anything else; asserting it survives (when it
    // doesn't match any secret pattern) demonstrates the exclusion is
    // structural, not a runtime filter that could itself be bypassed.
    const raw = {
      criteria: ["Criterion mentioning nothing sensitive"],
      diffSummary: "@@ -1,1 +1,1 @@\n+ordinary line",
      verifierSummaries: ["verifier ok"],
      lastResponse: "",
      recentTranscript: "",
    }
    const payload = buildJudgePayload(raw, logger)
    expect(JSON.stringify(payload)).not.toContain("NARRATIVE_CANARY")
    expect(
      Object.keys(payload).every((k) =>
        ["criteria", "diffSummary", "verifierSummaries", "lastResponse", "recentTranscript"].includes(k),
      ),
    ).toBe(true)
  })

  it("row 3 / test 39: diff hunk containing a complete sk-live token is dropped; other hunks survive", () => {
    const logger = vi.fn()
    const cleanHunk = "@@ -1,1 +1,1 @@\n-old\n+new"
    const secretHunk = '@@ -2,1 +2,1 @@\n+const key = "sk-live-abc123def456ghi789jkl012mno345pqr"'
    const raw = {
      criteria: [],
      diffSummary: [cleanHunk, secretHunk].join("\n"),
      verifierSummaries: [],
      lastResponse: "",
      recentTranscript: "",
    }
    const payload = buildJudgePayload(raw, logger)
    expect(payload.diffSummary).toBe(cleanHunk)
    expect(payload.diffSummary).not.toContain("sk-live")
    // field not emptied — no field-dropped, but one of the two hunks WAS
    // dropped, so the partial-drop event (added post-review — see the
    // judge:field-partial-drop tests below) must fire instead of nothing.
    expect(logger).toHaveBeenCalledTimes(1)
    expect(logger).toHaveBeenCalledWith("judge:field-partial-drop", { field: "diffSummary", kept: 1, dropped: 1 })
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
    const raw = { criteria: [], diffSummary: hunkWithSplitSecret, verifierSummaries: [], lastResponse: "", recentTranscript: "" }
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
      lastResponse: "",
      recentTranscript: "",
    }
    const payload = buildJudgePayload(raw, logger)
    expect(payload.verifierSummaries).toEqual(["5 passed, 0 failed"])
    // field not emptied (second line survives), but the first line WAS
    // dropped — partial-drop event fires instead of silence.
    expect(logger).toHaveBeenCalledTimes(1)
    expect(logger).toHaveBeenCalledWith("judge:field-partial-drop", { field: "verifierSummaries", kept: 1, dropped: 1 })
  })

  it("row 6 / test 39: connection string wrapped across two verifier-summary lines — both removed on reassembled scan", () => {
    const logger = vi.fn()
    const line1 = "Connecting to postgres://user:sec"
    const line2 = "retpass@dbhost:5432/mydb succeeded"
    const raw = {
      criteria: [],
      diffSummary: "",
      verifierSummaries: [line1, line2, "2 passed, 0 failed"],
      lastResponse: "",
      recentTranscript: "",
    }
    const payload = buildJudgePayload(raw, logger)
    expect(payload.verifierSummaries).toEqual(["2 passed, 0 failed"])
    // field not emptied — one surviving line, but both wrapped lines were
    // dropped as a pair — partial-drop event fires instead of silence.
    expect(logger).toHaveBeenCalledTimes(1)
    expect(logger).toHaveBeenCalledWith("judge:field-partial-drop", { field: "verifierSummaries", kept: 1, dropped: 2 })
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
      lastResponse: "",
      recentTranscript: "",
    }
    const payload = buildJudgePayload(raw, logger)
    expect(payload.criteria).toBeUndefined()
    expect(logger).toHaveBeenCalledWith("judge:field-dropped", { field: "criteria" })
  })

  it("row 8 / test 39: an oversized clean verifier summary is truncated to the field cap after scanning (C-9: scan-then-truncate)", () => {
    const logger = vi.fn()
    const longClean = "ok ".repeat(1334) // ~4002 chars, well past the 2000-char field cap, no secrets
    const raw = { criteria: [], diffSummary: "", verifierSummaries: [longClean], lastResponse: "", recentTranscript: "" }
    const payload = buildJudgePayload(raw, logger)
    expect(payload.verifierSummaries).toBeDefined()
    const survivingLength = payload.verifierSummaries!.join("\n").length
    expect(survivingLength).toBeLessThanOrEqual(2000)
    expect(survivingLength).toBeLessThan(longClean.length)
    // MINOR fix (post-review): truncation is no longer silent — a
    // judge:field-truncated event records that this field was cut, even
    // though it survives non-empty (never a judge:field-dropped, since the
    // field is not emptied). Nothing tripped the scan here, so the
    // post-scan length truncateField sees is identical to the raw length.
    expect(logger).toHaveBeenCalledTimes(1)
    expect(logger).toHaveBeenCalledWith("judge:field-truncated", {
      field: "verifierSummaries",
      originalLength: longClean.length,
      cap: 2000,
    })
    logger.mockClear()

    // C-9 fix (docs/CODE-ISSUES-FROM-PROMPT-AUDIT.md — "boundary-truncation
    // fragment leak"): a secret positioned past where the OLD truncate-first
    // cap used to cut is now still caught. Under the old truncate-then-scan
    // order this secret sat beyond the 2000-char cut point, was sliced away
    // before the scan ever ran, and buildJudgePayload never saw it at all —
    // the field only "survived" because the secret had already been
    // silently discarded, not because it was safe. Now the FULL field
    // (including everything past the old cut point) is scanned first, the
    // unit containing the secret trips, and the field is correctly dropped
    // in full — never truncated, since nothing survives scanning to
    // truncate (judge:field-truncated and judge:field-dropped are mutually
    // exclusive per field; see truncateField's doc comment).
    const secretPastOldBoundary = "x".repeat(2500) + " sk-live-abc123def456ghi789jkl012mno345pqr"
    const raw2 = {
      criteria: [],
      diffSummary: "",
      verifierSummaries: [secretPastOldBoundary],
      lastResponse: "",
      recentTranscript: "",
    }
    const payload2 = buildJudgePayload(raw2, logger)
    expect(payload2.verifierSummaries).toBeUndefined()
    expect(logger).toHaveBeenCalledTimes(1)
    expect(logger).toHaveBeenCalledWith("judge:field-dropped", { field: "verifierSummaries" })
    expect(logger).not.toHaveBeenCalledWith("judge:field-truncated", expect.anything())
  })

  it("fix #5: a field within the cap is NOT reported as truncated", () => {
    const logger = vi.fn()
    const raw = {
      criteria: ["short criterion"],
      diffSummary: "",
      verifierSummaries: ["short summary"],
      lastResponse: "",
      recentTranscript: "",
    }
    buildJudgePayload(raw, logger)
    expect(logger).not.toHaveBeenCalled()
  })

  it("fix #5 (updated for C-9 scan-then-truncate order): a single-unit field containing a secret is dropped in full, never also reported as truncated — judge:field-dropped and judge:field-truncated are mutually exclusive per field", () => {
    const logger = vi.fn()
    // Under the OLD truncate-then-scan order this exact input used to log
    // BOTH events (truncated to the cap, then the surviving truncated text
    // still contained the secret so it was also fully dropped). Under the
    // NEW scan-then-truncate order, scanning runs first on the whole field:
    // since this field is a single unit (no newlines) and that unit
    // contains the secret, the WHOLE unit is dropped immediately — there is
    // nothing left to truncate, so judge:field-truncated no longer fires
    // for this case at all.
    const secretText = 'const key = "sk-live-abc123def456ghi789jkl012mno345pqr" ' + "x".repeat(3000)
    const raw = { criteria: [], diffSummary: "", verifierSummaries: [secretText], lastResponse: "", recentTranscript: "" }
    const payload = buildJudgePayload(raw, logger)
    expect(payload.verifierSummaries).toBeUndefined()
    expect(logger).toHaveBeenCalledTimes(1)
    expect(logger).toHaveBeenCalledWith("judge:field-dropped", { field: "verifierSummaries" })
    expect(logger).not.toHaveBeenCalledWith("judge:field-truncated", expect.anything())
  })

  it("C-9 (multi-unit): a field that loses a tainted line to scanning AND remains oversized afterward logs BOTH judge:field-partial-drop and judge:field-truncated", () => {
    const logger = vi.fn()
    // Unlike the single-unit fix-#5 case above, a MULTI-unit field can still
    // combine a scan-driven drop with a truncation: here one line trips (and
    // is dropped) while the OTHER, surviving line is on its own already past
    // the cap, so the field is both partially dropped and truncated.
    const secretLine = 'const key = "sk-live-abc123def456ghi789jkl012mno345pqr"'
    const longCleanLine = "ok ".repeat(1000) // 3000 chars, clean, no secret
    const raw = {
      criteria: [],
      diffSummary: "",
      verifierSummaries: [secretLine, longCleanLine],
      lastResponse: "",
      recentTranscript: "",
    }
    const payload = buildJudgePayload(raw, logger)
    expect(payload.verifierSummaries).toBeDefined()
    expect(payload.verifierSummaries!.join("\n")).not.toContain("sk-live")
    expect(logger).toHaveBeenCalledWith("judge:field-partial-drop", { field: "verifierSummaries", kept: 1, dropped: 1 })
    expect(logger).toHaveBeenCalledWith("judge:field-truncated", {
      field: "verifierSummaries",
      originalLength: longCleanLine.length,
      cap: 2000,
    })
    expect(logger).not.toHaveBeenCalledWith("judge:field-dropped", expect.anything())
  })

  it("C-9: a 40-char JWT-shaped secret straddling the field's truncation-cap boundary is fully caught, not left as a leaking fragment (redact-then-truncate ordering)", () => {
    const logger = vi.fn()
    const CAP = 2000 // JUDGE_PAYLOAD_FIELD_CHAR_CAP
    // Exact reproduction numbers from docs/CODE-ISSUES-FROM-PROMPT-AUDIT.md's
    // C-9: a 40-char JWT-shaped string, third segment exactly at the JWT
    // pattern's `{8,}` floor. Scanned whole it redacts to [REDACTED:JWT];
    // truncated to 39 chars first (one char short) its third segment drops
    // to 7 chars — one under the floor — and the entire 39-char fragment
    // used to survive a truncate-first pipeline completely unredacted.
    const jwt = "eyJAAAAAAAA.BBBBBBBBBBBBBBBBBBB.CCCCCCCC"
    expect(jwt.length).toBe(40)
    // Filler (+ a boundary space so \b applies before "eyJ") sized so the
    // OLD truncate-first pipeline's cap cut would have landed exactly one
    // character into the jwt's tail: filler consumes CAP - 40 chars, the
    // space brings the running total to CAP - 39, leaving exactly 39 of the
    // jwt's 40 chars inside the old CAP-char window.
    const filler = "x".repeat(CAP - 40) + " "
    const text = filler + jwt
    expect(text.length).toBe(CAP + 1)

    const raw = { criteria: [], diffSummary: "", verifierSummaries: [text], lastResponse: "", recentTranscript: "" }
    const payload = buildJudgePayload(raw, logger)

    // Redact-then-truncate: the scan sees the WHOLE field — including
    // everything past where the old cap used to cut — before any truncation
    // happens, so the full jwt is visible to the JWT pattern and the unit
    // containing it is dropped in its entirety. Nothing survives to leak.
    expect(payload.verifierSummaries).toBeUndefined()
    expect(logger).toHaveBeenCalledTimes(1)
    expect(logger).toHaveBeenCalledWith("judge:field-dropped", { field: "verifierSummaries" })
  })

  it("C-8 backstop: a genuine unlabeled high-entropy secret — no ':'/'=' anywhere near it — is still caught by the entropy scan after the C-8 label-pattern tightening", () => {
    const logger = vi.fn()
    // 40 distinct characters drawn from a 62-symbol alphabet (stride 7 is
    // coprime with 62, so no repeats across i=0..39) — no assignment
    // separator, no recognizable secret-pattern prefix, just a high-entropy
    // unlabeled run, the exact shape C-8's fix relies on the entropy scan to
    // still catch once the label pattern was tightened.
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
    const highEntropyToken = Array.from({ length: 40 }, (_, i) => alphabet[(i * 7 + 3) % alphabet.length]).join("")
    expect(highEntropyToken.length).toBe(40)
    const raw = {
      criteria: [],
      diffSummary: "",
      verifierSummaries: [],
      lastResponse: "",
      recentTranscript: `assistant: here is the raw value ${highEntropyToken} for reference`,
    }
    const payload = buildJudgePayload(raw, logger)
    expect(payload.recentTranscript).toBeUndefined()
    expect(logger).toHaveBeenCalledWith("judge:field-dropped", { field: "recentTranscript" })
  })

  it("C-15: a realistic unlabeled hex secret — well below the entropy backstop's effective threshold — is caught by the hex-run backstop", () => {
    const logger = vi.fn()
    // Measured entropy 3.83 bits/char — below ENTROPY_EFFECTIVE_THRESHOLD_BITS
    // (3.95). This is the exact previously-leaking example from the audit
    // doc's C-15 entry: reads as obviously random to a human, but the
    // entropy rule's razor-thin margin (reachable only by a near-perfectly-
    // uniform 16-symbol distribution) let it through before this fix.
    const raw = {
      criteria: [],
      diffSummary: "",
      verifierSummaries: [],
      lastResponse: "our client secret ends up being 8f3ac9d2e1b74c0aa9f2d8e7c1b3a4f6",
      recentTranscript: "",
    }
    const payload = buildJudgePayload(raw, logger)
    expect(payload.lastResponse).toBeUndefined()
    expect(logger).toHaveBeenCalledWith("judge:field-dropped", { field: "lastResponse" })
  })

  it("C-15: a git-SHA-shaped hex run (not a secret) is still dropped — accepted false-positive cost of the hex-run backstop", () => {
    const logger = vi.fn()
    // 40 hex chars, git-SHA-shaped, measured 3.92 bits/char — below
    // ENTROPY_EFFECTIVE_THRESHOLD_BITS (3.95), so this specifically exercises
    // the hex-run backstop rather than accidentally passing via the
    // pre-existing entropy scan.
    const fullSha = "2b5335bd3dd6bc17e449a8c2f01d7e93a4c6b81f"
    const raw = {
      criteria: [],
      diffSummary: "",
      verifierSummaries: [`fixed in commit ${fullSha}`],
      lastResponse: "",
      recentTranscript: "",
    }
    const payload = buildJudgePayload(raw, logger)
    expect(payload.verifierSummaries).toBeUndefined()
    expect(logger).toHaveBeenCalledWith("judge:field-dropped", { field: "verifierSummaries" })
  })

  it("C-15: a dictionary-word passphrase embedded in prose is NOT caught — documented, accepted residual risk (no reliable local heuristic)", () => {
    const logger = vi.fn()
    // Pins current (accepted) behavior: this measures similarly low entropy
    // to ordinary English (repeated common letters from real dictionary
    // words) and is not a pure-hex run, so neither backstop trips. A fix
    // attempt here would need to distinguish this from ordinary prose, which
    // risks reopening C-8's false-positive problem.
    const text = "she pasted the password hunter2CorrectHorseBatteryStaple99 in the chat by mistake"
    const raw = { criteria: [], diffSummary: "", verifierSummaries: [], lastResponse: text, recentTranscript: "" }
    const payload = buildJudgePayload(raw, logger)
    expect(payload.lastResponse).toBe(text)
    expect(logger).not.toHaveBeenCalled()
  })

  it("C-15: an oversized raw field is dropped whole, before scanning, rather than scanned in full every time (cost bound)", () => {
    const logger = vi.fn()
    // JUDGE_PAYLOAD_RAW_FIELD_SAFETY_CAP is 100_000 — well past any
    // realistic evidence field, so a field this large is treated as
    // pathological and dropped whole rather than paying the full scan cost.
    const oversized = "x".repeat(100_001)
    const raw = { criteria: [], diffSummary: "", verifierSummaries: [], lastResponse: oversized, recentTranscript: "" }
    const payload = buildJudgePayload(raw, logger)
    expect(payload.lastResponse).toBeUndefined()
    expect(logger).toHaveBeenCalledWith("judge:field-oversized", {
      field: "lastResponse",
      rawLength: oversized.length,
      cap: 100_000,
    })
  })

  it("row 9 / test 39: ordinary English prose with a 40-char lowercase word run is NOT treated as a secret (false-positive guard)", () => {
    const logger = vi.fn()
    const prose = "constitutionalconstitutionalconstitution".slice(0, 40) // entropy ~2.99 bits/char
    expect(prose.length).toBe(40)
    const raw = {
      criteria: [],
      diffSummary: "",
      verifierSummaries: [`analysis: ${prose} completed cleanly`],
      lastResponse: "",
      recentTranscript: "",
    }
    const payload = buildJudgePayload(raw, logger)
    expect(payload.verifierSummaries).toEqual([`analysis: ${prose} completed cleanly`])
    expect(logger).not.toHaveBeenCalled()
  })

  it("empty raw fields are omitted (not present as empty array/string) without logging field-dropped", () => {
    const logger = vi.fn()
    const payload = buildJudgePayload(
      { criteria: [], diffSummary: "", verifierSummaries: [], lastResponse: "", recentTranscript: "" },
      logger,
    )
    expect(payload).toEqual({})
    expect(logger).not.toHaveBeenCalled()
  })

  it("dropping one criteria line among several logs judge:field-partial-drop, not silence", () => {
    const logger = vi.fn()
    const raw = {
      criteria: ["clean criterion one", "sk-live-abc123def456ghi789jkl012mno345pqr leaked here", "clean criterion two"],
      diffSummary: "",
      verifierSummaries: [],
      lastResponse: "",
      recentTranscript: "",
    }
    const payload = buildJudgePayload(raw, logger)
    expect(payload.criteria).toEqual(["clean criterion one", "clean criterion two"])
    // one of three lines dropped, field survives — partial-drop event fires
    // instead of silence (was the silent gap this test used to assert).
    expect(logger).toHaveBeenCalledTimes(1)
    expect(logger).toHaveBeenCalledWith("judge:field-partial-drop", { field: "criteria", kept: 2, dropped: 1 })
  })

  // =========================================================================
  // docs/JUDGE-PROMPT.md §5 — lastResponse/recentTranscript go through the
  // SAME redaction pipeline as the original three fields.
  // =========================================================================

  it("§5: a clean lastResponse and recentTranscript transmit unchanged", () => {
    const logger = vi.fn()
    const raw = {
      criteria: [],
      diffSummary: "",
      verifierSummaries: [],
      lastResponse: "All acceptance criteria are covered by the new tests.",
      recentTranscript: "user: please finish this\nassistant: done, tests pass",
    }
    const payload = buildJudgePayload(raw, logger)
    expect(payload.lastResponse).toBe(raw.lastResponse)
    expect(payload.recentTranscript).toBe(raw.recentTranscript)
    expect(logger).not.toHaveBeenCalled()
  })

  it("§5 security-critical: a secret embedded in lastResponse is redacted exactly like one embedded in diffSummary", () => {
    const logger = vi.fn()
    const secret = "sk-live-abc123def456ghi789jkl012mno345pqr"
    const raw = {
      criteria: [],
      diffSummary: "",
      verifierSummaries: [],
      lastResponse: `I finished the task. Here is the key I used: ${secret}`,
      recentTranscript: "",
    }
    const payload = buildJudgePayload(raw, logger)
    expect(payload.lastResponse).toBeUndefined()
    expect(JSON.stringify(payload)).not.toContain(secret)
    expect(logger).toHaveBeenCalledWith("judge:field-dropped", { field: "lastResponse" })
  })

  it("§5 security-critical: a secret embedded in recentTranscript is redacted exactly like one embedded in diffSummary", () => {
    const logger = vi.fn()
    const secret = "sk-live-abc123def456ghi789jkl012mno345pqr"
    const raw = {
      criteria: [],
      diffSummary: "",
      verifierSummaries: [],
      lastResponse: "",
      // Single line (no other lines to survive independently) so the whole
      // field is emptied by the scan — the direct analogue of row 4's
      // "token split across a hunk boundary -> whole diffSummary dropped".
      recentTranscript: `assistant: the key I used is ${secret}, all set`,
    }
    const payload = buildJudgePayload(raw, logger)
    expect(payload.recentTranscript).toBeUndefined()
    expect(JSON.stringify(payload)).not.toContain(secret)
    expect(logger).toHaveBeenCalledWith("judge:field-dropped", { field: "recentTranscript" })
  })

  it("§5 security-critical: a secret on one line of recentTranscript is dropped while a clean line survives", () => {
    const logger = vi.fn()
    const secret = "sk-live-abc123def456ghi789jkl012mno345pqr"
    const raw = {
      criteria: [],
      diffSummary: "",
      verifierSummaries: [],
      lastResponse: "",
      recentTranscript: `user: go ahead\nassistant: using ${secret} now\nassistant: all tests pass`,
    }
    const payload = buildJudgePayload(raw, logger)
    expect(payload.recentTranscript).toBeDefined()
    expect(payload.recentTranscript).not.toContain(secret)
    expect(payload.recentTranscript).toContain("all tests pass")
    // field survived non-empty — no field-dropped, but partial-drop fires
    // (one of three lines was removed).
    expect(logger).toHaveBeenCalledTimes(1)
    expect(logger).toHaveBeenCalledWith("judge:field-partial-drop", { field: "recentTranscript", kept: 2, dropped: 1 })
  })

  it("§5: recentTranscript is truncated to its own 4000-char cap (double the other fields' cap), not JUDGE_PAYLOAD_FIELD_CHAR_CAP", () => {
    const logger = vi.fn()
    const longClean = "assistant: ok ".repeat(400) // well past 4000 chars, no secrets
    const raw = {
      criteria: [],
      diffSummary: "",
      verifierSummaries: [],
      lastResponse: "",
      recentTranscript: longClean,
    }
    const payload = buildJudgePayload(raw, logger)
    expect(payload.recentTranscript).toBeDefined()
    expect(payload.recentTranscript!.length).toBeLessThanOrEqual(4000)
    expect(logger).toHaveBeenCalledWith("judge:field-truncated", {
      field: "recentTranscript",
      originalLength: longClean.length,
      cap: 4000,
    })
  })

  it("§5: lastResponse over 2000 chars is truncated at the SAME cap as the other fields", () => {
    const logger = vi.fn()
    const longClean = "ok ".repeat(1000) // 3000 chars, past the 2000-char cap
    const raw = {
      criteria: [],
      diffSummary: "",
      verifierSummaries: [],
      lastResponse: longClean,
      recentTranscript: "",
    }
    const payload = buildJudgePayload(raw, logger)
    expect(payload.lastResponse).toBeDefined()
    expect(payload.lastResponse!.length).toBeLessThanOrEqual(2000)
    expect(logger).toHaveBeenCalledWith("judge:field-truncated", {
      field: "lastResponse",
      originalLength: longClean.length,
      cap: 2000,
    })
  })

  it("§5: empty lastResponse/recentTranscript are omitted, same as the other empty fields", () => {
    const logger = vi.fn()
    const payload = buildJudgePayload(
      { criteria: [], diffSummary: "", verifierSummaries: [], lastResponse: "", recentTranscript: "" },
      logger,
    )
    expect(payload).toEqual({})
    expect(logger).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// judge:field-partial-drop — post-review fix. `judge:field-dropped` already
// fired correctly when a field's scan emptied it ENTIRELY; nothing fired when
// a field survived non-empty but lost some content, so "the assistant never
// said this" and "it said this and the scan silently removed it" were
// indistinguishable from the log alone.
//
// Originally demonstrated (review finding) with the benign sentence "I made
// sure no secrets leaked into the log output." — that sentence used to trip
// `SENSITIVE_ASSIGNMENT_LABEL` purely because it contains "secrets" followed
// by ordinary prose with no comma/semicolon before end of line, with no
// actual `:`/`=` assignment anywhere in sight. C-8
// (docs/CODE-ISSUES-FROM-PROMPT-AUDIT.md) has since tightened that pattern in
// src/redaction.ts to require a real `:`/`=` separator (see
// tests/riskRedaction.test.ts), so this exact sentence no longer trips
// anything — it is now the NEGATIVE case exercised right below, and the
// partial-drop demonstration is updated to use a genuine secret instead, so
// this block keeps proving the partial-drop mechanism itself independent of
// the (now-fixed) false positive that used to stand in for it.
// ===========================================================================

describe("judge:field-partial-drop", () => {
  it("C-8 regression: the exact false-positive sentence from the audit doc no longer trips anything and survives in recentTranscript unredacted", () => {
    const logger = vi.fn()
    const raw = {
      criteria: [],
      diffSummary: "",
      verifierSummaries: [],
      lastResponse: "",
      recentTranscript: [
        "user: please wrap up",
        "assistant: I made sure no secrets leaked into the log output.",
        "assistant: all tests pass",
      ].join("\n"),
    }
    const payload = buildJudgePayload(raw, logger)
    expect(payload.recentTranscript).toBe(raw.recentTranscript)
    expect(logger).not.toHaveBeenCalled()
  })

  it("a genuine partial drop: a real secret on one line of a multi-line recentTranscript is dropped, the field survives non-empty, and the drop is now logged", () => {
    const logger = vi.fn()
    const secret = "sk-live-abc123def456ghi789jkl012mno345pqr"
    const raw = {
      criteria: [],
      diffSummary: "",
      verifierSummaries: [],
      lastResponse: "",
      recentTranscript: [
        "user: please wrap up",
        `assistant: the key I used is ${secret}`,
        "assistant: all tests pass",
      ].join("\n"),
    }
    const payload = buildJudgePayload(raw, logger)

    // The line with the secret is gone, but the field survives non-empty.
    expect(payload.recentTranscript).toBeDefined()
    expect(payload.recentTranscript).not.toContain(secret)
    expect(payload.recentTranscript).toContain("user: please wrap up")
    expect(payload.recentTranscript).toContain("assistant: all tests pass")

    // The fix under test: a partial drop is now observable, distinguishing
    // "never said" from "said and silently removed" — and full-empty
    // judge:field-dropped must NOT fire, since the field is not empty.
    expect(logger).toHaveBeenCalledWith("judge:field-partial-drop", {
      field: "recentTranscript",
      kept: 2,
      dropped: 1,
    })
    expect(logger).not.toHaveBeenCalledWith("judge:field-dropped", expect.anything())
  })

  it("does NOT fire on a fully clean multi-line field (nothing dropped)", () => {
    const logger = vi.fn()
    const raw = {
      criteria: ["clean one", "clean two", "clean three"],
      diffSummary: "@@ -1,1 +1,1 @@\n-old\n+new",
      verifierSummaries: ["all good"],
      lastResponse: "everything looks fine",
      recentTranscript: "user: go\nassistant: done, all clean",
    }
    const payload = buildJudgePayload(raw, logger)
    expect(payload.criteria).toEqual(raw.criteria)
    expect(logger).not.toHaveBeenCalledWith("judge:field-partial-drop", expect.anything())
    expect(logger).not.toHaveBeenCalled()
  })

  it("does NOT fire when a field is dropped in full (that stays judge:field-dropped only, per field)", () => {
    const logger = vi.fn()
    const secret = "sk-live-abc123def456ghi789jkl012mno345pqr"
    // Single-line field: the only unit is dropped -> the field is fully
    // empty, not partial. judge:field-dropped alone must fire.
    const raw = {
      criteria: [],
      diffSummary: "",
      verifierSummaries: [],
      lastResponse: `the key I used is ${secret}`,
      recentTranscript: "",
    }
    const payload = buildJudgePayload(raw, logger)
    expect(payload.lastResponse).toBeUndefined()
    expect(logger).toHaveBeenCalledWith("judge:field-dropped", { field: "lastResponse" })
    expect(logger).not.toHaveBeenCalledWith("judge:field-partial-drop", expect.anything())
  })
})

// ===========================================================================
// runJudge — FR-030/FR-030a/FR-030b/FR-032, BDD "Feature: Judge (US-9)"
// ===========================================================================

describe("runJudge", () => {
  const basePayload = { criteria: ["c1"], diffSummary: "@@ -1,1 +1,1 @@\n+ok", verifierSummaries: ["ok"] }

  it('BDD "Judge verdict appended without gating the checkpoint": a configured judge stub returning {fit:"concern", summary, gaps} resolves cleanly', async () => {
    const gaps = [
      {
        issue: "criterion 2 evidence is type-only",
        evidence: "verifier summary only reports a typecheck, not a test run",
        fix: "run the test suite and cite its output",
      },
    ]
    mockRunSubturn.mockResolvedValue({
      ok: true,
      text: JSON.stringify({ fit: "concern", summary: "criterion 2 evidence is type-only", gaps }),
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
    expect(result).toEqual({ verdict: { fit: "concern", summary: "criterion 2 evidence is type-only", gaps } })
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
      .mockResolvedValueOnce({ ok: true, text: JSON.stringify({ fit: "pass", summary: "ok on retry", gaps: [] }) })

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
    expect(result).toEqual({ verdict: { fit: "pass", summary: "ok on retry", gaps: [] } })
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

  it('valid JSON with an invalid "fit" value (does not match the {fit, summary, gaps} shape) resolves to malformed', async () => {
    mockRunSubturn.mockResolvedValue({ ok: true, text: JSON.stringify({ fit: "maybe", summary: "unsure", gaps: [] }) })
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

  it("valid JSON missing the summary/gaps fields resolves to malformed", async () => {
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

  // =========================================================================
  // §4 redesign — new schema shape enforcement. Required coverage per the
  // task brief: (1) the superseded {fit, notes} shape must now be rejected,
  // not silently accepted; (2) fit:"pass" with a non-empty gaps array must be
  // rejected (a deliberate, tested validation choice, not an accident).
  // =========================================================================

  it('§4: an old-shape {fit, notes} reply (the shape this judge used to emit) is now rejected as malformed, not silently accepted', async () => {
    mockRunSubturn.mockResolvedValue({
      ok: true,
      text: JSON.stringify({ fit: "pass", notes: "looks fine" }),
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
    expect(result).toEqual({ verdict: null, reason: "malformed" })
    expect(logger).toHaveBeenCalledWith(
      "judge:malformed",
      expect.objectContaining({ reason: expect.stringContaining("does not match") }),
    )
  })

  it('§4: fit:"pass" with a non-empty gaps array is rejected as malformed (pass requires gaps === [])', async () => {
    mockRunSubturn.mockResolvedValue({
      ok: true,
      text: JSON.stringify({
        fit: "pass",
        summary: "looks fine",
        gaps: [{ issue: "leftover doubt", evidence: "some evidence", fix: "do the fix" }],
      }),
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
    expect(result).toEqual({ verdict: null, reason: "malformed" })
  })

  it('§4: fit:"concern" with a well-shaped, non-empty gaps array is accepted', async () => {
    const gaps = [
      { issue: "criterion 2 unverified", evidence: "no verifier summary mentions it", fix: "run the verifier and cite the result" },
      { issue: "diff touches an unrelated file", evidence: "diffSummary shows src/unrelated.ts", fix: "explain or revert the unrelated change" },
    ]
    mockRunSubturn.mockResolvedValue({
      ok: true,
      text: JSON.stringify({ fit: "concern", summary: "two open items", gaps }),
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
    expect(result).toEqual({ verdict: { fit: "concern", summary: "two open items", gaps } })
    expect(logger).not.toHaveBeenCalled()
  })

  it('§4: fit:"concern" with an empty gaps array is accepted (non-emptiness is prompt guidance, not a shape requirement)', async () => {
    mockRunSubturn.mockResolvedValue({
      ok: true,
      text: JSON.stringify({ fit: "concern", summary: "something feels off but I can't pin it down", gaps: [] }),
    })
    const client = makeClient()
    const result = await runJudge(
      client,
      { selfCreated: new SelfCreatedSessions(), logger: vi.fn() },
      {
        parentSessionID: "parent-1",
        sessionModel: { providerID: "minimax", modelID: "MiniMax-M3" },
        payload: basePayload,
      },
    )
    expect(result).toEqual({
      verdict: { fit: "concern", summary: "something feels off but I can't pin it down", gaps: [] },
    })
  })

  it("§4: a gaps array with wrong-shaped items (missing fields) is rejected as malformed", async () => {
    mockRunSubturn.mockResolvedValue({
      ok: true,
      text: JSON.stringify({ fit: "concern", summary: "problems found", gaps: [{ issue: "only an issue, no evidence/fix" }] }),
    })
    const client = makeClient()
    const result = await runJudge(
      client,
      { selfCreated: new SelfCreatedSessions(), logger: vi.fn() },
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

// ===========================================================================
// Judge reply parsing — found by UAT G12.
//
// A real judge run was discarded with `judge:malformed {reason:"response is
// not valid JSON"}`: the plan had completed, the subturn had run, and the
// verdict was thrown away because the model fenced its JSON. A zero-tool agent
// is told to return JSON and usually does, but "usually" is not a contract,
// and each miss costs a full judge budget (up to 90s and a model call).
// ===========================================================================

describe("parseJudgeResponse", () => {
  const verdict = { fit: "pass", notes: "tests cover the change" }

  it("accepts bare JSON", () => {
    expect(parseJudgeResponse(JSON.stringify(verdict))).toEqual(verdict)
  })

  it("accepts fenced JSON, with and without a language tag", () => {
    expect(parseJudgeResponse("```json\n" + JSON.stringify(verdict) + "\n```")).toEqual(verdict)
    expect(parseJudgeResponse("```\n" + JSON.stringify(verdict) + "\n```")).toEqual(verdict)
  })

  it("accepts JSON preceded by prose", () => {
    expect(parseJudgeResponse(`Here is my verdict:\n\n${JSON.stringify(verdict)}`)).toEqual(verdict)
  })

  it("handles braces inside string values", () => {
    const tricky = { fit: "concern", notes: "saw a literal } and { in the diff" }
    expect(parseJudgeResponse(`prose ${JSON.stringify(tricky)} trailing`)).toEqual(tricky)
  })

  it("still returns undefined for a reply with no JSON at all (discrimination)", () => {
    // A genuinely non-JSON reply must remain malformed, not be guessed at.
    expect(parseJudgeResponse("I think this looks fine to me, honestly.")).toBeUndefined()
    expect(parseJudgeResponse("")).toBeUndefined()
  })

  it("does not repair malformed JSON", () => {
    expect(parseJudgeResponse("{fit: pass, notes: unquoted}")).toBeUndefined()
  })
})
