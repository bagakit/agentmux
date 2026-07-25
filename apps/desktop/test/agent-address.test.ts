import { describe, expect, it } from 'vitest'
import {
  formatRegionAddress,
  formatSessionAddress,
  formatViewAddress
} from '../src/renderer/src/lib/agent-address.js'

// 复制出去的是一个寻址方式，不是一个 id。判据只有一条：接收方仅凭这段文本，
// 能不能不问人、不查文档就完成寻址。因此每条断言都在问"这段文本自足吗"，
// 而不是"字符串长得对不对"。

describe('Session 地址：哪个 Agent', () => {
  const address = formatSessionAddress('agent-7')

  it('说清目标是哪一层身份，而不是甩一个裸 id', () => {
    expect(address).toContain('agent-7')
    expect(address).toMatch(/Session/u)
  })

  it('给出可直接执行的命令，用既有 flag', () => {
    expect(address).toContain("agentmux send --to-session='agent-7'")
    expect(address).toContain("agentmux inspect --session='agent-7'")
  })
})

describe('Region 地址：屏幕上哪一格', () => {
  const address = formatRegionAddress('region:pane-2')

  it('给出 --to-region 命令', () => {
    expect(address).toContain("agentmux send --to-region='region:pane-2'")
    expect(address).toContain("agentmux inspect --region='region:pane-2'")
  })

  it('说明它在分屏下无歧义地指向那一格', () => {
    // 这正是 Region 地址存在的理由：Tab 地址在多 Agent 时有歧义，它没有。
    expect(address).toMatch(/split|Region/u)
    expect(address.toLowerCase()).toContain('unambiguous')
  })
})

describe('View 地址：哪张完整工作面', () => {
  const address = formatViewAddress('view:abc')

  it('给出 --to-tab 命令', () => {
    expect(address).toContain("agentmux send --to-tab='view:abc'")
    expect(address).toContain("agentmux inspect --tab='view:abc'")
  })

  it('如实声明它只在该 View 承载唯一 Agent 时可用于 Agent 寻址', () => {
    expect(address.toLowerCase()).toContain('exactly one')
  })

  it('多 Agent 时引导用 Region 地址，而不是把消歧甩给接收方', () => {
    // 旧 handoff 让接收方先 inspect、撞了 MESSAGE_TARGET_NOT_UNIQUE 再自己挑 candidate。
    // 歧义只在源头可见——复制时我们知道用户点的是哪一格，接收方不知道。
    expect(address).toMatch(/Region/u)
    expect(address).not.toContain('MESSAGE_TARGET_NOT_UNIQUE')
    expect(address).not.toContain('candidates')
  })
})

describe('shell 转义：粘贴即可执行', () => {
  it('转义带单引号与空格的 id', () => {
    const address = formatSessionAddress("--evil id$'quoted")
    expect(address).toContain(`--to-session='--evil id$'"'"'quoted'`)
  })

  it('三级地址用同一套转义', () => {
    const nasty = "a'b c"
    expect(formatRegionAddress(nasty)).toContain(`--to-region='a'"'"'b c'`)
    expect(formatViewAddress(nasty)).toContain(`--to-tab='a'"'"'b c'`)
  })
})
