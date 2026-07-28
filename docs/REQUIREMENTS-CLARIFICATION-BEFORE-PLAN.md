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

## Feasibility — both halves are already available

**Deterministic (preferred).** `tool.execute.after` in `src/v2/plugin.ts` fires
for EVERY tool; it filters only self-created sessions and inactive state. So the
harness can record whether the `question` tool was actually invoked, and when,
per session. That is observed evidence, in keeping with this codebase's rule of
observed-over-intent — the agent cannot claim to have asked.

**Self-attestation (secondary).** `plan_create` currently accepts only
`stories`. Adding fields is additive and non-breaking.

## Design

Two layers, mirroring how receipts and waivers work:

1. **Observed check.** Track `question`-tool usage per session. At
   `plan_create`, if no clarification has been observed since the user's last
   substantive request, the tool returns a **constructive refusal** naming what
   is unclear-by-default: unstated acceptance criteria, unstated scope
   boundaries, and any story whose `acceptanceItems` are vague.
2. ~~**Recorded attestation.**~~ **DROPPED after review.**

   The first draft added `clarifiedWith: string[]` and `openUnknowns: string[]`
   to `plan_create`. Both are removed:

   - `clarifiedWith` duplicates data that already exists in a TRUSTWORTHY place.
     The real questions and the user's real answers are recorded in
     `opencode.db` as tool parts, written by the host. Copying them into
     `plan.json` produces an unverifiable duplicate of verifiable data — written
     by the model. That is exactly the pattern receipts and waivers were signed
     to eliminate, and it is worse than useless: a plan showing a populated
     `clarifiedWith` LOOKS clarified to a reviewer whether or not it is.
   - `openUnknowns` has some value as a forcing function — writing down what you
     could not resolve changes the plan you write — but that is a behavioural
     nudge, and nudges belong in the agent prompt, not in a schema field the
     harness cannot verify.

   If the judge needs the clarification content at close-out, it should read the
   session's actual `question` tool parts, not the model's summary of them.

   Layer 1 carries the whole requirement.

## Acceptance criteria

- **AC-1** With no `question` tool call observed in the session and a
  non-trivial plan (>1 story, or any story lacking concrete acceptance items),
  `plan_create` refuses and returns text naming what needs clarifying.
- **AC-2** The refusal is constructive: it lists the specific unknowns it
  detected, not a generic "ask the user first".
- **AC-3** After a real `question` call, the same `plan_create` succeeds.
- **AC-4** A trivial plan (single story with concrete acceptance items) is NOT
  blocked — the gate must not tax one-shot work.
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
