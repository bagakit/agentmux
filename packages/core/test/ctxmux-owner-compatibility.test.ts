import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CtxmuxClient, PROTOCOL_VERSION, type RuntimeIdentity } from '@ctxmux/sdk'
import { CtxmuxRunAdapter } from '../src/ctxmux-run-adapter.js'
import { AgentMuxClient } from '../src/client.js'

const processSpies = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(), spawn: processSpies.spawn
}))

const runtime: RuntimeIdentity = {
  daemonInstanceId: '11111111-1111-4111-8111-111111111111', runtimeId: '22222222-2222-4222-8222-222222222222', runtimeIdPersistence: 'state_dir',
  buildId: 'ctxmuxd/0.1.0', protocolGeneration: PROTOCOL_VERSION, platform: 'macos', arch: 'aarch64',
  capabilities: {
    'native.start': 1, 'native.recoverable_input': 1, 'native.recoverable_stop': 1,
    'services.persistent_state': 1, 'services.planned_exec_upgrade_continuity': 1
  }
}
const directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); processSpies.spawn.mockReset()
  await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true })))
})
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'amx-ownership-'))
  directories.push(directory)
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', directory)
  vi.spyOn(CtxmuxClient.prototype, 'runtimeInfo').mockResolvedValue(structuredClone(runtime))
  vi.spyOn(CtxmuxClient.prototype, 'list').mockResolvedValue([])
  return { directory, adapter: new CtxmuxRunAdapter() }
}

describe('Runtime compatibility independent of launch provenance', () => {
  it.each(['missing', 'malformed', 'mismatch'] as const)('connects to the same compatible Runtime with a %s receipt without rewriting or stopping it', async (kind) => {
    const { directory, adapter } = await fixture()
    const receipt = join(directory, 'owner.json')
    if (kind !== 'missing') await writeFile(receipt, kind === 'malformed' ? '{broken' : '{}', { mode: 0o600 })
    const before = await readFile(receipt, 'utf8').catch(() => null)
    const client = new AgentMuxClient()
    Object.assign(client, { kernel: adapter })
    try {
      await expect(adapter.connect()).resolves.toBeUndefined()
      expect(await adapter.list()).toEqual([])
      expect(client.runtimeIdentity()).toMatchObject({ instanceId: '11111111-1111-4111-8111-111111111111', ownership: 'unverified' })
      adapter.disconnect()
      await expect(adapter.connect()).resolves.toBeUndefined()
      expect(client.runtimeIdentity()).toMatchObject({ instanceId: '11111111-1111-4111-8111-111111111111', ownership: 'unverified' })
      expect(processSpies.spawn).not.toHaveBeenCalled()
      expect(await readFile(receipt, 'utf8').catch(() => null)).toBe(before)
    } finally { await client.dispose() }
  })

  it.each([
    { protocolGeneration: PROTOCOL_VERSION + 1 },
    { buildId: 'ctxmuxd/incompatible' },
    { capabilities: {} },
    { runtimeIdPersistence: 'ephemeral' }
  ])('rejects incompatible public Runtime identity without spawning a replacement: %j', async (change) => {
    const { adapter } = await fixture()
    vi.mocked(CtxmuxClient.prototype.runtimeInfo).mockResolvedValue({ ...runtime, ...change } as RuntimeIdentity)
    await expect(adapter.connect()).rejects.toThrow('does not satisfy the pinned Local contract')
    expect(adapter.isConnected()).toBe(false)
    expect(processSpies.spawn).not.toHaveBeenCalled()
  })

  it('keeps a valid persistent launch record across app restarts and install relocation', async () => {
    const { directory, adapter } = await fixture()
    const manifestBytes = await readFile(new URL('../vendor/ctxmux/darwin-arm64/manifest.json', import.meta.url))
    const manifest = JSON.parse(manifestBytes.toString())
    const { createHash } = await import('node:crypto')
    await writeFile(join(directory, 'owner.json'), JSON.stringify({
      schema: 'agentmux.ctxmux-owner.v1', sourceCommit: manifest.source.commit, sourceTree: manifest.source.tree,
      manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
      daemonSha256: manifest.binaries.find((b: { name: string }) => b.name === 'ctxmuxd').sha256,
      daemonPath: '/previous/installation/ctxmuxd', socketPath: adapter.socketPath, stateDirectory: adapter.stateDirectory,
      daemonInstanceId: runtime.daemonInstanceId, runtimeId: runtime.runtimeId, runtimeBuildId: runtime.buildId
    }), { mode: 0o600 })
    try {
      await expect(adapter.connect()).resolves.toBeUndefined()
      expect(adapter.runtimeOwnership).toBe('owned')
      adapter.disconnect()
      const restarted = new CtxmuxRunAdapter()
      try {
        await expect(restarted.connect()).resolves.toBeUndefined()
        expect(restarted.runtimeOwnership).toBe('owned')
        expect(restarted.identity().daemonInstanceId).toBe(runtime.daemonInstanceId)
      } finally { restarted.disconnect() }
      expect(processSpies.spawn).not.toHaveBeenCalled()
    } finally { adapter.disconnect() }
  })
})
