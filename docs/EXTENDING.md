# Extending Multi-Agent Workbench

Extensions must preserve explicit identity, provider-family independence, workspace authority, and evidence binding. Add the smallest surface that fits the existing contracts.

## Add a model

1. Add an exact entry to `config/models.registry.json`: ID, provider, family, protocol, key-variable name, physical limits, supported efforts, and current pricing metadata.
2. Bind the model in a roster or preset. Do not add an alias, fallback, or inferred effort.
3. Extend registry, roster, and model-proof tests.
4. Run `npm run models:verify -- --offline`. Listing verification with real credentials is a separate operator action.

Changing a model ID or SDK version invalidates old proof. The runtime should report that state rather than falling back.

## Add a provider or protocol

Implement the contracts in `src/providers/types.ts` and normalize the provider stream into text, reasoning summary, tool call, usage, and terminal events. Keep provider-specific request construction and response parsing inside `src/providers/`.

Required properties:

- use the environment-variable name from the registry;
- disable provider-side storage when supported;
- preserve exact model IDs and requested effort;
- surface unsupported effort, refusal, context overflow, and protocol errors;
- normalize usage without fabricating absent fields;
- bind tool-call IDs and terminal reasons consistently;
- support abort and bounded retries only where the request is safe to replay.

Add a fake local protocol server or scripted fixture. Ordinary tests must not contact the provider. If the provider has a model-listing API, add a proof adapter that performs no inference.

## Add or change a seat

Seats live in roster JSON. Define a stable ID, kind, prompt file, strengths, phase bindings, and explicit capabilities. Then update prompt assembly and tests for every permitted and forbidden action.

Do not grant permissions because a particular model is present. Permissions belong to the seat and phase. Implementation authors and reviewers must resolve to different provider families. Only the root lead can ask the user or deliver; only Sol can write or integrate the main workspace.

## Add a tool

Define a strict zod input schema and a narrow result schema. Route the tool through the existing host or execution boundary, enforce seat/phase permission before side effects, persist receipts, and make retries idempotent. File tools must remain inside the granted workspace. Command tools must use structured arguments and a configured execution backend, never a host shell string.

Tests should cover malformed input, permission denial, path escape, cancellation, duplicate delivery, recovery, and evidence references.

## Add an execution backend

Implement the runner/backend contract under `src/exec/` and expose an explicit availability reason. A backend used for acceptance must demonstrate:

- workspace-copy isolation and scoped mounts;
- non-root or equivalent least privilege;
- normal-job network denial and a separate controlled install path;
- environment allowlisting with no provider keys;
- timeout, cancellation, output limits, and owned-resource cleanup;
- immutable backend identity or a locally verified capability proof;
- receipts that bind argv, working directory, timeout, exit status, output hashes, snapshot, and backend.

Never silently fall back to `local-unsafe`. A missing backend blocks evidence-dependent work.

## Add pipeline state

Pipeline transitions are program-owned. Validate boundary data, persist the transition, and make event replay idempotent. Do not let model prose set completion. New artifacts should carry stable references and hashes, and recovery must stop when referenced input cannot be proved.

## Verification checklist

```sh
npm run check
npm ci --prefix web
npm --prefix web test
npm run build:web
npm run demo:offline
npm run prepublish:scan
```

Add targeted tests before relying on the full suite. Live smoke testing is optional, budgeted, and guarded; it is not a substitute for deterministic protocol fixtures.
