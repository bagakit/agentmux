import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { allStyles } from './helpers/styles.js'
import type { AppConfig, SessionSnapshot } from '../src/shared/contracts.js'
import { producingAgentCount, workingAgentCount } from '../src/renderer/src/lib/project-board.js'
import { projectWorkspaces, removeProjectWorkspaces, projectGroupKey, workspaceProjectId } from '../src/renderer/src/lib/workspace-projects.js'
import { SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics.js'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

const fixture = vi.hoisted(() => ({
  state: {
    config: null as AppConfig | null,
    sessions: [] as SessionSnapshot[],
    // 真 store 里 timelines 恒为一个对象（初值 `{}`，且不进 partialize，故重启后仍是 `{}`）。
    // 这份手搓的 state 曾经漏了它，于是渲染出一个生产里不存在的世界：ProjectActivity 一读
    // `timelines[session.id]` 就抛 TypeError，六条断言全红。漏一个字段的假 store 不是「测试挂了」，
    // 是**判据在替被测代码回答问题**——它逼着组件去处理一个真实状态机里到不了的形状。
    timelines: {} as Record<string, { items: unknown[] }>,
    // 同一个缺陷的下一个 slice：ProjectActivity 的 roster 行读 `agentNames[row.sessionId]` 取手改名。
    // 真 store 的初值也是 `{}`（store.ts:1695）。漏了它，`undefined['agent-a']` 抛在生产文件的行上，
    // 栈读起来像组件回归——而组件没坏，是这份替身少了一个键。
    agentNames: {} as Record<string, string>,
    providerCatalog: [] as unknown[],
    activeWorkspaceId: 'project-a',
    mainSurface: 'workbench' as const,
    projectRailOpen: true,
    collapsedProjectGroups: {} as Record<string, true>,
    pinnedItems: {} as Record<string, string[]>,
    toolsOpen: false,
    selectWorkspace: vi.fn(async () => {}),
    setMainSurface: vi.fn(),
    setConfig: vi.fn(),
    toggleProjectRail: vi.fn(),
    toggleProjectGroup: vi.fn(),
    toggleTools: vi.fn()
  }
}))

vi.mock('../src/renderer/src/store.js', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof fixture.state) => unknown) => selector(fixture.state),
    { getState: () => fixture.state }
  )
}))

vi.mock('../src/renderer/src/lib/api.js', () => ({
  api: { workspaces: { chooseLocalFolder: vi.fn(async () => null) } }
}))

import { WorkspaceSidebar } from '../src/renderer/src/components/WorkspaceSidebar.js'

const config: AppConfig = {
  version: 9,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: {},
  workspaces: [
    { id: '__scratch__', name: 'Scratch', hostId: 'local', path: '/scratch', kind: 'folder' },
    { id: 'project-a', name: 'Alpha', hostId: 'local', path: '/alpha', kind: 'folder' },
    { id: 'project-b', name: 'Beta', hostId: 'local', path: '/beta', kind: 'folder' },
    { id: 'project-c', name: 'Gamma', hostId: 'local', path: '/gamma', kind: 'folder' }
  ],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
}

function session(
  id: string,
  workspacePath: string,
  state: SessionSnapshot['status']['state'],
  kind: SessionSnapshot['kind'] = 'agent'
): SessionSnapshot {
  if (kind === 'terminal') {
    return {
      id,
      kind: 'terminal',
      providerId: null,
      hostId: 'local',
      workspacePath,
      label: id,
      createdAt: 1,
      updatedAt: 1,
      processState: 'running',
      status: { state, source: 'run-process', observedAt: 1 },
      latestOutputBytes: 0,
      control: { kind: 'terminal', hostId: 'local', run: { runId: `run-${id}` } }
    }
  }
  return {
    id,
    kind: 'agent',
    providerId: 'codex',
    executorId: 'codex',
    capabilities: {
      terminal: true,
      timeline: 'streaming',
      permission: 'observe',
      providerResume: true,
      replyCorrelation: 'none'
    },
    hostId: 'local',
    workspacePath,
    label: id,
    createdAt: 1,
    updatedAt: 1,
    processState: 'running',
    status: { state, source: 'run-process', observedAt: 1 },
    latestOutputBytes: 0,
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `run-${id}` } }
  }
}

function renderRail(): string {
  return renderToStaticMarkup(createElement(WorkspaceSidebar, { onOpenSettings: vi.fn() }))
}

/** 取出某一行的完整标记。按 aria-label 定位，因为那是这一行对辅助技术自称的名字。 */
function rowFor(markup: string, name: string): string {
  const rows = [...markup.matchAll(/<button[^>]*class="[^"]*project-rail-row[^"]*"[\s\S]*?<\/button>/g)]
    .map((match) => match[0])
    .filter((row) => new RegExp(`aria-label="${name}(?:[^"]*)?"`).test(row))
  expect(`${name}: ${rows.length} 行`).toBe(`${name}: 1 行`)
  return rows[0]!
}

/** 这一行徽章上的数字，没有徽章时为 null——「零不显示」与「显示 0」是两件事。 */
function badgeOf(row: string): string | null {
  return row.match(/class="project-rail-row__count"[^>]*>([^<]*)</)?.[1] ?? null
}

afterEach(() => {
  fixture.state.config = structuredClone(config)
  fixture.state.sessions = []
  fixture.state.activeWorkspaceId = 'project-a'
  fixture.state.collapsedProjectGroups = {}
  fixture.state.pinnedItems = {}
})

describe('workingAgentCount', () => {
  it('uses the Board working column and excludes idle, finished, and terminal sessions', () => {
    expect(workingAgentCount([
      session('starting', '/alpha', 'starting'),
      session('running', '/alpha', 'running'),
      session('working', '/alpha', 'working'),
      session('waiting', '/alpha', 'waiting'),
      session('done', '/alpha', 'done'),
      session('terminal', '/alpha', 'running', 'terminal')
    ])).toBe(3)
  })

  it('separates semantic production from a quiet live Session', () => {
    expect(producingAgentCount([
      session('starting', '/alpha', 'starting'),
      session('working', '/alpha', 'working'),
      session('running', '/alpha', 'running'),
      session('waiting', '/alpha', 'waiting'),
      session('terminal', '/alpha', 'running', 'terminal')
    ])).toBe(2)
  })
})

describe('Project Rail selection and running signals', () => {
  it('shows a running marker for every running project, including the selected one', () => {
    fixture.state.config = structuredClone(config)
    fixture.state.sessions = [
      session('agent-a', '/alpha', 'working'),
      session('agent-b', '/beta', 'running'),
      session('agent-c', '/gamma', 'waiting')
    ]
    const markup = renderRail()
    const runningRows = markup.match(/data-running="true"/g) ?? []
    expect(runningRows).toHaveLength(2)
    expect(markup).toContain('project-rail-row--active')
    expect(markup).toContain('class="project-activity__pulse"')
    expect(markup).toContain('Alpha · 1 Agent is working')
    expect(markup).toContain('Beta · 1 idle')
    expect(markup).not.toContain('Beta · 1 Agent is working')
    expect(markup).not.toContain('Gamma · 1 Agent is working')
  })

  it('keeps selected and running independent across all four combinations', () => {
    fixture.state.config = structuredClone(config)
    fixture.state.sessions = [session('agent-b', '/beta', 'working')]
    fixture.state.activeWorkspaceId = 'project-a'
    let markup = renderRail()
    expect(markup.match(/data-running="true"/g) ?? []).toHaveLength(1)
    expect(markup).toContain('project-rail-row--active')

    fixture.state.sessions = [session('agent-a', '/alpha', 'working')]
    fixture.state.activeWorkspaceId = 'project-a'
    markup = renderRail()
    expect(markup.match(/data-running="true"/g) ?? []).toHaveLength(1)
    expect(markup).toContain('Alpha · 1 Agent is working')

    fixture.state.sessions = []
    fixture.state.activeWorkspaceId = 'project-a'
    markup = renderRail()
    expect(markup.match(/data-running="true"/g) ?? []).toHaveLength(0)
    expect(markup).toContain('project-rail-row--active')
  })

  it('separates "producing now" from "merely live" without forking the count', () => {
    // 两个词、一个数。`running` 不是边角状态而是主稳态（`unknown → 'running'` 的三条来路之一是
    // 15 分钟静默衰减），所以「正在吐字」与「半小时前说过一句话」同在 Board 的 working 列里。
    // 一个词盖住两者，用户就看不出哪个值得等。
    //
    // 这条同时钉住**计数不许跟着分叉**：两个项目各一个 Agent，词不同、数都必须是 1。#582 的四处
    // 报出两组数就是从「同一个问题判两次」开始的，区分用词不该把那道收敛重新打开。
    fixture.state.config = structuredClone(config)
    fixture.state.sessions = [
      session('producing', '/alpha', 'working'),
      session('idle-live', '/beta', 'running')
    ]
    const markup = renderRail()
    expect(rowFor(markup, 'Alpha')).toContain('data-running="true"')
    expect(rowFor(markup, 'Beta')).toContain('data-running="true"')
    // 数字在 aria-label 上（`__count` 是 aria-hidden 的字形，读屏只能听见这一份）。
    expect(markup).toContain('1 Working')
    expect(rowFor(markup, 'Beta')).not.toContain('class="project-activity"')
    expect(markup).not.toContain('1 Running')
  })

  it('prints the number once: the hover label carries the word only', () => {
    // 用户原话：「running 等标记本身已经带有数字了，hover 展开是不是不用带数字了」。
    //
    // 判据必须取**那个可见元素的文本本身**，不能用 `toContain('1 Working')`——展开后画成
    // 「1 1 Working」时那条断言照旧成立（实测：把数字塞回 label 的变异体让 33 条断言全绿通过）。
    // 所以这里抠出 `__label` 的内容，断言它**一个数字都没有**：这才是「印一遍」这个性质本身。
    fixture.state.config = structuredClone(config)
    fixture.state.sessions = [
      session('a1', '/alpha', 'working'),
      session('a2', '/alpha', 'working'),
      session('a3', '/alpha', 'running')
    ]
    const markup = renderRail()
    const labels = [...markup.matchAll(/class="project-activity__label">([^<]*)</g)].map((m) => m[1]!)
    expect(labels).toEqual(['Working'])
    expect(labels[0]).not.toMatch(/\d/)
    // 数字仍然在场，只是只在计数那一处（三个 Agent 里两个 working、一个 running，全在 working 列 = 3）。
    const counts = [...markup.matchAll(/class="project-activity__count"[^>]*>([^<]*)</g)].map((m) => m[1]!)
    expect(counts).toEqual(['2'])
  })

  it('removes the repeated project icon while retaining Scratch identity', () => {
    fixture.state.config = structuredClone(config)
    const markup = renderRail()
    const projectRows = [...markup.matchAll(/<button[^>]+class="project-rail-row(?:"| )[^>]*>[\s\S]*?<\/button>/g)]
      .map((match) => match[0])
      .filter((row) => row.includes('project-rail-row__identity'))
    expect(projectRows).toHaveLength(4)
    const regularRows = projectRows.filter((row) => !row.includes('scratch-workspace-row'))
    expect(regularRows).toHaveLength(3)
    expect(regularRows.every((row) => row.includes('project-rail-row__icon'))).toBe(true)
    expect(markup).toContain('scratch-workspace-row__icon')
  })

  it('counts running Agents in the badge, not worktrees', () => {
    // 这一条守的是**代码与设计文档的漂移**，不是样式：徽章此前显示 project.workspaces.length
    // （worktree 数），而密度合同《身份归属》写明这行答的是"在跑几个 Agent"。用户报"数字不准"，
    // 真因是它算的压根是另一件事——一个 3 worktree、0 Agent 的项目会显示 3。
    fixture.state.config = structuredClone(config)
    fixture.state.config!.workspaces.push(
      // 同一个项目的两个 worktree：归属靠 repoPath 相同，不是路径前缀。
      { id: 'project-a-wt1', name: 'x', hostId: 'local', path: '/alpha/.worktrees/x', repoPath: '/alpha', kind: 'worktree', branch: 'x' },
      { id: 'project-a-wt2', name: 'y', hostId: 'local', path: '/alpha/.worktrees/y', repoPath: '/alpha', kind: 'worktree', branch: 'y' }
    )
    fixture.state.sessions = [
      session('agent-a1', '/alpha', 'working'),
      session('agent-a2', '/alpha', 'running'),
      session('agent-a3', '/alpha', 'done')
    ]
    const markup = renderRail()
    const alpha = rowFor(markup, 'Alpha')
    // 三个 worktree、两个在跑：徽章必须是 2。改回 workspaces.length 会让它变成 3。
    // 数字与词分居两处（`__count` 画数字、`__label` 画词），这里比的是 aria-label 上拼回的那一份。
    expect(markup).toContain('1 Working')
    // 降级掉的事实不许消失，只许换位置。
    expect(alpha).toContain('3 worktrees')
    expect(alpha).toContain('3 sessions')
  })

  it('hides the badge entirely when nothing is running', () => {
    // 一列全是同一个数字的徽章不携带信息，只在挤压标题宽度（《控件语言》同一条理由）。
    // 截图里每一行都写着 1，因为每个项目恰好一个 worktree——那不是信息，是噪音。
    fixture.state.config = structuredClone(config)
    fixture.state.sessions = [session('agent-b', '/beta', 'working')]
    const markup = renderRail()
    expect(markup).toContain('1 Working')
    expect(badgeOf(rowFor(markup, 'Alpha'))).toBeNull()
    expect(badgeOf(rowFor(markup, 'Gamma'))).toBeNull()
  })

  it('keeps the attention badge lit even when no Agent is working', () => {
    // 徽章同时是 attention 的载体（CSS 把 ?/! 挂在它的 ::after 上）。若"零在跑就不渲染"写成
    // 无条件的，一个只有 waiting Agent 的项目会连同它的 needs-you 信号一起消失——那正是
    // rowAttention 当初要补的那个洞。
    fixture.state.config = structuredClone(config)
    fixture.state.sessions = [session('agent-c', '/gamma', 'waiting')]
    const gamma = rowFor(renderRail(), 'Gamma')
    expect(gamma).toContain('needs you')
    expect(renderRail()).toContain('Needs you')
  })

  it('gives Host a slot only when it is not this machine', () => {
    // `This Mac` 在每一行上逐字相同——它不区分任何东西，只占掉标题的宽度。
    fixture.state.config = structuredClone(config)
    fixture.state.config!.hosts.push({ id: 'studio', kind: 'ssh', label: 'Studio', address: 'studio' })
    fixture.state.config!.workspaces.push(
      { id: 'project-d', name: 'Delta', hostId: 'studio', path: '/delta', kind: 'folder' }
    )
    const markup = renderRail()
    expect(markup).not.toContain('This Mac')
    expect(rowFor(markup, 'Delta')).toContain('studio')
    // 本机行连 <small> 都不该有——留一个空的次级槽仍然会撑出行高。
    expect(rowFor(markup, 'Alpha')).not.toContain('<small')
  })

  it('keeps every row on a single line', () => {
    // 「一行只占一行」是密度预算里写死的一条，而两行结构的印记是 identity 里的 flex-direction:
    // column。这里连着断言 DOM 与 CSS 两侧：DOM 侧证明没有常驻次行内容，CSS 侧证明就算有
    // 内容也不会被摞成两行。
    fixture.state.config = structuredClone(config)
    const markup = renderRail()
    expect(rowFor(markup, 'Alpha')).not.toContain('Unscoped workspace')
    expect(markup).not.toContain('Unscoped workspace')
    const identity = allStyles().match(/\.project-rail-row__identity\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(identity.length).toBeGreaterThan(0)
    expect(identity).not.toContain('flex-direction: column')
  })

  it('uses the app icon for Scratch rather than a decorative glyph', () => {
    // 用户："Scratch 前面的图标有点难看, 是不是换成项目 icon, 现在项目 ICON 哪里都没有"。
    // 用的是已存在的 BrandIcon（resources/icon-128.png），不新造 per-project 图标体系。
    fixture.state.config = structuredClone(config)
    const scratch = rowFor(renderRail(), 'Scratch')
    expect(scratch).toContain('brand-icon')
    expect(scratch).not.toContain('lucide-sparkles')
  })

  it('removes a whole Project view without touching Scratch or unrelated registrations', () => {
    const workspaces = [
      ...config.workspaces,
      { id: 'project-a-wt', name: 'feature', hostId: 'local', path: '/alpha/.worktrees/feature', repoPath: '/alpha', kind: 'worktree' as const, branch: 'feature' }
    ]
    const projects = projectWorkspaces(workspaces)
    const alpha = projects.find((project) => project.name === 'Alpha')!
    expect(removeProjectWorkspaces(workspaces, alpha).map((workspace) => workspace.id)).toEqual([
      '__scratch__',
      'project-b',
      'project-c'
    ])
  })
})

describe('Project Rail style contract', () => {
  const source = allStyles()

  it('scans the Project Rail rules and keeps the section label below row-title emphasis', () => {
    const heading = source.match(/\.sidebar__section-heading\s*\{([^}]*)\}/)?.[1] ?? ''
    const row = source.match(/\.project-rail-row\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(heading.length).toBeGreaterThan(0)
    expect(row.length).toBeGreaterThan(0)
    expect(heading).toContain('font-size: var(--fs-micro)')
    expect(heading).toContain('font-weight: 560')
    expect(heading).toContain('text-transform: none')
  })

  it('does not brighten a project icon in the selected rule and has a separate running slot', () => {
    expect(source).not.toContain('.project-rail-row--active .project-rail-row__icon')
    expect(source).toContain('.project-activity')
    expect(source).toContain('.project-activity__pulse')
  })

  it('gives pinned children smaller underline-only hover and a quiet dashed relation connector', () => {
    const hover = source.match(/\.project-rail-row--pinned-child:hover,\s*\.project-rail-row--pinned-child:focus-visible\s*\{([^}]*)\}/)?.[1] ?? ''
    const connector = source.match(/\.project-rail-entry--pinned::before,\s*\.project-rail-entry--pinned::after\s*\{([^}]*)\}/)?.[1] ?? ''
    const title = source.match(/\.project-rail-row--pinned-child \.project-rail-row__identity strong\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(hover.length).toBeGreaterThan(0)
    expect(connector.length).toBeGreaterThan(0)
    expect(title.length).toBeGreaterThan(0)
    expect(hover).toContain('background: transparent')
    expect(hover).toContain('text-decoration-line: underline')
    expect(hover).not.toContain('var(--surface-2)')
    expect(connector).toContain('border-color: var(--line-soft)')
    expect(connector).toContain('border-style: dashed')
    expect(connector).toContain('pointer-events: none')
    expect(title).toContain('font-size: var(--fs-micro)')
    expect(title).toContain('font-weight: 560')
  })
})

describe('Project Rail 的分组与嵌套', () => {
  const chrome = allStyles()

  /** 分组头的标签，按出现顺序。 */
  function groupLabels(markup: string): string[] {
    return [...markup.matchAll(/class="project-rail-group__label"[^>]*>([^<]*)</g)].map(
      (match) => match[1]!
    )
  }

  /**
   * 按 aria-label **精确**取一行。不能复用上面的 `rowFor`：它允许 label 后面跟别的字符
   * （那是为了匹配 `Alpha · 2 Agents are running` 这种带状态后缀的名字），于是
   * `agentmux` 会同时命中 `agentmux-preview`——而这两个正是本节要区分的东西。
   */
  function exactRow(markup: string, name: string): string {
    const rows = [...markup.matchAll(/<button[^>]*class="[^"]*project-rail-row[^"]*"[\s\S]*?<\/button>/g)]
      .map((match) => match[0])
      .filter((row) => new RegExp(`aria-label="${name}"`).test(row))
    expect(`${name}: ${rows.length} 行`).toBe(`${name}: 1 行`)
    return rows[0]!
  }

  /** 这一行的缩进层数；没有注入就是 0（样式表里声明了默认值）。 */
  function depthOf(row: string): number {
    return Number(row.match(/--rail-depth:\s*(\d+)/)?.[1] ?? 0)
  }

  function useWorkspaces(paths: [string, string][], hostId = 'local'): void {
    fixture.state.config = {
      ...structuredClone(config),
      workspaces: [
        { id: '__scratch__', name: 'Scratch', hostId: 'local', path: '/scratch', kind: 'folder' },
        ...paths.map(([id, path]) => ({ id, name: id, hostId, path, kind: 'folder' as const }))
      ]
    }
    fixture.state.activeWorkspaceId = '__scratch__'
  }

  it('groups siblings under their shared parent directory and leaves a lone project ungrouped', () => {
    // 用户：「假设两个 projects 在同一个目录下，就在界面中显示它们的分组」。
    useWorkspaces([['agentmux', '/proj/kit/agentmux'], ['avatars', '/proj/kit/avatars'], ['solo', '/elsewhere/solo']])
    const markup = renderRail()
    // 只有一个分组头：`kit` 领着两个，`elsewhere` 只领 solo 一个所以不成组。
    expect(groupLabels(markup)).toEqual(['kit'])
    expect(exactRow(markup, 'solo')).toContain('project-rail-row')
  })

  it('indents a nested project without pushing its title onto a second line', () => {
    // 用户：「把处于子目录的 project 向前缩进，形成一个树结构」。缩进走 padding 不换行——
    // 密度合同要求项目行**一行只占一行**，缩进不能把它撑成两行。
    useWorkspaces([['outer', '/w/outer'], ['inner', '/w/outer/inner'], ['other', '/w/other']])
    const markup = renderRail()
    expect(depthOf(exactRow(markup, 'outer'))).toBe(1)
    expect(depthOf(exactRow(markup, 'inner'))).toBe(2)
    expect(depthOf(exactRow(markup, 'other'))).toBe(1)
    // 注入的自定义属性必须在样式表里有默认值，否则未注入的行整条 padding 失效。
    expect(chrome).toContain('--rail-depth: 0')
    expect(chrome).toContain('var(--rail-depth)')
  })

  it('keeps a name-prefix neighbour at the top level instead of nesting it', () => {
    // `…/agentmux-preview` 以 `…/agentmux` 开头但不在它里面。裸 startsWith 会把它错判成子节点。
    useWorkspaces([['agentmux', '/proj/agentmux'], ['agentmux-preview', '/proj/agentmux-preview']])
    const markup = renderRail()
    expect(depthOf(exactRow(markup, 'agentmux'))).toBe(1)
    expect(depthOf(exactRow(markup, 'agentmux-preview'))).toBe(1)
  })

  it('renders the group header as a disclosure control, not as a selectable project row', () => {
    // **这条断言换过方向。** 它原来钉的是「分组头不是 button」，理由是"点它没有任何东西可以被
    // 激活"。用户报告分组头与项目行读起来太像之后，那个前提不成立了：折叠是这个位置真实存在的
    // 动作（rail 上项目一多，不看的那几组该能收起来），而"它是个控件"恰恰是把它和项目行区分开
    // 的手段——区分不能靠把它做得更醒目，密度合同禁止父目录名比项目名还响。
    //
    // 所以现在它是 button 且有 aria-expanded，但仍**不是项目行**：这里两侧都判，只判前者会让
    // 一个直接复用 .project-rail-row 的实现照样绿，而那正是"太像"的极端形态。
    useWorkspaces([['one', '/proj/kit/one'], ['two', '/proj/kit/two']])
    const markup = renderRail()
    const header = markup.match(/<button[^>]*class="project-rail-group__header"[^>]*>/)?.[0] ?? ''
    expect(header, '分组头不再存在，或者不是一个 disclosure 控件').not.toBe('')
    expect(header).toContain('aria-expanded="true"')
    // 不借项目行的类：借了就连 hover 填充和选中态一起借来了，那是"又一行条目"的语言。
    expect(header).not.toContain('project-rail-row')
    expect(header).not.toContain('aria-current')
    // 完整路径仍进 tooltip——展开时它只显示最后一段，但要答得出它是哪个目录。
    expect(header).toContain('/proj/kit')
    // 可访问名不能只是一个目录名，否则分组头与项目行在读屏上才真的无从区分。
    expect(header).toMatch(/aria-label="[^"]*2 projects[^"]*"/)
  })

  /** 分组头的 `aria-expanded`，按出现顺序。 */
  function expandedStates(markup: string): string[] {
    return [
      ...markup.matchAll(/class="project-rail-group__header"[^>]*aria-expanded="(true|false)"/g)
    ].map((match) => match[1]!)
  }

  it('展开时不显示地址与角标——那两个事实此刻由下面的项目行自己带着', () => {
    // 用户要的地址是「后退的时候」才需要的。展开着还挂一条路径，就是同一个事实占两行；而每一行
    // 项目自己已经有角标了，分组头再来一个总数就是把同一批 Agent 数了两遍。
    useWorkspaces([['one', '/proj/kit/one'], ['two', '/proj/kit/two']])
    const markup = renderRail()
    expect(expandedStates(markup)).toEqual(['true'])
    expect(markup).not.toContain('project-rail-group__address')
    expect(markup).not.toContain('project-rail-group__count')
    // 展开时成员行都在。
    expect(exactRow(markup, 'one')).toContain('project-rail-row')
    expect(exactRow(markup, 'two')).toContain('project-rail-row')
  })

  it('折叠后藏掉成员行，并在头上补出地址', () => {
    // 用户：「后退的时候，是不是应该显示它的地址之类的元信息呀」。成员一藏，这一行就是那几个
    // 项目在界面上唯一的痕迹，所以它必须自己答出"这是磁盘上哪儿"。
    //
    // 父目录故意取得够深（4 段）：`/proj/kit` 那种两段路径根本不会被缩短，拿它断言"保留尾部"
    // 会得出一个与实现无关的绿——这条本来就是要判缩短方向的。
    useWorkspaces([['one', '/Users/me/proj/kit/one'], ['two', '/Users/me/proj/kit/two']])
    fixture.state.collapsedProjectGroups = { [JSON.stringify(['local', '/Users/me/proj/kit'])]: true }
    const markup = renderRail()
    expect(expandedStates(markup)).toEqual(['false'])
    // 成员行真的不在了——只把 chevron 转个方向而不藏行，是这个功能最容易的假实现。
    expect(markup).not.toMatch(/aria-label="one"/)
    expect(markup).not.toMatch(/aria-label="two"/)
    // 保留尾部而不是砍尾部：靠后的段才有分辨力，`/Users/me` 那一头对区分身份毫无帮助。
    expect(markup).toContain('…/me/proj/kit')
    expect(markup).not.toContain('/Users/me/proj/kit</span>')
  })

  it('折叠的分组把里面等你的 Agent 卷到头上——不是藏起来', () => {
    // 这条守的是一个**已经犯过一次**的错。row-attention.ts 的注释记着：项目行只显示 workspace
    // 计数时，"一个 Agent 正在里面等你"的折叠项目看起来和空闲的一模一样。分组折叠会在分组这一
    // 层原样复现那个洞，所以这里必须复用同一个 rollup。
    useWorkspaces([['one', '/proj/kit/one'], ['two', '/proj/kit/two']])
    fixture.state.collapsedProjectGroups = { [JSON.stringify(['local', '/proj/kit'])]: true }
    fixture.state.sessions = [session('s1', '/proj/kit/two', 'waiting')]
    const markup = renderRail()
    const header = markup.match(/<button[^>]*class="project-rail-group__header"[^>]*>/)?.[0] ?? ''
    expect(header, 'needs-you 被折叠吃掉了').toContain('needs you')
    expect(header).toMatch(/aria-label="[^"]*needs you[^"]*"/)
    expect(markup).toContain('Needs you')
  })

  it('跨 host 的同名父目录是两个分组，折叠一个不影响另一个', () => {
    // 折叠状态的 key 必须带 hostId。只用路径做 key 时，两台机器上同名的 `…/kit` 会被当成一个
    // 分组——折叠本机那个，远端那个跟着一起消失，而那是用户完全没要求的事。
    fixture.state.config = {
      ...structuredClone(config),
      workspaces: [
        { id: 'l1', name: 'l1', hostId: 'local', path: '/proj/kit/one', kind: 'folder' },
        { id: 'l2', name: 'l2', hostId: 'local', path: '/proj/kit/two', kind: 'folder' },
        { id: 'r1', name: 'r1', hostId: 'remote', path: '/proj/kit/three', kind: 'folder' },
        { id: 'r2', name: 'r2', hostId: 'remote', path: '/proj/kit/four', kind: 'folder' }
      ]
    }
    fixture.state.activeWorkspaceId = null
    fixture.state.collapsedProjectGroups = { [JSON.stringify(['local', '/proj/kit'])]: true }
    const markup = renderRail()
    // 两个分组头，一折一展。
    expect(expandedStates(markup).sort()).toEqual(['false', 'true'])
    // local 那组的成员藏了，remote 那组的还在。
    expect(markup).not.toMatch(/aria-label="l1"/)
    expect(markup).toMatch(/aria-label="r1"/)
  })

  it('单例分组不给折叠控件——没有分组头就没有可折叠的东西', () => {
    // 分组头只领一个成员时本来就不渲染（它说不出"这几个是一伙的"）。那种情况下若仍冒出一个
    // chevron，用户就能把一个**没有分组**的项目折叠掉，然后再也找不到它。
    useWorkspaces([['solo', '/elsewhere/solo']])
    const markup = renderRail()
    expect(markup).not.toContain('project-rail-group__header')
    expect(exactRow(markup, 'solo')).toContain('project-rail-row')
  })

  // 结构线（分组成员的竖直连接线）只挂在 `.project-rail-group--expanded` 上（chrome.css 的 ::before）。
  // 上面的用例判 aria-expanded / 地址 / 成员行 / 卷积，却没有一条钉住这个真正开关结构线的类，
  // 于是"仅展开的有名分组显示结构线；无分组和折叠无空线"是未证的。这里直接对分组容器的类断言。

  /** 取出某个分组容器 `<div class="project-rail-group ...">` 的开标签。用它内含的成员行 aria-label 定位。 */
  function groupDivFor(markup: string, memberName: string): string {
    const divs = [...markup.matchAll(/<div class="project-rail-group[^"]*"[^>]*>[\s\S]*?(?=<div class="project-rail-group|<\/nav>)/g)]
      .map((match) => match[0])
      .filter((div) => new RegExp(`aria-label="${memberName}(?:[^"]*)?"`).test(div))
    expect(`${memberName}: ${divs.length} 组`).toBe(`${memberName}: 1 组`)
    return divs[0]!
  }

  it('有名且展开的分组挂上结构线的类', () => {
    // 命名 + 展开：kit 领两个成员，其容器带 project-rail-group--expanded（结构线的唯一挂点）。
    // 去掉 WorkspaceSidebar.tsx:219 的 group.label 判断 → 无名分组也会拿到类（下一条红）；
    // 这一条正向证明命名+展开时类在场。
    useWorkspaces([['one', '/proj/kit/one'], ['two', '/proj/kit/two']])
    expect(groupDivFor(renderRail(), 'one')).toContain('project-rail-group--expanded')
  })

  it('无分组的单例不挂结构线的类——不留空线', () => {
    // solo 独占一个无名分组：容器绝不能带 project-rail-group--expanded，否则会画出一条没有成员
    // 关系的空竖线。去掉 :219 的 `group.label` → 无名分组也拿到类 → 本条红。
    useWorkspaces([['solo', '/elsewhere/solo']])
    expect(groupDivFor(renderRail(), 'solo')).not.toContain('project-rail-group--expanded')
  })

  it('折叠的有名分组不挂结构线的类——折叠态无成员亦无线', () => {
    // 折叠时成员行已藏，容器不能再带 project-rail-group--expanded 画一条悬空的线。
    // 折叠键走 SSOT 的 projectGroupKey，避免 JSON.stringify 形状在测试里另抄一份漂移。
    // 去掉 :219 的 `!collapsed` → 折叠分组仍带类/画线 → 本条红。
    useWorkspaces([['one', '/proj/kit/one'], ['two', '/proj/kit/two']])
    const key = projectGroupKey({ hostId: 'local', groupPath: '/proj/kit' })!
    fixture.state.collapsedProjectGroups = { [key]: true }
    const markup = renderRail()
    // 折叠后成员行不在，用分组头的 aria-label 定位该容器。
    const header = markup.match(/<div class="project-rail-group[^"]*"[^>]*>[\s\S]*?<\/div>/)?.[0] ?? ''
    expect(header, '分组容器缺失').not.toBe('')
    expect(header).not.toContain('project-rail-group--expanded')
  })
})

describe('Pinned Topics / Branches as child nodes in the rail', () => {
  /** 一个 pinned 子行的完整 <button>，按 aria-label 定位。断言恰好一行——「零不显示」与「显示重复」是两件事。 */
  function pinnedChildFor(markup: string, label: string): string {
    const rows = [...markup.matchAll(/<button[^>]*class="[^"]*project-rail-row--pinned-child[^"]*"[\s\S]*?<\/button>/g)]
      .map((match) => match[0])
      .filter((row) => new RegExp(`aria-label="${label}"`).test(row))
    expect(`${label}: ${rows.length} 行`).toBe(`${label}: 1 行`)
    return rows[0]!
  }

  function depthOf(row: string): number {
    return Number(row.match(/--rail-depth:\s*(\d+)/)?.[1] ?? 0)
  }

  /** Alpha 项目的 pin scope key。它是 `workspaceProjectId(workspace)`（= `[hostId, repoPath]`），
      **不是** workspace 的 id——两者只在这里分岔，手写 'project-a' 会静默地 pin 到一个不存在的 scope。 */
  const alphaScope = workspaceProjectId(config.workspaces.find((workspace) => workspace.id === 'project-a')!)
  const betaScope = workspaceProjectId(config.workspaces.find((workspace) => workspace.id === 'project-b')!)

  it('零 pin 时什么都不渲染——不留空容器、不留标题', () => {
    // 需求逐字：「Zero pinned items renders nothing at all」。守的是「零 pin 时冒出一个空容器」
    // 这个变异：把 pinnedChildRows 的 `ids.length === 0 → null` 改成返回一个空的
    // `<div class="project-rail-entry" />`，rail 的 entry 数就会从 4 涨上去，本条红。
    fixture.state.config = structuredClone(config)
    fixture.state.pinnedItems = {}
    const markup = renderRail()
    expect(markup).not.toContain('project-rail-row--pinned-child')
    // 基线：Scratch 槽 1 个 entry + 三个项目行各 1 个 = 4。空容器变异会让它变多。
    expect((markup.match(/class="project-rail-entry"/g) ?? []).length).toBe(4)
  })

  it('把 pinned Branch 挂在它自己的 Project 下，而不是 Scratch 或别的项目', () => {
    // scope 必须是 workspaceProjectId(workspace)（见 store.ts pinnedItems 的注释）：一个分支名只在
    // 其 repo 内唯一，两个项目都能有 `main`。守的是「忽略 scope、把每个 pin 都挂到 Scratch 下」
    // 这个变异——把分支侧的 pinnedChildRows(project.id, …) 改成读 SCRATCH_WORKSPACE_ID，`feat-x`
    // 就从 Alpha 下消失（Scratch scope 里没有它），本条红。
    fixture.state.config = structuredClone(config)
    fixture.state.pinnedItems = { [alphaScope]: ['feat-x'], [betaScope]: ['feat-y'] }
    const markup = renderRail()
    const child = pinnedChildFor(markup, 'feat-x')
    // 子节点比父项目行深一层：Alpha 在扁平 fixture 里是 depth 0，子节点是 1。
    expect(depthOf(child)).toBe(1)
    // 位置证明归属：feat-x 紧跟在 Alpha 之后、Beta 之前；feat-y 跟在 Beta 之后。
    const alphaAt = markup.indexOf('aria-label="Alpha"')
    const betaAt = markup.indexOf('aria-label="Beta"')
    const featXAt = markup.indexOf('aria-label="feat-x"')
    const featYAt = markup.indexOf('aria-label="feat-y"')
    expect(alphaAt).toBeLessThan(featXAt)
    expect(featXAt).toBeLessThan(betaAt)
    expect(betaAt).toBeLessThan(featYAt)
  })

  it('pinned branch titles share their parent collapse and icon slots before applying depth', () => {
    fixture.state.config = structuredClone(config)
    fixture.state.pinnedItems = { [alphaScope]: ['feat-x'] }
    const markup = renderRail()
    const child = pinnedChildFor(markup, 'feat-x')
    expect(child).toContain('class="project-rail-row__icon" aria-hidden="true"')
    const at = markup.indexOf(child)
    expect(at).toBeGreaterThan(0)
    const prefix = markup.slice(0, at)
    expect(prefix).toMatch(/<div class="project-rail-row-shell" style="--rail-depth:1"><span class="project-rail-row__collapse-spacer" aria-hidden="true"><\/span>$/)
    expect(markup).toContain('project-rail-entry--pinned')
  })

  it('把 pinned Topic 挂在 Scratch 下；快照缺失时回落到 id 而不是消失', () => {
    // 需求：pinned Topic 从 pin 列表单独就能渲染——快照没加载（SSR 下 useScratchTopics 恒返回
    // topics=null）时用 id 兜底，绝不因为「查不到标题」而让这一行消失。
    fixture.state.config = structuredClone(config)
    fixture.state.pinnedItems = { [SCRATCH_WORKSPACE_ID]: ['view:launcher-abc'] }
    const markup = renderRail()
    const child = pinnedChildFor(markup, 'view:launcher-abc')
    expect(depthOf(child)).toBe(1)
    // 挂在 Scratch 下：它出现在 Scratch 行之后、Projects 段第一行（Alpha）之前。
    const scratchAt = markup.indexOf('aria-label="Scratch"')
    const topicAt = markup.indexOf('aria-label="view:launcher-abc"')
    const alphaAt = markup.indexOf('aria-label="Alpha"')
    expect(scratchAt).toBeLessThan(topicAt)
    expect(topicAt).toBeLessThan(alphaAt)
    expect(markup).toContain('project-rail-entry--pinned')
  })

  it('不与 Scratch 行的静态 <Pin> 徽章相混——那是「此 workspace 被 pin」的另一个概念', () => {
    // 两个陷阱之一（见 review §2.7 / 任务）：Scratch 行本来就有一枚 <Pin> 徽章，含义是
    // 「这个 workspace 被 pin 了」。pinned Topic 子节点不能借用那套呈现读成同一个东西——它们走
    // --pinned-child + 更小字号，与 scratch-workspace-row__meta 里的徽章是不同的 DOM。
    fixture.state.config = structuredClone(config)
    fixture.state.pinnedItems = { [SCRATCH_WORKSPACE_ID]: ['view:launcher-abc'] }
    const markup = renderRail()
    const child = pinnedChildFor(markup, 'view:launcher-abc')
    expect(child).not.toContain('scratch-workspace-row__meta')
    expect(child).not.toContain('lucide-pin')
  })

  it('折叠的分组不泄漏成员的 pinned 子节点', () => {
    // pinned 子节点在 projectRow / Scratch 槽内部渲染，而折叠分组根本不调用 projectRow
    // （`collapsed ? null : group.nodes.map(projectRow)`）。守的是「把 pinned 子节点提到折叠守卫
    // 之外渲染」这个变异：那样折叠后 `feat` 仍会冒出来，本条红。
    fixture.state.config = {
      ...structuredClone(config),
      workspaces: [
        { id: '__scratch__', name: 'Scratch', hostId: 'local', path: '/scratch', kind: 'folder' },
        { id: 'one', name: 'one', hostId: 'local', path: '/proj/kit/one', kind: 'folder' },
        { id: 'two', name: 'two', hostId: 'local', path: '/proj/kit/two', kind: 'folder' }
      ]
    }
    fixture.state.activeWorkspaceId = '__scratch__'
    const oneScope = workspaceProjectId({ id: 'one', name: 'one', hostId: 'local', path: '/proj/kit/one', kind: 'folder' })
    fixture.state.pinnedItems = { [oneScope]: ['feat'] }

    // 展开时子节点在场。
    const expanded = renderRail()
    expect(expanded).toContain('project-rail-row--pinned-child')
    expect(expanded).toMatch(/aria-label="feat"/)

    // 折叠该分组后，成员行与它的 pinned 子节点一起消失。
    const key = projectGroupKey({ hostId: 'local', groupPath: '/proj/kit' })!
    fixture.state.collapsedProjectGroups = { [key]: true }
    const collapsed = renderRail()
    expect(collapsed).not.toMatch(/aria-label="one"/)
    expect(collapsed).not.toMatch(/aria-label="feat"/)
    expect(collapsed).not.toContain('project-rail-row--pinned-child')
  })
})
