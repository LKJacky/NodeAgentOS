# Deployment

One stack, one image, one compose file. What changes between a machine on your desk and a machine on
the internet is which services you start, not which files you build.

```
deploy/
  Dockerfile          the stack: bus, nodes, Web UI (one image, both modes)
  docker-compose.yml  services: stack, and caddy behind the `public` profile
  Caddyfile           certificate + reverse proxy for the `public` profile
  env.example         one env file for both modes
  node-agent/         .env.example for running the same stack without docker
```

## Local mode — `stack` only

```bash
cp deploy/env.example deploy/.env                 # NODE_AGENT_TOKEN, model, nothing else required
docker compose -f deploy/docker-compose.yml up -d --build
```

That starts `stack` and nothing else. One container, one process: the bus and the default nodes run as
worker threads in it. The bus is never published, the page is on `127.0.0.1:8790`, `/data` is the only
volume and holds the history database, the runtime home and the shell workspace. No TLS, no proxy, no
second container — `caddy` carries the `public` profile, so a plain `up` cannot start it.

To reach it from the LAN, change the published address in `docker-compose.yml` to `0.0.0.0:8790:8790`
— and set a real token first. For anything wider than the LAN, use the public mode below.

Without docker at all:

```bash
npm install && npm run build
cp deploy/node-agent/.env.example deploy/node-agent/.env   # put a token in it
node --env-file=deploy/node-agent/.env node_agent/node-agent/dist/serve.js
```

That is the same assembly with the paths pointing at your home directory instead of `/data`.

## Public mode — `stack` + `caddy`

```bash
cp deploy/env.example deploy/.env    # NODE_AGENT_TOKEN, NODE_AGENT_ACCESS_TOKEN, NODE_AGENT_DOMAIN
docker compose -f deploy/docker-compose.yml --profile public up -d --build
```

Two services, no third one:

```
internet -> caddy :443 -> stack :8080 (the built-in door) -> stack :8790 (the page)
```

- **caddy** takes `80`/`443`, gets a certificate for `NODE_AGENT_DOMAIN` (the DNS record must exist
  first, and the host must take those ports), and proxies to `stack:8080`. It never sees a token.
- **stack** is the same image and the same container as local mode, with its built-in door open: the
  door is a second listener inside the same process, `NODE_AGENT_PROXY_PORT` (`8080`) on the compose
  network, and nothing publishes it to the host.

The door is the login page, and it only opens when `NODE_AGENT_ACCESS_TOKEN` is set:

| variable | default | what it does |
|---|---|---|
| `NODE_AGENT_ACCESS_TOKEN` | unset | the switch, and the token typed at `/login` |
| `NODE_AGENT_PROXY_PORT` | `8080` | where the door listens (Caddy's upstream) |
| `NODE_AGENT_PROXY_SECURE` | `0` | `1` marks the login cookie `Secure`; set it in public mode |
| `NODE_AGENT_DOMAIN` | `localhost` | the name Caddy asks a certificate for |
| `ACME_EMAIL` | empty | only used for ACME expiry notices |

Set the token and the door behaves like this:

- `GET /login` is the form; `POST /login` takes the token and sets one `HttpOnly`, `SameSite=Lax`,
  `Path=/`, 30-day cookie holding `sha256(token)` — never the token itself, and never in a URL or a log
- every other path needs that cookie, or `Authorization: Bearer <token>` for scripts; without it a
  browser is redirected to `/login` (303) and other methods get `401`
- `/bus` (WebSocket upgrade) and `/events` (SSE) are piped, not buffered, so they survive both hops
- `/healthz` stays open, and the upstream is the webui this process just started — fixed at boot, so
  the door cannot be used as an open proxy

Forget the token and the door does not listen at all: Caddy answers `502` instead of serving the page
to the internet. That is the failure it should have.

Try it on one machine: set `NODE_AGENT_DOMAIN=localhost` and Caddy signs the name with its own local CA
(no DNS, no public ports). For a real host, the record has to point there before the first start.

One thing this mode does not hide: `stack` still publishes the page on `127.0.0.1:8790` of the host,
because that is also the local mode. Only processes on that machine can use it; everything off the
machine has to come through Caddy and the door.

Two things the door is not:

- **not TLS.** It speaks plain HTTP on the compose network; Caddy is the one holding the certificate.
  That is why `NODE_AGENT_PROXY_SECURE=1` belongs in public mode, and why the cookie it hands out is
  not `Secure` when you leave the default.
- **not `NODE_AGENT_TOKEN`.** Keep the two separate: the bus token lets a node register on the bus, the
  access token only lets a browser read the page. Rotating the access token logs browsers out (the
  cookie is a hash of it) and changes nothing else.

## Operations that are worth having

- **Backup:** stop the stack, copy the `data` volume's `history/` directory. Nothing else is written.
- **Upgrade:** `git pull && docker compose -f deploy/docker-compose.yml up -d --build` (or add
  `--profile public` if that is what you run). The history schema is migrated on start.
- **The `memory` → `notes` rename:** the memos written before it are still in the history database,
  filed under the old node name (the history node files every unit by the node that wrote it). Stop
  the stack and run the copy once — `node node_agent/nodes/notes/scripts/migrate-memos-from-memory.mjs`
  (with `[path]` to name the database; `--dry-run` to see what it would
  do). It keeps the old units, so a downgrade still finds them.
- **Rotate a token:** change it in `deploy/.env`, restart (`docker compose ... up -d`; keep the profile
  flag you started with). Rotating `NODE_AGENT_TOKEN` revokes every node; rotating
  `NODE_AGENT_ACCESS_TOKEN` logs browsers out.
- **Logs:** `docker compose -f deploy/docker-compose.yml logs -f stack` (and `... caddy` in public mode);
  node logs also land in the runtime home under `/data`.

## What this deployment is not

No multi-tenancy, no invites, no quotas, no audit trail, no zero-downtime upgrade. If you need those,
this repository is the wrong shape — it is one person's agent, deliberately.
