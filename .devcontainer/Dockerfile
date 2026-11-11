FROM pytorch/pytorch:2.12.0-cuda13.0-cudnn9-devel

ARG DEBIAN_FRONTEND=noninteractive

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Install development tools.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
    bash \
    build-essential \
    cmake \
    curl \
    g++ \
    gcc \
    git \
    htop \
    lsof \
    make \
    nano \
    pre-commit \
    procps \
    python3-venv \
    rsync \
    shfmt \
    sudo \
    tar \
    tmux \
    tree \
    unzip \
    vim \
    wget \
    zip \
    && rm -rf /var/lib/apt/lists/*


# Create a script file sourced by both interactive and non-interactive bash shells
ENV BASH_ENV="/root/.bash_env"
RUN touch "${BASH_ENV}"
RUN echo '. "${BASH_ENV}"' >> ~/.bashrc

# Download and install nvm
RUN curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.8/install.sh | PROFILE="${BASH_ENV}" bash
RUN echo node > .nvmrc
RUN nvm install

# Put node/npm/npx on a stable path that every process can see.
# nvm only hooks into bash (via BASH_ENV above), but the VS Code server and its
# extension host are exec'd directly and never source it -- their PATH has no
# ~/.nvm/.../bin, so the Node debugger (js-debug) cannot resolve "node" and fails
# with: Can't find Node.js binary "./node". /usr/local/bin *is* on that PATH, so
# linking here fixes debugging (and anything else that isn't a bash shell).
# The link also survives node upgrades: it is recreated from whatever `nvm install`
# picked, and launch.json points at this stable path instead of a versioned one.
RUN NVM_BIN_DIR="$(dirname "$(readlink -f "$(command -v node)")")" \
    && ln -sf "${NVM_BIN_DIR}/node" "${NVM_BIN_DIR}/npm" "${NVM_BIN_DIR}/npx" /usr/local/bin/ \
    && /usr/local/bin/node --version

# Install AI tools.
RUN npm install --global \
    @github/copilot \
    @anthropic-ai/claude-code \
    @openai/codex \
    @deepseek-ai/dsh

# Install uv and create the Python environment.
RUN curl -LsSf https://astral.sh/uv/install.sh \
    | env UV_INSTALL_DIR=/usr/local/bin sh \
    && uv venv --system-site-packages /workspaces/.venv

RUN uv pip install --python /workspaces/.venv/bin/python \
    "hermes-node @ git+https://github.com/LKJacky/hermes_nodes.git#subdirectory=node"

# Install Python dependencies.
# COPY requirements.txt /root/requirements.txt
# RUN uv pip install --python /workspaces/.venv/bin/python \
#     --requirements /root/requirements.txt
