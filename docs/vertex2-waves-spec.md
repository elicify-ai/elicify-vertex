# Feature Specification: Wave-Based Parallel Story Execution with Deterministic Mandatory Verification

**Created**: 2026-07-27
**Status**: Draft
**Input**: Operator finding that Vertex 2's plan model is strictly sequential (one `active` story at a time), which conflicts with parallel subagent fanout as a default execution strategy. Design agreed in session; four open decisions resolved by operator (see Clarifications).

> **Note added 2026-08-07 (spec rev 5).** This document is a **Draft**, and the event names
> it specifies — `wave:over-serialised`, `story:v2-archived`, `verifier:unavailable-at-close`,
> `verifier:no-progress` — are **proposals**. None is present in `V2_EVENT_TYPES`
> (`src/measurement.ts`), which is the normative registry of everything the harness actually
> writes (`docs/vertex2-spec.md` FR-033R, mirror in its Appendix A). If this spec is
> implemented, each name must be added to that array first — `EventLogger` is typed to it,
> so an unregistered name will not compile. Do not read a name here as evidence that the
> event exists.

---

## Problem Statement

Vertex 2's `PlanV2` allows exactly one `active` story at a time:

- `createPlan` sets `index === 0 ? "active" : "pending"` (`story.ts:380`).
- `getActiveStory` is a `.find()` for the single story with `status === "active"` (`story.ts:419-423`).
- `checkpoint` **throws** when completing any story that is not the current active one (`story.ts:578-584`).
- `checkScope` matches mutations against *the* active story's `scopeGlobs` only (`story.ts:491-510`).

Consequently, when work is delegated to parallel subagents:

1. Stories 2..N activate only *after* story 1 completes, so their `startedAt` postdates any verification receipt earned during the parallel wave. `isFreshReceipt` (`wiring/tools.ts:112`) rejects a receipt observed before `startedAt`, so **parallel work produces evidence the gate then invalidates**.
2. Checkpoint bookkeeping serialises even when execution did not.
3. The scope watchdog fires on nearly every mutation, consuming composer budget that useful findings need.

Separately, the mandatory verification step that v1 provided (`elicify_vertex_goal_create` auto-appended a final verification story — see `scripts/register-commands.mjs`) was **lost in v2**: `createPlan` accepts whatever stories the model supplies and sets `finalStoryId` to the last one, with no synthesised verification step.

This feature introduces **waves** (groups of stories that activate and execute concurrently) and restores **auto-appended, non-model-authored verification stories** as a hard gate between waves.

### Field-observed defects folded into this spec

A 1h34m live session (`ses_0668b2422ffe4hbFM3AkIerZmp`, 2026-07-27, `/home/dev/vertextest`, 93 messages, 25 bash calls) produced **zero evidence**: 21/21 acceptance items `null`, 0 receipts, 0 checkpoints, story S1 left `active` and S2–S5 never started. Root-caused against the real session data and the real functions:

- **D1 — Relevance-gap rejects covering verifiers (blocking).** `verifiersEquivalent` (`measurement.ts:824`) compares the resolver's `rationale` plus **set equality** of `matchedPaths`. It has no notion of coverage, so a *broader* verifier is scored as a miss. Verified directly against the shipped function: `go test ./...` vs prescribed `go test ./internal/auth/...` → gap; `npm test` vs prescribed `npx vitest run tests/lexer.test.ts` → gap. In the live session this fired 3 times (08:09:32, 08:20:15, 08:37:41) on precisely the 3 commands that `parseVerification` scored `verified` with exit 0 — the only 3 of 25 that would have minted a receipt. `success = rawSuccess && !relevanceGap` then suppressed every one. **Nothing downstream — evidence, checkpoints, wave progression, verifier — can function until this is fixed.**
- **D2 — The verifier is a post-hoc QA pass, not a completion detector.** `appendVerifierCloseOut` runs only when `phaseEngine.onIdle` returns `closed` *and* the final story is already `complete`. It therefore fires exactly when the work is already declared done, and can never say "you stopped early." In the live session it never ran at all.
- **D3 — No completion driver.** `gate.ts` has exactly four continuation triggers (promise-no-act, zero-criteria stop-block, criteria-block, verifier verdict). None is "the plan still has unfinished stories." All four were inert: 0 deferral keywords in 91 assistant messages; `classifyStopMode` scored the session `normal` so `shouldBlockStop` hard-returns false (it requires `deep`); `pins.json` was `{}`; the final story was never complete. The plan is a *record*, never a *driver*.
- **D4 — `newTurn` never advances in autonomous runs.** `turnIndex` reached 1 at 07:54:48 and never moved again across 43 minutes, yielding 250 `per-turn-cap:dropped` against 5 `directive_rendered` — a **2% directive delivery rate**. `composer.newTurn` is called only from `chat.message` (2 user messages all session) and from `promptContinuation` (never dispatched, per D3).

D1 and D4 are defects in already-shipped behaviour and are specified here because the wave model cannot be evaluated on top of them. D2 and D3 are the design inversion this revision introduces.

---

## Available Reference Patterns

No `docs/reference/` directory exists in this repository. In-repo precedents used instead:

| In-Repo Precedent | Pattern | Relevance to This Feature |
|---|---|---|
| `story.ts` `archiveV1IfPresent()` | Reversible archival via atomic rename to `archive/`, never delete | Reused verbatim in shape for archiving a `schemaVersion: 2` plan when v3 lands |
| `scripts/register-commands.mjs` (v1 goal-create template) | "A final verification story is appended automatically — do not invent one by hand" | The auto-append behaviour being restored, generalised from once-per-plan to once-per-wave |
| `pin.ts` `acquireStateLock()` | Shared `.elicify-vertex/` directory lock | All new plan writes use the existing lock; no new locking scheme |
| `wiring/tools.ts` `isFreshReceipt()` | Receipt must be observed, workspace-matching, and not predate story start | **Unchanged by this feature** — wave activation is what makes it hold |
| `composer.ts` `DEFAULT_FAMILY_CAPS` | Per-family per-turn caps, `correction` priority ranks above `phase-guidance` | New `wave-verification` and `delegation-gap` families slot into this table |

---

## Existing Codebase Context

### Symbols Involved

| Symbol | Role | Context |
|---|---|---|
| `StoryV2` (`story.ts:106`) | **modifies** | Add `wave: number`, `kind: "delivery" \| "verification"`; extend `status` union with `"delivered"` |
| `PlanV2` (`story.ts:143`) | **modifies** | `schemaVersion: 2` → `3` |
| `isStoryV2` / `isPlanV2` (`story.ts:186-205`) | **modifies** | Validate new fields; reject `schemaVersion !== 3`; enforce wave/kind invariants |
| `StoryEngine.createPlan` (`story.ts:370`) | **modifies** | Group by declared wave, validate grouping, auto-append per-wave verification stories, activate all of wave 1 |
| `StoryEngine.checkpoint` (`story.ts:558`) | **modifies** | Accept any `active` story; wave-gated successor activation; failed-verification rework path |
| `StoryEngine.getActiveStory` (`story.ts:419`) | **extends** | New `getActiveStories(): StoryV2[]`; `getActiveStory` retained as "first active" for back-compat at call sites that legitimately need one |
| `StoryEngine.checkScope` (`story.ts:491`) | **modifies** | Match against union of all active stories' `scopeGlobs` |
| `buildPlanTools` (`wiring/tools.ts:117`) | **modifies** | Add `elicify_vertex_plan_deliver`; loosen checkpoint story resolution |
| `isFreshReceipt` (`wiring/tools.ts:90`) | **calls (unchanged)** | Correctness depends on wave-start `startedAt`; no code change |
| `VerificationReceiptStore` (`goals.ts:159`) | **calls (unchanged)** | Session-keyed; subagents cannot mint. Invariant to preserve |
| `PhaseEngine` (`phase.ts:55`) | **modifies** | `session.activeStoryId` is overwritten on every mutation — unsafe with concurrent stories |
| `InjectionComposer` (`composer.ts:135`) | **extends** | Two new finding families in `DEFAULT_FAMILY_CAPS` |
| `handleSessionIdle` (`wiring/gate.ts:300`) | **modifies** | Three `getActiveStory` call sites (204, 251, 316) |

### Impact Assessment

| Symbol Modified | Risk Level | d=1 Dependents | d=2 Dependents |
|---|---|---|---|
| `StoryV2.status` union | **HIGH** | `isStoryV2`, `checkpoint`, `getActiveStory`, `createPlan`, `STORY_STATUSES` | All 10 `getActiveStory` call sites; `plan.json` on disk |
| `PlanV2.schemaVersion` | **HIGH** | `isPlanV2`, `hydrateFromDisk`, `persistPlan` | Every persisted plan; `persistPlan` silently drops entries failing validation — **data-loss risk if archival is not implemented first** |
| `getActiveStory` | **HIGH** | `plugin.ts:121,540,618,711,748`; `gate.ts:204,251,316`; `tools.ts:149,200` | Verifier resolution, verifier payload, phase keying, criteria reinject |
| `PhaseEngine.session.activeStoryId` | **MEDIUM** | `onMutation`, `onVerifierOutcome`, `getPhase(sid)` (no storyId) | `resolveStoryIdForPhase`, elevate/close transitions, verifier trigger |
| `checkpoint` ordering guard | **MEDIUM** | `tools.ts:188` | T8 story-advance arc (`tools.ts:197-202`) |
| `checkScope` | **LOW** | `plugin.ts:517` | scope-watchdog finding |
| `createPlan` | **LOW** | `tools.ts:137` | `onPlanCreated` compliance recording |

**CRITICAL ordering constraint**: `persistPlan` rebuilds `plan.json` keeping only entries that pass `isPlanV2` (`story.ts:680-684`). Bumping the version check to 3 **before** implementing v2 archival would silently delete every existing v2 plan on the next write. Archival (FR-018) MUST land in the same change as the version bump (FR-017), verified by a test.

### Relevant Execution Flows

| Flow Name | Relevance |
|---|---|
| `tool.execute.after` → mutation path (`plugin.ts:476-500`) | Calls `checkScope`; must see union scope |
| `tool.execute.after` → verification path (`plugin.ts:526-591`) | Mints receipts; the only place receipts are created; session-gated |
| `experimental.chat.system.transform` (`plugin.ts:~700-830`) | Builds `Finding[]`; two new families injected here |
| `event(session.idle)` → `handleSessionIdle` (`gate.ts:300`) | Reads active story for prescription + verifier payload |
| `elicify_vertex_plan_checkpoint` (`tools.ts:152-205`) | Evidence validation + successor promotion |

### Cluster Placement

This feature belongs to the **story-contract / plan lifecycle** cluster (`story.ts` + `wiring/tools.ts`), spanning into the **injection composer** cluster (two new finding families) and the **phase engine** cluster (concurrency correctness). It does **not** touch the receipt, redaction, verifier, or measurement clusters.

---

## User Stories & Acceptance Criteria

### User Story 1 — Declare stories in waves (Priority: P0)

An operator running a multi-story task wants independent stories grouped into a single wave so subagents can deliver them concurrently, instead of the harness forcing a strictly serial walk. Today the plan model can only represent one active story, so any parallel execution is invisible to — and actively penalised by — the harness.

**Why this priority**: Every other story in this spec depends on the wave grouping existing in the schema. Without it there is nothing to activate concurrently.

**Independent Test**: Create a plan with three stories declared `wave: 1` and one declared `wave: 2`; read back `plan.json` and confirm the wave assignment persisted and all three wave-1 stories are `active`.

**Acceptance Scenarios**:

1. **Given** a plan request with three stories each declaring `wave: 1`, **When** `elicify_vertex_plan_create` is called, **Then** all three stories are persisted with `wave: 1` and `status: "active"`, each carrying an identical `startedAt`.
2. **Given** a plan request where a story omits `wave`, **When** the plan is created, **Then** the story is assigned to wave 1 by default.
3. **Given** a plan request with stories declaring waves `1` and `3` (gap), **When** the plan is created, **Then** waves are normalised to contiguous ordinals `1, 2` preserving relative order.
4. **Given** two stories with disjoint `scopeGlobs` declared in different waves, **When** the plan is created, **Then** creation succeeds **and** a `wave:over-serialised` event is logged naming both story ids.

---

### User Story 2 — Auto-appended verification story per wave (Priority: P0)

The harness must guarantee a verification step exists for every wave, authored by the plugin rather than the model, so verification cannot be quietly omitted from the plan. v1 did this once per plan; v2 lost it entirely.

**Why this priority**: This is the mandatory step the operator requires. Without it, waves have no gate and the feature reduces to "parallel bookkeeping".

**Independent Test**: Create a plan with two delivery stories in wave 1; confirm `plan.json` contains a third story with `kind: "verification"`, `wave: 1`, whose acceptance items name the two delivery stories.

**Acceptance Scenarios**:

1. **Given** a wave containing delivery stories S1 and S2, **When** the plan is created, **Then** a verification story is appended to that wave with `kind: "verification"` and one acceptance item per delivery story, each naming that story's id.
2. **Given** a created plan, **When** the model attempts to author a story with `kind: "verification"`, **Then** the field is ignored and the story is stored as `kind: "delivery"`.
3. **Given** a plan with waves 1 and 2, **When** the plan is created, **Then** each wave has exactly one verification story.
4. **Given** a verification story, **When** `elicify_vertex_plan_deliver` is called on it, **Then** the call is rejected — verification stories are completed via checkpoint with receipts, never "delivered".

---

### User Story 3 — Deliver without evidence, verify with it (Priority: P0)

Subagents deliver work but structurally cannot produce verification receipts (the receipt store is session-keyed and `tool.execute.after` returns early for non-activated sessions). The main agent must therefore mark stories delivered, then verify them itself. Delivery needs a no-evidence path; verification keeps the existing evidence bar.

**Why this priority**: Without a delivery status there is no way to record subagent output, and no trigger point for the mandatory verification step.

**Independent Test**: Call `elicify_vertex_plan_deliver` on an active story with no receipts; confirm it succeeds and the story is `delivered`; confirm `checkpoint` on the same story still requires a receipt.

**Acceptance Scenarios**:

1. **Given** an active delivery story, **When** `elicify_vertex_plan_deliver(storyId)` is called with no evidence, **Then** the story becomes `delivered` and the call succeeds.
2. **Given** the last outstanding delivery story in a wave, **When** it is delivered, **Then** the tool's return value contains a mandatory-next-step instruction naming every delivery story in the wave and its resolved verifier.
3. **Given** a wave that is not yet fully delivered, **When** a story is delivered, **Then** the return value reports remaining undelivered story ids and does not emit the mandatory-next-step instruction.
4. **Given** a `delivered` story, **When** `checkpoint(storyId, "complete")` is called with a valid receipt, **Then** the story becomes `complete`.
5. **Given** a `delivered` story, **When** `checkpoint(storyId, "complete")` is called without valid evidence, **Then** the checkpoint is rejected and the story remains `delivered`.

---

### User Story 4 — Wave-gated progression (Priority: P0)

Wave N+1 must not activate until wave N's verification story is complete. This gate — not any injected prompt — is what makes the mandatory verification deterministic, because it cannot be talked past by the model.

**Why this priority**: This is the sole non-bypassable enforcement mechanism in the feature. Directives can be ignored; this cannot.

**Independent Test**: Create a two-wave plan, deliver and checkpoint all wave-1 delivery stories but leave the wave-1 verification story incomplete; confirm no wave-2 story is `active`.

**Acceptance Scenarios**:

1. **Given** all wave-1 delivery stories are `complete` but the wave-1 verification story is not, **When** the plan state is read, **Then** every wave-2 story remains `pending`.
2. **Given** wave 1 fully complete including its verification story, **When** that verification story is checkpointed complete, **Then** all wave-2 stories transition to `active` with an identical `startedAt` set at that moment.
3. **Given** a wave-1 verification story, **When** checkpoint is attempted while any wave-1 delivery story lacks a receipt, **Then** the checkpoint is rejected naming the specific unevidenced story.
4. **Given** the final wave's verification story, **When** it is checkpointed complete, **Then** the plan has no `active` stories and is considered finished.

---

### User Story 5 — Rework loop on failed verification (Priority: P1)

When a delivered story's verifier goes red, that story must return to `active` so it can be fixed and re-verified, while the wave stays open and downstream waves stay blocked.

**Why this priority**: Without a defined failure path the plan deadlocks on the first red test — high likelihood in real use, but not required for the happy path to work.

**Independent Test**: Deliver a story, checkpoint it `failed`, confirm it returns to `active` with its original `startedAt` preserved and the wave verification story still incomplete.

**Acceptance Scenarios**:

1. **Given** a `delivered` story, **When** `checkpoint(storyId, "failed")` is called, **Then** the story returns to `active` and retains its original `startedAt`.
2. **Given** a story returned to `active` by a failed verification, **When** the wave's verification story is checkpointed, **Then** it is rejected because that story has no receipt.
3. **Given** a story returned to `active`, **When** it is re-delivered and checkpointed complete with a fresh receipt, **Then** it becomes `complete` and the wave can proceed.
4. **Given** a `delivered` story, **When** `checkpoint(storyId, "blocked")` is called, **Then** the story becomes `blocked` (terminal) and the wave verification story can never complete, leaving the plan halted.

---

### User Story 6 — Wave-verification directive (Priority: P1)

While any wave is delivered-but-unverified, the composer must surface a `correction`-priority directive telling the agent to verify each story itself, so the mandatory step is visible across turns rather than only in one tool return.

**Why this priority**: Raises compliance materially, but the hard gate (US-4) already guarantees correctness without it.

**Independent Test**: Put a plan in the delivered-but-unverified state and invoke `system.transform`; confirm a `wave-verification` directive is rendered.

**Acceptance Scenarios**:

1. **Given** a wave where all delivery stories are `delivered` and the verification story is incomplete, **When** `system.transform` runs, **Then** a `wave-verification` finding is rendered at `correction` priority naming the unverified story ids.
2. **Given** the same state persisting across turns, **When** `system.transform` runs on a later turn, **Then** the finding renders again (it is not suppressed as stale).
3. **Given** a wave whose verification story is complete, **When** `system.transform` runs, **Then** no `wave-verification` finding is produced.

---

### User Story 7 — Delegation-gap nudge (advisory) (Priority: P1)

When a wave holds two or more delivery stories and no subagent (`task`) calls were observed, the harness should nudge toward parallel fanout — without ever blocking, since the check is trivially gameable and legitimate sequential execution exists.

**Why this priority**: Delivers the "prioritise parallel" intent, but is explicitly advisory by operator decision.

**Independent Test**: Activate a 3-story wave, run a turn with no `task` tool call, confirm a `delegation-gap` finding is produced and that plan progression is unaffected.

**Acceptance Scenarios**:

1. **Given** an active wave with ≥2 delivery stories and no `task` tool call observed this turn, **When** `system.transform` runs, **Then** a `delegation-gap` finding is rendered at `phase-guidance` priority.
2. **Given** a `task` tool call was observed this turn, **When** `system.transform` runs, **Then** no `delegation-gap` finding is produced.
3. **Given** a `delegation-gap` finding was ignored, **When** the wave is delivered, **Then** delivery succeeds — the finding never blocks.
4. **Given** an active wave with exactly one delivery story, **When** `system.transform` runs, **Then** no `delegation-gap` finding is produced.

---

### User Story 8 — Union scope watchdog (Priority: P1)

With several stories active at once, scope drift must be verifierd against the union of their `scopeGlobs`, not one story's.

**Why this priority**: Without it the watchdog fires on nearly every mutation during a wave, flooding the composer budget.

**Independent Test**: Activate a wave with two stories scoped to `src/a/**` and `src/b/**`; mutate `src/b/x.ts`; confirm no scope finding.

**Acceptance Scenarios**:

1. **Given** active stories scoped to `src/a/**` and `src/b/**`, **When** `src/b/x.ts` is mutated, **Then** `checkScope` returns `null`.
2. **Given** the same stories, **When** `docs/readme.md` is mutated, **Then** `checkScope` returns a scope-watchdog finding.
3. **Given** active stories where at least one declares empty `scopeGlobs`, **When** any path is mutated, **Then** `checkScope` returns `null` (an unconstrained story makes the wave unconstrained).

---

### User Story 9 — Schema v3 with safe archival (Priority: P0)

`plan.json` moves to `schemaVersion: 3`. No migration or backward compatibility is required, but an existing v2 plan must be archived rather than silently destroyed.

**Why this priority**: Must land atomically with the schema change; `persistPlan` drops non-validating entries, so a version bump without archival destroys data.

**Independent Test**: Place a v2 `plan.json` on disk, run any story-tool method, confirm the file is moved byte-identically under `archive/` and a fresh v3 plan can be created.

**Acceptance Scenarios**:

1. **Given** a `plan.json` with `schemaVersion: 2`, **When** any story-tool method runs, **Then** the file is moved to `archive/plan.<ISO-8601>.json` byte-identically via atomic rename, and a `story:v2-archived` event is logged.
2. **Given** an archived v2 plan, **When** a new plan is created, **Then** `plan.json` contains only the new `schemaVersion: 3` plan.
3. **Given** a `plan.json` already at `schemaVersion: 3`, **When** any story-tool method runs, **Then** no archival occurs.
4. **Given** an `archive/` directory already containing a file at the target name, **When** archival runs, **Then** a numeric suffix is appended and no existing archive file is overwritten.

---

### User Story 10 — The verifier detects incompleteness at idle (Priority: P0)

When the agent goes idle, the verifier must assess **whether the declared work is actually complete** and, if not, drive a continuation naming what is missing. Today the verifier runs only after the final story is already `complete` — it validates work that has already declared itself done, which is QA, not self-correction. The valuable moment is precisely the one it cannot see: the agent stopping early with stories unstarted and acceptance items unevidenced.

**Why this priority**: This is the inversion the feature exists for. Without it, a long autonomous run ends silently at 20% completion, exactly as observed in the field session (D2/D3).

**Independent Test**: Put a plan in a partially-complete state, fire `session.idle`, and confirm the verifier is invoked with the incomplete plan and its verdict drives a continuation naming the unfinished stories.

**Deterministic-first ordering (load-bearing)**: the verifier is the **last** check at idle, not the first. Any deterministic gap — a story not complete, an acceptance item unevidenced, unverified changes, a missing plan — is answered by a direct continuation and the verifier is **not invoked at all**. The verifier runs only when the deterministic layer has no remaining objection, because that is the only moment its answer is not already known. This makes it cheap (at most one invocation per "looks done" idle rather than per idle) and targets it at the one question a state machine cannot answer: *is this substantively complete, or merely checked off?*

**Acceptance Scenarios**:

1. **Given** an active plan with ≥1 story not `complete` or ≥1 acceptance item unevidenced, **When** `session.idle` fires, **Then** a deterministic continuation is dispatched naming the specific gap **and the verifier is not invoked**.
2. **Given** an active plan where every story is `complete` and every acceptance item is evidenced, **When** `session.idle` fires, **Then** the verifier is invoked with a completion-oriented payload containing the original ask, every story's status, and the evidence bound to each acceptance item.
3. **Given** a verifier verdict of `complete: false`, **When** the verdict is returned, **Then** a continuation is dispatched naming each item in `missing` and the verdict's `nextAction`.
4. **Given** a verifier verdict of `complete: true`, **When** the verdict is returned, **Then** no continuation is dispatched and the session is permitted to close.
5. **Given** every deterministic check passes and the verifier is unsupported, times out, or returns malformed output, **When** `session.idle` fires, **Then** no continuation is dispatched, the session is permitted to close, and a `verifier:unavailable-at-close` event is logged.
6. **Given** the verifier has already driven `maxVerifierContinuations` continuations this session, **When** `session.idle` fires again with deterministic checks passing, **Then** the verifier is not invoked and the session is permitted to close.
7. **Given** two consecutive verifier verdicts report an identical `missing` set with no new evidence recorded between them, **When** the second verdict returns, **Then** no continuation is dispatched and a `verifier:no-progress` event is logged.
8. **Given** no plan exists and the ask was classified multi-story, **When** `session.idle` fires, **Then** a deterministic plan-required continuation is dispatched and the verifier is not invoked.

---

### User Story 11 — Covering verifiers are not relevance gaps (Priority: P0)

A verifier that covers **more** than the prescribed one must count as satisfying it. Running the full suite is the single most common thing an agent does, and today it is always scored as a miss whenever a narrower command was prescribed — which suppresses the receipt and destroys the entire evidence chain.

**Why this priority**: Blocking. Verified against the shipped `verifiersEquivalent`: `go test ./...` vs `go test ./internal/auth/...` → gap, and `npm test` vs `npx vitest run tests/lexer.test.ts` → gap. No evidence can be collected in any project until this is fixed.

**Independent Test**: Call the relevance check with a full-suite observed command against a narrower prescribed command and confirm it is not reported as a gap.

**Acceptance Scenarios**:

1. **Given** a prescribed verifier targeting specific paths, **When** the observed verifier targets a superset of those paths, **Then** no relevance gap is reported and a receipt is minted.
2. **Given** a prescribed verifier targeting specific paths, **When** the observed verifier is a whole-suite command with no path arguments, **Then** no relevance gap is reported.
3. **Given** a prescribed verifier, **When** the observed verifier targets a strict subset or a disjoint set of paths, **Then** a relevance gap **is** reported.
4. **Given** a prescribed verifier, **When** the observed verifier is an unrelated command, **Then** a relevance gap is reported.
5. **Given** an observed command whose exit code is unreliable because it is piped, **When** the relevance check runs, **Then** the pre-existing ambiguity handling is unchanged by this feature.

---

### User Story 12 — The plan drives itself to completion (Priority: P0)

While a plan has unfinished stories and the session goes idle, the harness must deterministically re-inject the active story and its next legal step — independent of the verifier, so the loop survives verifier unavailability. This is the deterministic floor beneath US-10.

**Why this priority**: This is the primary completion driver, not a fallback. It runs **before** the verifier at every idle and answers every gap the state machine can see — which is most of them, faster, more precisely, and at zero token cost. It also gates the verifier (FR-038): while this layer has an objection, the verifier is never invoked.

**Independent Test**: Put a plan in a partially-complete state with the verifier disabled, fire `session.idle`, and confirm a continuation naming the active story is dispatched.

**Acceptance Scenarios**:

1. **Given** a plan with ≥1 `active` or `pending` story, **When** `session.idle` fires, **Then** a `plan-progress` continuation is dispatched naming the active story, its unevidenced acceptance items, and the next legal step, **and the verifier is not invoked**.
2. **Given** `maxPlanProgressContinuations` have already been dispatched for this plan, **When** `session.idle` fires again, **Then** no further plan-progress continuation is dispatched.
3. **Given** a plan whose stories are all `complete` with every acceptance item evidenced, **When** `session.idle` fires, **Then** no plan-progress continuation is dispatched and control passes to the verifier.
4. **Given** a plan containing a `blocked` or `failed` story, **When** `session.idle` fires, **Then** a continuation naming that story is dispatched and the verifier is not invoked — a halted plan is deterministically incomplete.
5. **Given** every story is `complete` but one acceptance item's receipt no longer validates (e.g. invalidated by a later mutation), **When** `session.idle` fires, **Then** a `plan-progress` continuation naming that item is dispatched and the verifier is not invoked.

---

### User Story 13 — Enforced plan quality and mandatory planning (Priority: P0)

Multi-step work must produce a real plan with verifiable acceptance criteria, not a one-line gesture. `createPlan` must reject structurally inadequate plans deterministically, and an idle session doing multi-step work without a plan must be driven to create one.

**Why this priority**: A plan with vague stories and no verifiers produces useless prescriptions — and directly worsens D1, because a story with no `verifiers` and no `scopeGlobs` makes the resolver prescribe something the agent will never naturally run.

**Independent Test**: Attempt to create a plan whose story has zero acceptance items, and one whose story declares neither `verifiers` nor `scopeGlobs`; confirm both are rejected with specific messages.

**Acceptance Scenarios**:

1. **Given** a plan request where a delivery story has zero acceptance items, **When** `elicify_vertex_plan_create` is called, **Then** it is rejected naming that story.
2. **Given** a plan request where a delivery story declares neither `verifiers` nor `scopeGlobs`, **When** the plan is created, **Then** it is rejected naming that story and stating that one of the two is required.
3. **Given** a plan request where a story's text or an acceptance item is blank or whitespace-only, **When** the plan is created, **Then** it is rejected naming the offending field.
4. **Given** a plan request where two stories in the same wave share an identical text, **When** the plan is created, **Then** it is rejected as ambiguous.
5. **Given** intake classified the ask as multi-story and no plan exists, **When** `session.idle` fires, **Then** a continuation is dispatched requiring a plan before further work, capped at `maxPlanProposalContinuations`.

---

### User Story 14 — Turn advancement during autonomous work (Priority: P1)

The composer's per-turn caps must reset on each model reply cycle, not only on a new user message, so directives keep being delivered through a long autonomous run.

**Why this priority**: Observed 2% directive delivery rate (5 rendered / 250 dropped). Every other directive in this spec — including the wave-verification mandate — is throttled to near-zero without it.

**Independent Test**: Drive several assistant reply cycles with no user message and confirm `turnIndex` advances and a capped family renders more than once.

**Acceptance Scenarios**:

1. **Given** an active session, **When** an assistant reply cycle completes without any new user message, **Then** `composer.newTurn` is called and `turnIndex` advances.
2. **Given** a per-turn-capped family that already rendered this turn, **When** a new assistant reply cycle begins, **Then** that family is eligible to render again.
3. **Given** a reentrant continuation from the harness itself, **When** it is processed, **Then** the turn does not advance twice for the same reply cycle.

---

### User Story 15 — Visible signalling of harness activity (Priority: P1)

An operator watching a long run currently has almost no signal that the harness is doing anything. In the 1h34m field session the entire user-visible output was **one line** (`[vertex] harness on · stopMode=normal · build`, 07:54) while 5 directives rendered invisibly and 250 were silently dropped. When the harness is working, invisibility is correct — chat should not be flooded with directive bodies. When it is *broken*, invisibility is actively harmful: there was no way to tell that evidence collection had been dead for 94 minutes.

The injection mechanism itself is unchanged: mid-turn directives continue to go to the model via `experimental.chat.system.transform` (full O-D-P-E body), and idle corrections continue to go via `session.prompt` (already user-visible as a real message). What is added is a **parallel, non-intrusive notification channel** — `client.tui.showToast` — carrying a compact summary of the same event.

**Why this priority**: It does not change harness behaviour, only observability. But without it, defects like D1 stay invisible for entire sessions.

**Independent Test**: With visibility enabled, render one mid-turn directive and confirm exactly one toast is emitted whose message names the directive family; with visibility off, confirm none is emitted.

**Rejected alternatives** (evaluated against the live host, recorded so they are not revisited):
- *Programmatic tool part via `session.shell`* — verified it does create a genuine model-independent tool part, but it always renders as `bash` (no custom tool name), spawns a real shell per directive, emits 2 messages per injection, and its output is prefixed with unsuppressible shell-profile noise (`true`, which outputs nothing, still produced 3 lines of it). Rejected on legibility and cost.
- *Fabricating a tool part directly* — impossible; the session API exposes no part-creation endpoint (`/session/{id}/message` is read-only). Tool parts originate only from model invocations.
- *`tui.publish`* — limited to prompt-append / command-execute / toast-show; no custom payload.
- *`tui.appendPrompt`* — writes into the user's prompt box and would fight their typing.
- *Dumping directive bodies into chat every turn* — explicitly a non-goal in `docs/REQUIREMENTS-INJECTION-VISIBILITY.md` (operator-approved 2026-07-24).

**Acceptance Scenarios**:

1. **Given** visibility is enabled, **When** a directive is rendered into the system prompt, **Then** exactly one toast is emitted whose message names the directive family and its prescription, and the system-prompt injection is unchanged.
2. **Given** visibility is set to `off`, **When** a directive is rendered, **Then** no toast is emitted and the system-prompt injection is unchanged.
3. **Given** visibility is set to `gates`, **When** a routine mid-turn directive is rendered, **Then** no toast is emitted; **but when** a gate fires or a health/failure signal occurs, **Then** a toast is emitted.
4. **Given** a health/failure condition (`verify:relevance-gap`, `verifier:unavailable`, receipt-not-minted, directive dropped at ≥90% for a turn), **When** it occurs with visibility enabled, **Then** a toast is emitted with variant `warning` or `error`.
5. **Given** the toast call fails or the host has no TUI attached, **When** a toast is attempted, **Then** the failure is swallowed and no harness behaviour changes.
6. **Given** more than `maxToastsPerMinute` toasts would be emitted, **When** the cap is reached, **Then** further toasts are suppressed for the remainder of that window and one summary toast reports the suppressed count.
7. **Given** the same directive family and instance id would toast twice, **When** the duplicate is attempted, **Then** it is suppressed.
8. **Given** a user runs the visibility toggle command, **When** it executes, **Then** the session's visibility mode changes and the new mode is confirmed to the user.

---

### User Story 16 — Requirements are understood before planning begins (Priority: P0)

The agent currently receives a request and goes straight to planning and executing on its own interpretation. The existing intake scaffold (`intakeScaffoldFinding`, `wiring/findings.ts:95`) asks for `OUTCOME:` / `ASSUMPTIONS:` / `CRITERIA:`, but has two structural weaknesses: `ASSUMPTIONS:` is a **declaration**, not a resolution — the model records its guess and proceeds — and **nothing checks compliance**, since `plan_create` has no intake precondition. In the field session this finding was dropped 87 times and rendered twice.

**Why this priority**: A plan built on an unexamined misreading is worse than no plan — every downstream gate then faithfully verifies the wrong thing.

**Independent Test**: Issue a non-trivial ambiguous request, and confirm `plan_create` is rejected until an intake record exists and a genuine user message has confirmed the proposal.

**Design note — no generic checklist.** A fixed dimension checklist (actors / scope / constraints / …) was evaluated and **rejected**: it is either too abstract to bite ("the scope is to fix the bug") or too specific to generalise across the real spread of requests (a typo fix has no actors; a perf task needs a latency target; a refactor needs "what behaviour must stay identical"). Instead, ambiguity surfacing is **self-tailoring**:

- **Generation over judgment** — "list 3 ways this request could be misread" adapts to the request automatically. Generating ambiguity is something models do well; judging whether something is clear is a calibration task they do badly, which is also why a self-reported confidence score is not used as a gate.
- **Testability as the detector** — every acceptance criterion must name the command that would prove it. A criterion with no possible proving command **is** the unknown, surfaced from the request itself with no taxonomy to maintain. This also guarantees stories arrive with usable `verifiers`, which FR-054 requires anyway.
- **Two universal anchors only** — "what does done look like, concretely?" and "what must not change?". Everything else is generated.

**Resolution order — ground first, then ask.** An unknown MUST NOT go straight to the human. The agent is required to first attempt resolution from evidence it can obtain itself, in this order:

1. **The codebase** — read the relevant source, tests, config, and git history.
2. **Available datasources** — any MCP server, documentation tool, or project artifact the session has access to.
3. **Web research** — where the session has that capability and the unknown is externally answerable (an API contract, a library's behaviour, a standard).

Only unknowns that survive grounding are eligible to be asked. This keeps the human out of questions the agent could have answered, which is the failure mode that makes clarification loops annoying enough to be switched off.

**Interactive vs autonomous.** "Interactive" means a genuine (non-harness-authored) user message has occurred in this session — reusing the `harnessAuthoredIds` tracking that FR-067a introduces for confirmation, so there is exactly one definition of "a human is present".

- **Interactive** → every surviving unknown MUST be asked via the host `question` tool, one question per unknown, in plain English, with concrete options and exactly one option marked `(Recommended)`. The agent MUST NOT proceed to `plan_create` while a surviving unknown is unasked.
- **Autonomous** → the agent MUST NOT ask (there is nobody to answer, and the question tool blocks the model's turn with no way to release it). Surviving unknowns resolve as `ASSUMED` with rationale and stated risk, and are surfaced to the verifier at close.

**No timeout.** The host `question` tool exposes no timeout, expiry, or deadline field, and the reply/reject endpoints that would let the harness auto-answer exist only on the v2 SDK surface — the plugin receives the v1 client, which does not expose `question.*` at all. A harness-side timeout is therefore not implementable without reaching into private SDK internals, and is explicitly out of scope. The interactive/autonomous split above is what handles an absent human.

**Question shape.** `QuestionInfo` provides `{question, header (≤30 chars), options: [{label, description}], multiple?, custom?}`. There is **no `recommended` field**, so the recommendation MUST be encoded in the option label (e.g. `"Freeze at checkpoint (Recommended)"`) and the recommended option MUST be listed first.

**Acceptance Scenarios**:

1. **Given** a non-trivial ask and no intake record, **When** `elicify_vertex_plan_create` is called, **Then** it is rejected stating that intake must be captured first.
2. **Given** an intake record exists but no user message has confirmed the proposal, **When** `plan_create` is called, **Then** it is rejected stating that user confirmation is required.
3. **Given** a `confirmedByMessageId` that does not resolve to a real `role: "user"` message, **When** `plan_create` is called, **Then** it is rejected — confirmation is proven via `isUserMessage`, never accepted on the model's assertion.
4. **Given** a `confirmedByMessageId` resolving to a genuine user message sent **before** the proposal was made, **When** `plan_create` is called, **Then** it is rejected — confirmation must postdate the proposal.
5. **Given** an intake record, **When** it is validated, **Then** it MUST contain a one-line outcome, an explicit out-of-scope statement, ≥1 generated potential misreading, and an `UNKNOWNS` list in which every entry is resolved as either `ANSWERED` (with the answering user message id) or `ASSUMED` (with a rationale and stated risk).
6. **Given** an acceptance criterion with no accompanying proving command, **When** the intake record is validated, **Then** it is rejected naming that criterion as underspecified.
7. **Given** a trivial ask (matching `TRIVIAL_ASK_RE`), **When** the agent proceeds, **Then** no intake is required and no intake directive is rendered.
8. **Given** a non-trivial ask with no intake record, **When** `system.transform` runs, **Then** an intake directive is rendered at `correction` priority (raised from `phase-guidance`, so it is not crowded out).
9. **Given** an `UNKNOWNS` entry marked `ASSUMED` with no recorded grounding attempt, **When** the intake record is validated, **Then** it is rejected — grounding must be attempted before an unknown may be assumed.
10. **Given** an interactive session with ≥1 surviving unknown and no observed `question` tool call, **When** `plan_create` is called, **Then** it is rejected stating that surviving unknowns must be asked.
11. **Given** an interactive session, **When** the agent asks a surviving unknown, **Then** the question carries plain-English text, ≥2 concrete options, and exactly one option labelled `(Recommended)` listed first.
12. **Given** an autonomous session (no genuine user message this session), **When** unknowns survive grounding, **Then** no question is asked, each unknown resolves as `ASSUMED` with rationale and risk, and those assumptions are included in the verifier payload at close.

---

## Behavioral Contract

Primary flows:
- When a directive is rendered and visibility is enabled, the system emits one compact toast alongside the unchanged system-prompt injection.
- When the toast channel is unavailable, the system continues unchanged — visibility is never on the critical path.
- When a plan is created with stories declaring waves, the system groups them by wave, appends one verification story per wave, and activates every story in wave 1 with a shared `startedAt`.
- When the session goes idle with a plan that is not complete, the system invokes the verifier to assess completion and, on `complete: false`, dispatches a continuation naming what is missing.
- When the verifier is unavailable and a plan has unfinished stories, the system dispatches a deterministic plan-progress continuation instead.
- When an observed verifier covers the prescribed one, the system records it as a valid verification and mints a receipt.
- When an assistant reply cycle completes, the system advances the composer turn so per-turn caps reset.
- When a delivery story is delivered, the system records `delivered` without requiring evidence.
- When the last delivery story in a wave is delivered, the system returns a mandatory-next-step instruction naming each story and its verifier.
- When every delivery story in a wave holds a valid receipt, the system permits the wave's verification story to complete.
- When a wave's verification story completes, the system activates the next wave with a shared `startedAt`.

Error flows:
- When a checkpoint is attempted on a story lacking valid evidence, the system rejects it and leaves the plan byte-identical.
- When a wave verification story is checkpointed while any delivery story lacks a receipt, the system rejects it naming that story.
- When a delivered story is checkpointed `failed`, the system returns it to `active` preserving `startedAt`.
- When a v2 plan is found on disk, the system archives it reversibly before writing v3.

Boundary conditions:
- When a story omits `wave`, the system assigns wave 1.
- When declared waves are non-contiguous, the system normalises them to contiguous ordinals preserving order.
- When any active story declares empty `scopeGlobs`, the system treats the wave as unconstrained.
- When a wave contains exactly one delivery story, the system still appends a verification story and emits no delegation-gap finding.

---

## Edge Cases

- **A wave with zero delivery stories** (model declares only wave 2, none in wave 1). Expected: waves normalise so the first populated wave becomes wave 1; empty waves never exist.
- **A verifier that writes files during the verification batch** (coverage, snapshots). Expected: `verificationReceipts.invalidate` wipes *live* receipts, so any not-yet-checkpointed item loses its evidence and must be re-verified (FR-087). Already-checkpointed items are unaffected — their evidence is frozen in `plan.json` (FR-082…FR-086). This narrows the exposure to the window between earning a receipt and checkpointing it.
- **A subagent that keeps writing after the wave is marked delivered.** Expected: `file.edited` invalidates receipts; checkpoint then fails; story must be re-verified.
- **`checkpoint` called on a `pending` story** (wave not yet active). Expected: rejected, naming the story's wave and the current gating wave.
- **`plan_deliver` called twice on the same story.** Expected: idempotent — second call succeeds, status stays `delivered`, no duplicate mandatory-next-step emission.
- **All stories in one wave, single wave total.** Expected: one delivery wave + its verification story; on completion the plan finishes with no active stories.
- **Model declares 50 stories in wave 1.** Expected: accepted; no cap imposed by this feature (composer caps limit *directives*, not plan size).
- **Concurrent `checkpoint` calls for two stories in the same wave.** Expected: serialised by the existing `.elicify-vertex/` directory lock; both persist.
- **`getPhase(sessionID)` called with no storyId during a multi-story wave.** Expected: returns a deterministic value, not "whichever story was touched last" (see FR-020).

---

## Explicit Non-Behaviors

- The system must not allow a subagent session to mint a verification receipt, because evidence must be observed by the main agent — this is currently enforced by `VerificationReceiptStore` being session-keyed plus `tool.execute.after`'s activation guard, and that enforcement must survive this change.
- The system must not block a wave for lack of `task` tool calls, because the check is satisfiable with one throwaway subagent and would deadlock legitimate sequential execution.
- The system must not auto-generate delivery stories, because plan content is the model's and the user's responsibility; only *verification* stories are synthesised.
- The system must not permit the model to author, edit, or delete a `kind: "verification"` story, because a model-editable gate is not a gate.
- The system must not convert or reinterpret an existing `schemaVersion: 2` plan, because the operator explicitly declined migration; it is archived untouched.
- The system must not weaken `isFreshReceipt`'s time bound, workspace check, or exit-code check to accommodate parallelism — wave-start `startedAt` is what makes the existing bound correct.
- The system must not emit the mandatory-next-step instruction more than once per wave delivery completion, because repeated identical tool output trains the model to skim it.
- The system must not activate a later wave to "unblock" a halted plan when a story is `blocked`, because that would silently discard the block.

---

## Integration Boundaries

### OpenCode host — tool registration and invocation

- **Data in**: Tool-call arguments for `elicify_vertex_plan_create` / `_deliver` / `_checkpoint` / `_next` / `_status` / `_clear`; `tool.execute.after` notifications carrying `{tool, sessionID, args}` and `{output, metadata}`.
- **Data out**: Tool return strings (JSON plan state, plus the mandatory-next-step instruction on wave delivery completion).
- **Contract**: `@opencode-ai/plugin` `tool()` helper; `ToolResult = string | {output, title?, metadata?}`; `ToolContext.sessionID` identifies the calling session.
- **On failure**: A thrown error inside a tool surfaces to the model as a tool error; the plan file is left byte-identical (validation precedes mutation).
- **Development**: Real host for end-to-end runs; existing vitest stubs (`tests/v2/plugin.integration.test.ts`'s `makeStubClient`) for unit/integration.

### OpenCode host — subagent (`task`) delegation

- **Data in**: Observation only — `tool.execute.after` with `tool === "task"`.
- **Data out**: Nothing; the plugin never spawns subagents itself.
- **Contract**: Presence of a `task` tool call in the current turn.
- **On failure**: If `task` calls are unobservable, the `delegation-gap` finding simply never fires — advisory only, so no correctness impact.
- **Development**: Real host; stubbed by driving `tool.execute.after` with `tool: "task"` in tests.

### Filesystem — `.elicify-vertex/` state directory

- **Data in**: `plan.json` (v3), `archive/` contents.
- **Data out**: Atomic writes of `plan.json`; atomic renames into `archive/`.
- **Contract**: Existing `acquireStateLock()` directory lock (30s staleness reclaim); `wx` temp file + rename; mode `0600`.
- **On failure**: An unparseable `plan.json` aborts the write and logs `story:disk-corrupt` rather than overwriting other sessions' entries (existing behaviour, preserved).
- **Development**: Real filesystem in `mkdtempSync` temp roots, per existing `story.test.ts` convention.

---

## BDD Scenarios

### Feature: Wave-Based Parallel Story Execution

#### Scenario: Three independent stories activate together in wave 1

**Traces to**: User Story 1, Acceptance Scenario 1
**Category**: Happy Path

- **Given** a plan request with stories S1, S2, S3 each declaring `wave: 1`
- **When** `elicify_vertex_plan_create` is called
- **Then** S1, S2 and S3 all have `status: "active"`
- **And** all three carry an identical `startedAt` timestamp
- **And** each has `wave: 1`

---

#### Scenario: A story omitting wave defaults to wave 1

**Traces to**: User Story 1, Acceptance Scenario 2
**Category**: Edge Case

- **Given** a plan request where story S1 declares no `wave` field
- **When** the plan is created
- **Then** S1 has `wave: 1`
- **And** S1 has `status: "active"`

---

#### Scenario Outline: Non-contiguous declared waves normalise to contiguous ordinals

**Traces to**: User Story 1, Acceptance Scenario 3
**Category**: Edge Case

- **Given** a plan request whose stories declare waves `<declared>`
- **When** the plan is created
- **Then** the resulting delivery-story waves are `<normalised>`

**Examples**:

| declared | normalised | note |
|---|---|---|
| 1, 1, 3 | 1, 1, 2 | gap closed, order preserved |
| 2, 2 | 1, 1 | first populated wave becomes 1 |
| 5, 1 | 2, 1 | ordering by declared value, not array position |
| 1, 2, 3 | 1, 2, 3 | already contiguous, unchanged |

---

#### Scenario: Needlessly serialised disjoint stories are flagged but permitted

**Traces to**: User Story 1, Acceptance Scenario 4
**Category**: Alternate Path

- **Given** story S1 scoped `src/a/**` declaring `wave: 1`
- **And** story S2 scoped `src/b/**` declaring `wave: 2`
- **When** the plan is created
- **Then** the plan is created successfully with S1 in wave 1 and S2 in wave 2
- **And** a `wave:over-serialised` event is logged naming S1 and S2

---

#### Scenario: A verification story is appended to each wave

**Traces to**: User Story 2, Acceptance Scenario 1
**Category**: Happy Path

- **Given** a wave containing delivery stories S1 and S2
- **When** the plan is created
- **Then** that wave contains a third story with `kind: "verification"`
- **And** that story has exactly two acceptance items
- **And** one acceptance item names S1 and the other names S2

---

#### Scenario: A model-authored verification kind is ignored

**Traces to**: User Story 2, Acceptance Scenario 2
**Category**: Error Path

- **Given** a plan request where a story declares `kind: "verification"`
- **When** the plan is created
- **Then** that story is stored with `kind: "delivery"`
- **And** a separate plugin-authored verification story exists in its wave

---

#### Scenario: Every wave gets exactly one verification story

**Traces to**: User Story 2, Acceptance Scenario 3
**Category**: Happy Path

- **Given** a plan request with two stories in wave 1 and one story in wave 2
- **When** the plan is created
- **Then** wave 1 contains exactly one story with `kind: "verification"`
- **And** wave 2 contains exactly one story with `kind: "verification"`

---

#### Scenario: A verification story cannot be delivered

**Traces to**: User Story 2, Acceptance Scenario 4
**Category**: Error Path

- **Given** a wave whose verification story is active
- **When** `elicify_vertex_plan_deliver` is called on the verification story
- **Then** the call is rejected with an error naming the story as a verification story
- **And** the story's status is unchanged

---

#### Scenario: A delivery story is marked delivered without evidence

**Traces to**: User Story 3, Acceptance Scenario 1
**Category**: Happy Path

- **Given** an active delivery story S1 with no receipts in the session
- **When** `elicify_vertex_plan_deliver("S1")` is called
- **Then** the call succeeds
- **And** S1 has `status: "delivered"`

---

#### Scenario: Completing a wave's delivery emits the mandatory next step

**Traces to**: User Story 3, Acceptance Scenario 2
**Category**: Happy Path

- **Given** wave 1 contains delivery stories S1 and S2, and S1 is already `delivered`
- **When** `elicify_vertex_plan_deliver("S2")` is called
- **Then** the return value contains a mandatory-next-step instruction
- **And** the instruction names both S1 and S2
- **And** the instruction names the resolved verifier for each

---

#### Scenario: Partial wave delivery reports what remains

**Traces to**: User Story 3, Acceptance Scenario 3
**Category**: Alternate Path

- **Given** wave 1 contains delivery stories S1, S2 and S3, all active
- **When** `elicify_vertex_plan_deliver("S1")` is called
- **Then** the return value lists S2 and S3 as still undelivered
- **And** the return value contains no mandatory-next-step instruction

---

#### Scenario: Checkpointing freezes the receipt's content into the plan

**Traces to**: User Story 3, Acceptance Scenario 4
**Category**: Happy Path

- **Given** a `delivered` story whose acceptance item names a valid live receipt
- **When** it is checkpointed complete
- **Then** the acceptance item's evidence in `plan.json` contains the receipt's `command`, `exitCode`, `outcome`, `observedAt`, `workspaceRoot` and originating `receiptId`
- **And** the evidence is readable without consulting the live receipt store

---

#### Scenario: Frozen evidence survives an invalidating mutation

**Traces to**: User Story 3, Acceptance Scenario 4
**Category**: Edge Case

- **Given** a story checkpointed complete with frozen evidence
- **When** a later file mutation calls `verificationReceipts.invalidate` for the session
- **Then** the story remains `complete`
- **And** an idle completion check does not reopen it

---

#### Scenario: Frozen evidence survives a process restart

**Traces to**: User Story 3, Acceptance Scenario 4
**Category**: Edge Case

- **Given** a plan whose stories are all complete with frozen evidence
- **And** the live receipt store is empty (fresh process)
- **When** an idle completion check runs
- **Then** the plan reads as complete
- **And** no `plan-progress` continuation is dispatched

---

#### Scenario: Malformed frozen evidence is treated as absent

**Traces to**: User Story 3, Acceptance Scenario 5
**Category**: Error Path

- **Given** an acceptance item whose frozen evidence record fails schema validation
- **When** the plan is loaded
- **Then** the item is treated as unevidenced
- **And** the load does not throw

---

#### Scenario: A delivered story completes with a valid receipt

**Traces to**: User Story 3, Acceptance Scenario 4
**Category**: Happy Path

- **Given** a `delivered` story S1 whose acceptance item is bound to a valid observed receipt
- **When** `checkpoint("S1", "complete")` is called
- **Then** S1 has `status: "complete"`

---

#### Scenario: A delivered story cannot complete without evidence

**Traces to**: User Story 3, Acceptance Scenario 5
**Category**: Error Path

- **Given** a `delivered` story S1 whose acceptance item has no evidence
- **When** `checkpoint("S1", "complete")` is called
- **Then** the checkpoint is rejected naming the unevidenced acceptance item
- **And** S1 remains `delivered`
- **And** `plan.json` is byte-identical to its pre-call contents

---

#### Scenario: Wave 2 stays pending while wave 1 verification is incomplete

**Traces to**: User Story 4, Acceptance Scenario 1
**Category**: Happy Path

- **Given** all wave-1 delivery stories are `complete`
- **And** the wave-1 verification story is not complete
- **When** the plan state is read
- **Then** every wave-2 story has `status: "pending"`

---

#### Scenario: Completing wave 1 verification activates wave 2

**Traces to**: User Story 4, Acceptance Scenario 2
**Category**: Happy Path

- **Given** all wave-1 delivery stories are `complete` with valid receipts
- **When** the wave-1 verification story is checkpointed complete
- **Then** every wave-2 story has `status: "active"`
- **And** all wave-2 stories share an identical `startedAt`
- **And** that `startedAt` is later than the wave-1 stories' `startedAt`

---

#### Scenario: Wave verification rejects while a delivery story lacks a receipt

**Traces to**: User Story 4, Acceptance Scenario 3
**Category**: Error Path

- **Given** wave-1 delivery stories S1 and S2, where S2 has no receipt
- **When** the wave-1 verification story is checkpointed complete
- **Then** the checkpoint is rejected naming S2 specifically
- **And** the verification story remains incomplete

---

#### Scenario: Completing the final wave finishes the plan

**Traces to**: User Story 4, Acceptance Scenario 4
**Category**: Happy Path

- **Given** a plan whose final wave's delivery stories are all `complete`
- **When** the final wave's verification story is checkpointed complete
- **Then** the plan has no story with `status: "active"`
- **And** `getActiveStories` returns an empty array

---

#### Scenario: A failed verification returns the story to active

**Traces to**: User Story 5, Acceptance Scenario 1
**Category**: Error Path

- **Given** a `delivered` story S1 with `startedAt` of `T0`
- **When** `checkpoint("S1", "failed")` is called
- **Then** S1 has `status: "active"`
- **And** S1's `startedAt` is still `T0`

---

#### Scenario: Wave verification blocks while a reworked story is unverified

**Traces to**: User Story 5, Acceptance Scenario 2
**Category**: Error Path

- **Given** story S1 was returned to `active` by a failed verification
- **When** the wave's verification story is checkpointed complete
- **Then** the checkpoint is rejected naming S1

---

#### Scenario: A reworked story completes on re-verification

**Traces to**: User Story 5, Acceptance Scenario 3
**Category**: Alternate Path

- **Given** story S1 was returned to `active` by a failed verification
- **When** S1 is re-delivered and checkpointed complete with a fresh valid receipt
- **Then** S1 has `status: "complete"`
- **And** the wave's verification story can be checkpointed complete

---

#### Scenario: A blocked story halts the plan

**Traces to**: User Story 5, Acceptance Scenario 4
**Category**: Edge Case

- **Given** a `delivered` story S1
- **When** `checkpoint("S1", "blocked")` is called
- **Then** S1 has `status: "blocked"`
- **And** the wave's verification story cannot be checkpointed complete
- **And** no later wave becomes active

---

#### Scenario: Delivered-but-unverified wave renders a wave-verification directive

**Traces to**: User Story 6, Acceptance Scenario 1
**Category**: Happy Path

- **Given** a wave where all delivery stories are `delivered` and the verification story is incomplete
- **When** `system.transform` runs
- **Then** a `wave-verification` finding is rendered
- **And** its priority is `correction`
- **And** its text names each unverified delivery story id

---

#### Scenario: The wave-verification directive persists across turns

**Traces to**: User Story 6, Acceptance Scenario 2
**Category**: Alternate Path

- **Given** a wave in the delivered-but-unverified state
- **And** a `wave-verification` finding was rendered on the previous turn
- **When** `system.transform` runs on a new turn
- **Then** a `wave-verification` finding is rendered again

---

#### Scenario: No wave-verification directive once the wave is verified

**Traces to**: User Story 6, Acceptance Scenario 3
**Category**: Happy Path

- **Given** a wave whose verification story is `complete`
- **When** `system.transform` runs
- **Then** no `wave-verification` finding is produced

---

#### Scenario: Multi-story wave with no subagent calls nudges toward fanout

**Traces to**: User Story 7, Acceptance Scenario 1
**Category**: Happy Path

- **Given** an active wave with three delivery stories
- **And** no `task` tool call was observed this turn
- **When** `system.transform` runs
- **Then** a `delegation-gap` finding is rendered at `phase-guidance` priority

---

#### Scenario: Observed subagent calls suppress the delegation nudge

**Traces to**: User Story 7, Acceptance Scenario 2
**Category**: Alternate Path

- **Given** an active wave with three delivery stories
- **And** a `task` tool call was observed this turn
- **When** `system.transform` runs
- **Then** no `delegation-gap` finding is produced

---

#### Scenario: An ignored delegation nudge never blocks delivery

**Traces to**: User Story 7, Acceptance Scenario 3
**Category**: Happy Path

- **Given** an active wave with three delivery stories and no `task` calls observed
- **When** every story in the wave is delivered
- **Then** all deliveries succeed
- **And** the wave reaches the delivered state normally

---

#### Scenario: Single-story waves produce no delegation nudge

**Traces to**: User Story 7, Acceptance Scenario 4
**Category**: Edge Case

- **Given** an active wave with exactly one delivery story
- **And** no `task` tool call was observed this turn
- **When** `system.transform` runs
- **Then** no `delegation-gap` finding is produced

---

#### Scenario: A mutation inside any active story's scope is in scope

**Traces to**: User Story 8, Acceptance Scenario 1
**Category**: Happy Path

- **Given** active stories scoped `src/a/**` and `src/b/**`
- **When** `checkScope` is called for `src/b/x.ts`
- **Then** it returns `null`

---

#### Scenario: A mutation outside every active story's scope is flagged

**Traces to**: User Story 8, Acceptance Scenario 2
**Category**: Error Path

- **Given** active stories scoped `src/a/**` and `src/b/**`
- **When** `checkScope` is called for `docs/readme.md`
- **Then** it returns a scope-watchdog finding

---

#### Scenario: An unconstrained active story makes the wave unconstrained

**Traces to**: User Story 8, Acceptance Scenario 3
**Category**: Edge Case

- **Given** active stories where one declares `scopeGlobs: []`
- **When** `checkScope` is called for any path
- **Then** it returns `null`

---

#### Scenario: A v2 plan is archived byte-identically

**Traces to**: User Story 9, Acceptance Scenario 1
**Category**: Happy Path

- **Given** a `plan.json` on disk with `schemaVersion: 2`
- **When** any story-tool method runs
- **Then** `plan.json` no longer exists at the top level
- **And** `archive/plan.<ISO-8601>.json` contains the original bytes unchanged
- **And** a `story:v2-archived` event is logged

---

#### Scenario: A fresh v3 plan is created after archival

**Traces to**: User Story 9, Acceptance Scenario 2
**Category**: Happy Path

- **Given** a v2 plan has just been archived
- **When** a new plan is created
- **Then** `plan.json` contains only the new plan
- **And** the new plan has `schemaVersion: 3`

---

#### Scenario: A v3 plan is never archived

**Traces to**: User Story 9, Acceptance Scenario 3
**Category**: Happy Path

- **Given** a `plan.json` with `schemaVersion: 3`
- **When** any story-tool method runs
- **Then** no file is added to `archive/`
- **And** `plan.json` is unchanged

---

#### Scenario: Archival never overwrites an existing archive file

**Traces to**: User Story 9, Acceptance Scenario 4
**Category**: Edge Case

- **Given** a v2 `plan.json` and an `archive/` already containing a file at the computed target name
- **When** archival runs
- **Then** the new archive file name carries a numeric suffix
- **And** the pre-existing archive file's contents are unchanged

---

#### Scenario Outline: A deterministic gap answers directly and never invokes the verifier

**Traces to**: User Story 10, Acceptance Scenarios 1, 8
**Category**: Happy Path

- **Given** a session state containing `<gap>`
- **When** `session.idle` fires
- **Then** a deterministic continuation is dispatched naming that gap
- **And** the verifier is not invoked

**Examples**:

| gap |
|---|
| a `pending` story |
| an `active` story |
| a `delivered` story awaiting verification |
| a `blocked` story |
| a `failed` story |
| a story complete but with an unevidenced acceptance item |
| a story complete but whose receipt no longer validates |
| no plan at all, with a multi-story ask |

---

#### Scenario: A deterministically complete plan invokes the verifier

**Traces to**: User Story 10, Acceptance Scenario 2
**Category**: Happy Path

- **Given** an active plan where every story is `complete`
- **And** every acceptance item carries valid evidence
- **When** `session.idle` fires
- **Then** the verifier is invoked exactly once
- **And** the payload contains the original ask, every story's status, and the evidence bound to each acceptance item

---

#### Scenario: A `complete: false` verdict drives a continuation

**Traces to**: User Story 10, Acceptance Scenario 2
**Category**: Happy Path

- **Given** an incomplete plan at idle
- **When** the verifier returns `{ complete: false, missing: ["S2 not started"], nextAction: "begin S2" }`
- **Then** a continuation is dispatched
- **And** the continuation text contains "S2 not started"
- **And** the continuation text contains "begin S2"

---

#### Scenario: A `complete: true` verdict permits close

**Traces to**: User Story 10, Acceptance Scenario 3
**Category**: Happy Path

- **Given** a plan at idle
- **When** the verifier returns `{ complete: true }`
- **Then** no continuation is dispatched

---

#### Scenario: A fully complete plan still receives a quality verdict

**Traces to**: User Story 10, Acceptance Scenario 4
**Category**: Alternate Path

- **Given** a plan whose stories are all `complete`
- **When** `session.idle` fires
- **Then** the verifier is invoked once
- **And** its `fit` assessment is surfaced as before

---

#### Scenario Outline: Verifier failure at close fails open

**Traces to**: User Story 10, Acceptance Scenario 5
**Category**: Error Path

- **Given** a deterministically complete plan at idle
- **When** the verifier returns `<failure>`
- **Then** no continuation is dispatched
- **And** the session is permitted to close
- **And** a `verifier:unavailable-at-close` event is logged

**Examples**:

| failure |
|---|
| unsupported |
| timeout |
| malformed |

---

#### Scenario: Verifier continuations are capped per session

**Traces to**: User Story 10, Acceptance Scenario 6
**Category**: Edge Case

- **Given** the verifier has already driven `maxVerifierContinuations` continuations this session
- **When** `session.idle` fires again with the plan still incomplete
- **Then** the verifier is not invoked
- **And** no verifier-driven continuation is dispatched

---

#### Scenario: Repeated identical verdicts stop the loop

**Traces to**: User Story 10, Acceptance Scenario 7
**Category**: Edge Case

- **Given** a verifier verdict reporting `missing: ["S2 not started"]`
- **And** no new evidence recorded since that verdict
- **When** a second verdict reports the identical `missing` set
- **Then** no continuation is dispatched
- **And** a `verifier:no-progress` event is logged

---

#### Scenario Outline: A covering verifier is not a relevance gap

**Traces to**: User Story 11, Acceptance Scenarios 1, 2, 3, 4
**Category**: Happy Path

- **Given** a prescribed verifier `<prescribed>`
- **When** the observed verifier is `<observed>`
- **Then** the relevance-gap result is `<gap>`

**Examples**:

| prescribed | observed | gap | rationale |
|---|---|---|---|
| `go test ./internal/auth/...` | `go test ./...` | no | recursive superset |
| `go test ./internal/a/... && go test ./internal/b/...` | `go build ./... && go test ./... -count=1` | no | the real field case |
| `npx vitest run tests/lexer.test.ts` | `npm test` | no | whole-suite command |
| `npx vitest run tests/lexer.test.ts` | `npx vitest run tests/lexer.test.ts` | no | identical |
| `go test ./...` | `go test ./internal/auth/...` | yes | observed is a strict subset |
| `go test ./internal/a/...` | `go test ./internal/b/...` | yes | disjoint |
| `go test ./internal/a/...` | `cargo build` | yes | unrelated toolchain |

---

#### Scenario: A covering verifier mints a receipt

**Traces to**: User Story 11, Acceptance Scenario 1
**Category**: Happy Path

- **Given** an active story whose prescribed verifier targets `internal/auth`
- **When** the agent runs `go test ./...` and it exits 0
- **Then** no `verify:relevance-gap` event is logged
- **And** a verification receipt is minted
- **And** the receipt id is appended to the tool output

---

#### Scenario: An incomplete plan at idle dispatches a plan-progress continuation

**Traces to**: User Story 12, Acceptance Scenario 1
**Category**: Happy Path

- **Given** a plan with story S1 `active` and S2 `pending`
- **When** `session.idle` fires
- **Then** a `plan-progress` continuation is dispatched
- **And** its text names S1 and S1's unevidenced acceptance items
- **And** the verifier is not invoked

---

#### Scenario: A halted plan is deterministically incomplete

**Traces to**: User Story 12, Acceptance Scenario 4
**Category**: Error Path

- **Given** a plan containing a `blocked` story
- **When** `session.idle` fires
- **Then** a continuation naming that blocked story is dispatched
- **And** the verifier is not invoked

---

#### Scenario: An invalidated receipt reopens a complete story

**Traces to**: User Story 12, Acceptance Scenario 5
**Category**: Edge Case

- **Given** a plan where every story is `complete`
- **And** one acceptance item's receipt no longer validates after a later mutation
- **When** `session.idle` fires
- **Then** a `plan-progress` continuation naming that acceptance item is dispatched
- **And** the verifier is not invoked

---

#### Scenario: Plan-progress continuations are capped

**Traces to**: User Story 12, Acceptance Scenario 2
**Category**: Edge Case

- **Given** `maxPlanProgressContinuations` have already been dispatched for this plan
- **When** `session.idle` fires with the plan still incomplete
- **Then** no further plan-progress continuation is dispatched

---

#### Scenario: A finished plan dispatches nothing

**Traces to**: User Story 12, Acceptance Scenario 3
**Category**: Happy Path

- **Given** a plan whose stories are all `complete`, `blocked` or `failed`
- **When** `session.idle` fires
- **Then** no `plan-progress` continuation is dispatched

---

#### Scenario: Verifier and plan-progress never double-dispatch

**Traces to**: User Story 12, Acceptance Scenario 4
**Category**: Edge Case

- **Given** an incomplete plan at idle
- **And** the verifier returned `complete: false` and dispatched a continuation
- **When** the plan-progress check runs in the same idle
- **Then** no second continuation is dispatched

---

#### Scenario Outline: Structurally inadequate plans are rejected

**Traces to**: User Story 13, Acceptance Scenarios 1, 2, 3, 4
**Category**: Error Path

- **Given** a plan request containing `<defect>`
- **When** `elicify_vertex_plan_create` is called
- **Then** the call is rejected
- **And** the error names the offending story or field

**Examples**:

| defect |
|---|
| a delivery story with zero acceptance items |
| a delivery story with neither `verifiers` nor `scopeGlobs` |
| a story whose text is whitespace-only |
| an acceptance item that is whitespace-only |
| two stories in one wave with identical text |

---

#### Scenario: Multi-story work without a plan is driven to plan

**Traces to**: User Story 13, Acceptance Scenario 5
**Category**: Happy Path

- **Given** intake classified the ask as multi-story
- **And** no plan exists for the session
- **When** `session.idle` fires
- **Then** a continuation is dispatched requiring a plan to be created

---

#### Scenario: An assistant reply cycle advances the composer turn

**Traces to**: User Story 14, Acceptance Scenarios 1, 2
**Category**: Happy Path

- **Given** an active session at `turnIndex` N
- **And** a per-turn-capped family has already rendered this turn
- **When** an assistant reply cycle completes with no new user message
- **Then** `turnIndex` becomes N+1
- **And** that family is eligible to render again

---

#### Scenario: A harness continuation does not double-advance the turn

**Traces to**: User Story 14, Acceptance Scenario 3
**Category**: Edge Case

- **Given** the harness dispatched a continuation
- **When** the reentrant `chat.message` for that continuation is processed
- **Then** `turnIndex` advances by exactly one for that reply cycle

---

#### Scenario: A rendered directive emits one toast and an unchanged injection

**Traces to**: User Story 15, Acceptance Scenario 1
**Category**: Happy Path

- **Given** visibility is `"all"`
- **When** a `verify-gap` directive is rendered into the system prompt
- **Then** exactly one toast is emitted
- **And** its message names `verify-gap` and the prescribed command
- **And** the system-prompt text is byte-identical to the visibility-off case

---

#### Scenario Outline: Visibility mode governs which events toast

**Traces to**: User Story 15, Acceptance Scenarios 2, 3, 4
**Category**: Alternate Path

- **Given** visibility is `<mode>`
- **When** an event of kind `<event>` occurs
- **Then** a toast `<emitted>`

**Examples**:

| mode | event | emitted |
|---|---|---|
| all | routine mid-turn directive | is emitted |
| all | gate fire | is emitted |
| all | health/failure signal | is emitted |
| gates | routine mid-turn directive | is not emitted |
| gates | gate fire | is emitted |
| gates | health/failure signal | is emitted |
| off | routine mid-turn directive | is not emitted |
| off | gate fire | is not emitted |
| off | health/failure signal | is not emitted |

---

#### Scenario: A failing toast never affects harness behaviour

**Traces to**: User Story 15, Acceptance Scenario 5
**Category**: Error Path

- **Given** the toast call rejects or the host has no TUI attached
- **When** a directive is rendered
- **Then** the failure is swallowed
- **And** the directive is still injected into the system prompt
- **And** no error surfaces to the model or the user

---

#### Scenario: Toasts are capped and deduplicated

**Traces to**: User Story 15, Acceptance Scenarios 6, 7
**Category**: Edge Case

- **Given** visibility is `"all"` and `maxToastsPerMinute` is 6
- **When** 10 distinct directives render within one minute
- **Then** 6 toasts are emitted
- **And** one summary toast reports 4 suppressed
- **And** a directive repeated with the same family and instance id emits no second toast

---

#### Scenario: The visibility toggle command changes mode

**Traces to**: User Story 15, Acceptance Scenario 8
**Category**: Happy Path

- **Given** visibility is `"all"`
- **When** the user runs `/elicify-vertex-visibility`
- **Then** `command.execute.before` intercepts it
- **And** the session's visibility mode changes
- **And** the new mode is confirmed to the user

---

#### Scenario Outline: Planning is blocked until requirements are understood

**Traces to**: User Story 16, Acceptance Scenarios 1, 2, 3, 4
**Category**: Error Path

- **Given** a non-trivial ask in state `<state>`
- **When** `elicify_vertex_plan_create` is called
- **Then** it is rejected naming `<reason>`

**Examples**:

| state | reason |
|---|---|
| no intake record | intake must be captured first |
| intake present, no `confirmedByMessageId` | user confirmation required |
| `confirmedByMessageId` not resolving to a real user message | confirmation could not be verified |
| `confirmedByMessageId` predating the proposal | confirmation must postdate the proposal |

---

#### Scenario: A confirmed intake permits planning

**Traces to**: User Story 16, Acceptance Scenarios 2, 3
**Category**: Happy Path

- **Given** a valid intake record whose unknowns are all resolved
- **And** a `confirmedByMessageId` resolving to a genuine user message sent after the proposal
- **When** `elicify_vertex_plan_create` is called
- **Then** the plan is created

---

#### Scenario Outline: An intake record is rejected when incomplete

**Traces to**: User Story 16, Acceptance Scenarios 5, 6
**Category**: Error Path

- **Given** an intake record missing `<element>`
- **When** it is validated
- **Then** it is rejected naming that element

**Examples**:

| element |
|---|
| the one-line outcome |
| the out-of-scope statement |
| any generated potential misreading |
| the `UNKNOWNS` list |
| a resolution for an `UNKNOWNS` entry |
| a rationale on an `ASSUMED` entry |
| a proving command for an acceptance criterion |

---

#### Scenario: An assumed unknown requires a recorded grounding attempt

**Traces to**: User Story 16, Acceptance Scenario 9
**Category**: Error Path

- **Given** an `UNKNOWNS` entry marked `ASSUMED`
- **And** no grounding attempt is recorded against it
- **When** the intake record is validated
- **Then** it is rejected stating that grounding must be attempted first

---

#### Scenario: An interactive session must ask surviving unknowns

**Traces to**: User Story 16, Acceptance Scenarios 10, 11
**Category**: Happy Path

- **Given** an interactive session with one unknown surviving grounding
- **And** no `question` tool call has been observed
- **When** `elicify_vertex_plan_create` is called
- **Then** it is rejected stating that surviving unknowns must be asked
- **And** when the agent then asks, the question carries ≥2 options with exactly one labelled `(Recommended)` listed first

---

#### Scenario: An autonomous session assumes instead of asking

**Traces to**: User Story 16, Acceptance Scenario 12
**Category**: Alternate Path

- **Given** an autonomous session with no genuine user message
- **And** one unknown surviving grounding
- **When** the intake record is completed
- **Then** no `question` tool call is made
- **And** the unknown is resolved as `ASSUMED` with rationale and risk
- **And** that assumption appears in the verifier payload at close

---

#### Scenario: A trivial ask requires no intake

**Traces to**: User Story 16, Acceptance Scenario 7
**Category**: Edge Case

- **Given** an ask matching `TRIVIAL_ASK_RE`
- **When** `system.transform` runs and the agent proceeds
- **Then** no intake directive is rendered
- **And** planning is not blocked on intake

---

#### Scenario: The intake directive is a correction, not guidance

**Traces to**: User Story 16, Acceptance Scenarios 8, 9
**Category**: Happy Path

- **Given** a non-trivial ask with no intake record
- **When** `system.transform` runs
- **Then** an intake directive is rendered at `correction` priority
- **And** its prescription asks the user to resolve unknowns rather than to assume

---

## Test-Driven Development Plan

### Test Hierarchy

| Level | Scope | Purpose |
|---|---|---|
| Unit | `StoryEngine` methods, wave normalisation, validators, finding builders | Validates plan-state logic in isolation against a temp `stateDir` |
| Integration | `buildPlanTools` tools driven against a real `StoryEngine` + stubbed client | Validates tool contracts, evidence rules, and mandatory-next-step text |
| E2E | Full plugin hook set (`plugin.integration.test.ts` style) | Validates wave lifecycle across `chat.message` → `tool.execute.after` → `system.transform` → `session.idle` |

### Test Implementation Order

| Order | Test Name | Level | Traces to BDD Scenario | Description |
|---|---|---|---|---|
| 1 | `wave_normalisation_contiguous` | Unit | Scenario Outline: Non-contiguous declared waves normalise… | Declared wave values map to contiguous ordinals preserving order |
| 2 | `wave_default_is_one` | Unit | Scenario: A story omitting wave defaults to wave 1 | Missing `wave` field defaults to 1 |
| 3 | `create_activates_whole_first_wave` | Unit | Scenario: Three independent stories activate together in wave 1 | All wave-1 stories active with shared `startedAt` |
| 4 | `create_appends_verification_story_per_wave` | Unit | Scenario: Every wave gets exactly one verification story | One synthetic verification story per wave |
| 5 | `verification_story_items_name_delivery_stories` | Unit | Scenario: A verification story is appended to each wave | Acceptance items generated one per delivery story |
| 6 | `model_authored_verification_kind_ignored` | Unit | Scenario: A model-authored verification kind is ignored | `kind` is not model-settable |
| 7 | `over_serialisation_logged` | Unit | Scenario: Needlessly serialised disjoint stories are flagged… | `wave:over-serialised` event on disjoint globs in different waves |
| 8 | `is_plan_v3_rejects_v2` | Unit | Scenario: A v2 plan is archived byte-identically | Validator rejects `schemaVersion: 2` |
| 9 | `archive_v2_byte_identical` | Unit | Scenario: A v2 plan is archived byte-identically | Atomic rename preserves bytes; event logged |
| 10 | `archive_v2_suffixes_on_collision` | Unit | Scenario: Archival never overwrites an existing archive file | Collision handling |
| 11 | `archive_skips_v3` | Unit | Scenario: A v3 plan is never archived | No-op for current schema |
| 12 | `fresh_v3_plan_after_archival` | Unit | Scenario: A fresh v3 plan is created after archival | Post-archival create writes only v3 |
| 13 | `deliver_requires_no_evidence` | Unit | Scenario: A delivery story is marked delivered without evidence | `delivered` transition without receipts |
| 14 | `deliver_rejects_verification_story` | Unit | Scenario: A verification story cannot be delivered | Verification stories are checkpoint-only |
| 15 | `deliver_is_idempotent` | Unit | Edge Case: `plan_deliver` called twice | Second call is a no-op success |
| 16 | `checkpoint_accepts_any_active_story` | Unit | Scenario: A delivered story completes with a valid receipt | Ordering guard loosened |
| 17 | `checkpoint_rejects_pending_story` | Unit | Edge Case: `checkpoint` on a `pending` story | Rejected naming gating wave |
| 18 | `failed_returns_story_to_active` | Unit | Scenario: A failed verification returns the story to active | `startedAt` preserved |
| 19 | `blocked_halts_plan` | Unit | Scenario: A blocked story halts the plan | Terminal block; no wave advance |
| 20 | `wave_gate_blocks_next_wave` | Unit | Scenario: Wave 2 stays pending while wave 1 verification is incomplete | The determinism gate |
| 21 | `wave_verification_activates_next_wave` | Unit | Scenario: Completing wave 1 verification activates wave 2 | Shared later `startedAt` |
| 22 | `wave_verification_rejects_unevidenced_story` | Unit | Scenario: Wave verification rejects while a delivery story lacks a receipt | Names the specific story |
| 23 | `final_wave_completion_finishes_plan` | Unit | Scenario: Completing the final wave finishes the plan | No active stories remain |
| 24 | `rework_then_complete` | Unit | Scenario: A reworked story completes on re-verification | Full rework loop |
| 25 | `check_scope_unions_active_globs` | Unit | Scenario: A mutation inside any active story's scope is in scope | Union matching |
| 26 | `check_scope_flags_outside_union` | Unit | Scenario: A mutation outside every active story's scope is flagged | Union miss |
| 27 | `check_scope_empty_globs_unconstrained` | Unit | Scenario: An unconstrained active story makes the wave unconstrained | Empty-glob semantics |
| 28 | `phase_engine_concurrent_stories_deterministic` | Unit | Edge Case: `getPhase(sessionID)` during a multi-story wave | Deterministic no-storyId resolution |
| 29 | `deliver_emits_mandatory_next_step` | Integration | Scenario: Completing a wave's delivery emits the mandatory next step | Tool return content |
| 30 | `deliver_partial_reports_remaining` | Integration | Scenario: Partial wave delivery reports what remains | No premature instruction |
| 31 | `checkpoint_rejects_without_evidence_plan_unchanged` | Integration | Scenario: A delivered story cannot complete without evidence | Byte-identical plan on rejection |
| 32 | `receipt_from_main_session_round_trips` | Integration | Scenario: A delivered story completes with a valid receipt | Receipt minted in main session satisfies checkpoint |
| 33 | `subagent_session_mints_no_receipt` | Integration | (Non-behavior; FR-021) | Non-activated session produces no receipt |
| 34 | `wave_verification_finding_rendered` | Integration | Scenario: Delivered-but-unverified wave renders a wave-verification directive | Correction priority, names stories |
| 35 | `wave_verification_finding_repeats_across_turns` | Integration | Scenario: The wave-verification directive persists across turns | Not suppressed by cooldown |
| 36 | `wave_verification_finding_absent_when_verified` | Integration | Scenario: No wave-verification directive once the wave is verified | Silence when satisfied |
| 37 | `delegation_gap_finding_rendered` | Integration | Scenario: Multi-story wave with no subagent calls nudges toward fanout | Advisory finding |
| 38 | `delegation_gap_suppressed_by_task_call` | Integration | Scenario: Observed subagent calls suppress the delegation nudge | `task` observation |
| 39 | `delegation_gap_single_story_wave_silent` | Integration | Scenario: Single-story waves produce no delegation nudge | Threshold behaviour |
| 40 | `delegation_gap_never_blocks` | Integration | Scenario: An ignored delegation nudge never blocks delivery | Advisory guarantee |
| 41 | `full_wave_lifecycle_e2e` | E2E | Scenarios: activate → deliver → verify → next wave | Whole lifecycle through real hooks |
| 42 | `wave_gate_survives_process_restart` | E2E | Scenario: Wave 2 stays pending… | Gate state is durable on disk |
| 43 | `covering_verifier_not_a_gap` | Unit | Scenario Outline: A covering verifier is not a relevance gap | All 7 example rows, incl. the real field case |
| 44 | `subset_verifier_is_a_gap` | Unit | Scenario Outline: A covering verifier is not a relevance gap | Strict subset / disjoint still gap |
| 45 | `whole_suite_command_covers_narrower` | Unit | Scenario Outline: A covering verifier is not a relevance gap | `npm test` / `go test ./...` path-free case |
| 46 | `covering_verifier_mints_receipt` | Integration | Scenario: A covering verifier mints a receipt | End of the D1 causal chain: receipt appears in tool output |
| 47 | `plan_create_rejects_no_acceptance_items` | Unit | Scenario Outline: Structurally inadequate plans are rejected | Row 1 |
| 48 | `plan_create_rejects_no_verifier_or_scope` | Unit | Scenario Outline: Structurally inadequate plans are rejected | Row 2 |
| 49 | `plan_create_rejects_blank_fields` | Unit | Scenario Outline: Structurally inadequate plans are rejected | Rows 3–4 |
| 50 | `plan_create_rejects_duplicate_story_text` | Unit | Scenario Outline: Structurally inadequate plans are rejected | Row 5 |
| 51 | `plan_progress_continuation_dispatched` | Unit | Scenario: An incomplete plan at idle dispatches a plan-progress continuation | Deterministic floor, verifier disabled |
| 52 | `plan_progress_continuation_capped` | Unit | Scenario: Plan-progress continuations are capped | Loop safety |
| 53 | `plan_progress_silent_when_finished` | Unit | Scenario: A finished plan dispatches nothing | No nagging after completion |
| 54 | `deterministic_gap_never_invokes_verifier` | Integration | Scenario Outline: A deterministic gap answers directly and never invokes the verifier | All 8 gap rows; asserts 0 verifier invocations |
| 54a | `verifier_invoked_only_when_deterministically_complete` | Integration | Scenario: A deterministically complete plan invokes the verifier | The gating condition (FR-038) |
| 54b | `halted_plan_blocks_verifier` | Unit | Scenario: A halted plan is deterministically incomplete | `blocked`/`failed` are gaps, not completion |
| 54c | `invalidated_receipt_reopens_story` | Unit | Scenario: An invalidated receipt reopens a complete story | Re-validates evidence at idle, not just at checkpoint |
| 55 | `verifier_incomplete_verdict_drives_continuation` | Integration | Scenario: A `complete: false` verdict drives a continuation | Self-correction loop |
| 56 | `verifier_complete_verdict_permits_close` | Integration | Scenario: A `complete: true` verdict permits close | No false nagging |
| 57 | `verifier_quality_pass_on_complete_plan` | Integration | Scenario: A fully complete plan still receives a quality verdict | Pre-existing behaviour preserved |
| 58 | `verifier_failure_at_close_fails_open` | Integration | Scenario Outline: Verifier failure at close fails open | 3 example rows; close permitted, event logged |
| 59 | `verifier_continuations_capped` | Integration | Scenario: Verifier continuations are capped per session | Cost + loop bound |
| 60 | `verifier_no_progress_stops_loop` | Integration | Scenario: Repeated identical verdicts stop the loop | Anti-nag detector |
| 61 | `verifier_and_plan_progress_never_double_dispatch` | Integration | Scenario: Verifier and plan-progress never double-dispatch | One continuation per idle |
| 62 | `multi_story_without_plan_driven_to_plan` | Integration | Scenario: Multi-story work without a plan is driven to plan | Mandatory planning |
| 63 | `assistant_reply_advances_turn` | Integration | Scenario: An assistant reply cycle advances the composer turn | D4 fix |
| 64 | `continuation_does_not_double_advance_turn` | Integration | Scenario: A harness continuation does not double-advance the turn | D4 guard |
| 65 | `autonomous_run_directive_delivery_rate` | E2E | Scenarios: turn advancement + wave-verification | ≥1 directive per reply cycle over a 10-cycle autonomous run |
| 66 | `rendered_directive_emits_one_toast` | Unit | Scenario: A rendered directive emits one toast and an unchanged injection | Toast content + injection byte-identical |
| 67 | `visibility_mode_governs_toasts` | Unit | Scenario Outline: Visibility mode governs which events toast | All 9 mode×event rows |
| 68 | `toast_failure_is_swallowed` | Unit | Scenario: A failing toast never affects harness behaviour | Fail-safe; injection still occurs |
| 69 | `toasts_capped_and_deduped` | Unit | Scenario: Toasts are capped and deduplicated | Rate cap + summary + dedupe |
| 70 | `visibility_toggle_command` | Integration | Scenario: The visibility toggle command changes mode | `command.execute.before` interception |
| 71 | `idle_correction_visible_without_toast` | Integration | Scenario: An incomplete plan at idle dispatches a plan-progress continuation | Idle path is visible via `session.prompt` alone (FR-065) |
| 72 | `plan_create_blocked_without_intake` | Integration | Scenario Outline: Planning is blocked until requirements are understood | All 4 state rows |
| 73 | `confirmation_must_be_a_real_user_message` | Integration | Scenario Outline: Planning is blocked until requirements are understood | `isUserMessage` proof, not assertion |
| 74 | `confirmation_must_postdate_proposal` | Integration | Scenario Outline: Planning is blocked until requirements are understood | Ordering check |
| 75 | `confirmed_intake_permits_planning` | Integration | Scenario: A confirmed intake permits planning | Happy path through the gate |
| 76 | `intake_record_validation` | Unit | Scenario Outline: An intake record is rejected when incomplete | All 7 element rows |
| 77 | `criterion_without_proving_command_rejected` | Unit | Scenario Outline: An intake record is rejected when incomplete | Testability-as-detector |
| 78 | `trivial_ask_skips_intake` | Unit | Scenario: A trivial ask requires no intake | `TRIVIAL_ASK_RE` scoping |
| 79 | `intake_directive_is_correction_priority` | Unit | Scenario: The intake directive is a correction, not guidance | Not crowded out of the budget |
| 80 | `assumed_unknown_requires_grounding` | Unit | Scenario: An assumed unknown requires a recorded grounding attempt | Ground-before-ask/assume |
| 81 | `interactive_must_ask_surviving_unknowns` | Integration | Scenario: An interactive session must ask surviving unknowns | Gate + question shape |
| 82 | `question_shape_options_and_recommendation` | Unit | Scenario: An interactive session must ask surviving unknowns | ≥2 options, one `(Recommended)` first |
| 83 | `autonomous_assumes_without_asking` | Integration | Scenario: An autonomous session assumes instead of asking | No question tool call; assumptions reach the verifier |
| 84 | `interactive_detection_excludes_harness_messages` | Unit | Scenario: An autonomous session assumes instead of asking | `harnessAuthoredIds` drives the interactive/autonomous split |
| 85 | `checkpoint_freezes_receipt_content` | Unit | Scenario: Checkpointing freezes the receipt's content into the plan | FR-082: content copied, not referenced |
| 86 | `frozen_evidence_survives_invalidate` | Unit | Scenario: Frozen evidence survives an invalidating mutation | FR-085 — the CRIT-005 case |
| 87 | `frozen_evidence_survives_restart` | Integration | Scenario: Frozen evidence survives a process restart | FR-084/085 — the CRIT-006 case |
| 88 | `malformed_frozen_evidence_is_absent` | Unit | Scenario: Malformed frozen evidence is treated as absent | FR-086 fail-safe load |
| 89 | `checkpoint_validation_unchanged` | Unit | Scenario: A delivered story cannot complete without evidence | FR-083: earning evidence is as strict as before |

### Test Datasets

#### Dataset: Wave normalisation input

| # | Input (declared waves) | Boundary Type | Expected Output | Traces to | Notes |
|---|---|---|---|---|---|
| 1 | `[1,1,1]` | Happy path | `[1,1,1]` | Scenario Outline: Non-contiguous… | Already contiguous single wave |
| 2 | `[1,2,3]` | Happy path | `[1,2,3]` | Scenario Outline: Non-contiguous… | Already contiguous multi-wave |
| 3 | `[1,1,3]` | Gap | `[1,1,2]` | Scenario Outline: Non-contiguous… | Gap closed |
| 4 | `[2,2]` | Offset min | `[1,1]` | Scenario Outline: Non-contiguous… | First populated wave becomes 1 |
| 5 | `[5,1]` | Out of order | `[2,1]` | Scenario Outline: Non-contiguous… | Ordered by value, not position |
| 6 | `[undefined]` | Missing | `[1]` | Scenario: A story omitting wave… | Default |
| 7 | `[1,undefined,2]` | Mixed | `[1,1,2]` | Scenario: A story omitting wave… | Default participates in normalisation |
| 8 | `[0]` | Zero | `[1]` | Scenario Outline: Non-contiguous… | Zero is a legal declared value, normalises to 1 |
| 9 | `[-1,1]` | Negative | `[1,2]` | Scenario Outline: Non-contiguous… | Negative ordered before positive |
| 10 | `[1.5,1]` | Non-integer | rejected | Scenario Outline: Non-contiguous… | `wave` must be an integer |
| 11 | `[1e6, 1]` | Very large | `[2,1]` | Scenario Outline: Non-contiguous… | No upper bound imposed |

#### Dataset: Checkpoint status transitions from `delivered`

| # | Input status | Boundary Type | Expected Output | Traces to | Notes |
|---|---|---|---|---|---|
| 1 | `complete` + valid receipt | Happy path | `complete` | Scenario: A delivered story completes with a valid receipt | Normal path |
| 2 | `complete` + no evidence | Error | rejected, stays `delivered` | Scenario: A delivered story cannot complete without evidence | Evidence gate |
| 3 | `complete` + receipt predating `startedAt` | Boundary | rejected | Scenario: A delivered story cannot complete without evidence | `isFreshReceipt` time bound |
| 4 | `complete` + receipt from another workspace | Error | rejected | Scenario: A delivered story cannot complete without evidence | Workspace check |
| 5 | `complete` + receipt with non-zero exit | Error | rejected | Scenario: A delivered story cannot complete without evidence | Exit-code check |
| 6 | `failed` | Alternate | `active`, `startedAt` preserved | Scenario: A failed verification returns the story to active | Rework loop |
| 7 | `blocked` | Edge | `blocked` terminal | Scenario: A blocked story halts the plan | Plan halts |
| 8 | `complete` on a `pending` story | Error | rejected | Edge Case: `checkpoint` on a `pending` story | Wave not active |
| 9 | `complete` on an already-`complete` story | Edge | rejected | Edge Case | No double-complete |

#### Dataset: Scope union matching

| # | Active globs | Mutated path | Boundary Type | Expected | Traces to |
|---|---|---|---|---|---|
| 1 | `["src/a/**"]`, `["src/b/**"]` | `src/b/x.ts` | Happy path | `null` (in scope) | Scenario: A mutation inside any active story's scope… |
| 2 | `["src/a/**"]`, `["src/b/**"]` | `docs/readme.md` | Error | finding | Scenario: A mutation outside every active story's scope… |
| 3 | `["src/a/**"]`, `[]` | `anything.ts` | Edge | `null` (unconstrained) | Scenario: An unconstrained active story… |
| 4 | `[]`, `[]` | `anything.ts` | Edge | `null` | Scenario: An unconstrained active story… |
| 5 | `["src/a/**"]` (single active) | `src/a/x.ts` | Boundary | `null` | Scenario: A mutation inside any active story's scope… |
| 6 | no active stories | `src/a/x.ts` | Boundary | `null` | Scenario: An unconstrained active story… |
| 7 | `["src/**"]`, `["src/a/**"]` | `src/a/x.ts` | Overlap | `null` | Scenario: A mutation inside any active story's scope… |
| 8 | `["src/a/*.ts"]` | `src/a/deep/x.ts` | Glob depth | finding | Scenario: A mutation outside every active story's scope… |

#### Dataset: Wave gate progression

| # | Wave-1 delivery states | Wave-1 verification | Boundary Type | Expected wave-2 state | Traces to |
|---|---|---|---|---|---|
| 1 | all `complete` | `complete` | Happy path | all `active` | Scenario: Completing wave 1 verification activates wave 2 |
| 2 | all `complete` | incomplete | Boundary | all `pending` | Scenario: Wave 2 stays pending… |
| 3 | one `delivered`, rest `complete` | incomplete | Boundary | all `pending` | Scenario: Wave 2 stays pending… |
| 4 | one `active` (reworked), rest `complete` | incomplete | Error | all `pending` | Scenario: Wave verification blocks while a reworked story is unverified |
| 5 | one `blocked`, rest `complete` | can never complete | Edge | all `pending` permanently | Scenario: A blocked story halts the plan |
| 6 | all `complete` (single-wave plan) | `complete` | Boundary | no wave 2; plan finished | Scenario: Completing the final wave finishes the plan |

### Regression Test Requirements

This feature **modifies existing functionality**.

| Existing Behaviour | Existing Test | New Regression Test Needed | Notes |
|---|---|---|---|
| Checkpoint rejects unevidenced completion | `story.test.ts` "checkpoint evidence validation — Dataset (6 rows)" | No — must pass unchanged | Evidence bar is unchanged by this feature |
| Final story requires an observed receipt (FR-020) | `story.test.ts` checkpoint dataset | No — must pass unchanged | Now applies to each wave's verification story |
| Plan persists/hydrates across engine instances | `story.test.ts` "survives a persist/load round-trip" | Yes — `wave_gate_survives_process_restart` | v3 fields must round-trip |
| `plan.json` corruption aborts the write | `story.test.ts` `story_disk_corrupt_on_write` | No — must pass unchanged | Untouched path |
| v1 `goals.json` archival | `story.test.ts` `story_v1_archival` (test 13) | No — must pass unchanged | v2 archival is additive, must not disturb v1 handling |
| `clearPlan` archives reversibly | `story.test.ts` "clearPlan (human-facing escape hatch)" | Yes — `clear_plan_works_on_v3` | Must handle v3 plans and waves |
| Receipt surfaced to model in tool output | `plugin.integration.test.ts` "verification receipt surfaced…" | No — must pass unchanged | Receipt mechanics untouched |
| Verifier fires at final-story completion | `integration-verifier.test.ts` | Yes — `verifier_fires_on_final_wave_verification` | "Final story" now means the final wave's verification story |
| Composer per-turn caps and cooldowns | `composer.test.ts` | Yes — `wave_verification_uncapped_across_turns` | New families must not break cap semantics |
| T8 story-advance phase arc | `plugin.integration.test.ts` / `phase.test.ts` | Yes — `phase_advance_on_wave_transition` | T8 now fires on wave transition, not per-story |

---

## Functional Requirements

- **FR-001**: `StoryV2` MUST gain a required `wave: number` field (positive contiguous integer after normalisation).
- **FR-002**: `StoryV2` MUST gain a required `kind: "delivery" | "verification"` field.
- **FR-003**: `StoryV2.status` MUST be extended with `"delivered"`.
- **FR-004**: `elicify_vertex_plan_create` MUST accept an optional per-story `wave` integer, defaulting to `1` when absent.
- **FR-005**: `createPlan` MUST normalise declared wave values to contiguous ordinals starting at 1, ordered by declared value, preserving relative order within a wave.
- **FR-006**: `createPlan` MUST reject a non-integer `wave` value.
- **FR-007**: `createPlan` MUST append exactly one `kind: "verification"` story to every wave, authored by the plugin.
- **FR-008**: Each appended verification story MUST carry one acceptance item per delivery story in its wave, each naming that story's id.
- **FR-009**: `createPlan` MUST ignore any model-supplied `kind` value and store model-supplied stories as `kind: "delivery"`.
- **FR-010**: `createPlan` MUST log a `wave:over-serialised` event when two stories with disjoint `scopeGlobs` are placed in different waves.
- **FR-011**: `createPlan` MUST set `status: "active"` and an identical `startedAt` on every story in wave 1.
- **FR-012**: A new `elicify_vertex_plan_deliver` tool MUST set a delivery story's status to `"delivered"` without requiring evidence.
- **FR-013**: `elicify_vertex_plan_deliver` MUST reject a `kind: "verification"` story.
- **FR-014**: `elicify_vertex_plan_deliver` MUST be idempotent for an already-`delivered` story.
- **FR-015**: When the last delivery story in a wave becomes `delivered`, `elicify_vertex_plan_deliver`'s return value MUST contain a mandatory-next-step instruction naming every delivery story in that wave and its resolved verifier.
- **FR-016**: When a wave is not yet fully delivered, `elicify_vertex_plan_deliver`'s return value MUST list the remaining undelivered story ids and MUST NOT contain the mandatory-next-step instruction.
- **FR-017**: `PlanV2` MUST become `schemaVersion: 3`, and validation MUST reject any other version.
- **FR-018**: An on-disk plan with `schemaVersion: 2` MUST be archived to `archive/plan.<ISO-8601>.json` by atomic rename, byte-identically, before any v3 write, logging `story:v2-archived`. Archival MUST NOT overwrite an existing archive file.
- **FR-019**: `checkpoint` MUST accept any story whose status is `"active"` or `"delivered"`, replacing the single-active-story guard.
- **FR-020**: `checkpoint` MUST reject completion of a story whose wave is not yet active, naming the gating wave.
- **FR-021**: `checkpoint(storyId, "failed")` on a `delivered` story MUST return it to `"active"` preserving its original `startedAt`.
- **FR-022**: A wave's verification story MUST NOT complete unless every delivery story in that wave is `"complete"` with a valid receipt; rejection MUST name the specific offending story.
- **FR-023**: Completing a wave's verification story MUST activate every story in the next wave with an identical `startedAt` set at that moment.
- **FR-024**: No story in wave N+1 MUST become `"active"` while wave N's verification story is incomplete.
- **FR-025**: `StoryEngine` MUST expose `getActiveStories(): StoryV2[]` returning all `"active"` stories.
- **FR-026**: `checkScope` MUST match a mutated path against the union of all active stories' `scopeGlobs`, returning `null` when any active story declares empty `scopeGlobs`.
- **FR-027**: The composer MUST support a `wave-verification` finding at `correction` priority that renders whenever a wave is delivered-but-unverified, and MUST NOT be suppressed by cooldown across turns.
- **FR-028**: The composer MUST support a `delegation-gap` finding at `phase-guidance` priority, rendered when an active wave holds ≥2 delivery stories and no `task` tool call was observed in the turn.
- **FR-029**: The `delegation-gap` finding MUST NOT block any plan transition.
- **FR-030**: `PhaseEngine.getPhase(sessionID)` called without a `storyId` MUST resolve deterministically when multiple stories are active, rather than returning whichever story was most recently mutated.
- **FR-031**: A subagent (non-activated) session MUST NOT be able to mint a verification receipt usable by the main session — existing behaviour that MUST be preserved and covered by a test.
- **FR-032**: `isFreshReceipt`'s time-bound, workspace, outcome and exit-code checks MUST remain unchanged.

### D1 — Covering verifiers (blocking fix)

**Coverage algorithm (normative).** The check answers one question: *does the observed command do at least everything the prescribed command would?* It replaces `verifiersEquivalent`'s `rationale` + `matchedPaths` **set equality** (`measurement.ts:824`), which cannot express "broader".

```
covers(prescribed, observed):
  P = parseSubcommands(prescribed)     # split on && ; ||, strip ignored flags + redirections
  O = parseSubcommands(observed)
  every p in P must be covered by some o in O
  where o covers p  iff  runnerEquivalent(o.runner, p.runner)
                    and  targetsCover(o.targets, p.targets)
```

- **`runner`** — the normalised leading tokens of a sub-command, up to the first path-shaped or flag token: `go test`, `go build`, `npm test`, `npx vitest run`, `pytest`, `cargo test`. `go build` is NOT a runner-equivalent of `go test` — building is not testing, so a build can never cover a prescribed test.
- **`runnerEquivalent`** — exact match, OR both runners appear in the same entry of an explicit `WHOLE_SUITE_ALIASES` table (e.g. `npm test` ≡ `npx vitest run` ≡ `npx jest` within a JS project). A runner absent from the table matches only itself — **fail-closed**, so an unknown runner never silently covers.
- **`targets`** — path-shaped tokens after flag stripping. `targetsCover(O, P)` is `true` when `O` is empty (a whole-suite invocation targets everything), otherwise when every `p ∈ P` has some `o ∈ O` that is `p` itself or a recursive ancestor of it. `./...` (Go) and a trailing `**` (glob) are recursive wildcards; plain prefix equality is not sufficient (`src/a` does not cover `src/ab`).

Worked example — the real field case, currently a gap:
`prescribed = go test ./internal/a/... && go test ./internal/b/... && go build ./...`,
`observed = go build ./... && go test ./... -count=1` → every prescribed sub-command finds a covering observed sub-command (`go test ./...` covers both test targets; `go build ./...` covers the build) → **no gap**.

- **FR-033**: The verifier relevance check MUST report a gap only when the observed verifier fails to **cover** the prescribed one per the algorithm above; a covering observed verifier MUST NOT be a gap.
- **FR-034**: An observed sub-command with **zero path-shaped target tokens after flag stripping** (e.g. `npm test`, `pytest`) MUST be treated as targeting everything for its runner. A recursive-wildcard target (`./...`, trailing `**`) MUST likewise cover any descendant target. *(This replaces the earlier, self-contradictory wording that called `go test ./...` a command with "no path arguments" — it has one target token, `./...`, which is recursive.)* **Correction:** the algorithm's `targetsCover` is NOT vacuously true when the PRESCRIBED target list is empty; a whole-suite prescription requires the observed side to name a universal target, or FR-035 would be violated.
- **FR-035**: An observed verifier whose targets are a strict subset of, or disjoint from, the prescribed verifier's MUST still report a relevance gap.
- **FR-036**: A prescribed sub-command MUST NOT be considered covered by an observed sub-command whose runner is neither identical nor listed as an alias of it in `WHOLE_SUITE_ALIASES`; cross-ecosystem commands therefore never cover each other. *(Resolves Ambiguity #7.)*
- **FR-036b**: The FR-034 compliance join (`verify-gap` directive marked complied) MUST use the same coverage predicate as the relevance check, so a broader observed run counts as compliance with a narrower prescription.
- **FR-036a**: Runner and target extraction MUST tolerate compound commands (`&&`, `;`, `||`), shell redirections (`2>&1`), and pipes, and MUST NOT treat a piped command's altered exit status as changing coverage — pipe handling remains the pre-existing `parseVerification` concern, unchanged by this feature.
- **FR-037**: When no relevance gap is reported and the command verifies with exit 0, a receipt MUST be minted and its id appended to the tool output (existing behaviour, now reachable).
- **FR-037a**: An observed sub-command carrying a test SELECTOR the prescription did not carry (`-run`, `-t`, `-k`, `--grep`, `--changed`, `--onlyChanged`, `--lf`, `-short`, `--shard`, …) MUST NOT cover it. Reviewers proved `go test -run TestFoo ./...` otherwise credits an entire prescribed suite while executing one test.
- **FR-037b**: An observed sub-command carrying a NON-EXECUTING flag (`--collect-only`, `--version`, `--listTests`, `--dry-run`, …) MUST cover nothing. Proven to mint real receipts otherwise.
- **FR-037c**: A BARE observed command (no path targets) MUST be treated as whole-suite ONLY for runners that genuinely run everything when bare (`npm test`, `pytest`, `cargo test`, …). It MUST NOT be for `go test`, which runs only the current directory's package — proven against a real Go module to mint a receipt while the prescribed suite was red.
- **FR-037d**: `||` alternation on the OBSERVED side MUST cover nothing: for `A || B` exiting 0 it is unknowable which operand ran.
- **FR-037e**: The relevance check MUST run even when no file mutation has been observed this turn, falling back to the active story's declared `verifiers` as the prescription. Gating it on changed paths let any passing command mint a receipt.

### W2 — Evidence durability (resolves review CRIT-005 / CRIT-006)

**Problem.** `VerificationReceiptStore` (`goals.ts:159`) is **process memory only**, keeps at most the last **20** receipts per session (`goals.ts:174`, `receipts.slice(-20)`), and `invalidate()` deletes **every** receipt for the session on any file mutation (`goals.ts:183`, called at `plugin.ts:486` and `plugin.ts:891`). Three consequences the earlier draft ignored: a wave of more than 20 stories cannot hold its receipts; one edit mid-verification wipes evidence already earned; and after any restart every `receiptId` in `plan.json` resolves to nothing, so a *finished* plan reads as permanently incomplete.

**Decision.** Evidence is **frozen at checkpoint**. Validation against the live store is unchanged at checkpoint time; on success the receipt's *content* is copied into `plan.json` as an immutable record, and every later reader uses that record instead of the live store.

- **FR-082**: On a successful checkpoint the system MUST copy the validating receipt's content — `command`, `exitCode`, `outcome`, `observedAt`, `workspaceRoot`, and the originating `receiptId` — into the acceptance item's `evidence` in `plan.json`.
- **FR-083**: Checkpoint-time validation MUST continue to resolve `receiptId` against the live `VerificationReceiptStore` exactly as today (observed, workspace-matching, exit 0, not predating story start). Freezing changes what is *stored*, never what is *required to earn* evidence.
- **FR-084**: Every reader after checkpoint — idle completion checks, wave gating, the verifier payload — MUST read the frozen record in `plan.json` and MUST NOT re-resolve `receiptId` against the live store.
- **FR-085**: A frozen evidence record MUST survive process restart and MUST NOT be invalidated by `verificationReceipts.invalidate`; a completed story MUST NOT reopen because the in-memory store was cleared.
- **FR-086**: Frozen evidence MUST be schema-validated on read; a malformed record MUST be treated as absent (the item is unevidenced) rather than crashing the load.
- **FR-087**: A later mutation MUST still invalidate *live* receipts for not-yet-checkpointed items (existing behaviour, unchanged) — freezing applies only at and after a successful checkpoint.

**Supersedes**: the Assumption stating that receipt invalidation remains session-global and path-scoping is deferred, and Ambiguity #3, are both corrected by FR-082…FR-087 — path-scoped invalidation is no longer needed, because a frozen record is never invalidated at all.

### D2 — Verifier as completion detector

- **FR-038**: At `session.idle` the system MUST evaluate deterministic completion FIRST, and MUST invoke the verifier **only when every deterministic check passes** (a plan exists, every story is `complete`, and every acceptance item carries valid evidence). Any deterministic gap MUST be answered by a direct continuation with the verifier left uninvoked.
- **FR-038a**: The verifier MUST NOT be invoked when no plan exists, when any story is `pending`/`active`/`delivered`/`blocked`/`failed`, or when any acceptance item lacks evidence.
- **FR-039**: The verifier payload MUST contain the original ask, every story's id/text/status, and the ids of acceptance items lacking evidence.
- **FR-040**: The verifier verdict schema MUST carry `{ complete: boolean, missing: string[], nextAction: string }` in addition to the existing quality `fit` assessment.
- **FR-041**: A `complete: false` verdict MUST dispatch a continuation whose text contains every entry in `missing` and the verdict's `nextAction`.
- **FR-042**: A `complete: true` verdict MUST NOT dispatch a continuation.
- **FR-043**: The verifier MUST still run once for a quality assessment when the plan is fully complete, preserving pre-existing behaviour.
- **FR-044**: Verifier unavailability (`unsupported`, `unavailable`, `malformed`, timeout) MUST fail open — no continuation is dispatched and the session is permitted to close, logging `verifier:unavailable-at-close`. The deterministic layer has already run and raised no objection by the time the verifier is reached (FR-038), so there is nothing to fall back to.
- **FR-045**: Verifier-driven continuations MUST be capped at `maxVerifierContinuations` per session (default 3) and MUST stop when two consecutive verdicts report an identical `missing` set with no new evidence recorded between them, logging `verifier:no-progress`.

### D3 — Deterministic completion driver

- **FR-046**: When a plan has ≥1 `active` or `pending` story and no other continuation fired this idle, the system MUST dispatch a `plan-progress` continuation naming the active story, its unevidenced acceptance items, and the next legal step.
- **FR-047**: `plan-progress` continuations MUST be capped at `maxPlanProgressContinuations` per plan (default 5).
- **FR-048**: No `plan-progress` continuation MUST be dispatched when every story is `complete`, `blocked` or `failed`.
- **FR-049**: At most one continuation MUST be dispatched per `session.idle` across all triggers.
- **FR-050**: When intake classified the ask as multi-story and no plan exists, the system MUST dispatch a continuation requiring plan creation, capped at `maxPlanProposalContinuations` (default 3).

### D4 — Turn advancement

- **FR-051**: ~~`composer.newTurn` MUST be called once per completed assistant reply cycle.~~ **WITHDRAWN.** The premise was a misdiagnosis: the field session had exactly ONE activated user message, so `turnIndex == 1` was correct and the ~250 `per-turn-cap:dropped` events were the cap working as designed. Live-host measurement then showed `experimental.chat.system.transform` fires after EVERY tool result, so advancing per reply cycle or per tool result drove the index 1 → 4 within a single cycle and collapsed every per-turn cap and cooldown into per-step. A turn MUST remain a prompt boundary (a user message or a dispatched gate continuation).
- **FR-052**: A reentrant `chat.message` produced by a harness continuation MUST NOT advance the turn more than once for the same prompt (unchanged, and satisfied by the reentrancy guard).
- **FR-052a**: **OPEN DESIGN ISSUE, not yet specified.** A single agent turn can run for 90 minutes, during which each directive family renders at most once. That is correct per-turn behaviour but poor guidance cadence. Fixing it needs a deliberate decision (time-based cap reset, raised caps for long turns, or a distinct long-run cadence) — NOT a turn-boundary change, which was tried and reverted.

### Plan quality enforcement

- **FR-053**: `createPlan` MUST reject a delivery story with zero acceptance items, naming that story.
- **FR-054**: `createPlan` MUST reject a delivery story declaring neither `verifiers` nor `scopeGlobs`, naming that story.
- **FR-055**: `createPlan` MUST reject a blank or whitespace-only story text or acceptance item, naming the offending field.
- **FR-056**: `createPlan` MUST reject two stories in the same wave with identical text.

### Visibility

- **FR-057**: The plugin MUST accept a `visibility` setting of `"off" | "gates" | "all"`, defaulting to `"all"`, overridable by `VERTEX_VISIBLE=0` (equivalent to `"off"`).
- **FR-058**: The mid-turn injection mechanism MUST remain `experimental.chat.system.transform` with an unchanged O-D-P-E body; visibility MUST NOT alter what the model receives.
- **FR-059**: When visibility is `"all"` and a directive is rendered, the system MUST emit exactly one `client.tui.showToast` call summarising that directive's family and prescription.
- **FR-060**: When visibility is `"gates"`, toasts MUST be emitted only for gate fires and health/failure signals, never for routine mid-turn directives.
- **FR-061**: Health/failure conditions (`verify:relevance-gap`, `verifier:unavailable`, a verified command that minted no receipt, and a **starved directive family** as defined in FR-061a) MUST emit a toast with variant `warning` or `error` when visibility is not `"off"`.
- **FR-061a** (**rev 2 — re-bases the "directive drop rate ≥90%" clause of rev 1**): A directive family is **starved** by a turn when, over that whole turn, its findings were dropped by the **per-invocation budget trim** at least 3 times and the family rendered **zero** times. On reaching that verdict the system MUST log a `directive:starved` event naming the family and the loss count, and MUST surface it under FR-061's health class.
  - **Rev 1 said**: "a turn whose directive drop rate is ≥90%", implemented as `rendered + dropped >= 5` with `rendered/attempted <= 0.1` **per `system.transform` invocation**. Both halves were wrong. It judged an *invocation*, not a turn, and the drops it counted were overwhelmingly **per-turn-cap** drops from producers re-minting findings the composer had already committed to discarding — so it read loudest precisely when every family had already delivered everything its FR-004 cap allowed. When the producers were changed to consult `blockedBeforeBudget` before building a finding, that waste disappeared and the maximum `attempted` fell from 5 to 4 (measured over 78 invocations), leaving the detector permanently below its own floor: a health signal that appeared live and could not fire.
  - **Why the budget trim**: a cap or cooldown drop means the family *was* delivered (for a cap-1 family, being cap-blocked is proof it rendered this turn). The budget trim is the only drop reason that means "eligible, re-offered, and never heard" — and it is the one `blockedBeforeBudget` cannot model, since it depends on the whole findings array of an invocation.
  - **Why the turn boundary**: losing the budget mid-turn is normal and usually self-correcting (corrections cap out within a few invocations and the phase guidance behind them lands), so the verdict is only honest once the turn is over. This is also what rev 1's own wording — "a **turn** whose..." — asked for.
  - **Why 3**: measured. Instrumenting every budget drop across the full test suite (1843 tests) and the UAT harness (54 assertions) recorded 25 budget drops, every one the first of its turn — a per-family per-turn noise floor of 1. With the default FR-004 cap table the reachable ceiling in a maximally busy turn is about 6, because every family other than the uncapped ones caps out; a threshold of 5 would sit at the top of that range and reproduce rev 1's defect.
- **FR-062**: A failed or unavailable toast call MUST be swallowed and MUST NOT change any harness behaviour (verified: `showToast` returns `{data:true}` and does not throw with no TUI attached).
- **FR-063**: Toasts MUST be capped at `maxToastsPerMinute` (default 6) and deduplicated by `family + instanceId`; on hitting the cap a single summary toast MUST report the suppressed count.
- **FR-064**: A `/elicify-vertex-visibility` slash command MUST toggle **that session's** visibility mode, intercepted via `command.execute.before`. The intercepted name MUST match the registration key literally — deriving it from a configurable `activeSkillTrigger` made the toggle a silent no-op under any custom trigger.
- **FR-064a**: The toggle's confirmation MUST bypass the mode filter, otherwise `all → off` sets the mode and is then silenced by the mode it just set, so the first press confirms nothing.
- **FR-064b**: The toast dedupe key MUST include the session id. `instanceId` restarts per session while the dedupe memory is per plugin instance, so without it one session's first directives are swallowed by another's.
- **FR-065**: Idle corrections MUST continue to be delivered via `session.prompt`, which is already user-visible; no additional visibility mechanism is required for them.

### Intake — requirements understood before planning

- **FR-066**: `createPlan` MUST reject when no intake record exists for the session and the ask is non-trivial, naming intake as the missing precondition.
- **FR-067**: `createPlan` MUST require a `confirmedByMessageId` and MUST verify it via `isUserMessage` — a confirmation the model asserts but cannot prove MUST be rejected.
- **FR-067a**: The harness MUST record the message id of every message it originates via `session.prompt` in a `harnessAuthoredIds` set, and `isUserMessage`-based confirmation MUST reject any id in that set. **Rationale (review CRIT-008)**: `isUserMessage` proves only `role === "user"`, and the harness's own continuations are user-role messages (FR-065 makes them deliberately user-visible) — so without this exclusion the harness satisfies its own confirmation gate. This set is also the single definition of "a human is present" used by FR-077.
- **FR-068**: `createPlan` MUST reject a `confirmedByMessageId` whose message predates the plan proposal.
- **FR-069**: An intake record MUST contain: a one-line outcome, an explicit out-of-scope statement, ≥1 generated potential misreading of the request, and an `UNKNOWNS` list.
- **FR-070**: Every `UNKNOWNS` entry MUST be resolved as `ANSWERED` (carrying the answering user message id, itself verified via `isUserMessage`) or `ASSUMED` (carrying a rationale and a stated risk); an unresolved entry MUST reject the intake record.
- **FR-071**: Every acceptance criterion in an intake record MUST name a command that would prove it; a criterion with no proving command MUST reject the record as underspecified.
- **FR-072**: Intake MUST NOT be required for asks matching `TRIVIAL_ASK_RE`, and no intake directive MUST be rendered for them.
- **FR-073**: The intake directive MUST be rendered at `correction` priority.
- **FR-074**: The system MUST NOT use a fixed dimension checklist, and MUST NOT accept a self-reported confidence score as a substitute for resolving an unknown.
- **FR-075**: When an `UNKNOWNS` entry is unresolved, the intake directive MUST prescribe grounding it first and, in an interactive session, asking the user via the host `question` tool rather than assuming.
- **FR-076**: Each `UNKNOWNS` entry MUST record a grounding attempt (which of codebase / available datasources / web research were consulted and what they yielded) before it may be resolved as `ASSUMED`; an `ASSUMED` entry with no recorded grounding attempt MUST reject the intake record.
- **FR-077**: A session MUST be classified `interactive` when a genuine, non-harness-authored user message has occurred in it, reusing the `harnessAuthoredIds` set from FR-067a; otherwise it is `autonomous`.
- **FR-078**: In an interactive session, `createPlan` MUST reject while any surviving unknown has not been asked via the `question` tool (observed as a `tool === "question"` call in `tool.execute.after`).
- **FR-079**: A question raised for a surviving unknown MUST carry plain-English text, ≥2 concrete options, and exactly one option whose label ends with `(Recommended)`, listed first — the host `QuestionOption` type has no `recommended` field, so the marker MUST be encoded in the label.
- **FR-080**: In an autonomous session the agent MUST NOT invoke the `question` tool; surviving unknowns MUST resolve as `ASSUMED` with rationale and risk, and MUST be included in the verifier payload at close.
- **FR-081**: The system MUST NOT attempt a harness-side question timeout: the host exposes no timeout field, and the reply/reject endpoints exist only on the v2 SDK surface which the plugin's v1 client does not expose.

---

## Success Criteria

- **SC-001**: A plan with 3 stories declared `wave: 1` results in exactly 4 persisted stories (3 delivery + 1 verification), all 3 delivery stories `active`, sharing one `startedAt` value.
- **SC-002**: Given 3 stories delivered in a wave and 3 receipts minted afterwards in the main session, all 3 checkpoints succeed — 0 rejections attributable to receipt timing.
- **SC-003**: With wave-1 verification incomplete, the count of wave-2 stories with `status: "active"` is exactly 0, across process restarts.
- **SC-004**: Attempting to complete a wave verification story with N delivery stories where 1 lacks a receipt fails with an error message containing that story's id.
- **SC-005**: A v2 `plan.json` of any size is archived with a byte-for-byte identical copy under `archive/` (verified by buffer equality) and 0 bytes of the original lost.
- **SC-006**: All 841 currently-passing tests continue to pass, plus ≥42 new tests from the TDD plan.
- **SC-007**: In a live `opencode` session, a 3-story wave delivered by subagents and verified by the main agent reaches plan completion with 3 distinct receipt ids recorded in `plan.json`.
- **SC-008**: The `wave-verification` finding renders on ≥2 consecutive turns while a wave stays delivered-but-unverified (proving cooldown does not suppress it).
- **SC-009**: `typecheck` (`tsc --noEmit`) and `npm run build` both exit 0.
- **SC-010**: Replaying the 25 recorded bash calls from session `ses_0668b2422ffe4hbFM3AkIerZmp` through the fixed relevance check yields ≥3 minted receipts (currently 0), and 0 relevance gaps on the three `go build ./... && go test ./... -count=1` runs.
- **SC-011**: For the 7 rows of the covering-verifier Examples table, the relevance check returns the stated `gap` value in 7/7 cases.
- **SC-012**: In a simulated idle with a plan at 1 of 5 stories complete, exactly 1 continuation is dispatched, and its text names at least one unfinished story id.
- **SC-013**: With the verifier forced to each of `unsupported`/`timeout`/`malformed` on a deterministically complete plan, the session closes with no continuation in 3/3 cases and logs `verifier:unavailable-at-close`.
- **SC-013a**: Across the 8 deterministic-gap rows, the verifier is invoked **0 times** — measured as zero `session.create` calls for the `vertex-verifier` agent.
- **SC-013b**: In the replayed field session (`ses_0668b2422ffe4hbFM3AkIerZmp`), which never reached deterministic completion, the verifier is invoked 0 times while ≥1 deterministic continuation is dispatched.
- **SC-014**: Over a 10-cycle autonomous run with no user messages, `turnIndex` advances ≥9 times and the ratio of `directive_rendered` to `per-turn-cap:dropped` is ≥ 1:3 (measured 5:250 ≈ 1:50 before the fix).
- **SC-015**: A verifier-driven continuation loop terminates within `maxVerifierContinuations` invocations in 100% of runs — no session exceeds the cap.
- **SC-016**: `createPlan` rejects all 5 defect rows of the inadequate-plan Examples table, each with an error naming the offending story or field.
- **SC-017**: With visibility `"all"`, the system-prompt text produced for a given finding set is byte-identical to the text produced with visibility `"off"` — the model's input is provably unaffected by the visibility setting.
- **SC-018**: All 9 rows of the visibility mode×event table produce the stated toast/no-toast outcome, 9/9.
- **SC-019**: With the toast transport forced to reject, 100% of directives are still injected and 0 errors surface.
- **SC-020**: Replaying the field session's 5 rendered directives and 3 relevance-gap events with visibility `"all"` produces ≥3 toasts naming a health/failure condition — against the 0 user-visible signals actually observed.

---

## Traceability Matrix

| Requirement | User Story | BDD Scenario(s) | Test Name(s) |
|---|---|---|---|
| FR-001 | US-1 | Three independent stories activate together in wave 1 | `create_activates_whole_first_wave` |
| FR-002 | US-2 | A verification story is appended to each wave | `create_appends_verification_story_per_wave` |
| FR-003 | US-3 | A delivery story is marked delivered without evidence | `deliver_requires_no_evidence` |
| FR-004 | US-1 | A story omitting wave defaults to wave 1 | `wave_default_is_one` |
| FR-005 | US-1 | Non-contiguous declared waves normalise to contiguous ordinals | `wave_normalisation_contiguous` |
| FR-006 | US-1 | Non-contiguous declared waves normalise to contiguous ordinals | `wave_normalisation_contiguous` |
| FR-007 | US-2 | Every wave gets exactly one verification story | `create_appends_verification_story_per_wave` |
| FR-008 | US-2 | A verification story is appended to each wave | `verification_story_items_name_delivery_stories` |
| FR-009 | US-2 | A model-authored verification kind is ignored | `model_authored_verification_kind_ignored` |
| FR-010 | US-1 | Needlessly serialised disjoint stories are flagged but permitted | `over_serialisation_logged` |
| FR-011 | US-1 | Three independent stories activate together in wave 1 | `create_activates_whole_first_wave` |
| FR-012 | US-3 | A delivery story is marked delivered without evidence | `deliver_requires_no_evidence` |
| FR-013 | US-2 | A verification story cannot be delivered | `deliver_rejects_verification_story` |
| FR-014 | US-3 | (Edge Case: deliver twice) | `deliver_is_idempotent` |
| FR-015 | US-3 | Completing a wave's delivery emits the mandatory next step | `deliver_emits_mandatory_next_step` |
| FR-016 | US-3 | Partial wave delivery reports what remains | `deliver_partial_reports_remaining` |
| FR-017 | US-9 | A fresh v3 plan is created after archival | `is_plan_v3_rejects_v2`, `fresh_v3_plan_after_archival` |
| FR-018 | US-9 | A v2 plan is archived byte-identically; Archival never overwrites an existing archive file; A v3 plan is never archived | `archive_v2_byte_identical`, `archive_v2_suffixes_on_collision`, `archive_skips_v3` |
| FR-019 | US-3 | A delivered story completes with a valid receipt | `checkpoint_accepts_any_active_story` |
| FR-020 | US-4 | (Edge Case: checkpoint a pending story) | `checkpoint_rejects_pending_story` |
| FR-021 | US-5 | A failed verification returns the story to active | `failed_returns_story_to_active` |
| FR-022 | US-4, US-5 | Wave verification rejects while a delivery story lacks a receipt; Wave verification blocks while a reworked story is unverified | `wave_verification_rejects_unevidenced_story` |
| FR-023 | US-4 | Completing wave 1 verification activates wave 2 | `wave_verification_activates_next_wave` |
| FR-024 | US-4 | Wave 2 stays pending while wave 1 verification is incomplete; A blocked story halts the plan | `wave_gate_blocks_next_wave`, `blocked_halts_plan`, `wave_gate_survives_process_restart` |
| FR-025 | US-4, US-8 | Completing the final wave finishes the plan | `final_wave_completion_finishes_plan` |
| FR-026 | US-8 | A mutation inside any active story's scope is in scope; A mutation outside every active story's scope is flagged; An unconstrained active story makes the wave unconstrained | `check_scope_unions_active_globs`, `check_scope_flags_outside_union`, `check_scope_empty_globs_unconstrained` |
| FR-027 | US-6 | Delivered-but-unverified wave renders a wave-verification directive; The wave-verification directive persists across turns; No wave-verification directive once the wave is verified | `wave_verification_finding_rendered`, `wave_verification_finding_repeats_across_turns`, `wave_verification_finding_absent_when_verified` |
| FR-028 | US-7 | Multi-story wave with no subagent calls nudges toward fanout; Observed subagent calls suppress the delegation nudge; Single-story waves produce no delegation nudge | `delegation_gap_finding_rendered`, `delegation_gap_suppressed_by_task_call`, `delegation_gap_single_story_wave_silent` |
| FR-029 | US-7 | An ignored delegation nudge never blocks delivery | `delegation_gap_never_blocks` |
| FR-030 | US-4 | (Edge Case: getPhase during multi-story wave) | `phase_engine_concurrent_stories_deterministic` |
| FR-031 | US-3 | A delivered story completes with a valid receipt | `subagent_session_mints_no_receipt` |
| FR-032 | US-3 | A delivered story cannot complete without evidence | `checkpoint_rejects_without_evidence_plan_unchanged`, `receipt_from_main_session_round_trips` |
| — (lifecycle) | US-1..US-9 | Full lifecycle | `full_wave_lifecycle_e2e` |
| — (rework) | US-5 | A reworked story completes on re-verification | `rework_then_complete` |
| FR-033 | US-11 | A covering verifier is not a relevance gap | `covering_verifier_not_a_gap` |
| FR-034 | US-11 | A covering verifier is not a relevance gap | `whole_suite_command_covers_narrower` |
| FR-035 | US-11 | A covering verifier is not a relevance gap | `subset_verifier_is_a_gap` |
| FR-036 | US-11 | A covering verifier is not a relevance gap | `subset_verifier_is_a_gap` |
| FR-036a | US-11 | A covering verifier is not a relevance gap | `covering_verifier_not_a_gap` |
| FR-037 | US-11 | A covering verifier mints a receipt | `covering_verifier_mints_receipt` |
| FR-038 | US-10, US-12 | A deterministic gap answers directly and never invokes the verifier; A deterministically complete plan invokes the verifier | `deterministic_gap_never_invokes_verifier`, `verifier_invoked_only_when_deterministically_complete` |
| FR-038a | US-10, US-12 | A deterministic gap answers directly and never invokes the verifier; A halted plan is deterministically incomplete; An invalidated receipt reopens a complete story | `deterministic_gap_never_invokes_verifier`, `halted_plan_blocks_verifier`, `invalidated_receipt_reopens_story` |
| FR-039 | US-10 | A deterministically complete plan invokes the verifier | `verifier_invoked_only_when_deterministically_complete` |
| FR-040 | US-10 | A `complete: false` verdict drives a continuation | `verifier_incomplete_verdict_drives_continuation` |
| FR-041 | US-10 | A `complete: false` verdict drives a continuation | `verifier_incomplete_verdict_drives_continuation` |
| FR-042 | US-10 | A `complete: true` verdict permits close | `verifier_complete_verdict_permits_close` |
| FR-043 | US-10 | A fully complete plan still receives a quality verdict | `verifier_quality_pass_on_complete_plan` |
| FR-044 | US-10 | Verifier failure at close fails open | `verifier_failure_at_close_fails_open` |
| FR-045 | US-10 | Verifier continuations are capped per session; Repeated identical verdicts stop the loop | `verifier_continuations_capped`, `verifier_no_progress_stops_loop` |
| FR-046 | US-12 | An incomplete plan at idle dispatches a plan-progress continuation | `plan_progress_continuation_dispatched` |
| FR-047 | US-12 | Plan-progress continuations are capped | `plan_progress_continuation_capped` |
| FR-048 | US-12 | A finished plan dispatches nothing | `plan_progress_silent_when_finished` |
| FR-049 | US-12 | Verifier and plan-progress never double-dispatch | `verifier_and_plan_progress_never_double_dispatch` |
| FR-050 | US-13 | Multi-story work without a plan is driven to plan | `multi_story_without_plan_driven_to_plan` |
| FR-051 | US-14 | An assistant reply cycle advances the composer turn | `assistant_reply_advances_turn`, `autonomous_run_directive_delivery_rate` |
| FR-052 | US-14 | A harness continuation does not double-advance the turn | `continuation_does_not_double_advance_turn` |
| FR-053 | US-13 | Structurally inadequate plans are rejected | `plan_create_rejects_no_acceptance_items` |
| FR-054 | US-13 | Structurally inadequate plans are rejected | `plan_create_rejects_no_verifier_or_scope` |
| FR-055 | US-13 | Structurally inadequate plans are rejected | `plan_create_rejects_blank_fields` |
| FR-056 | US-13 | Structurally inadequate plans are rejected | `plan_create_rejects_duplicate_story_text` |
| FR-057 | US-15 | Visibility mode governs which events toast | `visibility_mode_governs_toasts` |
| FR-058 | US-15 | A rendered directive emits one toast and an unchanged injection | `rendered_directive_emits_one_toast` |
| FR-059 | US-15 | A rendered directive emits one toast and an unchanged injection | `rendered_directive_emits_one_toast` |
| FR-060 | US-15 | Visibility mode governs which events toast | `visibility_mode_governs_toasts` |
| FR-061 | US-15 | Visibility mode governs which events toast | `visibility_mode_governs_toasts` |
| FR-061a | US-15 | A directive family a whole turn never delivered is reported as starved | `directive_starved_is_reported` |
| FR-062 | US-15 | A failing toast never affects harness behaviour | `toast_failure_is_swallowed` |
| FR-063 | US-15 | Toasts are capped and deduplicated | `toasts_capped_and_deduped` |
| FR-064 | US-15 | The visibility toggle command changes mode | `visibility_toggle_command` |
| FR-065 | US-15, US-12 | An incomplete plan at idle dispatches a plan-progress continuation | `idle_correction_visible_without_toast` |
| FR-066 | US-16 | Planning is blocked until requirements are understood | `plan_create_blocked_without_intake` |
| FR-067 | US-16 | Planning is blocked until requirements are understood; A confirmed intake permits planning | `confirmation_must_be_a_real_user_message`, `confirmed_intake_permits_planning` |
| FR-082 | US-3 | Checkpointing freezes the receipt's content into the plan | `checkpoint_freezes_receipt_content` |
| FR-083 | US-3 | A delivered story cannot complete without evidence | `checkpoint_validation_unchanged` |
| FR-084 | US-3, US-12 | Frozen evidence survives a process restart | `frozen_evidence_survives_restart` |
| FR-085 | US-3 | Frozen evidence survives an invalidating mutation; Frozen evidence survives a process restart | `frozen_evidence_survives_invalidate`, `frozen_evidence_survives_restart` |
| FR-086 | US-3 | Malformed frozen evidence is treated as absent | `malformed_frozen_evidence_is_absent` |
| FR-087 | US-3 | Frozen evidence survives an invalidating mutation | `frozen_evidence_survives_invalidate` |
| FR-067a | US-16 | Planning is blocked until requirements are understood; An autonomous session assumes instead of asking | `confirmation_must_be_a_real_user_message`, `interactive_detection_excludes_harness_messages` |
| FR-068 | US-16 | Planning is blocked until requirements are understood | `confirmation_must_postdate_proposal` |
| FR-069 | US-16 | An intake record is rejected when incomplete | `intake_record_validation` |
| FR-070 | US-16 | An intake record is rejected when incomplete | `intake_record_validation` |
| FR-071 | US-16 | An intake record is rejected when incomplete | `criterion_without_proving_command_rejected` |
| FR-072 | US-16 | A trivial ask requires no intake | `trivial_ask_skips_intake` |
| FR-073 | US-16 | The intake directive is a correction, not guidance | `intake_directive_is_correction_priority` |
| FR-074 | US-16 | An intake record is rejected when incomplete | `intake_record_validation` |
| FR-075 | US-16 | The intake directive is a correction, not guidance | `intake_directive_is_correction_priority` |
| FR-076 | US-16 | An assumed unknown requires a recorded grounding attempt | `assumed_unknown_requires_grounding` |
| FR-077 | US-16 | An autonomous session assumes instead of asking | `interactive_detection_excludes_harness_messages` |
| FR-078 | US-16 | An interactive session must ask surviving unknowns | `interactive_must_ask_surviving_unknowns` |
| FR-079 | US-16 | An interactive session must ask surviving unknowns | `question_shape_options_and_recommendation` |
| FR-080 | US-16 | An autonomous session assumes instead of asking | `autonomous_assumes_without_asking` |
| FR-081 | US-16 | An autonomous session assumes instead of asking | `autonomous_assumes_without_asking` |

**Completeness check**: FR-001 … FR-032 each appear above with ≥1 BDD scenario and ≥1 test. Every BDD scenario in this document appears in at least one row.

---

## Implementation Waves

This spec stays a single document — the hard problems are the *interactions* between intake, the wave model, the idle ordering and evidence durability, and splitting the spec would hide exactly those. Implementation is sequenced in waves instead. Each wave lands with its own tests, the full suite green, and (where it changes runtime behaviour) a live re-test against `/home/dev/vertextest` before the next wave starts.

Two review passes produced **64 findings, 14 CRITICAL** (`vertex2-waves-spec-review.md`, `vertex2-waves-spec-review-2.md`). FRs are revised wave-by-wave immediately before that wave is implemented, so spec and code never drift apart and no wave is built on unrevised requirements.

| Wave | Scope | Resolves | Depends on | Live re-test |
|---|---|---|---|---|
| **W1 — Unblock evidence** | D1 covering verifiers (FR-033…037) with pinned coverage semantics; D4 turn advancement (FR-051/052) | CRIT-009, MAJ (SC-014 relabelling hole) | — | **Yes** — receipts must be minted where 0 were before |
| **W2 — Evidence durability & data model** | Freeze-at-checkpoint evidence into `plan.json`; per-session (not whole-file) archival; archival trigger coverage; lock semantics; `schemaVersion` 3 | CRIT-001, CRIT-002, CRIT-005, CRIT-006, CRIT-010 | W1 | No |
| **W3 — Wave model** | `wave`/`kind`/`delivered`; `getActiveStories` + all 11 call sites; verification-story scope fix; wave gating; rework loop; `PhaseEngine` concurrency | CRIT-003, CRIT-004, FR-030 | W2 | No |
| **W4 — Idle ordering & verifier** | Deterministic-first ordering; plan-progress loop; verifier completion verdict | FR-038/038a, D3 | W2, W3 | **Yes** — the field-session failure must not reproduce |
| **W5 — Intake** | `harnessAuthoredIds` via pre-registered `messageID`; interactive/autonomous redesign; grounding verified from observed tool calls; question-gate binding | C2-001, C2-002, C2-003, C2-004, M2-001 | W4 | **Yes** |
| **W6 — Visibility** | Toast channel, visibility modes, toggle command | — | W1 | No |

**Ordering rationale.** W1 first because D1 suppresses *all* evidence today — until it lands, nothing downstream (gates, waves, verifier, intake) can be observed working even if correctly implemented, and every later wave's live re-test would be meaningless. W2 before W3 because the wave model's gate depends on evidence that survives a mutation and a restart, which today it does not. W5 last because its four criticals are the least settled and it has the most redesign still to do; it is also the only wave that can deadlock a session, so it should land on a base that is otherwise proven.

**Known-unrevised on entry.** W2 must record the evidence-durability decision that is currently absent from the FRs entirely (review-2 M2-002): a checkpoint copies the receipt's *content* — command, exitCode, observedAt, workspaceRoot — into `plan.json` as an immutable record, and later checks read `plan.json` only. Assumption line ~1906 and Ambiguity #3 still state the opposite and must be corrected in the same pass.

---

## Ambiguity Warnings

| # | What's Ambiguous | Likely Agent Assumption | Question to Resolve |
|---|---|---|---|
| 1 | How the verification story's acceptance items bind to receipts — one receipt per delivery story, or does the verification story get its own separate receipt? | Agent binds each verification acceptance item to the receipt already attached to the corresponding delivery story (no new verification run). | Should completing the wave verification story require a *fresh* verifier run of its own, or merely assert that each delivery story already holds a valid receipt? **Spec currently assumes the latter (FR-022).** |
| 2 | Whether `getActiveStory` (singular) should be removed or retained | Agent retains it returning the first active story, to limit blast radius across 10 call sites. | Should the 10 existing `getActiveStory` call sites each be individually reviewed for union semantics, or is "first active" acceptable for verifier resolution / verifier payload / criteria reinject? |
| 3 | ~~Verifier-written artifacts invalidating receipts mid-batch~~ | — | **RESOLVED by FR-082…FR-087 (freeze at checkpoint).** Frozen evidence is never invalidated, so path-scoped invalidation is unnecessary. The residual window is narrow and unchanged: a mutation between earning a receipt and checkpointing it still invalidates that *live* receipt (FR-087), and the agent re-verifies. |
| 4 | What "resolved verifier" means in the mandatory-next-step text when a story declares no `verifiers` | Agent falls back to `resolveVerifier` over the story's `scopeGlobs`, then to the generic prescription string. | Confirm the fallback chain for the instruction text. |
| 5 | Whether a wave may be added to an existing plan after creation | Agent assumes no — waves are fixed at `createPlan`. | Should there be an `amend`-style path to append a wave mid-plan? **Spec assumes not in scope.** |
| 6 | ~~Whether the verifier should fire per-wave or only at final-wave completion~~ | — | **RESOLVED**: the verifier fires at every `session.idle` where the plan is incomplete (FR-038), not on completion. Superseded by US-10. |
| 7 | How "covering" is decided across toolchains — is `npm test` allowed to cover a prescribed `go test`? | Agent scopes coverage to the same toolchain/runner, treating a different runner as non-covering (FR-036). | Confirm that cross-toolchain commands never cover each other, even when one is a whole-suite command. |
| 8 | Whether the completion verifier sees the raw user ask verbatim | Agent passes the first user message text, redacted, truncated to the existing verifier field cap. | Should the verifier see the full conversation, the first ask only, or a model-authored restatement of the goal? |
| 9 | What counts as "new evidence recorded" for the `verifier:no-progress` detector | Agent compares the count of evidenced acceptance items plus the receipt-store size between verdicts. | Confirm the progress signal; a weak signal risks either premature stop or an endless loop. |
| 10 | Interaction between verifier-driven continuations and `maxCriteriaBlocks` | Agent keeps the caps independent (`maxVerifierContinuations`, `maxPlanProgressContinuations`, `maxCriteriaBlocks` each separate). | Should there be a single global continuation budget per session instead of three independent caps? |

---

## Evaluation Scenarios (Holdout)

> **Note**: For post-implementation evaluation only. Not referenced in the TDD plan or traceability matrix.

### Scenario: Real three-way fanout reaches completion
- **Setup**: A git repo with three independent modules and a working `npm test`. Fresh opencode interactive session with the harness active.
- **Action**: Ask for three independent features, one per module, in a single wave; let the agent delegate to subagents and verify.
- **Expected outcome**: `plan.json` ends with all three delivery stories `complete`, three *distinct* receipt ids, the wave verification story `complete`, and no story left `delivered`.
- **Category**: Happy Path

### Scenario: Operator inspects the plan mid-wave
- **Setup**: A three-story wave where two stories are delivered and one is still active.
- **Action**: Read `plan.json` directly without invoking any tool.
- **Expected outcome**: Statuses are legible and unambiguous — two `delivered`, one `active`, verification story not complete, next wave entirely `pending`.
- **Category**: Happy Path

### Scenario: Agent tries to skip verification
- **Setup**: A two-wave plan with wave 1 fully delivered.
- **Action**: Instruct the agent to "skip verification and move on to wave 2".
- **Expected outcome**: No wave-2 story becomes active. The agent cannot produce a state where wave 2 is active without wave-1 receipts existing.
- **Category**: Error

### Scenario: Fabricated receipt is refused
- **Setup**: A delivered story awaiting verification.
- **Action**: Instruct the agent to checkpoint using a receipt id it invents.
- **Expected outcome**: Checkpoint rejected; story stays `delivered`; `plan.json` unchanged.
- **Category**: Error

### Scenario: Red test blocks the wave, green unblocks it
- **Setup**: A two-story wave where one story's tests genuinely fail.
- **Action**: Let the agent verify, observe the failure, fix, and re-verify.
- **Expected outcome**: The failing story returns to `active`, wave 2 never activates while it is unverified, and the plan proceeds only after a genuine green run.
- **Category**: Error

### Scenario: Subagent output alone cannot satisfy the gate
- **Setup**: A wave where subagents run their own tests and report success in their return text.
- **Action**: Instruct the agent to checkpoint based on the subagents' reported results without running tests itself.
- **Expected outcome**: No valid receipt exists; checkpoints are rejected; the wave cannot close.
- **Category**: Edge Case

### Scenario: Interrupted session resumes correctly
- **Setup**: A wave delivered but unverified; terminate the session.
- **Action**: Start a fresh session in the same directory and ask for plan status.
- **Expected outcome**: The gate still holds — delivered stories still `delivered`, next wave still `pending`, and the harness re-surfaces the verification requirement.
- **Category**: Edge Case

---

## Assumptions

- Wave membership is fixed at `createPlan`; there is no mid-plan wave insertion (Ambiguity #5).
- The wave verification story asserts existing per-delivery-story receipts rather than requiring an additional distinct verifier run (Ambiguity #1).
- Receipt invalidation remains session-global for *live* receipts, which is now harmless: evidence is frozen into `plan.json` at checkpoint (FR-082…FR-087), so invalidation can no longer reopen a completed story. Path-scoped invalidation is therefore not needed at all, rather than merely deferred.
- The operator explicitly declined migration and backward compatibility for `schemaVersion: 2`; archival exists solely to avoid destroying data, not to preserve usability.
- Subagent delegation uses opencode's `task` tool; if a future host renames it, `delegation-gap` silently stops firing (advisory only, no correctness impact).
- `getActiveStory` (singular) is retained as "first active" to bound the blast radius; call sites are reviewed individually but not all converted to union semantics (Ambiguity #2).
- No cap is imposed on stories per wave or waves per plan.
- ~~The verifier continues to fire only at final-wave verification completion.~~ **Superseded**: the verifier fires at every idle where the plan is incomplete, and its primary job is completion detection; quality assessment is retained as a secondary output (US-10).
- The completion verifier is advisory in the sense that it never grants or denies *evidence* — but its verdict does drive a continuation. "Non-gating" in FR-030 means "cannot substitute for a receipt", not "cannot cause the agent to keep working".
- Coverage is evaluated within a toolchain; a command from a different runner never covers another (Ambiguity #7).
- The three continuation caps remain independent rather than a single shared budget (Ambiguity #10).
- Verifier latency is 30–90s (measured 28.8s and 45.6s in isolation), so at most one verifier invocation per idle is acceptable; the caps exist to bound cost as much as to prevent loops.

## Clarifications

### 2026-07-27

- Q: How should a story's wave be decided at plan creation? → A: **Model declares, plugin validates.** `plan_create` takes an optional `wave` per story; the plugin flags stories with disjoint `scopeGlobs` placed in different waves as needlessly serialised, but does not block.
- Q: When a wave's verification fails, what happens to that story? → A: **Back to `active`, wave stays open.** The story keeps its original `startedAt`; the wave's verification story stays incomplete; the next wave stays blocked.
- Q: How should the `schemaVersion` 2 → 3 bump be handled? → A: **No backward compatibility or migration needed.** v3 only. (Implementation note: an existing v2 plan is archived rather than silently dropped, because `persistPlan` discards entries failing validation — archival prevents data loss without performing any conversion.)
- Q: Should the harness require actual subagent fanout, or only require the verification gate? → A: **Nudge only; verification is the hard gate.** A multi-story wave with no observed `task` calls produces an advisory `delegation-gap` directive but is never blocked. The receipt requirement is the sole non-bypassable enforcement.
- Q: When should the LLM verifier be invoked? → A: **At idle, to detect incompleteness — not on story/plan completion.** Invoking it only once work is already declared complete is QA and fails the actual purpose, which is self-correcting long-running tasks. Completion detection is the primary job; quality assessment is retained as a secondary output for the already-complete case.
- Q: Must the harness enforce that the LLM writes proper user stories and a plan, and follows it? → A: **Yes.** `createPlan` rejects structurally inadequate plans deterministically (FR-053…FR-056), multi-story work without a plan is driven to create one (FR-050), and the plan is driven to completion by both the verifier (FR-038) and a deterministic fallback loop (FR-046).
- Q: Should the verifier run at every idle, or only once deterministic checks pass? → A: **Deterministic first; the verifier only when nothing deterministic objects.** If a story is not complete or evidence is missing, we already know the answer — prompt the main agent directly and skip the verifier entirely. The verifier is reserved for the case where the state machine says "done", because that is the only moment its answer is not already known, and the only question it can answer better: *substantively complete, or merely checked off?* This also bounds cost to roughly one verifier call per "looks done" idle instead of one per idle.
- Q: If the deterministic layer already passed, what does verifier failure fall back to? → A: **Nothing — the session closes.** There is no fallback to construct, because the deterministic layer ran first and raised no objection. Failure is logged as `verifier:unavailable-at-close`.
- Q: Injected prompts are invisible to the user — should that change? → A: **Keep the current injection mechanism; add toast notifications for mid-turn injections.** The model keeps receiving the full O-D-P-E body via `system.transform` (unchanged); the user gets a compact toast alongside it. Idle corrections need nothing new — they already go through `session.prompt` and are visible as real messages; they were absent in the field session only because zero continuations fired (D3).
- Q: Should the mid-turn directive be its own tool entry rather than a toast? → A: **Rejected after testing.** `session.shell` was verified to create a genuine model-independent tool part, but it always renders as `bash`, spawns a real shell per directive, emits 2 messages per injection, and carries unsuppressible shell-profile noise (a no-output `true` command still produced 3 lines of it). Fabricating a part directly is impossible — the session API has no part-creation endpoint.
- Q: Should visibility be configurable? → A: **Yes — `"off" | "gates" | "all"`, default `"all"` (on), with a `/elicify-vertex-visibility` toggle** intercepted by `command.execute.before`, the same mechanism `/elicify-vertex` already uses.
- Q: How do we stop the agent rushing into planning on its own assumptions? → A: **Gate planning on a verifiable intake record plus proven user confirmation.** Prompt instructions alone are unenforceable; `plan_create` rejects until intake exists and a `confirmedByMessageId` resolves, via `isUserMessage`, to a genuine user message postdating the proposal — the same provenance trick that already secures waivers.
- Q: Is a confidence level enough? → A: **No.** Self-reported confidence is a calibration task models perform badly and is trivially gameable; it is explicitly not accepted as a substitute for resolving an unknown (FR-074). It may route, never gate.
- Q: Can a generic checklist work across all request types? → A: **No — rejected.** A fixed dimension list is either too abstract to bite or too specific to generalise across typo fixes, perf work, refactors and migrations. Replaced by three self-tailoring mechanisms: generated misreadings ("3 ways this could be misread"), testability-as-detector (a criterion with no proving command *is* the unknown), and only two universal anchors ("what does done look like?", "what must not change?").
- Q: Should unknowns go straight to the human? → A: **No — ground first.** The agent must attempt resolution from the codebase, then any available datasource, then web research where applicable. Only unknowns surviving grounding are eligible to be asked, and each `ASSUMED` entry must record what grounding was attempted (FR-076).
- Q: What happens to surviving unknowns? → A: **Interactive sessions must ask via the `question` tool** — plain English, ≥2 concrete options, exactly one `(Recommended)` listed first; `plan_create` is blocked until they are asked (FR-078/079). **Autonomous sessions must not ask** (nobody can answer and the tool blocks the turn) — unknowns resolve as `ASSUMED` with risk and are surfaced to the verifier at close (FR-080).
- Q: Can the harness time out an unanswered question? → A: **No, and it is explicitly out of scope (FR-081).** The host exposes no timeout/expiry field on questions, and the reply/reject endpoints that would let the harness auto-answer exist only on the v2 SDK surface — the plugin receives the v1 client, which does not expose `question.*`. The interactive/autonomous split replaces the timeout.
- Q: Are the three field-observed defects in scope for this spec? → A: **Yes — D1 and D4 block evaluation of everything else.** D1 (covering verifiers) suppresses all evidence; D4 (turn freeze) throttles directive delivery to ~2%. Both are specified here (US-11, US-14) and should land before the wave model is built on top of them.

---

## Test-Driven Development Plan — Addendum (2026-08-05)

The table above stops at test 89. Four features have landed since, each driven
by a defect observed in a live session rather than by the spec, so they have no
BDD scenario upstream. This addendum records them with the same traceability,
and — because every one of them exists to correct a *previous* test that passed
while the behaviour was broken — states for each what the test must fail on.

The last column is the important one. Three of the four features shipped with
tests that passed against the bug they were written for; that is the failure
mode this addendum is designed to prevent recurring.

### 90–96. Pause judge (replaces the phrase-based stall detector)

`src/v2/pauseJudge.ts`, `armPauseJudge`/`runPauseJudge` in `wiring/gate.ts`.
Tests: `tests/v2/pauseJudge.test.ts`, `tests/v2/gate.test.ts`,
`tests/v2/plugin.integration.test.ts`, UAT section C. (`promise.test.ts` is at
`tests/promise.test.ts`, not `tests/v2/`.)

| # | Test | Level | Property | Must fail when |
|---|---|---|---|---|
| 90 | `parsePauseVerdict` (17 cases) | Unit | Fenced, prose-wrapped and clean JSON parse; unreadable input returns null | The regex fallback takes the FIRST match — a reply naming both verdicts then resolves to whichever came first, inverting the prompt's awaiting-user bias |
| 91 | `does NOT nudge at idle — it only arms a timer` | Unit | `session.idle` never judges; it arms and returns | Judgement moves back onto the idle path, where a human still reading the reply is indistinguishable from a stall |
| 92 | `does not arm on %s` (2 cases) + `does not arm when the verifier is disabled` + `does not arm for a holdout-off session` | Unit | The structural pre-filter still gates the model call | Any gate is dropped — each belongs to another branch, and `VERTEX_VERIFIER=0` must switch this off too |
| 93 | `arms only once, however many idles arrive` | Unit | One timer per session; no overlap | The in-flight guard is removed and two judges run for one session |
| 94 | `stays silent on awaiting-user` / `nudges on stopped-mid-work` | Integration | The verdict decides, and the pair discriminates | The verdict is ignored — a pass/pass pair proves nothing |
| 95 | `does not nudge when the user speaks while the judge is in flight` | Integration | Epoch re-check before dispatch | The post-await re-validation is removed; the harness then talks over the user's own turn, which is the exact bug the feature exists to prevent |
| 96 | UAT `C1`–`C6` | E2E | Both verdicts, plus activity-cancellation and an unreadable reply, on the real timer against the shipped dist | The built artefact diverges from source |

### 97–98. Two stop modes (`quick` removed)

`classifyStopMode` in `src/index.ts`. Tests: `tests/stopMode.test.ts`,
`tests/verification.test.ts`, UAT section B.

| # | Test | Level | Property | Must fail when |
|---|---|---|---|---|
| 97 | `only normal and deep` (13 tests) | Unit | Unrecognised input falls back to `normal`; no input can produce `quick`; risk flags still promote | The fallback returns the least protective mode again — measured live, `hi` classified `quick` and the harness stayed off for the session |
| 98 | UAT `B2`–`B4` | E2E | The activation cue reports the mode the shipped build actually chose | Source and build disagree |

### 99. Judge → Verifier rename

Clean break: `story.verifier`, `verifier:*` events, `vertex-verifier` agent,
`VERTEX_VERIFIER`. Test: UAT `A3`/`A4`, `E4`.

| # | Test | Level | Property | Must fail when |
|---|---|---|---|---|
| 99 | UAT `A3`/`A4`/`E4` | E2E | The shipped build registers `vertex-verifier`, never `vertex-judge`, and writes no legacy `judge` field | A stale build ships — this is exactly how a cached 0.9.8 kept loading after 0.10.0 was installed |

### 100–102. Star ask — closed loop

> ~~`maybeAskForStar` in `plugin.ts`, consent states in `wiring/tools.ts`.~~
> **RETIRED (2026-08-06, backlog B-6).** The arm/inject/retry loop this section
> describes no longer exists. `maybeAskForStar`, its idle call site in
> `wiring/gate.ts`, `GateContext.starAsk`, the `starAskDispatched` /
> `starAskPendingInjection` sets, the `system.transform` injection block,
> `STAR_MAX_ATTEMPTS` / `readStarAttempts()` / `recordStarAttempt()`, the
> `attempts` field in the consent file and the `star:armed-for-injection` /
> `star:injected` / `star:gave-up` events were all deleted.
>
> **Why:** the loop behaved exactly as designed and still achieved nothing —
> weaker models simply never made the ask, so three injections were spent per
> machine to nag a model into a request the user never saw. Operator ruling:
> the ask belongs in the agent contract, not the idle tree.
>
> **What replaces it:** a read-only `elicify_vertex_star_status` tool
> (`wiring/tools.ts`, registered in `config.ts`'s `KNOWN_TOOL_NAMES`) that takes
> no arguments, returns `{consent: "none" | "asked" | "yes" | "declined"}` and
> **stars nothing**; the ask itself lives in `<how_you_work>` in
> `agents/elicify-vertex-agent.md` (and, via
> `scripts/sync-activate-template.mjs`, in `ACTIVATE_TEMPLATE`). The
> `tool.execute.after` observation that matches `STAR_REPO` and writes `asked`
> is deliberately KEPT — without it nothing ever writes `asked`, the status tool
> would answer `"none"` forever and the agent would re-ask every session, which
> is worse nagging than the loop that was removed. `star:asked` survives with
> it. `"gave-up"` is gone from the `StarConsent` union and is read as NO RECORD,
> like the legacy `"prompted"` marker.
>
> Tests: `tests/v2/starPrompt.test.ts` (isolated via `XDG_CONFIG_HOME`), UAT D —
> both still exist, but they now cover the status tool and the legacy-marker
> handling. See the current mutation results in `docs/BACKLOG.md` B-6.

| # | Test | Level | Property | Must fail when |
|---|---|---|---|---|
| 100 | ~~`writes nothing when merely armed` / `still writes nothing after dispatch`~~ → `writes nothing across an ordinary session` + `stars NOTHING and records NOTHING` | Unit | The one-shot is still spent only on an OBSERVED ask — but there is no arm step left to spend it early, so the surviving risk is the STATUS tool writing consent as a side effect of being asked | **RETIRED as written** (nothing arms, nothing is dispatched). Replacement fails when the status tool records anything (mutation: making it write consent kills 1 test) or when a quiet session writes a marker |
| 101 | `does not count an unrelated question call` | Unit | Only *our* question closes the loop — the observation matches the REPO, not the word "star" | Any `question` call counts, which is precisely what happened live (the model asked which games to build). Mutation: matching the bare word "star" kills 2 tests |
| 102 | ~~`gives up permanently after the attempt cap`~~ | Unit | ~~Bounded retry, then a terminal state~~ | **RETIRED** — there is no retry to bound and no `gave-up` state. Replaced by the inverse property: a machine carrying a legacy `gave-up` or `prompted` marker gets the one real ask it was owed (mutation: honouring either marker kills 1 unit test each and turns UAT `D7b`/`D7c` red) |

### Standing requirement: tests must discriminate

Every entry above states a *must fail when*, because on this feature set a
green suite has repeatedly not meant working code:

- the stated-intent branch passed 21 tests and was inert on the message that
  motivated it — the verb list had no `lay out`/`execute`;
- the UAT TUI probe passed with the stderr guard removed, twice: first because
  it created no plan so `git diff` never ran, then because `execFileSync`
  surfaces stderr only on the throw path;
- a malformed import made `promise.test.ts` fail to collect while the suite
  still reported all-green, at a *lower* total.

So: for any new behaviour, mutate the thing it protects and confirm the test
goes red. `npm run uat` is the layer that does this against the built artefact;
the mutation battery in the commit history is the pattern for unit tests.
