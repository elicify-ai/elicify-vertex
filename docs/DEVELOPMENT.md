# Development

Build, test, and UAT for `@elicify-ai/elicify-vertex`.  
Behavior: [USAGE.md](./USAGE.md). Shape: [ARCHITECTURE.md](./ARCHITECTURE.md).

## Prerequisites

- Node.js ≥ 20 (`package.json` `engines`)
- npm (or compatible client)

## Clone, install, test, build

```bash
git clone https://github.com/elicify-ai/elicify-vertex.git
cd elicify-vertex
npm install
npm test
npm run build
```

Useful scripts (`package.json`):

| Script | Command | Notes |
|--------|---------|--------|
| `build` | `tsc` + copy `scripts/plugin.cjs` → `dist/plugin.cjs` | Produces `dist/` |
| `typecheck` | `tsc` project + tests project `--noEmit` | |
| `test` | `vitest run` | Unit/integration tests under the repo test tree |
| `test:watch` | `vitest` | |
| `dev` | `tsc --watch` | |
| `setup` | `bash scripts/install-skill.sh` | Skill + agent + plugin registration |
| `uninstall` | `bash scripts/uninstall.sh` | |

`postinstall` runs `install-skill.sh` with `|| true` (install does not fail the npm install if setup fails).

## Live OpenCode UAT

End-to-end against a real OpenCode CLI (`opencode run`):

```bash
npm run build
# Ensure plugin is loaded (opencode.json → @elicify-ai/elicify-vertex or file://…/dist/plugin.js)
# Ensure agent elicify-vertex-agent is installed (npm run setup)
bash scripts/uat-opencode-live.sh
```

Requirements:

- `opencode` on `PATH`
- Plugin loaded so hooks actually run
- Network/model access as configured for your install

Env used by the script (see script body for defaults):

- `UAT_MODEL` (default in script: `opencode/big-pickle`)
- Work/data under `/tmp/oc-uat` and `/tmp/oc-uat-data` (paths are hard-coded in the shipped script)
- Forces `VERTEX_DEBUG=1` and `VERTEX_DATA` for the run directory

Report/output is written under `/tmp/oc-uat-report.txt` and `/tmp/oc-uat-runs/`.

## Package entry points

| Export | Path | Contents |
|--------|------|----------|
| `.` (main / module / default) | `dist/plugin.js` (ESM), `dist/plugin.cjs` (CJS), types `dist/plugin.d.ts` | **Plugin only:** `default` + `server` = `ElicifyVertexPlugin` |
| `./lib` | `dist/index.js`, types `dist/index.d.ts` | Full library: plugin factory + classifiers, ledger, measurement helpers, etc. |

**Why two entries:** OpenCode validates every export on the plugin module; shipping test helpers at the package root breaks load. Host must use `.` / `dist/plugin.js`. Tests and UAT import `./lib` or `dist/index.js`.

Source of the thin entry: `src/plugin.ts` re-exports from `./index.js`.

## Local plugin wiring

For a working tree:

1. `npm run build`
2. In OpenCode config, add `file:///…/elicify-vertex/dist/plugin.js` (or npm link the package)
3. `npm run setup` (or copy agent/skill manually per [CONFIGURATION.md](./CONFIGURATION.md))
4. Restart OpenCode

## Debug and measurement during development

- `VERTEX_DEBUG=1` → `~/.config/opencode/.vertex-debug.log`
- `VERTEX_DATA=<dir>` → `<dir>/.vertex-events.jsonl`
- See [USAGE.md](./USAGE.md) env section and [ARCHITECTURE.md](./ARCHITECTURE.md) measurement table

## Out of scope for this doc

- Invented CLI flags for vertex (none beyond env vars above and script-local UAT vars)
- Editing production OpenCode internals
