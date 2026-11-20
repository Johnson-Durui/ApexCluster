<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/apexcluster-logo-dark.svg" />
  <source media="(prefers-color-scheme: light)" srcset="docs/images/apexcluster-logo.svg" />
  <img src="docs/images/apexcluster-logo.svg" alt="ApexCluster Logo" width="96" />
</picture>

# ApexCluster

### The Apex Multi-Vendor Product & Engineering Cluster
**PRD-Ready Architecture Layer for PMs · Cross-Provider Checks & Balances · Immutable Docker Sandboxes · Zero Silent Fallback**

<p>
  <a href="https://johnson-durui.github.io/ApexCluster/"><strong>▶ Live Demo</strong></a> ·
  <a href="README.md">中文</a> ·
  <a href="README.en.md"><strong>English</strong></a> ·
  <a href="ARCHITECTURE.md">Architecture</a> ·
  <a href="docs/CONFIGURATION.md">Configuration</a> ·
  <a href="docs/EXTENDING.md">Extending</a> ·
  <a href="SECURITY.md">Security</a>
</p>

<p>
  <a href="https://johnson-durui.github.io/ApexCluster/"><img src="https://img.shields.io/badge/Live%20Demo-GitHub%20Pages-4F46E5?logo=githubpages&logoColor=white" alt="Live Online Demo" /></a>
  <img src="https://img.shields.io/badge/Node.js-%E2%89%A522.12-339933?logo=node.js&logoColor=white" alt="Node.js >= 22.12" />
  <img src="https://img.shields.io/badge/TypeScript-Strict-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Providers-5%20Frontier%20Labs-8A2BE2" alt="5 Frontier Providers" />
  <img src="https://img.shields.io/badge/Sandbox-Immutable%20Docker-2496ED?logo=docker&logoColor=white" alt="Immutable Docker Sandbox" />
  <img src="https://img.shields.io/badge/Downgrade-Zero%20Silent%20Fallback-D93F0B" alt="Zero Silent Fallback" />
  <img src="https://img.shields.io/badge/License-MIT-0E8A16" alt="MIT License" />
</p>

</div>

---

**ApexCluster** (Multi-Agent Workbench) is not another prompt-chaining script where one LLM talks to itself and declares `"LGTM — all tests pass"`. It is a **local-first, adversarial, multi-vendor product & software engineering cluster** built for complex, end-to-end delivery.

Orchestrating **Anthropic, OpenAI, Google, xAI, and DeepSeek** across **5 weighted flagship seats (`4 → 3 → 2`)** and **4 parallel worker pools (up to `64` concurrent workers each)** — paired with the real-time **Command Deck** observability web UI — it cleanly separates the workflow into an **Architecture Layer** and an **Implementation Layer**:

- **PRD-Ready Architecture Layer (Tailor-Made for Product Managers)**: Start from a rough business idea and let multiple frontier labs clarify requirements, explore competing options, cross-review risks, and build a runnable prototype (`demo/`) — outputting a complete, frozen **`PRD.md`, technical architecture spec, dev guide, and measurable acceptance contract (`CONTRACT.json`)** at **Gate A**. PMs can stop right at Gate A to take the PRD and interactive prototype directly to stakeholders or engineering teams, or confirm to continue automatically.
- **Cross-Vendor Implementation & Sandbox Verification**: Past Gate A, opposing provider families co-sign the milestone plan, build in isolation, cross-review inside immutable Docker sandboxes, run independent acceptance, and emit a cryptographically linked `TRACE`.

> **Core Invariant**: **Model prose cannot promote the pipeline.** Only durable program state, validated `CONTRACT.json` schemas, SHA-256 artifact hashes, structured command receipts, cross-window read acknowledgements, and final `TRACE` evidence can advance delivery.

---

## Online Demo

[![Online demo: one requirement taken from architecture to delivery](docs/images/walkthrough.gif)](https://johnson-durui.github.io/ApexCluster/)

**[▶ Open the Live Online Demo →](https://johnson-durui.github.io/ApexCluster/)** &nbsp;|&nbsp; **[Try the Delivered RoomDesk App →](https://johnson-durui.github.io/ApexCluster/demo-project/)**

The online demo runs this repository's real **Command Deck** web interface on preset, scripted data: **no backend, no API keys, and zero model calls** (interface is in Chinese). Click **▶ 播放完整演示** (play the full demo) in the status bar to watch a team meeting-room booking app (**RoomDesk**) go from raw requirement to verified delivery:

1. **Architecture cluster (PRD & prototype)**: multiple seats clarify requirements, propose competing options, cross-review risks, and produce the PRD, architecture spec, and runnable demo while the live task map animates every dispatch and return along fibres.
2. **Gate A human checkpoint**: the run stops and lists the frozen contract & deliverables for your sign-off (auto-confirms after 20 s without input).
3. **Cross-vendor build & independent acceptance**: mixed-provider implementation, cross-review, integration, and independent acceptance.
4. **Gate B delivery**: preview or download the PRD, architecture spec, source code, test report, and complete project archive.

The delivered [RoomDesk sample app](https://johnson-durui.github.io/ApexCluster/demo-project/) opens directly in your browser (floor filtering, conflict detection, iCal export, and 30 automated tests). Task history, new review, and environment pages are browsable too.

Run the same demo locally:

```sh
npm ci --prefix web
npm --prefix web run dev:demo
```

Then open <http://localhost:5180>. The demo source lives in [`web/demo/`](web/demo/); `npm --prefix web run build:demo` builds the static bundle into `web/dist-demo/`.

---

## Screenshots

All screenshots are captured from the real Command Deck frontend running on the online demo's preset data:

| | |
|---|---|
| ![Live task map](docs/images/live-implementation.png)<br>**Live task map**: the lead splits the work; dispatches and returns between seats animate along fibres | ![Gate A](docs/images/gate-a.png)<br>**Human gates**: the run stops where your decision is needed and lists the gate's deliverables |
| ![Deliverables](docs/images/delivered.png)<br>**Deliverables**: each file names the seat that produced it and can be safely previewed or downloaded | ![Architecture view](docs/images/architecture-view.png)<br>**Architecture view**: full-screen topology, reasoning effort and context usage |
| ![Decision pipeline](docs/images/decision-pipeline.png)<br>**Decision pipeline**: architecture, gate A, implementation, acceptance, gate B, done | ![Task history](docs/images/history.png)<br>**Task history**: review runs with state, pending decisions and metrics |
| ![Review decision](docs/images/run-decision.png)<br>**Review runs**: candidate comparison and decision | ![Environment](docs/images/environment.png)<br>**Environment**: seat models, keys, execution sandbox and services |

![The RoomDesk app delivered by the demo](docs/images/roomdesk-app.png)

<sub>The RoomDesk meeting-room booking app delivered by the demo pipeline: floor filter, conflict detection and iCal export, with 30 automated tests.</sub>

---

## Why ApexCluster?

Conventional multi-agent demos collapse on real software engineering: long horizons erase original specs, same-family models rubber-stamp each other's bugs, runtimes silently swap to weaker models, and shell commands execute on the host with exposed credentials. ApexCluster enforces **hard programmatic invariants** at every boundary:

| Dimension | Typical Multi-Agent Toys | ApexCluster |
| :--- | :--- | :--- |
| **Review Independence** | Single model or same family grades its own homework | **Mandatory Cross-Vendor Separation**: Implementation author and reviewer must belong to different model families (`Sol` [OpenAI] ⇄ `Opus` [Anthropic]); `Astra` runs independent acceptance on a frozen copy |
| **Source of Truth** | LLM text claims *"Done / Tests passed"* | **Program-Owned State Machine**: Every transition binds `CONTRACT.json`, SHA-256 snapshot/artifact hashes, structured `argv` command receipts, and post-adoption `TRACE` |
| **Model & Image Integrity** | Silent fallbacks, aliases, mutable `:latest` tags | **Zero Silent Downgrade**: Exact registry model IDs, zero-inference listing proofs (`models:verify`), and immutable local `sha256:` Docker image digests |
| **Long-Horizon Context** | Lossy LLM summarization drops specs & errors | **Lossless Window Rotation**: Tracks real physical limits and actual token usage, rotating before hard thresholds with mechanically assembled reference-preserving handoff packets |
| **Authority & Concurrency** | Flat chaotic loops where any agent edits anything | **Weighted Delegation (`4 → 3 → 2 → 1`)**: Agents can only dispatch to strictly lower weights; `Sol` is the sole main-workspace writer; 4 worker pools scale up to `64` concurrent workers each |
| **Execution & Secret Safety** | Host shell strings with leaked API keys | **Hard Trust Boundaries**: Offline non-root Docker sandboxes by default (plus WSL `bwrap` / Windows MXC); env-only API keys never enter configs, logs, browser payloads, or containers |

---

## Two-Layer Pipeline Architecture

> **Built for Product Managers too (Standalone Architecture Layer)**: The Architecture Layer works out of the box as a multi-vendor **PRD & prototyping studio**. Feed it a rough product idea and the cluster clarifies edge cases, weighs alternative designs, cross-reviews feasibility across labs, builds a clickable `demo/` prototype, and delivers a frozen **`PRD.md` + `ARCHITECTURE.md` + `DEV_GUIDE.md` + `CONTRACT.json`** at **Gate A** — making it an ideal fit for PM workflows (PRDs, spec reviews, trade-off analysis, and stakeholder prototypes) even when you stop at Gate A, or seamless end-to-end delivery when you confirm into implementation.

```mermaid
flowchart TD
    subgraph Arch["Architecture Layer · Product & Tech Blueprint (Standalone for PMs: PRDs & Prototypes)"]
        direction LR
        A1("1. Clarification<br/>Fable (W4)"):::archNode
        A2("2. Diverse Options<br/>Carbon (W2)"):::archNode
        A3("3. Cross-Review<br/>Astra ⇄ Opus (W3)"):::archNode
        A4("4. Demo + PRD Spec<br/>Sol demo/ · CONTRACT"):::archNode
        GA{{"◆ Gate A Freeze<br/>PM Sign-Off Ready"}}:::gateA
        A1 --> A2 & A3 --> A4 --> GA
    end

    subgraph Impl["Implementation Layer · Cross-Vendor Build & Immutable Sandbox Verification"]
        direction LR
        I1("5. Co-Signed DAG<br/>Sol ⇄ Opus Plan"):::implNode
        I2("6. Parallel Build<br/>Sol Main + Opus Isolated"):::implNode
        I3("4×64 Worker Pools<br/>xAI · Google · DeepSeek"):::implNode
        I4("7-9. Review + Accept<br/>Docker · Sol · Astra"):::implNode
        GB{{"◆ Gate B Delivery<br/>Hashed TRACE Sign-Off"}}:::gateB
        I1 --> I2 & I3 --> I4 --> GB
    end

    Arch ==>|"confirm (Gate A)"| Impl

    classDef archNode fill:#ffffff,stroke:#6366f1,stroke-width:1.4px,color:#1e293b
    classDef implNode fill:#ffffff,stroke:#10b981,stroke-width:1.4px,color:#1e293b
    classDef gateA fill:#eef2ff,stroke:#4f46e5,stroke-width:2px,color:#1e1b4b
    classDef gateB fill:#ecfdf5,stroke:#059669,stroke-width:2px,color:#064e3b
    style Arch fill:#f5f7ff,stroke:#818cf8,stroke-width:1.5px,color:#1e293b
    style Impl fill:#f2fbf7,stroke:#34d399,stroke-width:1.5px,color:#1e293b
```

---

## Flagship Cluster Roster

Permissions belong strictly to the **seat and phase**, never to a model string. When `delegationWeight` is configured, every agent may only dispatch work to targets with a **strictly lower weight**.

### 5 Flagship Leadership & Engineering Seats

| Seat | Weight | Default Flagship Model | Provider Family | Effort | Role & Enforced Authority |
| :--- | :---: | :--- | :--- | :---: | :--- |
| **`claude` (Lead)** | `4` | `claude-fable-5-2` | Anthropic | `max` | Sole user interface, clarification, owns the single shared proposal & final delivery; delegates to all seats; no direct workspace writes |
| **`astra` (Secondary)** | `3` | `gpt-6.2-astra` | OpenAI | `max` | Feasibility analysis, risk correction, parallel architecture critique, and **cross-family independent acceptance** (`acceptance`, `exec`) |
| **`opus` (CrossRef)** | `3` | `claude-opus-5-5` | Anthropic | `max` / `xhigh` | Architecture cross-review, milestone DAG co-signing, **isolated candidate implementation** (`writeIsolated`, `exec`), and cross-vendor review |
| **`carbon` (Ideator)** | `2` | `gemini-4-carbon` | Google | `high` | Generates diverse architectural directions, applicability bounds, and risks without adjudication authority |
| **`sol` (Builder)** | `2` | `gpt-6.2-sol` | OpenAI | `max` | **Sole writer & integrator for the main workspace** (`writeMain`, `integrate`, `exec`); builds `demo/` and integrates verified candidates |

### 4 High-Concurrency Worker Pools (Weight `1`)

| Pool | Default Model | Provider Family | Max Concurrency | Active Layers | Specialty |
| :--- | :--- | :--- | :---: | :---: | :--- |
| **`grok`** | `grok-4.7` | xAI | `64` | Architecture + Implementation | Fast, bounded engineering subtasks and isolated edits |
| **`hydrogen`** | `gemini-4-hydrogen` | Google | `64` | Architecture + Implementation | Massive parallel workers, long-context analysis, and verification subtasks |
| **`deepseek`** | `deepseek-v4-pro` | DeepSeek | `64` | Implementation | Implementation-layer code analysis and cost-efficient engineering subtasks |
| **`mini`** | Parent-matched (`claude-haiku-5-5` / `gpt-6-luna` / `gemini-4-hydrogen`) | Adaptive | `64` | Architecture | Low-cost fast subtasks matched to the parent seat's provider |

> **Flexible Presets**: Only have an OpenAI API key right now? Use the bundled `single-provider` preset to run the full architecture cluster through Gate A. For full implementation and independent acceptance, configure the flagship providers (or a custom multi-family roster) and switch to `--preset flagship`. See [Configuration](docs/CONFIGURATION.md#rosters-and-presets).

---

## Core Engineering Guarantees

- **Zero Silent Downgrade & Verifiable Model Registry**: `config/models.registry.json` pins exact model IDs, wire protocols, physical context limits, supported reasoning efforts, and pricing. `npm run models:verify` verifies account availability via provider listing endpoints (**zero inference calls**). Missing keys, SDK mismatches, or unsupported efforts fail explicitly instead of silently falling back.
- **Cross-Provider Family Independence**: Implementation authors and code reviewers are programmatically prevented from sharing a provider family. During architecture clustering, `Astra` and `Opus` must demonstrably read and acknowledge each other's paged notes before deterministic aggregation. `TRACE` is emitted post-adoption so generating it never invalidates reviewed source hashes.
- **Lossless Context Rotation & Event-Sourced Recovery**: Each invocation starts in a clean window. The runtime tracks actual usage against verified physical limits (`softTokens`, `hardTokens`, `hardRatio`), rotating windows early with mechanically assembled reference-preserving handoff packets — never letting an LLM summary overwrite original user requirements or undelivered receipts.
- **Hard-Boundary Sandboxing & Immutable Images**: Model-generated commands are structured `argv` arrays (no host shell strings). The default Docker backend runs as non-root with resource limits, offline normal jobs, a separate opt-in `installNetwork` path, named package caches, and an immutable local `sha256:` image digest. WSL `bwrap` and Windows MXC backends are also supported via local capability proofs.
- **Conservative Pre-Request Budget Guardrails**: Before each API call, the scheduler reserves against the most conservative price tier and reconciles against actual normalized usage after response — enforced by `budget.maxUsd` and `budget.maxTokens`.
- **Dual Mode (Headless JSONL Pipeline + Local Command Deck UI & CLI Reviews)**: Run fully automated or interactive pipelines from the terminal, inspect live seats/windows/fan-out/evidence in the loopback-only (`127.0.0.1`) React 19 Command Deck UI, or leverage locally authenticated **Claude Code** and **Codex CLI** accounts for CLI-backed reviews.

---

## Quick Start

### 1. Run the Zero-Cost Full Offline Docker Demo (Recommended First Step)

Prerequisites: **Node.js >= 22.12**, **Git**, and a running **Docker** daemon. This runs the entire end-to-end pipeline using scripted providers (**zero live model calls, zero API cost**) while spinning up real isolated Docker containers, executing build & acceptance checks, and cleaning up owned resources:

```sh
git clone https://github.com/Johnson-Durui/ApexCluster.git
cd ApexCluster
npm ci
docker build -t dmw-sandbox:local docker/sandbox
npm run demo:offline
```

On success, the final line prints `PASS`.

---

### 2. Run the Live API Pipeline

#### Step 1: Configure Keys & Immutable Docker Image

1. Copy `.env.example` to `.env` and populate the provider keys you need (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY`, `DEEPSEEK_API_KEY`).
2. Copy `config/chat.config.example.json` to `config/chat.config.json`, pin your local image's immutable `sha256:` ID per [Docker execution docs](docs/CONFIGURATION.md#docker-execution), and set `budget.maxUsd`.

#### Step 2: Verify Model Listings & Launch

**Option A — Single-Provider Trial (OpenAI key only, Architecture stage to Gate A)**

```sh
npm run models:verify -- --provider openai
mkdir product
npm run pipeline -- --preset single-provider --requirement tests/fixtures/pipeline/todo-cli/requirement.md --workspace ./product
```

**Option B — Full Flagship Multi-Vendor Pipeline (Architecture + Isolated Build + Cross-Review + Acceptance + TRACE)**

Configure the five provider keys in `.env`, verify listings with zero inference calls, and run `--preset flagship`:

```sh
npm run models:verify
npm run pipeline -- --preset flagship --requirement tests/fixtures/pipeline/todo-cli/requirement.md --workspace ./product
```

<details>
<summary><strong>CLI Options & Exit Codes</strong></summary>

**Options**

| Flag | Description |
| :--- | :--- |
| `--requirement <file>` | Required UTF-8 requirement file |
| `--workspace <directory>` | Required existing product directory (accessed only after local native selection grant) |
| `--preset <name>` | Roster preset, defaulting to `flagship` (or `single-provider` / custom roster) |
| `--auto` | Automatically handle clarification and Gates A/B; without it, an interactive terminal accepts `confirm`, `revise`, or `cancel` |

**Output & Exit Codes**

The CLI streams newline-delimited JSON (NDJSON):
- `0`: Completed
- `2`: Invalid arguments or paths
- `3`: Cancelled, or input required in a non-interactive session
- `4`: Runtime failure or stall detected
- `5`: Bootstrap configuration, model proof, or execution backend unavailable

</details>

---

### 3. Launch the Local Command Deck Web UI

```sh
npm ci --prefix web
npm run build:web
npm start
```

The server binds exclusively to `127.0.0.1` (default port `5170`, configurable via `port` in `config/workbench.config.json`). The UI displays seat bindings, missing env variables or model proofs, live context limits, window rotations, fan-out progress, and evidence status — without ever exposing raw API key values to the browser.

> **Note**: When started via `npm start`, the browser UI cannot grant access to a new project directory. To run a full pipeline against a local directory, use `npm run pipeline` above.

### 4. Run CLI-Backed Reviews with Local Claude Code / Codex CLI Sign-Ins

If you already have **Claude Code** and **Codex CLI** installed and authenticated locally, you can run reviews using your local CLI quotas:

```sh
npm run probe
```

1. Verify binary discovery and login status (to override paths or model IDs, copy `config/workbench.config.example.json` to `config/workbench.config.json`).
2. Start the web server and open [New Review](http://127.0.0.1:5170/#/new).

> `npm run pipeline` always uses the API driver. Enabling CLI mode for new chats additionally requires [isolation and protocol capability proofs](docs/CONFIGURATION.md#local-cli-mode).

---

## Repository Layout & Verification

```text
├── src/
│   ├── providers/   # Normalized Anthropic Messages, OpenAI Responses & Google GenAI adapters + ScriptedProvider
│   ├── chat/        # Durable event-sourced runtime, weighted scheduler, window rotation, grants & tools
│   ├── pipeline/    # Architecture cluster, Gates A/B, contracts, milestone DAG, cross-review, acceptance & TRACE
│   ├── exec/        # Immutable Docker sandbox, WSL bwrap, Windows MXC & command receipts
│   └── server/      # Loopback-only local API & event stream
├── web/
│   ├── src/         # React 19 + TypeScript + Vite Command Deck web UI
│   └── demo/        # Backend-free static online demo & automated browser verifier
├── config/          # Exact model registry, flagship/single-provider rosters & config templates
├── docker/sandbox/  # Offline non-root execution container definition
├── tests/           # 200+ deterministic backend & frontend test suites (zero live API calls)
└── docs/            # Configuration, extending, security docs & UI screenshots
```

Run the full local verification & pre-publish security scan:

```sh
npm run check            # TypeScript typecheck + full backend test suite
npm ci --prefix web
npm --prefix web test    # Frontend tests
npm run build:web        # Production frontend bundle
npm run prepublish:scan  # Secret, personal path & identifier leak scan
```

---

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) — Two-layer pipeline design, window rotation & trust boundaries
- [docs/CONFIGURATION.md](docs/CONFIGURATION.md) — Model registry, weighted rosters, budgets, Docker digest pinning & CLI mode
- [docs/EXTENDING.md](docs/EXTENDING.md) — Adding models, providers, seats, tools & execution backends
- [SECURITY.md](SECURITY.md) — Security model, operator responsibilities, live-smoke guardrails & audit status
- [CHANGELOG.md](CHANGELOG.md) — Release history
- [README.md](README.md) — 中文文档

## License

Released under the [MIT](LICENSE) License.
