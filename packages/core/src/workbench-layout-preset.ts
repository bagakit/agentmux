/**
 * 布局预设名的全集，作为运行时 SSOT——这一个元组既派生出成员判定 {@link isWorkbenchLayoutPreset}
 * 真正拿在手里的**值**，又被下面的双向 exactness 证明钉死在 {@link WorkbenchLayoutPreset} 类型上。
 *
 * 为什么要有这个模块：这份清单此前有**两份互不相干的**手抄——一份在 Core 的 `control.ts`
 *（`AgentMuxArrangeMode` 的 `preset` union），一份在 Desktop Renderer 的 `workbench-view-layout.ts`
 *（`WorkbenchRegionLayoutPreset`）。`tsc` 看不见它们之间的漂移：两份都是独立的字面量 union，
 * 编译器无从知道它们**该**相等。此外还有两处运行时成员判定把这份清单又抄成了**内联字符串数组**喂给
 * `.includes(...)`（`control-host.ts` 的请求校验、`agentmux.ts` 的 CLI 校验）——一个 `string[]` 对
 * `.includes` 而言只是 `string[]`，删掉其中一档（比如 `'grid-9'`）既不编译报错、也没有任何测试发红，
 * 症状是 `arrange --preset grid-9` 被静默判为非法。
 *
 * 现在只有这一份：元组是 SSOT，类型由 exactness 证明与它锁定，成员判定从元组派生。这与
 * `agent-provider-id.ts` 的 `BUILT_IN_AGENT_PROVIDER_IDS` 同源——元组是运行时可以拿在手里的值，
 * 类型与谓词都从它长出来。
 *
 * 本文件刻意不 import 任何 node 内置模块（连别的本仓模块都不 import），好让 Desktop Renderer 能
 * 直接用这份清单，而不必把 Core 的 process/filesystem 运行时一并拖进渲染进程（同 `agent-provider-id.ts`
 * 的理由）。
 */
export const WORKBENCH_LAYOUT_PRESETS = ['columns-3', 'grid-4', 'grid-6', 'grid-9'] as const

/**
 * 布局预设名的类型全集。所有消费者（控制协议的 `AgentMuxArrangeMode`、渲染器的
 * `WorkbenchRegionLayoutPreset`、图标表、格数表）都 import 这一个，不再各自手写字面量 union。
 *
 * 它是**独立写出来**的，不是 `(typeof WORKBENCH_LAYOUT_PRESETS)[number]`——这不是啰嗦，而是下面那道
 * 双向证明能不能真正发红的前提：若 union 从元组派生，`tuple[number] extends union` 与
 * `union extends tuple[number]` 都退化成 `(typeof T)[number] extends (typeof T)[number]`，无论元组是什么
 * 都恒为 `true`，证明变成永不失败的死代码（记忆 surviving-mutation-may-be-dead-condition）。两侧各自
 * 写出来、由证明绑定，才使得任一侧漂移都是一处**响亮的编译错误**——这正是把两份手抄 union 收敛成一处
 * 所要买到的东西。
 */
export type WorkbenchLayoutPreset = 'columns-3' | 'grid-4' | 'grid-6' | 'grid-9'

// 双向 exactness：元组 ⊆ union 且 union ⊆ 元组。每个条件只有在其包含关系成立时才是 `true`、否则是
// `never`，而 `never` 不能赋给 `true` 的槽位——于是任一方向的断裂都是一处点名了是哪一半失败的编译错误
//（元组里多/少一档而 union 没跟上，或反过来）。`void` 让这道证明不至于读成死变量。同 `workbench-surface-kinds.ts`
// 里 `_kindListIsExactlyTheUnion` 的形状。
type WorkbenchLayoutPresetTupleEntry = (typeof WORKBENCH_LAYOUT_PRESETS)[number]
const _presetTupleIsExactlyTheUnion: [
  WorkbenchLayoutPresetTupleEntry extends WorkbenchLayoutPreset ? true : never,
  WorkbenchLayoutPreset extends WorkbenchLayoutPresetTupleEntry ? true : never
] = [true, true]
void _presetTupleIsExactlyTheUnion

/**
 * 一个任意字符串是不是合法的布局预设名——成员判定的 SSOT，同时把入参从 `string` 收窄成
 * {@link WorkbenchLayoutPreset}。取代此前散在 `control-host.ts` 与 `agentmux.ts` 的两处内联
 * `[...].includes(...)`：那两处各抄一份清单，删一档不报错、无测试发红。这里只有元组一处，且返回类型
 * 谓词让调用方省掉自己的 `as` 断言。
 */
export function isWorkbenchLayoutPreset(value: string): value is WorkbenchLayoutPreset {
  return (WORKBENCH_LAYOUT_PRESETS as readonly string[]).includes(value)
}
