import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentMuxAgentContinuityResult,
  AgentMuxAgentSessionStore,
  AgentMuxRuntimeProjection
} from '@agentmux/core'
import type { WebContents } from 'electron'
import type { AppConfig, SessionControl, SshHostConfig } from '../src/shared/contracts.js'
import { SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics.js'

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
    eventListener: ((event: unknown) => void) | null = null
    readonly onEvent = vi.fn((listener: (event: unknown) => void) => {
      this.eventListener = listener
      return () => {
        if (this.eventListener === listener) this.eventListener = null
      }
    })
    readonly listRuns = vi.fn(async (): Promise<Array<{
      runId: string
      acceptedInputBytes: number
    }>> => [])
    readonly attachTerminal = vi.fn(async (runId: string) => ({
      run: {
        runId,
        kind: 'terminal' as const,
        providerId: null,
        executorId: null,
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
        providerId: null,
        executorId: null,
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
    readonly writeAgent = vi.fn(async (_agentSessionId: string, data: string) => ({
      runId: 'agent-run',
      appliedByteRange: { startByte: 0, endByte: Buffer.byteLength(data) },
      acceptedThroughByte: Buffer.byteLength(data)
    }))
    readonly createAgent = vi.fn(async () => {
      throw new Error('Agent launch fixture stopped after input capture')
    })
    readonly stopAgent = vi.fn(async () => {})
    readonly stopTerminal = vi.fn(async () => {})
    readonly resizeAgent = vi.fn(async () => ({ runId: 'agent-run', cols: 80, rows: 24 }))
    readonly resizeTerminal = vi.fn(async (run: { runId: string }, cols: number, rows: number) => ({
      runId: run.runId,
      cols,
      rows
    }))
    readonly statusAgent = vi.fn()
    readonly agentSession = vi.fn(() => ({
      kind: 'agent' as const,
      agentSessionId: 'agent-1',
      providerId: 'codex',
      executorId: 'review',
      hostId: 'local',
      workspacePath: '/repo',
      run: { runId: 'run-1' },
      retiredRuns: [],
      outputCursorBytes: 0,
      createdAt: 1,
      updatedAt: 2
    }))
    readonly agentSessions = vi.fn(() => [])
    readonly submitAgentPrompt = vi.fn(async () => {})
    readonly resumeAgent = vi.fn(async () => {})
    readonly ensureAgentContinuity = vi.fn(async (): Promise<AgentMuxAgentContinuityResult> => {
      throw new Error('Agent continuity fixture is not configured')
    })
    readonly sessionTimeline = vi.fn(async (agentSessionId: string) => ({
      agentSessionId,
      revision: 0,
      items: []
    }))
    readonly providers = {
      catalog: vi.fn(() => []),
      get: vi.fn(() => ({
        catalog: {
          capabilities: {
            terminal: true as const,
            hookEvents: true,
            timeline: 'complete-events' as const,
            permission: 'observe' as const,
            providerResume: true,
            acp: false,
            replyCorrelation: 'none' as const
          }
        }
      }))
    }
    readonly runtimeProjection = vi.fn(async (): Promise<AgentMuxRuntimeProjection> => ({ hostId: 'fixture', subjects: [] }))
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
  async loadRetiredAgentSessions() { return [] },
  async compareAndSwap() {},
  async reserveLifecycle() {},
  async claimStaleLifecycles() { return [] },
  async releaseLifecycle() {},
  async retireRuns() {},
  async commitLifecycle() {},
  async loadTimeline(agentSessionId: string) { return { agentSessionId, revision: 0, items: [] } },
  async applyTimelineMutation(mutation: { agentSessionId: string }) {
    return { agentSessionId: mutation.agentSessionId, revision: 1, changed: true, mutation }
  },
}

const localConfig: AppConfig = {
  version: 7,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: {},
  workspaces: [],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, more: true } }
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

function agentStatusFixture() {
  const run = {
    runId: 'run-1',
    kind: 'agent' as const,
    providerId: 'codex',
    executorId: 'review',
    agentSessionId: 'agent-1',
    workspacePath: '/repo',
    pid: 42,
    state: 'exited' as const,
    cols: 80,
    rows: 24,
    observedAt: 2,
    latestOutputBytes: 12,
    acceptedInputBytes: 4,
    exitCode: 0
  }
  return {
    session: {
      kind: 'agent' as const,
      agentSessionId: 'agent-1',
      providerId: 'codex',
      executorId: 'review',
      hostId: 'local',
      workspacePath: '/repo',
      run: { runId: run.runId },
      retiredRuns: [],
      outputCursorBytes: 0,
      createdAt: 1,
      updatedAt: 2
    },
    run,
    capabilities: {
      terminal: true as const,
      hookEvents: true,
      timeline: 'complete-events' as const,
      permission: 'observe' as const,
      providerResume: true,
      acp: false,
      replyCorrelation: 'none' as const
    }
  }
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

  it.each([true, false])('passes the Executor guide setting and Provider identity to Core (%s)', async (injectAgentMuxGuide) => {
    const controller = await configuredController()
    const client = runtimeFixture.FakeClient.instances[0]!
    const config: AppConfig = {
      ...localConfig,
      executors: {
        'codex-review': { label: 'Codex review', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide }
      }
    }

    await expect(controller.launchAgent({
      executorId: 'codex-review',
      hostId: 'local',
      workspacePath: '/repo',
      prompt: 'Open Claude on the right.'
    }, config)).rejects.toThrow('stopped after input capture')

    expect(client.createAgent).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'codex',
      executorId: 'codex-review',
      injectAgentMuxGuide,
      prompt: 'Open Claude on the right.'
    }))
  })

  it('launches a Scratch Agent inside its filesystem Topic with wiki context', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-runtime-topic-'))
    try {
      const controller = await configuredController()
      const client = runtimeFixture.FakeClient.instances[0]!
      const config: AppConfig = {
        ...localConfig,
        executors: {
          codex: {
            label: 'Codex',
            providerId: 'codex',
            command: 'codex',
            args: [],
            env: { EXECUTOR_SETTING: 'kept' },
            injectAgentMuxGuide: true
          }
        },
        workspaces: [{
          id: SCRATCH_WORKSPACE_ID,
          name: 'Scratch',
          hostId: 'local',
          path: root,
          kind: 'folder'
        }]
      }

      await expect(controller.launchAgent({
        executorId: 'codex',
        hostId: 'local',
        workspacePath: root,
        scratchTopicId: 'view:shared-work',
        agentSessionId: 'agent-one',
        prompt: 'Ship the result'
      }, config)).rejects.toThrow('stopped after input capture')

      expect(client.createAgent).toHaveBeenCalledWith(expect.objectContaining({
        workspacePath: expect.stringMatching(/topic--view--shared-work$/),
        env: expect.objectContaining({
          EXECUTOR_SETTING: 'kept',
          AGENTMUX_WIKI_DIR: expect.stringMatching(/topic--view--shared-work$/)
        }),
        prompt: expect.stringContaining('Inspect .agents/')
      }))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('launches two Executors through one Provider with their own commands and arguments', async () => {
    const controller = await configuredController()
    const client = runtimeFixture.FakeClient.instances[0]!
    const config: AppConfig = {
      ...localConfig,
      executors: {
        review: {
          label: 'Review Codex',
          providerId: 'codex',
          command: '/opt/codex-review',
          args: ['--model', 'review'],
          env: { CODEX_PROFILE: 'review' },
          injectAgentMuxGuide: true
        },
        ship: {
          label: 'Ship Codex',
          providerId: 'codex',
          command: '/opt/codex-ship',
          args: ['--full-auto'],
          env: { CODEX_PROFILE: 'ship' },
          injectAgentMuxGuide: false
        }
      }
    }

    for (const executorId of ['review', 'ship']) {
      await expect(controller.launchAgent({
        executorId,
        hostId: 'local',
        workspacePath: '/repo'
      }, config)).rejects.toThrow('stopped after input capture')
    }

    expect(client.createAgent).toHaveBeenNthCalledWith(1, expect.objectContaining({
      executorId: 'review',
      providerId: 'codex',
      commandOverride: '/opt/codex-review',
      args: ['--model', 'review'],
      env: { CODEX_PROFILE: 'review' }
    }))
    expect(client.createAgent).toHaveBeenNthCalledWith(2, expect.objectContaining({
      executorId: 'ship',
      providerId: 'codex',
      commandOverride: '/opt/codex-ship',
      args: ['--full-auto'],
      env: { CODEX_PROFILE: 'ship' }
    }))
  })

  it('returns a Session and its revision baseline from one Agent launch result', async () => {
    const controller = await configuredController()
    const client = runtimeFixture.FakeClient.instances[0]!
    const status = agentStatusFixture()
    client.createAgent.mockResolvedValue(status.session)
    client.runtimeProjection.mockResolvedValue({
      hostId: 'local',
      subjects: [{
        subjectId: 'agent:local:agent-1',
        kind: 'agent',
        hostId: 'local',
        workspacePath: '/repo',
        providerId: status.session.providerId,
        executorId: status.session.executorId,
        agentSession: status.session,
        run: status.run
      }]
    })
    const timeline = {
      agentSessionId: status.session.agentSessionId,
      revision: 1,
      items: []
    }
    client.sessionTimeline.mockResolvedValue(timeline)
    const config: AppConfig = {
      ...localConfig,
      executors: {
        review: {
          label: 'Review Codex',
          providerId: 'codex',
          command: 'codex',
          args: [],
          env: {},
          injectAgentMuxGuide: true
        }
      }
    }

    await expect(controller.launchAgent({
      executorId: 'review',
      hostId: 'local',
      workspacePath: '/repo',
      agentSessionId: 'agent-1'
    }, config)).resolves.toMatchObject({
      session: { id: 'agent-1', kind: 'agent' },
      timeline
    })
    expect(client.stopAgent).not.toHaveBeenCalled()
  })

  it('stops a created Agent when its launch projection cannot produce the matching Timeline baseline', async () => {
    const controller = await configuredController()
    const client = runtimeFixture.FakeClient.instances[0]!
    const status = agentStatusFixture()
    client.createAgent.mockResolvedValue(status.session)
    client.runtimeProjection.mockResolvedValue({
      hostId: 'local',
      subjects: [{
        subjectId: 'agent:local:agent-1',
        kind: 'agent',
        hostId: 'local',
        workspacePath: '/repo',
        providerId: status.session.providerId,
        executorId: status.session.executorId,
        agentSession: status.session,
        run: status.run
      }]
    })
    client.sessionTimeline.mockResolvedValue({ agentSessionId: 'another-session', revision: 0, items: [] })
    const config: AppConfig = {
      ...localConfig,
      executors: {
        review: {
          label: 'Review Codex',
          providerId: 'codex',
          command: 'codex',
          args: [],
          env: {},
          injectAgentMuxGuide: true
        }
      }
    }

    await expect(controller.launchAgent({
      executorId: 'review',
      hostId: 'local',
      workspacePath: '/repo',
      agentSessionId: 'agent-1'
    }, config)).rejects.toThrow('Agent launch returned a Timeline for another Session')
    expect(client.stopAgent).toHaveBeenCalledWith('agent-1', { runId: 'run-1' })
  })

  it.each(['submitPrompt', 'recoverSession'] as const)(
    'fails %s closed when an existing Executor was rebound to another Provider',
    async (operation) => {
      const controller = await configuredController()
      const client = runtimeFixture.FakeClient.instances[0]!
      client.statusAgent.mockResolvedValue(agentStatusFixture())
      const config: AppConfig = {
        ...localConfig,
        executors: {
          review: {
            label: 'Claude review',
            providerId: 'claude',
            command: 'claude',
            args: ['--resume'],
            env: {},
            injectAgentMuxGuide: true
          }
        }
      }
      const control = {
        kind: 'agent' as const,
        hostId: 'local',
        agentSessionId: 'agent-1',
        run: { runId: 'run-1' }
      }

      const result = operation === 'submitPrompt'
        ? controller.submitPrompt(control, 'continue', config)
        : controller.recoverSession(control, config)

      await expect(result).rejects.toThrow(
        'Agent Executor review is bound to Provider claude, but this Session uses Provider codex'
      )
      expect(client.resumeAgent).not.toHaveBeenCalled()
      expect(client.submitAgentPrompt).not.toHaveBeenCalled()
    }
  )

  it('delegates Agent recovery to Core continuity without inventing a prompt', async () => {
    const controller = await configuredController()
    const client = runtimeFixture.FakeClient.instances[0]!
    const previous = agentStatusFixture()
    const config: AppConfig = {
      ...localConfig,
      executors: {
        review: {
          label: 'Review Codex',
          providerId: 'codex',
          command: 'codex',
          args: [],
          env: {},
          injectAgentMuxGuide: true
        }
      }
    }
    const resumedSession = {
      ...previous.session,
      run: { runId: 'run-2' },
      retiredRuns: [previous.session.run],
      updatedAt: 3
    }
    const { exitCode: _exitCode, ...previousRun } = previous.run
    const resumedRun = {
      ...previousRun,
      runId: 'run-2',
      state: 'running' as const,
      pid: 43,
      observedAt: 3
    }
    client.ensureAgentContinuity.mockResolvedValueOnce({
      kind: 'resumed',
      session: resumedSession,
      previousRun: previous.session.run,
      run: resumedSession.run,
      evidence: {
        kind: 'provider-native',
        providerId: 'codex',
        nativeSessionId: 'native-1',
        previousRun: { kind: 'run-ended', state: 'exited', observedAt: 2 }
      }
    })
    client.runtimeProjection.mockResolvedValueOnce({
      hostId: 'local',
      subjects: [{
        subjectId: 'agent:local:agent-1',
        kind: 'agent',
        hostId: 'local',
        workspacePath: '/repo',
        providerId: 'codex',
        executorId: 'review',
        agentSession: resumedSession,
        run: resumedRun
      }]
    })

    await expect(controller.recoverSession({
      kind: 'agent',
      hostId: 'local',
      agentSessionId: 'agent-1',
      run: { runId: 'run-1' }
    }, config)).resolves.toMatchObject({
      kind: 'resumed',
      session: { id: 'agent-1', control: { run: { runId: 'run-2' } } }
    })
    expect(client.ensureAgentContinuity).toHaveBeenCalledWith(expect.objectContaining({
      agentSessionId: 'agent-1',
      expectedRun: { runId: 'run-1' },
      commandOverride: 'codex'
    }))
    expect(client.ensureAgentContinuity.mock.calls[0]?.[0]).not.toHaveProperty('prompt')
    expect(client.statusAgent).not.toHaveBeenCalled()
    expect(client.resumeAgent).not.toHaveBeenCalled()
  })

  it('returns Core continuity unavailability without projecting a replacement Run', async () => {
    const controller = await configuredController()
    const client = runtimeFixture.FakeClient.instances[0]!
    const config: AppConfig = {
      ...localConfig,
      executors: {
        review: {
          label: 'Review Codex',
          providerId: 'codex',
          command: 'codex',
          args: [],
          env: {},
          injectAgentMuxGuide: true
        }
      }
    }
    client.ensureAgentContinuity.mockResolvedValueOnce({
      kind: 'unavailable',
      agentSessionId: 'agent-1',
      previousRun: { runId: 'run-1' },
      reason: 'native-handle-unavailable',
      evidence: { kind: 'run-missing', observedAt: 2 }
    })

    await expect(controller.recoverSession({
      kind: 'agent',
      hostId: 'local',
      agentSessionId: 'agent-1',
      run: { runId: 'run-1' }
    }, config)).resolves.toEqual({
      kind: 'unavailable',
      agentSessionId: 'agent-1',
      previousRun: { runId: 'run-1' },
      reason: 'native-handle-unavailable',
      evidence: { kind: 'run-missing', observedAt: 2 }
    })
    expect(client.runtimeProjection).not.toHaveBeenCalled()
    expect(client.resumeAgent).not.toHaveBeenCalled()
  })

  it('does not project a rebound Executor label onto a Session owned by another Provider', async () => {
    const controller = await configuredController()
    const client = runtimeFixture.FakeClient.instances[0]!
    const status = agentStatusFixture()
    client.runtimeProjection.mockResolvedValue({
      hostId: 'local',
      subjects: [{
        subjectId: 'agent:local:agent-1',
        kind: 'agent',
        hostId: 'local',
        workspacePath: '/repo',
        providerId: status.session.providerId,
        executorId: status.session.executorId,
        agentSession: status.session,
        run: status.run
      }]
    })
    const snapshot = await controller.snapshot({
      ...localConfig,
      executors: {
        review: {
          label: 'Claude review',
          providerId: 'claude',
          command: 'claude',
          args: [],
          env: {},
          injectAgentMuxGuide: true
        }
      },
      workspaces: [{ id: 'workspace', name: 'Repository', hostId: 'local', path: '/repo', kind: 'folder' }]
    })

    expect(snapshot.sessions[0]).toMatchObject({
      id: 'agent-1',
      providerId: 'codex',
      executorId: 'review',
      label: 'review · Repository'
    })
    expect(client.sessionTimeline).toHaveBeenCalledWith('agent-1')
  })

  it('projects a stored Agent with a missing Run only as an exact recovery candidate', async () => {
    const controller = await configuredController()
    const client = runtimeFixture.FakeClient.instances[0]!
    const stored = client.agentSession()
    client.agentSessions.mockReturnValue([stored])
    client.runtimeProjection.mockResolvedValue({ hostId: 'local', subjects: [] })

    await expect(controller.snapshot(localConfig)).resolves.toMatchObject({
      sessions: [],
      timelines: {},
      recoveryCandidates: [{
        agentSessionId: stored.agentSessionId,
        hostId: stored.hostId,
        workspacePath: stored.workspacePath,
        providerId: stored.providerId,
        executorId: stored.executorId,
        run: stored.run
      }]
    })
    expect(client.sessionTimeline).not.toHaveBeenCalled()
  })

  it('rejects a Runtime snapshot whose Timeline belongs to another Session', async () => {
    const controller = await configuredController()
    const client = runtimeFixture.FakeClient.instances[0]!
    const status = agentStatusFixture()
    client.runtimeProjection.mockResolvedValue({
      hostId: 'local',
      subjects: [{
        subjectId: 'agent:local:agent-1',
        kind: 'agent',
        hostId: 'local',
        workspacePath: '/repo',
        providerId: status.session.providerId,
        executorId: status.session.executorId,
        agentSession: status.session,
        run: status.run
      }]
    })
    client.sessionTimeline.mockResolvedValue({ agentSessionId: 'another-session', revision: 0, items: [] })

    await expect(controller.snapshot(localConfig)).rejects.toThrow(
      'Runtime snapshot returned a Timeline for another Session: another-session'
    )
  })

  it('reprojects membership when an Agent disappears before its Timeline can be read', async () => {
    const controller = await configuredController()
    const client = runtimeFixture.FakeClient.instances[0]!
    const status = agentStatusFixture()
    client.runtimeProjection
      .mockResolvedValueOnce({
        hostId: 'local',
        subjects: [{
          subjectId: 'agent:local:agent-1',
          kind: 'agent',
          hostId: 'local',
          workspacePath: '/repo',
          providerId: status.session.providerId,
          executorId: status.session.executorId,
          agentSession: status.session,
          run: status.run
        }]
      })
      .mockResolvedValueOnce({ hostId: 'local', subjects: [] })
    client.sessionTimeline.mockRejectedValueOnce(new Error('Agent Session no longer exists'))

    await expect(controller.snapshot(localConfig)).resolves.toEqual({
      sessions: [],
      timelines: {},
      recoveryCandidates: []
    })
    expect(client.runtimeProjection).toHaveBeenCalledTimes(2)
    expect(client.sessionTimeline).toHaveBeenCalledOnce()
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

  it('answers split Codex color queries only after Core publishes the ready Agent Session', async () => {
    const controller = await configuredController()
    controller.setTerminalViewColors({ foreground: '#ffffff', background: '#000000' })
    const client = runtimeFixture.FakeClient.instances[0]!
    const publish = (data: string, startByte: number) => client.eventListener?.({
      type: 'terminal-output',
      agentSessionId: 'agent-1',
      run: { runId: 'run-1' },
      data,
      evidence: {
        source: 'terminal-output',
        observedAt: 1,
        run: { runId: 'run-1' },
        outputByteRange: {
          startByte,
          endByte: startByte + Buffer.byteLength(data)
        }
      }
    })

    publish('frame\x1b]10;?;', 0)
    publish('?\x1b\\', 12)
    await Promise.resolve()
    expect(client.writeAgent).not.toHaveBeenCalled()
    client.eventListener?.({
      type: 'agent-session',
      session: {
        kind: 'agent',
        agentSessionId: 'agent-1',
        providerId: 'codex',
        executorId: 'codex',
        hostId: 'local',
        workspacePath: '/repo',
        run: { runId: 'run-1' },
        retiredRuns: [],
        outputCursorBytes: 0,
        createdAt: 1,
        updatedAt: 1
      }
    })

    await vi.waitFor(() => {
      expect(client.writeAgent).toHaveBeenCalledWith(
        'agent-1',
        '\x1b]10;rgb:ffff/ffff/ffff\x1b\\\x1b]11;rgb:0000/0000/0000\x1b\\'
      )
    })
  })

  it('shares one retained Run Attachment across concurrent Desktop View leases', async () => {
    const controller = await configuredController()
    const client = runtimeFixture.FakeClient.instances[0]!
    const renderer = webContentsFixture()
    const detachRenderer = controller.attach(renderer)
    client.runtimeProjection.mockResolvedValue({
      hostId: 'local',
      subjects: [{
        subjectId: 'terminal:local:run-1',
        kind: 'terminal',
        hostId: 'local',
        workspacePath: '/repo',
        run: {
          runId: 'run-1',
          kind: 'terminal',
          providerId: null,
          executorId: null,
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
    expect(controller.resourceOwnerCounts()).toEqual({
      sessionAttachmentOwners: 1,
      sessionAttachmentLeases: 2
    })

    await controller.detachSession(renderer.id, first.attachmentId)
    expect(client.releaseRunAttachment).not.toHaveBeenCalled()
    expect(controller.resourceOwnerCounts()).toEqual({
      sessionAttachmentOwners: 1,
      sessionAttachmentLeases: 1
    })
    client.releaseRunAttachment.mockRejectedValueOnce(new Error('release interrupted'))
    await expect(controller.detachSession(renderer.id, second.attachmentId)).rejects.toThrow('release interrupted')
    expect(controller.resourceOwnerCounts()).toEqual({
      sessionAttachmentOwners: 0,
      sessionAttachmentLeases: 0
    })

    const third = await controller.attachSession(renderer.id, control, 12, localConfig)
    expect(client.attachTerminal).toHaveBeenCalledTimes(2)
    expect(client.readRunReplay).toHaveBeenCalledOnce()
    await controller.detachSession(renderer.id, third.attachmentId)
    expect(client.releaseRunAttachment).toHaveBeenCalledTimes(2)
    expect(client.releaseRunAttachment).toHaveBeenCalledWith(expect.objectContaining(control.run))
    expect(controller.resourceOwnerCounts()).toEqual({
      sessionAttachmentOwners: 0,
      sessionAttachmentLeases: 0
    })
    detachRenderer()
  })

  it('serializes Attachment-owned resize with exact-Run Stop and revokes late viewport work', async () => {
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
    client.runtimeProjection.mockResolvedValue({
      hostId: 'local',
      subjects: [{
        subjectId: 'terminal:local:run-1',
        kind: 'terminal',
        hostId: 'local',
        workspacePath: '/repo',
        run: {
          runId: 'run-1', kind: 'terminal', providerId: null, executorId: null, agentSessionId: null,
          workspacePath: '/repo', pid: 42, state: 'running', cols: 80, rows: 24,
          observedAt: 1, latestOutputBytes: 12, acceptedInputBytes: 4
        }
      }]
    })
    const attachment = await controller.attachSession(renderer.id, control, 0, localConfig)
    await expect(controller.resizeSessionAttachment(
      renderer.id + 1,
      attachment.attachmentId,
      100,
      30
    )).rejects.toThrow('different Desktop client')

    const resizeEntered = deferred<void>()
    const releaseResize = deferred<void>()
    client.resizeTerminal.mockImplementationOnce(async (run, cols, rows) => {
      resizeEntered.resolve()
      await releaseResize.promise
      return { runId: run.runId, cols, rows }
    })
    const resize = controller.resizeSessionAttachment(
      renderer.id,
      attachment.attachmentId,
      120,
      40
    )
    await resizeEntered.promise
    const stop = controller.stopSession(control)
    await Promise.resolve()
    expect(client.stopTerminal).not.toHaveBeenCalled()

    releaseResize.resolve()
    await Promise.all([resize, stop])
    expect(client.resizeTerminal).toHaveBeenCalledOnce()
    expect(client.resizeTerminal).toHaveBeenCalledWith(control.run, 120, 40)
    expect(client.stopTerminal).toHaveBeenCalledWith(control.run)
    expect(controller.resourceOwnerCounts()).toEqual({
      sessionAttachmentOwners: 0,
      sessionAttachmentLeases: 0
    })

    await expect(controller.resizeSessionAttachment(
      renderer.id,
      attachment.attachmentId,
      140,
      50
    )).resolves.toBeUndefined()
    expect(client.resizeTerminal).toHaveBeenCalledOnce()
    detachRenderer()
  })

  it('revokes a late Attachment resize that queues behind an in-flight Stop', async () => {
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
    client.runtimeProjection.mockResolvedValue({
      hostId: 'local',
      subjects: [{
        subjectId: 'terminal:local:run-1',
        kind: 'terminal',
        hostId: 'local',
        workspacePath: '/repo',
        run: {
          runId: 'run-1', kind: 'terminal', providerId: null, executorId: null, agentSessionId: null,
          workspacePath: '/repo', pid: 42, state: 'running', cols: 80, rows: 24,
          observedAt: 1, latestOutputBytes: 12, acceptedInputBytes: 4
        }
      }]
    })
    const attachment = await controller.attachSession(renderer.id, control, 0, localConfig)
    const stopEntered = deferred<void>()
    const releaseStop = deferred<void>()
    client.stopTerminal.mockImplementationOnce(async () => {
      stopEntered.resolve()
      await releaseStop.promise
    })

    const stop = controller.stopSession(control)
    await stopEntered.promise
    const resize = controller.resizeSessionAttachment(
      renderer.id,
      attachment.attachmentId,
      120,
      40
    )
    await Promise.resolve()
    expect(client.resizeTerminal).not.toHaveBeenCalled()

    releaseStop.resolve()
    await Promise.all([stop, resize])
    expect(client.resizeTerminal).not.toHaveBeenCalled()
    expect(controller.resourceOwnerCounts()).toEqual({
      sessionAttachmentOwners: 0,
      sessionAttachmentLeases: 0
    })
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
    client.runtimeProjection.mockResolvedValue({
      hostId: 'local',
      subjects: [{
        subjectId: 'terminal:local:run-1',
        kind: 'terminal',
        hostId: 'local',
        workspacePath: '/repo',
        run: {
          runId: 'run-1', kind: 'terminal', providerId: null, executorId: null, agentSessionId: null,
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
        runId: 'run-1', kind: 'terminal', providerId: null, executorId: null, agentSessionId: null,
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
          runId: 'new-run', kind: 'agent', providerId: 'codex', executorId: 'codex', agentSessionId: 'agent-1',
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
