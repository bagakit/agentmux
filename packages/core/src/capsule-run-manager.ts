import { createHash } from 'node:crypto'
import { mkdir, open, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { capsuleRuntimeEntrypoint, connectCapsuleRuntime } from '@agentmux/capsule/runtime'
import type { CapsuleCallContext, CapsuleMethod, CapsuleParamsMap, CapsulePresentationPort, CapsuleReplyPort, CapsuleResultMap } from '@agentmux/capsule'
import type { AgentMuxClient } from './client.js'
import type { AgentMuxRpcCallContext } from './public-rpc-service.js'
import type { AgentMuxRun } from './types.js'
import { AgentMuxError, parseAgentMuxErrorData, type AgentMuxErrorData } from './errors.js'
import { DurableWriteError, durableWriteFile } from './durable-write.js'
import { mintObjectId } from './object-id.js'
import { defaultAgentMuxRuntimeDirectory } from './runtime-paths.js'
import { observeRead } from './observation-read.js'
import { parsePreparedTerminal, parsePreparedTerminalStop, type AgentMuxPreparedTerminal, type AgentMuxPreparedTerminalStop } from './terminal-preparation.js'
import { parseCapsuleRuntimeParams, parseCapsuleRuntimeResult, type CapsuleRuntimeMethod, type CapsuleRuntimeObservation, type CapsuleRuntimeOperation, type CapsuleRuntimeParamsMap, type CapsuleRuntimePort } from './capsule-runtime.js'

export type CapsuleDesktopAdapters = (context?: AgentMuxRpcCallContext) => { presentation?: CapsulePresentationPort; replies?: CapsuleReplyPort }
type Command = { kind: 'start' | 'stop'; params: CapsuleRuntimeParamsMap['capsule.runtime.start'] | CapsuleRuntimeParamsMap['capsule.runtime.stop'] }
type NativeReceipt = { key: string; launchKey: string; operationId: string; runId?: string; ownerInstanceId?: string; outcome?: Outcome }
type CommandRecord = { schema: 'agentmux.capsule-command.v1'; command: Command; phase: 'prepared' | 'committed'; receipt?: CapsuleRuntimeOperation; native?: NativeReceipt; latestNative?: NativeReceipt }
type Outcome = { disposition: 'applied' | 'not_applied' | 'unknown'; failure?: AgentMuxErrorData }
type Effect = {
  kind: 'start' | 'stop'; key: string; operationId: string; commandId: string | null
  launch: AgentMuxPreparedTerminal; stop?: AgentMuxPreparedTerminalStop
  invoked: boolean; outcome?: Outcome; run?: AgentMuxRun; durable: boolean
}
type Binding = {
  schema: 'agentmux.capsule-service.v1'; revision: number; desired: 'running' | 'stopped'
  stateDirectory: string; socketPath: string; runtimeId: string | null
  run: { runId: string } | null; launch: AgentMuxPreparedTerminal | null
  launchPhase: 'prepared' | 'dispatched' | 'confirmed' | 'not_applied' | null
  launchOutcome?: Outcome; launchCommandId?: string | null
  stop: AgentMuxPreparedTerminalStop | null; stopPhase: 'prepared' | 'dispatched' | 'confirmed' | 'not_applied' | null
  stopOutcome?: Outcome; stopCommandId?: string | null
  command: Command | null
}
const unavailable = (message: string, code = 'CAPSULE_RUNTIME_UNAVAILABLE') => new AgentMuxError(message, code)
// Native defines interrupted as historical ownership, distinct from observation loss.
const terminalRun = (run: AgentMuxRun | null): boolean => run === null || run.state === 'exited' || run.state === 'interrupted'
const serviceReads = new Set<CapsuleMethod>(['capsule.ls', 'capsule.inspect', 'capsule.resolve', 'capsule.operation.inspect',
  'capsule.config.inspect', 'capsule.interaction.ls', 'capsule.interaction.inspect'])
const launchKey = (launch: AgentMuxPreparedTerminal): string => `${launch.createOperationId}:${createHash('sha256').update(launch.launch).digest('hex')}`
/** One durable service intent using the existing Core/ctxmux Run lifecycle, never another supervisor. */
export class CapsuleRunManager {
  private readonly path: string
  private readonly commandsDirectory: string
  private queue: Promise<unknown> = Promise.resolve()
  private closed = false
  private readonly disconnected = new AbortController()
  private readonly effects = new Map<string, Effect>()
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
      await this.settlePending()
      if (binding) {
        const current = (await this.converge(await this.load() ?? binding)).binding
        if (current.command) {
          const saved = await this.commandRecord(current.command.params.operationId)
          const observed = await this.observe(current, current.command, undefined, saved?.receipt)
          if (observed.operation?.phase === 'confirmed') await this.retainReceipt(current.command.params.operationId, 'confirmed')
        }
      }
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
      ![null, 'prepared', 'dispatched', 'confirmed', 'not_applied'].includes(b.launchPhase) ||
      ![null, 'prepared', 'dispatched', 'confirmed', 'not_applied'].includes(b.stopPhase) ||
      (b.run !== null && (typeof b.run?.runId !== 'string' || !b.run.runId)))
      throw unavailable('The original service binding is invalid. Preserve its namespace and repair the original binding; no replacement was created.', 'CAPSULE_RUNTIME_BINDING_INVALID')
    if (b.launch) parsePreparedTerminal(b.launch)
    if (b.stop) parsePreparedTerminalStop(b.stop)
    if ((b.stop && b.stop.run.runId !== b.run?.runId) || (b.stop === null) !== (b.stopPhase === null) ||
      (b.launch === null) !== (b.launchPhase === null) || b.run !== null && b.launchPhase !== 'confirmed' ||
      b.launchPhase === 'confirmed' && b.run === null || b.desired === 'running' && b.stop !== null && !['confirmed', 'not_applied'].includes(b.stopPhase ?? '') ||
      b.command !== null && !['start', 'stop'].includes(b.command.kind))
      throw unavailable('The original service lifecycle identities or phases disagree. Preserve the binding and its Runs.', 'CAPSULE_RUNTIME_BINDING_INVALID')
    for (const id of [b.launchCommandId, b.stopCommandId]) if (id !== undefined && id !== null &&
      (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(id)))
      throw unavailable('The original management operation ID is invalid.', 'CAPSULE_RUNTIME_BINDING_INVALID')
    if (b.launchPhase === 'not_applied' && b.launchOutcome?.disposition !== 'not_applied' ||
      b.stopPhase === 'not_applied' && b.stopOutcome?.disposition !== 'not_applied' ||
      b.launchOutcome && !b.launch || b.stopOutcome && !b.stop)
      throw unavailable('The original outcome has no matching Native preparation.', 'CAPSULE_RUNTIME_BINDING_INVALID')
    for (const outcome of [b.launchOutcome, b.stopOutcome]) {
      if (outcome && (!['applied', 'not_applied', 'unknown'].includes(outcome.disposition) ||
        outcome.disposition !== 'applied' && !outcome.failure))
        throw unavailable('The original service outcome is invalid.', 'CAPSULE_RUNTIME_BINDING_INVALID')
      if (outcome?.failure) parseAgentMuxErrorData(outcome.failure)
    }
    if (b.command) parseCapsuleRuntimeParams(`capsule.runtime.${b.command.kind}`, b.command.params)
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
  private failure(error: unknown): AgentMuxErrorData {
    if (error instanceof AgentMuxError) return parseAgentMuxErrorData({ code: error.code, message: error.message,
      ...(error.detail === undefined ? {} : { detail: error.detail }),
      ...(error.logId === undefined ? {} : { logId: error.logId }),
      ...(error.controlFailure === undefined ? {} : { controlFailure: error.controlFailure }),
      ...(error.creationFailure === undefined ? {} : { creationFailure: error.creationFailure }),
      ...(error.storageFailure === undefined ? {} : { storageFailure: error.storageFailure }) })
    if (error instanceof DurableWriteError) return { code: error.code ?? 'CAPSULE_RUNTIME_STORAGE_UNCONFIRMED', message: error.message, detail: error.detail }
    return { code: 'CAPSULE_RUNTIME_UNAVAILABLE', message: error instanceof Error ? error.message : String(error) }
  }
  private effectKey(kind: 'start' | 'stop', b: Binding): string {
    return kind === 'start' ? `start:${launchKey(b.launch!)}` :
      `stop:${b.stop!.run.runId}:${b.stop!.ownerInstanceId}:${b.stop!.operationId}`
  }
  private async nativeReceipt(b: Binding, kind: 'start' | 'stop'): Promise<NativeReceipt | undefined> {
    if (!b.launch || kind === 'stop' && !b.stop) return undefined
    const id = kind === 'start' ? b.launchCommandId : b.stopCommandId
    if (!id) return undefined
    const record = await this.commandRecord(id)
    // Old or incomplete facts remain unknown; a command phase cannot supply missing Native identity.
    const matched = [record?.latestNative, record?.native].find(receipt => receipt && receipt.key === this.effectKey(kind, b) && receipt.launchKey === launchKey(b.launch!) &&
      receipt.operationId === (kind === 'start' ? b.launch!.createOperationId : b.stop!.operationId) &&
      (kind === 'start' || receipt.runId === b.stop!.run.runId && receipt.ownerInstanceId === b.stop!.ownerInstanceId))
    if (!matched?.outcome || !['applied', 'not_applied', 'unknown'].includes(matched.outcome.disposition)) return undefined
    if (matched.outcome.disposition !== 'applied' && !matched.outcome.failure) return undefined
    if (matched.outcome.failure) { try { parseAgentMuxErrorData(matched.outcome.failure) } catch { return undefined } }
    if (kind === 'start' && matched.outcome.disposition === 'applied' && (typeof matched.runId !== 'string' || !matched.runId)) return undefined
    return matched
  }
  private async outcome(b: Binding, kind: 'start' | 'stop'): Promise<Outcome | undefined> {
    if (kind === 'start' && !b.launch || kind === 'stop' && !b.stop) return undefined
    const live = this.effects.get(this.effectKey(kind, b))?.outcome
    const stored = kind === 'start' ? b.launchOutcome : b.stopOutcome
    if (live) return live
    if (stored && (kind === 'start' ? b.launchPhase === 'confirmed' || b.launchPhase === 'not_applied' : b.stopPhase === 'confirmed' || b.stopPhase === 'not_applied')) return stored
    const saved = await this.nativeReceipt(b, kind)
    return saved?.outcome ?? stored
  }
  /** Only the existing effect owner repairs its binding from an already durable exact receipt. */
  private async restoreOutcomes(b: Binding): Promise<Binding> {
    const before = JSON.stringify(b)
    for (const kind of ['start', 'stop'] as const) {
      // An already bound Run is verified directly; historical command data cannot retarget it.
      if (kind === 'start' && b.run) continue
      const receipt = await this.nativeReceipt(b, kind)
      if (!receipt) continue
      const commandId = kind === 'start' ? b.launchCommandId : b.stopCommandId
      await this.confirmDurable(join(this.commandsDirectory, `${commandId}.json`))
      if (kind === 'start') {
        b.launchOutcome = receipt.outcome!
        if (receipt.outcome!.disposition === 'not_applied') b.launchPhase = 'not_applied'
        if (receipt.outcome!.disposition === 'applied' && receipt.runId) {
          b.run = { runId: receipt.runId }; b.launchPhase = 'confirmed'
        }
      } else {
        b.stopOutcome = receipt.outcome!
        if (receipt.outcome!.disposition === 'not_applied') b.stopPhase = 'not_applied'
        else if (receipt.outcome!.disposition === 'applied' && b.stopPhase === 'prepared') b.stopPhase = 'dispatched'
      }
    }
    if (JSON.stringify(b) !== before) await this.save(b)
    return b
  }
  private async commandRecord(id: string): Promise<CommandRecord | null> {
    try {
      const record = JSON.parse(await readFile(join(this.commandsDirectory, `${id}.json`), 'utf8')) as CommandRecord
      if (record.schema !== 'agentmux.capsule-command.v1' || !['prepared', 'committed'].includes(record.phase) ||
        record.command?.params.operationId !== id || !['start', 'stop'].includes(record.command.kind)) throw unavailable('The original service command is invalid.', 'CAPSULE_RUNTIME_OPERATION_CONFLICT')
      parseCapsuleRuntimeParams(`capsule.runtime.${record.command.kind}`, record.command.params)
      if (record.receipt && (record.receipt.operationId !== id || record.receipt.kind !== record.command.kind))
        throw unavailable('The original command receipt names another operation.', 'CAPSULE_RUNTIME_OPERATION_CONFLICT')
      if (record.receipt) parseCapsuleRuntimeResult({ revision: 0, desired: 'unconfigured', phase: 'unconfigured', stateDirectory: this.stateDirectory, socketPath: this.socketPath, run: null, runtime: null, operation: record.receipt, issue: null })
      return record
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  }
  private async retainReceipt(id: string | null | undefined, phase: CapsuleRuntimeOperation['phase'], failure?: AgentMuxErrorData, native?: NativeReceipt, reserve = false): Promise<void> {
    if (!id) return
    const record = await this.commandRecord(id)
    if (!record) return
    const previous = record.receipt
    // Terminal command history belongs to that original operation, not the current generation.
    const terminal = previous?.phase === 'confirmed' || previous?.phase === 'not_applied'
    if (terminal && !native) return
    if (!terminal) record.receipt = { operationId: id, kind: record.command.kind, phase,
      ...(failure ? { failure } : {}),
      ...(previous?.firstFailure || failure ? { firstFailure: (previous?.firstFailure ?? failure)! } : {}) }
    if (native) {
      if (!record.native) record.native = native
      else if (record.native.key === native.key) {
        if (native.outcome) record.native = native
      } else if (reserve || !record.latestNative || record.latestNative.key === native.key) {
        record.latestNative = native
      }
    }
    await durableWriteFile(join(this.commandsDirectory, `${id}.json`), JSON.stringify(record) + '\n', { requireDirectorySync: true })
  }
  /** Persist the original settled wire, even when its observer already timed out. Never dispatch. */
  private async settle(effect: Effect): Promise<void> {
    if (!effect.outcome || effect.durable) return
    const outcome = effect.outcome
    const receipt: NativeReceipt = { key: effect.key, launchKey: launchKey(effect.launch), operationId: effect.operationId, outcome,
      ...(effect.run ? { runId: effect.run.runId } : effect.stop ? { runId: effect.stop.run.runId, ownerInstanceId: effect.stop.ownerInstanceId } : {}) }
    // Receipt and its exact Native identity/result are one durable command replacement.
    await this.retainReceipt(effect.commandId, outcome.disposition === 'applied' ? 'pending' : outcome.disposition, outcome.failure, receipt)
    const current = await this.load()
    const sameGeneration = current?.launch && isDeepStrictEqual(current.launch, effect.launch) &&
      (effect.kind === 'start' || current.stop && isDeepStrictEqual(current.stop, effect.stop))
    if (current && sameGeneration) {
      if (effect.kind === 'start') {
        current.launchOutcome = outcome
        if (outcome.disposition === 'applied' && effect.run) {
          current.run = { runId: effect.run.runId }; current.launchPhase = 'confirmed'
        } else if (outcome.disposition === 'not_applied') current.launchPhase = 'not_applied'
      } else {
        current.stopOutcome = outcome
        if (outcome.disposition === 'not_applied') current.stopPhase = 'not_applied'
      }
      await this.save(current)
    }
    effect.durable = true
    this.effects.delete(effect.key)
  }
  private async settlePending(): Promise<void> {
    for (const effect of this.effects.values()) if (effect.outcome) await this.settle(effect)
  }
  private captureOutcome(effect: Effect, error: unknown): Outcome {
    const failure = this.failure(error)
    const notApplied = !effect.invoked || error instanceof AgentMuxError && (effect.kind === 'start'
      ? error.creationFailure?.operationId === effect.operationId && error.creationFailure.disposition === 'not_applied'
      : error.controlFailure?.disposition === 'not_applied')
    return { disposition: notApplied ? 'not_applied' : 'unknown', failure }
  }
  private async dispatch(b: Binding, kind: 'start' | 'stop'): Promise<void> {
    const key = this.effectKey(kind, b)
    let effect = this.effects.get(key)
    if (effect) { if (effect.outcome) await this.settle(effect); return }
    effect = { kind, key, operationId: kind === 'start' ? b.launch!.createOperationId : b.stop!.operationId,
      commandId: (kind === 'start' ? b.launchCommandId : b.stopCommandId) ?? null,
      launch: structuredClone(b.launch!), ...(b.stop ? { stop: structuredClone(b.stop) } : {}), invoked: false, durable: false }
    this.effects.set(key, effect)
    // This live owner knows whether Native was called, even if rename became visible before fsync failed.
    if (kind === 'start') b.launchPhase = 'dispatched'; else b.stopPhase = 'dispatched'
    try {
      await this.retainReceipt(effect.commandId, 'pending', undefined, { key: effect.key, launchKey: launchKey(effect.launch), operationId: effect.operationId,
        ...(effect.stop ? { runId: effect.stop.run.runId, ownerInstanceId: effect.stop.ownerInstanceId } : {}) }, true)
      await this.save(b)
    }
    catch (error) {
      effect.outcome = this.captureOutcome(effect, error)
      try { await this.settle(effect) } catch { /* Keep the exact uncalled fact for the active owner to settle. */ }
      throw error
    }
    effect.invoked = true
    const original = effect
    const work = Promise.resolve().then(async (): Promise<AgentMuxRun | void> => kind === 'start'
      ? await this.client.createPreparedTerminal(original.launch)
      : await this.client.stopPreparedTerminal(original.stop!))
    const settled = work.then(run => {
      if (run) original.run = run
      original.outcome = { disposition: 'applied' }
    }, error => { original.outcome = this.captureOutcome(original, error) })
    // Queueing a receipt writer does not hold the management queue over its own callback.
    void settled.then(() => { if (!this.closed) void this.serial(() => this.settle(original)).catch(() => {}) })
    const signal = AbortSignal.any([this.disconnected.signal, AbortSignal.timeout(5000)])
    try { await observeRead(settled, signal) }
    catch (error) {
      const failure = this.failure(unavailable('The original Native observation ended without a confirmed receipt. Inspect without resending.', 'CAPSULE_RUNTIME_OBSERVATION_UNKNOWN'))
      await this.retainReceipt(original.commandId, 'unknown', failure)
      throw unavailable(failure.message, failure.code)
    }
    await this.settle(original)
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
    if (!current || current.revision !== b.revision || current.desired !== 'running' ||
      current.run?.runId !== b.run?.runId || !isDeepStrictEqual(current.launch, b.launch) ||
      current.run !== null && current.run.runId !== run.runId)
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
    // Only an effect owner reconfirms a previously unacknowledged durable intent.
    await this.settlePending()
    b = await this.restoreOutcomes(await this.load() ?? b)
    await this.confirmDurable(this.path)
    if ((await this.outcome(b, b.desired === 'running' ? 'start' : 'stop'))?.disposition === 'not_applied') return { binding: b, run: b.run ? await this.originalRun(b) : null }
    await this.native('connect', () => this.client.connectRuntime())
    let run = await this.originalRun(b)
    if (b.run && terminalRun(run)) {
      if (b.desired === 'stopped') { if (b.stop && b.stopPhase !== 'confirmed') { b.stopPhase = 'confirmed'; await this.save(b) }; return { binding: b, run } }
      b.run = null; b.launch = null; b.launchPhase = null; b.stop = null; b.stopPhase = null
      delete b.launchOutcome; delete b.stopOutcome; delete b.launchCommandId; delete b.stopCommandId
      await this.save(b)
    }
    if (b.desired === 'stopped') {
      if (!b.run && b.launchPhase === 'dispatched' && b.launch) {
        run = await this.native(`creation:${launchKey(b.launch)}`, () => this.client.inspectPreparedTerminal(b.launch!))
        if (run) { b.run = { runId: run.runId }; b.launchPhase = 'confirmed'; await this.save(b) }
      }
      if (!b.run) return { binding: b, run: null }
      if (!b.stop) {
        b.stop = await this.client.prepareTerminalStop(b.run); b.stopPhase = 'prepared'
        b.stopCommandId = b.command?.kind === 'stop' ? b.command.params.operationId : null
        await this.save(b)
      }
      if (b.stopPhase === 'prepared') {
        await this.dispatch(b, 'stop')
        b = await this.load() ?? b
      }
      run = await this.originalRun(b)
      if (terminalRun(run) && b.stopPhase !== 'not_applied') { b.stopPhase = 'confirmed'; await this.save(b); await this.retainReceipt(b.stopCommandId, 'confirmed') }
      return { binding: b, run }
    }
    if (!b.run) {
      if (!b.launch) {
        await mkdir(b.stateDirectory, { recursive: true, mode: 0o700 })
        b.launch = this.client.prepareTerminal({ command: process.execPath,
          args: [capsuleRuntimeEntrypoint(), 'serve', '--state-directory', b.stateDirectory, '--socket', b.socketPath],
          workspacePath: b.stateDirectory, env: { ELECTRON_RUN_AS_NODE: '1' }, createOperationId: mintObjectId() })
        b.launchPhase = 'prepared'
        b.launchCommandId = b.command?.kind === 'start' ? b.command.params.operationId : null
        await this.save(b)
      }
      if (b.launchPhase === 'prepared') {
        await this.dispatch(b, 'start')
        b = await this.load() ?? b
        if (b.launchPhase === 'not_applied') return { binding: b, run: null }
        run = await this.originalRun(b)
      } else run = await this.native(`creation:${launchKey(b.launch)}`, () => this.client.inspectPreparedTerminal(b.launch!))
      if (!run) throw unavailable('The original service creation is unconfirmed. Inspect the retained operation; do not resend Start.', 'CAPSULE_RUNTIME_CREATION_UNKNOWN')
      b.run = { runId: run.runId }; b.launchPhase = 'confirmed'; await this.save(b)
    }
    return { binding: b, run: run ?? await this.originalRun(b) }
  }
  /** Read the original Run or already-dispatched creation; never dispatch or save lifecycle work. */
  private async observedRun(b: Binding): Promise<AgentMuxRun | null> {
    if (!b.run && !(b.launch && b.launchPhase === 'dispatched')) return null
    await this.native('connect', () => this.client.connectRuntime())
    if (b.run) return await this.originalRun(b)
    const receipt = await this.nativeReceipt(b, 'start')
    return await this.native(`creation:${launchKey(b.launch!)}`, () => this.client.inspectPreparedTerminal(b.launch!,
      receipt?.outcome?.disposition === 'applied' && receipt.runId ? { runId: receipt.runId } : undefined))
  }
  private async observe(b: Binding | null, requested?: Command, originalFailure?: unknown, retained?: CapsuleRuntimeOperation): Promise<CapsuleRuntimeObservation> {
    const base: CapsuleRuntimeObservation = { revision: b?.revision ?? 0, desired: b?.desired ?? 'unconfigured', phase: b ? 'unavailable' : 'unconfigured',
      stateDirectory: b?.stateDirectory ?? this.stateDirectory, socketPath: b?.socketPath ?? this.socketPath,
      run: b?.run ? { hostId: 'local', ...b.run } : null, runtime: null, operation: null, issue: null }
    if (!b) return base
    const command = requested ?? b.command
    if (command) base.operation = { operationId: command.params.operationId, kind: command.kind,
      phase: b.command?.params.operationId === command.params.operationId ? 'pending' : 'superseded' }
    if (retained) base.operation = structuredClone(retained)
    const fixed = retained && (retained.phase === 'confirmed' || retained.phase === 'not_applied' || command?.params.operationId !== b.command?.params.operationId)
    const currentKind = b.desired === 'running' ? 'start' : 'stop'
    const known = await this.outcome(b, currentKind)
    if (!fixed && known?.disposition === 'not_applied' && base.operation) base.operation = { ...base.operation, phase: 'not_applied', failure: known.failure!, firstFailure: retained?.firstFailure ?? known.failure! }
    try {
      if (known?.disposition === 'not_applied') {
        base.phase = b.desired === 'stopped' && !b.run ? 'stopped' : 'unavailable'
        base.issue = { code: known.failure!.code, message: known.failure!.message, recovery: 'The original Native operation was not applied. A new explicit command with a fresh ID and current revision can try again.', retry: currentKind }
        return base
      }
      if (originalFailure !== undefined) throw originalFailure
      const run = await this.observedRun(b)
      base.run = run ? { hostId: 'local', runId: run.runId } : base.run
      if (!run && b.launchPhase === 'dispatched') throw unavailable('The original service creation is unconfirmed. Inspect the retained operation; do not resend Start.', 'CAPSULE_RUNTIME_CREATION_UNKNOWN')
      if (b.desired === 'stopped') {
        const confirmed = b.stopPhase === 'confirmed' || (!b.run && b.launchPhase !== 'dispatched') || (b.run !== null || run !== null) && terminalRun(run)
        if (!confirmed && b.stopPhase !== 'dispatched') { base.phase = 'stopping'; return base }
        base.phase = confirmed ? 'stopped' : 'unknown'
        if (!confirmed) throw unavailable('The original Stop is unconfirmed. The stopped intent is durable; observe the same Run without resending Stop.', 'CAPSULE_RUNTIME_STOP_UNKNOWN')
      } else {
        if (!b.run && b.launchPhase !== 'dispatched') { base.phase = 'starting'; return base }
        if (!run || run.state !== 'running') throw unavailable('The original service Run is not currently running. Its retained intent will be observed again.')
        const { connection, identity } = await this.connect(b, run)
        try { base.runtime = { runtimeId: identity.runtimeId, ownerInstanceId: identity.ownerInstanceId, pid: identity.pid }; base.phase = 'running' }
        finally { await this.release(connection) }
      }
      if (base.operation && !fixed && base.operation.phase !== 'superseded' && base.operation.phase !== 'not_applied') base.operation.phase = 'confirmed'
    } catch (error) {
      const code = error instanceof AgentMuxError ? error.code : 'CAPSULE_RUNTIME_UNAVAILABLE'
      base.phase = b.launchPhase === 'dispatched' && !b.run || b.stopPhase === 'dispatched' || error instanceof AgentMuxError && error.code === 'CAPSULE_RUNTIME_OBSERVATION_UNKNOWN' ? 'unknown' : 'unavailable'
      base.issue = { code, message: error instanceof Error ? error.message : String(error), recovery: 'Inspect this original service binding again. Retain the namespace, Run and operation; healthy Agents remain available.' }
      if (base.operation && !fixed && base.operation.phase !== 'superseded' && base.operation.phase !== 'not_applied') base.operation = { ...base.operation, phase: base.phase === 'unknown' ? 'unknown' : 'pending', failure: this.failure(error), firstFailure: base.operation.firstFailure ?? this.failure(error) }
    }
    return base
  }
  private async manage<M extends CapsuleRuntimeMethod>(method: M, value: CapsuleRuntimeParamsMap[M]): Promise<CapsuleRuntimeObservation> {
    const params = parseCapsuleRuntimeParams(method, value)
    let b = await this.load()
    if (method === 'capsule.runtime.inspect') {
      const id = (params as CapsuleRuntimeParamsMap['capsule.runtime.inspect']).operationId
      const record = id ? await this.commandRecord(id) : b?.command ? await this.commandRecord(b.command.params.operationId) : null
      const observed = await this.observe(b, record?.command, undefined, record?.receipt)
      if (id && !record) observed.operation = null
      return observed
    }
    await this.settlePending()
    b = await this.load()
    if (b) b = await this.restoreOutcomes(b)
    const command: Command = { kind: method === 'capsule.runtime.start' ? 'start' : 'stop', params: params as Command['params'] }
    await mkdir(this.commandsDirectory, { recursive: true, mode: 0o700 })
    const path = join(this.commandsDirectory, `${command.params.operationId}.json`)
    try {
      const retained = JSON.parse(await readFile(path, 'utf8')) as CommandRecord
      if (retained.schema !== 'agentmux.capsule-command.v1' || !['prepared', 'committed'].includes(retained.phase) ||
        !isDeepStrictEqual(retained.command, command)) throw unavailable('This operation ID already belongs to a different service command or invalid record.', 'CAPSULE_RUNTIME_OPERATION_CONFLICT')
      const observation = await this.observe(b, command, undefined, retained.receipt)
      if (retained.phase === 'prepared' && b?.command?.params.operationId !== command.params.operationId) {
        observation.operation = { kind: command.kind, operationId: command.params.operationId, phase: 'unknown' }
        observation.issue = { code: 'CAPSULE_RUNTIME_INTENT_UNKNOWN', message: 'The original command was reserved but its intent commitment is unconfirmed.',
          recovery: 'Retain this operation. Inspect the current revision and original binding before deciding a new explicit management intent.' }
      }
      return observation
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (command.params.expectedRevision !== (b?.revision ?? 0)) throw unavailable('The service intent revision changed. Inspect the original binding before a new command.', 'CAPSULE_RUNTIME_REVISION_CONFLICT')
    let stopRun = b?.run ?? null
    if (command.kind === 'stop' && !stopRun && b?.launchPhase === 'dispatched') {
      const original = await this.observedRun(b)
      if (original) stopRun = { runId: original.runId }
    }
    if (command.kind === 'stop' && !isDeepStrictEqual((command.params as CapsuleRuntimeParamsMap['capsule.runtime.stop']).expectedRun, stopRun))
      throw unavailable('The observed service Run changed. The new Run was preserved.', 'CAPSULE_RUNTIME_RUN_CONFLICT')
    if (command.kind === 'start' && b?.desired === 'stopped' && (await this.outcome(b, 'start'))?.disposition !== 'not_applied' && (await this.outcome(b, 'stop'))?.disposition !== 'not_applied' && (b.run && b.stopPhase !== 'confirmed' || b.launchPhase === 'dispatched')) {
      const original = await this.observedRun(b)
      if (b.launchPhase === 'dispatched' && !original || !terminalRun(original))
        throw unavailable('The original Stop is still unconfirmed. Keep its Run fence before starting another generation.', 'CAPSULE_RUNTIME_STOP_UNKNOWN')
      if (!b.run && original) { b.run = { runId: original.runId }; b.launchPhase = 'confirmed' }
    }
    if (b?.command) {
      const previous = await this.commandRecord(b.command.params.operationId)
      if (previous?.receipt?.phase !== 'confirmed' && previous?.receipt?.phase !== 'not_applied') {
        const observed = await this.observe(b, b.command, undefined, previous?.receipt)
        if (observed.operation?.phase === 'confirmed') await this.retainReceipt(b.command.params.operationId, 'confirmed')
      }
    }
    const startFailed = b && (await this.outcome(b, 'start'))?.disposition === 'not_applied'
    const stopFailed = b && (await this.outcome(b, 'stop'))?.disposition === 'not_applied'
    const record: CommandRecord = { schema: 'agentmux.capsule-command.v1', command, phase: 'prepared' }
    await durableWriteFile(path, JSON.stringify(record) + '\n', { requireDirectorySync: true })
    if (!b) b = this.blank()
    else b.revision++
    b.desired = command.kind === 'start' ? 'running' : 'stopped'; b.command = command
    if (command.kind === 'start' && (b.stopPhase === 'confirmed' || startFailed)) { b.run = null; b.launch = null; b.launchPhase = null; b.stop = null; b.stopPhase = null; delete b.launchOutcome; delete b.stopOutcome; delete b.launchCommandId; delete b.stopCommandId }
    if (stopFailed) { b.stop = null; b.stopPhase = null; delete b.stopOutcome; delete b.stopCommandId }
    await this.save(b)
    record.phase = 'committed'
    await durableWriteFile(path, JSON.stringify(record) + '\n', { requireDirectorySync: true })
    try {
      b = (await this.converge(b)).binding
      const saved = await this.commandRecord(command.params.operationId)
      const observation = await this.observe(b, command, undefined, saved?.receipt)
      if (observation.operation && observation.operation.phase !== 'superseded') await this.retainReceipt(command.params.operationId, observation.operation.phase, observation.operation.failure)
      if (observation.runtime && !b.runtimeId) { b.runtimeId = observation.runtime.runtimeId; await this.save(b) }
      return observation
    } catch (error) {
      await this.retainReceipt(command.params.operationId, 'unknown', this.failure(error)).catch(() => {})
      b = await this.load() ?? b
      const saved = await this.commandRecord(command.params.operationId)
      return await this.observe(b, command, error, saved?.receipt)
    }
  }
  async call<M extends CapsuleMethod>(method: M, params: CapsuleParamsMap[M], context?: CapsuleCallContext, originalContext?: AgentMuxRpcCallContext): Promise<CapsuleResultMap[M]> {
    let dispatched = false
    try {
      // Reserve/observe management serially, but never hold its lock over a page callback.
      const ready = await this.serial(async () => {
        let b = await this.load()
        if (!b) {
          if (method !== 'capsule.create') throw unavailable('The Capsule service has no running intent. Start it explicitly or create a page before using this operation; this operation did not start a service.', 'CAPSULE_RUNTIME_UNCONFIGURED')
          b = this.blank(); await this.save(b)
        }
        if (b.desired === 'stopped') throw unavailable('The Capsule service was explicitly stopped. Its pages and configuration are retained; start it explicitly to serve them.', 'CAPSULE_RUNTIME_STOPPED')
        const ready = serviceReads.has(method) ? { binding: b, run: await this.observedRun(b) } : await this.converge(b)
        b = ready.binding
        const run = ready.run
        if (!run || run.state !== 'running') throw unavailable('The original Capsule service is not running yet. Inspect its retained Run.')
        return { binding: b, run }
      })
      let last: unknown
      // Native readiness is distinct from the application socket. Observation never restarts a live Run.
      for (let attempt = 0; attempt < 50 && !this.closed; attempt++) {
        context?.signal?.throwIfAborted()
        let connected: Awaited<ReturnType<CapsuleRunManager['connect']>>
        try { connected = await this.serial(async () => {
          const result = await this.connect(ready.binding, ready.run, originalContext)
          if (!serviceReads.has(method) && !ready.binding.runtimeId) {
            try { ready.binding.runtimeId = result.identity.runtimeId; await this.save(ready.binding) }
            catch (error) { await this.release(result.connection); throw error }
          }
          return result
        }) }
        catch (error) {
          // Only a connection failure before dispatch may be observed again. A domain call is never replayed.
          last = error
          const code = (error as NodeJS.ErrnoException).code
          if (code !== 'ENOENT' && code !== 'ECONNREFUSED') throw error
          await new Promise(resolveWait => setTimeout(resolveWait, 100))
          continue
        }
        try { dispatched = true; return await connected.connection.call(method, params, context) }
        finally { await this.release(connected.connection) }
      }
      throw unavailable(`The service Run is retained but its application endpoint is unavailable: ${last instanceof Error ? last.message : 'connection not confirmed'}`)
    } catch (error) {
      if (dispatched) throw error
      const original = this.failure(error)
      const refused = new AgentMuxError(original.message, original.code, original.detail,
        { disposition: 'not_applied', confirmedInputBytes: 0 }, original.logId, original.creationFailure, original.storageFailure)
      Object.defineProperty(refused, 'cause', { value: error })
      throw refused
    }
  }
}
