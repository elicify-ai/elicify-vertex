# Security Policy

elicify-vertex is an OpenCode plugin that injects harness directives, observes tool results, and can gate session completion. Issues that let an attacker bypass verification, inject untrusted directives, exfiltrate secrets via measurement logs, or escalate privileges through the plugin matter to us — report them privately first.

## Reporting a vulnerability

**Do not open a public GitHub issue for a security report.** Choose one of the following:

1. **(Preferred) GitHub Private Vulnerability Reporting.** Open a private advisory at <https://github.com/elicify-ai/elicify-vertex/security/advisories/new>. This keeps the conversation between you, the project maintainers, and (optionally) named experts you invite — without exposing the issue to the public until a fix ships.
2. **Email.** Write to **connect@elicify.ai** with subject line `[security]` and a description detailed enough for us to reproduce the issue. PGP / signed mail is not yet supported; consider GitHub PVR if confidentiality of transport matters.

If you don't get an acknowledgement within 72 hours, please re-send through the other channel — mail filters do occasionally lose messages.

## What we commit to

| Stage | SLA |
|---|---|
| Acknowledgement of receipt | **within 72 hours** |
| Initial severity assessment + reproduction confirmation | **within 7 days** |
| Status update or fix in progress | **at least every 14 days** until resolved |
| Coordinated public disclosure | only after a fix is released, or earlier if the issue is already public |
| Credit for the reporter (optional) | yes, in the release notes and the GitHub Security Advisory — we ask before publishing your name |

We don't pay bounties at this time. We will credit you publicly if you want it, and we'll keep you in the loop until the fix lands.

## Scope

### In scope

- The `@elicify-ai/elicify-vertex` npm package and source at `github.com/elicify-ai/elicify-vertex`
- Code under `src/`, `scripts/`, `agents/`, `skills/`, and published `dist/` artifacts
- Dependencies declared in `package.json` **only where elicify-vertex is responsible for the vulnerable usage** (e.g. a library we call insecurely). Upstream CVEs in libraries we ship are interesting but typically should be reported upstream — we'll happily coordinate.
- Build-pipeline outputs (npm publish artifacts, GitHub Releases if any)

### Out of scope

- **OpenCode host behaviour** unrelated to this plugin (report upstream to the OpenCode project).
- **Third-party LLM provider behaviour** — model jailbreaks, prompt-injection on the model side, etc. Report those to the provider.
- **Issues that require an attacker to already control the operator's machine or OpenCode config** in ways outside the plugin's threat model (e.g. arbitrary local code execution already available to the user).
- **Self-DoS via misconfiguration** (e.g. disabling verification and complaining the harness doesn't enforce). These are documentation issues, not security bugs.

If you're unsure whether something is in scope, send it. We'd rather sort it out than miss a real one.

## Supported versions

elicify-vertex is pre-1.0. Only the current `main` branch and the latest published npm version on the 0.x line are supported.

| Branch / version | Supported |
|---|---|
| `main` | ✅ active |
| Latest `0.x` on npm | ✅ active |
| Older `0.x` tags | ❌ please upgrade |

When 1.0 ships, this table will list the supported semver range explicitly.

## Disclosure history

We will list resolved security advisories here (and on GitHub Security Advisories) once we have any. For now: no public security advisories outstanding.

## How we handle reports (for the curious)

1. Acknowledge within 72 hours.
2. Try to reproduce locally. If we can't, ask for more detail.
3. Triage severity (CVSS 3.1 or 4.0, plus our own judgement).
4. Open a private GitHub Security Advisory linked to a draft PR. Invite the reporter as a collaborator.
5. Develop and review the fix in private.
6. Coordinate a release. The advisory goes public and the release ships on the same day.
7. Update this document and the changelog with a link to the advisory.

## Researcher acknowledgements

We will acknowledge security researchers here as advisories are resolved. If you'd prefer to stay anonymous, say so when you report — we honour that.

---

© 2026 elicify.ai Pte. Ltd. · Singapore · https://github.com/elicify-ai/elicify-vertex
