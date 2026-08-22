import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  addWorkbenchRegion,
  createWorkbenchTab,
  type WorkbenchSurface,
  type WorkbenchTab
} from '../src/renderer/src/lib/workbench-tabs.js'
import {
  markAppearance,
  tabMarkAgentFactsFor,
  tabRegionSummary,
  workbenchTabMarks,
  WORKBENCH_TAB_MARK_LIMIT,
  type TabMarkAgentFacts,
  type TabMarkSession
} from '../src/renderer/src/lib/workbench-tab-marks.js'
import { WorkbenchTabMarks } from '../src/renderer/src/components/WorkbenchTabMarks.js'

/**
 * 标签上的堆叠标记：一张 Tab 含多个 Region 时，标签要画出这张 Tab 的**种类构成**。
 *
 * 这里守的是设计 SSOT `docs/design/agentmux-surface-density.md` 的那条判据落到标签上的样子——
 * 「图标的价值在于区分，无可区分时它只在挤压标题的可读宽度」。所以判据分两侧，两侧都必须有人守：
 * 画出来不一样的必须都在（否则「还开着个浏览器」看不出来，这个需求就没实现），画出来一样的必须
 * 只留一个（否则三个终端堆三个同样的图标，纯宽度开销）。
 */

function agentSurface(regionId: string, sessionId: string): WorkbenchSurface {
  return { regionId, kind: 'agent', phase: 'attached', workspaceId: 'workspace', sessionId }
}

function terminalSurface(regionId: string, sessionId: string): WorkbenchSurface {
  return { regionId, kind: 'terminal', phase: 'attached', workspaceId: 'workspace', sessionId }
}

function fileSurface(regionId: string, path: string): WorkbenchSurface {
  return { regionId, kind: 'file', workspaceId: 'workspace', path }
}

function browserSurface(regionId: string, driving = false): WorkbenchSurface {
  return {
    regionId,
    kind: 'browser',
    workspaceId: 'workspace',
    browserId: `browser-${regionId}`,
    id: `browser-${regionId}`,
    navigationId: 'nav-1',
    profileId: 'profile-1',
    url: 'https://example.com',
    title: 'Example',
    canGoBack: false,
    canGoForward: false,
    loading: false,
    viewport: 'desktop',
    error: null,
    driving,
    appLinkPrompt: null
  }
}

function launcherSurface(regionId: string): WorkbenchSurface {
  return { regionId, kind: 'launcher', workspaceId: 'workspace' }
}

// 把若干 Region 拼成一张 Tab：第一个当标题 Region，其余依次右分。
function tabWith(...surfaces: WorkbenchSurface[]): WorkbenchTab {
  let tab = createWorkbenchTab('tab', surfaces[0]!)
  for (const surface of surfaces.slice(1)) {
    tab = addWorkbenchRegion(tab, tab.layout.activeRegionId, 'right', surface)
  }
  return tab
}

// 「这个 Region 上没有任何 Agent」——agent Region 的 session 还没到时的真实情形。
// 显式标注签名，别让它推成 `() => null`：那样把它当默认参数用时会把参数类型收窄成无参函数。
const noAgents: (surface: WorkbenchSurface) => TabMarkAgentFacts | null = () => null

// 按 sessionId 给 Agent 事实；未列出的 session 视为 Agent 事实缺席。
function agentsBySession(
  entries: Record<string, TabMarkAgentFacts>
): (surface: WorkbenchSurface) => TabMarkAgentFacts | null {
  return (surface) => {
    if (surface.kind !== 'agent' && surface.kind !== 'terminal') return null
    return entries[surface.sessionId] ?? null
  }
}

describe('workbenchTabMarks：画出来不一样的都要在', () => {
  it('终端 + 浏览器 + 文件三种同在时，三个标记都画出来', () => {
    const tab = tabWith(
      terminalSurface('region-0', 'session-term'),
      browserSurface('region-1'),
      fileSurface('region-2', 'src/main.ts')
    )
    // 这条是需求本身：此前标签只按标题 Region 画一个图标，另外两样在标签上完全不可见。
    expect(workbenchTabMarks(tab, noAgents).map((mark) => mark.kind)).toEqual([
      'terminal',
      'browser',
      'file'
    ])
  })

  it('两个 Provider 不同的 Agent 各画一个：Provider 图标肉眼可分，是真信息', () => {
    const tab = tabWith(agentSurface('region-0', 'session-a'), agentSurface('region-1', 'session-b'))
    const marks = workbenchTabMarks(
      tab,
      agentsBySession({
        'session-a': { providerId: 'codex', status: { state: 'working', source: 'native-hook', observedAt: 1 } },
        'session-b': { providerId: 'claude', status: { state: 'working', source: 'native-hook', observedAt: 1 } }
      })
    )
    // 不用 length 判：计数地板会把「画了两个但都是同一个 Provider」这种错吃掉。
    expect(marks).toEqual([
      { kind: 'agent', providerId: 'codex', status: { state: 'working', source: 'native-hook', observedAt: 1 }, regionId: 'region-0' },
      { kind: 'agent', providerId: 'claude', status: { state: 'working', source: 'native-hook', observedAt: 1 }, regionId: 'region-1' }
    ])
  })

  it('同 Provider 但状态不同的两个 Agent 各画一个：状态点也是肉眼可分的差别', () => {
    const tab = tabWith(agentSurface('region-0', 'session-a'), agentSurface('region-1', 'session-b'))
    const marks = workbenchTabMarks(
      tab,
      agentsBySession({
        'session-a': { providerId: 'codex', status: { state: 'working', source: 'native-hook', observedAt: 1 } },
        'session-b': { providerId: 'codex', status: { state: 'waiting', source: 'native-hook', observedAt: 1 } }
      })
    )
    expect(marks.map((mark) => mark.kind === 'agent' && mark.status.state)).toEqual([
      'working',
      'waiting'
    ])
  })

  it('kind 是 terminal 的 Region 拿到 Agent session 时画 Agent 标记，而不是终端图标', () => {
    // 渲染现场那条链就是这么判的：surface.kind 过了闸之后还要看 session 是不是 Agent。
    const tab = tabWith(terminalSurface('region-0', 'session-a'))
    expect(workbenchTabMarks(tab, agentsBySession({
      'session-a': { providerId: 'codex', status: { state: 'working', source: 'native-hook', observedAt: 1 } }
    }))).toEqual([
      { kind: 'agent', providerId: 'codex', status: { state: 'working', source: 'native-hook', observedAt: 1 }, regionId: 'region-0' }
    ])
  })

  it('标题 Region 恒在最前，即便它在 regions 的迭代序里不是第一个', () => {
    // 让标题 Region 成为**最后**加进去的那个：把 titleRegionId 指过去，制造迭代序与身份不一致。
    const base = tabWith(terminalSurface('region-0', 'session-term'), browserSurface('region-1'))
    const tab: WorkbenchTab = { ...base, titleRegionId: 'region-1' }
    // 若实现改成直接用 Object.values 的顺序，第一个标记会变成 terminal——标签上画的第一个图标
    // 就不是这张 Tab 自己的身份了。
    expect(workbenchTabMarks(tab, noAgents)[0]).toEqual({ kind: 'browser', driving: false, regionId: 'region-1' })
  })
})

describe('workbenchTabMarks：画出来一样的只留一个', () => {
  it('三个终端 Region 只画一个终端标记——同图标重复不携带信息', () => {
    const tab = tabWith(
      terminalSurface('region-0', 'session-a'),
      terminalSurface('region-1', 'session-b'),
      terminalSurface('region-2', 'session-c')
    )
    // 注意这里 session 各不相同：终端标记只画一个固定图标，sessionId 不进 appearance，所以照旧去重。
    expect(workbenchTabMarks(tab, noAgents)).toEqual([{ kind: 'terminal', regionId: 'region-0' }])
  })

  it('两个文件 Region 只画一个文件标记，且保留的是标题那个 Region', () => {
    const tab = tabWith(fileSurface('region-0', 'a.ts'), fileSurface('region-1', 'b.ts'))
    expect(workbenchTabMarks(tab, noAgents)).toEqual([{ kind: 'file', regionId: 'region-0' }])
  })

  it('两个 Agent 的 Provider 与状态都相同时只画一个：并排画出来逐像素相同', () => {
    const tab = tabWith(agentSurface('region-0', 'session-a'), agentSurface('region-1', 'session-b'))
    const marks = workbenchTabMarks(
      tab,
      agentsBySession({
        'session-a': { providerId: 'codex', status: { state: 'working', source: 'native-hook', observedAt: 1 } },
        'session-b': { providerId: 'codex', status: { state: 'working', source: 'native-hook', observedAt: 1 } }
      })
    )
    expect(marks).toEqual([
      { kind: 'agent', providerId: 'codex', status: { state: 'working', source: 'native-hook', observedAt: 1 }, regionId: 'region-0' }
    ])
  })

  it('同 Provider、同状态但 Executor 外观不同仍各画一个', () => {
    const tab = tabWith(agentSurface('region-0', 'session-a'), agentSurface('region-1', 'session-b'))
    const marks = workbenchTabMarks(tab, agentsBySession({
      'session-a': { providerId: 'codex', executorId: 'default', appearance: { tint: '#ee7755', badge: 'spark' }, status: { state: 'working', source: 'native-hook', observedAt: 1 } },
      'session-b': { providerId: 'codex', executorId: 'review', appearance: { tint: '#6688dd', badge: 'shield' }, status: { state: 'working', source: 'native-hook', observedAt: 1 } }
    }))
    expect(marks).toHaveLength(2)
    expect(marks.map((mark) => mark.kind === 'agent' ? mark.appearance?.badge : null)).toEqual(['spark', 'shield'])
  })

  it('Agent 事实缺席的 agent Region 与终端 Region 折成同一个标记', () => {
    // 两者在渲染现场画的都是那个固定的终端图标。若按 surface.kind 分开去重，这里会堆两个一样的图标。
    const tab = tabWith(agentSurface('region-0', 'session-a'), terminalSurface('region-1', 'session-b'))
    expect(workbenchTabMarks(tab, noAgents)).toEqual([{ kind: 'terminal', regionId: 'region-0' }])
  })
})

/**
 * 「这一格正在被 Agent 驱动」要在标签上认得出来。
 *
 * 为什么标签上非有这条不可：页面内角标（T-012）只在人**看着那一页**时成立，而人恰恰常在别处
 * 干活。这条判的是另一半覆盖面——不切过去也知道是哪一格。
 */
describe('workbenchTabMarks：驱动中的 Browser 与闲着的分得开', () => {
  it('一个在被驱动、一个闲着的两个 Browser Region，标签上画两个标记', () => {
    // 这条是本功能的全部要害。`driving` 不进 appearance 的话这两个会被折成一个，而被折掉的
    // 恰恰是「哪一格在被驱动」——功能当场归零，且看起来只是"去重工作正常"。
    const tab = tabWith(browserSurface('region-0', true), browserSurface('region-1', false))
    expect(workbenchTabMarks(tab, noAgents)).toEqual([
      { kind: 'browser', driving: true, regionId: 'region-0' },
      { kind: 'browser', driving: false, regionId: 'region-1' }
    ])
  })

  it('反向：两个都在被驱动时仍然只画一个——它们画出来逐像素相同', () => {
    // 没有这一半，一个「browser 标记一律不去重」的实现也会让上面那条绿，而那等于三个闲着的
    // Browser 堆三个一样的地球图标，正是去重规则要挡的东西。
    const tab = tabWith(browserSurface('region-0', true), browserSurface('region-1', true))
    expect(workbenchTabMarks(tab, noAgents)).toEqual([
      { kind: 'browser', driving: true, regionId: 'region-0' }
    ])
  })

  it('appearance 把两种状态分成两个键，闲着的那两个仍是同一个键', () => {
    // 直接判去重键本身：它同时是「画出来一不一样」的答案，两者收成一个取值就不会漂。
    const driving = markAppearance({ kind: 'browser', driving: true, regionId: 'r' })
    const idle = markAppearance({ kind: 'browser', driving: false, regionId: 'r' })
    expect(driving).not.toBe(idle)
    expect(markAppearance({ kind: 'browser', driving: false, regionId: 'other' })).toBe(idle)
  })

  it('tooltip 的人话说得出「正在被驱动」——被上限折掉时这句话是它唯一的痕迹', () => {
    const tab = tabWith(browserSurface('region-0', true), fileSurface('region-1', 'a.ts'))
    expect(tabRegionSummary(tab, noAgents)).toBe('Regions: Browser (Agent driving), File')
  })
})

describe('workbenchTabMarks：上限', () => {
  it('可区分的种类超过上限时截断，且标题 Region 那个不被截掉', () => {
    const tab = tabWith(
      browserSurface('region-0'),
      terminalSurface('region-1', 'session-term'),
      fileSurface('region-2', 'a.ts'),
      agentSurface('region-3', 'session-a')
    )
    const marks = workbenchTabMarks(tab, agentsBySession({
      'session-a': { providerId: 'codex', status: { state: 'working', source: 'native-hook', observedAt: 1 } }
    }))
    expect(marks).toHaveLength(WORKBENCH_TAB_MARK_LIMIT)
    // 头部必须是标题 Region：截断从尾部发生，不能把身份挤掉。
    expect(marks[0]).toEqual({ kind: 'browser', driving: false, regionId: 'region-0' })
  })

  it('上限是 3：这个数字本身有人守，改大改小都会红', () => {
    // 直接钉住常量，因为它是与 `.workbench-tab` 宽度绑定的产品决定，不是可以随手调的实现细节。
    expect(WORKBENCH_TAB_MARK_LIMIT).toBe(3)
  })
})

describe('WorkbenchTabMarks：算出来的标记真被画出来', () => {
  // 为什么必须有这一族：只测纯函数守不住「壳有没有被执行到」。实测在标记组件第一行插
  // `if (true) return null`——整个图标簇一个都不画，用户看到的东西完全消失——而 workbench 那 50 条
  // 测试照旧全绿。这里真渲染一遍，那次变异才会红。
  function render(tab: WorkbenchTab, agentFacts = noAgents): string {
    return renderToStaticMarkup(
      createElement(WorkbenchTabMarks, { marks: workbenchTabMarks(tab, agentFacts) })
    )
  }

  it('三种标记各画出一个可分辨的图标，且数量与纯函数算出的一致', () => {
    const html = render(
      tabWith(
        terminalSurface('region-0', 'session-term'),
        browserSurface('region-1'),
        fileSurface('region-2', 'src/main.ts')
      )
    )
    // lucide 每个图标带自己的 class，用它数「画了几个、都是哪几个」。类名取自实际渲染产物，不靠组件名猜
    // （`Globe2` 渲染出的是 `lucide-earth`，`FileCode2` 是 `lucide-file-code2`）。
    expect(html).toContain('lucide-square-terminal')
    expect(html).toContain('lucide-earth')
    expect(html).toContain('lucide-file-code2')
    // 三个 <svg> 恰好，多一个少一个都红：既守「都画了」也守「没多画」。
    expect(html.match(/<svg/g)).toHaveLength(3)
  })

  it('去重后只剩一个标记时就只画一个图标——重复的 Region 不产生重复的 svg', () => {
    const html = render(
      tabWith(
        terminalSurface('region-0', 'session-a'),
        terminalSurface('region-1', 'session-b'),
        terminalSurface('region-2', 'session-c')
      )
    )
    expect(html.match(/<svg/g)).toHaveLength(1)
    expect(html).toContain('lucide-square-terminal')
  })

  it('Agent 标记画出 Provider 图标与状态点，而不是终端图标', () => {
    const html = render(
      tabWith(agentSurface('region-0', 'session-a')),
      agentsBySession({
        'session-a': {
          providerId: 'codex',
          status: { state: 'working', source: 'native-hook', observedAt: 1 }
        }
      })
    )
    expect(html).toContain('workbench-tab__agent-mark')
    expect(html).toContain('agent-avatar__status--working')
    expect(html).not.toContain('status__dot')
    // Provider 图标在场：codex 走的是内置 Provider 那一支，画的不是那个兜底的机器人。
    expect(html).not.toContain('lucide-square-terminal')
  })

  it('外层容器带 .workbench-tab__marks——间距与状态点底座色全挂在这个类上', () => {
    // 这个类不是装饰：`workbench.css` 的 `gap` 与 `--tab-mark-seat`（状态点底座色，逐 tabbar 档位不同）
    // 只认它。类名没了，标记会挤成一团，且状态点周围出现一圈色差晕。
    expect(render(tabWith(terminalSurface('region-0', 'session-a')))).toContain(
      'class="workbench-tab__marks"'
    )
  })

  it('launcher Region 画自己的图标，不与终端折成一个', () => {
    // launcher（「新建 Tab」占位）是真实可达的 surface：分屏里完全可以一边是它、一边是别的东西。
    // 此前这一支两侧都无人守——把渲染兜底的 Sparkles 换成终端图标、或让纯函数把 launcher 归成
    // terminal 标记，两种变异都在 20 条全绿下存活。
    const html = render(tabWith(launcherSurface('region-0'), terminalSurface('region-1', 'session-a')))
    expect(html).toContain('lucide-sparkles')
    expect(html).toContain('lucide-square-terminal')
    // 两个：launcher 与终端画出来不一样，都要在（若被折成一种，这里只剩一个）。
    expect(html.match(/<svg/g)).toHaveLength(2)
  })

  it('被驱动的 Browser 画的不是地球——它与旁边闲着的那个一眼分得开', () => {
    // 纯函数那一族只能证「算出来是两个标记」。这一条证**画出来真的不一样**：让渲染对 driving
    // 视而不见（两支都返回 Globe2），纯函数那边照样全绿，而用户看到的是两个一模一样的地球。
    const html = render(tabWith(browserSurface('region-0', true), browserSurface('region-1', false)))
    expect(html).toContain('lucide-bot')
    expect(html).toContain('lucide-earth')
    expect(html.match(/<svg/g)).toHaveLength(2)
    // 悬停也要说得出来：图标本身不自带含义，标签上没有别的地方能解释这只 Bot 是什么意思。
    expect(html).toContain('Agent driving')
  })

  it('反向：没在被驱动的 Browser 画地球，不画 Bot', () => {
    // 少了这一半，一个「browser 一律画 Bot」的实现会让上面那条绿——而那等于每个浏览器看起来
    // 都在被 Agent 操作。
    const html = render(tabWith(browserSurface('region-0', false)))
    expect(html).toContain('lucide-earth')
    expect(html).not.toContain('lucide-bot')
  })
})

describe('tabMarkAgentFactsFor：从 Session 解析「谁是 Agent」', () => {
  // 为什么这一族必须存在：这个判断此前是 `WorkspaceWorkbench` 里的内联回调，而那个文件在 node 里
  // import 不了（经 api.ts 的一个 vite define），所以**没有任何测试能执行到它**。实测把回调第一行改成
  // `return null`——标签上所有 Agent 标记退化成终端图标，用户再也分不清 codex/claude、也看不到状态点——
  // 而这个文件里那 20 条照旧全绿。搬进 lib 之后下面这几条才守得住它。
  const working = { state: 'working' as const, source: 'native-hook' as const, observedAt: 1 }

  function sessions(...items: TabMarkSession[]): TabMarkSession[] {
    return items
  }

  it('agent Region 拿到 agent session 时给出 Provider 与状态', () => {
    const facts = tabMarkAgentFactsFor(
      sessions({ id: 'session-a', kind: 'agent', providerId: 'codex', status: working })
    )
    expect(facts(agentSurface('region-0', 'session-a'))).toEqual({
      providerId: 'codex',
      sessionId: 'session-a',
      status: working
    })
  })

  it('kind 是 terminal 的 Region 拿到 agent session 时同样给出 Agent 事实', () => {
    // 这正是「不能按 surface.kind 判」的理由：一个终端 Region 完全可以扛着一个 Agent session。
    const facts = tabMarkAgentFactsFor(
      sessions({ id: 'session-a', kind: 'agent', providerId: 'claude', status: working })
    )
    expect(facts(terminalSurface('region-0', 'session-a'))).toEqual({
      providerId: 'claude',
      sessionId: 'session-a',
      status: working
    })
  })

  it('session 是真终端时给 null——那画的是终端图标，不是 Agent 标记', () => {
    const facts = tabMarkAgentFactsFor(sessions({ id: 'session-a', kind: 'terminal', status: working }))
    expect(facts(terminalSurface('region-0', 'session-a'))).toBeNull()
  })

  it('session 还没到（id 查不到）时给 null，而不是造一个假 Provider', () => {
    // agent Region 在 session 抵达之前的真实情形。此时该画终端图标，等 session 到了再变成 Provider 图标。
    const facts = tabMarkAgentFactsFor(sessions())
    expect(facts(agentSurface('region-0', 'session-missing'))).toBeNull()
  })

  it('不带 session 的 Region 一律给 null，不去 Map 里瞎查', () => {
    // file / browser / launcher 三种 surface 没有 sessionId，它们不可能有 Agent 事实。
    const facts = tabMarkAgentFactsFor(
      sessions({ id: 'session-a', kind: 'agent', providerId: 'codex', status: working })
    )
    expect(facts(fileSurface('region-0', 'a.ts'))).toBeNull()
    expect(facts(browserSurface('region-1'))).toBeNull()
    expect(facts(launcherSurface('region-2'))).toBeNull()
  })

  it('多个 session 时按 sessionId 取对应那个，不是取第一个', () => {
    // 计数或「非空」都吃得下「永远返回第一个 session」这种错；这一条钉住按 id 对位。
    const facts = tabMarkAgentFactsFor(
      sessions(
        { id: 'session-a', kind: 'agent', providerId: 'codex', status: working },
        { id: 'session-b', kind: 'agent', providerId: 'claude', status: working }
      )
    )
    expect(facts(agentSurface('region-1', 'session-b'))?.providerId).toBe('claude')
  })

  it('接到 workbenchTabMarks 上，两个 Provider 不同的 Agent 各画一个', () => {
    // 端到端一次：这是渲染现场那一句 `workbenchTabMarks(tab, tabMarkAgentFactsFor(sessions))` 的形状，
    // 证明这个取值函数与那个纯函数真的接得上，而不只是各自单测通过。
    const tab = tabWith(agentSurface('region-0', 'session-a'), agentSurface('region-1', 'session-b'))
    const marks = workbenchTabMarks(
      tab,
      tabMarkAgentFactsFor(
        sessions(
          { id: 'session-a', kind: 'agent', providerId: 'codex', status: working },
          { id: 'session-b', kind: 'agent', providerId: 'claude', status: working }
        )
      )
    )
    expect(marks).toEqual([
      { kind: 'agent', providerId: 'codex', status: working, sessionId: 'session-a', regionId: 'region-0' },
      { kind: 'agent', providerId: 'claude', status: working, sessionId: 'session-b', regionId: 'region-1' }
    ])
  })
})

describe('tabRegionSummary：折掉的种类必须还能被找到', () => {
  // 标记簇在上限处截断且刻意不画 `+N`（标签宽度极紧）。「截断」那一半此前是实现好的，「折掉的东西
  // 仍然说得出来」那一半完全没有——第四种 Region 一声不响地消失。本仓自家的头像簇规矩是
  // 「超过可容纳枚数折成 +N，全名进 tooltip」（`docs/design/agentmux-surface-density.md`），
  // 标记簇只照做了前半句。这一族守的就是后半句。

  it('超出上限被截掉的那个种类，仍出现在 tooltip 的构成里', () => {
    // 四种可区分的 Region，上限是 3——第四个（agent）在标签上完全看不到。
    const tab = tabWith(
      browserSurface('region-0'),
      terminalSurface('region-1', 'session-term'),
      fileSurface('region-2', 'a.ts'),
      agentSurface('region-3', 'session-a')
    )
    const facts = agentsBySession({
      'session-a': { providerId: 'codex', status: { state: 'working', source: 'native-hook', observedAt: 1 } }
    })
    // 先坐实前提：它真的被标签截掉了，所以这条 tooltip 不是多余的。
    expect(workbenchTabMarks(tab, facts).map((mark) => mark.kind)).not.toContain('agent')
    expect(tabRegionSummary(tab, facts)).toBe('Regions: Browser, Terminal, File, codex')
  })

  it('Agent 那支在构成里给 Provider 名，不是笼统的 "Agent"', () => {
    // 「这张 Tab 里还开着一个 claude」正是被折掉时最可惜的那条信息；说成 "Agent" 等于没说。
    const tab = tabWith(fileSurface('region-0', 'a.ts'), agentSurface('region-1', 'session-a'))
    expect(
      tabRegionSummary(
        tab,
        agentsBySession({
          'session-a': { providerId: 'claude', status: { state: 'working', source: 'native-hook', observedAt: 1 } }
        })
      )
    ).toBe('Regions: File, claude')
  })

  it('只有一个种类时给 null——标签上那个图标已经说完了', () => {
    // SSOT 的「不重复呈现同一事实」：单 Region 的 Tab（绝大多数）tooltip 再补一行「Regions: Terminal」
    // 是同一件事占两处。三个终端 Region 同理，它们在标签上折成一个终端图标，构成也只有一个词。
    expect(tabRegionSummary(tabWith(terminalSurface('region-0', 'session-a')), noAgents)).toBeNull()
    expect(
      tabRegionSummary(
        tabWith(
          terminalSurface('region-0', 'session-a'),
          terminalSurface('region-1', 'session-b'),
          terminalSurface('region-2', 'session-c')
        ),
        noAgents
      )
    ).toBeNull()
  })

  it('构成从未截断的全部 Region 算，不从 marks 算', () => {
    // 拿已截断的结果去描述被截断掉的东西是循环的。五种 Region 时 marks 只有 3 个，而构成必须有 5 个词。
    const tab = tabWith(
      browserSurface('region-0'),
      terminalSurface('region-1', 'session-term'),
      fileSurface('region-2', 'a.ts'),
      launcherSurface('region-3'),
      agentSurface('region-4', 'session-a')
    )
    const facts = agentsBySession({
      'session-a': { providerId: 'codex', status: { state: 'working', source: 'native-hook', observedAt: 1 } }
    })
    expect(workbenchTabMarks(tab, facts)).toHaveLength(WORKBENCH_TAB_MARK_LIMIT)
    expect(tabRegionSummary(tab, facts)?.split(', ')).toHaveLength(5)
  })

  it('状态不进构成——那是会过期的描述，状态点自己画得出来', () => {
    // 两个同 Provider 不同状态的 Agent 在标签上画两个标记（状态点可分辨），但在 tooltip 里读作同一个
    // 词。把 working/waiting 写进这句话，它就会在下一秒变成谎，而 tooltip 不随状态重算措辞。
    const tab = tabWith(agentSurface('region-0', 'session-a'), agentSurface('region-1', 'session-b'))
    const facts = agentsBySession({
      'session-a': { providerId: 'codex', status: { state: 'working', source: 'native-hook', observedAt: 1 } },
      'session-b': { providerId: 'codex', status: { state: 'waiting', source: 'native-hook', observedAt: 1 } }
    })
    expect(workbenchTabMarks(tab, facts)).toHaveLength(2)
    // 说出来一样，所以只说一次——于是整句只剩一个词，按「不重复」规矩退回 null。
    expect(tabRegionSummary(tab, facts)).toBeNull()
  })
})

describe('markAppearance：去重键就是「画出来长什么样」', () => {
  it('Provider 不同则 appearance 不同', () => {
    const a = markAppearance({ kind: 'agent', providerId: 'codex', status: { state: 'working', source: 'native-hook', observedAt: 1 }, regionId: 'r0' })
    const b = markAppearance({ kind: 'agent', providerId: 'claude', status: { state: 'working', source: 'native-hook', observedAt: 1 }, regionId: 'r1' })
    expect(a).not.toBe(b)
  })

  it('状态不同则 appearance 不同', () => {
    const a = markAppearance({ kind: 'agent', providerId: 'codex', status: { state: 'working', source: 'native-hook', observedAt: 1 }, regionId: 'r0' })
    const b = markAppearance({ kind: 'agent', providerId: 'codex', status: { state: 'waiting', source: 'native-hook', observedAt: 1 }, regionId: 'r1' })
    expect(a).not.toBe(b)
  })

  it('status.source 不进 appearance：它只在 tooltip 里，并排画出来看不出差别', () => {
    // source 是指过去才看得到的文字。若它掺进 appearance，同一个 Provider 同一个状态、只因为状态来源
    // 不同（hook / 采样）就会在标签上堆两个逐像素相同的图标。
    const a = markAppearance({ kind: 'agent', providerId: 'codex', status: { state: 'working', source: 'native-hook', observedAt: 1 }, regionId: 'r0' })
    const b = markAppearance({ kind: 'agent', providerId: 'codex', status: { state: 'working', source: 'run-process', observedAt: 1 }, regionId: 'r1' })
    expect(a).toBe(b)
  })

  it('两个终端标记的 appearance 相同，尽管 regionId 不同', () => {
    const a = markAppearance({ kind: 'terminal', regionId: 'region-0' })
    const b = markAppearance({ kind: 'terminal', regionId: 'region-1' })
    expect(a).toBe(b)
  })

  it('appearance 一律不含 regionId：否则每个 Region 都「看起来不一样」，去重彻底失效', () => {
    // 这条把上面那条的理由钉死在取值上，而不是靠两个例子恰好相等；agent 那一支也一并守住。
    expect(markAppearance({ kind: 'file', regionId: 'region-nine' })).not.toContain('region-nine')
    expect(
      markAppearance({ kind: 'agent', providerId: 'codex', status: { state: 'working', source: 'native-hook', observedAt: 1 }, regionId: 'region-nine' })
    ).not.toContain('region-nine')
  })
})
