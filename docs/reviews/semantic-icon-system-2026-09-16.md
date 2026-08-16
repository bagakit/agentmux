# Semantic icon system review

## 结论

项目需要一个 semantic icon 层，但迁移边界必须按产品语义划分，而不是机械替换所有 SVG。Workflow、Activity、聊天状态栏、导航和动作图标应统一；Monaco、xterm 与第三方内容内部图标保持原库归属。

## 技术方案

- 用 TypeScript literal union 作为语义枚举，按状态、对象、动作、导航、层级分类。
- 由稳定的语义映射表选择 lucide 或组合 renderer；业务调用者不依赖具体 glyph 名。
- renderer contract 统一尺寸、`aria-hidden`/label、className、reduced-motion 和组合图标对齐。
- 动画只由 renderer 根据 semantic state 开启，静态/ reduced-motion 路径不创建动画状态。
- 不让图标组件读取 Store 或自行订阅外部状态，保证长列表滚动时成本可预测。
- 每个语义必须映射到独特 glyph 结构；不能用同一个最终图标代表两个不同语义。映射集合必须由测试完整钉死。
- 动态 renderer 按语义选择动作：running 可以旋转，completed 应有完成动作或独特静态勾形，paused/killed/failed 不复用 running 动画；reduced-motion 使用独特静态结构。

## 迁移策略

先跑通 Workflow/Gallery 的最小端到端 renderer，再迁移 Activity/聊天观察中具有产品语义的调用；根据扫描结果迁移跨表面重复的动作和导航图标。一次性全仓替换、兼容层和 fallback 不属于本 Feature。
