# Architecture

Multi-Agent Workbench has one durable chat runtime and two pipeline layers. It deliberately keeps orchestration, provider transport, workspace authority, and command execution separate.

## Main components

- `src/providers/` normalizes Anthropic Messages, OpenAI Responses-compatible APIs (including custom/local OpenAI-compatible endpoints via `models.registry.local.json`), and Google GenAI events into text, reasoning summaries, tool calls, usage, and terminal reasons. `ScriptedProvider` drives offline tests.
- `src/chat/` owns conversations, turns, tasks, invocations, windows, tickets, event persistence, roster permissions, per-chat frozen custom teams (`FrozenChatTeam`, with `apiRoster` and `cliRoster` kept strictly separate), workspace grants, and tools. Any verified API model or qualified local CLI seat (`claude`, `astra`, `sol`, `grok`) can be designated per chat as `rootSeat` with explicit dispatch authority (`proactive` / `explicit` / `none`) and member roles (`collaborator` / `writer` / `reviewer`), enforced fail-closed by `WorkspaceGateway` and `delegationWeight`. API and local CLI drivers remain distinct.
- `src/pipeline/` owns architecture clustering, gates, requirement/acceptance contracts, implementation plans, cross-review, integration, acceptance, and TRACE.
- `src/exec/` runs commands through a selected backend. Docker is the portable default; WSL bwrap and Windows MXC require local capability proof. `local-unsafe` is explicit and unsuitable for independent acceptance.
- `src/server/` exposes the local API. `web/` renders the workbench without receiving secret values.

## Architecture layer

The root lead maintains one proposal. A full cluster first asks Carbon for diverse ideas, then runs Astra and Opus concurrently. Each receives the other's paged result and acknowledges reading it before the program returns their deterministic aggregate to the lead. Sol builds the demo in the project's `demo/` directory. The program validates requirement IDs, acceptance IDs, sources, assumptions, and artifact hashes before gate A.

Model text cannot promote the pipeline. Durable program state, tool receipts, cross-window delivery acknowledgements, and schema validation do.

## Implementation layer

Sol and Opus co-sign a dependency-checked milestone DAG whose paths, owners, acceptance coverage, and commands are frozen. Sol owns the main workspace. Opus works only in an isolated candidate. The opposite provider family reviews the exact candidate hash and runs the frozen checks in a fresh sandbox.

Sol may integrate an approved candidate. The program records separate semantic checkpoints for integration and verification while preserving an existing repository's HEAD and index. Astra then runs the frozen acceptance checks against the latest product snapshot. TRACE is generated after adoption so that its own creation cannot invalidate reviewed source evidence.

This mixed-provider rule is intentional: an implementation author and reviewer cannot share a provider family. A single-provider roster remains useful for architecture work but is rejected when the full implementation contract requires independence.

## Context and recovery

Each invocation is a fresh model window. The runtime estimates request size before sending, records actual usage, emits one soft-threshold notice, and switches windows before the configured hard threshold. A handoff packet is assembled mechanically from persisted source references, plans, dispositions, files, and receipts. Unknown or incomplete delivery stops recovery rather than guessing.

Events are append-oriented and materialized into chat state. Recovery resumes only safe windows; failures, cancellations, and unknown exits are not silently replayed.

## Trust boundaries

1. API keys are read from named environment variables by provider adapters. Values do not enter configuration, events, prompts, the browser API, CLI child processes, or execution containers. Local-subscription CLI adapters also explicitly scrub `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, `CODEX_API_KEY`, `CURSOR_API_KEY`, and all `*_API_KEY` variables before spawning child processes so subscription invocations cannot accidentally trigger paid API billing.
2. A workspace must be granted from a local native directory selection request. Paths are normalized and constrained to that grant.
3. Model-generated commands are structured argument arrays. The default Docker backend mounts only the work copy, runs as a non-root user, limits resources, and disables network for normal commands. Installation network access is a separate configured capability.
4. The execution image is configured by immutable local digest. The runtime does not pull, retag, or substitute an image.
5. Evidence refers to exact snapshots, commands, output hashes, and receipts. Independent acceptance operates on a frozen derived copy.

## Data and outputs

Chat state defaults to `data/chat/`. Project artifacts are written beneath the granted project, including architecture documents, `CONTRACT.json`, implementation state under `.agent/`, and TRACE. Local data, work records, capability proofs, and environment files are excluded from the publishing tree.
