# RoomDesk 团队会议室预约

一个不依赖任何第三方库的小型 Web 应用：按楼层查看会议室日程，预约时实时检测冲突并给出最近的空闲时段，可把单场会议或整天的预约导出为 iCal（.ics）文件。

页面首次打开时载入 **示例数据**（3 个楼层、8 间会议室，今天和下一个工作日的若干场会议），人名和会议均为虚构，可以删除，也可以用页脚的“恢复示例数据”还原。

## 运行

页面是纯静态文件，用任意静态服务器打开 `index.html` 即可，例如：

```bash
npx serve .
# 或
python -m http.server 8000
```

浏览器的模块脚本不能从 `file://` 直接加载，所以请通过 HTTP 访问。页面只用相对路径，放在任意子路径下也能工作。

## 测试

需要 Node.js 22 或更高版本，不需要 `npm install`：

```bash
npm test
```

它执行 `node --test "tests/*-test.mjs"`，共 30 个用例，覆盖楼层筛选、时段校验、冲突检测、空闲时段建议、本地存储格式和 iCal 导出（转义、75 字节折行、CRLF）。

## 目录

| 路径 | 内容 |
|---|---|
| `index.html` | 页面结构 |
| `src/roomdesk-core.mjs` | 全部业务规则，纯函数，无 DOM 依赖，页面和测试共用 |
| `src/app.js` | 页面交互、渲染和 localStorage 读写 |
| `src/styles.css` | 样式，只用系统字体 |
| `tests/roomdesk-core-test.mjs` | `node:test` 测试 |
| `docs/` | PRD、技术架构、开发指南、验收记录和需求追踪表（随交付包提供） |

## 规则摘要

- 工作时间 08:00–21:00，时间对齐 15 分钟，单次最长 4 小时。
- 同一会议室、同一天的时段按半开区间 `[开始, 结束)` 判断重叠，首尾相接不算冲突。
- 导出的 .ics 使用 `TZID=Asia/Shanghai` 并附带 `VTIMEZONE`。
- 数据只保存在当前浏览器的 localStorage（键名 `roomdesk:v1:state`），不会上传。
