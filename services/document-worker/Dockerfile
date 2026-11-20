FROM python:3.13-slim-trixie@sha256:ae14d4ce8771606477a81446e7ef429edd6762305fc50c84507c1041fa8285d1

ARG LIBREOFFICE_VERSION=4:25.2.3-2+deb13u8

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DOCUMENT_WORKER_HOST=0.0.0.0 \
    DOCUMENT_WORKER_PORT=18781 \
    DOCUMENT_WORKER_TIMEOUT_SECONDS=55 \
    HOME=/tmp/home \
    TMPDIR=/tmp

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       "libreoffice=${LIBREOFFICE_VERSION}" \
       fonts-liberation \
       fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt /app/requirements.txt
RUN python -m pip install --no-cache-dir --disable-pip-version-check -r /app/requirements.txt

COPY document_worker /app/document_worker

RUN groupadd --system --gid 10001 document-worker \
    && useradd --system --uid 10001 --gid 10001 --home-dir /tmp/home --shell /usr/sbin/nologin document-worker

USER 10001:10001
EXPOSE 18781

HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=6 \
  CMD ["python", "-c", "import json,urllib.request; d=json.load(urllib.request.urlopen('http://127.0.0.1:18781/health',timeout=2)); assert d['status']=='ok'"]

CMD ["python", "-m", "document_worker.api"]
