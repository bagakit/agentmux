# AgentMux

AgentMux 是面向 Codex、Claude、TraeX、Hermes、Pi 等本地 Agent CLI 的可嵌入 Runtime，同时提供一个 Electron 桌面端作为第一方 Client。

`@agentmux/core` 负责 Provider、Semantic Session、Hook、Permission、恢复和类型安全的控制 API；每台执行主机上的轻量 `agentmuxd` 是唯一 PTY／进程 Owner。Desktop、Renderer 或 SSH Transport 退出后，仍在运行的 Session 不会被隐式停止。

## 当前能力

- Local／SSH 共用同一份 Daemon Session 合同，只替换连接 Transport。
- Raw Terminal 与五个内置 Agent 共用 Create、Attach、Detach、Write、Resize、Signal、Stop 和恢复边界。
- Output 使用单调 Sequence、有界 Replay、显式 Gap 和 Client Ack，不轮询或保存整屏 Snapshot。
- Daemon Run、Semantic Session、Provider-native Resume 与重新 Spawn 是不同对象和动作。
- Native Hook、ACP、Terminal Output、Daemon Process 与 User Action 保留各自 Evidence Source，不从终端文本猜测 Tool、Permission 或模型私有 Chain-of-thought。
- Desktop 支持 xterm、对话 Activity、Monaco 编辑器、文件树、拖拽分屏、Browser、Workspace、Branch／Worktree 和 Branch × Status 看板。
- Browser、文件系统和 Git Worktree 仍由 Electron Main 持有，不下沉到 Agent Daemon。

## 架构

```mermaid
flowchart LR
  UI[React workbench] --> PRELOAD[Typed sandboxed preload]
  PRELOAD --> MAIN[Electron Main]
  MAIN --> CLIENT[AgentMuxClient]
  CLIENT --> LOCAL[Local Unix socket]
  CLIENT --> SSH[Long-lived system SSH stdio]
  LOCAL --> DAEMON[agentmuxd]
  SSH --> DAEMON
  DAEMON --> PTY[node-pty / process tree]
  DAEMON --> HOOK[Authenticated loopback Hook ingress]
  MAIN --> FILES[Workspace files]
  MAIN --> GIT[Git worktrees]
  MAIN --> BROWSER[WebContentsView]
```

主要边界：

- `AgentProvider` 声明 executable、Prompt Delivery、Ready Signal、Hook、Capability 和 Resume Plan。
- `AgentMuxClient` 组合 Agent 语义与 Daemon 运行事实，但不缓存终端字节或持有 PTY。
- `agentmuxd` 持有 `sessionId + incarnationId`、node-pty、进程树、增量 Output、Replay、Backpressure 和控制确认。
- Electron Main 只调用 Core Client，并持有配置、文件、Git、Browser 和 IPC 信任边界。
- Renderer 只消费 Typed Preload API；xterm 直接写入增量 Output，渲染后按 Sequence Ack。

a mature workbench 源码证据与采用边界见 [docs/a mature workbench-agent-runtime-notes.md](docs/a mature workbench-agent-runtime-notes.md)。
Desktop 原子切换后的数据流、恢复语义和内存边界见 [docs/plans/agentmux-desktop-daemon-cutover.md](docs/plans/agentmux-desktop-daemon-cutover.md)。
Package、Doctor 与 Remote Artifact 候选边界见 [docs/plans/agentmux-package-candidate.md](docs/plans/agentmux-package-candidate.md)。

## 环境与验证

- Node.js 22 或更高版本。
- 通过 Corepack 使用仓库声明的 pnpm 版本。
- 创建 Worktree 的主机需要 Git。
- SSH Host 使用系统 OpenSSH 和用户已有认证。
- 目标主机需要相应 Agent CLI；AgentMux 不静默下载 Agent 或远端 Daemon。

```bash
corepack enable
pnpm install
pnpm check
```

构建并检查发布候选（不会 Publish）：

```bash
pnpm --filter @agentmux/core pack --pack-destination /tmp/agentmux-pack
node packages/core/bin/agentmux.js doctor --activate
node packages/core/bin/agentmux.js artifact create --output /tmp/agentmux-linux-arm64.tgz --build-id 0.1.0 --platform linux-arm64
```

## 使用 Core

下面的最小 Client 只使用包的公开 API。`dispose()` 只断开 Client，不停止 Daemon Session；需要结束进程时必须显式调用 `stopAgent()` 或 `stopTerminal()`。

```ts
import {
  AgentMuxClient,
  activateAgentMuxLocalDaemon
} from '@agentmux/core'

await activateAgentMuxLocalDaemon()

const client = new AgentMuxClient()
await client.connect()

const unsubscribe = client.onEvent((event) => {
  if (event.type === 'terminal-output') process.stdout.write(event.data)
})

const session = await client.createAgent({
  agentId: 'codex',
  workspacePath: '/srv/project',
  prompt: '检查失败测试，并说明最小正确修复。'
})

await client.writeAgent(session.semanticSessionId, '先运行聚焦测试。\r')

unsubscribe()
await client.dispose()
```

新增 Agent 只需实现 `AgentProvider` 并注入 `AgentMuxClient`，不需要了解 Electron、Local Socket 或 SSH Connector。

## Hook 合同

每个 Agent Run 会收到：

- `AGENTMUX_SESSION_ID`
- `AGENTMUX_SESSION_INCARNATION_ID`
- `AGENTMUX_SEMANTIC_SESSION_ID`
- `AGENTMUX_AGENT_ID`
- `AGENTMUX_HOOK_URL`
- `AGENTMUX_HOOK_TOKEN`

Agent 原生 Hook 向 `AGENTMUX_HOOK_URL` 发送带 Bearer Token 的 JSON：

```json
{
  "semanticSessionId": "value from AGENTMUX_SEMANTIC_SESSION_ID",
  "daemonSessionId": "value from AGENTMUX_SESSION_ID",
  "incarnationId": "value from AGENTMUX_SESSION_INCARNATION_ID",
  "agentId": "codex",
  "eventName": "PreToolUse",
  "payload": {
    "tool_name": "Bash",
    "tool_input": { "command": "pnpm test" }
  }
}
```

Ingress 只监听 Daemon 所在主机的 `127.0.0.1`，并同时核对 Agent、Semantic Session、Daemon Session 和 Incarnation。观察失败不会阻塞 Agent。全局 Hook 安装只能由用户显式执行 `preview -> install`，并带 Generation Check、Receipt 和可恢复卸载。

## Desktop

```bash
pnpm dev
```

只查看确定性演示数据：

```bash
pnpm dev:web
```

应用直接进入 Terminal-first Workbench。可以从侧栏加入本地目录，或在 Settings 中配置 SSH Host 和已显式安装的远端 Daemon。

### SSH 配置

1. 先确认系统 `ssh <host>` 使用现有配置和认证可以连接。
2. 使用 `agentmux artifact create` 构建目标平台 Artifact，再通过 `AgentMuxSshRemoteDaemon.install()` 与 `activate()` 显式安装并启动版本匹配的远端 `agentmuxd`。
3. 在 Host 设置中填写 hostname、可选 user／port／identity path，以及 Daemon Build、Node、入口绝对路径和 Socket 绝对路径。
4. 使用 Test 核对 Host、Build 和 Protocol 身份。
5. 添加远端 Workspace 后，Terminal、Agent、文件和 Git 操作都会在同一 Host 上执行。

AgentMux 只保存连接元数据和可选 Identity File 路径，不读取、复制或保存 Private Key 内容。

## 仓库结构

```text
packages/core/       UI 无关的 Provider、Client、Daemon、Local／SSH Transport 与 Session 合同
apps/desktop/        Electron Main／Preload 与 React 第一方 Client
docs/                中文设计、a mature workbench 源码证据、测试与 Feature 决策
```

## 当前限制

- 仓库不会自动修改用户全局 Codex、Claude、Hermes 或 Pi Hook 配置。
- SSH 自动化使用隔离的系统 SSH Fixture；不连接真实外部 Host，也不包含真实凭据。
- 当前 Package 候选声明 Node 22+、macOS／Linux、x64／arm64；Windows／ConPTY 不在支持范围。
- `node-pty` 精确锁定官方 `1.2.0-beta.15`，因为稳定版 1.1.0 的外部 Consumer 在 macOS 会遇到不可执行的 `spawn-helper`。
- 更长时间 Soak、协议安全矩阵和资源回归属于 T-007。
- 应用尚未签名、自动更新或发布。
