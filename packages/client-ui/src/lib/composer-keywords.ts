/**
 * keyword 里允许出现的字符，也就是「词」的定义。
 *
 * 不用 `\b`：JS 的 `\b` 把 `-` 当非词字符，于是 `\breview-changes\b` 在 `pre-review-changes` 里照样
 * 命中（`review` 前面那个 `-` 正好满足边界）。而本仓的默认 keyword 恰好就带 `-`（`review-changes`），
 * `grill_me` 带 `_`。所以边界自己判：两侧必须不是这一类字符。
 */
const KEYWORD_CHAR = /[A-Za-z0-9_-]/

function isKeywordBoundary(char: string | undefined): boolean {
  return char === undefined || !KEYWORD_CHAR.test(char)
}

/**
 * 文本里所有命中 keyword 的**整词**位置。下划线、提示、Tab 三处共用这一个判定。
 *
 * 为什么必须是同一个函数：这三处问的是同一个问题（「光标/这段文字里有没有一个识别词」），而分开算
 * 必然漂移——下划线画在一处、Tab 替换的是另一处，用户看到划了线却按不动，或按下去替换掉半个词。
 * 本仓「读的 key 与写的 key 必须只判一次」记的就是这一族。
 */
export function composerKeywordMatches(
  text: string,
  keywords: readonly string[]
): Array<{ from: number; to: number; keyword: string }> {
  const matches: Array<{ from: number; to: number; keyword: string }> = []
  for (const keyword of keywords) {
    if (!keyword) continue
    for (let at = text.indexOf(keyword); at !== -1; at = text.indexOf(keyword, at + 1)) {
      const to = at + keyword.length
      if (isKeywordBoundary(text[at - 1]) && isKeywordBoundary(text[to])) matches.push({ from: at, to, keyword })
    }
  }
  return matches.sort((left, right) => left.from - right.from)
}

/**
 * 光标**正停在其末尾**的那个识别词——Tab 唯一的触发条件。
 *
 * `to === caret` 而不是「光标落在词里」：词中间按 Tab 的人是在缩进/遍历焦点，不是要替换。这条正是
 * 「Tab 只在确实命中时接管」的判据来源；任何更宽的条件都会把普通的 Tab 吃掉。
 */
export function composerKeywordAtCaret(
  text: string,
  caret: number,
  keywords: readonly string[]
): string | undefined {
  return composerKeywordMatches(text, keywords).find((match) => match.to === caret)?.keyword
}
