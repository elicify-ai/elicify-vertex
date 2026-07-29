/** Redaction is applied at every disk-write boundary so secrets never land
 * on disk in the evidence ledger or measurement events.
 */

const SENSITIVE_LABEL = "(?:api[_-]?key|x-api-key|account[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|authorization|cookie|set-cookie|client[_-]?secret|secret[_-]?access[_-]?key|private[_-]?key|database[_-]?url|db[_-]?url|connection[_-]?string|dsn|credential)"
const SENSITIVE_ASSIGNMENT_LABEL = `[A-Za-z0-9_-]*${SENSITIVE_LABEL}[A-Za-z0-9_-]*`
const SENSITIVE_KEY_RE = new RegExp(SENSITIVE_LABEL, "i")

const SECRET_PATTERNS: readonly { pattern: RegExp; replacement: string }[] = [
  { pattern: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, replacement: "$1[REDACTED]" },
  { pattern: /\b(Basic\s+)[A-Za-z0-9+/=]{8,}/gi, replacement: "$1[REDACTED]" },
  {
    pattern: /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/g,
    replacement: "[REDACTED:PRIVATE_KEY]",
  },
  // C-8 fix (docs/CODE-ISSUES-FROM-PROMPT-AUDIT.md): both of these entries used
  // to accept a bare run of whitespace (`|\s+`) as the "assignment" between a
  // sensitive-sounding label and its value, so ordinary prose like "no secrets
  // leaked into the log output" or "the token refresh logic is fixed" — a
  // label word followed by an unrelated sentence, not a key=value pair — was
  // swallowed whole up to the next comma/semicolon/newline. Requiring an
  // actual `[:=]` separator (verified against every case in
  // tests/riskRedaction.test.ts's `redactSecrets` it.each block: each one
  // already contains `:`/`=`, or is caught by a wholly separate dedicated
  // pattern below — gh[pousr]_/npm_/glpat-/xoxb-/sk-/AKIA/JWT/private-key/
  // Bearer/Basic/URL-credential — independent of this label pattern)
  // eliminates the false positive without narrowing real `label: value` /
  // `label=value` leaks. An unlabeled secret with no `:`/`=` nearby (e.g. "the
  // password is hunter2...") is still covered by `judge.ts`'s separate
  // high-entropy scan (`tripsEntropyScan`), which does not depend on this
  // pattern matching at all.
  {
    pattern: new RegExp(`\\b(${SENSITIVE_ASSIGNMENT_LABEL})(\\s*[:=]\\s*)(["'])[^\\r\\n]*?\\3`, "gi"),
    replacement: "$1$2[REDACTED]",
  },
  {
    pattern: new RegExp(`\\b(${SENSITIVE_ASSIGNMENT_LABEL})(\\s*[:=]\\s*)[^\\r\\n,;]+`, "gi"),
    replacement: "$1$2[REDACTED]",
  },
  {
    pattern: /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|glpat-[A-Za-z0-9_-]{12,}|xox[baprs]-[A-Za-z0-9-]{12,}|npm_[A-Za-z0-9_-]{12,}|AKIA[0-9A-Z]{16})\b/g,
    replacement: "[REDACTED]",
  },
  {
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replacement: "[REDACTED:JWT]",
  },
  {
    pattern: /\b((?:https?|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss|amqp|amqps):\/\/)[^\s/:@]+:[^\s/@]+@/gi,
    replacement: "$1[REDACTED]@",
  },
]

export function redactSecrets(value: string): string {
  let redacted = value
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, replacement)
  }
  return redacted
}

function redactValue(value: unknown, key: string | null, seen: WeakSet<object>): unknown {
  if (typeof value === "string") {
    return key && SENSITIVE_KEY_RE.test(key) ? "[REDACTED]" : redactSecrets(value)
  }
  if (value === null || typeof value !== "object") return value
  if (seen.has(value)) return "[REDACTED:CIRCULAR]"
  seen.add(value)
  if (Array.isArray(value)) return value.map((item) => redactValue(item, null, seen))

  const output: Record<string, unknown> = {}
  for (const [childKey, childValue] of Object.entries(value)) {
    output[childKey] = redactValue(childValue, childKey, seen)
  }
  return output
}

/** Return a recursively sanitized copy suitable for JSON serialization. */
export function redactForDisk<T>(value: T): T {
  return redactValue(value, null, new WeakSet()) as T
}
