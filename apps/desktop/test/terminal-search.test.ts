import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  DEFAULT_TERMINAL_SEARCH_TOGGLES,
  runTerminalSearch,
  toggleTerminalSearch,
  type TerminalSearchToggles
} from '../src/renderer/src/lib/terminal-search.js'

// ---------------------------------------------------------------------------
// 终端搜索的三个开关：区分大小写 / 正则 / 全词。
//
// 能力一直在 addon 里，这个 task 只是把它露出来——所以这里真正会坏的地方**不是判断逻辑，
// 是接线**：三个开关有没有原样送到 xterm 的调用参数上。一个开关的值在半路被写死成
// false，纯逻辑测试照样全绿，用户点了却什么也不变。所以断言直接盯**送到 addon 门口的
// 那个 options 对象**，一个键一条，剪断任一根线都会红。
//
// 另一半是正则开关带进来的崩溃口子：addon 内部是裸的 `RegExp(pattern, 'g')`，用户打
// `\[warn\]` 的中途必然经过 `[` 这种非法模式，抛 SyntaxError，而搜索是从 React 事件处理器
// 里调的、中间没有 error boundary——整个终端会被卸载。
// ---------------------------------------------------------------------------

type FakeAddon = {
  findNext: ReturnType<typeof vi.fn>
  findPrevious: ReturnType<typeof vi.fn>
  clearDecorations: ReturnType<typeof vi.fn>
}

function fakeAddon(): FakeAddon {
  return {
    findNext: vi.fn().mockReturnValue(true),
    findPrevious: vi.fn().mockReturnValue(true),
    clearDecorations: vi.fn()
  }
}

/** 送到 addon 的第二个参数——也就是 xterm 真正看到的搜索条件。 */
function optionsSentTo(addon: FakeAddon, previous = false): Record<string, unknown> {
  const call = previous ? addon.findPrevious.mock.calls[0] : addon.findNext.mock.calls[0]
  expect(call).toBeDefined()
  return call![1] as Record<string, unknown>
}

const ALL_ON: TerminalSearchToggles = { caseSensitive: true, regex: true, wholeWord: true }

describe('三个开关传进搜索调用', () => {
  it('默认三个都关，且默认值不可被就地改坏', () => {
    expect(DEFAULT_TERMINAL_SEARCH_TOGGLES).toEqual({
      caseSensitive: false,
      regex: false,
      wholeWord: false
    })
    // 冻结过：一个共享的默认对象被某处 mutate，会静默污染所有后开的搜索面板。
    expect(Object.isFrozen(DEFAULT_TERMINAL_SEARCH_TOGGLES)).toBe(true)
  })

  // 一个开关一条断言。合成一条 toEqual 也能测出剪断，但红的时候只说"对象不等"；
  // 分开写，红的那一行的名字就直接是断掉的那根线。
  for (const key of ['caseSensitive', 'regex', 'wholeWord'] as const) {
    it(`${key} 开着时以 true 到达 addon`, () => {
      const addon = fakeAddon()
      // 只开这一个，其余保持关闭：这样断言的是**这一根线**，而不是"有某个 true 传过去了"。
      const toggles: TerminalSearchToggles = { ...DEFAULT_TERMINAL_SEARCH_TOGGLES, [key]: true }
      runTerminalSearch(addon, 'needle', toggles, 'next')
      expect(optionsSentTo(addon)[key]).toBe(true)
    })

    it(`${key} 关着时以 false 到达 addon`, () => {
      const addon = fakeAddon()
      runTerminalSearch(addon, 'needle', { ...ALL_ON, [key]: false }, 'next')
      // 必须是显式 false 而不是缺席：addon 对缺席和 false 的处理这里不做假设。
      expect(optionsSentTo(addon)[key]).toBe(false)
    })
  }

  it('查询词原样传过去，不被开关改写', () => {
    const addon = fakeAddon()
    runTerminalSearch(addon, 'ERROR', ALL_ON, 'next')
    expect(addon.findNext.mock.calls[0]![0]).toBe('ERROR')
  })

  it('向前搜走 findPrevious，且关掉 incremental', () => {
    const addon = fakeAddon()
    runTerminalSearch(addon, 'needle', DEFAULT_TERMINAL_SEARCH_TOGGLES, 'previous')
    expect(addon.findNext).not.toHaveBeenCalled()
    // 向前找时增量语义会让光标原地不动——既有行为，这个 task 不改它，但要钉住。
    expect(optionsSentTo(addon, true).incremental).toBe(false)
    expect(optionsSentTo(addon, true).caseSensitive).toBe(false)
  })

  it('向后搜开 incremental', () => {
    const addon = fakeAddon()
    runTerminalSearch(addon, 'needle', DEFAULT_TERMINAL_SEARCH_TOGGLES, 'next')
    expect(optionsSentTo(addon).incremental).toBe(true)
  })

  it('高亮色带跟着一起送，不靠调用方补', () => {
    const addon = fakeAddon()
    runTerminalSearch(addon, 'needle', DEFAULT_TERMINAL_SEARCH_TOGGLES, 'next')
    // 漏掉它，匹配会用 xterm 的默认色画在深色终端底上。
    expect(optionsSentTo(addon).decorations).toMatchObject({ activeMatchBorder: '#ecc16a' })
  })
})

describe('打到一半的正则不能掀掉终端', () => {
  // xterm 的 search addon 内部是 `RegExp(pattern, 'g')`，没有 try。这几个模式是用户
  // 打 `[warn]` / `(a|b)` 途中必然经过的中间态。
  for (const half of ['[', '[wa', '(', '(a|', '*', '\\']) {
    it(`不合法模式 ${JSON.stringify(half)} 不发起搜索，也不抛出去`, () => {
      const addon = fakeAddon()
      // 这里同时钉住"不抛"：抛出去就是终端被卸载。
      const outcome = runTerminalSearch(addon, half, { ...ALL_ON, regex: true }, 'next')
      expect(addon.findNext).not.toHaveBeenCalled()
      expect(outcome.searched).toBe(false)
      expect(outcome.notice).toBeTruthy()
    })
  }

  it('合不合法以 RegExp 自己为准，不以直觉为准', () => {
    // `a{` 看着像打了一半的量词，但 JS 按 Annex B 的 web 兼容规则把它当字面量收下——**合法**。
    // 手写校验八成会拒掉它，于是用户明明能搜的东西被挡住。这条钉住的是那个设计选择本身：
    // 判断必须交给最终执行这个模式的那个引擎，任何近似都会和它分歧。
    expect(() => new RegExp('a{', 'g')).not.toThrow()
    const addon = fakeAddon()
    expect(runTerminalSearch(addon, 'a{', { ...ALL_ON, regex: true }, 'next').searched).toBe(true)
  })

  it('同样的模式在正则关着时是普通字面量，照常搜', () => {
    const addon = fakeAddon()
    // `[` 作为字面量完全合法——校验只能在开了正则时生效，否则等于把方括号从搜索里禁掉了。
    const outcome = runTerminalSearch(addon, '[', DEFAULT_TERMINAL_SEARCH_TOGGLES, 'next')
    expect(addon.findNext).toHaveBeenCalled()
    expect(outcome).toEqual({ searched: true })
  })

  it('打完整了就恢复搜索，提示消失', () => {
    const addon = fakeAddon()
    const regexOn = { ...DEFAULT_TERMINAL_SEARCH_TOGGLES, regex: true }
    expect(runTerminalSearch(addon, '[warn', regexOn, 'next').searched).toBe(false)
    const done = runTerminalSearch(addon, '[warn]', regexOn, 'next')
    expect(done.searched).toBe(true)
    // notice 必须真的消失。留着上一次的提示，用户看到的是"搜到了但还说我写错了"。
    expect(done.notice).toBeUndefined()
    expect(optionsSentTo(addon).regex).toBe(true)
  })

  it('模式不合法时不清高亮——那是上一次的有效结果', () => {
    const addon = fakeAddon()
    runTerminalSearch(addon, '[', { ...DEFAULT_TERMINAL_SEARCH_TOGGLES, regex: true }, 'next')
    expect(addon.clearDecorations).not.toHaveBeenCalled()
  })

  it('查询清空才清高亮，且不给提示', () => {
    const addon = fakeAddon()
    const outcome = runTerminalSearch(addon, '', ALL_ON, 'next')
    expect(addon.clearDecorations).toHaveBeenCalled()
    expect(addon.findNext).not.toHaveBeenCalled()
    // 面板刚打开、还没输字就挂一句提示是噪音。
    expect(outcome.notice).toBeUndefined()
  })
})

describe('翻转开关', () => {
  it('只翻中指定的那一个，其余不动', () => {
    expect(toggleTerminalSearch(DEFAULT_TERMINAL_SEARCH_TOGGLES, 'regex')).toEqual({
      caseSensitive: false,
      regex: true,
      wholeWord: false
    })
    expect(toggleTerminalSearch(ALL_ON, 'wholeWord')).toEqual({
      caseSensitive: true,
      regex: true,
      wholeWord: false
    })
  })

  it('返回新对象，不原地改', () => {
    const before = { ...DEFAULT_TERMINAL_SEARCH_TOGGLES }
    const after = toggleTerminalSearch(before, 'caseSensitive')
    // 原地改的话 React 认不出变化，按钮按下去不会重绘。
    expect(after).not.toBe(before)
    expect(before.caseSensitive).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 面板本身。组件测试用 renderToStaticMarkup，effect 不跑、点击发不出去，所以这几条读源码
// 断言接线——它们要挡的正是"逻辑全对但界面上根本没有这三个按钮"。
// ---------------------------------------------------------------------------
describe('搜索面板把三个开关露出来', () => {
  const view = readFileSync(
    new URL('../src/renderer/src/components/TerminalView.tsx', import.meta.url),
    'utf8'
  )

  it('三个开关都有按钮，各自带无障碍标签', () => {
    for (const label of ['Match case', 'Use regular expression', 'Match whole word']) {
      expect(view).toContain(label)
    }
    for (const key of ['caseSensitive', 'regex', 'wholeWord']) {
      expect(view).toContain(`key: '${key}'`)
    }
  })

  it('开启态同时走 aria-pressed 和 data-active', () => {
    // 只有颜色的话，色觉差异下读不出哪个开着；aria-pressed 让屏幕阅读器也读得出。
    expect(view).toContain('aria-pressed={searchToggles[key]}')
    expect(view).toContain('data-active=')
  })

  it('点开关时把翻转后的新状态传进搜索，不读 state', () => {
    // setState 是异步的：这里若写成 setSearchToggles(next) 之后调 searchTerminal(query)，
    // 读到的还是翻转前的值，于是第一次点不生效、第二次才生效。
    expect(view).toMatch(/const next = toggleTerminalSearch\(searchToggles, key\)/)
    expect(view).toMatch(/searchWith\(searchQuery,\s*next\)/)
  })

  it('提示由 runTerminalSearch 的结果驱动，不由组件自己判', () => {
    expect(view).toContain('runTerminalSearch(addon, query, toggles')
    expect(view).toContain('setSearchNotice(outcome.notice)')
  })

  it('关掉面板时清掉提示', () => {
    // 留着的话，下次打开会挂着一句针对上次输入的「正则还不完整」，而那时输入框是空的。
    const closeSearch = view.slice(view.indexOf('function closeSearch'))
    expect(closeSearch.slice(0, closeSearch.indexOf('\n  }'))).toContain('setSearchNotice(undefined)')
  })

  it('开启态是实心填充，不是描边', () => {
    // 控件语言：选中只用一个几何信号（docs/design/agentmux-surface-density.md）。
    const css = readFileSync(
      new URL('../src/renderer/src/styles/terminal.css', import.meta.url),
      'utf8'
    )
    const active = css.slice(css.indexOf('.terminal-search__toggle[data-active]'))
    const rule = active.slice(0, active.indexOf('}'))
    expect(rule).toContain('background: var(--green)')
    expect(rule).not.toContain('border')
  })
})
