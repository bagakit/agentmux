---
status: approved
title: Attach recovery boundary and bounded Runtime projection
date: 2026-09-25
---

# 评审结论

本次问题的主要责任边界在 AgentMux 的 Desktop/Core 接入流程。ctxmux 持有 PTY、Run、ordered bytes、Replay、Gap 和 Attachment 的权威事实；AgentMux 不应为了把一个 Session 交给 Renderer 而重新枚举整张 Run 表。

修复前的 attach 路径是：

`RuntimeController.attachSession → sessionByTarget → AgentMuxClient.runtimeProjection → listRuns → CtxmuxRunAdapter.list → 每个保留 Run 一次 status`。

这条路径让一个精确目标的 attach 变成与历史 Run 数量相关的全局 fan-out。当前 daemon 可连接、健康检查通过，不能把现象归因成 ctxmux 已经失活；`ECONNREFUSED` 是这条调用形状在恢复并发下产生的连接压力信号。是否发生过 Unix listen backlog 溢出仍未被现场采样证明，所以不把它写成确定事实。

## 1. 边界与职责

- ctxmux：Run/PTY 生命周期、Attachment、ordered bytes、Replay、Gap、尺寸和输入游标。
- AgentMux Core：Provider、AgentSession、语义状态和把一个权威 Run 与 Session 组合成 Runtime Subject 的投影。
- AgentMux Desktop：恢复 durable Tab/Region、调用精确 attach、把流程退化显示成服务窗；不自己重建 Run 真相。

精确 attach 使用目标 Attachment 已经返回的 Run，Core 只做一次目标 Subject 投影；完整 Runtime projection 只用于确实需要全量列表的启动快照和管理界面。

随后把 Desktop 内其它单目标入口（launch、resume、refresh、recover）也收敛到同一个精确 Subject
入口；`runtimeProjection` 在 Desktop 主进程只剩启动快照和跨 Host 的 `resolveSession` 查找。这让
“单目标事实”与“全量管理事实”在调用层就分开，而不是靠调用方记住某个 helper 的可选参数。

## 2. 内聚与耦合

现有 `projectAgentMuxRuntimeSubjects` 已经是组合 Run 与 AgentSession 的唯一规则，应由 Core 继续持有。Desktop 只负责把 Subject 投影成 `SessionSnapshot`。新增的精确 Subject API 复用该规则，不在 Desktop 复制身份校验。

`CtxmuxRunAdapter.list` 仍属于 Core 的全量列表边界。它为必须全量读取的调用提供有界 status hydration，避免把 `Promise.all(全部历史 Run)` 变成隐含的资源管理策略。

## 3. 管理方式

参考成熟工作台按 team 管理局部终端的做法：`team session owner` 按 team 持有局部状态，`team command dispatcher` 只做命令分发，`TeamPane` 保存稳定的 fake pane id、真实 handle、顺序、split 来源和失败原因；每次请求先校验 team token 与 pane membership，再执行目标操作。这个模式的可迁移部分是“局部 owner、稳定句柄、显式失败、命令分发与状态持有分开”，而不是引入 tmux 作为 AgentMux 的第二个生命周期 owner。

对应到 AgentMux：Session attachment owner 按精确 Run 串行化，Core registry 负责 Session membership，ctxmux 负责 Attachment；不能用全局 projection 代替目标查找，也不能因一次恢复流程失败就删除健康 Session。

## 4. 熵审查

主要熵源有两个：

1. 单目标操作依赖全量 `runtimeProjection`，把全局状态读取、连接并发和单目标 attach 耦合在一起。
2. 全量列表的 status fan-out 没有并发边界，资源上限藏在 `Promise.all` 里。

本次收敛删除第一种隐式耦合，并把第二种资源策略写成 Core 内部的有界执行。不会添加重试、第二份 Runtime 缓存或永久兼容路径来掩盖原问题。

## 验收

- 一个 attach 不调用全量 `runtimeProjection`，目标 Run 已在 Attachment 中时不再额外发 status。
- 必须全量列表时，status RPC 的同时在途数有明确上限。
- 并发 attach 仍按目标 Session/Run single-flight，健康 Agent 继续可输入；流程退化只能显示服务窗。
- 重启恢复仍先保留 durable 工作面，再尝试精确 reattach/resume。

## 验证证据

- Core build、Core typecheck、Desktop typecheck 通过。
- `runtime-subject`、Runtime projection、bounded list hydration 测试通过。
- Desktop `runtime-controller` 测试 61/61 通过；精确 attach 用失败的全量 projection 作为守卫，确认不会枚举历史 Run。
- 将 attach 的精确 Run 改回 `undefined`、将 hydration 上限从 8 改为 20，对应测试分别变红后均已恢复。

## 剩余边界

本次没有把跨 Host 的 `resolveSession` 或启动快照改成单目标接口：它们的返回合同本来就是全量或跨 Host
查找，继续使用 Runtime projection 是职责匹配。ctxmux 的 daemon 生命周期、socket owner 和自动重连仍由
Core/ctxmux adapter 持有；本次没有引入第二个 tmux 或进程生命周期 owner。
