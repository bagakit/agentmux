import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

// T-005 的接线守护：证明 CLI 的 handoff verb 真的接到了 Core 既有的 client.handOff 上，而不是退化成
// 一条普通 send，也不在 CLI 侧重实现所有权转移。这个文件读 src 文本——与走 dist 的 CLI 行为测试
// （agentmux-cli-help.test.ts）各守一侧：那边证明 verb 真被分发，这边锁定被分发到的代码的形状。
// gate agent-handoff.test.ts 只测三个纯函数，两侧它都守不住。

const cliCode = readFileSync(new URL('../src/agentmux.ts', import.meta.url), 'utf8')

function handoffSlice(): string {
  const start = cliCode.indexOf('async function handoffCommand(')
  const end = cliCode.indexOf('\n}\n', start)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return cliCode.slice(start, end)
}

describe('handoff verb 接到 Core 既有 handOff，不退化成 send', () => {
  it('调用 client.handOff，而不是 send / composeOutboundMessage / requestAgentMuxControl', () => {
    const handoff = handoffSlice()
    // 走 Core 既有能力：client.handOff。把它换成 send 就是"用普通消息模拟交接"，这条会红。
    expect(handoff).toContain('client.handOff(')
    // 绝不退化成消息投递或 Control 面 send。
    expect(handoff).not.toContain('composeOutboundMessage')
    expect(handoff).not.toContain("operation: 'send'")
    expect(handoff).not.toContain('requestAgentMuxControl')
  })

  it('身份经 managed caller + capability 交回 Core 验证，不自证', () => {
    const handoff = handoffSlice()
    // 与 discuss 同口径：raw capability 从环境取出交回 Core，callerAgentSessionId 只是上下文。
    expect(handoff).toContain('managedCaller()')
    expect(handoff).toContain('AGENTMUX_AGENT_CAPABILITY')
    expect(handoff).toContain('capability')
    expect(handoff).toContain('callerAgentSessionId')
  })

  it('目标与 task 用既有 CLI 寻址词汇：--to-session（显式 id）+ --task', () => {
    const handoff = handoffSlice()
    // 复用 T-003 同一套 CLI flag 词汇与解析 helper，不另写一份寻址。
    expect(handoff).toContain("'--to-session'")
    expect(handoff).toContain("'--task'")
    // 目标必须是显式 id——交给"自己"没有意义，故走 explicitSelectorId（它拒 self）。
    expect(handoff).toContain('explicitSelectorId(')
  })

  it('只转移所有权：不接受 --text，不夹带消息投递', () => {
    const handoff = handoffSlice()
    // handoff 一旦带 --text 就同时是"转移所有权"和"投递指令"，那正是被否决的 agent 自主派活回路
    // 的雏形（见 io-fidelity-plan 边界节）。它的 flag 规格里绝不能出现 --text。
    expect(handoff).not.toContain("'--text'")
  })

  it('originAwaits 由 Core 决定，CLI 如实回显不另判', () => {
    const handoff = handoffSlice()
    // CLI 输出的是 Core 返回的 result.originAwaits，不是 CLI 自己写死的 false——后者会让 CLI 与
    // Core 的分界各写一份，漂移时不会有测试变红。
    expect(handoff).toContain('result.originAwaits')
    expect(handoff).toContain('result.ownerAgentSessionId')
    // 不在 CLI 侧硬编码 originAwaits 的值。
    expect(handoff).not.toContain('originAwaits: false')
    expect(handoff).not.toContain('originAwaits: true')
  })
})
