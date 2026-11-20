# Contributing

Contributions are welcome when they preserve the workbench's explicit trust boundaries and offline verification.

## Setup

Use Node.js 22.12 or newer, Git, and Docker. Install both dependency sets:

```sh
npm ci
npm ci --prefix web
```

Build the local offline-demo image when changing pipeline or execution behavior:

```sh
docker build -t dmw-sandbox:local docker/sandbox
```

## Development rules

- Keep changes narrow and follow existing module boundaries.
- Validate new boundary input with zod.
- Prefer one statement per line; keep new source files near 400 lines or smaller.
- Do not add runtime dependencies without a clear need and review.
- Preserve API/CLI separation and legacy CLI behavior.
- Never weaken assertions or add an unexplained skip.
- Tests and CI must use scripted providers or local fake servers, never real model calls.
- Never commit `.env`, keys, local data, work evidence, host paths, or capability proofs.

Provider, model, roster, tool, and backend changes have additional requirements in [Extending](docs/EXTENDING.md).

## Verification

Run the smallest targeted test first, then the release checks relevant to your change:

```sh
npm run check
npm --prefix web test
npm run build:web
npm run demo:offline
npm run prepublish:scan
```

`demo:offline` requires the local `dmw-sandbox:local` image and a running Docker engine. It makes zero model API calls.

The native Windows MXC execution tests require a directly executable Codex CLI with MXC support. Windows tests for proof and ticket validation also run without Codex. Both sets use local fixtures and require no model credentials.

## Pull requests

Describe the behavior changed, trust boundaries affected, tests run, and any validation you could not perform. Include no generated dependency directories, local logs, screenshots containing private data, or live ledgers. A change is not complete solely because a model says it is; provide fresh test or receipt evidence.
