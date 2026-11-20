# 文档 Worker

这是一个无模型、无聊天控制面的本地文档服务。它只接收 JSON 和内联 Base64 文件，不读取宿主路径、不联网抓取资源，也不挂载项目目录或凭证。

## 启动与停止

在项目根目录运行：

```powershell
.\scripts\document-worker.ps1 up
.\scripts\document-worker.ps1 health
.\scripts\document-worker.ps1 smoke
.\scripts\document-worker.ps1 down
```

服务只通过固定目标 TCP gateway 发布到 `http://127.0.0.1:18781`。worker 本体只加入 `internal: true` 网络，没有默认出网路由；gateway 不解析文档，只把 loopback 流量转到固定服务名。健康检查为 `GET /health`，任务接口为 `POST /v1/jobs`。

`/health` 返回 `implementationSha256`。算法是按 POSIX 相对路径排序 `document_worker/**/*.py`，依次向一个 SHA-256 写入 `path + "\\n" + fileBytes`。宿主可用同一算法拒绝源码与镜像实现不一致。

## 请求

请求必须是 `application/json`：

```json
{
  "operation": "read",
  "files": [{"name": "报告.docx", "base64": "..."}]
}
```

支持：

- `read`：读取 PDF、DOCX、XLSX、PPTX、Markdown、HTML、TXT，并返回中文文本和页、工作表、幻灯片来源元数据。
- `create`：从 `document` 生成 DOCX、XLSX、PPTX、Markdown、HTML；也可用单个 XLSX `file` 与 `changes` 修改单元格。
- `convert`：将 Office 文档转换为 PDF，或将支持的文档提取为 Markdown、HTML、TXT。
- `archive`：只打包请求中明确列出的文件；单任务最多 200 个明确且名称唯一的文件，展开总量最多 45 MiB。其他需要 `files` 的操作最多 10 个文件。
- `image_info`：用 Pillow 完整解码 PNG、JPEG、WebP，成功时仅返回 MIME、宽高和 SHA-256；损坏图片不会通过。

成功响应统一为：

```json
{"files":[{"name":"结果.pdf","mime":"application/pdf","base64":"...","sha256":"..."}],"text":"可选","metadata":{}}
```

PPTX 可在 `document.theme` 中提供可选主题样式：`background`、`text`、`accent` 是不带 `#` 的 6 位 RGB，`font` 是字体名称。未提供 theme 时沿用原有生成行为；提供部分字段时，其余字段使用 `FFFFFF`、`1F2937`、`2563EB` 和 `Noto Sans CJK SC`。混合格式请求只把 theme 应用于 PPTX，Word/Excel 等输出保持各自默认样式；若 `formats` 不含 `pptx`，带 theme 的请求会被拒绝。该能力只设置幻灯片背景、标题/正文配色、备注字体和图片边框，不改写 OOXML 原生 theme、母版，不加载模板或任意路径。备注保留默认文字颜色，避免深底浅字主题在白色备注页上不可读。

## 限制与安全

- 单文件最大 20 MiB，请求最大 60 MiB，单任务默认 55 秒。
- 拒绝宿主路径、路径穿越、重复规范化文件名、Office 宏、外部关系、ZIP 炸弹、加密或带主动内容的 PDF。
- 图片仅接收内联 PNG、JPEG、WebP；必须完成真实像素解码，最大 64 MP、单边 16000 像素；不接收 URL、SVG、动画或只有容器头的伪图片。
- worker 和 gateway 均以非 root、只读根文件系统、无 Linux capabilities 和受限 `/tmp` 运行；worker 只在 internal bridge，gateway 只发布宿主 loopback。应用没有下载或 URL 读取入口。
- DOCX 本身不保存稳定页码，因此读取 DOCX 只返回 `document` 来源单元；PDF 才返回真实页来源。
- LibreOffice 转换可证明文件已生成和可再次提取文字，但本服务不声称未经人工渲染检查的视觉排版质量。

## 已固定构建版本

- 基础镜像：`python:3.13-slim-trixie@sha256:ae14d4ce8771606477a81446e7ef429edd6762305fc50c84507c1041fa8285d1`
- 实际 Python：3.13.18
- Debian LibreOffice：25.2.3.2（包版本 `4:25.2.3-2+deb13u8`）
- Python 包：见 `requirements.txt`，直接和传递依赖均使用精确版本；实际镜像与 smoke 记录见 `build-record.json` 和 `verification.json`。
