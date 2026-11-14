// @vitest-environment happy-dom
import { act } from 'react'
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

let app: MoteAppFixture, maintenance: MotePresenceReading
const closes: Array<() => Promise<unknown>> = []
const topic = moteTopics[0]!
const reference = { hostId: 'local', sessionId: defaultAgent.id, displayWorkspaceId: scratchWorkspace.id,
  groupId: 'mote-group', tabId: defaultTab.id, regionId: defaultTab.layout.activeRegionId }
const loop = (): ContinuousProgressLoop => ({ loopId: 'original-heartbeat', hostId: 'local', agentSessionId: defaultAgent.id, providerId: defaultAgent.providerId,
  workspacePath: defaultAgent.workspacePath, everyMs: 1800000, intervalMs: 1800000, prompt: 'original work check', revision: 4, status: 'paused', nextCheckAt: 1794213600000,
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
  expect(api.schedule.list).toHaveBeenCalledWith({ target: { hostId: reference.hostId, agentSessionId: reference.sessionId, providerId: defaultAgent.providerId, workspacePath: defaultAgent.workspacePath } })
  const resume = vi.spyOn(api.schedule, 'resume')
  await moteClick(button('Configure heartbeat', card))
  const dialog = document.querySelector<HTMLElement>('.mote-quick-mode-dialog')!
  expect(dialog.querySelector('[aria-label="Enable automatic Mote maintenance"]')?.closest('details')).toBeNull()
  expect(dialog.querySelector('[aria-label="Mote heartbeat"]')?.textContent).toContain('Delivery unconfirmed')
  await moteClick(button('Cancel', dialog)); expect(resume).not.toHaveBeenCalled(); retained()
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
