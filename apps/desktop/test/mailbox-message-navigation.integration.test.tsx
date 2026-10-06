// @vitest-environment happy-dom
import { act, useEffect } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryPage, AgentSessionHistoryObservation, AgentSessionUserMessage } from '@agentmux/core'
import { projectSessionUserMessages } from '@agentmux/core/session-user-messages'
import { conversationMessageSourceKey } from '@agentmux/client-ui/conversation-message-location'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { useSessionUserMessages } from '../src/renderer/src/lib/session-user-messages'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { workbenchSessionStageHostId, type WorkbenchViewTarget } from '../src/renderer/src/lib/workbench-presentation'

// Real host, composer, mailbox, Activity and shared readers. Only terminal rendering is a leaf
// witness here; exact xterm geometry/input is qualified separately by the finite Native command.
const terminals = vi.hoisted(() => ({ mounted: 0, disposed: 0 }))
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: ({ visible, autoFocus }: { visible: boolean; autoFocus: boolean }) => {
  useEffect(() => { ++terminals.mounted; return () => { ++terminals.disposed } }, [])
  return <div data-terminal-witness data-visible={visible} data-auto-focus={autoFocus} />
} }))
vi.mock('../src/renderer/src/components/SessionResultReview', () => ({ SessionResultReview: () => null }))
import { SessionPane } from '../src/renderer/src/components/SessionPane'

const dom = composerDOM()
const body = 'Identical recorded text from distinct sources'
const page = (nativeSessionId = 'native-a', providerId = 'codex'): AgentSessionHistoryPage => ({
  agentSessionId: 'agent-1', source: { providerId, nativeSessionId }, nextCursor: 'earlier',
  items: [{ id: 'same', kind: 'user-message', contentParts: [{ kind: 'text', text: body }] }]
})
const incoming = { id: 'same', agentSessionId: 'agent-1', kind: 'user_message' as const, status: 'complete' as const,
  source: 'user' as const, title: 'Recorded input', content: body, authorAgentSessionId: 'declared-peer', createdAt: 1, updatedAt: 1 }
let observation: ((event: AgentSessionHistoryObservation) => void) | undefined
let witness: ReturnType<typeof useSessionUserMessages> | null = null
const revealSource = { kind: 'native' as const, providerId: 'codex', nativeSessionId: 'native-a', recordId: 'missing' }
function Witness() { witness = useSessionUserMessages(composerSession().control); return null }
const panel = () => dom.container.querySelector<HTMLElement>('.composer-mailbox')!
const pane = (id = 'agent-1', parked = false) => <SessionPane sessionId={id} surfaceKind="agent" interactiveResize={false} visible parked={parked}
  linkOrigin={{ workspaceId: 'workspace', tabId: 'tab', regionId: 'region' }} />
async function flush() { await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }); await act(async () => new Promise(resolve => setTimeout(resolve, 25))) }
async function open(folder = 'inbox') {
  const event = new Event('toggle'); Object.defineProperty(event, 'newState', { value: 'open' })
  await act(async () => panel().dispatchEvent(event)); await flush()
  await dom.click(`[role="tab"][id$="-${folder}-tab"]`)
}
async function navigate(key: string, detail = false) {
  const row = [...panel().querySelectorAll<HTMLButtonElement>('.composer-mailbox__row')].find(node => node.dataset.recordKey === key)
  expect(row).toBeDefined()
  if (detail) { await act(async () => { row!.focus(); row!.click() }); expect(panel().querySelectorAll('.log-turn__body')).toHaveLength(1) }
  const action = detail ? panel().querySelector<HTMLButtonElement>('.composer-mailbox__detail .composer-mailbox__record-actions .composer-mailbox__reveal') : row!.parentElement!.querySelector<HTMLButtonElement>('.composer-mailbox__reveal')
  expect(action).not.toBeNull(); expect(action!.closest('button button')).toBeNull()
  await act(async () => { action!.focus(); action!.click() }); await flush()
}
function located(source: AgentSessionUserMessage['source']) {
  const key = conversationMessageSourceKey('agent-1', source)
  const actual = [...dom.container.querySelectorAll<HTMLElement>('.activity-feed .log-turn')].filter(node => node.dataset.messageSourceKey === key)
  expect(actual).toHaveLength(1); expect(actual[0]!.dataset.messageLocated).toBe('true')
  expect(actual[0]!.textContent).toContain('已定位此消息'); expect(document.activeElement).toBe(actual[0])
  return actual[0]!
}
beforeEach(() => {
  observation = undefined; witness = null; terminals.mounted = 0; terminals.disposed = 0
  localStorage.clear()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0))
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id))
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} unobserve() {} })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    return { x: 0, y: 0, top: 0, left: 0, right: 600, bottom: this.classList.contains('activity-feed') ? 300 : 20,
      width: 600, height: this.classList.contains('activity-feed') ? 300 : 20, toJSON() {} }
  })
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
  Object.defineProperty(HTMLElement.prototype, 'hidePopover', { configurable: true, value() {
    const event = new Event('toggle'); Object.defineProperty(event, 'newState', { value: 'closed' }); this.dispatchEvent(event)
  } })
  vi.spyOn(api.sessions, 'historyPage').mockResolvedValue(page())
  vi.spyOn(api.sessions, 'observeHistory').mockImplementation(async (_control, listener) => {
    observation = listener; return { source: page().source, dispose: vi.fn() }
  })
  vi.spyOn(api.continuousProgress, 'list').mockResolvedValue([])
  useAppStore.setState({ sessions: [composerSession(), composerSession('other')], viewModes: { 'agent-1': 'terminal', other: 'terminal' },
    timelines: { 'agent-1': { agentSessionId: 'agent-1', revision: 1, items: [incoming] } },
    noticeReadReceipts: {}, agentSteerQueues: {}, agentSteerInFlight: {} })
})

it.each([false, true])('real Inbox captured action (detail=%s) locates receiving conversation rather than declared sender or duplicate native raw id', async detail => {
  const send = vi.spyOn(api.sessions, 'write')
  await dom.render(pane()); await open(); await navigate('timeline:same', detail)
  const target = located({ kind: 'captured', submissionId: 'same' })
  const duplicate = [...dom.container.querySelectorAll<HTMLElement>('.activity-feed .log-turn')].find(node => node.dataset.messageSourceKey === conversationMessageSourceKey('agent-1', page().source ? { ...page().source, kind: 'native', recordId: 'same' } : undefined))
  expect(duplicate).toBeDefined(); expect(duplicate).not.toBe(target); expect(duplicate!.dataset.messageLocated).toBeUndefined()
  expect(useAppStore.getState().viewModes).toEqual({ 'agent-1': 'activity', other: 'terminal' })
  expect(dom.draft()).toBe('Keep my draft'); expect(terminals.mounted).toBe(1); expect(terminals.disposed).toBe(0)
  expect(dom.container.querySelector('[data-terminal-witness]')?.getAttribute('data-visible')).toBe('false')
  expect(dom.container.querySelector('[data-terminal-witness]')?.getAttribute('data-auto-focus')).toBe('false')
  expect(panel().dataset.state).toBe('closed'); expect(send).not.toHaveBeenCalled()
})

it.each([false, true])('real Outbox native action (detail=%s) selects complete provider/session/record namespace with stable projection and handoff', async detail => {
  await dom.render(pane()); await open('outbox'); await navigate('native:native:codex:native-a:same', detail)
  const target = located({ kind: 'native', providerId: 'codex', nativeSessionId: 'native-a', recordId: 'same' })
  expect(target.dataset.messageId).toBe('native:codex:native-a:same')
  expect(api.sessions.historyPage).toHaveBeenCalledTimes(1)
  expect(panel().dataset.state).toBe('closed'); expect(document.activeElement).toBe(target)
})

it('Pending has a disabled independent action and honest reason in list and shared detail, with zero dispatch or navigation', async () => {
  const send = vi.spyOn(api.sessions, 'write'), steer = vi.spyOn(useAppStore.getState(), 'enqueueAgentSteer')
  useAppStore.setState({ agentSteerQueues: { 'agent-1': [{ operationId: 'pending', text: 'Exact unsent full text', status: 'queued', runId: 'run-agent-1' }] } })
  await dom.render(pane()); await open('outbox')
  const row = panel().querySelector<HTMLButtonElement>('[data-record-key="queue:pending"]')!
  const action = row.parentElement!.querySelector<HTMLButtonElement>('.composer-mailbox__reveal')!
  expect(action.disabled).toBe(true); expect(row.parentElement!.textContent).toContain('尚未发送，暂无对话位置')
  await act(async () => { action.click(); row.click() }); expect(panel().querySelector('.log-turn__body')!.textContent).toBe('Exact unsent full text')
  expect(panel().querySelector<HTMLButtonElement>('.log-turn__actions .composer-mailbox__reveal')!.disabled).toBe(true)
  expect(panel().textContent).toContain('尚未发送，暂无对话位置')
  expect(useAppStore.getState().viewModes['agent-1']).toBe('terminal'); expect(send).not.toHaveBeenCalled(); expect(steer).not.toHaveBeenCalled()
})

it.each([{ providerId: 'claude', nativeSessionId: 'native-a' }, { providerId: 'codex', nativeSessionId: 'native-b' }])('source change %s in the same Host/Session/Run rejects old native relation distinctly and retains full shared text/Copy', async source => {
  await dom.render(pane()); await open('outbox')
  await act(async () => observation?.({ kind: 'invalidated', agentSessionId: 'agent-1', source }))
  await navigate('native:native:codex:native-a:same', true)
  expect(panel().textContent).toContain('原生来源已变化'); expect(panel().textContent).not.toContain('当前有界对话窗口中没有这条记录')
  expect(panel().querySelector('.log-turn__body')!.textContent).toBe(body)
  expect(panel().querySelector('[aria-label="Copy message"]')).not.toBeNull()
  expect(panel().dataset.state).toBe('open'); expect(useAppStore.getState().viewModes['agent-1']).toBe('terminal')
})

it('a changed public Session provider in the same Host/Session/Run cannot use the previously loaded native source', async () => {
  await dom.render(pane()); await open('outbox')
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === 'agent-1' && session.kind === 'agent'
    ? { ...session, providerId: 'claude' } : session) })))
  await navigate('native:native:codex:native-a:same', true)
  expect(panel().textContent).toContain('原生来源已变化'); expect(panel().querySelector('.log-turn__body')!.textContent).toBe(body)
  expect(api.sessions.historyPage).toHaveBeenCalledTimes(1); expect(useAppStore.getState().viewModes['agent-1']).toBe('terminal')
  expect(dom.container.querySelector('[data-message-located]')).toBeNull()
})

it.each(['focus', 'mode', 'run', 'hidden'])('late native result is isolated from later %s intent or scope', async change => {
  await dom.render(pane()); await open('outbox')
  const action = panel().querySelector<HTMLButtonElement>('.composer-mailbox__reveal')!
  const external = document.createElement('button'); document.body.append(external)
  await act(async () => {
    action.focus(); action.click()
    if (change === 'focus') external.focus()
    if (change === 'mode') useAppStore.getState().setViewMode('agent-1', 'activity', { focus: false })
    if (change === 'run') useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === 'agent-1' && session.kind === 'agent'
      ? { ...session, control: { ...session.control, run: { runId: 'new-run' } } } : session) }))
    if (change === 'hidden') await dom.render(<SessionPane sessionId="agent-1" surfaceKind="agent" interactiveResize={false} visible={false} linkOrigin={{ workspaceId: 'workspace', tabId: 'tab', regionId: 'region' }} />)
  })
  await flush(); expect(dom.container.querySelector('[data-message-located]')).toBeNull()
  if (change === 'focus') expect(document.activeElement).toBe(external)
  expect(useAppStore.getState().viewModes['agent-1']).toBe(change === 'mode' ? 'activity' : 'terminal')
  external.remove()
})

it('shared Activity with equal raw native ids in two providers/sessions uses the complete rendered namespace', async () => {
  const a = page(), b = page('native-b', 'claude')
  const messages = [...projectSessionUserMessages({ agentSessionId: 'agent-1', historyPage: a }), ...projectSessionUserMessages({ agentSessionId: 'agent-1', historyPage: b })]
  const completed = vi.fn(), key = conversationMessageSourceKey('agent-1', messages[0]!.source)!
  expect(key).not.toBe(conversationMessageSourceKey('agent-1', messages[1]!.source))
  expect(key).not.toBe(conversationMessageSourceKey('other', messages[0]!.source))
  await dom.render(<ActivityView sessionId="agent-1" items={[]} userMessages={messages} nativeHistoryPage={a} capability="complete-events"
    revealRequest={{ generation: 1, sourceKey: key, isCurrent: () => true, complete: completed }} />)
  await flush(); expect(completed).toHaveBeenCalledWith(true)
  const target = located(messages[0]!.source); expect(target.dataset.messageId).toBe(messages[0]!.id)
  expect([...dom.container.querySelectorAll('[data-message-located]')]).toHaveLength(1)
})

it('later user focus or wheel cancels pending exact-node reveal, never taking it back', async () => {
  await dom.render(pane()); await open()
  const action = panel().querySelector<HTMLButtonElement>('.composer-mailbox__reveal')!
  const external = document.createElement('button'); document.body.append(external)
  await act(async () => { action.focus(); action.click(); external.focus(); external.dispatchEvent(new WheelEvent('wheel', { bubbles: true })) })
  await flush(); expect(document.activeElement).toBe(external)
  expect(dom.container.querySelector('[data-message-located]')).toBeNull(); expect(panel().dataset.state).toBe('open'); external.remove()
})

it('same-control native reader performs at most one bounded request, or joins inflight without queueing refresh', async () => {
  await dom.render(<Witness />); await flush(); expect(api.sessions.historyPage).toHaveBeenCalledTimes(1)
  let resolve: ((value: AgentSessionHistoryPage) => void) | undefined
  vi.mocked(api.sessions.historyPage).mockImplementationOnce(() => new Promise(done => { resolve = done }))
  let earlier: Promise<void> | undefined, reveal: ReturnType<NonNullable<typeof witness>['readForReveal']> | undefined
  await act(async () => { earlier = witness!.loadEarlier(); reveal = witness!.readForReveal(revealSource) })
  expect(api.sessions.historyPage).toHaveBeenCalledTimes(2)
  await act(async () => resolve?.({ ...page(), items: [{ id: 'missing', kind: 'user-message', contentParts: [{ kind: 'text', text: 'Exact older input' }] }], nextCursor: 'even-earlier' }))
  await act(async () => { await earlier; await reveal }); await flush()
  expect(api.sessions.historyPage).toHaveBeenCalledTimes(2); expect((await reveal)!.page!.items.map(item => item.id)).toEqual(['missing', 'same'])
  vi.mocked(api.sessions.historyPage).mockRejectedValueOnce(new Error('finite history read unavailable'))
  let failed: Awaited<ReturnType<NonNullable<typeof witness>['readForReveal']>> | undefined
  await act(async () => { failed = await witness!.readForReveal({ ...revealSource, recordId: 'not-present' }) })
  expect(api.sessions.historyPage).toHaveBeenCalledTimes(3); expect(failed!.error!.message).toBe('finite history read unavailable')
  expect(failed!.page!.items.map(item => item.id)).toEqual(['missing', 'same']); expect(dom.draft()).toBe('Keep my draft')
})

it.each(['changed-provider', 'changed-session', 'failed'])('an already loaded native target joins current revalidation (%s) before declaring a location', async outcome => {
  await dom.render(<>{pane()}<Witness /></>); await open('outbox')
  expect(witness!.messages.some(message => message.source.kind === 'native' && message.source.recordId === 'same')).toBe(true)
  let resolve: ((value: AgentSessionHistoryPage) => void) | undefined, reject: ((reason: Error) => void) | undefined
  vi.mocked(api.sessions.historyPage).mockImplementationOnce(() => new Promise((done, fail) => { resolve = done; reject = fail }))
  let revalidation: Promise<void> | undefined
  await act(async () => { revalidation = witness!.refresh() }); await flush()
  expect(api.sessions.historyPage).toHaveBeenCalledTimes(2)
  await navigate('native:native:codex:native-a:same', true)
  expect(useAppStore.getState().viewModes['agent-1']).toBe('terminal')
  expect(dom.container.querySelector('[data-message-located]')).toBeNull()
  await act(async () => { if (outcome === 'failed') reject?.(new Error('revalidation unavailable'))
    else resolve?.(page(outcome === 'changed-session' ? 'native-b' : 'native-a', outcome === 'changed-provider' ? 'claude' : 'codex')) })
  await act(async () => { await revalidation }); await flush()
  expect(api.sessions.historyPage).toHaveBeenCalledTimes(2)
  expect(panel().textContent).toContain(outcome === 'failed' ? '读取对话失败：revalidation unavailable' : '原生来源已变化')
  expect(panel().querySelector('.log-turn__body')!.textContent).toBe(body)
  expect(panel().querySelector('[aria-label="Copy message"]')).not.toBeNull()
  expect(panel().dataset.state).toBe('open'); expect(useAppStore.getState().viewModes['agent-1']).toBe('terminal')
  expect(dom.container.querySelector('[data-message-located]')).toBeNull()
})

it.each(['mode', 'hidden'])('programmatic %s change removes every pending reveal intent listener while its bounded read is still unresolved', async change => {
  await dom.render(<>{pane()}<Witness /></>); await open('outbox')
  let resolve: ((value: AgentSessionHistoryPage) => void) | undefined
  vi.mocked(api.sessions.historyPage).mockImplementationOnce(() => new Promise(done => { resolve = done }))
  let reading: Promise<void> | undefined
  await act(async () => { reading = witness!.refresh() }); await flush()
  const add = vi.spyOn(document, 'addEventListener'), remove = vi.spyOn(document, 'removeEventListener')
  await navigate('native:native:codex:native-a:same')
  const registered = add.mock.calls.filter(call => typeof call[1] === 'function' && call[1].name === 'changedIntent')
  expect(registered.map(call => call[0])).toEqual(['pointerdown', 'keydown', 'wheel', 'touchmove', 'focusin'])
  if (change === 'mode') await act(async () => useAppStore.getState().setViewMode('agent-1', 'activity', { focus: false }))
  else await dom.render(<><SessionPane sessionId="agent-1" surfaceKind="agent" interactiveResize={false} visible={false}
    linkOrigin={{ workspaceId: 'workspace', tabId: 'tab', regionId: 'region' }} /><Witness /></>)
  expect(witness!.loading).toBe(true)
  for (const call of registered) expect(remove.mock.calls.some(removed => removed[0] === call[0] && removed[1] === call[1] && removed[2] === true)).toBe(true)
  await act(async () => resolve?.(page())); await act(async () => { await reading }); await flush()
  expect(dom.container.querySelector('[data-message-located]')).toBeNull()
  expect(useAppStore.getState().viewModes['agent-1']).toBe(change === 'mode' ? 'activity' : 'terminal')
})

it.each(['exited', 'interrupted', 'theme'])('programmatic %s unavailability resolves the pending reveal and removes its intent listeners before its read returns', async change => {
  await dom.render(<>{pane()}<Witness /></>); await open('outbox')
  let resolve: ((value: AgentSessionHistoryPage) => void) | undefined
  vi.mocked(api.sessions.historyPage).mockImplementationOnce(() => new Promise(done => { resolve = done }))
  let reading: Promise<void> | undefined
  await act(async () => { reading = witness!.refresh() }); await flush()
  const add = vi.spyOn(document, 'addEventListener'), remove = vi.spyOn(document, 'removeEventListener')
  await navigate('native:native:codex:native-a:same', true)
  const registered = add.mock.calls.filter(call => typeof call[1] === 'function' && call[1].name === 'changedIntent')
  expect(registered).toHaveLength(5)
  await act(async () => {
    if (change === 'theme') useAppStore.setState(state => ({ config: { ...state.config!, appearance: { ...state.config!.appearance, terminalTheme: undefined } } }))
    else useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === 'agent-1'
      ? { ...session, processState: change } : session) }))
  })
  expect(witness!.loading).toBe(true)
  for (const call of registered) expect(remove.mock.calls.some(removed => removed[0] === call[0] && removed[1] === call[1] && removed[2] === true)).toBe(true)
  expect(useAppStore.getState().viewModes['agent-1']).toBe('terminal')
  expect(useAppStore.getState().sessions.find(session => session.id === 'agent-1')!.control.run.runId).toBe('run-agent-1')
  if (change !== 'theme') {
    expect(panel().textContent).toContain('当前对话位置尚不可用，Session 已保留')
    expect(panel().querySelector('.log-turn__body')!.textContent).toBe(body)
    expect(panel().querySelector('[aria-label="Copy message"]')).not.toBeNull()
  }
  await act(async () => resolve?.(page())); await act(async () => { await reading }); await flush()
  expect(dom.container.querySelector('[data-message-located]')).toBeNull(); expect(useAppStore.getState().viewModes['agent-1']).toBe('terminal')
  expect(dom.draft()).toBe('Keep my draft')
})

it('focus on an equal-source message in another display is later intent rather than this reveal handoff', async () => {
  await dom.render(pane()); await open('outbox')
  const externalFeed = document.createElement('div'), external = document.createElement('button')
  externalFeed.className = 'activity-feed'; external.dataset.messageSourceKey = conversationMessageSourceKey('agent-1', { kind: 'native', providerId: 'codex', nativeSessionId: 'native-a', recordId: 'same' })
  externalFeed.append(external); document.body.append(externalFeed)
  const action = panel().querySelector<HTMLButtonElement>('.composer-mailbox__reveal')!
  await act(async () => { action.focus(); action.click(); external.focus() }); await flush()
  expect(document.activeElement).toBe(external); expect(useAppStore.getState().viewModes['agent-1']).toBe('terminal')
  expect(dom.container.querySelector('[data-message-located]')).toBeNull(); externalFeed.remove()
})

it('never mounts a never-opened Terminal in Activity and preserves the original parked release boundary', async () => {
  useAppStore.setState({ viewModes: { 'agent-1': 'activity' } }); await dom.render(pane()); expect(terminals.mounted).toBe(0)
  await act(async () => useAppStore.getState().setViewMode('agent-1', 'terminal', { focus: false })); expect(terminals.mounted).toBe(1)
  await act(async () => useAppStore.getState().setViewMode('agent-1', 'activity', { focus: false })); expect(terminals.disposed).toBe(0)
  await dom.render(pane('agent-1', true)); expect(terminals.disposed).toBe(1)
})

it('a theme/connecting early return does not invent an already-opened Terminal', async () => {
  useAppStore.setState(state => ({ config: { ...state.config!, appearance: { ...state.config!.appearance, terminalTheme: undefined } } }))
  await dom.render(pane()); expect(terminals.mounted).toBe(0)
  await act(async () => useAppStore.getState().setViewMode('agent-1', 'activity', { focus: false }))
  await act(async () => useAppStore.setState(state => ({ config: { ...state.config!, appearance: { ...state.config!.appearance, terminalTheme: 'graphite' } } })))
  await dom.render(pane()); expect(terminals.mounted).toBe(0)
})

it('the presented Mailbox reveals only its proven display occurrence, without broadcasting to another projection', async () => {
  const targets: WorkbenchViewTarget[] = ['one', 'two'].map(id => ({ hostId: `display-${id}`, active: true, visible: true,
    reference: { displayWorkspaceId: 'workspace', groupId: `group-${id}`, tabId: `tab-${id}`, regionId: 'region' } }))
  const hosts = targets.map(target => { const host = document.createElement('div'); host.id = workbenchSessionStageHostId(target, 'region'); document.body.append(host); return host })
  try {
    useAppStore.setState({ viewModes: { 'agent-1': 'activity' } })
    await dom.render(<SessionPane sessionId="agent-1" surfaceKind="agent" interactiveResize={false} visible={false} presentations={targets}
      renderPresentationFrame={content => content} linkOrigin={{ workspaceId: 'workspace', tabId: 'tab', regionId: 'region' }} />)
    await flush()
    const mailbox = hosts[0]!.querySelector<HTMLElement>('.composer-mailbox')!
    expect(mailbox).not.toBeNull()
    const event = new Event('toggle'); Object.defineProperty(event, 'newState', { value: 'open' })
    await act(async () => mailbox.dispatchEvent(event)); await flush()
    await act(async () => hosts[0]!.querySelector<HTMLButtonElement>('[id$="-inbox-tab"]')!.click())
    const action = mailbox.querySelector<HTMLButtonElement>('.composer-mailbox__reveal')!
    expect(action.disabled).toBe(false)
    await act(async () => { action.focus(); action.click() }); await flush()
    const marker = hosts[0]!.querySelector<HTMLElement>('[data-message-located]')!
    expect(marker).not.toBeNull(); expect(document.activeElement).toBe(marker)
    expect(marker.dataset.messageSourceKey).toBe(conversationMessageSourceKey('agent-1', { kind: 'captured', submissionId: 'same' }))
    expect(hosts[1]!.querySelector('[data-message-located]')).toBeNull(); expect(dom.container.querySelector('[data-message-located]')).toBeNull()
    expect(terminals.mounted).toBe(0); expect(dom.draft()).toBe('Keep my draft')
  } finally { hosts.forEach(host => host.remove()) }
})
