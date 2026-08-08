import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import {
  installTerminalPasteSanitizer,
  pasteIntoTerminal
} from '../src/renderer/src/lib/terminal-paste.js'

// 控制字符一律构造，不敲裸字节也不写字面转义（tracker #385：一个裸控制字节让整个测试文件对
// git grep 永久失明）。
const ESC = String.fromCharCode(0x1b)
const VISIBLE_ESC = String.fromCharCode(0x241b)

/** 只实现被测代码真正用到的那一个方法，记录每次调用拿到的文本。 */
function terminal(): { pasted: string[]; paste: (text: string) => void } {
  const pasted: string[] = []
  return { pasted, paste: (text: string) => void pasted.push(text) }
}

/**
 * 最小 DOM 宿主替身：记录注册（含捕获标志），并能派发一次 paste。
 * 形状照 top-frame-navigation.test.ts 里 installFileDropGuard 那个 host()——同一族接线。
 */
function host() {
  const entries: Array<{ type: string; listener: EventListener; capture: boolean }> = []
  return {
    entries,
    addEventListener: vi.fn((type: string, listener: EventListener, options?: unknown) => {
      entries.push({ type, listener, capture: options === true })
    }),
    removeEventListener: vi.fn((type: string, listener: EventListener, options?: unknown) => {
      const index = entries.findIndex(
        (entry) =>
          entry.type === type && entry.listener === listener && entry.capture === (options === true)
      )
      if (index >= 0) entries.splice(index, 1)
    }),
    fire(clipboardText: string | null): {
      preventDefault: ReturnType<typeof vi.fn>
      stopImmediatePropagation: ReturnType<typeof vi.fn>
    } {
      const entry = entries.find((candidate) => candidate.type === 'paste')
      if (!entry) throw new Error('no paste listener installed')
      const preventDefault = vi.fn()
      const stopImmediatePropagation = vi.fn()
      entry.listener({
        type: 'paste',
        preventDefault,
        stopImmediatePropagation,
        clipboardData: clipboardText === null ? null : { getData: () => clipboardText }
      } as unknown as Event)
      return { preventDefault, stopImmediatePropagation }
    }
  }
}

describe('pasteIntoTerminal：渲染层唯一的粘贴出口', () => {
  it('喂给 xterm 的是消毒过的文本，不是剪贴板原字节', () => {
    // 上游 xterm 5.5.0 只**包**不**转义**（bracketTextForPaste 就是拼两个序列），所以载荷自带的
    // ESC[201~ 会提前闭合 bracket，其后的字节被 shell 当命令读。
    const term = terminal()
    pasteIntoTerminal(term, `${ESC}[201~; rm -rf /`)
    expect(term.pasted).toEqual([`${VISIBLE_ESC}[201~; rm -rf /`])
  })

  it('不含 ESC 的文本原样送达（消毒器不许顺手改别的字节）', () => {
    const term = terminal()
    pasteIntoTerminal(term, 'echo hello\nls -la')
    expect(term.pasted).toEqual(['echo hello\nls -la'])
  })
})

describe('installTerminalPasteSanitizer：接管原生 paste', () => {
  it('装的是**捕获期**监听——xterm 的 handlePasteEvent 从不看 defaultPrevented', () => {
    // 它只调 stopPropagation()，所以冒泡期的 preventDefault 拦不住它：唯一能先手的位置是捕获期。
    const dom = host()
    installTerminalPasteSanitizer(dom, terminal())
    expect(dom.entries).toHaveLength(1)
    expect(dom.entries[0]?.type).toBe('paste')
    expect(dom.entries[0]?.capture, '装成冒泡期了——xterm 会先拿到原始载荷').toBe(true)
  })

  it('同时 preventDefault 与 stopImmediatePropagation', () => {
    // stopPropagation 不够：xterm 把同一个 handler 注册在 textarea 和 element **两个**节点上，
    // 只有 stopImmediatePropagation 能一次掐掉同一节点上的其余监听。
    const dom = host()
    installTerminalPasteSanitizer(dom, terminal())
    const { preventDefault, stopImmediatePropagation } = dom.fire('x')
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(stopImmediatePropagation).toHaveBeenCalledOnce()
  })

  it('原生粘贴的文本经消毒后才进终端', () => {
    const dom = host()
    const term = terminal()
    installTerminalPasteSanitizer(dom, term)
    dom.fire(`${ESC}[201~payload`)
    expect(term.pasted).toEqual([`${VISIBLE_ESC}[201~payload`])
  })

  it('读不出文本时仍然夺走事件——绝不把原始载荷让回给 xterm', () => {
    // 这一条钉住「先夺权、再决定粘不粘」的顺序。反过来写（先取文本、空则直接 return）会让
    // clipboardData 缺席的那一次原样落到 xterm 手里。
    const dom = host()
    const term = terminal()
    installTerminalPasteSanitizer(dom, term)
    const { preventDefault, stopImmediatePropagation } = dom.fire(null)
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(stopImmediatePropagation).toHaveBeenCalledOnce()
    expect(term.pasted, '空剪贴板不该往终端写任何东西').toEqual([])
  })

  it('disposer 摘掉的是同一个监听、同一个捕获标志', () => {
    // removeEventListener 的捕获标志必须与注册时一致，否则摘不掉：重建终端（换主题/换 run）
    // 会让监听越挂越多，每次粘贴触发多份。
    const dom = host()
    const dispose = installTerminalPasteSanitizer(dom, terminal())
    dispose()
    expect(dom.entries).toEqual([])
    expect(dom.removeEventListener).toHaveBeenCalledOnce()
    expect(dom.removeEventListener.mock.calls[0]?.[2], '摘的时候丢了 capture 标志').toBe(true)
  })
})

/**
 * 接线层。上面那些断言全部只证明 lib 是对的——把 TerminalView 里那一句安装删掉，它们照旧全绿，
 * 而原生 Cmd+V 这条**更常用**的路径就彻底没有消毒了（#814 的整个由来）。
 *
 * 判据落在 AST 上而不是文本上：`toContain('installTerminalPasteSanitizer')` 会被注释、被
 * import 那一行、被一句 `console.log` 满足。这里要求的是「真有一次调用，且第一个实参取的就是
 * terminal.element」——宿主选错（比如传我们自己的 rootRef）会让终端搜索框的粘贴被一起劫走。
 */
describe('TerminalView 接线：装在 terminal.element 上，且两条入口共用同一个出口', () => {
  const viewPath = fileURLToPath(
    new URL('../src/renderer/src/components/TerminalView.tsx', import.meta.url)
  )

  function parse(name: string, source: string): ts.SourceFile {
    return ts.createSourceFile(name, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX)
  }

  /** 文件里对 `name(...)` 的每一次调用（裸标识符 callee），按出现顺序。 */
  function callsTo(sourceFile: ts.SourceFile, name: string): ts.CallExpression[] {
    const found: ts.CallExpression[] = []
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) {
        found.push(node)
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
    return found
  }

  /** 实参写成 `a.b` 时给出 'a.b'，否则给出它的源文本（诊断用）。 */
  function argumentText(call: ts.CallExpression, index: number): string {
    const argument = call.arguments[index]
    if (!argument) return '<缺席>'
    return argument.getText()
  }

  const view = parse('TerminalView.tsx', readFileSync(viewPath, 'utf8'))

  it('恰好安装一次消毒器', () => {
    expect(
      callsTo(view, 'installTerminalPasteSanitizer'),
      '安装点消失或重复了——消失=原生 Cmd+V 不消毒，重复=一次粘贴贴两份'
    ).toHaveLength(1)
  })

  it('宿主实参取的是 terminal.element，而不是我们自己的容器', () => {
    // 结构性作用域：粘贴目标只可能是 element 子树里那个 helper textarea（唯一 tabIndex=0 的节点），
    // 而终端搜索框那个 input 是 element 的**兄弟**。装到共同父节点上就会把搜索框的粘贴也劫走。
    const [install] = callsTo(view, 'installTerminalPasteSanitizer')
    const host = argumentText(install!, 0)
    // 直接传 terminal.element，或先取到一个局部变量再传——两种都要求那个局部变量确实来自
    // terminal.element，所以这里连它的声明一起查。
    const fromElement =
      host === 'terminal.element' || declaredFrom(view, host) === 'terminal.element'
    expect(fromElement, `宿主实参是 ${host}，它不来自 terminal.element`).toBe(true)
  })

  it('第二个实参是那个终端本身', () => {
    const [install] = callsTo(view, 'installTerminalPasteSanitizer')
    expect(argumentText(install!, 1)).toBe('terminal')
  })

  it('拆卸时调用了 disposer——否则每次重建终端都多挂一个监听', () => {
    // 上面「disposer 摘掉的是同一个监听」只证明返回的那个函数是对的；它有没有**被调用**是另一件事。
    // 实测：把 effect 清理里的 pasteSanitizer() 删掉，其余 12 条全绿（换主题/换 run 会重建终端，
    // 旧 element 上的监听虽随节点一起走，但持有的 terminal 闭包让整棵旧终端无法回收）。
    const called = callsTo(view, 'pasteSanitizer')
    expect(called, 'effect 清理里没人调 pasteSanitizer()').toHaveLength(1)
    // 且必须在清理函数里，不是在别处顺手调掉——那样监听刚装上就被摘了。
    expect(enclosingCleanupReturn(called[0]!), 'pasteSanitizer() 不在 effect 的清理函数里').toBe(true)
  })

  it('右键菜单那条路也走 pasteIntoTerminal，不自己调 terminal.paste', () => {
    // 两条入口给出同一个答案，是这次改动的**全部意义**；只修一条就立刻重建「同一概念两处判定」。
    expect(callsTo(view, 'pasteIntoTerminal').length, '菜单 paste 那条路没接上').toBeGreaterThan(0)
    expect(
      view.getFullText().includes('terminal.paste('),
      'TerminalView 里还有直接调 terminal.paste 的地方——那条路绕过了消毒'
    ).toBe(false)
  })

  /** `const x = <expr>` 里 x 的初始化式源文本；找不到给空串。 */
  function declaredFrom(sourceFile: ts.SourceFile, name: string): string {
    let initializer = ''
    const visit = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === name &&
        node.initializer
      ) {
        initializer = node.initializer.getText()
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
    return initializer
  }

  /**
   * 这个节点是不是坐在某个 `return () => { … }` 里面——effect 清理函数的形状。
   * 只判「祖先链上有一个箭头函数，而它自己就是某条 return 的取值」，不认死具体是哪个 effect：
   * 换个 effect 名字、把清理拆成 helper 都不该打假红，真正要抓的是「压根没人调」。
   */
  function enclosingCleanupReturn(node: ts.Node): boolean {
    for (let cursor = node.parent; cursor; cursor = cursor.parent) {
      if (
        (ts.isArrowFunction(cursor) || ts.isFunctionExpression(cursor)) &&
        cursor.parent &&
        ts.isReturnStatement(cursor.parent)
      ) {
        return true
      }
    }
    return false
  }

  it('自检：判据认得出「宿主换成别的容器」这次变异', () => {
    // 没有这一条，上面两条断言可能只是恰好在一个它读不懂的形状上返回了 true。
    const probe = parse(
      'probe.tsx',
      'const sanitizer = installTerminalPasteSanitizer(root, terminal)\n'
    )
    const [call] = callsTo(probe, 'installTerminalPasteSanitizer')
    expect(argumentText(call!, 0)).toBe('root')
    expect(declaredFrom(probe, 'root'), '把没声明的名字当成了 terminal.element').toBe('')
  })

  it('自检：判据认得出经局部变量中转的合法写法', () => {
    const probe = parse(
      'probe.tsx',
      'const pasteHost = terminal.element\n' +
        'const sanitizer = pasteHost ? installTerminalPasteSanitizer(pasteHost, terminal) : () => {}\n'
    )
    const [call] = callsTo(probe, 'installTerminalPasteSanitizer')
    expect(declaredFrom(probe, argumentText(call!, 0))).toBe('terminal.element')
  })
})
