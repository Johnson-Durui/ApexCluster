import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MvpSpec } from '../src/core/types.js';
import { commandMatches, verifyAcceptance, type ToolLogItem } from '../src/core/verify-mvp.js';

const expected = 'python -m pytest -q';
const wrapped = String.raw`"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -Command './.venv/Scripts/python.exe -m pytest -q -p no:cacheprovider'`;

test('Python 验收命令识别直接调用、已知包装和 PowerShell 调用操作符', () => {
  assert.equal(commandMatches(wrapped, expected), true);
  assert.equal(commandMatches(String.raw`cmd.exe /c .venv\Scripts\python.exe -m pytest -q`, expected), true);
  assert.equal(commandMatches('python3.12 -m pytest -q', expected), true);
  assert.equal(commandMatches(`powershell.exe -Command '& "C:/Program Files/Python/python.exe" -m pytest -q'`, expected), true);
});

test('Python 验收命令不采信输出、注释、相似程序或不同测试命令', () => {
  for (const actual of [
    'echo python -m pytest -q',
    'echo python -m pytest -q && ./env/python -V',
    'Write-Output "python -m pytest -q"',
    'Write-Output "hello ; python -m pytest -q"',
    '# python -m pytest -q',
    '# ignored ; python -m pytest -q',
    'powershell -Command "<# ignored ; python -m pytest -q #>"',
    'powershell -Command "exit 0; python -m pytest -q"',
    'cmd /c "rem ignored & python -m pytest -q"',
    'cmd /c "exit /b 0 & python -m pytest -q"',
    'echo passed || python -m pytest -q',
    'npm test && ./env/bin/python3 -m pytest -q',
    'powershell -Command "Write-Host python -m pytest -q"',
    './tools/my-python.exe -m pytest -q',
    'python-helper -m pytest -q',
    'python -m unittest -q',
    'python -m pytest tests/unit -q',
    'python -m pytest -qq',
  ]) assert.equal(commandMatches(actual, expected), false, actual);
});

test('pytest 等价调用只允许原始日志使用的安全尾参', () => {
  assert.equal(commandMatches('python -m pytest -q -p no:cacheprovider', expected), true);
  for (const actual of [
    'python -m pytest -q -k smoke',
    'python -m pytest -q -m integration',
    'python -m pytest -q --collect-only',
    'python -m pytest -q tests/unit',
    'python -m pytest -q -p no:warnings',
    'python -m pytest -q -p no:cacheprovider -p no:warnings',
  ]) assert.equal(commandMatches(actual, expected), false, actual);
});

test('Python 验收命令保留包装脚本的引号边界并支持带空格的解释器路径', () => {
  assert.equal(commandMatches(
    `powershell.exe -Command '"C:/Program Files/Python/python.exe" -m pytest -q -p no:cacheprovider'`,
    expected,
  ), true);
  assert.equal(commandMatches(
    `cmd.exe /c "C:\\Program Files\\Python\\python.exe" -m pytest -q`,
    expected,
  ), true);
  assert.equal(commandMatches(
    `powershell.exe -Command 'Write-Output \"python -m pytest -q ; C:/Program Files/Python/python.exe\"'`,
    expected,
  ), false);
  assert.equal(commandMatches(
    `powershell.exe -Command '& "C:/中文 目录/Python/python.exe" -m pytest -q'`,
    expected,
  ), true);
});

test('Python 解释器必须是无展开、无通配符的字面路径', () => {
  const unsafe = [
    `powershell -Command '& "$(exit 0)/python.exe" -m pytest -q'`,
    `powershell -Command "& '$env:TEMP/python.exe' -m pytest -q"`,
    `cmd /c "%PYTHON_HOME%\\python.exe" -m pytest -q`,
    `cmd /c "!PYTHON_HOME!\\python.exe" -m pytest -q`,
    `powershell -Command '& "C:/Python*/python.exe" -m pytest -q'`,
    `powershell -Command '& "C:/Python[0-9]/python.exe" -m pytest -q'`,
  ];
  for (const actual of unsafe) assert.equal(commandMatches(actual, expected), false, actual);

  const spec = {
    acceptance: [{ id: 'ac1', description: 'tests', kind: 'command', command: expected, expectExitCode: 0, outputIncludes: null }],
  } as MvpSpec;
  const log: ToolLogItem[] = [{
    seq: 0, type: 'command_execution', command: unsafe[0]!, exitCode: 0, output: '', status: 'completed', paths: [],
  }];
  assert.equal(verifyAcceptance(spec, log, null).items[0]?.status, 'not_observed');
});

test('虚拟环境 pytest 仍受最后修改、退出码和输出标记约束', () => {
  const spec = {
    acceptance: [{ id: 'ac1', description: 'tests', kind: 'command', command: expected, expectExitCode: 0, outputIncludes: 'passed' }],
  } as MvpSpec;
  const item = (seq: number, exitCode: number, output: string): ToolLogItem => ({
    seq, type: 'command_execution', command: wrapped, exitCode, output, status: exitCode ? 'failed' : 'completed', paths: [],
  });
  assert.equal(verifyAcceptance(spec, [item(0, 0, '68 passed')], null).items[0]?.status, 'verified_pass');
  assert.equal(verifyAcceptance(spec, [item(0, 0, '68 passed'), { seq: 1, type: 'file_change', command: null, exitCode: null, output: null, status: 'completed', paths: ['app.py'] }], null).items[0]?.status, 'not_observed');
  assert.equal(verifyAcceptance(spec, [item(0, 1, '68 passed')], null).items[0]?.status, 'verified_fail');
  assert.equal(verifyAcceptance(spec, [item(0, 0, 'no tests collected')], null).items[0]?.status, 'verified_fail');
});
