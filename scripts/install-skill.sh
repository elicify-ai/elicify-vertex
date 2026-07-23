#!/usr/bin/env bash
# elicify-vertex — install the skill without symlinks.
#
# Copies skills/elicify-vertex/SKILL.md into the user's opencode
# skills directory so the /elicify-vertex slash command works.
#
# Behaviour:
#   - Creates the target skill directory as a real directory (no symlinks).
#   - Copies SKILL.md into it.
#   - Idempotent: safe to re-run.
#   - Honours $XDG_CONFIG_HOME if set; defaults to ~/.config/opencode.
#   - Exits 0 even if the copy fails (warns and continues) so npm install
#     is not blocked by permission issues — the user can run it manually.
#
# Usage:
#   bash scripts/install-skill.sh           # install
#   SKILL_TARGET_DIR=/custom/path bash scripts/install-skill.sh
#   SKILL_FORCE=1 bash scripts/install-skill.sh   # overwrite existing
set -euo pipefail

# --- resolve source file (this script's own package) -----------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SOURCE_SKILL="$PACKAGE_ROOT/skills/vertex/SKILL.md"

if [[ ! -f "$SOURCE_SKILL" ]]; then
  echo "install-skill: source SKILL.md not found at $SOURCE_SKILL" >&2
  echo "  (are you running this from inside the package?)" >&2
  exit 0  # do not break npm install; warn only
fi

# --- resolve target directory ----------------------------------------------
if [[ -n "${SKILL_TARGET_DIR:-}" ]]; then
  TARGET_DIR="$SKILL_TARGET_DIR"
else
  CONFIG_ROOT="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
  TARGET_DIR="$CONFIG_ROOT/skills/elicify-vertex"
fi

# --- guard: never follow an existing symlink at the target ----------------
# If the user already has a symlink at $TARGET_DIR, that is their
# decision — we do not create new symlinks. We follow the symlink target
# and write a real file there, which is what the user wants.
if [[ -L "$TARGET_DIR" ]]; then
  RESOLVED="$(readlink -f "$TARGET_DIR" 2>/dev/null || python3 -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "$TARGET_DIR")"
  echo "install-skill: note — $TARGET_DIR is a symlink to $RESOLVED; writing a real file there"
  TARGET_DIR="$RESOLVED"
fi

# --- copy ------------------------------------------------------------------
if [[ -d "$TARGET_DIR" ]] && [[ -f "$TARGET_DIR/SKILL.md" ]] && [[ "${SKILL_FORCE:-0}" != "1" ]]; then
  echo "install-skill: $TARGET_DIR/SKILL.md already exists; pass SKILL_FORCE=1 to overwrite"
  exit 0
fi

mkdir -p "$TARGET_DIR"
cp "$SOURCE_SKILL" "$TARGET_DIR/SKILL.md"

echo "install-skill: installed -> $TARGET_DIR/SKILL.md"
