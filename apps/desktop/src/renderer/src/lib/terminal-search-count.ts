/**
 * 「第 3 个 / 共 47 个」——搜索结果的位置与总量投影。
 *
 * 事实从哪来：xterm search addon 的 `onDidChangeResults` 事件，给 `{ resultIndex, resultCount }`。
 * 我们不自己数匹配——addon 已经为了画高亮把匹配全找了一遍，再数一遍就是第二个真相来源。
 *
 * 但那两个数**不能照抄成文案**，addon 的实现（lib/addon-search.js）有两处与 typings 的说法不符：
 *
 * 1. `resultCount` 是**高亮**的条数，而高亮有上限：`_highlightLimit = options.highlightLimit ?? 1000`，
 *    `_highlightAllMatches` 的循环条件是 `i.length >= this._highlightLimit` 就停。所以在几千行日志里
 *    搜一个常见词，count 会**恰好停在 1000**，而真实匹配可能有五千条。把它当总数写成「共 1000 个」
 *    是撒谎——那正是这个功能存在的理由（用户想知道「搜到 1 条还是 400 条」），撒在这一点上等于没做。
 *    命中上限时只说「1000+」，把"这是下界"如实说出来。
 *
 * 2. typings 说 `-1 for resultIndex when the threshold of matches is exceeded`，但 `_fireResults`
 *    里 `-1` 的真实含义是「当前选中的那条不在高亮列表里」——**包括压根没有选中**的常态（刚打开面板、
 *    刚清掉选区）。所以 -1 不许被当作"超阈值"来报，它只意味着「位置未知」：此时报总量，不报序号。
 *
 * 为什么是纯函数而不是在组件里拼字符串：这里每一个分支都是一句会给用户看的话，而其中两句
 * （上限截断、位置未知）在正常使用中**很难人工触发**——需要一屏一千个匹配。让它们能被直接断言，
 * 是这两句话唯一能被验证的方式。
 */

/** addon 在 `onDidChangeResults` 里给的原始事实。 */
export type TerminalSearchResults = {
  /** 当前选中项在高亮列表里的下标（0 基）；`-1` 表示没有选中项或它不在列表里。 */
  resultIndex: number
  /** 已高亮的匹配条数；命中 `highlightLimit` 时是被截断的下界，不是总数。 */
  resultCount: number
}

/**
 * addon 的高亮上限。
 *
 * 与我们创建 SearchAddon 时传的 `highlightLimit` 必须是同一个值——两处各写一个数就会漂移，
 * 而漂移的后果是：真的截断了却不加那个 `+`（说谎），或者没截断也加（凭空制造不确定）。
 * 所以这个常量是 SSOT，创建 addon 的地方从这里取，不许再手写一个字面量。
 *
 * 值取 addon 自己的默认（`?? 1e3`）：我们没有理由改它，而显式传入让「两边同一个数」这件事
 * 有人可查——不传就得靠"库的默认恰好是 1000"这条无人守的假设。
 */
export const TERMINAL_SEARCH_HIGHLIGHT_LIMIT = 1000

/**
 * 把 addon 的原始计数投影成一句给用户看的话。
 *
 * 返回 `undefined` = 没什么可说：一条都没匹配上。那种情况归"没找到"的措辞管，不在这里说
 * 「0 of 0」——那是用数字复述一件已经说过的事。
 */
export function terminalSearchCountLabel(results: TerminalSearchResults): string | undefined {
  if (results.resultCount <= 0) return undefined
  // 命中上限：count 是下界而不是总数，如实带上 `+`。
  const total = results.resultCount >= TERMINAL_SEARCH_HIGHLIGHT_LIMIT
    ? `${TERMINAL_SEARCH_HIGHLIGHT_LIMIT}+`
    : `${results.resultCount}`
  // 位置未知（没有选中项，或选中项不在高亮列表里）：只报总量。报一个编出来的序号会让用户
  // 以为光标停在那一条上。
  if (results.resultIndex < 0) return `${total} matches`
  // 序号对用户是 1 基的。
  return `${results.resultIndex + 1} of ${total}`
}

/**
 * 把 addon 的结果事件接到界面上，返回取消订阅的手柄。
 *
 * 为什么订阅也放在这里而不是留在组件里：本仓库的组件测试用 `renderToStaticMarkup`，effect 完全
 * 不跑（见 render-to-static-markup-blind-to-effects），所以写在 `useEffect` 里的订阅**有没有真的
 * 建立**在那层测试里根本够不着——删掉整句 `search.onDidChangeResults(...)`，计数对用户彻底消失
 * 而组件断言全绿。搬进来之后这一步能被直接调、被直接断言。
 *
 * 组件那侧只剩一句转发，且必须把返回的 dispose 记进 addon owner 账——不 dispose 就是每次
 * 终端重建泄漏一个监听器，而泄漏的监听器还会往一个已卸载的 setState 里写。
 */
export function subscribeTerminalSearchCount(
  addon: { onDidChangeResults: (listener: (results: TerminalSearchResults) => void) => { dispose(): void } },
  showCount: (label: string | undefined) => void
): { dispose(): void } {
  return addon.onDidChangeResults((results) => {
    showCount(terminalSearchCountLabel(results))
  })
}
