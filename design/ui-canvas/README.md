# 工作台 UI 设计稿（claude.ai 画布的本地副本）

- 来源：claude.ai 上的 Design 画布 https://claude.ai/artifact/Y45t8pg4wqnxtYcoqq1SLt ，版本 `1791791020-a880`。2026-10-12 原样导出，文件内容未改动。
- 用途：方便其他 AI 或编辑器直接阅读和修改设计稿。

## 先看这里：状态

2026-10-12 已按 v0.4 实现重画（画布版本 `1791792472-d858`），共 14 块画板，新增 `Env`、`RunLive`、`MobileLive`。

- 样式与 `web/src/styles-base.css` 一致；两者冲突时以 `web/` 代码、`web/DESIGN.md` 和 `docs/V04_UI_TEST.md` 为准。
- 产品没有模拟模式（`AGENTS.md` 规则 4），设计稿里也不要加回。
- 设计稿里的运行、问题、候选和分数都是示例数据，不是真实运行结果。
- 每块画板的高度按 1440 / 390 宽度实测，改了内容记得同步调整 `canvas.json` 里的 `h` 和 `$preview`。
- 画布上的改动不会自动同步到这里，这里的改动也不会自动回到画布。

## 文件

`project/canvas.json` 是画布索引，记录每块画板在画布上的位置、尺寸、标题和排列顺序。其余每个 `.dc.html` 是一块画板：

| 文件 | 画板 |
| --- | --- |
| `Main.dc.html` | 首页 · 全部运行 |
| `New.dc.html` | 新建需求 |
| `Tokens.dc.html` | 设计规范（颜色、字体、组件） |
| `RunG1.dc.html` | 运行 · G1 回答澄清问题 |
| `RunProposals.dc.html` | 运行 · 架构方案 |
| `RunCompare.dc.html` | 运行 · 评审对比 |
| `RunG2.dc.html` | 运行 · G2 框架决策与 Ultra 裁决 |
| `RunG3.dc.html` | 运行 · G3 文档确认 |
| `RunG4.dc.html` | 运行 · G4 MVP 验收 |
| `Mobile.dc.html` | 手机 · G1 回答问题（390 宽） |
| `MobileG2.dc.html` | 手机 · G2 框架决策（390 宽） |

画板之间用 `<a href="xxx.dc.html">` 互相跳转。没有上传的图片或字体，外部资源只有 Google Fonts。

## 修改规则（`.dc.html` 格式）

每个文件是一个完整的 HTML 页面，由三部分组成：

1. `<x-dc>` 里的模板：
   - `<helmet>` 里放 `<style>` 和字体 `<link>`。
   - 其余是页面结构。
2. `<script type="text/x-dc" data-dc-script>`：
   - 只能写一个 `class Component extends DCLogic`，用普通 JavaScript，不能 `import`。
   - `renderVals()` 返回模板要用的值和事件函数。
   - 状态用 `this.state` / `this.setState`。
3. 脚本标签上的 `data-props`：
   - 单引号包住的 JSON，`$preview` 写画板尺寸。
   - 其中 `&` 写成 `&amp;`，单引号写成 `&#39;`。

模板语法：

- `{{a.b}}` 只能是点号取值，不能写表达式（`{{a + b}}`、`{{!x}}` 会静默失效），需要计算的值放进 `renderVals()`。
- 循环：`<sc-for list="{{items}}" as="item" hint-placeholder-count="3">…</sc-for>`
- 条件：`<sc-if value="{{cond}}" hint-placeholder-val="{{ true }}">…</sc-if>`
- 事件：`onClick="{{pick}}"`，`pick` 是 `renderVals()` 返回的函数。

几条会静默出错的规则：

- `<head>` 里的 `<script src="./support.js"></script>` 必须原样保留。
- 所有非空元素都要闭合，所有属性都要加引号。
- 界面全部写在 `<x-dc>` 里，不要用脚本生成 DOM（`innerHTML`、`appendChild`）。
- 不要用 `<iframe>`、`<object>`、`<embed>`；图标用内联 SVG，不用 emoji。
- 新增画板要同时做三件事：新建 `.dc.html` 文件，在 `canvas.json` 的 `boards` 里加一项（`x`、`y`、`w`、`h`、`title`），把文件名加进 `order`。删除画板时把这三处都去掉。
- 同一行的画板相隔 80px，行与行相隔 120px。网页类画板加 `"expand": "fill"`，能点击操作的加 `"is_interactive": true`。

## 预览与同步回画布

- `support.js` 是画布的运行时，只在 claude.ai 上提供。本地直接双击打开只能看到未渲染的模板（`{{…}}` 原样显示），要看效果需要同步回画布。
- 同步回画布：在能使用 Artifact 工具的 Claude 会话里，以本目录为 `root`，把改过的 `project/` 文件发布到上面的画布链接。只改布局时才需要一起发 `canvas.json`。
- 如果有人在网页上改过同一块画板，发布会被拒绝。先重新读取画布，把两边的修改合并后再发布。
