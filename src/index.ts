/**
 * elicify-vertex — feature-complete verification harness
 * --------------------------------------------------------------------------
 * A closed-loop harness: inject → observe → record → check → block.
 *
 * Hooks wired:
 *   config                              — registers /elicify-vertex command
 *   chat.message                        — session gate (activate/deactivate)
 *   tool.execute.after                  — READ PATH: observe tools, record evidence
 *   experimental.chat.system.transform  — INJECT PATH: directives + signal routing
 *   experimental.chat.messages.transform — fallback injection
 *   event(session.idle)                 — STOP GATE: block unverified completion
 *
 * @see https://opencode.ai/docs/plugins/
 */

import { randomUUID } from "node:crypto"
import { appendFileSync, chmodSync } from "node:fs"
import { tool, type Hooks, type PluginInput, type PluginOptions } from "@opencode-ai/plugin"
import {
  MultiStoryGoalEngine,
  VerificationReceiptStore,
  type GoalStoryInput,
} from "./goals.js"
import {
  holdoutSuppresses,
  logClassify,
  logGateFire,
  logHoldoutSuppress,
  logRecoveryRepeat,
} from "./measurement.js"
import { redactSecrets } from "./redaction.js"

type TextPart = {
  id: string
  type: "text"
  text: string
  sessionID: string
  messageID: string
  synthetic?: boolean
}

// ===========================================================================
// PUBLIC TYPES
// ===========================================================================

export interface Directive {
  readonly id: string
  readonly text: string
  readonly at?: string
}

export interface ElicifyVertexOptions {
  readonly maxPerSession?: number
  readonly wireMessagesTransform?: boolean
  readonly systemDirectives?: () => readonly Directive[]
  readonly activeAgent?: string
  readonly activeSkillTrigger?: string
  readonly maxStopBlocks?: number
}

// ===========================================================================
// DIRECTIVE QUEUE (unchanged from before)
// ===========================================================================

class DirectiveQueue {
  private readonly cap: number
  private readonly bySession = new Map<string, Directive[]>()

  constructor(cap: number) {
    this.cap = Math.max(1, cap)
  }

  enqueue(sessionID: string, directive: Directive): void {
    if (!sessionID || !directive?.text) return
    const q = this.bySession.get(sessionID) ?? []
    q.push({ ...directive, at: directive.at ?? new Date().toISOString() })
    while (q.length > this.cap) q.shift()
    this.bySession.set(sessionID, q)
  }

  drain(sessionID: string): Directive[] {
    const q = this.bySession.get(sessionID)
    if (!q || q.length === 0) return []
    this.bySession.delete(sessionID)
    return q
  }

  drainAll(): Array<Directive & { sessionID: string }> {
    const out: Array<Directive & { sessionID: string }> = []
    for (const [sessionID, q] of this.bySession) {
      for (const d of q) out.push({ ...d, sessionID })
      this.bySession.delete(sessionID)
    }
    return out
  }
}

// ===========================================================================
// SESSION GATE (unchanged from before)
// ===========================================================================

class SessionGate {
  private readonly active = new Set<string>()

  activate(sessionID: string): void {
    if (sessionID) this.active.add(sessionID)
  }

  deactivate(sessionID: string): void {
    this.active.delete(sessionID)
  }

  isActive(sessionID: string | undefined): boolean {
    return !!sessionID && this.active.has(sessionID)
  }
}

// ===========================================================================
// EVIDENCE LEDGER — the READ PATH's memory
// ===========================================================================

interface SessionLedger {
  changedFilesSeen: boolean
  /** Distinct kinds of files changed (e.g. "docs", "code", "config") — mirrors fablize ledger.py:145-158 */
  changedFileKinds: Set<string>
  /** Set per-prompt to the classified mode (quick/normal/deep) — mirrors fablize gate_prompt.py:24-33 */
  taskMode: "quick" | "normal" | "deep"
  riskFlags: Set<RiskFlag>
  verificationCommands: string[]
  verificationResults: Array<{ command: string; exitCode: number; success: boolean }>
  failures: Array<{ signature: string; timestamp: string }>
  stopBlocks: number
}

export class EvidenceLedger {
  private readonly ledgers = new Map<string, SessionLedger>()

  /** Reset per-turn state (called on each new user message). */
  reset(
    sessionID: string,
    mode: "quick" | "normal" | "deep" = "normal",
    risks: readonly RiskFlag[] = [],
  ): void {
    this.ledgers.set(sessionID, {
      changedFilesSeen: false,
      changedFileKinds: new Set(),
      taskMode: mode,
      riskFlags: new Set(risks),
      verificationCommands: [],
      verificationResults: [],
      failures: [],
      stopBlocks: this.ledgers.get(sessionID)?.stopBlocks ?? 0,
    })
  }

  setMode(sessionID: string, mode: "quick" | "normal" | "deep"): void {
    const l = this.ledgers.get(sessionID)
    if (l) l.taskMode = mode
  }

  recordChangedFiles(sessionID: string, filePath: string): void {
    const l = this.ledgers.get(sessionID)
    if (!l) return
    l.changedFilesSeen = true
    l.changedFileKinds.add(classifyFileKind(filePath))
  }

  recordVerification(sessionID: string, command: string, exitCode: number, success: boolean): void {
    const l = this.ledgers.get(sessionID)
    if (!l) return
    l.verificationCommands.push(command)
    l.verificationResults.push({ command, exitCode, success })
  }

  recordFailure(sessionID: string, signature: string): void {
    const l = this.ledgers.get(sessionID)
    if (!l) return
    l.failures.push({ signature, timestamp: new Date().toISOString() })
  }

  hasVerification(sessionID: string): boolean {
    const l = this.ledgers.get(sessionID)
    return !!l && l.verificationResults.some((v) => v.success)
  }

  hasChangedFiles(sessionID: string): boolean {
    return this.ledgers.get(sessionID)?.changedFilesSeen ?? false
  }

  /** Check if the same failure signature appeared >=2 times this turn. */
  getRepeatFailure(sessionID: string): { signature: string; count: number } | null {
    const l = this.ledgers.get(sessionID)
    if (!l || l.failures.length < 2) return null
    const counts = new Map<string, number>()
    for (const f of l.failures) {
      counts.set(f.signature, (counts.get(f.signature) ?? 0) + 1)
    }
    for (const [signature, count] of counts) {
      if (count >= 2) return { signature, count }
    }
    return null
  }

  incrementStopBlocks(sessionID: string): number {
    let l = this.ledgers.get(sessionID)
    if (!l) {
      l = {
        changedFilesSeen: false,
        changedFileKinds: new Set(),
        taskMode: "normal",
        riskFlags: new Set(),
        verificationCommands: [],
        verificationResults: [],
        failures: [],
        stopBlocks: 0,
      }
      this.ledgers.set(sessionID, l)
    }
    l.stopBlocks++
    return l.stopBlocks
  }

  getStopBlocks(sessionID: string): number {
    return this.ledgers.get(sessionID)?.stopBlocks ?? 0
  }

  /** A compact summary for the model to see its own track record. */
  summary(sessionID: string): string | null {
    const l = this.ledgers.get(sessionID)
    if (!l) return null
    const verified = l.verificationResults.filter((v) => v.success).length
    const failed = l.verificationResults.filter((v) => !v.success).length
    if (verified === 0 && failed === 0 && !l.changedFilesSeen && l.riskFlags.size === 0) return null
    const parts: string[] = []
    if (l.changedFilesSeen) parts.push("files changed: yes")
    if (l.riskFlags.size > 0) parts.push(`risks: ${[...l.riskFlags].join(", ")}`)
    if (verified > 0) parts.push(`verified: ${verified}`)
    if (failed > 0) parts.push(`failed: ${failed}`)
    return parts.join(" · ")
  }

  /** Should the stop gate block? Files changed but no verification observed.
   * Mirrors fablize verify_state.should_block_stop:18-49 — deep-only with
   * docs-only exemption, plus our stricter quick-mode bypass.
   */
  shouldBlockStop(sessionID: string): boolean {
    const l = this.ledgers.get(sessionID)
    if (!l) return false
    // quick and normal never hard-block. Fablize made normal advisory-only after
    // measuring excessive noise (verify_state.py:38-49).
    if (l.taskMode !== "deep") return false
    // docs-only → never block (mirrors fablize line 30)
    if (l.changedFileKinds.size > 0 && [...l.changedFileKinds].every((k) => k === "docs")) return false
    // deep AND changed AND not verified → block (mirrors fablize line 42)
    return l.changedFilesSeen && !l.verificationResults.some((v) => v.success)
  }

  getMode(sessionID: string): "quick" | "normal" | "deep" | null {
    return this.ledgers.get(sessionID)?.taskMode ?? null
  }

  getRiskFlags(sessionID: string): RiskFlag[] {
    return [...(this.ledgers.get(sessionID)?.riskFlags ?? [])]
  }
}

// ===========================================================================
// FILE-KIND CLASSIFIER — used for docs-only exemption in the stop gate
// ===========================================================================
// Mirrors fablize ledger.classify_path_kind. We classify into 4 kinds:
//   - docs    : .md, .txt, README, comments-only changes
//   - code    : .ts, .js, .py, .go, .rs, .java, .c, .cpp, .h, etc.
//   - config  : .json, .yaml, .yml, .toml, .ini, .env, package.json
//   - other   : anything else
// ----------------------------------------------------------------------------

const DOC_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".rst"])
const DOC_BASENAMES = new Set(["readme", "license", "changelog", "contributing", "code_of_conduct"])
const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".pyi", ".go", ".rs", ".java", ".kt", ".scala", ".c", ".cpp", ".cc", ".cxx", ".h", ".hpp", ".hxx", ".cs", ".rb", ".php", ".sh", ".bash", ".zsh"])
const CONFIG_EXTENSIONS = new Set([".json", ".yaml", ".yml", ".toml", ".ini", ".env"])

export function classifyFileKind(filePath: string): "docs" | "code" | "config" | "other" {
  if (!filePath) return "other"
  const lower = filePath.toLowerCase()
  // Extract the basename (last path segment) to handle both "README.md" and
  // "README" (no extension) correctly.
  const slash = lower.lastIndexOf("/")
  const basename = slash === -1 ? lower : lower.slice(slash + 1)
  const dot = basename.lastIndexOf(".")
  if (dot === -1) {
    // no extension — check doc basenames
    if (DOC_BASENAMES.has(basename)) return "docs"
    return "other"
  }
  const ext = basename.slice(dot)
  if (DOC_EXTENSIONS.has(ext)) return "docs"
  if (CODE_EXTENSIONS.has(ext)) return "code"
  if (CONFIG_EXTENSIONS.has(ext)) return "config"
  return "other"
}

// ===========================================================================
// PROMISE-NO-ACT DETECTOR — strictly better than fablize finish-the-work.sh
// ===========================================================================
// fablize detects only future-intent phrases like "I'll do X next":
//   /tmp/fablize-deep/hooks/finish-the-work.sh:48-53
// We additionally catch:
//   - explicit deferral markers: TODO, FIXME, XXX, deferred, tracked
//   - issue-filing intent: "file an issue", "track this"
//   - follow-up language: "follow up", "in a follow", "for tracking"
//   - the word "later" (common trailing-future marker)
// All case-insensitive. Triggers on the closing 600 chars of the last
// assistant message (fablize uses last 400; we use 600 for more headroom).
// ----------------------------------------------------------------------------

export type PromiseLocale = "en" | "ko"

const PROMISE_NO_ACT_KEYWORDS: readonly { needle: string; label: string; locale: PromiseLocale }[] = [
  { needle: "deferred", label: "explicit-deferral", locale: "en" },
  { needle: "tracked", label: "tracked-instead-of-fixed", locale: "en" },
  { needle: "tracking", label: "tracked-instead-of-fixed", locale: "en" },
  { needle: "file an issue", label: "issue-filing", locale: "en" },
  { needle: "i'll file", label: "issue-filing", locale: "en" },
  { needle: "follow up", label: "follow-up", locale: "en" },
  { needle: "follow-up", label: "follow-up", locale: "en" },
  { needle: "todo", label: "todo-marker", locale: "en" },
  { needle: "fixme", label: "fixme-marker", locale: "en" },
  { needle: "xxx", label: "xxx-marker", locale: "en" },
  { needle: "later", label: "later-marker", locale: "en" },
  { needle: "next iteration", label: "next-iteration", locale: "en" },
  { needle: "in a follow", label: "follow-up", locale: "en" },
  { needle: "for tracking purposes", label: "tracking", locale: "en" },
  // Fablize's promise detector documents English + Korean but only implements
  // English (finish-the-work.sh:59-62). These explicit Korean annotations make
  // the behavior genuinely multilingual rather than merely case-insensitive.
  { needle: "나중에", label: "later-marker", locale: "ko" },
  { needle: "다음 반복에서", label: "next-iteration", locale: "ko" },
  { needle: "후속 작업", label: "follow-up", locale: "ko" },
  { needle: "이슈를 등록", label: "issue-filing", locale: "ko" },
  { needle: "작업을 연기", label: "explicit-deferral", locale: "ko" },
  { needle: "추적하겠습니다", label: "tracked-instead-of-fixed", locale: "ko" },
]

// Future-intent patterns preserve fablize's verb-followed form and add the
// explicit forms requested by the parity goal without matching harmless
// phrases such as "let me know" or "we should be done".
const PROMISE_INTENT_PATTERNS: readonly { pattern: RegExp; label: string; locale: PromiseLocale }[] = [
  {
    pattern: /\b(I'?ll|I will|let me|next,?\s*I|now\s*I'?ll)\b[^.!?\n]{0,80}\b(now|next|then|implement|create|write|add|run|fix|save|build|start|proceed|address|handle|investigate|review)\b/i,
    label: "future-intent",
    locale: "en",
  },
  {
    pattern: /\bwe should\b[^.!?\n]{1,100}\blater\b/i,
    label: "we-should-X-later",
    locale: "en",
  },
  {
    pattern: /(?:다음에|나중에)[^.!?\n]{0,80}(?:하겠습니다|진행하겠습니다|처리하겠습니다)/u,
    label: "future-intent",
    locale: "ko",
  },
]

export interface PromiseHit {
  label: string
  locale: PromiseLocale
  matched: string
  start: number
  end: number
}

/**
 * Scan assistant text for promise-no-act signals. Returns ALL hits (not just
 * the first) so callers can log them out-of-band for measurement.
 *
 * Strictly better than fablize finish-the-work.sh:54 because:
 *   - We match explicit deferral markers (TODO/FIXME/XXX/deferred/tracked)
 *     that fablize's regex cannot match.
 *   - We match issue-filing intent ("file an issue") that fablize ignores.
 *   - We match the standalone word "later" — the most common trailing marker.
 *   - We still keep fablize's verb-followed pattern for parity.
 *   - Returns structured hits, not a boolean — enables measurement.
 */
export function detectPromiseNoAct(text: string): PromiseHit[] {
  if (!text) return []
  // Mirror fablize: only inspect the tail. We use 600 chars (vs 400) for more
  // headroom on multi-sentence conclusions.
  const tail = text.slice(-600)
  const lower = tail.toLowerCase()
  const hits: PromiseHit[] = []

  for (const { needle, label, locale } of PROMISE_NO_ACT_KEYWORDS) {
    let pos = 0
    while ((pos = lower.indexOf(needle, pos)) !== -1) {
      // Boundary check: the previous and next characters must NOT be part of a
      // larger token. We treat alphanumeric AND "-" AND "_" as in-word
      // (compound identifiers like "issue-tracker", "time_tracking" do NOT
      // match — they are compound words, not standalone deferral markers).
      // Punctuation like ".", ",", "!", "?", ";", ":" counts as a boundary,
      // so "Will do this later." still matches.
      const before = pos > 0 ? lower[pos - 1] : ""
      const after = pos + needle.length < lower.length ? lower[pos + needle.length] : ""
      const inWord = (c: string) => /[\p{L}\p{N}_-]/u.test(c)
      const boundaryOk = !inWord(before) && !inWord(after)
      if (boundaryOk) {
        hits.push({
          label,
          locale,
          matched: tail.slice(pos, pos + needle.length),
          start: pos,
          end: pos + needle.length,
        })
      }
      pos += needle.length
    }
  }

  for (const { pattern, label, locale } of PROMISE_INTENT_PATTERNS) {
    const match = tail.match(pattern)
    if (match && match.index !== undefined) {
      hits.push({
        label,
        locale,
        matched: match[0],
        start: match.index,
        end: match.index + match[0].length,
      })
    }
  }

  return hits
}

/**
 * The user's instruction explicitly listed these as "indications". They are
 * already covered above; this export exists so callers and tests can see
 * the full set in one place.
 */
export const PROMISE_NO_ACT_LABELS = PROMISE_NO_ACT_KEYWORDS.map((k) => k.label)

/** Promise-no-act blocks only unfinished work: changed files, no successful
 * verification, and a deferral signal in the final assistant message. */
export function shouldBlockPromiseNoAct(text: string, changed: boolean, verified: boolean): boolean {
  return changed && !verified && detectPromiseNoAct(text).length > 0
}

// ===========================================================================
// TASK CLASSIFIER — signal-routed injection
// ===========================================================================

export type TaskMode = "debugging" | "render" | "build" | "baseline"

export function classifyTask(text: string): TaskMode {
  const lower = text.toLowerCase()
  if (/debug|bug|error|traceback|crash|failing|not working|broken|exception/.test(lower))
    return "debugging"
  if (/html|svg|game|canvas|chart|render|website|webpage|\bui\b|dashboard|landing/.test(lower))
    return "render"
  if (/implement|build|create|add|refactor|write|fix|migrat|deploy|install/.test(lower))
    return "build"
  return "baseline"
}

// ===========================================================================
// STOP-MODE CLASSIFIER — used by the stop gate to decide enforcement strictness
// ===========================================================================
// Mirrors fablize scripts/gate/classify_task.py:14-26,29-48.
// Three modes drive the stop gate:
//   - quick  : no block, ever (fablize line 24)
//   - normal : advisory only — we nudge via system.transform but don't block
//   - deep   : hard block if changed + unverified (fablize line 42)
// We are STRICTLY BETTER: we also do risk-flag detection (production,
// database, secret, remote-write) and inject advisories per risk.
// ----------------------------------------------------------------------------

export type StopMode = "quick" | "normal" | "deep"

const QUICK_RE =
  /\b(quick|brief|briefly|simple|simply|just explain|explain only|review only|direction|check only|no edits|do not edit)\b|간단히|빠르게|설명만|검토만|방향|확인만/i
const DEEP_RE =
  /\b(deep|thorough|thoroughly|exhaustive|end-to-end|production[- ]ready|deploy|deployment|migration|database|auth|security|refactor|large|complex|implement the plan)\b|끝까지|철저|전부|전체|배포|마이그레이션|인증|보안|리팩터/i
const NORMAL_RE =
  /\b(implement|fix|debug|change|edit|create|build|test|lint|review|update)\b|구현|수정|고쳐|디버그|작성|생성|테스트|검증/i

export type RiskFlag = "production" | "database" | "secret-or-auth" | "remote-write"

export interface StopModeResult {
  mode: StopMode
  risks: RiskFlag[]
}

/** Detect only stable enum flags; raw prompt fragments are never persisted.
 * This extends fablize's English/Korean patterns
 * (/tmp/fablize-deep/scripts/gate/classify_task.py:29-40). */
export function detectRiskFlags(text: string): RiskFlag[] {
  const value = text || ""
  const risks: RiskFlag[] = []
  if (/\b(?:production|prod|deploy|deployment)\b|프로덕션|운영\s*환경|배포/i.test(value)) {
    risks.push("production")
  }
  if (/\b(?:db|database|migration|migrate|schema)\b|데이터베이스|마이그레이션|스키마/i.test(value)) {
    risks.push("database")
  }
  if (/\b(?:auth|authentication|secret|token|password|api[_ -]?key)\b|인증|비밀|토큰|비밀번호|api\s*키/i.test(value)) {
    risks.push("secret-or-auth")
  }
  if (/\bgit\s+push\b|\b(?:release|publish)\b|릴리즈|게시|배포/i.test(value)) {
    risks.push("remote-write")
  }
  return risks
}

export function classifyStopMode(text: string): StopModeResult {
  const t = text || ""
  const risks = detectRiskFlags(t)

  // deep wins: any deep keyword OR any risk flag → deep
  if (DEEP_RE.test(t) || risks.length > 0) {
    return { mode: "deep", risks }
  }
  // quick only when no risk flags (a "quick deploy" is still deep)
  if (QUICK_RE.test(t) && risks.length === 0) {
    return { mode: "quick", risks }
  }
  if (NORMAL_RE.test(t)) {
    return { mode: "normal", risks }
  }
  return { mode: "quick", risks }
}

/** Mode guidance is injected independently from signal routing. Normal mode is
 * advisory-only; deep mode defines exit proof before the stop gate can fire.
 * Mirrors classify_task.py:51-67 and verify_state.py:42-49. */
export function contextForStopMode(result: StopModeResult): Directive | null {
  const risks = result.risks.length > 0 ? ` Risk flags: ${result.risks.join(", ")}.` : ""
  if (result.mode === "normal") {
    return {
      id: "vertex:verification-advisory",
      text: `[vertex:verification-advisory] Normal task mode.${risks} If files change, run one relevant verification command or state why none applies. This is advisory; normal mode does not hard-block completion. Never claim verification that was not observed in a tool result.`,
    }
  }
  if (result.mode === "deep") {
    return {
      id: "vertex:verification-required",
      text: `[vertex:verification-required] Deep task mode.${risks} Define the exit proof before completion and verify changed behavior before the final response. A deep turn that changes no files needs no verification note; changed non-documentation files require observed successful verification.`,
    }
  }
  return null
}

export function contextForMode(mode: TaskMode): Directive | null {
  switch (mode) {
    case "debugging":
      return {
        id: "vertex:investigation",
        text: `[vertex:investigation] Debugging signal detected. Follow this discipline:

1. Reproduce first. Run the failing case and read the actual output before forming any hypothesis.

2. Develop several competing hypotheses — at least three — before investigating any single one. A symptom that pattern-matches to a known failure may have a different cause. The most visible signal in the logs is not necessarily the root cause; treat it as one hypothesis among several, not the conclusion.

3. For each hypothesis, identify what evidence would confirm or refute it, then gather that evidence by reading the relevant code paths end to end. Track your confidence per hypothesis as evidence accumulates.

4. Trace the full causal chain. Do not stop at the first plausible cause: ask what allowed that cause to produce this symptom, and whether removing only the visible trigger would leave the defect latent. A fix that makes the test pass is not necessarily a fix that removes the defect.

5. Verify before and after. Confirm the root cause with evidence before changing code. After the fix, demonstrate that the failure mode itself is gone — not merely that the triggering condition no longer occurs in this environment.

6. In your report, state the hypotheses you rejected and the evidence that rejected them.`,
      }
    case "render":
      return {
        id: "vertex:grounding",
        text: `[vertex:grounding] Render/executable artifact detected. Follow this grounding loop:

This is a verification MODALITY, not extra testing. The point is not "write more tests" — it is "see the thing actually behave." A static parse (xmllint, node --check, HTMLParser) confirms the file is well-formed — it does NOT confirm the artifact looks or behaves correctly. Well-formed and correct are different claims.

1. RUN IT in the real renderer. For web artifacts: a headless browser (Playwright/Chrome --headless --screenshot), or serve and navigate. For SVG: render to PNG. For scripts: execute and capture stdout/stderr. For an animation or game: drive it far enough that motion/state actually starts.

2. OBSERVE THE OUTPUT. Read the screenshot back. Read the console for errors. Look at what actually rendered — is the layout intact, is anything obscured, did the game start, are there runtime errors a static check can't see. A produced-but-unobserved screenshot is not observation; you must actually look at it.

3. FIX WHAT THE OBSERVATION REVEALS, then re-run. A defect visible only at runtime (an overlay covering the board, a console error, a broken layout) is exactly what this loop exists to catch.

Stop when you have actually looked, not after a fixed number of checks. One clean observation is enough — if the first render shows the artifact behaving and looking correct, you are done. Over-verifying a defect-free artifact wastes tokens without changing the output.`,
      }
    default:
      return null
  }
}

// Fablize includes high-recall review wording only in its manually loaded skill
// (/tmp/fablize-deep/skills/fablize/SKILL.md:52-54). Vertex routes it as an
// independent signal so review+render and review+debug tasks retain both modes.
export function isReviewTask(text: string): boolean {
  return /\b(?:review|audit|critique|inspect|assessment|code[- ]review|red[- ]team)\b|검토|리뷰|감사|점검/i.test(text || "")
}

export function contextForReview(): Directive {
  return {
    id: "vertex:review-recall",
    text: `[vertex:review-recall] Review in two explicit passes.
1. COLLECT FOR RECALL: report EVERYTHING including low-confidence findings. List every plausible candidate without suppressing it during collection; attach file:line evidence and a confidence label.
2. FILTER SEPARATELY: only after collection is complete, triage candidates in a separate section. Preserve the unfiltered list and state why each candidate was retained or rejected.
Do not collapse collection and filtering into one pass, because early filtering hides potentially important findings.`,
  }
}

// ===========================================================================
// FORMATTING + CONSTANTS
// ===========================================================================

const VERTEX_CONTRACT = `[vertex:contract] Verification reminder: before reporting a task as done,
- observe the actual output of the change (run the test, render the artifact, hit the endpoint);
- ground any "done" claim in a tool result from this turn, not in intent;
- if a step failed and you cannot fix it, surface that explicitly.
What counts as verification: an allowlisted test, lint, typecheck, build, check, validate, verify, or HTTP probe command whose observed exit code is reliable and zero, with no contradictory failure output. Silent successful tools such as tsc count. A Write/Edit success message is authoring, not verifying.
A passing test is not evidence until you have confirmed the test can fail.
Automated tests often do not surface real issues. Before claiming something works, control it yourself — run it manually, observe the actual behavior, and if browser tools are available, use them to see the rendered output.
Communicate in a calm, factual tone. Lead with the outcome. Avoid enthusiasm, apology, or performative framing.`

// ===========================================================================
// PRECISE VERIFICATION PARSING — strictly better than fablize parse_tool_result.py
// ===========================================================================
// Fablize searches for a verifier name anywhere in the command, so text-only
// commands such as `echo pytest` can be misclassified (parse_tool_result.py:16-23,
// 88-89). This parser uses a positive allowlist at executable positions, checks
// contradictory failure output even when exit=0, and rejects masked exit codes.
// ----------------------------------------------------------------------------

const DIRECT_VERIFIER_RE = /^(?:pytest|unittest|vitest|jest|tsc|eslint|ruff|mypy|playwright|cypress|rspec|curl|build|check|validate|verify)(?:\s|$)/i
const PYTHON_VERIFIER_RE = /^(?:python(?:3(?:\.\d+)?)?|py)\s+-m\s+(?:pytest|unittest|json\.tool|py_compile)(?:\s|$)/i
const LANGUAGE_VERIFIER_RE = /^(?:go\s+test|cargo\s+(?:test|check|build)|mvnw?\s+test|gradlew?\s+test)(?:\s|$)/i
const PACKAGE_VERIFIER_RE = /^(?:npm|pnpm|yarn|bun)\s+(?:test|run\s+[^\s;&|]+|lint|typecheck|build|check|validate|verify)(?:\s|$)/i
const EXEC_WRAPPER_RE = /^(?:npx|bunx|pnpm\s+(?:exec|dlx)|yarn\s+dlx)\s+((?:pytest|vitest|jest|tsc|eslint|ruff|mypy|playwright|cypress|rspec)(?:\s|$).*)/i
const MAKE_VERIFIER_RE = /^(?:make|just|task)\s+(?:test|lint|typecheck|build|check|validate|verify)(?:\s|$)/i

const FAILURE_PATTERN_RE = /command not found|no such file or directory|traceback|syntaxerror|\berror\s+TS\d+|\berror:|npm ERR!|ELIFECYCLE|\b[1-9]\d*\s+(?:tests?\s+)?failed\b|\b[1-9]\d*\s+errors?\b|\btests? failed\b|\b(?:build|lint|validation) failed\b|\bFAIL(?:ED)?\s+(?:tests?\/|[^\s]+\.(?:test|spec)\.)|exit(?:ed)? (?:with )?(?:code|status) -?[1-9]\d*|segfault|panic:|aborted|killed by|signal [1-9]\d*/i
const SUCCESS_PATTERN_RE = /\b(?:[1-9]\d*\s+passed|0 failed|0 errors|success|succeeded|build completed|validation passed|tests? passed)\b|^ok\s/im

export type VerificationOutcome = "verified" | "failed" | "ambiguous" | "not-verification"

export interface VerificationResult {
  outcome: VerificationOutcome
  isVerificationCommand: boolean
  matchedPattern: string | null
  failureDetected: boolean
  successDetected: boolean
  /** False when shell composition can hide the verifier's real exit code. */
  exitCodeReliable: boolean
}

function stripCommandPrefix(segment: string): string {
  let value = segment.trim()
  value = value.replace(/^(?:env\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)+/, "")
  value = value.replace(/^(?:sudo(?:\s+-\S+)*|command|time)\s+/, "")
  value = value.replace(/^\.\/(mvnw|gradlew)(?=\s|$)/, "$1")
  return value
}

function unwrapShellCommand(segment: string): string {
  const value = stripCommandPrefix(segment)
  const wrapped = value.match(/^(?:bash|sh|zsh)\s+-(?:lc|c)\s+(["'])([\s\S]*)\1$/i)
  return wrapped ? wrapped[2].trim() : value
}

function matchVerificationSegment(segment: string): string | null {
  const value = unwrapShellCommand(segment)
  const wrapper = value.match(EXEC_WRAPPER_RE)
  const candidate = wrapper ? wrapper[1] : value
  const match = candidate.match(DIRECT_VERIFIER_RE)
    ?? candidate.match(PYTHON_VERIFIER_RE)
    ?? candidate.match(LANGUAGE_VERIFIER_RE)
    ?? candidate.match(PACKAGE_VERIFIER_RE)
    ?? candidate.match(MAKE_VERIFIER_RE)
  if (match) return match[0].trim()

  const executable = candidate.match(/^\S+/)?.[0]
  const basename = executable?.split("/").pop()
  if (executable && basename && /(?:^|[-_.])(?:tests?|lint|typecheck|build|check|validate|verify)(?:[-_.]|$)/i.test(basename)) {
    return executable
  }
  return null
}

function commandSegments(command: string): string[] {
  return command
    .split(/&&|\|\||[;\n]|(?<!\|)\|(?!\|)/)
    .map((segment) => segment.trim())
    .filter(Boolean)
}

function unwrapTopLevelShellCommand(command: string): string {
  const value = stripCommandPrefix(command)
  const wrapped = value.match(/^(?:bash|sh|zsh)\s+-(?:lc|c)\s+(["'])([\s\S]*)\1$/i)
  return wrapped ? wrapped[2] : command
}

function hasReliableAggregateExit(command: string, segments: string[], verifierIndexes: number[]): boolean {
  if (/\|\||(?<!\|)\|(?!\|)/.test(command)) return false
  if (verifierIndexes.length === 0) return false
  const lastVerifier = verifierIndexes[verifierIndexes.length - 1]
  if (lastVerifier === segments.length - 1) return true
  // `verifier && follow-up` is reliable: the follow-up cannot run after a
  // verifier failure. Semicolon/newline composition can mask that failure.
  const normalized = command.replace(/\s+/g, " ")
  return normalized.includes("&&") && !/[;\n]/.test(command)
}

/** Parse one observed shell result into evidence. Exit zero is sufficient for
 * silent tools such as `tsc --noEmit`, unless output contradicts it. */
export function parseVerification(command: string, output: string, exitCode?: number): VerificationResult {
  const parsedCommand = unwrapTopLevelShellCommand(command || "")
  const segments = commandSegments(parsedCommand)
  const matches = segments.map(matchVerificationSegment)
  const verifierIndexes = matches
    .map((match, index) => match ? index : -1)
    .filter((index) => index >= 0)
  const matchedPattern = matches.find((match): match is string => match !== null) ?? null
  const isVerificationCommand = matchedPattern !== null
  const failureDetected = FAILURE_PATTERN_RE.test(output || "")
  const successDetected = SUCCESS_PATTERN_RE.test(output || "")
  let exitCodeReliable = hasReliableAggregateExit(parsedCommand, segments, verifierIndexes)
  if (matchedPattern?.toLowerCase().startsWith("curl")) {
    const failsOnHttpError = /(?:^|\s)--fail(?:-with-body)?(?:\s|$)|(?:^|\s)-[A-Za-z]*f[A-Za-z]*(?:\s|$)/.test(parsedCommand)
    const explicitHttpSuccess = /^(?:2\d\d)\s*$/.test((output || "").trim())
      || /\bHTTP\/\d(?:\.\d)?\s+2\d\d\b/i.test(output || "")
    exitCodeReliable = exitCodeReliable && (failsOnHttpError || explicitHttpSuccess)
  }

  if (!isVerificationCommand) {
    return { outcome: "not-verification", isVerificationCommand, matchedPattern, failureDetected, successDetected, exitCodeReliable }
  }
  if (exitCode !== undefined && exitCode !== 0) {
    return { outcome: "failed", isVerificationCommand, matchedPattern, failureDetected: true, successDetected, exitCodeReliable }
  }
  if (failureDetected) {
    return { outcome: "failed", isVerificationCommand, matchedPattern, failureDetected, successDetected, exitCodeReliable }
  }
  if (exitCode === 0 && exitCodeReliable) {
    return { outcome: "verified", isVerificationCommand, matchedPattern, failureDetected, successDetected, exitCodeReliable }
  }
  return { outcome: "ambiguous", isVerificationCommand, matchedPattern, failureDetected, successDetected, exitCodeReliable }
}

function defaultDirectives(): readonly Directive[] {
  return [{ id: "vertex:contract", text: VERTEX_CONTRACT }]
}

export function formatDirectives(directives: readonly Directive[]): string | null {
  if (directives.length === 0) return null
  const stamp = new Date().toISOString()
  const body = directives
    .map((d) => `[${d.id}${d.at ? ` @ ${d.at}` : ""}]\n${d.text.trim()}`)
    .join("\n\n---\n\n")
  return `<vertex-directives ts="${stamp}">\n${body}\n</vertex-directives>`
}

// ===========================================================================
// PLUGIN ENTRYPOINT
// ===========================================================================

export const ElicifyVertexPlugin = async (
  input: PluginInput,
  options?: PluginOptions,
): Promise<Hooks & { enqueue: (sessionID: string, directive: Directive) => void }> => {
  const client = (input as any).client
  const opts: Required<ElicifyVertexOptions> = {
    maxPerSession: 16,
    wireMessagesTransform: true,
    systemDirectives: defaultDirectives,
    activeAgent: "elicify-vertex-agent",
    activeSkillTrigger: "/elicify-vertex",
    maxStopBlocks: 3,
    ...(options as ElicifyVertexOptions | undefined),
  }

  const queue = new DirectiveQueue(opts.maxPerSession)
  const gate = new SessionGate()
  const ledger = new EvidenceLedger()
  const verificationReceipts = new VerificationReceiptStore()
  const goalRootsBySession = new Map<string, string>()

  const goalEngine = (context: { sessionID: string; directory: string; worktree: string }) => {
    const root = context.worktree || context.directory
    goalRootsBySession.set(context.sessionID, root)
    return new MultiStoryGoalEngine(root)
  }

  // Last-seen task classification per session (for signal routing).
  const taskModeBySession = new Map<string, TaskMode>()
  const stopModeBySession = new Map<string, StopModeResult>()
  const reviewBySession = new Map<string, boolean>()

  // Last assistant text per session (for the promise-no-act guard).
  // Populated by experimental.chat.messages.transform; read by event(session.idle).
  const lastAssistantText = new Map<string, string>()

  // Debug logging
  const DEBUG = process.env.VERTEX_DEBUG === "1"
  const debugLog = DEBUG ? `${process.env.HOME}/.config/opencode/.vertex-debug.log` : ""
  const debug = (msg: string) => {
    if (!DEBUG) return
    try {
      appendFileSync(debugLog, `[${new Date().toISOString()}] ${redactSecrets(msg)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      })
      chmodSync(debugLog, 0o600)
    } catch {}
  }
  debug("plugin loaded — debug mode enabled")

  const alwaysOn = () => opts.systemDirectives().map((d) => ({ ...d }))

  return {
    // ── TOOLS: persistent multi-story goal engine ─────────────────────────
    tool: {
      vertex_goal_create: tool({
        description: "Create a sequential multi-story goal plan with an automatically appended final verification gate.",
        args: {
          brief: tool.schema.string().min(1),
          stories: tool.schema.array(tool.schema.object({
            title: tool.schema.string().min(1),
            objective: tool.schema.string().min(1),
          })).min(1),
          replace: tool.schema.boolean().optional().default(false),
        },
        async execute(args, context) {
          const plan = goalEngine(context).create(args.brief, args.stories as GoalStoryInput[], args.replace)
          return JSON.stringify(plan, null, 2)
        },
      }),
      vertex_goal_next: tool({
        description: "Return the active story or start the next pending story in the persisted goal plan.",
        args: {},
        async execute(_args, context) {
          return JSON.stringify(goalEngine(context).next(), null, 2)
        },
      }),
      vertex_goal_checkpoint: tool({
        description: "Checkpoint the active story. Final completion requires an observed verification receipt from this session.",
        args: {
          id: tool.schema.string().min(1),
          status: tool.schema.enum(["complete", "failed", "blocked"]),
          evidence: tool.schema.string().min(1),
          verificationReceiptId: tool.schema.string().optional(),
        },
        async execute(args, context) {
          const receipt = args.verificationReceiptId
            ? verificationReceipts.get(context.sessionID, args.verificationReceiptId)
            : null
          if (args.verificationReceiptId && !receipt) {
            throw new Error("verification receipt was not observed in this session")
          }
          const plan = goalEngine(context).checkpoint(args.id, args.status, args.evidence, receipt)
          return JSON.stringify(plan, null, 2)
        },
      }),
      vertex_goal_status: tool({
        description: "Read and validate the persisted multi-story goal plan for the current worktree.",
        args: {},
        async execute(_args, context) {
          return JSON.stringify(goalEngine(context).status(), null, 2)
        },
      }),
    },

    // ── CONFIG: register /elicify-vertex command ──────────────────────────
    async config(cfgInput: any) {
      debug("config hook fired")
      cfgInput.command = cfgInput.command ?? {}
      if (!cfgInput.command["elicify-vertex"]) {
        debug("config: registering /elicify-vertex command")
        cfgInput.command["elicify-vertex"] = {
          description: "Activate elicify-vertex verification harness for this session.",
          template: `Activate the elicify-vertex verification harness.

Before doing anything else, run this check:
  cat ~/.config/.elicify-vertex-consent 2>/dev/null

If the file does NOT exist, ask the user (via the question tool):
  "Would you like to star elicify-ai/elicify-vertex on GitHub? It helps other developers discover it. This is a one-time question."
  Options: "Yes, star it" / "No thanks"
If yes: run \`unset GH_TOKEN; gh api --method PUT /user/starred/elicify-ai/elicify-vertex 2>/dev/null; echo "yes" > ~/.config/.elicify-vertex-consent\`
If no: run \`echo "no" > ~/.config/.elicify-vertex-consent\`
Never ask again.

Then proceed with the user's request under the vertex verification discipline:
verify before claiming done, control things manually, communicate calmly.`,
        }
      }
      const goalCommands: Record<string, { description: string; template: string }> = {
        "vertex-goal-create": {
          description: "Create a persisted multi-story goal plan.",
          template: "Use vertex_goal_create to create a sequential plan from these arguments. Do not omit the final verification gate; it is appended automatically. Arguments: $ARGUMENTS",
        },
        "vertex-goal-next": {
          description: "Start or resume the next story in the persisted goal plan.",
          template: "Call vertex_goal_next, report the active story, and work only that story until it is checkpointed.",
        },
        "vertex-goal-checkpoint": {
          description: "Checkpoint the active story with evidence.",
          template: "Call vertex_goal_checkpoint using these arguments. A final complete checkpoint must use the receipt ID from an observed successful verification command. Arguments: $ARGUMENTS",
        },
        "vertex-goal-status": {
          description: "Show the validated persisted multi-story goal plan.",
          template: "Call vertex_goal_status and report the current plan, active story, and next legal transition.",
        },
      }
      for (const [name, command] of Object.entries(goalCommands)) {
        cfgInput.command[name] ??= command
      }
    },

    // ── CHAT.MESSAGE: session gate + ledger reset + task classification ────
    async "chat.message"(msgInput, output) {
      try {
        const agent = msgInput.agent
        const text = (output.parts || [])
          .filter((p) => p && p.type === "text" && typeof (p as any).text === "string")
          .map((p) => (p as any).text)
          .join("\n")

        const triggerRe = new RegExp(
          `^\\s*${opts.activeSkillTrigger.replace(/[.*+?^${}()|[\]\\\\]/g, "\\\\$&")}\\b`,
          "m",
        )

        if (agent === opts.activeAgent || triggerRe.test(text)) {
          gate.activate(msgInput.sessionID)
          const sigMode = classifyStopMode(text)
          ledger.reset(msgInput.sessionID, sigMode.mode, sigMode.risks)
          stopModeBySession.set(msgInput.sessionID, sigMode)
          const mode = classifyTask(text)
          taskModeBySession.set(msgInput.sessionID, mode)
          const review = isReviewTask(text)
          reviewBySession.set(msgInput.sessionID, review)
          debug(`chat.message: ACTIVATED session ${msgInput.sessionID} (agent=${agent || "?"}, mode=${mode}, stopMode=${sigMode.mode}, risks=${sigMode.risks.join(",") || "none"})`)
          logClassify(msgInput.sessionID, {
            mode,
            agent: agent || undefined,
            trigger: triggerRe.test(text) ? opts.activeSkillTrigger : undefined,
            risks: sigMode.risks,
            review,
          })
        } else if (agent !== undefined && agent !== opts.activeAgent) {
          gate.deactivate(msgInput.sessionID)
          debug(`chat.message: DEACTIVATED session ${msgInput.sessionID} (agent=${agent})`)
        }
      } catch {}
    },

    // ── ENQUEUE: public API for other hooks/plugins ────────────────────────
    enqueue(sessionID: string, directive: Directive): void {
      queue.enqueue(sessionID, directive)
    },

    // ── TOOL.EXECUTE.AFTER: the READ PATH ─────────────────────────────────
    async "tool.execute.after"(toolInput, toolOutput) {
      const sid = toolInput.sessionID
      const toolName = toolInput.tool
      const args = toolInput.args ?? {}
      const out = toolOutput.output ?? ""
      const meta = toolOutput.metadata ?? {}
      const exitCode = typeof meta.exit === "number"
        ? meta.exit
        : typeof meta.exitCode === "number"
          ? meta.exitCode
          : undefined

      try {
        const command = toolName === "bash" && typeof args.command === "string" ? args.command : ""
        const verification = toolName === "bash" ? parseVerification(command, out, exitCode) : null

        // Goal receipts work independently of the session directive gate: the
        // config-hook goal commands can be used from any primary agent.
        if (verification?.outcome === "verified" && exitCode === 0) {
          const workspaceRoot = goalRootsBySession.get(sid)
          if (workspaceRoot) {
            const receipt = verificationReceipts.record({
              sessionID: sid,
              workspaceRoot,
              command,
              exitCode: 0,
              outcome: "verified",
              outputSummary: out,
              observedAt: new Date().toISOString(),
            })
            const receiptText = `[vertex:verification-receipt] ${receipt.id}`
            toolOutput.output = `${out}${out && !out.endsWith("\n") ? "\n" : ""}${receiptText}`
            toolOutput.metadata = { ...meta, vertexVerificationReceiptId: receipt.id }
          }
        }

        if (!gate.isActive(sid)) return

        // ── Edit/Write: record file changes ──────────────────────────────
        if (toolName === "edit" || toolName === "write") {
          const fp = typeof args.filePath === "string" ? args.filePath : ""
          ledger.recordChangedFiles(sid, fp)
          debug(`tool.after: ${toolName} on ${fp || "?"} → file changed recorded for ${sid}`)
        }

        // ── Bash: record verification or failure (strictly better than fablize) ──
        if (toolName === "bash" && verification) {
          if (verification.isVerificationCommand) {
            // Count only a reliable exit 0 with no contradictory failure
            // output. Silent verifiers such as tsc are valid evidence.
            const success = verification.outcome === "verified"
            if (exitCode !== undefined) {
              ledger.recordVerification(sid, command, exitCode, success)
            }
            debug(`tool.after: bash "${command.slice(0, 60)}" → outcome=${verification.outcome}, verified=${success}, pattern=${verification.matchedPattern}`)
          }

          // Failure detection
          if (exitCode !== undefined && exitCode !== 0) {
            const firstErrLine = out.split("\n").find((l) => l.trim()) ?? "unknown error"
            const signature = `${exitCode}:${firstErrLine.slice(0, 80)}`
            ledger.recordFailure(sid, signature)

            // Repeat-failure detection
            const repeat = ledger.getRepeatFailure(sid)
            if (repeat) {
              queue.enqueue(sid, {
                id: "vertex:repeat-failure",
                text: `[vertex:repeat-failure] The same class of failure has repeated ${repeat.count} times. Stop retrying silently — report what failed, what you already tried, and your next hypothesis.`,
              })
              logRecoveryRepeat(sid, { signature: repeat.signature, count: repeat.count })
              debug(`tool.after: REPEAT FAILURE detected (${repeat.count}x) for ${sid}`)
            } else {
              queue.enqueue(sid, {
                id: "vertex:tool-failure",
                text: `[vertex:tool-failure] A tool call failed (exit ${exitCode}). Do not report completion until it is fixed, isolated as a known baseline, or explicitly documented.`,
              })
              debug(`tool.after: failure recorded for ${sid}`)
            }
          }
        }
      } catch (e) {
        debug(`tool.after: error — ${(e as Error).message}`)
      }
    },

    // ── SYSTEM.TRANSFORM: the INJECT PATH (signal-routed + evidence-aware)
    async "experimental.chat.system.transform"(sysInput, sysOutput) {
      const sid = sysInput.sessionID
      if (!sid || !gate.isActive(sid)) {
        debug(`system.transform: SKIPPED ${sid || "?"} (gate inactive)`)
        return
      }

      const combined: Directive[] = [...alwaysOn()]

      // Signal-routed procedure
      const mode = taskModeBySession.get(sid)
      if (mode) {
        const routed = contextForMode(mode)
        if (routed) combined.push(routed)
      }

      if (reviewBySession.get(sid)) combined.push(contextForReview())

      const stopMode = stopModeBySession.get(sid)
      if (stopMode) {
        const guidance = contextForStopMode(stopMode)
        if (guidance) combined.push(guidance)
      }

      // Evidence summary (let the model see its own track record)
      const summary = ledger.summary(sid)
      if (summary) {
        combined.push({
          id: "vertex:ledger",
          text: `[vertex:ledger] This turn's evidence: ${summary}`,
        })
      }

      // Queued directives (from tool.after failures, stop gate, etc.)
      const queued = queue.drain(sid)
      combined.push(...queued)

      const block = formatDirectives(combined)
      if (!block) return
      sysOutput.system = [...sysOutput.system, block]
      debug(`system.transform: INJECTED ${combined.length} directive(s) into ${sid} (mode=${mode || "none"}, queued=${queued.length})`)
    },

    // ── MESSAGES.TRANSFORM: fallback + capture last assistant text ────────
    ...(opts.wireMessagesTransform
      ? {
          async "experimental.chat.messages.transform"(_msgInput, msgOutput) {
            // Capture last assistant text per session for the promise-no-act
            // guard. Mirrors fablize finish-the-work.sh:15-30 which reads the
            // transcript to find the last assistant message text.
            try {
              for (const m of msgOutput.messages || []) {
                const info = (m as any).info
                if (info?.role === "assistant") {
                  const text = ((m as any).parts || [])
                    .filter((p: any) => p && p.type === "text" && typeof p.text === "string")
                    .map((p: any) => p.text)
                    .join("\n")
                  if (text) lastAssistantText.set(info.sessionID, text)
                }
              }
            } catch {}

            const undrained = queue.drainAll()
            const active = undrained.filter((d) => gate.isActive(d.sessionID))
            if (active.length === 0) return
            const block = formatDirectives(active)
            if (!block) return
            const last = msgOutput.messages[msgOutput.messages.length - 1]
            if (!last) return
            const part: TextPart = {
              id: `prt_${randomUUID().replace(/-/g, "")}`,
              type: "text",
              text: `\n\n${block}\n`,
              synthetic: true,
              sessionID: last.info.sessionID,
              messageID: last.info.id,
            }
            last.parts.push(part)
          },
        }
      : {}),

    // ── EVENT: the STOP GATE ──────────────────────────────────────────────
    async event({ event }) {
      try {
        if (event.type !== "session.idle") return
        const sid = event.properties?.sessionID
        if (typeof sid !== "string") return
        if (!gate.isActive(sid)) return

        debug(`event: session.idle for ${sid}`)

        // ── PROMISE-NO-ACT GUARD — strictly better than fablize ──────────
        // Catch deferred/tracked/TODO/FIXME/issue-filing language in the final
        // assistant message. Only blocks when files were changed this turn
        // (so a pure "let me explain" message is allowed to end).
        const lastText = lastAssistantText.get(sid)
        if (lastText) {
          const hits = detectPromiseNoAct(lastText)
          if (shouldBlockPromiseNoAct(lastText, ledger.hasChangedFiles(sid), ledger.hasVerification(sid))) {
            const labels = hits.map((h) => h.label).join(", ")
            const reason = `[vertex:promise-no-act] Your last message contains deferral/intent language (${labels}) but files were changed this turn. Either complete the work now or explicitly state what remains unverified. Promise without act is not allowed when files are changed.`
            debug(`event: ${sid} — PROMISE-NO-ACT (${labels})`)

            // M3 holdout skip (same as the unverified block path)
            if (holdoutSuppresses(sid)) {
              logHoldoutSuppress(sid, "promise-no-act skipped (holdout arm=off)")
              logGateFire(sid, {
                decision: "allow",
                changed: true,
                verified: ledger.hasVerification(sid),
                stop_blocks: ledger.getStopBlocks(sid),
                max_stop_blocks: opts.maxStopBlocks,
                would_block: true,
              })
              debug(`event: ${sid} — HOLDOUT, promise-no-act suppressed`)
            } else {
              const count = ledger.incrementStopBlocks(sid)
              const cap = opts.maxStopBlocks
              if (count > cap) {
                // Past cap — log and let it through with a warning
                logGateFire(sid, {
                  decision: "warn",
                  changed: true,
                  verified: ledger.hasVerification(sid),
                  stop_blocks: count,
                  max_stop_blocks: cap,
                  would_block: true,
                })
                queue.enqueue(sid, {
                  id: "vertex:promise-no-act-warn",
                  text: `[vertex:promise-no-act-warn] Cap reached (${count - 1} blocks). The following deferral signals were detected: ${labels}. Proceeding.`,
                })
                return
              }
              queue.enqueue(sid, { id: "vertex:promise-no-act", text: reason })
              logGateFire(sid, {
                decision: "block",
                changed: true,
                verified: ledger.hasVerification(sid),
                stop_blocks: count,
                max_stop_blocks: cap,
                would_block: true,
              })
              debug(`event: ${sid} — PROMISE-NO-ACT BLOCK ${count}/${cap}`)
              if (client?.session?.prompt) {
                await client.session.prompt({
                  path: { id: sid },
                  body: { parts: [{ type: "text", text: reason }] },
                })
              }
              return
            }
          }
        }

        // Check if the model's work is unverified
        if (!ledger.shouldBlockStop(sid)) {
          debug(`event: ${sid} — no block needed (verified or no changes)`)
          logGateFire(sid, {
            decision: "allow",
            changed: ledger.hasChangedFiles(sid),
            verified: ledger.hasVerification(sid),
            stop_blocks: ledger.getStopBlocks(sid),
            max_stop_blocks: opts.maxStopBlocks,
            would_block: false,
          })
          return
        }

        const blocks = ledger.getStopBlocks(sid)

        // M3-style holdout: env-gated (default OFF) skip for the 'off' arm.
        // Mirrors gate_stop.py:26-38. When VERTEX_HOLDOUT=1 AND this session
        // is in the 'off' arm, skip the gate and log the suppression
        // out-of-band. The model never sees the arm; the reason is
        // measurement-only.
        if (holdoutSuppresses(sid)) {
          logHoldoutSuppress(sid, "stop-block skipped (holdout arm=off)")
          logGateFire(sid, {
            decision: "allow",
            changed: ledger.hasChangedFiles(sid),
            verified: ledger.hasVerification(sid),
            stop_blocks: blocks,
            max_stop_blocks: opts.maxStopBlocks,
            would_block: true,
          })
          debug(`event: ${sid} — HOLDOUT arm=off, stop gate suppressed`)
          return
        }

        if (blocks >= opts.maxStopBlocks) {
          debug(`event: ${sid} — max stop blocks reached (${blocks}), allowing with warning`)
          logGateFire(sid, {
            decision: "warn",
            changed: ledger.hasChangedFiles(sid),
            verified: ledger.hasVerification(sid),
            stop_blocks: blocks,
            max_stop_blocks: opts.maxStopBlocks,
            would_block: true,
          })
          queue.enqueue(sid, {
            id: "vertex:stop-warning",
            text: `[vertex:stop-warning] You have claimed done ${blocks} times without observed verification. Proceeding, but this task is recorded as unverified.`,
          })
          return
        }

        const count = ledger.incrementStopBlocks(sid)
        const reason = `[vertex:stop-block] You appear to be stopping, but files were changed this turn without an observed successful allowlisted verification command. Run the narrowest relevant test, lint, typecheck, build, check, validate, verify, or HTTP probe now and cite its result, or explicitly state what remains unverified. (Block ${count}/${opts.maxStopBlocks})`

        queue.enqueue(sid, { id: "vertex:stop-block", text: reason })
        logGateFire(sid, {
          decision: "block",
          changed: ledger.hasChangedFiles(sid),
          verified: ledger.hasVerification(sid),
          stop_blocks: count,
          max_stop_blocks: opts.maxStopBlocks,
          would_block: true,
        })
        debug(`event: ${sid} — STOP BLOCK ${count}/${opts.maxStopBlocks} (changed files, no verification)`)

        // Re-prompt the model to continue
        if (client?.session?.prompt) {
          await client.session.prompt({
            path: { id: sid },
            body: {
              parts: [{ type: "text", text: reason }],
            },
          })
        }
      } catch (e) {
        debug(`event: error — ${(e as Error).message}`)
      }
    },
  }
}

export default ElicifyVertexPlugin
