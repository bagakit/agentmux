import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  SHIFT_ENTER_CSI_U,
  SHIFT_ENTER_ESC_CR,
  isBareCtrlC,
  shiftEnterInput,
  terminalKeyEventHandler,
  terminalSelectionForCopy,
  terminalShortcutHandlers
} from '../src/renderer/src/lib/terminal-shortcuts.js'
import {
  initialKittyKeyboardState,
  isKittyKeyboardActive,
  readKittyKeyboardOutput
} from '../src/renderer/src/lib/terminal-kitty-keyboard.js'
import { SHORTCUT_BINDINGS, matchShortcut } from '../src/renderer/src/lib/shortcut-registry.js'

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
 * 整个键回调的行为（#366）。
 *
 * 上面那族钉的是「命中之后做什么」，而**吞不吞这个键**是另一件事，并且是四个变异全存活的那一族：
 * review 实测把 `terminalKeyEventHandler` 里这四处各改一处，98 条（其中一处 676 条）全绿——
 *
 * 1. `:125` 的 `!deps.hasSelection()` 改成 `false`：**没选区的 Ctrl+C 不再发 SIGINT**，被当成
 *    「复制空串」吞掉。用户中断不了跑飞的程序，这是四条里最重的一条。
 * 2. `:131` 的 `return false` 改成 `true`：动作照跑，但键同时漏给 xterm——Cmd+F 开了搜索条又
 *    往终端里写了个 `f`。
 * 3. `:130` 的 `event.type === 'keydown'` 判断删掉：keyup 也跑一次，每个终端键的动作做两遍。
 * 4. `:122` 之前插一句 `return true`：整个回调变 no-op，所有终端键失效。
 *
 * 为什么此前无人守：这个回调只有 xterm 在真实键盘事件里会调，而 `renderToStaticMarkup` 不跑
 * effect、更不会造键盘事件。`shortcut-scope-wiring` 那条 AST 守卫判的是「壳把它当实参传进去了」，
 * 对闭包体完全失明（记忆 guard-must-check-reachability-not-presence）。工厂那族只拿到
 * `Record<id, handler>`，看不到谁去查这张表、查完吞不吞。
 *
 * 所以判据必须是：喂一个事件进去，问**返回值**（吞了没有）和**外界被碰了几次**（动作跑了几遍）。
 */
describe('终端键回调的吞键判定', () => {
  /**
   * 一次调用碰了外界几次——判据是这个，不是某个具体 spy。
   *
   * 三条出口（交还 / 吞掉不做事 / 吞掉并做事）各自碰的东西不一样：`terminal.search` 碰
   * `setSearchOpen`，`terminal.copy` 碰剪贴板，`terminal.newline` 碰 `sendInput`。钉住某一个 spy
   * 只能守住那一条，另外两条的「动作跑了两遍」照旧存活（记忆
   * fixture-discarding-callback-hides-empty-body：判据要按「碰了外界几次」计数）。
   */
  function harness(options: { shortcutId: string | null; hasSelection?: boolean; selection?: string } ) {
    let touches = 0
    const bump = () => {
      touches += 1
    }
    const handler = terminalKeyEventHandler({
      matchTerminalShortcut: () => options.shortcutId,
      hasSelection: () => options.hasSelection ?? false,
      sendInput: bump,
      kittyKeyboardActive: () => false,
      setSearchOpen: bump,
      readSelection: () => options.selection ?? '',
      rememberSelection: bump,
      writeClipboard: bump,
      clear: bump
    })
    return {
      handler,
      /** 调用前归零：不然上一次的计数会掩盖这一次「一下都没碰」。 */
      touchesOf(event: KeyboardEvent): { swallowed: boolean; touches: number } {
        touches = 0
        const result = handler(event)
        return { swallowed: result === false, touches }
      }
    }
  }

  const keydown = (overrides: Partial<KeyboardEvent> = {}) =>
    key({ type: 'keydown', ...overrides } as Partial<KeyboardEvent>)
  const keyup = (overrides: Partial<KeyboardEvent> = {}) =>
    key({ type: 'keyup', ...overrides } as Partial<KeyboardEvent>)

  /**
   * 走**注册表**那条路的 copy 事件：mac 的 Cmd+C。
   *
   * 为什么不能再用 `{ key: 'c', ctrlKey: true }`：那正是 {@link isBareCtrlC} 认领的形状，而它的分支
   * 排在 `matchTerminalShortcut` 之前。用它喂下面两条，测的就变成了新分支，注册表那道选区闸
   * 变成死代码——两条断言照旧全绿（两条路今天的结论恰好一致），但「谁被测了」已经换人。
   * 这是本仓 fixture-wrong-shape-blinds-the-test 那一族：**判据没变，被测对象换了**。
   */
  const REGISTRY_COPY_EVENT = { key: 'c', metaKey: true } as const

  it('自证：注册表那条路的 copy 事件不被裸 Ctrl+C 分支拦下', () => {
    // 上面那句注释的判据。把 REGISTRY_COPY_EVENT 改回 ctrlKey，这条立刻红——而不是让下面两条
    // 静默改成测别的分支。
    expect(isBareCtrlC({ ...key(), ...REGISTRY_COPY_EVENT })).toBe(false)
  })

  it('不是终端绑定的键原样交还，且一下都不碰外界', () => {
    const { touchesOf } = harness({ shortcutId: null })
    const outcome = touchesOf(keydown())
    expect(outcome.swallowed, '不认识的键被吞掉了——普通打字会消失').toBe(false)
    expect(outcome.touches, '不认识的键触发了动作').toBe(0)
  })

  it('命中的键被吞掉，且动作只跑一次', () => {
    const { touchesOf } = harness({ shortcutId: 'terminal.search' })
    const outcome = touchesOf(keydown())
    // 吞掉：不吞的话 Cmd+F 会既开搜索条又往终端写一个 f。
    expect(outcome.swallowed, '命中的终端键没被吞——它会同时漏给 xterm').toBe(true)
    expect(outcome.touches, '一次 keydown 让动作跑了别的次数').toBe(1)
  })

  /**
   * 这一条是四个变异里最重的那个：**没选区时 Ctrl+C 必须交还给终端**。
   *
   * mac 上 Cmd+C 与 Ctrl+C 是两个键，但在注册表的 terminal scope 里 `terminal.copy` 在非 mac 上
   * 就是 Ctrl+C，而 Ctrl+C 在终端里的含义是 SIGINT。有选区时用户想复制，没选区时用户想中断——
   * 把「没选区」这一支也吞掉，等于让用户中断不了正在跑的程序，而且现场没有任何报错。
   */
  it('没选区的 terminal.copy 交还给终端——Ctrl+C 要能发 SIGINT', () => {
    const { touchesOf } = harness({ shortcutId: 'terminal.copy', hasSelection: false })
    const outcome = touchesOf(keydown(REGISTRY_COPY_EVENT))
    expect(outcome.swallowed, '没选区时 Ctrl+C 被吞成「复制空串」——用户中断不了跑飞的程序').toBe(false)
    // 连剪贴板都不该碰：吞不吞与做不做是两件事，把空串写进剪贴板会抹掉用户上一次复制的内容。
    expect(outcome.touches, '没选区时仍去动了剪贴板／选区记忆').toBe(0)
  })

  it('有选区的 terminal.copy 才认领', () => {
    // 与上一条成对：只有两侧都钉住，`hasSelection()` 这个判据本身才是被守的。单钉一侧时把条件
    // 改成常量仍有一半绿（记忆 guard-count-exits-not-conditions：「接受」那一侧常常无人守）。
    const { touchesOf } = harness({ shortcutId: 'terminal.copy', hasSelection: true, selection: 'x' })
    const outcome = touchesOf(keydown(REGISTRY_COPY_EVENT))
    expect(outcome.swallowed, '有选区时 Cmd/Ctrl+C 没被吞——复制之外还会给终端送一个 c').toBe(true)
    expect(outcome.touches, '有选区时没去复制').toBeGreaterThan(0)
  })

  it('keyup 也吞掉，但动作不再跑第二遍', () => {
    // 两件事一条断言里说不清，所以分开问：
    // - 仍要吞（否则 keyup 漏给终端）；
    // - 但不能再碰外界（否则每个终端键的动作做两遍：清屏清两次、搜索条开两次）。
    const { touchesOf } = harness({ shortcutId: 'terminal.clear' })
    const outcome = touchesOf(keyup())
    expect(outcome.swallowed, 'keyup 没被吞——它会漏给终端').toBe(true)
    expect(outcome.touches, 'keyup 也执行了动作——每个终端键会做两遍').toBe(0)
  })

  it('注册表里有 id 但 handler map 里没有的键，交还而不是吞掉', () => {
    // paste 走的正是这条路：它在注册表里（这样 cheat-sheet 能展示），但刻意不在 handler map 里，
    // 因为原生 Edit→Paste 是它的唯一所有者。这里若改成「吞掉」，粘贴会彻底失效——比贴两次更糟。
    const { touchesOf } = harness({ shortcutId: 'terminal.definitely-not-a-handler' })
    const outcome = touchesOf(keydown())
    expect(outcome.swallowed, '没有对应动作的绑定被吞掉了——那个键会彻底失效').toBe(false)
    expect(outcome.touches).toBe(0)
  })
})

/**
 * 裸 Ctrl+C（#610 的一半）。
 *
 * 用户报的是「我没有办法按 Ctrl+C 了」。测出来的真相不是回归而是**从来没有过**：注册表里
 * `terminal.copy` 的两个和弦（mac 的 Cmd+C、非 mac 的 Ctrl+Shift+C）都不匹配裸 Ctrl+C——
 * `chordMatches` 在 mac 上要求 `metaKey && !ctrlKey`，在别处要求 `shift`。所以这个键在两个平台上
 * 都直落「不是我们的键」那条出口。下面第一条把这个前提本身做成断言：**它是这一族存在的理由**，
 * 而不是一句可以随注册表变化而失效的散文（记忆 expired-reason-for-not-mapping）。
 *
 * 规则有两侧，且两侧都是用户要的：有选区复制、没选区把键交还终端（那时它是 SIGINT）。
 * 只钉「复制」那一侧时，把条件改成常量 true 仍有一半绿（记忆 guard-count-exits-not-conditions）。
 */
describe('裸 Ctrl+C：有选区复制，没选区发 SIGINT（#610）', () => {
  const bareCtrlC = { key: 'c', ctrlKey: true, type: 'keydown' } as Partial<KeyboardEvent>

  /**
   * 这一族刻意**不**给 `matchTerminalShortcut` 喂真注册表，而是让它恒返回 null。
   *
   * 理由是要证的正是「注册表这条路够不着裸 Ctrl+C，所以必须有别的入口」。让它返回 null 等于把
   * 那个前提摆在替身里；前提有没有变则由下面 `注册表两条和弦都不匹配裸 Ctrl+C` 那条独立钉。
   * 若在这里接真注册表，两条路就混在一起，分不出是谁认领的。
   */
  function harness(hasSelection: boolean) {
    const written: string[] = []
    let touches = 0
    const bump = (): void => {
      touches += 1
    }
    const handler = terminalKeyEventHandler({
      matchTerminalShortcut: () => null,
      hasSelection: () => hasSelection,
      sendInput: bump,
      kittyKeyboardActive: () => false,
      setSearchOpen: bump,
      readSelection: () => (hasSelection ? 'picked text' : ''),
      rememberSelection: bump,
      writeClipboard: (text) => {
        written.push(text)
        bump()
      },
      clear: bump
    })
    return {
      written,
      run(event: Partial<KeyboardEvent>): { swallowed: boolean; touches: number } {
        touches = 0
        const result = handler(event as KeyboardEvent)
        return { swallowed: result === false, touches }
      }
    }
  }

  it('注册表两条和弦都不匹配裸 Ctrl+C——这一族存在的前提', () => {
    // 前提做成断言，而不是注释：哪天 terminal.copy 的和弦改了（比如非 mac 侧去掉 shift），
    // 这条会红，提醒回来决定「新分支还要不要」。此前它在两个平台上都够不着，所以是**缺失的
    // 能力**，不是回归——这句话的真假由这条负责。
    const copy = SHORTCUT_BINDINGS.find((binding) => binding.id === 'terminal.copy')
    expect(copy, '注册表里没有 terminal.copy 了——下面整族的前提已经换了').toBeDefined()
    for (const [platform, isMac] of [
      ['mac', true],
      ['non-mac', false]
    ] as const) {
      expect(
        matchShortcut({ ...key(), ...bareCtrlC } as KeyboardEvent, isMac, { scope: 'terminal' }),
        `${platform}: 注册表现在自己认领裸 Ctrl+C 了——那 terminalKeyEventHandler 里那条前置分支该撤了`
      ).toBeNull()
    }
  })

  it('有选区时复制，并吞掉这个键', () => {
    const { run, written } = harness(true)
    const outcome = run(bareCtrlC)
    expect(outcome.swallowed, '有选区的 Ctrl+C 没被吞——复制之外还会给终端送一个 ETX').toBe(true)
    // 判「复制了什么」而不只是「碰了外界」：写空串进剪贴板会抹掉用户上一次复制的内容。
    expect(written, '有选区的 Ctrl+C 没把选区写进剪贴板').toEqual(['picked text'])
  })

  it('没选区时原样交还——那一刻 Ctrl+C 是 SIGINT', () => {
    const { run, written } = harness(false)
    const outcome = run(bareCtrlC)
    expect(outcome.swallowed, '没选区的 Ctrl+C 被吞掉了——用户中断不了跑飞的程序').toBe(false)
    expect(outcome.touches, '没选区时仍去动了剪贴板／选区记忆').toBe(0)
    expect(written).toEqual([])
  })

  it('keyup 也吞掉，但不复制第二遍', () => {
    // 与注册表那条路同一条规则：两个事件都要吞（否则 keyup 漏给终端），但动作只跑一次。
    const { run, written } = harness(true)
    const outcome = run({ ...bareCtrlC, type: 'keyup' })
    expect(outcome.swallowed, 'keyup 没被吞——它会漏给终端').toBe(true)
    expect(written, 'keyup 也复制了一遍——剪贴板被写两次').toEqual([])
  })

  it('带任一修饰键就不是它——那些是别的和弦', () => {
    // 逐个质询而不是抽一个：三个修饰键各自都必须缺席。Ctrl+Shift+C 正是非 mac 的 terminal.copy，
    // 被这条分支抢走就等于绕过了注册表；Cmd+Ctrl+C / Ctrl+Alt+C 则可能是别人的键。
    for (const extra of [{ shiftKey: true }, { metaKey: true }, { altKey: true }]) {
      expect(
        isBareCtrlC({ ...key(), ...bareCtrlC, ...extra } as KeyboardEvent),
        `带 ${Object.keys(extra)[0]} 的 Ctrl+C 被当成裸 Ctrl+C——它抢走了别的和弦`
      ).toBe(false)
    }
    // 反向自证：三个都缺席时它必须认。缺了这条，上面整个循环可以靠「恒返回 false」通过。
    expect(isBareCtrlC({ ...key(), ...bareCtrlC } as KeyboardEvent)).toBe(true)
  })

  it('不是 c 键、或没按 ctrl，都不是它', () => {
    expect(isBareCtrlC({ ...key(), key: 'v', ctrlKey: true } as KeyboardEvent)).toBe(false)
    expect(isBareCtrlC({ ...key(), key: 'c', ctrlKey: false } as KeyboardEvent)).toBe(false)
    // 大写 C 是同一个键（Shift 那侧已经在上面被排除，这里只问大小写归一化）。
    expect(isBareCtrlC({ ...key(), key: 'C', ctrlKey: true } as KeyboardEvent)).toBe(true)
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
