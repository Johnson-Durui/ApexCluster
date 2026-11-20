# RoomDesk 演示脚本 · 各席位输出

供预设演示脚本按段落流式播放。每段对应一个席位的一个步骤，内容与交付文件（PRD、架构、源码、30 个测试用例）一致。
里程碑约定：M-API = `src/roomdesk-core.mjs`（Sol 实现，Opus 评审）；M-UI = `index.html`、`src/app.js`、`src/styles.css`（Opus 实现，Sol 评审）。

## claude/cluster-start

先核对需求边界：楼层筛选、冲突检测、iCal 导出是三条硬需求，另外要交付 PRD、技术架构、可运行的 Web 应用和自动化测试。
未说明的部分按最小可用来定：单一时区 Asia/Shanghai、数据先存在浏览器本地、不做登录。
发起完整架构集群：Carbon 先给方案，Astra 与 Opus 分别评审后再互相参考。

## carbon/architecture-options

方案一：纯静态单页 + localStorage，规则写成一个纯函数模块，页面和测试共用。优点是零依赖、打开即用、测试快；缺点是数据不跨设备。
方案二：Node 小服务 + SQLite，多人共享同一份预约。优点是真正解决多人冲突；缺点是需要部署和运维，超出“小工具”的范围。
方案三：前端直连团队现有的 CalDAV 日历服务。优点是与日历天然同步；缺点是依赖外部账号和权限，离线无法演示。
建议采用方案一，并把存储格式加版本号（`roomdesk:v1:state`），以后换成方案二时只替换存储层。

## astra/cluster-review

同意 Carbon 的方案一。验收角度补三点：
1. 冲突必须明确用半开区间 [开始, 结束)，否则“10:00 结束、10:00 开始”会被误判。
2. 时段规则要写成可测的常量：08:00–21:00、15 分钟网格、单次最长 4 小时。
3. iCal 要按 RFC 5545 处理转义、75 字节折行和 CRLF，这三项最容易在中文标题上出错，需要专门的用例。

## opus/cluster-review

方案一可行。实现层面的风险在时间计算：建议内部一律用“当天分钟数”，日期只做 `Date.UTC` 日历运算，避免运行环境时区影响测试结果。
冲突时只报错不够，应同时给出最近的空闲时段，否则用户要自己反复试。
示例数据应每次按“今天”生成，不写进存储，避免过几天打开时日程板是空的。

## astra/cross-review

看过 Opus 的意见：赞同“当天分钟数”和每天重新生成示例数据。
对“最近空闲时段”补充一条可验收的定义：同一会议室、时长不变、与原开始时间距离最小，距离相同优先顺延，这样测试结果是确定的。
另外建议导出时附带 VTIMEZONE，并提供 UTC 形式作为兜底。

## opus/cross-review

接受 Astra 对建议时段的定义，算法上在 15 分钟网格上枚举即可，最多 52 个候选，距离开始变大后可以提前结束。
同意附带 VTIMEZONE。补充：ORGANIZER 需要邮件形式的日历地址，本工具不收集联系方式，预约人改写进 DESCRIPTION。
集群结论一致，可以进入 PRD 与架构撰写。

## grok/research-ical

RFC 5545 要点整理：TEXT 值需转义 `\` `;` `,` 和换行，且反斜杠必须最先处理；内容行超过 75 字节（不含 CRLF）要折行，续行以一个空格开头；所有行尾为 CRLF；使用 `TZID` 时必须附带对应的 VTIMEZONE；DTSTAMP 必须是 UTC。

## grok/research-conflict

冲突判断采用半开区间：`aStart < bEnd && bStart < aEnd`。只需比较同一会议室、同一天的记录；单个浏览器内预约量在几百条以内，线性扫描足够，不需要区间树。编辑已有预约时要排除自身 id。

## grok/research-browser

浏览器侧要点：模块脚本不能从 `file://` 加载，需要静态服务器；下载用 Blob + `URL.createObjectURL`，触发后释放；localStorage 在隐私模式或配额满时会抛异常，读写都要 try/catch；页面只用相对路径，才能部署到任意子路径。

## hydrogen/research-layout

日程板布局建议：会议室为行、小时为列，08:00–21:00 共 13 列；1280 宽时右侧固定表单栏约 320 px。窄屏不压缩时间轴，而是在卡片内横向滚动，会议室名称列固定在左侧；不足 45 分钟的会议只显示色块，完整信息放在悬停提示和详情里。

## mini/requirements-check

需求条目提取：按楼层筛选、冲突检测、iCal 导出、PRD、技术架构、可运行 Web 应用、自动化测试，共 7 项，无相互矛盾。未提及且需要默认的：时区、营业时间、单次时长上限、数据存放位置。

## claude/prd-architecture

正在撰写 PRD 与技术架构。
PRD 列出 12 条验收标准 AC-01 至 AC-12，覆盖楼层筛选、时段规则、冲突与建议、我的预约、iCal 导出与格式、本地存储、示例数据与部署。
架构采用纯函数核心 `src/roomdesk-core.mjs` + 页面 `src/app.js`，冲突用半开区间，iCal 映射到 UID、DTSTAMP、DTSTART/DTEND、SUMMARY、LOCATION、DESCRIPTION。

## astra/dev-guide

开发指南已发布：目录结构、运行方式（任意静态服务器）、`npm test`、八条代码约定，以及新增楼层或会议室、调整规则、本地存储版本升级的步骤。
特别说明：测试文件以 `-test.mjs` 结尾，避免被上层仓库按 `*.test.*` 收集用例的工具误收。

## sol/demo

核心路径 Demo 已实现并运行：载入 3 层 8 间会议室，新增 2 条预约；第三条与其中一条重叠，被拒绝并返回建议时段 10:30–11:30。
导出 1 个 VCALENDAR：行尾全部 CRLF，最长物理行 74 字节，中文主题按字节折行后展开与原文一致。

## astra/execution-review

核对 Sol 的 Demo 执行记录：退出码 0，冲突被拒、建议时段与定义一致，iCal 行尾与折行符合要求。
核心路径成立，同意冻结需求契约。

## claude/gate-a-summary

**架构阶段已完成，等待你确认进入实现。**

- PRD：12 条验收标准（AC-01 至 AC-12），明确了不在本期范围的内容。
- 技术架构：纯静态单页，零依赖；规则集中在纯函数模块，页面与测试共用。
- 开发指南：由 Astra 编写。
- 核心路径 Demo：Sol 已实际运行冲突检测与 iCal 导出，Astra 复核通过。
- 需求契约已冻结（第 1 版）。

确认后由 Sol 主持实现，分为 M-API 与 M-UI 两个里程碑，交叉评审后集成。

## sol/implementation-plan

实现计划（依据冻结契约第 1 版）：
1. M-API（我实现，Opus 评审）：`src/roomdesk-core.mjs`，包含规则常量、校验、冲突、建议、示例数据、存储格式、iCal；配套 `tests/roomdesk-core-test.mjs` 和只含 test 脚本的 `package.json`。
2. M-UI（Opus 实现，我评审）：`index.html`、`src/app.js`、`src/styles.css`，只调用核心模块，不重复实现规则。
3. DeepSeek 准备两组测试夹具：边界时段与 iCal 特殊字符样例。
每个里程碑的检查：M-API 跑 `npm test`；M-UI 在子路径下加载页面并检查无横向滚动、无控制台错误。

## opus/plan-review

计划评审通过，无缺陷。
两点确认：M-UI 不得在 `app.js` 中复制任何规则判断；M-API 的 `toICalendar` 需要可注入 `now`，否则 DTSTAMP 无法稳定测试。
里程碑划分清晰，作者与评审分属不同模型家族，符合交叉评审要求。

## deepseek/fixtures-boundaries

边界夹具：08:00–09:00 与 20:00–21:00（应通过）；07:45–08:30、20:30–21:15（超出工作时间）；09:10–10:00（不在网格）；10:00–10:00、11:00–10:00（结束不晚于开始）；09:00–13:00（恰好 4 小时）与 09:00–13:15（超长）；2026-02-30（不存在的日期）。

## deepseek/fixtures-ical

iCal 夹具：标题 `评审：接口, 存储; 发布\回滚` 加换行，期望转义为 `\,` `\;` `\\` `\n`；34 个汉字的长标题用于折行；含 4 字节表情符号的文本用于检查不拆开多字节字符；08:00 的 UTC 换算期望为 `T000000Z`。

## sol/milestone-api

M-API 已提交：`src/roomdesk-core.mjs` 导出 `filterRooms`、`validateSlot`、`validateBooking`、`findConflicts`、`suggestSlot`、`findFreeRooms`、`addBooking`、`parseState`、`toICalendar` 等函数；所有函数不访问 DOM 和存储。
`tests/roomdesk-core-test.mjs` 共 6 组 30 个用例，本地运行 30 通过、0 失败。

## opus/milestone-ui

M-UI 已提交：楼层页签、会议室 × 小时日程板、带实时冲突提示的预约表单、“我的预约”、详情对话框和整天导出。
冲突时给出“改为 10:30–11:30”和“换到 青杉”这类一键建议；预约成功后表单自动移到同一会议室最近的空闲时段。
页面只用相对路径，图标内联，不请求站点根目录的任何文件。

## opus/milestone-review-api

评审 M-API：通过。
已核对半开区间判断、转义顺序（反斜杠最先）、续行空格计入 75 字节、行尾 CRLF；`addBooking` 不修改传入数组。
执行 `npm test`：30 通过、0 失败。无阻断缺陷。

## sol/milestone-review-ui

评审 M-UI：通过。
`app.js` 只调用核心函数，没有重复规则；用户输入全部经 `textContent` 渲染；localStorage 读写都在 try/catch 中。
在子路径下加载页面，1280×720 与 375 px 均无横向滚动，控制台无错误。

## sol/handback

两个里程碑均已集成并通过检查：M-API（`npm test` 30/30）、M-UI（子路径加载、无横向滚动、无控制台错误）。
交回统筹，请安排独立验收。

## astra/acceptance

独立验收结论：12 项验收标准全部通过。
- 自动化：`npm test` 30 通过、0 失败（Node.js 22+）。
- 页面：楼层筛选、冲突提示与一键建议、我的预约、单场与整天 .ics 导出、刷新后保留、存储不可用时的降级提示均已逐项操作验证。
- 下载的 .ics 逐行检查：最长物理行 75 字节，无单独 LF。
已知限制：数据只在当前浏览器；.ics 不含参会人字段。均在 PRD 不在范围内。

## claude/final-summary

**RoomDesk 团队会议室预约已交付。**

- 可运行的 Web 应用：3 层 8 间会议室，按楼层筛选，实时冲突检测与最近空闲时段建议，单场或整天导出 iCal。
- 自动化测试：30 个用例，30 通过、0 失败。
- 文档：PRD（12 条验收标准）、技术架构、开发指南、验收记录、需求追踪表。
- 验收：Astra 独立验收 12/12 通过；追踪表把每条需求对应到源码函数、测试和评审席位。

打开 `index.html`（任意静态服务器）即可使用；`npm test` 可复现测试结果。
