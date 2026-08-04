# Adversarial Review: Vertex 2 — Phase-Aware Guidance Harness

**Spec reviewed**: `docs/vertex2-spec.md` (rev 2, 2026-07-25)
**Review date**: 2026-07-25
**Detected mode**: `plan-spec`
**Reviewer**: independent round — fresh context, no participation in spec authoring
**Supersedes**: the prior in-session self-review (rev 1) that this file previously held
**Verdict**: **BLOCK**

## Executive Summary

Rev 2 applies the nine prior findings as text edits, but four of the nine are only
nominally resolved and two of the applied fixes introduced new defects (FR-005 now
contradicts itself; the F-03 pre-filter makes short multi-story asks unclassifiable).
Independent of the prior round, this review found three CRITICAL defects: the spec never
excludes its own plugin-created child sessions from its own hooks (v1's
`attemptGateContinuation` proves `session.prompt` re-enters `chat.message`), "tool-calling
disabled" is not expressible through the SDK surface the spec claims to have verified, and
the criteria-only idle gate silently deletes v1's unverified-changes stop trigger whenever
the model declines to emit a `CRITERIA:` block. The spec's own structural claim ("all 9
findings applied", prior review's 9/9 structural PASS) does not survive checking: four
acceptance scenarios have no BDD scenario and no test.

| Severity | Count |
|----------|-------|
| CRITICAL | 3 |
| MAJOR | 14 |
| MINOR | 9 |
| OBSERVATION | 4 |
| **Total** | **30** |

### Verification of the prior round's findings (F-01 … F-09)

The spec's *Review Findings Applied* table claims all nine were applied and none deferred.
Independently checked against the current text:

| Prior ID | Claim | Independent verdict |
|---|---|---|
| F-01 | FR-005 cooldowns turn-scoped | **Nominal only** — the added sentence contradicts the clause it was appended to (MAJ-002) |
| F-02 | FR-013 memory fallback + retry | **Partial** — requirement text is sound; SC-013 asserts "100% of fault-injection test cases" but no test in the TDD plan injects a pins write fault (MAJ-008) |
| F-03 | FR-018a pre-filter | **Applied, defective** — length proxy misclassifies short multi-story asks (MAJ-006); "sequencing word" left undefined (MAJ-005); reverses Ambiguity #2's own resolution |
| F-04 | FR-031 reassembled-hunk scan | **Partial** — scan covers diff summaries only; criteria and verifier-output summaries in the same payload get regex redaction only, and the "strict secret-scanning check" is never defined (MAJ-009) |
| F-05 | FR-004 budget channel-scoped | **Resolved** |
| F-06 | FR-028 raw model id | **Resolved** |
| F-07 | Test 35 CI-skipped | **Applied, defective** — SC-004 is stated over "the scripted E2E session", which is now the CI-skipped test (MIN-002) |
| F-08 | Profiles collapsed to 2 | **Applied, over-collapsed** — `frontier` now differs from `standard` on exactly one family in the spec text, while a Non-Behavior implies an unspecified frontier fix-license (MAJ-013, OBS-002) |
| F-09 | Inline `EXPECT [conf]:` | **Resolved** |

Three fully resolved, six nominal/partial/defective. The claim "All 9 findings applied;
none deferred" is not accurate as a statement about the underlying defects.

---

## Findings

### CRITICAL Findings

#### [CRIT-001] Plugin-created child sessions re-enter the plugin's own hooks; no exclusion is specified

- **Lens**: Insecurity / Incorrectness
- **Affected section**: US-9 / FR-030, US-5 / FR-018, Integration Boundaries → "OpenCode SDK client (subturns: verifier US-9, intake classification US-5)"; Edge Cases (no entry covers self-created sessions)
- **Description**: The spec introduces two mechanisms that call `session.create({parentID})`
  + `session.prompt` from inside the plugin, and never states that the resulting child
  session must be excluded from the plugin's own `chat.message`,
  `experimental.chat.system.transform`, `experimental.text.complete`,
  `tool.execute.after` and `event(session.idle)` handling. This is not hypothetical: v1
  already proves the re-entrancy. `src/index.ts` maintains `gateContinuationSessions` and
  branches on it inside `chat.message` (`"chat.message: CONTINUATION session … (ledger
  preserved)"`, line ~1581) precisely because its own `client.session.prompt(...)` call in
  `attemptGateContinuation` (line ~1402) causes `chat.message` to fire again. A child
  session created by the harness will therefore surface as a normal session to every hook.
  Whether the harness *activates* on it depends on the child's agent — which the spec never
  specifies for either subturn (`SessionPromptData.body.agent` is optional; omitting it
  yields the host default). If the host default equals `opts.activeAgent` — the expected
  configuration for this plugin — the gate activates on the verifier's own child session.
- **Impact**: (a) `chat.message` pushes the activation cue directly into `output.parts`
  (`output.parts.push({type:"text", text:"\n"+cue})`, line ~1607) and
  `system.transform` appends the composed directive block to `output.system` — so the
  verifier subturn receives vertex directives and harness narration on top of the
  "evidence-only" payload, breaking FR-031 and the Non-Behavior "must not send chat
  narrative … to the verifier, because the verifier must not inherit coherence bias". (b) The
  BDD scenario "Verifier payload carries evidence only" and test 18/39 use a **stub client**,
  so they assert what the plugin *builds* and are structurally incapable of detecting what
  the host+plugin *deliver* — the canary test passes while the leak ships. (c) Every
  subturn allocates entries in `ledger`, `taskModeBySession`, `reviewBySession`,
  `goalRootsBySession`, `activateCueShown` keyed by the child session id, none of which are
  evicted — with FR-018 firing per qualifying user message this is unbounded growth in a
  long-lived process. (d) `session.idle` on the child fires the v2 gate; if it ever
  evaluates to a block, `attemptGateContinuation` issues another `session.prompt` on the
  child, and the spec defines no recursion depth bound.
- **Recommendation**: Add **FR-036**: "The plugin MUST record the id of every session it
  creates (verifier and intake subturns) in a `selfCreatedSessions` set for the process
  lifetime, and MUST return early from `chat.message`, `experimental.chat.system.transform`,
  `experimental.text.complete`, `tool.execute.after` and `event(session.idle)` for any
  session id in that set or whose `parentID` resolves to an active harness session. Subturn
  prompts MUST pass an explicit `agent` that is not `activeAgent`." Add an Edge Case row:
  "Harness-created child session → harness is inert for that session; no activation cue, no
  directives, no gate, no ledger entry." Add BDD scenario "Verifier subturn receives no
  harness injection" and an **integration** test (not a stub-only unit test) that drives
  the real hook set over a simulated child session and asserts `output.system` and
  `output.parts` are untouched. SC-012 MUST be restated over the delivered payload, not the
  built payload.

---

#### [CRIT-002] "Tool-calling disabled" is not expressible through the SDK field the spec cites as verification

- **Lens**: Infeasibility / Insecurity (Elevation of Privilege)
- **Affected section**: US-9 ("tool-calling disabled"), FR-030 ("one `session.prompt` with
  verifier system prompt, tool-calling disabled"), Integration Boundaries → "`tools`:
  `<tool-calling disabled>` … Grounded in SDK 1.18.4 … verified in
  `@opencode-ai/sdk/dist/gen/types.gen.d.ts`", STRIDE row "Tools explicitly disabled in
  prompt body"
- **Description**: The cited type is
  `SessionPromptData.body.tools?: { [key: string]: boolean }`
  (`types.gen.d.ts:2254`) — a per-tool-**name** allow/deny map. There is no boolean
  "disable tools" flag and no wildcard key in the type surface. The spec verified that the
  field *exists*; it did not verify that the semantics it needs are achievable. Disabling
  tool calling therefore requires enumerating every tool name reachable in that session —
  built-ins plus every tool contributed by other plugins and by MCP servers, which are
  installation-specific and can change without a release of this plugin. Any name not
  enumerated is, by the shape of the map, not denied.
- **Impact**: The verifier child session runs against the same project directory with the same
  permission configuration as the parent. A verifier prompt containing adversarial content
  from a diff summary (an attacker-authored source file is untrusted input that reaches the
  payload by design) could induce a `bash` or `edit` call that the spec believes is
  impossible. The spec's only stated defence is prose in the verifier system prompt, which is
  not an authorization control. The STRIDE table records this component as **PASS** on
  Elevation of Privilege on the strength of a mechanism that does not exist as described.
- **Recommendation**: Before implementation, confirm against the OpenCode server (not the
  type file) whether `tools: {"*": false}` is honoured as a deny-all default. Then replace
  the prose in FR-030 with the concrete mechanism, e.g. **FR-030b**: "The subturn MUST pass
  `tools: {'*': false}` **and** an explicit `agent` bound to a zero-tool agent definition
  shipped with the plugin. If the host does not honour a deny-all key, the subturn MUST be
  disabled and `verifier:unsupported` logged rather than sent with a partial deny list." Add
  BDD scenario "Verifier subturn is refused when tools cannot be disabled" and a test that
  asserts the exact `tools` value sent, plus a negative test asserting the subturn is not
  issued when the deny-all mechanism is unavailable. Downgrade the STRIDE row to `risk`
  until the mechanism is verified against a running host.

---

#### [CRIT-003] Criteria-only idle gate deletes v1's unverified-changes stop trigger; a model that never emits `CRITERIA:` is never blocked

- **Lens**: Incorrectness / Incompleteness
- **Affected section**: FR-015, FR-011, US-4 AS-3/AS-5, Behavioral Contract → error flows,
  Regression Test Requirements (no row covers this), "Explicitly replaced" list
- **Description**: FR-015 states the system "MUST block **only** when ≥1 criterion lacks
  evidence AND no explicit explanation artifact exists". v1's gate is
  `EvidenceLedger.shouldBlockStop` (`src/index.ts:310-319`): `deep && changedFilesSeen &&
  !anyVerificationSucceeded`, with quick/normal and docs-only exemptions. The pinned-criteria
  set is populated only from a model-authored `CRITERIA:` block (FR-012). When that set is
  **empty** — the model ignored the scaffold, or the scaffold never rendered — FR-015's
  condition is vacuously false and no block occurs, for any amount of unverified mutation.
  Nothing in the spec states a fallback to the v1 trigger. FR-011's scaffold is the only
  countermeasure, and it is a `phase-guidance`-priority finding competing inside the
  2-directive budget (FR-004), where `correction` outranks it — so on any turn with two
  correction findings the scaffold does not render at all. The "Explicitly replaced" list
  names "keyword-only stop-mode as sole authority" but not the unverified-changes trigger,
  and the Regression Test Requirements row for the gate carries only the negative invariants
  ("Quick/normal never hard-block; docs-only exemption").
- **Impact**: The plugin's single highest-value behaviour — refusing to let a turn end with
  changed files and no observed verification — becomes opt-in for the model being governed.
  A model that emits no `CRITERIA:` block gets a strictly weaker harness than v1. This is
  the harness-paradox failure the spec elsewhere says it exists to prevent, and it is
  reachable by omission rather than by attack. It will not appear in any listed test,
  because every criteria-gate scenario (US-4 AS-3, test 20) *starts from* pinned criteria.
- **Recommendation**: Add to FR-015: "When zero criteria are pinned at `session.idle`, the
  system MUST fall back to the v1 evidence gate (`deep` mode AND changed files AND no
  successful verification since the latest change), using the same caps, holdout and
  docs-only exemption; the block text MUST additionally state that no acceptance criteria
  were captured." Add BDD scenario "Deep session with no pinned criteria still blocks on
  unverified changes → Category: Error Path", add integration test
  `criteria_absent_falls_back_to_v1_gate`, and add a Regression Test Requirements row
  "Unverified-changes stop trigger (`shouldBlockStop`) | `tests/gate.test.ts`,
  `tests/hookLifecycle.test.ts` | Yes — port to the v2 gate as the zero-criteria fallback".
  Add SC: "Zero deep sessions with changed files and no verification close without a block
  or a warn, with or without pinned criteria."

---

### MAJOR Findings

#### [MAJ-001] The 2-directive per-turn budget cannot carry the five families the spec requires "once per turn"

- **Lens**: Inconsistency / Infeasibility
- **Affected section**: FR-004 vs FR-011, FR-021, FR-024, FR-027, US-6 AS-1; Ambiguity
  Warnings #4 ("Turn boundary: user message → next user message")
- **Description**: A turn is defined as spanning from one user message to the next. Within a
  single such turn an agentic loop invokes `experimental.chat.system.transform` once per
  model round-trip — tens of times on a deep task. FR-004 caps injections at **2 per turn**
  and forbids carry-over ("dropped findings MUST be logged, not carried over"). Meanwhile
  five separate requirements each claim a slot in that same turn: FR-011 intake scaffold
  ("on every turn … until a CRITERIA block is captured"), FR-021 scope watchdog ("at most
  once per turn"), FR-024 anomaly interrupt ("at most once per turn"), FR-027 elevate
  ("exactly once per turn"), US-6 AS-1 pre-commitment reminder ("at most once per turn").
  With `correction > phase-guidance > enrichment` and no carry-over, an early scope drift
  plus an early verify-gap permanently silences the anomaly interrupt and the elevate
  directive for the remainder of that turn — the two moments the design document calls the
  highest-value ones.
- **Impact**: On the exact tasks the harness targets (long deep turns), the guidance layer
  speaks twice and then goes quiet for the next forty tool calls, and the two things it says
  are whatever fired first. The Evaluation Scenario "Wrong expectation triggers re-modeling,
  not thrash" is unreachable whenever two corrections precede the failing verifier.
- **Recommendation**: Decide and state the budget's scope explicitly. Recommended:
  "FR-004: the budget is **2 directives per `system.transform` invocation**, with a
  per-family cooldown counted in `system.transform` invocations (FR-005) and a per-turn cap
  of N per family." Then state each family's per-turn cap in a table (intake 1, scope 1,
  anomaly 1, elevate 1, verify-gap 3) rather than a single global 2. Add BDD scenario
  "Anomaly interrupt is delivered in a turn that already spent the budget on corrections"
  and extend Dataset: Composer budget with a multi-`system.transform` row.

---

#### [MAJ-002] FR-005 contradicts itself after the F-01 fix

- **Lens**: Inconsistency / Ambiguity
- **Affected section**: FR-005
- **Description**: FR-005 reads: "MUST suppress a directive family within its cooldown
  window (**per-family config**, default once per turn). **A cooldown window resets on each
  new user message** … cooldowns are turn-scoped, never wall-clock-scoped." If every window
  resets on every user message, no per-family configuration value can express anything other
  than "once per turn" — a configured window of two or three turns is unrepresentable,
  because the reset clears it before it can span a boundary. The two clauses cannot both
  hold. The F-01 fix resolved the ambiguity about *when* a window resets by making the
  configurability it sits next to meaningless.
- **Impact**: Two engineers implement two different things: one builds a per-family counter
  reset in `chat.message` (config ignored), the other builds a turn-index-based window that
  survives user messages (F-01 unfixed). `tests/…composer_cooldown` ("per-family windows")
  will be written against whichever reading its author picked.
- **Recommendation**: Rewrite FR-005 as: "Each directive family has a cooldown expressed as
  an integer number of turns, `cooldownTurns` (default 1). A family rendered at turn T is
  suppressed until turn T + `cooldownTurns`. Turn index increments on each `chat.message`;
  all assistant outputs within one turn share the same turn index. Cooldowns are never
  wall-clock-scoped." Add a dataset row for `cooldownTurns: 2` spanning a user message.

---

#### [MAJ-003] Three of the seven phases have no defined entry transition; a BDD precondition depends on one of them

- **Lens**: Incompleteness / Incorrectness
- **Affected section**: FR-001, US-1 (all acceptance scenarios), US-6 AS-1
- **Description**: FR-001 declares the phase set `{intake, frame, plan, execute, verify,
  elevate, close}` but defines transitions on exactly four triggers: "user message, first
  mutation, verifier pass/fail, criteria-complete idle" — which reach only `intake`,
  `execute`, `elevate` and `close`. No transition enters `frame`, `plan` or `verify`. US-1's
  four acceptance scenarios cover only the reachable four. US-6 AS-1 then opens with "**Given
  a session in verify phase** without an EXPECT artifact this turn" — a precondition that no
  transition in the spec can produce (COR-03). The design input is not silent on these
  phases: `docs/vertex2-greenfield.html` defines "2 · FRAME — approach + tradeoff ·
  decompose" and "3 · PLAN — smallest verifiable steps" as substantive phases, and the spec's
  own Behavioral Contract references frame ("the frame directive renders" in the US-5 BDD).
- **Impact**: `PhaseState` ships with three inhabitable-but-unreachable values; the frame
  directive referenced by the US-5 BDD scenario has no phase to fire in; US-6 AS-1 is
  untestable as written, which is one reason it has no BDD scenario and no test (MAJ-011).
- **Recommendation**: Either (a) reduce FR-001's set to the four reachable phases and rewrite
  US-6 AS-1's Given as "Given a session in `execute` with changed files and no EXPECT
  artifact this turn", or (b) add explicit transitions: `intake → frame` on criteria capture,
  `frame → plan` on plan proposal acceptance, `execute → verify` on a verifier command
  observed starting. Option (a) is preferred and removes two concepts. Whichever is chosen,
  add the full transition table (source, trigger, target) to FR-001 and cover every arc in
  test 1.

---

#### [MAJ-004] Phase is per-session but work is per-story; elevate fires mid-plan

- **Lens**: Inconsistency / Incorrectness
- **Affected section**: FR-001 ("per-session phase"), FR-027, US-5, US-7 AS-1
- **Description**: FR-001 tracks one phase per session. US-5 introduces multi-story plans
  where each story has its own status, scope, verifiers and acceptance items. FR-027 injects
  the elevate directive "when a relevant verifier passes on a deep session with mutations".
  With a three-story plan, the verifier bound to story 1 going green satisfies FR-027 and the
  session receives "here is what finishing well looks like" — criteria replay, adjacent-finding
  sweep, taste pass over the diff — while stories 2 and 3 have not started. The design input
  states the opposite model: "The engine tracks the phase **per story**"
  (`docs/vertex2-greenfield.html`, §01).
- **Impact**: On exactly the multi-story tasks US-5 exists to serve, the harness declares the
  finishing ritual at every intermediate green, teaching the model to close early — the
  inverse of the story's stated purpose. US-1 AS-3 (`elevate → close` when all pinned criteria
  carry evidence) compounds it: story-1 criteria carrying evidence moves the *session* to
  `close`.
- **Recommendation**: Add to FR-001: "When an active plan exists, phase is tracked per active
  story; the session-level phase is the active story's phase. With no plan, the session has a
  single phase." Add to FR-027: "…and the passing verifier covers the **final** story of an
  active plan, or no plan is active." Add BDD scenario "Intermediate story green does not
  elevate a multi-story plan → Category: Alternate Path" and extend test 26 with a
  three-story fixture.

---

#### [MAJ-005] "Sequencing word" and "≥2 imperative outcomes" are never defined, yet both the pre-filter and the deterministic fallback depend on them

- **Lens**: Ambiguity
- **Affected section**: FR-018, FR-018a, US-5 AS-1, US-5 AS-6, Integration Boundaries →
  Pre-filter, SC-011, test 38
- **Description**: Five separate places condition behaviour on "contains a sequencing word"
  or "≥2 imperative outcomes". Neither term is defined anywhere in the spec: no word list, no
  part-of-speech rule, no language scope, no matching semantics (substring? word boundary?
  case?). The v1 codebase's comparable classifiers ship explicit regexes with bilingual
  coverage (`QUICK_RE`, `DEEP_RE`, `NORMAL_RE`, `PROMISE_NO_ACT_KEYWORDS` in `src/index.ts`),
  which is the convention this spec breaks. This matters more than an ordinary undefined term
  because the heuristic is the **failure fallback** — the thing that decides when the LLM
  subturn is unavailable — and the pre-filter is now the *first* gate (F-03), so the undefined
  rule runs before the defined one.
- **Impact**: Test 38 specifies a "threshold + sequencing-word matrix" with no matrix to
  implement; SC-011 asserts a property of rows that do not exist in any dataset. Two engineers
  produce two different classifiers, and the Korean-language coverage the v1 detectors carry is
  silently dropped.
- **Recommendation**: Add to FR-018a an explicit constant, e.g.
  `SEQUENCING_WORDS = /\b(first|then|next|after that|afterwards|finally|also|additionally|and then|followed by)\b/i`
  plus the Korean equivalents matching the v1 convention (`그다음|그리고|먼저|마지막으로`), and
  define "imperative outcome" as "a top-level clause beginning with a verb from
  `IMPERATIVE_VERBS`", with that set enumerated. Add a **Dataset: Intake pre-filter** with rows
  at 119/120/121 characters, one row per sequencing word, one Korean row, one row where the
  sequencing word occurs inside a fenced code block (must not count), and one row with an
  attached file part.

---

#### [MAJ-006] The pre-filter uses message length as a proxy for scope; short multi-story asks skip classification entirely

- **Lens**: Incorrectness
- **Affected section**: FR-018a, US-5 AS-6, Integration Boundaries → Pre-filter, SC-011
- **Description**: The F-03 fix gates the classification subturn on
  `length ≥ INTAKE_SUBTURN_MIN_CHARS (120) OR contains a sequencing word`, justified by the
  single example "fix typo in readme" (24 chars). The correlation it assumes — short ask ⇒
  single story — is false in the direction that matters. "refactor auth end-to-end" (24
  chars), "add caching and fix the flaky test" (34), "migrate the DB and update the client"
  (36) are all short, all multi-story, and none contains a word from any plausible sequencing
  list. All three skip classification and no plan is proposed. Conversely a 200-character
  rambling single question clears the threshold and burns a model call. The fix also inverts
  Ambiguity Warning #2's recorded resolution ("**LLM-classified** intake subturn … heuristic
  **only** as failure fallback"): the heuristic now decides first, for the whole short-ask
  population, and the LLM never sees those cases.
- **Impact**: US-5 — the "backbone that makes every prescription specific" — is unreachable
  for terse expert users, who are the population most likely to issue multi-story work in few
  words. The failure is silent: `intake:classify-skipped` is logged and nothing proposes a plan.
- **Recommendation**: Replace the length gate with a *cost* gate that does not pretend to be a
  scope gate: "FR-018a: the classification subturn MUST be issued at most once per task (first
  user message after activation, and again only after an explicit new-task signal), and MUST be
  skipped when the ask matches `TRIVIAL_ASK_RE` (typo/rename/one-line/read-only patterns,
  enumerated)." If a length threshold is retained, restate US-5 AS-6 so the example is a
  genuinely trivial ask and add explicit dataset rows for the short-multi-story cases above with
  the expected (and accepted) outcome documented.

---

#### [MAJ-007] The classification subturn has no frequency bound, no cost budget, and no specified hook site

- **Lens**: Incompleteness / Infeasibility
- **Affected section**: FR-018, FR-018a, FR-002, FR-009, SC-003, Integration Boundaries →
  "one prompt per subturn, `Promise.race` 5 s cap + one retry"
- **Description**: Three gaps compound. (1) **Frequency**: FR-002 resets the phase to `intake`
  on *every* user message, and FR-018 attaches classification to intake, so on the plain reading
  a qualifying subturn fires on every user message of an activated session. Nothing states
  "once per task" or caps it per session. (2) **Hook site**: no requirement says which hook
  issues it. The design input places it in `chat.message` (`docs/vertex2-greenfield.html`, §07
  build map: "chat.message → intake classifier"), which is squarely on the user's critical path,
  but FR-009 forbids network calls only in `tool.execute.after`/`system.transform` and the
  Non-Behaviors repeat that exact pair — so `chat.message` is exempted by silence rather than by
  decision. (3) **Latency accounting**: SC-003 bounds "hot hook" latency but enumerates only
  `tool.execute.after` and `system.transform`, so a 5 s + retry (up to ~10 s) blocking call in
  `chat.message` violates no stated criterion.
- **Impact**: A 30-turn session pays up to 30 extra model calls and up to 10 s of dead air per
  turn before the first token, with no requirement being broken. Token cost is never mentioned
  anywhere in the spec as a non-functional constraint.
- **Recommendation**: Add **FR-018b**: "The classification subturn MUST be issued from
  `chat.message`, at most once per task, and at most `INTAKE_SUBTURN_MAX_PER_SESSION` (default 3)
  times per session; it MUST be bounded at 5 s total including the retry, and on expiry MUST fall
  back to the heuristic without a second attempt." Extend SC-003 to name `chat.message` with its
  own budget: "added latency in `chat.message` ≤ 5 s p100, ≤ 50 ms median across turns that skip
  the subturn." Add a Non-Behavior: "The system must not issue more than one classification
  subturn per task, because each one is a paid model call on the user's critical path."

---

#### [MAJ-008] `pins.json` has no lifecycle, no concurrency contract, and no fault-injection test despite SC-013

- **Lens**: Incompleteness
- **Affected section**: FR-013, SC-013, Integration Boundaries → Filesystem state, Traceability
  row FR-013 (tests 10, 21, 37), test 37
- **Description**: `pins.json` is introduced as a second state file alongside `plan.json` and is
  specified only for *writes*. Unaddressed: how pins are keyed (per session id? overwritten
  globally?), when they are deleted or expire, whether the file accumulates every session's
  criteria indefinitely, whether it is covered by the `goals.lock` mechanism or has its own lock,
  and what happens on concurrent writes from two active sessions. The lock in `src/goals.ts`
  (`STALE_LOCK_MS = 30_000`, `lockPath` derived from the plan file) is a plan-file lock; the spec
  asserts "atomic writes … lock file with 30 s staleness … (v1 mechanisms reused)" for the whole
  directory without stating that a separate file needs its own lock or shares one. Separately,
  SC-013 asserts "A pins write failure is followed by a successful disk write on the next criteria
  update in **100% of fault-injection test cases**" — but the traceability row for FR-013 lists
  tests 10, 21 and 37, and test 37 is `story_lock_file_stale_recovery`, described entirely in terms
  of *plan* write concurrency. No test in the TDD plan injects a pins write fault. SC-013 is
  asserted over an empty set.
- **Impact**: The F-02 fix is unverifiable as specified; INC-04 (data lifecycle) is unmet for a
  file that persists model-authored task content to the user's worktree indefinitely; two
  concurrent sessions can interleave writes with no stated ordering rule.
- **Recommendation**: Add **FR-013a**: "`pins.json` MUST be a map keyed by session id, MUST be
  written under the same lock as `plan.json`, MUST drop entries older than 7 days or belonging to
  sessions closed in a previous process, and MUST be deleted when the last entry is dropped."
  Add test 40 `pins_write_fault_and_retry` (Unit: EACCES on first write → memory fallback +
  `pins:disk-fallback-memory`; next criteria update writes successfully) and retarget SC-013 at
  it. Add a **Dataset: Pins persistence** with rows for EACCES, ENOSPC, concurrent-session write,
  and stale-entry eviction.

---

#### [MAJ-009] The verifier payload secret scan covers only one of the three payload fields, and the scan itself is undefined

- **Lens**: Insecurity (Information Disclosure)
- **Affected section**: FR-031, US-9 AS-5, Dataset: Verifier payload hygiene, SC-012
- **Description**: FR-031 requires every field to pass `redactSecrets` and adds — as the F-04
  fix — that "**diff summaries** MUST additionally pass a strict secret-scanning check on the
  reassembled hunk". The payload has three fields (pinned criteria, diff summary, verifier output
  summaries). Verifier output summaries are the field most likely to contain a credential in the
  wild: test runners echo environment, connection strings and auth headers on failure, and the
  wrapping applied by terminal output is exactly the chunk-boundary condition F-04 was raised
  about. They receive no scan. Second, "a strict secret-scanning check" is never defined — no
  pattern set, no entropy rule, no threshold. The only redactor that exists, `src/redaction.ts`,
  is a fixed allowlist of labelled-assignment patterns and named vendor prefixes
  (`sk-`, `ghp_`, `AKIA…`, JWT, URL userinfo); it has no generic high-entropy-token rule, so a
  bare 40-character hex API key with no label passes through untouched. The spec cites
  `redactSecrets` as the baseline without stating that limitation.
- **Impact**: SC-012 ("100% of verifier-payload dataset rows containing a secret … transmit without
  the offending hunk") is satisfied by a 4-row dataset whose only secret is `sk-live-abc123…` —
  a string the existing regex already catches. The criterion passes while the actual gap (unlabelled
  tokens, verifier stdout) is untested.
- **Recommendation**: Amend FR-031 to: "**Every** payload field — pinned criteria, diff summary and
  verifier output summaries — MUST pass `redactSecrets` and then the strict scan, applied to the
  reassembled field rather than per chunk. The strict scan is defined as `SECRET_PATTERNS` from
  `src/redaction.ts` **plus** a Shannon-entropy rule: any whitespace-delimited token of ≥32
  characters with entropy ≥ 4.0 bits/char is treated as a secret. A field that trips the scan has
  the offending hunk/line removed; if removal leaves the field empty, the field is omitted and
  `verifier:field-dropped` is logged." Extend the hygiene dataset with rows for an unlabelled 40-hex
  token in verifier stdout, a token wrapped across two output lines, and a base64 blob in a criteria
  line.

---

#### [MAJ-010] The pre-commitment reminder (US-6 AS-1) cannot be delivered before the verifier runs, and has no scenario or test

- **Lens**: Infeasibility / Incompleteness
- **Affected section**: US-6 AS-1, FR-023, Integration Boundaries → OpenCode plugin host
  ("Data in": `chat.message`, `tool.execute.after`, `system.transform`, `text.complete`, `event`,
  `config`)
- **Description**: US-6 AS-1 requires: "**When** a verifier command is observed **starting** (tool
  args), **Then** a one-line pre-commitment reminder is queued at most once per turn." Observing a
  command *starting* requires `tool.execute.before`, which is not in the spec's declared hook
  surface. Even with it, a *queued* directive reaches the model only at the next
  `experimental.chat.system.transform` — i.e. after the tool has already executed and returned.
  The reminder asking the model to state an expectation *before* running the verifier therefore
  arrives after the result. The mechanism named in the acceptance scenario cannot produce the
  behaviour the scenario describes. Consistently, US-6 AS-1 is the one US-6 scenario with no BDD
  scenario and no entry in the TDD plan.
- **Impact**: The pre-commitment loop — which US-6 calls "the tier-2 mechanism the whole guide layer
  leans on" — has no delivery path for its own prompt. Implementers will either drop AS-1 silently or
  build a `tool.execute.before` path that arrives too late and looks broken in the transcript.
- **Recommendation**: Move the reminder to a phase-entry injection rather than a tool-observation
  one: "FR-023a: on the first `system.transform` after the session enters `execute` with changed
  files and no EXPECT artifact for the turn, the composer MUST render a one-line pre-commitment
  prompt (`phase-guidance` priority, once per turn)." Add `tool.execute.before` to the Integration
  Boundaries "Data in" list only if it is genuinely used. Add BDD scenario "Pre-commitment prompt
  renders before the first verifier of the turn" and a test entry traced to it.

---

#### [MAJ-011] Four acceptance scenarios have no BDD scenario and no test; the spec's structural claim is inaccurate

- **Lens**: Inconsistency (traceability)
- **Affected section**: US-1 AS-3, US-6 AS-1, US-8 AS-1, US-10 AS-1; Traceability Matrix
  "Completeness check"; the superseded review's structural table
- **Description**: Counted directly: 41 acceptance scenarios across US-1…US-10, 34 BDD scenarios.
  Four acceptance scenarios have no corresponding BDD scenario and no test name in the TDD plan:
  **US-1 AS-3** (`elevate → close` at idle when all pinned criteria carry evidence, no block) —
  the close transition is never exercised; **US-6 AS-1** (pre-commitment reminder — see MAJ-010);
  **US-8 AS-1** (resolved profile recorded on the session *and on every subsequent event*) — test 16
  covers only unknown-model fallback; **US-10 AS-1** (every event carries `model` and `session_id`) —
  the traceability row for FR-033 says "(all event-emitting scenarios) … + harness assert", which
  names no test. Additionally, the BDD scenario "Verifier verdict appended without gating the checkpoint"
  has no test traced to it (test 29 is the timeout path, test 36 is model selection, test 18 is the
  payload). The spec's own "Completeness check" asserts the opposite, and the superseded review
  recorded a 9/9 structural PASS with a scenario count (33 vs 37) that matches neither the spec nor
  this count.
- **Impact**: The `close` phase — one of the four reachable phases and the terminal state of the whole
  loop — ships with no scenario and no test. Two P2 measurement invariants have assertions nowhere.
- **Recommendation**: Add BDD scenarios and TDD entries for all four: "Idle with all criteria evidenced
  closes without blocking" (test 41, Integration), "Pre-commitment prompt renders before the first
  verifier" (MAJ-010), "Resolved profile is stamped on session init and every subsequent event"
  (extend test 16 with an event-stream assertion), "Every emitted event carries model and session id"
  (property test over the event sink, test 42). Add a test entry for the verifier happy path. Correct the
  Completeness check to state the counts.

---

#### [MAJ-012] No rollback path or kill switch for a breaking rewrite that mediates every LLM turn

- **Lens**: Inoperability
- **Affected section**: Assumptions ("Breaking-change communication … not part of this spec's scope"),
  Impact Assessment (`ElicifyVertexPlugin` return shape = HIGH), Decisions From Discovery ("Breaking
  changes allowed"), Success Criteria (no rollout criterion)
- **Description**: v2 rewrites the hook wiring, replaces the directive layer, changes the gate's
  trigger condition, breaks the plan schema (archiving v1 plans irreversibly on first contact, FR-022),
  and renames every tool and slash command. The only runtime switches named anywhere are `VERTEX_VERIFIER`
  (verifier only), `VERTEX_HOLDOUT` (measurement arms), `VERTEX_DATA` and `VERTEX_DEBUG`. There is no
  switch that returns a user to v1 behaviour, no staged rollout, and no criterion for deciding the
  rollout succeeded. FR-022's archival is one-way, so downgrading the package does not restore a
  working plan. OPS-03 is unmet for the highest-risk symbol the spec's own Impact Assessment
  identifies.
- **Impact**: Any v2 defect that reaches users — e.g. CRIT-003's silent gate loss, or MAJ-001's
  budget starvation — degrades every session of every user with no supported remedy short of pinning
  the previous major version and re-creating plans by hand.
- **Recommendation**: Add **FR-036**: "The plugin MUST support `VERTEX_V2=0` (or option
  `engine: 'v1'`), which disables all v2 components and restores the v1 composer and gate paths for
  the process; the flag MUST be honoured before any state file is read or archived." Add to FR-022:
  "Archival MUST be reversible: the archived file retains its original name plus a timestamp suffix
  and MUST NOT be deleted by the plugin." Add SC-014: "With `VERTEX_V2=0`, the full v1 regression
  suite passes unchanged and no `.elicify-vertex/` file is modified."

---

#### [MAJ-013] A frontier "proactive-fix license" is implied by a Non-Behavior but specified nowhere

- **Lens**: Incompleteness / Insecurity
- **Affected section**: Explicit Non-Behaviors ("must not silently fix out-of-scope findings **under
  the `standard` model profile** (propose only)"), FR-029, US-8, FR-021
- **Description**: The Non-Behavior is scoped to `standard`, which by exclusion states that under
  `frontier` the system *may* instruct silent fixing of out-of-scope findings. The design input makes
  this explicit ("Proactive-fix license: propose only, never silently fix | Fix when small + related +
  tested; always report"). But no functional requirement grants it, no acceptance scenario exercises
  it, no BDD scenario covers it, no test names it, and no bound is placed on it — while FR-021 states
  unconditionally that out-of-scope mutations "MUST enqueue a guiding directive (fold/amend/revert)".
  FR-021 and the Non-Behavior's exclusion contradict each other for `frontier`.
- **Impact**: The single most consequential dosing difference — whether the harness tells a model it
  may edit outside the user's stated scope without asking — exists only as an implication in a negative
  clause. An implementer reading the Non-Behavior literally will build an unbounded fix license for
  frontier models; one reading FR-021 will build none. The former is an autonomy grant with no stated
  limits reaching production untested.
- **Recommendation**: Decide explicitly. If the license is out of scope for v2.0, rewrite the
  Non-Behavior without the profile qualifier: "The system must not instruct silent fixing of
  out-of-scope findings under any profile (propose only)", and add it to the Assumptions' out-of-scope
  list. If it is in scope, add **FR-029a** with hard bounds ("`frontier` MAY render a fix license only
  when the finding is within the plan's workspace, the diff is ≤ N lines, and the story's bound
  verifier covers the path; the license MUST require the fix to be reported in the close-out"), plus a
  BDD scenario and a test.

---

#### [MAJ-014] Child sessions created for subturns are never deleted

- **Lens**: Incompleteness (data lifecycle) / Inoperability
- **Affected section**: US-9, FR-030, FR-018, Integration Boundaries → OpenCode SDK client
- **Description**: Every verifier and intake subturn calls `session.create({parentID, title})`. The spec
  specifies creation and prompting; it never specifies deletion or reuse. The SDK exposes
  `SessionDeleteData` (`types.gen.d.ts:1860`) and `SessionChildrenData` (:1946), so child sessions are
  both deletable and enumerable — i.e. user-visible. With FR-018 firing per qualifying user message
  (MAJ-007), a working day produces dozens of orphan child sessions per project.
- **Impact**: The user's session list fills with harness artefacts titled by the plugin; storage grows
  unbounded; the Evaluation Scenario "Verifier outage is invisible to the user" is contradicted by a
  visible trail of verifier sessions.
- **Recommendation**: Add to FR-030: "The subturn MUST delete its child session via `session.delete`
  in a `finally` block, including on timeout, retry exhaustion and failure; deletion failure MUST be
  logged (`subturn:cleanup-failed`) and MUST NOT affect the caller." Alternatively specify a single
  reused child session per parent session. Add an assertion to tests 29 and 36 that
  `session.delete` is called exactly once per subturn on every path.

---

### MINOR Findings

#### [MIN-001] SC-002's ≥95% threshold is degenerate against an 8-row dataset

- **Lens**: Infeasibility
- **Affected section**: SC-002; Dataset: Narrowest-verifier resolution (8 rows)
- **Description**: "returns the expected command for ≥ 95% of the fixture dataset rows" over 8 rows
  admits only 8/8 (100%) — 7/8 is 87.5%. The percentage communicates tolerance that the dataset size
  cannot express.
- **Recommendation**: Restate as "SC-002: resolution returns the expected command for **every** row of
  Dataset: Narrowest-verifier resolution (8/8); every non-matching input degrades to the generic list
  with `resolution:none` logged." If tolerance is genuinely wanted, grow the dataset to ≥20 rows first.

---

#### [MIN-002] SC-004 is stated over the one test the F-07 fix removed from CI

- **Lens**: Infeasibility
- **Affected section**: SC-004 ("In the scripted E2E session…"), TDD test 35
- **Description**: The F-07 fix made test 35 `live_scripted_session` maintainer-run and skipped in CI
  unless `OPENCODE_LIVE_TEST=1`. SC-004 — the criterion covering the teachable block, the spec's
  headline behaviour — is written over exactly that session, so it is unverified on every CI run.
- **Recommendation**: Restate SC-004 over the UAT harness (tests 32–34), which run in CI:
  "SC-004: In `uat_v2_core_loop`, a mutated session with an unmet criterion produces a block quoting
  the criterion and containing a runnable command; the following simulated green turn closes the
  session without a further block." Keep the live session as a separate, explicitly manual criterion.

---

#### [MIN-003] `INTAKE_SUBTURN_MIN_CHARS` is named as a constant but is not in the configuration surface, and "length" is undefined

- **Lens**: Ambiguity / Inoperability
- **Affected section**: FR-018a, US-5 AS-1, Ambiguity Warnings #3
- **Description**: The threshold is presented as a named tunable but appears in no options list
  (Ambiguity #3 covers only the dosing table), so it is a hardcoded magic number (OPS-07). Separately,
  "the user ask is ≥ 120 characters" does not say what is measured: raw message text, trimmed text,
  concatenated text parts, or text including quoted code, pasted stack traces and file attachments —
  each yields different behaviour for the same user action.
- **Recommendation**: Add to FR-018a: "`INTAKE_SUBTURN_MIN_CHARS` is a plugin option (default 120).
  Length is measured over the concatenation of the message's `type: 'text'` parts after trimming, with
  fenced code blocks and attached file parts excluded."

---

#### [MIN-004] US-5's acceptance scenarios are misnumbered (1, 6, 2, 3, 4, 5)

- **Lens**: Inconsistency
- **Affected section**: User Story 5 — Acceptance Scenarios
- **Description**: The F-03 fix inserted the new scenario as item "6" immediately after item 1, leaving
  the list ordered 1, 6, 2, 3, 4, 5. Cross-references elsewhere ("US-5, Acceptance Scenario 6") resolve
  correctly by number but a reader scanning the list sees a break, and any tooling that renumbers will
  break the BDD `Traces to:` links.
- **Recommendation**: Move the new scenario to the end of the list, or renumber the list 1–6 in reading
  order and update the two `Traces to:` references.

---

#### [MIN-005] SC-003 is unfalsifiable as written

- **Lens**: Infeasibility
- **Affected section**: SC-003
- **Description**: "Median added latency … ≤ 5 ms and p99 ≤ 250 ms including the bounded fallback,
  measured by a benchmark script over 1,000 synthetic invocations." Two gaps: (a) "added" implies a
  baseline that is never defined (added relative to no plugin? to v1?); (b) the p99 figure is only
  meaningful if the 250 ms fallback fires in more than 1% of the 1,000 invocations, and the benchmark's
  composition is unspecified — a benchmark where the fallback never fires passes trivially.
- **Recommendation**: "SC-003: measured against a no-op plugin baseline over 1,000 synthetic invocations
  of which ≥ 50 force the bounded resolution fallback, median added latency ≤ 5 ms and p99 ≤ 250 ms per
  invocation of `tool.execute.after` and `experimental.chat.system.transform`."

---

#### [MIN-006] Persistent pins degradation becomes silent after the first log

- **Lens**: Inoperability
- **Affected section**: FR-013
- **Description**: FR-013 logs `pins:disk-fallback-memory` "once per session" and retries on every
  criteria update. For a permanent cause (EACCES on a read-only mount, ENOSPC on a full disk) every
  subsequent retry fails silently, so the operator sees one event and no indication that persistence
  never recovered (OPS-02).
- **Recommendation**: "…log `pins:disk-fallback-memory` on the first failure and
  `pins:disk-recovered` on the first subsequent success; if three consecutive retries fail, log
  `pins:disk-unavailable` once and stop retrying for the session."

---

#### [MIN-007] The two-active-sessions rule starves the criteria gate of evidence

- **Lens**: Incompleteness
- **Affected section**: Edge Cases ("`file.edited` attribution only when exactly one session is active
  (v1 rule preserved)"), FR-015
- **Description**: v1 preserves non-attribution under multi-session activity, which in v1 means the
  stop gate simply does not fire (no changed files recorded). In v2 the gate's condition is inverted:
  it blocks on criteria *lacking evidence*. With attribution suppressed, evidence never accrues, so
  every pinned criterion stays unmet and both sessions block up to the cap. The edge case is listed but
  its interaction with the new gate is not analysed.
- **Recommendation**: Add to FR-015: "When more than one session is active, `file.edited` attribution is
  unavailable and the criteria gate MUST NOT block; it MUST render the criteria replay as advisory and
  log `gate:multi-session-advisory`." Add a BDD scenario and extend test 20 with a two-active-session row.

---

#### [MIN-008] "Equivalently-resolved verifier" in FR-034 is undefined

- **Lens**: Ambiguity
- **Affected section**: FR-034, US-10 AS-2, test 30
- **Description**: `directive_complied` fires when "the prescribed (or **equivalently-resolved**)
  verifier is observed in the same turn". No equivalence relation is given. Is `npx vitest run
  tests/lexer.test.ts` equivalent to `npm test`? To `npx vitest run tests/`? To `npx vitest run
  tests/lexer.test.ts --reporter=json`? Compliance rate — the metric that drives directive ROI and
  therefore which prescriptions get deleted — depends entirely on this choice.
- **Recommendation**: Define it: "Two commands are equivalent when the resolver (FR-008) returns the
  same tier and the same target path set for both, ignoring reporter/verbosity flags enumerated in
  `IGNORED_VERIFIER_FLAGS`." Add dataset rows to Dataset: Composer for a matching-but-not-identical
  command and a broader-suite command.

---

#### [MIN-009] Pins persistence has two modes with no stated reason

- **Lens**: Overcomplexity
- **Affected section**: FR-013 ("persist pins to `.elicify-vertex/` when a plan exists and hold them in
  memory otherwise"), Dataset: Artifact parsing row 7 note
- **Description**: The conditional creates two persistence paths, two failure modes and two test modes
  ("survive a simulated restart when a plan exists (disk) or the session when not (memory)") for one
  concept. No requirement depends on planless pins being non-durable; the only effect is that a planless
  deep session silently loses its definition of done on restart.
- **Recommendation**: Always persist pins to `.elicify-vertex/pins.json` under the lifecycle rules of
  MAJ-008, and delete the conditional from FR-013. This removes one branch, one test mode and one
  failure mode.

---

### Observations

#### [OBS-001] The `verifierModel` override and its fallback chain are configurability without a driver

- **Lens**: Overcomplexity
- **Affected section**: FR-030a, US-9 AS-2/AS-3, BDD "Configured verifierModel failure falls back", test 36
- **Suggestion**: The spec's own argument for the default is that the session model "always works, no
  extra config". The override adds a plugin option, a two-step fallback chain (override → session model
  → fail open), one acceptance scenario, one BDD scenario and part of a test — for a capability nobody
  has asked for and whose failure path is already covered by fail-open. Consider deferring
  `verifierModel` to a later version and deleting FR-030a's second sentence, US-9 AS-3 and its BDD
  scenario. Test 36 then reduces to asserting the session model is used and the child is created with
  `parentID`.

#### [OBS-002] Two dosing profiles now differ on exactly one family

- **Lens**: Overcomplexity
- **Affected section**: US-8, FR-028, FR-029, BDD dosing outline, Dataset: Dosing profiles
- **Suggestion**: After the F-08 collapse, the only dose difference expressed anywhere in the spec text
  is intake scaffold: full vs one-line nudge (the outline and the dataset exercise only that family;
  FR-029 pins anomaly and falsification at `full` for both). The design input distinguishes six families;
  the spec distinguishes one. Either restore the per-family dose table from
  `docs/vertex2-greenfield.html` §05 as an explicit matrix in FR-029 (with a BDD row per family), or
  replace the profile concept with a single option `intakeScaffold: 'full' | 'nudge'` and delete the
  table, the suffix-tolerant matching, the `dosing:unknown-model` event and tests 16–17 until a second
  dimension exists.

#### [OBS-003] Test 37's name and description do not match the requirement it is traced to

- **Lens**: Inconsistency
- **Affected section**: TDD test 37 `story_lock_file_stale_recovery`; Traceability rows FR-013 and FR-017
- **Suggestion**: Test 37 is described purely in plan-write terms ("concurrent plan write: second writer
  sees lock and throws; lock older than 30 s is reclaimed") yet is cited as coverage for FR-013 (pins
  persistence). Remove test 37 from the FR-013 row and add the pins fault-injection test from MAJ-008 in
  its place.

#### [OBS-004] The review-independence caveat can now be retired

- **Lens**: Inoperability (process)
- **Affected section**: "Review Findings Applied" → "Review independence caveat"
- **Suggestion**: The caveat correctly warned that rev 1 was self-review. This round was produced by an
  independent reviewer with no involvement in authoring, against the current text, with the spec's
  codebase claims verified against `src/index.ts`, `src/goals.ts`, `src/redaction.ts`,
  `node_modules/@opencode-ai/plugin/dist/index.d.ts` and
  `node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts`. Replace the caveat with a pointer to this
  round when rev 3 is produced.

---

## Structural Integrity

**Detected mode**: `plan-spec` (BDD scenarios with Given/When/Then, `FR-xxx` ids, Traceability Matrix,
`SC-xxx` ids all present).

| Check | Result | Notes |
|-------|--------|-------|
| Every user story has acceptance scenarios | **PASS** | US-1…US-10 each carry 3–6 scenarios (41 total) |
| Every acceptance scenario has BDD scenarios | **FAIL** | 41 acceptance scenarios vs 34 BDD scenarios; US-1 AS-3, US-6 AS-1, US-8 AS-1, US-10 AS-1 uncovered (MAJ-011) |
| Every BDD scenario has `Traces to:` reference | **PASS** | All 34 carry `Traces to:` and `Category:` |
| Every BDD scenario has a test in the TDD plan | **FAIL** | "Verifier verdict appended without gating the checkpoint" has no test; tests 29/36/18 cover other paths (MAJ-011) |
| Every FR appears in traceability matrix | **PASS** | FR-001…FR-035 plus FR-018a and FR-030a all present |
| Every BDD scenario appears in traceability matrix | **PASS** | All 34 resolve to a matrix row by shorthand |
| Test datasets cover boundaries/edges/errors | **FAIL** | No dataset for the intake pre-filter despite SC-011 citing one (MAJ-005); no dataset row for the zero-pinned-criteria gate state (CRIT-003); no dataset for cooldown windows > 1 turn (MAJ-002); no pins fault-injection rows despite SC-013 (MAJ-008) |
| Regression impact addressed | **FAIL** | v1's `shouldBlockStop` unverified-changes trigger is neither in the preserve table nor in the "Explicitly replaced" list (CRIT-003); the `ElicifyVertexPlugin` HIGH-risk row has no rollback (MAJ-012) |
| Success criteria are measurable | **FAIL** | SC-002 degenerate (MIN-001), SC-003 unfalsifiable composition (MIN-005), SC-004 over a CI-skipped test (MIN-002), SC-011 over a non-existent dataset (MAJ-005), SC-013 over a non-existent test (MAJ-008), SC-012 over a 4-row dataset that tests only an already-covered pattern (MAJ-009) |

**Result: 4 PASS / 5 FAIL.** The spec's own "Completeness check" and the superseded review's 9/9 PASS
are both contradicted by direct counting.

### Codebase claims verified

| Spec claim | Verified against | Result |
|---|---|---|
| "currently 405 passing" | `npx vitest run` | **Accurate** — 14 files, 405 tests, all passing |
| `parseVerification`, `isMutatingBashCommand`, `changedPathsFromTool` exist and are frozen | `src/index.ts:1152, 545, 567` | **Accurate** |
| `EvidenceLedger`, `DirectiveQueue`, `SessionGate`, `classifyStopMode`, `classifyTask`, `contextForMode`/`contextForStopMode`/`contextForReview`, `formatDirectives`, `formatGateContinuationText` | `src/index.ts:140, 66, 95, 875, 819, 921/904/968, 1198, 1228` | **Accurate** |
| `MultiStoryGoalEngine`, `VerificationReceiptStore`, atomic `wx`+rename, mode 0600, 30 s stale lock | `src/goals.ts:187, 159, 141, 473-486` | **Accurate** |
| `redactSecrets` / `redactForDisk` | `src/redaction.ts:38, 63` | **Accurate**, but pattern set is an allowlist with no entropy rule (MAJ-009) |
| `chat.message` exposes the model id | `@opencode-ai/plugin/dist/index.d.ts` — `model?: {providerID, modelID}` | **Accurate but optional**; `experimental.chat.system.transform` carries a **required** `model: Model` the spec does not use (see Unasked Questions) |
| `session.create({parentID})`, `session.prompt({model, system, tools, parts})` | `@opencode-ai/sdk/dist/gen/types.gen.d.ts:1811, 2244` | **Fields accurate**; `tools` semantics do not support the claimed capability (CRIT-002) |
| `experimental.text.complete`, `event(session.compacted)` | plugin `index.d.ts`; `src/index.ts:1786, 1799` | **Accurate** |
| Per-story phase tracking | `docs/vertex2-greenfield.html` §01 says per story; FR-001 says per session | **Divergent** (MAJ-004) |
| Frontier proactive-fix license | greenfield §05 dose table specifies it; spec has no FR | **Divergent** (MAJ-013) |

---

## Test Coverage Assessment

### Missing test categories

| Category | Gap description | Affected findings |
|---|---|---|
| Re-entrancy | No test drives the real hook set over a plugin-created child session; all subturn tests stub the client, so injection into the subturn is undetectable | CRIT-001 |
| Authorization | No test asserts the exact `tools` value sent, and none asserts the subturn is refused when tools cannot be disabled | CRIT-002 |
| Gate fallback | No test covers `session.idle` with zero pinned criteria and unverified changes | CRIT-003 |
| Budget under load | No test drives multiple `system.transform` invocations within one turn; the budget's scope is never exercised | MAJ-001 |
| Cooldown > 1 turn | `composer_cooldown` covers "per-family windows" but no dataset row spans a `chat.message` boundary | MAJ-002 |
| Phase completeness | Test 1 covers the transition table but three phases have no arcs and the `close` transition has no test | MAJ-003, MAJ-011 |
| Multi-story elevate | Test 26 uses a single-story fixture; no test asserts elevate is suppressed mid-plan | MAJ-004 |
| Subturn frequency/cost | No test asserts an upper bound on subturns per session | MAJ-007 |
| Fault injection (pins) | SC-013 asserts 100% of fault-injection cases; no such test exists | MAJ-008 |
| Payload hygiene breadth | Only diff summaries are scanned and only for an already-covered pattern | MAJ-009 |
| Subturn cleanup | No test asserts `session.delete` on any path | MAJ-014 |
| Event invariants | FR-033's "every event carries model + session id" has no property test | MAJ-011 |

### Dataset gaps

| Dataset | Missing boundary type | Recommendation |
|---|---|---|
| (none exists) Intake pre-filter | Threshold and word-list boundaries | New dataset: 119/120/121 chars; one row per sequencing word; Korean row; sequencing word inside a code fence; short multi-story asks ("refactor auth end-to-end"); message with file attachment |
| Composer budget / cooldown / decay | Multi-`system.transform` turn; cooldown spanning a user message; five families competing for two slots | Add rows 7–9 |
| Verifier payload hygiene | Unlabelled 40-hex token; secret in verifier stdout; token wrapped across output lines; base64 blob in a criteria line | Add rows 5–8 |
| Checkpoint evidence validation | Waiver recorded by whom, and whether a waiver can be self-issued by the model | Add a row for a model-issued waiver (must be rejected) |
| (none exists) Idle gate state matrix | Zero criteria × changed files × mode; two active sessions | New dataset covering the gate's decision table |
| Narrowest-verifier resolution | Monorepo/workspace root with multiple `package.json` files; changed path outside the worktree | Add rows 9–10 |

---

## STRIDE Threat Summary

| Component | S | T | R | I | D | E | Notes |
|---|---|---|---|---|---|---|---|
| Verifier subturn (child session) | risk | ok | ok | **risk** | risk | **risk** | Tool disabling not expressible (CRIT-002); harness injects its own directives/cue into the payload (CRIT-001); scan covers one of three fields (MAJ-009); no per-session cap on paid calls |
| Intake classification subturn | risk | ok | ok | risk | **risk** | risk | Same re-entrancy and tools exposure; unbounded frequency and no cost budget (MAJ-007); user ask sent to a model with no stated redaction requirement |
| Injection composer / `system.transform` | ok | ok | ok | ok | risk | ok | Budget starvation silences corrections (MAJ-001); `redactSecrets` applied per FR-007 |
| Idle gate + `session.prompt` continuation | ok | ok | ok | ok | risk | ok | Fires on harness-created child sessions with no recursion bound (CRIT-001); caps preserved from v1 |
| Filesystem state (`plan.json`) | ok | ok | ok | ok | ok | ok | v1 mechanisms (0600, `wx`+rename, 30 s stale lock) verified in `src/goals.ts` |
| Filesystem state (`pins.json`) | ok | **risk** | ok | risk | ok | ok | No lock/atomicity contract of its own, no keying, no deletion, no expiry (MAJ-008); persists task content in the worktree |
| Resolution subprocess fallback | ok | ok | ok | ok | ok | risk | 250 ms cap and "binary discovery guarded" stated, but no requirement forbids passing changed paths as shell arguments; state "arguments passed via argv array, never string-interpolated into a shell" |
| Measurement sink (`events.jsonl`) | ok | ok | ok | risk | ok | ok | New event types (`directive_rendered` text, `resolution:none` changed-path set, raw model id) widen what lands on disk; only `redactForDisk` is cited, and no retention or size bound is specified |

**Legend**: risk = identified threat not mitigated in the spec; ok = adequately addressed or not applicable.

---

## Unasked Questions

1. Why does the spec read the model id from `chat.message` (where it is `model?` — optional) rather
   than from `experimental.chat.system.transform` (where `model: Model` is **required**)? The latter is
   available on every injection and would make the `dosing:unknown-model` path nearly unreachable.
2. Which agent do the verifier and intake subturns run as? The answer determines whether the harness
   activates on its own child sessions (CRIT-001) and whether the subturn inherits the user's agent
   instructions — which would itself violate the evidence-only diet.
3. What is the cost budget for v2? Two subturn mechanisms issue paid model calls on the user's critical
   path and no requirement, success criterion, or assumption mentions tokens or spend.
4. What happens at `session.idle` when zero criteria are pinned? (CRIT-003 — the spec's most consequential
   silence.)
5. Who may issue the "explicit user waiver" that satisfies FR-019, and how does the story engine
   distinguish a user-issued waiver from one the model wrote into the tool arguments? The v1 receipt rule
   exists precisely because the model cannot be trusted to author its own evidence.
6. Does the injection budget reset per `system.transform` call or per user turn? Every "once per turn"
   requirement in the spec depends on the answer (MAJ-001).
7. When a plan exists and the user switches branches, the Assumptions say `plan.json` stays in place —
   but what happens when the plan's scope globs no longer match any file on the new branch? The scope
   watchdog fires on every mutation (the spec's own "globs match nothing" edge case) for the rest of the
   session.
8. Is `.elicify-vertex/pins.json` intended to be committed? The Assumptions suggest gitignoring the
   directory for branch-scoped plans, which would also discard pins — but nothing states whether pinned
   criteria are project state or session state.
9. How does the harness distinguish "a new task in the same session" from "a follow-up message on the
   current task"? FR-002 resets the phase on every user message, which implies every follow-up re-runs
   intake, re-demands criteria (FR-011, until captured) and re-fires classification (MAJ-007).
10. What is the migration story for a user who has an active v1 plan and does not want it archived?
    FR-022 archives on first contact with any story tool, irreversibly from the user's perspective.

---

## Verdict Rationale

**BLOCK.** Three findings are production-incident class and none of them is a matter of taste.
CRIT-003 removes the plugin's core protection by omission — a model that never emits a `CRITERIA:`
block gets a strictly weaker harness than v1 ships today, and no listed test can catch it because every
gate scenario begins from pinned criteria. CRIT-001 is grounded in this repository's own v1 code:
`attemptGateContinuation` exists in its current shape *because* `session.prompt` re-enters
`chat.message`, and the spec adds two more `session.prompt` call sites without ever excluding the
sessions it creates — so the verifier receives the harness's own directives and activation cue on top of
the payload FR-031 promises is evidence-only, and the stub-client test design cannot detect it.
CRIT-002 is a capability claim the spec presents as verified: `SessionPromptData.body.tools` is a
per-tool-name boolean map, which does not express "tool-calling disabled", and the STRIDE table records
a PASS on elevation of privilege on that basis.

The fourteen MAJOR findings cluster in three places. The composer's budget arithmetic does not support
the five families that each claim a slot in the same turn (MAJ-001), and FR-005 contradicts itself after
the F-01 fix (MAJ-002). The phase model is incomplete (three unreachable phases, MAJ-003) and scoped to
the session while the work is scoped to the story (MAJ-004), so elevate fires mid-plan. The intake
classification path — the newest and least-tested mechanism — rests on two undefined terms (MAJ-005),
uses length as a proxy for scope in a way that provably misses short multi-story asks (MAJ-006), and has
no frequency bound, hook site or cost budget (MAJ-007).

On the question this round was asked to settle: rev 2 applied all nine prior findings as text, but only
three (F-05, F-06, F-09) resolved the underlying defect. F-01 and F-03 introduced new defects while
closing the reported ambiguity; F-02, F-04 and F-07 left the requirement improved but the verification
hollow — each is now asserted by a success criterion with no dataset or test behind it. The pattern is
consistent: findings were addressed at the requirement text and not carried through to the traceability,
dataset and test layers, which is also where the four uncovered acceptance scenarios (MAJ-011) come from.

### Recommended next actions

- [ ] CRIT-001 — add FR-036 self-created-session exclusion; add an integration (not stub) test over a simulated child session
- [ ] CRIT-002 — verify deny-all `tools` against a running host; add FR-030b with the concrete mechanism and a refuse-to-send path
- [ ] CRIT-003 — add the zero-criteria fallback to FR-015, a regression-table row, a BDD scenario and test 41
- [ ] MAJ-001 / MAJ-002 — decide the budget's scope and restate FR-004/FR-005 with a per-family cap table and turn-indexed cooldowns
- [ ] MAJ-003 / MAJ-004 — publish the full phase transition table; scope phase per story; gate elevate on the final story
- [ ] MAJ-005 / MAJ-006 / MAJ-007 — enumerate `SEQUENCING_WORDS` and `IMPERATIVE_VERBS`; replace the length gate with a once-per-task cost gate; add FR-018b (hook site, caps, timeout) and a pre-filter dataset
- [ ] MAJ-008 / MAJ-014 — add FR-013a (pins keying, lock, expiry, deletion) and subturn `session.delete` cleanup; add test 40 and retarget SC-013
- [ ] MAJ-009 — extend the strict scan to all three payload fields; define the scan; add four hygiene dataset rows
- [ ] MAJ-010 — move the pre-commitment prompt to a phase-entry injection (FR-023a) with a scenario and test
- [ ] MAJ-011 — add BDD scenarios and tests for US-1 AS-3, US-6 AS-1, US-8 AS-1, US-10 AS-1 and the verifier happy path; correct the Completeness check
- [ ] MAJ-012 — add `VERTEX_V2=0` and reversible archival (FR-036/FR-022); add SC-014
- [ ] MAJ-013 — decide the frontier proactive-fix license: delete the profile qualifier, or add FR-029a with hard bounds
- [ ] Fix MIN-001…MIN-009 and answer the ten unasked questions, encoding each decision into the spec

**Verdict: BLOCK**

Review written to: `docs/vertex2-spec-review.md`

To address these findings and update the spec, run:

```bash
/plan-spec --revise docs/vertex2-spec.md docs/vertex2-spec-review.md
```
