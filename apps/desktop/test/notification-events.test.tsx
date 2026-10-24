// @vitest-environment happy-dom
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { RuntimeEvent } from '../src/shared/contracts'
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => null }))
vi.mock('../src/renderer/src/components/WorkspaceWorkbench', () => ({ WorkspaceWorkbench: () => null }))
vi.mock('../src/renderer/src/components/SurfaceToolDock', () => ({ SurfaceToolDock: () => null }))
import { App } from '../src/renderer/src/App'
import { api } from '../src/renderer/src/lib/api'
import { notificationEventIdentity, useAppStore, type ErrorNoticeContext } from '../src/renderer/src/store'
import { notificationsSettingsModule } from '../src/renderer/src/components/settings/modules/notifications'
import { providerCatalogReader, historySourcesReader } from './helpers/startup-observation-api-fixture'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { createClientUiRoot } from './helpers/client-ui-render'
import { configOwnerFixture } from './helpers/config-owner-fixture'

const initial = useAppStore.getState()
const config = { ...composerConfig, notifications: { mode: 'standard' as const, sound: false }, a2a: { notifications: 'follow-global' as const } }
const agent = (id: string) => ({ ...composerSession(id), status: { state: 'working' as const, source: 'native-hook' as const, observedAt: Date.now() } })
let root: Root, container: HTMLDivElement, settingsRoot: Root | undefined
let emit: (event: RuntimeEvent) => void
const sessions = [agent('notification-reader'), agent('notification-sender')]

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.spyOn(document, 'hasFocus').mockReturnValue(false)
  vi.spyOn(useAppStore.persist, 'hasHydrated').mockReturnValue(true)
  vi.spyOn(api.sessions, 'notifyInputOccupation').mockResolvedValue(undefined)
  vi.spyOn(api.config, 'get').mockResolvedValue(config)
  vi.spyOn(api.providers, 'list').mockImplementation(providerCatalogReader())
  vi.spyOn(api.sessions, 'historySources').mockImplementation(historySourcesReader())
  vi.spyOn(api.sessions, 'onEvent').mockImplementation(listener => { emit = listener; return () => {} })
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions, timelines: {}, recoveryCandidates: [] })
  vi.spyOn(api.ui, 'setAgentAttentionCount').mockResolvedValue(true)
  vi.spyOn(api.ui, 'notifyAgentAttention').mockResolvedValue({ status: 'shown', presentation: 'as-requested' })
  useAppStore.setState({ ...initial, loading: true }, true)
  container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container)
  await act(async () => root.render(<App />))
  await act(async () => { await vi.waitFor(() => expect(useAppStore.getState().loading).toBe(false)) })
  expect(container.querySelector('main.main-shell')).not.toBeNull()
  await act(async () => useAppStore.setState({ sessions, config, tabs: {}, layouts: { workspace: createWorkspaceLayout('present-group') },
    environmentWarning: undefined, runtimeOwnershipWarnings: [], runtimeEndpointWarnings: [], notificationEvents: [], noticeReadReceipts: {},
    error: null, lastError: null, errorNoticeContext: null, errorDismissed: false, agentComposerDrafts: { 'notification-reader': 'Keep this draft' } }))
})
afterEach(async () => {
  await act(async () => { root.unmount(); settingsRoot?.unmount() }); settingsRoot = undefined; container.remove()
  vi.restoreAllMocks(); useAppStore.setState(initial, true)
})

const records = () => useAppStore.getState().notificationEvents
const read = (id: string) => useAppStore.setState({ noticeReadReceipts: { 'global:events': { [id]: 'read' } } })
const message = (sequence: number, extra = {}): RuntimeEvent => ({ type: 'core', hostId: 'local', event: {
  type: 'agent-message-changed', messageId: `original-${sequence}`, sequence, messageSequence: sequence, live: true,
  recordKind: 'message', senderSessionId: 'notification-sender', recipientSessionId: 'notification-reader', ...extra
} })
const inboxUnavailable = (session = sessions[0]!): RuntimeEvent => ({ type: 'core', hostId: session.hostId, event: {
  type: 'agent-error', agentSessionId: session.id, code: 'A2A_NOTIFICATION_UNCONFIRMED',
  message: 'This Provider has no native input adapter for idle-only Inbox notifications. The original Inbox and healthy manual input remain available.',
  evidence: { source: 'agentmux', run: { ...session.control.run }, observedAt: 1 }
} })
async function transition(state: 'done' | 'waiting' | 'working') {
  await act(async () => useAppStore.setState(current => ({ sessions: current.sessions.map(session => session.id === 'notification-reader'
    ? { ...session, status: { state, source: 'native-hook', observedAt: Date.now() } } : session) })))
}

it('keeps same-prose unknown operations as separate received records and retains the saved identity for rendering', async () => {
  await act(async () => {
    useAppStore.getState().reportError('The selected target is unavailable')
    useAppStore.getState().reportError('The selected target is unavailable')
  })
  expect(records()).toHaveLength(2)
  expect(new Set(records().map(event => event.id)).size).toBe(2)
  expect(records().map(event => event.context?.event?.source)).toEqual(['operation', 'operation'])
  const state = useAppStore.getState()
  expect(notificationEventIdentity(state.error!, state.errorNoticeContext)).toBe(records()[1]!.id)
  expect(records().map(event => event.occurrences)).toEqual([1, 1])
})

it('A2A unavailable observations retain their original Run and dismissed notification identity through the real subscription', async () => {
  const before = useAppStore.getState()
  await act(async () => emit(inboxUnavailable()))
  expect(records()).toHaveLength(1)
  const first = records()[0]!
  expect(first.context?.subject).toEqual(sessions[0]!.control)
  expect(first.context?.event).toBeUndefined()
  expect(first.message).toContain('Last confirmed Agent state: working; Run state: running.')
  await act(async () => emit(inboxUnavailable()))
  expect(records()).toHaveLength(1)
  expect(records()[0]).toMatchObject({ id: first.id, occurrences: 2 })
  await act(async () => useAppStore.getState().dismissError())
  const dismissed = records()[0]
  await act(async () => emit(inboxUnavailable()))
  expect(records()).toEqual([dismissed])
  expect(useAppStore.getState().errorDismissed).toBe(true)
  expect(useAppStore.getState().sessions).toBe(before.sessions)
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
})

it('A2A unavailable observations cannot assign an earlier Run failure to its replacement', async () => {
  await act(async () => emit(inboxUnavailable()))
  const original = records()[0]!
  const successor = { ...sessions[0]!, control: { ...sessions[0]!.control, run: { runId: 'successor-run' } } }
  await act(async () => useAppStore.setState({ sessions: [successor, sessions[1]!] }))
  await act(async () => emit(inboxUnavailable()))
  expect(records()).toEqual([original])
  await act(async () => emit(inboxUnavailable(successor)))
  expect(records()).toHaveLength(2)
  expect(records()[0]?.context?.subject).toEqual(sessions[0]!.control)
  expect(records()[1]?.context?.subject).toEqual(successor.control)
  expect(records()[1]?.id).not.toBe(original.id)
})

it('updates receipt metadata for one producer occurrence without reviving unread; new objects, kinds and occurrences stay independent', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(1000)
  const context: ErrorNoticeContext = { kind: 'process-degraded', event: { source: 'spatial', key: 'original-operation',
    object: { kind: 'tab-group', id: 'first-group', workspaceId: 'workspace' } } }
  await act(async () => useAppStore.getState().reportError('First technical detail', context))
  const first = records()[0]!
  expect(first).toMatchObject({ firstObservedAt: 1000, lastObservedAt: 1000, occurrences: 1 })
  await act(async () => read(first.id))
  const receipts = useAppStore.getState().noticeReadReceipts
  now.mockReturnValue(3000)
  await act(async () => useAppStore.getState().reportError('Updated technical detail', context))
  expect(records()).toHaveLength(1)
  expect(records()[0]).toMatchObject({ id: first.id, message: 'Updated technical detail', firstObservedAt: 1000, lastObservedAt: 3000, occurrences: 2 })
  expect(useAppStore.getState().noticeReadReceipts).toBe(receipts)
  await act(async () => {
    useAppStore.getState().reportError('Updated technical detail', { ...context, event: { ...context.event!, object: { ...context.event!.object!, id: 'second-group' } } })
    useAppStore.getState().reportError('Updated technical detail', { ...context, event: { ...context.event!, key: 'next-operation' } })
    useAppStore.getState().reportError('Updated technical detail', { ...context, kind: 'agent-broken' })
  })
  expect(new Set(records().map(event => event.id)).size).toBe(4)
  expect(records().slice(1).every(event => !useAppStore.getState().noticeReadReceipts['global:events']?.[event.id])).toBe(true)
})

it('the real launcher producer preserves two missing Tab Groups and repeated user attempts without moving a healthy workface', async () => {
  const before = useAppStore.getState()
  await act(async () => {
    for (const tabGroupId of ['missing-first', 'missing-second', 'missing-first']) {
      useAppStore.getState().openLauncher({ workspaceId: 'workspace', tabGroupId, reveal: false })
    }
  })
  expect(records()).toHaveLength(3)
  expect(records().map(event => event.context?.event?.object)).toEqual(['missing-first', 'missing-second', 'missing-first'].map(id => ({
    kind: 'tab-group', id, workspaceId: 'workspace'
  })))
  expect(new Set(records().map(event => event.id)).size).toBe(3)
  expect(new Set(records().map(event => event.message)).size).toBe(1)
  const after = useAppStore.getState()
  expect(after.sessions).toBe(before.sessions); expect(after.tabs).toBe(before.tabs); expect(after.layouts).toBe(before.layouts)
  expect(after.agentComposerDrafts).toBe(before.agentComposerDrafts)
})

it.each(['unsupported', 'downgraded'] as const)('App attention and initialize A2A share one %s platform receipt without hiding native delivery', async kind => {
  const delivery = kind === 'unsupported' ? { status: 'unsupported' as const, reason: 'System policy declined delivery' }
    : { status: 'shown' as const, presentation: 'downgraded' as const }
  const notify = vi.mocked(api.ui.notifyAgentAttention).mockResolvedValue(delivery)
  await transition('done')
  expect(notify).toHaveBeenCalledOnce()
  expect(records()).toHaveLength(1)
  const first = records()[0]!
  expect(first.context).toMatchObject({ kind: 'process-degraded', event: { source: 'desktop-notifications',
    key: kind === 'unsupported' ? 'unsupported' : 'presentation-downgraded', object: { kind: 'application', id: 'desktop' } } })
  await act(async () => read(first.id))
  await act(async () => emit(message(1)))
  expect(notify).toHaveBeenCalledTimes(2)
  expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'notification-reader', title: 'New Agent message' }))
  expect(records()).toHaveLength(1)
  expect(records()[0]).toMatchObject({ id: first.id, occurrences: 2 })
  expect(useAppStore.getState().noticeReadReceipts['global:events']?.[first.id]).toBe('read')
  await act(async () => useAppStore.getState().clearReadNotificationEvents())
  expect(records()).toEqual([])
  await act(async () => useAppStore.getState().reportError('An unrelated operation failed'))
  const unrelated = records()[0]!
  await act(async () => emit(message(2)))
  expect(notify).toHaveBeenCalledTimes(3)
  expect(records()).toEqual([unrelated])
  expect(useAppStore.getState().agentComposerDrafts['notification-reader']).toBe('Keep this draft')
})

it('the actual A2A subscription ignores catch-up and repeated delivery and never replays a muted event', async () => {
  const notify = vi.mocked(api.ui.notifyAgentAttention)
  expect(notify).not.toHaveBeenCalled()
  await act(async () => { emit(message(1, { live: false })); emit(message(1)); emit(message(2, { recordKind: 'delivery', messageSequence: 1 })) })
  expect(notify).not.toHaveBeenCalled()
  await act(async () => {
    useAppStore.setState({ config: { ...config, notifications: { mode: 'off', sound: false } } })
    emit(message(3))
  })
  await act(async () => { useAppStore.setState({ config }); emit(message(3)) })
  expect(notify).not.toHaveBeenCalled()
  await act(async () => emit(message(4)))
  expect(notify).toHaveBeenCalledOnce()
})

it('Dock failure observations share one occurrence until a successful native receipt, then a new failure is unread', async () => {
  const badge = vi.mocked(api.ui.setAgentAttentionCount)
  badge.mockRejectedValueOnce(new Error('Native badge failed')).mockRejectedValueOnce(new Error('Native badge still failed'))
  await transition('waiting')
  expect(records()).toHaveLength(1)
  const first = records()[0]!
  await act(async () => read(first.id))
  await transition('waiting')
  expect(records()).toHaveLength(1)
  expect(records()[0]).toMatchObject({ id: first.id, occurrences: 2 })
  await transition('waiting')
  expect(badge).toHaveBeenLastCalledWith(1)
  badge.mockRejectedValueOnce(new Error('Native badge failed again'))
  await transition('done')
  expect(records()).toHaveLength(2)
  expect(records()[1]!.id).not.toBe(first.id)
  expect(records()[1]!.occurrences).toBe(1)
  expect(useAppStore.getState().noticeReadReceipts['global:events']?.[records()[1]!.id]).toBeUndefined()
})

it('the real Notifications settings module scopes banners, saves only its draft and keeps pending attention and current issues', async () => {
  const save = vi.spyOn(api.config, 'save').mockImplementation(async next => next)
  const before = useAppStore.getState()
  const settings = document.createElement('div'); container.append(settings); settingsRoot = createClientUiRoot(settings)
  await act(async () => settingsRoot!.render(<notificationsSettingsModule.Pane config={config} active={true} onClose={() => {}} onNavigate={() => {}} />))
  expect(settings.textContent).toContain('Current issues in the notification center and requests in Focus stay available when banners are off')
  expect(settings.textContent).toContain('Agent message alerts follow your A2A preference')
  const checkbox = settings.querySelector<HTMLInputElement>('input[type="checkbox"]')!
  await act(async () => checkbox.click())
  const button = settings.querySelector<HTMLButtonElement>('.primary-button')!
  await act(async () => button.click())
  expect(save).toHaveBeenCalledExactlyOnceWith({ ...config, notifications: { mode: 'standard', sound: true } }, config)
  expect(useAppStore.getState().sessions).toBe(before.sessions)
  expect(useAppStore.getState().notificationEvents).toBe(before.notificationEvents)
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
})

it('saves shared sound with Agent status banners off and delivers enabled A2A alerts with that exact preference', async () => {
  const owner = await configOwnerFixture({ ...config, notifications: { mode: 'off', sound: false }, a2a: { notifications: 'notify' } })
  const offConfig = owner.owner.current
  const publish = owner.publish.getMockImplementation()!
  owner.publish.mockImplementation(next => { publish(next); useAppStore.getState().setConfig(next) })
  await act(async () => useAppStore.setState({ config: offConfig }))
  const save = vi.spyOn(api.config, 'save').mockImplementation((next, expected) => owner.owner.edit(expected, next))
  const settings = document.createElement('div'); container.append(settings); settingsRoot = createClientUiRoot(settings)
  await act(async () => settingsRoot!.render(<notificationsSettingsModule.Pane config={offConfig} active={true} onClose={() => {}} onNavigate={() => {}} />))
  const checkbox = settings.querySelector<HTMLInputElement>('input[type="checkbox"]')!
  expect(checkbox.disabled).toBe(false)
  expect(settings.textContent).toContain('Applies to Agent status banners and enabled A2A message alerts')
  await act(async () => checkbox.click())
  await act(async () => settings.querySelector<HTMLButtonElement>('.primary-button')!.click())
  await act(async () => { await save.mock.results.at(-1)!.value })
  expect(save).toHaveBeenCalledExactlyOnceWith({ ...offConfig, notifications: { mode: 'off', sound: true } }, offConfig)
  expect((await owner.disk()).notifications).toEqual({ mode: 'off', sound: true })
  const notify = vi.mocked(api.ui.notifyAgentAttention)
  notify.mockClear()
  await transition('done')
  expect(notify).not.toHaveBeenCalled()
  await act(async () => emit(message(1)))
  expect(notify).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ title: 'New Agent message', mode: 'standard', sound: true }))
})
