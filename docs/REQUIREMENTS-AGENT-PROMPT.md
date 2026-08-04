# Requirements: the elicify-vertex agent prompt

Status: **DRAFT for review.** Written 2026-07-28 from defects observed in live
sessions, not from theory. Every mitigation below traces to something that
actually went wrong.

Scope: `agents/elicify-vertex-agent.md` (266 lines) and the `/elicify-vertex`
activation template in `src/v2/wiring/config.ts` (4 sentences). Both are the
model-facing contract; the plugin is the enforcement.

---

## 1. Principles

**P-1 — The prompt states the contract; the harness enforces it.**
Anything that MUST hold gets a mechanism. Prose alone is advice, and advice that
costs nothing to ignore gets ignored under time pressure. Where a rule matters,
this document names the enforcing mechanism alongside the wording.

**P-2 — Every factual claim the prompt makes about the code must be verifiable
by a test.** The prompt spent an entire release naming five tools that did not
exist, with a green suite, because every existing assertion was structural.

**P-3 — Advice fires at the wrong time; challenges fire at the decision point.**
A rule at the top of a 266-line prompt is thousands of tokens away from the
moment it applies. Where possible, deliver the reminder through the tool the
model is actually calling.

**P-4 — Do not add anything the model can self-report as evidence.** Receipts
and waivers are signed precisely because self-report is not evidence. The prompt
must not introduce a softer parallel channel.

---

## 2. What must be preserved

These already work and are the product of substantial behavioural research. No
rewrite may weaken them; changes here need explicit justification.

| Section | Why it stays |
|---|---|
| `<delegation>` | The wave pattern, the five-part delegation package (CONTEXT / VERTEX / SCOPE / DEFINITION OF DONE / RETURN), mandatory vertex-fied subagents, and "never implement sequentially what is independent". This is the most operationally load-bearing section in the file. |
| `<parallel_execution>` | Parallel tool calls when there is no data dependency; no placeholder parameters to force parallelism. |
| `<reasoning_protocol>` | UNDERSTAND → ... → CRITIQUE before committing to a plan. The critique step is where "what would make this fail?" lives. |
| `<uncertainty>` | The capability-ceiling ladder: delegate the stuck slice → escalate to a stronger model → report the limit honestly. Distinguishes a procedure gap from a capability gap. |
| `<scope_discipline>` | Confirm-before-destructive; no incidental refactors. |
| `<communication>` / `<output>` | Lead with the outcome; do not narrate. |
| `<vertex_behavior>` | The four-bullet verification hierarchy, and "Write/Edit success is authoring, not verification". |

---

## 3. Delegation and parallel waves — MANDATORY

**R-1** The prompt MUST require the wave pattern for non-trivial work, and MUST
NOT present it as optional. Sequence: **fan out build wave in parallel → wait for
all → review wave in parallel → fix wave → final sign-off.**

**R-2** Every delegation MUST carry the five-part package (CONTEXT with exact
paths, VERTEX instruction, SCOPE with non-goals, verifiable DEFINITION OF DONE,
RETURN shape). Pass only the needed slice — never the full conversation.

**R-3** Every spawned subagent MUST run vertex-fied and is independently
accountable for its own evidence gate. The parent does NOT verify on the
subagent's behalf.

**R-4** File ownership MUST be assigned explicitly and disjointly per wave. Two
subagents editing one file is a defect in the delegation, not in the subagents.
*Observed:* concurrent agents in this repo produced a transient red suite and one
agent's restore silently reverted another's edits — invisible in `git diff`.

**R-5** Fan-out MUST be sized to the dependency graph: fewer than 3 independent
units means do it yourself. Orchestration overhead is only justified by real
parallelism.

**R-6** Reviewer findings MUST route back to the unit that produced them; one fix
subagent MUST NOT touch multiple units. If two subagents touched one file, the
parent resolves the conflict by reading the diff.

**R-7** Incomplete or unverified subagent work MUST NOT be integrated —
re-delegate with tighter scope, or do it directly.

---

## 4. Clarification and grounding before planning

*Observed:* request at 05:16:43 → 6-story plan at 05:18:14. **Zero `question`
tool calls.** The request ("a mature UI" for a governance product) had genuinely
forking ambiguity; the agent silently chose admin console AND approval workflow
AND dashboard. The entire existing requirement is one clause inside a 34-line
protocol saying "ask **one** focused question", with no consequence.

**R-8** The prompt MUST require clarification of forking ambiguity BEFORE
planning, and MUST NOT cap it at one question. The current "ask one focused
question" wording is a ceiling where none belongs.

**R-9** The prompt MUST distinguish decisions that fork the architecture (ask)
from decisions resolvable by reading the code (research, do not ask). A rule
that says "always ask" gets ignored as fast as one that says nothing.

**R-10** *Mechanism (implemented, `37b42da`).* `plan_create` returns a grounding
challenge naming the remedy — ask / research / `plan_clear` → ground → re-plan —
and states that clearing archives rather than destroys. Prompt wording must not
contradict it.

**R-11** The prompt MUST state that a plan is proposed and confirmed before
`plan_create`, and that a bare acknowledgement is not confirmation.
*Observed:* one plan was created on the strength of the user typing `"1"`;
another with no confirmation step at all.

---

## 5. Evidence, verifiers and the waiver escape hatch

*Observed:* 28 `verify:ambiguous-exit` events in one session. The agent's
verifiers passed and minted nothing, so it could not checkpoint — and it
responded by asking the user to **waive the evidence requirement**. The prompt
had modelled `;`-chaining itself, and offered no other move.

**R-12** The prompt MUST require verifiers to run as a single standalone command
— no `;` chaining, no piping into `tail`/`grep`/`head` — and MUST explain WHY
(the aggregate exit status is the last command's, so the harness cannot trust
it). *Partially implemented.*

**R-13** The prompt MUST state that a passing verifier which mints no receipt is
a **command problem, not an evidence problem**, and MUST NOT be worked around
with a waiver. *Implemented in `4c97c42`.*

**R-14** The prompt MUST describe what the tools actually enforce, because the
model cannot infer it: receipts are MINTED by the harness and signed (a
hand-written id is rejected); a receipt is bound to the story active when it was
observed; it goes stale when the attested code changes; waivers are signed the
same way and need a real user message id. *Implemented in `4c97c42`.*

**R-15** The prompt MUST NOT present `plan_clear` as a way to escape an
inconvenient checkpoint, while MUST presenting it as the correct move for
re-planning after grounding. These are one sentence apart and easily confused.

---

## 6. Completion

*Observed:* 517 messages, 6-story plan, not one story ever checkpointed, session
closed silently, verifier never ran.

**R-16** The prompt MUST state that a story plan is a contract: every story ends
`complete`, or `blocked`/`failed` **with a stated reason**. Silently leaving a
story open is not an available option.

**R-17** *Mechanism (implemented, `37b42da`).* The idle gate deterministically
blocks on an incomplete plan and names what would close the active story. Prompt
wording must match what that message says, so the two do not contradict.

**R-18** The prompt MUST state that the completion verifier runs only after every
deterministic marker passes, and that its verdict is advisory — it never
substitutes for evidence.

---

## 7. Prompt/code contract integrity

*Observed:* the prompt named `elicify_vertex_goal_*` (five tools), a
`/elicify-vertex-goal-*` command family and `goals.json` — none of which existed
after the greenfield cut — plus argument shapes (`stories[{title, objective}]`)
that did not match the schema. A live session worked only because the model
ignored its instructions.

**R-19** Every tool name, slash command, file path and argument shape in the
prompt MUST match the code. *Enforced by `tests/agent-prompt.test.ts` as of
`3f2642a`, which diffs the prompt against `wiring/tools.ts` at test time.*

**R-20** Every registered tool MUST appear in the prompt — a new tool must not
ship silently undocumented. *Enforced.*

**R-21** Structural assertions about the prompt are NOT sufficient. The existing
tests checked section names and bullet counts and caught none of the above.
Any new prompt rule that references the code needs a corresponding check.

---

## 8. Activation parity

*Observed:* `/elicify-vertex` injects 4 sentences. `--agent
elicify-vertex-agent` injects 266 lines. Same product, two very different
contracts, with no indication to the user which they got.

**R-22** The two activation paths MUST NOT deliver materially different
contracts. Resolve by one of:
  - **(a)** the slash template instructs the model to adopt the agent's contract
    and points at it;
  - **(b)** the template carries a compressed version of the same rules;
  - **(c)** the template is explicitly documented as a reduced mode, and says so
    to the user on activation.

**R-23** Whichever is chosen, the clarification (§4), verifier (§5) and
completion (§6) rules MUST be present in BOTH paths. These are the three that
produced real defects.

**OPEN — needs a decision.** (a) is least duplication and least drift; (c) is
most honest if the template must stay short. Recommend (a).

---

## 9. Non-requirements

Stated to prevent drift back toward things already rejected:

- **No self-reported clarification fields.** `clarifiedWith` / `openUnknowns` on
  `plan_create` were designed and dropped: they duplicate data the host already
  records trustworthily in `opencode.db`, with an unverifiable copy written by
  the model, and a populated field *looks* clarified whether or not it is.
- **No gate on `question`-tool usage.** It measures a proxy: the model may
  clarify in conversation without the tool, or need to clarify and not realise.
- **No hard refusal in `plan_create`.** It would deadlock headless runs
  (`opencode run`, CI) where nobody can answer.

---

## 10. Verification

**V-1** Prompt changes ship with `tests/agent-prompt.test.ts` green, including
the code-contract assertions.

**V-2** Any new prompt rule that the harness enforces MUST name the enforcing
mechanism in this document, so prose and mechanism cannot drift apart silently.

**V-3** Behavioural claims ("the agent asks before planning") are verified by a
UAT scenario against a real model, not by reading the prompt. The prompt was
green on every structural check while being materially wrong.

---

## 11. Open questions for review

1. **§8 activation parity** — (a), (b) or (c)?
2. **Prompt length.** 266 lines is already long, and §3–§6 add material. Is
   there anything in the current file whose value no longer justifies its
   tokens? A prompt nobody finishes reading is its own failure mode.
3. **`blocked`/`failed` terminal states.** Related open defect: there is no
   reopen path, so such a plan can never reach all-complete and the new gate
   nudges forever. Prompt wording for R-16 depends on how that resolves.
4. **Does the wave pattern belong in the slash path at all?** It is the most
   valuable section and the most expensive in tokens.
