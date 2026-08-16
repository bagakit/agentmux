import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

// SurfaceToolDock 在模块加载时经 api 判断跑在哪个宿主里；不先立起这个全局，import 阶段就炸。
vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import type { SessionSnapshot, WorkspaceRecord } from '../src/shared/contracts.js'
import { WorkspaceAgentsTool } from '../src/renderer/src/components/SurfaceToolDock.js'

// 这个 feature 存在的理由：一个跑完待机、上下文 95% 的 Agent，就是那个「快满却没人管、下一 turn 就
// 悄悄压缩」的对象。花名册那条 surface 已被收进这个 dock（见 5c4f1b8e），而它的 recent 组恰好收着
// 这类 Agent——所以压力标记必须在**这里**能被看见，否则空闲 Agent 的压力就无处可读（正是原缺陷）。
//
// 本仓反复栽在「纯函数有人守、JSX 无人守」这个形状上：agent-usage 的门槛判定早有测试，
// 但若这行 markup 不把它渲染出来，界面上什么都看不到。所以这条钉的是**可达性**——标记确实出现在
// 渲染出的 DOM 里，而不仅仅是 contextPressure() 返回了一个值。

const workspace: WorkspaceRecord = {
  id: 'ws',
  hostId: 'local',
  path: '/repo'
} as unknown as WorkspaceRecord

function agent(overrides: Partial<Extract<SessionSnapshot, { kind: 'agent' }>> = {}): SessionSnapshot {
  return {
    id: 'idle-full',
    kind: 'agent',
    providerId: 'codex',
    executorId: 'codex',
    capabilities: {
      terminal: true,
      timeline: 'complete-events',
      permission: 'observe',
      providerResume: true,
      replyCorrelation: 'none',
      usage: { kind: 'native-transcript', transcriptFormat: 'codex-rollout' }
    },
    hostId: 'local',
    workspacePath: '/repo',
    label: 'Reviewer',
    createdAt: 1,
    updatedAt: 1,
    processState: 'running',
    // exited → recent 组：跑完待机，不在 working 也不在 needs-you。正是原缺陷里「看不见压力」的那类。
    status: { state: 'exited', source: 'native-hook', observedAt: 1 },
    latestOutputBytes: 0,
    turnUsage: {
      inputTokens: 1, outputTokens: 1, totalTokens: 2, observedAt: 1,
      context: { usedTokens: 190_000, capacityTokens: 200_000 }
    },
    control: { kind: 'agent', hostId: 'local', agentSessionId: 'idle-full', run: { runId: 'run-idle' } },
    ...overrides
  } as unknown as SessionSnapshot
}

function render(sessions: SessionSnapshot[]): string {
  return renderToStaticMarkup(
    createElement(WorkspaceAgentsTool, { workspace, sessions, onOpen: () => {} })
  )
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('Agents dock — 空闲 Agent 的上下文压力可见', () => {
  it('跑完待机、上下文快满的 Agent 带上压力标记与百分比', () => {
    const markup = render([agent()])

    // 可达性判据：标记与档位确实进了 DOM，不是仅仅算了个值出来。
    expect(markup).toContain('data-pressure="danger"')
    expect(markup).toContain('95%')
    // 文案说的是下一步而不是颜色名——对听的人/色盲用户「amber」毫无信息。
    expect(markup).toContain('start a fresh session')
    expect(markup.toLowerCase()).not.toContain('amber')
  })

  it('还早的空闲 Agent 什么都不带（缺席即正常，不给每行都发徽章）', () => {
    const markup = render([
      agent({
        id: 'idle-quiet',
        turnUsage: {
          inputTokens: 1, outputTokens: 1, totalTokens: 2, observedAt: 1,
          context: { usedTokens: 20_000, capacityTokens: 200_000 }
        }
      } as unknown as Partial<Extract<SessionSnapshot, { kind: 'agent' }>>)
    ])

    expect(markup).not.toContain('data-pressure')
    expect(markup).not.toContain('10%')
  })

  it('不报用量的 Agent 没有压力标记，且不显示 0%（0% 会被读成「刚开始」）', () => {
    // 不报用量的 Provider 根本没有 turnUsage.context，contextUsedPercent 因此为 null。
    const markup = render([
      agent({
        id: 'no-usage',
        capabilities: {
          terminal: true, timeline: 'complete-events', permission: 'observe',
          providerResume: true, replyCorrelation: 'none'
        },
        turnUsage: undefined
      } as unknown as Partial<Extract<SessionSnapshot, { kind: 'agent' }>>)
    ])

    expect(markup).not.toContain('data-pressure')
    expect(markup).not.toContain('0%')
  })
})
