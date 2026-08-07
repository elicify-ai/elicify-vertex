# Adversarial Review (Second Pass): Wave-Based Parallel Story Execution — US-16 Rewrite

**Spec reviewed**: `/home/dev/elicify-vertex/docs/vertex2-waves-spec.md` (1938 lines, 83 FRs, 68 BDD scenarios, 87 planned tests, 16 user stories)
**First-pass review**: `/home/dev/elicify-vertex/docs/vertex2-waves-spec-review.md` (BLOCK, 45 findings)
**Review date**: 2026-07-27
**Verdict**: **BLOCK**

> This is a *second-pass* review. It is written to a new file so the first-pass review is
> preserved — the spec has not yet been revised against it, so every one of its findings
> still needs an owner.

## Executive Summary

The spec has not been revised against the first review: FR-001…FR-065 are byte-for-byte
what they were, and all 10 prior CRITICALs and all 21 prior MAJORs still stand. The only
substantive change is the US-16 rewrite (new FR-067a, FR-076…FR-081, four new acceptance
scenarios, three new BDD scenarios, five new tests). That rewrite makes the intake gate
*worse*, not better, in three verified ways: **FR-067a cannot do what it claims** — the v1
SDK's `session.prompt` returns the *assistant* message, not the user message it creates, so
`harnessAuthoredIds` would contain only ids `isUserMessage` already rejects; **the autonomous
branch is unreachable** — FR-067's unconditional confirmation requirement plus FR-077's
definition of "interactive" mean any session that can plan is by definition interactive, so
FR-080 is dead code; and **the interactive/autonomous split does not detect an absent human**,
only a never-present one, so the spec's own motivating field session (93 messages, 2 user
messages) is classified interactive and walks into a question gate that FR-081 explicitly
refuses to time out.

| Severity | New this pass | Carried forward (unaddressed) | Total live |
|---|---|---|---|
| CRITICAL | 4 | 10 | 14 |
| MAJOR | 10 | 21 | 31 |
| MINOR | 4 | 9 | 13 |
| OBSERVATION | 1 | 5 | 6 |
| **Total** | **19** | **45** | **64** |

**Grounding note**: every SDK claim below was verified against the installed
`@opencode-ai/sdk@1.18.4` and `@opencode-ai/plugin` type surfaces in `node_modules`, and every
codebase claim against the shipped source at the cited `file:line`. New findings are numbered
`C2-xxx` / `M2-xxx` / `m2-xxx` to avoid collision with the first review's ids.

---

## Part A — Status of the first review's findings

The spec text for every section the first review cited is unchanged. Verified by re-reading
the cited lines.

### CRITICAL

| Prior ID | Status | Evidence in current spec |
|---|---|---|
| CRIT-001 whole-file archival destroys other sessions' plans | **STANDS unchanged** | FR-018 (line 1626) still says "archived to `archive/plan.<ISO-8601>.json` by atomic rename, byte-identically"; SC-005 unchanged. |
| CRIT-002 archival not on every `persistPlan` path | **STANDS unchanged** | Impact Assessment note (line 87) unchanged; no FR moves the trigger into `persistPlan`. |
| CRIT-003 `getActiveStory` "first active" corrupts phase state | **STANDS unchanged** | Assumption line 1909 and Ambiguity #2 (line 1842) verbatim; still 3 FRs for 11 call sites. |
| CRIT-004 verification story disables the scope watchdog | **STANDS unchanged** | FR-007/FR-011/FR-026 (lines 1615, 1619, 1634) verbatim. |
| CRIT-005 wave gate unsatisfiable (volatile, capped, wiped receipt store) | **STANDS unchanged** | FR-022 (line 1630), Assumption line 1906 ("path-scoped invalidation is out of scope"), Ambiguity #3 ("**Spec defers it**") all verbatim. See **M2-002** — the "freeze at checkpoint" decision the author believes was recorded is *not in the document*. |
| CRIT-006 idle re-validation livelocks resumed sessions | **STANDS unchanged** | FR-038/FR-038a (lines 1652-1653) verbatim. Same M2-002 caveat. |
| CRIT-007 intake gate makes autonomous work impossible | **PARTIALLY ADDRESSED, NOT FIXED — and now self-contradictory** | FR-077/FR-080 gesture at the autonomous case but FR-067/FR-068 remain unconditional. See **C2-002**. |
| CRIT-008 `isUserMessage` does not prove *human* confirmation | **PARTIALLY ADDRESSED, MECHANISM UNIMPLEMENTABLE** | FR-067a added; it records the wrong id. See **C2-001**. |
| CRIT-009 D1 covering-verifier rules contradict each other | **STANDS unchanged** | FR-033…FR-037 (lines 1644-1648) and Ambiguity #7 verbatim. |
| CRIT-010 `acquireStateLock` throws on contention | **STANDS unchanged** | Edge Case line 468 still claims "serialised by the existing directory lock; both persist". |

### MAJOR

All 21 stand unchanged. Spot-verified: MAJ-001 (Behavioral Contract lines 436-437 and
Ambiguity #6 line 1846 still state the pre-FR-038 verifier policy; Assumption line 1911 repeats
it); MAJ-002 (FR-001…FR-038 still collide with `docs/vertex2-spec.md`, and the FR range has
*grown* to FR-081); MAJ-003 (Cluster Placement line 101 still says "does **not** touch the
receipt, redaction, verifier, or measurement clusters" — now false three times over, since
FR-080 adds a *third* verifier-payload change); MAJ-009 (FR-044 line 1659 lists four reasons
including `timeout`, SC-013 line 1730 lists `unsupported`/`timeout`/`malformed`, and the real
API returns `unsupported`/`unavailable`/`malformed`); MAJ-013 (**nothing** in the document
creates or stores an intake record, or defines "the proposal" whose timestamp FR-068 compares
against — the rewrite adds six more FRs on top of that non-existent surface); MAJ-020 (the
Completeness check at line 1833 still claims coverage only for "FR-001 … FR-032", now 49 of
81 FRs unclaimed; SC-006 still says "≥42 new tests" against an 87-entry plan); MAJ-021 (no
registration FR for any new tool or command).

**Superseded**: none. **Newly worsened**: MAJ-003, MAJ-004 (US-16 now feeds *two* directives
into the 5-way contention for `INVOCATION_BUDGET = 2`), MAJ-012 (a third piece of unspecified
state, `harnessAuthoredIds`, now on the security-critical path), MAJ-013, MAJ-020.

---

## Part B — New findings against the US-16 rewrite

### CRITICAL

#### [C2-001] FR-067a is a no-op — `session.prompt` returns the *assistant* message, not the user message it creates

- **Lens**: Infeasibility / Insecurity (Spoofing)
- **Affected**: FR-067a (line 1698), FR-067, FR-077, US-16 prose line 404, test 84 `interactive_detection_excludes_harness_messages`
- **Description**: FR-067a says "The harness MUST record the message id of every message it
  originates via `session.prompt` in a `harnessAuthoredIds` set". Verified against the
  installed SDK:

  ```ts
  // node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts:2281
  export type SessionPromptResponses = {
      200: { info: AssistantMessage; parts: Array<Part> };
  };
  // :98  export type AssistantMessage = { id: string; ...; role: "assistant"; ... }
  ```

  The only id `session.prompt` hands back is the **assistant reply's** id. The `role: "user"`
  message the prompt body creates is never returned. So `harnessAuthoredIds` would be
  populated exclusively with ids for which `isUserMessage` (`wiring/tools.ts:55-70`) already
  returns `false` — the exclusion blocks nothing that was not already blocked, and the
  harness-authored *user* message that CRIT-008 identified remains a valid
  `confirmedByMessageId`.

  Two further defects make even a corrected version non-trivial:
  1. **Timing.** `session.prompt` resolves only after the assistant turn completes. The
     `plan_create` call the gate is protecting happens *inside* that turn. An id captured
     from the response therefore arrives strictly after the moment it is needed.
  2. **The current call site discards it.** `gate.ts:100-113` races the prompt against a 30 s
     timeout and ignores the resolved value entirely; on timeout the promise result is never
     observed at all, while the message still exists in the session.
- **Impact**: FR-067a as written provides zero additional security, and FR-077 — which the
  spec designates the *single definition of "a human is present"* — is built on top of it. Both
  the confirmation gate (FR-067) and the interactive/autonomous split (FR-077, FR-078, FR-080)
  rest on a set that will be empty of every id that matters.
- **Recommendation**: State an implementable mechanism. Two exist:
  - **(a)** Supply the id. `SessionPromptData.body.messageID?: string`
    (`types.gen.d.ts:2246`) lets the caller name the message it is creating. Require every
    harness `session.prompt` to generate an id, insert it into `harnessAuthoredIds` **before**
    the call, and pass it as `body.messageID`. This is the only route that is correct by
    construction. (Note the current call sites cast the body `as never` — `gate.ts:105`,
    `index.ts:1402` — so the extra field is type-invisible today.)
  - **(b)** Observe the reentry. `chat.message`'s input carries `messageID?: string`
    (`@opencode-ai/plugin/dist/index.d.ts:194`), and the harness already detects its own
    reentrant message via `state.idleContinuationInFlight` (`plugin.ts:367-369`). Record the
    id there. **If (b) is chosen, the spec must also close its hole**: that flag is cleared in
    a `finally` after the 30 s race (`gate.ts:118-120`), so a continuation that takes longer
    than 30 s clears the flag before its reentrant `chat.message` lands — at which point the
    harness's own message is treated as genuine user intent (activates the session, resets the
    turn via `composer.newTurn`, resets phase) *and* becomes a valid `confirmedByMessageId`.
  Add the negative test the first review asked for, and add a second: "a continuation whose
  `session.prompt` exceeds the 30 s race is still recorded in `harnessAuthoredIds`."

---

#### [C2-002] FR-067 and FR-077 make the autonomous branch unreachable — FR-080, AS-12 and test 83 describe a state that cannot lead to a plan

- **Lens**: Inconsistency / Infeasibility
- **Affected**: FR-067, FR-067a, FR-068, FR-077, FR-080, US-16 AS-12, BDD "An autonomous session assumes instead of asking" (line 1392), tests 83/84
- **Description**: Compose the requirements as written:
  - FR-067 + FR-068: **every** non-trivial `plan_create` requires a `confirmedByMessageId`
    resolving via `isUserMessage` to a message postdating the proposal. FR-072 exempts only
    `TRIVIAL_ASK_RE` asks. There is no conditional clause anywhere.
  - FR-067a: that message must not be harness-authored.
  - FR-077: a session is `interactive` **iff** "a genuine, non-harness-authored user message
    has occurred in it".

  Therefore: *the existence of a valid `confirmedByMessageId` is definitionally sufficient to
  classify the session `interactive`.* Every session in which `plan_create` can succeed is
  interactive. `autonomous` sessions can never create a plan, so FR-080's resolution path
  ("surviving unknowns resolve as `ASSUMED` … and are included in the verifier payload at close")
  leads nowhere — there is no plan, so there is nothing to close, and FR-038a forbids invoking
  the verifier when no plan exists.
- **Impact**: CRIT-007 is not fixed; it is relabelled. The first review's core objection —
  "the intake gate makes the autonomous multi-story operation this feature exists to enable
  structurally impossible" — is now *encoded in the requirements themselves* rather than merely
  implied by them. Test 83 `autonomous_assumes_without_asking` can only ever assert the
  negative half ("no question tool call"); the half that matters ("and work proceeds") is
  unreachable. AS-12's "those assumptions are included in the verifier payload at close" is
  untestable for the same reason.
- **Recommendation**: Decide and state, as an FR, what an autonomous session is permitted to
  do. The minimum coherent version: "In an `autonomous` session, `createPlan` MUST accept an
  intake record with no `confirmedByMessageId` when every `UNKNOWNS` entry is `ASSUMED` with a
  recorded grounding attempt and a stated risk; the plan MUST record `confirmationMode:
  "assumed"` and every such assumption MUST be surfaced in `plan_status` and in the verifier
  payload." Then make FR-067's confirmation requirement explicitly conditional on FR-077's
  classification, and re-derive the Scenario Outline at line 1312 (its four rows currently
  assert unconditional rejection).

---

#### [C2-003] "Interactive" means *ever-was-present*, not *is-present* — the spec's own field session deadlocks on the question gate

- **Lens**: Incorrectness / Infeasibility
- **Affected**: FR-077, FR-078, FR-081, US-16 prose lines 404-409, Clarification line 1937, D4 field data (line 28ff), US-10, US-14
- **Description**: FR-077 classifies on history ("a genuine … user message **has occurred**"),
  and nothing ever declassifies. US-16's prose (line 404) glosses this as "a human is present"
  and line 409 claims "The interactive/autonomous split above is what handles an absent human."
  It does not. It detects a human who was *never* present. It cannot detect a human who left.

  The spec's own motivating evidence is exactly the second case: the field session is described
  as "a 1h34m live session … 93 messages, **2 user messages all session**". Both user messages
  are genuine, so that session is `interactive` from message 1 and stays interactive for the
  remaining 91 messages during which nobody is watching. FR-078 then blocks `plan_create` until
  a `question` tool call is observed; the host `question` tool blocks the model's turn awaiting
  an answer; FR-081 explicitly refuses any harness-side release.

  Worse, the recovery paths the spec relies on are unavailable in exactly this state: while a
  question is outstanding the model's turn has not ended, so `session.idle` does not fire, so
  none of FR-046 / FR-050 / FR-038 can run. There is no continuation that can rescue it and no
  timeout that can end it.
- **Impact**: The gate hangs the precise scenario the feature exists to serve, with no
  diagnostic and no escape (MAJ-019 — still no kill switch for the intake gate). An operator
  who steps away from a long run returns to a session stopped on an unanswered question.
- **Recommendation**: Define presence with **recency**, not history: e.g. a session is
  `interactive` only if a genuine non-harness user message occurred within the last N minutes
  or within the last K idles, and `autonomous` otherwise, with the threshold configurable and
  logged on transition. Alternatively downgrade FR-078 from a hard `plan_create` block to a
  `correction`-priority directive plus an FR-080-style assumption path, so an unanswered
  question degrades instead of deadlocking. Whichever is chosen, add an FR stating what happens
  when a question is outstanding at `session.idle`, and add the intake gate to the kill-switch
  FR that MAJ-019 already requires.

---

#### [C2-004] FR-078's observable does not prove the right unknown was asked — and the gate is satisfiable with one unrelated question, or bypassed by declaring no unknowns

- **Lens**: Ambiguity / Insecurity (Elevation of Privilege over the evidence bar)
- **Affected**: FR-078, FR-079, FR-069, FR-070, US-16 AS-10/AS-11, BDD "An interactive session must ask surviving unknowns" (line 1379), tests 81/82
- **Description**: FR-078's entire observable is "*a* `tool === "question"` call in
  `tool.execute.after`". Three independent holes:
  1. **No binding between question and unknown.** Nothing associates an observed question with
     any `UNKNOWNS` entry. A record with five surviving unknowns is unblocked by one question
     about anything at all — including a question the model asks for unrelated reasons. The
     term "surviving unknown" is never defined in the document (is it any entry not `ANSWERED`?
     any entry whose grounding yielded nothing? a subset the model nominates?).
  2. **The list is model-authored.** `UNKNOWNS` is a field of a record the model writes. FR-069
     requires "≥1 generated potential misreading" and "an `UNKNOWNS` list", but nothing
     cross-checks the misreadings against the unknowns or requires the list to be non-empty
     *after* grounding. Declaring zero surviving unknowns bypasses FR-078 entirely, and FR-074's
     principle ("do not accept a self-report as a gate") is being violated by the very
     requirement meant to enforce it.
  3. **`tool.execute.after` observes completion, not asking.** The hook fires after the tool
     returns (`plugin.ts:459`), and returns early unless `state.active` (`plugin.ts:461-462`).
     For a blocking `question` tool, "returned" means *answered or rejected*. So FR-078 as
     specified actually gates on the human having **answered** — which contradicts AS-10's
     wording ("surviving unknowns must be asked") and converts every unanswered question into a
     permanent `plan_create` block (see C2-003). The spec never states which of asked/answered
     is intended, nor what the gate does on a host where the `question` tool is unavailable.
- **Impact**: The gate is simultaneously too weak (one throwaway question, or an empty unknowns
  list, unblocks planning) and too strong (an unanswered question blocks it forever). Test 81
  `interactive_must_ask_surviving_unknowns` will be written against whichever reading the
  implementer picks, and will pass either way.
- **Recommendation**: Bind the observation to the artifact. Add FRs: each `UNKNOWNS` entry
  carries an id; an observed `question` call MUST be recorded against exactly one unknown id
  (matched by the model supplying the id, or by the harness recording the question's `callID`
  and requiring the record to cite it); `createPlan` MUST reject while any entry marked
  `surviving` lacks a recorded question. Define "surviving unknown" in the glossary. State
  whether the gate is "asked" or "answered", and state the behaviour when `question` is not a
  registered tool on the host.

---

### MAJOR

#### [M2-001] FR-076's grounding attempt is self-asserted — it contradicts FR-074's own stated principle, and the checkable version is already available

- **Lens**: Inconsistency / Infeasibility
- **Affected**: FR-076, FR-074, US-16 prose lines 396-402, AS-9, BDD line 1367, test 80 `assumed_unknown_requires_grounding`
- **Description**: FR-074 rejects a self-reported confidence score because it is "a calibration
  task models perform badly and is trivially gameable". FR-076 then requires each `UNKNOWNS`
  entry to "record a grounding attempt (which of codebase / available datasources / web research
  were consulted and what they yielded)" — a free-text field the same model writes about its own
  behaviour, gating nothing but its own presence. The validator can only check that the field is
  non-empty. Test 80 can assert nothing stronger.

  This is avoidable: the plugin **already observes** the tool calls that constitute grounding.
  `tool.execute.after` sees every `read` / `grep` / `glob` / `webfetch` / `task` call
  (`plugin.ts:459-483`), and `KNOWN_TOOL_NAMES` (`wiring/config.ts:71-95`) enumerates them. A
  checkable requirement is one line away.
- **Recommendation**: Replace the self-report with an observation: "An `ASSUMED` resolution MUST
  NOT be accepted unless ≥1 `read`/`grep`/`glob`/`webfetch` tool call has been observed in this
  session since the intake record was opened, and the entry MUST cite at least one observed
  call." Keep the free-text "what it yielded" as documentation, not as the gate. If the observed
  call set is judged too coarse to attribute per-unknown, say so explicitly and drop FR-076 to a
  directive rather than a validator rule — an unenforceable MUST is worse than an honest SHOULD.

#### [M2-002] The "evidence frozen at checkpoint" decision is **not in the spec** — CRIT-005 and CRIT-006 are wholly unaddressed

- **Lens**: Incompleteness / Inconsistency
- **Affected**: Clarifications (lines 1919-1938), FR-022, FR-038a, Assumption line 1906, Ambiguity #3, CRIT-005, CRIT-006
- **Description**: The document contains exactly one occurrence of the phrase, and it is an
  **illustrative example of a question option label** inside FR-079's question-shape paragraph:

  > line 411 — "…the recommendation MUST be encoded in the option label (e.g. `"Freeze at
  > checkpoint (Recommended)"`)…"

  There is no Clarification Q&A recording the decision, no FR implementing it, no BDD scenario,
  no test, and no success criterion. Meanwhile the two places that *do* record a decision on this
  question still record the opposite one: Assumption line 1906 ("Receipt invalidation remains
  session-global; path-scoped invalidation is out of scope for this change") and Ambiguity #3
  ("Agent accepts the risk and documents it; does not implement path-scoped invalidation. …
  **Spec defers it.**").
- **Impact**: Anyone reading the spec — including the implementer — will conclude the decision was
  never taken, and will build the deferred behaviour. CRIT-005 (wave gate unsatisfiable) and
  CRIT-006 (resumed sessions livelock) remain live, and the first review's assessment that
  "FR-022 cannot be honestly tested" is unchanged.
- **Recommendation**: If the decision was made, write it down: add the Clarification Q&A, add FRs
  ("`checkpoint` MUST embed a sanitised copy of each cited receipt — workspace root, command,
  exit code, `observedAt` — into the acceptance item at attach time"; "the FR-038a evidence check
  MUST validate against the persisted copy, treating an absent in-memory receipt as evidence from
  a previous process"), rewrite Assumption line 1906 and Ambiguity #3, add the BDD scenario and
  the cross-session test the first review specified, and add a success criterion. Six FRs were
  added for US-16 while the two findings the first review called blocking received none.

#### [M2-003] `harnessAuthoredIds` has no specified storage, lifetime or scope — and it now carries two gates

- **Lens**: Incompleteness / Ambiguity
- **Affected**: FR-067a, FR-077, Symbols Involved table (lines 59-73), Impact Assessment (lines 77-86)
- **Description**: The set is introduced in FR-067a and immediately made load-bearing twice: it
  filters `confirmedByMessageId`, and FR-077 makes it "the single definition of 'a human is
  present'". The spec never says where it lives, how long it lives, or whether it is per-session
  or per-process. It is absent from Symbols Involved, absent from the Impact Assessment, and
  absent from `V2SessionState` (`wiring/state.ts:34-123`), the only comparable structure — which
  is an in-memory `Map` rebuilt on every process start.
- **Impact**: If in-memory (the default an implementer would reach for), then after any restart
  every previously dispatched harness continuation is unknown to the set. An old harness message
  is then (a) a valid `confirmedByMessageId` and (b) sufficient to classify the session
  `interactive`. Both gates fail open across a restart, silently. If persisted, it is a new state
  file with no defined schema, location, growth bound or GC — none of which the spec mentions.
- **Recommendation**: State the storage explicitly. If it must survive restarts to be sound (it
  must, for the confirmation gate), specify the file, the schema, the retention bound and the GC
  cadence, and add it to Symbols Involved and the Impact Assessment. Add a test: "a harness
  continuation dispatched before a process restart is still rejected as `confirmedByMessageId`
  after it."

#### [M2-004] FR-079 cites a type the plugin cannot see, and is enforced by nothing

- **Lens**: Infeasibility / Incompleteness
- **Affected**: FR-079, US-16 prose line 411, AS-11, test 82 `question_shape_options_and_recommendation`
- **Description**: FR-079 specifies the question's shape in terms of `QuestionOption` /
  `QuestionInfo`. Verified: those types exist **only** on the v2 SDK surface
  (`@opencode-ai/sdk/dist/v2/gen/types.gen.d.ts:522` and `:538`). The plugin receives the v1
  client — `PluginInput.client: ReturnType<typeof createOpencodeClient>` from `@opencode-ai/sdk`
  (`@opencode-ai/plugin/dist/index.d.ts:36`) — and the entire v1 type surface contains **zero**
  occurrences of the string "question" (`dist/gen/types.gen.d.ts`, `dist/gen/sdk.gen.d.ts`,
  `dist/index.d.ts`, `dist/client.d.ts` — all 0). The one plugin-side question API is on the
  **TUI** surface (`@opencode-ai/plugin/dist/tui.d.ts:309`), which a server plugin does not get
  (`PluginModule.tui?: never`).

  So the harness can inspect a question only as the untyped `toolInput.args` of a `question` tool
  call, and the spec never states that args shape or how it maps onto `QuestionInfo`. Separately,
  **no requirement makes FR-079 a gate**: FR-078 blocks on the *existence* of a question call, not
  its shape, so a malformed question satisfies the only gate there is. Test 82 therefore tests a
  helper that nothing in the enforcement path calls.

  Three unaddressed shape problems: `QuestionOption.label` is documented as "Display text (1-5
  words, concise)" — `" (Recommended)"` consumes one of those five and may be truncated by the
  host; `QuestionInfo.multiple?: true` makes "exactly one recommended" incoherent; and
  `QuestionInfo.custom?: true` permits a free-text answer that corresponds to no option.
- **Recommendation**: State the observable contract in terms of the `question` tool's **args**
  (the only thing the plugin can see), not the v2 types. Then either make FR-079 enforceable —
  "`createPlan` MUST reject when a recorded question's observed args carry <2 options or ≠1 label
  ending in `(Recommended)`" — or demote it to directive text and remove test 82's implied gate.
  Add rows for `multiple: true` and `custom: true`.

#### [M2-005] FR-081's factual claim is verified true, but its conclusion does not follow

- **Lens**: Incorrectness
- **Affected**: FR-081, US-16 prose line 409, Clarification line 1937
- **Description**: The claim checks out exactly as stated. Reply/reject exist only at
  `@opencode-ai/sdk/dist/v2/gen/sdk.gen.d.ts` (`session.question.reply` / `.reject`, ~lines
  1607-1620; global `question.reply` / `.reject`, ~lines 844-860), and the v1 client exposes no
  `question` namespace at all. A harness-side *answer* is genuinely unavailable.

  But "therefore no timeout" is a non-sequitur. A timeout does not require answering the question
  — it requires bounding the harness's own gate. The harness fully controls `plan_create`,
  `session.idle` and `session.prompt`, and could bound the wait by relaxing FR-078 after N idles
  (permitting `ASSUMED` with the outstanding question recorded as the risk). FR-081 as written
  converts an SDK limitation into a permanent hang (C2-003).

  FR-081 also under-states the limitation in a way that matters: the v1 **event** union has no
  question events either, so the harness cannot observe that a question is *outstanding* — only
  that one has *completed*, via `tool.execute.after`. It therefore cannot distinguish "asked and
  waiting" from "never asked", which is precisely the discrimination C2-003 and C2-004 need.
- **Recommendation**: Keep the factual paragraph (it is correct and worth recording) but replace
  the conclusion: state that a harness-side *auto-answer* is out of scope, and specify a
  harness-side *gate relaxation* instead. Add the observability gap explicitly to the Integration
  Boundaries section — "the v1 client surfaces no question state; only completed `question` tool
  calls are observable" — because two requirements depend on it.

#### [M2-006] "Intake" now names two unrelated subsystems in adjacent requirements

- **Lens**: Ambiguity (naming)
- **Affected**: FR-050, FR-066…FR-081, US-13 AS-5, US-16, BDD line 1204
- **Description**: FR-050 reads "When **intake** classified the ask as multi-story and no plan
  exists…". That "intake" is the shipped ask classifier: the `vertex-intake` zero-tool subagent
  (`story.ts:886`, registered at `wiring/config.ts:146`) whose result sets
  `state.multiStoryPending` (`plugin.ts:421`). FR-066…FR-081's "intake record" is a
  requirements-understanding artifact that does not exist yet and shares no code with it. The
  existing `intakeScaffoldFinding` (`wiring/findings.ts:95`) is a *third* use of the word, cited
  in US-16's opening paragraph.
- **Recommendation**: Rename one. "Ask classification" for the FR-050 sense (matching
  `classifyAsk`'s own name) and "requirements record" for the US-16 artifact would remove the
  collision without touching either subsystem.

#### [M2-007] The intake gate and FR-050 compose into a deterministic livelock ending in silence

- **Lens**: Incorrectness / Inoperability
- **Affected**: FR-050, FR-066, FR-067, FR-067a, MAJ-010 (unfixed)
- **Description**: FR-050 dispatches up to `maxPlanProposalContinuations` (3) continuations
  telling the agent to create a plan. Each is a harness `session.prompt` message, which FR-067a
  explicitly disqualifies as confirmation. In any session where the human has stopped replying
  (C2-003's case), the loop is: continuation → agent calls `plan_create` → rejected for want of a
  confirming user message → idle → continuation → … three times, then nothing. No plan exists, so
  FR-046/FR-048 have nothing to drive and FR-038a keeps the verifier uninvoked. MAJ-010 is unfixed,
  so no event, toast or `plan_status` field records that the session gave up.
- **Impact**: D3 — "a long autonomous run ends silently at 20% completion" — reproduced exactly,
  now reached through the new gate rather than around it.
- **Recommendation**: Add an FR stating what the idle driver does when `plan_create` is blocked by
  intake: at minimum, log a distinct terminal event naming the blocking precondition, emit an
  FR-061 warning toast, and include it in `plan_status`. This is the same requirement MAJ-010
  asked for, extended to the intake precondition.

#### [M2-008] No success criterion covers FR-067a or FR-076…FR-081

- **Lens**: Infeasibility (unmeasurable requirements)
- **Affected**: SC-001…SC-020 (lines 1718-1739), FR-067a, FR-076…FR-081
- **Description**: The Success Criteria section is unchanged; the newest entry is SC-020
  (visibility). Seven new requirements — including the two on the security-critical path
  (FR-067a, FR-077) and the one that can deadlock a session (FR-078) — ship with no measurable
  acceptance bar. Meanwhile SC-006 still reads "≥42 new tests" against an 87-entry plan, and the
  traceability Completeness check (line 1833) still claims verification only for "FR-001 …
  FR-032" — now 49 of 81 FRs unclaimed, up from 43 of 76.
- **Recommendation**: Add criteria that bite, e.g.: "SC-021: a harness-dispatched continuation is
  rejected as `confirmedByMessageId` in 100% of attempts, including after a process restart";
  "SC-022: in a replay of the field session (`ses_0668b2422ffe4hbFM3AkIerZmp`), `plan_create` is
  reachable — the intake gate does not block a session with 2 user messages over 93 turns";
  "SC-023: an `ASSUMED` entry with no observed grounding tool call is rejected in 5/5 cases".
  Raise SC-006 and extend the Completeness check to FR-081.

#### [M2-009] The happy-path scenario contradicts FR-078, and four requirements give three different answers on whether `ASSUMED` is legal in an interactive session

- **Lens**: Inconsistency
- **Affected**: BDD "A confirmed intake permits planning" (line 1332), test 75, FR-070, FR-076, FR-078, FR-080
- **Description**: The happy-path scenario is *"Given a valid intake record whose unknowns are all
  resolved / And a `confirmedByMessageId` resolving to a genuine user message sent after the
  proposal / When `plan_create` is called / Then the plan is created."* By FR-077, the presence of
  that genuine user message makes the session `interactive`. FR-078 then requires an observed
  `question` call before `plan_create` may succeed — a precondition the scenario neither states
  nor satisfies. Test 75 as specified passes exactly the case FR-078 must block.

  Underneath sits an unresolved question the rewrite introduced: is `ASSUMED` legal in an
  interactive session at all?
  - FR-070 permits `ANSWERED` **or** `ASSUMED`, unconditionally.
  - FR-076 governs `ASSUMED` resolutions generally, implying they are normal.
  - FR-078 blocks planning while any surviving unknown is unasked — so an unknown resolved
    `ASSUMED` without being asked blocks the plan.
  - FR-080 scopes assumption to autonomous sessions ("In an autonomous session … surviving
    unknowns MUST resolve as `ASSUMED`").
- **Recommendation**: Add the missing precondition to the happy-path scenario (either "and all
  unknowns were `ANSWERED` via observed questions" or "and zero unknowns survived grounding"), and
  add one FR settling interactive `ASSUMED`: permitted-with-a-recorded-question, or forbidden. The
  Scenario Outline at line 1312 needs a fifth row for the FR-078 rejection either way — it
  currently has four rows and FR-078's rejection is not among them.

#### [M2-010] FR-072's triviality test is evaluated against an ask `createPlan` cannot see

- **Lens**: Incompleteness
- **Affected**: FR-066 ("the ask is non-trivial"), FR-072, test 78 `trivial_ask_skips_intake`
- **Description**: `TRIVIAL_ASK_RE` lives at `story.ts:777-778` and is applied to raw ask text.
  `StoryEngine.createPlan` (`story.ts:370`) receives stories, not ask text; the ask text is only
  in scope at `chat.message` (`plugin.ts:371-374`). Nothing in the spec says the ask (or its
  classification) is recorded anywhere `createPlan` can read it — the same missing-artifact
  problem MAJ-013 raised for "the proposal" whose timestamp FR-068 compares against.

  Note also that the exemption is close to vacuous *at this gate*: `TRIVIAL_ASK_RE` matches typo
  fixes, `rename X to Y`, questions, `read/show/open/print/explain/describe` and `bump/pin X to
  Y` — none of which produce a `plan_create` call at all. Its real effect is FR-072's second
  clause (suppressing the directive), which is a different mechanism in a different hook.
- **Recommendation**: Specify where the ask text and its triviality classification are persisted
  for the tool layer to read (alongside the intake record and the proposal timestamp MAJ-013
  already requires), and split FR-072 into its two independent halves — the `createPlan`
  exemption and the directive suppression — since they are enforced in different places.

---

### MINOR

#### [m2-001] FR-076's ordering is stated but unverifiable
- **Affected**: FR-076, US-16 prose lines 396-402
- The resolution order (codebase → datasources → web research) is normative prose, but the
  recorded artifact only captures "which were consulted", not the order or why an earlier source
  was insufficient. Either drop the ordering language or require the record to state why each
  earlier source did not resolve the unknown.

#### [m2-002] An answered question cannot produce an `ANSWERED` resolution as FR-070 defines it
- **Affected**: FR-070, FR-078, FR-079
- FR-070 requires an `ANSWERED` entry to carry "the answering user message id, itself verified via
  `isUserMessage`". A question-tool answer is a tool result, not a user message — it has no message
  id to cite. The two resolution mechanisms the rewrite introduces (ask via `question`) and
  inherits (confirm via user message) are never reconciled. State how a question answer becomes an
  `ANSWERED` resolution, and what is verified in place of `isUserMessage`.

#### [m2-003] FR-077's classification has no stated evaluation point
- **Affected**: FR-077, FR-078, FR-080
- The spec never says when the classification is computed (at `plan_create`? at intake open?
  continuously?) or whether it is cached. It is monotonic (autonomous → interactive, never back),
  which matters for a long run and is nowhere stated.

#### [m2-004] "One question per unknown" appears only in prose; no FR requires it, and test 84 is mis-traced
- **Affected**: US-16 prose line 406, FR-078, FR-079, test 84, Traceability Matrix line 1817
- The prose says "one question per unknown"; neither FR-078 nor FR-079 states it, and the BDD
  scenario asserts neither. Separately, test 84 `interactive_detection_excludes_harness_messages`
  is traced to "Scenario: An autonomous session assumes instead of asking" (line 1392), which says
  nothing about harness messages or `harnessAuthoredIds` — the same class of mis-trace as MAJ-020.

---

### OBSERVATION

#### [o2-001] US-16 is now the largest independently-shippable unit in the document and shares no code with the wave model
- **Lens**: Overcomplexity
- US-16 now specifies an intake record store, a grounding record, a `harnessAuthoredIds` set, an
  interactive/autonomous classifier, question observation, and question-shape validation — 17 FRs
  and 13 tests — on top of an artifact whose creation surface still does not exist (MAJ-013). Its
  only coupling to the wave model is that it blocks `plan_create`; it touches none of the schema,
  the receipt store, or the phase engine. OBS-001 already recommended extracting US-15 for
  similar reasons; US-16 is now the stronger candidate. Extracting it would also let the four
  CRITICALs above be settled against a smaller blast radius, and would unblock the D1+D4 increment
  the spec's own final Clarification says must land first.

---

## Structural Integrity — new material only

| Check | Result | Notes |
|---|---|---|
| Every new acceptance scenario (AS-9…AS-12) has a BDD scenario | **PASS** | AS-9 → line 1367; AS-10/11 → line 1379; AS-12 → line 1392. |
| Every new BDD scenario has a `Traces to` | **PASS** | All three carry it and are correct. |
| Every new BDD scenario has a test | **PASS** | Tests 80-84. |
| Every new FR appears in the traceability matrix | **PASS** | FR-067a and FR-076…FR-081 all present (lines 1817, 1826-1831). |
| Every new test traces to a scenario that exercises it | **FAIL** | Test 84 traces to the autonomous scenario, which does not mention `harnessAuthoredIds` (m2-004). Test 82 traces to a scenario whose shape assertion is an "And when…" afterthought. |
| New FRs have success criteria | **FAIL** | Zero SCs for FR-067a and FR-076…FR-081 (M2-008). |
| New requirements are internally consistent | **FAIL** | C2-002 (FR-067 vs FR-077/FR-080), M2-009 (FR-070 vs FR-078 vs FR-080), M2-001 (FR-074 vs FR-076). |
| New requirements are implementable on the shipped SDK | **FAIL** | FR-067a (C2-001), FR-079 (M2-004). |
| New ambiguity warnings recorded for open questions | **FAIL** | The Ambiguity table (lines 1839-1850) is unchanged at 10 entries; the rewrite opened at least four (definition of "surviving unknown", `harnessAuthoredIds` storage, asked-vs-answered, interactive `ASSUMED`) and recorded none. |
| Interaction with the wave model (US-1…US-9) specified | **FAIL** | The gate sits on `plan_create`, the entry point to the entire wave model, and no requirement states what the idle driver does while it is blocked (M2-007). |
| Interaction with deterministic-first idle ordering (FR-038/038a) specified | **FAIL** | While a question is outstanding the model's turn has not ended, so `session.idle` never fires and no ordering applies (C2-003). Unaddressed. |

---

## Test Coverage Assessment — new material

| Category | Gap | Affected |
|---|---|---|
| **Provenance negatives** | No test attempts confirmation with a harness message *after a process restart*, or with a continuation whose `session.prompt` exceeded the 30 s race. Both are the live bypasses. | FR-067a, FR-077, C2-001, M2-003 |
| **Autonomous end-to-end** | Test 83 can only assert "no question asked"; there is no test that an autonomous session reaches a created plan, because C2-002 makes it impossible. | FR-080, AS-12 |
| **Question binding** | No test asserts that an observed question corresponds to a *specific* unknown, or that N surviving unknowns require N questions. | FR-078, C2-004 |
| **Deadlock** | No test drives an interactive session with an unanswered question through `session.idle` and asserts a bounded outcome. | FR-078, FR-081, C2-003 |
| **Grounding observation** | Test 80 can only assert a non-empty field; no test asserts a grounding *tool call* was observed. | FR-076, M2-001 |
| **Question shape enforcement** | Test 82 exercises a validator that no gate calls; no test asserts a malformed question is rejected at `plan_create`. | FR-079, M2-004 |
| **Host degradation** | No test covers a host with no `question` tool registered, or a `question` call that is rejected rather than answered. | FR-078, FR-081 |

---

## STRIDE — intake gate, re-assessed after the rewrite

| Threat | Verdict | Basis |
|---|---|---|
| **Spoofing** (harness message accepted as human confirmation) | **STILL OPEN** | FR-067a records the assistant id, not the user id (C2-001). Additional bypass across restart (M2-003) and across the 30 s continuation race (C2-001). |
| **Tampering** (intake record altered after confirmation) | **OPEN** | No requirement makes the record immutable or tamper-evident after `confirmedByMessageId` is bound. Unchanged from the first review. |
| **Repudiation** (no audit of what was confirmed) | **OPEN** | No event is specified for "intake confirmed by message X", "unknown resolved ASSUMED", or "session classified interactive/autonomous". FR-077's classification drives two gates and is never logged. |
| **Information disclosure** | ok | Intake content flows to the model and the verifier, both already redacted paths — though FR-080 routes assumptions into the verifier payload with no redaction requirement stated (see MAJ-003, verifier.ts still absent from the impact assessment). |
| **Denial of service** | **WORSENED** | Previously: `isUserMessage` fails closed on client error, blocking planning (CRIT-007). Now additionally: an unanswered `question` blocks `plan_create` **and** the model's turn, with FR-081 explicitly refusing a release (C2-003). Self-inflicted, deterministic, no kill switch (MAJ-019 unfixed). |
| **Elevation of privilege** (planning without understanding) | **OPEN** | One unrelated question, or a self-declared empty `UNKNOWNS` list, satisfies the gate (C2-004); a self-asserted grounding string satisfies FR-076 (M2-001). |

---

## Unasked Questions

1. `session.prompt` returns `{info: AssistantMessage, parts}`. Which id, exactly, does the harness put in `harnessAuthoredIds`, and how does it know it before the turn in which `plan_create` is called? (C2-001)
2. If a valid `confirmedByMessageId` definitionally makes the session interactive, in what session can FR-080's autonomous path ever produce a plan? (C2-002)
3. The field session had 2 genuine user messages across 93 messages and 1h34m. Is it interactive or autonomous — and if interactive, what ends the turn when the mandated `question` goes unanswered? (C2-003)
4. What binds an observed `question` tool call to a specific `UNKNOWNS` entry? What stops one question from clearing five unknowns? (C2-004)
5. What is a "surviving unknown", precisely, and who decides that an unknown survived grounding? (C2-004)
6. Is the FR-078 gate "asked" or "answered"? `tool.execute.after` can only tell you the latter. (C2-004)
7. What, mechanically, distinguishes a genuine grounding attempt from a string that says one happened? (M2-001)
8. Where is the decision that evidence is frozen at checkpoint? It appears in this document only as an example question label. (M2-002)
9. Where does `harnessAuthoredIds` live, and what happens to both gates after a process restart? (M2-003)
10. The plugin holds a v1 client with no `question` types at all. Against what does it validate FR-079's option shape? (M2-004)
11. If the harness cannot answer a question, why can it not bound its own gate instead? (M2-005)
12. Which "intake" does FR-050 mean — the `vertex-intake` classifier or the US-16 record? (M2-006)
13. What is logged, toasted or surfaced when `maxPlanProposalContinuations` is exhausted because `plan_create` keeps being rejected by the intake gate? (M2-007)
14. How does an answered question become an `ANSWERED` resolution carrying a *user message id*? (m2-002)
15. Where does `createPlan` read the ask text it must test against `TRIVIAL_ASK_RE`? (M2-010)

---

## Verdict Rationale

**BLOCK.** The spec was not revised against the first review — all 10 prior CRITICALs and all 21
prior MAJORs are live, verified line-by-line — and the one section that *was* revised introduced
four new CRITICALs.

The rewrite's central mechanism does not work. FR-067a exists to close CRIT-008, and it closes
nothing: `session.prompt` on the v1 SDK returns the assistant message, so `harnessAuthoredIds`
would hold only ids that `isUserMessage` already rejects. Because FR-077 designates that same set
"the single definition of 'a human is present'", the failure propagates into the entire
interactive/autonomous split — FR-078's question gate and FR-080's assumption path both inherit a
classification computed from an empty set.

The rewrite is also self-contradictory at the requirements level. FR-067's unconditional
confirmation requirement plus FR-077's definition of interactive mean **every session that can
plan is interactive**, so FR-080, AS-12 and test 83 describe an unreachable state. CRIT-007 is not
fixed; it has been encoded into the requirements rather than merely implied by them. And the split
does not solve the problem it was introduced for: it detects a human who was never present, not one
who left, so the spec's own motivating field session is classified interactive and blocked on a
question that FR-081 refuses to time out — in a state where `session.idle` cannot fire, so no
continuation can rescue it.

Two structural facts should be settled before another revision. First, the "freeze evidence at
checkpoint" decision that was believed to resolve CRIT-005/CRIT-006 **is not in the document** —
its only trace is an illustrative option label — while the two Assumptions that record the opposite
decision are untouched. Those two findings are still the blocking pair for FR-022 and FR-038a.
Second, US-16 has grown to 17 FRs and 13 tests, shares no code with the wave model, and gates its
entry point. It should be its own spec, reviewed on its own, so that the D1 + D4 increment the
spec's own final Clarification calls a prerequisite can ship without it.

### Recommended Next Actions

- [ ] Address the first review's 45 findings — none has been actioned — CRIT-001…CRIT-010, MAJ-001…MAJ-021
- [ ] Replace FR-067a's mechanism with `body.messageID` pre-registration (or `chat.message` `messageID` capture plus the 30 s-race fix) — C2-001
- [ ] Make FR-067's confirmation requirement conditional on FR-077's classification, or delete the autonomous branch — C2-002
- [ ] Redefine "interactive" with recency, and specify what happens when a question is outstanding at idle — C2-003
- [ ] Bind observed questions to specific unknown ids; define "surviving unknown"; state asked-vs-answered — C2-004
- [ ] Replace FR-076's self-report with an observed-tool-call requirement, or demote it — M2-001
- [ ] Write the "freeze evidence at checkpoint" decision into the Clarifications, FRs, BDD and tests, and correct Assumption line 1906 and Ambiguity #3 — M2-002
- [ ] Specify `harnessAuthoredIds` storage, lifetime and restart behaviour; add it to Symbols Involved and the Impact Assessment — M2-003
- [ ] Restate FR-079 against the `question` tool's observable args and make it a gate or a directive, not a MUST nobody enforces — M2-004
- [ ] Replace FR-081's conclusion: no auto-answer, but a bounded harness-side gate — M2-005
- [ ] Rename one of the two "intake" subsystems — M2-006
- [ ] Specify cap-exhaustion behaviour for the intake-blocked path — M2-007
- [ ] Add success criteria for FR-067a and FR-076…FR-081; raise SC-006; extend the Completeness check to FR-081 — M2-008
- [ ] Fix the happy-path scenario's missing FR-078 precondition and settle interactive `ASSUMED` — M2-009
- [ ] Specify where the ask text and proposal timestamp are persisted for the tool layer — M2-010, MAJ-013
- [ ] Record the four ambiguities the rewrite opened in the Ambiguity Warnings table
- [ ] Extract US-16 into its own spec — o2-001, OBS-005
