import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve, join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import type { AgentMuxRuntimeDiagnostics } from '../src/types.js'

it('decodes actual Doctor through Unix RPC and compiled CLI from one original executable observation', async () => {
  const f = await rpcOwnerFixture()
  f.inner.kernel.connect = vi.fn(async () => {})
  const prepare = vi.fn(async () => {})
  Object.assign(f.client, { prepareExecutionEnvironment: prepare })
  const catalog = new AgentProviderRegistry().get('codex').catalog
  vi.spyOn(f.client, 'catalog').mockReturnValue([catalog])
  vi.stubEnv('PATH', f.root)
  vi.spyOn(f.client, 'inspectManagedHooks').mockResolvedValue({ providerId: 'codex', workspacePath: null,
    checkedAt: Date.now(), status: 'skipped', code: 'HOOK_WORKSPACE_REQUIRED', action: 'Select a workspace.', targets: [] })
  vi.spyOn(f.client, 'runtimeDiagnostics').mockResolvedValue({ nodeVersion: process.versions.node, platform: 'darwin', arch: 'arm64', supported: true,
    ctxmux: { state: { configuredDirectory: f.root, servingDirectory: null },
      serving: { buildIdentity: 'fixture', protocolVersion: 17, instanceId: 'fixture', sourceCommit: null },
      bundled: { version: '0.1.0', sourceCommit: 'fixture', artifactPlatform: 'darwin-arm64' }, ready: true,
      capabilities: { transport: 'local-unix', orderedOutputBytes: true, boundedReplay: true, recoverableInput: true,
        resize: true, interrupt: true, completeStop: true } } } satisfies AgentMuxRuntimeDiagnostics)
  const availability = vi.spyOn(f.client, 'probeExecutorAvailability')
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'doctor.sock'), coreClients: f.coreClients })
  let rpc: Awaited<ReturnType<typeof connectAgentMuxRpc>> | undefined
  try {
    await server.start(); rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
    const report = await rpc.call('system.doctor', {})
    expect(report.hosts.remote.status).toBe('not-checked')
    expect(report.hosts.local.status).toBe('available')
    expect(report.agents).toMatchObject([{ id: 'codex', probe: 'missing', action: expect.stringContaining('codex') }])
    expect(prepare).toHaveBeenCalledTimes(1); expect(availability).not.toHaveBeenCalled()
    prepare.mockClear()
    const cli = await promisify(execFile)(process.execPath, [resolve('packages/core/bin/amux'), '--endpoint', 'unix:' + server.path, 'system', 'doctor'],
      { timeout: 10000, env: { ...process.env, AGENTMUX_AGENT_SESSION_ID: undefined, AGENTMUX_AGENT_CAPABILITY: undefined } })
    expect(JSON.parse(cli.stdout).result).toMatchObject({ hosts: report.hosts, agents: report.agents })
    expect(prepare).toHaveBeenCalledTimes(1); expect(availability).not.toHaveBeenCalled()
  } finally { await rpc?.dispose(); await server.stop(); await f.close() }
})
