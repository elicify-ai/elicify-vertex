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
  /**
   * When the most recent file mutation was observed, ISO-8601.
   *
   * A verifier verdict is a SNAPSHOT of the worktree. Without this the harness
   * had no way to notice the code had moved under one: measured live, the
   * verifier failed two stories at 06:43:46, the model fixed both at 06:44:46,
   * and the harness went on re-litigating the old verdict because the only
   * freshness test compared `verifiedAt` against `completedAt` — which does
   * not move when a completed story is edited.
   */
  lastMutationAt: string | null
  /** Distinct kinds of files changed — path-kind classifier. */
  changedFileKinds: Set<FileKind>
  /** Distinct changed paths this turn (capped) — surfaced in stop-block reasons. */
  changedFilePaths: string[]
  /** Set per-prompt to the classified mode (normal/deep) — stop-mode classifier */
  taskMode: StopMode
  riskFlags: Set<RiskFlag>
  /**
   * `success` answers "did the command pass?"; `coversPrescribed` answers
   * "was it the command we were waiting for?". BACKLOG R-4: these used to be
   * the same bit. A passing verifier that did not cover the prescribed one
   * was recorded with `outcome: "failed"` — so a command that really did exit
   * 0 was written into the evidence ledger as a failure, and `summary()`
   * reported "failed: 1" back to the model that had just watched it pass.
   * Splitting them keeps the coverage signal (every consumer below still
   * requires BOTH, so verify-gap/stop-block behaviour is unchanged) without
   * the ledger asserting something untrue about the command itself.
   */
  verificationResults: Array<{ command: string; exitCode: number; success: boolean; coversPrescribed: boolean }>
  failures: Array<{ signature: string; timestamp: string }>
  /** Signatures whose repeat-failure directive already fired this turn (cooldown). */
  repeatSignaturesFired: Set<string>
  stopBlocks: number
  promiseBlocks: number
}

/**
 * The single definition of "this session has been verified". A result must
 * have PASSED and have covered what was prescribed. Every gate that used to
 * read `v.success` alone routes through here, so the coverage signal that
 * drives verify-gap survives R-4's split of the two bits unchanged.
 */
function countsAsVerification(v: SessionLedger["verificationResults"][number]): boolean {
  return v.success && v.coversPrescribed
}

export class EvidenceLedger {
  private readonly ledgers = new Map<string, SessionLedger>()

  private freshLedger(
    mode: SessionLedger["taskMode"],
    risks: readonly RiskFlag[],
  ): SessionLedger {
    return {
      changedFilesSeen: false,
      lastMutationAt: null,
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
    l.lastMutationAt = new Date().toISOString()
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

  /**
   * @param options.coversPrescribed  false when the command passed but did
   *   NOT cover the verifier the harness prescribed for the current changes
   *   (a "relevance gap"). Defaults to true, so every existing call site
   *   keeps its exact previous meaning. An off-target pass counts as
   *   verification NOWHERE — `hasVerification`, `shouldBlockStop` and
   *   `actionableSummary` all require both bits — it is simply no longer
   *   recorded as if the command had failed.
   */
  recordVerification(
    sessionID: string,
    command: string,
    exitCode: number,
    outcome: VerificationOutcome,
    options: { coversPrescribed?: boolean } = {},
  ): void {
    if (!Number.isSafeInteger(exitCode)) {
      throw new TypeError("exitCode must be a safe integer")
    }
    const l = this.ledgers.get(sessionID)
    if (!l) return
    l.verificationResults.push({
      command,
      exitCode,
      success: outcome === "verified",
      coversPrescribed: options.coversPrescribed !== false,
    })
  }

  recordFailure(sessionID: string, signature: string): void {
    const l = this.ledgers.get(sessionID)
    if (!l) return
    l.failures.push({ signature, timestamp: new Date().toISOString() })
  }

  hasVerification(sessionID: string): boolean {
    const l = this.ledgers.get(sessionID)
    return !!l && l.verificationResults.some(countsAsVerification)
  }

  hasChangedFiles(sessionID: string): boolean {
    return this.ledgers.get(sessionID)?.changedFilesSeen ?? false
  }

  /**
   * ISO timestamp of the last observed mutation, or null.
   *
   * TURN-SCOPED, not session-scoped: `reset()` installs a fresh ledger on
   * every activated user message, so this returns null again at the start of
   * each turn. That is the right scope for its one caller — verdict staleness
   * asks "did the code move since the verdict, within this turn?" — but it
   * does mean a verdict does NOT go stale across a user message. Callers that
   * need durability across turns cannot use this field.
   */
  getLastMutationAt(sessionID: string): string | null {
    return this.ledgers.get(sessionID)?.lastMutationAt ?? null
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
    const verified = l.verificationResults.filter(countsAsVerification).length
    const failed = l.verificationResults.filter((v) => !v.success).length
    // BACKLOG R-4: an off-target pass is neither. Counting it under "failed"
    // told the model its own passing command had failed; counting it under
    // "verified" would claim the prescribed suite had run. It gets its own
    // word.
    const offTarget = l.verificationResults.filter((v) => v.success && !v.coversPrescribed).length
    if (verified === 0 && failed === 0 && offTarget === 0 && !l.changedFilesSeen && l.riskFlags.size === 0) return null
    const parts: string[] = []
    if (l.changedFilesSeen) parts.push("files changed: yes")
    if (l.riskFlags.size > 0) parts.push(`risks: ${[...l.riskFlags].join(", ")}`)
    if (verified > 0) parts.push(`verified: ${verified}`)
    if (failed > 0) parts.push(`failed: ${failed}`)
    if (offTarget > 0) parts.push(`passed but off-target: ${offTarget}`)
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
    const unverifiedChanges = l.changedFilesSeen && !l.verificationResults.some(countsAsVerification)
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
    return l.changedFilesSeen && !l.verificationResults.some(countsAsVerification)
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
// `install\b` is anchored to the segment head, so bare `install` matched but
// `npm install` did not — a turn that only added a dependency read as
// "nothing changed", even though it writes node_modules and the lockfile.
// The package managers are named explicitly for the same reason `build` is.
/**
 * A rehearsal is not a mutation. `npm install --dry-run`, `git apply --check`
 * and friends print what they WOULD do and touch nothing, but they match the
 * mutation patterns head-on — which let a read-only command satisfy the
 * evidence floor that exists to prove work actually happened.
 *
 * Long forms ONLY. A bare `-n` was here and meant the opposite in the commands
 * that matter: `git commit -n` is `--no-verify` (a real commit, common in
 * agent loops), `cp -n` / `mv -n` are `--no-clobber`. It suppressed all three.
 */
const DRY_RUN_RE = /(?:^|\s)(?:--dry-run|--dryrun|--check)(?:\s|$)/i

const MUTATING_BASH_RE = /^(?:sudo(?:\s+-[A-Za-z]+(?:\s+\S+)?)*\s+)?(?:apply_patch\b|chmod\b|mkdir\b|mv\b|cp\b|rm\b|touch\b|install\b|ln\b|truncate\b|sed\s+-i|perl\s+-pi|git\s+(?:add|commit|checkout|switch|restore|reset|clean|apply|am|merge|rebase|cherry-pick)|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b|(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|remove|uninstall|ci|update|upgrade)\b)/i
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
    (seg) => !DRY_RUN_RE.test(seg) && (MUTATING_BASH_RE.test(seg) || MUTATING_BASH_FLAG_RE.test(seg)),
  )
    || segments.some((seg) => downloaderIsMutation(seg))
    || shellRedirectTargetsWorkspace(command)
    || teeIsMutation(command)
    || pythonIsMutation(command)
    || NODE_INLINE_WRITE_RE.test(command)
  return anyMutator
}

// ===========================================================================
// BASH PATH ATTRIBUTION — "WHICH file did that shell command touch?"
// ===========================================================================
//
// THE MEASURED FAILURE THIS SECTION EXISTS TO END.
//
// `changedPathsFromTool` used to answer every mutating bash command with the
// single pathless marker `["bash-mutation"]`, even when the command named its
// target in plain sight (`cat > index.html <<EOF`, `touch a.js`,
// `echo x > src/a.js`). Downstream, `plugin.ts` and `diffstat.ts` both strip
// markers out (`NON_PATH_MUTATION_MARKERS`) to get a list git and
// `resolveVerifier` can use — so for a session that built its whole app
// through the bash tool that list was ALWAYS empty.
//
// Measured in live session ses_0254e14e (29 min, a working web app served on
// :8090): 0 non-empty `changedPaths` across every session in the log;
// `hasChangedFiles` TRUE while the filtered list was EMPTY (so the verify-gap
// producer ran and then found nothing to reason about); 40 x
// `resolution:none` with `changedPaths: []`; `verifier:field-dropped
// {verifierSummaries}`; `verifier:verdict-not-enforced` x4 and
// `verifier:unverified` for all five stories. The harness was blind for the
// whole session because a parser it never had was assumed to exist.
//
// The rules this parser holds itself to:
//
//  - ATTRIBUTE PER SEGMENT. `touch a.js && npm install` knows about `a.js`
//    AND knows that something else changed it cannot name, so it reports
//    BOTH — the path and the marker. Never collapse one into the other.
//  - NEVER REGRESS TO SILENCE. The marker stays as the fallback for commands
//    that genuinely mutate without naming a file (`npm install`,
//    `git checkout`, `mkdir -p src`, a `python3 <<PY` inline write). "We know
//    something changed but not what" must never degrade to "nothing changed".
//  - OVER-EXTRACTION IS ITS OWN BUG. Attributing `/dev/null`, a URL, a flag,
//    an unexpanded `$VAR`, a glob, a process substitution, or `/tmp/build.log`
//    as a project change is worse than the marker: it puts a lie in the
//    ledger, mis-scopes `resolveVerifier`, and trips the scope watchdog.
//    `isPlausibleTargetToken` and the workspace bound are the filters.
//  - `isMutatingBashCommand` IS NOT TOUCHED. Its true/false answers are
//    correct today and are pinned by tests (`npm install --dry-run`,
//    `git commit -n`, `cp -n`, `sudo -u`, …). This section only answers the
//    SECOND question — given that it mutates, what did it touch — and only
//    ever runs when `isMutatingBashCommand` has already said yes.

/** Heads whose non-flag operands are the files they change. */
const BASH_TARGET_ALL_OPERANDS = new Set(["touch", "rm", "unlink", "mv", "truncate"])
/** Heads whose LAST operand is the destination they create/overwrite. */
const BASH_TARGET_LAST_OPERAND = new Set(["cp", "ln", "install"])
/** Options that consume the following token as their value, per head. */
const BASH_VALUE_OPTIONS: Record<string, ReadonlySet<string>> = {
  truncate: new Set(["-s", "--size", "-r", "--reference"]),
  chmod: new Set(["--reference"]),
  install: new Set(["-m", "--mode", "-o", "--owner", "-g", "--group", "-t", "--target-directory"]),
  cp: new Set(["-t", "--target-directory", "-S", "--suffix"]),
  mv: new Set(["-t", "--target-directory", "-S", "--suffix"]),
  ln: new Set(["-t", "--target-directory", "-S", "--suffix"]),
  sed: new Set(["-e", "--expression", "-f", "--file", "-l", "--line-length"]),
  perl: new Set(["-e", "-E", "-I", "-m", "-M"]),
}
/** Sudo prefix accepted by MUTATING_BASH_RE, stripped before head lookup so
 * `sudo -u ci touch a.js` still attributes `a.js`. */
const SUDO_PREFIX_RE = /^sudo(?:\s+-[A-Za-z]+(?:\s+\S+)?)*\s+/i
/** The `*** Add|Update|Delete File:` envelope, shared by the `apply_patch`
 * tool and its bash invocation (opencode accepts both spellings). */
const PATCH_FILE_ENVELOPE_RE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm
/** A token that cannot be a project file: flag, URL, unexpanded expansion,
 * glob, process substitution, fd number, or a shell operator fragment. */
const NON_TARGET_TOKEN_RE = /[*?()<>|`$\n]|:\/\//
/** Kernel/device pseudo-filesystems. `> /dev/null` is a discard, not a write. */
const PSEUDO_FS_RE = /^\/(?:dev|proc|sys)(?:\/|$)/
/** Ceiling on paths attributed to one command. A `rm -rf a b c …` with a
 * hundred operands should not flood the ledger; past the cap the marker
 * records that the list is incomplete. */
const MAX_ATTRIBUTED_BASH_PATHS = 32

/** Read one quote-aware shell word starting at `start`. Returns the UNQUOTED
 * value and the index just past it. Stops at unquoted whitespace and at the
 * operator characters that end a word. */
function readShellWord(text: string, start: number): { token: string; next: number } {
  let raw = ""
  let quote: '"' | "'" | null = null
  let i = start
  for (; i < text.length; i++) {
    const ch = text[i]
    if (quote === "'") {
      if (ch === "'") quote = null
      else raw += ch
      continue
    }
    if (quote === '"') {
      if (ch === "\\" && i + 1 < text.length) {
        raw += text[i + 1]
        i++
        continue
      }
      if (ch === '"') quote = null
      else raw += ch
      continue
    }
    if (ch === "\\" && i + 1 < text.length) {
      raw += text[i + 1]
      i++
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (/[\s;|&<>()]/.test(ch)) break
    raw += ch
  }
  return { token: raw, next: i }
}

/**
 * Split one shell segment into its WORDS and its REDIRECT TARGETS, quote-aware.
 *
 * Doing both in one pass is what lets `touch a.js > log.txt` report `a.js` as
 * an operand and `log.txt` as a redirect instead of counting `log.txt` twice,
 * and what keeps a quoted path with a space (`> "my file.txt"`) in one piece —
 * which `SHELL_FILE_REDIRECT_RE`'s `(\S+)` capture cannot do, and must not be
 * changed to do, because that regex answers the frozen `isMutatingBashCommand`
 * question.
 *
 * fd duplications (`2>&1`, `>&2`) are consumed and discarded; input redirects
 * and heredoc openers (`< in`, `<<EOF`) are consumed so their word is never
 * mistaken for an operand.
 */
function parseShellSegment(segment: string): { words: string[]; redirects: string[] } {
  const words: string[] = []
  const redirects: string[] = []
  let i = 0
  const skipBlanks = (): void => {
    while (i < segment.length && (segment[i] === " " || segment[i] === "\t")) i++
  }
  const consumeWord = (): string => {
    const read = readShellWord(segment, i)
    i = read.next === i ? i + 1 : read.next
    return read.token
  }
  while (i < segment.length) {
    const ch = segment[i]
    if (/\s/.test(ch)) {
      i++
      continue
    }
    if (ch === "<") {
      // `<file`, `<<EOF`, `<<-EOF`, `<<<word` — consume the operator and the
      // word that names its source/delimiter. Neither is a changed path.
      while (segment[i] === "<") i++
      if (segment[i] === "-") i++
      skipBlanks()
      consumeWord()
      continue
    }
    if (ch === ">" || (ch === "&" && segment[i + 1] === ">")) {
      if (ch === "&") i++
      i++ // the `>`
      if (segment[i] === ">") i++ // append form
      if (segment[i] === "&") {
        // fd duplication (`2>&1`, `>&2`): the word is a descriptor, not a file.
        i++
        consumeWord()
        continue
      }
      if (segment[i] === "|") i++ // `>|` clobber form
      skipBlanks()
      const target = consumeWord()
      if (target) redirects.push(target)
      continue
    }
    if (ch === ";" || ch === "|" || ch === "&" || ch === "(" || ch === ")") {
      i++
      continue
    }
    const read = readShellWord(segment, i)
    if (read.next === i) {
      i++
      continue
    }
    // A bare fd number immediately followed by `>` belongs to the redirect
    // that comes next, not to the argument list.
    const isFdPrefix = /^\d+$/.test(read.token) && segment[read.next] === ">"
    if (!isFdPrefix) words.push(read.token)
    i = read.next
  }
  return { words, redirects }
}

/**
 * Remove heredoc BODIES before the command is parsed for paths.
 *
 * `cat > index.html <<EOF … EOF` names its target in the redirect; the body is
 * the file's CONTENT and must never be mined for paths. It routinely contains
 * text that looks exactly like a redirect once `shellSegments` has split it on
 * newlines (a shell snippet inside a README, `<a href="x" >` in HTML), and every
 * such hit would be a fabricated changed path. The opener line is kept so the
 * redirect target survives; the body and its closing delimiter line are dropped.
 *
 * `<<<` here-strings are excluded by the lookarounds — they have no body.
 */
const HEREDOC_OPENER_RE = /(?<!<)<<(?!<)-?[ \t]*(?:(['"])([^'"\n]+)\1|([A-Za-z_][A-Za-z0-9_]*))/

function stripHeredocBodies(command: string): string {
  if (!command.includes("<<")) return command
  let kept = ""
  let offset = 0
  for (let guard = 0; guard < 64; guard++) {
    const opener = HEREDOC_OPENER_RE.exec(command.slice(offset))
    if (!opener) break
    const openerEnd = offset + opener.index + opener[0].length
    const delimiter = opener[2] ?? opener[3]
    const lineEnd = command.indexOf("\n", openerEnd)
    const body = lineEnd === -1 ? "" : command.slice(lineEnd + 1)
    const closing =
      delimiter && lineEnd !== -1
        ? new RegExp(`^[\\t ]*${escapeRegExp(delimiter)}[\\t ]*$`, "m").exec(body)
        : null
    if (!closing) {
      // Not a heredoc after all — a `<<` inside a quoted argument
      // (`echo "a << b" > f.txt`), or an opener whose body never closes.
      // Keep the text and resume scanning AFTER it; dropping the remainder
      // here would silently lose every later segment's paths.
      kept += command.slice(offset, openerEnd)
      offset = openerEnd
      continue
    }
    kept += command.slice(offset, lineEnd + 1)
    offset = lineEnd + 1 + closing.index + closing[0].length
  }
  return kept + command.slice(offset)
}

/** Could this token name a file in the project? See NON_TARGET_TOKEN_RE. */
function isPlausibleTargetToken(token: string): boolean {
  if (!token || token.length > 4096) return false
  if (token.startsWith("-")) return false // a flag, not a path
  if (token === "." || token === "..") return false
  if (/^\d+$/.test(token)) return false // a file descriptor
  if (NON_TARGET_TOKEN_RE.test(token)) return false
  if (PSEUDO_FS_RE.test(token)) return false
  if (token.endsWith("/dev/null")) return false
  return true
}

/** Join a `cd`-relative base with a path fragment, POSIX-style. */
function joinPathParts(base: string, fragment: string): string {
  if (!fragment) return base
  if (fragment.startsWith("/")) return normalizePosixPath(fragment)
  if (!base) return normalizePosixPath(fragment)
  return normalizePosixPath(`${base.replace(/\/+$/, "")}/${fragment}`)
}

/** Collapse `.`/`..`/duplicate separators without touching the filesystem. */
function normalizePosixPath(path: string): string {
  const absolute = path.startsWith("/")
  const out: string[] = []
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue
    if (part === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop()
      else if (!absolute) out.push("..")
      continue
    }
    out.push(part)
  }
  const joined = out.join("/")
  if (absolute) return `/${joined}`
  return joined || "."
}

/** Is `candidate` at or under `root`? Both must already be absolute. */
function isUnderRoot(candidate: string, root: string): boolean {
  const normalizedRoot = normalizePosixPath(root).replace(/\/+$/, "")
  if (!normalizedRoot || normalizedRoot === "/") return true
  return candidate === normalizedRoot || candidate.startsWith(`${normalizedRoot}/`)
}

export interface BashAttributionOptions {
  /**
   * The session's worktree root. When known, relative targets are resolved
   * against it (so a bash write and an `edit` call spell the same file the
   * same way), and ABSOLUTE targets outside it are dropped — which is what
   * keeps `> /tmp/build.log` or `touch ~/scratch/x` out of the ledger without
   * a `/tmp` blacklist that would break every workspace that legitimately
   * lives under a temp directory.
   */
  workspaceRoot?: string
}

/**
 * The paths a mutating bash command names, plus `bash-mutation` when some part
 * of it mutated without naming anything. Returns `[]` for a non-mutating
 * command — `isMutatingBashCommand` remains the sole authority on that.
 */
export function changedPathsFromBashCommand(command: string, options: BashAttributionOptions = {}): string[] {
  if (!isMutatingBashCommand(command)) return []

  const root = options.workspaceRoot ? normalizePosixPath(options.workspaceRoot) : ""
  const paths: string[] = []
  let unattributed = false
  let overflowed = false

  const record = (rawToken: string, base: string): void => {
    if (!isPlausibleTargetToken(rawToken)) return
    // The directory the token is relative to: an absolute `cd` wins outright,
    // otherwise the worktree root with any relative `cd` prefix applied. With
    // no root known the base stays relative and the token is recorded as
    // written, which is the honest answer to "relative to what?".
    const anchor = base.startsWith("/") ? base : joinPathParts(root, base)
    const resolved = rawToken.startsWith("/") ? normalizePosixPath(rawToken) : joinPathParts(anchor, rawToken)
    if (PSEUDO_FS_RE.test(resolved)) return
    if (root && resolved.startsWith("/") && !isUnderRoot(resolved, root)) return
    if (paths.includes(resolved)) return
    if (paths.length >= MAX_ATTRIBUTED_BASH_PATHS) {
      overflowed = true
      return
    }
    paths.push(resolved)
  }

  // `apply_patch` carries its targets inside the heredoc body — the one place
  // a heredoc body IS the evidence — so it is read from the RAW command before
  // the bodies are stripped.
  let patchNamedFiles = false
  if (/(?:^|[\s;|&(])(?:sudo\s+)?apply_?patch\b/i.test(command)) {
    for (const match of command.matchAll(PATCH_FILE_ENVELOPE_RE)) {
      patchNamedFiles = true
      record(match[1].trim(), "")
    }
  }

  let base = "" // the `cd` prefix in force for the segments that follow
  for (const rawSegment of shellSegments(stripHeredocBodies(command))) {
    const segment = rawSegment.replace(SUDO_PREFIX_RE, "").trim()
    if (!segment) continue
    const { words, redirects } = parseShellSegment(segment)
    const head = (words[0] ?? "").toLowerCase()

    if (head === "cd") {
      const target = words[1]
      // `cd`, `cd -`, `cd ~…` and any expansion we cannot resolve reset the
      // base rather than guessing — a wrong base is a wrong path.
      base = target && isPlausibleTargetToken(target) && !target.startsWith("~") ? joinPathParts(base, target) : ""
      continue
    }

    let named = redirects.length
    for (const target of redirects) record(target, base)

    // A rehearsal changes nothing; mirror `isMutatingBashCommand`'s own guard.
    const rehearsal = DRY_RUN_RE.test(segment)
    const operands = rehearsal ? [] : operandTargetsForHead(head, words.slice(1))
    named += operands.length
    for (const target of operands) record(target, base)

    // The `apply_patch` segment's own targets came from the patch envelope
    // above, so it is already attributed even though the segment names none.
    const attributedElsewhere = patchNamedFiles && /^apply_?patch\b/i.test(segment)
    if (named === 0 && !rehearsal && !attributedElsewhere && segmentIsMutating(rawSegment)) unattributed = true
  }

  // An inline python/node write names its file inside a string literal we do
  // not evaluate, so it is unattributable by construction — say so rather than
  // implying the command changed nothing.
  if (pythonIsMutation(command) || NODE_INLINE_WRITE_RE.test(command)) unattributed = true

  if (paths.length === 0 || unattributed || overflowed) return [...paths, "bash-mutation"]
  return paths
}

/** Segment-level twin of `isMutatingBashCommand`'s per-segment checks, used
 * only to decide whether an un-attributed segment still owes a marker. */
function segmentIsMutating(segment: string): boolean {
  if (!DRY_RUN_RE.test(segment) && (MUTATING_BASH_RE.test(segment) || MUTATING_BASH_FLAG_RE.test(segment))) return true
  return (
    downloaderIsMutation(segment) ||
    shellRedirectTargetsWorkspace(segment) ||
    teeIsMutation(segment) ||
    pythonIsMutation(segment) ||
    NODE_INLINE_WRITE_RE.test(segment)
  )
}

/**
 * The operands of a known mutator head that name what it changes.
 *
 * Deliberately narrow. `mkdir` is absent: it names a DIRECTORY, which is not
 * a file-level change any verifier can be resolved from and which would fire
 * the scope watchdog on a path no one edited — `mkdir -p src` keeps the
 * marker. `git`, `npm`, `curl`/`wget` are absent for the same reason: what
 * they touch is not what they name.
 */
function operandTargetsForHead(head: string, args: readonly string[]): string[] {
  if (head === "tee") return collectTeeTargets(args)
  if (head === "chmod") return collectPlainOperands(head, args).slice(1) // arg 1 is the MODE
  if (head === "sed") return collectSedTargets(args)
  if (head === "perl") return collectPerlTargets(args)
  if (BASH_TARGET_ALL_OPERANDS.has(head)) return collectPlainOperands(head, args)
  if (BASH_TARGET_LAST_OPERAND.has(head)) {
    // Only the DESTINATION changes. `cp a b` -> `b`; `cp a b c dir` -> `dir`.
    const operands = collectPlainOperands(head, args)
    return operands.length > 0 ? [operands[operands.length - 1]] : []
  }
  return []
}

/** Non-flag operands, skipping options that consume the next token. */
function collectPlainOperands(head: string, args: readonly string[]): string[] {
  const valueOptions = BASH_VALUE_OPTIONS[head]
  const out: string[] = []
  let optionsOver = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!optionsOver && arg === "--") {
      optionsOver = true
      continue
    }
    if (!optionsOver && arg.startsWith("-") && arg.length > 1) {
      if (valueOptions?.has(arg)) i++
      continue
    }
    out.push(arg)
  }
  return out
}

/** `tee [-a] FILE…` — every named target is written. */
function collectTeeTargets(args: readonly string[]): string[] {
  const out: string[] = []
  let optionsOver = false
  for (const arg of args) {
    if (!optionsOver && arg === "--") {
      optionsOver = true
      continue
    }
    if (!optionsOver && arg.startsWith("-") && arg.length > 1) continue
    optionsOver = true
    out.push(arg)
  }
  return out
}

/** `sed -i[SUFFIX] [-e EXPR] SCRIPT? FILE…` — the script is not a file. */
function collectSedTargets(args: readonly string[]): string[] {
  if (!args.some((arg) => /^-[A-Za-z]*i/.test(arg) || arg === "--in-place" || arg.startsWith("--in-place="))) return []
  const valueOptions = BASH_VALUE_OPTIONS.sed
  let scriptConsumed = args.some((arg) => valueOptions.has(arg) || /^--(?:expression|file)=/.test(arg))
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg.startsWith("-") && arg.length > 1) {
      if (valueOptions.has(arg)) i++
      continue
    }
    if (!scriptConsumed) {
      scriptConsumed = true // the first bare operand is the sed program
      continue
    }
    out.push(arg)
  }
  return out
}

/** `perl -pi -e EXPR FILE…` — `-e`/`-E` swallow the program. */
function collectPerlTargets(args: readonly string[]): string[] {
  if (!args.some((arg) => /^-[A-Za-z]*i/.test(arg))) return []
  const valueOptions = BASH_VALUE_OPTIONS.perl
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg.startsWith("-") && arg.length > 1) {
      if (valueOptions.has(arg)) i++
      continue
    }
    out.push(arg)
  }
  return out
}

/**
 * Argument keys that carry a direct file path.
 *
 * WHAT THE HOST ACTUALLY DECLARES (read out of the shipped opencode binary,
 * v1.18.x, not guessed): `edit` is `Struct({filePath, oldString, newString,
 * replaceAll})`, `write` is `Struct({filePath, content})`, `read` is
 * `Struct({filePath, …})` and `apply_patch` is `Struct({patchText})`. The
 * host has no `multiedit` and no `notebookedit` tool at all, and it declares
 * no `path` key anywhere — so `filePath` is the only spelling opencode itself
 * will ever send, and the previous `filePath || file_path` pair was already
 * right FOR OPENCODE.
 *
 * The list is still widened, because opencode is not the only thing that
 * reaches this hook: `tool.execute.after` also fires for user-registered
 * plugin tools and for MCP servers, whose argument names are theirs to choose,
 * and `file_path` (Claude Code's spelling) was already here on exactly that
 * reasoning. `path`, `notebookPath` and `notebook_path` are added for the same
 * reason and cost nothing — a tool that does not send them is unaffected.
 */
const DIRECT_PATH_ARG_KEYS = ["filePath", "file_path", "path", "notebookPath", "notebook_path", "filepath"] as const

function directPathFromArgs(args: Record<string, unknown>): string {
  for (const key of DIRECT_PATH_ARG_KEYS) {
    const value = args[key]
    if (typeof value === "string" && value.trim().length > 0) return value
  }
  return ""
}

export function changedPathsFromTool(
  toolName: string,
  args: Record<string, unknown>,
  options: BashAttributionOptions = {},
): string[] {
  const normalized = toolName.toLowerCase()
  if (["edit", "write", "notebookedit", "multiedit"].includes(normalized)) {
    const directPath = directPathFromArgs(args)
    return directPath ? [directPath] : ["edit-mutation"]
  }
  if (normalized === "apply_patch" || normalized === "patch") {
    const patch = typeof args.patchText === "string"
      ? args.patchText
      : typeof args.patch === "string"
        ? args.patch
        : ""
    const paths = [...patch.matchAll(PATCH_FILE_ENVELOPE_RE)]
      .map((match) => match[1].trim())
    return paths.length > 0 ? paths : ["patch-mutation"]
  }
  if (normalized === "bash") {
    const command = typeof args.command === "string" ? args.command : ""
    return changedPathsFromBashCommand(command, options)
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
