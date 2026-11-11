[English](README.md) | 简体中文

# @node-agent/shell

`@node-agent/shell` 是 node-agent 总线上一个节点，它在总线上的名字是 `shell`。它就是那个真正去碰机器的节点：读写文件、搜索、执行命令（短的当场返回，长的变成会话继续跑）、在同一个总线上启动其他本地节点、保存用户自定义的命令，并为 Web UI 带来自己的页面。

它只是一个节点，不是一个进程。SDK 宿主每次调用都新建一个 `ShellNode`，调用结束就丢掉，所以任何需要活过一次调用的东西都不在它身上：`exec` 留下的会话、`run-node` 启动的节点、路径解析所依据的目录、用户的能力开关，全都放在按租户划分、每个进程只创建一次的 `ShellService` 里。

下面列出的能力就是 `package.json` 里 `node.caps` 中的那些——同一份声明既由总线注册，也是 agent 工具列表的来源。除非节点以另一个名字启动（见[运行它](#运行它)），每个能力都叫 `shell.<name>`。

## 它能做什么

### 文件

| 能力 | 做什么 |
|---|---|
| `read` | 按文本读一个文件；`offset` / `limit` 以行计；每次调用 256 KiB，超出截断并加标记；含 NUL 字节的文件按非文本拒绝 |
| `write` | 创建或覆盖一个文件，父目录自动创建；内容上限 1 MiB |
| `edit` | 替换一段字面文本；`old` 必须只出现一次，除非 `replaceAll: true`；结果同样上限 1 MiB |
| `list` | 列一个目录，`d` / `f` 加字节数，最多 500 条 |
| `glob` | 按模式找文件名（`**/*.ts`），最多 200 个匹配 |
| `grep` | 在一个目录下的文件里跑正则，输出 `path:line: the line`；最多 200 行匹配，超过 1 MiB 的文件跳过，不跟随符号链接，最多扫描 2000 个文件 |

相对路径从节点的 root 开始（见 [`NODE_AGENT_SHELL_ROOT`](#环境变量)）；绝对路径按原样使用，可以到达 Shell 进程能到达的任何位置。`grep` 遇到不是合法正则的模式直接报错，而不是悄悄匹配不到东西。

### 页面用的文件能力

Web UI 的页面不是另一套实现：它通过自己专用的三个能力来列目录、读文件、保存，因为这三种答案得是页面能画出来的东西。

| 能力 | 做什么 |
|---|---|
| `files-tree` | 一个目录的 JSON（`name`、`path`、`type`、`size`、`mtime`，以及可选的 `children`）；`depth` 最大 4，每个目录最多 1000 条，一次回答最多 4000 个节点 |
| `files-read` | 文本带行数、图片（`png`、`jpg`、`gif`、`webp`、`avif`、`bmp`、`ico`、`svg`）以 data URL 返回，其余是一份结构化拒绝：文本超过 512 KiB、图片超过 4 MiB、二进制或非文本 |
| `files-write` | 保存页面改过的文件并返回新 revision；路径命中 deny list 时回答 `kind: 'denied'`，内容超限回答 `kind: 'too-large'`，`expectedRevision` 过期回答 `kind: 'conflict'` 并带上文件当前的 revision——所以别人动过的文件不会被顺手覆盖。省略 `expectedRevision` 就是页面在说“以我的为准” |

revision 是文件自己的 mtime（微秒），所以这个检查能扛过重启，也不需要旁表。

### 命令，以及长命令变成的会话

| 能力 | 做什么 |
|---|---|
| `exec` | 用 `/bin/sh -c` 在 `cwd`（默认：workspace）里跑一条命令，等待 `yield_ms`（默认 10 秒，最多 30 秒） |
| `sessions` | 正在跑的会话：id、状态、年龄、pid、命令 |
| `write-stdin` | 给一个会话写输入，并读它上次被读之后产生的东西 |
| `kill-session` | 先 SIGTERM，两秒后进程还在就 SIGKILL |

一条命令在等待时间结束时还在跑，就以会话句柄的形式交回来，进程继续跑；它跨调用、跨轮次都在。几点值得知道：

- 子进程自成一个进程组，所以一次 kill 会连它的子进程一起带走（`sh -c 'sleep 100'` 不会留下一个 `sleep`）
- 输出是尾部：每条流保留 256 KiB，更早的输出被丢弃并计数，一次读取最多回 `max_output` 个字符（默认也是硬上限 4000）
- `timeout_ms` 是截止时间；不给就只有 30 分钟的会话上限，到点被杀的进程报 `exit 124`
- 最多同时跑 8 个会话；8 个已结束的会话在结束后 5 分钟内还能读
- `exec` 的 `cwd` 是唯一完全不作检查的路径参数——命令本来哪里都能去，在那里加检查只是装饰

### 其他本地节点

| 能力 | 做什么 |
|---|---|
| `run-node` | 让一个本地节点包对着这条总线跑起来，或者跑一个普通入口脚本 |
| `list-local-running-nodes` | 这个 shell 启动过什么，以及每个是否还在跑 |
| `kill-node` | 停掉一个，用它的 run-node 名字或它的会话 id 指定 |

一个目录（或一个文件正是某个包声明的 `node.entry`、或它的 `dist/serve.js`）会作为包运行：走的就是 store 启动已安装节点的那条 `node <sdk>/dist/serve.js <package dir>`，以包的 `node.id`（或 `name`）注册，不带参数——`args` 是给普通入口脚本的，给包会被拒绝。`.py` 脚本用 `NODE_AGENT_PYTHON`（默认 `python3`）跑，其他脚本用本进程自己的 `node`。包里的脚本依然只是脚本。

`run-node` 要求这个 shell 已经连上总线：它从自己的环境里读 `NODE_AGENT_BUS_URL` 和 `NODE_AGENT_TOKEN`，并且只把这两个交给子进程（普通脚本再加 `NODE_AGENT_NODE_NAME`，那是它自我命名的老办法）。没有这两个变量它会失败并说“run-node needs this shell to be joined to a bus”。

### 用户保存的命令

| 能力 | 做什么 |
|---|---|
| `custom-commands` | `list` / `get` / `add` / `update` / `delete`；每个回答都带上整份清单 |
| `run-custom` | 按名字跑一条 |

一条保存的命令就是一段 `/bin/sh` 脚本，用 `-c` 原样执行，在自己的 `cwd` 里、自己的截止时间下（最多 30 分钟）——和 `exec` 相同的截止时间、输出上限和工作目录。它的参数以 argv 传入（`$1`、`$2`、……），同时再以 JSON 形式放进一个变量 `SHELL_CUSTOM_ARGS`，所以调用方给的一个词永远变不成 shell 代码；脚本还能看到 `SHELL_CUSTOM_NAME`、`SHELL_CUSTOM_ID` 和 `SHELL_CUSTOM_COUNT`。上限：100 条命令，每条脚本 16 KiB，每次调用 64 个参数，每条命令 32 个变量名。

这份清单作为历史单元 `shell.custom_commands` 记在 `history` 节点上。命令定义可以点名额外的变量从 shell 的环境里取，但永远不能点 `NODE_AGENT_*` 的：那是能把总线带走的那个家族。

### 发布一个包

`publish` 用 SDK 的 `packLocalPackage` 打包一个本地包目录（`dir`，默认 root），把 manifest 和归档交给本总线上的 `store.publish`；`version` 覆盖这一次发布的版本，`overwrite` 替换已经存在的同版本。它需要一个 `store` 节点——`node_agent/node-agent` 里的个人版栈没有，所以在那儿这个能力无处投递。

### 开关和页面

| 能力 | 做什么 |
|---|---|
| `permissions` | 已保存的开关：每个能力一行，带上它的 effect 和规则点了哪些调用方——页面把它们画成四个组 |
| `set-permissions` | 保存这些开关 |
| `ui` | 节点自己的页面（`shell.ui`），Web UI 在 `/panel/<the node's name>` 处提供它 |

四个开关，而不是二十个，因为四个就是一个人真正做决定的粒度：**`READ`**
（`read`、`list`、`glob`、`grep`、`files-tree`、`files-read`、`list-local-running-nodes`、
`permissions`）、**`WRITE`**（`write`、`edit`、`files-write`、`publish`、`custom-commands`）、
**`EXEC`**（`exec`、`run-node`、`kill-node`、`write-stdin`、`sessions`、`kill-session`）和
**`EXEC_CUSTOM`**（`run-custom`——用户自己保存的命令，按用户的话跑，而不是按模型的话跑）。节点本身
仍然按能力保存一条 `{ cap, callers }` 规则，所以一个组开关会摊到它覆盖的每一个能力上，总线级的
检查读到的还是同一批规则；一个只关了一部分的组（手工改过的文件）读的时候显示为关，保存时写整个组。

每个能力在运行前都先过开关，被关掉的能力会在碰机器之前就拒绝调用方，并同时说出是哪个能力、哪个调用方。`ui` 和 `set-permissions` 只为 `webui` 保留；`permissions` 和 `custom-commands` 即使被关掉，`webui` 也仍然能调到，所以页面永远能把东西重新打开。

开关是这个节点自己的状态，每个租户一个文件：`$NODE_AGENT_HOME/shell/tenants/<tenant-key>/permissions.json`。租户键是租户名清洗成一个安全的路径段，再加它 SHA-256 的十二个十六进制字符，所以两个租户永远不会共用一个文件。文件读不出来或格式坏了，含义是“什么都没被关掉”，并由页面说明原因——这是偏好，不是沙箱（见[权限与风险](#权限与风险)）。保存没能落盘时，新值仍在运行中的进程里生效，并回答 `persisted: false` 和原因。

## 运行它

### 从一份 checkout 运行

```bash
npm install                                  # at the repository root
npm run build -w @node-agent/shell            # tsc -> dist/, then ui.html + icon.svg next door
node node_agent/nodes/shell/dist/serve.js
```

`dist/serve.js` 连上环境里指名的总线，一直服务到 SIGINT 或 SIGTERM。包里的 `npm start` 通过共享 runner 做的是同一件事（`node-agent-sdk .`），`npx @node-agent/sdk node_agent/nodes/shell` 也是。

`node dist/serve.js` 也可以接受一个总线名字——`--name computer`，或 `NODE_AGENT_NODE_ID=computer`——给那些一直把这个节点叫 `computer` 的栈用；能力会跟着名字一起换前缀（`computer.read`、……）。由 runner 启动的包则用它自己的 `node.id`（`shell`）注册。

### 在 node-agent 运行时里

shell 不在运行时的默认节点列表里。把它的包名写进 `NODE_AGENT_NODES`——一个逗号分隔的包根列表，运行时会把它像其他节点一样作为 worker 启动：

```bash
NODE_AGENT_NODES=node-agent-provider,@node-agent/shell,node-agent-webui \
  node --env-file=deploy/node-agent/.env node_agent/node-agent/dist/serve.js
```

运行时会把总线交给它启动的每个节点，所以那里的总线地址和 token 是运行时的事，不是你的。

### 从 npm 安装

```bash
npx @node-agent/shell
```

包里自带 `node-agent-shell` bin，`npx` 会直接启动这个节点，不需要另外安装 SDK 或写包路径。

## 环境变量

| 变量 | 默认值 | 它决定什么 |
|---|---|---|
| `NODE_AGENT_BUS_URL` | `ws://127.0.0.1:8788` | 要连上哪条总线 |
| `NODE_AGENT_TOKEN` | `demo-token`（SDK runner 的默认值，也是总线的） | 连上总线时出示的 token；从 `deploy/.env` 启动的栈有真正的 token，所以这里也要设 |
| `NODE_AGENT_NODE_ID` | 包的 `node.id`，即 `shell` | 注册用的总线名字；由 `dist/serve.js` 读取（`--name` 同样） |
| `NODE_AGENT_WORKSPACE` | 进程的当前目录 | `exec`、`run-custom`、`run-node` 的相对路径起点，也是命令默认的 `cwd` |
| `NODE_AGENT_SHELL_ROOT` | workspace | 文件能力相对路径的起点。设成一个并不存在的目录时，节点在构建自己的 shell 时就失败，之后每次调用都带着这个路径报错——拼错的地方不会被猜。每个租户每个进程只解析一次；后来的调用方无法移动一个活着的 shell 的 root |
| `NODE_AGENT_SHELL_DENY_WRITE` | 空 | 任何文件能力都不许写的额外名字，逗号分隔的段通配（`*.pem`、`secrets*`）。它只能往内建的 `.git`、`homes`、`*.pem`、`*.key`、`**/secrets*`、`.env*` 上加——一个变量就能缩短的名单不算名单 |
| `NODE_AGENT_PYTHON` | `python3` | `run-node` 跑 `.py` 入口脚本时用的解释器 |
| `NODE_AGENT_HOME` | `~/.node_agent` | 能力开关所在的地方：`$NODE_AGENT_HOME/shell/tenants/<tenant-key>/permissions.json` |
| `NODE_AGENT_TENANT` | `default`（SDK runner 的默认值） | 一个进程服务哪个租户的 shell——会话、开关和 root 都按租户分开 |

`NODE_AGENT_WORKSPACE` 和 `NODE_AGENT_SHELL_ROOT` 回答的是两个不同的问题：workspace 是*命令*在哪里跑，root 是*文件能力的*相对路径从哪里开始。两者都不约束绝对路径；见下一节。

deny list 上的路径按名字比较，先做 NFKC 再转小写（大小写折叠），所以在认为大小写无关的文件系统上 `.GIT` 和 `.git` 是同一个目录。`src/git.txt` 和 `notes/pem.md` 依然是普通文件——段通配匹配的是整个路径段，永远不会是子串。

### 命令能拿到什么环境

`exec` 不会把本节点的环境交给命令。它交出的是一份白名单：`PATH`、`HOME`、`LANG`、`LC_*`、`TERM`、`SHELL`、`USER`、`LOGNAME`、`TMPDIR`、`TZ`——以及别的什么都没有。总线 token、模型 key、`AWS_*`、`GITHUB_TOKEN`、`SSH_AUTH_SOCK`：否则它们全都只隔着一个 `echo`。

有两个能力是有意往上加的。`run-node` 加上 `NODE_AGENT_BUS_URL` 和 `NODE_AGENT_TOKEN`（普通脚本再加 `NODE_AGENT_NODE_NAME`），因为启动一个本地节点恰好就是需要这两个的场景。`run-custom` 加上一条命令定义保存下来的那些变量名，其中永远不会有 `NODE_AGENT_*`。

## 权限与风险

**这不是沙箱。** 它是一个带权限的 shell，值得把它的含义说清楚：

- **命令以启动节点的那个用户身份运行**——就是进程用户，带着这个用户的权限；没有 `setuid`，没有 jail，没有自己的 namespace。`exec`、`run-node` 和 `run-custom` 是同一回事。
- **绝对路径能到达进程能到达的地方。** 文件能力把相对路径解析到 root 之下，绝对路径按原样使用；它背后唯一的边界是操作系统自己的权限。
- **deny list 限制写，不限制读。** `NODE_AGENT_SHELL_DENY_WRITE` 和它的内建名单能挡住 `write`、`edit` 和 `files-write` 去碰 `.git`、密钥、`secrets*`、`.env*` 之类。`read`、`list`、`glob`、`grep`、`files-read` 和 `exec` 仍然够得着它们，除非你在别处禁掉——`cat .env` 就是一条普通命令。
- **开关管的是调用方，不是路径。** `set-permissions` 可以彻底不让 agent 调 `exec`；它不能让 `exec` 在允许之后变得安全。
- **prompt injection 能到达 shell。** 模型读到一个恶意文件或一段命令输出，就可能被要求去执行点什么，而任何进到 `shell.exec` 的东西都会被执行。真正起作用的边界是 agent 能看到什么、开关放行哪些调用方，以及底下这台机器。

如果你需要隔离，把整个栈跑在 `deploy/` 的容器里，只挂载 agent 可以碰的东西；见 [docs/security.md](../../../docs/security.md) 和 [docs/quickstart.md](../../../docs/quickstart.md) 里的一键启动。不要把这个节点描述成沙箱——`SECURITY.md` 和 `docs/security.md` 出于同样的理由是这么说的。

## npm、构建与发布

- 包名 `@node-agent/shell`，版本 `0.1.1`，publisher `node-agent`，MIT（见 [`LICENSE`](LICENSE)）
- 源码：<https://github.com/LKJacky/NodeAgentOS>，目录 `node_agent/nodes/shell`
- tarball 里是 `dist/`、`src/icon.svg`、`src/ui.html`、`LICENSE` 以及两份 README（`README.md`、`README.zh-CN.md`）——没有 TypeScript 源码，也没有测试
- `npm run build` 用 `tsc` 编译，并把页面和图标拷进 `dist/`
- `prepack` 从仓库根重新同步 `LICENSE`，所以即使跳过脚本，打出来的 tarball 也是合规的
- `prepublishOnly`（本包新增）会跑构建，所以 `npm publish` 不可能发出比源码旧的 `dist/`；`--ignore-scripts` 会把两者都跳过，那时构建就得你自己跑

```bash
npm run build            # tsc -> dist/, then the page and icon next to it
npm test                 # builds first, then node --test over test/*.test.ts and *.test.mjs
npm pack --dry-run       # what a publish would upload
npm publish              # build (prepublishOnly) -> LICENSE sync (prepack) -> tarball
```

## 一个叫 `computer` 的节点

一直把这个节点叫 `computer` 的栈可以保留这个名字——`--name computer`，或 `NODE_AGENT_NODE_ID=computer`。别的都不会变：SDK runner 把这次改名同时登记为节点名和包 id，能力还是同一份列表，只是换了前缀（`computer.read`、`computer.exec`、……），页面在 `/panel/<that name>`。
