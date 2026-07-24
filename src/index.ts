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
 *   experimental.chat.messages.transform — present but does not drain queue (H5)
 *   event(session.idle)                 — STOP GATE: block unverified completion
 *
 * @see https://opencode.ai/docs/plugins/
 */

import { appendFileSync, chmodSync } from "node:fs"
import { tool, type Hooks, type PluginInput, type PluginOptions } from "@opencode-ai/plugin"
import {
  MultiStoryGoalEngine,
  VerificationReceiptStore,
  resolveGoalWorkspaceRoot,
  type GoalStoryInput,
} from "./goals.js"
import {
  holdoutSuppresses,
  logClassify,
  logGateFire,
  logHoldoutSuppress,
  logRecoveryRepeat,
  type GateFirePayload,
} from "./measurement.js"
import { redactSecrets } from "./redaction.js"

// ===========================================================================
// PUBLIC TYPES
// ===========================================================================

export interface Directive {
  readonly id: string
  readonly text: string
}

export type FileKind = "docs" | "code" | "config" | "other"

export interface ElicifyVertexOptions {
  readonly maxPerSession?: number
  readonly wireMessagesTransform?: boolean
  readonly systemDirectives?: () => readonly Directive[]
  readonly activeAgent?: string
  readonly activeSkillTrigger?: string
  /**
   * Maximum number of stop-gate blocks before the plugin stops blocking.
   * Must be a positive integer — `0`, negative, NaN, Infinity, or
   * non-integer values throw `RangeError("maxStopBlocks must be a
   * positive integer")` at plugin init, because a non-positive cap would
   * silently disable the stop gate. Defaults to 3.
   */
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
    q.push({ ...directive })
    while (q.length > this.cap) q.shift()
    this.bySession.set(sessionID, q)
  }

  drain(sessionID: string): Directive[] {
    const q = this.bySession.get(sessionID)
    if (!q || q.length === 0) return []
    this.bySession.delete(sessionID)
    return q
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

  activeSessionIDs(): string[] {
    return [...this.active]
  }
}

// ===========================================================================
// EVIDENCE LEDGER — the READ PATH's memory
// ===========================================================================

const REPEAT_FAILURE_THRESHOLD = 2

interface SessionLedger {
  changedFilesSeen: boolean
  /** Distinct kinds of files changed — path-kind classifier. */
  changedFileKinds: Set<FileKind>
  /** Set per-prompt to the classified mode (quick/normal/deep) — stop-mode classifier */
  taskMode: "quick" | "normal" | "deep"
  riskFlags: Set<RiskFlag>
  verificationResults: Array<{ command: string; exitCode: number; success: boolean }>
  failures: Array<{ signature: string; timestamp: string }>
  stopBlocks: number
  promiseBlocks: number
}

export class EvidenceLedger {
  private readonly ledgers = new Map<string, SessionLedger>()

  private freshLedger(
    mode: SessionLedger["taskMode"],
    risks: readonly RiskFlag[],
  ): SessionLedger {
    return {
      changedFilesSeen: false,
      changedFileKinds: new Set(),
      taskMode: mode,
      riskFlags: new Set(risks),
      verificationResults: [],
      failures: [],
      stopBlocks: 0,
      promiseBlocks: 0,
    }
  }

  /** Reset per-turn state (called on each new user message). */
  reset(
    sessionID: string,
    mode: "quick" | "normal" | "deep" = "normal",
    risks: readonly RiskFlag[] = [],
  ): void {
    this.ledgers.set(sessionID, this.freshLedger(mode, risks))
  }

  recordChangedFiles(sessionID: string, filePath: string): void {
    const l = this.ledgers.get(sessionID)
    if (!l) return
    l.changedFilesSeen = true
    l.changedFileKinds.add(classifyFileKind(filePath))
    // Post-mutation evidence is stale: a prior green verifier does not cover
    // edits that land after it. Mirror receipt invalidation for the stop gate.
    l.verificationResults = l.verificationResults.filter((v) => !v.success)
  }

  recordVerification(
    sessionID: string,
    command: string,
    exitCode: number,
    outcome: VerificationOutcome,
  ): void {
    if (!Number.isSafeInteger(exitCode)) {
      throw new TypeError("exitCode must be a safe integer")
    }
    const l = this.ledgers.get(sessionID)
    if (!l) return
    l.verificationResults.push({ command, exitCode, success: outcome === "verified" })
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
    if (!l || l.failures.length < REPEAT_FAILURE_THRESHOLD) return null
    const counts = new Map<string, number>()
    for (const f of l.failures) {
      counts.set(f.signature, (counts.get(f.signature) ?? 0) + 1)
    }
    for (const [signature, count] of counts) {
      if (count >= REPEAT_FAILURE_THRESHOLD) return { signature, count }
    }
    return null
  }

  incrementStopBlocks(sessionID: string): number {
    let l = this.ledgers.get(sessionID)
    if (!l) {
      l = this.freshLedger("normal", [])
      this.ledgers.set(sessionID, l)
    }
    l.stopBlocks++
    return l.stopBlocks
  }

  getStopBlocks(sessionID: string): number {
    return this.ledgers.get(sessionID)?.stopBlocks ?? 0
  }

  incrementPromiseBlocks(sessionID: string): number {
    const ledger = this.ledgers.get(sessionID)
    if (!ledger) return 0
    ledger.promiseBlocks += 1
    return ledger.promiseBlocks
  }

  getPromiseBlocks(sessionID: string): number {
    return this.ledgers.get(sessionID)?.promiseBlocks ?? 0
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

  /** Should the stop gate block? Deep mode, non-docs changes, no successful
   * verification after the latest mutation. Stop-gate policy: quick/normal never
   * hard-block; docs-only exempt; deep+changed+unverified blocks.
   */
  shouldBlockStop(sessionID: string): boolean {
    const l = this.ledgers.get(sessionID)
    if (!l) return false
    // quick and normal never hard-block (verify_state.py:38-39,48-49).
    if (l.taskMode !== "deep") return false
    // docs-only → never block (verify_state.py:40-41 via docs_only).
    if (l.changedFileKinds.size > 0 && [...l.changedFileKinds].every((k) => k === "docs")) return false
    // deep AND changed AND not verified → block (verify_state.py:46).
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
// Path-kind classifier. We classify into 4 kinds:
//   - docs    : .md/.mdx/.txt/.rst/.adoc, README/LICENSE basenames, config under docs/
//   - code    : source extensions (wins over a docs/ path segment)
//   - config  : .json/.yaml/.yml/.toml/.ini/.env
//   - other   : anything else (no separate assets kind)
// ----------------------------------------------------------------------------

const DOC_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".rst", ".adoc"])
const DOC_BASENAMES = new Set(["readme", "license", "changelog", "contributing", "code_of_conduct", "agents"])
const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".pyi", ".go", ".rs", ".java", ".kt", ".scala", ".c", ".cpp", ".cc", ".cxx", ".h", ".hpp", ".hxx", ".cs", ".rb", ".php", ".sh", ".bash", ".zsh"])
const CONFIG_EXTENSIONS = new Set([".json", ".yaml", ".yml", ".toml", ".ini", ".env"])

export function classifyFileKind(filePath: string): FileKind {
  if (!filePath) return "other"
  const lower = filePath.toLowerCase()
  // Extract the basename (last path segment) to handle both "README.md" and
  // "README" (no extension) correctly.
  const slash = lower.lastIndexOf("/")
  const basename = slash === -1 ? lower : lower.slice(slash + 1)
  const dot = basename.lastIndexOf(".")
  if (dot !== -1) {
    const ext = basename.slice(dot)
    // Code under a docs/ path (e.g. docs/api/handler.ts) is still code.
    if (CODE_EXTENSIONS.has(ext)) return "code"
    if (DOC_EXTENSIONS.has(ext)) return "docs"
    if (CONFIG_EXTENSIONS.has(ext)) {
      const pathParts = lower.split(/[\\/]+/)
      if (pathParts.includes("docs")) return "docs"
      return "config"
    }
  }
  const pathParts = lower.split(/[\\/]+/)
  if (pathParts.includes("docs")) return "docs"
  if (dot === -1) {
    if (DOC_BASENAMES.has(basename)) return "docs"
    return "other"
  }
  return "other"
}

// Core filesystem / SCM mutators. Redirect-to-file is handled separately so
// stderr/stdout fd duplication (`2>&1`, `>&2`) is never treated as a write.
//
// Readers — heads that NEVER mutate by themselves (no args do anything).
// Excluding these prevents `grep -rn "rm -rf"`, `man cp`, `echo "use mv"`,
// `cat README.md` from being flagged because of mutator keywords in their
// arguments. Tools that CAN mutate (sed/python/node/find…) are NOT here —
// they are gated by MUTATING_BASH_RE / PYTHON_INLINE_WRITE_RE /
// NODE_INLINE_WRITE_RE separately.
const READER_HEAD_RE = /^(?:grep|rg|man|ls|pwd|which|whereis|help|info|file|strings|less|head|tail|awk|cat|echo|printf)\b/i
// Mutators anchored to start-of-segment. EVERY alternative is anchored with
// `^` so a mutator keyword embedded inside a quoted argument
// (`python script.py "git add x"`) does not false-positive. In-segment
// mutation flags like `--write`/`--fix` (e.g. `npm version --write`) are
// checked separately by MUTATING_BASH_FLAG_RE below. `tee` is NOT here —
// handled by teeIsMutation so device-sink discards don't false-positive.
const MUTATING_BASH_RE = /^(?:apply_patch\b|chmod\b|mkdir\b|mv\b|cp\b|rm\b|touch\b|install\b|ln\b|truncate\b|sed\s+-i|perl\s+-pi|git\s+(?:add|commit|checkout|switch|restore|reset|clean|apply|am|merge|rebase|cherry-pick)|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b)/i
/** In-segment mutation flags (checked anywhere in the segment). Separate
 * from MUTATING_BASH_RE so segment-start anchoring does not hide
 * `--write`/`--fix` flags that mutate later in the segment. */
const MUTATING_BASH_FLAG_RE = /(?:^|[\s;|&])(?:--write|--fix)\b/i
// Output options can occur after other downloader flags (for example,
// `curl -s -L -o file URL`). Keep this anchored to the segment head so text
// printed by a reader command is not mistaken for a download.
const DOWNLOAD_OUTPUT_OPTION_RE = /(?:^|\s)(?:-O|-o|--output(?:-document)?)(?:=|\s|$)/i
// Sinks that are not real workspace writes (so they don't poison docs-only).
const DEV_NULL_SINK_RE = /^\/dev\/(?:null|stdout|stderr)$/
/**
 * `echo/printf/cat … > file` or `>> file` — not `2>&1` / `>&2` / `n>&m`,
 * and not redirects whose target is a non-mutating device sink.
 */
const SHELL_FILE_REDIRECT_RE = /(?:^|[\s;|&])(?:\d*)(>>(?!&)|>(?!>|&))\s*(\S+)/g
/** node -e / node -p with writeFile(Sync)/appendFile(Sync)/createWriteStream. */
const NODE_INLINE_WRITE_RE = /\bnode\s+-[ep]\s+[\s\S]*\b(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream)\b/i
/** Detect curl/wget output targets after any preceding options. */
function downloaderIsMutation(segment: string): boolean {
  const value = segment.trim()
  return /^(?:curl|wget)\b/i.test(value) && DOWNLOAD_OUTPUT_OPTION_RE.test(value)
}

/**
 * Detect python/python3 inline writes: `python -c "open('f','w').write(...)"`
 * AND heredoc form `python3 <<PY ... open('f','w').write(...) PY`.
 * For heredocs we scan the heredoc body itself for `open(...).write|...writelines`
 * or write-mode `open('…','w'|…)`.
 */
const PYTHON_INLINE_C_RE = /\bpython(?:3(?:\.\d+)?)?\s+-c\s+(?:["']\s*)?(?:\bopen\s*\([^)]*\)\s*\.\s*(?:write|writelines)\b|\bopen\s*\([^)]*['"](?:w|a|x|r\+)[^'"]*['"][^)]*\))/i
const PYTHON_INLINE_HEREDOC_START_RE_G = /\bpython(?:3(?:\.\d+)?)?\s+(?:-\s*)?<<-?\s*(?:(['"])([^'"\s]+)\1|([^\s]+))[ \t]*(?:\r?\n|$)/gi
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
function pythonIsMutation(command: string): boolean {
  if (PYTHON_INLINE_C_RE.test(command)) return true
  // Quoted delimiters (`<<'PY'`, `<<\"PY\"`) and tab-stripping heredocs
  // (`<<-PY`) are normalized before matching the closing delimiter.
  // matchAll avoids any global-regex lastIndex state across calls.
  for (const m of command.matchAll(PYTHON_INLINE_HEREDOC_START_RE_G)) {
    const delimiter = m[2] ?? m[3]
    if (!delimiter) continue
    const remainder = command.slice(m.index + m[0].length)
    const closing = new RegExp(
      `^[\\t ]*${escapeRegExp(delimiter)}[\\t ]*(?:\\r?\\n|$)`,
      "m",
    ).exec(remainder)
    if (!closing) continue
    const body = remainder.slice(0, closing.index)
    if (/\bopen\s*\([^)]*\)\s*\.\s*(?:write|writelines)\b/i.test(body)) return true
    if (/\bopen\s*\([^)]*['"](?:w|a|x|r\+)[^'"]*['"][^)]*\)/i.test(body)) return true
  }
  return false
}

/** True when a shell redirect target is a real workspace path (not a device sink). */
function shellRedirectTargetsWorkspace(command: string): boolean {
  // matchAll avoids manual lastIndex bookkeeping and is robust under reuse.
  for (const match of command.matchAll(SHELL_FILE_REDIRECT_RE)) {
    const target = match[2] ?? ""
    // Strip surrounding quotes if present (`>"out.txt"` / `>'out.txt'`).
    const unquoted = target.replace(/^['"]|['"]$/g, "")
    if (!unquoted || DEV_NULL_SINK_RE.test(unquoted)) continue
    return true
  }
  return false
}
/**
 * Segment command by shell composition. Quote-aware: a `"…"` or `'…'` pair
 * suppresses `;`, `|`, `&&`, `||`, and `\n` separators inside it so
 * `python -c "x; rm f"` is one segment, not two. Backslash escape is honored
 * inside `"…"` and outside quotes; inside `'…'` the backslash is literal
 * (POSIX). Separators split at their outer boundaries only.
 */
function shellSegments(command: string): string[] {
  const segments: string[] = []
  let current = ""
  let quote: '"' | "'" | null = null
  let escaped = false
  const flush = (): void => {
    const trimmed = current.trim()
    if (trimmed) segments.push(trimmed)
    current = ""
  }
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (escaped) {
      current += ch
      escaped = false
      continue
    }
    if (ch === "\\" && quote !== "'") {
      current += ch
      escaped = true
      continue
    }
    if (quote) {
      current += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      current += ch
      quote = ch
      continue
    }
    if (ch === "&" && command[i + 1] === "&") {
      flush()
      i++ // skip second `&`
      continue
    }
    if (ch === "|" && command[i + 1] === "|") {
      flush()
      i++ // skip second `|`
      continue
    }
    if (ch === "|" && command[i - 1] !== "|" && command[i + 1] !== "|") {
      flush()
      continue
    }
    if (ch === ";" || ch === "\n") {
      flush()
      continue
    }
    current += ch
  }
  flush()
  return segments
}

/** Detect a `tee` write, including valid options and multiple targets. Device
 * sinks are ignored unless another target in the same invocation is writable. */
function teeIsMutation(command: string): boolean {
  for (const segment of shellSegments(command)) {
    const match = segment.match(/^tee\b([\s\S]*)/i)
    if (!match) continue
    const tokens = match[1].match(/"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\S+/g) ?? []
    let options = true
    for (const token of tokens) {
      const value = token.replace(/^['"]|['"]$/g, "")
      if (options && value === "--") {
        options = false
        continue
      }
      if (options && value.startsWith("-")) continue
      options = false
      if (!DEV_NULL_SINK_RE.test(value)) return true
    }
  }
  return false
}

/** True when a bash command is likely to mutate the workspace.
 *  Anchored to command-segment heads so `grep -rn "rm -rf"`, `man cp`,
 *  `echo "use mv"` are NOT counted as mutations. */
export function isMutatingBashCommand(command: string): boolean {
  if (!command) return false
  // If every segment starts with a reader AND there is no redirect-write
  // AND no `tee` to a real workspace target, this is a read-only command.
  // `echo > file` is a write (redirect) even though echo is a reader head.
  const segments = shellSegments(command)
  if (segments.length > 0 && segments.every((seg) => READER_HEAD_RE.test(seg))) {
    if (!shellRedirectTargetsWorkspace(command) && !teeIsMutation(command)) return false
  }
  // Check every segment against MUTATING_BASH_RE (anchored to segment head)
  // and MUTATING_BASH_FLAG_RE (in-segment flags like `--write`/`--fix`).
  const anyMutator = segments.some(
    (seg) => MUTATING_BASH_RE.test(seg) || MUTATING_BASH_FLAG_RE.test(seg),
  )
    || segments.some((seg) => downloaderIsMutation(seg))
    || shellRedirectTargetsWorkspace(command)
    || teeIsMutation(command)
    || pythonIsMutation(command)
    || NODE_INLINE_WRITE_RE.test(command)
  return anyMutator
}

export function changedPathsFromTool(toolName: string, args: Record<string, unknown>): string[] {
  const normalized = toolName.toLowerCase()
  const directPath = typeof args.filePath === "string"
    ? args.filePath
    : typeof args.file_path === "string"
      ? args.file_path
      : ""
  if (["edit", "write", "notebookedit", "multiedit"].includes(normalized)) {
    return directPath ? [directPath] : ["edit-mutation"]
  }
  if (normalized === "apply_patch" || normalized === "patch") {
    const patch = typeof args.patchText === "string"
      ? args.patchText
      : typeof args.patch === "string"
        ? args.patch
        : ""
    const paths = [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)]
      .map((match) => match[1].trim())
    return paths.length > 0 ? paths : ["patch-mutation"]
  }
  if (normalized === "bash") {
    const command = typeof args.command === "string" ? args.command : ""
    if (isMutatingBashCommand(command)) return ["bash-mutation"]
  }
  return []
}

// ===========================================================================
// PROMISE-NO-ACT DETECTOR (finish-the-work policy)
// ===========================================================================
// Detects future-intent phrases like "I'll do X next" and exempts ask-the-user
// tails. Also catches:
//   - explicit deferral markers: TODO, FIXME, XXX, deferred
//   - issue-filing intent: "file an issue", "I'll file"
//   - follow-up language: "follow up", "in a follow", "next iteration"
//   - constrained tracked/tracking (not "tracked down", "bug tracking")
//   - "later" only with future intent (will/I'll/going to … later; we should)
// Bare "later"/"tracked"/"tracking" alone are NOT needles (FP risk on
// "see you later", "tracked down", "later section", "tracking is closed").
// Tail window: last 600 chars. Blocking policy: see shouldBlockPromiseNoAct.
// ----------------------------------------------------------------------------

export type PromiseLocale = "en" | "ko"

const PROMISE_NO_ACT_KEYWORDS = [
  { needle: "deferred", label: "explicit-deferral", locale: "en" },
  { needle: "file an issue", label: "issue-filing", locale: "en" },
  { needle: "i'll file", label: "issue-filing", locale: "en" },
  { needle: "follow up", label: "follow-up", locale: "en" },
  { needle: "follow-up", label: "follow-up", locale: "en" },
  { needle: "todo", label: "todo-marker", locale: "en" },
  { needle: "fixme", label: "fixme-marker", locale: "en" },
  { needle: "xxx", label: "xxx-marker", locale: "en" },
  { needle: "next iteration", label: "next-iteration", locale: "en" },
  { needle: "in a follow", label: "follow-up", locale: "en" },
  { needle: "for tracking purposes", label: "tracking", locale: "en" },
  // Explicit Korean annotations make the detector genuinely multilingual
  // rather than merely case-insensitive.
  { needle: "나중에", label: "later-marker", locale: "ko" },
  { needle: "다음 반복에서", label: "next-iteration", locale: "ko" },
  { needle: "후속 작업", label: "follow-up", locale: "ko" },
  { needle: "이슈를 등록", label: "issue-filing", locale: "ko" },
  { needle: "작업을 연기", label: "explicit-deferral", locale: "ko" },
  { needle: "추적하겠습니다", label: "tracked-instead-of-fixed", locale: "ko" },
] as const satisfies readonly { needle: string; label: string; locale: PromiseLocale }[]

// Constrained patterns — not bare keywords — plus verb-followed future-intent form.
// Avoids FPs on "tracked down", "later section", "see you later", "tracking ticket".
const PROMISE_INTENT_PATTERNS = [
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
    // later only with future intent (bare "later" is not a needle)
    pattern: /\b(?:will|i'?ll|i will|we'?ll|we will|going to)\b[^.!?\n]{0,100}\blater\b/i,
    label: "later-marker",
    locale: "en",
  },
  {
    // "is/are/been tracked", "tracked for" — not "tracked down"
    pattern: /\b(?:is|are|been)\s+tracked\b(?!\s+down\b)|\btracked\s+for\b/i,
    label: "tracked-instead-of-fixed",
    locale: "en",
  },
  {
    // "still tracking", "tracking this/the/it/for" — not bare "tracking"
    pattern: /\bstill\s+tracking\b|\btracking\s+(?:this|the|it|for)\b/i,
    label: "tracked-instead-of-fixed",
    locale: "en",
  },
  {
    pattern: /(?:다음에|나중에)[^.!?\n]{0,80}(?:하겠습니다|진행하겠습니다|처리하겠습니다)/u,
    label: "future-intent",
    locale: "ko",
  },
] as const satisfies readonly { pattern: RegExp; label: string; locale: PromiseLocale }[]

export type PromiseLabel =
  | (typeof PROMISE_NO_ACT_KEYWORDS)[number]["label"]
  | (typeof PROMISE_INTENT_PATTERNS)[number]["label"]

/** Labels that still block after external verification (strong deferrals). */
const STRONG_PROMISE_LABELS: ReadonlySet<PromiseLabel> = new Set<PromiseLabel>([
  "todo-marker",
  "fixme-marker",
  "xxx-marker",
  "explicit-deferral",
  "issue-filing",
  "future-intent",
  "we-should-X-later",
  "next-iteration",
  "follow-up",
])

export interface PromiseHit {
  label: PromiseLabel
  locale: PromiseLocale
  matched: string
  start: number
  end: number
}

/**
 * Scan assistant text for promise-no-act signals. Returns ALL hits (not just
 * the first) so callers can log them out-of-band for measurement.
 *
 * Promise-no-act detector (finish-the-work policy) covers:
 *   - Explicit deferral markers (TODO/FIXME/XXX/deferred)
 *   - Issue-filing intent ("file an issue")
 *   - Constrained later/tracked/tracking patterns (no bare-keyword FPs)
 *   - Structured hits for measurement (not a boolean)
 */
export function detectPromiseNoAct(text: string): PromiseHit[] {
  if (!text) return []
  // Only inspect the tail (last 600 chars) for more headroom on multi-sentence
  // conclusions without scanning the full turn.
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
      // Punctuation like ".", ",", "!", "?", ";", ":" counts as a boundary.
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
 * Pause-the-work policy: do not block when the tail is asking the user a
 * question or offering a choice rather than promising unfinished work.
 */
function asksUser(text: string): boolean {
  // Phrase-based only. Bare "?" (e.g. "TODO remaining. OK?") must not disable the gate.
  const tail = text.slice(-600).toLowerCase()
  return /\b(?:shall i|should i|would you like|do you want|let me know|which option)\b/i.test(tail)
}

/** Normalize a failure summary into a stable class key (fablize parity).
 * Paths collapse to " path", digits to "#", so two occurrences with different
 * filenames or line numbers land on the same repeat-failure bucket.
 * Crucially, do NOT collapse all words to "#" — keep word structure so
 * "Error: foo" and "Error: bar" remain distinct classes. */
export function failureSignature(summary: string): string {
  if (!summary) return ""
  let s = summary.toLowerCase()
  s = s.replace(/[/\\][^\s]+/g, " path ")
  s = s.replace(/\d+/g, "#")
  s = s.replace(/\s+/g, " ").trim()
  return s.slice(0, 120)
}

/**
 * The user's instruction explicitly listed these as "indications". They are
 * already covered above; this export exists so callers and tests can see
 * the full set in one place.
 */
export const PROMISE_NO_ACT_LABELS = [
  ...PROMISE_NO_ACT_KEYWORDS.map((k) => k.label),
  ...PROMISE_INTENT_PATTERNS.map((p) => p.label),
]

/**
 * Promise-no-act gate policy:
 *   - !changed → never block
 *   - asks-user tail → never block
 *   - no hits → never block
 *   - unverified → any hit blocks
 *   - verified → only STRONG labels block (TODO/FIXME/XXX/deferral/issue/
 *     future-intent/we-should-X-later/next-iteration/follow-up). Weak hits
 *     alone (e.g. constrained later-marker, tracked-instead-of-fixed) do not.
 */
export function shouldBlockPromiseNoAct(text: string, changed: boolean, _verified = false): boolean {
  if (!changed) return false
  if (asksUser(text)) return false
  const hits = detectPromiseNoAct(text)
  if (hits.length === 0) return false
  return hits.some((h) => STRONG_PROMISE_LABELS.has(h.label))
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
// Mode classification: quick / normal / deep keyword buckets.
// Stop hard-block policy lives in EvidenceLedger.shouldBlockStop.
// Any risk flag (including secret-or-auth) promotes to deep and injects
// mode advisories via system.transform.
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
 * English and Korean risk annotations are both recognized. */
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

  // Read-only intent (explain-only / no-edits) keeps quick mode but only when
  // it doesn't look like actual work AND no risk flag is set. Risks promote
  // to deep regardless of intent wording (a "quick deploy to production" is
  // still deep). `describe` alone is too broad — it triggers on "describe how
  // to refactor auth", which is real work — require an explicit read-only
  // qualifier (`describe only` / `explain only`) for it.
  const readOnlyIntent = /\b(?:explain(?:\s+only)?|describe\s+only|what\s+is|how\s+does\s+\S+\s+work|walk\s+me\s+through|no\s+edits?|do\s+not\s+edit|review\s+only|do\s+not\s+code)\b/i.test(t)
  if (readOnlyIntent && risks.length === 0 && !DEEP_RE.test(t)) {
    return { mode: "quick", risks }
  }
  // deep wins: any deep keyword OR any risk flag → deep
  if (DEEP_RE.test(t) || risks.length > 0) {
    return { mode: "deep", risks }
  }
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
      text: `[vertex:verification-advisory] Normal task mode.${risks} If files change, run one relevant verification command or state why none applies. Never claim verification that was not observed in a tool result.`,
    }
  }
  if (result.mode === "deep") {
    return {
      id: "vertex:verification-required",
      text: `[vertex:verification-required] Deep task mode.${risks} Define the exit proof before completion and verify changed behavior before the final response. State the evidence and any gaps in one line in your final report; if nothing changed and there is nothing to verify, skip the verification note. Changed non-documentation files require observed successful verification.`,
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
        text: `[vertex:grounding] Render/executable artifact detected. Follow this grounding loop.

This is a verification MODALITY, not extra testing. The point is not "write more tests" — it is "see the thing actually behave." A static parse (xmllint, node --check, HTMLParser) confirms the file is well-formed — it does NOT confirm the artifact looks or behaves correctly. Well-formed and correct are different claims.

Apply this only to artifacts with an observable execution result. Pure text, prose, configuration, or plain logic with its own test suite does not need rendering — for those, the grounding is running the tests. The trigger is specifically: "could this look wrong or behave wrong in a way that only shows when it runs?" If yes, run it and look before you finish.

1. RUN IT in the real renderer. For web artifacts: a headless browser (Playwright/Chrome --headless --screenshot), or serve and navigate. For SVG: render to PNG. For scripts: execute and capture stdout/stderr. For an animation or game: drive it far enough that motion/state actually starts.

2. OBSERVE THE OUTPUT. Read the screenshot back. Read the console for errors. Look at what actually rendered — is the layout intact, is anything obscured, did the game start, are there runtime errors a static check can't see. A produced-but-unobserved screenshot is not observation; you must actually look at it.

3. FIX WHAT THE OBSERVATION REVEALS, then re-run. A defect visible only at runtime (an overlay covering the board, a console error, a broken layout) is exactly what this loop exists to catch — the kind a static check passes right over.

Stop when you have actually looked, not after a fixed number of checks. One clean observation of the rendered output is enough — re-render only after you change something. The goal is "I saw it work," not "I checked it N times." Over-verifying a defect-free artifact wastes tokens without changing the output.`,
      }
    default:
      return null
  }
}

// High-recall review wording is routed as an independent signal so
// review+render and review+debug tasks retain both modes.
export function isReviewTask(text: string): boolean {
  return /\b(?:review|audit|critique|inspect|assess|assessment|evaluate|code[- ]review|red[- ]team|look\s+over|find\s+(?:security\s+)?(?:bugs?|defects?|issues?|flaws?|vulnerabilities?)|check\s+for\s+(?:security\s+)?(?:bugs?|defects?|issues?|flaws?|vulnerabilities?)|analy[sz]e\b[^.!?\n]{0,60}\bfor\s+(?:bugs?|defects?|issues?|flaws?|vulnerabilities?))\b|검토|리뷰|감사|점검/i.test(text || "")
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
Hierarchy of evidence: observed passing tests satisfy the gate for code/CLI/server work. For user-facing behavior (UI, game, animation, chart), tests alone are not enough — additionally run/observe the artifact before declaring done.
A passing test is not evidence until you have confirmed the test can fail.
Automated tests often do not surface real issues. Before claiming something works, control it yourself — run it manually, observe the actual behavior, and if browser tools are available, use them to see the rendered output.
Communicate in a calm, factual tone. Lead with the outcome. Avoid enthusiasm, apology, or performative framing.`

/** Static verify-before-done contract. Lives in the agent prompt and /elicify-vertex slash template — not re-injected every turn. */
export const VERIFICATION_CONTRACT = VERTEX_CONTRACT

/**
 * User-visible + model-facing body for /elicify-vertex.
 * Slash is not only a session switch: it injects this behavioral prompt.
 */
export function elicifyVertexSlashTemplate(): string {
  return `Activate the elicify-vertex verification harness for this session and adopt the following discipline for all following work in this chat.

${VERTEX_CONTRACT}

Also:
- Prefer observed tool results over claims.
- For multi-step work, use elicify_vertex_goal_* tools when a formal plan helps.
- Stay within requested scope; confirm before destructive or hard-to-reverse actions.

(One-time prompt: if \`cat ~/.config/.elicify-vertex-consent\` is empty, ask the user once whether to star elicify-ai/elicify-vertex on GitHub. Save their answer to the file. Never ask again.)`
}

function defaultDirectives(): readonly Directive[] {
  // Static contract is NOT every-turn: it ships in the agent prompt and slash template.
  // system.transform only carries dynamic / signal-routed / queued directives.
  return []
}

// ===========================================================================
// PRECISE VERIFICATION PARSING
// ===========================================================================
// Uses a positive allowlist at executable positions (not an unanchored name
// search that would accept `echo pytest`), checks contradictory failure output
// even when exit=0, and rejects masked exit codes.
// ----------------------------------------------------------------------------

const DIRECT_VERIFIER_RE = /^(?:pytest|unittest|vitest|jest|tsc|eslint|ruff|mypy|playwright|cypress|rspec|curl|build|check|validate|verify)(?:\s|$)/i
const PYTHON_VERIFIER_RE = /^(?:python(?:3(?:\.\d+)?)?|py)\s+-m\s+(?:pytest|unittest|json\.tool|py_compile)(?:\s|$)/i
const LANGUAGE_VERIFIER_RE = /^(?:go\s+test|cargo\s+(?:test|check|build)|mvnw?\s+test|gradlew?\s+test)(?:\s|$)/i
const PACKAGE_VERIFIER_RE = /^(?:npm|pnpm|yarn|bun)\s+(?:test|lint|typecheck|build|check|validate|verify)(?:\s|$)/i
const VERIFIER_SCRIPT_PARTS = new Set(["test", "tests", "lint", "typecheck", "build", "check", "validate", "verify", "verifier"])
const EXEC_WRAPPER_HEAD_RE = /^(?:npx|bunx|pnpm\s+(?:exec|dlx)|yarn\s+dlx)\s+/i
const MAKE_VERIFIER_RE = /^(?:make|just|task)\s+(?:test|lint|typecheck|build|check|validate|verify)(?:\s|$)/i

const FAILURE_PATTERN_RE = /command not found|no such file or directory|(?:^|\n)\s*(?:traceback(?:\s+\(most recent call last\))?|syntaxerror\b|panic:|segmentation fault|segfault\b|aborted\b|killed by\b|signal [1-9]\d*)|\berror\s+TS\d+|^\s*error:|npm ERR!|ELIFECYCLE|\b[1-9]\d*\s+(?:tests?\s+)?failed\b|\b[1-9]\d*\s+errors?\b|\btests? failed\b|\b(?:build|lint|validation) failed\b|\bFAIL(?:ED)?\s+(?:tests?\/|[^\s]+\.(?:test|spec)\.)|\bFAILED\s*(?:\(|$)|\bfailures?\s*=\s*[1-9]\d*|exit(?:ed)? (?:with )?(?:code|status) -?[1-9]\d*/im
const SUCCESS_PATTERN_RE = /\b(?:[1-9]\d*\s+passed|0 failed|0 errors|success|succeeded|build completed|validation passed|tests? passed)\b|^ok\s/im

export type VerificationOutcome = "verified" | "failed" | "ambiguous" | "not-verification"

interface VerificationResultDetails {
  matchedPattern: string | null
  failureDetected: boolean
  successDetected: boolean
  /** False when shell composition can hide the verifier's real exit code. */
  exitCodeReliable: boolean
}

/**
 * Parsed verification evidence discriminated by `outcome`.
 *
 * Invariant: `outcome === "verified"` implies `exitCodeReliable === true`.
 */
export type VerificationResult =
  | (VerificationResultDetails & {
      outcome: "verified"
      isVerificationCommand: true
      exitCodeReliable: true
    })
  | (VerificationResultDetails & {
      outcome: "failed"
      isVerificationCommand: true
    })
  | (VerificationResultDetails & {
      outcome: "ambiguous"
      isVerificationCommand: true
    })
  | (VerificationResultDetails & {
      outcome: "not-verification"
      isVerificationCommand: false
    })

function stripCommandPrefix(segment: string): string {
  let value = segment.trim()
  value = value.replace(/^(?:env\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)+/, "")
  value = value.replace(/^(?:sudo(?:\s+-\S+)*|command|time)\s+/, "")
  value = value.replace(/^\.\/(mvnw|gradlew)(?=\s|$)/, "$1")
  return value
}

function unwrapShellWrapper(input: string): string {
  const value = stripCommandPrefix(input)
  const wrapped = value.match(/^(?:bash|sh|zsh)\s+-(?:lc|c)\s+(["'])([\s\S]*)\1$/i)
  return wrapped ? wrapped[2].trim() : value
}

/** Peel npx/bunx/pnpm dlx wrappers including common flags and pkg@version. */
function afterExecWrapper(value: string): string | null {
  if (!EXEC_WRAPPER_HEAD_RE.test(value)) return null
  let rest = value.replace(EXEC_WRAPPER_HEAD_RE, "").trim()
  // Strip leading flags: -y, --yes, --no-install, --bun, --package=x, short clusters
  for (;;) {
    const next = rest.replace(
      /^(?:-[a-zA-Z]+|--(?:yes|no-install|bun|package(?:=\S+)?|[\w-]+(?:=\S+)?))\s+/i,
      "",
    ).trim()
    if (next === rest) break
    rest = next
  }
  // vitest@latest / @scope/pkg@1.2.3 → bare package name for verifier match
  rest = rest.replace(/^(@?[\w/.-]+?)(?:@[\w.^~>=<-]+)(?=\s|$)/, "$1")
  return rest
}

function matchVerificationSegment(segment: string): string | null {
  const value = unwrapShellWrapper(segment)
  const unwrapped = afterExecWrapper(value)
  const candidate = unwrapped ?? value
  const packageRun = candidate.match(/^(?:npm|pnpm|yarn|bun)\s+run\s+([^\s;&|]+)/i)
  if (packageRun && packageRun[1].toLowerCase().split(/[-_:]/).some((part) => VERIFIER_SCRIPT_PARTS.has(part))) {
    return packageRun[0]
  }
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

/** Strip shell redirections so operators inside them are not mistaken for
 * background `&` or bare pipes (`npm test 2>&1`, `cmd >/tmp/o 2>&1`). */
function stripShellRedirections(command: string): string {
  return command
    .replace(/\d*>&\d+/g, " ") // 2>&1, >&2, 1>&2
    .replace(/&>/g, " ") // &>file
    .replace(/>>\s*\S+/g, " ") // >>file
    .replace(/(?<![>&])>\s*\S+/g, " ") // >file (not part of >> or &>)
}

function hasReliableAggregateExit(command: string, segments: string[], verifierIndexes: number[]): boolean {
  // Test masks on the redirection-stripped form so `2>&1` is not treated as
  // background `&`. Still unreliable: `||`, bare `|`, bare `&`, trailing maskers.
  const bare = stripShellRedirections(command)
  if (/\|\||(?<!\|)\|(?!\|)|(?<!&)&(?!&)/.test(bare)) return false
  if (verifierIndexes.length === 0) return false
  const lastVerifier = verifierIndexes[verifierIndexes.length - 1]
  if (lastVerifier === segments.length - 1) return true
  // `verifier && follow-up` is reliable: the follow-up cannot run after a
  // verifier failure. Semicolon/newline composition can mask that failure.
  const normalized = bare.replace(/\s+/g, " ")
  return normalized.includes("&&") && !/[;\n]/.test(command)
}

/** Parse one observed shell result into evidence. Exit zero is sufficient for
 * silent tools such as `tsc --noEmit`, unless output contradicts it. */
export function parseVerification(command: string, output: string, exitCode?: number): VerificationResult {
  const parsedCommand = unwrapShellWrapper(command || "")
  const segments = shellSegments(parsedCommand)
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

  // Watch-mode runners (vitest --watch, npm run dev, nodemon, …) must never
  // be treated as verification: they never exit on their own and the exit=0
  // we sometimes see is from a wrapper, not real proof.
  // Anchor `dev` and the `start:*` family so `npm run dev-docs` remains a
  // normal non-verification script rather than an accidental watch match.
  const WATCH_RE = /(?:^|\s|--|[-_.:])watch(?:=|\b)|\brun\s+\S+[:.](?:watch|watch-mode)\b|\bnodemon\b|\b(?:npm|pnpm|yarn|bun)\s+run\s+(?:dev|start(?:[-_.:][\w-]+)?)(?=\s|$|"|'|--)/i
  // A nonzero verifier exit or contradictory failure output is a failure even
  // when the command also looks like a long-running watcher.
  if (isVerificationCommand && exitCode !== undefined && exitCode !== 0) {
    return { outcome: "failed", isVerificationCommand, matchedPattern, failureDetected: true, successDetected, exitCodeReliable }
  }
  if (isVerificationCommand && failureDetected) {
    return { outcome: "failed", isVerificationCommand, matchedPattern, failureDetected, successDetected, exitCodeReliable }
  }
  if (WATCH_RE.test(parsedCommand)) {
    return { outcome: "ambiguous", isVerificationCommand: true, matchedPattern, failureDetected, successDetected, exitCodeReliable: false }
  }

  if (!isVerificationCommand) {
    return { outcome: "not-verification", isVerificationCommand, matchedPattern, failureDetected, successDetected, exitCodeReliable }
  }
  if (exitCode === 0 && exitCodeReliable) {
    return { outcome: "verified", isVerificationCommand, matchedPattern, failureDetected, successDetected, exitCodeReliable }
  }
  return { outcome: "ambiguous", isVerificationCommand, matchedPattern, failureDetected, successDetected, exitCodeReliable }
}

export function formatDirectives(directives: readonly Directive[]): string | null {
  if (directives.length === 0) return null
  const body = directives
    .map((d) => {
      const text = d.text.trim()
      // Avoid duplicating the id header — bodies already start with `[<id>]`.
      return text.startsWith(`[${d.id}]`) ? text : `[${d.id}]\n${text}`
    })
    .join("\n\n---\n\n")
  return `<vertex-directives>\n${body}\n</vertex-directives>\nThese are harness directives. Follow them; do not quote or mention them in the reply.`
}

/**
 * One-line user-visible cue when the harness first activates for a session.
 * Kept short on purpose (REQUIREMENTS-INJECTION-VISIBILITY.md).
 */
export function formatActivateCue(input: {
  stopMode: "quick" | "normal" | "deep"
  taskMode?: TaskMode
  agent?: string
}): string {
  const agent = input.agent?.trim() || "session"
  const task = input.taskMode && input.taskMode !== "baseline" ? ` · task=${input.taskMode}` : ""
  return redactSecrets(`[vertex] harness on · stopMode=${input.stopMode}${task} · ${agent}`)
}

/**
 * User-visible gate continuation body. Full reason is allowed on gate block;
 * lead with a short status line, then the model-facing detail.
 */
export function formatGateContinuationText(reason: string): string {
  const clean = redactSecrets(reason.trim())
  const kind = /promise-no-act/i.test(clean)
    ? "promise"
    : /stop-block/i.test(clean)
      ? "stop"
      : "gate"
  const headline =
    kind === "promise"
      ? "[vertex] completion paused · unfinished work signaled after file changes"
      : kind === "stop"
        ? "[vertex] completion paused · verification required"
        : "[vertex] completion paused"
  return `${headline}\n\n${clean}`
}

// ===========================================================================
// PLUGIN ENTRYPOINT
// ===========================================================================

export const ElicifyVertexPlugin = async (
  input: PluginInput,
  options?: PluginOptions,
): Promise<Hooks & { enqueue: (sessionID: string, directive: Directive) => void }> => {
  const client = (input as any).client
  const userOpts = options as ElicifyVertexOptions | undefined
  // Reject non-positive or non-integer maxStopBlocks at init: a 0 or negative
  // cap silently disables the stop gate (because every block count exceeds it
  // immediately) and a non-integer bypasses the loop counter entirely.
  if (userOpts?.maxStopBlocks !== undefined) {
    if (
      !Number.isInteger(userOpts.maxStopBlocks)
      || !Number.isFinite(userOpts.maxStopBlocks)
      || userOpts.maxStopBlocks <= 0
    ) {
      throw new RangeError("maxStopBlocks must be a positive integer")
    }
  }
  const opts: Required<ElicifyVertexOptions> = {
    maxPerSession: 16,
    wireMessagesTransform: true,
    systemDirectives: defaultDirectives,
    activeAgent: "elicify-vertex-agent",
    activeSkillTrigger: "/elicify-vertex",
    maxStopBlocks: 3,
    ...userOpts,
  }

  const queue = new DirectiveQueue(opts.maxPerSession)
  const gate = new SessionGate()
  const ledger = new EvidenceLedger()
  const verificationReceipts = new VerificationReceiptStore()
  const defaultRoot = (() => {
    try {
      return resolveGoalWorkspaceRoot([input.worktree, input.directory, process.cwd()])
    } catch {
      // Plugin still loads; goal tools throw a clear error on use if no root.
      return process.cwd()
    }
  })()
  const goalRootsBySession = new Map<string, string>()

  const goalEngine = (context: { sessionID: string; directory: string; worktree: string }) => {
    const root = resolveGoalWorkspaceRoot([
      context.worktree,
      context.directory,
      goalRootsBySession.get(context.sessionID),
      defaultRoot,
      process.cwd(),
    ])
    goalRootsBySession.set(context.sessionID, root)
    return new MultiStoryGoalEngine(root)
  }

  // Last-seen task classification per session (for signal routing).
  const taskModeBySession = new Map<string, TaskMode>()
  const reviewBySession = new Map<string, boolean>()
  const commandActivatedSessions = new Set<string>()
  const gateContinuationSessions = new Set<string>()
  const compactingSessions = new Set<string>()
  /** Sessions that already received the one-shot user-visible activate cue. */
  const activateCueShown = new Set<string>()

  // Last assistant text per session (for the promise-no-act guard).
  // Populated by experimental.text.complete; read by event(session.idle).
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
    } catch (err) {
      console.error("[vertex] debug log", err)
    }
  }
  debug("plugin loaded — debug mode enabled")

  const alwaysOn = () => opts.systemDirectives().map((d) => ({ ...d }))

  /**
   * Re-prompt after a gate decision. decision:"block" is only logged when prompt
   * actually runs. Missing/failed prompt → allow+would_block; queue already holds
   * the reason for system.transform. Continuation flag remains until chat.message
   * consumes it on success; cleared on prompt failure so next user turn resets.
   *
   * The prompt call is wrapped in Promise.race with a CONTINUATION_TIMEOUT_MS
   * timer so a hung session.prompt cannot leave gateContinuationSessions set
   * indefinitely (which would silently disable the gate for the rest of the
   * session). On timeout: clear the flag, log gate_fire with reason
   * "continuation timeout", and leave the directive queue intact for the
   * next system.transform.
   */
  const CONTINUATION_TIMEOUT_MS = 30_000
  const CONTINUATION_TIMEOUT_ERROR = "continuation timeout"
  const attemptGateContinuation = async (
    sid: string,
    reason: string,
    payload: Omit<GateFirePayload, "decision">,
  ): Promise<void> => {
    // GateFirePayload extends Record<string, unknown>; spread+Omit does not
    // preserve known keys under tsc — copy fields explicitly.
    const fire = (
      decision: GateFirePayload["decision"],
      extra?: { reason?: string },
    ): void => {
      logGateFire(sid, {
        decision,
        changed: Boolean(payload.changed),
        verified: Boolean(payload.verified),
        stop_blocks: Number(payload.stop_blocks),
        max_stop_blocks: Number(payload.max_stop_blocks),
        would_block: Boolean(payload.would_block),
        ...(extra?.reason !== undefined ? { reason: extra.reason } : {}),
      })
    }
    if (!client?.session?.prompt) {
      console.error("[vertex] session.prompt unavailable; cannot enforce stop gate")
      fire("allow", { reason: "session.prompt unavailable" })
      return
    }
    gateContinuationSessions.add(sid)
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error(CONTINUATION_TIMEOUT_ERROR)),
          CONTINUATION_TIMEOUT_MS,
        )
      })
      await Promise.race([
        client.session.prompt({
          path: { id: sid },
          body: { parts: [{ type: "text", text: formatGateContinuationText(reason) }] },
        }),
        timeoutPromise,
      ])
      fire("block")
    } catch (err) {
      console.error("[vertex] session.prompt", err)
      // Always clear the in-flight flag on failure — the gate must not be
      // silently disabled for the rest of the session.
      gateContinuationSessions.delete(sid)
      const isTimeout = err instanceof Error && err.message === CONTINUATION_TIMEOUT_ERROR
      fire("allow", { reason: isTimeout ? CONTINUATION_TIMEOUT_ERROR : "session.prompt failed" })
      // Queue is preserved in both cases: the stop-block / promise-no-act
      // directive was enqueued BEFORE attemptGateContinuation was called, so
      // system.transform on the next turn still delivers it.
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle)
    }
  }

  return {
    // ── TOOLS: persistent multi-story goal engine ─────────────────────────
    tool: {
      elicify_vertex_goal_create: tool({
        description:
          "Create a sequential multi-story elicify-vertex goal plan under <project>/.elicify-vertex/. " +
          "Requires a writable project directory (not filesystem root). " +
          "A final verification story is appended automatically. " +
          "Pass brief + stories[{title,objective}]; use replace=true to archive an existing plan.",
        args: {
          brief: tool.schema.string().min(1),
          stories: tool.schema.array(tool.schema.object({
            title: tool.schema.string().min(1),
            objective: tool.schema.string().min(1),
          })).min(1),
          replace: tool.schema.boolean().optional().default(false),
        },
        async execute(args, context) {
          const engine = goalEngine(context)
          const plan = engine.create(args.brief, args.stories as GoalStoryInput[], args.replace)
          return JSON.stringify({ ...plan, workspaceRoot: engine.root }, null, 2)
        },
      }),
      elicify_vertex_goal_next: tool({
        description:
          "Start or return the active story in the elicify-vertex multi-story plan " +
          "(state in <project>/.elicify-vertex/goals.json). Work only that story until checkpointed.",
        args: {},
        async execute(_args, context) {
          const engine = goalEngine(context)
          return JSON.stringify({ ...engine.next(), workspaceRoot: engine.root }, null, 2)
        },
      }),
      elicify_vertex_goal_checkpoint: tool({
        description:
          "Checkpoint the active elicify-vertex story (complete|failed|blocked) with evidence. " +
          "The final verification story requires verificationReceiptId from a successful " +
          "allowlisted verifier observed earlier in this session (see [vertex:verification-receipt]).",
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
          const engine = goalEngine(context)
          const plan = engine.checkpoint(args.id, args.status, args.evidence, receipt)
          return JSON.stringify({ ...plan, workspaceRoot: engine.root }, null, 2)
        },
      }),
      elicify_vertex_goal_status: tool({
        description:
          "Read the elicify-vertex multi-story goal plan for the current project " +
          "(null if none). State lives at <project>/.elicify-vertex/goals.json.",
        args: {},
        async execute(_args, context) {
          const engine = goalEngine(context)
          const plan = engine.status()
          return JSON.stringify(plan ? { ...plan, workspaceRoot: engine.root } : null, null, 2)
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
          description:
            "Inject elicify-vertex verification discipline into this session and activate the harness.",
          template: elicifyVertexSlashTemplate(),
        }
      }
      const goalCommands: Record<string, { description: string; template: string }> = {
        "elicify-vertex-goal-create": {
          description: "Create an elicify-vertex multi-story plan (project/.elicify-vertex).",
          template: `Create an elicify-vertex multi-story goal plan with the tool elicify_vertex_goal_create.

Requirements:
- Work in a writable project directory (not filesystem root). If the session is not in a project, create or cd into one first.
- Call elicify_vertex_goal_create with JSON args:
  - brief: one-paragraph outcome
  - stories: array of { title, objective } (at least one work story)
  - replace: optional boolean (archive existing plan)
- A final verification story is appended automatically — do not invent one by hand.
- If $ARGUMENTS is empty or incomplete, ask the user for brief + stories before calling the tool.
- After create, call elicify_vertex_goal_next and work only the active story.

User arguments (may be empty):
$ARGUMENTS`,
        },
        "elicify-vertex-goal-next": {
          description: "Start or resume the next elicify-vertex story.",
          template: `Call elicify_vertex_goal_next, report the active story (id, title, objective), and work only that story until you checkpoint it. If there is no plan, tell the user to run /elicify-vertex-goal-create first.

$ARGUMENTS`,
        },
        "elicify-vertex-goal-checkpoint": {
          description: "Checkpoint the active elicify-vertex story with evidence.",
          template: `Call elicify_vertex_goal_checkpoint for the active story.
- status: complete | failed | blocked
- evidence: what was done / observed
- For the final verification story only: pass verificationReceiptId from a successful allowlisted verifier in this session ([vertex:verification-receipt] id).
If args are missing, infer id from elicify_vertex_goal_status / next; otherwise ask.

User arguments:
$ARGUMENTS`,
        },
        "elicify-vertex-goal-status": {
          description: "Show the elicify-vertex multi-story plan status.",
          template: `Call elicify_vertex_goal_status and report: workspaceRoot, plan status, active story, and next legal step (next / checkpoint / create). If null, no plan exists yet.

$ARGUMENTS`,
        },
      }
      for (const [name, command] of Object.entries(goalCommands)) {
        cfgInput.command[name] ??= command
      }
    },

    async "command.execute.before"(commandInput) {
      if (commandInput.command === "elicify-vertex") {
        commandActivatedSessions.add(commandInput.sessionID)
        gate.activate(commandInput.sessionID)
        debug(`command.execute.before: ACTIVATED session ${commandInput.sessionID}`)
      }
    },

    // ── CHAT.MESSAGE: session gate + ledger reset + task classification ────
    async "chat.message"(msgInput, output) {
      try {
        lastAssistantText.delete(msgInput.sessionID)
        compactingSessions.delete(msgInput.sessionID)
        const gateContinuation = gateContinuationSessions.delete(msgInput.sessionID)
        const agent = msgInput.agent
        const text = (output.parts || [])
          .filter((p) => p && p.type === "text" && typeof (p as any).text === "string")
          .map((p) => (p as any).text)
          .join("\n")

        // Single activation slash: activeSkillTrigger only (default /elicify-vertex).
        const triggerEscaped = opts.activeSkillTrigger.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        const triggerRe = new RegExp(`^\\s*${triggerEscaped}\\b`, "m")

        const activatedByCommand = commandActivatedSessions.has(msgInput.sessionID)
        if (agent === opts.activeAgent || triggerRe.test(text) || activatedByCommand || gateContinuation) {
          gate.activate(msgInput.sessionID)
          goalRootsBySession.set(msgInput.sessionID, goalRootsBySession.get(msgInput.sessionID) ?? defaultRoot)
          if (gateContinuation) {
            debug(`chat.message: CONTINUATION session ${msgInput.sessionID} (ledger preserved)`)
            return
          }
          const sigMode = classifyStopMode(text)
          ledger.reset(msgInput.sessionID, sigMode.mode, sigMode.risks)
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
          // One minimal user-visible line the first time this session becomes
          // harness-active (covers agent select and /elicify-vertex). Not every turn.
          if (!activateCueShown.has(msgInput.sessionID)) {
            activateCueShown.add(msgInput.sessionID)
            const cue = formatActivateCue({
              stopMode: sigMode.mode,
              taskMode: mode,
              agent: agent || undefined,
            })
            output.parts.push({ type: "text", text: `\n${cue}` } as any)
            debug(`chat.message: ACTIVATE CUE for ${msgInput.sessionID}: ${cue}`)
          }
        } else if (agent !== undefined && agent !== opts.activeAgent) {
          gate.deactivate(msgInput.sessionID)
          activateCueShown.delete(msgInput.sessionID)
          debug(`chat.message: DEACTIVATED session ${msgInput.sessionID} (agent=${agent})`)
        }
      } catch (err) {
        console.error("[vertex] chat.message", err)
      }
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
        const changedPaths = changedPathsFromTool(toolName, args)

        if (changedPaths.length > 0) verificationReceipts.invalidate(sid)

        // After a tool call, any prior assistant text is no longer the
        // "final" reply of the turn (the model may produce more text later).
        // Clearing it on tool.after means session.idle only sees the last text
        // produced AFTER the latest tool call, mirroring fablize's
        // `last_had_tool` exemption.
        if (gate.isActive(sid)) {
          lastAssistantText.delete(sid)
        }

        // Goal receipts work independently of the session directive gate: the
        // config-hook goal commands can be used from any primary agent.
        // Mint even when no goal tool has run yet — bind the plugin default root.
        if (verification?.outcome === "verified" && exitCode === 0) {
          const workspaceRoot = goalRootsBySession.get(sid) ?? defaultRoot
          goalRootsBySession.set(sid, workspaceRoot)
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

        if (!gate.isActive(sid)) return

        // ── Mutations: record direct edits, patches, and mutating shell calls ──
        for (const filePath of changedPaths) {
          ledger.recordChangedFiles(sid, filePath)
          debug(`tool.after: ${toolName} on ${filePath} → file changed recorded for ${sid}`)
        }

        // ── Bash: record verification or failure (positive allowlist + patterns) ──
        if (toolName === "bash" && verification) {
          if (verification.isVerificationCommand) {
            // Count only a reliable exit 0 with no contradictory failure
            // output. Silent verifiers such as tsc are valid evidence.
            const success = verification.outcome === "verified"
            if (exitCode !== undefined) {
              ledger.recordVerification(sid, command, exitCode, verification.outcome)
            }
            debug(`tool.after: bash "${command.slice(0, 60)}" → outcome=${verification.outcome}, verified=${success}, pattern=${verification.matchedPattern}`)
          }

          // Failure detection
          if (exitCode !== undefined && exitCode !== 0) {
            const firstErrLine = out.split("\n").find((l) => l.trim()) ?? "unknown error"
            const signature = `${exitCode}:${failureSignature(firstErrLine)}`
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
      } catch (err) {
        console.error("[vertex] tool.execute.after", err)
      }
    },

    // ── SYSTEM.TRANSFORM: the INJECT PATH (signal-routed + evidence-aware)
    // Sole consumer of DirectiveQueue.drain (H5).
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

      const stopMode = ledger.getMode(sid)
      if (stopMode) {
        const guidance = contextForStopMode({ mode: stopMode, risks: ledger.getRiskFlags(sid) })
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
      const queued = compactingSessions.has(sid) ? [] : queue.drain(sid)
      combined.push(...queued)

      const block = formatDirectives(combined)
      if (!block) return
      sysOutput.system = [...sysOutput.system, block]
      debug(`system.transform: INJECTED ${combined.length} directive(s) into ${sid} (mode=${mode || "none"}, queued=${queued.length})`)
    },

    // ── MESSAGES.TRANSFORM: intentionally does NOT drain DirectiveQueue (H5).
    // system.transform is the only queue consumer so stop/fail directives are
    // not stolen by a messages path that races first.
    ...(opts.wireMessagesTransform
      ? {
          async "experimental.chat.messages.transform"() {
            /* no-op: do not drain */
          },
        }
      : {}),

    async "experimental.text.complete"(textInput, textOutput) {
      if (gate.isActive(textInput.sessionID) && textOutput.text.trim()) {
        lastAssistantText.set(textInput.sessionID, textOutput.text)
      }
    },

    // `experimental.chat.messages.transform` is invoked after text is
    // assembled; on each call the last assistant text is a fresh chunk. We
    // also clear on tool.execute.after below to honor fablize's last_had_tool
    // exemption: when the turn ends on a tool part, do not let stale text
    // (e.g. "Let me run the tests now") survive into session.idle.

    async "experimental.session.compacting"(compactionInput) {
      compactingSessions.add(compactionInput.sessionID)
    },

    // ── EVENT: the STOP GATE ──────────────────────────────────────────────
    async event({ event }) {
      try {
        if (event.type === "session.compacted") {
          compactingSessions.delete(event.properties.sessionID)
          return
        }
        if (event.type === "file.edited") {
          // Only attribute (and invalidate receipts) when a single session is
          // active — multi-active has no reliable session attribution, matching
          // ledger non-attribution. Do not broadcast-invalidate all sessions.
          const activeSessions = gate.activeSessionIDs()
          if (activeSessions.length === 1) {
            const sessionID = activeSessions[0]
            verificationReceipts.invalidate(sessionID)
            ledger.recordChangedFiles(sessionID, event.properties.file)
          }
          return
        }
        if (event.type !== "session.idle") return
        const sid = event.properties?.sessionID
        if (typeof sid !== "string") return
        if (!gate.isActive(sid)) return

        // In-flight guard: if a forced continuation is still pending, do not
        // re-block. Prevents double idles from issuing two session.prompts for
        // the same stop (fablize `stop_hook_active` parity).
        if (gateContinuationSessions.has(sid)) {
          debug(`event: ${sid} — session.idle SKIPPED (continuation in-flight)`)
          return
        }

        debug(`event: session.idle for ${sid}`)

        // ── PROMISE-NO-ACT GUARD (finish-the-work policy) ────────────────
        // Catch strong deferral/TODO/FIXME/issue-filing (and weak later/
        // tracked when unverified) in the final assistant message. Only
        // blocks when files were changed (pure Q&A / ask-user ends freely).
        const lastText = lastAssistantText.get(sid)
        if (lastText) {
          const hits = detectPromiseNoAct(lastText)
          if (shouldBlockPromiseNoAct(lastText, ledger.hasChangedFiles(sid), ledger.hasVerification(sid))) {
            const labels = hits.map((h) => h.label).join(", ")
            const reason = `[vertex:promise-no-act] Your last message states an intent to do further work (${labels}) after changing files, without doing it. Do that work now with tool calls. End the turn only when the work is complete, or ask the user a direct question if you are blocked on input only they can provide.`
            debug(`event: ${sid} — PROMISE-NO-ACT (${labels})`)

            // M3 holdout skip (same as the unverified block path)
            if (holdoutSuppresses(sid)) {
              logHoldoutSuppress(sid, "promise-no-act skipped (holdout arm=off)")
              logGateFire(sid, {
                decision: "allow",
                changed: true,
                verified: ledger.hasVerification(sid),
                stop_blocks: ledger.getPromiseBlocks(sid),
                max_stop_blocks: opts.maxStopBlocks,
                would_block: true,
              })
              debug(`event: ${sid} — HOLDOUT, promise-no-act suppressed`)
            } else {
              const count = ledger.incrementPromiseBlocks(sid)
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
              debug(`event: ${sid} — PROMISE-NO-ACT BLOCK ${count}/${cap}`)
              await attemptGateContinuation(sid, reason, {
                changed: true,
                verified: ledger.hasVerification(sid),
                stop_blocks: count,
                max_stop_blocks: cap,
                would_block: true,
              })
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
            text: `[vertex:stop-warning] Verification evidence is still missing — include that gap in the final report.`,
          })
          return
        }

        const count = ledger.incrementStopBlocks(sid)
        const reason = `[vertex:stop-block] Files were changed this turn but no successful verification command was observed. Run the narrowest relevant test, lint, typecheck, build, check, validate, verify, or HTTP probe now and cite its observed result. If genuinely none applies, say so explicitly and why.`

        queue.enqueue(sid, { id: "vertex:stop-block", text: reason })
        debug(`event: ${sid} — STOP BLOCK ${count}/${opts.maxStopBlocks} (changed files, no verification)`)

        await attemptGateContinuation(sid, reason, {
          changed: ledger.hasChangedFiles(sid),
          verified: ledger.hasVerification(sid),
          stop_blocks: count,
          max_stop_blocks: opts.maxStopBlocks,
          would_block: true,
        })
      } catch (err) {
        console.error("[vertex] event", err)
      }
    },
  }
}

export default ElicifyVertexPlugin
export const server = ElicifyVertexPlugin
