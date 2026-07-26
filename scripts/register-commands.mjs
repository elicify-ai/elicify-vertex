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
 * harness's own directives, not by a human typing a slash command. This
 * file's templates MUST be kept in sync with `src/v2/wiring/config.ts`'s
 * `ACTIVATE_TEMPLATE` and `src/v2/wiring/tools.ts`'s `planSlashCommands()` —
 * because the config hook only ever adds a command with `??=` (never
 * overwrites one already on disk), whatever this script writes here is what
 * a user actually sees, even after every later plugin upgrade.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const CONFIG_ROOT = process.env.XDG_CONFIG_HOME
  ? join(process.env.XDG_CONFIG_HOME, "opencode")
  : join(homedir(), ".config", "opencode")

const OPENCODE_JSON = join(CONFIG_ROOT, "opencode.json")
const PKG = "@elicify-ai/elicify-vertex"

// ── Command templates (mirrors src/index.ts config hook) ───────────────────

const MAIN_COMMAND = {
  description: "Activate the elicify-vertex 2 verification harness for this session.",
  template: `Activate the elicify-vertex 2 verification harness for this session.

Follow observed evidence over intent: ground every "done" claim in a tool result from this turn, run the narrowest relevant verifier after changing files, and state gaps explicitly rather than assuming success.

For multi-step work, confirm a story plan first (elicify_vertex_plan_create) and checkpoint each story with evidence (elicify_vertex_plan_checkpoint).`,
}

const PLAN_CLEAR_COMMAND = {
  description: "Abandon the current elicify-vertex v2 plan and pinned criteria for this session.",
  template: `Call elicify_vertex_plan_clear to abandon the current plan and pinned criteria for this session. Confirm what was cleared (or that there was nothing to clear).

$ARGUMENTS`,
}

const COMMANDS = {
  "elicify-vertex": MAIN_COMMAND,
  "elicify-vertex-plan-clear": PLAN_CLEAR_COMMAND,
}

// ── Main ───────────────────────────────────────────────────────────────────

let config
try {
  config = JSON.parse(readFileSync(OPENCODE_JSON, "utf8"))
} catch {
  console.error(`[elicify-vertex] ${OPENCODE_JSON} not found — skipping command registration`)
  process.exit(0)
}

// Ensure plugin is listed
if (!Array.isArray(config.plugin)) config.plugin = []
if (!config.plugin.includes(PKG)) {
  config.plugin.push(PKG)
}

// Ensure commands are registered (don't override user-defined commands)
config.command = config.command ?? {}
for (const [name, cmd] of Object.entries(COMMANDS)) {
  if (!config.command[name]) {
    config.command[name] = cmd
  }
}

writeFileSync(OPENCODE_JSON, JSON.stringify(config, null, 2) + "\n", "utf8")
console.log(`[elicify-vertex] registered ${Object.keys(COMMANDS).length} commands in ${OPENCODE_JSON}`)