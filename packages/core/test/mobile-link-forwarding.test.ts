import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PassThrough } from 'node:stream'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectionOfferUrl } from '@agentmux/relay/offer'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { objectCliEnvironment, runCompiledObjectCli as compiledCli } from './helpers/object-cli-rpc.js'

const core = process.env.AGENTMUX_TEST_LINK_CORE_ROOT ?? resolve(import.meta.dirname, '..')
const { connectAgentMuxRpc } = await import(pathToFileURL(join(core, 'dist/public-rpc-client.js')).href) as typeof import('../src/public-rpc-client.js')
const { AgentExecutionRpcFrontend, AgentExecutionRpcResource } = await import(pathToFileURL(join(core, 'dist/agent-execution-rpc-relay.js')).href) as typeof import('../src/agent-execution-rpc-relay.js')
const { forwardAgentMuxRpcStdio } = await import(pathToFileURL(join(core, 'dist/agentmux-rpc-stdio.js')).href) as typeof import('../src/agentmux-rpc-stdio.js')
const closes: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close() })
// The private process may be scheduled slowly on a busy development Host.
const runCompiledObjectCli = (args: readonly string[], env: NodeJS.ProcessEnv) => compiledCli(args, env, '', 60_000)

async function host() {
  const h = await rpcOwnerFixture(['caller']); closes.push(h.close)
  const socketPath = join(h.root, 'control.sock')
  const owner = { runtimeId: 'original-semantic-runtime', ownerInstanceId: 'original-owner', protocolVersion: 2 as const, processId: process.pid, availability: 'connected' as const,
    ctxmux: { protocolVersion: 5, buildIdentity: 'isolated-native-port', hostId: 'local', processId: process.pid, instanceId: 'original-native-instance' } }
  const url = connectionOfferUrl('https://relay.example.org/', { v: 2, serverId: 'original-host', daemonPublicKeyB64: 'A'.repeat(43) + '=', relay: { endpoint: 'relay.example.org', useTls: true } })
  const link = { hostId: 'original-host', url, pageUrl: url.split('#')[0]!, relay: { endpoint: 'relay.example.org', useTls: true }, mobileAccess: { state: 'disconnected' as const, message: 'Original disconnected observation', origin: 'https://relay.example.org' } }
  const calls = vi.fn(async () => link)
  // Only native Runtime I/O and the already-qualified Host link producer are
  // ports; authorization, transport, forwarding, parsing and CLI are real.
  const server = new AgentMuxControlServer({ socketPath, coreClients: h.coreClients,
    deviceAdministration: { call: calls as never }, hostedRuntime: () => ({
      assertFence: fence => expect(fence).toEqual({ runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId }),
      call: (async () => ({ owner })) as never, subscribe: vi.fn() as never
    }) })
  await server.start(); closes.push(() => server.stop())
  const env = objectCliEnvironment(h.root, { AGENTMUX_AGENT_SESSION_ID: h.credentials.agentSessionId, AGENTMUX_AGENT_CAPABILITY: h.credentials.capability })
  return { ...h, socketPath, owner, link, calls, env }
}

describe('mobile link through the original forwarding boundaries', () => {
  it('returns exact Host facts through both tool-relay gates, the public client and actual compiled CLI', async () => {
    const h = await host(), failures: Error[] = [], frames: unknown[] = []
    const resource = new AgentExecutionRpcResource(h.credentials.agentSessionId, error => failures.push(error))
    let frontend!: InstanceType<typeof AgentExecutionRpcFrontend>
    const toFrontend = async (frame: unknown) => { frames.push(frame); await frontend.receive(frame) }
    frontend = new AgentExecutionRpcFrontend({ agentSessionId: h.credentials.agentSessionId, onError: error => failures.push(error),
      send: async frame => { frames.push(frame); await resource.receive(frame, toFrontend) } })
    closes.push(async () => { frontend.close(); await resource.close() })
    const token = await frontend.register({ agentSessionId: h.credentials.agentSessionId, capability: h.credentials.capability,
      lifecycleOperationId: 'original-tool-execution', endpointPath: h.socketPath, runtimeId: h.owner.runtimeId, ctxmuxInstanceId: h.owner.ctxmux.instanceId })
    const context = frontend.claim(token, 'original-tool-generation')
    await frontend.begin(context.generation, true)
    await resource.receive({ type: 'agent-rpc-context', ...context }, toFrontend)
    const helper = resource.environment(context.generation)!
    const endpoint = { transport: 'unix' as const, path: helper.AGENTMUX_RPC_ENDPOINT!.slice(5) }
    const credentials = { agentSessionId: helper.AGENTMUX_AGENT_SESSION_ID!, capability: helper.AGENTMUX_AGENT_CAPABILITY! }
    const rpc = await connectAgentMuxRpc({ endpoint, credentials }); closes.push(() => rpc.dispose())
    await expect(rpc.call('device.link', {})).resolves.toEqual(h.link)
    const result = await runCompiledObjectCli(['--endpoint', helper.AGENTMUX_RPC_ENDPOINT!, 'device', 'link'], { ...h.env, ...helper })
    expect(result.code, result.stderr).toBe(0); expect(JSON.parse(result.stdout).result).toEqual(h.link)
    const wrong = await connectAgentMuxRpc({ endpoint, credentials: { ...credentials, capability: 'changed' } }); closes.push(() => wrong.dispose())
    await expect(wrong.call('device.link', {})).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
    await expect(rpc.call('device.ls', {})).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
    await expect(rpc.call('device.revoke', { deviceId: 'original-device' })).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
    await expect(rpc.call('device.hello', { name: 'Phone' })).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
    expect(h.calls).toHaveBeenCalledTimes(2); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
    expect(JSON.stringify(frames)).not.toContain(h.credentials.capability); expect(failures).toEqual([])
  })

  it('forwards only caller-bearing link reads through stdio and leaves exact authorization with the original service', async () => {
    const h = await host(), input = new PassThrough(), output = new PassThrough(), abort = new AbortController()
    let bytes = ''; output.on('data', chunk => { bytes += chunk })
    const forwarding = forwardAgentMuxRpcStdio({ endpoint: { transport: 'unix', path: h.socketPath }, input, output, signal: abort.signal })
    closes.push(async () => { abort.abort(); await forwarding; input.destroy(); output.destroy() })
    const request = (id: string, caller?: unknown, method = 'device.link') => ({ jsonrpc: '2.0', id, method, params: caller === undefined ? {} : { caller } })
    for (const frame of [request('owned', h.credentials), request('wrong', { ...h.credentials, capability: 'changed' }), request('callerless'),
      request('administration', h.credentials, 'device.ls'), [request('batch-link', h.credentials), request('batch-revoke', h.credentials, 'device.revoke')]]) input.write(JSON.stringify(frame) + '\n')
    await vi.waitFor(() => expect(bytes.trim().split('\n')).toHaveLength(5))
    const responses = bytes.trim().split('\n').flatMap(line => JSON.parse(line)), byId = new Map<string, any>(responses.map(value => [value.id, value]))
    expect(byId.get('owned').result).toEqual(h.link)
    expect(byId.get('wrong').error.data.code).toBe('AGENT_CAPABILITY_INVALID')
    for (const id of ['callerless', 'administration', 'batch-link', 'batch-revoke']) expect(byId.get(id).error.data.code).toBe('CONTROL_PERMISSION_DENIED')
    expect(h.calls).toHaveBeenCalledTimes(1); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
  })

  it('keeps the same exact read and refusal through the actual compiled SSH CLI and stdio process', async () => {
    const h = await host(), bin = join(h.root, 'bin'); await mkdir(bin)
    // Isolate the SSH network/authentication hop, while executing the actual
    // remote CLI stdio bridge against the same original Unix business owner.
    await writeFile(join(bin, 'ssh'), `#!${process.execPath}\nimport {spawn} from 'node:child_process';\nconst p=spawn(process.execPath,${JSON.stringify([join(core, 'bin/amux'), '--endpoint', `unix:${h.socketPath}`, 'system', 'endpoint', '--stdio'])},{stdio:'inherit'});p.on('exit',code=>process.exit(code??1));\n`, { mode: 0o700 })
    const env = { ...h.env, PATH: bin + ':' + process.env.PATH }
    const args = ['--endpoint', `ssh://original-host/?socket=${encodeURIComponent(h.socketPath)}`, 'device', 'link']
    const result = await runCompiledObjectCli(args, env)
    expect(result.code, result.stderr).toBe(0); expect(JSON.parse(result.stdout).result).toEqual(h.link)
    const wrong = await runCompiledObjectCli(args, { ...env, AGENTMUX_AGENT_CAPABILITY: 'changed' })
    expect(wrong.code).toBe(1); expect(JSON.parse(wrong.stderr).error.code).toBe('AGENT_CAPABILITY_INVALID')
    const callerless = { ...env }; delete callerless.AGENTMUX_AGENT_SESSION_ID; delete callerless.AGENTMUX_AGENT_CAPABILITY
    const refused = await runCompiledObjectCli(args, callerless)
    expect(refused.code).toBe(1); expect(JSON.parse(refused.stderr).error.code).toBe('CONTROL_PERMISSION_DENIED')
    expect(h.calls).toHaveBeenCalledTimes(1)
  })

  it('gives a failed read reachable advice without replaying it or losing typed unknown facts', async () => {
    const h = await host(), rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(h.root, 'missing.sock') }, credentials: h.credentials })
    closes.push(() => rpc.dispose())
    const failure = await rpc.call('device.link', {}).catch(error => error)
    expect(failure).toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
    expect(failure.message).toContain('Explicitly read amux device link again on the same original Host')
    expect(failure.message).not.toContain('device ls'); expect(failure.message).not.toContain('replay a write')
    const result = await runCompiledObjectCli(['--endpoint', `unix:${join(h.root, 'missing.sock')}`, 'device', 'link'], h.env)
    expect(result.code).toBe(1); expect(JSON.parse(result.stderr).error).toMatchObject({ code: failure.code, message: failure.message })
    expect(h.calls).not.toHaveBeenCalled(); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
  })
})
