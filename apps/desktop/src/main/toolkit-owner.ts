import { parseToolkitSnapshot } from '@agentmux/core/toolkit'
import { parseToolkitResultDocument } from '@agentmux/core/toolkit-result-document'
import { openToolkitResultChannel } from '@agentmux/core/toolkit-result-channel'
import { mintObjectId } from '@agentmux/core/object-id'
import { dirname, join } from 'node:path'
import { AgentMuxError, DurableWriteError, type AgentMuxClientEvent, type AgentMuxRunRef } from '@agentmux/core'
import { AGENTMUX_CONTROL_MAX_MESSAGE_BYTES, parseMetricsObservation, AGENTMUX_CONTROL_REQUEST_TIMEOUT_MS, type AgentMuxToolkitPort,
  type ToolkitRequest, type ToolkitResult, type ToolkitSnapshot, type ToolkitMetricsSnapshot,
} from '@agentmux/core/control'
import { ToolkitFailureCapture, toolkitFailureError, parseToolkitPerformanceFailureDetails,
  type ToolkitPerformanceIssue, type ToolkitPerformanceFailure, type ToolkitPerformanceFailureDetails, type ToolkitPerformanceFailureStage } from '@agentmux/core/toolkit-performance-failure'
import { readPerformanceScript, type PerformanceLaunch } from './toolkit-asset.js'
import { bundledToolkitTools, bundledToolkitScript } from './toolkit-bundled.js'
import type { ToolkitRunPort } from './toolkit-run-port.js'
import { CustomToolkitOwner } from './toolkit-custom-owner.js'
import { executeToolkitConfig, prepareToolkitConfig, toolkitTools } from './toolkit-config.js'
import type { ConfigOwner } from './config-owner.js'
import type { AppConfig } from '../shared/contracts.js'
import { ToolkitReceiptStore } from './toolkit-receipt-store.js'
import { PerformanceFailureStore } from './toolkit-performance-failure-store.js'
import { readToolkitPackageMetadata } from './toolkit-package.js'

type Lease = { includeFailureEvidence: boolean; snapshot(value: ToolkitSnapshot): void; end(error?: Error): void; release(): void }
type Execution = { id: string; ref: AgentMuxRunRef | null; port: ToolkitRunPort | null; ended: boolean
  creationPending: boolean; admissionSaved: boolean; receiptUnconfirmed: boolean; cleanupConfirmed: boolean
  captureFailure: boolean; stage: ToolkitPerformanceFailureStage; frame: ToolkitFailureCapture | null
  failureDetails: ToolkitPerformanceFailureDetails | null; frameStart: number
  channel: Awaited<ReturnType<typeof openToolkitResultChannel>> | null; runReady: Promise<void>; ready(): void
  drainTimer: ReturnType<typeof setTimeout> | null
  exit: { code: number | null; signal: string | null } | null
  terminalCursor: number; terminalCapture: ToolkitFailureCapture | null
  lastAppObservedAt: number | null; cursor: number; buffer: string; decoder: TextDecoder; sequence: number }
type PerformanceReceipt = { schema: 'agentmux.performance.receipt.v1'; admission:
  (Pick<ToolkitMetricsSnapshot, 'executionId' | 'run' | 'reason' | 'startedAt'>) | null }
/** Observation state only. Core/ctxmux remains the sole Run and process owner. */
export class PerformanceToolkitOwner implements AgentMuxToolkitPort {
  private readonly leases = new Set<Lease>()
  private manual = false
  private closed = false
  private starting: Promise<void> | null = null
  private stopping: Promise<void> | null = null
  private loaded: Promise<void> | null = null
  private execution: Execution | null = null
  private failure: ToolkitPerformanceFailure | null = null
  private value: ToolkitMetricsSnapshot = { schema: 'agentmux.toolkit.v1', kind: 'metrics', toolId: 'performance', executionId: null,
    run: null, state: 'idle', reason: null, startedAt: null, observedAt: null, observation: null,
    document: null, diagnostics: { captureEnabled: false, failureEvidence: 'none', droppedWrites: 0, lastFailure: null, persistence: 'not-requested', issue: null, cleanupIssue: null }, manual: false, consumerCount: 0, sequence: 0, trend: [] }
  constructor(private readonly args: { openRunPort(): Promise<ToolkitRunPort>; launch(): PerformanceLaunch
    enabled(): boolean; failures?: Pick<PerformanceFailureStore, 'read' | 'save'>; receipts: Pick<ToolkitReceiptStore, 'read' | 'save'>; mainPid?: number; now?: () => number }) {}
  get current(): ToolkitMetricsSnapshot { return this.snapshot() }
  private snapshot(includeFailureEvidence = false): ToolkitMetricsSnapshot {
    const retained = this.failure !== null && this.hasFailureEvidence(this.failure) ||
      this.value.diagnostics.issue?.message != null || this.value.diagnostics.cleanupIssue?.message != null ||
      this.value.diagnostics.output?.terminal != null || this.value.diagnostics.output?.stderr != null
    const safeIssue = (issue: ToolkitPerformanceIssue | null) => issue === null ? null : { ...issue, message: null }
    const diagnostics = { ...this.value.diagnostics,
      lastFailure: includeFailureEvidence ? this.failure : this.value.diagnostics.lastFailure,
      issue: includeFailureEvidence ? this.value.diagnostics.issue : safeIssue(this.value.diagnostics.issue),
      cleanupIssue: includeFailureEvidence ? this.value.diagnostics.cleanupIssue : safeIssue(this.value.diagnostics.cleanupIssue),
      ...(this.value.diagnostics.output ? { output: includeFailureEvidence ? this.value.diagnostics.output :
        { ...this.value.diagnostics.output, terminal: null, stderr: null } } : {}),
      failureEvidence: retained ? (includeFailureEvidence ? 'included' as const : 'retained' as const) : 'none' as const }
    return structuredClone({ ...this.value, diagnostics, manual: this.manual, consumerCount: this.leases.size })
  }
  private hasFailureEvidence(failure: ToolkitPerformanceFailure) {
    return failure.details.bytes !== null || failure.details.error.stack !== null || failure.details.error.message !== null || (failure.details.diagnosticOutput?.length ?? 0) > 0
  }
  private safeFailure(failure: ToolkitPerformanceFailure): ToolkitPerformanceFailure {
    return { ...failure, details: { ...failure.details, bytes: null, ...(failure.details.diagnosticOutput ? { diagnosticOutput: [] } : {}), error: { ...failure.details.error, message: null, stack: null } } }
  }
  private publish() {
    let safe: ToolkitMetricsSnapshot | undefined, evidence: ToolkitMetricsSnapshot | undefined
    for (const lease of [...this.leases]) {
      try { lease.snapshot(lease.includeFailureEvidence ? (evidence ??= this.snapshot(true)) : (safe ??= this.current)) }
      catch { lease.release() }
    }
  }
  private issue(operation: ToolkitPerformanceIssue['operation'], error: unknown): ToolkitPerformanceIssue {
    const { message, code } = toolkitFailureError(error)
    return { operation, message, code, phase: error instanceof DurableWriteError ? error.phase : null }
  }
  private wanted() { return !this.closed && (this.manual || this.leases.size > 0) }
  private newExecution(id: string): Execution {
    let ready!: () => void
    const runReady = new Promise<void>(resolve => { ready = resolve })
    return { id, ref: null, port: null, ended: false, creationPending: false, admissionSaved: false,
      receiptUnconfirmed: false, cleanupConfirmed: false, captureFailure: false, stage: 'launch', frame: null,
      channel: null, runReady, ready, drainTimer: null, exit: null, terminalCursor: 0, terminalCapture: null,
      failureDetails: null, frameStart: 0, lastAppObservedAt: null,
      cursor: 0, buffer: '', decoder: new TextDecoder('utf-8', { fatal: true }), sequence: 0 }
  }
  private async load(): Promise<void> {
    if (!this.loaded) this.loaded = (async () => {
      void this.loadFailure()
      try {
        const receipt = await this.args.receipts.read('performance') as PerformanceReceipt | null
        if (receipt === null) return
        if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) ||
          receipt.schema !== 'agentmux.performance.receipt.v1' || Object.keys(receipt).sort().join() !== 'admission,schema') {
          throw new AgentMuxError('Performance receipt is invalid.', 'CONTROL_PROTOCOL_ERROR')
        }
        if (receipt.admission === null) return
        const admission = receipt.admission
        if (!admission || typeof admission !== 'object' || Array.isArray(admission) ||
          Object.keys(admission).sort().join() !== 'executionId,reason,run,startedAt') {
          throw new AgentMuxError('Performance admission is invalid.', 'CONTROL_PROTOCOL_ERROR')
        }
        const value = parseToolkitSnapshot({ ...this.value, ...admission, state: 'unknown' })
        if (value.kind !== 'metrics' || value.executionId === null || value.startedAt === null ||
          (value.run !== null && value.run.hostId !== 'local')) {
          throw new AgentMuxError('Performance admission identity is invalid.', 'CONTROL_PROTOCOL_ERROR')
        }
        const execution = this.newExecution(value.executionId)
        execution.ref = value.run === null ? null : { runId: value.run.runId }
        execution.creationPending = execution.ref === null
        execution.admissionSaved = true; execution.ended = true
        this.execution = execution
        this.value = { ...value, reason: value.reason ?? 'Previous Performance execution outcome needs confirmation.' }
      } catch (error) {
        this.value.state = 'unknown'
        this.value.reason = 'Performance admission is unconfirmed: ' + String(error instanceof Error ? error.message : error).slice(0,4000)
      }
    })()
    return await this.loaded
  }
  private failureLoaded: Promise<void> | null = null
  private loadFailure(): Promise<void> {
    if (!this.failureLoaded) this.failureLoaded = (async () => {
      if (!this.args.failures) return
      try {
        const failure = await this.args.failures.read()
        // A late disk read cannot replace this process's new original failure.
        if (failure && this.failure === null) {
          this.failure = failure
          this.value.diagnostics = { ...this.value.diagnostics, lastFailure: this.safeFailure(failure),
            failureEvidence: this.hasFailureEvidence(failure) ? 'retained' : 'none', persistence: 'observed-on-disk' }
        }
      } catch (error) {
        if (this.failure === null) this.value.diagnostics.issue = this.issue('read-failure', error)
      }
      this.publish()
    })()
    return this.failureLoaded
  }
  private async save(execution: Execution): Promise<void> {
    execution.receiptUnconfirmed = true
    const receipt: PerformanceReceipt = { schema: 'agentmux.performance.receipt.v1', admission: {
      executionId: execution.id, run: execution.ref === null ? null : { hostId: 'local', runId: execution.ref.runId },
      startedAt: this.value.startedAt, reason: this.value.reason } }
    await this.args.receipts.save('performance', receipt)
    execution.admissionSaved = true; execution.receiptUnconfirmed = false
  }
  private allowed(signal: AbortSignal) {
    if (signal.aborted) throw new AgentMuxError('Toolkit consumer cancelled.', 'CONTROL_CANCELLED')
    if (this.closed) throw new AgentMuxError('Toolkit owner closed.', 'CONTROL_UNAVAILABLE')
    if (!this.args.enabled()) throw new AgentMuxError('Performance is disabled.', 'CONTROL_UNAVAILABLE')
  }
  async execute(request: ToolkitRequest, signal: AbortSignal): Promise<ToolkitResult> {
    if (request.operation !== 'toolkit.list' && request.toolId !== 'performance') throw new AgentMuxError('Toolkit tool is unknown.', 'INVALID_CONTROL_REQUEST')
    if (request.operation === 'toolkit.list') return { operation: request.operation, tools: [{ kind: 'metrics', toolId: 'performance', name: 'Performance', readonly: true }] }
    if (request.operation === 'toolkit.script') return { operation: request.operation, script: await readPerformanceScript(this.args.launch()) }
    await this.load()
    if (request.operation === 'toolkit.get') {
      await this.loadFailure()
      return { operation: request.operation, snapshot: this.snapshot(request.includeFailureEvidence === true) }
    }
    if (request.operation === 'toolkit.run') {
      this.allowed(signal)
      if (this.value.state === 'unknown') throw new AgentMuxError('Previous tool outcome is unconfirmed: ' + this.value.reason, 'CONTROL_UNAVAILABLE')
      // Admission is the explicit write. A lost receipt is unknown, not an implicit undo.
      this.manual = true
      await this.ensure()
      return { operation: request.operation, snapshot: this.current }
    }
    if (request.operation === 'toolkit.stop') {
      this.manual = false
      for (const lease of [...this.leases]) { lease.release(); lease.end() }
      await this.quiesce(true)
      return { operation: request.operation, snapshot: this.current }
    }
    throw new AgentMuxError('Watch requires the Toolkit subscription port.', 'INVALID_CONTROL_REQUEST')
  }
  async subscribe(_toolId: 'performance', snapshot: Lease['snapshot'], end: Lease['end'], signal: AbortSignal, options?: { captureFailure?: true; includeFailureEvidence?: true }) {
    await this.load()
    this.allowed(signal)
    let released = false
    const lease: Lease = { includeFailureEvidence: options?.includeFailureEvidence === true, snapshot, end, release: () => {
      if (released) return
      released = true; signal.removeEventListener('abort', lease.release); this.leases.delete(lease)
      this.publish(); void this.quiesce()
    } }
    this.leases.add(lease); signal.addEventListener('abort', lease.release, { once: true })
    if (signal.aborted) lease.release()
    try {
      await this.ensure(options?.captureFailure === true)
      if (!released && !signal.aborted) snapshot(this.snapshot(lease.includeFailureEvidence))
      else lease.release()
      return { dispose: lease.release }
    } catch (error) { lease.release(); throw error }
  }
  private async ensure(captureFailure = false): Promise<void> {
    if (this.stopping) await this.stopping
    if (!this.wanted()) return
    if (this.value.state === 'unknown') throw new AgentMuxError('Previous tool cleanup is unconfirmed: ' + this.value.reason, 'CONTROL_UNAVAILABLE')
    if (this.starting) return await this.starting
    if (this.execution?.ref && !this.execution.ended) return
    let id: string
    do { id = mintObjectId() } while (id === this.value.executionId)
    const execution = this.newExecution(id)
    execution.captureFailure = captureFailure
    this.execution = execution
    this.value = { ...this.value, executionId: execution.id, run: null, state: 'starting', reason: null,
      startedAt: (this.args.now ?? Date.now)(), observation: null, document: null, observedAt: null, sequence: 0, trend: [],
      diagnostics: { ...this.value.diagnostics, captureEnabled: captureFailure, cleanupIssue: null,
        output: { executionId: execution.id, run: null, terminalBytes: 0, stderrBytes: 0, terminalGap: false, terminal: null, stderr: null } } }
    this.publish()
    const work = async () => {
      const launch = this.args.launch()
      execution.stage = 'launch'
      await readPerformanceScript(launch)
      if (!this.wanted() || execution.ended) return
      // Admit durably before acquiring or dispatching the native creation port.
      execution.stage = 'admission'
      await this.save(execution)
      execution.stage = 'run-port'
      const port = await this.args.openRunPort()
      execution.port = port
      if (!this.wanted() || execution.ended) return
      execution.stage = 'result-channel'
      execution.channel = await openToolkitResultChannel({
        onBytes: async bytes => {
          // Kernel socket buffers provide backpressure until Core confirms the original Run.
          await execution.runReady
          if (!execution.ended && this.execution === execution) {
            try { this.bytes(execution, execution.cursor, execution.cursor + bytes.length, bytes) }
            catch (error) { this.fail(execution, error) }
          }
        },
        onEnd: async () => { await execution.runReady; this.outputEnded(execution) },
        onError: error => { if (!execution.ended) { execution.stage = 'result-channel'; this.fail(execution, error) } }
      })
      if (!this.wanted() || execution.ended) return
      execution.creationPending = true
      execution.stage = 'create'
      const run = await port.create({ createOperationId: execution.id, workspacePath: launch.cwd,
        command: launch.runner, args: [launch.script, launch.cli], env: { ...launch.env, ...execution.channel.env, AGENTMUX_PERFORMANCE_CAPTURE_FAILURE: captureFailure ? '1' : '0' }, cols: 80, rows: 24 },
      event => this.accept(execution, event))
      execution.ref = { runId: run.runId }
      execution.creationPending = false
      this.value.run = { hostId: 'local', runId: run.runId }
      this.value.diagnostics.output!.run = this.value.run
      execution.stage = 'admission'
      await this.save(execution)
      execution.ready()
      if (!this.wanted() || execution.ended) return
      execution.stage = 'attach'
      const attached = await port.attach(execution.ref, 0)
      if (attached.gap) this.value.diagnostics.output!.terminalGap = true
      for (const chunk of attached.replay) this.terminalBytes(execution, chunk.startByte, chunk.endByte, chunk.dataBytes)
      if (!execution.ended) {
        this.value.state = execution.exit ? 'unknown' : 'observing'
        this.publish()
      }
    }
    this.starting = work().catch(async error => {
      execution.ready()
      this.recordFailure(execution, error)
      this.manual = false; execution.ended = true
      this.value.state = execution.creationPending || execution.receiptUnconfirmed ? 'unknown' : 'failed'
      this.value.reason = String(error instanceof Error ? error.message : error).slice(0,4096)
      if (execution.admissionSaved && !execution.receiptUnconfirmed) {
        try { await this.save(execution) }
        catch (saveError) {
          this.value.state = 'unknown'
          this.value.reason = (this.value.reason + '; Performance receipt save is unconfirmed: ' +
            String(saveError instanceof Error ? saveError.message : saveError)).slice(0,4096)
        }
      }
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
        this.terminalBytes(execution, range.startByte, range.endByte, event.dataBytes)
      } else if (event.type === 'terminal-snapshot') {
        execution.stage = 'run-output-order'
        if (event.gap) this.value.diagnostics.output!.terminalGap = true
        for (const chunk of event.replay) this.terminalBytes(execution, chunk.startByte, chunk.endByte, chunk.dataBytes)
      } else if (event.type === 'agent-error') {
        execution.stage = 'run-event'
        const error = new AgentMuxError(event.message, event.code)
        execution.failureDetails = { stage: execution.stage, error: toolkitFailureError(error, execution.captureFailure), bytes: null, exit: null,
          eventOrigin: { source: event.evidence.source, observedAt: event.evidence.observedAt, run: event.evidence.run ?? null } }
        throw error
      } else if (event.type === 'process-state' && event.state !== 'running') {
        execution.exit = { code: event.exitCode ?? null, signal: event.exitSignal ?? null }
        // An exit event may precede the socket's final bytes. Drain that actual
        // stream before deciding its outcome; exit never invents a result frame.
        if (!execution.channel?.connected) this.outputEnded(execution)
        else {
          this.value.state = 'unknown'; this.value.reason = 'Run exited; final Toolkit result-channel bytes are still draining.'; this.publish()
          // A dead producer cannot keep readers observing forever. Use the existing
          // ordinary observation wait budget; expiry reports incomplete/unknown EOF,
          // never a complete result or a new Run. Already received evidence is retained.
          execution.drainTimer ??= setTimeout(() => {
            execution.stage = 'result-channel'
            execution.failureDetails = { stage: execution.stage, error: toolkitFailureError(new AgentMuxError('Run exited but Toolkit result-channel EOF is unconfirmed; final output may be incomplete.', 'CONTROL_TIMEOUT'), execution.captureFailure), bytes: execution.frame?.value ?? null, exit: execution.exit }
            this.fail(execution, new AgentMuxError('Toolkit final output is unconfirmed after Run exit.', 'CONTROL_TIMEOUT'))
          }, AGENTMUX_CONTROL_REQUEST_TIMEOUT_MS)
          execution.drainTimer.unref()
        }
      }
    } catch (error) { this.fail(execution, error) }
  }
  private outputEnded(execution: Execution) {
    if (execution.ended || this.execution !== execution) return
    if (execution.drainTimer) { clearTimeout(execution.drainTimer); execution.drainTimer = null }
    try {
      execution.stage = 'run-output-decode'
      execution.buffer += execution.decoder.decode()
      execution.stage = 'run-output-lf'
      if (execution.buffer.length) throw new AgentMuxError('Tool result channel ended without a complete LF frame.', 'CONTROL_PROTOCOL_ERROR')
      execution.stage = execution.exit ? 'process-exit' : 'result-channel'
      const error = new AgentMuxError(execution.exit ? 'Performance script exited.' : 'Toolkit result channel ended.', 'CONTROL_FAILED')
      execution.failureDetails = { stage: execution.stage, error: toolkitFailureError(error, execution.captureFailure), bytes: null, exit: execution.exit }
      throw error
    } catch (error) { this.fail(execution, error) }
  }
  private terminalBytes(execution: Execution, start: number, end: number, bytes: Uint8Array) {
    if (execution.ended || this.execution !== execution || end <= execution.terminalCursor) return
    const output = this.value.diagnostics.output!
    if (end - start !== bytes.length || start > execution.terminalCursor) { output.terminalGap = true; execution.terminalCapture = null }
    const fresh = bytes.subarray(Math.max(0, execution.terminalCursor - start))
    output.terminalBytes += fresh.length
    if (execution.captureFailure && fresh.length) {
      execution.terminalCapture ??= new ToolkitFailureCapture('toolkit-terminal', Math.max(start, execution.terminalCursor))
      execution.terminalCapture.append(fresh)
      output.terminal = execution.terminalCapture.value
    }
    execution.terminalCursor = end
    this.publish()
  }
  private bytes(execution: Execution, start: number, end: number, bytes: Uint8Array) {
    if (execution.ended || this.execution !== execution || end <= execution.cursor) return
    execution.stage = 'run-output-order'
    if (start > execution.cursor || end - start !== bytes.byteLength) throw new AgentMuxError('Tool output is not continuous ordered bytes.', 'CONTROL_PROTOCOL_ERROR')
    let offset = Math.max(0, execution.cursor - start)
    while (!execution.ended && offset < bytes.length) {
      const lf = bytes.indexOf(10, offset), next = lf < 0 ? bytes.length : lf + 1
      const part = bytes.subarray(offset, next)
      if (execution.captureFailure) {
        execution.frame ??= new ToolkitFailureCapture('toolkit-output', execution.frameStart)
        execution.frame.append(part)
      }
      execution.stage = 'run-output-decode'
      execution.buffer += execution.decoder.decode(part, { stream: true })
      execution.cursor = start + next
      offset = next
      execution.stage = 'run-output-lf'
      if (lf < 0) {
        if (Buffer.byteLength(execution.buffer) > AGENTMUX_CONTROL_MAX_MESSAGE_BYTES) throw new AgentMuxError('Incomplete Toolkit result exceeds budget.', 'CONTROL_PROTOCOL_ERROR')
        continue
      }
      const line = execution.buffer.slice(0, -1).replace(/\r$/u, '')
      execution.buffer = ''
      execution.stage = 'toolkit-json'
      if (Buffer.byteLength(line) > AGENTMUX_CONTROL_MAX_MESSAGE_BYTES) throw new AgentMuxError('Toolkit result exceeds budget.', 'CONTROL_PROTOCOL_ERROR')
      const frame = JSON.parse(line)
      execution.stage = 'toolkit-envelope'
      if (!frame || typeof frame !== 'object' || Array.isArray(frame) || frame.schema !== 'agentmux.toolkit.result.v1') throw new AgentMuxError('Toolkit result schema is invalid.', 'CONTROL_PROTOCOL_ERROR')
      if (frame.event === 'error') {
        if (Object.keys(frame).sort().join() !== 'event,failure,reason,schema') {
          throw new AgentMuxError('Toolkit error envelope is invalid.', 'CONTROL_PROTOCOL_ERROR')
        }
        const details = parseToolkitPerformanceFailureDetails(frame.failure)
        if (typeof frame.reason !== 'string' || frame.reason !== details.error.message ||
          !details.stage.startsWith('cli-') || (!execution.captureFailure && (details.bytes !== null || details.error.stack !== null || (details.diagnosticOutput?.length ?? 0) > 0))) {
          throw new AgentMuxError('Toolkit error origin is invalid.', 'CONTROL_PROTOCOL_ERROR')
        }
        execution.failureDetails = details
        throw new AgentMuxError(frame.reason, 'CONTROL_FAILED')
      }
      if (frame.event !== 'result' || Object.keys(frame).sort().join() !== 'diagnostics,document,event,payload,schema,sequence' ||
        frame.sequence !== execution.sequence + 1) throw new AgentMuxError('Toolkit result sequence or framing is invalid.', 'CONTROL_PROTOCOL_ERROR')
      const diagnostic = frame.diagnostics
      if (!diagnostic || typeof diagnostic !== 'object' || Array.isArray(diagnostic) ||
        Object.keys(diagnostic).sort().join() !== 'stderr,stderrBytes' || !Number.isSafeInteger(diagnostic.stderrBytes) || diagnostic.stderrBytes < 0) {
        throw new AgentMuxError('Toolkit diagnostic output is invalid.', 'CONTROL_PROTOCOL_ERROR')
      }
      if (diagnostic.stderr !== null) {
        const checked = parseToolkitPerformanceFailureDetails({ stage: 'cli-stderr', error: toolkitFailureError('diagnostic', false), bytes: diagnostic.stderr, exit: null })
        if (!execution.captureFailure || checked.bytes!.source !== 'metrics-rpc-stderr' || checked.bytes!.startByte !== 0 || checked.bytes!.endByte !== diagnostic.stderrBytes) {
          throw new AgentMuxError('Toolkit diagnostic source is invalid.', 'CONTROL_PROTOCOL_ERROR')
        }
      }
      this.value.diagnostics.output!.stderrBytes = diagnostic.stderrBytes
      this.value.diagnostics.output!.stderr = diagnostic.stderr
      execution.stage = 'metrics-payload'
      const observation = parseMetricsObservation(frame.payload)
      execution.stage = 'toolkit-document'
      const document = parseToolkitResultDocument(frame.document)
      execution.stage = 'metrics-scope'
      if (observation.scope.mainPid !== (this.args.mainPid ?? process.pid)) throw new AgentMuxError('Tool observation belongs to another Main owner.', 'CONTROL_PROTOCOL_ERROR')
      execution.sequence = frame.sequence
      this.value.observation = observation; this.value.observedAt = observation.observedAt
      this.value.document = document
      this.value.sequence = frame.sequence
      this.value.state = execution.exit ? 'unknown' : 'observing'
      this.value.reason = execution.exit ? 'Run exited; final Toolkit result-channel bytes are still draining.' : null
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
      execution.frame = null; execution.frameStart = execution.cursor
      this.publish()
    }
    if (Buffer.byteLength(execution.buffer) > AGENTMUX_CONTROL_MAX_MESSAGE_BYTES) throw new AgentMuxError('Incomplete Toolkit result exceeds budget.', 'CONTROL_PROTOCOL_ERROR')
  }
  private recordFailure(execution: Execution, error: unknown) {
    if (this.failure?.executionId === execution.id) return
    // Creation callbacks may fail before their receipt. Keep null rather than borrow a nearby Run.
    const failure = { schema: 'agentmux.performance.failure.v1' as const, executionId: execution.id,
      run: execution.ref ? { hostId: 'local', runId: execution.ref.runId } : null, recordedAt: (this.args.now ?? Date.now)(),
      details: execution.failureDetails ?? { stage: execution.stage, error: toolkitFailureError(error, execution.captureFailure),
        bytes: execution.frame?.value ?? null, exit: null } }
    const supplemental = [this.value.diagnostics.output?.terminal, this.value.diagnostics.output?.stderr].filter(value => value != null)
    if (supplemental.length) failure.details = { ...failure.details, diagnosticOutput: [...(failure.details.diagnosticOutput ?? []), ...supplemental].filter((value, index, all) => all.findIndex(other => other.source === value.source) === index).slice(0, 2) }
    this.failure = failure
    this.value.diagnostics = { ...(this.value.diagnostics.output ? { output: this.value.diagnostics.output } : {}), captureEnabled: execution.captureFailure, failureEvidence: this.hasFailureEvidence(failure) ? 'retained' : 'none',
      droppedWrites: this.value.diagnostics.droppedWrites, lastFailure: this.safeFailure(failure),
      persistence: execution.captureFailure && this.args.failures ? 'pending' : 'not-requested', issue: null, cleanupIssue: null }
    if (execution.captureFailure && this.args.failures) {
      const failures = this.args.failures
      void Promise.resolve().then(() => failures.save(failure)).then(() => {
        if (this.failure !== failure) return
        this.value.diagnostics.persistence = 'confirmed'; this.publish()
      }, diagnosticError => {
        if (diagnosticError instanceof AgentMuxError && diagnosticError.code === 'TOOLKIT_DIAGNOSTIC_SUPERSEDED') {
          this.value.diagnostics.droppedWrites++; this.publish()
        }
        if (this.failure !== failure) return
        this.value.diagnostics.persistence = 'unconfirmed'; this.value.diagnostics.issue = this.issue('write-failure', diagnosticError)
        this.publish()
      })
    }
  }
  private fail(execution: Execution, error: unknown) {
    if (execution.ended || this.execution !== execution) return
    this.recordFailure(execution, error)
    if (execution.drainTimer) { clearTimeout(execution.drainTimer); execution.drainTimer = null }
    execution.ended = true; this.manual = false
    this.value.state = 'failed'; this.value.reason = toolkitFailureError(error).message
    this.publish()
    for (const lease of [...this.leases]) { lease.release(); lease.end(new AgentMuxError(this.value.reason, 'CONTROL_FAILED')) }
    void this.quiesce()
  }
  private async quiesce(explicit = false): Promise<void> {
    if (this.starting) { try { await this.starting } catch { /* Cleanup the exact partial creation below. */ } }
    if (this.wanted() && !this.execution?.ended) return
    if (this.stopping) return await this.stopping
    const execution = this.execution
    if (!execution) return
    if ((!execution.ref && execution.creationPending) ||
      (!explicit && (execution.receiptUnconfirmed || this.value.state === 'unknown'))) {
      execution.ready(); await execution.channel?.close(); execution.channel = null
      this.value.state = 'unknown'; this.publish(); return
    }
    if (!execution.ref && !execution.admissionSaved && !execution.receiptUnconfirmed) {
      execution.ended = true; this.execution = null; this.value.run = null; this.value.diagnostics.captureEnabled = false
      if (this.value.state !== 'failed' && this.value.state !== 'unknown') this.value.state = 'paused'
      this.publish(); return
    }
    execution.ended = true
    if (execution.drainTimer) { clearTimeout(execution.drainTimer); execution.drainTimer = null }
    execution.ready()
    const failed = this.value.state === 'failed'
    this.value.state = 'stopping'; this.publish()
    this.stopping = (async () => {
      let operation: ToolkitPerformanceIssue['operation'] = 'close-result-channel'
      try {
        await execution.channel?.close()
        execution.channel = null
        operation = 'open-run-port'
        if (execution.ref) {
          if (!execution.port) execution.port = await this.args.openRunPort()
          if (!execution.cleanupConfirmed) {
            operation = 'stop'
            try { if (execution.exit === null) await execution.port.stop(execution.ref) } finally {
              const primaryOperation = operation
              operation = 'release'
              await execution.port.release(execution.ref)
              operation = primaryOperation
            }
            operation = 'remove'
            await execution.port.remove(execution.ref)
            execution.cleanupConfirmed = true
          }
        }
        execution.receiptUnconfirmed = true
        operation = 'clear-admission'
        await this.args.receipts.save('performance', { schema: 'agentmux.performance.receipt.v1', admission: null } satisfies PerformanceReceipt)
        execution.receiptUnconfirmed = false
        if (this.execution === execution) { this.execution = null; this.value.run = null; this.value.diagnostics.captureEnabled = false; this.value.state = failed ? 'failed' : 'paused' }
      } catch (error) {
        this.value.diagnostics.cleanupIssue = this.issue(operation, error)
        this.value.state = 'unknown'; this.value.reason = 'Tool cleanup is unconfirmed: ' + String(error instanceof Error ? error.message : error).slice(0,4000)
        if (!execution.receiptUnconfirmed) {
          try { await this.save(execution) }
          catch (saveError) { this.value.reason = (this.value.reason + '; receipt save is unconfirmed: ' +
            String(saveError instanceof Error ? saveError.message : saveError)).slice(0,4096) }
        }
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
    const receipts = new ToolkitReceiptStore(args.receiptPath, () => ['performance', ...bundledToolkitTools(args.launch(), args.config.current).map(tool => tool.id), ...toolkitTools(args.config.current).map(tool => tool.id)])
    this.performance = new PerformanceToolkitOwner({ ...args, receipts, failures: new PerformanceFailureStore(join(dirname(args.receiptPath), 'toolkit-performance-failure.json')) })
    const launch = args.launch()
    this.custom = new CustomToolkitOwner({ config: args.config, openRunPort: args.openRunPort,
      runner: launch.runner, env: launch.env, snapshotRoot: join(dirname(args.receiptPath), 'toolkit-snapshots'), bundled: () => bundledToolkitTools(args.launch(), args.config.current), ...(args.now ? { now: args.now } : {}),
      receipts })
  }
  prepareConfig(current: AppConfig, next: AppConfig): Promise<AppConfig> {
    return prepareToolkitConfig(current, next, id => this.custom.guardDelete(id))
  }
  configurationChanged() { this.custom.configurationChanged() }
  async execute(request: ToolkitRequest, signal: AbortSignal): Promise<ToolkitResult> {
    if (request.operation === 'toolkit.list') return { operation: request.operation, tools: [
      { kind: 'metrics', toolId: 'performance', name: 'Performance', readonly: true },
      ...bundledToolkitTools(this.args.launch(), this.args.config.current).map(tool => ({ kind: 'script' as const, toolId: tool.id, name: tool.name, readonly: true, revision: tool.revision, icon: tool.icon, enabled: tool.enabled, statusBar: tool.statusBar })),
      ...await Promise.all(toolkitTools(this.args.config.current).map(async tool => {
        if (!('kind' in tool)) return { kind: 'script' as const, toolId: tool.id, name: tool.name, readonly: false as const,
          revision: tool.revision, icon: tool.icon, enabled: tool.enabled, statusBar: tool.statusBar }
        const base = { kind: 'package' as const, toolId: tool.id, readonly: false as const, configRevision: tool.revision,
          path: tool.packagePath, enabled: tool.enabled, statusBar: tool.statusBar }
        try {
          const metadata = await readToolkitPackageMetadata(tool)
          return { ...base, availability: 'available' as const, name: metadata.manifest.name, icon: metadata.icon, reason: metadata.warning }
        } catch (error) {
          return { ...base, availability: 'unavailable' as const, name: null, icon: null,
            reason: String(error instanceof Error ? error.message : error).slice(0, 512) || 'Package metadata is unavailable.' }
        }
      }))
    ] }
    if (request.operation === 'toolkit.add' || request.operation === 'toolkit.update' || request.operation === 'toolkit.remove') {
      return await executeToolkitConfig(request, this.args.config)
    }
    if (request.toolId === 'performance') return await this.performance.execute(request, signal)
    if (request.operation === 'toolkit.get') return { operation: request.operation, snapshot: await this.custom.get(request.toolId) }
    if (request.operation === 'toolkit.script') return { operation: request.operation, script: bundledToolkitScript(this.args.launch(), request.toolId) ?? await this.custom.script(request.toolId) }
    if (request.operation === 'toolkit.run') return { operation: request.operation, snapshot: await this.custom.run(request.toolId, request.input, signal) }
    if (request.operation === 'toolkit.action') return { operation: request.operation, snapshot: await this.custom.action(request.toolId, request.actionId, request.input, signal) }
    if (request.operation === 'toolkit.stop') {
      if (request.executionId === undefined) throw new AgentMuxError('Stop requires a captured execution identity.', 'INVALID_CONTROL_REQUEST')
      return { operation: request.operation, snapshot: await this.custom.stop(request.toolId, request.executionId) }
    }
    throw new AgentMuxError('Watch requires the subscription port.', 'INVALID_CONTROL_REQUEST')
  }
  async subscribe(toolId: string, snapshot: (value: ToolkitSnapshot) => void, end: (error?: Error) => void, signal: AbortSignal, options?: { captureFailure?: true; includeFailureEvidence?: true }) {
    return toolId === 'performance' ? await this.performance.subscribe('performance', snapshot, end, signal, options)
      : await this.custom.subscribe(toolId, snapshot, end, signal)
  }
  async dispose(): Promise<void> { await Promise.all([this.performance.dispose(), this.custom.dispose()]) }
}
