/**
 * elicify-vertex plugin entry point.
 *
 * GREENFIELD: v2 is the only engine. There is no `VERTEX_V2=0` kill switch and
 * no `engine: "v1"` option, because there is no v1 plugin left to fall back to.
 *
 * Why this was removed rather than kept as a safety valve:
 *
 *  - It registered a SECOND, conflicting tool set. v1 exposed
 *    `elicify_vertex_goal_*` and v2 exposes `elicify_vertex_plan_*`; which one
 *    the model saw depended on an environment variable, so the agent prompt
 *    could not name its own tools with confidence.
 *  - It did not do what its name implied. `VERTEX_V2=0` never meant "harness
 *    off" — it silently swapped in a different, older harness that still minted
 *    receipts and still injected directives. Measured end to end: a rollback
 *    session emitted v1's `classify` event and a real `vrf_` receipt.
 *  - It was reproducibly broken in combination with the shipped agent. Every
 *    attempt at `VERTEX_V2=0 opencode run --agent elicify-vertex-agent` failed
 *    with `UnknownError`, while the same rollback with no `--agent` flag
 *    worked, and `--agent build` worked. Isolated but never root-caused; the
 *    combination is gone now, so the failure mode is gone with it.
 *
 * `src/index.ts` remains as the library of frozen v1 PRIMITIVES that v2 builds
 * on (`parseVerification`, `EvidenceLedger`, `changedPathsFromTool`, …). Only
 * the v1 *plugin surface* — its hooks and its `elicify_vertex_goal_*` tools —
 * is out of the loading path.
 */
import type { Hooks, PluginInput, PluginOptions } from "@opencode-ai/plugin"

import { ElicifyVertexPluginV2 as v2Plugin } from "./v2/plugin.js"

export const server = async (input: PluginInput, options?: PluginOptions): Promise<Hooks> => {
  return v2Plugin(input, options)
}

export default server
