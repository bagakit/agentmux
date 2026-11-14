// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { URL as NodeURL } from 'node:url'
import ts from 'typescript'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer, connectAgentMuxRpc } from '@agentmux/core'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner'
import { sessionInputOperationResult } from '../src/shared/session-input-result'
import { prepareTailcatKey } from '../../host/src/tailcat-key'
import type { AgentMuxPreloadApi } from '../src/shared/contracts'

const wire = vi.hoisted(() => ({ api: null as AgentMuxPreloadApi | null, invoke: vi.fn() }))
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: (_name: string, api: AgentMuxPreloadApi) => { wire.api = api } },
  ipcRenderer: { invoke: wire.invoke, on: vi.fn(), off: vi.fn(), send: vi.fn(), removeListener: vi.fn() }, webFrame: { getZoomFactor: () => 1 } }))
import '../src/preload/index'

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); wire.invoke.mockReset() })

/** Execute the exact production handler and public Host port; unrelated Main initialization is outside this focused test. */
function productionWiring(runtime: object, callUserRpc: unknown) {
  const source = ts.createSourceFile('ipc.ts', readFileSync(new NodeURL('../src/main/ipc.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
  const handlers: ts.Expression[] = [], ports: ts.Expression[] = []
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'handleWithEvent' && node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === 'hosts:prepareTailcatKey') handlers.push(node.arguments[1]!)
    if (ts.isPropertyAssignment(node) && node.name.getText(source) === 'hostTailcatKey') ports.push(node.initializer)
    ts.forEachChild(node, visit)
  }
  visit(source)
  expect(handlers).toHaveLength(1); expect(ports).toHaveLength(1)
  const compile = (node: ts.Expression) => new Function('args', 'callUserRpc', 'sessionInputOperationResult',
    'return ' + ts.transpileModule('(' + node.getText(source) + ')', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)
    ({ runtime }, callUserRpc, sessionInputOperationResult)
  return { handler: compile(handlers[0]!), hostTailcatKey: compile(ports[0]!) }
}

it('the real preload and Main handler forward user preparation through Desktop to the original local Host', async () => {
  const f = await rpcOwnerFixture(); cleanup.push(f.close)
  const publicKey = 'nodekey:' + 'cd'.repeat(32)
  const prepare = vi.fn(async (input: { role: 'server' | 'client'; key: string }) => ({ ...input, created: false, ...(input.role === 'client' ? { publicKey } : {}) }))
  const original = new AgentMuxControlServer({ socketPath: join(f.root, 'original.sock'), hostTailcatKey: prepare })
  await original.start(); cleanup.push(() => original.stop())
  const originalRpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: original.path } }); cleanup.push(() => originalRpc.dispose())
  const callOriginalCore = vi.fn(async (hostId: string, method: import('@agentmux/core').AgentMuxRpcMethod,
    params: import('@agentmux/core').AgentMuxRpcParams<import('@agentmux/core').AgentMuxRpcMethod>, context: import('@agentmux/core').AgentMuxRpcCallContext) => {
    expect(hostId).toBe('local'); expect(context.transport).toBe('unix')
    return originalRpc.call(method, params)
  })
  let desktopRpc!: Awaited<ReturnType<typeof connectAgentMuxRpc>>
  const wiring = productionWiring({ callOriginalCore }, (method: never, params: never) => desktopRpc.call(method, params))
  const desktop = new AgentMuxControlServer({ socketPath: join(f.root, 'desktop.sock'), hostTailcatKey: wiring.hostTailcatKey })
  await desktop.start(); cleanup.push(() => desktop.stop())
  desktopRpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: desktop.path } }); cleanup.push(() => desktopRpc.dispose())
  wire.invoke.mockImplementation(async (channel, ...args) => {
    expect(channel).toBe('hosts:prepareTailcatKey')
    return wiring.handler({ sender: {} }, ...structuredClone(args))
  })
  expect(await wire.api!.hosts.prepareTailcatKey({ role: 'client', key: 'studio-client' }))
    .toEqual({ role: 'client', key: 'studio-client', created: false, publicKey })
  expect(prepare.mock.calls[0]![0]).toEqual({ role: 'client', key: 'studio-client' })
  expect(callOriginalCore).toHaveBeenCalledOnce()
  await expect(wire.api!.hosts.prepareTailcatKey({ role: 'server', key: '../foreign' })).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  expect(prepare).toHaveBeenCalledOnce()
  const managed = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: desktop.path }, credentials: f.credentials }); cleanup.push(() => managed.dispose())
  await expect(managed.call('settings.hosts.tailcat-key', { role: 'client' })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect(callOriginalCore).toHaveBeenCalledOnce()
})

it('the original Host spawn failure keeps its machine code through public RPC and Main/preload', async () => {
  const f = await rpcOwnerFixture(); cleanup.push(f.close)
  const original = new AgentMuxControlServer({ socketPath: join(f.root, 'missing-cli.sock'),
    hostTailcatKey: input => prepareTailcatKey(input, { environment: { HOME: f.root, PATH: join(f.root, 'missing-bin') } }) })
  await original.start(); cleanup.push(() => original.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: original.path } }); cleanup.push(() => rpc.dispose())
  const wiring = productionWiring({}, (method: never, params: never) => rpc.call(method, params))
  wire.invoke.mockImplementation(async (channel, ...args) => {
    expect(channel).toBe('hosts:prepareTailcatKey')
    return wiring.handler({ sender: {} }, ...structuredClone(args))
  })
  await expect(wire.api!.hosts.prepareTailcatKey({ role: 'client' }))
    .rejects.toMatchObject({ code: 'TAILCAT_CLI_MISSING', message: expect.stringContaining('PATH') })
})
