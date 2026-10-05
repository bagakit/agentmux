import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { AgentMuxError, AgentMuxHostExecutorOwner, AgentProviderRegistry } from '@agentmux/core'
import { RuntimeController } from '../src/main/runtime-controller.js'
import type { DesktopRuntimeClient } from '../src/main/desktop-host.js'
import type { AppConfig, HostConfig } from '../src/shared/contracts.js'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'

vi.mock('../src/main/host-factory.js', () => ({
  createExecutionHost: (host: HostConfig) => ({ id: host.id, kind: host.kind, dispose: async () => {} })
}))
vi.mock('electron', () => ({ app: {}, nativeImage: {} }))

const cleanups: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks() })

it('the actual Main settings consumer uses the target registry without opening Session observation or borrowing local configuration', async () => {
  const f = await rpcOwnerFixture(); cleanups.push(f.close)
  const bin = join(f.root, 'bin'); await mkdir(bin)
  const command = join(bin, 'claude'); await writeFile(command, '#!/bin/sh\nexit 0\n'); await chmod(command, 0o755)
  Object.assign(f.client, { hostExecutorOwner: new AgentMuxHostExecutorOwner({ path: join(f.root, 'executors.json'), runtimeId: 'target-runtime',
    catalog: () => new AgentProviderRegistry().catalog().filter(p => p.id === 'claude'), environment: () => ({ PATH: bin }) }) })
  const connect = vi.spyOn(f.client, 'connect').mockRejectedValue(new AgentMuxError('Session observation is unavailable', 'RUNTIME_UNAVAILABLE'))
  const controller = new RuntimeController(f.store, async () => f.client as unknown as DesktopRuntimeClient)
  cleanups.push(() => controller.dispose())
  const config = { version: 9, hosts: [{ id: 'remote', kind: 'ssh', label: 'Target', hostname: 'target.invalid' }],
    executors: { claude: { label: 'Local', providerId: 'codex', command: _hygiene_fixturePath("local/codex"), args: [], env: { LOCAL_SECRET: 'local-secret' }, injectAgentMuxGuide: false } },
    workspaces: [], appearance: { terminalTheme: 'graphite' }, browser: {} } as unknown as AppConfig
  controller.commit(await controller.prepare(config))
  expect(await controller.discoverExecutors('remote')).toMatchObject({ routeHostId: 'remote', runtimeId: 'target-runtime', executors: [
    expect.objectContaining({ executorId: 'claude', providerId: 'claude', executable: command, availability: 'available' })
  ] })
  const saved = await controller.configureExecutor('remote', { executorId: 'wrapper', config: {
    label: 'Target wrapper', providerId: 'claude', command, args: [], env: { REMOTE_SECRET: 'remote-secret' }, injectAgentMuxGuide: false
  } })
  expect(saved).toMatchObject({ routeHostId: 'remote', runtimeId: 'target-runtime', executor: { executorId: 'wrapper', command } })
  expect(JSON.stringify(saved)).not.toMatch(/local-secret|remote-secret|"env"/)
  expect(connect).not.toHaveBeenCalled()
  await expect(controller.discoverExecutors('unconfigured')).rejects.toMatchObject({ code: 'UNKNOWN_HOST' })
  const failure = new AgentMuxError('The original authenticated control transport is unavailable', 'CONTROL_UNAVAILABLE')
  vi.spyOn(f.client, 'listHostExecutors').mockRejectedValueOnce(failure)
  await expect(controller.discoverExecutors('remote')).rejects.toBe(failure)
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  expect(await f.client.readAgentSessions()).toHaveLength(2)
})
