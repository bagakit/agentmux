import type { SplitDirection } from './workbench-layout'

export type WorkbenchRegionLayoutNode =
  | { type: 'leaf'; regionId: string }
  | {
      type: 'split'
      direction: 'horizontal' | 'vertical'
      first: WorkbenchRegionLayoutNode
      second: WorkbenchRegionLayoutNode
      ratio: number
    }

export type WorkbenchViewLayout = {
  root: WorkbenchRegionLayoutNode
  activeRegionId: string
}

export type WorkbenchRegionBounds = {
  x: number
  y: number
  width: number
  height: number
}

export type WorkbenchRegionLayoutPreset = 'columns-3' | 'grid-4' | 'grid-6' | 'grid-9'

export function createWorkbenchViewLayout(regionId: string): WorkbenchViewLayout {
  return { root: { type: 'leaf', regionId }, activeRegionId: regionId }
}

export function regionIds(root: WorkbenchRegionLayoutNode): string[] {
  return root.type === 'leaf'
    ? [root.regionId]
    : [...regionIds(root.first), ...regionIds(root.second)]
}

function lineLayout(
  ids: readonly string[],
  direction: 'horizontal' | 'vertical'
): WorkbenchRegionLayoutNode {
  const [first, ...rest] = ids
  if (!first) throw new Error('A Workbench Region layout cannot be empty.')
  if (rest.length === 0) return { type: 'leaf', regionId: first }
  return {
    type: 'split',
    direction,
    first: { type: 'leaf', regionId: first },
    second: lineLayout(rest, direction),
    ratio: 1 / ids.length
  }
}

function gridLayout(ids: readonly string[], columns: number): WorkbenchRegionLayoutNode {
  const rows: WorkbenchRegionLayoutNode[] = []
  for (let offset = 0; offset < ids.length; offset += columns) {
    rows.push(lineLayout(ids.slice(offset, offset + columns), 'horizontal'))
  }
  if (rows.length === 1) return rows[0]!
  const combineRows = (remaining: readonly WorkbenchRegionLayoutNode[]): WorkbenchRegionLayoutNode => {
    const [first, ...rest] = remaining
    if (!first) throw new Error('A Workbench Region grid cannot be empty.')
    if (rest.length === 0) return first
    return {
      type: 'split',
      direction: 'vertical',
      first,
      second: combineRows(rest),
      ratio: 1 / remaining.length
    }
  }
  return combineRows(rows)
}

export function workbenchRegionPresetSize(preset: WorkbenchRegionLayoutPreset): number {
  switch (preset) {
    case 'columns-3': return 3
    case 'grid-4': return 4
    case 'grid-6': return 6
    case 'grid-9': return 9
  }
}

export function applyWorkbenchRegionLayoutPreset(
  layout: WorkbenchViewLayout,
  preset: WorkbenchRegionLayoutPreset,
  addedRegionIds: readonly string[]
): WorkbenchViewLayout {
  const current = regionIds(layout.root)
  const size = workbenchRegionPresetSize(preset)
  if (current.length > size || addedRegionIds.length !== size - current.length) return layout
  const ids = [...current, ...addedRegionIds]
  if (new Set(ids).size !== ids.length) return layout
  return {
    root: preset === 'columns-3'
      ? lineLayout(ids, 'horizontal')
      : gridLayout(ids, preset === 'grid-4' ? 2 : 3),
    activeRegionId: layout.activeRegionId
  }
}

function leafCount(root: WorkbenchRegionLayoutNode): number {
  return root.type === 'leaf' ? 1 : leafCount(root.first) + leafCount(root.second)
}

function balanceNode(root: WorkbenchRegionLayoutNode): WorkbenchRegionLayoutNode {
  if (root.type === 'leaf') return root
  const first = balanceNode(root.first)
  const second = balanceNode(root.second)
  return {
    ...root,
    first,
    second,
    ratio: leafCount(first) / (leafCount(first) + leafCount(second))
  }
}

export function balanceWorkbenchRegionLayout(layout: WorkbenchViewLayout): WorkbenchViewLayout {
  return { ...layout, root: balanceNode(layout.root) }
}

function replaceLeafOrder(
  root: WorkbenchRegionLayoutNode,
  ids: Iterator<string>
): WorkbenchRegionLayoutNode {
  if (root.type === 'leaf') return { type: 'leaf', regionId: ids.next().value as string }
  return {
    ...root,
    first: replaceLeafOrder(root.first, ids),
    second: replaceLeafOrder(root.second, ids)
  }
}

export function placeActiveWorkbenchRegionFirst(layout: WorkbenchViewLayout): WorkbenchViewLayout {
  const current = regionIds(layout.root)
  if (current[0] === layout.activeRegionId) return layout
  const ordered = [layout.activeRegionId, ...current.filter((id) => id !== layout.activeRegionId)]
  if (ordered.length !== current.length) return layout
  return { ...layout, root: replaceLeafOrder(layout.root, ordered.values()) }
}

/**
 * 在既有布局里把两格的位置互换（#471）：树的骨架与每个 `ratio` 一字不动，只是两个 regionId 各自
 * 占到对方原来的叶子上——内容跟着 id 走，用户看到两格的东西对调了位置，而分屏的比例、方向、层级
 * 都保持原样。这是 `placeActiveWorkbenchRegionFirst` 那套「id 在固定骨架上重排」的一个两元置换特例，
 * 复用同一个 `replaceLeafOrder`。
 *
 * 守卫落在**集合**上，不落在长度上——这是刻意的，且与 `placeActiveWorkbenchRegionFirst` 的长度检查
 * 不同：那个调用方传的序列在 id 缺席时会短一截（filter 删不掉不存在的 id），长度检查够用；而这里传的
 * 是两位置置换，长度天然与 current 相等，长度检查对它完全失效。若不校验成员，一个不在场的 id 会被
 * `replaceLeafOrder` 里 `ids.next().value as string` 原样写进某个叶子（迭代器耗尽时它断言 undefined 是
 * string），凭空造出一格、把真在场的一格换没。所以要求两个端点都在场：两个都在时，置换后的集合必然
 * 与原集合逐一相等，写不进任何新 id。
 *
 * 同一个 id 与自己换、或任一端点不在场，都原样返回（`===` 稳定，避免无谓的重渲染）。
 */
export function swapWorkbenchRegions(
  layout: WorkbenchViewLayout,
  regionIdA: string,
  regionIdB: string
): WorkbenchViewLayout {
  if (regionIdA === regionIdB) return layout
  const current = regionIds(layout.root)
  const present = new Set(current)
  if (!present.has(regionIdA) || !present.has(regionIdB)) return layout
  const swapped = current.map((id) =>
    id === regionIdA ? regionIdB : id === regionIdB ? regionIdA : id
  )
  return { ...layout, root: replaceLeafOrder(layout.root, swapped.values()) }
}

export function workbenchRegionBounds(
  root: WorkbenchRegionLayoutNode
): Array<{ regionId: string; bounds: WorkbenchRegionBounds }> {
  const regions: Array<{ regionId: string; bounds: WorkbenchRegionBounds }> = []
  const visit = (node: WorkbenchRegionLayoutNode, bounds: WorkbenchRegionBounds): void => {
    if (node.type === 'leaf') {
      regions.push({ regionId: node.regionId, bounds })
      return
    }
    if (node.direction === 'horizontal') {
      const firstWidth = bounds.width * node.ratio
      visit(node.first, { ...bounds, width: firstWidth })
      visit(node.second, {
        ...bounds,
        x: bounds.x + firstWidth,
        width: bounds.width - firstWidth
      })
      return
    }
    const firstHeight = bounds.height * node.ratio
    visit(node.first, { ...bounds, height: firstHeight })
    visit(node.second, {
      ...bounds,
      y: bounds.y + firstHeight,
      height: bounds.height - firstHeight
    })
  }
  visit(root, { x: 0, y: 0, width: 1, height: 1 })
  return regions
}

function replaceRegion(
  root: WorkbenchRegionLayoutNode,
  targetRegionId: string,
  replacement: WorkbenchRegionLayoutNode
): WorkbenchRegionLayoutNode {
  if (root.type === 'leaf') return root.regionId === targetRegionId ? replacement : root
  return {
    ...root,
    first: replaceRegion(root.first, targetRegionId, replacement),
    second: replaceRegion(root.second, targetRegionId, replacement)
  }
}

export function splitWorkbenchRegion(
  layout: WorkbenchViewLayout,
  targetRegionId: string,
  direction: SplitDirection,
  newRegionId: string
): WorkbenchViewLayout {
  const currentRegionIds = regionIds(layout.root)
  if (!currentRegionIds.includes(targetRegionId) || currentRegionIds.includes(newRegionId)) return layout
  const target: WorkbenchRegionLayoutNode = { type: 'leaf', regionId: targetRegionId }
  const added: WorkbenchRegionLayoutNode = { type: 'leaf', regionId: newRegionId }
  const newFirst = direction === 'left' || direction === 'up'
  return {
    root: replaceRegion(layout.root, targetRegionId, {
      type: 'split',
      direction: direction === 'left' || direction === 'right' ? 'horizontal' : 'vertical',
      first: newFirst ? added : target,
      second: newFirst ? target : added,
      ratio: 0.5
    }),
    activeRegionId: newRegionId
  }
}

function removeRegionNode(
  root: WorkbenchRegionLayoutNode,
  targetRegionId: string
): WorkbenchRegionLayoutNode | null {
  if (root.type === 'leaf') return root.regionId === targetRegionId ? null : root
  const first = removeRegionNode(root.first, targetRegionId)
  const second = removeRegionNode(root.second, targetRegionId)
  if (!first) return second
  if (!second) return first
  return { ...root, first, second }
}

export function closeWorkbenchRegion(
  layout: WorkbenchViewLayout,
  regionId: string
): WorkbenchViewLayout {
  const currentRegionIds = regionIds(layout.root)
  if (currentRegionIds.length <= 1 || !currentRegionIds.includes(regionId)) return layout
  const root = removeRegionNode(layout.root, regionId)
  if (!root) return layout
  const remainingRegionIds = regionIds(root)
  return {
    root,
    activeRegionId: layout.activeRegionId === regionId
      ? remainingRegionIds.at(-1)!
      : layout.activeRegionId
  }
}

export function focusWorkbenchRegion(
  layout: WorkbenchViewLayout,
  regionId: string
): WorkbenchViewLayout {
  return regionIds(layout.root).includes(regionId) && layout.activeRegionId !== regionId
    ? { ...layout, activeRegionId: regionId }
    : layout
}

function updateSplitRatio(
  root: WorkbenchRegionLayoutNode,
  path: string[],
  ratio: number
): WorkbenchRegionLayoutNode {
  if (path.length === 0) return root.type === 'split' ? { ...root, ratio } : root
  if (root.type !== 'split') return root
  const [segment, ...rest] = path
  if (segment === 'first') return { ...root, first: updateSplitRatio(root.first, rest, ratio) }
  if (segment === 'second') return { ...root, second: updateSplitRatio(root.second, rest, ratio) }
  return root
}

export function setWorkbenchRegionSplitRatio(
  layout: WorkbenchViewLayout,
  nodePath: string,
  ratio: number
): WorkbenchViewLayout {
  const nextRatio = Math.max(0.1, Math.min(0.9, ratio))
  return {
    ...layout,
    root: updateSplitRatio(layout.root, nodePath ? nodePath.split('.') : [], nextRatio)
  }
}
