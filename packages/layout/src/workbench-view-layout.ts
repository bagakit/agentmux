import type { SplitDirection } from './workbench-layout'
import { orientationOf, placementOf } from './split-direction'
import {
  type SplitTreeNode,
  type SplitTreeLeaf,
  clampSplitRatio,
  collectLeafIds,
  EVEN_SPLIT_RATIO,
  findSiblingLeafId,
  removeLeaf,
  replaceLeaf,
  setSplitRatioAtPath
} from './split-tree'
import type { WorkbenchLayoutPreset } from '@agentmux/core/workbench-layout-preset'

// tab 内 region 分屏树 = 叶子挂 regionId 的通用分屏树（见 split-tree.ts）。ratio 必填，与 tab-group
// 树统一：每个 split 都由 splitWorkbenchRegion/gridLayout/balanceNode 现算一个比例，不存在缺省的情形。
export type WorkbenchRegionLayoutNode = SplitTreeNode<{ regionId: string }>

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

// 布局预设名。渲染器不自己写这份字面量 union，而是复用 Core 那份 node-free SSOT
//（@agentmux/core/workbench-layout-preset）——控制协议的 `AgentMuxArrangeMode.preset` 用的是同一个类型，
// 于是「GUI 认得的预设」与「控制协议认得的预设」在编译期就是同一个集合，任一侧加/删一档都会在两边同时
// 生效，不存在两份手抄漂移的余地。
export type WorkbenchRegionLayoutPreset = WorkbenchLayoutPreset

export function createWorkbenchViewLayout(regionId: string): WorkbenchViewLayout {
  return { root: { type: 'leaf', regionId }, activeRegionId: regionId }
}

// region 树的叶子取值器：把「叶子的 id 是 regionId」交给 split-tree 的泛型函数（collectLeafIds /
// replaceLeaf / removeLeaf / findSiblingLeafId）。整个文件只此一份，各调用点不各自写一遍箭头函数。
// 导出是给持久化边界用的（`dedupeLeafIds` 要同一个取值器）——与 workbench-layout 的 `groupLeafId`
// 对称。别在别处重新写一份 `(leaf) => leaf.regionId`：那就是第二份手抄。
export const regionLeafId = (leaf: SplitTreeLeaf<{ regionId: string }>): string => leaf.regionId

// region 树的所有 regionId，按读序。函数体恰好只有一句：转发到 split-tree 的 collectLeafIds，叶子
// 取值器用本文件的 regionLeafId。此前它自己递归一份（与 workbench-layout 的 groupIds 逐字相同），
// 现收归 SSOT——这层转发保留是因为它是本文件的公开面（workbench-persistence、workbench-shortcuts、
// workbench-tabs、WorkspaceWorkbench 等多个 importer 从这里取），但除了转发之外不做任何事。
export function regionIds(root: WorkbenchRegionLayoutNode): string[] {
  return collectLeafIds(root, regionLeafId)
}

/**
 * 一行 N 格，横向铺开。递归结构里每层的 `ratio` 是 1/剩余格数，于是自然等分。
 *
 * 刻意只做横向：唯一调用方 `gridLayout` 只需要横排的行，纵向由它自己的 `combineRows` 叠。此前这里
 * 有个 `direction` 形参，而全仓两个调用点传的都是 `'horizontal'`——一个永远只取一个值的形参会让人
 * 以为纵向排列也走这条路，而真正的纵向在 `combineRows` 里（本仓 expired-reason-for-not-mapping：
 * 没有消费者的灵活性是会骗人的声明）。
 */
function rowLayout(ids: readonly string[]): WorkbenchRegionLayoutNode {
  const [first, ...rest] = ids
  if (!first) throw new Error('A Workbench Region layout cannot be empty.')
  if (rest.length === 0) return { type: 'leaf', regionId: first }
  return {
    type: 'split',
    direction: 'horizontal',
    first: { type: 'leaf', regionId: first },
    second: rowLayout(rest),
    ratio: 1 / ids.length
  }
}

function gridLayout(ids: readonly string[], columns: number): WorkbenchRegionLayoutNode {
  const rows: WorkbenchRegionLayoutNode[] = []
  for (let offset = 0; offset < ids.length; offset += columns) {
    rows.push(rowLayout(ids.slice(offset, offset + columns)))
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

/**
 * 每档预设铺几列。带返回类型的穷举 switch，不是 `preset === 'grid-4' ? 2 : 3`——三元里的 `: 3`
 * 是个默认桶：新增一档只要不叫 `grid-4` 就静默拿到 3 列，`columns-5` 会被画成 3+2 的两行网格，
 * 而这一档的名字明说它是一行五列。没有编译错、没有红，只有用户点下去发现画错。穷举 switch 把
 * 「这一档铺几列」变成一次必须显式作答的决定。
 *
 * `columns-3` 也走这条路而不是另开一条「一行排完」的分支：它的格数恰好等于列数，
 * `gridLayout` 只会排出一行、直接返回那一行，与专门的一行实现逐字段相等。留着那条分支等于留一个
 * 任何测试都分辨不出的死条件（本仓 surviving-mutation-may-be-dead-condition：先判它可不可能改变
 * 结果，是就删代码）。
 */
function presetColumns(preset: WorkbenchRegionLayoutPreset): number {
  switch (preset) {
    case 'columns-3': return 3
    case 'grid-4': return 2
    case 'grid-6': return 3
    case 'grid-9': return 3
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
    root: gridLayout(ids, presetColumns(preset)),
    activeRegionId: layout.activeRegionId
  }
}

function leafCount(root: WorkbenchRegionLayoutNode): number {
  return root.type === 'leaf' ? 1 : leafCount(root.first) + leafCount(root.second)
}

/**
 * 按叶子数配比：一个 split 的两侧各拿到与自身格数成正比的空间。
 *
 * 算出来的比例要过 `clampSplitRatio`（split-tree.ts 那份 SSOT）。这不是防御性的多余一层——
 * `addWorkbenchRegion` 每次追加都挂在同一个锚点上，于是 N 格会长成一条梳子（见 workbench-tabs.ts
 * 的注释），最外层那个 split 的两侧是 N-1 : 1，配比 (N-1)/N。N=7 时它是 0.857，已经越过
 * `1 - MIN_SPLIT_RATIO` = 0.85；N 越大越界的层数越多。视图会把越界的比例夹回去再画，所以症状不是
 * 画错，而是**存进去的值与画出来的值不一致**：拖一次分隔条的提交器观察到被夹过的布局，又把修正值写
 * 回 store，于是有一帧跳动加一次多余的写入。夹在源头，模型里就不存在越界的比例。
 *
 * 要说清楚的是**这一层夹的是 split 的比例，不是格子的宽度**。N≥7 的梳子里「每格恰好 1/N 宽」在数学上
 * 就做不到——那要求最外层 split 的比例是 (N-1)/N > 0.85，本身就越界。所以 #470 那句「每格均分」在
 * N≥7 时会弯，弯的原因是梳子这个形状，不是这次的夹取；换成平衡二叉的骨架才是它的解法，不在本函数
 * 职责内。
 *
 * `rowLayout` / `gridLayout` 刻意不夹：它们的 1/N 里 N 是每行的列数或行数，受 `presetColumns`
 * 约束在 3 以内，取值下限 1/3 天然在界内。这个前提由 `workbench-view-layout.test.ts` 里那条遍历
 * `WORKBENCH_LAYOUT_PRESETS` 的用例守着——加一档新预设就自动多一份覆盖，若它的几何算出越界比例，
 * 那条会红。宁可让前提被数据质询，也不要写一段永远不可能触发的夹取。
 */
function balanceNode(root: WorkbenchRegionLayoutNode): WorkbenchRegionLayoutNode {
  if (root.type === 'leaf') return root
  const first = balanceNode(root.first)
  const second = balanceNode(root.second)
  return {
    ...root,
    first,
    second,
    ratio: clampSplitRatio(leafCount(first) / (leafCount(first) + leafCount(second)))
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
  const newFirst = placementOf(direction) === 'first'
  return {
    root: replaceLeaf(layout.root, regionLeafId, targetRegionId, {
      type: 'split',
      direction: orientationOf(direction),
      first: newFirst ? added : target,
      second: newFirst ? target : added,
      ratio: EVEN_SPLIT_RATIO
    }),
    activeRegionId: newRegionId
  }
}

export function closeWorkbenchRegion(
  layout: WorkbenchViewLayout,
  regionId: string
): WorkbenchViewLayout {
  const currentRegionIds = regionIds(layout.root)
  if (currentRegionIds.length <= 1 || !currentRegionIds.includes(regionId)) return layout
  // 关闭活动格前先认下它的兄弟——那正是删掉这一片后被提升、长大占掉空位的那一格，焦点该落在它上面。
  // 此前这里取 remainingRegionIds.at(-1)（读序里的最后一格），与 tab-group 树关闭分组时用的
  // findSiblingGroupId（兄弟）不一致：同一个「关掉当前格」的动作，两条路把焦点送去不同地方。收敛到
  // 兄弟。sibling 为 null（理论上到不了：已过 length>1 且 regionId 在树里）时回退到读序末尾，保持
  // activeRegionId 始终指向一个仍在场的格。
  const sibling = findSiblingLeafId(layout.root, regionLeafId, regionId)
  const root = removeLeaf(layout.root, regionLeafId, regionId)
  if (!root) return layout
  const remainingRegionIds = regionIds(root)
  return {
    root,
    activeRegionId: layout.activeRegionId === regionId
      ? sibling ?? remainingRegionIds.at(-1)!
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

export function setWorkbenchRegionSplitRatio(
  layout: WorkbenchViewLayout,
  nodePath: string,
  ratio: number
): WorkbenchViewLayout {
  return { ...layout, root: setSplitRatioAtPath(layout.root, nodePath, ratio) }
}
