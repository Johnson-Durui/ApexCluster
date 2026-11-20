# Repository guide

Multi-Agent Workbench is a local TypeScript application that coordinates an architecture pipeline, a mixed-provider implementation pipeline, isolated execution, and evidence-backed acceptance.

## Commands

- `npm ci` — install backend dependencies.
- `npm ci --prefix web` — install frontend dependencies.
- `npm run check` — backend typecheck and offline tests.
- `npm --prefix web test` — frontend tests.
- `npm run build:web` — production frontend build.
- `npm run demo:offline` — scripted models plus a real local Docker sandbox; no model API calls.
- `npm run pipeline -- --requirement <file> --workspace <directory>` — run the API pipeline.
- `npm run models:verify` — verify configured model listings without inference requests.
- `npm run prepublish:scan` — scan the publishing tree for secrets and machine-specific data.

## Directory map

- `src/providers/` — provider contracts, adapters, registry, proof, and scripted provider.
- `src/chat/` — runtime, windows, roster, tools, workspace grants, API/CLI drivers, and HTTP surface.
- `src/pipeline/` — architecture, gates, contract, implementation, acceptance, and TRACE state.
- `src/exec/` — sandbox policy and Docker/WSL/Windows/local backends.
- `src/server/` — local server and API.
- `web/` — React interface.
- `config/` — portable examples, model registry, roster, and presets.
- `scripts/` — headless pipeline, offline demo, verification, smoke, and publishing checks.
- `tests/` — offline Node tests and fixtures.
- `docker/sandbox/` — local execution image.
- `docs/` — configuration and extension documentation.

## Current rules

1. Keep the user requirement verbatim. Program state, receipts, hashes, and tests decide completion; model prose does not.
2. The lead maintains one shared architecture. Other seats contribute bounded increments; only the root lead asks the user or delivers.
3. In the implementation layer, Sol is the only main-workspace writer and integrator. Opus edits an isolated candidate. Cross-family review and frozen checks precede integration.
4. Astra independently accepts the latest frozen product. Authors never self-approve.
5. Workers receive bounded tasks, do not adjudicate, and do not recursively delegate.
6. Model IDs, effort, delegation, and provider family are explicit. Never silently substitute a model, reduce effort, or add a fallback.
7. API keys come only from named environment variables. Never log, persist, prompt-inject, or pass them to CLI children or execution sandboxes.
8. Model-generated commands run only through a configured execution backend. Docker is the default, normal jobs are offline, mounts are scoped, and arguments are structured.
9. Docker configuration uses a local immutable image ID. Never pull or silently replace an execution image during a run.
10. Preserve old CLI behavior. API mode and CLI mode are separate paths.
11. New boundary data is validated with zod. Prefer one statement per line and keep new modules near 400 lines or smaller.
12. Do not weaken assertions or add unexplained skips. Tests, demos, and CI must make zero real model calls.
13. Real smoke tests require the explicit live guard, complete keys, and a fixed dollar cap. They are never part of ordinary verification.
14. Do not commit `.env`, API keys, local data, work records, machine capability proofs, or host-specific paths.
15. Preserve unrelated user changes. Keep diffs narrow and verify before declaring completion.
16. API models require verified hard context-window limits. Treat a model with missing limits as unavailable.
17. API scheduling, pool concurrency, fanout, queue limits, context thresholds, and spend limits follow the configured policies.

## Further reading

- [README.md](README.md) and [README.en.md](README.en.md) — product overview and quick start.
- [ARCHITECTURE.md](ARCHITECTURE.md) — runtime and trust boundaries.
- [docs/CONFIGURATION.md](docs/CONFIGURATION.md) — API, roster, budget, context, and sandbox configuration.
- [docs/EXTENDING.md](docs/EXTENDING.md) — adding providers, models, seats, tools, and execution backends.
- [SECURITY.md](SECURITY.md) — threat model and vulnerability reporting.
- [CONTRIBUTING.md](CONTRIBUTING.md) — development and verification expectations.
