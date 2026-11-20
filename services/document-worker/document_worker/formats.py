from __future__ import annotations

import html
import io
import json
import mimetypes
import os
import re
import subprocess
import zipfile
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import quote

from docx import Document as WordDocument
from docx.shared import Inches
from openpyxl import Workbook, load_workbook
from openpyxl.utils import get_column_letter
from PIL import Image
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.dml.line import LineFormat
from pptx.oxml.ns import qn
from pptx.oxml.xmlchemy import OxmlElement
from pptx.util import Inches as PptxInches, Pt as PptxPt
from pypdf import PdfReader

from .errors import WorkerError
from .security import InputFile, safe_name, validate_image

SOFFICE_TIMEOUT_SECONDS = 40
SUPPORTED_CREATE = {"docx", "xlsx", "pptx", "md", "html"}
SUPPORTED_CONVERT = {"pdf", "md", "html", "txt"}
PPTX_THEME_DEFAULTS = {
    "background": "FFFFFF",
    "text": "1F2937",
    "accent": "2563EB",
    "font": "Noto Sans CJK SC",
}
PPTX_THEME_KEYS = frozenset(PPTX_THEME_DEFAULTS)
RGB_PATTERN = re.compile(r"[0-9A-Fa-f]{6}")
FONT_PATTERN = re.compile(r"[\w .,+()'\-]{1,100}")


class TextHTMLParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []

    def handle_data(self, data: str) -> None:
        text = data.strip()
        if text:
            self.parts.append(text)


def decode_text(data: bytes) -> str:
    for encoding in ("utf-8-sig", "utf-16"):
        try:
            return data.decode(encoding)
        except UnicodeError:
            pass
    raise WorkerError("text_decode_failed", "文本文件必须是 UTF-8 或带 BOM 的 UTF-16。")


def extract_file(item: InputFile) -> tuple[str, list[dict], dict]:
    suffix = item.suffix
    if suffix in {".md", ".markdown", ".txt"}:
        text = decode_text(item.data)
        return text, [{"type": "document", "index": 1, "textLength": len(text), "tableCount": 0}], {}
    if suffix in {".html", ".htm"}:
        parser = TextHTMLParser()
        parser.feed(decode_text(item.data))
        text = "\n".join(parser.parts)
        return text, [{"type": "document", "index": 1, "textLength": len(text), "tableCount": 0}], {}
    if suffix == ".docx":
        document = WordDocument(io.BytesIO(item.data))
        parts = [p.text for p in document.paragraphs if p.text.strip()]
        for table in document.tables:
            parts.extend("\t".join(cell.text for cell in row.cells) for row in table.rows)
        text = "\n".join(parts)
        return text, [{"type": "document", "index": 1, "textLength": len(text), "tableCount": len(document.tables)}], {"pagination": "OOXML 不保存稳定页码"}
    if suffix == ".xlsx":
        workbook = load_workbook(io.BytesIO(item.data), read_only=True, data_only=False, keep_links=False)
        parts: list[str] = []
        units: list[dict] = []
        try:
            for index, sheet in enumerate(workbook.worksheets, start=1):
                sheet_lines: list[str] = []
                for row in sheet.iter_rows(values_only=True):
                    values = ["" if value is None else str(value) for value in row]
                    if any(values):
                        sheet_lines.append("\t".join(values))
                text = "\n".join(sheet_lines)
                parts.append(f"[工作表:{sheet.title}]\n{text}")
                units.append({"type": "sheet", "index": index, "name": sheet.title, "textLength": len(text), "tableCount": 0})
        finally:
            workbook.close()
        return "\n\n".join(parts), units, {}
    if suffix == ".pptx":
        presentation = Presentation(io.BytesIO(item.data))
        parts: list[str] = []
        units: list[dict] = []
        for index, slide in enumerate(presentation.slides, start=1):
            slide_parts: list[str] = []
            table_count = 0
            for shape in slide.shapes:
                if getattr(shape, "has_text_frame", False) and shape.text.strip():
                    slide_parts.append(shape.text)
                if getattr(shape, "has_table", False):
                    table_count += 1
                    for row in shape.table.rows:
                        slide_parts.append("\t".join(cell.text for cell in row.cells))
            try:
                notes = slide.notes_slide.notes_text_frame.text.strip()
                if notes:
                    slide_parts.append(f"[备注]\n{notes}")
            except (AttributeError, ValueError):
                pass
            text = "\n".join(slide_parts)
            parts.append(f"[幻灯片:{index}]\n{text}")
            units.append({"type": "slide", "index": index, "textLength": len(text), "tableCount": table_count})
        return "\n\n".join(parts), units, {}
    if suffix == ".pdf":
        try:
            reader = PdfReader(io.BytesIO(item.data), strict=True)
            if reader.is_encrypted:
                raise WorkerError("encrypted_pdf_rejected", "不接受加密 PDF。")
            parts: list[str] = []
            units: list[dict] = []
            for index, page in enumerate(reader.pages, start=1):
                text = page.extract_text() or ""
                parts.append(f"[页:{index}]\n{text}")
                units.append({"type": "page", "index": index, "textLength": len(text), "tableCount": 0})
            return "\n\n".join(parts), units, {"pages": len(reader.pages)}
        except WorkerError:
            raise
        except Exception as exc:
            raise WorkerError("pdf_read_failed", "PDF 文本提取失败。") from exc
    raise WorkerError("unsupported_format", "不支持的读取格式。", status=415, details={"name": item.name})


def _pptx_theme(raw: object) -> dict | None:
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise WorkerError("invalid_theme", "document.theme 必须是对象。", status=400)
    unknown = sorted(str(key) for key in raw if key not in PPTX_THEME_KEYS)
    if unknown:
        raise WorkerError("invalid_theme", "document.theme 包含未知字段。", status=400, details={"keys": unknown})
    theme = dict(PPTX_THEME_DEFAULTS)
    for key in ("background", "text", "accent"):
        value = raw.get(key, theme[key])
        if not isinstance(value, str) or RGB_PATTERN.fullmatch(value) is None:
            raise WorkerError("invalid_theme_color", f"document.theme.{key} 必须是 6 位 RGB 十六进制。", status=400)
        theme[key] = value.upper()
    font = raw.get("font", theme["font"])
    if not isinstance(font, str):
        raise WorkerError("invalid_theme_font", "document.theme.font 必须是字符串。", status=400)
    font = font.strip()
    if not font or FONT_PATTERN.fullmatch(font) is None:
        raise WorkerError("invalid_theme_font", "document.theme.font 必须是至多 100 字符的字体名称。", status=400)
    theme["font"] = font
    return theme


def _document(raw: object) -> dict:
    if not isinstance(raw, dict):
        raise WorkerError("invalid_document", "document 必须是对象。", status=400)
    title = raw.get("title", "未命名文档")
    if not isinstance(title, str) or not title.strip() or len(title) > 300:
        raise WorkerError("invalid_title", "document.title 无效。", status=400)
    blocks = raw.get("blocks", [])
    sheets = raw.get("sheets", [])
    slides = raw.get("slides", [])
    if not isinstance(blocks, list) or not isinstance(sheets, list) or not isinstance(slides, list):
        raise WorkerError("invalid_document", "blocks、sheets、slides 必须是数组。", status=400)
    if len(blocks) > 1000 or len(sheets) > 50 or len(slides) > 200:
        raise WorkerError("document_too_large", "文档结构超过 blocks/sheets/slides 限制。", status=413)
    return {"title": title.strip(), "blocks": blocks, "sheets": sheets, "slides": slides, "theme": _pptx_theme(raw.get("theme"))}


def _block_text(block: dict) -> str:
    text = block.get("text", "")
    if not isinstance(text, str):
        raise WorkerError("invalid_block", "block.text 必须是字符串。", status=400)
    return text


def _rows(value: object) -> list[list[object]]:
    if not isinstance(value, list) or any(not isinstance(row, list) for row in value):
        raise WorkerError("invalid_rows", "rows 必须是二维数组。", status=400)
    if len(value) > 10_000 or any(len(row) > 256 for row in value):
        raise WorkerError("table_too_large", "表格超过行列限制。", status=413)
    return value


def _validated_blocks(raw_blocks: list) -> list[dict]:
    blocks: list[dict] = []
    for raw in raw_blocks:
        if not isinstance(raw, dict) or raw.get("type") not in {"heading", "paragraph", "table", "image"}:
            raise WorkerError("invalid_block", "block.type 无效。", status=400)
        block = dict(raw)
        if block["type"] in {"heading", "paragraph"}:
            _block_text(block)
        elif block["type"] == "table":
            _rows(block.get("rows"))
        else:
            block["_image"] = validate_image(block.get("file"))
        blocks.append(block)
    return blocks


def create_docx(raw: object) -> bytes:
    spec = _document(raw)
    blocks = _validated_blocks(spec["blocks"])
    document = WordDocument()
    document.core_properties.title = spec["title"]
    document.add_heading(spec["title"], 0)
    for block in blocks:
        kind = block["type"]
        if kind == "heading":
            level = block.get("level", 1)
            if not isinstance(level, int) or not 1 <= level <= 9:
                raise WorkerError("invalid_heading_level", "heading.level 必须为 1..9。", status=400)
            document.add_heading(_block_text(block), level=level)
        elif kind == "paragraph":
            document.add_paragraph(_block_text(block))
        elif kind == "table":
            rows = _rows(block.get("rows"))
            if not rows:
                continue
            width = max((len(row) for row in rows), default=0)
            if width == 0:
                continue
            table = document.add_table(rows=len(rows), cols=width)
            table.style = "Table Grid"
            for r_index, row in enumerate(rows):
                for c_index, value in enumerate(row):
                    table.cell(r_index, c_index).text = "" if value is None else str(value)
        elif kind == "image":
            image = block["_image"]
            document.add_picture(io.BytesIO(image.data), width=Inches(5.8))
    stream = io.BytesIO()
    document.save(stream)
    return stream.getvalue()


def create_xlsx(raw: object) -> bytes:
    spec = _document(raw)
    sheets = spec["sheets"]
    if not sheets:
        tables = [block for block in _validated_blocks(spec["blocks"]) if block["type"] == "table"]
        sheets = [{"name": "Sheet1", "rows": tables[0]["rows"] if tables else [[spec["title"]]]}]
    workbook = Workbook()
    workbook.remove(workbook.active)
    used: set[str] = set()
    for index, sheet_spec in enumerate(sheets, start=1):
        if not isinstance(sheet_spec, dict):
            raise WorkerError("invalid_sheet", "sheet 必须是对象。", status=400)
        name = sheet_spec.get("name", f"Sheet{index}")
        if not isinstance(name, str) or not name.strip() or len(name) > 31 or any(char in name for char in "[]:*?/\\"):
            raise WorkerError("invalid_sheet_name", "工作表名称无效。", status=400)
        key = name.casefold()
        if key in used:
            raise WorkerError("duplicate_sheet", "工作表名称重复。", status=400)
        used.add(key)
        worksheet = workbook.create_sheet(name)
        for row in _rows(sheet_spec.get("rows", [])):
            worksheet.append(row)
        widths = sheet_spec.get("widths", [])
        if widths is not None:
            if not isinstance(widths, list):
                raise WorkerError("invalid_widths", "widths 必须是数组。", status=400)
            for column, width in enumerate(widths, start=1):
                if isinstance(width, (int, float)) and 1 <= width <= 100:
                    worksheet.column_dimensions[get_column_letter(column)].width = float(width)
    stream = io.BytesIO()
    workbook.save(stream)
    return stream.getvalue()


def edit_xlsx(item: InputFile, changes: object) -> bytes:
    if item.suffix != ".xlsx":
        raise WorkerError("invalid_edit_file", "单元格编辑仅支持 .xlsx。", status=415)
    if not isinstance(changes, list) or len(changes) > 10_000:
        raise WorkerError("invalid_changes", "changes 必须是至多 10000 项的数组。", status=400)
    workbook = load_workbook(io.BytesIO(item.data), keep_links=False)
    try:
        for change in changes:
            if not isinstance(change, dict):
                raise WorkerError("invalid_change", "change 必须是对象。", status=400)
            sheet = change.get("sheet")
            cell = change.get("cell")
            if not isinstance(sheet, str) or sheet not in workbook.sheetnames:
                raise WorkerError("sheet_not_found", "找不到要编辑的工作表。", details={"sheet": sheet})
            if not isinstance(cell, str) or not re.fullmatch(r"[A-Z]{1,3}[1-9][0-9]{0,6}", cell.upper()):
                raise WorkerError("invalid_cell", "单元格地址无效。", status=400)
            workbook[sheet][cell.upper()] = change.get("value")
        stream = io.BytesIO()
        workbook.save(stream)
        return stream.getvalue()
    finally:
        workbook.close()


def _set_east_asian_font(properties: object, font: str) -> None:
    east_asian = properties.find(qn("a:ea"))
    if east_asian is None:
        east_asian = OxmlElement("a:ea")
        properties.append(east_asian)
    east_asian.set("typeface", font)


def _style_text_frame(text_frame: object, theme: dict, color_key: str | None) -> None:
    color = RGBColor.from_string(theme[color_key]) if color_key is not None else None
    for paragraph in text_frame.paragraphs:
        for run in paragraph.runs:
            run.font.name = theme["font"]
            if color is not None:
                run.font.color.rgb = color
            _set_east_asian_font(run._r.get_or_add_rPr(), theme["font"])


def _style_slide(slide: object, theme: dict) -> None:
    fill = slide.background.fill
    fill.solid()
    fill.fore_color.rgb = RGBColor.from_string(theme["background"])


def _style_picture(picture: object, theme: dict) -> None:
    line = LineFormat(picture._element.spPr)
    line.color.rgb = RGBColor.from_string(theme["accent"])
    line.width = PptxPt(2)


def create_pptx(raw: object) -> bytes:
    spec = _document(raw)
    theme = spec["theme"]
    presentation = Presentation()
    title_slide = presentation.slides.add_slide(presentation.slide_layouts[0])
    title_slide.shapes.title.text = spec["title"]
    if len(title_slide.placeholders) > 1:
        title_slide.placeholders[1].text = "本地文档服务生成"
    if theme is not None:
        _style_slide(title_slide, theme)
        _style_text_frame(title_slide.shapes.title.text_frame, theme, "accent")
        if len(title_slide.placeholders) > 1:
            _style_text_frame(title_slide.placeholders[1].text_frame, theme, "text")
    slides = spec["slides"]
    if not slides:
        body = "\n".join(_block_text(block) for block in _validated_blocks(spec["blocks"]) if block["type"] in {"heading", "paragraph"})
        slides = [{"title": spec["title"], "body": body}]
    for slide_spec in slides:
        if not isinstance(slide_spec, dict):
            raise WorkerError("invalid_slide", "slide 必须是对象。", status=400)
        title = slide_spec.get("title", "")
        body = slide_spec.get("body", "")
        notes = slide_spec.get("notes", "")
        if not all(isinstance(value, str) for value in (title, body, notes)):
            raise WorkerError("invalid_slide", "slide 标题、正文和备注必须是字符串。", status=400)
        slide = presentation.slides.add_slide(presentation.slide_layouts[1])
        slide.shapes.title.text = title
        if len(slide.placeholders) > 1:
            slide.placeholders[1].text = body
        if theme is not None:
            _style_slide(slide, theme)
            _style_text_frame(slide.shapes.title.text_frame, theme, "accent")
            if len(slide.placeholders) > 1:
                _style_text_frame(slide.placeholders[1].text_frame, theme, "text")
        if notes:
            slide.notes_slide.notes_text_frame.text = notes
            if theme is not None:
                _style_text_frame(slide.notes_slide.notes_text_frame, theme, None)
        if slide_spec.get("image") is not None:
            image = validate_image(slide_spec.get("image"))
            picture = slide.shapes.add_picture(io.BytesIO(image.data), PptxInches(6.1), PptxInches(4.4), width=PptxInches(3.0))
            if theme is not None:
                _style_picture(picture, theme)
    stream = io.BytesIO()
    presentation.save(stream)
    return stream.getvalue()


def _image_data_uri(item: InputFile) -> str:
    mime = mimetypes.guess_type(item.name)[0] or "application/octet-stream"
    import base64

    return f"data:{mime};base64,{base64.b64encode(item.data).decode('ascii')}"


def create_markdown(raw: object) -> bytes:
    spec = _document(raw)
    lines = [f"# {spec['title']}", ""]
    for block in _validated_blocks(spec["blocks"]):
        if block["type"] == "heading":
            level = max(1, min(6, int(block.get("level", 1))))
            lines.extend([f"{'#' * level} {_block_text(block)}", ""])
        elif block["type"] == "paragraph":
            lines.extend([_block_text(block), ""])
        elif block["type"] == "table":
            rows = _rows(block.get("rows"))
            if rows:
                width = max(len(row) for row in rows)
                normalized = [["" if value is None else str(value).replace("|", "\\|") for value in row] + [""] * (width - len(row)) for row in rows]
                lines.append("| " + " | ".join(normalized[0]) + " |")
                lines.append("| " + " | ".join(["---"] * width) + " |")
                lines.extend("| " + " | ".join(row) + " |" for row in normalized[1:])
                lines.append("")
        else:
            image = block["_image"]
            lines.extend([f"![{image.name}]({_image_data_uri(image)})", ""])
    return "\n".join(lines).encode("utf-8")


def create_html(raw: object) -> bytes:
    spec = _document(raw)
    parts = ["<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><title>", html.escape(spec["title"]), "</title></head><body>", f"<h1>{html.escape(spec['title'])}</h1>"]
    for block in _validated_blocks(spec["blocks"]):
        if block["type"] == "heading":
            level = max(1, min(6, int(block.get("level", 1))))
            parts.append(f"<h{level}>{html.escape(_block_text(block))}</h{level}>")
        elif block["type"] == "paragraph":
            parts.append(f"<p>{html.escape(_block_text(block))}</p>")
        elif block["type"] == "table":
            parts.append("<table>")
            for row in _rows(block.get("rows")):
                parts.append("<tr>" + "".join(f"<td>{html.escape('' if value is None else str(value))}</td>" for value in row) + "</tr>")
            parts.append("</table>")
        else:
            image = block["_image"]
            parts.append(f"<img alt=\"{html.escape(image.name)}\" src=\"{_image_data_uri(image)}\">")
    parts.append("</body></html>")
    return "".join(parts).encode("utf-8")


def create_outputs(raw: object, formats: object, *, edit_file: InputFile | None = None, changes: object = None) -> list[tuple[str, bytes]]:
    if not isinstance(formats, list) or not formats or any(not isinstance(fmt, str) for fmt in formats):
        raise WorkerError("invalid_formats", "formats 必须是非空字符串数组。", status=400)
    normalized = [fmt.lower() for fmt in formats]
    if len(set(normalized)) != len(normalized) or any(fmt not in SUPPORTED_CREATE for fmt in normalized):
        raise WorkerError("unsupported_create_format", "生成格式仅支持 docx/xlsx/pptx/md/html。", status=415)
    if edit_file is not None and normalized != ["xlsx"]:
        raise WorkerError("invalid_edit_formats", "编辑现有 XLSX 时 formats 必须且只能是 [\"xlsx\"]。", status=400)
    spec = _document(raw) if edit_file is None else None
    if spec is not None and spec["theme"] is not None and "pptx" not in normalized:
        raise WorkerError("theme_requires_pptx", "document.theme 仅用于 PPTX，formats 必须包含 pptx。", status=400)
    title = spec.get("title", "document") if spec is not None else Path(edit_file.name).stem
    base = safe_name(re.sub(r"[^\w\-.\u4e00-\u9fff]+", "-", title).strip("-.") or "document")
    outputs: list[tuple[str, bytes]] = []
    for fmt in normalized:
        if fmt == "docx":
            data = create_docx(raw)
        elif fmt == "xlsx":
            data = edit_xlsx(edit_file, changes) if edit_file is not None else create_xlsx(raw)
        elif fmt == "pptx":
            data = create_pptx(raw)
        elif fmt == "md":
            data = create_markdown(raw)
        else:
            data = create_html(raw)
        outputs.append((f"{base}.{fmt}", data))
    return outputs


def convert_with_libreoffice(input_path: Path, output_dir: Path, *, profile_dir: Path) -> Path:
    profile_dir.mkdir(parents=True, exist_ok=True)
    command = [
        "soffice",
        "--headless",
        "--nologo",
        "--nodefault",
        "--nofirststartwizard",
        f"-env:UserInstallation={profile_dir.as_uri()}",
        "--convert-to",
        "pdf",
        "--outdir",
        str(output_dir),
        str(input_path),
    ]
    environment = {**os.environ, "HOME": str(profile_dir.parent), "TMPDIR": str(profile_dir.parent)}
    try:
        completed = subprocess.run(command, capture_output=True, text=True, timeout=SOFFICE_TIMEOUT_SECONDS, env=environment, check=False)
    except (FileNotFoundError, subprocess.TimeoutExpired) as exc:
        code = "libreoffice_missing" if isinstance(exc, FileNotFoundError) else "libreoffice_timeout"
        raise WorkerError(code, "LibreOffice 转换不可用或超时。", status=504 if code.endswith("timeout") else 500) from exc
    output_path = output_dir / f"{input_path.stem}.pdf"
    if completed.returncode != 0 or not output_path.is_file():
        raise WorkerError("libreoffice_failed", "LibreOffice 未生成 PDF。", details={"stderr": completed.stderr[-1000:]})
    return output_path


def text_to_docx(name: str, text: str) -> bytes:
    document = WordDocument()
    document.core_properties.title = Path(name).stem
    document.add_heading(Path(name).stem, 0)
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("#"):
            level = min(9, len(stripped) - len(stripped.lstrip("#")))
            document.add_heading(stripped.lstrip("#").strip(), level=max(1, level))
        else:
            document.add_paragraph(stripped)
    stream = io.BytesIO()
    document.save(stream)
    return stream.getvalue()


def to_html_document(title: str, text: str) -> bytes:
    return ("<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><title>" + html.escape(title) + "</title></head><body><pre>" + html.escape(text) + "</pre></body></html>").encode("utf-8")


def make_archive(name: str, files: list[InputFile]) -> tuple[str, bytes]:
    archive_name = safe_name(name, default="documents.zip")
    if not archive_name.lower().endswith(".zip"):
        archive_name += ".zip"
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for item in files:
            info = zipfile.ZipInfo(item.name)
            info.date_time = (1980, 1, 1, 0, 0, 0)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o600 << 16
            archive.writestr(info, item.data)
    return archive_name, stream.getvalue()


def response_mime(name: str) -> str:
    mapping = {
        ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        ".pdf": "application/pdf",
        ".md": "text/markdown; charset=utf-8",
        ".html": "text/html; charset=utf-8",
        ".txt": "text/plain; charset=utf-8",
        ".zip": "application/zip",
    }
    return mapping.get(Path(name).suffix.lower(), "application/octet-stream")
