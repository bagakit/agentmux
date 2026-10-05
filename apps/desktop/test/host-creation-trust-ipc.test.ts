import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer, AgentMuxCreationAuthority, connectAgentMuxRpc } from '@agentmux/core'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner'
import { readHostCreationTrust, approveHostCreationTrust } from '../src/main/settings-host-creation-trust'
import { assertSenderTrusted, senderTrust } from '../src/main/ipc-sender-trust'
import type { AgentMuxPreloadApi, SshHostConfig } from '../src/shared/contracts'

const wire = vi.hoisted(() => ({ api: null as AgentMuxPreloadApi | null, invoke: vi.fn() }))
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: (_name: string, api: AgentMuxPreloadApi) => { wire.api = api } },
  ipcRenderer: { invoke: wire.invoke, on: vi.fn(), off: vi.fn(), send: vi.fn(), removeListener: vi.fn() }, webFrame: { getZoomFactor: () => 1 } }))
import '../src/preload/index'

const close: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const dispose of close.splice(0).reverse()) await dispose(); vi.restoreAllMocks(); wire.invoke.mockReset() })

// Execute the actual two registered handler expressions, with their original captured ports.
// Other registerIpc services and Electron transport serialization are outside this focused test.
function handlers(ports: Parameters<typeof readHostCreationTrust>[1], sender: object) {
  const source = ts.createSourceFile('ipc.ts', readFileSync(new URL('../src/main/ipc.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
  const found = new Map<string, (event: { sender: object }, ...args: unknown[]) => Promise<unknown>>()
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'handleWithEvent' &&
        node.arguments[0] && ts.isStringLiteral(node.arguments[0]) &&
        ['hosts:creationTrust', 'hosts:trustCreationSource'].includes(node.arguments[0].text)) {
      const expression = ts.transpileModule(`(${node.arguments[1]!.getText(source)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
      const guard = (channel: 'hosts:creationTrust' | 'hosts:trustCreationSource', event: { sender: object }) =>
        assertSenderTrusted(senderTrust(channel, event.sender, sender))
      found.set(node.arguments[0].text, new Function('requireTrustedSender', 'readHostCreationTrust', 'approveHostCreationTrust', 'creationTrustPorts',
        `return ${expression}`)(guard, readHostCreationTrust, approveHostCreationTrust, ports))
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  expect([...found.keys()].sort()).toEqual(['hosts:creationTrust', 'hosts:trustCreationSource'])
  return found
}

async function fixture() {
  const f = await rpcOwnerFixture(); close.push(f.close)
  const source = new AgentMuxCreationAuthority({ stateDirectory: join(f.root, 'source'), runtimeId: 'source-runtime' })
  const target = new AgentMuxCreationAuthority({ stateDirectory: join(f.root, 'target'), runtimeId: 'target-runtime' })
  Object.assign(f.client, { creationAuthority: target }); vi.spyOn(f.client, 'connect').mockResolvedValue()
  const local = { connect: async () => {}, agentCreationAuthority: () => source.identity(), listTrustedCreationSources: () => source.listTrusted() }
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'trust-ipc.sock'), coreClients: () => [
    { hostId: 'local', client: local as never }, { hostId: 'remote', client: f.client }
  ] })
  await server.start(); close.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); close.push(() => rpc.dispose())
  const host: SshHostConfig = { id: 'remote', kind: 'ssh', label: 'Remote', hostname: 'target.invalid', runtimeId: 'target-runtime' }
  let rebind = false
  const replacement = new AgentMuxCreationAuthority({ stateDirectory: join(f.root, 'replacement'), runtimeId: 'replacement-runtime' })
  const ports: Parameters<typeof readHostCreationTrust>[1] = { savedHost: () => host, call: async (method, input) => {
    if (rebind && method === 'settings.hosts.trust-source') Object.assign(f.client, { creationAuthority: replacement })
    return await rpc.call(method, input)
  } }
  const trusted = {}, registered = handlers(ports, trusted)
  let sender = trusted
  wire.invoke.mockImplementation(async (channel, ...args) => {
    const handler = registered.get(channel); expect(handler).toBeTypeOf('function')
    return await handler!({ sender }, ...structuredClone(args))
  })
  return { host, target, replacement, api: wire.api!.hosts, untrust: () => { sender = {} }, rebind: () => { rebind = true } }
}

it('preload forwards the exact reviewed identity through the real Main handlers and Unix user principal', async () => {
  const f = await fixture(), expected = await f.api.creationTrust(f.host)
  expect(await f.target.listTrusted()).toEqual([])
  const receipt = await f.api.trustCreationSource(f.host, expected)
  expect(receipt.target.sources[0]).toMatchObject({ sourceRuntimeId: expected.source.runtimeId,
    targetRuntimeId: f.host.runtimeId, registeredBy: { kind: 'user' } })
  expect(await f.target.listTrusted()).toEqual(receipt.target.sources)
})
it('rejects an untrusted sender before either identity reads or approval', async () => {
  const f = await fixture(), expected = await f.api.creationTrust(f.host)
  f.untrust()
  await expect(f.api.creationTrust(f.host)).rejects.toThrow('Untrusted creation source identity sender')
  await expect(f.api.trustCreationSource(f.host, expected)).rejects.toThrow('Untrusted creation source approval sender')
  expect(await f.target.listTrusted()).toEqual([])
})
it('retains the reviewed target guard even when the public route changes after the final UI reread', async () => {
  const f = await fixture(), expected = await f.api.creationTrust(f.host)
  f.rebind()
  await expect(f.api.trustCreationSource(f.host, expected)).rejects.toMatchObject({ code: 'AGENT_CREATION_TARGET_MISMATCH' })
  expect(await f.target.listTrusted()).toEqual([])
  expect(await f.replacement.listTrusted()).toEqual([])
})

it('does not present an old approval as current when its saved route changes during the write', async () => {
  const host: SshHostConfig = { id: 'remote', kind: 'ssh', hostname: 'original.invalid', label: 'Remote' }
  let saved = host
  const source = { runtimeId: 'source', publicKey: 'source-key', fingerprint: 'a'.repeat(64) }
  const authority = { runtimeId: 'target', publicKey: 'target-key', fingerprint: 'b'.repeat(64) }
  const ports: Parameters<typeof readHostCreationTrust>[1] = { savedHost: () => saved, call: async (method, input) => {
    if (method === 'settings.hosts.trusted-sources') return { routeHostId: input.hostId,
      authority: input.hostId === 'local' ? source : authority, sources: [] } as never
    saved = { ...host, hostname: 'replacement.invalid' }
    return { routeHostId: host.id, authority, source: { sourceRuntimeId: source.runtimeId,
      publicKey: source.publicKey, fingerprint: source.fingerprint, targetRuntimeId: authority.runtimeId,
      registeredAt: 1, registeredBy: { kind: 'user', id: 'user' } } } as never
  } }
  const expected = await readHostCreationTrust(host, ports)
  await expect(approveHostCreationTrust(host, expected, ports)).rejects.toThrow('Save this exact connection')
})
