# @agentmux/core

`@agentmux/core` 是 UI 无关的本地 Agent Runtime。它统一管理 Codex、Claude、TraeX、Hermes、Pi 与 Raw Terminal；最终由 `ctxmux` 持有 Run／PTY／进程，Node Client 只通过 AgentMux 的类型安全领域 API 创建、附着、恢复和控制 AgentSession。

> 架构修正状态（2026-08-11）：当前包仍包含可运行但待替换的自建 `agentmuxd`，所以下面的安装、Doctor 和示例只描述当前过渡实现，不是最终发布候选。T-015 已审计 ctxmux `b2bbc7a`：Local vertical slice 可运行，但 License/Package、SSH、幂等 byte cursor、进程树与资源 Gate 尚未齐备，因此原子切换暂时 parked。能力齐备后会直接删除该 bin、协议、node-pty Owner 和 Remote Artifact，不保留兼容入口或 fallback。

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

`node-pty` 精确锁定官方 1.2 beta 维护线，是因为稳定版 1.1.0 的 npm tarball 把 macOS `spawn-helper` 发布成不可执行文件；仓库私有 patch 无法传播给外部 Consumer。过渡 Doctor 会读取当前 Runtime 实际加载的版本、目标平台预编译文件与 Helper 权限，不用“安装成功”代替 PTY 可用性。

## 安装与验证

```bash
pnpm add @agentmux/core
agentmux doctor --activate
```

Doctor 会报告：

- Local 或 SSH Host 是否可达；
- Runtime Host／Build／Protocol／Instance；
- Node、OS、CPU 与 `node-pty` Artifact；
- 五个内置 Agent 的可执行文件与 Capability；
- Hook 是 `explicit-managed` 还是不支持；
- Permission 是 `none`／`observe`／`respond`；
- ACP 支持状态与默认拒绝策略；
- Reply correlation 是否有 Provider/ACP 的稳定 Turn ID 证据。

当前内置 Provider 的能力声明如下。`none` 是诚实能力，不会因为 Hook 中出现 Assistant 文本就伪造 Prompt→Reply 关联：

| Agent | Prompt | Hook | Permission | Provider Resume | ACP | Reply correlation |
| --- | --- | --- | --- | --- | --- | --- |
| Codex | positional argv | native | observe | session id | none | none |
| Claude | positional argv | native | observe | session id | none | none |
| TraeX | positional argv | none | none | none | none | none |
| Hermes | native query + TUI | native | observe | none | none | none |
| Pi | positional argv | native | observe | transcript path | none | none |

不可达 Host 的 Agent Probe 会明确标记为 `blocked` 并给出下一步，不输出含糊的 `UNKNOWN`。

## Local Client

```js
import {
  connectLocalAgentMux
} from '@agentmux/core'

const client = await connectLocalAgentMux()

const unsubscribe = client.onEvent((event) => {
  if (event.type === 'terminal-output') process.stdout.write(event.data)
})

const session = await client.createAgent({
  agentId: 'codex',
  workspacePath: process.cwd(),
  prompt: '检查当前失败测试，并解释最小修复。'
})

// Client 退出只 Detach；显式 Stop 才结束 Agent。
await client.stopAgent(session.agentSessionId)
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

当前过渡 Runtime 必须由宿主显式安装和启动；公共 Consumer 只通过 `connectSshAgentMux()` 连接已经核验 Build/Host 的 Runtime，不再接触 daemon connector、wire 或 SDK snapshot。运行期使用一条系统 `ssh -T` stdio Transport；AgentMux 不读取或复制 Private Key，不关闭 Known Hosts 校验，不开放远端 TCP 端口。

`examples/remote.mjs` 展示由环境变量提供 Host、Runtime Build、Entrypoint、Endpoint 与远端 cwd 的最小连接流程。最终 ctxmux 安装/发现合同由 T-015/T-016 审计后替换内部实现。

## 身份与恢复边界

- Run 使用 `runId + incarnationId + createOperationId`。
- Agent Session 与物理 Run 分离。
- Attach、Release Attachment、Provider-native Resume、Respawn 和 Open View 是不同动作。
- Output 使用单调 byte cursor、有界 Replay、显式 Gap 与 Ack。
- Terminal Replay 不证明模型上下文连续。
- Terminal Output、Run Process、Native Hook、ACP 与 User Action 保留不同 Evidence Source。
- Hook 安装必须显式 `preview → install`；Permission 默认拒绝。

`dispose()` 只释放 Client、Transport、Attachment 与监听器。它不会停止 Run；调用方必须按产品语义显式调用 `stopAgent()` 或 `stopTerminal()`。
