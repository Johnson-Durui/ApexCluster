# Interface principles

The workbench is a restrained decision instrument (指挥台 Command Deck): a light, full-screen, app-like frame of cool mist planes, dark ink for content, seat inks that identify origin, and one indigo reserved for what waits on the user. Decoration supports orientation and must never block input, hide evidence, or imply state that the server did not report. The single source of truth for tokens is `src/styles/tokens.css`; the build spec is `work/ui-redesign-20261119/BUILD-SPEC-B.md`.

## Product truth

- Server state, receipts, and evidence are authoritative. The UI distinguishes running, waiting, blocked, failed, cancelled, simulated, unverified, and complete states.
- Final model text appears as a completed message. Tool and agent lifecycle events may update live, but raw tool output and partial private reasoning are not presented as product progress. There is no typing caret, no fake progress bar and no invented metric.
- Unknown usage, limits, model proof, or acceptance remain visibly unknown. Do not convert absence into a pass.
- Fixed demos and simulated data carry a dashed `▷ 预设演示` / `模拟数据` tag wherever they appear.
- Normal chat, pipeline chat, and legacy runs keep their own contracts; visual reuse must not merge their mutations or state semantics.

## Frame

- One shell on every route: a sidebar (248px, a 64px icon rail at ≤1320px), a 44px top bar whose title and actions the page fills through `components/shell/ShellSlots.tsx`, and a 28px mono status bar across the full width (connection, sandbox, page cells, usage).
- Column hairlines run unbroken from the top bar to the status bar. The top bar, page heads, thread, composer and status bar share one gutter.
- No root zoom, no transform on text, no `h-screen` + `overflow:hidden` without a short-window layout (below 600px tall the frame scrolls).
- Desktop windows only (1920×1080 down to 1280×720; 1180 degrades cleanly). No page-level horizontal overflow.

## Colour and status

- Planes: canvas, sidebar, pane, paper and white surfaces from the token file. Text uses `--ink`, `--ink-2` and `--muted` only (≥4.5:1); `--faint`, `--ghost`, `--queued` and `--idle` are for glyphs and rules.
- **Indigo (`--gate*`) means "waiting on you"** (等你决定 / 等你回答) and nothing else. Primary actions are ink. Focus rings are ink. A filled `.gate` button resolves a pending decision, at most one per visible pane; links that jump to a decision use `.gate.outline`.
- **Status is always glyph + word + colour**, never colour alone: ▶ 运行 · ✓ 完成 · ◆ 等你 · ‖ 等待子任务 · ⋯ 排队 · ✕ 失败 · ■ 停止 · ○ 未开始 · ⊘ 阻塞 · ▷ 演示 (`Status` in `components/ui.tsx`).
- Seat inks identify a seat (dot, rule, strand) and never carry status alone. Known seats resolve `--ink-s` from `[data-seat]`; other seats get `seatInk()` inline.
- The chamfered `.decision-card` is the one shape that means "a decision is yours to make".
- No neon, no purple gradients, no dark dashboards, no classical or rococo ornament, no paper textures or script fonts.

## Typography

System Chinese UI fonts (`--font`) for text; `--mono` for ids, times, tokens, models and the status bar (tabular numerals); upright Georgia (`--num`) for large numerals and the seat name in the inspector. 11.5px is the minimum text size anywhere. Headings are sans-serif; there is no display serif.

## Motion

- Motion runs only on real state transitions observed live (a server event, a POST response, or labelled fixed-demo playback), never on snapshot load. At idle there are zero running animations and zero animation frames; a gate or question waiting on the user is idle.
- Reduced motion has one source: `components/motion.ts` sets `<html data-motion="reduce">` from the media query or the `dmw:motion` QA switch, and all CSS keys off `:root[data-motion=reduce]`.
- One animation frame owner per surface (the map clock, `tweenNumber` for counts); both stop at rest and pause while a dialog is open. Two systems never write the same element's transform or opacity.
- Background timers and autoplay never override a choice the user made. Two existing behaviours are kept by the user's decision (2026-11-20, BUILD-SPEC-B §1.10): the run page switches to the tab of a new phase (never away from the overview), and the fixed-demo product dialog opens once per demo when the product is ready.

## Interaction

- Preserve original whitespace and IME composition in the composer.
- Never submit a shortcut or workspace selection implicitly.
- Keep cancellation, retry, question answering, workspace grant/revocation, attachment preview, and artifact download reachable by keyboard. Core information is never hover-only.
- Escape closes only the top layer (popover or dialog first), and focus returns to its opener. Use native semantics (`<dialog>`, `role=separator`, tablists with roving focus) before custom keyboard behaviour.
- Reconnect live streams from the last sequence cursor and reconcile gaps without duplicating events or moving the reading position unexpectedly.
- Every toast action also exists outside the toast.

## Security and content

Render untrusted text as text. Preview HTML and SVG artifacts through the existing safe server path rather than executing attachment code. The browser receives API-key variable names and presence state only, never secret values. Fonts and images are self-hosted or system-provided; avoid external runtime assets that conflict with the local content-security policy.

## Verification

Every UI change should have a focused Vitest case, then pass frontend typecheck, the full frontend suite, and a production build. Changes to pipeline creation, gates, live events, settings, or layout also require browser verification at the desktop window sizes with no console errors, no horizontal overflow, an unbroken status bar, and the idle zero-motion check.
