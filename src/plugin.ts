/**
 * OpenCode plugin entry — ONLY plugin exports.
 * OpenCode 1.18 validates every module export value; shipping helpers from the
 * package root causes "Plugin export is not a function".
 *
 * FR-037 kill switch (US-11): `VERTEX_V2=0` (or plugin option `engine:
 * "v1"`) restores v1 behaviour for the whole process, unchanged. The flag is
 * read BEFORE anything else — before any v2 module is constructed and
 * before any `.elicify-vertex/` path is touched — so enabling it never
 * mutates state a v1-only user wouldn't expect.
 */
import type { Hooks, PluginInput, PluginOptions } from "@opencode-ai/plugin"
import { ElicifyVertexPlugin as v1Plugin } from "./index.js"
import { ElicifyVertexPluginV2 as v2Plugin } from "./v2/plugin.js"

export const server = async (input: PluginInput, options?: PluginOptions): Promise<Hooks> => {
  const engine = (options as { engine?: string } | undefined)?.engine
  const useV1 = process.env.VERTEX_V2 === "0" || engine === "v1"
  if (useV1) return v1Plugin(input, options)
  return v2Plugin(input, options)
}

export default server
