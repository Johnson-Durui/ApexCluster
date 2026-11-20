/**
 * 模拟场景：不调用任何真实模型，用于验证界面与状态流转（阶段 1）。
 * 所有模拟产出在界面上必须显著标注“模拟数据”（run.mode = 'mock'、task.simulated = true）。
 *
 * 场景与预期结论（与决策算法一一对应，便于界面开发和验收）：
 *   preference          Claude 方案 3.65 vs Astra 方案 3.80，差距 < 0.25 → 按偏好推荐 Claude 的框架
 *   clear               Astra 方案 4.00 明确领先；Claude 的第二个方案被两位评审一致判定违反约束 → 淘汰
 *   needs_verification  Claude 方案“可靠性”两位评审分歧（4 vs 2）→ 暂不推荐；复核后 Astra 上调为 3 → 偏好推荐
 *   needs_adjudication  复核后仍有关键分歧 → Astra Ultra 裁决建议 → G2，规则分数保持不变
 *   single              两边提出同一架构，两位评审都认为等价 → 合并为 1 个候选 → 直接推荐（不凑数）
 *   none_viable         所有方案都被两位评审判定违反硬约束 H1 → 无可行方案
 *   failures            同 clear 的数据，但：Astra 提案第 1 次进程失败；Claude 评审第 1 次输出缺项（触发修复）；
 *                       开发文档第 1 次输出用了工作区外的绝对路径（触发修复）；Sol 构建第 1 次测试失败（实现缺陷），重试后通过
 *
 * 所有场景在 G2 确认后都会先写架构说明手册与开发文档（G3），MVP 在 G4 被接受后再写 PRD（G5）；
 * 文档内容由 mockHandbook / mockDevDoc / mockPrd 按本次运行的材料生成。
 */
import type { DevDocOutput, HandbookOutput, PrdOutput, ProposalOut, QuestionOut } from '../core/schemas.js';
import { FINAL_VERIFICATION_RESERVE_MINUTES } from '../core/context-budget.js';
import type { DesignRole, FailureKind, MvpSpec } from '../core/types.js';
import type { ToolLogItem } from '../core/verify-mvp.js';
import type { DocTaskContext, ModelTaskSpec } from './types.js';

export const MOCK_SCENARIOS: Record<string, { name: string; description: string }> = {
  preference: { name: '接近 → 按偏好', description: '两方案差距在平局区间内，按你的偏好推荐 Claude 的整体框架' },
  clear: { name: '明确领先', description: 'Astra 方案明确领先（偏好不能覆盖）；另有一个方案被一致淘汰' },
  needs_verification: { name: '关键分歧', description: '可靠性评分分歧会改变结论；可演示“复核分歧”' },
  needs_adjudication: { name: 'Astra Ultra 裁决', description: '复核后仍有关键分歧，裁决建议返回 G2，由你最终确认' },
  single: { name: '只有一个最优解', description: '两边提出同一架构，合并为 1 个候选' },
  none_viable: { name: '无可行方案', description: '全部违反硬约束 H1' },
  failures: { name: '故障注入', description: '单端失败、输出修复（评审与开发文档）、MVP 首次失败后重试' },
  light_rework_files_only: { name: 'Grok 轻量返工', description: 'Sol 首轮出现 minor 实现缺陷，Grok 仅修改允许文件并交由 Astra 独立验收' },
};

export class MockFailure extends Error {
  constructor(
    public readonly kind: FailureKind | 'invalid_json' | 'hang',
    message: string,
  ) {
    super(message);
  }
}

type Row = [number | null, number | null, number | null, number | null, number | null];
const CRIT_INDEX: Record<string, number> = { fit: 0, cost: 1, reliability: 2, performance: 3, evolution: 4 };

interface ScenarioDef {
  proposals: Record<DesignRole, (keyof typeof TEMPLATES)[]>;
  scores: Record<string, Record<DesignRole, Row>>;
  /** proposalKey -> judge -> 判定为 fail 的约束序号（0 = H1） */
  fails?: Record<string, Partial<Record<DesignRole, number[]>>>;
  equivalent?: [string, string][];
  /** 复核时的改分：proposalKey|criterionId|judge -> 新分数 */
  recheck?: Record<string, number>;
}

// ------------------------------------------------------------------ 方案模板
function nodeProposal(localId: string, title = '本地 Node 服务 + SQLite + React 单页'): Omit<ProposalOut, 'constraintChecks' | 'assumptions'> {
  return {
    localId,
    title,
    summary: '一个本地 Node.js 进程同时提供 API 和静态页面，数据存 SQLite 单文件；前端 React 单页负责记账、预算和图表。',
    fitWhen: ['单人在本机使用', '希望前后端同一种语言（TypeScript）'],
    notFitWhen: ['需要多设备实时同步', '需要手机原生应用'],
    stack: [
      { layer: '运行时', choice: 'Node.js 22 LTS', reason: 'Windows 安装简单，前后端同语言' },
      { layer: '后端', choice: 'Fastify', reason: '轻量、类型友好' },
      { layer: '存储', choice: 'SQLite（better-sqlite3）', reason: '单文件，备份就是复制文件' },
      { layer: '前端', choice: 'React + Vite', reason: '预算和图表页面交互较多' },
    ],
    modules: [
      { id: 'ui', name: '浏览器界面', responsibility: '记账、预算设置、图表', tech: 'React' },
      { id: 'api', name: '本地 API 服务', responsibility: '校验输入、计算预算、读写数据', tech: 'Fastify' },
      { id: 'import', name: '账单导入', responsibility: '解析 CSV 并去重', tech: 'csv-parse' },
      { id: 'db', name: '数据库', responsibility: '交易、分类、预算持久化', tech: 'SQLite' },
      { id: 'backup', name: '备份导出', responsibility: '复制数据库文件并导出 CSV', tech: null },
    ],
    flows: [
      { from: 'ui', to: 'api', label: '记账/查询（HTTP JSON）', kind: 'call' },
      { from: 'api', to: 'db', label: '读写交易与预算', kind: 'data' },
      { from: 'api', to: 'import', label: '上传 CSV', kind: 'call' },
      { from: 'import', to: 'db', label: '批量写入', kind: 'data' },
      { from: 'backup', to: 'db', label: '读取并导出', kind: 'data' },
    ],
    dataModel: 'transactions(id, date, amount_cents, category_id, note, source_hash)；categories(id, name)；budgets(month, category_id, limit_cents)',
    deployment: '双击 start.cmd 启动本地服务（只监听 127.0.0.1），浏览器打开页面；数据库放在 %LOCALAPPDATA%\\Ledger\\ledger.db',
    tradeoffs: [
      { gain: '前后端同一语言，单人维护简单', cost: '需要安装 Node.js' },
      { gain: 'SQLite 单文件，备份就是复制文件', cost: 'better-sqlite3 是原生模块，Windows 上依赖预编译包' },
    ],
    risks: [{ text: 'better-sqlite3 在没有编译工具的 Windows 上安装失败', severity: 'medium', mitigation: '锁定有 Windows 预编译包的版本，或改用 node:sqlite' }],
    mvpPlan: {
      goal: '验证“记账 → 月度预算汇总”核心闭环能在 Windows 本机跑通',
      scopeIn: ['手动记一笔', '按月汇总并与预算对比', '导入一种银行 CSV 格式'],
      scopeOut: ['多用户', '云同步', '图表美化'],
      acceptance: [
        { id: 'AC1', description: '记账与预算计算的单元测试全部通过', kind: 'command', command: 'npm test', expectExitCode: 0, outputIncludes: null },
        { id: 'AC2', description: '前后端构建成功', kind: 'command', command: 'npm run build', expectExitCode: 0, outputIncludes: null },
        { id: 'AC3', description: '在 Windows 浏览器里完成一次记账并看到当月汇总', kind: 'manual', command: null, expectExitCode: null, outputIncludes: null },
      ],
      hypotheses: [
        { id: 'HY1', text: 'SQLite 驱动在目标 Windows 上无需额外编译工具即可安装', howToVerify: '在干净目录执行 npm install', passCriteria: '安装成功，且没有调用 node-gyp 编译' },
      ],
      workstreams: [
        { id: 'ws1', title: '后端 API 与数据层', dependsOn: [] },
        { id: 'ws2', title: '前端页面（按约定的 API 契约开发）', dependsOn: [] },
      ],
      estimatedEffort: 'Sol 单次运行约 1–2 小时',
    },
  };
}

function pythonProposal(localId: string): Omit<ProposalOut, 'constraintChecks' | 'assumptions'> {
  return {
    localId,
    title: 'Python FastAPI + SQLite + 服务端渲染（HTMX）',
    summary: 'FastAPI 直接渲染页面，HTMX 做局部刷新，几乎不需要前端构建；SQLite 使用标准库驱动，没有原生依赖。',
    fitWhen: ['更熟悉 Python', '界面以表单和表格为主'],
    notFitWhen: ['需要大量拖拽、复杂图表交互'],
    stack: [
      { layer: '运行时', choice: 'Python 3.12', reason: '标准库自带 sqlite3' },
      { layer: '后端', choice: 'FastAPI + Jinja2', reason: '页面和接口在同一处' },
      { layer: '存储', choice: 'SQLite（标准库 sqlite3）', reason: '无原生依赖，Windows 安装零编译' },
      { layer: '前端', choice: 'HTMX', reason: '不需要前端构建链' },
    ],
    modules: [
      { id: 'ui', name: '浏览器页面', responsibility: '表单记账、预算表格', tech: 'HTMX' },
      { id: 'web', name: 'FastAPI 应用', responsibility: '路由、渲染、预算计算', tech: 'FastAPI' },
      { id: 'import', name: '账单导入', responsibility: '解析 CSV 并去重', tech: 'csv（标准库）' },
      { id: 'db', name: '数据库', responsibility: '持久化', tech: 'SQLite' },
    ],
    flows: [
      { from: 'ui', to: 'web', label: '表单提交 / 局部刷新', kind: 'call' },
      { from: 'web', to: 'db', label: '读写', kind: 'data' },
      { from: 'web', to: 'import', label: '上传 CSV', kind: 'call' },
      { from: 'import', to: 'db', label: '批量写入', kind: 'data' },
    ],
    dataModel: '与 Node 方案相同的三张表',
    deployment: '安装 Python 后运行 start.cmd（uvicorn 只监听 127.0.0.1），浏览器访问',
    tradeoffs: [
      { gain: '没有前端构建、没有原生依赖', cost: '复杂交互（如预算拖拽）实现成本较高' },
      { gain: '代码量小', cost: '需要安装 Python 并管理虚拟环境' },
    ],
    risks: [{ text: '交互需求增长后 HTMX 方案需要重写为单页应用', severity: 'low', mitigation: '把预算计算放在独立模块，界面层可替换' }],
    mvpPlan: {
      goal: '验证“记账 → 月度预算汇总”核心闭环能在 Windows 本机跑通',
      scopeIn: ['手动记一笔', '按月汇总并与预算对比', '导入一种银行 CSV 格式'],
      scopeOut: ['多用户', '云同步'],
      acceptance: [
        { id: 'AC1', description: '记账与预算计算的单元测试全部通过', kind: 'command', command: 'python -m pytest', expectExitCode: 0, outputIncludes: null },
        { id: 'AC2', description: '在 Windows 浏览器里完成一次记账并看到当月汇总', kind: 'manual', command: null, expectExitCode: null, outputIncludes: null },
      ],
      hypotheses: [{ id: 'HY1', text: '标准库 sqlite3 在 10 万条交易下，月度汇总 200ms 内完成', howToVerify: '生成 10 万条测试数据并计时', passCriteria: 'p95 < 200ms' }],
      workstreams: [{ id: 'ws1', title: '应用与数据层', dependsOn: [] }],
      estimatedEffort: 'Sol 单次运行约 1 小时',
    },
  };
}

function electronProposal(localId: string): Omit<ProposalOut, 'constraintChecks' | 'assumptions'> {
  const base = nodeProposal(localId, 'Electron 桌面应用 + SQLite');
  return {
    ...base,
    summary: '打包成 Electron 桌面程序，界面与数据都在一个应用里，不需要单独启动服务。',
    stack: [
      { layer: '外壳', choice: 'Electron', reason: '一个安装包，双击即用' },
      { layer: '存储', choice: 'SQLite（better-sqlite3）', reason: '单文件' },
      { layer: '界面', choice: 'React', reason: '复用 Web 技能' },
    ],
    deployment: '安装包（NSIS），开始菜单启动；不通过浏览器访问',
    tradeoffs: [{ gain: '安装体验最好', cost: '安装包大（>100MB），且不是浏览器访问' }],
  };
}

const TEMPLATES = {
  node: nodeProposal,
  node_alt: (id: string) => nodeProposal(id, '单进程 Node（TypeScript）本地 Web 应用 + SQLite'),
  python: pythonProposal,
  electron: electronProposal,
};

// ------------------------------------------------------------------ 场景
const SCENARIOS: Record<string, ScenarioDef> = {
  preference: {
    proposals: { claude: ['node'], astra: ['python'] },
    scores: {
      'claude-1': { claude: [4, 3, 4, 3, 4], astra: [4, 3, 4, 3, 4] },
      'astra-1': { claude: [4, 4, 4, 3, 3], astra: [4, 4, 4, 3, 3] },
    },
  },
  clear: {
    proposals: { claude: ['node', 'electron'], astra: ['python'] },
    scores: {
      'claude-1': { claude: [3, 3, 3, 3, 4], astra: [3, 3, 3, 3, 4] },
      'claude-2': { claude: [4, 3, 3, 3, 3], astra: [4, 3, 3, 3, 3] },
      'astra-1': { claude: [4, 4, 4, 4, 4], astra: [4, 4, 4, 4, 4] },
    },
    fails: { 'claude-2': { claude: [1], astra: [1] } },
  },
  needs_verification: {
    proposals: { claude: ['node'], astra: ['python'] },
    scores: {
      'claude-1': { claude: [4, 4, 4, 3, 3], astra: [4, 4, 2, 3, 3] },
      'astra-1': { claude: [4, 3, 4, 3, 3], astra: [4, 3, 4, 3, 3] },
    },
    recheck: { 'claude-1|reliability|astra': 3 },
  },
  needs_adjudication: {
    proposals: { claude: ['node'], astra: ['python'] },
    scores: {
      'claude-1': { claude: [4, 4, 4, 3, 3], astra: [4, 4, 2, 3, 3] },
      'astra-1': { claude: [4, 3, 4, 3, 3], astra: [4, 3, 4, 3, 3] },
    },
  },
  single: {
    proposals: { claude: ['node'], astra: ['node_alt'] },
    scores: {
      'claude-1': { claude: [4, 4, 4, 4, 4], astra: [4, 4, 4, 4, 4] },
      'astra-1': { claude: [4, 4, 4, 4, 4], astra: [4, 4, 4, 4, 4] },
    },
    equivalent: [['claude-1', 'astra-1']],
  },
  none_viable: {
    proposals: { claude: ['node'], astra: ['python'] },
    scores: {
      'claude-1': { claude: [4, 4, 4, 4, 4], astra: [4, 4, 4, 4, 4] },
      'astra-1': { claude: [4, 4, 4, 4, 4], astra: [4, 4, 4, 4, 4] },
    },
    fails: { 'claude-1': { claude: [0], astra: [0] }, 'astra-1': { claude: [0], astra: [0] } },
  },
};
SCENARIOS.failures = SCENARIOS.clear!;
SCENARIOS.light_rework_files_only = SCENARIOS.clear!;

export function scenarioOf(name: string | null): ScenarioDef {
  return SCENARIOS[name ?? 'preference'] ?? SCENARIOS.preference!;
}

/** r1-claude-2 → claude-2 */
export function proposalKey(proposalId: string): string {
  return proposalId.replace(/^r\d+-/, '');
}

// ------------------------------------------------------------------ 问题
function q(localId: string, topic: QuestionOut['topic'], priority: QuestionOut['priority'], text: string, why: string, options: [string, string, string][], def: string, assumption: string, multi = false): QuestionOut {
  return {
    localId,
    topic,
    priority,
    text,
    whyItMatters: why,
    multiSelect: multi,
    options: options.map(([id, label, implication]) => ({ id, label, implication })),
    defaultOptionIds: [def],
    defaultAssumption: assumption,
  };
}

function clarifyQuestions(role: DesignRole): QuestionOut[] {
  if (role === 'claude') {
    return [
      q('q1', 'data', 'blocking', '数据需要在多台设备之间同步吗？', '决定是否需要服务端/云存储，直接改变整体架构', [
        ['local', '只在这台 Windows 电脑上用', '纯本地架构，最简单'],
        ['lan', '同一局域网内多台设备', '需要本机服务对局域网开放并加访问控制'],
        ['cloud', '需要云端同步', '需要云存储与账号体系，违背“不依赖云服务”的约束'],
      ], 'local', '只在这台电脑上单人使用，不做同步'),
      q('q2', 'users_scale', 'important', '预计会记录多少条交易？', '影响存储与查询方式的选择', [
        ['s', '少于 1 万条', '任何方案都足够'],
        ['m', '1–10 万条', '需要索引与分页'],
        ['l', '超过 10 万条', '需要关注汇总查询性能'],
      ], 's', '少于 1 万条'),
      q('q3', 'integration', 'important', '需要导入银行账单吗？', '决定是否需要导入模块和去重逻辑', [
        ['none', '不需要，全部手动记', '少一个模块'],
        ['csv', '导入 CSV', '需要解析与去重'],
        ['csv_xlsx', 'CSV 和 Excel 都要', '多一个 Excel 解析依赖'],
      ], 'csv', '需要导入一种银行的 CSV 格式'),
    ];
  }
  return [
    q('q1', 'security', 'blocking', '需要登录或多用户吗？', '决定是否需要账号、会话与权限控制', [
      ['none', '不需要（只有我在本机用）', '无需认证，只监听 127.0.0.1'],
      ['local_multi', '本机多账户', '需要简单账号体系'],
      ['remote', '需要从其他设备远程访问', '需要认证与传输加密'],
    ], 'none', '不需要登录，只有本人使用'),
    q('q2', 'team_skills', 'important', '你更熟悉哪种技术栈？', '同等条件下，熟悉的技术维护成本更低', [
      ['ts', 'JavaScript / TypeScript', 'Node 方案维护成本更低'],
      ['py', 'Python', 'Python 方案维护成本更低'],
      ['any', '都可以', '按其他因素选择'],
    ], 'any', '两种都可以'),
    q('q3', 'data', 'optional', '数据怎么备份？', '影响是否需要备份模块', [
      ['manual', '手动导出文件', '最简单'],
      ['auto', '自动定期备份到本地目录', '需要定时任务'],
      ['none', '不需要备份', '数据丢失风险自担'],
    ], 'manual', '手动导出备份'),
  ];
}

// ------------------------------------------------------------------ 构造各阶段输出
function scoreFor(def: ScenarioDef, key: string, judge: DesignRole, criterionId: string): number | null {
  const row = def.scores[key]?.[judge];
  const idx = CRIT_INDEX[criterionId];
  if (!row || idx === undefined) return null;
  return row[idx] ?? null;
}

function failsFor(def: ScenarioDef, key: string, judge: DesignRole, constraintIds: string[]): string[] {
  const idxs = def.fails?.[key]?.[judge] ?? [];
  return idxs.map((i) => constraintIds[i]).filter((x): x is string => !!x);
}

export interface MockProduct {
  output: unknown;
  toolLog: ToolLogItem[];
}

export function mockOutput(spec: ModelTaskSpec): MockProduct {
  const ctx = spec.context;
  const def = scenarioOf(ctx.mockScenario);
  const scenario = ctx.mockScenario ?? 'preference';
  const role = spec.role;
  const isRepair = !!spec.resumeSessionId;

  if (spec.phase === 'probe') return { output: { ok: true, note: '模拟探测' }, toolLog: [] };

  if (spec.phase === 'digest') {
    const sources = ctx.choreSources ?? [];
    const specRef = ctx.spec?.ref ?? sources[0]?.specRef ?? null;
    const workspaceCommit = ctx.workspaceCommit ?? sources[0]?.workspaceCommit ?? null;
    return {
      output: {
        specRef,
        workspaceCommit,
        entries: sources
          .filter(source => source.specRef === specRef && source.workspaceCommit === workspaceCommit && source.text.length > 0)
          .map(source => {
            const quote = source.text.slice(0, 240);
            return { text: `来源 ${source.id}：${quote}`.trim(), sourceId: source.id, quote };
          }),
      },
      toolLog: [],
    };
  }

  if (spec.phase === 'qgroup') {
    const questionIds = [...(ctx.choreQuestionIds ?? [])];
    return {
      output: {
        snapshotRef: ctx.snapshotRef ?? '',
        groups: questionIds.length ? [{ label: '待统一处理', questionIds }] : [],
      },
      toolLog: [],
    };
  }

  if (spec.phase === 'clarify') {
    const r = role as DesignRole;
    return {
      output: {
        snapshotRef: ctx.snapshotRef,
        understanding:
          r === 'claude'
            ? '你要一个只在本机 Windows 上运行、通过浏览器使用的个人记账与预算工具，核心是记账和按月对比预算。'
            : '目标是本地运行的个人财务记录工具：记账、预算、汇总，个人使用。',
        gaps: r === 'claude' ? ['没有说明是否需要多设备同步', '没有说明是否需要导入银行账单'] : ['没有说明是否需要登录', '没有说明备份方式'],
        questions: clarifyQuestions(r),
      },
      toolLog: [],
    };
  }

  if (spec.phase === 'propose') {
    const r = role as DesignRole;
    if (scenario === 'failures' && r === 'astra' && spec.attempt === 1) throw new MockFailure('process_error', '模拟：子进程意外退出（退出码 3221225477）');
    const tpls = def.proposals[r];
    const firstQ = ctx.knownQuestionIds[0] ?? null;
    const proposals: ProposalOut[] = tpls.map((t, i) => {
      const base = TEMPLATES[t](`p${i + 1}`);
      const key = `${r}-${i + 1}`;
      return {
        ...base,
        assumptions: [{ text: '只在本机单人使用，不做同步', questionId: firstQ }],
        constraintChecks: ctx.constraintIds.map((id, ci) => ({
          constraintId: id,
          status: (def.fails?.[key]?.[r] ?? []).includes(ci) ? 'fail' : 'pass',
          note: '提出者自评',
        })),
      } as ProposalOut;
    });
    return {
      output: {
        snapshotRef: ctx.snapshotRef,
        proposals,
        whyThisCount: tpls.length === 1 ? '在当前约束下只有一个方向明显合理，没有凑第二个方案。' : '两个方案在交付形态上有实质差异，值得比较。',
        rejectedAlternatives: [{ title: '云端 SaaS 方案', reason: '违反“不依赖云服务”的约束' }],
        questions:
          r === 'astra'
            ? [q('q9', 'deployment', 'optional', 'Windows 上是否允许安装 Python？', '决定 Python 方案是否可行', [
                ['yes', '可以安装', 'Python 方案可行'],
                ['no', '不能安装额外运行时', '只能用 Node（或打包成单文件）'],
              ], 'yes', '允许安装 Python')]
            : [],
      },
      toolLog: [],
    };
  }

  if (spec.phase === 'review') {
    const judge = role as DesignRole;
    const map = ctx.anonymousMap ?? {};
    const brokenFirst = scenario === 'failures' && judge === 'claude' && !isRepair && spec.attempt === 1;
    const reviews = Object.entries(map).map(([anon, pid]) => {
      const key = proposalKey(pid);
      const failing = failsFor(def, key, judge, ctx.constraintIds);
      return {
        candidateId: anon,
        constraintChecks: ctx.constraintIds.map((id) => ({
          constraintId: id,
          status: failing.includes(id) ? 'fail' : 'pass',
          rationale: failing.includes(id) ? '该方案的交付形态与此约束冲突' : '满足',
          evidence: failing.includes(id) ? [{ kind: 'reasoning', ref: id, summary: '方案“部署与运行”一节与约束文字直接冲突' }] : [],
        })),
        scores: (brokenFirst ? ctx.criterionIds.slice(0, 2) : ctx.criterionIds).map((cid) => {
          const s = scoreFor(def, key, judge, cid);
          return {
            criterionId: cid,
            score: s,
            rationale: s === null ? '缺乏依据，不评分' : `按锚点评为 ${s} 分`,
            evidence: s === null ? [] : [{ kind: 'reasoning', ref: null, summary: `对照评分锚点：${cid}` }],
          };
        }),
        objections:
          scenario === 'needs_verification' && judge === 'astra' && key === 'claude-1'
            ? [
                {
                  id: 'o1',
                  text: 'better-sqlite3 在没有 VS Build Tools 的 Windows 上可能需要本地编译，安装失败会直接阻断使用',
                  severity: 'major',
                  criterionId: 'reliability',
                  verifiable: true,
                  howToVerify: '在干净的 Windows 环境执行 npm install 并观察是否调用 node-gyp',
                  evidence: [{ kind: 'experience', ref: null, summary: '原生模块在 Windows 上的常见安装问题' }],
                },
              ]
            : [],
        strengths: ['范围克制，符合个人自用'],
      };
    });
    const equivalentGroups: string[][] = [];
    for (const [a, b] of def.equivalent ?? []) {
      const anonA = Object.entries(map).find(([, pid]) => proposalKey(pid) === a)?.[0];
      const anonB = Object.entries(map).find(([, pid]) => proposalKey(pid) === b)?.[0];
      if (anonA && anonB) equivalentGroups.push([anonA, anonB]);
    }
    return { output: { snapshotRef: ctx.snapshotRef, equivalentGroups, reviews, questions: [] }, toolLog: [] };
  }

  if (spec.phase === 'recheck') {
    const judge = role as DesignRole;
    const map = ctx.anonymousMap ?? {};
    const items = (ctx.recheckItems ?? []).map((it) => {
      const key = proposalKey(map[it.anonymousId] ?? '');
      if (it.kind === 'cell' && it.criterionId) {
        const revised = def.recheck?.[`${key}|${it.criterionId}|${judge}`];
        const orig = scoreFor(def, key, judge, it.criterionId);
        const score = revised ?? orig;
        return {
          itemId: it.id,
          revisedScore: score,
          revisedStatus: null,
          changed: revised !== undefined && revised !== orig,
          rationale: revised !== undefined ? '看过对方的理由后：失败处理比我原先认为的完整，上调 1 分' : '维持原评分，理由不变',
          evidence: score === null ? [] : [{ kind: 'reasoning', ref: null, summary: '复核依据' }],
        };
      }
      const failing = failsFor(def, key, judge, ctx.constraintIds);
      return {
        itemId: it.id,
        revisedScore: null,
        revisedStatus: it.constraintId && failing.includes(it.constraintId) ? 'fail' : 'pass',
        changed: false,
        rationale: '维持原判定',
        evidence: [{ kind: 'reasoning', ref: it.constraintId, summary: '复核依据' }],
      };
    });
    return { output: { snapshotRef: ctx.snapshotRef, items, questions: [] }, toolLog: [] };
  }

  if (spec.phase === 'adjudicate') {
    return { output: {
      snapshotRef: ctx.snapshotRef,
      recommendation: {
        candidateId: ctx.adjudication?.candidateIds[0] ?? null,
        rationale: '模拟裁决：建议优先验证该候选的最小闭环，安装风险仍需在 G2 确认后用日志验证。',
      },
      items: (ctx.adjudication?.itemIds ?? []).map(itemId => ({
        itemId,
        verdict: 'unresolved',
        rationale: '双方复核仍保留可靠性分歧，现有推理不足以证明目标 Windows 环境可安装。',
        evidence: [{ kind: 'reasoning', ref: itemId, summary: '双方方案与复核理由的对照（模拟数据）' }],
        verification: '在 G2 确认的隔离工作区执行安装和验收命令，保留退出码及输出。',
      })),
      risks: ['模拟建议不是原型验证结果，也不代表双模型共识。'],
      questions: [],
    }, toolLog: [] };
  }

  if (spec.phase === 'prd' || spec.phase === 'handbook' || spec.phase === 'devdoc') {
    const d = ctx.docs;
    if (!d) throw new MockFailure('process_error', '模拟：缺少文档上下文');
    // failures 场景：开发文档第一次输出用了工作区外的绝对路径 → 工作台退回修复一次
    const broken = scenario === 'failures' && spec.attempt === 1 && !isRepair;
    if (spec.phase === 'prd') return { output: mockPrd(d), toolLog: [] };
    if (spec.phase === 'devdoc') return { output: mockDevDoc(d, broken), toolLog: [] };
    return { output: mockHandbook(d), toolLog: [] };
  }

  if (spec.phase === 'evaluate') {
    const sp = ctx.spec!;
    const round = ctx.evaluation!.round;
    const canReproduce = ctx.evaluation!.canReproduce;
    const failed = new Set(round.verification?.items.filter(item => item.status === 'verified_fail').map(item => item.criterionId));
    const commands = sp.acceptance.filter(item => item.kind === 'command');
    const toolLog: ToolLogItem[] = canReproduce ? commands.map((item, seq) => ({ seq, type: 'command_execution', command: item.command,
      exitCode: failed.has(item.id) ? 1 : (item.expectExitCode ?? 0), output: failed.has(item.id) ? '实现缺陷：模拟断言失败' : `ok ${item.outputIncludes ?? ''}`,
      status: 'completed', paths: [] })) : [];
    const defects = canReproduce ? commands.filter(item => failed.has(item.id)).map((item, index) => ({
      id: `D${index + 1}`, criterionIds: [item.id], severity: 'minor', failureClass: 'implementation_defect', location: 'src/budget.ts',
      evidence: '模拟断言失败', reproduction: { command: item.command!, logSeq: commands.indexOf(item), expectedExitCode: item.expectExitCode ?? 0, outputIncludes: item.outputIncludes }, fix: '修复退款统计并重跑全部验收',
    })) : [];
    return { output: { specRef: sp.ref, round: round.round, workspaceCommit: round.workspaceCommit,
      verdict: !canReproduce ? 'cannot_verify' : defects.length ? 'fail' : 'pass',
      acceptance: sp.acceptance.map(item => ({ criterionId: item.id, status: item.kind === 'manual' ? 'awaiting_manual' : !canReproduce ? 'cannot_verify' : failed.has(item.id) ? 'fail' : 'pass', evidence: '模拟独立核验' })),
      defects, reworkBrief: defects.map(defect => ({ defectIds: [defect.id], instructions: defect.fix })), environmentIssues: [], deviationsNoted: [], questions: [],
    }, toolLog };
  }
  if (spec.phase === 'final_review') {
    const rounds = ctx.finalReview!.rounds;
    return { output: { specRef: ctx.spec!.ref, workspaceCommit: rounds.at(-1)!.workspaceCommit, roundsReviewed: rounds.map(round => round.round),
      verdict: scenario === 'final_review_reject' ? 'reject' : 'accept_with_notes', summary: '模拟终审：框架符合确认范围，人工项仍须用户确认',
      findings: [], frameworkCompliance: 'compliant', reworkNotes: scenario === 'final_review_reject' ? ['模拟终审意见：实现偏离已确认框架'] : [], questions: [],
    }, toolLog: [] };
  }

  // Grok 轻量返工只编辑冻结的允许文件；不运行命令，也不自行宣称验收通过。
  if (spec.phase === 'build' && role === 'grok' && ctx.lightRework) {
    const sp = ctx.spec as MvpSpec;
    return {
      output: {
        specRef: sp.ref,
        summary: '已在允许范围内修复独立评审指出的 minor 实现缺陷，验收交由 Astra 执行。',
        builtComponents: ['修复退款统计'],
        howToRun: { setup: [], run: [], test: [] },
        acceptanceResults: sp.acceptance.map(criterion => ({
          criterionId: criterion.id,
          status: 'not_run',
          evidence: 'Grok 文件编辑会话不执行验收命令；等待 Astra 独立核验。',
        })),
        hypothesisResults: sp.hypotheses.map(hypothesis => ({
          hypothesisId: hypothesis.id,
          status: 'inconclusive',
          evidence: 'Grok 文件编辑会话不验证假设。',
        })),
        failureClass: 'none',
        failureDetail: null,
        deviations: [],
        openIssues: [],
        questions: [],
      },
      toolLog: [{ seq: 0, type: 'file_change', command: null, exitCode: null, output: null, status: 'completed', paths: [...ctx.lightRework.allowedFiles] }],
    };
  }

  // T12 init：模拟模型将每条验收项拆为一个串行里程碑。
  if (spec.phase === 'build' && ctx.buildKind === 'init') {
    const sp = ctx.spec as MvpSpec;
    const count = sp.acceptance.length;
    // 模拟计划同时留出最终验收与本次 init 的时间，不把整段规格时间分给里程碑。
    const totalMinutes = Math.max(count, Math.floor(sp.timeboxMinutes) - FINAL_VERIFICATION_RESERVE_MINUTES - 1);
    const baseMinutes = count ? Math.floor(totalMinutes / count) : 0;
    const extraMinutes = count ? totalMinutes % count : 0;
    return {
      output: {
        specRef: sp.ref,
        milestones: sp.acceptance.map((criterion, index) => ({
          id: `M${index + 1}`,
          title: `实现并验证：${criterion.description}`,
          acceptanceIds: [criterion.id],
          dependsOn: index === 0 ? [] : [`M${index}`],
          paths: criterion.kind === 'command' ? ['src', 'tests'] : ['src'],
          minutes: Math.min(35, Math.max(1, baseMinutes + (index < extraMinutes ? 1 : 0))),
        })),
        notes: ['模拟计划按验收项串行拆分，并为最终整轮验收保留独立会话。'],
      },
      toolLog: [],
    };
  }

  // T12 milestone：context.spec 已由编排器收窄为当前验收项；最终整轮验收则传入完整规格。
  if (spec.phase === 'build' && ctx.buildKind === 'milestone') {
    const sp = ctx.spec as MvpSpec;
    const finalVerification = ctx.finalVerification === true;
    const failFirst = !finalVerification && ((scenario === 'failures' && (ctx.buildRound ?? spec.attempt) === 1) || scenario === 'rework_exhausted');
    const commandCriteria = sp.acceptance.filter(criterion => criterion.kind === 'command' && criterion.command);
    const failedCriterionId = failFirst ? commandCriteria[0]?.id ?? null : null;
    let seq = 0;
    const log: ToolLogItem[] = [];
    if (!finalVerification) {
      log.push({ seq: seq++, type: 'file_change', command: null, exitCode: null, output: null, status: 'completed', paths: ['src', 'tests'] });
    }
    for (const criterion of commandCriteria) {
      const failed = criterion.id === failedCriterionId;
      log.push({
        seq: seq++,
        type: 'command_execution',
        command: `powershell.exe -Command "${criterion.command}"`,
        exitCode: failed ? 1 : (criterion.expectExitCode ?? 0),
        output: failed ? '1 failing: 模拟验收失败' : `ok ${criterion.outputIncludes ?? ''}`.trim(),
        status: failed ? 'failed' : 'completed',
        paths: [],
      });
    }
    const milestoneIds = ctx.buildSession?.milestoneIds ?? [];
    return {
      output: {
        specRef: sp.ref,
        summary: finalVerification
          ? '已按当前完整规格重新执行全部验收命令。'
          : failFirst ? '当前里程碑实现完成，但一条验收命令失败。' : '当前里程碑实现及验收完成。',
        builtComponents: finalVerification ? [] : sp.acceptance.map(criterion => criterion.description),
        howToRun: { setup: [], run: finalVerification ? [] : ['npm start'], test: commandCriteria.map(criterion => criterion.command!) },
        acceptanceResults: sp.acceptance.map(criterion => ({
          criterionId: criterion.id,
          status: criterion.kind === 'manual' ? 'not_run' : criterion.id === failedCriterionId ? 'fail' : 'pass',
          evidence: criterion.kind === 'manual' ? '人工验收项，等待用户确认' : '见本会话执行日志',
        })),
        hypothesisResults: sp.hypotheses.map(hypothesis => ({ hypothesisId: hypothesis.id, status: 'supported', evidence: '模拟验证未发现反例' })),
        failureClass: failFirst ? 'implementation_defect' : 'none',
        failureDetail: failFirst ? '当前里程碑的模拟验收命令失败' : null,
        deviations: [],
        openIssues: failFirst ? ['修复当前里程碑的失败验收'] : [],
        questions: [],
        milestoneResults: milestoneIds.map(milestoneId => ({
          milestoneId,
          status: failFirst ? 'incomplete' : 'done',
          note: failFirst ? '仍有验收失败，需继续处理' : finalVerification ? '完整规格已重新验证' : '当前有效规格已完成',
        })),
        handoffNotes: [finalVerification ? '最终验收会话未修改源码或进度文件。' : '后续会话应以本次执行日志和程序验证结果为准。'],
      },
      toolLog: log,
    };
  }

  // 常规 build（Sol）：保留原有模拟输出兼容性。
  const sp = ctx.spec as MvpSpec;
  const failFirst = ((scenario === 'failures' || scenario === 'light_rework_files_only') && (ctx.buildRound ?? spec.attempt) === 1) || scenario === 'rework_exhausted';
  let seq = 0;
  const log: ToolLogItem[] = [
    { seq: seq++, type: 'file_change', command: null, exitCode: null, output: null, status: 'completed', paths: ['package.json', 'src/server.ts', 'src/budget.ts', 'tests/budget.test.ts'] },
    { seq: seq++, type: 'command_execution', command: 'powershell.exe -Command "npm install"', exitCode: 0, output: 'added 87 packages', status: 'completed', paths: [] },
  ];
  const commandCriteria = sp.acceptance.filter((a) => a.kind === 'command' && a.command);
  commandCriteria.forEach((a, i) => {
    const bad = failFirst && i === 0;
    log.push({
      seq: seq++,
      type: 'command_execution',
      command: `powershell.exe -Command "${a.command}"`,
      exitCode: bad ? 1 : (a.expectExitCode ?? 0),
      output: bad ? '1 failing: 月度汇总把退款算成了支出' : `ok ${a.outputIncludes ?? ''}`.trim(),
      status: bad ? 'failed' : 'completed',
      paths: [],
    });
  });
  return {
    output: {
      specRef: sp.ref,
      summary: failFirst ? '核心闭环已实现，但月度汇总的退款处理有缺陷，单元测试失败。' : '核心闭环已实现：记账、月度汇总、预算对比、CSV 导入；测试通过。',
      builtComponents: ['本地 API 服务', '预算计算模块', '记账页面', 'CSV 导入'],
      howToRun: { setup: ['npm install'], run: ['npm start'], test: commandCriteria.map((a) => a.command!) },
      acceptanceResults: sp.acceptance.map((a, i) => ({
        criterionId: a.id,
        status: a.kind === 'manual' ? 'not_run' : failFirst && i === 0 ? 'fail' : 'pass',
        evidence: a.kind === 'manual' ? '人工验收项，需要你在浏览器里确认' : '见执行日志',
      })),
      hypothesisResults: sp.hypotheses.map((h) => ({ hypothesisId: h.id, status: 'supported', evidence: '安装过程未调用 node-gyp（模拟）' })),
      failureClass: failFirst ? 'implementation_defect' : 'none',
      failureDetail: failFirst ? '退款记录被计为支出，属于实现缺陷，不是架构问题' : null,
      deviations: [],
      openIssues: failFirst ? ['修复退款统计'] : [],
      questions: [],
    },
    toolLog: log,
  };
}

// ------------------------------------------------------------------ PRD 与架构说明手册（模拟）
const two = (n: number) => String(n).padStart(2, '0');

/**
 * 模拟 PRD：需求来自需求快照里的“核心流程”事实，MVP 验收项逐一挂到验收标准上；
 * 材料中没有的信息（指标基线、发布安排）写成待确认事项。只用材料里给出的来源编号。
 */
export function mockPrd(d: DocTaskContext, broken = false): PrdOutput {
  const allowed = new Set(d.sourceIds);
  const first = d.sourceIds[0] ?? d.docRef;
  const core = d.facts.filter((f) => /^核心流程 \d+：/.test(f.text));
  const reqSrc = core.length ? core : [{ id: first, text: `核心流程 1：${d.title}` }];
  const specRefs = d.specs.map((s) => s.ref);
  const constraintIds = d.constraintIds.filter((id) => allowed.has(id));

  const requirements: PrdOutput['requirements'] = reqSrc.map((f, i) => ({
    id: `R-${two(i + 1)}`,
    name: f.text.replace(/^核心流程 \d+：/, ''),
    sources: [f.id],
    priority: '必需',
    decision: '纳入',
    reason: '核心流程，本期最小闭环不可缺',
    featureIds: [`F-${two(i + 1)}`],
  }));
  const out0 = d.specs.find((s) => s.scopeOut.length);
  if (out0) {
    requirements.push({
      id: `R-${two(requirements.length + 1)}`,
      name: out0.scopeOut[0]!,
      sources: [out0.ref],
      priority: '可延后',
      decision: '延后',
      reason: 'G2 确认的最小 MVP 范围之外；MVP 验证核心闭环后再评估',
      featureIds: [],
    });
  }
  // 修订或重写时保持编号稳定：上一版本有、本版本没有的需求保留为“延后”；
  // 来源在本批材料里找不到时，引用上一版本的记号（例如 PRD-v1），而不是随便找一个编号凑数
  const prev = d.previous as PrdOutput | null;
  const prevToken = d.previousVersion ? `PRD-v${d.previousVersion}` : null;
  for (const r of prev?.requirements ?? []) {
    if (requirements.some((x) => x.id === r.id)) continue;
    const kept = r.sources.filter((s) => allowed.has(s));
    const sources = kept.length ? kept : prevToken && allowed.has(prevToken) ? [prevToken] : [first];
    requirements.push({ ...r, sources, priority: '可延后', decision: '延后', reason: '沿用上一版本的编号；本批 MVP 范围不包含', featureIds: [] });
  }
  requirements.sort((a, b) => a.id.localeCompare(b.id));

  const included = requirements.filter((r) => r.decision === '纳入');
  const features: PrdOutput['features'] = included.map((r, i) => ({
    id: `F-${two(i + 1)}`,
    name: r.name,
    requirementIds: [r.id],
    priority: '必需',
    entry: '主页面',
    scenario: `用户需要完成「${r.name}」时使用本功能；成功标志是页面显示结果且数据已保存`,
    pageStructure: '标题；输入区；操作按钮；结果区',
    fields: [{ name: '说明', format: '文本，必填', defaultValue: '无', validation: '1–200 个字', errorMessage: '请填写说明' }],
    rules: '输入合法时允许提交，否则在字段旁提示错误',
    actions: '“保存”按钮在必填项齐全时可用；处理中显示“保存中”并禁止重复点击',
    success: '提示“已保存”，列表立即出现新记录',
    emptyAndFailure: '无数据时显示引导文字；保存失败时保留已填内容并提示重试',
    duplicateHandling: '同一次提交重试不新增记录（以提交编号去重）',
    acceptanceIds: [`AC-${two(2 * i + 1)}`, `AC-${two(2 * i + 2)}`],
  }));
  const acceptance: PrdOutput['acceptance'] = features.flatMap((f, i) => [
    { id: `AC-${two(2 * i + 1)}`, featureId: f.id, requirementId: f.requirementIds[0]!, type: '正常' as const, given: '用户已打开主页面', when: `完成「${f.name}」并保存`, then: '页面显示结果，数据已保存，刷新后仍在', inMvp: false },
    { id: `AC-${two(2 * i + 2)}`, featureId: f.id, requirementId: f.requirementIds[0]!, type: '异常' as const, given: '必填项为空', when: '点击保存', then: '不保存，字段旁提示“请填写说明”，已填内容保留', inMvp: false },
  ]);
  const mvpAcceptanceMap: PrdOutput['mvpAcceptanceMap'] = [];
  d.specs.forEach((s) =>
    s.acceptance.forEach((a, k) => {
      const ac = acceptance[2 * (k % features.length)];
      if (!ac) return;
      ac.inMvp = true;
      mvpAcceptanceMap.push({ specRef: s.ref, specAcceptanceId: a.id, acId: ac.id });
    }),
  );

  const pending: PrdOutput['pending'] = [
    { item: '核心指标的基线与目标值', relatedIds: ['M-01'], impact: '没有基线就无法判断上线效果；不阻塞 MVP', owner: '你', due: '待定' },
  ];
  if (d.revisionNotes) pending.push({ item: `评审修订意见的处理：${d.revisionNotes}`, relatedIds: [], impact: '已在本版本中调整，请评审人复核', owner: '你', due: '下次评审' });

  return {
    docRef: d.docRef,
    module: '核心闭环',
    plannedVersion: 'MVP',
    background: {
      evidence: { text: `用户提出的需求与核心流程见需求快照：${reqSrc.map((f) => f.text).join('；')}。`, sources: reqSrc.map((f) => f.id) },
      startReason: { text: broken ? '本期启动原因是【填写】' : '先用最小 MVP 验证核心闭环和主要技术假设，再决定是否继续投入。', sources: specRefs.slice(0, 1) },
      goals: { text: `帮助用户完成：${included.map((r) => r.name).join('、')}；观察周期与指标基线待确认。`, sources: included.map((r) => r.id) },
      constraints: { text: constraintIds.length ? '必须满足需求快照中的全部硬约束。' : '用户未声明硬约束；时间与资源限制待确认。', sources: constraintIds },
      nonGoals: { text: `本期不以 MVP 范围外的内容为目标${out0 ? `（例如：${out0.scopeOut.join('、')}）` : ''}。`, sources: out0 ? [out0.ref] : specRefs.slice(0, 1) },
    },
    users: { primary: '提出需求的用户本人', secondary: '无', frequency: '日常使用，频率待确认', uncovered: '多人协作场景（本期不覆盖）' },
    roles: [{ role: '主要用户', scenario: '需要记录或查看信息时打开页面', problem: '目前没有顺手的工具', outcome: '几步内完成核心操作并看到结果', sources: reqSrc.map((f) => f.id).slice(0, 1) }],
    userStories: included.map((r) => ({ text: `作为主要用户，当我需要「${r.name}」时，我希望能直接在页面上完成，以便及时掌握情况。`, sources: r.sources })),
    requirements,
    boundary: {
      mustDeliver: { text: `最小可用范围：${included.map((r) => r.id).join('、')}；完整闭环：从打开页面到看到保存后的结果。`, sources: [...included.map((r) => r.id), ...specRefs.slice(0, 1)] },
      notDoing: { text: out0 ? `本期不做：${out0.scopeOut.join('、')}；原因：不在 G2 确认的最小 MVP 范围；MVP 通过后再评估。` : '本期只做 MVP 范围内的内容。', sources: out0 ? [out0.ref] : specRefs.slice(0, 1) },
      dependencies: [],
    },
    flows: [
      {
        name: '核心使用流程',
        requirementIds: included.map((r) => r.id),
        entry: '主页面',
        precondition: '程序已在本机启动',
        successFlag: '页面显示保存后的结果',
        path: '用户打开页面 → 填写或选择 → 保存 → 系统校验并保存 → 显示结果',
        exceptions: '校验失败时停留在原页面并提示；保存失败时保留内容并可重试',
      },
    ],
    states: { applicable: false, reason: '本期数据只有“已保存”一种状态，没有需要流转的业务状态', rows: [], consistency: '' },
    permissions: { applicable: false, reason: '本机单人使用，没有角色与权限分级', rows: [] },
    features,
    data: {
      objects: [{ object: '核心业务记录', source: '用户在页面输入', uniqueness: '系统生成唯一编号；保存时更新修改时间', access: '仅本机用户可读写；保留期限待确认' }],
      lifecycle: '用户可以新建和修改记录；删除与恢复规则待确认',
      privacy: '数据只保存在本机，不上传；导出格式待确认',
    },
    quality: [{ kind: '可靠性', condition: '保存过程中关闭页面', threshold: '已确认保存的数据不丢失', method: '保存后强制刷新页面并核对记录' }],
    dependencyFailure: { external: '本期没有外部服务依赖', monitoring: '本机日志记录保存失败的原因；不收集个人信息' },
    acceptance,
    mvpAcceptanceMap,
    metrics: [{ id: 'M-01', name: '核心流程完成率', requirementIds: included.slice(0, 1).map((r) => r.id), formula: '成功保存次数 ÷ 开始操作次数', baselineAndTarget: '基线待采集；目标待确认', periodAndSource: '按周；来源为本机日志' }],
    events: [{ name: '记录保存成功', trigger: '数据写入成功后', fields: '记录编号、时间；按记录编号去重', verification: '保存一条记录后核对日志' }],
    release: { applicable: false, reason: '最小 MVP 只在本机验证，暂不发布', scope: '', preconditions: '', rollback: '' },
    ai: { applicable: false, reason: '产品本身不包含 AI 功能', boundary: '', io: '', toolsAndFallback: '', evaluation: '' },
    pending,
  };
}

export function mockHandbook(d: DocTaskContext): HandbookOutput {
  const first = d.sourceIds[0] ?? d.docRef;
  const factIds = d.facts.slice(0, 2).map((f) => f.id);
  const specRefs = d.specs.map((s) => s.ref);
  const pending: HandbookOutput['pending'] = [{ item: 'MVP 验证通过后的正式开发排期', relatedIds: specRefs.slice(0, 1), impact: '决定后续投入', owner: '老板', due: '待定' }];
  if (d.revisionNotes) pending.push({ item: `评审修订意见的处理：${d.revisionNotes}`, relatedIds: [], impact: '已在本版本中调整，请评审人复核', owner: '你', due: '下次评审' });
  return {
    docRef: d.docRef,
    summary: {
      problem: { text: `要解决的问题：${d.facts.map((f) => f.text).slice(0, 2).join('；') || d.title}。`, sources: factIds.length ? factIds : [first] },
      solution: { text: `采用已确认的方案：${d.candidates.map((c) => `${c.id}「${c.title}」`).join('、')}。`, sources: d.candidates.map((c) => c.id) },
      whyThis: { text: '两位架构师独立设计、匿名互评后，该方案在需求适配和维护成本上更合适；具体评分见第 2 章。', sources: d.candidates.map((c) => c.id) },
      costAndTimeline: { text: `最小 MVP 的时间上限约 ${d.specs.map((s) => s.timeboxMinutes).join('、')} 分钟（由 AI 工程师 Sol 构建）；正式开发的投入待 MVP 结果出来后评估。`, sources: specRefs },
      risks: { text: '主要风险是 MVP 尚未验证的技术假设；如果假设不成立，需要回到框架确认重新选择。', sources: specRefs },
      decisionsNeeded: { text: '请确认 MVP 的范围是否合适，以及 MVP 通过后是否继续投入。', sources: [] },
    },
    candidates: d.candidates.map((c) => ({
      candidateId: c.id,
      overview: { text: `${c.title}：各部分职责清楚，可以先做最小版本验证，再逐步完善。`, sources: [c.id] },
      modules: c.modules.map((m) => ({ moduleId: m.id, plainExplanation: `${m.name}：负责方案中这一部分的工作，与其他部分通过约定好的接口配合。` })),
      keyFlows: [{ name: '一次完整的使用', steps: ['用户在页面上完成操作', '系统检查输入并保存', '页面显示保存后的结果'], sources: factIds.length ? factIds.slice(0, 1) : [c.id] }],
      dataAndSecurity: { text: '数据只保存在本机，不上传到云端；服务只允许本机访问。', sources: d.constraintIds.filter((id) => d.sourceIds.includes(id)).slice(0, 1) },
      operations: { text: '日常使用只需启动程序；备份方式待确认。', sources: [] },
      quality: { text: 'MVP 用自动化命令和人工检查两种方式验收，结果以执行日志为准（待 MVP 验证）。', sources: specRefs },
    })),
    glossary: [
      { term: 'MVP', explanation: '最小可行产品：只包含验证核心价值所需的最少功能。' },
      { term: '接口（API）', explanation: '程序各部分之间约定好的“对话方式”。' },
    ],
    pending,
  };
}

/** 模拟开发文档：逐一覆盖模块，验收命令原样照抄规格，实施步骤对应 MVP 工作流，模块依赖取自方案的数据流 */
export function mockDevDoc(d: DocTaskContext, broken = false): DevDocOutput {
  const allowed = new Set(d.sourceIds);
  return {
    docRef: d.docRef,
    candidates: d.candidates.map((c) => {
      const sp = d.specs.find((s) => s.candidateId === c.id);
      const cmds = (sp?.acceptance ?? []).filter((a) => a.kind === 'command' && a.command).map((a) => a.command!);
      const python = [...c.stack, ...cmds].some((x) => /python|pytest|fastapi/i.test(x));
      const ws = c.workstreams.length ? c.workstreams : [{ id: 'ws1', title: '实现核心闭环', dependsOn: [] }];
      const plan = [
        { id: 'S1', step: `初始化工程：${python ? 'requirements.txt、pytest' : 'package.json、TypeScript、vitest'}、目录结构`, workstreamId: null, dependsOn: [], done: '安装命令成功，空测试可以运行' },
        ...ws.map((w, i) => ({ id: `S${i + 2}`, step: w.title, workstreamId: c.workstreams.length ? w.id : null, dependsOn: ['S1'], done: `${w.title}的单元测试通过` })),
        { id: `S${ws.length + 2}`, step: '集成，并在最后一次修改代码之后原样运行全部验收命令', workstreamId: null, dependsOn: ws.map((_, i) => `S${i + 2}`), done: '全部命令型验收项通过' },
      ];
      const assumption = d.sourceIds.find((id) => /^A\d+$/.test(id) && allowed.has(id));
      const name = (id: string) => c.modules.find((m) => m.id === id)?.name ?? id;
      const known = new Set(c.modules.map((m) => m.id));
      return {
        candidateId: c.id,
        purpose: sp ? sp.goal : `实现候选 ${c.id} 的最小闭环`,
        nonGoals: sp?.scopeOut.length ? sp.scopeOut : ['MVP 规格范围外的一切功能'],
        modules: c.modules.map((m) => {
          const out = c.flows.filter((f) => f.from === m.id && f.to !== m.id && known.has(f.to));
          const inc = c.flows.filter((f) => f.to === m.id && f.from !== m.id && known.has(f.from));
          const parts = [
            ...inc.map((f) => `被 ${f.from}（${name(f.from)}）${f.kind === 'data' ? '读写' : '调用'}：${f.label}`),
            ...out.map((f) => `${f.kind === 'data' ? '读写' : f.kind === 'event' ? '发出事件给' : '调用'} ${f.to}（${name(f.to)}）：${f.label}`),
          ];
          return {
            moduleId: m.id,
            responsibility: `${m.name}：只承担已确认框架中这一部分的职责`,
            interfaces: `${parts.join('；') || '没有与其他模块的直接交互'}。输入输出都有明确的类型；校验失败返回带错误码的结果，不把异常抛到界面。`,
            dependsOn: [...new Set(out.map((f) => f.to))],
            notes: '不跨模块直接读写别的模块的数据',
          };
        }),
        layout: [
          { path: broken ? 'C:\\app\\src' : python ? 'app/' : 'src/', purpose: '源代码，按模块分子目录' },
          { path: 'tests/', purpose: '单元测试与验收测试' },
          { path: 'README.md', purpose: '如何安装、运行、测试，以及人工验收步骤' },
        ],
        dataModel: [{ entity: '核心业务记录', fields: 'id（唯一）、创建时间、内容字段', rules: '保存前校验必填项；按 id 去重' }],
        flows: [{ name: '核心使用流程', steps: ['用户在界面输入', '服务端校验并保存', '界面显示保存后的结果'] }],
        conventions: [
          python ? 'Python 3.12，函数写类型标注' : 'TypeScript 严格模式',
          '所有路径用相对路径，通过标准库拼接，兼容 Windows',
          '命令能在 Windows PowerShell 中运行',
          '面向用户的错误信息用简体中文',
        ],
        plan,
        testPlan: (sp?.acceptance ?? []).map((a) => ({
          acceptanceId: a.id,
          approach: a.kind === 'command' ? '自动化测试覆盖该验收项；最后一次修改代码之后原样运行' : '在 README 写清人工检查步骤，交给用户确认',
          command: a.kind === 'command' ? a.command : null,
        })),
        hypothesisChecks: (sp?.hypotheses ?? []).map((h) => ({ hypothesisId: h.id, method: `写一个可重复运行的测量脚本，按通过标准判断：${h.passCriteria}` })),
        commands: python
          ? { setup: ['python -m pip install -r requirements.txt'], run: ['python -m app'], test: cmds.length ? cmds : ['python -m pytest'] }
          : { setup: ['npm install'], run: ['npm start'], test: cmds.length ? cmds : ['npm test'] },
        pitfalls: [{ risk: '在最后一次修改代码之前运行验收命令', avoid: '所有修改完成后，再按顺序原样运行全部验收命令' }],
        openQuestions: assumption ? [{ question: '采用默认假设实现是否可以', defaultDecision: '按默认假设实现，并在构建报告中注明', relatedIds: [assumption] }] : [],
      };
    }),
  };
}
