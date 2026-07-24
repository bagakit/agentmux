import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentMuxAgentSessionStore, AgentMuxWorkspaceView } from '@agentmux/core'
import type { WebContents } from 'electron'
import type { AppConfig, SessionControl, SshHostConfig } from '../src/shared/contracts.js'

const runtimeFixture = vi.hoisted(() => {
  const createdHosts: Array<{ id: string; dispose: ReturnType<typeof vi.fn> }> = []

  class FakeClient {
    static instances: FakeClient[] = []
    static failNextConnect = false
    readonly connect = vi.fn(async () => {
      if (FakeClient.failNextConnect) {
        FakeClient.failNextConnect = false
        throw new Error('Runtime discovery failed')
      }
    })
    readonly dispose = vi.fn(async () => {})
    readonly onEvent = vi.fn(() => () => {})
    readonly listRuns = vi.fn(async (): Promise<Array<{
      runId: string
      acceptedInputBytes: number
    }>> => [])
    readonly attachTerminal = vi.fn(async (runId: string) => ({
      run: {
        runId,
        kind: 'terminal' as const,
        agentId: null,
        agentSessionId: null,
        workspacePath: '/repo',
        pid: 42,
        state: 'running' as const,
        cols: 80,
        rows: 24,
        observedAt: 1,
        latestOutputBytes: 12,
        acceptedInputBytes: 4
      },
      replay: [],
      gap: null
    }))
    readonly readRunReplay = vi.fn(async (run: { runId: string }) => ({
      run: {
        runId: run.runId,
        kind: 'terminal' as const,
        agentId: null,
        agentSessionId: null,
        workspacePath: '/repo',
        pid: 42,
        state: 'running' as const,
        cols: 80,
        rows: 24,
        observedAt: 1,
        latestOutputBytes: 12,
        acceptedInputBytes: 4
      },
      replay: [],
      gap: null
    }))
    readonly releaseRunAttachment = vi.fn(async () => {})
    readonly reattachAgent = vi.fn(async () => {
      throw new Error('Agent attachment fixture is not configured')
    })
    readonly writeTerminal = vi.fn(async (
      ref: { runId: string },
      operation: {
        ownerInstanceId: string
        operationId: string
        expectedByte: number
        data: string
      }
    ) => ({
      runId: ref.runId,
      appliedByteRange: {
        startByte: operation.expectedByte,
        endByte: operation.expectedByte + Buffer.byteLength(operation.data)
      },
      acceptedThroughByte: operation.expectedByte + Buffer.byteLength(operation.data)
    }))
    readonly workspaceView = vi.fn(async (): Promise<AgentMuxWorkspaceView> => ({ hostId: 'fixture', views: [] }))
    readonly runtimeIdentity = vi.fn(() => ({
      protocolVersion: 5,
      buildIdentity: '0.1.0',
      hostId: 'fixture',
      processId: 1,
      instanceId: 'runtime-1'
    }))

    constructor() {
      FakeClient.instances.push(this)
    }
  }

  return {
    FakeClient,
    createdHosts,
    connectClient: vi.fn(async () => {
      const client = new FakeClient()
      await client.connect()
      return client
    })
  }
})

vi.mock('@agentmux/core', () => ({
  AgentMuxClient: runtimeFixture.FakeClient,
  AgentMuxMemoryAgentSessionStore: class {},
  connectLocalAgentMux: runtimeFixture.connectClient,
  connectSshAgentMux: runtimeFixture.connectClient
}))
vi.mock('../src/main/host-factory.js', () => ({
  createExecutionHost: vi.fn((host: { id: string }) => {
    const created = { id: host.id, dispose: vi.fn(async () => {}) }
    runtimeFixture.createdHosts.push(created)
    return created
  })
}))

import { RuntimeController } from '../src/main/runtime-controller.js'

const store: AgentMuxAgentSessionStore = {
  async load() { return [] },
  async loadRetiredRuns() { return [] },
  async compareAndSwap() {},
  async reserveLifecycle() {},
  async claimStaleLifecycles() { return [] },
  async releaseLifecycle() {},
  async retireRuns() {},
  async commitLifecycle() {}
}

const localConfig: AppConfig = {
  version: 3,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  agents: {},
  workspaces: []
}

const remoteHost: SshHostConfig = {
  id: 'remote',
  kind: 'ssh',
  label: 'Build box',
  hostname: 'build.example.test'
}

async function configuredController(): Promise<RuntimeController> {
  const controller = new RuntimeController(store)
  controller.commit(await controller.prepare(localConfig))
  return controller
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

function webContentsFixture(id = 17): WebContents & EventEmitter {
  return Object.assign(new EventEmitter(), {
    id,
    isDestroyed: () => false,
    send: vi.fn()
  }) as unknown as WebContents & EventEmitter
}

describe('RuntimeController configuration transaction', () => {
  beforeEach(() => {
    runtimeFixture.FakeClient.instances.length = 0
    runtimeFixture.FakeClient.failNextConnect = false
    runtimeFixture.createdHosts.length = 0
    vi.clearAllMocks()
  })

  it('connects a changed host before committing its host capabilities', async () => {
    const controller = await configuredController()
    const next = { ...localConfig, hosts: [...localConfig.hosts, remoteHost] }

    const preparation = await controller.prepare(next)
    expect(runtimeFixture.FakeClient.instances[1]?.connect).toHaveBeenCalledOnce()
    expect(() => controller.executionHost('remote')).toThrow('not configured')

    controller.commit(preparation)
    expect(controller.executionHost('remote')).toMatchObject({ id: 'remote' })
  })

  it('does not advance host truth when Runtime discovery fails and retries the same config', async () => {
    const controller = await configuredController()
    const next = { ...localConfig, hosts: [...localConfig.hosts, remoteHost] }
    runtimeFixture.FakeClient.failNextConnect = true

    await expect(controller.prepare(next)).rejects.toThrow('Runtime discovery failed')
    expect(() => controller.executionHost('remote')).toThrow('not configured')
    expect(runtimeFixture.createdHosts.at(-1)?.dispose).toHaveBeenCalledOnce()

    const retry = await controller.prepare(next)
    controller.commit(retry)
    expect(controller.executionHost('remote')).toMatchObject({ id: 'remote' })
  })

  it('fences launches between changed-host preparation and commit', async () => {
    const controller = await configuredController()
    const next: AppConfig = {
      ...localConfig,
      hosts: [{ ...localConfig.hosts[0]!, label: 'Renamed Mac' }]
    }

    const preparation = await controller.prepare(next)
    await expect(controller.launchTerminal({
      hostId: 'local',
      workspacePath: '/repo'
    }, next)).rejects.toThrow('being reconfigured')

    controller.commit(preparation)
  })

  it('serializes terminal Input with one retained owner and advancing byte boundaries', async () => {
    const controller = await configuredController()
    const client = runtimeFixture.FakeClient.instances[0]!
    client.listRuns.mockResolvedValue([{
      runId: 'run-1',
      acceptedInputBytes: 4
    }])
    const control: SessionControl = {
      kind: 'terminal',
      hostId: 'local',
      runId: 'run-1',
      run: { runId: 'run-1' }
    }

    await Promise.all([
      controller.write(control, 'A'),
      controller.write(control, '😀')
    ])

    expect(client.writeTerminal.mock.calls.map(([, operation]) => ({
      ownerInstanceId: operation.ownerInstanceId,
      expectedByte: operation.expectedByte,
      data: operation.data
    }))).toEqual([
      { ownerInstanceId: 'runtime-1', expectedByte: 4, data: 'A' },
      { ownerInstanceId: 'runtime-1', expectedByte: 5, data: '😀' }
    ])
    expect(client.writeTerminal.mock.calls[0]?.[1].operationId).not.toBe(
      client.writeTerminal.mock.calls[1]?.[1].operationId
    )
  })

  it('shares one retained Run Attachment across concurrent Desktop View leases', async () => {
    const controller = await configuredController()
    const client = runtimeFixture.FakeClient.instances[0]!
    const renderer = webContentsFixture()
    const detachRenderer = controller.attach(renderer)
    client.workspaceView.mockResolvedValue({
      hostId: 'local',
      views: [{
        viewId: 'terminal-view:local:run-1',
        kind: 'terminal',
        hostId: 'local',
        workspacePath: '/repo',
        run: {
          runId: 'run-1',
          kind: 'terminal',
          agentId: null,
          agentSessionId: null,
          workspacePath: '/repo',
          pid: 42,
          state: 'running',
          cols: 80,
          rows: 24,
          observedAt: 1,
          latestOutputBytes: 12,
          acceptedInputBytes: 4
        }
      }]
    })
    const control: SessionControl = {
      kind: 'terminal',
      hostId: 'local',
      runId: 'run-1',
      run: { runId: 'run-1' }
    }

    const [first, second] = await Promise.all([
      controller.attachSession(renderer.id, control, 0, localConfig),
      controller.attachSession(renderer.id, control, 8, localConfig)
    ])

    expect(first.attachmentId).not.toBe(second.attachmentId)
    expect(client.attachTerminal).toHaveBeenCalledOnce()
    expect(client.readRunReplay).toHaveBeenCalledWith(control.run, 8)

    await controller.detachSession(renderer.id, first.attachmentId)
    expect(client.releaseRunAttachment).not.toHaveBeenCalled()
    client.releaseRunAttachment.mockRejectedValueOnce(new Error('release interrupted'))
    await expect(controller.detachSession(renderer.id, second.attachmentId)).rejects.toThrow('release interrupted')
    await controller.detachSession(renderer.id, second.attachmentId)
    expect(client.releaseRunAttachment).toHaveBeenCalledTimes(2)
    expect(client.releaseRunAttachment).toHaveBeenCalledWith(expect.objectContaining(control.run))
    detachRenderer()
  })

  it('rolls back an in-flight attach when its Renderer generation disappears', async () => {
    const controller = await configuredController()
    const client = runtimeFixture.FakeClient.instances[0]!
    const renderer = webContentsFixture()
    const detachRenderer = controller.attach(renderer)
    const control: SessionControl = {
      kind: 'terminal',
      hostId: 'local',
      runId: 'run-1',
      run: { runId: 'run-1' }
    }
    client.workspaceView.mockResolvedValue({
      hostId: 'local',
      views: [{
        viewId: 'terminal-view:local:run-1',
        kind: 'terminal',
        hostId: 'local',
        workspacePath: '/repo',
        run: {
          runId: 'run-1', kind: 'terminal', agentId: null, agentSessionId: null,
          workspacePath: '/repo', pid: 42, state: 'running', cols: 80, rows: 24,
          observedAt: 1, latestOutputBytes: 12, acceptedInputBytes: 4
        }
      }]
    })
    const pending = deferred<Awaited<ReturnType<typeof client.attachTerminal>>>()
    client.attachTerminal.mockImplementationOnce(async () => await pending.promise)

    const attaching = controller.attachSession(renderer.id, control, 0, localConfig)
    renderer.emit('render-process-gone')
    pending.resolve({
      run: {
        runId: 'run-1', kind: 'terminal', agentId: null, agentSessionId: null,
        workspacePath: '/repo', pid: 42, state: 'running', cols: 80, rows: 24,
        observedAt: 1, latestOutputBytes: 12, acceptedInputBytes: 4
      },
      replay: [],
      gap: null
    })

    await expect(attaching).rejects.toThrow('Renderer changed')
    expect(client.releaseRunAttachment).toHaveBeenCalledWith(expect.objectContaining(control.run))
    detachRenderer()
  })

  it('releases the actual attached Run when Agent control is stale after resume', async () => {
    const controller = await configuredController()
    const client = runtimeFixture.FakeClient.instances[0]!
    const control: SessionControl = {
      kind: 'agent',
      hostId: 'local',
      agentSessionId: 'agent-1',
      run: { runId: 'old-run' }
    }
    client.reattachAgent.mockResolvedValueOnce({
      session: { agentSessionId: 'agent-1' },
      attachment: {
        run: {
          runId: 'new-run', kind: 'agent', agentId: 'codex', agentSessionId: 'agent-1',
          workspacePath: '/repo', pid: 42, state: 'running', cols: 80, rows: 24,
          observedAt: 1, latestOutputBytes: 12, acceptedInputBytes: 4
        },
        replay: [],
        gap: null
      }
    })

    await expect(controller.attachSession(17, control, 0, localConfig)).rejects.toThrow(
      'exact Run Attachment'
    )
    expect(client.releaseRunAttachment).toHaveBeenCalledWith(expect.objectContaining({ runId: 'new-run' }))
  })
})
