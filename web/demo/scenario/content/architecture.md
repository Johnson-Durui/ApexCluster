# RoomDesk 技术架构

版本 1.0 · 对应 PRD 1.0（AC-01 至 AC-12）

## 1. 总体方案

纯静态单页应用，无后端、无构建步骤、无第三方依赖。业务规则全部在一个纯函数模块里，页面和测试共用。

依赖方向：`index.html` → `src/app.js` → `src/roomdesk-core.mjs` ← `tests/roomdesk-core-test.mjs`。

## 2. 模块

| 模块 | 职责 | 约束 |
|---|---|---|
| `src/roomdesk-core.mjs` | 会议室数据、校验、冲突、建议、示例数据、存储格式、iCal | 不访问 DOM、存储和系统时钟，`now` 由参数传入 |
| `src/app.js` | 渲染页签、日程板、表单、我的预约、详情；localStorage；Blob 下载 | 不实现规则，全部调用核心模块 |
| `src/styles.css` | 布局与视觉；三档响应式（>1080、760–1080、<760 px） | 只用系统字体，不加载外部资源 |
| `index.html` | 页面骨架，图标内联为 data URI | 只用相对路径 |

## 3. 数据模型

```js
Floor   { id: 'f2', name: '2 层', zone: '产品与设计' }
Room    { id: 'r203', floorId: 'f2', name: '银杏', capacity: 10, equipment: ['投影', '视频会议', '白板'] }
Booking { id, roomId, date: 'YYYY-MM-DD', start: 'HH:MM', end: 'HH:MM', title, organiser,
          mine?: true, sample?: true, createdAt?: ISO 时间 }
```

- 楼层：2 层（青杉 4 人、白桦 6 人、银杏 10 人）、3 层（云杉 4 人、枫林 8 人、松涛 12 人）、5 层（远山 6 人、星河 20 人）。
- 时间在内部统一换算为“当天 0 点起的分钟数”，日期只做日历运算（`Date.UTC`），不受运行环境时区影响。
- 规则集中在 `RULES`：`dayStart` 480、`dayEnd` 1260、`step` 15、`maxDuration` 240、`titleMax` 40。

## 4. 校验与冲突算法

1. `validateSlot` 一次返回全部问题（`invalid-date`、`invalid-time`、`off-grid`、`end-before-start`、`too-long`、`outside-hours`），表单据此逐条展示原因。`validateBooking` 再加上 `unknown-room`、`missing-title`、`title-too-long`、`missing-organiser`。
2. `overlaps(aStart, aEnd, bStart, bEnd)` 判断半开区间：`aStart < bEnd && bStart < aEnd`。10:00 结束与 10:00 开始不冲突。
3. `findConflicts(bookings, candidate)` 只比较同一会议室、同一天、id 不同的记录，结果按开始时间排序。单个浏览器内只有几百条以内，线性扫描足够。
4. `suggestSlot` 在 08:00–21:00 的 15 分钟网格上枚举与原请求同时长的候选（最多 52 个），跳过冲突项，取与原开始时间距离最小者；距离相同取更晚的（顺延优先）；距离开始变大后提前结束。请求超出工作时间时会被挪回工作时间内。
5. `findFreeRooms` 给出同楼层同时段空闲的其他会议室。
6. `addBooking` 不修改传入数组：先校验，再查冲突，成功时返回新的已排序数组；失败时返回原数组、冲突列表和建议。

## 5. iCal 映射（RFC 5545）

| iCal 属性 | 来源 |
|---|---|
| `UID` | `roomdesk-<booking.id>`（id 为 UUID 或示例 id，全局唯一） |
| `DTSTAMP` | 导出时刻，UTC，形如 `20261120T013000Z` |
| `DTSTART` / `DTEND` | 默认 `;TZID=Asia/Shanghai:20261120T093000`，并附 `VTIMEZONE`（固定 +0800）；`utc: true` 时为 `…Z` 形式且不带 `VTIMEZONE` |
| `SUMMARY` | 会议主题 |
| `LOCATION` | “楼层 会议室”，如 `2 层 银杏` |
| `DESCRIPTION` | 预约人、容纳人数和设备，多行用 `\n` |
| `STATUS` / `TRANSP` | `CONFIRMED` / `OPAQUE` |

- `escapeText`：先把 `\` 转为 `\\`，再转义 `;`、`,` 和换行；顺序反过来会把新加的反斜杠再转义一次。
- `foldLine`：按 UTF-8 字节计数，单个物理行不超过 75 字节，续行以一个空格开头且空格计入 75 字节；按完整字符切分，不拆开多字节字符。
- `toICalendar`：每行先折行，再用 CRLF 连接，文件以 CRLF 结尾。
- 不写 `ORGANIZER` / `ATTENDEE`（需要邮件形式的日历地址，本工具不收集联系方式），预约人写进 `DESCRIPTION`。

## 6. 存储

- `roomdesk:v1:state`：`{ version: 1, bookings: [用户自己的预约], hiddenSamples: [被删除的示例 id] }`。
- `roomdesk:v1:prefs`：当前楼层页签和上次使用的预约人。
- 示例数据不入库，每次按“今天”重新生成（id 由日期和序号决定）；`mergeSamples` 去掉用户删除过的示例和与用户预约冲突的示例。
- 所有读写包在 try/catch 中。`parseState` 对坏 JSON、版本不符、缺字段、互相冲突的记录逐条丢弃；写入失败时页面提示“刷新后会丢失”，功能照常。

## 7. 测试策略

- `tests/roomdesk-core-test.mjs`，`node:test` + `node:assert/strict`，计划 6 组 30 个用例：楼层筛选 3、时段校验 8、冲突检测 6、空闲时段建议 4、示例数据与本地存储 3、iCal 导出 6。
- 只测纯函数，固定 `now`，结果与运行时区无关。
- 关键规则须经变异检查：把半开区间改成闭区间、调换转义顺序、取消续行空格计数、把 CRLF 换成 LF、放宽工作时间或时长上限等改动，每一种都必须让至少一个用例失败（实现阶段由交叉评审与验收核对）。
- 页面在 headless 浏览器中从子路径加载，检查三种宽度下无横向滚动、无控制台错误，并走通预约、刷新、取消和导出。

## 8. 风险与应对

| 风险 | 影响 | 应对 |
|---|---|---|
| 数据只在单个浏览器 | 换设备看不到预约，多人之间不同步 | PRD 已列为不在范围；存储格式带版本号，后续接服务端时可平移 |
| 时区固定 UTC+08:00 | 跨时区团队需要换算 | 提供 UTC 导出形式；时区常量集中在核心模块 |
| 窄屏下日程板过宽 | 手机上看不全 | 日程板容器内横向滚动，会议室名称列固定在左侧，首次打开滚到当前时间附近 |
| localStorage 被禁用或写满 | 新预约刷新后丢失 | 捕获异常并在页脚提示，内存中的功能照常 |
