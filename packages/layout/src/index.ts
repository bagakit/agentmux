// 布局代数包的公共入口——纯分屏树代数，零 UI/Agent 依赖（见 README）。四个模块按内部依赖序
// 重导出：split-tree（0 依赖）← split-direction（type-only）← workbench-layout ← workbench-view-layout。
// 包外消费者只从这里取（`@agentmux/layout`），不得深入 `src/`——渲染层曾有四个同名转发文件，
// 已随抽包一并删除，今天渲染层的每个消费者都直接 import 本包。
export * from './split-tree'
export * from './split-direction'
export * from './workbench-layout'
export * from './workbench-view-layout'
