# Changelog

All notable changes to **ApexCluster** (Multi-Agent Workbench) are documented here. The format follows Keep a Changelog, and versions follow semantic versioning.

## [1.0.0] - 2026-11-20

### Added

- Direct provider adapters for Anthropic Messages, OpenAI Responses-compatible APIs, and Google GenAI, with exact model/effort validation and listing proof.
- Configurable multi-provider seat roster, worker pools, cost/token budgets, rate-limit scheduling, and durable context-window handoffs.
- Optional weighted delegation: when every seat and worker pool declares `delegationWeight`, a seat may dispatch only to targets with a strictly lower weight. Rosters without weights keep their original delegation policy.
- Architecture pipeline with full and pair clusters, source-linked requirements, acceptance contracts, runnable demos, independent review, and gate A.
- Mixed-provider implementation pipeline with co-signed milestone plans, isolated candidates, cross-family review, Git checkpoints, independent Astra acceptance, TRACE, and gate B.
- Docker execution backend with offline normal jobs, controlled installation network, named cache, resource limits, receipts, snapshot isolation, cancellation, and cleanup.
- Optional WSL bwrap and Windows MXC runners based on local capability proof, plus an explicit unsafe local compatibility backend.
- Command Deck (`指挥台`) web UI featuring a unified shell, live observatory task map with dispatch/return animations, full-screen architecture view (topology, decision pipeline, and context usage), tabbed collaboration inspector, explicit gate A/B decision cards, task history inspector, and environment/connections dashboard.
- Static online demo (`web/demo/`) driven by preset synthetic data (RoomDesk meeting-room booking app with 30 automated tests), GitHub Pages deployment workflow (`.github/workflows/pages-demo.yml`), README screenshots and walkthrough GIF (`docs/images/`), and a matching built-in offline RoomDesk fixed demo (`web/public/fixed-demo/`).
- Headless JSONL CLI with presets, automatic or interactive gates, model status, context limits, fan-out progress, and cost visibility.
- Fully offline end-to-end demo using scripted providers and a real local Docker sandbox.
- Windows and Ubuntu CI, live-smoke guardrails, and a pre-publish privacy/secret scan.

### Changed

- Shipped rosters bind Astra and Sol to `gpt-6.2-astra` and `gpt-6.2-sol`. The registry retains `gpt-6-astra` and `gpt-6.1-sol` so existing API chats keep their frozen bindings. CLI-mode defaults follow the same models; CLI capability proofs are bound to the model ID and must be regenerated.
- OpenAI Responses requests carry the system prompt as the leading `developer` input item. GPT-6.2 appends top-level `instructions` after `input` and bills them uncached on every request. xAI and DeepSeek requests still use `instructions`.
- Portable defaults now use repository-relative data locations.
- Legacy local CLI mode remains available as a separate compatibility path; API mode is the default for clean installations and headless pipelines.
- Context management uses verified physical limits and actual response usage instead of fixed API-mode approximations.

### Security

- API keys are environment-only and excluded from prompts, persistence, browser responses, CLI children, and execution sandboxes.
- Workspace grants, immutable execution images, structured command arguments, cross-provider review, and evidence hashes are enforced by the program.
- Updated the root lockfile to `zod` 4.6.7 and `fast-uri` 3.1.9, and updated DOMPurify to 3.4.18 to remove the reported critical web finding.
- Disclosed seven unresolved audit nodes: five high-severity development-only glob/toolchain nodes and two low-severity Mermaid/KaTeX runtime nodes. Loopback development defaults and strict Mermaid rendering reduce exposure but do not resolve the advisories; major toolchain replacement is deferred beyond v1.0.0.
