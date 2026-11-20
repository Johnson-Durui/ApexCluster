from __future__ import annotations

import base64
import binascii
import io
import os
import posixpath
import re
import unicodedata
import warnings
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath, PureWindowsPath

from PIL import Image, UnidentifiedImageError
from pypdf import PdfReader

from .errors import WorkerError

MAX_FILE_BYTES = 20 * 1024 * 1024
MAX_REQUEST_BYTES = 60 * 1024 * 1024
MAX_OUTPUT_RAW_BYTES = 45 * 1024 * 1024
MAX_FILES = 10
MAX_ARCHIVE_FILES = 200
MAX_ARCHIVE_TOTAL_BYTES = 45 * 1024 * 1024
MAX_ARCHIVE_ENTRIES = 2048
MAX_ARCHIVE_UNCOMPRESSED = 200 * 1024 * 1024
MAX_COMPRESSION_RATIO = 100
MAX_IMAGE_PIXELS = 64_000_000
MAX_IMAGE_DIMENSION = 16_000
SAFE_IMAGE_EXTENSIONS = {".png": "PNG", ".jpg": "JPEG", ".jpeg": "JPEG", ".webp": "WEBP"}
ALLOWED_INPUT_EXTENSIONS = {".pdf", ".docx", ".xlsx", ".pptx", ".md", ".markdown", ".html", ".htm", ".txt"}
MACRO_EXTENSIONS = {".docm", ".dotm", ".xlsm", ".xltm", ".xlam", ".pptm", ".potm", ".ppam", ".ppsm"}
CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")
EXTERNAL_REL_RE = re.compile(br"TargetMode\s*=\s*['\"]External['\"]", re.IGNORECASE)
PDF_ACTIVE_ACTIONS = {"/JavaScript", "/Launch", "/GoToR", "/SubmitForm", "/ImportData"}


@dataclass(frozen=True)
class InputFile:
    name: str
    data: bytes

    @property
    def suffix(self) -> str:
        return Path(self.name).suffix.lower()


def safe_name(value: object, *, default: str | None = None) -> str:
    if value is None and default is not None:
        value = default
    if not isinstance(value, str):
        raise WorkerError("invalid_file_name", "文件名必须是字符串。", status=400)
    name = unicodedata.normalize("NFC", value.strip())
    if not name or len(name) > 180 or CONTROL_RE.search(name):
        raise WorkerError("invalid_file_name", "文件名为空、过长或包含控制字符。", status=400)
    if name in {".", ".."} or PurePosixPath(name).name != name or PureWindowsPath(name).name != name:
        raise WorkerError("unsafe_file_name", "文件名不能包含路径。", status=400)
    if "/" in name or "\\" in name or ":" in name:
        raise WorkerError("unsafe_file_name", "文件名不能包含路径分隔符或盘符。", status=400)
    return name


def decode_files(raw_files: object, *, allow_empty: bool = False, max_files: int = MAX_FILES) -> list[InputFile]:
    if not isinstance(raw_files, list):
        raise WorkerError("invalid_files", "files 必须是数组。", status=400)
    if not raw_files and not allow_empty:
        raise WorkerError("missing_files", "至少需要一个输入文件。", status=400)
    if len(raw_files) > max_files:
        raise WorkerError("too_many_files", f"本操作最多 {max_files} 个文件。", status=413)
    files: list[InputFile] = []
    seen: set[str] = set()
    for raw in raw_files:
        files.append(decode_file(raw, seen=seen))
    return files


def decode_file(raw: object, *, seen: set[str] | None = None) -> InputFile:
    if not isinstance(raw, dict):
        raise WorkerError("invalid_file", "文件必须是 {name,base64} 对象。", status=400)
    name = safe_name(raw.get("name"))
    key = name.casefold()
    if seen is not None:
        if key in seen:
            raise WorkerError("duplicate_file", "规范化后存在重复文件名。", status=400, details={"name": name})
        seen.add(key)
    encoded = raw.get("base64")
    if not isinstance(encoded, str) or not encoded:
        raise WorkerError("invalid_base64", "base64 必须是非空字符串。", status=400, details={"name": name})
    if len(encoded) > ((MAX_FILE_BYTES + 2) // 3) * 4 + 8:
        raise WorkerError("file_too_large", "文件超过 20 MiB。", status=413, details={"name": name})
    try:
        data = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise WorkerError("invalid_base64", "文件不是有效的严格 Base64。", status=400, details={"name": name}) from exc
    if len(data) > MAX_FILE_BYTES:
        raise WorkerError("file_too_large", "文件超过 20 MiB。", status=413, details={"name": name})
    suffix = Path(name).suffix.lower()
    if suffix in MACRO_EXTENSIONS:
        raise WorkerError("macro_format_rejected", "不接受启用宏的 Office 格式。", details={"name": name})
    return InputFile(name=name, data=data)


def validate_supported_input(item: InputFile) -> None:
    if item.suffix not in ALLOWED_INPUT_EXTENSIONS:
        raise WorkerError("unsupported_format", "不支持的输入格式。", status=415, details={"name": item.name})
    if item.suffix in {".docx", ".xlsx", ".pptx"}:
        inspect_ooxml(item)
    elif item.suffix == ".pdf":
        inspect_pdf(item)


def _safe_zip_member(name: str) -> bool:
    normalized = name.replace("\\", "/")
    path = PurePosixPath(normalized)
    return bool(normalized) and not normalized.startswith("/") and not path.is_absolute() and ".." not in path.parts and ":" not in path.parts[0]


def inspect_ooxml(item: InputFile) -> None:
    try:
        with zipfile.ZipFile(io.BytesIO(item.data)) as archive:
            infos = archive.infolist()
            if len(infos) > MAX_ARCHIVE_ENTRIES:
                raise WorkerError("archive_too_many_entries", "Office 文件条目数过多。", details={"name": item.name})
            total = 0
            for info in infos:
                if not _safe_zip_member(info.filename):
                    raise WorkerError("unsafe_archive_path", "Office 文件包含不安全路径。", details={"name": item.name})
                if (info.external_attr >> 16) & 0o170000 == 0o120000:
                    raise WorkerError("archive_symlink_rejected", "Office 文件包含链接条目。", details={"name": item.name})
                total += info.file_size
                if total > MAX_ARCHIVE_UNCOMPRESSED:
                    raise WorkerError("archive_expansion_limit", "Office 文件解压后过大。", details={"name": item.name})
                if info.file_size > 1024 * 1024 and info.file_size / max(info.compress_size, 1) > MAX_COMPRESSION_RATIO:
                    raise WorkerError("archive_ratio_limit", "Office 文件压缩比异常。", details={"name": item.name})
                lowered = info.filename.casefold()
                if "vbaproject.bin" in lowered or lowered.endswith("/macros.xml"):
                    raise WorkerError("embedded_macro_rejected", "Office 文件包含宏。", details={"name": item.name})
                if lowered.endswith(".rels") and info.file_size <= 2 * 1024 * 1024:
                    if EXTERNAL_REL_RE.search(archive.read(info)):
                        raise WorkerError("external_relationship_rejected", "Office 文件包含外部关系。", details={"name": item.name})
    except zipfile.BadZipFile as exc:
        raise WorkerError("invalid_ooxml", "Office 文件不是有效的 OOXML 包。", details={"name": item.name}) from exc


def inspect_pdf(item: InputFile) -> None:
    if not item.data.startswith(b"%PDF-"):
        raise WorkerError("invalid_pdf", "PDF 文件头无效。", details={"name": item.name})
    try:
        reader = PdfReader(io.BytesIO(item.data), strict=True)
        if reader.is_encrypted:
            raise WorkerError("encrypted_pdf_rejected", "不接受加密 PDF。", details={"name": item.name})
        root = reader.trailer["/Root"]
        open_action = root.get("/OpenAction")
        if open_action is not None:
            resolved = open_action.get_object()
            if hasattr(resolved, "get") and str(resolved.get("/S")) not in {"None", "/GoTo"}:
                raise WorkerError("active_pdf_rejected", "PDF 包含主动打开动作。", details={"name": item.name})
        if root.get("/AA") is not None:
            raise WorkerError("active_pdf_rejected", "PDF 包含自动附加动作。", details={"name": item.name})
        names = root.get("/Names")
        if names is not None:
            names = names.get_object()
            if names.get("/JavaScript") is not None or names.get("/EmbeddedFiles") is not None:
                raise WorkerError("active_pdf_rejected", "PDF 包含脚本或附件。", details={"name": item.name})
        for page in reader.pages:
            if page.get("/AA") is not None:
                raise WorkerError("active_pdf_rejected", "PDF 页面包含自动动作。", details={"name": item.name})
            annotations = page.get("/Annots") or []
            for reference in annotations:
                annotation = reference.get_object()
                if annotation.get("/AA") is not None:
                    raise WorkerError("active_pdf_rejected", "PDF 批注包含自动动作。", details={"name": item.name})
                action = annotation.get("/A")
                if action is not None and str(action.get_object().get("/S")) in PDF_ACTIVE_ACTIONS:
                    raise WorkerError("active_pdf_rejected", "PDF 批注包含主动动作。", details={"name": item.name})
    except WorkerError:
        raise
    except Exception as exc:
        raise WorkerError("invalid_pdf", "PDF 结构无效。", details={"name": item.name}) from exc


def decode_image(raw: object) -> tuple[InputFile, dict]:
    item = decode_file(raw)
    expected = SAFE_IMAGE_EXTENSIONS.get(item.suffix)
    if not expected:
        raise WorkerError("unsupported_image", "图片仅支持 PNG、JPEG、WebP。", status=415, details={"name": item.name})
    Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(item.data)) as image:
                image.load()
                if (
                    image.format != expected
                    or image.width > MAX_IMAGE_DIMENSION
                    or image.height > MAX_IMAGE_DIMENSION
                    or image.width * image.height > MAX_IMAGE_PIXELS
                ):
                    raise WorkerError("unsafe_image", "图片格式、尺寸或像素数不符合限制。", details={"name": item.name})
                if getattr(image, "n_frames", 1) != 1:
                    raise WorkerError("animated_image_rejected", "不接受动画图片。", details={"name": item.name})
                metadata = {
                    "name": item.name,
                    "mime": Image.MIME.get(image.format, "application/octet-stream"),
                    "width": image.width,
                    "height": image.height,
                }
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise WorkerError("invalid_image", "图片无法安全解码。", details={"name": item.name}) from exc
    return item, metadata


def validate_image(raw: object) -> InputFile:
    item, _ = decode_image(raw)
    return item


def write_input(directory: Path, item: InputFile) -> Path:
    path = directory / item.name
    path.write_bytes(item.data)
    return path


def ensure_output_budget(files: list[tuple[str, bytes]]) -> None:
    total = 0
    for name, data in files:
        if len(data) > MAX_FILE_BYTES:
            raise WorkerError("output_too_large", "单个输出超过 20 MiB。", status=413, details={"name": name})
        total += len(data)
    if total > MAX_OUTPUT_RAW_BYTES:
        raise WorkerError("output_total_too_large", "输出总量超过安全预算。", status=413)
