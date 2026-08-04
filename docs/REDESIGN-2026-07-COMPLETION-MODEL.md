# Completion-model redesign (2026-07-29)

> **2026-07-30 addendum — task/DAG model.** Point 6 below (story-level
> `wave` numbers) was superseded: the atomic unit is now the **TASK**. Each
> story decomposes into `tasks[]`; `dependsOn` at story AND task level lets
> the engine **compute** parallel waves from the dependency DAG (topological
> levels) — no `wave` field is input or stored. `plan_next` returns active
> TASKS; `plan_checkpoint` takes a `taskId`; a story auto-completes when all
> its tasks are done (then the verifier audits it). Promotion is
> dependency-COMPLETION-based, so a blocked dependency holds its dependents
> pending (the C-11 invariant, carried into the task model). The input shape
> itself forces parallel planning: declaring tasks + dependencies is the act
> of planning.

Supersedes the completion model described in `docs/VERIFIER-PROMPT.md` and the
verifier-gating described in `docs/REQUIREMENTS-IDLE-COMPLETION-GATE.md`. The
rationale and evidence are in `HANDOVER.md` ("The problem we're now designing
against" — a real 894-message session that ended 5/5 stories blocked, 0
receipts, verifier never fired). The nine agreed points are HANDOVER.md's
"Agreed redesign direction"; this document records where each landed in code.

## The new model in one paragraph

A story checkpoint is a **claim**, not a close. The model claims
`complete`/`blocked`/`failed` with no citation of any kind; at `session.idle`
the **completion verifier** — a tool-using subturn with read/grep/glob/list/bash
and no write/edit — independently audits every story claimed since its last
audit, reading the worktree and re-running the stories' declared verifiers
itself. Its structured per-acceptance-item verdicts are **applied**: a failed
claim reverts the story to `active` with named gaps and a constructive
continuation; a passed plan closes out. Deterministic nudges (incomplete
plan, promise-no-act, criteria replay, zero-criteria fallback) remain, but
they nudge toward *claimable truth*, and they defer while a delegated
subagent is mid-flight and pause after a capped run of no-progress
continuations.

## Where each point landed

1. **No receipt/waiver citation at checkpoint** — `src/v2/story.ts`
   `checkpoint(sessionID, storyId, status, {reason?})`; `src/v2/wiring/tools.ts`
   (the entire waiver-provenance/receipt-freshness apparatus deleted).
   Receipts and signed waivers still back the *plan-less* pinned-criteria
   path (`PinStore`, `src/goals.ts`) — untouched.
2. **Verifier is the sole arbiter** — `src/v2/wiring/gate.ts` `handleVerifierAudit`,
   runs at every idle with an unverifiedStories claim; the old `appendVerifierCloseOut`
   (gated behind all-stories-complete) is gone.
3. **Verifier has read-only tools** — `src/v2/wiring/config.ts` `VERIFIER_PERMISSION`
   (deliberate reversal of the zero-tool decision; `vertex-intake` stays
   zero-tool), `src/v2/subturn.ts` `ProbePolicy`/`VERIFIER_PROBE_POLICY`/
   `buildToolPolicyMap`. Verifier budget default 300s (`VERTEX_VERIFIER_BUDGET_MS`).
4. **Structured per-item verdicts** — `src/v2/verifier.ts` `VerifierVerdict
   {stories: [{storyId, pass, summary, items: [{itemId, met, note}]}]}`;
   `pass` requires every item `met`.
5. **Acceptance items are functional claims** — tool descriptions,
   `agents/elicify-vertex-agent.md` `<planning_in_waves>`, and the verifier's
   plan-digest payload field (`buildVerifierPayload`'s `plan`).
6. **Real waves** — `StoryV2.wave`; `createPlan` activates all stories of the
   lowest wave; `checkpoint` promotes the whole next wave when no story
   remains active; `getActiveStories()`; wave-aware `checkScope`/`reopenStory`.
7. **Nudges only when justified** — `src/v2/plugin.ts` `system.transform`
   fires verify-gap only when the resolver names a concrete command; the
   generic "run something relevant" nudge is gone (the idle stop-block still
   catches unverified work at turn end).
8. **Constructive continuations** — `formatVerifierReverts` (gate.ts) and the
   verifier-stamp-aware `incompletePlanFinding`/`activeStoryPrescription`
   (findings.ts): "S2 not delivered — A3, A4 still missing, and here is what
   the verifier saw."
9. **Watchdog** — `src/v2/wiring/watchdog.ts`: `DelegationTracker` +
   `hasBusyChildren` (defer nudging mid-delegation) and `evaluateStall`
   (pause after `VERTEX_MAX_NO_PROGRESS_TURNS` consecutive no-progress
   continuations, default 3; re-armed by the next real user message).

## Invariants that survived the redesign

- Fail-open everywhere: verifier unavailable/malformed → claims stand, health
  notification emitted; probe failure → `verifier:unsupported`, zero child
  sessions created.
- A thrown `checkpoint` error leaves `plan.json` byte-for-byte unchanged.
- The C-11 final-story guard: the final story cannot claim `complete` while
  any other story is unresolved.
- Plans written before the redesign (no `wave`/`completedAt`/`verifier` fields)
  still validate and behave sequentially (`waveOf` fallback = array index+1).
- Stall pause never wedges a session: any real user message re-arms the gate.
