from __future__ import annotations

import base64
import io
import json
import sys
import unittest
import zipfile
from pathlib import Path

from PIL import Image
from pypdf import PdfWriter

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services" / "document-worker"))

from document_worker.errors import WorkerError  # noqa: E402
from document_worker.implementation import implementation_sha256  # noqa: E402
from document_worker.service import execute_job  # noqa: E402


DOCUMENT = {
    "title": "中文巡检报告",
    "blocks": [
        {"type": "heading", "level": 1, "text": "检查结论"},
        {"type": "paragraph", "text": "设备运行正常，温度二十五摄氏度。"},
        {"type": "table", "rows": [["项目", "结果"], ["推进器", "正常"]]},
    ],
    "sheets": [{"name": "巡检数据", "rows": [["项目", "数值"], ["温度", 25]], "widths": [18, 12]}],
    "slides": [{"title": "巡检结论", "body": "设备运行正常", "notes": "中文备注"}],
}


def encoded(name: str, data: bytes) -> dict:
    return {"name": name, "base64": base64.b64encode(data).decode("ascii")}


class DocumentWorkerTests(unittest.TestCase):
    def test_implementation_hash_is_stable_shape(self) -> None:
        digest = implementation_sha256()
        self.assertEqual(len(digest), 64)
        int(digest, 16)

    def test_create_and_read_chinese_office_documents(self) -> None:
        created = execute_job({"operation": "create", "formats": ["docx", "xlsx", "pptx", "md", "html"], "document": DOCUMENT})
        self.assertEqual([item["name"].split(".")[-1] for item in created["files"]], ["docx", "xlsx", "pptx", "md", "html"])
        office = [file for file in created["files"] if Path(file["name"]).suffix in {".docx", ".xlsx", ".pptx"}]
        read = execute_job({"operation": "read", "files": [{"name": file["name"], "base64": file["base64"]} for file in office]})
        self.assertIn("设备运行正常", read["text"])
        kinds = {unit["type"] for document in read["metadata"]["documents"] for unit in document["units"]}
        self.assertTrue({"document", "sheet", "slide"}.issubset(kinds))

    def test_edit_xlsx_cells(self) -> None:
        created = execute_job({"operation": "create", "formats": ["xlsx"], "document": DOCUMENT})["files"][0]
        edited = execute_job(
            {
                "operation": "create",
                "formats": ["xlsx"],
                "file": {"name": created["name"], "base64": created["base64"]},
                "changes": [{"sheet": "巡检数据", "cell": "B2", "value": 26}],
            }
        )["files"][0]
        read = execute_job({"operation": "read", "files": [{"name": edited["name"], "base64": edited["base64"]}]})
        self.assertIn("26", read["text"])

    def test_archive_is_deterministic_and_explicit(self) -> None:
        result = execute_job({"operation": "archive", "archiveName": "中文归档.zip", "files": [encoded("说明.txt", "中文".encode())]})
        raw = base64.b64decode(result["files"][0]["base64"])
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            self.assertEqual(archive.namelist(), ["说明.txt"])
            self.assertEqual(archive.read("说明.txt").decode(), "中文")

    def test_archive_allows_200_files_but_other_operations_allow_10(self) -> None:
        files = [encoded(f"产物-{index:03}.txt", f"内容-{index}".encode()) for index in range(200)]
        result = execute_job({"operation": "archive", "archiveName": "完整任务.zip", "files": files})
        raw = base64.b64decode(result["files"][0]["base64"])
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            self.assertEqual(len(archive.namelist()), 200)
            self.assertEqual(archive.namelist()[0], "产物-000.txt")
            self.assertEqual(archive.namelist()[-1], "产物-199.txt")
        with self.assertRaisesRegex(WorkerError, "最多 200"):
            execute_job({"operation": "archive", "files": files + [encoded("产物-200.txt", b"extra")]})
        with self.assertRaisesRegex(WorkerError, "最多 10"):
            execute_job({"operation": "read", "files": files[:11]})

    def test_path_and_macro_protection(self) -> None:
        with self.assertRaises(WorkerError):
            execute_job({"operation": "archive", "files": [encoded("../evil.txt", b"x")]})
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, "w") as archive:
            archive.writestr("[Content_Types].xml", "<Types/>")
            archive.writestr("word/vbaProject.bin", b"macro")
        with self.assertRaises(WorkerError):
            execute_job({"operation": "read", "files": [encoded("macro.docx", stream.getvalue())]})

    def test_external_relationship_protection(self) -> None:
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, "w") as archive:
            archive.writestr("[Content_Types].xml", "<Types/>")
            archive.writestr("word/_rels/document.xml.rels", '<Relationship TargetMode="External" Target="https://example.com"/>')
        with self.assertRaises(WorkerError):
            execute_job({"operation": "read", "files": [encoded("external.docx", stream.getvalue())]})

    def test_image_info_requires_full_decode(self) -> None:
        stream = io.BytesIO()
        Image.new("RGB", (32, 24), (12, 34, 56)).save(stream, format="PNG")
        good = execute_job({"operation": "image_info", "files": [encoded("巡检.png", stream.getvalue())]})
        self.assertEqual(good["files"], [])
        self.assertEqual(good["metadata"]["images"][0]["width"], 32)
        self.assertEqual(good["metadata"]["images"][0]["height"], 24)
        png = stream.getvalue()
        idat = png.index(b"IDAT")
        for name, raw in [
            ("损坏.png", png[: idat + 12]),
            ("伪造.jpg", b"\xff\xd8\xff\xe0not-a-jpeg"),
            ("空壳.webp", b"RIFF\x0e\x00\x00\x00WEBPVP8X\x00\x00\x00\x00\x00\x00"),
        ]:
            with self.subTest(name=name), self.assertRaises(WorkerError):
                execute_job({"operation": "image_info", "files": [encoded(name, raw)]})

    def test_pdf_javascript_is_rejected(self) -> None:
        stream = io.BytesIO()
        writer = PdfWriter()
        writer.add_blank_page(width=100, height=100)
        writer.add_js("app.alert('blocked')")
        writer.write(stream)
        with self.assertRaises(WorkerError):
            execute_job({"operation": "read", "files": [encoded("active.pdf", stream.getvalue())]})


if __name__ == "__main__":
    unittest.main(verbosity=2)
