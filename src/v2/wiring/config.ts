/**
 * Wave-3 wiring — the `config` hook body: registers the two FR-030b
 * zero-tool subagents (`vertex-judge`, `vertex-intake`), the `/elicify-vertex`
 * activation command, and the `/elicify-vertex-plan-*` slash commands.
 *
 * The `tools` field on both agents is a static, hardcoded deny map
 * (`KNOWN_TOOL_NAMES`, below) — NOT built via `subturn.ts`'s `buildDenyMap`,
 * which calls `client.tool.ids()` (a real HTTP round trip back to the
 * host). `config` fires while the host is still bootstrapping the plugin
 * set — live-host testing showed this round trip deadlocks: the host can't
 * finish bootstrapping until `config` returns, and `config` was waiting on
 * a host call that only resolves after bootstrapping finishes.
 *
 * Post-review correction: an earlier version of this fix used a bare
 * `{"*": false}` wildcard entry instead of real tool names, on the
 * assumption that `"*"` is honoured as "deny every tool not otherwise
 * named". Live-host testing (`opencode debug agent vertex-judge`) disproved
 * this: `"*"` is treated as a literal (nonexistent) tool name, so it denies
 * nothing, and the resolved `tools` map came back with most real tools
 * (`read`, `glob`, `grep`, `task`, `todowrite`, `skill`, this plugin's own
 * `elicify_vertex_plan_*` tools, and any other installed plugin's tools)
 * still `true`. `KNOWN_TOOL_NAMES` replaces the wildcard with an explicit,
 * compile-time-known list: every opencode core built-in tool plus this
 * plugin's own tool names (the only two sets that CAN be known without a
 * live host call).
 *
 * This is still necessarily incomplete for tools contributed by OTHER
 * installed plugins/MCP servers (their names aren't knowable at compile
 * time) — that gap is intentionally left to the FR-030b capability PROBE
 * (`judge.ts`/`story.ts`'s `classifyMultiStory`, each calling
 * `probeCapability` before every real subturn, long after the host is
 * fully up) to catch: if some other plugin's tool is still enabled, the
 * probe correctly refuses (`judge:unsupported` / `intake:unsupported`)
 * rather than silently running with more capability than "zero tools"
 * implies. That refusal path, not this map, remains the actual control of
 * record (spec Open Question 1) — this map only exists to make the probe
 * PASS as often as possible without reintroducing the config-time deadlock.
 */
import type { OpencodeClient } from "../types.js"
import { planSlashCommands } from "./tools.js"

const AGENT_PERMISSION = { edit: "deny" as const, bash: "deny" as const, webfetch: "deny" as const }

/**
 * Every opencode core built-in tool name observed on a live host
 * (`bash`, `edit`, `write`, `read`, `glob`, `grep`, `task`, `todowrite`,
 * `skill`, `question`, `webfetch`, `invalid`) plus a few documented
 * built-ins not observed in that specific run but known to exist in other
 * opencode configurations (MCP resource helpers, patch/multi-edit), plus
 * this plugin's own `elicify_vertex_plan_*` tool names. Extra entries for
 * tools that don't exist on a given host are harmless no-ops.
 */
const KNOWN_TOOL_NAMES = [
  "bash",
  "edit",
  "write",
  "read",
  "glob",
  "grep",
  "task",
  "todowrite",
  "skill",
  "question",
  "webfetch",
  "invalid",
  "patch",
  "multiedit",
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
  "elicify_vertex_plan_create",
  "elicify_vertex_plan_next",
  "elicify_vertex_plan_checkpoint",
  "elicify_vertex_plan_status",
  "elicify_vertex_plan_clear",
]

function buildStaticDenyMap(): Record<string, boolean> {
  const deny: Record<string, boolean> = { "*": false }
  for (const name of KNOWN_TOOL_NAMES) deny[name] = false
  return deny
}

/** @deprecated kept only so nothing importing this symbol breaks; no longer called from `applyV2Config` — see module header. */
export async function buildAgentDenyMap(_client: OpencodeClient): Promise<Record<string, boolean>> {
  return buildStaticDenyMap()
}

export interface V2ConfigHookInput {
  agent?: Record<string, unknown>
  command?: Record<string, { description: string; template: string; agent?: string }>
}

const ACTIVATE_TEMPLATE = `Activate the elicify-vertex 2 verification harness for this session.

Follow observed evidence over intent: ground every "done" claim in a tool result from this turn, run the narrowest relevant verifier after changing files, and state gaps explicitly rather than assuming success.

For multi-step work, confirm a story plan first (elicify_vertex_plan_create) and checkpoint each story with evidence (elicify_vertex_plan_checkpoint).`

export async function applyV2Config(
  cfgInput: V2ConfigHookInput,
  _client: OpencodeClient,
  activateCommandName: string,
): Promise<Record<string, boolean>> {
  cfgInput.command = cfgInput.command ?? {}
  if (!cfgInput.command[activateCommandName]) {
    cfgInput.command[activateCommandName] = {
      description: "Activate the elicify-vertex 2 verification harness for this session.",
      template: ACTIVATE_TEMPLATE,
    }
  }
  for (const [name, command] of Object.entries(planSlashCommands())) {
    cfgInput.command[name] ??= command
  }

  // Static, hardcoded-tool-name deny map — see module header for why this
  // must not call the host (client.tool.ids()) at config time.
  const deny: Record<string, boolean> = buildStaticDenyMap()

  cfgInput.agent = cfgInput.agent ?? {}
  cfgInput.agent["vertex-judge"] ??= {
    mode: "subagent",
    description: "elicify-vertex internal judge subturn — zero-tool, evidence-only, never gates a checkpoint.",
    tools: deny,
    permission: AGENT_PERMISSION,
    maxSteps: 1,
  }
  cfgInput.agent["vertex-intake"] ??= {
    mode: "subagent",
    description: "elicify-vertex internal intake multi-story classification subturn — zero-tool.",
    tools: deny,
    permission: AGENT_PERMISSION,
    maxSteps: 1,
  }

  return deny
}
