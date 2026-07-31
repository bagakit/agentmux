import { describe, expect, it } from 'vitest'
import type { AgentTimelineItem } from '../src/shared/contracts.js'
import {
  HUMAN_SPEAKER_ID,
  isConversationTurn,
  speakerOf
} from '../src/renderer/src/lib/conversation-speaker.js'

/**
 * 「这一条是谁说的」——把散在渲染层三处的二值判定收敛成一个判据之后，这里钉的是那个判据本身。
 *
 * 这些性质写在纯函数上而不是渲染断言上是有原因的：本仓渲染测试用 `renderToStaticMarkup`，一个
 * 写在组件里的分支只能通过它产出的 class 名间接观察，而「权威字段是哪个」这种判断在 class 名上
 * 看不出来——两种实现能给出一样的 markup，却在遇到第三个身份时行为相反。
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

describe('对话体的说话人判定', () => {
  it('人类的话按 source 认，而不是按 kind 认', () => {
    // 这是这个函数存在的理由。`kind:'user_message'` 与 `source:'user'` 在今天恒等价（Core 里只有
    // launch/send 一处产生用户消息，同时写死两个字段），所以任何只看其中一个的实现都能让常规用例
    // 全绿。要钉住「权威是 source」，必须构造一条**只有 source 说话**的条目：source 是 'user'，而
    // kind 不是 user_message。按 kind 反推身份的实现在这里会把人的话判成机器上报（null），而设计
    // SSOT 明确禁止按 kind 反推身份。
    const speaker = speakerOf(item({ source: 'user', kind: 'lifecycle' }))
    expect(speaker).toEqual({ role: 'human', id: HUMAN_SPEAKER_ID })
  })

  it('常规的用户消息（两个字段同时成立）当然也是人', () => {
    // 今天真实数据长这样：两个字段一致。上一条钉判据，这一条钉「判据没把常规情况判错」。
    expect(speakerOf(item({ source: 'user', kind: 'user_message' })))
      .toEqual({ role: 'human', id: HUMAN_SPEAKER_ID })
  })

  it('Agent 自己的话带上它自己的身份，而不是一个写死的字面量', () => {
    // 身份是 id，不是 role。今天 agent 的 id 就是 agentSessionId；A2A 落地后新增的参与者拿自己的
    // id 而 role 仍是 'agent'，调用方（取头像、排轴）不需要改。若有人把 id 写成常量 'agent'，
    // 这条会红——那正是「所有 Agent 挤成一个身份」的形态。
    expect(speakerOf(item({ kind: 'assistant_message', agentSessionId: 'agent-42' })))
      .toEqual({ role: 'agent', id: 'agent-42' })
  })

  it('两个不同 Agent 说的话是两个身份，不是同一个', () => {
    // 上一条只看单条。这条是 A2A 预留真正要买到的性质：同一条对话里两个 Agent 必须能被区分开。
    // 今天数据里还不会出现，但形状现在就得对——否则轴上并置多个头像时它们会全指向同一个身份。
    const first = speakerOf(item({ kind: 'assistant_message', agentSessionId: 'agent-a' }))
    const second = speakerOf(item({ kind: 'assistant_message', agentSessionId: 'agent-b' }))
    expect(first?.id).not.toBe(second?.id)
    // 而它们的类别相同——A2A 带来的是更多 agent 身份，不是一个新类别。
    expect(first?.role).toBe('agent')
    expect(second?.role).toBe('agent')
  })

  it('机器上报不是说话——三种都返回 null，而不是硬塞给 Agent', () => {
    // 这三种是「既不是人说话也不是 Agent 说话」。若把它们也判成 agent，对话体里每个 lifecycle
    // hook 都会长出一个头像和一条 turn，正文节奏就没了。
    for (const kind of ['tool_call', 'permission', 'lifecycle'] as const) {
      expect(speakerOf(item({ kind }))).toBeNull()
    }
  })

  it('Agent 的话不因证据来源不同就丢掉身份', () => {
    // assistant_message 可以从不同证据源到达（native-hook 之外还有 acp 等）。身份取自
    // agentSessionId，与证据源无关；若实现把 source 也当成 assistant 的必要条件，这里会红。
    for (const source of ['native-hook', 'acp', 'terminal-output', 'run-process'] as const) {
      expect(speakerOf(item({ kind: 'assistant_message', source })))
        .toEqual({ role: 'agent', id: 'agent-1' })
    }
  })

  it('「是一轮对话」与「有说话人」是同一个判据的两种问法，不是两份实现', () => {
    // 渲染层原先有一个只看 kind 的 isTurn，与 caption 的判据各写一遍。这条钉住两者不可能漂移：
    // 任何一条有说话人的都是 turn，任何一条没说话人的都不是。若有人日后给 isConversationTurn
    // 单独加一个 kind 白名单，这条就会在某个组合上红。
    const cases = [
      item({ source: 'user', kind: 'user_message' }),
      item({ source: 'user', kind: 'lifecycle' }),
      item({ kind: 'assistant_message' }),
      item({ kind: 'tool_call' }),
      item({ kind: 'permission' }),
      item({ kind: 'lifecycle' })
    ]
    for (const candidate of cases) {
      expect(isConversationTurn(candidate)).toBe(speakerOf(candidate) !== null)
    }
  })

  it('不改传进来的条目——判定是读，不是写', () => {
    // 纯函数的那一半承诺。折叠与 ruler 都在同一批 item 上反复调用它，一次意外的字段写入会变成
    // 一个只在特定滚动位置复现的 bug。
    const source = item({ source: 'user', kind: 'user_message' })
    const snapshot = structuredClone(source)
    speakerOf(source)
    isConversationTurn(source)
    expect(source).toEqual(snapshot)
  })
})
