// 该状态内核直接移植并裁剪自 Orca 的 tab-group Store：
// src/renderer/src/store/slices/tabs.ts 与 pane-column-split-drop-no-op.ts。
// AgentMux 只移除了 Browser/Relay/Persistence 等当前不存在的分支。

export type SplitDirection = 'left' | 'right' | 'up' | 'down'

export type TabGroupLayoutNode =
  | { type: 'leaf'; groupId: string }
  | {
      type: 'split'
      direction: 'horizontal' | 'vertical'
      first: TabGroupLayoutNode
      second: TabGroupLayoutNode
      ratio?: number
    }

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

function pickNextActiveTab(tabOrder: string[], recentTabIds: string[], closingId: string) {
  const remainingOrder = tabOrder.filter((id) => id !== closingId)
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

function updateSplitRatio(
  root: TabGroupLayoutNode,
  path: string[],
  ratio: number
): TabGroupLayoutNode {
  if (path.length === 0) return root.type === 'split' ? { ...root, ratio } : root
  if (root.type !== 'split') return root
  const [segment, ...rest] = path
  if (segment === 'first') return { ...root, first: updateSplitRatio(root.first, rest, ratio) }
  if (segment === 'second') return { ...root, second: updateSplitRatio(root.second, rest, ratio) }
  return root
}

function findFirstLeaf(root: TabGroupLayoutNode): string {
  return root.type === 'leaf' ? root.groupId : findFirstLeaf(root.first)
}

export function findSiblingGroupId(
  root: TabGroupLayoutNode,
  targetGroupId: string
): string | null {
  if (root.type === 'leaf') return null
  if (root.first.type === 'leaf' && root.first.groupId === targetGroupId) {
    return root.second.type === 'leaf' ? root.second.groupId : findFirstLeaf(root.second)
  }
  if (root.second.type === 'leaf' && root.second.groupId === targetGroupId) {
    return root.first.type === 'leaf' ? root.first.groupId : findFirstLeaf(root.first)
  }
  return (
    findSiblingGroupId(root.first, targetGroupId) ??
    findSiblingGroupId(root.second, targetGroupId)
  )
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
  if (first.type === 'leaf' && first.groupId === targetGroupId) {
    if (direction === 'horizontal' && splitDirection === 'right' && second.type === 'leaf') {
      return second.groupId
    }
    if (direction === 'vertical' && splitDirection === 'down' && second.type === 'leaf') {
      return second.groupId
    }
  }
  if (second.type === 'leaf' && second.groupId === targetGroupId) {
    if (direction === 'horizontal' && splitDirection === 'left' && first.type === 'leaf') {
      return first.groupId
    }
    if (direction === 'vertical' && splitDirection === 'up' && first.type === 'leaf') {
      return first.groupId
    }
  }
  return null
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
  tabId: string
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
              ? pickNextActiveTab(candidate.tabOrder, candidate.recentTabIds, tabId)
              : candidate.activeTabId,
          recentTabIds: sanitizeRecentTabIds(
            candidate.recentTabIds.filter((id) => id !== tabId),
            sourceOrder
          )
        }
      : candidate
  )
  if (sourceOrder.length > 0 || layout.root.type === 'leaf') return { ...layout, groups }
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
    direction === 'left' || direction === 'right' ? 'horizontal' : 'vertical',
    direction === 'left' || direction === 'up' ? 'first' : 'second'
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
  const clamped = Math.max(0.15, Math.min(0.85, ratio))
  return {
    ...layout,
    root: updateSplitRatio(layout.root, nodePath ? nodePath.split('.') : [], clamped)
  }
}
