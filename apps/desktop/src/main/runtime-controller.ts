import { readInputObservation, type InputObservationReference, type InputPerformanceSender, type InputPerformanceHandle } from '@agentmux/core/control'
import { MainPerformanceDiagnostics } from './performance-diagnostics.js'
import { profileAgentContext } from '../shared/user-profile.js'
import type { ToolkitRunPort } from './toolkit-run-port.js'
import { AGENT_SCHEDULE_CHECK_IN_GUIDANCE, type AgentScheduleCheckInPolicy } from '@agentmux/core/schedule'
import { checkInHumanObservation, type CheckInObservation } from './agent-schedule-check-in.js'
import { randomUUID } from 'node:crypto'
import {
  AgentMuxError,
  createInputPerformanceRecorder, hostedCarrierPerformance,
  hostAgentCreationIntent,
  type AgentMuxHostAgentCreateInput,
  AGENTMUX_AGENT_MESSAGING_GUIDANCE,
  agentPromptPredecessor,
  agentPromptNotApplied,
  validateAgentPromptCondition,
  type AgentPromptCondition,
  type AgentPromptExecution,
  type AgentMessageChannel,
  type AgentSessionQuestionReplyReceipt,
  type AgentMuxAgentMessageInput,
  type AgentMuxRpcCallContext,
  type AgentMuxNativeSessionConfirmationInput,
  type AgentMuxNativeSessionConfirmation,
  runtimeStorageUsage,
  loadSessionHistorySources,
  agentInteractionResponseUnavailableReason,
  agentInteractionActiveRequest,
  type AgentCapabilities,
  type AgentCatalogEntry,
  type AgentExecutorId,
  type AgentProviderId,
  type AgentSessionHistoryPage,
  type AgentMuxAgentResumeInput,
  type AgentMuxSshHostedClient,
  type AgentSessionHistoryDescriptor,
  type AgentSessionHistoryResourceRequest,
  type AgentSessionHistoryResourceReadResult,
  type AgentSessionHistoryObservation,
  type AgentSessionHistoryObservationHandle,
  type AgentMuxClientEvent,
  type AgentMuxInteractionResponse,
  type AgentMuxAgentSessionStore,
  type AgentMuxRun,
  type AgentMuxRunInputData,
  type AgentMuxAgentWriteInput,
  type AgentMuxRuntimeSubject,
  type AgentMuxRuntimeSubjectTarget,
  type ExecutionHost
} from '@agentmux/core'
import type { DesktopRuntimeClient as AgentMuxClient, DesktopRuntimeConnector } from './desktop-host.js'
// 进程事实的投影走那个 node-free 子路径，与 renderer 侧的实时路径**同一个**实现。走子路径而不是包根，
// 是为了让两侧 import 的是同一个模块——包根那条链拖 node:crypto，renderer 引不动。
import { projectRunProcessStatus, runExitFacts } from '@agentmux/core/run-status'
import { isAgentActivityStatusSource, currentAgentSemanticStatus } from '@agentmux/core/agent-status'
import type { WebContents } from 'electron'
import type {
  ExecutorDetection,
  AgentLaunchResult,
  AgentLaunchInput,
  AgentSessionControl,
  AgentSessionRecoveryCandidate,
  AgentSessionNameMetadata,
  AppConfig,
  HostConfig,
  RuntimeEvent,
  RuntimeSnapshot,
  RuntimeEndpointWarning,
  ProviderCatalogObservation,
  SessionAttachResult,
  SessionReplayResult,
  SessionControl,
  SessionRecoveryResult,
  SessionSnapshot,
  SessionHistoryPageOptions,
  SessionHistoryReference,
  SessionHistorySourcesObservation,
  SessionQuestionReplyInput,
  TerminalLaunchInput
} from '../shared/contracts.js'
import { CONTROL_ENDPOINT_PUBLICATION_STEP, runInterruptionFact, SESSION_EVENT_CHANNEL } from '../shared/contracts.js'
import { projectNativeSourceFacts } from '../shared/agent-native-source.js'
import {
  scanTerminalOscColorQueries,
  type TerminalOscColorQueryReplyColors
} from '../shared/terminal-osc-color-query.js'
import { createExecutionHost } from './host-factory.js'
import { ScratchTopics, type PreparedScratchAgentTopic } from './scratch-topics.js'
import { ProcessResourceSampler } from './process-resource-sampler.js'
import type { RuntimeUsage } from '../shared/process-usage.js'
import { humanizePromptDeliveryError } from './prompt-readiness-diagnostics.js'
import {
  SCRATCH_WORKSPACE_ID,
  scratchTopicIdFromWorkspacePath,
  workspaceOwnsSessionPath
} from '../shared/scratch-topics.js'

type RuntimeHost = {
  executionHost: ExecutionHost
  client: AgentMuxClient
  config: HostConfig
  unsubscribe: () => void
  historyObservationDisposers: Set<() => void>
}

type PreparedRuntimeHost = {
  id: string
  executionHost: ExecutionHost
  client: AgentMuxClient
  config: HostConfig
  warning?: RuntimeEndpointWarning
}

type SessionAttachmentOwner = {
  control: SessionControl
  controlIdentity: string
  attachmentIds: Set<string>
  refresh?: Promise<SessionAttachResult>
}

type SessionAttachmentLease = {
  key: string
  webContentsId: number
}

export type RuntimePreparation = {
  hosts: PreparedRuntimeHost[]
  removedHostIds: string[]
  hostSignatures: Map<string, string>
  reservedHostIds: string[]
  runtimeBindings?: Map<string, string>
  configs?: HostConfig[]
  launcherUpdates?: {
    config: HostConfig & { kind: 'ssh'; runtimeId: string }
    client: AgentMuxSshHostedClient
    expectedSignature: string
  }[]
}

function runtimeOwner(client: AgentMuxClient) {
  return 'runtimeOwnerIdentity' in client ? client.runtimeOwnerIdentity() : null
}

function isSshHostedClient(client: AgentMuxClient): client is AgentMuxSshHostedClient {
  return 'setRemoteCommand' in client && typeof client.setRemoteCommand === 'function'
}

function endpointWarning(hostId: string, step: string, error: unknown): RuntimeEndpointWarning {
  return {
    hostId, step, availability: step === 'Saving Runtime binding' ? 'connected' : 'unverified',
    code: error instanceof AgentMuxError ? error.code : 'RUNTIME_UNAVAILABLE',
    message: error instanceof Error ? error.message : String(error),
    recovery: 'Restore this endpoint connection and retry. Keep its original Session and work surface; inspect an unconfirmed operation before sending it again.'
  }
}

function observationWarning(hostId: string, step: string, error: unknown, connected: boolean): RuntimeEndpointWarning {
  return { ...endpointWarning(hostId, step, error), scope: 'observation', availability: connected ? 'connected' : 'unverified',
    recovery: 'Retry this observation on its original Host. Keep its original Sessions and work surface; no execution is replayed.' }
}

function hostSignature({ label: _label, ...host }: HostConfig): string {
  if (host.kind === 'ssh') {
    const { runtimeId: _runtimeId, ...route } = host
    return JSON.stringify(route)
  }
  return JSON.stringify(host)
}

function signatures(config: AppConfig): Map<string, string> {
  return new Map(config.hosts.map(host => [host.id, hostSignature(host)]))
}

function workspaceLabel(config: AppConfig, hostId: string, path: string): string {
  return config.workspaces.find((workspace) => workspaceOwnsSessionPath(workspace, {
    hostId,
    workspacePath: path
  }))?.name
    ?? path.split(/[\\/]/).filter(Boolean).at(-1)
    ?? path
}

/**
 * The Provider·Workspace derived name — the LOWEST tier of the display-name priority chain (see the
 * renderer's `display-name.ts`). This is the ONE place that builds that string; it rides on `session.label`
 * and the renderer consumes it verbatim as the chain's fallback, never re-deriving it. Every agent Session
 * and recovery candidate takes its label from here so the three sites cannot drift apart.
 */
function agentFallbackLabel(
  config: AppConfig,
  session: { executorId: AgentExecutorId; providerId: AgentProviderId; hostId: string; workspacePath: string }
): string {
  const configuredExecutor = Object.hasOwn(config.executors, session.executorId) ? config.executors[session.executorId] : undefined
  const executorLabel = configuredExecutor?.providerId === session.providerId
    ? configuredExecutor.label
    : session.executorId
  return `${executorLabel} · ${workspaceLabel(config, session.hostId, session.workspacePath)}`
}

function terminalInputKey(hostId: string, runId: string): string {
  return JSON.stringify([hostId, runId])
}

function requireSessionExecutor(
  config: AppConfig,
  session: { executorId: AgentExecutorId; providerId: AgentProviderId }
): AppConfig['executors'][AgentExecutorId] {
  const executor = Object.hasOwn(config.executors, session.executorId) ? config.executors[session.executorId] : undefined
  if (!executor) throw new Error(`Missing Agent Executor configuration: ${session.executorId}`)
  if (executor.providerId !== session.providerId) {
    throw new Error(
      `Agent Executor ${session.executorId} is bound to Provider ${executor.providerId}, ` +
      `but this Session uses Provider ${session.providerId}. Create a new Executor instead of changing its Provider.`
    )
  }
  return executor
}

function sessionAttachmentKey(control: SessionControl): string {
  return JSON.stringify([control.hostId, control.run.runId])
}

function sessionControlIdentity(control: SessionControl): string {
  return JSON.stringify([
    control.kind,
    control.hostId,
    control.kind === 'agent' ? control.agentSessionId : control.runId,
    control.run.runId
  ])
}

function sessionAttachmentHostId(key: string): string {
  const value = JSON.parse(key) as unknown
  if (!Array.isArray(value) || typeof value[0] !== 'string') {
    throw new Error('Invalid internal Session Attachment key.')
  }
  return value[0]
}

/**
 * 从一个 client 的 Provider registry 取能力声明——快照里每一处 `capabilities` 的唯一来源。
 *
 * 为什么是这个具名函数、而不是让每个调用方自己写那句 `client.providers.get(id).catalog.capabilities`：
 * 那句查询此前在三个地方各抄一份（两个 `projectSession` 调用点，加 `recoveryCandidates` 自己那一处）。
 * 手抄的查询会漂移（一处改成读别的字段、一处忘了改），而"能力声明从 Provider 自己的 catalog 来"是
 * **一条规则**，只该有一个取值点。registry 的 `get` 对未知 id 抛 `UNKNOWN_PROVIDER`，所以取不到能力时
 * 是响亮失败，不会退化成一份"什么都不支持"的假声明。
 */
function providerCapabilitiesFrom(
  client: AgentMuxClient
): (providerId: AgentProviderId) => AgentCapabilities {
  return (providerId) => client.providers.get(providerId).catalog.capabilities
}

function projectSession(
  subject: AgentMuxRuntimeSubject,
  config: AppConfig,
  // 「这个 Provider 声明了什么能力」的取值口。收成一个 resolver 而不是一个可选的 `capabilities` 值：
  // 可选值那种写法要求每个调用方自己写 `kind === 'agent' ? 查一下 : undefined`，于是同一句查询在两个
  // 调用点各抄一份，而 terminal 分支传的 undefined 又逼这里留一份手写的兜底 capabilities 字面量。
  // 那份字面量对 agent 恒不可达（两个调用点都传真 catalog），却是全仓第三份手抄的 `AgentCapabilities`
  // ——实测把它四个取值全改，runtime-controller 那 42 条与整套 desktop 测试都全绿。
  //
  // 换成 resolver 之后：agent 分支必须调它才拿得到能力（拿不到就是 UNKNOWN_PROVIDER 响亮地抛，不是
  // 静默退化成一份"什么都不支持"的假声明），terminal 分支根本不调，于是兜底字面量没有存在的理由。
  capabilitiesFor: (providerId: AgentProviderId) => AgentCapabilities
): SessionSnapshot {
  const run = subject.run
  const observedAt = run.observedAt
  // 「进程事实 → 界面那一行状态」只有一个答案，走 Core 的共享投影。这里只负责把快照的字段形状取出来。
  // 曾经这段是本地手写的：于是它带 `signal SIGSEGV` 的 detail 而实时路径（session-state 收
  // process-state 事件那处）整段没有，同一个崩掉的 Agent 在场时看不到信号、reload 之后反而看到了。
  //
  // 三条退出事实走 runExitFacts 而不是在这里逐条 spread：那三行此前在两条路径上各抄一份，于是漏抄
  // 一行没有任何东西会红——`exitSignal` 和 `exitReason` 各自独立地漏过一次。本地只保留快照形状独有的
  // 部分（source 在这条路上恒为 'run-process'，因为快照本身就是进程台账）。
  const processStatus = projectRunProcessStatus({
    state: run.state,
    source: 'run-process',
    observedAt,
    ...runExitFacts(run)
  })
  if (subject.kind === 'agent') {
    // 「哪些来源的状态压得过裸进程投影」这条判据走 Core 的共享谓词，而不是在这里写「字段在场就保留」。
    // 在场判定与实时路径（session-state.ts）的来源白名单今天等价，纯属巧合——`semanticStatus` 的唯二
    // 写入方恰好就是那两个活动来源。新增第三个活动来源时，在场判定会自动接纳，而那边的白名单会把它
    // 覆盖成裸 running：同一个 Agent 在场看 running、reload 看 waiting，且两侧都不会红（实测把这里
    // 收窄成只认 native-hook，93 条全绿）。两侧现在同判一次，新增来源只需在 Core 那张表里表态一次。
    const semanticFacts = subject.agentSession.semanticStatus
    const semantic = currentAgentSemanticStatus(semanticFacts)
    const pending = subject.agentSession.pendingInteraction
    const activeRequest = agentInteractionActiveRequest(pending)
    const unavailableReason = pending ? agentInteractionResponseUnavailableReason(pending) : undefined
    const status = run.state === 'running' && semantic && isAgentActivityStatusSource(semantic.source)
      ? structuredClone(semantic)
      : processStatus
    return {
      id: subject.agentSession.agentSessionId,
      kind: 'agent',
      providerId: subject.providerId,
      executorId: subject.executorId,
      ...projectNativeSourceFacts(subject.agentSession),
      ...(subject.agentSession.hookIngressObservation
        ? { hookIngressObservation: structuredClone(subject.agentSession.hookIngressObservation) }
        : {}),
      ...(subject.agentSession.nativeHandle
        ? { nativeSessionId: subject.agentSession.nativeHandle.sessionId }
        : {}),
      capabilities: capabilitiesFor(subject.providerId),
      ...(semanticFacts ? { semanticStatus: structuredClone(semanticFacts) } : {}),
      hostId: subject.hostId,
      workspacePath: subject.workspacePath,
      label: agentFallbackLabel(config, subject),
      createdAt: subject.agentSession.createdAt,
      updatedAt: Math.max(subject.agentSession.updatedAt, observedAt),
      agentSessionUpdatedAt: subject.agentSession.updatedAt,
      // The posture the create fixed at spawn. Projected as ids only: a surface resolves them against
      // the Provider's own catalog declaration for labels, so the argv stays in Core. Absent when the
      // create narrowed nothing, which a surface must show as "no scope declared" rather than a guess.
      ...(subject.agentSession.launchOptions
        ? { launchOptions: subject.agentSession.launchOptions }
        : {}),
      ...(subject.agentSession.terminalCapability
        ? { terminalCapability: structuredClone(subject.agentSession.terminalCapability) }
        : {}),
      ...(subject.agentSession.terminalPromptDelivery
        ? { terminalPromptDelivery: structuredClone(subject.agentSession.terminalPromptDelivery) }
        : {}),
      ...(subject.agentSession.creation ? { creation: structuredClone(subject.agentSession.creation) } : {}),
      ...(subject.agentSession.forkedFrom ? { forkedFrom: structuredClone(subject.agentSession.forkedFrom) } : {}),
      promptSubmissionPredecessor: agentPromptPredecessor(subject.agentSession),
      promptInputNotApplied: agentPromptNotApplied(subject.agentSession),
      ...(subject.agentSession.terminalOutputChannel
        ? { terminalOutputChannel: structuredClone(subject.agentSession.terminalOutputChannel) }
        : {}),
      processState: run.state,
      ...runInterruptionFact(run),
      status,
      ...(activeRequest ? { pendingInteraction: structuredClone(activeRequest) } : {}),
      ...(pending?.response && activeRequest?.id !== pending.request.id ? { completedInteractionResponse: {
        requestId: pending.request.id, operationId: pending.response.operationId, acknowledged: pending.response.acknowledged
      } } : {}),
      ...(unavailableReason ? { interactionResponseUnavailableReason: unavailableReason } : {}),
      // 最近一 turn 的真实原生用量，随收尾事件的 hook 回执落在会话上。缺席就不投影，UI 据此显示
      // "此 Provider 不报 token 用量"或"还没有一 turn 的用量"，绝不落成 0。
      ...(subject.agentSession.turnUsage
        ? { turnUsage: structuredClone(subject.agentSession.turnUsage) }
        : {}),
      latestOutputBytes: run.latestOutputBytes,
      nativeService: run.nativeService,
      control: {
        kind: 'agent',
        hostId: subject.hostId,
        agentSessionId: subject.agentSession.agentSessionId,
        run: { ...subject.agentSession.run }
      }
    }
  }
  return {
    id: run.runId,
    kind: 'terminal',
    providerId: null,
    hostId: subject.hostId,
    workspacePath: subject.workspacePath,
    label: `Terminal · ${workspaceLabel(config, subject.hostId, subject.workspacePath)}`,
    createdAt: run.observedAt,
    updatedAt: observedAt,
    processState: run.state,
    ...runInterruptionFact(run),
    status: processStatus,
    latestOutputBytes: run.latestOutputBytes,
    nativeService: run.nativeService,
    control: {
      kind: 'terminal',
      hostId: subject.hostId,
      runId: run.runId,
      run: { runId: run.runId }
    }
  }
}

async function disposePrepared(hosts: readonly PreparedRuntimeHost[]): Promise<void> {
  const results = await Promise.allSettled(hosts.flatMap((host) => [
    host.client.dispose(),
    host.executionHost.dispose()
  ]))
  const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
  if (errors.length > 0) throw new AggregateError(errors, 'Failed to dispose prepared Runtime hosts.')
}

export class RuntimeController {
  private readonly hosts = new Map<string, RuntimeHost>()
  private readonly toolkitRuns = new Map<string, (event: AgentMuxClientEvent) => void>()
  private readonly clients = new Set<WebContents>()
  private readonly sessionAttachmentOwners = new Map<string, SessionAttachmentOwner>()
  private readonly sessionAttachmentLeases = new Map<string, SessionAttachmentLease>()
  private readonly sessionAttachmentTails = new Map<string, Promise<void>>()
  // SDK replay cannot currently be canceled. Keep one pending read per exact Run even if a
  // timed-out pane is recreated; a client deadline must not accumulate transient attachments.
  private readonly sessionReplayReads = new Map<string, Promise<SessionReplayResult>>()
  private readonly rendererGenerations = new Map<number, number>()
  private readonly hostLifecycleOperations = new Map<string, Set<Promise<void>>>()
  private readonly hostReconfigurationReservations = new Set<string>()
  private readonly executorConfigReservations = new Set<string>()
  private readonly admittedExecutorLaunches = new Map<string, number>()
  private readonly terminalInputCursors = new Map<string, number | null>()
  private readonly terminalInputTails = new Map<string, Promise<void>>()
  private readonly terminalColorQueryRemainders = new Map<string, string>()
  private readonly pendingAgentColorQueryReplies = new Map<string, string>()
  private readonly readyAgentColorQueryRuns = new Map<string, string>()
  private terminalViewColors: TerminalOscColorQueryReplyColors = {
    foreground: '#ffffff',
    background: '#000000'
  }
  private hostSignatures = new Map<string, string>()
  private readonly endpointWarnings = new Map<string, RuntimeEndpointWarning>()
  private readonly observationWarnings = new Map<string, RuntimeEndpointWarning>()
  private readonly endpointConnections = new Map<AgentMuxClient, Promise<void>>()

  constructor(
    private readonly agentSessionStore: AgentMuxAgentSessionStore,
    private readonly connectRuntimeClient: DesktopRuntimeConnector,
    private readonly scratchTopics: ScratchTopics = new ScratchTopics(),
    /**
     * 进程资源采样器。挂在 controller 上是因为 pid 从这条事件流上流过；采样本身仍由订阅
     * 驱动，没人看面板时它一次 `ps` 都不会起。可注入是为了让测试喂假的 `ps` 输出——
     * 否则只能给它开一个测试专用的取数口，那条口用户永远不走，坏了也不会有人知道。
     */
    readonly resourceSampler: ProcessResourceSampler = new ProcessResourceSampler()
  ) {}

  setTerminalViewColors(colors: TerminalOscColorQueryReplyColors): void {
    this.terminalViewColors = { ...colors }
  }

  private readonly inputPerformance = createInputPerformanceRecorder()
  private readonly performanceObservation = new MainPerformanceDiagnostics()

  async performanceDiagnostics(signal: AbortSignal) {
    return this.performanceObservation.observe([...this.hosts.values()], () => ({ processId: process.pid, observedAt: Date.now(),
      input: this.inputPerformance.snapshot(), carrier: hostedCarrierPerformance.snapshot() }), signal)
  }

  resourceOwnerCounts(): { sessionAttachmentOwners: number; sessionAttachmentLeases: number } {
    return {
      sessionAttachmentOwners: this.sessionAttachmentOwners.size,
      sessionAttachmentLeases: this.sessionAttachmentLeases.size
    }
  }

  /** Observe already-connected owners; this never reconnects, stops, attaches, or removes a Run. */
  async resourceUsageObservation(): Promise<RuntimeUsage[]> {
    const hosts = [...this.hosts]
    const storage = new Map<string, Promise<Pick<RuntimeUsage, 'runtimeStorage' | 'runtimeStorageUnavailable' | 'runtimeStorageObservedAt'>>>()
    const observeStorage = async (client: AgentMuxClient) => {
      try {
        const directory = (await client.runtimeDiagnostics()).ctxmux.state.servingDirectory
        if (directory === null) return { runtimeStorage: null, runtimeStorageUnavailable: 'Current Runtime state directory is unverified', runtimeStorageObservedAt: null }
        if (!storage.has(directory)) storage.set(directory, runtimeStorageUsage(directory).then(
          (runtimeStorage) => ({ runtimeStorage, runtimeStorageUnavailable: null, runtimeStorageObservedAt: Date.now() }),
          (error: unknown) => ({ runtimeStorage: null, runtimeStorageUnavailable: error instanceof Error ? error.message : String(error), runtimeStorageObservedAt: null })
        ))
        return await storage.get(directory)!
      } catch (error) {
        return { runtimeStorage: null, runtimeStorageUnavailable: error instanceof Error ? error.message : String(error), runtimeStorageObservedAt: null }
      }
    }
    return await Promise.all(hosts.map(async ([hostId, { client, executionHost }]): Promise<RuntimeUsage> => {
      const [resources, endpoint] = await Promise.all([
        client.runtimeResourceSnapshot().then(
          (resources) => ({ resources, unavailable: null }),
          (error: unknown) => ({ resources: null, unavailable: error instanceof Error ? error.message : String(error) })
        ),
        executionHost.kind === 'local'
          ? observeStorage(client)
          : Promise.resolve({ runtimeStorage: null, runtimeStorageUnavailable: 'Remote Runtime storage is unavailable', runtimeStorageObservedAt: null })
      ])
      return {
        hostId,
        ...resources,
        ...endpoint,
        process: {
          cpuPercent: null,
          rssKib: null,
          unavailable: 'ctxmux does not publish its daemon PID'
        }
      }
    }))
  }

  async prepare(config: AppConfig): Promise<RuntimePreparation> {
    const nextSignatures = signatures(config)
    for (const next of config.hosts) {
      if (next.kind !== 'ssh' || !next.runtimeId) continue
      const existing = this.hosts.get(next.id)
      const known = (existing ? runtimeOwner(existing.client) : null)?.runtimeId ??
        (existing?.config.kind === 'ssh' ? existing.config.runtimeId : undefined)
      if (known && known !== next.runtimeId) {
        throw new AgentMuxError(`Runtime binding is immutable for ${next.id}. Configure another endpoint for a different Runtime.`, 'RUNTIME_OWNER_MISMATCH')
      }
    }
    const changed = config.hosts.filter(
      (host) => this.hostSignatures.get(host.id) !== nextSignatures.get(host.id)
    )
    const launcherUpdates: NonNullable<RuntimePreparation['launcherUpdates']> = changed.flatMap(next => {
      const existing = this.hosts.get(next.id), expectedSignature = this.hostSignatures.get(next.id)
      if (next.kind !== 'ssh' || !next.runtimeId || existing?.config.kind !== 'ssh' ||
        existing.config.runtimeId !== next.runtimeId || expectedSignature === undefined ||
        existing.config.remoteCommand === next.remoteCommand || !isSshHostedClient(existing.client)) return []
      const { remoteCommand: _nextCommand, ...nextRoute } = next
      const { remoteCommand: _previousCommand, ...previousRoute } = existing.config
      if (hostSignature(nextRoute) !== hostSignature(previousRoute)) return []
      return [{ config: { ...next, runtimeId: next.runtimeId }, client: existing.client, expectedSignature }]
    })
    const launcherHostIds = new Set(launcherUpdates.map(update => update.config.id))
    const removedHostIds = [...this.hostSignatures.keys()].filter((id) => !nextSignatures.has(id))
    const reservedHostIds = [...new Set([
      ...removedHostIds,
      ...changed.flatMap((host) => this.hosts.has(host.id) && !launcherHostIds.has(host.id) ? [host.id] : [])
    ])]
    const acquiredHostIds: string[] = []
    for (const hostId of reservedHostIds) {
      if (this.hostReconfigurationReservations.has(hostId)) {
        for (const acquired of acquiredHostIds) this.hostReconfigurationReservations.delete(acquired)
        throw new Error(`Runtime host reconfiguration is already in progress: ${hostId}`)
      }
      this.hostReconfigurationReservations.add(hostId)
      acquiredHostIds.push(hostId)
    }
    try {
      await Promise.all(reservedHostIds.map(async (hostId) => await this.waitForHostQuiescence(hostId)))
      await this.assertConfigurable(nextSignatures, launcherHostIds)
      const results = await Promise.allSettled(changed.map(async host => {
        const update = launcherUpdates.find(update => update.config.id === host.id)
        if (!update) return await this.prepareHost(host)
        // A slow or failed probe cannot reserve healthy input on the retained consumer.
        const probe = await this.prepareHost(update.config)
        try {
          await probe.client.connectRuntime()
          const owner = runtimeOwner(probe.client)
          if (owner?.availability !== 'connected' || owner.runtimeId !== update.config.runtimeId) {
            throw new AgentMuxError('The candidate launcher did not confirm the original Runtime. Its current connection and Runs were retained.', 'RUNTIME_OWNER_MISMATCH')
          }
          this.assertLauncherUpdateCurrent(update)
        } finally { await disposePrepared([probe]) }
        return undefined
      }))
      const prepared = results.flatMap((result) => result.status === 'fulfilled' && result.value ? [result.value] : [])
      const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
      if (errors.length > 0) {
        try {
          await disposePrepared(prepared)
        } catch (cleanupError) {
          throw new AggregateError([...errors, cleanupError], 'Runtime preparation and cleanup both failed.')
        }
        if (errors.length === 1) throw errors[0]
        throw new AggregateError(errors, 'Multiple Runtime hosts failed preparation.')
      }
      const candidates = [...this.hosts.entries()].filter(([id]) => nextSignatures.has(id) &&
        !prepared.some(host => host.id === id)).map(([id, host]) => ({ id, ...host, warning: this.endpointWarnings.get(id) }))
      const runtimeBindings = new Map([...candidates, ...prepared].flatMap(host => {
        const identity = runtimeOwner(host.client)
        return host.config.kind === 'ssh' && identity?.availability === 'connected' && (!host.warning || host.warning.availability === 'connected')
          ? [[host.id, identity.runtimeId] as const] : []
      }))
      const boundConfig = {
        ...config,
        hosts: config.hosts.map(host => host.kind === 'ssh' && runtimeBindings.has(host.id)
          ? { ...host, runtimeId: runtimeBindings.get(host.id)! } : host)
      }
      return {
        hosts: prepared,
        removedHostIds,
        hostSignatures: signatures(boundConfig),
        reservedHostIds,
        launcherUpdates,
        runtimeBindings,
        configs: boundConfig.hosts
      }
    } catch (error) {
      for (const hostId of reservedHostIds) this.hostReconfigurationReservations.delete(hostId)
      throw error
    }
  }

  commit(preparation: RuntimePreparation): void {
    try {
      for (const update of preparation.launcherUpdates ?? []) this.assertLauncherUpdateCurrent(update)
      for (const update of preparation.launcherUpdates ?? []) update.client.setRemoteCommand(update.config.remoteCommand)
      const retired = new Map<string, RuntimeHost>()
      for (const id of preparation.removedHostIds) {
        const host = this.hosts.get(id)
        if (host) retired.set(id, host)
        this.hosts.delete(id)
        this.endpointWarnings.delete(id)
        this.clearHostObservationWarnings(id)
      }
      for (const prepared of preparation.hosts) {
        const previous = this.hosts.get(prepared.id)
        if (previous) retired.set(prepared.id, previous)
        this.clearHostObservationWarnings(prepared.id)
        const unsubscribe = prepared.client.onEvent((event) => {
          if (this.hosts.get(prepared.id)?.client === prepared.client) this.publish(prepared.id, event)
        })
        this.hosts.set(prepared.id, { ...prepared, unsubscribe, historyObservationDisposers: new Set() })
        if (prepared.warning) this.endpointWarnings.set(prepared.id, prepared.warning)
        else this.endpointWarnings.delete(prepared.id)
      }
      for (const config of preparation.configs ?? []) {
        const host = this.hosts.get(config.id)
        if (host) host.config = config
      }
      this.hostSignatures = preparation.hostSignatures
      for (const hostId of preparation.runtimeBindings?.keys() ?? []) {
        if (this.endpointWarnings.get(hostId)?.step === 'Saving Runtime binding') this.endpointWarnings.delete(hostId)
      }
      for (const prepared of preparation.hosts) {
        if ('runtimeOwnerIdentity' in prepared.client) this.connectEndpointInBackground(prepared.id, prepared.client)
      }
      for (const [id, host] of retired) {
        for (const release of host.historyObservationDisposers) release()
        host.unsubscribe()
        void disposePrepared([{ id, executionHost: host.executionHost, client: host.client, config: host.config }]).catch((error) => {
          console.error(`Failed to dispose retired Runtime host ${id}`, error)
        })
      }
    } finally {
      for (const hostId of preparation.reservedHostIds) {
        this.hostReconfigurationReservations.delete(hostId)
      }
    }
  }

  async discard(preparation: RuntimePreparation): Promise<void> {
    try {
      await disposePrepared(preparation.hosts)
    } finally {
      for (const hostId of preparation.reservedHostIds) {
        this.hostReconfigurationReservations.delete(hostId)
      }
    }
  }

  attach(client: WebContents): () => void {
    this.clients.add(client)
    if (!this.rendererGenerations.has(client.id)) this.rendererGenerations.set(client.id, 0)
    const releaseAttachments = (): void => {
      this.rendererGenerations.set(client.id, (this.rendererGenerations.get(client.id) ?? 0) + 1)
      void this.releaseSessionAttachments(client.id).catch((error) => {
        console.error('Failed to release Renderer-owned Session Attachments', error)
      })
    }
    const onNavigation = (details: { isMainFrame?: boolean; isSameDocument?: boolean }): void => {
      if (details.isMainFrame === false || details.isSameDocument) return
      releaseAttachments()
    }
    client.on('did-start-navigation', onNavigation)
    client.on('render-process-gone', releaseAttachments)
    client.on('destroyed', releaseAttachments)
    return () => {
      client.off('did-start-navigation', onNavigation)
      client.off('render-process-gone', releaseAttachments)
      client.off('destroyed', releaseAttachments)
      this.clients.delete(client)
      releaseAttachments()
    }
  }

  /** Read the existing navigation owner; absence is not a ready Renderer. */
  rendererGeneration(client: WebContents): number | null {
    return this.clients.has(client) && !client.isDestroyed() ? this.rendererGenerations.get(client.id) ?? null : null
  }

  /** Cached public identities from connected hosts only; no lifecycle or probing action. */
  connectedRuntimeIdentities() {
    return [...this.hosts].flatMap(([hostId, host]) => {
      try { return [{ hostId, identity: host.client.runtimeIdentity() }] }
      catch { return [] }
    })
  }

  executionHost(hostId: string): ExecutionHost {
    const host = this.hosts.get(hostId)
    if (!host) throw new Error(`Runtime host is not configured: ${hostId}`)
    return host.executionHost
  }

  async checkHost(config: HostConfig): Promise<{ detail: string }> {
    let prepared: PreparedRuntimeHost | null = null
    try {
      prepared = await this.prepareHost(config)
      await prepared.client.connect()
      const identity = prepared.client.runtimeIdentity()
      return {
        detail: `Runtime ${identity.buildIdentity} · protocol ${identity.protocolVersion}`
      }
    } finally {
      if (prepared) await disposePrepared([prepared])
    }
  }

  async providerCatalog(options: { observation: true }): Promise<ProviderCatalogObservation>
  async providerCatalog(): Promise<AgentCatalogEntry[]>
  async providerCatalog(options?: { observation: true }): Promise<AgentCatalogEntry[] | ProviderCatalogObservation> {
    const hosts = [...this.hosts]
    const step = 'Reading Provider catalog'
    const warnings = new Map<string, RuntimeEndpointWarning>()
    const results = await Promise.allSettled(hosts.map(async ([hostId, host]) => {
      let connected = false
      try {
        if (options?.observation) this.assertObservationHostConnection(hostId, host)
        if (host.config.kind !== 'local') {
          await host.client.connect()
          connected = true
        }
        if (this.hosts.get(hostId) !== host) throw new AgentMuxError('The execution Host changed while reading its Provider catalog.', 'EXECUTOR_HOST_CHANGED')
        const entries = host.client.providers.catalog()
        this.observationWarnings.delete(JSON.stringify([hostId, step]))
        return entries
      } catch (error) {
        const warning = observationWarning(hostId, step, error, connected)
        warnings.set(hostId, warning)
        if (this.hosts.get(hostId) === host) this.observationWarnings.set(JSON.stringify([hostId, step]), warning)
        throw error
      }
    }))
    const current = results.filter((result, index) => result.status === 'fulfilled' && this.hosts.get(hosts[index]![0]) === hosts[index]![1])
    if (hosts.length && !current.length) {
      const failure = results.find(result => result.status === 'rejected')
      throw failure?.status === 'rejected' ? failure.reason : new AgentMuxError('The execution Hosts changed while reading their Provider catalogs.', 'EXECUTOR_HOST_CHANGED')
    }
    for (const [index, result] of results.entries()) if (result.status === 'fulfilled' && this.hosts.get(hosts[index]![0]) !== hosts[index]![1]) {
      const hostId = hosts[index]![0]
      warnings.set(hostId, observationWarning(hostId, step,
        new AgentMuxError('The execution Host changed while reading its Provider catalog.', 'EXECUTOR_HOST_CHANGED'), false))
    }
    const catalog = new Map<string, AgentCatalogEntry>()
    for (const result of current) {
      if (result.status !== 'fulfilled') continue
      for (const entry of result.value) {
        if (!catalog.has(entry.id)) catalog.set(entry.id, entry)
      }
    }
    const entries = [...catalog.values()]
    return options?.observation ? { catalog: entries, warnings: [...warnings.values()] } : entries
  }

  async discoverExecutors(hostId: string): Promise<import('../shared/contracts.js').HostExecutorInventory> {
    const host = this.hosts.get(hostId)
    if (!host) throw new AgentMuxError('The exact execution Host is not configured.', 'UNKNOWN_HOST')
    const inventory = await host.client.listHostExecutors({ refresh: true })
    if (this.hosts.get(hostId) !== host) throw new AgentMuxError('The execution Host changed while reading its Executor inventory. Refresh this Host.', 'EXECUTOR_HOST_CHANGED')
    return { routeHostId: hostId, ...inventory }
  }

  async configureExecutor(hostId: string, input: import('@agentmux/core').AgentMuxHostExecutorConfigureInput): Promise<import('../shared/contracts.js').HostExecutorConfiguration> {
    const host = this.hosts.get(hostId)
    if (!host) throw new AgentMuxError('The exact execution Host is not configured.', 'UNKNOWN_HOST')
    if (this.hosts.get(hostId) !== host) throw new AgentMuxError('The execution Host changed before saving its Executor. Inspect this Host before another explicit save.', 'EXECUTOR_HOST_CHANGED')
    return { routeHostId: hostId, ...await host.client.configureHostExecutor(input) }
  }

  async detect(executorId: AgentExecutorId, hostId: string, config: AppConfig): Promise<ExecutorDetection> {
    const executor = Object.hasOwn(config.executors, executorId) ? config.executors[executorId] : undefined
    if (!executor) throw Object.assign(new Error(`Agent Executor not found: ${executorId}`), { code: 'SETTING_RESOURCE_NOT_FOUND' })
    const host = config.hosts.find((item) => item.id === hostId)
    if (!host) throw Object.assign(new Error(`Host not found: ${hostId}`), { code: 'SETTING_RESOURCE_NOT_FOUND' })
    const input = structuredClone({
      executorId,
      providerId: executor.providerId,
      command: executor.command,
      host
    })
    const owner = this.hosts.get(hostId)
    const signature = hostSignature(input.host)
    let executable: string | undefined
    // Only this diagnostic requires a stable connection owner. Existing input routes keep their own contract.
    const assertOwner = (): RuntimeHost => {
      if (!owner || this.hosts.get(hostId) !== owner || this.hostSignatures.get(hostId) !== signature || this.hostReconfigurationReservations.has(hostId)) {
        throw Object.assign(new Error(`Host ${hostId} connection is unavailable or changed during the executable check. Refresh this check.`), { code: 'EXECUTOR_HOST_CHANGED' })
      }
      return owner
    }
    try {
      const current = assertOwner()
      if (current.config.kind !== 'local') await current.client.connect()
      assertOwner()
      const result = await current.client.probeExecutorAvailability(input.providerId, input.command)
      executable = result.executable
      assertOwner()
      return { input, ...result }
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
        ? error.code : 'EXECUTOR_CHECK_FAILED'
      return { input, availability: 'check-failed', ...(executable === undefined ? {} : { executable }),
        cause: { code, message: error instanceof Error ? error.message : String(error) } }
    }
  }

  async snapshot(config: AppConfig): Promise<RuntimeSnapshot> {
    const sessionNames = this.readSessionNames(config)
    const hosts = [...this.hosts]
    const unobservedWarnings = new Map<string, RuntimeEndpointWarning>()
    const results = await Promise.allSettled(hosts.map(async ([hostId, { client, config: hostConfig }]) => {
      if (hostConfig.kind === 'ssh' && runtimeOwner(client)?.availability !== 'connected') {
        const warning = this.endpointWarnings.get(hostId) ?? endpointWarning(hostId, 'Connecting to Runtime',
          new AgentMuxError('The endpoint has not completed its trusted Runtime connection. Other endpoints remain available.', 'RUNTIME_UNAVAILABLE'))
        unobservedWarnings.set(hostId, warning)
        // An established owner's lost stream already owns bounded reconnect and restoration.
        // Only the first observation needs Main's initial connection notification.
        if (!runtimeOwner(client)) this.connectEndpointInBackground(hostId, client)
        throw new AgentMuxError(warning.message, warning.code)
      }
      await this.connectedClient(hostId)
      if (this.hosts.get(hostId)?.client !== client) throw new Error('Runtime endpoint changed during its observation.')
      let projection = await client.runtimeProjection()
      while (true) {
        const agentSubjects = projection.subjects.filter((subject): subject is Extract<AgentMuxRuntimeSubject, { kind: 'agent' }> => (
          subject.kind === 'agent'
        ))
        const timelineResults = await Promise.allSettled(agentSubjects.map(async (subject) => {
          const timeline = await client.sessionTimeline(subject.agentSession.agentSessionId)
          if (timeline.agentSessionId !== subject.agentSession.agentSessionId) {
            throw new AgentMuxError(`Runtime snapshot returned a Timeline for another Session: ${timeline.agentSessionId}`, 'TIMELINE_IDENTITY_MISMATCH')
          }
          return timeline
        }))
        const timelineEntries = timelineResults.flatMap((result, index) => {
          if (result.status === 'rejected') return []
          const agentSessionId = agentSubjects[index]!.agentSession.agentSessionId
          return [[agentSessionId, result.value] as const]
        })
        const failures = timelineResults.flatMap((result, index) => result.status === 'rejected'
          ? [{ agentSessionId: agentSubjects[index]!.agentSession.agentSessionId, reason: result.reason }]
          : [])
        if (failures.length === 0) return { hostId, client, projection, timelineEntries, timelineFailures: [] }

        // Membership was already observed independently of these optional display reads.
        // Recheck a possible removal, but another failed observation cannot revoke that cut.
        let refreshed: Awaited<ReturnType<AgentMuxClient['runtimeProjection']>>
        try {
          refreshed = await client.runtimeProjection()
        } catch {
          return { hostId, client, projection, timelineEntries, timelineFailures: failures }
        }
        const refreshedAgentIds = new Set(refreshed.subjects.flatMap((subject) => (
          subject.kind === 'agent' ? [subject.agentSession.agentSessionId] : []
        )))
        if (failures.every((failure) => refreshedAgentIds.has(failure.agentSessionId))) {
          return { hostId, client, projection, timelineEntries, timelineFailures: failures }
        }
        projection = refreshed
      }
    }))
    const projections = results.flatMap((result, index) => {
      if (result.status === 'fulfilled') {
        if (this.endpointWarnings.get(result.value.hostId)?.step !== 'Saving Runtime binding') {
          this.endpointWarnings.delete(result.value.hostId)
        }
        return [result.value]
      }
      const hostId = hosts[index]![0]
      if (!unobservedWarnings.has(hostId) && this.hosts.get(hostId)?.client === hosts[index]![1].client) {
        this.endpointWarnings.set(hostId, endpointWarning(hostId, 'Reading Runtime state', result.reason))
      }
      return []
    })
    for (const { hostId, projection } of projections) {
      for (const subject of projection.subjects) {
        if (subject.kind !== 'terminal') continue
        this.terminalInputCursors.set(
          terminalInputKey(hostId, subject.run.runId),
          subject.run.acceptedInputBytes
        )
      }
    }
    const sessions = projections.flatMap(({ hostId, client, projection, timelineFailures }) => {
      const failures = new Map(timelineFailures.map(failure => [failure.agentSessionId, failure.reason]))
      return projection.subjects.map((subject) => {
        const session = projectSession({ ...subject, hostId }, config, providerCapabilitiesFrom(client))
        if (session.kind !== 'agent' || !failures.has(session.id)) return session
        const error = failures.get(session.id)
        return { ...session, timelineObservation: {
          run: { ...session.control.run },
          code: error instanceof AgentMuxError ? error.code : 'TIMELINE_OBSERVATION_FAILED',
          message: error instanceof Error ? error.message : String(error)
        } }
      })
    })
    const recoveryCandidates = projections.flatMap(({ hostId, client, projection }) => {
      // 与 sessions 同一个取值口。这条出口此前自己抄了一遍那句 registry 查询——两个都在投影
      // `capabilities`、都该按 Session 自己的 providerId 取，却是两份各自可漂移的表达式。
      const capabilitiesFor = providerCapabilitiesFrom(client)
      const projected = new Set(projection.subjects.flatMap((subject) => (
        subject.kind === 'agent' ? [subject.agentSession.agentSessionId] : []
      )))
      return client.agentSessions().flatMap((session): AgentSessionRecoveryCandidate[] => {
        if (projected.has(session.agentSessionId)) return []
        return [{
          agentSessionId: session.agentSessionId,
          hostId,
          workspacePath: session.workspacePath,
          providerId: session.providerId,
          executorId: session.executorId,
          ...projectNativeSourceFacts(session),
          ...(session.nativeHandle ? { nativeSessionId: session.nativeHandle.sessionId } : {}),
          capabilities: capabilitiesFor(session.providerId),
          ...(session.semanticStatus ? { semanticStatus: structuredClone(session.semanticStatus) } : {}),
          ...(session.terminalCapability
            ? { terminalCapability: structuredClone(session.terminalCapability) }
            : {}),
          label: agentFallbackLabel(config, { ...session, hostId }),
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          run: { ...session.run }
        }]
      })
    })
    const timelineEntries = projections.flatMap(({ timelineEntries: entries }) => entries)
    const runtimeOwnershipWarnings = projections.flatMap(({ hostId, client }) => (
      client.runtimeIdentity().ownership === 'unverified' ? [hostId] : []
    ))
    return {
      ...await sessionNames,
      sessions, timelines: Object.fromEntries(timelineEntries), recoveryCandidates,
      ...(runtimeOwnershipWarnings.length > 0 ? { runtimeOwnershipWarnings } : {}),
      // A background connection can finish while another endpoint is being read. This cut still
      // did not observe that endpoint; keep its warning until the restored event's fresh resync.
      runtimeEndpointWarnings: [...new Map([...this.endpointWarnings, ...unobservedWarnings]).values(), ...this.observationWarnings.values()]
    }
  }

  private async readSessionNames(config: AppConfig): Promise<Pick<RuntimeSnapshot, 'sessionNameMetadata' | 'sessionNameMetadataWarning'>> {
    const localHostIds = new Set<string>(config.hosts.filter(host => host.kind === 'local').map(host => host.id))
    if (localHostIds.size === 0) return {}
    try {
      // One catalogue read per complete snapshot, never per Host, label, or output event. The
      // original store also covers stale bindings and retirement without consulting a live Run.
      const sources = await loadSessionHistorySources(this.agentSessionStore)
      const sessionNameMetadata = sources.flatMap((source): AgentSessionNameMetadata[] => {
        if (!localHostIds.has(source.hostId) || !source.history) return []
        const { providerId, executorId, workspacePath } = source.history
        return [{
          agentSessionId: source.agentSessionId, hostId: source.hostId, providerId, executorId, workspacePath,
          state: source.state,
          label: agentFallbackLabel(config, { hostId: source.hostId, providerId, executorId, workspacePath })
        }]
      })
      return sessionNameMetadata.length > 0 ? { sessionNameMetadata } : {}
    } catch (error) {
      return { sessionNameMetadataWarning: {
        code: error instanceof AgentMuxError ? error.code : 'SESSION_NAME_METADATA_UNAVAILABLE',
        message: `Saved Session names could not be read: ${error instanceof Error ? error.message : String(error)}`,
        recovery: 'Refresh the Session snapshot to retry reading the original Session store. Existing Agents remain available.'
      } }
    }
  }

  /** Only dangerous template identity edits consult references; ordinary settings never wait here. */
  async reserveExecutorConfigEdit(current: AppConfig, next: AppConfig): Promise<() => void> {
    const changed = [...new Set([...Object.keys(current.executors), ...Object.keys(next.executors)])].filter((id) =>
      !Object.hasOwn(current.executors, id) || !Object.hasOwn(next.executors, id) ||
      current.executors[id]!.providerId !== next.executors[id]!.providerId)
    if (!changed.length) return () => {}
    for (const id of changed) this.executorConfigReservations.add(id)
    const release = () => { for (const id of changed) this.executorConfigReservations.delete(id) }
    try {
      for (const id of changed) {
        const existing = Object.hasOwn(current.executors, id) ? current.executors[id]! : undefined
        const requested = Object.hasOwn(next.executors, id) ? next.executors[id]! : undefined
        if (existing && requested && existing.providerId !== requested.providerId) {
          throw Object.assign(new Error(`Executor “${id}” has a fixed Provider. Choose a new Executor identity.`), { code: 'SETTING_IDENTITY_IMMUTABLE' })
        }
        if (!requested && (this.admittedExecutorLaunches.get(id) ?? 0) > 0) {
          throw Object.assign(new Error(`Executor “${id}” is used by an admitted launch. Keep this template until its launch completes.`), { code: 'SETTING_RESOURCE_IN_USE' })
        }
      }
      // Each original Runtime owns retained Session references, regardless of Run state.
      // Retired History is an independent descriptor, not a current Session reference.
      const sessions = (await Promise.all([...this.hosts].map(async ([hostId]) => {
        const client = this.hosts.get(hostId)!.client
        return (await client.sessionHistorySources()).flatMap(descriptor => descriptor.state === 'active' && descriptor.history ? [descriptor.history] : [])
      }))).flat()
      for (const id of changed) {
        const references = sessions.filter((session) => session.executorId === id)
        const requested = Object.hasOwn(next.executors, id) ? next.executors[id]! : undefined
        if (!requested && (references.length > 0 || (this.admittedExecutorLaunches.get(id) ?? 0) > 0)) {
          throw Object.assign(new Error(`Executor “${id}” is used by a retained Session or an admitted launch. Keep this template to preserve History and continuity.`), { code: 'SETTING_RESOURCE_IN_USE' })
        }
        if (requested && references.some((session) => session.providerId !== requested.providerId)) {
          throw Object.assign(new Error(`Executor “${id}” belongs to a different Provider in a retained Session. Choose a new Executor identity.`), { code: 'SETTING_IDENTITY_IMMUTABLE' })
        }
      }
      return release
    } catch (cause) {
      release()
      if (cause && typeof cause === 'object' && 'code' in cause &&
          (cause.code === 'SETTING_RESOURCE_IN_USE' || cause.code === 'SETTING_IDENTITY_IMMUTABLE')) throw cause
      throw Object.assign(new Error(`Cannot verify Executor references; this template change was not saved. ${cause instanceof Error ? cause.message : String(cause)}`), { code: 'SETTING_RESOURCE_REFERENCES_UNKNOWN' })
    }
  }

  async launchAgent(request: AgentLaunchInput, config: AppConfig): Promise<AgentLaunchResult> {
    if (!request.forkSource && config.hosts.find(host => host.id === request.hostId)?.kind === 'ssh') {
      return await this.launchAdmittedAgent(request, config)
    }
    if (this.executorConfigReservations.has(request.executorId)) {
      throw Object.assign(new Error(`Executor “${request.executorId}” is being changed. Retry this new launch after its save completes.`), { code: 'SETTING_RESOURCE_IN_USE' })
    }
    this.admittedExecutorLaunches.set(request.executorId, (this.admittedExecutorLaunches.get(request.executorId) ?? 0) + 1)
    try {
      return await this.launchAdmittedAgent(request, config)
    } finally {
      const remaining = this.admittedExecutorLaunches.get(request.executorId)! - 1
      if (remaining) this.admittedExecutorLaunches.set(request.executorId, remaining)
      else this.admittedExecutorLaunches.delete(request.executorId)
    }
  }

  private async launchAdmittedAgent(request: AgentLaunchInput, config: AppConfig): Promise<AgentLaunchResult> {
    return await this.trackHostLifecycleOperation(request.hostId, async () => {
      const client = await this.connectedClient(request.hostId)
      const remoteCreation = config.hosts.find(host => host.id === request.hostId)?.kind === 'ssh' && !request.forkSource
      const inventory = remoteCreation ? await client.listHostExecutors() : undefined
      const selected = inventory?.executors.find(executor => executor.executorId === request.executorId)
      const executor = remoteCreation ? selected : Object.hasOwn(config.executors, request.executorId) ? config.executors[request.executorId] : undefined
      if (!executor) throw new AgentMuxError(`Missing Executor on the selected Host: ${request.executorId}`, 'EXECUTOR_UNKNOWN')
      let preparedTopic: PreparedScratchAgentTopic | null = null
      let created: AgentLaunchResult['created']
      let creation: AgentLaunchResult['creation']
      try {
        if (request.scratchTopicId !== undefined) {
          if (!request.agentSessionId) {
            throw new Error('Scratch Topic launches require an Agent Session identity')
          }
          const scratch = config.workspaces.find((workspace) => workspace.id === SCRATCH_WORKSPACE_ID)
          if (!scratch || scratch.hostId !== request.hostId || scratch.path !== request.workspacePath) {
            throw new Error('Scratch Topic launch does not match the configured Scratch workspace')
          }
          preparedTopic = await this.scratchTopics.prepareAgent(scratch, request.scratchTopicId, {
            providerId: executor.providerId,
            sessionId: request.agentSessionId
          })
        }
        // Topic 说明是 AgentMux 自己的话，作为 agentMuxNote 交给 Core 的出口署名进信封；
        // 用户的真实请求原样留在 prompt（user 段）。desktop 不自己拼信封，也不再把两者混成一段。
        const profileContext = profileAgentContext(config.profile)
        const agentMuxNote = [preparedTopic?.prompt, request.agentMuxNote, profileContext].filter(note => note?.trim()).join('\n\n')
        const hostIntent: AgentMuxHostAgentCreateInput | undefined = remoteCreation ? {
          executorId: request.executorId, executorRevision: request.executorRevision ?? selected!.configRevision,
          workspacePath: preparedTopic?.absolutePath ?? request.workspacePath,
          createOperationId: request.createOperationId ?? randomUUID(),
          ...(agentMuxNote ? { agentMuxNote } : {}),
          ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
          ...(request.launchOptions === undefined ? {} : { launchOptions: request.launchOptions }),
          ...(request.cols === undefined ? {} : { cols: request.cols }), ...(request.rows === undefined ? {} : { rows: request.rows })
        } : undefined
        if (hostIntent) {
          hostIntent.agentSessionId = request.agentSessionId ?? await client.resolveAgentCreationSessionId(hostIntent.createOperationId!)
          if (request.initialMessage) {
            const source = await this.authorizedCallerHost({ agentSessionId: request.initialMessage.callerAgentSessionId, capability: request.initialMessage.capability })
            if (request.initialMessage.threadId) hostIntent.threadId = request.initialMessage.threadId
            // Only the authoritative source sees its capability. The target consumes a signed,
            // one-creation admission against its explicitly registered source public key.
            hostIntent.initialMessageAdmission = await source.client.attestAgentCreation({
              caller: { agentSessionId: request.initialMessage.callerAgentSessionId, capability: request.initialMessage.capability },
              target: { runtimeId: inventory!.runtimeId, intentDigest: hostAgentCreationIntent(hostIntent) }
            })
          }
        }
        const localExecutor = !remoteCreation ? config.executors[request.executorId]! : undefined
        const receipt = hostIntent ? await client.createHostAgentWithDelivery(hostIntent) : await client.createAgentWithDelivery({
          providerId: executor.providerId,
          executorId: request.executorId,
          workspacePath: preparedTopic?.absolutePath ?? request.workspacePath,
          args: localExecutor!.args,
          env: {
            ...localExecutor!.env,
            ...(preparedTopic ? { AGENTMUX_WIKI_DIR: preparedTopic.absolutePath } : {})
          },
          injectAgentMuxGuide: localExecutor!.injectAgentMuxGuide,
          commandOverride: localExecutor!.command,
          ...(agentMuxNote ? { agentMuxNote } : {}),
          ...(request.launchOptions === undefined ? {} : { launchOptions: request.launchOptions }),
          ...(request.agentSessionId === undefined ? {} : { agentSessionId: request.agentSessionId }),
          ...(request.createOperationId === undefined ? {} : { createOperationId: request.createOperationId }),
          ...(request.forkSource === undefined ? {} : { forkSource: request.forkSource }),
          ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
          ...(request.initialMessage ? { initialMessage: request.initialMessage } : {}),
          ...(request.cols === undefined ? {} : { cols: request.cols }),
          ...(request.rows === undefined ? {} : { rows: request.rows })
        })
        // Core's local Host is relative to that Core. Desktop controls use this client's route.
        created = { ...receipt.session, hostId: request.hostId }
        creation = receipt.creation
      } catch (error) {
        try {
          if (preparedTopic) await this.scratchTopics.discardPreparedIdentity(preparedTopic)
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            'Agent launch failed and its prepared Scratch identity could not be removed'
          )
        }
        throw error
      }
      const result: AgentLaunchResult = { created, creation, projectionFailures: [] }
      try {
        const session = await this.sessionByTarget(
          client,
          { kind: 'agent-session', agentSessionId: created.agentSessionId },
          config
        )
        if (session.kind !== 'agent' || session.id !== created.agentSessionId ||
          session.control.run.runId !== created.run.runId) {
          throw new Error(`Agent launch projected a different identity: ${created.agentSessionId}`)
        }
        result.session = session
      } catch (error) {
        result.projectionFailures.push({ step: 'session', message: error instanceof Error ? error.message : String(error) })
      }
      try {
        const timeline = await client.sessionTimeline(created.agentSessionId)
        if (timeline.agentSessionId !== created.agentSessionId) {
          throw new Error(`Agent launch returned a Timeline for another Session: ${timeline.agentSessionId}`)
        }
        result.timeline = timeline
      } catch (error) {
        result.projectionFailures.push({ step: 'timeline', message: error instanceof Error ? error.message : String(error) })
      }
      return result
    })
  }

  /**
   * 「这一个 Session 现在是什么」——解析单个 Session，不拉整张快照。
   *
   * 与 {@link snapshot} 的区别不是规模而是 RPC 形状：`snapshot` 为了给出 Timeline，对**每个** agent
   * Session 各发一次 `sessionTimeline`（见那里的 `Promise.allSettled`），所以「解析一个 Session」
   * 走 `snapshot` 的代价随房里 Session 数线性增长——而调用方只要那一个 Session 的 workspacePath
   * 与 providerId，一条 Timeline 都不看。这里只做一次 `runtimeProjection()`。
   *
   * 为什么仍要在主进程解析、而不是让 renderer 直接把 workspacePath 传进来：那会把「枚举任意
   * 路径下的文件」变成 renderer 能直接驱动的原语。身份必须由权威状态给出，便宜只能便宜在 RPC 上。
   *
   * 不接受 hostId：调用方（IPC 的 sessionId 入参）本来就只有 Session id，跨 host 找一遍是这个
   * 方法存在的理由。找不到返回 `null` 而不是抛——「这个 Session 不在了」是调用方要分辨的事实，
   * 不是异常。
   */
  async resolveSession(sessionId: string, config: AppConfig): Promise<SessionSnapshot | null> {
    const results = await Promise.allSettled([...this.hosts].map(async ([hostId, { client }]) => {
      await this.connectedClient(hostId)
      const subject = (await client.runtimeProjection()).subjects.find(candidate => (
        candidate.kind === 'agent' ? candidate.agentSession.agentSessionId === sessionId : candidate.run.runId === sessionId
      ))
      return subject ? projectSession({ ...subject, hostId }, config, providerCapabilitiesFrom(client)) : null
    }))
    const matches = results.flatMap(result => result.status === 'fulfilled' && result.value ? [result.value] : [])
    if (matches.length > 1) throw new AgentMuxError('Session identity is ambiguous across configured endpoints.', 'RUNTIME_OWNER_MISMATCH')
    if (matches[0]) return matches[0]
    const failure = results.find(result => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
    return null
  }

  async agentCreation(hostId: string, agentSessionId: string) {
    const client = await this.connectedClient(hostId)
    return { ...await client.inspectAgentCreation(agentSessionId), hostId }
  }

  async resolveCreationSessionId(hostId: string, createOperationId: string): Promise<string> {
    return (await this.connectedClient(hostId)).resolveAgentCreationSessionId(createOperationId)
  }

  async sessionHistorySources(options: { observation: true }): Promise<SessionHistorySourcesObservation>
  async sessionHistorySources(): Promise<AgentSessionHistoryDescriptor[]>
  async sessionHistorySources(options?: { observation: true }): Promise<AgentSessionHistoryDescriptor[] | SessionHistorySourcesObservation> {
    const hosts = [...this.hosts]
    const step = 'Reading retained History sources'
    const warnings = new Map<string, RuntimeEndpointWarning>()
    const results = await Promise.allSettled(hosts.map(async ([hostId, host]) => {
      try {
        if (options?.observation) this.assertObservationHostConnection(hostId, host)
        const descriptors = await host.client.sessionHistorySources()
        if (this.hosts.get(hostId) !== host) throw new AgentMuxError('The execution Host changed while reading its retained History sources.', 'EXECUTOR_HOST_CHANGED')
        this.observationWarnings.delete(JSON.stringify([hostId, step]))
        return descriptors.map(descriptor => ({ ...descriptor, hostId }))
      } catch (error) {
        const warning = observationWarning(hostId, step, error, runtimeOwner(host.client)?.availability === 'connected')
        warnings.set(hostId, warning)
        if (this.hosts.get(hostId) === host) this.observationWarnings.set(JSON.stringify([hostId, step]), warning)
        throw error
      }
    }))
    const current = results.filter((result, index) => result.status === 'fulfilled' && this.hosts.get(hosts[index]![0]) === hosts[index]![1])
    const failure = results.find(result => result.status === 'rejected')
    if (!options?.observation && failure?.status === 'rejected') throw failure.reason
    if (hosts.length && !current.length) {
      throw failure?.status === 'rejected' ? failure.reason : new AgentMuxError('The execution Hosts changed while reading their retained History sources.', 'EXECUTOR_HOST_CHANGED')
    }
    if (current.length !== results.filter(result => result.status === 'fulfilled').length) {
      const error = new AgentMuxError('The execution Host changed while reading its retained History sources.', 'EXECUTOR_HOST_CHANGED')
      if (!options?.observation) throw error
      for (const [index, result] of results.entries()) if (result.status === 'fulfilled' && this.hosts.get(hosts[index]![0]) !== hosts[index]![1]) {
        const hostId = hosts[index]![0]
        warnings.set(hostId, observationWarning(hostId, step, error, false))
      }
    }
    const sources = current.flatMap(result => result.status === 'fulfilled' ? result.value : [])
    return options?.observation ? { sources, warnings: [...warnings.values()] } : sources
  }

  async sessionTimeline(control: SessionHistoryReference) {
    const host = this.hosts.get(control.hostId)
    if (!host) throw new Error(`Runtime host is not configured: ${control.hostId}`)
    const timeline = await host.client.sessionTimeline(control.agentSessionId)
    if (this.hosts.get(control.hostId) !== host) throw new Error('History host configuration changed while reading. Reopen conversation history.')
    if (timeline.agentSessionId !== control.agentSessionId) {
      throw new Error(`Timeline snapshot belongs to another Session: ${timeline.agentSessionId}`)
    }
    return timeline
  }

  /** Remote invocation configuration stays private to its Core; local templates keep their existing meaning. */
  private sessionExecutorOptions(hostId: string, client: AgentMuxClient, config: AppConfig,
    session: { executorId: AgentExecutorId; providerId: AgentProviderId; creation?: { executorRevision?: string } }): Pick<AgentMuxAgentResumeInput, 'commandOverride' | 'args' | 'env'> {
    const host = this.hosts.get(hostId)
    if (!host || host.client !== client) throw new AgentMuxError('The original Runtime Host connection changed. Keep its Session and retry through the current connection.', 'CONTROL_UNAVAILABLE')
    if (host.config.kind === 'ssh' || session.creation?.executorRevision !== undefined) return {}
    const executor = requireSessionExecutor(config, session)
    return { commandOverride: executor.command, args: executor.args, env: executor.env }
  }

  async sessionHistoryPage(
    control: SessionHistoryReference,
    options: SessionHistoryPageOptions | undefined,
    config: AppConfig
  ): Promise<AgentSessionHistoryPage> {
    if (typeof control.agentSessionId !== 'string' || !control.agentSessionId) throw new Error('Conversation history requires an Agent Session.')
    if (this.hostReconfigurationReservations.has(control.hostId)) {
      throw new Error(`Runtime host is being reconfigured: ${control.hostId}`)
    }
    const host = this.hosts.get(control.hostId)
    if (!host) throw new Error(`Runtime host is not configured: ${control.hostId}`)
    let executor: Pick<AgentMuxAgentResumeInput, 'commandOverride' | 'args' | 'env'> = {}
    if (host.config.kind !== 'ssh') {
      const descriptor = (await host.client.sessionHistorySources()).find(entry => entry.agentSessionId === control.agentSessionId)
      if (!descriptor) throw new Error(`History Agent Session is not stored on host: ${control.hostId}`)
      if (!descriptor.history) throw new Error('No native history locator was retained for this Session.')
      executor = this.sessionExecutorOptions(control.hostId, host.client, config, descriptor.history)
    }
    const page = await host.client.sessionHistoryPage(control.agentSessionId, {
      ...(options?.cursor === undefined ? {} : { cursor: options.cursor }),
      ...(options?.limit === undefined ? {} : { limit: options.limit }),
      ...(options?.refreshNativeSource === undefined ? {} : { refreshNativeSource: options.refreshNativeSource }),
      ...(options?.nativeSource === undefined ? {} : { nativeSource: options.nativeSource }),
      ...executor
    })
    if (this.hosts.get(control.hostId) !== host) {
      throw new Error('History host configuration changed while reading. Reopen conversation history.')
    }
    if (page.agentSessionId !== control.agentSessionId) {
      throw new Error(`History page belongs to another Session: ${page.agentSessionId}`)
    }
    return page
  }

  async sessionHistoryResource(
    control: SessionHistoryReference,
    input: AgentSessionHistoryResourceRequest,
    config: AppConfig
  ): Promise<AgentSessionHistoryResourceReadResult> {
    if (typeof control.agentSessionId !== 'string' || !control.agentSessionId) throw new Error('Conversation resource requires an Agent Session.')
    if (this.hostReconfigurationReservations.has(control.hostId)) throw new Error(`Runtime host is being reconfigured: ${control.hostId}`)
    const host = this.hosts.get(control.hostId)
    if (!host) throw new Error(`Runtime host is not configured: ${control.hostId}`)
    let executor: Pick<AgentMuxAgentResumeInput, 'commandOverride' | 'args' | 'env'> = {}
    if (host.config.kind !== 'ssh') {
      const descriptor = (await host.client.sessionHistorySources()).find(entry => entry.agentSessionId === control.agentSessionId)
      if (!descriptor?.history) throw new Error('No native history locator was retained for this Session.')
      executor = this.sessionExecutorOptions(control.hostId, host.client, config, descriptor.history)
    }
    // Renderer supplies a recorded locator, never an invocation or an arbitrary file read.
    const result = await host.client.sessionHistoryResource(control.agentSessionId, {
      source: input.source, recordId: input.recordId, partIndex: input.partIndex, expectedReference: input.expectedReference,
      ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
      ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }),
      ...executor
    })
    if (this.hosts.get(control.hostId) !== host) throw new Error('History host configuration changed while reading. Reopen conversation history.')
    if (result.agentSessionId !== control.agentSessionId || result.source.providerId !== input.source.providerId ||
      result.source.nativeSessionId !== input.source.nativeSessionId || result.recordId !== input.recordId ||
      result.turnId !== input.turnId || result.partIndex !== input.partIndex || result.reference !== input.expectedReference) {
      throw new Error('History resource response belongs to another recorded target.')
    }
    return result
  }

  async observeSessionHistory(
    control: SessionHistoryReference,
    listener: (observation: AgentSessionHistoryObservation) => void,
    config: AppConfig,
    signal: AbortSignal
  ): Promise<AgentSessionHistoryObservationHandle> {
    signal.throwIfAborted()
    if (typeof control.agentSessionId !== 'string' || !control.agentSessionId) throw new Error('History observation requires an Agent Session.')
    const host = this.hosts.get(control.hostId)
    if (!host) throw new Error(`History host is not configured: ${control.hostId}`)
    const controller = new AbortController()
    let handle: AgentSessionHistoryObservationHandle | undefined
    let disposed = false
    const dispose = (): void => {
      if (disposed) return
      disposed = true
      controller.abort(signal.reason ?? new Error('History observation owner was released.'))
      handle?.dispose()
      signal.removeEventListener('abort', dispose)
      host.historyObservationDisposers.delete(retire)
    }
    const retire = (): void => {
      try {
        listener({ kind: 'unavailable', agentSessionId: control.agentSessionId,
          code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED',
          message: 'History host configuration changed. The current window is kept; refresh its source.' })
      } catch {
        // A readonly Consumer cannot veto replacing or disposing its Host.
      } finally { dispose() }
    }
    host.historyObservationDisposers.add(retire)
    signal.addEventListener('abort', dispose, { once: true })
    try {
      let executor: Pick<AgentMuxAgentResumeInput, 'commandOverride' | 'args' | 'env'> = {}
      if (host.config.kind !== 'ssh') {
        const descriptor = (await host.client.sessionHistorySources()).find(entry => entry.agentSessionId === control.agentSessionId)
        controller.signal.throwIfAborted()
        if (!descriptor?.history) throw new Error('No native history locator was retained for this Session.')
        executor = this.sessionExecutorOptions(control.hostId, host.client, config, descriptor.history)
      }
      controller.signal.throwIfAborted()
      const acquired = await host.client.observeSessionHistory(control.agentSessionId, observation => {
        if (!disposed) listener(observation)
      }, { ...executor, signal: controller.signal })
      handle = acquired
      if (disposed || this.hosts.get(control.hostId) !== host) {
        acquired.dispose()
        controller.signal.throwIfAborted()
        throw new Error('History host configuration changed while observing its source.')
      }
      return { source: acquired.source, dispose }
    } catch (error) { dispose(); throw error }
  }

  async toolkitRunPort(): Promise<ToolkitRunPort> {
    const hostId = 'local'
    const client = await this.connectedClient(hostId, 'runtime')
    return {
      create: async (input, onEvent) => await this.trackHostLifecycleOperation(hostId, async () => {
        const run = await client.createTerminal(input)
        this.toolkitRuns.set(terminalInputKey(hostId, run.runId), onEvent)
        return run
      }),
      attach: async (ref, afterByte, onEvent) => {
        if (onEvent) this.toolkitRuns.set(terminalInputKey(hostId, ref.runId), onEvent)
        return await client.attachTerminal(ref.runId, afterByte, 'raw')
      },
      replay: async (ref, afterByte) => await client.readRunReplay(ref, afterByte, 'raw'),
      release: async ref => await client.releaseRunAttachment(ref),
      stop: async ref => await client.stopTerminal(ref),
      remove: async ref => {
        await client.removeTerminal(ref)
        this.toolkitRuns.delete(terminalInputKey(hostId, ref.runId))
      }
    }
  }

  async launchTerminal(request: TerminalLaunchInput, config: AppConfig): Promise<SessionSnapshot> {
    return await this.trackHostLifecycleOperation(request.hostId, async () => {
      const client = await this.connectedClient(request.hostId, 'runtime')
      const run = await client.createTerminal({
        createOperationId: request.createOperationId ?? randomUUID(),
        workspacePath: request.workspacePath,
        ...(request.shellCommand === undefined
          ? {}
          : {
              command: '/bin/sh',
              args: ['-lc', request.shellCommand]
            }),
        ...(request.cols === undefined ? {} : { cols: request.cols }),
        ...(request.rows === undefined ? {} : { rows: request.rows })
      })
      this.terminalInputCursors.set(
        terminalInputKey(request.hostId, run.runId),
        run.acceptedInputBytes
      )
      return await this.sessionByTarget(
        client,
        { kind: 'terminal-run', runId: run.runId },
        config,
        run
      )
    })
  }

  async attachSession(
    webContentsId: number,
    control: SessionControl,
    afterByte: number,
    config: AppConfig,
    refresh?: { attachmentId: string | null }
  ): Promise<SessionAttachResult> {
    if ('run' in control && this.toolkitRuns.has(terminalInputKey(control.hostId, control.run.runId))) {
      throw new AgentMuxError('Toolkit owns this raw Attachment.', 'RUN_KIND_MISMATCH')
    }
    const key = sessionAttachmentKey(control)
    const rendererGeneration = this.rendererGenerations.get(webContentsId) ?? 0
    return await this.serializeSessionAttachment(key, async () => {
      const client = await this.connectedClient(control.hostId, 'runtime')
      const existing = this.sessionAttachmentOwners.get(key)
      const identity = sessionControlIdentity(control)
      if (existing && existing.controlIdentity !== identity) {
        throw new Error('A Session Attachment owner already exists for this exact Run identity.')
      }
      let retainedRun: { runId: string } | null = null
      try {
        const attached = refresh
          ? await client.refreshRunAttachment(control.run, afterByte, 'terminal')
          : existing
          ? await client.readRunReplay(control.run, afterByte, 'terminal')
          : control.kind === 'agent'
            ? (await client.reattachAgent(control.agentSessionId, afterByte, 'terminal')).attachment
            : await client.attachTerminal(control.runId, afterByte, 'terminal')
        if (!existing) retainedRun = attached.run
        if (attached.run.runId !== control.run.runId) {
          throw new Error('The Session control changed before its exact Run Attachment was established.')
        }
        const session = await this.sessionByTarget(
          client,
          control.kind === 'agent'
            ? { kind: 'agent-session', agentSessionId: control.agentSessionId }
            : { kind: 'terminal-run', runId: control.runId },
          config,
          attached.run
        )
        if ((this.rendererGenerations.get(webContentsId) ?? 0) !== rendererGeneration) {
          throw new Error('The Desktop Renderer changed before its Session Attachment was delivered.')
        }
        if (control.kind === 'terminal') {
          this.terminalInputCursors.set(
            terminalInputKey(control.hostId, control.runId),
            attached.run.acceptedInputBytes
          )
        }
        const attachmentId = refresh?.attachmentId ?? randomUUID()
        if (refresh?.attachmentId) this.requireSessionAttachmentLease(webContentsId, refresh.attachmentId, key)
        const owner = existing ?? { control, controlIdentity: identity, attachmentIds: new Set<string>() }
        owner.attachmentIds.add(attachmentId)
        this.sessionAttachmentOwners.set(key, owner)
        this.sessionAttachmentLeases.set(attachmentId, { key, webContentsId })
        retainedRun = null
        return {
          attachmentId,
          session,
          currentSize: attached.run.cols === null || attached.run.rows === null
            ? null
            : { cols: attached.run.cols, rows: attached.run.rows },
          replay: attached.replay,
          gap: attached.gap,
          terminal: attached.terminal,
          resizeRevision: attached.resizeRevision
        }
      } catch (error) {
        if (retainedRun) {
          try {
            await client.releaseRunAttachment(retainedRun)
          } catch (cleanupError) {
            throw new AggregateError([error, cleanupError], 'Session Attachment establishment and rollback failed.')
          }
        }
        throw error
      }
    })
  }

  /** Reopen the shared Core observation, retaining every Region's original lease. */
  async refreshSessionAttachment(webContentsId: number, control: SessionControl,
    attachmentId: string | null, afterByte: number, config: AppConfig): Promise<SessionAttachResult> {
    const key = sessionAttachmentKey(control)
    if (attachmentId) this.requireSessionAttachmentLease(webContentsId, attachmentId, key)
    const owner = this.sessionAttachmentOwners.get(key)
    if (owner && owner.controlIdentity !== sessionControlIdentity(control)) throw new Error('Attachment refresh belongs to another Session.')
    let refresh = owner?.refresh
    if (!refresh) {
      refresh = this.attachSession(webContentsId, control, afterByte, config, { attachmentId })
      if (owner) owner.refresh = refresh
    }
    try {
      const result = await refresh
      if (!attachmentId) return result
      this.requireSessionAttachmentLease(webContentsId, attachmentId, key)
      return { ...result, attachmentId }
    } finally {
      if (owner?.refresh === refresh) delete owner.refresh
    }
  }

  private requireSessionAttachmentLease(webContentsId: number, attachmentId: string, key: string): void {
    const lease = this.sessionAttachmentLeases.get(attachmentId)
    if (!lease || lease.webContentsId !== webContentsId || lease.key !== key ||
      !this.sessionAttachmentOwners.get(key)?.attachmentIds.has(attachmentId)) {
      throw new Error('Attachment refresh requires this exact Session and Desktop client lease.')
    }
  }

  async readSessionReplay(webContentsId: number, attachmentId: string, afterByte: number): Promise<SessionReplayResult> {
    const lease = this.sessionAttachmentLeases.get(attachmentId)
    if (!lease || lease.webContentsId !== webContentsId) {
      throw new Error('Retained history requires this Desktop client’s Session Attachment lease.')
    }
    const owner = this.sessionAttachmentOwners.get(lease.key)
    if (!owner || !owner.attachmentIds.has(attachmentId)) {
      throw new Error('The Session Attachment owner is no longer available.')
    }
    if (this.sessionReplayReads.has(lease.key)) {
      throw new Error('A retained history read for this Run is still pending. Live input remains available.')
    }
    const read = (async (): Promise<SessionReplayResult> => {
      const client = await this.connectedClient(owner.control.hostId, 'runtime')
      const result = await client.readRunReplay(owner.control.run, afterByte)
      if (result.run.runId !== owner.control.run.runId) {
        throw new Error('Retained history returned a different Run.')
      }
      return { replay: result.replay, gap: result.gap }
    })()
    this.sessionReplayReads.set(lease.key, read)
    try { return await read }
    finally {
      if (this.sessionReplayReads.get(lease.key) === read) this.sessionReplayReads.delete(lease.key)
    }
  }

  async detachSession(webContentsId: number, attachmentId: string): Promise<void> {
    const lease = this.sessionAttachmentLeases.get(attachmentId)
    if (!lease) return
    if (lease.webContentsId !== webContentsId) {
      throw new Error('The Session Attachment lease belongs to a different Desktop client.')
    }
    await this.serializeSessionAttachment(lease.key, async () => {
      const currentLease = this.sessionAttachmentLeases.get(attachmentId)
      if (!currentLease) return
      if (currentLease.webContentsId !== webContentsId) {
        throw new Error('The Session Attachment lease owner changed before release.')
      }
      const owner = this.sessionAttachmentOwners.get(currentLease.key)
      if (!owner) {
        this.sessionAttachmentLeases.delete(attachmentId)
        return
      }
      if (owner.attachmentIds.size > 1) {
        owner.attachmentIds.delete(attachmentId)
        this.sessionAttachmentLeases.delete(attachmentId)
        return
      }
      await (await this.connectedClient(owner.control.hostId, 'runtime')).releaseRunAttachment(owner.control.run)
      owner.attachmentIds.delete(attachmentId)
      this.sessionAttachmentLeases.delete(attachmentId)
      this.sessionAttachmentOwners.delete(currentLease.key)
    })
  }

  async resizeSessionAttachment(
    webContentsId: number,
    attachmentId: string,
    cols: number,
    rows: number
  ): Promise<{ cols: number; rows: number } | null> {
    const lease = this.sessionAttachmentLeases.get(attachmentId)
    if (!lease) return null
    if (lease.webContentsId !== webContentsId) {
      throw new Error('The Session Attachment lease belongs to a different Desktop client.')
    }
    return await this.serializeSessionAttachment(lease.key, async () => {
      const currentLease = this.sessionAttachmentLeases.get(attachmentId)
      if (!currentLease) return null
      if (currentLease.webContentsId !== webContentsId || currentLease.key !== lease.key) {
        throw new Error('The Session Attachment lease owner changed before resize.')
      }
      const owner = this.sessionAttachmentOwners.get(lease.key)
      if (!owner?.attachmentIds.has(attachmentId)) return null
      const client = await this.connectedClient(owner.control.hostId, 'runtime')
      const applied = owner.control.kind === 'agent'
        ? await client.resizeAgent(
          owner.control.agentSessionId,
          owner.control.run,
          cols,
          rows
        )
        : await client.resizeTerminal(owner.control.run, cols, rows)
      return { cols: applied.cols, rows: applied.rows }
    })
  }

  async write(control: SessionControl, data: AgentMuxRunInputData, source: AgentMuxAgentWriteInput['source'],
    observation?: InputObservationReference, sender?: InputPerformanceSender): Promise<void> {
    const parent = readInputObservation(observation)
    const diagnostic = this.inputPerformance.begin({ sessionId: control.kind === 'agent' ? control.agentSessionId : null,
      hostId: control.hostId, runId: control.run.runId, kind: source === 'terminal-protocol' ? 'protocol' : 'user',
      bytes: typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength, parent, sender: sender ?? null, stage: 'received' })
    try {
      const client = await diagnostic.measure('connected-client', () => this.connectedClient(control.hostId, 'runtime'))
      try { diagnostic.executionOwner(client.runtimeIdentity().instanceId) } catch { /* Diagnostic identity is optional. */ }
      await diagnostic.measure('host-call', () => control.kind === 'agent' ? client.writeAgent({
        agentSessionId: control.agentSessionId, expectedRun: control.run, data, source, ...(parent ? { observation: parent } : {})
      }).then(() => {}) : this.writeTerminalInput(client, control, data, diagnostic, parent))
      diagnostic.stage('reply-ready'); diagnostic.settle(true)
    } catch (error) { diagnostic.settle(false); throw error }
  }

  async paste(control: SessionControl, text: string, terminalData: string,
    observation?: InputObservationReference, sender?: InputPerformanceSender): Promise<void> {
    const parent = readInputObservation(observation)
    const diagnostic = this.inputPerformance.begin({ sessionId: control.kind === 'agent' ? control.agentSessionId : null,
      hostId: control.hostId, runId: control.run.runId, kind: 'paste', bytes: Buffer.byteLength(terminalData), parent,
      sender: sender ?? null, stage: 'received' })
    try {
      const client = await diagnostic.measure('connected-client', () => this.connectedClient(control.hostId, 'runtime'))
      try { diagnostic.executionOwner(client.runtimeIdentity().instanceId) } catch { /* Diagnostic identity is optional. */ }
      await diagnostic.measure('host-call', () => control.kind === 'agent' ? client.pasteAgent({ agentSessionId: control.agentSessionId,
        expectedRun: control.run, text, terminalData, ...(parent ? { observation: parent } : {}) }).then(() => {})
        : this.writeTerminalInput(client, control, terminalData, diagnostic, parent))
      diagnostic.stage('reply-ready'); diagnostic.settle(true)
    } catch (error) { diagnostic.settle(false); throw error }
  }

  async submitPrompt(
    control: Extract<SessionControl, { kind: 'agent' }>,
    prompt: string,
    operationId: string,
    condition: AgentPromptCondition,
    automation?: { completionId?: string; futureIntent?: { intentId: string; occurrenceAt: number }; inputByte?: number; isCurrent(): boolean; signal: AbortSignal },
    choice?: { allowUncertainTurn?: true; execution?: AgentPromptExecution; preparationRetry?: import('@agentmux/core').AgentPromptPreparationRetryFence },
    authorHuman?: boolean,
    agentMuxNote?: string,
    sourceChannel: AgentMessageChannel = 'message-tool'
  ): Promise<void> {
    const capturedCondition = validateAgentPromptCondition(condition)
    await this.trackHostLifecycleOperation(control.hostId, async () => {
      const client = await this.connectedClient(control.hostId)
      if (control.run.runId !== capturedCondition.expectedRun.runId) {
        throw new AgentMuxError('Prompt intent targets another Run.', 'STALE_AGENT_SESSION')
      }
      const status = await client.statusAgent(control.agentSessionId)
      if (status.run.runId !== control.run.runId) {
        throw new AgentMuxError('Agent Session changed before prompt submission.', 'STALE_AGENT_SESSION')
      }
      if (status.run.state !== 'running') {
        throw new AgentMuxError('Agent Session is not running. Use explicit resume.', 'SESSION_NOT_RUNNING')
      }
      try {
        if (automation && !automation.isCurrent()) {
          throw new AgentMuxError('Automatic delivery was cancelled.', 'AGENT_COMPLETION_CHANGED')
        }
        await client.submitAgentPrompt({
          agentSessionId: control.agentSessionId,
          ...capturedCondition,
          operationId,
          ...(automation ? { ...(automation.futureIntent ? { expectedFutureIntent: automation.futureIntent } : automation.completionId === undefined ? {} : { expectedCompletionId: automation.completionId }), ...(automation.inputByte === undefined ? {} : { expectedInputByte: automation.inputByte }), signal: automation.signal } : {}),
          prompt,
          ...(agentMuxNote === undefined ? {} : { agentMuxNote }),
          sourceChannel,
          ...(choice?.allowUncertainTurn === true && !automation ? { allowUncertainTurn: true } : {}),
          ...(!automation && choice?.execution !== undefined ? { execution: choice.execution } : {}),
          ...(!automation && choice?.preparationRetry ? { preparationRetry: choice.preparationRetry } : {}),
          ...(authorHuman === true ? { authorHuman: true } : {})
        })
      } catch (error) {
        // A process can exit in the small window after the first status check. Re-read the same
        // authoritative Run before translating a readiness error so a stopped Agent is never told to
        // keep waiting for an observation that can no longer arrive.
        let runState: 'running' | 'ended' | undefined
        if (error instanceof AgentMuxError && (
          error.code === 'AGENT_PROMPT_SUBMISSION_BUSY'
        )) {
          try {
            const latest = await client.statusAgent(control.agentSessionId)
            if (latest.run.runId === control.run.runId) {
              if (latest.run.state !== 'running') runState = 'ended'

            }
          } catch {
            // Keep the original fail-closed error when the follow-up observation is unavailable.
          }
        }
        throw humanizePromptDeliveryError(error, {
          ...(runState ? { runState } : {})
        })
      }
    })
  }

  async replyQuestion(control: AgentSessionControl, input: SessionQuestionReplyInput, config: AppConfig): Promise<AgentSessionQuestionReplyReceipt> {
    const condition = validateAgentPromptCondition(input)
    const hostId = control.hostId, agentSessionId = control.agentSessionId
    if (control.run.runId !== condition.expectedRun.runId) throw new AgentMuxError('Question reply targets another Run.', 'STALE_AGENT_SESSION')
    const original = { source: { ...input.source }, turnId: input.turnId, recordId: input.recordId,
      answers: input.answers.map(answer => ({ ...answer })), operationId: input.operationId,
      ...(input.allowUncertainTurn === undefined ? {} : { allowUncertainTurn: input.allowUncertainTurn }) }
    return await this.trackHostLifecycleOperation(hostId, async () => {
      const client = await this.connectedClient(hostId)
      const executor = this.sessionExecutorOptions(hostId, client, config, client.agentSession(agentSessionId))
      return await client.replySessionQuestion({ ...condition, ...original, agentSessionId,
        ...executor,
        authorHuman: true, sourceChannel: 'question-reply' })
    })
  }

  async submitMessage(control: AgentSessionControl, message: Omit<AgentMuxAgentMessageInput, 'agentSessionId'>): Promise<void> {
    await this.trackHostLifecycleOperation(control.hostId, async () => {
      const client = await this.connectedClient(control.hostId)
      if (control.run.runId !== message.condition.expectedRun.runId) {
        throw new AgentMuxError('Message intent targets another Run.', 'STALE_AGENT_SESSION')
      }
      await client.submitAgentMessage({ ...message, agentSessionId: control.agentSessionId })
    })
  }

  private progressInputObserver: ((control: AgentSessionControl, signal?: AbortSignal) => Promise<boolean>) | undefined
  async authorizeFutureIntent(target: { hostId: string; agentSessionId: string; providerId: string; workspacePath: string }, context?: AgentMuxRpcCallContext): Promise<void> {
    if (!context?.caller) return
    const client = await this.connectedClient(target.hostId), recipient = await client.statusAgent(target.agentSessionId)
    if (recipient.session.hostId !== target.hostId || recipient.session.providerId !== target.providerId || recipient.session.workspacePath !== target.workspacePath) {
      throw new AgentMuxError('The original future-message target is unconfirmed. The arrangement and manual input are retained.', 'STALE_AGENT_SESSION')
    }
    const sender = await client.authorizeAgentCaller(context.caller.capability, context.caller.agentSessionId)
    await client.authorizeAgentMessage({ capability: context.caller.capability, callerAgentSessionId: sender.agentSessionId,
      senderAgentSessionId: sender.agentSessionId, senderSessionId: sender.agentSessionId, senderRunId: sender.run.runId,
      recipientSessionId: recipient.session.agentSessionId, recipientRunId: recipient.session.run.runId })
  }
  async saveFutureIntent(loop: { hostId: string; agentSessionId: string; providerId: string; workspacePath: string; futureIntentId?: string; creationOperationId?: string; prompt: string; checkIn?: AgentScheduleCheckInPolicy }, active: boolean, context?: AgentMuxRpcCallContext): Promise<void> {
    const client = await this.connectedClient(loop.hostId)
    const status = await client.statusAgent(loop.agentSessionId)
    if (status.session.hostId !== loop.hostId || status.session.providerId !== loop.providerId || status.session.workspacePath !== loop.workspacePath || !loop.futureIntentId || !loop.creationOperationId) {
      throw new AgentMuxError('The original future-message target or intent is unconfirmed. Manual input remains available.', 'STALE_AGENT_SESSION')
    }
    await client.saveAgentFuturePromptIntent({ agentSessionId: loop.agentSessionId, intentId: loop.futureIntentId, operationId: loop.creationOperationId,
      prompt: loop.prompt, agentMuxNote: AGENTMUX_AGENT_MESSAGING_GUIDANCE + (loop.checkIn ? '\n\n' + AGENT_SCHEDULE_CHECK_IN_GUIDANCE : ''), active, ...(context?.caller ? { caller: context.caller } : {}) })
  }
  async observeCheckIn(target: { hostId: string; agentSessionId: string; providerId: string; workspacePath: string }, now: number, signal: AbortSignal, config: AppConfig): Promise<CheckInObservation> {
    signal.throwIfAborted()
    const client = await this.connectedClient(target.hostId), before = await client.statusAgent(target.agentSessionId)
    const matches = (session: typeof before.session) => session.agentSessionId === target.agentSessionId && session.hostId === target.hostId && session.providerId === target.providerId && session.workspacePath === target.workspacePath
    if (!matches(before.session)) return { known: false, reason: 'The original quiet follow-up target is unconfirmed.' }
    const timeline = await client.sessionTimeline(target.agentSessionId)
    const executor = this.sessionExecutorOptions(target.hostId, client, config, before.session)
    const page = await client.sessionHistoryPage(target.agentSessionId, { limit: 100, refreshNativeSource: true, requireCurrentSource: true, signal, ...executor })
    signal.throwIfAborted()
    const after = await client.statusAgent(target.agentSessionId)
    signal.throwIfAborted()
    const handle = after.session.nativeHandle
    if (!matches(after.session) || before.session.run.runId !== after.session.run.runId || JSON.stringify(before.session.nativeHandle) !== JSON.stringify(handle) ||
        handle?.kind !== 'provider' || handle.providerId !== page.source.providerId || handle.sessionId !== page.source.nativeSessionId) return { known: false, reason: 'The original Run or current conversation source changed while reading; this occurrence remains due.' }
    return checkInHumanObservation(target.agentSessionId, timeline, page, now)
  }
  setContinuousProgressInputObserver(observer: (control: AgentSessionControl, signal?: AbortSignal) => Promise<boolean>): () => void {
    this.progressInputObserver = observer
    return () => { if (this.progressInputObserver === observer) this.progressInputObserver = undefined }
  }

  /** Read the authoritative session facts used by the durable progress loop immediately before delivery. */
  async observeContinuousProgress(loop: { hostId: string; agentSessionId: string; providerId: string; workspacePath: string; futureIntentId?: string }, tickId: string, now: number, signal?: AbortSignal) {
    const host = this.hosts.get(loop.hostId)
    if (!host) throw new AgentMuxError('Continuous progress target host is unavailable.', 'UNKNOWN_AGENT_SESSION')
    const status = await host.client.statusAgent(loop.agentSessionId)
    if (status.session.hostId !== loop.hostId || status.session.providerId !== loop.providerId ||
        status.session.workspacePath !== loop.workspacePath) {
      throw new AgentMuxError('Continuous progress target identity changed. Review this loop before resuming.', 'STALE_AGENT_SESSION')
    }
    if (status.run.acceptedInputBytes === null) throw new AgentMuxError('The original Native input cursor is unconfirmed. Automatic progress is paused; manual input and your Agent remain available.', 'CONTROL_UNAVAILABLE')
    const observer = this.progressInputObserver
    if (!observer) throw new Error('User input observation is unavailable. Automatic progress is paused; manual input remains available.')
    const inputOccupied = await observer({ kind: 'agent', hostId: loop.hostId, agentSessionId: loop.agentSessionId, run: status.session.run }, signal)
    const saved = loop.futureIntentId ? await host.client.readAgentFuturePromptIntent(loop.agentSessionId, loop.futureIntentId) : null
    const session = loop.futureIntentId ? { ...status.session, futurePromptIntents: saved ? { [loop.futureIntentId]: saved } : {} } : status.session
    return { session, observation: status.observation, inputByte: status.run.acceptedInputBytes, inputOccupied, tickId, now }
  }

  /** Read the original Core input transaction; absence is never a replacement admission. */
  async inspectContinuousProgressInitial(loop: import('@agentmux/core').ContinuousProgressLoop): Promise<'confirmed' | 'pending' | 'unconfirmed'> {
    const initial = loop.initialDelivery
    if (!initial) return 'unconfirmed'
    const status = await (await this.connectedClient(loop.hostId)).statusAgent(loop.agentSessionId)
    const session = status.session, admission = session.promptCompletionAdmission
    if (session.hostId !== loop.hostId || session.agentSessionId !== loop.agentSessionId || session.providerId !== loop.providerId || session.workspacePath !== loop.workspacePath ||
        session.run.runId !== initial.condition.expectedRun.runId || admission?.submissionId !== initial.operationId ||
        admission.intent?.run.runId !== initial.condition.expectedRun.runId || admission.intent.prompt !== initial.prompt ||
        admission.intent.message?.userContent !== initial.prompt || admission.intent.message.systemContext !== undefined) return 'unconfirmed'
    if (admission.acknowledged === true || session.terminalPromptSubmission?.submissionId === initial.operationId && session.terminalPromptSubmission.submit.acknowledged === true) return 'confirmed'
    return 'pending'
  }

  async respondInteraction(
    control: Extract<SessionControl, { kind: 'agent' }>,
    response: AgentMuxInteractionResponse
  ): Promise<void> {
    await this.trackHostLifecycleOperation(control.hostId, async () => {
      await (await this.connectedClient(control.hostId)).respondAgentInteraction({
        agentSessionId: control.agentSessionId,
        expectedRun: control.run,
        response
      })
    })
  }

  async setPosture(
    control: Extract<SessionControl, { kind: 'agent' }>,
    modeId: string
  ): Promise<void> {
    await this.trackHostLifecycleOperation(control.hostId, async () => {
      await (await this.connectedClient(control.hostId)).setAgentPosture({
        agentSessionId: control.agentSessionId,
        expectedRun: control.run,
        modeId
      })
    })
  }

  async reopenRetiredSession(
    reference: SessionHistoryReference,
    expectedRetiredAt: number,
    operationId: string,
    config: AppConfig
  ): Promise<SessionSnapshot> {
    return await this.trackHostLifecycleOperation(reference.hostId, async () => {
      let dispatched = false
      try {
      const client = await this.connectedClient(reference.hostId)
      const descriptor = (await this.sessionHistorySources()).find(entry =>
        entry.agentSessionId === reference.agentSessionId && entry.hostId === reference.hostId)
      if (!descriptor || descriptor.state !== 'retired' || descriptor.retiredAt !== expectedRetiredAt || !descriptor.history) {
        throw new AgentMuxError('The original Session retirement changed. Read its history again before continuing.', 'STALE_AGENT_SESSION')
      }
      const executor = this.sessionExecutorOptions(reference.hostId, client, config, descriptor.history)
      dispatched = true
      const canonical = await client.reopenAgent({ agentSessionId: reference.agentSessionId, expectedRetiredAt, operationId,
        ...executor })
      if (canonical.agentSessionId !== reference.agentSessionId || canonical.providerId !== descriptor.history.providerId ||
        canonical.executorId !== descriptor.history.executorId || canonical.workspacePath !== descriptor.history.workspacePath ||
        JSON.stringify(canonical.nativeHandle) !== JSON.stringify(descriptor.history.nativeHandle)) {
        throw new AgentMuxError('Continued Session identity is unconfirmed. Read the original Session; no operation was resent.', 'STALE_AGENT_SESSION')
      }
      return await this.sessionByTarget(client, { kind: 'agent-session', agentSessionId: canonical.agentSessionId }, config)
      } catch (error) {
        if (!dispatched) throw new AgentMuxError(error instanceof Error ? error.message : String(error),
          error instanceof AgentMuxError ? error.code : 'SESSION_REOPEN_NOT_APPLIED', undefined,
          { disposition: 'not_applied', confirmedInputBytes: null })
        throw error
      }
    })
  }

  async reconcileRetiredSession(reference: SessionHistoryReference, expectedRetiredAt: number, operationId: string, config: AppConfig): Promise<SessionSnapshot> {
    return await this.trackHostLifecycleOperation(reference.hostId, async () => {
      const client = await this.connectedClient(reference.hostId)
      const canonical = await client.reconcileAgentReopen({ agentSessionId: reference.agentSessionId, expectedRetiredAt, operationId })
      if (canonical.agentSessionId !== reference.agentSessionId || canonical.hostId !== 'local' || canonical.reopenedFrom?.observedAt !== expectedRetiredAt) {
        throw new AgentMuxError('The original continue result belongs to another Session.', 'STALE_AGENT_SESSION')
      }
      return await this.sessionByTarget(client, { kind: 'agent-session', agentSessionId: canonical.agentSessionId }, config)
    })
  }

  async resumeSession(
    control: Extract<SessionControl, { kind: 'agent' }>,
    prompt: string,
    operationId: string,
    config: AppConfig,
    agentMuxNote?: string
  ): Promise<SessionSnapshot> {
    return await this.trackHostLifecycleOperation(control.hostId, async () => {
      const client = await this.connectedClient(control.hostId)
      const status = await client.statusAgent(control.agentSessionId)
      if (status.run.runId !== control.run.runId) {
        throw new AgentMuxError('Agent Session changed before explicit resume.', 'STALE_AGENT_SESSION')
      }
      const executor = this.sessionExecutorOptions(control.hostId, client, config, status.session)
      const resumed = await client.resumeAgent({
        agentSessionId: control.agentSessionId,
        operationId,
        prompt,
        ...(agentMuxNote === undefined ? {} : { agentMuxNote }),
        ...executor
      })
      if (resumed.agentSessionId !== control.agentSessionId) {
        throw new AgentMuxError('Agent resume returned another Session identity.', 'LAUNCH_RESULT_MISMATCH')
      }
      return await this.sessionByTarget(
        client,
        { kind: 'agent-session', agentSessionId: control.agentSessionId },
        config
      )
    })
  }

  async interrupt(control: SessionControl): Promise<void> {
    const client = await this.connectedClient(control.hostId, 'runtime')
    if (control.kind === 'agent') await client.signalAgent(control.agentSessionId, control.run, 'SIGINT')
    else await client.signalTerminal(control.run, 'SIGINT')
  }

  async observeStorage(control: SessionControl): Promise<import('@agentmux/core').AgentMuxRunStorageObservation> {
    if (control.kind === 'terminal' && control.runId !== control.run.runId) {
      throw Object.assign(new Error('Terminal storage target has conflicting Run identities.'), { code: 'INVALID_CONTROL_REQUEST' })
    }
    const client = await this.connectedClient(control.hostId, 'runtime')
    if (control.kind === 'agent') {
      // Confirm original Session/Run binding without changing lifecycle or opening an attachment.
      const original = client.agentSession(control.agentSessionId)
      if (original.run.runId !== control.run.runId) {
        throw Object.assign(new Error('Session changed before storage observation. Refresh the original Session.'), { code: 'STALE_AGENT_SESSION_BINDING' })
      }
    }
    const run = control.kind === 'agent' ? control.run : { runId: control.runId }
    const result = await client.observeRunStorage(run)
    return { ...result, runtime: { ...result.runtime, hostId: control.hostId } }
  }

  async refresh(control: SessionControl, config: AppConfig): Promise<SessionSnapshot> {
    const client = await this.connectedClient(control.hostId)
    if (control.kind === 'agent') await client.refreshAgentSession(control.agentSessionId, control.run)
    return await this.sessionByTarget(
      client,
      control.kind === 'agent'
        ? { kind: 'agent-session', agentSessionId: control.agentSessionId }
        : { kind: 'terminal-run', runId: control.runId },
      config
    )
  }

  async confirmNativeSession(control: AgentSessionControl, input: AgentMuxNativeSessionConfirmationInput): Promise<AgentMuxNativeSessionConfirmation> {
    if (control.kind !== 'agent' || control.agentSessionId !== input.agentSessionId || control.run.runId !== input.expectedRun.runId) {
      throw new AgentMuxError('Native confirmation must target this exact Session and Run.', 'STALE_AGENT_SESSION')
    }
    const client = await this.connectedClient(control.hostId)
    return await client.confirmAgentNativeSession(input)
  }

  /**
   * Recovers a session whose authoritative Run is ended or missing.
   *
   * Raw Terminals relaunch with a new identity. Agents delegate the complete attach/resume/
   * unavailable/retired/conflict decision to Core. Transport loss is surfaced unchanged;
   * it never authorizes a retry or Provider resume.
   */
  async recoverSession(
    control: SessionControl,
    config: AppConfig,
    workspacePath?: string,
    operationId: string = randomUUID()
  ): Promise<SessionRecoveryResult> {
    return await this.trackHostLifecycleOperation(
      control.hostId,
      async () => await this.performRecovery(control, config, workspacePath, operationId)
    )
  }

  private async performRecovery(
    control: SessionControl,
    config: AppConfig,
    workspacePath: string | undefined,
    operationId: string
  ): Promise<SessionRecoveryResult> {
    const client = await this.connectedClient(control.hostId)
    if (control.kind === 'terminal') {
      const cwd = workspacePath ?? (await this.sessionByTarget(
        client,
        { kind: 'terminal-run', runId: control.runId },
        config
      )).workspacePath
      const run = await client.createTerminal({
        createOperationId: randomUUID(),
        workspacePath: cwd
      })
      this.terminalInputCursors.set(
        terminalInputKey(control.hostId, run.runId),
        run.acceptedInputBytes
      )
      return {
        kind: 'terminal-restarted',
        session: await this.sessionByTarget(
          client,
          { kind: 'terminal-run', runId: run.runId },
          config,
          run
        )
      }
    }
    let stored
    try {
      stored = client.agentSession(control.agentSessionId)
    } catch {
      const result = await client.ensureAgentContinuity({
        agentSessionId: control.agentSessionId,
        expectedRun: control.run,
        operationId
      })
      if (result.kind === 'reattachable' || result.kind === 'resumed') {
        throw new Error('Core returned live continuity without a current Agent Session.')
      }
      return result
    }
    // Target-owned Sessions reattach without a local template or a fresh command probe.
    // Core resolves its own Executor only if Level B recovery needs a new native Run.
    const scratch = config.workspaces.find((workspace) => (
      workspace.id === SCRATCH_WORKSPACE_ID && workspace.hostId === control.hostId
    ))
    let scratchTopicId: string | null = null, advisory: string | undefined
    const name = stored.workspacePath.split('/').at(-1) ?? ''
    if (scratch && /^(?:topic--(?:launcher|session|view)--|[0-9a-f]{16}$)/.test(name)) {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const topic = await Promise.race([this.scratchTopics.readForDirectory(scratch, stored.workspacePath),
          new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('The optional Wiki directory check timed out.')), 100) })])
        if (topic?.readError) throw new Error(topic.readError)
        scratchTopicId = topic?.id ?? null
      } catch (error) {
        advisory = `Wiki directory association is unconfirmed: ${error instanceof Error ? error.message : String(error)} Agent continuity and input remain available. Retry the original directory repair before the next resume.`
      } finally { clearTimeout(timer) }
    }
    const executor = this.sessionExecutorOptions(control.hostId, client, config, stored)
    const result = await client.ensureAgentContinuity({
      agentSessionId: control.agentSessionId,
      expectedRun: control.run,
      operationId,
      ...executor,
      ...(executor.env && scratchTopicId ? { env: { ...executor.env, AGENTMUX_WIKI_DIR: stored.workspacePath } } : {})
    })
    if (result.kind === 'conflict' && result.reason === 'session-run-changed' && result.currentRun) {
      // A prior recovery whose reply was lost may already own the canonical Run.
      const session = await this.sessionByTarget(client,
        { kind: 'agent-session', agentSessionId: control.agentSessionId }, config)
      if (session.kind === 'agent' && session.processState === 'running' &&
        session.control.run.runId === result.currentRun.runId) return { kind: 'reattachable', session, ...(advisory ? { advisory } : {}) }
    }
    if (result.kind !== 'reattachable' && result.kind !== 'resumed') return result
    return {
      kind: result.kind,
      ...(advisory ? { advisory } : {}),
      session: await this.sessionByTarget(
        client,
        { kind: 'agent-session', agentSessionId: control.agentSessionId },
        config
      )
    }
  }

  async stopSession(control: SessionControl): Promise<void> {
    const attachmentKey = sessionAttachmentKey(control)
    // 停止**不排队**，其余附着操作照旧排队。
    //
    // 理由是「关不掉」那条缺陷的下半场。一次没回执的停止会让它那格队列永远不前进；如果停止
    // 自己也排在这条队上，用户按提示再关一次，第二次会卡在队尾——`client.stopTerminal` 一次都
    // 不会被再调到。那正是「点了没反应」的实感，而我们给出的恢复动作（「再关一次」）在这种
    // 状态下根本走不通：文案点名的动作必须从当前状态真能走通。
    //
    // 队列存在的理由是 resize / attach / detach 这些**改附着状态**的操作不能互相穿插。停止不属于
    // 这一族：它是终局动作，重复发一次对 Runtime 是幂等的（同一个 run 停两次，第二次无事发生），
    // 不存在需要被上一步保护的中间态。反过来它还必须能插队——正因为队首卡住的往往就是它自己。
    // 附着在**决定停止的那一刻**就作废，而不是等 Runtime 回话之后。这一句同时管两件事：
    // 排在后面的 resize 找不到 owner，直接 revoke（这条性质原先靠「停止占着队列」间接成立，
    // 现在直接写出来）；而一次没回执的停止也不会让这一格永远顶着一个已经作废的附着。
    this.forgetSessionAttachmentOwner(attachmentKey)
    const client = await this.connectedClient(control.hostId)
    if (control.kind === 'agent') {
      await client.stopAgent(control.agentSessionId, control.run)
    } else {
      await client.stopTerminal(control.run)
      const inputKey = terminalInputKey(control.hostId, control.runId)
      this.terminalInputCursors.delete(inputKey)
      this.terminalInputTails.delete(inputKey)
    }
  }

  async dispose(): Promise<void> {
    const hosts = [...this.hosts.entries()]
    for (const [hostId] of hosts) this.hostReconfigurationReservations.add(hostId)
    try {
      await Promise.all(hosts.map(async ([hostId]) => await this.waitForHostQuiescence(hostId)))
      // Keep the current host/client projection until every owner has actually been disposed. If
      // cleanup fails, the window can report the failure and retry/recover against still-live
      // owners; clearing the maps first used to leave the reservation set behind and every later
      // attach was rejected as "Host is being reconfigured" forever.
      for (const [, host] of hosts) for (const release of host.historyObservationDisposers) release()
      await disposePrepared(hosts.map(([id, host]) => ({ id, ...host })))
      this.hosts.clear()
      this.clients.clear()
      this.sessionAttachmentOwners.clear()
      this.sessionAttachmentLeases.clear()
      this.sessionAttachmentTails.clear()
      this.rendererGenerations.clear()
      this.hostLifecycleOperations.clear()
      this.hostSignatures.clear()
      this.endpointWarnings.clear()
      this.observationWarnings.clear()
      this.terminalInputCursors.clear()
      this.terminalInputTails.clear()
      this.terminalColorQueryRemainders.clear()
      this.pendingAgentColorQueryReplies.clear()
      this.readyAgentColorQueryRuns.clear()
      this.resourceSampler.dispose()
      for (const [, host] of hosts) host.unsubscribe()
    } finally {
      // A failed quit/reconfiguration is a workflow error, not a new Runtime fact. Never leave
      // the gate latched across the error path: the next attach or explicit retry must be able to
      // reach the surviving owner and expose the real failure instead.
      for (const [hostId] of hosts) this.hostReconfigurationReservations.delete(hostId)
    }
  }

  private async prepareHost(
    config: HostConfig,
    store: AgentMuxAgentSessionStore = this.agentSessionStore
  ): Promise<PreparedRuntimeHost> {
    const executionHost = createExecutionHost(config)
    let client: AgentMuxClient | null = null
    try {
      client = await this.connectRuntimeClient(config, store)
      return { id: config.id, executionHost, client, config,
        ...('runtimeOwnerIdentity' in client && runtimeOwner(client)?.availability !== 'connected'
          ? { warning: endpointWarning(config.id, 'Connecting to Runtime', new AgentMuxError(
            'The endpoint is connecting. Its existing Sessions remain unverified while other endpoints are available.', 'RUNTIME_UNAVAILABLE')) }
          : {}) }
    } catch (error) {
      const cleanup = await Promise.allSettled([
        client?.dispose() ?? Promise.resolve(),
        executionHost.dispose()
      ])
      const cleanupErrors = cleanup.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
      if (cleanupErrors.length > 0) {
        throw new AggregateError([error, ...cleanupErrors], 'Runtime host preparation and cleanup failed.')
      }
      throw error
    }
  }

  private connectEndpointInBackground(hostId: string, client: AgentMuxClient): void {
    if (this.endpointConnections.has(client) || this.hosts.get(hostId)?.client !== client) return
    const connection = (async () => {
      try {
        await client.connect()
        // The Hosted SDK confirms its consumer lease, not completion of Core recovery observation.
        // Only the original Core's current observation event can clear the service window.
        if (this.hosts.get(hostId)?.client !== client) return
      } catch (error) {
        if (this.hosts.get(hostId)?.client !== client) return
        const available = runtimeOwner(client)?.availability === 'connected'
        this.publish(hostId, { type: 'connection-state', state: available ? 'restored' : 'unrecoverable',
          ...(available ? { diagnostic: { code: 'CTXMUX_CONNECTION_OBSERVATION_FAILED',
            message: `${error instanceof Error ? error.message : String(error)}. Original Runtime remains available; retry Session observation.` } } : {}),
          evidence: { source: 'run-process', observedAt: Date.now() } }, endpointWarning(hostId, available ? 'Observing Runtime' : 'Connecting to Runtime', error))
      }
    })()
    this.endpointConnections.set(client, connection)
    void connection.finally(() => {
      if (this.endpointConnections.get(client) === connection) this.endpointConnections.delete(client)
    })
  }

  private assertLauncherUpdateCurrent(update: NonNullable<RuntimePreparation['launcherUpdates']>[number]): void {
    const host = this.hosts.get(update.config.id)
    if (host?.client !== update.client || this.hostSignatures.get(update.config.id) !== update.expectedSignature ||
      host.config.kind !== 'ssh' || host.config.runtimeId !== update.config.runtimeId) {
      throw new AgentMuxError('The Runtime connection changed while confirming its launcher. Retry the original operation; existing consumers and Runs were retained.', 'RUNTIME_OWNER_CHANGED')
    }
  }

  private async assertConfigurable(nextSignatures: ReadonlyMap<string, string>, launcherHostIds: ReadonlySet<string>): Promise<void> {
    for (const [hostId, host] of this.hosts) {
      if (nextSignatures.get(hostId) === this.hostSignatures.get(hostId) || launcherHostIds.has(hostId)) continue
      await host.client.connect()
      if ((await host.client.listRuns()).some(run => run.state === 'running')) {
        throw new Error(`Stop sessions on ${hostId} before changing that host`)
      }
    }
  }

  private async connectedClient(hostId: string, scope: 'runtime' | 'session' = 'session'): Promise<AgentMuxClient> {
    if (this.hostReconfigurationReservations.has(hostId)) {
      throw new Error(`Runtime host is being reconfigured: ${hostId}`)
    }
    const host = this.hosts.get(hostId)
    if (!host) throw new Error(`Runtime host is not configured: ${hostId}`)
    try {
      if (scope === 'runtime') await host.client.connectRuntime()
      else {
        await host.client.connect()
      }
    } catch (error) {
      this.endpointWarnings.set(hostId, endpointWarning(hostId, 'Connecting to Runtime', error))
      throw error
    }
    return host.client
  }

  rpcClients(): readonly { hostId: string; client: AgentMuxClient }[] {
    return [...this.hosts].map(([hostId, host]) => ({ hostId, client: host.client }))
  }

  runtimeBindings(): Map<string, string> {
    return new Map([...this.hosts].flatMap(([hostId, host]) => {
      const identity = runtimeOwner(host.client)
      return host.config.kind === 'ssh' && identity?.availability === 'connected'
        ? [[hostId, identity.runtimeId] as const] : []
    }))
  }

  endpointWarningSnapshot(): RuntimeEndpointWarning[] {
    return [...this.endpointWarnings.values(), ...this.observationWarnings.values()]
  }

  private clearHostObservationWarnings(hostId: string): void {
    for (const [key, warning] of this.observationWarnings) if (warning.hostId === hostId) this.observationWarnings.delete(key)
  }

  private assertObservationHostConnection(hostId: string, host: RuntimeHost): void {
    if (host.config.kind !== 'ssh' || runtimeOwner(host.client)?.availability === 'connected') return
    // The original connection continues in its existing owner. This read cannot wait on an
    // unconfirmed remote handshake or use its untrusted metadata as another Host's facts.
    if (runtimeOwner(host.client) === null) this.connectEndpointInBackground(hostId, host.client)
    throw new AgentMuxError('The endpoint has not completed its trusted Runtime connection. Other endpoints remain available.', 'RUNTIME_UNAVAILABLE')
  }

  reportBindingSaveFailure(preparation: Pick<RuntimePreparation, 'runtimeBindings'>, error: unknown): void {
    for (const hostId of preparation.runtimeBindings?.keys() ?? []) {
      this.endpointWarnings.set(hostId, endpointWarning(hostId, 'Saving Runtime binding', error))
    }
  }

  /** Core is the authority for managed caller capabilities; the renderer never authenticates them. */
  async authorizeAgentCaller(input: { agentSessionId: string; capability: string }): Promise<void> {
    await this.authorizedCallerHost(input)
  }

  private async authorizedCallerHost(input: { agentSessionId: string; capability: string }): Promise<RuntimeHost> {
    const hosts = [...this.hosts.values()]
    // A known exact route avoids unrelated handshakes. Its projection is only a hint:
    // confirm the nonsecret durable identity before sending the capability to its owner.
    const known = hosts.filter(host => (host.config.kind !== 'ssh' || runtimeOwner(host.client)?.availability === 'connected') &&
      host.client.agentSessions().some(session => session.agentSessionId === input.agentSessionId))
    const scopes = known.length === 1 ? known : hosts
    const observed = await Promise.allSettled(scopes.map(async host => {
      this.assertObservationHostConnection(host.config.id, host)
      const ownerRuntimeId = runtimeOwner(host.client)?.runtimeId
      const sessions = await host.client.readAgentSessions()
      return { host, ownerRuntimeId, owns: sessions.some(session => session.hostId === 'local' && session.agentSessionId === input.agentSessionId) }
    }))
    const owners = observed.flatMap(result => result.status === 'fulfilled' && result.value.owns ? [result.value] : [])
    if (owners.length > 1) {
      throw new AgentMuxError('The caller Session has multiple authoritative Host routes. Select its original owner; no capability was sent.', 'AMBIGUOUS_AGENT_SESSION')
    }
    const unconfirmed = observed.find(result => result.status === 'rejected')
    if (unconfirmed?.status === 'rejected') {
      throw unconfirmed.reason instanceof AgentMuxError ? unconfirmed.reason
        : new AgentMuxError('The caller Session owner could not be confirmed. Refresh the original Host without replaying this operation.', 'AGENT_SESSION_STORE_READ_UNCONFIRMED')
    }
    const owner = owners[0]
    if (!owner) throw new AgentMuxError('The caller Session has no confirmed owner.', 'UNKNOWN_AGENT_SESSION')
    const assertOwner = () => {
      if (this.hosts.get(owner.host.config.id) !== owner.host || runtimeOwner(owner.host.client)?.runtimeId !== owner.ownerRuntimeId) {
        throw new AgentMuxError('The caller Host changed while resolving its owner. Read the original owner again.', 'RUNTIME_OWNER_MISMATCH')
      }
      this.assertObservationHostConnection(owner.host.config.id, owner.host)
    }
    assertOwner()
    await owner.host.client.authorizeAgentCaller(input.capability, input.agentSessionId)
    assertOwner()
    return owner.host
  }


  private async trackHostLifecycleOperation<T>(hostId: string, operation: () => Promise<T>): Promise<T> {
    if (this.hostReconfigurationReservations.has(hostId)) {
      throw new Error(`Runtime host is being reconfigured: ${hostId}`)
    }
    const result = operation()
    const settled = result.then(() => {}, () => {})
    const operations = this.hostLifecycleOperations.get(hostId) ?? new Set<Promise<void>>()
    operations.add(settled)
    this.hostLifecycleOperations.set(hostId, operations)
    try {
      return await result
    } finally {
      operations.delete(settled)
      if (operations.size === 0 && this.hostLifecycleOperations.get(hostId) === operations) {
        this.hostLifecycleOperations.delete(hostId)
      }
    }
  }

  private async waitForHostQuiescence(hostId: string): Promise<void> {
    const lifecycle = [...(this.hostLifecycleOperations.get(hostId) ?? [])]
    const attachments = [...this.sessionAttachmentTails.entries()].flatMap(([key, tail]) => (
      sessionAttachmentHostId(key) === hostId ? [tail] : []
    ))
    const terminalInputs = [...this.terminalInputTails.entries()].flatMap(([key, tail]) => (
      sessionAttachmentHostId(key) === hostId ? [tail] : []
    ))
    await Promise.all([...lifecycle, ...attachments, ...terminalInputs])
  }

  private async writeTerminalInput(
    client: AgentMuxClient,
    control: Extract<SessionControl, { kind: 'terminal' }>,
    data: AgentMuxRunInputData,
    diagnostic: InputPerformanceHandle,
    parent: InputObservationReference | null
  ): Promise<void> {
    const key = terminalInputKey(control.hostId, control.runId)
    diagnostic.stage('queued')
    const previous = this.terminalInputTails.get(key) ?? Promise.resolve()
    const operation = previous.catch(() => {}).then(async () => {
      diagnostic.dequeue()
      let expectedByte = this.terminalInputCursors.get(key)
      if (expectedByte == null) {
        const run = (await diagnostic.measure('current-run', () => client.listRuns())).find((candidate) => candidate.runId === control.runId)
        if (!run || run.acceptedInputBytes === null) {
          throw new Error(`Terminal Input cursor is unavailable: ${control.runId}`)
        }
        expectedByte = run.acceptedInputBytes
      }
      diagnostic.stage('operation')
      try {
        const ownerInstanceId = client.runtimeIdentity().instanceId
        diagnostic.executionOwner(ownerInstanceId)
        const accepted = await diagnostic.measure('native-input', () => client.writeTerminal(control.run, {
          ownerInstanceId,
          operationId: randomUUID(),
          expectedByte,
          data
        }, parent ?? undefined))
        if (accepted.acceptedThroughByte !== null) {
          this.terminalInputCursors.set(key, accepted.acceptedThroughByte)
        }
      } catch (error) {
        this.terminalInputCursors.delete(key)
        throw error
      }
    })
    const tail = operation.then(() => {}, () => {})
    this.terminalInputTails.set(key, tail)
    void tail.finally(() => {
      if (this.terminalInputTails.get(key) === tail) this.terminalInputTails.delete(key)
    })
    await operation
  }

  private async sessionByTarget(
    client: AgentMuxClient,
    target: AgentMuxRuntimeSubjectTarget,
    config: AppConfig,
    knownRun?: AgentMuxRun
  ): Promise<SessionSnapshot> {
    const subject = await client.runtimeSubject(target, knownRun)
    const hostId = [...this.hosts].find(([, host]) => host.client === client)?.[0]
    if (!hostId) throw new AgentMuxError('Session owner is no longer configured.', 'RUNTIME_UNAVAILABLE')
    return projectSession({ ...subject, hostId }, config, providerCapabilitiesFrom(client))
  }

  private async serializeSessionAttachment<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.sessionAttachmentTails.get(key) ?? Promise.resolve()
    const result = previous.catch(() => {}).then(operation)
    const tail = result.then(() => {}, () => {})
    this.sessionAttachmentTails.set(key, tail)
    try {
      return await result
    } finally {
      if (this.sessionAttachmentTails.get(key) === tail) this.sessionAttachmentTails.delete(key)
    }
  }

  private async releaseSessionAttachments(webContentsId: number): Promise<void> {
    const attachmentIds = [...this.sessionAttachmentLeases.entries()].flatMap(
      ([attachmentId, lease]) => lease.webContentsId === webContentsId ? [attachmentId] : []
    )
    const results = await Promise.allSettled(
      attachmentIds.map(async (attachmentId) => await this.detachSession(webContentsId, attachmentId))
    )
    const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
    if (errors.length > 0) throw new AggregateError(errors, 'Desktop Session Attachment cleanup failed.')
  }

  private forgetSessionAttachmentOwner(key: string): void {
    const owner = this.sessionAttachmentOwners.get(key)
    if (!owner) return
    for (const attachmentId of owner.attachmentIds) {
      this.sessionAttachmentLeases.delete(attachmentId)
    }
    owner.attachmentIds.clear()
    this.sessionAttachmentOwners.delete(key)
  }

  private publish(hostId: string, event: AgentMuxClientEvent, connectionWarning?: RuntimeEndpointWarning): void {
    const ref = 'run' in event ? event.run : ('evidence' in event ? event.evidence?.run : undefined)
    const toolkit = ref ? this.toolkitRuns.get(terminalInputKey(hostId, ref.runId)) : undefined
    if (toolkit && (event.type === 'terminal-output' || event.type === 'terminal-snapshot')) { toolkit(event); return }
    if (event.type === 'terminal-output' || event.type === 'terminal-snapshot') {
      const queryKey = terminalInputKey(hostId, event.run.runId)
      // Only original tail bytes contain new CLI queries; restoration bytes are synthetic.
      const decoder = new TextDecoder()
      const outputs = event.type === 'terminal-output' ? [event.data] : event.replay
        .filter(chunk => chunk.endByte > event.afterByte)
        .map(chunk => {
          const skip = Math.max(0, event.afterByte - chunk.startByte)
          return decoder.decode(chunk.dataBytes.subarray(skip), { stream: true })
        })
      for (const data of outputs) {
        const scan = scanTerminalOscColorQueries(
          data,
          this.terminalColorQueryRemainders.get(queryKey) ?? '',
          this.terminalViewColors
        )
        if (scan.remainder) this.terminalColorQueryRemainders.set(queryKey, scan.remainder)
        else this.terminalColorQueryRemainders.delete(queryKey)
        if (scan.replies.length > 0) {
          const replies = scan.replies.join('')
          const readyAgentSessionId = this.readyAgentColorQueryRuns.get(queryKey)
          if (readyAgentSessionId) {
            void this.replyToAgentColorQuery(hostId, readyAgentSessionId, event.run.runId, replies)
          } else {
            const pending = `${this.pendingAgentColorQueryReplies.get(queryKey) ?? ''}${replies}`
            if (Buffer.byteLength(pending) <= 4 * 1024) {
              this.pendingAgentColorQueryReplies.set(queryKey, pending)
            }
          }
        }
      }
    } else if (event.type === 'agent-session') {
      const queryKey = terminalInputKey(hostId, event.session.run.runId)
      this.readyAgentColorQueryRuns.set(queryKey, event.session.agentSessionId)
      const pending = this.pendingAgentColorQueryReplies.get(queryKey)
      this.pendingAgentColorQueryReplies.delete(queryKey)
      if (pending) {
        void this.replyToAgentColorQuery(
          hostId,
          event.session.agentSessionId,
          event.session.run.runId,
          pending
        )
      }
    } else if (
      event.type === 'run-removed' ||
      (event.type === 'process-state' && event.state !== 'running')
    ) {
      const queryKey = terminalInputKey(hostId, event.run.runId)
      this.terminalColorQueryRemainders.delete(queryKey)
      this.pendingAgentColorQueryReplies.delete(queryKey)
      this.readyAgentColorQueryRuns.delete(queryKey)
    }
    // 资源采样要知道每个 run 的 pid，而 Core 已经在这条事件里报了它——顺手记下即可，
    // 不新建第二份 pid 台账（第二份会与 Core 漂移，且漂移时不会有任何测试变红）。
    if (this.hosts.get(hostId)?.executionHost.kind === 'local' && event.type === 'process-state') {
      if (event.state === 'running') this.resourceSampler.trackRun(event.run.runId, event.pid, hostId)
      else this.resourceSampler.forgetRun(event.run.runId)
    } else if (this.hosts.get(hostId)?.executionHost.kind === 'local' && event.type === 'run-removed') {
      this.resourceSampler.forgetRun(event.run.runId)
    }
    if (toolkit) { toolkit(event); return }
    let warningChange: RuntimeEndpointWarning | null | undefined
    let endpointObservation: RuntimeEvent['endpointObservation']
    if (event.type === 'control-endpoint-state') {
      const step = CONTROL_ENDPOINT_PUBLICATION_STEP
      const key = JSON.stringify([hostId, step])
      const warning: RuntimeEndpointWarning | null = event.state === 'unavailable' ? {
        hostId, step, scope: 'observation', availability: 'connected',
        code: event.diagnostic.code, message: event.diagnostic.message,
        recovery: 'The original Core owner retries publication automatically. Existing Sessions and accepted connections are retained; new connections may be unavailable until publication is restored.'
      } : null
      if (warning) this.observationWarnings.set(key, warning)
      else this.observationWarnings.delete(key)
      endpointObservation = { step, warning }
    }
    if (event.type === 'connection-state') {
      const recoveryWarningKey = JSON.stringify([hostId, 'Observing Runtime'])
      if (event.state === 'restored' && !event.diagnostic) {
        this.observationWarnings.delete(recoveryWarningKey)
        if (this.endpointWarnings.get(hostId)?.step !== 'Saving Runtime binding') {
          this.endpointWarnings.delete(hostId)
          warningChange = null
        }
      } else {
        warningChange = connectionWarning ?? endpointWarning(hostId, 'Observing Runtime',
          event.diagnostic ? new AgentMuxError(event.diagnostic.message, event.diagnostic.code) :
          new AgentMuxError(event.state === 'lost' ? 'Runtime connection was lost.' :
            'Automatic reconnect did not verify the Runtime. Its existing Sessions remain unverified; reconnect this endpoint.', 'RUNTIME_UNAVAILABLE'))
        if (event.state === 'restored') warningChange = { ...warningChange, availability: 'connected' }
        if (event.state === 'restored' && this.endpointWarnings.get(hostId)?.step === 'Saving Runtime binding') {
          warningChange = { ...warningChange, scope: 'observation' }
          this.observationWarnings.set(recoveryWarningKey, warningChange)
        } else this.endpointWarnings.set(hostId, warningChange)
      }
    }
    const projectedEvent = event.type === 'agent-session' ? { ...event, session: { ...event.session, hostId } } : event
    const runtimeEvent: RuntimeEvent = { type: 'core', hostId, event: projectedEvent,
      ...(endpointObservation ? { endpointObservation } : {}),
      ...(warningChange !== undefined ? { endpointWarning: warningChange } : {}) }
    for (const client of this.clients) {
      if (client.isDestroyed()) continue
      try {
        client.send(SESSION_EVENT_CHANNEL, runtimeEvent)
      } catch (error) {
        console.error('Failed to publish AgentMux Runtime event', error)
      }
    }
  }

  private async replyToAgentColorQuery(
    hostId: string,
    agentSessionId: string,
    runId: string,
    data: string
  ): Promise<void> {
    try {
      await (await this.connectedClient(hostId, 'runtime')).writeAgent({
        agentSessionId, expectedRun: { runId }, data, source: 'terminal-protocol'
      })
    } catch (error) {
      console.error(`Failed to answer Terminal color query for Run ${runId}`, error)
    }
  }
}
