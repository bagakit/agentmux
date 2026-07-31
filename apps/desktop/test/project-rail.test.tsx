import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppConfig, SessionSnapshot } from '../src/shared/contracts.js'
import { workingAgentCount } from '../src/renderer/src/lib/project-board.js'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

const fixture = vi.hoisted(() => ({
  state: {
    config: null as AppConfig | null,
    sessions: [] as SessionSnapshot[],
    activeWorkspaceId: 'project-a',
    mainSurface: 'workbench' as const,
    projectRailOpen: true,
    toolsOpen: false,
    selectWorkspace: vi.fn(async () => {}),
    setMainSurface: vi.fn(),
    setConfig: vi.fn(),
    toggleProjectRail: vi.fn(),
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
  version: 7,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: {},
  workspaces: [
    { id: '__scratch__', name: 'Scratch', hostId: 'local', path: '/scratch', kind: 'folder' },
    { id: 'project-a', name: 'Alpha', hostId: 'local', path: '/alpha', kind: 'folder' },
    { id: 'project-b', name: 'Beta', hostId: 'local', path: '/beta', kind: 'folder' },
    { id: 'project-c', name: 'Gamma', hostId: 'local', path: '/gamma', kind: 'folder' }
  ],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, more: true } }
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
      hookEvents: true,
      timeline: 'streaming',
      permission: 'observe',
      providerResume: true,
      acp: false,
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
    expect(markup).toContain('class="project-rail-row__activity status status--working"')
    expect(markup).toContain('Alpha · 1 Agent is running')
    expect(markup).toContain('Beta · 1 Agent is running')
    expect(markup).not.toContain('Gamma · 1 Agent is running')
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
    expect(markup).toContain('Alpha · 1 Agent is running')

    fixture.state.sessions = []
    fixture.state.activeWorkspaceId = 'project-a'
    markup = renderRail()
    expect(markup.match(/data-running="true"/g) ?? []).toHaveLength(0)
    expect(markup).toContain('project-rail-row--active')
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
    expect(regularRows.every((row) => !row.includes('project-rail-row__icon'))).toBe(true)
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
    expect(badgeOf(alpha)).toBe('2')
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
    expect(badgeOf(rowFor(markup, 'Beta'))).toBe('1')
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
    expect(gamma).toContain('data-attention="needs-you"')
    expect(badgeOf(gamma)).toBe('1')
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
    const identity = readFileSync(
      new URL('../src/renderer/src/styles/chrome.css', import.meta.url),
      'utf8'
    ).match(/\.project-rail-row__identity\s*\{([^}]*)\}/)?.[1] ?? ''
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
})

describe('Project Rail style contract', () => {
  const source = readFileSync(
    new URL('../src/renderer/src/styles/chrome.css', import.meta.url),
    'utf8'
  )

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
    expect(source).toContain('.project-rail-row__activity')
    expect(source).toContain('.project-rail-row__activity .status__dot')
  })
})

describe('Project Rail 的分组与嵌套', () => {
  const chrome = readFileSync(
    new URL('../src/renderer/src/styles/chrome.css', import.meta.url),
    'utf8'
  )

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
    expect(depthOf(exactRow(markup, 'outer'))).toBe(0)
    expect(depthOf(exactRow(markup, 'inner'))).toBe(1)
    expect(depthOf(exactRow(markup, 'other'))).toBe(0)
    // 注入的自定义属性必须在样式表里有默认值，否则未注入的行整条 padding 失效。
    expect(chrome).toContain('--rail-depth: 0')
    expect(chrome).toContain('var(--rail-depth)')
  })

  it('keeps a name-prefix neighbour at the top level instead of nesting it', () => {
    // `…/agentmux-preview` 以 `…/agentmux` 开头但不在它里面。裸 startsWith 会把它错判成子节点。
    useWorkspaces([['agentmux', '/proj/agentmux'], ['agentmux-preview', '/proj/agentmux-preview']])
    const markup = renderRail()
    expect(depthOf(exactRow(markup, 'agentmux'))).toBe(0)
    expect(depthOf(exactRow(markup, 'agentmux-preview'))).toBe(0)
  })

  it('renders the group header as a label, not as a selectable row', () => {
    // 分组头不是 Project：点它没有任何东西可以被激活，所以它不能是 button，也不该有选中态。
    useWorkspaces([['one', '/proj/kit/one'], ['two', '/proj/kit/two']])
    const markup = renderRail()
    const header = markup.match(/<[a-z]+[^>]*class="project-rail-group__label"[^>]*>/)?.[0] ?? ''
    expect(header).not.toBe('')
    expect(header.startsWith('<button')).toBe(false)
    expect(header).not.toContain('aria-current')
    expect(header).not.toContain('project-rail-row__count')
    // 完整路径进 tooltip——分组头只显示最后一段，但要答得出它是哪个目录。
    expect(header).toContain('title="/proj/kit"')
  })
})
