// 读取全部 stdin，原样（加前缀）写回 stdout；用于验证 UTF-8 与大输入
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const text = Buffer.concat(chunks).toString('utf8');
const mode = process.argv[2] ?? 'normal';
const write = (stream, data) => new Promise((r) => stream.write(data, r));
if (mode === 'bytewise') {
  // 逐字节写出，故意把多字节字符拆到不同的数据块里
  const buf = Buffer.from(`GOT:${text}\n`, 'utf8');
  for (const b of buf) {
    await write(process.stdout, Buffer.from([b]));
    await new Promise((r) => setImmediate(r));
  }
} else {
  await write(process.stdout, `GOT:${text}\n`);
}
await write(process.stderr, 'stderr 行\r\n');
// 用 exitCode 而不是 process.exit()，保证管道里的数据写完再退出
process.exitCode = Number(process.argv[3] ?? 0);
