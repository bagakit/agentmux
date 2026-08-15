import { describe, expect, it } from 'vitest'
import type { AgentDisplayState } from '@agentmux/core'
import type { AgentTimelineItem, SessionSnapshot } from '../src/shared/contracts.js'
import { sessionRecentActivity } from '../src/renderer/src/lib/session-recency.js'
import { projectActivityRow } from '../src/renderer/src/lib/project-activity-row.js'
import { usagePanelRows } from '../src/renderer/src/lib/resource-usage-panel.js'
import { MAX_STEP_SUMMARY_LENGTH } from '../src/renderer/src/lib/activity-step-summary.js'

// 用户问的是「这个 Agent 最近在干什么」。答案有一条严格优先级阶梯，每一级都盖过它下面那级——
// 一级一条 case 只证得了「这一级会出现」，证不了顺序，所以每条 case 都要让上一级也**在场**却被压下去。

function agent(spec: { state?: AgentDisplayState; detail?: string } = {}): SessionSnapshot {
  return {
    id: 'a1',
    kind: 'agent',
    providerId: 'codex',
    executorId: 'codex',
    hostId: 'local',
    workspacePath: '/repo',
    label: 'Agent a1',
    createdAt: 1,
    updatedAt: 1,
    processState: 'running',
    status: {
      state: spec.state ?? 'working',
      source: 'native-hook',
      observedAt: 1,
      ...(spec.detail ? { detail: spec.detail } : {})
    },
    latestOutputBytes: 0,
    control: { kind: 'agent', hostId: 'local', agentSessionId: 'a1', run: { runId: 'run-a1' } }
  } as unknown as SessionSnapshot
}

function withPending(session: SessionSnapshot, request: unknown): SessionSnapshot {
  return { ...session, pendingInteraction: request } as unknown as SessionSnapshot
}

function toolCall(spec: {
  title: string
  toolName?: string
  toolInput?: string
  status?: AgentTimelineItem['status']
}): AgentTimelineItem {
  return {
    id: `t-${spec.title}`,
    agentSessionId: 'a1',
    kind: 'tool_call',
    status: spec.status ?? 'complete',
    source: 'native-hook',
    createdAt: 1,
    updatedAt: 1,
    title: spec.title,
    ...(spec.toolName ? { toolName: spec.toolName } : {}),
    ...(spec.toolInput ? { toolInput: spec.toolInput } : {})
  }
}

const EDIT = toolCall({ title: 'Edit', toolName: 'Edit', toolInput: JSON.stringify({ file_path: '/repo/x.ts' }) })

describe('sessionRecentActivity 优先级阶梯', () => {
  // 顶级：pendingInteraction 压过下面所有更具体的信号（时间轴、detail），因为它是唯一该促使用户行动的。
  it('1) pendingInteraction 盖过时间轴 tool_call 与 status.detail', () => {
    const session = withPending(agent({ detail: 'still churning' }), {
      kind: 'permission',
      title: 'Allow Bash?'
    })
    expect(sessionRecentActivity(session, [EDIT])).toBe('Allow Bash?')
  })

  it('1) 问题类 pendingInteraction 取各问 prompt', () => {
    const session = withPending(agent(), {
      kind: 'question',
      questions: [{ prompt: 'Ship it?' }, { prompt: 'Rollback?' }]
    })
    expect(sessionRecentActivity(session, [EDIT])).toBe('Ship it? · Rollback?')
  })

  // 第二级：没有 pending 时，最近的 tool_call 盖过 status.detail——detail 在场却被压下，才证得了顺序。
  it('2) 最近 tool_call 盖过 status.detail', () => {
    const session = agent({ state: 'working', detail: 'still churning' })
    expect(sessionRecentActivity(session, [EDIT])).toBe('Edit /repo/x.ts')
  })

  it('2) 取的是最后一条 tool_call，不是第一条', () => {
    const first = toolCall({ title: 'Read', toolName: 'Read', toolInput: JSON.stringify({ file_path: '/repo/a.ts' }) })
    const last = toolCall({ title: 'Bash', toolName: 'Bash', toolInput: JSON.stringify({ command: 'pnpm test' }) })
    expect(sessionRecentActivity(agent({ state: 'working' }), [first, last])).toBe('Bash pnpm test')
  })

  it('2) streaming 的 tool_call 任何状态都算最近（正在发生）', () => {
    // Session 已 done，但这条正在流式跑——定义上就在此刻发生，仍然显示它。
    const streaming = toolCall({ title: 'Bash', toolName: 'Bash', toolInput: JSON.stringify({ command: 'sleep 9' }), status: 'streaming' })
    expect(sessionRecentActivity(agent({ state: 'done' }), [streaming])).toBe('Bash sleep 9')
  })

  it('2) 已完成的 tool_call 在 Session 不再活跃时不当现状——落回 detail', () => {
    // done 之后那条 Edit 是历史，不是「正在改」。它让位给 detail，避免把结束的活读成还在跑。
    const session = agent({ state: 'done', detail: 'wrapped up' })
    expect(sessionRecentActivity(session, [EDIT])).toBe('wrapped up')
  })

  // 第三级：无 pending、无可算作现状的 tool_call 时，status.detail 盖过状态专属句。
  it('3) status.detail 盖过状态专属句', () => {
    // waiting 有自己的专属句，但 detail 在场时用 detail——detail 更贴近这一刻。
    const session = agent({ state: 'waiting', detail: 'awaiting review' })
    expect(sessionRecentActivity(session, [])).toBe('awaiting review')
  })

  // 第四级：状态专属句盖过裸状态。
  it('4) waiting 专属句', () => {
    expect(sessionRecentActivity(agent({ state: 'waiting' }), [])).toBe('Waiting for your reply in the terminal')
  })

  it('4) error 专属句', () => {
    expect(sessionRecentActivity(agent({ state: 'error' }), [])).toBe('Agent reported an error; open the terminal for details')
  })

  it('4) 没有专属句的状态退到裸状态', () => {
    expect(sessionRecentActivity(agent({ state: 'blocked' }), [])).toBe('blocked')
  })
})

describe('时间轴缺席与非 Agent（原则 11 class 3：判不出别谎报）', () => {
  it('空时间轴退回基于状态的答案，绝不返回空串或谎报 Idle', () => {
    const result = sessionRecentActivity(agent({ state: 'working' }), [])
    // 「还没加载」不是「闲着」：既不能空，也不能编一个 Idle。working 无 detail 无专属句 → 裸状态。
    expect(result).toBe('working')
    expect(result).not.toBe('')
    expect(result.toLowerCase()).not.toContain('idle')
  })

  it('时间轴只有非 tool_call 项时，当作没有「最近在改什么」', () => {
    const msg: AgentTimelineItem = {
      id: 'm1', agentSessionId: 'a1', kind: 'assistant_message', status: 'complete',
      source: 'native-hook', createdAt: 1, updatedAt: 1, title: 'Assistant response'
    }
    const session = agent({ state: 'working', detail: 'thinking' })
    expect(sessionRecentActivity(session, [msg])).toBe('thinking')
  })

  it('终端（非 agent）没有时间轴语义，如实只报状态', () => {
    const terminal = {
      id: 't1', kind: 'terminal', providerId: null, hostId: 'local', workspacePath: '/repo',
      label: 'Terminal', createdAt: 1, updatedAt: 1, processState: 'running',
      status: { state: 'running', source: 'run-process', observedAt: 1 }, latestOutputBytes: 0,
      control: { kind: 'terminal' }
    } as unknown as SessionSnapshot
    expect(sessionRecentActivity(terminal, [])).toBe('running')
  })
})

describe('单行封顶', () => {
  it('超长 tool 摘要截断到一行上限', () => {
    const long = toolCall({ title: 'Bash', toolName: 'Bash', toolInput: JSON.stringify({ command: 'x'.repeat(500) }), status: 'streaming' })
    const result = sessionRecentActivity(agent({ state: 'working' }), [long])
    expect(result.length).toBeLessThanOrEqual(MAX_STEP_SUMMARY_LENGTH)
    expect(result.endsWith('…')).toBe(true)
  })
})

describe('仓根要一路传到 stepTitle', () => {
  // 这两个消费面（资源面板、项目活动菜单）都再被 CSS 截一刀，而 CSS 的省略号永远吃**尾巴**——
  // 也就是 JS 刚保下来的文件名。所以「缩短」在这里不是排版偏好，是这行字的识别力本身。
  //
  // 实测本仓 984 个源文件：传根与不传根，**270 个**的输出真的不同；其余 714 个即使剥掉仓根仍超预算，
  // 被尾切成同一串——所以判据必须挑前一类。下面这条路径就是从那 270 个里取的真实例子；
  // 换成 lib/session-recency.ts 那种更深的路径，两边输出逐字相同，这条断言就什么都证不到了。
  const shallow = '/Users/me/proj/repo/apps/desktop/src/main/agent-notifier.ts'
  const call = toolCall({ title: 'Edit', toolName: 'Edit', toolInput: JSON.stringify({ file_path: shallow }) })

  it('传了根就剥成相对路径，整条都放得下', () => {
    const result = sessionRecentActivity(agent({ state: 'working' }), [call], '/Users/me/proj/repo')
    expect(result).toBe('Edit apps/desktop/src/main/agent-notifier.ts')
  })

  it('不传根只能做 ~ 折叠，仍然超界并被尾切吃掉前缀', () => {
    const result = sessionRecentActivity(agent({ state: 'working' }), [call])
    expect(result).toBe('Edit …po/apps/desktop/src/main/agent-notifier.ts')
  })

  it('根穿过 projectActivityRow 与 usagePanelRows 两层，不在中途被丢掉', () => {
    // 接线判据：形参加了却不往下传，上面两条照样绿。
    const row = projectActivityRow(agent({ state: 'working' }), [call], 1, '/Users/me/proj/repo')
    expect(row.reason).toBe('Edit apps/desktop/src/main/agent-notifier.ts')

    const session = agent({ state: 'working' })
    const rows = usagePanelRows(
      { runs: [{ runId: 'run-a1', cpuPercent: 1, rssKib: 1 }] } as never,
      [session],
      { [session.id]: { items: [call] } } as never,
      1,
      { [session.id]: '/Users/me/proj/repo' }
    )
    expect(rows[0]?.activity).toBe('Edit apps/desktop/src/main/agent-notifier.ts')
  })
})
