import { createElement } from 'react'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionSnapshot } from '../src/shared/contracts.js'
import type { LinkClickModifiers } from '../src/renderer/src/components/AgentMarkdown.js'
import type { OpenDestination, OpenHttpLinkOrigin } from '../src/renderer/src/lib/open-destination.js'

// The conversation's http links must reach the SAME destination menu + Store exit the Terminal uses,
// opening into this pane's Region — never a jump straight to the system browser. This harness has no DOM
// and cannot click, so we capture the click handler SessionPane hands to ActivityView and the props it
// hands to OpenDestinationPopover, then drive them by hand and assert on the Store call that results.
const captured = vi.hoisted(() => ({
  onProseLinkClick: null as ((url: string, event: LinkClickModifiers) => void) | null,
  onMenuSelect: null as ((destination: OpenDestination) => void) | null,
  menuCanSplit: null as boolean | null,
  menuRequest: null as { id: number; url: string; x: number; y: number } | null,
  openHttpLink: vi.fn(async (_origin: OpenHttpLinkOrigin, _url: string, _dest: OpenDestination) => {})
}))

const fixture = vi.hoisted(() => ({
  state: {
    sessions: [] as SessionSnapshot[],
    timelines: {} as Record<string, { items: never[] }>,
    // `workspaces` is required on the real config, and the pane reads it to resolve file references
    // in agent prose the same way the terminal does. An empty list is the honest "no active
    // workspace" case: absolute paths then resolve to nothing rather than to a guess.
    config: { appearance: { terminalTheme: 'graphite' }, workspaces: [] },
    activeWorkspaceId: undefined as string | undefined,
    viewModes: {} as Record<string, 'terminal' | 'activity'>,
    refreshSession: vi.fn(async () => {}),
    recoverSession: vi.fn(async () => {}),
    respondInteraction: vi.fn(async () => {}),
    openFile: vi.fn(async () => {}),
    openHttpLink: captured.openHttpLink,
    reportError: vi.fn()
  }
}))

vi.mock('../src/renderer/src/store.js', () => ({
  useAppStore: (selector: (state: typeof fixture.state) => unknown) => selector(fixture.state)
}))
vi.mock('../src/renderer/src/components/TerminalView.js', () => ({
  TerminalView: () => <div data-test-view="terminal" />
}))
vi.mock('../src/renderer/src/components/ActivityView.js', () => ({
  // displayState 透传出来断言：判定再对，Pane 不把它交出去，整个「在进行」指示就是死的，
  // 而且所有只测判定的用例仍会绿。这条把那个静默失效变成可见的红。
  // openHttpLink 也俘获出来：这是对话链接点击的唯一出口，SessionPane 不交出去就等于没接线。
  ActivityView: ({ displayState, openHttpLink }: {
    displayState?: string
    openHttpLink?: (url: string, event: LinkClickModifiers) => void
  }) => {
    captured.onProseLinkClick = openHttpLink ?? null
    return <div data-test-view="activity" data-display-state={displayState ?? 'absent'} />
  }
}))
vi.mock('../src/renderer/src/components/OpenDestinationBar.js', () => ({
  // 俘获 canSplit 与 request：canSplit 必须如实反映 origin 有没有精确 pane，request 有值才代表浮窗浮出。
  OpenDestinationPopover: ({ request, canSplit, onSelect }: {
    request: { id: number; url: string; x: number; y: number } | null
    canSplit: boolean
    onSelect(destination: OpenDestination): void
  }) => {
    captured.menuCanSplit = canSplit
    captured.menuRequest = request
    captured.onMenuSelect = onSelect
    return request ? <div data-test-menu="open" data-can-split={String(canSplit)} /> : null
  }
}))
vi.mock('../src/renderer/src/components/AgentSessionComposer.js', () => ({
  AgentSessionComposer: ({ disabled }: { disabled?: boolean }) => (
    <div data-test-agent-composer={disabled ? 'disabled' : 'enabled'} />
  )
}))
vi.mock('../src/renderer/src/components/AgentInteractionCard.js', () => ({
  AgentInteractionCard: ({ disabled }: { disabled?: boolean }) => (
    <div data-test-interaction-card={disabled ? 'disabled' : 'enabled'} />
  )
}))

import { SessionPane } from '../src/renderer/src/components/SessionPane.js'

function session(kind: 'agent' | 'terminal'): SessionSnapshot {
  const common = {
    id: `${kind}-1`,
    hostId: 'local',
    workspacePath: '/repo',
    label: kind === 'agent' ? 'Codex' : 'Terminal',
    createdAt: 1,
    updatedAt: 1,
    processState: 'running' as const,
    status: { state: 'running' as const, source: 'run-process' as const, observedAt: 1 },
    latestOutputBytes: 0
  }
  return kind === 'agent'
    ? {
        ...common,
        kind: 'agent',
        providerId: 'codex',
        executorId: 'codex',
        capabilities: {
          terminal: true,
          hookEvents: true,
          timeline: 'complete-events',
          permission: 'observe',
          providerResume: true,
          acp: false,
          replyCorrelation: 'none'
        },
        control: { kind: 'agent', hostId: 'local', agentSessionId: 'agent-1', run: { runId: 'run-1' } }
      }
    : {
        ...common,
        kind: 'terminal',
        providerId: null,
        control: { kind: 'terminal', hostId: 'local', runId: 'terminal-1', run: { runId: 'terminal-1' } }
      }
}

function render(
  sessionId: string,
  surfaceKind: 'agent' | 'terminal',
  parked = false,
  linkOrigin: OpenHttpLinkOrigin = { workspaceId: 'workspace-1', tabGroupId: 'group-1' }
): string {
  return renderToStaticMarkup(createElement(SessionPane, {
    sessionId,
    surfaceKind,
    interactiveResize: false,
    visible: true,
    parked,
    // Required props the pane really takes. They were omitted while nothing read them; the file
    // references in agent prose open into this Tab Group, exactly as a terminal path click does.
    linkOrigin
  }))
}

afterEach(() => {
  fixture.state.sessions = []
  fixture.state.viewModes = {}
  captured.onProseLinkClick = null
  captured.onMenuSelect = null
  captured.menuCanSplit = null
  captured.menuRequest = null
  captured.openHttpLink.mockClear()
})

describe('SessionPane Agent Composer ownership', () => {
  it('shows the Composer with an Agent Terminal projection', () => {
    fixture.state.sessions = [session('agent')]
    fixture.state.viewModes = { 'agent-1': 'terminal' }

    const markup = render('agent-1', 'agent')

    expect(markup).toContain('data-test-view="terminal"')
    expect(markup).toContain('data-test-agent-composer="enabled"')
  })

  it('shows the same Composer slot with an Agent Activity projection', () => {
    fixture.state.sessions = [session('agent')]
    fixture.state.viewModes = { 'agent-1': 'activity' }

    const markup = render('agent-1', 'agent')

    expect(markup).toContain('data-test-view="activity"')
    expect(markup).toContain('data-test-agent-composer="enabled"')
  })

  it('把 Session 的显示状态交给 Activity——不交出去，「在进行」指示就是死的', () => {
    // 「这个 turn 在不在工作」的唯一真相在 Session 上，Activity 自己推不出来。删掉 Pane 上那行
    // displayState，判定层的测试全都还是绿的，只有这条会红。
    fixture.state.sessions = [session('agent')]
    fixture.state.viewModes = { 'agent-1': 'activity' }

    const markup = render('agent-1', 'agent')

    expect(markup).toContain('data-display-state="running"')
    expect(markup).not.toContain('data-display-state="absent"')
  })

  it('never adds an Agent Composer to Raw Terminal', () => {
    fixture.state.sessions = [session('terminal')]

    const markup = render('terminal-1', 'terminal')

    expect(markup).toContain('data-test-view="terminal"')
    expect(markup).not.toContain('data-test-agent-composer')
  })

  it('keeps a disabled Composer on a launching Agent Region', () => {
    const markup = render('agent-launching', 'agent')

    expect(markup).toContain('Connecting to this session')
    expect(markup).toContain('data-test-agent-composer="disabled"')
  })

  it('goes inert on a pending request whose Agent process is gone', () => {
    // A pending request outlives the process that asked it. If the card stayed live the user could
    // answer a Run that can no longer accept input, and the answer would fail on a dead Run.
    const dead = session('agent')
    fixture.state.sessions = [{
      ...dead,
      processState: 'exited',
      status: { state: 'exited', source: 'run-process', observedAt: 2 },
      pendingInteraction: {
        kind: 'permission',
        requestId: 'req-1',
        title: 'Allow shell?',
        options: [{ id: 'allow-once', label: 'Allow once', kind: 'allow-once' }]
      }
    } as SessionSnapshot]
    fixture.state.viewModes = { 'agent-1': 'terminal' }

    const markup = render('agent-1', 'agent')

    expect(markup).toContain('data-test-interaction-card="disabled"')
  })

  it('keeps a pending request answerable while its Agent process runs', () => {
    const live = session('agent')
    fixture.state.sessions = [{
      ...live,
      pendingInteraction: {
        kind: 'permission',
        requestId: 'req-1',
        title: 'Allow shell?',
        options: [{ id: 'allow-once', label: 'Allow once', kind: 'allow-once' }]
      }
    } as SessionSnapshot]
    fixture.state.viewModes = { 'agent-1': 'terminal' }

    const markup = render('agent-1', 'agent')

    expect(markup).toContain('data-test-interaction-card="enabled"')
  })

  it('cold-parks only the terminal view while retaining the Agent composer', () => {
    fixture.state.sessions = [session('agent')]
    fixture.state.viewModes = { 'agent-1': 'terminal' }

    const markup = render('agent-1', 'agent', true)

    expect(markup).toContain('Terminal parked')
    expect(markup).not.toContain('data-test-view="terminal"')
    expect(markup).toContain('data-test-agent-composer="enabled"')
  })

  it('tells apart the reasons an Agent could not resume, instead of one dead button', () => {
    // Two sessions that used to render identically: both said "Resume unavailable" on a disabled
    // button. One is permanent (this Provider has no resume at all), the other is temporary (the
    // Provider is just missing here). Collapsing them hides the only thing the user can act on.
    function renderWithReason(reason: string, retryable: boolean): string {
      const dead = session('agent')
      fixture.state.sessions = [{
        ...dead,
        processState: 'interrupted',
        status: {
          state: 'error',
          source: 'run-process',
          observedAt: 2,
          continuity: 'unavailable',
          continuityReason: reason
        }
      } as SessionSnapshot]
      fixture.state.viewModes = { 'agent-1': 'terminal' }
      const markup = render('agent-1', 'agent')
      // The retryable one must offer a live button; the permanent one must not pretend it can retry.
      expect(markup).toContain(retryable ? 'Try resuming again' : 'Start a new Agent')
      return markup
    }

    const permanent = renderWithReason('provider-resume-unsupported', false)
    const temporary = renderWithReason('provider-unavailable', true)

    expect(permanent).not.toBe(temporary)
    expect(permanent).not.toContain('Resume unavailable')
  })

  it('says a conflict is held by someone else, not lost', () => {
    const held = session('agent')
    fixture.state.sessions = [{
      ...held,
      processState: 'interrupted',
      status: {
        state: 'error',
        source: 'run-process',
        observedAt: 2,
        continuity: 'conflict'
      }
    } as SessionSnapshot]
    fixture.state.viewModes = { 'agent-1': 'terminal' }

    const markup = render('agent-1', 'agent')

    expect(markup).toContain('another operation')
    expect(markup).toContain('Resolve conflict first')
  })

  // f-23r8fq5nw / T-012：退出横幅要能说清「是你关的还是它崩的」。三种 exitReason 必须给出彼此不同的
  // 文案；把 humanizeDetail 的 exitReason 分支剪断（退回统一那句「The process is no longer running.」）
  // 时，下面 not-same 与 unknown 的诚实措辞断言一起变红。
  it('tells a user stop apart from a crash apart from an undetermined exit', () => {
    function renderExit(exitReason: 'user-stopped' | 'crashed' | 'unknown'): string {
      const dead = session('agent')
      fixture.state.sessions = [{
        ...dead,
        processState: 'exited',
        status: { state: 'exited', source: 'run-process', observedAt: 2, exitReason }
      } as SessionSnapshot]
      fixture.state.viewModes = { 'agent-1': 'terminal' }
      return render('agent-1', 'agent')
    }

    const userStopped = renderExit('user-stopped')
    const crashed = renderExit('crashed')
    const unknown = renderExit('unknown')

    // 我关的：明说是用户停止。
    expect(userStopped).toContain('You stopped this session')
    // 它崩的：明说是进程自退，绝不与「你关的」同文案。
    expect(crashed).toContain('exited on its own')
    // 读不出结论：诚实说未知，绝不冒充干净完成。
    expect(unknown).toContain('could not be determined')

    // 三者两两不同——合成一句就等于没做。
    expect(userStopped).not.toBe(crashed)
    expect(crashed).not.toBe(unknown)
    expect(userStopped).not.toBe(unknown)
  })
})

describe('SessionPane 对话链接的浮窗出口', () => {
  function renderAgentActivity(linkOrigin?: OpenHttpLinkOrigin): string {
    fixture.state.sessions = [session('agent')]
    fixture.state.viewModes = { 'agent-1': 'activity' }
    return linkOrigin
      ? render('agent-1', 'agent', false, linkOrigin)
      : render('agent-1', 'agent')
  }

  const FULL_ORIGIN: OpenHttpLinkOrigin = {
    workspaceId: 'workspace-1',
    tabGroupId: 'group-1',
    tabId: 'tab-1',
    regionId: 'region-1'
  }

  it('把点击出口交给 Activity——不交，对话里的链接就点了没反应', () => {
    // 这是接线本身：SessionPane 必须把 onProseLinkClick 交给 ActivityView。不交出去，链接点击无处可去。
    renderAgentActivity(FULL_ORIGIN)
    expect(captured.onProseLinkClick).toBeTypeOf('function')
  })

  it('普通点击浮出菜单、不直接开系统浏览器；带 Cmd/Ctrl 才直开——共用终端那套修饰键判定', () => {
    // 尺子三：修饰键直开的判定必须在。删掉它（让 Cmd/Ctrl 也走菜单），普通点击那半段仍绿，
    // 但「带修饰键必须立刻 openHttpLink('system')」这半段会红。
    renderAgentActivity(FULL_ORIGIN)
    const click = captured.onProseLinkClick!

    // 普通点击：不立刻调 openHttpLink（改为浮出菜单，等用户选目标）。
    click('https://example.com/a', { metaKey: false, ctrlKey: false, clientX: 5, clientY: 6 })
    expect(captured.openHttpLink).not.toHaveBeenCalled()

    // Cmd+click（本机 navigator.userAgent 为 'Node.js/24'，isMac=false，所以用 Ctrl 命中）：立刻直开系统浏览器。
    click('https://example.com/b', { metaKey: false, ctrlKey: true, clientX: 7, clientY: 8 })
    expect(captured.openHttpLink).toHaveBeenCalledTimes(1)
    expect(captured.openHttpLink).toHaveBeenCalledWith(FULL_ORIGIN, 'https://example.com/b', 'system')
  })

  it('选中某个目标后，openHttpLink 收到的正是那个 destination——源码接线断言', () => {
    // 尺子一的另一面：菜单选择必须把用户挑的 destination 与当前 request 的 URL 一起原样送进 openHttpLink。
    // 本仓库的 renderToStaticMarkup 不重渲染，无法在“菜单已浮出(request 非空)”的那一帧驱动 onSelect，
    // 故按仓内既有约定（topic-rename）改为源码接线断言：防的是把 destination 写死、或丢掉 request.url。
    const source = readFileSync(
      new URL('../src/renderer/src/components/SessionPane.tsx', import.meta.url),
      'utf8'
    )
    const select = source.slice(
      source.indexOf('const onProseLinkSelect'),
      source.indexOf('const [refreshing')
    )
    // destination 必须原样透传（不是写死的 'system'/'tab'），URL 必须取自当前 request。
    expect(select).toContain('openHttpLink(linkOrigin, request.url, destination)')
    // 选完要消掉当前 request，避免菜单赖着不走。
    expect(select).toContain('dismissOpenDestinationRequest(current, request.id)')
  })

  it('canSplit 如实反映 origin：有精确 Tab+Region 才为真', () => {
    // 尺子二：canSplit 谎报会让用户点了分屏项后撞上 Store 那个抛错。它必须等于 Boolean(tabId && regionId)。
    // 把 SessionPane 里的 canSplit 改成恒 true，这条的「缺 pane 时为 false」断言会红。
    // 用一次普通点击把 request 立起来，让菜单真的渲染，从而俘获 canSplit——但静态渲染只跑一次，
    // 无法在 setState 后重渲染。所以改为断言 SessionPane 传给菜单的 canSplit 初值（request 为 null 时也会算）。
    renderAgentActivity(FULL_ORIGIN)
    expect(captured.menuCanSplit).toBe(true)

    renderAgentActivity({ workspaceId: 'workspace-1', tabGroupId: 'group-1' })
    expect(captured.menuCanSplit).toBe(false)
  })
})
