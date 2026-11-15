# 空间状态与导航机制

本文说明当前源码中空间事实的 owner、持久化、Desktop 投影及准确导航的公共接缝。整体体系与实体／入口的含义只见[空间模型](../design/behavior/spaces-and-layout.md#空间模型)及[概念词典](../design/behavior/spaces-and-layout.md#统一概念与空间寻址)；源码存在不代表所有设计消费面、实际安装或 Native surface 已通过验收。

## 唯一事实 owner

Core 持有 Space、Zone、Tab、Group、Region 的稳定身份、拓扑、顺序、分割比例、选择与全部绑定，独立于 Electron、React 和图形客户端。客户端持有屏幕几何、DOM 挂载、遮挡和输入焦点；地址索引与屏幕投影由持久关系派生。

没有 App 的远端 Host 仍通过同一公共 API／CLI 保存、查询与管理空间图。加载 Zone 使用稳定身份及原成员、布局，不以某一旧展示地址仍然存在为前提。解除一个绑定不删除实体或关闭 Run；AgentSession、Run 和执行 cwd 分别沿原 owner。

事实模型由 [`AgentMuxSpatialGraph`](../../packages/core/src/spatial-graph.ts) 与 [`AgentMuxSpaceCatalog`](../../packages/core/src/space-control.ts) 定义。空间目录与地址是同一实体图的消费视角，没有独立的 Agent 组织 Space 注册表。资源、Session 和 Run 的身份关系见[系统职责地图](system-ownership.md#身份与位置分开)。

Mote 的公开定位关系由同一 [`AgentMuxSpatialStateStore`](../../packages/core/src/spatial-state.ts) 在原图的 `owned:space-object-links` 元数据中持久保存；原空间锁与耐久写入同时保护定位符、完整目标 tuple 和发行 operation，不另建对象库。`space.link.ensure` 是该元数据的唯一发行入口，普通 graph commit 保留原 owned 元数据且拒绝伪造或重映射；`space.link.resolve` 只读原关系。原 `spaceId`、Zone、布局与执行资源键不因发行地址而变动。公共读取、URI 与旧输入保全规则见[对象地址、分享与方向](../design/behavior/public-control.md#对象地址分享与方向)和[对象链接 wire](../specs/amux-protocol.md#对象链接)。


## 持久化与跨进程观察

Core 状态目录中的 `spatial-state.json` 保存同一空间图；`AGENTMUX_SPATIAL_STATE_STORE` 可指定绝对路径，宿主也可注入该路径。revision 校验和跨进程锁保护并发写入；原子提交保留此前有效文档。读取损坏或不可用不能变成空图，也不授权破坏性覆盖；从保留文档恢复须明确执行。

[`defaultAgentMuxSpatialStatePath` / `AgentMuxSpatialStateStore`](../../packages/core/src/spatial-state.ts) 负责路径、读取、revision 提交、锁与订阅；原子写入沿 [`durableWriteFile`](../../packages/core/src/durable-write.ts)。

原文件解码得到当前读取所拥有的 graph，随后沿原拓扑约束验证。公开结果 codec 在既有协议解码边界执行同一验证。需要隔离调用方持有的输入时，原 parser 生成独立副本。目录查询用原 Tab、Region、Group 和绑定缩小候选，再生成名称及位置投影。查询仍按原顺序保留多个展示位置，也能读取没有展示位置的原实体。

### 原权威 Space 的公共业务投影

Core 的 `space.snapshot`／`space.watch` 以准确 `{runtimeId,spaceId}` 读取同一原文件 owner，SDK 的 `readSpaceSnapshot`／`observeSpace` 与 CLI 消费同一公共订阅端口。快照 begin／part／complete 和后续实体 delta 复用已有 Hosted 分帧、取消与背压；累计 Space 不受单个传输值预算限制，单条实体仍沿原 Hosted 编码／在途内存边界，失败只结束本次读取并保留源文档；源图 revision 是原 CAS 版本，重新连接明确给全范围快照及 cursor gap，不承诺持久事件日志。来源 Runtime 或 reader instance 不符只拒本次观察，不把原 Run 判为终局。

共享范围只含空间业务实体、成员、原 Session／Run 引用和 Zone–Space 绑定；不传显示 Workspace／Group、分割比例、选择、DOM 焦点、私有草稿或不透明 client resources。原 Core 文档的这些已有数据继续保全，公开业务订阅不接管本机窗口持久化。`space.apply` 的显式范围编辑由服务端合入当前原图，沿同一 CAS／持久写入，不能把过滤投影当整图覆盖；原名称和创建关联仍由既有 mutation owner 维护。

[`space-authority.ts`](../../packages/core/src/space-authority.ts) 定义业务投影、实体索引、delta 和范围编辑；[`space-authority-owner.ts`](../../packages/core/src/space-authority-owner.ts) 只持临时订阅读者与有界的最新待发送状态；[`space-authority-stream.ts`](../../packages/core/src/space-authority-stream.ts) 持分帧组合与 SDK 读者。每个 owner 只借一份原文件观察，按实际受影响 Space 投影并共享给相关读者。原整图文件的解码／CAS 写入仍随该文件规模增长；它没有变成全网 Store，未因网络过滤就宣称所有生产端成本按单 Space 缩减。客户端挂载和真正多跳执行是另外的实际消费，不由这组公共端口的存在代签。

## 实体图与 Desktop 投影

### 保存什么

Core 文档保存实体、全部绑定、原 Group／Region 分割树及选择。客户端资源元数据作为 JSON 保留，由原宿主解释；Core 不创建 Browser 页面、文件、PTY 或 Run。已保存布局不证明 Native surface 已挂载。

### 如何提交与合并

仅当 Core 文档不存在时，Desktop 才可导入旧 Workbench。文档一旦存在，其 revision 即为权威，旧客户端副本不能覆盖它。Desktop 经受信 preload port 读写同一文档；Core ACK 之后，偏好文件不保存第二份实体或布局快照。UI 偏好与草稿由 Desktop 宿主文件持有，具体链路见下节。

合并按实体与键进行：Tab、Region、Zone、Space、绑定与资源各自独立；展示布局再细到每个 Group，其 Tab 顺序、选择（含最近记录）与分割树各为一个键。不相交编辑保留双方增量。只有一方改动的 Tab 顺序保持该方的顺序；双方都改时，任一方关闭的 Tab 移除、新开的 Tab 保留，双方以不同方式移动同一批 Tab 才算顺序冲突。分割树取远端值时，仍被某一方展示、且没有被任何一方关闭的 Tab 回到原 Group 或活动 Group，不会掉出布局。Tab 的 Region 成员随其合并后的分割树投影，与名称一样不参与 Tab 实体的冲突判定，因此合并结果始终是 Core 接受的图。同一键被双方改成不同值时，该键保留已提交的远端值并在告示中点名；其余键照常提交，基线随提交前进，冲突不阻止后续保存，也不阻止观察其他进程的提交。客户端通过文件 owner 观察其他进程的提交。转换、保存和合并来源为 [`desktopSpatialGraph` / `desktopWorkbenchFromSpatial` / `DesktopSpatialPersistence` / `reconcileSpatialGraphs`](../../apps/desktop/src/renderer/src/lib/desktop-spatial-state.ts)。

`DesktopSpatialPersistence` 的订阅与显式刷新进入同一观察路径。读取已观察状态与已经应用到客户端的状态分别保留；准确执行事实的读取不能提前消费尚未应用的布局／分类更新，本地编辑也不能以提前读到的状态冒充原编辑基线。分类更新经同一 apply 调用 [`reconcileWorkbenchSpaceSelection`](../../apps/desktop/src/renderer/src/lib/desktop-focus-navigation.ts)，GUI 没有另外的私有选择修补。该协调只更新同一原 Zone 的分类引用，不改 `tab.space` 的原内容身份；未知关系的可见性与局部能力沿[行为合同](../design/behavior/spaces-and-layout.md#topic-导航与成员范围)。

Survey 显式组成多个 Tab 时，先完成已有编辑的 checkpoint，再由 [`planSurveyTabComposition`](../../apps/desktop/src/renderer/src/lib/survey-tab-composition.ts) 核对已消费的 Core 基线、冻结的原内容集合与准确目标；精确页面的提升也在同一个纯计划内完成。Core 的 [`composeSpatialTabs`](../../packages/core/src/spatial-tab-composition.ts) 只改变组成关系，整张图经原 Core 空间 owner 一次 CAS 提交；公共 `space.commit` 消费同一 owner，不用逐键合并拆散这次意图。后续 Survey 引用保存沿原偏好 owner 独立回执；组成已提交但引用保存未确认时，保留原请求并只修复引用，不重放移动。

DOM 内容的寿命由窗口内 [`WorkbenchRegionOwners`](../../apps/desktop/src/renderer/src/components/WorkbenchRegionOwners.tsx) 按原 Region ID 持有。Tab 的几何与槽位仍由原 Workbench 呈现，Region 的 React 内容和原展示、文档、Mote 对话上下文随槽位移动，避免换 Workspace 或提升为新 Tab 时重建未提交输入。该 owner 只保存 React 内容与局部订阅，结构仍读原 Core 投影；单个 Region 内容更新不复制全部内容记录，也不订阅无关 Session。

Topic 创建和新讨论 Tab 使用 [`originalTopicAddress`](../../apps/desktop/src/shared/space-addresses.ts) 写入原内容身份，Category 地址只用于导航。还原时，同一 Core Zone 资源中已确认的内容身份优先于客户端 Tab 描述，分类移动不改写它。带首句的创建先提交原 Launcher 工作面，再由 Host 注册该 Topic，避免客户端自己的待保存布局与注册争用同一图的 revision；失败仍保留原 Launcher 和草稿。

### 创建即确认位置与后台保存的停滞

Launcher 内创建的 Agent 由 Main 在 Core 创建回执确认后，经 [`AgentMuxSpatialStateStore.attachLauncherAgent`](../../packages/core/src/spatial-state.ts) 在同一把锁内把原 Launcher Region 改为该 Agent 的 Region，执行目录取创建出的 Session 实际所在目录，不等 Renderer 后台补存。它自行读取当前 revision，已挂好的相同 Region 不产生新 revision。Goal 讨论 Launcher 的位置由 Host 经 `commitOwnedResource` 的 `agentRegion` 与讨论绑定一起提交；两条路径共用同一条 Region 准入规则：只接受空 Launcher，或同一 Session 且 Run 与执行位置未定或相同的 Region，较新的 Run 不会被较早的创建回执改回。原 Region 已变化时只报告位置问题，不影响已创建的 Agent 与 Run。

`DesktopSpatialPersistence` 记录未确认结构首次出现的时间与最后一次确认保存。同一计时器在未确认满 15 秒时告示一次，之后后台按倍增的间隔重试（上限 2 分钟），直到确认；仍在等待的读取或提交应答超过同一时限即按回执丢失处理，下一次尝试重新读取并合并，Core 的 revision 校验保证迟到的写入不会覆盖更新的内容。停滞恢复只清除停滞自己报出的告示。`app.inspect` 的 `persistence.spatial` 报告同一事实，安装器读同一来源。停滞与其恢复经 Main 的客户端事件档案各留一条有界记录（阶段、错误码、持有的 revision、未保存时长、冲突数），不含正文或路径，重启后可读。

### Desktop 用户数据与保存回执

Desktop 的 `workbench-user-state.json` 位于同一应用 `userData` 根，由应用生命周期内唯一的 [`WorkbenchUserStateStore`](../../apps/desktop/src/main/workbench-user-state.ts) 持有。受信 preload 端口只操作这一私有文档，不向公共 RPC 暴露草稿正文或任意路径写入。Renderer 的批处理写入器保留最新用户投影，Main 沿 `durableWriteFile` 完成文件与目录同步后返回包含路径、摘要、字节数和确认时间的原写入回执。

主 Workbench 投影和固定 `desktopFragments` 共用原 Renderer root 缓存及同一批处理写入器。Renderer 解码原文档后，状态恢复和批处理直接读取这份对象的投影。片段包含 Launcher 草稿与原请求、Agent 书签、Mote 浮层偏好、头像原保存请求和全局巡查 operation 引用，不新增任意 KV 或路径接口。片段缺席才交接原来源，显式空值防止已退休的旧请求复活；损坏或读取未知时保留原字节和用户在等待期间的编辑。需要先保留原请求的业务动作显式等待准确用户文档 ACK，再沿原业务 owner 执行，不以同步 setter 接受输入代签持久保存。

首次读取只在宿主文档确认不存在时导入既有 Web Storage 字节；原子导入与普通写入共用同一宿主队列。新的宿主文档存在后只读取原文件，读取失败保留原数据。旧内容仅在准确写入确认后清理。普通读取、目录存在和相同摘要都不产生新的写入确认；历史 `lastConfirmedWrite` 与当前读取分别表达。

[`checkpointSpatialWorkbench`](../../apps/desktop/src/renderer/src/store.ts) 只捕获当前空间结构并等待原 Core 空间 owner 确认；显式汇总保存与受控退出由 `requestWorkbenchStorageFlush` 另行覆盖用户投影及各片段的待保存编辑。空间观察器与其初始化 owner 同寿命，Runtime 启动失败不撤销空间保存，旧初始化的清理也不释放新 owner。公共空间操作的 `clientStateWritten` 表示客户端用户投影写入，`diskDurability` 仍须覆盖本次空间与用户数据；字段不绑定某个浏览器 API。

Survey 的 [`createSurveyBrowser`](../../apps/desktop/src/renderer/src/lib/survey-browser-creation.ts)、[`openSystemPageInSurvey`](../../apps/desktop/src/renderer/src/lib/survey-system-page.ts) 与页面准入只暴露所需的 `Pick<AppState, …>` 能力；对 Store 的引用仅用于类型。Store 适配器复用 [`planSpatialZone`](../../apps/desktop/src/renderer/src/lib/space-agent-control.ts) 同步准备准确位置，再把原 `checkpointSpatialWorkbench` 作为显式端口注入：Launcher 框架可先显示，Native 创建仍等准确位置确认。页面准入和选中偏好由同一 `saveSurveyPreferences` 保存原用户文档，不调用会汇总 Launcher、书签等片段的通用 Zone 创建或汇总保存。原 getter 身份、页面引用数组代次、Main Browser 回执与 Core 空间身份继续由原 owner 持有。

共同数据分类、失败边界和重启验收归[用户数据与本地持久化](../design/behavior/persistence.md)。

### 缺失资源与 Host 能力

缺少 Host 资源元数据时如实报告，保 Core 身份与当前内容。资源来源和屏幕展示位置分别保留，不能用当前焦点补猜目录。空间管理复用既有 JSON-RPC 与远程传输；可移植 API 不以 OS 安装门禁判断可用性，随包 Native Runtime 的可用性是另一项 Host 能力。本页不为未验证 Host 的 Native surface 宣布完成。

### 工作面模式与局部控件

局部模式的业务选择仍由调用者持有；[`SurfaceModeSwitch`](../../apps/desktop/src/renderer/src/components/SurfaceModeSwitch.tsx) 统一原生选择和焦点机制，[`LiquidSelectionSurface`](../../apps/desktop/src/renderer/src/components/LiquidSelectionSurface.tsx) 只提供局部装饰。两者及其样式属于通用呈现，不依附设置或 Git；行为与视觉约束分别引用[统一工作面框架](../design/behavior/spaces-and-layout.md#space-的统一工作面框架)和[工作面框架的呈现](../design/presentation/spaces-and-layout.md#space-的统一工作面框架)。

## Topic／Mote 物理目录与目录身份

必须成立的结果归[Topic 与 Mote 的物理目录](../design/behavior/motes-and-coordination.md#topic-与-mote-的物理目录)；本节只说明当前机制。

- **目录根**。[`scratchTopicStorageRoots`](../../apps/host/src/mote-topic-model.ts) 从 Scratch 根派生并列的 `topics/` 与 `motes/` 根；Desktop 的 Scratch 根是 `SCRATCH_BACKING_PATH`，即 `~/.agentmux/scratch`（[config-store.ts](../../apps/desktop/src/main/config-store.ts)）。
- **Mote 短名**。[`moteDirectoryName`](../../apps/host/src/mote-directory-identity.mjs) 取完整内容 ID 的 SHA-256 前 16 位十六进制，只作目录索引，不代替完整对象 ID。
- **身份记录**。记录位于对象内的 `.agentmux/directory-identity.json`（`SCRATCH_DIRECTORY_IDENTITY_PATH`）。当前格式由 `directoryIdentityRecord` 生成：`{version: 3, topicId, identityRoot, identityDirectoryName, identityPathHash}`，其中 `identityRoot` 为 `scratch`、`topics` 或 `motes`，`identityPathHash` 是原逻辑地址的 SHA-256，记录中不写绝对路径。`verifiedRecord` 只在恰好一个候选地址与记录的根、目录名和哈希一致时确认身份；旧格式 v1（绝对路径）与 v2（目录名与路径哈希）仍可读取，但标为 `needsUpgrade`。记录无效或地址无法唯一确认时报告 `DIRECTORY_IDENTITY_INVALID`，保留原记录与内容。
- **写入与升级**。`retainDirectoryIdentity` 为新对象排他创建并同步记录。`normalizeDirectoryIdentity` 把已确认的旧记录无损重编码为 v3，经待确认见证 `.agentmux/directory-identity.pending.json` 发布并核对；发布或持久确认未知时报告 `DIRECTORY_IDENTITY_WRITE_UNKNOWN`。别名交换的待确认见证 `.agentmux/directory-identity.pending.alias` 存在时，先要求确认那次交换，不改写记录。
- **原子交换**。[`migrateTopicDirectories`](../../apps/host/src/mote-directory-maintenance.mjs) 的 `exchange` 调用原生 helper `agentmux-workspace-move --alias-swap <root> <dev> <ino> …`（`AGENTMUX_WORKSPACE_MOVE_HELPER` 可覆盖其路径），在同一卷上以不覆盖目标的一次交换保留原 inode 与完整内容，并把旧地址变为指向同一对象的别名。非 darwin 平台返回 `DIRECTORY_MIGRATION_UNSUPPORTED`，不做非原子迁移；结果无法确认、目标已存在或别名不指向原对象时，分别返回 `DIRECTORY_MIGRATION_RESULT_UNKNOWN`、`DIRECTORY_MIGRATION_TARGET_EXISTS` 与 `DIRECTORY_MIGRATION_ALIAS_INVALID`，保留原内容与交换见证。Host 的 [mote-resources.ts](../../apps/host/src/mote-resources.ts) 与 Desktop 的 [scratch-topics.ts](../../apps/desktop/src/main/scratch-topics.ts) 以 `motesOnly` 调用它。
- **解析**。[`resolveScratchTopicDirectory`](../../apps/host/src/mote-directories.ts) 在三个根中按完整目录名与 Mote 短名查找候选：短名目录必须有确认的完整内容 ID，别名必须解析到同一物理对象，出现多个物理位置时拒绝并保留全部字节，待确认的交换中间地址只在同一操作的见证一致时接受。

## 独立窗口的宿主与内容

打开整面 Survey、Recall、Tab 或 Region 都经过同一组公共窗口操作。Desktop Main 根据原目标和窗口文档代次打开、复用、归还或恢复展示。Renderer 将原工作面的 DOM 移到新 document，继续使用已有编辑器和状态。窗口生命周期见 [WorkbenchWindows](../../apps/desktop/src/main/workbench-windows.ts)，内容交接见 [StableWorkbenchView](../../apps/desktop/src/renderer/src/components/StableWorkbenchView.tsx)。

接入独立窗口时，内容通过 [useWorkbenchWindowChrome 与 useWorkbenchWindowTitle](../../apps/desktop/src/renderer/src/lib/workbench-document.tsx) 取得当前宿主、设置原生窗口名称，并在自己的顶边排入返回按钮。分割 Tab 只在左上角展示一份窗口控件。返回使用此次交接提供的窗口身份，并沿原窗口操作取得回执。原生安全区、拖动区、窄窗收纳和可点击区域按[独立窗口的呈现](../design/presentation/spaces-and-layout.md#工作面的独立窗口)处理。

## 准确选择与跨视图导航

Desktop 的 [`workbenchSpaceSelection` / `selectMainRegion` / `activateTab`](../../apps/desktop/src/renderer/src/store.ts) 持有并更新 Work 当前选择。原空间目录经 [`workbenchSelectionCatalog` / `resolveDesktopSpaceSelection` / `resolveWorkbenchOccurrenceSelection`](../../apps/desktop/src/renderer/src/lib/desktop-focus-navigation.ts) 确认对象、成员与准确 occurrence；局部选择与显式导航以原 intent 区分，不按最近 Session 或第一处展示推导目标。

Focus 的 [`mainFocusPresentation`](../../apps/desktop/src/renderer/src/lib/focus-tab-projection.ts) 消费同一选择，按原 Tab 或 Region 投影；[`mainRegionReference`](../../apps/desktop/src/renderer/src/lib/desktop-focus-navigation.ts) 从该选择派生准确引用，不成为第二个选择 owner。实体的展示通过 [`WorkbenchProjection`](../../apps/desktop/src/renderer/src/lib/workbench-projection.ts) 及原工作面组件消费；导航选择与 DOM 输入交接是不同事实。

文件打开由 Store 的 `defaultFileOpenTarget` 捕获 UI 导航上下文，显式公共请求及工作面 projection 保原目标；两条路径消费 [`resolveFileOpenTarget`](../../apps/desktop/src/renderer/src/lib/workface-file-open.ts) 的资源／空间解析。既有准确 File reference 与新建 destination 分别沿原公共机制确认，`FileOpenPlacement` 传递本次目标，`FileOpenResult` 返回实际落点；重开与 Diff 沿本次目标与结果，不全局查找文档，也不读取之后的选择来推定结果。文档数据共享仍由 [`FileWorkbenchState`](../../apps/desktop/src/renderer/src/lib/file-workbench-state.ts) 持有。局部导航只从 App owner 读取必要的遮挡状态，不以前端完整 DOM 呈现探测作为选择资格。

这里核对空间底座和既有 Work 导航接缝；Mote／Work／Know 的产品分组及 Survey／Recall 的独立导航要求归[导航上下文合同](../design/behavior/spaces-and-layout.md#worksurveyrecall-与-mote-的导航上下文)，分组本身不新增 Core 实体或自动同步器。公共服务、JSON-RPC 与 CLI 的原接线见[系统职责地图](system-ownership.md#当前执行与展示链路)，精确参数沿[公共能力源码入口](../specs/public-capabilities.md)。
