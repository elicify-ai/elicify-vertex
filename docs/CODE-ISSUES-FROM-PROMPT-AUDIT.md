# Code issues found by auditing the agent prompt

Status: **CLOSED.** Raised 2026-07-28 while rewriting
`agents/elicify-vertex-agent.md`. C-1 retracted (not a defect). C-5 decided
(no code change; reasoning recorded). Every other item —
C-2/C-3/C-4/C-6/C-7/C-8/C-9/C-10/C-11/C-12/C-13/C-14/C-15/C-16 — is
implemented and tested, including the items originally deferred as
pre-existing or higher-risk, on explicit instruction to close every
remaining item, preexisting or not. C-15 was found by adversarial re-review
of C-8/C-9 themselves, during the re-review this same instruction also
required — a gap in the entropy backstop C-8's own fix relied on, plus an
unbounded cost regression in C-9's fix. Both closed; see C-15 for the full
account, including a regression a first attempt at the fix caused and this
session's own verification caught before it shipped. C-16 was found
constructing new host-faithful UAT coverage for C-11/C-12
(`scripts/uat-harness.mjs` section T) — a narrow story-promotion edge case,
initially decided as "documented, not fixed" (a working but non-obvious
recovery path existed), then genuinely fixed on the operator's explicit
instruction to redesign the promotion trigger rather than accept the
workaround.

Each item below was a *prompt rule* compensating for a *code defect*. The rules
have been removed from the prompt — a prompt that teaches the model to route
around a harness limitation hides the limitation and makes it permanent. The
model's behaviour is now the specification; the harness has to meet it.

Ordered by severity.

---

## C-1 — RETRACTED. The harness already reads chained-command exit status correctly

**Status: not a defect.** Verified 2026-07-28 by running `parseVerification`
(frozen v1, `src/index.ts:1152`, backed by `hasReliableAggregateExit` at
`src/index.ts:1136`) directly against seven cases including the exact original
example, before delegating a "fix":

| command | outcome |
|---|---|
| `go test ./... 2>&1; echo "exit:$?"` | `ambiguous` — correct, echo's exit hides go test's |
| `cd myproj && npm test` | `verified` — correct, verifier is the tail |
| `npm test && echo done` | `verified` — correct, `&&` short-circuit guarantees it |
| `npm test; echo done` | `ambiguous` — correct, `;` does not causally depend on npm test |
| `go test ./... \|\| true` | `ambiguous` — correct, `true` always succeeds regardless |
| `npm test \| tail -50` | `ambiguous` — correct, pipe exit status is `tail`'s |
| `npm test` | `verified` — correct |

All seven classify correctly, and it's pinned by 21 existing tests
(`tests/verification.test.ts`). This originally read: *"parse the sub-command
structure... `parseSubcommands`/`isTestRunnerCommand` are the pieces; the
receipt path is what needs to consume them."* That was wrong — the receipt path
already has a separate, correct, well-tested mechanism, and doesn't touch
`coverage.ts`'s `parseSubcommands` for this at all. The original write-up was
never checked against the current code before being filed. Left in place,
struck through in spirit, as a record that the audit itself needs auditing —
see V-4 in the "Test gap" section below.

The real gap was always **C-2** below: the classification is correct, but
nothing tells the *model* about it.

## C-2 — RESOLVED. A passing verifier that mints nothing now gives the model a usable signal

**Severity: high.** Confirmed live 2026-07-28. Implemented and tested in this
diff — `src/v2/plugin.ts`'s `verify:ambiguous-exit` and
`receipt:scope-unverifiable` handling (both inside `tool.execute.after`), each
covered in `tests/v2/plugin.integration.test.ts`. (Line numbers deliberately
omitted here — they drifted twice already as later items added code earlier
in the same file; the event names are stable greppable anchors.)

When the harness declines to mint, the model saw a green test and a blocked
checkpoint with no explanation connecting them. Its observed response was to ask
the user to waive the evidence requirement — the one move that defeats the whole
mechanism.

**Root cause, confirmed by reading `src/v2/visibility.ts`'s own header
comment:** `VisibilityNotifier`/`notify()` calls `client.tui.showToast` — an
"additive channel" for the *human operator*, explicitly separate from
`experimental.chat.system.transform`, which is what actually reaches the
model. Both `verify:ambiguous-exit` and `receipt:scope-unverifiable`
(originally cited here as "the right pattern") route their diagnostic through
`visibility.notify("health", ...)` only. **Neither reached the model.** The
model saw a green test, a blocked checkpoint, and silence — exactly the defect
this item describes — because the fix originally pointed at here had the
identical bug.

**Fix, grounded in a channel proven to work:** the successful-mint branch
appends the receipt id directly to `toolOutput.output` — the bash tool's own
returned text, which the model reads as its tool result. Both
`verify:ambiguous-exit` and `receipt:scope-unverifiable` now append the same
way, alongside the unchanged `visibility.notify` call for the human toast, with
distinct prefixes (`[vertex:verify-ambiguous]`, `[vertex:scope-unverifiable]`)
that can never be mistaken for `[vertex:verification-receipt] <id>`.

## C-3 — RESOLVED. `resolveGoalWorkspaceRoot`'s fallback is now logged

**Severity: medium.** A behaviour regression from v1, not just a prompt issue.
Implemented and tested in this diff — `src/v2/plugin.ts:254-261`, covered in
`tests/v2/plugin.integration.test.ts`'s "C-3" block.

v1's `MultiStoryGoalEngine` constructor (`src/goals.ts:1123`) checked
writability and threw. v2 calls `resolveGoalWorkspaceRoot` once at plugin init
and catches the throw, falling back to `process.cwd()`; `StoryEngine` takes
`stateDir` as a plain string and never re-checks. So a session at filesystem
root writes state to `/` where v1 refused loudly.

The prompt used to carry "if create fails with a writable-directory error, cd
into a real project folder; never `sudo mkdir` under `/`" — advice keyed to an
error string the v2 model can never see.

**Fix:** decided to log rather than restore the throw — a hard failure at
plugin init has far more blast radius than a log line, and the fallback itself
was already a deliberate (if silent) design choice. `plugin.ts` now logs
`workspace:unwritable-fallback` with the candidates tried and the fallback path
whenever the catch branch fires.

## C-4 — RESOLVED. Subagents cannot mint receipts, and now a test says so

**Severity: medium — by design, but was undocumented at the point of use.**
Implemented in this diff — `tests/v2/subagent-receipt-isolation.test.ts`.

`tool.execute.after` returns early at `if (!state || !state.active) return`
(`src/v2/plugin.ts`, top of the hook), and activation requires
`msgInput.agent === opts.activeAgent`, the slash trigger, or a
command-activated session (`chat.message`'s `activatedByAgent` /
`activatedByTrigger` / `activatedByCommand` check). A task-tool subagent has
none, so its verifier runs produce no evidence.

This is deliberate — it is what forces the main agent to verify — but the prompt
had it backwards ("every agent clears its own evidence gate"), which gave the
model a reason to skip its own verification.

**Fix:** the constraint was already correct; the prompt's inversion was
removed separately (see the fan-out-agents section of the prompt rewrite). This
item's own remedy was a test pinning the constraint, so a future change to the
activation condition cannot silently let subagent receipts through — done,
with both a negative case (absent state, and present-but-inactive state — two
distinct ways the guard can be satisfied) and a positive discriminator case.

## C-5 — DECIDED. One-shot injection (C-7) is sufficient by design; no ongoing channel

**Severity: low.** Consequence of the same gate as C-4.

`system.transform` is behind `state.active` (`plugin.ts`, unchanged), so a
subagent gets no plugin-injected procedure for its task signal — no ongoing,
per-turn directive stream, throughout its own work, the way an activated
session gets one.

**What C-7 changed, and what it didn't.** C-7 (below) now injects a static
behaviour preamble once, at the moment a `task` call is dispatched — this
closes the *self-report* half of this item's original framing ("the parent
writes the discipline into the delegation text" is no longer something the
parent has to remember to do; the harness now guarantees it happened). It does
**not** give the subagent's own session `state.active = true`, so it still
receives nothing through `system.transform` for the rest of its own turns.
Confirmed unchanged: `plugin.ts`'s `experimental.chat.system.transform` gate is
still `state.active`-only.

**Decision, made 2026-07-28: the one-shot preamble stays the whole answer. No
ongoing channel will be built.**

Three reasons, not just a preference:

1. **It would reopen C-4's guarantee.** The only way to give a subagent
   `system.transform`'s ongoing directive stream is `state.active = true` for
   its session — but that is the exact flag `tool.execute.after` gates
   receipt-minting on. Turning it on for subagents to solve C-5 would silently
   undo C-4 (subagents cannot mint receipts, tested and deliberate), trading a
   low-severity gap for a high-severity one.
2. **A genuinely separate, receipt-blind directive channel is a new feature,
   not a fix.** It would need its own delivery mechanism (a second
   `tool.execute.before`-style injection point, mid-task rather than at
   spawn), its own scope decision (which findings/directives would even apply
   to a subagent mid-task, when most of this harness's findings are about
   *plan* state a subagent doesn't own), and its own budget/complexity
   analysis. That is real, deliberate scope beyond "fix the issues this audit
   found."
3. **The bounded-task design already has the right answer for this.** A
   subagent's mid-task guidance is supposed to come from the parent's own
   delegation package (CONTEXT/SCOPE/DEFINITION OF DONE, per
   `agents/elicify-vertex-agent.md`'s `<fan_out_agents>`), decided once,
   upfront, by the parent who actually has the context — not from a live
   stream the subagent would have to interpret mid-task with no way to ask
   the parent what it means.

No code changes from this decision — it closes the open question, it doesn't
implement anything new.

## C-6 — RESOLVED end-to-end. `blocked`/`failed` stories can now be reopened

**Severity: medium.** Pre-existing. Implemented and tested end-to-end in this
diff.

`"active"` was assigned only at `createPlan` index 0 and on complete-promotion,
so a plan containing a `blocked` or `failed` story could never reach
all-complete — the idle gate then nudged forever.

**Fix:** `StoryEngine.reopenStory` (`src/v2/story.ts`) resets a blocked/failed
story's status — to `active` immediately if nothing else is active, or back to
`pending` to rejoin the normal successor-promotion queue otherwise — and clears
its acceptance-item evidence so re-completion must be re-proven, never
satisfied by stale receipts. Exposed to the model as
`elicify_vertex_plan_reopen` (`src/v2/wiring/tools.ts`), registered in
`KNOWN_TOOL_NAMES` (`src/v2/wiring/config.ts`) and named in
`agents/elicify-vertex-agent.md`'s `<completion>` section. Proven end-to-end,
not just at the engine level, by `tests/v2/tools.test.ts`'s "C-6 end-to-end"
test: a plan whose *final* story blocks (the exact stuck case) is reopened,
re-completed, and reaches all-complete, driven entirely through the tool's own
`execute` interface.

**Also fixed:** the fix was initially built but not surfaced at the moment the
harness itself detects a stalled plan — `wiring/findings.ts`'s
`incompletePlanFinding`, the exact nudge dispatched on `session.idle` when no
story is active, did not mention `elicify_vertex_plan_reopen`. It now names the
tool explicitly whenever the stall is caused by a blocked/failed story with no
active successor (`tests/v2/gate.test.ts`, "names elicify_vertex_plan_reopen
when the plan is stalled...").

## C-7 — RESOLVED. Subagents get the discipline unconditionally, not only if the parent remembers to write it

**Severity: high.** The largest remaining gap between intent and enforcement.
Implemented and tested in this diff — `src/v2/wiring/subagentInjection.ts`,
wired into `src/v2/plugin.ts`'s `tool.execute.before`, covered by
`tests/v2/subagentInjection.test.ts` (unit) and
`tests/v2/plugin.integration.test.ts` (hook-level).

A subagent should behave the same way the parent does — different process,
same discipline. Previously that depended entirely on the parent hand-writing
the discipline into each delegation, which is self-report by another name:
nothing checked it, and under time pressure it was the first thing dropped.

The prompt used to carry a `VERTEX` bullet in the delegation package
instructing the parent to do exactly this. It has been removed, because asking
the model to remember was the wrong mechanism for something the harness can
guarantee.

**Fix:** inject the behaviour preamble into every subagent call from
`tool.execute.before`, before the `WRITE_TOOL_NAMES` early return in the same
hook — the injection branch has to come first, or the write-tool gate skips
it.

### Feasibility — probed empirically, opencode 1.18.4

The hook's arg mutation **does** reach the subagent, but only in place:

```js
toolOutput.args.prompt = TEXT + "\n\n" + toolOutput.args.prompt   // works
toolOutput.args = { ...toolOutput.args, prompt: ... }             // silently discarded
```

The dispatcher passes the same object reference to the hook and then to the
tool (`{args: b}` is a fresh wrapper, so assigning to `output.args` rebinds only
the wrapper); `TaskTool.execute` reads `prompt` off the live args object at
execution time.

Confirmed by running both variants and reading the child session out of the
opencode DB rather than trusting the subagent's reply — the in-place run's child
message carried the injected sentinel and the subagent obeyed it; the reassign
run's child message carried the original prompt, unmutated. That control is what
separates "the hook mutated an object" from "the subagent received the text".

Tool name is `task`. Args: `description` (string, required), `prompt` (string,
required — this is the injection point), `subagent_type` (string, required),
`task_id` (optional, resumes a prior subagent session), `command` (optional).

### Consequences designed around, now shipped

- **The injected text echoes back into the parent's context**, verified by
  asking the parent on a later turn to quote its own earlier `prompt`
  argument — it reproduced the full injected text. This is why the shipped
  preamble is the compact execution-only variant (~460 words), not the full
  ~2,100-word orchestrator prompt — see `docs/SUBAGENT-INJECTION-DRAFT.md`.
- **This rests on an implementation detail, not a documented contract.**
  Reference sharing between hook and executor could change in any opencode
  release. Guarded defensively (`injectSubagentPreamble` verifies `args.prompt`
  is a string before mutating, returns `false` and logs
  `subagent:injection-skipped` otherwise rather than failing silently) and the
  in-place-vs-reassign distinction is pinned by a dedicated regression test.
- **A second trigger site** for programmatically-spawned tasks (the `@agent`
  mention / command path) — see C-10 below. Resolved: the host converts it
  into an ordinary `task` call before dispatch, so this path was already
  covered without any new code.

### Design constraints, applied

- **Sends the execution half only.** A subagent executes; it does not
  orchestrate. `fan_out_agents` would invite recursive delegation;
  `plan_gate` / `planning_in_waves` / `completion` point at plan tools whose
  receipts land in the wrong session bucket (see C-4), so it can never
  checkpoint; `interview` assumes a user it cannot reach. Ships `grounding`,
  `evidence`, `scope_discipline`, `how_you_think`, `known_traps`,
  `uncertainty` (compressed) — see `docs/SUBAGENT-INJECTION-DRAFT.md` §1 for
  the full section-by-section rationale.
- Injection is skipped for `isSelf` sessions structurally, with no extra check
  needed: verifier and intake subturns are created via `runSubturn` directly
  (`client.session.create`/`client.session.prompt`), never via the `task`
  tool, so `tool.execute.before`'s `toolInput.tool === "task"` branch never
  sees them.
- `<evidence>` transfers cleanly as written, because the receipt mechanics
  were stripped out of it (C-1/C-2 above). A subagent told to cite a
  `receiptId` would be chasing something it cannot obtain.

---

## C-8 — RESOLVED. Redaction false-positive on ordinary prose

**Severity: medium.** Pre-existing in `src/redaction.ts`. Fixed on explicit
instruction to close every remaining item, preexisting or not — see the
"Fix, applied" note below for why the earlier caution against a rushed fix
turned out not to apply to the actual chosen fix.

`src/redaction.ts`'s `SENSITIVE_ASSIGNMENT_LABEL` pattern (the second
`SECRET_PATTERNS` entry:
`` \b(${SENSITIVE_ASSIGNMENT_LABEL})(\s*[:=]\s*|\s+)[^\r\n,;]+ ``) matches a
sensitive-sounding word — `secret`, `token`, `password`, `authorization`, …
— followed by ordinary trailing prose, not just an actual `key=value` leak:
a bare run of whitespace satisfies the "assignment" half, and the value half
then swallows everything up to the next comma/semicolon/newline, i.e. up to
the end of the sentence.

**Evidence**, run directly against `redactSecrets` (`src/redaction.ts`),
independently reproduced three times by three separate reviewers:

| input | output |
|---|---|
| `"I made sure no secrets leaked into the log output."` | `"I made sure no secrets [REDACTED]"` |
| `"The token refresh logic is now fixed and covered by a test."` | `"The token [REDACTED]"` |

Both sentences are dropped entirely, not just a token inside them —
`verifier.ts`'s `logPartialDrop` (new in this diff, `verifier:field-partial-drop`)
makes this failure mode *observable* rather than fixing it: the event fires
with the field name and drop count, but the dropped text stays gone.
`verifierSummaries` has always been exposed to this. What's new in this diff is
`lastResponse`/`recentTranscript` (`docs/VERIFIER-PROMPT.md` §5): free-form
narrative prose is exactly the kind of text a verification-focused assistant
writes constantly ("no secrets were logged", "the token refresh test now
passes"), so this pattern triggers far more often against those two fields
than it ever did against the older, more structured ones.

**Fix, applied.** The earlier caution was against *loosening* the pattern (more
matches = more false negatives). The actual fix *tightens* it in a way that
provably doesn't reduce true-positive detection: both
`SENSITIVE_ASSIGNMENT_LABEL`-based `SECRET_PATTERNS` entries had their
separator group changed from `(\s*[:=]\s*|\s+)` to `(\s*[:=]\s*)` — dropping
the bare-whitespace alternative, requiring an actual `:`/`=`. Verified against
all 16 pre-existing cases in `tests/riskRedaction.test.ts`'s `redactSecrets`
suite by hand before the fix was written, then confirmed by running the suite
before and after: every case either already has `:`/`=`, or is caught by a
completely separate dedicated pattern (`gh[pousr]_`/`npm_`/`glpat-`/`xoxb-`/
`sk-`/`AKIA`/JWT/private-key/Bearer/Basic/URL-credential — none depend on
`SENSITIVE_ASSIGNMENT_LABEL`). The entropy-based scan
(`ENTROPY_MIN_TOKEN_LENGTH`/`ENTROPY_THRESHOLD_BITS` in `verifier.ts`) remains
the backstop for a genuine secret phrased without `:`/`=` — confirmed still
catching an unlabeled high-entropy token in a new test. Both audit-doc
example sentences now survive `redactSecrets` unchanged.

## C-9 — RESOLVED. Boundary-truncation fragment leak

**Severity: medium.** Reproduced against the pre-existing `verifierSummaries`
field; the new fields extended the same exposure surface.

`verifier.ts`'s field pipeline (`truncateField` then `scanUnits`, per
`buildVerifierPayload`'s doc comment) truncates a field to its character cap
**before** the secret-pattern/entropy scan ever runs on it. A secret
positioned to straddle that cap boundary has its tail cut off first — and the
surviving prefix can fall just short of a pattern's minimum-length
requirement (or, for a low-entropy/repeated-character run, under the entropy
scan's threshold) even though almost the entire secret is still sitting in
the field, now completely unscanned.

**Evidence**, run directly against `redactSecrets` (`src/redaction.ts`,
`tripsPatternScan`'s exact mechanism), independently reproduced twice with the
identical numbers both times: a 40-character JWT-shaped string
(`eyJAAAAAAAA.BBBBBBBBBBBBBBBBBBB.CCCCCCCC`, third segment exactly at the
`{8,}` floor the JWT pattern requires) redacts correctly to
`[REDACTED:JWT]` when scanned whole. Truncated to 39 characters — dropping
only the single trailing character, which pushes the third segment to 7
chars, one under the pattern's minimum — the entire 39-character fragment
survives `redactSecrets` completely unchanged: **39 of the original 40
characters leak verbatim**, unredacted, because the cut happened before the
scan, not after it.

Reproduces identically against the pre-existing `verifierSummaries` field
(`VERIFIER_PAYLOAD_FIELD_CHAR_CAP` = 2000, same `truncateField` → `scanUnits`
pipeline in `src/v2/verifier.ts`) — not a regression from this diff. The
new `lastResponse` (same cap) and `recentTranscript`
(`VERIFIER_TRANSCRIPT_FIELD_CHAR_CAP` = 4000) fields extend the identical
exposure to more, and longer, free-form text.

**Fix, applied: redact-then-truncate ordering.** `scanLineField`/
`scanDiffSummaryField`/`scanProseField` now run `scanUnits` (the secret
scan) on the full, untruncated reassembled field first; only the surviving
(already-scanned) text is truncated to its cap afterward. Nothing unscanned
ever reaches the output, so the boundary-leak is closed by construction, not
patched around. The "could a truncation bisect a `[REDACTED]` marker"
question the two candidate fixes were weighed against turned out to be moot:
`redactSecrets`'s replacement markers are never actually embedded in this
codebase's output — `scanUnits` drops whole lines/hunks rather than
substituting inline markers — so that concern doesn't apply to either fix
direction here, confirmed by reading the code rather than assumed. New test
reproduces the exact 40-char JWT-straddling-cap case and confirms full
redaction, not a 39-character leak. `verifier:field-truncated`'s and
`verifier:field-dropped`'s logging semantics shifted accordingly (now mutually
exclusive per field per call — a fully-dropped field has nothing left to
truncate) and are documented in `verifier.ts`'s own comments.

## C-10 — RESOLVED. Second subagent-injection trigger site

**Severity: low.** Was a test gap, not a known defect — confirmed still true.

C-7's own "Consequences" section (above) already names a second trigger site
for programmatically-spawned tasks (the `@agent` mention / command path),
which builds its own args object and passes the same reference to the
executor — in-place mutation "should work there too — established by reading
the binary, not by running it." That was true when C-7 was filed and remains
true now that `injectSubagentPreamble` is wired in: every test added for it —
`tests/v2/subagentInjection.test.ts` (unit-level) and
`tests/v2/plugin.integration.test.ts`'s "C-7: task tool calls get the
subagent discipline injected" block (hook-level) — drives the `task`-tool
call path only. Nothing exercises the `@agent`/command path.

**Fix, applied — probed empirically, opencode 1.18.4, same discipline as
C-7's original feasibility probe.** Traced what the "second trigger site"
actually is: reading the SDK types and the host binary's own bundled source,
it's the SDK's `SubtaskPartInput`/`SubtaskPart` message-part type
(`{type:"subtask", prompt, description, agent}`), produced when a
`mode:"subagent"` agent is `@mention`ed, or a slash command configured
`subtask:true` is invoked. A live-host probe sending a `SubtaskPartInput`
directly, with a sidecar plugin logging every hook, proved the host
**internally converts it into a genuine `task` tool call**
(`args: {prompt, description, subagent_type, command}`) before dispatch —
landing in the exact same `tool.execute.before` / `toolInput.tool ===
"task"` branch C-7 already covers. The child session's DB-persisted first
message contained the full injected preamble, verbatim. **No new injection
code was needed** — this path was already covered; it was only ever a test
gap, exactly as originally scoped. A regression test now pins the exact args
shape this path produces (including the extra `command` key unique to it),
so a future narrowing of the injection condition can't silently reopen this
without a test noticing.

## C-11 — RESOLVED. `checkpoint`'s successor-promotion is a first-match scan, not strictly index-ordered

**Severity: low/medium.** Pre-existing, unrelated to `reopenStory` (C-6's fix
only ever promotes FROM `blocked`/`failed` back to `pending`/`active`; it
never touched `checkpoint`'s own promotion logic, and still doesn't).

`StoryEngine.checkpoint` (`story.ts`) promotes a successor via
`plan.stories.find((candidate) => candidate.status === "pending")` — the
first array match at the moment promotion runs, not "the next index after
the story that just completed." Separately, `checkpointTool`
(`wiring/tools.ts`) lets the caller checkpoint *any* `storyId` to
`blocked`/`failed` — only the `"complete"` path in `story.ts`'s `checkpoint`
requires the target be the plan's current active story (`story.ts` ~line
704-718); `blocked`/`failed` carry no such requirement.

In principle: if story 2 is checkpointed directly to `blocked` while it is
still `pending` (out of order — nothing prevents this call), and story 1
later completes and triggers promotion, `find` walks the array looking for
the first `"pending"` story — story 2 is `"blocked"`, not `"pending"`, so it
is skipped, and story 3 gets promoted instead. Story 2 is now stuck until
someone calls `elicify_vertex_plan_reopen` on it (C-6) — which nothing does
automatically — while the rest of the plan, including eventually the final
story, can still reach `"complete"`.

That would falsify `wiring/gate.ts`'s own comment (line 217): *"`final
complete` implies every earlier story completed... AC-3 therefore holds
structurally, not by this function's grace"* — the structural argument
assumes promotion is strictly sequential, which this first-match `find` does
not actually guarantee once an out-of-order `blocked`/`failed` checkpoint is
possible.

**Fix, applied — reachability investigated first, not assumed.** Checked the
real tool-calling surface before choosing a remedy: `checkpointTool`'s own
description imposes no active-story restriction for `blocked`/`failed`, and
`agents/elicify-vertex-agent.md`'s `<planning_in_waves>`/`<fan_out_agents>`
explicitly instruct grouping stories into waves and fanning out one agent
per story for the whole wave at once — a subagent legitimately working a
`"pending"` story can discover mid-work that it's broken, and
`<completion>` tells the model every story must end settled. So out-of-order
blocking is a real, prompt-encouraged flow, not a theoretical edge case —
hardening `checkpoint`'s `blocked`/`failed` branch to require active-story-ness
would have broken it.

Fixed the actual invariant instead of the promotion mechanism: `checkpoint`'s
`"complete"` branch, when the target is `plan.finalStoryId`, now additionally
rejects unless every *other* story is also `"complete"` — naming every
unresolved story and its status. Deliberately scoped to the final story only,
not every completion, since a non-final story completing while an earlier one
sits blocked (skip-ahead, later rejoin via `reopenStory`) is the existing,
tested, intentional shape the C-6 reopen tests depend on — confirmed those
tests still pass unmodified. `gate.ts`'s comment now states what's actually
enforced ("`checkpoint` enforces this directly") rather than the false
"holds structurally" claim.

## C-12 — RESOLVED. `reopenStory` doesn't rebind `PhaseEngine`'s phase tracking

**Severity: low — advisory-only impact, not a gate weakness.** Found during
adversarial review of C-6's reopen tool.

`PhaseEngine` tracks phase per-storyId independently of `StoryEngine`'s status
field. `reopenStory` resets status and evidence but never called anything
equivalent to `phaseEngine.onMutation` — a reopened story kept whatever phase
it had before it was blocked. In the narrow case where a story's phase was
already `"close"` before it blocked, and the harness's own gate-continuation
prompts are explicitly excluded from the phase reset that a genuine new user
message would trigger, `onIdle`'s elevate→close transition (which is what
fires the completion verifier) could never re-trigger for that storyId within one
long, harness-driven turn — even after the story is genuinely reopened and
re-completed with fresh evidence.

This never weakened the deterministic evidence gate: Stage-1
(`handleIncompletePlan`) and `checkpoint`'s own validation are both
status-driven, not phase-driven, and were unaffected. Only the advisory,
non-gating completion verifier's re-trigger was at risk in this edge case — the
codebase's own documentation already treats the verifier as "advisory, never
gating."

**Fix applied:** `reopenTool` (`wiring/tools.ts`) now calls
`phaseEngine.onStoryAdvance(context.sessionID, args.storyId, args.storyId)`
once `reopenStory` reports the story is `"active"` again — not `onMutation`,
which is a documented no-op from the `"close"` phase (`phase.ts`'s own table
comment: *"prev is 'execute' or 'close': no table arc for a mutation from
those sources — no-op, no transition recorded"*), i.e. exactly the phase C-12
needed to unstick. `onStoryAdvance`'s T8 transition unconditionally forces the
target story's phase back to `"execute"` regardless of what it was before.
Covered by `tests/v2/tools.test.ts`'s "C-12: reopening rebinds a phase stuck
at close" test, which drives a story to phase `"close"`, blocks it, reopens
it, and asserts the phase is back to `"execute"`. Mutation-verified: reverting
the fix to `onMutation` turns that test red.

## C-13 — RESOLVED. `elicify_vertex_plan_create` crashed on a real model's ordinary, spec-conformant call

**Severity: high — found by manual UAT, blocked the feature this whole diff
depends on.** Pre-existing (confirmed via `git diff`: the crashing lines were
untouched by every other item in this document), surfaced for the first time
because this was the first time `elicify_vertex_plan_create` was driven by a
real model rather than a test harness that always supplies every field.

`wiring/tools.ts`'s `createTool` schema declares `scopeGlobs`/`verifiers` as
`tool.schema.array(...).optional().default([])` — a real model, told the
fields are optional, naturally omits them. The opencode host does not
reliably apply a zod `.default()` for an omitted optional tool arg (the
`tool()` helper is a pure schema-shape passthrough with no runtime
enforcement), so `args.stories[i].scopeGlobs` reached `execute()` as
`undefined`, not `[]`, despite what both the zod schema and `StoryEngine
.createPlan`'s own TypeScript signature claimed. `story.ts`'s `createPlan` did
`scopeGlobs: [...input.scopeGlobs]` with no fallback — `[...undefined]`
throws `TypeError: input.scopeGlobs is not iterable`, live, reproduced by a
real model in a real UAT session.

**Fix:** `createPlan`'s parameter type now declares both fields `?:` optional
(matching the runtime reality the host actually delivers, not the reality the
zod schema promises), and both are defaulted with `?? []` at the point of
use — defending in `story.ts` rather than at the `tools.ts` boundary, since
`createPlan` is a public `StoryEngine` method other callers (tests, future
wiring) could also reach with the same gap. `wiring/tools.ts`'s two
`.optional().default(...)` args are the only two in the file; both were
consumers of this exact bug and both are now fixed. Regression test in
`tests/v2/story.test.ts` constructs the args by hand (bypassing the file's own
`story()` test helper, which — same root cause as every other item in this
document's "Test gap" section — always filled both fields, which is exactly
why 1293 passing tests never caught what a real model hit immediately).
Mutation-verified: reverting the fallback turns the new test red.

## C-14 — RESOLVED. Sending an explicit `agent` field on a later turn could deactivate an already-active session

**Severity: medium.** Found during manual UAT of C-6.

`plugin.ts`'s `chat.message` handler sets `state.active = false` whenever an
incoming message names an explicit `agent` field that doesn't match
`opts.activeAgent` — **even when it's a message re-sent by the same agent
that originally activated the harness via the `/elicify-vertex` trigger
text**, if that agent's name isn't the one configured as `opts.activeAgent`.
Confirmed deterministically with a direct hook probe against the real plugin
(no live model involved): repeatedly sending `agent: "build"` after an
initial trigger-text activation deactivates the session on the second turn;
a control run sending `agent: "elicify-vertex-agent"` every turn never
deactivates.

**Resolved, root cause traced, not just patched around.** A live UAT run
exercising the verifier (C-2 above) also sent `agent: "build"` on every turn and
stayed demonstrably active the whole time — this and the direct-probe finding
seemed to disagree. Reproduced both with one harness against the real host
(opencode 1.18.8), reusing the original UAT's own leftover session DBs as
ground truth rather than re-guessing. Both observations were correct; they
were measuring different **moments** in the session. Querying the verifier
scenario's real DB showed the model's first turn alone autonomously ran the
entire `plan_create → ... → checkpoint` lifecycle inside one open-ended
agentic turn — `session.idle` fired and the verifier dispatched (protected from
deactivation by `idleContinuationInFlight`) *before* any later turn
re-sending `agent: "build"` ever arrived. The reopen scenario's script, by
contrast, explicitly sent those later mismatched-agent turns — which *did*
deactivate, correctly, just not in a way the verifier scenario's measurement
ever exposed.

**Root cause:** the deactivation check conflated "agent ≠ the harness's
configured default" with "the user switched to an unrelated agent" — but
never accounted for a session having been activated via trigger text *while
already running under a non-default agent*, where that same agent
reappearing on the next turn is the session continuing, not a switch.

**Fix:** `plugin.ts` now records which agent actually activated each session
(`activatedAgentBySession`, set on every activation). Deactivation now
requires the incoming agent to differ from **both** `opts.activeAgent` and
the session's own recorded activating agent — closing the false positive
while preserving the original "explicit switch to an unrelated agent"
signal. Tests cover both directions: the genuine-switch case still
deactivates, the same-agent-continuing case no longer does.

**Follow-up, found by adversarial re-review of this fix (not by UAT):** the
first version set `activatedAgentBySession` unconditionally on every
qualifying turn, including ordinary default-agent turns. A session activated
by trigger under a non-default agent (e.g. "build"), followed by ONE ordinary
turn under the configured default agent, had its recorded activator silently
overwritten from "build" to the default — so "build" reappearing afterward
looked like a switch to a genuinely different agent and incorrectly
deactivated, reproducing the same bug class one interleaving hop removed.
Reproduced with a live probe test (temporary, reverted) before the reviewer's
report was accepted. **Fix:** record the activator ONCE per activation
streak (`if (!activatedAgentBySession.has(sid))`, not an unconditional
`.set()`), and clear the entry on genuine deactivation so a later real
re-activation still records fresh. Covered by a new test: "survives an
intervening default-agent turn without losing the original non-default
activator."

---

## C-15 — RESOLVED. The entropy backstop C-8 relies on essentially never trips on a realistic secret; a cost regression in C-9's reordering was also unbounded

**Severity: high — the exact backstop C-8's own comment cites as covering its
narrowed pattern.** Found independently by two adversarial re-review agents
in the same wave, both computing matching entropy values from `verifier.ts`'s
own formula/thresholds, during the re-review this session's second `/goal`
requested for C-8/C-9.

**The gap.** `tripsEntropyScan`'s effective threshold (3.95 bits/char, just
under hex's theoretical max of exactly 4.0) is reachable only by a
near-perfectly-uniform 16-symbol digit distribution. Real random hex strings
at the scanned lengths essentially never land that close to uniform — a
20,000-sample Monte Carlo of random 32-char hex found 0/20000 clearing it;
40-char hex cleared only 4/20000 (0.02%). Concrete, previously-leaking
examples, fed through the real `buildVerifierPayload` pipeline end to end:
`"our client secret ends up being 8f3ac9d2e1b74c0aa9f2d8e7c1b3a4f6"` (3.83
bits/char) and `"she pasted the password
hunter2CorrectHorseBatteryStaple99..."` (3.89 bits/char) both survived
completely unredacted. The shipped "entropy backstop" test only proves the
scan catches an artificially-maximized token (40 distinct characters, zero
repeats, ~5.3 bits/char) — not a realistic secret shape, so it didn't
validate the claim C-8's own comment cites it for. Exactly the failure mode
this document's own "V-4 — audit the audit" principle warns about: a claim
that sounded right and was never independently re-verified against the real
code.

**Fix applied — hex-run backstop, scoped to `verifier.ts` only.** Rather than
lower the entropy threshold (risking new false positives on ordinary long
identifiers/camelCase tokens without a large empirical dataset to calibrate a
safe cutoff), `src/v2/verifier.ts` gained a direct, unambiguous character-class
backstop: `tripsHexRunScan`, a standalone run of 32+ pure-hex characters
(the length `ENTROPY_MIN_TOKEN_LENGTH` already uses) trips regardless of
entropy. Natural-language prose does not produce 32+ consecutive
hex-alphabet characters as one token; the realistic false-positive cost is
git full-SHA/hash-shaped IDs (also hex, also long) being dropped when they
appear in evidence text — accepted, since a verifier subturn losing one line of
context is far cheaper than a leaked secret.

**A first attempt at this fix caused a real regression, caught before it
shipped.** The hex-run pattern was first added to `redaction.ts`'s shared
`SECRET_PATTERNS` array (used by both `redactSecrets` and `redactForDisk`).
`redactForDisk` is applied to the *entire* `VerificationReceipt` object on
every disk write (`goals.ts`'s `atomicWriteJson`) — and a receipt's
`signature` field is itself a bare 64-char hex HMAC-SHA256 digest, with
`scope.worktreeDigest` a bare hex hash alongside it. The new pattern matched
both, corrupting them on write. 13 tests across `forgery.test.ts`,
`receipts.test.ts`, `tools.test.ts`, and `plugin.integration.test.ts` failed
with "genuine receipt must survive: expected null not to be null" the moment
the full suite ran — caught immediately by this session's own
verify-before-report discipline, not shipped. **Fix:** moved the hex-run rule
out of the shared `redaction.ts` module entirely and into `verifier.ts`'s local
`unitTrips`, which is only ever applied to the five free-form verifier-payload
fields (prose/line arrays), never signed or structured data. A regression-pin
test (`tests/riskRedaction.test.ts`, "C-15 regression guard") proves
`redactForDisk` leaves a receipt-shaped object's signature/digest fields
byte-identical, and is mutation-verified to catch the exact bug that
happened: re-adding the pattern to `SECRET_PATTERNS` turns it red.

**Accepted residual risks, not fixed:**
- **Dictionary-word passphrases embedded in prose** (e.g. the
  `hunter2CorrectHorseBatteryStaple99` example above) measure similarly low
  entropy to ordinary English — repeated common letters from real dictionary
  words — and are not a pure-hex run, so neither backstop catches them. No
  local character-level heuristic can reliably tell these apart from prose
  without a false-positive cost that would reopen C-8's exact problem
  (label-word-triggered redaction of ordinary sentences).
- **The equivalent gap in `redactForDisk`-covered disk persistence**
  (`measurement.jsonl`, plan archives, pins) for the *pattern-matchable* gap
  above — i.e. a genuinely unlabeled high-entropy secret pasted into
  free-form text that ends up in one of those files — is not closed, for the
  same reason the hex-run fix couldn't go in `redaction.ts`: those files mix
  arbitrary free-form text with structured, legitimately-high-entropy fields
  (signatures, digests, IDs), and a blanket string-pattern rule can't tell
  them apart without a schema-aware (key-based) exclusion, which is out of
  scope for this fix.

**C-9 follow-up — cost regression, also found and fixed in the same
review.** C-9's scan-then-truncate fix requires scanning the FULL untruncated
field, so scan cost now scales with the raw field size, not the
post-truncation cap. `criteria`/`verifierSummaries`/`diffSummary` are already
bounded upstream before they reach `verifier.ts`, but `lastResponse`/
`recentTranscript` are not (`gate.ts`'s own comment on the transcript turn
window says outright it's "a soft pre-filter, not the real bound"). Measured:
a 2MB single-line field took ~45ms to scan; a 1.37MB/20,000-line field
~270ms. **Fix:** `VERIFIER_PAYLOAD_RAW_FIELD_SAFETY_CAP` (100,000 chars) — a
raw field over this cap is dropped WHOLE, before scanning, logging
`verifier:field-oversized`. This bounds worst-case cost without reintroducing
C-9's bug: unlike truncating a field's *content* toward its transmission cap
(which risks bisecting a secret near that boundary), dropping an oversized
field whole produces no partial/fragmentary text for a bisected secret to
hide in — a field either gets a full scan (and, if it survives, a
cap-respecting truncation of the scanned result), or it is entirely omitted.
Sized far larger than the real transmission caps and than any realistic
secret token, so it never engages for genuine evidence text.

All five new tests (`tests/v2/verifier.test.ts` ×4, `tests/riskRedaction.test.ts`
×1) mutation-verified: each one confirmed to fail when its corresponding fix
is reverted, confirmed to pass again once restored, using file-copy backups
rather than `git checkout` (this session's own established lesson — the
staged index is stale mid-session, and `git checkout` restores from it, not
from the working tree).

---

## C-16 — RESOLVED. A story displaced to "pending" could be stranded if the story occupying its active slot later blocked instead of completing

**Severity: low — operational friction, not a correctness or evidence-integrity
gap.** Found while writing new host-faithful UAT coverage for C-11/C-12
(`scripts/uat-harness.mjs` section T) — not by UAT of a scenario anyone
requested; discovered while constructing the test data.

**The scenario.** S2 blocks while still `"pending"` (C-11's own out-of-order
shape); successor-promotion skips it and promotes S3 (final) to active.
`elicify_vertex_plan_reopen(S2)` correctly rejoins S2 as `"pending"` (S3 is
active — see `reopenStory`'s documented "another story is active" branch). If
S3 is now ALSO blocked (rather than completed), `story.status = status`'s
transition used to set no story `"active"` at all: `checkpoint`'s
successor-promotion only fired `if (status === "complete" && wasActive)`,
and `reopenStory`'s own "promote directly to active" branch requires the
story being reopened to currently be `"blocked"`/`"failed"` — S2 is
`"pending"`, neither. Grepped every `.status = "active"` assignment in
`story.ts` (exactly two: the two just named) to confirm there was no third
path.

**Initially decided as "documented, not fixed"** (a genuinely non-obvious but
working recovery path existed: checkpoint the stranded pending story to
`"blocked"`, which is an ungated transition, then reopen it again). Revisited
on the operator's explicit instruction to do the real fix rather than accept
the workaround, given the risk was judged narrow.

**Fix applied.** `checkpoint`'s successor-promotion now fires whenever the
active slot vacates for ANY reason — `"complete"`, `"blocked"`, or
`"failed"` alike — not just `"complete"`. Symmetric with the existing
`"complete"` case in every other respect: same selection (first `"pending"`
story in array order), same `startedAt` stamping. Does not touch
`reopenStory`'s own no-preemption guarantee — a reopened story still only
jumps straight to `"active"` when nothing else is active, exactly as before.

Retracing the scenario with the fix: S2 blocks while pending (nothing to
promote, no-op) → S1 completes, promotion skips blocked S2, promotes S3 →
reopening S2 correctly rejoins it as `"pending"` (S3 active) → S3, still
stuck because C-11 rejects its completion while S2 is unresolved, gets
blocked by the model (the natural next move, directly suggested by C-11's
own rejection message) → **S2 is now auto-promoted to `"active"`
immediately** → S2 completes normally → S3 is reopened (nothing active, so
it resumes directly per the existing branch) → S3 completes, C-11's gate
passes. No more "checkpoint-to-blocked-then-reopen" trick required anywhere
in the flow.

Covered by two new tests: `tests/v2/tools.test.ts`'s "blocking the active
story promotes the next pending one; reopening the blocked story then
rejoins as pending" (mutation-verified: reverting the promotion gate back to
`status === "complete" && wasActive` turns it red), and
`scripts/uat-harness.mjs`'s "T1" scenario, simplified to the natural
recovery flow and re-verified end to end against the real compiled
`dist/v2/` (112/112 UAT scenarios, stable across repeated runs). Three
existing tests encoded the OLD "blocking the active story leaves nothing
active" behavior as their premise (`tests/v2/gate.test.ts` ×2,
`tests/v2/tools.test.ts` ×1) — updated: the two `gate.test.ts` tests moved to
single-story plans (nothing pending to promote, preserving their original
"no active story" intent unchanged); the `tools.test.ts` test was narrowed
to a single-story plan for its original assertion, with the promotion-aware
two-story case split into the new dedicated test above.

---

## Test gap behind all of these

The prompt-vs-code contract test that caught the original phantom-tool-name
defect was removed later this session (`tests/agent-prompt.test.ts` — dropped
per an explicit decision that prose-matching tests were too brittle; three
line-wrap reflows broke it without any rule changing). Its narrower, useful
property — no tool named in the prompt that doesn't exist — currently has no
enforcement mechanism at all (checked directly: no comment or test anywhere
asserts it; an earlier draft of this document claimed one existed at
`ACTIVATE_TEMPLATE`'s definition, which turned out not to be true either —
another instance of V-4 below).

The gap this section originally named is broader than "no test for this":
**C-1 itself was filed without checking the current code**, and its
recommended fix pointed at logic (`coverage.ts`'s `parseSubcommands`) that the
actual receipt path never touches. C-2's original fix pointed at a pattern
(`receipt:scope-unverifiable`) that turned out to have the identical bug it
was meant to cure. Three of twelve items in a document titled "code issues
found by auditing" were themselves not verified against the code before being
written down (C-1, C-2, and this section's own now-corrected phantom claim).

**V-4 — audit the audit.** Before implementing any item in a findings
document, re-derive it against the current code — run the actual function
against the actual claimed-broken input, don't just re-read the prose that
described it. This document is the evidence: C-1 was corrected only because
implementation was about to start and the described fix ("consume
`parseSubcommands`") didn't match a five-minute read of the real receipt path.
A findings doc is a hypothesis with a paper trail, not a verified fact merely
because it was written down carefully. Applies recursively to this document
itself, at every subsequent edit — the phantom "covered by a code comment"
claim above survived one full sign-off review pass before a later one caught
it.
