// System endpoints of the online demo (README.md "System endpoints"): session, chat capabilities, chat settings, workspace
// grants, the environment check and the legacy run config. Data lives in scenario/system-data.ts; settings checks and
// the services derivation live in mock/system-settings.ts.
//
// State is in memory and lasts until the page reloads:
// - Saved settings replace the initial ones, and the 运行状态 services are derived from them on every read.
// - The workspace grant list is fixed: one active grant w-roomdesk. Revoking it is refused (409, READ_ONLY).
// Nothing here calls a model or a backend. The paid live probe is refused with 409.
import { demoWorkspaceGrant, apiConfiguration, appConfig, DATA_ROOT, demoDrivers, initialSettings, probeReport, RUNNER } from '../scenario/system-data';
import { deriveServices, parseSettings } from './system-settings';
import { fail, json, READ_ONLY, route, type MockRequest } from './router';
import type { ChatCapabilities, ChatSettings, WorkspaceSelection } from '../../src/lib/chat-api';
import type { ProbeResponse } from '../../src/pages/new/environmentModel';

/** The answer to the paid live probe (README.md "System endpoints"). */
const NO_MODEL_CALLS = '在线演示不调用模型。';
/** Shown once per folder pick: the browser has no native folder dialog, so the preset project is chosen. */
const PICKER_TOAST = '在线演示没有系统目录选择窗口，已选中预设项目 roomdesk。';
const SELECTION_TTL_MS = 120_000;

let settings: ChatSettings = initialSettings();
const selections = new Map<string, number>();
let selectionSeq = 0;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** GET /api/chat-capabilities. Built fresh on every call; it changes only when the settings are saved. */
function capabilities(): ChatCapabilities {
  return {
    drivers: demoDrivers(),
    services: deriveServices(settings),
    exec: { backend: 'docker', available: true, unsafe: false },
    apiConfiguration: apiConfiguration(),
    runner: clone(RUNNER),
    nativePicker: true,
    dataRoot: DATA_ROOT,
  };
}

function putSettings(req: MockRequest): Response {
  const parsed = parseSettings(req.body);
  if (!parsed.ok) return fail(400, parsed.message);
  settings = parsed.settings;
  return json(clone(settings));
}

/** POST /api/workspaces/select: 202 pending, like the server while its dialog is open. The poll then selects. */
function startSelection(): Response {
  selectionSeq += 1;
  const requestId = `sel-${Date.now().toString(36)}-${selectionSeq}`;
  const expiresAt = Date.now() + SELECTION_TTL_MS;
  selections.set(requestId, expiresAt);
  try { window.__mawbDemo?.toast(PICKER_TOAST); } catch { /* the pill is optional */ }
  const selection: WorkspaceSelection = { requestId, status: 'pending', expiresAt };
  return json(selection, 202);
}

/** GET /api/workspaces/select/:id: always the preset grant, unchanged (same id and version). */
function pollSelection(req: MockRequest): Response {
  const requestId = req.params.id ?? '';
  const expiresAt = selections.get(requestId);
  if (expiresAt === undefined) return fail(404, '目录选择请求不存在或已过期');
  selections.delete(requestId);
  const selection: WorkspaceSelection = { requestId, status: 'selected', expiresAt, workspace: demoWorkspaceGrant() };
  return json(selection);
}

/** POST /api/probe: the free check answers; a request with live targets would call models, so it is refused. */
function probe(req: MockRequest): Response {
  const body = req.body as { live?: unknown } | undefined;
  if (Array.isArray(body?.live) && body.live.length > 0) return fail(409, NO_MODEL_CALLS);
  const response: ProbeResponse = { env: probeReport(), live: [] };
  return json(response);
}

/** Registers the system routes with mock/router.ts. Called once by main.ts before the product loads. */
export function install(): void {
  route('GET', '/api/session', () => json({ token: 'demo-token' }));
  route('GET', '/api/config', () => json(appConfig()));

  route('GET', '/api/chat-capabilities', () => json(capabilities()));
  route('GET', '/api/chat-settings', () => json(clone(settings)));
  route('PUT', '/api/chat-settings', putSettings);

  route('GET', '/api/workspaces', () => json([demoWorkspaceGrant()]));
  route('POST', '/api/workspaces/select', startSelection);
  route('GET', '/api/workspaces/select/:id', pollSelection);
  route('DELETE', '/api/workspaces/:id', () => fail(409, READ_ONLY));

  // The product only POSTs /api/probe; GET answers the same free check.
  route('GET', '/api/probe', () => json({ env: probeReport(), live: [] } satisfies ProbeResponse));
  route('POST', '/api/probe', probe);

  route('POST', '/api/reference-documents/import', () => fail(409, READ_ONLY));
  route('POST', '/api/reference-archives/import', () => fail(409, READ_ONLY));
}
