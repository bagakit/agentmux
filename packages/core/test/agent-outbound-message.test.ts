import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  composeAgentLaunchPrompt,
  composeOutboundMessage
} from '../src/agent-outbound-message.js'
import { AGENTMUX_SELF_CONTEXT_VERB } from '../src/agentmux-cli-help.js'
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

const clientCode = readFileSync(new URL('../src/client.ts', import.meta.url), 'utf8')

function clientSlice(fromNeedle: string, toNeedle: string): string {
  const start = clientCode.indexOf(fromNeedle)
  const end = clientCode.indexOf(toNeedle, start + fromNeedle.length)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return clientCode.slice(start, end)
}

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

  it('引导只指路不抄语法：绝不把完整 CLI flag 语法塞进提示', () => {
    // 守 SSOT「不把完整 CLI 语法抄进提示」——语法的唯一真相在 skill，抄进来会在语法演进时过期。
    // 这条负向断言此前在旧 agent-launch-prompt.test.ts 里，随模块删除一并搬来。
    const guide = composeAgentLaunchPrompt('do the work', true)
    for (const direction of ['left', 'right', 'above', 'below']) expect(guide).toContain(direction)
    for (const flag of ['--left-of', '--right-of', '--above', '--below', 'open terminal', 'open agent']) {
      expect(guide).not.toContain(flag)
    }
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

// T-004 验收 #2/#3/#4：启动路径确实携带并执行一次"定向握手"——启动引导指示 Agent 先去问自己的
// 坐标与能力，而不是等到要开分屏那一刻才发现自己在 AgentMux 里。这些是**行为断言**：握手指令是否
// 真的进了启动提示、是否署名在 amux 信封里、是否指向 whoami 与 --skill 而不把语法抄进来。把握手指令
// 从引导里摘掉、或把它挪出信封落进用户段、或把动词抄错成一个 CLI 并不分发的名字，都会让某一条变红。
describe('启动定向握手：启动提示携带 whoami 指令并署名进信封', () => {
  it('启动提示指示 Agent 先运行 whoami 拿到自己的坐标与能力', () => {
    const out = composeAgentLaunchPrompt('do the work', true)
    // 行为断言：握手动词进了启动提示，且用的是 CLI 真正分发的那个动词名（防 guide/dispatch 漂移）。
    expect(out).toContain(`"$AGENTMUX_CLI" ${AGENTMUX_SELF_CONTEXT_VERB}`)
    // 握手的目的：让 Agent 知道自己是谁、在哪、有哪些能力——坐标各项都被点到。
    for (const coordinate of ['Session', 'View', 'Region', 'Workspace', 'capabilities']) {
      expect(out).toContain(coordinate)
    }
  })

  it('握手指令是 AgentMux 的话：署名在 amux 信封内，不落进用户段', () => {
    const out = composeAgentLaunchPrompt('do the work', true)
    const envelopeEnd = out.indexOf('</amux>')
    expect(envelopeEnd).toBeGreaterThan(0)
    const insideEnvelope = out.slice(0, envelopeEnd)
    const afterEnvelope = out.slice(envelopeEnd + '</amux>'.length)
    // 握手指令在信封内署名。
    expect(insideEnvelope).toContain(`"$AGENTMUX_CLI" ${AGENTMUX_SELF_CONTEXT_VERB}`)
    // 绝不落进用户段（信封之后）——那会让 Agent 把 AgentMux 的话读成用户的话。
    expect(afterEnvelope).not.toContain(AGENTMUX_SELF_CONTEXT_VERB)
    expect(afterEnvelope.trim()).toBe('do the work')
  })

  it('握手指路而不抄语法：指向 --skill 查确切用法，不把 whoami 的 flag 语法塞进提示', () => {
    const out = composeAgentLaunchPrompt('do the work', true)
    // 确切用法的唯一真相在 skill——引导指向它。
    expect(out).toContain('"$AGENTMUX_CLI" --skill')
    // 不把 whoami 的任何 flag/子句抄进来（whoami 无参，抄语法只会在演进时过期）。
    for (const syntax of ['whoami --', 'whoami <', '--session', '--tab', '--region']) {
      expect(out).not.toContain(syntax)
    }
  })

  it('关闭注入时连握手指令也不出现——它属于运行时引导这一整块', () => {
    const out = composeAgentLaunchPrompt('do the work', false)
    expect(out).toBe('do the work')
    expect(out).not.toContain(AGENTMUX_SELF_CONTEXT_VERB)
  })
})

describe('agentMuxNote 是 AgentMux 的话：署名进信封，与用户段分层', () => {
  // Scratch/Topic 启动路径把 Topic 说明作为 agentMuxNote 交给出口。它是 AgentMux 自己的话，
  // 必须进信封署名，绝不能像旧实现那样被拼进用户段、和用户请求混在同一段。
  const NOTE = 'Scratch Topic context:\nRead topic.md and inspect .agents/ to discover collaborators.'

  it('note 与运行时引导同在一个信封里，用户请求逐字节留在信封外', () => {
    const out = composeAgentLaunchPrompt(NASTY_USER, true, NOTE)
    expect(out.startsWith('<amux from="amux">\n')).toBe(true)
    expect(out).toContain('AgentMux runtime guide:')
    expect(out).toContain('Scratch Topic context:')
    expect(out).toContain('inspect .agents/')
    // Topic 说明在信封内、用户请求在信封外，二者有明确分界。
    expect(out).toContain(`</amux>\n\n${NASTY_USER}`)
    // Topic 说明绝不出现在用户段（信封闭合之后）里。
    const afterEnvelope = out.slice(out.indexOf('</amux>') + '</amux>'.length)
    expect(afterEnvelope).not.toContain('Scratch Topic context:')
    expect(afterEnvelope.trim()).toBe(NASTY_USER)
  })

  it('note 是 AgentMux 的话：引导关闭时它仍署名进信封，不落进用户段', () => {
    const out = composeAgentLaunchPrompt(NASTY_USER, false, NOTE)
    expect(out.startsWith('<amux from="amux">\n')).toBe(true)
    expect(out).toContain('Scratch Topic context:')
    expect(out).not.toContain('AgentMux runtime guide:')
    expect(out.endsWith(`</amux>\n\n${NASTY_USER}`)).toBe(true)
  })

  it('无请求 + 有 note 时给出等待指示，用户段为空', () => {
    const out = composeAgentLaunchPrompt(undefined, true, NOTE)
    expect(out).toContain('Scratch Topic context:')
    expect(out).toContain('No request yet. Wait for the user.')
    expect(out.endsWith('</amux>')).toBe(true)
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

describe('四条路径的接线守护：真的都改成调用同一出口', () => {
  // 纯函数断言证明出口本身正确，但不证明四条路径真的接了上去。这里读 client 源码，锁定每条路径
  // 对出口的调用形状——把接线改回直传原文（绕过出口），下面的断言就会红。这正是本任务「收敛」的意义。
  it('createAgent 把 prompt / note 交给 composeAgentLaunchPrompt，note 走 amux 段', () => {
    const create = clientSlice('async createAgent(', 'const launchOptionArgv =')
    expect(create).toContain('composeAgentLaunchPrompt(')
    expect(create).toContain('input.prompt')
    expect(create).toContain('input.agentMuxNote')
    // T-004 验收 #2：启动路径确实携带握手。握手随运行时引导进启动提示，而引导是否注入由这个 flag
    // 决定——createAgent 必须把 input.injectAgentMuxGuide 透传给出口。把它写死成 false（即"把握手从
    // 启动路径摘掉"）会让这条变红。
    expect(create).toContain('input.injectAgentMuxGuide')
  })

  it('send（submitAgentPrompt）经出口产出 outbound 再投递，不直传 content', () => {
    const submit = clientSlice('async submitAgentPrompt(', 'await this.recordPromptAfterSideEffect(')
    expect(submit).toContain('composeOutboundMessage({ user: content })')
    // 出口的产物 outbound 才是喂给 provider/记录的东西——不是原始 content。
    expect(submit).toContain('planPromptInput(outbound)')
    expect(submit).toContain('this.promptSubmission.submitInputPlan(current, run, operationId, outbound, plan)')
    expect(submit).not.toContain('planPromptInput(content)')
  })

  it('resume（resumeAgentRun）经出口产出用户段文本，不直传 trimmedPrompt', () => {
    const resume = clientSlice('private async resumeAgentRun(', 'const reservation = await this.registry.reserveExisting(')
    expect(resume).toContain('composeOutboundMessage({ user: trimmedPrompt })')
  })
})
