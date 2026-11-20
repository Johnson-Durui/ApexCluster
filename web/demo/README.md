# Online demo (`web/demo`)

A static online demo of the workbench. It builds the real `web/src` UI with Vite from a separate entry and answers
every `/api/*` request and every `EventSource` in the browser, from preset, synthetic data. There is no backend, no API
key and no model call. The built site works from any sub-path (`base: './'`); it is published to GitHub Pages by
`.github/workflows/pages-demo.yml`.

```
npm --prefix web run typecheck:demo    # tsc -p demo/tsconfig.json
npm --prefix web run build:demo        # vite build --config demo/vite.config.ts  ->  web/dist-demo/
npm --prefix web run dev:demo          # dev server on http://localhost:5180/ (no /api proxy)
node web/demo/scripts/verify-demo.mjs <outDir> [--private-words <file>]   # full browser tour (Windows + Edge)
node web/demo/scripts/verify-demo.mjs <outDir> --scan-only                 # dist scan only (any OS, no browser)
```

The demo builds the current product UI. A few product strings are rewritten at build time (see "Plugin
demo-overrides"), and the build fails when one of them is no longer found, so whoever changes those product strings
also updates `REPLACEMENTS` in `vite.config.ts`. `npm --prefix web run build:demo` shows such drift locally.

## Hard rules

1. Product files are never edited for the demo: everything lives in `web/demo/` (plus three scripts in
   `web/package.json`, the Pages workflow and one `.gitignore` line).
2. The built site contains none of the product's own fixed-demo wording. `scripts/verify-demo.mjs` lists the forbidden
   strings (`FORBIDDEN`) and scans every built file, including the entries of zip files, for them.
3. No private data: no real user paths, user names, e-mail addresses, tokens or real projects. The only workspace is the
   neutral `D:\Projects\roomdesk` (id `w-roomdesk`), and every name in the sample data is fictional.
4. Honesty: every page shows the demo label (`在线演示 · 预设数据，不调用任何模型`), and nothing claims that a model call
   happened.
5. No `*.test.*` or `*.spec.*` file under `web/demo/` (the product's vitest would pick it up).

## Build layout

| Path | Role |
|---|---|
| `index.html`, `main.ts` | Entry. `main.ts` installs the mock transport, the demo pill, the system, chat and run mocks and the link interceptor, then imports `../src/main.tsx`. |
| `vite.config.ts`, `tsconfig.json`, `env.d.ts` | Build (root `web/demo`, output `web/dist-demo`), typecheck (`../src` included), demo-only globals. |
| `mock/` | The browser-side server: `router.ts` (fetch and EventSource shims, route registry), `clock.ts` (speeds 1/2/4), `navigation.ts` (`/api/` links, iframes and images), `system*.ts`, `chats.ts` + `chat-*.ts`, `runs.ts`. |
| `overrides/` | Modules swapped for product modules at build time, plus `conformance.ts` (typecheck only). |
| `scenario/` | The scripted chats, the review runs (`runs/`), the deliverable texts (`content/`, `content-extra/`). |
| `chrome/` | The demo pill. |
| `public/` | Favicons and `demo-project/`, the delivered RoomDesk app with its tests and `roomdesk.zip`. |
| `scripts/` | `verify-demo.mjs` + `tour.mjs` (verification), `pack-demo-project.mjs` (rebuilds `roomdesk.zip` and `manifest.json`), `capture-media.mjs` (README screenshots and GIF). |

## Plugin demo-overrides

`vite.config.ts` swaps two product modules at resolve time (`src/lib/fixed-demo.ts` and
`src/pages/chat/FixedDemoProduct.tsx`, replaced by the files in `overrides/`) and applies a fixed list of exact string
replacements (`REPLACEMENTS`) at transform time. Every swap and every replacement must apply, otherwise the build fails.

## Mock contract

- `router.ts`: `route(method, pattern, handler)` and `stream(pattern, open)`. The fetch shim answers same-origin
  `/api/*` requests after 60-180 ms; an unknown route logs `[demo] unmocked` and answers 404. Writes the demo does not
  support answer `409 在线演示使用预设数据，此操作不可用。` (never 403). `MockEventSource` fires `open` asynchronously,
  then the route's `open(ctx)` replays and streams events; `ctx.close()` ends the stream with an `error` event.
- `clock.ts`: `after(ms)` waits `ms / speed` of real time; `setSpeed()` reschedules pending timers. The speed comes from
  `?speed=`, else from the speed last chosen in the tab.
- `navigation.ts`: `<a href="/api/…">` links never carry the `/api/` href (it would leave the published sub-path).
  Clicks are answered from the router and saved as Blob downloads; the link's href becomes a blob: URL before a context
  menu can open. `<iframe>`/`<img>` sources under `/api/` are filled from the router.

## Scenario

- **RoomDesk pipeline** (`scenario/roomdesk.ts`): the product's fixed-prompt path (`#/?new=1&demo=play`, then send)
  starts a scripted pipeline chat: architecture, gate A, implementation, acceptance, gate B, completed, with the seats
  and pools of the flagship roster. A gate confirms itself after 20 s of demo time; revise and cancel are refused.
  The visitor's run stays `仅对话` (no workspace); only the pre-baked sample is bound to the preset workspace.
- **Pre-baked chats** (`scenario/samples.ts`): a completed RoomDesk run, a weekly-report template and a README question
  that waits for an answer.
- **Plain chats** (`scenario/plain.ts`): any other text gets an honest canned answer.
- **Persistence**: chats started in a tab are saved to that tab's sessionStorage as recipes (inputs and timing) and
  rebuilt after a reload by replaying their script. Another tab or a shared link cannot open them.
- **Deliverables** (`public/demo-project/`, `scenario/content/`): RoomDesk is a real, dependency-free web app with
  30 `node:test` tests. After changing any of its files or documents, run
  `node web/demo/scripts/pack-demo-project.mjs --test-report` to refresh the test report, `roomdesk.zip` and the
  sizes and hashes in `manifest.json`.

## Runs

`mock/runs.ts` and `scenario/runs/` provide four synthetic review runs for 任务历史 and the run pages (completed,
waiting at G2, blocked, running with a live feed). Every tab renders; every write answers 409.

## System endpoints

`mock/system.ts`, `mock/system-settings.ts` and `scenario/system-data.ts`: session, capabilities (everything ready;
the single-provider preset unavailable with its real reason), settings (saved in memory), the `w-roomdesk` workspace
grant and the probe. A paid live probe is refused.

## Demo chrome

`chrome/pill.ts`: the label, `▶ 播放完整演示`, speed `1× 2× 4×`, `交付成品 ↗`, `GitHub ↗`, a collapse toggle and the
gate countdown of the chat on screen. It docks on the status bar's empty middle and never covers product controls;
below 900 px of viewport width it becomes a 26 px strip at the top and the app frame moves down. `?shots=1` hides it.

## Verification

`scripts/verify-demo.mjs` scans the dist (forbidden strings, private paths, e-mail hosts, the OS user's home path and
the literals of an optional, unpublished `--private-words` file), serves it under `/ApexCluster/` and drives
headless Edge through the tour in `scripts/tour.mjs` (desktop, tablet and phone viewports). A step fails on console
errors, unmocked requests, failed requests, error boundaries, forbidden or private text in the DOM, missing expected
text or downloads, model-call claims, a pill that covers a product control or leaves the viewport, and a layout
viewport that is not the emulated width. Options: `--dist`, `--only`, `--steps`, `--url`, `--scan-only`; environment
`CDP_PORT`, `EDGE_PATH`, `EDGE_PROFILE_DIR`. Keep the output directory outside the published tree; copy only PNGs
from it.

## README media

`scripts/capture-media.mjs` regenerates the screenshots and the walkthrough GIF in `docs/images/` from the built demo
(`?shots=1`, so the demo pill is hidden; runs play at `?speed=4`). It needs Windows with Edge, and ffmpeg for the GIF:

```
npm --prefix web run build:demo
FFMPEG=<path to ffmpeg> node web/demo/scripts/capture-media.mjs            # writes docs/images/
node web/demo/scripts/capture-media.mjs <outDir> --no-gif                   # screenshots only, elsewhere
```
