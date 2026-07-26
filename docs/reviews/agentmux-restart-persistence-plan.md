# Task Plan Review — 重启后布局还在，session 能直接 resume

日期：2026-08-29
设计 SSOT：`docs/plans/agentmux-semantic-session.md`（Reattach/Resume/Respawn 三态）、`docs/design/agentmux-desktop-interaction.md`（布局只持久化 session 在哪张 view 哪个 region）

## 用户原话

> 机器重启后, 布局和可 resume 的 session 就都没了, 应该要保留布局并能直接 resume session

## 结论

**approved**，但比用户描述的范围小得多——**根因是一个文件放错了目录，不是缺少持久化机制**。

恢复链早已完整实现并通电，只是每次重启都被喂进一个已被系统删掉的 token。

## 根因（逐条在源码里核实过）

`AgentMuxFileAgentSessionStore` 的默认根目录是 `defaultAgentMuxRuntimeDirectory()`
（`packages/core/src/agent-session-store.ts:1289-1290`），它指向**临时目录**
（`packages/core/src/runtime-paths.ts:17-19`）：

- macOS：`/private/tmp/amx-<uid>-<runtime-id>`，系统按 3 天周期清理
- Linux：`tmpdir()`，多数发行版 **reboot 即清**

这个文件里存的是每个 Agent Session 的 `nativeHandle`——也就是
`claude --resume <session-id>` / `codex resume` 所需的那个 token。它没了，session 就再也接不回来。

`agent-timelines/` 由同一个 path 派生（`agent-session-store.ts:1636` 用 `dirname(this.path)`），
所以一起易失；也因此**一次改动同时救回两者**。

对照组就在同一进程里：config 与 browser profile 都老实落在 Electron userData
（`apps/desktop/src/main/config-store.ts:198`、`browser-profile-store.ts:137`）。
唯独 session 身份放错了地方。缺省注入点在 `apps/desktop/src/main/index.ts:29`。

## 为什么不需要写新的恢复逻辑

整条链已经在跑，只差一个活着的 token：

1. `open()` 载入 registry，`kernel.list()` 找不到匹配的活 run（`packages/core/src/client.ts:462-470`）
2. snapshot 把这些 session 标成 `recoveryCandidates`（`apps/desktop/src/main/runtime-controller.ts:443-520`）
3. `store.initialize()` 取 `persistedAgentSessionIds(restoredWorkbench)` 与 candidate 求交，逐个 `api.sessions.recover`（`apps/desktop/src/renderer/src/store.ts:1015-1032`）
4. `decideAgentSessionContinuity` 走 run-missing 分支，`nativeHandle` 在场即无 prompt Resume（`packages/core/src/agent-session-continuity.ts:183-223`）
5. `restorePersistedWorkbench` 只保留有对应 live session 的 tab（`store.ts:1033-1074`）

第 3 步正是布局与 session 的缝合点——**布局本来就在驱动恢复**。

## 布局侧的真实情况

布局本体（跨 pane split 树、每 split ratio、tab group、region 树）已由 Zustand `persist`
持久化并有测试（`workbench-layout.ts:7-28`、`workbench-view-layout.ts:3-16`），
**graceful 重启下它是活的**。用户感觉"布局也没了"，很可能是因为 tab 对应的 session 全部恢复失败后
被 `restorePersistedWorkbench` 剔除——即布局的表现症状源自 session 侧的根因。

布局侧真正独立的缺口是次级的，放进后续 task：

- 硬关机丢最近一批写入：localStorage 异步刷盘，renderer 无 pagehide/flush（`store.ts:3177-3186`）
- 一批字段不在 partialize 白名单：`toolDockWidth`、`projectRailOpen`、`toolsOpen`、`workspaceTool`、`activeWorkspaceId`（`store.ts:3180-3185`、`:1053,1067`）
- 窗口几何从不持久化，每次固定 1480×940（`apps/desktop/src/main/index.ts:66-71`）

## 边界（本质救不回来，必须如实告诉用户，不得伪装）

- **原 PTY 活进程**：机器重启后 daemon 与全部子进程必死，无 OS 级移交。Resume 只能以**新 runId** 重开 provider CLI。
- **终端 scrollback**：存在 daemon 内存，run 与 daemon 一亡即不可达（`ctxmux-run-adapter.ts:738-811`）。
- **无 resume 能力的 provider**：traex/hermes/grok/gemini/cursor 的 `resumeStrategy` 为 `none`（`agent-provider.ts:792,818,878,904,958`），重启后只能重开。
- **pending ACP typed interaction**（审批/提问卡）重启后被结算清除。
- **daemon 的 socket 与 state 必须留在临时目录**：那是 ephemeral 的机器级 runtime 状态，
  用 `AGENTMUX_RUNTIME_DIRECTORY` 整体搬走会连它一起搬，并改变 daemon adopt 路径。**只搬 session 文件。**

## Task 核

| Task | 独立可验收 | 备注 |
|---|---|---|
| T-001 session 身份落到 durable 目录 | 是 | 最小端到端闭环：改注入点，timelines 随之。测试证明路径在 userData 下、不在 tmp 下，且 store 往返可读回 nativeHandle。 |
| T-002 恢复失败要说人话 | 是 | 依赖 T-001。token 缺失/provider 不支持 resume 时，UI 必须说明白哪一类，而不是静默丢 tab。 |
| T-003 布局字段补齐与硬关机 flush | 是 | 与 T-001 无依赖，可并行。 |
