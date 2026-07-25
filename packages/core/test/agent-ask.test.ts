import { describe, expect, it } from 'vitest'
import { answerAsk, cancelAsk, openAsk, timeOutAsk } from '../src/agent-ask.js'

// Ask 是"我问了你一个问题，在等答案"。它比一次投递多一件事：**答案本身**。
// 因此相同回答必须幂等（网络重试不该变成冲突），不同回答必须冲突（否则先到先得地
// 悄悄覆盖，问的人永远不知道对方改过口）。

const asked = openAsk({ askId: 'ask-1', messageId: 'm-1', at: 100 })

describe('提问', () => {
  it('起始于 pending', () => {
    expect(asked.state).toBe('pending')
    expect(asked.answer).toBeNull()
  })

  it('绑定发问的那条消息——超时后按原 Message 恢复，不另起一个问题', () => {
    expect(asked.messageId).toBe('m-1')
  })
})

describe('回答', () => {
  it('第一次回答落到 answered', () => {
    const done = answerAsk(asked, 'yes', 200)
    expect(done.state).toBe('answered')
    expect(done.answer).toBe('yes')
  })

  it('相同回答幂等——重试不该变成冲突', () => {
    const once = answerAsk(asked, 'yes', 200)
    const twice = answerAsk(once, 'yes', 300)
    expect(twice.state).toBe('answered')
    expect(twice.answer).toBe('yes')
    // 时刻保留第一次的：那才是答案真正到达的时候。
    expect(twice.at).toBe(200)
  })

  it('不同回答冲突——不能悄悄覆盖前一个答案', () => {
    const once = answerAsk(asked, 'yes', 200)
    expect(() => answerAsk(once, 'no', 300))
      .toThrowError(expect.objectContaining({ code: 'AGENT_ASK_ANSWER_CONFLICT' }))
  })
})

describe('超时与取消', () => {
  it('等过了就超时，落到 closed', () => {
    const out = timeOutAsk(asked, 400)
    expect(out.state).toBe('closed')
    expect(out.answer).toBeNull()
  })

  it('可以显式取消', () => {
    expect(cancelAsk(asked, 400).state).toBe('closed')
  })

  it('已回答的不会被超时冲掉——答案已经到了', () => {
    const once = answerAsk(asked, 'yes', 200)
    expect(() => timeOutAsk(once, 400))
      .toThrowError(expect.objectContaining({ code: 'AGENT_ASK_STATE_INVALID' }))
  })

  it('关闭之后不再接受回答——迟到的答案不能翻案', () => {
    const out = timeOutAsk(asked, 400)
    expect(() => answerAsk(out, 'yes', 500))
      .toThrowError(expect.objectContaining({ code: 'AGENT_ASK_STATE_INVALID' }))
  })

  it('重复取消是幂等的，不是错误', () => {
    // 取消两次表达的是同一个意图，报错只会逼调用方去猜自己是不是第一个。
    expect(cancelAsk(cancelAsk(asked, 400), 500).state).toBe('closed')
  })
})

describe('纯函数', () => {
  it('不改动传入对象', () => {
    const snapshot = JSON.stringify(asked)
    answerAsk(asked, 'yes', 200)
    timeOutAsk(asked, 300)
    expect(JSON.stringify(asked)).toBe(snapshot)
  })
})
