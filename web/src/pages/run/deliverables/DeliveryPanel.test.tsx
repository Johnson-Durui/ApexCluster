import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';
import type { Run, ValidationJob } from '../../../lib/types';
import { artifactUrl, DeliverablesView, fileKind, type DeliverablesResponse } from './DeliveryPanel';

const job = (patch: Partial<ValidationJob> = {}) => ({
  id: 'j-C1-1', runId: 'r demo', batch: 1, candidateId: 'C1', proposalId: 'p1', effort: 'max', effortReason: '默认', workspaceDir: 'X:\\fixtures\\demo', gitRepo: false,
  spec: { ref: 'spec-1', candidateId: 'C1', goal: '桌面客户端', scopeIn: [], scopeOut: [], acceptance: [], hypotheses: [], timeboxMinutes: 30, allowNetwork: false, comparisonQuestions: [] },
  status: 'failed', taskIds: [], report: null, verification: { verdict: 'failed', items: [], selfReportMismatches: [], computedAt: '2026-10-16T08:00:00Z' }, manualResults: [], failureClass: 'implementation_defect', failureClassSource: 'sol', devGuideVersion: null, createdAt: '2026-10-16T08:00:00Z', endedAt: '2026-10-16T09:00:00Z', ...patch,
}) as ValidationJob;
const run = (patch: Partial<Run> = {}) => ({
  id: 'r demo', mode: 'real', phase: 'done', phaseStatus: 'completed', terminal: 'done', updatedAt: '2026-10-16T09:00:00Z', jobs: [job()], proposals: [{ id: 'p1', title: '双端 Python 控制台' }] as Run['proposals'], finalChoice: { candidateId: 'C1', reason: null, at: '2026-10-16T09:00:00Z' }, writeDocs: true, writePrd: true,
  docs: { batch: 1, bases: [], requests: [], versions: [], missing: [], requestSeq: 0 },
  ...patch,
}) as Run;
const data = (patch: Partial<DeliverablesResponse> = {}): DeliverablesResponse => ({ jobs: [{ jobId: 'j-C1-1', workspaceDir: 'X:\\fixtures\\demo', available: true, files: [{ path: 'dist/app.exe', size: 2048 }, { path: 'README.md', size: 1200 }], warnings: [] }], generatedAt: '2026-10-16T09:00:00Z', ...patch });
const render = (r: Run, d: DeliverablesResponse) => renderToStaticMarkup(<DeliverablesView run={r} data={d} selectedJobId={null} onSelectJob={vi.fn()} onOpenRecords={vi.fn()} />);

describe('交付成果', () => {
  test('无作业时解释没有产物并保留决策记录入口', () => {
    const html = render(run({ jobs: [], finalChoice: null, terminal: 'cancelled' }), data({ jobs: [] }));
    expect(html).toContain('本次运行没有创建 MVP 作业');
    expect(html).toContain('运行已取消');
    expect(html).toContain('查看决策记录');
    expect(html).toContain('项目文档版本');
    expect(html).toContain('下载决策记录');
  });

  test('失败作业仍可下载现有整包，但不冒充验收通过', () => {
    const html = render(run(), data());
    expect(html).toContain('下载工作区整包');
    expect(html).toContain('/api/runs/r%20demo/jobs/j-C1-1/archive');
    expect(html).toContain('核验：失败');
    expect(html).toContain('整包只是现有结果，不代表验收通过');
  });

  test('缺失工作区时不提供下载', () => {
    const html = render(run(), data({ jobs: [{ jobId: 'j-C1-1', workspaceDir: 'E:\\missing', available: false, files: [], warnings: ['目录已被移动'] }] }));
    expect(html).toContain('源码工作区不可用');
    expect(html).toContain('目录已被移动');
    expect(html).not.toContain('下载工作区整包');
  });

  test('扫描不完整时保留文件清单但禁用整包并显示原因', () => {
    const html = render(run(), data({ jobs: [{ jobId: 'j-C1-1', workspaceDir: 'X:\\fixtures\\demo', available: true, incomplete: true, files: [{ path: 'README.md', size: 10 }], warnings: ['无权读取 secrets/'] }] }));
    expect(html).toContain('文件扫描不完整，整包下载已禁用');
    expect(html).toContain('无权读取 secrets/');
    expect(html).toContain('README.md');
    expect(html).not.toContain('href="/api/runs/r%20demo/jobs/j-C1-1/archive"');
  });

  test('单文件下载完整编码运行、作业和相对路径', () => {
    expect(artifactUrl('r /一', 'j 1', '输出 包/app #1.exe')).toBe('/api/runs/r%20%2F%E4%B8%80/jobs/j%201/artifact?path=%E8%BE%93%E5%87%BA%20%E5%8C%85%2Fapp%20%231.exe');
  });

  test('关闭正式文档仍显示工作区资料和源码整包', () => {
    const html = render(run({ writeDocs: false, writePrd: false }), data());
    expect(html).toContain('构建前正式文档已关闭');
    expect(html).toContain('README.md');
    expect(html).toContain('下载工作区整包');
    expect(html).toContain('不等于资料不存在');
  });

  test('成品只收直接交付文件，内部运行库默认归入收起组', () => {
    expect(fileKind('dist/MecanumConsole-Setup-0.2.0.exe')).toBe('product');
    expect(fileKind('Portable.zip')).toBe('product');
    expect(fileKind('dist/SHA256SUMS.txt')).toBe('product');
    expect(fileKind('dist/MecanumConsole/_internal/python3.dll')).toBe('other');
    expect(fileKind('docs/USER_GUIDE.md')).toBe('material');
    expect(fileKind('DEV_GUIDE.md')).toBe('material');
    expect(fileKind('AGENTS.md')).toBe('material');
    expect(fileKind('work/inno/app/Examples/Readme.txt')).toBe('other');
  });

  test('作业标题使用提案名，长构建目标放入次要详情', () => {
    const html = render(run(), data());
    expect(html).toContain('C1 · 双端 Python 控制台');
    expect(html).toContain('<summary>查看本次构建目标</summary>');
    expect(html).toContain('桌面客户端');
  });

  test('最终选择只标记当前验收批次中的同候选作业', () => {
    const current = job({ id: 'j-C1-2', batch: 2 });
    const html = render(run({ jobBatch: 2, jobs: [job(), current] }), data({ jobs: [{ jobId: 'j-C1-1', workspaceDir: 'old', available: true, files: [], warnings: [] }, { jobId: 'j-C1-2', workspaceDir: 'new', available: true, files: [], warnings: [] }] }));
    expect(html.match(/最终选择/g)).toHaveLength(1);
  });
});
