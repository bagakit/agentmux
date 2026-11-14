// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { ContinuousProgressLoop } from '@agentmux/core/continuous-progress-scheduler'
import type { MotePresenceReading } from '@agentmux/core/mote-preferences'
import { AGENTMUX_CONTROL_SCHEMA_VERSION, parseClientNotificationsObservation } from '@agentmux/core/control'
import { GlobalSystemNotices } from '../src/renderer/src/components/GlobalSystemNotices'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { observeNotifications } from '../src/renderer/src/lib/notification-observation'
import { normalizeNotificationReadReceipts } from '../src/renderer/src/lib/notification-read-identity'
import { moteHeartbeatNotice } from '../src/renderer/src/lib/mote-heartbeat-notice'
import { moteConnectionTarget } from '../src/renderer/src/lib/mote-connection-default'
import { subscribeMoteHeartbeatInspection, useMoteHeartbeatReading, type MoteHeartbeatInspection } from '../src/renderer/src/lib/mote-heartbeat-reading'
import type { MoteWorkfaceScope } from '../src/renderer/src/lib/mote-workface'
import { composerDOM } from './helpers/composer-dom-fixture'
import { notificationTrigger, toggleNotificationCenter, toggleNotificationDetails } from './helpers/notification-center'
import { defaultAgent, defaultTab, moteTopics, scratchWorkspace, seedMoteWorkface } from './fixtures/mote-workface'
import { scratchTopicDirectoryName } from '@agentmux/host/mote-model'

const dom = composerDOM()
const scope: MoteWorkfaceScope = { topic: moteTopics[0]!, workspace: scratchWorkspace, rootPath: scratchTopicDirectoryName(moteTopics[0]!.id) }
const otherScope: MoteWorkfaceScope = { topic: moteTopics[1]!, workspace: scratchWorkspace, rootPath: scratchTopicDirectoryName(moteTopics[1]!.id) }
const reference = { hostId: defaultAgent.hostId, sessionId: defaultAgent.id, displayWorkspaceId: scratchWorkspace.id,
  groupId: 'mote-group', tabId: defaultTab.id, regionId: defaultTab.layout.activeRegionId }
const originalLoop = (): ContinuousProgressLoop => ({ loopId: 'original-watch-arrangement', hostId: defaultAgent.hostId,
  agentSessionId: defaultAgent.id, providerId: defaultAgent.providerId, workspacePath: defaultAgent.workspacePath,
  managedSource: { sourceId: 'original-mote-source', revision: 'original-main-role' }, everyMs: 1800000, intervalMs: 1800000,
  futureIntentId: 'original-standing-intent', creationOperationId: 'original-arrangement-creation',
  prompt: 'Original authorized check', nextCheckAt: 1794376800000, revision: 3, status: 'paused',
  lastTickAt: 1794372000000, lastOutcome: 'unknown', lastDecision: 'Original input delivery is not confirmed.',
  pause: { reason: 'input-unconfirmed', episodeId: 'original-pause-episode', pausedAt: 1794372300000 },
  pendingCompletion: { id: 'original-occurrence', operationId: 'original-input', condition: { expectedRun: defaultAgent.control.run, afterSubmissionId: null } } })
let maintenance: MotePresenceReading
let presenceEnabled: boolean
let currentReading: ReturnType<typeof useMoteHeartbeatReading>
function Reader({ value = scope }: { value?: MoteWorkfaceScope }) { const reading = useMoteHeartbeatReading(value, true); if (value.topic.id === scope.topic.id) currentReading = reading; return null }
function Surface({ mounted = true, value = scope }: { mounted?: boolean; value?: MoteWorkfaceScope }) { return <>{mounted ? <Reader value={value} /> : null}<GlobalSystemNotices /></> }
const rows = () => [...dom.container.querySelectorAll<HTMLElement>('.notification-item[data-notice-id^="mote-heartbeat:"]')]
const unread = () => rows().filter(row => row.dataset.unread === 'true').length
async function refresh() { await act(async () => currentReading.refresh()); await vi.waitFor(() => expect(currentReading.loading).toBe(false)) }
async function open() { await toggleNotificationCenter(dom.container, 'open') }
function publicRead() {
  const target = { domain: 'client.notifications' as const, hostId: 'local', list: { section: 'current' as const } }
  const result = observeNotifications({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'original-notice-read',
    operation: 'inspect.notifications', target, includeRaw: true, maxBytes: 65536 })
  return parseClientNotificationsObservation(result, target, true)
}
beforeEach(() => {
  seedMoteWorkface()
  useAppStore.setState({ loading: false, sessions: [{ ...defaultAgent, status: { state: 'running', source: 'run-process', observedAt: Date.now() } }], notificationEvents: [], noticeReadReceipts: {},
    error: null, lastError: null, errorNoticeContext: null, errorDismissed: false, runtimeOwnershipWarnings: [], runtimeEndpointWarnings: [],
    displacedAgentSessionIds: [], startupAgentAvailability: undefined, environmentWarning: undefined,
    sessionNameMetadataWarning: null, workbenchSaveWarning: null, nameSaveUnconfirmed: null, nameEditFailure: null, desktopNavigationNotice: null })
  maintenance = { status: 'paused', schedule: originalLoop(), issue: null }
  presenceEnabled = true
  vi.spyOn(api.motePreferences, 'read').mockImplementation(async input => {
    const original = [scope, otherScope].find(value => moteConnectionTarget(value, useAppStore.getState().spaceZoneBindings)?.spaceId === input.target.spaceId)!
    return { ...input, kind: 'quick', status: 'ready', main: true, issue: null,
    defaults: { conversation: reference, conversationRevision: 'original-main-role', presence: { enabled: presenceEnabled, intervalMs: 1800000 } },
    source: { resource: { ...input.target.expectedResource, zoneId: input.target.zoneId, zonePath: original.topic.directoryPath, path: original.rootPath + '/MOTE.md' }, result: { status: 'deleted' } },
    choices: { executors: [], conversations: [], destinations: [] }, maintenance }
  })
})

it.each(['input-unconfirmed', 'persistence-unconfirmed', 'timing-unrepresentable'] as const)('projects the actual shared public %s pause into one original Current notice and exact public metadata without changing the Agent', async reason => {
  maintenance.schedule!.pause!.reason = reason
  const before = useAppStore.getState(), original = structuredClone(maintenance.schedule)
  await dom.render(<Surface />); await vi.waitFor(() => expect(currentReading.saved?.maintenance?.schedule?.pause?.episodeId, JSON.stringify(currentReading)).toBe('original-pause-episode'))
  await open(); expect(rows()).toHaveLength(1); expect(rows()[0]!.textContent).toContain('Heartbeat paused')
  expect(unread()).toBe(1)
  const publicResult = publicRead(), records = publicResult.data!.items.filter(item => item.source === 'events' && item.subject.kind === 'zone')
  expect(records).toHaveLength(1); expect(records[0]).toMatchObject({ source: 'events', section: 'current', category: 'operations', unread: true,
    level: 'indeterminate', observedAt: original!.pause!.pausedAt, subject: { kind: 'zone', hostId: defaultAgent.hostId, workspaceId: scratchWorkspace.id } })
  expect(records[0]!.original?.detail).toContain('original-input')
  expect(notificationTrigger(dom.container).getAttribute('aria-label')).toContain(`${publicResult.data!.items.filter(item => item.unread).length} unread`)
  expect(useAppStore.getState().noticeReadReceipts).toEqual({})
  expect(maintenance.schedule).toEqual(original); expect(useAppStore.getState().sessions).toBe(before.sessions)
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
})

it('reading, repeated polling, interval edits and closing every reader preserve the same unresolved episode and its shared read receipt', async () => {
  await dom.render(<Surface />); await vi.waitFor(() => expect(currentReading.saved).not.toBeNull()); await open()
  expect(rows()).toHaveLength(1); const id = rows()[0]!.dataset.noticeId
  await toggleNotificationDetails(rows()[0]!); expect(unread()).toBe(0)
  const receipts = structuredClone(useAppStore.getState().noticeReadReceipts)
  maintenance = { ...maintenance, schedule: { ...maintenance.schedule!, everyMs: 3600000, intervalMs: 3600000, revision: 4,
    lastDecision: 'Localized diagnostic changed without a new pause.', lastTickAt: 1794372200000 } }
  await refresh(); expect(rows()).toHaveLength(1); expect(rows()[0]!.dataset.noticeId).toBe(id); expect(unread()).toBe(0)
  await toggleNotificationCenter(dom.container, 'closed'); await dom.render(<Surface mounted={false} />)
  expect(useAppStore.getState().noticeReadReceipts).toEqual(receipts)
  await dom.render(<Surface />); await vi.waitFor(() => expect(currentReading.saved).not.toBeNull()); await open()
  expect(rows()).toHaveLength(1); expect(unread()).toBe(0); expect(rows()[0]!.dataset.noticeId).toBe(id)
  expect(maintenance.schedule?.status).toBe('paused'); expect(maintenance.schedule?.pendingCompletion?.operationId).toBe('original-input')
})

it('preserves the exact acknowledged episode through the original persisted user-document read-receipt hydration owner', async () => {
  await dom.render(<Surface />); await vi.waitFor(() => expect(currentReading.saved).not.toBeNull()); await open()
  expect(rows()).toHaveLength(1); await toggleNotificationDetails(rows()[0]!); expect(unread()).toBe(0)
  const original = JSON.parse(JSON.stringify(useAppStore.getState().noticeReadReceipts))
  expect(Object.keys(original['global:events'])).toHaveLength(1)
  const hydrated = normalizeNotificationReadReceipts(original)
  expect(hydrated).toEqual(original)
  await act(async () => useAppStore.setState({ noticeReadReceipts: hydrated }))
  await refresh(); expect(unread()).toBe(0); expect(rows()).toHaveLength(1)
  expect(maintenance.schedule?.status).toBe('paused')
})

it('announces a new original episode once without treating polling, renaming or reopening an unread source as another event', async () => {
  await dom.render(<Surface />); await vi.waitFor(() => expect(currentReading.saved).not.toBeNull())
  const announcement = () => dom.container.querySelector<HTMLElement>('[data-mote-heartbeat-announcement]')!
  expect(announcement().textContent).toContain('Heartbeat paused')
  const original = announcement().firstChild
  await refresh(); expect(announcement().firstChild).toBe(original)
  await dom.render(<Surface value={{ ...scope, topic: { ...scope.topic, title: 'Renamed Mote' } }} />)
  expect(announcement().firstChild).toBe(original)
  await dom.render(<Surface mounted={false} />); expect(announcement().textContent?.trim()).toBe('')
  await dom.render(<Surface />); await vi.waitFor(() => expect(currentReading.saved).not.toBeNull())
  expect(announcement().textContent?.trim()).toBe('')
  await open(); expect(rows()).toHaveLength(1); expect(unread()).toBe(1)
  maintenance = { ...maintenance, schedule: { ...maintenance.schedule!, pause: { ...maintenance.schedule!.pause!, episodeId: 'new-episode', pausedAt: 1794372301000 } } }
  await refresh(); expect(announcement().textContent).toContain('Heartbeat paused')
  expect(announcement().firstChild).not.toBe(original)
})

it.each(['manual', 'source-disabled', 'source-changed', 'execution-ended', 'preparation'] as const)('does not alarm for the original %s pause', async reason => {
  maintenance.schedule!.pause = { ...maintenance.schedule!.pause!, reason }
  await dom.render(<Surface />); await vi.waitFor(() => expect(currentReading.saved).not.toBeNull()); await open()
  expect(rows()).toHaveLength(0); expect(unread()).toBe(0); expect(maintenance.schedule?.status).toBe('paused')
})

it.each(['no-pause', 'no-episode', 'no-time', 'busy', 'old-role', 'wrong-session', 'no-managed-source', 'disabled', 'preference-off'] as const)('keeps %s evidence from fabricating a fault reminder', async mode => {
  if (mode === 'no-pause') { delete maintenance.schedule!.pause; maintenance.schedule!.lastDecision = 'Paused by you.'; maintenance.schedule!.lastMutation = { operationId: 'original-pause', action: 'pause', expectedRevision: 2 } }
  if (mode === 'no-episode') { delete maintenance.schedule!.pause!.episodeId; delete maintenance.schedule!.pause!.pausedAt }
  if (mode === 'no-time') delete maintenance.schedule!.pause!.pausedAt
  if (mode === 'busy') { maintenance.status = 'active'; maintenance.schedule = { ...maintenance.schedule!, status: 'active', lastOutcome: 'skipped', lastDecision: 'The original Agent is busy.' } }
  if (mode === 'old-role') maintenance.schedule!.managedSource!.revision = 'old-main-role'
  if (mode === 'wrong-session') maintenance.schedule!.agentSessionId = 'another-agent'
  if (mode === 'no-managed-source') delete maintenance.schedule!.managedSource
  if (mode === 'disabled') maintenance.status = 'disabled'
  if (mode === 'preference-off') presenceEnabled = false
  await dom.render(<Surface />)
  if (mode === 'no-time') await vi.waitFor(() => { expect(currentReading.loading).toBe(false); expect(currentReading.unavailable).toBe(true); expect(currentReading.issue).not.toBeNull() })
  else await vi.waitFor(() => expect(currentReading.saved).not.toBeNull())
  await open()
  expect(rows()).toHaveLength(0); expect(unread()).toBe(0)
})

it('keeps the exact unresolved pause and reading when its later Host observation fails', async () => {
  await dom.render(<Surface />); await vi.waitFor(() => expect(currentReading.saved).not.toBeNull()); await open()
  expect(rows()).toHaveLength(1); await toggleNotificationDetails(rows()[0]!); expect(unread()).toBe(0)
  vi.mocked(api.motePreferences.read).mockRejectedValueOnce(new Error('Original Host observation unavailable'))
  await refresh(); expect(currentReading.unavailable).toBe(true)
  expect(rows()).toHaveLength(1); expect(unread()).toBe(0); expect(rows()[0]!.textContent).toContain('observation')
  expect(publicRead().data?.coverage.unavailableSources).toContain('events')
  expect(maintenance.schedule?.status).toBe('paused')
})

it('retains the original unresolved episode when a fulfilled public read explicitly reports unavailable facts', async () => {
  await dom.render(<Surface />); await vi.waitFor(() => expect(currentReading.saved).not.toBeNull()); await open()
  expect(rows()).toHaveLength(1); await toggleNotificationDetails(rows()[0]!); expect(unread()).toBe(0)
  const original = currentReading.saved
  const target = moteConnectionTarget(scope, useAppStore.getState().spaceZoneBindings)!
  vi.mocked(api.motePreferences.read).mockResolvedValueOnce({ kind: 'quick', target, status: 'unconfirmed', source: null, defaults: null,
    main: null, issue: 'Original Host facts are unavailable', choices: { executors: [], conversations: [], destinations: [] },
    maintenance: { status: 'unconfirmed', schedule: null, issue: 'Original Host facts are unavailable' } })
  await refresh(); expect(currentReading.unavailable).toBe(true); expect(currentReading.saved).toBe(original)
  expect(rows()).toHaveLength(1); expect(unread()).toBe(0)
})

it('keeps identical episode and arrangement names on distinct original Motes as independent current reminders', async () => {
  await dom.render(<><Reader /><Reader value={otherScope} /><GlobalSystemNotices /></>)
  await vi.waitFor(() => expect(api.motePreferences.read).toHaveBeenCalledTimes(2)); await open()
  await vi.waitFor(() => expect(rows()).toHaveLength(2))
  const ids = rows().map(row => row.dataset.noticeId); expect(new Set(ids).size).toBe(2)
  await toggleNotificationDetails(rows()[0]!); expect(unread()).toBe(1)
  await refresh(); expect(rows()).toHaveLength(2); expect(unread()).toBe(1)
  const records = publicRead().data!.items.filter(item => item.source === 'events' && item.subject.kind === 'zone')
  expect(new Set(records.map(item => item.subject.objectKey)).size).toBe(2)
  expect(records.filter(item => item.unread)).toHaveLength(1)
})

it('reading the latest of two original Mote reminders never announces the earlier unread episode again', async () => {
  await dom.render(<><Reader /><Reader value={otherScope} /><GlobalSystemNotices /></>)
  await vi.waitFor(() => expect(api.motePreferences.read).toHaveBeenCalledTimes(2)); await open()
  await vi.waitFor(() => expect(rows()).toHaveLength(2))
  const announcement = dom.container.querySelector<HTMLElement>('[data-mote-heartbeat-announcement]')!
  const original = announcement.firstChild
  await toggleNotificationDetails(rows()[1]!); expect(unread()).toBe(1)
  expect(announcement.firstChild === null || announcement.firstChild === original).toBe(true)
  await refresh(); expect(unread()).toBe(1)
  const retained = announcement.firstChild
  await refresh(); expect(announcement.firstChild).toBe(retained)
})

it('confirmed resolution removes only the original current problem and a later episode is newly unread', async () => {
  await dom.render(<Surface />); await vi.waitFor(() => expect(currentReading.saved).not.toBeNull()); await open()
  expect(rows()).toHaveLength(1); await toggleNotificationDetails(rows()[0]!); expect(unread()).toBe(0)
  const paused = structuredClone(maintenance.schedule!)
  const { pause: _pause, pendingCompletion: _pending, ...active } = paused
  maintenance = { status: 'active', schedule: { ...active, status: 'active', lastOutcome: 'sent' }, issue: null }
  await refresh(); expect(rows()).toHaveLength(0)
  maintenance = { status: 'paused', schedule: { ...paused, pause: { ...paused.pause!, episodeId: 'later-original-episode', pausedAt: paused.pause!.pausedAt! + 1000 },
    pendingCompletion: { ...paused.pendingCompletion!, id: 'later-occurrence', operationId: 'later-original-input' } }, issue: null }
  await refresh(); expect(rows()).toHaveLength(1); expect(unread()).toBe(1)
  expect(publicRead().data!.items.find(item => item.source === 'events' && item.subject.kind === 'zone')!.original?.detail).toContain('later-original-input')
})

it('opens the original Mote inspection intent from its notification without resuming, submitting or selecting a neighbouring Agent', async () => {
  const activated: MoteHeartbeatInspection[] = [], release = subscribeMoteHeartbeatInspection(intent => { activated.push(intent); return true })
  const resume = vi.spyOn(api.schedule, 'resume'), original = structuredClone(maintenance.schedule)
  const sessions = useAppStore.getState().sessions, drafts = useAppStore.getState().agentComposerDrafts
  try {
    await dom.render(<Surface />); await vi.waitFor(() => expect(currentReading.saved).not.toBeNull()); await open()
    expect(rows()).toHaveLength(1)
    const action = [...rows()[0]!.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Inspect original heartbeat')
    expect(action).toBeDefined(); await act(async () => action!.click())
    expect(activated).toEqual([{ target: moteConnectionTarget(scope, useAppStore.getState().spaceZoneBindings), original }])
    expect(resume).not.toHaveBeenCalled(); expect(maintenance.schedule).toEqual(original)
    expect(useAppStore.getState().sessions).toBe(sessions); expect(useAppStore.getState().agentComposerDrafts).toBe(drafts)
  } finally { release() }
})

it.each(['replacement', 'mutation'] as const)('captures an immutable original arrangement for inspection before a later source %s', async change => {
  await dom.render(<Surface />); await vi.waitFor(() => expect(currentReading.saved).not.toBeNull())
  const saved = structuredClone(currentReading.saved!), original = structuredClone(saved.maintenance!.schedule!)
  const target = moteConnectionTarget(scope, useAppStore.getState().spaceZoneBindings)!, inspect = vi.fn()
  const item = moteHeartbeatNotice({ ...currentReading, key: JSON.stringify(target), target, label: scope.topic.title, saved, inspect })
  expect(item).not.toBeNull()
  if (change === 'replacement') saved.maintenance!.schedule = { ...original, loopId: 'later-arrangement-B', agentSessionId: 'later-main-B' }
  else { saved.maintenance!.schedule!.prompt = 'Later content'; saved.maintenance!.schedule!.pendingCompletion!.operationId = 'later-input-B' }
  item!.action!.run()
  expect(inspect).toHaveBeenCalledExactlyOnceWith(original)
  expect(maintenance.schedule?.loopId).toBe('original-watch-arrangement')
})
