// 该状态内核移植并裁剪自一个成熟的 tab-group Store（tabs slice 与
// pane-column-split-drop-no-op 逻辑）。
// AgentMux 只移除了 Browser/Relay/Persistence 等当前不存在的分支。

import {
  type SplitTreeNode,
  findSiblingLeafId,
  setSplitRatioAtPath
} from './split-tree'
// 方向的两半含义（哪根轴、哪一侧）只从这里取。本文件定义 SplitDirection，而 split-direction.ts 只
// `import type` 它——类型导入编译后被擦除，故这条反向的值导入不构成运行时循环。
import { orientationOf, placementOf } from './split-direction'

export type SplitDirection = 'left' | 'right' | 'up' | 'down'

// 工作区 tab-group 分屏树 = 叶子挂 groupId 的通用分屏树（见 split-tree.ts）。ratio 与 region 树统一
// 为必填：buildSplitNode 恒给 0.5，不存在缺省。（渲染侧 WorkspaceWorkbench.tsx 仍以 `?? 0.5` 兜底，
// 那是给可能缺 ratio 的历史持久化数据留的防线，与本类型的「新建时恒有」不矛盾。）
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
    ratio: 0.5
  }
}

function replaceLeaf(
  root: TabGroupLayoutNode,
  targetGroupId: string,
  replacement: TabGroupLayoutNode
): TabGroupLayoutNode {
  if (root.type === 'leaf') return root.groupId === targetGroupId ? replacement : root
  return {
    ...root,
    first: replaceLeaf(root.first, targetGroupId, replacement),
    second: replaceLeaf(root.second, targetGroupId, replacement)
  }
}

// 关闭一个分组后由谁接管焦点：它在分屏树里的兄弟（子树时取其第一片叶子）。逐点等价于此前手写的
// findSiblingGroupId + findFirstLeaf，现改为复用 split-tree 的通用兄弟查找，只把「叶子的 id」这一件
// 树代数不认识的事作为取值器传进去。
export function findSiblingGroupId(
  root: TabGroupLayoutNode,
  targetGroupId: string
): string | null {
  return findSiblingLeafId(root, (leaf) => leaf.groupId, targetGroupId)
}

function removeLeaf(
  root: TabGroupLayoutNode,
  targetGroupId: string
): TabGroupLayoutNode | null {
  if (root.type === 'leaf') return root.groupId === targetGroupId ? null : root
  if (root.first.type === 'leaf' && root.first.groupId === targetGroupId) return root.second
  if (root.second.type === 'leaf' && root.second.groupId === targetGroupId) return root.first
  const first = removeLeaf(root.first, targetGroupId)
  const second = removeLeaf(root.second, targetGroupId)
  if (!first) return second
  if (!second) return first
  return { ...root, first, second }
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

export function groupIds(root: TabGroupLayoutNode): string[] {
  return root.type === 'leaf' ? [root.groupId] : [...groupIds(root.first), ...groupIds(root.second)]
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
  // 改变结果。三项各由 workbench-layout-off-tree-group.test.ts 单独钉着（逐项撤掉只红对应那条）。
  const leafIds = groupIds(layout.root)
  if (sourceOrder.length > 0 || !leafIds.includes(groupId) || leafIds.length === 1) {
    return { ...layout, groups }
  }
  const siblingId = findSiblingGroupId(layout.root, groupId)
  return {
    root: removeLeaf(layout.root, groupId) ?? layout.root,
    groups: groups.filter((candidate) => candidate.id !== groupId),
    activeGroupId: siblingId ?? layout.activeGroupId
  }
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
    root = removeLeaf(root, sourceGroupId) ?? root
    groups = groups.filter((group) => group.id !== sourceGroupId)
  }
  return { root, groups, activeGroupId: targetGroupId }
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
  let root = replaceLeaf(layout.root, targetGroupId, replacement)
  if (sourceOrder.length === 0) {
    root = removeLeaf(root, sourceGroupId) ?? root
    groups = groups.filter((group) => group.id !== sourceGroupId)
  }
  return { root, groups, activeGroupId: newGroupId }
}

export function setSplitRatio(
  layout: WorkspaceLayout,
  nodePath: string,
  ratio: number
): WorkspaceLayout {
  return { ...layout, root: setSplitRatioAtPath(layout.root, nodePath, ratio) }
}
