# @agentmux/layout

本包重导出 Core 的无 UI 空间布局代数，供已有客户端通过 `@agentmux/layout` 消费同一实现。代数的唯一源码 owner 是 [`@agentmux/core/spatial-layout`](../core/src/spatial-layout.ts)；本包不持有空间状态、实体身份或生命周期。

## 树与载荷的关系

显示 Workspace 的分割树以 Tab Group 为叶子，各 Group 通过 Tab 顺序组织完整 Tab 的展示；Tab 内的分割树以 Region 为叶子。两类树复用相同的泛型二叉树代数，叶子载荷和所属对象不同，不是同一份布局实例。实体与绑定关系见[空间模型](../../docs/design/behavior/spaces-and-layout.md#tabtab-group-与-region)。

## API 与消费边界

[`src/index.ts`](src/index.ts) 只重导出 Core 子路径。分割树、比例、方向寻址和两类布局 reducer 的准确 exports 以该子路径为准；消费者使用包入口，不另复制算法或深引内部文件。

该 Core 子路径必须独立于 React、Electron、Renderer Store 和 Agent 生命周期。布局变更的提交、持久化与空间身份由[Core 空间状态 owner](../../docs/architecture/spatial-state.md)处理；纯代数计算不代表布局已保存。

本包的入口直接指向 TypeScript 源文件，没有 emit/build 步骤。运行环境、exports 和检查命令以 [`package.json`](package.json) 为准；宿主须支持该源 TS 及其模块解析，不能仅凭是否使用 Node 或 Vite 推断可导入。类型检查使用 `typecheck`，消费边界测试见 [`test/package-consumer.test.ts`](test/package-consumer.test.ts)。
