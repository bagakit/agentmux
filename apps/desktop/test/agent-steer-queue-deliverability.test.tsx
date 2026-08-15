import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AgentComposer } from '../src/renderer/src/components/AgentComposer.js'

/**
 * 一条队列里的 steer 在 run 退出后就再也发不出去了，但徽标当时仍然写着「queued for delivery」。
 *
 * 这是**承诺**与**能力**的错位，不是文案瑕疵：store 的 `flushAgentSteerQueue` 要求
 * `processState === 'running'` 才往下走，run 一退出就没有任何东西会再排空它；而用户在那一刻看到的
 * 唯一说明，恰恰在说它正在路上。他自己敲的字还在里面，屏幕上没有第二处告诉他这些不会到达。
 *
 * 判据落在**两侧都点名**，而不是只守「不可投递时不要说 delivery」：
 * 只守一侧的话，把两个分支都改成同一句悲观文案可以全绿——那会在正常路径上凭空造出一条假警报，
 * 属本仓记过的「措辞近似吃掉分类」。所以两条用例互为反面，且各自要求对方那句**不在场**。
 *
 * 用 renderToStaticMarkup：这两条断言只关心一次渲染的产物，不涉及 effect，
 * 本仓记过 renderToStaticMarkup 对 effect 完全失明——这里没有 effect 可失明。
 */
describe('AgentComposer 队列徽标的可投递性', () => {
  const queued = ['steer one', 'steer two']

  function render(deliverable: boolean, onCopyQueued?: (text: string) => void): string {
    return renderToStaticMarkup(createElement(AgentComposer, {
      value: '',
      disabled: false,
      placeholder: '',
      queued,
      queueDeliverable: deliverable,
      ...(onCopyQueued ? { onCopyQueued } : {}),
      onChange: () => {}
    }))
  }

  it('run 还活着时，如实说这些会被投递', () => {
    const markup = render(true)

    expect(markup).toContain('2 messages queued for delivery')
    expect(markup).toContain('Delivered in this order when the Agent finishes its current turn.')
    // 反面必须缺席：否则把两档合并成一句「都说不确定」也能过上面两条。
    expect(markup).not.toContain('not sent')
  })

  it('run 已经退出时，不再承诺投递，并说清这些字还在哪', () => {
    const markup = render(false)

    // 「不承诺」本身要可判：光改 <p> 不改徽标，读屏用户听到的仍是 delivery。
    expect(markup).not.toContain('queued for delivery')
    expect(markup).toContain('2 messages not sent')
    // 不是报错，是交代去向——文字还在。这句是这一档存在的理由，删了就只剩一个坏消息。
    expect(markup).toContain('They are kept here')
  })

  /**
   * 文案点名的动作必须当场做得到。
   *
   * 这一档的正文原本写着「copy them」，而卡片是个 `popover="auto"`——点卡片外任何地方它就关掉，
   * 用户只有拖选这一条路。那与徽标原来那句假承诺是同一个毛病：文案描述了一个界面并不提供的
   * 操作。所以按钮在场时才说「可以复制」，不在场时只说字还在。
   */
  it('能复制时才把复制说成办法，并且真给出按钮', () => {
    const markup = render(false, () => {})

    expect(markup).toContain('so you can copy them')
    expect(markup).toContain('Copy all')
  })

  it('没有复制出口时不提复制——不描述做不到的事', () => {
    // 剪贴板出口强制要一个报错口（lib/clipboard-copy），拿不到报错口的壳不该提供可能静默失败的
    // 动作。变异：让文案无条件说 "copy them"，这条红。
    const markup = render(false)

    expect(markup).not.toContain('copy them')
    expect(markup).not.toContain('Copy all')
  })

  it('单数时按钮说 message 而不是 all', () => {
    const markup = renderToStaticMarkup(createElement(AgentComposer, {
      value: '', disabled: false, placeholder: '',
      queued: ['only one'], queueDeliverable: false, onCopyQueued: () => {}, onChange: () => {}
    }))

    expect(markup).toContain('Copy message')
    expect(markup).toContain('1 message not sent')
  })

  it('可投递那一档不给复制按钮——它不是这一档要解决的问题', () => {
    const markup = render(true, () => {})

    expect(markup).not.toContain('Copy all')
  })

  it('两档都把用户原话原样留在卡片里——这才是「还在」的证据', () => {
    // 这条独立于文案：无论哪一档，队列内容本身都不许因为状态变化而消失。
    // 不可投递那一档尤其要紧——那正是用户唯一还能把字捞回去的地方。
    for (const deliverable of [true, false]) {
      const markup = render(deliverable)
      expect(markup).toContain('steer one')
      expect(markup).toContain('steer two')
    }
  })
})
