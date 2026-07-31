import type { AgentTimelineItem } from '../../../shared/contracts'

/**
 * 「这枚标记要展示的原话是什么」——把一条 timeline item 收敛成面板要显示的那段引文。
 *
 * ## 为什么是原话，不是摘要
 *
 * 轴的用途是让人不滚动就找到「那句话在哪儿」。摘要回答不了这个问题：两轮都被摘成「问了个问题」
 * 时，面板等于没说。所以取的是 `content` 本身。
 *
 * ## 为什么这是一个纯函数，而不是面板组件里的一段 JSX
 *
 * 「面板内容是该 item 的原话」是一条可以在无 DOM 处判定的性质，而 `renderToStaticMarkup` 对 effect
 * 完全失明、对"内容从哪儿来"也只能靠字符串比对——把取值抽出来，这条性质就能被直接钉住，而不是
 * 通过渲染结果间接推断。同一个理由已经让轴的定位与筛选收敛成 {@link conversationAxis}。
 *
 * ## 空与超长
 *
 * `content` 是 optional，且实测会是空串（lifecycle 那类事件没有话）。没有话时返回 `null`——由调用方
 * 决定不开面板，而不是开一个空面板：一个空面板会让人以为"这条没内容"和"面板坏了"是同一件事。
 *
 * 长引文按**字符数**截断并缀 `…`。上限 280 不是排版数字而是可读性数字：面板是浮层，覆盖屏幕越多越
 * 挡住它所描述的那条轴；而真要读全文，日志里那一行本来就在（点标记就会选中并滚到它）。截断保留
 * 开头而不是结尾：一句话的主语与动作在开头，掐掉尾巴仍认得出是哪一句。
 */
export const QUOTE_MAX_CHARS = 280

export function conversationQuote(item: AgentTimelineItem): string | null {
  const content = item.content?.trim()
  if (!content) return null
  if (content.length <= QUOTE_MAX_CHARS) return content
  // 从截断点往前找一个空白，避免把一个词劈成两半；找不到（比如一长串无空白的字符）就硬截。
  const cut = content.slice(0, QUOTE_MAX_CHARS)
  const lastSpace = cut.lastIndexOf(' ')
  const kept = lastSpace > QUOTE_MAX_CHARS * 0.6 ? cut.slice(0, lastSpace) : cut
  return `${kept.trimEnd()}…`
}
