/**
 * MVP 验收核验：不相信 Sol 的自报，而是用 Codex 事件日志里真实执行过的命令和退出码判断。
 * 规则：命令型验收项必须在“最后一次文件修改之后”被执行过，且退出码/输出符合要求。
 */
import type { BuildReportOutput } from './schemas.js';
import type { AcceptanceVerification, MvpSpec, VerificationResult } from './types.js';

/** 适配器把 CLI 事件转换成的统一工具日志条目（只含已完成的条目，按发生顺序） */
export interface ToolLogItem {
  seq: number;
  type: 'command_execution' | 'file_change' | 'other';
  command: string | null;
  exitCode: number | null;
  output: string | null;
  status: string | null;
  paths: string[];
}

export function normalizeCommand(cmd: string): string {
  return cmd
    .toLowerCase()
    // Windows CLI 会把内层引号写为 \"；先去掉该转义层，保留普通路径反斜杠。
    .replace(/\\(["'`])/g, '$1')
    .replace(/["'`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function fragmentMatches(actual: string, expected: string): boolean {
  const re = new RegExp(`(?:^|[\\s;&|])${escapeRegExp(expected)}(?=$|[\\s;&|])`);
  return re.test(actual);
}

interface ShellToken { value: string; start: number; end: number }

/** 只解析一个直接调用；复合控制、注释、管道、重定向和不闭合引号全部 fail closed。 */
function directShellTokens(command: string, allowCallOperator = false): ShellToken[] | null {
  const tokens: ShellToken[] = [];
  let quote: "'" | '"' | null = null;
  let start = -1;
  let value = '';
  let callOperatorUsed = false;
  const push = (end: number) => {
    if (start >= 0) tokens.push({ value, start, end });
    start = -1;
    value = '';
  };
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]!;
    if (quote) {
      if (char === quote) quote = null;
      else value += char;
      continue;
    }
    if (';|#<>\r\n'.includes(char) || char === '`' || char === '(' || char === ')') return null;
    if (char === '&') {
      const leading = command.slice(0, i).trim() === '' && start < 0 && tokens.length === 0;
      if (!allowCallOperator || callOperatorUsed || !leading || !/\s/.test(command[i + 1] ?? '')) return null;
      callOperatorUsed = true;
      continue;
    }
    if (char === "'" || char === '"') {
      if (start < 0) start = i;
      quote = char;
    } else if (/\s/.test(char)) push(i);
    else {
      if (start < 0) start = i;
      value += char;
    }
  }
  if (quote) return null;
  push(command.length);
  return tokens;
}

function unwrapScript(value: string): string {
  const trimmed = value.trim();
  const quote = trimmed[0];
  return (quote === "'" || quote === '"') && trimmed.at(-1) === quote ? trimmed.slice(1, -1) : trimmed;
}

function isPythonExecutable(value: string): boolean {
  if ([...value].some(char => '$`%!*?[]{}()'.includes(char))) return false;
  const basename = value.replaceAll('\\', '/').split('/').at(-1) ?? '';
  return /^python(?:3(?:\.\d+)?)?(?:\.exe)?$/i.test(basename);
}

function pythonInvocation(script: string): string[] | null {
  let tokens = directShellTokens(script);
  if (!tokens && script.trimStart().startsWith('&')) tokens = directShellTokens(script, true);
  if (!tokens?.length) return null;
  const executable = tokens[0]!.value.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase();
  const powershell = !!executable && ['powershell', 'powershell.exe', 'pwsh', 'pwsh.exe'].includes(executable);
  const cmd = !!executable && ['cmd', 'cmd.exe'].includes(executable);
  if (!powershell && !cmd) return tokens.map(token => token.value.toLowerCase());
  if (tokens.length < 3 || !['-command', '-c', '/c'].includes(tokens[1]!.value.toLowerCase())) return null;
  const payload = unwrapScript(script.slice(tokens[1]!.end));
  const inner = directShellTokens(payload, powershell);
  return inner?.map(token => token.value.toLowerCase()) ?? null;
}

/** 只接受一个直接 Python 调用；pytest 仅放行原始日志中的无缓存插件尾参。 */
function pythonCommandMatches(actual: string, expected: string): boolean {
  const wanted = pythonInvocation(expected);
  const observed = pythonInvocation(actual);
  if (!wanted?.[0] || !observed?.[0] || !isPythonExecutable(wanted[0]) || !isPythonExecutable(observed[0])) return false;
  const expectedTokens = ['python', ...wanted.slice(1)];
  const actualTokens = ['python', ...observed.slice(1)];
  if (actualTokens.length === expectedTokens.length && expectedTokens.every((token, index) => actualTokens[index] === token)) return true;
  const pytest = expectedTokens[1] === '-m' && expectedTokens[2] === 'pytest';
  return pytest && actualTokens.length === expectedTokens.length + 2
    && expectedTokens.every((token, index) => actualTokens[index] === token)
    && actualTokens.at(-2) === '-p' && actualTokens.at(-1) === 'no:cacheprovider';
}

/** 期望命令作为完整片段出现在实际命令中（前后是边界），避免 "npm run test" 误匹配 "npm run test:e2e" */
export function commandMatches(actual: string, expected: string): boolean {
  const a = normalizeCommand(actual);
  const e = normalizeCommand(expected);
  if (!e) return false;
  if (/^python(?=\s|$)/.test(e)) return pythonCommandMatches(actual, expected);
  return fragmentMatches(a, e);
}

export function verifyAcceptance(
  spec: MvpSpec,
  log: ToolLogItem[],
  report: BuildReportOutput | null,
  manual: { criterionId: string; pass: boolean; note: string | null }[] = [],
  now = new Date().toISOString(),
): VerificationResult {
  const lastChange = log.filter((x) => x.type === 'file_change').reduce((m, x) => Math.max(m, x.seq), -1);
  const items: AcceptanceVerification[] = spec.acceptance.map((c) => {
    if (c.kind === 'manual') {
      const m = manual.filter((x) => x.criterionId === c.id).at(-1);
      if (!m) return { criterionId: c.id, status: 'awaiting_user', matchedCommand: null, exitCode: null, outputExcerpt: null, note: '人工验收项：等待你确认' };
      return { criterionId: c.id, status: m.pass ? 'user_pass' : 'user_fail', matchedCommand: null, exitCode: null, outputExcerpt: null, note: m.note ?? '' };
    }
    const expected = c.command ?? '';
    const runs = log.filter((x) => x.type === 'command_execution' && x.command && x.seq > lastChange && commandMatches(x.command, expected));
    const last = runs.at(-1);
    if (!last) {
      const earlier = log.some((x) => x.type === 'command_execution' && x.command && commandMatches(x.command, expected));
      return {
        criterionId: c.id,
        status: 'not_observed',
        matchedCommand: null,
        exitCode: null,
        outputExcerpt: null,
        note: earlier ? '只在最后一次代码修改之前执行过该命令，不能证明最终代码通过' : '执行日志中没有找到该命令',
      };
    }
    const wantExit = c.expectExitCode ?? 0;
    const exitOk = last.exitCode === wantExit;
    const outOk = !c.outputIncludes || (last.output ?? '').includes(c.outputIncludes);
    const excerpt = (last.output ?? '').slice(-800);
    return {
      criterionId: c.id,
      status: exitOk && outOk ? 'verified_pass' : 'verified_fail',
      matchedCommand: last.command,
      exitCode: last.exitCode,
      outputExcerpt: excerpt,
      note: exitOk ? (outOk ? '' : `输出中没有包含「${c.outputIncludes}」`) : `退出码 ${last.exitCode}，期望 ${wantExit}`,
    };
  });

  const selfReportMismatches: string[] = [];
  if (report) {
    for (const r of report.acceptanceResults) {
      const v = items.find((i) => i.criterionId === r.criterionId);
      if (!v) continue;
      if (r.status === 'pass' && (v.status === 'verified_fail' || v.status === 'not_observed')) {
        selfReportMismatches.push(`${r.criterionId}：Sol 自报通过，但日志核验为「${v.status === 'verified_fail' ? '失败' : '未观察到'}」`);
      }
      if (r.status === 'fail' && v.status === 'verified_pass') {
        selfReportMismatches.push(`${r.criterionId}：Sol 自报失败，但日志中最后一次执行是成功的`);
      }
    }
  }

  let verdict: VerificationResult['verdict'];
  if (items.some((i) => i.status === 'verified_fail' || i.status === 'user_fail')) verdict = 'failed';
  else if (items.some((i) => i.status === 'not_observed')) verdict = 'inconclusive';
  else if (items.some((i) => i.status === 'awaiting_user')) verdict = 'awaiting_manual';
  else verdict = 'passed';

  return { verdict, items, selfReportMismatches, computedAt: now };
}
