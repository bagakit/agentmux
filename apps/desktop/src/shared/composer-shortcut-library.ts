import type { ComposerShortcut } from './contracts'

/**
 * 缺席时返回的那一份空列表——**共享冻结**的同一个引用，不是每次新建一个 `[]`。
 *
 * 这一条是承重的：取值层被放在 zustand 选择器里（`useAppStore((state) => resolveComposerShortcuts(...))`），
 * 而 zustand 按引用比较。就地 `?? []` 每次调用都是新引用，于是选择器永远"变了"，组件无限重渲染。
 * 更坏的是它只在**没有这个字段**的配置上炸——默认配置带着两条，所以开发时一路正常。
 */
const NO_PROMPTS: readonly ComposerShortcut[] = Object.freeze([])

/**
 * 本地 prompt 库的取值层。
 *
 * 为什么是函数而不是各处 `config.composerShortcuts ?? []`：这两个默认（缺席即空、缺 providerId 即
 * 通用）会被三方问到——Composer 的候选、裸词识别、设置页——而分居各处的同一个默认必然漂移。
 * 本仓 `resolveNotificationModeId` 是同一形状的先例，理由也一样。
 *
 * 缺席解析成空列表且**不回写盘**：空与缺席语义完全一样。更要紧的是内置那两条是
 * `DEFAULT_CONFIG` 里的默认项，用户删光后配置里就是空列表——任何「缺席即补默认」的回填都会把
 * 删掉的东西送回来。
 */
export function resolveComposerShortcuts(
  config: { composerShortcuts?: ComposerShortcut[] | undefined } | null | undefined
): readonly ComposerShortcut[] {
  return config?.composerShortcuts ?? NO_PROMPTS
}

/**
 * 某个 Provider 的 Composer 该看到哪些 prompt。
 *
 * `providerId` 缺席即通用（对所有 Agent 可见），绑定了就只在那个 Provider 出现。判据必须是
 * 「缺席 **或** 相等」两支：只写相等会让所有不绑定的 prompt 一条都不出现（那是最常见的情形），
 * 只写缺席则绑定这件事根本没有效果。
 *
 * `providerId` 参数自身缺席（还不知道是哪个 Agent，比如新标签页尚未选 Provider）时只给通用那些：
 * 此时无从判断绑定条是否适用，而把绑定条端出来是在一个它明确不属于的地方展示它。
 */
export function composerShortcutsForProvider(
  prompts: readonly ComposerShortcut[],
  providerId: string | undefined
): ComposerShortcut[] {
  return prompts.filter((prompt) => prompt.providerId === undefined || prompt.providerId === providerId)
}

/**
 * 一条 prompt 在候选列表里的样子：`/keyword` 作补全词，来源写进描述。
 *
 * 来源必须显示：候选里同时有 Provider 原生命令与用户自己的 Shortcut，而「打这个词会发生什么」在两者
 * 之间是不同的——一个交给 Provider 执行，一个只是把正文填进草稿。同名时用户看不出区别就会误发。
 *
 * 来源经 `group` 这个**字段**表达（浮层按它分段加标题），而不是塞进 description 让渲染层再解析回来。
 */
export const SHORTCUT_GROUP_LABEL = 'Shortcuts'
export const AGENT_COMMAND_GROUP_LABEL = 'Agent commands'

export function composerShortcutSuggestion(
  shortcut: ComposerShortcut
): { text: string; description: string; group: string } {
  return {
    text: `/${shortcut.keyword}`,
    description: shortcut.label,
    group: SHORTCUT_GROUP_LABEL
  }
}

/** 光标前的裸词若命中某条 prompt 的 keyword，返回那一条。命中判定是**整词相等**，不是前缀。 */
export function composerShortcutForBareWord(
  prompts: readonly ComposerShortcut[],
  word: string
): ComposerShortcut | undefined {
  return prompts.find((prompt) => prompt.keyword === word)
}

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
