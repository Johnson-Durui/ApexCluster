# Frontend

The frontend is a React 19, TypeScript, and Vite application served by the local workbench. It contains the current chat/pipeline interface and the legacy run viewer.

## Development

Install both dependency sets from the repository root:

```sh
npm ci
npm ci --prefix web
```

Run the API server and Vite development server in separate terminals:

```sh
npm run dev
npm run dev:web
```

Vite listens on `127.0.0.1:5173` and proxies `/api` to the local server on port `5170`.

## Verification and build

```sh
npm --prefix web test
npm --prefix web run typecheck
npm run build:web
```

The production bundle is written to `web/dist`; the local server serves it automatically when present. The browser does not load runtime scripts from a CDN.

## Session and API rules

- `GET /api/session` returns a short-lived local mutation token.
- POST, DELETE, and upload requests send that token as `x-workbench-token` and retry once with a fresh session after a rejected token.
- Server-owned state remains authoritative. Do not infer completion, evidence, model availability, or acceptance in the browser.
- Import backend data structures as types only. Keep runtime validation and authorization on the server.

## Live updates

Legacy runs subscribe to `/api/runs/:id/events?since=<seq>`. Pipeline chats subscribe to `/api/chats/:id/events?since=<seq>` and reconcile gaps through the paged trace endpoint. Event sequence numbers are monotonic cursors; reconnect from the last applied event and re-fetch server state when reconciliation requires it.

## Pipeline controls

The chat creation form selects normal chat or pipeline mode, a roster preset, automatic or user gates, and a natively granted workspace. Pipeline views show stage, gate A/B controls, roster/model status, actual context limits, usage, window rotations, fan-out progress, and evidence state. Gate actions are explicit `confirm`, `revise`, or `cancel` mutations; the UI never chooses on the user's behalf unless the pipeline was created in automatic mode.

See [DESIGN.md](DESIGN.md) for current interface principles and [../ARCHITECTURE.md](../ARCHITECTURE.md) for runtime boundaries.
