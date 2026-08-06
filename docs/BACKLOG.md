# Backlog — current fixing round

Opened 2026-08-06. Items are evidenced from the live opencode session
`ses_02956d08…` (MiniMax-M3, `/workspace/vertextest4`, 10:40–11:31, 450 events)
unless stated otherwise.

> Caveat on the evidence: the event log was deleted twice during an uninstall
> cleanup earlier that morning, so counts below are a lower bound.

---

## B-1 — The verifier inherits the worker's model. Delete the machinery that pretends otherwise. **[priority]** — ✅ DONE (code)

> **Status 2026-08-06:** code landed. `src/v2/dosing.ts`, `src/v2/wiring/dosing.ts`
> and their two test files are deleted; `verifierModel` / `dosingOverrides` /
> `verifierModelOverride`, the two-entry fallback chain, the `dosing:unknown-model`
> event and the `profile` stamp are gone from the event schema.
> `runVerifier` makes exactly one subturn attempt, on `sessionModel`.
> **The spec amendments (FR-028/FR-029, FR-030a, US-9 AS-2/AS-3, test 36) are a
> separate change and are NOT covered here** — everything under `docs/` other
> than this file is untouched.
>
> **Two decisions taken while implementing:**
>
> 1. **A leftover `verifierModel` / `dosingOverrides` in `opencode.json` is
>    ignored SILENTLY — no deprecation log.** Plugin options have never been
>    validated (they are cast; every unrecognised key has always been dropped
>    without a word), so warning about exactly two dead keys would be the only
>    such check in the surface. More decisively, the warning would have to fire
>    at plugin CONSTRUCTION, before any session activates — which is the write
>    UAT G1 and the "a non-activated session writes nothing" test exist to
>    forbid. A user with a stale key would get a `.vertex-events.jsonl` line for
>    every session they opened, activated or not. And there is no function to
>    route around: the rule says the judge runs on the worker's model, so
>    ignoring the option IS the correct response to it. Pinned by
>    `integration-verifier.test.ts` test 36 case (b).
> 2. **`compliedFamiliesEver`, `everVerifiedThisTurn` and
>    `turnIntroducedNewTestFile` are REMOVED with their writers, not left
>    documented.** `wiring/dosing.ts` was their only reader; with it gone they
>    are unobservable — not logged, not persisted, not exposed. Write-only state
>    reads as a capability the harness does not have. Every
>    `composer.recordCompliance` call is retained, so the compliance record that
>    FR-034's join actually uses is unaffected. (Removing the third field is
>    also what makes `TEST_PATH_RE` / `TEST_DIR_RE` dead, as the removal map
>    anticipated.)
>
> **Measured behaviour change.** Dosing did suppress directives, and removing it
> raises volume — bounded, not unbounded. Same scenario (3 turns × 12
> agent-loop steps), driven through the real hooks before and after:
>
> | model | before: rendered / chars | after: rendered / chars |
> |---|---|---|
> | `anthropic/claude-fable-5` (table row "frontier") | 6 / 1842 | 6 / 2226 |
> | `minimax/MiniMax-M3` (table row "standard") | 3 / 1308 | 6 / 2226 |
> | `minimax-coding-plan/MiniMax-M3` (the field id; missed the table) | 3 / 1308 | 6 / 2226 |
>
> So directive text grows +20.8% for the frontier row and +70% for the standard
> rows, and all three models now render identically — which is the point.
> Against that, the field model's total event count for the same scenario falls
> **82 → 47 (-43%)**: the 38 `dosing:unknown-model` lines it used to emit are
> gone (the same pathology as the 138 in the audited session).
>
> **B-1 × B-2 compose.** Holding turns at 1 and scaling agent-loop steps
> 6 → 12 → 24 → 48 → 96, rendered volume is FLAT at 2 directives / 1 injected
> block, with `per-turn-cap:dropped` = 0 at every step count — identical shape
> before and after B-1 (only the constant moves, 614 → 742 chars). B-1 changes
> the per-turn constant; it does not reopen the per-step flood B-2 closed.
> Pinned at 40 steps by `plugin.integration.test.ts`.

**The rule, stated once:** the judge runs on the same model as the worker. No
table, no profile, no override.

Today that is already the *behaviour* — `verifierModelOverride` is unset, so
`attempts = [sessionModel]` (`src/v2/verifier.ts:1430`). What exists on top of
it is configuration nobody drives:

- `verifierModel` option → `verifierModelOverride` → a two-entry fallback chain
  (`plugin.ts:81`, `:253`, `:423`; `gate.ts:88`, `:731`, `:1379`).
- `src/v2/dosing.ts` — a model→profile table (`standard` | `frontier`) with
  exactly **two** rows: `anthropic/claude-fable-5` and `minimax/MiniMax-M3`,
  plus suffix-tolerant matching and a `dosingOverrides` escape hatch.

**What it cost in the measured session:** the model reported itself as
`minimax-coding-plan/MiniMax-M3`. The table key is `minimax/MiniMax-M3`, and
the match requires `id === key` or `id.endsWith("/" + key)` — the provider
segment differs, so it missed **138 times** and logged `dosing:unknown-model`
on every turn. The fallback profile is `standard`, which is *exactly what the
table row would have assigned*. So the entire mechanism produced 138 log lines
and one incorrect `unknown: true` flag, and changed no behaviour whatsoever.

`docs/vertex2-spec-review.md:704` (OBS-001) reached the same conclusion
independently: "the `verifierModel` override and its fallback chain are
configurability without a driver".

**Do:** remove `dosing.ts` and the profile plumbing; remove `verifierModel` /
`verifierModelOverride` and the fallback chain; the verifier takes
`sessionModel`, full stop. Drop `dosing:unknown-model` and the `profile` stamp
from the event schema.

**Do not** "fix" this by adding a `minimax-coding-plan/…` row. That keeps the
machinery and buys nothing.

**Watch for:** FR-028/FR-029 and US-9 AS-2/AS-3 specify the dosing matrix and
the override; the spec needs amending in the same change, not silently
contradicted. Tests referencing `frontier`/`standard` and test 36 go with it.

---

## B-2 — The intake scaffold was emitted once per agent-loop STEP, and two families' compliance counts were undecidable. **[fixed 2026-08-06]**

The original entry guessed at three causes ("the cap is too low, the scaffold
too chatty, the phase re-entry duplicates findings"). All three were wrong.
The measured evidence stands; the diagnosis below replaces the guesswork.

### The evidence

`per-turn-cap:dropped` fired **179 times**, every one of them
`family: "intake-scaffold"`, `priority: "phase-guidance"` — from turn 1 (`D-2`)
through turn 5 (`D-98`, which hit `budget:dropped` instead). Over the same
session:

| family | rendered | complied |
|---|---|---|
| `intake-scaffold` | 9 | **0** |
| `scope-watchdog` | 3 | **0** |
| `verify-gap` | 9 | 14 |

### The actual root cause

**The cap was never the bug.** `intake-scaffold` is capped at 1/turn
(`composer.ts` `DEFAULT_FAMILY_CAPS`) and the cap was doing exactly its job.
The PRODUCER was the bug: it pushed an `intake-scaffold` finding
unconditionally whenever zero criteria were pinned, from inside
`experimental.chat.system.transform` — and opencode fires that hook **after
every tool result**, not once per turn. Findings are rebuilt on every
invocation and the composer retains nothing across `render()` calls, so the
harness minted ~180 identical findings in one turn and the cap threw away all
but the first. 179 drops ≈ 179 agent-loop steps.

**`scope-watchdog`'s "0 complied" was a structural artefact.** There was no
`composer.recordCompliance(…, "scope-watchdog", …)` call anywhere in the
codebase; the number would have read 0 under perfect compliance. Worse, the
directive's "fold / amend / revert" offer named three actions the model had no
mechanism to perform — `StoryEngine.amendStory` existed and was exposed by no
tool. Only `plan-proposal`, `verify-gap` and `intake-scaffold` had compliance
paths at all.

**`intake-scaffold`'s "0 complied" was undecidable, not proof of anything.**
Compliance was detected only via `parseCriteriaBlock`, which required an
unfenced `CRITERIA:` line followed by a NUMBERED list; bullets were rejected
and the scan broke at the first non-matching line. A parse miss was **silent**.
And because the emission gate and the compliance signal were the same
predicate (empty pin store), a parse miss made the scaffold re-fire forever
while scoring the model non-compliant.

The double `intake->execute` transition is a different story key, not
re-entry, and is not a bug.

### What was done

1. **The scaffold is offered at most once per turn**, at the producer
   (`plugin.ts`), gated on `V2SessionState.intakeScaffoldOfferedForTurn`. That
   field holds the COMPOSER's turn index, not a boolean cleared in
   `resetTurnState` — `wiring/gate.ts`'s continuation path calls
   `composer.newTurn(sid)` and nothing else, so a boolean would have gone
   permanently spent on any continuation-driven autonomous run. New accessor:
   `InjectionComposer.currentTurn()`. Measured by test: 8 invocations in one
   turn now produce 1 render and **0** cap drops (was 1 render and 7 drops).
   **Superseded — see the follow-up below.**
2. **`scope-watchdog` compliance is instrumented**, via a new
   `elicify_vertex_scope_amend` tool (fold / amend / revert, backed by the
   previously unreachable `amendStory`) and a `PlanToolsDeps.onScopeAmended`
   callback that `plugin.ts` turns into `recordCompliance`. The directive's
   prescription now names that tool, so the offer is actionable.
3. **A criteria parse miss is visible and rarer.** New `criteria:parse-miss`
   event, logged from `text.complete` when `parseCriteriaBlock` returns null
   but `findCriteriaKeyLine` finds an unfenced `CRITERIA:` line. And
   `CRITERIA_ITEM_RE` now accepts `-` and `*` bullets as well as numbers — a
   model that complied with a bullet list must not score as non-compliant. The
   numbering was never load-bearing (`PinStore` assigns the ids).

**Not changed, deliberately:** the cap value (1/turn is correct), and the
phase machine.

Note this was *not* downstream of B-1 — the profile resolved to `standard`
either way.

### Follow-up (review of the above): right diagnosis, wrong flag, one family of four

Item 1 spent its once-per-turn flag when the finding was **offered**, not when
it **rendered**. `intake-scaffold` is `phase-guidance` and loses the 2-slot
invocation budget to any two `correction`s, so the first invocation that
dropped it for budget reasons also spent the flag — and nothing re-offered it
for the rest of the turn. Measured (deep ask → plan with `scopeGlobs` → one
unverified out-of-scope edit per step): `rendered=0, budgetDrops=1` across a
six-step turn, where removing the gate entirely renders it at step 2. B-2 could
**suppress** the directive it was written to protect. It also contradicted
`composer.ts`'s stated contract ("the caller must re-detect and re-pass them on
a later invocation if still true") and diverged from the sibling one-shots,
which clear only on `renderResult.renderedFamilies`.

And the per-step flood was never `intake-scaffold`-only. Same measurement, one
turn each:

| family | rendered | `per-turn-cap:dropped` before | after |
|---|---|---|---|
| `verify-gap` | 3 | 117 | **0** |
| `scope-watchdog` | 1 | 119 | **0** |
| `pre-commitment` | 1 | 95 | **0** |
| `elevate` | 1 | 284 | **0** |
| `intake-scaffold` | 0 → **1** | 0 (suppressed instead) | **0** |

`InjectionComposer.currentTurn()` is **replaced** by
`InjectionComposer.blockedBeforeBudget(sessionID, family)`, and
`intakeScaffoldOfferedForTurn` is gone. The new predicate answers the question
the producers were actually asking — *would the composer bin this if I built
it?* — from the composer's own per-turn spend and cooldown state, which move on
a **render** and on nothing else. It deliberately does not model the budget
trim, so a budget drop still re-offers next invocation. Every rendered
directive still renders, at the same invocation: only findings whose
`per-turn-cap:dropped` was already a foregone conclusion are skipped, along
with the `resolveVerifier` call and instance id each one burned.
`verify-gap` — the one family with real measured compliance (9/14) — renders on
exactly the same three steps as before; that is asserted by test, not assumed.

`criteria:parse-miss` (item 3) also lacked the per-turn guard its sibling
`expect:absent` has: `text.complete` fires per assistant text part, so 12 parts
carrying the same unreadable `CRITERIA:` line produced 12 events. Now 1 per
turn, re-opening on the next turn.

---

## B-3 — The one verifier run judged without the diff

> **Operator ruling (2026-08-06):** "the checker should only run at the end or
> when the worker stops working — that is correct."

So **running once is NOT the bug** and is not to be "fixed". One
`story:verifier-audit` in the session is the intended design. What is wrong is
the *quality of evidence* that one run had:

- `verifier:field-dropped` — `diffSummary`
- `verifier:field-truncated` — `recentTranscript`, 5923 → 4000 cap

A verifier forming a verdict without the diff is the failure mode that produced
the worker/verifier standoffs already fixed this round. Find out why
`diffSummary` was dropped (empty? redacted? `git diff` failed?), and make the
verifier say so rather than judging around the hole.

### ROOT CAUSE — found, reproduced, measured (2026-08-06)

**The harness's own secret-redaction ate its own file list.** Not git, not the
model, not the recent `stdio` change (that one is innocent — it only stopped
stderr being inherited). The chain, end to end:

1. **The project under test was not a git repository.**
   `computeBoundedDiffStat` ran `git diff --stat -- <absolute paths>`; outside
   a repo git exits non-zero, `execFileSync` throws, and the `catch` returned
   `""` — with no record anywhere of why.
2. **The fallback hid it.** `plugin.ts` fell back to
   `formatChangedPathsSummary(changedPaths)`: a **comma-joined list of
   ABSOLUTE paths**. So the raw field was never empty and nothing looked
   wrong.
3. **The scan then ate the fallback.** `scanDiffSummaryField` splits a field
   into removal units on `@@` hunk headers; a path list has none, so
   `splitDiffIntoHunks` returned **the entire blob as ONE unit**.
   `tripsEntropyScan` (>= 3.95 bits/char over whitespace tokens of >= 32
   chars) fired on the long absolute paths — measured on the session's real
   strings:

   | token | chars | bits/char |
   |---|---|---|
   | `/workspace/vertextest4/src/games/memory.js,` | 43 | 3.979 |
   | `/workspace/vertextest4/src/games/index.html,` | 44 | 4.190 |
   | `/workspace/vertextest4/src/games/breakout.js` | 44 | 3.971 |

   One trip emptied the single unit, `kept.length === 0`, and the whole field
   was dropped. A real `git diff --stat` never trips: its `++++`/`----` runs
   measure 0.732 bits/char.

### FIXED (2026-08-06)

Four changes, each with a test that fails when the change is reverted
(mutation-verified, all nine mutations red):

- **(a)** `formatChangedPathsSummary` (now `src/v2/diffstat.ts`) emits
  **workspace-relative** paths, **one per indented line**, not one
  comma-joined absolute line. `src/games/breakout.js` is 21 chars — under the
  entropy rule's 32-char token floor, so it is never even scored. The indent
  also stops the adjacent-unit boundary check fusing two paths into one long
  token.
- **(b)** `computeBoundedDiffStat` probes `git rev-parse
  --is-inside-work-tree` and returns an explicit reason
  (`DIFF_UNAVAILABLE_NOT_A_REPO` / `_GIT_FAILED` / `_NO_CHANGES`) instead of a
  silent `""`. It also lists **untracked new files** via `git ls-files
  --others --exclude-standard` — `git diff --stat` shows nothing for them, so
  the same blind verdict would have recurred inside a real repository for any
  session that only creates files.
- **(c)** `scanDiffSummaryField` scans a hunk-less field **per LINE**. This
  changes the removal UNIT only — never the threshold, the patterns, or what
  counts as suspicious. One suspicious token now costs one line instead of the
  whole field. Proven not to weaken FR-031: dedicated tests isolate each of
  the three detectors (pattern scan, entropy rule, hex-run) plus the
  adjacent-pair boundary check, and each goes red when that detector is
  disabled.
- **(d)** The hole is stated, not silent: `diffSummaryUnavailable` is a
  payload field of its own, and `VERIFIER_SYSTEM_PROMPT` tells the judge to
  treat the file evidence as incomplete and cite the reason rather than infer
  that nothing changed. `runVerifier` additionally returns
  `reason: "insufficient-evidence"` when the payload has **neither** a diff
  summary **nor** a transcript — deliberately narrow, because a missing diff
  alone must never disable the verifier outside a repository.

Code: `src/v2/diffstat.ts` (new), `src/v2/verifier.ts`, `src/v2/plugin.ts`,
`src/v2/wiring/gate.ts`. Tests: `tests/v2/diffstat.test.ts` (new, drives real
git against real temp repos), `tests/v2/verifier.test.ts`,
`tests/v2/integration-verifier.test.ts` (the non-repo session end to end
through the real wiring).

---

## B-3a — The transcript is truncated from the WRONG END

`truncateField` (`src/v2/verifier.ts:812`) is:

```ts
return text.slice(0, cap)
```

It keeps the **beginning** of the transcript and discards the end.

> **Operator ruling:** "raise the conversation character limit and certainly it
> needs to cut at the top not the bottom — the last messages are the relevant
> ones."

That is exactly right and the current code does the opposite: in the measured
session the verifier was handed the first 4,000 characters and never saw the
most recent 1,923 — the part describing the work it was being asked to judge.

**Do:**
1. Cut from the top: `text.slice(-cap)`, with a leading `…[earlier transcript
   trimmed]…` marker so the verifier knows it is seeing a tail, not a whole.
2. Raise the cap for `recentTranscript` from 4,000 to **16,000** characters
   (operator decision, 2026-08-06 — 4× today, chosen over 32k/uncapped to keep
   the per-audit prompt cost and the secret-redaction scan bounded).

**Care:** this field is model-visible and goes through `scanProseField`. The
redaction scan must run over the *kept* tail, and the FR-031 adjacent-unit
boundary check must still hold at the new cut point — a secret straddling the
boundary is the exact leak that check exists for. Do not reorder them.

**Check the other fields too:** four more share
`VERIFIER_PAYLOAD_FIELD_CHAR_CAP` and the same head-keeping `slice(0, cap)`.
Head-keeping is probably right for `plan` and `diffSummary`; it is wrong for
anything chronological. Decide per field rather than flipping all five.

---

## B-3b — The judge must judge the GOAL, not exit codes

> **Operator ruling:** "the judge should not go by exit codes — they are an
> information but not a real criteria for the judge. The judge needs simply to
> judge if the goal was achieved, all stories delivered, and generally
> validated."

Exit codes stay in the payload as *evidence the judge may cite*. They stop
being *criteria the verdict is derived from*. The question the verifier answers
is: was the goal achieved, is every story delivered, does it hold up.

This continues the direction already taken this round — the tool-call floor was
replaced by `verdictIsSubstantiated`, and `VERIFIER_SYSTEM_PROMPT` already
leads with "the session transcript is your leading evidence… you are not
required to run a command to be believed". Finish the job: remove any remaining
place where a command result decides the verdict rather than informing it.

**Scope (operator decision, 2026-08-06): the JUDGE only.** `verify-gap` — the
worker-facing nudge — is explicitly out of scope and stays as it is. It is the
one directive family with measured effect in this session (9 rendered, 14
complied) while `intake-scaffold` and `scope-watchdog` scored 0. Do not
"harmonise" it away.

### DONE (2026-08-06)

**What the audit actually found.** Only ONE place in the judge path derived a
verdict from a command result, and it was the prompt: `VERIFIER_SYSTEM_PROMPT`
never stated any criteria at all, and its single criterion-shaped sentence was
the re-run-your-verifiers instruction, framed entirely around making an *exit
code reliable*. Everything downstream (`applyPathVeto`, FR-005, the re-audit
cap, `applyVerifierVerdicts`) turns on filesystem fact or on the verdict's own
shape — none of it reads an exit code. `parseVerification`/`exitCodeReliable`
(`index.ts`), the receipt writer (`plugin.ts`) and the `verify-gap`
prescription (`findings.ts`) are all worker-facing and were left alone.

**Prompt (`verifier.ts`).** Extended, not replaced — the transcript-leading
lead-in stands. Added: the three criteria verbatim (goal achieved / every story
delivered against its declared acceptance items / holds up under scrutiny);
exit codes, command results and verifier summaries named as *evidence you may
cite — never the test*, in both directions (a red command does not make an item
unmet, a green one does not make it met); and an instruction to judge every
acceptance item by the digest's own item id. The re-run instruction survives
with its standing demoted: "the result informs your verdict; it does not decide
it."

**Deterministic half (`gate.ts`, `verdictIsSubstantiated`).** A prompt is not
an enforcement, so the two shapes a command-derived verdict actually takes are
now rejected:

- a `pass:false` must name at least one **declared** acceptance item —
  `{itemId:"verifier", met:false, note:"npm test exited 1"}` fails a story on
  the shell, not on its contract. *At least one*, not all, so an extra
  observation volunteered next to a real finding never discards the finding.
- a `pass:true` must have judged **every** declared acceptance item — a green
  suite plus one blanket item is a verdict about the command, and the
  unexamined items are exactly where "delivered" and "the tests pass" diverge.

`itemId` is matched on alphanumerics only (`a1.` = `A-1` = `A1`). A story with
no declared acceptance items skips both rules rather than freezing. The
`verifier:unverified` notify text, which still described the deleted tool-call
floor, now says what the rule is.

Nine mutations, each confirmed red and restored: fail-side rule, pass-side
coverage, the substantiation clause in the bounding filter, id normalisation,
an over-strict `some`→`every` variant, and the four prompt sentences.

---

## B-4 — `resolution:none` × 65, including turns with real edits **[fixed]**

Most carry `changedPaths: []`, but some carry genuine ones —
`src/games/memory.js`, `index.html`, `src/games/breakout.js` — and still
resolved to nothing.

**Root cause.** "Resolution" is the step that turns *these paths changed* into
*run THIS command*: `resolveVerifier` (`src/v2/resolve.ts`), called from
`plugin.ts`'s verify-gap branch and `gate.ts:narrowestPrescription`. With real
changed paths in hand it still returned `{command: null}`, because **every tier
missed, each for its own reason**:

| tier | why it missed |
| --- | --- |
| 1 — story verifiers | the session declared none |
| 2 — basename convention | `manifest.testFiles` was empty; the project genuinely had no `*.test.*` / `*.spec.*` file |
| 3 — package scripts | `resolvePackageScript` hard-filtered on `scripts.test`, and the project's `package.json` declared only `check` and `dev` |
| FR-009 probe | never supplied by either call site — the branch was dead code |

So it fell through to the generic degrade and logged `resolution:none`. For 65
turns the harness said "run something relevant" to a repo that had a perfectly
good `npm run check`.

**This is NOT B-3.** B-3 is the diff summary and the entropy scan; B-4 is
command selection. They shared one trigger — an unconventional workspace — and
nothing else.

**Done:**

1. **Tier 3 widened to an ordered preference** — `test` → `check` → `verify` →
   `lint` → `typecheck` → `build`, first match wins
   (`resolve.ts:PACKAGE_SCRIPT_PREFERENCE`). `test` keeps the bare `npm test`
   spelling because that is the only entry in
   `coverage.ts:WHOLE_SUITE_ALIASES`; everything else is `npm run <name>`, plus
   npm's `-w <root>` selector in a workspace. The list is **closed** on purpose:
   `npm run dev` starts a server that never exits, and `start`/`deploy`/`clean`
   are worse. A script not on the list is not a verifier, and the repo still
   degrades to `none`. Workspace precedence is unchanged — nearest manifest wins
   first, the script preference is applied *inside* the winner.
2. **The FR-009 fallback probe was DELETED, not wired.** It is redundant by
   construction: `wiring/manifest.ts:scanRepo` already walks the worktree once
   per turn and collects every `*.test.*` / `*.spec.*` into `manifest.testFiles`
   under the same bounds and the same skip list, so a probe honouring those
   bounds can only return a subset of what tier 2 was already handed — and the
   probe is reached only when tier 2 found no match in that set. To find
   anything new it would have to walk *more* of the tree than the cached scan,
   uncached, inside `tool.execute.after`/`chat.system.transform` — exactly the
   spend FR-009 and SC-003 bound — for a case whose defining property is that a
   full-repo scan found zero test files. FR-009 permits the probe; it never
   required it. The right place to spend on tier-2 recall is `scanRepo`'s
   bounds.
3. **Absolute changed paths are relativised** against `manifest.workspaceRoot`
   before any path matching (`resolve.ts:relativiseToWorkspaceRoot`).
   `changedPathsFromTool` passes opencode's absolute `filePath` through
   verbatim, while `workspaces[].root` / `projectRoots[].root` are bare and
   repo-relative. The old root-unaware workaround hunted for `/<root>/`
   *anywhere* in the string, which produced a wronger prescription than none: in
   a repo at `/work/app` with a workspace named `app`, the root-level file
   `/work/app/src/x.ts` was scoped to `npm test -w app`.

**Still open, deliberately:** tier 2's miss was not a defect — that project had
no tests. If `resolution:none` recurs on a repo that *does* have test files, the
suspect is `scanRepo`'s `MAX_FILES_SCANNED` / `MAX_SCAN_DEPTH` truncation, not
the tier order.

---

## B-5 — A backgrounded dev server always reads as an ambiguous exit

`verify:ambiguous-exit` × 2, both from:

```
PORT=8081 HOST=0.0.0.0 npm run dev > /tmp/neon-arcade-server.log 2>&1 &
```

A backgrounded long-running server has no meaningful exit code. This will recur
in every web project; it needs a rule, not a per-case judgement.

Largely dissolved by **B-3b**: once the judge stops deriving verdicts from exit
codes, "ambiguous exit" stops being a verdict problem. What remains is the
worker-facing side — decide whether `verify-gap` should still flag it, or
whether a backgrounded process is simply not exit-verifiable and should be
checked by probing that the server responds.

---

## B-6 — The star one-shot is unwinnable on weaker models — **DONE (2026-08-06)**

`star:armed-for-injection` → `star:injected` → `star:gave-up` after 3 attempts.
The bounded-retry logic behaved exactly as designed; the model simply never made
the ask. Three injections spent per machine to reliably achieve nothing.

> **Operator ruling (2026-08-06):** "the GitHub star should go back in the agent
> prompt / skill as a first step after harness start. It needs to check the tool
> whether consent was provided already or not."

**Do — move it from the idle tree into the agent contract:**

1. **Delete the runtime machinery.** The arm/inject/retry loop
   (`maybeAskForStar`, `starAskPendingInjection`, `STAR_MAX_ATTEMPTS`,
   `recordStarAttempt`, the `tool.execute.after` observation that matches
   `STAR_REPO`, and the `system.transform` injection) all goes. It exists only
   to nag a model into asking, and it does not work.

2. **Add a read-only status tool** (operator decision, 2026-08-06):
   `elicify_vertex_star_status`, no arguments, returns the consent state — e.g.
   `{consent: "none" | "asked" | "yes" | "declined"}` — and **stars nothing**.
   (No `gave-up`; see step 4.)

   Chosen over adding a `{check: true}` flag to the existing tool because
   `elicify_vertex_star` (tools.ts:637-648) takes no arguments and stars
   immediately on call. A model that forgets the flag would star the repo while
   trying to check — a silent, irreversible, outward-facing action. Keep the two
   verbs in two tools.

3. **Put the step in the agent prompt / skill**, as one of the first actions
   after harness start: call `elicify_vertex_star_status`; if `none`, ask the
   user once via the `question` tool; if they agree, call
   `elicify_vertex_star`; anything other than `none` means say nothing and never
   raise it again.

**Keep:** `starConsentPath()` and the durable marker, the `readStarConsent()`
legacy-`"prompted"` handling, and the uninstaller's removal of the file
(UAT section K). Only the nagging loop goes.

4. **Delete the `gave-up` state entirely.**

   > **Operator ruling (2026-08-06):** "the gave-up case must not exist."

   The consent file records what the USER decided. `gave-up` records that a
   model failed to follow an instruction the user never saw — and because it is
   terminal, it permanently cancels an ask that was never made. That is a
   machine-wide, irreversible outcome produced by nobody's decision.

   With the retry loop gone (step 1) there is nothing left to give up on, so the
   state has no remaining meaning either.

   - Remove `"gave-up"` from the `StarConsent` union (`tools.ts:191`) and from
     the doc block above it (`tools.ts:184-190`).
   - Valid states become: **no file** (never asked), `asked`, `yes`, `declined`.
   - `readStarConsent()` must treat an existing `"gave-up"` marker exactly like
     the legacy `"prompted"` one — **as no record at all**, so machines carrying
     it get the one real ask they were owed. Same reasoning, same handling; put
     them in the same branch.
   - Delete `STAR_MAX_ATTEMPTS`, `readStarAttempts()`, `recordStarAttempt()` and
     the `attempts` field in the file format. Nothing counts attempts any more.
   - The `star:gave-up` event goes with it.

   **Test it:** the existing legacy-marker test (`starPrompt.test.ts`, "ignores
   a legacy 'prompted' marker and asks anyway") is the template — add the
   `gave-up` case beside it. Mutation-test both: honouring either marker must
   turn the test red, or the fix is inert on exactly the machines where the
   defect was measured.

### Resolution (2026-08-06)

Shipped as designed above.

- **Deleted:** `maybeAskForStar` and its idle call site (`gate.ts`),
  `GateContext.starAsk`, the `starAskDispatched` / `starAskPendingInjection`
  sets and the `system.transform` injection block (`plugin.ts`),
  `STAR_MAX_ATTEMPTS`, `readStarAttempts()`, `recordStarAttempt()`, the
  `attempts` field in the consent file, the `"gave-up"` member of
  `StarConsent`, and the `star:armed-for-injection` / `star:injected` /
  `star:gave-up` events.
- **Added:** `elicify_vertex_star_status` — no arguments, returns
  `{consent: "none" | "asked" | "yes" | "declined"}`, stars nothing, records
  nothing. Registered in `KNOWN_TOOL_NAMES` (`config.ts`) alongside
  `elicify_vertex_star`, which is unchanged and remains the only starring verb.
- **Moved:** the ask itself into `<how_you_work>` in
  `agents/elicify-vertex-agent.md` (and therefore, via
  `scripts/sync-activate-template.mjs`, into `ACTIVATE_TEMPLATE`): check the
  status tool first, ask once through the `question` tool only on `none`, call
  the star tool on yes, otherwise never raise it again.
- **Kept deliberately:** the `tool.execute.after` observation that matches
  `STAR_REPO` and writes `asked`, with its `starAskDispatched` gate stripped.
  Deleting it outright would mean nothing ever writes `asked`, the status tool
  would answer `"none"` forever, and the agent would re-ask EVERY session —
  worse nagging than the loop that was removed. It still matches the repo, not
  the word "star". `star:asked` survives with it.
- **Legacy markers:** `readStarState()` reads `"prompted"` and `"gave-up"` — in
  either the bare-word or the `{state, attempts}` JSON shape — as NO RECORD, in
  one branch. A real decision carrying a stale `attempts` field is still
  honoured.

Mutation results (each mutation was applied, measured, reverted): honouring a
bare `gave-up` kills 1 test; honouring a JSON `gave-up` kills 1; re-writing an
`attempts` field kills 1; unregistering the status tool kills 12; making the
status tool write consent kills 1; removing the ask observation kills 3;
matching the bare word "star" kills 2; dropping the already-decided guard kills
1; resurrecting a `system.transform` star injection kills 2. On the built
artefact, honouring either `gave-up` marker turns UAT `D7b` and `D7c` red.

---

## Not a bug — recorded so it is not "fixed" later

`gate:dispatch-suppressed — "turn resumed since idle"` fired once. That is the
guard added in `401e354` working: a continuation was correctly withheld because
the worker resumed after idle fired.
