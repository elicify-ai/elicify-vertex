#!/usr/bin/env node
/**
 * Register elicify-vertex slash commands in opencode.json.
 * Called by install-skill.sh and postinstall.
 *
 * Reads opencode.json, adds the elicify-vertex commands to the `command`
 * section (if not already present), writes the result.
 *
 * This is a FALLBACK for the plugin's config hook.  The config hook also
 * registers the same commands at runtime, but some OpenCode TUI versions do
 * not surface plugin-registered commands in the command palette.  Persisting
 * them in the config file guarantees they are always visible.
 *
 * Only two commands: `/elicify-vertex` (activate) and
 * `/elicify-vertex-plan-clear` (abandon the current plan/pins). Everything
 * else — creating, advancing, and checkpointing the plan — happens through
 * the model calling `elicify_vertex_plan_*` tools directly, driven by the
 * harness's own directives, not by a human typing a slash command.
 *
 * WHY THE ACTIVATE TEMPLATE IS DERIVED, NOT WRITTEN HERE. The config hook only
 * ever adds a command with `??=`, so it never overwrites one already on disk —
 * which means whatever THIS script writes is what the user actually sees, for
 * good, through every later upgrade. This file used to carry its own
 * four-sentence summary while `ACTIVATE_TEMPLATE` carried the full contract,
 * so installing the plugin silently pinned the weaker of the two. Deriving both
 * from the agent file's BEHAVIOR block removes the copy that could drift.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const CONFIG_ROOT = process.env.XDG_CONFIG_HOME
  ? join(process.env.XDG_CONFIG_HOME, "opencode")
  : join(homedir(), ".config", "opencode")

const OPENCODE_JSON = join(CONFIG_ROOT, "opencode.json")
const PKG = "@elicify-ai/elicify-vertex"
const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

// ── Command templates ──────────────────────────────────────────────────────

/**
 * The identity preamble — the ONLY thing that legitimately differs between the
 * slash path and the agent. Kept byte-identical to `ACTIVATE_TEMPLATE`'s
 * preamble in `src/v2/wiring/config.ts`; `tests/agent-prompt.test.ts` fails if
 * the two templates diverge.
 */
export const ACTIVATE_PREAMBLE = `Work under the elicify-vertex verification discipline for the rest of this session.

This changes how you work, not who you are — keep your own identity and voice. Everything below is the same contract the elicify-vertex-agent runs under; the two are kept byte-identical on purpose, so activating by slash command is never a weaker mode than activating by agent.

`

/**
 * Build the activate template from the agent file's shared behaviour block.
 * Throws rather than falling back to a summary: registering a weaker contract
 * is worse than registering none, because the plugin's own config hook still
 * supplies the full one at runtime and `??=` would let a fallback win forever.
 */
export function buildActivateTemplate(pkgRoot = PKG_ROOT) {
  const agent = readFileSync(join(pkgRoot, "agents", "elicify-vertex-agent.md"), "utf8")
  const body = agent.split("<!-- BEHAVIOR:BEGIN -->")[1]?.split("<!-- BEHAVIOR:END -->")[0]?.trim()
  if (!body) throw new Error("agents/elicify-vertex-agent.md has no BEHAVIOR block")
  return ACTIVATE_PREAMBLE + body
}

const PLAN_CLEAR_COMMAND = {
  description: "Abandon the current elicify-vertex v2 plan and pinned criteria for this session.",
  template: `Call elicify_vertex_plan_clear to abandon the current plan and pinned criteria for this session. Confirm what was cleared (or that there was nothing to clear).

$ARGUMENTS`,
}

// ── Main ───────────────────────────────────────────────────────────────────

function main() {
  const commands = {
    "elicify-vertex": {
      description: "Activate the elicify-vertex 2 verification harness for this session.",
      template: buildActivateTemplate(),
    },
    "elicify-vertex-plan-clear": PLAN_CLEAR_COMMAND,
  }

  let config
  try {
    config = JSON.parse(readFileSync(OPENCODE_JSON, "utf8"))
  } catch {
    console.error(`[elicify-vertex] ${OPENCODE_JSON} not found — skipping command registration`)
    return
  }

  // Ensure plugin is listed
  if (!Array.isArray(config.plugin)) config.plugin = []
  if (!config.plugin.includes(PKG)) {
    config.plugin.push(PKG)
  }

  // Ensure commands are registered (don't override user-defined commands)
  config.command = config.command ?? {}
  for (const [name, cmd] of Object.entries(commands)) {
    if (!config.command[name]) {
      config.command[name] = cmd
    }
  }

  writeFileSync(OPENCODE_JSON, JSON.stringify(config, null, 2) + "\n", "utf8")
  console.log(`[elicify-vertex] registered ${Object.keys(commands).length} commands in ${OPENCODE_JSON}`)
}

// Only run when executed directly — the exports above are imported by
// tests/agent-prompt.test.ts to prove this script and the config hook agree.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}