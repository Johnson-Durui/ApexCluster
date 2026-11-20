/** Explicitly authorized live Claude evidence probe. It never reads real credentials or project files. */
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { resolveCommand, runProcess, scrubEnv } from '../src/adapters/process.js';

const cli = process.env.DMW_CLAUDE_CLI ?? 'claude';
const model = 'claude-opus-5-5'; const effort = 'max'; const workBase = path.resolve(process.env.DMW_WORK_ROOT ?? 'work');
const negativeOnly = process.argv.includes('--negative-only');
if ((path.isAbsolute(cli) && !existsSync(cli)) || !existsSync(path.dirname(workBase))) throw new Error('已配置的 Claude CLI 或工作根目录不可用。');
mkdirSync(workBase, { recursive: true }); const root = mkdtempSync(path.join(workBase, 'chat-live-claude-'));
const reportFile = path.join(root, 'evidence.json'); const publicFile = path.join(root, 'public.txt'); writeFileSync(publicFile, 'PUBLIC_READ_OK');
const bridgePath = fileURLToPath(new URL('../src/chat/mcp-bridge.mjs', import.meta.url));
const chatId = `live-${randomUUID()}`, invocationId = `inv-${randomUUID()}`, bridgeSecret = randomBytes(32).toString('hex');
const token = createHmac('sha256', bridgeSecret).update(`${chatId}\n${invocationId}`).digest('hex');
const events: unknown[] = []; const hostCalls: { name: string; args: unknown }[] = []; let toolCount = 0;
const clean = scrubEnv(process.env, ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'CURSOR_API_KEY', 'XAI_API_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']).env;
const command = resolveCommand('claude', { override: { command: cli, args: [] } }); if (!command) throw new Error('无法解析固定 Claude CLI。');
const claudeCommand = command;
function keepEvent(line: string) { try { const value = JSON.parse(line); events.push(value); if (events.length > 80) events.shift(); return value as any; } catch { events.push({ malformed: line.slice(0, 500) }); return null; } }
async function mcpBoundary(env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [bridgePath], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false }); const lines = createInterface({ input: child.stdout }); let next = 1;
  const call = (method: string, params: unknown) => new Promise<any>((resolve, reject) => { const id = next++; const timer = setTimeout(() => reject(new Error('MCP response timeout')), 10_000); const onLine = (line: string) => { try { const value = JSON.parse(line); if (value.id !== id) return; clearTimeout(timer); lines.off('line', onLine); resolve(value); } catch { /* ignore malformed bridge output */ } }; lines.on('line', onLine); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  try {
    const init = await call('initialize', { protocolVersion: '2024-11-05' }); const list = await call('tools/list', {});
    const good = await call('tools/call', { name: 'read', arguments: { path: 'public.txt' } });
    const invalid: Record<string, boolean> = {};
    for (const [label, argumentsValue] of Object.entries({ outside: { path: '../outside.txt' }, fakeAuth: { path: 'fake-auth.txt' }, url: { path: 'public.txt', url: 'http://127.0.0.1/' }, write: { path: 'public.txt', text: 'x' }, command: { path: 'public.txt', executable: process.execPath, args: ['--version'] } })) { const value = await call('tools/call', { name: 'read', arguments: argumentsValue }); invalid[label] = value.result?.isError === true; }
    for (const name of ['Bash', 'Write', 'network', 'spawn']) { const value = await call('tools/call', { name, arguments: {} }); invalid[`unknown:${name}`] = value.error?.code === -32601; }
    return { init: Boolean(init.result), advertisedTools: list.result?.tools?.map((tool: any) => tool.name) ?? null, positiveRead: good.result?.content?.[0]?.text === 'PUBLIC_READ_OK', invalid };
  } finally { lines.close(); child.stdin.end(); child.kill(); }
}
async function main() {
  const server = createServer((req, res) => {
    const expectedPath = `/internal/chat-tools/${chatId}/${invocationId}`;
    if (req.url !== expectedPath) { res.writeHead(404); res.end(); return; }
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); res.end(); return; }
    let raw = ''; req.setEncoding('utf8'); req.on('data', value => { raw += value; if (raw.length > 16_384) req.destroy(); });
    req.on('end', () => { try {
      const body = JSON.parse(raw); const argumentsValue = body?.arguments; if (body?.name !== 'read' || !argumentsValue || Object.keys(argumentsValue).length !== 1 || argumentsValue.path !== 'public.txt' || ++toolCount > 12) { res.writeHead(403); res.end(); return; }
      hostCalls.push({ name: body.name, args: body.arguments }); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ text: readFileSync(publicFile, 'utf8') }));
    } catch { res.writeHead(400); res.end(); } });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('无法创建 loopback MCP host。');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const negative = { wrongBearer: false, wrongInvocation: false };
  try { negative.wrongBearer = (await fetch(`${baseUrl}/internal/chat-tools/${chatId}/${invocationId}`, { method: 'POST', headers: { authorization: 'Bearer wrong' } })).status === 401; negative.wrongInvocation = (await fetch(`${baseUrl}/internal/chat-tools/${chatId}/wrong`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })).status === 404; } catch { /* remains false */ }
  const mcp = JSON.stringify({ mcpServers: { workbench: { command: process.execPath, args: [bridgePath] } } });
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--model', model, '--effort', effort, '--restricted', '--strict-mcp-config', '--mcp-config', mcp, '--tools', '', '--allowedTools', 'mcp__workbench__read', '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--no-session-persistence', '--no-chrome', '--disable-slash-commands'];
  const env = { ...clean, CHAT_BRIDGE_URL: baseUrl, CHAT_BRIDGE_TOKEN: token, CHAT_BRIDGE_CHAT: chatId, CHAT_BRIDGE_INVOCATION: invocationId, CHAT_BRIDGE_TOOLS: JSON.stringify([{ name: 'read', description: 'Read only public probe text.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }]) };
  if (negativeOnly) {
    const boundary = await mcpBoundary(env); const report = { checkedAt: new Date().toISOString(), mode: 'negative-only', realModelCalls: 2, root: '<disposable configured work root>', negative, boundary, mechanism: { cliAdvertisedTable: 'not queried in negative-only mode; prior live init must be consulted separately', bridgeAdvertisedTable: boundary.advertisedTools, hostOrigin: 'not exercised by this independent loopback bridge fixture; production HTTP route tests own this boundary', expiredInvocation: negative.wrongInvocation }, proofGenerated: false };
    const temp = `${reportFile}.${process.pid}.tmp`; writeFileSync(temp, JSON.stringify(report, null, 2), { mode: 0o600 }); renameSync(temp, reportFile); console.log(JSON.stringify({ reportFile, mode: 'negative-only', boundary, realModelCalls: 2 }, null, 2)); await new Promise<void>(resolve => server.close(() => resolve())); return;
  }
  const normal = await runProcess(claudeCommand, args, { cwd: root, env, stdinText: 'Use the workbench MCP read tool exactly once with path public.txt. Reply with exactly the returned text, then stop.', timeoutMs: 14 * 60_000, onStdoutLine: keepEvent });
  const init = events.find((value: any) => value?.type === 'system' && value?.subtype === 'init') as any;
  const normalEvidence = { exitCode: normal.exitCode, cancelled: normal.cancelled, timedOut: normal.timedOut, exitUnknown: Boolean(normal.terminationWarning), initTools: init?.tools ?? null, initMcp: init?.mcp_servers ?? null, hostCalls, textSeen: events.some((value: any) => JSON.stringify(value).includes('PUBLIC_READ_OK')) };
  const cancelEvents: unknown[] = []; const abort = new AbortController(); let started = false;
  const cancellation = await runProcess(claudeCommand, args, { cwd: root, env, stdinText: 'Use the workbench MCP read tool with public.txt and continue until stopped.', timeoutMs: 14 * 60_000, signal: abort.signal, onStdoutLine: line => { const value = keepEvent(line); cancelEvents.push(value); if (!started && value?.type === 'system' && value?.subtype === 'init') { started = true; abort.abort(); } } });
  const report = { checkedAt: new Date().toISOString(), cli, model, effort, root: '<disposable configured work root>', negative, normal: normalEvidence, cancellation: { started, cancelled: cancellation.cancelled, timedOut: cancellation.timedOut, exitUnknown: Boolean(cancellation.terminationWarning), eventCount: cancelEvents.length }, boundedEvents: events.slice(-80), proofGenerated: false };
  const temp = `${reportFile}.${process.pid}.tmp`; writeFileSync(temp, JSON.stringify(report, null, 2), { mode: 0o600 }); renameSync(temp, reportFile); console.log(JSON.stringify({ reportFile, normal: normalEvidence, cancellation: report.cancellation, proofGenerated: false }, null, 2));
  await new Promise<void>(resolve => server.close(() => resolve()));
}
main().catch(error => { console.error(`Claude live probe failed: ${(error as Error).message}`); process.exitCode = 1; });
