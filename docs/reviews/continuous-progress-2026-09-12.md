# 内置任务持续推进：AFTERTIME 需求评估

2026-09-12。需求由用户在本会话直接交付 AgentMux 维护 Agent，已接收；没有发生 CLI 定向转发，不伪造 delivery receipt。参考项目仅只读检查，未发送业务消息、启用循环或修改权限。维护者评审：approved，批准登记以下建议范围；本轮仅评估与规划，尚未实现/验收。

## 代码证据

| 能力 | 当前事实 | 建议复用/补齐 |
| --- | --- | --- |
| 调度 owner | 在 Core、Desktop Main/shared 中未找到持久化 loop scheduler | Desktop Main 持有循环生命周期，通过 typed intent 暴露；Core 继续单 Session 输入能力，不在 Renderer setInterval 发消息 |
| 输入串行 | `packages/core/src/client.ts` 的 `serializeAgentInput` 重读 Session、验证 Run 和 running，普通 `submitAgentPrompt` 检查 pending interaction | 补自动续行的条件提交合同，普通人工 Send/steer 保持独立语义 |
| 就绪消费 | `packages/core/src/prompt-submission.ts` 的 `claimPromptReadiness` 保存 consumedBySubmissionId；使用 operationId、输入字节栅栏和阶段回执 | 复用，而非另写 PTY 发送器；核实各 Provider 是否走同样的 readiness 分支 |
| 投递回执 | Main `runtime-controller.ts:submitPrompt` 每次生成 randomUUID，Core `AgentMuxAgentPromptInput` 仅有 Session/operationId/prompt，返回 void | 调度需要持久稳定 operationId、expectedRun/readiness/input revision 与可查询结果；不能把 void 成功当 Provider 已消费 |
| 输入竞争 | `serializeAgentInput` 是一个 Client 实例内的队列，已有 ctxmux expectedByte 栅栏 | 不能据此宣称跨 Client、Hook 变化和用户草稿无竞态；最终条件认领与输入消费必须接到同一权威投递边界 |
| Session 列表 | `packages/core/src/agentmux.ts:listCommand` 整批 Promise.all(statusAgent) | stale 条目可使整批失败；改逐项结果并保留错误对象，不吞全局连接错误 |
| 维护者发现 | 现有 CLI 支持精确 Session/Region/Tab send，无维护角色目录 | 复用已有 handoff Feature 补显式角色绑定、未知目标草稿和回执；不作为单 Session loop 的前置依赖 |

现有 Renderer `agentSteerQueues` 是人工消息队列，不是持久化调度。它没有 tick/readiness 的单次认领保证，不能直接用来承载自动循环。前一轮任务标 done 也不构成这些能力已交付的证据。

## 建议范围与边界

首版提供精确单 Agent 的周期续行、持久配置、一次立即检查、紧凑观察与可选 Tracker 来源。Host 管调度，Core 管条件输入，Provider 提供原生证据，任务适配器只读业务状态。应用完全退出期间不执行；重新打开/唤醒时重查一次即可，不引入额外常驻 daemon。

正常完成、手动中断和 Provider StopFailure 不能统称 Stop。App 按钮/公开 interrupt 可记录用户意图；原生 TUI 中断必须核实 Provider 证据，无法区分时明确限制自动能力。用户已在终端输入的字节与尚未提交的 Composer 草稿是两条占用信号：Host 只看到 acceptedInputBytes 无法保护后者，需把已有输入表面的占用/版本接到条件提交上。不存在这些信号时不能宣称“并发安全”。

权限等待本身只挂起发送并定位原请求；真实 Provider/绑定错误暂停循环。停止循环不会停止 Agent。任务来源未知/读失败与“无可推进工作”分开，不能假装业务已结束。all tasks done + pending closeout 要发起 closeout 续行；discarded/transferred 停止本循环但不标成功。

原型 `ops/claude_loop.py` 适合作为判定参考，不原样搬入产品：Session/Provider/path 写死、inspect/send 分两步、结果未知前写 memo、异常立即暂停，且终态统一 complete。8 项单测只验证 decision 函数，没有跨进程竞态、持久化投递或真实新一轮消费证明。launchd 的 UNKNOWN_AGENT_SESSION 根因仍未定位；本轮不推断为通用 launchd 限制。

## 建议任务与验收

执行计划以 Tracker tasks.json 为准。本文件给出证据要求，不维护第二份状态。

1. 先闭合公开 typed「条件检查/投递」最小链路：精确目标，busy/permission/user input/run mismatch 不发送，相同 readiness 只认领一次，未知回执不重发。用可控并发屏障验证 read→submit 竞争，不能只测纯 decision。
2. 接入持久周期与最小 UI：30 分钟默认、忙跳过、立即检查、暂停/恢复/停止、重启/唤醒不补发，单目标去重；fake clock + Main 生命周期重建 + mounted UI 接线验证。
3. 可选 Tracker 适配：真实 schema fixture 覆盖 runnable/blocked/closeout/archived/discarded/transferred 和损坏来源；普通无任务来源循环明确截止/上限语义。
4. 补观察面：回执分阶段、未知状态、原权限定位、活动来源、倒计时和空转说明；从组件操作验证真实 Host 调用。
5. 真 Claude 端到端：在明确授权的测试 Session 验证“结束→到期→单次接收→新一轮开始”，并验证重启恢复。不得驱动 AFTERTIME 业务 Agent 作为无授权实验。Codex/其他 Provider 分项列出支持与 unknown，不能从 Claude 外推。

每个实现 task 须同时有行为 gate、变异红绿证据、排除定义文件后的生产调用者证据；没有这些证据不可标 done。拟定测试文件尚待实现，不把计划命令当已通过证据。

## 独立的 CLI 基础能力

Session 列表部分成功、筛选和真实诊断指引，以及维护角色精确绑定/待投草稿/receipt 纳入既有 `f-23d8fwq4z`（Managed Agent Handoff and Conversation Entry）。其 Closure 是可靠发现和定向交接；不与持续推进绑定成巨型 Feature，也不阻塞用户在已知 Agent 输入区启动循环。

## 本轮验证

只读运行原型 8 项 decision 单测；核对上述生产代码路径和 Tracker 计划结构。未验收自动续行、跨重启投递或任务最终完成。

## 追加需求：全局 Message Tools 与 Context 语义（2026-09-12）

用户确认初始页与已连接 Agent 的输入能力应对齐：引用文件、截屏、选择 Skill、Provider subcommands/commands 和快捷指令使用同一个可复用 Message Tools 组件。组件接收项目/工作区上下文；初始页只因尚未有 Session 而不能显示 Session 专属 context，工具的收起能力由宿主表面决定。启动失败或未提交时，prompt、已选引用与选项必须保留。

Context 不是一条普通消息，也不是“剩余百分比”孤立数字。它表示当前 Session 的上下文容量消耗：已使用/容量、剩余比例，以及 Provider 报告的压缩或接近压缩阈值状态。若 Provider 没有暴露压缩阈值，只显示“剩余上下文”并明确未知，不臆测何时压缩；hover/详情显示采样时间与来源，不能把 queued 数量混进 Context。

追加任务：T-006 抽取全局 Message Tools 并接入初始页；T-007 重做 Context 语义与可访问详情。两项依赖 T-003（观察/输入表面）但不改变 loop 的权限和投递边界。

## 追加需求：Session 重启恢复（截图现场，2026-09-12）

截图显示外置监督器在 Claude `working` 时同时记录 `error_paused`，且 Session 重启后状态没有形成可信的恢复链路。该问题属于本 Feature 的同一 Closure，追加 T-008，不创建平行 Feature。

T-008 目标是 Run 替换/Session 重启后的幂等恢复：保留 loop 配置，废弃旧 Run 的 tick/readiness/回执，重新解析精确 Session 与新 Run，只执行一次恢复检查；将执行、循环、恢复三种状态分开投影，避免 busy 与 error_paused 并存却无法解释。验收必须覆盖正常重启、旧回执未知、stale binding、恢复竞态、窗口重载和失败后手动恢复。
