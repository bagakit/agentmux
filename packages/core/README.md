# @agentmux/core

`@agentmux/core` 是 UI 无关的本地 Agent Runtime。它统一管理 Codex、Claude、TraeX、Hermes、Pi 与 Raw Terminal；`agentmuxd` 是每台执行主机上唯一的 PTY／进程 Owner，Node Client 只通过类型安全协议创建、附着、恢复和控制 Session。

## 支持范围

| 项目 | 当前候选范围 |
| --- | --- |
| Node.js | 22 或更高 |
| OS | macOS、Linux |
| CPU | x64、arm64 |
| Local Transport | 当前用户私有 Unix Socket |
| Remote Transport | 系统 OpenSSH 长期 stdio；远端 macOS／Linux |
| PTY | 官方 `node-pty@1.2.0-beta.15` 预编译 Artifact |

Windows／ConPTY 不在当前发布候选范围内。包清单用 `engines`、`os` 和 `cpu` 直接拒绝未支持组合，不提供降级 Runtime。

`node-pty` 精确锁定官方 1.2 beta 维护线，是因为稳定版 1.1.0 的 npm tarball 把 macOS `spawn-helper` 发布成不可执行文件；仓库私有 patch 无法传播给外部 Consumer。Doctor 会读取 Daemon 实际加载的版本、目标平台预编译文件与 Helper 权限，不用“安装成功”代替 PTY 可用性。

## 安装与验证

```bash
pnpm add @agentmux/core
agentmux doctor --activate
```

Doctor 会报告：

- Local 或 SSH Host 是否可达；
- Daemon Host／Build／Protocol／Instance；
- Node、OS、CPU 与 `node-pty` Artifact；
- 五个内置 Agent 的可执行文件与 Capability；
- Hook 是 `explicit-managed` 还是不支持；
- Permission 是 `none`／`observe`／`respond`；
- ACP 支持状态与默认拒绝策略。

不可达 Host 的 Agent Probe 会明确标记为 `blocked` 并给出下一步，不输出含糊的 `UNKNOWN`。

## Local Client

```js
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
  workspacePath: process.cwd(),
  prompt: '检查当前失败测试，并解释最小修复。'
})

// Client 退出只 Detach；显式 Stop 才结束 Agent。
await client.stopAgent(session.semanticSessionId)
unsubscribe()
await client.dispose()
```

可直接运行的 Raw Terminal 示例位于 `examples/local.mjs`。

## Remote Artifact 与 SSH

远端安装不运行 npm、不调用 npx，也不联网下载依赖。先在本地从已经安装的 Package 构建目标平台 Artifact：

```bash
agentmux artifact create \
  --output ./agentmux-linux-arm64.tgz \
  --build-id 0.1.0 \
  --platform linux-arm64
```

Artifact 只包含：

- `agentmux-artifact.json`；
- Package 的 `dist`、`bin` 与清单；
- 目标平台的 `node-pty` JS Loader 和预编译文件。

安装、Activation、Audit、Upgrade 与 Uninstall 由 `AgentMuxSshRemoteDaemon` 显式调用。运行期使用一条系统 `ssh -T` stdio Transport；AgentMux 不读取或复制 Private Key，不关闭 Known Hosts 校验，不开放远端 TCP 端口。

`examples/remote.mjs` 展示由环境变量提供 Host、Artifact、Build、Platform 与远端 cwd 的完整最小流程。示例不会自动 Uninstall。

## 身份与恢复边界

- Daemon Run 使用 `sessionId + incarnationId + createOperationId`。
- Semantic Agent Session 与物理 Daemon Run 分离。
- Attach、Provider-native Resume 和 Respawn 是三个不同动作。
- Output 使用单调 Sequence、有界 Replay、显式 Gap 与 Ack。
- Terminal Replay 不证明模型上下文连续。
- Terminal Output、Daemon Process、Native Hook、ACP 与 User Action 保留不同 Evidence Source。
- Hook 安装必须显式 `preview → install`；Permission 默认拒绝。

`dispose()` 只释放 Client、Transport 与监听器。它不会停止 Daemon Session；调用方必须按产品语义显式调用 `stopAgent()` 或 `stopTerminal()`。
