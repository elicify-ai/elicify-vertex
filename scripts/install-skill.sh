#!/usr/bin/env bash
# elicify-vertex — full installer (skill + agent + plugin registration).
#
# Usage:
#   bash scripts/install-skill.sh                    # install everything
#   SKILL_FORCE=1 bash scripts/install-skill.sh      # overwrite existing
set -uo pipefail

# --- output helper: try /dev/tty, then stderr. Never crash. ---------------
# In a real terminal, /dev/tty bypasses npm's output capture.
# In CI/headless, falls back to stderr. The /dev/tty errors in test
# environments are cosmetic and don't affect functionality.
say() {
  { echo "$1" >/dev/tty; } 2>/dev/null && return 0
  { echo "$1" >&2; } 2>/dev/null && return 0
  return 0
}

# --- resolve source files -------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SOURCE_SKILL="$PACKAGE_ROOT/skills/vertex/SKILL.md"
SOURCE_AGENT="$PACKAGE_ROOT/agents/elicify-vertex-agent.md"

# --- resolve config root --------------------------------------------------
CONFIG_ROOT="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
SKILL_DIR="${SKILL_TARGET_DIR:-$CONFIG_ROOT/skills/vertex}"
OPENCODE_JSON="$CONFIG_ROOT/opencode.json"
FORCE="${SKILL_FORCE:-0}"

# --- helper ---------------------------------------------------------------
copy_file() {
  local src="$1" dest="$2"
  if [[ -f "$dest" ]] && [[ "$FORCE" != "1" ]]; then
    say "  ✓ $dest (already exists)"
    return 0
  fi
  mkdir -p "$(dirname "$dest")"
  cp "$src" "$dest"
  say "  ✓ $dest"
}

say ""
say "  ╔══════════════════════════════════════════════════╗"
say "  ║          elicify-vertex installed!               ║"
say "  ║   Make any model work like a senior engineer      ║"
say "  ╚══════════════════════════════════════════════════╝"
say ""

# --- install skill --------------------------------------------------------
if [[ -f "$SOURCE_SKILL" ]]; then
  say "  Installing /elicify-vertex skill..."
  copy_file "$SOURCE_SKILL" "$SKILL_DIR/SKILL.md"
else
  say "  ⚠ SKILL.md not found at $SOURCE_SKILL"
fi

# --- install agent (copy to both agent/ and agents/ for compatibility) ----
if [[ -f "$SOURCE_AGENT" ]]; then
  say ""
  say "  Installing Elicify-Vertex-Agent..."
  copy_file "$SOURCE_AGENT" "$CONFIG_ROOT/agent/elicify-vertex-agent.md"
  copy_file "$SOURCE_AGENT" "$CONFIG_ROOT/agents/elicify-vertex-agent.md"
else
  say "  ⚠ Agent file not found at $SOURCE_AGENT"
fi

# --- register plugin in opencode.json -------------------------------------
say ""
say "  Registering plugin in opencode.json..."
if [[ ! -f "$OPENCODE_JSON" ]]; then
  say "  ⚠ opencode.json not found — add this manually:"
  say '    { "plugin": ["@elicify-ai/elicify-vertex"] }'
else
  node -e "
const fs = require('fs');
const path = '$OPENCODE_JSON';
const pkg = '@elicify-ai/elicify-vertex';
let cfg;
try { cfg = JSON.parse(fs.readFileSync(path, 'utf8')); } catch (e) {
  process.exit(0);
}
if (!Array.isArray(cfg.plugin)) cfg.plugin = [];
if (cfg.plugin.includes(pkg)) { process.exit(0); }
cfg.plugin.push(pkg);
fs.writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n');
" 2>/dev/null || true
  say "  ✓ done"
fi

# --- register slash commands in opencode.json (fallback for palette visibility) ---
say ""
say "  Registering slash commands in opencode.json..."
node "$SCRIPT_DIR/register-commands.mjs" 2>/dev/null || true
say "  ✓ done"

# --- GitHub star link -----------------------------------------------------
say ""
say "  ─────────────────────────────────────────────────"
say "  Enjoying elicify-vertex? It's free and open source."
say "  A GitHub star helps other developers discover it."
say "  ─────────────────────────────────────────────────"
say "  ⭐ https://github.com/elicify-ai/elicify-vertex"
say ""
say "  ✓ Done! Restart opencode to activate."
say "  Command: /elicify-vertex  |  Agent: Elicify-Vertex-Agent"
say ""

exit 0
