/**
 * Vertex 2 — shared type definitions.
 *
 * Source of truth for the shapes referenced here is
 * `docs/vertex2-module-contracts.md` (see "Logging convention" for
 * `EventLogger`, and each module's mention of `OpencodeClient`). Where this
 * file and that doc conflict, the doc wins — flag the conflict rather than
 * silently diverging.
 *
 * This module has no runtime behavior of its own: it only re-exports/aliases
 * types so every v2 module (phase.ts, pin.ts, artifacts.ts, resolve.ts,
 * composer.ts, subturn.ts, verifier.ts, story.ts, measurement.ts)
 * imports one canonical definition instead of hand-rolling copies that could
 * drift.
 */

import type { V2EventType } from "../measurement.js"

export type { V2EventType }

/**
 * Every module that emits measurement events takes an injected logger rather
 * than importing `measurement.ts` directly, so it stays testable without a
 * real event sink. The wave-3 wiring agent supplies the real implementation
 * (backed by the extended `measurement.ts`); unit tests pass a `vi.fn()`.
 *
 * `eventType` is `V2EventType`, not `string`. That is what makes
 * `measurement.ts`'s `V2_EVENT_TYPES` an authoritative registry rather than a
 * decorative list: an event name that is not registered there does not
 * compile at the line that emits it. Before this it was `string`, and
 * `wiring/logger.ts` cast the name to `V2EventType` on the way to disk — 61
 * of the 82 names actually emitted from `src/v2/` were unregistered and
 * nothing could tell.
 */
export type EventLogger = (eventType: V2EventType, payload: Record<string, unknown>) => void

/**
 * The real OpenCode SDK client type, re-exported (not hand-copied) so this
 * never drifts from the actual shape. `@opencode-ai/plugin`'s `PluginInput`
 * types `client` as `ReturnType<typeof createOpencodeClient>`
 * (node_modules/@opencode-ai/plugin/dist/index.d.ts) and
 * `createOpencodeClient` returns exactly this `OpencodeClient` class
 * (node_modules/@opencode-ai/sdk/dist/client.d.ts,
 * node_modules/@opencode-ai/sdk/dist/gen/sdk.gen.d.ts) — the class exposing
 * `.session.create`, `.session.prompt`, `.session.delete`, `.tool.ids`, and
 * `.app.agents` that subturn.ts/verifier.ts/story.ts need.
 */
export type { OpencodeClient } from "@opencode-ai/sdk"
