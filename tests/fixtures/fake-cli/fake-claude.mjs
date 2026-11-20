// 模拟 Claude Code CLI（-p --output-format stream-json）。行为由环境变量控制：
//   FAKE_MODE = ok | heartbeat | mismatch | auth | model | unknown_flag | slow
//   FAKE_OUTPUT_FILE = 结构化输出（JSON 文件）
//   FAKE_ARGS_FILE   = 把收到的参数和 stdin 写到这个文件，供测试断言
import { readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
if (argv[0] === '--version') {
  console.log('2.1.290 (Claude Code)');
  process.exit(0);
}
if (argv[0] === 'auth' && argv[1] === 'status') {
  console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }));
  process.exit(0);
}
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const prompt = Buffer.concat(chunks).toString('utf8');
if (process.env.FAKE_ARGS_FILE) writeFileSync(process.env.FAKE_ARGS_FILE, JSON.stringify({ argv, prompt, cwd: process.cwd(), env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? null } }));

const arg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const model = arg('--model');
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const mode = process.env.FAKE_MODE ?? 'ok';
const session = '11111111-2222-3333-4444-555555555555';

if (mode === 'unknown_flag') {
  process.stderr.write("error: unknown option '--permission-prompts'\n");
  process.exit(1);
}
out({ type: 'system', subtype: 'init', model, session_id: session, tools: ['StructuredOutput', 'WebFetch', 'WebSearch'], mcp_servers: [], permissionMode: 'dontAsk', apiKeySource: process.env.FAKE_API_KEY_SOURCE ?? 'none', claude_code_version: '2.1.294' });
out({ type: 'system', subtype: 'status' });
out({ type: 'autocompact_state' });
if (mode === 'heartbeat') {
  out({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 47, text: '绝不能显示的思维内容' });
  out({ type: 'system', subtype: 'thinking_tokens', text: '缺少数字时也绝不能显示' });
  out({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: '88', text: '字符串数字不能接受' });
  out({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: -1, text: '负数不能接受' });
}
if (mode === 'slow') await new Promise((r) => setTimeout(r, 60_000));
if (mode === 'auth') {
  out({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 2, retry_delay_ms: 10, error_status: 401, error: 'authentication_failed', session_id: session });
  out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Not logged in · Please run /login', session_id: session });
  process.exit(1);
}
if (mode === 'limit') {
  out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: "You've hit your limit · resets 5pm (Asia/Shanghai)", session_id: session });
  process.exit(1);
}
if (mode === 'model') {
  out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: `model ${model} not found`, session_id: session });
  process.exit(1);
}
out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'WebSearch', input: { query: 'Windows SQLite 预编译' } }] }, session_id: session });
out({ type: 'assistant', message: { content: [{ type: 'text', text: '已完成' }] }, session_id: session });
const structured = process.env.FAKE_OUTPUT_FILE ? JSON.parse(readFileSync(process.env.FAKE_OUTPUT_FILE, 'utf8')) : { ok: true, note: '探测成功' };
const usedModel = mode === 'mismatch' ? 'claude-opus-4-8' : `${model}-20260922`;
out({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: JSON.stringify(structured),
  structured_output: structured,
  session_id: session,
  total_cost_usd: 0.42,
  usage: { input_tokens: 1200, output_tokens: 800 },
  modelUsage: { [usedModel]: { inputTokens: 1200, outputTokens: 800 }, 'claude-haiku-5-5': { inputTokens: 50, outputTokens: 10 } },
  duration_ms: 1234,
  num_turns: 3,
});
process.exit(0);
