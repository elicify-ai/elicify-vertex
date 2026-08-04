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
 * dosing.ts, composer.ts, subturn.ts, verifier.ts, story.ts, measurement.ts)
 * imports one canonical definition instead of hand-rolling copies that could
 * drift.
 */

/**
 * Every module that emits measurement events takes an injected logger rather
 * than importing `measurement.ts` directly, so it stays testable without a
 * real event sink. The wave-3 wiring agent supplies the real implementation
 * (backed by the extended `measurement.ts`); unit tests pass a `vi.fn()`.
 */
export type EventLogger = (eventType: string, payload: Record<string, unknown>) => void

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

/**
 * FR-028/FR-029 dosing profile. Canonically defined in `src/v2/dosing.ts`
 * (which already exists on disk) — re-exported here as a type alias so
 * composer.ts/measurement.ts and anything else that only needs the shared
 * shared-types entry point can import it from `./types.js` without also
 * depending on `./dosing.js`. There is exactly one canonical definition
 * (dosing.ts); this is a re-export, never a second declaration, so the two
 * can never drift.
 */
export type { Profile } from "./dosing.js"
