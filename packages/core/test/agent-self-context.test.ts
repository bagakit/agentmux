import { describe, expect, it } from 'vitest'
import { classifySelfViewFailure, SELF_CONTEXT_TOPIC_HINT } from '../src/agent-self-context.js'
import { AgentMuxError } from '../src/errors.js'

// T-004 验收 #1/#5/#6 的判定层：whoami 的 View 那一半在查不到时如何分流，以及 Topic 为何是解释性
// 缺席。坐标不新建第二份来源——Session/能力走 statusAgent，View 走 inspect.region self；这里只钉死
// "查不到 View 时怎么说"这条判定，让它每一支都能被直接断言。

describe('whoami 的 View 缺席分流：确定没有 vs 没查成', () => {
  it('CALLER_NOT_OPEN 是"此刻没投影到任何 View"——正常态，判成 no-desktop-view', () => {
    const outcome = classifySelfViewFailure(new AgentMuxError('caller not open', 'CALLER_NOT_OPEN'))
    expect(outcome).toEqual({ attached: false, reason: 'no-desktop-view' })
  })

  it('REGION_NOT_OPEN 同样是确定没有 View——正常态', () => {
    const outcome = classifySelfViewFailure(new AgentMuxError('region not open', 'REGION_NOT_OPEN'))
    expect(outcome).toEqual({ attached: false, reason: 'no-desktop-view' })
  })

  it('Control 面不可达只说明"没查成"，绝不静默说成"没有 View"，并如实带出错误码', () => {
    const outcome = classifySelfViewFailure(new AgentMuxError('desktop host down', 'CONTROL_UNAVAILABLE'))
    expect(outcome).toEqual({
      attached: false,
      reason: 'view-unavailable',
      error: { code: 'CONTROL_UNAVAILABLE', message: 'desktop host down' }
    })
  })

  it('默认落在"没查成"这边：不认识的错误码不被当成"没有 View"', () => {
    // 关键分界——把未知当成"没有 View"就是原则 11 第二边界禁止的"把未知当成好的"。要判成"确定没有"
    // 必须显式命中 CALLER_NOT_OPEN / REGION_NOT_OPEN，新错误码自动落在 view-unavailable 这侧。
    const outcome = classifySelfViewFailure(new AgentMuxError('something new', 'SOME_FUTURE_CODE'))
    expect(outcome).toEqual({
      attached: false,
      reason: 'view-unavailable',
      error: { code: 'SOME_FUTURE_CODE', message: 'something new' }
    })
  })

  it('非 AgentMuxError 的意外也判成没查成，不冒充"没有 View"', () => {
    const outcome = classifySelfViewFailure(new Error('boom'))
    expect(outcome).toEqual({
      attached: false,
      reason: 'view-unavailable',
      error: { code: 'CONTROL_FAILED', message: 'boom' }
    })
  })
})

describe('Topic 是解释性缺席，不是静默省略', () => {
  it('提示指向工作区文件（topic.md/.agents），让缺席可辨而不甩给接收方去猜', () => {
    expect(SELF_CONTEXT_TOPIC_HINT).toContain('topic.md')
    expect(SELF_CONTEXT_TOPIC_HINT).toContain('.agents/')
    // 说清 Topic 不是 Core 事实——这正是"不为握手新建第二份来源"的直接后果。
    expect(SELF_CONTEXT_TOPIC_HINT).toContain('not a Core fact')
  })
})
