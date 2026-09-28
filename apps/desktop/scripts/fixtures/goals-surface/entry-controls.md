# Goals 起步控件实际 Renderer 场景

用户反馈「CTA 按钮在设计上太挫了，和设置页完全比不了」。约束唯一见 interaction《Goals 的 Grill 与 Grounding》与 surface-density《Goals 的目标正文与对齐密度》。

`node apps/desktop/scripts/verify-goals-surface.mjs`（也可显式 `--entry-controls`）编译当前产品 App、GlobalBoardSurface 与实际 index.css，使用私有 Electron userData/sessionData。原完整 Goal 详情/确认/结果场景仍可用 `--full-workflow`，不参与此次新控件审美的代签。

采图包括 dark/light × 1280/620 × 零目标、一项目标、连续目标、可靠 recent、current-only；320 light 的长项目名；320 light 同时报告减少动态、减少透明度、增强对比偏好；620 dark 的真实 keyboard Tab focus、hover、mousePressed 和 preparation。

preparation 从真实第三个 CTA click 进入原 startGoalExploration/createScratchTopic owner。fixture 只延迟 preview ensureMote 的回应，随后点击实际 Goals 导航返回，读取原 finite pending boolean。正常完成该 preview 回应后检查控件可用，不 seed 第二份请求或 pending 状态。原三句 textContent、准确相邻项目、完整行命中与本文宽窄可读性均从实际挂载 DOM/computed style/geometry 断言。

模拟边界：Project、Goal、Session 与 Runtime 来自原 preview API；这份证据证明真实 Renderer 接线与可见控件，不证明真实 CLI 首轮理解、Native 发送、Main durable 保存或重启。没有操作用户 App 或 Run。Native 首发/失败草稿/普通重启证据沿旧合格 owner 消费，由此次 Source 接缝审查明确适用范围。

截图 receipt 的 captureOnly 与 aestheticReview:not-performed 不构成审美通过。独立 Agent 必须逐张实际看完整页，并与本次引用的 Settings 图对照字重、长句、项目次层、边界、操作状态、宽窄空间与连续清单。修正后重拍同场景；最终 Root 消费准确候选结论。
