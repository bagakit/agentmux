import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { classifySelfViewFailure, SELF_CONTEXT_TOPIC_HINT } from '../src/agent-self-context.js'
import { AgentMuxError } from '../src/errors.js'

const cliCode = readFileSync(new URL('../src/agentmux.ts', import.meta.url), 'utf8')

function whoamiSlice(): string {
  const start = cliCode.indexOf('async function whoamiCommand(')
  const end = cliCode.indexOf('\n}\n', start)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return cliCode.slice(start, end)
}

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

// T-004 验收 #5：握手失败或超时不阻塞 Agent 启动，且失败可见。whoami 里 View 查询的失败绝不能把
// 整条应答掀翻——坐标（statusAgent）已经拿到了，View 查不到只是少一项，必须降级成 view 字段里的
// 可见事实、照常 printSuccess，而不是让异常冒泡杀掉整个 whoami。这条读 CLI 源码锁定接线形状：把
// View 查询的 try/catch 摘掉（让失败直接冒泡阻塞应答），或把降级结果丢掉不写进输出，都会让它变红。
describe('whoami 接线：View 查询失败降级可见，绝不阻塞整条应答', () => {
  it('View 查询包在 try/catch 里，失败经 classifySelfViewFailure 降级而非冒泡', () => {
    const whoami = whoamiSlice()
    // 坐标先从既有 Session 投影拿到——不新建第二份身份来源。
    expect(whoami).toContain('client.statusAgent(self)')
    // View 查询的失败被接住并降级，而不是让它掀翻整条 whoami。
    expect(whoami).toContain('try {')
    expect(whoami).toContain('} catch (error) {')
    expect(whoami).toContain('view = classifySelfViewFailure(error)')
  })

  it('降级结果与坐标一起 printSuccess——失败可见，不静默吞掉', () => {
    const whoami = whoamiSlice()
    // view 字段随成功应答一起输出：这是"失败可见"的落点。
    expect(whoami).toContain('printSuccess(')
    expect(whoami).toMatch(/printSuccess\([\s\S]*view[\s\S]*\)/u)
    // 坐标来自 statusAgent 投影的字段，不为握手另攒一份。
    expect(whoami).toContain('session: status.session')
    expect(whoami).toContain('capabilities: status.capabilities')
  })
})

