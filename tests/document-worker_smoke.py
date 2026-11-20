from __future__ import annotations

import base64
import hashlib
import json
import os
import struct
import urllib.request
import urllib.error
import zlib
from pathlib import Path

URL = os.environ.get("DOCUMENT_WORKER_URL", "http://127.0.0.1:18781/v1/jobs")

DOCUMENT = {
    "title": "中文设备巡检",
    "blocks": [
        {"type": "heading", "level": 1, "text": "巡检结论"},
        {"type": "paragraph", "text": "推进器运行正常，未发现异常。"},
        {"type": "table", "rows": [["项目", "状态"], ["推进器", "正常"]]},
    ],
    "sheets": [{"name": "巡检表", "rows": [["项目", "状态"], ["推进器", "正常"]], "widths": [18, 14]}],
    "slides": [{"title": "巡检结论", "body": "推进器运行正常", "notes": "现场复核"}],
}


def png_chunk(kind: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)


PNG_1X1 = base64.b64encode(
    b"\x89PNG\r\n\x1a\n"
    + png_chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
    + png_chunk(b"IDAT", zlib.compress(b"\x00\x0c\x22\x38"))
    + png_chunk(b"IEND", b"")
).decode("ascii")


def post(payload: dict) -> dict:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(URL, data=body, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"document-worker HTTP {exc.code}: {detail}") from exc


created = post({"operation": "create", "formats": ["docx", "xlsx", "pptx", "md", "html"], "document": DOCUMENT})
office = [item for item in created["files"] if item["name"].endswith((".docx", ".xlsx", ".pptx"))]
read_back = post({"operation": "read", "files": [{"name": item["name"], "base64": item["base64"]} for item in office]})
if "推进器运行正常" not in read_back.get("text", ""):
    raise SystemExit("中文 Office 往返文本缺失")

pdfs = post({"operation": "convert", "to": "pdf", "files": [{"name": item["name"], "base64": item["base64"]} for item in office]})
pdf_read = post({"operation": "read", "files": [{"name": item["name"], "base64": item["base64"]} for item in pdfs["files"]]})
if not pdf_read.get("metadata", {}).get("documents"):
    raise SystemExit("PDF 往返未返回来源元数据")

archive = post({"operation": "archive", "archiveName": "巡检交付.zip", "files": [{"name": item["name"], "base64": item["base64"]} for item in created["files"] + pdfs["files"]]})
image_info = post({"operation": "image_info", "files": [{"name": "像素.png", "base64": PNG_1X1}]})
if image_info["metadata"]["images"][0]["width"] != 1 or image_info["metadata"]["images"][0]["height"] != 1:
    raise SystemExit("image_info 未返回真实解码尺寸")

evidence = {
    "created": [{"name": item["name"], "sha256": item["sha256"], "bytes": len(base64.b64decode(item["base64"]))} for item in created["files"]],
    "pdf": [{"name": item["name"], "sha256": item["sha256"], "bytes": len(base64.b64decode(item["base64"]))} for item in pdfs["files"]],
    "archive": {"name": archive["files"][0]["name"], "sha256": archive["files"][0]["sha256"], "bytes": len(base64.b64decode(archive["files"][0]["base64"]))},
    "readKinds": sorted({unit["type"] for document in read_back["metadata"]["documents"] for unit in document["units"]}),
    "pdfPages": [document.get("pages") for document in pdf_read["metadata"]["documents"]],
    "chineseRoundTrip": True,
    "renderQualityInspected": False,
    "imageInfo": image_info["metadata"]["images"],
}

output_dir_value = os.environ.get("DOCUMENT_WORKER_SMOKE_DIR")
if output_dir_value:
    output_dir = Path(output_dir_value).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    for item in created["files"] + pdfs["files"] + archive["files"]:
        (output_dir / item["name"]).write_bytes(base64.b64decode(item["base64"]))
    (output_dir / "result.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps(evidence, ensure_ascii=False, indent=2))
