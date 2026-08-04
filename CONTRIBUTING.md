# Contributing to elicify-vertex

Thank you for your interest in contributing to elicify-vertex. This project is an open-source OpenCode plugin that holds models to a verify-before-done standard. We welcome bug fixes, features, documentation, and testing contributions.

elicify-vertex was substantially developed with AI assistance — we embrace this approach and have built our contribution process around it.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Contributor License Agreement (CLA)](#contributor-license-agreement-cla)
- [Trademarks](#trademarks)
- [Ways to Contribute](#ways-to-contribute)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Making Changes](#making-changes)
- [AI-Assisted Contributions](#ai-assisted-contributions)
- [Pull Request Process](#pull-request-process)
- [Branch Strategy](#branch-strategy)
- [Code Review](#code-review)
- [Communication](#communication)

---

## Code of Conduct

We are committed to maintaining a welcoming and respectful community. Be kind, constructive, and assume good faith. Harassment or discrimination of any kind will not be tolerated. Full text: [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

---

## Contributor License Agreement (CLA)

elicify-vertex is developed by **elicify.ai Pte. Ltd.** under the MIT license. Before your first pull request can be merged, you (or your employer, if you contribute on company time) sign a one-time **Contributor License Agreement** based on the Apache and Google Contributor License Agreements.

**You keep the copyright to your contribution.** The CLA grants elicify.ai Pte. Ltd. a broad, irrevocable license to use your contribution — including in future distribution forms of the project — without retroactively chasing every contributor for permission. The upstream MIT-licensed code is **irrevocable** — anyone who downloads elicify-vertex today keeps the MIT grant forever.

See [`CLA.md`](CLA.md) for the full text, common questions, and the Corporate CLA path for contributions made on company time. You sign once per GitHub account; all future PRs from that account are covered.

---

## Trademarks

The **elicify-vertex** name and related brand assets are trademarks of **elicify.ai Pte. Ltd.** The MIT license covers source code only — it does not grant rights to use the brand on a fork, a commercial variant, or any goods or services.

You can refer to "elicify-vertex" in articles, integrations ("elicify-vertex-compatible"), and unmodified redistributions. You **cannot** name your fork "elicify-vertex Pro" or sell an "elicify-vertex Cloud" service without written permission. Full policy: [`TRADEMARKS.md`](TRADEMARKS.md).

---

## Ways to Contribute

- **Bug reports** — Open an issue with reproduction steps (see [`SUPPORT.md`](SUPPORT.md)).
- **Feature requests** — Open an issue; discuss before implementing large changes.
- **Code** — Fix bugs or implement features. See the workflow below.
- **Documentation** — Improve the README, `docs/`, inline comments.
- **Testing** — Run the host UAT harness or live OpenCode UAT and report results.

For substantial new features, please open an issue first to discuss the design before writing code.

---

## Getting Started

1. **Fork** the repository on GitHub.
2. **Clone** your fork locally:
   ```bash
   git clone https://github.com/<your-username>/elicify-vertex.git
   cd elicify-vertex
   ```
3. Add the upstream remote:
   ```bash
   git remote add upstream https://github.com/elicify-ai/elicify-vertex.git
   ```

---

## Development Setup

### Prerequisites

- Node.js **20** or later
- npm

### Install & build

```bash
npm install
npm run build
```

### Tests

```bash
npm test                 # unit suite (vitest)
npm run typecheck        # tsc for src + tests
```

Live OpenCode UAT (optional; needs OpenCode CLI + plugin loaded):

```bash
bash scripts/uat-opencode-live.sh
```

See [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) for more detail.

### Code style

- TypeScript, ESM
- Prefer small, focused changes
- Do not add narrative comments that restate the next line; explain *why* when needed
- Keep the plugin fail-open: a broken harness must never break the host session

---

## Making Changes

### Branching

Always branch off `main` and target `main` in your PR. Never push directly to `main`:

```bash
git checkout main
git pull upstream main
git checkout -b your-feature-branch
```

Use descriptive branch names, e.g. `fix/stop-gate-docs-only`, `feat/new-verifier`, `docs/contributing-guide`.

### Commits

- Write clear, concise commit messages in English.
- Use the imperative mood: "Add repeat-failure inject" not "Added…".
- Reference the related issue when relevant: `Fix docs-only false positive (#12)`.
- Keep commits focused. One logical change per commit is preferred.
- Follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/).

### Keeping up to date

```bash
git fetch upstream
git rebase upstream/main
```

---

## AI-Assisted Contributions

elicify-vertex was built with substantial AI assistance, and we fully embrace AI-assisted development. Contributors must still own what they submit.

### Disclosure is required

Every PR must disclose AI involvement using the PR template's AI Code Generation section:

| Level | Description |
|---|---|
| Fully AI-generated | AI wrote the code; contributor reviewed and validated it |
| Mostly AI-generated | AI produced the draft; contributor made significant modifications |
| Mostly human-written | Contributor led; AI provided suggestions or none at all |

Honest disclosure is expected. There is no stigma attached to any level — what matters is the quality of the contribution.

### You are responsible for what you submit

Before opening a PR with AI-generated code, you must:

- **Read and understand** every line of the generated code.
- **Test it** (`npm test`, and UAT when behaviour changes).
- **Check for security issues** — especially secret handling, path handling, and anything that could weaken the stop gate or measurement redaction.
- **Verify correctness** — AI-generated logic can be plausible-sounding but wrong.

PRs where it is clear the contributor has not read or tested the AI-generated code will be closed without review.

### AI-generated code quality standards

AI-generated contributions are held to the **same quality bar** as human-written code:

- All CI checks must pass (when CI is configured).
- Code must be idiomatic TypeScript and consistent with the existing codebase.
- It must not introduce unnecessary abstractions, dead code, or over-engineering.
- It must include or update tests where appropriate.

---

## Pull Request Process

### Before opening a PR

- [ ] Run `npm test` and ensure it passes.
- [ ] Run `npm run typecheck`.
- [ ] Run `bash scripts/uat-opencode-live.sh` (needs `OPENCODE_LIVE_TEST=1`) if you changed gate, verification, or hook behaviour.
- [ ] Fill in the PR template completely, including the AI disclosure section.
- [ ] Link any related issue(s) in the PR description.
- [ ] Keep the PR focused. Avoid bundling unrelated changes together.
- [ ] Sign the [CLA](CLA.md) when the bot asks (one-time per GitHub account).

### PR template sections

The PR template asks for:

- **Description** — What does this change do and why?
- **Type of Change** — Bug fix, feature, docs, or refactor.
- **AI Code Generation** — Disclosure of AI involvement (required).
- **Related Issue** — Link to the issue this addresses.
- **Test Environment** — OS, Node, OpenCode version when relevant.
- **Evidence** — Optional logs or screenshots.
- **Checklist** — Self-review confirmation.

### PR size

Prefer small, reviewable PRs. If your feature is large, split it into a series of smaller, logically complete PRs.

---

## Branch Strategy

### Long-lived branches

- **`main`** — the active development branch. All feature PRs target `main`.
- **`cla-signatures`** — signature ledger for the CLA bot (not for product code).

### Requirements to merge into `main`

1. **CLA signed** — all human authors (and co-authors) covered.
2. **CI passes** — when workflows are configured.
3. **Reviewer approval** — at least one maintainer has approved.
4. **PR template is complete** — including AI disclosure.

### Who can merge

Only maintainers can merge PRs. Contributors cannot merge their own PRs.

### Merge strategy

We prefer **squash merge** for most PRs so `main` history stays readable. Each merged PR becomes a single commit referencing the PR number.

---

## Code Review

### For contributors

- Respond to review comments within a reasonable time. If you need more time, say so.
- When you update a PR in response to feedback, briefly note what changed.
- If you disagree with feedback, engage respectfully.
- Prefer additional commits after review starts; the maintainer will squash on merge.

### For reviewers

Review for:

1. **Correctness** — Does the code do what it claims? Edge cases?
2. **Security** — Redaction, fail-open honesty, no secret leakage in logs/events.
3. **Architecture** — Consistent with inject → observe → record → check → block.
4. **Simplicity** — No unnecessary abstraction.
5. **Tests** — Behaviour covered; UAT updated when inject paths change.

Be constructive and specific.

---

## Communication

- **GitHub Issues** — Bug reports, feature requests, design discussions.
- **GitHub Discussions** — General questions (when enabled).
- **Pull Request comments** — Code-specific feedback.
- **Email** — **connect@elicify.ai** for security, trademarks, partnerships.

When in doubt, open an issue before writing code.

---

## A note on the project's AI-driven origin

elicify-vertex's architecture was substantially designed and implemented with AI assistance, guided by human oversight. If you find something that looks odd or over-engineered, it may be an artifact of that process — opening an issue to discuss it is always welcome.

We believe AI-assisted development done responsibly produces great results. We also believe humans must remain accountable for what they ship. These two beliefs are not in conflict.

Thank you for contributing.
