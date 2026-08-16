import type { AppConfig, SessionSnapshot } from '../../../shared/contracts'
import {
  activateTab,
  addTab,
  createWorkspaceLayout,
  findGroupForTab,
  groupIds,
  groupLeafId,
  removeTab,
  clampSplitTreeRatios,
  dedupeLeafIds,
  removeLeaf,
  closeWorkbenchRegion,
  regionIds,
  regionLeafId,
  type WorkspaceLayout
} from '@agentmux/layout'
import {
  removeWorkbenchRegion,
  workbenchSurfaces,
  type AgentWorkbenchSurface,
  type BrowserWorkbenchSurface,
  type FileWorkbenchSurface,
  type LauncherWorkbenchSurface,
  type TerminalWorkbenchSurface,
  type WorkbenchSurface,
  type WorkbenchTab
} from './workbench-tabs'
import { assertUnreachableSurface, isSessionSurface } from './workbench-surface-kinds'
import { workspaceOwnsSessionPath } from '../../../shared/scratch-topics'

/**
 * 一个 browser 面**存到盘上的**最小可再实例化子集。只有这几位：browserId + url（+ title 供加载完成前
 * 先画个标签）。整个活体 `BrowserSnapshot` 的其余字段（navigationId/loading/canGoBack/canGoForward/
 * driving/appLinkPrompt/profileId/viewport/error/id）都是**每次运行**的瞬时事实，不进盘——它们由冷启动
 * 重建 WebContentsView 那一刻的真快照补回（见 store 启动路径的 browser 复活循环 + `reduceBrowserEvent`）。
 *
 * 为什么是这个形状而不是整面剥离：旧决定「browser 面整面剥离」的顾虑本身是对的——硬存整个活体结构
 * 会 ship 一个没有后端 WebContentsView 的死面板。但被推翻的不是顾虑，而是它的**前提**「没有一条能把
 * 持久 browser 复活成可用页的生命周期」。现在补上了 store 启动路径的 `api.browser.create` 接缝，那个
 * 前提不再成立，于是用户的显式决定「存完整 URL、恢复到原页」得以落地。浏览历史这一档敏感度按用户
 * 决定接受（与逐字持久化的 file path 同一档：collapsedProjectGroups/pinnedItems 也都存目录路径）。
 */
export type PersistedBrowserSurface = {
  regionId: string
  kind: 'browser'
  workspaceId: string
  browserId: string
  url: string
  title: string
}

/** 存盘形态的 Region：只有 browser 与活体不同（缩成 {@link PersistedBrowserSurface}），其余原样。 */
export type PersistedWorkbenchSurface =
  | AgentWorkbenchSurface
  | TerminalWorkbenchSurface
  | FileWorkbenchSurface
  | LauncherWorkbenchSurface
  | PersistedBrowserSurface

export type PersistedWorkbenchTab = Omit<WorkbenchTab, 'regions'> & {
  regions: Record<string, PersistedWorkbenchSurface>
}

export type PersistedWorkbench = {
  tabs: Record<string, PersistedWorkbenchTab>
  layouts: Record<string, WorkspaceLayout>
}

/**
 * 载入路径的产物：与存盘形态同构，但 browser 面是**活体** surface（`hydratePersistedBrowserSurface`
 * 补齐了瞬时位的默认值）。它直接灌进 `state.tabs`（都是活体 `WorkbenchTab`），冷启动的 browser 复活
 * 循环随后为每个 browser 面 `api.browser.create` 出真 WebContentsView，用真快照覆盖那些默认位。
 */
export type RestoredWorkbench = {
  tabs: Record<string, WorkbenchTab>
  layouts: Record<string, WorkspaceLayout>
}

/** 把一个存盘 browser 复活成活体 surface：url/title/browserId 保留，其余瞬时位填默认，等待真快照覆盖。 */
function hydratePersistedBrowserSurface(surface: PersistedBrowserSurface): BrowserWorkbenchSurface {
  return {
    regionId: surface.regionId,
    kind: 'browser',
    workspaceId: surface.workspaceId,
    browserId: surface.browserId,
    id: surface.browserId,
    url: surface.url,
    title: surface.title,
    // 瞬时位：由 store 启动路径 create 出真 WebContentsView 后的快照经 applyBrowserEvent 覆盖。
    navigationId: '',
    profileId: '',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    viewport: 'responsive',
    error: null,
    driving: false,
    appLinkPrompt: null
  }
}

/** 存盘时把一个 browser 活体 surface 缩成最小可再实例化子集，剥掉全部瞬时/敏感运行时位。 */
function reduceBrowserSurfaceForPersistence(surface: BrowserWorkbenchSurface): PersistedBrowserSurface {
  return {
    regionId: surface.regionId,
    kind: 'browser',
    workspaceId: surface.workspaceId,
    browserId: surface.browserId,
    url: surface.url,
    title: surface.title
  }
}

/** 一整张存盘 Tab 的 browser 面全部复活成活体，其余 Region 原样。载入路径在 reconcile 之前调它。 */
export function hydratePersistedTab(tab: PersistedWorkbenchTab): WorkbenchTab {
  return {
    ...tab,
    regions: Object.fromEntries(
      Object.entries(tab.regions).map(([regionId, surface]) => [
        regionId,
        surface.kind === 'browser' ? hydratePersistedBrowserSurface(surface) : surface
      ])
    )
  }
}

/** 一整张活体 Tab 的 browser 面全部缩成存盘子集，其余 Region 原样。存盘路径在投影之后调它。 */
function reducePersistedTab(tab: WorkbenchTab): PersistedWorkbenchTab {
  return {
    ...tab,
    regions: Object.fromEntries(
      Object.entries(tab.regions).map(([regionId, surface]) => [
        regionId,
        surface.kind === 'browser' ? reduceBrowserSurfaceForPersistence(surface) : surface
      ])
    )
  }
}

/**
 * 一张持久化 Tab 上「树 ↔ regions 表」不一致的抢救结果。空数组/false 表示那一类没发生。
 */
export type PersistedTabRepair = {
  tabId: string
  /** regions 表里有、树里没有的死记录（永远画不到，也永远回收不掉）。 */
  droppedGhostRegionIds: string[]
  /** 树里有、regions 表里没有的孤儿叶（画成 null，看不见也关不掉）。 */
  droppedOrphanLeafIds: string[]
  /**
   * 同一个 regionId 在树里出现多次时，被摘掉的那些重复片（保留读序首片）。
   *
   * 与上面两类分开记，因为**失败面不同**：孤儿/死记录是「两侧对不上」，而重复叶违反的是 removeLeaf
   * 写明的前置条件「叶子 id 在一棵树内唯一」，且它对两个集合判据（Set 差集）完全隐身——`[r1,r1]` 配
   * `{r1}` 的 ghosts 与 orphans 都是空，会从早退那条路原样交出去，然后被 `assertRegionInvariant` 的
   * 排序逐元素判据抓住并抛出。合并成一类会让「修了什么」说不清楚。
   */
  droppedDuplicateLeafIds: string[]
  /** 两侧毫无交集 → 这张 Tab 整体不可救，只能丢弃。 */
  discardedTab: boolean
}

/**
 * 一张**持久化读回来的** Tab 的无条件归一化：树里每个 `ratio` 夹回今天的界，焦点与标题格落回树上。
 *
 * 与下面的 {@link reconcilePersistedTab} 分工明确：那一个修的是「树 ↔ regions 表」这条**结构**不变量，
 * 只在真的漂移时动手并产出一条用户可见的抢救记录；本函数修的是**取值**——不产 repair、不告知用户，
 * 因为它修的东西对用户不构成损失（一个越界的比例、一个指向空处的焦点），说出来只是噪音。
 *
 * 为什么必须无条件：这两件事此前都搭在结构抢救的车上，而结构抢救开头就有一处早退
 * （`ghosts.length === 0 && orphans.length === 0`）。于是一张**结构完全干净**的持久化 Tab
 * 整批跳过归一化——实测四条路径全中（region 树与 tab-group 树各有 ratio 与指针两件）。两类失败面：
 *   - `ratio`：盘上的比例是**旧版本的代码**写的，那时 region 树的下界是 0.1（见 split-tree.ts :23-28
 *     记的那次收敛）。0.12 当年合法、今天越界，模型存 12% 而视图只画到 15%，拖一次分隔条就有一帧
 *     跳动加一次多余写入。
 *   - 指针：`activeRegionId` 指向一个树里没有的格时，界面拿它去 `regions` 表里取会得到 undefined。
 *     这条重座逻辑本就存在，只是站在早退后面——所以它对「结构干净但焦点陈旧」这一形状从不执行。
 *
 * 引用稳定（干净的 Tab 原样返回同一个对象）只是省一次分配：本函数也跑在 zustand 的 `partialize` 上，
 * 即每一次写入，而绝大多数写入的记录本就干净。**它不是一个可依赖的合同**——今天没有任何消费者
 * 按引用比较这张 Tab（`partialize` 的产物直接序列化进 localStorage），所以别让后来人以为「引用变了」
 * 本身就是回归。见 `clampSplitTreeRatios` 的同一段说明。
 */
function normalizePersistedTab(tab: WorkbenchTab): WorkbenchTab {
  const root = clampSplitTreeRatios(tab.layout.root)
  const live = regionIds(root)
  // 兜底取读序首格。`live[0]!` 的依据不是上游抢救过，而是**树的形状本身**：`SplitTreeNode` 的基例
  // 就是叶子，`regionIds` 对任何合法节点都至少产出一个 id（见 workbench-view-layout.ts:37-41），
  // 所以这里恒有得选。写清这条是因为「上游保证了交集非空」听起来也像个理由，但那说的是另一个集合
  // （树 ∩ regions 表），而这一行取的是树自己的 id。
  const activeRegionId = live.includes(tab.layout.activeRegionId) ? tab.layout.activeRegionId : live[0]!
  const titleRegionId = live.includes(tab.titleRegionId) ? tab.titleRegionId : activeRegionId
  if (
    root === tab.layout.root &&
    activeRegionId === tab.layout.activeRegionId &&
    titleRegionId === tab.titleRegionId
  ) return tab
  return { ...tab, layout: { ...tab.layout, root, activeRegionId }, titleRegionId }
}

/**
 * 一个工作区的 tab-group 布局的同一件事：树里每个 `ratio` 夹回今天的界，`activeGroupId` 落回在场的分组。
 *
 * 两棵树是同一个分屏树（见 split-tree.ts），所以这两条毛病也是同一对。分开写而不是泛型化整个函数：
 * 两边的「指针」字段名与在场判据不同——region 的焦点判据是「在树里」，而 tab-group 的消费者读的是
 * `groups` 表（`layout.groups.find(...)` 那一族），所以判据必须是**两侧都认**：一个只在树里、不在
 * `groups` 表里的 id 交出去，下游取分组会得到 undefined；只在表里、不在树里的交出去，`addTabPlacement`
 * 会把 Tab 挂到一个画不出来的分组上（workbench-layout.ts:350-352 描述的孤儿形状）。
 * 共享的那一半（ratio 的夹取）走的是同一个 `clampSplitTreeRatios`，没有第二份实现。
 *
 * 交集为空时保持原值不动：那是「树 ↔ groups 表」漂移，不是本函数的职责，而**编一个不存在的 id
 * 交出去比留着陈旧值更坏**——后者至少还能被识别成陈旧。
 */
function normalizePersistedLayout(layout: WorkspaceLayout): WorkspaceLayout {
  const root = clampSplitTreeRatios(layout.root)
  const seated = groupIds(root).filter((id) => layout.groups.some((group) => group.id === id))
  const activeGroupId = seated.includes(layout.activeGroupId)
    ? layout.activeGroupId
    : seated[0] ?? layout.activeGroupId
  if (root === layout.root && activeGroupId === layout.activeGroupId) return layout
  return { ...layout, root, activeGroupId }
}

/**
 * 把一个**持久化读回来的** workspace 布局的「tab-group 树 ↔ `groups` 数组」拉回一致，绝不抛出。
 *
 * 这是 {@link reconcilePersistedTab} 在工作区这一层的对偶，两者存在的理由逐字相同：
 * `assertGroupInvariant`（workbench-layout.ts）是无条件 throw 的生产断言，而 `removeTab` 在
 * **两个持久化入口**上都会被调用（`keepTabsInLayout`，见其两个调用点）。localStorage 里的内容是
 * 用户数据，那道断言是本轮才装上的，所以磁盘上完全可能已经躺着一个漂移的布局。
 *
 * 实测过的爆法（探针；不是推理）——树 `[main | main-2]`、`groups` 多一条 off-tree 的 `floating`：
 *   - `projectPersistedWorkbench`（zustand `partialize`，**每次写入都跑**）：`keepTabsInLayout` 把
 *     `main-2` 的最后一张 Tab 摘掉 → `removeTab` 走收组出口 → 尾部断言看到 `floating` 记录没有对应
 *     叶子，抛。抛在 `set()` 里，于是**任意一次用户操作变成崩溃，且此后再也写不进去**。
 *   - 同一形状经 `restorePersistedWorkbench`（启动恢复）同样抛 → 整个 Workbench 落回空白。
 * 注意漂移**不必**是持久化数据自己带来的：`removeTab` 那条 within-record 出口**刻意容忍**入场时
 * 就在的 off-tree group（见 workbench-layout.ts:407-411），所以一个今天合法的运行时状态存下来，
 * 下一次写入就可能在另一个分组上触发收组、连带炸掉。这是本修复要堵的那条缝。
 *
 * 取「树 ∩ 记录」，与 region 侧同一条理由：两个方向的多余项在界面上**都不可达**（记录多出来的是
 * 画不到也关不掉的死分组，树上多出来的叶子 `findGroup` 取不到、画成一只永远空的破格），所以
 * 「只留两侧都认的」是唯一在用户可见效果上无损的答案。
 *
 * **交集为空时不动手**，与 `normalizePersistedLayout` 的同款判断一致：那意味着这个工作区没有一个
 * 可画的分组，而**编一棵树出来比留着可识别的坏数据更坏**。这一条不像 region 侧那样能整张丢弃——
 * 工作区布局不是可丢弃的单元，下游 `restorePersistedWorkbench` 对缺失布局有 `createWorkspaceLayout`
 * 兜底，而对一个**半真半假**的布局没有。留着原样让它继续被识别成漂移。
 *
 * 不产 repair 记录：与 region 侧那半不同，这里摘掉的东西对用户不构成可感知的损失——死分组本来就
 * 画不出来，孤儿叶本来就是空格。告知用户「修好了一个你从来看不见的东西」只是噪音。
 */
function reconcilePersistedLayout(layout: WorkspaceLayout): WorkspaceLayout {
  // 与 region 侧同一条理由（见 reconcilePersistedTab 顶部）：下面两个判据都是 `Set`，对重复完全失明。
  // 两条重复轴都要在取集合**之前**收掉，否则收紧后的 `assertGroupInvariant`（排序逐元素 + 比长度）
  // 会在持久化路径上抛，而那正是本函数存在的理由。
  //
  //   1. **重复叶**：树里同一个 groupId 两片。
  //   2. **重复记录**：`layout.groups` 是**数组**（region 侧的 `tab.regions` 是对象，一个 id 只存得下
  //      一条，所以这条轴那边根本不存在）。`[g1]` 配 `[g1, g1]` 两个方向的 `Set` 差都是空，早退原样
  //      交出去，而收紧后的判据比长度 → 抛。
  //
  // 两条都按「保留第一次出现」：树侧是 `collectLeafIds` 的读序（见 dedupeLeafIds 的说明），记录侧是
  // 数组顺序——同一个 id 的两条记录可能带着不同的 tabOrder/activeTabId，而「哪条是真的」在数据里没有
  // 答案，取先出现的那条与树侧同规矩。
  const root0 = dedupeLeafIds(layout.root, groupLeafId)
  const groups0 = layout.groups.filter(
    (group, index) => layout.groups.findIndex((other) => other.id === group.id) === index
  )
  const tree = groupIds(root0)
  const treeSet = new Set(tree)
  const recordSet = new Set(groups0.map((group) => group.id))
  const orphanLeafIds = tree.filter((id) => !recordSet.has(id))
  const ghostRecordIds = groups0.filter((group) => !treeSet.has(group.id)).map((g) => g.id)
  if (
    root0 === layout.root &&
    groups0.length === layout.groups.length &&
    orphanLeafIds.length === 0 &&
    ghostRecordIds.length === 0
  ) {
    return layout
  }

  const kept = tree.filter((id) => recordSet.has(id))
  // 一个可画的分组都不剩：不编树，原样交出去（见 JSDoc 末段）。
  if (kept.length === 0) return layout

  // 逐个摘掉孤儿叶。`kept` 非空保证 `removeLeaf` 每次都还留得下至少一片叶子，故它恒不返回 null；
  // `?? root` 是给类型的，不是给一条可达路径的。
  let root = root0
  for (const orphanId of orphanLeafIds) root = removeLeaf(root, groupLeafId, orphanId) ?? root
  const groups = groups0.filter((group) => !ghostRecordIds.includes(group.id))
  // `activeGroupId` 原样带走，**刻意不在这里重座**：那件事恰好只有一个正确答案，而它已经有主了。
  // 两个调用点都是 `normalizePersistedLayout(keepTabsInLayout(...))`（:362 与 :487），那一处按
  // 「树 ∩ groups」重座，而本函数刚把两侧拉成同一个集合，所以它算出的答案与这里能算的逐点相同；
  // 中间夹的 `removeTab` 也不会让它失效——收组出口自己就重写 `activeGroupId`
  // （workbench-layout.ts:418），且它绝不摘掉最后一片叶，故那次重座恒有得选。
  // 这里再算一遍只会得到第二个「碰巧一致」的判定点：实测把这一行改成原样带走，15 条全绿——
  // 那不是缺测试，是这个决定在此处不可观测（见 removeTab 出口那条断言只判集合、不判指针）。
  return { root, groups, activeGroupId: layout.activeGroupId }
}

/**
 * 一张**持久化读回来的** Tab 的两种 Region 表示强行拉回一致，绝不抛出。
 *
 * 为什么这一步必须存在：`assertRegionInvariant`（workbench-tabs.ts）是无条件 throw 的生产断言，
 * 而 `removeWorkbenchRegion` 在两个持久化入口上都会被调用（`sessionOnlyTab` 与 `restoreTab`）。
 * localStorage 里的内容是**用户数据**：这道断言是本轮才装上的，此前发货的版本没有任何 reducer 守着
 * 这条不变量，所以磁盘上完全可能已经躺着一张漂移的 Tab。若不先抢救，那条断言会在
 *   - `restorePersistedWorkbench`（启动恢复）→ 启动路径抛出，整个 Workbench 落回空白；
 *   - `projectPersistedWorkbench`（zustand `partialize`，**每次写入都跑**）→ 在 `set()` 里抛出，
 *     把任意一次用户操作变成崩溃，且此后再也写不进去。
 * 两条都实测抛过（探针：树 [r1]、表 [r1,r2]，两个入口同一条消息）。**修法必须落在边界上，
 * 不能把断言削成 dev-only**——削掉它就等于把守卫从唯一真正需要它的环境（生产）里拿走。
 *
 * 取交集，不取任何一侧为准：两个方向的多余项在界面上**都不可达**（表里的死记录画不到、树里的孤儿叶
 * 画成 null），所以「只留两侧都认的」是唯一在用户可见效果上无损的答案。交集为空则这张 Tab 没有一格
 * 可画，整张丢弃。
 *
 * 这不是兼容层：它不认识任何版本号，也不随版本增长；它修的是一条**恒定**的结构不变量，
 * 而该不变量今后由生产断言在每个变更点就地守住。响亮性由两处提供——启动恢复把抢救结果汇报成可见告警
 * （见 `restorePersistedWorkbench` 的 `repairs`），以及 reducer 侧那条无条件断言在**改动发生的那一处**
 * 立刻炸掉。写入路径（partialize）刻意只抢救不抛：在那里抛会把持久化写入本身变成崩溃。
 */
function reconcilePersistedTab(
  tab: WorkbenchTab
): { tab: WorkbenchTab | null; repair: PersistedTabRepair | null } {
  // 去重必须排在**取集合之前**：下面两个判据都是 `Set`，而 `Set` 对重复完全失明——`[r1, r1]` 配
  // `{r1}` 的 ghosts 与 orphans 都是空，会从下一行的早退原样交出去，然后被 `assertRegionInvariant`
  // 的排序逐元素判据抓住并抛出（那条判据同时比长度，所以它认得出重复；group 侧的 Set 差集认不出）。
  // 实测过：这张 Tab 在 `projectPersistedWorkbench`（partialize）与 `restorePersistedWorkbench`
  // 两个入口都抛，前者意味着任意一次用户操作变成崩溃且此后再也写不进去。
  const deduped = dedupeLeafIds(tab.layout.root, regionLeafId)
  const duplicates = deduped === tab.layout.root
    ? []
    : regionIds(tab.layout.root).filter((id, index, all) => all.indexOf(id) !== index)
  const layoutRoot = deduped
  const tree = regionIds(layoutRoot)
  const treeIds = new Set(tree)
  const mapIds = new Set(Object.keys(tab.regions))
  const ghosts = [...mapIds].filter((id) => !treeIds.has(id))
  const orphans = tree.filter((id) => !mapIds.has(id))
  if (ghosts.length === 0 && orphans.length === 0 && duplicates.length === 0) {
    return { tab, repair: null }
  }

  const kept = tree.filter((id) => mapIds.has(id))
  if (kept.length === 0) {
    return {
      tab: null,
      repair: {
        tabId: tab.id,
        droppedGhostRegionIds: ghosts,
        droppedOrphanLeafIds: orphans,
        droppedDuplicateLeafIds: duplicates,
        discardedTab: true
      }
    }
  }

  // 逐个摘掉孤儿叶。`closeWorkbenchRegion` 在只剩一叶时拒绝动手，而 kept 非空保证了每次摘除都还有
  // 至少一片留存叶，故每一步都能落地；它同时负责把落在被摘叶上的焦点交给兄弟。
  let layout = { ...tab.layout, root: layoutRoot }
  for (const orphanId of orphans) layout = closeWorkbenchRegion(layout, orphanId)
  const regions = Object.fromEntries(
    Object.entries(tab.regions).filter(([regionId]) => !ghosts.includes(regionId))
  )
  // 焦点与标题格必须落在留存集合上。activeRegionId 由 closeWorkbenchRegion 维护，但持久化数据也可能
  // 一开始就指向一个树里根本没有的格，所以这里不假设、直接兜到读序首格。
  const remaining = regionIds(layout.root)
  const activeRegionId = remaining.includes(layout.activeRegionId)
    ? layout.activeRegionId
    : remaining[0]!
  return {
    tab: {
      ...tab,
      layout: { ...layout, activeRegionId },
      titleRegionId: remaining.includes(tab.titleRegionId) ? tab.titleRegionId : activeRegionId,
      regions
    },
    repair: {
      tabId: tab.id,
      droppedGhostRegionIds: ghosts,
      droppedOrphanLeafIds: orphans,
      droppedDuplicateLeafIds: duplicates,
      discardedTab: false
    }
  }
}

/** 抢救结果的用户向措辞。只在真的动过东西时产出一句。 */
export function describePersistedTabRepairs(repairs: readonly PersistedTabRepair[]): string | null {
  if (repairs.length === 0) return null
  const discarded = repairs.filter((repair) => repair.discardedTab).length
  const trimmed = repairs.length - discarded
  const parts = [
    ...(discarded > 0 ? [`${discarded} unusable tab${discarded === 1 ? '' : 's'} discarded`] : []),
    ...(trimmed > 0 ? [`${trimmed} tab${trimmed === 1 ? '' : 's'} repaired`] : [])
  ]
  return `Saved layout contained inconsistent split panes: ${parts.join(', ')}.`
}

/**
 * Every attached-session identity the persisted Workbench still names — Agent AND Terminal.
 *
 * This drives the startup empty-snapshot fail-open guard (store `initialize`): "an empty Runtime
 * snapshot cannot distinguish 'no Sessions' from a not-yet-ready/mis-rooted Runtime, so keep the
 * persisted Regions until a canonical snapshot confirms or retires them." That property is identical
 * for both session kinds; scoping this to `kind === 'agent'` was an omission, not a decision, and it
 * made the guard SILENTLY VANISH on a pure-Terminal layout (`.size` was 0, so `.size > 0` never
 * fired) — a saved Terminal only survived a transient empty snapshot when it happened to share a Tab
 * with an Agent that kept the guard alive. `sessionSurface` is the SSOT phase+kind predicate, so a
 * future session-bearing kind is enrolled here once instead of being dropped by another copy.
 *
 * The recovery-candidate filter also reads this set, and stays correct: recovery candidates are only
 * Agents, and a Terminal's id is its `run.runId`, which never equals an `agentSessionId`.
 */
export function persistedSessionSurfaceIds(
  persisted: PersistedWorkbench | null
): Set<string> {
  return new Set(persisted ? Object.values(persisted.tabs).flatMap((tab) => (
    workbenchSurfaces(hydratePersistedTab(tab)).flatMap((surface) => (
      sessionSurface(surface) ? [surface.sessionId] : []
    ))
  )) : [])
}

type SessionWorkbenchSurface = AgentWorkbenchSurface | TerminalWorkbenchSurface

function sessionSurface(surface: WorkbenchSurface): surface is SessionWorkbenchSurface {
  // `isSessionSurface` is the SSOT for "agent-or-terminal"; the phase gate stays here because only an
  // ATTACHED view carries a stable identity worth persisting/restoring. Keeping the kind half in one
  // place means a future session-bearing kind is enrolled once (in `isSessionSurface`) rather than
  // being silently excluded by this copy.
  return isSessionSurface(surface) && surface.phase === 'attached'
}

/**
 * Does a NON-attached-session surface survive the persistence round-trip? This is the one decision
 * that used to be a silent fall-through: a kind absent from the keep-list was dropped, so a new
 * surface kind would be lost across restart with nothing going red. The switch is exhaustive via
 * `assertUnreachableSurface`, so a 6th kind cannot compile until someone decides — here, in one place
 * — whether it survives. A `Record<kind, boolean>` would not fit: `file` and `launcher` are not
 * constant, they depend on `fileSurvives`/`hasTopic`, and the launching-session leak below needs a
 * real case, not a table cell.
 *
 * Note the `agent`/`terminal` case: `sessionSurface` is a kind-based predicate whose body also gates
 * on phase, so a LAUNCHING agent/terminal fails it and reaches this classifier even though the caller
 * has narrowed the static type to file|launcher|browser. Taking the full `WorkbenchSurface` here (not
 * the narrowed remainder) makes that runtime leak an explicit, handled case instead of an
 * `assertUnreachableSurface` throw — a launching view has no run to keep, so it is dropped, exactly as
 * before this was made exhaustive.
 */
function persistedSurfaceSurvives(
  surface: WorkbenchSurface,
  ctx: { hasTopic: boolean; fileSurvives: (surface: FileWorkbenchSurface) => boolean }
): boolean {
  switch (surface.kind) {
    case 'agent':
    case 'terminal':
      return false
    case 'launcher':
      return ctx.hasTopic
    case 'file':
      return ctx.fileSurvives(surface)
    case 'browser':
      // browser 面活过重启（用户显式决定「存完整 URL、恢复到原页」，推翻了旧的「整面剥离」）。
      // 旧决定的顾虑本身是对的——硬存整个活体 `BrowserSnapshot`（navigationId/loading/driving… 全是
      // 瞬时运行时位）会 ship 一个没有后端 WebContentsView 的死面板。被推翻的不是那个顾虑，而是它的
      // **前提**「冷启动没有一条能把持久 browser 复活成可用页的生命周期」：现在 store 启动路径补上了
      // `api.browser.create` 接缝（见其 browser 复活循环），前提不再成立。故这里放行 browser 面，但
      // 存盘只留最小可再实例化子集（`reduceBrowserSurfaceForPersistence`：browserId+url+title），瞬时/
      // 敏感位一律不进盘。浏览历史这一档敏感度按用户决定接受，与逐字持久化的 file path 同一档。
      // create 失败不留死壳：那条由 store 复活循环删 Region + 报错兜住（旧顾虑在那里被真正回答）。
      return true
    default:
      return assertUnreachableSurface(surface)
  }
}

function sessionOnlyTab(tab: WorkbenchTab): WorkbenchTab | null {
  let next: WorkbenchTab | null = tab
  for (const surface of workbenchSurfaces(tab)) {
    if (sessionSurface(surface)) continue
    // 文件面必须活过重启——它就是用户报的「重启后 tab 和分屏没了」的一半：一个纯 file tab 曾被整面剥成
    // 0 面（整 tab 消失），agent+file 分屏曾塌成单面。file 面本身只有 {regionId,kind,workspaceId,path}，
    // 没有运行时内容可剥，且 tab id 本就是 `file:${workspaceId}:${path}`——存 file 面与存路径是同一件事，
    // 分不开。path 原样保留（相对存相对、绝对存绝对，不 normalize/重写）。谁若日后以「过时的直接删」为由
    // 把下面这条 file→存 一并删掉，就会原样重犯这个 bug——这个机制不是冗余，删它=回归。
    if (persistedSurfaceSurvives(surface, { hasTopic: Boolean(tab.topicId), fileSurvives: () => true })) {
      continue
    }
    next = next ? removeWorkbenchRegion(next, surface.regionId) : null
  }
  return next
}

/**
 * 从一个持久化布局里摘掉不再在场的 Tab。
 *
 * `reconcilePersistedLayout` 必须排在 `removeTab` **之前**（两个调用点都是）：`removeTab` 尾部那条
 * 无条件断言对一个已漂移的布局会抛，而抢救本身不调任何带断言的 reducer。反序等于让断言先炸。
 */
function keepTabsInLayout(
  layout: WorkspaceLayout,
  tabIds: ReadonlySet<string>
): WorkspaceLayout {
  let next = reconcilePersistedLayout(layout)
  for (const group of next.groups) {
    for (const tabId of group.tabOrder) {
      if (!tabIds.has(tabId)) next = removeTab(next, group.id, tabId)
    }
  }
  return next
}

function addTabWithoutStealingFocus(
  layout: WorkspaceLayout,
  groupId: string,
  tabId: string
): WorkspaceLayout {
  const activeTabId = layout.groups.find((group) => group.id === groupId)?.activeTabId
  const next = addTab(layout, groupId, tabId)
  return activeTabId ? activateTab(next, groupId, activeTabId) : next
}

export function projectPersistedWorkbench(input: PersistedWorkbench): PersistedWorkbench {
  const tabs = Object.fromEntries(
    Object.values(input.tabs).flatMap((persistedTab) => {
      // 存盘路径也先复活成活体：本函数的两个调用方喂进来的形态不同——`partialize` 喂的是活体
      // `state.tabs`（对它 hydrate 是恒等），启动侧的 re-project（如有）喂的是存盘子集。统一 hydrate 一次，
      // 下面的抢救/投影就只面对活体形态。抢救与投影后再 reduce 回存盘子集（剥掉 browser 瞬时/敏感位）。
      const tab = hydratePersistedTab(persistedTab)
      // 先抢救再投影：`sessionOnlyTab` 会调 `removeWorkbenchRegion`，而它尾部那条无条件断言
      // 对一张已漂移的 Tab 会抛——这里是 zustand 的 `partialize`，抛出即让**每一次写入**变成崩溃。
      const reconciled = reconcilePersistedTab(tab).tab
      const projected = reconciled ? sessionOnlyTab(normalizePersistedTab(reconciled)) : null
      return projected ? [[projected.id, reducePersistedTab(projected)]] : []
    })
  )
  const tabIds = new Set(Object.keys(tabs))
  const layouts = Object.fromEntries(
    Object.entries(input.layouts).map(([workspaceId, layout]) => [
      workspaceId,
      normalizePersistedLayout(keepTabsInLayout(layout, tabIds))
    ])
  )
  return { tabs, layouts }
}

function sessionBelongsToWorkspace(
  config: AppConfig,
  session: SessionSnapshot,
  workspaceId: string
): boolean {
  const workspace = config.workspaces.find((candidate) => candidate.id === workspaceId)
  return Boolean(
    workspace && workspaceOwnsSessionPath(workspace, session)
  )
}

function restoreTab(
  config: AppConfig,
  sessions: ReadonlyMap<string, SessionSnapshot>,
  tab: WorkbenchTab,
  preserveUnknownSessionViews = false
): WorkbenchTab | null {
  let next: WorkbenchTab | null = tab
  for (const surface of workbenchSurfaces(tab)) {
    if (!sessionSurface(surface)) {
      // 一个文件面在其 workspace 仍被配置时生还，原样保留（含 path）。文件是否还在磁盘上不在这里判：
      // 本函数是纯 presentation 投影，无磁盘/无 IPC——stat 会把同步启动恢复变成异步，且新增一个与 Core/
      // 主进程并存的文件存在性真相源（违反 SSOT）。
      //
      // 代价是这里交出一个没有文档的面，所以必须有人在它上屏时把文档装上，否则 tab 在、点开报「不可用」
      // ——看起来像文件坏了。那个人是 `EditorPane`：它缺文档就调 `attachPersistedFileDocument`
      // （store 侧 `loadPersistedFileDocument` → `reduceDocumentAttached`）。「文件已删」也在那条路上
      // 惰性表达（`reduceDocumentLoadFailed` 记 `documentIssues.deleted`），与「打开着的文件被删」
      // 同一条既有失败态。**留下这一行而不接那个加载入口，等于把一个整 tab 消失的 bug 换成一个更难
      // 诊断的 bug。**
      //
      // 关键：这里绝不能退回旧的 `return null`——那会把整 tab 连同存活的 agent 面一起毙掉（正是用户报的
      // 「分屏没了」）。越界面只删该 Region，让 removeWorkbenchRegion 走与 session 面完全同一条收敛出口。
      // survive 判据经 `persistedSurfaceSurvives`（同一张 SSOT 表），file 面额外要求其 workspace 仍在配置里。
      if (
        persistedSurfaceSurvives(surface, {
          hasTopic: Boolean(tab.topicId),
          fileSurvives: (file) =>
            config.workspaces.some((workspace) => workspace.id === file.workspaceId)
        })
      ) continue
      next = next ? removeWorkbenchRegion(next, surface.regionId) : null
      continue
    }
    const session = sessions.get(surface.sessionId)
    // A Runtime snapshot can be temporarily unavailable while the persisted presentation is still
    // perfectly usable. Keep the exact Region identity in that narrow fail-open state; Core remains
    // the owner of whether the Session/Run exists and SessionPane will show its neutral connecting
    // state until a later canonical snapshot arrives. Never apply this to a successful snapshot: a
    // known missing or mismatched Session must still be removed by the normal verified restore path.
    if (
      preserveUnknownSessionViews &&
      !session &&
      config.workspaces.some((workspace) => workspace.id === tab.workspaceId) &&
      surface.workspaceId === tab.workspaceId
    ) continue
    if (
      session?.kind === surface.kind &&
      sessionBelongsToWorkspace(config, session, tab.workspaceId)
    ) continue
    next = next ? removeWorkbenchRegion(next, surface.regionId) : null
  }
  return next
}

export function restorePersistedWorkbench(input: {
  config: AppConfig
  sessions: readonly SessionSnapshot[]
  persisted: PersistedWorkbench | null
  createTabGroupId(): string
  /**
   * Keep session Regions whose identities could not be checked because the Runtime snapshot failed.
   * This is a one-shot presentation projection, not a second Session truth source; callers should
   * set it only for an explicitly rejected snapshot and let the next canonical snapshot reconcile it.
   */
  preserveUnknownSessionViews?: boolean
}): RestoredWorkbench & { repairs: PersistedTabRepair[] } {
  if (!input.persisted) {
    return {
      tabs: {},
      layouts: Object.fromEntries(input.config.workspaces.map((workspace) => [
        workspace.id,
        createWorkspaceLayout(input.createTabGroupId())
      ])),
      repairs: []
    }
  }

  const sessions = new Map(input.sessions.map((session) => [session.id, session]))
  const repairs: PersistedTabRepair[] = []
  const tabs = Object.fromEntries(
    Object.values(input.persisted.tabs).flatMap((persistedTab) => {
      // 先把存盘 browser 面复活成活体（补齐瞬时位默认值），再进抢救/恢复——这两步都在活体形态上
      // 判 kind 与调 removeWorkbenchRegion。真正的 WebContentsView 由 store 启动路径的复活循环建。
      const tab = hydratePersistedTab(persistedTab)
      // 抢救先于恢复：`restoreTab` 会调 `removeWorkbenchRegion`，其尾部无条件断言对一张已漂移的
      // Tab 会抛，而这里在启动路径上——抛出即整个 Workbench 落回空白（正是 #59/#60 那个 bug 的形状）。
      const { tab: reconciled, repair } = reconcilePersistedTab(tab)
      if (repair) repairs.push(repair)
      const restored = reconciled
        ? restoreTab(
            input.config,
            sessions,
            reconciled,
            input.preserveUnknownSessionViews === true
          )
        : null
      const normalized = restored ? normalizePersistedTab(restored) : null
      return normalized ? [[normalized.id, normalized]] : []
    })
  )
  const layouts: Record<string, WorkspaceLayout> = {}
  for (const workspace of input.config.workspaces) {
    const workspaceTabIds = new Set(
      Object.values(tabs)
        .filter((tab) => tab.workspaceId === workspace.id)
        .map((tab) => tab.id)
    )
    // 归一化排在补挂之前，不是之后：下面的 `addTabWithoutStealingFocus` 把无处安放的 Tab 挂到
    // `layout.activeGroupId` 上，而磁盘上的这个指针可能指着一个已经不在 `groups` 表里的分组。若先补挂
    // 再归一化，那些 Tab 已经进了一个画不出来的分组（`workbench-layout.ts:350-352` 记的孤儿形状），之后
    // 再把指针重座也救不回它们。先把指针落到一个真在场的分组上，补挂才有正确的落点。
    let layout = normalizePersistedLayout(
      input.persisted.layouts[workspace.id]
        ? keepTabsInLayout(input.persisted.layouts[workspace.id]!, workspaceTabIds)
        : createWorkspaceLayout(input.createTabGroupId())
    )
    for (const tabId of workspaceTabIds) {
      if (!findGroupForTab(layout, tabId)) {
        layout = addTabWithoutStealingFocus(layout, layout.activeGroupId, tabId)
      }
    }
    layouts[workspace.id] = layout
  }
  return { tabs, layouts, repairs }
}
