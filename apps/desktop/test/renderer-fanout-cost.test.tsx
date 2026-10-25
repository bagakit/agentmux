// @vitest-environment happy-dom
import { act, Profiler, useMemo, useState } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { homedir } from 'node:os'
import { appendFileSync } from 'node:fs'
import { createWorkspaceLayout } from '@agentmux/layout'
import { PROMPT_REACTION_STARTERS } from '@agentmux/core/prompt-reaction'
import { msUntilSemanticStatusStale } from '@agentmux/core/agent-status'
import { WorkspaceWorkbench } from '../src/renderer/src/components/WorkspaceWorkbench'
import { MoteWorkfaceContext } from '../src/renderer/src/lib/mote-workface'
import { GlobalSystemNotices } from '../src/renderer/src/components/GlobalSystemNotices'
import { useAgentAttentionNotifications } from '../src/renderer/src/hooks/useAgentAttentionNotifications'
import { useConversationReactions } from '../src/renderer/src/lib/conversation-reactions'
import { createSessionServiceNoticeSelector } from '../src/renderer/src/lib/session-service-notices'
import { serviceNoticeFingerprint, type ServiceNoticeItem } from '../src/renderer/src/lib/use-service-notices'
import { sessionPresentationById } from '../src/renderer/src/lib/session-presentation'
import { createWorkbenchTab, documentKey, type WorkbenchTab, type BrowserWorkbenchSurface } from '../src/renderer/src/lib/workbench-tabs'
import { TerminalParkingProvider } from '../src/renderer/src/lib/terminal-cold-parking-coordinator'
import { SurfaceMemoryBudgetProvider, type SurfaceMemoryBudgetState } from '../src/renderer/src/lib/surface-memory-budget-coordinator'
import type { BrowserControlConfirmation } from '../src/renderer/src/lib/workbench-presentation'
import type { BrowserSnapshot } from '../src/shared/contracts'
import { sessionNameMetadataKey } from '../src/renderer/src/lib/session-name-metadata'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { currentNotificationRows, toggleNotificationCenter, toggleNotificationDetails } from './helpers/notification-center'

// The retained product chain stays real through SessionPane and Composer. Only
// the native Terminal leaf is unavailable in happy-dom; Native proof owns it.
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div data-original-terminal /> }))
vi.mock('../src/renderer/src/components/FileSourceEditor', () => ({
  FileSourceEditor: ({ surface }: { surface: { regionId: string; workspaceId: string; path: string } }) => {
    const content = useAppStore(state => state.documents[documentKey(surface.workspaceId, surface.path)]?.content)
    return <div data-native-editor-substitute={surface.regionId} contentEditable suppressContentEditableWarning>{content}</div>
  }
}))

type Counts = Record<string, number>
const counts = () => ((globalThis as typeof globalThis & { __rendererFanoutCounts?: Counts }).__rendererFanoutCounts ??= {})
const reset = () => { for (const key of Object.keys(counts())) counts()[key] = 0 }
function sample(owner: string, scale: number, extra: Record<string, unknown> = {}) {
  if (process.env.AGENTMUX_RENDERER_SAMPLES) appendFileSync(process.env.AGENTMUX_RENDERER_SAMPLES,
    JSON.stringify({ owner, scale, counts: { ...counts() }, workerPid: process.pid, privateHome: homedir(), ...extra }) + '\n')
}
const dom = composerDOM()
let commitCount = 0
beforeEach(() => {
  expect(homedir()).toBe(process.env.AGENTMUX_RENDERER_PRIVATE_HOME)
  expect(process.env.HOME).toBe(process.env.AGENTMUX_RENDERER_PRIVATE_HOME)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  Element.prototype.scrollIntoView = vi.fn()
  commitCount = 0
})
afterEach(() => vi.unstubAllGlobals())
function fixture(count: number) {
  const sessions = Array.from({ length: count }, (_, i) => ({ ...composerSession(`owned-${i}`), label: `Original ${i}` }))
  const tabs = Object.fromEntries(sessions.map((session, i) => {
    const tab = createWorkbenchTab(`tab-${i}`, { kind: 'agent', phase: 'attached', workspaceId: 'workspace', regionId: `region-${i}`, sessionId: session.id })
    return [tab.id, tab]
  }))
  const layout = createWorkspaceLayout('group', Object.keys(tabs))
  useAppStore.setState({ config: { ...composerConfig, composerShortcuts: [...PROMPT_REACTION_STARTERS] }, loading: false,
    sessions: [...sessions, composerSession('unrelated')], tabs, layouts: { workspace: layout }, mainSurface: 'workbench', activeWorkspaceId: 'workspace',
    agentNames: {}, sessionNameMetadata: {}, pendingAgentLaunches: {}, recoveryCandidates: [], viewModes: {}, timelines: {},
    agentComposerDrafts: { 'owned-0': 'Original unsent draft' }, agentSteerQueues: {}, agentSteerInFlight: {},
    noticeReadReceipts: {}, runtimeEndpointWarnings: [], runtimeOwnershipWarnings: [], environmentWarning: undefined,
    displacedAgentSessionIds: [], notificationEvents: [], error: null, errorNoticeContext: null,
    workbenchSaveWarning: null, nameSaveUnconfirmed: null, nameEditFailure: null, desktopNavigationNotice: null })
  return { sessions, tabs, layout }
}
async function status(id: string, state: 'working' | 'waiting' | 'done', at = Date.now()) {
  await act(async () => useAppStore.getState().applyEvent({ type: 'core', hostId: 'local', event: {
    type: 'agent-status', agentSessionId: id, state, evidence: { source: 'native-hook', observedAt: at }
  } }))
}

it.each([1, 32, 100])('bounds actual retained Workbench metadata and Pane reaction selector work at %i unrelated surfaces', async count => {
  const original = fixture(count)
  await dom.render(<Profiler id="workbench" onRender={() => { commitCount++ }}><WorkspaceWorkbench workspaceId="workspace" /></Profiler>)
  expect(document.querySelectorAll('.retained-workbench-view').length).toBeGreaterThanOrEqual(count)
  expect(document.querySelectorAll('[data-original-terminal]').length).toBeGreaterThan(0)
  const before = useAppStore.getState(), originalTerminal = document.querySelector('[data-original-terminal]')
  const editor = document.querySelector('.tiptap')
  reset(); commitCount = 0
  await act(async () => useAppStore.getState().setAgentComposerDraft('unrelated-draft', 'Outside original workface'))
  await status('unrelated', 'working')
  await act(async () => useAppStore.setState(state => ({ agentNames: { ...state.agentNames, unrelated: 'Unrelated name' },
    sessionNameMetadata: { ...state.sessionNameMetadata, [sessionNameMetadataKey('local', 'unrelated')]: {
      hostId: 'local', agentSessionId: 'unrelated', providerId: 'codex', executorId: 'codex',
      workspacePath: composerConfig.workspaces[0]!.path, label: 'Outside metadata', state: 'active' as const
    } } })))
  sample('workbench-and-reactions', count, { commits: commitCount, retainedLayers: document.querySelectorAll('.retained-workbench-view').length })
  expect.soft(counts().workbenchModes ?? 0, 'unrelated workspace Activity projections must not execute').toBe(0)
  expect.soft(counts().tabMetadata ?? 0, 'unrelated heavy metadata selectors must not execute').toBe(0)
  expect.soft(counts().reactionProvider ?? 0, 'unrelated Pane reaction selectors must not execute').toBe(0)
  expect(commitCount, 'selector work and actual React commits are separate gates').toBe(0)
  expect(document.querySelector('[data-original-terminal]')).toBe(originalTerminal)
  expect(document.querySelector('.tiptap')).toBe(editor)
  expect(useAppStore.getState().tabs).toBe(before.tabs)
  expect(useAppStore.getState().layouts).toBe(before.layouts)
  expect(useAppStore.getState().agentComposerDrafts['owned-0']).toBe('Original unsent draft')
  await act(async () => useAppStore.setState(state => ({ agentNames: { ...state.agentNames, 'owned-0': 'Related renamed Agent' } })))
  expect(counts().tabMetadata).toBeGreaterThan(0)
  expect(dom.container.textContent).toContain('Related renamed Agent')
  await status('owned-0', 'waiting', Date.now() + 1)
  expect(useAppStore.getState().sessions.find(session => session.id === 'owned-0')?.status.state).toBe('waiting')
  expect(useAppStore.getState().sessions.filter(session => session.id.startsWith('owned-')).map(session => session.control.run.runId)).toEqual(original.sessions.map(session => session.control.run.runId))
  // Stable actions read the current Store when the real retained Tab is used.
  // A changed close request remains a subscribed fact and must reach its dialog.
  const actionTarget = `tab-${count > 1 ? 1 : 0}`
  const targetGroup = original.layout.groups[0]!
  const targetButton = dom.container.querySelector<HTMLButtonElement>(`[data-workbench-tab-id="${actionTarget}"]`)
  expect(targetButton).not.toBeNull()
  await act(async () => targetButton!.click())
  expect(useAppStore.getState().layouts.workspace?.groups.find(group => group.id === targetGroup.id)?.activeTabId).toBe(actionTarget)
  expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject({
    workspaceId: 'workspace', groupId: targetGroup.id, tabId: actionTarget, regionId: original.tabs[actionTarget]!.layout.activeRegionId
  })
  expect(dom.container.querySelector(`[data-workbench-tab-id="${actionTarget}"]`)?.classList.contains('workbench-tab--active')).toBe(true)
  expect(originalTerminal?.isConnected).toBe(true)
  expect(editor?.isConnected).toBe(true)
  await act(async () => useAppStore.getState().requestCloseTab('workspace', targetGroup.id, actionTarget))
  expect(useAppStore.getState().closeTabRequest).toBeNull()
  const confirmation = document.querySelector('.confirmation-dialog')
  expect(confirmation?.textContent).toContain('Stop Agent Session?')
  expect(confirmation?.textContent).toContain('Keep Session & Close')
  const cancel = confirmation?.querySelector<HTMLButtonElement>('.confirmation-dialog__cancel')
  expect(cancel).not.toBeNull()
  await act(async () => cancel!.click())
  expect(document.querySelector('.confirmation-dialog')).toBeNull()
  expect(useAppStore.getState().tabs[actionTarget]).toBe(original.tabs[actionTarget])
  expect(useAppStore.getState().agentComposerDrafts['owned-0']).toBe('Original unsent draft')
  expect(useAppStore.getState().sessions.filter(session => session.id.startsWith('owned-')).map(session => session.control.run.runId)).toEqual(original.sessions.map(session => session.control.run.runId))
})

function tabDemandProbe() {
  const orders: { workspaceId: string; groupId: string; items: readonly string[] }[] = []
  const ranges: { order: readonly string[]; target: string; scope: string }[] = []
  const requests: (readonly string[])[] = []
  vi.stubGlobal('__workbenchTabDemandProbe', {
    order(workspaceId: string, groupId: string, items: readonly string[]) { orders.push({ workspaceId, groupId, items }) },
    range(order: readonly string[], target: string, scope: string) { ranges.push({ order, target, scope }) },
    request(ids: string[]) { requests.push(ids) }
  })
  return { orders, ranges, requests }
}
const tabButton = (id: string) => {
  const button = dom.container.querySelector<HTMLButtonElement>(`[data-workbench-tab-id="${id}"]`)
  expect(button).not.toBeNull()
  return button!
}
async function tabMenu(id: string) {
  await act(async () => tabButton(id).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 80, clientY: 20 })))
  const item = (label: string) => {
    const node = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent?.trim() === label)
    expect(node, label).toBeDefined()
    return node!
  }
  return item
}
async function cancelTabClose() {
  const cancel = document.querySelector<HTMLButtonElement>('.confirmation-dialog__cancel')
  expect(cancel).not.toBeNull()
  await act(async () => cancel!.click())
  expect(document.querySelector('.confirmation-dialog')).toBeNull()
}

it.each([4, 24])('keeps actual Tab demand stable through selection with %i tabs', async count => {
  const original = fixture(count), probe = tabDemandProbe()
  await dom.render(<WorkspaceWorkbench workspaceId="workspace" />)
  expect(dom.container.querySelectorAll('button[data-workbench-tab-id]')).toHaveLength(count)
  expect(probe.orders.length).toBeGreaterThan(0)
  const order = probe.orders.at(-1)!.items
  expect(order).toEqual(original.layout.groups[0]!.tabOrder)
  expect(probe.ranges).toHaveLength(0)
  const before = useAppStore.getState(), terminal = document.querySelector('[data-original-terminal]')
  const editor = document.querySelector('.tiptap'), button = tabButton('tab-1')
  probe.orders.length = 0
  await act(async () => button.click())
  const state = useAppStore.getState()
  expect(state.layouts.workspace!.groups[0]!.activeTabId).toBe('tab-1')
  expect(state.workbenchSpaceSelection).toMatchObject({ workspaceId: 'workspace', groupId: original.layout.groups[0]!.id, tabId: 'tab-1' })
  expect(button.classList.contains('workbench-tab--active')).toBe(true)
  expect(probe.orders.length).toBeGreaterThan(0)
  expect(probe.orders.every(value => value.items === order)).toBe(true)
  expect(probe.ranges).toHaveLength(0)
  expect(state.tabs).toBe(before.tabs)
  expect(state.layouts.workspace!.groups[0]!.tabOrder).toBe(before.layouts.workspace!.groups[0]!.tabOrder)
  expect(state.agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(state.sessions.map(session => session.control.run.runId)).toEqual(before.sessions.map(session => session.control.run.runId))
  expect(document.querySelector('[data-original-terminal]')).toBe(terminal)
  expect(terminal?.isConnected).toBe(true); expect(editor?.isConnected).toBe(true)
  await act(async () => useAppStore.getState().setAgentComposerDraft('unrelated-draft', 'Unrelated original draft'))
  expect(probe.orders.every(value => value.items === order)).toBe(true)
  expect(probe.ranges).toHaveLength(0)
  const menu = await tabMenu('tab-1')
  expect(probe.ranges).toHaveLength(0)
  expect(menu('Close Tabs to the Left').hasAttribute('data-disabled')).toBe(false)
  await act(async () => menu('Close Tabs to the Left').click())
  expect(probe.ranges).toEqual([{ order: original.layout.groups[0]!.tabOrder, target: 'tab-1', scope: 'left' }])
  expect(probe.requests).toEqual([['tab-0']])
  expect(document.querySelector('.confirmation-dialog')?.textContent).toContain('Stop Agent Session?')
  await cancelTabClose()
  expect(useAppStore.getState().tabs).toBe(before.tabs)
  expect(useAppStore.getState().agentComposerDrafts['owned-0']).toBe('Original unsent draft')
  expect(useAppStore.getState().sessions.map(session => session.control.run.runId)).toEqual(before.sessions.map(session => session.control.run.runId))
})

it('uses original close ranges when a pinned Tab has a different display order', async () => {
  const original = fixture(4), probe = tabDemandProbe(), groupId = original.layout.groups[0]!.id
  const reference = { hostId: 'local', sessionId: 'owned-3', displayWorkspaceId: 'workspace', groupId, tabId: 'tab-3', regionId: 'region-3' }
  const context = { workspace: composerConfig.workspaces[0]!, topic: { id: 'original-topic', directoryPath: 'original-topic', topicPath: 'original-topic/topic.md', title: 'Original Mote', summary: '', collaborators: [] },
    rootPath: '', floating: false, defaultConversation: reference,
    selectTab: (id: string, group: string) => useAppStore.getState().activateTab('workspace', group, id, 'local') }
  const render = (pinned: boolean) => <MoteWorkfaceContext.Provider value={pinned ? context : { ...context, defaultConversation: undefined }}><WorkspaceWorkbench workspaceId="workspace" /></MoteWorkfaceContext.Provider>
  await dom.render(render(true))
  const order = probe.orders.at(-1)!.items
  expect(order).toEqual(['tab-3', 'tab-0', 'tab-1', 'tab-2'])
  probe.orders.length = 0
  await act(async () => tabButton('tab-2').click())
  expect(probe.orders.length).toBeGreaterThan(0)
  expect(probe.orders.every(value => value.items === order)).toBe(true)
  expect(probe.ranges).toHaveLength(0)
  for (const [label, scope, ids] of [['Close Tabs to the Left', 'left', ['tab-0', 'tab-1']],
    ['Close Others', 'others', ['tab-0', 'tab-1', 'tab-3']], ['Close Tabs to the Right', 'right', ['tab-3']]] as const) {
    const menu = await tabMenu('tab-2')
    expect(probe.ranges).toHaveLength(probe.requests.length)
    await act(async () => menu(label).click())
    expect(probe.ranges.at(-1)).toEqual({ order: original.layout.groups[0]!.tabOrder, target: 'tab-2', scope })
    expect(probe.requests.at(-1)).toEqual(ids)
    if (scope === 'right') {
      // The original close owner protects the pinned conversation, despite its different display order.
      expect(document.querySelector('.confirmation-dialog')).toBeNull()
      expect(useAppStore.getState().error).toContain('The default conversation stays open')
    } else {
      expect(document.querySelector('.confirmation-dialog')?.textContent).toContain('Stop 2 Agent Sessions?')
      await cancelTabClose()
    }
    expect(useAppStore.getState().tabs).toBe(original.tabs)
  }
  await dom.render(render(false))
  expect(probe.orders.at(-1)!.items).toEqual(original.layout.groups[0]!.tabOrder)
  expect(probe.orders.at(-1)!.items).not.toBe(order)
  const first = await tabMenu('tab-0')
  expect(first('Close Tabs to the Left').hasAttribute('data-disabled')).toBe(true)
  await act(async () => first('Close Tabs to the Left').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  const last = await tabMenu('tab-3')
  expect(last('Close Tabs to the Right').hasAttribute('data-disabled')).toBe(true)
  expect(probe.ranges).toHaveLength(3)
  expect(useAppStore.getState().sessions.filter(session => session.id.startsWith('owned-')).map(session => session.control.run.runId)).toEqual(original.sessions.map(session => session.control.run.runId))
})

function Reactions({ id, enabled }: { id: string; enabled: boolean }) {
  const render = useConversationReactions(id, enabled)
  return <div data-reaction-owner={id}>{render({ kind: 'native', agentSessionId: id, providerId: 'codex', nativeSessionId: `native-${id}`, recordId: 'reply' })}</div>
}
it('keeps reaction provider/config/queue facts live while hidden and after reveal', async () => {
  fixture(1)
  await dom.render(<Reactions id="owned-0" enabled={false} />)
  expect(dom.container.querySelector('.conversation-reactions')).toBeNull()
  const only = { ...PROMPT_REACTION_STARTERS[0]!, providerId: 'traex' }
  await act(async () => useAppStore.setState(state => ({ config: { ...state.config!, composerShortcuts: [only] },
    sessions: state.sessions.map(session => session.kind === 'agent' && session.id === 'owned-0' ? { ...session, providerId: 'traex' } : session) })))
  await dom.render(<Reactions id="owned-0" enabled />)
  expect(dom.container.querySelectorAll('.conversation-reactions__choice')).toHaveLength(1)
  await act(async () => useAppStore.setState({ agentSteerQueues: { 'owned-0': [{ operationId: 'original-reaction', text: only.body,
    status: 'failed', promptCondition: null, error: 'Original reaction delivery is unknown', reaction: { code: only.keyword,
      replySource: { kind: 'native', agentSessionId: 'owned-0', providerId: 'codex', nativeSessionId: 'native-owned-0', recordId: 'reply' } } }] } }))
  expect(dom.container.textContent).toContain('Original reaction delivery is unknown')
  await act(async () => useAppStore.setState(state => ({ config: { ...state.config!, composerShortcuts: [] } })))
  expect(dom.container.querySelector('.conversation-reactions')).toBeNull()
})
function Attention() { useAgentAttentionNotifications(); return null }
it.each([1, 32, 100])('reuses structural visibility but reconciles current attention facts at %i Tabs', async count => {
  const f = fixture(count)
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  const notify = vi.spyOn(api.ui, 'notifyAgentAttention').mockResolvedValue({ status: 'delivered', requestedMode: 'normal', actualMode: 'normal' } as never)
  vi.spyOn(api.ui, 'setAgentAttentionCount').mockResolvedValue(true)
  await dom.render(<Attention />)
  await status('unrelated', 'working')
  reset(); notify.mockClear()
  await status('unrelated', 'waiting', Date.now() + 1)
  sample('attention', count, { notifications: notify.mock.calls.length })
  expect(counts().visibility ?? 0).toBe(0)
  expect(notify).toHaveBeenCalledTimes(1)
  // A real active Tab change invalidates the cached structure. The newly visible
  // Session must be suppressed; the old front Session is now off screen.
  const other = createWorkbenchTab('new-tab', { kind: 'agent', phase: 'attached', workspaceId: 'workspace', regionId: 'new-region', sessionId: 'new-visible' })
  await act(async () => useAppStore.setState(state => ({ tabs: { ...state.tabs, [other.id]: other },
    layouts: { workspace: { ...f.layout, groups: f.layout.groups.map(group => ({ ...group, tabOrder: [...group.tabOrder, other.id], activeTabId: other.id })) } },
    sessions: [...state.sessions, { ...composerSession('new-visible'), status: { state: 'working', source: 'native-hook', observedAt: Date.now() } }] })))
  expect(counts().visibility).toBeGreaterThan(0)
  notify.mockClear(); reset()
  await status('new-visible', 'done', Date.now() + 2)
  expect(notify).not.toHaveBeenCalled()
  await status('owned-0', 'done', Date.now() + 3)
  expect(notify).toHaveBeenCalledTimes(1)
  expect(counts().visibility ?? 0).toBe(0)
})

it.each([1, 32, 100])('reuses unrelated global Session notice projections and fingerprints at %i Sessions', async count => {
  fixture(count)
  await dom.render(<GlobalSystemNotices />)
  expect(dom.container.querySelector('.global-system-notices')).not.toBeNull()
  reset()
  await status('unrelated', 'working')
  sample('global-notices', count)
  expect(counts().sessionNotices).toBe(1)
  // The changed Session may own new notices; every other original notice keeps
  // its view object and does not hash its complete text again.
  expect(counts().fingerprintHash ?? 0).toBeLessThanOrEqual(2)
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === 'owned-0' ? {
    ...session, timelineObservation: { code: 'ORIGINAL_HISTORY_FAULT', message: 'New original Session history fault', run: session.control.run }
  } : session) })))
  await toggleNotificationCenter(dom.container, 'open')
  const groupId = JSON.stringify(['agents', JSON.stringify(['agent', 'local', 'owned-0', 'run-owned-0'])])
  const group = [...dom.container.querySelectorAll<HTMLElement>('.notification-group')].find(item => item.dataset.groupId === groupId)
  expect(group).toBeDefined()
  const more = group!.querySelector<HTMLButtonElement>('.notification-group__more[aria-expanded="false"]')
  if (more) await act(async () => more.click())
  const notice = currentNotificationRows(dom.container).find(row => row.dataset.noticeId === JSON.stringify(['local', 'owned-0', 'timeline-observation']))
  expect(notice).toBeDefined()
  await toggleNotificationDetails(notice!)
  expect(dom.container.textContent).toContain('New original Session history fault')
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => {
    if (session.kind !== 'agent' || session.id !== 'owned-0') return session
    const { timelineObservation: _resolved, ...retained } = session
    return retained
  }) })))
  expect(dom.container.textContent).not.toContain('New original Session history fault')
  expect(useAppStore.getState().agentComposerDrafts['owned-0']).toBe('Original unsent draft')
})

it('invalidates notice time boundaries and exact read identity without caching a business verdict', () => {
  const now = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(now)
  const session = { ...composerSession('clock'), status: { state: 'working' as const, source: 'native-hook' as const, observedAt: now } }
  const select = createSessionServiceNoticeSelector()
  expect(select(session).some(item => item.id === 'activity-observation')).toBe(false)
  const first = select(session)
  expect(select(session)).toBe(first)
  clock.mockReturnValue(now + msUntilSemanticStatusStale(session.status, now) + 1)
  expect(select(session).some(item => item.id === 'activity-observation')).toBe(true)
  const notice: ServiceNoticeItem = { id: 'original', notice: { kind: 'indeterminate', notice: { step: 'Original', mode: 'Original cause', restore: 'Retry original' } } }
  const fingerprint = serviceNoticeFingerprint(notice)
  expect(serviceNoticeFingerprint(notice)).toBe(fingerprint)
  notice.notice.notice.mode = 'Changed cause'
  expect(serviceNoticeFingerprint(notice)).not.toBe(fingerprint)
  const changed = serviceNoticeFingerprint(notice)
  notice.observedAt = now + 1
  expect(serviceNoticeFingerprint(notice)).toBe(changed)
  notice.cause = 'exact-owner-cause'
  const owned = serviceNoticeFingerprint(notice)
  notice.notice.notice.mode = 'New display metadata'
  expect(serviceNoticeFingerprint(notice)).toBe(owned)
})

it.each([1, 32, 100])('shares exact previous/current immutable Session indexes across %i consumers', count => {
  let reads = 0
  const previous = Array.from({ length: count }, (_, i) => new Proxy(composerSession(`before-${i}`), {
    get(target, key, receiver) { if (key === 'id') reads++; return Reflect.get(target, key, receiver) }
  }))
  const current = [...previous, composerSession('new')]
  sessionPresentationById(previous); sessionPresentationById(current)
  reset(); reads = 0
  for (let i = 0; i < count; i++) {
    expect(sessionPresentationById(previous).get('before-0')).toBe(previous[0])
    expect(sessionPresentationById(current).get('new')?.id).toBe('new')
  }
  sample('session-index', count, { idReads: reads })
  expect(reads).toBe(0)
})

type ResourceContextProbe = {
  phase: string
  counts: Record<string, Counts>
  count(kind: string, stage: string, regionId: string): void
}
const resourceProbe: ResourceContextProbe = (globalThis as typeof globalThis & { __rendererResourceContextProbe: ResourceContextProbe }).__rendererResourceContextProbe = {
  phase: '', counts: {},
  count(kind, stage, regionId) {
    if (!this.phase) return
    const row = this.counts[this.phase] ??= {}, key = `${kind}:${stage}:${regionId}`
    row[key] = (row[key] ?? 0) + 1
  }
}
let updateResourceParking: (value: ReadonlySet<string>) => void
let updateResourceRelease: (value: SurfaceMemoryBudgetState) => void
let updateResourceConfirmation: (value: BrowserControlConfirmation) => void
let originalResourceConfirmation: BrowserControlConfirmation
function ResourceContextWorkbench() {
  const [parked, setParked] = useState<ReadonlySet<string>>(new Set())
  const [released, setReleased] = useState<SurfaceMemoryBudgetState>({ monacoRegionIds: new Set(), browserRegionIds: new Set() })
  const [confirmation, setConfirmation] = useState<BrowserControlConfirmation>(() => originalResourceConfirmation)
  updateResourceParking = setParked; updateResourceRelease = setReleased
  updateResourceConfirmation = value => setConfirmation(() => value)
  const child = useMemo(() => <WorkspaceWorkbench workspaceId="workspace" onBrowserControlConfirmation={confirmation} />, [confirmation])
  return <SurfaceMemoryBudgetProvider state={released}><TerminalParkingProvider parkedRegionIds={parked}>{child}</TerminalParkingProvider></SurfaceMemoryBudgetProvider>
}
const resourceRegion = (id: string) => dom.container.querySelector<HTMLElement>(`[data-workbench-region-id="${id}"]`)!
const settleResources = async () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve() })
function resourceContextFixture(count: number) {
  const sessions = ['resource-affected', 'resource-unrelated'].map(id => composerSession(id))
  const tabs: Record<string, WorkbenchTab> = Object.fromEntries(sessions.map(session => {
    const tab = createWorkbenchTab(session.id, { kind: 'agent', phase: 'attached', workspaceId: 'workspace', regionId: `region-${session.id}`, sessionId: session.id })
    return [tab.id, tab]
  }))
  const documents: ReturnType<typeof useAppStore.getState>['documents'] = {}
  const fileIds: string[] = [], browserIds: string[] = []
  for (let i = 0; i < count; i++) {
    const id = `resource-other-${i}`, regionId = `region-${id}`
    const tab = createWorkbenchTab(id, i % 2 === 0
      ? { kind: 'file', workspaceId: 'workspace', regionId, path: `original-${i}.ts` }
      : { kind: 'browser', workspaceId: 'workspace', regionId, browserId: `browser-${i}`, id: `browser-${i}`,
        mode: 'normal', navigationId: `navigation-${i}`, profileId: 'original-profile', viewport: 'responsive',
        url: `https://example.test/original-${i}`, title: `Original Browser ${i}`, loading: false,
        canGoBack: false, canGoForward: false, error: null, driving: false, appLinkPrompt: null })
    tabs[id] = tab
    if (i % 2 === 0) {
      fileIds.push(regionId)
      documents[documentKey('workspace', `original-${i}.ts`)] = { path: `original-${i}.ts`, content: `Original unsaved file ${i}`, revision: 'original' }
    } else browserIds.push(regionId)
  }
  useAppStore.setState({ config: composerConfig, loading: false, sessions, tabs,
    layouts: { workspace: createWorkspaceLayout('group', Object.keys(tabs)) }, mainSurface: 'workbench', activeWorkspaceId: 'workspace',
    agentNames: {}, sessionNameMetadata: {}, pendingAgentLaunches: {}, recoveryCandidates: [],
    viewModes: { 'resource-affected': 'terminal', 'resource-unrelated': 'terminal' }, timelines: {}, documents,
    dirtyDocuments: Object.fromEntries(Object.keys(documents).map(key => [key, true])), documentIssues: {},
    agentComposerDrafts: { 'resource-affected': 'Affected original draft', 'resource-unrelated': 'Unrelated original draft' },
    agentSteerQueues: {}, agentSteerInFlight: {}, scratchTopicSnapshots: {}, noticeReadReceipts: {},
    runtimeEndpointWarnings: [], runtimeOwnershipWarnings: [], environmentWarning: undefined,
    displacedAgentSessionIds: [], notificationEvents: [], error: null, errorNoticeContext: null,
    workbenchSaveWarning: null, nameSaveUnconfirmed: null, nameEditFailure: null, desktopNavigationNotice: null })
  return { fileIds, browserIds }
}
function preserveResourceWorkface(original: ReturnType<typeof resourceContextFixture>) {
  const state = useAppStore.getState(), node = resourceRegion('region-resource-unrelated')
  const editor = node.querySelector<HTMLElement>('.tiptap')!
  expect(editor?.textContent).toBe('Unrelated original draft')
  const selection = document.getSelection()!, range = document.createRange()
  range.selectNodeContents(editor); selection.removeAllRanges(); selection.addRange(range)
  const files = original.fileIds.map(id => resourceRegion(id).querySelector<HTMLElement>('[data-native-editor-substitute]')!)
  for (const file of files) { expect(file).not.toBeNull(); file.scrollTop = 43 }
  const browsers = original.browserIds.map(id => resourceRegion(id).querySelector<HTMLInputElement>('input')!)
  for (const input of browsers) expect(input).not.toBeNull()
  return { state, node, editor, files, browsers, selectionText: selection.toString(), anchor: selection.anchorNode,
    focus: selection.focusNode, anchorOffset: selection.anchorOffset, focusOffset: selection.focusOffset }
}
function unchangedResourceWorkface(original: ReturnType<typeof resourceContextFixture>, saved: ReturnType<typeof preserveResourceWorkface>) {
  const state = useAppStore.getState(), selection = document.getSelection()!
  for (const key of ['tabs', 'layouts', 'sessions', 'documents', 'agentComposerDrafts'] as const) expect(state[key]).toBe(saved.state[key])
  expect(resourceRegion('region-resource-unrelated')).toBe(saved.node)
  expect(saved.node.querySelector('.tiptap')).toBe(saved.editor); expect(saved.editor.textContent).toBe('Unrelated original draft')
  expect(selection.toString()).toBe(saved.selectionText)
  expect(selection.anchorNode).toBe(saved.anchor); expect(selection.focusNode).toBe(saved.focus)
  expect(selection.anchorOffset).toBe(saved.anchorOffset); expect(selection.focusOffset).toBe(saved.focusOffset)
  original.fileIds.forEach((id, i) => {
    expect(resourceRegion(id).querySelector('[data-native-editor-substitute]')).toBe(saved.files[i]); expect(saved.files[i]!.scrollTop).toBe(43)
  })
  original.browserIds.forEach((id, i) => expect(resourceRegion(id).querySelector('input')).toBe(saved.browsers[i]))
}
function currentResourceBrowser(): BrowserWorkbenchSurface {
  const value = useAppStore.getState().tabs['resource-other-1']?.regions['region-resource-other-1']
  if (value?.kind !== 'browser') throw new Error('Original Browser Region is required')
  return value
}
function resourceBrowserSnapshot(value: BrowserWorkbenchSurface): BrowserSnapshot {
  return { id: value.id, mode: value.mode, navigationId: value.navigationId, profileId: value.profileId, viewport: value.viewport,
    url: value.url, title: value.title, loading: value.loading, canGoBack: value.canGoBack, canGoForward: value.canGoForward,
    error: value.error, driving: value.driving, appLinkPrompt: value.appLinkPrompt }
}

it('keeps unrelated resource-context bodies quiet while original Workbench facts and controls remain live', async () => {
  vi.spyOn(api.continuousProgress, 'list').mockResolvedValue([])
  vi.spyOn(api.continuousProgress, 'pauseForInput').mockResolvedValue(undefined)
  const source = (reference: { agentSessionId: string }) => ({ providerId: 'codex', nativeSessionId: `source-${reference.agentSessionId}` })
  vi.spyOn(api.sessions, 'observeHistory').mockImplementation(async reference => ({ source: source(reference), dispose() {} }))
  vi.spyOn(api.sessions, 'historyPage').mockImplementation(async reference => ({ agentSessionId: reference.agentSessionId, source: source(reference), items: [], nextCursor: null }))
  vi.spyOn(api.sessions, 'readHistory').mockImplementation(async (reference, input) => ({ ...reference, source: input.source,
    kind: 'user-message', revision: 'a'.repeat(64), availability: 'empty', order: 'newest-first', items: [], userMessages: [],
    budgetBytes: 128 * 1024, scan: { examined: 0, complete: true }, nextCursor: null }))
  vi.spyOn(api.browser, 'registerPresentation').mockImplementation(async input => ({ leaseId: `original-${input.occurrence.presentationId}` }))
  vi.spyOn(api.browser, 'updatePresentation').mockResolvedValue(undefined)
  vi.spyOn(api.browser, 'removePresentation').mockResolvedValue(undefined)
  vi.spyOn(api.browser, 'setBounds').mockResolvedValue(undefined)
  vi.spyOn(api.browser, 'cancelElementSelection').mockResolvedValue(undefined)
  const release = vi.spyOn(api.browser, 'release').mockImplementation(async (browserId, navigationId) => ({ browserId, navigationId, status: 'released', reasons: [] }))
  const restore = vi.spyOn(api.browser, 'restore').mockImplementation(async () => resourceBrowserSnapshot(currentResourceBrowser()))
  for (const count of [1, 12]) {
    resourceProbe.phase = ''; originalResourceConfirmation = vi.fn()
    const original = resourceContextFixture(count)
    await dom.render(<ResourceContextWorkbench key={count} />); await settleResources()
    await vi.waitFor(() => expect(document.querySelectorAll('[data-original-terminal]')).toHaveLength(2))
    const originalTty = resourceRegion('region-resource-unrelated').querySelector('[data-original-terminal]')
    await dom.click('button[data-workbench-tab-id="resource-unrelated"]')
    await act(async () => useAppStore.getState().setViewMode('resource-unrelated', 'activity', { focus: false }))
    await settleResources()
    await vi.waitFor(() => expect(resourceRegion('region-resource-unrelated').querySelector('.tiptap')).not.toBeNull())
    expect(resourceRegion('region-resource-unrelated').querySelector('[data-original-terminal]')).toBe(originalTty)
    await dom.click('button[data-workbench-tab-id="resource-affected"]'); await settleResources()
    await vi.waitFor(() => expect(document.querySelectorAll('[data-native-editor-substitute]')).toHaveLength(original.fileIds.length))
    const saved = preserveResourceWorkface(original)
    async function parking(phase: string, values: ReadonlySet<string>): Promise<Counts> {
      const key = `${count}:${phase}`; resourceProbe.phase = key; resourceProbe.counts[key] = {}
      await act(async () => updateResourceParking(values)); await settleResources(); resourceProbe.phase = ''
      unchangedResourceWorkface(original, saved)
      return resourceProbe.counts[key]!
    }
    expect(await parking('equal-empty', new Set())).toEqual({})
    for (const [phase, values] of [['park', new Set(['region-resource-affected'])], ['unpark', new Set<string>()]] as const) {
      const row = await parking(phase, values)
      for (const id of ['region-resource-unrelated', ...original.fileIds, ...original.browserIds]) {
        expect(row[`wrapper:render:${id}`], 'real shared context delivery must execute').toBeGreaterThan(0)
        for (const kind of ['body', 'session', 'file', 'browser']) for (const stage of ['render', 'commit']) {
          expect.soft(row[`${kind}:${stage}:${id}`] ?? 0, `${phase} unrelated ${kind} ${stage} ${id}`).toBe(0)
        }
      }
      expect(row['body:render:region-resource-affected']).toBeGreaterThan(0)
      expect(row['session:commit:region-resource-affected']).toBeGreaterThan(0)
      expect(Boolean(resourceRegion('region-resource-affected').querySelector('[data-original-terminal]'))).toBe(phase === 'unpark')
      if (phase === 'park') {
        expect(resourceRegion('region-resource-affected').textContent).toContain('Terminal parked')
        expect(await parking('equal-parked', new Set(['region-resource-affected']))).toEqual({})
      }
      sample('resource-context', count, { phase, resourceCounts: row, originalDomDraftRangeAndScrollPreserved: true })
    }
    if (count === 12) {
      const originalFile = resourceRegion(original.fileIds[0]!)
      await act(async () => updateResourceRelease({ monacoRegionIds: new Set([original.fileIds[0]!]), browserRegionIds: new Set() }))
      expect(originalFile.textContent).toContain('Editor parked')
      expect(originalFile.querySelector('[data-native-editor-substitute]')).toBeNull()
      await act(async () => updateResourceRelease({ monacoRegionIds: new Set(), browserRegionIds: new Set() })); await settleResources()
      expect(originalFile.querySelector('[data-native-editor-substitute]')).not.toBeNull()
      await act(async () => useAppStore.getState().updateDocument('resource-other-0', 'Related original file changed', original.fileIds[0]!))
      expect(originalFile.querySelector('[data-native-editor-substitute]')?.textContent).toBe('Related original file changed')
      await dom.click('button[data-workbench-tab-id="resource-other-1"]'); await settleResources()
      expect(useAppStore.getState().layouts.workspace?.groups[0]?.activeTabId).toBe('resource-other-1')
      const originalAddress = resourceRegion(original.browserIds[0]!).querySelector<HTMLInputElement>('input')!
      await act(async () => useAppStore.getState().applyBrowserEvent({ type: 'updated', browser: {
        ...resourceBrowserSnapshot(currentResourceBrowser()), navigationId: 'related-new-navigation', url: 'https://example.test/changed-original'
      } })); await settleResources()
      expect(originalAddress.value).toBe('https://example.test/changed-original')
      const newConfirmation = vi.fn()
      vi.mocked(originalResourceConfirmation).mockClear()
      await act(async () => updateResourceConfirmation(newConfirmation))
      await act(async () => updateResourceRelease({ monacoRegionIds: new Set(), browserRegionIds: new Set([original.browserIds[0]!]) })); await settleResources()
      expect(release).toHaveBeenCalledWith('browser-1', 'related-new-navigation')
      expect(currentResourceBrowser().nativeOwnerReleased).toBe(true)
      await act(async () => updateResourceRelease({ monacoRegionIds: new Set(), browserRegionIds: new Set() })); await settleResources()
      expect(restore).toHaveBeenCalledWith('browser-1', expect.objectContaining({ workspaceId: 'workspace', profileId: 'original-profile' }))
      expect(newConfirmation).toHaveBeenCalledWith(original.browserIds[0]!, true)
      expect(originalResourceConfirmation).not.toHaveBeenCalled()
      expect(resourceRegion('region-resource-unrelated').querySelector('.tiptap')).toBe(saved.editor)
      expect(saved.editor.textContent).toBe('Unrelated original draft')
      sample('resource-context-positive', count, { fileReleaseAndContent: true, browserNavigationReleaseRestoreAndLatestCallback: true })
    }
    await dom.render(null); await settleResources()
  }
})
