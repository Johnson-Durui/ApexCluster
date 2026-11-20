/**
 * 环境探测命令行。
 *   npm run probe                                   只读检查（不调用模型、不花钱）
 *   npm run probe -- --live=claude,astra,sol:max,sol:ultra --yes
 *                                                   最小真实调用（消耗额度；必须带 --yes）
 */
import { loadConfig } from '../config.js';
import type { Effort, ModelRole } from '../core/types.js';
import { liveProbe, probeEnvironment } from '../probe.js';

const args = process.argv.slice(2);
const cfg = loadConfig();
const icon = { ok: '✔', warn: '⚠', error: '✖' } as const;

const env = await probeEnvironment(cfg);
console.log(`平台：${env.platform}  Node：${env.node}`);
for (const f of env.findings) console.log(`${icon[f.level]} ${f.message}${f.detail ? `\n    ${f.detail}` : ''}`);

const liveArg = args.find((a) => a.startsWith('--live='));
if (liveArg) {
  if (!args.includes('--yes')) {
    console.error('\n真实探测会消耗订阅额度。确认后请加 --yes 重新运行。');
    process.exit(2);
  }
  const targets = liveArg
    .slice('--live='.length)
    .split(',')
    .filter(Boolean)
    .map((t) => {
      const [role, effort] = t.split(':') as [ModelRole, Effort | undefined];
      return effort ? { role, effort } : { role };
    });
  const results = await liveProbe(cfg, targets);
  console.log('\n真实探测：');
  for (const r of results) {
    const m = r.meta;
    console.log(
      `${r.status === 'succeeded' && r.outputValid ? icon.ok : icon.error} ${r.role} 请求 ${r.model}/${r.effort} → ${r.status}${r.failure ? `（${r.failure.kind}：${r.failure.message}）` : ''}` +
        `\n    执行端报告型号：${m.reportedModels.join(', ') || '未确认'}（来源：${m.reportedModelSource ?? '无'}，已确认：${m.modelConfirmed ? '是' : '否'}）；强度：${m.reportedEffort ?? '未确认'}；结构化输出：${r.outputValid ? '合法' : '不合法'}；用时 ${Math.round(m.durationMs / 1000)}s`,
    );
  }
}
const hasError = env.findings.some((f) => f.level === 'error');
process.exit(hasError ? 1 : 0);
