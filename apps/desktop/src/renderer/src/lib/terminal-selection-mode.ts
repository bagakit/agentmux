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
 * xterm 此刻会不会拒绝从一次「平白左拖」里建立选区。
 *
 * 等价于 xterm 的 `areMouseEventsActive`（`events !== 0`）：除 `none`（events=0）之外的四种模式
 * 都让它为真，都会 `disable()` 选区服务。所以判据就是 `mode !== 'none'`——**这是实测事实，不是设计取舍**。
 *
 * 四种活跃模式并不等价：X10（events=1）与 VT200（19）只在按键时上报，DRAG（23）与 ANY（31）连移动
 * 也上报。但对「平白左拖能不能选中」这个问题，它们今天给出**同一个**答案，因为四者的 `events` 都非零。
 * 若日后要让「只报点击」的模式仍允许拖选，那是一次**行为变更**，应走 follow-up，而不是在这里偷偷分叉。
 *
 * 未知模式（xterm 将来新增、类型层已用索引访问兜住）走保守的一侧：当作压制（返回 true）。方向是刻意的
 * ——误判为压制只会多显示一句提示，而误判为不压制会把这个静默死胡同再放回给用户。
 */
export function isPlainDragSelectionSuppressed(mode: MouseTrackingMode): boolean {
  return mode !== 'none'
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
