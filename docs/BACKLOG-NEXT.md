# Backlog — next round

Opened 2026-08-07. The previous round's backlog (`docs/BACKLOG.md`) is closed;
items there are done or explicitly recorded as open residuals.

---

## Q-1 — The agent under-asks. Give it a way to know when it has enough. **[priority]**

### The observation

In live use the agent asks **exactly three questions**, every time, regardless
of how underspecified the task is.

### Root cause — structural, not wording

Two causes, stacked. Neither is fixed by rewording the grounding rules.

**1. The contract is subtractive by design.**

- `agents/elicify-vertex-agent.md:101` — *"**One ask, not a battery.** A single
  `question` call carries every remaining fork."* One call, and the `question`
  tool bounds what fits in it. Three is the fill, not a judgement.
- `:66` — *"Resolve unknowns in this order. Only what survives becomes a
  question."* A funnel whose every rule **removes** questions.
- `:102` — *"drop any question that does not change what you build."*

It asks three because the contract says ask once and prune hard. It is obeying.

**2. The working model grades its own ambiguity.**

[Ask or Assume](https://arxiv.org/html/2603.26233v1) ran exactly this
comparison over 500 coding tasks:

| Design | Avg questions | Cost/task |
|---|---|---|
| Single agent self-assessing "do I have enough info?" | **1.84** | $1.63 |
| **Separate intent agent** analysing the conversation | **3.06** | $3.50 |

A separate agent nearly doubled the count with *no* metric on either side —
both were pure prompting. Their ask-rate also scaled with task difficulty
(62% easy → 100% hardest), so the calibration came from the architecture.

We are running the 1.84 design.

[CaRT](https://arxiv.org/pdf/2510.08517) names the underlying bias: models get
no negative signal for stopping information-gathering early, so termination is
under-trained. Its remedy is contrastive pairs — the same task shown as
sufficient *and* insufficient — so the boundary is learned rather than
habituated. The prompt-only equivalent is worked examples of both, not a rule.

### BLOCKING CHECK — do this first, it is ~10 minutes

Does opencode's `question` tool cap questions per call? If it caps at 3–4, then
"one ask, not a battery" makes three a **hard ceiling** and no prompt or agent
change moves it — multi-round asking becomes the prerequisite for everything
below, and the order of work changes. Do not start the rest until this is
answered.

### Do

**Architecture (highest leverage, has measured evidence):** move the
sufficiency judgement out of the working model and into a `vertex-intake`
subturn. `runSubturn` and the intake agent already exist; this is wiring, not
new machinery.

**Measurement, two layers:**

1. **Gate — reconstruction test (cheap, countable).** Can the model write every
   acceptance criterion *and* the verifier command with no placeholder? Each
   placeholder is exactly one unasked question. No sampling cost; plugs into
   the existing pinned-criteria machinery.
2. **Generator — sample-and-diverge (training-free).** When the gate fails,
   have the intake subturn draft the acceptance criteria **k times
   independently**. Where the drafts disagree, the disagreement *is* the
   missing information, and each axis of divergence names a question. This is
   [semantic entropy](https://arxiv.org/html/2510.21310v2) applied to plans:
   sample, cluster by meaning, measure spread. It yields both a number (axes
   diverged) and the questions themselves.

**Replace the count with a stopping condition.** Any literal number anchors —
"up to 3" reads as "exactly 3". Use a test the model applies to itself:
*keep asking until you could write the acceptance criteria without guessing.*

**Allow a second round.** Answers create forks; question 4 is unknowable before
answer 2. The contract currently forbids exactly this. Gate it: *if an answer
opened a new fork, ask once more.*

**Compute the value-of-information rule instead of only stating it.** Line 102
already encodes the right criterion — ask only if a different answer changes
what you build — but nothing ever evaluates it. See
[cost-penalised EVPI](https://arxiv.org/pdf/2606.03135).

**Cover dimensions, not one dimension three times.** Scope boundary ·
acceptance criteria · what *not* to do · environment and constraints. Three
questions all about library choice are worth less than one that surfaces a
hidden constraint.

### Do NOT

- Raise the number in the prompt. That swaps one fixed count for another.
- Delete the pruning funnel wholesale. Its *intent* is right — questions the
  project already answered are noise. The defect is that it prunes without ever
  measuring what pruning cost.

### Acceptance

- Question count **varies with task ambiguity** — demonstrated on a spread of
  tasks from fully-specified to badly underspecified, with the measured counts
  recorded. A fixed number at any value is a failure, including a higher one.
- The gate is **measurable and measured**: `criteria:*`-style events show when
  reconstruction failed and how many placeholders remained.
- A **compliance signal exists**, in the shape that already works here: did the
  acceptance criteria change after the answers? Questions that changed nothing
  are decorative and must be visible as such.
- Every behavioural change is **mutation-tested** — remove the fix, confirm the
  test goes red. This round found seven vacuous tests; the shapes most likely
  to be vacuous are assertions on a count, a length, or an absence.

### Why this went unnoticed

Questions have no compliance signal. `verify-gap` works and is measured
(9 rendered / 14 complied in the field session); `intake-scaffold` scored 0
partly because its compliance was undetectable rather than absent. An unmeasured
directive cannot be known to be failing — which is the general lesson, not a
fact about questions.
