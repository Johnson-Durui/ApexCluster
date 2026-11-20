/**
 * 默认评分标准（0–5 锚点）。权重在评分开始前可调，开始评审后锁定（criteriaLockedAt）。
 * 锚点的作用：让“3 分”有可核对的含义；没有依据的项必须给 null，不能取中间值。
 */
import type { Criterion } from './types.js';

export const DEFAULT_CRITERIA: Criterion[] = [
  {
    id: 'fit',
    name: '需求适配',
    weight: 0.3,
    anchors: [
      '无法满足核心流程（通常已被硬约束淘汰）',
      '多个核心流程只能部分满足',
      '有一个核心流程只能部分满足',
      '满足全部核心流程，但至少一个依赖变通或额外组件',
      '满足全部核心流程，只有次要需求需要变通',
      '满足全部硬约束与核心流程，设计直接支撑每个核心流程，无已知冲突',
    ],
  },
  {
    id: 'cost',
    name: '开发与维护成本',
    weight: 0.25,
    anchors: [
      '超出可承受的成本',
      '需要专门运维或多人协作才能维护',
      '多项新技术或多个常驻服务，或依赖不够成熟',
      '需要学习一项新技术或维护一个常驻服务',
      '少量新技术或少量运维工作',
      '单人可在现有技能内维护；依赖少且成熟；无额外运维',
    ],
  },
  {
    id: 'reliability',
    name: '可靠性与可验证性',
    weight: 0.25,
    anchors: [
      '核心行为不可验证',
      '多个关键路径不可验证或没有失败处理',
      '存在已知单点故障或难以测试的关键路径',
      '失败处理一般，部分关键行为难以自动化验证',
      '主要失败场景有处理，自动化测试可覆盖大部分关键行为',
      '关键失败场景有明确处理，核心行为可被自动化测试覆盖，有可观测性',
    ],
  },
  {
    id: 'performance',
    name: '性能与资源成本',
    weight: 0.1,
    anchors: [
      '无法满足目标负载',
      '存在已知瓶颈，难以满足',
      '需要专门优化才能满足',
      '刚好满足目标负载',
      '满足目标并有余量',
      '明显超出目标负载要求，资源占用低',
    ],
  },
  {
    id: 'evolution',
    name: '后续演进',
    weight: 0.1,
    anchors: [
      '无法演进',
      '预期变化需要重写主要部分',
      '预期变化需要较大重构',
      '部分预期变化需要跨模块修改',
      '大部分预期变化可局部修改',
      '模块边界清晰，主要变化方向都可局部修改',
    ],
  },
];

/** 应用用户权重；要求和为 1（界面负责提供“按比例归一化”按钮，这里不静默归一化） */
export function applyWeights(base: Criterion[], weights: Record<string, number> | null): Criterion[] {
  if (!weights) return base.map((c) => ({ ...c, anchors: [...c.anchors] }));
  const out = base.map((c) => ({ ...c, anchors: [...c.anchors], weight: weights[c.id] ?? c.weight }));
  for (const k of Object.keys(weights)) {
    if (!base.some((c) => c.id === k)) throw new Error(`未知评分项：${k}`);
  }
  const sum = out.reduce((a, c) => a + c.weight, 0);
  if (Math.abs(sum - 1) > 1e-3) throw new Error(`评分权重之和必须为 1（当前 ${sum.toFixed(3)}）`);
  // 消除浮点误差：把差额加到权重最大的一项
  const diff = 1 - sum;
  if (diff !== 0) {
    const maxC = out.reduce((a, b) => (b.weight > a.weight ? b : a));
    maxC.weight = Math.round((maxC.weight + diff) * 1e6) / 1e6;
  }
  return out;
}

export function renderCriteriaForPrompt(criteria: Criterion[]): string {
  return criteria
    .map(
      (c) =>
        `- **${c.id}｜${c.name}**（权重 ${Math.round(c.weight * 100)}%）\n` +
        c.anchors.map((a, i) => `  - ${i} 分：${a}`).join('\n'),
    )
    .join('\n');
}
