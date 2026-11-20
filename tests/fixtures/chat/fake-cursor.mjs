import { appendFileSync } from 'node:fs';
if (process.argv.includes('--version')) { console.log('fake-cursor 1'); process.exit(0); }
process.on('exit', () => appendFileSync('fake-exits.txt', 'exit\n'));
let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  const send = value => process.stdout.write(JSON.stringify(value) + '\n');
  send({ type: 'system', subtype: 'init', model: 'fake-grok', cwd: '/workspace' });
  let response;
  if (input.includes('NATIVE_TOOL_TEST')) { send({ type: 'tool_call', name: 'shell' }); setInterval(() => {}, 1000); return; }
  else if (input.includes('REPEAT_TEST')) response = { tool: 'file_write', arguments: { path: 'output.txt', text: 'edited', expectedHash: null } };
  else if (input.includes('READ_MODE_TEST')) response = input.includes('"tool":"file_read"') ? { result: 'read complete' } : { tool: 'file_read', arguments: { path: 'input.txt' } };
  else if (input.includes('VERIFY_MODE_TEST')) response = { tool: 'test_submit', arguments: { executable: process.execPath, args: ['--version'] } };
  else if (!input.includes('宿主回执：[{')) response = { tool: 'file_write', arguments: { path: 'output.txt', text: 'edited', expectedHash: null } };
  else if (!input.includes('"tool":"test_submit"')) response = { tool: 'test_submit', arguments: { executable: process.execPath, args: ['--version'] } };
  else response = { result: 'verified' };
  send({ type: 'result', subtype: 'success', result: JSON.stringify(response) });
});
