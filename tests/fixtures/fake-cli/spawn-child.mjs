// 启动一个子进程（模拟 CLI 再启动工具进程），打印双方 pid 后挂起；用于验证“结束整个进程树”
import { spawn } from 'node:child_process';
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
process.stdout.write(`${JSON.stringify({ parent: process.pid, child: child.pid })}\n`);
setInterval(() => {}, 1000);
