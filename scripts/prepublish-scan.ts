import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const PREPUBLISH_ALLOWLIST = 'config/prepublish-scan-whitelist.json';

const REQUIRED_VERIFICATION_MODULES = new Set([
  'docs/verification/v05-h6-report.ts',
  'docs/verification/v05-h8-evidence.ts',
  'docs/verification/v05-h8-probe.ts',
  'docs/verification/v05-h8-static-capabilities.ts',
  'docs/verification/v05-live-acceptance.ts',
  'docs/verification/v05-live-rework-acceptance.ts',
]);

export function releaseExcluded(file: string): boolean {
  const normalized = file.replaceAll('\\', '/').replace(/^\.\//, '');
  if (normalized === 'docs/TASKBOOK_V1_API_PIPELINE.md') return true;
  if (normalized.startsWith('.omx/') || normalized.startsWith('work/') || normalized.startsWith('data/')) return true;
  if (normalized.startsWith('docs/history/')) return true;
  if (normalized.startsWith('docs/plans/')) return true;
  if (normalized.startsWith('docs/screenshots/')) return true;
  if (normalized.startsWith('docs/verification/') && !REQUIRED_VERIFICATION_MODULES.has(normalized)) return true;
  return false;
}

interface ScanRule {
  id: string;
  pattern: RegExp;
}

const RULES: readonly ScanRule[] = [
  { id: 'secret.api-key', pattern: /\b(?:sk-(?:ant-|proj-|svcacct-)?[A-Za-z0-9_-]{12,}|AIza[0-9A-Za-z_-]{20,}|A(?:KIA|SIA)[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g },
  { id: 'secret.private-key', pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g },
  { id: 'local.windows-user-path', pattern: /\b[A-Za-z]:[\\/]+(?:Users|Documents and Settings)[\\/]+[^\\/\s"'<>|]+/g },
  { id: 'local.codex-work-path', pattern: /\b[A-Za-z]:[\\/]+Codex(?:[\\/]+|\b)/g },
  { id: 'local.posix-user-path', pattern: /(?:^|[\s"'=(])\/(?:Users|home)\/[A-Za-z0-9._-]+(?:\/|\b)/g },
  { id: 'personal.email', pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
  { id: 'identifier.sha256', pattern: /\bsha256:[0-9a-f]{64}\b/gi },
  { id: 'identifier.windows-sid', pattern: /\bS-1-5-21-(?:\d+-){3}\d+\b/g },
  { id: 'identifier.account', pattern: /\b(?:machineId|deviceId|hostId|installationId|subscriptionId|tenantId|accountId)\b\s*["']?\s*[:=]\s*["'][^"'\r\n]{4,}["']/gi },
];

export interface PrepublishFinding {
  rule: string;
  path: string;
  line: number;
}

interface AllowEntry {
  path: string;
  rule: string;
  lineSha256: string;
  reason: string;
}

interface ContentEntry {
  path: string;
  bytes: Buffer;
}

export interface ScanPublishingTreeOptions {
  root?: string;
  tree?: string;
  release?: boolean;
  allowlistPath?: string;
}

export interface ScanPublishingTreeResult {
  findings: PrepublishFinding[];
  scannedFiles: number;
  release: boolean;
  tree?: string;
}

function git(root: string, args: readonly string[], input?: Buffer): Buffer {
  const result = spawnSync('git', args, {
    cwd: root,
    input,
    encoding: 'buffer',
    windowsHide: true,
    maxBuffer: 512 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const message = Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8').trim() : '';
    throw new Error(`git ${args[0] ?? ''} failed${message ? `: ${message}` : ''}`);
  }
  return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.alloc(0);
}

function nulStrings(bytes: Buffer): string[] {
  return bytes.toString('utf8').split('\0').filter(Boolean);
}

function currentEntries(root: string): ContentEntry[] {
  const tracked = nulStrings(git(root, ['ls-files', '--cached', '-z']));
  const staged = new Set(nulStrings(git(root, ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'])));
  const entries: ContentEntry[] = [];
  for (const file of tracked) {
    const absolute = path.join(root, ...file.split('/'));
    if (existsSync(absolute) && !lstatSync(absolute).isDirectory() && !lstatSync(absolute).isSymbolicLink()) {
      entries.push({ path: file, bytes: readFileSync(absolute) });
    } else if (!staged.has(file)) {
      try { entries.push({ path: file, bytes: git(root, ['show', `:${file}`]) }); } catch { /* unstaged deletion */ }
    }
    if (staged.has(file)) entries.push({ path: file, bytes: git(root, ['show', `:${file}`]) });
  }
  return entries;
}

function treeEntries(root: string, requested: string): { tree: string; entries: ContentEntry[] } {
  if (!requested || requested.startsWith('-') || /[\r\n\0]/.test(requested)) throw new Error('invalid --tree reference');
  const tree = git(root, ['rev-parse', '--verify', `${requested}^{tree}`]).toString('utf8').trim();
  const records = nulStrings(git(root, ['ls-tree', '-rz', '--full-tree', tree]));
  const objects: Array<{ hash: string; path: string }> = [];
  for (const record of records) {
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const [mode, type, hash] = record.slice(0, tab).split(' ');
    if (!mode || type !== 'blob' || !hash) continue;
    objects.push({ hash, path: record.slice(tab + 1) });
  }
  if (!objects.length) return { tree, entries: [] };
  const output = git(root, ['cat-file', '--batch'], Buffer.from(`${objects.map(item => item.hash).join('\n')}\n`, 'utf8'));
  const entries: ContentEntry[] = [];
  let offset = 0;
  for (const object of objects) {
    const newline = output.indexOf(0x0a, offset);
    if (newline < 0) throw new Error('unexpected git cat-file output');
    const header = output.subarray(offset, newline).toString('utf8');
    const size = Number(header.split(' ')[2]);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('unexpected git cat-file header');
    const start = newline + 1;
    entries.push({ path: object.path, bytes: Buffer.from(output.subarray(start, start + size)) });
    offset = start + size + 1;
  }
  return { tree, entries };
}

function contentViews(bytes: Buffer): string[] {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!text.includes('\0')) return [text];
  } catch { /* Binary blobs still need metadata and embedded-string scanning. */ }
  const views = [bytes.toString('latin1')];
  if (bytes.length >= 4) views.push(bytes.toString('utf16le'));
  return views;
}

function lineHash(line: string): string {
  return createHash('sha256').update(line, 'utf8').digest('hex');
}

function parseAllowlist(raw: string, source: string): AllowEntry[] {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error(`${source} must be valid JSON`); }
  if (!Array.isArray(value)) throw new Error(`${source} must contain a JSON array`);
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw new Error(`${source}[${index}] must be an object`);
    const item = entry as Record<string, unknown>;
    if (typeof item.path !== 'string' || !item.path || typeof item.rule !== 'string' || !RULES.some(rule => rule.id === item.rule)
      || typeof item.lineSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(item.lineSha256)
      || typeof item.reason !== 'string' || item.reason.trim().length < 8) {
      throw new Error(`${source}[${index}] is not an exact, justified allowlist entry`);
    }
    return { path: item.path.replaceAll('\\', '/'), rule: item.rule, lineSha256: item.lineSha256, reason: item.reason.trim() };
  });
}

function allowlistFor(root: string, entries: readonly ContentEntry[], tree: string | undefined, custom: string | undefined): AllowEntry[] {
  const relative = (custom ?? PREPUBLISH_ALLOWLIST).replaceAll('\\', '/');
  if (tree) {
    const entry = entries.find(item => item.path === relative);
    if (!entry) return [];
    const text = new TextDecoder('utf-8', { fatal: true }).decode(entry.bytes);
    if (text.includes('\0')) throw new Error(`${relative} must be UTF-8 text`);
    return parseAllowlist(text, relative);
  }
  const absolute = path.resolve(root, custom ?? PREPUBLISH_ALLOWLIST);
  return existsSync(absolute) ? parseAllowlist(readFileSync(absolute, 'utf8'), relative) : [];
}

export function scanPublishingTree(options: ScanPublishingTreeOptions = {}): ScanPublishingTreeResult {
  const root = path.resolve(options.root ?? process.cwd());
  const selected = options.tree ? treeEntries(root, options.tree) : { tree: undefined, entries: currentEntries(root) };
  const release = options.release ?? false;
  const entries = selected.entries.filter(entry => !release || !releaseExcluded(entry.path));
  const allowlist = allowlistFor(root, entries, selected.tree, options.allowlistPath);
  const allowed = new Set(allowlist.map(item => `${item.path}\0${item.rule}\0${item.lineSha256}`));
  const findings = new Map<string, PrepublishFinding>();

  for (const entry of entries) {
    for (const text of contentViews(entry.bytes)) {
      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]!;
        for (const rule of RULES) {
          rule.pattern.lastIndex = 0;
          if (!rule.pattern.test(line)) continue;
          if (allowed.has(`${entry.path}\0${rule.id}\0${lineHash(line)}`)) continue;
          const finding = { rule: rule.id, path: entry.path, line: index + 1 };
          findings.set(`${finding.rule}\0${finding.path}\0${finding.line}`, finding);
        }
      }
    }
  }
  return {
    findings: [...findings.values()].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.rule.localeCompare(b.rule)),
    scannedFiles: new Set(entries.map(entry => entry.path)).size,
    release,
    ...(selected.tree ? { tree: selected.tree } : {}),
  };
}

export function formatFinding(finding: PrepublishFinding): string {
  return `${finding.rule}\t${finding.path}:${finding.line}`;
}

export function releaseByDefault(branch: string): boolean {
  return branch === 'main';
}

export interface PrepublishScanIo {
  root?: string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

export function runPrepublishScan(argv: string[], io: PrepublishScanIo = {}): number {
  let tree: string | undefined;
  let releaseRequested = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--release') releaseRequested = true;
    else if (arg === '--tree' && argv[index + 1]) tree = argv[++index];
    else throw new Error(`usage: prepublish-scan [--release] [--tree <ref>]`);
  }
  const root = path.resolve(io.root ?? process.cwd());
  const stdout = io.stdout ?? (text => process.stdout.write(text));
  const stderr = io.stderr ?? (text => process.stderr.write(text));
  const branch = tree ? '' : git(root, ['branch', '--show-current']).toString('utf8').trim();
  const result = scanPublishingTree({ root, ...(tree ? { tree } : {}), release: releaseRequested || releaseByDefault(branch) });
  for (const finding of result.findings) stderr(`${formatFinding(finding)}\n`);
  if (result.findings.length) {
    stderr(`prepublish scan failed: ${result.findings.length} finding(s)\n`);
    return 1;
  }
  stdout(`prepublish scan passed: ${result.scannedFiles} file(s)\n`);
  return 0;
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (invoked) {
  try { process.exitCode = runPrepublishScan(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write(`prepublish scan error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
