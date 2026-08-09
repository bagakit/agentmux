// 方向的几何真相——「我某个方向上是哪一格 Region」只在这里回答一次。
//
// 为什么必须只有一处：这个问题此前有**两个**答案，各带一套数学。一个服务 Agent 侧寻址
// （`directional-addressing` 的 `regionNeighbor` → `inspect` 报给 Agent 的 neighbors），要求
// 另一根轴上有重叠；另一个服务键盘焦点移动（`workbench-shortcuts` 的 `adjacentRegionId`），
// 不设重叠判定、改用中心最近。对同一份 `workbenchRegionBounds`、同一个出发点与方向，两者会给出
// 不同的格子：一个斜错开、纵向不与出发点重叠的右上格，对 Agent 是「右边没有东西」，对键盘却正是
// 按「向右」聚焦到的那一格。于是 Agent 被告知「你右边什么也没有」，紧挨着它的却是用户一按右键就
// 到达的格子——而将来「把我和右边那格互换」会换到与 Agent 认知不同的一格。方向必须只有一个含义。
//
// 判定写成纯函数、不接布局树本身：本仓库组件测试用 `renderToStaticMarkup`，effect 不跑，写在组件或
// store 回调里的分支断言够不着；而几何判定是承重的，必须留在够得着的地方。

import type { SplitDirection } from './workbench-layout'
import type { WorkbenchRegionBounds } from './workbench-view-layout'

/** 一格 Region 的 id 与它在单位面上的归一化几何，来自既有的 `workbenchRegionBounds`。 */
export type RegionGeometry = { regionId: string; bounds: WorkbenchRegionBounds }

/**
 * 归一化几何的唯一比较容差。
 *
 * bounds 由 ratio 连乘得出，`0.5 + 0.25 + 0.25` 这类拆分会在同一条边上留下浮点尾数：origin 的边缘
 * 可能落在 `0.1 + 0.2 = 0.30000000000000004`，而邻格的边缘是干净的 `0.3`——比它小。零容差下「邻格
 * 贴着我」这一判定就不成立，明明相邻的两格会答成不相邻。取 1e-6 是因为分屏比例的有效精度远粗于此，
 * 这个量级只吃掉浮点误差，不会把真正错开的两格误判成对齐。
 *
 * 此前两处判定各带一个容差（寻址侧 1e-6、键盘侧 1e-9），值不同本身就是两份真相漂移的征兆。收成一个。
 */
export const REGION_GEOMETRY_EPSILON = 1e-6

/**
 * 该方向沿横轴（left/right）还是纵轴（up/down）。方向→轴的派生只在这里算一次。
 *
 * 写成**无 `default` 的穷举 switch**，与下面 `edgeGap` 同形，不是 `... ? 'horizontal' : 'vertical'`
 * 那种三元。三元的 `: 'vertical'` 是个默认桶：给 union 加第五个方向（比如将来的 `previous`），它会
 * 静默落进 vertical，没有编译错、没有红测试——正是本仓反复被咬的那一类「带兜底臂的 union 投影」。
 * 无 default 的 switch 让返回类型不再覆盖新成员的路径，tsc 当场以 TS2366 报红，逼这一档显式作答。
 * （实测：临时给 SplitDirection 加一个成员，此函数改回三元时 tsc 沉默、改成本 switch 时报
 * `split-direction.ts: TS2366 Function lacks ending return statement`。）
 */
export function orientationOf(direction: SplitDirection): 'horizontal' | 'vertical' {
  switch (direction) {
    case 'left':
    case 'right':
      return 'horizontal'
    case 'up':
    case 'down':
      return 'vertical'
  }
}

/**
 * 新来的那一格落在拆分节点的哪一侧：`first` 是轴的前半（左 / 上），`second` 是后半（右 / 下）。
 *
 * 这是方向的第二半真相，和 {@link orientationOf} 成对——「向左分屏」既意味着横轴（哪根轴），也意味着
 * 新格在前（哪一侧），两个答案缺一不可。此前 `orientationOf` 已经收在这里，而这一半散在两个建树函数里
 * 各写一遍（region 树的 `splitWorkbenchRegion`、tab-group 树的 `moveTabToNewGroup`），且**没有任何一处
 * 声称自己是 SSOT**。
 *
 * 为什么这一半更危险：轴判错会立刻看出来（该左右分的变成上下分），而侧判错只是新格出现在反侧——
 * 它看起来完全像一个正常的分屏，只是方向反了。本仓刚修过逐字同形的一颗真缺陷（链接目的地那一行四个
 * 箭头同时反了），症状就是"能用但反着"。两份手抄各自正确纯属它们是同一天写的；改一处而另一处不跟上，
 * 两棵树会对同一个「向左」给出相反的落点，而两边各自的测试照旧全绿——它们各自断言的是自己那棵树。
 *
 * 判据成对：`up` 与 `left` 都是 `first`，靠的是"轴的前半"这一个概念，不是两条巧合。
 *
 * 与 {@link orientationOf} 同理，写成**无 `default` 的穷举 switch** 而非 `... ? 'first' : 'second'`：
 * 三元的 `: 'second'` 是默认桶，给 union 加一个方向会让新成员静默判成 `second`（新格出现在反侧、
 * 看起来完全像一次正常分屏），零编译错、零红测试——本仓多次被咬的那类隐性回归。无 default 的 switch
 * 让 tsc 以 TS2366 挡住新增而未作答的成员。
 */
export function placementOf(direction: SplitDirection): 'first' | 'second' {
  switch (direction) {
    case 'left':
    case 'up':
      return 'first'
    case 'right':
    case 'down':
      return 'second'
  }
}

/**
 * `candidate` 沿 `direction` 越过 `origin` 前沿边的距离（带符号）。
 *
 * 「前沿边」是 origin 朝该方向的那条边（向右看是右边缘 `x + width`，向左看是左边缘 `x`……），
 * 拿它和 candidate 朝回望向 origin 的那条边相减。结果 ≥ 0（配合容差）表示 candidate 确实在 origin
 * 的该方向一侧、而不是与它交叠或在反方向。
 */
function edgeGap(
  origin: WorkbenchRegionBounds,
  candidate: WorkbenchRegionBounds,
  direction: SplitDirection
): number {
  switch (direction) {
    case 'right': return candidate.x - (origin.x + origin.width)
    case 'left': return origin.x - (candidate.x + candidate.width)
    case 'down': return candidate.y - (origin.y + origin.height)
    case 'up': return origin.y - (candidate.y + candidate.height)
  }
}

/**
 * candidate 是否在另一根轴上与 origin 有重叠。
 *
 * 这是「方向」的核心约束，也是本模块存在的原因。只判「沿该轴更靠外」会把斜对角那一格也算成「右边」，
 * 而用户说「右边」指的是视线平移过去撞上的那一格，不是任何 x 更大的格子。用严格不等（配合容差），
 * 仅仅边缘相接不算重叠——那是对角关系。
 */
function crossOverlaps(
  origin: WorkbenchRegionBounds,
  candidate: WorkbenchRegionBounds,
  orientation: 'horizontal' | 'vertical'
): boolean {
  const eps = REGION_GEOMETRY_EPSILON
  if (orientation === 'horizontal') {
    return candidate.y < origin.y + origin.height - eps && origin.y < candidate.y + candidate.height - eps
  }
  return candidate.x < origin.x + origin.width - eps && origin.x < candidate.x + candidate.width - eps
}

/** 另一根轴上的近端坐标，用来在并列候选里取稳定的那一个（横向取 y、纵向取 x）。 */
function crossCoordinate(bounds: WorkbenchRegionBounds, orientation: 'horizontal' | 'vertical'): number {
  return orientation === 'horizontal' ? bounds.y : bounds.x
}

/**
 * 同一 View 内，`origin` 沿 `direction` 相邻的那一格 Region 的 id；没有则 `null`。
 *
 * 选法（对 Agent 寻址与键盘焦点是同一套，不再分家）：
 *   1. 候选必须**沿该轴在那一侧**（`edgeGap ≥ 0`）**且在另一根轴上与 origin 重叠**（`crossOverlaps`）。
 *      重叠这一关是刻意保留的——见 `crossOverlaps` 注释。这也是本函数取代原键盘实现的那条规则：
 *      原键盘实现声称「中心最近的排序会让斜对角格自然落选，不需要重叠判定」，但那条前提是错的，
 *      **在完整平铺下也能构造出反例**：一个大而重叠的格中心离 origin 更远、一个小而斜错开、另一轴不
 *      重叠的格中心反而更近，于是「中心最近」选中了不重叠的斜格。见 `directional-region-ssot.test.ts`
 *      的 `OVERLAP_GATE_TREE`（ORIGIN 问 up，旧键盘选不重叠的 DIAG、本函数选真正在上方的 ABOVE；
 *      那条 fixture 同时钉住删掉 `crossOverlaps` 会让答案变错，即这道闸不是死代码）。该前提已作废；
 *      重叠必须显式判。另外本函数接受任意 `RegionGeometry[]`（不限完整平铺），重叠判定在只喂进部分
 *      格子时同样是「那个方向」的正确定义，不靠「平铺一定铺满」这条外部前提兜底。
 *   2. 多个候选取沿该方向**最近**的一格（`edgeGap` 最小）。
 *   3. 仍并列时取另一根轴上坐标更小（更靠前）的那一格，让答案对同一份布局稳定——不稳定的答案会让
 *      Agent 两次问同一个问题得到不同的格子。
 *
 * 出发点不在 `regions` 里（布局刚变、投影没跟上）时返回 `null`，不猜。
 */
export function regionInDirection(
  regions: ReadonlyArray<RegionGeometry>,
  originId: string,
  direction: SplitDirection
): string | null {
  const origin = regions.find((region) => region.regionId === originId)?.bounds
  if (!origin) return null
  const orientation = orientationOf(direction)
  const eps = REGION_GEOMETRY_EPSILON
  let best: RegionGeometry | null = null
  let bestGap = 0
  for (const region of regions) {
    if (region.regionId === originId) continue
    const gap = edgeGap(origin, region.bounds, direction)
    if (gap < -eps) continue
    if (!crossOverlaps(origin, region.bounds, orientation)) continue
    if (best === null) {
      best = region
      bestGap = gap
      continue
    }
    if (gap < bestGap - eps) {
      best = region
      bestGap = gap
      continue
    }
    if (gap > bestGap + eps) continue
    if (crossCoordinate(region.bounds, orientation) < crossCoordinate(best.bounds, orientation)) {
      best = region
      bestGap = gap
    }
  }
  return best?.regionId ?? null
}
