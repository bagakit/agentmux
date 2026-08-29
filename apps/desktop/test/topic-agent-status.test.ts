import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AgentAvatar } from '../src/renderer/src/components/AgentAvatar'
import { TopicPresence } from '../src/renderer/src/components/TopicPresence'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { AgentDisplayState } from '@agentmux/core'
import { topicAgentPresentation } from '../src/renderer/src/lib/surface-tool-dock.js'
import {
  URGENT_ATTENTION_CATEGORIES,
  attentionAccentFor,
  type AttentionCategory
} from '../src/renderer/src/lib/attention-event.js'
import { AGENT_DISPLAY_STATES } from '../src/renderer/src/lib/attention-vocabulary.js'
import type { AgentSessionSnapshot } from '../src/shared/contracts.js'
// `allStyles` 只给那条自检用（证明剥注释真的剥掉了东西）；所有判「规则在不在场」的断言走 `allStyleRules`。
import { allStyleRules, allStyles } from './helpers/styles.js'

// Topic 行要回答的是"这个 Topic 里的 Agent 现在怎么样了"，而不是把每个 Agent 的全名平铺出来。
// 状态语汇必须复用窗口里那一套（status status--<state>），不发明第三套。

function agent(state: AgentSessionSnapshot['status']['state']): AgentSessionSnapshot {
  return {
    id: 's', kind: 'agent', providerId: 'codex', executorId: 'codex',
    capabilities: {
      terminal: true, timeline: 'streaming', permission: 'observe',
      providerResume: true, replyCorrelation: 'none'
    },
    hostId: 'local', workspacePath: '/scratch', label: 'a', createdAt: 1, updatedAt: 1,
    processState: 'running', status: { state, source: 'run-process', observedAt: 1 },
    latestOutputBytes: 0,
    control: { kind: 'agent', hostId: 'local', agentSessionId: 's', run: { runId: 'r' } }
  }
}

/**
 * 一条规则体里"自己挑的状态色"。
 *
 * 判据不是"有没有读 token"——加一条读 `--status-ink` 的规则，同族里另一条照旧可以自己挑色，而
 * 「至少有一条读了」的断言仍然绿（实测：角标背景换成 `#ffb020`，描边那条替它顶住，45 条全绿）。
 * 所以按**出现即红**判：状态语汇里那四个色相 token 与任何颜色字面量都不许出现在消费方规则里。
 *
 * `--surface-*` / `--overlay-*` 这类不在名单里：它们是这个形状自己的底与环（角标要在深底上有个
 * 1.5px 的分离环），与"这是什么状态"无关。名单只列**状态色相**，因为第二份状态色表恰恰是靠
 * 直接引用色相而不是引用状态来铸成的。
 */
const STATE_HUE_TOKENS = ['--green', '--amber', '--red', '--blue', '--neutral-3', '--text-3']

function colourLiterals(body: string): string[] {
  const found: string[] = []
  for (const token of STATE_HUE_TOKENS) {
    if (new RegExp(`var\\(\\s*${token}\\b`, 'u').test(body)) found.push(token)
  }
  // 颜色字面量：绕过 token 层直接写死更隐蔽，而 `--status-ink` 那条链一旦被绕过就再没人对齐。
  found.push(...[...body.matchAll(/#[0-9a-f]{3,8}\b/giu)].map((match) => match[0]))
  found.push(...[...body.matchAll(/\b(?:rgba?|hsla?|color-mix)\s*\(/giu)].map((match) => match[0]))
  return found
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
    new URL('../src/renderer/src/components/WorkspaceTopicsPanel.tsx', import.meta.url),
    'utf8'
  )
  const avatarSource = readFileSync(
    new URL('../src/renderer/src/components/AgentAvatar.tsx', import.meta.url),
    'utf8'
  )
  const topologySource = readFileSync(
    new URL('../src/renderer/src/components/TopicPresence.tsx', import.meta.url),
    'utf8'
  )
  // 整张表而不是 dock.css 一个文件：这几条规则按表面再拆一刀就会搬走，而硬编码单文件时
  // 扫描面变空、`toContain` 一条都不红（stylesheet-organisation 那道守卫守的正是这个）。
  const dockStyles = allStyles()
  it('不再同时给出计数和逐个全名——两者说的是同一件事', () => {
    // `2 agents` 与其下一排「图标＋全名」胶囊重复，且把一行撑成四层。
    expect(source).not.toContain("'agent' : 'agents'")
  })

  it('逐个头像在场后不再另给一个计数——同一事实不说两遍', () => {
    // 锚点取整行（`<SortableTopicItem` … `</SortableTopicItem>`）而不是头像簇那一小段：计数要是
    // 回来了，它未必长在簇里，行上任何位置都算违约，扫整行才是这条性质真正的范围。
    //
    // 此前锚点写的是 `className="workspace-topic-agents"`，而那个类名早已不存在（头像簇换成了
    // 共享的 `SelectorPresence`）。`indexOf` 返回 -1，`slice(-1, 23870)` 得到**空串**，于是下面两条
    // `not.toContain` 恒真——判据在盘上、看着有主，实际一个字符都没扫（AGENTS.md:85-88 的第三种白绿）。
    const start = source.indexOf('<SortableTopicItem')
    const end = source.indexOf('</SortableTopicItem>')
    expect(start, '行的起锚点不见了——下面扫的是空内容').toBeGreaterThan(-1)
    expect(end, '行的止锚点不见了').toBeGreaterThan(start)
    const row = source.slice(start, end)
    // 扫描面自检：证明这一段真的是那一行，而不是恰好非空的别处。
    expect(row, '扫到的这段里没有 Region/Agent 呈现，锚点指错了地方').toContain('<TopicPresence')
    expect(row).not.toContain('agents in ')
    expect(row).not.toContain('.length} agent')
  })

  it('用共享状态点语汇，不发明第三套', () => {
    expect(avatarSource).toContain('status status--')
  })

  it('Topic presence exposes Tab structure, Region executor and recent activity', () => {
    const html = renderToStaticMarkup(createElement(TopicPresence, {
      agents: [],
      tabs: [{
        tabId: 'tab:review',
        title: 'Review runtime',
        active: true,
        regions: [{
          regionId: 'region:agent',
          bounds: { x: 0, y: 0, width: 1, height: 1 },
          surfaceKind: 'agent',
          executorLabel: 'Codex',
          activity: 'Editing store.ts'
        }, {
          regionId: 'region:file',
          bounds: { x: 0.5, y: 0, width: 0.5, height: 1 },
          surfaceKind: 'file',
          executorLabel: 'File',
          activity: 'No recent activity'
        }]
      }, {
        tabId: 'tab:notes',
        title: 'Notes',
        active: false,
        regions: [{
          regionId: 'region:notes',
          bounds: { x: 0, y: 0, width: 1, height: 1 },
          surfaceKind: 'terminal',
          executorLabel: 'Terminal',
          activity: 'Waiting for input'
        }]
      }]
    }))
    expect(html).toContain('class="topic-workbench-topology__inspector"')
    expect(html).toContain('aria-label="2 Tabs. Hover or focus a Tab')
    expect(html).toContain('topic-workbench-topology__tab-glyph')
    expect(html).toContain('data-region-count="2"')
    expect(html).toContain('data-region-count="1"')
    expect(html).not.toContain('<b>T1</b>')
    expect(html).not.toContain('<small>2R</small>')
    expect(html).toContain('Review runtime')
    expect(html).toContain('Codex')
    expect(html).toContain('Editing store.ts')
    expect(html).toContain('No recent activity')
    expect(html).toContain('aria-describedby=')
    expect(html).not.toContain('topic-workbench-topology__activity')
    expect(html).toContain('style="aspect-ratio:1.6"')
    expect(html).toContain('data-region-kind="agent"')
    expect(html).toContain('data-region-kind="file"')
  })

  it('uses the Agent avatar for a single Region and removes that Agent from the duplicate roster', () => {
    const html = renderToStaticMarkup(createElement(TopicPresence, {
      agents: [{
        key: 'session:codex',
        providerId: 'codex',
        executorId: 'codex',
        sessionId: 'session:codex',
        label: 'Codex',
        state: 'working'
      }],
      tabs: [{
        tabId: 'tab:agent',
        title: 'Agent tab',
        active: true,
        regions: [{
          regionId: 'region:agent',
          bounds: { x: 0, y: 0, width: 1, height: 1 },
          surfaceKind: 'agent',
          executorLabel: 'Codex',
          activity: 'Editing TopicPresence.tsx',
          agent: {
            providerId: 'codex',
            executorId: 'codex',
            sessionId: 'session:codex',
            label: 'Codex',
            state: 'working'
          }
        }]
      }]
    }))
    expect(html).toContain('topic-workbench-topology__tab-glyph--single')
    expect(html).toContain('class="agent-avatar status status--working"')
    expect(html).not.toContain('class="selector-presence"')
    expect(html).toContain('Editing TopicPresence.tsx')
  })

  it('把 inspector 提升到 viewport overlay，避免被 Topic 滚动面板裁切', () => {
    expect(topologySource).toContain('createPortal(inspector, portalHost)')
    expect(topologySource).toContain('getBoundingClientRect()')
    expect(topologySource).toContain('onMouseEnter={() => setInspectorOpen(true)}')
    expect(topologySource).toContain('onFocus={() => setInspectorOpen(true)}')
    expect(topologySource).toContain('topic-workbench-topology__inspector--portal')
    expect(topologySource).toContain('window.addEventListener(\'scroll\', updatePosition, true)')
  })

  it('横向列出全部 Tab，细节按单个 Tab 展开', () => {
    expect(topologySource).toContain('tabs.map((tab, index)')
    expect(topologySource).not.toContain('tabs.slice(0, 3)')
    expect(topologySource).toContain('onMouseEnter={() => inspectTab(tab.tabId)}')
    expect(topologySource).toContain('inspectTab(tab.tabId)')
    expect(topologySource).toContain('regions.map((region)')
  })

  it('收起态用可复用的真实 bounds 缩略图，详情浮层保持窄宽度', () => {
    expect(topologySource).toContain('function TopicTabGlyph')
    expect(topologySource).toContain('data-region-count={tab.regions.length}')
    expect(topologySource).toContain('region.bounds.x * 100')
    expect(topologySource).toContain('<TopicTabGlyph tab={tab} />')
    expect(dockStyles).toContain('.topic-workbench-topology__tab-glyph')
    expect(dockStyles).toContain('width: 280px;')
    expect(dockStyles).toContain('width: 100%;')
  })

  it('does not restore a duplicate Agent roster when a Session is mounted in any Tab', () => {
    expect(topologySource).toContain('tabs.flatMap((tab) => tab.regions.flatMap')
    expect(topologySource).toContain('region.agent?.sessionId ?? region.agentSessionId')
    expect(topologySource).toContain('<TopicRegionMark region={region} />')
  })

  it('uses the shared avatar-stack overlap while keeping each Tab above its neighbor on focus', () => {
    expect(topologySource).toContain('style={{ zIndex: index + 1 }}')
    expect(dockStyles).toContain('.topic-workbench-topology__tab-chip + .topic-workbench-topology__tab-chip')
    expect(dockStyles).toContain('margin-left: calc(-1 * var(--sp-4))')
    expect(dockStyles).toContain('z-index: 20 !important')
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
  const styles = allStyleRules()

  it('读的是剥掉注释的规则，且剥完仍是一整张表（防两个方向的空过）', () => {
    // 判「某条规则在不在场」一律走剥注释的那一份，因为**规则的理由注释里常常逐字写着那条选择器**：
    // #409 那道可达性判据就被 dock.css 的注释顶住过——头像类名整个改掉、界面上再无规则接，24 条
    // 照旧全绿。但剥注释本身有反方向的坑：一个把全文吃空的剥法会让下面每条 `not.toContain` 恒真。
    // 所以两侧各钉一次：注释里的散文必须消失，规则必须还在。
    expect(styles.length).toBeGreaterThan(10_000)
    expect(styles).toContain('.status--waiting')
    // dock.css 那段理由注释里的字（它逐字引用了 `.status__dot` 与 `data-attention`）不许留下。
    expect(styles).not.toContain('The Provider alpha owns the contour')
    expect(allStyles()).toContain('The Provider alpha owns the contour')
  })

  /** 每条给 `--status-ink` 赋值的规则，连同它覆盖的状态和赋的那个值。 */
  function inkDefinitions(): Array<{ selector: string; states: string[]; value: string }> {
    const out: Array<{ selector: string; states: string[]; value: string }> = []
    for (const [, selector, body] of styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const assignment = /--status-ink\s*:\s*([^;}]+)/.exec(body!)
      if (!assignment) continue
      const states = [...selector.matchAll(/\.status--([a-z-]+)/g)].map((match) => match[1]!)
      out.push({
        selector: selector.trim().replace(/\s+/g, ' '),
        states,
        value: assignment[1]!.trim()
      })
    }
    return out
  }

  /** 每个被赋色的状态 → 赋的那个值。 */
  function inkByState(): Map<string, string> {
    const out = new Map<string, string>()
    for (const { states, value } of inkDefinitions()) {
      for (const state of states) out.set(state, value)
    }
    return out
  }

  it('每个状态各自恰好被赋色一次，且清单以 Core 的状态联合为锚', () => {
    const seen = new Map<string, string[]>()
    for (const { selector, states } of inkDefinitions()) {
      for (const state of states) seen.set(state, [...(seen.get(state) ?? []), selector])
    }
    // 扫描必须真的扫到东西——空扫描会让下面的断言全部空过。
    expect(seen.size).toBeGreaterThan(0)
    const duplicated = [...seen].filter(([, selectors]) => selectors.length > 1)
    expect(duplicated.map(([state, selectors]) => `${state} 被赋色 ${selectors.length} 次`)).toEqual([])
    // 锚是 Core 的 `AgentDisplayState` 联合（经 AGENT_DISPLAY_STATES 派生），不是手抄的八个名字。
    // 手抄那份此前写着「九个状态」却只列了八个——`starting` 从来没有色规则，而那条断言逐字通过，
    // 因为它比对的是它自己抄的那一份。Core 加一个状态时，手抄清单会安静地把新状态放行。
    //
    // `starting` 刻意不上色：它是"进程刚起、还没有任何语义事实"，`.status` 本体的中性色就是它该有的
    // 样子；给它一个色相等于宣称一件还不知道的事。这个豁免必须自带前提自检——它哪天真的被赋色了，
    // 是这条断言先红，而不是清单默默扩容。
    const UNPAINTED: readonly AgentDisplayState[] = ['starting']
    for (const state of UNPAINTED) {
      expect(seen.has(state), `${state} 现在有色规则了——豁免的前提已经变了，重新判它该不该上色`).toBe(false)
    }
    expect([...seen.keys()].sort()).toEqual(
      [...AGENT_DISPLAY_STATES].filter((state) => !UNPAINTED.includes(state)).sort()
    )
  })

  it('only true errors earn the shared exclamation glyph', () => {
    const glyphs = [...styles.matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
      .filter((match) => /content:\s*["']!["']/.test(match[2]!))
      .flatMap((match) => match[1]!.split(',').map((selector) => selector.trim()))
    expect(glyphs.filter((selector) => selector.includes('.status__dot'))).toEqual(['.status--error .status__dot::after'])
  })

  it('running is a hollow dot while working retains the active fill', () => {
    const hollow = [...styles.matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
      .filter((match) => match[1]!.split(',').some((selector) => selector.trim() === '.status--running .status__dot'))
    expect(hollow).toHaveLength(1)
    expect(hollow[0]![2]).toContain('background: transparent')
    expect(hollow[0]![2]).toContain('inset 0 0 0 1.5px var(--status-ink)')
    expect(hollow[0]![1]).not.toContain('.status--working')
  })

  it('四个色相各自归属哪些状态——红/蓝那两侧此前完全无人守', () => {
    // 这条补的是一个实测存活过的洞：把 `.status--error, .status--exited` 的 `--status-ink` 从
    // `var(--red)` 改成 `var(--amber)`，全仓 2980 条无一变红。于是一个崩掉的 Agent 在**每一个**读色表
    // 的表面（状态点、头像、Board 卡框、快切）都被画成琥珀，与 waiting 逐像素同色——而
    // attention-vocabulary.ts 的表把 error 单独列为一类，理由写得很直白：「琥珀说『你被等着』，
    // 红说『这坏了』；折在一起就丢掉了颜色唯一的用处」。
    //
    // 不对称是这个洞的形状：琥珀那一侧被 status-needs-you-glyph.test.tsx 钉死了，红与蓝那两侧一条
    // 断言都没有。而上面那条「各恰好被赋色一次」只数**次数**，不看赋的是**哪个色相**，所以任意两个
    // 色相互换都在它眼皮下存活。
    //
    // 判据按色相分组写，且要求分组是**全集**（下面那条等式）：只写「error 必须是红」的话，把 done
    // 从蓝改成红仍然全绿。
    const ink = inkByState()
    const HUE_OWNERS: Record<string, readonly AgentDisplayState[]> = {
      'var(--green)': ['working'],
      'var(--amber)': ['waiting', 'blocked'],
      'var(--red)': ['error'],
      'var(--blue)': ['done', 'running'],
      'var(--text-3)': ['disconnected', 'exited']
    }
    // 自检：色表真的被读到了，否则下面每条 `.get()` 都是 undefined 对 undefined。
    expect(ink.size).toBeGreaterThan(4)
    for (const [hue, states] of Object.entries(HUE_OWNERS)) {
      for (const state of states) {
        expect(ink.get(state), `.status--${state} 的 --status-ink 必须是 ${hue}`).toBe(hue)
      }
    }
    // 分组必须是全集：漏掉一个色相时，那个色相下的状态可以随意改而上面的循环不问。
    expect([...Object.values(HUE_OWNERS)].flat().sort()).toEqual([...ink.keys()].sort())
  })

  it('消费方读 --status-ink，而不是自己挑颜色', () => {
    const consumers = [...styles.matchAll(/([^{}]+)\{([^{}]*var\(--status-ink\)[^{}]*)\}/g)]
      .map(([, selector]) => selector.trim().replace(/\s+/g, ' '))
      .filter((selector) => !selector.includes('--status-ink:'))
    // 状态墨水只由共享状态点消费；头像轮廓是身份层，不能再把状态色变成光晕。
    expect(consumers.some((selector) => selector.includes('.status__dot'))).toBe(true)
    expect(consumers.filter((selector) => selector.includes('.agent-avatar'))).toEqual(['.agent-avatar .agent-avatar__status--working'])
  })

  it('头像以图形透明轮廓读共享状态色，不给矩形容器画状态框', () => {
    const contour = styles.match(/(?:^|\n)\.agent-avatar__contour\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(contour.length).toBeGreaterThan(0)
    expect(contour).toContain('filter: none')
    expect(contour).not.toContain('drop-shadow(')
    const avatarBase = styles.match(/(?:^|\n)\.agent-avatar\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(avatarBase.length).toBeGreaterThan(0)
    expect(avatarBase).toContain('border: 0')
    expect(avatarBase).not.toMatch(/outline:|box-shadow:|filter: grayscale/)
    const corner = styles.match(/\.agent-avatar \.agent-avatar__status\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(corner.length).toBeGreaterThan(0)
    // The avatar positions the pip; it must not erase the shared running/disconnected hollow ring.
    expect(corner).not.toMatch(/background:|box-shadow:/)
  })
})

/**
 * #409：头像那枚 `data-attention` 必须画得出来。
 *
 * 两层分开守，因为它们各自的失效方式不一样，而且互相看不见：
 *
 *   投影层 —— `topicAgentPresentation` 算出的取值域，必须与样式表画得出的取值域一致。原来它调
 *   `categoryFor`，于是 `done` 会被送进 DOM 而没有任何规则接：不响、不报错，只是让两个取值域悄悄
 *   分岔。分岔本身就是下一个不可见状态的入口。
 *
 *   CSS 层 —— 那两个真会到达 DOM 的取值，必须各有一条规则读 `--status-ink` 并带一枚字形。
 *
 * 状态清单来自 `AGENT_DISPLAY_STATES`（它自己派生于那张 Record），不在这里手抄九个名字——手抄的
 * 清单会在"新加了一个状态"的那一刻恰好落后，而那正是唯一需要它的时刻。
 */
describe('#409 头像的注意力取值必须画得出来', () => {
  const styles = allStyleRules()

  /** 每个状态经投影层算出的 attention。走真的 Session 形状，不直接调下游那个函数。 */
  function projected(state: AgentDisplayState): AttentionCategory | null {
    return topicAgentPresentation({ sessionId: 's', providerId: 'codex', live: agent(state) }).attention
  }

  it('投影层的取值域恰好是那两个会上色的 category，done 到不了 DOM', () => {
    // 自检：状态清单是空的话下面整个循环都空过。
    expect(AGENT_DISPLAY_STATES.length).toBeGreaterThan(0)
    const emitted = new Set(AGENT_DISPLAY_STATES.map(projected).filter((value) => value !== null))
    // 恰好等于「值得抢琥珀/红的那些」——不是它的子集：少一个就是某个状态又不可见了，多一个就是
    // 送出了没人接的取值。`done` 不在里面正是这条断言最贵的一半（它是 categoryFor 与
    // attentionAccentFor 唯一的差集），所以再单独钉一次它自己那两个状态。
    expect([...emitted].sort()).toEqual([...URGENT_ATTENTION_CATEGORIES].sort())
    expect(projected('done')).toBeNull()
    expect(projected('exited')).toBeNull()
    // 而"等你"与"出错"必须真的算出来——上面那条等式在两侧同时坍缩成空集时也成立。
    expect(projected('waiting')).toBe('needs-you')
    expect(projected('blocked')).toBe('needs-you')
    expect(projected('error')).toBe('error')
  })

  it('投影层不自己判，与共享取值器逐状态一致', () => {
    // 上面守的是取值域，这条守的是"谁说的"。取值域对而映射错（比如把 error 也说成 needs-you）
    // 在上面那条等式下照样绿。
    for (const state of AGENT_DISPLAY_STATES) {
      expect(projected(state), state).toBe(attentionAccentFor(state))
    }
  })

  it('头像每个需注意状态都有共享状态点，颜色与字形从同一套规则到达 DOM', () => {
    const urgent = AGENT_DISPLAY_STATES.filter((state) => projected(state) !== null)
    expect(urgent.length).toBeGreaterThan(1)
    const glyphs = new Map<string, string>()
    for (const state of urgent) {
      const markup = renderToStaticMarkup(createElement(AgentAvatar, { label: 'Agent', providerId: 'codex', state }))
      expect(markup).toContain(`status--${state}`)
      expect(markup).toContain('agent-avatar__status status__dot')
      const rules = [...styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
        .filter(([, selector]) => selector!.split(',').some((part) => part.trim() === `.status--${state} .status__dot::after`))
      expect(rules.length, `${state}: no shared glyph rule`).toBeGreaterThan(0)
      const glyph = rules.map(([, , body]) => /content:\s*["']([^"']+)["']/u.exec(body!)?.[1]).find(Boolean)
      expect(glyph, `${state}: missing shared glyph`).toBeTruthy()
      glyphs.set(projected(state)!, glyph!)
    }
    expect([...glyphs]).toEqual([['needs-you', '?'], ['error', '!']])
    const dot = styles.match(/(?:^|\n)\.status__dot\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(dot.length).toBeGreaterThan(0)
    expect(dot).toContain('var(--status-ink)')
    expect(colourLiterals(dot)).toEqual([])
  })

  /**
   * 载体规则不分档，却点名了一个色相。
   *
   * 这是 `.status__dot { background: var(--status-ink) }` 那条被改成 `var(--green)` 的形状：它对
   * **所有**状态生效，于是整张九状态色表塌成一个颜色。它此前能存活，是因为判据写的是
   * `consumers.some(sel => sel.includes('.status__dot'))`——兄弟规则
   * `.status--disconnected .status__dot`（chrome.css，在 box-shadow 里读了同一个 token）替它满足了
   * "有人在读 ink"，基础规则那条填充改成什么都不影响。头像那一侧更彻底：满足 `.some()` 的是一条
   * `:hover` 规则，所以静息态的描边色（dock.css 两处 outline）压根没人守。
   *
   * 所以判据不问"有没有人读 ink"，而是反过来问"有没有人在不分档的地方写死了色相"——那是这类
   * 缺陷唯一的共同形状，且不必手抄"哪条规则的哪个属性该读 token"（手抄的清单会在新增载体时恰好
   * 落后）。
   *
   * 分档有两种键，都合法：`.status--<state>` 按状态、`[data-attention='<category>']` 按"需不需要
   * 你"。裸 `[data-attention]`（不带取值）仍在禁令内——它和没有键一样会盖住全部取值。
   */
  it('不分档的载体规则不许点名色相——那会把整张表塌成一个颜色', () => {
    /**
     * 载体：那些**按状态上色**的元素。判在场必须按词法边界，不能用 `includes`——
     * `.project-rail-row__activity`（"有东西在跑"的指示器，绿色是它的本意，显隐由 `[data-running]`
     * 控制）会被 `.project-rail-row` 前缀吞掉，于是判据对着一条合法规则报红。BEM 的 `__` 子元素
     * 是另一个东西，不是这个载体的一部分。
     */
    const CARRIERS = ['status__dot', 'agent-avatar', 'board-run-card', 'project-rail-row']
    /** 类名以这个词结束（后面不再接 `-`、`_` 或别的词字符），才算命中这个载体本身。 */
    const carriesState = (selector: string): boolean =>
      CARRIERS.some((carrier) => new RegExp(`\\.${carrier}(?![\\w-])`, 'u').test(selector))
    /**
     * 色相取值：四个基色**及其任何派生后缀**。后缀不许枚举——`-text|-bg|-line|-wash` 那份手抄的清单
     * 已经漏过两族真实拼法（`--green-2` 是 board 卡尾部箭头用的，`--amber-bg-hover` 是选中行 hover
     * 用的），于是那两条规则对判据完全隐身。tokens.css 里凡以基色开头的自定义属性都从那个基色派生，
     * 按"基色 + 任意后缀"判才与 token 的构造方式同形。
     */
    const HUE = /var\(\s*--(?:green|amber|red|blue)(?:[\w-]*)?\s*\)/u
    /**
     * 具名例外：按**选择器**放行，不放行数值。
     *
     * 今天是空的——#436 那条（`.board-run-card:hover` 借了 `--green-line`，于是一张 done /
     * disconnected / error 的卡指上去后卡框说「在跑」）已改成中性 `--line`，豁免随之删掉。留着这张
     * 空表而不是删掉整个机制，是因为下一条真例外该有个落点，且下面自检三会强制它指向真实存在的选择器：
     * 一条选择器被重命名后，豁免不会静默变成谁都能钻的洞。
     */
    const NAMED = new Map<string, string>()
    /**
     * 判据本体。抽成函数是为了让下面的自检**质询同一段代码**而不是在别处重算一遍——
     * 一个在字面量上另写一遍正则的"自检"，改坏真判据时它照旧绿。
     */
    const flatteningRules = (sheet: string, exceptions: Map<string, string> = NAMED): string[] => {
      const out: string[] = []
      for (const [, rawSelector, body] of sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const selector = rawSelector!.trim().replace(/\s+/gu, ' ')
        if (selector.startsWith('@')) continue
        if (carriesState(selector) === false) continue
        // 分档取键的规则点名色相是合法的——状态语汇段就是这么给 ink 赋值的，项目栏的角标也是这么按
        // category 各挑一个色相的。两种键都算分档：`.status--<state>` 是状态那一档，
        // `[data-attention='<category>']` 是"需不需要你"那一档。禁令针对的是**不带任何键**的规则，
        // 因为只有它才会一视同仁地盖住全部取值。
        if (/\.status--[\w-]+|\[data-attention=/u.test(selector)) continue
        if (exceptions.has(selector)) continue
        for (const hue of body!.matchAll(new RegExp(HUE.source, 'gu'))) {
          out.push(`${selector} { ${hue[0]} }`)
        }
      }
      return out
    }
    expect(flatteningRules(styles), '这些规则对所有状态生效，却写死了一个色相').toEqual([])

    // 自检一：扫描真的看到了载体规则。一条都没看到时上面的循环空转，返回值恒为空。
    const seen = [...styles.matchAll(/([^{}]+)\{/gu)]
      .filter(([, selector]) => carriesState(selector!))
    expect(seen.length, '扫不到任何载体规则——判据会变成恒真').toBeGreaterThan(4)
    // 自检二：判据认得出这个缺陷本身——逐字喂那次实测存活的变异，以及裸 `[data-attention]` 那种
    // "看着像分档其实盖住全部取值"的写法。
    expect(flatteningRules('.status__dot { background: var(--green); }')).toHaveLength(1)
    expect(flatteningRules(".agent-avatar[data-attention] { outline: 1px solid var(--red); }")).toHaveLength(1)
    // 而两种真的分档写法必须放行，否则判据会逼着人把合法的色相赋值也改掉。
    expect(flatteningRules('.status--waiting .status__dot { box-shadow: 0 0 0 3px var(--amber-wash); }')).toEqual([])
    expect(flatteningRules(".project-rail-row[data-attention='error'] .x { background: var(--red); }")).toEqual([])
    // 自检三：例外清单必须指向真实存在的选择器，否则重命名之后它会静默变成一个谁都能钻的洞。
    // 清单今天是空的，所以先钉「放行这件事真的按选择器生效」——空表让那个循环空转，光有循环等于没判。
    expect(flatteningRules('.status__dot { background: var(--green); }')).toHaveLength(1)
    const withException = new Map(NAMED)
    withException.set('.status__dot', '自检用')
    expect(
      flatteningRules('.status__dot { background: var(--green); }', withException),
      '具名豁免对判据不起作用——那这张表是装饰'
    ).toEqual([])
    const selectors = new Set(
      [...styles.matchAll(/([^{}]+)\{/gu)].map(([, selector]) => selector!.trim().replace(/\s+/gu, ' '))
    )
    for (const selector of NAMED.keys()) {
      expect(selectors, `例外 ${selector} 已不存在，该删掉这条豁免`).toContain(selector)
    }
  })
})

describe('Agent 头像：身份看图标，点击到人', () => {
  const avatar = readFileSync(
    new URL('../src/renderer/src/components/AgentAvatar.tsx', import.meta.url),
    'utf8'
  )
  const dock = readFileSync(
    new URL('../src/renderer/src/components/WorkspaceTopicsPanel.tsx', import.meta.url),
    'utf8'
  )
  const selector = readFileSync(
    new URL('../src/renderer/src/components/SelectorList.tsx', import.meta.url),
    'utf8'
  )
  const topicPresence = readFileSync(
    new URL('../src/renderer/src/components/TopicPresence.tsx', import.meta.url),
    'utf8'
  )
  const branches = readFileSync(
    new URL('../src/renderer/src/components/BranchesPanel.tsx', import.meta.url),
    'utf8'
  )
  const styles = allStyleRules()

  it('身份由 Provider 图标给出，不是一排看不出谁是谁的抽象点', () => {
    expect(renderToStaticMarkup(createElement(AgentAvatar, { label: 'Agent', providerId: 'codex' }))).toContain('data-agent-provider="codex"')
  })

  it('点击走全局那一个 selectSession，不另开跳转路径', () => {
    expect(dock).toContain('selectSession(agent.sessionId)')
    expect(avatar).toContain('onOpen()')
  })

  it('头像坐在整行的打开按钮之上，点它不该顺带开 Topic', () => {
    expect(avatar).toContain('event.stopPropagation()')
  })

  it('键盘可达：它是 button，Enter 天然等价于点击，并有 aria-label 与 tooltip', () => {
    expect(avatar).toContain("const Element = onOpen ? 'button' : 'span'")
    const markup = renderToStaticMarkup(createElement(AgentAvatar, { label: 'Agent', providerId: 'codex', state: 'running', onOpen: () => {} }))
    expect(markup).toContain('aria-label="Agent · Idle"')
    expect(markup).toContain('<button')
    expect(avatar).toContain('onPointerEnter={show}')
    expect(avatar).toContain('onFocus={show}')
  })

  it('悬停抬升并放大，且不推动同排其它头像', () => {
    // 这条曾写作"轻量抬升，不是放大——放大会挤动同排的其它头像"。**那个理由是错的**：
    // `transform` 不参与布局，一枚头像 scale 起来不会让邻座移动一个像素（会挤动的是改宽高
    // 或 margin）。用户要的正是 macOS 程序坞那种抬升放大，而当初挡住它的是一条搞错了机制的
    // 注释。现在放大在叠压容器上生效——叠压之后必须有东西能让被压住的那枚完整露出来。
    const lift = styles.match(/\.selector-presence__slot:hover button\.agent-avatar[^{]*\{([^}]*)\}/)?.[1] ?? ''
    expect(lift.length).toBeGreaterThan(0)
    expect(lift).toContain('scale(')
    expect(lift).toContain('translateY(')
    // 放大只能走 transform：换成 width/height 就真的会挤动同排。
    expect(lift).not.toMatch(/\b(width|height|margin)\s*:/)
  })

  it('AgentAvatar 有真实调用者，且两个面板都经同一条链路到达它（零调用者检查）', () => {
    // 竖切闭合：共享层渲染头像，两个 bar 都用共享层。任何一环断了，头像就只在一侧在场，
    // 或者退回成"两处长得像的写法"。
    expect(selector).toContain("import { AgentAvatar } from './AgentAvatar'")
    expect(selector).toContain('<AgentAvatar')
    expect(dock).toContain("import { TopicPresence } from './TopicPresence'")
    expect(dock).toContain('<TopicPresence')
    expect(topicPresence).toContain("import { AgentAvatar } from './AgentAvatar'")
    expect(topicPresence).toContain('<AgentAvatar')
    expect(topicPresence).toContain('<SelectorPresence agents=')
    expect(branches).toContain('<SelectorPresence')
  })
})
