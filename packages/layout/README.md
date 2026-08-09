# @agentmux/layout

工作区分屏布局的**纯代数**——一棵带方向与比例的二叉分屏树，叶子上挂各自的载荷。工作区的
tab-group 布局与 tab 内的 region 布局是同一棵树，只有叶子载荷不同，所以这套树代数只存在一份。

## 为什么是独立的包

这套代数此前住在 Desktop 渲染层里，与 React/Electron/store/Agent 概念混在一起。抽成包是为了让
「树的结构、方向寻址、焦点移动、比例夹取」这些**与显示无关**的判定可以在包外消费、在裸的非 DOM
环境里测，且从机器上保证它不回头依赖任何 UI/Agent 概念。

**零 UI/Agent 依赖**是这个包的硬约束，不是风格：`src/` 下任何文件都不得 import `react` /
`react-dom` / `electron` / `zustand`、任何渲染层路径、或 `@agentmux/core` 的 barrel。唯一允许的
外部依赖是 node-free 的类型 SSOT 子路径 `@agentmux/core/workbench-layout-preset`（布局预设名的全集，
控制协议与 GUI 共用同一份，不在这里重列）。这条约束由 `test/package-consumer.test.ts` 逐文件静态
扫描守着。

## 公共 API

只从包入口 `@agentmux/layout` 取，不要深入 `src/`：

- **split-tree**：泛型分屏树 `SplitTreeNode<Leaf>`、比例夹取（`clampSplitRatio` /
  `clampSplitTreeRatios` / `setSplitRatioAtPath`）、叶子操作（`collectLeafIds` / `removeLeaf` /
  `replaceLeaf` / `findSiblingLeafId` / `dedupeLeafIds` / `leafIdsMatchRecords`），以及比例 SSOT
  常量 `MIN_SPLIT_RATIO` / `MIN_SPLIT_PERCENT` / `EVEN_SPLIT_RATIO`。
- **split-direction**：方向的几何真相——`orientationOf` / `placementOf` / `regionInDirection` /
  `REGION_GEOMETRY_EPSILON`。
- **workbench-layout**：`WorkspaceLayout` 与 tab-group 树的 reducer（`addTab` / `removeTab` /
  `moveTab` / `moveTabToNewGroup` / `assertGroupInvariant` …），`SplitDirection` union 定义处。
- **workbench-view-layout**：`WorkbenchViewLayout` 与 region 树的 reducer、`workbenchRegionBounds`、
  `applyWorkbenchRegionLayoutPreset`。

## 无构建步骤

`exports` 直接指向 `./src/*.ts`：vite/vitest 直接转译 TS，消费者无需先 build。`tsc -p
tsconfig.build.json` 的 `build` 脚本只为类型检查/emit 对齐，不是消费者的前置门禁。
