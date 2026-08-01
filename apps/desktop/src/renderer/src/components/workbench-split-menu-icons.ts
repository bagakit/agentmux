import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Columns3,
  Grid2x2,
  Grid3x3,
  LayoutGrid
} from 'lucide-react'
import type { SplitDirection } from '../lib/workbench-layout'
import type { WorkbenchRegionLayoutPreset } from '../lib/workbench-view-layout'
import type { WorkbenchSplitMenuEntry } from '../lib/workbench-tab-actions'

/**
 * 分屏方向与布局预设的图标——**一份**，全部菜单容器共用。
 *
 * 此前 `SPLIT_ICONS` 在 PaneSplitMenu 与 WorkbenchTabContextMenu 里各写一遍、逐字相同且互不
 * import。四个方向的图标恰好没漂移过，但那是运气：本仓刚修完的一颗真缺陷正是「图标表达的方向
 * 与它承诺的落点相反」（链接目的地那一行，四个箭头同时反了）。同一族图标散在多个文件里，就意味着
 * 修对一处而另几处静默留着反的那份，且每个容器各自的测试照旧全绿。
 *
 * 写成按判别式索引的完整映射而不是渲染时的三元链：`SplitDirection` 与
 * `WorkbenchRegionLayoutPreset` 都是字面量联合，少一个键 tsc 就不过——将来加一个方向或一档预设，
 * 编译器会替我们记得配图标。
 */
const SPLIT_ICONS = {
  left: ArrowLeft,
  right: ArrowRight,
  up: ArrowUp,
  down: ArrowDown
} satisfies Record<SplitDirection, typeof ArrowRight>

const PRESET_ICONS = {
  'columns-3': Columns3,
  'grid-4': Grid2x2,
  'grid-6': LayoutGrid,
  'grid-9': Grid3x3
} satisfies Record<WorkbenchRegionLayoutPreset, typeof Grid2x2>

/**
 * 一个方向的图标。除了分屏菜单，Tab 菜单的「移到新组」也按方向出图标——那是另一个动作
 * （搬 Tab，不是分格），但「左就是这个箭头」必须是同一个答案，否则同一张菜单里两处朝向不一致。
 */
export function workbenchSplitDirectionIcon(direction: SplitDirection): typeof ArrowRight {
  return SPLIT_ICONS[direction]
}

/** 一档预设的图标。 */
export function workbenchRegionPresetIcon(
  preset: WorkbenchRegionLayoutPreset
): typeof Grid2x2 {
  return PRESET_ICONS[preset]
}

/**
 * 一条条目的图标。分隔线没有图标，故它不在这个函数的输入里——调用方在 map 时已经按 kind 分了岔，
 * 传进来的必然是可点的那两种。
 */
export function workbenchSplitMenuIcon(
  entry: Extract<WorkbenchSplitMenuEntry, { kind: 'split' | 'preset' }>
): typeof ArrowRight {
  return entry.kind === 'split'
    ? workbenchSplitDirectionIcon(entry.direction)
    : workbenchRegionPresetIcon(entry.preset)
}

/**
 * 一条条目在 React 里的稳定 key。分隔线用它在清单里的位置（同一份清单里最多一条，但位置是它
 * 唯一的身份），其余用判别值本身。
 */
export function workbenchSplitMenuKey(entry: WorkbenchSplitMenuEntry, index: number): string {
  if (entry.kind === 'separator') return `separator-${index}`
  return entry.kind === 'split' ? entry.direction : entry.preset
}
