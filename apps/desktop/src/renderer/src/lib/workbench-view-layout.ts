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

export function createWorkbenchViewLayout(regionId: string): WorkbenchViewLayout {
  return { root: { type: 'leaf', regionId }, activeRegionId: regionId }
}

export function regionIds(root: WorkbenchRegionLayoutNode): string[] {
  return root.type === 'leaf'
    ? [root.regionId]
    : [...regionIds(root.first), ...regionIds(root.second)]
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
