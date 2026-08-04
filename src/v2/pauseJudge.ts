/**
 * The pause judge — "is this turn waiting for the user, or did it just stop?"
 *
 * WHY THIS REPLACED A DETECTOR. The first answer to that question was a
 * regex: an intent lead-in (`I'll` / `let me`) plus a work verb, minus an
 * allowlist of hand-back phrases. It was wrong in both directions within two
 * live sessions:
 *
 *   - it stayed silent on "Let me lay out the plan and execute." because
 *     `lay out` / `execute` were not in the verb list;
 *   - it nudged "Green-light this and I'll create the plan and start." — a
 *     model correctly pausing for approval — because `green-light` was not in
 *     the hand-back list.
 *
 * The second case is the damning one: the agent contract tells the model to
 * propose a plan and "wait for unambiguous agreement", and the harness then
 * sent it a user-authority message saying "Do that work now… record the plan
 * with elicify_vertex_plan_create first". Two halves of the same system
 * issuing opposite orders, because one of them was pattern-matching a
 * judgement.
 *
 * "Is this model waiting for me?" is not decidable from a word list — the
 * phrasings are unbounded and the same words mean different things depending
 * on what was proposed. So it is decided the way every other genuinely
 * ambiguous question in this harness is decided: by a model, in an isolated
 * subturn, with the evidence in front of it.
 *
 * WHAT MAKES THIS AFFORDABLE. A judgement call costs a model call, so it must
 * not run on every idle. Two gates come first, both free:
 *
 *   1. the cheap structural pre-filter (no plan, nothing changed, not quick
 *      mode) — the only job the old detector was ever fit for;
 *   2. a real pause. `session.idle` fires the instant a turn ends, which is
 *      not evidence of anything; a turn that is still being read by a human
 *      looks identical to one that stalled. Only after `PAUSE_JUDGE_DELAY_MS`
 *      of genuine silence is the question worth asking.
 *
 * FAIL-OPEN, ALWAYS SILENT. Unavailable agent, timeout, malformed reply,
 * anything unexpected: say nothing. The cost of a missed nudge is a session
 * that waits for the user — which is the normal state of a conversation. The
 * cost of a wrong nudge is the harness overriding the user's own turn, which
 * is what this module exists to stop happening again.
 */

import { buildDenyMap, runSubturn, type SelfCreatedSessions } from "./subturn.js"
import { scanProseField } from "./verifier.js"
import type { EventLogger, OpencodeClient } from "./types.js"

/** How long a session must be genuinely silent before the question is worth a model call. */
export const PAUSE_JUDGE_DELAY_MS = 60_000

/**
 * TOTAL budget for one judgement, tool map + subturn together. Spending it
 * twice (once per phase) let a single run outlast the 60s arming interval,
 * which is how two judges ended up in flight for one session.
 */
const PAUSE_JUDGE_TOTAL_MS = 30_000

const PAUSE_JUDGE_AGENT = "vertex-verifier"

const PAUSE_JUDGE_SYSTEM =
  "You are judging ONE thing about a coding session that has gone quiet: did the assistant's last turn end " +
  "because it needs a decision from the user, or did it stop part-way through work it had already started or " +
  "announced?\n\n" +
  'Answer "awaiting-user" when the turn ends by proposing something for approval, offering options, asking a ' +
  "question, reporting a finished result, or saying it is blocked on something only the user can supply. " +
  "Proposing a plan and waiting for the user to confirm it is ALWAYS awaiting-user — the assistant is required " +
  "to get agreement before recording a plan, so pausing there is correct behaviour, not a stall.\n\n" +
  'Answer "stopped-mid-work" ONLY when the turn announces work the assistant was going to do itself, right ' +
  "then, and simply did not do it — no question, no proposal, nothing for the user to respond to.\n\n" +
  "When the two readings are close, answer awaiting-user. Interrupting a user who is thinking is worse than " +
  "missing a stall.\n\n" +
  'Reply with exactly one JSON object: {"verdict":"awaiting-user"} or {"verdict":"stopped-mid-work"}. ' +
  "No prose, no markdown fences."

export type PauseVerdict = "awaiting-user" | "stopped-mid-work"

/** Tolerant parse — accepts a fenced or prose-wrapped reply, `null` when unreadable. */
export function parsePauseVerdict(text: string): PauseVerdict | null {
  const unfenced = text
    .trim()
    .replace(/^```[a-zA-Z]*\n?/, "")
    .replace(/```\s*$/, "")
    .trim()
  try {
    const parsed: unknown = JSON.parse(unfenced)
    if (parsed && typeof parsed === "object" && "verdict" in parsed) {
      const v = (parsed as { verdict: unknown }).verdict
      if (v === "awaiting-user" || v === "stopped-mid-work") return v
    }
  } catch {
    // fall through to extraction
  }
  // A reply that mentions BOTH ("I would not say stopped-mid-work… final:
  // awaiting-user") is unreadable, not a vote for whichever came first —
  // taking the first match inverted the prompt's deliberate awaiting-user
  // bias. Unreadable means silence.
  const all = [...text.matchAll(/"verdict"\s*:\s*"(awaiting-user|stopped-mid-work)"/gi)].map((m) =>
    m[1].toLowerCase(),
  )
  const unique = new Set(all)
  return unique.size === 1 ? (all[0] as PauseVerdict) : null
}

export interface PauseJudgeInput {
  client: OpencodeClient
  selfCreated: SelfCreatedSessions
  logger: EventLogger
  parentSessionID: string
  /** The assistant text that ended the turn. */
  lastAssistantText: string
  /** Bounded recent transcript for context; may be empty. */
  recentTranscript: string
  /** The session's own model; the judge runs on it unless overridden. */
  sessionModel: { providerID: string; modelID: string }
  verifierModelOverride?: { providerID: string; modelID: string }
}

/**
 * Ask the judge. Returns `null` on ANY failure — the caller must treat that
 * as "stay silent", never as a licence to nudge.
 */
export async function judgePause(input: PauseJudgeInput): Promise<PauseVerdict | null> {
  try {
    // ZERO TOOLS, like the intake classifier — this is a text classification,
    // not an investigation. Reusing the verifier's probe policy granted
    // read/grep/glob/list/BASH, and `wiring/config.ts` documents from a live
    // probe that the host ignores `maxSteps` and that this agent was observed
    // running `bash ls -la`. An unattended background timer must not be able
    // to hand a model a shell to answer "is this waiting for me?".
    const started = Date.now()
    const tools = await buildDenyMap(input.client)
    // MAJ-001: both fields are model output and go to the SAME destination as
    // the verifier payload — and to a different provider entirely when
    // `verifierModelOverride` is set. `buildVerifierPayload` routes its prose
    // through `scanProseField` (secret patterns, entropy, adjacent-unit
    // boundary check, oversize and length caps) and FR-031 treats that as a
    // safety control; interpolating raw prose here would have walked around it.
    const lastMessage = scanProseField(input.lastAssistantText, "lastResponse", input.logger, 2_000) ?? ""
    const transcript = scanProseField(input.recentTranscript, "recentTranscript", input.logger, 4_000) ?? ""
    if (!lastMessage) {
      // The one input the judgement cannot be made without was dropped.
      input.logger("pause:judge-unavailable", { sessionID: input.parentSessionID, reason: "last message redacted" })
      return null
    }

    const result = await runSubturn(input.client, input.selfCreated, input.logger, {
      parentSessionID: input.parentSessionID,
      agent: PAUSE_JUDGE_AGENT,
      model: input.verifierModelOverride ?? input.sessionModel,
      system: PAUSE_JUDGE_SYSTEM,
      parts: [
        {
          type: "text",
          text:
            `The assistant's last message was:\n---\n${lastMessage}\n---\n\n` +
            (transcript ? `Recent context:\n---\n${transcript}\n---\n\n` : "") +
            "Did this turn end awaiting the user, or stop mid-work?",
        },
      ],
      tools,
      timeoutMs: Math.max(1_000, PAUSE_JUDGE_TOTAL_MS - (Date.now() - started)),
    })
    if (!result.ok) {
      input.logger("pause:judge-unavailable", { sessionID: input.parentSessionID, reason: result.reason })
      return null
    }
    const verdict = parsePauseVerdict(result.text)
    if (verdict === null) {
      input.logger("pause:judge-malformed", { sessionID: input.parentSessionID })
      return null
    }
    return verdict
  } catch (error) {
    // Fail-open: never throw into the idle path.
    input.logger("pause:judge-unavailable", {
      sessionID: input.parentSessionID,
      reason: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}
