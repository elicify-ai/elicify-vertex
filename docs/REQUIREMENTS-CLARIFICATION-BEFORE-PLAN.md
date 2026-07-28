# Requirement: clarification check before planning

Status: **OPEN — not implemented.** Raised 2026-07-28 from a live session.

## The requirement

`elicify_vertex_plan_create` must not accept a plan that was written without the
agent first clarifying requirements and unknowns with the user. When the agent
starts planning, the harness reminds it — and can refuse.

## Why this is not just a prompt fix

The agent prompt already contains the advice, and it did not hold. Today's
session (`ses_0668b2422ffe…`, msg #269→#274):

```
05:16:43  user      "as a product manager ... it needs a mature ui ..."
05:16:54  assistant "This is a substantial product UI effort. Let me load the
                     relevant skills first, then plan and execute."
05:18:14  TOOL      elicify_vertex_plan_create   (6 stories)
```

**Zero `question` tool calls today.** Eleven seconds from request to work, 91
seconds to a 6-story plan, with no clarification and no plan proposal. The
request had real forking ambiguity — "mature UI" for a governance product could
be an admin console, an approval-workflow UI, or a dashboard; the agent silently
chose all three.

The prompt's entire clarification requirement is one clause buried in step 1 of
a 34-line reasoning protocol:

> *"If any are ambiguous, ask one focused question (via the question tool)
> rather than guessing scope."*

Advisory, singular ("one focused question"), and with no consequence for
skipping it. The `/elicify-vertex` slash template says nothing about
clarification at all. Advice that costs nothing to ignore will be ignored under
time pressure — which is the same reason receipts are signed rather than
requested.

Compare the 07-25 turn in the same session, where the agent DID stop and ask
four architecture questions before planning. The behaviour is not absent, it is
unreliable — so it needs a gate, not more words.

## Design — a reflective challenge, NOT a checker

**Revised after review.** The first two drafts both got this wrong in the same
direction: they tried to VERIFY clarification (has the `question` tool been
called?) and refuse if not. That measures a proxy, not the thing. The model may
legitimately have clarified in conversation without the tool, or — the case that
matters — may need to clarify and not realise it. Checking tool usage catches
neither.

The mechanism is instead a **reflective challenge delivered at the decision
point**: when `elicify_vertex_plan_create` fires, its return text puts the
question in front of the model while the plan is still fresh and cheap to
change:

> **Before you act on this plan — was it grounded, or guessed?**
>
> - Did you ground it in research and user interview?
> - Have you eliminated the unknowns as far as possible?
>
> If material questions remain, do ONE of these now, before writing any code:
>
> 1. **Ask the user** — use the question tool for the decisions that fork the
>    architecture. Cheaper now than after four stories are built on a guess.
> 2. **Research it** — read the code, the docs, the existing conventions, and
>    resolve what can be resolved without asking.
> 3. **Clear and re-plan** — if the stories encode assumptions rather than
>    findings, call `elicify_vertex_plan_clear`, ground the work, then
>    `elicify_vertex_plan_create` again. The old plan is archived, not lost.
>
> Proceeding is also a valid answer — but only if you can say what the plan is
> grounded IN.

**Naming the remedy is load-bearing, not politeness.** An open question with no
stated escape route defaults to "yes, I grounded it" — that is the cheapest
answer and requires no work. Listing the three concrete moves, and naming the
exact tools, makes the expensive answer available and legitimate. Saying "the
old plan is archived, not lost" matters for the same reason: without it,
clearing a plan reads as destructive and the model will avoid it. (It is true —
`createPlan` and `clearPlan` both archive as of `57dcc3f`.)

Properties that make this the right shape:

- **Not a gate.** Cannot deadlock a headless `opencode run` or CI, where nobody
  can answer. The plan is created; the model is asked to reflect on it.
- **Right moment.** Fires exactly when the model has committed its assumptions
  to stories, which is when re-opening them is cheapest. A prompt-level rule
  fires at session start, thousands of tokens before it is relevant.
- **Uses an existing channel.** Tool return text is already how receipt ids
  reach the model, and it demonstrably reads it.
- **Nothing to forge.** It asks nothing of the model that gets recorded as
  evidence, so it introduces no new self-report to trust.

The model may answer the challenge by proceeding, by asking the user, or by
calling `elicify_vertex_plan_clear` and re-planning. All three are acceptable;
what is not acceptable is the current behaviour, where nothing prompts the
question at all.

## Feasibility

`elicify_vertex_plan_create` already returns text to the model, and
`tool.execute.after` fires for every tool if a stronger signal is ever wanted.
No new plumbing.

## Acceptance criteria

- **AC-1** `elicify_vertex_plan_create`'s return text contains the reflective
  challenge: grounding in research/user interview, and elimination of unknowns.
- **AC-2** The challenge is specific to the plan just created where it can be —
  e.g. naming stories whose acceptance items are vague — rather than being
  identical boilerplate on every call.
- **AC-2b** The challenge NAMES the remedy, with the exact tool calls: ask via
  the question tool, research, or `plan_clear` -> ground -> `plan_create`. It
  must also state that clearing archives rather than destroys, or the model will
  treat re-planning as costly and avoid it. A challenge that only asks the
  question defaults to "yes" and changes nothing.
- **AC-3** `plan_create` still SUCCEEDS. It is a challenge, not a gate: no
  refusal, no deadlock in headless runs.
- **AC-4** The challenge is proportionate: a single-story plan with concrete
  acceptance items gets a short form or none, so one-shot work is not taxed.
- **AC-5** No self-reported clarification field is added to `plan.json`. If the
  judge needs clarification context, it reads the session's real `question` tool
  parts.
- **AC-6** Mutation-verified: removing the observed-clarification check turns a
  named test red, and the AC-4 discrimination test proves trivial plans pass.

## Open design questions

1. **Refuse or warn?** A hard refusal is stronger but can deadlock an agent that
   cannot reach the user (headless `opencode run`, CI). Suggest: refuse when a
   UI is attachable, warn-and-record otherwise — the harness already knows
   whether toasts/questions are available.
2. **What resets the requirement?** Per session, or per substantive user
   request? A long session that re-plans three times (this one did) probably
   needs re-clarification per new objective, not once ever.
3. **Interaction with `plan:replaced`.** A second `plan_create` now archives the
   first; should replacing a plan require fresh clarification?

## Related

- `docs/REQUIREMENTS-IDLE-COMPLETION-GATE.md` — the other half of the same
  problem: this one governs how work STARTS, that one how it ENDS.
- Inspiration: `trailofbits/ask-questions-if-underspecified`, which pauses on
  ambiguous objectives / unclear scope / missing constraints and **waits for
  answers before proceeding** — a blocking gate rather than advice.
