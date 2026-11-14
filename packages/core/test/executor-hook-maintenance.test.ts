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
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { hostedTestOwner } from './helpers/hosted-runtime-port.js'

it('checks the exact Host and preserves coexisting legacy entries through a managed update and CLI readback', async () => {
  const fixture = await rpcOwnerFixture()
  const registry = new AgentProviderRegistry()
  const installer = new AgentManagedHookInstaller(join(fixture.root, 'hook-state'))
  const hostedOwner = hostedTestOwner(fixture.client), runtimeId = hostedOwner.runtimeId
  const owner = new AgentMuxHostExecutorOwner({ path: join(fixture.root, 'executors.json'), runtimeId,
    catalog: () => registry.catalog() })
  Object.assign(fixture.client, { hostExecutorOwner: owner, hookInstaller: installer })
  const hosted = new AgentMuxHostedRuntimeService(fixture.client, null, () => hostedOwner)
  const connect = vi.spyOn(fixture.client, 'connect')
  const server = new AgentMuxControlServer({ socketPath: join(fixture.root, 'public.sock'),
    coreClients: () => [{ hostId: 'target', client: fixture.client }], hostedRuntime: () => hosted })
  let client: Awaited<ReturnType<typeof connectAgentMuxRpc>> | undefined
  try {
    await server.start()
    client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
    const command = process.execPath
    const grokEnv = { GROK_HOME: 'private-grok' }
    const config = { label: 'Native tool agent', providerId: 'grok', command, args: [], env: grokEnv, injectAgentMuxGuide: false }
    await client.call('settings.executors.register', { hostId: 'target', executorId: 'private', input: { config } })
    const inventory = await client.call('settings.executors.discover', { hostId: 'target', executorId: 'private', refresh: false })
    const target = { hostId: 'target', runtimeId: inventory.runtimeId, executorId: 'private',
      configRevision: inventory.executors[0]!.configRevision, workspacePath: fixture.root }
    const plan = registry.get('grok').planManagedHooks!({ env: grokEnv, workspacePath: fixture.root })!
    const mutation = plan.mutations[0]!
    const current = JSON.parse(mutation.content)
    const legacy = { matcher: '.*', hooks: [{ type: 'command',
      command: "ELECTRON_RUN_AS_NODE=1 AGENTMUX_HOOK_PROVIDER='grok' '" + command + "' '" + join(fixture.root, 'old copy', 'bin', 'agentmux-hook.js') + "'" }] }
    const user = { matcher: '^Keep$', hooks: [{ type: 'command', command: 'printf keep' }] }
    const broken = JSON.stringify({ hooks: { ...current.hooks, PreToolUse: [legacy, user, ...current.hooks.PreToolUse] } })
    await mkdir(dirname(mutation.path), { recursive: true })
    await writeFile(mutation.path, broken)

    const { workspacePath: _workspace, ...userScope } = target
    const relativeRead = await client.call('settings.executors.hooks-inspect', userScope)
    expect(relativeRead).toMatchObject({ health: 'unknown', canUpdate: false,
      inspection: { status: 'skipped', code: 'HOOK_WORKSPACE_REQUIRED', targets: [] } })
    const relativeUpdate = await client.call('settings.executors.hooks-update', userScope)
    expect(relativeUpdate.update.status).toBe('not-applicable')
    expect(await readFile(mutation.path, 'utf8')).toBe(broken)

    await client.call('settings.executors.register', { hostId: 'target', executorId: 'user-scope',
      input: { config: { ...config, env: { GROK_HOME: join(fixture.root, 'private-grok') } } } })
    const absoluteInventory = await client.call('settings.executors.discover', {
      hostId: 'target', executorId: 'user-scope', refresh: false
    })
    const absoluteCheck = await runCompiledObjectCli(['--endpoint', 'unix:' + server.path, 'settings', 'executors', 'hooks-inspect',
      '--host', target.hostId, '--runtime', target.runtimeId, '--executor', 'user-scope',
      '--config-revision', absoluteInventory.executors[0]!.configRevision], objectCliEnvironment(fixture.root))
    expect(absoluteCheck.code, absoluteCheck.stderr).toBe(0)
    expect(JSON.parse(absoluteCheck.stdout).result).toMatchObject({ executorId: 'user-scope', health: 'issue',
      inspection: { targets: [{ path: mutation.path, legacyDeclarations: 1, missingLegacyEntrypoints: 1 }] } })
    expect(JSON.parse(absoluteCheck.stdout).result).not.toHaveProperty('workspacePath')

    const noted = await client.call('settings.executors.hooks-inspect', target)
    expect(noted).toMatchObject({ routeHostId: target.hostId, health: 'issue', update: { status: 'not-requested' },
      inspection: { status: 'partial', code: 'MANAGED_HOOK_LEGACY_CARRIER', targets: [{ path: mutation.path, legacyDeclarations: 1 }] } })
    expect(await readFile(mutation.path, 'utf8')).toBe(broken)
    const { hostId: _route, ...hostedTarget } = target
    const invoke = { consumerId: 'hook-checker', fence: { runtimeId, ownerInstanceId: hostedOwner.ownerInstanceId },
      invocation: { method: 'maintainHostExecutorHooks' as const, args: [hostedTarget, false] } }
    const hostedRead = await client.call('runtime.invoke', invoke)
    expect(decodeHostedValue(hostedRead.value)).toMatchObject({ ...hostedTarget, health: 'issue', update: { status: 'not-requested' } })
    const agent = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path }, credentials: fixture.credentials })
    try {
      await expect(agent.call('settings.executors.hooks-update', target)).rejects.toMatchObject({ code: expect.stringMatching(/CONTROL_PERMISSION_DENIED|AGENT_CAPABILITY_INVALID/) })
      await expect(agent.call('runtime.invoke', { ...invoke, invocation: { ...invoke.invocation, args: [hostedTarget, true] } })).rejects
        .toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
    } finally { await agent.dispose() }
    await expect(client.call('settings.executors.hooks-update', { ...target, runtimeId: 'wrong-runtime' })).rejects.toMatchObject({ code: 'EXECUTOR_HOST_CHANGED' })
    await expect(client.call('settings.executors.hooks-update', { ...target, configRevision: 'old-revision' })).rejects.toMatchObject({ code: 'EXECUTOR_CONFIGURATION_CHANGED' })
    expect(await readFile(mutation.path, 'utf8')).toBe(broken)

    const cli = (action: string) => runCompiledObjectCli(['--endpoint', 'unix:' + server.path, 'settings', 'executors', action,
      '--host', target.hostId, '--runtime', target.runtimeId, '--executor', target.executorId, '--config-revision', target.configRevision,
      '--workspace', target.workspacePath], objectCliEnvironment(fixture.root))
    const preserved = await cli('hooks-update')
    expect(preserved.code, preserved.stderr).toBe(0)
    expect(JSON.parse(preserved.stdout).result).toMatchObject({ health: 'issue', update: { status: 'unchanged' } })
    expect(await readFile(mutation.path, 'utf8')).toBe(broken)
    await writeFile(mutation.path, JSON.stringify({ hooks: { PreToolUse: [user] } }))

    const updated = await cli('hooks-update')
    expect(updated.code, updated.stderr).toBe(0)
    expect(JSON.parse(updated.stdout).result).toMatchObject({ health: 'current', update: { status: 'updated', receiptId: expect.any(String) },
      inspection: { status: 'installed' } })
    expect(JSON.parse(await readFile(mutation.path, 'utf8')).hooks.PreToolUse).toEqual([user, ...current.hooks.PreToolUse])
    const readback = await cli('hooks-inspect')
    expect(readback.code, readback.stderr).toBe(0)
    expect(JSON.parse(readback.stdout).result).toMatchObject({ health: 'current', update: { status: 'not-requested' } })
    const invalid = '{"hooks":'
    await writeFile(mutation.path, invalid)
    const refused = await client.call('settings.executors.hooks-update', target)
    expect(refused).toMatchObject({ health: 'issue', update: { status: 'unconfirmed', code: 'HOOK_TARGET_UNPARSEABLE' },
      inspection: { status: 'error', targets: [{ path: mutation.path, code: 'HOOK_TARGET_UNPARSEABLE' }] } })
    expect(await readFile(mutation.path, 'utf8')).toBe(invalid)
    expect(connect).not.toHaveBeenCalled()
    expect(fixture.inner.kernel.stop).not.toHaveBeenCalled()
  } finally {
    await client?.dispose()
    await server.stop()
    await hosted.dispose()
    await fixture.close()
  }
}, 20_000)
