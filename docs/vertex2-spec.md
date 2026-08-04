# Feature Specification: Vertex 2 — Phase-Aware Guidance Harness

**Created**: 2026-07-25
**Revised**: 2026-07-25 (**rev 3** — applies the independent adversarial review round)
**Status**: Final — revised
**Input**: Greenfield design `docs/vertex2-greenfield.html` + session design review (guide-over-gate, three-tier composer, story contracts). Full Vertex 2 scope in one spec; priorities P0–P2 map to the migration order.
**Review**: `docs/vertex2-spec-review.md` — independent round against rev 2, verdict **BLOCK**: 3 critical, 14 major, 9 minor, 4 observation. Rev 3 resolves every CRITICAL and MAJOR finding and every mechanical MINOR/OBSERVATION finding; deferrals are listed with reasons in *Review Findings Applied (rev 3)*.

---

## Decisions From Discovery (2026-07-25)

| Question | Decision |
|---|---|
| Spec scope | Full Vertex 2 in one spec; P0–P2 priorities encode the migration order |
| Delivery | Evolve in-repo as the next major version of `@elicify-ai/elicify-vertex` |
| Tier-3 LLM verifier | **In scope** as P2 |
| v1 user surface | **Breaking changes allowed** (tool names, slash commands, goals.json schema) |
| Performance | Prefer in-process resolution; bounded subprocess fallback allowed where correctness requires it. "A well-working solution" outranks purity |
| Human evaluation | Scripted live-session review (basis for holdout scenarios) |

---

## Available Reference Patterns

No `docs/reference/` directory exists in this project. The v1 implementation itself is the reference:

| Reference File | Pattern | Relevance to This Feature |
|----------------|---------|---------------------------|
| `src/index.ts` | `parseVerification` positive allowlist + failure patterns + masked-exit rejection | Reused as-is by the verifier-relevance detector (US-3) |
| `src/index.ts` | `isMutatingBashCommand` / `changedPathsFromTool` shell segmentation | Reused as-is by the scope watchdog (US-5) |
| `src/goals.ts` | Atomic write (`wx` temp + rename, mode 0600), lock file, archive-on-replace | Reused by the v2 store (US-5); schema is replaced |
| `src/measurement.ts` | JSONL event sink + holdout arm | Extended, not replaced (US-10) |
| `src/redaction.ts` | `redactSecrets` / `redactForDisk` | Applied to all new artifacts (EXPECT lines, criteria, verifier payloads) |

---

## Existing Codebase Context

> Manual analysis (no code-graph index). Language: TypeScript ESM, Node ≥20.
> Tests: vitest, `tests/*.test.ts`, currently 405 passing. Build: `tsc` → `dist/`.
> Plugin surface: OpenCode hooks via `@opencode-ai/plugin` v1 API.

### Symbols Involved

| Symbol | Role | Context |
|--------|------|---------|
| `ElicifyVertexPlugin` (src/index.ts) | **rewritten** | Hook wiring; becomes thin composition of v2 components |
| `EvidenceLedger` | **extended → renamed `TurnLedger`** | Gains phase, pinned criteria ref, EXPECT artifacts, changed paths (exists), calibration records |
| `DirectiveQueue` | **replaced by `InjectionComposer`** | Budget/priority/cooldown/decay live in the composer |
| `SessionGate` | kept | Activation semantics unchanged |
| `classifyStopMode`, `classifyTask` | **demoted** | Text classification becomes the *prior*; observed evidence dominates |
| `contextForMode`/`contextForStopMode`/`contextForReview` | **replaced** | Content moves into the pattern library rendered by the composer |
| `parseVerification`, `isMutatingBashCommand`, `changedPathsFromTool` | kept (behavior frozen) | Regression surface |
| `MultiStoryGoalEngine`, `VerificationReceiptStore` (src/goals.ts) | **replaced by `StoryEngine` (schemaVersion 2)** | Receipts store kept; plan schema breaks |
| `measurement.ts` log functions | extended | `model` + profile on every event; new event types; size/age rotation (FR-033a) |
| `formatDirectives`, `formatGateContinuationText` | kept | Envelope + redaction unchanged |
| `EvidenceLedger.shouldBlockStop` | **kept as the zero-criteria fallback** | Rev 3: v1's unverified-changes trigger is preserved inside the v2 gate, not replaced (FR-015) |
| `gateContinuationSessions` (src/index.ts) | **generalised → `selfCreatedSessions`** | Rev 3: v1 already excludes its own continuation sessions from `chat.message`; v2 adds two more `session.prompt` call sites, so the exclusion becomes a first-class rule across five hooks (FR-036) |
| `redactSecrets` (src/redaction.ts) | kept + **wrapped** | Allowlist of labelled/vendor patterns with no entropy rule; FR-031's strict scan adds one on top for verifier payloads |

### Impact Assessment

| Symbol Modified | Risk Level | d=1 Dependents | d=2 Dependents |
|----------------|------------|----------------|----------------|
| `ElicifyVertexPlugin` return shape | HIGH | OpenCode host, `scripts/uat-harness.mjs`, all hook tests | live UAT, docs |
| ↳ **mitigation (rev 3)** | — | `VERTEX_V2=0` restores the v1 hook set for the process, read before any state access (FR-037, US-11, SC-014) | — |
| goals.json schema (v1→v2) | MEDIUM | `tests/goals.test.ts`, slash templates, `scripts/register-commands.mjs` | users with active v1 plans (archived **reversibly** on detection, FR-022) |
| Directive ids/texts | MEDIUM | `tests/*` asserting `vertex:*` ids, UAT assertions | none (ids are internal contract) |
| `classify*` demotion | LOW | `tests/stopMode.test.ts`, `tests/gate.test.ts` | measurement dashboards |
| `parseVerification` (frozen) | — | must NOT change: 9 UAT cases + `tests/verification.test.ts` | receipts, gate |

### Relevant Execution Flows

| Flow Name | Relevance |
|-----------|-----------|
| `chat.message` → activation + reset | Gains intake classification subturn (≤1/task), criteria pinning, phase init, turn-index increment; returns early for `selfCreatedSessions` |
| `tool.execute.after` → evidence | Gains scope watch, EXPECT comparison, verifier-relevance; keeps mutation/verification recording |
| `system.transform` → injection | Entire path replaced by the composer (single queue consumer invariant preserved) |
| `session.idle` → gate | Becomes criteria replay → elevate → teachable block (last resort), **with v1's `shouldBlockStop` retained as the zero-criteria fallback** |
| `session.compacted` | Gains re-injection of pinned criteria + active story |
| goal tools | Replaced by story-contract tools |

### Cluster Placement

Single-package plugin. New modules: `src/phase.ts`, `src/composer.ts`, `src/resolve.ts`, `src/pin.ts`, `src/story.ts`, `src/artifacts.ts`, `src/dosing.ts`, `src/verifier.ts`, `src/subturn.ts` (shared session create/prompt/delete + `selfCreatedSessions` + the FR-030b capability probe). `src/index.ts` shrinks to wiring, plus the `VERTEX_V2=0` branch that returns the v1 hook set untouched.

---

## User Stories & Acceptance Criteria

### User Story 1 — Phase engine with pinned session state (Priority: P0)

The harness (actor: plugin runtime) tracks each active unit of work through **four reachable phases — `intake`, `execute`, `elevate`, `close`** — so every other component can serve phase-appropriate guidance instead of turn-blind boilerplate. Today the harness only distinguishes "turn started / turn idle"; the right prompt at the wrong phase is noise.

> **Rev 3 (review MAJ-003)**: rev 2 declared seven phases (`intake, frame, plan, execute, verify, elevate, close`) but defined transitions reaching only four; `frame`, `plan` and `verify` were inhabitable but unreachable, and a BDD precondition depended on one of them. Rev 3 takes the review's preferred option (a): the **phase set is the four reachable states**, and *frame*, *plan* and *verify* survive as **directive families** rendered by the composer (US-2), not as phases. Nothing in the greenfield design is lost — the frame/plan scaffolds still render; they simply no longer name a state the engine cannot enter.

**Why this priority**: Every other story reads the phase. Nothing else can be built correctly without it.

**Independent Test**: Drive a synthetic session through hook calls only (message → mutations → verifier → idle) and assert the phase transitions recorded in the ledger match the expected sequence, and that every arc of the FR-001 transition table is exercised.

**Acceptance Scenarios**:

1. **Given** a newly activated session, **When** the first user message arrives, **Then** the session phase is `intake` and transitions to `execute` after the first mutating tool call.
2. **Given** a session in `execute`, **When** a bound verifier is observed passing, **Then** the phase becomes `elevate`; **When** it is observed failing, **Then** the phase remains `execute`.
3. **Given** a session in `elevate`, **When** `session.idle` fires and all pinned criteria carry evidence, **Then** the phase becomes `close` and no block occurs.
4. **Given** any phase, **When** a new user message arrives, **Then** the phase resets to `intake` while pinned criteria persist.
5. **Given** an active multi-story plan, **When** the phase is read, **Then** it is the **active story's** phase, and completing a non-final story returns the session to `execute` for the next story rather than to `elevate`.

---

### User Story 2 — Injection composer with O→D→P→E grammar (Priority: P0)

The working model receives injections that prescribe instead of complain. Every injection is composed from observed state into four slots — Observation, Diagnosis, Prescription, Example (optional) — with a budget of **2 directives per `experimental.chat.system.transform` invocation**, a **per-family per-turn cap table**, per-family cooldowns counted in turns, and decay to a one-line reminder after observed compliance. Today's directives are static texts that repeat regardless of what the model does.

> **Rev 3 (review MAJ-001)**: rev 2 capped injections at 2 *per turn* while five families each claimed a "once per turn" slot. Because a turn spans many `system.transform` invocations on a deep task, two early corrections permanently silenced the anomaly interrupt and the elevate directive — the two highest-value moments. The budget is now scoped **per `system.transform` invocation**, with an explicit per-family per-turn cap table (FR-004) so no family can be starved by an unrelated family firing first.

**Why this priority**: This is the "guide" layer itself — the core of the redesign; ships value even against v1 detectors.

**Independent Test**: Feed the composer synthetic detector findings and assert the rendered directive contains all grammar slots, respects the budget/priority order, suppresses within cooldown, and decays after a compliance record.

**Acceptance Scenarios**:

1. **Given** a verify-gap finding (changed paths + last verifier class), **When** the composer renders it, **Then** the directive contains `Observed:` with the actual paths, `Diagnosis:` from the failure-mode taxonomy, and `Do now:` with a runnable command.
2. **Given** three findings with priorities correction > phase-guidance > enrichment, **When** the composer renders **one `system.transform` invocation**, **Then** at most 2 directives are injected and the enrichment finding is dropped.
3. **Given** a directive rendered last turn whose prescription was followed, **When** the same finding class recurs, **Then** the rendered form is a one-line reminder (decay).
4. **Given** a directive family rendered at turn T with `cooldownTurns: 2`, **When** the same finding recurs at turn T+1 (a new user message has arrived), **Then** nothing is injected for it; **When** it recurs at turn T+2, **Then** it renders again.
5. **Given** a turn in which the first `system.transform` invocation already spent both slots on corrections, **When** an anomaly finding fires at a later `system.transform` invocation of the same turn, **Then** the anomaly interrupt is injected (its per-family per-turn cap of 1 is still unspent).

---

### User Story 3 — Narrowest-verifier resolution (Priority: P0)

When the model changes files, the harness resolves the narrowest verifier covering those paths — story-bound verifiers first, then basename convention matching, then a cached manifest of `package.json` scripts, then (only when still ambiguous) a bounded lookup — so prescriptions name a runnable command instead of a generic category list.

**Why this priority**: Prescriptions without a concrete command are complaints with better formatting. Required by US-2's `Do now:` slot.

**Independent Test**: A fixture repo layout (paths only, no execution) drives a table of `changedPaths → expected command` resolutions.

**Acceptance Scenarios**:

1. **Given** an active story with `verifiers: ["npx vitest run tests/parser"]` and a change in `src/parser/x.ts`, **When** resolution runs, **Then** the story verifier is returned.
2. **Given** no active story and a change to `src/lexer.ts` with `tests/lexer.test.ts` present in the manifest, **When** resolution runs, **Then** `npx vitest run tests/lexer.test.ts` is returned.
3. **Given** no convention match and a `package.json` with a `test` script, **When** resolution runs, **Then** `npm test` is returned with rationale `fallback:package-script`.
4. **Given** resolution is ambiguous (no story, no match, no scripts), **When** the prescription renders, **Then** it degrades to the generic category list and the finding is logged as `resolution:none` for taxonomy growth.

---

### User Story 4 — Intake scaffold, criteria pinning, and teachable idle gate (Priority: P0)

At the start of a non-trivial task the model is scaffolded to restate the real outcome, list 2–3 proceed-forward assumptions, and pin acceptance criteria. The criteria persist across turns and compaction. At `session.idle`, the harness replays criteria against evidence; it blocks only when criteria are unmet AND unexplained, and the block names which criterion lacks evidence. **When no criteria were ever pinned, the gate falls back to v1's unverified-changes trigger** so the harness is never weaker than v1. This is where one-shot competence is born; today the harness is absent at turn start entirely.

> **Rev 3 (review CRIT-003)**: rev 2's gate condition ("block only when ≥1 criterion lacks evidence") is *vacuously false* when the pinned-criteria set is empty — which happens whenever the model ignores the `CRITERIA:` scaffold. v1's `EvidenceLedger.shouldBlockStop` (deep ∧ changed files ∧ no successful verification) would have blocked; v2 rev 2 would not. The plugin's highest-value behaviour must not be opt-in for the model being governed, so FR-015 now carries an explicit zero-criteria fallback to the v1 trigger.

**Why this priority**: Front-loading is the highest-leverage behavior change; the idle gate becomes teachable instead of generic.

**Independent Test**: Synthetic session: intake message → criteria pinned from the model's `CRITERIA:` block → mutations → idle without evidence → block names the unmet criterion id; after a verifier receipt is attached, idle passes.

**Acceptance Scenarios**:

1. **Given** an activated session with a non-trivial task (mode ≥ normal), **When** system.transform runs, **Then** an intake directive requests `OUTCOME:` (one line), `ASSUMPTIONS:` (≤3), and `CRITERIA:` (numbered) blocks, and **the request repeats every turn until a CRITERIA block is captured** (decision 2026-07-25: keep demanding; it occupies a phase-guidance budget slot).
2. **Given** the model's reply contains a `CRITERIA:` block, **When** the text completes, **Then** the criteria are parsed, redacted, persisted, and echoed back in the next turn's ledger line.
3. **Given** pinned criteria and `session.idle` with a criterion lacking evidence, **When** the gate evaluates, **Then** the continuation prompt quotes that criterion verbatim and prescribes the narrowest verifier (US-3) for it.
4. **Given** a compaction completes, **When** the next system.transform runs, **Then** pinned criteria and the active story are re-injected once.
5. **Given** a quick/read-only task (no mutations observed), **When** `session.idle` fires, **Then** no intake demand and no block occur.
6. **Given** a deep session with changed files, **no** pinned criteria (the model never emitted a `CRITERIA:` block) and no successful verification since the latest change, **When** `session.idle` fires, **Then** the v1 evidence gate blocks under the same caps, holdout and docs-only exemption, and the block text additionally states that no acceptance criteria were captured.
7. **Given** more than one session is active (so `file.edited` attribution is unavailable), **When** `session.idle` fires with unmet criteria, **Then** the gate does **not** block: the criteria replay renders as advisory and `gate:multi-session-advisory` is logged.
8. **Given** a pins disk write fails with `EACCES`, **When** the next criteria update occurs, **Then** the retry writes successfully; **Given** three consecutive failures, **Then** `pins:disk-unavailable` is logged once and retries stop for the session.

---

### User Story 5 — Story contracts v2 with receipt-bound checkpoints (Priority: P1)

Multi-story work is planned as contracts: each story carries acceptance criteria, scope globs, bound verifier commands, assumptions, and rejected alternatives. The engine auto-proposes decomposition **during `intake`, from `chat.message`, at most once per task** for multi-story scope. Mutations outside the active story's scope trigger a guiding (not blocking) directive. A story cannot checkpoint complete unless every acceptance item carries an evidence pointer (verification receipt id or explicit user waiver). schemaVersion 2; v1 plans are archived on detection (reversibly — see FR-022/FR-037).

**Why this priority**: The backbone that makes every prescription specific — but useful only after US-1–US-4 exist.

**Independent Test**: Engine unit tests: create contract plan → mutate out of scope (directive queued) → checkpoint with prose only (rejected) → attach receipts per criterion (accepted) → final story requires observed receipt.

**Acceptance Scenarios**:

1. **Given** the first user message of a task that does **not** match `TRIVIAL_ASK_RE`, **When** the multi-story subturn classification (session model, evidence = the user ask only) returns `multiStory: true`, **Then** the harness injects a proposed story plan and asks for confirmation before creating it; **When** the subturn fails or times out, **Then** the heuristic fallback (`SEQUENCING_WORDS` match or ≥2 `IMPERATIVE_VERBS`-led top-level clauses, both enumerated in FR-018) decides and `intake:classify-fallback` is logged.
2. **Given** an active story with `scope: ["src/parser/**"]`, **When** a mutation lands in `src/cli.ts`, **Then** a scope directive is queued offering: fold into a proposal, amend the story (logged reason), or revert — and no block occurs.
3. **Given** a checkpoint request with `status=complete` and a criterion without an evidence pointer, **When** the tool executes, **Then** it throws naming the criterion id.
4. **Given** a v1 `goals.json` (schemaVersion 1), **When** any story tool runs, **Then** the file is archived to `archive/<name>.<timestamp>.json` (never deleted) and the tool reports that a new plan is required.
5. **Given** all stories complete and the final verification story holds an observed receipt for the integrated verifier, **When** checkpointed, **Then** the plan status becomes `complete`.
6. **Given** a user ask matching `TRIVIAL_ASK_RE` (e.g. "fix typo in readme"), **When** intake completes, **Then** no classification subturn is issued, no plan is proposed, and `intake:classify-skipped` is logged (avoids a paid model call and ~1–2 s of latency on trivial asks).
7. **Given** a task for which a classification subturn was already issued, **When** further user messages arrive in the same task, **Then** no further subturn is issued until an explicit new-task signal; and no session may exceed `VERTEX_INTAKE_SUBTURN_MAX` (default 3) subturns regardless of task boundaries.

---

### User Story 6 — Pre-commitment capture and anomaly interrupt (Priority: P1)

Before running a verifier, the model states one line: `EXPECT [confidence]: <one line>` — confidence (`low|med|high`) is optional inline metadata, not a separate directive line (review F-09: one parser, one artifact). The harness captures it deterministically from the assistant text stream, compares the expectation against the observed outcome (pass/fail + failure-pattern class), and on mismatch fires an anomaly interrupt that quotes the model's own expectation back and demands a model revision before another fix. Declared confidence is logged for calibration.

**Why this priority**: Converts semantic judgment into temporal comparison — the tier-2 mechanism the whole guide layer leans on.

**Independent Test**: Text-complete with `EXPECT: all 18 pass` → failing verifier observed → next system.transform contains the interrupt quoting "all 18 pass"; matching outcome → no interrupt.

**Acceptance Scenarios**:

1. **Given** a session that has entered `execute` with changed files and no EXPECT artifact for the turn, **When** the **first `experimental.chat.system.transform` after that phase entry** runs, **Then** a one-line pre-commitment prompt is rendered (`phase-guidance` priority, at most once per turn) — i.e. before the model issues its next tool call, not after a verifier has already returned.
2. **Given** a captured `EXPECT:` predicting pass, **When** the verifier fails, **Then** the anomaly interrupt is injected containing the quoted expectation, the observed summary line, and the question "what belief is now false?".
3. **Given** a captured `EXPECT [high]:` predicting pass, **When** the verifier passes, **Then** no interrupt fires and a `calibration` event is logged with `{declared: high, observed: pass}`; **Given** an `EXPECT:` with no inline confidence, **Then** `declared` is `null` and the event is still logged.
4. **Given** malformed or absent EXPECT text, **When** the verifier completes, **Then** no comparison is attempted and no interrupt fires (fail-open, logged `expect:absent`).

---

### User Story 7 — Elevate phase (Priority: P1)

When the bound verifier goes green on a deep task, the harness injects the elevate directive once: replay each pinned criterion with its evidence status, sweep adjacent findings under the graduated protocol (surface always; fix now only when small + same root cause + covered by the verifier just run; otherwise propose), and run a taste pass over the diff from a reviewer's stance. This converts "you may stop" into "here is what finishing well looks like."

**Why this priority**: The moment weak models stop and strong ones keep going; requires criteria (US-4) and composer (US-2).

**Independent Test**: Deep session → mutation → green bound verifier → next system.transform contains exactly one elevate directive with the three parts; second green run does not re-inject.

**Acceptance Scenarios**:

1. **Given** a deep-mode session with pinned criteria and changed files, and either no active plan or an active plan whose **final** story the verifier covers, **When** the bound verifier is observed passing, **Then** the elevate directive is injected once containing criteria replay, the sweep protocol, and the taste-pass instruction.
2. **Given** the elevate directive was already injected this turn, **When** another verifier passes, **Then** it is not injected again (once per turn).
3. **Given** a quick/docs-only session, **When** a verifier passes, **Then** no elevate directive is injected.
4. **Given** an active three-story plan whose story 1 verifier goes green while stories 2–3 are not started, **When** the pass is observed, **Then** no elevate directive is injected (the passing verifier does not cover the plan's **final** story); the story-1 completion directive renders instead.

---

### User Story 8 — Model-conditioned dosing (Priority: P2)

Directive families are dosed per model class. The plugin reads the model id from `experimental.chat.system.transform` (where `model: Model` is **required**), falling back to `chat.message` (where it is optional), maps it through a config-supplied profile table, and the composer consults the dose before rendering. **Two profiles only** (review F-08: `small` and `mid` had identical doses — three classes were speculative): `standard` (full scaffolds + prescriptions; the default) and `frontier` (one-line phase nudges, but anomaly interrupts and falsification demands stay on). The two profiles differ across **five directive families** (FR-029 dose matrix, restored from `docs/vertex2-greenfield.html` §05), not one. Every event logs the model id so doses can be tuned from outcomes, and unmapped models are logged with their raw id so the table can be populated from telemetry.

**Why this priority**: Multiplies the value of all prior stories but is safe to ship after them; wrong dosing degrades gracefully to the default profile.

**Independent Test**: Same synthetic finding stream rendered under `profile:standard` vs `profile:frontier` produces the documented different directive sets.

**Acceptance Scenarios**:

1. **Given** a model id is available (from `system.transform`, else `chat.message`), **When** the session initializes, **Then** the resolved profile is recorded on the session **and stamped on every subsequent event emitted for that session** — asserted over the whole event stream, not just the init event.
2. **Given** profile `frontier`, **When** an intake finding renders after one observed compliance, **Then** the scaffold is suppressed to a one-line nudge; **Given** profile `standard`, **Then** the full scaffold renders every task. The same profile pair produces the documented different form for each of the five families in the FR-029 dose matrix.
3. **Given** no model id or an unknown model, **When** the session initializes, **Then** the default profile (`standard`) applies and a `dosing:unknown-model` event is logged **including the raw `providerID/modelID` string** so unmapped models are discoverable from telemetry.

---

### User Story 9 — Tier-3 verifier as an in-loop subturn (Priority: P2)

At the final checkpoint of a deep story plan, the harness runs a verifier **subturn inside the same agent loop**: it creates a child session (`session.create({parentID})` — the same mechanism OpenCode uses for subagents), prompts it via `session.prompt` **as the plugin-registered zero-tool `vertex-verifier` agent** with a verifier system prompt and an evidence-only payload. **By default the subturn runs on the session's own model** — the one already serving the agent, guaranteed configured — so the verifier always works with zero extra setup. An optional plugin option `verifierModel: "providerID/modelID"` selects a different host-configured model; any failure of the override falls back to the session model, and any failure of the subturn fails open. The verdict `{fit: pass|concern, notes}` is appended to the close-out report and never gates the checkpoint. The child session is **inert to the harness's own hooks** (FR-036) and is **deleted on every exit path** (FR-038).

> **Rev 3 (review CRIT-001, CRIT-002)**: rev 2 said "tool-calling disabled" and cited `SessionPromptData.body.tools` as verification. That field is a per-tool-**name** boolean map (`{[key: string]: boolean}`) — it expresses a deny *list*, not a deny-*all*, so the claimed capability was not established by the cited type. Rev 3 replaces the prose with a constructed mechanism (FR-030b: a registered zero-tool agent + a deny map enumerated from `client.tool.ids()` + `"*": false`) behind a **capability probe** that refuses to send the subturn at all when zero-tool execution cannot be confirmed. Separately, rev 2 never excluded the plugin's own child sessions from its own hooks — v1's `gateContinuationSessions` set in `src/index.ts` exists precisely because `session.prompt` re-enters `chat.message` — so the verifier would have received the harness's activation cue and directive block on top of its "evidence-only" payload. FR-036 closes that.

**Why this priority**: Escalation tier for the one judgment that cannot be pinned (intent); explicitly non-blocking and degradable.

**Independent Test**: Stub client: `session.create` + `session.prompt` + `session.delete` recorded → close-out contains verdict notes; payload schema-checked (no chat narrative); prompt body asserts `model` = session model by default (override when configured), `agent: "vertex-verifier"`, and the exact `tools` deny map; stub throwing/hanging → checkpoint completes, `verifier:unavailable` logged, child session still deleted. **Plus an integration test (not stub-only)** that drives the real hook set over a simulated harness-created child session and asserts `output.system` and `output.parts` are untouched.

**Acceptance Scenarios**:

1. **Given** a final verification story checkpointing complete, **When** the verifier subturn succeeds, **Then** the close-out report appends the verdict, and the checkpoint result does not depend on it.
2. **Given** no `verifierModel` configured, **When** the subturn is built, **Then** its prompt uses the current session's `{providerID, modelID}` (read from `experimental.chat.system.transform`, falling back to `chat.message`).
3. **Given** `verifierModel` is configured but its prompt fails, **When** the subturn retries, **Then** it falls back to the session model before failing open.
4. **Given** the subturn fails or exceeds the 5 s cap, **When** checkpointing, **Then** the checkpoint completes normally and `verifier:unavailable` is logged.
5. **Given** a verifier request is built, **Then** its payload contains criteria, diff summary, and verifier output summaries only — asserted by schema — and **every one of the three fields** is passed through `redactSecrets` and then the strict scan (FR-031).
6. **Given** the harness has created a child session for a subturn, **When** any harness hook (`chat.message`, `experimental.chat.system.transform`, `experimental.text.complete`, `tool.execute.after`, `event(session.idle)`) fires for that session id, **Then** the harness returns early: no activation cue is pushed into `output.parts`, no directive block is appended to `output.system`, no ledger entry is allocated, and no gate runs — asserted over the **delivered** payload, not the built payload.
7. **Given** the deny-all capability probe cannot confirm that the `vertex-verifier` agent resolves to zero enabled tools, **When** a final checkpoint occurs, **Then** no subturn is issued at all, `verifier:unsupported` is logged once per process with the probe's reason, and the close-out proceeds deterministically without a verdict.
8. **Given** any subturn exit path (success, malformed verdict, timeout, retry exhaustion, thrown error), **When** the subturn returns, **Then** `session.delete` is called exactly once for its child session; a deletion failure logs `subturn:cleanup-failed` and does not affect the caller.

---

### User Story 10 — Measurement v2: outcomes, not blocks (Priority: P2)

The events layer records what users feel: `model` on every event; per-directive lifecycle events (`directive_rendered`, `directive_complied`) joining prescriptions to next actions; `calibration` events; and derivable metrics — block conversion (block → relevant green within the turn), one-shot rate (corrective user turns per task), proposal acceptance. Holdout arms extend from the gate to directive families.

**Why this priority**: The tuning loop for everything else; valuable immediately but not blocking any behavior.

**Independent Test**: Synthetic session produces a JSONL stream; a metrics script computes block conversion and compliance rates matching hand-computed values.

**Acceptance Scenarios**:

1. **Given** any event emitted, **Then** it carries `model` (or `"unknown"`) and `session_id`.
2. **Given** a rendered prescription with command X, **When** X (or a command resolving to the same verifier) is observed within the same turn, **Then** a `directive_complied` event joins it by directive instance id.
3. **Given** `VERTEX_HOLDOUT=1` and a directive family in the `off` arm for a session, **When** its finding fires, **Then** rendering is suppressed and `holdout_suppress` is logged with the family name.

---

### User Story 11 — Rollout safety and rollback (Priority: P0)

v2 rewrites the hook wiring, replaces the directive layer, changes the idle gate's trigger, breaks the plan schema, and renames every tool and slash command. The maintainer (actor: operator shipping the release) needs a single switch that returns any user to v1 behaviour without a downgrade, and an archival step that is reversible by hand. Today the only runtime switches are feature-local (`VERTEX_VERIFIER`, `VERTEX_HOLDOUT`, `VERTEX_DATA`, `VERTEX_DEBUG`) — none of them restores v1.

**Why this priority**: This plugin mediates *every* LLM turn. A defect that reaches users degrades every session of every user; without a kill switch the only remedy is pinning the previous major version, and FR-022's archival makes even that lossy. Rollback is a P0 property of the release, not a P3 nicety (review MAJ-012, OPS-03 against the spec's own HIGH-risk `ElicifyVertexPlugin` row).

**Independent Test**: Run the full v1 regression suite with `VERTEX_V2=0` set and assert it passes unchanged and that no file under `.elicify-vertex/` is created, modified or renamed.

**Acceptance Scenarios**:

1. **Given** `VERTEX_V2=0` (or plugin option `engine: "v1"`), **When** the plugin loads, **Then** all v2 components are disabled and the v1 composer and gate paths serve the process; the flag is honoured **before any state file is read, written or archived**.
2. **Given** a v1 `goals.json` and the default (v2) engine, **When** archival runs, **Then** the file is renamed to `archive/goals.<ISO-8601-timestamp>.json` with its contents intact and the plugin never deletes an archived file — so a manual restore is always possible.
3. **Given** `VERTEX_V2=0`, **When** a session runs to idle with unverified changes, **Then** the v1 stop-block behaves exactly as it does today (no criteria gate, no composer, no subturns, no new event types).

---

## Behavioral Contract

Primary flows:
- When a non-trivial task starts, the system requests OUTCOME/ASSUMPTIONS/CRITERIA once and pins parsed criteria across turns and compaction.
- When files change, the system resolves and prescribes the narrowest covering verifier, naming the changed paths.
- When a bound verifier passes on a deep task, the system injects the elevate directive exactly once.
- When all pinned criteria carry evidence at idle, the system closes without blocking.
- When multi-story scope is detected (at most one classification subturn per task), the system proposes a story-contract plan and waits for confirmation.
- When the session enters `execute` with changed files and no expectation on record, the system renders a one-line pre-commitment prompt before the next tool call.

Error flows:
- When a verifier outcome contradicts a captured EXPECT, the system interrupts with the quoted expectation and demands model revision before further fixes.
- When the same failure signature repeats, the system fires re-model guidance once per signature per turn.
- When criteria are unmet and unexplained at idle on a deep task, the system blocks with the specific criterion and a runnable prescription (max 3 blocks, then warn).
- When **no** criteria were ever pinned and a deep session idles with changed files and no successful verification, the system blocks on the v1 unverified-changes trigger and says so.
- When more than one session is active, the criteria replay renders as advisory and the gate does not block.
- When a checkpoint lacks evidence pointers, the story engine rejects it naming the criterion.
- When the verifier, session.prompt, or resolution is unavailable, the system fails open, logs the reason, and never fabricates a block or verdict.
- When the verifier's zero-tool capability cannot be confirmed, the system does not send the subturn at all.

Boundary conditions:
- When the per-invocation budget (2 per `system.transform`) is exceeded, lower-priority findings are dropped, never queued across invocations or turns.
- When a family has spent its per-turn cap (FR-004 table), it is not rendered again this turn even if the invocation budget is free.
- When a directive is within `cooldownTurns` or was complied with, it is suppressed or decayed respectively.
- When the task is quick/read-only or docs-only, no intake demand, no elevate, no block.
- When a v1 goals.json is encountered, it is archived reversibly; tools operate only on schemaVersion 2.
- When a session was created by the harness itself, the harness is inert for it — no cue, no directives, no gate, no ledger entry.
- When `VERTEX_V2=0`, none of the above applies: the process serves v1 behaviour unchanged.

---

## Edge Cases

- Two sessions active concurrently → all state (phase, criteria, artifacts, doses) is per-session; `file.edited` attribution only when exactly one session is active (v1 rule preserved). **Because attribution is suppressed, evidence cannot accrue, so the criteria gate MUST NOT block in this state** — it renders the replay as advisory and logs `gate:multi-session-advisory` (review MIN-007).
- Harness-created child session (verifier or intake subturn) → the harness is inert for that session: no activation cue, no directives, no gate, no ledger/dosing/review map entry, no recursion into `attemptGateContinuation` (FR-036).
- Harness-created child session outlives its subturn → deleted in a `finally` block on every path; failure logs `subturn:cleanup-failed` (FR-038).
- Deep session idles with changed files and **zero** pinned criteria → v1 unverified-changes gate applies (FR-015 fallback); block text states no criteria were captured.
- Model writes multiple `CRITERIA:` blocks in one reply → last block wins; earlier ones ignored; event `criteria:re-pinned`.
- Criteria block with >10 items → first 10 pinned, `criteria:truncated` logged.
- EXPECT present but verifier never runs this turn → artifact expires at turn end; no comparison.
- Verifier passes but is unrelated to changed paths (relevance gap) → evidence recorded as partial; verify-gap prescription names the missing suite; elevate does not fire.
- Story scope globs match nothing (typo) → every mutation is "out of scope"; watchdog fires once per turn max with a hint to amend the scope.
- Compaction mid-turn → pinned criteria survive (**always disk-backed** in `pins.json`, memory only as a write-failure fallback — review MIN-009), re-injection occurs once on the next transform.
- Story scope globs stop matching after a branch switch → the scope watchdog's per-turn cap (FR-004 table, 1/turn) bounds the noise; the directive text offers `amend` first when the plan's globs match **zero** files in the worktree (review: unasked question 7).
- Verifier returns malformed JSON → treated as unavailable; logged `verifier:malformed`.
- Unknown model string variants (e.g., provider prefixes) → normalized by suffix match before profile lookup; unmatched → default profile.
- Prescription command contains user path with secrets → passed through `redactSecrets` before injection (as all directive text already is).

---

## Explicit Non-Behaviors

- The system must not block quick- or normal-mode sessions at idle, because advisory-only modes are a v1 contract that prevents harness-paradox friction.
- The system must not auto-create a story plan without user confirmation, because plans redirect the whole session and a wrong plan is worse than none.
- The system must not instruct silent fixing of out-of-scope findings **under any model profile** (propose only), because ungoverned proactivity is the v1 sprawl failure inverted. A `frontier` proactive-fix license is **out of scope for v2.0** — see Assumptions (review MAJ-013: rev 2's `standard`-only qualifier implied an unbounded fix license for `frontier` that no requirement granted and that contradicted FR-021).
- The system must not send chat narrative, file contents beyond diff summaries, or unredacted text to the verifier, because the verifier must not inherit coherence bias and must not leak secrets.
- The system must not let the verifier verdict gate or block a checkpoint, because tier 3 is advisory by design.
- The system must not inject more than 2 directives per `system.transform` invocation, exceed any family's per-turn cap, or re-inject a family within `cooldownTurns`, because attention is the scarce resource being managed.
- The system must not make network calls or spawn subprocesses inside `tool.execute.after`/`system.transform` hot paths except the bounded resolution fallback (≤250 ms, cached, async where the host allows), because hook latency is user-visible.
- The system must not issue more than one classification subturn per task, because each one is a paid model call on the user's critical path (`chat.message`), and must not issue any model call from `tool.execute.after` or `system.transform` at all.
- The system must not act on any session it created itself, because the harness governing its own verifier would feed the verifier the harness's directives and risk unbounded recursion.
- The system must not send a verifier subturn when zero-tool execution is unconfirmed, because a partial deny list is an authorization control that does not hold.
- The system must not persist raw user prompt text in events or plan files (enum flags + redacted summaries only), preserving the v1 privacy posture.

---

## Integration Boundaries

### OpenCode plugin host (`@opencode-ai/plugin` v1 API)

- **Data in**: hook invocations (`chat.message`, `tool.execute.after`, `experimental.chat.system.transform`, `experimental.text.complete`, `event`, `config`), `PluginInput` (client, directory, worktree), model id — **required** on `experimental.chat.system.transform` (`model: Model`), optional on `chat.message` (`model?: {providerID, modelID}`); the agent name on `chat.message` (`agent?: string`). `tool.execute.before` is **not** used.
- **Data out**: mutated `output.system` arrays, tool results, `session.prompt` continuations, config command registrations, **one agent registration** (`config.agent["vertex-verifier"]`, and `config.agent["vertex-intake"]` when the intake subturn is enabled).
- **Contract**: v1 `Hooks` interface; single queue consumer = `system.transform` (v1 invariant preserved). **Every hook returns early for a session id in `selfCreatedSessions`** (FR-036).
- **On failure**: missing `session.prompt` → allow + `would_block` logging (v1 behavior preserved); hook exceptions caught per-hook, never thrown into the host.
- **Kill switch**: with `VERTEX_V2=0` the plugin registers the v1 hook set only; no v2 module is constructed and no state file is opened (FR-037).
- **Development**: simulated host via the existing UAT harness pattern; live via `opencode run`.

### OpenCode SDK client (subturns: verifier US-9, intake classification US-5)

- **Data in**: `session.create({ body: { parentID: <current session>, title } })` → child session (the same mechanism OpenCode uses for subagent subturns); `session.prompt({ path: { id: childID }, body: { model?: {providerID, modelID}, agent: "vertex-verifier" | "vertex-intake", system: <rubric>, tools: <deny map>, parts: [evidence] } })`. Grounded in SDK 1.18.4 (`@opencode-ai/sdk/dist/gen/types.gen.d.ts`): `SessionCreateData.body.parentID` (:1811), `SessionPromptData.body.{model, agent, system, tools, parts}` (:2244–2258), `SessionDeleteData` (:1860), `Config.agent[name]: AgentConfig` (:1112, :835), `client.tool.ids()` → `GET /experimental/tool/ids` returning `Array<string>` (:1705, `ToolIds` :1215), `client.app.agents()` → `Agent[]` each carrying a resolved `tools: {[id]: boolean}` map (:1399–1428).
- **Tool disabling is constructed, not asserted** (review CRIT-002): `SessionPromptData.body.tools` is a per-tool-**name** map, so "disable tools" is expressed as (a) the plugin-registered zero-tool agent, (b) a deny map enumerated from `client.tool.ids()` with `"*": false` added, and (c) a one-time **capability probe** over `client.app.agents()`. Probe failure ⇒ **no subturn is issued** and `verifier:unsupported` / `intake:unsupported` is logged. See FR-030b.
- **Self-created sessions**: every id returned by `session.create` is recorded in `selfCreatedSessions`; all harness hooks return early for those ids (FR-036). Each subturn passes an explicit `agent` that is never `opts.activeAgent`.
- **Cleanup**: `session.delete` in a `finally` block on every path (FR-038).
- **Pre-filter (intake classification only)**: a **cost** gate, not a scope gate — the subturn is issued at most once per task and never for asks matching `TRIVIAL_ASK_RE`; skipped asks log `intake:classify-skipped` (review MAJ-006 replaced rev 2's character-length gate, which provably missed short multi-story asks such as "refactor auth end-to-end").
- **Payload hygiene**: **all three** payload fields — pinned criteria, diff summary, verifier output summaries — pass `redactSecrets` and then the strict scan (FR-031), applied to the reassembled field rather than per chunk; a field that trips the scan has the offending hunk/line removed, and an emptied field is omitted with `verifier:field-dropped` logged (review MAJ-009).
- **Model selection**: default = the current session's `{providerID, modelID}` (from `system.transform`, else `chat.message`) — always configured because it is already serving the agent. Optional plugin option `verifierModel: "providerID/modelID"`; on override failure, fall back to session model, then fail open.
- **Data out**: JSON verdict `{fit, notes}` (verifier) / `{multiStory: boolean, outcomes: string[]}` (intake classification).
- **Contract**: one prompt per subturn, `Promise.race` **5 s total including the retry** (v1 gate-continuation pattern reused), JSON-parse with schema check. Verifier fires only at final-story checkpoint of a deep plan; intake classification fires only from `chat.message`, ≤1 per task and ≤ `VERTEX_INTAKE_SUBTURN_MAX` (3) per session.
- **On failure**: verifier → `verifier:unavailable`, close-out proceeds deterministically; intake classification → heuristic fallback (`SEQUENCING_WORDS` / `IMPERATIVE_VERBS`, FR-018), logged `intake:classify-fallback`, no second attempt after the 5 s budget expires.
- **Development**: stubbed client in unit tests **plus one integration test that exercises the real hook set over a simulated child session** (stub-only tests cannot detect host-side injection); live behind `VERTEX_VERIFIER=1`.

### Filesystem state (`<project>/.elicify-vertex/`)

- **Data in/out**: `plan.json` (schemaVersion 2), `pins.json` (**all** pinned criteria, keyed by session id — review MIN-009 removed rev 2's plan-conditional dual-mode), `events.jsonl` sink dir via `VERTEX_DATA`, `archive/` (never pruned by the plugin).
- **Contract**: atomic writes (`wx` temp + rename), mode 0600, `redactForDisk` on all payloads (v1 mechanisms reused). **`pins.json` is written under the same lock as `plan.json`** — one directory lock, `lockPath` derived from the state directory rather than the plan file, 30 s staleness (review MAJ-008 — rev 2 asserted lock coverage for a file that had none). Writers are last-write-wins per session key; a write never merges another session's key from a stale in-memory copy (read-modify-write happens inside the lock).
- **Lifecycle**: entries older than 7 days, or belonging to a session not seen in this process and whose plan is absent, are dropped on the next write; when the last entry is dropped the file is deleted (FR-013a).
- **On failure**: unwritable root → tools throw the v1 guidance error; pins fall back to memory-only for the session, `pins:disk-fallback-memory` on the first failure, `pins:disk-recovered` on the first subsequent success, `pins:disk-unavailable` once after three consecutive failures (then retries stop — review MIN-006).

### Subprocess fallback (resolution, US-3)

- **Data in**: candidate test globs / filename queries.
- **Data out**: matching paths.
- **Contract**: only outside hot paths or under a 250 ms cap with result caching per turn; binary discovery guarded; never required for correctness of the degraded path. **Arguments are passed via an argv array and never string-interpolated into a shell**, and changed paths are passed as data, never as a command fragment (review STRIDE: resolution subprocess, Elevation of Privilege).
- **On failure**: resolution degrades to manifest/generic tiers; `resolution:none` logged.
- **Development**: fixture-driven, no real subprocess in unit tests.

---

## Security Posture (STRIDE summary)

Rev 3 records the spec's own threat posture so the claims are auditable. `risk` = a threat the spec does not fully mitigate and knowingly accepts or defers; `ok` = addressed by a stated requirement.

| Component | S | T | R | I | D | E | Notes |
|---|---|---|---|---|---|---|---|
| Verifier subturn (child session) | ok | ok | ok | ok | ok | **risk** | I/S/D addressed by FR-036 (no harness injection), FR-031 (three-field strict scan), FR-038 (cleanup), FR-030/FR-030b (5 s cap, one subturn per checkpoint). **E remains `risk` until the FR-030b capability probe is verified against a running OpenCode host** — the deny-all semantics of `tools` are not established by the type surface (CRIT-002); until then the probe's refusal path is the control, not the deny map |
| Intake classification subturn | ok | ok | ok | ok | ok | **risk** | Same probe dependency as the verifier (`vertex-intake` agent). Frequency and cost bounded by FR-018b (≤1/task, ≤3/session, 5 s total); user-ask payload passes `redactSecrets` (FR-031's rule extended to the intake payload) |
| Injection composer / `system.transform` | ok | ok | ok | ok | ok | ok | Budget starvation resolved by FR-004's per-invocation budget + per-family caps; `redactSecrets` per FR-007 |
| Idle gate + `session.prompt` continuation | ok | ok | ok | ok | ok | ok | Recursion closed by FR-036 (self-created sessions never reach the gate); caps preserved from v1; zero-criteria fallback (FR-015) restores v1's protection |
| Filesystem state (`plan.json`) | ok | ok | ok | ok | ok | ok | v1 mechanisms (0600, `wx`+rename, 30 s stale lock) verified in `src/goals.ts` |
| Filesystem state (`pins.json`) | ok | ok | ok | ok | ok | ok | FR-013a: session-keyed, same directory lock as `plan.json`, 7-day expiry, deleted when empty |
| Resolution subprocess fallback | ok | ok | ok | ok | ok | ok | argv array only, never shell-interpolated; 250 ms cap; guarded binary discovery |
| Measurement sink (`events.jsonl`) | ok | ok | ok | **risk** | ok | ok | `redactForDisk` applies, but v2 widens what lands on disk (directive text, changed-path sets, raw model ids). **Accepted risk for v2.0**: FR-033a caps the sink at 32 MB with rotation and 30-day retention; no per-field classification scheme is specified — deferred to v2.1 |

---

## BDD Scenarios

### Feature: Phase engine (US-1)

#### Scenario: Session advances intake → execute on first mutation
**Traces to**: User Story 1, Acceptance Scenario 1
**Category**: Happy Path
- **Given** an activated session with a build-intent message
- **When** an `edit` tool call on `src/a.ts` completes
- **Then** the ledger phase is `execute`
- **And** the transition is recorded with a timestamp

#### Scenario: Passing bound verifier advances execute → elevate; failing does not
**Traces to**: User Story 1, Acceptance Scenario 2
**Category**: Alternate Path
- **Given** a session in `execute` with changed files
- **When** `npm test` is observed with exit 0 and no failure patterns
- **Then** the phase is `elevate`
- **But** a subsequent mutation returns the phase to `execute`

#### Scenario: New user message resets phase but keeps pinned criteria
**Traces to**: User Story 1, Acceptance Scenario 4
**Category**: Edge Case
- **Given** a session in `elevate` with pinned criteria C1–C2
- **When** a new user message arrives
- **Then** the phase is `intake`
- **And** criteria C1–C2 remain pinned

#### Scenario: Idle with all criteria evidenced closes without blocking
**Traces to**: User Story 1, Acceptance Scenario 3
**Category**: Happy Path
- **Given** a deep session in `elevate` with pinned criteria C1–C2, each carrying an observed receipt id
- **When** `session.idle` fires
- **Then** the phase is `close`
- **And** no continuation prompt is issued and no `would_block` event is logged
- **And** a `phase_transition{from: elevate, to: close}` event is emitted

#### Scenario: Active plan scopes the phase to the active story
**Traces to**: User Story 1, Acceptance Scenario 5
**Category**: Alternate Path
- **Given** a confirmed three-story plan with story 1 active
- **When** story 1 checkpoints complete
- **Then** the session phase is story 2's phase (`execute`), not `elevate`
- **And** the transition table records the arc against story 2

### Feature: Injection composer (US-2)

#### Scenario: Verify-gap renders all grammar slots from observed state
**Traces to**: User Story 2, Acceptance Scenario 1
**Category**: Happy Path
- **Given** changed paths `src/lexer.ts` and a last verifier classified types-only
- **When** the composer renders the verify-gap finding
- **Then** the directive contains `Observed:` with `src/lexer.ts`, a `Diagnosis:` line, and `Do now:` with a runnable command

#### Scenario: Budget drops lowest-priority finding
**Traces to**: User Story 2, Acceptance Scenario 2
**Category**: Happy Path
- **Given** pending findings: one correction, one phase-guidance, one enrichment
- **When** a single `system.transform` invocation renders
- **Then** exactly 2 directives are injected
- **And** the enrichment finding is absent and logged `budget:dropped`
- **And** the dropped finding is not re-queued for the next invocation

#### Scenario: Compliance decays the next occurrence to one line
**Traces to**: User Story 2, Acceptance Scenario 3
**Category**: Alternate Path
- **Given** a verify-gap directive rendered last turn and its prescribed command observed passing
- **When** a new verify-gap finding of the same class fires
- **Then** the rendered directive is a single line containing the command only

#### Scenario: Cooldown suppresses identical finding across turn boundaries
**Traces to**: User Story 2, Acceptance Scenario 4
**Category**: Error Path
- **Given** a scope-drift family with `cooldownTurns: 2` rendered at turn index T
- **When** a second out-of-scope mutation occurs later in turn T
- **Then** no additional scope directive is injected (per-family per-turn cap 1)
- **And** at turn T+1 — after a new user message — the family is still suppressed
- **But** at turn T+2 the family renders again

#### Scenario: Anomaly interrupt survives a turn whose budget went to corrections
**Traces to**: User Story 2, Acceptance Scenario 5
**Category**: Alternate Path
- **Given** a turn in which the first `system.transform` invocation injected two correction directives
- **When** a failing verifier produces an anomaly finding before the second `system.transform` invocation of the same turn
- **Then** the anomaly interrupt is injected in that second invocation
- **And** its per-family per-turn cap (1) is now spent, so a third invocation injects no further anomaly directive

### Feature: Narrowest-verifier resolution (US-3)

#### Scenario Outline: Resolution tiers return the narrowest command
**Traces to**: User Story 3, Acceptance Scenarios 1–3
**Category**: Happy Path
- **Given** an active story verifier `<story_verifier>`, a changed path `<changed>`, and manifest test file `<test_file>`
- **When** resolution runs
- **Then** the command is `<expected>` with rationale `<rationale>`

**Examples**:

| story_verifier | changed | test_file | expected | rationale |
|---|---|---|---|---|
| `npx vitest run tests/parser` | `src/parser/x.ts` | — | `npx vitest run tests/parser` | story |
| — | `src/lexer.ts` | `tests/lexer.test.ts` | `npx vitest run tests/lexer.test.ts` | basename |
| — | `src/util/deep/fmt.ts` | `tests/fmt.spec.ts` | `npx vitest run tests/fmt.spec.ts` | basename |
| — | `src/misc.ts` | — | `npm test` | package-script |

#### Scenario: Ambiguous resolution degrades to generic prescription
**Traces to**: User Story 3, Acceptance Scenario 4
**Category**: Error Path
- **Given** no story, no convention match, and no package scripts
- **When** the verify-gap directive renders
- **Then** the `Do now:` slot contains the generic verifier category list
- **And** a `resolution:none` event is logged

### Feature: Intake and criteria pinning (US-4)

#### Scenario: Intake scaffold repeats until criteria are captured
**Traces to**: User Story 4, Acceptance Scenario 1
**Category**: Happy Path
- **Given** an activated session classified normal or deep
- **When** system.transform runs on three consecutive turns where the model produces no `CRITERIA:` block
- **Then** the intake directive is injected on each of those turns
- **But** it is not injected again after a `CRITERIA:` block is captured

#### Scenario: CRITERIA block is parsed, pinned, and persisted
**Traces to**: User Story 4, Acceptance Scenario 2
**Category**: Happy Path
- **Given** an assistant reply containing `CRITERIA:\n1. parser handles nesting\n2. errors point at inner token`
- **When** the text completes
- **Then** two criteria are pinned with ids C1, C2
- **And** they are written to `.elicify-vertex/pins.json` under the session's key and survive a simulated restart, with or without a plan

#### Scenario: Idle block quotes the unmet criterion and prescribes its verifier
**Traces to**: User Story 4, Acceptance Scenario 3
**Category**: Error Path
- **Given** pinned criteria C1 (evidence: receipt) and C2 (no evidence), deep mode, changed files
- **When** `session.idle` fires
- **Then** the continuation prompt quotes C2's text
- **And** contains a runnable command from resolution
- **And** the block counts against the max-3 cap

#### Scenario: Criteria re-injected once after compaction
**Traces to**: User Story 4, Acceptance Scenario 4
**Category**: Edge Case
- **Given** pinned criteria and a `session.compacted` event
- **When** the next system.transform runs
- **Then** a pinned-criteria directive is injected exactly once

#### Scenario: Read-only session sees no intake demand and no gate
**Traces to**: User Story 4, Acceptance Scenario 5
**Category**: Alternate Path
- **Given** a session classified quick with no mutations
- **When** system.transform and later `session.idle` run
- **Then** no intake directive is injected and no block occurs

#### Scenario: Deep session with no pinned criteria still blocks on unverified changes
**Traces to**: User Story 4, Acceptance Scenario 6
**Category**: Error Path
- **Given** a deep session with changed files, no `CRITERIA:` block ever emitted, and no successful verification since the latest change
- **When** `session.idle` fires
- **Then** the v1 evidence gate blocks
- **And** the block text states that no acceptance criteria were captured and prescribes the resolved verifier
- **And** the block counts against the same max-3 cap, honours the docs-only exemption, and is suppressed for the holdout arm

#### Scenario: Multi-session activity renders the criteria replay as advisory
**Traces to**: User Story 4, Acceptance Scenario 7
**Category**: Edge Case
- **Given** two sessions active concurrently and pinned criteria with no evidence (attribution suppressed)
- **When** `session.idle` fires on either session
- **Then** no block occurs
- **And** the criteria replay is rendered as advisory text
- **And** `gate:multi-session-advisory` is logged

#### Scenario: Pins write fault falls back to memory and recovers
**Traces to**: User Story 4, Acceptance Scenario 8
**Category**: Error Path
- **Given** a pins write that fails with `EACCES`
- **When** the criteria are updated again
- **Then** the first failure logged `pins:disk-fallback-memory` and criteria stayed available in memory
- **And** the retry writes to disk successfully and logs `pins:disk-recovered`
- **But** after three consecutive failures `pins:disk-unavailable` is logged once and no further retries occur this session

### Feature: Story contracts (US-5)

#### Scenario: Multi-story scope triggers a proposed plan awaiting confirmation
**Traces to**: User Story 5, Acceptance Scenario 1
**Category**: Happy Path
- **Given** an intake capturing three distinct outcomes
- **When** the plan-proposal directive renders
- **Then** it contains a proposed story list and an explicit confirmation request
- **But** no plan file is written before the create tool is invoked

#### Scenario: Trivial ask skips the classification subturn
**Traces to**: User Story 5, Acceptance Scenario 6
**Category**: Alternate Path
- **Given** a user ask matching `TRIVIAL_ASK_RE` ("fix typo in readme")
- **When** intake completes
- **Then** no `session.create`/`session.prompt` subturn is issued
- **And** `intake:classify-skipped` is logged
- **But** no plan proposal is injected

#### Scenario: Short multi-story ask still reaches the classifier
**Traces to**: User Story 5, Acceptance Scenario 1
**Category**: Edge Case
- **Given** a 24-character ask "refactor auth end-to-end" that matches no `TRIVIAL_ASK_RE` pattern and contains no sequencing word
- **When** intake completes
- **Then** the classification subturn **is** issued
- **And** a `multiStory: true` verdict produces a plan proposal

#### Scenario: Classification subturn is issued at most once per task
**Traces to**: User Story 5, Acceptance Scenario 7
**Category**: Alternate Path
- **Given** a task whose first user message already triggered a classification subturn
- **When** three further user messages arrive in the same task
- **Then** no further `session.prompt` classification call is made
- **And** after an explicit new-task signal a second subturn is permitted
- **But** the session never exceeds `VERTEX_INTAKE_SUBTURN_MAX` (3) subturns, logging `intake:classify-capped` on the attempt that would exceed it

#### Scenario: Out-of-scope mutation guides without blocking
**Traces to**: User Story 5, Acceptance Scenario 2
**Category**: Alternate Path
- **Given** active story S1 with scope `src/parser/**`
- **When** an edit lands in `src/cli.ts`
- **Then** a scope directive is queued offering fold/amend/revert
- **And** `session.idle` does not block for scope alone

#### Scenario: Checkpoint rejected when a criterion lacks evidence
**Traces to**: User Story 5, Acceptance Scenario 3
**Category**: Error Path
- **Given** story S1 with acceptance items A1 (receipt attached) and A2 (none)
- **When** `checkpoint(status=complete)` executes
- **Then** the tool throws an error naming `A2`
- **And** the plan file is unchanged

#### Scenario: v1 plan archived on first contact
**Traces to**: User Story 5, Acceptance Scenario 4
**Category**: Edge Case
- **Given** `.elicify-vertex/goals.json` with `schemaVersion: 1`
- **When** any story tool runs
- **Then** the file is moved to `archive/goals.<ISO-8601-timestamp>.json` with its contents byte-identical
- **And** the tool response states a new plan is required
- **But** the plugin never deletes a file under `archive/` on any later path

#### Scenario: Final story completion requires an observed integrated receipt
**Traces to**: User Story 5, Acceptance Scenario 5
**Category**: Happy Path
- **Given** all work stories complete and a verification receipt observed in this session for the plan's workspace
- **When** the final story checkpoints complete with that receipt id
- **Then** the plan status is `complete`
- **But** a caller-invented receipt id is rejected

### Feature: Pre-commitment and anomaly interrupt (US-6)

#### Scenario: Pre-commitment prompt renders on execute entry, before the turn's first verifier
**Traces to**: User Story 6, Acceptance Scenario 1
**Category**: Happy Path
- **Given** a session that has just entered `execute` with changed files and no EXPECT artifact for the turn
- **When** the first `experimental.chat.system.transform` after that phase entry runs
- **Then** a one-line pre-commitment prompt is present in `output.system`
- **And** it is rendered at `phase-guidance` priority and not repeated later in the same turn
- **But** it does not fire when an EXPECT artifact for the turn already exists

#### Scenario: EXPECT mismatch fires the interrupt quoting the model
**Traces to**: User Story 6, Acceptance Scenario 2
**Category**: Happy Path
- **Given** captured artifact `EXPECT: all 18 tests pass`
- **When** the verifier is observed failing with 2 failures
- **Then** the next injection contains the quoted expectation and the observed summary
- **And** asks what belief is now false

#### Scenario: Matching expectation logs calibration and stays silent
**Traces to**: User Story 6, Acceptance Scenario 3
**Category**: Alternate Path
- **Given** captured artifact `EXPECT [high]: all tests pass`
- **When** the verifier passes
- **Then** no interrupt is injected
- **And** a `calibration` event records `{declared: high, observed: pass}`
- **And** an `EXPECT:` line without inline confidence records `{declared: null, observed: pass}`

#### Scenario: Absent or malformed EXPECT fails open
**Traces to**: User Story 6, Acceptance Scenario 4
**Category**: Error Path
- **Given** no EXPECT artifact captured this turn
- **When** a verifier completes with any outcome
- **Then** no comparison occurs, no interrupt fires
- **And** `expect:absent` is logged once

### Feature: Elevate phase (US-7)

#### Scenario: Green bound verifier triggers the single elevate directive
**Traces to**: User Story 7, Acceptance Scenarios 1–2
**Category**: Happy Path
- **Given** a deep session with pinned criteria and changed files
- **When** the bound verifier passes
- **Then** exactly one elevate directive is injected containing criteria replay, the sweep protocol, and the taste pass
- **But** a second green run in the same turn injects nothing further

#### Scenario: Docs-only session never elevates
**Traces to**: User Story 7, Acceptance Scenario 3
**Category**: Alternate Path
- **Given** a session whose only changes are `README.md`
- **When** any verifier passes
- **Then** no elevate directive is injected

#### Scenario: Intermediate story green does not elevate a multi-story plan
**Traces to**: User Story 7, Acceptance Scenario 4
**Category**: Alternate Path
- **Given** a confirmed three-story plan with story 1 active and stories 2–3 not started
- **When** story 1's bound verifier is observed passing
- **Then** no elevate directive is injected
- **And** a story-completion directive naming story 2 renders instead
- **But** when the **final** story's verifier passes, the elevate directive is injected exactly once

### Feature: Dosing (US-8)

#### Scenario Outline: Same finding, different profile, different dose
**Traces to**: User Story 8, Acceptance Scenario 2
**Category**: Happy Path
- **Given** profile `<profile>` with one prior compliance for the family
- **When** a `<family>` finding renders
- **Then** the directive form is `<form>`

**Examples**:

| family | profile | form |
|---|---|---|
| phase procedure (intake/plan scaffold) | standard | full scaffold, every task |
| phase procedure (intake/plan scaffold) | frontier | one-line nudge; suppressed after first compliance |
| verification prescription | standard | always, with the exact resolved command |
| verification prescription | frontier | only on a relevance gap |
| falsification / pre-commitment | standard | on new tests |
| falsification / pre-commitment | frontier | every execute-entry turn (primary lever) |
| anomaly interrupt | standard | full |
| anomaly interrupt | frontier | full (FR-029 floor) |
| elevate | standard | full checklist |
| elevate | frontier | rubric + taste pass only |

#### Scenario: Resolved profile is stamped on session init and on every subsequent event
**Traces to**: User Story 8, Acceptance Scenario 1
**Category**: Happy Path
- **Given** a session whose first `system.transform` carries `model: {providerID: "anthropic", modelID: "claude-fable-5"}`
- **When** the session runs a full turn emitting directive, calibration and gate events
- **Then** the resolved profile `frontier` is recorded on the session
- **And** **every** event in the emitted stream carries that profile value — asserted over the stream, not the init event alone

#### Scenario: Unknown model falls back to default profile with raw id logged
**Traces to**: User Story 8, Acceptance Scenario 3
**Category**: Error Path
- **Given** `chat.message` with model id `someprovider/new-model-x`
- **When** the session initializes
- **Then** profile `standard` applies
- **And** `dosing:unknown-model` is logged containing the raw string `someprovider/new-model-x`

### Feature: Verifier (US-9)

#### Scenario: Verifier verdict appended without gating the checkpoint
**Traces to**: User Story 9, Acceptance Scenario 1
**Category**: Happy Path
- **Given** a configured verifier stub returning `{fit: "concern", notes: "criterion 2 evidence is type-only"}`
- **When** the final story checkpoints complete with a valid receipt
- **Then** the checkpoint succeeds
- **And** the close-out report contains the verifier notes

#### Scenario: Verifier subturn uses the session model by default
**Traces to**: User Story 9, Acceptance Scenario 2
**Category**: Happy Path
- **Given** no `verifierModel` option and a session served by `minimax/MiniMax-M3`
- **When** the verifier subturn prompt is built
- **Then** the prompt body's model is `{providerID: "minimax", modelID: "MiniMax-M3"}`
- **And** the prompt targets a child session created with the current session as parent

#### Scenario: Configured verifierModel failure falls back to the session model
**Traces to**: User Story 9, Acceptance Scenario 3
**Category**: Error Path
- **Given** `verifierModel: "provider-x/model-y"` whose prompt rejects
- **When** the subturn retries
- **Then** the retry prompt uses the session model
- **And** on success the verdict is appended to the close-out report

#### Scenario: Verifier timeout fails open
**Traces to**: User Story 9, Acceptance Scenario 4
**Category**: Error Path
- **Given** a verifier stub that never resolves
- **When** the final checkpoint executes
- **Then** it completes within the 5 s cap plus overhead
- **And** `verifier:unavailable` is logged

#### Scenario: Verifier payload carries evidence only
**Traces to**: User Story 9, Acceptance Scenario 5
**Category**: Edge Case
- **Given** a session containing chat text with the marker string `NARRATIVE_CANARY`
- **When** the verifier request is built
- **Then** the payload contains criteria, diff summary, and verifier summaries
- **And** all three fields have passed `redactSecrets` and the strict scan on the reassembled field
- **But** does not contain `NARRATIVE_CANARY`

#### Scenario: Verifier subturn receives no harness injection
**Traces to**: User Story 9, Acceptance Scenario 6
**Category**: Error Path
- **Given** the harness has created a child session `S-child` and recorded it in `selfCreatedSessions`
- **When** the **real hook set** is driven over `S-child` (`chat.message`, `experimental.chat.system.transform`, `experimental.text.complete`, `tool.execute.after`, `event(session.idle)`)
- **Then** `output.parts` is byte-identical to its input (no activation cue)
- **And** `output.system` is byte-identical to its input (no directive block, no ledger narration)
- **And** no entry is allocated in the ledger, task-mode, review, goal-root or cue maps for `S-child`
- **And** no gate evaluation and therefore no `session.prompt` continuation occurs for `S-child`

#### Scenario: Verifier subturn is refused when tools cannot be disabled
**Traces to**: User Story 9, Acceptance Scenario 7
**Category**: Error Path
- **Given** a host where the deny-all capability probe reports at least one enabled tool on the resolved `vertex-verifier` agent (or `client.tool.ids()` is unavailable)
- **When** a final story checkpoints complete with `VERTEX_VERIFIER=1`
- **Then** no `session.create` and no `session.prompt` call is made
- **And** `verifier:unsupported` is logged once per process with the probe reason
- **And** the checkpoint completes and the close-out renders without a verdict

#### Scenario: Subturn child session is deleted on every path
**Traces to**: User Story 9, Acceptance Scenario 8
**Category**: Edge Case
- **Given** subturn stubs that respectively succeed, return malformed JSON, hang past the 5 s cap, and throw
- **When** each subturn completes
- **Then** `session.delete` is called exactly once for that child session in every case
- **And** a rejecting `session.delete` logs `subturn:cleanup-failed` without changing the caller's result

### Feature: Measurement (US-10)

#### Scenario: Every emitted event carries model and session id
**Traces to**: User Story 10, Acceptance Scenario 1
**Category**: Happy Path
- **Given** an arbitrary sequence of harness events generated by a property test over every event type in FR-033
- **When** the sink serializes them
- **Then** every record has a non-empty `session_id`
- **And** every record has a `model` field that is either a `providerID/modelID` string or the literal `"unknown"`
- **And** no record carries raw user prompt text

#### Scenario: Prescription compliance is joined by instance id
**Traces to**: User Story 10, Acceptance Scenario 2
**Category**: Happy Path
- **Given** a rendered verify-gap directive with instance id D-7 prescribing `npx vitest run tests/lexer.test.ts`
- **When** that command is observed passing in the same turn
- **Then** a `directive_complied` event with id D-7 is logged

#### Scenario: Directive-family holdout suppresses rendering
**Traces to**: User Story 10, Acceptance Scenario 3
**Category**: Alternate Path
- **Given** `VERTEX_HOLDOUT=1` and the session hashed into the `off` arm for family `elevate`
- **When** an elevate finding fires
- **Then** nothing is injected
- **And** `holdout_suppress` is logged with `family: elevate`

### Feature: Rollout and rollback (US-11)

#### Scenario: Kill switch restores v1 behaviour for the whole process
**Traces to**: User Story 11, Acceptance Scenarios 1 and 3
**Category**: Happy Path
- **Given** `VERTEX_V2=0` in the environment
- **When** the plugin is loaded and a deep session runs to idle with unverified changes
- **Then** the v1 composer and v1 `shouldBlockStop` gate produce exactly the v1 outputs
- **And** no v2 module is constructed, no subturn is issued, and no v2 event type is emitted
- **And** no file under `.elicify-vertex/` is created, modified or renamed — the flag is read before any state access

#### Scenario: Archival is reversible and never destructive
**Traces to**: User Story 11, Acceptance Scenario 2
**Category**: Edge Case
- **Given** a v1 `goals.json` with known contents
- **When** a story tool triggers archival and the session then runs to completion
- **Then** `archive/goals.<timestamp>.json` holds byte-identical contents
- **And** restoring it by renaming it back yields a file the v1 engine (under `VERTEX_V2=0`) loads successfully
- **But** no plugin code path deletes or truncates a file under `archive/`

---

## Test-Driven Development Plan

### Test Hierarchy

| Level | Scope | Purpose |
|---|---|---|
| Unit | phase machine, composer, resolver, artifact parser, story engine, dosing table, verifier payload builder | Logic in isolation, fixture-driven |
| Integration | plugin hooks wired together (v1 harness pattern: synthetic hook calls) | Components cooperate across a turn lifecycle |
| E2E | UAT harness scenarios + scripted live `opencode run` | Full behavior under the real/simulated host |

### Test Implementation Order

| Order | Test Name | Level | Traces to BDD Scenario | Description |
|---|---|---|---|---|
| 1 | `phase_transitions_on_mutation` | Unit | Session advances intake → execute on first mutation | **every arc of the FR-001 transition table**, incl. timestamps and the `elevate → close` arc |
| 2 | `phase_verify_pass_fail_paths` | Unit | Passing bound verifier advances… | pass→elevate, fail→execute, mutation→execute |
| 3 | `phase_reset_keeps_pins` | Unit | New user message resets phase but keeps pinned criteria | reset semantics |
| 4 | `composer_renders_odpe_slots` | Unit | Verify-gap renders all grammar slots | slot presence + real paths |
| 5 | `composer_budget_priority` | Unit | Budget drops lowest-priority finding | 2-per-invocation cap, priority order, drop log, no re-queue |
| 6 | `composer_decay_on_compliance` | Unit | Compliance decays the next occurrence | decay form |
| 7 | `composer_cooldown` | Unit | Cooldown suppresses identical finding across turn boundaries | `cooldownTurns` = 1 and 2, spanning a `chat.message` boundary |
| 8 | `resolve_tier_table` | Unit | Scenario Outline: Resolution tiers (all rows) | fixture repo table |
| 9 | `resolve_degrades_generic` | Unit | Ambiguous resolution degrades | rationale + event |
| 10 | `artifact_parse_criteria` | Unit | CRITERIA block is parsed, pinned, persisted | parser incl. malformed/dup/truncation |
| 11 | `artifact_parse_expect_confidence` | Unit | EXPECT mismatch / matching / absent | grammar + fail-open |
| 12 | `story_schema_v2_validation` | Unit | Checkpoint rejected when criterion lacks evidence | contract validation |
| 13 | `story_v1_archival` | Unit | v1 plan archived on first contact | archive + message |
| 14 | `story_scope_watchdog_globs` | Unit | Out-of-scope mutation guides | glob match incl. empty-match hint |
| 15 | `story_final_receipt_gate` | Unit | Final story completion requires observed receipt | receipt binding (v1 semantics) |
| 16 | `dosing_profile_resolution` | Unit | Unknown model falls back; **Resolved profile is stamped on session init and on every subsequent event** | suffix normalization + default + event-stream assertion that every emitted event carries the profile |
| 17 | `dosing_render_matrix` | Unit | Scenario Outline: Same finding, different profile | 5-family × 2-profile form matrix (FR-029) |
| 18 | `verifier_payload_evidence_only` | Unit | Verifier payload carries evidence only | schema + canary + redaction across all three fields |
| 19 | `intake_scaffold_repeats_until_captured` | Integration | Intake scaffold repeats until criteria are captured | injects on each of three consecutive turns with no `CRITERIA:` block, then suppresses permanently once one is captured (rev 3: the rev-2 name `intake_scaffold_once` contradicted FR-011's "every turn until captured") |
| 20 | `criteria_idle_block_names_unmet` | Integration | Idle block quotes the unmet criterion; **Multi-session activity renders the criteria replay as advisory** | teachable gate + cap + two-active-session advisory row |
| 21 | `criteria_compaction_reinjection` | Integration | Criteria re-injected once after compaction | compacted event path |
| 22 | `quick_session_untouched` | Integration | Read-only session sees no intake demand | quick/read-only exemption |
| 23 | `verify_gap_end_to_end` | Integration | Verify-gap renders all grammar slots | ledger→resolver→composer chain |
| 24 | `expect_interrupt_lifecycle` | Integration | EXPECT mismatch fires the interrupt | capture→compare→inject |
| 25 | `calibration_event_logged` | Integration | Matching expectation logs calibration | event join |
| 26 | `elevate_once_per_turn` | Integration | Green bound verifier triggers elevate once | dedupe + docs-only negative + **three-story fixture asserting no elevate on an intermediate green** |
| 27 | `plan_propose_confirm_create` | Integration | Multi-story scope triggers proposed plan | no write before tool call |
| 28 | `scope_directive_no_block` | Integration | Out-of-scope mutation guides without blocking | idle stays green |
| 29 | `verifier_async_fail_open` | Integration | Verifier timeout fails open | 5 s cap, checkpoint unaffected, `session.delete` called exactly once on the timeout path |
| 30 | `directive_compliance_join` | Integration | Prescription compliance joined by instance id | rendered→complied join |
| 31 | `family_holdout_suppression` | Integration | Directive-family holdout suppresses | arm hashing + event |
| 32 | `uat_v2_core_loop` | E2E | multiple (US-1..4 happy paths) | UAT harness: scripted turn walk. **Carries SC-004**: a mutated session with an unmet criterion must produce a block quoting the criterion and containing a runnable command, and the following simulated green turn must close the session with no further block |
| 33 | `uat_v2_story_lifecycle` | E2E | plan propose → checkpoints → final gate | UAT harness |
| 34 | `uat_v2_anomaly_and_elevate` | E2E | EXPECT interrupt + elevate | UAT harness |
| 35 | `live_scripted_session` | E2E | Behavioral Contract (all primary flows) | **Maintainer-run locally; skipped in headless CI unless `OPENCODE_LIVE_TEST=1`** (review F-07 — CI lacks provider keys) |
| 36 | `verifier_model_selection_and_fallback` | Integration | Verifier subturn uses the session model by default; Configured verifierModel failure falls back | default model, override, fallback chain, child-session parentID, `session.delete` called exactly once per attempt path |
| 37 | `story_lock_file_stale_recovery` | Unit | (coverage gap — state-directory write concurrency) | concurrent `plan.json`/`pins.json` write under the shared directory lock: second writer sees lock and throws; lock older than 30 s is reclaimed; no partial file left |
| 38 | `intake_prefilter_and_heuristics` | Unit | Trivial ask skips the classification subturn; Short multi-story ask still reaches the classifier | `TRIVIAL_ASK_RE` matrix, `SEQUENCING_WORDS` / `IMPERATIVE_VERBS` matrix (incl. Korean, code-fence, attachment rows); asserts no client call on skip and a call on every non-trivial row |
| 39 | `verifier_payload_secret_scan` | Unit | Verifier payload carries evidence only | strict scan over **all three** fields on the reassembled field; unlabelled 40-hex token, entropy rule, line-wrapped token, base64 in criteria; `verifier:field-dropped` when a field empties |
| 40 | `pins_write_fault_and_retry` | Unit | Pins write fault falls back to memory and recovers | injected `EACCES`/`ENOSPC`: memory fallback + `pins:disk-fallback-memory`; next update writes + `pins:disk-recovered`; 3 consecutive failures ⇒ `pins:disk-unavailable`, retries stop |
| 41 | `criteria_absent_falls_back_to_v1_gate` | Integration | Deep session with no pinned criteria still blocks on unverified changes | zero pins × changed files × deep ⇒ block; caps/holdout/docs-only honoured; block text states no criteria captured |
| 42 | `event_invariants_property` | Unit (property) | Every emitted event carries model and session id | fast-check over every FR-033 event type: `session_id` non-empty, `model` string or `"unknown"`, no raw prompt text |
| 43 | `self_created_session_is_inert` | **Integration** | Verifier subturn receives no harness injection | drives the real hook set over a simulated child session; asserts `output.system` / `output.parts` untouched, no map entries, no gate, no continuation. **Must not use a stub-only client** — a stub asserts what the plugin builds, not what the host delivers |
| 44 | `verifier_tools_denied_or_refused` | Unit | Verifier subturn is refused when tools cannot be disabled | asserts the exact `tools` deny map and `agent: "vertex-verifier"` on the happy path; asserts **zero** `session.create`/`session.prompt` calls and one `verifier:unsupported` when the probe fails |
| 45 | `idle_all_criteria_evidenced_closes` | Integration | Idle with all criteria evidenced closes without blocking | `elevate → close` arc; no continuation, no `would_block` |
| 46 | `precommitment_prompt_on_execute_entry` | Integration | Pre-commitment prompt renders on execute entry | first `system.transform` after entering `execute`; once per turn; suppressed when an EXPECT artifact exists |
| 47 | `subturn_session_cleanup` | Integration | Subturn child session is deleted on every path | success / malformed / timeout / throw ⇒ exactly one `session.delete` each; rejecting delete ⇒ `subturn:cleanup-failed`, caller unaffected |
| 48 | `composer_budget_multi_transform` | Unit | Anomaly interrupt survives a turn whose budget went to corrections | ≥3 `system.transform` invocations in one turn; per-family per-turn cap table enforced |
| 49 | `phase_and_elevate_per_story` | Unit | Active plan scopes the phase to the active story; Intermediate story green does not elevate | three-story fixture: phase follows the active story; elevate only on the final story's verifier |
| 50 | `intake_subturn_frequency_caps` | Integration | Classification subturn is issued at most once per task | 1/task, `VERTEX_INTAKE_SUBTURN_MAX`=3/session, 5 s total budget incl. retry, `intake:classify-capped` |
| 51 | `verifier_verdict_appended_happy_path` | Integration | Verifier verdict appended without gating the checkpoint | stub returns `{fit: concern, notes}`; checkpoint succeeds; close-out contains the notes; result independent of the verdict |
| 52 | `kill_switch_restores_v1` | E2E | Kill switch restores v1 behaviour for the whole process | `VERTEX_V2=0`: full v1 regression suite passes unchanged; no `.elicify-vertex/` file created/modified/renamed |
| 53 | `archival_is_reversible` | Unit | Archival is reversible and never destructive | byte-identical archive copy; restore loads under v1; no code path deletes under `archive/` |

### Test Datasets

#### Dataset: Narrowest-verifier resolution (fixture layout)

| # | Changed path(s) | Story verifier | Manifest contents | Expected command | Traces to | Notes |
|---|---|---|---|---|---|---|
| 1 | `src/parser/x.ts` | `npx vitest run tests/parser` | — | story verifier | Resolution tiers row 1 | story wins |
| 2 | `src/lexer.ts` | — | `tests/lexer.test.ts` | `npx vitest run tests/lexer.test.ts` | row 2 | basename `.test` |
| 3 | `src/util/deep/fmt.ts` | — | `tests/fmt.spec.ts` | `npx vitest run tests/fmt.spec.ts` | row 3 | `.spec` variant |
| 4 | `src/misc.ts` | — | scripts: `test` | `npm test` | row 4 | package fallback |
| 5 | `src/a.ts`,`src/b.ts` | — | tests for both | both files, one command joining them | Verify-gap renders slots | multi-path join |
| 6 | `README.md` | — | any | none (docs-only: no prescription) | Read-only session | docs exemption |
| 7 | `src/x.ts` | — | empty manifest, no scripts | generic category list | Ambiguous resolution degrades | `resolution:none` |
| 8 | 12 changed paths | — | any | command + `(+7 more)` display | Verify-gap renders slots | display cap 5 |
| 9 | `packages/api/src/h.ts` | — | monorepo: root `package.json` + `packages/api/package.json` both with `test` | `npm test -w packages/api` (nearest manifest wins) | row 4 | workspace root disambiguation |
| 10 | `../outside/x.ts` (outside the worktree) | — | any | none; `resolution:none` logged, path excluded from `Observed:` | Ambiguous resolution degrades | never resolve outside the worktree |

#### Dataset: Artifact parsing (EXPECT / CONFIDENCE / CRITERIA)

| # | Input text (tail of reply) | Boundary Type | Expected Output | Traces to | Notes |
|---|---|---|---|---|---|
| 1 | `EXPECT: all 18 pass` | happy | artifact `{kind: expect, text}` | EXPECT mismatch fires | |
| 2 | `expect: pass` (lowercase) | case | captured (case-insensitive key) | EXPECT mismatch fires | |
| 3 | `EXPECT:` (empty) | empty | not captured; `expect:absent` | Absent or malformed EXPECT | |
| 4 | two EXPECT lines | duplicate | last wins | Absent or malformed EXPECT | |
| 5 | `EXPECT [high]: all pass` | happy | artifact `{text, declared: high}` | Matching expectation logs calibration | inline confidence |
| 6 | `EXPECT [90%]: all pass` | invalid enum | artifact captured, `declared: null`, logged | Absent or malformed EXPECT | enum only; text still usable |
| 6b | `CONFIDENCE: high` on its own line | retired grammar | ignored (not an artifact) | Absent or malformed EXPECT | F-09: single-line grammar only |
| 7 | `CRITERIA:\n1. a\n2. b` | happy | 2 pins C1,C2 | CRITERIA block parsed | |
| 8 | criteria with 12 items | max+ | 10 pinned, truncation event | Edge Cases | cap 10 |
| 9 | criteria containing `sk-live-…` token | security | pinned text redacted | CRITERIA block parsed | redaction |
| 10 | unicode/Korean criteria item | unicode | pinned intact | CRITERIA block parsed | |
| 11 | `EXPECT` inside code fence | false positive | not captured | Absent or malformed EXPECT | fence-aware |

#### Dataset: Composer budget / cooldown / decay

| # | Pending findings (priority) | Prior state | Expected injected | Traces to | Notes |
|---|---|---|---|---|---|
| 1 | correction + guidance + enrichment | none | correction, guidance | Budget drops lowest | drop logged |
| 2 | 2 corrections + guidance | none | 2 corrections | Budget drops lowest | priority within cap |
| 3 | scope-drift ×2 same turn | first rendered | 1 total | Cooldown suppresses identical finding across turn boundaries | per-family per-turn cap 1 (FR-004) — the cooldown is what carries suppression **into** later turns (row 8) |
| 4 | verify-gap | complied last turn | one-line decay form | Compliance decays | |
| 5 | verify-gap | non-complied last turn | full O→D→P→E | Compliance decays | no decay |
| 6 | none | any | no envelope injected | Behavioral Contract | empty ⇒ silence |
| 7 | 2 corrections at `system.transform` #1; anomaly at #2; elevate at #3 — all in one turn | none | 2 corrections, then the anomaly, then the elevate | Anomaly interrupt survives a turn whose budget went to corrections | budget is per invocation, not per turn |
| 8 | scope-drift with `cooldownTurns: 2` at turn T; same finding at T+1 and T+2 | rendered at T | rendered at T, suppressed at T+1, rendered at T+2 | Cooldown suppresses identical finding across turn boundaries | window spans a `chat.message` |
| 9 | intake + scope + anomaly + elevate + verify-gap ×4, all pending in one turn | none | intake ≤1, scope ≤1, anomaly ≤1, elevate ≤1, verify-gap ≤3 across the turn | Anomaly interrupt survives a turn whose budget went to corrections | FR-004 per-family cap table |
| 10 | `directive_complied` candidate `npx vitest run tests/lexer.test.ts --reporter=json` against prescription `npx vitest run tests/lexer.test.ts` | rendered D-7 | counted as compliance (reporter flag in `IGNORED_VERIFIER_FLAGS`) | Prescription compliance is joined by instance id | FR-034 equivalence |
| 11 | `directive_complied` candidate `npm test` against prescription `npx vitest run tests/lexer.test.ts` | rendered D-7 | **not** counted (broader tier, different target set) | Prescription compliance is joined by instance id | FR-034 non-equivalence |

#### Dataset: Intake pre-filter and classification heuristics (FR-018 / FR-018a / FR-018b)

| # | User ask | Boundary Type | Expected Output | Traces to | Notes |
|---|---|---|---|---|---|
| 1 | `fix typo in readme` | trivial (matches `TRIVIAL_ASK_RE`) | no subturn; `intake:classify-skipped` | Trivial ask skips the classification subturn | |
| 2 | `rename fooBar to foo_bar` | trivial (rename pattern) | no subturn; skipped | Trivial ask skips the classification subturn | |
| 3 | `where is the lexer defined?` | trivial (read-only pattern) | no subturn; skipped | Trivial ask skips the classification subturn | |
| 4 | `refactor auth end-to-end` (24 chars) | **short but non-trivial** | subturn issued; `multiStory: true` ⇒ plan proposal | Short multi-story ask still reaches the classifier | the rev-2 length gate misclassified this |
| 5 | `add caching and fix the flaky test` (34 chars) | short multi-story | subturn issued; heuristic fallback also returns multi-story (2 imperative verbs) | Short multi-story ask still reaches the classifier | |
| 6 | `migrate the DB and update the client` (36 chars) | short multi-story | subturn issued | Short multi-story ask still reaches the classifier | |
| 7 | `first add the parser, then wire the CLI` | sequencing word (`first`, `then`) | heuristic ⇒ multi-story when the subturn fails | Multi-story scope triggers a proposed plan | `SEQUENCING_WORDS` hit |
| 8 | `먼저 파서를 추가하고 그다음 CLI를 연결해줘` | unicode / Korean sequencing | heuristic ⇒ multi-story on fallback | Multi-story scope triggers a proposed plan | Korean list parity with v1 detectors |
| 9 | ask whose only "then" appears inside a fenced code block | false positive | sequencing word **not** counted; classification driven by the rest of the text | Short multi-story ask still reaches the classifier | fence-aware, matching FR-012 rules |
| 10 | 400-character rambling single question, no imperative verbs | long single-story | subturn issued once; `multiStory: false`; no proposal | Classification subturn is issued at most once per task | length is not a scope signal in either direction |
| 11 | ask + attached file part | attachment | file parts excluded from the ask text; classification uses text parts only | Classification subturn is issued at most once per task | |
| 12 | 4 consecutive user messages in one task | frequency | exactly 1 subturn total | Classification subturn is issued at most once per task | |
| 13 | 5 tasks in one session | session cap | 3 subturns, then `intake:classify-capped` on tasks 4–5 | Classification subturn is issued at most once per task | `VERTEX_INTAKE_SUBTURN_MAX` |
| 14 | subturn that never resolves | timeout | heuristic fallback at 5 s total, no second attempt, `intake:classify-fallback` | Multi-story scope triggers a proposed plan | shared 5 s budget incl. retry |

#### Dataset: Idle gate decision matrix (FR-015)

| # | Pinned criteria | Evidence | Mode | Changed files | Active sessions | Expected | Traces to | Notes |
|---|---|---|---|---|---|---|---|---|
| 1 | C1,C2 | C1 only | deep | yes | 1 | block quoting C2 + prescription | Idle block quotes the unmet criterion | primary path |
| 2 | C1,C2 | both | deep | yes | 1 | close, no block | Idle with all criteria evidenced closes | `elevate → close` |
| 3 | **none** | — | deep | yes, no successful verification | 1 | block on the v1 unverified-changes trigger; text says no criteria captured | Deep session with no pinned criteria still blocks | CRIT-003 fallback |
| 4 | none | — | deep | yes, verification succeeded after the last change | 1 | no block | Deep session with no pinned criteria still blocks | v1 semantics preserved |
| 5 | none | — | normal | yes | 1 | no hard block (advisory only) | Read-only session sees no intake demand | v1 invariant |
| 6 | none | — | deep | docs only | 1 | no block | Deep session with no pinned criteria still blocks | docs-only exemption |
| 7 | C1 | none | deep | yes | 2 | no block; advisory replay + `gate:multi-session-advisory` | Multi-session activity renders the criteria replay as advisory | MIN-007 |
| 8 | C1 | none | deep | yes | 1, holdout `off` arm | no block; `holdout_suppress` | Deep session with no pinned criteria still blocks | holdout parity for the fallback |
| 9 | C1 | none | deep | yes, 4th consecutive idle | 1 | warn, not block (max-3 cap reached) | Idle block quotes the unmet criterion | cap parity for both paths |

#### Dataset: Pins persistence (FR-013 / FR-013a)

| # | Condition | Boundary Type | Expected Output | Traces to | Notes |
|---|---|---|---|---|---|
| 1 | first write succeeds | happy | `pins.json` contains the session key, mode 0600 | CRITERIA block is parsed, pinned, and persisted | |
| 2 | `EACCES` on first write | error | memory fallback + `pins:disk-fallback-memory`; criteria still served | Pins write fault falls back to memory and recovers | |
| 3 | `EACCES` then success | recovery | disk write succeeds + `pins:disk-recovered` | Pins write fault falls back to memory and recovers | SC-013 target |
| 4 | `ENOSPC` ×3 consecutive | permanent fault | `pins:disk-unavailable` once; retries stop for the session | Pins write fault falls back to memory and recovers | MIN-006 |
| 5 | two sessions writing concurrently | concurrency | both keys present; read-modify-write inside the shared directory lock; no lost update | Pins write fault falls back to memory and recovers | MAJ-008 |
| 6 | entry with `updatedAt` 8 days old | expiry | entry dropped on the next write | CRITERIA block is parsed, pinned, and persisted | 7-day TTL |
| 7 | last remaining entry expires | empty | `pins.json` deleted | CRITERIA block is parsed, pinned, and persisted | no orphan file |
| 8 | lock held by a dead process, mtime > 30 s | stale lock | lock reclaimed, write proceeds | Pins write fault falls back to memory and recovers | v1 mechanism reused |

#### Dataset: Checkpoint evidence validation

| # | Acceptance items | Receipts attached | Status requested | Expected | Traces to | Notes |
|---|---|---|---|---|---|---|
| 1 | A1,A2 | A1✓ A2✓ | complete | accepted | Final story completion | |
| 2 | A1,A2 | A1✓ | complete | throw naming A2 | Checkpoint rejected | |
| 3 | A1 | user waiver recorded | complete | accepted, waiver logged | Checkpoint rejected | explicit waiver |
| 4 | A1 | invented receipt id | complete | throw: not observed | Final story completion | v1 rule kept |
| 5 | A1,A2 | none | blocked | accepted (evidence not required for blocked) | Story contracts | terminal non-complete |
| 6 | A1 | waiver written by the model into the tool arguments | complete | **rejected** — a waiver is only valid when recorded from a user message, never self-issued | Checkpoint rejected | the model may not author its own evidence (v1 receipt rule extended to waivers) |

#### Dataset: Dosing profiles

| # | Model id input | Normalized class | Intake form (post-compliance) | Traces to | Notes |
|---|---|---|---|---|---|
| 1 | `anthropic/claude-fable-5` | frontier | one-line nudge | Dosing outline | |
| 2 | `openrouter/anthropic/claude-fable-5` | frontier | one-line nudge | Dosing outline | prefix-tolerant |
| 3 | `minimax/MiniMax-M3` | standard | full scaffold | Dosing outline | mapped, non-frontier |
| 4 | `x/tiny-7b` | unknown → standard | full scaffold | Unknown model falls back | default + event with raw id |
| 5 | absent | unknown → standard | full scaffold | Unknown model falls back | `"unknown"` on events |

#### Dataset: Verifier payload hygiene (US-9 / FR-031)

| # | Payload field content | Boundary Type | Expected Output | Traces to | Notes |
|---|---|---|---|---|---|
| 1 | criteria + diff summary + verifier summary, all clean | happy | transmitted unchanged | Verifier payload carries evidence only | baseline |
| 2 | chat text containing `NARRATIVE_CANARY` present in session | exclusion | canary absent from payload | Verifier payload carries evidence only | schema excludes narrative |
| 3 | diff hunk containing `sk-live-abc123…` | security | hunk dropped; payload transmitted without it | Verifier payload carries evidence only | F-04 secret scan |
| 4 | diff hunk with a token split across two chunk boundaries | security / boundary | scan concatenates hunk before matching; hunk dropped | Verifier payload carries evidence only | F-04 partial-leak case |
| 5 | verifier stdout containing an **unlabelled** 40-character hex token | security / entropy | entropy rule trips (≥32 chars, ≥4.0 bits/char); line removed from the verifier summary | Verifier payload carries evidence only | `redactSecrets` alone misses this (MAJ-009) |
| 6 | verifier stdout with a connection string wrapped across two terminal lines | security / boundary | scan runs on the reassembled field; both lines removed | Verifier payload carries evidence only | verifier field, not just diffs |
| 7 | criteria line containing a 200-char base64 blob | security / entropy | criteria line removed; if that empties the field, the field is omitted and `verifier:field-dropped` logged | Verifier payload carries evidence only | third payload field |
| 8 | all three fields clean but one 4 000-char verifier summary | size boundary | field truncated to the summary cap before scanning; scan runs on the truncated text actually sent | Verifier payload carries evidence only | scan the transmitted bytes |
| 9 | English prose containing a 40-char lowercase word run | false positive | entropy < 4.0 ⇒ not treated as a secret; field transmitted intact | Verifier payload carries evidence only | guards against over-redaction |

### Regression Test Requirements

**Modifying existing functionality** — v1 behaviors that MUST be preserved:

| Existing Behaviour | Existing Test | New Regression Test Needed | Notes |
|---|---|---|---|
| `parseVerification` semantics (allowlist, masked exit, watch-mode, curl rules) | `tests/verification.test.ts` | No — must pass unchanged | frozen contract |
| Mutation detection (`isMutatingBashCommand`, redirects, heredocs, tee, /dev/null) | `tests/hookLifecycle.test.ts` mutation matrix, `tests/fixes.test.ts` | No — must pass unchanged | frozen contract |
| Receipt minting + invalidation on mutation/file.edited | `tests/goals.test.ts` (receipt parts) | Yes — `receipts_v2_semantics` (same rules, new store wiring) | store reused |
| Redaction before disk / in directives | `tests/riskRedaction.test.ts` | No — must pass unchanged | applied to new artifacts too (new tests cover that) |
| Fail-open honesty (missing/throwing `session.prompt`, timeout) | `tests/hookLifecycle.test.ts` F/O cases | Yes — port to v2 gate path | same guarantees |
| Gate caps (max 3 blocks → warn), holdout arm suppression | `tests/hookLifecycle.test.ts`, UAT I-cases | Yes — port with criteria-gate | |
| Promise-no-act detection + ask-user exemption | `tests/promise.test.ts` | No — detector kept; wiring test updated | folded into close-out |
| Quick/normal never hard-block; docs-only exemption | `tests/stopMode.test.ts` | Yes — assert under criteria-gate | invariant carried |
| Single queue consumer (messages.transform no-drain) | `tests/hookLifecycle.test.ts` L2 | Yes — composer equivalent | invariant carried |
| **Unverified-changes stop trigger (`EvidenceLedger.shouldBlockStop`: deep ∧ changed files ∧ no successful verification)** | `tests/gate.test.ts`, `tests/hookLifecycle.test.ts` | **Yes — port to the v2 gate as the zero-criteria fallback (test 41)** | review CRIT-003: rev 2 silently deleted this behaviour; it is **preserved**, not replaced |
| **Self-created session non-reentrancy (`gateContinuationSessions` branch in `chat.message`)** | `tests/hookLifecycle.test.ts` continuation cases | **Yes — generalised to `selfCreatedSessions` (test 43)** | v1 already needed this for one call site; v2 adds two more |
| **Whole v1 behaviour under `VERTEX_V2=0`** | the entire existing v1 suite (405 tests) | **Yes — run the suite unchanged with the flag set (test 52)** | rollback path, review MAJ-012 |

Explicitly **replaced** (tests updated/retired with the change): directive id/text assertions, goals schemaVersion 1 lifecycle, keyword-only stop-mode as sole authority, `vertex:ledger` unconditional narration.

> **Rev 3 correction**: rev 2's "explicitly replaced" list did **not** name the unverified-changes stop trigger, yet FR-015 as written removed it whenever no criteria were pinned. That was an unintended deletion, not a decision. It is now an explicitly **preserved** behaviour with its own regression row and test (review CRIT-003).

---

## Functional Requirements

**Phase engine (US-1)**
- **FR-001**: System MUST track a phase in the **four-state set `{intake, execute, elevate, close}`** with exactly the transitions in this table, and MUST NOT define any state it cannot enter (review MAJ-003 — `frame`, `plan` and `verify` are directive families rendered by the composer, not phases):

  | # | Source | Trigger | Target |
  |---|---|---|---|
  | T1 | (none) | session activated + first user message | `intake` |
  | T2 | any | new user message (`chat.message`) | `intake` |
  | T3 | `intake` | first mutating tool call observed | `execute` |
  | T4 | `execute` | bound/relevant verifier observed passing **and** it covers the final story of the active plan (or no plan is active) | `elevate` |
  | T5 | `execute` | verifier observed failing | `execute` (no transition; recorded) |
  | T6 | `elevate` | new mutating tool call observed | `execute` |
  | T7 | `elevate` | `session.idle` with every pinned criterion carrying evidence (or, with zero pins, no unverified changes) | `close` |
  | T8 | `execute` | non-final story checkpoints complete on an active plan | `execute` (rebound to the next story) |
  | T9 | `close` | new user message | `intake` (via T2) |

  **Scoping (review MAJ-004)**: when an active plan exists, phase is tracked **per active story** and the session-level phase is the active story's phase; with no plan the session has a single phase. Every arc above MUST be exercised by test 1.
- **FR-002**: System MUST reset phase to intake on each user message while preserving pinned criteria and plan state.

**Composer (US-2)**
- **FR-003**: System MUST render every injected directive with Observation and Prescription slots populated from observed state; Diagnosis from a versioned failure-mode taxonomy; Example optional.
- **FR-004**: System MUST enforce an injection budget of **2 directives per `experimental.chat.system.transform` invocation** with priority correction > phase-guidance > enrichment; dropped findings MUST be logged and MUST NOT be carried over to the next invocation or turn. Idle-gate continuation prompts issued via `session.prompt` are a separate channel and do not consume the budget (review F-05). In addition, each family has a **per-turn cap** — a turn spans one user message to the next, and a turn contains many `system.transform` invocations, so a single global per-turn number cannot serve five families (review MAJ-001):

  | Directive family | Priority | Per-turn cap |
  |---|---|---|
  | intake scaffold (`FR-011`) | phase-guidance | 1 |
  | plan proposal (`FR-018`) | phase-guidance | 1 |
  | pre-commitment prompt (`FR-023a`) | phase-guidance | 1 |
  | scope watchdog (`FR-021`) | correction | 1 |
  | anomaly interrupt (`FR-024`) | correction | 1 |
  | repeat-failure / re-model | correction | 1 per failure signature |
  | verify-gap prescription (`FR-008`) | correction | 3 |
  | elevate (`FR-027`) | phase-guidance | 1 |
  | pinned-criteria re-injection (`FR-014`) | enrichment | 1 |

  A family that has spent its per-turn cap MUST NOT be rendered again that turn even when the invocation budget is free; a family with cap remaining MUST be eligible in any later invocation of the same turn even when earlier invocations exhausted their 2 slots.
- **FR-005**: Each directive family has a cooldown expressed as an integer number of turns, **`cooldownTurns` (default 1)**. A family rendered at turn index T is suppressed until turn T + `cooldownTurns`. **The turn index increments on each `chat.message`; all assistant outputs and all `system.transform` invocations within one turn share the same turn index.** Cooldowns are never wall-clock-scoped. `cooldownTurns: 1` therefore means "at most once per turn"; `cooldownTurns: 2` spans one user-message boundary (review MAJ-002 — rev 2's "window resets on each new user message" clause made every configured value other than 1 unrepresentable).
- **FR-006**: System MUST decay a directive family to its one-line form after a logged compliance for that family in the previous turn.
- **FR-007**: System MUST pass all directive text through `redactSecrets` before injection (v1 invariant).

**Resolution (US-3)**
- **FR-008**: System MUST resolve prescriptions in tier order: active-story verifiers → basename convention (`*.test.*`/`*.spec.*`) via a per-turn cached manifest → package-manifest scripts → generic category list.
- **FR-009**: System MUST NOT spawn subprocesses or perform network calls in `tool.execute.after`/`system.transform`, except an optional resolution fallback bounded at 250 ms with per-turn caching; the degraded path MUST remain correct without it. **`chat.message` is the single deliberate exception**: it may issue the classification subturn under FR-018b's bounds (≤1 per task, ≤3 per session, 5 s total). No other hook may issue a model call. This exemption is stated rather than left implicit (review MAJ-007 — rev 2 exempted `chat.message` by silence).
- **FR-010**: System MUST log `resolution:none` with the changed-path set when degrading to the generic list.

**Intake & criteria (US-4)**
- **FR-011**: System MUST inject the intake scaffold (OUTCOME/ASSUMPTIONS/CRITERIA) on every turn of a session classified ≥ normal until a CRITERIA block is captured, and never for quick/read-only sessions.
- **FR-012**: System MUST parse `CRITERIA:` blocks from completed assistant text (fence-aware, case-insensitive keys, last-block-wins, cap 10, redacted) into pinned criteria with stable ids.
- **FR-013**: System MUST persist pins to `.elicify-vertex/pins.json` **always** — not conditionally on a plan existing (review MIN-009: the conditional created two persistence paths, two failure modes and two test modes for one concept, and silently lost a planless deep session's definition of done on restart). **If a pins write fails (e.g. `EACCES`, `ENOSPC`), the system MUST fall back to session-memory pins, log `pins:disk-fallback-memory` on the first failure, and retry the disk write on the next criteria update**; it MUST log `pins:disk-recovered` on the first subsequent success, and after **three consecutive failures** MUST log `pins:disk-unavailable` once and stop retrying for that session (review F-02, MIN-006).
- **FR-013a**: `pins.json` MUST be a JSON object **keyed by session id** (`{ [sessionID]: { criteria: [...], updatedAt: <ISO-8601> } }`), MUST be written under the **same lock as `plan.json`** — one lock for the `.elicify-vertex/` directory, `lockPath` derived from the state directory, 30 s staleness, read-modify-write performed inside the lock — MUST drop entries whose `updatedAt` is older than **7 days** or whose session is unknown to this process and has no plan, and MUST delete the file when the last entry is dropped (review MAJ-008).
- **FR-014**: System MUST re-inject pinned criteria and active story exactly once after `session.compacted`.
- **FR-015**: At `session.idle` on deep tasks with mutations, the system MUST block only when ≥1 criterion lacks evidence AND no explicit explanation artifact exists; the block MUST quote the criterion and include a resolved prescription; caps and holdout follow v1 rules (max 3 → warn).
  - **Zero-criteria fallback (review CRIT-003)**: **when zero criteria are pinned at `session.idle`, the system MUST fall back to the v1 evidence gate** — `deep` mode AND changed files AND no successful verification since the latest change — using the same caps, holdout arm and docs-only exemption; the block text MUST additionally state that no acceptance criteria were captured. The v1 trigger is **preserved, not replaced**: a model that never emits a `CRITERIA:` block MUST NOT receive a weaker harness than v1 ships.
  - **Multi-session advisory (review MIN-007)**: when more than one session is active, `file.edited` attribution is unavailable, so evidence cannot accrue; in that state the gate MUST NOT block on either path. It MUST render the criteria replay as advisory and log `gate:multi-session-advisory`.
- **FR-016**: Quick and normal modes MUST never hard-block; docs-only changes MUST never block (v1 invariants).

**Story contracts (US-5)**
- **FR-017**: Story schema v2 MUST include acceptance items (id, text, evidence pointer|null), scope globs, verifier commands, assumptions, rejected alternatives, amendments log; plans MUST validate on read and write.
- **FR-018**: System MUST classify multi-story scope via an intake subturn (child session, session model, user-ask evidence only); on subturn failure or timeout it MUST fall back to the heuristic and log `intake:classify-fallback`. Plans are auto-proposed, never auto-created. The heuristic's two terms MUST be the following enumerated constants, matching the bilingual convention of v1's `QUICK_RE`/`DEEP_RE`/`NORMAL_RE` (review MAJ-005 — both terms were previously undefined while five places conditioned behaviour on them):
  - `SEQUENCING_WORDS = /\b(first|then|next|after that|afterwards|finally|also|additionally|and then|followed by)\b/i` plus the Korean set `/(먼저|그다음|그리고 나서|그리고|마지막으로|이후에)/`. Matching is **word-boundary, case-insensitive, and fence-aware** — an occurrence inside a fenced code block or an attached file part does not count.
  - `IMPERATIVE_VERBS = /^(add|build|create|implement|fix|refactor|migrate|remove|delete|rename|update|upgrade|write|wire|test|document|split|extract|optimi[sz]e|revert)\b/i` (plus Korean equivalents `추가|구현|수정|리팩터|마이그레이션|삭제|변경|작성`). An **imperative outcome** is a top-level clause (split on `.`, `;`, newline, and a `SEQUENCING_WORDS` match) whose first token matches `IMPERATIVE_VERBS`. "≥2 imperative outcomes" means two or more such clauses.
- **FR-018a**: The classification subturn MUST be gated by a **cost** filter, not a scope filter (review MAJ-006 — rev 2's `INTAKE_SUBTURN_MIN_CHARS` length gate used message length as a proxy for scope, which provably skipped short multi-story asks such as "refactor auth end-to-end" and inverted Ambiguity #2's recorded resolution). The subturn MUST be skipped, with `intake:classify-skipped` logged, **only** when the ask matches `TRIVIAL_ASK_RE`:

  ```
  TRIVIAL_ASK_RE = /^(\s*(fix|correct)\s+(a\s+)?typos?\b|\s*rename\s+\S+\s+to\s+\S+\s*$|\s*(what|where|why|how|who|when)\b.*\?\s*$|\s*(read|show|open|print|explain|describe)\b[^.;\n]*$|\s*(bump|pin)\s+\S+\s+to\s+\S+\s*$)/i
  ```

  plus the Korean read-only/typo equivalents. `INTAKE_SUBTURN_MIN_CHARS` is **removed** from the spec; no length threshold participates in the decision. Ask text is measured over the concatenation of the message's `type: "text"` parts after trimming, with fenced code blocks and attached file parts excluded (review MIN-003).
- **FR-018b**: The classification subturn MUST be issued **from `chat.message`** — the only hook where the user ask is available before the model runs, and the only hook exempted from FR-009's no-network rule. It MUST be issued **at most once per task** (the first user message after activation, and again only after an explicit new-task signal) and at most **`VERTEX_INTAKE_SUBTURN_MAX`** (plugin option, default 3) times per session, logging `intake:classify-capped` on an attempt that would exceed either bound. It MUST be bounded at **5 s total including the retry**, and on expiry MUST fall back to the heuristic without a further attempt (review MAJ-007 — rev 2 attached classification to a phase that resets on every user message, with no hook site, frequency bound, latency budget or cost statement).
- **FR-019**: Checkpoint `complete` MUST require an evidence pointer (observed receipt id or recorded user waiver) on every acceptance item; violations throw naming the item. A **waiver is valid only when it originates from a user message** captured by the harness (recorded with the message id that carried it); a waiver appearing only in the model's tool arguments MUST be rejected, because the model may not author its own evidence (v1 receipt rule, extended to waivers — review: unasked question 5).
- **FR-020**: The final verification story MUST require an observed, workspace-matching, time-valid receipt (v1 receipt semantics preserved).
- **FR-021**: Mutations outside the active story scope MUST enqueue a guiding directive (fold/amend/revert) at most once per turn and MUST NOT block.
- **FR-022**: On encountering schemaVersion 1 state, the system MUST archive it and require plan re-creation (breaking change accepted). **Archival MUST be reversible**: the archived file retains its original base name plus an ISO-8601 timestamp suffix (`archive/goals.<timestamp>.json`), its contents are byte-identical to the original, and the plugin MUST NOT delete, truncate or prune any file under `archive/` on any code path (review MAJ-012).

**Artifacts & anomaly (US-6)**
- **FR-023**: System MUST capture the single-line `EXPECT [confidence]: <text>` artifact from completed assistant text with the same parsing rules as FR-012 (fence-aware, case-insensitive key, last-wins); inline confidence is optional and MUST be one of `low|med|high`, any other value yielding `declared: null` while the expectation text remains usable. A standalone `CONFIDENCE:` line is NOT an artifact (review F-09). Artifacts expire at turn end.
- **FR-023a**: On the **first `experimental.chat.system.transform` after the session enters `execute`** with changed files and no EXPECT artifact for the turn, the composer MUST render a one-line pre-commitment prompt at `phase-guidance` priority, at most once per turn (review MAJ-010 — rev 2's US-6 AS-1 required observing a verifier *starting*, which needs `tool.execute.before`, a hook the spec does not use, and which in any case delivers the prompt only after the tool has already returned; a phase-entry injection reaches the model before its next tool call). `tool.execute.before` is deliberately **not** added to the hook surface.
- **FR-024**: System MUST compare captured expectations against observed verifier outcomes (pass/fail + failure class) and inject the anomaly interrupt (quoting the expectation) on mismatch, at most once per turn (FR-004 cap table).
- **FR-025**: Absent/malformed artifacts MUST fail open (no comparison, no interrupt) with a logged reason.
- **FR-026**: System MUST log `calibration` events joining declared confidence (or `null` when not declared) to the observed outcome.

**Elevate (US-7)**
- **FR-027**: System MUST inject the elevate directive exactly once per turn when a relevant verifier passes on a deep session with mutations **and the passing verifier covers the final story of the active plan, or no plan is active**, containing criteria replay, the graduated sweep protocol, and the taste pass; never for quick or docs-only sessions, and never on an intermediate story's green (review MAJ-004 — declaring the finishing ritual at every intermediate green teaches the model to close early, the inverse of US-5's purpose).

**Dosing (US-8)**
- **FR-028**: System MUST resolve a model profile from the set `{standard, frontier}` (review F-08 — `small`/`mid` collapsed; their doses were identical) from the model id via suffix-tolerant matching over a config table, defaulting to `standard`; the profile MUST be recorded on the session and stamped on **every** event emitted for that session. The model id MUST be read from `experimental.chat.system.transform` (where `model: Model` is **required**) in preference to `chat.message` (where `model?` is optional), so the `dosing:unknown-model` path is reachable only for genuinely unmapped models (review: unasked question 1). `dosing:unknown-model` events MUST include the raw `providerID/modelID` string so the profile table can be populated from telemetry (review F-06).
- **FR-029**: The composer MUST consult the profile's dose per directive family before rendering, per this matrix (restored from `docs/vertex2-greenfield.html` §05, minus the proactive-fix license which is out of scope for v2.0 — see FR-021 and the Non-Behaviors; review OBS-002/MAJ-013):

  | Directive family | `standard` | `frontier` |
  |---|---|---|
  | Phase procedure (intake / plan scaffold) | full scaffold, every task | one-line nudge; suppressed after the first observed compliance |
  | Verification prescription | always, with the exact resolved command | only on a relevance gap |
  | Falsification / pre-commitment (FR-023a) | on turns introducing new tests | every execute-entry turn (primary lever) |
  | Anomaly interrupt (FR-024) | full | full |
  | Elevate (FR-027) | full checklist | rubric + taste pass only |

  The `frontier` profile MUST NOT reduce the anomaly-interrupt or falsification families below `full` (floor). Unlisted families are dosed `full` under both profiles.

**Verifier (US-9)**
- **FR-030**: The verifier MUST run as an in-loop subturn: child session via `session.create({parentID})`, one `session.prompt` with the verifier system prompt and the tool-disabling mechanism of FR-030b, `Promise.race` **5 s total including the retry**; fired only at final-story checkpoint of deep plans when enabled; its verdict MUST NOT gate the checkpoint.
- **FR-030a**: The subturn's model MUST default to the current session's `{providerID, modelID}`; a `verifierModel: "providerID/modelID"` plugin option MAY override it, with fallback to the session model on override failure.
- **FR-030b** (review CRIT-002): "Tool-calling disabled" MUST be **constructed**, not asserted. `SessionPromptData.body.tools` is `{ [toolName: string]: boolean }` — a per-tool-name allow/deny map with no documented deny-all flag — so the capability the spec needs is **not** established by the existence of that field. The system MUST therefore:
  1. Register a zero-tool subagent through the `config` hook: `config.agent["vertex-verifier"] = { mode: "subagent", description, prompt: <rubric>, tools: <deny map>, permission: { edit: "deny", bash: "deny", webfetch: "deny" }, maxSteps: 1 }`, and likewise `config.agent["vertex-intake"]` when the intake subturn is enabled. Grounded in `Config.agent[name]: AgentConfig` (`types.gen.d.ts:1112`, `:835`).
  2. Build the **deny map** at plugin init by enumerating the host's tool ids via `client.tool.ids()` (`GET /experimental/tool/ids` → `Array<string>`, `:1705`), setting every id to `false`, and additionally setting the key `"*": false` for hosts that honour a wildcard. Enumeration is at runtime, so installation-specific and MCP-contributed tools are covered.
  3. Pass **both** `agent: "vertex-verifier"` (never `opts.activeAgent`) and that same deny map as `tools` on `session.prompt`.
  4. Run a **deny-all capability probe once per process**, after registration: read back the resolved agents via `client.app.agents()` (`:1399` — each `Agent` carries a resolved `tools: {[id]: boolean}` map and a `permission` block) and require that the `vertex-verifier` entry exists, exposes **no** tool resolving to `true`, and carries `edit`/`bash`/`webfetch` = `deny`.

  **If the probe does not pass** — the agent is absent, any tool resolves to `true`, `client.tool.ids()` or `client.app.agents()` is unavailable, or the call throws — the subturn MUST be **disabled for the process**: no `session.create` and no `session.prompt` is issued, `verifier:unsupported` (respectively `intake:unsupported`) is logged once with the probe's reason, and callers proceed deterministically. The system MUST NOT send a subturn with a partial deny list. **This mechanism has not been verified against a running OpenCode host from within this spec's authoring session** — only against the SDK type surface — which is why the refusal path, not the deny map, is the control of record; the STRIDE row for both subturns stays at `risk` on Elevation of Privilege until a live verification is recorded (see Open Questions).
- **FR-031**: The verifier payload MUST contain only pinned criteria, diff summary, and verifier output summaries — schema-enforced, no chat narrative. **Every one of the three fields** MUST pass `redactSecrets` and then a **strict scan**, applied to the **reassembled field** rather than per chunk (review MAJ-009 — rev 2 scanned diff summaries only, leaving verifier stdout, the field most likely to echo a credential in the wild, covered by regex redaction alone). The strict scan is defined as `SECRET_PATTERNS` from `src/redaction.ts` **plus** a Shannon-entropy rule: any whitespace-delimited token of ≥32 characters with entropy ≥ 4.0 bits/character is treated as a secret. A field that trips the scan has the offending hunk (diff) or line (criteria, verifier output) removed; if removal empties the field, the field is omitted and `verifier:field-dropped` is logged. The scan runs on the **transmitted** bytes, i.e. after any summary truncation.
- **FR-032**: Verifier unavailability or malformed responses MUST fail open with `verifier:unavailable`/`verifier:malformed` events.

**Measurement (US-10)**
- **FR-033**: Every event MUST carry `model` (or `"unknown"`), session id and resolved dosing profile; new event types: `directive_rendered`, `directive_complied`, `calibration`, `phase_transition`, `resolution:none`, `dosing:unknown-model`, `gate:multi-session-advisory`, `pins:disk-*`, `intake:classify-*`, `subturn:cleanup-failed`, `verifier:*` statuses. These invariants MUST be enforced by a property test over every event type (test 42), not only by scenario tests.
- **FR-033a**: The `events.jsonl` sink MUST be size- and age-bounded: rotate at **32 MB** to `events.<timestamp>.jsonl` and delete rotated files older than **30 days**. v2 widens what lands on disk (directive text, changed-path sets, raw model ids); `redactForDisk` remains the only content control in v2.0 and no per-field classification scheme is specified (accepted risk, see the STRIDE table).
- **FR-034**: System MUST assign instance ids to rendered prescriptions and log `directive_complied` when the prescribed **or equivalently-resolved** verifier is observed in the same turn. **Two commands are equivalent when the FR-008 resolver returns the same tier and the same target path set for both, after stripping the flags enumerated in `IGNORED_VERIFIER_FLAGS` = `{--reporter=*, --reporters=*, -v, --verbose, --silent, --no-color, --color, --bail, --run, --watch=false}`** (review MIN-008 — compliance rate drives directive ROI and therefore which prescriptions get deleted, so the equivalence relation cannot be left to the implementer). A broader suite (different tier or a superset target path set) is **not** equivalent.
- **FR-035**: Holdout arms MUST extend to directive families (suppress rendering, log `holdout_suppress` with family), preserving v1 gate holdout behavior.

**Re-entrancy, rollback and subturn lifecycle (US-9, US-11)**
- **FR-036** (review CRIT-001): The plugin MUST record the id of every session it creates — verifier and intake subturns — in a `selfCreatedSessions` set for the process lifetime, and MUST **return early** from `chat.message`, `experimental.chat.system.transform`, `experimental.text.complete`, `tool.execute.after` and `event(session.idle)` for any session id in that set, or whose `parentID` resolves to a session already in it. For such sessions the harness MUST NOT push an activation cue into `output.parts`, MUST NOT append a directive block to `output.system`, MUST NOT allocate an entry in the ledger, task-mode, review, goal-root or activation-cue maps, and MUST NOT run the idle gate (so no `session.prompt` continuation can recurse). Subturn prompts MUST pass an explicit `agent` that is never `opts.activeAgent`. This generalises v1's existing `gateContinuationSessions` branch in `chat.message` (`src/index.ts` ~line 1581), which exists precisely because `client.session.prompt(...)` in `attemptGateContinuation` re-enters `chat.message`; v2 adds two further `session.prompt` call sites, so the exclusion must be a first-class rule rather than a per-call-site special case.
- **FR-037** (review MAJ-012): The plugin MUST support **`VERTEX_V2=0`** (equivalently plugin option `engine: "v1"`), which disables every v2 component and restores the v1 composer and gate paths for the process. The flag MUST be read **before any state file is read, written or archived**, so enabling it never mutates `.elicify-vertex/`. Together with FR-022's reversible archival this is the release's rollback path; no other remedy (downgrading the package) restores an archived plan.
- **FR-038** (review MAJ-014): Every subturn MUST delete its child session via `session.delete` (`SessionDeleteData`, `types.gen.d.ts:1860`) in a `finally` block — including on success, malformed verdict, timeout, retry exhaustion and thrown error. A deletion failure MUST log `subturn:cleanup-failed` and MUST NOT affect the caller's result. Child sessions are user-visible (`session.children`, `:1946`), so an undeleted one is a harness artefact in the user's session list and contradicts the "verifier outage is invisible" property.

---

## Success Criteria

- **SC-001**: 100% of injected gate/correction directives contain a non-empty Observation and Prescription slot (asserted by integration tests over all composer paths).
- **SC-002**: Narrowest-verifier resolution returns the expected command for **every row** of Dataset: Narrowest-verifier resolution (10/10); every non-matching input degrades to the generic list with `resolution:none` logged (review MIN-001 — a ≥95% threshold over a small dataset admits only 100%, so it communicated a tolerance the dataset cannot express).
- **SC-003**: Measured **against a no-op plugin baseline** over 1,000 synthetic invocations **of which ≥ 50 force the bounded resolution fallback**, median added latency ≤ 5 ms and p99 ≤ 250 ms per invocation of `tool.execute.after` and `experimental.chat.system.transform` (review MIN-005 — "added" needs a baseline and the p99 figure is only meaningful if the fallback actually fires). Separately, added latency in **`chat.message`** ≤ 5 s p100 (the classification-subturn budget) and ≤ 50 ms median across turns that skip the subturn (review MAJ-007).
- **SC-004**: In `uat_v2_core_loop` (test 32, runs in CI), a mutated session with an unmet criterion produces a block quoting the criterion and containing a runnable command; the following simulated green turn closes the session without a further block (review MIN-002 — rev 2 stated this over test 35, which the F-07 fix removed from CI, leaving the spec's headline behaviour unverified on every CI run). **SC-004a** (manual): the same property observed in `live_scripted_session` (test 35), maintainer-run.
- **SC-005**: EXPECT mismatch produces the anomaly interrupt in 100% of integration-test cases; zero interrupts fire when artifacts are absent (fail-open verified).
- **SC-006**: A story checkpoint with any evidence-less acceptance item is rejected in 100% of validation-test cases; plans on disk are never left schema-invalid (property-checked writer).
- **SC-007**: Across the full UAT run (harness asserts globally): no `system.transform` invocation injects more than 2 directives, no family exceeds its FR-004 per-turn cap, and no family repeats within its `cooldownTurns` window.
- **SC-008**: All frozen v1 regression tests (verification parsing, mutation matrix, redaction, promise detector) pass unchanged.
- **SC-009**: With the verifier stub disabled/hanging, 100% of final checkpoints complete within timeout + 500 ms and log `verifier:unavailable`.
- **SC-010**: Events stream is join-complete: every `directive_complied` references an existing `directive_rendered` instance id (validated by a metrics script over UAT output).
- **SC-011**: Over Dataset: Intake pre-filter and classification heuristics (14 rows), a client-call spy records **0** `session.prompt` classification calls on every `TRIVIAL_ASK_RE` row (each logging `intake:classify-skipped`) and **exactly 1** on every non-trivial row; no task issues more than one subturn and no session more than 3.
- **SC-012**: Over Dataset: Verifier payload hygiene (9 rows), 100% of rows containing a secret — in **any** of the three payload fields, including the boundary-split, unlabelled-token and base64 cases — transmit without the offending hunk/line; 0 rows over-redact the false-positive row; and **zero delivered payloads** contain the narrative canary, harness directives or the activation cue. "Delivered" means the payload observed at the `session.prompt` boundary in test 43's integration harness, not the object the payload builder returned (review CRIT-001 — a stub-client assertion is structurally incapable of detecting host-side injection).
- **SC-013**: In `pins_write_fault_and_retry` (test 40) and Dataset: Pins persistence, a pins write failure is followed by a successful disk write on the next criteria update in 100% of fault-injection rows, and a permanent fault produces exactly one `pins:disk-unavailable` after three attempts.
- **SC-014**: With `VERTEX_V2=0`, the full v1 regression suite (405 tests) passes unchanged and no file under `.elicify-vertex/` is created, modified or renamed during the run.
- **SC-015**: Zero deep sessions with changed files and no successful verification close without a block or a warn — **with or without pinned criteria** — across Dataset: Idle gate decision matrix and the UAT run.
- **SC-016**: In 100% of subturn test paths (success, malformed, timeout, throw), `session.delete` is called exactly once for the child session, and 0 harness-created sessions remain in `session.children` at the end of a UAT run.
- **SC-017**: When the FR-030b capability probe fails, 0 `session.create` and 0 `session.prompt` calls are issued and exactly one `verifier:unsupported` event is logged per process; when it passes, the `tools` value sent equals the enumerated deny map exactly (asserted field-by-field, not by shape).

---

## Traceability Matrix

| Requirement | User Story | BDD Scenario(s) | Test Name(s) |
|---|---|---|---|
| FR-001 | US-1 | intake→execute; verifier pass/fail paths; idle with all criteria evidenced closes; active plan scopes phase to the active story | 1, 2, 45, 49 |
| FR-002 | US-1 | message resets phase, keeps pins | 3 |
| FR-003 | US-2 | verify-gap renders slots | 4, 23 |
| FR-004 | US-2 | budget drops lowest; anomaly survives a turn whose budget went to corrections | 5, 48 |
| FR-005 | US-2 | cooldown suppresses identical finding across turn boundaries | 7 |
| FR-006 | US-2 | compliance decays | 6 |
| FR-007 | US-2 | (covered via dataset row: secret path) | 4, 18 |
| FR-008 | US-3 | resolution tiers outline | 8 |
| FR-009 | US-3 | resolution tiers; degrade | 8, 9 + SC-003 bench |
| FR-010 | US-3 | ambiguous degrades | 9 |
| FR-011 | US-4 | intake scaffold repeats until criteria are captured; read-only untouched | 19, 22 |
| FR-012 | US-4 | CRITERIA parsed/pinned | 10 |
| FR-013 | US-4 | CRITERIA persisted; pins write fault falls back and recovers | 10, 21, 40 |
| FR-013a | US-4 | pins write fault falls back and recovers (keying, lock, expiry rows) | 37, 40 |
| FR-014 | US-4 | criteria re-injected post-compaction | 21 |
| FR-015 | US-4 | idle block names unmet criterion; deep session with no pinned criteria still blocks; multi-session advisory | 20, 41 |
| FR-016 | US-4 | read-only untouched; docs-only (dataset row 6) | 20, 22 |
| FR-017 | US-5 | schema validation (checkpoint rejected) | 12, 37 |
| FR-018 | US-5 | plan proposed awaiting confirmation; short multi-story ask still reaches the classifier | 27, 38 |
| FR-018a | US-5 | trivial ask skips the classification subturn | 38 |
| FR-018b | US-5 | classification subturn is issued at most once per task | 50 |
| FR-019 | US-5 | checkpoint rejected naming item (incl. model-issued waiver row) | 12 |
| FR-020 | US-5 | final story requires observed receipt | 15 |
| FR-021 | US-5 | out-of-scope guides without blocking | 14, 28 |
| FR-022 | US-5, US-11 | v1 plan archived; archival is reversible and never destructive | 13, 53 |
| FR-023 | US-6 | EXPECT datasets; absent fails open | 11 |
| FR-023a | US-6 | pre-commitment prompt renders on execute entry | 46 |
| FR-024 | US-6 | mismatch fires interrupt | 24 |
| FR-025 | US-6 | absent/malformed fails open | 11, 24 |
| FR-026 | US-6 | calibration logged | 25 |
| FR-027 | US-7 | elevate once; docs-only never; intermediate story green does not elevate | 26, 49 |
| FR-028 | US-8 | unknown model falls back with raw id logged; resolved profile stamped on every event | 16 |
| FR-029 | US-8 | dosing outline (5 families × 2 profiles) | 17 |
| FR-030 | US-9 | verdict appended, non-gating; timeout fails open | 29, 51 |
| FR-030a | US-9 | subturn uses session model; verifierModel fallback | 36 |
| FR-030b | US-9 | verifier subturn is refused when tools cannot be disabled | 44 |
| FR-031 | US-9 | payload evidence-only (three fields, strict scan) | 18, 39 |
| FR-032 | US-9 | timeout fails open | 29 |
| FR-033 | US-10 | every emitted event carries model and session id | 42, 30, 31 |
| FR-033a | US-10 | every emitted event carries model and session id (rotation/retention asserted in the same suite) | 42 |
| FR-034 | US-10 | compliance joined by instance id (equivalence rows 10–11) | 30 |
| FR-035 | US-10 | family holdout suppresses | 31 |
| FR-036 | US-9 | verifier subturn receives no harness injection | 43 |
| FR-037 | US-11 | kill switch restores v1 behaviour for the whole process | 52 |
| FR-038 | US-9 | subturn child session is deleted on every path | 47, 29, 36 |

**Completeness check (counted, rev 3)**:

| Artefact | Count | Breakdown |
|---|---|---|
| User stories | **11** | US-1…US-11 (US-11 added in rev 3) |
| Acceptance scenarios | **54** | US-1: 5, US-2: 5, US-3: 4, US-4: 8, US-5: 7, US-6: 4, US-7: 4, US-8: 3, US-9: 8, US-10: 3, US-11: 3 |
| BDD scenarios | **51** | 49 scenarios + 2 Scenario Outlines; fewer than 54 because three scenarios each cover a group of acceptance scenarios (US-3 AS-1–3, US-7 AS-1–2, US-11 AS-1 & 3) |
| Tests in the TDD plan | **53** | 1–53; 26 Unit, 21 Integration, 5 E2E, 1 Unit (property) |
| Functional requirements | **45** | FR-001…FR-038 plus FR-013a, FR-018a, FR-018b, FR-023a, FR-030a, FR-030b, FR-033a |
| Success criteria | **18** | SC-001…SC-017 plus SC-004a (manual) |
| Test datasets | **9** | resolution, artifact parsing, composer budget/cooldown/decay, intake pre-filter, idle gate matrix, pins persistence, checkpoint evidence, dosing profiles, verifier payload hygiene |

Every FR appears in the matrix above. **All 54 acceptance scenarios are covered** — verified by resolving every BDD `Traces to:` line against the acceptance lists, with zero uncovered. Every BDD scenario has ≥1 named test in the TDD plan.

Rev 2's check asserted completeness without counting: the independent review found 41 acceptance scenarios against 34 BDD scenarios, with US-1 AS-3, US-6 AS-1, US-8 AS-1 and US-10 AS-1 uncovered and the verifier happy path untested (review MAJ-011). All five gaps are closed by tests 45, 46, 16 (extended), 42 and 51; the E2E tests 32–35 remain cross-story coverage on top of, not instead of, the per-scenario rows.

---

## Ambiguity Warnings

Resolved 2026-07-25 (user review); one item pending:

| # | What Was Ambiguous | Resolution | Status |
|---|---|---|---|
| 1 | Criteria source when the model never produces a `CRITERIA:` block | **Keep demanding** — scaffold repeats every turn until captured (FR-011) | Resolved |
| 2 | Multi-story detection for auto-propose | **LLM-classified intake subturn** (session model), heuristic fallback on failure (FR-018). Rev 3 restores this resolution: the pre-filter is a *cost* gate (`TRIVIAL_ASK_RE`, FR-018a), not a scope gate, so the LLM still decides for every non-trivial ask | Resolved |
| 3 | Dosing profile table source | Plugin options in `opencode.json` + built-in defaults (FR-028); the tunables are `verifierModel`, `engine`, `VERTEX_INTAKE_SUBTURN_MAX` and the per-family `cooldownTurns`/cap overrides — all in the options surface, none hardcoded | Resolved |
| 4 | "Turn" boundary | User message → next user message (v1 ledger semantics). A turn contains **many** `system.transform` invocations; the injection budget is per invocation and the caps/cooldowns are per turn (FR-004, FR-005) | Resolved |
| 5 | Verifier model selection | **In-loop subturn on the session's own model by default** (always works, no extra config); optional `verifierModel` plugin option over host-configured providers; grounded in SDK 1.18.4 `session.create({parentID})` + `session.prompt({model, agent, system, tools, parts})` (FR-030/030a). **Rev 3 correction**: the presence of the `tools` field does **not** establish "tool-calling disabled" — see FR-030b and Open Question 1 | Resolved (with a correction) |
| 6 | v2 tool/slash naming | `elicify_vertex_plan_*` tools, `/elicify-vertex-plan-*` slash; `goal` names removed | Resolved |
| 7 | Elevate trigger without a story | Any successful verifier while unverified changes existed; relevance preferred, not required (FR-027) | Resolved |
| 8 | Automated one-shot-rate labeling in v2.0 | **No in-plugin labeling, ever** — corrective-turn labeling is semantic judgment (tier 3), unreliable deterministically. v2.0 records raw events only (FR-033/034); one-shot rate is computed offline by a future verifier script over recorded sessions, out of v2.0 scope | Resolved |

**Item 8 rationale (user, 2026-07-25)**: keyword labeling could not work reliably; only an LLM verifier could — therefore it is offline tier-3 tooling, not plugin runtime.

Added in rev 3 (decided by the revision pass, not by the user — flagged as such):

| # | What Was Ambiguous | Resolution | Status |
|---|---|---|---|
| 9 | Which agent do the subturns run as? | A plugin-registered zero-tool subagent (`vertex-verifier` / `vertex-intake`), never `activeAgent` (FR-030b, FR-036) | Resolved |
| 10 | Cost budget for v2 | ≤1 classification subturn per task, ≤3 per session, ≤1 verifier subturn per final checkpoint; no other paid call exists. Token spend is otherwise unbudgeted in v2.0 | Resolved (bounded), see Open Questions |
| 11 | "A new task in the same session" vs "a follow-up message" | An explicit new-task signal only: the user invokes a plan slash command, or the user message follows a `close`-phase idle with no pending story. Phase still resets to `intake` on every user message (FR-002), but the intake **scaffold** stops once criteria are captured (FR-011) and classification does not re-fire (FR-018b) | Resolved |
| 12 | Is `.elicify-vertex/pins.json` project state or session state? | **Session state that happens to be durable** — session-keyed, 7-day TTL, deleted when empty (FR-013a). It is not intended to be committed; `.elicify-vertex/` should be gitignored, as the Assumptions already recommend | Resolved |
| 13 | Migration for a user with an active v1 plan who does not want it archived | `VERTEX_V2=0` before first contact keeps v1 semantics and touches nothing; if archival already happened, the archived file is byte-identical and can be renamed back (FR-022, FR-037) | Resolved |

---

## Review Findings Applied

### Rev 3 — independent adversarial review (`docs/vertex2-spec-review.md`, 2026-07-25, verdict BLOCK)

30 findings: 3 CRITICAL, 14 MAJOR, 9 MINOR, 4 OBSERVATION. **26 resolved, 1 partially resolved, 3 deferred with reasons.**

| ID | Severity | Disposition | Section(s) changed |
|---|---|---|---|
| CRIT-001 | Critical | **Resolved** | New **FR-036** (`selfCreatedSessions` exclusion across all five hooks); US-9 AS-6; BDD "Verifier subturn receives no harness injection"; Edge Cases; Integration Boundaries; **integration** test 43 (explicitly not stub-only); SC-012 restated over the **delivered** payload; regression row added |
| CRIT-002 | Critical | **Partially resolved** — mechanism specified and made refusable, but **not verified against a running host** from within this revision (no live host session was available; only the SDK type surface was checked) | New **FR-030b** (registered zero-tool `vertex-verifier` agent + deny map enumerated from `client.tool.ids()` + `"*": false` + one-time capability probe + refuse-and-log `verifier:unsupported`); US-9 AS-7; BDD "Verifier subturn is refused when tools cannot be disabled"; test 44; SC-017; STRIDE row held at `risk` on Elevation of Privilege; Open Question 1 |
| CRIT-003 | Critical | **Resolved** | **FR-015** zero-criteria fallback to the v1 evidence gate; US-4 AS-6; BDD "Deep session with no pinned criteria still blocks on unverified changes"; test 41; Dataset: Idle gate decision matrix; Regression row "Unverified-changes stop trigger — preserved"; SC-015 |
| MAJ-001 | Major | **Resolved** | **FR-004** budget re-scoped to per `system.transform` invocation + per-family per-turn cap table (9 families); US-2 narrative + AS-5; BDD "Anomaly interrupt survives a turn whose budget went to corrections"; test 48; Composer dataset rows 7 and 9; SC-007 |
| MAJ-002 | Major | **Resolved** | **FR-005** rewritten as integer `cooldownTurns` (default 1) over a monotonic turn index; the self-contradicting "resets on each new user message" clause removed; US-2 AS-4; BDD updated; Composer dataset row 8 |
| MAJ-003 | Major | **Resolved** (review's preferred option (a)) | **FR-001** reduced to the four reachable phases with a full 9-arc transition table; `frame`/`plan`/`verify` demoted to directive families; US-1 narrative; US-6 AS-1 re-based on `execute`; test 1 covers every arc |
| MAJ-004 | Major | **Resolved** | **FR-001** phase tracked per active story when a plan exists; **FR-027** gated on the final story; US-1 AS-5; US-7 AS-4; BDD ×2; tests 26 (3-story fixture) and 49 |
| MAJ-005 | Major | **Resolved** | **FR-018** enumerates `SEQUENCING_WORDS` and `IMPERATIVE_VERBS` (English + Korean, word-boundary, fence-aware) and defines "imperative outcome"; new Dataset: Intake pre-filter (14 rows); test 38; SC-011 |
| MAJ-006 | Major | **Resolved** | **FR-018a** replaces the character-length gate with `TRIVIAL_ASK_RE`, a cost gate; `INTAKE_SUBTURN_MIN_CHARS` deleted from the spec; US-5 AS-6; new BDD "Short multi-story ask still reaches the classifier"; dataset rows 4–6 carry the exact examples the review named |
| MAJ-007 | Major | **Resolved** | New **FR-018b** (hook site `chat.message`, ≤1/task, ≤`VERTEX_INTAKE_SUBTURN_MAX`=3/session, 5 s total incl. retry); US-5 AS-7; BDD; test 50; SC-003 extended with a `chat.message` budget; Non-Behavior added |
| MAJ-008 | Major | **Resolved** | New **FR-013a** (session-keyed `pins.json`, shared directory lock, 7-day expiry, delete-when-empty); Integration Boundaries → Filesystem state; new Dataset: Pins persistence (8 rows); test 40; SC-013 retargeted at test 40; test 37 removed from the FR-013 row (OBS-003) |
| MAJ-009 | Major | **Resolved** | **FR-031** extends the strict scan to all three payload fields on the reassembled field and defines it (`SECRET_PATTERNS` + Shannon entropy ≥4.0 bits/char over ≥32-char tokens), with `verifier:field-dropped`; hygiene dataset rows 5–9 (incl. a false-positive row); SC-012 |
| MAJ-010 | Major | **Resolved** | New **FR-023a** (pre-commitment as a phase-entry injection); US-6 AS-1 rewritten; BDD "Pre-commitment prompt renders on execute entry"; test 46; `tool.execute.before` explicitly **not** added to the hook surface |
| MAJ-011 | Major | **Resolved** | BDD scenarios + tests added for US-1 AS-3 (45), US-6 AS-1 (46), US-8 AS-1 (16 extended), US-10 AS-1 (42) and the verifier happy path (51); the Completeness check now states counted numbers |
| MAJ-012 | Major | **Resolved** | New **US-11** (P0), **FR-037** (`VERTEX_V2=0` / `engine: "v1"`, read before any state access), **FR-022** reversible archival; BDD ×2; tests 52–53; SC-014; regression row for the whole v1 suite under the flag |
| MAJ-013 | Major | **Resolved** (license declared out of scope) | Non-Behavior's `standard`-only qualifier removed — propose-only under **all** profiles; the frontier proactive-fix license added to the Assumptions' out-of-scope list; FR-029's dose matrix omits it explicitly |
| MAJ-014 | Major | **Resolved** | New **FR-038** (`session.delete` in `finally` on every path, `subturn:cleanup-failed`); US-9 AS-8; BDD; test 47; assertions added to tests 29 and 36; SC-016 |
| MIN-001 | Minor | **Resolved** | SC-002 restated as every row (10/10) after the resolution dataset grew to 10 rows |
| MIN-002 | Minor | **Resolved** | SC-004 restated over `uat_v2_core_loop` (test 32, CI); SC-004a keeps the live session as an explicitly manual criterion |
| MIN-003 | Minor | **Resolved** | Moot for the threshold (deleted with MAJ-006); the measurement rule survives in FR-018a — text parts, trimmed, code fences and file attachments excluded |
| MIN-004 | Minor | **Resolved** | US-5 acceptance scenarios renumbered 1–7 in reading order; the two `Traces to: US-5 AS-6` references still resolve (the trivial-ask scenario is still #6) |
| MIN-005 | Minor | **Resolved** | SC-003 given a no-op-plugin baseline and a benchmark composition (≥50 of 1 000 invocations force the fallback) |
| MIN-006 | Minor | **Resolved** | FR-013 adds `pins:disk-recovered` and `pins:disk-unavailable` after three consecutive failures; US-4 AS-8; dataset row 4 |
| MIN-007 | Minor | **Resolved** | FR-015 multi-session advisory clause; US-4 AS-7; BDD; Edge Cases; test 20 extended; gate dataset row 7 |
| MIN-008 | Minor | **Resolved** | FR-034 defines verifier equivalence (same tier + same target path set, modulo `IGNORED_VERIFIER_FLAGS`); Composer dataset rows 10–11 |
| MIN-009 | Minor | **Resolved** | FR-013 always persists pins; the plan-conditional dual mode deleted; BDD and Edge Cases updated |
| OBS-001 | Observation | **Deferred** — `verifierModel` is a recorded user decision (Clarifications 2026-07-25, Ambiguity #5); removing it would reverse a resolved question without the user present. Cost is one option, one AS, one BDD scenario and part of test 36 | No change; recorded here as an accepted carry |
| OBS-002 | Observation | **Resolved** | FR-029 now carries the five-family × two-profile dose matrix restored from `docs/vertex2-greenfield.html` §05 (minus the fix license, per MAJ-013); the BDD outline and test 17 exercise all ten cells |
| OBS-003 | Observation | **Resolved** | Test 37 removed from the FR-013 traceability row and re-described as state-directory write concurrency; the pins fault-injection test (40) takes its place |
| OBS-004 | Observation | **Resolved** | The rev-2 self-review independence caveat is retired and replaced by the provenance note below |

**Deferred, with reasons** (3): OBS-001 (reverses a recorded user decision — see above); **token/spend budgeting beyond call counts** (review Unasked Question 3 — v2.0 bounds the *number* of paid calls but sets no cost ceiling; a spend budget needs pricing data the plugin does not have); **per-field data classification for `events.jsonl`** (STRIDE Information-Disclosure row — v2.0 ships `redactForDisk` plus FR-033a's size/age bound and defers a classification scheme to v2.1).

**Partially resolved** (1): CRIT-002 — see the row above and Open Question 1.

**Review provenance (replaces the rev-2 independence caveat, OBS-004)**: rev 3 responds to an **independent** review round produced with fresh context by a reviewer that took no part in authoring the spec, checked against the current text, and verified the spec's codebase claims against `src/index.ts`, `src/goals.ts`, `src/redaction.ts`, `node_modules/@opencode-ai/plugin/dist/index.d.ts` and `node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts`. Rev 3's own edits were made autonomously, without a user in the loop: every design choice this pass had to make (cap numbers, env var names, regex contents, the MAJ-003/MAJ-013 option selections) is stated inline in the requirement text rather than left as a placeholder, and the ones that could not be settled from evidence are in Open Questions below rather than silently decided.

### Open Questions (rev 3 — not resolved by this pass)

1. **Does the OpenCode host honour a deny-all `tools` map?** FR-030b's mechanism (registered zero-tool agent + enumerated deny map + `"*": false`) is grounded in the SDK type surface but was **not** exercised against a running server. Until a maintainer records a live verification, the capability probe's refusal path is the control, and both subturn STRIDE rows stay at `risk` on Elevation of Privilege. **Action before implementation**: run one verifier subturn against a live host with a deliberately tool-inviting payload and assert zero tool calls.
2. **Is `client.tool.ids()` complete?** It is an experimental endpoint (`GET /experimental/tool/ids`). If MCP-contributed tools are registered lazily, the enumerated deny map may be built before they exist. FR-030b's probe re-reads `client.app.agents()`, which should reflect resolution, but this ordering is unverified.
3. **Does `maxSteps: 1` on the verifier agent interact with `Promise.race`?** If the host enforces `maxSteps` by truncating rather than erroring, a truncated verdict may parse as malformed rather than as unavailable. Both fail open, so the behaviour is safe either way, but the event taxonomy would attribute it to the wrong cause.

### Rev 2 — prior round (superseded)

Rev 2 applied nine findings (F-01…F-09) as text edits. The independent round found only three (F-05, F-06, F-09) resolved the underlying defect; F-01 and F-03 introduced new defects while closing the reported ambiguity (MAJ-002, MAJ-006), and F-02, F-04 and F-07 left each requirement improved but its verification hollow (MAJ-008, MAJ-009, MIN-002). Rev 3 carries the three sound fixes forward unchanged and re-does the other six at the requirement, dataset and test layers together.

| ID | Rev-2 claim | Rev-3 status |
|---|---|---|
| F-01 | FR-005 cooldowns turn-scoped | Re-done — FR-005 rewritten as `cooldownTurns` (MAJ-002) |
| F-02 | FR-013 memory fallback + retry | Re-done — FR-013a + test 40 + SC-013 retargeted (MAJ-008, MIN-006) |
| F-03 | FR-018a pre-filter | Replaced — cost gate, not length gate (MAJ-006); heuristic terms enumerated (MAJ-005) |
| F-04 | FR-031 reassembled-hunk scan | Extended — all three fields, scan defined (MAJ-009) |
| F-05 | FR-004 budget channel-scoped | Kept, and re-scoped per invocation with a cap table (MAJ-001) |
| F-06 | FR-028 raw model id | Kept unchanged; model id now sourced from `system.transform` first |
| F-07 | Test 35 CI-skipped | Kept; SC-004 moved off it to test 32 (MIN-002) |
| F-08 | Profiles collapsed to 2 | Kept; the two profiles now differ across five families, not one (OBS-002) |
| F-09 | Inline `EXPECT [conf]:` | Kept unchanged |

---

## Evaluation Scenarios (Holdout)

> **Note**: For post-implementation evaluation only. Must NOT be referenced in the
> TDD plan or traceability matrix, and not visible to the implementing agent.
> Basis: scripted live-session review by a maintainer using `opencode run`.

### Scenario: Vague feature request lands one-shot
- **Setup**: Fresh project with a small TS module and vitest configured. Prompt: "make the formatter handle nested lists properly, you know what I mean".
- **Action**: Single `opencode run` with the vertex agent; no follow-up guidance.
- **Expected outcome**: The transcript shows an OUTCOME line, explicit assumptions, pinned criteria; the final report replays each criterion with evidence; the diff includes a test that covers nesting; no generic "run a test" text appears — commands are named.
- **Category**: Happy Path

### Scenario: Deep task blocked once, then teaches its way green
- **Setup**: Repo with failing-prone module and a test suite. Prompt instructs the model (via task content) to edit and stop without verifying.
- **Action**: Observe the idle block and the following turn.
- **Expected outcome**: Exactly one block; its text quotes the specific unmet criterion and a runnable command naming the changed file's suite; the next turn runs that command; session closes green without a second block.
- **Category**: Happy Path

### Scenario: Story plan proposed, confirmed, and closed with receipts
- **Setup**: Prompt describing three sequential outcomes.
- **Action**: Accept the proposed plan; work proceeds; inspect `.elicify-vertex/plan.json` afterwards.
- **Expected outcome**: Plan file is schemaVersion 2; every completed story's acceptance items carry receipt ids that appear in the session transcript; final story holds an integrated receipt.
- **Category**: Happy Path

### Scenario: Wrong expectation triggers re-modeling, not thrash
- **Setup**: Module with a deliberately misleading bug (symptom far from cause).
- **Action**: Watch the first failing verifier after an `EXPECT: pass` line.
- **Expected outcome**: The next assistant message quotes its own expectation, states the falsified belief, and reads a *different* file before editing again; no third repeat of the same fix location.
- **Category**: Error

### Scenario: Verifier outage is invisible to the user
- **Setup**: `VERTEX_VERIFIER=1` with the provider unreachable (network blocked) so the verifier subturn cannot complete.
- **Action**: Complete a deep plan's final checkpoint.
- **Expected outcome**: Checkpoint completes without user-visible delay beyond ~5 s; close-out report renders; events contain `verifier:unavailable`; no error surfaces in chat; **the session list contains no leftover harness-created child session**, and the transcript shows no vertex directive addressed to a verifier.
- **Category**: Error

### Scenario: Rapid trivial Q&A stays friction-free
- **Setup**: Ten consecutive quick questions ("what does this function do?", "where is X defined?") with no edits.
- **Action**: Run them in one session.
- **Expected outcome**: Zero intake scaffolds, zero blocks, zero elevate directives; at most cosmetic activation cue; responses are not longer than a non-harnessed baseline by more than ~10%.
- **Category**: Edge Case

### Scenario: A model that ignores the scaffold is still not let off the hook
- **Setup**: Repo with a test suite. Prompt a deep task with an instruction in the task content that discourages emitting any structured block, so no `CRITERIA:` block is ever produced.
- **Action**: Let the model edit files and stop without running a verifier.
- **Expected outcome**: The session is still blocked once, the block says no acceptance criteria were captured and names a runnable command for the changed files, and the harness is observably no weaker than v1 on the same transcript. A session that closes silently here is a failure of this scenario.
- **Category**: Error

### Scenario: Compaction does not lose the definition of done
- **Setup**: Long session engineered to trigger compaction mid-task with 3 pinned criteria.
- **Action**: Continue after compaction and let the task finish.
- **Expected outcome**: Post-compaction turns still reference the original criteria ids; the close-out replays all 3; none are dropped or rephrased into something weaker.
- **Category**: Edge Case

---

## Assumptions

- OpenCode ≥ 1.18 with the v1 plugin `Hooks` API remains the host contract; `experimental.chat.system.transform` continues to carry a required `model: Model` and `chat.message` an optional one.
- The host honours plugin-registered agents written into `config.agent` from the `config` hook, and `client.app.agents()` reflects the resolved result. **If it does not, FR-030b's probe fails closed and both subturns are disabled — the spec degrades rather than breaks.**
- Single OpenCode process per project; cross-process plan safety relies on the existing lock-file mechanism only.
- vitest remains the project's test framework for v2's own tests; fixture-driven unit tests require no network and no subprocess.
- The v1 measurement environment variables (`VERTEX_DATA`, `VERTEX_HOLDOUT`, `VERTEX_DEBUG`) carry over; new: `VERTEX_VERIFIER` (verifier subturn on/off) and **`VERTEX_V2`** (`0` = kill switch, FR-037). New plugin options: `verifierModel`, `engine`, `VERTEX_INTAKE_SUBTURN_MAX`, per-family `cooldownTurns` and per-turn cap overrides.
- Breaking-change communication (README migration note, major version bump) happens at release; the *technical* rollback path is in scope and specified (US-11, FR-037).
- Out of scope for v2.0: cross-session/user-level memory, automated one-shot-rate labeling, multi-agent evidence trust-weighting, prompt-technique A/B content variants beyond family holdouts, **a `frontier` proactive-fix license** (review MAJ-013 — propose-only holds under every profile in v2.0), **token/spend budgeting beyond the call-count bounds in FR-018b and FR-030**, and **per-field data classification for the event sink** (FR-033a bounds size and age only).
- `.elicify-vertex/` state lives in the worktree root and is **not** branch-aware: switching branches leaves `plan.json` in place. Projects wanting branch-scoped plans should add `.elicify-vertex/` to `.gitignore` and re-create plans per branch (review: unasked question 1). v2.0 ships no branch detection.

## Clarifications

### 2026-07-25

- Q: Spec scope? → A: Full Vertex 2 in one spec; priorities encode migration order.
- Q: Greenfield package or evolve? → A: Evolve in-repo as next major version.
- Q: Tier-3 verifier in scope? → A: Yes, as P2.
- Q: Preserve v1 user surface? → A: No — breaking changes allowed (tools, slash commands, goals schema).
- Q: Subprocess in hot path for resolution? → A: Avoid if possible; correctness of guidance outranks purity → bounded, cached fallback permitted (FR-009).
- Q: Human evaluation method? → A: Scripted live-session review (holdout scenarios above).

### 2026-07-25 — ambiguity review

- Q: Model never produces CRITERIA? → A: Keep demanding every turn until captured.
- Q: Multi-story detection? → A: LLM-classified intake subturn; heuristic only as failure fallback.
- Q: Dosing config? → A: Plugin options + built-in defaults.
- Q: Turn boundary? → A: User message → user message.
- Q: Verifier model? → A: Must always work; run as a subturn of the agent loop on the session's own model; optional `verifierModel` plugin option for a different host-configured model. Grounded against SDK 1.18.4 (`session.create` supports `parentID`; `session.prompt` supports per-call `model`, `agent`, `system`, `tools`). *Superseded in part by rev 3: the `tools` field is a per-tool-name map, not a disable flag — see FR-030b.*
- Q: Naming? → A: `plan_*`.
- Q: Elevate trigger without story? → A: Any green verifier.
- Q: One-shot labeling in v2.0? → A: None in the plugin — labeling is semantic and only reliable via an LLM verifier, therefore offline tier-3 tooling out of v2.0 scope; the plugin records raw events only.

### 2026-07-25 — rev 2 (grill-spec revision)

- Q: Do cooldowns reset on wall-clock or turn? → A: Turn (`chat.message`); shared across assistant outputs in the turn (F-01).
- Q: Does a pins disk failure disable persistence for the session? → A: No — memory fallback, log once, retry next update (F-02).
- Q: Does the classification subturn run on trivial asks? → A: No — pre-filter at 120 chars or a sequencing word; skip and log (F-03).
- Q: Could a split credential reach the verifier? → A: Scan the reassembled hunk and drop it; not per-chunk (F-04).
- Q: Do idle continuations consume the injection budget? → A: No — budget is `system.transform`-scoped (F-05).
- Q: How are unmapped models discovered? → A: raw id in `dosing:unknown-model` (F-06).
- Q: Can the live E2E run in CI? → A: Maintainer-run; skipped unless `OPENCODE_LIVE_TEST=1` (F-07).
- Q: Three dosing profiles? → A: Two — `standard`, `frontier`; the third was speculative (F-08).
- Q: Separate `CONFIDENCE:` line? → A: Retired; inline `EXPECT [conf]:` (F-09).

### 2026-07-25 — rev 3 (independent adversarial review revision)

> Decided autonomously by the revision pass, with no user present. Each answer is stated in the requirement text it governs; unresolved items are in *Open Questions*, not here.

- Q: Do the plugin's own child sessions re-enter its hooks? → A: Yes, and that is now excluded — `selfCreatedSessions` + explicit non-`activeAgent` agents (FR-036, CRIT-001).
- Q: Can `session.prompt` express "tool-calling disabled"? → A: Not by itself — `tools` is a per-name map. Disabling is constructed from a registered zero-tool agent + an enumerated deny map + a capability probe, and the subturn is **refused** when the probe fails (FR-030b, CRIT-002). Not yet verified against a live host.
- Q: What blocks when the model never emits `CRITERIA:`? → A: v1's unverified-changes gate, preserved as the zero-criteria fallback (FR-015, CRIT-003).
- Q: Is the injection budget per turn or per `system.transform`? → A: Per invocation (2), with a per-family per-turn cap table (FR-004, MAJ-001).
- Q: How is a cooldown expressed? → A: `cooldownTurns`, an integer number of turns over a monotonic turn index (FR-005, MAJ-002).
- Q: Seven phases or four? → A: Four reachable phases with a published 9-arc transition table; frame/plan/verify are directive families (FR-001, MAJ-003).
- Q: Session phase or story phase? → A: Per active story when a plan exists; elevate only on the final story (FR-001, FR-027, MAJ-004).
- Q: What is a "sequencing word" / an "imperative outcome"? → A: Enumerated constants, English + Korean, word-boundary and fence-aware (FR-018, MAJ-005).
- Q: Should short asks skip classification? → A: No — trivial asks skip it (`TRIVIAL_ASK_RE`); length is not a scope signal (FR-018a, MAJ-006).
- Q: Where and how often does classification run? → A: `chat.message`, ≤1 per task, ≤3 per session, 5 s total including the retry (FR-018b, MAJ-007).
- Q: Does `pins.json` have a lifecycle? → A: Session-keyed, shared directory lock, 7-day TTL, deleted when empty; always persisted (FR-013/013a, MAJ-008, MIN-009).
- Q: Which verifier payload fields are scanned? → A: All three, on the reassembled field, with `SECRET_PATTERNS` + an entropy rule (FR-031, MAJ-009).
- Q: How does the pre-commitment prompt arrive before the verifier? → A: As a phase-entry injection on the first `system.transform` after entering `execute`; `tool.execute.before` stays out of the hook surface (FR-023a, MAJ-010).
- Q: What is the rollback path? → A: `VERTEX_V2=0`, read before any state access, plus byte-identical reversible archival (US-11, FR-037/FR-022, MAJ-012).
- Q: Does `frontier` get a silent-fix license? → A: No — propose-only under every profile in v2.0; out of scope (MAJ-013).
- Q: Are subturn child sessions deleted? → A: Yes, in `finally`, on every path (FR-038, MAJ-014).
- Q: Who may issue an evidence waiver? → A: Only a user message; a model-authored waiver in tool arguments is rejected (FR-019).
- Q: What makes two verifier commands "equivalent" for compliance? → A: Same resolver tier and same target path set, ignoring `IGNORED_VERIFIER_FLAGS` (FR-034, MIN-008).
