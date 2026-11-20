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

The web UI's [New Review](http://127.0.0.1:5170/#/new) page uses authenticated local CLIs through the review workflow. It works independently of the chat driver setting.

1. Install and sign in to Claude Code and Codex CLI under the same local user that will start the workbench. The review workflow uses Claude Code for Claude and Codex CLI for Astra and Sol. Cursor is optional and requires separate capability checks.
2. Run `npm run probe` from the repository root. It checks binary discovery, versions, and sign-in status without sending a model prompt. If you need to specify a binary or model, copy `config/workbench.config.example.json` to `config/workbench.config.json`. Set `adapters.claude.command` or `adapters.codex.command` to an object with `command` and optional `args`, then set the corresponding `models` entries to exact IDs and supported effort values for your accounts.
3. Run `npm ci --prefix web`, `npm run build:web`, and `npm start`. On New Review, confirm the quota prompt before launching a real review. This workflow targets Windows. A successful probe on another platform confirms local command and login discovery.

For CLI-backed **new chats**, additionally set `"driverMode": "cli"` in `config/chat.config.json` and supply a local capability proof for each seat you intend to use. `capabilitiesFile` defaults to `<dataRoot>/capabilities/models.json`. Proofs bind the CLI binary, model, effort, and isolation policy. Claude, Astra, and Sol also require Windows Job isolation and a matching supervisor. An absent or stale proof keeps that seat disabled. For an eligible scoped build, the Codex job probe and refresh scripts accept `--codex-version` to bind fresh qualification to that build's binary. `npm run probe` does not generate isolation proofs.

## Data locations

`dataRoot` defaults to `./data/chat`. Relative paths resolve from the repository root. The application checks that the destination is writable and has at least 256 MiB available. Product workspaces are independent: the runtime gains access only after a native local directory selection grant.

## Headless behavior

`npm run pipeline` always uses API mode, even when an old local desktop configuration defaults to CLI mode. Use `--auto` for unattended gates. Without `--auto`, a non-interactive process exits with code `3` and emits an `input_required` JSON event instead of guessing a decision.

Each CLI invocation writes its chat journal and execution scratch data to a separate directory under the configured `dataRoot/pipeline-runs`. The initial `started` JSON event includes `sessionRoot` so the durable run record can be located and inspected without sharing mutable chat state with the web service or another CLI process. Model, runner, and media proofs, service settings, and workspace grants continue to come from the configured data root.
