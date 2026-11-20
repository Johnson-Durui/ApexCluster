// Run 1 of 4 (README.md "Runs"): 为博客评论选择存储方案 — completed, with a decision, an accepted MVP job,
// three approved documents and a workspace to download. Fixed dates (2026-11-14), so its history never moves.
import type { HardConstraint, ProjectInput, RequirementSnapshot, Run, ValidationJob } from '../../../src/lib/types';
import { BLOG_DOCS, BLOG_FILES } from './blog-storage-files';
import {
  candidate, commonFields, constraintResult, dualCell, gate, judgment, proposal, question, settledBudget, started, task, timeline, totals, trail,
  type RunBundle,
} from './common';

export const BLOG_RUN_ID = 'r-20261114-3c9e51';
const CREATED = Date.parse('2026-11-14T01:20:00.000Z');
const SPEC = 'spec-7d2c4e91a0b3';
const V1 = 'v1-41c7e02b9d58';
const V2 = 'v2-9e3a51f0c7d2';

const project: ProjectInput = {
  title: '为博客评论选择存储方案',
  prompt: '个人技术博客要加评论功能：支持嵌套回复、按文章分页读取、垃圾评论过滤后再展示。博客本身是静态站点，评论服务需要一个存储方案，部署在一台小型云主机上，月活读者约 2 万。',
  coreFlows: ['读者发表评论与回复', '按文章分页读取评论树', '管理员审核与删除垃圾评论'],
  existingStack: '静态站点生成器；作者熟悉 TypeScript 与 Node.js',
  deployment: '一台 2 核 4 GB 的 Linux 云主机',
  budget: '一人业余时间，三周内上线',
  acceptance: '评论读写与审核流程可用；单篇文章 500 条评论时首屏读取在 200 毫秒内',
  context: '',
  referenceDocuments: [{ name: '现有博客部署说明.md', content: '# 部署\n- 静态页面由 CI 构建后上传到对象存储\n- 云主机只运行一个反向代理和后续的评论服务\n- 每周日人工检查一次磁盘占用' }],
};
const constraints: HardConstraint[] = [
  { id: 'H1', text: '评论数据每日自动备份，并能在 30 分钟内恢复', kind: 'must' },
  { id: 'H2', text: '引入需要单独付费的托管数据库服务', kind: 'must_not' },
];

const acceptance: ValidationJob['spec']['acceptance'] = [
  { id: 'AC1', description: '评论树、分页与审核规则的单元测试全部通过', kind: 'command', command: 'npm test', expectExitCode: 0, outputIncludes: null },
  { id: 'AC2', description: '单篇 500 条评论时首屏读取 p95 小于 200 毫秒', kind: 'command', command: 'npm run bench -- --comments 500', expectExitCode: 0, outputIncludes: 'p95' },
  { id: 'AC3', description: '备份恢复演练在 30 分钟内完成且条数一致', kind: 'command', command: 'npm run backup:verify', expectExitCode: 0, outputIncludes: 'restored' },
  { id: 'AC4', description: '在测试博客上发表、回复并审核一条评论', kind: 'manual', command: null, expectExitCode: null, outputIncludes: null },
];
const goal = '验证评论树分页读取、审核流程与备份恢复能在单台主机上满足目标';
const scopeIn = ['嵌套评论的发表与分页读取', '规则过滤与人工审核队列', '每日备份与恢复演练脚本'];
const scopeOut = ['邮件通知', '第三方登录', '多实例部署'];

export function buildBlogRun(): RunBundle {
  const t = timeline(CREATED);
  const run = { id: BLOG_RUN_ID, models: commonFields().models };
  const snapshots: RequirementSnapshot[] = [
    { version: 1, ref: V1, hash: V1.slice(3), createdAt: t(0), reason: '用户输入', project, constraints, facts: [{ id: 'F1', text: '评论服务部署在一台 2 核 4 GB 云主机', source: 'user_input' }], assumptions: [], openItems: [] },
    { version: 2, ref: V2, hash: V2.slice(3), createdAt: t(14.2), reason: '合并 G1 回答', project, constraints,
      facts: [
        { id: 'F1', text: '评论服务部署在一台 2 核 4 GB 云主机', source: 'user_input' },
        { id: 'F2', text: '评论支持软删除，原文保留供审核', source: 'answer:Q1' },
        { id: 'F3', text: '单篇文章评论不超过 1000 条', source: 'answer:Q2' },
        { id: 'F4', text: '垃圾评论用本地规则过滤加人工审核', source: 'answer:Q3' },
      ],
      assumptions: [{ id: 'A1', text: '单实例部署即可满足读者规模', source: 'default:Q4' }], openItems: [] },
  ];
  const tasks = [
    task(run, { id: 't-clarify-claude-a1', role: 'claude', phase: 'clarify', scope: 'clarify', createdAt: t(0.02), startedAt: t(0.05), endedAt: t(2.6), inputRef: V1 }),
    task(run, { id: 't-clarify-astra-a1', role: 'astra', phase: 'clarify', scope: 'clarify', createdAt: t(0.02), startedAt: t(0.05), endedAt: t(3.4), inputRef: V1 }),
    task(run, { id: 't-r1-propose-claude-a1', role: 'claude', phase: 'propose', scope: 'r1-propose', createdAt: t(14.25), startedAt: t(14.3), endedAt: t(22.8), inputRef: V2 }),
    task(run, { id: 't-r1-propose-astra-a1', role: 'astra', phase: 'propose', scope: 'r1-propose', createdAt: t(14.25), startedAt: t(14.3), endedAt: t(25.1), inputRef: V2 }),
    task(run, { id: 't-r1-review-claude-a1', role: 'claude', phase: 'review', scope: 'r1-review', createdAt: t(25.15), startedAt: t(25.2), endedAt: t(33.4), inputRef: V2 }),
    task(run, { id: 't-r1-review-astra-a1', role: 'astra', phase: 'review', scope: 'r1-review', createdAt: t(25.15), startedAt: t(25.2), endedAt: t(35.0), inputRef: V2 }),
    task(run, { id: 't-docs-b1-handbook-v1-r1-claude-a1', role: 'claude', phase: 'handbook', scope: 'docs-b1-handbook-v1-r1', createdAt: t(51.6), startedAt: t(51.65), endedAt: t(58.9), inputRef: 'docs-handbook-v1-5a0e2c91d3', effort: 'xhigh' }),
    task(run, { id: 't-docs-b1-devdoc-v1-r2-astra-a1', role: 'astra', phase: 'devdoc', scope: 'docs-b1-devdoc-v1-r2', createdAt: t(51.6), startedAt: t(51.65), endedAt: t(60.4), inputRef: 'docs-devdoc-v1-c84f1b7e20' }),
    task(run, { id: 't-job-j-C1-1-r1-build-sol-a1', role: 'sol', phase: 'build', scope: 'job:j-C1-1:r1:build', createdAt: t(78.4), startedAt: t(78.5), endedAt: t(121.8), jobId: 'j-C1-1', inputRef: SPEC, extra: { jobBatch: 1, buildRound: 1 } }),
    task(run, { id: 't-docs-b1-prd-v1-r3-claude-a1', role: 'claude', phase: 'prd', scope: 'docs-b1-prd-v1-r3', createdAt: t(140.1), startedAt: t(140.15), endedAt: t(147.6), inputRef: 'docs-prd-v1-0f6d93a2b4', effort: 'xhigh' }),
  ];
  const byId = (id: string) => tasks.find(item => item.id === id)!;

  const questions = [
    question({ id: 'Q1', askedBy: 'claude', taskId: 't-clarify-claude-a1', createdAt: t(2.6), topic: 'data', priority: 'blocking', multiSelect: false,
      text: '评论需要支持编辑和删除吗？删除后是否保留原文？', whyItMatters: '决定评论表是否需要状态与删除时间字段，以及审核能否追溯',
      options: [{ id: 'soft', label: '软删除，保留原文供审核', implication: '多一个状态列，查询需过滤' }, { id: 'hard', label: '直接物理删除', implication: '实现最简单，无法追溯' }],
      defaultOptionIds: ['soft'], defaultAssumption: '评论软删除并保留原文', answer: { optionIds: ['soft'], at: t(9.5) } }),
    question({ id: 'Q2', askedBy: 'claude', taskId: 't-clarify-claude-a1', createdAt: t(2.6), topic: 'performance', priority: 'important', multiSelect: false,
      text: '单篇文章的评论量上限大约是多少？', whyItMatters: '影响评论树的读取方式与是否需要分页',
      options: [{ id: 'lt1k', label: '1000 条以内', implication: '整棵树按页读取即可' }, { id: 'lt10k', label: '1 万条以内', implication: '需要按子树懒加载' }],
      defaultOptionIds: ['lt1k'], defaultAssumption: '单篇文章评论不超过 1000 条', answer: { optionIds: ['lt1k'], at: t(10.8) } }),
    question({ id: 'Q3', askedBy: 'astra', taskId: 't-clarify-astra-a1', createdAt: t(3.4), topic: 'security', priority: 'blocking', multiSelect: false,
      text: '垃圾评论过滤用本地规则，还是接入外部反垃圾服务？', whyItMatters: '外部服务通常按量计费，并需要把评论内容发出主机',
      options: [{ id: 'rules', label: '本地规则 + 人工审核', implication: '无外部依赖，需要维护规则' }, { id: 'service', label: '外部反垃圾服务', implication: '准确率高，但有费用与隐私顾虑' }],
      defaultOptionIds: ['rules'], defaultAssumption: '本地规则过滤，人工审核兜底', answer: { optionIds: ['rules'], at: t(12.1) } }),
    question({ id: 'Q4', askedBy: 'astra', taskId: 't-clarify-astra-a1', createdAt: t(3.4), topic: 'deployment', priority: 'optional', multiSelect: false,
      text: '评论服务需要多实例部署吗？', whyItMatters: '决定存储是否必须支持多进程并发写入',
      options: [{ id: 'single', label: '单实例即可', implication: '可以使用嵌入式数据库' }, { id: 'multi', label: '需要多实例', implication: '需要独立数据库服务' }],
      defaultOptionIds: ['single'], defaultAssumption: '单实例部署即可满足读者规模' }),
  ];

  const propC = proposal('claude', 2, {
    title: 'SQLite（WAL）+ 物化路径评论树 + 单进程 Node 服务',
    summary: '评论服务与 SQLite 单文件库部署在同一台主机；评论用 parent_id 与物化路径列存储，按文章分页一次查询取出整棵子树；每日用 SQLite 在线备份生成快照并上传对象存储。',
    fitWhen: ['单台主机部署', '读多写少，单篇评论量在千条以内'], notFitWhen: ['需要多实例同时写入', '评论总量达到百万级并需要全文检索'],
    stack: [{ layer: '挂件', choice: '原生 Web Components', reason: '嵌入静态页面，无框架依赖' }, { layer: '服务', choice: 'Node.js + Fastify', reason: '轻量，作者熟悉' }, { layer: '存储', choice: 'SQLite（WAL 模式）', reason: '单文件、零运维' }, { layer: '备份', choice: 'SQLite 在线备份 + 对象存储', reason: '备份时不锁库' }],
    modules: [
      { id: 'widget', name: '评论挂件', responsibility: '嵌入文章页，提交与展示评论', tech: 'Web Components' },
      { id: 'api', name: '评论 API', responsibility: '发表、回复、分页读取', tech: 'Fastify' },
      { id: 'tree', name: '评论树查询', responsibility: '按物化路径排序并分页', tech: null },
      { id: 'moderation', name: '审核队列', responsibility: '规则过滤与人工审核', tech: null },
      { id: 'db', name: '评论库', responsibility: '保存评论与审核状态', tech: 'SQLite' },
      { id: 'backup', name: '备份任务', responsibility: '每日快照与恢复演练', tech: 'cron' },
    ],
    flows: [
      { from: 'widget', to: 'api', label: '发表/读取', kind: 'call' }, { from: 'api', to: 'tree', label: '分页取子树', kind: 'call' },
      { from: 'api', to: 'moderation', label: '新评论待审', kind: 'event' }, { from: 'tree', to: 'db', label: '按路径读取', kind: 'data' },
      { from: 'moderation', to: 'db', label: '更新审核状态', kind: 'data' }, { from: 'backup', to: 'db', label: '在线备份', kind: 'data' },
    ],
    dataModel: 'comments(id, post_slug, parent_id, path, author_name, body, status, created_at, deleted_at)；索引 (post_slug, status, path)',
    deployment: 'systemd 托管单个 Node 进程；SQLite 文件放在独立数据盘；cron 每日 03:00 备份并上传对象存储',
    tradeoffs: [{ gain: '没有额外服务，备份就是复制一个文件', cost: '不能多实例并发写入' }, { gain: '物化路径一次查询取出整页', cost: '移动子树需要批量改写路径' }],
    risks: [{ text: '突发评论高峰时 SQLite 写锁排队', severity: 'low', mitigation: 'WAL 模式 + busy_timeout 重试' }, { text: '备份文件只存在本机时无法应对磁盘故障', severity: 'medium', mitigation: '备份后立即上传对象存储并校验大小' }],
    assumptions: [{ text: '单实例部署即可满足读者规模', questionId: 'Q4' }, { text: '评论不可移动到其他父评论下', questionId: null }],
    constraintChecks: [{ constraintId: 'H1', status: 'pass', note: '在线备份 + 每周恢复演练' }, { constraintId: 'H2', status: 'pass', note: '嵌入式数据库，无托管服务' }],
    mvpPlan: { goal, scopeIn, scopeOut, acceptance,
      hypotheses: [{ id: 'HY1', text: '物化路径排序可在 200 毫秒内取出 500 条评论的首屏', howToVerify: '用 500 条随机嵌套评论跑基准', passCriteria: 'p95 小于 200 毫秒' }],
      workstreams: [{ id: 'W1', title: '存储与查询', dependsOn: [] }, { id: 'W2', title: '挂件与审核', dependsOn: ['W1'] }], estimatedEffort: '约 4 人日' },
  });
  const propA = proposal('astra', 2, {
    title: 'PostgreSQL + 递归 CTE + 物化评论计数',
    summary: '同机部署 PostgreSQL，评论树用递归 CTE 读取；评论计数与热门排序写入物化视图；每日 pg_dump 备份到对象存储。',
    fitWhen: ['后续可能扩展到多实例或全文检索'], notFitWhen: ['主机内存紧张', '不希望维护常驻数据库服务'],
    stack: [{ layer: '服务', choice: 'Node.js + Fastify', reason: '与现有技能一致' }, { layer: '存储', choice: 'PostgreSQL 16', reason: '递归查询与并发写入成熟' }, { layer: '备份', choice: 'pg_dump + 对象存储', reason: '标准逻辑备份' }],
    modules: [
      { id: 'widget', name: '评论挂件', responsibility: '提交与展示评论', tech: 'Web Components' },
      { id: 'api', name: '评论 API', responsibility: '发表、回复、分页读取', tech: 'Fastify' },
      { id: 'cte', name: '递归查询', responsibility: '按层级读取评论树', tech: 'PostgreSQL' },
      { id: 'counts', name: '计数物化视图', responsibility: '评论数与热门排序', tech: 'PostgreSQL' },
      { id: 'moderation', name: '审核队列', responsibility: '规则过滤与人工审核', tech: null },
    ],
    flows: [{ from: 'widget', to: 'api', label: '发表/读取', kind: 'call' }, { from: 'api', to: 'cte', label: '递归读取', kind: 'call' }, { from: 'api', to: 'moderation', label: '新评论待审', kind: 'event' }, { from: 'cte', to: 'counts', label: '刷新计数', kind: 'data' }],
    dataModel: 'comments(id, post_slug, parent_id, body, status, created_at)；mv_comment_counts(post_slug, total, approved)',
    deployment: 'PostgreSQL 与 Node 服务同机，systemd 管理；pg_dump 每日上传对象存储',
    tradeoffs: [{ gain: '多实例与全文检索扩展空间大', cost: '多维护一个常驻数据库服务与版本升级' }],
    risks: [{ text: 'PostgreSQL 在 4 GB 主机上与 Node 进程争用内存', severity: 'medium', mitigation: '限制 shared_buffers 并加内存监控' }],
    assumptions: [{ text: '同机部署数据库不违反 H2', questionId: null }],
    constraintChecks: [{ constraintId: 'H1', status: 'pass', note: 'pg_dump 每日备份' }, { constraintId: 'H2', status: 'pass', note: '自建数据库，无托管费用' }],
    mvpPlan: { goal, scopeIn, scopeOut, acceptance,
      hypotheses: [{ id: 'HY1', text: '递归 CTE 在 500 条评论时首屏读取小于 200 毫秒', howToVerify: '基准测试', passCriteria: 'p95 小于 200 毫秒' }],
      workstreams: [{ id: 'W1', title: '数据库与查询', dependsOn: [] }, { id: 'W2', title: '挂件与审核', dependsOn: [] }], estimatedEffort: '约 6 人日' },
  });
  const C1 = candidate('C1', 'claude');
  const C2 = candidate('C2', 'astra');
  const reason = (claude: string, astra: string) => ({ claude, astra });
  const cells = [
    dualCell('C1', 'fit', 4, 4, reason('三个核心流程都有直接支撑', '满足全部核心流程，移动子树需变通')),
    dualCell('C1', 'cost', 5, 5, reason('单进程 + 单文件，无额外运维', '依赖少且成熟')),
    dualCell('C1', 'reliability', 4, 3, reason('备份与恢复演练可自动化验证', '写锁排队的失败处理只描述了重试')),
    dualCell('C1', 'performance', 4, 4, reason('单次查询取整页', '读多写少场景余量充足')),
    dualCell('C1', 'evolution', 3, 3, reason('多实例需要换存储', '扩展到多实例需迁移')),
    dualCell('C2', 'fit', 4, 4, reason('满足核心流程', '满足核心流程')),
    dualCell('C2', 'cost', 2, 3, reason('常驻数据库需要升级与调优', '需要维护一个常驻服务')),
    dualCell('C2', 'reliability', 4, 4, reason('事务与备份成熟', '主要失败场景有处理')),
    dualCell('C2', 'performance', 5, 4, reason('递归查询有余量', '内存争用需监控')),
    dualCell('C2', 'evolution', 4, 4, reason('扩展空间大', '模块边界清晰')),
  ];
  const constraintResults = [
    constraintResult('C1', constraints[0]!, 'pass', 'pass', reason('在线备份 + 恢复演练脚本', '满足，需把演练纳入验收')),
    constraintResult('C1', constraints[1]!, 'pass', 'pass', reason('嵌入式数据库', '无托管服务')),
    constraintResult('C2', constraints[0]!, 'pass', 'pass', reason('pg_dump 每日备份', '满足')),
    constraintResult('C2', constraints[1]!, 'pass', 'pass', reason('自建数据库', '自建数据库，无托管费用')),
  ];
  const totalC1 = totals('C1', 'claude', cells, constraintResults);
  const totalC2 = totals('C2', 'astra', cells, constraintResults);
  const gap = Number((totalC1.lo - totalC2.hi).toFixed(3));
  const spec = { ref: SPEC, candidateId: 'C1', goal, scopeIn, scopeOut, acceptance, hypotheses: [{ id: 'HY1', text: '物化路径排序可在 200 毫秒内取出 500 条评论的首屏', passCriteria: 'p95 小于 200 毫秒' }], timeboxMinutes: 120, allowNetwork: true, comparisonQuestions: [] };
  const buildTask = 't-job-j-C1-1-r1-build-sol-a1';
  const verification: NonNullable<ValidationJob['verification']> = { verdict: 'passed', items: [
    { criterionId: 'AC1', status: 'verified_pass', matchedCommand: 'powershell.exe -Command "npm test"', exitCode: 0, outputExcerpt: '# pass 24  # fail 0', note: '' },
    { criterionId: 'AC2', status: 'verified_pass', matchedCommand: 'powershell.exe -Command "npm run bench -- --comments 500"', exitCode: 0, outputExcerpt: 'first page p95 = 41.7 ms (500 comments)', note: '' },
    { criterionId: 'AC3', status: 'verified_pass', matchedCommand: 'powershell.exe -Command "npm run backup:verify"', exitCode: 0, outputExcerpt: 'restored 500 rows in 2.4 s', note: '' },
    { criterionId: 'AC4', status: 'user_pass', matchedCommand: null, exitCode: null, outputExcerpt: null, note: '' },
  ], selfReportMismatches: [], computedAt: t(121.85), specRef: SPEC, atCommit: '6b1e0f4c2a9d7e3b5c8f1a0d2e4b6c8a9f0e1d2c', treeHash: '3f9c1e7a5b2d4c6e8a0b1d3f5e7c9a2b4d6f8e0a', taskId: buildTask, logRange: { from: 1, to: 12 } };
  const report: NonNullable<ValidationJob['report']> = { specRef: SPEC,
    summary: '评论服务已实现：挂件、分页读取、规则过滤与审核队列、每日备份与恢复演练。单元测试、读取基准与恢复演练都已运行并通过。',
    builtComponents: ['评论 API', '评论树查询', '审核队列', '备份与恢复脚本', '评论挂件'],
    howToRun: { setup: ['npm install', 'npm run migrate'], run: ['npm start'], test: ['npm test', 'npm run bench -- --comments 500', 'npm run backup:verify'] },
    acceptanceResults: [{ criterionId: 'AC1', status: 'pass', evidence: '见执行日志 #9' }, { criterionId: 'AC2', status: 'pass', evidence: '见执行日志 #10' }, { criterionId: 'AC3', status: 'pass', evidence: '见执行日志 #11' }, { criterionId: 'AC4', status: 'not_run', evidence: '人工验收项' }],
    hypothesisResults: [{ hypothesisId: 'HY1', status: 'supported', evidence: '500 条评论首屏 p95 41.7 ms' }],
    failureClass: 'none', failureDetail: null, deviations: [], openIssues: ['评论挂件暂未提供暗色主题', '审核规则目前只支持关键词与链接数量'], questions: [] };
  const docVersion = (kind: 'handbook' | 'devdoc' | 'prd', taskId: string, docRef: string, createdAt: string, approvedAt: string, reviewers: string, warnings: string[] = []) => ({
    kind, version: 1, batch: 1, taskId, docRef, reason: 'initial' as const, createdAt, status: 'approved' as const, content: null, revisionNotes: null, previousVersion: null,
    warnings, approvedAt, approval: { reviewers, conclusion: '通过' as const, note: null } });

  const full: Run = {
    ...commonFields(), id: BLOG_RUN_ID, title: project.title, createdAt: t(0), updatedAt: t(168),
    phase: 'done', phaseStatus: 'completed', blockedReason: null, terminal: 'done', clarifyWith: 'both',
    designMode: 'dual', riskLevel: 'medium', designResolution: { mode: 'dual', reasons: ['用户显式选择 dual'], architects: ['claude', 'astra'], reviewers: ['claude', 'astra'] },
    criteriaLockedAt: t(14.25), snapshots, currentSnapshotVersion: 2, designSnapshotVersion: 2, tasks, questions,
    modelNotes: [
      { taskId: 't-clarify-claude-a1', role: 'claude', phase: 'clarify', understanding: '你要为静态博客加一个自托管的评论服务：嵌套回复、分页读取、先审后显，单机部署。', gaps: ['删除语义未说明', '单篇评论量上限未说明'], whyThisCount: null, rejectedAlternatives: [] },
      { taskId: 't-r1-propose-claude-a1', role: 'claude', phase: 'propose', understanding: null, gaps: [], whyThisCount: '单机、读多写少，嵌入式数据库是主要方向，给出一个方案。', rejectedAlternatives: [{ title: '把评论写成 Markdown 文件随站点构建', reason: '新评论需要重新构建站点，审核延迟过长' }] },
      { taskId: 't-r1-propose-astra-a1', role: 'astra', phase: 'propose', understanding: null, gaps: [], whyThisCount: '从后续扩展出发给出一个独立数据库方案。', rejectedAlternatives: [{ title: '键值存储 + 应用层组树', reason: '分页与排序要在应用层重写，验证成本高' }] },
    ],
    proposals: [propC, propA],
    judgments: [
      judgment('claude', 'r1-claude-1', 'B', { constraintChecks: [{ constraintId: 'H1', status: 'pass', rationale: '在线备份覆盖每日要求', evidence: [{ kind: 'reasoning', ref: 'H1', summary: 'H1 要求每日备份与 30 分钟恢复' }] }, { constraintId: 'H2', status: 'pass', rationale: '无托管服务', evidence: [] }], objections: [], strengths: ['运维面最小'] }),
      judgment('claude', 'r1-astra-1', 'A', { constraintChecks: [{ constraintId: 'H1', status: 'pass', rationale: 'pg_dump 每日备份', evidence: [] }, { constraintId: 'H2', status: 'pass', rationale: '自建数据库', evidence: [] }], objections: [{ id: 'O1', text: '在 4 GB 主机上同时运行数据库与服务，内存余量未量化', severity: 'minor', criterionId: 'performance', verifiable: true, howToVerify: '压测时记录常驻内存', evidence: [] }], strengths: ['扩展空间大'] }),
      judgment('astra', 'r1-claude-1', 'A', { constraintChecks: [{ constraintId: 'H1', status: 'pass', rationale: '需把恢复演练纳入验收', evidence: [{ kind: 'reasoning', ref: 'H1', summary: '恢复时间需要实测' }] }, { constraintId: 'H2', status: 'pass', rationale: '无托管服务', evidence: [] }], objections: [{ id: 'O1', text: '写锁排队时的失败处理只描述了重试，未说明超时后的用户提示', severity: 'minor', criterionId: 'reliability', verifiable: true, howToVerify: '并发写入压测并检查错误响应', evidence: [] }], strengths: ['备份简单可验证'] }),
      judgment('astra', 'r1-astra-1', 'B', { constraintChecks: [{ constraintId: 'H1', status: 'pass', rationale: '标准逻辑备份', evidence: [] }, { constraintId: 'H2', status: 'pass', rationale: '无托管费用', evidence: [] }], objections: [], strengths: [] }),
    ],
    equivalenceGroups: { claude: [], astra: [] },
    anonymization: { seed: 4417, maps: { claude: { A: 'r1-astra-1', B: 'r1-claude-1' }, astra: { A: 'r1-claude-1', B: 'r1-astra-1' } } },
    candidates: [C1, C2],
    decision: { outcome: 'recommend', basis: 'clear', winnerId: 'C1', conditional: false, contenders: ['C1'], displayOrder: ['C1', 'C2'],
      totals: [totalC1, totalC2], cells, constraints: constraintResults,
      pairwise: [{ a: 'C1', b: 'C2', dLo: gap, dHi: gap, aRobustlyPreferred: true }, { a: 'C2', b: 'C1', dLo: -gap, dHi: -gap, aRobustlyPreferred: false }],
      keyUncertainties: [],
      suggestedValidation: { candidateIds: ['C1'], reason: 'C1 明确领先；用 MVP 验证分页读取与备份恢复两项关键假设。', hypotheses: ['物化路径排序可在 200 毫秒内取出 500 条评论的首屏'] },
      selfPreference: [{ judge: 'claude', ownMeanDelta: 0.4, otherMeanDelta: 0.1, index: 0.3, sampleSize: 10 }, { judge: 'astra', ownMeanDelta: 0.1, otherMeanDelta: -0.2, index: 0.3, sampleSize: 10 }],
      explanation: [`推荐 C1：C1（${totalC1.lo.toFixed(2)}）领先 C2（${totalC2.hi.toFixed(2)}）${gap.toFixed(2)} 分，超过平局宽度 δ=0.25。`, '两个候选都满足全部硬约束；C2 的主要代价是需要维护常驻数据库服务。', '「可靠性与可验证性」上两位评审相差 1 分，未达到分歧阈值。'],
      params: commonFields().decisionParams, judges: ['claude', 'astra'], degraded: false, computedAt: t(35.02) },
    docs: { batch: 1, requestSeq: 3, missing: [],
      bases: [{ batch: 1, createdAt: t(51.55), snapshotRef: V2, designRound: 1, candidateIds: ['C1'], candidates: [C1], decision: null, specRefs: [SPEC], jobIds: ['j-C1-1'], confirmReason: null }],
      requests: [
        { kind: 'handbook', version: 1, seq: 1, docRef: 'docs-handbook-v1-5a0e2c91d3', reason: 'initial', revisionNotes: null, previousVersion: null, abandoned: false },
        { kind: 'devdoc', version: 1, seq: 2, docRef: 'docs-devdoc-v1-c84f1b7e20', reason: 'initial', revisionNotes: null, previousVersion: null, abandoned: false },
        { kind: 'prd', version: 1, seq: 3, docRef: 'docs-prd-v1-0f6d93a2b4', reason: 'initial', revisionNotes: null, previousVersion: null, abandoned: false },
      ],
      versions: [
        docVersion('handbook', 't-docs-b1-handbook-v1-r1-claude-a1', 'docs-handbook-v1-5a0e2c91d3', t(58.9), t(78.0), '博客作者（产品负责人）'),
        docVersion('devdoc', 't-docs-b1-devdoc-v1-r2-astra-a1', 'docs-devdoc-v1-c84f1b7e20', t(60.4), t(78.0), '博客作者（产品负责人）'),
        docVersion('prd', 't-docs-b1-prd-v1-r3-claude-a1', 'docs-prd-v1-0f6d93a2b4', t(147.6), t(168.0), '博客作者（产品负责人）；一位常驻读者', ['待确认事项中有 1 项期限待定']),
      ] },
    gates: [
      gate('G1_answers', t(3.45), t(14.2), { action: 'submit' }, { questionCount: 4 }),
      gate('G2_framework', t(35.03), t(51.5), { action: 'validate', candidateIds: ['C1'], specs: [spec], efforts: {}, recheckItemIds: [], reason: '分页读取与备份恢复是两项关键假设，先用 MVP 验证' }, { outcome: 'recommend', computedAt: t(35.02), adjudicationTaskId: null }),
      gate('G3_docs', t(60.45), t(78.0), { action: 'approve', reviewers: '博客作者（产品负责人）', conclusion: '通过', handbookNotes: null, devdocNotes: null, reason: null }),
      gate('G4_final', t(121.9), t(140.0), { action: 'accept', chosenCandidateId: 'C1', jobId: null, manualResults: [{ jobId: 'j-C1-1', criterionId: 'AC4', pass: true, note: '在测试文章上完成发表、回复和审核' }], failureClassOverrides: {}, reason: null }, { jobIds: ['j-C1-1'] }),
      gate('G5_prd', t(147.65), t(168.0), { action: 'approve', reviewers: '博客作者（产品负责人）；一位常驻读者', conclusion: '通过', prdNotes: null, reason: null }),
    ],
    jobBatch: 1,
    jobs: [{ id: 'j-C1-1', runId: BLOG_RUN_ID, batch: 1, candidateId: 'C1', proposalId: 'r1-claude-1', effort: 'max', effortReason: '单一工作流（或工作流相互依赖），使用 Max',
      workspaceDir: `D:\\workbench-demo\\workspaces\\${BLOG_RUN_ID}\\j-C1-1`, gitRepo: true, spec, status: 'passed', taskIds: [buildTask], report, verification,
      manualResults: [{ criterionId: 'AC4', pass: true, note: '在测试文章上完成发表、回复和审核', at: t(140.0), specRef: SPEC, round: 1 }],
      failureClass: 'none', failureClassSource: 'sol', devGuideVersion: 1, createdAt: t(78.0), endedAt: t(121.85),
      preflight: { ok: true, checkedAt: t(78.3), items: [
        { check: 'Node.js', status: 'ok', detail: 'v22.11.0' }, { check: 'npm', status: 'ok', detail: '10.9.0' },
        { check: 'git', status: 'ok', detail: '工作区已初始化为 git 仓库' }, { check: 'SQLite 驱动预编译包', status: 'ok', detail: '可离线安装，无需本机编译工具' },
        { check: '磁盘空间', status: 'ok', detail: '可用 38 GB' },
      ] },
      preflightHistory: [], preflightAudit: [], firstVerification: verification,
      maxRounds: 3, autoRework: false, lightRework: { enabled: false, minutes: 5, capabilityRef: null },
      rounds: [{ round: 1, kind: 'initial', writer: 'sol', buildTaskId: buildTask, evaluateTaskId: null, report, verification, evaluation: null,
        workspaceCommit: '6b1e0f4c2a9d7e3b5c8f1a0d2e4b6c8a9f0e1d2c', treeHash: '3f9c1e7a5b2d4c6e8a0b1d3f5e7c9a2b4d6f8e0a', baselineCommit: '0a1b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4',
        fileTree: BLOG_FILES.filter(file => !file.zipOf).map(file => file.path), diffStat: ' 17 files changed, 1046 insertions(+)', reviewWorkspace: null, reviewIntegrity: null,
        verifiedDefectIds: [], reworkBrief: [], finalReviewInstructions: null, outcome: 'passed', staleReason: null, stoppedReason: null, createdAt: t(78.5), endedAt: t(121.85) }],
      budget: settledBudget(buildTask, t(78.5), t(121.8)), writeLock: null, workspaceCheckpoints: [] }],
    finalChoice: { candidateId: 'C1', reason: '全部验收项通过，单机运维成本最低', at: t(140.0) },
  };

  const trails = {
    't-clarify-claude-a1': trail(byId('t-clarify-claude-a1'), [started('claude-opus-5-5', 'max'), [9, 'tool', '读取需求快照 v1 与参考资料《现有博客部署说明》'], [64, 'message', '复述需求：静态博客 + 自托管评论服务，嵌套回复、分页读取、先审后显。'], [140, 'message', '提出 2 个澄清问题：删除语义、单篇评论量上限。']]),
    't-clarify-astra-a1': trail(byId('t-clarify-astra-a1'), [started('gpt-6.2-astra', 'max'), [12, 'tool', '读取需求快照 v1'], [118, 'message', '反垃圾方式会影响费用和数据外发，需要先确认。'], [190, 'message', '提出 2 个澄清问题：反垃圾方式、是否多实例。']]),
    't-r1-propose-claude-a1': trail(byId('t-r1-propose-claude-a1'), [started('claude-opus-5-5', 'max'), [20, 'tool', '读取需求快照 v2（合并了 4 条回答）'], [210, 'info', '估计已生成 6800 tokens'], [380, 'message', '单机、读多写少：选择 SQLite（WAL）+ 物化路径，备份即复制单文件。'], [500, 'message', '提交 1 个方案，并说明放弃“评论随站点构建”的原因。']]),
    't-r1-propose-astra-a1': trail(byId('t-r1-propose-astra-a1'), [started('gpt-6.2-astra', 'max'), [18, 'tool', '读取需求快照 v2'], [300, 'message', '从后续扩展出发：PostgreSQL + 递归 CTE，计数写入物化视图。'], [640, 'message', '提交 1 个方案，两个工作流互不依赖。']]),
    't-r1-review-claude-a1': trail(byId('t-r1-review-claude-a1'), [started('claude-opus-5-5', 'max'), [15, 'tool', '读取匿名方案 A、B 与评分锚点'], [260, 'message', '方案 A「开发与维护成本」给 2 分：需要维护常驻数据库。'], [470, 'message', '两个方案的 H1、H2 均判定满足。']]),
    't-r1-review-astra-a1': trail(byId('t-r1-review-astra-a1'), [started('gpt-6.2-astra', 'max'), [15, 'tool', '读取匿名方案 A、B 与评分锚点'], [330, 'message', '方案 A「可靠性」给 3 分：写锁排队只描述了重试。'], [560, 'message', '完成评审：未发现违反硬约束的方案。']]),
    't-docs-b1-handbook-v1-r1-claude-a1': trail(byId('t-docs-b1-handbook-v1-r1-claude-a1'), [started('claude-opus-5-5', 'xhigh'), [30, 'tool', '读取已确认框架 C1 与 MVP 规格'], [400, 'message', '完成《架构说明手册》v1：6 个模块、数据流与备份恢复流程。']]),
    't-docs-b1-devdoc-v1-r2-astra-a1': trail(byId('t-docs-b1-devdoc-v1-r2-astra-a1'), [started('gpt-6.2-astra', 'max'), [30, 'tool', '读取已确认框架 C1 与 MVP 规格'], [480, 'message', '完成《开发文档》v1：目录结构、接口约定与 4 项验收的执行方式。']]),
    [buildTask]: trail(byId(buildTask), [started('gpt-6.2-sol', 'max'), [40, 'tool', '写入 package.json、src/store.mjs、src/tree.mjs'], [300, 'tool', '运行 npm install：added 41 packages'], [900, 'message', '评论树查询完成：按 (post_slug, path) 索引一次读取整页。'], [1500, 'tool', '运行 npm test：# pass 24  # fail 0'], [2100, 'tool', '运行 npm run bench -- --comments 500：first page p95 = 41.7 ms'], [2400, 'tool', '运行 npm run backup:verify：restored 500 rows in 2.4 s'], [2590, 'message', '全部命令型验收已在执行日志中通过；AC4 需要人工确认。']]),
    't-docs-b1-prd-v1-r3-claude-a1': trail(byId('t-docs-b1-prd-v1-r3-claude-a1'), [started('claude-opus-5-5', 'xhigh'), [25, 'tool', '读取 G4 接受的作业 j-C1-1、执行日志与人工验收结果'], [420, 'message', '完成 PRD v1：需求 4 条、功能 4 个、验收 5 条，可追溯到执行日志。']]),
  };

  return {
    run: full, trails, docs: BLOG_DOCS, files: { 'j-C1-1': BLOG_FILES },
    prd: {
      checklist: [
        { ok: true, text: '目标与问题证据一致，本期做与不做已确认', note: '背景段落均有来源，本期边界已写明' },
        { ok: true, text: '需求、功能、验收及指标编号可相互追踪', note: '需求 4 条、功能 4 个、验收 5 条、指标 2 个，编号关联已由程序检查' },
        { ok: true, text: '主流程、状态、权限、空态和异常恢复均明确', note: '主流程 3 条；评论状态 4 种；管理员权限 1 种' },
        { ok: true, text: '字段、规则、非功能要求可实现且可测试', note: '非功能要求 2 项均有阈值和验证方法' },
        { ok: true, text: '外部依赖、上线负责人和回退条件已确认', note: '回退方式：停用挂件脚本，评论数据保留' },
        { ok: false, text: '所有待确认事项有负责人和期限；示例已替换', note: '待确认事项 1 项，其中期限待定 1 项；模板占位符已由程序检查' },
      ],
      traceability: [
        { requirementId: 'R-01', requirementName: '发表与回复评论', decision: '纳入', featureIds: ['F-01'], acIds: ['AC-01'], mvpItems: [{ specRef: SPEC, specAcceptanceId: 'AC4', acId: 'AC-01', exec: { status: '通过（你人工确认）', evidence: '', state: 'pass' } }] },
        { requirementId: 'R-02', requirementName: '分页读取评论树', decision: '纳入', featureIds: ['F-02'], acIds: ['AC-02', 'AC-03'], mvpItems: [
          { specRef: SPEC, specAcceptanceId: 'AC1', acId: 'AC-02', exec: { status: '通过（日志核验）', evidence: 'powershell.exe -Command "npm test" → 退出码 0', state: 'pass' } },
          { specRef: SPEC, specAcceptanceId: 'AC2', acId: 'AC-03', exec: { status: '通过（日志核验）', evidence: 'first page p95 = 41.7 ms', state: 'pass' } }] },
        { requirementId: 'R-03', requirementName: '审核与软删除', decision: '纳入', featureIds: ['F-03'], acIds: ['AC-04'], mvpItems: [{ specRef: SPEC, specAcceptanceId: 'AC1', acId: 'AC-04', exec: { status: '通过（日志核验）', evidence: 'moderation.test.mjs 全部通过', state: 'pass' } }] },
        { requirementId: 'R-04', requirementName: '每日备份与恢复', decision: '纳入', featureIds: ['F-04'], acIds: ['AC-05'], mvpItems: [{ specRef: SPEC, specAcceptanceId: 'AC3', acId: 'AC-05', exec: { status: '通过（日志核验）', evidence: 'restored 500 rows in 2.4 s', state: 'pass' } }] },
        { requirementId: 'R-05', requirementName: '评论邮件通知', decision: '延后', featureIds: [], acIds: [], mvpItems: [] },
      ],
    },
    toolLogs: {
      [buildTask]: [
        { seq: 0, type: 'file_change', command: null, exitCode: null, output: null, status: 'completed', paths: ['package.json', 'src/store.mjs', 'src/tree.mjs', 'migrations/001_init.sql'] },
        { seq: 1, type: 'command_execution', command: 'powershell.exe -Command "npm install"', exitCode: 0, output: 'added 41 packages in 6s', status: 'completed', paths: [] },
        { seq: 2, type: 'file_change', command: null, exitCode: null, output: null, status: 'completed', paths: ['src/server.mjs', 'src/moderation.mjs', 'widget/comments.js'] },
        { seq: 3, type: 'command_execution', command: 'powershell.exe -Command "npm test"', exitCode: 0, output: '# tests 24\n# pass 24\n# fail 0', status: 'completed', paths: [] },
        { seq: 4, type: 'command_execution', command: 'powershell.exe -Command "npm run bench -- --comments 500"', exitCode: 0, output: 'seeded 500 comments (depth <= 6)\nfirst page p50 = 18.2 ms\nfirst page p95 = 41.7 ms (500 comments)', status: 'completed', paths: [] },
        { seq: 5, type: 'command_execution', command: 'powershell.exe -Command "npm run backup:verify"', exitCode: 0, output: 'backup written: data/backup-check.sqlite\nrestored 500 rows in 2.4 s\nrow count matches: 500', status: 'completed', paths: [] },
      ],
    },
  };
}
