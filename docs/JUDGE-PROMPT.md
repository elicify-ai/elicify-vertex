# The judge's actual prompt

Status: **IMPLEMENTED.** This document originally described the shipped
prompt (§1-3) alongside two draft redesigns raised 2026-07-28: §4 (verdict
redesign — `{fit, summary, gaps}` replacing `{fit, notes}`) and §5 (input
redesign — `lastResponse`/`recentTranscript` added to the payload). Both are
now **implemented, in this same diff** — `JUDGE_SYSTEM_PROMPT`,
`JudgeVerdict`, `isJudgeVerdictShape`, `buildJudgePayload`, and
`appendJudgeCloseOut`'s rendering all reflect §4+§5 as shipped, not proposed.
§1-3 below have been updated in place to match what actually ships; §4/§5
further down are kept as the historical design record of *why* (rationale,
rejected alternatives, empirical probes), each now marked implemented rather
than draft. See `tests/v2/judge.test.ts` / `tests/v2/integration-judge.test.ts`
for the coverage proving it.

Source: `src/v2/judge.ts` (`JUDGE_SYSTEM_PROMPT`), sent as the `system`
field of a `runSubturn` call in `runJudge`. Copied verbatim below.

## System prompt

```
You are an automated fit-for-purpose judge for a coding assistant's completed task. You will be given pinned acceptance criteria, a diff summary, and verifier output summaries as a JSON object. You will also receive the parent agent's own last response and a short recent transcript. Use these to catch overclaiming, hedging, or reasoning gaps the structured evidence alone would not show — but the structured criteria, diff, and verifier evidence remain the primary basis for "fit". Use your own judgment — decide whether the evidence actually supports each criterion being met, not just superficially present. Respond with exactly one JSON object and nothing else, matching this shape: {"fit": "pass" | "concern", "summary": "<one sentence>", "gaps": [{"issue": "...", "evidence": "...", "fix": "..."}]}. If fit is "pass", gaps must be an empty array. If fit is "concern", list every criterion or aspect that is missing, inconsistent, or unverified — each gap must name what is wrong and what would close it, specific enough that another agent could act on it without asking you to clarify. Do not ask questions, do not request tool access, and do not output anything other than the JSON object.
```

## What it actually receives

The system prompt is the whole instruction — there is no separate "user
turn" prose. The one message part is the payload itself, JSON-stringified
(`buildJudgePayload`'s return value, built in `appendJudgeCloseOut`):

```json
{
  "criteria": ["...pinned acceptance items..."],
  "diffSummary": "...",
  "verifierSummaries": ["..."],
  "lastResponse": "...the parent's own last assistant message, verbatim...",
  "recentTranscript": "user: ...\nassistant: ...\n...a bounded recent-turn window, both roles..."
}
```

`JudgePayload`'s five fields (`src/v2/judge.ts`, `JudgePayload`) are each
**optional** — a field that the secret-redaction scan emptied out entirely is
omitted from the JSON entirely (key absent, not `""`), so the judge sees
exactly what survived scanning and nothing else. `lastResponse` and
`recentTranscript` go through the identical redaction pipeline as the
original three fields (see §5 below for sourcing) — nothing about them is
exempt from the secret scan.

## Why it's this short

- **Zero-tool, evidence-only.** `vertex-judge` is registered with
  `permission: {"*": "deny", ...}` (`src/v2/wiring/config.ts` — see that file's
  header for why the tools-deny map alone doesn't work and the permission
  wildcard is the actual enforcement). The prompt's "do not ask questions, do
  not request tool access" line matches what the harness enforces structurally
  — the judge has no channel to act even if it tried.
- **Advisory, never gating.** `runJudge` fails open on every error path
  (`unsupported`, `unavailable`, `malformed` — see `JudgeRunResult`); a verdict
  is a signal, not a blocker. That's why the prompt doesn't need any of the
  main agent's evidence hierarchy, waiver rules, or escalation ladder — the
  judge isn't the one deciding whether work counts as done, it's giving a
  second opinion after the harness already decided.
- **One-shot, budgeted.** `JUDGE_TOTAL_BUDGET_MS` defaults to 90s (search
  `DEFAULT_JUDGE_TOTAL_BUDGET_MS` in `judge.ts` — line citations in this doc
  drift every time the file is edited; the symbol name doesn't) — raised from
  the spec's original 5s after live measurement showed a real remote-model
  round trip alone could take 28-45s.
  A long, exploratory prompt would eat directly into that budget for no
  return, since the judge gets exactly one turn and no tools to investigate
  further with.

## Compare to the main agent / subagent prompts

| | Words | Tools | Purpose |
|---|---|---|---|
| Main agent (`agents/elicify-vertex-agent.md`) | ~2,124 | Full toolset | Owns the whole task |
| Subagent (`src/v2/wiring/subagentInjection.ts`) | 460 | Whatever the delegation grants | Executes one bounded unit |
| Judge (this file) | 192 (was ~90 pre-§4/§5) | None | One JSON verdict + gap list, then gone |

Each tier's prompt size roughly tracks how much autonomy and channel-back it
actually has — the judge has the least of both, and its prompt is
correspondingly the smallest.

---

## 4. Verdict redesign — the verdict is too thin to drive completion

Raised 2026-07-28. **Implemented in this diff** (§1-3 above already reflect
the shipped result — this section is kept as the design record: the
rationale, and what it touches). Two separate claims, and only the second was
a real gap:

- The judge already reasons with genuine judgment, not a fixed checklist — it
  decides whether evidence *plausibly* satisfies each criterion, which is a
  qualitative call, not a deterministic one. JSON is the delivery envelope for
  that judgment (§3), not a constraint on how it's formed.
- **What's actually thin is the output.** `notes` used to be capped at "one or
  two sentences" and got rendered as a single chat line (the pre-§4 shape of
  what is now `formatJudgeVerdict` in `src/v2/wiring/gate.ts`):

  ```
  [vertex:judge] fit=concern — <one or two sentences>
  ```

  That can't carry "here is everything wrong and what would fix each one" —
  which is exactly the bar already required (and, separately, since built —
  see `gate.ts`'s `handleIncompletePlan`) of the *deterministic* stage-1 gate
  in `docs/REQUIREMENTS-IDLE-COMPLETION-GATE.md` AC-2: *"names, specifically:
  which stories are incomplete... and what evidence would close it — a
  generic 'keep going' does not satisfy this."* The judge should meet the same
  bar on the qualitative half of completion that AC-2 already sets for the
  mechanical half.

### Schema (shipped — `JudgeVerdict`, `judge.ts`)

```json
{
  "fit": "pass" | "concern",
  "summary": "<one sentence, overall assessment>",
  "gaps": [
    { "issue": "<what is missing, inconsistent, or unverified>",
      "evidence": "<what in the payload shows this>",
      "fix": "<what would close it, specific enough to act on directly>" }
  ]
}
```

`gaps` is `[]` when `fit` is `"pass"`. When `fit` is `"concern"`, every
criterion or aspect the judge doubts gets its own entry — this is the part that
turns a binary label into an actual to-do list.

### System prompt addition (shipped — folded into §1's prompt above, together with §5's addition)

```
You are an automated fit-for-purpose judge for a coding assistant's completed
task. You will be given pinned acceptance criteria, a diff summary, and
verifier output summaries as a JSON object. Use your own judgment — decide
whether the evidence actually supports each criterion being met, not just
superficially present.

Respond with exactly one JSON object and nothing else, matching this shape:
{"fit": "pass" | "concern", "summary": "<one sentence>", "gaps": [{"issue":
"...", "evidence": "...", "fix": "..."}]}.

If fit is "pass", gaps must be an empty array. If fit is "concern", list every
criterion or aspect that is missing, inconsistent, or unverified — each gap
must name what is wrong and what would close it, specific enough that another
agent could act on it without asking you to clarify.

Do not ask questions, do not request tool access, and do not output anything
other than the JSON object.
```

### Rendering (shipped — `formatJudgeVerdict`, `gate.ts`)

```
fit=pass:
  [vertex:judge] fit=pass — <summary>

fit=concern:
  [vertex:judge] fit=concern — <summary>

  To complete this to the standard expected:
  1. <gap[0].issue> — <gap[0].fix>
  2. <gap[1].issue> — <gap[1].fix>
  ...
```

### What this actually touches — not a doc-only change

- `src/v2/judge.ts`: `JUDGE_SYSTEM_PROMPT`, the `JudgeVerdict` type,
  `isJudgeVerdictShape` (new required `summary`/`gaps` fields, `gaps` shape
  validation), `parseJudgeResponse` (unaffected — still just extracts the
  outermost JSON object).
- `src/v2/wiring/gate.ts`: `appendJudgeCloseOut`'s rendering.
- `tests/v2/judge.test.ts`, `tests/v2/integration-judge.test.ts`: shape and
  rendering assertions need the new schema; existing `{fit, notes}` fixtures
  become invalid input and should get a coverage case each (old shape → still
  rejected as malformed, not silently accepted).
- Payload budget: `gaps` is unbounded model output inside a fixed 90s budget —
  worth deciding whether to cap array length or leave it, since a judge that
  starts padding gaps to seem thorough would cost real time for no benefit
  (`<how_you_think>`'s "over-thoroughness" trap, applied to a different agent).

---

## 5. Input redesign — the input is as thin as the output

Raised 2026-07-28, same session. **Implemented in this diff** (§1-3 above
already reflect the shipped result — this section is kept as the design
record). §4 fixed what the judge says; this fixes what it's given to say it
about.

**Confirmed empirically 2026-07-28** (background probe, not inferred from
reading our own code): `session.create({parentID})` is bookkeeping-only in
opencode 1.18.4. No parent conversation content reaches a child session's
model input through any implicit channel — proven by a prompt-cache collision
test (a parentless child's request hit the exact same cache prefix as a
parented child's, which is only possible if neither included the parent's
prior turns) and a full-database token scan (a sentinel string in the parent's
messages appeared in exactly one row across the whole DB — its own). So there
is no hidden channel already smuggling context in; the fields below are the
*only* way to give the judge any of it.

Before this change, the judge saw only `{criteria, diffSummary, verifierSummaries}` —
derived facts built from the *same* sources the deterministic stage-1 gate
already checks (`gate.ts`'s `appendJudgeCloseOut`: `ctx.pinStore.get`,
`ctx.diffSummary`, `ctx.recentVerifierSummaries`). It never sees a single word
the parent actually wrote. An LLM judge's only advantage over a machine check is reading nuance in
natural language — hedging, admitted gaps, overclaiming — and today it
structurally cannot, because no prose ever reaches it.

**Rejected: give the judge a tool to read the transcript itself**, whether a
bespoke search tool or generic `read`/`grep` against a session file path.
Checked directly (`ls ~/.local/share/opencode/`): the transcript lives only in
`opencode.db`, a SQLite database — no per-session text export exists.
`grep`/`read` are built for text files; they can't reconstruct which session,
message, or part a raw-byte match belongs to. And even a hypothetical
`sqlite3`-via-`bash` version would read **raw, unredacted** rows straight from
the DB, defeating `buildJudgePayload`'s existing secret redaction entirely —
worse than the problem it would solve. Multi-turn tool use inside the judge
also risks the documented 90s budget on its own: one round trip alone measured
28.8s-45.6s (see `DEFAULT_JUDGE_TOTAL_BUDGET_MS`'s doc comment in `judge.ts`).

**Instead: inject a bounded, pre-redacted amount of parent transcript as two
new payload fields** — same pipeline, same guarantees, no new permission
surface.

### New payload fields

- **`lastResponse`** — the parent's final assistant message before going idle,
  verbatim. Unambiguous: always exactly one message, no window to tune.
- **`recentTranscript`** — the last few turns leading up to it (both roles,
  compact `role: text` format), for context `lastResponse` alone might not
  carry (an earlier hedge, an earlier admitted shortcut).

### Sourcing and redaction

`client.session.messages({path: {id}})` — already proven working elsewhere in
this codebase (`tools.ts:58`, waiver validation), not new capability. Fetched
in `appendJudgeCloseOut` (`gate.ts`) alongside the existing `ctx.diffSummary`/
`ctx.recentVerifierSummaries` calls, then passed as two more raw fields into
`buildJudgePayload`, which redacts and caps them exactly like the three fields
it already handles — same `redactSecrets` + entropy scan, same "emptied by the
scan → field omitted, not sent as `\"\"`" rule.

### Caps (starting point, tunable)

- `lastResponse`: the existing `JUDGE_PAYLOAD_FIELD_CHAR_CAP` (2000 chars,
  `judge.ts`) — same cap as every other field.
- `recentTranscript`: shipped as **4000 chars**
  (`JUDGE_TRANSCRIPT_FIELD_CHAR_CAP`) — roughly double, since it carries
  multiple turns of nuance rather than one fact. Not measured against
  anything; a real number to argue with, not a claim.

### System prompt addition (shipped)

One clause added to §4's prompt: *"You will also receive the parent
agent's own last response and a short recent transcript. Use these to catch
overclaiming, hedging, or reasoning gaps the structured evidence alone would
not show — but the structured criteria, diff, and verifier evidence remain the
primary basis for `fit`."* Keeps prose as corroborating signal, not the
primary one — the structured facts stay load-bearing so a verbose but
evasive response can't talk its way to `fit: "pass"`.

### What this touches, in addition to §4's list

- `src/v2/judge.ts`: `RawJudgePayload`/`JudgePayload` gain the two fields;
  `buildJudgePayload` redacts/caps them the same way as the existing three.
- `src/v2/wiring/gate.ts`: `appendJudgeCloseOut` fetches parent messages via
  `ctx.client.session.messages` before building the payload.
- Redaction test coverage: a case proving a secret inside `lastResponse` or
  `recentTranscript` gets scrubbed exactly like one inside `diffSummary` today
  — this is the one place a regression would be a real security defect, not
  just a quality one.

Implemented — both §4 and §5 landed together in this diff, with the wave
discipline this note originally asked for: `src/v2/judge.ts`,
`src/v2/wiring/gate.ts`, `tests/v2/judge.test.ts`, and
`tests/v2/integration-judge.test.ts` all updated together, not as a doc-only
change.
