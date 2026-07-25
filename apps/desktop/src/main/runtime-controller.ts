import { randomUUID } from 'node:crypto'
import {
  AgentMuxError,
  AgentMuxMemoryAgentSessionStore,
  connectLocalAgentMux,
  connectSshAgentMux,
  type AgentCapabilities,
  type AgentCatalogEntry,
  type AgentExecutorId,
  type AgentProviderId,
  type AgentMuxClient,
  type AgentMuxClientEvent,
  type AgentMuxAgentSessionStore,
  type AgentMuxRuntimeSubject,
  type ExecutionHost
} from '@agentmux/core'
import type { WebContents } from 'electron'
import type {
  ExecutorDetection,
  AgentLaunchResult,
  AgentLaunchInput,
  AgentSessionRecoveryCandidate,
  AppConfig,
  HostCheckResult,
  HostConfig,
  RuntimeEvent,
  RuntimeSnapshot,
  SessionAttachResult,
  SessionControl,
  SessionRecoveryResult,
  SessionSnapshot,
  TerminalLaunchInput
} from '../shared/contracts.js'
import {
  scanTerminalOscColorQueries,
  type TerminalOscColorQueryReplyColors
} from '../shared/terminal-osc-color-query.js'
import { createExecutionHost } from './host-factory.js'
import { ScratchTopics, type PreparedScratchAgentTopic } from './scratch-topics.js'
import {
  SCRATCH_WORKSPACE_ID,
  scratchTopicIdFromWorkspacePath,
  workspaceOwnsSessionPath
} from '../shared/scratch-topics.js'

type RuntimeHost = {
  executionHost: ExecutionHost
  client: AgentMuxClient
  unsubscribe: () => void
}

type PreparedRuntimeHost = {
  id: string
  executionHost: ExecutionHost
  client: AgentMuxClient
}

type SessionAttachmentOwner = {
  control: SessionControl
  controlIdentity: string
  attachmentIds: Set<string>
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
}

function signatures(config: AppConfig): Map<string, string> {
  return new Map(config.hosts.map((host) => [host.id, JSON.stringify(host)]))
}

function workspaceLabel(config: AppConfig, hostId: string, path: string): string {
  return config.workspaces.find((workspace) => workspaceOwnsSessionPath(workspace, {
    hostId,
    workspacePath: path
  }))?.name
    ?? path.split(/[\\/]/).filter(Boolean).at(-1)
    ?? path
}

function terminalInputKey(hostId: string, runId: string): string {
  return JSON.stringify([hostId, runId])
}

function requireSessionExecutor(
  config: AppConfig,
  session: { executorId: AgentExecutorId; providerId: AgentProviderId }
): AppConfig['executors'][AgentExecutorId] {
  const executor = config.executors[session.executorId]
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

function projectSession(
  subject: AgentMuxRuntimeSubject,
  config: AppConfig,
  capabilities?: AgentCapabilities
): SessionSnapshot {
  const run = subject.run
  const observedAt = run.observedAt
  const status = {
    state: run.state === 'interrupted' ? 'error' as const : run.state,
    source: 'run-process' as const,
    observedAt,
    ...(run.state === 'interrupted'
      ? { detail: run.interruptionReason ?? 'The Run owner interrupted this PTY.' }
      : run.exitSignal !== undefined
        ? { detail: `signal ${run.exitSignal}` }
        : {}),
    ...(run.exitCode === undefined ? {} : { exitCode: run.exitCode })
  }
  if (subject.kind === 'agent') {
    const configuredExecutor = config.executors[subject.executorId]
    const executorLabel = configuredExecutor?.providerId === subject.providerId
      ? configuredExecutor.label
      : subject.executorId
    return {
      id: subject.agentSession.agentSessionId,
      kind: 'agent',
      providerId: subject.providerId,
      executorId: subject.executorId,
      capabilities: capabilities ?? {
        terminal: true,
        hookEvents: false,
        timeline: 'unavailable',
        permission: 'none',
        providerResume: false,
        acp: false,
        replyCorrelation: 'none'
      },
      hostId: subject.hostId,
      workspacePath: subject.workspacePath,
      label: `${executorLabel} · ${workspaceLabel(config, subject.hostId, subject.workspacePath)}`,
      createdAt: subject.agentSession.createdAt,
      updatedAt: Math.max(subject.agentSession.updatedAt, observedAt),
      processState: run.state,
      status,
      latestOutputBytes: run.latestOutputBytes,
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
    status,
    latestOutputBytes: run.latestOutputBytes,
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
  private readonly clients = new Set<WebContents>()
  private readonly sessionAttachmentOwners = new Map<string, SessionAttachmentOwner>()
  private readonly sessionAttachmentLeases = new Map<string, SessionAttachmentLease>()
  private readonly sessionAttachmentTails = new Map<string, Promise<void>>()
  private readonly rendererGenerations = new Map<number, number>()
  private readonly hostLifecycleOperations = new Map<string, Set<Promise<void>>>()
  private readonly hostReconfigurationReservations = new Set<string>()
  private readonly terminalInputCursors = new Map<string, number>()
  private readonly terminalInputTails = new Map<string, Promise<void>>()
  private readonly terminalColorQueryRemainders = new Map<string, string>()
  private readonly pendingAgentColorQueryReplies = new Map<string, string>()
  private readonly readyAgentColorQueryRuns = new Map<string, string>()
  private terminalViewColors: TerminalOscColorQueryReplyColors = {
    foreground: '#ffffff',
    background: '#000000'
  }
  private hostSignatures = new Map<string, string>()

  constructor(
    private readonly agentSessionStore: AgentMuxAgentSessionStore,
    private readonly scratchTopics: ScratchTopics = new ScratchTopics()
  ) {}

  setTerminalViewColors(colors: TerminalOscColorQueryReplyColors): void {
    this.terminalViewColors = { ...colors }
  }

  resourceOwnerCounts(): { sessionAttachmentOwners: number; sessionAttachmentLeases: number } {
    return {
      sessionAttachmentOwners: this.sessionAttachmentOwners.size,
      sessionAttachmentLeases: this.sessionAttachmentLeases.size
    }
  }

  async prepare(config: AppConfig): Promise<RuntimePreparation> {
    const nextSignatures = signatures(config)
    const changed = config.hosts.filter(
      (host) => this.hostSignatures.get(host.id) !== nextSignatures.get(host.id)
    )
    const removedHostIds = [...this.hostSignatures.keys()].filter((id) => !nextSignatures.has(id))
    const reservedHostIds = [...new Set([
      ...removedHostIds,
      ...changed.flatMap((host) => this.hosts.has(host.id) ? [host.id] : [])
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
      await this.assertConfigurable(nextSignatures)
      const results = await Promise.allSettled(changed.map(async (host) => await this.prepareHost(host)))
      const prepared = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
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
      return {
        hosts: prepared,
        removedHostIds,
        hostSignatures: nextSignatures,
        reservedHostIds
      }
    } catch (error) {
      for (const hostId of reservedHostIds) this.hostReconfigurationReservations.delete(hostId)
      throw error
    }
  }

  commit(preparation: RuntimePreparation): void {
    try {
      const retired = new Map<string, RuntimeHost>()
      for (const id of preparation.removedHostIds) {
        const host = this.hosts.get(id)
        if (host) retired.set(id, host)
        this.hosts.delete(id)
      }
      for (const prepared of preparation.hosts) {
        const previous = this.hosts.get(prepared.id)
        if (previous) retired.set(prepared.id, previous)
        const unsubscribe = prepared.client.onEvent((event) => this.publish(prepared.id, event))
        this.hosts.set(prepared.id, { ...prepared, unsubscribe })
      }
      this.hostSignatures = preparation.hostSignatures
      for (const [id, host] of retired) {
        host.unsubscribe()
        void disposePrepared([{ id, executionHost: host.executionHost, client: host.client }]).catch((error) => {
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

  executionHost(hostId: string): ExecutionHost {
    const host = this.hosts.get(hostId)
    if (!host) throw new Error(`Runtime host is not configured: ${hostId}`)
    return host.executionHost
  }

  async checkHost(config: HostConfig): Promise<HostCheckResult> {
    let prepared: PreparedRuntimeHost | null = null
    try {
      prepared = await this.prepareHost(config, new AgentMuxMemoryAgentSessionStore())
      const identity = prepared.client.runtimeIdentity()
      return {
        ok: true,
        detail: `Runtime ${identity.buildIdentity} · protocol ${identity.protocolVersion}`
      }
    } finally {
      if (prepared) await disposePrepared([prepared])
    }
  }

  providerCatalog(): AgentCatalogEntry[] {
    const runtimeHost = this.hosts.values().next().value as RuntimeHost | undefined
    if (!runtimeHost) throw new Error('Runtime has no configured hosts.')
    return runtimeHost.client.providers.catalog()
  }

  async detect(executorId: AgentExecutorId, hostId: string, config: AppConfig): Promise<ExecutorDetection> {
    const executor = config.executors[executorId]
    if (!executor) throw new Error(`Missing Agent Executor configuration: ${executorId}`)
    const client = await this.connectedClient(hostId)
    return {
      executorId,
      providerId: executor.providerId,
      hostId,
      installed: (await client.probeAgent(executor.providerId, executor.command)).installed
    }
  }

  async snapshot(config: AppConfig): Promise<RuntimeSnapshot> {
    const projections = await Promise.all([...this.hosts.values()].map(async ({ client }) => {
      await client.connect()
      let projection = await client.runtimeProjection()
      while (true) {
        const agentSubjects = projection.subjects.filter((subject): subject is Extract<AgentMuxRuntimeSubject, { kind: 'agent' }> => (
          subject.kind === 'agent'
        ))
        const timelineResults = await Promise.allSettled(agentSubjects.map(async (subject) => (
          await client.sessionTimeline(subject.agentSession.agentSessionId)
        )))
        const timelineEntries = timelineResults.flatMap((result, index) => {
          if (result.status === 'rejected') return []
          const agentSessionId = agentSubjects[index]!.agentSession.agentSessionId
          if (result.value.agentSessionId !== agentSessionId) {
            throw new Error(`Runtime snapshot returned a Timeline for another Session: ${result.value.agentSessionId}`)
          }
          return [[agentSessionId, result.value] as const]
        })
        const failures = timelineResults.flatMap((result, index) => result.status === 'rejected'
          ? [{ agentSessionId: agentSubjects[index]!.agentSession.agentSessionId, reason: result.reason }]
          : [])
        if (failures.length === 0) return { client, projection, timelineEntries }

        const refreshed = await client.runtimeProjection()
        const refreshedAgentIds = new Set(refreshed.subjects.flatMap((subject) => (
          subject.kind === 'agent' ? [subject.agentSession.agentSessionId] : []
        )))
        const persistentFailure = failures.find((failure) => refreshedAgentIds.has(failure.agentSessionId))
        if (persistentFailure) throw persistentFailure.reason
        projection = refreshed
      }
    }))
    for (const { projection } of projections) {
      for (const subject of projection.subjects) {
        if (subject.kind !== 'terminal') continue
        this.terminalInputCursors.set(
          terminalInputKey(subject.hostId, subject.run.runId),
          subject.run.acceptedInputBytes
        )
      }
    }
    const sessions = projections.flatMap(({ client, projection }) => projection.subjects.map((subject) => (
      projectSession(
        subject,
        config,
        subject.kind === 'agent'
          ? client.providers.get(subject.providerId).catalog.capabilities
          : undefined
      )
    )))
    const recoveryCandidates = projections.flatMap(({ client, projection }) => {
      const projected = new Set(projection.subjects.flatMap((subject) => (
        subject.kind === 'agent' ? [subject.agentSession.agentSessionId] : []
      )))
      return client.agentSessions().flatMap((session): AgentSessionRecoveryCandidate[] => {
        if (projected.has(session.agentSessionId)) return []
        const configuredExecutor = config.executors[session.executorId]
        const executorLabel = configuredExecutor?.providerId === session.providerId
          ? configuredExecutor.label
          : session.executorId
        return [{
          agentSessionId: session.agentSessionId,
          hostId: session.hostId,
          workspacePath: session.workspacePath,
          providerId: session.providerId,
          executorId: session.executorId,
          capabilities: client.providers.get(session.providerId).catalog.capabilities,
          label: `${executorLabel} · ${workspaceLabel(config, session.hostId, session.workspacePath)}`,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          run: { ...session.run }
        }]
      })
    })
    const timelineEntries = projections.flatMap(({ timelineEntries: entries }) => entries)
    return { sessions, timelines: Object.fromEntries(timelineEntries), recoveryCandidates }
  }

  async launchAgent(request: AgentLaunchInput, config: AppConfig): Promise<AgentLaunchResult> {
    return await this.trackHostLifecycleOperation(request.hostId, async () => {
      const executor = config.executors[request.executorId]
      if (!executor) throw new Error(`Missing Agent Executor configuration: ${request.executorId}`)
      const client = await this.connectedClient(request.hostId)
      let preparedTopic: PreparedScratchAgentTopic | null = null
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
        const launchPrompt = preparedTopic
          ? `${preparedTopic.prompt}\n\n${request.prompt?.trim()
              ? `Task:\n${request.prompt}`
              : 'No task has been given yet. Wait for the user.'}`
          : request.prompt
        const agentSession = await client.createAgent({
          providerId: executor.providerId,
          executorId: request.executorId,
          workspacePath: preparedTopic?.absolutePath ?? request.workspacePath,
          args: executor.args,
          env: {
            ...executor.env,
            ...(preparedTopic ? { AGENTMUX_WIKI_DIR: preparedTopic.absolutePath } : {})
          },
          injectAgentMuxGuide: executor.injectAgentMuxGuide,
          commandOverride: executor.command,
          ...(request.agentSessionId === undefined ? {} : { agentSessionId: request.agentSessionId }),
          ...(request.createOperationId === undefined ? {} : { createOperationId: request.createOperationId }),
          ...(launchPrompt === undefined ? {} : { prompt: launchPrompt }),
          ...(request.cols === undefined ? {} : { cols: request.cols }),
          ...(request.rows === undefined ? {} : { rows: request.rows })
        })
        try {
          const session = await this.sessionById(client, agentSession.agentSessionId, config)
          if (session.kind !== 'agent') {
            throw new Error(`Agent launch projected a non-Agent Session: ${agentSession.agentSessionId}`)
          }
          const timeline = await client.sessionTimeline(agentSession.agentSessionId)
          if (timeline.agentSessionId !== agentSession.agentSessionId) {
            throw new Error(`Agent launch returned a Timeline for another Session: ${timeline.agentSessionId}`)
          }
          return { session, timeline }
        } catch (error) {
          try {
            await client.stopAgent(agentSession.agentSessionId, agentSession.run)
          } catch (cleanupError) {
            throw new AggregateError(
              [error, cleanupError],
              `Agent launch projection failed and cleanup also failed: ${agentSession.agentSessionId}`
            )
          }
          throw error
        }
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
    })
  }

  async sessionTimeline(control: Extract<SessionControl, { kind: 'agent' }>) {
    const client = await this.connectedClient(control.hostId)
    const timeline = await client.sessionTimeline(control.agentSessionId)
    if (timeline.agentSessionId !== control.agentSessionId) {
      throw new Error(`Timeline snapshot belongs to another Session: ${timeline.agentSessionId}`)
    }
    return timeline
  }

  async launchTerminal(request: TerminalLaunchInput, config: AppConfig): Promise<SessionSnapshot> {
    return await this.trackHostLifecycleOperation(request.hostId, async () => {
      const client = await this.connectedClient(request.hostId)
      const run = await client.createTerminal({
        createOperationId: request.createOperationId ?? randomUUID(),
        workspacePath: request.workspacePath,
        ...(request.shellCommand === undefined
          ? {}
          : {
              command: process.env.SHELL ?? '/bin/sh',
              args: ['-lc', request.shellCommand]
            }),
        ...(request.cols === undefined ? {} : { cols: request.cols }),
        ...(request.rows === undefined ? {} : { rows: request.rows })
      })
      this.terminalInputCursors.set(
        terminalInputKey(request.hostId, run.runId),
        run.acceptedInputBytes
      )
      return await this.sessionById(client, run.runId, config)
    })
  }

  async attachSession(
    webContentsId: number,
    control: SessionControl,
    afterByte: number,
    config: AppConfig
  ): Promise<SessionAttachResult> {
    const key = sessionAttachmentKey(control)
    const rendererGeneration = this.rendererGenerations.get(webContentsId) ?? 0
    return await this.serializeSessionAttachment(key, async () => {
      const client = await this.connectedClient(control.hostId)
      const existing = this.sessionAttachmentOwners.get(key)
      const identity = sessionControlIdentity(control)
      if (existing && existing.controlIdentity !== identity) {
        throw new Error('A Session Attachment owner already exists for this exact Run identity.')
      }
      let retainedRun: { runId: string } | null = null
      try {
        const attached = existing
          ? await client.readRunReplay(control.run, afterByte)
          : control.kind === 'agent'
            ? (await client.reattachAgent(control.agentSessionId, afterByte)).attachment
            : await client.attachTerminal(control.runId, afterByte)
        if (!existing) retainedRun = attached.run
        if (attached.run.runId !== control.run.runId) {
          throw new Error('The Session control changed before its exact Run Attachment was established.')
        }
        const session = await this.sessionById(
          client,
          control.kind === 'agent' ? control.agentSessionId : control.runId,
          config
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
        const attachmentId = randomUUID()
        const owner = existing ?? { control, controlIdentity: identity, attachmentIds: new Set<string>() }
        owner.attachmentIds.add(attachmentId)
        this.sessionAttachmentOwners.set(key, owner)
        this.sessionAttachmentLeases.set(attachmentId, { key, webContentsId })
        retainedRun = null
        return { attachmentId, session, replay: attached.replay, gap: attached.gap }
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
      await (await this.connectedClient(owner.control.hostId)).releaseRunAttachment(owner.control.run)
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
  ): Promise<void> {
    const lease = this.sessionAttachmentLeases.get(attachmentId)
    if (!lease) return
    if (lease.webContentsId !== webContentsId) {
      throw new Error('The Session Attachment lease belongs to a different Desktop client.')
    }
    await this.serializeSessionAttachment(lease.key, async () => {
      const currentLease = this.sessionAttachmentLeases.get(attachmentId)
      if (!currentLease) return
      if (currentLease.webContentsId !== webContentsId || currentLease.key !== lease.key) {
        throw new Error('The Session Attachment lease owner changed before resize.')
      }
      const owner = this.sessionAttachmentOwners.get(lease.key)
      if (!owner?.attachmentIds.has(attachmentId)) return
      const client = await this.connectedClient(owner.control.hostId)
      if (owner.control.kind === 'agent') {
        await client.resizeAgent(
          owner.control.agentSessionId,
          owner.control.run,
          cols,
          rows
        )
      } else {
        await client.resizeTerminal(owner.control.run, cols, rows)
      }
    })
  }

  async write(control: SessionControl, data: string): Promise<void> {
    const client = await this.connectedClient(control.hostId)
    if (control.kind === 'agent') await client.writeAgent(control.agentSessionId, data)
    else await this.writeTerminalInput(client, control, data)
  }

  async submitPrompt(
    control: Extract<SessionControl, { kind: 'agent' }>,
    prompt: string
  ): Promise<void> {
    await this.trackHostLifecycleOperation(control.hostId, async () => {
      const client = await this.connectedClient(control.hostId)
      const status = await client.statusAgent(control.agentSessionId)
      if (status.run.runId !== control.run.runId) {
        throw new AgentMuxError('Agent Session changed before prompt submission.', 'STALE_AGENT_SESSION')
      }
      if (status.run.state !== 'running') {
        throw new AgentMuxError('Agent Session is not running. Use explicit resume.', 'SESSION_NOT_RUNNING')
      }
      await client.submitAgentPrompt({
        agentSessionId: control.agentSessionId,
        operationId: randomUUID(),
        prompt
      })
    })
  }

  async resumeSession(
    control: Extract<SessionControl, { kind: 'agent' }>,
    prompt: string,
    operationId: string,
    config: AppConfig
  ): Promise<SessionSnapshot> {
    return await this.trackHostLifecycleOperation(control.hostId, async () => {
      const client = await this.connectedClient(control.hostId)
      const status = await client.statusAgent(control.agentSessionId)
      if (status.run.runId !== control.run.runId) {
        throw new AgentMuxError('Agent Session changed before explicit resume.', 'STALE_AGENT_SESSION')
      }
      const executor = requireSessionExecutor(config, status.session)
      const resumed = await client.resumeAgent({
        agentSessionId: control.agentSessionId,
        operationId,
        prompt,
        args: executor.args,
        env: executor.env,
        commandOverride: executor.command
      })
      if (resumed.agentSessionId !== control.agentSessionId) {
        throw new AgentMuxError('Agent resume returned another Session identity.', 'LAUNCH_RESULT_MISMATCH')
      }
      return await this.sessionById(client, control.agentSessionId, config)
    })
  }

  async acknowledge(control: SessionControl, throughByte: number): Promise<void> {
    const client = await this.connectedClient(control.hostId)
    if (control.kind === 'agent') await client.acknowledgeAgentOutput(control.agentSessionId, throughByte)
    else await client.acknowledgeTerminalOutput(control.run, throughByte)
  }

  async interrupt(control: SessionControl): Promise<void> {
    const client = await this.connectedClient(control.hostId)
    if (control.kind === 'agent') await client.signalAgent(control.agentSessionId, 'SIGINT')
    else await client.signalTerminal(control.run, 'SIGINT')
  }

  async refresh(control: SessionControl, config: AppConfig): Promise<SessionSnapshot> {
    return await this.sessionById(
      await this.connectedClient(control.hostId),
      control.kind === 'agent' ? control.agentSessionId : control.runId,
      config
    )
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
    workspacePath?: string
  ): Promise<SessionRecoveryResult> {
    return await this.trackHostLifecycleOperation(
      control.hostId,
      async () => await this.performRecovery(control, config, workspacePath)
    )
  }

  private async performRecovery(
    control: SessionControl,
    config: AppConfig,
    workspacePath?: string
  ): Promise<SessionRecoveryResult> {
    const client = await this.connectedClient(control.hostId)
    if (control.kind === 'terminal') {
      const cwd = workspacePath ?? (await this.sessionById(client, control.runId, config)).workspacePath
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
        session: await this.sessionById(client, run.runId, config)
      }
    }
    let stored
    try {
      stored = client.agentSession(control.agentSessionId)
    } catch {
      const result = await client.ensureAgentContinuity({
        agentSessionId: control.agentSessionId,
        expectedRun: control.run,
        operationId: randomUUID()
      })
      if (result.kind === 'reattachable' || result.kind === 'resumed') {
        throw new Error('Core returned live continuity without a current Agent Session.')
      }
      return result
    }
    const executor = requireSessionExecutor(config, stored)
    const scratch = config.workspaces.find((workspace) => (
      workspace.id === SCRATCH_WORKSPACE_ID && workspace.hostId === control.hostId
    ))
    const scratchTopicId = scratch
      ? scratchTopicIdFromWorkspacePath(scratch.path, stored.workspacePath)
      : null
    const result = await client.ensureAgentContinuity({
      agentSessionId: control.agentSessionId,
      expectedRun: control.run,
      operationId: randomUUID(),
      args: executor.args,
      env: {
        ...executor.env,
        ...(scratchTopicId ? { AGENTMUX_WIKI_DIR: stored.workspacePath } : {})
      },
      commandOverride: executor.command
    })
    if (result.kind !== 'reattachable' && result.kind !== 'resumed') return result
    return {
      kind: result.kind,
      session: await this.sessionById(client, control.agentSessionId, config)
    }
  }

  async stopSession(control: SessionControl): Promise<void> {
    const attachmentKey = sessionAttachmentKey(control)
    await this.serializeSessionAttachment(attachmentKey, async () => {
      const client = await this.connectedClient(control.hostId)
      if (control.kind === 'agent') {
        await client.stopAgent(control.agentSessionId, control.run)
      } else {
        await client.stopTerminal(control.run)
        const inputKey = terminalInputKey(control.hostId, control.runId)
        this.terminalInputCursors.delete(inputKey)
        this.terminalInputTails.delete(inputKey)
      }
      this.forgetSessionAttachmentOwner(attachmentKey)
    })
  }

  async dispose(): Promise<void> {
    const hosts = [...this.hosts.entries()]
    for (const [hostId] of hosts) this.hostReconfigurationReservations.add(hostId)
    await Promise.all(hosts.map(async ([hostId]) => await this.waitForHostQuiescence(hostId)))
    this.hosts.clear()
    this.clients.clear()
    this.sessionAttachmentOwners.clear()
    this.sessionAttachmentLeases.clear()
    this.sessionAttachmentTails.clear()
    this.rendererGenerations.clear()
    this.hostLifecycleOperations.clear()
    this.hostReconfigurationReservations.clear()
    this.hostSignatures.clear()
    this.terminalInputCursors.clear()
    this.terminalInputTails.clear()
    this.terminalColorQueryRemainders.clear()
    this.pendingAgentColorQueryReplies.clear()
    this.readyAgentColorQueryRuns.clear()
    for (const [, host] of hosts) host.unsubscribe()
    await disposePrepared(hosts.map(([id, host]) => ({ id, ...host })))
  }

  private async prepareHost(
    config: HostConfig,
    store: AgentMuxAgentSessionStore = this.agentSessionStore
  ): Promise<PreparedRuntimeHost> {
    const executionHost = createExecutionHost(config)
    let client: AgentMuxClient | null = null
    try {
      if (config.kind === 'local') {
        client = await connectLocalAgentMux({ store })
      } else {
        client = await connectSshAgentMux({
          store,
          target: {
            hostId: config.id,
            hostname: config.hostname,
            ...(config.user ? { user: config.user } : {}),
            ...(config.port ? { port: config.port } : {}),
            ...(config.identityFile ? { identityFile: config.identityFile } : {})
          },
        })
      }
      return { id: config.id, executionHost, client }
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

  private async assertConfigurable(nextSignatures: ReadonlyMap<string, string>): Promise<void> {
    for (const [hostId, host] of this.hosts) {
      if (nextSignatures.get(hostId) === this.hostSignatures.get(hostId)) continue
      await host.client.connect()
      if ((await host.client.listRuns()).length > 0) {
        throw new Error(`Stop sessions on ${hostId} before changing that host`)
      }
    }
  }

  private async connectedClient(hostId: string): Promise<AgentMuxClient> {
    if (this.hostReconfigurationReservations.has(hostId)) {
      throw new Error(`Runtime host is being reconfigured: ${hostId}`)
    }
    const host = this.hosts.get(hostId)
    if (!host) throw new Error(`Runtime host is not configured: ${hostId}`)
    await host.client.connect()
    return host.client
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
    data: string
  ): Promise<void> {
    const key = terminalInputKey(control.hostId, control.runId)
    const previous = this.terminalInputTails.get(key) ?? Promise.resolve()
    const operation = previous.catch(() => {}).then(async () => {
      let expectedByte = this.terminalInputCursors.get(key)
      if (expectedByte === undefined) {
        const run = (await client.listRuns()).find((candidate) => candidate.runId === control.runId)
        if (!run || run.acceptedInputBytes === null) {
          throw new Error(`Terminal Input cursor is unavailable: ${control.runId}`)
        }
        expectedByte = run.acceptedInputBytes
      }
      try {
        const accepted = await client.writeTerminal(control.run, {
          ownerInstanceId: client.runtimeIdentity().instanceId,
          operationId: randomUUID(),
          expectedByte,
          data
        })
        this.terminalInputCursors.set(key, accepted.acceptedThroughByte)
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

  private async sessionById(
    client: AgentMuxClient,
    subjectId: string,
    config: AppConfig
  ): Promise<SessionSnapshot> {
    const subject = (await client.runtimeProjection()).subjects.find((candidate) => (
      candidate.kind === 'agent'
        ? candidate.agentSession.agentSessionId === subjectId
        : candidate.run.runId === subjectId
    ))
    if (!subject) throw new Error(`Runtime subject is not available: ${subjectId}`)
    return projectSession(
      subject,
      config,
      subject.kind === 'agent'
        ? client.providers.get(subject.providerId).catalog.capabilities
        : undefined
    )
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

  private publish(hostId: string, event: AgentMuxClientEvent): void {
    if (event.type === 'terminal-output') {
      const queryKey = terminalInputKey(hostId, event.run.runId)
      const scan = scanTerminalOscColorQueries(
        event.data,
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
    const runtimeEvent: RuntimeEvent = { type: 'core', hostId, event }
    for (const client of this.clients) {
      if (client.isDestroyed()) continue
      try {
        client.send('agentmux:session-event', runtimeEvent)
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
      await (await this.connectedClient(hostId)).writeAgent(agentSessionId, data)
    } catch (error) {
      console.error(`Failed to answer Terminal color query for Run ${runId}`, error)
    }
  }
}
