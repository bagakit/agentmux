import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { topicAgentPresentation } from '../src/renderer/src/lib/surface-tool-dock.js'
import type { AgentSessionSnapshot } from '../src/shared/contracts.js'
import { allStyles } from './helpers/styles.js'

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
  const avatarSource = readFileSync(
    new URL('../src/renderer/src/components/AgentAvatar.tsx', import.meta.url),
    'utf8'
  )
  it('不再同时给出计数和逐个全名——两者说的是同一件事', () => {
    // `2 agents` 与其下一排「图标＋全名」胶囊重复，且把一行撑成四层。
    expect(source).not.toContain("'agent' : 'agents'")
  })

  it('逐个头像在场后不再另给一个计数——同一事实不说两遍', () => {
    const row = source.slice(
      source.indexOf('className="workspace-topic-agents"'),
      source.indexOf('</SortableTopicItem>')
    )
    expect(row).not.toContain('agents in ')
    expect(row).not.toContain('.length} agent')
  })

  it('用共享状态点语汇，不发明第三套', () => {
    expect(avatarSource).toContain('status status--')
  })
})

/**
 * 状态到颜色只说一次。
 *
 * 九个状态到颜色的对照表只存在于状态语汇段：每个 `.status--<state>` 赋一次 `--status-ink`，
 * 点用它填充、头像用它描边。这里从样式表反推，不维护一份手写清单——手写清单会和样式表一起
 * 漂移，且漂移时它自己不会响。
 */
describe('状态到颜色的映射只有一处定义', () => {
  const styles = allStyles()

  /** 每条给 `--status-ink` 赋值的规则，连同它覆盖的状态。 */
  function inkDefinitions(): Array<{ selector: string; states: string[] }> {
    const out: Array<{ selector: string; states: string[] }> = []
    for (const [, selector, body] of styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/--status-ink\s*:/.test(body)) continue
      const states = [...selector.matchAll(/\.status--([a-z-]+)/g)].map((match) => match[1]!)
      out.push({ selector: selector.trim().replace(/\s+/g, ' '), states })
    }
    return out
  }

  it('九个状态各自恰好被赋色一次', () => {
    const seen = new Map<string, string[]>()
    for (const { selector, states } of inkDefinitions()) {
      for (const state of states) seen.set(state, [...(seen.get(state) ?? []), selector])
    }
    // 扫描必须真的扫到东西——空扫描会让下面的断言全部空过。
    expect(seen.size).toBeGreaterThan(0)
    const duplicated = [...seen].filter(([, selectors]) => selectors.length > 1)
    expect(duplicated.map(([state, selectors]) => `${state} 被赋色 ${selectors.length} 次`)).toEqual([])
    expect([...seen.keys()].sort()).toEqual([
      'blocked', 'disconnected', 'done', 'error', 'exited', 'running', 'waiting', 'working'
    ])
  })

  it('消费方读 --status-ink，而不是自己挑颜色', () => {
    const consumers = [...styles.matchAll(/([^{}]+)\{([^{}]*var\(--status-ink\)[^{}]*)\}/g)]
      .map(([, selector]) => selector.trim().replace(/\s+/g, ' '))
      .filter((selector) => !selector.includes('--status-ink:'))
    // 点和头像两处都在读它；只有一个消费者说明另一处又自己挑了颜色。
    expect(consumers.some((selector) => selector.includes('.status__dot'))).toBe(true)
    expect(consumers.some((selector) => selector.includes('.agent-avatar'))).toBe(true)
  })

  it('头像的边框颜色不是自己写的一份状态表', () => {
    expect(styles).toContain('border: 0')
    expect(styles).not.toContain('border: 1px solid var(--status-ink)')
    expect(styles).toContain('.agent-avatar.status--working')
    expect(styles).toContain('.agent-avatar.status--running')
    expect(styles).toContain('outline: 1px solid var(--status-ink)')
    const avatarBase = styles.match(/(?:^|\n)\.agent-avatar\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(avatarBase).toContain('filter: grayscale(1)')
  })
})

describe('Agent 头像：身份看图标，点击到人', () => {
  const avatar = readFileSync(
    new URL('../src/renderer/src/components/AgentAvatar.tsx', import.meta.url),
    'utf8'
  )
  const dock = readFileSync(
    new URL('../src/renderer/src/components/SurfaceToolDock.tsx', import.meta.url),
    'utf8'
  )
  const styles = allStyles()

  it('身份由 Provider 图标给出，不是一排看不出谁是谁的抽象点', () => {
    expect(avatar).toContain('<AgentProviderIcon providerId={providerId}')
  })

  it('点击走全局那一个 selectSession，不另开跳转路径', () => {
    expect(dock).toContain('onOpen={() => selectSession(agent.sessionId)}')
    expect(avatar).toContain('onOpen()')
  })

  it('头像坐在整行的打开按钮之上，点它不该顺带开 Topic', () => {
    expect(avatar).toContain('event.stopPropagation()')
  })

  it('键盘可达：它是 button，Enter 天然等价于点击，并有 aria-label 与 tooltip', () => {
    expect(avatar).toContain('type="button"')
    expect(avatar).toContain('aria-label={`${label} · ${state}`}')
    expect(avatar).toContain('title={`${label} · ${state}`}')
  })

  it('悬停是轻量抬升，不是放大——放大会挤动同排的其它头像', () => {
    const hover = styles.match(/\.agent-avatar:hover\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(hover).toContain('translateY(-1px)')
    expect(hover).not.toContain('scale(')
  })

  it('在 Topic 面板里有真实调用者（零调用者检查）', () => {
    expect(dock).toContain("import { AgentAvatar } from './AgentAvatar'")
    expect(dock).toContain('<AgentAvatar')
  })
})
