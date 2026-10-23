// @vitest-environment happy-dom
import { act } from 'react'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer, connectAgentMuxRpc } from '@agentmux/core'
import type { ConnectionEnrollmentBeginInput, ConnectionRecord } from '@agentmux/core/connections'
import { createConnectionServices, type ConnectionAdapter } from '../../../packages/connectors/src/index.js'
import { registerConnectorIpc } from '../src/main/connector-ipc'
import { unwrapSessionInputOperationResult } from '../src/shared/session-input-result'
import type { ConnectionHostingTarget } from '../src/shared/contracts'
import { BotEnrollmentPane, useBotEnrollment } from '../src/renderer/src/components/settings/BotEnrollmentPane'
import { ConnectionManagementSetup } from '../src/renderer/src/components/settings/ConnectionManagementSetup'
import { useConnectionManagementSetup } from '../src/renderer/src/components/settings/useConnectionManagementSetup'
import { api } from '../src/renderer/src/lib/api'
import { botTaskSelectionKey, managementTaskScope } from '../src/renderer/src/lib/bot-task-selection'
import { setBotTaskSelection, useAppStore } from '../src/renderer/src/store'
import { enrollmentAvatar } from '../../../packages/connectors/test/fixtures/connection-enrollment'
import { composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM(), cleanup: Array<() => void | Promise<void>> = [], facts: unknown[] = []
afterEach(async () => { await dom.render(null); for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
afterAll(async () => { if (process.env.GENERIC_SETUP_FACTS) await writeFile(process.env.GENERIC_SETUP_FACTS, JSON.stringify({ scope: 'Mounted generic Renderer hooks/panes, original AppStore locators, trusted IPC, public Core RPC and two independent original ConnectionServices SQLite owners. Native protocol I/O and hosting transport selection are controlled; no RuntimeController, live platform or installed GUI.', facts }, null, 2) + '\n') })
const wait = async (check: () => void) => vi.waitFor(async () => { await act(async () => {}); check() })
const preset = { name: 'Original bot', avatar: { pngDataUrl: enrollmentAvatar } }
async function owner(name: string) {
  const directory = await mkdtemp(join(tmpdir(), 'generic-hosting-')), effects: string[] = []
  const challenge = () => ({ qrPayload: name + '-original-private-qr', expiresAt: null, nextPollAt: Date.now() + 3600000 })
  const adapter: ConnectionAdapter = { adapterId: 'signed', test: async () => ({ authentication: { state: 'unknown' }, transport: { state: 'unknown' }, intake: { state: 'unknown' }, delivery: { state: 'unknown' } }), enrollment: {
    domains: [{ domain: 'signed.example', label: 'Signed platform' }],
    begin: async input => { effects.push('enrollment-begin'); return { kind: 'authentication', stage: 'waiting', challenge: challenge(), account: null, privateState: JSON.stringify({ operationId: input.operationId, owner: name }) } },
    advance: async input => { expect(JSON.parse(input.privateState).owner).toBe(name); effects.push('enrollment-advance'); return { kind: 'authentication', stage: 'account', challenge: null, account: { userId: name + '-user', tenantId: name + '-tenant' }, privateState: input.privateState } },
    upload: async input => ({ kind: 'uploaded', privateState: input.privateState }), create: async input => { effects.push('enrollment-create'); return { kind: 'created', application: { domain: 'signed.example', appId: 'new-app' }, privateState: input.privateState } }, credential: async input => ({ kind: 'credential', secret: 'synthetic-' + name, privateState: input.privateState })
  }, setup: { domains: ['signed.example'], begin: async input => { effects.push('management-begin'); return { kind: 'challenge', challenge: challenge(), privateState: JSON.stringify({ operationId: input.operationId, owner: name }) } }, advance: async input => { expect(JSON.parse(input.privateState).owner).toBe(name); effects.push('management-advance'); return { kind: 'progress', stage: 'account', challenge: null, account: { userId: name + '-user', tenantId: name + '-tenant' }, privateState: input.privateState } }, enrollmentContinuation: { domains: ['signed.example'], resume: async input => ({ kind: 'progress', stage: 'confirmed', challenge: null, account: input.account, privateState: input.privateState }) } } }
  const services = await createConnectionServices({ directory, adapters: [adapter] })
  const server = new AgentMuxControlServer({ socketPath: join(directory, 'rpc.sock'), connections: services.connections, coreClients: () => [] }); await server.start()
  const sdk = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  const secret = await services.secrets.store({ operationId: 'seed-secret', secret: 'synthetic-' + name })
  const configured = await sdk.call('connection.configure', { operationId: 'seed-configure', expectedRevision: null, connection: { connectionId: 'same-bot', adapterId: 'signed', application: { domain: 'signed.example', appId: 'same-app' }, label: 'Original bot', enabled: true, credentialRef: secret.credentialRef } })
  const target = { hostId: name, runtimeId: name + '-runtime' }
  return { services, sdk, effects, target, record: configured.connection, close: async () => { await sdk.dispose(); await server.stop(); await services.close(); await rm(directory, { recursive: true, force: true }) } }
}
async function fixture() {
  const config = useAppStore.getState().config!
  vi.spyOn(api.config, 'get').mockResolvedValue(config)
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [], timelines: {}, recoveryCandidates: [] })
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue(undefined)
  window.localStorage.clear(); await useAppStore.persist.rehydrate()
  const stop = await useAppStore.getState().initialize(); stop()
  const a = await owner('owner-a'), b = await owner('owner-b'); cleanup.push(a.close, b.close)
  useAppStore.setState({ botTaskSelections: {} })
  const calls: Array<{ target: ConnectionHostingTarget; method: string; input: any; retained: unknown }> = []
  let heldMethod = '', heldId = '', release!: () => void, pending = Promise.resolve(), started = false
  const handlers = new Map<string, (...args: any[]) => Promise<any>>(), sender = {}
  const runtime = { connectionHostingTarget: async () => b.target, callConnectionHost: async (target: ConnectionHostingTarget, method: any, input: any) => {
    const selected = target.hostId === a.target.hostId && target.runtimeId === a.target.runtimeId ? a : target.hostId === b.target.hostId && target.runtimeId === b.target.runtimeId ? b : null
    if (!selected) throw Error('This exact controlled original owner is unavailable')
    calls.push({ target: structuredClone(target), method, input: structuredClone(input), retained: structuredClone(useAppStore.getState().botTaskSelections) })
    const result = await selected.sdk.call(method, input)
    if (method === heldMethod && input.operationId === heldId && selected === a) { started = true; await pending }
    return result
  }, watchConnectionMetadata: async () => { throw Error('This fixture does not open metadata readers') } }
  const ipc = registerConnectorIpc({ runtime, handleWithEvent: (name, handler) => handlers.set(name, handler), assertTrusted: (_channel, event) => expect(event.sender).toBe(sender), metadata: { publish() {}, observation() {} } }); cleanup.push(ipc.dispose)
  vi.spyOn(api.connections, 'call').mockImplementation(async (method, input, target) => unwrapSessionInputOperationResult(await handlers.get('connections:call')!({ sender }, method, input, target)))
  return { a, b, calls, hold(method: string, id: string) { heldMethod = method; heldId = id; pending = new Promise(resolve => { release = resolve }) }, started: () => started, release() { heldMethod = ''; release?.() } }
}
let enrollment: ReturnType<typeof useBotEnrollment>, management: ReturnType<typeof useConnectionManagementSetup>
function Enrollment({ target }: { target: ConnectionHostingTarget | null }) { enrollment = useBotEnrollment(true, target); return <BotEnrollmentPane enrollment={enrollment} onExisting={() => {}} onSaved={() => {}} /> }
function Management({ target, record }: { target: ConnectionHostingTarget | null; record: ConnectionRecord }) { management = useConnectionManagementSetup(record, true, true, target); return <ConnectionManagementSetup record={record} model={management} platformLabel="Signed platform" onBack={() => {}} onLibrary={() => {}} onConsole={async () => {}} /> }
const input = (operationId: string): ConnectionEnrollmentBeginInput => ({ operationId, connectionId: operationId + '-bot', adapterId: 'signed', domain: 'signed.example', label: 'Original bot', preset })
async function trace() { const details = dom.container.querySelector<HTMLDetailsElement>('[data-request-trace]')!; await act(async () => { details.open = true; details.dispatchEvent(new Event('toggle')) }); await wait(() => expect(dom.container.querySelectorAll('[data-request-trace] tbody tr').length).toBeGreaterThan(0)) }

it('retains a typed new enrollment locator before I/O and keeps parent and trace on that original owner', async () => {
  const f = await fixture(); await dom.render(<Enrollment target={f.a.target} />)
  await wait(() => expect(enrollment.capabilities).toHaveLength(1)); await act(async () => enrollment.begin(enrollment.capabilities[0]!, 'Original bot', preset))
  await wait(() => expect(enrollment.view?.challenge).toBeTruthy())
  const id = enrollment.selectedId!, a = await f.a.sdk.call('connection.enrollment.inspect', { operationId: id }), b = await f.b.sdk.call('connection.enrollment.inspect', { operationId: id })
  facts.push({ case: 'new-enrollment-owner', id, a: a.operation?.operationId ?? null, b: b.operation?.operationId ?? null, routes: f.calls, effectsA: f.a.effects, effectsB: f.b.effects })
  expect(a.operation?.operationId).toBe(id); expect(b.operation).toBeNull(); expect(enrollment.view?.challenge?.qrPayload).toBe('owner-a-original-private-qr')
  const begin = f.calls.find(call => call.method === 'connection.enrollment.begin')!; expect(begin.retained).toMatchObject({ enrollment: { operationId: id, hostingTarget: f.a.target } })
  expect(begin.target).toEqual(f.a.target); await trace()
  expect(f.calls.filter(call => call.input.operationId === id).every(call => call.target.runtimeId === f.a.target.runtimeId)).toBe(true)
  vi.spyOn(Date, 'now').mockReturnValue(enrollment.view!.challenge!.nextPollAt + 1)
  await act(async () => enrollment.inspect())
  for (const kind of ['continue-authentication', 'confirm-account', 'create'] as const) {
    await wait(() => expect(enrollment.view?.actions.some(action => action.kind === kind)).toBe(true))
    await act(async () => enrollment.advance(enrollment.view!.actions.find(action => action.kind === kind)!))
  }
  await wait(() => expect(enrollment.operation?.configured).toBeTruthy())
  const child = enrollment.operation?.initialSetup?.operationId
  facts.push({ case: 'original-enrollment-child', id, child, routes: f.calls })
  expect(child).toBeTruthy()
  const childTrace = dom.container.querySelectorAll<HTMLDetailsElement>('[data-request-trace]')[1]!
  await act(async () => { childTrace.open = true; childTrace.dispatchEvent(new Event('toggle')) })
  await wait(() => expect(f.calls.some(call => call.method === 'connection.setup.inspect' && call.input.operationId === child && call.input.requestTrace)).toBe(true))
  expect(f.calls.filter(call => call.input.operationId === child).every(call => call.target.runtimeId === f.a.target.runtimeId)).toBe(true)
  const parent = enrollment.operation!, saved = parent.configured!.connection
  await dom.render(<Management target={f.a.target} record={saved} />)
  await wait(() => expect(management.catalog?.value?.support?.capabilities).toContain('enrollment-continuation'))
  await act(async () => management.handoff({ kind: 'enrollment', operationId: id, expectedRevision: parent.revision }))
  await wait(() => expect(management.view?.operation?.source?.kind).toBe('enrollment'))
  const continuation = management.selectedId!, request = f.calls.find(call => call.method === 'connection.setup.begin' && call.input.operationId === continuation)!
  expect(request.target).toEqual(f.a.target)
  expect(request.retained).toMatchObject({ [botTaskSelectionKey(managementTaskScope(saved))]: { operationId: continuation, hostingTarget: f.a.target } })
  expect((await f.b.sdk.call('connection.setup.inspect', { operationId: continuation })).operation).toBeNull()
  facts.push({ case: 'enrollment-management-handoff', parent: id, continuation, source: management.view?.operation?.source, target: request.target, retained: request.retained })
})

it('restores same-ID enrollment from its retained owner and ignores its late QR after a new owner draft starts', async () => {
  const f = await fixture(), id = 'same-enrollment'; await f.a.sdk.call('connection.enrollment.begin', input(id)); await f.b.sdk.call('connection.enrollment.begin', input(id))
  setBotTaskSelection({ kind: 'enrollment' }, { operationId: id, hostingTarget: f.a.target }); f.hold('connection.enrollment.inspect', id)
  await dom.render(<Enrollment target={f.b.target} />); await wait(() => expect(f.started()).toBe(true))
  await act(async () => enrollment.startAnother()); await wait(() => expect(enrollment.capabilities).toHaveLength(1))
  await act(async () => enrollment.begin(enrollment.capabilities[0]!, 'New owner bot', preset)); const next = enrollment.selectedId!
  await wait(() => expect(enrollment.view?.challenge?.qrPayload).toBe('owner-b-original-private-qr')); f.release(); await act(async () => {})
  expect(enrollment.selectedId).toBe(next); expect(enrollment.view?.challenge?.qrPayload).toBe('owner-b-original-private-qr')
  expect(f.calls.filter(call => call.method === 'connection.enrollment.inspect' && call.input.operationId === id).every(call => call.target.runtimeId === f.a.target.runtimeId)).toBe(true)
  expect((await f.a.sdk.call('connection.enrollment.inspect', { operationId: id })).operation?.operationId).toBe(id)
  facts.push({ case: 'enrollment-original-and-late-owner', id, next, originalReads: f.calls.filter(call => call.input.operationId === id), nextQR: enrollment.view?.challenge?.qrPayload })
})

it('binds new management and a same-ID restored management trace to their original SQLite owner', async () => {
  const f = await fixture(); await dom.render(<Management target={f.a.target} record={f.a.record} />)
  await wait(() => expect(management.supported).toBe(true)); await act(async () => management.start())
  await wait(() => expect(management.view?.challenge).toBeTruthy()); const id = management.selectedId!
  const beforeA = await f.a.sdk.call('connection.setup.inspect', { operationId: id }), beforeB = await f.b.sdk.call('connection.setup.inspect', { operationId: id })
  facts.push({ case: 'management-original-owner', id, original: beforeA.operation?.operationId ?? null, foreign: beforeB.operation?.operationId ?? null, routes: f.calls, effectsA: f.a.effects, effectsB: f.b.effects })
  expect(beforeA.operation?.operationId).toBe(id); expect(beforeB.operation).toBeNull(); expect(management.view?.challenge?.qrPayload).toBe('owner-a-original-private-qr')
  const scope = managementTaskScope(f.a.record), key = botTaskSelectionKey(scope), begin = f.calls.find(call => call.method === 'connection.setup.begin')!
  expect(begin.retained).toMatchObject({ [key]: { operationId: id, hostingTarget: f.a.target } })
  await f.b.sdk.call('connection.setup.begin', { operationId: id, connectionId: 'same-bot', expectedConnectionRevision: 1, goal: { kind: 'agent-conversation', interaction: 'messages' } })
  await dom.render(null); await dom.render(<Management target={f.b.target} record={f.b.record} />)
  await wait(() => expect(management.view?.challenge?.qrPayload).toBe('owner-a-original-private-qr')); await trace()
  expect(f.calls.filter(call => call.input.operationId === id).every(call => call.target.runtimeId === f.a.target.runtimeId)).toBe(true)
})

it('keeps ownerless locators and exposes no check/continue until a separate new request is chosen', async () => {
  const f = await fixture(), id = 'same-old-ownerless'; await f.b.sdk.call('connection.enrollment.begin', input(id))
  setBotTaskSelection({ kind: 'enrollment' }, id); const before = f.calls.length
  await dom.render(<Enrollment target={f.b.target} />)
  await wait(() => expect(enrollment.originalOwnerIssue || enrollment.view?.operation).toBeTruthy())
  facts.push({ observedOperation: enrollment.view?.operation?.operationId ?? null, case: 'ownerless-enrollment', before, after: f.calls.length, routes: f.calls, locator: useAppStore.getState().botTaskSelections.enrollment, text: dom.container.textContent })
  expect(f.calls).toHaveLength(before); expect(enrollment.checking).toBe(false); expect(dom.container.querySelector('[data-enrollment-owner-unconfirmed]')).not.toBeNull(); expect(dom.container.querySelector('[data-enrollment-inspect], [data-enrollment-advance]')).toBeNull(); expect(useAppStore.getState().botTaskSelections.enrollment).toBe(id)
  const scope = managementTaskScope(f.a.record); setBotTaskSelection(scope, id)
  await dom.render(<Management target={f.b.target} record={f.b.record} />)
  expect(f.calls).toHaveLength(before); expect(management.busy).toBe(false); expect(dom.container.querySelector('[data-management-owner-unconfirmed]')).not.toBeNull(); expect(dom.container.querySelector('[data-management-inspect], [data-management-resume]')).toBeNull()
  await act(async () => management.another()); await wait(() => expect(management.supported).toBe(true)); await act(async () => management.start())
  await wait(() => expect(management.view?.challenge?.qrPayload).toBe('owner-b-original-private-qr'))
  expect(f.a.effects).toHaveLength(0); expect(f.b.effects).toContain('management-begin')
  facts.push({ case: 'ownerless-new-management', id: management.selectedId, effectsA: f.a.effects, effectsB: f.b.effects, retained: useAppStore.getState().botTaskSelections })
})


it('retains failed local saves without dispatch and retries both original begin inputs after the original writer recovers', async () => {
  const f = await fixture(); await dom.render(<Enrollment target={f.a.target} />)
  await wait(() => expect(enrollment.capabilities).toHaveLength(1))
  let fault = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => { throw Error('Original local selection writer unavailable') })
  await act(async () => enrollment.begin(enrollment.capabilities[0]!, 'Original unsent bot', preset))
  await wait(() => expect(enrollment.pendingLocalSave || enrollment.view?.operation).toBeTruthy())
  const enrollmentId = enrollment.selectedId!, savedInput = enrollment.submissions.find(input => input.operationId === enrollmentId)
  const unsentEnrollment = await f.a.sdk.call('connection.enrollment.inspect', { operationId: enrollmentId })
  const enrollmentBegins = f.calls.filter(call => call.method === 'connection.enrollment.begin').length
  fault.mockRestore()
  facts.push({ case: 'enrollment-local-save-failed', enrollmentId, originalInput: savedInput, platformOperation: unsentEnrollment.operation?.operationId ?? null, beginRequests: enrollmentBegins, effects: [...f.a.effects] })
  expect(enrollmentBegins).toBe(0); expect(unsentEnrollment.operation).toBeNull(); expect(enrollment.pendingLocalSave).toBe(true)
  const flush = vi.mocked(api.ui.requestStorageFlush).mockRejectedValue(Error('Controlled disk flush observation unavailable'))
  await act(async () => enrollment.retryLocalSave())
  await wait(() => expect(enrollment.view?.operation?.operationId).toBe(enrollmentId))
  expect(enrollment.view?.operation?.label).toBe('Original unsent bot')
  expect(JSON.parse(window.localStorage.getItem('agentmux-workbench-v1')!).state.botTaskSelections.enrollment).toEqual({ operationId: enrollmentId, hostingTarget: f.a.target })
  flush.mockResolvedValue(undefined)
  await dom.render(<Management target={f.a.target} record={f.a.record} />)
  await wait(() => expect(management.supported).toBe(true))
  fault = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => { throw Error('Original local selection writer unavailable') })
  await act(async () => management.start())
  await wait(() => expect(management.reading?.localSaveFailed || management.view?.operation).toBeTruthy())
  const managementId = management.selectedId!, unsentManagement = await f.a.sdk.call('connection.setup.inspect', { operationId: managementId })
  const managementBegins = f.calls.filter(call => call.method === 'connection.setup.begin').length
  fault.mockRestore()
  facts.push({ case: 'management-local-save-failed', managementId, platformOperation: unsentManagement.operation?.operationId ?? null, beginRequests: managementBegins, effects: [...f.a.effects] })
  expect(managementBegins).toBe(0); expect(unsentManagement.operation).toBeNull(); expect(management.reading?.localSaveFailed).toBe(true)
  await act(async () => management.continueOriginal())
  await wait(() => expect(management.view?.operation?.operationId).toBe(managementId))
  expect(f.calls.filter(call => call.method === 'connection.setup.begin').map(call => call.input.operationId)).toEqual([managementId])
  expect((await f.b.sdk.call('connection.setup.inspect', { operationId: managementId })).operation).toBeNull()
  facts.push({ case: 'original-local-save-recovered', enrollmentId, managementId, sameOriginalInputs: true, effectsA: f.a.effects, effectsB: f.b.effects })
})
