// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createMoteApp, moteClick, settleMoteApp, type MoteAppFixture } from './fixtures/mote-app'
import { defaultAgent, defaultTab, moteTopics, scratchWorkspace } from './fixtures/mote-workface'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { useLauncherState, initializeLauncherState } from '../src/renderer/src/lib/launcher-state'
import type { ContinuousProgressLoop } from '@agentmux/core/continuous-progress-scheduler'
import type { MoteDialoguePage } from '@agentmux/core/mote-dialogue'
import type { MoteQuickPreferencesSaveParams } from '@agentmux/core/mote-preferences'
import { originalMoteHeartbeatReport } from '../src/renderer/src/lib/mote-heartbeat-report'

let app: MoteAppFixture, schedule: ContinuousProgressLoop, page: MoteDialoguePage
const topic = moteTopics[0]!, documentRevision = 'sha256:' + 'a'.repeat(64), role = 'legacy:' + documentRevision
const main = { hostId: 'local', sessionId: defaultAgent.id, displayWorkspaceId: scratchWorkspace.id, groupId: 'mote-group', tabId: defaultTab.id, regionId: defaultTab.layout.activeRegionId }
const defaults = { executorId: 'fixture', conversation: main, presence: { enabled: true, intervalMs: 1800000 } }
const button = (label: string, root: ParentNode = document) => { const found = [...root.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === label || node.getAttribute('aria-label') === label); expect(found, label).toBeDefined(); return found! }
const originalInput = () => ({ kind: 'prompt' as const, agentSessionId: defaultAgent.id, expectedRun: { ...defaultAgent.control.run }, submissionId: 'original-tick' })
const safeInput = () => ({ reference: structuredClone(schedule.lastInputRef!), status: 'confirmed' as const, delivery: 'terminal-confirmed' as const, nativeResult: { state: 'unsupported' as const } })
beforeEach(async () => {
  app = createMoteApp(); useLauncherState.setState({ drafts: {} }); await initializeLauncherState()
  schedule = { loopId: 'original-heartbeat', hostId: 'local', agentSessionId: defaultAgent.id, providerId: defaultAgent.providerId, workspacePath: defaultAgent.workspacePath,
    everyMs: 1800000, intervalMs: 1800000, prompt: 'PRIVATE SYSTEM GUIDANCE', revision: 3, creationOperationId: 'original-definition-operation', futureIntentId: 'original-definition', status: 'active', nextCheckAt: 60000, lastTickAt: 30000, lastTickId: 'later-skipped-check', lastOutcome: 'skipped',
    managedSource: { sourceId: 'original-mote', revision: role }, lastInputRef: { inputKey: originalInput(), futureIntent: { intentId: 'original-definition', occurrenceAt: 1000 }, definitionOperationId: 'original-definition-operation', managedSource: { sourceId: 'original-mote', revision: role }, preparedAt: 1200 } }
  const topics = [{ ...topic, quickMode: { status: 'saved' as const, version: 'original-preferences', defaults } }, ...moteTopics.slice(1)]
  useAppStore.setState({ scratchTopicSnapshots: { [scratchWorkspace.id]: { scope: scratchTopicsScope(scratchWorkspace), revision: 1, topics, reading: false, error: null } } })
  vi.mocked(api.scratch.listTopics).mockResolvedValue(topics)
  vi.mocked(api.scratch.readTopic).mockImplementation(async (_workspace, id) => topics.find(item => item.id === id) ?? null)
  vi.spyOn(api.files, 'readDirectory').mockResolvedValue([])
  vi.spyOn(api.motePreferences, 'read').mockImplementation(async params => ({ target: params.target, kind: 'quick', status: 'ready', main: true, issue: null, defaults,
    source: { resource: { ...params.target.expectedResource, zoneId: params.target.zoneId, zonePath: topic.directoryPath, path: topic.directoryPath.slice(scratchWorkspace.path.length + 1) + '/MOTE.md' }, result: { status: 'read', document: { path: topic.directoryPath.slice(scratchWorkspace.path.length + 1) + '/MOTE.md', content: 'Original user notes', revision: documentRevision } } },
    choices: params.includeChoices === false ? null : { executors: [{ id: 'fixture', name: 'Fixture', providerId: 'fixture' }], conversations: [], destinations: [] }, maintenance: { status: 'active', schedule, issue: null,
      guidance: { availableRevision: 'new-guide', currentDefinition: { intentId: 'original-definition', operationId: 'original-definition-operation' }, adoptedRevision: null, adoptions: [] } } }))
  vi.spyOn(api.schedule, 'inspect').mockImplementation(async () => ({ schedule: structuredClone(schedule), input: safeInput(), executionScope: 'connected-host' }))
  vi.spyOn(api.moteDialogue, 'read').mockImplementation(async query => {
    page ??= { main: { target: query.target, identity: { hostId: 'local', moteId: topic.id }, status: 'ready', resource: null, documentRevision, roleRevision: role, current: main, issue: null },
      links: [], incarnation: 'original-report-source', throughSequence: 0, next: null, coverage: 'linked-sources-only', sourceStatus: 'read', sourceIssue: null }
    return page
  })
  page = undefined as unknown as MoteDialoguePage
})
afterEach(async () => { await app.dispose(); useLauncherState.setState({ drafts: {} }) })
function retained() { expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled() }
async function profile() { await app.mount(); await moteClick(button('Profile')); await vi.waitFor(() => expect(document.querySelector('.mote-quick-mode [aria-label="Mote heartbeat"]')?.textContent, document.querySelector('.mote-quick-mode .mote-heartbeat__issue')?.textContent ?? 'Original heartbeat read').toContain('Sent · acceptance unconfirmed')); return document.querySelector<HTMLElement>('.mote-quick-mode [aria-label="Mote heartbeat"]')! }
it('the actual App reads safe input immediately and separates the last input from a newer skipped check', async () => {
  const card = await profile()
  expect(card.textContent).toContain('No input sent on this check'); expect(card.textContent).toContain('Execution result unconfirmed')
  expect(card.textContent).not.toContain('PRIVATE SYSTEM GUIDANCE'); expect(card.querySelector('pre')).toBeNull()
  expect(api.schedule.inspect).toHaveBeenCalledWith({ scheduleId: schedule.loopId }, 'local')
  expect(api.moteDialogue.read).toHaveBeenCalledWith(expect.objectContaining({ kind: 'heartbeat', limit: 20 }))
  retained()
})
it('the original report summary is visible without treating an Agent statement or observed Idea as task completion', async () => {
  await profile()
  page.links = [{ kind: 'heartbeat', attribution: 'agent-statement', sequence: 1, identity: page.main.identity!, operationId: 'independent-report-operation', associatedAt: 3000,
    source: { inputKey: originalInput(), scheduleId: schedule.loopId, definitionIntentId: schedule.futureIntentId!, occurrenceAt: 1000, mainRoleRevision: role },
    author: { hostId: 'local', agentSessionId: defaultAgent.id, run: defaultAgent.control.run }, report: { disposition: 'quiet', summary: 'A useful experiment was saved for later review.', inspected: [], actions: [{ kind: 'idea', path: 'ideas/experiment.md', resource: { ...page.main.target.expectedResource, zoneId: page.main.target.zoneId, zonePath: topic.directoryPath, path: topic.directoryPath.slice(scratchWorkspace.path.length + 1) + '/ideas/experiment.md' }, revision: documentRevision }] }, ideaEvidence: [{ actionIndex: 0, status: 'observed-file', revision: documentRevision, observedAt: 3100 }] }]
  page.throughSequence = 1
  await moteClick(button('Refresh actual schedule', document.querySelector('.mote-quick-mode')!))
  await vi.waitFor(() => expect(document.querySelector('.mote-heartbeat__report-summary')?.textContent).toContain('useful experiment'))
  expect(document.querySelector('.mote-heartbeat__report-summary')?.closest('details')).toBeNull()
  const summary = document.querySelector('.mote-quick-mode .mote-heartbeat__report-summary')!, metadata = document.querySelector('.mote-quick-mode .mote-heartbeat__reading')!
  expect(summary.compareDocumentPosition(metadata) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(document.querySelector('.mote-heartbeat__idea')?.textContent).toContain('File revision observed')
  expect(button('Open Idea', document.querySelector('.mote-quick-mode')!)).toBeDefined()
  const before = useAppStore.getState().workbenchSpaceSelection
  const ownReport = page.links[0]!
  if (ownReport.kind !== 'heartbeat' || ownReport.report.actions[0]?.kind !== 'idea') throw Error('Original Idea fixture required')
  ownReport.report.actions[0].resource.zoneId = 'another-mote-zone'
  await moteClick(button('Refresh actual schedule', document.querySelector('.mote-quick-mode')!))
  await vi.waitFor(() => expect([...document.querySelectorAll('.mote-quick-mode button')].some(node => node.textContent === 'Open Idea')).toBe(false))
  expect(useAppStore.getState().workbenchSpaceSelection).toEqual(before)
  expect(document.querySelector('.mote-heartbeat-lamp')?.getAttribute('data-mote-care')).toBe('active')
  expect(document.querySelector('.global-system-notices__details')?.textContent).not.toContain('Mote work report needs attention')
  const copied = structuredClone(page); copied.links[0]!.kind === 'heartbeat' && (copied.links[0]!.source.inputKey.submissionId = 'another-tick')
  expect(originalMoteHeartbeatReport(schedule.lastInputRef, schedule.loopId, { page: copied, issue: null })).toBeNull()
  retained()
})
it('a later original ref replaces the safe reading without retaining a previous completed result', async () => {
  await profile()
  const next = structuredClone(schedule); next.lastInputRef!.inputKey.submissionId = 'new-tick'; next.lastInputRef!.futureIntent.occurrenceAt++
  schedule = next
  vi.mocked(api.schedule.inspect).mockImplementation(async () => ({ schedule, executionScope: 'connected-host' }))
  await moteClick(button('Refresh actual schedule', document.querySelector('.mote-quick-mode')!))
  await vi.waitFor(() => expect(document.querySelector('.mote-quick-mode [aria-label="Mote heartbeat"]')?.textContent).toContain('Delivery unconfirmed'))
  expect(document.querySelector('.mote-quick-mode [aria-label="Mote heartbeat"]')?.textContent).not.toContain('Sent · acceptance unconfirmed')
  retained()
})
it('explicit guidance adoption freezes a complete original request across modal unmount and continues the same operation', async () => {
  const card = await profile(); await moteClick(button('Configure heartbeat', card))
  let dialog = document.querySelector<HTMLElement>('.mote-quick-mode-dialog')!
  const calls: MoteQuickPreferencesSaveParams[] = []
  vi.spyOn(api.motePreferences, 'save').mockImplementation(async input => { if (input.kind !== 'quick') throw Error('Wrong fixture owner'); calls.push(structuredClone(input)); throw Error('Original writer response unavailable') })
  await moteClick(button('Use updated guidance', dialog))
  await vi.waitFor(() => expect(calls).toHaveLength(1))
  const stored = Object.values(useLauncherState.getState().drafts).find(value => value.moteQuick?.pending)?.moteQuick
  expect(stored?.pending?.input).toEqual(calls[0]); expect(stored?.pending?.phase).toBe('may-have-dispatched')
  expect(calls[0]?.action?.expectedMain.roleRevision).toBe(role)
  expect(calls[0]?.values).toEqual(calls[0]?.baseline.defaults)
  await moteClick(button('Cancel', dialog)); await moteClick(button('Configure heartbeat', card)); dialog = document.querySelector<HTMLElement>('.mote-quick-mode-dialog')!
  await vi.waitFor(() => expect(dialog.textContent).toContain('Check original adoption'))
  await moteClick(button('Check original adoption', dialog)); await vi.waitFor(() => expect(calls).toHaveLength(2))
  expect(calls[1]).toEqual(calls[0]); retained()
})
it('closing while the original resume checkpoint is held sends no resume and reopening only inspects it', async () => {
  schedule.status = 'paused'; schedule.pause = { reason: 'manual', episodeId: 'manual-pause', pausedAt: 2000 }
  const read = vi.mocked(api.motePreferences.read).getMockImplementation()!
  vi.mocked(api.motePreferences.read).mockImplementation(async input => { const result = await read(input); return { ...result, maintenance: { ...result.maintenance!, status: 'paused' } } })
  const card = await profile(); await moteClick(button('Configure heartbeat', card))
  let release!: () => void
  vi.spyOn(api.ui, 'requestStorageFlush').mockImplementation(() => new Promise<void>(resolve => { release = resolve }))
  const resume = vi.spyOn(api.schedule, 'resume')
  await moteClick(button('Resume saved heartbeat', document.querySelector('.mote-quick-mode-dialog')!))
  await vi.waitFor(() => expect(release).toBeDefined())
  const held = Object.values(useLauncherState.getState().drafts).find(value => value.moteQuick?.resume)?.moteQuick?.resume
  expect(held?.operationId).toBeTruthy()
  await moteClick(button('Cancel', document.querySelector('.mote-quick-mode-dialog')!)); await act(async () => release()); await settleMoteApp()
  expect(resume).not.toHaveBeenCalled()
  await moteClick(button('Configure heartbeat', card)); await vi.waitFor(() => expect(document.querySelector('.mote-quick-mode-dialog')?.textContent).toContain('Inspect original resume'))
  expect(resume).not.toHaveBeenCalled(); retained()
})
it.each(['resolve', 'reject'] as const)('a late adoption %s cannot overwrite a later reopened raw draft', async ending => {
  const card = await profile(); await moteClick(button('Configure heartbeat', card))
  let finish!: (value: any) => void, fail!: (error: Error) => void, request: MoteQuickPreferencesSaveParams | undefined
  vi.spyOn(api.motePreferences, 'save').mockImplementation(input => { request = input as MoteQuickPreferencesSaveParams; return new Promise((resolve, reject) => { finish = resolve; fail = reject }) })
  await moteClick(button('Use updated guidance', document.querySelector('.mote-quick-mode-dialog')!))
  await vi.waitFor(() => expect(request).toBeDefined())
  await moteClick(button('Cancel', document.querySelector('.mote-quick-mode-dialog')!)); await moteClick(button('Configure heartbeat', card))
  const dialog = document.querySelector<HTMLElement>('.mote-quick-mode-dialog')!, field = dialog.querySelector<HTMLInputElement>('[aria-label="Heartbeat interval (minutes)"]')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, '47'); field.dispatchEvent(new Event('input', { bubbles: true })); field.dispatchEvent(new Event('change', { bubbles: true })) })
  await vi.waitFor(() => expect(Object.values(useLauncherState.getState().drafts).find(value => value.moteQuick?.pending)?.moteQuick?.minutes).toBe('47'))
  const before = structuredClone(useLauncherState.getState().drafts)
  await act(async () => {
    if (ending === 'reject') fail(Error('Original response unavailable'))
    else finish({ kind: 'quick', target: request!.target, operationId: request!.operationId, status: 'unchanged', source: request!.baseline, message: null, maintenanceAdoption: { loopId: schedule.loopId, operationId: request!.operationId, requestDigest: 'b'.repeat(64), actor: { kind: 'user', id: 'fixture-user' }, expectedRevision: request!.action!.expectedSchedule.revision,
      oldDefinition: request!.action!.expectedDefinition, newDefinition: { intentId: 'updated-definition', operationId: 'updated-definition-operation', baseIntentId: 'original-definition', guidanceRevision: 'new-guide' }, guidance: 'Updated original guidance', preparedAt: 4000, publishedAt: 4100, state: 'adopted', issue: null } })
  }); await settleMoteApp()
  const expected = structuredClone(before)
  if (ending === 'resolve') for (const draft of Object.values(expected)) if (draft.moteQuick?.pending?.input.operationId === request!.operationId) delete draft.moteQuick.pending
  expect(useLauncherState.getState().drafts).toEqual(expected)
  expect(field.value).toBe('47'); expect(document.querySelector('.mote-quick-mode-dialog')).toBe(dialog); retained()
})
it('a typed failed input stays visible beside a quiet statement and its reminder opens a read-only original inspection', async () => {
  vi.mocked(api.schedule.inspect).mockImplementation(async () => ({ schedule, input: { ...safeInput(), delivery: 'native-admitted', nativeResult: { state: 'failed', observedAt: 2300 } }, executionScope: 'connected-host' }))
  const readReports = vi.mocked(api.moteDialogue.read).getMockImplementation()!
  vi.mocked(api.moteDialogue.read).mockImplementation(async query => {
    const result = await readReports(query)
    return query.kind !== 'heartbeat' ? result : { ...result, throughSequence: 1, links: [{ kind: 'heartbeat', attribution: 'agent-statement', sequence: 1, identity: result.main.identity!, operationId: 'quiet-original-report', associatedAt: 3000,
      source: { inputKey: originalInput(), scheduleId: schedule.loopId, definitionIntentId: schedule.futureIntentId!, occurrenceAt: 1000, mainRoleRevision: role }, author: { hostId: 'local', agentSessionId: defaultAgent.id, run: defaultAgent.control.run },
      report: { disposition: 'quiet', summary: 'The Agent had no further update to report.', inspected: [], actions: [] }, ideaEvidence: [] }] }
  })
  await app.mount(); await moteClick(button('Profile'))
  await vi.waitFor(() => expect(document.querySelector('.mote-quick-mode [aria-label="Mote heartbeat"]')?.textContent).toContain('This input failed'))
  const center = document.querySelector<HTMLElement>('.global-system-notices__details')!
  await act(async () => center.showPopover()); await settleMoteApp()
  const row = center.querySelector<HTMLElement>('.notification-item[data-notice-id^="mote-heartbeat:"]')!
  expect(row?.textContent).toContain('Heartbeat input needs attention')
  await moteClick(button('Inspect original heartbeat', row))
  const dialog = document.querySelector<HTMLElement>('.mote-quick-mode-dialog')!
  await vi.waitFor(() => expect(dialog.textContent).toContain('Original heartbeat'))
  expect(dialog.textContent).toContain('This input failed')
  expect(dialog.textContent).not.toContain('Use updated guidance'); expect([...dialog.querySelectorAll('button')].some(node => ['Save', 'Resume saved heartbeat', 'Check original adoption'].includes(node.textContent!))).toBe(false)
  retained()
})
it('a failed original checkpoint retains the full adoption request without dispatching it', async () => {
  const card = await profile(); await moteClick(button('Configure heartbeat', card))
  vi.spyOn(api.ui, 'requestStorageFlush').mockRejectedValue(Error('Original device writer unavailable'))
  const save = vi.spyOn(api.motePreferences, 'save')
  await moteClick(button('Use updated guidance', document.querySelector('.mote-quick-mode-dialog')!))
  await vi.waitFor(() => expect(document.querySelector('.mote-quick-mode-dialog')?.textContent).toContain('Original device writer unavailable'))
  expect(save).not.toHaveBeenCalled()
  const pending = Object.values(useLauncherState.getState().drafts).find(value => value.moteQuick?.pending)?.moteQuick?.pending
  expect(pending?.input.action?.kind).toBe('adopt-current-guidance'); expect(pending?.input.baseline.document?.content).toBe('Original user notes')
  retained()
})

it('the actual Care dialog offers the work cycle outside closed details without adopting on open', async () => {
  await app.mount()
  const save = vi.spyOn(api.motePreferences, 'save')
  await vi.waitFor(() => expect(document.querySelector('.mote-heartbeat-lamp')?.getAttribute('data-mote-care')).toBe('active'))
  await moteClick(document.querySelector<HTMLButtonElement>('.mote-heartbeat-lamp')!)
  const dialog = document.querySelector<HTMLElement>('.mote-quick-mode-dialog')!
  await vi.waitFor(() => expect(dialog.textContent).toContain('Use updated guidance'))
  expect(button('Use updated guidance', dialog).closest('details:not([open])')).toBeNull()
  expect(dialog.querySelector('.mote-heartbeat__guidance-status')?.textContent).toBe('Work cycle adoption not confirmed')
  expect(dialog.querySelector('.mote-heartbeat__details')?.hasAttribute('open')).toBe(false)
  expect(save).not.toHaveBeenCalled(); retained()
})
it.each(['current', 'missing'] as const)('the current work cycle shows its original %s guidance receipt without a false old-version claim', async state => {
  const read = vi.mocked(api.motePreferences.read).getMockImplementation()!
  vi.mocked(api.motePreferences.read).mockImplementation(async input => {
    const value = await read(input), maintenance = { ...value.maintenance! }
    if (state === 'current') maintenance.guidance = { ...maintenance.guidance!, adoptedRevision: maintenance.guidance!.availableRevision }
    else delete maintenance.guidance
    return { ...value, maintenance }
  })
  await profile()
  await moteClick(button('Configure heartbeat', document.querySelector('.mote-quick-mode')!))
  const dialog = document.querySelector<HTMLElement>('.mote-quick-mode-dialog')!
  await vi.waitFor(() => expect(dialog.textContent).toContain('Saved settings loaded'))
  expect([...dialog.querySelectorAll('button')].some(node => node.textContent === 'Use updated guidance')).toBe(false)
  expect(dialog.querySelector('.mote-heartbeat__guidance-status')?.textContent ?? null).toBe(state === 'current' ? 'Current work cycle adopted' : null)
  expect(dialog.textContent).not.toContain('old version'); retained()
})
it('an unavailable original read does not turn a retained guidance receipt into current confirmation', async () => {
  const read = vi.mocked(api.motePreferences.read).getMockImplementation()!
  vi.mocked(api.motePreferences.read).mockImplementation(async input => {
    const value = await read(input)
    return { ...value, maintenance: { ...value.maintenance!, guidance: { ...value.maintenance!.guidance!, adoptedRevision: value.maintenance!.guidance!.availableRevision } } }
  })
  const card = await profile()
  expect(card.querySelector('.mote-heartbeat__guidance-status')?.textContent).toBe('Current work cycle adopted')
  vi.mocked(api.schedule.inspect).mockRejectedValue(Error('Original schedule read unavailable'))
  await moteClick(button('Refresh actual schedule', card))
  await vi.waitFor(() => expect(card.querySelector('.mote-heartbeat__guidance-status')?.textContent).toBe('Work cycle adoption not confirmed'))
  expect(card.textContent).toContain('Original schedule read unavailable'); retained()
})
