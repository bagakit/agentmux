import { describe, expect, it } from 'vitest'
import {
  SHIFT_ENTER_CSI_U,
  SHIFT_ENTER_ESC_CR,
  isShiftEnterNewline,
  isTerminalAppShortcut,
  shiftEnterInput,
  terminalSelectionForCopy
} from '../src/renderer/src/lib/terminal-shortcuts.js'
import {
  initialKittyKeyboardState,
  isKittyKeyboardActive,
  readKittyKeyboardOutput
} from '../src/renderer/src/lib/terminal-kitty-keyboard.js'

const ESC = '\u001b'

function key(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key: 'f',
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...overrides
  } as KeyboardEvent
}

describe('Terminal app shortcuts', () => {
  it('uses Command on macOS without stealing Ctrl chords from the Agent TUI', () => {
    expect(isTerminalAppShortcut(key({ metaKey: true }), 'f', true)).toBe(true)
    expect(isTerminalAppShortcut(key({ ctrlKey: true }), 'f', true)).toBe(false)
  })

  it('requires Ctrl+Shift elsewhere so readline and Agent Ctrl chords remain native', () => {
    expect(isTerminalAppShortcut(key({ ctrlKey: true, shiftKey: true }), 'f', false)).toBe(true)
    expect(isTerminalAppShortcut(key({ ctrlKey: true }), 'f', false)).toBe(false)
    expect(isTerminalAppShortcut(key({ ctrlKey: true, shiftKey: true, altKey: true }), 'f', false)).toBe(false)
  })

  it('keeps the last non-empty selection when a context-menu focus transition clears xterm selection', () => {
    expect(terminalSelectionForCopy('live text', 'remembered text')).toBe('live text')
    expect(terminalSelectionForCopy('', 'remembered text')).toBe('remembered text')
    expect(terminalSelectionForCopy('', '')).toBe('')
  })
})

/**
 * Shift+Enter 必须与 Enter 送出不同的字节。
 *
 * 判据落在字节上而不是"handler 注册过"：后者在编码写错时同样会绿，证明不了用户能不能换行。
 */
describe('Shift+Enter 换行', () => {
  it('未协商 kitty 协议时送 ESC+CR，而不是与 Enter 相同的裸 CR', () => {
    expect(shiftEnterInput(false)).toBe(`${ESC}\r`)
    // 这才是缺陷的实质：与 Enter 同字节，下游只能读成提交。
    expect(shiftEnterInput(false)).not.toBe('\r')
  })

  it('协商过 kitty 协议时送 CSI-u 编码', () => {
    expect(shiftEnterInput(true)).toBe(`${ESC}[13;2u`)
    expect(SHIFT_ENTER_CSI_U).not.toBe(SHIFT_ENTER_ESC_CR)
  })

  it('只接管单独的 Shift+Enter，其余修饰组合留给下游', () => {
    expect(isShiftEnterNewline(key({ key: 'Enter', shiftKey: true }))).toBe(true)
    // 不带 Shift 的 Enter 必须继续走原路——修好换行不能弄坏提交。
    expect(isShiftEnterNewline(key({ key: 'Enter' }))).toBe(false)
    for (const modifier of ['ctrlKey', 'altKey', 'metaKey'] as const) {
      expect(isShiftEnterNewline(key({ key: 'Enter', shiftKey: true, [modifier]: true }))).toBe(false)
    }
    expect(isShiftEnterNewline(key({ key: 'a', shiftKey: true }))).toBe(false)
  })
})

/**
 * 协议状态只能从下游程序自己的输出里探测。
 *
 * 强开会让没协商过的 TUI 收到一串它不认识的字节——那是比"少了个换行"严重得多的缺陷。
 */
describe('kitty keyboard 协议探测', () => {
  const fold = (...chunks: string[]) =>
    chunks.reduce(readKittyKeyboardOutput, initialKittyKeyboardState())

  it('默认不启用——没见过协商就不许送 CSI-u', () => {
    expect(isKittyKeyboardActive(initialKittyKeyboardState())).toBe(false)
    expect(isKittyKeyboardActive(fold('hello world\r\n'))).toBe(false)
  })

  it('只认宣告（> = <），不认查询/应答（?）——降级安全就架在这条上', () => {
    // 这不是一条挑剔的解析规则，它是"握手降级不会改变按键编码"这个结论的唯一支点：
    // 渲染层跟的是 codex 自己推的宣告，不是任何人对 `CSI ? u` 的应答。真跑过一次
    // codex 双分支抓包（见 docs/reviews/agentmux-handshake-degrade-plan.md）：回与不回
    // `[?0u`，PTY 输出逐字节相同，两次都推 `ESC[>7u`。若这里哪天开始匹配 `?` 形式，
    // 那份实测结论立即失效——而失效的表现是 Shift+Enter 静默送错字节，没有别的报警。
    expect(isKittyKeyboardActive(fold(`${ESC}[?u`))).toBe(false)
    expect(isKittyKeyboardActive(fold(`${ESC}[?0u`))).toBe(false)
    // 查询与应答夹在真宣告两侧时，也不许干扰那次真宣告的读数。
    expect(isKittyKeyboardActive(fold(`${ESC}[?u`, `${ESC}[>7u`, `${ESC}[?0u`))).toBe(true)
  })

  it('codex 实测的开场序列会被读成"已启用"', () => {
    // 逐字节取自真实抓包的开头（偏移 0..53）。codex 是先推后问：`>7u` 在查询之前就出现，
    // 因此它根本没有"等应答再决定"这个决策点——降级不参与它的任何判断。
    const opening = `${ESC}[?2004h${ESC}[>4;0m${ESC}[>7u${ESC}[?1004h${ESC}[6n${ESC}]10;?${ESC}\\${ESC}]11;?${ESC}\\${ESC}[?u${ESC}[c`
    expect(isKittyKeyboardActive(fold(opening))).toBe(true)
  })

  it('程序 push 标志位后启用，pop 回去后停用', () => {
    const pushed = fold(`${ESC}[>1u`)
    expect(isKittyKeyboardActive(pushed)).toBe(true)
    expect(isKittyKeyboardActive(readKittyKeyboardOutput(pushed, `${ESC}[<u`))).toBe(false)
  })

  it('嵌套 push/pop 只弹一层，外层的协商仍然有效', () => {
    // 内层程序（比如一个短命的 pager）退出时，不该把外层 Agent 的协商一起清掉——
    // 那会让 Shift+Enter 在它退出后突然改送另一种编码。
    const nested = fold(`${ESC}[>1u`, `${ESC}[>15u`)
    expect(isKittyKeyboardActive(readKittyKeyboardOutput(nested, `${ESC}[<1u`))).toBe(true)
  })

  it('程序清掉自己置的位之后就不再启用', () => {
    // mode 3 是清位。清光了就等于它不再按这个协议读键，我们必须跟着退回 ESC+CR；
    // 把 mode 当成"整体替换"会让这里仍然启用，于是给一个已经不认识 CSI-u 的程序送 CSI-u。
    expect(isKittyKeyboardActive(fold(`${ESC}[>4u`, `${ESC}[=4;3u`))).toBe(false)
    // mode 2 是置位，只会加不会减。
    expect(isKittyKeyboardActive(fold(`${ESC}[>1u`, `${ESC}[=4;2u`))).toBe(true)
    // 缺省的 mode 1 是整体替换：换成 0 即为关闭。
    expect(isKittyKeyboardActive(fold(`${ESC}[>7u`, `${ESC}[=0u`))).toBe(false)
  })

  it('被 chunk 边界切断的序列拼回来，不漏读一次协商', () => {
    // PTY 输出按任意边界分块；一条协商横跨两块时若不拼回，就会静默地当作没协商过。
    expect(isKittyKeyboardActive(fold(`${ESC}[>`, '1u'))).toBe(true)
    expect(isKittyKeyboardActive(fold(`${ESC}`, '[>1u'))).toBe(true)
    expect(isKittyKeyboardActive(fold('text', `${ESC}[>1`, 'u', 'more'))).toBe(true)
  })

  it('永远等不到结尾的半条序列不会让缓冲无限增长', () => {
    const state = fold(`${ESC}[`, 'x'.repeat(200))
    expect(state.pending.length).toBeLessThanOrEqual(32)
  })

  it('弹空栈不算错误——我们可能只见到程序输出的后半段', () => {
    expect(() => fold(`${ESC}[<u`, `${ESC}[<9u`)).not.toThrow()
    expect(isKittyKeyboardActive(fold(`${ESC}[<u`))).toBe(false)
  })
})
