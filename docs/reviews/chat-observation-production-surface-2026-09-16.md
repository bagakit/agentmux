# Chat observation production surface review

## 用户确认的方向

- Gallery 的产品成熟度已经足够，聊天页面可以直接使用同一套组件。
- Gallery 与当前 AgentMux 的设计语言还不完全一致，图标和结构需要进一步收敛。
- 聊天页替换只改变观察展示层；消息、Session、Agent 与 Runtime 事实继续由原有 owner 提供。

## 设计决定

- Gallery 和聊天观察区共用 Workflow 的状态 glyph、层级标题、时间线和 dock 组件。
- section 采用“序号/图标 + 主题 + 一句话目的”的结构，先给用户阅读地图，再展示样例。
- 图标优先复用 lucide-react 与现有 StatusDot/语义图标，不引入新的图标库或 emoji 作为状态事实。
- 生产聊天适配层只把真实 Activity/Run/Agent 数据映射到公开 props，不复用 Gallery fixture。

## 验收重点

- 图标在 light/dark 下都具备可读性，不依赖颜色表达状态。
- 页面顺序能明确区分上下文、主体工作流、终态恢复、规模降级、dock 和既有聊天表面。
- Gallery 与聊天页不出现第二套并行组件实现。
