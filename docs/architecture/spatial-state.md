# 空间状态与导航机制

本文说明当前源码中空间事实的 owner、持久化、Desktop 投影及准确导航的公共接缝。产品分组与身份含义只见[空间行为合同](../design/behavior/spaces-and-layout.md#统一概念与空间寻址)；源码存在不代表所有设计消费面、实际安装或 Native surface 已通过验收。

## 唯一事实 owner

Space, Zone, Tab, Group and Region identities, topology, ordering, split ratios, selections and all bindings are amux product data. Core owns these independently of Electron, React and any graphical frontend. Clients own screen geometry, DOM mounts, occlusion and input focus. Lookup maps and screen projections are derived; the underlying position relationships are durable.

A remote host without an App must maintain, persist, query and manage the same graph through the public API and CLI. A Zone is loaded by stable identity and its original members and layout, not by whether one saved presentation address still exists. Multiple bindings are allowed; unbinding one location does not delete the entity or close its Run. AgentSession, Run and execution cwd remain with their original owners.

事实模型由 [`AgentMuxSpatialGraph`](../../packages/core/src/spatial-graph.ts) 与 [`AgentMuxSpaceCatalog`](../../packages/core/src/space-control.ts) 定义。空间目录与地址是同一实体图的消费视角；没有独立的 Agent 组织 Space 注册表。内容资源、Session 和 Run 沿[系统职责地图](system-ownership.md#身份与位置分开)的原 owner。

## 持久化与跨进程观察

The filesystem owner uses `spatial-state.json` in the Core state directory. `AGENTMUX_SPATIAL_STATE_STORE` may select an absolute path; hosts can inject that same path. Revision checks and a cross-process lock protect concurrent writes. Existing durable file writes commit atomically; the previous valid document is retained. Corrupt or unavailable reads never become an empty graph or authorize destructive replacement. Recovery from the retained document is explicit.

来源：[`defaultAgentMuxSpatialStatePath` / `AgentMuxSpatialStateStore`](../../packages/core/src/spatial-state.ts) 负责路径、读取、revision 提交、锁与订阅；原子写入沿 [`durableWriteFile`](../../packages/core/src/durable-write.ts)。

## 实体图与 Desktop 投影

The document keeps entity facts, every binding, original Group and Region trees and selections. Client resource metadata is preserved as JSON, interpreted by the original host; Core does not create Browser pages, files, PTYs or Runs. Public spatial management uses the existing JSON-RPC and remote transports. A persisted layout does not imply a Native surface is mounted.

Desktop may import its old workbench only when the Core document is absent. Once present, the Core document and revision are authoritative; a stale client cannot overwrite it. UI preferences and drafts remain client concerns. Desktop reads and writes that same file through its trusted preload port. Its preferences contain no second entity or layout snapshot after the Core ACK. Disjoint edits retain both changes; overlapping edits keep the local work visible and unsaved. Clients observe commits from other processes through the filesystem owner. Missing Host resource metadata is reported without removing Core identities or current content. The package has no OS installation gate for these portable APIs; shipped Native Runtime availability is a separate Host capability. These contracts do not certify Native surfaces on an untested Host.

来源：[`desktopSpatialGraph` / `desktopWorkbenchFromSpatial` / `DesktopSpatialPersistence` / `reconcileSpatialGraphs`](../../apps/desktop/src/renderer/src/lib/desktop-spatial-state.ts) 在同一 Core 图与原宿主工作面之间转换、保存及合并；真实资源来源与屏幕展示位置分别保留。

## 准确选择与跨视图导航

Desktop 的 [`workbenchSpaceSelection` / `selectMainRegion` / `activateTab`](../../apps/desktop/src/renderer/src/store.ts) 持有并更新 Work 当前选择。原空间目录经 [`workbenchSelectionCatalog` / `resolveDesktopSpaceSelection` / `resolveWorkbenchOccurrenceSelection`](../../apps/desktop/src/renderer/src/lib/desktop-focus-navigation.ts) 确认对象、成员与准确 occurrence；局部选择与显式导航以原 intent 区分，不按最近 Session 或第一处展示推导目标。

Focus 的 [`mainFocusPresentation`](../../apps/desktop/src/renderer/src/lib/focus-tab-projection.ts) 消费同一选择，按原 Tab 或 Region 投影；[`mainRegionReference`](../../apps/desktop/src/renderer/src/lib/desktop-focus-navigation.ts) 从该选择派生准确引用，不成为第二个选择 owner。实体的展示通过 [`WorkbenchProjection`](../../apps/desktop/src/renderer/src/lib/workbench-projection.ts) 及原工作面组件消费；导航选择与 DOM 输入交接是不同事实。

这里核对空间底座和既有 Work 导航接缝；Mote／Work／Know 的产品分组及 Survey／Recall 的独立导航要求归[导航上下文合同](../design/behavior/spaces-and-layout.md#worksurveyrecall-与-mote-的导航上下文)，分组本身不新增 Core 实体或自动同步器。公共服务、JSON-RPC 与 CLI 的原接线见[系统职责地图](system-ownership.md#当前执行与展示链路)，精确参数沿[公共能力源码入口](../specs/public-capabilities.md)。
