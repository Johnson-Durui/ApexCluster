// Every file the demo chats deliver as an artifact, with its true size and SHA-256.
//
// - The RoomDesk deliverables are imported as raw text (scenario/content/*.md and public/demo-project/*), so the bytes the
//   artifact route serves are exactly the files in the delivered project. Their hashes are computed here; they match
//   scenario/content/manifest.json because they are the same bytes.
// - roomdesk.zip is binary. It is not bundled: the artifact route fetches ./demo-project/roomdesk.zip and the record
//   uses the size and hash from manifest.json.
// - The workspace diffs are generated from the real project files ("new file" unified diffs).
// - CONTRACT.json is generated from the PRD's acceptance table, so it always lists the same AC-01..AC-12.
import type { ChatArtifact } from '../../src/lib/chat-api';
import acceptanceMd from './content/acceptance.md?raw';
import architectureMd from './content/architecture.md?raw';
import devGuideMd from './content/dev-guide.md?raw';
import manifestText from './content/manifest.json?raw';
import prdMd from './content/prd.md?raw';
import seatNotesMd from './content/seat-notes.md?raw';
import testReportTxt from './content/test-report.txt?raw';
import traceMd from './content/trace.md?raw';
import corePathDemoMjs from './content-extra/core-path-demo.mjs?raw';
import demoReportMd from './content-extra/demo-report.md?raw';
import executionReviewArchMd from './content-extra/execution-review-arch.md?raw';
import weeklyTemplateMd from './content-extra/weekly-template.md?raw';
import indexHtml from '../public/demo-project/index.html?raw';
import packageJson from '../public/demo-project/package.json?raw';
import readmeMd from '../public/demo-project/README.md?raw';
import appJs from '../public/demo-project/src/app.js?raw';
import coreMjs from '../public/demo-project/src/roomdesk-core.mjs?raw';
import stylesCss from '../public/demo-project/src/styles.css?raw';
import testsMjs from '../public/demo-project/tests/roomdesk-core-test.mjs?raw';
import { sha256Hex, utf8Bytes } from './sha256';

export const ROOMDESK_PROMPT = '帮我做一个团队会议室预约小工具：先出 PRD 和技术架构，再完成可运行的 Web 应用和自动化测试。需要支持按楼层筛选、冲突检测和 iCal 导出。';

export interface DemoFile {
  key: string;
  /** Artifact display name. */
  name: string;
  /** Path inside the delivered project (or a blob path for generated records). */
  relativePath: string;
  kind: ChatArtifact['kind'];
  contentType: string;
  bytes: number;
  sha256: string;
  /** Inline text content. Absent for binary files, which are fetched from `url`. */
  text?: string;
  /** Path relative to the page (document.baseURI) for binary files. */
  url?: string;
}

interface ManifestEntry { id: string; name: string; relativePath: string; source: string; kind: ChatArtifact['kind']; bytes: number; sha256: string }

const TYPES: Record<string, string> = {
  md: 'text/markdown; charset=utf-8', txt: 'text/plain; charset=utf-8', json: 'application/json; charset=utf-8',
  diff: 'text/x-diff; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8', html: 'text/html; charset=utf-8', zip: 'application/zip',
};
const typeOf = (name: string) => TYPES[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';

const files = new Map<string, DemoFile>();

/** Registers a text file under `key` and returns it. Size and hash are computed from the UTF-8 bytes. */
export function registerText(key: string, name: string, text: string, kind: ChatArtifact['kind'], relativePath = name): DemoFile {
  const file: DemoFile = { key, name, relativePath, kind, contentType: typeOf(name), bytes: utf8Bytes(text), sha256: sha256Hex(text), text };
  files.set(key, file);
  return file;
}

/** The registered file. Throws for an unknown key, which is a scenario bug. */
export function demoFile(key: string): DemoFile {
  const file = files.get(key);
  if (!file) throw new Error(`[demo] unknown content key ${key}`);
  return file;
}

export function hasDemoFile(key: string): boolean {
  return files.has(key);
}

const manifest = JSON.parse(manifestText) as ManifestEntry[];
const manifestById = new Map(manifest.map(entry => [entry.id, entry]));

const TEXT_BY_MANIFEST_ID: Record<string, string> = {
  prd: prdMd, architecture: architectureMd, 'dev-guide': devGuideMd, acceptance: acceptanceMd, trace: traceMd,
  index: indexHtml, app: appJs, core: coreMjs, styles: stylesCss, tests: testsMjs, readme: readmeMd, package: packageJson,
  'test-report': testReportTxt,
};

for (const entry of manifest) {
  const text = TEXT_BY_MANIFEST_ID[entry.id];
  if (text !== undefined) {
    registerText(entry.id, entry.name, text, entry.kind, entry.relativePath);
  } else if (entry.id === 'zip') {
    files.set('zip', { key: 'zip', name: entry.name, relativePath: entry.relativePath, kind: entry.kind, contentType: typeOf(entry.name), bytes: entry.bytes, sha256: entry.sha256, url: 'demo-project/roomdesk.zip' });
  }
}

/** The manifest entry for a RoomDesk deliverable (used for its project path). */
export function manifestEntry(id: string): ManifestEntry | undefined {
  return manifestById.get(id);
}

// ---------------------------------------------------------------- seat notes

/** seat-notes.md split at its '## seat/step' headings. */
const seatNotes = new Map<string, string>();
for (const block of seatNotesMd.split(/^## /m).slice(1)) {
  const newline = block.indexOf('\n');
  seatNotes.set(block.slice(0, newline).trim(), block.slice(newline + 1).trim());
}

/** The text of one seat step from seat-notes.md. Throws for a missing heading, which is a scenario bug. */
export function seatNote(key: string): string {
  const text = seatNotes.get(key);
  if (text === undefined) throw new Error(`[demo] seat-notes.md has no section ${key}`);
  return text;
}

/** The product's answer renderer has no bold: '**text**' becomes 'text'. */
export function plainMarkdown(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, '$1');
}

// ---------------------------------------------------------------- generated files

/** A unified diff that adds `paths` as new files (what the workspace snapshot diff of a fresh file looks like). */
export function newFileDiff(entries: Array<{ path: string; text: string }>): string {
  return entries.map(({ path, text }) => {
    const lines = text.split('\n');
    const endsWithNewline = text.endsWith('\n');
    if (endsWithNewline) lines.pop();
    const body = lines.map(line => `+${line}`).join('\n');
    return [
      `diff --git a/${path} b/${path}`,
      'new file mode 100644',
      '--- /dev/null',
      `+++ b/${path}`,
      `@@ -0,0 +1,${lines.length} @@`,
      body,
      ...(endsWithNewline ? [] : ['\\ No newline at end of file']),
    ].join('\n');
  }).join('\n') + '\n';
}

function acceptanceRows(): Array<{ id: string; text: string }> {
  const rows: Array<{ id: string; text: string }> = [];
  for (const line of prdMd.split('\n')) {
    const match = /^\|\s*(AC-\d{2})\s*\|\s*(.+?)\s*\|\s*$/.exec(line);
    if (match) rows.push({ id: match[1], text: match[2] });
  }
  return rows;
}

function contractJson(): string {
  const contract = {
    version: 1,
    revision: 1,
    requirement: ROOMDESK_PROMPT,
    preset: 'flagship',
    acceptance: acceptanceRows(),
    milestones: [
      { id: 'M-API', files: ['package.json', 'src/roomdesk-core.mjs', 'tests/roomdesk-core-test.mjs'], author: 'sol', reviewer: 'opus', checks: ['CHECK-API'] },
      { id: 'M-UI', files: ['index.html', 'src/app.js', 'src/styles.css'], author: 'opus', reviewer: 'sol', checks: ['CHECK-UI'] },
    ],
    checks: [
      { id: 'CHECK-API', argv: ['npm', 'test'], expect: '退出码 0，全部用例通过' },
      { id: 'CHECK-UI', kind: 'browser', expect: '子路径下加载无 404、无控制台错误；1280×720 与 375 px 无横向滚动' },
    ],
    deliverables: ['docs/PRD.md', 'docs/ARCHITECTURE.md', 'docs/DEV_GUIDE.md', 'index.html', 'src/app.js', 'src/roomdesk-core.mjs', 'src/styles.css', 'tests/roomdesk-core-test.mjs', 'README.md', 'package.json'],
    outOfScope: ['用户登录与多人实时同步', '服务端存储与审批流程', '周期性会议与跨天会议', '通知与参会人邀请', '与现有日历系统的双向同步'],
  };
  return `${JSON.stringify(contract, null, 2)}\n`;
}

registerText('demo-report', 'DEMO_REPORT.md', demoReportMd, 'report', 'blobs/demo-report.md');
registerText('demo-diff', 'workspace-diff-demo.diff', newFileDiff([{ path: '.agent/demo/core-path-demo.mjs', text: corePathDemoMjs }]), 'diff');
registerText('contract', 'CONTRACT.json', contractJson(), 'file', '.agent/CONTRACT.json');
registerText('execution-review-arch', 'execution-review.md', executionReviewArchMd, 'report', 'blobs/execution-review-architecture.md');
// package.json (the npm test script) belongs to M-API, whose check runs npm test.
registerText('diff-api', 'workspace-diff-api.diff', newFileDiff([{ path: 'package.json', text: packageJson }, { path: 'src/roomdesk-core.mjs', text: coreMjs }, { path: 'tests/roomdesk-core-test.mjs', text: testsMjs }]), 'diff');
registerText('diff-ui', 'workspace-diff-ui.diff', newFileDiff([{ path: 'index.html', text: indexHtml }, { path: 'src/app.js', text: appJs }, { path: 'src/styles.css', text: stylesCss }]), 'diff');
registerText('diff-handback', 'workspace-diff-handback.diff', newFileDiff([{ path: 'README.md', text: readmeMd }]), 'diff');
registerText('weekly-template', '周报模板.md', weeklyTemplateMd, 'file');

/** The full test report (stdout of `npm test` in the delivered project). */
export const TEST_REPORT = testReportTxt;
/** Pass count read from the real report ("ℹ pass 30"). */
export const TEST_PASS = Number(/ℹ pass (\d+)/.exec(testReportTxt)?.[1] ?? 0);
export const TEST_FAIL = Number(/ℹ fail (\d+)/.exec(testReportTxt)?.[1] ?? 0);
