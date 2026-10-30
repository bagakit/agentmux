// @vitest-environment happy-dom
import { act } from 'react'
import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
import * as core from '../../../packages/core/src/index.js'
import { fixture, closes } from '../../../packages/connectors/test/fixtures/publication-source-owner.js'
import { context } from '../../../packages/connectors/test/fixtures/room-binding.js'
import { RuntimeController } from '../src/main/runtime-controller'
import { registerConnectorIpc } from '../src/main/connector-ipc'
import { unwrapSessionInputOperationResult } from '../src/shared/session-input-result'
import { AgentConnectorDialog } from '../src/renderer/src/components/AgentConnectorDialog'
import { ConnectorConnectionOverview } from '../src/renderer/src/components/ConnectorConnectionOverview'
import { SettingsNavigation } from '../src/renderer/src/components/SettingsNavigation'
import { settingsCatalog } from '../src/renderer/src/components/settings/settings-modules'
import { connectorConnectionPresentation } from '../src/renderer/src/lib/connector-connection-presentation'
import { api } from '../src/renderer/src/lib/api'
import { groupTarget, readGroupDiagnosis } from '../src/renderer/src/lib/group-diagnosis'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
const dom = composerDOM(), host = { hostId: 'local', runtimeId: 'original-image-runtime' }
const facts = (value: unknown) => { if (process.env.CONNECTION_OVERVIEW_FACTS) appendFileSync(process.env.CONNECTION_OVERVIEW_FACTS, JSON.stringify({ case: expect.getState().currentTestName, value }) + '\n') }
const wait = (read: () => unknown | Promise<unknown>) => vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) }); await read() }, { timeout: 10000, interval: 25 })
const click = async (text: string) => { const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === text || node.getAttribute('role') === 'tab' && node.querySelector('span')?.textContent === text); expect(button, text).toBeTruthy(); await act(async () => button!.click()) }
async function consumer() {
  const f = await fixture(), starts = vi.spyOn(f.inner.kernel, 'start')
  const inspectConnection = f.services.connections.inspect.bind(f.services.connections)
  vi.spyOn(f.services.connections, 'inspect').mockImplementation(async input => { const value = await inspectConnection(input); return { ...value, connection: value.connection ? { ...value.connection,
    receiver: { ref: 'overview-original-receiver', state: 'ready' }, observation: { ...value.connection.observation, authentication: { state: 'ready' }, transport: { state: 'ready' }, intake: { state: 'ready' } } } : null } })
  const hosted = await core.connectHostedAgentMux({ rpc: f.rpc, waitForReady: false, forwardRpc: (method, input, context = {}, expected) => f.rpc.call(method, input, { ...(context.signal ? { signal: context.signal } : {}), ...(expected ?? context.runtimeFence ? { runtimeFence: expected ?? context.runtimeFence } : {}) }) }); closes.push(() => hosted.dispose())
  vi.spyOn(hosted, 'connect').mockRejectedValue(Error('Controlled startup observation'))
  const controller = new RuntimeController(f.store, async () => hosted); closes.push(() => controller.dispose()); controller.commit(await controller.prepare(composerConfig))
  const handlers = new Map<string, (...args: any[]) => Promise<unknown>>(), trusted = vi.fn(), calls: Array<{ method: string; input: any; target: any }> = []
  registerConnectorIpc({ handleWithEvent: (method, handler) => handlers.set(method, handler),  runtime: controller, metadata: { publish() {}, observation() {} } })
  let weakPolicy = false
  vi.spyOn(api.connections, 'call').mockImplementation(async (method, input, target) => { calls.push({ method, input: structuredClone(input), target: structuredClone(target) }); const result: any = unwrapSessionInputOperationResult(structuredClone(await handlers.get('connections:call')!({}, method, input, target))); if (weakPolicy && method === 'connection.diagnose') result.service = { value: { enabled: false, revision: 1 }, retained: true, issue: 'read-unavailable' }; return result })
  vi.spyOn(api.config, 'get').mockResolvedValue(composerConfig)
  const session = composerSession(f.binding.agentSessionId, 'claude')
  useAppStore.setState({ sessions: [session], connectorRoomIntents: {}, connectorRoomDrafts: {}, agentComposerDrafts: { [session.id]: 'Keep this original draft' } })
  const unchanged = () => { expect(starts).not.toHaveBeenCalled(); expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled(); expect(useAppStore.getState().agentComposerDrafts[session.id]).toBe('Keep this original draft'); expect(calls.every(row => JSON.stringify(row.target) === JSON.stringify(host))).toBe(true);  }
  const report = () => readGroupDiagnosis((method, input) => api.connections.call(method, input, host), groupTarget(f.binding))
  return { ...f, session, calls, unchanged, report, weakPolicy: () => { weakPolicy = true }, mount: () => dom.render(<SettingsNavigation.Provider value={{open:()=>{},openToolkit:()=>{},openHost:()=>{},openChannel:()=>{},channelPresentation:settingsCatalog.channelPresentation,channelEntries:settingsCatalog.channelEntries,openMoteLark:()=>{},chooseAgent:()=>{}}}><AgentConnectorDialog mode="details" original={{ name: 'Original Agent', session, target: { executionHostId: f.binding.executionHostId, agentSessionId: f.binding.agentSessionId }, hostingTarget: host, connectionId: f.binding.connectionId, bindingId: f.binding.bindingId }} onClose={() => {}} returnFocus={() => null} /></SettingsNavigation.Provider>) }
}

it('keeps receiving online and actually wakes original sync through the mounted dialog, IPC, Main, Hosted and Host', async () => {
  const f = await consumer(), changes = f.port.changes.bind(f.port)
  let fault = true
  vi.spyOn(f.port, 'changes').mockImplementation((...args) => fault ? Promise.reject(new core.AgentMuxError('Controlled source contention', 'AGENT_SESSION_HISTORY_BUSY')) : changes(...args))
  f.services.publication!.refresh()
  await wait(async () => expect((await f.report()).outgoing.value?.sourceObservation?.code).toBe('AGENT_SESSION_HISTORY_BUSY'))
  const recover = vi.spyOn(f.services.publication!, 'recoverSource')
  f.weakPolicy()
  await f.mount()
  await wait(() => expect(document.querySelector('[data-connection-panel="overview"] h3')?.textContent).toBe('Receiving online'))
  const overview = document.querySelector<HTMLElement>('[data-connection-panel="overview"]')!
  expect(document.querySelector('.agent-connector-platform-title img')).not.toBeNull()
  expect(overview.textContent).not.toContain('Earlier delivery'); expect(overview.textContent).not.toContain('content gap')
  expect(overview.querySelectorAll('.primary-button')).toHaveLength(1)
  const diagnostic = document.querySelector<HTMLElement>('[data-connection-panel="diagnostics"]')!
  expect(diagnostic.hidden).toBe(true)
  fault = false
  await click('Try sync now')
  await wait(() => expect(recover).toHaveBeenCalledOnce())
  expect(recover.mock.calls[0]![0]).toEqual({ connectionId: f.binding.connectionId, bindingId: f.binding.bindingId, bindingRevision: f.binding.revision })
  expect(f.calls.filter(row => row.method === 'connection.delivery.source.recover')).toHaveLength(1)
  await wait(async () => expect((await f.report()).outgoing.value?.sourceObservation?.state).toBe('ready'))
  await click('Diagnostics'); expect(diagnostic.hidden).toBe(false)
  await click('Members'); await click('Overview')
  expect(document.querySelector('[data-connection-panel="diagnostics"]')).toBe(diagnostic)
  expect(overview.hidden).toBe(false)
  f.unchanged(); facts({ calls: f.calls, realSourceRecover: true, sameOriginalScope: recover.mock.calls[0]![0], sameDiagnosticPanel: true, noAgentLifecycleWrites: true })
})

it('preserves current policy and original scheduled progress across typed counterexamples', async () => {
  const f = await consumer(), original = await f.report(), connection = original.connection.value!
  const source = { ...original, outgoing: { ...original.outgoing, value: { ...original.outgoing.value!, sourceObservation: { state: 'unavailable' as const, code: 'AGENT_SESSION_HISTORY_BUSY', codeRecorded: true, checkpointKey: null } } } }
  expect(connectorConnectionPresentation(source).title).toBe('Receiving online')
  const admitted = { ...source, connection: { ...source.connection, value: { ...connection, intake: { state: 'unknown' as const, reason: 'check-failed' as const } } },
    incoming: { ...source.incoming, value: { ...source.incoming.value!, rows: [{ ingressId: 'current-accepted', sourceConnectionId: f.binding.connectionId, kind: 'message' as const, state: 'claimed' as const, code: null, codeRecorded: false, bindingId: f.binding.bindingId, bindingRevision: f.binding.revision, targetConnectionId: f.binding.connectionId, scope: 'current-binding' as const, inputOperationId: 'accepted-original-input', recording: { state: 'recorded' as const }, coreStatus: 'admitted' as const, coreObservation: 'observed' as const, nativeAdoption: null, waiting: null }] } } }
  expect(connectorConnectionPresentation(admitted).title).toBe('Receiving online')
  expect(connectorConnectionPresentation(admitted).waiting).toBeNull()
  expect(connectorConnectionPresentation(admitted).attention).toBe('check')
  for (const [receiver, transport, title] of [
    [{ ref: 'original', state: 'ended' as const }, { state: 'unavailable' as const }, 'Receiving stopped'],
    [{ ref: 'original', state: 'ended' as const, nextAttemptAt: 1 }, { state: 'unavailable' as const }, 'Reconnecting'],
    [{ ref: 'original', state: 'recovering' as const }, { state: 'unknown' as const }, 'Reconnecting'],
    [{ ref: 'original', state: 'ready' as const }, { state: 'unknown' as const }, 'Needs checking']
  ] as const) expect(connectorConnectionPresentation({ ...source, connection: { value: { ...connection, receiver, transport }, issue: null } }).title).toBe(title)
  const retained = { ...source, service: { value: { enabled: false, revision: 1 }, issue: 'read-unavailable' as const, retained: true as const } }
  expect(connectorConnectionPresentation(retained).hint).not.toBe('Automatic sync is off')
  expect(connectorConnectionPresentation(retained).hint).not.toContain('will retry')
  expect(connectorConnectionPresentation(retained).primary).toBe('source')
  expect(connectorConnectionPresentation(retained).policyState).toBeNull()
  const paused = { ...source, binding: { value: { ...source.binding.value!, state: 'paused' as const }, issue: null } }
  expect(connectorConnectionPresentation(paused).actionLabel).toBe('Review group sync')
  expect(connectorConnectionPresentation(paused).policyState).toBe('paused')
  expect(connectorConnectionPresentation({ ...source, service: { value: { enabled: false, revision: 2 }, issue: null } }).policyState).toBe('off')
  f.unchanged(); facts({ policyAndScheduleKept: true })
})

it('lets the new binding revision wake while an earlier RPC reply is held and ignores the late old reply', async () => {
  const f = await consumer()
  const busy = (report: Awaited<ReturnType<typeof f.report>>) => ({ ...report, outgoing: { ...report.outgoing, value: { ...report.outgoing.value!, sourceObservation: { state: 'unavailable' as const, code: 'AGENT_SESSION_HISTORY_BUSY' as const, codeRecorded: true, checkpointKey: null } } } })
  const originalReport = busy(await f.report())
  const paused = await f.services.connections.bindings!.pause({ operationId: 'pause-ui-scope', bindingId: f.binding.bindingId, expectedRevision: f.binding.revision }, context)
  expect(paused.state).toBe('applied'); if (paused.state !== 'applied') throw Error('Original pause required')
  const second = await f.services.connections.bindings!.resume({ operationId: 'resume-ui-scope', bindingId: f.binding.bindingId, expectedRevision: paused.binding.revision }, context)
  expect(second.state).toBe('applied'); if (second.state !== 'applied') throw Error('Resumed original scope required')
  const otherReport = busy(await readGroupDiagnosis((method, input) => api.connections.call(method, input, host), groupTarget(second.binding)))
  let release = () => {}; const held = new Promise<void>(resolve => { release = resolve }); closes.push(() => release())
  const implementation = vi.mocked(api.connections.call).getMockImplementation()!
  vi.mocked(api.connections.call).mockImplementation(async (method, input, owner) => { const result = await implementation(method, input, owner); if (method === 'connection.delivery.source.recover' && (input as any).bindingRevision === f.binding.revision) await held; return result })
  await dom.render(<ConnectorConnectionOverview compact binding={f.binding} report={originalReport} hostingTarget={host} onCheck={() => {}} />)
  await click('Try sync now'); await wait(() => expect(f.calls.filter(row => row.method === 'connection.delivery.source.recover')).toHaveLength(1))
  await dom.render(<ConnectorConnectionOverview compact binding={second.binding} report={otherReport} hostingTarget={host} onCheck={() => {}} />)
  await click('Try sync now'); await wait(() => expect(f.calls.filter(row => row.method === 'connection.delivery.source.recover')).toHaveLength(2))
  await wait(() => expect(dom.container.textContent).toMatch(/Sync recovery requested|Joined the current sync work/))
  const before = dom.container.textContent; release(); await act(async () => { await held; await new Promise(resolve => setTimeout(resolve, 50)) })
  expect(dom.container.textContent).toBe(before)
  expect(f.calls.filter(row => row.method === 'connection.delivery.source.recover').map(row => row.input.bindingRevision)).toEqual([f.binding.revision, second.binding.revision])
  f.unchanged(); facts({ revisedOriginalScopeJoined: true, lateOldReplyIgnored: true, calls: f.calls })
})
