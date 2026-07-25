import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  hashAgentCapability,
  issueAgentCapability,
  resolveCapabilityAuthor
} from '../src/agent-capability.js'

// 谁说的这句话，必须由 Core 从一个不透明凭证解析出来。
// 公开的 AGENTMUX_AGENT_SESSION_ID 只是上下文提示——改一个环境变量就能冒充别人，
// 所以它不能用来认证 author。

describe('签发', () => {
  it('是高熵的，两次签发不重复', () => {
    const a = issueAgentCapability()
    const b = issueAgentCapability()
    expect(a).not.toBe(b)
    // 32 字节 base64url = 43 个字符，与既有 hook token 同一形状。
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/u)
  })

  it('只持久化 hash，raw 值不可从 hash 反推', () => {
    const raw = issueAgentCapability()
    const hash = hashAgentCapability(raw)
    expect(hash).not.toBe(raw)
    expect(hash).toMatch(/^[A-Za-z0-9_-]+$/u)
    // 同一个 raw 恒定映射到同一个 hash，否则重启后就认不出来了。
    expect(hashAgentCapability(raw)).toBe(hash)
  })
})

describe('解析 author', () => {
  const raw = issueAgentCapability()
  const bound = {
    agentSessionId: 'agent-a',
    workspacePath: '/repo',
    runId: 'run-1',
    capabilityHash: hashAgentCapability(raw)
  }

  it('凭证对上时解析出它绑定的那个 Agent', () => {
    expect(resolveCapabilityAuthor(raw, bound, 'run-1')).toBe('agent-a')
  })

  it('缺失凭证——失败关闭，不退回环境变量里的 session id', () => {
    expect(() => resolveCapabilityAuthor('', bound, 'run-1'))
      .toThrowError(expect.objectContaining({ code: 'AGENT_CAPABILITY_INVALID' }))
  })

  it('伪造的凭证不被接受', () => {
    expect(() => resolveCapabilityAuthor(issueAgentCapability(), bound, 'run-1'))
      .toThrowError(expect.objectContaining({ code: 'AGENT_CAPABILITY_INVALID' }))
  })

  it('旧 Run 的凭证重放——失败关闭', () => {
    // Run 被替换后旧凭证立即失效，否则一次 resume 之后旧进程还能以你的名义说话。
    expect(() => resolveCapabilityAuthor(raw, bound, 'run-2'))
      .toThrowError(expect.objectContaining({ code: 'AGENT_CAPABILITY_STALE_RUN' }))
  })

  it('尚未激活时报 not-ready，而不是笼统的无效', () => {
    // raw 必须在 Run 启动前进入受管环境，因此存在一段"已签发未激活"的窗口。
    // 这两种情形要能区分：一个是"再等等"，另一个是"你不是你说的那个人"。
    expect(() => resolveCapabilityAuthor(raw, { ...bound, runId: null }, 'run-1'))
      .toThrowError(expect.objectContaining({ code: 'AGENT_CAPABILITY_NOT_READY' }))
  })
})

// 每个通信动作都必须先解析 author。漏验一个就是一个冒充口子，而这类遗漏在加新动作时
// 最容易发生——所以钉住"所有动作都过同一道门"，而不是逐个动作各测一遍。
describe('每个通信动作都验凭证', () => {
  const source = readFileSync(new URL('../src/client.ts', import.meta.url), 'utf8')

  it('通信动作都调用 resolveMessageAuthor', () => {
    for (const action of [
      'checkDeliveries', 'ackDeliveryBatch', 'answerAsk',
      'cancelAsk', 'handOff', 'openDispatch', 'recordDispatchEvent'
    ]) {
      const body = source.slice(source.indexOf(`  ${action}(input: {`))
      expect(body.slice(0, body.indexOf('\n  }\n'))).toContain('this.resolveMessageAuthor(')
    }
  })

  it('那道门本身用凭证解析，不信调用方自称的身份', () => {
    const gate = source.slice(source.indexOf('private resolveMessageAuthor'))
    expect(gate.slice(0, gate.indexOf('\n  }\n'))).toContain('resolveCapabilityAuthor(')
  })
})
