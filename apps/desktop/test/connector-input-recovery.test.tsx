// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
import { AgentMuxError } from '@agentmux/core'
import { ingressFixture } from '../../../packages/connectors/test/fixtures/ingress'
import { context } from '../../../packages/connectors/test/fixtures/room-binding'
import { AgentMuxHostedRuntimeService } from '../../../packages/core/src/hosted-runtime-service'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client'
import { connectHostedAgentMux } from '../../../packages/core/src/hosted-client'
import { hostedTestOwner } from '../../../packages/core/test/helpers/hosted-runtime-port'
import { createConnectionExternalInputAuthority } from '../../host/src/external-input-authority'
import { RuntimeController } from '../src/main/runtime-controller'
import { registerConnectorIpc } from '../src/main/connector-ipc'
import { sessionInputOperationResult, unwrapSessionInputOperationResult } from '../src/shared/session-input-result'
import { ConnectorDeliveryDetails } from '../src/renderer/src/components/ConnectorDeliveryDetails'
import { api } from '../src/renderer/src/lib/api'
import { connectorGroupSummary } from '../src/renderer/src/lib/connector-group-status'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM(), closes: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { await dom.render(null); for (const close of closes.splice(0).reverse()) await close(); vi.unstubAllEnvs() })
const wait = async (assertion: () => void | Promise<void>) => vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) }); await assertion() }, { timeout: 8000 })
const settled = () => wait(() => expect(dom.container.querySelector<HTMLButtonElement>('[data-input-wait-action="check"]')?.disabled).toBe(false))
async function click(label: string) {
  const button = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === label)
  expect(button, label).toBeTruthy(); await act(async () => button!.click())
}

/** Mounted surface → connector IPC/public RPC and Main controller → Hosted SDK → original Core.
 * Runtime/Provider transport and the preload invocation seam are controlled; no live platform claim. */
async function originalWait(automatic = false) {
  const f = await ingressFixture(!automatic, undefined, undefined, { publication: 'future-shared-conversation' }); closes.push(() => f.close())
  let allowInput = () => {}
  if (!automatic) {
    const provider = (f.client as unknown as { providers: { get(id: string): { planPromptInput(text: string): unknown } } }).providers.get('claude')
    const plan = vi.spyOn(provider, 'planPromptInput').mockImplementation(() => { throw new AgentMuxError('Original native input unavailable', 'AGENT_NATIVE_INPUT_UNAVAILABLE') })
    allowInput = () => { plan.mockImplementation(text => ({ kind: 'single-phase', data: text + '\r' })) }
  }
  const received = await f.receive(), original = await f.ingress.dispatch(received.ingress.ingressId)
  await wait(async () => expect((await f.ingress.inspect({ ingressId: received.ingress.ingressId })).inputReceipt?.control.waiting?.wake).toBe(automatic ? 'runtime-restored' : 'explicit-rejoin'))
  const receipt = (await f.ingress.inspect({ ingressId: received.ingress.ingressId })).inputReceipt!
  const coreRejoin = vi.spyOn(f.client, 'rejoinAgentInputWaiting')
  const authority = createConnectionExternalInputAuthority({ ingress: async () => f.ingress, executionHostId: 'local' })
  const service = new AgentMuxHostedRuntimeService(f.client, f.store.path, () => hostedTestOwner(f.client), undefined, authority); closes.push(() => service.dispose())
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'input-recovery.sock'), connections: f.connections, coreClients: f.coreClients, hostedRuntime: () => service })
  await server.start(); closes.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); closes.push(() => rpc.dispose())
  const hosted = await connectHostedAgentMux({ rpc, waitForReady: false }); closes.push(() => hosted.dispose())
  vi.spyOn(hosted, 'connect').mockRejectedValue(new Error('Controlled startup transport observation'))
  const controller = new RuntimeController(f.store, async () => hosted); closes.push(() => controller.dispose())
  controller.commit(await controller.prepare(composerConfig))
  const inspect = vi.spyOn(api.sessions, 'inspectInput').mockImplementation(async (target, key) => unwrapSessionInputOperationResult(structuredClone(await sessionInputOperationResult(() => controller.inspectInput(target, key)))))
  const rejoin = vi.spyOn(api.sessions, 'rejoinInputWaiting').mockImplementation(async (target, ref) => unwrapSessionInputOperationResult(structuredClone(await sessionInputOperationResult(() => controller.rejoinInputWaiting(target, ref)))))
  const stop = vi.spyOn(api.sessions, 'stopInputWaiting').mockImplementation(async (target, ref, id) => unwrapSessionInputOperationResult(structuredClone(await sessionInputOperationResult(() => controller.stopInputWaiting(target, ref, id)))))
  const handlers = new Map<string, (...args: any[]) => Promise<unknown>>(), hostingTarget = { hostId: 'local', runtimeId: 'original-runtime' }
  registerConnectorIpc({ handleWithEvent: (channel, handler) => { handlers.set(channel, handler) }, assertTrusted: vi.fn(), metadata: { publish() {}, observation() {} }, runtime: {
    connectionHostingTarget: async () => hostingTarget, callConnectionHost: async (target, method, params) => {
      expect(target).toEqual(hostingTarget); return rpc.call(method, params)
    }, watchConnectionMetadata: async (_target, handlers) => rpc.subscribe('connection.metadata.watch', {}, handlers)
  } })
  const call = vi.spyOn(api.connections, 'call').mockImplementation(async (method, params, target) => unwrapSessionInputOperationResult(structuredClone(await handlers.get('connections:call')!({}, method, params, target)) as any))
  const binding = (await f.bindings.inspect({ bindingId: f.input.bindingId })).binding!
  await dom.render(<ConnectorDeliveryDetails binding={binding} hostingTarget={hostingTarget} />)
  await wait(() => expect(dom.container.textContent).toContain(automatic ? 'Waiting for Agent' : 'Input recovery needed'))
  const diagnosis = call.mock.results.find((_result, index) => call.mock.calls[index]?.[0] === 'connection.diagnose')
  expect(diagnosis).toBeTruthy()
  const report = await diagnosis!.value as any
  const summary = connectorGroupSummary({ ...report.groups.value.items[0], service: report.service })
  expect(summary.incoming.tone).toBe(automatic ? 'neutral' : 'warning')
  return { ...f, receipt, original, binding, hostingTarget, inspect, rejoin, stop, call, controller, rpc, hosted, coreRejoin, allowInput }
}

it('opens the original saved connector input and explicitly rejoins through Main and Hosted Core with its immutable inspected ref', async () => {
  const f = await originalWait(), submit = vi.spyOn(f.client, 'submitAgentMessage')
  f.allowInput()
  expect(f.rejoin).not.toHaveBeenCalled(); expect(f.inspect).not.toHaveBeenCalled()
  await click('Open original input')
  await wait(() => expect(dom.container.querySelector('[data-input-wait-action="rejoin"]')).not.toBeNull())
  expect(f.call.mock.calls.some(([method]) => method === 'connection.ingress.inspect')).toBe(true)
  await dom.click('[data-input-wait-action="rejoin"]')
  await wait(() => expect(dom.container.querySelector('[data-input-rejoin-outcome]')).not.toBeNull())
  await wait(async () => expect((await f.client.inspectAgentInput({ key: f.receipt.key }))?.status).toBe('terminal-confirmed'))
  expect(f.rejoin).toHaveBeenCalledExactlyOnceWith({ kind: 'agent', hostId: 'local', agentSessionId: f.receipt.key.agentSessionId, run: f.receipt.key.expectedRun }, f.receipt.ref)
  const after = await f.client.inspectAgentInput({ key: f.receipt.key })
  expect(after?.key).toEqual(f.receipt.key); expect(after?.ref).toEqual(f.receipt.ref)
  expect(f.coreRejoin).toHaveBeenCalledOnce(); expect(f.coreRejoin.mock.calls[0]![0].ref).toEqual(f.receipt.ref)
  expect(f.coreRejoin.mock.calls[0]![1]?.externalAuthor?.identity).toEqual(f.original.ingress!.input!.author)
  expect(after?.admission).not.toBeNull(); expect(dom.container.textContent).not.toContain('Accepted by Agent')
  expect(submit).not.toHaveBeenCalled(); expect(f.inner.kernel.input).toHaveBeenCalledTimes(1)
  // A read-only public inspection sees the same original journal, not a second input.
  expect(await f.rpc.call('agent.input.inspect', { key: f.receipt.key })).toMatchObject({ input: { key: f.receipt.key, ref: after!.ref } })
  expect(await f.rpc.call('agent.input.rejoin', { ref: f.receipt.ref })).toMatchObject({ key: f.receipt.key, ref: f.receipt.ref })
  expect(f.inner.kernel.input).toHaveBeenCalledTimes(1)
}, 25_000)

it('keeps explicit recovery available when an acknowledged rejoin still waits on the same original input', async () => {
  const f = await originalWait()
  await click('Open original input')
  await wait(() => expect(dom.container.querySelector('[data-input-wait-action="rejoin"]')).not.toBeNull())
  await dom.click('[data-input-wait-action="rejoin"]')
  await settled()
  await wait(async () => expect((await f.client.inspectAgentInput({ key: f.receipt.key }))?.control.waiting?.wake).toBe('explicit-rejoin'))
  await dom.click('[data-input-wait-action="check"]')
  await settled()
  expect(dom.container.querySelector<HTMLButtonElement>('[data-input-wait-action="rejoin"]')?.disabled).toBe(false)
  f.allowInput()
  await dom.click('[data-input-wait-action="rejoin"]')
  await wait(async () => expect((await f.client.inspectAgentInput({ key: f.receipt.key }))?.status).toBe('terminal-confirmed'))
  expect(f.rejoin).toHaveBeenCalledTimes(2)
  for (const [, ref] of f.rejoin.mock.calls) expect(ref).toEqual(f.receipt.ref)
  expect(f.inner.kernel.input).toHaveBeenCalledTimes(1)
}, 25_000)

it('keeps automatic waiting quiet and preserves original check and stop without offering explicit rejoin', async () => {
  const f = await originalWait(true)
  await click('Open original input')
  await wait(() => expect(dom.container.querySelector('[data-input-wait-action="stop"]')).not.toBeNull())
  expect(dom.container.querySelector('[data-input-wait-action="rejoin"]')).toBeNull()
  await dom.click('[data-input-wait-action="check"]')
  await settled()
  expect(f.inspect.mock.calls[0]![1]).toEqual(f.receipt.key)
  await dom.click('[data-input-wait-action="stop"]')
  await wait(() => expect(dom.container.querySelector('[data-input-stop-outcome]')).not.toBeNull())
  expect((await f.client.inspectAgentInput({ key: f.receipt.key }))?.status).toBe('stopped')
  expect(f.rejoin).not.toHaveBeenCalled(); expect(f.inner.kernel.input).not.toHaveBeenCalled()
}, 25_000)

it('rechecks the original external grant and preserves the saved input after a refused rejoin', async () => {
  const f = await originalWait()
  await click('Open original input')
  await wait(() => expect(dom.container.querySelector('[data-input-wait-action="rejoin"]')).not.toBeNull())
  await f.bindings.grant({ ...f.grant, operationId: 'revoke-original-input', expectedRevision: 1, state: 'revoked' }, context)
  await dom.click('[data-input-wait-action="rejoin"]')
  await wait(() => expect(dom.container.querySelector('[data-input-wait-error]')?.textContent).toContain('接回结果未确认'))
  expect(dom.container.querySelector<HTMLButtonElement>('[data-input-wait-action="rejoin"]')?.disabled).toBe(true)
  expect((await f.client.inspectAgentInput({ key: f.receipt.key }))?.ref).toEqual(f.receipt.ref)
  await dom.click('[data-input-wait-action="check"]')
  await settled()
  expect(f.inspect).toHaveBeenCalledTimes(1)
  expect(dom.container.querySelector<HTMLButtonElement>('[data-input-wait-action="rejoin"]')?.disabled).toBe(false)
  expect(f.rejoin).toHaveBeenCalledTimes(1); expect(f.inner.kernel.input).not.toHaveBeenCalled()
}, 25_000)

it('reconciles a lost rejoin ACK by inspecting the original input instead of repeating the action or changing its target', async () => {
  const f = await originalWait(), perform = f.controller.rejoinInputWaiting.bind(f.controller)
  f.rejoin.mockImplementationOnce(async (...args) => { await perform(...args); throw Error('Original rejoin response lost') })
  await click('Open original input')
  await wait(() => expect(dom.container.querySelector('[data-input-wait-action="rejoin"]')).not.toBeNull())
  await dom.click('[data-input-wait-action="rejoin"]')
  await wait(() => expect(dom.container.querySelector('[data-input-wait-error]')?.textContent).toContain('接回结果未确认'))
  await dom.click('[data-input-wait-action="rejoin"]')
  expect(f.rejoin).toHaveBeenCalledTimes(1)
  await dom.click('[data-input-wait-action="check"]')
  await settled()
  expect(dom.container.querySelector('[data-input-wait-observation]')?.textContent).toContain('原输入仍在等待')
  expect(f.rejoin).toHaveBeenCalledTimes(1); expect(f.coreRejoin).toHaveBeenCalledTimes(1)
  expect(f.inspect.mock.calls[0]![1]).toEqual(f.receipt.key)
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
}, 25_000)

it('keeps a retained original receipt readable when its current inspection fails and rejects a foreign receipt', async () => {
  const f = await originalWait()
  await click('Open original input')
  await wait(() => expect(dom.container.querySelector('[data-input-wait-action="rejoin"]')).not.toBeNull())
  f.inspect.mockRejectedValueOnce(Error('Original owner unavailable'))
  await dom.click('[data-input-wait-action="check"]')
  expect(dom.container.querySelector('[data-input-wait-error]')?.textContent).toContain('本次检查未确认')
  const originalCall = f.call.getMockImplementation()!
  f.call.mockImplementation(async (method, params, target) => {
    const result = await originalCall(method, params, target)
    if (method !== 'connection.ingress.inspect') return result
    const value = structuredClone(result) as any
    value.inputReceipt.key.expectedRun = { runId: 'foreign-run' }
    return value
  })
  await click('Close original input'); await click('Open original input')
  await wait(() => expect(dom.container.textContent).toContain('Original input receipt could not be confirmed'))
  expect(dom.container.querySelector('[data-input-wait-action="rejoin"]')).toBeNull()
  expect(f.rejoin).not.toHaveBeenCalled()
}, 25_000)

it('keeps the original target after a Session resumes onto a different Run and never substitutes the current Run', async () => {
  const f = await originalWait()
  await click('Open original input')
  await wait(() => expect(dom.container.querySelector('[data-input-wait-action="rejoin"]')).not.toBeNull())
  const saved = await f.store.readMetadata(f.receipt.key.agentSessionId)
  if (!saved) throw Error('Original fixture Session required')
  await f.store.compareAndSwap(saved, { ...saved, run: { runId: 'another-current-run' } })
  await f.inner.registry.load('local')
  await dom.click('[data-input-wait-action="rejoin"]')
  await settled()
  expect(f.rejoin.mock.calls[0]![0].run).toEqual(f.receipt.key.expectedRun)
  expect(f.rejoin.mock.calls[0]![1]).toEqual(f.receipt.ref)
  const observed = await f.client.inspectAgentInput({ key: f.receipt.key })
  expect(observed?.key).toEqual(f.receipt.key); expect(observed?.admission).toBeNull()
  expect(dom.container.textContent).not.toContain('Accepted by Agent')
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
}, 25_000)
