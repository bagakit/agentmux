# Agent 输入队列与 resume 尺寸复核

状态：**已实施并完成验证**（2026-09-20）

## 复核结论

本轮复核要求同时满足用户补充的低熵、自收敛、反脆弱、清晰分层、低耦合高内聚与务实扩展；不以表面文案修补替代状态所有者修复。

1. `send()` 先把文字放入本地 steer 队列；Provider 暂时拒绝时，队列条目被正确保留，但 Composer 也保留同一段草稿。用户按一次重试会再次入队，产生重复文字和重复提示。入队成功后队列应成为唯一待投递副本；只有入队本身被拒绝时才保留草稿。
2. 初步“继承旧 Run 尺寸”的假设被复核收窄：已退出 Run 的 `current_size` 可以未知，不能据此保证 resume 新 Run 的初始几何。确定的缺陷在 attach 返回边界丢弃 `attached.run.cols/rows`，Renderer 回放期间又允许 RAF fit 改变几何。真实 headless 反例：80×24 解析定位到第40行第100列的文本后再 resize132×45，目标行内容不可恢复；先设正确几何则内容完整。修复落在 attach 契约和回放同步 owner。
3. 队列自动/手动投递各自调用 Core，缺少一个共同的单飞 owner；旧数组跨 await 使用使删除无效，拒绝替换 entry 对象又让按对象引用删除失效。
4. 旧 Run 条目一经“立即发送”标 failed 就阻塞新 Run；deferred 优先级还使已结束 Run 继续承诺自动重试。
5. 单条 prompt 有 Core 上限，但本地队列没有数量上限；按现有“有界队列”约束在唯一 admission 入口拒绝超限，不淘汰用户文字。
6. 每个 Runtime 事件遍历所有队列制造重试洪水，而无事件的启动/快照恢复反而不唤醒队列。
7. typed interaction 期间父组件虽然提供 `onQueue`，输入框 Enter 分支仍额外要求 Stop 主动作；常见的 waiting/blocked 状态因此无法真正入队。按既有 SSOT 的 pending interaction 队列约束，是否提供 `onQueue` 就是排队能力的唯一判据，不能从 Stop 按钮反推；正常发送、Shift+Enter 与 IME 行为保持各自语义。

## 约束

- 队列、草稿与一次提交的 operation id 必须保持一份归属；重试原条目复用 operation id，不复制。
- 健康 Agent 的 readiness/transport 拒绝是流程降级，条目保持 `deferred` 并可见；不可达或过期 Run 的可投递性从当前 Session/Run 推导，不再写一份会过时的终局判断。
- attach 传递 ctxmux 的 owner-confirmed 尺寸；未知就保持未知，不回退到 `RunSpec.size`。
- retained replay 和启动期间缓冲的 pending 输出共用一个解析几何锁，二者写入交接完成后才同步可见视口；失败与不可控制 Run 也必须在交接收尾解除本地锁；未知与失败沿用服务窗，不阻断健康 Agent。最新尺寸不能冒充历史逐字节几何。 首次 resize 抛错仍保留 live 同步意图和待完成的首次重绘，后续视口事件可重试；失败告示仅在 Runtime 确认成功后收敛，不增加轮询或第二份尺寸真相。
- 自动与手动队列共用单飞 owner；每次读取最新条目与 Session，更新/删除使用 operationId；运行中的当前条目显示在途，旧 Run 条目保留但不阻塞新 Run。
- 只由相关 Session 状态/readiness/连接恢复与权威快照唤醒，不由原始输出或其他 Session 的事件重试。
- Provider 能接收就发送，修正文案的“总是等本轮结束”承诺，不为匹配旧文案增加 working 门控。

## 证据与验收

- 队列：`store.send`、Composer 草稿清理、重复入队回归，以及现有 deferred 重试/operation id 语义。
- 尺寸：Desktop attach owner 尺寸、真实 headless alt-screen 回放中 resize 反例、隔离进程重启恢复原布局与同一 Run。
- 每个实现 task 要有变异红/恢复绿记录，并排除定义文件做生产调用者检查。

依赖复核：T-009 消费现有 Core 投递 API 即可闭合，不需要等待更广的 T-002 owner 重构；移除原依赖。T-010 只依赖已交付的重启恢复 T-005。既有 T-001～008 的任务语义与历史保持原样。

## 设计复核落点

- **职责与耦合**：Store 持有排队意图、关联 ID 和本地请求是否在途；Core/ctxmux 仍负责投递、幂等受据和真实 Run 尺寸。未增加 Provider 分支或第二份尺寸台账。
- **收敛性**：手动/自动共用每 Session 一个消费者，await 后重新读当前事实；快照恢复、明确的新 readiness、交互解除、重连和手动 refresh 都可推进队列。自身发布的 consumed/degraded 快照不触发自激重试。
- **交互**：成功入队就转移草稿归属；拒绝入队保留原稿；在途不可假装撤回；旧 Run 条目保留可复制。等待权限时 Enter 真正进入队列；Shift+Enter 保留编辑语义。原因驻留于队列旁边，详细诊断仍可展开查看。
- **务实边界**：沿用现有 replay 收尾与视口同步器；保留下一次真实视口事件的重试机会，不增设轮询或重试定时器。队列数量上限在唯一 admission 入口执行，不淘汰旧文字。
- **抗回归证据**：真实 Store 并发交错、真实 xterm parser、独立客户端进程重启，以及逐项破坏生产实现的变异；每条路径都有定义文件之外的产品调用者。

详证：[队列并发与恢复](evidence/agent-queue-concurrency-2026-09-20.md)、[输入与可见反馈](evidence/agent-queue-ui-2026-09-20.md)、[尺寸、回放与进程重启](evidence/agent-resume-size-2026-09-20.md)。

边界：当前尺寸不是历史尺寸时间线，不能据此声称原样重建所有跨尺寸历史。Core 的普通 live attachment 未传播其他客户端的 resize，属于多 View 尺寸协调的另一条协议边界；已核实本次 attach/replay 每次取 fresh daemon snapshot，不受该缓存边界影响。本轮没有用轮询或互相抢 resize 来掩盖它。

## 交付记录

- T-009、T-010 的最终 gate 均通过，已由 feature-tracker 标记 done。
- 队列与 UI 共 20 项、尺寸与恢复共 22 项生产变异均变红，随后恢复绿；没有将构建产物过期的守卫失败冒充变异命中。
- 串行全量：6720 passed / 8 failed / 3 skipped，剩余为既有 8 红基线。其后的 pending 交接窄修，最终 7 文件 114 tests 全绿，Desktop typecheck 再次通过。
- 工作区 `pnpm -r typecheck` 通过；420px 窄布局无横向溢出；真实独立 Node 客户端进程退出/重启仍保持原 Run 与 132×45 尺寸。
- 收尾时另一项并行工作更新了 Core 源码，freshness 守卫正确拒绝旧 dist；重建后最终 gate 通过。该并行变更不属于本轮修改。
- 队列与尺寸修复按独立回退边界提交；Browser、路径显示等并行实现不纳入本轮提交。Tracker 同时补齐前置 T-008 已落地修复的历史记录及其 review 引用。
