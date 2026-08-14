# 重连后实时输出流不重建

Contract: `bagakit.feature-goal.v1`
Feature: `f-2588fuu6e`

## 真因（2026-09-13 逐行核实，非推断）

Core 内部重连（flap-in-budget）成功后，**每个 run 的 daemon→Core 字节泵不会重建**，但状态被刷回
`running`、恢复横幅消失。用户得到一个**看着在运行、实则永久静默**的终端。

链路四步，每步都读过：

1. `packages/core/src/ctxmux-run-adapter.ts:632` `markConnectionLost()`
   —— 掉线时 `for (...) attachment.close()` + `attachments.clear()`，拆掉唯一的字节通道。
2. 重连走 `client.ts:762 reconnectLoop` → `open(epoch)` → `republishLiveRunState()`。
   `open()` 重订阅了 kernel 事件、对每个 session 做了 `ensureTerminalHandshakeOrDegrade`，
   但**从不重建 per-run attachment**。真正重建它的是 `reattachAgent()`
   （`client.ts:1587`），全仓只有两个调用方——`apps/desktop/src/main/runtime-controller.ts:673`
   （用户主动 attach 时）与 `packages/core/src/agentmux.ts:414`——**重连路径上一个都没有**。
3. `client.ts:810 republishLiveRunState()` 只 `list()` + `publishRunState()`，
   补发 `process-state: running`。
4. 渲染端 `apps/desktop/src/renderer/src/lib/session-state.ts:457` 对 `restored`
   **刻意不改状态**（注释：交给补发的 process-state 拨正，更准）。于是那条 `running`
   把 `disconnected` 洗掉，横幅消失。

`TerminalView` 的 attach effect 依赖里不含"同 daemon 重连"会变的量（`runId` 存活），
所以渲染端也不会自己重 attach。

## 为什么现有测试看不见

`packages/core/test/client-connection-lost.test.ts:100` 断言的正是代码做的那两件事
（状态补发了、`restored` 发了）。**输出还能不能到，从来不在它的契约里**——断言只写了一侧。
这不是测试坏了，是盲区。

## 修法方向

`republishLiveRunState()` 在推 `running` 的同时，为每个 live run 重建实时 attachment，
按各自的 `outputCursorBytes` 续上（复用现有 attach 路径，别造第二条）。

## 判据（必须是行为判据，不是源码 grep）

端到端：**断线 → 重连 → 新字节必须到达渲染端**。
变异验证：把重建那一步去掉 → 该判据必须变红。

## 参考

两家参考实现都在重连握手落地时重新订阅每条流，并把 subscribe/unsubscribe 建模成
**可重连的状态**而非一次性动作。
