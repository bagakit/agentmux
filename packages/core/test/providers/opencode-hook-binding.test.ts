import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentProviderRegistry } from '../../src/agent-provider.js'
import { AgentHookServer } from '../../src/hook-server.js'
import { AgentManagedHookInstaller } from '../../src/managed-hook-installer.js'
import { AgentMuxClient } from '../../src/client.js'
import { AgentMuxMemoryAgentSessionStore } from '../../src/agent-session-store.js'
import { createOpenCodeManagedHookPlan } from '../../src/providers/opencode.js'
import type { NativeHookEnvelope } from '../../src/types.js'

type Plugin = { server(): Promise<{ event?: (input: { event: { type: string; properties: Record<string, unknown> } }) => Promise<void> }> }
const roots: string[] = [], servers: AgentHookServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.stop()))
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'amx-opencode-binding-')); roots.push(root); return root
}
async function plugin(): Promise<Plugin> {
  const source = createOpenCodeManagedHookPlan({ OPENCODE_CONFIG_DIR: await directory() }).mutations[0]!.content
  return await import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`) as Plugin
}
function bindEnvironment(endpoint: { url: string; token: string }, host = 'owned'): void {
  vi.stubEnv('AGENTMUX_ENV', '1'); vi.stubEnv('AGENTMUX_PROVIDER_ID', 'opencode')
  vi.stubEnv('AGENTMUX_OPENCODE_HOOK_HOST', host)
  vi.stubEnv('AGENTMUX_HOOK_URL', endpoint.url); vi.stubEnv('AGENTMUX_HOOK_TOKEN', endpoint.token)
}

describe('OpenCode shared plugin keeps each native host binding', () => {
  it('keeps shared source independent of the original endpoint, token and Run environment', async () => {
    const root = await directory(), provider = new AgentProviderRegistry().get('opencode')
    const plan = (token: string) => provider.planManagedHooks!({ workspacePath: root,
      env: { OPENCODE_CONFIG_DIR: root, AGENTMUX_HOOK_URL: `http://127.0.0.1/${token}`, AGENTMUX_HOOK_TOKEN: token },
      endpoint: { url: `http://127.0.0.1/${token}`, token } })!
    const first = plan('private-original-a'), second = plan('private-original-b')
    expect(first.mutations).toHaveLength(1)
    expect(second).toEqual(first)
    expect(first.mutations[0]!.content).not.toContain('private-original-a')
    expect(first.mutations[0]!.content).not.toContain('private-original-b')
  })

  it('delivers two factories from the same cached module to their original authenticated Core Runs', async () => {
    const observed: NativeHookEnvelope[] = []
    const server = new AgentHookServer(event => { observed.push(event) }, 0); servers.push(server); await server.start()
    const a = server.createBinding('original-agent-a', 'opencode'), b = server.createBinding('original-agent-b', 'opencode')
    await a.bindRun('original-run-a'); await b.bindRun('original-run-b')
    const module = await plugin()
    bindEnvironment(a.endpoint); const first = await module.server()
    bindEnvironment(b.endpoint); const second = await module.server()
    expect(first.event).toBeTypeOf('function'); expect(second.event).toBeTypeOf('function')
    await first.event!({ event: { type: 'session.status', properties: { sessionID: 'native-a', status: { type: 'busy' } } } })
    await second.event!({ event: { type: 'session.status', properties: { sessionID: 'native-b', status: { type: 'busy' } } } })
    await vi.waitFor(() => expect(observed).toHaveLength(2))
    expect(observed.map(event => [event.agentSessionId, event.runId, event.eventName, event.payload?.sessionID]).sort()).toEqual([
      ['original-agent-a', 'original-run-a', 'session.status', 'native-a'],
      ['original-agent-b', 'original-run-b', 'session.status', 'native-b']
    ])
    const provider = new AgentProviderRegistry().get('opencode')
    const own = provider.normalizeHook(observed.find(event => event.runId === 'original-run-a')!, {
      nativeHandle: { kind: 'provider', providerId: 'opencode', sessionId: 'native-a' } })
    const foreign = provider.normalizeHook(observed.find(event => event.runId === 'original-run-b')!, {
      nativeHandle: { kind: 'provider', providerId: 'opencode', sessionId: 'native-a' } })
    expect(own.semanticState).toBe('working')
    expect(foreign.semanticState).toBe('unknown'); expect(foreign.nativeHandle).toBeUndefined()
  })

  it('keeps a healthy original binding usable when that Run predates the host observation field', async () => {
    const observed: NativeHookEnvelope[] = []
    const server = new AgentHookServer(event => { observed.push(event) }, 0); servers.push(server); await server.start()
    const binding = server.createBinding('retained-agent', 'opencode'); await binding.bindRun('retained-run')
    const module = await plugin(); bindEnvironment(binding.endpoint)
    vi.stubEnv('AGENTMUX_OPENCODE_HOOK_HOST', undefined)
    const hooks = await module.server(); expect(hooks.event).toBeTypeOf('function')
    await hooks.event!({ event: { type: 'session.status', properties: { sessionID: 'retained-native', status: { type: 'busy' } } } })
    await vi.waitFor(() => expect(observed).toHaveLength(1))
    expect(observed[0]).toMatchObject({ agentSessionId: 'retained-agent', runId: 'retained-run',
      payload: { sessionID: 'retained-native' } })
  })

  it.each(['external', 'foreign-provider', 'unbound-host'] as const)('keeps %s invocation passive even with another Run credentials in scope', async mode => {
    const module = await plugin()
    bindEnvironment({ url: 'http://127.0.0.1:1/unused', token: 'retained-original-token' })
    if (mode === 'external') vi.stubEnv('AGENTMUX_ENV', undefined)
    if (mode === 'foreign-provider') vi.stubEnv('AGENTMUX_PROVIDER_ID', 'codex')
    if (mode === 'unbound-host') vi.stubEnv('AGENTMUX_OPENCODE_HOOK_HOST', 'unbound')
    const request = vi.spyOn(globalThis, 'fetch')
    expect(await module.server()).toEqual({})
    expect(request).not.toHaveBeenCalled()
  })

  it('reports a missing binding without turning it into a permission decision or native failure', async () => {
    const module = await plugin(); bindEnvironment({ url: 'http://127.0.0.1:1/unused', token: '' })
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await module.server()).toEqual({})
    expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining('binding is unavailable'))
  })

  it('lets public Core inspect the same credential-free target before any Runtime connection or binding', async () => {
    const root = await directory(), config = join(root, 'config'), state = join(root, 'state')
    vi.stubEnv('AGENTMUX_STATE_DIRECTORY', state); vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(state, 'queue.ndjson'))
    const installer = new AgentManagedHookInstaller(join(root, 'receipts'))
    const client = new AgentMuxClient({ providers: [new AgentProviderRegistry().get('opencode')], hookInstaller: installer,
      store: new AgentMuxMemoryAgentSessionStore() })
    const options = { workspacePath: root, env: { OPENCODE_CONFIG_DIR: config } }
    const controls = [vi.spyOn(client, 'connect'), vi.spyOn(client, 'createAgent'), vi.spyOn(client, 'stopAgent')]
    try {
      const plan = createOpenCodeManagedHookPlan(options.env)
      expect(await client.inspectManagedHooks('opencode', options)).toMatchObject({ status: 'not_installed',
        targets: [{ path: plan.mutations[0]!.path, status: 'not_present' }] })
      await installer.ensure(plan)
      const first = await client.inspectManagedHooks('opencode', options)
      const second = await client.inspectManagedHooks('opencode', { ...options, endpoint: { url: 'http://127.0.0.1/other', token: 'new-original-run' } })
      expect(first).toMatchObject({ status: 'partial', code: 'HOOK_ACTIVATION_NEEDS_EVIDENCE', targets: [{ status: 'current' }] })
      expect(second).toMatchObject({ status: first.status, code: first.code, targets: first.targets })
      expect(await client.inspectManagedHooks('opencode', { ...options, args: ['attach', 'http://127.0.0.1:4096'] }))
        .toMatchObject({ status: 'partial', code: 'OPENCODE_HOOK_HOST_UNBOUND', targets: [{ status: 'current' }] })
      expect(await readFile(plan.mutations[0]!.path, 'utf8')).not.toContain('new-original-run')
      for (const control of controls) expect(control).not.toHaveBeenCalled()
    } finally { await client.dispose() }
  })

  it.each([
    ['attach', 'http://127.0.0.1:4096'],
    ['--log-level', 'ERROR', 'attach', 'http://127.0.0.1:4096'],
    ['run', '--attach=http://127.0.0.1:4096', 'original message']
  ])('preserves explicit external host arguments %j with an unbound service issue', (...args) => {
    const provider = new AgentProviderRegistry().get('opencode')
    const plan = provider.buildLaunch({ workspacePath: '/private/native-test', prompt: '', args, env: {} })
    expect(plan.args).toEqual(args)
    expect(plan.env.AGENTMUX_OPENCODE_HOOK_HOST).toBe('unbound')
    expect(plan.hookLaunchIssue?.code).toBe('OPENCODE_HOOK_HOST_UNBOUND')
    const resumed = provider.buildResumeLaunch({ workspacePath: '/private/native-test', prompt: '', args, env: {},
      nativeHandle: { kind: 'provider', providerId: 'opencode', sessionId: 'original-native-session' } })
    expect(resumed.args).toEqual(['--session', 'original-native-session', ...args])
    expect(resumed.hookLaunchIssue?.code).toBe('OPENCODE_HOOK_HOST_UNBOUND')
  })

  it.each([['--prompt', 'attach'], ['--prompt=attach'], ['--', 'attach'], ['run', 'attach']])('does not reinterpret opaque native data %j as an external host', (...args) => {
    const provider = new AgentProviderRegistry().get('opencode')
    const plan = provider.buildLaunch({ workspacePath: '/private/native-test', prompt: '', args, env: {} })
    expect(plan.args).toEqual(args); expect(plan.hookLaunchIssue).toBeUndefined()
    expect(plan.env.AGENTMUX_OPENCODE_HOOK_HOST).toBe('owned')
  })
})
