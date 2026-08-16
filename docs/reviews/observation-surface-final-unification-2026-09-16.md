# Observation surface final unification review

## Scope

彻底完成 Gallery、Workflow、Activity、服务窗、权限卡和 Composer 的视觉与组件统一；真实聊天事实仍由原有 Session/Core/Runtime owner 提供。

## Design direction

- 以时间线为骨架，以分层 surface 表达上下文，以语义 icon 和状态轨道表达事实。
- 视觉重点放在层次、对比、细微动势和状态反馈，不用装饰性卡片堆叠制造“高级感”。
- Gallery 直接展示最终生产组件和真实公开 props，成为快速回归入口。

## Technical boundary

- Chat host owns data adaptation; Workflow and semantic icon components remain store-free.
- No compatibility layer, migration, fallback or parallel chat-only component.
- Existing Core/Runtime facts are not reimplemented in the renderer.

## Acceptance

- Chat observation uses the same production surface as Gallery.
- Running/completed/failed/paused/permission/degraded states remain semantically distinct.
- Keyboard, reduced-motion, narrow layouts and existing Composer/interaction behavior remain valid.
