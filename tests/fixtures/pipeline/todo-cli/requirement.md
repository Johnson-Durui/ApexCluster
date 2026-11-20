# Todo CLI 离线夹具

请在所选项目的 `demo/` 目录实现一个只使用 Node.js 标准库的待办命令行程序。

- `node demo/cli.mjs add <文字>` 新增一条待办并打印其 JSON。
- `node demo/cli.mjs list` 按创建顺序打印 JSON 数组。
- 数据只保存在 `demo/todos.json`，不访问网络。
- Demo 必须在隔离沙箱中真实执行 add 和 list，并把命令、退出码和输出引用写进 `DEMO_REPORT.md`。
- PRD 使用 `R-001`、`R-002` 和 `AC-001`、`AC-002`，每条 AC 都关联存在的 R。

本夹具由脚本化模型驱动。模型写出的文本和文件必须明确带“模拟数据”标记，Docker 命令回执按真实执行结果登记。
