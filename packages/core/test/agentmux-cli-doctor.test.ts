import { fixturePath } from './helpers/fixture-values.js'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import { AgentManagedHookInstaller } from '../src/managed-hook-installer.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import type { AgentMuxRuntimeDiagnostics } from '../src/types.js'

let root = ''
let client: AgentMuxClient | undefined
let owner: AgentMuxControlServer | undefined
const runtime: AgentMuxRuntimeDiagnostics = { nodeVersion: '24.0.0', platform: 'darwin', arch: 'arm64', supported: true,
  ctxmux: { state: { configuredDirectory: fixturePath('fixture/future'), servingDirectory: null }, serving: { buildIdentity: 'fixture', protocolVersion: 17, instanceId: 'fixture', sourceCommit: null }, bundled: { version: '0.1.0', sourceCommit: 'c168c0ab9cd849bfade68461b62684982c71f688', artifactPlatform: 'darwin-arm64' }, ready: true,
    capabilities: { transport: 'local-unix', orderedOutputBytes: true, boundedReplay: true, recoverableInput: true, resize: true, interrupt: true, completeStop: true } } }
afterEach(async () => {
  try { await owner?.stop() }
  finally {
    try { await client?.dispose() }
    finally {
      owner = undefined; client = undefined
      vi.restoreAllMocks(); vi.unstubAllEnvs()
      if (root) await rm(root, { recursive: true, force: true })
    }
  }
})

describe('actual doctor CLI body to public Core inspection', () => {
  it('emits the pre-connect scoped result through the real CLI and public Core owner', async () => {
    root = await mkdtemp(join(tmpdir(), 'amx-cli-doctor-'))
    vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(root, 'state'))
    const provider = new AgentProviderRegistry().get('claude')
    const installer = new AgentManagedHookInstaller(join(root, 'receipts'))
    client = new AgentMuxClient({ providers: [provider], hookInstaller: installer, store: new AgentMuxMemoryAgentSessionStore() })
    const resolved = provider.planManagedHooks!({ workspacePath: root, env: {} })!
    await mkdir(dirname(resolved.mutations[0]!.path), { recursive: true })
    await writeFile(resolved.mutations[0]!.path, '{"secret":"never-report"}')
    const before = await readFile(resolved.mutations[0]!.path, 'utf8')
    const connect = vi.spyOn(client, 'connect').mockImplementation(async () => { await installer.ensure(resolved) })
    vi.spyOn(client, 'runtimeIdentity').mockReturnValue({ hostId: 'local', buildIdentity: 'fixture', protocolVersion: 17, instanceId: 'fixture', processId: null })
    vi.spyOn(client, 'runtimeDiagnostics').mockResolvedValue(runtime)
    vi.spyOn(client, 'probeAgent').mockResolvedValue({ providerId: provider.id, executable: provider.executable, installed: true, capabilities: provider.catalog.capabilities })
    vi.spyOn(client, 'probeExecutorAvailability').mockResolvedValue({ executable: 'claude', availability: 'available' })
    const dispose = vi.spyOn(client, 'dispose'), inspect = vi.spyOn(client, 'inspectManagedHooks')
    const socket = join(root, 'public.sock')
    owner = new AgentMuxControlServer({ socketPath: socket, coreClients: () => [{ hostId: 'local', client: client! }] })
    await owner.start()
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENTMUX_|CTXMUX_|CLAUDE_|CODEX_)/u.test(key)))
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [resolve('packages/core/bin/amux'), '--endpoint', `unix:${socket}`,
      'system', 'doctor', '--workspace', root], { env: { ...env, HOME: root, CLAUDE_CONFIG_DIR: join(root, 'claude'), AGENTMUX_STATE_DIRECTORY: join(root, 'state') } })
    const lines = stdout.trim().split('\n')
    expect(lines).toHaveLength(1)
    const message = JSON.parse(lines[0]!)
    expect(message).toMatchObject({ ok: true, operation: 'system.doctor', result: { ok: true,
      agents: [{ id: 'claude', hookInstallation: { status: 'partial', phase: 'pre-connect', workspacePath: root } }] } })
    expect(message.result.agents[0].hookInstallation.targets).toEqual(resolved.mutations.map((mutation, index) => ({
      path: mutation.path, status: index === 0 ? 'partial' : 'not_present' })))
    expect(inspect.mock.calls).toEqual([['claude', { workspacePath: root }]])
    expect(inspect.mock.invocationCallOrder[0]).toBeLessThan(connect.mock.invocationCallOrder[0]!)
    expect(connect).toHaveBeenCalledOnce()
    // The CLI owns its reader connection; the serving Core remains available after that reader exits.
    expect(dispose).not.toHaveBeenCalled()
    expect(stdout + stderr).not.toContain('never-report')
    expect(await readFile(resolved.mutations[0]!.path, 'utf8')).not.toBe(before)
  })
})
