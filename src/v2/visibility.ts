/**
 * src/v2/visibility.ts — US-15 / FR-057..FR-065: the parallel, non-intrusive
 * notification channel.
 *
 * WHY THIS EXISTS
 * ---------------
 * Everything the harness injects reaches the model through
 * `experimental.chat.system.transform`, which is *invisible to the operator*.
 * In the measured 1h34m field session the entire user-visible output was one
 * line (`[vertex] harness on ...`) while 5 directives rendered invisibly and
 * 250 were silently dropped. When the harness works, that invisibility is
 * correct — chat must not be flooded with directive bodies (an explicitly
 * rejected non-goal, `docs/REQUIREMENTS-INJECTION-VISIBILITY.md`). When the
 * harness is *broken*, invisibility is actively harmful: there was no way to
 * tell that evidence collection had been dead for 94 minutes.
 *
 * So this module adds a **second, additive channel** — `client.tui.showToast`
 * — carrying a compact summary of the same event. It is deliberately
 * *write-only towards the TUI*:
 *
 *   - It NEVER touches prompt or system text. FR-058 requires the O-D-P-E
 *     body the model receives to be byte-identical whether visibility is
 *     `"all"` or `"off"`, so this module has no access to, and returns
 *     nothing that could influence, the injected text. Composition lives in
 *     composer.ts; this file only *describes* what composer.ts already did.
 *   - It NEVER changes control flow. FR-062: a rejected, throwing, missing,
 *     or error-returning `showToast` is swallowed and logged. `notify()` is
 *     `async` but is contractually non-rejecting, which is what makes it safe
 *     to call un-awaited (fire-and-forget) from inside a hook.
 *
 * Verified against a live host before this was written: `showToast` returns
 * `{data: true}` and does **not** throw even with no TUI attached (headless).
 * The swallow logic is therefore belt-and-braces for hosts that behave worse
 * than the one we measured — never a load-bearing assumption.
 *
 * IDLE CORRECTIONS ARE NOT ROUTED HERE (FR-065): they go out via
 * `session.prompt`, which already renders as a real, user-visible message.
 * Toasting them too would double-report the same event.
 */

import { redactSecrets } from "../redaction.js"
import type { Finding } from "./composer.js"
import type { EventLogger, OpencodeClient } from "./types.js"

// ===========================================================================
// PUBLIC TYPES
// ===========================================================================

/**
 * FR-057. `"all"` toasts every harness event; `"gates"` narrows to the
 * signals an operator must not miss (gate fires and health/failure); `"off"`
 * is complete silence — no `showToast` call is ever attempted.
 */
export type VisibilityMode = "off" | "gates" | "all"

/**
 * What happened, from the operator's point of view:
 *
 *   - `"directive"` — a routine mid-turn directive was rendered into the
 *     system prompt (FR-059). High volume, low individual importance: this is
 *     the kind `"gates"` mode exists to mute.
 *   - `"gate"` — a gate fired (a tool call was blocked / a precondition
 *     refused). Low volume, high importance.
 *   - `"health"` — a harness health or failure signal: `verify:relevance-gap`,
 *     `judge:unavailable`, a verified command that minted no receipt, or a
 *     turn whose directive drop rate hit ≥90% (FR-061). This is the class of
 *     event whose invisibility cost 94 minutes in the field session.
 */
export type VisibilityEventKind = "directive" | "gate" | "health"

/** Mirrors `TuiShowToastData["body"]["variant"]` in the SDK's generated types
 * (`@opencode-ai/sdk/dist/gen/types.gen.d.ts`). Declared locally rather than
 * imported because the SDK exposes it only inline inside the request-body
 * type; the string union itself is the stable part of that contract. */
export type ToastVariant = "info" | "success" | "warning" | "error"

/**
 * One notification's payload. Everything except `message` is optional so that
 * call sites which have no `Finding` in hand (a health probe, a gate) are not
 * forced to fabricate one.
 */
export interface VisibilityInput {
  /** Directive family (`verify-gap`, `intake-scaffold`, ...). Prefixed onto
   * the toast message so the operator can tell *which* rule fired, and half
   * of the FR-063 dedupe key. */
  family?: string
  /** The human-readable summary — for a directive, its prescription (FR-059:
   * "summarising that directive's family and prescription"). */
  message: string
  /** Overrides the per-kind default (see `DEFAULT_VARIANT_BY_KIND`). */
  variant?: ToastVariant
  /** The finding's `instanceId`. Present ⇒ this event participates in FR-063
   * dedupe (`family + instanceId` never toasts twice). Absent ⇒ the event is
   * un-identifiable and is always allowed through, because suppressing it
   * could only be a guess. */
  instanceId?: string
  /** Overrides the default `[vertex] <kind>` toast title. */
  title?: string
  /**
   * FR-064: the session this event belongs to. When present, the mode filter
   * consults that session's own mode (set by `/elicify-vertex-visibility`)
   * rather than the plugin-wide default — one plugin instance serves every
   * concurrent session, so a process-global mode would let one operator
   * silence another's toasts with no way to tell why.
   *
   * Absent ⇒ the plugin-wide default applies (events with no session context).
   */
  sessionID?: string
}

export interface VisibilityNotifierOptions {
  /** The plugin's `OpencodeClient`. Optional, and tolerated even when the
   * concrete object has no `tui` at all (older hosts, test doubles, a
   * server build with the TUI routes compiled out) — see `emit()`. */
  client?: OpencodeClient
  mode: VisibilityMode
  logger: EventLogger
  /** FR-063 cap, default `DEFAULT_MAX_TOASTS_PER_MINUTE`. */
  maxToastsPerMinute?: number
  /** Clock seam. Defaults to `Date.now`. Injected so the FR-063 window is
   * exercised by advancing a number in a test rather than by sleeping — the
   * rate cap is the one piece of behaviour here that is time-dependent, and
   * real timers would make it both slow and flaky. */
  now?: () => number
}

// ===========================================================================
// CONSTANTS
// ===========================================================================

/** FR-063's default cap. Six per minute is roughly "one every ten seconds" —
 * fast enough to see a burst of activity, slow enough not to obscure the TUI.
 */
export const DEFAULT_MAX_TOASTS_PER_MINUTE = 6

/** The FR-063 window ("per minute"), in milliseconds. */
export const VISIBILITY_WINDOW_MS = 60_000

/**
 * Toast bodies are one-liners in a corner of a terminal, not log entries. A
 * prescription containing a long command would otherwise push the family name
 * (the part that identifies *what* fired) off screen. Truncation happens
 * after redaction so a secret can never be half-redacted by the cut.
 */
export const TOAST_MESSAGE_MAX_CHARS = 240

/**
 * Bound on the FR-063 dedupe memory. A session that runs for hours mints a
 * new `instanceId` per finding, so an unbounded set would grow with session
 * length for no benefit — an instance id that old will never recur. Eviction
 * is FIFO (`Set` preserves insertion order).
 */
const DEDUPE_MEMORY_LIMIT = 500

/**
 * Per-kind default variants. FR-061 requires health/failure signals to be
 * `warning` or `error`; gates are blocks, so they are `warning` too; routine
 * directives are `info`. A call site with better information (an outright
 * failure rather than a degradation) passes `variant: "error"` explicitly.
 */
const DEFAULT_VARIANT_BY_KIND: Record<VisibilityEventKind, ToastVariant> = {
  directive: "info",
  gate: "warning",
  health: "warning",
}

/** FR-060: which kinds survive which mode. */
const KINDS_BY_MODE: Record<VisibilityMode, ReadonlySet<VisibilityEventKind>> = {
  off: new Set<VisibilityEventKind>(),
  gates: new Set<VisibilityEventKind>(["gate", "health"]),
  all: new Set<VisibilityEventKind>(["directive", "gate", "health"]),
}

const VISIBILITY_MODES: readonly VisibilityMode[] = ["off", "gates", "all"]

// ===========================================================================
// MODE RESOLUTION (FR-057)
// ===========================================================================

function isVisibilityMode(value: string): value is VisibilityMode {
  return (VISIBILITY_MODES as readonly string[]).includes(value)
}

/**
 * FR-057. Precedence, highest first:
 *
 *   1. `VERTEX_VISIBLE=0` — the kill switch. It wins over *everything*,
 *      including an explicit `visibility: "all"` in plugin options, because
 *      its whole purpose is "make this stop right now" without editing
 *      config. (Same shape as the existing `VERTEX_JUDGE=0` switch in
 *      plugin.ts.)
 *   2. An explicit, valid option value.
 *   3. `"all"` — the default. Chosen deliberately: the failure this story
 *      exists to fix is *too little* signal, so opting *out* is the
 *      deliberate act, not opting in.
 *
 * An unrecognised option value degrades to the default rather than throwing —
 * a typo in a config file must not take the plugin down, and silently
 * choosing the safest visible behaviour is better than a hard failure at
 * plugin-load time.
 *
 * DECISION (spec is silent): `VERTEX_VISIBLE` is honoured *only* as the
 * documented `0` kill switch. Any other value (`1`, `gates`, `yes`) is
 * ignored, so it can never quietly *widen* visibility beyond what the
 * operator configured. Mode selection stays in one place — the option.
 */
export function resolveVisibilityMode(opt?: string, env: NodeJS.ProcessEnv = process.env): VisibilityMode {
  if ((env?.VERTEX_VISIBLE ?? "").trim() === "0") return "off"
  const candidate = (opt ?? "").trim().toLowerCase()
  if (isVisibilityMode(candidate)) return candidate
  return "all"
}

// ===========================================================================
// FINDING -> TOAST SUMMARY
// ===========================================================================

/**
 * FR-059 helper: turn a rendered `Finding` into the toast that summarises it.
 * Only the family and the prescription travel — the observation and diagnosis
 * are the model's business (they are already in the system prompt), whereas
 * the operator needs to know *which rule fired and what it asked for*.
 *
 * Kept here rather than in wiring so the "what does a directive toast say"
 * decision has exactly one home.
 */
export function summarizeFinding(finding: Finding): VisibilityInput {
  return {
    family: finding.family,
    message: finding.prescription,
    instanceId: finding.instanceId,
  }
}

// ===========================================================================
// NOTIFIER
// ===========================================================================

/** The `showToast` shape we depend on, structurally. Declared as its own type
 * so the runtime guard in `emit()` can narrow a possibly-absent `tui` without
 * `any` and without assuming the SDK class is fully constructed. */
type ToastFn = (options: {
  body: { title?: string; message: string; variant: ToastVariant; duration?: number }
}) => unknown

/** The SDK's fields-style result (`{ data, error }`). A populated `error` is a
 * *failed* toast that did not throw — logged like any other failure. */
interface FieldsStyleResult {
  error?: unknown
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === "string") return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

/**
 * A cap arriving from user config (`maxToastsPerMinute` in `opencode.json`) is
 * untrusted: `NaN`, `-1`, `1.5` or `Infinity` must not turn into a nonsensical
 * budget or an infinite loop elsewhere. Anything not a finite, non-negative
 * number degrades to the default; `0` is *kept* because "cap everything, tell
 * me only how much I missed" is a coherent (if extreme) choice.
 */
function normalizeCap(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_TOASTS_PER_MINUTE
  if (!Number.isFinite(value) || value < 0) return DEFAULT_MAX_TOASTS_PER_MINUTE
  return Math.floor(value)
}

function hasError(result: unknown): result is FieldsStyleResult {
  return typeof result === "object" && result !== null && "error" in result && Boolean((result as FieldsStyleResult).error)
}

/**
 * Emits toasts for harness events, subject to mode (FR-057/FR-060), a
 * per-minute cap with a single roll-up summary (FR-063), dedupe by
 * `family + instanceId` (FR-063), and an absolute swallow-everything
 * guarantee (FR-062).
 *
 * One instance per plugin load is expected; the cap and dedupe state are
 * per-instance (i.e. per host process), not per session — an operator watches
 * one TUI, so the budget that matters is the TUI's, not any single session's.
 */
export class VisibilityNotifier {
  private readonly client?: OpencodeClient
  private readonly logger: EventLogger
  private readonly maxToastsPerMinute: number
  private readonly now: () => number

  private currentMode: VisibilityMode

  /** Wall-clock start of the current cap window; only meaningful while
   * `windowOpen` is true. */
  private windowStart = 0
  /** Whether a cap window is currently open. Tracked separately from
   * `emittedInWindow` because a window can legitimately contain zero emitted
   * toasts (`maxToastsPerMinute: 0`, or a window whose every event was
   * suppressed) and must still close — and emit its roll-up — on time. */
  private windowOpen = false
  private emittedInWindow = 0
  /** Events dropped by the cap since the last summary was emitted. */
  private suppressedInWindow = 0
  /** Guards the one-per-window `visibility:cap-reached` log line. */
  private capLogged = false
  /** Guards the one-per-instance `visibility:unavailable` log line — a host
   * with no TUI would otherwise log once per directive, forever. */
  private unavailableLogged = false

  private readonly seen = new Set<string>()
  /** FR-064: per-session mode overrides. Absent ⇒ `currentMode` applies. */
  private readonly modeBySession = new Map<string, VisibilityMode>()

  constructor(opts: VisibilityNotifierOptions) {
    this.client = opts.client
    this.currentMode = opts.mode
    this.logger = opts.logger
    this.maxToastsPerMinute = normalizeCap(opts.maxToastsPerMinute)
    this.now = opts.now ?? Date.now
  }

  /** Current mode. */
  get mode(): VisibilityMode {
    return this.currentMode
  }

  /**
   * FR-064: the mode in force for a given session — its own override when it
   * has toggled, otherwise the plugin-wide default.
   */
  modeFor(sessionID?: string): VisibilityMode {
    if (sessionID !== undefined) {
      const override = this.modeBySession.get(sessionID)
      if (override !== undefined) return override
    }
    return this.currentMode
  }

  /**
   * FR-064 support: the `/elicify-vertex-visibility` toggle changes the mode
   * of the live notifier. Deliberately does NOT reset the cap window or the
   * dedupe memory — flipping to `"all"` mid-session must not become a way to
   * re-toast everything that was already reported.
   */
  setMode(mode: VisibilityMode, sessionID?: string): void {
    if (sessionID !== undefined) {
      this.modeBySession.set(sessionID, mode)
      return
    }
    this.currentMode = mode
  }

  /**
   * A user-initiated control acknowledgement — the reply to someone pressing
   * `/elicify-vertex-visibility`.
   *
   * Deliberately BYPASSES the mode filter, unlike `notify`. Routing it through
   * the filter produced a real defect: toggling `all -> off` set the mode to
   * `off` and the confirmation was then suppressed by the mode it had just
   * set, so the very first press of the toggle silently did nothing visible.
   * A direct answer to an explicit user action is not a harness-initiated
   * signal and must not be silenced by the setting that action just changed.
   *
   * Still rate-capped and deduped, and still fail-safe (FR-062).
   */
  async notifyControl(input: VisibilityInput): Promise<void> {
    await this.deliver("gate", input, { bypassModeFilter: true })
  }

  /**
   * Report one harness event.
   *
   * Contract: **never throws, never rejects, never blocks caller behaviour**
   * (FR-062). Every failure path — no client, no `tui`, a throwing or
   * rejecting `showToast`, an error-carrying result, even a throwing logger —
   * ends in a swallowed log line. Awaiting it is optional.
   *
   * Order of the gates is deliberate:
   *   1. **mode** — in `"off"` no work happens at all, and no clock is read,
   *      so a disabled notifier is genuinely inert.
   *   2. **window roll** — a stale window is closed (and its roll-up summary
   *      emitted) before this event is judged, so an event arriving after a
   *      quiet minute is measured against a fresh budget.
   *   3. **dedupe** — a duplicate is not an event at all; it must not consume
   *      cap budget nor inflate the suppressed count.
   *   4. **cap** — last, so the budget is spent only on events that would
   *      genuinely have been shown.
   */
  async notify(kind: VisibilityEventKind, input: VisibilityInput): Promise<void> {
    await this.deliver(kind, input, { bypassModeFilter: false })
  }

  private async deliver(
    kind: VisibilityEventKind,
    input: VisibilityInput,
    opts: { bypassModeFilter: boolean },
  ): Promise<void> {
    try {
      if (!opts.bypassModeFilter && !KINDS_BY_MODE[this.modeFor(input.sessionID)].has(kind)) return

      await this.rollWindow()

      const key = dedupeKey(input)
      if (key !== null && this.seen.has(key)) {
        this.safeLog("visibility:deduped", { kind, family: input.family ?? null, instanceId: input.instanceId ?? null })
        return
      }

      // The window is anchored at the first *eligible event*, not at the first
      // emitted toast, so a window in which everything was suppressed still
      // closes 60s later and reports its roll-up. (A deduped event, rejected
      // above, deliberately does not open a window: it is not an event.)
      if (!this.windowOpen) {
        this.windowOpen = true
        this.windowStart = this.now()
      }

      if (this.emittedInWindow >= this.maxToastsPerMinute) {
        this.suppressedInWindow += 1
        if (!this.capLogged) {
          this.capLogged = true
          this.safeLog("visibility:cap-reached", {
            maxToastsPerMinute: this.maxToastsPerMinute,
            windowMs: VISIBILITY_WINDOW_MS,
          })
        }
        return
      }

      // Only a genuinely emitted toast is remembered for dedupe: an event the
      // cap swallowed was never *shown*, so it stays eligible next window.
      if (key !== null) this.remember(key)
      this.emittedInWindow += 1

      await this.emit(kind, {
        title: input.title ?? `[vertex] ${kind}`,
        message: composeMessage(input.family, input.message),
        variant: input.variant ?? DEFAULT_VARIANT_BY_KIND[kind],
      })
    } catch (err) {
      // Defence in depth: nothing above is *expected* to throw (the emit path
      // has its own catch), but FR-062 is absolute — a bug in this module must
      // not be able to change harness behaviour.
      this.safeLog("visibility:notify-failed", { kind, reason: describeError(err) })
    }
  }

  /**
   * Emit the pending FR-063 roll-up now, if any, and clear the counter.
   *
   * WHY THIS IS PUBLIC: the summary is deliberately *deferred* — it reports
   * "N notifications suppressed", and N is not known until the window closes.
   * Emitting eagerly at the moment the cap is hit would necessarily report
   * "1 suppressed" and then either lie or emit a second summary, both of
   * which FR-063 forbids ("a single summary toast MUST report the suppressed
   * count"). So the roll-up lands at window close — which happens on the next
   * `notify()` after the window elapses, or immediately when wiring calls
   * `flush()` (e.g. at session idle / stop, so a burst at the very end of a
   * run is still reported rather than dying with the process).
   *
   * Same swallow contract as `notify()`: never throws.
   */
  async flush(): Promise<void> {
    try {
      // The mode gate applies here too. `emitSummary` calls `emit` directly
      // rather than going through `notify`, so without this check a window
      // that filled while the mode was "all" would still fire its roll-up
      // after the operator had switched to "off" — a toast arriving *after*
      // silence was requested. `"off"` is documented as complete silence, and
      // that has to hold for every path, not just the common one.
      //
      // The pending count is dropped rather than deferred: the operator asked
      // not to be told, so telling them later is the same defect with a delay.
      if (this.currentMode === "off") {
        this.suppressedInWindow = 0
        this.windowOpen = false
        return
      }
      await this.emitSummary()
    } catch (err) {
      this.safeLog("visibility:notify-failed", { kind: "summary", reason: describeError(err) })
    }
  }

  // -----------------------------------------------------------------------
  // internals
  // -----------------------------------------------------------------------

  /**
   * Close the cap window if `VISIBILITY_WINDOW_MS` has elapsed since its first
   * toast, emitting the roll-up summary for whatever it suppressed.
   *
   * DECISION (the spec says "per minute" and "for the remainder of the
   * window", which are tumbling-window wording, while the module brief says
   * "rolling"): this is a **tumbling window anchored at the first toast of the
   * window**, not a sliding count of the last 60s. That is what makes
   * "suppress further toasts for the remainder of the window" literally true
   * and gives the operator a stable, explainable rule ("at most 6 per minute,
   * then one line telling you what you missed"). A sliding window would drip
   * single toasts back in as individual timestamps aged out, which reads as
   * random flapping in a TUI and makes the roll-up count meaningless.
   */
  private async rollWindow(): Promise<void> {
    if (!this.windowOpen) return
    if (this.now() - this.windowStart < VISIBILITY_WINDOW_MS) return
    await this.emitSummary()
    this.windowOpen = false
    this.emittedInWindow = 0
    this.capLogged = false
  }

  private async emitSummary(): Promise<void> {
    const suppressed = this.suppressedInWindow
    if (suppressed <= 0) return
    // Reset before emitting: `emit()` cannot throw, but if it ever did, a
    // stale count must not be reported twice.
    this.suppressedInWindow = 0
    this.safeLog("visibility:suppressed-summary", { suppressed, maxToastsPerMinute: this.maxToastsPerMinute })
    // Exempt from the cap and from the window counters by design: it is the
    // meta-notification that explains the cap, and there is at most one per
    // window, so it cannot itself become spam.
    await this.emit("health", {
      title: "[vertex] visibility",
      message: `${suppressed} harness notification${suppressed === 1 ? "" : "s"} suppressed (cap ${this.maxToastsPerMinute}/min)`,
      variant: "info",
    })
  }

  /**
   * The single place `client.tui.showToast` is called — and the single place
   * FR-062's swallow is implemented.
   *
   * The `tui` lookup is structural rather than typed-through, because the
   * declared `OpencodeClient` type guarantees `tui` exists while a real
   * object may not (an older host, a partial test double, a client that
   * failed to construct). Trusting the type here would turn a missing route
   * into a `TypeError` inside a hook.
   */
  private async emit(
    kind: VisibilityEventKind,
    body: { title: string; message: string; variant: ToastVariant },
  ): Promise<void> {
    const tui = (this.client as unknown as { tui?: { showToast?: ToastFn } } | undefined)?.tui
    const showToast = tui?.showToast
    if (typeof showToast !== "function") {
      if (!this.unavailableLogged) {
        this.unavailableLogged = true
        this.safeLog("visibility:unavailable", { reason: "client.tui.showToast is not available" })
      }
      return
    }
    try {
      const result = await showToast.call(tui, { body })
      if (hasError(result)) {
        this.safeLog("visibility:toast-failed", { kind, reason: describeError(result.error) })
      }
    } catch (err) {
      this.safeLog("visibility:toast-failed", { kind, reason: describeError(err) })
    }
  }

  private remember(key: string): void {
    this.seen.add(key)
    while (this.seen.size > DEDUPE_MEMORY_LIMIT) {
      const oldest = this.seen.values().next()
      if (oldest.done) break
      this.seen.delete(oldest.value)
    }
  }

  /** Even the logger is untrusted: a sink that throws must not turn an
   * observability nicety into a harness failure. */
  private safeLog(eventType: string, payload: Record<string, unknown>): void {
    try {
      this.logger(eventType, payload)
    } catch {
      /* deliberately empty — FR-062 */
    }
  }
}

// ===========================================================================
// PURE HELPERS
// ===========================================================================

/**
 * `family: message`, redacted then truncated.
 *
 * Redaction runs even though the toast is local-only: toast text is derived
 * from observations and prescriptions (real paths, real commands), and the
 * same FR-007 rule that keeps secrets out of the injected text applies to any
 * other rendering of it. A leaked token on screen is a leaked token.
 */
function composeMessage(family: string | undefined, message: string): string {
  const raw = family ? `${family}: ${message}` : message
  const redacted = redactSecrets(raw)
  if (redacted.length <= TOAST_MESSAGE_MAX_CHARS) return redacted
  return `${redacted.slice(0, TOAST_MESSAGE_MAX_CHARS - 1)}…`
}

/** FR-063 dedupe key, or `null` when the event carries no `instanceId` and is
 * therefore not identifiable (see `VisibilityInput.instanceId`). The separator
 * is NUL rather than a printable character because a family name may itself
 * contain punctuation (`repeat-failure:<signature>`, see composer.ts) — with
 * `:` as the separator, `("a", "b:c")` and `("a:b", "c")` would collide and one
 * real event would be silently swallowed as a duplicate. */
function dedupeKey(input: VisibilityInput): string | null {
  if (!input.instanceId) return null
  // sessionID is part of the key. `nextInstanceId` counts PER SESSION and
  // restarts at `D-1`, while `seen` is per plugin instance — one process
  // serves every session in a directory. Without the session in the key, a
  // second session's very first directives collide with the first session's
  // and are silently swallowed, which a review proved end to end.
  return `${input.sessionID ?? ""}\u0000${input.family ?? ""}\u0000${input.instanceId}`
}
