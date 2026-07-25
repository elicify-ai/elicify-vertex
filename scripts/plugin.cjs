/**
 * CJS entry for hosts that load plugins via require().
 * Export the plugin function as module.exports (not a namespace object).
 *
 * Routes through ./plugin.js (compiled from src/plugin.ts), NOT ./index.js
 * directly — that switch is what implements the FR-037 kill switch
 * (VERTEX_V2=0 / engine:"v1" restores v1 behaviour). Importing ./index.js
 * here would silently bypass the switch for every require()-based host.
 */
module.exports = async function ElicifyVertexPlugin(input, options) {
  const mod = await import("./plugin.js")
  return mod.server(input, options)
}
module.exports.server = module.exports
module.exports.default = module.exports
