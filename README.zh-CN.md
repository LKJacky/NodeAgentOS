# node-agent

[English](README.md) | [中文](README.zh-CN.md)

![node-agent：一个点，衍生出很多节点，你的专属 Agent](docs/assets/hero.svg)

**一个你自己运行的完整 Agent。** 一条总线、一组小而专注的工具节点，以及一个不挡路的 Web UI。
它面向一个人——你的机器，或你自己的内网。没有注册、没有租户、没有账单。模型密钥由你提供，兼容
任意 OpenAI-compatible 接口。

## ⚡ 30 秒启动

需要 Node 23.6 或更新版本（`.nvmrc` 和 CI 使用 24）以及 npm。

```bash
npx @node-agent/local
# 打开 http://127.0.0.1:8790/
```

一个镜像，两种启动方式——先在本地跑，确认要公网访问再加门：

```bash
# 本地：只启动 stack，页面在 127.0.0.1:8790
cp deploy/env.example deploy/.env                            # 填入 token
docker compose -f deploy/docker-compose.yml up -d --build

# 公网：同一个 stack，加上 Caddy 的 80/443 和证书
# （需要在 deploy/.env 设置 NODE_AGENT_ACCESS_TOKEN 和 NODE_AGENT_DOMAIN）
docker compose -f deploy/docker-compose.yml --profile public up -d
```

## 🧠 它是什么

| 层 | 含义 |
|---|---|
| **bus** (`node_agent/bus`) | 一条 WebSocket 总线；每个节点和 UI 都是它的客户端 |
| **runtime** (`node_agent/runtime`) | runtime 契约（`Runtime`：总线、节点、用户作为访问关系），以及把同一接口放到 HTTP 上的 `RuntimeServer`，让 runtime 可以运行在别处 |
| **nodes** (`node_agent/nodes/*`，节点包） | 小包：`agent`、`history`、`provider`、`shell`、`search`、`webui`、`notes`、`todo`、`timer`、`system`、`introduce` |
| **sdk** (`node_agent/sdk`) | 写节点时面对的东西：信封、manifest、runner |
| **node-agent** (`node_agent/node-agent`) | `LocalRuntime`：本进程内的总线，每个节点一个 worker 线程，以及启动整个 stack 的命令行入口 |

节点就是一个带 `node` manifest 和入口文件的包；节点之间共享的只有总线。
`node_example/hello-node` 是最小的可运行示例，[docs/node-authoring.md](docs/node-authoring.md)
会带你写自己的节点。

## 🧩 不一样在哪

- 🧠 **一个 Agent，而不是每个标签页一个聊天。** 所有页面看到同一份历史、notes、todo 和工具。
- 🧰 **工具就是节点。** 加一个包就多一种能力，Agent 在运行时发现它。
- 🖥️ **本地优先。** 文件、shell、计时器、搜索都在你身边运行；除非你选择，否则模型是唯一远程部分。
- 🔌 **不锁定。** 任意 OpenAI-compatible 接口、普通 WebSocket 总线，以及可以替换的 Web UI。

## 🚫 它不是什么

- 不是托管服务：没有需要注册的服务器
- 不是多租户：一个部署就是一个人、一个 token（内置登录页是一道门，不是账号系统）
- 不是节点商店：第三方节点自己连到你的本地总线（`npx @node-agent/sdk .`）
- 不是沙箱：`shell` 节点会在你的机器上执行命令，因为它本来就是干这个的

## 🗂 目录结构

```text
node_agent/
  sdk/         通信类型、manifest schema、节点 runner
  bus/         WebSocket 总线
  runtime/     runtime 契约，以及面向远程 runtime 的 RuntimeServer over HTTP
  node-agent/  LocalRuntime（本进程的总线和每节点 worker）以及入口，bin: node-agent
  nodes/       节点包
    agent/ history/ provider/ shell/ search/ webui/
    notes/ todo/ timer/ system/ introduce/
deploy/        一个 Dockerfile、一个 compose：`stack`，以及 public profile 里的 `caddy`
node_example/hello-node/
docs/
```

## 🛠 开发

```bash
npm install          # workspace 包 + 从 npm 安装 @node-agent/sdk
npm run build        # 按依赖顺序构建 workspace
npm test             # 先构建，再跑每个 workspace suite；全绿（计数见 docs/STATUS.md）
```

另见 [docs/quickstart.md](docs/quickstart.md)、[docs/architecture.md](docs/architecture.md)、
[docs/security.md](docs/security.md) 和 [docs/deployment.md](docs/deployment.md)。

## 📊 状态

这是一个早期的 `0.1.0` 项目，还不是生产软件。`npm run build` 是支持的构建门禁；CI 还会跑
`npm test`，它先构建，再执行每个 workspace 的测试；两者目前都是绿的。每个 suite 的计数见
[docs/STATUS.md](docs/STATUS.md)。

## 📄 License

MIT License，见 [LICENSE](LICENSE)。

每个要发布的 workspace 包都带有 npm 需要的 LICENSE 副本；副本漂移时
`npm run licenses:check` 会失败。
