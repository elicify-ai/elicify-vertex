/**
 * Wave-3 wiring — `elicify_vertex_plan_*` tools and their matching
 * `/elicify-vertex-plan-*` slash commands (Ambiguity #6's naming
 * resolution), backed by `StoryEngine` rather than v1's `MultiStoryGoalEngine`.
 * Structure mirrors v1's `elicify_vertex_goal_*` tools in `src/index.ts`.
 *
 * Waiver-provenance enforcement (`story.ts`'s module header, "Dataset row 6
 * of Checkpoint evidence validation" — flagged as high-severity in the wave
 * brief alongside FR-036/CRIT-001): `StoryEngine.checkpoint` only checks that
 * a waiver is STRUCTURALLY well-formed (a non-empty `sourceMessageId`). It
 * explicitly documents that the caller (this file) must independently prove
 * the referenced message id names a real `role: "user"` chat message before
 * ever attaching it as evidence — a waiver id supplied via tool-call
 * arguments is, by construction, something the MODEL wrote, so it can never
 * be trusted on its own. `checkpointTool` below resolves every
 * `waiverSourceMessageId` against `client.session.messages(...)` and REJECTS
 * (throws, does not silently drop) any waiver whose id does not resolve to a
 * `role: "user"` message.
 */
import { resolve } from "node:path"

import { tool } from "@opencode-ai/plugin"
import type { VerificationReceiptStore } from "../../goals.js"
import type { PhaseEngine } from "../phase.js"
import type { PinStore } from "../pin.js"
import type { StoryEngine } from "../story.js"
import type { OpencodeClient } from "../types.js"
import type { V2SessionState } from "./state.js"

export interface PlanToolsDeps {
  storyEngine: StoryEngine
  pinStore: PinStore
  verificationReceipts: VerificationReceiptStore
  client: OpencodeClient
  states: Map<string, V2SessionState>
  /** T8 (FR-001): rebinds phase to `execute` for the next story when a
   * non-final story checkpoints complete. Without this call the phase
   * engine's per-story slot for the newly-active story is never touched
   * until its first mutation, so `getPhase()` reads a stale/default value
   * in the window between checkpoint and that mutation. */
  phaseEngine: PhaseEngine
  /** Runs when a plan is successfully created, so wiring can clear `multiStoryPending`. */
  onPlanCreated: (sessionID: string) => void
}

interface ClientMessage {
  info?: { id?: string; role?: string }
  message?: { id?: string; role?: string }
}

function isFieldsStyle(value: unknown): value is { data?: unknown; error?: unknown } {
  return typeof value === "object" && value !== null && ("data" in value || "error" in value)
}

async function isUserMessage(client: OpencodeClient, sessionID: string, messageID: string): Promise<boolean> {
  try {
    const raw = await client.session.messages({ path: { id: sessionID } } as never)
    const list = isFieldsStyle(raw) ? raw.data : raw
    if (!Array.isArray(list)) return false
    for (const entry of list as ClientMessage[]) {
      const info = entry.info ?? entry.message
      if (info?.id === messageID) return info.role === "user"
    }
    return false
  } catch {
    return false
  }
}

function isValidTimestampString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && Number.isFinite(Date.parse(value))
}

/**
 * v1 parity (`src/goals.ts`'s `MultiStoryGoalEngine.checkpoint`, ~L300-312):
 * a `receiptId` evidence pointer is only as good as the receipt it names
 * still being an OBSERVED, workspace-matching, time-valid verification
 * (FR-020: "workspace-matching, time-valid receipt") — not merely present
 * in the store. Existence alone (this function's previous behaviour)
 * accepts a receipt recorded in a different workspace, one that failed, or
 * one whose timestamp cannot possibly cover this story's work.
 *
 * "Not before story start" is checked defensively: `StoryV2` does not carry
 * a `startedAt` field as of this fix (a sibling wave-4 agent may add one to
 * story.ts concurrently, which this file does not — and must not — depend
 * on). This falls back through a hypothetical `story.createdAt` to
 * `plan.createdAt`, and skips the time bound entirely if none of those
 * resolve to a valid timestamp — it never crashes on a field that may or
 * may not exist, and never skips the workspace/outcome/exitCode checks just
 * because the time bound can't be computed.
 *
 * ------------------------------------------------------------------
 * Reconciliation with PERSISTED receipts (`VerificationReceiptStore` now
 * writes `.elicify-vertex/receipts.json`):
 *
 *  - Hydration. `store.get()`'s two-argument signature carries no workspace
 *    root, so a receipt observed in an EARLIER process is invisible until
 *    the store is told where to read from. The `load()` call below does
 *    that, using the session's own `workspaceRoot`. Without it persistence
 *    would be inert on exactly the path it exists for: resuming tomorrow.
 *  - Staleness. This function does NOT re-implement freshness. `store.get()`
 *    is the single choke point: it recomputes the receipt's worktree
 *    fingerprint and returns `null` when anything under the worktree changed
 *    since the verification was observed. So "legitimately still valid from
 *    an earlier process" is accepted here through the ordinary `!receipt`
 *    branch, and "stale" is refused through the same branch — no second,
 *    drift-prone copy of the rule lives here.
 *  - Plan link. The product requirement is that a verification is linked to
 *    the story it verifies and that each story is validated once. A receipt
 *    minted while story S1 was active is evidence for S1; reusing it to
 *    close S2 is precisely the coincidence-of-timing loophole this closes.
 *    Hence: with a plan present, the receipt's `scope.storyId` must equal
 *    the story being checkpointed. With no plan the store records
 *    `scope.storyId: null` and this check is vacuous, which is the
 *    supported "executions with no plan" path.
 * ------------------------------------------------------------------
 */
function isFreshReceipt(
  deps: Pick<PlanToolsDeps, "verificationReceipts" | "states" | "storyEngine">,
  sessionID: string,
  storyId: string,
  receiptId: string,
): boolean {
  const state = deps.states.get(sessionID)
  // Make receipts persisted by an earlier process visible before looking one
  // up. Idempotent and non-throwing (see `VerificationReceiptStore.load`).
  if (state) deps.verificationReceipts.load(sessionID, state.workspaceRoot)

  // `get()` enforces staleness itself and returns null for a retired receipt.
  const receipt = deps.verificationReceipts.get(sessionID, receiptId)
  if (!receipt) return false
  if (receipt.outcome !== "verified" || receipt.exitCode !== 0) return false

  if (state && resolve(receipt.workspaceRoot) !== resolve(state.workspaceRoot)) return false

  const now = new Date().toISOString()
  if (receipt.observedAt > now) return false

  const plan = deps.storyEngine.getPlan(sessionID)
  if (plan && (receipt.scope?.storyId ?? null) !== storyId) return false

  const story = plan?.stories.find((s) => s.id === storyId)
  const storyStart =
    (story as Record<string, unknown> | undefined)?.startedAt ??
    (story as Record<string, unknown> | undefined)?.createdAt ??
    plan?.createdAt
  if (isValidTimestampString(storyStart) && receipt.observedAt < storyStart) return false

  return true
}

export function buildPlanTools(deps: PlanToolsDeps) {
  const { storyEngine, pinStore, verificationReceipts, client, states, phaseEngine } = deps

  const createTool = tool({
    description:
      "Create the elicify-vertex v2 story-contract plan under <project>/.elicify-vertex/plan.json. " +
      "Call only after the user has confirmed a proposed plan. Pass the confirmed stories.",
    args: {
      stories: tool.schema
        .array(
          tool.schema.object({
            text: tool.schema.string().min(1),
            acceptanceItems: tool.schema.array(tool.schema.string().min(1)).min(1),
            scopeGlobs: tool.schema.array(tool.schema.string()).optional().default([]),
            verifiers: tool.schema.array(tool.schema.string()).optional().default([]),
          }),
        )
        .min(1),
    },
    async execute(args, context) {
      const plan = storyEngine.createPlan(context.sessionID, args.stories)
      deps.onPlanCreated(context.sessionID)
      return JSON.stringify(plan, null, 2)
    },
  })

  const nextTool = tool({
    description: "Return the active story in the elicify-vertex v2 plan. Work only that story until checkpointed.",
    args: {},
    async execute(_args, context) {
      const story = storyEngine.getActiveStory(context.sessionID)
      return JSON.stringify(story, null, 2)
    },
  })

  const checkpointTool = tool({
    description:
      "Checkpoint a story in the elicify-vertex v2 plan (complete|failed|blocked). " +
      "For status=complete, every acceptance item needs evidence: either a verificationReceiptId observed " +
      "earlier in this session, or a waiverSourceMessageId naming a real user chat message that explicitly waived it.",
    args: {
      storyId: tool.schema.string().min(1),
      status: tool.schema.enum(["complete", "failed", "blocked"]),
      items: tool.schema
        .array(
          tool.schema.object({
            id: tool.schema.string().min(1),
            receiptId: tool.schema.string().optional(),
            waiverSourceMessageId: tool.schema.string().optional(),
          }),
        )
        .optional()
        .default([]),
    },
    async execute(args, context) {
      for (const item of args.items) {
        if (item.receiptId) {
          storyEngine.attachEvidence(context.sessionID, args.storyId, item.id, { receiptId: item.receiptId })
        } else if (item.waiverSourceMessageId) {
          const verified = await isUserMessage(client, context.sessionID, item.waiverSourceMessageId)
          if (!verified) {
            throw new Error(
              `waiver for acceptance item ${item.id} references message ${item.waiverSourceMessageId}, which does not resolve to a user-authored chat message — rejected`,
            )
          }
          storyEngine.attachEvidence(context.sessionID, args.storyId, item.id, {
            waiver: true,
            sourceMessageId: item.waiverSourceMessageId,
          })
        }
      }
      storyEngine.checkpoint(context.sessionID, args.storyId, args.status, {
        isValidReceipt: (receiptId) =>
          isFreshReceipt({ verificationReceipts, states, storyEngine }, context.sessionID, args.storyId, receiptId),
      })
      const plan = storyEngine.getPlan(context.sessionID)
      // T8 (FR-001): a non-final story completing rebinds phase to `execute`
      // for the newly-active successor story. `storyEngine.checkpoint` above
      // already promoted the next "pending" story to "active" internally;
      // if a different story is now active, that's the T8 arc.
      if (args.status === "complete") {
        const nowActive = storyEngine.getActiveStory(context.sessionID)
        if (nowActive && nowActive.id !== args.storyId) {
          phaseEngine.onStoryAdvance(context.sessionID, args.storyId, nowActive.id)
        }
      }
      return JSON.stringify(plan, null, 2)
    },
  })

  const statusTool = tool({
    description: "Read the elicify-vertex v2 story-contract plan for the current session (null if none).",
    args: {},
    async execute(_args, context) {
      return JSON.stringify(storyEngine.getPlan(context.sessionID), null, 2)
    },
  })

  const clearTool = tool({
    description:
      "Abandon the current elicify-vertex v2 plan and pinned criteria for this session. Reversible (the plan " +
      "is archived under .elicify-vertex/archive/, never deleted) but not something to reach for to dodge an " +
      "inconvenient checkpoint — only call this on an explicit user request to reset or abandon the plan.",
    args: {},
    async execute(_args, context) {
      const planCleared = storyEngine.clearPlan(context.sessionID)
      const pinsCleared = pinStore.clearPins(context.sessionID)
      return JSON.stringify({ planCleared, pinsCleared }, null, 2)
    },
  })

  return {
    elicify_vertex_plan_create: createTool,
    elicify_vertex_plan_next: nextTool,
    elicify_vertex_plan_checkpoint: checkpointTool,
    elicify_vertex_plan_status: statusTool,
    elicify_vertex_plan_clear: clearTool,
  }
}

/**
 * Only ONE slash command besides `/elicify-vertex` itself: the plan is
 * created/advanced/checkpointed by the model calling `elicify_vertex_plan_*`
 * tools directly as the harness's directives prompt it to — those steps are
 * driven by the LLM's own tool use, not a human typing a command. `clear` is
 * the exception: abandoning a plan is a human-facing decision (an escape
 * hatch), so it gets an explicit, discoverable slash command as well as the
 * tool itself.
 */
export function planSlashCommands(): Record<string, { description: string; template: string }> {
  return {
    "elicify-vertex-plan-clear": {
      description: "Abandon the current elicify-vertex v2 plan and pinned criteria for this session.",
      template: `Call elicify_vertex_plan_clear to abandon the current plan and pinned criteria for this session. Confirm what was cleared (or that there was nothing to clear).

$ARGUMENTS`,
    },
    // FR-064. The template body is deliberately inert: the mode change is
    // performed by `command.execute.before` in plugin.ts intercepting this
    // command name, because a slash command is only a prompt template and
    // cannot call plugin code itself.
    "elicify-vertex-visibility": {
      description: "Cycle elicify-vertex notification visibility (all -> off -> gates -> all).",
      template: `The elicify-vertex visibility mode has been cycled by the harness. Briefly tell the user the new mode and what it means:
- "all"   — toast on every rendered directive, gate fire and health signal
- "gates" — toast only on gate fires and health signals
- "off"   — no toasts (injection into the model's context is unchanged either way)

$ARGUMENTS`,
    },
  }
}
