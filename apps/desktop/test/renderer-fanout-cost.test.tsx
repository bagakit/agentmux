// @vitest-environment happy-dom
import { act, Profiler } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { homedir } from 'node:os'
import { appendFileSync } from 'node:fs'
import { createWorkspaceLayout } from '@agentmux/layout'
import { PROMPT_REACTION_STARTERS } from '@agentmux/core/prompt-reaction'
import { msUntilSemanticStatusStale } from '@agentmux/core/agent-status'
import { WorkspaceWorkbench } from '../src/renderer/src/components/WorkspaceWorkbench'
import { GlobalSystemNotices } from '../src/renderer/src/components/GlobalSystemNotices'
import { useAgentAttentionNotifications } from '../src/renderer/src/hooks/useAgentAttentionNotifications'
import { useConversationReactions } from '../src/renderer/src/lib/conversation-reactions'
import { createSessionServiceNoticeSelector } from '../src/renderer/src/lib/session-service-notices'
import { serviceNoticeFingerprint, type ServiceNoticeItem } from '../src/renderer/src/lib/use-service-notices'
import { sessionPresentationById } from '../src/renderer/src/lib/session-presentation'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { sessionNameMetadataKey } from '../src/renderer/src/lib/session-name-metadata'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'

// The retained product chain stays real through SessionPane and Composer. Only
// the native Terminal leaf is unavailable in happy-dom; Native proof owns it.
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div data-original-terminal /> }))

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
