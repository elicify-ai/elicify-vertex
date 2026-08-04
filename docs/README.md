# elicify-vertex developer docs

End-user install and “how to use” stay in the root [README](../README.md).  
This directory holds developer and power-user detail, grounded in the package source.

Vertex is three mechanisms, not one: a **behavioural contract** before the work,
**live detection and correction** during it, and an **independent verifier** that
rules on the outcome against your repo. [ARCHITECTURE.md](./ARCHITECTURE.md)
explains how they fit together.

| Doc | Purpose |
|-----|---------|
| [USAGE.md](./USAGE.md) | Activation, stop gate, promise-no-act, verification, goals tools, env vars |
| [CONFIGURATION.md](./CONFIGURATION.md) | Plugin options, `opencode.json` entries, skill/agent install paths |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Closed loop, hooks, directive IDs, measurement events |
| [DEVELOPMENT.md](./DEVELOPMENT.md) | Build, test, UAT harnesses, package entry points |

**Package:** `@elicify-ai/elicify-vertex` (see root `package.json`)

**Primary sources:** `src/v2/*` (current harness — plugin, gate, verifier, story, coverage), `src/plugin.ts` (host entry), and `src/index.ts`, `src/goals.ts`, `src/measurement.ts`, `src/redaction.ts` (v1 loop and shared primitives)

## Governance & legal

| Doc | Purpose |
|-----|---------|
| [LICENSE](../LICENSE) | MIT license (copyright elicify.ai Pte. Ltd.) |
| [CLA.md](../CLA.md) | Contributor License Agreement |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | How to contribute |
| [CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md) | Community standards |
| [SECURITY.md](../SECURITY.md) | Vulnerability reporting |
| [SUPPORT.md](../SUPPORT.md) | Where to get help |
| [TRADEMARKS.md](../TRADEMARKS.md) | Brand / name policy |

## Reference

| Doc | Purpose |
|-----|---------|
| [VERIFIER-PROMPT.md](./VERIFIER-PROMPT.md) | The completion verifier's prompt and contract |
| [VERIFIER-RELIABILITY-FIXES-SPEC.md](./VERIFIER-RELIABILITY-FIXES-SPEC.md) | Verifier reliability spec + the review rounds behind it |
| [REQUIREMENTS-INJECTION-VISIBILITY.md](./REQUIREMENTS-INJECTION-VISIBILITY.md) | Operator-agreed visibility of harness inject/steering |
| [keyword-inject.html](./keyword-inject.html) | Keyword detection → when inject fires |
