/**
 * elicify-vertex v2 — phase-aware guidance harness plugin entry.
 * --------------------------------------------------------------------------
 * Wires the `src/v2/*` modules (phase.ts, pin.ts, story.ts, composer.ts,
 * resolve.ts, artifacts.ts, subturn.ts, verifier.ts) plus the
 * `src/v2/wiring/*` support modules into the OpenCode `Hooks` surface, per
 * `docs/vertex2-spec.md`'s "Relevant Execution Flows" table and Functional
 * Requirements.
 *
 * `src/index.ts` is the SHARED PRIMITIVES library, not a frozen v1 artefact.
 * This comment claimed it was "FROZEN — never edited, never reimplemented"
 * long after that stopped being true: the v1 plugin was deleted, and the file
 * has taken nine v2-era commits since (mutation-detection widening, stop-mode
 * collapse, the mutation timestamp the verdict-staleness fix reads, and most
 * recently `recordVerification`'s `coversPrescribed` bit for BACKLOG R-4). A
 * header asserting a constraint nobody is honouring is worse than no header:
 * the next person either believes it and works around a file they were free to
 * edit, or notices it is false and trusts nothing else here.
 *
 * What is still true: it is imported for primitives shared with the v2 tree
 * (`EvidenceLedger`/`shouldBlockStop`, `parseVerification`,
 * `changedPathsFromTool` — which routes `isMutatingBashCommand`,
 * `formatChangedPathsForReason`, `formatGateContinuationText`,
 * `formatActivateCue`, `classifyStopMode`, `failureSignature`). Edit it when
 * the shared behaviour must change; do not fork a second copy into `src/v2/`.
 *
 * FR-036 (self-created-session inertness) is enforced at the top of EVERY
 * hook via `selfCreated.isSelfCreated(sessionID, selfCreatedGuard.resolveParent)`.
 */
import { resolve as resolvePath } from "node:path"
import { randomUUID } from "node:crypto"

import type { Hooks, PluginInput, PluginOptions } from "@opencode-ai/plugin"

import {
  EvidenceLedger,
  changedPathsFromTool,
  classifyStopMode,
  failureSignature,
  formatActivateCue,
  parseVerification,
} from "../index.js"
import { PLUGIN_STATE_DIR, VerificationReceiptStore, isProtectedStatePath, resolveGoalWorkspaceRoot } from "../goals.js"
import { holdoutSuppresses, logHoldoutSuppress } from "../measurement.js"

import { compareExpectation, findCriteriaKeyLine, parseCriteriaBlock, parseExpectArtifact } from "./artifacts.js"
import { computeBoundedDiffStat, formatChangedPathsSummary, NON_PATH_MUTATION_MARKERS } from "./diffstat.js"
import { isNonExecutingCommand, isTestRunnerCommand, observedCoversPrescribed, verifyGapComplied } from "./coverage.js"
import { VisibilityNotifier, resolveVisibilityMode, summarizeFinding } from "./visibility.js"
import { InjectionComposer, type Finding } from "./composer.js"
import { PhaseEngine } from "./phase.js"
import { PinStore } from "./pin.js"
import { resolveVerifier } from "./resolve.js"
import { classifyMultiStory, StoryEngine, type StoryV2 } from "./story.js"
import { SelfCreatedSessions } from "./subturn.js"
import type { OpencodeClient } from "./types.js"

import { applyV2Config } from "./wiring/config.js"
import { cancelPauseJudge, forgetIdleTurn, GateContext, handleSessionIdle } from "./wiring/gate.js"
import {
  anomalyInterruptFinding,
  elevateFinding,
  intakeScaffoldFinding,
  pinnedCriteriaReinjectFinding,
  planProposalFinding,
  precommitmentFinding,
  scopeWatchdogFinding,
  storyCompletionFinding,
  verifyGapFinding,
} from "./wiring/findings.js"
import { bindSession, createSharedV2Logger } from "./wiring/logger.js"
import { ManifestCache } from "./wiring/manifest.js"
import {
  SelfCreatedGuard,
  freshSessionState,
  nextInstanceId,
  resetTurnState,
  type V2SessionState,
} from "./wiring/state.js"
import { injectSubagentPreamble } from "./wiring/subagentInjection.js"
import { buildPlanTools, recordStarAskIfOurs } from "./wiring/tools.js"
import { DelegationTracker } from "./wiring/watchdog.js"

export interface ElicifyVertexV2Options {
  readonly activeAgent?: string
  readonly activeSkillTrigger?: string
  readonly maxCriteriaBlocks?: number
  readonly intakeSubturnMax?: number
  // BACKLOG B-1: `verifierModel` and `dosingOverrides` were removed, not
  // deprecated. Both are IGNORED SILENTLY if still present in `opencode.json`
  // — see this file's option-handling note below for why that is the chosen
  // behaviour rather than a warning.
  readonly familyCaps?: Record<string, number>
  readonly cooldowns?: Record<string, number>
  /** FR-057: `"off" | "gates" | "all"`, default `"all"`. `VERTEX_VISIBLE=0` forces `"off"`. */
  readonly visibility?: string
  /** FR-063 toast rate cap per minute (default 6). */
  readonly maxToastsPerMinute?: number
  /** Redesign point 9: pause idle-gate auto-continuations after this many
   * consecutive continuations produced no observable tool activity
   * (default 3; <= 0 disables). `VERTEX_MAX_NO_PROGRESS_TURNS` overrides. */
  readonly maxNoProgressTurns?: number
  /** FR-007: cap consecutive verifier reverts per story, then escalate to the
   * operator instead of reverting again (default 3; <= 0 disables).
   * `VERTEX_MAX_STORY_REAUDITS` overrides. Evidence: the audited session ran
   * 9 audit cycles / 82 checkpoints over 10 tasks with no exit; one story was
   * reverted 7 consecutive times. */
  readonly maxStoryReaudits?: number
  /** Consumed by `src/plugin.ts`'s kill switch; harmless if also present here. */
  readonly engine?: string
}

/** Tools that unambiguously WRITE a file named by an argument. Read/search
 * tools are excluded on purpose: blocking those broke `cat`, `grep` and `git
 * commit` over this repo's own source without protecting anything, since the
 * signature — not this list — is what makes a forged receipt inert. */
const WRITE_TOOL_NAMES = new Set(["write", "edit", "patch", "multiedit", "notebookedit"])

/** Every spelling of "the file I am about to write" observed across opencode's
 * own tools and MCP servers. `changedPathsFromTool` (src/index.ts) already had
 * to handle `file_path` as well as `filePath`; the first version of this guard
 * checked only three of these. */
const WRITE_TOOL_PATH_KEYS = ["filePath", "file_path", "path", "file", "notebookPath", "destination"]

function parseModelRef(id: string | null): { providerID: string; modelID: string } | null {
  if (!id) return null
  const slash = id.indexOf("/")
  if (slash <= 0 || slash === id.length - 1) return null
  return { providerID: id.slice(0, slash), modelID: id.slice(slash + 1) }
}

function classifyFailureClass(output: string, success: boolean): string | null {
  if (success) return null
  const lower = (output || "").toLowerCase()
  if (/typeerror|type error|\bts\d{4}\b/.test(lower)) return "type-error"
  if (/timeout|timed out/.test(lower)) return "timeout"
  if (/assertionerror|\bassert(ion)?\b|expect\(/.test(lower)) return "assertion"
  return "unknown"
}

function firstLine(text: string): string {
  return text.split("\n").find((l) => l.trim()) ?? ""
}

/**
 * FIX #1 (review CRITICAL — "verifier subsystem is unreachable"): `getActiveStory`
 * returns `null` once the plan's final story is checkpointed `"complete"` —
 * nothing is "active" anymore. Every `tool.execute.after` call site that fed
 * `phaseEngine.onMutation`/`onVerifierOutcome` a bare
 * `storyEngine.getActiveStory(sid)?.id ?? null` therefore silently rekeyed
 * post-completion phase transitions under an untracked `null` story slot
 * instead of the completed final story's own slot. Falling back to
 * `getPlan(sid)?.finalStoryId` once no story is active keeps phase tracking
 * pointed at the right slot for the rest of the session's life, matching the
 * gate.ts sibling fix applied to `handleSessionIdle`'s equivalent call site.
 */
function resolveStoryIdForPhase(storyEngine: StoryEngine, sessionID: string): string | null {
  return storyEngine.getActiveStory(sessionID)?.id ?? storyEngine.getPlan(sessionID)?.finalStoryId ?? null
}

/**
 * CR-15: pick the first DEFINED value, not the first truthy one. `0` is a
 * meaningful setting for several of these knobs (it disables the FR-007
 * re-audit cap), and a `||` chain silently replaced it with the default.
 */
function firstDefinedNumber(...values: Array<number | undefined>): number {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value
  }
  return 0
}

/**
 * FIX #5 (review MAJOR — "SelfCreatedGuard is never populated"): `runSubturn`
 * (`subturn.ts`) already calls `SelfCreatedSessions.record(childID,
 * parentID)` on the SAME shared instance this plugin passes to both
 * `classifyMultiStory` (intake) and, via `GateContext.selfCreated`,
 * `runVerifier` (verifier, `wiring/gate.ts`) — but neither `subturn.ts` nor
 * `story.ts`/`verifier.ts` ever surfaces the created child session id back to
 * the caller (`ClassifyResult`/`SubturnResult` carry no session id field,
 * and `runSubturn`'s own `finally` block has already deleted the child
 * session by the time its promise resolves), so there is no id available at
 * any call site AFTER a subturn call returns to forward into
 * `SelfCreatedGuard.record` — attempting one would mean guessing an id we
 * were never given. Subclassing `SelfCreatedSessions` and mirroring its own
 * `record()` call into the guard is the one seam available without editing
 * subturn.ts/story.ts/verifier.ts (none owned by this fix): it captures the
 * REAL child/parent ids at the exact moment `runSubturn` records them,
 * exactly matching `wiring/state.ts`'s own doc comment for `SelfCreatedGuard`
 * ("populated at the moment wiring records a subturn"). Because `plugin.ts`
 * constructs ONE `selfCreated` instance shared by both the intake subturn
 * (this file) and the verifier subturn (`wiring/gate.ts`, sibling-owned), this
 * also happens to close the equivalent gap at the verifier call site as a
 * side effect — see the final report.
 */
class TrackingSelfCreatedSessions extends SelfCreatedSessions {
  constructor(private readonly guard: SelfCreatedGuard) {
    super()
  }

  override record(sessionID: string, parentID: string | null): void {
    super.record(sessionID, parentID)
    this.guard.record(sessionID, parentID)
  }
}

export const ElicifyVertexPluginV2 = async (input: PluginInput, options?: PluginOptions): Promise<Hooks> => {
  const client = input.client as unknown as OpencodeClient
  // BACKLOG B-1 — why removed options are ignored SILENTLY, with no
  // deprecation warning. `options` has never been validated: it is cast, and
  // every unrecognised key (a typo, a stale key, a key meant for another
  // plugin) has always been dropped without a word. A warning for exactly two
  // dead keys would be the only such check in the surface. It would also have
  // to fire from plugin CONSTRUCTION, before any session activates — which is
  // precisely the write that UAT G1 and the "a non-activated session writes
  // nothing" test exist to forbid: a user with a leftover `verifierModel` in
  // `opencode.json` would get a `.vertex-events.jsonl` line for every session
  // they open, activated or not. And the removal is not a loss of function
  // the user needs to route around: the operator's rule is that the judge
  // runs on the worker's model, so the only correct response to the option
  // would be to ignore it anyway.
  const userOpts = (options ?? {}) as ElicifyVertexV2Options

  const opts = {
    activeAgent: userOpts.activeAgent ?? "elicify-vertex-agent",
    activeSkillTrigger: userOpts.activeSkillTrigger ?? "/elicify-vertex",
    maxCriteriaBlocks: userOpts.maxCriteriaBlocks ?? 3,
    intakeSubturnMax: Number(process.env.VERTEX_INTAKE_SUBTURN_MAX) || userOpts.intakeSubturnMax || 3,
    familyCaps: userOpts.familyCaps,
    cooldowns: userOpts.cooldowns,
    visibility: userOpts.visibility,
    maxToastsPerMinute: userOpts.maxToastsPerMinute,
    maxNoProgressTurns: Number(process.env.VERTEX_MAX_NO_PROGRESS_TURNS) || userOpts.maxNoProgressTurns || 3,
    // CR-15 (round 5): `0` is the DOCUMENTED way to disable the FR-007 cap
    // (`<=0` disables — see `GateContext.maxStoryReaudits`), and `||` swallowed
    // it, so the cap always applied. Coalesce on definedness, not truthiness.
    maxStoryReaudits: firstDefinedNumber(
      Number.isFinite(Number(process.env.VERTEX_MAX_STORY_REAUDITS))
        ? Number(process.env.VERTEX_MAX_STORY_REAUDITS)
        : undefined,
      userOpts.maxStoryReaudits,
      3,
    ),
  }
  const activateCommandName = opts.activeSkillTrigger.replace(/^\//, "")

  // -- Shared long-lived components -----------------------------------------
  const states = new Map<string, V2SessionState>()
  const getContext = (sessionID: string | undefined) => {
    const state = sessionID ? states.get(sessionID) : undefined
    return { model: state?.modelId ?? null }
  }
  const logger = createSharedV2Logger(getContext)

  // C-3 (docs/CODE-ISSUES-FROM-PROMPT-AUDIT.md): v1's GoalStore constructor
  // checked writability and threw (src/goals.ts:1133) when it found no
  // writable project root; v2 catches that same throw here and falls back to
  // process.cwd() SILENTLY. Deliberately NOT restoring the hard throw --
  // crashing plugin init on an unwritable root has a much bigger blast
  // radius than writing harness state to process.cwd() would, so the
  // fallback stays. What v2 actually dropped was observability: log the
  // fallback so a session that lands on the wrong directory is at least
  // visible instead of silently invisible. No sessionID is attached -- this
  // runs once at plugin construction, before any session exists.
  const workspaceRoot = (() => {
    const candidates = [input.worktree, input.directory, process.cwd()]
    try {
      return resolveGoalWorkspaceRoot(candidates)
    } catch (err) {
      const fallback = process.cwd()
      logger("workspace:unwritable-fallback", {
        candidates,
        fallback,
        error: err instanceof Error ? err.message : String(err),
      })
      return fallback
    }
  })()
  const stateDir = `${workspaceRoot}/${PLUGIN_STATE_DIR}`

  const phaseEngine = new PhaseEngine(logger)
  const pinStore = new PinStore({ stateDir, logger })
  const storyEngine = new StoryEngine({ stateDir, logger })
  const composer = new InjectionComposer({ logger, familyCaps: opts.familyCaps, cooldowns: opts.cooldowns })
  /**
   * US-15: the user-facing half of every injection. The model keeps receiving
   * the full O-D-P-E body through `system.transform` unchanged (FR-058) — this
   * only mirrors a one-line summary to the TUI, and every call is fail-safe
   * (FR-062), so visibility can never alter harness behaviour.
   */
  const visibility = new VisibilityNotifier({
    client,
    mode: resolveVisibilityMode(opts.visibility),
    logger,
    maxToastsPerMinute: opts.maxToastsPerMinute,
  })
  const evidenceLedger = new EvidenceLedger()
  // Every other subsystem is constructed with { logger }; this one was not, so
  // `receipts:stale-dropped`, `receipts:disk-corrupt`, `receipts:disk-unavailable`
  // and `receipts:scope-unverifiable` all went to a no-op sink. The one
  // subsystem that MINTS the evidence artifact had no telemetry at all, which
  // made a disk failure or a silently-disabled staleness layer indistinguishable
  // from healthy operation.
  const verificationReceipts = new VerificationReceiptStore({ logger })
  // FIX #5: selfCreatedGuard must exist before the tracking wrapper below —
  // see TrackingSelfCreatedSessions's doc comment.
  const selfCreatedGuard = new SelfCreatedGuard()
  const selfCreated = new TrackingSelfCreatedSessions(selfCreatedGuard)
  const manifests = new ManifestCache()
  // Redesign point 9: `task`-tool delegations in flight per session, so the
  // idle gate can defer nudging a parent that is legitimately waiting on a
  // subagent (see wiring/watchdog.ts).
  const delegationTracker = new DelegationTracker()
  const commandActivatedSessions = new Set<string>()
  // FIX #7: most recent verifier command's real output text per session
  // (bounded), for the verifier payload's verifierSummaries — not part of
  // V2SessionState (wiring/state.ts is not owned by this fix), kept here
  // instead as plugin-local per-session bookkeeping (same pattern as
  // commandActivatedSessions above).
  const lastVerifierOutputBySession = new Map<string, string>()
  // FIX #8: pending "story completion" nudge — set when an intermediate
  // (non-final) story's bound verifier goes green, cleared once rendered or
  // at the next chat.message turn boundary. Also not part of V2SessionState
  // for the same reason.
  const storyCompletionPending = new Map<string, StoryV2>()
  // C-14 (docs/CODE-ISSUES-FROM-PROMPT-AUDIT.md): the `agent` field that
  // actually activated each session -- undefined when activation came from
  // trigger text/command with no agent, or the literal agent value when it
  // came via `activatedByAgent`/trigger/command WITH an agent attached (e.g.
  // "build"). Needed so `chat.message`'s deactivation branch can tell "the
  // session's own established agent said hi again" (not a deactivation
  // signal) apart from "the user switched to a genuinely different agent"
  // (a real deactivation signal) -- see that branch below for the full
  // mechanism this fixes. Same plugin-local-map pattern as
  // commandActivatedSessions/lastVerifierOutputBySession above; not part of
  // V2SessionState for the same reason (wiring/state.ts not owned here).
  const activatedAgentBySession = new Map<string, string | undefined>()

  const isSelf = (sessionID: string | undefined): boolean =>
    !!sessionID && selfCreated.isSelfCreated(sessionID, selfCreatedGuard.resolveParent)

  function getOrCreateState(sessionID: string): V2SessionState {
    let state = states.get(sessionID)
    if (!state) {
      state = freshSessionState(workspaceRoot)
      states.set(sessionID, state)
      pinStore.load(sessionID)
      // Hydrate persisted receipts at the same moment as pins, and for the
      // same reason. Without this the store has no workspace root for the
      // session, so `gateCtx.isValidReceipt` -> `verificationReceipts.get()`
      // never hydrates from disk: after a restart, criteria evidence pointing
      // at a perfectly valid persisted receipt reads as UNEVIDENCED and the
      // gate re-demands proof the user already produced. That is the "come
      // back tomorrow" complaint persistence exists to fix, so leaving it out
      // would make the feature inert on the one path that motivated it.
      // Staleness is still enforced inside `get()`, which re-fingerprints the
      // worktree on every lookup -- hydrating cannot resurrect a stale receipt.
      verificationReceipts.load(sessionID, state.workspaceRoot)
    }
    return state
  }

  const gateCtx: GateContext = {
    client,
    logger,
    phaseEngine,
    pinStore,
    storyEngine,
    evidenceLedger,
    selfCreated,
    manifests,
    states,
    activeSessionIDs: () => [...states.entries()].filter(([, s]) => s.active).map(([id]) => id),
    maxCriteriaBlocks: opts.maxCriteriaBlocks,
    // FR-030 was opt-in (VERTEX_VERIFIER=1); flipped to opt-out per operator
    // request — the verifier now runs by default at every final-story
    // checkpoint, disabled only by explicit VERTEX_VERIFIER=0. It remains
    // strictly advisory/non-gating (FR-030) and fails open via the FR-030b
    // capability probe regardless of this flag.
    verifierEnabled: process.env.VERTEX_VERIFIER !== "0",
    isValidReceipt: (sessionID, receiptID) => {
      // Unlike `isFreshReceipt` (wiring/tools.ts) this had NO workspace check, so
      // a receipt naming a different `workspaceRoot` was accepted -- and stayed
      // accepted permanently, because staleness re-fingerprints the root named
      // ON THE RECEIPT. A receipt pointing at a frozen directory could never go
      // stale no matter what happened to the real workspace.
      const receipt = verificationReceipts.get(sessionID, receiptID)
      if (!receipt) return false
      const sessionRoot = states.get(sessionID)?.workspaceRoot
      if (sessionRoot && resolvePath(receipt.workspaceRoot) !== resolvePath(sessionRoot)) return false
      return true
    },
    // FIX #7: prefer the most recent verifier command's real output text
    // (captured in tool.execute.after) over the terse ledger summary string
    // ("verified: 1 · failed: 0") — the ledger summary is still the
    // fallback when no verifier has run yet this process.
    recentVerifierSummaries: (sessionID) => {
      const recentOutput = lastVerifierOutputBySession.get(sessionID)
      if (recentOutput && recentOutput.trim()) return [recentOutput]
      const l = evidenceLedger.summary(sessionID)
      return l ? [l] : []
    },
    // FIX #7: a bounded `git diff --stat` for the changed paths, falling
    // back to the recorded path list when git is unavailable, the worktree
    // isn't a repo, or the diff is empty.
    //
    // B-3: the fallback now carries the REASON the diff is missing
    // (`unavailableReason`) instead of being indistinguishable from a real
    // diff, and the list itself is workspace-relative and one-path-per-line
    // so the payload's own secret scan stops eating it — see
    // `diffstat.ts`'s header for the measured failure both properties fix.
    diffSummary: (sessionID) => {
      const state = states.get(sessionID)
      const cwd = state?.workspaceRoot ?? workspaceRoot
      const changedPaths = evidenceLedger.getChangedPaths(sessionID)
      const stat = computeBoundedDiffStat(cwd, changedPaths)
      if (stat.text.length > 0) return stat
      return { text: formatChangedPathsSummary(changedPaths, cwd), unavailableReason: stat.unavailableReason }
    },
    composer,
    visibility,
    delegation: delegationTracker,
    maxNoProgressTurns: opts.maxNoProgressTurns,
    maxStoryReaudits: opts.maxStoryReaudits,
  }

  const planTools = buildPlanTools({
    storyEngine,
    pinStore,
    client,
    states,
    phaseEngine,
    onPlanCreated: (sessionID) => {
      const state = states.get(sessionID)
      if (!state) return
      state.multiStoryPending = false
      // Confirming the plan IS the plan-proposal prescription's compliance —
      // it drives the composer's own per-turn decay to the one-line form.
      composer.recordCompliance(sessionID, "plan-proposal", "plan-created")
    },
    // B-2: the ONLY `scope-watchdog` compliance signal in the codebase.
    // Before this, the family had no `recordCompliance` call anywhere, so its
    // measured "3 rendered, 0 complied" was a structural artefact — it would
    // have read 0 under perfect compliance.
    onScopeAmended: (sessionID, resolution) => {
      composer.recordCompliance(sessionID, "scope-watchdog", `scope-${resolution}`)
    },
  })

  // ===========================================================================
  return {
    async config(cfgInput) {
      await applyV2Config(cfgInput as never, client, activateCommandName)
    },

    tool: planTools,

    async "command.execute.before"(commandInput) {
      if (isSelf(commandInput.sessionID)) return
      if (
        commandInput.command === activateCommandName ||
        commandInput.command.startsWith("elicify-vertex-plan-")
      ) {
        commandActivatedSessions.add(commandInput.sessionID)
        const state = getOrCreateState(commandInput.sessionID)
        state.active = true
      }

      // FR-064: `/elicify-vertex-visibility` cycles off -> gates -> all.
      // Slash commands are prompt templates and cannot call plugin code, so
      // the toggle is implemented by intercepting the command here — the same
      // mechanism activation already uses.
      // Hardcoded to match `planSlashCommands()`'s registration key
      // (wiring/tools.ts), which does NOT vary with activeSkillTrigger.
      // Deriving it from the trigger made the toggle a silent no-op under
      // any custom trigger while the template still told the user it had
      // been cycled.
      if (commandInput.command === "elicify-vertex-visibility") {
        const sid = commandInput.sessionID
        const current = visibility.modeFor(sid)
        const next = current === "all" ? "off" : current === "off" ? "gates" : "all"
        // Per-session (FR-064): one plugin instance serves every concurrent
        // session, so a process-global mode would let one operator silence
        // another's toasts with no way to tell why.
        visibility.setMode(next, sid)
        logger("visibility:mode-changed", { sessionID: sid, mode: next })
        // notifyControl, not notify: this acknowledges an explicit user action
        // and must not be suppressed by the mode that action just set —
        // otherwise toggling `all -> off` silently confirms nothing.
        void visibility.notifyControl({
          sessionID: sid,
          family: "visibility",
          message: `elicify-vertex visibility is now "${next}"`,
          variant: "info",
        })
      }
    },

    // ── CHAT.MESSAGE: activation, phase reset, intake classification ───────
    async "chat.message"(msgInput, output) {
      const sid = msgInput.sessionID
      if (isSelf(sid)) return
      const state = getOrCreateState(sid)

      // Recording the model id is a pure in-memory assignment: no disk, no
      // event, nothing a session that never activates the harness can leave
      // behind (UAT G1 / the "a non-activated session writes nothing" test).
      if (msgInput.model) {
        state.modelId = `${msgInput.model.providerID}/${msgInput.model.modelID}`
      }

      // A message of any kind means the silence ended — the pause timer is
      // measuring quiet, and this is the opposite of quiet. Cancelled before
      // the echo guard so it also clears on the continuation's own echo.
      cancelPauseJudge(sid)

      const text = (output.parts || [])
        .filter((p) => p && p.type === "text" && typeof (p as { text?: unknown }).text === "string")
        .map((p) => (p as { text: string }).text)
        .join("\n")

      if (state.idleContinuationInFlight) {
        // v1's `gateContinuationSessions` pattern: the reentrant chat.message
        // caused by our own session.prompt continuation must not reset the
        // turn — ledger/phase/pins all stay exactly as they were.
        //
        // M4 (grill round 2): this used to return unconditionally, which made
        // it the wedge it was meant to be a backstop against. `promptContinuation`
        // deliberately does NOT release the flag on its timeout path, and
        // documents that the next real `chat.message` is "the turn boundary
        // that genuinely ends it" — but the release lives in `resetTurnState`
        // further down, which this `return` skipped. A continuation that never
        // settled therefore left the flag set forever and every subsequent
        // user message short-circuited here: the harness inert, silently.
        //
        // So distinguish the two cases the flag conflates. A dispatched
        // continuation produces exactly ONE echo, so the first message while
        // the guard is up is consumed as that echo and every later one is
        // user intent — which IS the turn boundary.
        //
        // MAJ-9 (grill round 3): this used to be
        // `text.includes(state.lastContinuationText)`. A host that trims,
        // re-wraps or prefixes the echoed prompt would fail the match, release
        // the guard and let the continuation clobber the very ledger it was
        // dispatched to act on — and the emitted event said "real user
        // message" either way, so the log could not tell them apart. The
        // one-shot consume (v1's `gateContinuationSessions` behaviour) has
        // neither failure mode: text is a corroborating signal, not the test.
        if (state.lastContinuationText !== null) {
          const looksLikeEcho = text.includes(state.lastContinuationText)
          state.lastContinuationText = null
          logger("gate:continuation-echo-consumed", { sessionID: sid, textMatched: looksLikeEcho })
          state.active = true
          return
        }
        // Belt and braces: `resetTurnState`, reached a few lines below on the
        // activation path, also clears this. A mutant deleting this line
        // survives the suite for exactly that reason — kept anyway, because a
        // message that does NOT re-activate the session never reaches
        // `resetTurnState`, and leaving the guard up there is the wedge.
        state.idleContinuationInFlight = false
        logger("gate:continuation-guard-released", { sessionID: sid, reason: "real user message" })
      }

      // CR-11 (round 5): `resetTurnState` runs ONLY on the activation branch
      // below, so a session that is already active and receives an ordinary
      // follow-up (no trigger text, non-default agent — the normal shape of
      // every turn after the first in a trigger-activated session) never
      // reset these. `unauditedEscalated` then stayed spent, so a second
      // unaudited plan ended in silence, and `storyReaudits` accumulated
      // across unrelated plans, tripping the FR-007 cap early. Both are
      // per-plan state whose boundary is a real user message, which is
      // exactly what this is.
      if (state.active) {
        // NOT `unauditedEscalatedFor`: that is keyed by the unresolved story
        // set, and a user message does not resolve anything. Clearing it here
        // is what let the escalation repeat every turn against a state nothing
        // could move (fix 2). It clears itself when the set changes.
        state.storyReaudits = {}
      }

      const triggerEscaped = opts.activeSkillTrigger.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      const triggerRe = new RegExp(`^\\s*${triggerEscaped}\\b`, "m")
      const activatedByTrigger = triggerRe.test(text)
      const activatedByAgent = msgInput.agent === opts.activeAgent
      const activatedByCommand = commandActivatedSessions.has(sid)
      const activatesThisMessage = activatedByAgent || activatedByTrigger || activatedByCommand

      // ── THE TURN BOUNDARY ──────────────────────────────────────────────
      // This lives OUTSIDE the activation branch on purpose. It used to sit
      // inside it, next to `resetTurnState`, and that froze the turn index at
      // 1 for the whole of the commonest session shape there is: a session
      // activated by trigger text (or by `/elicify-vertex`) while running
      // under a non-default agent. Every ordinary follow-up in such a session
      // — the shape the C-14 comment below itself calls "the normal shape of
      // every turn after the first", and which also covers any message with
      // no `agent` field at all — takes neither the activation branch nor the
      // deactivation branch, so nothing advanced the clock.
      //
      // Measured, one session: activation by trigger under agent "build" then
      // three ordinary follow-ups, 16 hook invocations, identical worktree.
      //   frozen:         turnIndex [1],     4 directives delivered
      //   turn advancing: turnIndex [1,2,3], 12 directives delivered
      // Every per-turn cap, every cooldown, every `claimOncePerTurn` latch and
      // the whole FR-061 starvation verdict ride this clock, so freezing it
      // silences the harness for the rest of the session AND silences the one
      // detector that would have reported the silence (the verdict is reached
      // in `advanceTurn`, which never ran).
      //
      // A prompt boundary is a turn regardless of how the session was
      // activated. That is the definition `composer.ts` states and the one
      // `wiring/gate.ts` uses for its continuations. This is emphatically NOT
      // the reverted per-step advance (see the history note at gate.ts's own
      // `newTurn` call): a `chat.message` on an active session is one prompt,
      // not one agent-loop step, and the reentrant `chat.message` a harness
      // continuation causes is consumed as an echo above and returns before
      // it ever reaches here — so a continuation still advances the turn
      // exactly once, at dispatch.
      //
      // Guarded on "active, or activating right now" so a session that never
      // engages the harness still allocates no composer state (UAT G1).
      if (state.active || activatesThisMessage) {
        composer.newTurn(sid)
      }

      if (activatesThisMessage) {
        const wasClose = phaseEngine.getPhase(sid) === "close"
        state.active = true
        // C-14: record which agent (if any) activated this turn, so a LATER
        // message carrying that same agent again is recognised as "business
        // as usual" rather than misread as a switch-away. Trigger/command
        // activation is agent-independent by design (that's the whole point
        // of having those two routes alongside activatedByAgent) — a session
        // activated via `/elicify-vertex` while running under a non-default
        // agent (e.g. "build") must not self-deactivate the moment that same
        // agent reappears on the very next turn, which it always will.
        //
        // Set ONCE per activation streak, not on every qualifying turn: a
        // session activated by trigger under "build" that later gets an
        // ordinary default-agent turn (activatedByAgent) must not have its
        // recorded activator overwritten to the default agent — that would
        // make "build" look like a switch-away the next time it reappears.
        // Found by adversarial re-review of the first C-14 fix, reproduced
        // with a 3-turn interleaving the original two-agent tests didn't
        // cover. Paired with the `.delete()` on genuine deactivation below,
        // so a later real re-activation still records fresh.
        if (!activatedAgentBySession.has(sid)) {
          activatedAgentBySession.set(sid, msgInput.agent)
        }
        phaseEngine.onUserMessage(sid)
        resetTurnState(state)
        // Redesign point 9: a real user message re-arms the delegation
        // tracker — a `task` whose `tool.execute.after` the host dropped (or
        // an inconsistent before/after callID) would otherwise leave a stale
        // in-flight entry that the idle gate has to probe around every turn.
        delegationTracker.clearSession(sid)
        // FIX #8: plugin-local turn-scoped pending state (not part of
        // V2SessionState's resetTurnState) — cleared at the same turn
        // boundary.
        storyCompletionPending.delete(sid)
        // FIX #4: PinStore.gc() was fully implemented but never called
        // anywhere, so pins.json grew unboundedly across every session ever
        // seen. Once per activated turn is a reasonable cadence — cheap
        // relative to a whole turn, and bounds growth without adding a call
        // to every persist() site.
        pinStore.gc(new Set(states.keys()))

        if (wasClose) {
          state.classifiedThisTask = false
          state.multiStoryPending = false
        }

        const sigMode = classifyStopMode(text)
        evidenceLedger.reset(sid, sigMode.mode, sigMode.risks)
        manifests.invalidate(state.workspaceRoot)

        // -- Intake classification subturn dispatch (FR-018/018a/018b) --
        if (!state.classifiedThisTask) {
          if (state.intakeSubturnCount >= opts.intakeSubturnMax) {
            logger("intake:classify-capped", { sessionID: sid })
          } else {
            const sessionModel = parseModelRef(state.modelId) ?? { providerID: "unknown", modelID: "unknown" }
            const result = await classifyMultiStory(
              client,
              { selfCreated, logger: bindSession(sid, logger) },
              { parentSessionID: sid, sessionModel, askText: text },
            )
            state.classifiedThisTask = true
            if (result.source !== "skipped") state.intakeSubturnCount += 1
            if (result.multiStory) state.multiStoryPending = true
          }
        }

        if (!state.activateCueShown) {
          state.activateCueShown = true
          const cue = formatActivateCue({ stopMode: sigMode.mode, agent: msgInput.agent })
          // TextPart requires id/sessionID/messageID (@opencode-ai/sdk's
          // TextPart type) — omitting them compiles (the push site was cast
          // `as never`/`as any`) but the host rejects the part at save time,
          // discovered via live-host testing, in three successive layers:
          // (1) the fields are required at all (SchemaError: Missing key);
          // (2) their VALUES must match the host's own ID shape — id must
          // start with "prt", messageID with "msg" (SchemaError: Expected a
          // string starting with...) — a bare UUID fails this even though
          // it's a valid string; (3) messageID must reference a REAL row —
          // a syntactically-valid-but-fabricated "msg_<uuid>" fails the
          // `part.message_id` foreign key constraint against the `message`
          // table. The one ID that is real, host-assigned, and guaranteed to
          // reference the message this very hook call is attached to is
          // `output.message.id` — use that instead of `msgInput.messageID`
          // (optional on the hook's input type, and not the same value even
          // when both happen to be present).
          output.parts.push({
            id: `prt_${randomUUID()}`,
            sessionID: sid,
            messageID: output.message.id,
            type: "text",
            text: `\n${cue}`,
          } as never)
        }
      } else if (
        msgInput.agent !== undefined &&
        msgInput.agent !== opts.activeAgent &&
        // C-14 (docs/CODE-ISSUES-FROM-PROMPT-AUDIT.md): without this third
        // condition, a session activated by trigger text/command while
        // running under a non-default agent (e.g. "build") deactivated
        // itself on its own very next ordinary turn -- that turn's message
        // necessarily carries the SAME "build" agent again, which read as a
        // switch-away even though nothing changed. Confirmed on a real host,
        // not just a direct hook probe (see tests/v2/plugin.integration.test.ts's
        // "C-14" describe block for both directions). Only a message whose
        // agent differs from BOTH the configured default AND whatever agent
        // this session itself activated under is treated as a genuine
        // switch to an unrelated agent.
        msgInput.agent !== activatedAgentBySession.get(sid)
      ) {
        state.active = false
        state.activateCueShown = false
        // Paired with the "set once per streak" guard above: clearing the
        // recorded activator on a genuine deactivation is what lets the NEXT
        // real activation record fresh, instead of the once-per-streak guard
        // mistaking a stale entry from a prior streak for "already recorded".
        activatedAgentBySession.delete(sid)
      }
    },

    // ── TOOL.EXECUTE.BEFORE: defence in depth over the evidence store ──────
    //
    // NOT the integrity control. That is the HMAC in `goals.ts`: a receipt the
    // harness did not mint has no valid signature, so `get()` refuses it no
    // matter how it reached the file. This hook exists to give a clear error at
    // the moment of the attempt instead of a confusing refusal later.
    //
    // It is deliberately NARROW, because the wide version was worse than
    // useless. An audit walked ~15 ways around it -- `file_path` instead of
    // `filePath`, a path inside `patchText`, a symlink to the directory, string
    // concatenation and base64 inside a bash command -- so it never actually
    // held the line; and the bash substring match ALSO refused `cat`, `grep`,
    // `ls`, and `git commit -m "move state to .opencode/elicify-vertex"`,
    // breaking ordinary work and contradicting its own promise that reads were
    // untouched. Signing made exhaustiveness unnecessary, so the check now
    // covers only unambiguous write tools by path and leaves bash alone.
    async "tool.execute.before"(toolInput, toolOutput) {
      const sid = toolInput.sessionID
      if (isSelf(sid)) return

      // C-7 (docs/CODE-ISSUES-FROM-PROMPT-AUDIT.md, design in
      // docs/SUBAGENT-INJECTION-DRAFT.md): every `task` tool call gets the
      // shared subagent discipline prepended to its prompt, instead of
      // depending on the parent remembering to hand-write it into each
      // delegation. Must go BEFORE the `WRITE_TOOL_NAMES` gate below --
      // "task" is not a write tool, so that gate would otherwise skip right
      // past this branch. Inject and return immediately; the write-protection
      // logic below does not apply to a `task` call. No `isSelf` re-check
      // needed here: the verifier and intake subturns are created directly via
      // `runSubturn` (`client.session.create` + `client.session.prompt`),
      // never through the `task` tool, so they never reach this branch.
      if (toolInput.tool === "task") {
        // Redesign point 9: record the delegation so the idle gate defers
        // nudging while it is mid-flight (paired with `noteTaskDone` in
        // `tool.execute.after`).
        delegationTracker.noteTaskCall(sid, toolInput.callID)
        const args = (toolOutput?.args ?? {}) as Record<string, unknown>
        const injected = injectSubagentPreamble(args)
        // `injectSubagentPreamble` returns `false` (no-op, defensively) when
        // `args.prompt` isn't a string -- today that never happens (the
        // `task` schema requires `prompt: string`), but the return value was
        // previously discarded outright, so if the schema ever changes shape
        // the whole injection mechanism would silently stop working with no
        // signal anywhere. Log only the no-op case -- the success path stays
        // as quiet as it already was.
        if (!injected) {
          logger("subagent:injection-skipped", {
            sessionID: sid,
            callID: toolInput.callID,
            reason: "args.prompt is not a string",
            promptType: typeof args.prompt,
          })
        }
        return
      }
      // The star ask is recorded at DISPATCH as well as on completion (see the
      // twin in `tool.execute.after`). `tool.execute.after` only runs once
      // `execute` RESOLVES, so a question the user escapes or rejects records
      // nothing — and `asked` is the only thing that stops the agent raising
      // starring again, so that user would be asked every session forever.
      // Dispatch is the moment the question is put in front of them, which is
      // the event the marker is meant to record. Writing it here can, in the
      // rare case where the host refuses the call outright, record an ask
      // nobody saw: that costs a star, whereas the miss costs the user a
      // prompt every session for the rest of time. Both sites are idempotent
      // (`recordStarAskIfOurs` writes only when nothing is recorded yet).
      if (toolInput.tool === "question") {
        if (recordStarAskIfOurs(toolOutput?.args)) logger("star:asked", { sessionID: sid, at: "dispatch" })
      }
      if (!WRITE_TOOL_NAMES.has(toolInput.tool)) return

      const state = states.get(sid)
      const root = state?.workspaceRoot ?? workspaceRoot
      const args = (toolOutput?.args ?? {}) as Record<string, unknown>

      for (const key of WRITE_TOOL_PATH_KEYS) {
        const value = args[key]
        if (typeof value === "string" && isProtectedStatePath(value, root)) {
          throw new Error(
            `elicify-vertex: ${value} is inside ${PLUGIN_STATE_DIR}, which holds verification ` +
              `evidence written only by the harness. Receipts are signed, so one you author ` +
              `yourself will be rejected as evidence — record work with ` +
              `elicify_vertex_plan_checkpoint instead.`,
          )
        }
      }
    },

    // ── TOOL.EXECUTE.AFTER: mutation/verification observation ──────────────
    async "tool.execute.after"(toolInput, toolOutput) {
      // Work happened: whatever the timer was measuring, it was not a pause.
      if (typeof toolInput?.sessionID === "string") cancelPauseJudge(toolInput.sessionID)

      const sid = toolInput.sessionID
      if (isSelf(sid)) return

      // The star ask is recorded HERE as well as at dispatch — on an OBSERVED
      // `question` call carrying our repo. Nothing else writes `asked`.
      //
      // B-6 removed the runtime arm/inject/retry loop, so there is no longer a
      // "dispatched" set to gate this on: the ask now comes from the agent
      // prompt, which the harness cannot observe arming. Without this
      // observation nothing would ever write `asked`,
      // `elicify_vertex_star_status` would answer "none" forever, and the
      // agent would re-raise starring EVERY session — worse nagging than the
      // loop that was deleted. A repo-and-star match is the whole gate.
      // Matching rule + write live in `recordStarAskIfOurs` (wiring/tools.ts)
      // so both observation points share one implementation — see the twin in
      // `tool.execute.before`, which is the one that survives a question the
      // user escapes.
      //
      // PLACEMENT MATTERS, and it matches the twin exactly: AFTER `isSelf`
      // (a `question` inside one of the harness's own subturn sessions is not
      // an ask the user ever saw, and must not spend the machine-wide
      // one-shot) and BEFORE the `state.active` check (a question put to the
      // user in a session the harness has not activated is still a real ask,
      // and the whole point of the marker is that it is machine-wide). The
      // twin sits at the same two boundaries; this site used to sit above
      // both, which is only moot because subturns are zero-tool today.
      if (toolInput?.tool === "question" && typeof sid === "string") {
        if (recordStarAskIfOurs(toolInput.args)) logger("star:asked", { sessionID: sid })
      }
      const state = states.get(sid)
      if (!state || !state.active) return

      // v1 parity (src/index.ts's tool.execute.after): once a tool runs,
      // any prior assistant text is no longer the turn's "final" reply — the
      // model may still produce more text after this tool call. Clearing it
      // here means gate.ts's promise-no-act check (session.idle) only ever
      // sees text produced AFTER the latest tool call; without this, stale
      // pre-tool-call text (e.g. "I'll fix this next" followed by the model
      // actually fixing it) would still read as an unfulfilled promise.
      state.lastAssistantText = null

      const toolName = toolInput.tool
      // Redesign point 9: every real tool call is observable activity — the
      // stall detector compares this marker across idle boundaries, and a
      // completed `task` call closes its delegation record.
      state.activityMarker += 1
      if (toolName === "task") delegationTracker.noteTaskDone(sid, toolInput.callID)
      const args = (toolInput.args ?? {}) as Record<string, unknown>
      const out = toolOutput.output ?? ""
      const meta = (toolOutput.metadata ?? {}) as Record<string, unknown>
      const exitCode =
        typeof meta.exit === "number" ? meta.exit : typeof meta.exitCode === "number" ? meta.exitCode : undefined

      const command = toolName === "bash" && typeof args.command === "string" ? args.command : ""
      const verification = toolName === "bash" ? parseVerification(command, out, exitCode) : null
      const changedPaths = changedPathsFromTool(toolName, args)

      if (changedPaths.length > 0) {
        verificationReceipts.invalidate(sid)
        for (const p of changedPaths) evidenceLedger.recordChangedFiles(sid, p)

        // FIX #1: resolve via the plan's finalStoryId once no story is
        // active (see resolveStoryIdForPhase's doc comment) instead of a
        // bare getActiveStory(sid)?.id ?? null.
        const activeStoryId = resolveStoryIdForPhase(storyEngine, sid)
        const phaseBefore = phaseEngine.getPhase(sid, activeStoryId)
        phaseEngine.onMutation(sid, activeStoryId)
        const phaseAfter = phaseEngine.getPhase(sid, activeStoryId)
        if (phaseBefore !== "execute" && phaseAfter === "execute") state.precommitmentPending = true

        // Auto-invalidate criteria evidence that was a receipt (not a
        // user waiver — waivers are a deliberate sign-off, not stale
        // machine evidence) on new mutations, mirroring v1's "post-mutation
        // evidence is stale" rule (EvidenceLedger.recordChangedFiles).
        for (const c of pinStore.get(sid)) {
          if (c.evidence && "receiptId" in c.evidence) pinStore.attachEvidence(sid, c.id, null)
        }
        // FIX #3: this invalidation loop never persisted, unlike the
        // sibling "attach new evidence" loop below (which does) — a process
        // crash between an edit and the next successful verification left
        // stale "evidenced" state on disk. PinStore.persist() is the
        // documented "explicit disk sync point — call after pin()/
        // attachEvidence()"; call it unconditionally here too (cheap no-op
        // write when nothing actually changed).
        pinStore.persist(sid)

        const realPaths = changedPaths.filter((p) => !NON_PATH_MUTATION_MARKERS.has(p))
        for (const p of realPaths) {
          const result = storyEngine.checkScope(sid, p)
          if (result) {
            state.scopeDriftPending = { path: p, offer: result.offer, scopeGlobsMatchedZero: result.scopeGlobsMatchedZero }
          }
        }
      }

      if (toolName === "bash" && verification?.isVerificationCommand) {
        const rawSuccess = verification.outcome === "verified"

        // FR-061 health signal: a REAL verifier ran, but its aggregate exit
        // code is unreliable, so no receipt can be minted. Almost always
        // caused by `;`-chaining (`go test ./... ; echo "---exit:$?---"`),
        // where the compound's status is the trailing command's and is
        // therefore always 0. `parseVerification` correctly refuses it — but
        // silently, so the model re-runs the same shape forever and evidence
        // never accrues. Measured: 4 of 25 bash commands in the field session
        // had this shape, and the agent's own prompt models `;`-chaining, so
        // the model learns it by example.
        if (verification.outcome === "ambiguous" && exitCode === 0) {
          const ambiguousExitMessage =
            `"${command.slice(0, 80)}" looks like a verifier but its exit code is not reliable ` +
            `(usually ';' chaining) — no receipt minted. Run the verifier as a standalone command.`
          void visibility.notify("health", {
            sessionID: sid,
            family: "verify:ambiguous-exit",
            message: ambiguousExitMessage,
            variant: "warning",
          })
          // C-2 (docs/CODE-ISSUES-FROM-PROMPT-AUDIT.md): `visibility.notify`
          // only reaches `client.tui.showToast`, a human-operator channel --
          // the model never reads it. Append the same diagnostic to the
          // tool's own output, mirroring the successful receipt-mint branch
          // below (`[vertex:verification-receipt] <id>`), but with a prefix
          // that can never be mistaken for a real receipt id.
          const diagnosticText = `[vertex:verify-ambiguous] ${ambiguousExitMessage}`
          toolOutput.output = `${out}${out && !out.endsWith("\n") ? "\n" : ""}${diagnosticText}`
          logger("verify:ambiguous-exit", { sessionID: sid, command })
        }

        // FIX #6 (review MAJOR — "relevance gap" edge case unimplemented):
        // docs/vertex2-spec.md Edge Cases — "Verifier passes but is
        // unrelated to changed paths (relevance gap) -> evidence recorded
        // as partial; verify-gap prescription names the missing suite;
        // elevate does not fire." Compare the observed command against what
        // resolve.ts's resolveVerifier would prescribe for the CURRENTLY
        // changed paths; a real (non-generic) resolution the observed
        // command does not match is a relevance gap.
        let relevanceGap = false
        // Hoisted: the auto-attach decision below needs to know whether this run
        // related to any work at all.
        let prescribed: string | null = null
        // Did the session have anything for this verifier to be ABOUT -- files
        // changed this turn, or a story declaring what proves it? This is the
        // distinction that matters, and it is NOT `prescribed !== null`:
        // `resolveVerifier` also returns null when files DID change but it has
        // no opinion about which verifier covers them, and a passing run is
        // perfectly good evidence there.
        let hadWorkToMeasure = false

        // A command that EXECUTES NOTHING can never be evidence, whether or
        // not a prescription exists to compare it against. This is checked
        // before (and independently of) the coverage comparison because with
        // no plan and no changed paths there IS no prescription — and UAT
        // proved `python3 -m pytest --collect-only` minted a real receipt
        // through exactly that hole while running zero tests.
        if (rawSuccess && exitCode === 0 && isNonExecutingCommand(command)) {
          relevanceGap = true
          void visibility.notify("health", {
            sessionID: sid,
            family: "verify:non-executing",
            message: `"${command.slice(0, 80)}" executes no tests — no receipt minted.`,
            variant: "warning",
          })
          logger("verify:non-executing", { sessionID: sid, command })
        }

        if (rawSuccess && exitCode === 0 && !relevanceGap) {
          const realChangedPaths = evidenceLedger.getChangedPaths(sid).filter((p) => !NON_PATH_MUTATION_MARKERS.has(p))
          const storyForResolve = storyEngine.getActiveStory(sid)
          // M7: same reachable-bad-input guard as `resolve.ts` — these strings
          // are LLM-authored, and `observedCoversPrescribed` would throw on a
          // non-string straight out of a `tool.execute.after` hook.
          const storyVerifiers =
            storyForResolve?.verifiers?.filter((v) => typeof v === "string" && v.trim().length > 0) ?? null

          // The prescription to compare against. Previously this whole check
          // was gated on `realChangedPaths.length > 0`, which left a hole a
          // review proved end to end: with no mutation observed yet this
          // turn, ANY passing command minted a receipt — `npx eslint .`
          // satisfied a story whose verifier was `go test ./internal/...`.
          // `resolveVerifier` returns tier "none" for an empty path set
          // before it ever consults `storyVerifiers`, so when there are no
          // changed paths we fall back to the story's own declared verifiers,
          // which are a prescription in their own right.
          hadWorkToMeasure = realChangedPaths.length > 0 || (storyVerifiers?.length ?? 0) > 0
          // M5 (grill round 2): the story branch must come FIRST. Story
          // precedence is absolute — `resolveVerifier` returns tier 1
          // ("story") ahead of every ecosystem inference — so with changed
          // paths present the old ordering reached the same verifiers by the
          // other route and got them back `.join(" && ")`-ed, which is
          // precisely the joined prescription FR-013 exists to undo. The
          // individual crediting below therefore only ever ran in the
          // no-changed-paths branch: the rare case. Whenever a story declares
          // verifiers they ARE the prescription, changed paths or not.
          if (storyVerifiers && storyVerifiers.length > 0) {
            // FR-013: credit a story's verifiers INDIVIDUALLY. This used to be
            // `storyVerifiers.join(" && ")`, which — combined with
            // `observedCoversPrescribed`'s `prescribedParts.every(...)` —
            // demanded that ONE observed command cover ALL of a story's
            // verifiers at once. A 6-verifier story could then only mint a
            // receipt if the agent ran all six in a single command, which no
            // agent does. Measured consequence in the audited session
            // (ses_04dc77bdaffej8SFJvYm5yO0CW): 146 `verify:relevance-gap`
            // events and ZERO receipts minted, even though the agent WAS
            // running the stories' own declared verifiers one at a time
            // (observed `test -f .../crispr-gene-editing.md` vs prescribed
            // `test -f research/renewable-energy.json && ...`). That empty
            // receipt store is also why the receipt-based verifier cross-check
            // had no data to use. Any single declared verifier the observed
            // command covers is now sufficient.
            //
            // The individual-crediting half is only HALF the fix: the observed
            // command in that measurement was spelled ABSOLUTELY
            // (`/workspace/vertextest2/research/…`) while the declared verifier
            // was relative, so `find` still matched nothing. `workspaceRoot` is
            // the second half — it lets `observedCoversPrescribed` recognise
            // the two spellings as the same path (see `coverage.ts`'s
            // `rootRelative`). Both call sites must pass it, or `find` locates
            // the right verifier and the check below immediately re-rejects it.
            prescribed =
              storyVerifiers.find((verifier) => observedCoversPrescribed(verifier, command, state.workspaceRoot)) ??
              storyVerifiers[0]
          } else if (realChangedPaths.length > 0) {
            const manifest = manifests.get(state.workspaceRoot)
            prescribed = resolveVerifier(
              // `storyVerifiers` is empty on this branch by construction, so
              // passing it would be noise; tier 1 cannot apply here.
              { changedPaths: realChangedPaths, storyVerifiers: null },
              { readManifest: () => manifest },
            ).command
          }

          if (prescribed && !observedCoversPrescribed(prescribed, command, state.workspaceRoot)) {
            relevanceGap = true
            // FR-061 health signal. This is the exact condition that
            // silently suppressed every receipt for 94 minutes in the
            // field — the operator must be able to see it happening.
            void visibility.notify("health", {
              sessionID: sid,
              family: "verify:relevance-gap",
              message: `verifier did not cover the prescribed one — no receipt minted. observed: ${command}`,
              variant: "warning",
            })
            logger("verify:relevance-gap", {
              sessionID: sid,
              observedCommand: command,
              expectedCommand: prescribed,
            })
          }
        }
        // `success` folds the relevance gap in: a relevance-gap pass must
        // not attach evidence, drive elevate, or count as a story going
        // green. EXPECT/anomaly/failure-classification below intentionally
        // use `rawSuccess` instead — whether the OBSERVED COMMAND itself
        // passed or failed is a different question than whether it covers
        // the right paths, and EXPECT is about the former.
        //
        // BACKLOG R-4: the EVIDENCE LEDGER no longer reads this bit. It used
        // to, and that is precisely how a passing command came to be recorded
        // as a failure — see the call below. Verify-gap is still suppressed
        // by a relevance gap, but via the ledger's own coverage bit rather
        // than by mislabelling the run.
        const success = rawSuccess && !relevanceGap
        if (exitCode !== undefined) {
          // BACKLOG R-4: this used to be
          // `success ? verification.outcome : "failed"`, which folded the
          // relevance gap into the FAILURE axis: a command that exited 0 and
          // really did pass was written into the ledger as a failure purely
          // because it did not match the prescription, and the model was then
          // shown "failed: 1" for a run it had just watched succeed. Failure
          // means the command failed. The coverage question is now carried by
          // its own bit — every gate (`hasVerification`, `shouldBlockStop`,
          // `actionableSummary`) still requires both, so verify-gap keeps
          // firing on exactly the same runs as before.
          evidenceLedger.recordVerification(sid, command, exitCode, verification.outcome, {
            coversPrescribed: !relevanceGap,
          })
        }

        // FIX #7: keep the most recent verifier command's real output text
        // (bounded) for the verifier payload — see gateCtx.recentVerifierSummaries.
        lastVerifierOutputBySession.set(sid, (out || "").slice(-2000))

        if (success && exitCode === 0) {
          const receipt = verificationReceipts.record({
            sessionID: sid,
            workspaceRoot: state.workspaceRoot,
            command,
            exitCode: 0,
            outcome: "verified",
            outputSummary: out,
            observedAt: new Date().toISOString(),
          })
          // Surface the receipt id back to the model, mirroring v1's
          // src/index.ts (`attemptGateContinuation`'s tool.execute.after,
          // ~L1670) — v2 minted receipts but never told the model what id
          // to quote back in elicify_vertex_plan_checkpoint, so the model
          // had no way to pass a real receiptId and either fabricated one
          // (rejected by isFreshReceipt) or fell back to a waiver/generic
          // tool. Appending it to the tool's own output puts it exactly
          // where the model already reads the verifier's result.
          //
          // A receipt whose scope could not be fingerprinted is NOT surfaced.
          // It cannot pass the freshness check at any consumer, so telling the
          // model to cite it produced the worst possible sequence: mint, print
          // the id, then refuse that id forever -- on a worktree past the
          // file/byte ceiling no story could be closed by a receipt at all, and
          // the only route left was a waiver. Say so plainly instead.
          if (receipt.scope && receipt.scope.complete === false) {
            const scopeUnverifiableMessage =
              `verifier passed, but this worktree is too large to fingerprint ` +
              `(${receipt.scope.fileCount} files), so no citable receipt was issued. ` +
              `Checkpoint with a waiver, or narrow the workspace.`
            void visibility.notify("health", {
              sessionID: sid,
              family: "receipt:scope-unverifiable",
              message: scopeUnverifiableMessage,
              variant: "warning",
            })
            // C-2 (docs/CODE-ISSUES-FROM-PROMPT-AUDIT.md): same fix as
            // verify:ambiguous-exit above -- append to the tool's own output
            // so the model (not just the human toast) sees why a passing
            // verifier minted nothing citable. Distinct prefix so this can
            // never be mistaken for `[vertex:verification-receipt] <id>`.
            const diagnosticText = `[vertex:scope-unverifiable] ${scopeUnverifiableMessage}`
            toolOutput.output = `${out}${out && !out.endsWith("\n") ? "\n" : ""}${diagnosticText}`
            logger("receipt:scope-unverifiable", { sessionID: sid, command, fileCount: receipt.scope.fileCount })
          } else {
            const receiptText = `[vertex:verification-receipt] ${receipt.id}`
            toolOutput.output = `${out}${out && !out.endsWith("\n") ? "\n" : ""}${receiptText}`
            toolOutput.metadata = { ...meta, vertexVerificationReceiptId: receipt.id }
          }
          // FIX #2 (review CRITICAL — "evidence auto-attach is
          // all-or-nothing"). Judgment call (documented — restate in the
          // final report, this is a genuine spec ambiguity, not a clean bug
          // fix): no module anywhere exposes a per-criterion evidence-binding
          // mechanism (no verifier declares which specific criterion it
          // proves), so which criterion a passing verifier "counts for" is
          // undecidable from first principles. The PRIOR behavior attached
          // the same receipt to EVERY currently-unevidenced criterion at
          // once, which makes FR-015 Dataset Row 1 ("C1 evidenced, C2 not,
          // from a single verifier pass") structurally impossible to
          // observe. Interim interpretation applied here: attach the new
          // receipt to only the SINGLE oldest unevidenced criterion (first
          // in pin order) — a session with N unmet criteria now needs N
          // distinct successful verifications to clear them all, matching
          // the dataset's implicit "each criterion needs its own evidence"
          // model far more closely than all-or-nothing ever did.
          //
          // ...and only when the run was measured against a PRESCRIPTION. With
          // no plan and no changed paths, `prescribed` is null, so every
          // verifier-shaped command mints -- `npx eslint .`, `tsc --noEmit`,
          // `make check` all did. Auto-attaching those closed the criteria gate
          // on evidence of nothing: an audit pinned "auth service tests pass"
          // and "migration applies cleanly", ran eslint, and the session was
          // allowed to close. The receipt itself is a true statement (that
          // command really did pass) and is still minted and citable; what it
          // must not do is silently answer a criterion nobody checked it
          // against.
          // Only a TEST RUN may answer a criterion nobody explicitly measured
          // it against. `hadWorkToMeasure` alone was not enough: the audit's
          // case edited `src/app.rb`, which the resolver cannot classify, so
          // `prescribed` was null AND files had changed -- and `npx eslint .`
          // still closed criteria reading "auth service tests pass".
          if (hadWorkToMeasure && isTestRunnerCommand(command)) {
            const firstUnevidenced = pinStore.get(sid).find((c) => !c.evidence)
            if (firstUnevidenced) pinStore.attachEvidence(sid, firstUnevidenced.id, { receiptId: receipt.id })
            pinStore.persist(sid)
          }
        } else if (rawSuccess && exitCode === 0 && verification.outcome === "verified" && relevanceGap) {
          // FR-061: the command DID verify and exited 0, but its evidence was
          // refused. Silent evidence loss is the failure this whole feature
          // exists to make visible.
          //
          // The previous condition was `rawSuccess && exitCode === 0 &&
          // !relevanceGap`, which is exactly `success && exitCode === 0` --
          // the `if` branch above it -- so this could never fire. The signal
          // designed to expose silent receipt loss was itself silent. It now
          // fires on the case that actually loses evidence: a genuine pass
          // whose coverage or provenance check refused it.
          void visibility.notify("health", {
            sessionID: sid,
            family: "receipt:not-minted",
            message: `a passing verifier produced no receipt: ${command}`,
            variant: "warning",
          })
          // BACKLOG R-4, receipt decision. An uncovered-but-successful run
          // does NOT mint a receipt, and this is the deliberate half of that
          // choice rather than an oversight:
          //
          //   * A receipt is not a diary entry, it is a citable certificate —
          //     `gate.ts`'s criteria replay closes a pinned criterion on
          //     `isValidReceipt` alone and never re-asks about coverage. Mint
          //     one here and "ran eslint, cited it, closed 'auth service
          //     tests pass'" becomes a supported move.
          //   * Minting-but-refusing-at-lookup is not the alternative: this
          //     file already learned that lesson on the scope-unverifiable
          //     path ("mint, print the id, then refuse that id forever" —
          //     see `receipt.scope.complete === false` above), and the
          //     resolution there was to refuse at mint time and SAY SO.
          //   * Withholding on a positive, checkable "you did not run what
          //     was prescribed" is not the same as withholding out of
          //     ignorance, which is why the no-prescription branch still
          //     mints. What was never defensible was ALSO recording the run
          //     as a failure — fixed at `recordVerification` above.
          //
          // What is not defensible either is doing it in silence.
          // `visibility.notify` reaches `client.tui.showToast`, a
          // human-operator channel the model never reads (C-2), so until now
          // a passing verifier could produce nothing at all with no
          // explanation the model could act on. Same treatment as
          // `verify:ambiguous-exit` and `receipt:scope-unverifiable`: state
          // what was run versus what was prescribed, in the tool's own
          // output, with a prefix that cannot be mistaken for a receipt id.
          const gapMessage = prescribed
            ? `"${command.slice(0, 120)}" passed, but it does not cover the prescribed verifier ` +
              `"${prescribed.slice(0, 120)}" — no receipt was minted. Run the prescribed verifier ` +
              `to turn this into citable evidence.`
            : // `prescribed` can only be null here: `relevanceGap` is set in
              // exactly two places, and the other one (`prescribed &&
              // !observedCoversPrescribed(...)`) cannot fire without it.
              `"${command.slice(0, 120)}" exited 0 but executes no tests, so it is not evidence — ` +
              `no receipt was minted.`
          const gapText = `[vertex:verify-relevance-gap] ${gapMessage}`
          toolOutput.output = `${out}${out && !out.endsWith("\n") ? "\n" : ""}${gapText}`
        }

        // FIX #1: same resolveStoryIdForPhase fallback as the mutation site
        // above.
        const activeStoryId = resolveStoryIdForPhase(storyEngine, sid)
        const plan = storyEngine.getPlan(sid)
        const activeStory = storyEngine.getActiveStory(sid)
        const coversFinalStory = !plan || (activeStory != null && activeStory.id === plan.finalStoryId)
        const phaseBeforeVerify = phaseEngine.getPhase(sid, activeStoryId)
        // FIX #6: a relevance-gap pass must not drive onVerifierOutcome with
        // success:true (that would fire T4/elevate for a verifier that
        // doesn't actually cover the changes) — skip the call entirely so
        // phase stays exactly where it was (equivalent to "call it with
        // success:false" for T4 purposes, without risking T5's "record the
        // outcome" side effect for a pass that, from the command's own
        // perspective, did not fail).
        if (!relevanceGap) {
          phaseEngine.onVerifierOutcome(sid, activeStoryId, { success, coversFinalStory })
        }
        const phaseAfterVerify = phaseEngine.getPhase(sid, activeStoryId)
        if (phaseBeforeVerify !== "elevate" && phaseAfterVerify === "elevate") state.elevatePending = true

        // FIX #8 (review MAJOR — "no story-completion directive when an
        // intermediate story's verifier goes green"): BDD "Intermediate
        // story green does not elevate a multi-story plan" — a bound
        // verifier passed, a plan is active, and it does NOT cover the
        // plan's final story (this is exactly PhaseEngine.onVerifierOutcome's
        // own documented no-op case, "success && !coversFinalStory ... no
        // arc in the table"). Derived entirely from StoryEngine's own plan
        // order — NOT from PhaseEngine.onStoryAdvance (T8), which nothing
        // calls yet — so this fires regardless of whether T8 wiring lands.
        if (success && plan && activeStory && !coversFinalStory) {
          const idx = plan.stories.findIndex((s) => s.id === activeStory.id)
          const nextStory = idx >= 0 ? plan.stories[idx + 1] : undefined
          if (nextStory) storyCompletionPending.set(sid, nextStory)
        }

        // EXPECT comparison (FR-024/025/026)
        const failureClass = classifyFailureClass(out, rawSuccess)
        const summaryLine = firstLine(out) || (rawSuccess ? "verification passed" : "verification failed")
        const { mismatch, calibration } = compareExpectation(state.turnExpect, {
          success: rawSuccess,
          failureClass,
          summaryLine,
        })
        if (state.turnExpect) {
          if (calibration) {
            logger("calibration", { sessionID: sid, declared: calibration.declared, observed: calibration.observed })
          }
          if (mismatch) {
            state.anomalyPending = { expectText: state.turnExpect.text, observedSummary: summaryLine, failureClass }
          }
          state.turnExpect = null
        } else if (composer.claimOncePerTurn(sid, "expect:absent")) {
          // Once per turn, on the COMPOSER's turn clock. This used to be a
          // wiring boolean cleared only in `resetTurnState`, which the gate's
          // continuation path never reaches (`gate.ts` advances the turn with
          // `composer.newTurn` alone) — so in an unattended run the flag stayed
          // spent after the first turn and every later turn's missing EXPECT
          // went unrecorded.
          logger("expect:absent", { sessionID: sid })
        }

        // FR-034 compliance join
        // MAJ-7 (grill round 3): a verify-gap prescription built from a
        // story's verifiers arrives `&&`-joined (`resolve.ts` tier 1), and
        // `observedCoversPrescribed` requires ONE observed command to cover
        // EVERY prescribed part. A multi-verifier story's nudge could
        // therefore never be marked complied, no matter what the agent ran —
        // the same joined-prescription defect FR-013 fixed for receipts,
        // surviving on the compliance path.
        //
        // Compliance measures whether the nudge was ACTED ON, not whether
        // verification is complete (that is the receipt path, which still
        // demands full coverage). Running one declared verifier of an
        // `&&` chain is acting on it.
        for (const rendered of state.renderedVerifyGaps) {
          // M6 (grill round 2): this call was the one site still omitting the
          // root, so an observed command spelled absolutely never matched a
          // relatively-spelled prescription and the verify-gap was never
          // marked complied — the same absolute-vs-relative mismatch FR-013
          // fixed for receipts.
          // MAJ-7: see `verifyGapComplied` — the `&&` split is credited only
          // for a story's own verifiers, never for a mixed-ecosystem join.
          if (
            verifyGapComplied(rendered.command, command, {
              workspaceRoot: state.workspaceRoot,
              storyScoped: rendered.storyScoped,
            })
          ) {
            composer.recordCompliance(sid, "verify-gap", rendered.instanceId)
          }
        }

        // repeat-failure (reuses v1's per-signature cooldown mechanism)
        if (exitCode !== undefined && exitCode !== 0) {
          const signature = `${exitCode}:${failureSignature(firstLine(out) || "unknown error")}`
          evidenceLedger.recordFailure(sid, signature)
          const repeat = evidenceLedger.getRepeatFailure(sid)
          if (repeat && evidenceLedger.markRepeatFired(sid, repeat.signature)) {
            state.repeatFailurePending = { signature: repeat.signature, count: repeat.count }
          }
        }
      }
    },

    // ── SYSTEM.TRANSFORM: the single queue consumer ─────────────────────────
    async "experimental.chat.system.transform"(sysInput, sysOutput) {
      const sid = sysInput.sessionID
      if (!sid || isSelf(sid)) return
      const state = states.get(sid)
      if (!state || !state.active) return
      if (state.compacting) return // v1 invariant: skip draining mid-compaction

      state.modelId = `${sysInput.model.providerID}/${sysInput.model.id}`

      const findings: Finding[] = []

      if (state.needsCriteriaReinject) {
        findings.push(
          pinnedCriteriaReinjectFinding({
            instanceId: nextInstanceId(state),
            criteria: pinStore.get(sid),
            activeStory: storyEngine.getActiveStory(sid),
          }),
        )
      }

      // NO ASK-BASED SUPPRESSION. `TRIVIAL_ASK_RE` was tried here to keep
      // read-only questions quiet after `quick` mode was removed, and it was
      // wrong in both directions — measured:
      //
      //   SUPPRESSED  deep+database  "describe a plan to migrate the database
      //                               and then do it"
      //   SUPPRESSED  normal         "read the spec and implement the whole
      //                               payment flow"
      //   scaffold    normal         "/elicify-vertex\n\nwhat does this
      //                               function do?"
      //
      // Exactly backwards: it silenced the highest-risk class while still
      // firing on the read-only question it was added for, because the regex
      // is `^`-anchored and the documented activation route prefixes the ask
      // with the trigger. It also had no way back on once suppressed, and read
      // `lastUserAsk`, which is only populated on the activation branch.
      //
      // Losing a scaffold on a deep, risk-flagged task is a far worse outcome
      // than one extra directive on a question, so the gate is gone rather
      // than patched. If the noise matters, the fix is a signal that actually
      // tracks "has the user asked for work" — not a regex over the ask text.
      //
      // B-2: ONE OFFER PER TURN, not per invocation. This hook runs after
      // every tool result, so the unconditional `pinStore.get(sid).length
      // === 0` test above re-minted the scaffold on every step of the agent
      // loop. Measured in one field session: 179 `per-turn-cap:dropped`
      // events, every one `intake-scaffold` — the finding was rebuilt ~180
      // times and the composer's cap of 1 discarded all but the first. The
      // cap was never the bug; this producer was.
      //
      // B-2 FOLLOW-UP: the gate is spent on RENDER, not on OFFER.
      //
      // B-2 stamped `intakeScaffoldOfferedForTurn` at the moment the finding
      // was BUILT, which is not the moment it reaches the model. The scaffold
      // is `phase-guidance` and therefore ranks below every `correction` in
      // the 2-slot invocation budget. Measured (deep ask -> plan with
      // scopeGlobs -> one out-of-scope unverified edit): step 1 mints
      // verify-gap + scope-watchdog + the scaffold, the scaffold is
      // `budget:dropped` — and the flag was already spent, so steps 2..N never
      // re-offered it. `rendered=0, budgetDrops=1` for the WHOLE turn, six
      // steps running, where the same run renders it at step 2 with the gate
      // removed. B-2 could suppress the scaffold entirely.
      //
      // That inverted the composer's own contract ("the caller must re-detect
      // and re-pass them on a later invocation if still true") and diverged
      // from the two sibling one-shots ~130 lines below, which clear only on
      // `renderResult.renderedFamilies`.
      //
      // `blockedBeforeBudget` IS the sibling rule, read off the composer's own
      // per-render bookkeeping instead of a wiring copy of it: for a cap-1
      // family it is true exactly when the family already RENDERED this turn.
      // Preferring it to a wiring flag also keeps B-2's real find — a flag
      // cleared in `resetTurnState` goes stale on `wiring/gate.ts`'s
      // continuation path, which advances the composer's turn and touches no
      // wiring state — without re-introducing the failure mode B-2 shipped,
      // because cap spend cannot move on anything but a render.
      if (pinStore.get(sid).length === 0 && !composer.blockedBeforeBudget(sid, "intake-scaffold")) {
        findings.push(intakeScaffoldFinding(nextInstanceId(state)))
      }

      // FIX #8: story-completion nudge, set in tool.execute.after when an
      // intermediate story's bound verifier just went green. Ranked right
      // after intake-scaffold (deliberately, not accidentally): it reflects
      // the freshest, most actionable signal this turn produced — the model
      // just watched its own change go green — so it should not be
      // routinely crowded out of the 2-slot invocation budget by the
      // routine pre-commitment reminder.
      const pendingNextStory = storyCompletionPending.get(sid)
      if (pendingNextStory) {
        findings.push(storyCompletionFinding({ instanceId: nextInstanceId(state), nextStory: pendingNextStory }))
      }

      if (state.multiStoryPending && !storyEngine.getPlan(sid)) {
        findings.push(planProposalFinding(nextInstanceId(state)))
      }

      // `precommitmentPending` is re-armed by every RE-ENTRY into execute
      // (T6: elevate -> execute on the next mutation), so a turn that cycles
      // edit -> green verifier -> edit re-mints this finding per cycle while
      // its cap of 1 has been gone since the first render. Measured, 96
      // edit/bash cycles in one turn: 1 rendered, 95 `per-turn-cap:dropped`.
      // The pending flag is still cleared unconditionally below, exactly as
      // before — the skipped mints are the ones the composer was already
      // committed to discarding, so FR-023a's "offered at most once per phase
      // entry" is untouched.
      if (
        state.precommitmentPending &&
        evidenceLedger.hasChangedFiles(sid) &&
        !state.turnExpect &&
        !composer.blockedBeforeBudget(sid, "pre-commitment")
      ) {
        findings.push(precommitmentFinding(nextInstanceId(state)))
      }
      state.precommitmentPending = false // FR-023a: offered at most once per phase entry

      let verifyGapCandidate: { instanceId: string; command: string | null; storyScoped?: boolean } | null = null
      const changedPaths = evidenceLedger.getChangedPaths(sid)
      const hasVerification = evidenceLedger.hasVerification(sid)
      // HANDOVER.md redesign point 7: the per-turn verify-gap nudge fired on
      // EVERY turn with unverified changes regardless of relevance, and in
      // the field session the model simply learned to ignore it (19 identical
      // warnings, never corrected). It now fires only when JUSTIFIED — the
      // resolver can name a concrete command (a story's declared verifiers or
      // a manifest/basename convention), so the nudge says "run X", not
      // "run something relevant". The generic case stays silent here; the
      // idle stop-block (gate.ts's zero-criteria fallback) still catches
      // genuinely unverified work at turn end. The composer cap table's
      // per-turn ceiling is the "capped" half of the redesign point.
      //
      // ...and `blockedBeforeBudget` is what stops this producer re-deriving
      // the nudge once that ceiling is reached. Unverified changes stay
      // unverified across the whole turn, so the condition above is true on
      // EVERY step: measured, one 120-step turn resolved a verifier and minted
      // this finding 120 times for 3 renders (its cap) and 117
      // `per-turn-cap:dropped` — 117 `resolveVerifier` calls and instance ids
      // burned on findings that could not reach the model.
      //
      // This does NOT change when the nudge reaches the model, which matters
      // more here than anywhere else: verify-gap is the one family with
      // measured real-world compliance (9 rendered, 14 complied). The first
      // three renders of a turn are unaffected — the gate only closes once the
      // composer has already spent the family's cap, i.e. only over mints
      // whose `per-turn-cap:dropped` was a foregone conclusion.
      if (evidenceLedger.hasChangedFiles(sid) && !hasVerification && !composer.blockedBeforeBudget(sid, "verify-gap")) {
        const realPaths = changedPaths.filter((p) => !NON_PATH_MUTATION_MARKERS.has(p))
        const manifest = manifests.get(state.workspaceRoot)
        const activeStory = storyEngine.getActiveStory(sid)
        const resolutionResult = resolveVerifier(
          { changedPaths: realPaths, storyVerifiers: activeStory?.verifiers ?? null },
          { readManifest: () => manifest },
        )
        if (resolutionResult.command !== null) {
          const instanceId = nextInstanceId(state)
          verifyGapCandidate = {
            instanceId,
            command: resolutionResult.command,
            storyScoped: resolutionResult.rationale === "story",
          }
          findings.push(
            verifyGapFinding({
              instanceId,
              changedPathsLabel: changedPaths.length ? changedPaths.join(", ") : "files changed",
              resolution: resolutionResult,
            }),
          )
        } else {
          logger("resolution:none", { sessionID: sid, changedPaths: realPaths })
        }
      }

      // Same treatment, same reason: `scopeDriftPending` is re-armed by every
      // out-of-scope mutation, and a turn that keeps editing outside the
      // active story's scope re-mints this on every step against a cap of 1.
      // Measured, same 120-step turn: 1 rendered, 119 `per-turn-cap:dropped`.
      // The pending drift is deliberately NOT cleared when the gate closes —
      // it is cleared only by a render, so the LATEST drift still carries into
      // the next turn and renders there, exactly as it did when each step
      // minted a finding for the composer to throw away.
      if (state.scopeDriftPending && !composer.blockedBeforeBudget(sid, "scope-watchdog")) {
        const drift = state.scopeDriftPending
        findings.push(
          scopeWatchdogFinding({
            instanceId: nextInstanceId(state),
            path: drift.path,
            offer: drift.offer,
            scopeGlobsMatchedZero: drift.scopeGlobsMatchedZero,
          }),
        )
      }

      if (state.anomalyPending) {
        const anomaly = state.anomalyPending
        findings.push(
          anomalyInterruptFinding({
            instanceId: nextInstanceId(state),
            expectText: anomaly.expectText,
            observedSummary: anomaly.observedSummary,
          }),
        )
      }

      // FOUND BY THE SAME MEASUREMENT, not in the reported set: `elevate` has
      // the identical shape and the WORST numbers of the five. `elevatePending`
      // is re-armed by every execute -> elevate transition (T4), i.e. by every
      // passing verifier, and `pinStore.get(sid)` is re-read to build the
      // criteria replay each time. Measured over 96 edit/pass/fail cycles in
      // one turn: 1 rendered, 284 `per-turn-cap:dropped`. Same gate, same
      // guarantee — `elevatePending` is cleared by a render and by nothing
      // else, so a still-pending elevate still renders at the next turn.
      if (state.elevatePending && !composer.blockedBeforeBudget(sid, "elevate")) {
        findings.push(elevateFinding({ instanceId: nextInstanceId(state), criteria: pinStore.get(sid) }))
      }

      if (state.repeatFailurePending) {
        const rf = state.repeatFailurePending
        findings.push({
          family: `repeat-failure:${rf.signature}`,
          priority: "correction",
          observation: `The same class of failure has repeated ${rf.count} times this turn.`,
          diagnosis: "Re-running the same fix without a new hypothesis.",
          prescription: "Stop retrying silently — report what failed, what you already tried, and your next hypothesis.",
          instanceId: nextInstanceId(state),
        })
      }

      // BACKLOG B-1: findings go straight to the holdout filter. There is no
      // per-model dose in between — every session renders the full directive,
      // and the composer's own per-turn caps, cooldowns and compliance decay
      // are what bound the volume.
      const finalFindings = findings.filter((f) => {
        if (holdoutSuppresses(sid, f.family)) {
          logHoldoutSuppress(sid, `${f.family} suppressed (holdout arm=off)`, {
            family: f.family,
            model: state.modelId,
          })
          return false
        }
        return true
      })

      const renderResult = composer.render(sid, finalFindings, { priorCompliance: () => false })

      // FR-059: one toast per rendered directive. Fire-and-forget — `notify`
      // never throws and never rejects (FR-062), and `system.transform` is a
      // hot path that must not wait on a TUI round trip.
      for (const rendered of finalFindings.filter((f) => renderResult.renderedFamilies.includes(f.family))) {
        void visibility.notify("directive", { ...summarizeFinding(rendered), sessionID: sid })
      }

      if (renderResult.renderedFamilies.includes("pinned-criteria-reinject")) state.needsCriteriaReinject = false
      if (renderResult.renderedFamilies.includes("scope-watchdog")) state.scopeDriftPending = null
      if (renderResult.renderedFamilies.includes("anomaly-interrupt")) state.anomalyPending = null
      if (renderResult.renderedFamilies.includes("elevate")) state.elevatePending = false
      if (renderResult.renderedFamilies.includes("story-completion")) storyCompletionPending.delete(sid)
      if (renderResult.renderedFamilies.some((f) => f.startsWith("repeat-failure:"))) state.repeatFailurePending = null
      if (renderResult.renderedFamilies.includes("verify-gap") && verifyGapCandidate?.command) {
        state.renderedVerifyGaps.push({
          instanceId: verifyGapCandidate.instanceId,
          command: verifyGapCandidate.command,
          storyScoped: verifyGapCandidate.storyScoped,
        })
      }

      // FR-061: a family the harness keeps offering that never reaches the
      // model is starvation. The composer owns the accounting (see
      // `STARVATION_BUDGET_DROPS`) and reports each family at most once per
      // turn, so this loop needs no dedupe of its own.
      //
      // THIS REPLACES A DETECTOR THAT COULD NOT FIRE. The previous form counted
      // `rendered + dropped` in ONE invocation and needed `attempted >= 5` with
      // a >=90% drop rate. Measured on the same 78-invocation differential that
      // signed off the producer gating: pre-gate 22 fires with max `attempted`
      // 5; post-gate 0 fires with max `attempted` 4 — permanently one short of
      // its own floor, because every drop it had been counting was a per-turn-cap
      // drop from a producer re-minting a finding the composer was already
      // committed to discarding. It had no test, which is why nothing caught it.
      // A detector that cannot fire but still appears in the health list is
      // worse than none, so the quantity has been re-based rather than the
      // threshold nudged.
      for (const s of renderResult.starved) {
        void visibility.notify("health", {
          sessionID: sid,
          family: "directive:starved",
          message: `${s.family} lost the injection budget ${s.budgetDrops} times this turn and never reached the model`,
          variant: "warning",
        })
      }

      if (renderResult.text) {
        sysOutput.system = [...sysOutput.system, renderResult.text]
      }
    },

    // ── MESSAGES.TRANSFORM: never drains anything (single-queue-consumer invariant) ──
    async "experimental.chat.messages.transform"() {
      /* no-op */
    },

    async "experimental.text.complete"(textInput, textOutput) {
      const sid = textInput.sessionID
      if (isSelf(sid)) return
      const state = states.get(sid)
      if (!state || !state.active) return
      if (!textOutput.text.trim()) return
      state.lastAssistantText = textOutput.text


      const criteriaBlock = parseCriteriaBlock(textOutput.text)
      if (criteriaBlock) {
        pinStore.pin(sid, criteriaBlock.criteria)
        if (criteriaBlock.truncated) {
          logger("criteria:truncated", { sessionID: sid, kept: criteriaBlock.criteria.length })
        }
        pinStore.persist(sid)
        // Pinning criteria IS the intake-scaffold prescription's compliance —
        // it drives the composer's own per-turn decay to the one-line form.
        composer.recordCompliance(sid, "intake-scaffold", "criteria-pinned")
      } else {
        // B-2: the model wrote a CRITERIA: line the grammar could not read.
        //
        // This used to be indistinguishable from never answering at all, and
        // the consequences are not symmetric: nothing gets pinned, so the
        // scaffold's emission gate (`pinStore.get(sid).length === 0`) stays
        // open and re-offers forever, while its compliance signal — pinning —
        // never fires. The field numbers this backlog item started from (9
        // intake-scaffold directives rendered, 0 complied) could not be read
        // as "the model ignored us" precisely because this case was silent.
        // Now it is an event, so the next session's numbers are decidable.
        //
        // ONCE PER TURN, like its sibling `expect:absent` above. `text.complete`
        // fires per assistant TEXT PART, and a model that writes an unreadable
        // `CRITERIA:` line tends to repeat it in every part of the same reply:
        // measured, 12 text parts in one turn -> 12 identical events. The event
        // exists to make "did the model answer the scaffold?" decidable, and
        // one record per turn answers that; twelve only inflate the
        // denominator of every rate computed from this log.
        //
        // FIX 2: "this turn" is the COMPOSER's turn, not a wiring boolean.
        // Both boundaries advance the composer (`chat.message` at the
        // activation branch, and `gate.ts`'s continuation dispatch); only ONE
        // of them calls `resetTurnState`. Keyed on a wiring flag, a
        // continuation turn's parse miss was silently dropped — the exact
        // blind spot this event was introduced to close, reintroduced by its
        // own dedupe guard.
        const keyLine = findCriteriaKeyLine(textOutput.text)
        if (keyLine !== null && composer.claimOncePerTurn(sid, "criteria:parse-miss")) {
          logger("criteria:parse-miss", { sessionID: sid, keyLine: keyLine.slice(0, 200) })
        }
      }

      const expect = parseExpectArtifact(textOutput.text)
      if (expect) state.turnExpect = expect
    },

    async "experimental.session.compacting"(compactionInput) {
      const sid = compactionInput.sessionID
      if (isSelf(sid)) return
      const state = states.get(sid)
      if (state) state.compacting = true
    },

    async event({ event }) {
      if (event.type === "session.compacted") {
        const sid = event.properties.sessionID
        if (isSelf(sid)) return
        const state = states.get(sid)
        if (state) {
          state.compacting = false
          state.needsCriteriaReinject = true
        }
        return
      }
      if (event.type === "file.edited") {
        // DELIBERATELY A NO-OP. This branch has been wrong in both directions.
        //
        // It first required EXACTLY ONE active session, which looked
        // conservative but was permanently false in a long-lived server:
        // `states` is never pruned and `active` clears only on an agent switch,
        // so from the second activated session on, the net never fired again.
        //
        // The fix for that fanned out to "every active session whose workspace
        // contains the file" -- which cannot discriminate at all, because
        // `workspaceRoot` is computed ONCE at plugin construction and handed to
        // every session (`freshSessionState(workspaceRoot)`). Measured: a
        // session that had done nothing received a stop-block for someone
        // else's edit, and `invalidate()` deleted peers' PERSISTED receipts.
        // That inverted the bug rather than fixing it.
        //
        // `file.edited` carries no session id, and one process has one
        // workspace root, so the event is simply not attributable. Guessing
        // either way corrupts evidence. `tool.execute.after` already records
        // changed paths and invalidates receipts per session, from a payload
        // that names its own session -- it was never affected by either bug and
        // covers every edit the tool layer makes. Edits made outside the tool
        // layer are genuinely unattributable and are left to the worktree
        // fingerprint in `goals.ts`.
        return
      }
      // MIN-006: a session that ends, errors, or is aborted is not a pause.
      // The abort case matters most — a user pressing ESC mid-work leaves
      // exactly the shape the judge is trained to call "stopped-mid-work",
      // so without this the harness would restart the work the user just
      // killed. Cancellation is idempotent and safe for unknown sessions.
      if (event.type === "session.deleted" || event.type === "session.error") {
        const endedSid = (event.properties as { sessionID?: unknown } | undefined)?.sessionID
        if (typeof endedSid === "string") {
          cancelPauseJudge(endedSid)
          // `idleDispatch` is keyed by session and was never cleared, so a
          // long-lived process accumulated one entry per session seen.
          forgetIdleTurn(endedSid)
        }
        return
      }
      if (event.type !== "session.idle") return
      const sid = event.properties?.sessionID
      if (typeof sid !== "string" || isSelf(sid)) return
      const state = states.get(sid)
      if (!state || !state.active) return
      if (state.idleContinuationInFlight) return
      await handleSessionIdle(gateCtx, sid)

      // FR-063: drain any pending suppressed-toast roll-up. Without this a
      // burst at the very end of a run is capped and then never reported,
      // which is the failure mode visibility exists to remove.
      await visibility.flush()
    },
  }
}

export default ElicifyVertexPluginV2
