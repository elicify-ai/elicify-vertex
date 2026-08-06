# Backlog — current fixing round

Opened 2026-08-06. Items are evidenced from the live opencode session
`ses_02956d08…` (MiniMax-M3, `/workspace/vertextest4`, 10:40–11:31, 450 events)
unless stated otherwise.

> Caveat on the evidence: the event log was deleted twice during an uninstall
> cleanup earlier that morning, so counts below are a lower bound.

---

## B-1 — The verifier inherits the worker's model. Delete the machinery that pretends otherwise. **[priority]**

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

## B-2 — The intake scaffold is starved by the per-turn cap and complied with zero times

`per-turn-cap:dropped` fired **179 times**, every one of them
`family: "intake-scaffold"`, `priority: "phase-guidance"` — from turn 1 (`D-2`)
through turn 5 (`D-98`, which hit `budget:dropped` instead). Over the same
session:

| family | rendered | complied |
|---|---|---|
| `intake-scaffold` | 9 | **0** |
| `scope-watchdog` | 3 | **0** |
| `verify-gap` | 9 | 14 |

179 dropped against 15 complied is the harness generating guidance it then
discards. Two of three families had no observable effect at all.

Related symptom: the phase machine never settled — 9 transitions, 7 of them
`execute->execute`, and `intake->execute` fired **twice** (it re-entered intake
after already executing).

**Unknown:** whether the cap is too low, the scaffold too chatty, or the
re-entry is generating duplicate findings. Not yet diagnosed. Note this is
*not* downstream of B-1 — the profile resolved to `standard` either way.

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

---

## B-4 — `resolution:none` × 65, including turns with real edits

Most carry `changedPaths: []`, but some carry genuine ones —
`src/games/memory.js`, `index.html`, `src/games/breakout.js` — and still
resolved to nothing.

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
