// 模拟 Codex CLI（exec --json ... -o <file> -）。行为由环境变量控制：
//   FAKE_MODE = ok | model | effort | auth | build_fail
//   FAKE_OUTPUT_FILE = 最终消息（JSON 文件）
//   FAKE_ARGS_FILE   = 把收到的参数和 stdin 写到这个文件
import { readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
if (argv[0] === '--version') {
  console.log('codex-cli 0.150.0');
  process.exit(0);
}
if (argv[0] === 'login' && argv[1] === 'status') {
  console.log('Logged in using ChatGPT');
  process.exit(0);
}
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const prompt = Buffer.concat(chunks).toString('utf8');
if (process.env.FAKE_ARGS_FILE) writeFileSync(process.env.FAKE_ARGS_FILE, JSON.stringify({ argv, prompt, env: { OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? null, CODEX_API_KEY: process.env.CODEX_API_KEY ?? null, CODEX_WINDOWS_REGISTERED_CORE: process.env.CODEX_WINDOWS_REGISTERED_CORE ?? null } }));

const arg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const model = arg('-m');
const effortArg = argv.find((a) => a.startsWith('model_reasoning_effort='));
const effort = effortArg ? effortArg.split('=')[1] : 'medium';
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const mode = process.env.FAKE_MODE ?? 'ok';

process.stderr.write(`model: ${model}\nreasoning effort: ${effort}\n`);
if (mode === 'effort') {
  process.stderr.write(`error: invalid value '${effort}' for model_reasoning_effort: not supported for this model\n`);
  process.exit(2);
}
if (mode === 'auth') {
  process.stderr.write('Error: Not logged in. Run `codex login` first.\n');
  process.exit(1);
}
out({ type: 'thread.started', thread_id: 'thread-abc' });
out({ type: 'turn.started' });
if (mode === 'model') {
  out({ type: 'turn.failed', error: { message: `The model '${model}' does not exist or you do not have access to it.` } });
  process.exit(1);
}
out({ type: 'item.started', item: { id: 'i1', type: 'reasoning', text: '' } });
out({ type: 'item.completed', item: { id: 'i2', type: 'file_change', changes: [{ path: 'src/app.ts', kind: 'add' }], status: 'completed' } });
const exit = mode === 'build_fail' ? 1 : 0;
out({ type: 'item.started', item: { id: 'i3', type: 'command_execution', command: 'powershell.exe -Command "npm test"', aggregated_output: '', status: 'in_progress' } });
out({ type: 'item.completed', item: { id: 'i3', type: 'command_execution', command: 'powershell.exe -Command "npm test"', aggregated_output: exit ? '1 failing' : '12 passing', exit_code: exit, status: exit ? 'failed' : 'completed' } });
const final = process.env.FAKE_OUTPUT_FILE ? readFileSync(process.env.FAKE_OUTPUT_FILE, 'utf8') : JSON.stringify({ ok: true, note: '探测成功' });
out({ type: 'item.completed', item: { id: 'i4', type: 'agent_message', text: final } });
out({ type: 'turn.completed', usage: { input_tokens: 2000, cached_input_tokens: 100, output_tokens: 500, reasoning_output_tokens: 300 } });
const o = arg('-o');
if (o) writeFileSync(o, final, 'utf8');
process.exit(0);
