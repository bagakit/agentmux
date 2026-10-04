import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { createRequire } from 'node:module'
import { act, useMemo } from 'react'
import { createRoot } from 'react-dom/client'
import { useObservedAppStore } from '../src/renderer/src/lib/use-observed-app-store'
import { expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { ComposerResubmitGuard, RESUBMIT_WINDOW_MS } from '../src/renderer/src/lib/composer-resubmit-guard'
import { SessionPane } from '../src/renderer/src/components/SessionPane'
import { WorkspaceWorkbench } from '../src/renderer/src/components/WorkspaceWorkbench'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { rendererPerformance } from '../src/renderer/src/lib/renderer-performance'
import * as topics from '../src/renderer/src/lib/scratch-topic-snapshots'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { composerDOM, composerSession, composerConfig } from './helpers/composer-dom-fixture'

vi.mock('react-resizable-panels', () => createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js'))
// Only PTY painting is outside this test; the production Pane, Composer, rich editor and Store remain mounted.
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: ({ autoFocus }: { autoFocus?: boolean }) => <div data-pty-paint data-pane-autofocus={String(autoFocus)} /> }))
const dom = composerDOM()
const browser = { id: 'browser', browserId: 'browser', kind: 'browser' as const,
  regionId: 'browser-region', workspaceId: 'workspace', navigationId: 'navigation',
  url: 'https://example.test/original', title: 'Original', profileId: 'profile',
  driving: false, appLinkPrompt: null, loading: false, canGoBack: false, canGoForward: false,
  viewport: 'responsive' as const, error: null }
async function unrelatedUpdates() {
  for (let index = 0; index < 8; index++) {
    await act(async () => useAppStore.getState().applyEvent({ type: 'core', hostId: 'local', event: {
      type: 'agent-status', agentSessionId: 'unrelated', state: 'working', evidence: { source: 'native-hook', observedAt: Date.now() + index }
    } }))
    await act(async () => useAppStore.getState().applyBrowserEvent({ type: 'updated', browser: {
      ...browser, navigationId: `navigation-${index}`, title: `Page ${index}`, url: `https://example.test/${index}`, loading: index % 2 === 0
    } }))
    await act(async () => useAppStore.setState({ mainSurface: 'board', activeWorkspaceId: 'other', workbenchNavigationInputPolicy: 'target' }))
    await act(async () => useAppStore.setState({ mainSurface: 'workbench', activeWorkspaceId: 'workspace', workbenchNavigationInputPolicy: null }))
    await act(async () => useAppStore.setState(state => ({
      agentNames: { ...state.agentNames, unrelated: `Name ${index}` },
      agentComposerDrafts: { ...state.agentComposerDrafts, unrelated: `Draft ${index}` },
      timelines: { ...state.timelines, unrelated: { agentSessionId: 'unrelated', revision: index, items: [] } }
    })))
  }
}
function checks() {
  const snapshot = rendererPerformance.snapshot().consumers
  return { pane: snapshot.sessionPane.hidden.checks, composer: snapshot.composer.hidden.checks,
    commits: snapshot.sessionPane.hidden.commits + snapshot.composer.hidden.commits }
}

for (const count of [1, 32, 100]) it(`production mounted ${count} retained Pane/Composer pairs admit related facts and skip unrelated notifications`, async () => {
  const ids = Array.from({ length: count }, (_, n) => `retained-${n}`)
  const browserTab = createWorkbenchTab('browser-tab', browser)
  useAppStore.setState({ sessions: [...ids.map(id => composerSession(id)), composerSession('unrelated')],
    agentComposerDrafts: Object.fromEntries(ids.map(id => [id, `Draft ${id}`])),
    viewModes: Object.fromEntries(ids.map(id => [id, 'terminal' as const])), tabs: { [browserTab.id]: browserTab },
    timelines: {}, recoveryCandidates: [], pendingAgentLaunches: {}, scratchTopicSnapshots: {} })
  const scene = (reveal: boolean) => <>{ids.map((id, n) => <SessionPane key={id} sessionId={id} surfaceKind="agent"
    interactiveResize={false} visible={reveal && n === 0} linkOrigin={{ workspaceId: 'workspace' }} />)}</>
  await dom.render(scene(false))
  const editors = [...dom.container.querySelectorAll<HTMLElement>('.ProseMirror')]
  expect(editors).toHaveLength(count)
  expect(editors[0]!.textContent).toBe('Draft retained-0')
  const before = checks()
  await unrelatedUpdates()
  expect(checks()).toEqual(before)
  expect(useAppStore.getState().sessions.find(session => session.id === 'unrelated')?.status.state).toBe('working')
  expect(useAppStore.getState().tabs['browser-tab']?.regions['browser-region']).toMatchObject({ title: 'Page 7', loading: false })
  await act(async () => useAppStore.getState().setAgentComposerDraft(ids[0]!, 'Fresh hidden draft'))
  expect(dom.container.querySelector('.ProseMirror')).toBe(editors[0])
  expect(editors[0]!.textContent).toBe('Fresh hidden draft')
  expect(checks().composer).toBeGreaterThan(before.composer)
  // Hidden capability changes remain live; visibility is never a blanket state freeze.
  await act(async () => useAppStore.getState().applyEvent({ type: 'core', hostId: 'local', event: {
    type: 'agent-status', agentSessionId: ids[0]!, state: 'working', evidence: { source: 'native-hook', observedAt: Date.now() + 100 }
  } }))
  expect(dom.container.querySelector('button[aria-label="Interrupt the current turn"]')).not.toBeNull()
  await act(async () => useAppStore.setState(state => ({ agentNames: { ...state.agentNames, [ids[0]!]: 'Fresh identity' } })))
  expect(dom.container.textContent).toContain('Fresh identity')
  await dom.render(scene(true))
  expect(dom.container.querySelector('.ProseMirror')).toBe(editors[0])
  expect(editors[0]!.textContent).toBe('Fresh hidden draft')
  expect(useAppStore.getState().sessions.find(session => session.id === ids[0])?.control.run.runId).toBe('run-retained-0')
  expect([...dom.container.querySelectorAll('.ProseMirror')]).toEqual(editors)
})

it('the mounted Workbench uses its cheap-facts mode cache and preserves invalidation', async () => {
  const ids = Array.from({ length: 32 }, (_, n) => `workbench-${n}`)
  const tabs = Object.fromEntries(ids.map((id, n) => {
    const tab = createWorkbenchTab(`tab-${n}`, { kind: 'agent', phase: 'attached', regionId: `region-${n}`, workspaceId: 'workspace', sessionId: id })
    return [tab.id, tab]
  }))
  useAppStore.setState({ sessions: [...ids.map(id => composerSession(id)), composerSession('unrelated')], tabs,
    layouts: { workspace: createWorkspaceLayout('group', Object.keys(tabs)) }, viewModes: {}, scratchTopicSnapshots: {},
    agentComposerDrafts: {}, timelines: {}, workbenchSpaceSelection: null })
  const walks = vi.spyOn(topics, 'scratchTopicsForConfig')
  await dom.render(<WorkspaceWorkbench workspaceId="workspace" interactiveResize={false} visible />)
  expect(dom.container.querySelectorAll('[data-workbench-tab-id]').length).toBeGreaterThan(0)
  expect(walks.mock.calls.length).toBeGreaterThan(0)
  walks.mockClear()
  for (let n = 0; n < 8; n++) await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => ({ ...session, updatedAt: n + 2 })) })))
  expect(walks.mock.calls.length).toBe(0)
  await act(async () => useAppStore.setState({ config: { ...composerConfig, workspaces: [...composerConfig.workspaces] } }))
  expect(walks.mock.calls.length).toBeGreaterThan(0)
  await act(async () => useAppStore.setState(state => ({ viewModes: { ...state.viewModes, [ids[0]!]: 'activity' } })))
  expect(dom.container.querySelector('.activity-feed')).not.toBeNull()
  await act(async () => useAppStore.setState(state => ({ viewModes: { ...state.viewModes, [ids[0]!]: 'terminal' } })))
  expect(useAppStore.getState().viewModes[ids[0]!]).toBe('terminal')
})

it('accepted submits protect an immediate remount duplicate, release expired prompts and preserve failed retries', async () => {
  const guard = new ComposerResubmitGuard()
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'performance'] })
  try {
    vi.setSystemTime(10_000)
    const retained = Object.getOwnPropertyDescriptor(guard, 'submissions')!.value as Map<string, { text: string; at: number }>
    for (let n = 0; n < 100; n++) guard.record(`guard-${n}`, 'Large accepted prompt '.repeat(1000))
    expect(vi.getTimerCount()).toBe(1)
    expect(retained.size).toBe(100)
    expect(guard.isDuplicate('guard-0', 'Large accepted prompt '.repeat(1000))).toBe(true)
    vi.setSystemTime(-1_000_000) // A wall-clock adjustment must not extend a transient duplicate gate.
    await vi.advanceTimersByTimeAsync(400)
    guard.record('guard-0', 'new prompt')
    await vi.advanceTimersByTimeAsync(400)
    expect(retained.size).toBe(1)
    expect(guard.isDuplicate('guard-0', 'new prompt')).toBe(true)
    await vi.advanceTimersByTimeAsync(400)
    expect(retained.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(guard.isDuplicate('guard-0', 'new prompt')).toBe(false)
  } finally { vi.useRealTimers() }

  const send = vi.fn(() => true)
  useAppStore.setState({ sessions: [composerSession('resubmit')], agentComposerDrafts: { resubmit: 'Exact accepted prompt' }, send })
  await dom.render(<AgentSessionComposer sessionId="resubmit" />)
  const submit = async () => { await act(async () => dom.container.querySelector('.ProseMirror')!.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))) }
  await submit()
  expect(send).toHaveBeenCalledTimes(1)
  expect(send.mock.calls[0]).toEqual(['resubmit', 'Exact accepted prompt', expect.any(Function), 'manual'])
  await dom.render(<div />)
  await act(async () => useAppStore.getState().setAgentComposerDraft('resubmit', 'Exact accepted prompt'))
  await dom.render(<AgentSessionComposer sessionId="resubmit" />)
  await submit()
  expect(send).toHaveBeenCalledTimes(1)
  // A refusal never enters the application-run guard and keeps the exact draft retryable.
  send.mockReturnValueOnce(false)
  await act(async () => useAppStore.getState().setAgentComposerDraft('resubmit', 'Retry refused prompt'))
  await submit()
  expect(dom.draft('resubmit')).toBe('Retry refused prompt')
  await submit()
  expect(send).toHaveBeenCalledTimes(3)
  await act(async () => useAppStore.getState().setAgentComposerDraft('resubmit', 'Exact accepted prompt'))
  await new Promise(resolve => setTimeout(resolve, RESUBMIT_WINDOW_MS + 20))
  await submit()
  expect(send).toHaveBeenCalledTimes(4)
})

it('the actual Pane keeps current cross-session speaker identity in its notification scope', async () => {
  const recipient = composerSession('speaker-recipient'), speaker = composerSession('recorded-speaker')
  const captured = { id: 'recorded-agent-input', agentSessionId: recipient.id, kind: 'user_message' as const,
    source: 'user' as const, status: 'complete' as const, createdAt: 1, updatedAt: 1,
    title: 'Captured agent input', content: 'Original related speaker passage', authorAgentSessionId: speaker.id }
  const history = vi.spyOn(api.sessions, 'historyPage').mockResolvedValue({ agentSessionId: recipient.id,
    source: { providerId: 'codex', nativeSessionId: 'private-observation-only' }, items: [], nextCursor: null })
  useAppStore.setState({ sessions: [recipient, speaker, composerSession('unrelated')],
    agentNames: { [speaker.id]: 'Original related speaker' }, viewModes: { [recipient.id]: 'activity' },
    timelines: { [recipient.id]: { agentSessionId: recipient.id, revision: 1, items: [captured] } },
    agentComposerDrafts: { [recipient.id]: 'Keep exact input' }, recoveryCandidates: [], pendingAgentLaunches: {} })
  await dom.render(<SessionPane sessionId={recipient.id} surfaceKind="agent" interactiveResize={false} visible linkOrigin={{ workspaceId: 'workspace' }} />)
  await vi.waitFor(() => expect(dom.container.textContent).toContain('Original related speaker passage'))
  expect(history).toHaveBeenCalled()
  expect(dom.container.textContent).toContain('Original related speaker')
  const editor = dom.container.querySelector('.ProseMirror')
  await act(async () => useAppStore.setState(state => ({ agentNames: { ...state.agentNames, [speaker.id]: 'Fresh related speaker' } })))
  expect(dom.container.textContent).toContain('Fresh related speaker')
  expect(dom.container.querySelector('.ProseMirror')).toBe(editor)
  expect(dom.draft(recipient.id)).toBe('Keep exact input')
})

it('a hidden mounted Composer observes a published in-place timeline revision without another changed fact', async () => {
  const own = { agentSessionId: 'timeline-own', revision: 1, items: [] as import('../src/shared/contracts').AgentTimelineSnapshot['items'] }
  useAppStore.setState({ sessions: [composerSession('timeline-own')], timelines: { 'timeline-own': own }, agentComposerDrafts: { 'timeline-own': 'Untouched draft' } })
  await dom.render(<AgentSessionComposer sessionId="timeline-own" visible={false} />)
  own.items.push({ id: 'new-own-prompt', agentSessionId: 'timeline-own', kind: 'user_message', title: 'Prompt', source: 'user', status: 'complete', createdAt: 1, updatedAt: 1, content: 'Fresh revision prompt' })
  own.revision++
  await act(async () => useAppStore.setState(state => ({ timelines: { ...state.timelines } })))
  expect(dom.container.querySelector('.composer-agent-identity button')?.getAttribute('aria-label')).toContain('Fresh revision prompt')
  expect(dom.draft('timeline-own')).toBe('Untouched draft')
})

it('the shared notification owner subscribes once and releases its final mounted listener', async () => {
  const active = new Set<unknown>(), original = useAppStore.subscribe
  const spy = vi.spyOn(useAppStore, 'subscribe').mockImplementation(listener => {
    active.add(listener)
    const off = original(listener)
    return () => { active.delete(listener); off() }
  })
  const host = document.createElement('div'), root = createRoot(host)
  function Probe({ id }: { id: string }) {
    const scope = useMemo(() => ({ sessionIds: [id], navigation: false }), [id])
    const draft = useObservedAppStore('composer', false, scope, state => state.agentComposerDrafts[id])
    const name = useObservedAppStore('composer', false, scope, state => state.agentNames[id])
    return <output>{draft}{name}</output>
  }
  try {
    await act(async () => root.render(<>{Array.from({ length: 32 }, (_, n) => <Probe id={`probe-${n}`} key={n} />)}</>))
    expect(active.size).toBe(1)
    expect(spy).toHaveBeenCalledTimes(1)
    await act(async () => root.unmount())
    expect(active.size).toBe(0)
    const before = checks()
    useAppStore.setState({ agentNames: { 'probe-0': 'After disposal' } })
    expect(checks()).toEqual(before)
  } finally { spy.mockRestore(); host.remove() }
})

it('direct production Pane retains Activity body, reading Range and original editor through hidden updates and reveal', async () => {
  const session = composerSession('reading-own')
  const message = { id: 'reading-body', agentSessionId: session.id, kind: 'assistant_message' as const,
    source: 'native-hook' as const, status: 'complete' as const, createdAt: 1, updatedAt: 1,
    title: 'Original response', content: 'Original continuous reading passage' }
  vi.spyOn(api.sessions, 'historyPage').mockResolvedValue({ agentSessionId: session.id,
    source: { providerId: 'codex', nativeSessionId: 'private-reading-observation' }, items: [], nextCursor: null })
  const controls = [vi.spyOn(api.sessions, 'launchAgent'), vi.spyOn(api.sessions, 'stop'), vi.spyOn(api.sessions, 'resume'), vi.spyOn(api.sessions, 'write')]
  useAppStore.setState({ sessions: [session, composerSession('unrelated')], viewModes: { [session.id]: 'activity' },
    timelines: { [session.id]: { agentSessionId: session.id, revision: 1, items: [message] } },
    agentComposerDrafts: { [session.id]: 'Original unsent input' } })
  const pane = (visible: boolean) => <SessionPane sessionId={session.id} surfaceKind="agent" interactiveResize={false} visible={visible} linkOrigin={{ workspaceId: 'workspace' }} />
  await dom.render(pane(true))
  const body = [...dom.container.querySelectorAll<HTMLElement>('.log-turn__body')].find(element => element.textContent === message.content)!
  expect(body).toBeDefined()
  const text = body.querySelector('p')!.firstChild!, range = document.createRange()
  range.setStart(text, 3); range.setEnd(text, 11)
  document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range)
  const editor = dom.container.querySelector('.ProseMirror')
  await dom.render(pane(false))
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(item => item.id === session.id
    ? { ...item, status: { state: 'working', source: 'native-hook', observedAt: Date.now() } } : item) })))
  await dom.render(pane(true))
  expect([...dom.container.querySelectorAll('.log-turn__body')].find(element => element.textContent === message.content)).toBe(body)
  expect(dom.container.querySelector('.ProseMirror')).toBe(editor)
  expect([range.startContainer, range.startOffset, range.endContainer, range.endOffset]).toEqual([text, 3, text, 11])
  expect(document.getSelection()!.toString()).toBe('ginal co')
  expect(dom.draft(session.id)).toBe('Original unsent input')
  expect(useAppStore.getState().sessions.find(item => item.id === session.id)?.control).toBe(session.control)
  expect(controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0])
})

it('hidden Composer still refreshes shared service and configuration facts without closing healthy input', async () => {
  const session = composerSession('shared-own')
  useAppStore.setState({ sessions: [session], error: null, lastError: null, errorNoticeContext: null,
    agentComposerDrafts: { [session.id]: 'Original editable draft' }, lastActiveFileByWorkspace: { workspace: _hygiene_fixturePath("repo/related.ts") } })
  await dom.render(<AgentSessionComposer sessionId={session.id} visible={false} />)
  const editor = dom.container.querySelector('.ProseMirror')
  const notices = () => dom.container.querySelector('button[aria-label^="Mailbox:"]')?.getAttribute('aria-label')
  expect(notices()).toContain('Notices 0 need attention')
  await act(async () => useAppStore.setState({ error: 'Controlled recovery observation failed',
    errorNoticeContext: { kind: 'indeterminate', lifecycle: { step: 'resume', subject: session.control, lastProcessState: 'running' } } }))
  expect(notices()).toContain('Notices 1 need attention')
  expect(dom.container.querySelector('.ProseMirror')).toBe(editor)
  expect(editor?.getAttribute('contenteditable')).toBe('true')
  expect(dom.draft(session.id)).toBe('Original editable draft')
  // A global configuration edit remains current even while the surface is retained.
  expect(dom.container.querySelector(("button[aria-label=\"Reference " + _hygiene_fixturePath("repo/related.ts") + "\"]"))).not.toBeNull()
  await act(async () => useAppStore.setState({ config: { ...composerConfig, workspaces: [] } }))
  expect(dom.container.querySelector(("button[aria-label=\"Reference " + _hygiene_fixturePath("repo/related.ts") + "\"]"))).toBeNull()
  expect(dom.container.querySelector('.ProseMirror')).toBe(editor)
  expect(editor?.getAttribute('contenteditable')).toBe('true')
})

it('visible Pane autofocus follows current navigation while retained reveal reads current facts', async () => {
  const session = composerSession('focus-own')
  const tab = createWorkbenchTab('focus-tab', { kind: 'agent', phase: 'attached', regionId: 'focus-region', workspaceId: 'workspace', sessionId: session.id })
  useAppStore.setState({ sessions: [session], tabs: { [tab.id]: tab }, layouts: { workspace: createWorkspaceLayout('focus-group', [tab.id]) },
    mainSurface: 'workbench', activeWorkspaceId: 'workspace', retainedSpatialFocus: null, workbenchNavigationInputPolicy: null,
    workbenchSpaceSelection: null, viewModes: { [session.id]: 'terminal' } })
  const pane = (visible: boolean) => <SessionPane sessionId={session.id} surfaceKind="agent" interactiveResize={false} visible={visible}
    linkOrigin={{ workspaceId: 'workspace', tabGroupId: 'focus-group', tabId: tab.id, regionId: 'focus-region', sessionId: session.id }} />
  await dom.render(pane(false))
  const focus = { workspaceId: 'workspace', spaceId: null, zoneId: null, topicId: null, groupId: 'focus-group', tabId: tab.id, regionId: 'focus-region' }
  const before = checks()
  await act(async () => useAppStore.setState({ workbenchSpaceSelection: focus }))
  expect(checks()).toEqual(before)
  await dom.render(pane(true))
  expect(dom.container.querySelector('[data-pty-paint]')?.getAttribute('data-pane-autofocus')).toBe('true')
  await act(async () => useAppStore.setState({ workbenchSpaceSelection: null }))
  expect(dom.container.querySelector('[data-pty-paint]')?.getAttribute('data-pane-autofocus')).toBe('false')
  expect(useAppStore.getState().sessions[0]?.control).toBe(session.control)
})

it('a retained Pane preserves the original first recovery observation and refreshes its own identity', async () => {
  const session = composerSession('retained-recovery')
  const first = { ...session, agentSessionId: session.id, run: session.control.run, label: 'Original recovery identity' }
  const overlapping = { ...first, label: 'Later recovery observation' }
  useAppStore.setState({ sessions: [], pendingAgentLaunches: {}, recoveryCandidates: [first, overlapping],
    timelines: {}, agentNames: {}, agentComposerDrafts: { [session.id]: 'Original retained input' } })
  const controls = [vi.spyOn(api.sessions, 'launchAgent'), vi.spyOn(api.sessions, 'stop'), vi.spyOn(api.sessions, 'resume'), vi.spyOn(api.sessions, 'write')]
  await dom.render(<SessionPane sessionId={session.id} surfaceKind="agent" interactiveResize={false} visible={false}
    linkOrigin={{ workspaceId: 'workspace' }} />)
  const surface = dom.container.querySelector('.agent-surface')
  expect(dom.container.textContent).toContain('Original recovery identity')
  const before = checks()
  const later = { ...overlapping, label: 'Changed later observation' }
  await act(async () => useAppStore.setState({ recoveryCandidates: [first, later] }))
  expect(checks()).toEqual(before)
  await act(async () => useAppStore.setState({ recoveryCandidates: [{ ...first, label: 'Fresh original recovery identity' }, later] }))
  expect(dom.container.textContent).toContain('Fresh original recovery identity')
  expect(dom.container.querySelector('.agent-surface')).toBe(surface)
  expect(dom.draft(session.id)).toBe('Original retained input')
  expect(controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0])
})
