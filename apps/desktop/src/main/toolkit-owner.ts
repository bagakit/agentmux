import { randomUUID } from 'node:crypto'
import { AgentMuxError, type AgentMuxClientEvent, type AgentMuxRunRef } from '@agentmux/core'
import { AGENTMUX_CONTROL_MAX_MESSAGE_BYTES, parseMetricsObservation, type AgentMuxToolkitPort,
  type ToolkitRequest, type ToolkitResult, type ToolkitSnapshot, type ToolkitMetricsSnapshot } from '@agentmux/core/control'
import { readPerformanceScript, type PerformanceLaunch } from './toolkit-asset.js'
import type { ToolkitRunPort } from './toolkit-run-port.js'
import { CustomToolkitOwner } from './toolkit-custom-owner.js'
import { executeToolkitConfig, prepareToolkitConfig, toolkitTools } from './toolkit-config.js'
import type { ConfigOwner } from './config-owner.js'
import type { AppConfig } from '../shared/contracts.js'
import { ToolkitReceiptStore } from './toolkit-receipt-store.js'

type Lease = { snapshot(value: ToolkitSnapshot): void; end(error?: Error): void; release(): void }
type Execution = { id: string; ref: AgentMuxRunRef | null; port: ToolkitRunPort | null; ended: boolean
  creationPending: boolean; lastAppObservedAt: number | null; cursor: number; buffer: string; decoder: TextDecoder; sequence: number }
/** Observation state only. Core/ctxmux remains the sole Run and process owner. */
export class PerformanceToolkitOwner implements AgentMuxToolkitPort {
  private readonly leases = new Set<Lease>()
  private manual = false
  private closed = false
  private starting: Promise<void> | null = null
  private stopping: Promise<void> | null = null
  private execution: Execution | null = null
  private value: ToolkitMetricsSnapshot = { schema: 'agentmux.toolkit.v1', kind: 'metrics', toolId: 'performance', executionId: null,
    run: null, state: 'idle', reason: null, startedAt: null, observedAt: null, observation: null,
    manual: false, consumerCount: 0, sequence: 0, trend: [] }
  constructor(private readonly args: { openRunPort(): Promise<ToolkitRunPort>; launch(): PerformanceLaunch
    enabled(): boolean; mainPid?: number; now?: () => number }) {}
  get current(): ToolkitMetricsSnapshot {
    return structuredClone({ ...this.value, manual: this.manual, consumerCount: this.leases.size })
  }
  private publish() {
    const value = this.current
    for (const lease of [...this.leases]) {
      try { lease.snapshot(value) } catch { lease.release() }
    }
  }
  private wanted() { return !this.closed && (this.manual || this.leases.size > 0) }
  private allowed(signal: AbortSignal) {
    if (signal.aborted) throw new AgentMuxError('Toolkit consumer cancelled.', 'CONTROL_CANCELLED')
    if (this.closed) throw new AgentMuxError('Toolkit owner closed.', 'CONTROL_UNAVAILABLE')
    if (!this.args.enabled()) throw new AgentMuxError('Performance is disabled.', 'CONTROL_UNAVAILABLE')
  }
  async execute(request: ToolkitRequest, signal: AbortSignal): Promise<ToolkitResult> {
    if (request.operation !== 'toolkit.list' && request.toolId !== 'performance') throw new AgentMuxError('Toolkit tool is unknown.', 'INVALID_CONTROL_REQUEST')
    if (request.operation === 'toolkit.list') return { operation: request.operation, tools: [{ kind: 'metrics', toolId: 'performance', name: 'Performance', readonly: true }] }
    if (request.operation === 'toolkit.script') return { operation: request.operation, script: await readPerformanceScript(this.args.launch()) }
    if (request.operation === 'toolkit.get') return { operation: request.operation, snapshot: this.current }
    if (request.operation === 'toolkit.run') {
      this.allowed(signal)
      if (this.execution && this.value.state === 'unknown') throw new AgentMuxError('Previous tool outcome is unconfirmed.', 'CONTROL_UNAVAILABLE')
      // Admission is the explicit write. A lost receipt is unknown, not an implicit undo.
      this.manual = true
      await this.ensure()
      return { operation: request.operation, snapshot: this.current }
    }
    if (request.operation === 'toolkit.stop') {
      this.manual = false
      for (const lease of [...this.leases]) { lease.release(); lease.end() }
      await this.quiesce()
      return { operation: request.operation, snapshot: this.current }
    }
    throw new AgentMuxError('Watch requires the Toolkit subscription port.', 'INVALID_CONTROL_REQUEST')
  }
  async subscribe(_toolId: 'performance', snapshot: Lease['snapshot'], end: Lease['end'], signal: AbortSignal) {
    this.allowed(signal)
    let released = false
    const lease: Lease = { snapshot, end, release: () => {
      if (released) return
      released = true; signal.removeEventListener('abort', lease.release); this.leases.delete(lease)
      this.publish(); void this.quiesce()
    } }
    this.leases.add(lease); signal.addEventListener('abort', lease.release, { once: true })
    if (signal.aborted) lease.release()
    try {
      await this.ensure()
      if (!released && !signal.aborted) snapshot(this.current)
      else lease.release()
      return { dispose: lease.release }
    } catch (error) { lease.release(); throw error }
  }
  private async ensure(): Promise<void> {
    if (this.stopping) await this.stopping
    if (!this.wanted()) return
    if (this.execution && this.value.state === 'unknown') throw new AgentMuxError('Previous tool cleanup is unconfirmed.', 'CONTROL_UNAVAILABLE')
    if (this.starting) return await this.starting
    if (this.execution?.ref && !this.execution.ended) return
    const execution: Execution = { id: randomUUID(), ref: null, port: null, ended: false,
      creationPending: false, lastAppObservedAt: null, cursor: 0, buffer: '', decoder: new TextDecoder('utf-8', { fatal: true }), sequence: 0 }
    this.execution = execution
    this.value = { ...this.value, executionId: execution.id, run: null, state: 'starting', reason: null,
      startedAt: (this.args.now ?? Date.now)(), observation: null, observedAt: null, sequence: 0, trend: [] }
    this.publish()
    const work = async () => {
      const launch = this.args.launch()
      await readPerformanceScript(launch)
      const port = await this.args.openRunPort()
      execution.port = port
      if (!this.wanted() || execution.ended) return
      execution.creationPending = true
      const run = await port.create({ createOperationId: execution.id, workspacePath: launch.cwd,
        command: launch.runner, args: [launch.script, launch.cli], env: launch.env, cols: 80, rows: 24 },
      event => this.accept(execution, event))
      execution.ref = { runId: run.runId }
      execution.creationPending = false
      this.value.run = { hostId: 'local', runId: run.runId }
      if (!this.wanted() || execution.ended) return
      const attached = await port.attach(execution.ref, 0)
      if (attached.gap) throw new AgentMuxError('Tool output replay has a Gap.', 'CONTROL_PROTOCOL_ERROR')
      for (const chunk of attached.replay) this.bytes(execution, chunk.startByte, chunk.endByte, chunk.dataBytes)
      if (!execution.ended) { this.value.state = 'observing'; this.publish() }
    }
    this.starting = work().catch(error => {
      this.manual = false; execution.ended = true
      this.value.state = execution.creationPending ? 'unknown' : 'failed'
      this.value.reason = String(error instanceof Error ? error.message : error).slice(0,4096)
      this.publish(); throw error
    }).finally(() => {
      this.starting = null
      if (!this.wanted() || execution.ended) void this.quiesce()
    })
    return await this.starting
  }
  private accept(execution: Execution, event: AgentMuxClientEvent) {
    if (this.execution !== execution || execution.ended) return
    try {
      if (event.type === 'terminal-output') {
        const range = event.evidence.outputByteRange
        this.bytes(execution, range.startByte, range.endByte, event.dataBytes)
      } else if (event.type === 'terminal-snapshot') {
        if (event.gap) throw new AgentMuxError('Tool output snapshot has a Gap.', 'CONTROL_PROTOCOL_ERROR')
        for (const chunk of event.replay) this.bytes(execution, chunk.startByte, chunk.endByte, chunk.dataBytes)
      } else if (event.type === 'agent-error') {
        throw new AgentMuxError(event.message, 'CONTROL_PROTOCOL_ERROR')
      } else if (event.type === 'process-state' && event.state !== 'running') {
        execution.buffer += execution.decoder.decode()
        if (execution.buffer.length) throw new AgentMuxError('Tool output ended without a complete LF frame.', 'CONTROL_PROTOCOL_ERROR')
        this.fail(execution, event.exitCode === 0 ? 'Observation ended.' : 'Performance script exited unsuccessfully.')
      }
    } catch (error) { this.fail(execution, String(error instanceof Error ? error.message : error)) }
  }
  private bytes(execution: Execution, start: number, end: number, bytes: Uint8Array) {
    if (execution.ended || this.execution !== execution || end <= execution.cursor) return
    if (start > execution.cursor || end - start !== bytes.byteLength) throw new AgentMuxError('Tool output is not continuous ordered bytes.', 'CONTROL_PROTOCOL_ERROR')
    execution.buffer += execution.decoder.decode(bytes.subarray(Math.max(0,execution.cursor - start)), { stream: true })
    execution.cursor = end
    let lf: number
    while (!execution.ended && (lf = execution.buffer.indexOf('\n')) >= 0) {
      const line = execution.buffer.slice(0,lf).replace(/\r$/u, '')
      execution.buffer = execution.buffer.slice(lf+1)
      if (Buffer.byteLength(line) > AGENTMUX_CONTROL_MAX_MESSAGE_BYTES) throw new AgentMuxError('Toolkit result exceeds budget.', 'CONTROL_PROTOCOL_ERROR')
      const frame = JSON.parse(line)
      if (frame.schema !== 'agentmux.toolkit.result.v1') throw new AgentMuxError('Toolkit result schema is invalid.', 'CONTROL_PROTOCOL_ERROR')
      if (frame.event === 'error') throw new AgentMuxError(String(frame.reason).slice(0,4096), 'CONTROL_FAILED')
      if (frame.event !== 'result' || Object.keys(frame).sort().join() !== 'event,payload,schema,sequence' ||
        frame.sequence !== execution.sequence + 1) throw new AgentMuxError('Toolkit result sequence or framing is invalid.', 'CONTROL_PROTOCOL_ERROR')
      const observation = parseMetricsObservation(frame.payload)
      if (observation.scope.mainPid !== (this.args.mainPid ?? process.pid)) throw new AgentMuxError('Tool observation belongs to another Main owner.', 'CONTROL_PROTOCOL_ERROR')
      execution.sequence = frame.sequence
      this.value.observation = observation; this.value.observedAt = observation.observedAt
      this.value.sequence = frame.sequence; this.value.state = 'observing'; this.value.reason = null
      const app = observation.app
      if (app.state === 'available' && app.data && app.observedAt !== null &&
        (execution.lastAppObservedAt === null || app.observedAt > execution.lastAppObservedAt)) {
        execution.lastAppObservedAt = app.observedAt
        this.value.trend = [...this.value.trend, { observedAt: app.observedAt,
          appCpuPercent: app.data.cpuPercent, appRssKib: app.data.rssKib }].slice(-60)
      } else if (app.state !== 'available' && this.value.trend.length &&
        (this.value.trend.at(-1)!.appCpuPercent !== null || this.value.trend.at(-1)!.appRssKib !== null)) {
        // A real observation of unavailable source separates segments; it is not a sample.
        this.value.trend = [...this.value.trend, { observedAt: observation.observedAt,
          appCpuPercent: null, appRssKib: null }].slice(-60)
      }
      this.publish()
    }
    if (Buffer.byteLength(execution.buffer) > AGENTMUX_CONTROL_MAX_MESSAGE_BYTES) throw new AgentMuxError('Incomplete Toolkit result exceeds budget.', 'CONTROL_PROTOCOL_ERROR')
  }
  private fail(execution: Execution, reason: string) {
    if (execution.ended || this.execution !== execution) return
    execution.ended = true; this.manual = false
    this.value.state = 'failed'; this.value.reason = reason.slice(0,4096)
    for (const lease of [...this.leases]) { lease.release(); lease.end(new AgentMuxError(this.value.reason, 'CONTROL_FAILED')) }
    void this.quiesce()
  }
  private async quiesce(): Promise<void> {
    if (this.starting) { try { await this.starting } catch { /* Cleanup the exact partial creation below. */ } }
    if (this.wanted() && !this.execution?.ended) return
    if (this.stopping) return await this.stopping
    const execution = this.execution
    if (!execution?.ref || !execution.port) {
      if (execution && !execution.ref) {
        if (execution.creationPending) { this.value.state = 'unknown'; this.publish(); return }
        execution.ended = true; this.execution = null; this.value.run = null
        if (this.value.state !== 'failed' && this.value.state !== 'unknown') this.value.state = 'paused'
        this.publish()
      }
      return
    }
    execution.ended = true
    const failed = this.value.state === 'failed'
    this.value.state = 'stopping'; this.publish()
    this.stopping = (async () => {
      try {
        try { await execution.port!.stop(execution.ref!) } finally { await execution.port!.release(execution.ref!) }
        await execution.port!.remove(execution.ref!)
        if (this.execution === execution) { this.execution = null; this.value.run = null; this.value.state = failed ? 'failed' : 'paused' }
      } catch (error) {
        this.value.state = 'unknown'; this.value.reason = 'Tool cleanup is unconfirmed: ' + String(error instanceof Error ? error.message : error).slice(0,4000)
      } finally { this.stopping = null; this.publish() }
    })()
    return await this.stopping
  }
  async dispose(): Promise<void> {
    this.closed = true; this.manual = false
    for (const lease of [...this.leases]) { lease.release(); lease.end() }
    await this.quiesce()
  }
}


/** The sole public Toolkit port routes built-in observations and configured scripts to the same RawRun owner. */
export class ToolkitOwner implements AgentMuxToolkitPort {
  private readonly performance: PerformanceToolkitOwner
  private readonly custom: CustomToolkitOwner
  constructor(private readonly args: { openRunPort(): Promise<ToolkitRunPort>; launch(): PerformanceLaunch
    enabled(): boolean; config: ConfigOwner; receiptPath: string; mainPid?: number; now?: () => number }) {
    this.performance = new PerformanceToolkitOwner(args)
    const launch = args.launch()
    this.custom = new CustomToolkitOwner({ config: args.config, openRunPort: args.openRunPort,
      runner: launch.runner, env: launch.env, ...(args.now ? { now: args.now } : {}),
      receipts: new ToolkitReceiptStore(args.receiptPath, () => toolkitTools(args.config.current).map(tool => tool.id)) })
  }
  prepareConfig(current: AppConfig, next: AppConfig): Promise<AppConfig> {
    return prepareToolkitConfig(current, next, id => this.custom.guardDelete(id))
  }
  configurationChanged() { this.custom.configurationChanged() }
  async execute(request: ToolkitRequest, signal: AbortSignal): Promise<ToolkitResult> {
    if (request.operation === 'toolkit.list') return { operation: request.operation, tools: [
      { kind: 'metrics', toolId: 'performance', name: 'Performance', readonly: true },
      ...toolkitTools(this.args.config.current).map(tool => ({ kind: 'script' as const, toolId: tool.id,
        name: tool.name, readonly: false as const, revision: tool.revision, icon: tool.icon, enabled: tool.enabled, statusBar: tool.statusBar }))
    ] }
    if (request.operation === 'toolkit.add' || request.operation === 'toolkit.update' || request.operation === 'toolkit.remove') {
      return await executeToolkitConfig(request, this.args.config)
    }
    if (request.toolId === 'performance') return await this.performance.execute(request, signal)
    if (request.operation === 'toolkit.get') return { operation: request.operation, snapshot: await this.custom.get(request.toolId) }
    if (request.operation === 'toolkit.script') return { operation: request.operation, script: this.custom.script(request.toolId) }
    if (request.operation === 'toolkit.run') return { operation: request.operation, snapshot: await this.custom.run(request.toolId, request.input, signal) }
    if (request.operation === 'toolkit.stop') {
      if (request.executionId === undefined) throw new AgentMuxError('Stop requires a captured execution identity.', 'INVALID_CONTROL_REQUEST')
      return { operation: request.operation, snapshot: await this.custom.stop(request.toolId, request.executionId) }
    }
    throw new AgentMuxError('Watch requires the subscription port.', 'INVALID_CONTROL_REQUEST')
  }
  async subscribe(toolId: string, snapshot: (value: ToolkitSnapshot) => void, end: (error?: Error) => void, signal: AbortSignal) {
    return toolId === 'performance' ? await this.performance.subscribe('performance', snapshot, end, signal)
      : await this.custom.subscribe(toolId, snapshot, end, signal)
  }
  async dispose(): Promise<void> { await Promise.all([this.performance.dispose(), this.custom.dispose()]) }
}
