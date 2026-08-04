# Adversarial Review: Wave-Based Parallel Story Execution with Deterministic Mandatory Verification

**Spec reviewed**: `/home/dev/elicify-vertex/docs/vertex2-waves-spec.md`
**Review date**: 2026-07-27
**Verdict**: **BLOCK**

## Executive Summary

This spec bundles six independent workstreams (waves, D1 relevance, D2/D3 idle driver, D4 turn advancement, TUI visibility, and an intake gate) into a single 76-FR change gated on an all-or-nothing `plan.json` schema bump, and it does so on top of a codebase whose actual behaviour contradicts the spec in at least ten load-bearing places. The archival design (FR-018) destroys other sessions' data because `plan.json` is a **multi-session map**, not a single plan; the wave gate (FR-022) cannot be satisfied because the receipt store is in-memory, capped at 20 entries, and wiped on every mutation; and the intake gate (US-16) makes the autonomous multi-story operation this feature exists to enable structurally impossible. Ten CRITICAL findings must be resolved before any implementation begins.

| Severity | Count |
|----------|-------|
| CRITICAL | 10 |
| MAJOR | 21 |
| MINOR | 9 |
| OBSERVATION | 5 |
| **Total** | **45** |

**Grounding note**: every finding below was verified against the shipped source at the cited `file:line`, and the baseline was confirmed by running the suite (`npx vitest run` → 33 files, 841 tests, all passing). Quotes are from the real code, not from the spec's description of it.

---

## Findings

### CRITICAL Findings

#### [CRIT-001] FR-018's whole-file archival destroys other sessions' plans — `plan.json` is a multi-session map

- **Lens**: Incorrectness / Incompleteness
- **Affected section**: FR-017, FR-018, US-9 (all 4 acceptance scenarios), BDD "A v2 plan is archived byte-identically", SC-005, Impact Assessment ("CRITICAL ordering constraint", spec line 87)
- **Description**: The spec models `plan.json` as *one plan* throughout. It is not. `story.ts:290` sets `this.planPath = join(this.stateDir, "plan.json")` and `persistPlan` (`story.ts:697`) declares `let file: Record<string, PlanV2> = {}` — the file is a **shared map keyed by sessionID**, with **no top-level `schemaVersion`**; the version lives on each per-session value (`story.ts:144`, `schemaVersion: 2` as a literal type). `hydrateFromDisk` reads `parsed[sessionID]` (`story.ts:689`). `clearPlan` (`story.ts:643-670`) already documents this: "a single entry inside the shared multi-session `plan.json` file rather than a whole-file migration."

  Consequently FR-018 ("An on-disk plan with `schemaVersion: 2` MUST be archived to `archive/plan.<ISO-8601>.json` **by atomic rename, byte-identically**") and its BDD assertion ("**Then** `plan.json` no longer exists at the top level") are mutually exclusive with correctness: renaming the whole file away also removes every **v3** entry belonging to every other session that is mid-plan. There is no "the on-disk plan" to archive — there are N of them at potentially mixed versions.
- **Impact**: Operator has two workspaces open (or a stale entry from a prior session). One session upgrades; the archival step renames `plan.json` away wholesale; the second session's live v3 plan — including its wave gate state and receipt bindings — is gone. Its next `getPlan` returns `null` (indistinguishable from "no plan", since `hydrateFromDisk` fails silently with **no logging at all**, `story.ts:674-692`), and its next `persistPlan` writes a file containing only its own reconstructed state. Silent, unrecoverable, and invisible in the event log.
- **Recommendation**: Rewrite FR-018 to be **per-entry**, matching `clearPlan`'s existing shape: for each `[sid, value]` in the parsed map where `value.schemaVersion === 2`, write that entry to `archive/plan.<sid>.<timestamp>.json` (timestamp with `[:.]` replaced by `-`, collision suffix loop) using `flag: "wx"`, then remove only that key and rewrite `plan.json` with the surviving entries. Drop "atomic rename" and "byte-identically" — they are whole-file properties that cannot hold for a per-entry extraction; replace SC-005 with "every key/value pair present in the pre-archival map is present either in `plan.json` or in exactly one archive file, verified by deep equality". State explicitly that mixed v2/v3 maps are the expected case.

---

#### [CRIT-002] Archival is not on every path that reaches `persistPlan` — v2 entries are silently deleted by unguarded mutators

- **Lens**: Incompleteness
- **Affected section**: FR-018 ("before any v3 write"), US-9 AS-1 ("**When** any story-tool method runs"), spec line 87
- **Description**: The spec's own ordering constraint is correct in principle but its trigger is wrong in practice. The precedent it names, `archiveV1IfPresent()`, is called from exactly four sites: `proposePlan` (`story.ts:357`), `createPlan` (`story.ts:374`), `checkScope` (`story.ts:496`) and `checkpoint` (`story.ts:564`). It is **not** called from `attachEvidence` (`story.ts:436`), `amendStory` (`story.ts:455`), or `clearPlan` (`story.ts:643`) — all three of which call `persistPlan`.

  `persistPlan` silently drops every entry failing `isPlanV2` (`story.ts:724-726`: `if (isPlanV2(value)) file[sid] = value`) with **no log and no archive**, and the drop is committed by the very next `atomicWrite`. And `isPlanV2` rejects on hard equality — `story.ts:197`: `if (value.schemaVersion !== 2) return false`. Bump that to `3` and *any* of those three unguarded mutators erases every remaining v2 entry.

  Worse: `attachEvidence` is called from the **checkpoint tool handler** (`tools.ts:170`, `tools.ts:181`) *before* `storyEngine.checkpoint` runs — so the very first checkpoint attempt in an upgraded workspace reaches `persistPlan` through a path with no archival guard.
- **Impact**: The spec's mitigation ("Archival (FR-018) MUST land in the same change as the version bump (FR-017), verified by a test") is satisfiable by a test that only exercises `createPlan`, and would still ship the data-loss bug. A user upgrades, calls `plan_checkpoint` on an in-flight v2 plan, and every other session's v2 plan is deleted from disk with zero diagnostics.
- **Recommendation**: Make archival a precondition of **`persistPlan` itself** (inside the same lock window it already holds, `story.ts:695-741`), not of the public methods — that is the single choke point all writes pass through. Add an FR: "`persistPlan` MUST, while holding the state lock, archive every parsed entry whose `schemaVersion` is not 3 before merging and writing." Add an FR requiring `persistPlan` to log a `story:entry-dropped` event for any entry it discards for any reason, so a future validator change can never again delete data silently. Add a test that drives archival through `attachEvidence` and `amendStory`, not only `createPlan`.

---

#### [CRIT-003] Retaining `getActiveStory` as "first active" (Ambiguity #2) corrupts phase state — and 8 of its 11 call sites have no requirement at all

- **Lens**: Incorrectness / Incompleteness
- **Affected section**: Existing Codebase Context (`getActiveStory` row, "**extends**"), Ambiguity #2, Assumptions ("`getActiveStory` (singular) is retained as 'first active' to bound the blast radius"), FR-025, FR-026, FR-030
- **Description**: The spec's stated mitigation is to keep `getActiveStory` returning `plan.stories.find(s => s.status === "active")` (`story.ts:419-423` — array order, no tie-break) and review call sites "individually but not all converted". Site-by-site verification shows only **one** of eleven tolerates that, and two actively corrupt state:

  | Site | Verdict | Failure |
  |---|---|---|
  | `story.ts:578` `checkpoint` active-guard | **BLOCKER** | Only the array-first active story can be checkpointed; every sibling throws `cannot complete story X: it is not the plan's current active story`. A wave deadlocks before anything else matters. |
  | `tools.ts:200` T8 advance detection | **CORRUPTING** | `if (nowActive && nowActive.id !== args.storyId) phaseEngine.onStoryAdvance(...)`. With N active, this is *always* true — completing B fires a spurious advance to A, and `phase.ts:127-129` unconditionally does `session.phases.set(toStoryId, "execute")`, **force-demoting A out of `elevate`**. Deterministic, every time. |
  | `gate.ts:316` idle close/verifier | **CORRUPTING** | `onIdle` hard-requires `prev === "elevate"` for the one key read (`phase.ts:154`). First story at `execute` → session never closes and the verifier never runs. First story at `elevate` while a sibling is mid-`execute` → premature close and verifier verdict on unfinished work. |
  | `plugin.ts:121` `resolveStoryIdForPhase` | WRONG | Every mutation keys the first story's phase slot; siblings stay frozen at `intake` forever. |
  | `plugin.ts:540` relevance resolution | WRONG | Sibling's green verifier is compared against story A's `verifiers` → false `relevanceGap` → `plugin.ts:628` skips `onVerifierOutcome` entirely; a genuine pass is discarded. |
  | `plugin.ts:618` `coversFinalStory` + `stories[idx+1]` nudge | WRONG | Elevation becomes array-position-dependent; the completion nudge names a story that is already active. |
  | `plugin.ts:748` verify-gap prescription | WRONG | Prescribes one story's suite for wave-wide changed paths; the FR-034 compliance join (`plugin.ts:670-676`) then marks the gap satisfied while siblings are unverified. |
  | `gate.ts:204`, `gate.ts:251` stop/criteria block | WRONG | Same under-prescription; the gate is closed by evidence that does not cover the changes. |
  | `tools.ts:149` `plan_next` | WRONG | Its own description says "Work only that story until checkpointed" while returning 1 of N — a subagent cannot discover its assignment. |
  | `story.ts:497` `checkScope` | WRONG | (covered by FR-026) |
  | `plugin.ts:711` criteria reinject | TOLERABLE | Cosmetic; names 1 of N after compaction. |

  Of these, the spec issues requirements for exactly three: FR-019 (`checkpoint` guard), FR-026 (`checkScope`), FR-030 (`getPhase` determinism). **Eight sites are unspecified.**
- **Impact**: Ships a wave model in which the phase engine is actively corrupted by normal operation (`tools.ts:200` demotes elevated stories; `gate.ts:316` either hangs the session or closes it early), the gates that mint and consume evidence are satisfied by non-covering runs, and `plan_next` cannot describe the wave. These are not degradations that show up under load — they are deterministic on the second story of the first wave.
- **Recommendation**: Resolve Ambiguity #2 as **BLOCKING** and reject the "first active" assumption. Add one FR per unspecified site with explicit union semantics, minimally:
  - `resolveStoryIdForPhase` MUST key the phase slot by the story owning the mutated path (matched against `scopeGlobs`), falling back to a stable deterministic key when no story matches — not to "first active".
  - The relevance and verify-gap resolutions MUST resolve against the **union** of active stories' `verifiers`, and a pass MUST be attributed to the story or stories whose verifiers it covers.
  - `coversFinalStory` MUST be computed from the story the observed verifier covers, not from `getActiveStory`.
  - T8 MUST fire on wave transition only (as the Regression table's own `phase_advance_on_wave_transition` implies), never on "a different story is now active".
  - `onIdle` MUST take a quorum over all active stories' phase slots.
  - `plan_next` MUST return the array of active stories.
  Then add the missing regression tests; the Regression Test Requirements table names `phase_advance_on_wave_transition` but the TDD plan never numbers it (see MAJ-019).

---

#### [CRIT-004] The auto-appended verification story permanently disables the scope watchdog

- **Lens**: Incorrectness
- **Affected section**: FR-007, FR-011, FR-026, US-8 AS-3, BDD "An unconstrained active story makes the wave unconstrained", Scope-union Dataset rows 3–4
- **Description**: Three requirements compose into a defect the spec does not notice:
  1. FR-007: "`createPlan` MUST append exactly one `kind: "verification"` story to **every** wave, authored by the plugin."
  2. FR-011: "`createPlan` MUST set `status: "active"` … on **every story in wave 1**." (BDD "A verification story cannot be delivered" confirms verification stories are active: "**Given** a wave whose verification story **is active**".)
  3. FR-026: "`checkScope` MUST match … returning `null` when **any** active story declares empty `scopeGlobs`."

  The plugin-authored verification story is described nowhere as carrying `scopeGlobs`; its acceptance items name delivery stories (FR-008), and FR-054's "verifiers or scopeGlobs" bar is scoped to *delivery* stories. So every wave contains an active story with `scopeGlobs: []`, and FR-026 therefore returns `null` for **every path, in every wave, always**.
- **Impact**: The scope watchdog — an existing shipped control (`story.ts:491-510`, `plugin.ts:517-527`) — is silently and permanently disabled by this feature. US-8 exists specifically to make the watchdog work under waves and instead deletes it. Every one of US-8's tests (`check_scope_unions_active_globs`, `check_scope_flags_outside_union`) would pass on a synthetic two-story fixture that omits the verification story, and fail to catch this in any realistic plan.
- **Recommendation**: Pick one and state it as an FR: (a) verification stories are excluded from the `checkScope` union entirely; or (b) verification stories inherit the union of their wave's delivery-story `scopeGlobs`; or (c) verification stories are not `active` until every delivery story in their wave is `delivered` (which also removes them from `getActiveStories` noise and simplifies FR-022). Option (c) is the cleanest and makes "delivered-but-unverified" (US-6) a first-class state. Whichever is chosen, add a scope-union dataset row whose fixture is a **real** `createPlan` output including the synthesised verification story, not a hand-built story array.

---

#### [CRIT-005] FR-022's wave gate is unsatisfiable — the receipt store is volatile, capped at 20, and wiped by any mutation

- **Lens**: Infeasibility / Incompleteness
- **Affected section**: FR-022, US-4 AS-3, US-5 AS-2, Ambiguity #1, Ambiguity #3, Edge Cases ("A verifier that writes files…", "A subagent that keeps writing…"), SC-007, Evaluation Scenario "Real three-way fanout reaches completion"
- **Description**: FR-022 requires that at the moment the wave's verification story is checkpointed, **every** delivery story in that wave simultaneously holds a valid receipt. Three properties of the shipped store make that a coin flip at best:
  1. **Volatile and session-keyed**: `VerificationReceiptStore` is `private readonly bySession = new Map<string, VerificationReceipt[]>()` (`goals.ts:158`) — pure process memory, never persisted.
  2. **Hard cap of 20**: `this.bySession.set(receipt.sessionID, receipts.slice(-20))` (`goals.ts:175`). The spec's Edge Cases explicitly permit "Model declares 50 stories in wave 1 … no cap imposed by this feature". A 50-story wave needs 50 live receipts; the store keeps 20. The gate is then *provably* unsatisfiable.
  3. **All-or-nothing invalidation on any mutation**: `plugin.ts:485-486` — `if (changedPaths.length > 0) { verificationReceipts.invalidate(sid) }`, and `invalidate` is `this.bySession.delete(sessionID)` (`goals.ts:182`). One `edit`/`write` anywhere destroys **every** receipt for the session. `file.edited` does the same (`plugin.ts:887-891`) — though only when exactly one session is active, an inconsistency of its own.

  Under the sequential v2 model this was tolerable: one story, one receipt, checkpoint immediately. Under waves the agent must accumulate N receipts and hold them all live across N verification runs plus the checkpoint calls. Ambiguity #3 deems this "documented, not prevented" — but that assessment was made for the old model. Under FR-022 it is the main path, not an edge case.
- **Impact**: The realistic sequence — verify S1 (receipt R1), verify S2 (R2), notice S2 needs a one-line fix, edit the file, re-verify S2 (R2′) — leaves **only R2′**. R1 is gone. The wave verification story is then rejected naming S1 (FR-022), S1 must be re-verified, and any fix discovered during *that* pass wipes R2′ again. This is a livelock, and it terminates only by exhausting `maxPlanProgressContinuations` into silence (see MAJ-009). Evaluation Scenario "Real three-way fanout reaches completion" and SC-007 ("3 distinct receipt ids recorded in `plan.json`") would fail on any run where a single fix follows a single verification.
- **Recommendation**: This is blocking and must be resolved in this change, not deferred. Add FRs for: (a) **path-scoped invalidation** — a mutation invalidates only receipts whose covered paths intersect the mutated path (Ambiguity #3 must be re-decided as BLOCKING); (b) **receipt persistence** — receipts referenced by a plan's acceptance items must survive in the state directory, or the wave gate must read evidence from `plan.json`'s attached `{receiptId}` pointers rather than from the live store; (c) a receipt-store capacity FR that is at least `max(stories per wave) + headroom`, or an explicit `createPlan` cap on stories per wave that contradicts the current "no cap imposed" edge case. Until (a) or (b) lands, FR-022 cannot be honestly tested.

---

#### [CRIT-006] Re-validating receipts at idle (FR-038a / US-12 AS-5) livelocks every resumed or restarted session

- **Lens**: Incorrectness
- **Affected section**: FR-038, FR-038a, US-12 AS-5, BDD "An invalidated receipt reopens a complete story", test 54c `invalidated_receipt_reopens_story`, Evaluation Scenario "Interrupted session resumes correctly"
- **Description**: FR-038a gates the verifier on "every acceptance item **carries valid evidence**", and US-12 AS-5 makes an item whose "receipt no longer validates" a deterministic gap that dispatches a `plan-progress` continuation. Validity is `isFreshReceipt` (`tools.ts:92-117`), whose first act is `deps.verificationReceipts.get(sessionID, receiptId)` and `if (!receipt) return false`.

  Because the store is in-memory (CRIT-005), **after any process restart or in any new session, every receipt id in `plan.json` resolves to `null`** — so every acceptance item of every `complete` story is "unevidenced". Note also that `isFreshReceipt` is keyed by `sessionID`: a plan created in session A and resumed in session B can never validate A's receipts even without a restart.
- **Impact**: The spec's own Evaluation Scenario "Interrupted session resumes correctly" produces the opposite of its stated expectation. A genuinely finished plan, resumed in a fresh session, is classified as deterministically incomplete on every idle: `plan-progress` continuations fire naming already-complete stories until `maxPlanProgressContinuations` (default 5) is spent, after which nothing fires at all and the verifier is *still* never invoked (FR-038a blocks it while gaps exist). The user gets five rounds of "finish S1" on a finished plan, then silence. This is a worse failure than D3, and it is introduced by the fix for D3.
- **Recommendation**: Make evidence validity **durable and session-independent** for the idle check, or explicitly scope the re-validation to the session that minted the receipt. Concretely: add an FR that a receipt's *sanitised, persisted* form (workspace root, command, exit code, `observedAt`) is embedded in the acceptance item at attach time — v1 already does exactly this ("the persisted final checkpoint embeds a sanitized copy of observed receipts", `goals.ts:156-157`) — and that the idle check validates against the persisted copy, treating a missing in-memory receipt as "evidence from a previous process", not as "no evidence". Add a test: "a plan completed in session A, hydrated in session B, dispatches zero plan-progress continuations and invokes the verifier exactly once."

---

#### [CRIT-007] The intake gate makes autonomous multi-story work impossible — the exact operation this feature exists to enable

- **Lens**: Inconsistency / Infeasibility
- **Affected section**: US-16, FR-066, FR-067, FR-068, FR-072, Clarifications ("How do we stop the agent rushing into planning…"), versus US-10 ("a long autonomous run ends silently at 20% completion"), US-12, US-14, SC-014
- **Description**: FR-066/FR-067/FR-068 make `plan_create` reject unless (a) an intake record exists, (b) a `confirmedByMessageId` is supplied, (c) it resolves via `isUserMessage` to a real `role: "user"` message, and (d) that message **postdates the proposal**. FR-072 exempts only asks matching `TRIVIAL_ASK_RE` (`story.ts:777`), which matches typo fixes, `rename X to Y`, questions, `read/show/open/print/explain/describe`, and `bump/pin X to Y` — i.e. essentially nothing that would ever be multi-story.

  So: **every** multi-story ask requires a fresh human message after the agent proposes, before a plan can exist. But the entire justification for this spec is unattended operation — the field session is described as "a 1h34m live session … 93 messages, **2 user messages all session**" (D4), and US-10's stated purpose is "a long autonomous run ends silently at 20% completion". With no human present to send the confirming message, `plan_create` can never succeed, so no plan exists, so FR-046 (plan-progress) has nothing to drive and FR-038 never reaches the verifier. The harness degrades to FR-050's plan-required continuation, capped at 3, then silence.
- **Impact**: US-16 as specified is a hard stop on the feature's headline use case. Shipped together, waves + intake gate = "the harness now refuses to plan autonomous work at all."
- **Recommendation**: Either (a) scope the intake gate to interactive sessions only and define the detection mechanism, or (b) allow a documented autonomous path — e.g. an intake record whose `UNKNOWNS` are all `ASSUMED` with rationale and stated risk (FR-070 already defines that resolution) satisfies the gate without a confirming user message, with the assumptions surfaced in the plan and in the verifier payload. Add an explicit FR stating which sessions the gate applies to and what happens when no user is present. Note that (b) makes FR-067's confirmation requirement conditional, which must then be reflected in the BDD Scenario Outline "Planning is blocked until requirements are understood" and tests 72–75.

---

#### [CRIT-008] `isUserMessage` does not prove *confirmation* — the harness's own continuations are `role: "user"` messages

- **Lens**: Insecurity (Spoofing / Repudiation)
- **Affected section**: FR-067, FR-068, US-16 AS-3/AS-4, FR-070 ("carrying the answering user message id, itself verified via `isUserMessage`"), Clarifications ("the same provenance trick that already secures waivers")
- **Description**: `isUserMessage` (`tools.ts:55-70`) answers exactly one question: *does message `X` in this session have `role === "user"`?* It cannot distinguish a human-authored message from any other message the host records with that role. The harness dispatches its own continuations through `ctx.client.session.prompt({ path: {id: sid}, body: { parts: [{type:"text", text}] } })` (`gate.ts:100-105`) — and the spec itself asserts these are ordinary user-visible messages: FR-065, "Idle corrections MUST continue to be delivered via `session.prompt`, **which is already user-visible**"; and Clarifications, "they already go through `session.prompt` and are visible as real messages."

  If those land as `role: "user"` (which is what "visible as a real message" means on this host), then **the harness's own `[vertex:plan-progress]` continuation satisfies FR-067**. The model need only propose, wait one idle, and cite the harness's continuation id as `confirmedByMessageId`. It postdates the proposal (FR-068 ✓), it resolves via `isUserMessage` (FR-067 ✓), and no human ever confirmed anything. The same hole applies to FR-070's `ANSWERED` resolution: an `UNKNOWNS` entry can be "answered" by a harness message.

  This also weakens the existing waiver path the spec cites as precedent (`tools.ts:178`) — but there the blast radius is one acceptance item; here it is the entire requirements gate.
- **Impact**: The one mechanism the spec calls "non-bypassable" for requirements understanding is bypassable by waiting. Worse, it is bypassable *by the harness itself*, so it will be bypassed on essentially every autonomous run without any adversarial intent.
- **Recommendation**: Add an FR requiring confirmation to be proven against a message that is **both** `role: "user"` **and** not harness-originated. The plugin already tracks its own traffic (`SelfCreatedSessions` / `TrackingSelfCreatedSessions`, `plugin.ts:233-234`, and `state.idleContinuationInFlight`); extend that to record the message ids of every `session.prompt` the harness dispatches, and require `confirmedByMessageId ∉ harnessDispatchedMessageIds`. Additionally require the confirming message to contain content beyond the harness's own continuation prefix (`[vertex:...]`). Add a test: "a harness-dispatched continuation cannot be used as `confirmedByMessageId`."

---

#### [CRIT-009] The D1 covering-verifier rules contradict each other and specify no algorithm — FR-033..FR-037 are not implementable as written

- **Lens**: Ambiguity / Inconsistency
- **Affected section**: FR-033, FR-034, FR-035, FR-036, Ambiguity #7, BDD Scenario Outline "A covering verifier is not a relevance gap" (all 7 rows), SC-011, tests 43–45
- **Description**: The spec correctly diagnoses D1 but its fix is three mutually inconsistent rules over undefined terms.

  **(a) FR-034 contradicts its own example.** FR-034: "An observed verifier with **no path arguments** (a whole-suite command such as `npm test` **or `go test ./...`**) MUST be treated as covering any prescribed verifier for the same toolchain." But `go test ./...` *does* have a path argument. The shipped extractor (`measurement.ts:783-794`) keeps any token containing `.` or `/` after dropping flags and stopwords, so `go test ./...` → `["./..."]`, not `[]`. The definition ("no path arguments") and the example (`go test ./...`) select different code paths. An implementer following the definition produces `gap` for Examples row 1; one following the example produces `no gap`.

  **(b) FR-034 and FR-036/Ambiguity #7 are contradictory.** Ambiguity #7's recorded resolution: "Agent scopes coverage to the **same toolchain/runner**, treating a different runner as non-covering (FR-036)." Examples row 3 requires `npx vitest run tests/lexer.test.ts` (runner: `vitest`) to be covered by `npm test` (runner: `npm`). Under the toolchain rule these are different runners → gap; under FR-034 → no gap. Both are in the same spec, and SC-011 demands 7/7 on the table.

  **(c) "Toolchain" is never defined.** FR-036 requires "an observed verifier for an unrelated toolchain MUST still report a relevance gap", but the spec never says what a toolchain is (first token? binary name? a mapping table?). Today it does not exist as a concept anywhere in the codebase — and note the current implementation would score `npm test` ≡ `cargo build` as **equivalent** (both extract zero path tokens → both `rationale: "none"` → equal empty `matchedPaths` sets), so FR-036 requires *new* machinery, not a relaxation.

  **(d) "Covering" has no defined algorithm over the real token space.** There is **no path normalisation anywhere** — `extractVerifierTargetTokens` does no `./` stripping, no trailing-slash trimming, no Go `...` semantics, no glob expansion, no relative/absolute reconciliation. Deciding that `./...` covers `./internal/auth/...` requires Go package-pattern semantics; row 2 (`go build ./... && go test ./... -count=1` covering `go test ./internal/a/... && go test ./internal/b/...`) additionally requires compound-command parsing, subcommand awareness (`build` vs `test`), and handling `-count=1`, which is **not** in `IGNORED_VERIFIER_FLAGS` (`measurement.ts:692-703`).
- **Impact**: The spec calls D1 "blocking — nothing downstream can function until this is fixed", and then under-specifies the fix so completely that two competent engineers will ship different relevance semantics. Given `relevanceGap` gates receipts, evidence attach, phase progression *and* story completion in one shot (`plugin.ts:562`, `:572`, `:628`, `:643`), getting it wrong in the permissive direction silently accepts unrelated commands as verification.
- **Recommendation**: Replace FR-033..FR-036 with a stated algorithm and a term list. Minimally: (1) define **runner** as the resolved executable after stripping `npx`/`npm run`/`pnpm`/`yarn` wrappers, with an explicit alias table (`npm test` → the manifest's `scripts.test` runner) so row 3 is decided by *resolution*, not by surface form; (2) define **target set** as normalised path tokens, with an explicit normalisation spec (strip leading `./`, strip trailing `/`, expand Go `...` to a directory-prefix predicate, treat a bare-recursive root as ⊤); (3) define **covers** as `runner(observed) ≍ runner(prescribed) ∧ targets(observed) ⊇ targets(prescribed)` where ⊇ is *prefix containment*, not set equality, and ⊤ ⊇ everything; (4) state whether `-count=1` and other unknown flags are ignored or significant, and extend `IGNORED_VERIFIER_FLAGS` accordingly. Then re-derive all 7 Examples rows from the stated algorithm rather than asserting them.

---

#### [CRIT-010] Concurrent checkpoints do not serialise — `acquireStateLock` throws on contention

- **Lens**: Incorrectness
- **Affected section**: Edge Cases — "Concurrent `checkpoint` calls for two stories in the same wave. Expected: **serialised by the existing `.elicify-vertex/` directory lock; both persist**."; Integration Boundaries — Filesystem ("Existing `acquireStateLock()` directory lock (30s staleness reclaim)"); Available Reference Patterns ("All new plan writes use the existing lock; no new locking scheme")
- **Description**: The spec's central concurrency assumption is factually wrong. `acquireStateLock` (`pin.ts:81`) is a synchronous `openSync(..., "wx")` exclusive-create with a 30-second stale reclaim. It has **no wait, no retry, and no queue** — on contention with a fresh lock it **throws**: `elicify-vertex state directory is locked by another process: ${lockPath}`. It is also **not reentrant**, so any nested acquisition from the same process throws too.

  Compounding this, neither `createPlan` nor `checkpoint` holds the lock across its own work. Each takes it twice, disjointly — once inside `archiveV1IfPresent` (released before return) and once inside `persistPlan`. All validation and the in-memory status mutation in `checkpoint` (`story.ts:616-624`) happen **unlocked and before** `persistPlan` can throw, so a failed persist leaves memory and disk divergent, with the in-memory plan reporting a completion the disk does not have.
- **Impact**: The wave model's whole point is concurrent activity. Two checkpoints landing within the same window do not serialise — one throws a lock error to the model, which will interpret it as a checkpoint failure and retry or give up. Meanwhile the thrown path has already mutated in-memory state. Under a wave with 3+ stories being checkpointed in sequence by a single agent this is survivable; under any genuine concurrency (or a second opencode window in the same workspace) it is not. Every test in the plan uses a fresh `mkdtempSync` root and single-threaded calls, so none of this is caught.
- **Recommendation**: Either add an FR making `acquireStateLock` blocking-with-backoff (bounded retry, then throw), or add an FR making `checkpoint`/`createPlan` hold a single lock window across validate → mutate → persist so the "plan is left byte-identical on rejection" guarantee (Behavioral Contract, Error flows) actually holds. Rewrite the Edge Case to state the real behaviour and the chosen remedy. Add a concurrency test that issues two overlapping checkpoints against the same state dir and asserts both succeed — the TDD plan currently has **zero** concurrency tests despite the feature being about concurrency.

---

### MAJOR Findings

#### [MAJ-001] Three sections state the opposite verifier policy from FR-038

- **Lens**: Inconsistency
- **Affected section**: Behavioral Contract (bullets 4 and 5), Ambiguity #6, Assumptions (superseded bullet)
- **Description**: FR-038/FR-038a and US-10's "Deterministic-first ordering (load-bearing)" note establish that the verifier is invoked **only when every deterministic check passes**. Three other sections say the reverse and were evidently not updated:
  - Behavioral Contract: "When the session goes idle with a plan that **is not complete**, the system **invokes the verifier** to assess completion" — exactly what FR-038a forbids.
  - Behavioral Contract: "When the verifier is unavailable and a plan has unfinished stories, the system dispatches a deterministic plan-progress continuation **instead**" — contradicts FR-044, which states there is nothing to fall back to because the deterministic layer already ran.
  - Ambiguity #6, marked **RESOLVED**: "the verifier fires at **every `session.idle` where the plan is incomplete** (FR-038)" — cites FR-038 for its own negation. The Assumptions block repeats it.
- **Impact**: The Behavioral Contract is the section an implementer reads first for the happy path. Following it produces the pre-FR-038 design: verifier on every incomplete idle, deterministic as fallback. That is the cost profile (a 30–90 s verifier call per idle) the FR-038 revision exists to eliminate, and it inverts SC-013a's "0 verifier invocations across the 8 deterministic-gap rows".
- **Recommendation**: Rewrite the two Behavioral Contract bullets to state deterministic-first, and rewrite Ambiguity #6's resolution text to match FR-038.

#### [MAJ-002] FR IDs collide with the shipped `vertex2-spec.md`, whose IDs are referenced throughout the source

- **Lens**: Inconsistency
- **Affected section**: All FRs; Regression Test Requirements ("Final story requires an observed receipt (FR-020)"); Assumptions ("'Non-gating' in **FR-030** means 'cannot substitute for a receipt'")
- **Description**: `docs/vertex2-spec.md` defines FR-001…FR-038 (plus FR-023a, FR-030a, FR-030b, FR-033a), and those identifiers are cited as normative throughout the code: `composer.ts:72` "FR-004's per-family per-turn cap table", `resolve.ts` "FR-009: bounded fallback", `story.ts:586` / `tools.ts` "FR-020: workspace-matching, time-valid receipt", `config.ts` "FR-030b zero-tool subagents", `plugin.ts:670` "FR-034 compliance join". This spec re-uses FR-001…FR-038 for completely different requirements.

  The spec then trips over its own collision twice: the Regression table cites "(FR-020)" meaning the *old* FR-020 (observed receipt), while this spec's FR-020 is the pending-wave checkpoint guard; and Assumptions cites "FR-030" as the verifier's non-gating property, while this spec's FR-030 is `PhaseEngine.getPhase` determinism.
- **Impact**: An implementer reading `// FR-034 compliance join` in `plugin.ts:670` and then reading FR-034 in this spec ("whole-suite command covers any prescribed verifier") will connect two unrelated requirements. Code comments become actively misleading the moment this spec lands.
- **Recommendation**: Renumber this spec's requirements into a non-colliding namespace (e.g. `FRW-001…FRW-075` for "waves"), and fix the two stale cross-references to name the source document explicitly (`vertex2-spec.md FR-020`, `vertex2-spec.md FR-030`).

#### [MAJ-003] The impact assessment excludes two clusters the spec's own requirements modify

- **Lens**: Inconsistency / Incompleteness
- **Affected section**: Cluster Placement ("It does **not** touch the receipt, redaction, **verifier**, or **measurement** clusters"), Existing Codebase Context table, Impact Assessment table
- **Description**: FR-033..FR-037 change the relevance check, which lives in `measurement.ts` (`verifiersEquivalent`, `measurement.ts:824` — the spec cites this line itself in D1). FR-039/FR-040 change the verifier payload and verdict schema, which live in `verifier.ts`: `VerifierPayload` is `{criteria, verifierSummaries, diffSummary}` (`verifier.ts:51`), `VerifierVerdict` is `{fit: "pass"|"concern", notes: string}` (`verifier.ts:309`), enforced by `isVerifierVerdictShape` (`verifier.ts:398-401`) and described by `VERIFIER_SYSTEM_PROMPT` (`verifier.ts:390-394`) — all four must change to carry `complete`/`missing`/`nextAction`, the original ask, story statuses and per-item evidence. Neither `measurement.ts` nor `verifier.ts` appears in the Symbols Involved table or the Impact Assessment table.
- **Impact**: Two modified modules have no risk level, no dependent list, and no regression coverage plan. `measurement.ts:824` in particular has a second consumer the spec never mentions — the FR-034 compliance join at `plugin.ts:670-676`, which decides whether a rendered `verify-gap` directive counts as complied-with. Loosening equivalence to "covering" also loosens that join, so a broad suite run now marks a narrow verify-gap satisfied. That behaviour change is unrequested, unspecified and untested.
- **Recommendation**: Add `verifiersEquivalent` (`measurement.ts:824`), `VerifierPayload`/`VerifierVerdict`/`isVerifierVerdictShape`/`VERIFIER_SYSTEM_PROMPT` (`verifier.ts`) to the Symbols Involved and Impact Assessment tables with dependents and risk levels. Add an explicit FR stating whether the FR-034 compliance join uses the same relaxed predicate or keeps strict equivalence, and a regression test for whichever is chosen.

#### [MAJ-004] `INVOCATION_BUDGET = 2` makes FR-027 and FR-073 unachievable, and FR-073's stated rationale is wrong

- **Lens**: Infeasibility / Incorrectness
- **Affected section**: FR-027, FR-028, FR-073, SC-008, Available Reference Patterns (`DEFAULT_FAMILY_CAPS` row)
- **Description**: The spec treats the composer as if per-family caps and cooldowns were the only limits. They are not: `composer.ts:98` sets `const INVOCATION_BUDGET = 2` — a hard, non-configurable ceiling of **two directives per `system.transform` call**, applied *after* a priority sort (`composer.ts:287-289`). This spec adds `wave-verification` at `correction` (FR-027) and raises `intake-scaffold` to `correction` (FR-073), joining the three existing correction families `verify-gap`, `scope-watchdog` and `anomaly-interrupt` (`findings.ts:18`, `:38`, `:58`). Five correction families, two slots.

  FR-073's rationale — "raised from `phase-guidance`, **so it is not crowded out**" — is factually incorrect. Within a fixed budget of 2, raising priority does not prevent crowding; it changes *who* gets crowded out. The most likely victim is `verify-gap`, the only directive that drives the agent to mint the receipts every other gate in this spec consumes.

  Separately, FR-027's cooldown clause ("MUST NOT be suppressed by cooldown across turns") is a no-op: the default `cooldownTurns` is 1 (`composer.ts:174`) and the guard is `state.turnIndex > lastTurn && state.turnIndex < lastTurn + cooldown` (`composer.ts:271`), which is unsatisfiable at `cooldown === 1`. The spec requires a property the code already has, while missing the property that actually suppresses it.
- **Impact**: SC-008 ("the `wave-verification` finding renders on ≥2 consecutive turns") passes trivially in a test fixture with two findings and fails in production whenever three corrections are live. The mandatory-verification directive — US-6's entire purpose — is silently dropped exactly when the session is busiest.
- **Recommendation**: Add an FR that either raises/derives `INVOCATION_BUDGET` or defines an explicit precedence order among correction families with `wave-verification` and `verify-gap` guaranteed slots. Correct FR-073's rationale. Delete or restate FR-027's cooldown clause. Add a test that renders with all five correction families live and asserts which two survive.

#### [MAJ-005] SC-014 measures the wrong counter — the D4 fix can pass it without improving delivery

- **Lens**: Infeasibility (unmeasurable success criterion)
- **Affected section**: SC-014, US-14, FR-051, test 65 `autonomous_run_directive_delivery_rate`
- **Description**: SC-014 requires "the ratio of `directive_rendered` to `per-turn-cap:dropped` is ≥ 1:3 (measured 5:250 ≈ 1:50 before the fix)". The composer emits **three distinct** drop events: `per-turn-cap:dropped` (`composer.ts:245`), `cooldown:dropped` (`composer.ts:273`) and `budget:dropped` (`composer.ts:292`). Advancing `turnIndex` per reply cycle resets `turnSpend` and therefore converts per-turn-cap drops into **budget** drops — the same findings are still dropped, just under a different event name that SC-014 does not count.
- **Impact**: The criterion can be satisfied by relabelling, with directive delivery unchanged. Since D4 is one of two defects the spec says must land before anything else can be evaluated, a false-positive here invalidates the evaluation of the whole feature.
- **Recommendation**: Restate SC-014 over the sum of all three drop events, or better, over the absolute quantity that matters: "≥1 `directive_rendered` per assistant reply cycle across a 10-cycle autonomous run, with `directive_rendered / (directive_rendered + budget:dropped + per-turn-cap:dropped + cooldown:dropped) ≥ 0.25`."

#### [MAJ-006] FR-051 names no hook and conflicts with two existing `newTurn` call sites

- **Lens**: Ambiguity / Infeasibility
- **Affected section**: FR-051, FR-052, US-14, D4 root cause
- **Description**: FR-051 requires `composer.newTurn` "once per completed assistant reply cycle", but never says which hook detects a completed reply cycle. This matters because `newTurn` already has two call sites and the spec's D4 diagnosis is out of date:
  - `plugin.ts:386` — `chat.message`, only when the turn is genuinely activated.
  - `gate.ts:95` — inside `promptContinuation`, with a comment documenting a *previous* turn-freeze fix: "a real session showed 435 such drops over ~1.5 hours with `turnIndex` stuck at 7."

  FR-052 ("a reentrant `chat.message` produced by a harness continuation MUST NOT advance the turn more than once") describes a de-duplication requirement whose mechanism is also unspecified — today the reentrant `chat.message` is made a no-op by `state.idleContinuationInFlight`, so adding a third call site must coordinate with that flag and with `gate.ts:95` or the turn will advance twice per continuation.
- **Impact**: D4 is 50 % of the "must land first" work and the implementer is given a goal with no mechanism. The likeliest outcomes are (a) no suitable hook is found and FR-051 is quietly dropped, or (b) `newTurn` is added somewhere that double-advances, which resets per-turn caps twice and changes cooldown arithmetic for every existing family.
- **Recommendation**: Name the hook and the guard explicitly. State how "reply cycle completed" is detected on this host (candidates: `event(session.idle)` before the gate runs, or a `message.updated` event with a terminal assistant part) and state the de-duplication key (e.g. the assistant message id), so FR-052 is testable rather than aspirational.

#### [MAJ-007] The multi-session advisory short-circuit silently disables FR-046 and FR-038

- **Lens**: Incompleteness / Incorrectness
- **Affected section**: FR-038, FR-046, FR-050, US-12, SC-012
- **Description**: `handleSessionIdle` returns before any continuation logic whenever more than one session is gate-active — `gate.ts:304-309`:
  ```ts
  const activeSessionIDs = ctx.activeSessionIDs()
  if (activeSessionIDs.length > 1) {
    ctx.logger("gate:multi-session-advisory", { sessionID: sid, activeSessionCount: activeSessionIDs.length })
    state.needsCriteriaReinject = true
    return
  }
  ```
  Every new idle-time requirement in this spec (FR-038 verifier gating, FR-046 plan-progress, FR-050 plan-required) is written as unconditional MUST and would be added downstream of this guard. The spec never mentions it.
- **Impact**: An operator with two opencode sessions active in the same workspace — a normal thing to do while a wave is running — gets zero continuations from the new deterministic driver. The D3 failure mode returns in full, and the event log records only `gate:multi-session-advisory`, which nothing in this spec teaches anyone to look for.
- **Recommendation**: State explicitly whether the new idle requirements run above or below the multi-session guard. If below, add the precondition to FR-038/FR-046/FR-050 and to SC-012. If above, add an FR stating that plan-progress is per-session-safe and a test with two active sessions.

#### [MAJ-008] No in-flight guard on verifier invocation — a 90 s verifier overlaps subsequent idles

- **Lens**: Incompleteness / Infeasibility
- **Affected section**: FR-038, FR-043, FR-049, SC-013a, Assumptions ("Verifier latency is 30–90 s … at most one verifier invocation per idle is acceptable")
- **Description**: `VERIFIER_TOTAL_BUDGET_MS` defaults to `90_000` (`verifier.ts:381`). The existing in-flight guard, `state.idleContinuationInFlight`, is set only *inside* `promptContinuation` (`gate.ts:64-65`) — it does not cover the verifier call itself, which happens earlier in `appendVerifierCloseOut` (`gate.ts:258-293`). Nothing in the spec adds one. FR-049 ("At most one continuation MUST be dispatched per `session.idle`") constrains a single idle's behaviour, not overlapping idles.
- **Impact**: During a 90-second verifier call, further `session.idle` events re-enter `handleSessionIdle`, re-run the deterministic checks (which still pass, since nothing changed), and invoke the verifier again. SC-013a ("the verifier is invoked 0 times — measured as zero `session.create` calls for the `vertex-verifier` agent") and FR-045's cap are both defeated by concurrency rather than by logic, and each concurrent invocation costs a real model call.
- **Recommendation**: Add an FR requiring a per-session verifier-in-flight flag set before `runVerifier` and cleared in a `finally`, with re-entrant idles returning immediately. Add a test that fires two `session.idle` events within the verifier's budget window and asserts exactly one invocation.

#### [MAJ-009] The verifier-failure taxonomy in the spec does not match `VerifierRunResult` — the most likely failure is untested

- **Lens**: Incorrectness / Incompleteness
- **Affected section**: FR-044, US-10 AS-5, BDD Scenario Outline "Verifier failure at close fails open" (Examples: `unsupported` / `timeout` / `malformed`), test 58, SC-013
- **Description**: `runVerifier` returns `{ verdict: null; reason: "unsupported" | "unavailable" | "malformed" }` (`verifier.ts:343`). `"timeout"` is **not** one of them — a probe timeout folds into `"unsupported"` (`verifier.ts:455-459`) and a subturn timeout folds into `"unavailable"` (`verifier.ts:471`, `:488`). The BDD Examples table and SC-013 both enumerate `unsupported` / `timeout` / `malformed`, so `"unavailable"` — the branch that catches every thrown error *and* every subturn timeout, i.e. the most frequent real failure — has no scenario and no test row. FR-044's parenthetical lists four values, mixing the two vocabularies.
- **Impact**: Test 58 asserts fail-open on three rows, one of which (`timeout`) cannot be produced by the real API and will be simulated by stubbing something that does not exist, while the real high-frequency path (`unavailable`) is never exercised. If `unavailable` does not fail open, the session hangs at close and nobody finds out until production.
- **Recommendation**: Change the Examples table and SC-013 to the three real reasons `unsupported` / `unavailable` / `malformed`, and add a note that timeouts surface as `unsupported` (probe) or `unavailable` (subturn). Fix FR-044's parenthetical to match.

#### [MAJ-010] Cap exhaustion produces silent stall — the D3 failure mode, delayed by five idles

- **Lens**: Incompleteness
- **Affected section**: FR-045, FR-047, FR-050, US-12 AS-2, BDD "Plan-progress continuations are capped"
- **Description**: FR-047 caps `plan-progress` at 5 per plan; FR-045 caps verifier continuations at 3 per session; FR-050 caps plan-required at 3. FR-038a forbids invoking the verifier while any deterministic gap exists. Compose them: once `maxPlanProgressContinuations` is spent on a still-incomplete plan, the deterministic layer is silent **and** the verifier remains blocked. Nothing fires. No requirement says anything is logged, toasted, surfaced to the operator, or written to the plan.
- **Impact**: This is precisely D3 — "a long autonomous run ends silently at 20 % completion" — reproduced by design, with a five-idle delay. Given CRIT-006, a *finished* plan resumed in a new session reaches this state on the sixth idle.
- **Recommendation**: Add an FR: when any continuation cap is exhausted with the plan still incomplete, the system MUST log a distinct terminal event (e.g. `plan:driver-exhausted`) naming the outstanding stories, MUST emit a `warning`-variant toast under FR-061's health/failure class, and MUST include the exhaustion state in `plan_status` output. Add it to the FR-061 health/failure list and to test 69's cases.

#### [MAJ-011] FR-049's "at most one continuation per idle" defines no precedence among six triggers

- **Lens**: Ambiguity
- **Affected section**: FR-049, FR-046, FR-050, FR-041, US-12 AS-4, BDD "Verifier and plan-progress never double-dispatch"
- **Description**: After this change there are six continuation sources: promise-no-act (`gate.ts:184`), zero-criteria stop-block (`gate.ts:207`), criteria replay (`gate.ts:254`), verifier (`gate.ts:288`), plan-progress (FR-046) and plan-required (FR-050). FR-049 mandates mutual exclusion but specifies only one ordering relation — deterministic before verifier (FR-038). The relative order of plan-progress versus promise-no-act, stop-block and criteria-block is undefined, and today `handlePromiseNoAct` short-circuits the whole tree (`gate.ts:313`).
- **Impact**: Two engineers produce different behaviour on the most common idle in the system. If promise-no-act keeps priority, plan-progress never fires in any session where the model uses deferral language — which is the majority of long runs — and D3 is only partly fixed. The single BDD scenario ("Verifier and plan-progress never double-dispatch") covers one of the fifteen pairs.
- **Recommendation**: Add an explicit ordered precedence list to FR-049 covering all six triggers, and a Scenario Outline with one row per adjacent pair asserting which fires.

#### [MAJ-012] Continuation-cap and no-progress state has no specified storage — "per plan" caps live in per-process memory

- **Lens**: Ambiguity / Incompleteness
- **Affected section**: FR-045, FR-047, FR-050, Ambiguity #9, Ambiguity #10
- **Description**: FR-047 scopes its cap "**per plan**", FR-045 and FR-050 "per session". The only comparable state today is `V2SessionState` (`wiring/state.ts:34-123`), which is an in-memory `Map` rebuilt on every process start, and whose `criteriaBlocks` counter is additionally reset every turn by `resetTurnState` (`state.ts:148`). A "per plan" cap implies persistence in `plan.json`; a "per session" cap implies `V2SessionState`. The spec picks neither. The same gap applies to FR-045's no-progress detector, which must remember the previous verdict's `missing` set and an evidence-progress signal across idles.
- **Impact**: If the caps live in memory, every restart resets them, so a livelocking plan (CRIT-006) re-arms its five continuations forever. If they live in `plan.json`, they are a schema addition that FR-001/FR-002/FR-003 do not mention and `isPlanV2` will not validate.
- **Recommendation**: State the storage location for each cap and for the no-progress comparison state; if any of it belongs in `plan.json`, add the fields to the v3 schema FRs and to the validator requirements in FR-017.

#### [MAJ-013] No mechanism creates or stores an intake record

- **Lens**: Incompleteness
- **Affected section**: US-16, FR-066, FR-069, FR-070, FR-071, tests 72–79
- **Description**: FR-066 rejects `plan_create` "when no intake record exists **for the session**". FR-069–FR-071 specify the record's *contents* and *validation*. Nothing specifies how one comes into existence: there is no tool (the registered set is `plan_create`/`_next`/`_checkpoint`/`_status`/`_clear`, `tools.ts:231-235`), no hook, no file, no schema, and no storage location. "The proposal" — whose timestamp FR-068 compares against — is likewise never defined as an artefact.
- **Impact**: FR-066 as written is a gate on a thing that cannot be produced, so `plan_create` would reject unconditionally for every non-trivial ask. The 8 intake tests (72–79) cannot be written against a nonexistent surface.
- **Recommendation**: Add FRs for an `elicify_vertex_intake_record` tool (arguments matching FR-069's fields), its persistence location and schema, its validator, and the definition and recording of "the proposal" timestamp used by FR-068. Add the new tool name to `KNOWN_TOOL_NAMES` (`config.ts:71-95`) — see MAJ-021.

#### [MAJ-014] How the wave verification story's acceptance items acquire evidence is unspecified

- **Lens**: Ambiguity
- **Affected section**: FR-008, FR-022, Ambiguity #1, US-4 AS-3, BDD "Wave verification rejects while a delivery story lacks a receipt"
- **Description**: FR-008 gives the verification story one acceptance item per delivery story. FR-022 states the *wave-level* precondition (every delivery story `complete` with a valid receipt). But `checkpoint`'s existing evidence loop (`story.ts:587-612`) independently requires **every acceptance item of the story being checkpointed** to carry `{receiptId}` or a valid waiver, and the synthesised items start at `evidence: null`. So there are two overlapping gates and the spec defines only one. Ambiguity #1 records the intent ("assert existing per-delivery-story receipts, no fresh run") but no requirement says whether: (a) the model must re-cite each delivery story's receipt id in the verification checkpoint's `items` array; (b) the engine auto-binds them; or (c) verification stories are exempt from the per-item loop and validated solely by FR-022.
- **Impact**: Option (a) is what an implementer touching nothing would get, and it fails the moment a receipt has been invalidated (CRIT-005) with an error naming an acceptance item rather than the story FR-022 promises to name. Option (b) requires new engine code nobody specified. The BDD scenario asserts a rejection *message* ("naming S2 specifically") that only option (c) naturally produces.
- **Recommendation**: Resolve Ambiguity #1 as **BLOCKING** and add an FR choosing one option explicitly, plus an FR stating precisely which check produces the rejection message that US-4 AS-3 asserts.

#### [MAJ-015] `finalStoryId` semantics under waves are undefined, and `isPlanV2` requires it to be valid

- **Lens**: Incompleteness
- **Affected section**: FR-007, FR-017, US-4 AS-4, BDD "Completing the final wave finishes the plan"
- **Description**: `PlanV2.finalStoryId` is mandatory and validated (`story.ts:203`: must be a string **and** a member of the story-id set), assigned as `stories[stories.length - 1].id` (`story.ts:404`), and consumed in four places — `story.ts:586` (`isFinal` switches on the mandatory-observed-receipt rule), `plugin.ts:121` and `gate.ts:322` (phase-key fallback when no story is active), `plugin.ts:619` (`coversFinalStory`). This spec appends verification stories (FR-007) without saying where in the array, and never states what `finalStoryId` means under waves.
- **Impact**: If verification stories are appended per wave in array order, `stories[last]` is the final wave's verification story — probably the intent, but unstated, and it silently changes `isFinal` semantics for `checkpoint`. If they are inserted adjacent to their wave, `finalStoryId` becomes an arbitrary delivery story and `coversFinalStory` breaks. Either way `hydrateFromDisk` rejects any v3 plan whose `finalStoryId` is not in the id set, returning `null` indistinguishably from "no plan" (`story.ts:689-691`, no logging).
- **Recommendation**: Add an FR: "`finalStoryId` MUST be the final wave's verification story id," plus an FR stating the array ordering of synthesised verification stories relative to their wave's delivery stories, since three consumers depend on array position.

#### [MAJ-016] "`plan.json` is byte-identical on rejection" is false in the current code path

- **Lens**: Incorrectness
- **Affected section**: Behavioral Contract Error flows ("the system rejects it and leaves the plan byte-identical"), BDD "A delivered story cannot complete without evidence" ("**And** `plan.json` is byte-identical to its pre-call contents"), Integration Boundaries ("the plan file is left byte-identical (validation precedes mutation)"), test 31
- **Description**: The checkpoint **tool handler** attaches evidence before validating: `tools.ts:165-186` loops over `args.items` calling `storyEngine.attachEvidence(...)` — which mutates and calls `persistPlan` (`story.ts:436-445`) — and only then calls `storyEngine.checkpoint(...)`. When `checkpoint` throws, the evidence attachments are already on disk. `story.ts`'s own doc comment at 557-559 makes the same false claim.
- **Impact**: Test 31 (`checkpoint_rejects_without_evidence_plan_unchanged`) is specified as verifying an existing guarantee that does not hold, so it fails on day one and will most likely be "fixed" by weakening the assertion. Meanwhile the real defect — partial evidence persisted from a rejected checkpoint, which a later checkpoint can then satisfy without a fresh receipt — stays.
- **Recommendation**: Add an FR requiring the checkpoint tool to validate all evidence *before* attaching any of it (or to attach into a staged copy committed only on success), and mark test 31 as covering a **new** guarantee rather than a preserved one.

#### [MAJ-017] The spec's covering-verifier examples do not match the real comparison the code performs

- **Lens**: Incorrectness
- **Affected section**: US-11, FR-033–FR-037, BDD Examples table, SC-010, SC-011
- **Description**: Every example is framed as "prescribed verifier vs observed verifier", implying the prescribed side is the story's declared `verifiers`. In the real call path it usually is not. `plugin.ts:536-545` computes `resolution = resolveVerifier({ changedPaths: realChangedPaths, storyVerifiers: activeStory?.verifiers ?? null }, { readManifest: () => manifest })` and compares `resolution.command`. With a real manifest, `resolveVerifier` can return tier-2 (`npx vitest run <files>`, `resolve.ts:207`) or tier-3 (`npm test -w <root>`, `resolve.ts:173`) commands that the story never declared. Meanwhile the comparison *inside* `verifiersEquivalent` re-resolves both sides with **synthetic** paths and `readManifest: () => null` (`measurement.ts:837`), so the two sides are never evaluated on the same footing.
- **Impact**: SC-010 ("replaying the 25 recorded bash calls … yields ≥3 minted receipts") is the spec's headline D1 proof, and it will be evaluated against a prescribed command the examples table never models. A fix validated only against the 7 table rows can still fail the replay.
- **Recommendation**: Restate the examples in terms of the actual comparison (`resolution.command` vs observed command) and add rows covering tier-2 and tier-3 resolutions (`npx vitest run tests/x.test.ts` and `npm test -w packages/a` as the *prescribed* side). State whether `verifiersEquivalent` should receive the real manifest.

#### [MAJ-018] Toast content is never required to be redacted

- **Lens**: Insecurity (Information Disclosure)
- **Affected section**: FR-059, FR-061, FR-063, SC-017, US-15
- **Description**: FR-059 requires a toast "summarising that directive's **family and prescription**". Prescriptions are built from resolved commands and changed paths and can embed arbitrary command strings. The system-prompt path is protected — `composer.render` passes the assembled envelope through `redactSecrets` (`composer.ts:323`) — but the toast is constructed from the `Finding` before that step, and no FR requires redaction on it. FR-061's health/failure toasts are worse: `verify:relevance-gap` carries `observedCommand` (`plugin.ts:547-551`), which is raw user/model shell input.
- **Impact**: A command containing a token (`curl -H "Authorization: Bearer …"`, `npm test --token=…`) is redacted out of the model's context and then rendered verbatim in a TUI toast — and toasts are the one channel explicitly designed to be *seen and screenshotted*. SC-017 proves only that the model's input is unaffected by visibility; it says nothing about what the toast shows.
- **Recommendation**: Add an FR: "Toast `title` and `message` MUST be passed through `redactSecrets` before dispatch, and MUST be truncated to a stated length." Add a test asserting a secret-bearing prescription is redacted in the toast, and add the assertion to test 66.

#### [MAJ-019] No rollback path or kill switch for the v3 bump or the wave model

- **Lens**: Inoperability
- **Affected section**: US-9, FR-017, FR-018, Assumptions ("The operator explicitly declined migration and backward compatibility"), FR-057
- **Description**: The spec provides a config toggle for the *cosmetic* feature (`visibility`, FR-057, plus `VERTEX_VISIBLE=0` and a slash command) and none for the two changes that can break a workspace: the schema bump and the wave gate. Once a plan is archived and rewritten at v3, reverting the plugin to the previous version leaves an unreadable archive and no live plan — `hydrateFromDisk` returns `null` with no log, and the user sees "no plan" with no explanation. There is no `VERTEX_WAVES=0`, no way to disable the intake gate that blocks `plan_create` (CRIT-007), and no way to disable the new idle continuations if they livelock (CRIT-006).
- **Impact**: Every CRITICAL in this review is a "user is stuck with no escape hatch" scenario. The one existing escape hatch, `/elicify-vertex-plan-clear`, throws away the plan entirely.
- **Recommendation**: Add FRs for (a) an env/config kill switch for the intake gate and for the new idle continuation drivers, defaulting on but overridable; (b) a documented downgrade procedure (restore the archived entry into `plan.json`); (c) a `story:schema-mismatch` event logged by `hydrateFromDisk` whenever an entry parses but fails validation, so "no plan" and "wrong version" are distinguishable in the field.

#### [MAJ-020] Traceability defects: mis-numbered `Traces to`, two FRs with no acceptance scenario, four untraced regression tests, and an understated SC-006

- **Lens**: Inconsistency
- **Affected section**: BDD Scenarios (US-10 and US-12 groups), Regression Test Requirements, SC-006, Traceability Matrix "Completeness check"
- **Description**: Concrete defects:
  1. Three consecutive US-10 BDD scenarios are off by one: "A `complete: false` verdict drives a continuation" traces to **AS-2** (should be AS-3); "A `complete: true` verdict permits close" traces to **AS-3** (should be AS-4); "A fully complete plan still receives a quality verdict" traces to **AS-4**, which is about `complete: true`.
  2. **FR-043** (verifier still runs once for quality on a complete plan) has no acceptance scenario in US-10 — only a mis-traced BDD scenario.
  3. **FR-049** (at most one continuation per idle) has no acceptance scenario; its BDD scenario traces to US-12 AS-4, which is about blocked stories.
  4. Four tests are required by the Regression Test Requirements table — `clear_plan_works_on_v3`, `verifier_fires_on_final_wave_verification`, `wave_verification_uncapped_across_turns`, `phase_advance_on_wave_transition` — and appear in **neither** the Test Implementation Order (1–79 + 54a/b/c) **nor** the Traceability Matrix.
  5. **SC-006** requires "≥42 new tests" against a TDD plan of 82. A criterion satisfiable at half the planned coverage is not a gate.
  6. The **Completeness check** claims verification only for "FR-001 … FR-032" — 43 of the 76 FRs are unclaimed.
- **Impact**: Items 1–3 mean an implementer wiring tests from `Traces to` back-references lands them against the wrong criteria. Item 4 means four regression tests protecting existing shipped behaviour have no owner. Item 5 lets the change ship at half coverage and still pass its own success criteria.
- **Recommendation**: Fix the three back-references; add acceptance scenarios for FR-043 and FR-049; number the four regression tests into the implementation order and the matrix; raise SC-006 to "all 82 planned tests plus the 4 regression tests"; extend the completeness check to FR-075.

#### [MAJ-021] New tool and command surface is not registered

- **Lens**: Incompleteness
- **Affected section**: FR-012 (`elicify_vertex_plan_deliver`), FR-064 (`/elicify-vertex-visibility`), MAJ-013's intake tool
- **Description**: `config.ts:71-95` maintains `KNOWN_TOOL_NAMES`, which enumerates the plugin's own tools (`elicify_vertex_plan_create`, `_next`, `_checkpoint`, `_status`, `_clear`) for the subagent deny map, and `planSlashCommands()` (`tools.ts:248-256`) registers the command surface. Neither `plan_deliver` nor the visibility command nor any intake tool is mentioned anywhere in the spec's registration requirements, and the Symbols Involved table lists `buildPlanTools` only.
- **Impact**: A `plan_deliver` absent from `KNOWN_TOOL_NAMES` is not covered by the static deny map that partially backstops FR-030b zero-tool subagents — meaning a `vertex-verifier`/`vertex-intake` subagent could, on a host that honours the `tools` map, reach a tool that mutates the plan. The command surface simply will not appear.
- **Recommendation**: Add an FR requiring every newly registered tool name to be added to `KNOWN_TOOL_NAMES` and every new slash command to `planSlashCommands()`, with a test asserting the registered tool set equals the deny-map set.

---

### MINOR Findings

#### [MIN-001] US-1 AS-3's "preserving relative order" contradicts the normalisation dataset
- **Lens**: Ambiguity
- **Affected section**: US-1 AS-3, FR-005, Wave normalisation dataset rows 5 and 11
- **Description**: AS-3 says waves normalise "preserving relative order", which reads as array order. Dataset row 5 (`[5,1] → [2,1]`, "ordering by declared value, not array position") and FR-005 ("ordered by declared value, preserving relative order **within a wave**") say otherwise.
- **Recommendation**: Restate AS-3 as "ordered by declared wave value, with array order preserved among stories sharing a wave".

#### [MIN-002] FR-001's "positive contiguous integer" is contradicted by datasets accepting `0` and `-1`
- **Lens**: Inconsistency
- **Affected section**: FR-001, FR-006, dataset rows 8 (`[0] → [1]`) and 9 (`[-1,1] → [1,2]`)
- **Description**: FR-006 rejects only non-integers. The datasets accept zero and negatives as legal *declared* values. FR-001's "positive" applies post-normalisation but reads as an input constraint.
- **Recommendation**: Split into two requirements: declared `wave` MUST be an integer (any sign); normalised `wave` MUST be a contiguous positive ordinal starting at 1.

#### [MIN-003] The archive filename in FR-018 conflicts with the existing naming convention
- **Lens**: Inconsistency
- **Affected section**: FR-018, US-9 AS-1, BDD "A v2 plan is archived byte-identically"
- **Description**: FR-018 specifies `archive/plan.<ISO-8601>.json`. A raw ISO-8601 string contains `:` characters. Both existing archival paths replace them: `archiveV1IfPresent` uses `new Date().toISOString().replace(/[:.]/g, "-")` (`story.ts:334`) and `clearPlan` does the same plus a sessionID segment, producing `plan.<sessionID>.<timestamp>.json` (`story.ts:652`).
- **Recommendation**: Specify the filename as `plan.<sessionID>.<timestamp>.json` with `[:.]` replaced by `-`, matching both precedents (and CRIT-001's per-entry requirement).

#### [MIN-004] FR-010's disjointness test is undefined when a story declares no `scopeGlobs`
- **Lens**: Ambiguity
- **Affected section**: FR-010, US-1 AS-4
- **Description**: FR-054 permits a delivery story to declare `verifiers` **instead of** `scopeGlobs`. Two stories where one has `scopeGlobs: []` are vacuously disjoint, vacuously overlapping, or undefined depending on the implementer.
- **Recommendation**: State that the over-serialisation check is skipped when either story has empty `scopeGlobs`.

#### [MIN-005] FR-027's cooldown clause requires a property the composer already has
- **Lens**: Incorrectness
- **Affected section**: FR-027, SC-008
- **Description**: The default `cooldownTurns` is 1 (`composer.ts:174`) and the suppression guard is `state.turnIndex > lastTurn && state.turnIndex < lastTurn + cooldown` (`composer.ts:271`), which cannot be true at `cooldown === 1`. Cooldown never suppresses an unlisted family across turns.
- **Recommendation**: Delete the cooldown clause (the real suppressor is the invocation budget — see MAJ-004) or restate it as "MUST NOT be added to the `cooldowns` table".

#### [MIN-006] No test asserts the toast `variant` that FR-061 requires
- **Lens**: Incompleteness
- **Affected section**: FR-061, US-15 AS-4, test 67
- **Description**: FR-061 requires health/failure toasts to carry variant `warning` or `error`. `TuiShowToastData.variant` is a required field of the SDK call (`"info" | "success" | "warning" | "error"`). The mode×event Scenario Outline asserts only emitted/not-emitted across 9 rows; no scenario or test checks the variant.
- **Recommendation**: Add a variant column to the Examples table and an assertion to test 67.

#### [MIN-007] Test 71's traced BDD scenario does not concern its FR
- **Lens**: Inconsistency
- **Affected section**: Test 71 `idle_correction_visible_without_toast`, FR-065
- **Description**: Test 71 traces to "Scenario: An incomplete plan at idle dispatches a plan-progress continuation", which asserts nothing about visibility. FR-065's claim (idle corrections are visible via `session.prompt` alone) has no scenario of its own.
- **Recommendation**: Add a BDD scenario for FR-065 asserting that an idle continuation emits no toast and is present as a session message.

#### [MIN-008] Dataset row "complete on an already-`complete` story" has no requirement
- **Lens**: Incompleteness
- **Affected section**: Checkpoint transitions dataset row 9, FR-019
- **Description**: FR-019 permits checkpoint on `"active"` or `"delivered"`, implying rejection elsewhere, but no requirement states the double-complete rejection or its message. `checkpoint`'s existing guard is being replaced, so the behaviour is not inherited.
- **Recommendation**: Add an explicit FR for rejecting a checkpoint on a `complete` or `blocked` story, naming the story and its current status.

#### [MIN-009] `file.edited` receipt invalidation is inconsistent with the tool-path invalidation
- **Lens**: Incompleteness
- **Affected section**: Edge Cases ("A subagent that keeps writing after the wave is marked delivered")
- **Description**: The edge case asserts "`file.edited` invalidates receipts". It does — but only when exactly one session is gate-active: `plugin.ts:888-891` guards on `if (active.length === 1)`. The `tool.execute.after` path (`plugin.ts:485-486`) has no such guard. The spec relies on this behaviour without noting the asymmetry.
- **Recommendation**: State the precondition in the edge case, or add an FR normalising the two invalidation paths.

---

### Observations

#### [OBS-001] US-15 (visibility/toasts) is an unrelated feature and should be its own spec
- **Lens**: Overcomplexity
- **Suggestion**: FR-057–FR-065 introduce a config mode, a slash command, a rate limiter, a dedupe key, a summary toast and 6 tests, and interact with the wave model **not at all** (SC-017 explicitly proves the model's input is unchanged). It is a clean, independently shippable observability change. Splitting it removes ~20 % of the spec's surface from the schema-bump blast radius and lets it ship first, where it would actually help diagnose the other five workstreams.

#### [OBS-002] `delegation-gap` (US-7) costs four tests and two requirements to change nothing
- **Lens**: Overcomplexity
- **Suggestion**: The spec states the check "is trivially gameable" (US-7), "never blocks" (FR-029), and "silently stops firing" if the host renames `task` (Assumptions). Removing it changes no external behaviour for any stated requirement. Consider deferring it until the wave model has field data showing serial execution is actually the problem.

#### [OBS-003] Wave normalisation over negatives, zero and `1e6` is speculative generality
- **Lens**: Overcomplexity
- **Suggestion**: Dataset rows 5, 8, 9 and 11 specify behaviour for declared waves of `-1`, `0`, `5`-out-of-order and `1000000`. The model authors these values; a plain "`wave` MUST be an integer ≥ 1, otherwise reject naming the story" is simpler, produces a better error, and removes four dataset rows plus the value-sort. The gap-closing case (`[1,1,3] → [1,1,2]`) is the only one with a real motivation.

#### [OBS-004] Five independent loop-limiting mechanisms
- **Lens**: Overcomplexity
- **Suggestion**: `maxVerifierContinuations`, `maxPlanProgressContinuations`, `maxPlanProposalContinuations`, `maxCriteriaBlocks` and the `verifier:no-progress` detector all bound the same thing: how many times the harness may re-prompt before giving up. Ambiguity #10 raises this and the spec keeps them independent. A single per-session continuation budget with per-family sub-quotas would be one number to reason about, one place to log exhaustion (MAJ-010), and one thing to explain in a runbook.

#### [OBS-005] The spec states D1/D4 must land first but defines no phasing
- **Lens**: Inoperability
- **Suggestion**: The final Clarification says "D1 and D4 block evaluation of everything else … both should land before the wave model is built on top of them." Nothing in the FRs, TDD plan or success criteria encodes that ordering, and the schema bump makes the change atomic. Consider splitting into three shippable increments — (1) D1 + D4 + visibility (no schema change, immediately measurable via SC-010/SC-014/SC-020); (2) waves + schema v3; (3) idle driver + intake — each with its own grill-spec pass.

---

## Structural Integrity

### Variant A: Plan-Spec Format

| Check | Result | Notes |
|-------|--------|-------|
| Every user story has acceptance scenarios | **PASS** | All 16 user stories carry ≥3 acceptance scenarios. |
| Every acceptance scenario has BDD scenarios | **FAIL** | US-10 AS-4 and AS-6/AS-7 are covered only via mis-traced scenarios (MAJ-020). US-15 AS-4's variant requirement has no scenario (MIN-006). FR-043 and FR-049 have no acceptance scenario at all. |
| Every BDD scenario has `Traces to:` reference | **PASS (with defects)** | All 65 scenarios carry the field; three US-10 references are off by one and one US-12 reference is wrong (MAJ-020). |
| Every BDD scenario has a test in TDD plan | **PASS** | All 65 map into the 82-entry implementation order. |
| Every FR appears in traceability matrix | **PASS** | FR-001…FR-075 plus FR-038a all present. |
| Every BDD scenario in traceability matrix | **PASS** | Verified by inspection. |
| Test datasets cover boundaries/edges/errors | **FAIL** | Four datasets, all single-dimension. **Zero concurrency tests** in a spec about concurrency (CRIT-010). No dataset for the covering-verifier normalisation space beyond the 7 BDD rows (CRIT-009). No dataset for receipt-store capacity or invalidation (CRIT-005). No dataset for cross-session/restart receipt resolution (CRIT-006). No dataset for composer budget contention (MAJ-004). No intake-record dataset beyond the 7 "missing element" rows. |
| Regression impact addressed | **FAIL** | The table is good as far as it goes, but four of its required tests are untraced and unnumbered (MAJ-020), and two whole modified modules (`verifier.ts`, `measurement.ts`) are excluded from the impact assessment entirely (MAJ-003). The FR-034 compliance join — a second consumer of the function FR-033 changes — is not listed as affected. |
| Success criteria are measurable | **FAIL** | SC-006 (`≥42 new tests` against 82 planned) and SC-014 (counts one of three drop-event types) are satisfiable without achieving their intent. SC-011 demands 7/7 on an Examples table whose rows contradict each other (CRIT-009). SC-013a is defeatable by concurrent idles (MAJ-008). SC-007 and the fanout evaluation scenario are unreachable given CRIT-005. |

---

## Test Coverage Assessment

### Missing Test Categories

| Category | Gap Description | Affected Scenarios |
|----------|----------------|-------------------|
| **Concurrency** | Not one test in 82 exercises two simultaneous operations, in a feature whose premise is concurrent execution. `acquireStateLock` throws on contention (CRIT-010) and would be caught immediately. | Edge Case "Concurrent `checkpoint` calls"; all of US-1, US-3, US-4 |
| **Cross-session / restart** | No test hydrates a plan in a different session or process from the one that minted its receipts. This is where CRIT-006's livelock lives, and the spec's own Evaluation Scenario "Interrupted session resumes correctly" depends on it. | US-12 AS-5, FR-038a, test 42 `wave_gate_survives_process_restart` (covers statuses only, not evidence) |
| **Receipt lifecycle** | No test covers the 20-receipt cap, invalidation-on-mutation during a verification batch, or N-receipts-live-simultaneously. | FR-022, US-4 AS-3, SC-007 |
| **Composer contention** | No test renders with more correction-priority findings than `INVOCATION_BUDGET`. | FR-027, FR-073, SC-008 |
| **Multi-entry `plan.json`** | Every story test uses a fresh `mkdtempSync` root with one session. Nothing exercises a `plan.json` containing 2+ sessions at mixed schema versions — the exact shape CRIT-001/CRIT-002 destroy. | FR-017, FR-018, US-9, SC-005 |
| **Negative security tests** | No test attempts to satisfy `confirmedByMessageId` with a harness-dispatched continuation (CRIT-008), or to pass an intake gate without a human. | FR-067, FR-068, FR-070 |
| **Idempotency under failure** | `deliver_is_idempotent` exists; there is no equivalent for a checkpoint that throws after `attachEvidence` has persisted (MAJ-016). | FR-014, FR-019, test 31 |

### Dataset Gaps

| Dataset | Missing Boundary Type | Recommendation |
|---------|----------------------|----------------|
| Wave normalisation | Empty story list; `NaN`/`Infinity`/string `"1"` as `wave`; duplicate ids | Add rows; `createPlan` already throws on an empty list (`story.ts:375`) and `isPlanV2` rejects duplicate ids (`story.ts:201`) — both should be asserted. |
| Checkpoint transitions | Receipt evicted by the 20-entry cap; receipt invalidated between attach and checkpoint; checkpoint on a story from a different session's plan | Add rows exercising CRIT-005's failure modes explicitly rather than through the happy path. |
| Scope union | A wave including its **synthesised** verification story (not a hand-built array) | Add; this is the fixture that surfaces CRIT-004. |
| Wave gate progression | Two concurrent waves' stories interleaved; a wave with zero delivery stories after normalisation | Row 6 covers the single-wave case; the empty-wave edge case in the prose has no dataset row. |
| Covering verifier | Tier-2/tier-3 resolver outputs as the *prescribed* side; `pytest -k foo`; quoted `|` inside an argument; `-count=1` and other unlisted flags | Add; the current 7 rows all assume the prescribed side is a story-declared verifier (MAJ-017). |
| Intake record | No dataset at all for `confirmedByMessageId` provenance | Add rows: harness-dispatched message; assistant message; message from a different session; message predating the proposal by 1 ms. |

---

## STRIDE Threat Summary

| Component | S | T | R | I | D | E | Notes |
|-----------|---|---|---|---|---|---|-------|
| Intake gate (`plan_create` precondition, FR-066–FR-071) | **risk** | **risk** | **risk** | ok | **risk** | ok | S: harness continuations are `role:"user"` and satisfy `isUserMessage` (CRIT-008). T: no requirement makes the intake record tamper-evident or immutable after confirmation. R: no audit event is specified for "intake confirmed by message X". D: `isUserMessage` fails closed on any client error (`tools.ts:68-69`), so a transient `session.messages` failure permanently blocks planning with no override (CRIT-007). |
| `plan.json` persistence + archival (FR-017, FR-018) | ok | **risk** | **risk** | ok | **risk** | ok | T: whole-file rename destroys other sessions' entries (CRIT-001); unguarded `persistPlan` paths silently drop entries (CRIT-002). R: `persistPlan` and `hydrateFromDisk` log nothing when discarding data. D: `acquireStateLock` throws rather than waits, so a stale-but-fresh lock denies all plan writes for up to 30 s (CRIT-010). |
| Verification receipts + wave gate (FR-022, FR-031, FR-032) | ok | ok | ok | ok | **risk** | **risk** | D: 20-entry cap plus all-or-nothing invalidation makes the gate unsatisfiable for large waves (CRIT-005). E: relaxing `verifiersEquivalent` to "covering" without a defined toolchain rule (CRIT-009) risks accepting an unrelated command as proof — a privilege escalation over the evidence bar. FR-031's subagent-cannot-mint invariant is correctly identified and preserved. |
| Verifier subturn (FR-038–FR-045) | ok | ok | ok | **risk** | **risk** | ok | I: FR-041 re-injects the verifier's model-authored `missing` entries into a continuation; the payload builder redacts *inputs* (`verifier.ts:290-306`) but no requirement redacts the verdict on the way out. D: no in-flight guard on a 90 s call (MAJ-008); each overlapping idle costs a real model invocation. |
| Toast channel (FR-057–FR-065) | ok | ok | ok | **risk** | ok | ok | I: prescriptions and `observedCommand` reach the TUI without any required redaction (MAJ-018). D is `ok` — FR-063's rate cap and FR-062's swallow-on-failure are correctly specified. |
| `plan_deliver` tool (FR-012–FR-016) | ok | ok | ok | ok | ok | **risk** | E: a no-evidence status transition is new attack surface; FR-013 correctly blocks verification stories, but nothing prevents delivering a story in a **non-active** wave, and the tool is absent from `KNOWN_TOOL_NAMES` so the subagent deny map does not list it (MAJ-021). |

**Legend**: risk = identified threat not mitigated in spec, ok = adequately addressed or not applicable

---

## Ambiguity Warning Assessment

The spec documents 10 warnings, 9 open. Five are **blocking**:

| # | Subject | Assessment |
|---|---|---|
| 1 | Verification-story receipt binding | **BLOCKING** — two overlapping gates, only one specified; determines the rejection message US-4 AS-3 asserts (MAJ-014). |
| 2 | `getActiveStory` retained as "first active" | **BLOCKING** — verified unsafe at 10 of 11 call sites; two corrupt phase state deterministically (CRIT-003). |
| 3 | Receipt invalidation not path-scoped | **BLOCKING** — was an edge case under sequential execution; is the main path under FR-022 (CRIT-005). |
| 4 | "Resolved verifier" fallback chain | Non-blocking — affects instruction text only; the stated fallback is reasonable. |
| 5 | Mid-plan wave insertion | Non-blocking — a clean scope exclusion. |
| 6 | Verifier per-wave vs at-completion | Marked RESOLVED, but its resolution text states the opposite of FR-038 (MAJ-001). Fix the text. |
| 7 | Cross-toolchain coverage | **BLOCKING** — directly contradicts FR-034 and Examples row 3; "toolchain" is undefined (CRIT-009). |
| 8 | Verifier sees raw ask | Non-blocking — the stated assumption (first user message, redacted, truncated) is safe and matches the existing field caps. |
| 9 | What counts as "new evidence" for `verifier:no-progress` | **BLOCKING** — the proposed signal is "evidenced-item count plus receipt-store size", and the receipt store is wiped on every mutation (CRIT-005), so the signal oscillates independently of real progress. Either premature stop or endless loop, as the warning itself predicts. |
| 10 | One budget vs three caps | Non-blocking, but see OBS-004 and MAJ-010. |

---

## Unasked Questions

1. `plan.json` holds **every session's** plan in one map. What happens to session B's live v3 plan when session A archives "the v2 plan"? (CRIT-001)
2. Which code path guarantees archival runs before `persistPlan` when the write is triggered by `attachEvidence` or `amendStory` rather than `createPlan`? (CRIT-002)
3. Verification receipts are in-memory, session-keyed and capped at 20, and are wiped by **any** mutation. How does a 5-story wave hold 5 valid receipts simultaneously long enough to checkpoint its verification story? (CRIT-005)
4. After a process restart, every `receiptId` in `plan.json` resolves to nothing. Is a complete plan then "deterministically incomplete" forever? (CRIT-006)
5. In an unattended run with no human present, who sends the message that `confirmedByMessageId` must resolve to? (CRIT-007)
6. Does `session.prompt` create a `role: "user"` message? If so, what stops the harness's own continuation from being cited as user confirmation? (CRIT-008)
7. Is `go test ./...` a "whole-suite command with no path arguments" (FR-034) or a command with the path argument `./...` (the extractor's actual behaviour)? (CRIT-009)
8. Does `npm test` cover a prescribed `npx vitest run tests/x.test.ts`? FR-034 says yes; Ambiguity #7's same-runner rule says no. Which governs? (CRIT-009)
9. What exactly is a "toolchain", as a computable property of a command string? (CRIT-009)
10. `acquireStateLock` throws on contention rather than waiting. On what basis does the Edge Case claim concurrent checkpoints are "serialised … both persist"? (CRIT-010)
11. The synthesised verification story has no `scopeGlobs` and is `active` from wave start. Under FR-026, does that not disable the scope watchdog for every wave? (CRIT-004)
12. Which hook fires "once per completed assistant reply cycle", and how does it avoid double-advancing alongside `plugin.ts:386` and `gate.ts:95`? (MAJ-006)
13. Five correction-priority families will compete for `INVOCATION_BUDGET = 2`. Which two win, and why is `verify-gap` not one of the losers? (MAJ-004)
14. What happens — logged, surfaced, recorded — when all continuation caps are exhausted on an incomplete plan? (MAJ-010)
15. In what order do the six continuation triggers evaluate, and does promise-no-act still short-circuit plan-progress? (MAJ-011)
16. Which tool creates an intake record, what is its schema, and where is it stored? (MAJ-013)
17. What is "the proposal" whose timestamp FR-068 compares against, and where is that timestamp recorded? (MAJ-013)
18. Under waves, what is `finalStoryId`, and where in the `stories` array do synthesised verification stories sit? (MAJ-015)
19. Does the FR-034 compliance join (`plugin.ts:670`) use the relaxed covering predicate or keep strict equivalence? (MAJ-003)
20. Are toast messages redacted? (MAJ-018)
21. How does an operator turn the wave model, the intake gate, or the new idle drivers off if one of them misbehaves in the field? (MAJ-019)

---

## Verdict Rationale

**BLOCK.** Ten CRITICAL findings, of which four are outright data-loss or deadlock hazards grounded in verified source behaviour rather than in theory. CRIT-001 and CRIT-002 mean the archival design — the spec's own headline safety measure — destroys data, because `plan.json` is a multi-session map and `persistPlan` drops non-validating entries silently from three code paths the archival trigger does not cover. CRIT-005 and CRIT-006 mean the wave gate (FR-022) and the deterministic completion driver (FR-038a) cannot both hold against a receipt store that is in-memory, capped at 20 entries and wiped by any mutation — the first is unsatisfiable for real waves, the second livelocks every resumed session. CRIT-003 shows the spec's own recorded mitigation for its highest-risk symbol is unsafe at ten of eleven call sites, two of which corrupt phase state deterministically on the second story of the first wave.

Beyond the mechanics, two structural problems must be settled before a revision is worth grilling again. First, **CRIT-007**: the intake gate as specified makes autonomous multi-story planning impossible, which is the exact operation US-10, US-12 and US-14 exist to enable — the spec argues against itself, and that has to be resolved at the requirements level, not in code. Second, **scope**: six independent workstreams behind one atomic schema bump, with the spec's own final Clarification conceding that two of them (D1, D4) must land first while providing no phasing, no feature flag and no rollback (MAJ-019, OBS-005). Splitting the change — D1 + D4 + visibility first, with no schema change and immediately measurable success criteria — would let the wave model be built on a verified foundation instead of an assumed one.

Five of the nine open Ambiguity Warnings (#1, #2, #3, #7, #9) are blocking and must be decided, not documented, before implementation.

### Recommended Next Actions

- [ ] Redesign archival as a per-entry operation over the multi-session map, and move the trigger into `persistPlan` — CRIT-001, CRIT-002
- [ ] Decide receipt durability and path-scoped invalidation; FR-022 and FR-038a are untestable until then — CRIT-005, CRIT-006, Ambiguity #3, Ambiguity #9
- [ ] Add one requirement per unspecified `getActiveStory` call site with explicit union semantics; reject the "first active" assumption — CRIT-003, Ambiguity #2
- [ ] Decide the verification story's `scopeGlobs`/activation semantics so FR-026 does not disable the scope watchdog — CRIT-004
- [ ] Re-scope the intake gate so autonomous runs can plan, and make confirmation provably human-authored — CRIT-007, CRIT-008
- [ ] Replace FR-033–FR-036 with a stated coverage algorithm, a defined "runner", and a path-normalisation spec; re-derive all 7 Examples rows from it — CRIT-009, Ambiguity #7
- [ ] Specify locking semantics for concurrent checkpoints and correct the Edge Case — CRIT-010
- [ ] Fix the three sections that state the pre-FR-038 verifier policy — MAJ-001
- [ ] Renumber FRs out of collision with `vertex2-spec.md` — MAJ-002
- [ ] Add `verifier.ts` and `measurement.ts` to the impact assessment with dependents and regression tests — MAJ-003
- [ ] Address `INVOCATION_BUDGET` and fix SC-014's counter before claiming the D4 fix is measurable — MAJ-004, MAJ-005
- [ ] Specify the FR-051 hook, the FR-049 precedence order, and cap-exhaustion behaviour — MAJ-006, MAJ-010, MAJ-011
- [ ] Specify intake record creation/storage and `finalStoryId` semantics under waves — MAJ-013, MAJ-015
- [ ] Fix the traceability defects and raise SC-006 to full coverage — MAJ-020
- [ ] Add concurrency, cross-session and multi-entry-`plan.json` test categories — Test Coverage Assessment
- [ ] Consider splitting into three shippable increments — OBS-005
