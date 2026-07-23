#!/usr/bin/env bash
# elicify-vertex — full installer (skill + agent + plugin registration).
#
# Copies the shipped SKILL.md and agent file into the user's opencode
# config, and registers the plugin in opencode.json. No symlinks.
#
# Behaviour:
#   - Creates target directories as real directories (no symlinks).
#   - Copies files. Idempotent. Honours SKILL_FORCE=1 to overwrite.
#   - Registers "@elicify-ai/elicify-vertex" in opencode.json plugin[]
#     if not already present (using node for safe JSON editing).
#   - Exits 0 even on non-fatal issues so npm install is not blocked.
#
# Usage:
#   bash scripts/install-skill.sh           # install everything
#   SKILL_FORCE=1 bash scripts/install-skill.sh   # overwrite existing
#   SKILL_TARGET_DIR=/custom/path bash scripts/install-skill.sh
set -euo pipefail

# --- resolve source files -------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SOURCE_SKILL="$PACKAGE_ROOT/skills/vertex/SKILL.md"
SOURCE_AGENT="$PACKAGE_ROOT/agents/elicify-vertex-agent.md"

# --- resolve config root --------------------------------------------------
CONFIG_ROOT="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
SKILL_DIR="${SKILL_TARGET_DIR:-$CONFIG_ROOT/skills/vertex}"
AGENT_DIR="$CONFIG_ROOT/agents"
AGENT_FILE="$AGENT_DIR/elicify-vertex-agent.md"
OPENCODE_JSON="$CONFIG_ROOT/opencode.json"
FORCE="${SKILL_FORCE:-0}"

# --- helper ---------------------------------------------------------------
copy_file() {
  local src="$1" dest="$2"
  if [[ -f "$dest" ]] && [[ "$FORCE" != "1" ]]; then
    echo "install: $dest already exists (pass SKILL_FORCE=1 to overwrite)"
    return 0
  fi
  mkdir -p "$(dirname "$dest")"
  cp "$src" "$dest"
  echo "install: copied -> $dest"
}

# --- install skill --------------------------------------------------------
if [[ ! -f "$SOURCE_SKILL" ]]; then
  echo "install: source SKILL.md not found at $SOURCE_SKILL" >&2
else
  copy_file "$SOURCE_SKILL" "$SKILL_DIR/SKILL.md"
fi

# --- install agent --------------------------------------------------------
if [[ ! -f "$SOURCE_AGENT" ]]; then
  echo "install: source agent not found at $SOURCE_AGENT" >&2
else
  copy_file "$SOURCE_AGENT" "$AGENT_FILE"
fi

# --- register plugin in opencode.json -------------------------------------
if [[ ! -f "$OPENCODE_JSON" ]]; then
  echo "install: opencode.json not found at $OPENCODE_JSON — skipping plugin registration"
  echo "  Add this to your opencode.json manually:"
  echo '  { "plugin": ["@elicify-ai/elicify-vertex"] }'
  exit 0
fi

node -e "
const fs = require('fs');
const path = '$OPENCODE_JSON';
const pkg = '@elicify-ai/elicify-vertex';
let cfg;
try { cfg = JSON.parse(fs.readFileSync(path, 'utf8')); } catch (e) {
  console.error('install: could not parse opencode.json — skipping plugin registration');
  process.exit(0);
}
if (!Array.isArray(cfg.plugin)) cfg.plugin = [];
if (cfg.plugin.includes(pkg)) {
  console.log('install: plugin already registered in opencode.json');
  process.exit(0);
}
cfg.plugin.push(pkg);
fs.writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n');
console.log('install: registered ' + pkg + ' in opencode.json');
" 2>&1 || echo "install: could not update opencode.json — add \"@elicify-ai/elicify-vertex\" to plugin[] manually"

echo "install: done. Restart opencode to activate."
