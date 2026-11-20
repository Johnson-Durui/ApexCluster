// Document bodies and job workspace files of the completed blog-comments run (scenario/runs/blog-storage.ts).
// Sample content written for the online demo. The run mock serves these as previews, downloads and a zip.
import type { DemoFile, RunBundle } from './common';

export const BLOG_DOCS: RunBundle['docs'] = {
  'handbook/1': `# 架构说明手册 · 博客评论服务

> 依据：需求快照 v2 · 已确认候选 C1（SQLite（WAL）+ 物化路径评论树 + 单进程 Node 服务）

## 1. 目标与边界

为静态博客提供自托管评论：嵌套回复、按文章分页读取、先审后显。本期只做单实例部署，不做邮件通知和第三方登录。

## 2. 总体结构

| 模块 | 职责 | 技术 |
| --- | --- | --- |
| 评论挂件 | 嵌入文章页，提交与展示评论 | Web Components |
| 评论 API | 发表、回复、分页读取 | Node.js + Fastify |
| 评论树查询 | 按物化路径排序并分页 | SQL |
| 审核队列 | 规则过滤与人工审核 | — |
| 评论库 | 保存评论与审核状态 | SQLite（WAL） |
| 备份任务 | 每日快照与恢复演练 | cron |

## 3. 关键数据流

1. 读者在挂件中提交评论，API 写入状态为 \`pending\` 的记录。
2. 审核规则先打分；命中规则的评论进入人工审核队列，其余自动通过。
3. 读取时按 \`(post_slug, status, path)\` 索引一次取出一页，挂件在浏览器内组装树。

## 4. 备份与恢复（对应 H1）

- 每日 03:00 用 SQLite 在线备份生成快照，上传对象存储并校验大小。
- 每周执行一次恢复演练：下载最新快照、恢复到临时目录、比较评论条数。
- 目标：30 分钟内恢复。MVP 实测 500 条评论恢复用时 2.4 秒。

## 5. 已知取舍

- 不支持多实例并发写入；读者规模增长到需要多实例时，再迁移到独立数据库。
- 评论不可移动到其他父评论下，避免批量改写路径。
`,
  'devdoc/1': `# 开发文档 · 博客评论服务

## 目录结构

\`\`\`
src/server.mjs        HTTP 入口与路由
src/store.mjs         SQLite 连接、迁移与写入
src/tree.mjs          物化路径生成与分页查询
src/moderation.mjs    审核规则与队列
widget/comments.js    评论挂件（Web Component）
scripts/backup.mjs    在线备份与恢复演练
tests/                node:test 单元测试
\`\`\`

## 接口约定

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | /comments?post=slug&page=1 | 已通过的评论，按路径排序，每页 50 条 |
| POST | /comments | 发表评论或回复，返回待审状态 |
| POST | /admin/comments/:id/approve | 管理员通过 |
| DELETE | /admin/comments/:id | 软删除，保留原文 |

## 物化路径规则

- 顶层评论路径为 6 位零填充序号，例如 \`000042\`。
- 回复路径为父路径加 \`.\` 与 6 位序号，例如 \`000042.000003\`。
- 最大嵌套深度 6 层，超过时挂在第 6 层下。

## 验收如何执行

1. \`npm test\`：评论树、分页与审核规则。
2. \`npm run bench -- --comments 500\`：生成 500 条嵌套评论并统计首屏读取 p95。
3. \`npm run backup:verify\`：备份、恢复到临时目录并比较条数。
4. 人工：在测试文章上发表、回复并审核一条评论。
`,
  'prd/1': `# 产品需求文档 · 博客评论

## 背景

博客为静态站点，读者希望在文章下讨论；作者需要在评论公开前过滤垃圾内容。MVP 已在单机上验证读取性能与备份恢复。

## 需求与范围

| 编号 | 需求 | 本期 |
| --- | --- | --- |
| R-01 | 发表与回复评论 | 纳入 |
| R-02 | 分页读取评论树 | 纳入 |
| R-03 | 审核与软删除 | 纳入 |
| R-04 | 每日备份与恢复 | 纳入 |
| R-05 | 评论邮件通知 | 延后 |

## 功能说明

- **F-01 发表与回复**：昵称必填，正文 1–2000 字；回复最多嵌套 6 层。
- **F-02 分页读取**：每页 50 条顶层评论及其回复；首屏 p95 小于 200 毫秒。
- **F-03 审核**：命中规则的评论进入待审队列；管理员可通过或软删除。
- **F-04 备份**：每日自动备份，30 分钟内可恢复。

## 验收标准

| 编号 | 标准 | MVP 结果 |
| --- | --- | --- |
| AC-01 | 发表、回复并审核一条评论 | 通过（人工确认） |
| AC-02 | 单元测试全部通过 | 通过（日志核验） |
| AC-03 | 500 条评论首屏 p95 < 200 毫秒 | 通过，41.7 毫秒 |
| AC-04 | 软删除后原文仍可在后台查看 | 通过（日志核验） |
| AC-05 | 备份恢复演练 30 分钟内完成 | 通过，2.4 秒 |

## 待确认事项

- 评论邮件通知的上线时间（负责人：博客作者，期限待定）。
`,
};

export const BLOG_FILES: DemoFile[] = [
  { path: 'README.md', content: `# comment-service

静态博客的自托管评论服务：嵌套回复、分页读取、先审后显。

## 运行

\`\`\`
npm install
npm run migrate
npm start            # http://127.0.0.1:8787
\`\`\`

## 测试

\`\`\`
npm test
npm run bench -- --comments 500
npm run backup:verify
\`\`\`

在文章模板中加入：

\`\`\`html
<script type="module" src="/comments/widget.js"></script>
<blog-comments post="hello-world"></blog-comments>
\`\`\`
` },
  { path: 'MVP_SPEC.md', content: `# MVP 规格 · spec-7d2c4e91a0b3

目标：验证评论树分页读取、审核流程与备份恢复能在单台主机上满足目标。

| 编号 | 验收 | 方式 |
| --- | --- | --- |
| AC1 | 评论树、分页与审核规则的单元测试全部通过 | npm test |
| AC2 | 单篇 500 条评论时首屏读取 p95 小于 200 毫秒 | npm run bench -- --comments 500 |
| AC3 | 备份恢复演练在 30 分钟内完成且条数一致 | npm run backup:verify |
| AC4 | 在测试博客上发表、回复并审核一条评论 | 人工 |

范围外：邮件通知、第三方登录、多实例部署。
` },
  { path: 'DEV_GUIDE.md', content: `# DEV_GUIDE

本文件由 G3 确认的《开发文档》v1 写入。实现时以 MVP 规格与已确认框架为准。

- 存储：SQLite（WAL），busy_timeout 3000 ms
- 路径：6 位零填充序号，最大嵌套 6 层
- 测试：node:test，不依赖网络
` },
  { path: 'AGENTS.md', content: `# 工作区说明

- 只在本目录内修改文件。
- 命令型验收以执行日志为准，不以自报为准。
- 新增依赖前在报告的 deviations 中说明。
` },
  { path: 'docs/backup-restore.md', content: `# 备份与恢复

1. 每日 03:00 运行 \`node scripts/backup.mjs\`，生成 \`backup-YYYYMMDD.sqlite\`。
2. 上传对象存储后比较文件大小。
3. 恢复：下载快照 → 停止服务 → 替换 data/comments.sqlite → 启动服务。
4. 演练：\`npm run backup:verify\` 会恢复到临时目录并比较条数。
` },
  { path: 'package.json', content: `{
  "name": "comment-service",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node src/server.mjs",
    "migrate": "node src/store.mjs --migrate",
    "test": "node --test tests/",
    "bench": "node scripts/bench.mjs",
    "backup:verify": "node scripts/backup.mjs --verify"
  },
  "dependencies": {
    "fastify": "^5.1.0",
    "better-sqlite3": "^11.5.0"
  }
}
` },
  { path: 'migrations/001_init.sql', content: `CREATE TABLE IF NOT EXISTS comments (
  id          INTEGER PRIMARY KEY,
  post_slug   TEXT    NOT NULL,
  parent_id   INTEGER REFERENCES comments(id),
  path        TEXT    NOT NULL,
  author_name TEXT    NOT NULL,
  body        TEXT    NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'pending',
  created_at  TEXT    NOT NULL,
  deleted_at  TEXT
);
CREATE INDEX IF NOT EXISTS comments_page ON comments (post_slug, status, path);
` },
  { path: 'src/tree.mjs', content: `// 物化路径：顶层 000042，回复 000042.000003；最多 6 层。
export const MAX_DEPTH = 6;

export function childPath(parentPath, seq) {
  const part = String(seq).padStart(6, '0');
  if (!parentPath) return part;
  const depth = parentPath.split('.').length;
  return depth >= MAX_DEPTH ? parentPath : \`\${parentPath}.\${part}\`;
}

export function pageQuery(db, post, page, size = 50) {
  const tops = db.prepare(
    "SELECT path FROM comments WHERE post_slug = ? AND status = 'approved' AND parent_id IS NULL ORDER BY path LIMIT ? OFFSET ?"
  ).all(post, size, (page - 1) * size);
  if (!tops.length) return [];
  const first = tops[0].path;
  const last = tops[tops.length - 1].path + '.~';
  return db.prepare(
    "SELECT * FROM comments WHERE post_slug = ? AND status = 'approved' AND path BETWEEN ? AND ? ORDER BY path"
  ).all(post, first, last);
}
` },
  { path: 'src/moderation.mjs', content: `// 本地审核规则：命中任一规则的评论进入人工审核队列。
const RULES = [
  { id: 'links', test: body => (body.match(/https?:\\/\\//g) ?? []).length > 2 },
  { id: 'keywords', test: body => /(免费领取|加微信|代开发票)/.test(body) },
  { id: 'length', test: body => body.trim().length < 2 },
];

export function review(body) {
  const hits = RULES.filter(rule => rule.test(body)).map(rule => rule.id);
  return { status: hits.length ? 'pending' : 'approved', hits };
}
` },
  { path: 'src/store.mjs', content: `import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';

export function open(file = 'data/comments.sqlite') {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 3000');
  return db;
}

export function migrate(db) {
  db.exec(readFileSync(new URL('../migrations/001_init.sql', import.meta.url), 'utf8'));
}

if (process.argv.includes('--migrate')) migrate(open());
` },
  { path: 'src/server.mjs', content: `import Fastify from 'fastify';
import { open } from './store.mjs';
import { pageQuery } from './tree.mjs';
import { review } from './moderation.mjs';

const db = open();
const app = Fastify();

app.get('/comments', req => pageQuery(db, req.query.post, Number(req.query.page ?? 1)));
app.post('/comments', req => {
  const verdict = review(req.body.body);
  // 写入与路径分配见 store.mjs；此处省略。
  return { status: verdict.status };
});

app.listen({ host: '127.0.0.1', port: 8787 });
` },
  { path: 'scripts/bench.mjs', content: `// 生成 N 条随机嵌套评论，统计首屏读取 p50 / p95。
const count = Number(process.argv[process.argv.indexOf('--comments') + 1] || 500);
console.log(\`seeded \${count} comments (depth <= 6)\`);
` },
  { path: 'scripts/backup.mjs', content: `// 在线备份；--verify 时恢复到临时目录并比较条数。
import { open } from '../src/store.mjs';
const db = open();
await db.backup('data/backup-check.sqlite');
console.log('backup written: data/backup-check.sqlite');
` },
  { path: 'tests/tree.test.mjs', content: `import test from 'node:test';
import assert from 'node:assert/strict';
import { childPath, MAX_DEPTH } from '../src/tree.mjs';

test('top level path is zero padded', () => assert.equal(childPath(null, 42), '000042'));
test('reply appends a segment', () => assert.equal(childPath('000042', 3), '000042.000003'));
test('depth is capped', () => {
  let path = null;
  for (let i = 0; i < MAX_DEPTH + 2; i++) path = childPath(path, 1);
  assert.equal(path.split('.').length, MAX_DEPTH);
});
` },
  { path: 'tests/moderation.test.mjs', content: `import test from 'node:test';
import assert from 'node:assert/strict';
import { review } from '../src/moderation.mjs';

test('plain comment is approved', () => assert.equal(review('写得很清楚，谢谢').status, 'approved'));
test('many links go to the queue', () => assert.equal(review('http://a http://b http://c').status, 'pending'));
` },
  { path: 'widget/comments.js', content: `// <blog-comments post="slug">：读取一页评论并在浏览器内组装树。
class BlogComments extends HTMLElement {
  async connectedCallback() {
    const post = this.getAttribute('post');
    const rows = await (await fetch(\`/comments?post=\${encodeURIComponent(post)}\`)).json();
    this.textContent = \`\${rows.length} 条评论\`;
  }
}
customElements.define('blog-comments', BlogComments);
` },
  { path: 'dist/comment-service-0.1.0.zip', zipOf: ['README.md', 'package.json', 'migrations/001_init.sql', 'src/server.mjs', 'src/store.mjs', 'src/tree.mjs', 'src/moderation.mjs', 'scripts/backup.mjs', 'scripts/bench.mjs', 'widget/comments.js'] },
];
