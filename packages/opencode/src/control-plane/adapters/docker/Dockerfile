FROM ubuntu:24.04

ARG DEBIAN_FRONTEND=noninteractive
ARG NODE_VERSION=22.16.0
ARG BUN_VERSION=1.3.14

ENV BUN_INSTALL=/opt/bun
ENV UV_INSTALL_DIR=/usr/local/bin
ENV PATH=/opt/bun/bin:/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ENV PIP_DISABLE_PIP_VERSION_CHECK=1
ENV npm_config_update_notifier=false

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    build-essential \
    ca-certificates \
    curl \
    fd-find \
    git \
    jq \
    openssh-client \
    pipx \
    pkg-config \
    python3 \
    python3-pip \
    python3-venv \
    ripgrep \
    unzip \
    xz-utils \
    zip \
  && ln -s /usr/bin/fdfind /usr/local/bin/fd \
  && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
  arch="$(uname -m)"; \
  node_arch="x64"; \
  if [ "$arch" = "aarch64" ]; then node_arch="arm64"; fi; \
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" \
    | tar -xJf - -C /usr/local --strip-components=1; \
  corepack enable; \
  node --version; \
  npm --version; \
  npx --version

RUN set -eux; \
  curl -fsSL https://bun.sh/install | bash -s -- "bun-v${BUN_VERSION}"; \
  bun --version; \
  bunx --version

RUN set -eux; \
  curl -LsSf https://astral.sh/uv/install.sh | sh; \
  uv --version; \
  uvx --version; \
  python3 --version; \
  pipx --version

COPY setup.sh /tmp/opencode-docker-setup.sh
RUN /bin/bash /tmp/opencode-docker-setup.sh \
  && rm /tmp/opencode-docker-setup.sh

WORKDIR /workspace

CMD ["sleep", "infinity"]
