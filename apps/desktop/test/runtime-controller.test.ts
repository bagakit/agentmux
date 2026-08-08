import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AgentMuxError,
  type AgentCapabilities,
  type AgentMuxAgentSession,
  type AgentMuxAgentContinuityResult,
  type AgentMuxAgentSessionStore,
  type AgentMuxRuntimeProjection
} from '@agentmux/core'
// 衰减判据从 core 的 node-free 子路径取，而不是在测试里手抄阈值：阈值刻意不导出（它没有产品
// 调用方），所以「带回的时刻对不对」只能由 core 自己回答。
import {
  msUntilSemanticStatusStale,
  semanticStatusStale
} from '@agentmux/core/agent-status'
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
    readonly createAgent = vi.fn(async (): Promise<AgentMuxAgentSession> => {
      throw new Error('Agent launch fixture stopped after input capture')
    })
    readonly createTerminal = vi.fn(async () => ({
      runId: 'terminal-run',
      kind: 'terminal' as const,
      providerId: null,
      executorId: null,
      agentSessionId: null,
      workspacePath: '/repo',
      pid: 44,
      state: 'running' as const,
      cols: 80,
      rows: 24,
      observedAt: 1,
      latestOutputBytes: 0,
      acceptedInputBytes: 0
    }))
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
    readonly respondAgentInteraction = vi.fn(async () => {})
    readonly resumeAgent = vi.fn(async () => {})
    readonly ensureAgentContinuity = vi.fn(async (): Promise<AgentMuxAgentContinuityResult> => {
      throw new Error('Agent continuity fixture is not configured')
    })
    readonly sessionTimeline = vi.fn(async (agentSessionId: string) => ({
      agentSessionId,
      revision: 0,
      items: []
    }))
    // 每个 Provider 给一份**互不相同**的能力声明，且必须按传进来的 id 取。
    //
    // 为什么不能像原先那样 `get: vi.fn(() => 同一个对象)`：那样的 fixture 让"按这个 Session 自己的
    // providerId 去查"与"返回一个常量"在断言下完全等价——实测把生产侧的取值口整个换成一份写死的
    // "什么都不支持"，42 条照旧全绿。能力声明是要往界面上决定"这个 Agent 有没有时间轴/能不能恢复"的，
    // 取错 Provider 的那一份就是把别家的能力安到这家头上，而这一族此前无人守。
    // 只有让不同 id 的取值真的不同，投影里那个 id 才有人质询。
    //
    // 每个值都必须是 `AgentCapabilities` 联合里的**合法成员**：desktop 的 tsconfig include 只有
    // `src/**`，test/ 不在其中，vitest 又只转译不查类型——所以这里写一个不存在的枚举值（曾经写过
    // `timeline:'incremental-events'`）没有任何东西会拦，而这份 fixture 的隐含前提正是"它长得像一份
    // 真 Provider 声明"。区分两家靠的是**选不同的合法成员**，不是编新成员。
    static readonly PROVIDER_CAPABILITIES: Record<string, AgentCapabilities> = {
      codex: {
        terminal: true,
        timeline: 'complete-events',
        permission: 'observe',
        providerResume: true,
        replyCorrelation: 'none'
      },
      claude: {
        terminal: true,
        timeline: 'streaming',
        permission: 'respond',
        providerResume: false,
        replyCorrelation: 'native-turn-id'
      }
    }
    readonly providers = {
      catalog: vi.fn(() => []),
      get: vi.fn((providerId: string) => {
        const capabilities = FakeClient.PROVIDER_CAPABILITIES[providerId]
        // 未知 id 响亮地抛，与真 registry 的 UNKNOWN_PROVIDER 同一个姿态：取不到能力绝不能静默
        // 退化成一份假声明，那正是被删掉的那个兜底字面量犯的错。
        if (!capabilities) throw new Error(`UNKNOWN_PROVIDER: ${providerId}`)
        return { catalog: { capabilities } }
      })
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

vi.mock('@agentmux/core', () => {
  class AgentMuxError extends Error {
    readonly code: string
    readonly detail?: string
    constructor(message: string, code: string, detail?: string) {
      super(message)
      this.name = 'AgentMuxError'
      this.code = code
      this.detail = detail
    }
  }
  return {
    AgentMuxError,
    AgentMuxClient: runtimeFixture.FakeClient,
    AgentMuxMemoryAgentSessionStore: class {},
    connectLocalAgentMux: runtimeFixture.connectClient,
    connectSshAgentMux: runtimeFixture.connectClient
  }
})
vi.mock('../src/main/host-factory.js', () => ({
  createExecutionHost: vi.fn((host: { id: string }) => {
    const created = { id: host.id, dispose: vi.fn(async () => {}) }
    runtimeFixture.createdHosts.push(created)
    return created
  })
}))

import { RuntimeController } from '../src/main/runtime-controller.js'
import { ProcessResourceSampler } from '../src/main/process-resource-sampler.js'

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
  version: 9,
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
      timeline: 'complete-events' as const,
      permission: 'observe' as const,
      providerResume: true,
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

  it('maps one Terminal shell command only at the Desktop creation boundary', async () => {
    const controller = await configuredController()
    const client = runtimeFixture.FakeClient.instances[0]!
    client.runtimeProjection.mockResolvedValue({
      hostId: 'local',
      subjects: [{
        subjectId: 'terminal:local:terminal-run',
        kind: 'terminal',
        hostId: 'local',
        workspacePath: '/repo',
        run: await client.createTerminal.mock.results[0]?.value ?? {
          runId: 'terminal-run', kind: 'terminal', providerId: null, executorId: null,
          agentSessionId: null, workspacePath: '/repo', pid: 44, state: 'running', cols: 80,
          rows: 24, observedAt: 1, latestOutputBytes: 0, acceptedInputBytes: 0
        }
      }]
    })

    await controller.launchTerminal({
      hostId: 'local',
      workspacePath: '/repo',
      createOperationId: 'terminal-op',
      shellCommand: 'pnpm test:fast'
    }, localConfig)

    expect(client.createTerminal).toHaveBeenCalledWith({
      createOperationId: 'terminal-op',
      workspacePath: '/repo',
      command: process.env.SHELL ?? '/bin/sh',
      args: ['-lc', 'pnpm test:fast']
    })
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
        // Topic 说明是 AgentMux 自己的话：作为 agentMuxNote 分开传给 Core 的信封出口署名，
        // 不再被拼进用户段。用户的真实请求原样留在 prompt。
        agentMuxNote: expect.stringContaining('Inspect .agents/'),
        prompt: 'Ship the result'
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

  it('projects Core delivery degradation with the launch snapshot', async () => {
    const controller = await configuredController()
    const client = runtimeFixture.FakeClient.instances[0]!
    const status = agentStatusFixture()
    const delivery = {
      state: 'unverified' as const, mode: 'degraded' as const, reason: 'screen-evidence-replaced' as const,
      submissionId: 'prompt-1', run: { ...status.session.run }, observedAt: 10
    }
    Object.assign(status.session, { terminalPromptDelivery: delivery })
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
      session: { id: 'agent-1', kind: 'agent', terminalPromptDelivery: delivery },
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

  it.each(['resumeSession', 'recoverSession'] as const)(
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

      const result = operation === 'resumeSession'
        ? controller.resumeSession(control, 'continue', 'op-1', config)
        : controller.recoverSession(control, config)

      await expect(result).rejects.toThrow(
        'Agent Executor review is bound to Provider claude, but this Session uses Provider codex'
      )
      expect(client.resumeAgent).not.toHaveBeenCalled()
      expect(client.submitAgentPrompt).not.toHaveBeenCalled()
    }
  )

  it('submits prompt to running agent through single Core submitAgentPrompt invocation', async () => {
    const controller = await configuredController()
    const client = runtimeFixture.FakeClient.instances[0]!
    const running = agentStatusFixture()
    client.statusAgent.mockResolvedValue({
      ...running,
      run: { ...running.run, state: 'running' as const }
    })
    const control = {
      kind: 'agent' as const,
      hostId: 'local',
      agentSessionId: 'agent-1',
      run: { runId: 'run-1' }
    }

    await controller.submitPrompt(control, 'hello', localConfig)
    expect(client.submitAgentPrompt).toHaveBeenCalledTimes(1)
    expect(client.submitAgentPrompt).toHaveBeenCalledWith(expect.objectContaining({
      agentSessionId: 'agent-1',
      prompt: 'hello'
    }))
  })

  it.each([
    {
      code: 'AGENT_PROMPT_NOT_READY',
      coreMessage: 'Agent prompt requires a ready composer epoch for this exact Run.',
      detail: 'runId=run-1 readinessId=readiness-1 readinessSource=native-stop readyThroughByte=pending reason=observation-pending',
      expected: /no consumable composer readiness.*still running.*send again/i
    },
    {
      code: 'AGENT_PROMPT_READINESS_CONSUMED',
      coreMessage: 'The current composer readiness epoch was already consumed by another prompt.',
      detail: 'runId=run-1 readinessId=readiness-1 consumedBySubmissionId=submission-1 readyThroughByte=42',
      expected: /readiness epoch was already consumed.*still running.*next readiness epoch/i
    },
    {
      code: 'AGENT_PROMPT_SUBMISSION_BUSY',
      coreMessage: 'Another Agent prompt operation is incomplete for this Run.',
      detail: 'runId=run-1 activeSubmissionId=submission-1 payloadAcknowledged=true submitAcknowledged=false',
      expected: /another submission.*still completing.*keep this draft/i
    },
    {
      code: 'AGENT_PROMPT_READINESS_CONFLICT',
      coreMessage: 'Prompt readiness changed or was consumed by another Client.',
      detail: 'expectedRunId=run-1 canonicalRunId=run-2 reason=session-cas-rejected-after-refresh',
      expected: /readiness changed.*refresh the canonical Session.*current Run/i
    }
  ] as const)('classifies $code into an actionable message and preserves diagnostics', async ({
    code,
    coreMessage,
    detail,
    expected
  }) => {
    // Core remains fail-closed. Main classifies only the stable code, while carrying the non-sensitive
    // Run/epoch/submission facts through the Error detail for logs and the IPC-visible message.
    const controller = await configuredController()
    const client = runtimeFixture.FakeClient.instances[0]!
    const running = agentStatusFixture()
    client.statusAgent.mockResolvedValue({
      ...running,
      run: { ...running.run, state: 'running' as const }
    })
    client.submitAgentPrompt.mockRejectedValue(new AgentMuxError(coreMessage, code, detail))
    const control = {
      kind: 'agent' as const,
      hostId: 'local',
      agentSessionId: 'agent-1',
      run: { runId: 'run-1' }
    }

    const rejection = await controller.submitPrompt(control, 'steer mid-turn').then(
      () => { throw new Error('submitPrompt resolved but should have rejected') },
      (error: unknown) => error
    )
    expect(rejection).toBeInstanceOf(AgentMuxError)
    const error = rejection as AgentMuxError
    expect(error.code).toBe(code)
    expect(error.detail).toBe(detail)
    expect(error.message).toMatch(expected)
    expect(error.message).toContain(`Diagnostic: ${detail}`)
    // User content is never copied into Core detail or the classified message.
    expect(error.message).not.toContain('steer mid-turn')
  })

  it('forwards a typed interaction response with the exact Session Run fence', async () => {
    const controller = await configuredController()
    const client = runtimeFixture.FakeClient.instances[0]!
    const control = {
      kind: 'agent' as const,
      hostId: 'local',
      agentSessionId: 'agent-1',
      run: { runId: 'run-1' }
    }
    const response = {
      kind: 'permission' as const,
      requestId: 'permission-1',
      decision: { outcome: 'selected' as const, optionId: 'allow' }
    }

    await controller.respondInteraction(control, response)

    expect(client.respondAgentInteraction).toHaveBeenCalledWith({
      agentSessionId: 'agent-1',
      expectedRun: { runId: 'run-1' },
      response
    })
  })

  it('rejects send for an ended Run and resumes only through the explicit operation', async () => {
    const controller = await configuredController()
    const client = runtimeFixture.FakeClient.instances[0]!
    const previous = agentStatusFixture()
    client.statusAgent.mockResolvedValue(previous)
    const control = {
      kind: 'agent' as const,
      hostId: 'local',
      agentSessionId: 'agent-1',
      run: { runId: 'run-1' }
    }

    await expect(controller.submitPrompt(control, 'continue')).rejects.toMatchObject({
      code: 'SESSION_NOT_RUNNING'
    })
    expect(client.resumeAgent).not.toHaveBeenCalled()

    client.resumeAgent.mockResolvedValue({ ...previous.session, run: { runId: 'run-2' } })
    client.runtimeProjection.mockResolvedValue({
      hostId: 'local',
      subjects: [{
        subjectId: 'agent:local:agent-1',
        kind: 'agent',
        hostId: 'local',
        workspacePath: '/repo',
        providerId: 'codex',
        executorId: 'review',
        agentSession: { ...previous.session, run: { runId: 'run-2' } },
        run: { ...previous.run, runId: 'run-2', state: 'running', exitCode: undefined }
      }]
    })
    const resumeConfig: AppConfig = {
      ...localConfig,
      executors: {
        review: {
          label: 'Review Codex', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: true
        }
      }
    }
    await expect(controller.resumeSession(control, 'continue', 'resume-op', resumeConfig)).resolves.toMatchObject({
      id: 'agent-1', control: { run: { runId: 'run-2' } }
    })
    expect(client.resumeAgent).toHaveBeenCalledWith(expect.objectContaining({
      agentSessionId: 'agent-1', operationId: 'resume-op', prompt: 'continue'
    }))
  })

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

  it('carries the exit reason through the snapshot — reload must not degrade it to a bare signal', async () => {
    // 这条守的是 reload / 冷启动那条路。exitReason 由 Core 在退出那一刻合成后挂在 run 上；projectSession
    // 若不把它抄到 status，横幅就从「它自己崩了」退化成 detail:"signal SIGKILL"——同一个已死的 Agent，
    // 在场时说得清，重开窗口就说不清了。事件路径的那一半在 session-state 里另有断言，两条路必须同答案。
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
        run: { ...status.run, state: 'exited' as const, exitCode: 0, exitSignal: 'SIGKILL', exitReason: 'crashed' as const }
      }]
    })

    const snapshot = await controller.snapshot(localConfig)

    expect(snapshot.sessions[0]?.status).toMatchObject({ state: 'exited', exitReason: 'crashed' })
  })

  it('carries the killing signal into the visible detail — the same sentence the live path shows', async () => {
    // 两条路径同一句话那一半。这段投影现在是 Core 的共享实现（@agentmux/core/run-status），实时路径的
    // 姊妹断言在 run-process-status-convergence.test.ts；两个文件各自独立红，因为「一条路走了共享投影、
    // 另一条还留着手抄版」正是这个缺陷此前活下来的形状。
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
        run: { ...status.run, state: 'exited' as const, exitCode: 139, exitSignal: 'SIGSEGV' }
      }]
    })

    const snapshot = await controller.snapshot(localConfig)

    expect(snapshot.sessions[0]?.status).toMatchObject({ state: 'exited', detail: 'signal SIGSEGV' })
  })

  it('says the PTY went away in the same words the live path uses', async () => {
    // interrupted 那条分支：它既没有退出码也没有信号可给，不解释一句用户只会看到一个没有下文的 error。
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
        run: { ...status.run, state: 'interrupted' as const }
      }]
    })

    const snapshot = await controller.snapshot(localConfig)

    expect(snapshot.sessions[0]?.status).toMatchObject({
      state: 'error',
      detail: 'The Run owner interrupted this PTY.'
    })
  })

  it('does not invent an exit reason the Run never carried', async () => {
    // 反向那一侧：run 上没有 exitReason 时不许凭空造一个。少了它，「一律填 crashed」这种过宽的抄法
    // 也会让上面那条全绿——而那会把一个我们自己关掉的 Agent 说成崩溃。
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
        run: { ...status.run, state: 'exited' as const, exitCode: 0 }
      }]
    })

    const snapshot = await controller.snapshot(localConfig)

    expect(snapshot.sessions[0]?.status).toMatchObject({ state: 'exited' })
    expect(snapshot.sessions[0]?.status.exitReason).toBeUndefined()
  })

  it('carries why the PTY went away through the snapshot — on the terminal, whose auto-recovery reads it', async () => {
    // 第四条同族事实的**快照**一半。它与上面三条的区别是落点：`interruptionReason` 挂在 Session 本体
    // 而不是 `status` 里，所以 :1023/:1049/:1101 那三条断言（全都取 `.status`）对它整条失明。
    //
    // 为什么先钉 terminal：SessionPane 的自动恢复 effect 第一句就是
    // `if (session.kind !== 'terminal') return`，随后才判 `interruptionReason === 'daemon_restart'`。
    // 也就是说这条事实的唯一行为消费者只看 terminal 那个分支——而 terminal 与 agent 是投影里两个
    // 各自 return 的对象，各写一次。少写一处不会有任何东西红。
    const controller = await configuredController()
    const client = runtimeFixture.FakeClient.instances[0]!
    client.runtimeProjection.mockResolvedValue({
      hostId: 'local',
      subjects: [{
        subjectId: 'terminal:local:run-1',
        kind: 'terminal',
        hostId: 'local',
        workspacePath: '/repo',
        run: {
          runId: 'run-1',
          kind: 'terminal' as const,
          providerId: null,
          executorId: null,
          agentSessionId: null,
          workspacePath: '/repo',
          pid: 42,
          state: 'interrupted' as const,
          cols: 80,
          rows: 24,
          observedAt: 2,
          latestOutputBytes: 0,
          acceptedInputBytes: 0,
          interruptionReason: 'daemon_restart'
        }
      }]
    })

    const snapshot = await controller.snapshot(localConfig)

    expect(snapshot.sessions[0]).toMatchObject({
      kind: 'terminal',
      processState: 'interrupted',
      interruptionReason: 'daemon_restart'
    })
  })

  it('carries why the PTY went away on the agent too — the two projections are written separately', async () => {
    // 姊妹的姊妹：agent 分支是同一条事实的第二个写入点。上面那条 terminal 断言绿着，也不能替这一处
    // 担保——那正是 exitSignal / exitReason 各自漏过一次的方式。
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
        run: { ...status.run, state: 'interrupted' as const, interruptionReason: 'daemon_restart' }
      }]
    })

    const snapshot = await controller.snapshot(localConfig)

    expect(snapshot.sessions[0]).toMatchObject({
      kind: 'agent',
      processState: 'interrupted',
      interruptionReason: 'daemon_restart'
    })
  })

  it('does not put an interruption reason on a Run that simply exited', async () => {
    // 条件里 `state === 'interrupted'` 那一半。少了这条，把判据放宽成「只看理由在不在」也能让上面两条
    // 全绿——而那会让一个正常退出的终端带上中断理由，于是 SessionPane 会去自动重开它。
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
        run: { ...status.run, state: 'exited' as const, exitCode: 0, interruptionReason: 'daemon_restart' }
      }]
    })

    const snapshot = await controller.snapshot(localConfig)

    expect(snapshot.sessions[0]).toMatchObject({ processState: 'exited' })
    expect(snapshot.sessions[0]).not.toHaveProperty('interruptionReason')
  })

  it('does not put an EMPTY interruption reason on an interrupted Run either', async () => {
    // 姊妹于上一条。上一条守的是条件里 `state === 'interrupted'` 那一半（正常退出不带理由）；这一条
    // 守另一半：即便 state 确实是 interrupted，理由是空串时也不能落。runInterruptionFact 的注释逐字
    // 写着空串会把「没说原因」伪装成「原因是空的」，并让 SessionPane 的 `=== 'daemon_restart'` 判定读到
    // 假值。把真值判据放宽成 `interruptionReason !== undefined` 会放行空串——它挡住 undefined、放行 ''，
    // 所以只喂 undefined 的断言对它整条失明。这里让快照路径也各钉一次（agent 与 terminal 分开投影）。
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
        run: { ...status.run, state: 'interrupted' as const, interruptionReason: '' }
      }]
    })

    const snapshot = await controller.snapshot(localConfig)

    expect(snapshot.sessions[0]).toMatchObject({ processState: 'interrupted' })
    expect(snapshot.sessions[0]).not.toHaveProperty('interruptionReason')
  })

  it('projects persisted semantic status and typed interaction over a live Run', async () => {
    const controller = await configuredController()
    const client = runtimeFixture.FakeClient.instances[0]!
    const status = agentStatusFixture()
    const request = {
      kind: 'permission' as const,
      id: 'permission-1',
      agentSessionId: 'agent-1',
      title: 'Allow command?',
      options: [{ id: 'allow', label: 'Allow', kind: 'allow-once' as const }],
      evidence: {
        source: 'native-hook' as const,
        observedAt: 3,
        run: { runId: 'run-1' },
        hookReceiptId: 'permission-1'
      }
    }
    client.runtimeProjection.mockResolvedValue({
      hostId: 'local',
      subjects: [{
        subjectId: 'agent:local:agent-1',
        kind: 'agent',
        hostId: 'local',
        workspacePath: '/repo',
        providerId: 'codex',
        executorId: 'review',
        agentSession: {
          ...status.session,
          updatedAt: 3,
          semanticStatus: {
            state: 'waiting',
            source: 'native-hook',
            observedAt: 3,
            detail: 'PermissionRequest'
          },
          pendingInteraction: { request }
        },
        run: {
          ...status.run,
          state: 'running',
          observedAt: 4,
          exitCode: undefined
        }
      }]
    })

    const snapshot = await controller.snapshot(localConfig)

    expect(snapshot.sessions[0]).toMatchObject({
      processState: 'running',
      status: { state: 'waiting', source: 'native-hook', detail: 'PermissionRequest' },
      pendingInteraction: request
    })
  })

  it('语义状态跨 reload 带回原来的观察时刻，而不是盖成当下——否则衰减永远等不到', async () => {
    // 为什么要单独钉这一条：`working` 会不会「陈旧到不再算数」完全按 `observedAt` 判
    // （agent-status-freshness 的阈值 + renderer 的 agent-status-decay）。快照投影是 reload 与重连
    // 补发唯一的取值来源，它只要把 observedAt 换成 Date.now()，每次 reload 就把计时器重置一次——
    // 一个 hook 流早已断掉的 Agent 会永远转圈，而这正是衰减本身要解决的那个问题。
    //
    // 现有那条 permission 测试用 toMatchObject 且没列 observedAt，所以盖掉它 55 条全绿（实测）。
    // 这里必须逐值比对那个时刻本身。
    const controller = await configuredController()
    const client = runtimeFixture.FakeClient.instances[0]!
    const status = agentStatusFixture()
    // 一个远早于「现在」的时刻：真实场景里它是 hook 最后一次说话的时间。
    const lastHeardFrom = 1_000
    // 进程台账自己的观测时刻必须**与上面那个不同**：投影里 `const observedAt = run.observedAt`
    // （runtime-controller.ts:159），所以「把语义状态的时刻盖成进程时刻」这个变异，只有在两者
    // 取值不同时才是可观测的改动。实测两者都填 1000 时，那次变异是恒等替换，42 条照旧全绿——
    // fixture 自己让被测的缺陷变成了 no-op。
    const processObservedAt = 900_000
    client.runtimeProjection.mockResolvedValue({
      hostId: 'local',
      subjects: [{
        subjectId: 'agent:local:agent-1',
        kind: 'agent',
        hostId: 'local',
        workspacePath: '/repo',
        providerId: 'codex',
        executorId: 'review',
        agentSession: {
          ...status.session,
          updatedAt: lastHeardFrom,
          semanticStatus: {
            state: 'working',
            source: 'native-hook',
            observedAt: lastHeardFrom
          }
        },
        // run 仍在跑：只有 running 才会走 semanticStatus 那条分支（非 running 时用进程投影）。
        run: { ...status.run, state: 'running', observedAt: processObservedAt, exitCode: undefined }
      }]
    })

    const snapshot = await controller.snapshot(localConfig)
    const projected = snapshot.sessions[0]!

    expect(projected.status.state).toBe('working')
    expect(
      projected.status.observedAt,
      '快照必须原样带回语义状态自己的观察时刻；盖成 Date.now() 会让衰减在每次 reload 后重新计时'
    ).toBe(lastHeardFrom)
    // 判据不止「等于那个数」，还要「衰减据此真的会降它」——数字对但取值口径变了同样是坏的。
    // 阈值本身在 core 里刻意不导出（零调用者原则），所以这里让 core 自己回答「还剩多久」，
    // 再走到那一刻之后去问「陈旧了吗」，全程不手抄任何毫秒数。
    const remaining = msUntilSemanticStatusStale(projected.status, lastHeardFrom)
    expect(remaining, '一条刚被观察到的 working 必须还剩正的寿命').toBeGreaterThan(0)
    expect(
      semanticStatusStale(projected.status, lastHeardFrom + remaining),
      '带回的时刻要能让 core 的陈旧判据在到点后认定它该降级'
    ).toBe(true)
    // 对照：同一条 status 在它自己那一刻还不算陈旧。少了这条，上面那句在「判据恒为真」时也会绿。
    expect(semanticStatusStale(projected.status, lastHeardFrom)).toBe(false)
  })

  it('每个 Session 的能力声明按它自己的 providerId 取，两家不同的 Provider 不共用一份', async () => {
    // 这条守的是「能力声明从哪来」这条规则本身，而不是某几个取值。
    //
    // 为什么必须让两家 Provider 同场、且声明互不相同：能力投影此前完全无人守——把取值口整个换成一份
    // 写死的"什么都不支持"字面量，42 条全绿。原因是 fixture 的 `providers.get` 忽略入参恒返回同一个
    // 对象，于是"按这个 Session 的 providerId 查"与"返回常量"在断言下无从区分。两家同场之后，常量化、
    // 取错 id（比如两处都拿第一个 subject 的 providerId）、读错字段都会红。
    //
    // 为什么这件事值得守：`timeline` 决定界面给不给这个 Agent 画时间轴，`providerResume` 决定"恢复"
    // 按钮是不是死的。安错一家的声明，用户看到的是一个对着能恢复的 Agent 不给恢复、或对着没有时间轴的
    // Provider 画一个永远空的时间轴的界面——两者都不会报错，只是静默地不对。
    const controller = await configuredController()
    const client = runtimeFixture.FakeClient.instances[0]!
    const codex = agentStatusFixture()
    const claude = agentStatusFixture()
    claude.session = { ...claude.session, agentSessionId: 'agent-2', providerId: 'claude' }
    claude.run = { ...claude.run, runId: 'run-2', agentSessionId: 'agent-2', providerId: 'claude' }

    client.runtimeProjection.mockResolvedValue({
      hostId: 'local',
      subjects: [{
        subjectId: 'agent:local:agent-1',
        kind: 'agent',
        hostId: 'local',
        workspacePath: '/repo',
        providerId: 'codex',
        executorId: codex.session.executorId,
        agentSession: codex.session,
        run: { ...codex.run, state: 'running' as const, exitCode: undefined }
      }, {
        subjectId: 'agent:local:agent-2',
        kind: 'agent',
        hostId: 'local',
        workspacePath: '/repo',
        providerId: 'claude',
        executorId: claude.session.executorId,
        agentSession: claude.session,
        run: { ...claude.run, state: 'running' as const, exitCode: undefined }
      }]
    })

    const snapshot = await controller.snapshot(localConfig)
    const byId = new Map(snapshot.sessions.map((session) => [session.id, session]))

    // 逐条对上 registry 里那一家自己的声明。期望值从 fixture 的那张表取，不在这里手抄——手抄一份就又是
    // 一处可漂移的副本，而且期望值若由被测取值口算出来，它会跟着变异一起漂、断言恒真。
    expect(byId.get('agent-1')?.capabilities)
      .toEqual(runtimeFixture.FakeClient.PROVIDER_CAPABILITIES.codex)
    expect(byId.get('agent-2')?.capabilities)
      .toEqual(runtimeFixture.FakeClient.PROVIDER_CAPABILITIES.claude)
    // 显式钉死"两家不一样"。少了这条，把两个 Session 的能力都取成同一家（或都取成一份常量）时上面
    // 两句里至少有一句仍可能绿——而"所有 Agent 共用一份能力"正是这个缺陷的实际形状。
    expect(byId.get('agent-1')?.capabilities)
      .not.toEqual(byId.get('agent-2')?.capabilities)
    // registry 必须真的被按各自的 id 问过：取值口若被换成常量，这两句会红而不必依赖取值恰好不同。
    expect(client.providers.get).toHaveBeenCalledWith('codex')
    expect(client.providers.get).toHaveBeenCalledWith('claude')
  })

  it('恢复候选的能力声明与在场 Session 走同一个取值口，不是自己抄一遍 registry 查询', async () => {
    // 分开钉这条出口：`recoveryCandidates` 曾自己抄了一遍那句 registry 查询，两处都在投影
    // `capabilities` 却是两份可独立漂移的表达式。恢复候选正是"进程没了但会话还在"的那一批，
    // `providerResume` 取错就直接决定用户能不能把它救回来。
    const controller = await configuredController()
    const client = runtimeFixture.FakeClient.instances[0]!
    const stored = { ...client.agentSession(), providerId: 'claude' as const }
    client.agentSessions.mockReturnValue([stored])
    client.runtimeProjection.mockResolvedValue({ hostId: 'local', subjects: [] })

    const snapshot = await controller.snapshot(localConfig)

    expect(snapshot.recoveryCandidates[0]?.capabilities)
      .toEqual(runtimeFixture.FakeClient.PROVIDER_CAPABILITIES.claude)
    // 对照：不能是默认那家（fixture 里 codex 与 claude 的声明刻意不同），否则"按 Session 自己的
    // providerId 取"与"取了个别的"无从区分。
    expect(snapshot.recoveryCandidates[0]?.capabilities)
      .not.toEqual(runtimeFixture.FakeClient.PROVIDER_CAPABILITIES.codex)
    expect(client.providers.get).toHaveBeenCalledWith('claude')
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
      sessionAttachmentOwners: 1,
      sessionAttachmentLeases: 1
    })

    await controller.detachSession(renderer.id, second.attachmentId)
    expect(controller.resourceOwnerCounts()).toEqual({
      sessionAttachmentOwners: 0,
      sessionAttachmentLeases: 0
    })

    const third = await controller.attachSession(renderer.id, control, 12, localConfig)
    expect(client.attachTerminal).toHaveBeenCalledTimes(2)
    expect(client.readRunReplay).toHaveBeenCalledOnce()
    await controller.detachSession(renderer.id, third.attachmentId)
    expect(client.releaseRunAttachment).toHaveBeenCalledTimes(3)
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

  /**
   * resize 有两条臂，而在此之前只有 terminal 那条被执行过。
   *
   * `resizeSessionAttachment` 按 `owner.control.kind` 分岔：agent 走
   * `resizeAgent(agentSessionId, run, cols, rows)`，terminal 走 `resizeTerminal(run, cols, rows)`。
   * 本文件里四个 `resizeSessionAttachment` 调用点全部喂 `kind:'terminal'`；`resizeAgent` 这个
   * fixture 早就定义好了，却从未出现在任何断言里。实测过：把 agent 那条臂的两个实参对调成
   * `(…, rows, cols)`，本文件 47 条全绿。
   *
   * 这条臂恰好是本应用最主要的用法——每一个 codex / claude-code agent 终端的每一次 resize。
   * 转置之后 PTY 按错几何重绘：换行位置全错、diff 视图花屏、状态栏跑到不该在的列。
   *
   * 判据必须同时否掉 terminal 那条：`resizeAgent` 内部会转发给 `resizeTerminal`，所以只断言
   * 「resizeTerminal 收到了 cols/rows」在两条臂上都成立，分不出走的是哪一条。
   */
  it('resize 一个 Agent 附着时走 agent 那条臂，且 cols/rows 不许对调', async () => {
    const controller = await configuredController()
    const client = runtimeFixture.FakeClient.instances[0]!
    const renderer = webContentsFixture()
    const detachRenderer = controller.attach(renderer)
    const status = agentStatusFixture()
    const control: SessionControl = {
      kind: 'agent',
      hostId: 'local',
      agentSessionId: 'agent-1',
      run: { runId: 'run-1' }
    }
    client.reattachAgent.mockResolvedValueOnce({
      session: status.session,
      attachment: {
        run: { ...status.run, state: 'running' as const },
        replay: [],
        gap: null
      }
    })
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
        run: { ...status.run, state: 'running' as const }
      }]
    })

    const attachment = await controller.attachSession(renderer.id, control, 0, {
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
    })
    await controller.resizeSessionAttachment(renderer.id, attachment.attachmentId, 120, 40)

    // 顺序写死：Core 的签名是 (agentSessionId, expectedRun, cols, rows)，对调即转置 PTY。
    expect(client.resizeAgent).toHaveBeenCalledOnce()
    expect(client.resizeAgent).toHaveBeenCalledWith('agent-1', control.run, 120, 40)
    // 分岔的另一半：agent 路上不许直接走 terminal 那条臂（resizeAgent 自己会去转发）。
    expect(client.resizeTerminal).not.toHaveBeenCalled()
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

  /**
   * 资源采样的 pid 从哪来，以及退出时谁把它关掉。
   *
   * 这两条都不会自己变红：pid 来源接错了，面板只是显示不出数；退出时漏掉 dispose，
   * 采样定时器在应用关掉之后还在起 `ps`——用户看不到，测试也看不到。
   */
  describe('资源采样的接线', () => {
    const TABLE = `  PID  PPID    RSS  %CPU\n 4242     1  10000   5.0`

    function sampledController(): { controller: RuntimeController; sampler: ProcessResourceSampler } {
      // 注入假的 `ps`：真实进程会让断言依赖机器当时的负载。
      const sampler = new ProcessResourceSampler(
        async () => TABLE,
        () => 1_000_000,
        () => []
      )
      const controller = new RuntimeController(store, undefined, sampler)
      return { controller, sampler }
    }

    /** 经由订阅读一帧——那是产品唯一的读取口（ipc.ts 的 resourceUsage:subscribe）。 */
    async function runsInOneFrame(sampler: ProcessResourceSampler): Promise<string[]> {
      const runs: string[] = []
      const stop = sampler.subscribe((snapshot) => {
        runs.push(...snapshot.runs.map((run) => run.runId))
      })
      await vi.waitFor(() => expect(runs.length).toBeGreaterThanOrEqual(0))
      await Promise.resolve()
      await Promise.resolve()
      stop()
      return runs
    }

    const processState = (runId: string, state: string, pid: number | null) => ({
      type: 'process-state' as const,
      state,
      run: { runId },
      pid
    })

    it('pid 取自 Core 已经在报的 process-state，不另建一份台账', async () => {
      const { controller, sampler } = sampledController()
      controller.commit(await controller.prepare(localConfig))
      const client = runtimeFixture.FakeClient.instances.at(-1)!

      client.eventListener?.(processState('run-a', 'running', 4242))
      // 事件里带着 pid，采样器就该认得这个 run；认不得说明接线断了或接到了别处。
      expect(await runsInOneFrame(sampler)).toContain('run-a')
      await controller.dispose()
    })

    it('run 结束就不再为它采样——退出的进程留在表里会一直报不可用', async () => {
      const { controller, sampler } = sampledController()
      controller.commit(await controller.prepare(localConfig))
      const client = runtimeFixture.FakeClient.instances.at(-1)!

      client.eventListener?.(processState('run-a', 'running', 4242))
      client.eventListener?.(processState('run-a', 'exited', 4242))
      expect(await runsInOneFrame(sampler)).not.toContain('run-a')
      await controller.dispose()
    })

    it('run-removed 同样注销——两条路径都要走到，只堵一条等于没堵', async () => {
      const { controller, sampler } = sampledController()
      controller.commit(await controller.prepare(localConfig))
      const client = runtimeFixture.FakeClient.instances.at(-1)!

      client.eventListener?.(processState('run-a', 'running', 4242))
      client.eventListener?.({ type: 'run-removed', run: { runId: 'run-a' } })
      expect(await runsInOneFrame(sampler)).not.toContain('run-a')
      await controller.dispose()
    })

    it('controller dispose 会把采样器一并关掉，不留后台采样', async () => {
      const { controller, sampler } = sampledController()
      controller.commit(await controller.prepare(localConfig))
      const disposeSampler = vi.spyOn(sampler, 'dispose')
      await controller.dispose()
      // 漏掉这一步，应用退出后采样定时器还在跑，且没有任何别的断言够得着它。
      expect(disposeSampler).toHaveBeenCalledOnce()
    })
  })
})
