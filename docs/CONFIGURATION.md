# Configuration

The API runtime reads `config/chat.config.json` when present. Start from `config/chat.config.example.json`, then replace local values. Configuration stores environment-variable names and policy, never API-key values.

## API keys

Copy `.env.example` to `.env` or export the variables in the process environment. A pipeline run needs the keys for the providers it uses.

| Provider | Variable |
| --- | --- |
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| Google | `GEMINI_API_KEY` |
| xAI | `XAI_API_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |

`.env` is local and must never be committed. API mode loads it at startup. Secret values are not returned by the capabilities API; the UI sees only the variable name and whether it is present.

## Model registry and proof

`config/models.registry.json` is the source of exact model IDs, provider families, wire protocols, context limits, output limits, supported effort values, key-variable names, and pricing metadata. Aliases and silent fallback are rejected.

Run a schema-only offline check with:

```sh
npm run models:verify -- --offline
```

To verify listings for the entire registry, set a key for every registered provider and run the following command.

```sh
npm run models:verify
```

For a subset, supply `--provider` for each provider whose listings you want to verify. This example requires the OpenAI and Anthropic keys. Both commands use listing requests and send zero inference requests.

```sh
npm run models:verify -- --provider openai --provider anthropic
```

The proof is stored under the configured `dataRoot`. A model is unavailable when its key is missing, its listing cannot be proved, its SDK version differs from the recorded proof, or its configured effort is unsupported. Listing proof does not send a prompt and is distinct from the opt-in live smoke test.

The shipped rosters use `gpt-6.2-astra` and `gpt-6.2-sol` for new chats. Refresh the OpenAI listing proof for API mode after upgrading. Existing API chats keep their frozen model bindings, and the registry retains the specifications they reference.

## Rosters and presets

`config/roster.json` and `config/presets/roster.flagship.json` define named seats, phase-specific model/effort/delegation bindings, capabilities, pools, and provider families. `config/presets/roster.single-provider.json` is architecture-only when all implementation authors and reviewers resolve to one family.

`rosterFile` may point to another validated roster. A roster must use exact registry IDs. Permission belongs to the seat and phase, not to a model name.

The bundled `single-provider` preset uses OpenAI models. For the bundled flagship roster, set the five variables listed above and run `npm run models:verify`. With a custom roster, verify the providers it uses in one command by repeating `--provider`. Review the result for the exact model IDs selected by your roster. If a model is unavailable to your account, update the registry and roster to verified specifications and supported effort values before starting a new chat.

Set a positive integer `delegationWeight` on every seat and worker pool to enable weighted delegation. An agent may submit work only to an eligible target with strictly lower weight. Named seats also require `can.delegateSeats` permission, and pools must be available in the current layer. A cluster submission requires permission for every seat in that mode. The runtime preserves phase, task mode, and workspace checks.

The flagship roster starts with Fable 5.2 at 4, Astra 6.2 and Opus at 3, Carbon and Sol at 2, and worker pools at 1. Weights belong to roster seats and pools, so two seats can use the same model with different authority. Chats keep their frozen roster. Rosters without weights follow their original delegation policy.

Advanced operators can also add custom or local loopback (`http://127.0.0.1`, `localhost`, `[::1]`) OpenAI-compatible endpoints (`openai-chat` or `openai-responses`) via `config/models.registry.local.json`. Custom entries still require a named `apiKeyEnv` variable, streaming usage reporting, and a passing `models:verify` listing check (no silent aliases or fallback).

## Per-task custom teams and Lead Agent dispatch

You do not need all five providers configured to run multi-agent tasks. Startup never blocks on missing models or keys, and Command Deck allows composing a **per-task custom team** — including designating **any available model or qualified local CLI seat as the Lead Agent (`主 Agent`)** with explicit dispatch authority — either in the composer popover (`任务协作团队` / `自定义协作团队`) or via HTTP API.

### Discovery: `GET /api/chat-capabilities`

- `teamConfiguration` returns the active `driverMode` (`"api"` or `"cli"`), `supported`, `defaultRoster`, and the full `options[]` catalog (`id`, `label`, `provider`, `family`, `authLabel`, `defaultEffort`, `efforts`, `available`, `reason`, `model`, `contextWindow`). Unavailable models remain visible with their exact `reason` and are never silently substituted.
- `apiConfiguration.presets[]` preserves `available` (full end-to-end pipeline readiness) and adds `scope` (`"full"` or `"architecture_only"`) plus `architectureAvailable`. When you only have one API provider family (such as OpenAI with `single-provider`), the UI allows selecting that preset when `architectureAvailable` is `true` and displays a clear Gate-A scope notice (`仅架构阶段 · 至关卡 A`).

### Creation: `POST /api/chats` (`team` payload)

Pass an optional `team` object when creating a normal chat (`team` and `pipeline` are mutually exclusive; sending both returns `400`). Omitting `team` preserves the default roster behavior.

```json
{
  "title": "API service refactor",
  "workspaceId": "w-my-project",
  "team": {
    "leadModel": "gpt-6.2-astra",
    "leadEffort": "max",
    "delegation": "proactive",
    "allowLeadWrite": false,
    "requireAcceptanceReview": true,
    "members": [
      { "model": "gpt-6.2-sol", "role": "writer", "effort": "max" },
      { "model": "claude-opus-5-5", "role": "reviewer", "effort": "max" }
    ]
  }
}
```

- `leadModel`: exact registered model ID in API mode, or one of `claude`, `astra`, `sol`, `grok` in local CLI mode (no longer locked to `claude`). Optional `leadLabel` (<= 60 chars) and `leadEffort` (in API mode; CLI mode pins the qualified effort).
- `delegation`: Lead dispatch authority — `"proactive"` (autonomously decompose and dispatch authorized members), `"explicit"` (dispatch only when asked or needed), or `"none"` (Lead works solo; dispatch disabled).
- `members`: `0..16` authorized collaborators (each a model/CLI ID string or `{ model, label?, effort?, role? }`):
  - `"collaborator"` (default, weight `2`): read-only analysis, options, and synthesis.
  - `"writer"` (weight `2`): code implementation and command execution (`exec`). The first `writer` owns main-workspace write & integration when `allowLeadWrite` is `false`; additional writers operate in isolated copies (`writeIsolated`).
  - `"reviewer"` (weight `3`): independent read-only snapshot review, test execution, and acceptance (`acceptance`, `exec`).
  - In local CLI mode, the Lead cannot be listed as its own collaborator and each CLI role can appear at most once.
- `allowLeadWrite` (default `false`): grants the Lead main-workspace write, integration, and `exec` authority (recommended for single-model execution or direct lead coding).
- `requireAcceptanceReview` (optional): defaults to `true` when `delegation !== "none"` and at least one `"reviewer"` member is selected, otherwise `false`. Setting `true` without a `"reviewer"` or under `delegation: "none"` fails closed with HTTP `400`.
- **Fail-closed & frozen per chat**: Unknown IDs or unsupported efforts return `400`; any unavailable Lead or member returns `503` with the exact reason (zero silent downgrade). Valid teams are synthesized and frozen onto the chat record (`apiRoster` in API mode, `cliRoster` in CLI mode, plus `team: FrozenChatTeam`). During execution, a frozen custom team binds `agent_submit` (and CLI `grok_submit` when authorized) strictly to its frozen authorized members and fails closed with HTTP `503` if a frozen member goes offline mid-session — never silently dropping it (by contrast, default non-pipeline chats automatically prune offline seats/pools from `agent_submit`, `worker_submit`, and `fanout_submit`). `delegationWeight`, `can.delegateSeats`, and `WorkspaceGateway` boundaries are enforced in code throughout.

## Gates, quality, scheduling, and budget

- `gates.clarify`, `gates.architecture`, and `gates.delivery`: `user` or `auto`.
- `quality.crossReview`: require cross-review.
- `quality.maxReworkRounds`: `1` through `10`; the default is `2` reworks after the initial attempt.
- `quality.clusterCrossRounds`: `1` or `2`.
- `scheduler.seatConcurrency`: concurrent named-seat requests.
- `scheduler.fanoutMaxItemsPerCall`, `workerMaxItemsPerCall`, `parentOutstanding`, and `queued`: positive limits or `null`.
- `budget.maxUsd`: positive run cap or `null`.
- `budget.maxTokens`: positive token cap or `null`.
- `recovery.autoResume`: whether eligible safe windows resume after restart.

Before each request, the runtime reserves against the most conservative configured price category. Actual normalized usage replaces the reservation after a response.

## Context windows

`context.seats` and `context.pools` configure `softTokens`, `hardTokens`, initial/output limits, tool actions, and elapsed minutes. `context.overrides` may specialize a model. `hardRatio` is an additional physical-window safety ratio.

The registry supplies physical limits and verification supplies current proof. Missing hard-limit facts make a model unavailable; the runtime does not guess.

## Docker execution

Build the local image, then resolve its immutable ID:

```sh
docker build -t dmw-sandbox:local docker/sandbox
docker image inspect --format '{{.Id}}' dmw-sandbox:local
```

Put the returned `sha256:` ID in `exec.docker.image`. Tags are accepted by the offline demo as a convenience, but production configuration requires an immutable local ID. The runtime never pulls or silently substitutes it.

Merge this `exec` entry into the copied `config/chat.config.json` and replace the sample image value with the ID printed by Docker.

```json
{
  "exec": {
    "backend": "docker",
    "installNetwork": false,
    "docker": { "image": "sha256:<image-id>" }
  }
}
```

`exec.backend` defaults to `docker`. `exec.installNetwork` controls the separate package-install path; ordinary commands remain offline. Docker settings can limit memory, CPUs, PIDs, user, allowed environment-variable names, installation commands, and the named package-cache volume. The cache is mounted only where policy allows it.

Browser acceptance uses the separate immutable `exec.browserImage`. If no browser image is configured, UI acceptance stays explicitly unverified; it is never converted into a command-line pass.

The `wsl-bwrap` and `windows-mxc` backends require a current local capability proof. `local-unsafe` is an explicit compatibility option and does not qualify as isolated independent evidence.

## Local CLI mode

ApexCluster separates **local-subscription CLI execution** from **BYOK API key execution** with explicit boundaries and zero silent fallback between modes:

| Surface / Subsystem | Auth Mode | Supported Providers / Agents | Out-of-the-Box w/ Local Subscription? | Notes & Guardrails |
| --- | --- | --- | --- | --- |
| **Dual-Model Reviews** (`/api/runs`, `npm run probe`, Web UI `New Review`) | Local Subscription CLI | **Claude Code** (Claude Pro/Max), **Codex CLI** (ChatGPT Plus/Pro); optional **Cursor Agent CLI** (Grok) | **Yes** (Claude Code + Codex CLI; zero API keys) | Actively strips `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, `CODEX_API_KEY`, `CURSOR_API_KEY`, and all `*_API_KEY` env vars before spawning CLIs. Cursor CLI requires H7 capability records. |
| **Command Deck Chat CLI Mode** (`driverMode: "cli"`) | Local Subscription CLI | `claude` (Claude Code), `astra` / `sol` (Codex CLI `app-server`), `grok` (Cursor Agent CLI) | **Proof-gated** (fail-closed) | Supports per-task custom teams & designating **any qualified CLI seat** (`claude`, `astra`, `sol`, `grok`) as Lead (`cliRoster`). Requires `capabilities/models.json` proofs + Windows Job supervisor (`windows-job-supervisor.exe` on Windows desktop/portable builds); Cursor chat requires WSL2 `bwrap` isolation. |
| **Command Deck Chat API Mode** (`driverMode: "api"`, default) | BYOK API Keys | Anthropic, OpenAI, Google Gemini, xAI, DeepSeek + custom/local OpenAI-compatible endpoints | No (API keys via `.env`) | Supports partial providers (`models:verify -- --provider <p>`) and per-task custom teams (`POST /api/chats` `team`). |
| **v1 Two-Layer Pipeline** (`npm run pipeline` & Web UI `Pipeline`) | BYOK API Keys only | Same 5 API providers (`single-provider` for Gate A; multi-family for full delivery) | No (requires API mode) | Always runs in API mode; Gemini and DeepSeek are API-key only. No hybrid CLI+API mixing inside a single chat. |

### Dual-Model Reviews (Out-of-the-Box Local Subscriptions)

The web UI's [New Review](http://127.0.0.1:5170/#/new) page and `/api/runs` use authenticated local CLIs through the review workflow, independently of the chat driver setting.

1. Install and sign in to **Claude Code** (`claude` login, Claude Pro/Max) and **Codex CLI** (`codex login`, ChatGPT Plus/Pro) under the same local user that starts the workbench. The review workflow uses Claude Code for Claude and Codex CLI for Astra and Sol. Cursor Agent CLI (Grok) is optional and requires separate H7 capability checks.
2. Run `npm run probe` from the repository root. It checks binary discovery, versions, `claude auth status` (`claude.ai` / `oauth_token`), and `codex login status` without sending a model prompt, and explicitly warns if an API-key billing path is detected. Before launching CLI child processes, adapters also strip `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, `CODEX_API_KEY`, `CURSOR_API_KEY`, custom base URLs, and all `*_API_KEY` variables to prevent accidental paid API billing. To override binary paths or model IDs, copy `config/workbench.config.example.json` to `config/workbench.config.json`.
3. Run `npm ci --prefix web`, `npm run build:web`, and `npm start`. On New Review, confirm the subscription-quota prompt before launching a real review.

### CLI-Backed Chats (`driverMode: "cli"`)

For CLI-backed **new chats** (including custom per-task teams with any qualified CLI role as Lead via `cliRoster`), set `"driverMode": "cli"` in `config/chat.config.json` and supply a local capability proof for each seat you intend to use. `capabilitiesFile` defaults to `<dataRoot>/capabilities/models.json`. Proofs bind the CLI binary, model, effort, and isolation policy. Claude, Astra, and Sol require Windows Job isolation (`windows-job-supervisor.exe`) and a matching supervisor manifest, and Cursor/Grok chat requires WSL2 `bwrap` isolation and verified tool-exclusion records. An absent or stale proof keeps that seat disabled rather than falling back. `npm run probe` does not generate isolation proofs.

## Data locations

`dataRoot` defaults to `./data/chat`. Relative paths resolve from the repository root. The application checks that the destination is writable and has at least 256 MiB available. Product workspaces are independent: the runtime gains access only after a native local directory selection grant.

## Headless behavior

`npm run pipeline` always uses API mode, even when an old local desktop configuration defaults to CLI mode. Use `--auto` for unattended gates. Without `--auto`, a non-interactive process exits with code `3` and emits an `input_required` JSON event instead of guessing a decision.

Each CLI invocation writes its chat journal and execution scratch data to a separate directory under the configured `dataRoot/pipeline-runs`. The initial `started` JSON event includes `sessionRoot` so the durable run record can be located and inspected without sharing mutable chat state with the web service or another CLI process. Model, runner, and media proofs, service settings, and workspace grants continue to come from the configured data root.
