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

# --- evict opencode's resolved copy ----------------------------------------
# Removing the npm package is not enough: opencode loads from its own plugin
# cache, so an uninstall that skips this leaves a fully working copy behind.
CACHE_ROOT="${XDG_CACHE_HOME:-$HOME/.cache}/opencode/packages"
if [[ -d "$CACHE_ROOT/@elicify-ai" ]]; then
  rm -rf "$CACHE_ROOT/@elicify-ai"
  echo "  ✓ evicted opencode's cached copy"
  REMOVED=1
fi

# --- remove machine-wide state --------------------------------------------
# THE GAP THIS CLOSES. Everything above removes what the INSTALLER wrote. The
# harness also writes state of its own at runtime, and none of it was ever
# removed — so "uninstall" left the star-consent marker, the event log and the
# receipt signing key on disk. Observed on a real machine after a clean
# uninstall run: two consent files (one legacy plain-text `yes`, one
# `{"state":"yes","attempts":2}`) and 1.65 MB of `.vertex-events.jsonl`, with
# the script reporting "Nothing to remove — elicify-vertex was not installed".
#
# A stale consent marker is not inert: `state: yes` is terminal, so the star
# ask can never fire again on that machine, and a reinstall inherits a decision
# the user may never have made.
#
# TWO ROOTS, deliberately. `starConsentPath()` honours XDG_CONFIG_HOME while
# `defaultDataRoot()` hardcodes ~/.config/opencode, so with XDG_CONFIG_HOME set
# the consent file and the event log live in DIFFERENT directories. Removing
# only one root leaves the other behind.
#
# `if`, not `&&`: this script runs under `set -e`, where a bare `cond && cmd`
# that evaluates false IS the statement's exit status and aborts the run. The
# uninstaller failing silently half-way is precisely how state gets left behind.
STATE_ROOTS=("$CONFIG_ROOT" "$HOME/.config/opencode")
if [[ -n "${VERTEX_DATA:-}" ]]; then STATE_ROOTS+=("$VERTEX_DATA"); fi

remove_state_file() {
  [[ -e "$1" ]] || return 0
  rm -f "$1"
  echo "  ✓ removed $1"
  REMOVED=1
}

for root in "${STATE_ROOTS[@]}"; do
  remove_state_file "$root/.elicify-vertex-consent"
  remove_state_file "$root/.vertex-events.jsonl"
  remove_state_file "$root/receipt-signing.key"
  # Rotated event logs: `.vertex-events.jsonl` becomes
  # `.vertex-events.<ISO-timestamp>.jsonl` once it passes the size cap, so
  # removing only the live file can leave tens of MB of history behind.
  for rotated in "$root"/.vertex-events.*.jsonl; do
    if [[ -e "$rotated" ]]; then remove_state_file "$rotated"; fi
  done
done

# Legacy consent location. Older builds wrote the marker one directory up, in
# plain text (`yes`) rather than JSON. Still present on machines that ran them,
# and still terminal, so a reinstall would silently honour it.
remove_state_file "${XDG_CONFIG_HOME:-$HOME/.config}/.elicify-vertex-consent"
remove_state_file "$HOME/.config/.elicify-vertex-consent"

# --- unregister plugin + commands from opencode.json -----------------------
if [[ -f "$OPENCODE_JSON" ]]; then
  node -e "
const fs = require('fs');
const path = '$OPENCODE_JSON';
const pkg = '@elicify-ai/elicify-vertex';
// Superset of every command name this package has ever registered, across
// both the v1 goal-* names and the current v2 plan-* names, so uninstall
// cleans up regardless of which version was installed.
const commandNames = ['elicify-vertex', 'elicify-vertex-goal-create', 'elicify-vertex-goal-next', 'elicify-vertex-goal-checkpoint', 'elicify-vertex-goal-status', 'elicify-vertex-plan-create', 'elicify-vertex-plan-next', 'elicify-vertex-plan-checkpoint', 'elicify-vertex-plan-status', 'elicify-vertex-plan-clear'];
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
