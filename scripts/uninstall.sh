#!/usr/bin/env bash
# elicify-vertex — uninstaller (skill + agent + plugin registration).
#
# Removes everything the installer copied and unregisters the plugin
# from opencode.json.
#
# Usage:
#   bash scripts/uninstall.sh
set -euo pipefail

# --- resolve config root --------------------------------------------------
CONFIG_ROOT="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
OPENCODE_JSON="$CONFIG_ROOT/opencode.json"
REMOVED=0

echo ""
echo "  Removing elicify-vertex..."
echo ""

# --- remove skill ---------------------------------------------------------
for dir in "$CONFIG_ROOT/skills/vertex"; do
  if [[ -d "$dir" ]] || [[ -f "$dir" ]]; then
    rm -rf "$dir"
    echo "  ✓ removed $dir"
    REMOVED=1
  fi
done

# --- remove agent (both directories) --------------------------------------
for file in \
  "$CONFIG_ROOT/agent/elicify-vertex-agent.md" \
  "$CONFIG_ROOT/agents/elicify-vertex-agent.md"; do
  if [[ -f "$file" ]]; then
    rm -f "$file"
    echo "  ✓ removed $file"
    REMOVED=1
  fi
done

# --- unregister plugin + commands from opencode.json -----------------------
if [[ -f "$OPENCODE_JSON" ]]; then
  node -e "
const fs = require('fs');
const path = '$OPENCODE_JSON';
const pkg = '@elicify-ai/elicify-vertex';
const commandNames = ['elicify-vertex', 'elicify-vertex-goal-create', 'elicify-vertex-goal-next', 'elicify-vertex-goal-checkpoint', 'elicify-vertex-goal-status'];
let cfg;
try { cfg = JSON.parse(fs.readFileSync(path, 'utf8')); } catch (e) { process.exit(0); }
let changed = false;
if (Array.isArray(cfg.plugin)) {
  const before = cfg.plugin.length;
  cfg.plugin = cfg.plugin.filter(p => p !== pkg);
  if (cfg.plugin.length !== before) { changed = true; console.log('  ✓ removed ' + pkg + ' from opencode.json'); }
}
if (cfg.command) {
  const commandCount = Object.keys(cfg.command).length;
  for (const name of commandNames) { delete cfg.command[name]; }
  if (Object.keys(cfg.command).length !== commandCount) { changed = true; console.log('  ✓ removed elicify-vertex commands from opencode.json'); }
}
if (changed) fs.writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n');
" 2>&1 || true
fi

# --- summary --------------------------------------------------------------
echo ""
if [[ "$REMOVED" == "1" ]]; then
  echo "  ✓ elicify-vertex fully removed."
else
  echo "  Nothing to remove — elicify-vertex was not installed."
fi
echo ""
echo "  To remove the npm package:  npm uninstall @elicify-ai/elicify-vertex"
echo ""
