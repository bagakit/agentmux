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
 *
 * **本文件已知的盲点（明说，免得下一个人以为方向已经全锁上了）**：文末
 * `_addressDirectionMatchesControlProtocol` 那道证明只锁**集合成员**——渲染层的 `SplitDirection` 与
 * 控制协议 `AgentMuxOpenDestination.direction` 逐字相等。它锁不住两类东西：
 *   1. 把方向 union 又抄成**运行时 `string[]` / 三元**的校验器。Core 侧至今有两处（`control-host.ts`
 *      的 `openDestination` 用 `['left','right','up','down'].includes(...)`，`agentmux.ts` 的
 *      `openDestination` 用 `? 'left' : … : 'down'` 的兜底三元）——删/加一个方向它们不报错、无红测试，
 *      症状是那个方向被静默拒绝或投影错。它们在 `packages/core`，不在本 lane 的可改文件内；方向没有
 *      运行时元组 SSOT（不像预设的 `WORKBENCH_LAYOUT_PRESETS`）正是根因。真正的修法是在 Core 建一个
 *      `SPLIT_DIRECTIONS` 元组 + `isSplitDirection` 谓词，让那两处从它派生——留作后续。
 *   2. `orientationOf`/`placementOf`（split-direction.ts）里**对调两个 case 返回值**这类变异：tsc 对它
 *      沉默（实测两次变异 tsc 均 exit 0），挡它的是运行时值断言（`workbench-view-layout.test.ts` 的
 *      逐方向 axis/order 用例、`directional-region-ssot.test.ts`），不是本证明。
 */

import type { AgentMuxOpenDestination, AgentMuxRegionNeighbor } from '@agentmux/core/control'
import type { SplitDirection } from './workbench-layout'
import type { WorkbenchRegionBounds } from './workbench-view-layout'
import { orientationOf, placementOf, regionInDirection } from './split-direction'

/**
 * 用户说的那四个方向。与 `open` 的 direction 同名同义，不另起一套词。
 *
 * 刻意写成 `SplitDirection` 的别名而不是重新列一遍那四个字面量：那样它与渲染层的方向真相（哪根轴、
 * 哪一侧由 `split-direction` 的 `orientationOf`/`placementOf` 拆）在编译期就是同一个集合。那两个拆解
 * 函数是**无 `default` 的穷举 switch**：给 `SplitDirection` 加第五个方向而不在每个 case 作答，tsc 当场
 * 以 TS2366 报红（实测——见本文件末尾 `_addressDirectionMatchesControlProtocol` 上方那段实验记录）。
 * 于是渲染层内部这一侧不存在「多出来的成员静默落进 else 桶」的隐患。
 */
export type AddressDirection = SplitDirection

/**
 * 渲染层的方向集合（`SplitDirection`）与**控制协议**的方向集合必须逐字相等。
 *
 * 这是本仓最常复发的缺陷族——「一个 union 被抄成第二份，tsc 看不见它们之间的漂移」——在方向上唯一还
 * 没上锁的一处。方向被独立手写在**两个包**里：渲染层的 `SplitDirection`（workbench-layout.ts），和
 * Core 控制协议 `AgentMuxOpenDestination` 里 `split` 分支的 `direction` 字段（control.ts）。两处今天
 * 恰好都是 `'left' | 'right' | 'up' | 'down'`，但那是两处同时写对，不是类型逼出来的：Agent 用
 * `open --left-of` 造得出一个方向，`inspect` 用同名方向问「我左边是什么」（`directionalNeighbor` 返回
 * 的就是控制契约的 `AgentMuxRegionNeighbor`）。任一侧加/删一个方向而另一侧没跟上，Agent 就会造出一个
 * 查不回来、或查得出却造不成的方向，而两个包各自的测试照旧全绿。
 *
 * 下面这道双向 `extends` 证明把两份手抄锁在一起：`ControlSplitDirection ⊆ SplitDirection` 且
 * `SplitDirection ⊆ ControlSplitDirection`。任一方向的包含关系断裂，对应那一半就从 `true` 塌成
 * `never`，而 `never` 不能赋给 `true` 的槽位——于是漂移是一处**点名了是哪一半失败**的编译错误，
 * 落在渲染层这个 `src/` 文件里（真正的 `tsc --noEmit -p tsconfig.json` 门禁看得见的地方）。同
 * `workbench-layout-preset.ts` 的 `_presetTupleIsExactlyTheUnion`：那边把预设 union 与它的运行时元组
 * 锁在一起，这边把方向 union 与控制协议锁在一起。`void` 让这道证明不至于被读成死变量。
 *
 * 为什么不各写成 `(typeof T)[number]` 从一处派生：方向在这里天生没有运行时元组可派生（`SplitDirection`
 * 是纯类型，控制协议那份也是），两侧各自独立写出、由本证明绑定，才使得任一侧漂移是一处响亮的编译错误
 * ——若从同一处派生，两半都退化成 `X extends X` 恒真，证明成了永不失败的死代码。
 *
 * **上一段不只是叮嘱，有人钉着**：把 `ControlSplitDirection` 改成 `= SplitDirection`（即让证明从自己
 * 的另一半派生）实测 `tsc --noEmit` **exit 0** 且相关两个 suite 43 条全绿——这道证明当场变成永不失败的
 * 装饰。所以判据不能只是「证明在场」。`directional-region-ssot.test.ts` 的
 * 「方向的跨包证明必须真的跨包」用 checker 顺着别名链追每一半 `extends` 两侧的**定义出处**，要求恰好是
 * 一半 core→renderer、一半 renderer→core；那次变异现在红。判出处不判拼法，所以把 `Extract<…>` 直接内联
 * 进元组这类等价改写照旧通过（也实测过）。
 */
type ControlSplitDirection = Extract<AgentMuxOpenDestination, { kind: 'split' }>['direction']
const _addressDirectionMatchesControlProtocol: [
  ControlSplitDirection extends SplitDirection ? true : never,
  SplitDirection extends ControlSplitDirection ? true : never
] = [true, true]
void _addressDirectionMatchesControlProtocol

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
  // 侧的派生同样取自 SSOT。上一行的闸已经把 up/down 挡掉，所以到这里只剩 left/right——此时「是不是
  // right」问的恰好就是 `placementOf` 的那个问题（在这根轴的前半还是后半），而 Tab 条的序号就是这根轴。
  // 写成 `direction === 'right'` 会是第五份手抄：它今天与 `placementOf` 一致纯属两处同时正确，一旦分岔，
  // 「在 Tab 条上往右拖」与「向右分屏」会朝相反方向走，而两边各自的测试照旧全绿。
  return input.tabOrder[placementOf(direction) === 'second' ? index + 1 : index - 1] ?? null
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
