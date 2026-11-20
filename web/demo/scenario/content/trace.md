# RoomDesk 需求追踪表

测试名格式为“组名 › 用例名”，均在 `tests/roomdesk-core-test.mjs` 中；“浏览器”表示由页面检查验证，见 `ACCEPTANCE.md`。

里程碑分工：**M-API**（`src/roomdesk-core.mjs`）由 Sol 实现、Opus 评审；**M-UI**（`index.html`、`src/app.js`、`src/styles.css`）由 Opus 实现、Sol 评审；Astra 独立验收最终产物。

## 原始需求拆分

| 需求 | 来源（原始需求中的表述） |
|---|---|
| R-01 楼层筛选 | “需要支持按楼层筛选” |
| R-02 冲突检测 | “冲突检测” |
| R-03 iCal 导出 | “iCal 导出” |
| R-04 可运行的 Web 应用 | “完成可运行的 Web 应用” |
| R-05 自动化测试 | “和自动化测试” |
| R-06 PRD 与技术架构 | “先出 PRD 和技术架构” |

## 追踪矩阵

| 需求 | 验收 | 源码（文件 · 函数） | 测试 | 评审席位 |
|---|---|---|---|---|
| R-01 | AC-01 | `roomdesk-core.mjs` · `FLOORS`、`ROOMS`、`filterRooms`；`app.js` · `renderTabs`、`selectFloor` | 楼层筛选 › 全部楼层返回 3 层共 8 间会议室；楼层筛选 › 按楼层筛选只返回该楼层的会议室，并保持原顺序；楼层筛选 › 不存在的楼层返回空列表，最少人数条件同时生效 | Opus（M-API）· Sol（M-UI）· Astra（验收） |
| R-04 | AC-02 | `app.js` · `renderTimeline`、`renderSummary`、`changeViewDate`；`roomdesk-core.mjs` · `bookingsOn`、`addDays` | 浏览器 | Sol（M-UI）· Astra |
| R-02 | AC-03 | `roomdesk-core.mjs` · `RULES`、`validateSlot`、`parseTime` | 时段校验 › 工作时间内、对齐 15 分钟的时段通过校验，08:00 开始与 21:00 结束的边界也允许；时段校验 › 早于 08:00 或晚于 21:00 的时段被拒绝；时段校验 › 不在 15 分钟刻度上的时间被拒绝；时段校验 › 结束不晚于开始时被拒绝；时段校验 › 时长上限 4 小时：恰好 4 小时通过，超过被拒绝 | Opus（M-API）· Astra |
| R-02 | AC-04 | `roomdesk-core.mjs` · `validateBooking`、`isValidDate` | 时段校验 › 完整预约还要求会议室存在、主题和预约人已填写、主题不超过 40 字；时段校验 › 不存在的日期和错误格式的日期被拒绝 | Opus（M-API）· Astra |
| R-02 | AC-05 | `roomdesk-core.mjs` · `overlaps`、`findConflicts` | 冲突检测 › 半开区间：首尾相接不算重叠，有交集才算；冲突检测 › 同一会议室同一天时段重叠即冲突，相邻时段不冲突；冲突检测 › 不同会议室或不同日期互不冲突；冲突检测 › 编辑自身时不与自己冲突 | Opus（M-API）· Astra |
| R-02 | AC-06 | `roomdesk-core.mjs` · `addBooking`；`app.js` · `renderCheck`、`submitForm` | 冲突检测 › 新增有冲突的预约被拒绝，返回冲突与建议，原数组不变；冲突检测 › 新增合法预约返回按时间排序的新数组，删除同样不改原数组；浏览器 | Opus（M-API）· Sol（M-UI）· Astra |
| R-02 | AC-07 | `roomdesk-core.mjs` · `suggestSlot`、`findFreeRooms`；`app.js` · `renderCheck` | 空闲时段建议 › 建议离原开始时间最近、时长相同的空闲时段；空闲时段建议 › 前后距离相同时优先顺延；空闲时段建议 › 超出工作时间的请求被挪回 08:00–21:00 之内；全天占满时返回 null；空闲时段建议 › 同一时段可以换到同楼层其他空闲会议室 | Opus（M-API）· Sol（M-UI）· Astra |
| R-04 | AC-08 | `app.js` · `renderMine`、`cancelBooking`、`armOrRun`、`downloadBooking`；`roomdesk-core.mjs` · `removeBooking` | 冲突检测 › 新增合法预约返回按时间排序的新数组，删除同样不改原数组；浏览器 | Sol（M-UI）· Astra |
| R-03 | AC-09 | `roomdesk-core.mjs` · `toICalendar`、`eventLines`、`toICalLocal`、`toICalUtc`、`shanghaiToUtc`、`icsFileName`；`app.js` · `download` | iCal 导出 › VEVENT 含 UID、UTC 的 DTSTAMP，以及带 TZID=Asia/Shanghai 的起止时间和 VTIMEZONE；iCal 导出 › UTC 形式：08:00（UTC+8）导出为 000000Z，且不带 VTIMEZONE；iCal 导出 › 日历结构完整，行尾一律 CRLF，没有单独的 LF | Opus（M-API）· Sol（M-UI）· Astra |
| R-03 | AC-10 | `roomdesk-core.mjs` · `escapeText`、`foldLine`、`unfoldLines`、`utf8Length` | iCal 导出 › TEXT 转义：反斜杠、分号、逗号、换行；iCal 导出 › 折行：每行不超过 75 字节，续行以空格开头，不拆开多字节字符，展开后与原文一致；iCal 导出 › 导出的 SUMMARY 已转义特殊字符，长中文主题按字节折行 | Opus（M-API）· Astra |
| R-04 | AC-11 | `roomdesk-core.mjs` · `STORAGE_KEY`、`serialiseState`、`parseState`；`app.js` · `readStorage`、`writeStorage`、`persist` | 示例数据与本地存储 › 存储格式可往返，坏数据回退为空，不合法和互相冲突的记录被丢弃；浏览器 | Opus（M-API）· Sol（M-UI）· Astra |
| R-04、R-05 | AC-12 | `roomdesk-core.mjs` · `sampleBookings`、`mergeSamples`；`index.html`（相对路径）；`styles.css`（响应式）；`package.json` · `test` | 示例数据与本地存储 › 示例数据全部带示例标记、字段合法且互不冲突；示例数据与本地存储 › 合并时隐藏已删除的示例，与用户预约冲突的示例让位；`npm test` 全部 30 个用例；浏览器 | Sol（M-UI）· Astra |
| R-06 | — | `docs/PRD.md`、`docs/ARCHITECTURE.md`、`docs/DEV_GUIDE.md` | 不适用（文档） | Carbon、Astra、Opus（架构集群互审）· 关卡 A 由用户确认 |

## 覆盖小结

- 6 条原始需求全部落到验收标准或交付文档；12 条验收标准都有源码位置和验证方式。
- 30 个用例都至少对应一条验收标准；`时段校验 › 时刻解析只接受 HH:MM，并能与分钟数互转` 支撑 AC-03。
- 只能在页面上验证的部分见验收记录中的“浏览器”说明。
