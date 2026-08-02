/**
 * 「我右边是什么」——方向寻址的判定层。
 *
 * 方向今天只存在于**创建**一侧：`AgentMuxOpenDestination` 有 `{kind:'split', region, direction}`，
 * 而 `inspect` 的两个 anchor 根本没有 direction 这个概念。于是 Agent 造得出一个右边，却问不出
 * 自己右边是什么——除非那一格恰好是它已知 id 的 Region。
 *
 * **创建与查看的默认落点不同，这是有意的，不是不一致**：创建一个方向只有一种诚实解释——用户
 * 要多一格，那就是 split（新开一个 Tab 不叫"在右边"）。而查看一个方向时，屏幕上"右边"的东西
 * 可能是同一 View 里的另一格 Region，**也可能在没有分栏时就是 Tab 条上相邻的那张 Tab**。查看端
 * 拒绝回答"没有分栏所以没有右边"，等于对着用户眼睛看得见的东西说不存在。
 *
 * 判定写成纯函数：本仓库测试用 `renderToStaticMarkup`，effect 不跑，写在组件或 store 回调里的
 * 分支没有断言够得着。
 */

import type { AgentMuxRegionNeighbor } from '@agentmux/core/control'
import type { WorkbenchRegionBounds } from './workbench-view-layout'
import { orientationOf, regionInDirection } from './split-direction'

/** 用户说的那四个方向。与 `open` 的 direction 同名同义，不另起一套词。 */
export type AddressDirection = 'left' | 'right' | 'up' | 'down'

/** 判定只需要这些事实——不接整个 store，也不接布局树本身。 */
export type DirectionalNeighborInput = {
  /** 出发点所在 Region。 */
  regionId: string
  /** 同一 View 内所有 Region 的归一化几何，来自既有的 `workbenchRegionBounds`。 */
  regions: ReadonlyArray<{ regionId: string; bounds: WorkbenchRegionBounds }>
  /** 出发点所在 Tab。 */
  tabId: string
  /** 该 Tab 所在 Group 的 Tab 顺序，来自既有的 `findGroupForTab(...).tabOrder`。 */
  tabOrder: readonly string[]
}

/**
 * 同一 View 内该方向上最近的兄弟 Region。
 *
 * 几何判定本身（重叠约束、最近、并列取稳定）全部委托给 `split-direction` 的 `regionInDirection`——
 * 那是「某方向上是哪一格」的唯一真相，键盘焦点移动（`workbench-shortcuts.adjacentRegionId`）走的是
 * 同一个函数，于是 Agent 侧 `inspect` 报出的邻居与用户按方向键聚焦到的格子恒等。本函数只把寻址侧的
 * 输入形状（`DirectionalNeighborInput.regions`）转交过去。
 */
export function regionNeighbor(
  input: DirectionalNeighborInput,
  direction: AddressDirection
): string | null {
  return regionInDirection(input.regions, input.regionId, direction)
}

/**
 * Tab 条上该方向的相邻 Tab。
 *
 * **up/down 对 Tab 不成立**：Tab 条是一维水平序列，"上面那张 Tab"没有所指。此时如实返回 null，
 * **不许把 up/down 折成 prev/next**——那会让 Agent 以为自己拿到了上方的东西，实际拿到的是左边
 * 那张，而且它无从发现自己被骗了。
 */
export function tabNeighbor(
  input: DirectionalNeighborInput,
  direction: AddressDirection
): string | null {
  // up/down 沿纵轴，对一维水平 Tab 条不成立。轴的派生取自 `split-direction` 的 SSOT，不另抄一份。
  if (orientationOf(direction) !== 'horizontal') return null
  const index = input.tabOrder.indexOf(input.tabId)
  if (index < 0) return null
  return input.tabOrder[direction === 'right' ? index + 1 : index - 1] ?? null
}

/**
 * 「我左边/右边/上面/下面是什么」的答案。
 *
 * **优先级由"屏幕上更近"决定：先 Region 后 Tab**。同一 View 内有分栏时，方向必须落在 Region
 * 上——那才是用户视线里紧挨着的那一格；只有该方向上没有兄弟 Region 时，才退到 Tab 邻接。反过来
 * （先 Tab）会让一个分了栏的 View 把用户指向另一张 Tab，与所见不符。
 *
 * 返回的就是 Control 契约里的 `AgentMuxRegionNeighbor`，不在渲染层另抄一份结构相同的类型。
 * 其中 `none` 与"报错"是两回事：最右一格问 right 是一个**合法问题的合法答案**，不是失败。
 * 抛异常会让 Agent 以为自己问错了，而它只是到边了。
 */
export function directionalNeighbor(
  input: DirectionalNeighborInput,
  direction: AddressDirection
): AgentMuxRegionNeighbor {
  const region = regionNeighbor(input, direction)
  if (region) return { kind: 'region', regionId: region }
  const tab = tabNeighbor(input, direction)
  if (tab) return { kind: 'tab', tabId: tab }
  return { kind: 'none' }
}
