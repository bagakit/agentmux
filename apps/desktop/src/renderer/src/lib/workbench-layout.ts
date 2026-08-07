// 该状态内核移植并裁剪自一个成熟的 tab-group Store（tabs slice 与
// pane-column-split-drop-no-op 逻辑）。
// AgentMux 只移除了 Browser/Relay/Persistence 等当前不存在的分支。

import {
  type SplitTreeNode,
  type SplitTreeLeaf,
  collectLeafIds,
  EVEN_SPLIT_RATIO,
  findSiblingLeafId,
  removeLeaf,
  replaceLeaf,
  setSplitRatioAtPath
} from './split-tree'
// 方向的两半含义（哪根轴、哪一侧）只从这里取。本文件定义 SplitDirection，而 split-direction.ts 只
// `import type` 它——类型导入编译后被擦除，故这条反向的值导入不构成运行时循环。
import { orientationOf, placementOf } from './split-direction'

export type SplitDirection = 'left' | 'right' | 'up' | 'down'

// 工作区 tab-group 分屏树 = 叶子挂 groupId 的通用分屏树（见 split-tree.ts）。ratio 与 region 树统一
// 为必填：buildSplitNode 恒给 0.5，不存在缺省。历史持久化数据仍可能缺它，那条防线在
// `clampSplitRatio`（split-tree.ts）——**不是**渲染层的 `?? 0.5`：#552 坐实 `??` 接不住上游归一化
// 算出来的 NaN，那道兜底已被撤掉。
//
// 但两棵树的**兜底位置不一样**，别把这句读成「渲染层一律夹」：只有 tab-group 那一侧的渲染层自己夹
// 一次（WorkspaceWorkbench.tsx:1119），region 那一侧把 node.ratio 裸着交出去——给 <Panel> 的
// :798/:815，给分屏提交器的 :788/:791。region 靠的是「每个写入点都夹过」这条上游不变量，详见
// split-tree.ts 里 clampSplitRatio 的注释。于是新增一个写 region ratio 的地方时必须自己夹——
// 渲染层不会替你兜。
export type TabGroupLayoutNode = SplitTreeNode<{ groupId: string }>

export type TabGroup = {
  id: string
  activeTabId: string | null
  tabOrder: string[]
  recentTabIds: string[]
}

export type WorkspaceLayout = {
  root: TabGroupLayoutNode
  groups: TabGroup[]
  activeGroupId: string
}

// tab-group 树的叶子取值器：把「叶子的 id 是 groupId」这一件通用分屏树代数不认识的事，交给 split-tree
// 的泛型函数（collectLeafIds / replaceLeaf / removeLeaf / findSiblingLeafId）。整个文件只此一份，
// 各调用点不各自写一遍箭头函数。
// 导出的理由：Topic 投影（scratch-topic-layout.ts）也要在这棵树上摘叶子——把外来 Topic 投影到空的
// 那些格从树里去掉。它若自己写一份同样的箭头函数，就是这个取值器的第二处手抄，而这正是本注释开头
// 说要避免的事。取值器只有一份，谁在这棵树上作业都从这里取。
export const groupLeafId = (leaf: SplitTreeLeaf<{ groupId: string }>): string => leaf.groupId

function dedupeTabOrder(tabOrder: string[]): string[] {
  return [...new Set(tabOrder)]
}

function sanitizeRecentTabIds(recentTabIds: string[], tabOrder: string[]): string[] {
  const valid = new Set(tabOrder)
  return dedupeTabOrder(recentTabIds).filter((id) => valid.has(id))
}

function pushRecentTabId(recentTabIds: string[], tabId: string): string[] {
  return [...recentTabIds.filter((id) => id !== tabId), tabId]
}

/**
 * 一个 Tab 能不能当「下一个活动项」。
 *
 * 为什么这个判据要能被外部指定：这个文件是纯 layout 代数，它认识 group / tabOrder / recent，但**不认识
 * Tab 的语义**——不知道有 Topic 这回事，也不该知道。而「下一个活动项」在 Scratch 里必须认识 Topic：
 * Scratch 的所有 Topic 共用同一个 workspace，因此共用同一份 layout，`recentTabIds` 里混着别的 Topic
 * 的 Tab。关掉当前 Topic 的最后一张 Tab 时 `recent.at(-1)` 就会落到另一个 Topic 上，用户被静默弹走。
 *
 * 显示侧本来就按 Topic 投影过（`layoutForActiveTopic` 会过滤 tabOrder 与 recentTabIds），但那是**只读
 * 派生**，只服务渲染、内存预算、冷泊车、快捷键取值这几个读取面。reducer 吃的是未投影的 storedLayout，
 * 所以投影完全管不到这里——这正是缺陷能存在的原因。
 *
 * 缺省全部可选：不传谓词时行为与从前逐字相同，普通 workspace（一个 workspace 一个 worktree，不存在
 * Topic 混装）不需要任何额外知识。
 */
export type TabEligibility = (tabId: string) => boolean

function pickNextActiveTab(
  tabOrder: string[],
  recentTabIds: string[],
  closingId: string,
  eligible: TabEligibility = () => true
) {
  // eligible 只在这一处收窄，是刻意的：`sanitizeRecentTabIds` 会把 recent 交到 remainingOrder 上，
  // 所以在 recent 那一侧再判一次 eligible **不可能改变结果**——实测把那一次判断删掉，19 条全绿。
  // 那不是「守卫缺失」而是多余条件，写上去只会让读者以为两侧各有一道独立的门。
  const remainingOrder = tabOrder.filter((id) => id !== closingId && eligible(id))
  const recent = sanitizeRecentTabIds(
    recentTabIds.filter((id) => id !== closingId),
    remainingOrder
  )
  return recent.at(-1) ?? remainingOrder.at(-1) ?? null
}

function buildSplitNode(
  existingGroupId: string,
  newGroupId: string,
  direction: 'horizontal' | 'vertical',
  position: 'first' | 'second'
): TabGroupLayoutNode {
  const existingLeaf: TabGroupLayoutNode = { type: 'leaf', groupId: existingGroupId }
  const newLeaf: TabGroupLayoutNode = { type: 'leaf', groupId: newGroupId }
  return {
    type: 'split',
    direction,
    first: position === 'first' ? newLeaf : existingLeaf,
    second: position === 'second' ? newLeaf : existingLeaf,
    ratio: EVEN_SPLIT_RATIO
  }
}

// 关闭一个分组后由谁接管焦点：它在分屏树里的兄弟（子树时取其第一片叶子）。逐点等价于此前手写的
// findSiblingGroupId + findFirstLeaf，现改为复用 split-tree 的通用兄弟查找，只把「叶子的 id」这一件
// 树代数不认识的事作为取值器传进去。
export function findSiblingGroupId(
  root: TabGroupLayoutNode,
  targetGroupId: string
): string | null {
  return findSiblingLeafId(root, groupLeafId, targetGroupId)
}

function getDirectLayoutSiblingOnSplitSide(
  split: Extract<TabGroupLayoutNode, { type: 'split' }>,
  targetGroupId: string,
  splitDirection: SplitDirection
): string | null {
  const { first, second, direction } = split
  // 此前这里把方向拆解手抄了四遍（横×right、纵×down、横×left、纵×up），每条都自带一组轴与侧的配对。
  // 四条今天都对，但那是因为它们同一天写成；任何一条的配对写反，只会让那一个方向在那一根轴上静默答
  // 「没有邻居」——而另外三个方向照旧正确，最像"能用"的那种坏法。收敛到两半真相各取一次。
  if (orientationOf(splitDirection) !== direction) return null
  const towardSecond = placementOf(splitDirection) === 'second'
  // 朝轴的后半看时，出发点必须是 first、邻居是 second；朝前半看时反之。
  const origin = towardSecond ? first : second
  const neighbor = towardSecond ? second : first
  if (origin.type !== 'leaf' || origin.groupId !== targetGroupId) return null
  return neighbor.type === 'leaf' ? neighbor.groupId : null
}

function findLayoutSiblingOnSplitSide(
  root: TabGroupLayoutNode,
  targetGroupId: string,
  splitDirection: SplitDirection
): string | null {
  if (root.type === 'leaf') return null
  const direct = getDirectLayoutSiblingOnSplitSide(root, targetGroupId, splitDirection)
  if (direct) return direct
  return (
    findLayoutSiblingOnSplitSide(root.first, targetGroupId, splitDirection) ??
    findLayoutSiblingOnSplitSide(root.second, targetGroupId, splitDirection)
  )
}

function isSplitDropNoOp(args: {
  sourceGroupId: string
  targetGroupId: string
  splitDirection: SplitDirection
  sourceTabCount: number
  layout: TabGroupLayoutNode
}): boolean {
  if (args.sourceGroupId === args.targetGroupId && args.sourceTabCount <= 1) return true
  if (args.sourceTabCount !== 1) return false
  return (
    findLayoutSiblingOnSplitSide(args.layout, args.targetGroupId, args.splitDirection) ===
    args.sourceGroupId
  )
}

export function createWorkspaceLayout(groupId: string, tabs: string[] = []): WorkspaceLayout {
  const tabOrder = dedupeTabOrder(tabs)
  const activeTabId = tabOrder.at(0) ?? null
  return {
    root: { type: 'leaf', groupId },
    groups: [{ id: groupId, tabOrder, activeTabId, recentTabIds: activeTabId ? [activeTabId] : [] }],
    activeGroupId: groupId
  }
}

// tab-group 树的所有 groupId，按读序。函数体恰好只有一句：转发到 split-tree 的 collectLeafIds，
// 叶子取值器用本文件的 groupLeafId。此前它自己递归一份（与 workbench-view-layout 的 regionIds 逐字
// 相同），现收归 SSOT——这层薄壳保留是因为它是本文件的公开面（WorkspaceWorkbench、workbench-persistence
// 等多个 importer 从这里取），但除了转发之外不做任何事。
export function groupIds(root: TabGroupLayoutNode): string[] {
  return collectLeafIds(root, groupLeafId)
}

export function findGroup(layout: WorkspaceLayout, groupId: string): TabGroup | null {
  return layout.groups.find((group) => group.id === groupId) ?? null
}

export function findGroupForTab(layout: WorkspaceLayout, tabId: string): TabGroup | null {
  return layout.groups.find((group) => group.tabOrder.includes(tabId)) ?? null
}

export function addTab(layout: WorkspaceLayout, groupId: string, tabId: string): WorkspaceLayout {
  const existing = findGroupForTab(layout, tabId)
  if (existing) return activateTab(layout, existing.id, tabId)
  const group = findGroup(layout, groupId)
  if (!group) return layout
  return {
    ...layout,
    activeGroupId: groupId,
    groups: layout.groups.map((candidate) =>
      candidate.id === groupId
        ? {
            ...candidate,
            tabOrder: [...candidate.tabOrder, tabId],
            activeTabId: tabId,
            recentTabIds: pushRecentTabId(candidate.recentTabIds, tabId)
          }
        : candidate
    )
  }
}

/**
 * 与 {@link addTab} 同一件事，但挂不上时明确交回 `null`。
 *
 * `addTab` 挂不上时原样返回 layout——作为纯 reducer 这是正当的，但调用方若把 Tab 记录写进
 * `state.tabs` 再把这个返回值写回 `state.layouts`，那条 Tab 就进了 tabs 而**不在任何分组的
 * `tabOrder` 里**：一个永不显示、永不可关的孤儿，且全程零报错。实测（`launchAgent` /
 * `createBrowser`，无 launcher 归属、`tabGroupId` 指向一个已不存在的分组）：抛出的是 `null`
 * 而 `state.tabs` 多出一条孤儿记录，用户点了「启动」什么都没发生，整套测试零红。
 *
 * 判据取**后置条件**而不是 `next === layout` 的身份比较：后者认不出「Tab 已在别处、
 * `activateTab` 恰好返回同一个对象」这种正常情形，也会随 reducer 内部实现漂移。「调用之后这条
 * Tab 必须属于某个分组」才是这里唯一在乎的不变量，与怎么实现无关。
 *
 * 这个函数是那条判定在整个 store 里的**唯一**落点，{@link addTabOrThrow} 只是它的薄壳。
 * 谁用哪个取决于挂不上时能做什么，而不是取决于喜好：
 *   - 能直接抛的 async 动作用 `addTabOrThrow`；
 *   - 抛之前还要收尾的（`promoteWarmTerminal` 已把 PTY 从全局单槽里取出，必须先停掉），
 *     以及不能抛的同步 `void` 动作（`selectSession` / `openLauncher` 走 `reportError`，
 *     抛出只会变成 onClick 里的未捕获异常），用这个取值形式。
 * 无论哪条，「有没有挂上」只在这里判一次，调用点不各自再写一遍。
 */
export function addTabPlacement(
  layout: WorkspaceLayout,
  groupId: string,
  tabId: string
): WorkspaceLayout | null {
  const next = addTab(layout, groupId, tabId)
  return findGroupForTab(next, tabId) ? next : null
}

/** 挂不上即抛。落点不在场时调用方多半除了放弃没别的可做，这条壳省掉一次手写的 null 检查。 */
export function addTabOrThrow(
  layout: WorkspaceLayout,
  groupId: string,
  tabId: string
): WorkspaceLayout {
  const next = addTabPlacement(layout, groupId, tabId)
  if (!next) throw new Error('The Tab Group is no longer available')
  return next
}

export function insertTabAfter(
  layout: WorkspaceLayout,
  anchorTabId: string,
  tabId: string
): WorkspaceLayout {
  if (findGroupForTab(layout, tabId)) return layout
  const group = findGroupForTab(layout, anchorTabId)
  if (!group) return layout
  const anchorIndex = group.tabOrder.indexOf(anchorTabId)
  const tabOrder = [...group.tabOrder]
  tabOrder.splice(anchorIndex + 1, 0, tabId)
  return {
    ...layout,
    activeGroupId: group.id,
    groups: layout.groups.map((candidate) => candidate.id === group.id
      ? {
          ...candidate,
          tabOrder,
          activeTabId: tabId,
          recentTabIds: pushRecentTabId(candidate.recentTabIds, tabId)
        }
      : candidate)
  }
}

export function activateTab(
  layout: WorkspaceLayout,
  groupId: string,
  tabId: string
): WorkspaceLayout {
  const group = findGroup(layout, groupId)
  if (!group?.tabOrder.includes(tabId)) return layout
  return {
    ...layout,
    activeGroupId: groupId,
    groups: layout.groups.map((candidate) =>
      candidate.id === groupId
        ? {
            ...candidate,
            activeTabId: tabId,
            recentTabIds: pushRecentTabId(candidate.recentTabIds, tabId)
          }
        : candidate
    )
  }
}

export function focusGroup(layout: WorkspaceLayout, groupId: string): WorkspaceLayout {
  return findGroup(layout, groupId) ? { ...layout, activeGroupId: groupId } : layout
}

/**
 * 一个工作区布局的核心不变量：分组有两种表示，必须逐一相等——
 *   - 分屏树的叶子 id 集合：`groupIds(layout.root)`；
 *   - `groups` 数组的 id 集合：`layout.groups.map((g) => g.id)`。
 *
 * 这是 region 侧 `assertRegionInvariant`（workbench-tabs.ts）在**工作区这一层**的对偶：那半守的是
 * 「Region 树 ↔ tab.regions 表」，这半守的是「tab-group 树 ↔ layout.groups 数组」。两个违约方向都是
 * 「画不出、也回收不掉的孤儿」：
 *   - 树里多一片叶子（`groups` 数组没有对应记录）：渲染层拿 groupId 去 `findGroup` 得 null，画成一只
 *     永远空的破格；
 *   - `groups` 数组多一条记录（树里没有对应叶子）：一个永远画不到、也永远回收不掉的死分组，它名下的
 *     Tab 全成孤儿（{@link addTabPlacement} 那段 JSDoc 描述的形状）。
 *
 * 此前这条只由 `removeTab` / `moveTab` / `moveTabToNewGroup` 三处「两侧一起改」的手工约定维持，零守卫
 * ——而 region 那半早已是生产断言。历史代价有据：off-tree group 已复发两次（ad00a5e、dfd63eb），#556
 * 是同一族的三连缺陷。把不变量提升成生产断言，套在每个**重排分屏树**的 reducer 出口：将来只改了一侧的
 * 路径，会在改动发生的那一处响亮失败，而不是在渲染层留下一个静默孤儿。这也是判定这条性质的**唯一**
 * 实现（SSOT）。
 *
 * 无条件 throw，理由与 `assertRegionInvariant` 逐条相同：
 *   1. 断言跑在 reducer 算出「下一个 layout」之后、return 之前；抛出即这个 layout 不被返回，store 的
 *      `set()` 拿不到它，于是这一次操作整个作废、落回上一个一致状态。
 *   2. 反面更糟且不可恢复：静默放行一个看不见的孤儿分组，用户既看不见也关不掉，只能重启。
 *   3. 与同层其它 reducer 一致（空树、撞名等都是无条件抛）。
 *
 * **两个方向都判，不许削成单向。** 只判「叶子都有记录」会放过 off-tree group（记录多、树里没有）——那正是
 * 已复发两次的那一种；只判「记录都有叶子」会放过树里的孤儿叶。缺一侧就漏掉一整族缺陷。
 *
 * **只断言 STORED layout，绝不断言任何投影。** `layoutForActiveTopic`（scratch-topic-layout.ts:203）
 * 刻意产出一个 `groups` ⊇ 树叶的**超集**：它把投影到空的分组用 `removeLeaf` 摘出树，却在 `groups` 数组里
 * 保留它们（那是存储真相，别的 Topic 的 Tab 还在里面，删了切回去就找不回来——见其 :188-197 原话）。那是
 * 只读派生值，不流回任何 reducer，故本断言碰不到它；谁若把它喂回 reducer 或在它身上断言，会误报——见
 * scratch-topic-write-coordinates.test.ts 里那条钉住「投影是合法超集」的用例。
 */
export function assertGroupInvariant(layout: WorkspaceLayout): void {
  const tree = groupIds(layout.root)
  const records = layout.groups.map((group) => group.id)
  const recordSet = new Set(records)
  const treeSet = new Set(tree)
  const leavesWithoutRecord = tree.filter((id) => !recordSet.has(id))
  const recordsWithoutLeaf = records.filter((id) => !treeSet.has(id))
  if (leavesWithoutRecord.length > 0 || recordsWithoutLeaf.length > 0) {
    throw new Error(
      `Workspace layout group invariant violated: the split tree holds group ids ` +
        `[${[...tree].sort().join(', ')}] but layout.groups holds [${[...records].sort().join(', ')}]. ` +
        `Tree leaves with no group record: [${leavesWithoutRecord.sort().join(', ')}]; ` +
        `group records with no tree leaf: [${recordsWithoutLeaf.sort().join(', ')}]. Every tree leaf ` +
        `must have exactly one groups entry and vice versa — a mismatch is an invisible, un-closeable ` +
        `orphan Tab Group.`
    )
  }
}

export function removeTab(
  layout: WorkspaceLayout,
  groupId: string,
  tabId: string,
  eligible?: TabEligibility
): WorkspaceLayout {
  const group = findGroup(layout, groupId)
  if (!group?.tabOrder.includes(tabId)) return layout
  const sourceOrder = group.tabOrder.filter((id) => id !== tabId)
  const groups = layout.groups.map((candidate) =>
    candidate.id === groupId
      ? {
          ...candidate,
          tabOrder: sourceOrder,
          activeTabId:
            candidate.activeTabId === tabId
              ? pickNextActiveTab(candidate.tabOrder, candidate.recentTabIds, tabId, eligible)
              : candidate.activeTabId,
          recentTabIds: sanitizeRecentTabIds(
            candidate.recentTabIds.filter((id) => id !== tabId),
            sourceOrder
          )
        }
      : candidate
  )
  // 收掉这个分组（从 `groups` 里删掉）只在它**真的是分屏树里的一片叶子、且不是最后一片**时才成立。
  //
  // 判据此前只写了 `layout.root.type === 'leaf'`。那句话想表达「只剩一个分组，别把它删了」，而它只在
  // 「每个分组都在 root 树里」这个前提下够用。前提一旦不成立（一个分组只进了 `groups` 而没进 `root`
  // ——例如把浮层做成一个不在主区分屏树里渲染的真分组），判据就漏掉那一族，而且漏的方向取决于**主区
  // 恰好有没有分屏**：
  //
  //   - 主区未分屏 → 命中 `root.type === 'leaf'` 提前返回 → 那个分组留着。
  //   - 主区已分屏 → 落到下面：`removeLeaf` 因为它不在树里而不会改动树，但 `groups.filter` 把它
  //     **删了**。它的 Tab 记录还在 `state.tabs` 里却不再属于任何分组：一个永不显示、永不可关的
  //     孤儿（正是 {@link addTabPlacement} 那段 JSDoc 描述的形状）。且若它当时是 `activeGroupId`，
  //     `findSiblingGroupId` 因为它在树里没有兄弟而返回 null，`activeGroupId` 就停在一个已不存在的
  //     id 上。全程零报错。
  //
  // 所以判据补上「它在不在树里」这一问。`leafIds.length === 1` 与旧的 `root.type === 'leaf'` 逐点
  // 等价（split 恒有两个子节点，故叶子数为 1 ⟺ root 本身就是叶子），换成数叶子只是为了与前一问共用
  // 同一次 `groupIds`；真正的变化只有 `!leafIds.includes(groupId)` 那一项，对今天每条可达输入都不
  // 改变结果。三项各由 workbench-layout-off-tree-group.test.ts 单独钉着（逐项撤掉只红对应那条：实测
  // 撤 `sourceOrder.length > 0` → 1 红 6 绿，撤 `!leafIds.includes` → 2 红，撤 `length === 1` → 2 红）。
  const leafIds = groupIds(layout.root)
  if (sourceOrder.length > 0 || !leafIds.includes(groupId) || leafIds.length === 1) {
    // 这条出口只改 `groups` 里的 within-record 字段（tabOrder / activeTabId / recentTabIds），树与
    // 「记录 id 集合」都原样不动，故不可能引入「树 ↔ groups」漂移，不套断言。它还**刻意容忍**一个
    // 入场时就在的 off-tree group（记录多、树里没有对应叶）：删该分组自己的最后一张 Tab 走这条路，
    // 分组留着等持久化边界回收（workbench-layout-off-tree-group.test.ts 钉住这条容忍）。在这里断言会把
    // 那条容忍打断。真正会重排树的下一条出口才套断言。
    return { ...layout, groups }
  }
  const siblingId = findSiblingGroupId(layout.root, groupId)
  const next: WorkspaceLayout = {
    root: removeLeaf(layout.root, groupLeafId, groupId) ?? layout.root,
    groups: groups.filter((candidate) => candidate.id !== groupId),
    activeGroupId: siblingId ?? layout.activeGroupId
  }
  // 收组同时从树（removeLeaf）与 `groups` 数组（filter）里摘掉同一个 groupId——将来只改一侧就会留下
  // 画不出、回收不掉的孤儿。在改动发生的这一处响亮失败。
  assertGroupInvariant(next)
  return next
}

export function moveTab(
  layout: WorkspaceLayout,
  tabId: string,
  sourceGroupId: string,
  targetGroupId: string,
  targetIndex: number
): WorkspaceLayout {
  const sourceGroup = findGroup(layout, sourceGroupId)
  const targetGroup = findGroup(layout, targetGroupId)
  if (!sourceGroup?.tabOrder.includes(tabId) || !targetGroup) return layout
  if (sourceGroupId === targetGroupId) {
    const order = sourceGroup.tabOrder.filter((id) => id !== tabId)
    order.splice(Math.max(0, Math.min(targetIndex, order.length)), 0, tabId)
    return {
      ...layout,
      activeGroupId: targetGroupId,
      groups: layout.groups.map((group) =>
        group.id === targetGroupId ? { ...group, tabOrder: order, activeTabId: tabId } : group
      )
    }
  }
  const sourceOrder = sourceGroup.tabOrder.filter((id) => id !== tabId)
  const targetOrder = targetGroup.tabOrder.filter((id) => id !== tabId)
  targetOrder.splice(Math.max(0, Math.min(targetIndex, targetOrder.length)), 0, tabId)
  let groups = layout.groups.map((group) => {
    if (group.id === sourceGroupId) {
      return {
        ...group,
        tabOrder: sourceOrder,
        activeTabId:
          group.activeTabId === tabId
            ? pickNextActiveTab(group.tabOrder, group.recentTabIds, tabId)
            : group.activeTabId,
        recentTabIds: sanitizeRecentTabIds(
          group.recentTabIds.filter((id) => id !== tabId),
          sourceOrder
        )
      }
    }
    if (group.id === targetGroupId) {
      return {
        ...group,
        tabOrder: targetOrder,
        activeTabId: tabId,
        recentTabIds: pushRecentTabId(sanitizeRecentTabIds(group.recentTabIds, targetOrder), tabId)
      }
    }
    return group
  })
  let root = layout.root
  if (sourceOrder.length === 0) {
    root = removeLeaf(root, groupLeafId, sourceGroupId) ?? root
    groups = groups.filter((group) => group.id !== sourceGroupId)
  }
  const next: WorkspaceLayout = { root, groups, activeGroupId: targetGroupId }
  // 源分组被搬空时这里同时从树（removeLeaf）与 `groups`（filter）摘掉它——两侧漏一侧就是孤儿。搬空
  // 之外的跨组移动不动树、也不动记录 id 集合，此处再判一次是纵深防御（与 region 侧 swap 自愿断言同理）。
  assertGroupInvariant(next)
  return next
}

export function moveTabToNewGroup(
  layout: WorkspaceLayout,
  tabId: string,
  sourceGroupId: string,
  targetGroupId: string,
  direction: SplitDirection,
  newGroupId: string
): WorkspaceLayout {
  const sourceGroup = findGroup(layout, sourceGroupId)
  const targetGroup = findGroup(layout, targetGroupId)
  if (!sourceGroup?.tabOrder.includes(tabId) || !targetGroup) return layout
  if (
    isSplitDropNoOp({
      sourceGroupId,
      targetGroupId,
      splitDirection: direction,
      sourceTabCount: sourceGroup.tabOrder.length,
      layout: layout.root
    })
  ) {
    return layout
  }

  const replacement = buildSplitNode(
    targetGroupId,
    newGroupId,
    orientationOf(direction),
    placementOf(direction)
  )
  const sourceOrder = sourceGroup.tabOrder.filter((id) => id !== tabId)
  let groups: TabGroup[] = [
    ...layout.groups,
    { id: newGroupId, tabOrder: [tabId], activeTabId: tabId, recentTabIds: [tabId] }
  ].map((group) =>
    group.id === sourceGroupId
      ? {
          ...group,
          tabOrder: sourceOrder,
          activeTabId:
            group.activeTabId === tabId
              ? pickNextActiveTab(group.tabOrder, group.recentTabIds, tabId)
              : group.activeTabId,
          recentTabIds: sanitizeRecentTabIds(
            group.recentTabIds.filter((id) => id !== tabId),
            sourceOrder
          )
        }
      : group
  )
  let root = replaceLeaf(layout.root, groupLeafId, targetGroupId, replacement)
  if (sourceOrder.length === 0) {
    root = removeLeaf(root, groupLeafId, sourceGroupId) ?? root
    groups = groups.filter((group) => group.id !== sourceGroupId)
  }
  const next: WorkspaceLayout = { root, groups, activeGroupId: newGroupId }
  // 这里既往树里加了一片新叶（replaceLeaf 把目标格换成含 newGroupId 的 split），也把 newGroupId 的记录
  // 追加进 `groups`；源被搬空时又两侧一起摘。任一侧漏改都会留下孤儿——在改动发生的这一处响亮失败。
  assertGroupInvariant(next)
  return next
}

export function setSplitRatio(
  layout: WorkspaceLayout,
  nodePath: string,
  ratio: number
): WorkspaceLayout {
  return { ...layout, root: setSplitRatioAtPath(layout.root, nodePath, ratio) }
}
