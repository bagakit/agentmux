import { describe, expect, it } from 'vitest'
import {
  composeAgentLaunchPrompt,
  composeOutboundMessage
} from '../src/agent-outbound-message.js'
import {
  hashAgentCapability,
  issueAgentCapability
} from '../src/agent-capability.js'
import { planDiscussion } from '../src/agent-discussion.js'

// AgentMux 出站文本此前散在四处各拼各的（启动提示、discuss 首条、send、resume）；这里锁定
// 它们收敛到同一个出口 composeOutboundMessage，且 AgentMux 自己的话进 <amux> 信封署名、
// 用户原文逐字节透传。信封只署名不认证——from 是声明而非凭证。

// 会诱发转义的用户原文：引号、尖括号、换行，甚至一个假的闭合信封标签。用户敲什么，Agent 就该
// 收到什么——一个字节都不许被改写。放进 </amux> 正是为了证明我们不把用户文本当线协议去转义。
const NASTY_USER = 'Fix <Parser> & say "done".\nLine two has </amux> and > < inside.'

describe('唯一出站出口 composeOutboundMessage', () => {
  it('AgentMux 自己的话进 <amux from="amux"> 信封署名', () => {
    const out = composeOutboundMessage({ amux: 'runtime note' })
    expect(out).toBe('<amux from="amux">\nruntime note\n</amux>')
  })

  it('用户原文逐字节透传：不进属性、不被转义成另一种形状', () => {
    // 独立断言：Agent 收到的用户文本与用户输入逐字节一致，含会诱发转义的字符。
    const out = composeOutboundMessage({ user: NASTY_USER })
    expect(out).toBe(NASTY_USER)
    // 没有 AgentMux 的话时，出口不擅自加信封。
    expect(out).not.toContain('<amux')
  })

  it('amux 与 user 同在时：信封在前、用户原文在后，用户段完整未被信封吞掉', () => {
    const out = composeOutboundMessage({ amux: 'guide', user: NASTY_USER })
    expect(out).toBe(`<amux from="amux">\nguide\n</amux>\n\n${NASTY_USER}`)
    // 用户原文原封不动地作为独立一段存在。
    expect(out.endsWith(NASTY_USER)).toBe(true)
  })

  it('两者都空时产出空串', () => {
    expect(composeOutboundMessage({})).toBe('')
    expect(composeOutboundMessage({ amux: '', user: '' })).toBe('')
  })

  it('from 是声明而非凭证：不夹带签名/校验字段', () => {
    // 边界：信封不做认证，不引入 capability 签发或签名 ledger。
    const out = composeOutboundMessage({ amux: 'guide', user: 'hi' })
    for (const credentialish of ['sig=', 'signature', 'hash=', 'token=', 'nonce=']) {
      expect(out).not.toContain(credentialish)
    }
  })
})

describe('启动提示路径经同一出口', () => {
  it('运行时引导进信封，用户请求原样透传且逐字节一致', () => {
    const out = composeAgentLaunchPrompt(NASTY_USER, true)
    // AgentMux 的引导语被署名。
    expect(out.startsWith('<amux from="amux">\n')).toBe(true)
    expect(out).toContain('AgentMux runtime guide:')
    expect(out).toContain('into a split')
    expect(out).toContain('"$AGENTMUX_CLI" --skill')
    // 用户原文作为独立一段、逐字节保留在信封之外。
    expect(out.endsWith(`</amux>\n\n${NASTY_USER}`)).toBe(true)
  })

  it('关闭注入时不加任何 AgentMux 的话，用户原文原样返回', () => {
    expect(composeAgentLaunchPrompt(NASTY_USER, false)).toBe(NASTY_USER)
    expect(composeAgentLaunchPrompt(undefined, false)).toBe('')
  })

  it('还没有用户请求时给出等待指示，且它属于 AgentMux 的话（进信封）', () => {
    const idle = composeAgentLaunchPrompt(undefined, true)
    expect(idle).toContain('<amux from="amux">')
    expect(idle).toContain('No request yet. Wait for the user.')
    // 没有用户段时，信封是唯一内容，末尾就是闭合标签。
    expect(idle.endsWith('</amux>')).toBe(true)
  })
})

describe('discuss 首条消息路径经同一出口', () => {
  // 复现 client 的注入路径：planDiscussion 把正文交回为 launchPrompt，startDiscussion 再以
  // injectAgentMuxGuide=true 喂给 createAgent → composeAgentLaunchPrompt。发起者是另一个 Agent，
  // 其正文按 user 透传（不被 amux 信封吞），运行时引导才是 AgentMux 的话。
  const raw = issueAgentCapability()
  const binding = {
    agentSessionId: 'agent-a',
    workspacePath: '/repo',
    runId: 'run-1',
    capabilityHash: hashAgentCapability(raw)
  }

  it('首条正文逐字节保留在信封之外', () => {
    const plan = planDiscussion({
      capability: raw,
      binding,
      currentRunId: 'run-1',
      targetWorkspacePath: '/repo',
      body: NASTY_USER,
      operationId: 'op-1',
      now: 1000
    })
    const out = composeAgentLaunchPrompt(plan.launchPrompt, true)
    expect(out.startsWith('<amux from="amux">\n')).toBe(true)
    expect(out.endsWith(`</amux>\n\n${NASTY_USER}`)).toBe(true)
  })
})

describe('send 与 resume 路径经同一出口', () => {
  // send / resume 是纯用户话：都经 composeOutboundMessage({ user }) 产出，不加 amux 信封，
  // 用户原文逐字节透传。复现二者对出口的调用（client.submitAgentPrompt / resumeAgentRun）。
  it('send 把用户原文逐字节送达，不加信封', () => {
    expect(composeOutboundMessage({ user: NASTY_USER })).toBe(NASTY_USER)
  })

  it('resume 把用户原文逐字节送达，不加信封', () => {
    expect(composeOutboundMessage({ user: NASTY_USER })).toBe(NASTY_USER)
  })
})
