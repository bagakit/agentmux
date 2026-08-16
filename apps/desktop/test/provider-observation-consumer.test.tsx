import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { SessionSnapshot } from '../src/shared/contracts.js'
import { observeAgentSession, observationSummary } from '../src/renderer/src/lib/agent-observation.js'

/**
 * Provider 观察合同在**桌面消费者**这一端的闭合。
 *
 * 收敛判定住在 Core 的 `@agentmux/core/agent-status`（observeAgent），渲染侧只经 observeAgentSession 把
 * SessionSnapshot 归一后喂给它——不新建第二套塌成 busy 的逻辑。这一族证两件事：
 *   1. 三条不折叠的轴（进程活性 / 语义活性 / 就绪性）从 SessionSnapshot 端到端各自可判、互不塌陷；
 *   2. 真实生产调用者——WorkspaceBoard 的 RunCard——确实走了这个投影（源码接线断言，排除定义文件）。
 *
 * 用源码断言钉接线，与本仓既有的 workspace-board.test.ts 同一口径：要证的是"某段渲染代码接到了这个
 * 投影"，纯函数全绿证明不了组件真的调了它。
 */

const NOW = 1_000_000

function agentSession(overrides: Partial<Extract<SessionSnapshot, { kind: 'agent' }>> = {}): Extract<SessionSnapshot, { kind: 'agent' }> {
  return {
    id: 'session-1',
    kind: 'agent',
    providerId: 'codex',
    executorId: 'codex',
    capabilities: {
      terminal: true,
      timeline: 'complete-events',
      permission: 'observe',
      providerResume: true,
      replyCorrelation: 'none'
    },
    hostId: 'local',
    workspacePath: '/repo',
    label: 'Codex',
    createdAt: 1,
    updatedAt: 2,
    processState: 'running',
    status: { state: 'running', source: 'run-process', observedAt: NOW },
    latestOutputBytes: 0,
    control: { kind: 'agent', hostId: 'local', agentSessionId: 'session-1', run: { runId: 'run-1' } },
    ...overrides
  }
}

describe('桌面消费者读同一份观察合同：三轴不折叠', () => {
  it('进程 alive + semantic idle + readiness pending 从 SessionSnapshot 端到端各自可判', () => {
    const pending = observeAgentSession(
      agentSession({
        processState: 'running',
        status: { state: 'running', source: 'run-process', observedAt: NOW },
        pendingInteraction: {
          kind: 'permission',
          id: 'req-1',
          agentSessionId: 'session-1',
          title: 'Allow write?',
          options: [],
          evidence: { source: 'native-hook', observedAt: NOW, run: { runId: 'run-1' } }
        }
      }),
      NOW
    )
    expect(pending.process).toBe('running')
    expect(pending.semantic).toBe('idle')
    expect(pending.readiness).toBe('pending')
  })

  it('有活动声明来源时 semantic active、就绪 ready——与上一格是不同的值，证明不是同一个 busy', () => {
    const active = observeAgentSession(
      agentSession({ status: { state: 'working', source: 'native-hook', observedAt: NOW } }),
      NOW
    )
    expect(active.semantic).toBe('active')
    expect(active.readiness).toBe('ready')
  })

  it('迟到活动声明过窗口后落回 idle 且标 stale——迟到事件不把它冒充成还在干活', () => {
    const stale = observeAgentSession(
      agentSession({ status: { state: 'working', source: 'native-hook', observedAt: NOW } }),
      NOW + 16 * 60_000
    )
    expect(stale.semantic).toBe('idle')
    expect(stale.stale).toBe(true)
  })

  it('终端握手未确认时就绪 pending，但语义仍按活动声明独立取值', () => {
    const degraded = observeAgentSession(
      agentSession({
        status: { state: 'working', source: 'native-hook', observedAt: NOW },
        terminalCapability: {
          state: 'unknown',
          mode: 'degraded',
          reason: 'handshake-timeout',
          run: { runId: 'run-1' },
          observedAt: NOW
        }
      }),
      NOW
    )
    expect(degraded.readiness).toBe('pending')
    expect(degraded.semantic).toBe('active')
  })

  it('无 timeline 能力的 Provider 保持 unsupported，不显示成 unknown', () => {
    const unsupported = observeAgentSession(
      agentSession({
        providerId: 'traex',
        capabilities: {
          terminal: true, timeline: 'unavailable', permission: 'none',
          providerResume: false, replyCorrelation: 'none'
        },
        status: { state: 'running', source: 'run-process', observedAt: NOW }
      }),
      NOW
    )
    expect(unsupported.semantic).toBe('unsupported')
  })

  it('进程退出后语义/就绪退回 unknown，绝不伪造 idle/ready', () => {
    const exited = observeAgentSession(
      agentSession({
        processState: 'exited',
        status: { state: 'exited', source: 'run-process', observedAt: NOW }
      }),
      NOW
    )
    expect(exited.semantic).toBe('unknown')
    expect(exited.readiness).toBe('unknown')
  })

  it('摘要把三段读数并排呈现，不塌成一体', () => {
    const summary = observationSummary(
      observeAgentSession(agentSession({ status: { state: 'working', source: 'native-hook', observedAt: NOW } }), NOW)
    )
    expect(summary).toBe('running · active · ready')
  })
})

describe('真实生产调用者：WorkspaceBoard 的 RunCard 走了这个投影', () => {
  const board = readFileSync(new URL('../src/renderer/src/components/WorkspaceBoard.tsx', import.meta.url), 'utf8')

  it('RunCard 从共享 lib 导入并调用 observeAgentSession（排除定义文件本身）', () => {
    // 接回本地手拼一份 busy 会让这两条红。定义文件是 agent-observation.ts；这里断言的是消费组件。
    expect(board).toContain("from '../lib/agent-observation'")
    expect(board).toContain('observeAgentSession(session, Date.now())')
    // 三段读数确实被拼成用户可见文本落在渲染上，而不是算完丢弃。
    expect(board).toContain('observationSummary(')
  })
})
