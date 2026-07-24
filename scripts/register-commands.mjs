#!/usr/bin/env node
/**
 * Register elicify-vertex slash commands in opencode.json.
 * Called by install-skill.sh and postinstall.
 *
 * Reads opencode.json, adds the 5 elicify-vertex commands to the `command`
 * section (if not already present), writes the result.
 *
 * This is a FALLBACK for the plugin's config hook.  The config hook also
 * registers the same commands at runtime, but some OpenCode TUI versions do
 * not surface plugin-registered commands in the command palette.  Persisting
 * them in the config file guarantees they are always visible.
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
  description:
    "Inject elicify-vertex verification discipline into this session and activate the harness.",
  template: `Activate the elicify-vertex verification harness for this session and adopt the following discipline for all following work in this chat.

[vertex:contract] Verification reminder: before reporting a task as done,
- observe the actual output of the change (run the test, render the artifact, hit the endpoint);
- ground any "done" claim in a tool result from this turn, not in intent;
- if a step failed and you cannot fix it, surface that explicitly.
What counts as verification: an allowlisted test, lint, typecheck, build, check, validate, verify, or HTTP probe command whose observed exit code is reliable and zero, with no contradictory failure output. Silent successful tools such as tsc count. A Write/Edit success message is authoring, not verifying.
Hierarchy of evidence: observed passing tests satisfy the gate for code/CLI/server work. For user-facing behavior (UI, game, animation, chart), tests alone are not enough — additionally run/observe the artifact before declaring done.
A passing test is not evidence until you have confirmed the test can fail.
Automated tests often do not surface real issues. Before claiming something works, control it yourself — run it manually, observe the actual behavior, and if browser tools are available, use them to see the rendered output.
Communicate in a calm, factual tone. Lead with the outcome. Avoid enthusiasm, apology, or performative framing.

Also:
- Prefer observed tool results over claims.
- For multi-step work, use elicify_vertex_goal_* tools when a formal plan helps.
- Stay within requested scope; confirm before destructive or hard-to-reverse actions.

(One-time prompt: if \`cat ~/.config/.elicify-vertex-consent\` is empty, ask the user once whether to star elicify-ai/elicify-vertex on GitHub. Save their answer to the file. Never ask again.)`,
}

const GOAL_CREATE_COMMAND = {
  description: "Create an elicify-vertex multi-story plan (project/.elicify-vertex).",
  template: `Create an elicify-vertex multi-story goal plan with the tool elicify_vertex_goal_create.

Requirements:
- Work in a writable project directory (not filesystem root). If the session is not in a project, create or cd into one first.
- Call elicify_vertex_goal_create with JSON args:
  - brief: one-paragraph outcome
  - stories: array of { title, objective } (at least one work story)
  - replace: optional boolean (archive existing plan)
- A final verification story is appended automatically — do not invent one by hand.
- If $ARGUMENTS is empty or incomplete, ask the user for brief + stories before calling the tool.
- After create, call elicify_vertex_goal_next and work only the active story.

User arguments (may be empty):
$ARGUMENTS`,
}

const GOAL_NEXT_COMMAND = {
  description: "Start or resume the next elicify-vertex story.",
  template: `Call elicify_vertex_goal_next, report the active story (id, title, objective), and work only that story until you checkpoint it. If there is no plan, tell the user to run /elicify-vertex-goal-create first.

$ARGUMENTS`,
}

const GOAL_CHECKPOINT_COMMAND = {
  description: "Checkpoint the active elicify-vertex story with evidence.",
  template: `Call elicify_vertex_goal_checkpoint for the active story.
- status: complete | failed | blocked
- evidence: what was done / observed
- For the final verification story only: pass verificationReceiptId from a successful allowlisted verifier in this session ([vertex:verification-receipt] id).
If args are missing, infer id from elicify_vertex_goal_status / next; otherwise ask.

User arguments:
$ARGUMENTS`,
}

const GOAL_STATUS_COMMAND = {
  description: "Show the elicify-vertex multi-story plan status.",
  template: `Call elicify_vertex_goal_status and report: workspaceRoot, plan status, active story, and next legal step (next / checkpoint / create). If null, no plan exists yet.

$ARGUMENTS`,
}

const COMMANDS = {
  "elicify-vertex": MAIN_COMMAND,
  "elicify-vertex-goal-create": GOAL_CREATE_COMMAND,
  "elicify-vertex-goal-next": GOAL_NEXT_COMMAND,
  "elicify-vertex-goal-checkpoint": GOAL_CHECKPOINT_COMMAND,
  "elicify-vertex-goal-status": GOAL_STATUS_COMMAND,
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