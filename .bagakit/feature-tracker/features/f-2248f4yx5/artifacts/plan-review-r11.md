# f-2248f4yx5 计划修订 11：把 T-018 去膨胀，卸载两个外部阻塞的 task

日期: 2026-08-28
评审结论: **approved**（用户在会话中确认账本方案）

## 依据

九个候选项逐一对着代码评估，每条再过一遍对抗性复核（9 条中 1 条被推翻）。完整账本见
`ideas/index.md` 的「从 tracker 卸载的决定」一节。

## T-018 重界定为「单次独立边界 Review」

原 task 捆了**两个可分割的交付物**，只有一个卡住：

1. **benchmark 重冻** —— 确实被外部阻塞。正式一轮卡在 ctxmux owner 层的 RSS 修复
   （`docs/benchmarks/agentmux-daemon-cutover.md:7`），属上游仓库。而且现存唯二两份结果
   （`docs/benchmarks/results/`，8/17）**早于** 8/24 的 cutover（d365560），测的是已被删除的自建
   daemon，Rev3 判定还是 fail —— 这不是缺数据，是**数据无效**。**从本 task 移出**，记入 ideas。
2. **独立边界 Review** —— **不卡任何上游**，只依赖已经存在于树上的最终 SHA（T-020 与 T-017 均
   已 done）。且它是 plan SSOT 明确要求的：`docs/plans/agentmux-core-maturity-review.md:64`
   「由独立 Review 验证边界和失败模型」。**从未做过**：`docs/reviews/` 目录不存在，T-017 自己的
   闸门也只是浅的 `pnpm check` + 文件存在性检查，所以 kernel/permission 边界至今没被独立审过。

同时**删掉「至少三个独立 Reviewer」这项膨胀** —— SSOT line 64 只要求「独立 Review」，三个
reviewer 是从别处继承的仪式，对本项目规模没有对应收益。

## 卸载 T-019 与 T-021

两者都从当前计划移出（记入 `superseded_task_ids`，历史保留可读），依据写在 ideas：

- **T-019（A2A + Inbox）**：human-in-the-loop 的多路复用器里人是信任锚，那套 capability 认证与
  幂等 ledger 只在 agent 自主对彼此动作时才值钱，而那正是 `agent-communication.md:36` 明确否认的
  编排。真实需求「不丢追踪」已由 roster/attention 兑现。core 里零实现。
- **T-021（SSH）**：前置在我们不拥有的上游 —— vendored `@ctxmux/sdk` 的 `RunBackend` 只有
  `native｜tmux`，全树 grep remote/ssh 零结果，而 `ctxmux-cutover.md:171` 明令「AgentMux 不私造
  Remote wire」。**无论意愿如何都执行不了**，留在 tracker 只会永久阻塞。fail-closed 占位保留。

卸载它们同时解除了 `T-019→T-018`、`T-021→T-018` 两条硬阻塞边。

## 一处事实更正

初评称「ctxmux 是我们无法 patch 的 vendored binary」——**这是错的**。`tasks.json:689`（T-020 验收）
写明「两仓库同属用户」，是同一 owner 的独立仓库按 exact commit 引入。所以准确表述不是「结构上不
可能」，而是「不该是 AgentMux tracker 里的 task」。这只支持解阻塞，不支持宣称做不到。

## 明确不做的

不改任何已完成 task 的状态与历史。T-008 / T-016 保持 blocked 且留在当前计划之外 —— 它们各自被
已交付的 task 取代，那个状态就是重规划的记录。
