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


// ===========================================================================
// SESSION GATE (unchanged from before)
// ===========================================================================


// ===========================================================================
// EVIDENCE LEDGER — the READ PATH's memory
// ===========================================================================

const REPEAT_FAILURE_THRESHOLD = 2
/** Distinct changed paths kept per turn for the evidence-rich stop-block. */
const MAX_TRACKED_CHANGED_PATHS = 10

interface SessionLedger {
  changedFilesSeen: boolean
  /** Distinct kinds of files changed — path-kind classifier. */
  changedFileKinds: Set<FileKind>
  /** Distinct changed paths this turn (capped) — surfaced in stop-block reasons. */
  changedFilePaths: string[]
  /** Set per-prompt to the classified mode (normal/deep) — stop-mode classifier */
  taskMode: StopMode
  riskFlags: Set<RiskFlag>
  verificationResults: Array<{ command: string; exitCode: number; success: boolean }>
  failures: Array<{ signature: string; timestamp: string }>
  /** Signatures whose repeat-failure directive already fired this turn (cooldown). */
  repeatSignaturesFired: Set<string>
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
      changedFilePaths: [],
      taskMode: mode,
      riskFlags: new Set(risks),
      verificationResults: [],
      failures: [],
      repeatSignaturesFired: new Set(),
      stopBlocks: 0,
      promiseBlocks: 0,
    }
  }

  /** Reset per-turn state (called on each new user message). */
  reset(
    sessionID: string,
    mode: StopMode = "normal",
    risks: readonly RiskFlag[] = [],
  ): void {
    this.ledgers.set(sessionID, this.freshLedger(mode, risks))
  }

  recordChangedFiles(sessionID: string, filePath: string): void {
    const l = this.ledgers.get(sessionID)
    if (!l) return
    l.changedFilesSeen = true
    const kind = classifyFileKind(filePath)
    l.changedFileKinds.add(kind)
    if (filePath && !l.changedFilePaths.includes(filePath) && l.changedFilePaths.length < MAX_TRACKED_CHANGED_PATHS) {
      l.changedFilePaths.push(filePath)
    }
    // (The old quick -> normal evidence promotion lived here. With `quick`
    // gone, `normal` IS the floor, so there is nothing to promote from.)
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

  /**
   * Per-signature cooldown for the repeat-failure directive. Returns true the
   * FIRST time a signature is marked this turn (caller should fire), false on
   * later calls (caller stays silent). Without this, the guard whose purpose
   * is "stop repeating yourself" repeats itself on every subsequent failure.
   */
  markRepeatFired(sessionID: string, signature: string): boolean {
    const l = this.ledgers.get(sessionID)
    if (!l) return false
    if (l.repeatSignaturesFired.has(signature)) return false
    l.repeatSignaturesFired.add(signature)
    return true
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
    let ledger = this.ledgers.get(sessionID)
    // MIN-1: mirror `incrementStopBlocks`, which mints a ledger rather than
    // returning 0. Returning 0 made the caller's `count > cap` test never
    // true, so the cap was inert in the window where a session is active but
    // its ledger has not been reset yet (`command.execute.before` activates
    // without resetting; the reset lands on the next `chat.message`).
    if (!ledger) {
      this.reset(sessionID)
      ledger = this.ledgers.get(sessionID)
      if (!ledger) return 0
    }
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

  /**
   * Decision-relevant ledger summary for injection. Returns the summary only
   * when it can change the model's next action: unverified changes pending, or
   * risk flags present. "files changed: yes" right after the model changed a
   * file is telling it what it just did — that is noise, not signal.
   */
  actionableSummary(sessionID: string): string | null {
    const l = this.ledgers.get(sessionID)
    if (!l) return null
    const unverifiedChanges = l.changedFilesSeen && !l.verificationResults.some((v) => v.success)
    if (!unverifiedChanges && l.riskFlags.size === 0) return null
    return this.summary(sessionID)
  }

  /** Distinct changed paths recorded this turn (capped), for stop-block evidence. */
  getChangedPaths(sessionID: string): string[] {
    return [...(this.ledgers.get(sessionID)?.changedFilePaths ?? [])]
  }

  /** Should the stop gate block? Deep mode, non-docs changes, no successful
   * verification after the latest mutation. Stop-gate policy: quick/normal never
   * hard-block; docs-only exempt; deep+changed+unverified blocks.
   */
  shouldBlockStop(sessionID: string): boolean {
    const l = this.ledgers.get(sessionID)
    if (!l) return false
    // quick and normal never hard-block.
    if (l.taskMode !== "deep") return false
    // docs-only → never block.
    if (l.changedFileKinds.size > 0 && [...l.changedFileKinds].every((k) => k === "docs")) return false
    // deep AND changed AND not verified → block.
    return l.changedFilesSeen && !l.verificationResults.some((v) => v.success)
  }

  getMode(sessionID: string): StopMode | null {
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
// Tail window: last PROMISE_TAIL_WINDOW chars. Blocking policy: see shouldBlockPromiseNoAct.
// ----------------------------------------------------------------------------

/** Only the tail of the assistant text is scanned for promise-no-act and
 * ask-user signals, leaving headroom on multi-sentence conclusions. */
const PROMISE_TAIL_WINDOW = 600

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
    // The verb list is what makes this an INTENT rather than a mention, so it
    // has to cover how models actually announce work. The original set missed
    // the single most common opening in a real stalled session — "Let me lay
    // out the plan and execute." — because neither `lay out`, `plan` nor
    // `execute` was in it, and the nudge that exists for exactly that case
    // therefore never fired. Every addition still requires one of the intent
    // lead-ins above, so "let me <verb>" carries the meaning, not the verb
    // alone.
    pattern: /\b(I'?ll|I will|let me|next,?\s*I|now\s*I'?ll)\b[^.!?\n]{0,80}\b(now|next|then|implement|create|write|add|run|fix|save|build|start|get started|proceed|continue|address|handle|investigate|review|plan|lay out|draft|draw up|outline|scaffold|set up|execute|carry out|go ahead|replace|delete|remove|update|refactor|wire|generate|migrate)\b/i,
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
 * Scan assistant text for promise-no-act signals. The keyword loop returns
 * every occurrence of every needle; the intent-pattern loop returns the first
 * match per pattern (patterns are not /g). Callers log all hits out-of-band
 * for measurement.
 *
 * Promise-no-act detector (finish-the-work policy) covers:
 *   - Explicit deferral markers (TODO/FIXME/XXX/deferred)
 *   - Issue-filing intent ("file an issue")
 *   - Constrained later/tracked/tracking patterns (no bare-keyword FPs)
 *   - Structured hits for measurement (not a boolean)
 */
export function detectPromiseNoAct(text: string): PromiseHit[] {
  if (!text) return []
  // Only inspect the tail (last PROMISE_TAIL_WINDOW chars) for more headroom
  // on multi-sentence conclusions without scanning the full turn.
  const tail = text.slice(-PROMISE_TAIL_WINDOW)
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
  const tail = text.slice(-PROMISE_TAIL_WINDOW).toLowerCase()
  return /\b(?:shall i|should i|would you like|do you want|let me know|which option)\b/i.test(tail)
}

/** Normalize a failure summary into a stable class key.
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
  // Keeps the FULL strong-label set. Changed files are proof the model was
  // working, so `todo-marker` / `follow-up` / `explicit-deferral` read as
  // deferrals of that work. That calibration does NOT transfer to a turn where
  // nothing happened — the no-work case is judged by `pauseJudge.ts`, not by
  // words, precisely because it was twice wrong here.
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

export type StopMode = "normal" | "deep"

const DEEP_RE =
  /\b(deep|thorough|thoroughly|exhaustive|end-to-end|production[- ]ready|deploy|deployment|migration|database|auth|security|refactor|large|complex|implement the plan)\b|끝까지|철저|전부|전체|배포|마이그레이션|인증|보안|리팩터/i

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

  // TWO MODES. `quick` is gone, and with it the whole class of failure it
  // caused: it was the FALLBACK, so every phrasing the keyword lists did not
  // recognise silently disabled the harness. Measured on a real session,
  // "hi" classified quick and nothing has ever promoted it back.
  //
  // `normal` is now the floor — soft nudges and the pause judge, never a hard
  // block — so an unrecognised message gets watched rather than ignored.
  // `deep` is the only opt-in, because hard-blocking a turn is the one
  // genuinely intrusive behaviour and deserves an explicit signal.
  //
  // What used to earn `quick` (explain-only, review-only, "just briefly") now
  // earns `normal`, which is the right answer: the harness may still nudge,
  // but it cannot block, and the pause judge — not a keyword — decides
  // whether a conversational turn is waiting on the user.
  return { mode: DEEP_RE.test(t) || risks.length > 0 ? "deep" : "normal", risks }
}

/** Mode guidance is injected independently from signal routing. Normal mode is
 * advisory-only; deep mode defines exit proof before the stop gate can fire. */
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


// ===========================================================================
// FORMATTING + CONSTANTS
// ===========================================================================


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
  stopMode: StopMode
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

/**
 * Human-readable changed-path list for the stop-block reason. Pseudo markers
 * from changedPathsFromTool become readable labels; long lists are truncated.
 */
export function formatChangedPathsForReason(paths: readonly string[], maxShown = 5): string {
  const PSEUDO_LABELS: Record<string, string> = {
    "edit-mutation": "(file edit)",
    "patch-mutation": "(patch)",
    "bash-mutation": "(shell mutation)",
  }
  const labeled = paths.map((p) => PSEUDO_LABELS[p] ?? p)
  if (labeled.length === 0) return "files changed"
  const shown = labeled.slice(0, maxShown).join(", ")
  const rest = labeled.length - maxShown
  return rest > 0 ? `${shown} (+${rest} more)` : shown
}

// ===========================================================================
// PLUGIN ENTRYPOINT
// ===========================================================================
