# 空间状态与导航机制

本文说明当前源码中空间事实的 owner、持久化、Desktop 投影及准确导航的公共接缝。整体体系与实体／入口的含义只见[空间模型](../design/behavior/spaces-and-layout.md#空间模型)及[概念词典](../design/behavior/spaces-and-layout.md#统一概念与空间寻址)；源码存在不代表所有设计消费面、实际安装或 Native surface 已通过验收。

## 唯一事实 owner

Core 持有 Space、Zone、Tab、Group、Region 的稳定身份、拓扑、顺序、分割比例、选择与全部绑定，独立于 Electron、React 和图形客户端。客户端持有屏幕几何、DOM 挂载、遮挡和输入焦点；地址索引与屏幕投影由持久关系派生。

没有 App 的远端 Host 仍通过同一公共 API／CLI 保存、查询与管理空间图。加载 Zone 使用稳定身份及原成员、布局，不以某一旧展示地址仍然存在为前提。解除一个绑定不删除实体或关闭 Run；AgentSession、Run 和执行 cwd 分别沿原 owner。

事实模型由 [`AgentMuxSpatialGraph`](../../packages/core/src/spatial-graph.ts) 与 [`AgentMuxSpaceCatalog`](../../packages/core/src/space-control.ts) 定义。空间目录与地址是同一实体图的消费视角，没有独立的 Agent 组织 Space 注册表。资源、Session 和 Run 的身份关系见[系统职责地图](system-ownership.md#身份与位置分开)。

## 持久化与跨进程观察

Core 状态目录中的 `spatial-state.json` 保存同一空间图；`AGENTMUX_SPATIAL_STATE_STORE` 可指定绝对路径，宿主也可注入该路径。revision 校验和跨进程锁保护并发写入；原子提交保留此前有效文档。读取损坏或不可用不能变成空图，也不授权破坏性覆盖；从保留文档恢复须明确执行。

[`defaultAgentMuxSpatialStatePath` / `AgentMuxSpatialStateStore`](../../packages/core/src/spatial-state.ts) 负责路径、读取、revision 提交、锁与订阅；原子写入沿 [`durableWriteFile`](../../packages/core/src/durable-write.ts)。

## 实体图与 Desktop 投影

### 保存什么

Core 文档保存实体、全部绑定、原 Group／Region 分割树及选择。客户端资源元数据作为 JSON 保留，由原宿主解释；Core 不创建 Browser 页面、文件、PTY 或 Run。已保存布局不证明 Native surface 已挂载。

### 如何提交与合并

仅当 Core 文档不存在时，Desktop 才可导入旧 Workbench。文档一旦存在，其 revision 即为权威，旧客户端副本不能覆盖它。Desktop 经受信 preload port 读写同一文档；Core ACK 后，偏好文件不再保存第二份实体或布局快照。UI 偏好与草稿仍由客户端持有。

不相交编辑保留双方增量；重叠编辑保留本地可见、未保存工作。客户端通过文件 owner 观察其他进程的提交。转换、保存和合并来源为 [`desktopSpatialGraph` / `desktopWorkbenchFromSpatial` / `DesktopSpatialPersistence` / `reconcileSpatialGraphs`](../../apps/desktop/src/renderer/src/lib/desktop-spatial-state.ts)。

### 缺失资源与 Host 能力

缺少 Host 资源元数据时如实报告，保 Core 身份与当前内容。资源来源和屏幕展示位置分别保留，不能用当前焦点补猜目录。空间管理复用既有 JSON-RPC 与远程传输；可移植 API 不以 OS 安装门禁判断可用性，随包 Native Runtime 的可用性是另一项 Host 能力。本页不为未验证 Host 的 Native surface 宣布完成。

## 准确选择与跨视图导航

Desktop 的 [`workbenchSpaceSelection` / `selectMainRegion` / `activateTab`](../../apps/desktop/src/renderer/src/store.ts) 持有并更新 Work 当前选择。原空间目录经 [`workbenchSelectionCatalog` / `resolveDesktopSpaceSelection` / `resolveWorkbenchOccurrenceSelection`](../../apps/desktop/src/renderer/src/lib/desktop-focus-navigation.ts) 确认对象、成员与准确 occurrence；局部选择与显式导航以原 intent 区分，不按最近 Session 或第一处展示推导目标。

Focus 的 [`mainFocusPresentation`](../../apps/desktop/src/renderer/src/lib/focus-tab-projection.ts) 消费同一选择，按原 Tab 或 Region 投影；[`mainRegionReference`](../../apps/desktop/src/renderer/src/lib/desktop-focus-navigation.ts) 从该选择派生准确引用，不成为第二个选择 owner。实体的展示通过 [`WorkbenchProjection`](../../apps/desktop/src/renderer/src/lib/workbench-projection.ts) 及原工作面组件消费；导航选择与 DOM 输入交接是不同事实。

这里核对空间底座和既有 Work 导航接缝；Mote／Work／Know 的产品分组及 Survey／Recall 的独立导航要求归[导航上下文合同](../design/behavior/spaces-and-layout.md#worksurveyrecall-与-mote-的导航上下文)，分组本身不新增 Core 实体或自动同步器。公共服务、JSON-RPC 与 CLI 的原接线见[系统职责地图](system-ownership.md#当前执行与展示链路)，精确参数沿[公共能力源码入口](../specs/public-capabilities.md)。
