import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';

const PROMPT = '帮我做一个团队会议室预约小工具：先出 PRD 和技术架构，再完成可运行的 Web 应用和自动化测试。需要支持按楼层筛选、冲突检测和 iCal 导出。';
const UUID = '123e4567-e89b-42d3-a456-426614174000';
const baseTime = Date.parse('2026-11-06T00:00:00.000Z');
const texts = {
  prd: '# PRD\n预设产品需求文档内容。'.repeat(10),
  architecture: '# 架构\n预设技术架构内容。'.repeat(10),
  source: 'export const demo = true;\n'.repeat(20),
  tests: '预设测试报告，非现场模型运行。\n'.repeat(10),
};
const projectBytes = new TextEncoder().encode(`PK\u0003\u0004${'fixed-demo-zip'.repeat(1600)}`);
const urls = { prd: '/fixed-demo/prd.md', architecture: '/fixed-demo/architecture.md', source: '/fixed-demo/source.mjs', tests: '/fixed-demo/tests.txt', project: '/fixed-demo/project.zip' } as const;

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
function fixtureManifest() {
  return {
    version: 1, scenarioId: 'roomdesk-v1', prompt: PROMPT,
    artifacts: [
      ...Object.entries(texts).map(([id, text]) => ({ id, name: `${id}文件`, url: urls[id as keyof typeof texts], bytes: new TextEncoder().encode(text).byteLength, hash: digest(text) })),
      { id: 'project', name: '完整项目包', url: urls.project, bytes: projectBytes.byteLength, hash: createHash('sha256').update(projectBytes).digest('hex') },
    ],
    productUrl: '/fixed-demo/project/index.html',
  };
}

function installEnvironment(options: { storage?: Storage; manifest?: ReturnType<typeof fixtureManifest>; tamper?: keyof typeof urls } = {}) {
  const storage = options.storage ?? new MemoryStorage();
  const manifest = options.manifest ?? fixtureManifest();
  const calls: string[] = [];
  const target = new EventTarget() as EventTarget & { location: { origin: string }; dispatchEvent: typeof EventTarget.prototype.dispatchEvent };
  target.location = { origin: 'http://localhost:5173' };
  vi.stubGlobal('window', target);
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('crypto', { subtle: webcrypto.subtle, randomUUID: () => UUID });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input); calls.push(url);
    if (url === '/fixed-demo/manifest.json') return new Response(JSON.stringify(manifest), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const id = (Object.keys(urls) as Array<keyof typeof urls>).find(key => urls[key] === url);
    if (id === 'project') return new Response(options.tamper === id ? new Uint8Array([...projectBytes, 0]) : projectBytes, { status: 200 });
    if (id) return new Response(options.tamper === id ? `${texts[id]}损坏` : texts[id], { status: 200 });
    return new Response('not found', { status: 404 });
  }));
  return { storage, calls, target };
}

async function loadModule() {
  vi.resetModules();
  return import('./fixed-demo');
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(baseTime); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('fixed demo controller', () => {
  it('accepts the shipped manifest and exact checked-out bytes of all five assets', async () => {
    installEnvironment();
    const requests: string[] = [];
    const allowed = ['/fixed-demo/manifest.json', ...Object.values(urls)];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(allowed).toContain(url);
      requests.push(url);
      const bytes = readFileSync(new URL(`../../public${url}`, import.meta.url));
      return new Response(new Uint8Array(bytes));
    });
    const demo = await loadModule();
    await demo.startFixedDemo('shipped-assets');
    expect(requests).toEqual(allowed);
  });

  it('only accepts the exact trimmed NFC prompt and strict demo UUIDs', async () => {
    installEnvironment(); const demo = await loadModule();
    expect(demo.isFixedDemoPrompt(`  ${PROMPT}\n`)).toBe(true);
    expect(demo.isFixedDemoPrompt(`${PROMPT}请快点`)).toBe(false);
    expect(demo.isFixedDemoId(`fixed-demo-roomdesk-${UUID}`)).toBe(true);
    expect(demo.isFixedDemoId(`ordinary-${UUID}`)).toBe(false);
    expect(demo.isFixedDemoId('fixed-demo-roomdesk-not-a-uuid')).toBe(false);
  });

  it('loads only allowlisted static assets and never calls real chat APIs', async () => {
    const { calls } = installEnvironment(); const demo = await loadModule();
    const snapshot = await demo.startFixedDemo('client-1');
    expect(snapshot.chat.id).toBe(`fixed-demo-roomdesk-${UUID}`);
    expect(snapshot.chat.invocations).toEqual([]);
    expect(snapshot.capabilities).toEqual([]);
    expect(snapshot.recentEvents).toEqual([]);
    expect(snapshot.messages[0]).toMatchObject({ role: 'user', text: PROMPT, clientMessageId: 'client-1' });
    expect(calls).toEqual(['/fixed-demo/manifest.json', urls.prd, urls.architecture, urls.source, urls.tests, urls.project]);
    expect(calls.every(url => url.startsWith('/fixed-demo/'))).toBe(true);
  });

  it('releases artifacts at exact phase boundaries and completes only at 240 seconds', async () => {
    installEnvironment(); const demo = await loadModule(); const started = await demo.startFixedDemo('client-2'); const id = started.chat.id;
    const checkpoints: Array<[number, string[]]> = [[44_999, []], [45_000, ['prd']], [85_000, ['prd', 'architecture']], [150_000, ['prd', 'architecture', 'source']], [185_000, ['prd', 'architecture', 'source', 'tests']], [190_000, ['prd', 'architecture', 'source', 'tests', 'project']]];
    for (const [at, ids] of checkpoints) { vi.setSystemTime(baseTime + at); expect((await demo.getFixedDemoSnapshot(id)).chat.artifacts.map(item => item.id)).toEqual(ids); }
    expect(demo.getFixedDemoPlayback(id)).toMatchObject({ productReady: true, completed: false, durationMs: 240_000 });
    vi.setSystemTime(baseTime + 239_999); expect((await demo.getFixedDemoSnapshot(id)).chat.turns[0].status).toBe('running');
    vi.setSystemTime(baseTime + 240_000); expect((await demo.getFixedDemoSnapshot(id)).chat.turns[0].status).toBe('completed');
  });

  it('streams stable phase keys with progressive text', async () => {
    installEnvironment(); const demo = await loadModule(); const id = (await demo.startFixedDemo('client-3')).chat.id;
    vi.setSystemTime(baseTime + 15_000); const early = await demo.getFixedDemoSnapshot(id);
    vi.setSystemTime(baseTime + 30_000); const later = await demo.getFixedDemoSnapshot(id);
    expect(early.streams?.[0].invocationId).toBe(later.streams?.[0].invocationId);
    expect(early.streams?.[0].text.length).toBeGreaterThan(0);
    expect(later.streams?.[0].text.length).toBeGreaterThan(early.streams?.[0].text.length ?? 0);
    expect(later.chat.invocations).toHaveLength(0);
  });

  it('pauses without advancing and resumes from the saved elapsed baseline', async () => {
    installEnvironment(); const demo = await loadModule(); const id = (await demo.startFixedDemo('client-4')).chat.id;
    vi.setSystemTime(baseTime + 20_000); await demo.pauseFixedDemo(id, true); const paused = demo.getFixedDemoPlayback(id).elapsedMs;
    vi.setSystemTime(baseTime + 50_000); expect(demo.getFixedDemoPlayback(id).elapsedMs).toBe(paused);
    await demo.pauseFixedDemo(id, false); vi.setSystemTime(baseTime + 55_000);
    expect(demo.getFixedDemoPlayback(id).elapsedMs).toBe(paused + 5_000);
  });

  it('cancels permanently and does not advance afterwards', async () => {
    installEnvironment(); const demo = await loadModule(); const id = (await demo.startFixedDemo('client-5')).chat.id;
    vi.setSystemTime(baseTime + 12_000); await demo.cancelFixedDemo(id); const stopped = demo.getFixedDemoPlayback(id).elapsedMs;
    vi.setSystemTime(baseTime + 60_000); expect(demo.getFixedDemoPlayback(id)).toMatchObject({ elapsedMs: stopped, cancelled: true, paused: true });
    await expect(demo.pauseFixedDemo(id, false)).rejects.toThrow('不能继续');
  });

  it('keeps corrupt storage isolated and reports write failures', async () => {
    const corrupt = new MemoryStorage(); corrupt.setItem('dmw:fixed-demo:v1', '{bad json'); installEnvironment({ storage: corrupt });
    const demo = await loadModule(); expect(demo.listFixedDemos()).toEqual([]);
    const failing = new MemoryStorage(); failing.setItem = () => { throw new Error('quota denied'); };
    installEnvironment({ storage: failing }); const fresh = await loadModule();
    await expect(fresh.startFixedDemo('client-6')).rejects.toThrow('固定演示保存失败：quota denied');
  });

  it('drops unsafe persisted timestamps and keeps the valid upper Date boundary listable', async () => {
    const storage = new MemoryStorage();
    const valid = { id: `fixed-demo-roomdesk-${UUID}`, clientMessageId: 'safe', createdAt: 8_640_000_000_000_000 - 240_000, updatedAt: 8_640_000_000_000_000, elapsedMs: 240_000, paused: true, cancelled: false };
    storage.setItem('dmw:fixed-demo:v1', JSON.stringify([
      valid,
      { ...valid, id: 'fixed-demo-roomdesk-223e4567-e89b-42d3-a456-426614174000', createdAt: 1e308 },
      { ...valid, id: 'fixed-demo-roomdesk-323e4567-e89b-42d3-a456-426614174000', updatedAt: -1 },
      { ...valid, id: 'fixed-demo-roomdesk-423e4567-e89b-42d3-a456-426614174000', updatedAt: 8_640_000_000_000_001 },
      { ...valid, id: 'fixed-demo-roomdesk-523e4567-e89b-42d3-a456-426614174000', elapsedMs: 240_001 },
      { ...valid, id: 'fixed-demo-roomdesk-623e4567-e89b-42d3-a456-426614174000', elapsedMs: 1e308 },
      { ...valid, id: 'fixed-demo-roomdesk-723e4567-e89b-42d3-a456-426614174000', elapsedMs: -1 },
    ]));
    installEnvironment({ storage }); const demo = await loadModule();
    expect(() => demo.listFixedDemos()).not.toThrow();
    expect(demo.listFixedDemos()).toEqual([expect.objectContaining({ id: valid.id, status: 'completed' })]);
  });

  it('fails closed on tampered assets and unknown artifact IDs', async () => {
    installEnvironment({ tamper: 'prd' }); const broken = await loadModule();
    await expect(broken.startFixedDemo('client-7')).rejects.toThrow('prd 校验失败');
    installEnvironment(); const demo = await loadModule(); const id = (await demo.startFixedDemo('client-8')).chat.id;
    expect(demo.fixedDemoArtifactUrl(id, 'prd')).toBe(urls.prd);
    expect(() => demo.fixedDemoArtifactUrl(id, 'unknown')).toThrow('未知');
  });

  it('rejects a tampered project ZIP without falling back to any API', async () => {
    const { calls } = installEnvironment({ tamper: 'project' }); const demo = await loadModule();
    await expect(demo.startFixedDemo('client-zip')).rejects.toThrow('project 校验失败');
    expect(calls.every(url => url.startsWith('/fixed-demo/'))).toBe(true);
    expect(calls.some(url => url.startsWith('/api/'))).toBe(false);
  });

  it('shares one subscription timer and clears it after the last listener leaves', async () => {
    installEnvironment(); const demo = await loadModule(); const id = (await demo.startFixedDemo('client-9')).chat.id;
    const one = vi.fn(); const two = vi.fn(); const error = vi.fn();
    const stopOne = demo.subscribeFixedDemo(id, one, error); const stopTwo = demo.subscribeFixedDemo(id, two, error);
    await vi.advanceTimersByTimeAsync(0); expect(vi.getTimerCount()).toBe(1); expect(one).toHaveBeenCalled(); expect(two).toHaveBeenCalled();
    stopOne(); expect(vi.getTimerCount()).toBe(1); stopTwo(); expect(vi.getTimerCount()).toBe(0);
  });
});
