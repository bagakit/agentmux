import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppConfig } from '../src/shared/contracts.js'

const runtimeFixture = vi.hoisted(() => {
  class FakeRuntime {
    static instances: FakeRuntime[] = []
    readonly discover = vi.fn(async () => [])
    readonly start = vi.fn(async () => {})
    readonly onEvent = vi.fn(() => () => {})
    readonly snapshot = vi.fn(() => ({ sessions: [], activities: {} }))
    readonly dispose = vi.fn(async () => {})
    readonly hosts = {
      replace: vi.fn(async () => {}),
      remove: vi.fn(async () => {})
    }

    constructor() {
      FakeRuntime.instances.push(this)
    }
  }

  return { FakeRuntime }
})

vi.mock('@agentmux/core', () => ({ AgentMuxRuntime: runtimeFixture.FakeRuntime }))
vi.mock('../src/main/host-factory.js', () => ({
  createExecutionHost: vi.fn((host: { id: string }) => ({ id: host.id }))
}))

import { RuntimeController } from '../src/main/runtime-controller.js'

const localConfig: AppConfig = {
  version: 1,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  agents: {},
  workspaces: []
}

describe('RuntimeController host discovery', () => {
  beforeEach(() => {
    runtimeFixture.FakeRuntime.instances.length = 0
    vi.clearAllMocks()
  })

  it('discovers sessions after a host is added or replaced at runtime', async () => {
    const controller = new RuntimeController()
    await controller.configure(localConfig)
    const runtime = runtimeFixture.FakeRuntime.instances[0]!

    await controller.configure({
      ...localConfig,
      hosts: [
        ...localConfig.hosts,
        { id: 'remote', kind: 'ssh', label: 'Build box', hostname: 'build.example.test' }
      ]
    })
    expect(runtime.hosts.replace).toHaveBeenCalledWith({ id: 'remote' })
    expect(runtime.discover).toHaveBeenLastCalledWith('remote')

    await controller.configure({
      ...localConfig,
      hosts: [
        ...localConfig.hosts,
        { id: 'remote', kind: 'ssh', label: 'Renamed box', hostname: 'build.example.test' }
      ]
    })
    expect(runtime.discover).toHaveBeenCalledTimes(2)
    expect(runtime.discover).toHaveBeenLastCalledWith('remote')
  })
})
