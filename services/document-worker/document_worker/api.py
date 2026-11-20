from __future__ import annotations

import json
import multiprocessing
import os
import socket
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import __version__
from .errors import WorkerError
from .implementation import implementation_sha256
from .security import MAX_FILE_BYTES, MAX_REQUEST_BYTES
from .service import execute_job

HOST = os.environ.get("DOCUMENT_WORKER_HOST", "127.0.0.1")
PORT = int(os.environ.get("DOCUMENT_WORKER_PORT", "18781"))
JOB_TIMEOUT_SECONDS = int(os.environ.get("DOCUMENT_WORKER_TIMEOUT_SECONDS", "55"))
JOB_SLOTS = threading.BoundedSemaphore(2)
IMPLEMENTATION_SHA256 = implementation_sha256()


def _child(connection, payload: dict) -> None:
    try:
        connection.send(("ok", execute_job(payload)))
    except WorkerError as exc:
        connection.send(("worker", exc.status, exc.payload()))
    except Exception:
        connection.send(("internal", 500, {"error": {"code": "internal_error", "message": "文档任务失败。"}}))
    finally:
        connection.close()


def run_with_timeout(payload: dict) -> tuple[int, dict]:
    context = multiprocessing.get_context("spawn")
    parent, child = context.Pipe(duplex=False)
    process = context.Process(target=_child, args=(child, payload), daemon=True)
    process.start()
    child.close()
    try:
        if not parent.poll(JOB_TIMEOUT_SECONDS):
            process.terminate()
            process.join(5)
            return 504, {"error": {"code": "job_timeout", "message": "文档任务超过时间限制。"}}
        message = parent.recv()
        process.join(5)
        if message[0] == "ok":
            return 200, message[1]
        return int(message[1]), message[2]
    finally:
        parent.close()
        if process.is_alive():
            process.kill()
            process.join(2)


class Handler(BaseHTTPRequestHandler):
    server_version = "DocumentWorker/1"
    protocol_version = "HTTP/1.1"

    def setup(self) -> None:
        super().setup()
        self.connection.settimeout(15)

    def log_message(self, fmt: str, *args: object) -> None:
        print(f"{self.client_address[0]} - {fmt % args}", flush=True)

    def _send(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Connection", "close")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path != "/health":
            self._send(404, {"error": {"code": "not_found", "message": "接口不存在。"}})
            return
        self._send(
            200,
            {
                "status": "ok",
                "version": __version__,
                "implementationSha256": IMPLEMENTATION_SHA256,
                "capabilities": {
                    "read": ["pdf", "docx", "xlsx", "pptx", "md", "html", "txt"],
                    "create": ["docx", "xlsx", "pptx", "md", "html"],
                    "convert": ["pdf", "md", "html", "txt"],
                    "archive": ["zip"],
                    "imageInfo": ["png", "jpeg", "webp"],
                },
                "limits": {
                    "fileBytes": MAX_FILE_BYTES,
                    "requestBytes": MAX_REQUEST_BYTES,
                    "timeoutSeconds": JOB_TIMEOUT_SECONDS,
                    "imageMaxPixels": 64000000,
                    "imageMaxDimension": 16000,
                    "defaultMaxFiles": 10,
                    "archiveMaxFiles": 200,
                },
            },
        )

    def do_POST(self) -> None:
        if self.path != "/v1/jobs":
            self._send(404, {"error": {"code": "not_found", "message": "接口不存在。"}})
            return
        content_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
        if content_type != "application/json":
            self._send(415, {"error": {"code": "unsupported_media_type", "message": "仅接受 application/json。"}})
            return
        raw_length = self.headers.get("Content-Length")
        try:
            length = int(raw_length) if raw_length is not None else -1
        except ValueError:
            length = -1
        if length < 0:
            self._send(411, {"error": {"code": "length_required", "message": "必须提供有效 Content-Length。"}})
            return
        if length > MAX_REQUEST_BYTES:
            self._send(413, {"error": {"code": "request_too_large", "message": "请求超过 60 MiB。"}})
            return
        try:
            body = self.rfile.read(length)
        except (TimeoutError, socket.timeout, OSError):
            self._send(408, {"error": {"code": "request_timeout", "message": "请求体读取超时。"}})
            return
        try:
            payload = json.loads(body.decode("utf-8"))
        except (UnicodeError, json.JSONDecodeError, RecursionError):
            self._send(400, {"error": {"code": "invalid_json", "message": "请求不是有效 UTF-8 JSON。"}})
            return
        if not JOB_SLOTS.acquire(blocking=False):
            self._send(503, {"error": {"code": "worker_busy", "message": "文档服务繁忙，请稍后重试。"}})
            return
        try:
            status, result = run_with_timeout(payload)
        finally:
            JOB_SLOTS.release()
        self._send(status, result)


def main() -> None:
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.daemon_threads = True
    print(f"document-worker {__version__} listening on {HOST}:{PORT}", flush=True)
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    multiprocessing.freeze_support()
    main()
