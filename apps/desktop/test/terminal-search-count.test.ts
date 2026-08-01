import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  TERMINAL_SEARCH_HIGHLIGHT_LIMIT,
  subscribeTerminalSearchCount,
  terminalSearchCountLabel
} from '../src/renderer/src/lib/terminal-search-count.js'

// ---------------------------------------------------------------------------
// 「第 3 个 / 共 47 个」的投影。事实来自 addon 的 onDidChangeResults，但那两个数不能照抄成文案——
// 读 @xterm/addon-search 的实现（lib/addon-search.js）确认了两处与 typings 说法不符的地方，
// 这里每一条断言各钉住其中一个。
// ---------------------------------------------------------------------------

describe('terminal search result count label', () => {
  it('reports the 1-based position within the total', () => {
    // resultIndex 是 0 基的，给用户看的序号是 1 基。抄成 0 基会让第一个匹配显示成「0 of 47」。
    expect(terminalSearchCountLabel({ resultIndex: 2, resultCount: 47 })).toBe('3 of 47')
    expect(terminalSearchCountLabel({ resultIndex: 0, resultCount: 1 })).toBe('1 of 1')
  })

  it('says nothing at all when nothing matched', () => {
    // 「0 of 0」是用数字复述一件已经由"没找到"说过的事。缺席即无话可说。
    expect(terminalSearchCountLabel({ resultIndex: -1, resultCount: 0 })).toBeUndefined()
  })

  it('reports only the total when the position is unknown', () => {
    // typings 说 -1 意味着"超阈值"，实现里 _fireResults 的 -1 其实是「当前选中项不在高亮列表里」，
    // 包括**压根没有选中**的常态（刚打开面板、刚清掉选区）。此时编一个序号会让用户以为光标停在
    // 那一条上，所以只报总量。
    expect(terminalSearchCountLabel({ resultIndex: -1, resultCount: 47 })).toBe('47 matches')
  })

  it('marks a truncated count as a lower bound, never as the total', () => {
    // 这是这个功能最要紧的一条诚实性。addon 的 _highlightAllMatches 在 _highlightLimit 处停止，
    // 于是在几千行日志里搜一个常见词，resultCount 会**恰好停在上限**而真实匹配远多于此。
    // 把它写成「共 1000 个」正好在这个功能存在的理由上撒谎——用户问的就是"1 条还是 400 条"。
    expect(terminalSearchCountLabel({
      resultIndex: 2,
      resultCount: TERMINAL_SEARCH_HIGHLIGHT_LIMIT
    })).toBe(`3 of ${TERMINAL_SEARCH_HIGHLIGHT_LIMIT}+`)
    expect(terminalSearchCountLabel({
      resultIndex: -1,
      resultCount: TERMINAL_SEARCH_HIGHLIGHT_LIMIT
    })).toBe(`${TERMINAL_SEARCH_HIGHLIGHT_LIMIT}+ matches`)
  })

  it('does not put a + on a count that merely got close to the limit', () => {
    // 反向那一侧：`>=` 写成 `>` 或干脆无条件加 `+`，都会让一个**精确**的计数变成不确定的。
    // 差一条就到上限时，那个数是真的总数。
    expect(terminalSearchCountLabel({
      resultIndex: 0,
      resultCount: TERMINAL_SEARCH_HIGHLIGHT_LIMIT - 1
    })).toBe(`1 of ${TERMINAL_SEARCH_HIGHLIGHT_LIMIT - 1}`)
  })
})

// ---------------------------------------------------------------------------
// 订阅那一步。它之所以在 lib 而不是留在组件的 useEffect 里：本仓的组件测试用
// renderToStaticMarkup，effect 完全不跑（见 render-to-static-markup-blind-to-effects），
// 于是"订阅有没有真的建立"在那层测试里够不着——删掉整句 onDidChangeResults，
// 计数对用户彻底消失而组件断言全绿。搬进来之后这一步能被直接调、直接断言。
// ---------------------------------------------------------------------------

function fakeSearchAddon() {
  const listeners: Array<(results: { resultIndex: number; resultCount: number }) => void> = []
  const dispose = vi.fn()
  return {
    listeners,
    dispose,
    onDidChangeResults: vi.fn((listener: (results: { resultIndex: number; resultCount: number }) => void) => {
      listeners.push(listener)
      return { dispose }
    })
  }
}

describe('terminal search count subscription', () => {
  it('pushes each result event through the projection', () => {
    const addon = fakeSearchAddon()
    const shown: Array<string | undefined> = []
    subscribeTerminalSearchCount(addon, (label) => shown.push(label))

    // 订阅必须在这一步就建立起来，不能等第一次搜索。
    expect(addon.onDidChangeResults).toHaveBeenCalledOnce()

    addon.listeners[0]!({ resultIndex: 2, resultCount: 47 })
    addon.listeners[0]!({ resultIndex: -1, resultCount: 0 })
    // 送出去的必须是**投影后**的文案：直接把两个数塞给界面，就把"截断的下界"和"位置未知"
    // 两个诚实性都丢在这一层了。
    expect(shown).toEqual(['3 of 47', undefined])
  })

  it('hands back the addon disposer so the listener can be released', () => {
    const addon = fakeSearchAddon()
    const handle = subscribeTerminalSearchCount(addon, () => {})
    // 不 dispose 就是每次终端重建泄漏一个监听器，而泄漏的那个还会往已卸载组件的 setState 里写。
    handle.dispose()
    expect(addon.dispose).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// 组件那一侧的接线。这几条是**源码断言**，买到的东西有限（它们看不见"这一句有没有被执行到"，
// 见 grep-guard-cannot-see-early-return），所以只用来守那些源码里就能判死的形状：
// 上限常量是不是同一个、dispose 有没有落在 cleanup 里、泄漏账有没有跟上。
// 行为本身由上面两个 describe 直接调函数来守。
// ---------------------------------------------------------------------------
describe('terminal search count wiring', () => {
  const view = readFileSync(
    new URL('../src/renderer/src/components/TerminalView.tsx', import.meta.url),
    'utf8'
  )
  const code = view.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

  it('creates the addon with the shared limit, never a second literal', () => {
    // 两处各写一个 1000 就会漂移，而漂移的后果是"真截断了却不加 +"（说谎）或反之。
    expect(code).toMatch(/new SearchAddon\(\{ highlightLimit: TERMINAL_SEARCH_HIGHLIGHT_LIMIT \}\)/)
    expect(code).not.toMatch(/highlightLimit:\s*\d/)
  })

  it('binds the counter to the real subscription, not to a local stand-in', () => {
    // 这一条守的是本条最容易复现的失效：把 `subscribeTerminalSearchCount(...)` 换成
    // `{ dispose: () => {} }`——订阅从此不存在、计数对用户彻底消失，而**其余 11 条断言全绿**
    // （实测）。搬进 lib 只让投影的**内容**可测，"这层壳有没有被执行到"照旧没人守
    // （见 extracting-to-lib-only-fixes-half）；能守的就是把初始化式本身钉死。
    expect(code).toMatch(
      /const searchCounter = subscribeTerminalSearchCount\(search, setSearchCount\)/
    )
    // 且那个名字必须解析到 lib，不能是同名的本地函数把守卫骗过去
    // （见 guard-criterion-must-be-import-relation：裸标识符绕得过文本断言）。
    expect(code).toMatch(
      /import \{[^}]*\bsubscribeTerminalSearchCount\b[^}]*\} from '\.\.\/lib\/terminal-search-count'/
    )
    expect(code).not.toMatch(/function subscribeTerminalSearchCount\b/)
  })

  it('lets nothing but the projection put a number on screen', () => {
    // 计数只有两个写入点：订阅（把投影后的文案送进来，以引用形式传入）与关面板时的显式清空。
    // 多一处 setSearchCount(...) 就意味着有人绕过投影自己拼了一句话，而那两条诚实性
    //（截断下界、位置未知）只活在投影里。
    const writes = [...code.matchAll(/setSearchCount\(/g)]
    expect(writes.length, 'setSearchCount 的调用点只该有 closeSearch 里那一次清空').toBe(1)
  })

  it('releases the count listener in the effect cleanup', () => {
    // 订阅在 effect 里建立，就必须在同一个 effect 的 cleanup 里释放：终端每次重建（换主题、
     // 换 run）都会跑一遍，不释放就是一次泄漏，而泄漏的监听器还会往已卸载的 setState 里写。
    const effectEnd = code.indexOf('return () => {', code.indexOf('subscribeTerminalSearchCount'))
    expect(effectEnd, '找不到订阅之后的 cleanup——接线的形状变了，这条守卫要跟着改').toBeGreaterThan(0)
    expect(code.slice(effectEnd)).toContain('searchCounter.dispose()')
  })

  it('counts the new listener in the leak account', () => {
    // 泄漏账是显式的：onData / onBinary / onDidChangeResults 三个订阅。少数一个就等于把
    // 一条泄漏账瞒下去，而这个账是资源面板唯一的判据来源。
    expect(code).toMatch(/listeners:\s*8\b/)
  })

  it('clears the count when the panel closes', () => {
    // clearDecorations 只擦高亮，addon 不会为"擦干净了"再发一次结果事件。不显式清的话，
    // 下次打开面板会先亮着上次的「3 of 47」，而那时输入框是空的。
    const closeSearch = code.slice(code.indexOf('function closeSearch'))
    expect(closeSearch.slice(0, closeSearch.indexOf('\n  }'))).toContain('setSearchCount(undefined)')
  })

  it('keeps the count live region mounted, swapping only its text', () => {
    // 与 notice 同理：读屏播报的是**已存在区域内的内容变化**，连同区域一起插进来的文字
    // 好几款读屏都不念。所以只能靠 hidden 收起来，不能条件挂载。
    expect(code).toMatch(/role="status" hidden=\{!searchCount\}/)
    expect(code).not.toMatch(/\{searchCount \?\s*\(/)
  })
})
