# RoomDesk 开发指南

## 1. 目录

```
roomdesk/
├─ index.html                  页面骨架（相对路径引用 src/ 下的文件）
├─ package.json                只有 test 脚本，没有依赖
├─ README.md
├─ src/
│  ├─ roomdesk-core.mjs        全部业务规则（纯函数）
│  ├─ app.js                   页面交互、渲染、localStorage
│  └─ styles.css               样式
├─ tests/
│  └─ roomdesk-core-test.mjs   node:test 用例
└─ docs/                       PRD、架构、本指南、验收记录、追踪表（交付包内）
```

## 2. 运行

页面是纯静态文件，但浏览器不允许从 `file://` 加载模块脚本，需要任意静态服务器：

```bash
npx serve .            # 或 python -m http.server 8000
```

打开 `http://localhost:<端口>/index.html`。页面只用相对路径，部署到子路径（例如 `https://example.com/tools/roomdesk/`）不需要改任何配置。静态服务器需要把 `.mjs` 以 `text/javascript` 返回，主流服务器默认如此。

## 3. 测试

需要 Node.js 22 或更高版本，不需要安装任何包：

```bash
npm test               # 等同于 node --test "tests/*-test.mjs"
```

期望输出以 `ℹ fail 0` 结束，`ℹ tests` 与 `ℹ pass` 的数目相同。

测试文件以 `-test.mjs` 结尾而不是 `.test.mjs`：Node 的测试运行器认得这种命名，同时不会被上层仓库里按 `*.test.*` 收集用例的其他测试工具误收。新增测试文件请沿用这个命名。

## 4. 约定

1. **规则只写在 `roomdesk-core.mjs`。** `app.js` 只负责“读表单 → 调核心函数 → 渲染结果”。新增规则先写核心函数和测试，再接页面。
2. **核心模块保持纯函数。** 不访问 `document`、`window`、`localStorage`，不调用无参数的 `new Date()` 做判断；需要当前时间时由调用方传入 `now`（`toICalendar` 的 `now` 参数只在调用方省略时取当前时间）。
3. **不修改传入的数组。** `addBooking`、`removeBooking`、`mergeSamples` 都返回新数组。
4. **时间表示统一：** 日期 `YYYY-MM-DD`，时刻 `HH:MM`，比较时用 `parseTime` 转成分钟数。
5. **用户输入一律当作文本渲染。** 页面用 `textContent` / `createElement` 生成节点，不拼接 HTML。
6. **存储读写放在 try/catch 中，** 失败时页面照常工作。
7. **不引入依赖、不加构建步骤、不加载外部字体或 CDN。**
8. 用户可见文字用中文；代码注释说明“为什么”，不复述代码。

## 5. 新增楼层或会议室

1. 在 `src/roomdesk-core.mjs` 的 `FLOORS` 中追加楼层，例如 `Object.freeze({ id: 'f7', name: '7 层', zone: '会议中心' })`。`id` 必须唯一。
2. 在 `ROOMS` 中用 `room(id, floorId, name, capacity, equipment)` 追加会议室，`floorId` 指向已有楼层，`id` 唯一。
3. 页面无需改动：楼层页签、日程板分组和表单里的会议室下拉框都由这两个数组生成。
4. 更新测试 `全部楼层返回 3 层共 8 间会议室` 中的数量；如果新楼层要有示例预约，在 `SAMPLE_PLAN` 中追加一行，并确认 `示例数据全部带示例标记、字段合法且互不冲突` 仍然通过。
5. 运行 `npm test`，再在浏览器里切到新楼层页签看一眼。

## 6. 调整预约规则

修改 `RULES` 即可，例如把最长时长改为 3 小时：`maxDuration: 3 * 60`。表单下拉选项、校验文案、建议算法和日程板刻度都读取 `RULES`。同时更新对应的边界测试（`时长上限 4 小时：恰好 4 小时通过，超过被拒绝`）。

## 7. iCal 相关

- 新增文本属性时必须经过 `escapeText`，并让整行经过 `foldLine`；`toICalendar` 已对每一行统一折行。
- 不要在核心模块里写 `\n` 作为行尾，行尾只在 `toICalendar` 里用 CRLF 连接。
- 需要 UTC 形式时调用 `toICalendar(bookings, { utc: true })`。

## 8. 本地存储

- 键名带版本号：`roomdesk:v1:state`、`roomdesk:v1:prefs`。数据结构不兼容时换成 `v2` 新键，并在 `parseState` 中决定是否迁移。
- 调试时可在浏览器控制台执行 `localStorage.removeItem('roomdesk:v1:state')`，或点击页脚“恢复示例数据”。
