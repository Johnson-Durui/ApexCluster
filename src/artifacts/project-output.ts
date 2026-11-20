import { createHash, randomUUID } from 'node:crypto';
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync, type Stats } from 'node:fs';
import path from 'node:path';
import type { WorkspaceRegistry } from '../chat/workspace.js';

export const PROJECT_OUTPUT_DIRECTORY = 'agent-outputs';
export interface SavedProjectOutput {
  status: 'saved'; path: string; relativePath: string; workspaceId: string; version: number; hash: string;
}
export type ProjectExport = SavedProjectOutput | { status: 'failed'; error: string };
export interface ProjectOutputInput {
  workspaceId: string; workspaceVersion?: number; chatId: string; name: string; bytes: Uint8Array;
}
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const isReparse = (info: Stats) => info.isSymbolicLink() || Boolean(((info as Stats & { fileAttributes?: number }).fileAttributes ?? 0) & 0x400);
const inside = (root: string, target: string) => {
  const relative = path.relative(root, target);
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
};
function assertDirectory(root: string, directory: string) {
  const info = lstatSync(directory);
  if (!info.isDirectory() || isReparse(info) || !inside(root, realpathSync.native(directory))) throw new Error('项目输出目录包含链接或越界路径');
}
function validName(name: string, maximum = 160) {
  if (!name || name.length > maximum || /[<>:"/\\|?*\x00-\x1f\x7f]/u.test(name) || /[ .]$/u.test(name) || name !== name.trim() || name === '.' || name === '..' || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(name)) throw new Error('项目输出文件名不安全');
}

/** Copies deliverables into the current grant; existing project files are never overwritten. */
export class ProjectOutputStore {
  constructor(private readonly registry: Pick<WorkspaceRegistry, 'assert'>) {}

  save(input: ProjectOutputInput): SavedProjectOutput {
    validName(input.name);
    if (!/^[A-Za-z0-9-]{1,64}$/u.test(input.chatId)) throw new Error('聊天输出目录身份无效');
    const grant = this.registry.assert(input.workspaceId, input.workspaceVersion);
    const root = grant.path;
    assertDirectory(root, root);
    let directory = root;
    for (const segment of [PROJECT_OUTPUT_DIRECTORY, input.chatId]) {
      directory = path.join(directory, segment);
      mkdirSync(directory, { recursive: true });
      assertDirectory(root, directory);
    }
    const staging = path.join(directory, `.pending-${randomUUID()}`);
    const hash = digest(input.bytes);
    try {
      writeFileSync(staging, input.bytes, { flag: 'wx' });
      const { name, ext } = path.parse(input.name);
      for (let index = 0; index < 1000; index++) {
        this.registry.assert(input.workspaceId, grant.version);
        assertDirectory(root, path.dirname(directory));
        assertDirectory(root, directory);
        const target = path.join(directory, index ? `${name} (${index + 1})${ext}` : input.name);
        try { copyFileSync(staging, target, constants.COPYFILE_EXCL); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue; throw error; }
        if (digest(readFileSync(target)) !== hash) throw new Error('项目输出文件内容校验失败');
        return { status: 'saved', path: target, relativePath: path.relative(root, target).replaceAll('\\', '/'), workspaceId: grant.id, version: grant.version, hash };
      }
      throw new Error('同名项目输出过多，请整理输出目录');
    } finally {
      try { if (existsSync(staging)) unlinkSync(staging); } catch { /* A locked staging file must not turn a committed copy into a failed export. */ }
    }
  }

  private target(output: SavedProjectOutput): string {
    const parts = output.relativePath.split('/');
    if (parts.length !== 3 || parts[0] !== PROJECT_OUTPUT_DIRECTORY || !/^[A-Za-z0-9-]{1,64}$/u.test(parts[1]!)) throw new Error('项目输出路径无效');
    validName(parts[2]!, 200);
    const grant = this.registry.assert(output.workspaceId, output.version);
    const target = path.join(grant.path, ...parts);
    if (target !== output.path || !inside(path.join(grant.path, PROJECT_OUTPUT_DIRECTORY), target)) throw new Error('项目输出路径无效');
    assertDirectory(grant.path, grant.path);
    assertDirectory(grant.path, path.join(grant.path, PROJECT_OUTPUT_DIRECTORY));
    assertDirectory(grant.path, path.dirname(target));
    return target;
  }

  verify(output: SavedProjectOutput, expectedHash: string): void {
    if (!/^[a-f0-9]{64}$/u.test(expectedHash) || output.hash !== expectedHash) throw new Error('项目输出与登记产物哈希不一致');
    const target = this.target(output);
    const info = lstatSync(target);
    if (!info.isFile() || isReparse(info) || digest(readFileSync(target)) !== expectedHash) throw new Error('项目输出已被修改，保留现有文件');
  }

  rollback(output: SavedProjectOutput): void {
    const target = this.target(output);
    if (!existsSync(target)) return;
    const before = lstatSync(target);
    this.verify(output, output.hash);
    const after = lstatSync(target);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('项目输出在核验期间发生变化，保留现有文件');
    unlinkSync(target);
  }
}
