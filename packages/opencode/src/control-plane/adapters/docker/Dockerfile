FROM debian:13-slim

ARG DEBIAN_FRONTEND=noninteractive
ARG NODE_VERSION=22.16.0

ENV UV_INSTALL_DIR=/usr/local/bin
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/opencode/browser-cache/playwright
ENV PUPPETEER_CACHE_DIR=/opt/opencode/browser-cache/puppeteer
ENV UV_CACHE_DIR=/root/.cache/uv
ENV npm_config_cache=/root/.npm
ENV PATH=/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ENV PIP_DISABLE_PIP_VERSION_CHECK=1
ENV npm_config_update_notifier=false

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    binutils \
    ca-certificates \
    curl \
    fd-find \
    file \
    git \
    jq \
    less \
    lsof \
    netcat-openbsd \
    openssh-client \
    procps \
    psmisc \
    python-is-python3 \
    python3 \
    python3-pip \
    python3-venv \
    ripgrep \
    rsync \
    tree \
    unzip \
    wget \
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
  curl -LsSf https://astral.sh/uv/install.sh | sh; \
  uv --version; \
  uvx --version; \
  python --version; \
  python3 --version

COPY setup.sh /tmp/opencode-docker-setup.sh
RUN /bin/bash /tmp/opencode-docker-setup.sh \
  && rm -f /tmp/opencode-docker-setup.sh

WORKDIR /workspace

CMD ["sleep", "infinity"]
