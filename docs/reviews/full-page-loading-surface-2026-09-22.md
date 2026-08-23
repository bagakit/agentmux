# Review: reusable full-page loading and startup big-screen surface

日期：2026-09-22

## Reviewed goal

用户希望 AgentMux 启动时有酷炫的大屏动画，所有全页加载也使用同一套视觉语言，并把大屏动画封装成可复用组件，放在统一位置。

## Approved closure

- 新增一个 renderer-only、无 Electron 依赖的 `FullPageLoadingSurface`，统一 loading / recovering / failed 三类全页状态的结构、可访问文本和 reduced-motion 降级；ready 时由调用方卸载它。
- 启动与恢复入口只提供阶段、说明和可选动作；组件不拥有 Session、Run、布局或恢复事实，不清空 durable 工作面。
- 盘点并迁移真实的全页加载入口；行内 loading 和原生 Browser/Terminal 内容不强行套大屏。
- 用行为测试、源码调用者扫描、变异验证和真实启动/恢复页面检查证明组件接入产品。

## Interaction constraints

- 大屏是过程提示，不阻断健康 Agent；组件只提供 failed 阶段骨架，流程探测失败由调用方接入既有服务窗说明步骤、当前状态和恢复动作。
- 动画结束后保留原 Tab、Region、焦点、草稿和 Session 引用；只有 Core 的终局事实允许移除投影。
- `prefers-reduced-motion` 下保留静态构图、阶段标题和 live 文本，停止扫描与位移。
- 动画不能依赖某个站点、Provider、按钮文案或启动路径；调用方只传通用阶段事实。

## Review decision

状态：**approved**。实现边界只覆盖全页 loading 的复用和视觉统一，不复制 Runtime 状态，也不替换局部行内 spinner。
