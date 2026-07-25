/**
 * Wave-3 wiring — the real `EventLogger` backing every v2 module.
 *
 * Every v2 module takes an injected `EventLogger` rather than importing
 * `measurement.ts` directly (module contracts doc's "Logging convention").
 * This is the one place a v2 event-type string becomes a real
 * `measurement.ts` JSONL record via `makeV2Event`/`appendEvent`.
 *
 * Cross-module inconsistency (flagged, not silently patched — see this
 * wave's final report): `measurement.ts`'s `V2EventType` union is a closed
 * set of event-name literals, but the wave-1/2 modules that emit events do
 * not all agree with it or with each other:
 *   - `story.ts` logs `"intake:unsupported"`; `measurement.ts`'s union spells
 *     the same concept `"intake:classify-unsupported"`.
 *   - `composer.ts` logs `"budget:dropped"`, `"per-turn-cap:dropped"`,
 *     `"cooldown:dropped"` — none of which are in `V2EventType` at all (the
 *     module contract left composer's drop-event names as "yours to define
 *     consistently", so composer.ts picked reasonable names but they were
 *     never folded back into measurement.ts's union).
 *   - `story.ts` also logs `"story:v1-archived"`, its own addition for
 *     FR-022 observability, again absent from `V2EventType`.
 * Rather than hand-maintain a translation table that could silently drift
 * (or drop events that don't match), this logger passes `eventType` straight
 * through to `makeV2Event` with a type-level cast: every event still reaches
 * disk under the name its emitting module actually used, and `session_id` /
 * `model` / `profile` are still stamped consistently (FR-033). `V2EventType`
 * remains useful as authoring-time documentation for measurement.ts's own
 * typed writer functions; it is not enforced as a runtime allowlist here.
 */
import { appendEvent, makeV2Event, type DosingProfile, type V2EventType } from "../../measurement.js"
import type { EventLogger } from "../types.js"

export interface SessionLogContext {
  model: string | null
  profile: DosingProfile
}

/**
 * The single shared logger passed to every long-lived v2 component
 * (`PhaseEngine`, `PinStore`, `StoryEngine`, `InjectionComposer`,
 * `runSubturn`). Those modules always embed the correct `sessionID` in the
 * payload they hand to the logger themselves (verified against each
 * module's source), so this implementation trusts `payload.sessionID` when
 * present and only falls back to `"no-session"` (via `makeV2Event`'s own
 * fallback) when it is absent.
 *
 * `getContext` is called at LOG TIME (not logger-construction time) so the
 * resolved model id / dosing profile always reflects the session's current
 * state, not a stale snapshot from whenever the shared logger was built.
 */
export function createSharedV2Logger(getContext: (sessionID: string | undefined) => SessionLogContext): EventLogger {
  return (eventType, payload) => {
    const sessionID = typeof payload.sessionID === "string" ? payload.sessionID : undefined
    const ctx = getContext(sessionID)
    const ev = makeV2Event(eventType as V2EventType, {
      ...payload,
      sessionID,
      model: ctx.model,
      profile: ctx.profile,
    })
    appendEvent(ev)
  }
}

/**
 * Session-bound wrapper for call-style modules that build a fresh
 * `EventLogger` argument per invocation rather than holding one long-lived
 * (`judge.ts`'s `runJudge`/`buildJudgePayload`, `story.ts`'s
 * `classifyMultiStory`). `judge.ts` specifically logs several event types
 * (`judge:unsupported`, `judge:unavailable`, `judge:malformed`,
 * `judge:field-dropped`) with NO `sessionID` in their payload at all — a gap
 * against FR-033's "every event MUST carry ... session id" invariant that
 * this wrapper closes by injecting the bound session id whenever the
 * module's own payload omitted one. When the payload already carries its
 * own `sessionID` (e.g. `subturn.ts`'s `subturn:cleanup-failed`, which
 * intentionally names the *child* session that failed to delete), that
 * value is preserved rather than overwritten — the bound id is a fallback,
 * not an override.
 */
export function bindSession(sessionID: string, logger: EventLogger): EventLogger {
  return (eventType, payload) => {
    if (typeof payload.sessionID === "string" && payload.sessionID.length > 0) {
      logger(eventType, payload)
      return
    }
    logger(eventType, { ...payload, sessionID })
  }
}
