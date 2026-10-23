import { createHash } from 'node:crypto'
import { mkdir, open, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { capsuleRuntimeEntrypoint, connectCapsuleRuntime } from '@agentmux/capsule/runtime'
import type { CapsuleCallContext, CapsuleMethod, CapsuleParamsMap, CapsulePresentationPort, CapsuleReplyPort, CapsuleResultMap } from '@agentmux/capsule'
import type { AgentMuxClient } from './client.js'
import type { AgentMuxRpcCallContext } from './public-rpc-service.js'
import type { AgentMuxRun } from './types.js'
import { AgentMuxError } from './errors.js'
import { durableWriteFile } from './durable-write.js'
import { mintObjectId } from './object-id.js'
import { defaultAgentMuxRuntimeDirectory } from './runtime-paths.js'
import { observeRead } from './observation-read.js'
import { parsePreparedTerminal, parsePreparedTerminalStop, type AgentMuxPreparedTerminal, type AgentMuxPreparedTerminalStop } from './terminal-preparation.js'
import { parseCapsuleRuntimeParams, type CapsuleRuntimeMethod, type CapsuleRuntimeObservation, type CapsuleRuntimeParamsMap, type CapsuleRuntimePort } from './capsule-runtime.js'

export type CapsuleDesktopAdapters = (context?: AgentMuxRpcCallContext) => { presentation?: CapsulePresentationPort; replies?: CapsuleReplyPort }
type Command = { kind: 'start' | 'stop'; params: CapsuleRuntimeParamsMap['capsule.runtime.start'] | CapsuleRuntimeParamsMap['capsule.runtime.stop'] }
type CommandRecord = { schema: 'agentmux.capsule-command.v1'; command: Command; phase: 'prepared' | 'committed' }
type Binding = {
  schema: 'agentmux.capsule-service.v1'; revision: number; desired: 'running' | 'stopped'
  stateDirectory: string; socketPath: string; runtimeId: string | null
  run: { runId: string } | null; launch: AgentMuxPreparedTerminal | null
  launchPhase: 'prepared' | 'dispatched' | 'confirmed' | null
  stop: AgentMuxPreparedTerminalStop | null; stopPhase: 'prepared' | 'dispatched' | 'confirmed' | null
  command: Command | null
}
const unavailable = (message: string, code = 'CAPSULE_RUNTIME_UNAVAILABLE') => new AgentMuxError(message, code)
// Native defines interrupted as historical ownership, distinct from observation loss.
const terminalRun = (run: AgentMuxRun | null): boolean => run === null || run.state === 'exited' || run.state === 'interrupted'
const launchKey = (launch: AgentMuxPreparedTerminal): string => `${launch.createOperationId}:${createHash('sha256').update(launch.launch).digest('hex')}`
/** One durable service intent using the existing Core/ctxmux Run lifecycle, never another supervisor. */
export class CapsuleRunManager {
  private readonly path: string
  private readonly commandsDirectory: string
  private queue: Promise<unknown> = Promise.resolve()
  private closed = false
  private readonly disconnected = new AbortController()
  private readonly nativePending = new Map<string, Promise<unknown>>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly connections = new Set<Awaited<ReturnType<typeof connectCapsuleRuntime>>>()
  readonly stateDirectory: string
  readonly socketPath: string
  readonly runtime: CapsuleRuntimePort = { call: (method, params) => this.serial(() => this.manage(method, params)) }

  constructor(private readonly client: AgentMuxClient, coreStateDirectory: string, private readonly adapters?: CapsuleDesktopAdapters) {
    this.stateDirectory = resolve(coreStateDirectory, 'capsules')
    this.path = join(coreStateDirectory, 'capsule-service.json')
    this.commandsDirectory = join(coreStateDirectory, 'capsule-service-operations')
    this.socketPath = join(defaultAgentMuxRuntimeDirectory(), `capsule-${createHash('sha256').update(this.stateDirectory).digest('hex').slice(0, 12)}.sock`)
  }
  /** Restore only an existing intent. An empty Core never eagerly starts a page service. */
  start(): void { this.schedule(0) }
  async dispose(): Promise<void> {
    this.closed = true; clearTimeout(this.timer)
    this.disconnected.abort(new Error('The Core manager disconnected. The service Run is retained.'))
    await this.queue
    await Promise.allSettled([...this.connections].map(connection => connection.dispose()))
    this.connections.clear()
    // No Stop, no unlink and no HTTP close: the original Run survives its manager.
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(() => { if (this.closed) throw unavailable('The Core manager is disconnected. The service Run is retained.'); return work() })
    this.queue = result.catch(() => {})
    return result
  }
  private schedule(delay = 2000): void {
    if (this.closed) return
    this.timer = setTimeout(() => { void this.serial(async () => {
      const binding = await this.load()
      if (binding) await this.converge(binding)
    }).catch(() => {}).finally(() => this.schedule()) }, delay)
    this.timer.unref()
  }
  private async load(): Promise<Binding | null> {
    let b: Binding
    try { b = JSON.parse(await readFile(this.path, 'utf8')) as Binding }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
    if (b.schema !== 'agentmux.capsule-service.v1' || !Number.isSafeInteger(b.revision) || b.revision < 1 ||
      !['running', 'stopped'].includes(b.desired) || !isAbsolute(b.stateDirectory) || !isAbsolute(b.socketPath) ||
      b.stateDirectory !== this.stateDirectory || b.socketPath !== this.socketPath ||
      b.runtimeId !== null && (typeof b.runtimeId !== 'string' || !b.runtimeId) ||
      ![null, 'prepared', 'dispatched', 'confirmed'].includes(b.launchPhase) ||
      ![null, 'prepared', 'dispatched', 'confirmed'].includes(b.stopPhase) ||
      (b.run !== null && (typeof b.run?.runId !== 'string' || !b.run.runId)))
      throw unavailable('The original service binding is invalid. Preserve its namespace and repair the original binding; no replacement was created.', 'CAPSULE_RUNTIME_BINDING_INVALID')
    if (b.launch) parsePreparedTerminal(b.launch)
    if (b.stop) parsePreparedTerminalStop(b.stop)
    if ((b.stop && b.stop.run.runId !== b.run?.runId) || (b.stop === null) !== (b.stopPhase === null) ||
      (b.launch === null) !== (b.launchPhase === null) || b.run !== null && b.launchPhase !== 'confirmed' ||
      b.launchPhase === 'confirmed' && b.run === null || b.desired === 'running' && b.stop !== null && b.stopPhase !== 'confirmed' ||
      b.command !== null && !['start', 'stop'].includes(b.command.kind))
      throw unavailable('The original service lifecycle identities or phases disagree. Preserve the binding and its Runs.', 'CAPSULE_RUNTIME_BINDING_INVALID')
    if (b.command) parseCapsuleRuntimeParams(`capsule.runtime.${b.command.kind}`, b.command.params)
    // A previous rename with an unacknowledged directory sync is not yet a durable
    // control fact. Reconfirm the exact original file and its directory before effects.
    await this.confirmDurable(this.path)
    return b
  }
  private async confirmDurable(path: string): Promise<void> {
    const file = await open(path, 'r')
    try { await file.sync() } finally { await file.close() }
    const directory = await open(resolve(path, '..'), 'r')
    try { await directory.sync() } finally { await directory.close() }
  }
  private async save(b: Binding): Promise<void> {
    await durableWriteFile(this.path, JSON.stringify(b) + '\n', { requireDirectorySync: true })
  }
  /** End this observer, never the admitted Native operation. Reuse its original pending wire. */
  private async native<T>(key: string, work: () => Promise<T>): Promise<T> {
    let operation = this.nativePending.get(key)
    if (!operation) {
      operation = Promise.resolve().then(work)
      this.nativePending.set(key, operation)
      const release = () => { if (this.nativePending.get(key) === operation) this.nativePending.delete(key) }
      void operation.then(release, release)
    }
    const signal = AbortSignal.any([this.disconnected.signal, AbortSignal.timeout(5000)])
    try { return await observeRead(operation as Promise<T>, signal) }
    catch (error) {
      if (signal.aborted) throw unavailable('The original Native observation ended without a confirmed receipt. Its operation and Run are retained; inspect without resending.', 'CAPSULE_RUNTIME_OBSERVATION_UNKNOWN')
      throw error
    }
  }
  private blank(): Binding {
    return { schema: 'agentmux.capsule-service.v1', revision: 1, desired: 'running', stateDirectory: this.stateDirectory,
      socketPath: this.socketPath, runtimeId: null, run: null, launch: null, launchPhase: null, stop: null, stopPhase: null, command: null }
  }
  private async originalRun(b: Binding): Promise<AgentMuxRun | null> {
    if (!b.run) return null
    if (!b.launch) throw unavailable('The original Run has no prepared launch binding.', 'CAPSULE_RUNTIME_BINDING_INVALID')
    return await this.native(`inspect:${b.run.runId}:${launchKey(b.launch)}`, () => this.client.inspectPreparedTerminal(b.launch!, b.run!))
  }
  private async connect(b: Binding, run: AgentMuxRun, context?: AgentMuxRpcCallContext) {
    const current = await this.load()
    if (!current || current.revision !== b.revision || current.desired !== 'running' || current.run?.runId !== run.runId)
      throw unavailable('The original service intent changed before connection. Inspect its current Run and intent.', 'CAPSULE_RUNTIME_INTENT_CHANGED')
    b = current
    const controller = new AbortController(), deadline = setTimeout(() => controller.abort(new Error('The original runtime handshake timed out.')), 5000)
    deadline.unref()
    let connection: Awaited<ReturnType<typeof connectCapsuleRuntime>> | undefined
    try {
      connection = await connectCapsuleRuntime({ socketPath: b.socketPath, ...(b.runtimeId ? { expectedRuntimeId: b.runtimeId } : {}),
        signal: AbortSignal.any([controller.signal, this.disconnected.signal]), ...(this.adapters ? { adapters: this.adapters(context) } : {}) })
      const identity = await connection.identity()
      if (identity.pid !== run.pid || identity.stateDirectory !== await realpath(b.stateDirectory) || (b.runtimeId && identity.runtimeId !== b.runtimeId))
        throw unavailable('The service identity does not match its original execution Host, namespace and Run.', 'CAPSULE_RUNTIME_IDENTITY_MISMATCH')
      if (!b.runtimeId) { b.runtimeId = identity.runtimeId; await this.save(b) }
      this.connections.add(connection)
      return { connection, identity }
    } catch (error) { await connection?.dispose(); throw error }
    finally { clearTimeout(deadline) }
  }
  private async release(connection: Awaited<ReturnType<typeof connectCapsuleRuntime>>) {
    this.connections.delete(connection); await connection.dispose()
  }
  /** Only authoritative terminal/removal facts allow a fresh service generation. */
  private async converge(b: Binding): Promise<{ binding: Binding; run: AgentMuxRun | null }> {
    await this.native('connect', () => this.client.connectRuntime())
    let run = await this.originalRun(b)
    if (b.run && terminalRun(run)) {
      if (b.desired === 'stopped') { if (b.stop && b.stopPhase !== 'confirmed') { b.stopPhase = 'confirmed'; await this.save(b) }; return { binding: b, run } }
      b.run = null; b.launch = null; b.launchPhase = null; b.stop = null; b.stopPhase = null
      await this.save(b)
    }
    if (b.desired === 'stopped') {
      if (!b.run && b.launchPhase === 'dispatched' && b.launch) {
        run = await this.native(`creation:${launchKey(b.launch)}`, () => this.client.inspectPreparedTerminal(b.launch!))
        if (run) { b.run = { runId: run.runId }; b.launchPhase = 'confirmed'; await this.save(b) }
      }
      if (!b.run) return { binding: b, run: null }
      if (!b.stop) {
        b.stop = await this.client.prepareTerminalStop(b.run); b.stopPhase = 'prepared'; await this.save(b)
      }
      if (b.stopPhase === 'prepared') {
        b.stopPhase = 'dispatched'; await this.save(b)
        await this.native(`stop:${b.stop.run.runId}:${b.stop.ownerInstanceId}:${b.stop.operationId}`, () => this.client.stopPreparedTerminal(b.stop!))
      }
      run = await this.originalRun(b)
      if (terminalRun(run)) { b.stopPhase = 'confirmed'; await this.save(b) }
      return { binding: b, run }
    }
    if (!b.run) {
      if (!b.launch) {
        await mkdir(b.stateDirectory, { recursive: true, mode: 0o700 })
        b.launch = this.client.prepareTerminal({ command: process.execPath,
          args: [capsuleRuntimeEntrypoint(), 'serve', '--state-directory', b.stateDirectory, '--socket', b.socketPath],
          workspacePath: b.stateDirectory, env: { ELECTRON_RUN_AS_NODE: '1' }, createOperationId: mintObjectId() })
        b.launchPhase = 'prepared'; await this.save(b)
      }
      if (b.launchPhase === 'prepared') {
        b.launchPhase = 'dispatched'; await this.save(b)
        run = await this.native(`start:${launchKey(b.launch)}`, () => this.client.createPreparedTerminal(b.launch!))
      } else run = await this.native(`creation:${launchKey(b.launch)}`, () => this.client.inspectPreparedTerminal(b.launch!))
      if (!run) throw unavailable('The original service creation is unconfirmed. Inspect the retained operation; do not resend Start.', 'CAPSULE_RUNTIME_CREATION_UNKNOWN')
      b.run = { runId: run.runId }; b.launchPhase = 'confirmed'; await this.save(b)
    }
    return { binding: b, run: run ?? await this.originalRun(b) }
  }
  private async observe(b: Binding | null, requested?: Command): Promise<CapsuleRuntimeObservation> {
    const base: CapsuleRuntimeObservation = { revision: b?.revision ?? 0, desired: b?.desired ?? 'unconfigured', phase: b ? 'unavailable' : 'unconfigured',
      stateDirectory: b?.stateDirectory ?? this.stateDirectory, socketPath: b?.socketPath ?? this.socketPath,
      run: b?.run ? { hostId: 'local', ...b.run } : null, runtime: null, operation: null, issue: null }
    if (!b) return base
    const command = requested ?? b.command
    if (command) base.operation = { operationId: command.params.operationId, kind: command.kind,
      phase: b.command?.params.operationId === command.params.operationId ? 'pending' : 'superseded' }
    try {
      const { run } = await this.converge(b)
      base.run = b.run ? { hostId: 'local', ...b.run } : null
      if (b.desired === 'stopped') {
        const confirmed = b.stopPhase === 'confirmed' || (!b.run && b.launchPhase !== 'dispatched') || !!b.run && terminalRun(run)
        base.phase = confirmed ? 'stopped' : 'unknown'
        if (!confirmed) throw unavailable('The original Stop is unconfirmed. The stopped intent is durable; observe the same Run without resending Stop.', 'CAPSULE_RUNTIME_STOP_UNKNOWN')
      } else {
        if (!run || run.state !== 'running') throw unavailable('The original service Run is not currently running. Its retained intent will be observed again.')
        const { connection, identity } = await this.connect(b, run)
        try { base.runtime = { runtimeId: identity.runtimeId, ownerInstanceId: identity.ownerInstanceId, pid: identity.pid }; base.phase = 'running' }
        finally { await this.release(connection) }
      }
      if (base.operation && base.operation.phase !== 'superseded') base.operation.phase = 'confirmed'
    } catch (error) {
      const code = error instanceof AgentMuxError ? error.code : 'CAPSULE_RUNTIME_UNAVAILABLE'
      base.phase = code.includes('UNKNOWN') ? 'unknown' : 'unavailable'
      base.run = b.run ? { hostId: 'local', ...b.run } : null
      base.issue = { code, message: error instanceof Error ? error.message : String(error), recovery: 'Inspect this original service binding again. Retain the namespace, Run and operation; healthy Agents remain available.' }
      if (base.operation && base.operation.phase !== 'superseded') base.operation.phase = base.phase === 'unknown' ? 'unknown' : 'pending'
    }
    return base
  }
  private async manage<M extends CapsuleRuntimeMethod>(method: M, value: CapsuleRuntimeParamsMap[M]): Promise<CapsuleRuntimeObservation> {
    const params = parseCapsuleRuntimeParams(method, value)
    let b = await this.load()
    if (method === 'capsule.runtime.inspect') return await this.observe(b)
    const command: Command = { kind: method === 'capsule.runtime.start' ? 'start' : 'stop', params: params as Command['params'] }
    await mkdir(this.commandsDirectory, { recursive: true, mode: 0o700 })
    const path = join(this.commandsDirectory, `${command.params.operationId}.json`)
    try {
      const retained = JSON.parse(await readFile(path, 'utf8')) as CommandRecord
      if (retained.schema !== 'agentmux.capsule-command.v1' || !['prepared', 'committed'].includes(retained.phase) ||
        !isDeepStrictEqual(retained.command, command)) throw unavailable('This operation ID already belongs to a different service command or invalid record.', 'CAPSULE_RUNTIME_OPERATION_CONFLICT')
      await this.confirmDurable(path)
      const observation = await this.observe(b, command)
      if (retained.phase === 'prepared' && b?.command?.params.operationId !== command.params.operationId) {
        observation.operation = { kind: command.kind, operationId: command.params.operationId, phase: 'unknown' }
        observation.issue = { code: 'CAPSULE_RUNTIME_INTENT_UNKNOWN', message: 'The original command was reserved but its intent commitment is unconfirmed.',
          recovery: 'Retain this operation. Inspect the current revision and original binding before deciding a new explicit management intent.' }
      }
      return observation
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (command.params.expectedRevision !== (b?.revision ?? 0)) throw unavailable('The service intent revision changed. Inspect the original binding before a new command.', 'CAPSULE_RUNTIME_REVISION_CONFLICT')
    if (command.kind === 'stop' && !isDeepStrictEqual((command.params as CapsuleRuntimeParamsMap['capsule.runtime.stop']).expectedRun, b?.run ?? null))
      throw unavailable('The observed service Run changed. The new Run was preserved.', 'CAPSULE_RUNTIME_RUN_CONFLICT')
    if (command.kind === 'start' && b?.desired === 'stopped' && (b.run && b.stopPhase !== 'confirmed' || b.launchPhase === 'dispatched')) {
      await this.native('connect', () => this.client.connectRuntime())
      const original = await this.originalRun(b)
      if (b.launchPhase === 'dispatched' || !terminalRun(original))
        throw unavailable('The original Stop is still unconfirmed. Keep its Run fence before starting another generation.', 'CAPSULE_RUNTIME_STOP_UNKNOWN')
    }
    const record: CommandRecord = { schema: 'agentmux.capsule-command.v1', command, phase: 'prepared' }
    await durableWriteFile(path, JSON.stringify(record) + '\n', { requireDirectorySync: true })
    if (!b) b = this.blank()
    else b.revision++
    b.desired = command.kind === 'start' ? 'running' : 'stopped'; b.command = command
    if (command.kind === 'start' && b.stopPhase === 'confirmed') { b.run = null; b.launch = null; b.launchPhase = null; b.stop = null; b.stopPhase = null }
    await this.save(b)
    record.phase = 'committed'
    await durableWriteFile(path, JSON.stringify(record) + '\n', { requireDirectorySync: true })
    return await this.observe(b)
  }
  async call<M extends CapsuleMethod>(method: M, params: CapsuleParamsMap[M], context?: CapsuleCallContext, originalContext?: AgentMuxRpcCallContext): Promise<CapsuleResultMap[M]> {
    // Reserve/observe management serially, but never hold its lock over a page callback.
    const ready = await this.serial(async () => {
      let b = await this.load()
      if (!b) { b = this.blank(); await this.save(b) }
      if (b.desired === 'stopped') throw unavailable('The Capsule service was explicitly stopped. Its pages and configuration are retained; start it explicitly to serve them.', 'CAPSULE_RUNTIME_STOPPED')
      const result = await this.converge(b)
      if (!result.run || result.run.state !== 'running') throw unavailable('The original Capsule service is not running yet. Inspect its retained Run.')
      return { binding: b, run: result.run }
    })
    let last: unknown
    // Native readiness is distinct from the application socket. Observation never restarts a live Run.
    for (let attempt = 0; attempt < 50 && !this.closed; attempt++) {
      context?.signal?.throwIfAborted()
      let connected: Awaited<ReturnType<CapsuleRunManager['connect']>>
      try { connected = await this.serial(() => this.connect(ready.binding, ready.run, originalContext)) }
      catch (error) {
        // Only a connection failure before dispatch may be observed again. A domain call is never replayed.
        last = error
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'ENOENT' && code !== 'ECONNREFUSED') throw error
        await new Promise(resolveWait => setTimeout(resolveWait, 100))
        continue
      }
      try { return await connected.connection.call(method, params, context) }
      finally { await this.release(connected.connection) }
    }
    throw unavailable(`The service Run is retained but its application endpoint is unavailable: ${last instanceof Error ? last.message : 'connection not confirmed'}`)
  }
}
