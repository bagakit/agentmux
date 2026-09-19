import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentProviderRegistry, resolveManagedHookPlan } from '../src/agent-provider.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import { AgentManagedHookInstaller } from '../src/managed-hook-installer.js'
import { diagnoseAgentMux } from '../src/doctor.js'
import type { AgentMuxRuntimeDiagnostics } from '../src/types.js'

let root: string
let client: AgentMuxClient
let installer: AgentManagedHookInstaller
const runtime: AgentMuxRuntimeDiagnostics = { nodeVersion: '24.0.0', platform: 'darwin', arch: 'arm64', supported: true,
  ctxmux: {
    state: { configuredDirectory: '/fixture/future', servingDirectory: null }, serving: { buildIdentity: 'fixture', protocolVersion: 17, instanceId: 'fixture', sourceCommit: null }, bundled: { version: '0.1.0', sourceCommit: 'c168c0ab9cd849bfade68461b62684982c71f688', artifactPlatform: 'darwin-arm64' }, ready: true,
    capabilities: { transport: 'local-unix', orderedOutputBytes: true, boundedReplay: true, recoverableInput: true, resize: true, interrupt: true, completeStop: true } } }

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'amx-doctor-hook-'))
  const providers = new AgentProviderRegistry()
  installer = new AgentManagedHookInstaller(join(root, 'receipts'))
  client = new AgentMuxClient({ providers: ['claude', 'kimi', 'traex'].map(id => providers.get(id)), hookInstaller: installer, store: new AgentMuxMemoryAgentSessionStore() })
  vi.spyOn(client, 'connect').mockResolvedValue(undefined)
  vi.spyOn(client, 'runtimeIdentity').mockReturnValue({ hostId: 'local', buildIdentity: 'fixture', protocolVersion: 17, instanceId: 'fixture-runtime', processId: null })
  vi.spyOn(client, 'runtimeDiagnostics').mockResolvedValue(runtime)
  vi.spyOn(client, 'probeAgent').mockImplementation(async id => ({ providerId: id, executable: providers.get(id).executable, installed: true, capabilities: providers.get(id).catalog.capabilities }))
  vi.spyOn(client, 'probeExecutorAvailability').mockResolvedValue('available')
})
afterEach(async () => { await client.dispose(); await rm(root, { recursive: true, force: true }) })

describe('actual Core disk observations consumed by Doctor', () => {
  it('captures pre-connect absence then preserves it when ordinary connection repairs the same private files', async () => {
    const resolved = resolveManagedHookPlan('claude', root, {})!
    vi.mocked(client.connect).mockImplementation(async () => { await installer.ensure(resolved) })
    const inspected = vi.spyOn(client, 'inspectManagedHooks')
    const report = await diagnoseAgentMux({ client, workspacePath: root, env: {} })
    expect(report.agents.map(agent => [agent.id, agent.probe, agent.hookInstallation.status, agent.hookInstallation.phase])).toEqual([
      ['claude', 'found', 'not_installed', 'pre-connect'], ['kimi', 'found', 'skipped', 'pre-connect'], ['traex', 'found', 'skipped', 'pre-connect']
    ])
    expect(report.ok).toBe(true)
    expect(inspected.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(client.connect).mock.invocationCallOrder[0]!)
    expect(await client.inspectManagedHooks('claude', { workspacePath: root })).toMatchObject({ status: 'installed', workspacePath: root })
    expect(report.agents[0]!.hookInstallation.targets).toEqual([{ path: resolved.mutations[0]!.path, status: 'not_present' }])
    expect(report.agents[0]!.hookInstallation.checkedAt).toBeGreaterThan(0)
  })

  it('keeps malformed scoped facts on unreachable Runtime and never prints config content or command', async () => {
    const resolved = resolveManagedHookPlan('claude', root, {})!
    await mkdir(join(root, '.claude'))
    await writeFile(resolved.mutations[0]!.path, '{private-credential-do-not-report')
    vi.mocked(client.connect).mockRejectedValue(new Error('synthetic Runtime unavailable'))
    const report = await diagnoseAgentMux({ client, workspacePath: root })
    expect(report.agents.map(agent => [agent.id, agent.probe, agent.hookInstallation.status])).toEqual([
      ['claude', 'blocked', 'error'], ['kimi', 'blocked', 'skipped'], ['traex', 'blocked', 'skipped']
    ])
    expect(report.agents[0]!.hookInstallation.targets).toEqual([{ path: resolved.mutations[0]!.path, status: 'error', code: 'HOOK_TARGET_UNPARSEABLE' }])
    expect(report.agents[0]!.hookInstallation.phase).toBe('pre-connect')
    expect(report.host.reachable).toBe(false)
    expect(JSON.stringify(report)).not.toContain('private-credential-do-not-report')
    expect(await readFile(resolved.mutations[0]!.path, 'utf8')).toBe('{private-credential-do-not-report')
  })

  it('reports unsupported, unmanaged, missing workspace and binding context as explicit skipped facts', async () => {
    expect(await client.inspectManagedHooks('traex', { workspacePath: root })).toMatchObject({ status: 'skipped', code: 'HOOKS_UNSUPPORTED', targets: [] })
    expect(await client.inspectManagedHooks('kimi', { workspacePath: root })).toMatchObject({ status: 'skipped', code: 'HOOKS_NOT_MANAGED', targets: [] })
    expect(await client.inspectManagedHooks('claude')).toMatchObject({ status: 'skipped', code: 'HOOK_WORKSPACE_REQUIRED', workspacePath: null, targets: [] })
    const provider = new AgentProviderRegistry().get('opencode')
    const other = new AgentMuxClient({ providers: [provider], hookInstaller: installer, store: new AgentMuxMemoryAgentSessionStore() })
    try { expect(await other.inspectManagedHooks('opencode', { workspacePath: root })).toMatchObject({ status: 'skipped', code: 'HOOK_PLAN_CONTEXT_UNAVAILABLE', targets: [] }) }
    finally { await other.dispose() }
  })

  it('checks an existing exact plugin binding context without exposing its generated credential', async () => {
    const provider = new AgentProviderRegistry().get('opencode')
    const other = new AgentMuxClient({ providers: [provider], hookInstaller: installer, store: new AgentMuxMemoryAgentSessionStore() })
    const env = { OPENCODE_CONFIG_DIR: join(root, 'private-opencode') }
    const endpoint = { url: 'http://127.0.0.1:65535/hook', token: 'private-existing-binding-token' }
    const resolved = resolveManagedHookPlan('opencode', root, env, endpoint)!
    await installer.ensure(resolved)
    try {
      const result = await other.inspectManagedHooks('opencode', { workspacePath: root, env, endpoint })
      expect(result).toMatchObject({status:'installed',targets:[{path:resolved.mutations[0]!.path,status:'current'}]})
      expect(JSON.stringify(result)).not.toContain(endpoint.token)
      expect(await other.inspectManagedHooks('opencode', { workspacePath: root, env, endpoint: {...endpoint,token:'other-binding-token'} })).toMatchObject({status:'partial'})
    } finally { await other.dispose() }
  })

  it('keeps current disk targets when a native activation reader fails, without connect, stop or create', async () => {
    const base = new AgentProviderRegistry().get('claude')
    const other = new AgentMuxClient({ providers: [{ ...base, inspectHookActivation: async () => { throw new Error('private-native-stderr') } }], hookInstaller: installer, store: new AgentMuxMemoryAgentSessionStore() })
    const resolved = resolveManagedHookPlan('claude', root, {})!
    await installer.ensure(resolved)
    const connect = vi.spyOn(other, 'connect'), stop = vi.spyOn(other, 'stopAgent'), create = vi.spyOn(other, 'createAgent')
    try {
      const result = await other.inspectManagedHooks('claude', { workspacePath: root })
      expect(result).toMatchObject({ status: 'error', code: 'HOOK_ACTIVATION_CHECK_FAILED', targets: [{ path: resolved.mutations[0]!.path, status: 'current' }] })
      expect(JSON.stringify(result)).not.toContain('private-native-stderr')
      expect(connect).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled()
    } finally { await other.dispose() }
  })
})
