# The one image both deployment modes run: bus, history, agent, system, the default nodes
# (provider, webui, notes, todo, timer, search, init) and the Web UI.
#
#     docker compose -f deploy/docker-compose.yml up -d --build              # this machine only
#     docker compose -f deploy/docker-compose.yml --profile public up -d     # plus Caddy and TLS
#
# The build context is the repository root, because the workspaces under node_agent/ are the source of
# the image — there is no vendored copy of them under deploy/.

ARG NODE_VERSION=24

# --- build: every workspace, installed and compiled -------------------------------
FROM node:${NODE_VERSION}-slim AS build
WORKDIR /app
# Only the manifests: there is no tsconfig.json at the root, and a glob that matches nothing is a
# build error under BuildKit.
COPY package.json package-lock.json* ./
COPY LICENSE ./
COPY node_agent/ ./node_agent/
COPY node_example/ ./node_example/
RUN npm install --no-audit --no-fund \
 && npm run build \
 && npm cache clean --force

# --- runtime: what is left once the image only has to start the stack ------------
FROM node:${NODE_VERSION}-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app /app
# /data is the one writable place: node data and the runtime`s users/packages live below it.
RUN mkdir -p /data && chown node:node /data
USER node
ENV NODE_AGENT_BUS_BIND=0.0.0.0 \
    NODE_AGENT_WEBUI_BIND=0.0.0.0 \
    NODE_AGENT_WEBUI_PORT=8790 \
    NODE_AGENT_WORKSPACE=/data/workspace \
    NODE_AGENT_HOME=/data
VOLUME ["/data"]
# 8790 is the Web UI. The bus stays inside the container on purpose: the nodes are started by the
# runtime as worker threads in this container, and nothing outside needs to dial it. The built-in door
# (NODE_AGENT_ACCESS_TOKEN -> 8080) is only opened when that variable is set; the `public` profile
# points Caddy at it.
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.NODE_AGENT_WEBUI_PORT||8790)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "node_agent/node-agent/dist/serve.js"]
