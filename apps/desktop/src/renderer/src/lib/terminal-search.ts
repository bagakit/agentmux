import type { SearchAddon } from '@xterm/addon-search'
import { safeTerminalFind, TERMINAL_SEARCH_DECORATIONS } from './terminal-search-safe-find.js'

/**
 * 「区分大小写、正则、全词」——终端搜索的三个开关，以及执行一次搜索的完整一步。
 *
 * 能力**本来就在**：`safeTerminalFind` 一直在转发 `ISearchOptions`，xterm 的 search addon 原生支持
 * `caseSensitive`/`regex`/`wholeWord`。缺的只是把它们露出来。翻长篇 Agent 日志时，区分大小写和
 * 正则是刚需——一个 `error` 在几千行里可能出现上百次，而 `ERROR` 只出现三次。
 *
 * 但正则开关带进来一个真问题：**输入是一个字符一个字符来的**。用户想打 `\[warn\]`，中途必然
 * 经过 `[`、`[w`、`[wa` 这些**非法**正则。addon 内部是裸的 `RegExp(pattern, 'g')`，非法模式抛
 * `SyntaxError`；而 `safeTerminalFind` 只吞装饰宽度那一个异常，其余原样上抛。搜索是从 React 事件
 * 处理器里调的，中间没有 error boundary——于是**打到一半整个终端被卸载**。
 *
 * 所以这里先判模式合不合法：不合法就不发起搜索，如实说明"这个正则还不完整"，等用户打完。
 * 不合法的模式**不是错误**，是打字打到一半——所以措辞是提示不是报错，也不清掉已有的高亮。
 *
 * 整步（判断 → 选项翻译 → 调 addon）都放在这里而不是留在组件里：本仓库测试用
 * `renderToStaticMarkup`，effect 不跑、事件发不出去，写在组件里的分支断言够不着。开关有没有
 * **真的传进搜索调用**是这个功能唯一会坏的地方——纯逻辑再全，接线断了照样全绿。所以
 * `runTerminalSearch` 收下 addon 本身，让假 addon 能把送到 xterm 门口的东西原样接住。
 */

/** 三个开关的状态。 */
export type TerminalSearchToggles = {
  caseSensitive: boolean
  regex: boolean
  wholeWord: boolean
}

/** 三个开关都关——搜索面板首次打开时的状态。 */
export const DEFAULT_TERMINAL_SEARCH_TOGGLES: TerminalSearchToggles = Object.freeze({
  caseSensitive: false,
  regex: false,
  wholeWord: false
})

/**
 * 这一步的结果。
 *
 * 只说「用户还需要知道点什么」——不自报"我搜了没有"：那种自报是**比事实弱的证据**，
 * 测试要证明搜索真的发生了，该看 addon 有没有被调到，而不是听这个返回值怎么说自己。
 * `notice` 缺席就是没话说；空查询不给理由，面板刚打开就挂一句提示是噪音。
 */
type TerminalSearchOutcome = { notice?: string }

/**
 * 这个模式**在 addon 会真的编译的那个形态下**能不能用。
 *
 * 用 `RegExp` 自己来判，不自己写校验——它才是最终执行这个模式的东西，任何手写的近似判断
 * 都会和它产生分歧，而分歧的那一侧就是崩溃。
 *
 * 但"交给 RegExp 判"还不够，**得判对那个字符串**：addon 在不区分大小写时编译的是
 * `term.toLowerCase()`（`_findInLine` 里 `caseSensitive ? term : term.toLowerCase()`，
 * 紧接着裸的 `RegExp(_, 'g')`）。于是存在一类模式**原样合法、小写后非法**——
 * `[Z-a]`（Z 到 a 之间那段 ASCII，是个真实写法）小写成 `[z-a]` 就是逆序区间；
 * 同理 `(?<AB>x)(?<ab>y)` 小写后成了重名捕获组。校验原串就会放它过去，
 * 然后在 addon 里抛出来——正好落在这个功能要挡的那个崩溃上，而且是在**默认**的
 * 不区分大小写模式下。所以按开关决定校验哪一个形态。
 */
function regexUsable(pattern: string, caseSensitive: boolean): boolean {
  try {
    // eslint-disable-next-line no-new
    new RegExp(caseSensitive ? pattern : pattern.toLowerCase(), 'g')
    return true
  } catch {
    return false
  }
}

/**
 * 三个开关翻译成 addon 的搜索选项。
 *
 * `incremental` 只在向后（next）时开：向前找时增量语义会让光标原地不动。这条是既有行为，
 * 原样保留，不趁机改。
 */
function searchOptions(
  toggles: TerminalSearchToggles,
  direction: 'next' | 'previous'
): { caseSensitive: boolean; regex: boolean; wholeWord: boolean; incremental: boolean } {
  return {
    caseSensitive: toggles.caseSensitive,
    regex: toggles.regex,
    wholeWord: toggles.wholeWord,
    incremental: direction === 'next'
  }
}

/**
 * 按当前开关跑一次搜索。
 *
 * 两种不发起：查询为空（什么都没输，顺手清掉上一轮高亮），开了正则但模式还不合法（正在打字，
 * **留着**上一轮高亮，只如实说明这次没搜——否则用户会以为是搜不到）。
 */
export function runTerminalSearch(
  addon: Pick<SearchAddon, 'findNext' | 'findPrevious' | 'clearDecorations'>,
  query: string,
  toggles: TerminalSearchToggles,
  direction: 'next' | 'previous'
): TerminalSearchOutcome {
  if (!query) {
    addon.clearDecorations()
    return {}
  }
  if (toggles.regex && !regexUsable(query, toggles.caseSensitive)) {
    return { notice: 'Incomplete regular expression' }
  }
  // 装饰色带在这里而不是让调用方拼：调用方漏掉它，匹配就会用 xterm 的默认色画在深底上。
  safeTerminalFind(addon, query, direction, {
    ...searchOptions(toggles, direction),
    decorations: TERMINAL_SEARCH_DECORATIONS
  })
  return {}
}

/** 翻转一个开关，返回新状态——不原地改，让 React 认得出变化。 */
export function toggleTerminalSearch(
  toggles: TerminalSearchToggles,
  key: keyof TerminalSearchToggles
): TerminalSearchToggles {
  return { ...toggles, [key]: !toggles[key] }
}
