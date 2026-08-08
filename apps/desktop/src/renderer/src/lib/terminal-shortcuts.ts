import { isImeOwnedKeyboardEvent } from './ime-composition-keyboard-event'
import { isMacPlatform } from './host-platform'
import { shouldBypassXtermKeyboardEvent } from './xterm-bypass-policy'

// The "what bytes / which text after the key" helpers for the terminal. The chord decisions themselves —
// is this Cmd+F / Cmd+C / Cmd+K, is this the bare Shift+Enter newline — now live in `shortcut-registry.ts`
// (terminal scope), so the one platform bottom line is expressed once. What stays here is the part that is
// NOT a key decision: which selection to copy, and which byte sequence a newline must send.

/**
 * xterm can clear its live selection while a context menu takes focus. Keep the
 * last non-empty selection as a copy source so a right-click Copy remains
 * deterministic even after that focus transition.
 */
export function terminalSelectionForCopy(liveSelection: string, rememberedSelection: string): string {
  return liveSelection || rememberedSelection
}

/**
 * Shift+Enter 该送哪几个字节。
 *
 * 终端本身对 Enter 与 Shift+Enter 不可分辨——两者默认都是 `\r`，因为传统终端的线路上根本没有
 * 表达修饰键的位置。于是下游 TUI 看到 `\r` 只能理解成"提交"，用户就写不了多行。要分得开，
 * 必须由宿主显式送出不同的字节，这是我们的活，不是可以指望的默认行为。
 *
 * 两种编码，取决于下游程序自己有没有协商 kitty keyboard 协议：
 * - 协商过：送 CSI-u（`ESC [13;2u`，13 是 Enter 的键码，2 是 Shift 修饰位）——这是该协议下
 *   表达"带修饰键的 Enter"的正规说法。
 * - 没协商过：退回 `ESC CR`。这是许多 TUI 沿用已久的"Alt/Meta+Enter 换行"约定，在没有协议
 *   支持时它是最可能被正确理解的一种。
 *
 * 没协商过却送 CSI-u 会让那个程序收到一串它不认识的字节，因此协议状态只能探测、不能假定，
 * 见 `terminal-kitty-keyboard.ts`。
 */
export const SHIFT_ENTER_CSI_U = '[13;2u'
export const SHIFT_ENTER_ESC_CR = '\r'

export function shiftEnterInput(kittyKeyboardActive: boolean): string {
  return kittyKeyboardActive ? SHIFT_ENTER_CSI_U : SHIFT_ENTER_ESC_CR
}

/**
 * 终端绑定命中之后要做的事，注入形式的依赖。
 *
 * 每个字段都是壳能提供、而这一层不该自己去拿的东西：`sendInput` 通向 PTY，`clipboard` 通向系统
 * 剪贴板（含它自己的响亮报错），其余三个是 xterm 实例上的取值/动作。刻意不接收 `terminal` 本体：
 * 那样这层就得知道 xterm 的形状，而它只需要这几个动作。
 */
export interface TerminalShortcutDeps {
  /** 往 PTY 送字节。 */
  sendInput: (data: string) => void
  /** 下游程序有没有协商 kitty keyboard 协议——决定 Shift+Enter 送哪种编码。 */
  kittyKeyboardActive: () => boolean
  /** 打开/关闭终端内搜索条。 */
  setSearchOpen: (open: boolean) => void
  /** 当前选区（空串表示没有选中）。 */
  readSelection: () => string
  /** 记住这次选区，供右键 Copy 在焦点转移后仍可用。 */
  rememberSelection: (text: string) => void
  /** 把文本送进系统剪贴板；失败要响亮报错而不是静默丢。 */
  writeClipboard: (text: string) => void
  /** 清屏。 */
  clear: () => void
}

/**
 * 每条 `terminal` scope 绑定命中后的动作，键是绑定 id。
 *
 * 为什么抽出来：这些分支此前内联在 `TerminalView` 的 `attachCustomKeyEventHandler` 里，运行期
 * 完全够不着——把任一分支的**体**掏空（`if (id === 'terminal.search') { return false }`），56 条
 * 终端搜索测试与整族快捷键测试全绿，而那个键对用户彻底失效。跨 scope 的接线守卫因此只能读源码
 * 断言「比较在场」，那是最弱的一层。抽成纯工厂后它可以被直接调用并断言后果。
 *
 * 镜像 `windowShortcutHandlers` 的形状（`Record<id, handler>`）。返回的 handler 只在 keydown 时
 * 被调用一次——「keydown 还是 keyup」是壳的判断，不是这层的；这层只回答「做什么」。
 *
 * 注意 **paste 刻意不在这里**：xterm 的 `attachCustomKeyEventHandler` 返回 false 不会
 * preventDefault，所以原生 Edit→Paste 路径照旧触发。在这里也处理 Cmd/Ctrl+V 会让同一份剪贴板
 * 文本被贴两次。原生路径是 paste 的唯一所有者。
 */
export function terminalShortcutHandlers(deps: TerminalShortcutDeps): Record<string, () => void> {
  return {
    'terminal.newline': () => {
      // xterm 对 Enter 与 Shift+Enter 送同一个裸 \r（终端线路上没有表达修饰键的位置），下游 TUI
      // 因此只能把 Shift+Enter 读成提交，用户写不了多行。这里显式送出不同的字节。
      deps.sendInput(shiftEnterInput(deps.kittyKeyboardActive()))
    },
    'terminal.search': () => {
      deps.setSearchOpen(true)
    },
    'terminal.copy': () => {
      const text = deps.readSelection()
      // 空文本既不记也不写。写 `''` 会**抹掉用户上一次复制的内容**——那是比「这次没复制成」严重
      // 得多的一种失败，而且完全静默（剪贴板出口只在 IPC 抛错时报，成功写入空串是它的正常路径）。
      //
      // 这条分支**真的可达**，因为 xterm 对「有没有选区」有两个判得不一样的答案（读的是 vendored
      // 的 5.5.0 源码 `browser/services/SelectionService.ts`）：
      //   - `hasSelection` 是纯**坐标**判定：`start[0] !== end[0] || start[1] !== end[1]`；
      //   - `selectionText` 走 `translateBufferLineToString(..., trimRight = true)`，把行尾空白裁掉。
      // 于是「在空白处横拖一段」这个再普通不过的手势就让两者分岔：坐标上确实有区间，裁完是空串。
      // 用户看到的正是 #610 那句「划词的时候它自己显示一个 Copy，但那个 Copy 又不成功」。
      if (!text) return
      deps.rememberSelection(text)
      deps.writeClipboard(text)
    },
    'terminal.clear': () => {
      deps.clear()
    }
  }
}

/**
 * 这个事件是不是**裸** Ctrl+C（不带 Cmd / Shift / Alt）。
 *
 * 为什么它不走 `shortcut-registry`：那张表里一条绑定在一个平台上只能有一个和弦，而 Ctrl+C 要的是
 * 「同一个键按有没有选区分成两件事」——有选区复制、没选区送 SIGINT。这不是第二个和弦，是一个
 * **条件**，塞进注册表就得给 `ShortcutBinding` 加一条 schema（而改键持久化格式正在待拍板，见 #361）。
 *
 * 也因此它在两个平台上都是同一个判据：`terminal.copy` 在 mac 上是 Cmd+C、在别处是 Ctrl+Shift+C，
 * 两条都不会匹配裸 Ctrl+C（`chordMatches` 在 mac 上要求 `metaKey`，在别处要求 `shift`），于是这个键
 * 今天在两个平台上都直接落到「不是我们的键」那条出口、原样交给终端。**它是缺失的能力，不是回归。**
 */
export function isBareCtrlC(event: {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  shiftKey?: boolean
  altKey?: boolean
}): boolean {
  if (event.key.toLowerCase() !== 'c') return false
  if (!event.ctrlKey) return false
  // 三个修饰键都必须缺席：带上任何一个就是别的和弦（Ctrl+Shift+C 正是非 mac 的 terminal.copy）。
  return !event.metaKey && !event.shiftKey && !event.altKey
}

/** {@link terminalKeyEventHandler} 除动作之外还要的两件事。 */
export interface TerminalKeyEventDeps extends TerminalShortcutDeps {
  /** 这个事件命中了哪条 terminal 绑定（`null` 表示不是我们的键）。通常是 `matchShortcut` 的柯里化。 */
  matchTerminalShortcut: (event: KeyboardEvent) => string | null
  /**
   * 终端此刻有没有选区——xterm 的**坐标**判定（`terminal.hasSelection()`）。
   *
   * 它单独**不足以**作为 copy 的认领条件：坐标有区间而文本裁完是空串这件事在空白处横拖时就会
   * 发生（机制写在 `terminal.copy` 那个动作里）。
   *
   * 而且反过来，它对下面那个判据**不产生影响**——这一点实测过，别把它读成一道真的闸：
   * `getSelection()` 走的是同一个 `SelectionService`，两个取值器开头是同一句
   * `if (!start || !end) return`（`hasSelection` 返 false、`selectionText` 返 `''`），所以
   * 「文本非空」蕴含「坐标有区间」。合起来判只是把权威那一侧说清楚，不是两个独立条件。
   *
   * 那为什么还留着它：它的实参在 `TerminalView` 那个组件里，而那个文件此刻由别的 agent 持有
   * （实测删掉这个端口会让它的 deps 字面量报 TS2353）。收成一处是后续的事，今天不动别人的文件。
   */
  hasSelection: () => boolean
}

/**
 * xterm `attachCustomKeyEventHandler` 的整个回调：返回 `false` 表示这个键被我们吞掉。
 *
 * 为什么连回调一起抽出来，而不只抽动作：只抽 {@link terminalShortcutHandlers} 时「动作对不对」
 * 可测了，但「这层壳有没有被执行到」照旧无人守——在组件里 `matchShortcut` 之后插一句
 * `return true`，整个回调变 no-op（每个终端键都失效），而工厂那族与接线守卫全绿，实测过。
 * 判「取值关系」的 AST 守卫看不见一句早退。
 *
 * 收法是让壳里没有语句可插：组件那侧只剩
 * `terminal.attachCustomKeyEventHandler(terminalKeyEventHandler({ … }))` 一句转发，判定与吞键
 * 的全部逻辑在这里，可以直接喂事件断言返回值。
 */
export function terminalKeyEventHandler(deps: TerminalKeyEventDeps): (event: KeyboardEvent) => boolean {
  const actions = terminalShortcutHandlers(deps)
  /**
   * 这次 copy 有东西可写吗。两处认领共用**同一个**判据，别各写一遍——本仓记过「读的 key 与写的
   * key 必须只判一次」，而这里分开算的代价正是 #610：一侧说「有选区」、另一侧写了个空串。
   *
   * 判决在 `readSelection()` 这一侧，因为它读的就是动作要写进剪贴板的那个取值。左边那个合取项
   * **改不了结果**（xterm 两个取值器共用同一个空区间早退，见 `hasSelection` 的注释），所以别指望
   * 有测试能单独钉住它——把它删掉这一族仍然全绿，这是实测过的、已知的。
   */
  const hasCopyableText = (): boolean => deps.hasSelection() && deps.readSelection() !== ''
  // 平台在渲染进程里从 navigator.userAgent 派生（与 TerminalView 传给 matchShortcut 的那个 isMac
  // 同源同值）——在本层就地取，好让旁路策略不必再往 deps 里加一个字段、也就不必改由别的 agent 持有
  // 的 TerminalView。
  const isMac = isMacPlatform()
  /**
   * 这个键该不该让 xterm 提前出让、把它交给原生浏览器管线（Chromium `copy`/`paste`、OS 键位）。
   *
   * 为什么需要这一步：某些 CLI 启用 kitty progressive enhancement 后，xterm 的 KittyKeyboard 编码器
   * 会把带修饰键的和弦——**包括 Cmd/Ctrl+V**——编成 CSI-u 并 `preventDefault()`，那次 preventDefault
   * 连原生 `paste` 事件一起压掉，于是原生 Edit→Paste 落不到 xterm 的 textarea。对这些和弦返回 false
   * 让 xterm 在跑编码器**之前**就 bail，原生管线照常触发。逻辑全在 `xterm-bypass-policy.ts`，见其文件头。
   */
  const shouldBypass = (event: KeyboardEvent): boolean =>
    shouldBypassXtermKeyboardEvent(event, { isMac, hasSelection: deps.hasSelection() })
  return (event) => {
    // Composition owns its keys, including the Enter that confirms a candidate.
    if (isImeOwnedKeyboardEvent(event)) return true

    // 裸 Ctrl+C：有可复制的文本就复制，否则把键交还终端（那时它是 SIGINT）。
    //
    // 用户明确要回这条体验（「我觉得还是要保留 Ctrl+C 和右键菜单复制的体验」），而它此前在两个平台上
    // 都够不着——见 isBareCtrlC 的注释：注册表里那条 terminal.copy 的两个和弦都不匹配裸 Ctrl+C。
    //
    // 顺序上它排在 matchTerminalShortcut 之前，理由是**不能**让它经过注册表：那条路一旦匹配上就会
    // 把「没选区」也算成 copy 的候选，而 SIGINT 那一侧必须原样交还。放在前面等于说「这个键有它自己的
    // 认领条件」，与下面 terminal.copy 那道闸是同一条规则的两个入口，所以两处都调 hasCopyableText()。
    if (isBareCtrlC(event)) {
      // 没选区 = SIGINT，必须原样交还终端（返 true）。这条**不**走 shouldBypass：#610 的判据是
      // 「readSelection() 文本非空」，而旁路策略的 interrupt-C 分支读的是 xterm 的**坐标** hasSelection
      // ——两者在「空白处横拖」时分岔（坐标有区间、文本裁完为空）。把这条交给 shouldBypass 会用错的
      // 那个判据把该发的 SIGINT 吞成「复制空串」（实测：一条 #610 用例会红）。bare Ctrl+C 由本分支
      // 完整拥有，等同于参考项目里排在旁路策略**之前**的 interrupt 处理器——够不到 return !shouldBypass。
      if (!hasCopyableText()) return true
      if (event.type === 'keydown') actions['terminal.copy']?.()
      return false
    }
    const shortcutId = deps.matchTerminalShortcut(event)
    // 不是我们的注册表键：这里正是 paste / Shift+Insert 落脚处，也是**唯一**该由旁路策略裁决的出口。
    // 以前无条件 `return true`（把键交给 xterm），在 kitty 模式下这些剪贴板和弦就被 KittyKeyboard 编码器
    // preventDefault 掉、原生 paste 随之死掉。改成 `return !shouldBypass`：策略认领剪贴板和弦时返回 false，
    // xterm 提前 bail，原生管线接手。镜像参考项目回调末尾那句 `return !shouldBypassXtermKeyboardEvent(...)`
    // ——在参考项目里，被更早的处理器认领的键都已 return，落到这句的正是「我们不认领」的键，与此处等价。
    if (!shortcutId) return !shouldBypass(event)
    // Copy 只在真有文本时认领。没文本就交还终端（返 true，与 bare Ctrl+C 同理由，判据同为文本非空，
    // 不走 shouldBypass）——Ctrl+C 那种情况下是 SIGINT，吞掉会让用户中断不了正在跑的程序。
    if (shortcutId === 'terminal.copy' && !hasCopyableText()) return true
    const act = actions[shortcutId]
    // 没有对应动作就交还。（注册表 id 都有动作，这条实际到不了，保留成与其它出口同形。）
    if (!act) return true
    // keydown / keyup 的区分在这里：动作只跑一次，但两个事件都要吞掉，否则 keyup 会漏给终端。
    if (event.type === 'keydown') act()
    return false
  }
}
