ARG BASE_IMAGE=node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
FROM ${BASE_IMAGE}

ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      build-essential ca-certificates git python3 python3-pip \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 sandbox \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin sandbox
RUN install -d -o 10001 -g 10001 /cache /cache/npm /cache/pip /cache/cargo /cache/go

ENV HOME=/tmp/home \
    NPM_CONFIG_CACHE=/cache/npm \
    PIP_CACHE_DIR=/cache/pip \
    CARGO_HOME=/cache/cargo \
    GOMODCACHE=/cache/go

USER 10001:10001
WORKDIR /workspace
