import { describe, expect, it } from 'vitest'
import {
  shouldBypassXtermForIosTextEdit,
  shouldBypassXtermKeyboardEvent,
  shouldSuppressTerminalModifierKeyboardEvent,
  type XtermBypassEvent,
  type XtermBypassOptions
} from '../src/renderer/src/lib/xterm-bypass-policy.js'
import { terminalKeyEventHandler } from '../src/renderer/src/lib/terminal-shortcuts.js'

// xterm 键盘旁路策略 —— faithful port of the reference project's xterm-bypass-policy.ts。
//
// 判据一律是**返回值**：`shouldBypassXtermKeyboardEvent` 返 true 表示「让 xterm 提前出让、把这个键
// 交给原生浏览器管线/OS」。它的两个消费后果：
//   - copy/paste 和弦返 true → 回调层 `return !shouldBypass` = false → xterm 在跑 kitty 编码器之前
//     bail → 原生 copy/paste 事件照常触发；
//   - 普通输入返 false → 回调层 return true → xterm 照常把键当输入送 shell。
//
// 每个 it 只钉**一条**分支，且成对的两侧（该旁路 / 不该旁路）各写一条，免得一条 it 里两个断言
// 互相掩盖（本仓 two-throws-in-one-it-mask-each-other）。

/** 造一个 keydown 事件；只填本策略读到的字段，其余给出中性默认。 */
function evt(overrides: Partial<XtermBypassEvent> = {}): XtermBypassEvent {
  return {
    type: 'keydown',
    key: 'a',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides
  }
}

const MAC: XtermBypassOptions = { isMac: true, hasSelection: false }
const NONMAC: XtermBypassOptions = { isMac: false, hasSelection: false }

describe('shouldBypassXtermKeyboardEvent — 事件类型闸', () => {
  it('keypress 既不是 keydown 也不是 keyup，直接不旁路（除非 iOS 文本编辑另有说法）', () => {
    // 为什么钉它：`isXtermHandledKeyEvent` 是所有平台分支的前置门。若它被改成把 keypress 也算进来，
    // 一个 Cmd+C 的 keypress 会被重复认领。
    expect(
      shouldBypassXtermKeyboardEvent(evt({ type: 'keypress', key: 'c', metaKey: true }), MAC)
    ).toBe(false)
  })

  it('keyup 是 xterm 处理的事件类型：mac 的 Cmd+C keyup 也要旁路', () => {
    // 与上一条成对：证明门放行的是 keydown/keyup 而不是「只 keydown」。keyup 不旁路的话 xterm 会漏发
    // 一条释放 CSI-u。
    expect(
      shouldBypassXtermKeyboardEvent(evt({ type: 'keyup', key: 'c', metaKey: true }), MAC)
    ).toBe(true)
  })
})

describe('shouldBypassXtermKeyboardEvent — defaultPrevented + 平台修饰键', () => {
  it('mac：defaultPrevented 且按住 Cmd（未按 Ctrl）→ 旁路', () => {
    expect(
      shouldBypassXtermKeyboardEvent(
        evt({ key: 'x', metaKey: true, defaultPrevented: true }),
        MAC
      )
    ).toBe(true)
  })

  it('mac：defaultPrevented 但同时按住 Ctrl → platformModifierHeld 为假，不走这条分支', () => {
    // platformModifierHeld = metaKey && !ctrlKey。这条钉住 `!ctrlKey` 那一半：把它去掉，Cmd+Ctrl 的
    // 组合会误落进 defaultPrevented 分支。key 用 'x'（非剪贴板键）确保只有本分支可能命中。
    expect(
      shouldBypassXtermKeyboardEvent(
        evt({ key: 'x', metaKey: true, ctrlKey: true, defaultPrevented: true }),
        MAC
      )
    ).toBe(false)
  })

  it('非 mac：defaultPrevented 且按住 Ctrl（未按 Cmd）→ 旁路', () => {
    expect(
      shouldBypassXtermKeyboardEvent(
        evt({ key: 'x', ctrlKey: true, defaultPrevented: true }),
        NONMAC
      )
    ).toBe(true)
  })

  it('非 mac：按住平台修饰键但 defaultPrevented 为假 → 不因这条分支旁路', () => {
    // 与上一条成对：证明这条闸的两个合取项都必要。key='x' 不是任何剪贴板和弦，故只有 defaultPrevented
    // 分支能让它 true。
    expect(
      shouldBypassXtermKeyboardEvent(evt({ key: 'x', ctrlKey: true, defaultPrevented: false }), NONMAC)
    ).toBe(false)
  })
})

describe('shouldBypassXtermKeyboardEvent — Shift + 单个非 ASCII 可打印', () => {
  it('Shift 且 key 是单个非 ASCII 码点（无其它修饰键）→ 旁路', () => {
    // é (U+00E9) ≥ 0x80、单码点。xterm 的 kitty 编码器会按物理 code 推 shifted 键码而送错字符。
    expect(shouldBypassXtermKeyboardEvent(evt({ key: 'É', shiftKey: true }), MAC)).toBe(true)
  })

  it('Shift + 单个 ASCII 字母 → 不旁路（普通输入，交给 xterm）', () => {
    // 与上一条成对：钉住「非 ASCII」这一半。'A' 的码点 0x41 < 0x80。
    expect(shouldBypassXtermKeyboardEvent(evt({ key: 'A', shiftKey: true }), MAC)).toBe(false)
  })

  it('非 ASCII 但同时按住 Ctrl → 不走 Shift 分支（该由控制和弦逻辑决定）', () => {
    // 钉住那串 `!event.ctrlKey && !event.metaKey && !event.altKey`：带任一其它修饰键就不是「纯 Shift」。
    expect(
      shouldBypassXtermKeyboardEvent(evt({ key: 'É', shiftKey: true, ctrlKey: true }), NONMAC)
    ).toBe(false)
  })

  it('非 ASCII 但没按 Shift → 不走这条分支', () => {
    // 钉住 `event.shiftKey` 这一半。没 Shift 的非 ASCII 键交给 xterm 正常处理。
    expect(shouldBypassXtermKeyboardEvent(evt({ key: 'é', shiftKey: false }), MAC)).toBe(false)
  })

  it('key 是多码点串（IME 提交的整词）→ 不算单个非 ASCII，不旁路', () => {
    // isSingleNonAsciiPrintableText 要求 Array.from(key).length === 1。'ab' 两码点。
    expect(shouldBypassXtermKeyboardEvent(evt({ key: 'ab', shiftKey: true }), MAC)).toBe(false)
  })
})

describe('shouldBypassXtermKeyboardEvent — mac 剪贴板和弦', () => {
  it('mac：Cmd+C（注册表 terminal.copy）→ 旁路', () => {
    expect(shouldBypassXtermKeyboardEvent(evt({ key: 'c', metaKey: true }), MAC)).toBe(true)
  })

  it('mac：Cmd+V（就地定义的 paste 和弦）→ 旁路，让原生 paste 接手', () => {
    expect(shouldBypassXtermKeyboardEvent(evt({ key: 'v', metaKey: true }), MAC)).toBe(true)
  })

  it('mac：裸 Ctrl+C（无 Cmd）→ 不由本策略旁路（它是 SIGINT，且 bare-Ctrl+C 由回调层单独拥有）', () => {
    // mac 分支只认 Cmd+C / Cmd+V。裸 Ctrl+C 在 mac 上落到这里应返 false，交回终端发 SIGINT。
    expect(shouldBypassXtermKeyboardEvent(evt({ key: 'c', ctrlKey: true }), MAC)).toBe(false)
  })

  it('mac：普通字母 a → 不旁路', () => {
    expect(shouldBypassXtermKeyboardEvent(evt({ key: 'a' }), MAC)).toBe(false)
  })
})

describe('shouldBypassXtermKeyboardEvent — 非 mac 剪贴板和弦', () => {
  it('非 mac：Ctrl+Shift+C（注册表 terminal.copy）→ 恒旁路', () => {
    expect(
      shouldBypassXtermKeyboardEvent(evt({ key: 'c', ctrlKey: true, shiftKey: true }), NONMAC)
    ).toBe(true)
  })

  it('非 mac：Ctrl+C 且**有选区** → 旁路（复制）', () => {
    expect(
      shouldBypassXtermKeyboardEvent(evt({ key: 'c', ctrlKey: true }), {
        isMac: false,
        hasSelection: true
      })
    ).toBe(true)
  })

  it('非 mac：Ctrl+C 且**无选区** → 不旁路（它是 SIGINT，必须到 shell）', () => {
    // 与上一条成对，钉住 INTERRUPT_C_CHORD 那道 `&& hasSelection` 闸。这是最重的一条：改成恒真会让
    // 无选区 Ctrl+C 被旁路吞掉，用户中断不了跑飞的程序。
    expect(
      shouldBypassXtermKeyboardEvent(evt({ key: 'c', ctrlKey: true }), {
        isMac: false,
        hasSelection: false
      })
    ).toBe(false)
  })

  it('非 mac：Ctrl+V → 旁路', () => {
    expect(shouldBypassXtermKeyboardEvent(evt({ key: 'v', ctrlKey: true }), NONMAC)).toBe(true)
  })

  it('非 mac：Ctrl+Shift+V → 旁路', () => {
    expect(
      shouldBypassXtermKeyboardEvent(evt({ key: 'v', ctrlKey: true, shiftKey: true }), NONMAC)
    ).toBe(true)
  })

  it('非 mac：Shift+Insert → 旁路', () => {
    expect(
      shouldBypassXtermKeyboardEvent(evt({ key: 'Insert', shiftKey: true }), NONMAC)
    ).toBe(true)
  })

  it('非 mac：裸 Insert（无 Shift）→ 不旁路', () => {
    // 与上一条成对：SHIFT_INSERT_CHORD 的 shift:true 那一半。裸 Insert 是终端自己的键。
    expect(shouldBypassXtermKeyboardEvent(evt({ key: 'Insert', shiftKey: false }), NONMAC)).toBe(
      false
    )
  })

  it('非 mac：普通字母 v（无修饰键）→ 不旁路', () => {
    expect(shouldBypassXtermKeyboardEvent(evt({ key: 'v' }), NONMAC)).toBe(false)
  })
})

describe('shouldBypassXtermForIosTextEdit — iOS 文本编辑分支（本仓不可达，仍逐条钉）', () => {
  // 本仓是 Electron 桌面端，isIosWeb 恒为 false，故 shouldBypassXtermKeyboardEvent 里这条今天到不了。
  // 但按「不删分支」保留，且它是一个可独立导出、可独立测试的纯函数。

  it('isIosWeb=false → 恒不旁路（本仓的实际取值）', () => {
    expect(shouldBypassXtermForIosTextEdit(evt({ key: 'ㄱ' }), false)).toBe(false)
  })

  it('isIosWeb=true 且 key 是 Hangul jamo（无修饰键、非组字）→ 旁路', () => {
    // ㄱ (U+3131) 在 compatibility jamo 块内，HANGUL_JAMO_KEY 命中。
    expect(shouldBypassXtermForIosTextEdit(evt({ key: 'ㄱ' }), true)).toBe(true)
  })

  it('isIosWeb=true 但按住 Ctrl → 不旁路（控制和弦不是文本编辑）', () => {
    expect(shouldBypassXtermForIosTextEdit(evt({ key: 'ㄱ', ctrlKey: true }), true)).toBe(false)
  })

  it('isIosWeb=true 但正在组字（isComposing）→ 不旁路，交给 CompositionHelper', () => {
    expect(shouldBypassXtermForIosTextEdit(evt({ key: 'ㄱ', isComposing: true }), true)).toBe(false)
  })

  it('isIosWeb=true 但 key 不是 jamo（普通拉丁字母）→ 不旁路', () => {
    // 钉住「只认 jamo」这一半：一个普通 'a' 不该被 iOS 分支认领。
    expect(shouldBypassXtermForIosTextEdit(evt({ key: 'a' }), true)).toBe(false)
  })

  it('shouldBypassXtermKeyboardEvent 在 options.isIosWeb=true 时会走 iOS 分支', () => {
    // 证明顶层函数确实把 iOS 分支接了进来（而不是只导出了那个纯函数却没调用）。
    expect(
      shouldBypassXtermKeyboardEvent(evt({ key: 'ㄱ' }), {
        isMac: true,
        hasSelection: false,
        isIosWeb: true
      })
    ).toBe(true)
  })
})

describe('shouldSuppressTerminalModifierKeyboardEvent — 独立修饰键（当前未接线）', () => {
  // 这个导出目前在 terminalKeyEventHandler 里没有调用方（见其函数注释：TerminalView 由别的 agent 持有）。
  // 仍逐条钉住它的纯函数行为，好在接线时有现成判据。

  it('keydown 且 key 是修饰键（Meta）→ true', () => {
    expect(shouldSuppressTerminalModifierKeyboardEvent(evt({ type: 'keydown', key: 'Meta' }))).toBe(
      true
    )
  })

  it('keydown 且 key 是普通字母 → false', () => {
    expect(shouldSuppressTerminalModifierKeyboardEvent(evt({ type: 'keydown', key: 'a' }))).toBe(
      false
    )
  })

  it('keypress（非 xterm 处理类型）即便 key 是修饰键 → false', () => {
    expect(shouldSuppressTerminalModifierKeyboardEvent(evt({ type: 'keypress', key: 'Shift' }))).toBe(
      false
    )
  })
})

// ────────────────────────────────────────────────────────────────────────────
// 接线：terminalKeyEventHandler 把 shouldBypass 接在「不是注册表键」那条出口上。
//
// 判据是 handler 的**返回值**：paste（Cmd/Ctrl+V）不是注册表快捷键、也不是 bare Ctrl+C，会落到
// `!shortcutId` 出口。修好之前那里无条件 `return true`（键交给 xterm，kitty 模式下原生 paste 死掉）；
// 修好之后对剪贴板和弦 `return false`（xterm bail，原生 paste 接手）。
//
// 注意：handler 内部用 isMacPlatform() 从 navigator.userAgent 取平台。node 测试环境里 userAgent 是
// "Node.js/…" 故 isMac=false，因此这里用**非 mac** 的和弦（Ctrl+V / Ctrl+Shift+V / Shift+Insert）来
// 触发旁路，与运行环境自洽。
// ────────────────────────────────────────────────────────────────────────────
describe('terminalKeyEventHandler ← 旁路接线（非 mac 环境）', () => {
  function handlerWith(hasSelection: boolean) {
    let touches = 0
    const bump = () => {
      touches += 1
    }
    const handler = terminalKeyEventHandler({
      // paste / Shift+Insert 都不是注册表快捷键，故恒返回 null（走 !shortcutId 出口）。
      matchTerminalShortcut: () => null,
      hasSelection: () => hasSelection,
      sendInput: bump,
      kittyKeyboardActive: () => false,
      setSearchOpen: bump,
      readSelection: () => (hasSelection ? 'picked' : ''),
      rememberSelection: bump,
      writeClipboard: bump,
      clear: bump
    })
    return {
      /** 返回 { swallowed, touches }：swallowed = handler 返回 false = xterm 会 bail。 */
      run(event: Partial<XtermBypassEvent>) {
        touches = 0
        const result = handler({ type: 'keydown', key: 'a', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...event } as unknown as KeyboardEvent)
        return { swallowed: result === false, touches }
      }
    }
  }

  it('Ctrl+V 落到旁路出口：handler 返回 false（xterm bail，原生 paste 接手），且不碰任何 dep', () => {
    // 这是本任务的核心回归：修好前这里返回 true（键交 xterm），kitty 模式下原生 paste 被吞。
    const { swallowed, touches } = handlerWith(false).run({ key: 'v', ctrlKey: true })
    expect(swallowed, 'Ctrl+V 没让 xterm 出让——kitty 模式下原生 paste 会被编码器吞掉').toBe(true)
    expect(touches, '旁路 paste 时不该调用任何注入 dep（paste 的所有者是原生管线）').toBe(0)
  })

  it('Ctrl+Shift+V 同样走旁路出口：handler 返回 false', () => {
    const { swallowed } = handlerWith(false).run({ key: 'v', ctrlKey: true, shiftKey: true })
    expect(swallowed).toBe(true)
  })

  it('Shift+Insert 走旁路出口：handler 返回 false', () => {
    const { swallowed } = handlerWith(false).run({ key: 'Insert', shiftKey: true })
    expect(swallowed).toBe(true)
  })

  it('普通字母（非注册表键、非剪贴板和弦）→ handler 返回 true（原样交给终端）', () => {
    // 与上面成对：证明 !shortcutId 出口不是无条件吞。若它退回旧的无条件 `return true`，上面三条会红；
    // 若它被改成无条件 `return !shouldBypass` 里 shouldBypass 恒真，这条会红。
    const { swallowed } = handlerWith(false).run({ key: 'a' })
    expect(swallowed, '普通打字被 xterm 出让了——字符会进不了 shell').toBe(false)
  })

  it('非 mac Ctrl+C 且无选区 → 仍原样交还终端（SIGINT），不因旁路被吞', () => {
    // 回归护栏：bare Ctrl+C 由回调层单独拥有、不走 shouldBypass。这条钉住那个决定没被旁路改写。
    const { swallowed, touches } = handlerWith(false).run({ key: 'c', ctrlKey: true })
    expect(swallowed, '无选区 Ctrl+C 被吞——用户中断不了跑飞的程序').toBe(false)
    expect(touches, '无选区 Ctrl+C 去动了剪贴板/选区记忆').toBe(0)
  })
})
