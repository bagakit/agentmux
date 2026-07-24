import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { AgentProviderRegistry, type AgentProvider } from './agent-provider.js'
import { AgentMuxError } from './errors.js'
import {
  ExecutionHostRegistry,
  LocalExecutionHost,
  type ExecutionHost
} from './execution-host.js'
import { AgentHookServer } from './hook-server.js'
import { AGENTMUX_TMUX_PREFIX, TmuxClient, type TmuxPaneInfo } from './tmux-client.js'
import type {
  AgentActivity,
  AgentStatus,
  NormalizedHookEvent,
  RuntimeEvent,
  RuntimeSnapshot,
  SessionLaunchRequest,
  SessionSnapshot
} from './types.js'

const MAX_ACTIVITIES_PER_SESSION = 300

export type AgentMuxRuntimeOptions = {
  hosts?: readonly ExecutionHost[]
  providers?: readonly AgentProvider[]
  pollIntervalMs?: number
}

function safeSessionId(value: string): string {
  const normalized = value.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(normalized)) {
    throw new AgentMuxError('Session id must contain only letters, numbers, underscore, or dash.', 'INVALID_SESSION_ID')
  }
  return normalized
}

function cloneSession(session: SessionSnapshot): SessionSnapshot {
  return { ...session, status: { ...session.status } }
}

function metadataEnvironment(args: {
  sessionId: string
  kind: SessionSnapshot['kind']
  agentId?: string
  hostId: string
  workspacePath: string
  label: string
}): Record<string, string> {
  return {
    AGENTMUX_SESSION_ID: args.sessionId,
    AGENTMUX_SESSION_KIND: args.kind,
    ...(args.agentId ? { AGENTMUX_AGENT_ID: args.agentId } : {}),
    AGENTMUX_HOST_ID: args.hostId,
    AGENTMUX_WORKSPACE_PATH: args.workspacePath,
    AGENTMUX_SESSION_LABEL: args.label
  }
}

export class AgentMuxRuntime {
  readonly hosts: ExecutionHostRegistry
  readonly providers: AgentProviderRegistry
  private readonly events = new EventEmitter()
  private readonly sessions = new Map<string, SessionSnapshot>()
  private readonly activities = new Map<string, AgentActivity[]>()
  private readonly watchers = new Map<string, NodeJS.Timeout>()
  private readonly inputTails = new Map<string, Promise<void>>()
  private readonly hookServer: AgentHookServer
  private readonly pollIntervalMs: number
  private started = false

  constructor(options: AgentMuxRuntimeOptions = {}) {
    this.hosts = new ExecutionHostRegistry(options.hosts ?? [new LocalExecutionHost()])
    this.providers = new AgentProviderRegistry(options.providers)
    this.pollIntervalMs = Math.max(250, options.pollIntervalMs ?? 750)
    this.hookServer = new AgentHookServer((event) => this.acceptHookEvent(event))
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    await this.hookServer.start()
    for (const host of this.hosts.list()) await this.discover(host.id)
  }

  async dispose(): Promise<void> {
    this.started = false
    for (const watcher of this.watchers.values()) clearInterval(watcher)
    this.watchers.clear()
    this.inputTails.clear()
    await this.hosts.dispose()
    await this.hookServer.stop()
    this.events.removeAllListeners()
  }

  onEvent(listener: (event: RuntimeEvent) => void): () => void {
    this.events.on('event', listener)
    return () => this.events.off('event', listener)
  }

  snapshot(): RuntimeSnapshot {
    return {
      sessions: [...this.sessions.values()].map(cloneSession),
      activities: Object.fromEntries(
        [...this.activities].map(([sessionId, items]) => [sessionId, items.map((item) => ({ ...item }))])
      )
    }
  }

  async detect(agentId: string, hostId = 'local', commandOverride?: string): Promise<boolean> {
    return await this.providers.get(agentId).detect(this.hosts.get(hostId), commandOverride)
  }

  async launch(request: SessionLaunchRequest): Promise<SessionSnapshot> {
    await this.start()
    const host = this.hosts.get(request.hostId ?? 'local')
    const client = new TmuxClient(host)
    await client.assertAvailable()
    const id = safeSessionId(request.sessionId ?? randomUUID())
    if (this.sessions.has(id)) throw new AgentMuxError(`Session already exists: ${id}`, 'DUPLICATE_SESSION')
    const tmuxSession = `${AGENTMUX_TMUX_PREFIX}${id}`
    const workspaceName = request.workspacePath.split(/[\\/]/).pop() || request.workspacePath
    let launch: { command?: string; args?: readonly string[]; env: Record<string, string>; agentId: string | null; label: string }
    if (request.kind === 'agent') {
      const provider = this.providers.get(request.agentId)
      if (!(await provider.detect(host, request.commandOverride))) {
        throw new AgentMuxError(`${provider.label} is not installed on ${host.label}.`, 'AGENT_NOT_FOUND')
      }
      const plan = provider.buildLaunch({
        workspacePath: request.workspacePath,
        prompt: request.prompt ?? '',
        args: request.args ?? [],
        env: request.env ?? {},
        ...(request.commandOverride !== undefined ? { commandOverride: request.commandOverride } : {})
      })
      const endpoint = this.hookServer.getEndpoint()
      if (!endpoint) throw new AgentMuxError('Hook server is not running.', 'HOOK_SERVER_NOT_RUNNING')
      const hookPort = await host.exposeLoopbackPort(endpoint.port)
      const label = request.label?.trim() || `${provider.label} · ${workspaceName}`
      launch = {
        command: plan.command,
        args: plan.args,
        agentId: provider.id,
        label,
        env: {
          ...plan.env,
          ...metadataEnvironment({ sessionId: id, kind: 'agent', agentId: provider.id, hostId: host.id, workspacePath: request.workspacePath, label }),
          AGENTMUX_HOOK_URL: `http://127.0.0.1:${hookPort}/v1/events`,
          AGENTMUX_HOOK_TOKEN: endpoint.token
        }
      }
    } else {
      const label = request.label?.trim() || `Terminal · ${workspaceName}`
      launch = {
        agentId: null,
        label,
        env: metadataEnvironment({ sessionId: id, kind: 'terminal', hostId: host.id, workspacePath: request.workspacePath, label })
      }
    }
    const now = Date.now()
    const sessionBase = {
      id,
      tmuxSession,
      hostId: host.id,
      workspacePath: request.workspacePath,
      label: launch.label,
      createdAt: now,
      updatedAt: now,
      processState: 'starting' as const,
      status: { state: 'starting' as const, source: 'tmux' as const, observedAt: now },
      terminalSnapshot: ''
    }
    const session: SessionSnapshot = request.kind === 'agent'
      ? { ...sessionBase, kind: 'agent', agentId: launch.agentId! }
      : { ...sessionBase, kind: 'terminal', agentId: null }
    this.sessions.set(id, session)
    this.emit({ type: 'session', session: cloneSession(session) })
    try {
      await client.start({
        sessionName: tmuxSession,
        cwd: request.workspacePath,
        ...(launch.command === undefined ? {} : { command: launch.command, args: launch.args ?? [] }),
        env: launch.env,
        ...(request.cols !== undefined ? { cols: request.cols } : {}),
        ...(request.rows !== undefined ? { rows: request.rows } : {})
      })
    } catch (error) {
      this.setStatus(session, {
        state: 'error',
        source: 'tmux',
        observedAt: Date.now(),
        detail: error instanceof Error ? error.message : String(error)
      })
      this.forgetSession(id)
      throw error
    }
    if (request.kind === 'agent' && request.prompt?.trim()) {
      this.addActivity({
        id: randomUUID(),
        sessionId: id,
        kind: 'prompt',
        source: 'user',
        createdAt: now,
        title: 'Initial prompt',
        content: request.prompt.trim()
      })
    }
    this.watch(id)
    await this.poll(id)
    return cloneSession(session)
  }

  async discover(hostId: string): Promise<SessionSnapshot[]> {
    const host = this.hosts.get(hostId)
    const client = new TmuxClient(host)
    try {
      await client.assertAvailable()
    } catch {
      return []
    }
    const discovered: SessionSnapshot[] = []
    for (const tmuxSession of await client.list()) {
      if (!tmuxSession.name.startsWith(AGENTMUX_TMUX_PREFIX)) continue
      const id = tmuxSession.name.slice(AGENTMUX_TMUX_PREFIX.length)
      const existing = this.sessions.get(id)
      if (existing) {
        discovered.push(cloneSession(existing))
        continue
      }
      const env = await client.showEnvironment(tmuxSession.name)
      const kind = env.AGENTMUX_SESSION_KIND
      const agentId = env.AGENTMUX_AGENT_ID
      const workspacePath = env.AGENTMUX_WORKSPACE_PATH
      if ((kind !== 'agent' && kind !== 'terminal') || !workspacePath || (kind === 'agent' && !agentId)) continue
      const createdAt = (tmuxSession.createdAt ?? Math.floor(Date.now() / 1000)) * 1_000
      const recoveredBase = {
        id,
        tmuxSession: tmuxSession.name,
        hostId,
        workspacePath,
        label: env.AGENTMUX_SESSION_LABEL || `${kind === 'agent' ? agentId : 'Terminal'} · recovered`,
        createdAt,
        updatedAt: Date.now(),
        processState: 'unknown' as const,
        status: { state: 'running' as const, source: 'tmux' as const, observedAt: Date.now(), detail: 'Recovered from tmux' },
        terminalSnapshot: ''
      }
      const session: SessionSnapshot = kind === 'agent'
        ? { ...recoveredBase, kind: 'agent', agentId: agentId! }
        : { ...recoveredBase, kind: 'terminal', agentId: null }
      this.sessions.set(id, session)
      await this.poll(id, false)
      this.watch(id)
      this.emit({ type: 'session', session: cloneSession(session) })
      discovered.push(cloneSession(session))
    }
    return discovered
  }

  async send(sessionId: string, text: string, submit = true): Promise<void> {
    const session = this.requireSession(sessionId)
    const previous = this.inputTails.get(sessionId) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(async () => {
      if (this.sessions.get(sessionId) !== session) {
        throw new AgentMuxError(`Unknown session: ${sessionId}`, 'UNKNOWN_SESSION')
      }
      await new TmuxClient(this.hosts.get(session.hostId)).sendText(session.tmuxSession, text, submit)
      if (session.kind === 'agent' && submit && text.trim()) {
        this.addActivity({
          id: randomUUID(),
          sessionId,
          kind: 'prompt',
          source: 'user',
          createdAt: Date.now(),
          title: 'Prompt',
          content: text.trim()
        })
      }
    })
    this.inputTails.set(sessionId, current)
    try {
      await current
    } finally {
      if (this.inputTails.get(sessionId) === current) this.inputTails.delete(sessionId)
    }
  }

  async interrupt(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId)
    await new TmuxClient(this.hosts.get(session.hostId)).interrupt(session.tmuxSession)
    this.addActivity({
      id: randomUUID(),
      sessionId,
      kind: 'lifecycle',
      source: 'user',
      createdAt: Date.now(),
      title: 'Interrupt sent'
    })
  }

  async resize(sessionId: string, cols: number, rows: number): Promise<void> {
    const session = this.requireSession(sessionId)
    await new TmuxClient(this.hosts.get(session.hostId)).resize(session.tmuxSession, cols, rows)
  }

  async refresh(sessionId: string): Promise<SessionSnapshot> {
    this.requireSession(sessionId)
    await this.poll(sessionId)
    return cloneSession(this.requireSession(sessionId))
  }

  async stopSession(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId)
    await new TmuxClient(this.hosts.get(session.hostId)).stop(session.tmuxSession)
    this.forgetSession(sessionId)
  }

  private forgetSession(sessionId: string): void {
    const watcher = this.watchers.get(sessionId)
    if (watcher) clearInterval(watcher)
    this.watchers.delete(sessionId)
    this.inputTails.delete(sessionId)
    this.sessions.delete(sessionId)
    this.activities.delete(sessionId)
    this.emit({ type: 'removed', sessionId })
  }

  async capture(sessionId: string): Promise<string> {
    const session = this.requireSession(sessionId)
    return await new TmuxClient(this.hosts.get(session.hostId)).capture(session.tmuxSession)
  }

  private requireSession(sessionId: string): SessionSnapshot {
    const session = this.sessions.get(sessionId)
    if (!session) throw new AgentMuxError(`Unknown session: ${sessionId}`, 'UNKNOWN_SESSION')
    return session
  }

  private watch(sessionId: string): void {
    if (this.watchers.has(sessionId)) return
    const timer = setInterval(() => void this.poll(sessionId), this.pollIntervalMs)
    timer.unref()
    this.watchers.set(sessionId, timer)
  }

  private async poll(sessionId: string, emitEvents = true): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    const client = new TmuxClient(this.hosts.get(session.hostId))
    let pane: TmuxPaneInfo | null
    try {
      pane = await client.inspect(session.tmuxSession)
    } catch (error) {
      session.processState = 'unknown'
      this.setStatus(session, {
        state: 'disconnected',
        source: 'tmux',
        observedAt: Date.now(),
        detail: error instanceof Error ? error.message : 'Connection unavailable'
      }, emitEvents)
      return
    }
    if (!pane) {
      session.processState = 'unknown'
      this.setStatus(session, {
        state: 'error',
        source: 'tmux',
        observedAt: Date.now(),
        detail: 'tmux session is unavailable'
      }, emitEvents)
      return
    }
    if (pane.pid !== undefined) session.panePid = pane.pid
    else delete session.panePid
    if (pane.command !== undefined) session.paneCommand = pane.command
    else delete session.paneCommand
    session.updatedAt = Date.now()
    if (pane.dead) {
      session.processState = 'exited'
      this.setStatus(session, {
        state: 'exited',
        source: 'tmux',
        observedAt: Date.now(),
        ...(pane.exitCode !== undefined ? { exitCode: pane.exitCode } : {}),
        detail: pane.exitCode === 0 ? 'Process exited' : `Process exited with code ${pane.exitCode ?? 'unknown'}`
      }, emitEvents)
    } else {
      session.processState = 'running'
      if (session.status.state === 'starting' || session.status.source === 'tmux') {
        this.setStatus(session, {
          state: 'running',
          source: 'tmux',
          observedAt: Date.now(),
          ...(pane.command ? { detail: pane.command } : {})
        }, emitEvents)
      }
    }
    try {
      const captured = await client.capture(session.tmuxSession)
      if (captured !== session.terminalSnapshot) {
        session.terminalSnapshot = captured
        session.updatedAt = Date.now()
        if (emitEvents) {
          this.emit({ type: 'terminal', sessionId, snapshot: captured, observedAt: session.updatedAt })
        }
      }
    } catch (error) {
      if (client.host.kind === 'ssh') {
        session.processState = 'unknown'
        this.setStatus(session, {
          state: 'disconnected',
          source: 'tmux',
          observedAt: Date.now(),
          detail: error instanceof Error ? error.message : 'Connection unavailable'
        }, emitEvents)
      }
      // The pane can disappear between inspect and capture; next poll reconciles it.
    }
  }

  private acceptHookEvent(event: NormalizedHookEvent): void {
    const session = this.sessions.get(event.sessionId)
    if (!session || session.kind !== 'agent' || session.agentId !== event.agentId) return
    this.setStatus(session, event.status)
    for (const activity of event.activities) this.addActivity(activity)
  }

  private setStatus(session: SessionSnapshot, status: AgentStatus, emitEvents = true): void {
    const same =
      session.status.state === status.state &&
      session.status.source === status.source &&
      session.status.detail === status.detail &&
      session.status.exitCode === status.exitCode
    if (same) return
    session.status = status
    session.updatedAt = status.observedAt
    if (!emitEvents) return
    this.emit({ type: 'status', sessionId: session.id, status: { ...status } })
    this.emit({ type: 'session', session: cloneSession(session) })
  }

  private addActivity(activity: AgentActivity): void {
    const items = this.activities.get(activity.sessionId) ?? []
    items.push(activity)
    if (items.length > MAX_ACTIVITIES_PER_SESSION) items.splice(0, items.length - MAX_ACTIVITIES_PER_SESSION)
    this.activities.set(activity.sessionId, items)
    this.emit({ type: 'activity', sessionId: activity.sessionId, activity: { ...activity } })
  }

  private emit(event: RuntimeEvent): void {
    this.events.emit('event', event)
  }
}
