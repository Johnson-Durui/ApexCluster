# Security policy

## Supported version

Security fixes are made on the current `1.x` release line.

## Reporting a vulnerability

Do not open a public issue for an unpatched vulnerability. Use the repository host's private security-advisory channel. Include the affected version, a minimal reproduction, impact, and any suggested mitigation. Do not include real API keys, private prompts, or user data.

If a private channel is unavailable, ask a maintainer in a public issue to enable private reporting without disclosing technical details.

## Security model

- Provider credentials are loaded from named environment variables. Values are not configuration, browser payloads, prompts, event records, child-process environment, or sandbox environment.
- Workspace access requires a local selection grant and path confinement.
- Model-generated commands use structured arguments and a configured execution backend. Docker is the default; normal commands run without network and with scoped mounts.
- Execution images are local immutable IDs. The runtime does not pull or substitute an image.
- Provider identity, model ID, effort, and family are explicit. There is no silent fallback.
- Acceptance evidence binds exact snapshots and receipts. A model's assertion is not proof of command success.

## Operator responsibilities

- Keep `.env`, `data/`, `work/`, capability proofs, and product workspaces private.
- Use least-privilege provider keys and provider-side spending limits.
- Review `config/chat.config.json`, especially budgets, installation network access, environment allowlists, and image IDs.
- Rebuild and re-pin images after dependency or base-image security updates.
- Treat `local-unsafe` as host command execution; do not use it for untrusted requirements or independent acceptance.
- Review generated changes and TRACE before delivery.

## Live smoke tests

Live smoke testing is disabled unless `LIVE_SMOKE=1`, all required keys are present, and the command receives an explicit budget such as `--budget-usd 5`. It sends real provider requests and writes a local ledger. Never run it in ordinary CI or as part of offline verification.

## Dependency audit status for v1.0.0

The release audit updated the root lockfile to `zod` 4.6.7 and `fast-uri` 3.1.9. Compatible web updates include DOMPurify 3.4.18, which removed the previously reported critical finding.

Seven advisory nodes remain: five high-severity development-only nodes in the `picomatch` / `fdir` / `tinyglobby` glob path used by Vite and Vitest, and two low-severity runtime nodes in Mermaid 11.17.2 and KaTeX 0.16.47 related to a pre-existing prototype-pollution requirement.

Build and development inputs are expected to be trusted, and development servers bind to loopback by default. Mermaid rendering uses strict security mode with HTML labels disabled. The release retains these advisories pending compatible upstream fixes. Replacing the affected major toolchain components requires a separate migration and regression review.

## Publishing checks

Run `npm run prepublish:scan` before publishing. It rejects likely secrets, personal absolute paths, machine identifiers, and email addresses except for narrow documented whitelist entries. The scanner reduces accidental disclosure risk; it does not replace secret rotation or review.
