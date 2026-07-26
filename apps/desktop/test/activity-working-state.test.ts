import { describe, expect, it } from 'vitest'
import type { AgentDisplayState } from '@agentmux/core'
import type { AgentTimelineItem } from '../src/shared/contracts.js'
import {
  showEmptyState,
  showWorkingIndicator,
  turnWorking
} from '../src/renderer/src/lib/activity-working-state.js'

// 要修的那一幕：刚发完 prompt，首行还没落地，窗格显示「暂无活动」——看上去是空的、停的。

function item(overrides: Partial<AgentTimelineItem> = {}): AgentTimelineItem {
  return {
    id: 'i1',
    agentSessionId: 'agent-1',
    kind: 'assistant_message',
    status: 'complete',
    source: 'native-hook',
    createdAt: 1,
    updatedAt: 1,
    title: 'Assistant response',
    ...overrides
  }
}

const toolStep = () => item({ id: 'tool', kind: 'tool_call', title: 'Bash', toolName: 'Bash', toolInput: '{}' })

describe('turn 在不在工作', () => {
  it('starting 与 working 算在工作', () => {
    expect(turnWorking('starting')).toBe(true)
    expect(turnWorking('working')).toBe(true)
  })

  it('其余状态都不算', () => {
    const idle: AgentDisplayState[] = ['running', 'disconnected', 'waiting', 'blocked', 'done', 'exited']
    for (const state of idle) expect(turnWorking(state)).toBe(false)
  })

  it('状态未知时不算在工作——不猜', () => {
    expect(turnWorking(undefined)).toBe(false)
  })
})

describe('「在进行」指示', () => {
  it('刚发完 prompt、还没有任何条目时就显示——这正是今天最刺眼的那一幕', () => {
    expect(showWorkingIndicator('working', [])).toBe(true)
  })

  it('只有工具步骤、还没有助手正文时仍然显示', () => {
    // 用户看到一串机器动作，仍然不知道 Agent 有没有在回应他。
    expect(showWorkingIndicator('working', [toolStep()])).toBe(true)
  })

  it('助手正文一到就退场，不与正文并存造成两个「在动」的信号', () => {
    expect(showWorkingIndicator('working', [toolStep(), item({ content: 'Here is the plan' })])).toBe(false)
  })

  it('还没吐出字的流式条目不算实质回答，指示继续留着', () => {
    expect(showWorkingIndicator('working', [item({ status: 'streaming', content: '' })])).toBe(true)
    expect(showWorkingIndicator('working', [item({ status: 'streaming', content: '   ' })])).toBe(true)
  })

  it('用户自己那条消息不算助手回答', () => {
    expect(showWorkingIndicator('working', [item({ kind: 'user_message', content: 'go' })])).toBe(true)
  })

  it('没在工作就不显示，哪怕时间轴是空的', () => {
    expect(showWorkingIndicator('done', [])).toBe(false)
    expect(showWorkingIndicator(undefined, [])).toBe(false)
  })
})

describe('空状态', () => {
  it('真的没有活动、也没在工作时才显示', () => {
    expect(showEmptyState('done', [])).toBe(true)
  })

  it('正在想的时候绝不显示空状态——这是本 task 要修的那一幕', () => {
    expect(showEmptyState('working', [])).toBe(false)
    expect(showEmptyState('starting', [])).toBe(false)
  })

  it('有条目时不显示空状态', () => {
    expect(showEmptyState('done', [item()])).toBe(false)
  })
})
