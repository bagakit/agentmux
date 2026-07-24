import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppConfig } from '../src/shared/contracts.js'

const runtimeFixture = vi.hoisted(() => {
  const createdHosts: Array<{ id: string; dispose: ReturnType<typeof vi.fn> }> = []

  class FakeRuntime {
    static instances: FakeRuntime[] = []
    readonly start = vi.fn(async () => {})
    readonly onEvent = vi.fn(() => () => {})
    readonly snapshot = vi.fn(() => ({ sessions: [], activities: {} }))
    readonly dispose = vi.fn(async () => {})
    readonly prepareHost = vi.fn(async (host: { id: string }) => ({ host, sessions: [] }))
    readonly commitHost = vi.fn(() => undefined)
    readonly removeHost = vi.fn(() => undefined)

    constructor() {
      FakeRuntime.instances.push(this)
    }
  }

  return { FakeRuntime, createdHosts }
})

vi.mock('@agentmux/core', () => ({ AgentMuxRuntime: runtimeFixture.FakeRuntime }))
vi.mock('../src/main/host-factory.js', () => ({
  createExecutionHost: vi.fn((host: { id: string }) => {
    const created = { id: host.id, dispose: vi.fn(async () => {}) }
    runtimeFixture.createdHosts.push(created)
    return created
  })
}))

import { RuntimeController } from '../src/main/runtime-controller.js'

const localConfig: AppConfig = {
  version: 1,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  agents: {},
  workspaces: []
}

async function configuredController(): Promise<{ controller: RuntimeController; runtime: InstanceType<typeof runtimeFixture.FakeRuntime> }> {
  const controller = new RuntimeController()
  controller.commit(await controller.prepare(localConfig))
  return { controller, runtime: runtimeFixture.FakeRuntime.instances[0]! }
}

describe('RuntimeController configuration transaction', () => {
  beforeEach(() => {
    runtimeFixture.FakeRuntime.instances.length = 0
    runtimeFixture.createdHosts.length = 0
    vi.clearAllMocks()
  })

  it('discovers a changed host before committing it to the active Runtime', async () => {
    const { controller, runtime } = await configuredController()
    const next = {
      ...localConfig,
      hosts: [
        ...localConfig.hosts,
        { id: 'remote', kind: 'ssh' as const, label: 'Build box', hostname: 'build.example.test' }
      ]
    }

    const preparation = await controller.prepare(next)
    expect(runtime.prepareHost).toHaveBeenCalledWith(expect.objectContaining({ id: 'remote' }))
    expect(runtime.commitHost).not.toHaveBeenCalled()

    controller.commit(preparation)
    expect(runtime.commitHost).toHaveBeenCalledWith(expect.objectContaining({
      host: expect.objectContaining({ id: 'remote' })
    }))
  })

  it('does not advance host truth when discovery fails and retries the same config', async () => {
    const { controller, runtime } = await configuredController()
    const next = {
      ...localConfig,
      hosts: [
        ...localConfig.hosts,
        { id: 'remote', kind: 'ssh' as const, label: 'Build box', hostname: 'build.example.test' }
      ]
    }
    runtime.prepareHost.mockRejectedValueOnce(new Error('discovery failed'))

    await expect(controller.prepare(next)).rejects.toThrow('discovery failed')
    expect(runtime.commitHost).not.toHaveBeenCalled()
    expect(runtimeFixture.createdHosts.at(-1)?.dispose).toHaveBeenCalledOnce()

    const retry = await controller.prepare(next)
    expect(runtime.prepareHost).toHaveBeenCalledTimes(2)
    controller.commit(retry)
    expect(runtime.commitHost).toHaveBeenCalledOnce()
  })
})
