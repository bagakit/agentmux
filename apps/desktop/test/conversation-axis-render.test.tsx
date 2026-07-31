import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AgentTimelineItem } from '../src/shared/contracts.js'
import { ConversationAxis } from '../src/renderer/src/components/ConversationAxis.js'
import { speaksAsAgent, speaksAsHuman } from '../src/renderer/src/lib/conversation-axis.js'
import { HUMAN_SPEAKER_ID } from '../src/renderer/src/lib/conversation-speaker.js'
import type { ConversationSpeaker } from '../src/renderer/src/lib/conversation-speaker.js'

/**
 * 两条轴的渲染验收。
 *
 * 这一栈用 `renderToStaticMarkup`，所以 effect 不跑——每条断言都落在标记上，不落在注册的 handler 上。
 * 定位与筛选本身已由 conversation-axis.test.ts 在纯函数层钉住；这里只钉**渲染层新增的那些性质**：
 * 一个组件两种配置、空轴不占位、身份解析留在调用方、标记可点可聚焦、轴上不泄漏时刻。
 */
function item(overrides: Partial<AgentTimelineItem>): AgentTimelineItem {
  return {
    id: 'item-1',
    agentSessionId: 'agent-1',
    kind: 'lifecycle',
    status: 'complete',
    source: 'native-hook',
    createdAt: 1_000,
    updatedAt: 1_000,
    title: 'Event',
    ...overrides
  }
}

function conversationFixture(): AgentTimelineItem[] {
  return [
    item({ id: 'u1', source: 'user', kind: 'user_message', createdAt: 0, content: '第一句问' }),
    item({ id: 't1', kind: 'tool_call', source: 'native-hook', createdAt: 250 }),
    item({ id: 'a1', kind: 'assistant_message', source: 'native-hook', createdAt: 1_000, content: 'Agent 的答' }),
    item({ id: 'u2', source: 'user', kind: 'user_message', createdAt: 4_000, content: '第二句问' })
  ]
}

const describeSpeaker = (speaker: ConversationSpeaker): { name: string; providerId?: 'claude' } =>
  speaker.role === 'human' ? { name: 'You' } : { name: 'Claude', providerId: 'claude' }

function render(node: Parameters<typeof renderToStaticMarkup>[0]): string {
  return renderToStaticMarkup(node)
}

describe('对话轴的渲染', () => {
  it('同一个组件换一个谓词就是另一条轴——代码里不存在两个轴组件', () => {
    // 「一个可复用组件按轴的语义参数化，不是两个」的可执行形式：同一个 ConversationAxis，只把
    // belongs 从 speaksAsHuman 换成 speaksAsAgent，渲染出的标记集合就不同。若有人把轴语义写死，
    // 两条轴会给出同一批标记，这条立刻红。
    const items = conversationFixture()
    const human = render(
      <ConversationAxis
        items={items}
        belongs={speaksAsHuman}
        label="Speakers"
        size={16}
        describe={describeSpeaker}
        selectedIndex={null}
        onSelect={() => {}}
      />
    )
    const agent = render(
      <ConversationAxis
        items={items}
        belongs={speaksAsAgent}
        label="This agent"
        size={16}
        describe={describeSpeaker}
        selectedIndex={null}
        onSelect={() => {}}
      />
    )
    // 人类轴上两枚（u1、u2），Agent 轴上一枚（a1）——数量与身份都不同。
    expect(human.match(/conversation-axis__mark/g)).toHaveLength(2)
    expect(agent.match(/conversation-axis__mark/g)).toHaveLength(1)
    expect(human).toContain('conversation-avatar--human')
    expect(human).not.toContain('conversation-avatar--agent')
    expect(agent).toContain('conversation-avatar--agent')
    expect(agent).not.toContain('conversation-avatar--human')
    // 两条轴各有自己的可访问名，读屏能分清在听哪条轴。
    expect(human).toContain('aria-label="Speakers"')
    expect(agent).toContain('aria-label="This agent"')
  })

  it('空轴不占位——一条还没有人说话的 Session 上不画空槽', () => {
    // 验收「轴在没有任何标记时不占位撑高」。返回空字符串而不是一个空的轨道 div：画一条空槽会让
    // "这里有一条你还没用上的功能"占掉纵向密度，而它什么也不表达。只有机器上报时说话人轴是空的。
    const machineOnly = [
      item({ id: 't1', kind: 'tool_call', source: 'native-hook', createdAt: 0 }),
      item({ id: 'l1', kind: 'lifecycle', source: 'native-hook', createdAt: 100 })
    ]
    const empty = render(
      <ConversationAxis
        items={machineOnly}
        belongs={speaksAsHuman}
        label="Speakers"
        size={16}
        describe={describeSpeaker}
        selectedIndex={null}
        onSelect={() => {}}
      />
    )
    expect(empty).toBe('')
    // 完全没有 item 时同样不画。
    expect(
      render(
        <ConversationAxis
          items={[]}
          belongs={speaksAsHuman}
          label="Speakers"
          size={16}
          describe={describeSpeaker}
          selectedIndex={null}
          onSelect={() => {}}
        />
      )
    ).toBe('')
  })

  it('位置按全量时间基准落在百分比上，与主刻度同源', () => {
    // 全量 createdAt 是 0/250/1000/4000，所以人类的两条发言 u1 在 0%、u2 在 100%；Agent 的 a1 在
    // 1000/4000 = 25%。若实现在筛过的子集上重建 scale，a1 会落到 0%（子集只有它一条、scale 退化）,
    // 这条立刻红——这是「两条轴时间基准同源」在渲染层的证据。
    const items = conversationFixture()
    const human = render(
      <ConversationAxis
        items={items}
        belongs={speaksAsHuman}
        label="Speakers"
        size={16}
        describe={describeSpeaker}
        selectedIndex={null}
        onSelect={() => {}}
      />
    )
    const agent = render(
      <ConversationAxis
        items={items}
        belongs={speaksAsAgent}
        label="This agent"
        size={16}
        describe={describeSpeaker}
        selectedIndex={null}
        onSelect={() => {}}
      />
    )
    expect(human).toContain('left:0%')
    expect(human).toContain('left:100%')
    expect(agent).toContain('left:25%')
    expect(agent).not.toContain('left:0%')
  })

  it('身份解析走调用方给的 describe——组件自己不查 store，也不猜名字', () => {
    // 受控纯组件：名字与 providerId 都从 describe 来。这里给一个能分辨"是否真的被调用"的实现：
    // 返回与默认完全不同的名字，断言它出现在标记上。若组件写死 'You'/'Assistant' 之类的文字，
    // 或自己去查 provider，这条会红。
    const items = conversationFixture()
    const markup = render(
      <ConversationAxis
        items={items}
        belongs={speaksAsHuman}
        label="Speakers"
        size={16}
        describe={() => ({ name: '张三' })}
        selectedIndex={null}
        onSelect={() => {}}
      />
    )
    expect(markup).toContain('aria-label="张三"')
    expect(markup).not.toContain('aria-label="You"')
  })

  it('describe 不给 providerId 时仍画出 agent 那一路的头像', () => {
    // providerId 查不到是常态（Session 已退场、store 未装载）。缺失时头像仍是 agent 画法、仍有色相，
    // 不许退化成人形剪影，也不许整枚消失留一个无法解释的空位。
    const items = conversationFixture()
    const markup = render(
      <ConversationAxis
        items={items}
        belongs={speaksAsAgent}
        label="This agent"
        size={16}
        describe={() => ({ name: 'Unknown agent' })}
        selectedIndex={null}
        onSelect={() => {}}
      />
    )
    expect(markup).toContain('conversation-avatar--agent')
    expect(markup).toContain('aria-label="Unknown agent"')
    expect(markup).toMatch(/--speaker-hue:\s*[0-9]+/)
    expect(markup).toContain('<svg')
  })

  it('每枚标记是 button——可点、可聚焦、Enter 天然可达，触屏也能用', () => {
    // 轴的用途是"不滚动就找到那句话在哪儿"，所以标记必须可点可聚焦。这同时是移植到触屏的前提：
    // hover 在触屏上不存在，若标记只对 hover 有反应，移植就得重写而不是退化。
    const items = conversationFixture()
    const markup = render(
      <ConversationAxis
        items={items}
        belongs={speaksAsHuman}
        label="Speakers"
        size={16}
        describe={describeSpeaker}
        selectedIndex={null}
        onSelect={() => {}}
      />
    )
    expect(markup.match(/<button[^>]*type="button"/g)).toHaveLength(2)
    // 不是带 onClick 的 span——那种写法键盘到不了。
    expect(markup).not.toMatch(/<span[^>]*class="conversation-axis__mark"/)
  })

  it('轴上不渲染任何钟点——时刻只能从 scale 的 readout 取', () => {
    // ruler 的诚实性是类型级的：序数轴上 RulerReadout 根本没有 `at` 字段，所以"在没有跨度的轴上
    // 显示钟点"写不出来。但轴标记手里的 `item.createdAt` 永远是个裸数字，继承不到那层保护——
    // 把它格式化进 title 就把那种不诚实又请了回来。这条钉住轴上一个时钟串都没有。
    const items = conversationFixture()
    for (const belongs of [speaksAsHuman, speaksAsAgent]) {
      const markup = render(
        <ConversationAxis
          items={items}
          belongs={belongs}
          label="Axis"
          size={16}
          describe={describeSpeaker}
          selectedIndex={null}
          onSelect={() => {}}
        />
      )
      expect(markup).not.toMatch(/\d{1,2}:\d{2}/)
      // 也不许把裸时间戳塞进标记的任何属性。
      expect(markup).not.toContain('4000')
      expect(markup).not.toContain('1000')
    }
  })

  it('主刻度选中的那条 item，在轴上同一位置也标出来', () => {
    // 选择是一个值，两处表现同一个值——而不是轴自己另存一份选中态。selectedIndex 用的是**全量
    // 下标**（u2 是 3），若实现拿轴内序号去比，选中会标错到另一枚头像上。
    const items = conversationFixture()
    const markup = render(
      <ConversationAxis
        items={items}
        belongs={speaksAsHuman}
        label="Speakers"
        size={16}
        describe={describeSpeaker}
        selectedIndex={3}
        onSelect={() => {}}
      />
    )
    // 恰好一枚被标记为选中，且是落在 100%（u2 的位置）那一枚。
    expect(markup.match(/data-selected/g)).toHaveLength(1)
    const selectedMark = markup.slice(markup.indexOf('data-selected') - 200, markup.indexOf('data-selected'))
    expect(selectedMark).toContain('left:100%')
  })

  it('人类身份不带 providerId 也不会去查 provider——human 那一路与 provider 无关', () => {
    // human 的画法不经过 provider 图标：即便 describe 对人类返回了一个 providerId，头像仍是人形
    // 剪影。这钉住「role 选画法」——providerId 只回答 agent 这一路怎么画。
    const items = conversationFixture()
    const markup = render(
      <ConversationAxis
        items={items}
        belongs={speaksAsHuman}
        label="Speakers"
        size={16}
        describe={() => ({ name: 'You', providerId: 'claude' })}
        selectedIndex={null}
        onSelect={() => {}}
      />
    )
    expect(markup).toContain('conversation-avatar--human')
    expect(markup).not.toContain('data-agent-provider="claude"')
  })

  it('人类哨兵 id 与 agentSessionId 共用 id 空间，所以两条轴的标记不许按 id 归并', () => {
    // 这条守的是一个结构性的陷阱：HUMAN_SPEAKER_ID 与 agentSessionId 都是字符串、同一个命名空间
    // （Core 的 SAFE_ID 允许 'human'）。若实现用 id 作为 React key 或作为归并依据，两条人类发言会
    // 因为共享同一个 id 而被折成一枚。这里断言两枚都在。
    const items = conversationFixture()
    const markup = render(
      <ConversationAxis
        items={items}
        belongs={speaksAsHuman}
        label="Speakers"
        size={16}
        describe={describeSpeaker}
        selectedIndex={null}
        onSelect={() => {}}
      />
    )
    expect(markup.match(/conversation-axis__mark/g)).toHaveLength(2)
    expect(HUMAN_SPEAKER_ID).toBe('human')
  })
})
