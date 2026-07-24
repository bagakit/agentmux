import { randomUUID } from 'node:crypto'
import {
  AgentMuxClient,
  AgentMuxMemorySemanticStore,
  SshAgentMuxDaemonConnector,
  activateAgentMuxLocalDaemon,
  type AgentId,
  type AgentMuxClientEvent,
  type AgentMuxSemanticStore,
  type AgentMuxSessionSnapshot,
  type ExecutionHost
} from '@agentmux/core'
import type { WebContents } from 'electron'
import type {
  AgentDetection,
  AgentLaunchInput,
  AppConfig,
  HostCheckResult,
  HostConfig,
  RuntimeEvent,
  SessionAttachResult,
  SessionControl,
  SessionSnapshot,
  TerminalLaunchInput
} from '../shared/contracts.js'
import { createExecutionHost } from './host-factory.js'

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

export type RuntimePreparation = {
  hosts: PreparedRuntimeHost[]
  removedHostIds: string[]
  hostSignatures: Map<string, string>
}

function signatures(config: AppConfig): Map<string, string> {
  return new Map(config.hosts.map((host) => [host.id, JSON.stringify(host)]))
}

function workspaceLabel(config: AppConfig, hostId: string, path: string): string {
  return config.workspaces.find((workspace) => workspace.hostId === hostId && workspace.path === path)?.name
    ?? path.split(/[\\/]/).filter(Boolean).at(-1)
    ?? path
}

function projectSession(session: AgentMuxSessionSnapshot, config: AppConfig): SessionSnapshot {
  const run = session.run
  const observedAt = run.exitedAt ?? run.lostAt ?? run.createdAt
  const status = {
    state: run.state === 'lost' ? 'error' as const : run.state,
    source: 'daemon-process' as const,
    observedAt,
    ...(run.state === 'lost'
      ? { detail: 'The daemon restarted; this PTY can no longer be attached.' }
      : run.exitSignal !== undefined
        ? { detail: `signal ${run.exitSignal}` }
        : {}),
    ...(run.exitCode === undefined ? {} : { exitCode: run.exitCode })
  }
  if (session.kind === 'agent') {
    return {
      id: session.id,
      kind: 'agent',
      agentId: session.agentId,
      hostId: session.hostId,
      workspacePath: session.workspacePath,
      label: `${session.agentId} · ${workspaceLabel(config, session.hostId, session.workspacePath)}`,
      createdAt: session.semantic.createdAt,
      updatedAt: Math.max(session.semantic.updatedAt, observedAt),
      processState: run.state,
      status,
      latestSequence: run.latestSequence,
      control: {
        kind: 'agent',
        hostId: session.hostId,
        semanticSessionId: session.semantic.semanticSessionId,
        daemonSession: { ...session.semantic.daemonSession }
      }
    }
  }
  return {
    id: session.id,
    kind: 'terminal',
    agentId: null,
    hostId: session.hostId,
    workspacePath: session.workspacePath,
    label: `Terminal · ${workspaceLabel(config, session.hostId, session.workspacePath)}`,
    createdAt: run.createdAt,
    updatedAt: observedAt,
    processState: run.state,
    status,
    latestSequence: run.latestSequence,
    control: {
      kind: 'terminal',
      hostId: session.hostId,
      sessionId: run.sessionId,
      daemonSession: { sessionId: run.sessionId, incarnationId: run.incarnationId }
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
  private hostSignatures = new Map<string, string>()

  constructor(private readonly semanticStore: AgentMuxSemanticStore) {}

  async prepare(config: AppConfig): Promise<RuntimePreparation> {
    const nextSignatures = signatures(config)
    await this.assertConfigurable(nextSignatures)
    const changed = config.hosts.filter(
      (host) => this.hostSignatures.get(host.id) !== nextSignatures.get(host.id)
    )
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
      removedHostIds: [...this.hostSignatures.keys()].filter((id) => !nextSignatures.has(id)),
      hostSignatures: nextSignatures
    }
  }

  commit(preparation: RuntimePreparation): void {
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
  }

  async discard(preparation: RuntimePreparation): Promise<void> {
    await disposePrepared(preparation.hosts)
  }

  attach(client: WebContents): () => void {
    this.clients.add(client)
    return () => this.clients.delete(client)
  }

  executionHost(hostId: string): ExecutionHost {
    const host = this.hosts.get(hostId)
    if (!host) throw new Error(`Runtime host is not configured: ${hostId}`)
    return host.executionHost
  }

  async checkHost(config: HostConfig): Promise<HostCheckResult> {
    let prepared: PreparedRuntimeHost | null = null
    try {
      prepared = await this.prepareHost(config, new AgentMuxMemorySemanticStore())
      const identity = prepared.client.daemonIdentity()
      return {
        ok: true,
        detail: `agentmuxd ${identity.buildIdentity} · protocol ${identity.protocolVersion}`
      }
    } finally {
      if (prepared) await disposePrepared([prepared])
    }
  }

  async detect(agentId: AgentId, hostId: string, config: AppConfig): Promise<AgentDetection> {
    const agent = config.agents[agentId]
    const client = await this.connectedClient(hostId)
    return {
      agentId,
      hostId,
      installed: (await client.probeAgent(agentId, agent?.command)).installed
    }
  }

  async snapshot(config: AppConfig) {
    const snapshots = await Promise.all([...this.hosts.values()].map(async ({ client }) => {
      await client.connect()
      return await client.snapshot()
    }))
    return {
      sessions: snapshots.flatMap((snapshot) => snapshot.sessions.map((session) => projectSession(session, config))),
      activities: {}
    }
  }

  async launchAgent(request: AgentLaunchInput, config: AppConfig): Promise<SessionSnapshot> {
    const agent = config.agents[request.agentId]
    if (!agent) throw new Error(`Missing agent configuration: ${request.agentId}`)
    const client = await this.connectedClient(request.hostId)
    const semantic = await client.createAgent({
      agentId: request.agentId,
      workspacePath: request.workspacePath,
      args: agent.args,
      env: agent.env,
      commandOverride: agent.command,
      ...(request.semanticSessionId === undefined ? {} : { semanticSessionId: request.semanticSessionId }),
      ...(request.daemonSessionId === undefined ? {} : { daemonSessionId: request.daemonSessionId }),
      ...(request.createOperationId === undefined ? {} : { createOperationId: request.createOperationId }),
      ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
      ...(request.cols === undefined ? {} : { cols: request.cols }),
      ...(request.rows === undefined ? {} : { rows: request.rows })
    })
    return await this.sessionById(client, semantic.semanticSessionId, config)
  }

  async launchTerminal(request: TerminalLaunchInput, config: AppConfig): Promise<SessionSnapshot> {
    const client = await this.connectedClient(request.hostId)
    const sessionId = request.sessionId ?? randomUUID()
    await client.createTerminal({
      sessionId,
      createOperationId: request.createOperationId ?? randomUUID(),
      cwd: request.workspacePath,
      ...(request.cols === undefined ? {} : { cols: request.cols }),
      ...(request.rows === undefined ? {} : { rows: request.rows })
    })
    return await this.sessionById(client, sessionId, config)
  }

  async attachSession(
    control: SessionControl,
    afterSequence: number,
    config: AppConfig
  ): Promise<SessionAttachResult> {
    const client = await this.connectedClient(control.hostId)
    const attached = control.kind === 'agent'
      ? (await client.reattachAgent(control.semanticSessionId, afterSequence)).run
      : await client.attachTerminal(control.sessionId, afterSequence)
    const session = await this.sessionById(
      client,
      control.kind === 'agent' ? control.semanticSessionId : control.sessionId,
      config
    )
    return { session, replay: attached.replay, gap: attached.gap }
  }

  async detachSession(control: SessionControl): Promise<void> {
    const client = await this.connectedClient(control.hostId)
    if (control.kind === 'agent') await client.detachAgent(control.semanticSessionId)
    else await client.detachTerminal(control.daemonSession)
  }

  async write(control: SessionControl, data: string): Promise<void> {
    const client = await this.connectedClient(control.hostId)
    if (control.kind === 'agent') await client.writeAgent(control.semanticSessionId, data)
    else await client.writeTerminal(control.daemonSession, data)
  }

  async submitPrompt(
    control: Extract<SessionControl, { kind: 'agent' }>,
    prompt: string
  ): Promise<void> {
    await (await this.connectedClient(control.hostId)).submitAgentPrompt(
      control.semanticSessionId,
      prompt
    )
  }

  async acknowledge(control: SessionControl, sequence: number): Promise<void> {
    const client = await this.connectedClient(control.hostId)
    if (control.kind === 'agent') await client.acknowledgeAgentOutput(control.semanticSessionId, sequence)
    else await client.acknowledgeTerminalOutput(control.daemonSession, sequence)
  }

  async interrupt(control: SessionControl): Promise<void> {
    const client = await this.connectedClient(control.hostId)
    if (control.kind === 'agent') await client.signalAgent(control.semanticSessionId, 'SIGINT')
    else await client.signalTerminal(control.daemonSession, 'SIGINT')
  }

  async resize(control: SessionControl, cols: number, rows: number): Promise<void> {
    const client = await this.connectedClient(control.hostId)
    if (control.kind === 'agent') await client.resizeAgent(control.semanticSessionId, cols, rows)
    else await client.resizeTerminal(control.daemonSession, cols, rows)
  }

  async refresh(control: SessionControl, config: AppConfig): Promise<SessionSnapshot> {
    return await this.sessionById(
      await this.connectedClient(control.hostId),
      control.kind === 'agent' ? control.semanticSessionId : control.sessionId,
      config
    )
  }

  async stopSession(control: SessionControl): Promise<void> {
    const client = await this.connectedClient(control.hostId)
    if (control.kind === 'agent') await client.stopAgent(control.semanticSessionId)
    else await client.stopTerminal(control.daemonSession)
  }

  async dispose(): Promise<void> {
    const hosts = [...this.hosts.entries()]
    this.hosts.clear()
    this.clients.clear()
    this.hostSignatures.clear()
    for (const [, host] of hosts) host.unsubscribe()
    await disposePrepared(hosts.map(([id, host]) => ({ id, ...host })))
  }

  private async prepareHost(
    config: HostConfig,
    store: AgentMuxSemanticStore = this.semanticStore
  ): Promise<PreparedRuntimeHost> {
    const executionHost = createExecutionHost(config)
    let client: AgentMuxClient | null = null
    try {
      if (config.kind === 'local') {
        await activateAgentMuxLocalDaemon()
        client = new AgentMuxClient({ store })
      } else {
        client = new AgentMuxClient({
          store,
          connector: new SshAgentMuxDaemonConnector({
            target: {
              hostId: config.id,
              hostname: config.hostname,
              ...(config.user ? { user: config.user } : {}),
              ...(config.port ? { port: config.port } : {}),
              ...(config.identityFile ? { identityFile: config.identityFile } : {})
            },
            remoteNodePath: config.daemon.remoteNodePath,
            remoteAgentMuxdPath: config.daemon.remoteAgentMuxdPath,
            remoteSocketPath: config.daemon.remoteSocketPath,
            expectedBuildIdentity: config.daemon.buildIdentity
          })
        })
      }
      await client.connect()
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
    const host = this.hosts.get(hostId)
    if (!host) throw new Error(`Runtime host is not configured: ${hostId}`)
    await host.client.connect()
    return host.client
  }

  private async sessionById(
    client: AgentMuxClient,
    sessionId: string,
    config: AppConfig
  ): Promise<SessionSnapshot> {
    const session = (await client.snapshot()).sessions.find((candidate) => candidate.id === sessionId)
    if (!session) throw new Error(`Session is not available: ${sessionId}`)
    return projectSession(session, config)
  }

  private publish(hostId: string, event: AgentMuxClientEvent): void {
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
}
