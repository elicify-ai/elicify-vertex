/**
 * Wave-3 wiring — the real `EventLogger` backing every v2 module.
 *
 * Every v2 module takes an injected `EventLogger` rather than importing
 * `measurement.ts` directly (module contracts doc's "Logging convention").
 * This is the one place a v2 event-type string becomes a real
 * `measurement.ts` JSONL record via `makeV2Event`/`appendEvent`.
 *
 * HISTORY, because the shape of the fix depends on it. This function used to
 * cast: `makeV2Event(eventType as V2EventType, …)`. The comment here said
 * `V2EventType` was "authoring-time documentation … not enforced as a runtime
 * allowlist", and listed three known divergences (`intake:unsupported` vs
 * `intake:classify-unsupported`, composer's three drop events,
 * `story:v1-archived`) as flagged-not-patched. Left alone, that list grew:
 * measured across `src/v2/`, 82 distinct event names were emitted and 61 were
 * absent from the registry. An event-name registry nothing consults cannot
 * detect drift, which was the only reason to have one.
 *
 * `EventLogger` now takes `V2EventType` and the cast is gone, so the registry
 * is enforced at the emitting line. Divergent spellings were REGISTERED
 * rather than renamed — `intake:unsupported` stays as `story.ts` emits it —
 * because renaming an event breaks continuity with every record already on
 * disk, which is the thing measurement exists to preserve.
 */
import { appendEvent, makeV2Event } from "../../measurement.js"
import type { EventLogger } from "../types.js"

export interface SessionLogContext {
  model: string | null
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
 * resolved model id always reflects the session's current state, not a stale
 * snapshot from whenever the shared logger was built.
 */
export function createSharedV2Logger(getContext: (sessionID: string | undefined) => SessionLogContext): EventLogger {
  return (eventType, payload) => {
    const sessionID = typeof payload.sessionID === "string" ? payload.sessionID : undefined
    const ctx = getContext(sessionID)
    // No cast. `EventLogger` now takes `V2EventType`, so an unregistered
    // event name is a compile error at the emitting line rather than
    // something this function launders on its way to disk.
    const ev = makeV2Event(eventType, {
      ...payload,
      sessionID,
      model: ctx.model,
    })
    appendEvent(ev)
  }
}

/**
 * Session-bound wrapper for call-style modules that build a fresh
 * `EventLogger` argument per invocation rather than holding one long-lived
 * (`verifier.ts`'s `runVerifier`/`buildVerifierPayload`, `story.ts`'s
 * `classifyMultiStory`). `verifier.ts` specifically logs several event types
 * (`verifier:unsupported`, `verifier:unavailable`, `verifier:malformed`,
 * `verifier:field-dropped`) with NO `sessionID` in their payload at all — a gap
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
