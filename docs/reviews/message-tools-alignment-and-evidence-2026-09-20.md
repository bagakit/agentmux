# Message Tools 对齐与投递确认复核

Review: approved。来源是用户本轮明确要求：头像替代常驻名字并移到右边、修复切换图标导致的高度抖动，以及频繁出现但原因不清的终端历史读取告示。

## UI 边界

沿用既有 identity 及 AgentAvatar，仅改变布局与可见内容；工具/头像/主动作保持同一稳定的控件高度。一行态此前把 mode padding 从 4px 改成 0，造成按钮 14px/22px 两套高度；左右簇又分别由头像、图标与文字撑高。验收为三态/窄宽度的真实几何、名称不常驻但身份可辨，以及定义文件外的调用链。

## 确认证据边界

已定位 Core screen-evidence：提交确认冷启动从 byte 0 请求历史；历史被 ctxmux 正常逐出后立即抛 OUTPUT_GAP。告示仅在下次完整屏幕确认后清除，因此旧告示会长期保留。修复前继续核对 retained replay、当前提交边界与增量屏幕的证据合同，不取消真实 gap 检查，不另建字节历史 owner。

UI 延续 f-2688fn733 的身份呈现 Closure；终端确认是独立行为 Closure，另建 Feature。两个任务分别验证，不把排版正确当作运行时已修复。

## 通知收件箱

用户进一步确认痛点是告示无法关闭，提出 Message Tools Mailbox。批准范围来自该明确请求：允许把当前 Session 服务提醒收起到收件箱，保留降级事实和恢复指引；同一问题按原因/严重程度合并，已读持久保存，恢复后清除。保持既有服务分类器为唯一文案和严重度来源；仅持久化已读指纹，不复制 Runtime 历史。独立 UI Closure，不把 Core 确认证据修复当作收件箱交付。

用户再次指出 readiness consumed 的队列提示也长期不消失且位置不同，明确要求统一梳理。补充同一收件箱 Closure 的队列/局部错误接入任务；原服务提醒任务语义不变。Steer 的 Provider 与 Core 因果审查正在进行，不以改文案代替协议修复。

依赖修正：服务提醒和队列提醒都消费相同收件箱控件，各自可用真实 Composer 验证，队列接入不必等待服务提醒完成打包/几何签收；两任务保持独立验收，不设礼仪依赖。

## Steer 设计收敛

独立 Level Router 与 Layer reviewer 发现旧 epoch 是 Core 观测，不是 Provider 的一轮一条限制。按 RED-LINES.md，取消它作为健康 Run 的永久许可证：readiness 只作为可选完整证据保存；输入事务仍保留未完成 submission BUSY、CAS、operationId、exact Run、expectedByte 和两阶段回执。missing/pending/consumed 都不再永久阻断；render 检查继续执行，失败继续显式降级，不把未知屏幕伪造为完整。持久校验只核验存在且关联的 readiness evidence，不要求历史 consumed epoch 指向最新 submission。自动进度的去重和触发策略另行核对，不机械移除防重复推进门。

后续边界复核证伪了“直接持久消费 completion 就足够”的候选：认领后、发送前崩溃会永久停车；异步保存期间暂停/换轮也可误发。修订同一 steer Closure 的验收：持久 pending 与确认分离、未知显式暂停、显式继续沿用原 operationId，并在实际发送边界复核同 Run/完成事实。不是增加 readiness 许可证或新 retry owner。


## Candidate and verification environment

主工作树存在并行 Browser/Copy Paths 未提交改动，Core build 在无关 Browser contract 的类型错误处失败。门禁已记录该失败。使用基于 a91f46c0 的独立候选 `/tmp/agentmux-message-tools-20260920`；只复制本轮显式文件清单与 Store 的四个 noticeReadReceipts 字段，逐字节核对候选后运行原门禁命令。修订只改变命令的执行位置，不改变 acceptance 或测试内容。最终提交/安装使用此独立候选，不把其他工作合入。

## Automatic progression scope

复核发现 `ContinuousProgressPanel` 的产品调用者为零，且没有创建/暂停/恢复的 IPC 接入；产品竖切仍为 **blocked**，归属既有 `f-25k8f8m9k/T-006`（目前等待其前置输入/交互合同）。本轮不宣称自动推进界面已交付。Main 确实会加载 durable loops，因此修复它对新 Core 准入规则的真实依赖：pending claim 与 confirmed completion 分离、重启未知暂停、显式继续复用同 operationId、暂停 signal 到达 Core 认领边界。已认领事务可恢复回执；pending interaction 只允许全部字节已接收的对账，不能补发 Enter。


## Evidence

- 22 个可编译的生产变异全部使对应行为测试变红，恢复后相关回归全绿；编译失败不计为 mutation caught。详见 `evidence/message-tools-delivery-mutations-20260920.json`。覆盖 receipt 写入/恢复/Session 隔离、启动空投影、头像/等高、队列接线、missing/pending/consumed 准入、未完成事务、历史缺口/可信 reset、自动完成去重/认领恢复/暂停/最终条件/权限界面不补写。
- 非零产品调用者：`AgentSessionComposer` 调用 inbox hook、Inbox、Banners；`SessionPane` 调用该 Composer；`client.ts` 两处调用 submission coordinator；`screen-evidence.ts` 构造并持续持有屏幕证据；`main/index.ts` 调用自动投递 helper。上述证明均排除定义文件和测试。自动控制面板的零调用者限制已单独列明，不能拿 owner 的调用者替它背书。
- 浏览器真实控件：314 / 554 / 994px 宽度，三态的切换、Inbox、Send、头像均 24px；切换在左、头像在右且无常驻文字。关闭告示后 inbox 仍保留条目。另有 DOM 测试覆盖空 Session 启动投影、同一事实重挂载已读、恢复后再发生、换 Run 新提醒、队列消息和局部 retry 不被关闭动作删除。
- 无 Stop 连续 steer、保存后新 Client 恢复继续发送、排队后取消、submit 已接收而确认丢失后在 working 状态恢复相同事务，均通过公开 Client / 实际 coordinator 的行为测试。
- 屏幕前缀被保留窗口淘汰后，继续保存观察连接；只有可信 RIS 终端重置恢复完整屏幕权威，普通清屏或同步帧不伪装为完整证据。无完整确认时输入仍继续，Inbox 保留真实降级。

安装前最后的并发复核证实：manual acknowledgment 不会立即改变 native semantic done；仅比较完成 ID 仍可误发自动提示。暂停 07bde277 的安装，追加 Core 的完成事实输入认领记录（含原 operation/range 供 single-phase 对账），与两阶段 claim 原子持久化。该字段是准入事实而不是第二套 Agent 状态，不伪造 working；完成事实消费只限制新自动输入。

补充准入候选验证：80 项相关回归与 desktop typecheck 通过；新增 5 个变异全部由行为断言检出（累计 27 个）。single-phase 与 two-phase 的完成消费、原子重验、持久解码、原字节区间恢复、调度侧停止重复探测均有覆盖。独立增量复核未发现新的 P1。最终安装候选包含该补充修复。
