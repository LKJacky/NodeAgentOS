English | [简体中文](README.zh-CN.md)

# @node-agent/shell

`@node-agent/shell` is the node-agent bus node whose name on the bus is `shell`. It is the node that
touches the machine: it reads, writes and searches files, runs commands (short ones inline, long ones
as sessions that keep running), starts other local nodes on the same bus, keeps commands the user
saved, and brings its own page for the Web UI.

It is a node, not a process. The SDK host builds one `ShellNode` per call and throws it away, so
nothing that has to outlive a call lives on it: the sessions `exec` leaves running, the nodes
`run-node` started, the directories paths resolve against and the user's capability switches all live
in one `ShellService` per tenant, made once for the process.

The capabilities below are the ones in `package.json`'s `node.caps` — the same block the bus
registers and the agent's tool list is built from. Each is `shell.<name>` unless the node was started
under another name (see [Running it](#running-it)).

## What it can do

### Files

| capability | what it does |
|---|---|
| `read` | one file as text; `offset` / `limit` count lines; 256 KiB per call, cut with a marker; a file holding a NUL byte is refused as not text |
| `write` | create or overwrite one file, parents made; 1 MiB of content |
| `edit` | replace one literal snippet; `old` must appear exactly once unless `replaceAll: true`; result capped at 1 MiB |
| `list` | one directory, `d` / `f` plus size, 500 entries |
| `glob` | names by pattern (`**/*.ts`), 200 matches |
| `grep` | a regex over files under a directory, `path:line: the line`; 200 matching lines, files over 1 MiB skipped, symlinks not followed, at most 2000 files scanned |

A relative path starts at the node's root (see [`NODE_AGENT_SHELL_ROOT`](#environment)); an absolute
path is taken as it is and may reach anywhere the Shell process can. `grep` refuses a pattern that is
not a valid regular expression instead of quietly matching nothing.

### The page's file abilities

The Web UI page is not a second implementation: it lists, reads and saves through three capabilities
of its own, because it has to answer with something a page can draw.

| capability | what it does |
|---|---|
| `files-tree` | one directory as JSON (`name`, `path`, `type`, `size`, `mtime`, optional `children`); `depth` up to 4, 1000 entries per directory, 4000 nodes per answer |
| `files-read` | text with its line count, an image (`png`, `jpg`, `gif`, `webp`, `avif`, `bmp`, `ico`, `svg`) as a data URL, or a structured refusal: text over 512 KiB, images over 4 MiB, anything binary or non-text |
| `files-write` | save an edited file and answer with its new revision; a path on the deny list answers `kind: 'denied'`, an oversized body `kind: 'too-large'`, and a stale `expectedRevision` `kind: 'conflict'` with the revision the file is at now — so a file somebody else touched is not written over by accident. Omitting `expectedRevision` is how the page says "keep mine" |

The revision is the file's own mtime in microseconds, so the check survives a restart and needs no
side table.

### Commands, and the sessions long ones become

| capability | what it does |
|---|---|
| `exec` | run a command with `/bin/sh -c` in `cwd` (default: the workspace), wait `yield_ms` (default 10 s, max 30 s) |
| `sessions` | the long-running sessions: id, state, age, pid, command |
| `write-stdin` | send input to a session and read what it produced since the last read |
| `kill-session` | SIGTERM, then SIGKILL two seconds later if the process is still there |

A command that is still running when the wait ends comes back as a session handle and keeps going; it
lives across calls and across turns. Details worth knowing:

- the child leads its own process group, so a kill takes its children too (`sh -c 'sleep 100'` leaves
  no `sleep` behind)
- output is a tail: each stream keeps 256 KiB, older output is dropped and counted, and one read hands
  back at most `max_output` characters (default and hard ceiling 4000)
- `timeout_ms` is a deadline; without one only the 30-minute session cap applies, and a kill on the
  deadline reports `exit 124`
- at most 8 sessions run at once; 8 finished ones stay readable for 5 minutes after they end
- `exec`'s `cwd` is the one path argument that is not checked at all — a command can go anywhere
  anyway, so a check there would only be decoration

### Other local nodes

| capability | what it does |
|---|---|
| `run-node` | start a local node package against this bus, or a plain entry script |
| `list-local-running-nodes` | what this shell started, and whether each is still running |
| `kill-node` | stop one, by its run-node name or its session id |

A directory (or a file that is a package's declared `node.entry`, or its `dist/serve.js`) runs as a
package: through the same `node <sdk>/dist/serve.js <package dir>` the store starts, registering under
the package's `node.id` (or `name`), with no arguments — `args` are for a plain entry script and are
refused for a package. A `.py` script runs under `NODE_AGENT_PYTHON` (default `python3`), anything
else under this process's own `node`. A script inside a package is still a script.

`run-node` needs this shell to be joined to a bus: it reads `NODE_AGENT_BUS_URL` and `NODE_AGENT_TOKEN`
from its own environment and hands exactly those two to the child (plus `NODE_AGENT_NODE_NAME` for a
plain script, which names itself the old way). Without them it fails with "run-node needs this shell to
be joined to a bus".

### Commands the user saved

| capability | what it does |
|---|---|
| `custom-commands` | `list` / `get` / `add` / `update` / `delete`; the whole list comes back on every answer |
| `run-custom` | run one by name |

A saved command is a `/bin/sh` script run with `-c`, exactly as written, in its own `cwd`, under its
own deadline (at most 30 minutes) — the same deadline, output ceiling and working directory `exec`
gets. Its arguments are passed as argv (`$1`, `$2`, …) and again as one JSON variable,
`SHELL_CUSTOM_ARGS`, so a caller's word can never become shell code; the script also sees
`SHELL_CUSTOM_NAME`, `SHELL_CUSTOM_ID` and `SHELL_CUSTOM_COUNT`. Limits: 100 commands, 16 KiB per
script, 64 arguments per call, 32 variable names per command.

The list is filed with the `history` node as the unit `shell.custom_commands`. A command definition
may name extra variables to take from the shell's environment, but never a `NODE_AGENT_*` one: that is
the family that walks off with the bus.

### Publishing a package

`publish` packs a local package directory (`dir`, default the root) with the SDK's `packLocalPackage`
and hands the manifest and archive to `store.publish` on this bus; `version` overrides the version for
that publish and `overwrite` replaces one already there. It needs a `store` node — the personal stack
in `node_agent/node-agent` has none, so there this capability has nowhere to send anything.

### Switches and the page

| capability | what it does |
|---|---|
| `permissions` | the saved switches: one row per capability, with its effect and the callers a rule names — the page draws them as four groups |
| `set-permissions` | save the switches |
| `ui` | the node's own page (`shell.ui`), which the Web UI serves at `/panel/<the node's name>` |

Four switches, not twenty, because four is the granularity a person decides at: **`READ`**
(`read`, `list`, `glob`, `grep`, `files-tree`, `files-read`, `list-local-running-nodes`,
`permissions`), **`WRITE`** (`write`, `edit`, `files-write`, `publish`, `custom-commands`), **`EXEC`**
(`exec`, `run-node`, `kill-node`, `write-stdin`, `sessions`, `kill-session`) and **`EXEC_CUSTOM`**
(`run-custom` — the commands the user saved, which run by the user's word rather than the model's).
The node still keeps one `{ cap, callers }` rule per capability, so a group switch fans out to every
capability it covers and a bus-wide check reads the same rules; a group that is only part off (a file
written by hand) reads as off, and saving writes the whole group.

Every capability goes through the switches before it runs, and a capability that is off refuses its
caller — naming both the capability and the caller — before anything touches the machine. `ui` and
`set-permissions` are reserved for `webui`; `permissions` and `custom-commands` are reachable by
`webui` even when switched off, so the page can always be used to switch things back on.

The switches are this node's own state, one file per tenant:
`$NODE_AGENT_HOME/shell/tenants/<tenant-key>/permissions.json`. The tenant key is the tenant name
made into one safe path segment plus twelve hex characters of its SHA-256, so two tenants never share
a file. An unreadable or malformed file means "nothing is switched off" and the page says why — these
are a preference, not a sandbox (see [Permissions and risk](#permissions-and-risk)). A save that
fails to reach disk still takes effect in the running process and answers `persisted: false` with the
reason.

## Running it

### From a checkout

```bash
npm install                                  # at the repository root
npm run build -w @node-agent/shell            # tsc -> dist/, then ui.html + icon.svg next door
node node_agent/nodes/shell/dist/serve.js
```

`dist/serve.js` joins the bus the environment names and serves until SIGINT or SIGTERM. `npm start`
inside the package is the same thing through the shared runner (`node-agent-sdk .`), and so is
`npx @node-agent/sdk node_agent/nodes/shell`.

`node dist/serve.js` also takes a bus name — `--name computer`, or `NODE_AGENT_NODE_ID=computer` — for
a stack that has always called this node `computer`; the capabilities follow the name with it
(`computer.read`, …). A package started by a runner registers under its `node.id` (`shell`).

### Inside the node-agent runtime

The shell is not in the runtime's default node list. Name its package in `NODE_AGENT_NODES` — a
comma-separated list of package roots the runtime starts as workers beside the rest:

```bash
NODE_AGENT_NODES=node-agent-provider,@node-agent/shell,node-agent-webui \
  node --env-file=deploy/node-agent/.env node_agent/node-agent/dist/serve.js
```

The runtime hands each node the bus it started, so the bus URL and token there are the runtime's
business, not yours.

### From npm

```bash
npx @node-agent/shell
```

The package carries its own `node-agent-shell` bin, so `npx` starts the node directly; no separate SDK install or package path is needed.

## Environment

| variable | default | what it decides |
|---|---|---|
| `NODE_AGENT_BUS_URL` | `ws://127.0.0.1:8788` | the bus to join |
| `NODE_AGENT_TOKEN` | `demo-token` (the SDK runner's default, and the bus's) | the token presented when joining; a stack started from `deploy/.env` has a real one, so set it here too |
| `NODE_AGENT_NODE_ID` | the package's `node.id`, `shell` | the bus name to register under; read by `dist/serve.js` (as is `--name`) |
| `NODE_AGENT_WORKSPACE` | the process's current directory | where relative paths start for `exec`, `run-custom` and `run-node`, and the default `cwd` of a command |
| `NODE_AGENT_SHELL_ROOT` | the workspace | where the file abilities' relative paths start. Set to something that is not an existing directory, the node fails while building its shell and every call answers with that path — a typo is not guessed at. Resolved once per tenant per process; a later caller cannot move a live shell's root |
| `NODE_AGENT_SHELL_DENY_WRITE` | empty | extra names no file ability may write, comma-separated segment globs (`*.pem`, `secrets*`). It can only add to the built-in `.git`, `homes`, `*.pem`, `*.key`, `**/secrets*`, `.env*` — a list a variable can shorten is not a list |
| `NODE_AGENT_PYTHON` | `python3` | the interpreter `run-node` uses for a `.py` entry script |
| `NODE_AGENT_HOME` | `~/.node_agent` | where the capability switches live: `$NODE_AGENT_HOME/shell/tenants/<tenant-key>/permissions.json` |
| `NODE_AGENT_TENANT` | `default` (the SDK runner's default) | which tenant's shell a process serves — sessions, switches and root are per tenant |

`NODE_AGENT_WORKSPACE` and `NODE_AGENT_SHELL_ROOT` answer different questions: the workspace is where a
*command* runs, the root is where a *file ability's* relative path starts. Neither confines an absolute
path; see the next section.

A path on the deny list is compared by name, case-folded (NFKC, then lower case), so `.GIT` and `.git`
are one directory on a filesystem that thinks so. `src/git.txt` and `notes/pem.md` stay ordinary
files — a segment glob is matched against a whole path segment, never a substring.

### What a command inherits

`exec` does not hand a command this node's environment. It hands a whitelist: `PATH`, `HOME`, `LANG`,
`LC_*`, `TERM`, `SHELL`, `USER`, `LOGNAME`, `TMPDIR`, `TZ` — and nothing else. The bus token, the
model key, `AWS_*`, `GITHUB_TOKEN`, `SSH_AUTH_SOCK`: all of it would otherwise be one `echo` away.

Two capabilities add to that on purpose. `run-node` adds `NODE_AGENT_BUS_URL` and `NODE_AGENT_TOKEN`
(and `NODE_AGENT_NODE_NAME` for a plain script), because starting a local node is exactly the case
where those are the point. `run-custom` adds the names a command's definition saved, never a
`NODE_AGENT_*` one.

## Permissions and risk

**This is not a sandbox.** It is a permissioned shell, and it is worth stating plainly what that means:

- **Commands run as whoever started the node** — the process user, with that user's rights, no `setuid`,
  no jail, no namespace of its own. `exec`, `run-node` and `run-custom` are the same story.
- **An absolute path reaches what the process can reach.** The file abilities take relative paths from
  the root and absolute paths as given; the operating system's own permissions are the only boundary
  behind it.
- **The deny list limits writes, not reads.** `NODE_AGENT_SHELL_DENY_WRITE` and its built-in names stop
  `write`, `edit` and `files-write` from touching `.git`, keys, `secrets*`, `.env*` and friends. `read`,
  `list`, `glob`, `grep`, `files-read` and `exec` still reach them unless you deny them elsewhere —
  `cat .env` is a command like any other.
- **The switches name callers, not paths.** `set-permissions` can stop an agent from calling `exec` at
  all; it cannot make `exec` safe once it is allowed.
- **Prompt injection reaches the shell.** A model that reads a hostile file or command output can be
  told to run something, and what reaches `shell.exec` runs. The boundaries that matter are what the
  agent can see, which callers the switches allow, and the machine underneath.

If you need isolation, run the stack in the container from `deploy/` and mount only what the agent
may touch; see [docs/security.md](../../../docs/security.md) and the one-command start in
[docs/quickstart.md](../../../docs/quickstart.md). Do not describe this node as a sandbox — the
`SECURITY.md` and `docs/security.md` notes say the same, for the same reason.

## npm, build and publish

- package `@node-agent/shell`, version `0.1.1`, publisher `node-agent`, MIT (see [`LICENSE`](LICENSE))
- source: <https://github.com/LKJacky/NodeAgentOS>, directory `node_agent/nodes/shell`
- the tarball carries `dist/`, `src/icon.svg`, `src/ui.html`, `LICENSE` and both READMEs (`README.md`,
  `README.zh-CN.md`) — no TypeScript sources and no tests
- `npm run build` compiles with `tsc` and copies the page and the icon into `dist/`
- `prepack` re-syncs `LICENSE` from the repository root, so a tarball is legal even when scripts
  are skipped
- `prepublishOnly` (added here) runs the build, so `npm publish` can never ship a `dist/` older than
  the sources; `--ignore-scripts` skips both, and then the build is yours to run

```bash
npm run build            # tsc -> dist/, then the page and icon next to it
npm test                 # builds first, then node --test over test/*.test.ts and *.test.mjs
npm pack --dry-run       # what a publish would upload
npm publish              # build (prepublishOnly) -> LICENSE sync (prepack) -> tarball
```

## A node named `computer`

A stack that has always called this node `computer` keeps that name — `--name computer`, or
`NODE_AGENT_NODE_ID=computer`. Nothing else changes with it: the SDK runner registers the rename as
both the node's name and its package id, and the capabilities are the same list under the new prefix
(`computer.read`, `computer.exec`, …), with the page at `/panel/<that name>`.
