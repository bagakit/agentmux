// @vitest-environment happy-dom
import { act } from 'react'
import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
import * as core from '../../../packages/core/src/index.js'
import type { ConnectionDiagnosisIntake, RoomBinding } from '@agentmux/core/connections'
import { fixture, append, native, imageBlock, imageOperation, contentOperations, closes } from '../../../packages/connectors/test/fixtures/publication-source-owner.js'
import { RuntimeController } from '../src/main/runtime-controller'
import { registerConnectorIpc } from '../src/main/connector-ipc'
import { unwrapSessionInputOperationResult } from '../src/shared/session-input-result'
import { ConnectorDeliveryDetails } from '../src/renderer/src/components/ConnectorDeliveryDetails'
import { ConnectorTrafficSummary } from '../src/renderer/src/components/ConnectorTrafficSummary'
import { connectorGroupSummary } from '../src/renderer/src/lib/connector-group-status'
import { connectorGapExplanation, connectorSourceExplanation } from '../src/renderer/src/lib/connector-diagnosis-explanation'
import { originalInputExplanation } from '../src/renderer/src/lib/original-input-presentation'
import { groupTarget, readGroupDiagnosis } from '../src/renderer/src/lib/group-diagnosis'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const wait = (read: () => unknown | Promise<unknown>) => vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) }); await read() }, { timeout: 10_000, interval: 25 })
const click = async (text: string) => { const button = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === text); expect(button, text).toBeTruthy(); await act(async () => button!.click()) }
const facts = (value: unknown) => { if (process.env.DIAGNOSIS_UI_FACTS) appendFileSync(process.env.DIAGNOSIS_UI_FACTS, JSON.stringify({ case: expect.getState().currentTestName, value }) + '\n') }

/** Existing official SDK/loopback publication fixture, registered IPC and real Main/Hosted owner.
 * Transport readiness is a controlled native observation; source faults and public diagnosis remain owner-produced. */
async function consumer() {
  const f = await fixture(), starts = vi.spyOn(f.inner.kernel, 'start'), inspect = f.services.connections.inspect.bind(f.services.connections)
  vi.spyOn(f.services.connections, 'inspect').mockImplementation(async input => {
    const result = await inspect(input)
    return { ...result, connection: result.connection ? { ...result.connection, receiver: { ref: 'original-ui-receiver', state: 'ready' as const }, observation: {
      ...result.connection.observation, authentication: { state: 'ready' as const }, transport: { state: 'ready' as const }, intake: { state: 'ready' as const }
    } } : null }
  })
  const hosted = await core.connectHostedAgentMux({ rpc: f.rpc, waitForReady: false, forwardRpc: (method, input, context = {}, expected) => f.rpc.call(method, input,
    { ...(context.signal ? { signal: context.signal } : {}), ...(expected ?? context.runtimeFence ? { runtimeFence: expected ?? context.runtimeFence } : {}) }) }); closes.push(() => hosted.dispose())
  vi.spyOn(hosted, 'connect').mockRejectedValue(Error('Only startup observation is controlled'))
  const controller = new RuntimeController(f.store, async () => hosted); closes.push(() => controller.dispose()); controller.commit(await controller.prepare(composerConfig))
  const hostingTarget = { hostId: 'local', runtimeId: 'original-image-runtime' }, handlers = new Map<string, (...args: any[]) => Promise<unknown>>(), trusted = vi.fn()
  registerConnectorIpc({ handleWithEvent: (method, handler) => handlers.set(method, handler),  runtime: controller, metadata: { publish() {}, observation() {} } })
  const calls: Array<{ method: string; input: any; target: any }> = []; let failInspect = false, held: Promise<void> | undefined, release = () => {}
  closes.push(() => release())
  vi.spyOn(api.connections, 'call').mockImplementation(async (method, input, target) => {
    calls.push({ method, input: structuredClone(input), target: structuredClone(target) })
    if (method === 'connection.delivery.inspect' && failInspect) { failInspect = false; throw Error('Controlled original observation loss') }
    const result = await handlers.get('connections:call')!({}, method, input, target)
    if (method === 'connection.delivery.inspect') await held
    return unwrapSessionInputOperationResult(structuredClone(result)) as any
  })
  vi.spyOn(api.config, 'get').mockResolvedValue(composerConfig)
  useAppStore.setState({ connectorRoomIntents: {}, agentComposerDrafts: { 'original-agent': 'Keep the original diagnosis draft' } })
  const unchanged = () => { expect(starts).not.toHaveBeenCalled(); expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled(); expect(useAppStore.getState().agentComposerDrafts['original-agent']).toBe('Keep the original diagnosis draft'); expect(calls.every(call => JSON.stringify(call.target) === JSON.stringify(hostingTarget))).toBe(true);  }
  return { ...f, hostingTarget, calls, unchanged, mount: (binding: RoomBinding = f.binding) => dom.render(<ConnectorDeliveryDetails binding={binding} hostingTarget={hostingTarget} />),
    failInspect: () => { failInspect = true }, hold: () => { held = new Promise<void>(resolve => { release = resolve }) }, release: () => { held = undefined; release() } }
}

it('shows real BUSY and timeout causes, follows the original older receipt and keeps unknown effects read-only through Main and Hosted', async () => {
  const f = await consumer()
  f.remote.controls.unknownImageMessage = true
  await append(f, native('original-unknown-effect', [imageBlock()])); f.services.publication!.refresh()
  await wait(() => expect(imageOperation(f)?.state).toBe('unknown'))
  const original = imageOperation(f)!
  f.remote.controls.unknownImageMessage = false
  await append(f, { sessionId: 'ingress-native', uuid: 'unqualified-original-user', type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Original input without public qualification' }] } })
  for (let index = 0; index < 6; index++) await append(f, native('later-original-' + index, [{ type: 'text', text: 'Independent original reply ' + index }]))
  f.services.publication!.refresh()
  await wait(() => expect(contentOperations(f.services.publication!.store, f.binding).filter(row => row.state === 'confirmed')).toHaveLength(6))
  const beforeWrites = f.remote.calls.filter(call => call.method === 'POST' && call.path === '/open-apis/im/v1/messages').length
  let fault: 'AGENT_SESSION_HISTORY_BUSY' | 'AGENT_SESSION_HISTORY_TIMEOUT' | null = 'AGENT_SESSION_HISTORY_BUSY'
  const changes = f.port.changes.bind(f.port)
  vi.spyOn(f.port, 'changes').mockImplementation((...args) => fault ? Promise.reject(new core.AgentMuxError('Controlled native source reading fault', fault)) : changes(...args))
  f.services.publication!.refresh()
  await wait(async () => expect((await f.services.publication!.list({ connectionId: f.binding.connectionId, bindingId: f.binding.bindingId, bindingRevision: f.binding.revision })).sourceObservation?.code).toBe(fault))
  await f.mount(); await wait(() => expect(dom.container.querySelector('[data-direction="outgoing"] strong')?.textContent).toBe('Conversation reading is busy'))
  expect(dom.container.textContent).toContain('Other reads are still running.')
  expect(dom.container.textContent).not.toContain('No finer reason was recorded. A reason')
  expect(dom.container.querySelector('[data-receiver-action="recover"]')).toBeNull()
  expect([...dom.container.querySelectorAll('button')].filter(node => node.textContent === 'Check read result')).toHaveLength(1)
  expect([...dom.container.querySelectorAll('button')].filter(node => node.textContent === 'Check group activity')).toHaveLength(0)
  fault = 'AGENT_SESSION_HISTORY_TIMEOUT'; f.services.publication!.refresh()
  await wait(async () => expect((await f.services.publication!.list({ connectionId: f.binding.connectionId, bindingId: f.binding.bindingId, bindingRevision: f.binding.revision })).sourceObservation?.code).toBe(fault))
  await click('Check read result'); await wait(() => expect(dom.container.querySelector('[data-direction="outgoing"] strong')?.textContent).toBe('Conversation read timed out'))
  fault = null; f.services.publication!.refresh()
  await wait(async () => expect((await f.services.publication!.list({ connectionId: f.binding.connectionId, bindingId: f.binding.bindingId, bindingRevision: f.binding.revision })).sourceObservation?.state).toBe('ready'))
  await click('Check read result'); await wait(() => expect(dom.container.textContent).toContain('Some content is not ready to share'))
  expect(dom.container.textContent).toContain('No finer reason was recorded.')
  expect(dom.container.textContent).toContain('Earlier delivery results unconfirmed')
  expect(f.calls.filter(call => call.method === 'connection.delivery.inspect')).toHaveLength(0)
  const report = await readGroupDiagnosis((method, input) => api.connections.call(method, input, f.hostingTarget), groupTarget(f.binding)), cursor = report.outgoing.value!.next!
  await click('View earlier receipts')
  await wait(() => expect(f.calls.some(call => call.method === 'connection.diagnose' && call.input.after === cursor)).toBe(true))
  await wait(() => expect([...dom.container.querySelectorAll<HTMLElement>('[data-delivery-operation]')].some(node => node.dataset.deliveryOperation === original.operationId)).toBe(true))
  const row = [...dom.container.querySelectorAll<HTMLElement>('[data-delivery-operation]')].find(node => node.dataset.deliveryOperation === original.operationId)!
  await act(async () => row.querySelector<HTMLButtonElement>('button')!.click())
  await wait(() => expect(dom.container.querySelector('[data-selected-delivery]')?.getAttribute('data-selected-delivery')).toBe(original.operationId))
  expect(dom.container.querySelector('[data-delivery-action="retry"]')).toBeNull(); expect(dom.container.querySelector('[data-delivery-action="continue"]')).toBeNull()
  f.failInspect(); await dom.click('[data-delivery-action="inspect"]'); await wait(() => expect(dom.container.textContent).toContain('Original result observation unconfirmed'))
  expect(dom.container.querySelector('[data-selected-delivery]')?.getAttribute('data-selected-delivery')).toBe(original.operationId)
  f.hold(); await dom.click('[data-delivery-action="inspect"]'); await f.mount({ ...f.binding, bindingId: 'other-original-group' }); f.release()
  await wait(() => expect(f.calls.some(call => call.method === 'connection.diagnose' && call.input.bindingId === 'other-original-group')).toBe(true))
  expect(dom.container.querySelector('[data-selected-delivery]')).toBeNull()
  expect(f.calls.filter(call => call.method === 'connection.delivery.retry' || call.method === 'connection.receiver.recover')).toHaveLength(0)
  expect(f.remote.calls.filter(call => call.method === 'POST' && call.path === '/open-apis/im/v1/messages')).toHaveLength(beforeWrites)
  f.unchanged(); facts({ originalOperationId: original.operationId, cursor, calls: f.calls, beforeWrites, afterWrites: beforeWrites, fixtureTransportObservation: 'ready', sourceCodes: ['AGENT_SESSION_HISTORY_BUSY', 'AGENT_SESSION_HISTORY_TIMEOUT'], noInputOrLifecycleWrites: true })
}, 35_000)

it('keeps this group input facts when a bot-wide intake check fails, without inventing finer causes or rejoin authority', async () => {
  const f = await consumer(), report = await readGroupDiagnosis((method, input) => api.connections.call(method, input, f.hostingTarget), groupTarget(f.binding))
  const row: ConnectionDiagnosisIntake = { ingressId: 'original-group-input', sourceConnectionId: f.binding.connectionId, kind: 'message', state: 'claimed', code: null, codeRecorded: false,
    bindingId: f.binding.bindingId, bindingRevision: f.binding.revision, targetConnectionId: f.binding.connectionId, scope: 'current-binding', inputOperationId: 'original-control-input', recording: { state: 'recorded' }, coreStatus: 'admitted', coreObservation: 'observed', nativeAdoption: null, waiting: null }
  const original = { ...report, connection: { ...report.connection, value: { ...report.connection.value!, intake: { state: 'unknown' as const, reason: 'check-failed' as const } } }, incoming: { issue: null, value: { beforeIngressId: null, next: null, rows: [row] } } }
  await dom.render(<ConnectorTrafficSummary summary={connectorGroupSummary(original)} />)
  expect(dom.container.querySelector('[data-direction="incoming"] strong')?.textContent).toBe('Last message: Accepted by Agent')
  expect(dom.container.textContent).toContain('This may concern another group or an earlier event.')
  expect(dom.container.textContent).not.toContain('Inputs need checking')
  const before = f.calls.length
  for (const [status, title] of [['saved', 'Saved input'], ['hook-written', 'Input hook written'], ['acp-acknowledged', 'CLI acknowledgement received'], ['terminal-confirmed', 'Input written to terminal'], ['unknown', 'Input result is unknown']] as const) {
    await dom.render(<ConnectorTrafficSummary summary={connectorGroupSummary({ ...original, incoming: { issue: null, value: { ...original.incoming.value, rows: [{ ...row, coreStatus: status }] } } })} />)
    expect(dom.container.querySelector('[data-direction="incoming"] strong')?.textContent).toBe(title)
    expect(dom.container.querySelector('[data-input-wait-action="rejoin"]')).toBeNull()
  }
  expect(f.calls).toHaveLength(before)
  expect(originalInputExplanation('waiting', { phase: 'authorization', reason: 'author-authorization-needed', wake: 'explicit-rejoin' }).detail).toBe('This saved input needs an explicit resume to continue.')
  expect(connectorSourceExplanation({ state: 'unavailable', code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED', codeRecorded: true, checkpointKey: null }).title).toBe('Saved conversation source changed')
  expect(connectorSourceExplanation({ state: 'unavailable', code: 'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE', codeRecorded: true, checkpointKey: null }).title).toBe('Conversation identity unavailable')
  expect(connectorGapExplanation({ reason: 'source-gap', code: 'AGENT_SESSION_HISTORY_BUDGET', codeRecorded: true }).detail).toContain('current reading window')
  for (const codeRecorded of [true, false]) expect(connectorGapExplanation({ reason: 'public-content-unconfirmed', code: null, codeRecorded }).detail).toContain(codeRecorded ? 'safe detail is not available' : 'No finer reason was recorded')
  const paused = connectorGroupSummary({ ...original, service: { value: { enabled: false, revision: 2 }, issue: null } })
  expect(paused.problems.find(problem => problem.kind === 'sync-off')?.action?.kind).toBe('sync')
  expect(paused.problems.map(problem => problem.detail).join(' ')).not.toMatch(/automatically|retrying|will reconnect/)
  f.unchanged(); facts({ originalInputStage: 'admitted', botWideScopeKept: true, legacyStagesKept: true, noAutomaticInputRead: f.calls.length === before, originalCalls: f.calls })
})
