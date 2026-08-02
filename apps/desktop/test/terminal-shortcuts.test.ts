import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  SHIFT_ENTER_CSI_U,
  SHIFT_ENTER_ESC_CR,
  shiftEnterInput,
  terminalSelectionForCopy,
  terminalShortcutHandlers
} from '../src/renderer/src/lib/terminal-shortcuts.js'
import {
  initialKittyKeyboardState,
  isKittyKeyboardActive,
  readKittyKeyboardOutput
} from '../src/renderer/src/lib/terminal-kitty-keyboard.js'
import { SHORTCUT_BINDINGS } from '../src/renderer/src/lib/shortcut-registry.js'

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

describe('Terminal copy-selection source', () => {
  it('keeps the last non-empty selection when a context-menu focus transition clears xterm selection', () => {
    expect(terminalSelectionForCopy('live text', 'remembered text')).toBe('live text')
    expect(terminalSelectionForCopy('', 'remembered text')).toBe('remembered text')
    expect(terminalSelectionForCopy('', '')).toBe('')
  })
})

// TerminalView 的终端作用域接线。键判定发生在 xterm 的 attachCustomKeyEventHandler 回调里，
// renderToStaticMarkup 不跑 effect、更不会触发 xterm 的键回调——所以这一族曾经只能读源码断言
// `=== 'terminal.search'` 在场，而那一层认不出分支体被掏空：把 `{ setSearchOpen(true) }` 的体清掉，
// 56 条终端搜索测试与整族快捷键测试全绿，那个键对用户彻底失效。
//
// 现在动作抽成了 {@link terminalShortcutHandlers}（注入依赖 → `Record<id, handler>`），运行期够得着：
// 下面逐条钉**后果**（送什么字节、开哪个开关、写什么进剪贴板）。「壳有没有真的去查那份 map」
// 由 shortcut-scope-wiring.test.tsx 里的接线层守卫按 AST 判 import 关系与下标取值。
describe('terminal 绑定的动作', () => {
  const terminalView = readFileSync(
    new URL('../src/renderer/src/components/TerminalView.tsx', import.meta.url),
    'utf8'
  )
  // 剥注释，免得注释里写的东西假装成接线。
  const code = terminalView.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

  /** 记下每个依赖被碰了什么，作为「后果」的观测面。 */
  function spyDeps(selection = 'picked text', kitty = false) {
    const calls = {
      sentInput: [] as string[],
      searchOpen: [] as boolean[],
      remembered: [] as string[],
      clipboard: [] as string[],
      cleared: 0
    }
    const handlers = terminalShortcutHandlers({
      sendInput: (data) => calls.sentInput.push(data),
      kittyKeyboardActive: () => kitty,
      setSearchOpen: (open) => calls.searchOpen.push(open),
      readSelection: () => selection,
      rememberSelection: (text) => calls.remembered.push(text),
      writeClipboard: (text) => calls.clipboard.push(text),
      clear: () => {
        calls.cleared += 1
      }
    })
    return { calls, handlers }
  }

  it('注册表 terminal scope 的 id 集与 handler map 的键**双向**一致', () => {
    // 两个方向都要判。少一条 → 那个键按下去什么都不会发生（漏接 / typo）。多一条 → map 里有个
    // 谁也匹配不出来的 id，那是死代码，通常意味着注册表那侧改了名字而这侧没跟上。
    const registryIds = SHORTCUT_BINDINGS.filter((b) => b.scope === 'terminal')
      .map((b) => b.id)
      .sort()
    // 自证扫到了东西：注册表里确实有 terminal 绑定，否则下面两条对空集恒真。
    expect(registryIds.length).toBeGreaterThan(0)
    const handlerIds = Object.keys(spyDeps().handlers).sort()
    expect(handlerIds, 'terminal 绑定与 handler map 的 id 集不一致').toEqual(registryIds)
  })

  it('terminal.newline 送出与 Enter 不同的字节（两种编码各一次）', () => {
    const off = spyDeps('', false)
    off.handlers['terminal.newline']!()
    expect(off.calls.sentInput).toEqual([SHIFT_ENTER_ESC_CR])
    expect(off.calls.sentInput[0]).not.toBe('\r')

    const on = spyDeps('', true)
    on.handlers['terminal.newline']!()
    expect(on.calls.sentInput).toEqual([SHIFT_ENTER_CSI_U])
  })

  it('terminal.search 打开搜索条，而不是关掉它', () => {
    const { calls, handlers } = spyDeps()
    handlers['terminal.search']!()
    // 极性也是判据：`setSearchOpen(false)` 会让 Cmd+F 变成「关掉搜索」。
    expect(calls.searchOpen).toEqual([true])
  })

  it('terminal.copy 把当前选区记下来并写进剪贴板', () => {
    const { calls, handlers } = spyDeps('picked text')
    handlers['terminal.copy']!()
    expect(calls.clipboard).toEqual(['picked text'])
    // 记住这次选区，右键 Copy 在焦点转移后仍可用（见 terminalSelectionForCopy）。
    expect(calls.remembered).toEqual(['picked text'])
  })

  it('terminal.copy 在没选区时不去覆盖记住的那份', () => {
    // 空选区若也写进 rememberedSelection，就把上一次的可用来源抹掉了。
    const { calls, handlers } = spyDeps('')
    handlers['terminal.copy']!()
    expect(calls.remembered).toEqual([])
  })

  it('terminal.clear 清屏', () => {
    const { calls, handlers } = spyDeps()
    handlers['terminal.clear']!()
    expect(calls.cleared).toBe(1)
  })

  it('paste 刻意不在 handler map 里——原生 Edit→Paste 是它的唯一所有者', () => {
    // xterm 的 attachCustomKeyEventHandler 返回 false 不会 preventDefault，所以原生路径照旧触发。
    // 在这里也处理一次会让同一份剪贴板文本被贴两次。这条断言让「顺手补上 paste」立刻红，
    // 并把理由摆在失败信息里。
    expect(Object.keys(spyDeps().handlers)).not.toContain('terminal.paste')
  })

  it('判定来自注册表的 matchShortcut(scope terminal)，不是各自手写修饰键判断', () => {
    // 收敛证据：TerminalView 不再自己判 metaKey/ctrlKey/shiftKey，改为向注册表要 id。回退到手写判定
    // （比如 isTerminalAppShortcut 那套）这条会红。
    expect(code).toMatch(/matchShortcut\(event, isMac, \{ scope: 'terminal' \}\)/)
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
