from __future__ import annotations

import base64
import hashlib
import tempfile
from pathlib import Path

from .errors import WorkerError
from .formats import (
    SUPPORTED_CONVERT,
    create_outputs,
    extract_file,
    make_archive,
    response_mime,
    text_to_docx,
    to_html_document,
    convert_with_libreoffice,
)
from .security import (
    InputFile,
    MAX_ARCHIVE_FILES,
    MAX_ARCHIVE_TOTAL_BYTES,
    MAX_FILES,
    decode_image,
    decode_file,
    decode_files,
    ensure_output_budget,
    inspect_ooxml,
    validate_supported_input,
    write_input,
)


def _result_file(name: str, data: bytes) -> dict:
    return {
        "name": name,
        "mime": response_mime(name),
        "base64": base64.b64encode(data).decode("ascii"),
        "sha256": hashlib.sha256(data).hexdigest(),
    }


def _read(payload: dict) -> dict:
    files = decode_files(payload.get("files"))
    documents: list[dict] = []
    text_parts: list[str] = []
    for item in files:
        validate_supported_input(item)
        text, units, extra = extract_file(item)
        text_parts.append(f"===== {item.name} =====\n{text}")
        documents.append(
            {
                "name": item.name,
                "mime": response_mime(item.name),
                "sha256": hashlib.sha256(item.data).hexdigest(),
                "units": units,
                **extra,
            }
        )
    return {"files": [], "text": "\n\n".join(text_parts), "metadata": {"documents": documents}}


def _create(payload: dict) -> dict:
    edit_file = None
    if payload.get("file") is not None:
        edit_file = decode_file(payload.get("file"))
        inspect_ooxml(edit_file)
    outputs = create_outputs(
        payload.get("document", {"title": "document", "blocks": []}),
        payload.get("formats"),
        edit_file=edit_file,
        changes=payload.get("changes"),
    )
    ensure_output_budget(outputs)
    return {"files": [_result_file(name, data) for name, data in outputs], "metadata": {"operation": "create"}}


def _convert(payload: dict, workspace: Path) -> dict:
    files = decode_files(payload.get("files"))
    target = payload.get("to")
    if not isinstance(target, str) or target.lower() not in SUPPORTED_CONVERT:
        raise WorkerError("unsupported_convert_target", "to 仅支持 pdf、md、html、txt。", status=415)
    target = target.lower()
    input_dir = workspace / "input"
    output_dir = workspace / "output"
    input_dir.mkdir()
    output_dir.mkdir()
    outputs: list[tuple[str, bytes]] = []
    for index, item in enumerate(files):
        validate_supported_input(item)
        if target == "pdf":
            if item.suffix == ".pdf":
                raise WorkerError("same_format", "PDF 无需再次转换为 PDF。", details={"name": item.name})
            if item.suffix in {".docx", ".xlsx", ".pptx"}:
                input_path = write_input(input_dir, item)
            else:
                text, _, _ = extract_file(item)
                input_path = input_dir / f"{Path(item.name).stem}.docx"
                input_path.write_bytes(text_to_docx(item.name, text))
            pdf_path = convert_with_libreoffice(input_path, output_dir, profile_dir=workspace / f"profile-{index}")
            source_kind = item.suffix.lstrip(".") or "source"
            outputs.append((f"{Path(item.name).stem}-{source_kind}.pdf", pdf_path.read_bytes()))
        else:
            text, _, _ = extract_file(item)
            name = f"{Path(item.name).stem}.{target}"
            if target == "html":
                data = to_html_document(Path(item.name).stem, text)
            else:
                data = text.encode("utf-8")
            outputs.append((name, data))
    ensure_output_budget(outputs)
    return {"files": [_result_file(name, data) for name, data in outputs], "metadata": {"operation": "convert", "target": target}}


def _archive(payload: dict) -> dict:
    files = decode_files(payload.get("files"), max_files=MAX_ARCHIVE_FILES)
    if sum(len(item.data) for item in files) > MAX_ARCHIVE_TOTAL_BYTES:
        raise WorkerError("archive_expansion_limit", "归档展开后的文件总量超过 45 MiB。", status=413)
    name, data = make_archive(payload.get("archiveName", "documents.zip"), files)
    ensure_output_budget([(name, data)])
    return {"files": [_result_file(name, data)], "metadata": {"operation": "archive", "entries": [item.name for item in files]}}


def _image_info(payload: dict) -> dict:
    raw_files = payload.get("files")
    if not isinstance(raw_files, list) or not raw_files:
        raise WorkerError("missing_files", "image_info 至少需要一个图片文件。", status=400)
    if len(raw_files) > MAX_FILES:
        raise WorkerError("too_many_files", f"本操作最多 {MAX_FILES} 个文件。", status=413)
    images: list[dict] = []
    seen: set[str] = set()
    for raw in raw_files:
        item, metadata = decode_image(raw)
        key = item.name.casefold()
        if key in seen:
            raise WorkerError("duplicate_file", "规范化后存在重复文件名。", status=400, details={"name": item.name})
        seen.add(key)
        images.append({**metadata, "sha256": hashlib.sha256(item.data).hexdigest()})
    return {"files": [], "metadata": {"images": images}}


def execute_job(payload: object) -> dict:
    if not isinstance(payload, dict):
        raise WorkerError("invalid_request", "JSON 顶层必须是对象。", status=400)
    operation = payload.get("operation")
    if operation not in {"read", "create", "convert", "archive", "image_info"}:
        raise WorkerError("invalid_operation", "operation 必须是 read、create、convert、archive 或 image_info。", status=400)
    with tempfile.TemporaryDirectory(prefix="document-job-") as temporary:
        workspace = Path(temporary)
        if operation == "read":
            return _read(payload)
        if operation == "create":
            return _create(payload)
        if operation == "convert":
            return _convert(payload, workspace)
        if operation == "image_info":
            return _image_info(payload)
        return _archive(payload)
