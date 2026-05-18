ARG CODE_SERVER_VERSION=4.96.4
FROM ghcr.io/coder/code-server:${CODE_SERVER_VERSION}

USER root

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        gnupg \
        git \
        build-essential \
        python3 \
        python3-pip \
        python3-venv \
        python3-dev \
        ripgrep \
    && mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
        | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" \
        > /etc/apt/sources.list.d/nodesource.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

RUN ln -sf /usr/bin/python3 /usr/local/bin/python \
    && ln -sf /usr/bin/pip3 /usr/local/bin/pip \
    && (corepack enable || true) \
    && mkdir -p /home/coder/project \
    && chown -R coder:coder /home/coder/project

USER coder
RUN python3 -m venv /home/coder/.venv \
    && /home/coder/.venv/bin/pip install --no-cache-dir --upgrade pip setuptools wheel

WORKDIR /home/coder/project
