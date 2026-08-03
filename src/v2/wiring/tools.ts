/**
 * Wave-3 wiring — `elicify_vertex_plan_*` tools and their matching
 * `/elicify-vertex-plan-*` slash commands (Ambiguity #6's naming
 * resolution), backed by `StoryEngine` rather than v1's `MultiStoryGoalEngine`.
 * Structure mirrors v1's `elicify_vertex_goal_*` tools in `src/index.ts`.
 *
 * 2026-07-30 task/DAG redesign (supersedes the wave model): the atomic
 * execution unit is the TASK. `elicify_vertex_plan_create` now requires
 * each story to decompose into ≥1 `tasks` (each `{ text, dependsOn? }`)
 * and optionally declare story-level `dependsOn`; the engine assigns every
 * task a predictable id (`S{n}.T{m}`) and COMPUTES parallel waves from the
 * dependency DAG (topological levels), so there is no `wave` argument
 * anymore — waves are derived, never input. `elicify_vertex_plan_next`
 * returns the active TASKS (one subagent per element); the model fans out
 * a `task`-tool subagent against each. `elicify_vertex_plan_checkpoint`
 * takes `{ taskId, status, reason? }` — a story auto-completes when all
 * its tasks are done, at which point the completion judge audits it.
 *
 * HANDOVER.md redesign point 1 (preserved): a checkpoint is a CLAIM, not a
 * close — no receipt, no waiver, no evidence validation. The old per-story
 * citation apparatus (waiver-provenance, `signWaiver`, receipt-freshness,
 * the attach-then-restore-on-reject dance) is gone, not just bypassed.
 * Receipts and signed waivers still back the PLAN-LESS pinned-criteria
 * path (`PinStore`, `tool.execute.after`'s auto-attach), which never went
 * through this file.
 */
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { tool } from "@opencode-ai/plugin"
import type { PhaseEngine } from "../phase.js"
import type { PinStore } from "../pin.js"
import type { PlanV2, StoryEngine, Task } from "../story.js"
import type { OpencodeClient } from "../types.js"
import type { V2SessionState } from "./state.js"

export interface PlanToolsDeps {
  storyEngine: StoryEngine
  pinStore: PinStore
  client: OpencodeClient
  states: Map<string, V2SessionState>
  /** T8 (FR-001): rebinds phase to `execute` for a story whose first task
   * just activated. Without this call the phase engine's per-story slot
   * for the newly-active story is never touched until its first mutation,
   * so `getPhase()` reads a stale/default value in the window between
   * checkpoint/promotion and that mutation. */
  phaseEngine: PhaseEngine
  /** Runs when a plan is successfully created, so wiring can clear `multiStoryPending`. */
  onPlanCreated: (sessionID: string) => void
}

// ---------------------------------------------------------------------------
// One-time "star on GitHub" consent + tool (deterministic trigger, LLM popup,
// hidden execution).
//
// The ask is a real yes/no via the model's `question` tool (the only popup
// opencode exposes). The harness fires that ask ONCE per machine (consent file
// gates it — see plugin.ts), not from the model's memory. The actual `gh` star
// call runs as this plugin's OWN subprocess inside the tool below — never a
// bash tool call — so the command and its output never appear in the chat; the
// model only sees a clean tool result. `GH_TOKEN` is stripped so the user's own
// `gh auth login` is used.
// ---------------------------------------------------------------------------

export const STAR_REPO = "elicify-ai/elicify-vertex"

/** The opencode config root, matching `scripts/register-commands.mjs`. */
function opencodeConfigRoot(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  return xdg ? join(xdg, "opencode") : join(homedir(), ".config", "opencode")
}

/** Machine-wide consent marker for the star ask. Absent = never asked. */
export function starConsentPath(): string {
  return join(opencodeConfigRoot(), ".elicify-vertex-consent")
}

/** Read the consent marker. `null` = no file (never asked). */
export function readStarConsent(): string | null {
  try {
    const path = starConsentPath()
    return existsSync(path) ? readFileSync(path, "utf8").trim() || null : null
  } catch {
    return null
  }
}

/** Star the repo as a hidden subprocess. Best-effort: returns false on any
 *  failure (no `gh`, not authed, offline) — the caller records consent so the
 *  user is never re-asked by a transient failure. */
export function starRepoHidden(): boolean {
  const env = { ...process.env }
  delete env.GH_TOKEN
  delete env.GITHUB_TOKEN
  try {
    execFileSync("gh", ["api", "--method", "PUT", `/user/starred/${STAR_REPO}`], {
      env,
      stdio: "ignore",
      timeout: 15_000,
    })
    return true
  } catch {
    return false
  }
}

/** Write the consent marker (mode 0600). */
export function writeStarConsent(value: "prompted" | "yes"): void {
  try {
    writeFileSync(starConsentPath(), value, { mode: 0o600 })
  } catch {
    // Non-fatal: worst case the user is asked again next run.
  }
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
    // Verified against src/v2/story.ts: `clearPlan` archives to
    // archive/plan.<session>.<ts>.json before dropping the session's entry,
    // and `createPlan` archives any existing plan before replacing it. Say so,
    // or the model reads re-planning as destructive and avoids it.
    "3. Clear and re-plan — if the stories encode assumptions rather than findings, call " +
      "elicify_vertex_plan_clear, ground the work, then elicify_vertex_plan_create again. The old plan is " +
      "ARCHIVED under .opencode/elicify-vertex/archive/, never deleted, so re-planning costs a tool call and " +
      "loses nothing.",
    "Proceeding is also a valid answer — but only if you can say what the plan is grounded IN.",
  )
  return lines
}

/** 2026-07-30: enrich each active task with its parent story's id/text so the
 * model has the context it needs to dispatch a subagent per task. Keeps the
 * task's own fields intact (it is a shallow copy, not a mutation of the
 * engine's in-memory task). */
function activeTasksWithStoryContext(plan: PlanV2 | null, tasks: Task[]): Array<Task & { storyId: string; storyText: string }> {
  if (!plan) return []
  const storyOf = new Map<string, { id: string; text: string }>()
  for (const story of plan.stories) {
    for (const task of story.tasks) storyOf.set(task.id, { id: story.id, text: story.text })
  }
  return tasks.map((task) => {
    const parent = storyOf.get(task.id)
    return { ...task, storyId: parent?.id ?? "", storyText: parent?.text ?? "" }
  })
}

export function buildPlanTools(deps: PlanToolsDeps) {
  const { storyEngine, pinStore, phaseEngine } = deps

  const createTool = tool({
    description:
      "Create the elicify-vertex v2 plan under <project>/.opencode/elicify-vertex/plan.json. Call only after the " +
      "user has confirmed a proposed plan. Decompose EACH story into one or more tasks, and declare dependencies " +
      "so parallel waves can be computed from the dependency graph (you never choose waves yourself — the engine " +
      "derives them as topological levels over the task DAG). Task ids are assigned by the engine as S{n}.T{m} in " +
      "story-then-task order (S1.T1, S1.T2, S2.T1, ...), so you CAN predict them and reference one task from " +
      "another's dependsOn before the plan exists. A task's dependsOn may name other task ids (cross-story " +
      "allowed) or whole story ids (the task then waits for every task of that story). A story's optional top-" +
      "level dependsOn names other STORY ids and means none of this story's tasks can start until those stories " +
      "are fully done. AcceptanceItems are written as functional, verifiable claims ('make check passes', 'X " +
      "returns 200') because the completion judge will independently check every one of them against the real " +
      "worktree. Tasks with no dependsOn all start active at once (wave 0) — fan out a subagent per active task.",
    args: {
      stories: tool.schema
        .array(
          tool.schema.object({
            text: tool.schema.string().min(1),
            acceptanceItems: tool.schema.array(tool.schema.string().min(1)).min(1),
            tasks: tool.schema
              .array(
                tool.schema.object({
                  text: tool.schema.string().min(1),
                  dependsOn: tool.schema.array(tool.schema.string()).optional().default([]),
                }),
              )
              .min(1),
            scopeGlobs: tool.schema.array(tool.schema.string()).optional().default([]),
            verifiers: tool.schema.array(tool.schema.string()).optional().default([]),
            dependsOn: tool.schema.array(tool.schema.string()).optional().default([]),
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
      // MAJ-1: an aborted create leaves the OLD plan on disk while returning
      // the new one, so the old plan resurrects on the next hydrate.
      const createAborted = storyEngine.consumeWriteAbort(context.sessionID)
      const createWarning = createAborted
        ? {
            persisted: false,
            warning:
              "This plan was created in memory but could NOT be written to disk (the state lock was held by " +
              "another instance). Any previous plan is still on disk and will reappear. Re-create the plan.",
          }
        : {}
      return JSON.stringify(
        planningChallenge ? { planningChallenge, ...createWarning, ...plan } : { ...createWarning, ...plan },
        null,
        2,
      )
    },
  })

  const nextTool = tool({
    description:
      "Return every currently-active TASK in the elicify-vertex v2 plan as a JSON array (each enriched with its " +
      "parent storyId/storyText). Fan out ONE task-tool subagent per active task and work them in parallel; tasks " +
      "at the same computed wave are independent by construction. Checkpoint each task when its work is done.",
    args: {},
    async execute(_args, context) {
      const tasks = storyEngine.getActiveTasks(context.sessionID)
      const plan = storyEngine.getPlan(context.sessionID)
      return JSON.stringify(activeTasksWithStoryContext(plan, tasks), null, 2)
    },
  })

  const checkpointTool = tool({
    description:
      "Checkpoint a TASK in the elicify-vertex v2 plan (complete|failed|blocked). A 'complete' checkpoint is a " +
      "CLAIM, not a close: when the task's parent story has ALL its tasks complete, the story auto-completes, and " +
      "at the next idle the completion judge independently audits every acceptance item against the real worktree " +
      "(reading files, re-running the story's declared verifiers) and re-opens the story with named gaps if the " +
      "claim does not hold. Claim only what you have genuinely delivered and verified. No receipt or waiver ids " +
      "are needed or accepted. Pass a reason for failed/blocked.",
    args: {
      taskId: tool.schema.string().min(1),
      status: tool.schema.enum(["complete", "failed", "blocked"]),
      reason: tool.schema.string().optional(),
    },
    async execute(args, context) {
      // Capture the set of active STORY ids (and the checkpointed task's
      // parent story) BEFORE the call so we can rebind phase to `execute`
      // for every story that newly became active (its first task activated)
      // as a side effect of this checkpoint + level-promotion.
      const activeBefore = new Set(storyEngine.getActiveStories(context.sessionID).map((story) => story.id))
      const planBefore = storyEngine.getPlan(context.sessionID)
      let parentStoryId = args.taskId
      if (planBefore) {
        for (const story of planBefore.stories) {
          if (story.tasks.some((task) => task.id === args.taskId)) {
            parentStoryId = story.id
            break
          }
        }
      }

      // MIN-001 (code review): consume the result. For an IDEMPOTENT no-op
      // this is the only remaining corrective signal — the thrown error that
      // used to name the currently-active tasks is gone by design (FR-003),
      // so without surfacing it the model cannot tell "already done, carry on"
      // from "just completed".
      const checkpointResult = storyEngine.checkpoint(context.sessionID, args.taskId, args.status, {
        reason: args.reason,
      })

      // T8 (FR-001), task/wave-aware: completing/blocking/failing the last
      // active task can promote a whole new level at once — possibly across
      // several stories. Rebind phase to `execute` for EVERY newly-active
      // story, not just a single successor. Best-effort: a phase-engine
      // hiccup must not fail a successful checkpoint.
      for (const nowActive of storyEngine.getActiveStories(context.sessionID)) {
        if (activeBefore.has(nowActive.id)) continue
        try {
          phaseEngine.onStoryAdvance(context.sessionID, parentStoryId, nowActive.id)
        } catch {
          // best-effort — see comment above
        }
      }

      const plan = storyEngine.getPlan(context.sessionID)
      // C3 (grill round 2): a contended state lock aborts the WRITE while the
      // mutation still applies in memory, and the tool used to return the
      // updated plan as though it had been saved. Say so instead — the model
      // is the only thing in a position to re-checkpoint, and an operator
      // reading the transcript should not have to infer a lost write from a
      // `plan:write-aborted` line in the event log.
      const writeAborted = storyEngine.consumeWriteAbort(context.sessionID)
      const abortNote = writeAborted
        ? {
            persisted: false,
            warning:
              `The checkpoint of ${args.taskId} was applied in memory but could NOT be written to disk (the state ` +
              "lock was held by another instance). It may be lost. Re-run this checkpoint before relying on it.",
          }
        : {}
      return JSON.stringify(
        checkpointResult.idempotent
          ? {
              idempotent: true,
              note: `${args.taskId} was already complete — no change made.`,
              activeTaskIds: checkpointResult.activeTaskIds,
              ...abortNote,
              ...plan,
            }
          : { ...abortNote, ...plan },
        null,
        2,
      )
    },
  })

  const reopenTool = tool({
    description:
      "Reopen a story in the elicify-vertex v2 plan so work on it can resume. Use this after whatever actually " +
      "caused a block or failure has been resolved (a missing dependency now exists, a design question got " +
      "answered, an external blocker cleared), or to resume a story the completion judge reverted — never as a " +
      "way to dodge unmet acceptance criteria (the judge will audit the next claim all the same). The story's " +
      "not-complete tasks are re-activated when their dependencies are satisfied, or rejoin the queue as pending " +
      "otherwise; complete tasks are left complete.",
    args: {
      storyId: tool.schema.string().min(1),
      reason: tool.schema.string().min(1),
    },
    async execute(args, context) {
      storyEngine.reopenStory(context.sessionID, args.storyId, { reason: args.reason })
      const plan = storyEngine.getPlan(context.sessionID)
      const story = plan?.stories.find((candidate) => candidate.id === args.storyId) ?? null
      // C-12: reopenStory resets StoryEngine's own status/evidence but has no
      // knowledge of PhaseEngine (a deliberately separate module — see
      // story.ts's header). Without this, a story whose phase reached
      // "close" before it blocked stays "close" after reopening — and
      // onMutation is a documented no-op from "close" (no table arc), so it
      // cannot fix this. onStoryAdvance (T8) is the one phase transition
      // that unconditionally forces the target back to "execute"; reused
      // here as "resume this story now".
      if (story?.status === "active") phaseEngine.onStoryAdvance(context.sessionID, args.storyId, args.storyId)
      return JSON.stringify(
        {
          storyId: args.storyId,
          newStatus: story?.status ?? null,
          becameActive: story?.status === "active",
          story,
          plan,
        },
        null,
        2,
      )
    },
  })

  const statusTool = tool({
    description:
      "Read the elicify-vertex v2 plan for the current session (null if none). Includes each story's tasks and " +
      "their statuses, so the active tasks / computed waves are visible without a separate call.",
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
      // MAJ-1 (grill round 3): C3's abort signal was wired into `checkpoint`
      // only, so an aborted clear still returned `planCleared: true` while the
      // plan sat untouched on disk — it comes straight back on the next
      // hydrate. Same for create, below.
      const writeAborted = storyEngine.consumeWriteAbort(context.sessionID)
      return JSON.stringify(
        writeAborted
          ? {
              planCleared,
              pinsCleared,
              persisted: false,
              warning:
                "The plan was cleared in memory but the change could NOT be written to disk (the state lock was " +
                "held by another instance). The plan is still on disk and will reappear. Re-run this to clear it.",
            }
          : { planCleared, pinsCleared },
        null,
        2,
      )
    },
  })

  // One-time star tool: the model calls this ONLY after the user agrees via
  // the `question` tool. It runs `gh` as a hidden subprocess and records
  // consent, so no bash/gh ever appears in the chat. Idempotent: a second call
  // (consent already "yes") is a no-op.
  const starTool = tool({
    description:
      "Star the elicify-vertex GitHub repo. Call this ONLY once, after the user agreed to star via the question tool. " +
      "It performs the star itself — do NOT run gh or any bash command yourself. Returns {starred, already}.",
    args: {},
    async execute() {
      const prior = readStarConsent()
      if (prior === "yes") return JSON.stringify({ starred: true, already: true })
      const ok = starRepoHidden()
      writeStarConsent("yes")
      return JSON.stringify({ starred: ok, already: false })
    },
  })

  return {
    elicify_vertex_plan_create: createTool,
    elicify_vertex_plan_next: nextTool,
    elicify_vertex_plan_checkpoint: checkpointTool,
    elicify_vertex_plan_status: statusTool,
    elicify_vertex_plan_clear: clearTool,
    elicify_vertex_plan_reopen: reopenTool,
    elicify_vertex_star: starTool,
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
