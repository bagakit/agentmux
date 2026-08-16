# Resume / attach 几何修复验证（2026-09-20）

对应 `f-25k8f8m9k / T-010`。验证均使用测试夹具、独立临时 Runtime 与独立子进程；没有重启、
停止或读取当前用户的 Desktop / Agent Run。以下结果针对本次未提交工作树。

## 根因与 owner

ctxmux protocol 17 已返回 `RunInfo.current_size`；Core 的 adapter 正确映射为 `run.cols/rows`。
Desktop `RuntimeController.attachSession` 原先丢弃它。Renderer 在默认 80×24 或 RAF 临时 fit 后的
尺寸上回放，并在整个异步回放完成后才记 grid。`hydrateTerminalReplay` 的每批 write 会让出执行，
RAF/ResizeObserver 因而可能在回放途中改变解析几何；结束时记尺寸不能证明此前字节的解析尺寸。

真实 `@xterm/headless` 证伪：80×24 解析 `ESC[?1049h ESC[40;100H WIDE_MARK`，再 resize 到
132×45，第 40 行为空，第 24 行残留 `IDE_MARK`；从 132×45 开始解析，同一标记完整位于第 40 行。
alt screen 的事后 resize 不能重建被截断的内容。

修复归 Desktop：attach 透传 `currentSize`；回放前采用确认尺寸；`beginReplay/endReplay` 保持
回放期间几何稳定；完成后恢复可见 Region 的尺寸同步。未知尺寸保留 `null`，持续显示服务窗并请求
当前画面重绘。resize 返回未送达时不消耗首次重绘义务。

## 正向验证

```sh
pnpm exec vitest run \
  apps/desktop/test/terminal-replay-reflow-recovery.test.ts \
  apps/desktop/test/terminal-viewport-sync.test.ts \
  apps/desktop/test/terminal-replay.test.ts \
  apps/desktop/test/runtime-controller.test.ts \
  apps/desktop/test/desktop-agent-continuity.integration.test.ts \
  apps/desktop/test/sliced-scan-surface-not-empty.test.ts \
  apps/desktop/test/vacuous-on-empty-predicate.test.ts
pnpm --filter @agentmux/desktop typecheck
```

进程重启补测后复跑结果：7 文件、109 tests 全绿（6.11 秒）；Desktop typecheck 退出码 0。
`desktop-agent-continuity.integration.test.ts` 的严格进程重启用例 642ms，Runtime 重建用例 1250ms。

回放测试用真实 headless xterm，在异步 write 的 yield 中尝试 RAF fit，断言全过程仍为 owner 的
132×45，且第 40 行标记完整；完成后分别测试目标尺寸相同与不同，检查最终尺寸以及是否重绘。
另测过早的 process-state live 启动、既有像素基线与 resize 未送达。Main 测试让 attachment 返回
132×45、后续 session snapshot 仍为 80×24，证明使用的是同一次 attachment 的事实；共享
attachment 的 fresh replay 返回 null 时，Main 必须继续返回 null。

### 严格进程重启

新增 `apps/desktop/test/fixtures/terminal-size-restart-worker.mjs`：

1. 第一个独立 Node 进程连接临时 ctxmux，创建 80×24 Terminal Run，resize 至 132×45，attach，
   打印身份与 owner 尺寸，dispose 并退出。
2. 测试确认第一个客户端 PID 已退出。
3. 第二个独立 Node 进程用原 runId 重新连接并 attach。断言客户端 PID 不同、daemon instance、
   Run ID、PTY PID 不变，尺寸仍为 132×45，Run 仍 running。
4. 第二个客户端进程退出后，Desktop `RuntimeController.attachSession` 再连接该 Run，断言产品
   `SessionAttachResult.currentSize` 是 132×45，并保持原 SessionControl。
5. 清理只停止临时测试 Run 与其独立 daemon。

原来的 Agent integration 另覆盖 RuntimeController dispose/recreate、原 Agent 身份、无 Provider
handle 的 retained Run、replay 和 live I/O；已增加重建前 resize 与重建后 attach 尺寸断言。
这些是实际 Node 客户端进程重启与产品协议回归，尚不是实际 Electron 像素截图验收。

## 变异测试

逐项修改生产实现、运行指定测试、确认红，再恢复原实现；各项独立运行，没有把多个缺陷一起注入。
`R` 为 `apps/desktop/test/terminal-replay-reflow-recovery.test.ts`；
`M` 为 `apps/desktop/test/runtime-controller.test.ts`。
命令均为 `pnpm exec vitest run <文件>`。

| 注入缺陷 | 测试 | 结果 |
| --- | --- | --- |
| `beginReplay` 不设置 replay 暂停原因 | R | 2 failed / 10 passed |
| `endReplay` 不解除 replay 暂停 | R | 3 failed / 9 passed |
| `endReplay` 不记回放 grid | R | 1 failed / 11 passed |
| `beginReplay` 保留之前的像素基线 | R | 1 failed / 11 passed |
| 允许回放过程中提前进入 live | R | 1 failed / 11 passed |
| resize 返回 false 仍消耗首次重绘义务 | R | 1 failed / 11 passed |
| TerminalView 用 80×24 代替 attachment 尺寸 | R（产品接线断言） | 1 failed / 11 passed |
| Main 用 `run.rows` 填充 `currentSize.cols` | M | 1 failed / 57 passed |
| Main 把未知尺寸 null 伪造为 80×24 | M | 1 failed / 57 passed |
| 未知几何返回 healthy，告示消失 | R | 1 failed / 11 passed |

严格进程重启另注入 Main 忽略 attachment 尺寸、固定返回 80×24：

```sh
pnpm exec vitest run apps/desktop/test/desktop-agent-continuity.integration.test.ts \
  -t 'attaching Node process'
```

结果：1 failed / 1 skipped，断言明确得到 `{ cols: 80, rows: 24 }`，期望为
`{ cols: 132, rows: 45 }`；退出码 1。恢复后该文件 2/2 及上述最终 109 tests 全绿。

## 零调用者检查

```sh
rg -n 'beginReplay|endReplay|terminalReplayGeometryOutcome|currentSize' \
  apps/desktop/src/renderer/src/components/TerminalView.tsx \
  apps/desktop/src/main/runtime-controller.ts \
  apps/desktop/src/shared/contracts.ts \
  apps/desktop/src/renderer/src/lib/api.ts
```

`beginReplay/endReplay` 的真实外部调用在 TerminalView 的 attach effect；
`terminalReplayGeometryOutcome` 在 TerminalView 转成实际 `ServiceWindowNotice`；
`currentSize` 从 Main attachment 投影，经共享合同，到 TerminalView 的 `terminal.resize`。
接线断言显式确认每个源码锚点存在并且顺序正确，没有空 slice 反向断言。

## fresh snapshot 与已知边界

Main 首次 Agent attach → `reattachAgent` → `attachAgentRun` → `kernel.attach`；首次 Terminal
attach → `attachTerminal` → `kernel.attach`；共享 attachment → `readRunReplay` → `kernel.replay`。
`CtxmuxRunAdapter.attach/replay` 每次都调用 SDK `client.attach`，使用本次 `snapshot.run`，
没有从客户端旧尺寸缓存构造 attachment。

Core 普通输出泵确实忽略 `resized` 事件；screen evidence 自己的 attachment 会消费该事件。
因此它不会让本次 attach 几何读旧，但已打开的长命 View 尚不能察觉另一客户端的 resize。
这是另一个事件传播与多 View 协调边界，不能用轮询或第二份尺寸台账绕过。

当前 `current_size` 也不是完整历史尺寸时间线。使用当前确认尺寸重放不能保证每一段跨尺寸历史的
原始布局；本修复保证当前附件几何被实际使用且回放中不被本地 fit 改写，不宣称恢复全部历史布局。

## 补充审查：首次 resize 抛错后的收敛

发现 `startLiveSynchronization` 的 catch 会清掉 `live` 和 `awaitingFirstLiveFit`。真实产品只调用
一次 start；下一次正常 viewport 观察因此只更新本地 grid，不再提交给 PTY。失败仅 console.warn，
用户既不知道降级，也无法通过普通 resize 收敛。

先补 SSOT 和原 review 的约束，再移除这处撤销意图的 catch：异常仍报告，持续同步意图和首次重绘
义务保留。没有新增计时器、轮询、尺寸缓存或 Runtime 真相。成功回执由 synchronizer 的
`onResizeSuccess` 通知 TerminalView，和既有 `onResizeError` 一起驱动服务窗的展示与撤下。

新增行为测试仅 start 一次：首次 resize 抛错→服务窗 process-degraded；既有 startup frame
返回 false→告示仍保留且没有继续排帧；下一次真实 observe→提交成功并完成一次 redraw→healthy。
它同时证明“能重试”“不会自己轮询”“未送达不能报恢复”“成功后告示收敛”。

命令：`pnpm exec vitest run apps/desktop/test/terminal-replay-reflow-recovery.test.ts`。
以下七处独立变异各得到 **1 failed / 12 passed**，退出码 1，均已恢复：

| 注入缺陷 | 结果 |
| --- | --- |
| 首次抛错后 `live=false` | 红 |
| 首次抛错后清空 `awaitingFirstLiveFit` | 红 |
| 删除失败回调 | 红 |
| 删除成功回调 | 红 |
| resize 返回 false 也发送成功回调 | 红 |
| TerminalView 失败回调不再显示告示 | 红（接线断言） |
| 同步失败被分类成 healthy | 红 |

外部调用复核：TerminalView 的 `onResizeError` / `onResizeSuccess` 修改展示状态，
`terminalViewportSyncOutcome` 由它实际调用并渲染 `ServiceWindowNotice`。

此补充修复后的最终回归：上面的 7 文件 **110 tests 全绿**（4.62 秒），其中严格进程重启493ms、
Runtime 重建973ms；Desktop typecheck 退出码 0。所有变异已恢复。

## 补充审查：retained replay 到启动缓冲的交接

再次检查发现：只保护 `hydrateTerminalReplay` 不够。Renderer 原先在 hydrate 后立即 endReplay，
但随后 `releaseLiveOutput` 还会异步写入启动期间缓冲的 pending bytes；解锁排出的 RAF 能在这段
write/yield 中途改变 xterm 几何。这些字节同样属于 attachment 尺寸下的输出。

先更新 SSOT 与原 review，再把唯一收尾放到已有 `finishTerminalReplayRecovery`：mandatory
`finishReplay` 回调在 `await releaseLiveOutput()` 的 finally 调用，随后才开始 live 同步。
TerminalView 只传该回调，不再在 hydrate 后自行提前解锁。失败和不可控制 Run 也解除本地锁。

新增 4 组真实 headless 组合：`canControl=true/false × release成功/抛错`。pending 两批输出均
定位到第 39/40 行、第 100 列；每批异步 write 后主动执行可用 RAF，确认仍为 132×45，最后一行
内容完整。收尾必须恰好一次，失败走既有恢复错误通道；不可控制 Run 仅允许本地 fit，不提交 PTY resize。

变异命令：

```sh
pnpm exec vitest run apps/desktop/test/terminal-replay-reflow-recovery.test.ts \
  apps/desktop/test/terminal-replay.test.ts
```

| 独立注入缺陷 | 结果 |
| --- | --- |
| 在 pending drain 前调用 finishReplay | 7 failed / 17 passed |
| 仅 release 成功时调用 finishReplay，异常不收尾 | 2 failed / 22 passed |
| 仅 canControlRun=true 才收尾 | 3 failed / 21 passed |
| TerminalView 在交接前再次直接 endReplay | 1 failed / 23 passed（接线断言） |

以上退出码均为 1，均已恢复。接线断言要求 TerminalView 只出现一处 endReplay，且该调用必须是
`finishReplay` 回调。生产外部调用仍在 TerminalView；没有新增第二个 drain 或 parser owner。

最终恢复绿：上述 7 文件 **114 tests 全绿**（3.21 秒），Desktop typecheck 退出码 0。
严格 Node 进程重启451ms、Desktop Runtime 重建789ms；所有变异已恢复。
