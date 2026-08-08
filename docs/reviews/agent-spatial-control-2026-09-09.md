# Agent 自助创建与空间操作：整合审查

Review: approved

授权：用户连续要求修复重复投影、自定义 Executor 启动、虚假的右侧占用信息，并确认“整合需求并优化”。以两份设计 SSOT 为行为和视觉约束。本文件只记录证据、工作拆分与验证，不复制需求。

## 已确认和待验证

- `open.agent` 的已有 Session 分支新增投影；截图中的“移动”用了该命令，源 Region 因而仍在。GUI 已有真正的 `promoteRegionToTab`，CLI 尚未暴露它。
- Executor 已是开放字符串，创建校验是配置键查询，没有内置白名单。设置里的 label 可变、ID 单独生成且只读；名称当 ID 是可复现的失败路径。尚未读取 CodexAllDisk 当前配置，不把这个具体个案说成已经实机确诊。
- `list.agents` 只有 ID/label/Provider/available；available 从任意 Workspace 的 ready 探测聚合，不能准确表达目标 Host，也混淆未探测与不可用。
- `directionalNeighbor` 返回 Region 或相邻 Tab，属于有意保留的导航合同。创建空间只能消费 View 几何；不能删掉 Tab 导航来掩盖两种关系被混用。
- 树代数、方向、几何和 Region 布局仍在 Renderer；仓库只有 packages/core，没有独立布局包。ctxmux 是 Run Runtime，不是布局包。
- 异步启动完成后，Agent 回执仍携带 plan.tabId；代码先查询现存 owner 后不使用它生成回执。是否导致用户这次异常尚待延迟完成/中途搬动行为测试证实。

## 任务边界

T-001 名称解析是最小可用端到端修复；T-002 补目标 Host 的发现与 Session 关联元信息；T-003 将既有纯布局代数迁入独立包并接回产品；T-004 给 CLI 暴露真正的 Region 移动；T-005 修正异步操作的实际落点回执和降级行为；T-006 将空间原则和发现/移动引导接到注入路径。最后 T-007 消费整合候选验收。

T-001 与布局迁出不互相依赖。T-004 消费 T-003 的公共布局操作；T-005 消费 T-004 的可复现异步搬动；T-006 等 CLI 和元信息合同落定，避免提前教不存在的命令。共享热点是 Core Control 合同、Desktop store 和 CLI 帮助，单一执行者按边界串行编辑，不为形式并行复制 owner。

独立包暂定 packages/layout（@agentmux/layout）：仅纯树、方向、几何和布局变换，不持有 Session/Runtime，也不依赖 Desktop 类型。保留已运行的产品路径，迁出并接线在同一候选内完成，不留 re-export 兼容层或双实现。

验证覆盖真实 CLI、协议解析、store/UI 入口、包外消费者；每个实现任务须有变异红绿和排除定义文件的生产调用证据。新增扫描验证须断言扫描非空。不得以纯函数单测或文案出现替代产品交付。打包安装是前一需求的后续，不能把未完成的控制任务混称已安装。

## Tracker 边界

旧 f-24e8ffbzq 是任意元数、换位、独立窗口与方向选择器的 proposal，本次闭合目标不同，引用它但不删掉未授权取消的需求。先前两份搬动/自定义交接计划未正式安装，整合计划取代这些草稿；project-navigation 仍独立。
