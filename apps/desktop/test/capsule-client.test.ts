// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { URL as NodeURL } from 'node:url'
import ts from 'typescript'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer, connectAgentMuxRpc, AgentMuxError, type AgentMuxRpcCallContext } from '@agentmux/core'
import { NodeCapsuleOwner } from '../../../packages/capsule/src/node'
import { callCapsuleFromApp } from '../src/main/capsule-ipc'
import { senderTrust, assertSenderTrusted } from '../src/main/ipc-sender-trust'
import { sessionInputOperationResult } from '../src/shared/session-input-result'
import type { AgentMuxPreloadApi } from '../src/shared/contracts'

const wire = vi.hoisted(() => ({ api: null as AgentMuxPreloadApi | null, invoke: vi.fn() }))
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: (_name: string, api: AgentMuxPreloadApi) => { wire.api = api; Object.assign(window, { agentmux: api }) } },
  ipcRenderer: { invoke: wire.invoke, on: vi.fn(), off: vi.fn(), send: vi.fn(), removeListener: vi.fn() }, webFrame: { getZoomFactor: () => 1 } }))
import '../src/preload/index'
import { api } from '../src/renderer/src/lib/api'

const closes: Array<() => Promise<unknown>> = []
const trusted = {}, intruder = {}
let sender = trusted
beforeEach(() => { sender = trusted; wire.invoke.mockReset() })
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close() })

/** Execute the actual registered handler expression with its original captured domain ports. */
function handler(callOriginalCore: Parameters<typeof callCapsuleFromApp>[0]) {
  const text = readFileSync(process.env.CAPSULE_CLIENT_IPC_SOURCE ?? new NodeURL('../src/main/ipc.ts', import.meta.url), 'utf8')
  const source = ts.createSourceFile('ipc.ts', text, ts.ScriptTarget.Latest, true)
  const expressions: string[] = []
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'handleWithEvent' &&
        node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === 'capsules:call') expressions.push(node.arguments[1]!.getText(source))
    ts.forEachChild(node, visit)
  }
  visit(source); expect(expressions).toHaveLength(1)
  const compiled = ts.transpileModule(`(${expressions[0]})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const requireTrustedSender = (channel: 'capsules:call', event: { sender: object }) => assertSenderTrusted(senderTrust(channel, event.sender, trusted))
  return new Function('requireTrustedSender', 'sessionInputOperationResult', 'callCapsuleFromApp', 'args', `return ${compiled}`)(
    requireTrustedSender, sessionInputOperationResult, callCapsuleFromApp, { runtime: { callOriginalCore } }) as (event: { sender: object }, method: unknown, params: unknown) => Promise<unknown>
}
function mount(callOriginalCore: Parameters<typeof callCapsuleFromApp>[0]) {
  const execute = handler(callOriginalCore)
  wire.invoke.mockImplementation(async (channel, method, params) => {
    expect(channel).toBe('capsules:call')
    // Electron and contextBridge copy plain DTOs, including original failure envelopes.
    return structuredClone(await execute({ sender }, method, structuredClone(params)))
  })
}

it('routes actual Renderer/preload/Main IPC through the original public Host owner and retains configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'capsule-app-'))
  closes.push(() => rm(root, { recursive: true, force: true }))
  const owner = await NodeCapsuleOwner.open({ stateDirectory: join(root, 'capsules') })
  closes.push(() => owner.close())
  const server = new AgentMuxControlServer({ socketPath: join(root, 'owner.sock'), coreClients: () => [], capsules: owner })
  await server.start(); closes.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  closes.push(() => rpc.dispose())
  const calls: Array<{ hostId: string; method: string; params: unknown; context: AgentMuxRpcCallContext }> = []
  mount(async (hostId, method, params, context) => {
    calls.push({ hostId, method, params, context })
    return rpc.call(method, params)
  })
  expect(api.capsules).toBe(wire.api!.capsules)
  const { config } = await api.capsules.call('capsule.config.inspect', {})
  const changed = await api.capsules.call('capsule.config.update', { operationId: 'original-defaults', expectedRevision: config.revision,
    changes: { defaultMode: 'injected', defaultTheme: 'none' } })
  expect(changed.config).toMatchObject({ defaultMode: 'injected', defaultTheme: 'none' })
  const source = join(root, 'build'); await mkdir(source); await writeFile(join(source, 'index.html'), '<title>Original page</title>')
  const created = await api.capsules.call('capsule.create', { operationId: 'original-create', sourcePath: source })
  expect(created.record.mode).toBe('injected')
  const opened = await api.capsules.call('capsule.open', { capsuleId: created.record.capsuleId, operationId: 'original-open' })
  expect(opened).toMatchObject({ capsuleId: created.record.capsuleId, operationId: 'original-open', rendering: { status: 'unavailable' } })
  expect(calls.map(call => call.method)).toEqual(['capsule.config.inspect', 'capsule.config.update', 'capsule.create', 'capsule.open'])
  for (const call of calls) expect(call).toMatchObject({ hostId: 'local', context: { transport: 'unix', principal: { kind: 'user', id: `local-user:${process.getuid?.() ?? 'current'}` } } })
  expect(calls[3]!.params).toEqual({ capsuleId: created.record.capsuleId, operationId: 'original-open' })
  // Recreate only the page owner; no Desktop service is needed to consume saved defaults.
  await owner.close()
  const restored = await NodeCapsuleOwner.open({ stateDirectory: join(root, 'capsules') })
  closes.push(() => restored.close())
  expect((await restored.call('capsule.config.inspect', {})).config).toEqual(changed.config)
})

it('rejects untrusted App senders before any Host call', async () => {
  const call = vi.fn(async () => ({ capsules: [], issues: [] }))
  mount(call as never); sender = intruder
  const failure = await api.capsules.call('capsule.ls', {}).then(() => null, error => error)
  expect(failure).toMatchObject({ message: 'Untrusted Capsule page management sender' })
  expect(call).not.toHaveBeenCalled()
})

it('delegates each original Capsule call to the exact original Host once', async () => {
  const config = { revision: 1, contentRoot: (new URL('file:///').pathname + "fixture/capsules"), defaultStorageMode: 'managed', defaultMode: 'isolated', defaultTheme: 'follow' }
  const call = vi.fn(async () => ({ config }))
  mount(call as never)
  expect(await api.capsules.call('capsule.config.inspect', {})).toEqual({ config })
  expect(call).toHaveBeenCalledExactlyOnceWith('local', 'capsule.config.inspect', {}, {
    transport: 'unix', principal: { kind: 'user', id: `local-user:${process.getuid?.() ?? 'current'}` }
  })
})

it('accepts only Capsule methods and strict inputs and validates the original result', async () => {
  const call = vi.fn(async () => ({ capsules: [], issues: [] }))
  mount(call as never)
  const invoke = api.capsules.call as (method: string, params: unknown) => Promise<unknown>
  await expect(invoke('agent.send', {})).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  await expect(invoke('capsule.config.inspect', { authorHuman: true })).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  expect(call).not.toHaveBeenCalled()
  await expect(api.capsules.call('capsule.config.inspect', {})).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
  expect(call).toHaveBeenCalledTimes(1)
})

it('preserves unknown operation errors through copied preload envelopes without replay', async () => {
  const call = vi.fn(async () => { throw new AgentMuxError('Original open remains unconfirmed.', 'CAPSULE_OPERATION_UNKNOWN', 'Retain original-open; inspect its operation.') })
  mount(call as never)
  const failure = await api.capsules.call('capsule.open', { capsuleId: '123456789ABC', operationId: 'original-open' }).then(() => null, error => error)
  expect(failure).toMatchObject({ code: 'CAPSULE_OPERATION_UNKNOWN', detail: 'Retain original-open; inspect its operation.' })
  expect(call).toHaveBeenCalledTimes(1)
  expect(wire.invoke).toHaveBeenCalledExactlyOnceWith('capsules:call', 'capsule.open', { capsuleId: '123456789ABC', operationId: 'original-open' })
})
