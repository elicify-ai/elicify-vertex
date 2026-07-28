/**
 * Wave-3 wiring — pure `Finding` builders for `composer.ts`'s `render()`.
 *
 * Each function produces one `Finding` (family/priority already fixed per
 * the FR-004 cap table) from already-collected observed state. No fs/client
 * access happens here — these are formatting-only, so they stay trivially
 * testable and keep `plugin.ts`'s hook bodies focused on *when* to call
 * them rather than *how* to word them.
 */
import type { Finding } from "../composer.js"
import type { ResolutionResult } from "../resolve.js"
import type { Criterion } from "../pin.js"
import type { StoryV2 } from "../story.js"

const GENERIC_VERIFIER_CATEGORIES =
  "a relevant test, lint, typecheck, build, check, validate, verify, or HTTP probe command covering the changed paths"

/**
 * Bounds for the idle gate's plan-completion wording (see
 * `incompletePlanFinding`). The text is dispatched as a real chat message,
 * so it has to stay readable; these are generous relative to real plans
 * (the 517-message session that produced this requirement had 6 stories
 * with 2-3 acceptance items each) while keeping a pathological 50-story
 * plan from pasting itself into the conversation.
 */
const MAX_LISTED_STORIES = 8
const MAX_LISTED_ITEMS = 6
const MAX_QUOTED_TEXT = 120

/** Single-line, length-bounded echo of author-supplied story/item text. */
function quote(text: string): string {
  const clean = text.trim().replace(/\s*\r?\n\s*/g, " ")
  return clean.length > MAX_QUOTED_TEXT ? `${clean.slice(0, MAX_QUOTED_TEXT - 1)}…` : clean
}

function listWithOverflow(parts: readonly string[], max: number): string {
  if (parts.length <= max) return parts.join("; ")
  return `${parts.slice(0, max).join("; ")} (+${parts.length - max} more)`
}

export function verifyGapFinding(opts: {
  instanceId: string
  changedPathsLabel: string
  resolution: ResolutionResult
}): Finding {
  const { instanceId, changedPathsLabel, resolution } = opts
  const command = resolution.command ?? GENERIC_VERIFIER_CATEGORIES
  return {
    family: "verify-gap",
    priority: "correction",
    observation: `Changed this turn: ${changedPathsLabel} — no successful verification observed since the latest change.`,
    diagnosis:
      resolution.rationale === "none"
        ? "No story verifier, basename convention, or package script resolved a narrower command."
        : `Resolved via ${resolution.rationale}.`,
    prescription: `Run ${command} and cite its observed result.`,
    instanceId,
  }
}

export function scopeWatchdogFinding(opts: {
  instanceId: string
  path: string
  offer: "fold" | "amend" | "revert"
  scopeGlobsMatchedZero: boolean
}): Finding {
  const { instanceId, path, offer, scopeGlobsMatchedZero } = opts
  const zeroNote = scopeGlobsMatchedZero
    ? " The active story's scope globs currently match zero files in the worktree — consider amending them first."
    : ""
  return {
    family: "scope-watchdog",
    priority: "correction",
    observation: `${path} is outside the active story's declared scope.`,
    diagnosis: "Mutation falls outside the checkpointed story's scopeGlobs.",
    prescription: `Fold this into the story's scope, amend the story's scopeGlobs (state why), or revert this change.${zeroNote} Recommended: ${offer}.`,
    instanceId,
  }
}

export function anomalyInterruptFinding(opts: {
  instanceId: string
  expectText: string
  observedSummary: string
}): Finding {
  const { instanceId, expectText, observedSummary } = opts
  return {
    family: "anomaly-interrupt",
    priority: "correction",
    observation: `You expected: "${expectText}". Observed: ${observedSummary}.`,
    diagnosis: "The stated expectation was contradicted by the observed verifier outcome.",
    prescription: "State what belief is now false, then revise before attempting another fix.",
    instanceId,
  }
}

export function elevateFinding(opts: {
  instanceId: string
  criteria: readonly Criterion[]
}): Finding {
  const { instanceId, criteria } = opts
  const replay = criteria.length
    ? criteria
        .map((c) => `${c.id}: ${c.text} — ${c.evidence ? "evidenced" : "NOT evidenced"}`)
        .join("; ")
    : "no criteria were pinned for this session"
  return {
    family: "elevate",
    priority: "phase-guidance",
    observation: `The bound verifier passed on a deep task. Criteria: ${replay}.`,
    diagnosis: "The task appears functionally done; this is the moment to finish well, not merely to stop.",
    prescription:
      "Replay each criterion against its evidence. Sweep adjacent findings: surface always; fix now only when small, same root cause, and covered by the verifier just run; otherwise propose. Run a taste pass over the diff from a reviewer's stance before reporting done.",
    instanceId,
  }
}

export function intakeScaffoldFinding(instanceId: string): Finding {
  return {
    family: "intake-scaffold",
    priority: "phase-guidance",
    observation: "No acceptance criteria have been pinned for this task yet.",
    diagnosis: "The task looks non-trivial; the intake scaffold has not been captured.",
    prescription:
      "Reply with an OUTCOME: line (one line), an ASSUMPTIONS: list (≤3 items), and a CRITERIA: numbered list of acceptance criteria before continuing.",
    instanceId,
  }
}

/**
 * Deliberately does NOT call `story.ts`'s `StoryEngine.proposePlan` — flagged
 * as a module-contract gap in this wave's final report: `proposePlan(sessionID,
 * stories)` expects an already-decomposed `stories` array, but the only
 * upstream signal wiring has (`classifyMultiStory`'s `ClassifyResult`)
 * carries a bare `multiStory: boolean`, never the decomposition itself — no
 * module in this codebase produces a story breakdown from raw ask text.
 * Rather than inventing a decomposition heuristic of its own, wiring asks
 * the model to draft the split and call `elicify_vertex_plan_create`
 * directly with structured args; `StoryEngine.proposePlan`'s formatted
 * "Proposed story plan:" text therefore goes unused by this wave's wiring.
 */
export function planProposalFinding(instanceId: string): Finding {
  return {
    family: "plan-proposal",
    priority: "phase-guidance",
    observation: "The task describes multiple distinct, separately-completable outcomes.",
    diagnosis: "Multi-story scope was detected at intake.",
    prescription:
      "Propose a story-by-story split: for each story, state its text and 2-3 acceptance items. After the user confirms the split, call elicify_vertex_plan_create with that breakdown (text, acceptanceItems, and optionally scopeGlobs/verifiers per story).",
    instanceId,
  }
}

export function precommitmentFinding(instanceId: string): Finding {
  return {
    family: "pre-commitment",
    priority: "phase-guidance",
    observation: "Changed files exist and no EXPECT artifact has been stated for this turn.",
    diagnosis: "Entering execute without a falsifiable prediction removes the value of the next verifier run.",
    prescription: 'State one line before running the verifier: "EXPECT [confidence]: <what you expect to observe>".',
    instanceId,
  }
}

/**
 * FIX #8 (review MAJOR — "no story-completion directive when an
 * intermediate story's verifier goes green"). Per BDD "Intermediate story
 * green does not elevate a multi-story plan": "no elevate directive is
 * injected ... a story-completion directive naming story 2 renders
 * instead." `plugin.ts` calls this exactly when a bound verifier passed,
 * an active plan exists, and the passing verifier does NOT cover the
 * plan's final story — `nextStory` is the story immediately following the
 * one that just went green, in plan order.
 */
export function storyCompletionFinding(opts: { instanceId: string; nextStory: StoryV2 }): Finding {
  const { instanceId, nextStory } = opts
  return {
    family: "story-completion",
    priority: "phase-guidance",
    observation: "The active story's bound verifier just passed, but it is not the plan's final story.",
    diagnosis:
      "An intermediate story going green does not elevate a multi-story plan (US-7) — completion is scoped per story, not session-wide.",
    prescription: `Checkpoint this story as complete (elicify_vertex_plan_checkpoint, with evidence for every acceptance item), then move on to story ${nextStory.id}: ${nextStory.text}.`,
    instanceId,
  }
}

/**
 * What the ACTIVE story needs before it can be checkpointed complete —
 * AC-2's "for the active story what evidence would close it (its declared
 * verifiers, and which acceptance items lack evidence)".
 *
 * Three item states are worded distinctly on purpose: a story with no
 * acceptance items at all is a different (and more common than it should
 * be) failure from one whose items are merely unevidenced, and a story
 * whose items are ALL evidenced needs a checkpoint call, not another
 * verifier run. Saying "run the verifier" in that last case would be the
 * generic "keep going" the requirement explicitly rejects.
 */
function activeStoryPrescription(story: StoryV2): string {
  const unevidenced = story.acceptanceItems.filter((item) => !item.evidence)

  const itemsClause =
    story.acceptanceItems.length === 0
      ? `${story.id} declares no acceptance items, so nothing can evidence it — amend it to declare what "done" means before checkpointing.`
      : unevidenced.length === 0
        ? `Every acceptance item on ${story.id} already carries evidence, so it is ready to checkpoint.`
        : `Acceptance items on ${story.id} still lacking evidence: ${listWithOverflow(
            unevidenced.map((item) => `${item.id}: "${quote(item.text)}"`),
            MAX_LISTED_ITEMS,
          )}.`

  const verifierClause = story.verifiers.length
    ? `Evidence that would close ${story.id}: run ${story.verifiers.join(" && ")} and cite its observed result.`
    : `${story.id} declares no verifiers, so nothing narrower is bound to it — run ${GENERIC_VERIFIER_CATEGORIES}, or amend ${story.id} to declare the verifier you intend to use.`

  return (
    `Resume story ${story.id} — "${quote(story.text)}". ${itemsClause} ${verifierClause} ` +
    `Then call elicify_vertex_plan_checkpoint for ${story.id} with evidence for every acceptance item, and continue with the next story. ` +
    `If a story genuinely no longer applies, checkpoint it blocked or failed with a reason rather than leaving it silently open.`
  )
}

/**
 * Stage-1 deterministic idle gate: the session went idle while its story
 * plan still had open stories (`docs/REQUIREMENTS-IDLE-COMPLETION-GATE.md`,
 * AC-1/AC-2).
 *
 * Lives here rather than being hand-built at the gate for the reason the
 * requirement gives: every other directive in this harness is worded in
 * this module, from observed state only, with no fs/client access — so it
 * stays trivially testable and cannot drift into a second, differently
 * shaped voice. `wiring/gate.ts` renders these three slots into the
 * continuation body and owns the *when* (cap, holdout, short-circuit); this
 * function owns only the *what*.
 *
 * `incomplete` is every story whose status is not `"complete"` (the
 * requirement's literal bar), in plan order — including `blocked`/`failed`,
 * whose status is named verbatim so the model can tell a stalled story from
 * an untouched one.
 */
export function incompletePlanFinding(opts: {
  instanceId: string
  totalStories: number
  incomplete: readonly StoryV2[]
  activeStory: StoryV2 | null
}): Finding {
  const { instanceId, totalStories, incomplete, activeStory } = opts

  const roster = listWithOverflow(
    incomplete.map((story) => `${story.id} (${story.status}): "${quote(story.text)}"`),
    MAX_LISTED_STORIES,
  )

  const observation =
    `The story plan is not complete: ${incomplete.length} of ${totalStories} ` +
    `${totalStories === 1 ? "story is" : "stories are"} still open — ${roster}.`

  const diagnosis =
    "Idle was reached with an open story contract. Deterministic completion checks run before the completion " +
    "judge, so nothing has assessed this session as done — the plan itself already says it is not."

  const prescription = activeStory
    ? activeStoryPrescription(activeStory)
    : `No story is active, so nothing can be checkpointed complete and the plan has stalled with ${incomplete
        .map((story) => story.id)
        .join(", ")} unresolved. State plainly that the plan is stalled and what is needed to resume it, rather than ending the turn as if it were finished.`

  return {
    family: "plan-incomplete",
    priority: "correction",
    observation,
    diagnosis,
    prescription,
    instanceId,
  }
}

export function pinnedCriteriaReinjectFinding(opts: {
  instanceId: string
  criteria: readonly Criterion[]
  activeStory: StoryV2 | null
}): Finding {
  const { instanceId, criteria, activeStory } = opts
  const list = criteria.length
    ? criteria.map((c) => `${c.id}: ${c.text}`).join("; ")
    : "(none pinned)"
  const story = activeStory ? ` Active story: ${activeStory.id} — ${activeStory.text}.` : ""
  return {
    family: "pinned-criteria-reinject",
    priority: "enrichment",
    observation: `Session state was just compacted. Pinned criteria: ${list}.${story}`,
    diagnosis: "Compaction can drop context; criteria and the active story are re-stated once.",
    prescription: "Continue honoring these criteria and this story for the rest of the session.",
    instanceId,
  }
}
