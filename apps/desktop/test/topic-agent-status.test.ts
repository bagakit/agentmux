import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { topicAgentPresentation } from '../src/renderer/src/lib/surface-tool-dock.js'
import type { AgentSessionSnapshot } from '../src/shared/contracts.js'

// Topic 行要回答的是"这个 Topic 里的 Agent 现在怎么样了"，而不是把每个 Agent 的全名平铺出来。
// 状态语汇必须复用窗口里那一套（status status--<state>），不发明第三套。

function agent(state: AgentSessionSnapshot['status']['state']): AgentSessionSnapshot {
  return {
    id: 's', kind: 'agent', providerId: 'codex', executorId: 'codex',
    capabilities: {
      terminal: true, hookEvents: true, timeline: 'streaming', permission: 'observe',
      providerResume: true, acp: false, replyCorrelation: 'none'
    },
    hostId: 'local', workspacePath: '/scratch', label: 'a', createdAt: 1, updatedAt: 1,
    processState: 'running', status: { state, source: 'run-process', observedAt: 1 },
    latestOutputBytes: 0,
    control: { kind: 'agent', hostId: 'local', agentSessionId: 's', run: { runId: 'r' } }
  }
}

describe('Topic 行显示每个 Agent 的运行状态', () => {
  it('把 live Session 的状态原样带出，供共享状态点渲染', () => {
    const shown = topicAgentPresentation({ sessionId: 's1', providerId: 'codex', live: agent('working') })
    expect(shown.state).toBe('working')
  })

  it('等待用户的 Agent 用 needs-you 语汇，与窗口其他表面一致', () => {
    expect(topicAgentPresentation({ sessionId: 's', providerId: 'codex', live: agent('waiting') }).attention)
      .toBe('needs-you')
  })

  it('出错的 Agent 报 error，不被折叠成普通运行中', () => {
    expect(topicAgentPresentation({ sessionId: 's', providerId: 'codex', live: agent('error') }).attention)
      .toBe('error')
  })

  it('没有 live Session 的协作者如实报 disconnected，不假装在跑', () => {
    const shown = topicAgentPresentation({ sessionId: 's2', providerId: 'claude', live: null })
    expect(shown.state).toBe('disconnected')
    expect(shown.attention).toBeNull()
  })
})

describe('Topic 行的视觉收敛', () => {
  const source = readFileSync(
    new URL('../src/renderer/src/components/SurfaceToolDock.tsx', import.meta.url),
    'utf8'
  )

  it('不再同时给出计数和逐个全名——两者说的是同一件事', () => {
    // `2 agents` 与其下一排「图标＋全名」胶囊重复，且把一行撑成四层。
    expect(source).not.toContain("'agent' : 'agents'")
  })

  it('用共享状态点语汇，不发明第三套', () => {
    expect(source).toContain('status status--')
  })
})
