from __future__ import annotations

import os
import socket
import socketserver
import threading

LISTEN_HOST = os.environ.get("DOCUMENT_GATEWAY_HOST", "0.0.0.0")
LISTEN_PORT = int(os.environ.get("DOCUMENT_GATEWAY_PORT", "18781"))
TARGET_HOST = os.environ.get("DOCUMENT_GATEWAY_TARGET_HOST", "document-worker")
TARGET_PORT = int(os.environ.get("DOCUMENT_GATEWAY_TARGET_PORT", "18781"))
BUFFER_BYTES = 64 * 1024
SOCKET_TIMEOUT_SECONDS = 90


def relay(source: socket.socket, destination: socket.socket) -> None:
    try:
        while True:
            chunk = source.recv(BUFFER_BYTES)
            if not chunk:
                break
            destination.sendall(chunk)
    except OSError:
        pass
    finally:
        try:
            destination.shutdown(socket.SHUT_WR)
        except OSError:
            pass


class ProxyHandler(socketserver.BaseRequestHandler):
    def handle(self) -> None:
        self.request.settimeout(SOCKET_TIMEOUT_SECONDS)
        try:
            upstream = socket.create_connection((TARGET_HOST, TARGET_PORT), timeout=5)
        except OSError:
            return
        with upstream:
            upstream.settimeout(SOCKET_TIMEOUT_SECONDS)
            upload = threading.Thread(target=relay, args=(self.request, upstream), daemon=True)
            upload.start()
            relay(upstream, self.request)
            upload.join(timeout=2)


class ProxyServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True
    request_queue_size = 32


def main() -> None:
    with ProxyServer((LISTEN_HOST, LISTEN_PORT), ProxyHandler) as server:
        print(f"document-worker-gateway listening on {LISTEN_HOST}:{LISTEN_PORT} -> {TARGET_HOST}:{TARGET_PORT}", flush=True)
        server.serve_forever(poll_interval=0.5)


if __name__ == "__main__":
    main()
