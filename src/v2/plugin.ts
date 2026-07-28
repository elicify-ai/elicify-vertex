/**
 * elicify-vertex v2 — phase-aware guidance harness plugin entry.
 * --------------------------------------------------------------------------
 * Wires the ten `src/v2/*` modules (phase.ts, pin.ts, story.ts, composer.ts,
 * resolve.ts, dosing.ts, artifacts.ts, subturn.ts, judge.ts) plus the
 * `src/v2/wiring/*` support modules into the OpenCode `Hooks` surface, per
 * `docs/vertex2-spec.md`'s "Relevant Execution Flows" table and Functional
 * Requirements.
 *
 * `src/index.ts` is FROZEN — imported for its reusable v1 primitives
 * (`EvidenceLedger`/`shouldBlockStop`, `parseVerification`,
 * `isMutatingBashCommand` (indirectly, via `changedPathsFromTool`),
 * `changedPathsFromTool`, `formatChangedPathsForReason`,
 * `formatGateContinuationText`, `formatActivateCue`, `classifyStopMode`,
 * `failureSignature`) — never edited, never reimplemented.
 *
 * FR-036 (self-created-session inertness) is enforced at the top of EVERY
 * hook via `selfCreated.isSelfCreated(sessionID, selfCreatedGuard.resolveParent)`.
 */
import { execFileSync } from "node:child_process"
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

import { compareExpectation, parseCriteriaBlock, parseExpectArtifact } from "./artifacts.js"
import { isNonExecutingCommand, observedCoversPrescribed } from "./coverage.js"
import { VisibilityNotifier, resolveVisibilityMode, summarizeFinding } from "./visibility.js"
import { InjectionComposer, type Finding } from "./composer.js"
import { resolveProfile, type Profile } from "./dosing.js"
import { PhaseEngine } from "./phase.js"
import { PinStore } from "./pin.js"
import { resolveVerifier } from "./resolve.js"
import { classifyMultiStory, StoryEngine, type StoryV2 } from "./story.js"
import { SelfCreatedSessions } from "./subturn.js"
import type { OpencodeClient } from "./types.js"

import { applyV2Config } from "./wiring/config.js"
import { applyDosing } from "./wiring/dosing.js"
import { GateContext, handleSessionIdle } from "./wiring/gate.js"
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
import { buildPlanTools } from "./wiring/tools.js"

export interface ElicifyVertexV2Options {
  readonly activeAgent?: string
  readonly activeSkillTrigger?: string
  readonly maxCriteriaBlocks?: number
  readonly intakeSubturnMax?: number
  readonly judgeModel?: string
  readonly dosingOverrides?: Record<string, Profile>
  readonly familyCaps?: Record<string, number>
  readonly cooldowns?: Record<string, number>
  /** FR-057: `"off" | "gates" | "all"`, default `"all"`. `VERTEX_VISIBLE=0` forces `"off"`. */
  readonly visibility?: string
  /** FR-063 toast rate cap per minute (default 6). */
  readonly maxToastsPerMinute?: number
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

const NON_PATH_MUTATION_MARKERS = new Set(["edit-mutation", "patch-mutation", "bash-mutation"])
const TEST_PATH_RE = /\.(?:test|spec)\.[^./]+$/
const TEST_DIR_RE = /(^|\/)tests?\//

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
 * FIX #1 (review CRITICAL — "judge subsystem is unreachable"): `getActiveStory`
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
 * FIX #7 (judge payload richness): a bounded `git diff --stat` for the
 * currently changed paths, invoked at judge-invocation time only
 * (`session.idle`, which FR-009 does NOT list among the prohibited hot
 * paths — only `tool.execute.after`/`system.transform` are). Never throws:
 * a missing `git` binary, a non-repo `cwd`, or a timeout all degrade to the
 * empty string so the caller can fall back to the old changed-paths label.
 *
 * This is a `--stat` summary, not full hunks — a size-capped full `git diff`
 * for the changed paths is a reasonable follow-up if the judge needs more
 * than file-level shape, but is not implemented here (documented in the
 * final report, not silently claimed as solved).
 */
const DIFF_STAT_TIMEOUT_MS = 2000
const DIFF_STAT_MAX_CHARS = 4000

function computeBoundedDiffStat(cwd: string, changedPaths: readonly string[]): string {
  const realPaths = changedPaths.filter((p) => !NON_PATH_MUTATION_MARKERS.has(p))
  try {
    const args = realPaths.length > 0 ? ["diff", "--stat", "--", ...realPaths] : ["diff", "--stat"]
    const out = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: DIFF_STAT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    })
    const trimmed = out.trim()
    if (trimmed.length === 0) return ""
    return trimmed.length > DIFF_STAT_MAX_CHARS ? `${trimmed.slice(0, DIFF_STAT_MAX_CHARS)}\n… (truncated)` : trimmed
  } catch {
    return ""
  }
}

/**
 * FIX #5 (review MAJOR — "SelfCreatedGuard is never populated"): `runSubturn`
 * (`subturn.ts`) already calls `SelfCreatedSessions.record(childID,
 * parentID)` on the SAME shared instance this plugin passes to both
 * `classifyMultiStory` (intake) and, via `GateContext.selfCreated`,
 * `runJudge` (judge, `wiring/gate.ts`) — but neither `subturn.ts` nor
 * `story.ts`/`judge.ts` ever surfaces the created child session id back to
 * the caller (`ClassifyResult`/`SubturnResult` carry no session id field,
 * and `runSubturn`'s own `finally` block has already deleted the child
 * session by the time its promise resolves), so there is no id available at
 * any call site AFTER a subturn call returns to forward into
 * `SelfCreatedGuard.record` — attempting one would mean guessing an id we
 * were never given. Subclassing `SelfCreatedSessions` and mirroring its own
 * `record()` call into the guard is the one seam available without editing
 * subturn.ts/story.ts/judge.ts (none owned by this fix): it captures the
 * REAL child/parent ids at the exact moment `runSubturn` records them,
 * exactly matching `wiring/state.ts`'s own doc comment for `SelfCreatedGuard`
 * ("populated at the moment wiring records a subturn"). Because `plugin.ts`
 * constructs ONE `selfCreated` instance shared by both the intake subturn
 * (this file) and the judge subturn (`wiring/gate.ts`, sibling-owned), this
 * also happens to close the equivalent gap at the judge call site as a
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
  const userOpts = (options ?? {}) as ElicifyVertexV2Options

  const opts = {
    activeAgent: userOpts.activeAgent ?? "elicify-vertex-agent",
    activeSkillTrigger: userOpts.activeSkillTrigger ?? "/elicify-vertex",
    maxCriteriaBlocks: userOpts.maxCriteriaBlocks ?? 3,
    intakeSubturnMax: Number(process.env.VERTEX_INTAKE_SUBTURN_MAX) || userOpts.intakeSubturnMax || 3,
    judgeModel: userOpts.judgeModel,
    dosingOverrides: userOpts.dosingOverrides,
    familyCaps: userOpts.familyCaps,
    cooldowns: userOpts.cooldowns,
    visibility: userOpts.visibility,
    maxToastsPerMinute: userOpts.maxToastsPerMinute,
  }
  const activateCommandName = opts.activeSkillTrigger.replace(/^\//, "")

  const workspaceRoot = (() => {
    try {
      return resolveGoalWorkspaceRoot([input.worktree, input.directory, process.cwd()])
    } catch {
      return process.cwd()
    }
  })()
  const stateDir = `${workspaceRoot}/${PLUGIN_STATE_DIR}`

  // -- Shared long-lived components -----------------------------------------
  const states = new Map<string, V2SessionState>()
  const getContext = (sessionID: string | undefined) => {
    const state = sessionID ? states.get(sessionID) : undefined
    return { model: state?.modelId ?? null, profile: state?.profile ?? ("standard" as Profile) }
  }
  const logger = createSharedV2Logger(getContext)

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
  const commandActivatedSessions = new Set<string>()
  // FIX #7: most recent verifier command's real output text per session
  // (bounded), for the judge payload's verifierSummaries — not part of
  // V2SessionState (wiring/state.ts is not owned by this fix), kept here
  // instead as plugin-local per-session bookkeeping (same pattern as
  // commandActivatedSessions above).
  const lastVerifierOutputBySession = new Map<string, string>()
  // FIX #8: pending "story completion" nudge — set when an intermediate
  // (non-final) story's bound verifier goes green, cleared once rendered or
  // at the next chat.message turn boundary. Also not part of V2SessionState
  // for the same reason.
  const storyCompletionPending = new Map<string, StoryV2>()

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
    // FR-030 was opt-in (VERTEX_JUDGE=1); flipped to opt-out per operator
    // request — the judge now runs by default at every final-story
    // checkpoint, disabled only by explicit VERTEX_JUDGE=0. It remains
    // strictly advisory/non-gating (FR-030) and fails open via the FR-030b
    // capability probe regardless of this flag.
    judgeEnabled: process.env.VERTEX_JUDGE !== "0",
    judgeModelOverride: parseModelRef(opts.judgeModel ?? null) ?? undefined,
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
    // back to the old comma-joined path list when git is unavailable, the
    // worktree isn't a repo, or the diff is empty.
    diffSummary: (sessionID) => {
      const state = states.get(sessionID)
      const cwd = state?.workspaceRoot ?? workspaceRoot
      const changedPaths = evidenceLedger.getChangedPaths(sessionID)
      const stat = computeBoundedDiffStat(cwd, changedPaths)
      return stat || formatChangedPathsSummary(changedPaths)
    },
    composer,
    visibility,
  }

  function formatChangedPathsSummary(paths: readonly string[]): string {
    return paths.length === 0 ? "no changed paths recorded" : paths.join(", ")
  }

  const planTools = buildPlanTools({
    storyEngine,
    pinStore,
    verificationReceipts,
    client,
    states,
    phaseEngine,
    onPlanCreated: (sessionID) => {
      const state = states.get(sessionID)
      if (!state) return
      state.multiStoryPending = false
      // FR-029 "frontier" nudge-after-compliance dose: confirming the plan
      // IS the plan-proposal prescription's compliance.
      composer.recordCompliance(sessionID, "plan-proposal", "plan-created")
      state.compliedFamiliesEver.add("plan-proposal")
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

      if (msgInput.model) {
        const modelId = `${msgInput.model.providerID}/${msgInput.model.modelID}`
        state.modelId = modelId
        const resolution = resolveProfile(modelId, opts.dosingOverrides)
        state.profile = resolution.profile
        // Resolving the profile is a pure computation and always safe, but the
        // LOG is a side effect: it creates `.vertex-events.jsonl` in the data
        // dir. Emitting it before the activation check meant a session that
        // never activates the harness still left a trace on disk — UAT G1
        // (no --agent, no trigger) caught exactly that. The sibling call site
        // in `system.transform` is already behind `state.active`; this one now
        // matches. On the activating message `state.active` is still false
        // here (activation is decided further down), so the first log simply
        // comes from `system.transform`, which runs before the model call.
        if (resolution.unknown && state.active) {
          logger("dosing:unknown-model", { sessionID: sid, rawModelId: resolution.rawModelId })
        }
      }

      if (state.idleContinuationInFlight) {
        // v1's `gateContinuationSessions` pattern: the reentrant chat.message
        // caused by our own session.prompt continuation must not reset the
        // turn — ledger/phase/pins all stay exactly as they were.
        state.active = true
        return
      }

      const text = (output.parts || [])
        .filter((p) => p && p.type === "text" && typeof (p as { text?: unknown }).text === "string")
        .map((p) => (p as { text: string }).text)
        .join("\n")

      const triggerEscaped = opts.activeSkillTrigger.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      const triggerRe = new RegExp(`^\\s*${triggerEscaped}\\b`, "m")
      const activatedByTrigger = triggerRe.test(text)
      const activatedByAgent = msgInput.agent === opts.activeAgent
      const activatedByCommand = commandActivatedSessions.has(sid)

      if (activatedByAgent || activatedByTrigger || activatedByCommand) {
        const wasClose = phaseEngine.getPhase(sid) === "close"
        state.active = true
        phaseEngine.onUserMessage(sid)
        composer.newTurn(sid)
        resetTurnState(state)
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
      } else if (msgInput.agent !== undefined && msgInput.agent !== opts.activeAgent) {
        state.active = false
        state.activateCueShown = false
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
      const sid = toolInput.sessionID
      if (isSelf(sid)) return
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
          if (TEST_PATH_RE.test(p) || TEST_DIR_RE.test(p)) state.turnIntroducedNewTestFile = true
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
          void visibility.notify("health", {
            sessionID: sid,
            family: "verify:ambiguous-exit",
            message:
              `"${command.slice(0, 80)}" looks like a verifier but its exit code is not reliable ` +
              `(usually ';' chaining) — no receipt minted. Run the verifier as a standalone command.`,
            variant: "warning",
          })
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
          const storyVerifiers = storyForResolve?.verifiers ?? null

          // The prescription to compare against. Previously this whole check
          // was gated on `realChangedPaths.length > 0`, which left a hole a
          // review proved end to end: with no mutation observed yet this
          // turn, ANY passing command minted a receipt — `npx eslint .`
          // satisfied a story whose verifier was `go test ./internal/...`.
          // `resolveVerifier` returns tier "none" for an empty path set
          // before it ever consults `storyVerifiers`, so when there are no
          // changed paths we fall back to the story's own declared verifiers,
          // which are a prescription in their own right.
          let prescribed: string | null = null
          if (realChangedPaths.length > 0) {
            const manifest = manifests.get(state.workspaceRoot)
            prescribed = resolveVerifier(
              { changedPaths: realChangedPaths, storyVerifiers },
              { readManifest: () => manifest },
            ).command
          } else if (storyVerifiers && storyVerifiers.length > 0) {
            prescribed = storyVerifiers.join(" && ")
          }

          if (prescribed && !observedCoversPrescribed(prescribed, command)) {
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
        // not suppress verify-gap, attach evidence, drive elevate, or count
        // as a story going green. EXPECT/anomaly/failure-classification
        // below intentionally use `rawSuccess` instead — whether the
        // OBSERVED COMMAND itself passed or failed is a different question
        // than whether it covers the right paths, and EXPECT is about the
        // former.
        const success = rawSuccess && !relevanceGap
        if (exitCode !== undefined) {
          evidenceLedger.recordVerification(sid, command, exitCode, success ? verification.outcome : "failed")
        }
        if (success) state.everVerifiedThisTurn = true

        // FIX #7: keep the most recent verifier command's real output text
        // (bounded) for the judge payload — see gateCtx.recentVerifierSummaries.
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
            void visibility.notify("health", {
              sessionID: sid,
              family: "receipt:scope-unverifiable",
              message:
                `verifier passed, but this worktree is too large to fingerprint ` +
                `(${receipt.scope.fileCount} files), so no citable receipt was issued. ` +
                `Checkpoint with a waiver, or narrow the workspace.`,
              variant: "warning",
            })
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
          const firstUnevidenced = pinStore.get(sid).find((c) => !c.evidence)
          if (firstUnevidenced) pinStore.attachEvidence(sid, firstUnevidenced.id, { receiptId: receipt.id })
          pinStore.persist(sid)
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
        } else if (!state.expectAbsentLoggedThisTurn) {
          logger("expect:absent", { sessionID: sid })
          state.expectAbsentLoggedThisTurn = true
        }

        // FR-034 compliance join
        for (const rendered of state.renderedVerifyGaps) {
          if (observedCoversPrescribed(rendered.command, command)) {
            composer.recordCompliance(sid, "verify-gap", rendered.instanceId)
            state.compliedFamiliesEver.add("verify-gap")
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

      const modelId = `${sysInput.model.providerID}/${sysInput.model.id}`
      state.modelId = modelId
      const resolution = resolveProfile(modelId, opts.dosingOverrides)
      state.profile = resolution.profile
      if (resolution.unknown) logger("dosing:unknown-model", { sessionID: sid, rawModelId: resolution.rawModelId })

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

      const mode = evidenceLedger.getMode(sid) ?? "normal"
      if (mode !== "quick" && pinStore.get(sid).length === 0) {
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

      if (state.precommitmentPending && evidenceLedger.hasChangedFiles(sid) && !state.turnExpect) {
        findings.push(precommitmentFinding(nextInstanceId(state)))
      }
      state.precommitmentPending = false // FR-023a: offered at most once per phase entry

      let verifyGapCandidate: { instanceId: string; command: string | null } | null = null
      const changedPaths = evidenceLedger.getChangedPaths(sid)
      const hasVerification = evidenceLedger.hasVerification(sid)
      if (mode !== "quick" && evidenceLedger.hasChangedFiles(sid) && !hasVerification) {
        const realPaths = changedPaths.filter((p) => !NON_PATH_MUTATION_MARKERS.has(p))
        const manifest = manifests.get(state.workspaceRoot)
        const activeStory = storyEngine.getActiveStory(sid)
        const resolutionResult = resolveVerifier(
          { changedPaths: realPaths, storyVerifiers: activeStory?.verifiers ?? null },
          { readManifest: () => manifest },
        )
        if (resolutionResult.rationale === "none") {
          logger("resolution:none", { sessionID: sid, changedPaths: realPaths })
        }
        const instanceId = nextInstanceId(state)
        verifyGapCandidate = { instanceId, command: resolutionResult.command }
        findings.push(
          verifyGapFinding({
            instanceId,
            changedPathsLabel: changedPaths.length ? changedPaths.join(", ") : "files changed",
            resolution: resolutionResult,
          }),
        )
      }

      if (state.scopeDriftPending) {
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

      if (state.elevatePending) {
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

      const dosed = findings
        .map((f) => applyDosing(f, state.profile, state))
        .filter((f): f is Finding => f !== null)

      const finalFindings = dosed.filter((f) => {
        if (holdoutSuppresses(sid, f.family)) {
          logHoldoutSuppress(sid, `${f.family} suppressed (holdout arm=off)`, {
            family: f.family,
            model: state.modelId,
            profile: state.profile,
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
        state.renderedVerifyGaps.push({ instanceId: verifyGapCandidate.instanceId, command: verifyGapCandidate.command })
      }

      // FR-061: a turn in which nearly every directive was dropped means the
      // model is being starved of guidance. `renderResult.dropped` already
      // carries the data; it was only ever going to the JSONL sink.
      {
        const attempted = renderResult.renderedFamilies.length + renderResult.dropped.length
        if (attempted >= 5 && renderResult.renderedFamilies.length / attempted <= 0.1) {
          void visibility.notify("health", {
            sessionID: sid,
            family: "directive:starved",
            message: `${renderResult.dropped.length} of ${attempted} directives dropped this turn — the model is getting almost no guidance`,
            variant: "warning",
          })
        }
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
        // FR-029 "frontier" nudge-after-compliance dose (wiring/dosing.ts):
        // pinning criteria IS the intake-scaffold prescription's compliance.
        composer.recordCompliance(sid, "intake-scaffold", "criteria-pinned")
        state.compliedFamiliesEver.add("intake-scaffold")
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
