import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import { renderMarkdown, renderStandaloneHtml } from '../core/doc-model.js';
import { buildDocModel } from '../core/docs.js';
import { renderDecisionRecord } from '../core/report.js';
import type { Run, ValidationJob } from '../core/types.js';
import { HttpError } from '../orchestrator/errors.js';

const OMIT = new Set(['.git', '.venv', 'venv', 'node_modules', 'pip-cache', 'npm-cache', '.npm', '.pnpm-store', '__pycache__', '.cache', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', '.workbench-references', '.codex', '.claude', '.aws', '.ssh']);
const MAX_FILES = 20_000;
const MAX_ZIP_BYTES = 0xffffffff;
export interface DeliveryFile { path: string; size: number }
export interface DeliveryInventory {
  jobId: string; workspaceDir: string; available: boolean; files: DeliveryFile[]; warnings: string[];
  incomplete: boolean;
}

function omitted(name: string): boolean {
  const lower = name.toLowerCase();
  return OMIT.has(lower) || /\.(pyc|pyo)$/i.test(name)
    || (/^\.env(?:\.|$)/i.test(name) && !/^\.env\.(example|sample|template)$/i.test(name));
}

/** Download paths are relative to the recorded job, never arbitrary local paths. */
function artifactPath(job: ValidationJob, relative: string): string {
  if (!relative || relative.length > 4096 || /[\\:\x00-\x1f\x7f]/.test(relative)
    || relative.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || omitted(part))) {
    throw new HttpError(400, '文件路径无效，或属于不提供下载的依赖、缓存或私密配置。');
  }
  return path.join(workspaceRoot(job), ...relative.split('/'));
}

function workspaceRoot(job: ValidationJob): string {
  const root = path.resolve(job.workspaceDir);
  if (!path.isAbsolute(job.workspaceDir) || path.basename(root) !== job.id || path.basename(path.dirname(root)) !== job.runId) {
    throw new HttpError(403, '作业工作区路径无效。');
  }
  return root;
}

async function noLinks(target: string): Promise<void> {
  const { root } = path.parse(target);
  let current = root;
  for (const part of target.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new HttpError(403, '不提供符号链接或目录联接中的文件。');
  }
}

function fileError(error: unknown): never {
  if (error instanceof HttpError) throw error;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT' || code === 'ENOTDIR') throw new HttpError(404, '工作区或文件已不存在。');
  if (code === 'EACCES' || code === 'EPERM') throw new HttpError(403, '没有读取工作区文件的权限。');
  throw error;
}

export async function listDeliverables(job: ValidationJob): Promise<DeliveryInventory> {
  const result: DeliveryInventory = { jobId: job.id, workspaceDir: job.workspaceDir, available: false, files: [], warnings: [], incomplete: false };
  try {
    const root = workspaceRoot(job);
    await noLinks(root);
    if (!(await lstat(root)).isDirectory()) throw new HttpError(404, '工作区不是目录。');
    result.available = true;
    let skippedLinks = 0;
    const walk = async (directory: string, prefix: string, depth: number): Promise<void> => {
      if (depth > 64 || result.files.length >= MAX_FILES) { result.incomplete = true; return; }
      await noLinks(directory);
      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
      for (const entry of entries) {
        if (omitted(entry.name)) continue;
        const relative = `${prefix}${entry.name}`;
        // Apply exactly the same path policy to the inventory and downloads.
        const absolute = artifactPath(job, relative);
        const stat = await lstat(absolute);
        if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) { skippedLinks++; continue; }
        if (stat.isDirectory()) await walk(absolute, `${relative}/`, depth + 1);
        else if (stat.isFile()) result.files.push({ path: relative, size: stat.size });
        if (result.files.length >= MAX_FILES) { result.incomplete = true; break; }
      }
    };
    await walk(root, '', 0);
    if (skippedLinks) result.warnings.push(`已跳过 ${skippedLinks} 个链接文件或目录。`);
    if (result.incomplete) result.warnings.push('文件清单超过展示上限，无法生成完整交付包；请从本机工作区取用完整文件。');
  } catch (error) {
    result.incomplete = true;
    result.warnings.push(error instanceof HttpError ? error.message : '工作区缺失、无权读取或文件正在变化，请刷新后重试。');
  }
  return result;
}

export async function openArtifact(job: ValidationJob, relative: string): Promise<{ file: FileHandle; size: number }> {
  let file: FileHandle | undefined;
  try {
    const target = artifactPath(job, relative);
    await noLinks(target);
    // Windows 8.3 aliases (e.g. VENV~1) must pass the policy under their long names too.
    const root = await realpath(workspaceRoot(job));
    const canonical = await realpath(target);
    const canonicalRelative = path.relative(root, canonical);
    if (path.isAbsolute(canonicalRelative) || canonicalRelative === '..' || canonicalRelative.startsWith(`..${path.sep}`)) {
      throw new HttpError(403, '文件不在作业工作区内。');
    }
    artifactPath(job, canonicalRelative.split(path.sep).join('/'));
    await noLinks(canonical);
    file = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink > 1) throw new HttpError(403, '仅提供工作区内的普通文件。');
    return { file, size: stat.size };
  } catch (error) {
    await file?.close();
    return fileError(error);
  }
}

interface ZipEntry { name: string; size: number; content?: Buffer; source?: string }

/** ZIP32, stored entries: stream large installers without buffering or spawning a shell. */
export async function deliveryArchive(run: Run, job: ValidationJob, targetPlatform: string): Promise<{ size: number; stream: AsyncGenerator<Buffer> }> {
  if (['queued', 'preparing', 'running', 'verifying', 'evaluating', 'final_review'].includes(job.status)
    || run.tasks.some(task => job.taskIds.includes(task.id) && task.status === 'running')) {
    throw new HttpError(409, '作业仍在构建，请完成后下载交付包。');
  }
  const inventory = await listDeliverables(job);
  if (!inventory.available) throw new HttpError(404, inventory.warnings.join('；'));
  if (inventory.incomplete) throw new HttpError(409, inventory.warnings.join('；'));
  const entries: ZipEntry[] = inventory.files.map(file => ({ name: `workspace/${file.path}`, size: file.size, source: file.path }));
  const add = (name: string, text: string) => { const content = Buffer.from(text, 'utf8'); entries.push({ name, size: content.length, content }); };
  add('交付说明.md', [
    `# ${run.title} · 现有成果交付`, '',
    `运行：${run.id}；作业：${job.id}；模式：${run.mode === 'mock' ? '模拟数据（不是真实模型产出）' : '真实运行'}`, '',
    `作业状态：${job.status}；日志核验：${job.verification?.verdict ?? '尚无核验结果'}。`,
    '流程结束、已接受候选和验收通过是不同的状态；下载不会改变验收结果。', '',
    'workspace/ 保留源码、现有安装包、资料和项目内执行证据；从其中的 README 或 docs/ 使用说明开始。',
    '交付记录/ 包含决策记录、MVP 规格、模型报告、日志核验结果和人工验收结果。',
    '项目文档/ 保留已生成的各版本 Markdown 和 HTML，确认、草稿和历史状态写在文档中。', '',
    '不含 .git、虚拟环境、node_modules、缓存、.env 私密配置、上传资料副本及链接文件。依赖按项目说明重新安装；原始上传资料仍保存在工作台 data/reference-uploads/。',
    ...inventory.warnings, '',
    job.report?.summary ?? '尚未生成构建报告。', '',
    ...(['setup', 'run', 'test'] as const).flatMap(key => [`## ${{ setup: '准备环境', run: '运行方法', test: '验收方法' }[key]}`, ...(job.report?.howToRun[key] ?? ['尚未记录。']).map(text => `- ${text}`), '']),
  ].join('\n'));
  add('交付记录/decision.md', renderDecisionRecord(run));
  add('交付记录/validation.json', JSON.stringify({ runId: run.id, mode: run.mode, finalChoice: run.finalChoice, job }, null, 2));
  for (const version of run.docs.versions) {
    const model = buildDocModel(run, version, { targetPlatform });
    add(`项目文档/${version.kind}-v${version.version}.md`, renderMarkdown(model));
    add(`项目文档/${version.kind}-v${version.version}.html`, renderStandaloneHtml(model));
  }
  const size = 22 + entries.reduce((total, entry) => total + 30 + 46 + 16 + 2 * Buffer.byteLength(entry.name, 'utf8') + entry.size, 0);
  if (entries.length >= 65535 || size >= MAX_ZIP_BYTES || entries.some(entry => Buffer.byteLength(entry.name, 'utf8') > 65535)) {
    throw new HttpError(413, '交付包超过 ZIP32 的 4 GiB 或文件数量上限，请从本机工作区取用。');
  }
  async function* stream(): AsyncGenerator<Buffer> {
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const entry of entries) {
      const name = Buffer.from(entry.name, 'utf8');
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4);
      header.writeUInt16LE(0x0808, 6); header.writeUInt16LE(33, 12); header.writeUInt16LE(name.length, 26);
      yield header; yield name;
      let checksum = 0;
      let bytes = 0;
      if (entry.content) { checksum = crc32(entry.content); bytes = entry.content.length; yield entry.content; }
      else {
        const { file, size: currentSize } = await openArtifact(job, entry.source!);
        try {
          if (currentSize !== entry.size) throw new HttpError(409, '打包期间文件发生变化，请刷新后重试。');
          const before = await file.stat();
          for await (const data of file.createReadStream({ autoClose: false })) {
            const chunk = data as Buffer;
            bytes += chunk.length;
            if (bytes > entry.size) throw new HttpError(409, '打包期间文件发生变化。');
            checksum = crc32(chunk, checksum); yield chunk;
          }
          if ((await file.stat()).mtimeMs !== before.mtimeMs) throw new HttpError(409, '打包期间文件发生变化。');
        } finally { await file.close(); }
      }
      if (bytes !== entry.size) throw new HttpError(409, '打包期间文件发生变化。');
      const descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(0x08074b50, 0); descriptor.writeUInt32LE(checksum, 4);
      descriptor.writeUInt32LE(bytes, 8); descriptor.writeUInt32LE(bytes, 12); yield descriptor;
      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6);
      central.writeUInt16LE(0x0808, 8); central.writeUInt16LE(33, 14); central.writeUInt32LE(checksum, 16);
      central.writeUInt32LE(bytes, 20); central.writeUInt32LE(bytes, 24); central.writeUInt16LE(name.length, 28);
      // Preserve an executable bit for deployment scripts on Unix after extraction.
      central.writeUInt32LE(((entry.name.endsWith('.sh') ? 0o100755 : 0o100644) << 16) >>> 0, 38);
      central.writeUInt32LE(offset, 42); centrals.push(central, name);
      offset += header.length + name.length + bytes + descriptor.length;
    }
    const central = Buffer.concat(centrals);
    yield central;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16); yield end;
  }
  return { size, stream: stream() };
}
