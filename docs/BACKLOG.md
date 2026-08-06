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

## B-3 — The verifier ran once in 51 minutes, and judged without the diff

One `story:verifier-audit` across the whole session, and that single run had a
hole in its evidence:

- `verifier:field-dropped` — `diffSummary`
- `verifier:field-truncated` — `recentTranscript`, 5923 → 4000 cap

A verifier forming a verdict without the diff is the failure mode that produced
the worker/verifier standoffs already fixed this round. Find out why
`diffSummary` was dropped (empty? redacted? `git diff` failed?).

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

---

## B-6 — The star one-shot is unwinnable on weaker models

`star:armed-for-injection` → `star:injected` → `star:gave-up` after 3 attempts.
The bounded-retry logic behaved exactly as designed; the model simply never made
the ask. If `gave-up` is the normal outcome on non-frontier models, the feature
is spending three injections per machine to reliably achieve nothing.

---

## Not a bug — recorded so it is not "fixed" later

`gate:dispatch-suppressed — "turn resumed since idle"` fired once. That is the
guard added in `401e354` working: a continuation was correctly withheld because
the worker resumed after idle fired.
