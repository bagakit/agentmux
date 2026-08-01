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
import {
  CONNECTION_LOST_DETAIL,
  CONNECTION_UNRECOVERABLE_DETAIL
} from '../src/renderer/src/lib/session-state.js'

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
          timeline: 'complete-events',
          permission: 'observe',
          providerResume: true,
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

  // conflict 曾经只有一条文案（"另一个操作占着，先解决冲突"）。它对两类中的一类是错的，所以那条
  // 断言随实现一起废掉了——两类各自的渲染断言见下面 'SessionPane 把两类 conflict 渲染成两件不同的事'。
  // 这里只留「Core 一个类别都没给」这一格：它必须如实说分不清，且不许冒用任何一类的措辞。
  it('says a conflict of unknown class is a claim, without guessing which kind', () => {
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

    expect(markup).toContain('Cannot tell what claimed this Agent')
    expect(markup).toContain('did not report which kind of claim')
    // 而且不许长得像「另一个操作正在用」那一类：那一类要求「等」，这一格要求「重读」。
    // 同一句话要求两件相反的事，正是这条轴要消灭的东西。
    expect(markup).not.toContain('Another operation is using this Agent')
    expect(markup).not.toContain('Waiting for that operation')
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

// conflict 有两类，它们**要求用户做的事相反**：一条 Run 已被换掉（等不回来，该重读），另一条是
// 某个生命周期操作此刻占着（真的会回来，该等）。判定层的测试守的是判定；这一组守的是**这一格真的
// 渲染出了那一类的字，并且按钮的可按性跟着那一类走**——判定再对，Pane 把两类渲染成同一句话，
// 用户还是不知道该干什么，而只测判定的用例全都还是绿的。
describe('SessionPane 把两类 conflict 渲染成两件不同的事', () => {
  function conflicted(conflict: 'session-run-changed' | 'lifecycle-busy' | undefined): SessionSnapshot {
    // 恢复横幅只在进程真的没了的时候出现（processState interrupted + status error），
    // 这正是 conflict 抵达界面时的形状。
    return {
      ...session('agent'),
      processState: 'interrupted',
      status: {
        state: 'error',
        source: 'run-process',
        observedAt: 2,
        continuity: 'conflict',
        ...(conflict ? { continuityConflict: conflict } : {})
      }
    } as SessionSnapshot
  }

  it('Run 已被换掉时，让用户重读，而不是干等一个回不来的 Run', () => {
    fixture.state.sessions = [conflicted('session-run-changed')]
    fixture.state.viewModes = { 'agent-1': 'terminal' }

    const markup = render('agent-1', 'agent')

    expect(markup).toContain('already moved to a newer Run')
    expect(markup).toContain('Re-read this Agent')
    // 这一类**按得动**：重读是真能做到的事。禁用它等于把人钉在一个过期视图上。
    expect(markup).not.toContain('disabled=""')
    // 而且绝不能再说「等」——那是修好前的错建议。
    expect(markup).not.toContain('Waiting for that operation')
  })

  it('另一个操作占着时，说等，并且不给一个按了也没用的按钮', () => {
    fixture.state.sessions = [conflicted('lifecycle-busy')]
    fixture.state.viewModes = { 'agent-1': 'terminal' }

    const markup = render('agent-1', 'agent')

    expect(markup).toContain('Another operation is using this Agent')
    expect(markup).toContain('Waiting for that operation')
    // 「等」这一类没有能按的动作：按下去不会让那个操作提前结束，所以按钮必须是禁用的。
    expect(markup).toContain('disabled=""')
    expect(markup).not.toContain('newer Run')
  })

  it('两类渲染出的字必须不同——折回同一句话时这条红', () => {
    // 这是验收判据本身。上面两条各自钉住一类的字面，这条钉住「它们不是同一份字」，
    // 于是任何把两类合并回一条文案的改动都躲不过去。
    fixture.state.sessions = [conflicted('session-run-changed')]
    fixture.state.viewModes = { 'agent-1': 'terminal' }
    const stale = render('agent-1', 'agent')

    fixture.state.sessions = [conflicted('lifecycle-busy')]
    const busy = render('agent-1', 'agent')

    expect(stale).not.toBe(busy)
  })

  it('Core 没给类别时，如实说不知道，并且仍给一条做得到的出路', () => {
    fixture.state.sessions = [conflicted(undefined)]
    fixture.state.viewModes = { 'agent-1': 'terminal' }

    const markup = render('agent-1', 'agent')

    expect(markup).toContain('did not report which kind of claim')
    // 分不清的时候也不许把人钉住：重读永远是安全动作（它不抢占，只重读快照）。
    expect(markup).toContain('Re-read this Agent')
  })

  it('「重读」走的是 refresh 而不是再 resume 一次——源码接线断言', () => {
    // 本仓无 DOM，点不动 onClick，故按仓内既有约定（上面 onProseLinkSelect 那条）落到源码。
    // 防的是把 refresh 那一类接到 recover()：这条 Agent 已经活在一个更新的 Run 上，再 resume
    // 就是**第二次抢占**，比不给按钮更糟。这一条与上面「按得动」合起来才完整：那条证明按钮活着，
    // 这条证明它按下去走的是对的那条通路。
    const source = readFileSync(
      new URL('../src/renderer/src/components/SessionPane.tsx', import.meta.url),
      'utf8'
    )
    const button = source.slice(
      source.indexOf('continuityNotice ? ('),
      source.indexOf('</button>', source.indexOf('continuityNotice ? ('))
    )

    // refresh 判据在前、且落在 refresh()；retry 判据落在 recover()。两者不许互换。
    expect(button).toContain('continuityRefreshEnabled(continuityNotice)\n                          ? () => void refresh()')
    expect(button).toContain('continuityRetryEnabled(continuityNotice)\n                            ? () => void recover()')
    // 两个判据都要参与 disabled，否则其中一类的按钮会是死的。
    expect(button).toContain('continuityRetryEnabled(continuityNotice) || continuityRefreshEnabled(continuityNotice)')
  })
})

/**
 * 失联的两类必须在标题上分家：还在重连 vs 已经放弃。
 *
 * 这不是文案洁癖。抖动预算用尽后 Core 发 `unrecoverable`，渲染端把 Agent 置成 `disconnected`
 * ——与短暂 `lost` 同一个状态位。只认状态位的话，终局会顶着「Remote terminal disconnected /
 * Reconnecting…」的皮：用户以为等一会儿就好，而实际上没有任何东西还在重试。区分它们的判据是
 * `status.detail`（连接投影写下的那一对 SSOT 常量）。
 *
 * 这个横幅在 SSR 下就渲染（不依赖任何 useState 展开），所以能真断言渲染结果而不是源码文本。
 */
describe('SessionPane 失联横幅区分「重连中」与「已放弃」', () => {
  afterEach(() => { fixture.state.sessions = [] })

  function disconnectedAgent(detail: string): SessionSnapshot {
    const base = session('agent')
    return {
      ...base,
      status: { state: 'disconnected', source: 'run-process', observedAt: 9, detail }
    }
  }

  it('重连中：标题说断开、正文说进程还在跑', () => {
    fixture.state.sessions = [disconnectedAgent(CONNECTION_LOST_DETAIL)]
    const markup = render('agent-1', 'agent')

    expect(markup).toContain('Remote terminal disconnected')
    expect(markup).not.toContain('Can’t reach this host')
    // 正文必须真的把那条 detail 交出去，否则用户拿不到「进程还在跑」这个关键事实。
    expect(markup).toContain('only this window')
  })

  it('已放弃：标题改口说连不上，且正文指向手动恢复', () => {
    // 把 SessionPane 里那个 gaveUpReconnecting 判据删掉（或让它恒 false），本条红——那正是
    // 「终局伪装成暂时」的形状。
    fixture.state.sessions = [disconnectedAgent(CONNECTION_UNRECOVERABLE_DETAIL)]
    const markup = render('agent-1', 'agent')

    expect(markup).toContain('Can’t reach this host')
    // 且绝不能同时挂着「重连中」那套说法。
    expect(markup).not.toContain('Remote terminal disconnected')
    expect(markup).toContain('Resume')
  })

  it('两类渲染出的标题确实不同——判据不是恒真也不是恒假', () => {
    // 单独一条各自断言时，把判据写成恒 true 或恒 false 都只会打红其中一条；这条把两次渲染放在
    // 一起比，任何「两类都走同一分支」的写法都会红。
    fixture.state.sessions = [disconnectedAgent(CONNECTION_LOST_DETAIL)]
    const reconnecting = render('agent-1', 'agent')
    fixture.state.sessions = [disconnectedAgent(CONNECTION_UNRECOVERABLE_DETAIL)]
    const gaveUp = render('agent-1', 'agent')

    expect(reconnecting).not.toBe(gaveUp)
  })
})
