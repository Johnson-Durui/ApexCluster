import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { ChatDriverError } from '../src/chat/drivers.js';
import { ChatRuntime, type WorkspaceToolHost } from '../src/chat/runtime.js';
import { ChatStore } from '../src/chat/store.js';
import { HttpError } from '../src/orchestrator/errors.js';
import type { ChatDriver, ChatRole, DriverInput, DriverResult, ToolReply } from '../src/chat/types.js';

const roles: ChatRole[] = ['claude', 'astra', 'sol', 'grok'];
const result = (text = 'done'): DriverResult => ({ text, exitConfirmed: true });
const json = <T>(reply: ToolReply): T => reply.data as T;
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
function page(reply: ToolReply) {
  const match = /^\[程序分页 offset=(\d+) next=(\d+|null)\]\n/.exec(reply.text); assert.ok(match, 'result_read exposes offset and next in text');
  return { offset: Number(match[1]), next: match[2] === 'null' ? null : Number(match[2]), body: reply.text.slice(match[0].length) };
}

function fixture(t: TestContext, invoke: (role: ChatRole, input: DriverInput) => Promise<DriverResult>, workspace?: WorkspaceToolHost) {
  const workRoot = path.join(process.cwd(), 'work'); mkdirSync(workRoot, { recursive: true });
  const root = mkdtempSync(path.join(workRoot, 'chat-evidence-'));
  t.after(() => { if (path.dirname(root) !== workRoot || !path.basename(root).startsWith('chat-evidence-')) throw new Error(`unsafe cleanup ${root}`); rmSync(root, { recursive: true, force: true }); });
  const driverErrors: unknown[] = [];
  const drivers = Object.fromEntries(roles.map(role => [role, { capability: { role, available: true, isolationVerified: true }, invoke: async (input: DriverInput) => { try { return await invoke(role, input); } catch (error) { driverErrors.push(error); throw new ChatDriverError(error instanceof Error ? error.message : String(error), true); } } } satisfies ChatDriver])) as Record<ChatRole, ChatDriver>;
  return { runtime: new ChatRuntime({ store: new ChatStore(path.join(root, 'store')), drivers, workspace, handoffMs: 10 }), driverErrors };
}

test('parent discovers and reads small child write and runner receipts without catalog self-growth', async (t) => {
  const writeReceipt = JSON.stringify({ created: true, path: 'tiny.txt' });
  const failedTestReceipt = JSON.stringify({ ok: false, result: { exitCode: 7, stderrTail: 'FAIL' } });
  const testReceipt = JSON.stringify({ ok: true, result: { exitCode: 0, stdoutTail: 'PASS' } });
  const tickets = new Map<string, { ticketId: string; ok: boolean }>(); let submittedTests = 0; let failedTicketId = ''; let runtime!: ChatRuntime; const segments = new Map<string, number>(); let childId = '';
  const workspace: WorkspaceToolHost = {
    definitions: [
      { name: 'file_write', description: 'write', inputSchema: {} },
      { name: 'test_submit', description: 'test', inputSchema: {} },
    ],
    assertWorkspace: () => ({ version: 1 }),
    call: async (name, _args, identity) => {
      if (name === 'file_write') return { text: writeReceipt, data: JSON.parse(writeReceipt) };
      if (name === 'test_submit') { const ticketId = `runner-${randomUUID()}`; const ok = ++submittedTests > 1; if (!ok) failedTicketId = ticketId; tickets.set(identity.invocation.id, { ticketId, ok }); return { text: 'queued', stop: 'wait', ticketId }; }
      throw new Error(`unexpected workspace tool ${name}`);
    },
    afterInvocation: async identity => {
      const ticket = tickets.get(identity.invocation.id); if (!ticket) return [];
      tickets.delete(identity.invocation.id); const text = ticket.ok ? testReceipt : failedTestReceipt;
      return [{ ticketId: ticket.ticketId, reply: { text, data: JSON.parse(text), processExitConfirmed: true } }];
    },
  };
  const f = fixture(t, async (role, input) => {
    const segment = (segments.get(input.task.id) ?? 0) + 1; segments.set(input.task.id, segment);
    if (role === 'grok') {
      if (segment === 1) {
        await input.callTool('file_write', { path: 'tiny.txt', text: 'tiny', expectedHash: null });
        await input.callTool('test_submit', { executable: 'fixed-test', args: [] });
        return result('waiting');
      }
      if (segment === 2) { await input.callTool('test_submit', { executable: 'fixed-test', args: [] }); return result('waiting'); }
      const note = await input.callTool('artifact_publish', { name: 'child-note.txt', text: 'model note', kind: 'report' });
      assert.equal(page(await input.callTool('result_read', { ref: (note.data as { relativePath: string }).relativePath, offset: 0 })).body, 'model note');
      await input.callTool('task_complete', { result: 'child done' }); return result();
    }
    if (segment === 1) {
      const submitted = json<Array<{ taskId: string }>>(await input.callTool('grok_submit', { tasks: [{ goal: 'produce evidence', mode: 'edit' }] })); childId = submitted[0]!.taskId;
      await input.callTool('grok_collect', { wait: true }); return result('waiting');
    }
    const before = runtime.get(input.chatId).toolResults?.length ?? 0;
    const catalog = json<{ entries: Array<Record<string, unknown>>; total: number; next: number | null }>(await input.callTool('task_evidence', { taskId: childId }));
    const tools = catalog.entries.filter(entry => entry.kind === 'tool');
    const write = tools.find(entry => entry.name === 'file_write')!; assert.equal(catalog.entries[0], write); assert.equal(write.toolNumber, 1);
    assert.equal(write.hash, sha256(writeReceipt)); assert.equal(write.bytes, Buffer.byteLength(writeReceipt));
    assert.equal(write.invocationId, runtime.get(input.chatId).tasks.find(task => task.id === childId)!.invocationIds[0]);
    const testEntry = catalog.entries.find(entry => entry.kind === 'test')!;
    assert.equal(catalog.entries.filter(entry => entry.kind === 'test').length, 1, 'failed safe test is not promoted as verified evidence');
    assert.equal(testEntry.name, 'test_submit'); assert.equal(testEntry.provenance, 'runner'); assert.equal(testEntry.hash, sha256(testReceipt)); assert.equal(testEntry.bytes, Buffer.byteLength(testReceipt));
    assert.equal(testEntry.status, 'resolved'); assert.equal(testEntry.processStatus, 'exited'); assert.match(String(testEntry.externalId), /^runner-/);
    assert.equal(catalog.entries.some(entry => entry.kind === 'artifact' && entry.provenance === 'runner'), false, 'runner artifact duplicate stays out of the catalog');
    const artifact = catalog.entries.find(entry => entry.kind === 'artifact' && entry.name === 'child-note.txt')!;
    assert.equal(artifact.artifactKind, 'report'); assert.equal(artifact.provenance, 'model');
    const writeRead = page(await input.callTool('result_read', { ref: write.ref, offset: 0 })); assert.equal(writeRead.body, writeReceipt); assert.equal(writeRead.next, null);
    const testRead = page(await input.callTool('result_read', { ref: testEntry.ref, offset: 0 })); assert.equal(testRead.body, testReceipt); assert.equal(testRead.next, null);
    const testTicket = runtime.get(input.chatId).tickets.find(ticket => ticket.resultRef === testEntry.ref)!;
    testTicket.processStatus = 'exit_unknown';
    await assert.rejects(input.callTool('result_read', { ref: testEntry.ref, offset: 0 }), error => error instanceof HttpError && error.status === 403);
    testTicket.processStatus = 'exited';
    const childArtifactRead = page(await input.callTool('result_read', { ref: artifact.ref, offset: 0 })); assert.equal(childArtifactRead.body, 'model note', 'parent gets its own first read even after the child read the page');
    const childArtifactRepeat = await input.callTool('result_read', { ref: artifact.ref, offset: 0 }); assert.equal((childArtifactRepeat.data as any).alreadyProvided, true); assert.doesNotMatch(childArtifactRepeat.text, /model note/);
    const failedTicket = runtime.get(input.chatId).tickets.find(ticket => ticket.externalId === failedTicketId)!;
    assert.equal(failedTicket.status, 'resolved'); assert.equal(failedTicket.processStatus, 'exited');
    assert.equal(runtime.get(input.chatId).toolResults?.some(record => record.ref === failedTicket.resultRef), false, 'ok=false runner receipt is not indexed as successful evidence');
    assert.equal(page(await input.callTool('result_read', { ref: failedTicket.resultRef, offset: 0 })).body, failedTestReceipt, 'safe failed runner receipt remains readable for diagnosis');
    assert.equal(runtime.get(input.chatId).toolResults?.length ?? 0, before, 'catalog and result_read must not index themselves');
    await input.callTool('grok_disposition', { taskId: childId, disposition: 'reference' });
    await input.callTool('task_complete', { result: 'parent done' }); return result();
  }, workspace); runtime = f.runtime;
  const chat = runtime.create({ workspaceId: 'workspace' }); runtime.send(chat.id, { text: 'collect evidence', clientMessageId: '1' }); await runtime.idle();
  assert.deepEqual(f.driverErrors, []); assert.equal(chat.tasks[0]?.status, 'completed');
});

test('evidence scope, bounded pagination, and legacy tool records remain safe', async (t) => {
  let runtime!: ChatRuntime; let foreignTaskId = ''; let siblingDenied = false; const segments = new Map<string, number>();
  const f = fixture(t, async (role, input) => {
    const segment = (segments.get(input.task.id) ?? 0) + 1; segments.set(input.task.id, segment);
    if (role === 'grok') {
      const tasks = runtime.get(input.chatId).tasks;
      if (input.task.goal === 'sibling') {
        const owner = tasks.find(task => task.goal === 'owner')!;
        await assert.rejects(input.callTool('task_evidence', { taskId: owner.id }), error => { siblingDenied = error instanceof HttpError && error.status === 403; return siblingDenied; });
      }
      await input.callTool('task_complete', { result: input.task.goal }); return result();
    }
    if (input.task.goal === 'foreign') { await input.callTool('task_complete', { result: 'foreign done' }); return result(); }
    if (segment === 1) { await input.callTool('grok_submit', { tasks: [{ goal: 'owner' }, { goal: 'sibling' }] }); await input.callTool('grok_collect', { wait: true }); return result('waiting'); }
    const chat = runtime.get(input.chatId); const owner = chat.tasks.find(task => task.goal === 'owner')!;
    const legacy = runtime.store.putBlob(chat.id, 'legacy.txt', 'legacy receipt');
    (chat.toolResults ??= []).push({ taskId: owner.id, invocationId: owner.invocationIds[0]!, ref: legacy.relativePath, hash: legacy.hash, bytes: legacy.bytes } as NonNullable<typeof chat.toolResults>[number]);
    for (let index = 0; index < 30; index++) {
      const blob = runtime.store.putBlob(chat.id, `page-${index}.txt`, `page ${index}`);
      chat.artifacts.push({ id: randomUUID(), taskId: owner.id, name: `${index}-`.padEnd(150, 'x'), relativePath: blob.relativePath, hash: blob.hash, bytes: blob.bytes, kind: 'report', createdAt: new Date().toISOString(), provenance: 'model' });
    }
    const entries: Array<Record<string, unknown>> = []; let offset = 0; let total = -1;
    do {
      const reply = await input.callTool('task_evidence', { taskId: owner.id, offset, limit: 20 }); assert.ok(reply.text.length <= 4000);
      const page = json<{ entries: Array<Record<string, unknown>>; total: number; next: number | null }>(reply); total = page.total; entries.push(...page.entries); offset = page.next ?? -1;
    } while (offset >= 0);
    assert.equal(entries.length, total); assert.equal(new Set(entries.map(entry => entry.ref)).size, entries.length);
    assert.ok(entries.some(entry => entry.kind === 'tool' && entry.ref === legacy.relativePath), 'legacy record without name/toolNumber remains catalogued');
    await assert.rejects(input.callTool('task_evidence', { taskId: foreignTaskId }), error => error instanceof HttpError && error.status === 403);
    const unsafe = runtime.store.putBlob(chat.id, 'unsafe-ticket.txt', 'not confirmed');
    const unsafeTicket = { id: randomUUID(), taskId: owner.id, invocationId: owner.invocationIds[0]!, type: 'tool' as const, status: 'pending' as const, createdAt: new Date().toISOString(), externalId: 'unsafe', resultRef: unsafe.relativePath, processStatus: 'registered' as const };
    chat.tickets.push(unsafeTicket);
    chat.toolResults!.push({ taskId: owner.id, invocationId: owner.invocationIds[0]!, name: 'test_submit', provenance: 'runner', ref: unsafe.relativePath, hash: unsafe.hash, bytes: unsafe.bytes });
    await assert.rejects(input.callTool('result_read', { ref: unsafe.relativePath }), error => error instanceof HttpError && error.status === 403);
    Object.assign(unsafeTicket, { status: 'resolved', processStatus: 'exit_unknown' });
    await assert.rejects(input.callTool('result_read', { ref: unsafe.relativePath }), error => error instanceof HttpError && error.status === 403);
    const legacyRead = page(await input.callTool('result_read', { ref: legacy.relativePath })); assert.equal(legacyRead.body, 'legacy receipt'); assert.equal(legacyRead.next, null);
    for (const child of chat.tasks.filter(task => task.parentTaskId === input.task.id)) await input.callTool('grok_disposition', { taskId: child.id, disposition: 'reference' });
    await input.callTool('task_complete', { result: 'scoped' }); return result();
  }); runtime = f.runtime;
  const foreign = runtime.create({}); runtime.send(foreign.id, { text: 'foreign', clientMessageId: 'foreign' }); await runtime.idle(); foreignTaskId = foreign.tasks[0]!.id;
  const chat = runtime.create({}); runtime.send(chat.id, { text: 'scope and paginate', clientMessageId: 'main' }); await runtime.idle();
  assert.deepEqual(f.driverErrors, []); assert.equal(siblingDenied, true); assert.equal(chat.tasks[0]?.status, 'completed');
});

test('text-only result pagination preserves emoji boundaries and ignores next-like body text', async (t) => {
  const marker = 'payload says next=null and offset=999\n';
  const original = marker + 'a'.repeat(7799 - marker.length) + '😀' + 'b'.repeat(100);
  let runtime!: ChatRuntime;
  const f = fixture(t, async (_role, input) => {
    const chat = runtime.get(input.chatId); const blob = runtime.store.putBlob(chat.id, 'text-pagination.txt', original);
    (chat.toolResults ??= []).push({ taskId: input.task.id, invocationId: input.invocation.id, name: 'file_read', toolNumber: 1, provenance: 'workspace', ref: blob.relativePath, hash: blob.hash, bytes: blob.bytes });
    const before = chat.toolResults.length; const evidenceBefore = JSON.stringify(input.task.evidenceHashes);
    await input.callTool('task_evidence', {});
    const bodies: string[] = []; const offsets = new Set<number>(); let offset = 0;
    for (;;) {
      const reply = await input.callTool('result_read', { ref: blob.relativePath, offset }); assert.ok(reply.text.length <= 4000);
      const parsed = page(reply); assert.equal(parsed.offset, offset); assert.equal(offsets.has(offset), false); offsets.add(offset);
      assert.equal(/[\uD800-\uDBFF]/.test(parsed.body.at(-1) ?? ''), false, 'page must not end on a high surrogate');
      assert.equal(/[\uDC00-\uDFFF]/.test(parsed.body[0] ?? ''), false, 'page must not begin on a low surrogate');
      bodies.push(parsed.body);
      if (parsed.next === null) { assert.match(reply.text, /^\[程序分页 offset=\d+ next=null\]\n/); break; }
      offset = parsed.next;
    }
    assert.equal(offsets.size, 3); assert.equal(bodies.join(''), original);
    assert.equal(chat.toolResults.length, before); assert.equal(JSON.stringify(input.task.evidenceHashes), evidenceBefore);
    await input.callTool('task_complete', { result: 'pagination complete' }); return result();
  }); runtime = f.runtime;
  const chat = runtime.create({}); runtime.send(chat.id, { text: 'read long evidence', clientMessageId: 'long' }); await runtime.idle();
  assert.deepEqual(f.driverErrors, []); assert.equal(chat.tasks[0]?.status, 'completed');
});
