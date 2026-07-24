import { randomUUID } from 'node:crypto'
import {
  AgentMuxMemoryAgentSessionStore,
  connectLocalAgentMux,
  connectSshAgentMux,
  type AgentId,
  type AgentMuxClient,
  type AgentMuxClientEvent,
  type AgentMuxAgentSessionStore,
  type AgentMuxView,
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

function terminalInputKey(hostId: string, runId: string): string {
  return JSON.stringify([hostId, runId])
}

function projectSession(view: AgentMuxView, config: AppConfig): SessionSnapshot {
  const run = view.run
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
  if (view.kind === 'agent') {
    return {
      id: view.agentSession.agentSessionId,
      kind: 'agent',
      agentId: view.agentId,
      hostId: view.hostId,
      workspacePath: view.workspacePath,
      label: `${view.agentId} · ${workspaceLabel(config, view.hostId, view.workspacePath)}`,
      createdAt: view.agentSession.createdAt,
      updatedAt: Math.max(view.agentSession.updatedAt, observedAt),
      processState: run.state,
      status,
      latestOutputBytes: run.latestOutputBytes,
      control: {
        kind: 'agent',
        hostId: view.hostId,
        agentSessionId: view.agentSession.agentSessionId,
        run: { ...view.agentSession.run }
      }
    }
  }
  return {
    id: run.runId,
    kind: 'terminal',
    agentId: null,
    hostId: view.hostId,
    workspacePath: view.workspacePath,
    label: `Terminal · ${workspaceLabel(config, view.hostId, view.workspacePath)}`,
    createdAt: run.observedAt,
    updatedAt: observedAt,
    processState: run.state,
    status,
    latestOutputBytes: run.latestOutputBytes,
    control: {
      kind: 'terminal',
      hostId: view.hostId,
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
  private readonly terminalInputCursors = new Map<string, number>()
  private readonly terminalInputTails = new Map<string, Promise<void>>()
  private hostSignatures = new Map<string, string>()

  constructor(private readonly agentSessionStore: AgentMuxAgentSessionStore) {}

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
    const workspaceViews = await Promise.all([...this.hosts.values()].map(async ({ client }) => {
      await client.connect()
      return await client.workspaceView()
    }))
    for (const workspaceView of workspaceViews) {
      for (const view of workspaceView.views) {
        if (view.kind !== 'terminal') continue
        this.terminalInputCursors.set(
          terminalInputKey(view.hostId, view.run.runId),
          view.run.acceptedInputBytes
        )
      }
    }
    return {
      sessions: workspaceViews.flatMap((workspaceView) => workspaceView.views.map((view) => projectSession(view, config))),
      activities: {}
    }
  }

  async launchAgent(request: AgentLaunchInput, config: AppConfig): Promise<SessionSnapshot> {
    const agent = config.agents[request.agentId]
    if (!agent) throw new Error(`Missing agent configuration: ${request.agentId}`)
    const client = await this.connectedClient(request.hostId)
    const agentSession = await client.createAgent({
      agentId: request.agentId,
      workspacePath: request.workspacePath,
      args: agent.args,
      env: agent.env,
      commandOverride: agent.command,
      ...(request.agentSessionId === undefined ? {} : { agentSessionId: request.agentSessionId }),
      ...(request.createOperationId === undefined ? {} : { createOperationId: request.createOperationId }),
      ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
      ...(request.cols === undefined ? {} : { cols: request.cols }),
      ...(request.rows === undefined ? {} : { rows: request.rows })
    })
    return await this.sessionById(client, agentSession.agentSessionId, config)
  }

  async launchTerminal(request: TerminalLaunchInput, config: AppConfig): Promise<SessionSnapshot> {
    const client = await this.connectedClient(request.hostId)
    const run = await client.createTerminal({
      createOperationId: request.createOperationId ?? randomUUID(),
      workspacePath: request.workspacePath,
      ...(request.cols === undefined ? {} : { cols: request.cols }),
      ...(request.rows === undefined ? {} : { rows: request.rows })
    })
    this.terminalInputCursors.set(
      terminalInputKey(request.hostId, run.runId),
      run.acceptedInputBytes
    )
    return await this.sessionById(client, run.runId, config)
  }

  async attachSession(
    control: SessionControl,
    afterByte: number,
    config: AppConfig
  ): Promise<SessionAttachResult> {
    const client = await this.connectedClient(control.hostId)
    const attached = control.kind === 'agent'
      ? (await client.reattachAgent(control.agentSessionId, afterByte)).attachment
      : await client.attachTerminal(control.runId, afterByte)
    if (control.kind === 'terminal') {
      this.terminalInputCursors.set(
        terminalInputKey(control.hostId, control.runId),
        attached.run.acceptedInputBytes
      )
    }
    const session = await this.sessionById(
      client,
      control.kind === 'agent' ? control.agentSessionId : control.runId,
      config
    )
    return { session, replay: attached.replay, gap: attached.gap }
  }

  async detachSession(control: SessionControl): Promise<void> {
    const client = await this.connectedClient(control.hostId)
    if (control.kind === 'agent') await client.releaseAgentAttachment(control.agentSessionId)
    else await client.releaseTerminalAttachment(control.run)
  }

  async write(control: SessionControl, data: string): Promise<void> {
    const client = await this.connectedClient(control.hostId)
    if (control.kind === 'agent') await client.writeAgent(control.agentSessionId, data)
    else await this.writeTerminalInput(client, control, data)
  }

  async submitPrompt(
    control: Extract<SessionControl, { kind: 'agent' }>,
    prompt: string,
    config: AppConfig
  ): Promise<void> {
    const client = await this.connectedClient(control.hostId)
    const status = await client.statusAgent(control.agentSessionId)
    if (status.run.state === 'running') {
      await client.submitAgentPrompt({
        agentSessionId: control.agentSessionId,
        operationId: randomUUID(),
        prompt
      })
      return
    }
    const agent = config.agents[status.session.agentId]
    if (!agent) throw new Error(`Missing agent configuration: ${status.session.agentId}`)
    await client.resumeAgent({
      agentSessionId: control.agentSessionId,
      operationId: randomUUID(),
      prompt,
      args: agent.args,
      env: agent.env,
      commandOverride: agent.command
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

  async resize(control: SessionControl, cols: number, rows: number): Promise<void> {
    const client = await this.connectedClient(control.hostId)
    if (control.kind === 'agent') await client.resizeAgent(control.agentSessionId, cols, rows)
    else await client.resizeTerminal(control.run, cols, rows)
  }

  async refresh(control: SessionControl, config: AppConfig): Promise<SessionSnapshot> {
    return await this.sessionById(
      await this.connectedClient(control.hostId),
      control.kind === 'agent' ? control.agentSessionId : control.runId,
      config
    )
  }

  async stopSession(control: SessionControl): Promise<void> {
    const client = await this.connectedClient(control.hostId)
    if (control.kind === 'agent') await client.stopAgent(control.agentSessionId)
    else {
      await client.stopTerminal(control.run)
      const key = terminalInputKey(control.hostId, control.runId)
      this.terminalInputCursors.delete(key)
      this.terminalInputTails.delete(key)
    }
  }

  async dispose(): Promise<void> {
    const hosts = [...this.hosts.entries()]
    this.hosts.clear()
    this.clients.clear()
    this.hostSignatures.clear()
    this.terminalInputCursors.clear()
    this.terminalInputTails.clear()
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
    const host = this.hosts.get(hostId)
    if (!host) throw new Error(`Runtime host is not configured: ${hostId}`)
    await host.client.connect()
    return host.client
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
    const view = (await client.workspaceView()).views.find((candidate) => (
      candidate.kind === 'agent'
        ? candidate.agentSession.agentSessionId === subjectId
        : candidate.run.runId === subjectId
    ))
    if (!view) throw new Error(`Runtime subject is not available: ${subjectId}`)
    return projectSession(view, config)
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
