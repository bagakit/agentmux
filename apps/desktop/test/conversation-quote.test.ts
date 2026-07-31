import { describe, expect, it } from 'vitest'
import type { AgentTimelineItem } from '../src/shared/contracts.js'
import { QUOTE_MAX_CHARS, conversationQuote } from '../src/renderer/src/lib/conversation-quote.js'

/**
 * 面板要展示的那段引文，作为纯函数验收。
 *
 * 落在这里而不是渲染测试里：「面板内容是该 item 的原话」是一条在无 DOM 处就能判定的性质，而
 * `renderToStaticMarkup` 对内容来源只能靠字符串比对——把摘要写成恰好等于原话开头的实现能骗过
 * 渲染断言，骗不过这里。
 */
function item(overrides: Partial<AgentTimelineItem>): AgentTimelineItem {
  return {
    id: 'item-1',
    agentSessionId: 'agent-1',
    kind: 'user_message',
    status: 'complete',
    source: 'user',
    createdAt: 1_000,
    updatedAt: 1_000,
    title: 'Event',
    ...overrides
  }
}

describe('轴标记的引文取值', () => {
  it('取的是原话本身——不是标题、不是摘要', () => {
    // 判据能分辨「取 content」与「取 title」：两者给的是不同的字符串，而 title 恰恰是那种看起来
    // 也合理的错误来源（每条 item 都有 title，且它读起来像一句摘要）。
    const quote = conversationQuote(item({ content: '把这条改成从 manifest 派生', title: '用户提问' }))
    expect(quote).toBe('把这条改成从 manifest 派生')
    expect(quote).not.toContain('用户提问')
  })

  it('没有话的事件返回 null——由调用方决定不开面板，而不是开一个空面板', () => {
    // lifecycle / tool_call 那类机器上报没有 content。空面板会让「这条没内容」与「面板坏了」看起来
    // 是同一件事，所以这里把「没有可展示的话」编码成 null，让调用方有机会什么都不做。
    expect(conversationQuote(item({ kind: 'lifecycle', source: 'native-hook' }))).toBeNull()
    expect(conversationQuote(item({ content: '' }))).toBeNull()
    // 只有空白也算没有话——否则面板会浮出来一片空白，比不浮出来更费解。
    expect(conversationQuote(item({ content: '   \n\t ' }))).toBeNull()
  })

  it('两侧空白被剪掉——引文的第一个字符就是话的第一个字符', () => {
    expect(conversationQuote(item({ content: '  \n第一句问\n  ' }))).toBe('第一句问')
  })

  it('刚好到上限的引文一字不动——截断只在真的超长时发生', () => {
    // 边界两侧各钉一次。只钉「超长会截断」的话，一个把所有引文都截掉一截的实现照样绿。
    const exact = 'x'.repeat(QUOTE_MAX_CHARS)
    expect(conversationQuote(item({ content: exact }))).toBe(exact)
    expect(conversationQuote(item({ content: exact }))).not.toContain('…')
  })

  it('超长引文截断并缀省略号，且保留开头——主语与动作在开头', () => {
    const long = 'y'.repeat(QUOTE_MAX_CHARS + 50)
    const quote = conversationQuote(item({ content: long }))
    expect(quote).not.toBeNull()
    expect(quote!.endsWith('…')).toBe(true)
    // 长度含省略号仍不超上限：面板是浮层，越大越挡住它所描述的那条轴。
    expect(quote!.length).toBeLessThanOrEqual(QUOTE_MAX_CHARS + 1)
    expect(quote!.startsWith('yyy')).toBe(true)
  })

  it('截断不把一个词劈成两半——在截断点附近的空白处断开', () => {
    // 每个词 9 字符 + 空格，正好让上限落在某个词中间。断点必须退到空白处，而不是留半个词。
    const words = Array.from({ length: 60 }, (_, i) => `word${String(i).padStart(5, '0')}`).join(' ')
    expect(words.length).toBeGreaterThan(QUOTE_MAX_CHARS)
    const quote = conversationQuote(item({ content: words }))!
    expect(quote.endsWith('…')).toBe(true)
    // 去掉省略号后，最后一段必须是一个完整的词，而不是被切断的前缀。
    const kept = quote.slice(0, -1)
    const lastWord = kept.slice(kept.lastIndexOf(' ') + 1)
    expect(lastWord, `${lastWord} 不是完整的词——截断劈开了它`).toMatch(/^word\d{5}$/)
  })

  it('一长串没有空白的字符仍会被截断——退到空白的逻辑不能变成不截断', () => {
    // 找不到合适空白时必须硬截。若实现写成「找不到空白就整段返回」，面板会被一条超长 URL 或
    // base64 撑满整个屏幕，而这恰好是最需要截断的那一类内容。
    const blob = 'a'.repeat(QUOTE_MAX_CHARS * 2)
    const quote = conversationQuote(item({ content: blob }))!
    expect(quote.length).toBeLessThanOrEqual(QUOTE_MAX_CHARS + 1)
    expect(quote.endsWith('…')).toBe(true)
  })

  it('开头就有空白的超长引文不会被截成一小截——退让有下界', () => {
    // 「退到最后一个空白」若没有下界，`a b` + 一长串无空白字符会退到第 1 个空格，把 280 字的额度
    // 砍成 1 个字符。下界让这种输入宁可硬截也不至于只剩开头一个词。
    const content = `a ${'b'.repeat(QUOTE_MAX_CHARS * 2)}`
    const quote = conversationQuote(item({ content }))!
    expect(quote.length).toBeGreaterThan(QUOTE_MAX_CHARS * 0.6)
  })
})
