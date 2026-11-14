// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ContinuousProgressLoop } from '@agentmux/core/continuous-progress-scheduler'
import type { MotePresenceReading } from '@agentmux/core/mote-preferences'
import type { MoteDialoguePage } from '@agentmux/core/mote-dialogue'
import { parseScheduleRpcParams } from '@agentmux/core/schedule-rpc'
import { tmpdir } from 'node:os'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner'
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() }, nativeImage: {} }))
import { RuntimeController } from '../src/main/runtime-controller'
import { sessionInputOperationResult, unwrapSessionInputOperationResult } from '../src/shared/session-input-result'
import { createMoteApp, moteClick, settleMoteApp, type MoteAppFixture } from './fixtures/mote-app'
import { defaultAgent, defaultTab, moteTopics, scratchWorkspace } from './fixtures/mote-workface'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { useMoteHeartbeatNoticeReadings, type MoteHeartbeatNoticeReading } from '../src/renderer/src/lib/mote-heartbeat-reading'

let app: MoteAppFixture, maintenance: MotePresenceReading
const closes: Array<() => Promise<unknown>> = []
const topic = moteTopics[0]!
const reference = { hostId: 'local', sessionId: defaultAgent.id, displayWorkspaceId: scratchWorkspace.id,
  groupId: 'mote-group', tabId: defaultTab.id, regionId: defaultTab.layout.activeRegionId }
const loop = (): ContinuousProgressLoop => ({ loopId: 'original-heartbeat', hostId: 'local', agentSessionId: defaultAgent.id, providerId: defaultAgent.providerId,
  workspacePath: defaultAgent.workspacePath, everyMs: 1800000, intervalMs: 1800000, prompt: 'original work check', revision: 4, creationOperationId: 'original-heartbeat-creation', futureIntentId: 'original-heartbeat-standing-intent', status: 'paused', nextCheckAt: 1794213600000,
  lastTickAt: 1794210000000, lastOutcome: 'unknown', lastDecision: 'Original Host connection unavailable.',
  pendingCompletion: { id: 'original-occurrence', operationId: 'original-heartbeat-input', condition: { expectedRun: defaultAgent.control.run, afterSubmissionId: null }, prompt: 'original work check', agentMuxNote: 'original maintenance' } })
const button = (name: string, within: ParentNode = document) => {
  const node = [...within.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === name || node.getAttribute('aria-label') === name)
  expect(node, name).toBeDefined(); return node!
}
beforeEach(() => {
  app = createMoteApp(); maintenance = { status: 'paused', schedule: loop(), issue: 'Original Host connection unavailable.' }
  const defaults = { executorId: 'fixture', conversation: reference, presence: { enabled: true, intervalMs: 1800000 } }
  const topics = [{ ...topic, quickMode: { status: 'saved' as const, version: 'reliability-settings', defaults } }, ...moteTopics.slice(1)]
  useAppStore.setState({ toolsOpen: true, explorerCollapsed: { [scratchWorkspace.id]: false }, scratchTopicSnapshots: {
    [scratchWorkspace.id]: { scope: scratchTopicsScope(scratchWorkspace), revision: 1, topics, reading: false, error: null } } })
  vi.mocked(api.scratch.listTopics).mockResolvedValue(topics)
  vi.mocked(api.scratch.readTopic).mockImplementation(async (_workspace, id) => topics.find(topic => topic.id === id) ?? null)
  vi.spyOn(api.files, 'readDirectory').mockResolvedValue([])
  vi.spyOn(api.sessions, 'inputMailbox').mockImplementation(async (source, options) => ({ agentSessionId: source.agentSessionId, queueId: 'original-input-queue', cut: { incarnation: 'original-incarnation', throughSequence: 0 },
    budgetBytes: options?.maxBytes ?? 65536, items: [], nextCursor: null, coverage: { kind: 'recorded-inputs', unrecorded: 'unconfirmed' } }))
  vi.spyOn(api.sessions, 'inspectSubmission').mockResolvedValue(null)
  vi.spyOn(api.schedule, 'list').mockImplementation(async input => { parseScheduleRpcParams('schedule.list', input); return { schedules: maintenance.schedule ? [maintenance.schedule] : [], executionScope: 'connected-host' } })
  vi.spyOn(api.motePreferences, 'read').mockImplementation(async params => ({ ...params, kind: 'quick', status: 'ready', main: true, issue: null, defaults,
    source: { resource: { ...params.target.expectedResource, zoneId: params.target.zoneId, zonePath: topic.directoryPath, path: topic.directoryPath.slice(scratchWorkspace.path.length + 1) + '/MOTE.md' }, result: { status: 'deleted' } },
    choices: { executors: [{ id: 'fixture', name: 'Fixture', providerId: 'fixture' }], conversations: [], destinations: [] }, maintenance }))
  vi.spyOn(api.moteDialogue, 'read').mockImplementation(async ({ target }): Promise<MoteDialoguePage> => ({ main: { target,
    identity: { hostId: 'local', moteId: topic.id }, status: 'ready', resource: null, documentRevision: 'original-settings', roleRevision: 'original-role', current: reference, issue: null },
    links: [], incarnation: 'original-links', throughSequence: 0, next: null, coverage: 'linked-sources-only', sourceStatus: 'read', sourceIssue: null }))
})
afterEach(async () => { await app.dispose(); for (const close of closes.splice(0).reverse()) await close() })
function retained(expectedControl = defaultAgent.control) {
  const current = useAppStore.getState()
  expect(current.sessions.find(value => value.id === defaultAgent.id)?.control).toEqual(expectedControl)
  expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled()
}
it('actual Profile reads the original schedule: enabled preferences cannot masquerade as a working heartbeat', async () => {
  await app.mount(); await moteClick(button('Profile'))
  const card = document.querySelector<HTMLElement>('.mote-quick-mode [aria-label="Mote heartbeat"]')!
  await vi.waitFor(() => expect(card?.dataset.moteMaintenanceStatus, card.textContent ?? '').toBe('paused'))
  expect(card.textContent).toContain('Heartbeat paused'); expect(card.textContent).toContain('Delivery unconfirmed')
  expect(card.textContent).toContain('original-heartbeat-input'); expect(card.textContent).not.toContain('Every 30 min')
  expect(api.motePreferences.read).toHaveBeenCalledWith(expect.objectContaining({ kind: 'quick', target: expect.objectContaining({ expectedResource: { hostId: 'local', workspaceId: scratchWorkspace.id, workspacePath: scratchWorkspace.path } }) }))
  const resume = vi.spyOn(api.schedule, 'resume')
  await moteClick(button('Configure heartbeat', card))
  const dialog = document.querySelector<HTMLElement>('.mote-quick-mode-dialog')!
  expect(dialog.querySelector('[aria-label="Enable automatic Mote maintenance"]')?.closest('details')).toBeNull()
  expect(dialog.querySelector('[aria-label="Mote heartbeat"]')?.textContent).toContain('Delivery unconfirmed')
  await moteClick(button('Cancel', dialog)); expect(resume).not.toHaveBeenCalled(); retained()
})
it('the real conversation and daily entry share one original reading while Profile is closed, and inspect without resuming', async () => {
  maintenance.schedule!.pause = { reason: 'input-unconfirmed', episodeId: 'original-pause', pausedAt: 1794210000500 }
  const inspect = vi.spyOn(api.schedule, 'inspect').mockResolvedValue({ schedule: maintenance.schedule, executionScope: 'connected-host' })
  const resume = vi.spyOn(api.schedule, 'resume'), input = vi.spyOn(api.sessions, 'inspectInput').mockResolvedValue(null)
  await app.mount()
  const lamp = document.querySelector<HTMLButtonElement>('.mote-space-frame__header .mote-heartbeat-lamp')!
  await vi.waitFor(() => expect(lamp?.dataset.moteCare).toBe('attention'))
  expect(document.querySelector('.mote-heartbeat-entry')?.getAttribute('data-mote-care')).toBe('attention')
  expect(document.querySelector('.mote-quick-mode-dialog')).toBeNull()
  const beforeProfile = vi.mocked(api.motePreferences.read).mock.calls.filter(([input]) => input.kind === 'quick').length
  await moteClick(button('Profile'))
  expect(vi.mocked(api.motePreferences.read).mock.calls.filter(([input]) => input.kind === 'quick')).toHaveLength(beforeProfile)
  await moteClick(lamp)
  const dialog = document.querySelector<HTMLElement>('.mote-quick-mode-dialog')!
  expect(dialog.textContent).toContain('Automatic care')
  expect(dialog.textContent).toContain('A heartbeat may have been delivered')
  expect(dialog.querySelector('[aria-label="Mote heartbeat"]')?.textContent).toContain('Paused since')
  await moteClick(button('Check original delivery', dialog))
  expect(inspect).toHaveBeenCalledWith({ scheduleId: 'original-heartbeat' }, 'local')
  expect(input).toHaveBeenCalledWith(defaultAgent.control, expect.objectContaining({ submissionId: 'original-heartbeat-input' }))
  expect(resume).not.toHaveBeenCalled(); retained()
})
it.each(['another-main', 'next-pause-in-same-loop', 'legacy-without-key'])('a reminder for A inspects original A after %s and closes back to the exact lamp', async change => {
  maintenance.schedule!.pause = { reason: 'input-unconfirmed', episodeId: 'original-pause-A', pausedAt: 1794210000500 }
  maintenance.schedule!.managedSource = { sourceId: 'original-mote-source', revision: 'legacy:missing' }
  if (change === 'legacy-without-key') delete maintenance.schedule!.pendingCompletion
  const originalA = structuredClone(maintenance.schedule!)
  const newerPause = { ...originalA, pause: { reason: 'input-unconfirmed' as const, episodeId: 'next-pause-B', pausedAt: 1794211800500 },
    pendingCompletion: { ...originalA.pendingCompletion!, id: 'next-occurrence-B', operationId: 'next-input-B', condition: { expectedRun: { runId: 'next-run-B' }, afterSubmissionId: null } } }
  const inspect = vi.spyOn(api.schedule, 'inspect').mockResolvedValue({ schedule: change === 'another-main' ? originalA : newerPause, executionScope: 'connected-host' })
  const input = vi.spyOn(api.sessions, 'inspectInput').mockResolvedValue(null), resume = vi.spyOn(api.schedule, 'resume')
  await app.mount()
  const center = document.querySelector<HTMLElement>('.global-system-notices__details')!
  await act(async () => center.showPopover()); await settleMoteApp()
  const row = center.querySelector<HTMLElement>('.notification-item[data-notice-id^="mote-heartbeat:"]')!
  expect(row).not.toBeNull()
  const source = vi.mocked(api.motePreferences.read), read = source.getMockImplementation()!
  const next = change === 'another-main' ? { ...loop(), loopId: 'new-main-heartbeat-B', agentSessionId: 'new-main-B', status: 'active' as const, lastOutcome: 'sent' as const } : change === 'legacy-without-key' ? originalA : newerPause
  source.mockImplementation(async params => { const result = await read(params); return { ...result, defaults: { ...result.defaults!, conversation: change === 'another-main' ? { ...reference, sessionId: 'new-main-B' } : reference }, maintenance: { status: next.status === 'active' ? 'active' : 'paused', schedule: next, issue: null } } })
  const action = button('Inspect original heartbeat', row)
  await act(async () => action.focus()); await moteClick(action)
  const dialog = document.querySelector<HTMLElement>('.mote-quick-mode-dialog')!
  await vi.waitFor(() => expect(dialog?.textContent).toContain('Original heartbeat'))
  expect(inspect).toHaveBeenCalledWith({ scheduleId: originalA.loopId }, 'local')
  if (change !== 'legacy-without-key') expect(dialog.textContent).toContain('original-heartbeat-input')
  expect(dialog.textContent).not.toContain('new-main-heartbeat-B'); expect(dialog.textContent).not.toContain('next-input-B')
  expect(dialog.querySelector('[aria-label="Enable automatic Mote maintenance"]')).toBeNull()
  expect([...dialog.querySelectorAll('button')].some(value => value.textContent?.includes('Save') || value.textContent?.includes('Resume'))).toBe(false)
  await moteClick(button('Check original delivery', dialog))
  if (change === 'legacy-without-key') expect(input).not.toHaveBeenCalled()
  else expect(input).toHaveBeenCalledWith(defaultAgent.control, expect.objectContaining({ submissionId: 'original-heartbeat-input' }))
  expect([...dialog.querySelectorAll('button')].some(value => value.textContent?.includes('Save') || value.textContent?.includes('Resume'))).toBe(false)
  await moteClick(button('Close', dialog))
  expect(document.activeElement).toBe(document.querySelector('.mote-space-frame__header .mote-heartbeat-lamp'))
  expect(resume).not.toHaveBeenCalled(); retained()
})
it('legacy pause wording and an old check cannot invent an explicit cause or pause onset', async () => {
  maintenance.schedule!.lastDecision = 'Paused by you.'
  maintenance.schedule!.lastMutation = { action: 'pause', operationId: 'unknown-old-origin', expectedRevision: 3 }
  await app.mount()
  const lamp = document.querySelector<HTMLButtonElement>('.mote-space-frame__header .mote-heartbeat-lamp')!
  await vi.waitFor(() => expect(lamp?.dataset.moteCare).toBe('unknown'))
  expect(lamp.textContent).toContain('Pause needs checking')
  await moteClick(lamp)
  const card = document.querySelector<HTMLElement>('.mote-quick-mode-dialog [aria-label="Mote heartbeat"]')!
  expect(card.textContent).toContain('Original pause time not recorded')
  expect(card.querySelectorAll('time')).toHaveLength(1)
  expect(card.textContent).toContain('Its original reason and pause time were not recorded'); retained()
})
it('legacy current heartbeat exposes a checked missing key and explicit future recovery outside details', async () => {
  delete maintenance.schedule!.pendingCompletion
  const original = structuredClone(maintenance.schedule!)
  vi.spyOn(api.schedule, 'inspect').mockResolvedValue({ schedule: original, executionScope: 'connected-host' })
  const input = vi.spyOn(api.sessions, 'inspectInput'), resume = vi.spyOn(api.schedule, 'resume').mockImplementation(async request => ({
    schedule: { ...original, status: 'active', revision: request.expectedRevision + 1,
      lastMutation: { operationId: request.operationId, expectedRevision: request.expectedRevision, action: 'resume' } }, diskDurability: 'confirmed', executionScope: 'connected-host' }))
  await app.mount(); await moteClick(document.querySelector<HTMLButtonElement>('.mote-space-frame__header .mote-heartbeat-lamp')!)
  const dialog = document.querySelector<HTMLElement>('.mote-quick-mode-dialog')!
  expect([...dialog.querySelectorAll('button')].some(node => node.textContent === 'Resume future checks')).toBe(false)
  await moteClick(button('Check original delivery', dialog))
  const recovery = button('Resume future checks', dialog), explanation = recovery.closest('[role="status"]')!
  expect(recovery.closest('details')).toBeNull(); expect(explanation.closest('details')).toBeNull()
  expect(explanation.textContent).toContain('no retained input key'); expect(explanation.textContent).toContain('earlier delivery remains unknown')
  expect(explanation.textContent).toContain('due check immediately'); expect(input).not.toHaveBeenCalled(); expect(resume).not.toHaveBeenCalled()
  await moteClick(recovery)
  expect(resume).toHaveBeenCalledExactlyOnceWith({ scheduleId: original.loopId, expectedRevision: original.revision, operationId: expect.any(String) }, 'local')
  expect(dialog.querySelector('[aria-label="Mote heartbeat"]')?.getAttribute('data-mote-maintenance-status')).toBe('active')
  expect(dialog.textContent).toContain('Delivery unconfirmed'); await moteClick(button('Cancel', dialog)); retained()
})
it('legacy current heartbeat does not confuse missing receipts for an existing key with a missing key', async () => {
  const input = vi.spyOn(api.sessions, 'inspectInput').mockResolvedValue(null), resume = vi.spyOn(api.schedule, 'resume')
  vi.spyOn(api.schedule, 'inspect').mockResolvedValue({ schedule: maintenance.schedule!, executionScope: 'connected-host' })
  await app.mount(); await moteClick(document.querySelector<HTMLButtonElement>('.mote-space-frame__header .mote-heartbeat-lamp')!)
  const dialog = document.querySelector<HTMLElement>('.mote-quick-mode-dialog')!
  await moteClick(button('Check original delivery', dialog))
  expect(input).toHaveBeenCalledWith(defaultAgent.control, expect.objectContaining({ submissionId: 'original-heartbeat-input' }))
  expect([...dialog.querySelectorAll('button')].some(node => node.textContent === 'Resume future checks')).toBe(false)
  expect(dialog.textContent).not.toContain('no retained input key'); expect(resume).not.toHaveBeenCalled(); retained()
})
it.each(['main', 'source-role', 'revision', 'pause', 'unavailable'])('legacy current heartbeat invalidates checked recovery after original %s changes', async change => {
  delete maintenance.schedule!.pendingCompletion
  vi.spyOn(api.schedule, 'inspect').mockResolvedValue({ schedule: maintenance.schedule!, executionScope: 'connected-host' })
  const resume = vi.spyOn(api.schedule, 'resume')
  await app.mount(); await moteClick(document.querySelector<HTMLButtonElement>('.mote-space-frame__header .mote-heartbeat-lamp')!)
  const dialog = document.querySelector<HTMLElement>('.mote-quick-mode-dialog')!
  await moteClick(button('Check original delivery', dialog)); const recovery = button('Resume future checks', dialog)
  const source = vi.mocked(api.motePreferences.read), read = source.getMockImplementation()!
  source.mockImplementation(async params => {
    if (change === 'unavailable') throw Error('Original preference source unavailable')
    const current = await read(params), schedule = structuredClone(current.maintenance!.schedule!)
    if (change === 'source-role') schedule.managedSource = { sourceId: 'original-source', revision: 'new-source-role' }
    if (change === 'revision') schedule.revision = 9
    if (change === 'pause') schedule.pause = { reason: 'input-unconfirmed', episodeId: 'later-episode', pausedAt: 1794211800000 }
    return { ...current, defaults: { ...current.defaults!, ...(change === 'main' ? { conversation: { ...reference, sessionId: 'another-main' } } : {}) },
      maintenance: { ...current.maintenance!, schedule } }
  })
  await moteClick(recovery)
  expect(resume).not.toHaveBeenCalled()
  expect([...dialog.querySelectorAll('button')].some(node => node.textContent === 'Resume future checks' || node.textContent === 'Inspect original resume')).toBe(false)
  expect(dialog.textContent).toContain(change === 'unavailable' ? 'Original preference source unavailable' : 'main role or original heartbeat changed')
  retained()
})
it('legacy current heartbeat keeps an unknown resume on its original operation in the first screen', async () => {
  delete maintenance.schedule!.pendingCompletion
  const original = structuredClone(maintenance.schedule!)
  const inspect = vi.spyOn(api.schedule, 'inspect').mockResolvedValue({ schedule: original, executionScope: 'connected-host' })
  const resume = vi.spyOn(api.schedule, 'resume').mockRejectedValue(Error('Resume receipt unavailable'))
  await app.mount(); await moteClick(document.querySelector<HTMLButtonElement>('.mote-space-frame__header .mote-heartbeat-lamp')!)
  const dialog = document.querySelector<HTMLElement>('.mote-quick-mode-dialog')!
  await moteClick(button('Check original delivery', dialog)); await moteClick(button('Resume future checks', dialog))
  const request = resume.mock.calls[0]![0], retainedAction = button('Inspect original resume', dialog)
  expect(retainedAction.closest('details')).toBeNull(); expect(resume).toHaveBeenCalledTimes(1)
  inspect.mockResolvedValue({ schedule: { ...original, status: 'active', revision: request.expectedRevision + 1,
    lastMutation: { operationId: request.operationId, expectedRevision: request.expectedRevision, action: 'resume' } }, executionScope: 'connected-host' })
  await moteClick(retainedAction)
  expect(inspect).toHaveBeenLastCalledWith({ operationId: request.operationId }, 'local'); expect(resume).toHaveBeenCalledTimes(1)
  await moteClick(button('Cancel', dialog)); retained()
})
it('legacy current heartbeat cannot establish checked recovery from another current Main', async () => {
  delete maintenance.schedule!.pendingCompletion
  const inspect = vi.spyOn(api.schedule, 'inspect').mockResolvedValue({ schedule: maintenance.schedule!, executionScope: 'connected-host' })
  const resume = vi.spyOn(api.schedule, 'resume')
  await app.mount(); await moteClick(document.querySelector<HTMLButtonElement>('.mote-space-frame__header .mote-heartbeat-lamp')!)
  const dialog = document.querySelector<HTMLElement>('.mote-quick-mode-dialog')!
  const source = vi.mocked(api.motePreferences.read), read = source.getMockImplementation()!
  source.mockImplementation(async params => { const result = await read(params); return { ...result, defaults: { ...result.defaults!, conversation: { ...reference, sessionId: 'new-main' } } } })
  await moteClick(button('Check original delivery', dialog))
  expect(inspect).not.toHaveBeenCalled(); expect(resume).not.toHaveBeenCalled()
  expect([...dialog.querySelectorAll('button')].some(node => node.textContent === 'Resume future checks')).toBe(false)
  expect(dialog.textContent).toContain('main role or original heartbeat changed'); retained()
})
it('legacy current heartbeat qualifies the same original resource independent of JSON property order', async () => {
  delete maintenance.schedule!.pendingCompletion
  vi.spyOn(api.schedule, 'inspect').mockResolvedValue({ schedule: maintenance.schedule!, executionScope: 'connected-host' })
  await app.mount(); await moteClick(document.querySelector<HTMLButtonElement>('.mote-space-frame__header .mote-heartbeat-lamp')!)
  const dialog = document.querySelector<HTMLElement>('.mote-quick-mode-dialog')!
  const source = vi.mocked(api.motePreferences.read), read = source.getMockImplementation()!
  source.mockImplementation(async params => { const result = await read(params), resource = result.source!.resource!; return { ...result,
    source: { ...result.source!, resource: Object.fromEntries(Object.entries(resource).reverse()) as typeof resource } } })
  await moteClick(button('Check original delivery', dialog))
  expect(button('Resume future checks', dialog).closest('details')).toBeNull(); retained()
})
it('legacy current heartbeat does not retain a resume that was never dispatched after its preflight closes', async () => {
  delete maintenance.schedule!.pendingCompletion
  vi.spyOn(api.schedule, 'inspect').mockResolvedValue({ schedule: maintenance.schedule!, executionScope: 'connected-host' })
  const resume = vi.spyOn(api.schedule, 'resume')
  await app.mount(); const lamp = document.querySelector<HTMLButtonElement>('.mote-space-frame__header .mote-heartbeat-lamp')!
  await moteClick(lamp)
  const dialog = document.querySelector<HTMLElement>('.mote-quick-mode-dialog')!
  await moteClick(button('Check original delivery', dialog))
  const source = vi.mocked(api.motePreferences.read), current = await source.mock.results.at(-1)!.value
  let complete!: (value: typeof current) => void
  source.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
  await moteClick(button('Resume future checks', dialog)); expect(complete).toBeTypeOf('function')
  await moteClick(button('Cancel', dialog)); expect(document.querySelector('.mote-quick-mode-dialog')).toBeNull()
  await act(async () => complete(current)); await moteClick(lamp)
  const reopened = document.querySelector<HTMLElement>('.mote-quick-mode-dialog')!
  expect([...reopened.querySelectorAll('button')].some(node => node.textContent === 'Inspect original resume')).toBe(false)
  expect(button('Check original delivery', reopened)).toBeDefined(); expect(resume).not.toHaveBeenCalled(); retained()
})
it('confirmed off settings keep the lamp quiet while the original Host still returns the preceding paused arrangement', async () => {
  maintenance.schedule!.pause = { reason: 'input-unconfirmed', episodeId: 'previous-pause', pausedAt: 1794210000500 }
  const source = vi.mocked(api.motePreferences.read), read = source.getMockImplementation()!
  source.mockImplementation(async input => { const result = await read(input); return { ...result, defaults: { ...result.defaults!, presence: { enabled: false, intervalMs: 1800000 } } } })
  await app.mount()
  await vi.waitFor(() => expect(document.querySelector('.mote-space-frame__header .mote-heartbeat-lamp')?.getAttribute('data-mote-care')).toBe('off'))
  expect(document.querySelector('.mote-heartbeat-entry')?.getAttribute('data-mote-care')).toBe('off'); retained()
})
it.each(['another-main', 'another-role-revision'])('a successful setting read with %s cannot paint the previous arrangement as current care', async mismatch => {
  maintenance = { status: 'active', schedule: { ...loop(), ...(mismatch === 'another-main' ? { agentSessionId: 'another-main' } : { managedSource: { sourceId: 'original-mote-source', revision: 'another-role' } }), status: 'active', lastOutcome: 'sent' }, issue: null }
  await app.mount()
  const lamp = document.querySelector<HTMLButtonElement>('.mote-space-frame__header .mote-heartbeat-lamp')!
  await vi.waitFor(() => expect(lamp?.dataset.moteCare).toBe('unknown'))
  expect(lamp.textContent).toContain('Care unconfirmed')
  await moteClick(button('Profile'))
  expect(document.querySelector('.mote-quick-mode [aria-label="Mote heartbeat"]')?.getAttribute('data-mote-maintenance-status')).toBe('unconfirmed')
  await moteClick(lamp)
  expect(document.querySelector('.mote-quick-mode-dialog [aria-label="Mote heartbeat"]')?.getAttribute('data-mote-maintenance-status')).toBe('unconfirmed'); retained()
})
it('reading failure keeps the original schedule and makes the shared lamp unconfirmed instead of healthy', async () => {
  maintenance = { status: 'active', schedule: { ...loop(), status: 'active', lastOutcome: 'sent' }, issue: null }
  await app.mount(); await moteClick(button('Profile'))
  const lamp = document.querySelector<HTMLButtonElement>('.mote-space-frame__header .mote-heartbeat-lamp')!
  await vi.waitFor(() => expect(lamp.dataset.moteCare).toBe('active'))
  vi.mocked(api.motePreferences.read).mockRejectedValue(new Error('Original Host temporarily unavailable'))
  const card = document.querySelector<HTMLElement>('.mote-quick-mode [aria-label="Mote heartbeat"]')!
  await moteClick(button('Refresh actual schedule', card))
  await vi.waitFor(() => expect(lamp.dataset.moteCare).toBe('unknown'))
  expect(card.dataset.moteMaintenanceStatus).toBe('unconfirmed')
  expect(card.textContent).toContain('Host accepted input'); expect(card.textContent).toContain('Original Host temporarily unavailable'); retained()
})
it('an old in-flight public read cannot overwrite the confirmed reading after refresh, and does not create parallel reads', async () => {
  maintenance = { status: 'active', schedule: { ...loop(), status: 'active', lastOutcome: 'sent' }, issue: null }
  let readings: readonly MoteHeartbeatNoticeReading[] = []
  function Probe() { readings = useMoteHeartbeatNoticeReadings(); return null }
  await app.mount(createElement(Probe))
  expect(readings).toHaveLength(1)
  const source = vi.mocked(api.motePreferences.read), count = source.mock.calls.length
  const original = await source.mock.results[source.mock.calls.findIndex(([input]) => input.kind === 'quick')]!.value
  let releaseOld!: (value: typeof original) => void, releaseNew!: (value: typeof original) => void
  source.mockImplementationOnce(() => new Promise(resolve => { releaseOld = resolve }))
    .mockImplementationOnce(() => new Promise(resolve => { releaseNew = resolve }))
  await act(async () => { readings[0]!.refresh(); await Promise.resolve() })
  await act(async () => { readings[0]!.refresh(); readings[0]!.refresh(); await Promise.resolve() })
  expect(source).toHaveBeenCalledTimes(count + 1)
  await act(async () => { releaseOld({ ...original, maintenance: { status: 'paused', schedule: loop(), issue: null } }); await Promise.resolve() })
  await vi.waitFor(() => expect(source).toHaveBeenCalledTimes(count + 2))
  expect(document.querySelector('.mote-space-frame__header .mote-heartbeat-lamp')?.getAttribute('data-mote-care')).toBe('active')
  expect(readings[0]!.saved?.maintenance?.schedule?.status).toBe('active')
  await act(async () => { releaseNew(original); await Promise.resolve() }); retained()
})
it('a currently unavailable public reading retains the original unresolved pause without inventing an onset or delivery', async () => {
  maintenance.schedule!.pause = { reason: 'input-unconfirmed', episodeId: 'retained-episode', pausedAt: 1794210000500 }
  let readings: readonly MoteHeartbeatNoticeReading[] = []
  function Probe() { readings = useMoteHeartbeatNoticeReadings(); return null }
  await app.mount(createElement(Probe))
  const source = vi.mocked(api.motePreferences.read), original = await source.mock.results[source.mock.calls.findIndex(([input]) => input.kind === 'quick')]!.value
  source.mockResolvedValue({ ...original, defaults: null, main: null, issue: 'Original observation unavailable', status: 'unconfirmed', maintenance: { status: 'unconfirmed', schedule: null, issue: 'Original observation unavailable' } })
  await act(async () => readings[0]!.refresh())
  await vi.waitFor(() => expect(readings[0]!.unavailable).toBe(true))
  expect(readings[0]!.issue).toBe('Original observation unavailable')
  expect(readings[0]!.saved?.maintenance?.schedule?.pause?.episodeId).toBe('retained-episode')
  expect(document.querySelector('.mote-space-frame__header .mote-heartbeat-lamp')?.getAttribute('data-mote-care')).toBe('unknown'); retained()
})
it('an observed settings revision change makes the previous Main reading unconfirmed while the original new read is pending', async () => {
  maintenance = { status: 'active', schedule: { ...loop(), status: 'active', lastOutcome: 'sent' }, issue: null }
  await app.mount()
  const lamp = document.querySelector<HTMLButtonElement>('.mote-space-frame__header .mote-heartbeat-lamp')!
  await vi.waitFor(() => expect(lamp.dataset.moteCare).toBe('active'))
  const source = vi.mocked(api.motePreferences.read), original = await source.mock.results[source.mock.calls.findIndex(([input]) => input.kind === 'quick')]!.value
  const releases: Array<(value: typeof original) => void> = []
  source.mockImplementation(() => new Promise(resolve => { releases.push(resolve) }))
  await act(async () => useAppStore.setState(state => {
    const snapshot = state.scratchTopicSnapshots[scratchWorkspace.id]!
    return { scratchTopicSnapshots: { ...state.scratchTopicSnapshots, [scratchWorkspace.id]: { ...snapshot, revision: snapshot.revision + 1,
      topics: snapshot.topics!.map(value => value.id === topic.id ? { ...value, quickMode: { status: 'saved' as const, version: 'next-main-revision',
        defaults: { executorId: 'fixture', conversation: { ...reference, sessionId: 'new-main' } } } } : value) } } }
  }))
  await vi.waitFor(() => expect(releases.length).toBeGreaterThan(0))
  expect(lamp.dataset.moteCare).toBe('unknown')
  await act(async () => { for (const release of releases) release(original); await Promise.resolve() }); retained()
})
it('periodic care observation reads only the exact original schedule rather than rebuilding Mote configuration choices', async () => {
  maintenance = { status: 'active', schedule: { ...loop(), status: 'active', lastOutcome: 'sent' }, issue: null }
  const inspect = vi.spyOn(api.schedule, 'inspect').mockResolvedValue({ schedule: maintenance.schedule, executionScope: 'connected-host' })
  let readings: readonly MoteHeartbeatNoticeReading[] = []
  function Probe() { readings = useMoteHeartbeatNoticeReadings(); return null }
  await app.mount(createElement(Probe))
  const count = vi.mocked(api.motePreferences.read).mock.calls.length
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 5150)) })
  expect(inspect).toHaveBeenCalledWith({ scheduleId: 'original-heartbeat' }, 'local')
  expect(api.motePreferences.read).toHaveBeenCalledTimes(count)
  expect(document.querySelector('.mote-space-frame__header .mote-heartbeat-lamp')?.getAttribute('data-mote-care'), readings.map(value => value.issue).join('; ')).toBe('active'); retained()
})
it('an original loop ending discovers the actual new Main arrangement without a frontend metadata edit', async () => {
  maintenance = { status: 'active', schedule: { ...loop(), status: 'active', lastOutcome: 'sent' }, issue: null }
  let readings: readonly MoteHeartbeatNoticeReading[] = []
  function Probe() { readings = useMoteHeartbeatNoticeReadings(); return null }
  await app.mount(createElement(Probe))
  const source = vi.mocked(api.motePreferences.read), original = await source.mock.results[source.mock.calls.findIndex(([input]) => input.kind === 'quick')]!.value
  const count = source.mock.calls.length
  const next = { ...loop(), loopId: 'new-main-heartbeat', agentSessionId: 'new-main', revision: 1, status: 'active' as const, lastOutcome: 'sent' as const }
  vi.spyOn(api.schedule, 'inspect').mockResolvedValue({ schedule: { ...loop(), status: 'stopped' }, executionScope: 'connected-host' })
  source.mockResolvedValue({ ...original, defaults: { ...original.defaults!, conversation: { ...reference, sessionId: 'new-main' } }, maintenance: { status: 'active', schedule: next, issue: null } })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 5150)) })
  expect(source).toHaveBeenCalledTimes(count + 1)
  expect(readings[0]!.saved?.maintenance?.schedule?.loopId).toBe('new-main-heartbeat')
  expect(document.querySelector('.mote-space-frame__header .mote-heartbeat-lamp')?.getAttribute('data-mote-care')).toBe('active'); retained()
})
it('rereads real check and delivery facts, retains the last reading on an observation failure, and never says work completed', async () => {
  await app.mount(); await moteClick(button('Profile'))
  const card = document.querySelector<HTMLElement>('.mote-quick-mode [aria-label="Mote heartbeat"]')!
  await vi.waitFor(() => expect(card.dataset.moteMaintenanceStatus).toBe('paused'))
  maintenance = { status: 'active', schedule: { ...loop(), status: 'active', revision: 5, lastOutcome: 'sent', lastDecision: 'Original input accepted.' }, issue: null }
  await moteClick(button('Refresh actual schedule', card))
  await vi.waitFor(() => expect(card.dataset.moteMaintenanceStatus).toBe('active'))
  expect(card.textContent).toContain('Host accepted input'); expect(card.textContent).toContain('progress is in the conversation')
  expect(card.querySelectorAll('time')).toHaveLength(2)
  vi.mocked(api.motePreferences.read).mockRejectedValue(new Error('Original settings temporarily unavailable'))
  await moteClick(button('Refresh actual schedule', card))
  expect(card.textContent).toContain('Original settings temporarily unavailable'); expect(card.textContent).toContain('Host accepted input'); retained()
})
it('checking an unknown heartbeat inspects its exact original input and never resumes or submits it', async () => {
  const inspect = vi.spyOn(api.schedule, 'inspect').mockResolvedValue({ schedule: loop(), executionScope: 'connected-host' })
  const input = vi.spyOn(api.sessions, 'inspectInput').mockResolvedValue(null), resume = vi.spyOn(api.schedule, 'resume')
  await app.mount(); await moteClick(button('Profile')); await moteClick(button('Configure heartbeat'))
  const dialog = document.querySelector<HTMLElement>('.mote-quick-mode-dialog')!
  await vi.waitFor(() => expect(button('Check original delivery', dialog)).toBeDefined())
  expect(button('Resume saved heartbeat', dialog).closest('details')?.open).toBe(false)
  await moteClick(button('Check original delivery', dialog))
  expect(inspect).toHaveBeenCalledWith({ scheduleId: 'original-heartbeat' }, 'local')
  expect(input).toHaveBeenCalledWith(defaultAgent.control, { kind: 'prompt', agentSessionId: defaultAgent.id, expectedRun: defaultAgent.control.run, submissionId: 'original-heartbeat-input' })
  expect(api.sessions.inspectSubmission).toHaveBeenCalledWith(defaultAgent.control, { kind: 'prompt', agentSessionId: defaultAgent.id, expectedRun: defaultAgent.control.run, submissionId: 'original-heartbeat-input' })
  expect(dialog.textContent).toContain('That does not prove it was never sent.'); expect(resume).not.toHaveBeenCalled(); retained()
  maintenance = { ...maintenance, schedule: { ...loop(), revision: 5, pendingCompletion: { ...loop().pendingCompletion!, operationId: 'later-heartbeat-input' } } }
  await moteClick(button('Refresh actual schedule', dialog))
  await vi.waitFor(() => expect(dialog.textContent).toContain('later-heartbeat-input'))
  expect(dialog.textContent).not.toContain('That does not prove it was never sent.')
})
it('the mounted Mote heartbeat reads the actual Core terminal receipt through the Desktop controller without a waiting journal', async () => {
  const f = await rpcOwnerFixture([defaultAgent.id]); closes.push(f.close)
  const actual = f.client.agentSession(defaultAgent.id)!
  const actualControl = { ...defaultAgent.control, run: actual.run }
  useAppStore.setState(state => ({ sessions: state.sessions.map(value => value.id === defaultAgent.id ? { ...value, control: actualControl } : value) }))
  const schedule = { ...loop(), pendingCompletion: { ...loop().pendingCompletion!, condition: { expectedRun: actual.run, afterSubmissionId: null } } }
  maintenance = { ...maintenance, schedule }
  await f.client.submitAgentPrompt({ agentSessionId: actual.agentSessionId, expectedRun: actual.run, afterSubmissionId: null,
    operationId: 'original-heartbeat-input', prompt: 'Exact original heartbeat input' })
  const before = f.rawInput.mock.calls.length
  vi.spyOn(f.client, 'connect').mockRejectedValue(new Error('This read does not reconnect a Runtime.'))
  const controller = new RuntimeController(f.store, async () => f.client); closes.push(() => controller.dispose())
  controller.commit(await controller.prepare({ ...useAppStore.getState().config!, executors: {}, workspaces: [{ id: 'private', hostId: 'local', name: 'Original Core fixture', path: f.root, kind: 'folder' }] }))
  vi.spyOn(api.schedule, 'inspect').mockResolvedValue({ schedule, executionScope: 'connected-host' })
  vi.spyOn(api.sessions, 'inspectInput').mockImplementation((control, key) => controller.inspectInput(control, key))
  vi.mocked(api.sessions.inspectSubmission).mockImplementation(async (control, key) => unwrapSessionInputOperationResult(await sessionInputOperationResult(() => controller.inspectSubmission(control, key))))
  await app.mount(); await moteClick(button('Profile')); await moteClick(button('Configure heartbeat'))
  const dialog = document.querySelector<HTMLElement>('.mote-quick-mode-dialog')!
  await moteClick(button('Check original delivery', dialog))
  await vi.waitFor(() => expect(dialog.textContent).toContain('Input written to terminal'))
  expect(dialog.textContent).toContain('Native processing is not confirmed by this receipt.')
  expect(dialog.textContent).not.toContain('The original input was not observed in this read.')
  expect(f.rawInput.mock.calls.length).toBe(before); retained(actualControl)
})
it.each(['unbound', 'disabled', 'unconfirmed'] as const)('shows the actual %s state without inventing a delivery', async status => {
  maintenance = { status, schedule: null, issue: status === 'unconfirmed' ? 'Original Host status unknown.' : null }
  await app.mount(); await moteClick(button('Profile'))
  await vi.waitFor(() => expect(document.querySelector('.mote-quick-mode [data-mote-maintenance-status]')?.getAttribute('data-mote-maintenance-status')).toBe(status))
  expect(document.querySelector('.mote-quick-mode .mote-heartbeat time')).toBeNull(); retained()
})
it('a failed first schedule read leaves an actionable unknown state instead of an endless loading claim', async () => {
  vi.mocked(api.motePreferences.read).mockRejectedValue(new Error('Original Host is unavailable'))
  await app.mount(); await moteClick(button('Profile'))
  const card = document.querySelector<HTMLElement>('.mote-quick-mode [aria-label="Mote heartbeat"]')!
  await vi.waitFor(() => expect(card.dataset.moteMaintenanceStatus).toBe('unconfirmed'))
  expect(card.getAttribute('aria-busy')).toBeNull(); expect(card.textContent).toContain('Original Host is unavailable')
  expect(card.textContent).not.toContain('Reading the actual schedule'); expect(button('Refresh actual schedule', card).disabled).toBe(false); retained()
})
it('the original conversation shows a durable trust preparation failure in place; recheck reads without restarting or sending', async () => {
  const refresh = vi.fn(async () => undefined), recover = vi.fn(async () => undefined)
  useAppStore.setState(state => ({ refreshSession: refresh, recoverSession: recover, sessions: state.sessions.map(value => value.id === defaultAgent.id ? {
    ...value, creation: { createOperationId: 'original-create', initialPrompt: 'unconfirmed' as const, createdRun: defaultAgent.control.run,
      workspaceTrust: { lifecycleOperationId: 'original-create', workspacePath: value.workspacePath, step: 'trust-record' as const, status: 'unconfirmed' as const,
        trustKey: null, code: 'TEST_NATIVE_CONFIG_UNAVAILABLE', issue: 'Original native configuration is unavailable.', observedAt: 1794210000000 } } } : value) }))
  await app.mount(); await moteClick(button('Discussion'))
  await vi.waitFor(() => expect(document.querySelector('[aria-label="Mote startup"]')).not.toBeNull())
  const card = document.querySelector<HTMLElement>('[aria-label="Mote startup"]')!
  expect(card.textContent).toContain('启动准备需要核对'); expect(card.textContent).toContain('original-create')
  expect(card.querySelector('details')?.open).toBe(false)
  await moteClick(button('重新核对启动', card)); expect(refresh).toHaveBeenCalledWith(defaultAgent.id); expect(recover).not.toHaveBeenCalled(); retained()
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(value => value.id === defaultAgent.id && value.kind === 'agent' ? {
    ...value, terminalFrontend: { run: defaultAgent.control.run, frontendId: 'original-ready-frontend', state: 'attached' as const, backendState: 'running' as const, source: 'managed-process' as const, observedAt: 1794210001000,
      initialization: { lifecycleOperationId: 'original-create', phase: 'ready' as const, native: { state: 'confirmed' as const, sessionId: 'original-ready-native' } } } } : value) })))
  await settleMoteApp(); expect(document.querySelector('[aria-label="Mote startup"]')).toBeNull()
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(value => value.id === defaultAgent.id && value.kind === 'agent' ? {
    ...value, terminalFrontend: undefined, creation: { ...value.creation!, createdRun: { runId: 'old-run' } } } : value) })))
  await settleMoteApp(); expect(document.querySelector('[aria-label="Mote startup"]')).toBeNull()
})
it('a TUI Provider without structured setup still exposes the original saved input waiting for native startup', async () => {
  let stopped = false
  const listeners = new Set<Parameters<typeof api.sessions.onEvent>[0]>()
  vi.spyOn(api.sessions, 'onEvent').mockImplementation(listener => { listeners.add(listener); return () => { listeners.delete(listener) } })
  const key = { kind: 'prompt' as const, agentSessionId: defaultAgent.id, expectedRun: defaultAgent.control.run, submissionId: 'original-waiting-query' }, ref = { key, waitGeneration: 1 }
  const receipt = { key, ref, persistence: 'confirmed' as const, control: { ref, state: 'enabled' as const, at: 1000, waiting: { phase: 'session' as const, reason: 'native-session-starting' as const, wake: 'session-restored' as const } }, admission: null, status: 'waiting' as const, observation: 'owned' as const }
  vi.mocked(api.sessions.inputMailbox).mockImplementation(async (source, options) => ({ agentSessionId: source.agentSessionId, queueId: 'original-input-queue', cut: { incarnation: 'original-incarnation', throughSequence: 1 }, budgetBytes: options?.maxBytes ?? 65536,
    items: [{ kind: 'item', item: { kind: 'controlled', sequence: 1, recordedAt: 1000, intent: { key, admissionIntent: { kind: 'session-conversation', expectedRun: key.expectedRun }, execution: 'immediate', source: { kind: 'prompt', prompt: 'My retained original question', authorHuman: true } },
      receipt: stopped ? { ...receipt, status: 'stopped', observation: 'closed', control: { ref, state: 'stopped-before-dispatch', at: 1100 } } : receipt } }],
    nextCursor: null, coverage: { kind: 'recorded-inputs', unrecorded: 'unconfirmed' } }))
  await app.mount(); await moteClick(button('Discussion'))
  await vi.waitFor(() => expect(document.querySelector('[aria-label="Mote startup"]')?.textContent).toContain('启动状态待确认，原消息已保存'))
  const card = document.querySelector<HTMLElement>('[aria-label="Mote startup"]')!
  expect(card.textContent).not.toContain('trust'); expect(card.querySelector('details')?.open).toBe(false)
  expect(card.textContent).toContain('部分 Agent'); expect(card.textContent).toContain('查看原终端')
  expect(card.querySelectorAll('button')).not.toHaveLength(0); retained()
  stopped = true
  await act(async () => { for (const listener of listeners) listener({ hostId: reference.hostId, event: { type: 'agent-input', receipt: { ...receipt, status: 'stopped', observation: 'closed', control: { ref, state: 'stopped-before-dispatch', at: 1100 } } } }) })
  await vi.waitFor(() => expect(document.querySelector('[aria-label="Mote startup"]')).toBeNull())
  retained()
})
it('a native permission is answered by the existing inline card with its exact original request and no terminal navigation', async () => {
  const request = { kind: 'permission' as const, id: 'original-native-permission', agentSessionId: defaultAgent.id, title: 'Original directory approval',
    options: [{ id: 'allow-once', label: 'Approve original directory', kind: 'allow-once' as const }], evidence: { source: 'native-hook' as const, observedAt: 1794210000000, run: defaultAgent.control.run } }
  const respond = vi.fn(async () => undefined), terminal = vi.fn()
  useAppStore.setState(state => ({ respondInteraction: respond, setViewMode: terminal, sessions: state.sessions.map(value => value.id === defaultAgent.id ? { ...value, pendingInteraction: request } : value) }))
  await app.mount(); await moteClick(button('Discussion'))
  await vi.waitFor(() => expect(document.querySelector('.agent-interaction-source')).not.toBeNull())
  const card = document.querySelector<HTMLElement>('.agent-interaction-source')!
  await moteClick(button('Approve original directory', card))
  expect(respond).toHaveBeenCalledWith(defaultAgent.id, { kind: 'permission', requestId: request.id, decision: { outcome: 'selected', optionId: 'allow-once' } }, expect.objectContaining({ expectedRequest: request, operationId: expect.any(String) }))
  expect(terminal).not.toHaveBeenCalled(); retained()
})
it('a healthy attached terminal with an unconfirmed startup observation is reread without a recovery action', async () => {
  const refresh = vi.fn(async () => undefined), recover = vi.fn(async () => undefined)
  useAppStore.setState(state => ({ refreshSession: refresh, recoverSession: recover, sessions: state.sessions.map(value => value.id === defaultAgent.id ? { ...value,
    terminalFrontend: { run: defaultAgent.control.run, frontendId: 'original-attached', state: 'attached' as const, backendState: 'running' as const, source: 'managed-process' as const, observedAt: 1000,
      initialization: { lifecycleOperationId: 'original-setup', phase: 'unknown' as const, native: { state: 'unknown' as const } } } } : value) }))
  await app.mount(); await moteClick(button('Discussion'))
  await vi.waitFor(() => expect(document.querySelector('[aria-label="Mote startup"]')).not.toBeNull())
  const card = document.querySelector<HTMLElement>('[aria-label="Mote startup"]')!
  await moteClick(button('Check startup', card))
  expect(refresh).toHaveBeenCalledWith(defaultAgent.id); expect(recover).not.toHaveBeenCalled(); retained()
})
