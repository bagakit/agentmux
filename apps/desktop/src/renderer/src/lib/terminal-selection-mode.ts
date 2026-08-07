// 为什么会有这个文件：AgentMux 里排第一的用户可见 bug——终端里右键 Copy 变灰、Ctrl+C 不复制、
// Cmd+C 也不复制，三者同时失效。根因**不在复制这条路上**，而在选区从一开始就没被建立起来。
//
// 机制读的是 vendored 的 @xterm/xterm 5.5.0 `lib/xterm.js`，不是推测：
//   - PTY 里的全屏 TUI 一旦开启鼠标上报（DECSET ?1000 / ?1002 / ?1003，或旧式 ?9），xterm 的
//     `onProtocolChange` 就 `this._selectionService.disable()`，而 `disable(){this.clearSelection(),this._enabled=!1}`。
//   - 此后 `handleMouseDown(e){… if(!this._enabled){if(!this.shouldForceSelection(e))return; …}}`：
//     选区服务停用时，一次平白左拖被**直接让给程序**，xterm 根本不建选区模型。
//   - 于是 `getSelection()` 恒为 `''`、`hasSelection()` 恒为 false。每一条复制路都以「有没有选区」
//     为闸，所以它们**一起**失效——这正是用户看到的三合一症状。
//   - 逃生手势早就配好了却完全无法发现：`shouldForceSelection(e){return isMac ? e.altKey && rawOptions.macOptionClickForcesSelection : e.shiftKey}`。
//     mac 上是 Option（⌥）拖、别处是 Shift 拖；mac 那条依赖 `macOptionClickForcesSelection: true`，
//     已在 `lib/terminal-theme.ts` 里开启。
//
// 判据是 xterm 的 `areMouseEventsActive`，源码里就是 `0 !== this._protocols[activeProtocol].events`。
// 五种模式的 `events` 位掩码逐字取自源码：NONE=0、X10=1、VT200=19、DRAG=23、ANY=31。所以除 `none`
// 以外的四种模式全都让 `areMouseEventsActive` 为真、全都关掉选区。
//
// 这个模块是纯的：它只从 `mouseTrackingMode` 回答 UI 需要的两个问题（会不会压制选区、该提示什么），
// 不碰 xterm 实例、不读 DOM。取值口作参数传入，好被直接调用并断言后果。

import type { Terminal } from '@xterm/xterm'
import { isMacPlatform } from './host-platform'

/**
 * xterm 公开出来的鼠标上报模式取值域。
 *
 * 用**索引访问**从 xterm 自己的类型派生，而不是手抄这五个字面量：xterm 若在某个版本里增删一种模式，
 * 这里会立刻编译报错，逼我们回来重新判断它进不进「压制」那一侧——手抄一份则会静默漂移。
 * 见 `@xterm/xterm` 的 `IModes.mouseTrackingMode`（`terminal.modes.mouseTrackingMode`）。
 */
export type MouseTrackingMode = Terminal['modes']['mouseTrackingMode']

/**
 * 每种模式的 `events` 位掩码是否非零，逐字取自 xterm 源码：NONE=0、X10=1、VT200=19、DRAG=23、ANY=31。
 *
 * 这张表活在 `src/` 而不是测试里，**因为只有这里的编译期检查真的会被执行**：`apps/desktop/tsconfig.json`
 * 的 `include` 只有 `src/**`，而 vitest 只转译不查类型。此前这个完整性自检写在
 * `test/terminal-selection-mode.test.ts` 里、注释还声称「靠单文件 tsc 检查兜」——那个检查在任何门禁里
 * 都不存在，于是整条判据是死代码，xterm 增删一种模式不会有任何东西变红（记忆
 * desktop-tsc-does-not-see-tests）。搬到这里之后，`pnpm typecheck` 就是它的执行者。
 *
 * 显式标注 `Record<MouseTrackingMode, boolean>` 是承重的：xterm 增一种模式 → 缺键报错，删/改一种 →
 * 多余键报错，两个方向都逼人回来重新判断它落在哪一侧。
 *
 * 这里**不是**「只有标注才行、satisfies 不行」——那句话我先写过，实测是错的：对**对象字面量**而言
 * `satisfies Record<MouseTrackingMode, boolean>` 缺键报 TS1360、多余键报 TS2353，两个方向都退 2，
 * 与标注等强。真正会静默的是**数组**形式（`['x10','vt200'] as const satisfies readonly MouseTrackingMode[]`）：
 * `readonly X[]` 只约束「每个元素合法」，从不要求覆盖全集，所以漏掉一种模式没有任何东西会红。
 * 选标注只是因为它同时把类型写在了名字旁边，不是因为 satisfies 弱。
 */
const MOUSE_REPORTING_ACTIVE: Record<MouseTrackingMode, boolean> = {
  none: false,
  x10: true,
  vt200: true,
  drag: true,
  any: true
}

/**
 * 全部模式，从上面那张表的键派生——**不手抄第二份**。
 *
 * 测试遍历这个导出来逐模式质询，于是「测到的模式集合」与「类型层的全集」在编译期被同一个对象绑住：
 * 漏测一种模式的唯一方式是让 tsc 先报错。此前测试里有一份手抄的 `ACTIVE_MODES = ['x10','vt200','drag','any']`，
 * 那种形状下漏掉一个字面量是静默的（记忆 sampled-pair-can-be-the-blind-spot）。
 */
export const MOUSE_TRACKING_MODES = Object.keys(MOUSE_REPORTING_ACTIVE) as readonly MouseTrackingMode[]

/**
 * xterm 此刻会不会拒绝从一次「平白左拖」里建立选区。
 *
 * 等价于 xterm 的 `areMouseEventsActive`（`events !== 0`）：除 `none`（events=0）之外的四种模式
 * 都让它为真，都会 `disable()` 选区服务。所以判据就是 `mode !== 'none'`——**这是实测事实，不是设计取舍**。
 *
 * 四种活跃模式并不等价：X10（events=1）与 VT200（19）只在按键时上报，DRAG（23）与 ANY（31）连移动
 * 也上报。但对「平白左拖能不能选中」这个问题，它们今天给出**同一个**答案，因为四者的 `events` 都非零。
 * 若日后要让「只报点击」的模式仍允许拖选，那是一次**行为变更**，应走 follow-up，而不是在这里偷偷分叉。
 *
 * 取值读上面那张表，而不是再写一遍 `mode !== 'none'`：那样分类就有了两份（表里一份、这里一份），
 * 而 tsc 管不住两份之间的一致性。现在表是唯一的分类真相，改表里任何一个布尔值都会让行为测试变红。
 *
 * 这里**没有** `?? true` 之类的兜底，是实测结论而非疏漏：`MOUSE_REPORTING_ACTIVE` 是
 * `Record<MouseTrackingMode, boolean>`，键是有限 union 而非索引签名，所以取值类型就是 `boolean`、
 * 永不为 `undefined`（`noUncheckedIndexedAccess` 只作用于索引签名，对声明属性不生效）。我先写过
 * `?? true` 并给它编了一段「未知模式倒向提示那一侧」的理由，然后实测：把 `?? true` 改成 `?? false`
 * 是 20 条全绿 + tsc exit 0，整段删掉也是 20 条全绿 + tsc exit 0——那个分支根本不可达，注释是在为
 * 一段死代码担保（记忆 surviving-mutation-may-be-dead-condition / comment-promises-more-than-assertion）。
 * xterm 真的新增一种模式时，把守的人是上面那个 `Record` 标注：缺键当场编译报错，而不是在运行期被
 * 一个悄悄猜错方向的兜底吞掉。
 */
export function isPlainDragSelectionSuppressed(mode: MouseTrackingMode): boolean {
  return MOUSE_REPORTING_ACTIVE[mode]
}

/**
 * 选区被压制时该告诉用户的那一句——平台正确的逃生手势。
 *
 * 逃生手势是 xterm 的 `shouldForceSelection`：mac 上按住 Option（⌥）再拖，别处按住 Shift 再拖。
 * 平台从 `host-platform.ts` 的 `isMacPlatform` 派生，**不**在这里手写第 11 处 `navigator.userAgent`
 * 判断（本仓有一条「散落平台判定」的在册缺陷，SSOT 收在那个 helper 里）。`userAgent` 作参数一路透传，
 * 供测试钉两个平台，而不必去改全局 `navigator`。
 *
 * 文案同时说清「为什么」（程序正占用鼠标）与「怎么办」（按住某个修饰键再拖）——只说其一都不足以
 * 把用户从死胡同里领出来。
 */
export function selectionForceGestureHint(userAgent?: string): string {
  return isMacPlatform(userAgent)
    ? 'Selection is off while the program is using the mouse — hold ⌥ Option and drag to select.'
    : 'Selection is off while the program is using the mouse — hold Shift and drag to select.'
}

/**
 * UI 要的整个决定收在一处：这次要不要提示（`null` 表示不压制、菜单照常），以及提示什么。
 *
 * 这是给右键菜单的**单一调用点**用的：菜单把 `mouseTrackingMode` 喂进来，拿到 `null` 或那句提示，
 * 不必自己知道位掩码或平台判定。见 `TerminalContextMenu.tsx` 里的接线说明。
 */
export function terminalSelectionSuppressionHint(
  mode: MouseTrackingMode,
  userAgent?: string
): string | null {
  return isPlainDragSelectionSuppressed(mode) ? selectionForceGestureHint(userAgent) : null
}
