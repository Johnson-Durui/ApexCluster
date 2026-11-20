import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ProjectOutputStore, PROJECT_OUTPUT_DIRECTORY } from '../src/artifacts/project-output.js';
import type { ChatCapabilityHost } from '../src/chat/capability-contract.js';
import { ChatRuntime, type WorkspaceToolHost } from '../src/chat/runtime.js';
import { SessionFiles } from '../src/chat/session-files.js';
import { ChatStore } from '../src/chat/store.js';
import type { ChatDriver, ChatRole, DriverInput } from '../src/chat/types.js';
import { WorkspaceRegistry } from '../src/chat/workspace.js';

const roles: ChatRole[] = ['claude', 'astra', 'sol', 'grok'];
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3]);
const docx = Buffer.from([80, 75, 3, 4, 68, 79, 67, 88]);
const zip = Buffer.from([80, 75, 3, 4, 90, 73, 80]);

function fixture(t: test.TestContext) {
  const work = path.join(process.cwd(), 'work');
  mkdirSync(work, { recursive: true });
  const root = mkdtempSync(path.join(work, 'project-output-integration-'));
  const project = path.join(root, 'selected project');
  mkdirSync(project);
  const registry = new WorkspaceRegistry(path.join(root, 'registry'));
  const requestId = registry.issueNativeSelectionRequest();
  const grant = registry.grantFromNativeSelection(project, requestId);
  const store = new ChatStore(path.join(root, 'sessions'));
  const projectOutputs = new ProjectOutputStore(registry);
  const files = new SessionFiles(store, projectOutputs);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, project, registry, grant, store, projectOutputs, files };
}

const outputDirectory = (project: string, chatId: string) => path.join(project, PROJECT_OUTPUT_DIRECTORY, chatId);

test('generated document, image, archive, and text artifact are copied to the selected project with durable metadata', t => {
  const f = fixture(t);
  const chat = f.store.create({ workspaceId: f.grant.id });
  const batch = f.files.publishArtifacts(chat, 'task-files', 'inv-files', [
    { name: '交付文档.docx', bytes: docx },
    { name: '示意图.png', bytes: png },
    { name: '资料包.zip', bytes: zip },
  ]);

  for (const [index, expected] of [docx, png, zip].entries()) {
    const file = batch.files[index]!;
    assert.equal(file.projectExport?.status, 'saved');
    if (file.projectExport?.status !== 'saved') throw new Error('expected saved project export');
    assert.deepEqual(readFileSync(file.projectExport.path), expected);
    assert.equal(file.projectExport.relativePath, `${PROJECT_OUTPUT_DIRECTORY}/${chat.id}/${file.name}`);
    assert.equal(file.projectExport.workspaceId, f.grant.id);
    assert.equal(file.projectExport.version, f.grant.version);
    assert.equal(file.projectExport.hash, file.hash);
    assert.deepEqual(batch.artifacts[index]?.projectExport, file.projectExport);
  }

  const text = f.files.publishTextArtifact(chat, 'task-text', 'inv-text', { name: '交付说明.md', text: '项目交付正文', kind: 'report' }, 'model');
  assert.equal(text.projectExport?.status, 'saved');
  if (text.projectExport?.status !== 'saved') throw new Error('expected saved text export');
  assert.equal(readFileSync(text.projectExport.path, 'utf8'), '项目交付正文');

  const upload = f.files.upload(chat, { name: '用户上传.txt', base64: Buffer.from('input').toString('base64'), clientUploadId: 'upload-1' });
  assert.equal(upload.projectExport, undefined);
  assert.equal(existsSync(path.join(outputDirectory(f.project, chat.id), upload.name)), false);

  const restored = new ChatStore(path.join(f.root, 'sessions')).get(chat.id);
  assert.deepEqual(restored.attachments?.map(file => file.projectExport), chat.attachments?.map(file => file.projectExport));
  assert.deepEqual(restored.artifacts.map(artifact => artifact.projectExport), chat.artifacts.map(artifact => artifact.projectExport));

  const noProject = f.store.create();
  const localOnly = f.files.publish(noProject, 'task-local', 'inv-local', [{ name: '仅下载.txt', bytes: Buffer.from('local') }])[0]!;
  assert.equal(localOnly.projectExport, undefined);
  assert.equal(existsSync(outputDirectory(f.project, noProject.id)), false);
  assert.equal(f.files.read(noProject, localOnly.id).bytes.toString(), 'local');
});

test('an occupied agent-outputs path records a failed export while preserving the session download', t => {
  const f = fixture(t);
  writeFileSync(path.join(f.project, PROJECT_OUTPUT_DIRECTORY), 'occupied');
  const chat = f.store.create({ workspaceId: f.grant.id });
  const file = f.files.publishArtifacts(chat, 'task', 'inv', [{ name: '仍可下载.png', bytes: png }]).files[0]!;

  assert.equal(file.projectExport?.status, 'failed');
  if (file.projectExport?.status !== 'failed') throw new Error('expected failed project export');
  assert.match(file.projectExport.error, /EEXIST|exist|目录|文件/i);
  assert.deepEqual(f.files.read(chat, file.id).bytes, png);
  assert.equal(chat.artifacts[0]?.projectExport?.status, 'failed');
  assert.equal(new ChatStore(path.join(f.root, 'sessions')).get(chat.id).attachments?.[0]?.projectExport?.status, 'failed');
});

test('a failed session save rolls back the whole generated batch without overwriting an existing project file', t => {
  const f = fixture(t);
  const chat = f.store.create({ workspaceId: f.grant.id });
  const directory = outputDirectory(f.project, chat.id);
  mkdirSync(directory, { recursive: true });
  const existing = path.join(directory, '报告.txt');
  writeFileSync(existing, '用户已有内容');
  const originalSave = f.store.save.bind(f.store);
  f.store.save = () => { throw new Error('fixture session save failed'); };

  assert.throws(() => f.files.publishArtifacts(chat, 'task', 'inv', [
    { name: '报告.txt', bytes: Buffer.from('新报告') },
    { name: '新文件.txt', bytes: Buffer.from('新文件') },
  ]), /fixture session save failed/);
  f.store.save = originalSave;

  assert.equal(readFileSync(existing, 'utf8'), '用户已有内容');
  assert.deepEqual(readdirSync(directory), ['报告.txt']);
  assert.equal(chat.attachments, undefined);
  assert.deepEqual(chat.artifacts, []);
  const sessionOutputs = path.join(f.store.sessionDirectory(chat.id), 'outputs');
  assert.deepEqual(readdirSync(sessionOutputs), []);
  assert.deepEqual(f.store.get(chat.id).artifacts, []);
});

function runtimeFixture(
  t: test.TestContext,
  invoke: (input: DriverInput) => Promise<{ text: string; exitConfirmed: boolean }>,
  capabilities?: ChatCapabilityHost,
) {
  const f = fixture(t);
  const drivers = Object.fromEntries(roles.map(role => [role, { capability: { role, available: true, isolationVerified: true }, invoke }])) as Record<ChatRole, ChatDriver>;
  const workspace: WorkspaceToolHost = {
    definitions: [],
    assertWorkspace: (id, version) => f.registry.assert(id, version),
    call: async () => { throw new Error('workspace tool is not used by this fixture'); },
  };
  const runtime = new ChatRuntime({ store: f.store, drivers, workspace, capabilities, projectOutputs: f.projectOutputs });
  return { ...f, runtime };
}

test('runtime exports session_file_write, capability binary, and artifact_publish results, but never a cancelled late result', async t => {
  const capability: ChatCapabilityHost = {
    definitions: () => [{ name: 'document_test', description: 'deterministic binary fixture', inputSchema: { type: 'object' } }],
    status: async () => [],
    call: async () => ({ text: 'binary ready', files: [{ name: '能力图片.png', bytes: png }] }),
  };
  const f = runtimeFixture(t, async input => {
    await input.callTool('session_file_write', { name: '会话记录.txt', text: 'session file body' });
    await input.callTool('document_test', {});
    await input.callTool('artifact_publish', { name: '模型报告.md', text: 'artifact body', kind: 'report' });
    return { text: '完成', exitConfirmed: true };
  }, capability);
  const chat = f.runtime.create({ workspaceId: f.grant.id });
  f.runtime.send(chat.id, { text: '生成三类产物', clientMessageId: 'm1' });
  await f.runtime.idle();

  const directory = outputDirectory(f.project, chat.id);
  assert.equal(readFileSync(path.join(directory, '会话记录.txt'), 'utf8'), 'session file body');
  assert.deepEqual(readFileSync(path.join(directory, '能力图片.png')), png);
  assert.equal(readFileSync(path.join(directory, '模型报告.md'), 'utf8'), 'artifact body');
  assert.equal(chat.attachments?.every(file => file.projectExport?.status === 'saved'), true);
  assert.equal(chat.artifacts.every(artifact => artifact.projectExport?.status === 'saved'), true);

  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { started = resolve; });
  const late = runtimeFixture(t, async input => {
    try { await input.callTool('document_test', {}); } catch { /* Cancellation is the expected tool outcome. */ }
    return { text: 'late', exitConfirmed: true };
  }, {
    definitions: capability.definitions,
    status: async () => [],
    call: async () => { started(); await gate; return { text: 'late', files: [{ name: '迟到结果.zip', bytes: zip }] }; },
  });
  const cancelled = late.runtime.create({ workspaceId: late.grant.id });
  late.runtime.send(cancelled.id, { text: '开始后取消', clientMessageId: 'm2' });
  await ready;
  late.runtime.cancel(cancelled.id);
  release();
  await late.runtime.idle();
  assert.equal(cancelled.tasks[0]?.status, 'cancelled');
  assert.equal(cancelled.attachments?.length ?? 0, 0);
  assert.equal(cancelled.artifacts.length, 0);
  assert.equal(existsSync(outputDirectory(late.project, cancelled.id)), false);
});

test('task completion verifies real project copies while keeping every session download readable', async t => {
  let failedCompletion: { accepted?: boolean; issues?: string[] } | undefined;
  const occupied = runtimeFixture(t, async input => {
    const generated = await input.callTool('session_file_write', { name: '目录故障.txt', text: 'session copy survives' });
    const file = (generated.data as { files: { id: string }[] }).files[0]!;
    assert.equal(JSON.parse((await input.callTool('session_file_read', { fileId: file.id })).text).text, 'session copy survives');
    failedCompletion = (await input.callTool('task_complete', { result: 'should be blocked' })).data as typeof failedCompletion;
    return { text: 'blocked as expected', exitConfirmed: true };
  });
  writeFileSync(path.join(occupied.project, PROJECT_OUTPUT_DIRECTORY), 'occupied by a regular file');
  const occupiedChat = occupied.runtime.create({ workspaceId: occupied.grant.id });
  occupied.runtime.send(occupiedChat.id, { text: '生成但项目目录不可用', clientMessageId: 'completion-failed' });
  await occupied.runtime.idle();
  assert.equal(failedCompletion?.accepted, false);
  assert.ok(failedCompletion?.issues?.some(issue => issue.includes('未成功保存到所选项目')));
  assert.notEqual(occupiedChat.tasks[0]?.status, 'completed');
  const failedFile = occupiedChat.attachments![0]!;
  assert.equal(failedFile.projectExport?.status, 'failed');
  assert.equal(occupied.runtime.files.read(occupiedChat, failedFile.id).bytes.toString(), 'session copy survives');

  let tamperedCompletion: { accepted?: boolean; issues?: string[] } | undefined;
  const tampered = runtimeFixture(t, async input => {
    const generated = await input.callTool('session_file_write', { name: '篡改检测.txt', text: 'trusted session bytes' });
    const file = (generated.data as { files: { id: string; projectExport?: { status: string; path?: string } }[] }).files[0]!;
    assert.equal(file.projectExport?.status, 'saved');
    writeFileSync(file.projectExport!.path!, 'tampered project bytes');
    assert.equal(JSON.parse((await input.callTool('session_file_read', { fileId: file.id })).text).text, 'trusted session bytes');
    tamperedCompletion = (await input.callTool('task_complete', { result: 'should detect tampering' })).data as typeof tamperedCompletion;
    return { text: 'tamper blocked as expected', exitConfirmed: true };
  });
  const tamperedChat = tampered.runtime.create({ workspaceId: tampered.grant.id });
  tampered.runtime.send(tamperedChat.id, { text: '生成后核验实际副本', clientMessageId: 'completion-tampered' });
  await tampered.runtime.idle();
  assert.equal(tamperedCompletion?.accepted, false);
  assert.ok(tamperedCompletion?.issues?.some(issue => issue.includes('实际文件或授权校验失败')));
  assert.notEqual(tamperedChat.tasks[0]?.status, 'completed');
  const tamperedFile = tamperedChat.attachments![0]!;
  assert.equal(tampered.runtime.files.read(tamperedChat, tamperedFile.id).bytes.toString(), 'trusted session bytes');
  if (tamperedFile.projectExport?.status !== 'saved') throw new Error('expected saved project copy before tampering');
  assert.equal(readFileSync(tamperedFile.projectExport.path, 'utf8'), 'tampered project bytes');

  let positiveCompletion: { submitted?: boolean } | undefined;
  const positive = runtimeFixture(t, async input => {
    const generated = await input.callTool('session_file_write', { name: '正常交付.txt', text: 'verified project and session bytes' });
    const file = (generated.data as { files: { id: string }[] }).files[0]!;
    assert.equal(JSON.parse((await input.callTool('session_file_read', { fileId: file.id })).text).text, 'verified project and session bytes');
    positiveCompletion = (await input.callTool('task_complete', { result: 'verified delivery complete' })).data as typeof positiveCompletion;
    return { text: '', exitConfirmed: true };
  });
  const positiveChat = positive.runtime.create({ workspaceId: positive.grant.id });
  positive.runtime.send(positiveChat.id, { text: '正常保存并完成', clientMessageId: 'completion-positive' });
  await positive.runtime.idle();
  assert.equal(positiveCompletion?.submitted, true);
  assert.equal(positiveChat.tasks[0]?.status, 'completed');
  const positiveFile = positiveChat.attachments![0]!;
  assert.equal(positiveFile.projectExport?.status, 'saved');
  assert.equal(positive.runtime.files.read(positiveChat, positiveFile.id).bytes.toString(), 'verified project and session bytes');
  if (positiveFile.projectExport?.status !== 'saved') throw new Error('expected saved positive control');
  assert.equal(readFileSync(positiveFile.projectExport.path, 'utf8'), 'verified project and session bytes');
});
