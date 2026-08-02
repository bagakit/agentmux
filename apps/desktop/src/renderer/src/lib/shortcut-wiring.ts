// 每个 scope 的「壳」在哪、它用什么机制把匹配出的 id 变成真的动作。
//
// 为什么需要这张表：注册表把「哪个键是哪个动作」收成了一处，但「匹配出 id 之后到底有没有人执行它」
// 分散在四个各自不同的壳里——window 走 handler map（`routeWindowShortcut` 查 `handlers[id]`），
// terminal 走 `shortcutId === 'id'` 的分支，editor 走 Monaco 的 `addCommand`，launcher 走一条谓词闸。
// 这四条路各自都有守卫，但**四条守卫是四种写法**，于是加第五个 scope 时：
//   - `shortcut-cheat-sheet.ts` 的 `groupIdForBinding` 会 tsc 报错（`never` 穷尽）；
//   - `CHEAT_SHEET_GROUP_IDS` 那道逐 scope 守卫会红；
//   - `shortcut-registry.test.ts` 冻结 id 集那条会红；
//   - 而「这个 scope 的壳有没有接住它的绑定」**一条都不会红**——没有任何测试遍历
//     {@link SHORTCUT_SCOPES} 要求每个 scope 都存在一条被执行的路径。新 scope 的绑定可以带着
//     正确的和弦、正确的 cheat-sheet 分组发货，而用户按下去什么都不发生。
//
// 这张表就是那条缺失的元守卫的落点。它是 `Record<ShortcutScope, …>`，所以**加一个 scope 时 tsc 在这里
// 先报错**，逼迫作者回答「这个 scope 的壳是谁、按哪种机制执行」；守卫再按 `kind` 分派到对应的检查上。
//
// 为什么它住在 src 而不是 test 里：本仓 desktop 的 tsconfig 只 include `src/**`（记忆
// desktop-tsc-does-not-see-tests），写在测试文件里的 `Record<ShortcutScope, …>` 得不到任何穷尽检查——
// 那样这张表就退化成一份手抄清单，漏一行照旧静默。它没有运行期消费者，唯一消费者是那道守卫；这一点
// 与 `CHEAT_SHEET_GROUP_IDS`「导出是为了让守卫能质询」同源，不是「声明了却没人消费」的那种字段。

import { SHORTCUT_SCOPES, type ShortcutScope } from './shortcut-registry'

/**
 * 壳把匹配出的 id 变成动作的机制。守卫按这个值挑检查方式，所以它不是一个描述性标签——
 * 选错了机制，那个 scope 的检查就会用错的方式去问，问不出来就是红。
 *
 * - `handler-map`：壳查一张 `Record<id, () => boolean>`。**可运行期质询**：直接向那份 map 要 handler。
 * - `id-comparison`：壳里对匹配出的 id 做 `=== 'x'` / `!== 'x'` 比较。本仓组件测试走
 *   `renderToStaticMarkup`（effect 不跑、发不出 keydown），所以这类只能读源码断言那个比较在场——
 *   判据锚在带比较运算符的形状上，注册表 import 进来的裸字符串不满足它。
 * - `monaco-command`：壳把和弦交给 Monaco 的 `addCommand`。两侧都要：和弦能表达给 Monaco
 *   （`monacoKeybindingFor` 不抛），且壳真的按 id 取了那条绑定。
 */
export type ShortcutWiringKind = 'handler-map' | 'id-comparison' | 'monaco-command'

export interface ScopeWiring {
  kind: ShortcutWiringKind
  /**
   * 壳的模块路径，相对 `src/renderer/src/`。守卫要读它，所以路径写错会 ENOENT 响亮失败——
   * 这是刻意的：宁可让守卫炸在「找不到壳」上，也不要它悄悄跳过这个 scope 变成恒绿。
   */
  shell: string
}

/**
 * 每个 scope 一行。加 scope 时 tsc 在这里先红（缺键），这是这张表存在的全部理由。
 *
 * 注意 `window` 那一行指的是 handler map 的**产出处**（`windowShortcutHandlers`），不是挂监听的
 * `App.tsx`。「监听挂上了吗」与「map 覆盖了每条绑定吗」是两件各自能坏的事，前者由
 * workbench-shortcut-wiring.test.tsx 守；这张表守的是后者——匹配出 id 之后有没有人执行它。
 */
export const SHORTCUT_WIRING: Record<ShortcutScope, ScopeWiring> = {
  window: { kind: 'handler-map', shell: 'lib/workbench-shortcuts.ts' },
  terminal: { kind: 'id-comparison', shell: 'components/TerminalView.tsx' },
  editor: { kind: 'monaco-command', shell: 'components/EditorPane.tsx' },
  launcher: { kind: 'id-comparison', shell: 'lib/launcher-submit.ts' }
}

/**
 * 这张表与 scope 清单逐键对齐吗。
 *
 * `Record<ShortcutScope, …>` 挡住的是「少一行」，挡不住「多一行」——一个已删掉的 scope 留在表里会让
 * 守卫去检查一个不存在的 scope（那一轮必然抽到零条绑定，于是恒绿）。两侧都要判，所以这个函数返回
 * 双向的差集而不是一个布尔：守卫要能说出**是哪个键**对不上，而不是只说「不一致」。
 */
export function wiringScopeDrift(): { missing: string[]; extra: string[] } {
  const declared = new Set<string>(SHORTCUT_SCOPES)
  const covered = new Set(Object.keys(SHORTCUT_WIRING))
  return {
    missing: [...declared].filter((scope) => !covered.has(scope)),
    extra: [...covered].filter((scope) => !declared.has(scope))
  }
}
