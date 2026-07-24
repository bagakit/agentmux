# AgentMux Core Package 候选

状态：T-006 历史候选（未发布）；已被 ctxmux 唯一 Run Kernel 决策取代。本文不再是最终 Package 合同，最终 candidate 不包含自建 agentmuxd、node-pty Owner 或 Remote Artifact。

本文定义 `@agentmux/core@0.1.0` 的发布候选边界。当前工作只构建、安装和验证本地 tarball；不执行 npm Publish、GitHub Release 或真实远端全局安装。

## 1. Package 合同

`packages/core/package.json` 是发布边界：

- `exports` 只公开 ESM `dist/index.js` 与类型声明；
- `agentmux` 提供 Doctor 与 Remote Artifact Builder；
- `agentmuxd` 提供 Serve／Activate／Connect／Status／Shutdown；
- `files` 只包含 `bin`、`dist`、`examples` 与 npm 自动保留的 Package 清单／README；
- 延续已有的 `execa@^9.6.0` 与 `shell-quote@^1.8.3`，Native PTY 精确锁定为 `node-pty@1.2.0-beta.15`；
- `engines`、`os`、`cpu` 直接声明 Node 22+、macOS／Linux、x64／arm64。

Build 先删除精确的 `packages/core/dist` 与 `tsconfig.build.tsbuildinfo`，再完整编译。这个顺序是 Package 正确性的一部分：普通增量 `tsc` 不会删除已删源码留下的 JS，T-005 后首次 Pack 曾真实带入陈旧的 `dist/tmux-client.*`。

`prepack` 强制执行同一干净 Build。Pack Gate 会拒绝任何 tmux 文件、缺失声明、缺失 bin 或错误执行位。

## 2. Native PTY

稳定版 `node-pty@1.1.0` 的 macOS Helper 权限缺陷曾由 workspace patch 修复，但 patch 不会传播到外部 Consumer。T-006 在干净 npm 安装中复现 `posix_spawnp failed` 后，直接切到官方 `1.2.0-beta.15`；旧 patch 已删除。

Doctor 从 Daemon 进程读取实际事实：

- Node Version、Platform、Arch；
- `node-pty` Package Version；
- 当前平台 `pty.node` 相对 Artifact；
- darwin `spawn-helper` 是否存在并具有执行位。

Daemon 已经加载 `node-pty` 不等于目标平台 Artifact 完整，因此两项证据都必须通过。

## 3. Doctor

`agentmux doctor` 默认只检查已有 Local Daemon；`--activate` 才显式启动。SSH 模式要求直接提供 Host ID、Build、远端 Node／Entrypoint／Socket 和系统 SSH 目标，不引入第二份配置文件。

报告包含：

- Host 类型、Reachability、Host／Build／Protocol／Instance；
- 远端或本地 Daemon 实际 Runtime 与 PTY；
- 五个 Agent 的 `found | missing | blocked` Probe；
- Terminal、Hook、Permission、Provider Resume 与 ACP Capability；
- Hook `explicit-managed`、Permission 默认拒绝、Semantic Evidence 来源边界；
- 每个失败的明确 Action。

Daemon 不可达时不会用 `UNKNOWN` 填满字段：Host 明确为 unavailable，依赖该 Host 的 Agent Probe 明确为 blocked。

## 4. Remote Artifact

历史 `createAgentMuxRemoteArtifact()` 与 `agentmux artifact create` 生成 `agentmux.remote-artifact.v1`。T-014 已从 Package root 删除 Builder 与 Daemon Manager 导出；CLI 仅为过渡 candidate 保留到 T-016：

```text
agentmux-artifact.json
package/
├─ package.json
├─ bin/
├─ dist/
└─ node_modules/node-pty/
   ├─ package.json
   ├─ LICENSE
   ├─ lib/
   └─ prebuilds/<target-platform>/
```

Artifact 只包含 Daemon 运行所需的 Native 依赖，不包含 AgentMux 仓库、Desktop、测试、用户配置、Credential 或其他平台 Prebuild。远端安装只解压这个本地显式文件，不运行 npm、不调用 npx、不联网下载。

Builder 先在输出目录写临时 Archive，再用排他 Hard Link 发布；目标已存在时明确失败，不覆盖用户文件，tar 失败也不会留下占住重试路径的半成品。

## 5. Consumer 验证

自动化从真实 `pnpm pack` 解出 Package，再从 pnpm 内容寻址 Store 物化精确生产依赖；随后在不引用仓库源码的目录中执行：

1. ESM Import 与两个 bin；
2. Local Activation、Raw Terminal 与 Fake Codex；
3. Local Doctor；
4. 公共 `connectLocalAgentMux()` / `connectSshAgentMux()`；
5. 隔离系统 SSH 的预装 Runtime、Remote Terminal 与 Remote Doctor；
6. Stop、Dispose 与 Shutdown。

Consumer 还会断言 Package root 不再导出 `AgentMuxDaemonClient`、`AgentMuxSshRemoteDaemon`、`SshAgentMuxDaemonConnector`、`activateAgentMuxLocalDaemon` 或 `createAgentMuxRemoteArtifact`。

另外保留一次真实干净 npm 安装证据，用于证明 Registry Consumer 会拿到官方 Native Artifact，而不是 workspace patch。自动化不把公网 Registry 作为日常 `pnpm check` 前提。

## 6. 明确未做

- 不 Publish Package、Release 或 Binary；
- 不连接、安装或删除真实 SSH Host；
- 不修改用户全局 Agent Hook 或 Credential；
- 不宣称 Windows／ConPTY 支持；
- 不把 Source Map、类型声明或示例当成运行时所有权；
- 不为 Package 增加 Plugin System、Backend Selector、Migration 或 Fallback。
