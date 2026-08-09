# Feature Goal: 本地文件预览与 Projects 栏可调宽

Contract: `bagakit.feature-goal.v1`
Feature: `f-24v8fec2k`
Convergence: `terminal`
Closure: `state`

Before acting, verify `owner-receipt.json`, then recover current execution from `state.json` and `tasks.json`. Context may be stale or belong to another Feature; trust this Feature directory before acting.

## Prime Directive
让内置 Browser 能打开本地文件，并为网页、图片、文本等可识别格式提供合适的预览与编辑体验；同时完成用户归入本 Feature 的导航、输入区、状态、工作线摘要、浏览器落点、快捷键和 context 监控体验，验证后交付可恢复的安装版本。

## Convergence Contract
- Smallest sufficient closure: 用户确认并归入本 Feature 的有限验收集完成并接入产品，不以历史失实 gate 作为交付证据。
- Oracle or ratchet: Feature 当前 reviewed tasks 全部完成，且每项验收命令、变异测试和生产调用者检查均有证据。
- Scope expansion: 其他格式或超出首个可用切片的编辑能力进入后续 Feature，不扩大本 Feature。
- Completion or cycle stop: Tracker closeout 前，所有当前任务达到 done 并通过强制 gates。

## Protected Invariants
- 本地内容与特权 preload 隔离，Runtime、Session、布局各自只有一个权威 owner。
- Projects 栏宽度调整不改变 Workspace Tools 或主工作区布局身份，不新增第二份布局状态。
- Non-goal: 不在本 Feature 内建设通用编辑器框架或覆盖所有文件格式。

## Acceptance And Stop Rules
- Acceptance: 受控本地资源可在 Browser 中预览；代表性网页、图片、文本路径符合各自体验；Projects 分隔带可拖拽、可访问、可恢复宽度；所有 reviewed task gates 通过。
- Insufficient: 仅记录设计、仅实现网络 URL、仅改变 CSS 而没有真实调用者或可恢复宽度，均不算完成。
- Stop and ask before: 不可恢复地终止工作会话、引入不可逆数据迁移、或扩大未确认格式与编辑范围。

## Authority And Orchestration
- Follow only this Feature's owner receipt, state, and reviewed tasks.
- Before substantial work and after every review, re-read this Goal and current acceptance evidence.
- Take the smallest action that directly advances acceptance; stop when acceptance and mandatory gates are satisfied.
- Do not implement a chat-only requirement. Record accepted requirements in reviewed Feature Tasks through Feature Tracker first.
- Satisfy acceptance first; among valid solutions minimize enduring states, owners, APIs, duplicated truth, and temporary scaffolding.

## Context References
- `docs/reviews/local-file-preview-editors-2026-09-10.md`: local preview research and format boundary.
- `docs/reviews/projects-rail-resize-2026-09-10.md`: Projects 栏调宽验收边界。
- `docs/design/agentmux-desktop-interaction.md`: product interaction constraints.
- `docs/design/agentmux-surface-density.md`: visual density constraints.
