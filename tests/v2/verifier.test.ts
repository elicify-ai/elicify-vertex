import { beforeEach, describe, expect, it, vi } from "vitest"

// ---------------------------------------------------------------------------
// subturn.ts is mocked for the runVerifier suite: probeCapabilityBounded/
// runSubturn are wave-1 infrastructure with their own dedicated coverage in
// tests/v2/subturn.test.ts (including real-timer timeout behavior, and
// probeCapabilityBounded's own probe/deny-map/timeout race). Verifier.ts only
// needs to prove it *drives* that infrastructure correctly (right agent
// name, right model per attempt, shared budget — INCLUDING the probe +
// deny-map step per the CRITICAL fix below, correct classification of the
// result) — mocking lets every scenario here run instantly and
// deterministically instead of racing real timers. SelfCreatedSessions is
// left un-mocked (trivial, no behavior worth stubbing).
//
// CRITICAL fix (post-review): runVerifier used to call subturn.ts's
// probeCapability/buildDenyMap directly, with no timeout, BEFORE starting
// its own VERIFIER_TOTAL_BUDGET_MS clock — a hang in either could block
// runVerifier indefinitely. runVerifier now calls the single bounded helper
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

import { buildVerifierPayload, VERIFIER_TOTAL_BUDGET_MS, runVerifier, parseVerifierResponse, scanProseField } from "../../src/v2/verifier.js"
import { VERIFIER_PROBE_POLICY, probeCapabilityBounded, runSubturn, SelfCreatedSessions } from "../../src/v2/subturn.js"
import {
  DIFF_UNAVAILABLE_GIT_FAILED,
  DIFF_UNAVAILABLE_NOT_A_REPO,
  DIFF_UNAVAILABLE_NO_CHANGES,
  UNTRACKED_FILES_HEADER,
  formatChangedPathsSummary,
} from "../../src/v2/diffstat.js"
import type { OpencodeClient } from "../../src/v2/types.js"

const mockProbeCapabilityBounded = vi.mocked(probeCapabilityBounded)
const mockRunSubturn = vi.mocked(runSubturn)

// HANDOVER.md point 3: the verifier's tool map is no longer a pure deny map —
// the read-only tools (read/grep/glob/list/bash) resolve true, everything
// else false. runVerifier must thread whatever the (mocked) bounded probe
// returns straight into the subturn's `tools` field.
const VERIFIER_TOOLS_MAP = {
  read: true,
  grep: true,
  glob: true,
  list: true,
  bash: true,
  edit: false,
  write: false,
  webfetch: false,
  task: false,
  "*": false,
}

// HANDOVER.md point 4 verdict shape: one story entry, one item entry per
// acceptance item; pass requires every item met.
const PASS_VERDICT = {
  stories: [
    {
      storyId: "S1",
      pass: true,
      summary: "all items observed",
      items: [{ itemId: "A1", met: true, note: "verifier re-run passed" }],
    },
  ],
}

/**
 * FR-006 fixtures: a realistic, secret-free plan digest of an EXACT length,
 * so the measured 7518-char raw digest (spec round-2 finding m-19) and the
 * new cap's +1 boundary can both be exercised as real numbers rather than
 * approximations. Shaped like `renderPlanDigest`'s output (story header,
 * acceptance items, declared verifiers) and deliberately free of any
 * adjacent-line pair whose no-separator join could reach 32 characters — the
 * FR-006a mechanism is tested separately, and must not be smuggled into a
 * cap test.
 */
function makePlanDigestOfLength(totalChars: number): string {
  const lines: string[] = []
  let length = 0
  for (let i = 1; length < totalChars; i++) {
    for (const line of [
      `S${i} (complete): "Story ${i} of the audited plan"`,
      `  - [A1] the deliverable for story ${i} exists on disk`,
      `  - [A2] the deliverable for story ${i} cites its sources`,
      `  verifiers: test -f out/s${i}.md`,
    ]) {
      lines.push(line)
      length += line.length + 1
    }
  }
  return lines.join("\n").slice(0, totalChars)
}

function makeClient(): OpencodeClient {
  return {
    app: { agents: vi.fn() },
    tool: { ids: vi.fn() },
    session: { create: vi.fn(), prompt: vi.fn(), delete: vi.fn() },
  } as unknown as OpencodeClient
}

beforeEach(() => {
  vi.clearAllMocks()
  mockProbeCapabilityBounded.mockResolvedValue({ ok: true, tools: VERIFIER_TOOLS_MAP })
  mockRunSubturn.mockResolvedValue({ ok: true, text: JSON.stringify(PASS_VERDICT) })
})

// ===========================================================================
// buildVerifierPayload — test 18 (verifier_payload_evidence_only), test 39
// (verifier_payload_secret_scan), Dataset: Verifier payload hygiene (all 9 rows)
// ===========================================================================

describe("buildVerifierPayload", () => {
  it("row 1 / test 18: clean criteria + diff summary + verifier summary transmit unchanged", () => {
    const logger = vi.fn()
    const raw = {
      criteria: ["Handles empty input", "Returns a sorted list"],
      diffSummary: ["@@ -1,2 +1,2 @@", "-const sorted = input", "+const sorted = input.sort()"].join("\n"),
      verifierSummaries: ["3 passed, 0 failed"],
      lastResponse: "",
      recentTranscript: "", plan: "",
    }
    const payload = buildVerifierPayload(raw, logger)
    expect(payload).toEqual({
      criteria: raw.criteria,
      diffSummary: raw.diffSummary,
      verifierSummaries: raw.verifierSummaries,
    })
    expect(logger).not.toHaveBeenCalled()
  })

  it("row 2 / test 18: payload has no free-form narrative field to leak NARRATIVE_CANARY through — schema excludes it structurally", () => {
    const logger = vi.fn()
    // buildVerifierPayload's signature accepts only the five named fields — there
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
      recentTranscript: "", plan: "",
    }
    const payload = buildVerifierPayload(raw, logger)
    expect(JSON.stringify(payload)).not.toContain("NARRATIVE_CANARY")
    expect(
      Object.keys(payload).every((k) =>
        ["criteria", "diffSummary", "verifierSummaries", "lastResponse", "recentTranscript", "plan"].includes(k),
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
      recentTranscript: "", plan: "",
    }
    const payload = buildVerifierPayload(raw, logger)
    expect(payload.diffSummary).toBe(cleanHunk)
    expect(payload.diffSummary).not.toContain("sk-live")
    // field not emptied — no field-dropped, but one of the two hunks WAS
    // dropped, so the partial-drop event (added post-review — see the
    // verifier:field-partial-drop tests below) must fire instead of nothing.
    expect(logger).toHaveBeenCalledTimes(1)
    expect(logger).toHaveBeenCalledWith("verifier:field-partial-drop", { field: "diffSummary", kept: 1, dropped: 1 })
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
    const raw = { criteria: [], diffSummary: hunkWithSplitSecret, verifierSummaries: [], lastResponse: "", recentTranscript: "", plan: "" }
    const payload = buildVerifierPayload(raw, logger)
    expect(payload.diffSummary).toBeUndefined()
    expect(logger).toHaveBeenCalledWith("verifier:field-dropped", { field: "diffSummary" })
  })

  it("row 5 / test 39: unlabelled 40-char hex token trips the entropy rule (redactSecrets alone misses it)", () => {
    const logger = vi.fn()
    const hexToken = "4702a3465c59e203612b5411f9dc37870f86aebd" // 40 chars, near-max hex entropy (~3.971 bits/char)
    const raw = {
      criteria: [],
      diffSummary: "",
      verifierSummaries: [`build hash ${hexToken} recorded`, "5 passed, 0 failed"],
      lastResponse: "",
      recentTranscript: "", plan: "",
    }
    const payload = buildVerifierPayload(raw, logger)
    expect(payload.verifierSummaries).toEqual(["5 passed, 0 failed"])
    // field not emptied (second line survives), but the first line WAS
    // dropped — partial-drop event fires instead of silence.
    expect(logger).toHaveBeenCalledTimes(1)
    expect(logger).toHaveBeenCalledWith("verifier:field-partial-drop", { field: "verifierSummaries", kept: 1, dropped: 1 })
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
      recentTranscript: "", plan: "",
    }
    const payload = buildVerifierPayload(raw, logger)
    expect(payload.verifierSummaries).toEqual(["2 passed, 0 failed"])
    // field not emptied — one surviving line, but both wrapped lines were
    // dropped as a pair — partial-drop event fires instead of silence.
    expect(logger).toHaveBeenCalledTimes(1)
    expect(logger).toHaveBeenCalledWith("verifier:field-partial-drop", { field: "verifierSummaries", kept: 1, dropped: 2 })
  })

  it("row 7 / test 39: 200-char base64 blob in a criteria line is removed; emptying the field logs verifier:field-dropped", () => {
    const logger = vi.fn()
    const base64Blob = Buffer.from(Array.from({ length: 150 }, (_, i) => (i * 37 + 13) % 256)).toString(
      "base64",
    ).slice(0, 200)
    const raw = {
      criteria: [`payload: ${base64Blob}`],
      diffSummary: "",
      verifierSummaries: [],
      lastResponse: "",
      recentTranscript: "", plan: "",
    }
    const payload = buildVerifierPayload(raw, logger)
    expect(payload.criteria).toBeUndefined()
    expect(logger).toHaveBeenCalledWith("verifier:field-dropped", { field: "criteria" })
  })

  it("row 8 / test 39: an oversized clean verifier summary is truncated to the field cap after scanning (C-9: scan-then-truncate)", () => {
    const logger = vi.fn()
    const longClean = "ok ".repeat(1334) // ~4002 chars, well past the 2000-char field cap, no secrets
    const raw = { criteria: [], diffSummary: "", verifierSummaries: [longClean], lastResponse: "", recentTranscript: "", plan: "" }
    const payload = buildVerifierPayload(raw, logger)
    expect(payload.verifierSummaries).toBeDefined()
    const survivingLength = payload.verifierSummaries!.join("\n").length
    expect(survivingLength).toBeLessThanOrEqual(2000)
    expect(survivingLength).toBeLessThan(longClean.length)
    // MINOR fix (post-review): truncation is no longer silent — a
    // verifier:field-truncated event records that this field was cut, even
    // though it survives non-empty (never a verifier:field-dropped, since the
    // field is not emptied). Nothing tripped the scan here, so the
    // post-scan length truncateField sees is identical to the raw length.
    expect(logger).toHaveBeenCalledTimes(1)
    expect(logger).toHaveBeenCalledWith("verifier:field-truncated", {
      field: "verifierSummaries",
      originalLength: longClean.length,
      cap: 2000,
      keep: "head",
    })
    logger.mockClear()

    // C-9 fix (docs/CODE-ISSUES-FROM-PROMPT-AUDIT.md — "boundary-truncation
    // fragment leak"): a secret positioned past where the OLD truncate-first
    // cap used to cut is now still caught. Under the old truncate-then-scan
    // order this secret sat beyond the 2000-char cut point, was sliced away
    // before the scan ever ran, and buildVerifierPayload never saw it at all —
    // the field only "survived" because the secret had already been
    // silently discarded, not because it was safe. Now the FULL field
    // (including everything past the old cut point) is scanned first, the
    // unit containing the secret trips, and the field is correctly dropped
    // in full — never truncated, since nothing survives scanning to
    // truncate (verifier:field-truncated and verifier:field-dropped are mutually
    // exclusive per field; see truncateField's doc comment).
    const secretPastOldBoundary = "x".repeat(2500) + " sk-live-abc123def456ghi789jkl012mno345pqr"
    const raw2 = {
      criteria: [],
      diffSummary: "",
      verifierSummaries: [secretPastOldBoundary],
      lastResponse: "",
      recentTranscript: "", plan: "",
    }
    const payload2 = buildVerifierPayload(raw2, logger)
    expect(payload2.verifierSummaries).toBeUndefined()
    expect(logger).toHaveBeenCalledTimes(1)
    expect(logger).toHaveBeenCalledWith("verifier:field-dropped", { field: "verifierSummaries" })
    expect(logger).not.toHaveBeenCalledWith("verifier:field-truncated", expect.anything())
  })

  it("fix #5: a field within the cap is NOT reported as truncated", () => {
    const logger = vi.fn()
    const raw = {
      criteria: ["short criterion"],
      diffSummary: "",
      verifierSummaries: ["short summary"],
      lastResponse: "",
      recentTranscript: "", plan: "",
    }
    buildVerifierPayload(raw, logger)
    expect(logger).not.toHaveBeenCalled()
  })

  it("fix #5 (updated for C-9 scan-then-truncate order): a single-unit field containing a secret is dropped in full, never also reported as truncated — verifier:field-dropped and verifier:field-truncated are mutually exclusive per field", () => {
    const logger = vi.fn()
    // Under the OLD truncate-then-scan order this exact input used to log
    // BOTH events (truncated to the cap, then the surviving truncated text
    // still contained the secret so it was also fully dropped). Under the
    // NEW scan-then-truncate order, scanning runs first on the whole field:
    // since this field is a single unit (no newlines) and that unit
    // contains the secret, the WHOLE unit is dropped immediately — there is
    // nothing left to truncate, so verifier:field-truncated no longer fires
    // for this case at all.
    const secretText = 'const key = "sk-live-abc123def456ghi789jkl012mno345pqr" ' + "x".repeat(3000)
    const raw = { criteria: [], diffSummary: "", verifierSummaries: [secretText], lastResponse: "", recentTranscript: "", plan: "" }
    const payload = buildVerifierPayload(raw, logger)
    expect(payload.verifierSummaries).toBeUndefined()
    expect(logger).toHaveBeenCalledTimes(1)
    expect(logger).toHaveBeenCalledWith("verifier:field-dropped", { field: "verifierSummaries" })
    expect(logger).not.toHaveBeenCalledWith("verifier:field-truncated", expect.anything())
  })

  it("C-9 (multi-unit): a field that loses a tainted line to scanning AND remains oversized afterward logs BOTH verifier:field-partial-drop and verifier:field-truncated", () => {
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
      recentTranscript: "", plan: "",
    }
    const payload = buildVerifierPayload(raw, logger)
    expect(payload.verifierSummaries).toBeDefined()
    expect(payload.verifierSummaries!.join("\n")).not.toContain("sk-live")
    expect(logger).toHaveBeenCalledWith("verifier:field-partial-drop", { field: "verifierSummaries", kept: 1, dropped: 1 })
    expect(logger).toHaveBeenCalledWith("verifier:field-truncated", {
      field: "verifierSummaries",
      originalLength: longCleanLine.length,
      cap: 2000,
      keep: "head",
    })
    expect(logger).not.toHaveBeenCalledWith("verifier:field-dropped", expect.anything())
  })

  it("C-9: a 40-char JWT-shaped secret straddling the field's truncation-cap boundary is fully caught, not left as a leaking fragment (redact-then-truncate ordering)", () => {
    const logger = vi.fn()
    const CAP = 2000 // VERIFIER_PAYLOAD_FIELD_CHAR_CAP
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

    const raw = { criteria: [], diffSummary: "", verifierSummaries: [text], lastResponse: "", recentTranscript: "", plan: "" }
    const payload = buildVerifierPayload(raw, logger)

    // Redact-then-truncate: the scan sees the WHOLE field — including
    // everything past where the old cap used to cut — before any truncation
    // happens, so the full jwt is visible to the JWT pattern and the unit
    // containing it is dropped in its entirety. Nothing survives to leak.
    expect(payload.verifierSummaries).toBeUndefined()
    expect(logger).toHaveBeenCalledTimes(1)
    expect(logger).toHaveBeenCalledWith("verifier:field-dropped", { field: "verifierSummaries" })
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
      plan: "",
    }
    const payload = buildVerifierPayload(raw, logger)
    expect(payload.recentTranscript).toBeUndefined()
    expect(logger).toHaveBeenCalledWith("verifier:field-dropped", { field: "recentTranscript" })
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
      recentTranscript: "", plan: "",
    }
    const payload = buildVerifierPayload(raw, logger)
    expect(payload.lastResponse).toBeUndefined()
    expect(logger).toHaveBeenCalledWith("verifier:field-dropped", { field: "lastResponse" })
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
      recentTranscript: "", plan: "",
    }
    const payload = buildVerifierPayload(raw, logger)
    expect(payload.verifierSummaries).toBeUndefined()
    expect(logger).toHaveBeenCalledWith("verifier:field-dropped", { field: "verifierSummaries" })
  })

  it("C-15: a dictionary-word passphrase embedded in prose is NOT caught — documented, accepted residual risk (no reliable local heuristic)", () => {
    const logger = vi.fn()
    // Pins current (accepted) behavior: this measures similarly low entropy
    // to ordinary English (repeated common letters from real dictionary
    // words) and is not a pure-hex run, so neither backstop trips. A fix
    // attempt here would need to distinguish this from ordinary prose, which
    // risks reopening C-8's false-positive problem.
    const text = "she pasted the password hunter2CorrectHorseBatteryStaple99 in the chat by mistake"
    const raw = { criteria: [], diffSummary: "", verifierSummaries: [], lastResponse: text, recentTranscript: "", plan: "" }
    const payload = buildVerifierPayload(raw, logger)
    expect(payload.lastResponse).toBe(text)
    expect(logger).not.toHaveBeenCalled()
  })

  it("C-15: an oversized raw field is dropped whole, before scanning, rather than scanned in full every time (cost bound)", () => {
    const logger = vi.fn()
    // VERIFIER_PAYLOAD_RAW_FIELD_SAFETY_CAP is 100_000 — well past any
    // realistic evidence field, so a field this large is treated as
    // pathological and dropped whole rather than paying the full scan cost.
    const oversized = "x".repeat(100_001)
    const raw = { criteria: [], diffSummary: "", verifierSummaries: [], lastResponse: oversized, recentTranscript: "", plan: "" }
    const payload = buildVerifierPayload(raw, logger)
    expect(payload.lastResponse).toBeUndefined()
    expect(logger).toHaveBeenCalledWith("verifier:field-oversized", {
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
      recentTranscript: "", plan: "",
    }
    const payload = buildVerifierPayload(raw, logger)
    expect(payload.verifierSummaries).toEqual([`analysis: ${prose} completed cleanly`])
    expect(logger).not.toHaveBeenCalled()
  })

  it("empty raw fields are omitted (not present as empty array/string) without logging field-dropped", () => {
    const logger = vi.fn()
    const payload = buildVerifierPayload(
      { criteria: [], diffSummary: "", verifierSummaries: [], lastResponse: "", recentTranscript: "", plan: "" },
      logger,
    )
    expect(payload).toEqual({})
    expect(logger).not.toHaveBeenCalled()
  })

  it("dropping one criteria line among several logs verifier:field-partial-drop, not silence", () => {
    const logger = vi.fn()
    const raw = {
      criteria: ["clean criterion one", "sk-live-abc123def456ghi789jkl012mno345pqr leaked here", "clean criterion two"],
      diffSummary: "",
      verifierSummaries: [],
      lastResponse: "",
      recentTranscript: "", plan: "",
    }
    const payload = buildVerifierPayload(raw, logger)
    expect(payload.criteria).toEqual(["clean criterion one", "clean criterion two"])
    // one of three lines dropped, field survives — partial-drop event fires
    // instead of silence (was the silent gap this test used to assert).
    expect(logger).toHaveBeenCalledTimes(1)
    expect(logger).toHaveBeenCalledWith("verifier:field-partial-drop", { field: "criteria", kept: 2, dropped: 1 })
  })

  // =========================================================================
  // docs/VERIFIER-PROMPT.md §5 — lastResponse/recentTranscript go through the
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
      plan: "",
    }
    const payload = buildVerifierPayload(raw, logger)
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
      recentTranscript: "", plan: "",
    }
    const payload = buildVerifierPayload(raw, logger)
    expect(payload.lastResponse).toBeUndefined()
    expect(JSON.stringify(payload)).not.toContain(secret)
    expect(logger).toHaveBeenCalledWith("verifier:field-dropped", { field: "lastResponse" })
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
      plan: "",
    }
    const payload = buildVerifierPayload(raw, logger)
    expect(payload.recentTranscript).toBeUndefined()
    expect(JSON.stringify(payload)).not.toContain(secret)
    expect(logger).toHaveBeenCalledWith("verifier:field-dropped", { field: "recentTranscript" })
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
      plan: "",
    }
    const payload = buildVerifierPayload(raw, logger)
    expect(payload.recentTranscript).toBeDefined()
    expect(payload.recentTranscript).not.toContain(secret)
    expect(payload.recentTranscript).toContain("all tests pass")
    // field survived non-empty — no field-dropped, but partial-drop fires
    // (one of three lines was removed).
    expect(logger).toHaveBeenCalledTimes(1)
    expect(logger).toHaveBeenCalledWith("verifier:field-partial-drop", { field: "recentTranscript", kept: 2, dropped: 1 })
  })

  it("§5: recentTranscript is truncated to its own 16000-char cap (B-3a raised it from 4000), not VERIFIER_PAYLOAD_FIELD_CHAR_CAP", () => {
    const logger = vi.fn()
    const longClean = "assistant: ok ".repeat(1600) // well past 16000 chars, no secrets
    const raw = {
      criteria: [],
      diffSummary: "",
      verifierSummaries: [],
      lastResponse: "",
      recentTranscript: longClean,
      plan: "",
    }
    const payload = buildVerifierPayload(raw, logger)
    expect(payload.recentTranscript).toBeDefined()
    expect(payload.recentTranscript!.length).toBeLessThanOrEqual(16000)
    expect(logger).toHaveBeenCalledWith("verifier:field-truncated", {
      field: "recentTranscript",
      originalLength: longClean.length,
      cap: 16000,
      keep: "tail",
    })
  })

  // =========================================================================
  // B-3a — WHICH END SURVIVES. Every other truncation test here asserts a
  // LENGTH, and a length is satisfied by cutting either end, so none of them
  // could see that chronological fields were being cut backwards. Measured on
  // a live session: a 5923-char transcript was cut to its first 4000, so the
  // verifier read the opening of the session and never saw the most recent
  // messages — the ones describing the work it was judging.
  //
  // Operator ruling, 2026-08-06: "cut at the top not the bottom — the last
  // messages are the relevant ones."
  // =========================================================================
  it("keeps the END of recentTranscript and discards the beginning", () => {
    const logger = vi.fn()
    // Distinguishable ends: only one of them can survive a cut.
    const opening = "OPENING_OF_SESSION "
    const filler = "middle chatter ".repeat(1600) // pushes well past the 16000 cap
    const closing = " CLOSING_OF_SESSION"
    const raw = {
      criteria: [],
      diffSummary: "",
      verifierSummaries: [],
      lastResponse: "",
      recentTranscript: opening + filler + closing,
      plan: "",
    }
    const kept = buildVerifierPayload(raw, logger).recentTranscript!
    expect(kept.endsWith(closing), "the most recent text must survive").toBe(true)
    expect(kept.includes(opening), "the oldest text is what gets dropped").toBe(false)
    expect(kept.length, "the cap still binds, marker included").toBeLessThanOrEqual(16000)
    expect(kept.startsWith("…["), "a tail cut must announce itself, or the verifier reads a fragment as a whole").toBe(true)
  })

  it("keeps the END of lastResponse — its conclusion is at the bottom", () => {
    const logger = vi.fn()
    const raw = {
      criteria: [],
      diffSummary: "",
      verifierSummaries: [],
      lastResponse: "FIRST_LINE " + "padding ".repeat(500) + " FINAL_VERDICT",
      recentTranscript: "",
      plan: "",
    }
    const kept = buildVerifierPayload(raw, logger).lastResponse!
    expect(kept.endsWith("FINAL_VERDICT")).toBe(true)
    expect(kept.includes("FIRST_LINE")).toBe(false)
  })

  // The direction is PER FIELD, not global. `plan` is front-loaded — its
  // opening carries the story list — so it keeps its head. Flipping all five
  // fields would have been wrong in the other direction.
  it("keeps the START of plan", () => {
    const logger = vi.fn()
    const raw = {
      criteria: [],
      diffSummary: "",
      verifierSummaries: [],
      lastResponse: "",
      recentTranscript: "",
      plan: "PLAN_HEADER " + "story line ".repeat(2000) + " PLAN_FOOTER",
    }
    const kept = buildVerifierPayload(raw, logger).plan!
    expect(kept.startsWith("PLAN_HEADER"), "a front-loaded field keeps its head").toBe(true)
    expect(kept.includes("PLAN_FOOTER")).toBe(false)
  })

  // =========================================================================
  // B-3d — the tail cut must respect the cap at EVERY cap, including the ones
  // no field uses today.
  //
  // `truncateField` computed `room = Math.max(0, cap - MARKER.length)`. At any
  // cap at or below the marker's own 28 characters that clamps to zero and the
  // function returned the MARKER ALONE: 28 characters for a cap of 1 — over
  // the cap, with 100% of the content dropped, and still a non-empty, defined
  // field, so nothing downstream (not the insufficient-evidence guard, not the
  // judge) could tell it was reading a label instead of evidence. Latent under
  // today's 2000/4000/16000 caps and reachable the moment anyone adds a small
  // one; a bound that inverts below 28 is a trap, so it is closed rather than
  // documented. `scanProseField` takes its cap as an argument, which is what
  // makes this directly testable.
  // =========================================================================
  it("B-3d: a tail cut below the marker's own length ships CONTENT within the cap, never the marker alone", () => {
    // Ordinary prose, no token anywhere near the 32-char entropy floor: this
    // test is about the cap arithmetic, and a field the scan drops would prove
    // nothing about it.
    const text = "the run began quietly and then the newest words arrived right at the very end HERE"
    for (const cap of [1, 5, 27, 28]) {
      const logger = vi.fn()
      const out = scanProseField(text, "recentTranscript", logger, cap)!
      expect(out, `cap=${cap}: something must survive`).toBeDefined()
      expect(out.length, `cap=${cap}: the cap must bind`).toBeLessThanOrEqual(cap)
      expect(out, `cap=${cap}: must be real content, not the marker`).toBe(text.slice(text.length - cap))
      expect(logger, `cap=${cap}: the cut is still announced in the log`).toHaveBeenCalledWith("verifier:field-truncated", {
        field: "recentTranscript",
        originalLength: text.length,
        cap,
        keep: "tail",
      })
    }
  })

  it("B-3d: a cap of 0 omits the field entirely rather than emitting the whole text", () => {
    // `text.slice(-0)` is `text.slice(0)` — the WHOLE string. The zero case
    // has to be handled explicitly or the "fix" leaks the entire field.
    const out = scanProseField("secretish content here", "recentTranscript", vi.fn(), 0)
    expect(out).toBeUndefined()
  })

  it("B-3d: at a cap with room for both, the marker is still emitted and still inside the budget", () => {
    // The property the fix must not break: above the marker's length the
    // marker is part of the budget, not added on top of it.
    const text = "x".repeat(500) + "TAIL"
    const out = scanProseField(text, "recentTranscript", vi.fn(), 40)!
    expect(out.startsWith("…[")).toBe(true)
    expect(out.endsWith("TAIL")).toBe(true)
    expect(out.length).toBeLessThanOrEqual(40)
  })

  it("§5: lastResponse over 2000 chars is truncated at the SAME cap as the other fields", () => {
    const logger = vi.fn()
    const longClean = "ok ".repeat(1000) // 3000 chars, past the 2000-char cap
    const raw = {
      criteria: [],
      diffSummary: "",
      verifierSummaries: [],
      lastResponse: longClean,
      recentTranscript: "", plan: "",
    }
    const payload = buildVerifierPayload(raw, logger)
    expect(payload.lastResponse).toBeDefined()
    expect(payload.lastResponse!.length).toBeLessThanOrEqual(2000)
    expect(logger).toHaveBeenCalledWith("verifier:field-truncated", {
      field: "lastResponse",
      originalLength: longClean.length,
      cap: 2000,
      keep: "tail",
    })
  })

  it("§5: empty lastResponse/recentTranscript are omitted, same as the other empty fields", () => {
    const logger = vi.fn()
    const payload = buildVerifierPayload(
      { criteria: [], diffSummary: "", verifierSummaries: [], lastResponse: "", recentTranscript: "", plan: "" },
      logger,
    )
    expect(payload).toEqual({})
    expect(logger).not.toHaveBeenCalled()
  })

  // =========================================================================
  // HANDOVER.md point 4 — the `plan` field (rendered plan digest: stories,
  // statuses, acceptance items, declared verifiers) goes through the SAME
  // scan-then-truncate pipeline as recentTranscript, with its own 4000 cap.
  // =========================================================================

  it("point 4: a clean plan digest transmits unchanged", () => {
    const logger = vi.fn()
    const planDigest = [
      "S1 [claimed-complete] Build the trace model",
      "  A1: NormalizedTrace exists with fields X/Y/Z",
      "  verifiers: make check",
      "S2 [claimed-complete] Wire the CLI",
      "  A1: cli --help exits 0",
    ].join("\n")
    const raw = { criteria: [], diffSummary: "", verifierSummaries: [], lastResponse: "", recentTranscript: "", plan: planDigest }
    const payload = buildVerifierPayload(raw, logger)
    expect(payload.plan).toBe(planDigest)
    expect(logger).not.toHaveBeenCalled()
  })

  it("point 4: a secret embedded in the plan field is dropped exactly like one embedded in recentTranscript", () => {
    const logger = vi.fn()
    const secret = "sk-live-abc123def456ghi789jkl012mno345pqr"
    const raw = {
      criteria: [],
      diffSummary: "",
      verifierSummaries: [],
      lastResponse: "",
      recentTranscript: "",
      // Single line (no other lines to survive independently) so the whole
      // field is emptied by the scan — the direct analogue of the §5
      // recentTranscript single-line secret test.
      plan: `S1 [claimed-complete] deploy — A1: service live with key ${secret}`,
    }
    const payload = buildVerifierPayload(raw, logger)
    expect(payload.plan).toBeUndefined()
    expect(JSON.stringify(payload)).not.toContain(secret)
    expect(logger).toHaveBeenCalledWith("verifier:field-dropped", { field: "plan" })
  })

  it("point 4 / FR-006: an oversized clean plan is truncated to its own 16000-char cap (C-9 scan-then-truncate), not the 2000 field cap", () => {
    const logger = vi.fn()
    // Cap raised 4000 -> 16000 by FR-006 (measured raw digest = 7518 chars),
    // so the oversize fixture is re-sized to stay ABOVE the cap: this test's
    // subject is "the plan field has its OWN, larger cap", not the number.
    const longPlan = "story line ok\n".repeat(1400) // 19600 chars, past 16000, no secrets
    const raw = { criteria: [], diffSummary: "", verifierSummaries: [], lastResponse: "", recentTranscript: "", plan: longPlan }
    const payload = buildVerifierPayload(raw, logger)
    expect(payload.plan).toBeDefined()
    expect(payload.plan!.length).toBeLessThanOrEqual(16000)
    expect(payload.plan!.length).toBeGreaterThan(4000) // proves neither the 2000 field cap nor the old 4000 plan cap was applied
    expect(logger).toHaveBeenCalledWith("verifier:field-truncated", {
      field: "plan",
      originalLength: longPlan.length,
      cap: 16000,
      keep: "head",
    })
  })

  // =========================================================================
  // FR-006 / FR-006a — docs/VERIFIER-RELIABILITY-FIXES-SPEC.md, User Story 6.
  //
  // Both requirements exist because of ONE observed production failure mode:
  // the verifier FAILing delivered stories while citing the very plan content
  // the payload pipeline had silently removed before it ever saw it
  // ("the verifier command is incomplete in the digest", "S5 has no
  // independent verifier set in the digest"). Two independent mechanisms did
  // the removing — the 4000-char cap (11 `verifier:field-truncated`) and the
  // no-separator adjacent-pair join (11 `verifier:field-partial-drop`) — so
  // there are two sets of tests.
  // =========================================================================

  it("FR-006a / SC-006b: two clean plan-digest lines whose no-separator join manufactures a high-entropy token are BOTH KEPT", () => {
    const logger = vi.fn()
    // The REAL reproduced pair (spec round-2 finding M-10). Joined with no
    // separator these fuse into `research/space-exploration.jsonS2` — 33
    // chars, 4.044 bits/char, over the 3.95 effective entropy threshold —
    // while NEITHER line trips anything on its own (the path token alone is
    // 31 chars, under ENTROPY_MIN_TOKEN_LENGTH, and measures 3.889). Before
    // FR-006a both lines were dropped, which is exactly how S1/S2/S3 lost
    // their `verifiers:` lines 11 times in the audited session.
    const verifiersLine =
      "  verifiers: test -f research/space-exploration.json && jq -e '.kpis | length >= 3' research/space-exploration.json"
    const nextStoryLine = 'S2 (active): "Research Wave B — space exploration briefing"'
    const planDigest = ["S1 (complete): \"Research Wave A\"", verifiersLine, nextStoryLine].join("\n")

    const raw = { criteria: [], diffSummary: "", verifierSummaries: [], lastResponse: "", recentTranscript: "", plan: planDigest }
    const payload = buildVerifierPayload(raw, logger)

    expect(payload.plan).toBe(planDigest)
    expect(payload.plan).toContain(verifiersLine)
    expect(payload.plan).toContain(nextStoryLine)
    expect(logger).not.toHaveBeenCalledWith("verifier:field-partial-drop", expect.anything())
    expect(logger).not.toHaveBeenCalled()
  })

  it("FR-006a: the same manufactured-token pair is kept in every scanned field, not just `plan` (no per-field exemption)", () => {
    // FR-006a forbids fixing this by exempting the plan digest (that would
    // contradict US6 AS3 — a secret in the digest must still be redacted), so
    // the fix lives in scanUnits and must be observable through the line
    // fields and the prose fields alike.
    const a = "  verifiers: jq -e '.kpis | length >= 3' research/space-exploration.json"
    const b = 'S2 (active): "Research Wave B"'

    const lineLogger = vi.fn()
    const linePayload = buildVerifierPayload(
      { criteria: [a, b], diffSummary: "", verifierSummaries: [a, b], lastResponse: "", recentTranscript: "", plan: "" },
      lineLogger,
    )
    expect(linePayload.criteria).toEqual([a, b])
    expect(linePayload.verifierSummaries).toEqual([a, b])

    const proseLogger = vi.fn()
    const prosePayload = buildVerifierPayload(
      {
        criteria: [],
        diffSummary: "",
        verifierSummaries: [],
        lastResponse: [a, b].join("\n"),
        recentTranscript: [a, b].join("\n"),
        plan: "",
      },
      proseLogger,
    )
    expect(prosePayload.lastResponse).toBe([a, b].join("\n"))
    expect(prosePayload.recentTranscript).toBe([a, b].join("\n"))

    expect(lineLogger).not.toHaveBeenCalled()
    expect(proseLogger).not.toHaveBeenCalled()
  })

  it("FR-006a regression (C-9 MUST still hold): a pattern-shaped secret genuinely wrapped across two plan lines is still dropped as a pair", () => {
    const logger = vi.fn()
    // The straddling case: the connection string is one token that a hard
    // line break bisected. Neither half trips alone; the reassembled match
    // crosses the join, so the pair MUST still be dropped.
    const raw = {
      criteria: [],
      diffSummary: "",
      verifierSummaries: [],
      lastResponse: "",
      recentTranscript: "",
      plan: ["S1 (complete): deploy", "  verifiers: psql postgres://user:sec", 'retpass@dbhost:5432/mydb -c "select 1"'].join("\n"),
    }
    const payload = buildVerifierPayload(raw, logger)
    expect(payload.plan).toBe("S1 (complete): deploy")
    expect(payload.plan).not.toContain("retpass")
    expect(logger).toHaveBeenCalledWith("verifier:field-partial-drop", { field: "plan", kept: 1, dropped: 2 })
  })

  it("FR-006a regression (C-9 MUST still hold): a hex secret wrapped across two lines is still dropped as a pair", () => {
    const logger = vi.fn()
    // 40-char hex run split 20/20 — under the 32-char minimum on each side,
    // so it is invisible to the per-unit scan and only the join can catch it.
    const raw = {
      criteria: ["build hash 4702a3465c59e203", "612b5411f9dc37870f86aebd recorded", "3 passed, 0 failed"],
      diffSummary: "",
      verifierSummaries: [],
      lastResponse: "",
      recentTranscript: "",
      plan: "",
    }
    const payload = buildVerifierPayload(raw, logger)
    expect(payload.criteria).toEqual(["3 passed, 0 failed"])
    expect(logger).toHaveBeenCalledWith("verifier:field-partial-drop", { field: "criteria", kept: 1, dropped: 2 })
  })

  it("FR-006a regression (C-9 MUST still hold): an entropy-only secret wrapped across two lines is still dropped as a pair", () => {
    const logger = vi.fn()
    // Neither a SECRET_PATTERNS shape nor a hex run: a 40-char mixed-alphabet
    // token split 20/20. Only the entropy rule can catch it, and only across
    // the join — this is the case FR-006a's fragment bar must NOT sacrifice
    // while it protects the digest lines above (each side contributes 20
    // chars, far over ENTROPY_PAIR_MIN_FRAGMENT_CHARS).
    const raw = {
      criteria: [],
      diffSummary: "",
      verifierSummaries: [],
      lastResponse: "",
      recentTranscript: ["assistant: the deploy token is kJ8vQz3XmR7wLp2NcT9y", "Bf4HdG6sVe1AoZ5rUiWx and it worked", "user: thanks"].join("\n"),
      plan: "",
    }
    const payload = buildVerifierPayload(raw, logger)
    expect(payload.recentTranscript).toBe("user: thanks")
    expect(payload.recentTranscript).not.toContain("kJ8vQz3XmR7wLp2NcT9y")
    expect(logger).toHaveBeenCalledWith("verifier:field-partial-drop", { field: "recentTranscript", kept: 1, dropped: 2 })
  })

  it("FR-006 / SC-006: the measured 7518-char raw plan digest transmits whole — no truncation, no partial drop", () => {
    const logger = vi.fn()
    // Dataset: Plan digest row 1 — the measured RAW digest of the audited
    // 6-story plan (spec round-2 finding m-19; the originalLength 6411-6425
    // seen in the session's events is the POST-scan number). Under the old
    // 4000-char cap this fired verifier:field-truncated on all 9 audit runs.
    const planDigest = makePlanDigestOfLength(7518)
    expect(planDigest.length).toBe(7518)

    const raw = { criteria: [], diffSummary: "", verifierSummaries: [], lastResponse: "", recentTranscript: "", plan: planDigest }
    const payload = buildVerifierPayload(raw, logger)

    expect(payload.plan).toBe(planDigest)
    expect(logger).not.toHaveBeenCalledWith("verifier:field-truncated", expect.anything())
    expect(logger).not.toHaveBeenCalledWith("verifier:field-partial-drop", expect.anything())
    expect(logger).not.toHaveBeenCalled()
  })

  it("FR-006 / US6 AS2: a digest above the raised cap is STILL truncated and STILL logged (the bound is raised, not removed)", () => {
    const logger = vi.fn()
    const planDigest = makePlanDigestOfLength(16001) // new cap + 1
    const raw = { criteria: [], diffSummary: "", verifierSummaries: [], lastResponse: "", recentTranscript: "", plan: planDigest }
    const payload = buildVerifierPayload(raw, logger)

    expect(payload.plan!.length).toBe(16000)
    expect(logger).toHaveBeenCalledWith("verifier:field-truncated", { field: "plan", originalLength: 16001, cap: 16000,
      keep: "head",
    })
  })

  it("FR-006 / US6 AS3: raising the cap does not weaken redaction — a secret past the OLD 4000-char cap is still dropped", () => {
    const logger = vi.fn()
    // Pre-C-9 (truncate-then-scan) this secret would never have been scanned
    // at all; post-C-9 with a 4000 cap it was scanned then cut. With the
    // 16000 cap it is scanned AND transmitted-adjacent, so the scan is the
    // only thing standing between it and the verifier. It must still drop.
    const secret = "sk-live-abc123def456ghi789jkl012mno345pqr"
    const planDigest = `${makePlanDigestOfLength(6000)}\n  A9: deployed with key ${secret}`
    const raw = { criteria: [], diffSummary: "", verifierSummaries: [], lastResponse: "", recentTranscript: "", plan: planDigest }
    const payload = buildVerifierPayload(raw, logger)

    expect(payload.plan).toBeDefined()
    expect(payload.plan).not.toContain(secret)
    expect(JSON.stringify(payload)).not.toContain("sk-live")
    expect(logger).toHaveBeenCalledWith("verifier:field-partial-drop", { field: "plan", kept: expect.any(Number), dropped: 1 })
  })
})

// ===========================================================================
// verifier:field-partial-drop — post-review fix. `verifier:field-dropped` already
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

describe("verifier:field-partial-drop", () => {
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
      plan: "",
    }
    const payload = buildVerifierPayload(raw, logger)
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
      plan: "",
    }
    const payload = buildVerifierPayload(raw, logger)

    // The line with the secret is gone, but the field survives non-empty.
    expect(payload.recentTranscript).toBeDefined()
    expect(payload.recentTranscript).not.toContain(secret)
    expect(payload.recentTranscript).toContain("user: please wrap up")
    expect(payload.recentTranscript).toContain("assistant: all tests pass")

    // The fix under test: a partial drop is now observable, distinguishing
    // "never said" from "said and silently removed" — and full-empty
    // verifier:field-dropped must NOT fire, since the field is not empty.
    expect(logger).toHaveBeenCalledWith("verifier:field-partial-drop", {
      field: "recentTranscript",
      kept: 2,
      dropped: 1,
    })
    expect(logger).not.toHaveBeenCalledWith("verifier:field-dropped", expect.anything())
  })

  it("does NOT fire on a fully clean multi-line field (nothing dropped)", () => {
    const logger = vi.fn()
    const raw = {
      criteria: ["clean one", "clean two", "clean three"],
      diffSummary: "@@ -1,1 +1,1 @@\n-old\n+new",
      verifierSummaries: ["all good"],
      lastResponse: "everything looks fine",
      recentTranscript: "user: go\nassistant: done, all clean",
      plan: "",
    }
    const payload = buildVerifierPayload(raw, logger)
    expect(payload.criteria).toEqual(raw.criteria)
    expect(logger).not.toHaveBeenCalledWith("verifier:field-partial-drop", expect.anything())
    expect(logger).not.toHaveBeenCalled()
  })

  it("does NOT fire when a field is dropped in full (that stays verifier:field-dropped only, per field)", () => {
    const logger = vi.fn()
    const secret = "sk-live-abc123def456ghi789jkl012mno345pqr"
    // Single-line field: the only unit is dropped -> the field is fully
    // empty, not partial. verifier:field-dropped alone must fire.
    const raw = {
      criteria: [],
      diffSummary: "",
      verifierSummaries: [],
      lastResponse: `the key I used is ${secret}`,
      recentTranscript: "", plan: "",
    }
    const payload = buildVerifierPayload(raw, logger)
    expect(payload.lastResponse).toBeUndefined()
    expect(logger).toHaveBeenCalledWith("verifier:field-dropped", { field: "lastResponse" })
    expect(logger).not.toHaveBeenCalledWith("verifier:field-partial-drop", expect.anything())
  })
})

// ===========================================================================
// runVerifier — FR-030/FR-030a/FR-030b/FR-032, BDD "Feature: Verifier (US-9)"
// ===========================================================================

describe("runVerifier", () => {
  const basePayload = { criteria: ["c1"], diffSummary: "@@ -1,1 +1,1 @@\n+ok", verifierSummaries: ["ok"] }

  it('BDD "Verifier verdict appended without gating the checkpoint": a configured verifier stub returning a per-story/per-item verdict resolves cleanly', async () => {
    // HANDOVER.md point 4: a failing story names exactly which acceptance
    // items are unmet and why, per item — the detail continuations consume.
    const verdict = {
      stories: [
        {
          storyId: "S1",
          pass: true,
          summary: "model exists with the declared fields",
          items: [{ itemId: "A1", met: true, note: "NormalizedTrace found in src/model.ts with X/Y/Z" }],
        },
        {
          storyId: "S2",
          pass: false,
          summary: "one item unverified",
          items: [
            { itemId: "A1", met: true, note: "cli --help exits 0 (re-ran it myself)" },
            { itemId: "A2", met: false, note: "declared verifier `make check` fails on test 37" },
          ],
        },
      ],
    }
    mockRunSubturn.mockResolvedValue({ ok: true, text: JSON.stringify(verdict) })
    const client = makeClient()
    const logger = vi.fn()
    const result = await runVerifier(
      client,
      { selfCreated: new SelfCreatedSessions(), logger },
      {
        parentSessionID: "parent-1",
        sessionModel: { providerID: "minimax", modelID: "MiniMax-M3" },
        payload: basePayload,
      },
    )
    expect(result).toEqual({ verdict })
    // No verifier:* failure event on a clean success.
    expect(logger).not.toHaveBeenCalled()
  })

  it('BDD "Verifier subturn uses the session model by default": no override — prompt model is the session model, agent is vertex-verifier, parent is the current session', async () => {
    const client = makeClient()
    await runVerifier(
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
    expect(req.agent).toBe("vertex-verifier")
    expect(req.parentSessionID).toBe("session-123")
    // HANDOVER.md point 3: the allow-aware tool map from the probe is
    // threaded through verbatim as the subturn's `tools` field.
    expect(req.tools).toEqual(VERIFIER_TOOLS_MAP)
  })

  // =========================================================================
  // FR-011 (P0 — docs/VERIFIER-RELIABILITY-FIXES-SPEC.md, User Story 9).
  //
  // Probe P1 reproduced the production failure in 9.8 s: given only the
  // payload, the verifier answered `pass:false` with "research/x.json does not
  // exist ... ls shows no research/ directory" for a file that existed.
  // Probe P2/P3, same bytes but a prompt that named what to check, made 2
  // real tool calls and returned a correct verdict. The prompt's only
  // observation obligation was attached to CREDITING a claim
  // ("Read the files a claim references before crediting it"), leaving the
  // negative direction — the one that reverts delivered work — unconstrained.
  //
  // These assert on the prompt actually handed to the subturn, not on an
  // exported constant, so they fail if the sentence exists but is not wired
  // through.
  // =========================================================================

  async function assembledVerifierSystemPrompt(): Promise<string> {
    await runVerifier(
      makeClient(),
      { selfCreated: new SelfCreatedSessions(), logger: vi.fn() },
      {
        parentSessionID: "parent-1",
        sessionModel: { providerID: "minimax", modelID: "MiniMax-M3" },
        payload: basePayload,
      },
    )
    return mockRunSubturn.mock.calls[0][3].system as string
  }

  it("FR-011: the assembled system prompt forbids a met:false file claim that was not observed first", async () => {
    const system = await assembledVerifierSystemPrompt()
    // The negative-direction obligation, its trigger, and the tools that
    // discharge it must all be present in the text the model receives.
    expect(system).toMatch(/must not report an item as "met": false/i)
    expect(system).toMatch(/missing, empty, or lacks some content/i)
    expect(system).toMatch(/unless you have just observed that yourself/i)
    expect(system).toMatch(/read, glob, grep or bash/i)
    // ...and the payload must be explicitly disqualified as evidence of
    // absence — this is the exact inference P1 made.
    expect(system).toMatch(/payload is never evidence that something is absent/i)
  })

  it("FR-011: the prompt gives the verifier a compliant way to express doubt instead of asserting absence", async () => {
    const system = await assembledVerifierSystemPrompt()
    expect(system).toMatch(/if you cannot make that observation/i)
    expect(system).toMatch(/could not verify/i)
    expect(system).toMatch(/instead of claiming the file or its content does not exist/i)
  })

  // =========================================================================
  // B-3b (operator ruling, 2026-08-06): "the judge should not go by exit codes
  // — they are information, but not a real criterion for the judge. The judge
  // needs simply to judge if the goal was achieved, all stories delivered, and
  // generally validated."
  //
  // This is a PROMPT change and nothing else: there is no behaviour here to
  // assert beyond the text the model receives. What these tests buy is that a
  // later edit cannot quietly drop the criteria and leave the suite green —
  // the failure mode this prompt has actually suffered before (the only
  // criterion-shaped sentence it ever contained was about exit-code
  // reliability).
  // =========================================================================

  it("B-3b: the prompt states the judge's three criteria — goal achieved, every story delivered, holds up", async () => {
    const system = await assembledVerifierSystemPrompt()
    expect(system).toMatch(/was the GOAL of the plan achieved/i)
    expect(system).toMatch(/is EVERY story delivered against the acceptance items it declares/i)
    expect(system).toMatch(/HOLD UP UNDER SCRUTINY/i)
  })

  it("B-3b: exit codes are named as citable evidence and explicitly disqualified as the test", async () => {
    const system = await assembledVerifierSystemPrompt()
    expect(system).toMatch(/exit codes, command results and verifier summaries are EVIDENCE you may cite/i)
    expect(system).toMatch(/they are never the test/i)
    // Both directions, because both are how a command result smuggles itself
    // in as a verdict.
    expect(system).toMatch(/a failing command does not by itself make an acceptance item unmet/i)
    expect(system).toMatch(/a passing command does not by itself make an acceptance item met/i)
  })

  it("B-3b: re-running a declared verifier is kept, but its result informs the verdict rather than deciding it", async () => {
    const system = await assembledVerifierSystemPrompt()
    // The instruction survives (it is how evidence is gathered) ...
    expect(system).toMatch(/run each verifier as a standalone command/i)
    // ... with its standing demoted.
    expect(system).toMatch(/the result informs your verdict; it does not decide it/i)
  })

  it("B-3b: the prompt demands a judgement on every acceptance item, by the digest's own item id", async () => {
    const system = await assembledVerifierSystemPrompt()
    expect(system).toMatch(/judge every acceptance item of every story you were asked to audit/i)
    expect(system).toMatch(/using that item's own id from the plan digest/i)
    expect(system).toMatch(/fails a story on something the story does not declare/i)
  })

  it("FR-011: the pre-existing positive-direction instruction is kept, not replaced", async () => {
    const system = await assembledVerifierSystemPrompt()
    expect(system).toContain("Read the files a claim references before crediting it.")
    // Still one flat sentence-joined string (the `.join(" ")` shape), not a
    // list or a multi-line block that a host might reformat.
    expect(system).not.toContain("\n")
  })

  // =========================================================================
  // FR-014 (docs/VERIFIER-RELIABILITY-FIXES-SPEC.md, User Story 12): the gate
  // needs the verifier child session's id to apply the tool-call floor — a
  // verdict produced with zero tool calls may not revert a story. runVerifier
  // cannot read it from runSubturn's return value (it isn't there) and must
  // not edit subturn.ts, so it observes the SelfCreatedSessions recorder.
  // =========================================================================

  it("FR-014: a successful run reports the child session id the subturn created", async () => {
    const selfCreated = new SelfCreatedSessions()
    mockRunSubturn.mockImplementation(async (_client, registry, _logger, req) => {
      registry.record("ses_verifier_child_1", req.parentSessionID)
      return { ok: true, text: JSON.stringify(PASS_VERDICT) }
    })

    const result = await runVerifier(
      makeClient(),
      { selfCreated, logger: vi.fn() },
      {
        parentSessionID: "parent-1",
        sessionModel: { providerID: "minimax", modelID: "MiniMax-M3" },
        payload: basePayload,
      },
    )

    expect(result.verdict).toEqual(PASS_VERDICT)
    expect(result.childSessionID).toBe("ses_verifier_child_1")
    // FR-036 must not regress: the CALLER's registry — not a private copy
    // inside the observing wrapper — has to recognise the child, or the
    // harness hooks would start firing on the verifier's own session.
    expect(selfCreated.isSelfCreated("ses_verifier_child_1", () => null)).toBe(true)
  })

  it("FR-014: a malformed or unavailable run still reports the child id (a child WAS created), and a failed probe reports none", async () => {
    mockRunSubturn.mockImplementation(async (_client, registry, _logger, req) => {
      registry.record("ses_verifier_child_2", req.parentSessionID)
      return { ok: true, text: "not json at all" }
    })
    const malformed = await runVerifier(
      makeClient(),
      { selfCreated: new SelfCreatedSessions(), logger: vi.fn() },
      { parentSessionID: "p", sessionModel: { providerID: "minimax", modelID: "MiniMax-M3" }, payload: basePayload },
    )
    expect(malformed).toEqual({ verdict: null, reason: "malformed", childSessionID: "ses_verifier_child_2" })

    // A refused probe never reaches runSubturn, so there is no child to name
    // and the key must be ABSENT (not an explicit undefined) — the gate reads
    // "no id" as inconclusive and fails open.
    mockProbeCapabilityBounded.mockResolvedValue({ ok: false, cause: "probe", reason: "agent not registered" })
    const unsupported = await runVerifier(
      makeClient(),
      { selfCreated: new SelfCreatedSessions(), logger: vi.fn() },
      { parentSessionID: "p", sessionModel: { providerID: "minimax", modelID: "MiniMax-M3" }, payload: basePayload },
    )
    expect(unsupported).toEqual({ verdict: null, reason: "unsupported" })
    expect("childSessionID" in unsupported).toBe(false)
  })

  // BACKLOG B-1: the BDD "Configured verifierModel failure falls back to the
  // session model" case lived here, asserting two attempts with the first on
  // `provider-x`. There is no override to configure, so the scenario is
  // unreachable AND its assertion is now the opposite of the contract. It is
  // deleted rather than adapted; what the removal guarantees instead — one
  // attempt, on the session's own model, no retry — is asserted by
  // "the judge runs on the worker's model: a single attempt is the only path"
  // further down this describe block.

  // =========================================================================
  // CRITICAL fix (post-review): the capability probe + deny-map build used
  // to be plain un-timed `await`s taken BEFORE the VERIFIER_TOTAL_BUDGET_MS
  // clock started — only the later runSubturn call was ever raced against a
  // timeout. runVerifier now starts its budget clock first and calls the
  // bounded probeCapabilityBounded(client, agent, budgetMs) helper, so the
  // probe + deny-map step itself counts against the shared 5s total.
  // =========================================================================

  it("fix #1: probeCapabilityBounded is invoked with the FULL VERIFIER_TOTAL_BUDGET_MS as its budget (the clock starts before the probe)", async () => {
    const client = makeClient()
    await runVerifier(
      client,
      { selfCreated: new SelfCreatedSessions(), logger: vi.fn() },
      {
        parentSessionID: "parent-1",
        sessionModel: { providerID: "minimax", modelID: "MiniMax-M3" },
        payload: basePayload,
      },
    )
    expect(mockProbeCapabilityBounded).toHaveBeenCalledTimes(1)
    // HANDOVER.md point 3: the verifier's probe runs with VERIFIER_PROBE_POLICY —
    // read/grep/glob/list/bash allowed, edit/write/webfetch/task must deny.
    expect(mockProbeCapabilityBounded).toHaveBeenCalledWith(client, "vertex-verifier", VERIFIER_TOTAL_BUDGET_MS, VERIFIER_PROBE_POLICY)
  })

  it("fix #1: real elapsed time spent in the probe/deny-map step reduces the subturn attempt's timeout — never a fresh 5s after the probe", async () => {
    mockProbeCapabilityBounded.mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, 40)) // simulate real elapsed time during probe+tool-map build
      return { ok: true, tools: VERIFIER_TOOLS_MAP }
    })
    const client = makeClient()
    await runVerifier(
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
    // The subturn's budget is what's left of VERIFIER_TOTAL_BUDGET_MS after the
    // probe/deny-map step's real elapsed time — strictly less than the full
    // budget, proving the clock was already running during that step.
    expect(req.timeoutMs).toBeLessThan(VERIFIER_TOTAL_BUDGET_MS)
  })

  it('fix #1: a probe/deny-map TIMEOUT (cause:"timeout") resolves to "unsupported" — the same classification as an ordinary probe refusal — never throws, never calls runSubturn', async () => {
    mockProbeCapabilityBounded.mockResolvedValue({
      ok: false,
      cause: "timeout",
      reason: "capability probe (probe + deny map) timed out",
    })
    const client = makeClient()
    const logger = vi.fn()
    const result = await runVerifier(
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
    expect(logger).toHaveBeenCalledWith("verifier:unsupported", {
      reason: "capability probe (probe + deny map) timed out",
    })
    expect(mockRunSubturn).not.toHaveBeenCalled()
  })

  // BACKLOG B-1 kept this guard when the retry loop collapsed to one call:
  // the probe races the SAME budget clock, so "no time left before the
  // subturn is even reached" is still reachable and must not become a
  // `runSubturn` with a non-positive timeout.
  it("fix #1: if the probe/deny-map step alone consumes the entire budget, the verifier reports timeout (remaining <= 0) rather than attempting with a negative/zero timeout", async () => {
    // Fake timers (rather than a real 5s+ delay) so this test proves the
    // "remaining <= 0" branch instantly: the mocked probeCapabilityBounded
    // advances the (mocked) clock past VERIFIER_TOTAL_BUDGET_MS before
    // resolving, exactly as if a real probe/deny-map round trip had
    // genuinely taken that long between runVerifier's `start = Date.now()` and
    // the probe settling.
    vi.useFakeTimers()
    try {
      mockProbeCapabilityBounded.mockImplementationOnce(async () => {
        vi.advanceTimersByTime(VERIFIER_TOTAL_BUDGET_MS + 10)
        return { ok: true, tools: VERIFIER_TOOLS_MAP }
      })
      const client = makeClient()
      const logger = vi.fn()
      const result = await runVerifier(
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
      expect(logger).toHaveBeenCalledWith("verifier:unavailable", { reason: "timeout" })
    } finally {
      vi.useRealTimers()
    }
  })

  it('BDD "Verifier timeout fails open": a subturn that reports timeout resolves to unavailable and logs verifier:unavailable', async () => {
    mockRunSubturn.mockResolvedValue({ ok: false, reason: "timeout" })
    const client = makeClient()
    const logger = vi.fn()
    const result = await runVerifier(
      client,
      { selfCreated: new SelfCreatedSessions(), logger },
      {
        parentSessionID: "parent-1",
        sessionModel: { providerID: "minimax", modelID: "MiniMax-M3" },
        payload: basePayload,
      },
    )
    expect(result).toEqual({ verdict: null, reason: "unavailable" })
    expect(logger).toHaveBeenCalledWith("verifier:unavailable", { reason: "timeout" })
  })

  it('BDD "Verifier subturn is refused when tools cannot be disabled": probe failure => zero session.create/session.prompt (runSubturn never called), verifier:unsupported logged once', async () => {
    mockProbeCapabilityBounded.mockResolvedValue({
      ok: false,
      cause: "probe",
      reason: 'agent "vertex-verifier" resolves tool "bash" to true',
    })
    const client = makeClient()
    const logger = vi.fn()
    const result = await runVerifier(
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
    expect(logger).toHaveBeenCalledWith("verifier:unsupported", {
      reason: 'agent "vertex-verifier" resolves tool "bash" to true',
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
    const result = await runVerifier(
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
    expect(eventId).toBe("verifier:unavailable")
    expect(String((eventPayload as { reason: string }).reason)).toMatch(/tool ids endpoint unavailable/)
    expect(mockRunSubturn).not.toHaveBeenCalled()
  })

  it("malformed (non-JSON) response text resolves to malformed and logs verifier:malformed", async () => {
    mockRunSubturn.mockResolvedValue({ ok: true, text: "here is my verdict: pass, looks fine" })
    const client = makeClient()
    const logger = vi.fn()
    const result = await runVerifier(
      client,
      { selfCreated: new SelfCreatedSessions(), logger },
      {
        parentSessionID: "parent-1",
        sessionModel: { providerID: "minimax", modelID: "MiniMax-M3" },
        payload: basePayload,
      },
    )
    expect(result).toEqual({ verdict: null, reason: "malformed" })
    expect(logger).toHaveBeenCalledWith("verifier:malformed", expect.objectContaining({ reason: expect.any(String) }))
  })

  it("valid JSON that does not match the {stories: [...]} shape resolves to malformed", async () => {
    mockRunSubturn.mockResolvedValue({ ok: true, text: JSON.stringify({ verdict: "maybe", confidence: 0.7 }) })
    const client = makeClient()
    const logger = vi.fn()
    const result = await runVerifier(
      client,
      { selfCreated: new SelfCreatedSessions(), logger },
      {
        parentSessionID: "parent-1",
        sessionModel: { providerID: "minimax", modelID: "MiniMax-M3" },
        payload: basePayload,
      },
    )
    expect(result).toEqual({ verdict: null, reason: "malformed" })
    expect(logger).toHaveBeenCalledWith("verifier:malformed", expect.any(Object))
  })

  // =========================================================================
  // HANDOVER.md point 4 — new verdict schema shape enforcement. Required
  // coverage: (1) BOTH superseded shapes ({fit, summary, gaps} and the older
  // {fit, notes}) must be rejected, not silently accepted; (2) pass:true with
  // an unmet item must be rejected (the machine-checkable invariant
  // continuations rely on); (3) unknown extra keys are tolerated.
  // =========================================================================

  it('point 4: the superseded {fit, summary, gaps} shape is now rejected as malformed, not silently accepted', async () => {
    mockRunSubturn.mockResolvedValue({
      ok: true,
      text: JSON.stringify({ fit: "pass", summary: "looks fine", gaps: [] }),
    })
    const client = makeClient()
    const logger = vi.fn()
    const result = await runVerifier(
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
      "verifier:malformed",
      expect.objectContaining({ reason: expect.stringContaining("does not match") }),
    )
  })

  it("point 4: the even-older {fit, notes} shape is also rejected as malformed", async () => {
    mockRunSubturn.mockResolvedValue({
      ok: true,
      text: JSON.stringify({ fit: "pass", notes: "looks fine" }),
    })
    const client = makeClient()
    const result = await runVerifier(
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

  it("point 4: an empty stories array is rejected as malformed (the verifier is the sole arbiter — an empty audit is not a verdict)", async () => {
    mockRunSubturn.mockResolvedValue({ ok: true, text: JSON.stringify({ stories: [] }) })
    const client = makeClient()
    const result = await runVerifier(
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

  it("point 4: pass:true with an unmet item is rejected as malformed (a pass requires every item met)", async () => {
    mockRunSubturn.mockResolvedValue({
      ok: true,
      text: JSON.stringify({
        stories: [
          {
            storyId: "S1",
            pass: true,
            summary: "claimed pass despite a gap",
            items: [
              { itemId: "A1", met: true, note: "observed" },
              { itemId: "A2", met: false, note: "verifier fails" },
            ],
          },
        ],
      }),
    })
    const client = makeClient()
    const result = await runVerifier(
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

  it("point 4: a blank storyId or blank itemId is rejected as malformed", async () => {
    for (const broken of [
      { stories: [{ storyId: "  ", pass: false, summary: "s", items: [{ itemId: "A1", met: false, note: "n" }] }] },
      { stories: [{ storyId: "S1", pass: false, summary: "s", items: [{ itemId: "", met: false, note: "n" }] }] },
    ]) {
      mockRunSubturn.mockResolvedValue({ ok: true, text: JSON.stringify(broken) })
      const client = makeClient()
      const result = await runVerifier(
        client,
        { selfCreated: new SelfCreatedSessions(), logger: vi.fn() },
        {
          parentSessionID: "parent-1",
          sessionModel: { providerID: "minimax", modelID: "MiniMax-M3" },
          payload: basePayload,
        },
      )
      expect(result).toEqual({ verdict: null, reason: "malformed" })
    }
  })

  it("point 4: wrong-shaped items (missing met/note) are rejected as malformed", async () => {
    mockRunSubturn.mockResolvedValue({
      ok: true,
      text: JSON.stringify({
        stories: [{ storyId: "S1", pass: false, summary: "problems found", items: [{ itemId: "A1", note: "no met field" }] }],
      }),
    })
    const client = makeClient()
    const result = await runVerifier(
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

  it("point 4: unknown extra keys on the verdict, a story, or an item are tolerated", async () => {
    const verdict = {
      stories: [
        {
          storyId: "S1",
          pass: false,
          summary: "one item missing",
          confidence: "high", // extra key — tolerated
          items: [{ itemId: "A1", met: false, note: "A1 still missing", severity: "blocking" }],
        },
      ],
      auditedAt: "2026-07-29", // extra key — tolerated
    }
    mockRunSubturn.mockResolvedValue({ ok: true, text: JSON.stringify(verdict) })
    const client = makeClient()
    const logger = vi.fn()
    const result = await runVerifier(
      client,
      { selfCreated: new SelfCreatedSessions(), logger },
      {
        parentSessionID: "parent-1",
        sessionModel: { providerID: "minimax", modelID: "MiniMax-M3" },
        payload: basePayload,
      },
    )
    expect(result).toEqual({ verdict })
    expect(logger).not.toHaveBeenCalled()
  })

  // BACKLOG B-1 — the operator's rule, as an assertion: the judge runs on the
  // same model as the worker. Before B-1 this test's premise was "no
  // verifierModelOverride was passed"; now there is no override to pass, so a
  // FAILING subturn is the sharpest probe available — under the old two-entry
  // attempt list a failure is exactly what triggered the second attempt on a
  // different model. One call, on `sessionModel`, is therefore load-bearing
  // for both halves of the rule (same model, no fallback chain).
  it("the judge runs on the worker's model: a single attempt is the only path, even when it fails", async () => {
    mockRunSubturn.mockResolvedValue({ ok: false, reason: "provider unreachable" })
    const client = makeClient()
    const logger = vi.fn()
    await runVerifier(
      client,
      { selfCreated: new SelfCreatedSessions(), logger },
      {
        parentSessionID: "parent-1",
        sessionModel: { providerID: "minimax", modelID: "MiniMax-M3" },
        payload: basePayload,
      },
    )
    expect(mockRunSubturn).toHaveBeenCalledTimes(1)
    expect(mockRunSubturn.mock.calls[0][3].model).toEqual({ providerID: "minimax", modelID: "MiniMax-M3" })
    expect(logger).toHaveBeenCalledWith("verifier:unavailable", { reason: "provider unreachable" })
  })

  it("thrown error from runSubturn's own promise rejection still resolves via the ok:false contract, not a throw", async () => {
    // runSubturn itself never rejects (subturn.ts's own contract: every exit
    // path resolves to a SubturnResult) — this test documents that runVerifier
    // does not add its own try/catch around runSubturn and instead trusts
    // that contract, by asserting a call that resolves ok:false propagates
    // cleanly without runVerifier throwing.
    mockRunSubturn.mockResolvedValue({ ok: false, reason: "subturn failed: boom" })
    const client = makeClient()
    await expect(
      runVerifier(
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
// Verifier reply parsing — found by UAT G12.
//
// A real verifier run was discarded with `verifier:malformed {reason:"response is
// not valid JSON"}`: the plan had completed, the subturn had run, and the
// verdict was thrown away because the model fenced its JSON. The verifier agent
// is told to return JSON and usually does, but "usually" is not a contract,
// and each miss costs a full verifier budget (up to 300s and a model call).
// ===========================================================================

describe("parseVerifierResponse", () => {
  const verdict = { stories: [{ storyId: "S1", pass: true, summary: "tests cover the change", items: [{ itemId: "A1", met: true, note: "observed" }] }] }

  it("accepts bare JSON", () => {
    expect(parseVerifierResponse(JSON.stringify(verdict))).toEqual(verdict)
  })

  it("accepts fenced JSON, with and without a language tag", () => {
    expect(parseVerifierResponse("```json\n" + JSON.stringify(verdict) + "\n```")).toEqual(verdict)
    expect(parseVerifierResponse("```\n" + JSON.stringify(verdict) + "\n```")).toEqual(verdict)
  })

  it("accepts JSON preceded by prose", () => {
    expect(parseVerifierResponse(`Here is my verdict:\n\n${JSON.stringify(verdict)}`)).toEqual(verdict)
  })

  it("handles braces inside string values", () => {
    const tricky = { stories: [{ storyId: "S1", pass: false, summary: "saw a literal } and { in the diff", items: [] }] }
    expect(parseVerifierResponse(`prose ${JSON.stringify(tricky)} trailing`)).toEqual(tricky)
  })

  it("still returns undefined for a reply with no JSON at all (discrimination)", () => {
    // A genuinely non-JSON reply must remain malformed, not be guessed at.
    expect(parseVerifierResponse("I think this looks fine to me, honestly.")).toBeUndefined()
    expect(parseVerifierResponse("")).toBeUndefined()
  })

  it("does not repair malformed JSON", () => {
    expect(parseVerifierResponse("{fit: pass, notes: unquoted}")).toBeUndefined()
  })
})

// ===========================================================================
// CRIT-001 regression — the wrapped-secret guarantee across EVERY split point.
//
// My first FR-006a fix used a fragment-LENGTH bar and re-opened the C-9 leak
// for uneven splits. The replacement is a SHAPE bar (`PATHLIKE_AT_JOIN`). This
// sweeps every split of a 42-char high-entropy token and asserts the real
// property that matters: no USABLE fragment (>= 16 chars of the secret) ever
// reaches the payload. Long fragments trip `unitTrips` alone; short remainders
// are not a secret. A crude "was the whole field dropped?" assertion reports
// false alarms here, which is why the check is written against what is
// actually transmitted.
// ===========================================================================
describe("FR-006a / C-9 — no usable secret fragment survives any wrap point", () => {
  const SECRET = "sV8kQz3RtY7pLmN2xW9bC4dF6gH1jK5aZ0eR8uT3iO"

  it("leaks no >=16-char fragment at any of the 41 split points", () => {
    const leaks: string[] = []
    for (let i = 1; i < SECRET.length; i++) {
      const payload = buildVerifierPayload(
        {
          criteria: [SECRET.slice(0, i), SECRET.slice(i)],
          diffSummary: "",
          verifierSummaries: [],
          lastResponse: "",
          recentTranscript: "",
          plan: "",
        },
        () => {},
      )
      for (const line of payload.criteria ?? []) {
        if (line.length >= 16 && SECRET.includes(line)) leaks.push(`split ${i}: ${line}`)
      }
    }
    expect(leaks, `usable fragments transmitted: ${leaks.length}`).toEqual([])
  })

  it("still keeps the innocent path-join that motivated the fix", () => {
    const events: string[] = []
    const payload = buildVerifierPayload(
      {
        criteria: [
          "  verifiers: jq -e .kpis research/space-exploration.json",
          'S2 (active): "Research Wave B"',
        ],
        diffSummary: "",
        verifierSummaries: [],
        lastResponse: "",
        recentTranscript: "",
        plan: "",
      },
      (event) => events.push(event),
    )
    expect(payload.criteria).toHaveLength(2)
    expect(events).not.toContain("verifier:field-partial-drop")
  })
})

// ---------------------------------------------------------------------------
// C1 (grill round 2) — the FR-006a exoneration must not exempt the other HALF
// of a confirmed secret. `scanUnits` used to `continue` whenever either unit of
// a pair had already been dropped alone, to protect an innocent neighbor. That
// also skipped the one check able to tell an abutter from a fragment.
// ---------------------------------------------------------------------------
describe("C1 — split-secret fragment adjacent to a unit dropped alone", () => {
  const scan = (criteria: string[]) =>
    buildVerifierPayload(
      { criteria, diffSummary: "", verifierSummaries: [], lastResponse: "", recentTranscript: "", plan: "" },
      () => {},
    ).criteria ?? []

  // The regression, exactly: a 64-char hex key split at 16. The 48-char tail
  // exceeds ENTROPY_MIN_TOKEN_LENGTH so it trips and is dropped on its own; the
  // 16-char head is under every standalone threshold and used to survive.
  it("drops BOTH halves when a 64-char hex key is split so only the tail trips alone", () => {
    const key = "4145244f7f8dbe2cf1" + "0123456789abcdef".repeat(2) + "99887766554433"
    expect(key).toHaveLength(64)
    expect(scan([key.slice(0, 16), key.slice(16)])).toHaveLength(0)
  })

  it("leaks no >=16-char fragment at ANY split point, across four key encodings", () => {
    const keys = [
      "HUZxXdF2O3ftvnSNicpJtsJI0PCeI/m9Ri1u0CYfbfQ=", // base64, contains / and =
      "4145244f7f8dbe2cf10123456789abcdef0123456789abcdef99887766554433", // hex
      "Svzr9U0zES32u3j1XrjO5C1DqJjuNf7CQM0ScPyuXXU", // base64url
      // Real random alnum material. An earlier version of this row was
      // hand-authored and happened to end in the literal string
      // "abcdefghijklmn", which the structural test correctly reads as a WORD
      // and keeps — see the documented trade-off on `looksLikeSecretFragment`.
      "KsZwACdq04WhV2Fn8pQXwRrRn5grnym14poxtRbM", // alnum only
    ]
    const leaks: string[] = []
    for (const key of keys) {
      for (let i = 1; i < key.length; i++) {
        for (const line of scan([key.slice(0, i), key.slice(i)])) {
          if (line.length >= 16 && key.includes(line)) leaks.push(`${i}:${line}`)
        }
      }
    }
    expect(leaks).toEqual([])
  })

  // The guarantee the old `continue` was protecting must still hold: abutting a
  // secret is not the same as being part of one. A pattern match that BEGINS at
  // the join has start === joinIdx, so it is not a straddle and the neighbor is
  // kept.
  // MAJ-5: the previous version of this test ended its first line with a
  // TRAILING SPACE, so `/\S+$/` matched nothing and the fragment predicate was
  // never reached — the guarantee it claimed to pin was untested. No trailing
  // space here, so the edge token is really examined.
  it("keeps an innocent neighbor that merely abuts a standalone secret", () => {
    const kept = scan(["Story S4 delivered the chart component.", "AKIAIOSFODNN7EXAMPLEKEYMATERIAL01"])
    expect(kept).toEqual(["Story S4 delivered the chart component."])
  })

  // MAJ-5, the regression proper: the first C1 fix DROPPED a neighbouring
  // unit whose edge token looked random enough, and each newly-dropped unit
  // implicated its own neighbour in turn. Measured then: four of five lines
  // lost, and a 40-char git SHA — a documented false positive of the hex-run
  // rule, no real secret involved — emptied the field outright, re-creating
  // the FR-006a failure this module exists to prevent.
  // MAJ-2 (round 4): the first version of this test led the adjacent line with
  // `Authorization` — 13 characters, under SECRET_FRAGMENT_MIN_CHARS — so the
  // predicate was never reached, and lines 3-5 were never adjacent to a
  // dropped unit at all. It asserted the fix's conclusion without exercising
  // its mechanism: mutants making `looksLikeWord` always-true AND always-false
  // both survived it. Every line here now leads with a >=16-char
  // secret-alphabet token that only `looksLikeWord` distinguishes from key
  // material.
  it("does not cascade: long identifier lines beside a secret all survive", () => {
    const kept = scan([
      "tok AKIAIOSFODNN7EXAMPLEKEYMATERIAL01",
      "createPlanRequestValidator ran clean",
      "snake_case_variable_name assigned correctly",
      "tests/fixtures/verifier-replay was refreshed",
      "documentationBuilder finished",
    ])
    expect(kept).toEqual([
      "createPlanRequestValidator ran clean",
      "snake_case_variable_name assigned correctly",
      "tests/fixtures/verifier-replay was refreshed",
      "documentationBuilder finished",
    ])
  })

  // CRIT-3 (round 4): the edge test used to require a PURE `\S+` token, so any
  // adjacent punctuation carried the fragment through untouched — and the
  // leaking shapes are JSON, markdown and quoted shell output, i.e. exactly
  // what reaches `recentTranscript` / `lastResponse` / `plan`.
  describe("CRIT-3: punctuation and newlines do not shelter a fragment", () => {
    const KEY = "91a0c1c67e98ec1e0b48db2e30e260ffc44f81c3c139"
    const WRAPPERS: Array<[string, string]> = [
      ["token `", "` used"],
      ['"', '", rest'],
      ["(", ") tail"],
      ["[", "] tail"],
      ["<", "> tail"],
      ["**", "** bold"],
      ["", " ; done"],
      ["", "\n next"],
    ]
    for (const [left, right] of WRAPPERS) {
      it(`leaks nothing for ${JSON.stringify(left)}…${JSON.stringify(right)}`, () => {
        for (let i = 8; i < KEY.length - 8; i++) {
          const kept = scan([left + KEY.slice(0, i), KEY.slice(i) + right]).join("\n")
          const survivors = (kept.match(/[0-9a-f]{16,}/g) ?? []).filter((run) => KEY.includes(run))
          expect(survivors, `split ${i} of ${JSON.stringify(left)}…`).toEqual([])
        }
      })
    }

    // The edge-strip regime proper: one unit is >=32 chars so it trips ALONE
    // (the pair pass is skipped entirely), and the surviving unit ends in the
    // fragment behind a quote/backtick/paren. Testing the whole `\S+` edge
    // token — the round-3 behaviour — captures the punctuation too, fails the
    // alphabet check, and strips nothing.
    it.each(['tail "', "tail `", "tail ("])("strips a fragment behind %j", (prefix) => {
      const hex = "4145244f7f8dbe2cf10123456789abcdef0123456789abcdef99887766554433"
      expect(scan([prefix + hex.slice(0, 20), hex.slice(20)])).toEqual([prefix])
    })

    // A SPACE is a real separator, not punctuation: skipping past one would
    // strip a token that was never part of the secret.
    it("does not strip a token separated from the secret by a space", () => {
      expect(scan(["tok AKIAIOSFODNN7EXAMPLEKEYMATERIAL01", " documentationBuilder finished"])).toEqual([
        " documentationBuilder finished",
      ])
    })

    // Examining `dewrap(unit)` and RETURNING it was tried and is wrong: it
    // hands back the unit with its newlines gone. `criteria` is split on
    // newlines anyway, so the damage only shows on `diffSummary`, whose units
    // are whole multi-line hunks — caught by the existing sk-live hunk test,
    // re-asserted here next to the fix it constrains.
    it("preserves newlines inside a surviving diff hunk beside a dropped one", () => {
      const payload = buildVerifierPayload(
        {
          criteria: [],
          diffSummary: "diff --git a/s b/s\n@@ -1,1 +1,1 @@\n-tok AKIAIOSFODNN7EXAMPLEKEYMATERIAL01\ndiff --git a/b b/b\n@@ -2,2 +2,2 @@\n-old\n+new",
          verifierSummaries: [],
          lastResponse: "",
          recentTranscript: "",
          plan: "",
        },
        () => {},
      )
      expect(payload.diffSummary).toContain("@@ -2,2 +2,2 @@\n-old\n+new")
      expect(payload.diffSummary).not.toContain("AKIAIOSFODNN7EXAMPLEKEYMATERIAL01")
    })
  })

  it("a git SHA false positive does not take the following lines with it", () => {
    const kept = scan([
      "commit 9f2c1ab4d7e6053829bb14cf7a0d3e5182647c9b",
      "Authorization header verified in tests",
      "createPlanRequest validated end to end",
    ])
    expect(kept).toEqual(["Authorization header verified in tests", "createPlanRequest validated end to end"])
  })

  // Only the offending TOKEN is removed, never the whole unit — that is what
  // makes a cascade structurally impossible.
  it("strips only the fragment, leaving the rest of the neighbouring line", () => {
    const key = "4145244f7f8dbe2cf10123456789abcdef0123456789abcdef99887766554433"
    const kept = scan([`prefix ${key.slice(0, 16)}`, key.slice(16)])
    expect(kept).toEqual(["prefix "])
  })

  // FR-006a's production case, re-asserted here because C1's fix touches the
  // same loop: the plan-digest lines that lost S1/S2/S3 must still both survive.
  it("still keeps the two plan-digest lines whose no-separator join manufactures a token", () => {
    expect(
      scan(["  verifiers: jq -e .kpis research/space-exploration.json", 'S2 (active): "Research Wave B"']),
    ).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// MAJ-1 (round 4) — mutation guards for the C1 predicate itself.
//
// A 37-mutant battery found that `looksLikeWord` could be replaced by
// `always true` OR `always false` with the suite still green: the predicate
// was load-bearing and untested from both directions.
// ---------------------------------------------------------------------------
describe("MAJ-1: looksLikeWord is pinned in both directions", () => {
  const scan2 = (criteria: string[]) =>
    buildVerifierPayload(
      { criteria, diffSummary: "", verifierSummaries: [], lastResponse: "", recentTranscript: "", plan: "" },
      () => {},
    ).criteria ?? []

  // always-true would keep these: each is real key material adjacent to a
  // dropped secret and must be stripped.
  const SECRET_FRAGMENTS = [
    "4145244f7f8dbe2cf1", // pure hex — LONG_HEX_RUN, segments into pseudo-words
    "TxobYfDaktWCrSXRdwBM", // base64 alphabet, 3-4 char pseudo-words
    "HMEr3sTxobYfDaktWCrSX", // ditto, mixed digits
  ]
  for (const fragment of SECRET_FRAGMENTS) {
    it(`strips key material: ${fragment}`, () => {
      expect(scan2(["tok AKIAIOSFODNN7EXAMPLEKEYMATERIAL01", `${fragment} trailing words here`])).toEqual([
        " trailing words here",
      ])
    })
  }

  // always-false would strip these: each is ordinary content that must survive
  // intact beside a dropped secret.
  const PROSE_TOKENS = ["createPlanRequestValidator", "snake_case_variable_name", "tests/fixtures/verifier-replay", "documentationBuilder"]
  for (const token of PROSE_TOKENS) {
    it(`keeps content: ${token}`, () => {
      expect(scan2(["tok AKIAIOSFODNN7EXAMPLEKEYMATERIAL01", `${token} was updated`])).toEqual([`${token} was updated`])
    })
  }

  // The FR-006a class, found by a test written for something else: two clean
  // adjacent prose lines whose no-separator join manufactures a 32+ char
  // high-entropy token. Both must survive.
  it("keeps two prose lines whose join manufactures a high-entropy token", () => {
    expect(
      scan2(["snake_case_variable_name assigned correctly", "tests/fixtures/verifier-replay was refreshed"]),
    ).toHaveLength(2)
  })
})

// ===========================================================================
// BACKLOG B-3 — "the one verifier run judged without the diff".
//
// The audited session logged `verifier:field-dropped {field:"diffSummary"}`
// and the verifier then formed a verdict with NO file evidence at all. The
// cause was not git and not the model: the harness's own FR-031 secret scan
// ate the harness's own file list. Reproduced end to end, measured:
//
//   the workspace was not a git repository -> `git diff --stat` threw ->
//   the caller fell back to a comma-joined list of ABSOLUTE paths -> that
//   list has no `@@` hunk header, so the scan treated the WHOLE list as one
//   removal unit -> the entropy rule (>= 3.95 bits/char, tokens >= 32 chars)
//   fired on
//       "/workspace/vertextest4/src/games/memory.js,"   43 chars  3.979 bits
//       "/workspace/vertextest4/src/games/index.html,"  44 chars  4.190 bits
//       "/workspace/vertextest4/src/games/breakout.js"  44 chars  3.971 bits
//   -> the single unit was emptied -> the entire field was dropped.
//
// The scan is a SAFETY control (FR-031) and is not weakened here: the fixes
// change the removal UNIT (whole blob -> one line) and the INPUT (absolute
// -> workspace-relative), never the threshold or the patterns. The SAFETY
// block below is the proof, and it must keep passing whatever else changes.
// ===========================================================================

/** The three paths from the audited session, verbatim. */
const B3_FIELD_PATHS = [
  "/workspace/vertextest4/src/games/memory.js",
  "/workspace/vertextest4/src/games/index.html",
  "/workspace/vertextest4/src/games/breakout.js",
]
const B3_WORKSPACE = "/workspace/vertextest4"

function b3Raw(diffSummary: string, extra: Partial<{ diffSummaryUnavailable: string }> = {}) {
  return { criteria: [], diffSummary, verifierSummaries: [], lastResponse: "", recentTranscript: "", plan: "", ...extra }
}

describe("B-3: the diff summary the harness produces survives the harness's own scan", () => {
  it("REPRODUCES the field failure: the OLD shape (absolute paths, comma-joined onto one line) empties the field", () => {
    // Not a mutation guard — the disease, pinned. It is still true after the
    // fix, because one line of absolute paths is still one removal unit
    // holding a 44-char, 4.190-bits/char token. That is exactly why fix (a)
    // changes what the harness EMITS and does not merely re-slice it.
    const logger = vi.fn()
    const payload = buildVerifierPayload(b3Raw(B3_FIELD_PATHS.join(", ")), logger)
    expect(payload.diffSummary).toBeUndefined()
    expect(logger).toHaveBeenCalledWith("verifier:field-dropped", { field: "diffSummary" })
  })

  it("FIX (a): the SAME paths, emitted by formatChangedPathsSummary, reach the verifier intact", () => {
    // Dies if `formatChangedPathsSummary` goes back to absolute paths (the
    // tokens clear the entropy threshold again) or to a single comma-joined
    // line (one unit, same total loss).
    const logger = vi.fn()
    const payload = buildVerifierPayload(b3Raw(formatChangedPathsSummary(B3_FIELD_PATHS, B3_WORKSPACE)), logger)
    expect(payload.diffSummary).toBeDefined()
    expect(payload.diffSummary).toContain("src/games/memory.js")
    expect(payload.diffSummary).toContain("src/games/index.html")
    expect(payload.diffSummary).toContain("src/games/breakout.js")
    expect(logger).not.toHaveBeenCalled()
  })

  it("FIX (c): a hunk-less summary loses only the offending LINE, never the whole field", () => {
    // Dies if `splitDiffIntoHunks` goes back to `return [diffSummary]` for a
    // field with no `@@` header: the one high-entropy line takes the two
    // innocent ones with it and the field is dropped whole.
    const logger = vi.fn()
    const summary = [
      "  src/games/memory.js",
      "  /workspace/vertextest4/src/games/index.html", // 43 chars, 4.127 bits/char — trips
      "  src/games/breakout.js",
    ].join("\n")
    const payload = buildVerifierPayload(b3Raw(summary), logger)
    expect(payload.diffSummary).toBe(["  src/games/memory.js", "  src/games/breakout.js"].join("\n"))
    expect(logger).toHaveBeenCalledWith("verifier:field-partial-drop", { field: "diffSummary", kept: 2, dropped: 1 })
    expect(logger).not.toHaveBeenCalledWith("verifier:field-dropped", expect.anything())
  })

  it("FIX (c): a REAL `git diff --stat` (which also has no `@@` header) is untouched", () => {
    const logger = vi.fn()
    // The `+++/---` bar measures 0.732 bits/char — this shape never tripped,
    // which is why the defect only ever showed up outside a repository.
    const stat = [
      " src/v2/plugin.ts    | 42 ++++++++++++++++++++++++++++++--------",
      " src/v2/verifier.ts  |  8 ++++----",
      " 2 files changed, 40 insertions(+), 10 deletions(-)",
    ].join("\n")
    const payload = buildVerifierPayload(b3Raw(stat), logger)
    expect(payload.diffSummary).toBe(stat)
    expect(logger).not.toHaveBeenCalled()
  })

  it("hunk splitting is unchanged when `@@` headers ARE present (one unit per hunk, not per line)", () => {
    // Guards the other direction: fix (c) must not turn hunk-shaped input
    // into line-shaped input, or a secret split across two lines of one hunk
    // stops being a single unit's problem.
    const logger = vi.fn()
    const clean = "@@ -1,1 +1,1 @@\n-old\n+new"
    const withSecret = '@@ -2,1 +2,1 @@\n+const key = "sk-live-abc123def456ghi789jkl012mno345pqr"'
    const payload = buildVerifierPayload(b3Raw([clean, withSecret].join("\n")), logger)
    expect(payload.diffSummary).toBe(clean)
    expect(logger).toHaveBeenCalledWith("verifier:field-partial-drop", { field: "diffSummary", kept: 1, dropped: 1 })
  })
})

// ---------------------------------------------------------------------------
// Every test in this block must ISOLATE one detector: disable that detector
// and this test dies; leave it in place and no other mutation kills it. Two
// tests here used to fail that bar and were replaced (B-3b/FIX-4):
//
//  - "a complete sk-live token on one line of a `git diff --stat`-shaped
//    summary is removed" survived BOTH the pattern-scan and the entropy-rule
//    mutation (measured: 0 of the 2 pattern deaths, 0 of the 19 entropy
//    deaths), because that token trips both. It proved nothing that the
//    hunter2 case (pattern, isolated) and the base64 case (entropy, isolated)
//    below do not already prove, and its hunk-less `--stat` shape is asserted
//    by both of them too. Its slot now holds the span-pass isolator.
//  - "an unlabelled 40-char hex token on its own line still trips the entropy
//    rule" survived BOTH the entropy-rule and the hex-run mutations for the
//    same reason, and its comment — "the entropy rule is the only thing that
//    catches it" — was simply false: 40 chars of hex is also a 32+ hex run.
//    Its slot now holds the hex-run isolator, the detector that had NO
//    isolating test in this block at all.
// ---------------------------------------------------------------------------
describe("B-3 SAFETY (FR-031): per-line scanning of a hunk-less diff summary still catches real secrets", () => {
  it("B-3b: a key wrapped across THREE lines — the case only the span pass can catch — is removed whole", () => {
    // Reproduced leak, verbatim. 40 chars of base64 key at 5.12 bits/char,
    // split 12 / 6 / 25. No unit reaches the 32-char entropy floor alone and
    // no ADJACENT PAIR does either (18 and 31 chars), so passes 1 and 2 are
    // both blind and the whole key shipped — recoverable by stripping the
    // newlines — with not a single event logged.
    //
    // Dies for the span pass alone: restore SPAN_MAX_UNITS to 2 (or delete
    // the third pass) and the key comes straight back.
    const logger = vi.fn()
    const key = "HMEr3sTxobYfDaktWCrSXRdwBMkQvZpNjLgUeIoA"
    const summary = [" src/config.ts | 2 +-", "+  HMEr3sTxo", "bYfDak", "tWCrSXRdwBMkQvZpNjLgUeIoA"].join("\n")
    const payload = buildVerifierPayload(b3Raw(summary), logger)
    expect(payload.diffSummary).toBe(" src/config.ts | 2 +-")
    expect((payload.diffSummary ?? "").replace(/[\r\n]/g, "")).not.toContain(key)
    expect(logger).toHaveBeenCalledWith("verifier:field-partial-drop", { field: "diffSummary", kept: 1, dropped: 3 })
  })

  it("B-3b: the SAME three-way wrap in recentTranscript is removed too — this is not a diffSummary-only fix", () => {
    // The hole was documented as applying to all six fields, and the fields
    // where a three-way wrap is actually PRODUCIBLE are the free-form ones:
    // `computeBoundedDiffStat` only ever emits `--stat` lines and filenames,
    // while a transcript carries whatever the model and the user pasted.
    // Hardening diffSummary alone would have fixed the least exposed field.
    const logger = vi.fn()
    const key = "HMEr3sTxobYfDaktWCrSXRdwBMkQvZpNjLgUeIoA"
    const payload = buildVerifierPayload(
      {
        criteria: [],
        diffSummary: "",
        verifierSummaries: [],
        lastResponse: "",
        recentTranscript: ["assistant: the key is", "+  HMEr3sTxo", "bYfDak", "tWCrSXRdwBMkQvZpNjLgUeIoA"].join("\n"),
        plan: "",
      },
      logger,
    )
    expect(JSON.stringify(payload).replace(/\\n/g, "")).not.toContain(key)
    expect(payload.recentTranscript).toBe("assistant: the key is")
  })

  it("B-3b: three lines of unindented compact JSON are NOT dropped — the span pass must not re-open FR-006a", () => {
    // The counterweight to the two tests above, and a measured one: without
    // `spanLooksLikeOneWrappedToken` the span pass deleted all three of these
    // lines. They fuse into a 45-char token over 4 bits/char with no
    // word-meets-word join, i.e. it clears every other bar the pass applies.
    // A wrapped KEY is one uninterrupted run of key alphabet; this token's
    // punctuation is interior and load-bearing, which is what tells them apart.
    const logger = vi.fn()
    const lines = ['{"storyId":"S1",', '"pass":true,', '"summary":"done"}']
    const payload = buildVerifierPayload(
      { criteria: [], diffSummary: "", verifierSummaries: [], lastResponse: lines.join("\n"), recentTranscript: "", plan: "" },
      logger,
    )
    expect(payload.lastResponse).toBe(lines.join("\n"))
    expect(logger).not.toHaveBeenCalled()
  })

  it("B-3b: a connection string wrapped across three lines IS still dropped — the JSON exemption is entropy-only", () => {
    // `postgres://user:pw@host` is exactly a token whose middle is full of
    // structural punctuation, so exempting "punctuation in the middle"
    // unconditionally would have handed a wrapped connection string a free
    // pass. The exemption is applied only to an entropy-driven hit; a
    // SECRET_PATTERNS match is shape-specific and is never exonerated by it.
    //
    // Split so that neither individual line and neither ADJACENT PAIR carries
    // a whole `scheme://user:pass@host`, which is what forces the span pass to
    // be the thing that catches it: "see postgres://us" + "er:pw1" is 23 chars
    // with no `@`, "er:pw123@dbhost/mydb now" has no scheme.
    const logger = vi.fn()
    const lines = ["see postgres://us", "er:pw1", "23@dbhost/mydb now", "and we are done"]
    const payload = buildVerifierPayload(
      { criteria: [], diffSummary: "", verifierSummaries: [], lastResponse: lines.join("\n"), recentTranscript: "", plan: "" },
      logger,
    )
    expect(payload.lastResponse).toBe("and we are done")
    expect(JSON.stringify(payload)).not.toContain("pw123")
  })

  it("a secret SPLIT across two adjacent lines is still caught — the adjacent-pair pass survives the unit change", () => {
    // This is the property per-line scanning could plausibly have broken:
    // with the whole blob as one unit the split token was reunited by
    // `dewrap`; with lines as units it is only reunited by `scanUnits`'
    // adjacent-pair pass. Both halves must go.
    const logger = vi.fn()
    const summary = ['+const key = "sk-live-abc123', 'def456ghi789jklmno"', " src/config.ts | 2 +-"].join("\n")
    const payload = buildVerifierPayload(b3Raw(summary), logger)
    expect(payload.diffSummary).toBe(" src/config.ts | 2 +-")
    expect(payload.diffSummary).not.toContain("sk-live")
    expect(payload.diffSummary).not.toContain("def456ghi789")
  })

  it("a LOW-entropy 32-char hex run — the case only the hex-run backstop can catch — is still removed", () => {
    const logger = vi.fn()
    // Deliberately picked so exactly one detector can see it. 32 characters
    // of pure hex, but only four distinct symbols: 2.156 bits/char, far under
    // the entropy rule's 3.95 effective threshold, so `tripsEntropyScan`
    // never fires. No `:`/`=` and no recognised token prefix, so
    // `redactSecrets` never fires either. Only the C-15 hex-run backstop is
    // left — and this block had NO test isolating it until now.
    //
    // (The 40-char hex token this replaced measured 3.971 bits/char, over the
    // entropy bar AND a 32+ hex run, so it survived removing either one.)
    const summary = [" src/config.ts | 2 +-", "+const token is deadbeefdeadbeefdeadbeefdeadbeef here"].join("\n")
    const payload = buildVerifierPayload(b3Raw(summary), logger)
    expect(payload.diffSummary).toBe(" src/config.ts | 2 +-")
    expect(payload.diffSummary).not.toContain("deadbeef")
  })

  it("an UNLABELLED, non-hex high-entropy key — the case only the entropy rule can catch — is still removed", () => {
    // 40 chars, 5.122 bits/char, base64 alphabet: no SECRET_PATTERNS entry
    // matches it and it is not a hex run, so the entropy rule is its only
    // catcher. This is the control the B-3 change touches (it re-units what
    // the rule is applied to), so it needs its own isolated proof.
    const logger = vi.fn()
    const summary = [" src/config.ts | 2 +-", "+const k = HMEr3sTxobYfDaktWCrSXRdwBMkQvZpNjLgUeIoA"].join("\n")
    const payload = buildVerifierPayload(b3Raw(summary), logger)
    expect(payload.diffSummary).toBe(" src/config.ts | 2 +-")
  })

  it("a LOW-entropy LABELLED secret — the case only the pattern scan can catch — is still removed", () => {
    // Deliberately below every other tripwire: "hunter2hunter2" is 14 chars
    // (the entropy rule ignores anything under 32) and is not hex, so if
    // `redactSecrets` ever stopped being consulted this line would sail
    // through. Measured: this is 1 of only 2 tests in the whole suite that
    // die when `tripsPatternScan` is stubbed out.
    const logger = vi.fn()
    const summary = [" src/config.ts | 2 +-", "+password: hunter2hunter2", " 1 file changed, 1 insertion(+)"].join("\n")
    const payload = buildVerifierPayload(b3Raw(summary), logger)
    expect(payload.diffSummary).not.toContain("hunter2")
    expect(payload.diffSummary).toContain("src/config.ts")
  })

  it("a hunk-less summary that is NOTHING but a secret is still dropped in full", () => {
    const logger = vi.fn()
    const payload = buildVerifierPayload(
      b3Raw('AKIAIOSFODNN7EXAMPLE aws_secret_access_key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"'),
      logger,
    )
    expect(payload.diffSummary).toBeUndefined()
    expect(logger).toHaveBeenCalledWith("verifier:field-dropped", { field: "diffSummary" })
  })
})

// ---------------------------------------------------------------------------
// The span pass, round 6. Four reproduced findings, each with its own isolator:
//
//  1. the wrapped-key guard leaked WHOLE KEYS whenever line 1 carried a prefix
//     that put a non-alphabet character between itself and the key;
//  2. the same guard's alphabet contained `.` and `/`, so it ATE tight lists of
//     file paths — the changed-file evidence the verifier judges from;
//  3. base32-shaped keys exonerated themselves as "words";
//  4. `SPAN_MAX_UNITS` was pinned in neither direction (3 and 60 both left the
//     suite green), and the pass cost 1700 ms on the worst field the raw-field
//     safety cap admits.
// ---------------------------------------------------------------------------
describe("span pass round 6: the wrapped-key guard, the span window, and the cost", () => {
  const KEY = "HMEr3sTxobYfDaktWCrSXRdwBMkQvZpNjLgUeIoA"
  const flat = (text: string | undefined) => (text ?? "").replace(/[\r\n]/g, "")
  const scan = (lines: string[]) => {
    const logger = vi.fn()
    return { out: scanProseField(lines.join("\n"), "recentTranscript", logger, 16000), logger }
  }

  it("FIX 1 (HIGH, reproduced): a quoted CLI flag on line 1 no longer buys the whole key a free pass", () => {
    // Verbatim reproduction. The old guard demanded the fused token be ONE
    // uninterrupted run of key alphabet; `--blob="` is alphabet, the `"` is
    // not, and the key is alphabet — two runs, so the guard exonerated the
    // span. Measured before this fix: this input came back BYTE-IDENTICAL with
    // an EMPTY event list, in all six fields.
    const { out, logger } = scan(["running deploy:", `--blob="HMEr3sTxobYf`, "DaktWCrS", `XRdwBMkQvZpNjLgUeIoA"`, "exit 0"])
    expect(flat(out)).not.toContain(KEY)
    expect(out).toBe("running deploy:\nexit 0")
    expect(logger).toHaveBeenCalledWith("verifier:field-partial-drop", { field: "recentTranscript", kept: 2, dropped: 3 })
  })

  // The eight of sixteen realistic shapes that leaked. Measured over all 741
  // three-way split points of the key above: 662 of 11,856 probes leaked
  // before, 0 after. Each shape puts a different non-alphabet character
  // between the prefix and the key, which is all it took.
  it.each([
    ['BLOB="', '"'],
    ['"blob":"', '"'],
    ["blob='", "'"],
    ['--blob="', '"'],
    ["setBlob(", ")"],
    ["[x](", ")"],
    ['<n v="', '"/>'],
    ["id,blob,", ",end"],
  ])("FIX 1: the key still goes when line 1 reads %s…", (prefix, suffix) => {
    const { out } = scan(["running deploy:", prefix + KEY.slice(0, 12), KEY.slice(12, 20), KEY.slice(20) + suffix, "exit 0"])
    expect(flat(out)).not.toContain(KEY)
  })

  it("FIX 1: …and a prefix whose punctuation is INTERIOR is still spared (the guard's whole reason to exist)", () => {
    // The counterweight. Compact JSON has punctuation BETWEEN the joins, so
    // there is no single-encoding core at all and the span is exonerated —
    // the same verdict the old whole-token regex reached, for a reason that
    // survives a prefix on line 1.
    const lines = ['log: {"storyId":"S1",', '"pass":true,', '"summary":"done"}']
    const { out, logger } = scan(lines)
    expect(out).toBe(lines.join("\n"))
    expect(logger).not.toHaveBeenCalled()
  })

  it("EXTRA FIX A (reproduced): a tight list of changed FILE PATHS survives byte-identical", () => {
    // Measured: this exact field came back `undefined` — three innocent path
    // lines in, the whole field DROPPED, the verifier left judging with no
    // changed-file evidence at all. `.` and `/` were in the guard's key
    // alphabet, so a path list fused into "one clean run of key material".
    // Over 618 innocent corpora x 2 fields the span pass widened 66 of them;
    // it now widens 0.
    const lines = ["lib/ui/phase.mjs", "lib/api/main.rs", "internal/types/artifacts.py"]
    const { out, logger } = scan(lines)
    expect(out).toBe(lines.join("\n"))
    expect(logger).not.toHaveBeenCalled()
  })

  it("EXTRA FIX A: an EXTENSIONLESS path list survives too — the dot is not what saves it", () => {
    // `assets/api/helper` is pure `[A-Za-z0-9/]`, i.e. a legal base64 run, so
    // the encoding test alone does not clear it. Three-or-more-segment paths
    // in every unit do: a wrapped key chunk would need two `/` by chance in
    // every one of its pieces.
    const lines = ["assets/api/helper", "src/v2/index", "pkg/wiring/gate", "components/v2/artifacts"]
    const { out, logger } = scan(lines)
    expect(out).toBe(lines.join("\n"))
    expect(logger).not.toHaveBeenCalled()
  })

  it("EXTRA FIX A: a snake_case identifier list survives — structured text, not key material", () => {
    const lines = ["verifier_ui_helper", "story_db_main", "gate_adr_index", "coverage_api_tools"]
    const { out } = scan(lines)
    expect(out).toBe(lines.join("\n"))
  })

  it("FIX 2: a base32 key wrapped across three lines is removed — an all-caps run is not a word", () => {
    // The measured residual. A base32 key is uppercase letters plus 2-7, so it
    // carries no separator and no camelCase hump: `looksLikeWord` read its
    // digit-delimited shards as vowel-bearing words and exonerated the join.
    // Base32 was 3,584 of 12,718 whole-key leaks in a 180,000-probe sweep.
    const b32 = "AJEN72OERLKQA3BZEV3TUHMVRWGXKZQA2PKDSUXV"
    const { out } = scan(["deploying now", b32.slice(0, 13), b32.slice(13, 26), b32.slice(26), "done"])
    expect(flat(out)).not.toContain(b32)
    expect(out).toBe("deploying now\ndone")
  })

  it("EXTRA FIX B: a key wrapped across exactly SPAN_MAX_UNITS lines is removed", () => {
    // 36 characters over six 6-character lines. Every window NARROWER than six
    // carries at most 30 characters — under the 32-char entropy floor — so
    // nothing but a full-width span can see this key. Lower SPAN_MAX_UNITS to
    // 3, 4 or 5 and the key comes straight back.
    const key = "aCreHz2wDL4keqaDIEZf8DRPIMNAygdlSQlR"
    const units = [0, 1, 2, 3, 4, 5].map((i) => key.slice(i * 6, i * 6 + 6))
    const { out } = scan(["deploying now:", ...units, "(done)"])
    expect(flat(out)).not.toContain(key)
    expect(out).toBe("deploying now:\n(done)")
  })

  it("EXTRA FIX B: the span window STOPS at SPAN_MAX_UNITS — a seven-line wrap is out of scope by design", () => {
    // Pinning the bound, not endorsing the hole. A wrap this narrow means five
    // characters per line, which no terminal, editor or serializer produces;
    // the bound is what keeps the pass linear, and widening it was measured at
    // ~10x the cost on an adversarial field. This test exists so that changing
    // `SPAN_MAX_UNITS` — in EITHER direction — is a deliberate, visible act
    // rather than a silent one: set it to 60 and this test fails.
    const key = "sbmkYHSiA5H4eyTXQo0ZYjSvXZUdnhyfggW"
    const units = [0, 1, 2, 3, 4, 5, 6].map((i) => key.slice(i * 5, i * 5 + 5))
    const { out, logger } = scan(["deploying now:", ...units, "(done)"])
    expect(flat(out)).toContain(key)
    expect(logger).not.toHaveBeenCalled()
  })

  it("FIX 3: the span pass costs a bounded multiple of a plain scan on an adversarial field", () => {
    // The worst field the raw-field safety cap admits: whitespace-free lines,
    // so EVERY span is a candidate, each one tripping the cheap gate and then
    // being rejected, so nothing is ever dropped and no span is skipped. That
    // field measured 1700 ms (7600 units) / 912 ms (4000 units) before the
    // fix and ~230 ms / ~135 ms after.
    //
    // Asserted as a RATIO against the same field with a space in every line —
    // identical size and content class, but not a span candidate — so the bar
    // does not move with the machine. Measured on this workload: 29.8-40.2x
    // against the pre-fix build, 14.4-16.2x against a hand-reverted pre-fix
    // SHAPE (per-join re-scan, pattern first, gate un-hoisted), 4.8-5.2x now.
    const rows = 4000
    const chunk = (i: number, n: number) => ((i * 2654435761) >>> 0).toString(36).padStart(7, "x").slice(0, n)
    const adversarial: string[] = []
    const baseline: string[] = []
    for (let i = 0; i < rows; i++) {
      adversarial.push(`${chunk(i, 6)}${chunk(i + 7919, 5)},`)
      baseline.push(`${chunk(i, 6)} ${chunk(i + 7919, 5)},`)
    }
    const time = (lines: string[]) => {
      const text = lines.join("\n")
      expect(text.length).toBeLessThan(100_000) // else the field is rejected unscanned
      scanProseField(text, "recentTranscript", () => {}, 16000)
      const started = performance.now()
      scanProseField(text, "recentTranscript", () => {}, 16000)
      return performance.now() - started
    }
    const spaced = Math.max(time(baseline), 1)
    const tight = time(adversarial)
    expect(tight / spaced).toBeLessThan(10)
  })
})

describe("B-3c: a path list the scan emptied is ABSENT, not present-but-empty", () => {
  /** Three paths outside the workspace root. `toWorkspaceRelative` leaves
   * these ABSOLUTE on purpose (a `../../..` chain reads worse), so they keep
   * the length and entropy that made B-3's original list trip. */
  const OUTSIDE_ROOT = [
    "/tmp/scratch-9182/src/games/memory.js",
    "/tmp/scratch-9182/src/games/index.html",
    "/tmp/scratch-9182/src/games/breakout.js",
  ]

  it("REPRODUCES the shape: the scan deletes every path and keeps the header", () => {
    // Pinning the disease, not the cure: this is still exactly what the scan
    // does to the field. What changes below is what the payload builder makes
    // of the result.
    const summary = formatChangedPathsSummary(OUTSIDE_ROOT, "/workspace/proj")
    expect(summary).toContain("/tmp/scratch-9182/src/games/memory.js")
    expect(summary.split("\n")).toHaveLength(4)
  })

  it("the field is DROPPED, not shipped as a bare header with nothing under it", () => {
    // Before: diffSummary === "changed paths (no diff available):" — DEFINED,
    // so the insufficient-evidence guard could not fire, and only
    // verifier:field-partial-drop was logged. The judge was handed a promise
    // of a file list containing zero files, which reads as "nothing changed".
    const logger = vi.fn()
    const payload = buildVerifierPayload(b3Raw(formatChangedPathsSummary(OUTSIDE_ROOT, "/workspace/proj")), logger)
    expect(payload.diffSummary).toBeUndefined()
    expect("diffSummary" in payload).toBe(false)
    expect(logger).toHaveBeenCalledWith("verifier:field-dropped", { field: "diffSummary" })
  })

  it("so runVerifier refuses to judge when the emptied list was the only evidence", async () => {
    // The point of the fix: the hole becomes VISIBLE to the guard that exists
    // to catch it, instead of being papered over by a defined-but-empty field.
    const logger = vi.fn()
    const payload = buildVerifierPayload(b3Raw(formatChangedPathsSummary(OUTSIDE_ROOT, "/workspace/proj")), vi.fn())
    const result = await runVerifier(
      makeClient(),
      { selfCreated: new SelfCreatedSessions(), logger },
      { parentSessionID: "parent-1", sessionModel: { providerID: "minimax", modelID: "MiniMax-M3" }, payload },
    )
    expect(result).toEqual({ verdict: null, reason: "insufficient-evidence" })
    expect(mockRunSubturn).not.toHaveBeenCalled()
  })

  it("ONE surviving path is still evidence — the field is not dropped for being short", () => {
    // The other direction. This must stay narrow: a list that still names a
    // real file is real file-level evidence, and dropping it would recreate
    // B-3 itself.
    const logger = vi.fn()
    const payload = buildVerifierPayload(
      b3Raw(formatChangedPathsSummary([...OUTSIDE_ROOT, "/workspace/proj/src/a.ts"], "/workspace/proj")),
      logger,
    )
    expect(payload.diffSummary).toBe("changed paths (no diff available):\n  src/a.ts")
    expect(logger).not.toHaveBeenCalledWith("verifier:field-dropped", { field: "diffSummary" })
  })

  it("the untracked-files header alone is treated the same way", () => {
    // `computeBoundedDiffStat`'s other announcement line, same defect.
    const logger = vi.fn()
    const payload = buildVerifierPayload(b3Raw(`${UNTRACKED_FILES_HEADER}\n  /tmp/scratch-9182/src/games/breakout.js`), logger)
    expect(payload.diffSummary).toBeUndefined()
    expect(logger).toHaveBeenCalledWith("verifier:field-dropped", { field: "diffSummary" })
  })
})

describe("B-3 (d): the payload STATES why there is no diff instead of hiding the hole", () => {
  it("carries the reason through as its own field", () => {
    const logger = vi.fn()
    const payload = buildVerifierPayload(
      b3Raw("changed paths (no diff available):\n  src/games/breakout.js", {
        diffSummaryUnavailable: DIFF_UNAVAILABLE_NOT_A_REPO,
      }),
      logger,
    )
    expect(payload.diffSummaryUnavailable).toBe(DIFF_UNAVAILABLE_NOT_A_REPO)
    expect(payload.diffSummary).toContain("src/games/breakout.js")
  })

  it("is absent when the diff is real — no reason is invented", () => {
    const payload = buildVerifierPayload(b3Raw("@@ -1,1 +1,1 @@\n+ok"), vi.fn())
    expect(payload.diffSummaryUnavailable).toBeUndefined()
    expect("diffSummaryUnavailable" in payload).toBe(false)
  })

  for (const [name, reason] of [
    ["not-a-repo", DIFF_UNAVAILABLE_NOT_A_REPO],
    ["git-failed", DIFF_UNAVAILABLE_GIT_FAILED],
    ["no-changes", DIFF_UNAVAILABLE_NO_CHANGES],
  ] as const) {
    it(`the ${name} reason survives the payload scan whole (a reason that is itself redacted is another silent hole)`, () => {
      const logger = vi.fn()
      const payload = buildVerifierPayload(b3Raw("", { diffSummaryUnavailable: reason }), logger)
      expect(payload.diffSummaryUnavailable).toBe(reason)
      expect(logger).not.toHaveBeenCalledWith("verifier:field-dropped", { field: "diffSummaryUnavailable" })
    })
  }
})

describe("B-3 (d): runVerifier will not judge with neither a diff nor a transcript", () => {
  it("returns insufficient-evidence WITHOUT prompting a model", async () => {
    const logger = vi.fn()
    const result = await runVerifier(
      makeClient(),
      { selfCreated: new SelfCreatedSessions(), logger },
      {
        parentSessionID: "parent-1",
        sessionModel: { providerID: "minimax", modelID: "MiniMax-M3" },
        payload: { criteria: ["c1"], plan: "S1 complete" },
      },
    )
    expect(result).toEqual({ verdict: null, reason: "insufficient-evidence" })
    expect(mockRunSubturn).not.toHaveBeenCalled()
    expect(mockProbeCapabilityBounded).not.toHaveBeenCalled()
    expect(logger).toHaveBeenCalledWith("verifier:insufficient-evidence", { fields: ["criteria", "plan"] })
  })

  it("a diff summary ALONE is enough to proceed — a missing transcript must never disable the verifier", async () => {
    const result = await runVerifier(
      makeClient(),
      { selfCreated: new SelfCreatedSessions(), logger: vi.fn() },
      {
        parentSessionID: "parent-1",
        sessionModel: { providerID: "minimax", modelID: "MiniMax-M3" },
        payload: { diffSummary: "changed paths (no diff available):\n  src/games/breakout.js" },
      },
    )
    expect(result).toEqual({ verdict: PASS_VERDICT })
    expect(mockRunSubturn).toHaveBeenCalledTimes(1)
  })

  it("a transcript ALONE is enough to proceed — outside a git repository there may never be a diff", async () => {
    const result = await runVerifier(
      makeClient(),
      { selfCreated: new SelfCreatedSessions(), logger: vi.fn() },
      {
        parentSessionID: "parent-1",
        sessionModel: { providerID: "minimax", modelID: "MiniMax-M3" },
        payload: { recentTranscript: "assistant: I implemented the three games and ran the tests" },
      },
    )
    expect(result).toEqual({ verdict: PASS_VERDICT })
    expect(mockRunSubturn).toHaveBeenCalledTimes(1)
  })

  it("the system prompt tells the judge to cite the stated reason rather than infer nothing changed", async () => {
    await runVerifier(
      makeClient(),
      { selfCreated: new SelfCreatedSessions(), logger: vi.fn() },
      {
        parentSessionID: "parent-1",
        sessionModel: { providerID: "minimax", modelID: "MiniMax-M3" },
        payload: { diffSummary: "  src/a.ts", diffSummaryUnavailable: DIFF_UNAVAILABLE_NOT_A_REPO },
      },
    )
    const system = mockRunSubturn.mock.calls[0][3].system
    expect(system).toContain("diffSummaryUnavailable")
    expect(system).toContain("not as evidence that nothing changed")
  })
})
