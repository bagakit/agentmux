# AgentMux Core Native PTY 依赖审计

状态：T-001/T-006 历史依赖证据；自建 node-pty Owner 已被 ctxmux 决策取代。本文保留供应链与 Artifact 发现，不能继续作为最终依赖选择。
Feature：`f-2248f4yx5`
Task：`T-001`、`T-006`
审计日期：2026-08-10（Asia/Shanghai）

## 1. 结论

当前发布候选精确锁定官方 `node-pty@1.2.0-beta.15`，由 `agentmuxd` 用它持有 Local／SSH PTY 与进程。仓库在 pnpm 11 的 `allowBuilds` 中显式允许 `node-pty` 执行受审计的安装脚本；Package 同时声明 Node 22+、macOS／Linux 和 x64／arm64。

T-001 曾使用稳定版 `1.1.0 + pnpm patchedDependencies`：补丁只把两个 macOS Helper 从 `0644` 改为 `0755`。T-006 的干净 npm Consumer 证明这种 workspace patch 不会进入发布包，真实 Terminal 仍稳定报 `posix_spawnp failed`。因此发布候选直接切到 2026-08-03 发布的官方 1.2 beta 维护线；其 npm tarball 已为 darwin arm64/x64 Helper 携带 `0755`，并同时包含四个目标平台的预编译文件。旧 patch 与配置已删除，没有 postinstall 修补、运行时 chmod 或 Fallback。

Local Daemon Transport 暂不新增 WebSocket、RPC、数据库或配置库。Node 已有的 `net`、`events`、`fs`、`crypto` 和 Stream 背压原语足以跑通 T-001 的单机 Unix Socket 竖切；协议可靠性、Replay 与 Backpressure 的收紧属于 T-002，但公共身份从第一天携带 `sessionId + incarnationId + createOperationId`。

## 2. 当前依赖可复用边界

| 依赖／能力 | 当前用途 | T-001 处理 |
| --- | --- | --- |
| `execa@^9.6.0` | Local/SSH 非交互命令、Agent 可执行文件探测 | 延续已有依赖；不把 pipe 子进程伪装成 PTY |
| `shell-quote@^1.8.3` | SSH 远端 argv 引用 | 延续已有依赖；不手写 Shell Quoting |
| `@xterm/xterm@^5.5.0` | Desktop Renderer 的 Terminal Emulator | 保持在 Desktop；Daemon 不渲染终端、不依赖 DOM |
| Node `net` / Unix Socket | 本机进程间双向 Stream | 用作 Local Client/Daemon Transport，Socket 目录 `0700`、Endpoint `0600` |
| Node `crypto.randomUUID` | 稳定随机身份 | 生成 Incarnation、Create Operation 和请求身份 |

仓库原先没有 PTY、ConPTY、WebSocket/RPC 或远端 Daemon SDK。`execa` 只能提供 pipe，不满足 TUI、Resize、Signal 与 Terminal 语义；自行调用 `forkpty`、实现 ConPTY 或写 Terminal Emulator 均不在范围内。

## 3. `node-pty` 证据

### 维护、License 与能力

- 上游：`microsoft/node-pty`，npm 作者为 Microsoft Corporation，MIT License。
- npm 当前稳定标签为 `1.1.0`，beta 标签为 `1.2.0-beta.15`；beta 包发布于 2026-08-03，维护者仍为 Microsoft／node-pty 上游账号。
- 公共 API 直接覆盖 T-001 所需的 `spawn`、`onData`、`onExit`、`write`、`resize`、`kill`、`pause` 与 `resume`。
- `node-pty` 只拥有伪终端原语；Agent Catalog、Session Identity、Replay、权限和 Client API 仍由 AgentMux 定义。
- `node-pty` 进程继承 Daemon 用户权限。Daemon 不接受任意远端网络请求，Local Endpoint 只允许当前用户访问。

### Artifact 与安装事实

`1.1.0` 的 npm 包约 64 MiB 解包，包含 macOS `pty.node`／`spawn-helper`、Windows ConPTY／winpty Artifact 和源码。当前 tarball 中 macOS arm64/x64 `spawn-helper` 的模式均为 `0644`。在以下环境通过干净临时安装复现：

```text
Node 24.14.1
pnpm 11.5.1
macOS arm64
node-pty 1.1.0 -> posix_spawnp failed
```

对应上游问题：

- `microsoft/node-pty#850`：macOS `spawn-helper` 缺少执行位；
- `microsoft/node-pty#919`：请求发布修复 `1.1.0` tarball 的 `1.1.x`。

仓库补丁只包含两个 Git File Mode 变化：

```diff
old mode 100644
new mode 100755
```

应用补丁后，相同机器上的仓库安装与真实 PTY Spike 成功：

```json
{"version":"1.1.0","exitCode":0,"output":"patched-node-pty-spike","cols":80,"rows":24}
```

没有选择 `1.0.0`：它依赖 npm 的隐式 `node-gyp rebuild`，pnpm 11 的显式 Build Allowlist 不会在当前包形状下可靠生成原生模块。也没有选择 Homebridge 预编译 Fork：虽然真实 Spike 可运行，但它引入已废弃的 `prebuild-install`，且偏离任务明确要求的官方 `node-pty`。

T-006 又从真实 `pnpm pack` 解包产物和干净 npm／隔离 pnpm Consumer 复现了 1.1.0 的失败，并验证 1.2.0-beta.15 的 Local Terminal、Fake Codex、Doctor、Remote Artifact 与隔离 SSH 生命周期。当前证据覆盖 darwin-arm64 的真实执行；Package 与 Artifact 清单覆盖 macOS／Linux 的 x64／arm64 预编译文件。Windows／ConPTY 仍明确不支持，不从源码中的条件分支外推能力。

## 4. 选择与非选择

选择：

- 精确版本 `node-pty@1.2.0-beta.15`，不使用范围版本；
- pnpm 明确允许 `node-pty` 的安装脚本；发布候选不依赖 workspace patch；
- Raw Terminal 和 Codex 共享一个 Daemon Session Owner；
- Terminal 渲染继续完全交给 xterm。

不选择：

- 运行时 chmod、自定义 postinstall、`patch-package`、workspace-only patch、`node-pty@1.0.0` 或预编译 Fork；
- Main-owned PTY、tmux/ctxmux Backend Selector 或失败 Fallback；
- 自写 PTY、ConPTY、Terminal Emulator、通用 RPC 框架或 Transport 插件层；
- 为 T-001 提前加入 SQLite、持久队列、ACP、SSH Daemon 安装器或多租户配置。

## 5. T-001 实施约束

1. `agentmuxd` 是 PTY/Process 的唯一新 Owner；Client Detach 或退出不调用 `kill`。
2. Daemon 只接收 Core 已解析的启动计划，不解释 Codex、Claude 等 Provider 语义。
3. Create 与 Attach-only 明确分开；Attach 目标不存在时失败，不能偷偷 Spawn Shell。
4. 公共事件使用增量 Data 和独立 Exit，不回退到 tmux `capture-pane` Snapshot。
5. 本阶段不把 Desktop 切到新 Daemon，也不公开 Backend 选择；现有 tmux 只保留为未切换基线。
6. 依赖安装、干净 Build、Pack 清单、Doctor PTY Artifact 与真实 PTY Spike 任一失败，都阻止发布候选继续推进。
