/**
 * 分屏方向的运行时 SSOT——`left/right/up/down` 这四个方向此前只以纯类型存在
 * （`@agentmux/layout` 的 `SplitDirection`、`control.ts` 的 `AgentMuxOpenDestination.direction`），
 * 却被两处 Core 侧运行时校验各自**手抄**成了第二份清单：
 *   - `control-host.ts` 的 `openDestination` 用 `['left','right','up','down'].includes(...)`；
 *   - `agentmux.ts` 的 `openDestination` 用 `? 'left' : … : 'down'` 的**兜底三元**。
 * 一个 `string[]` 对 `.includes` 只是 `string[]`，删/加一个方向不编译报错、无红测试——审计实测从
 * control-host 那份清单删掉 `'up'`（合法的 split-up 被静默判成 `INVALID_CONTROL_REQUEST`）后，1203 条
 * 全绿、`tsc --noEmit` exit 0，零测试察觉。三元的 `: 'down'` 更险：一个写错或新增的 flag 会**静默落进
 * down** 而不是报错。
 *
 * 现在只有这一份：元组是 SSOT，`SplitDirection` 由元组派生（类型与运行时清单不可能漂移），CLI flag 的
 * 方向映射 {@link SPLIT_FLAG_DIRECTIONS} 与成员判定 {@link isSplitDirection} 都从这里长出来。与
 * `workbench-layout-preset.ts` 的 `WORKBENCH_LAYOUT_PRESETS`、`control.ts` 的
 * `AGENTMUX_EXECUTOR_AVAILABILITIES` 同源。
 *
 * **为什么 SSOT 落在 `packages/core` 而不是 `@agentmux/layout`（后者今天拥有 `SplitDirection` 类型）**：
 * 两处消费者都在 core（control-host / agentmux），而依赖方向是 **layout → core**——`packages/layout` 的
 * package.json 依赖 `@agentmux/core`，且已从 `@agentmux/core/workbench-layout-preset` 取预设清单；反向
 * `grep '@agentmux/layout' packages/core/src` 为空，core 不 import layout。把运行时元组放进 layout 再让
 * core 从它派生，会造成 core→layout 的反向依赖（环）。所以 SSOT 建在 core，与预设清单同一处。layout 侧的
 * `SplitDirection` 类型经 `directional-region-ssot.test.ts` 已有的跨包 exactness 证明与控制协议锁死，
 * 本模块下面这道 core 侧证明再把运行时元组锁到同一个控制协议 union 上，两道证明各在自己的 tsc 门禁里。
 */
// type-only import：编译后擦除，不构成运行时环（control.ts 的值导入只有 errors.js，其余两条
// `import type` 同样擦除，运行时是叶子）。
import type { AgentMuxOpenDestination } from './control.js'

export const SPLIT_DIRECTIONS = ['left', 'right', 'up', 'down'] as const

/**
 * 分屏方向的类型全集，**派生自元组**，故运行时清单与本类型不可能漂移。控制协议
 * `AgentMuxOpenDestination.direction` 与 `@agentmux/layout` 的 `SplitDirection` 都逐字等于它——那两处的
 * 相等由下面的证明与跨包证明分别钉住。
 */
export type SplitDirection = (typeof SPLIT_DIRECTIONS)[number]

// 双向 exactness：运行时元组 === 控制协议的方向 union。
//
// 刻意拿**控制协议**（`AgentMuxOpenDestination` 的 direction，独立写在 control.ts 里的字面量 union）当
// 另一半，而不是拿本模块自己派生的 `SplitDirection`：后者 `SplitDirection extends SplitDirection` 两半都
// 恒真，证明退化成永不失败的死代码（记忆 surviving-mutation-may-be-dead-condition，预设那份同款注释亦
// 记）。控制协议那份是消费者真正 `as`/赋值过去的类型，把元组锁到它身上才有意义：
//   - 元组少一档（比如删 `'up'`）→ `ControlSplitDirection extends 元组` 塌成 `never`，第 1 槽 TS2322；
//   - 元组多一档（比如加 `'sideways'`）→ `元组 extends ControlSplitDirection` 塌成 `never`，第 0 槽 TS2322。
// `void` 让这道证明不至于被读成死变量。同 `workbench-layout-preset.ts` 的 `_presetTupleIsExactlyTheUnion`。
type ControlSplitDirection = Extract<AgentMuxOpenDestination, { kind: 'split' }>['direction']
type SplitDirectionTupleEntry = (typeof SPLIT_DIRECTIONS)[number]
const _splitDirectionsAreExactlyTheControlProtocol: [
  SplitDirectionTupleEntry extends ControlSplitDirection ? true : never,
  ControlSplitDirection extends SplitDirectionTupleEntry ? true : never
] = [true, true]
void _splitDirectionsAreExactlyTheControlProtocol

/**
 * 一个任意字符串是不是合法方向——成员判定的 SSOT，同时把入参从 `string` 收窄成 {@link SplitDirection}。
 * 取代 `control-host.ts` 里的内联 `['left','right','up','down'].includes(...)`：那处删一档不报错、无测试发红。
 */
export function isSplitDirection(value: string): value is SplitDirection {
  return (SPLIT_DIRECTIONS as readonly string[]).includes(value)
}

/**
 * `agentmux open --<方向>-of` 的方向 flag → {@link SplitDirection} 的**总映射**，取代 `agentmux.ts` 里
 * `? 'left' : … : 'down'` 那条带兜底桶的三元。
 *
 * 三处收敛买到两样 tsc 保证：
 *   1. `satisfies Record<string, SplitDirection>`：任一 flag 映到一个非法方向（拼错、或映到已被删除的
 *      方向）当场编译错误——原三元把值直接写成字面量，写错成 `'downn'` 也无人管。
 *   2. 下面的覆盖证明：每个方向都必须有恰好一个 flag 指向它。往 `SPLIT_DIRECTIONS` 加一个方向却忘了给它
 *      一个 CLI flag，`SplitDirection extends MappedDirection` 塌成 `never`，TS2322——不再是「新方向从
 *      命令行根本够不到」的静默缺口。
 *
 * 调用方（`agentmux.ts` 的 `openDestination`）把喂给 `exactlyOne` 的 split flag 清单直接由本表的键派生，
 * 于是「哪些 flag 是方向 flag」也只有这一处。查表未命中时它**显式抛错**而不是兜底 down——见那里的注释：
 * 今天该分支不可达（`exactlyOne` 只返回它收到的清单里的项），保留它是为了让将来新增 flag 却漏配方向时
 * 响亮失败。
 */
export const SPLIT_FLAG_DIRECTIONS = {
  '--left-of': 'left',
  '--right-of': 'right',
  '--above': 'up',
  '--below': 'down'
} as const satisfies Record<string, SplitDirection>

// 覆盖证明：本表产出的方向集合恰好覆盖 SplitDirection 全集。加方向不加 flag → 下面这半塌成 never。
type MappedDirection = (typeof SPLIT_FLAG_DIRECTIONS)[keyof typeof SPLIT_FLAG_DIRECTIONS]
const _everyDirectionHasAFlag: SplitDirection extends MappedDirection ? true : never = true
void _everyDirectionHasAFlag
