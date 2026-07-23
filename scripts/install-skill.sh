#!/usr/bin/env bash
# elicify-vertex — full installer (skill + agent + plugin registration + star).
#
# Copies the shipped SKILL.md and agent file into the user's opencode
# config, registers the plugin in opencode.json, and stars the GitHub
# repo if gh CLI is available. No symlinks.
#
# Usage:
#   bash scripts/install-skill.sh                    # install everything
#   SKILL_FORCE=1 bash scripts/install-skill.sh      # overwrite existing
#   VERTEX_NO_STAR=1 bash scripts/install-skill.sh   # skip GitHub star
set -euo pipefail

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
    echo "  $dest (already exists)"
    return 0
  fi
  mkdir -p "$(dirname "$dest")"
  cp "$src" "$dest"
  echo "  $dest"
}

echo ""
echo "  elicify-vertex installer"
echo "  ─────────────────────────"

# --- install skill --------------------------------------------------------
if [[ -f "$SOURCE_SKILL" ]]; then
  echo ""
  echo "  Installing skill (/vertex)..."
  copy_file "$SOURCE_SKILL" "$SKILL_DIR/SKILL.md"
else
  echo "  WARNING: SKILL.md not found at $SOURCE_SKILL" >&2
fi

# --- install agent (copy to both agent/ and agents/ for compatibility) ----
if [[ -f "$SOURCE_AGENT" ]]; then
  echo ""
  echo "  Installing agent (Elicify-Vertex-Agent)..."
  copy_file "$SOURCE_AGENT" "$CONFIG_ROOT/agent/elicify-vertex-agent.md"
  copy_file "$SOURCE_AGENT" "$CONFIG_ROOT/agents/elicify-vertex-agent.md"
else
  echo "  WARNING: agent file not found at $SOURCE_AGENT" >&2
fi

# --- register plugin in opencode.json -------------------------------------
echo ""
echo "  Registering plugin in opencode.json..."
if [[ ! -f "$OPENCODE_JSON" ]]; then
  echo "  opencode.json not found — add this manually:"
  echo '    { "plugin": ["@elicify-ai/elicify-vertex"] }'
else
  node -e "
const fs = require('fs');
const path = '$OPENCODE_JSON';
const pkg = '@elicify-ai/elicify-vertex';
let cfg;
try { cfg = JSON.parse(fs.readFileSync(path, 'utf8')); } catch (e) {
  console.log('  could not parse opencode.json — skipping');
  process.exit(0);
}
if (!Array.isArray(cfg.plugin)) cfg.plugin = [];
if (cfg.plugin.includes(pkg)) {
  console.log('  already registered');
  process.exit(0);
}
cfg.plugin.push(pkg);
fs.writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n');
console.log('  registered @elicify-ai/elicify-vertex');
" 2>&1 || echo "  could not update opencode.json — add \"@elicify-ai/elicify-vertex\" to plugin[] manually"
fi

# --- GitHub star (automatic, opt-out via VERTEX_NO_STAR=1) ----------------
echo ""
if [[ "${VERTEX_NO_STAR:-0}" == "1" ]]; then
  echo "  GitHub star skipped (VERTEX_NO_STAR=1)"
elif command -v gh &>/dev/null; then
  if gh auth status &>/dev/null 2>&1; then
    if gh api --method PUT /user/starred/elicify-ai/elicify-vertex 2>/dev/null; then
      echo "  Starred elicify-ai/elicify-vertex on GitHub"
    else
      echo "  Could not star (gh returned error) — star manually:"
      echo "  https://github.com/elicify-ai/elicify-vertex"
    fi
  else
    echo "  gh CLI not authenticated — star manually:"
    echo "  https://github.com/elicify-ai/elicify-vertex"
  fi
else
  echo "  Star us on GitHub: https://github.com/elicify-ai/elicify-vertex"
fi

echo ""
echo "  Done! Restart opencode to activate."
echo ""
