import { AgentMuxError } from '@agentmux/core'
import { describe, expect, it } from 'vitest'
import { humanizePromptDeliveryError } from '../src/main/prompt-readiness-diagnostics.js'

// ---------------------------------------------------------------------------
// humanizePromptDeliveryError 只该翻译它认得的四个 readiness 码，别的一律**原样**放过。
//
// runtime-controller.test.ts 已经钉住四个码各自翻成哪句话、detail 有没有被保住。这里补它判不到的
// 那一半：**两条直通分支**。它们是 `submitPrompt` 里 catch 的唯一出口（runtime-controller.ts:795
// 是 `throw humanizePromptDeliveryError(error)`），所以这个函数返回什么，用户就看到什么。
//
// 直通分支的可达性不是假设：`submitAgentPrompt` 自己会抛 INVALID_AGENT_PROMPT /
// UNKNOWN_AGENT_INTERACTION 一族别的 AgentMuxError，传输层与 IPC 还会抛根本不是 AgentMuxError
// 的东西（TypeError、被 abort 的 fetch）。任一条分支返回 undefined，那句 `throw undefined` 就成了
// 一个没有 message 的 rejection——横幅上写的是 "undefined"，而真正的失败原因（"Agent prompt cannot
// be empty."、网络栈的报错）彻底消失。实测：把两条 `return error` 各改成 `return undefined`，
// runtime-controller.test.ts 44 条全绿。
//
// 判据落在**同一性**（toBe）而不是「返回值不是 undefined」：后者被 `return new Error('x')` 骗过，
// 而那也丢掉了 code 和 detail。
// ---------------------------------------------------------------------------
describe('humanizePromptDeliveryError 的直通分支', () => {
  it('不是 AgentMuxError 的东西原样放过——连对象身份都不换', () => {
    // 传输层/IPC 抛的不一定是 AgentMuxError。吞掉它等于把 "fetch failed" 换成 "undefined"。
    const transport = new TypeError('fetch failed')
    expect(humanizePromptDeliveryError(transport)).toBe(transport)
  })

  it('连 Error 都不是的抛出物（字符串、null）也原样放过', () => {
    // `throw 'boom'` 与 `throw null` 都是合法 JS；instanceof 分支必须把它们照原样送出去，
    // 而不是让 `error.code` 这类取值在下游炸开或悄悄变成 undefined。
    expect(humanizePromptDeliveryError('boom')).toBe('boom')
    expect(humanizePromptDeliveryError(null)).toBe(null)
    expect(humanizePromptDeliveryError(undefined)).toBe(undefined)
  })

  it('是 AgentMuxError 但码不在四个 readiness 码里，原样放过', () => {
    // submitAgentPrompt 自己就会抛这一条（空 prompt）。翻译表里没有它，那就该原样上浮——
    // 它本来的 message 已经是可读的，换成 undefined 只会让横幅说 "undefined"。
    const other = new AgentMuxError('Agent prompt cannot be empty.', 'INVALID_AGENT_PROMPT')
    expect(humanizePromptDeliveryError(other)).toBe(other)
  })

  it('原样放过时不加 Diagnostic 后缀——它只属于被翻译的那四个码', () => {
    const other = new AgentMuxError('Session vanished.', 'STALE_AGENT_SESSION', 'runId=run-1')
    const result = humanizePromptDeliveryError(other)
    expect(result).toBe(other)
    expect((result as AgentMuxError).message).toBe('Session vanished.')
  })

  it('前提自检：认得的码确实被换掉了，所以上面那几条不是恒真', () => {
    // 没有这一条，把整个函数改成 `return error` 会让本文件全绿——那就等于四个码一句人话都不翻，
    // 用户重新收到 Core 的内部串。这条是「直通」判据的对照面。
    const known = new AgentMuxError(
      'Agent prompt requires a ready composer epoch for this exact Run.',
      'AGENT_PROMPT_NOT_READY',
      'runId=run-1 reason=observation-pending'
    )
    const result = humanizePromptDeliveryError(known)
    expect(result, '认得的码没被翻译：整个函数可能退化成恒等').not.toBe(known)
    expect((result as AgentMuxError).code).toBe('AGENT_PROMPT_NOT_READY')
    expect((result as AgentMuxError).detail).toBe('runId=run-1 reason=observation-pending')
  })
})

// ---------------------------------------------------------------------------
// detail 缺席时不能留下一个说 "Diagnostic: undefined" 的句子。
//
// Core 今天四个抛出点都走 promptReadinessDetail 且都带非空 runId，所以这一侧从 Core 来不了。
// 但这个函数收的是**经过 IPC/传输层之后**的错误：AgentMuxError 的 detail 是可选的，而
// 「Electron 的 ipcRenderer.invoke 会剥掉自定义字段」正是这个模块存在的理由（见它的文件头注释）。
// 也就是说 detail 丢失恰恰是它要处理的场景，不是一个假想的输入。
//
// 三元没人守时的症状：横幅末尾多一句 "Diagnostic: undefined"，用户以为诊断信息在场。
// 实测：把 `diagnostic ? ... : message` 改成无条件拼接，runtime-controller.test.ts 44 条全绿。
// ---------------------------------------------------------------------------
describe('detail 缺席或空白时不拼 Diagnostic', () => {
  it('detail 是 undefined 时消息里没有 Diagnostic 段', () => {
    const result = humanizePromptDeliveryError(
      new AgentMuxError('core message', 'AGENT_PROMPT_SUBMISSION_BUSY')
    ) as AgentMuxError
    expect(result.message, '空 detail 也拼了后缀：横幅会说 Diagnostic: undefined').not.toContain(
      'Diagnostic'
    )
    expect(result.message).toContain('another submission')
  })

  it('detail 只有空白时同样不拼——trim 后为空与缺席是一回事', () => {
    const result = humanizePromptDeliveryError(
      new AgentMuxError('core message', 'AGENT_PROMPT_READINESS_CONFLICT', '   \n  ')
    ) as AgentMuxError
    expect(result.message).not.toContain('Diagnostic')
  })

  it('detail 在场时拼出被 trim 过的那份，且原始 detail 一字不改地留在字段上', () => {
    // 消息里给人看的那份去掉首尾空白；error.detail 保持原样供日志比对。
    const raw = '  runId=run-1 readinessId=readiness-1  '
    const result = humanizePromptDeliveryError(
      new AgentMuxError('core message', 'AGENT_PROMPT_READINESS_CONSUMED', raw)
    ) as AgentMuxError
    expect(result.message).toContain('Diagnostic: runId=run-1 readinessId=readiness-1')
    expect(result.message, 'trim 没生效：诊断段前后多了空白').not.toContain('Diagnostic:  runId')
    expect(result.detail, '原始 detail 被改写了，日志与 Core 那侧对不上').toBe(raw)
  })

  it('四个码一个不漏地被翻译——少一个就是那一类拒绝退回内部串', () => {
    // 表里少一项时，那个码会掉进「未知码」直通分支：用户重新看到 Core 的内部消息。
    // 这条按码枚举，而不是数表的长度——数长度换个名字加一项也能凑够。
    for (const code of [
      'AGENT_PROMPT_NOT_READY',
      'AGENT_PROMPT_READINESS_CONSUMED',
      'AGENT_PROMPT_SUBMISSION_BUSY',
      'AGENT_PROMPT_READINESS_CONFLICT'
    ] as const) {
      const original = new AgentMuxError('core internal message', code, 'runId=run-1')
      const result = humanizePromptDeliveryError(original) as AgentMuxError
      expect(result, `${code} 没被翻译，用户会看到 Core 的内部串`).not.toBe(original)
      expect(result.message, `${code} 的人话消息里漏了 Core 的内部串该被换掉`).not.toContain(
        'core internal message'
      )
      expect(result.code, `${code} 的码在翻译中被改写了`).toBe(code)
    }
  })
})

describe('semantic turn state keeps readiness wording honest', () => {
  it('does not call a completed turn a still-running Run', () => {
    const result = humanizePromptDeliveryError(
      new AgentMuxError('core message', 'AGENT_PROMPT_NOT_READY', 'runId=run-1 reason=observation-pending'),
      { semanticState: 'done' }
    ) as AgentMuxError
    expect(result.message).toContain('Agent turn is complete')
    expect(result.message).not.toContain('still running')
    expect(result.message).toContain('keep the draft')
  })

  it('keeps a waiting Agent actionable without weakening the readiness gate', () => {
    const result = humanizePromptDeliveryError(
      new AgentMuxError('core message', 'AGENT_PROMPT_READINESS_CONSUMED'),
      { semanticState: 'waiting' }
    ) as AgentMuxError
    expect(result.message).toContain('waiting for your reply')
    expect(result.message).not.toContain('still running')
  })
})
