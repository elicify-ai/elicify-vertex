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
import { signWaiver } from "../../goals.js"
import type { VerificationReceiptStore } from "../../goals.js"
import type { PhaseEngine } from "../phase.js"
import type { PinStore } from "../pin.js"
import type { PlanV2, StoryEngine } from "../story.js"
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
 * writes `.opencode/elicify-vertex/receipts.json`):
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

// ---------------------------------------------------------------------------
// The reflective planning challenge (docs/REQUIREMENTS-CLARIFICATION-BEFORE-PLAN.md)
// ---------------------------------------------------------------------------
/**
 * `elicify_vertex_plan_create`'s return text puts a reflective challenge in
 * front of the model while the plan is still fresh and cheap to change
 * (AC-1..AC-4). It is a CHALLENGE, not a gate. Two other designs were
 * considered and rejected first, and neither should be re-invented here:
 *
 *  - A `clarifiedWith` / `openUnknowns` field on the plan schema — rejected
 *    because it duplicates, as an unverifiable MODEL-authored copy, data the
 *    HOST already records trustworthily in `opencode.db` (the real `question`
 *    tool parts and the user's real answers). A populated field *looks*
 *    clarified whether or not it is: exactly the pattern that signed receipts
 *    and signed waivers exist to eliminate. Hence AC-5 — nothing here is
 *    written to `plan.json`, and this challenge asks the model for nothing
 *    that gets recorded as evidence.
 *  - Refusing the plan when the `question` tool has not been called —
 *    rejected because it measures a proxy. The model may legitimately have
 *    clarified in conversation without the tool, or (the case that matters)
 *    may need to clarify and not realise it. Tool usage catches neither.
 *
 * So the plan is ALWAYS created (AC-3): nothing below can refuse, and nothing
 * below can deadlock a headless `opencode run` or CI where no one can answer.
 *
 * Delivery: the challenge rides in the tool's return JSON as its FIRST key,
 * `planningChallenge`, ahead of the plan body — not as loose prose appended
 * after the JSON, because callers `JSON.parse` this tool's return value
 * (`scripts/uat-harness.mjs` and three v2 integration test files), and a
 * trailing prose block would break every one of them.
 */

/**
 * AC-2/AC-4's mechanical question: which acceptance items are too vague to
 * be worth anything as a contract?
 *
 * The heuristic is deliberately cheap and deliberately UNDER-eager. A
 * challenge that fires identically on trivial work becomes wallpaper, so a
 * false positive costs more here than a false negative. An item counts as
 * vague only when it carries no verifiable anchor AND is either too short to
 * state a condition or leans on a subjective quality word:
 *
 *  - ANCHOR — a digit, a quoted/backticked fragment, or a path/call/flag
 *    shaped token (`/`, `.ts`, `foo()`, `--flag`). These are the things a
 *    verifier command can actually be pointed at, so their presence alone
 *    exempts the item.
 *  - SHORT — fewer than `MIN_CONCRETE_WORDS` words: not enough room to say
 *    what would count as done ("done", "it works", "tests pass").
 *  - SUBJECTIVE — "works", "properly", "clean", "robust", "intuitive": a
 *    quality claim with no stated measurement.
 *
 * Cannot throw: it is pure string work over values `StoryEngine.createPlan`
 * already validated as non-blank strings, it type-guards anyway, and every
 * regex is short and linear (no nested quantifiers, so no backtracking
 * blowup). `buildPlanningChallenge`'s caller additionally wraps the whole
 * build in a try/catch, so a bug here can never fail a plan creation.
 */
const MIN_CONCRETE_WORDS = 5
const VERIFIABLE_ANCHOR = /[0-9]|`[^`]+`|"[^"]+"|'[^']+'|\/|\.[A-Za-z]{2,4}\b|\w\(\)|--[A-Za-z]/
const SUBJECTIVE_QUALITY =
  /\b(works?|working|properly|correct|correctly|good|nice|clean|robust|solid|polished|mature|modern|intuitive|seamless|user-friendly|better|improved|appropriate|reasonable|sensible|handled|expected|etc)\b/i

function isVagueAcceptanceItem(text: unknown): boolean {
  if (typeof text !== "string") return true
  const trimmed = text.trim()
  if (trimmed === "") return true
  if (VERIFIABLE_ANCHOR.test(trimmed)) return false
  return trimmed.split(/\s+/).length < MIN_CONCRETE_WORDS || SUBJECTIVE_QUALITY.test(trimmed)
}

/** Keep the challenge readable on a 20-story plan: name the worst few. */
const MAX_STORIES_LISTED = 4
const MAX_ITEMS_LISTED = 3

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`
}

/**
 * Returns the challenge as an array of lines (renders one-per-line under
 * `JSON.stringify(..., 2)`, where a single `\n`-joined string would render as
 * one unreadable escaped blob).
 *
 * Proportionality (AC-4): a single-story plan whose acceptance items are all
 * concrete gets the two-line short form — no remedy list, no headline — so
 * one-shot work is not taxed. Everything else gets the full challenge.
 */
function buildPlanningChallenge(plan: PlanV2): string[] {
  const stories = Array.isArray(plan.stories) ? plan.stories : []
  const flagged = stories
    .map((story) => ({
      story,
      vague: (Array.isArray(story.acceptanceItems) ? story.acceptanceItems : []).filter((item) =>
        isVagueAcceptanceItem(item?.text),
      ),
    }))
    .filter((entry) => entry.vague.length > 0)

  if (stories.length <= 1 && flagged.length === 0) {
    return [
      "Grounding check (short form: one story, acceptance items that state what would prove them).",
      "Was this grounded in research and in what the user actually said, or guessed? If any decision here " +
        "forks the design and you assumed the answer, ask the user via the question tool before writing code.",
    ]
  }

  const totalItems = stories.reduce(
    (sum, story) => sum + (Array.isArray(story.acceptanceItems) ? story.acceptanceItems.length : 0),
    0,
  )
  const vagueCount = flagged.reduce((sum, entry) => sum + entry.vague.length, 0)

  const lines: string[] = [
    "Before you act on this plan — was it grounded, or guessed?",
    "- Did you ground it in research and user interview?",
    "- Have you eliminated the unknowns as far as possible?",
    // AC-2: specific to THIS plan, so it cannot read as boilerplate.
    `This plan: ${stories.length} ${stories.length === 1 ? "story" : "stories"}, ${totalItems} acceptance ` +
      `${totalItems === 1 ? "item" : "items"}, ${vagueCount} of which do not say what would prove them.`,
  ]

  if (flagged.length > 0) {
    lines.push("Acceptance items with nothing verifiable in them — these are where a guess hides:")
    for (const entry of flagged.slice(0, MAX_STORIES_LISTED)) {
      const quoted = entry.vague
        .slice(0, MAX_ITEMS_LISTED)
        .map((item) => `"${truncate(String(item?.text ?? ""), 60)}"`)
        .join(", ")
      const more = entry.vague.length > MAX_ITEMS_LISTED ? `, +${entry.vague.length - MAX_ITEMS_LISTED} more` : ""
      lines.push(`  ${entry.story.id} (${truncate(String(entry.story.text ?? ""), 60)}): ${quoted}${more}`)
    }
    if (flagged.length > MAX_STORIES_LISTED) {
      lines.push(`  …and ${flagged.length - MAX_STORIES_LISTED} further stories with vague acceptance items.`)
    }
  }

  // AC-2b. Naming the remedy is load-bearing, not politeness: an open question
  // with no stated escape route defaults to "yes, I grounded it" — the cheapest
  // answer, which changes nothing. Naming the exact tool calls makes the
  // expensive answer available and legitimate.
  lines.push(
    "If material questions remain, do ONE of these now, before writing any code:",
    "1. Ask the user — call the question tool for the decisions that fork the architecture (scope, surface, " +
      "data model). Cheaper now than after four stories are built on a guess.",
    "2. Research it — read the code, the docs and the existing conventions, and resolve what can be resolved " +
      "without asking.",
    // Verified against src/v2/story.ts as of 57dcc3f: `clearPlan` archives to
    // archive/plan.<session>.<ts>.json before dropping the session's entry, and
    // `createPlan` archives any existing plan before replacing it. Say so, or
    // the model reads re-planning as destructive and avoids it.
    "3. Clear and re-plan — if the stories encode assumptions rather than findings, call " +
      "elicify_vertex_plan_clear, ground the work, then elicify_vertex_plan_create again. The old plan is " +
      "ARCHIVED under .opencode/elicify-vertex/archive/, never deleted, so re-planning costs a tool call and " +
      "loses nothing.",
    "Proceeding is also a valid answer — but only if you can say what the plan is grounded IN.",
  )
  return lines
}

export function buildPlanTools(deps: PlanToolsDeps) {
  const { storyEngine, pinStore, verificationReceipts, client, states, phaseEngine } = deps

  const createTool = tool({
    description:
      "Create the elicify-vertex v2 story-contract plan under <project>/.opencode/elicify-vertex/plan.json. " +
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
      // AC-3: the challenge is additive and never fatal. If building it ever
      // throws, the plan that was just persisted is still returned intact —
      // a reflection prompt must not be able to fail a plan creation.
      let planningChallenge: string[] | null = null
      try {
        planningChallenge = buildPlanningChallenge(plan)
      } catch {
        planningChallenge = null
      }
      // `planningChallenge` FIRST so the model meets it before the plan body;
      // the plan's own keys follow unchanged, so callers that `JSON.parse`
      // this return value keep working.
      return JSON.stringify(planningChallenge ? { planningChallenge, ...plan } : plan, null, 2)
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
      // Validate EVERYTHING before writing anything.
      //
      // These attachments used to happen inline, before `checkpoint` validated
      // any of them, so a REFUSED checkpoint still persisted the model's claim:
      // `checkpoint(S1, complete, receiptId: "vrf_totally_made_up")` threw, and
      // plan.json was left holding `"evidence": {"receiptId": "vrf_totally_made_up"}`.
      // The story could not be completed -- validation re-runs every attempt --
      // but the durable audit record showed fabricated evidence, contradicting
      // story.ts's guarantee that a thrown error leaves the plan byte-for-byte
      // unchanged. Waiver verification is an await, so it must also finish
      // before the first write.
      const pending: Array<{ itemId: string; evidence: { receiptId: string } | { waiver: true; sourceMessageId: string } }> = []
      for (const item of args.items) {
        if (item.receiptId) {
          pending.push({ itemId: item.id, evidence: { receiptId: item.receiptId } })
        } else if (item.waiverSourceMessageId) {
          const verified = await isUserMessage(client, context.sessionID, item.waiverSourceMessageId)
          if (!verified) {
            throw new Error(
              `waiver for acceptance item ${item.id} references message ${item.waiverSourceMessageId}, which does not resolve to a user-authored chat message — rejected`,
            )
          }
          // Sign the waiver to the (session, criterion, message) it was
          // validated for. Unsigned, this was the cheapest forgery left in the
          // system: `pins.json` is an ordinary file and the gate trusts a
          // waiver forever, so writing one over each criterion silenced the
          // gate outright (measured: continuations 1 -> 0) -- no receipt to
          // clone, no worktree digest to satisfy. Signing also stops a
          // LEGITIMATE waiver being moved to a different criterion.
          const waiverSignature = signWaiver({
            sessionID: context.sessionID,
            criterionId: item.id,
            sourceMessageId: item.waiverSourceMessageId,
          })
          pending.push({
            itemId: item.id,
            evidence: {
              waiver: true,
              sourceMessageId: item.waiverSourceMessageId,
              ...(waiverSignature ? { signature: waiverSignature } : {}),
            },
          })
        }
      }
      // Receipt ids are validated here too, not only inside `checkpoint`.
      // Otherwise a fabricated id is written to plan.json first and rejected
      // second, leaving the forgery in the durable record.
      for (const { itemId, evidence } of pending) {
        if ("receiptId" in evidence) {
          const fresh = isFreshReceipt(
            { verificationReceipts, states, storyEngine },
            context.sessionID,
            args.storyId,
            evidence.receiptId,
          )
          if (!fresh) {
            throw new Error(
              `cannot complete story ${args.storyId}: acceptance item ${itemId}'s receipt ${evidence.receiptId} is not an observed receipt for this story`,
            )
          }
        }
      }
      // `checkpoint` reads evidence off the plan, so it has to be attached
      // before validation can run -- but a REFUSED checkpoint must not leave
      // the model's claim behind. An audit showed exactly that: a checkpoint
      // rejected for being out of order still wrote its waivers into
      // plan.json, and they then satisfied the story on a later attempt with
      // no further proof. Snapshot the prior evidence and restore it if
      // `checkpoint` throws, so story.ts's stated guarantee -- "a thrown error
      // leaves the plan file byte-for-byte unchanged" -- actually holds.
      type Evidence = { receiptId: string } | { waiver: true; sourceMessageId: string; signature?: string } | null
      const priorEvidence = new Map<string, Evidence>()
      const storyBefore = storyEngine.getPlan(context.sessionID)?.stories.find((s) => s.id === args.storyId)
      for (const { itemId } of pending) {
        const item = storyBefore?.acceptanceItems.find((a) => a.id === itemId)
        priorEvidence.set(itemId, (item?.evidence ?? null) as Evidence)
      }

      for (const { itemId, evidence } of pending) {
        storyEngine.attachEvidence(context.sessionID, args.storyId, itemId, evidence)
      }
      try {
        storyEngine.checkpoint(context.sessionID, args.storyId, args.status, {
          isValidReceipt: (receiptId) =>
            isFreshReceipt({ verificationReceipts, states, storyEngine }, context.sessionID, args.storyId, receiptId),
        })
      } catch (error) {
        for (const [itemId, evidence] of priorEvidence) {
          storyEngine.attachEvidence(context.sessionID, args.storyId, itemId, evidence)
        }
        throw error
      }
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
      "is archived under .opencode/elicify-vertex/archive/, never deleted) but not something to reach for to dodge an " +
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
