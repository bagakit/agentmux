import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import { AgentMuxHostExecutorOwner } from '../src/executor-owner.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { decodeHostedValue } from '../src/hosted-value.js'
import { AgentManagedHookInstaller } from '../src/managed-hook-installer.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { hostedTestOwner } from './helpers/hosted-runtime-port.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'

it('checks and repairs only the selected native Hook scope through Host RPC and the CLI', async () => {
  const fixture = await rpcOwnerFixture()
  const registry = new AgentProviderRegistry()
  const installer = new AgentManagedHookInstaller(join(fixture.root, 'hook-state'))
  const inspect = vi.spyOn(installer, 'inspect'), ensure = vi.spyOn(installer, 'ensure')
  const hostedOwner = hostedTestOwner(fixture.client)
  const owner = new AgentMuxHostExecutorOwner({ path: join(fixture.root, 'native-executors.json'), runtimeId: hostedOwner.runtimeId,
    catalog: () => registry.catalog() })
  Object.assign(fixture.client, { hostExecutorOwner: owner, hookInstaller: installer })
  const hosted = new AgentMuxHostedRuntimeService(fixture.client, null, () => hostedOwner)
  const connect = vi.spyOn(fixture.client, 'connect')
  const hostId = 'target'
  const server = new AgentMuxControlServer({ socketPath: join(fixture.root, 'scope-test.sock'), hostedRuntime: () => hosted,
    coreClients: () => [{ hostId, client: fixture.client }] })
  const providerId = 'grok'
  const shared = join(fixture.root, 'shared'), other = join(fixture.root, 'other')
  vi.stubEnv('GROK_HOME', shared)
  let client: Awaited<ReturnType<typeof connectAgentMuxRpc>> | undefined
  try {
    await server.start()
    const rpc = client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
    const register = (executorId: string, path: string, expectedRevision?: string) => rpc.call('settings.executors.register', { hostId, executorId, input: {
      config: { label: executorId, providerId, command: process.execPath, args: ['--wrapper-flag'], env: { GROK_HOME: path, PRIVATE_VALUE: 'must-not-leave-host' }, injectAgentMuxGuide: false },
      ...(expectedRevision === undefined ? {} : { expectedRevision })
    } })
    await register('same-native-path', shared + '/.')
    const otherExecutor = await register('other-native-path', other)
    await register('relative-a', 'shared')
    await register('relative-b', 'other')
    const sharedPath = registry.get(providerId).planManagedHooks!({ env: { GROK_HOME: shared } })!.mutations[0]!.path
    const otherPath = registry.get(providerId).planManagedHooks!({ env: { GROK_HOME: other } })!.mutations[0]!.path
    const nativeContent = { hooks: { PreToolUse: [{ matcher: '^User$', hooks: [{ type: 'command', command: 'printf keep' }] }] } }
    await mkdir(dirname(sharedPath), { recursive: true })
    await writeFile(sharedPath, JSON.stringify(nativeContent))

    const listed = await rpc.call('settings.providers.hooks-list', { hostId, providerId })
    expect(listed).toMatchObject({ routeHostId: hostId, runtimeId: hostedOwner.runtimeId })
    expect(listed.scopes).toHaveLength(4)
    expect(JSON.stringify(listed)).not.toContain('must-not-leave-host')
    expect(inspect.mock.calls.flatMap(([plan]) => plan.mutations.map(mutation => mutation.path))).toEqual([sharedPath, otherPath])
    expect(ensure).not.toHaveBeenCalled()
    const sharedScope = listed.scopes.find(scope => scope.paths.includes(sharedPath))!
    const otherScope = listed.scopes.find(scope => scope.paths.includes(otherPath))!
    expect(sharedScope).toMatchObject({ providerId, kind: 'configuration', canUpdate: true, health: 'issue',
      executors: [{ executorId: providerId, configRevision: expect.any(String) }, { executorId: 'same-native-path', configRevision: expect.any(String) }] })
    expect(listed.scopes.filter(scope => scope.kind === 'unresolved')).toMatchObject([
      { paths: [], inspection: { code: 'HOOK_WORKSPACE_REQUIRED' }, health: 'unknown', canUpdate: false, executors: [{ executorId: 'relative-a' }] },
      { paths: [], inspection: { code: 'HOOK_WORKSPACE_REQUIRED' }, health: 'unknown', canUpdate: false, executors: [{ executorId: 'relative-b' }] }
    ])
    const withWorkspace = await rpc.call('settings.providers.hooks-list', { hostId, providerId, workspacePath: fixture.root })
    expect(withWorkspace.scopes).toHaveLength(2)
    expect(withWorkspace.scopes[0]).toMatchObject({ scopeId: sharedScope.scopeId, scopeRevision: sharedScope.scopeRevision,
      executors: [{ executorId: providerId }, { executorId: 'same-native-path' }, { executorId: 'relative-a' }] })

    inspect.mockClear()
    for (const providerId of ['codex', 'claude']) {
      const carried = await rpc.call('settings.providers.hooks-list', { hostId, providerId })
      expect(carried.scopes).toMatchObject([{ kind: 'launch-carried', canUpdate: false, paths: [],
        inspection: { code: 'HOOK_NATIVE_LOADING_UNCONFIRMED' }, executors: [{ executorId: providerId, canInspectLoading: true }] }])
      expect(carried.scopes[0]).not.toHaveProperty('scopeRevision')
    }
    expect(inspect).not.toHaveBeenCalled()

    const target = { hostId, providerId, runtimeId: listed.runtimeId, scopeId: sharedScope.scopeId, scopeRevision: sharedScope.scopeRevision! }
    const original = await rpc.call('settings.providers.hooks-inspect', target)
    expect(original.scope).toMatchObject({ scopeId: sharedScope.scopeId, update: { status: 'not-requested' } })
    expect(inspect.mock.calls.flatMap(([plan]) => plan.mutations.map(mutation => mutation.path))).toEqual([sharedPath])
    const { hostId: _host, ...hostedTarget } = target
    const fence = { runtimeId: hostedOwner.runtimeId, ownerInstanceId: hostedOwner.ownerInstanceId }
    const hostedRead = await rpc.call('runtime.invoke', { fence, consumerId: 'scope-checker',
      invocation: { method: 'maintainHostProviderHooks', args: [hostedTarget, false] } })
    expect(decodeHostedValue(hostedRead.value)).toMatchObject({ runtimeId: listed.runtimeId, scope: { scopeId: sharedScope.scopeId } })

    const agent = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path }, credentials: fixture.credentials })
    try {
      await expect(agent.call('settings.providers.hooks-update', target)).rejects.toMatchObject({ code: expect.stringMatching(/CONTROL_PERMISSION_DENIED|AGENT_CAPABILITY_INVALID/) })
      await expect(agent.call('runtime.invoke', { fence, consumerId: 'scope-checker',
        invocation: { method: 'maintainHostProviderHooks', args: [hostedTarget, true] } })).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
    } finally { await agent.dispose() }
    await expect(rpc.call('settings.providers.hooks-update', { ...target, runtimeId: 'wrong-runtime' })).rejects.toMatchObject({ code: 'HOOK_SCOPE_HOST_CHANGED' })
    await expect(rpc.call('settings.providers.hooks-update', { ...target, scopeRevision: '0'.repeat(64) })).rejects.toMatchObject({ code: 'HOOK_SCOPE_CHANGED' })
    expect(ensure).not.toHaveBeenCalled()

    const cli = (action: string, args: string[]) => runCompiledObjectCli(['--endpoint', 'unix:' + server.path, 'settings', 'providers', `hooks-${action}`,
      '--host', hostId, '--provider', providerId, ...args], objectCliEnvironment(fixture.root))
    const discovered = await cli('list', [])
    expect(discovered.code, discovered.stderr).toBe(0)
    expect(JSON.parse(discovered.stdout).result.scopes).toEqual(expect.arrayContaining([expect.objectContaining({ scopeId: target.scopeId, scopeRevision: target.scopeRevision })]))
    const flags = ['--runtime', target.runtimeId, '--scope', target.scopeId, '--scope-revision', target.scopeRevision]
    const updated = await cli('update', flags)
    expect(updated.code, updated.stderr).toBe(0)
    expect(JSON.parse(updated.stdout).result.scope).toMatchObject({ scopeId: target.scopeId, health: 'current', update: { status: 'updated', receiptId: expect.any(String) } })
    const readback = await cli('inspect', flags)
    expect(readback.code, readback.stderr).toBe(0)
    expect(JSON.parse(readback.stdout).result.scope).toMatchObject({ scopeId: target.scopeId, health: 'current', update: { status: 'not-requested' } })
    expect(JSON.parse(await readFile(sharedPath, 'utf8')).hooks.PreToolUse).toEqual(expect.arrayContaining(nativeContent.hooks.PreToolUse))
    await expect(readFile(otherPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

    await register('other-native-path', join(fixture.root, 'changed'), otherExecutor.executor.configRevision)
    await expect(rpc.call('settings.providers.hooks-update', { ...target, scopeId: otherScope.scopeId, scopeRevision: otherScope.scopeRevision! }))
      .rejects.toMatchObject({ code: 'HOOK_SCOPE_CHANGED' })
    expect(ensure).toHaveBeenCalledTimes(1)
    expect(connect).not.toHaveBeenCalled()
    expect(fixture.inner.kernel.stop).not.toHaveBeenCalled()
  } finally {
    vi.unstubAllEnvs()
    await client?.dispose()
    await server.stop()
    await hosted.dispose()
    await fixture.close()
  }
}, 20_000)
