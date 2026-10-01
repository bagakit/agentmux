import { createHash, randomUUID } from 'node:crypto'
import { AgentMuxError, type AgentMuxClientEvent, type AgentMuxRunAttachment } from '@agentmux/core'
import { parseToolkitSnapshot, parseToolkitRunInput, parseToolkitActionInput, TOOLKIT_TEXT_MAX_BYTES, TOOLKIT_TEXT_MAX_JSON_BYTES,
  type ToolkitAdmission, type ToolkitConfirmedResult, type ToolkitRunInput,
  type ToolkitExecution, type ToolkitScriptSnapshot, type ToolkitToolDefinition } from '@agentmux/core/control'
import type { ConfigOwner } from './config-owner.js'
import { findToolkitTool, toolkitTools } from './toolkit-config.js'
import type { ToolkitRunPort } from './toolkit-run-port.js'
import type { ToolkitReceiptStore } from './toolkit-receipt-store.js'

type Lease = { snapshot(value: ToolkitScriptSnapshot): void; end(error?: Error): void; release(): void }
type Tool = { id: string; loading: Promise<void> | null; latest: ToolkitConfirmedResult | null; admission: ToolkitAdmission | null
  error: string | null; sequence: number; leases: Set<Lease>; live: Execution | null }
type Execution = { tool: Tool; admission: ToolkitAdmission; port: ToolkitRunPort | null; cursor: number; rawBytes: number
  decoder: TextDecoder; replayText: string | null; failure: string | null; creating: boolean; attaching: boolean; ended: boolean; stopRequested: boolean
  terminalHint: boolean; uncertain: boolean; done: Promise<void>; complete(): void
  finishing: Promise<void> | null; starting: Promise<void> | null }
type Receipt = { latestConfirmed: ToolkitConfirmedResult | null; admission: ToolkitAdmission | null }
// A code unit may cost six JSON bytes; leave room for the fixed owner explanation.
const message = (error: unknown) => String(error instanceof Error ? error.message : error).slice(0, 512)
const ref = (execution: Execution) => {
  if (!execution.admission.run) throw new AgentMuxError('Tool Run identity is unconfirmed.', 'CONTROL_UNAVAILABLE')
  return { runId: execution.admission.run.runId }
}

/** User scripts share the existing RawRun port; closing a reader never changes execution admission. */
export class CustomToolkitOwner {
  private readonly tools = new Map<string, Tool>()
  private closed = false
  constructor(private readonly args: { config: ConfigOwner; receipts: Pick<ToolkitReceiptStore, 'read' | 'save'>
    openRunPort(): Promise<ToolkitRunPort>; runner: string; env: Record<string, string>; now?: () => number }) {}
  private now() { return (this.args.now ?? Date.now)() }
  private definition(id: string) { return findToolkitTool(this.args.config.current, id) }
  private current(tool: Tool): ToolkitScriptSnapshot {
    const definition = this.definition(tool.id)
    return structuredClone({ schema: 'agentmux.toolkit.v1', kind: 'script', toolId: tool.id, definition,
      state: tool.error ? 'unknown' : tool.admission?.state ?? (!definition.enabled ? 'disabled' : tool.latest?.state ?? 'idle'),
      reason: tool.error ?? tool.admission?.reason ?? tool.latest?.reason ?? null, admission: tool.admission,
      latestConfirmed: tool.latest, consumerCount: tool.leases.size, sequence: tool.sequence })
  }
  private publish(tool: Tool) {
    tool.sequence++
    if (!tool.leases.size) return
    const value = this.current(tool)
    for (const lease of [...tool.leases]) try { lease.snapshot(value) } catch { lease.release() }
  }
  configurationChanged() {
    const ids = new Set(toolkitTools(this.args.config.current).map(tool => tool.id))
    for (const [id, tool] of this.tools) {
      if (ids.has(id)) { if (tool.leases.size) this.publish(tool); continue }
      if (tool.admission) continue
      for (const lease of [...tool.leases]) {
        lease.release()
        try { lease.end(new AgentMuxError('Tool was removed.', 'SETTING_RESOURCE_NOT_FOUND')) } catch {}
      }
      this.tools.delete(id)
    }
  }
  private async load(id: string): Promise<Tool> {
    this.definition(id)
    let tool = this.tools.get(id)
    if (!tool) {
      tool = { id, loading: null, latest: null, admission: null, error: null, sequence: 0, leases: new Set(), live: null }
      this.tools.set(id, tool)
    }
    const value = tool
    if (!value.loading) value.loading = (async () => {
      try {
        const receipt = await this.args.receipts.read(id)
        if (receipt === null) return
        if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) || Object.keys(receipt).sort().join() !== 'admission,latestConfirmed') {
          throw new AgentMuxError('Tool receipt is invalid.', 'CONTROL_PROTOCOL_ERROR')
        }
        const saved = receipt as Receipt
        const parsed = parseToolkitSnapshot({ ...this.current(value), admission: saved.admission,
          latestConfirmed: saved.latestConfirmed, state: saved.admission?.state ?? saved.latestConfirmed?.state ?? 'idle' })
        if (parsed.kind !== 'script') throw new AgentMuxError('Tool receipt has another kind.', 'CONTROL_PROTOCOL_ERROR')
        value.latest = parsed.latestConfirmed; value.admission = parsed.admission
        if (value.admission) value.admission = { ...value.admission, state: 'unknown', reason: 'Execution restored; exact Run outcome needs confirmation.' }
      } catch (error) { value.error = 'Tool receipt is unconfirmed: ' + message(error) }
    })()
    await value.loading
    this.definition(id)
    return value
  }
  async guardDelete(id: string): Promise<void> {
    const tool = await this.load(id)
    if (tool.error || tool.admission) throw new AgentMuxError(`Tool “${id}” has an in-use or unconfirmed execution.`, 'SETTING_RESOURCE_IN_USE')
  }
  async get(id: string): Promise<ToolkitScriptSnapshot> {
    const tool = await this.load(id)
    if (!tool.error && tool.admission?.run && !tool.live && !this.closed) await this.recover(tool)
    return this.current(tool)
  }
  script(id: string) {
    const definition = this.definition(id)
    return { toolId: id, path: null, sha256: createHash('sha256').update(definition.script).digest('hex'), text: definition.script }
  }
  private execution(tool: Tool, admission: ToolkitAdmission): Execution {
    let complete!: () => void
    const done = new Promise<void>(resolve => { complete = resolve })
    return { tool, admission, port: null, cursor: 0, rawBytes: 0, decoder: new TextDecoder('utf-8', { fatal: true }), replayText: null,
      failure: null, creating: false, attaching: false, ended: false, stopRequested: false, terminalHint: false, uncertain: false,
      done, complete, finishing: null, starting: null }
  }
  private receipt(tool: Tool): Receipt { return structuredClone({ latestConfirmed: tool.latest, admission: tool.admission }) }
  private async save(tool: Tool): Promise<void> { await this.args.receipts.save(tool.id, this.receipt(tool)) }
  private unknown(execution: Execution, error: unknown) {
    if (execution.tool.live !== execution) return
    execution.uncertain = true
    execution.complete()
    execution.admission.state = 'unknown'; execution.admission.reason = message(error)
    this.publish(execution.tool)
  }
  private savedAction(definition: ToolkitToolDefinition, id: string) {
    const action = definition.actions?.find(action => action.id === id)
    if (!action) throw new AgentMuxError('Action does not exist in the saved tool configuration.', 'SETTING_RESOURCE_NOT_FOUND')
    return action
  }
  private repeat(tool: Tool, input: ToolkitRunInput, action: NonNullable<ToolkitExecution['action']> | null): boolean {
    const fact = tool.admission?.invocationId === input.invocationId ? tool.admission
      : tool.latest?.invocationId === input.invocationId ? tool.latest : null
    if (!fact) return false
    const sameAction = action === null ? fact.action == null : fact.action != null && fact.action.id === action.id &&
      fact.action.sourceExecutionId === action.sourceExecutionId && fact.action.expectedAdmissionExecutionId === action.expectedAdmissionExecutionId
    if (fact.definition.revision !== input.expectedRevision || fact.expectedLatestExecutionId !== input.expectedLatestExecutionId ||
        !sameAction || (action !== null && tool.admission !== null && fact !== tool.admission)) {
      throw new AgentMuxError('Invocation belongs to another captured request.', 'CONFIG_CONFLICT')
    }
    return true
  }
  async run(id: string, rawInput: unknown, signal: AbortSignal): Promise<ToolkitScriptSnapshot> {
    return await this.admit(id, parseToolkitRunInput(rawInput), null, signal)
  }
  async action(id: string, actionId: string, rawInput: unknown, signal: AbortSignal): Promise<ToolkitScriptSnapshot> {
    const input = parseToolkitActionInput(rawInput)
    return await this.admit(id, { invocationId: input.invocationId, expectedRevision: input.expectedRevision,
      expectedLatestExecutionId: input.sourceExecutionId }, { id: actionId, sourceExecutionId: input.sourceExecutionId,
      expectedAdmissionExecutionId: input.expectedAdmissionExecutionId }, signal)
  }
  private async admit(id: string, input: ToolkitRunInput, action: NonNullable<ToolkitExecution['action']> | null, signal: AbortSignal): Promise<ToolkitScriptSnapshot> {
    const tool = await this.load(id)
    let execution: Execution | null = null
    await this.args.config.inspect(current => {
      if (signal.aborted) throw new AgentMuxError('Tool admission cancelled.', 'CONTROL_CANCELLED')
      if (this.closed) throw new AgentMuxError('Toolkit owner is closed.', 'CONTROL_UNAVAILABLE')
      const definition = findToolkitTool(current, id)
      if (definition.revision !== input.expectedRevision) throw new AgentMuxError('Tool configuration changed; inspect it before running.', 'CONFIG_CONFLICT')
      if (this.repeat(tool, input, action)) return
      if (action && (!tool.latest || tool.latest.definition.revision !== definition.revision ||
          tool.latest.target.workspacePath !== definition.workspacePath || tool.latest.executionId !== action.sourceExecutionId ||
          (tool.admission?.executionId ?? null) !== action.expectedAdmissionExecutionId)) {
        throw new AgentMuxError('Action result, configuration or target changed; inspect it before acting.', 'CONFIG_CONFLICT')
      }
      if (tool.error || tool.admission) throw new AgentMuxError('Tool has an in-use or unconfirmed execution.', 'SETTING_RESOURCE_IN_USE')
      const latest = tool.latest?.executionId ?? null
      if (latest !== input.expectedLatestExecutionId) throw new AgentMuxError('Tool result changed; inspect it before running.', 'CONFIG_CONFLICT')
      if (!definition.enabled) throw new AgentMuxError('Tool is disabled.', 'CONTROL_UNAVAILABLE')
      if (action) this.savedAction(definition, action.id)
      const admission: ToolkitAdmission = { executionId: randomUUID(), invocationId: input.invocationId,
        definition: structuredClone(definition), expectedLatestExecutionId: input.expectedLatestExecutionId, action,
        target: { workspacePath: definition.workspacePath }, run: null, startedAt: this.now(), text: '', state: 'pending', reason: null }
      tool.admission = admission
      execution = this.execution(tool, admission); tool.live = execution
      const admitted = execution
      // Register the entire admitted work before any durable wait, so disposal cannot return ahead of a late create.
      admitted.starting = Promise.resolve().then(async () => {
        try { await this.save(tool) }
        catch (error) { this.unknown(admitted, 'Tool admission save is unconfirmed: ' + message(error)); throw error }
        if (this.closed) await this.confirm(admitted, 'stopped', 'Owner closed before the script started.', null)
        else await this.start(admitted)
      }).finally(() => { admitted.starting = null })
      void admitted.starting.catch(() => {}) // The original caller still receives the rejection below.
      this.publish(tool)
    })
    if (!execution) return this.current(tool)
    const admitted = execution as Execution
    await admitted.starting
    return this.current(tool)
  }
  private async start(execution: Execution): Promise<void> {
    try {
      execution.port = await this.args.openRunPort()
      if (this.closed) { await this.confirm(execution, 'stopped', 'Owner closed before the script started.', null); return }
      execution.creating = true
      const definition = execution.admission.definition
      const program = execution.admission.action ? this.savedAction(definition, execution.admission.action.id) : definition
      const run = await execution.port.create({ createOperationId: execution.admission.executionId,
        workspacePath: definition.workspacePath, command: this.args.runner,
        args: ['--input-type=module', '--eval', program.script, '--', ...program.args], env: this.args.env, cols: 80, rows: 24 },
        event => this.accept(execution, event))
      execution.admission.run = { hostId: 'local', runId: run.runId }; execution.creating = false
      await this.save(execution.tool)
      const attached = await this.attach(execution)
      if (execution.ended || execution.tool.live !== execution || execution.uncertain) return
      if (attached.run.state !== 'running') await this.finish(execution, attached)
      else if (execution.stopRequested || execution.failure) await this.stop(execution.tool.id, execution.admission.executionId)
      else { execution.admission.state = 'running'; this.publish(execution.tool) }
    } catch (error) {
      if (execution.creating || execution.admission.run) this.unknown(execution, error)
      else await this.confirm(execution, 'failed', 'Tool preparation failed: ' + message(error), null)
    }
  }
  private async recover(tool: Tool): Promise<void> {
    const execution = this.execution(tool, tool.admission!); tool.live = execution
    execution.replayText = ''
    // The entire attachment attempt belongs to this owner, including failed-attempt release.
    execution.starting = Promise.resolve().then(async () => {
      try {
        execution.port = await this.args.openRunPort()
        const attached = await this.attach(execution)
        if (execution.ended || tool.live !== execution || execution.uncertain) return
        if (attached.run.state !== 'running') await this.finish(execution, attached)
        else if (execution.failure || execution.stopRequested) await this.stop(tool.id, execution.admission.executionId)
        else { execution.admission.state = 'running'; execution.admission.reason = null; this.publish(tool) }
      } catch (error) {
        this.unknown(execution, error)
        if (execution.port && execution.admission.run) {
          try { await execution.port.release(ref(execution)) }
          catch (releaseError) { this.unknown(execution, message(error) + '; recovery attachment release is unconfirmed: ' + message(releaseError)) }
        }
        if (tool.live === execution) tool.live = null
      }
    }).finally(() => { execution.starting = null })
    await execution.starting
  }
  private async attach(execution: Execution): Promise<AgentMuxRunAttachment> {
    execution.attaching = true
    try {
      let attached = await execution.port!.attach(ref(execution), 0, event => this.accept(execution, event))
      this.snapshot(execution, attached)
      if (execution.terminalHint && attached.run.state === 'running') {
        execution.terminalHint = false
        attached = await execution.port!.replay(ref(execution), execution.cursor)
        this.snapshot(execution, attached)
      }
      execution.terminalHint = false
      this.restoreText(execution, attached)
      return attached
    } finally { execution.attaching = false }
  }
  private restoreText(execution: Execution, attached: AgentMuxRunAttachment) {
    if (execution.replayText === null) return
    if (execution.cursor < attached.run.latestOutputBytes || !execution.replayText.startsWith(execution.admission.text)) {
      throw new AgentMuxError('Recovered output does not confirm the persisted partial text.', 'CONTROL_PROTOCOL_ERROR')
    }
    execution.admission.text = execution.replayText; execution.replayText = null
  }
  private snapshot(execution: Execution, attached: AgentMuxRunAttachment) {
    if (attached.run.runId !== ref(execution).runId || attached.run.kind !== 'terminal') throw new AgentMuxError('Tool attachment returned another Run.', 'CONTROL_PROTOCOL_ERROR')
    if (attached.gap) throw new AgentMuxError('Tool output replay has a Gap.', 'CONTROL_PROTOCOL_ERROR')
    for (const chunk of attached.replay) {
      const failure = execution.failure
      try { this.bytes(execution, chunk.startByte, chunk.endByte, chunk.dataBytes) }
      catch (error) { if (failure || !execution.failure) throw error }
    }
  }
  private accept(execution: Execution, event: AgentMuxClientEvent) {
    if (execution.tool.live !== execution || execution.ended) return
    // The authoritative first attachment replays bytes emitted before create returns its exact identity.
    if (!execution.admission.run) return
    if ('run' in event && event.run?.runId && execution.admission.run && event.run.runId !== execution.admission.run.runId) return
    try {
      if (event.type === 'terminal-output') {
        const range = event.evidence.outputByteRange
        this.bytes(execution, range.startByte, range.endByte, event.dataBytes)
      } else if (event.type === 'terminal-snapshot') {
        if (event.gap) throw new AgentMuxError('Tool output snapshot has a Gap.', 'CONTROL_PROTOCOL_ERROR')
        for (const chunk of event.replay) this.bytes(execution, chunk.startByte, chunk.endByte, chunk.dataBytes)
      } else if (event.type === 'agent-error') throw new AgentMuxError(event.message, 'CONTROL_UNAVAILABLE')
      else if (event.type === 'process-state' && event.state !== 'running' && execution.admission.run) {
        if (execution.creating || execution.attaching) execution.terminalHint = true
        else void this.finish(execution)
      }
    } catch (error) {
      execution.failure = message(error)
      if (execution.port && execution.admission.run) void this.stop(execution.tool.id, execution.admission.executionId).catch(stopError => this.unknown(execution, stopError))
      else this.unknown(execution, error)
    }
  }
  private append(execution: Execution, text: string) {
    const previous = execution.replayText ?? execution.admission.text, combined = previous + text
    if (Buffer.byteLength(combined) > TOOLKIT_TEXT_MAX_BYTES || Buffer.byteLength(JSON.stringify(combined)) > TOOLKIT_TEXT_MAX_JSON_BYTES) {
      const characters = Array.from(text)
      let low = 0, high = characters.length
      while (low < high) {
        const middle = Math.ceil((low + high) / 2), next = previous + characters.slice(0, middle).join('')
        if (Buffer.byteLength(next) <= TOOLKIT_TEXT_MAX_BYTES && Buffer.byteLength(JSON.stringify(next)) <= TOOLKIT_TEXT_MAX_JSON_BYTES) low = middle
        else high = middle - 1
      }
      this.setText(execution, previous + characters.slice(0, low).join(''))
      throw new AgentMuxError('Tool output exceeds its text budget.', 'CONTROL_PROTOCOL_ERROR')
    }
    this.setText(execution, combined)
  }
  private setText(execution: Execution, text: string) {
    if (execution.replayText !== null) execution.replayText = text
    else execution.admission.text = text
  }
  private bytes(execution: Execution, start: number, end: number, bytes: Uint8Array) {
    if (execution.ended || end <= execution.cursor) return
    if (start > execution.cursor || end - start !== bytes.byteLength) throw new AgentMuxError('Tool output is not continuous ordered bytes.', 'CONTROL_PROTOCOL_ERROR')
    const fresh = bytes.subarray(Math.max(0, execution.cursor - start))
    execution.cursor = end; execution.rawBytes += fresh.byteLength
    if (execution.failure) return
    try {
      this.append(execution, execution.decoder.decode(fresh, { stream: true }))
      if (execution.rawBytes > TOOLKIT_TEXT_MAX_BYTES) throw new AgentMuxError('Tool raw output exceeds its byte budget.', 'CONTROL_PROTOCOL_ERROR')
    } catch (error) { execution.failure = message(error); throw error }
    this.publish(execution.tool)
  }
  private async finish(execution: Execution, initial?: AgentMuxRunAttachment): Promise<void> {
    if (execution.ended || execution.tool.live !== execution) return
    if (execution.finishing) return await execution.finishing
    execution.finishing = (async () => {
      try {
        const final = initial ?? await execution.port!.replay(ref(execution), execution.cursor)
        this.snapshot(execution, final)
        if (final.run.state === 'running') return
        if (execution.cursor !== final.run.latestOutputBytes) throw new AgentMuxError('Tool terminal output is incomplete.', 'CONTROL_PROTOCOL_ERROR')
        if (!execution.failure) {
          try { this.append(execution, execution.decoder.decode()) }
          catch (error) { execution.failure = message(error) }
        }
        this.restoreText(execution, final)
        const state = execution.failure ? 'failed' : execution.stopRequested ? 'stopped' : final.run.exitCode === 0 ? 'succeeded' : 'failed'
        const reason = execution.failure ?? (state === 'succeeded' ? null : state === 'stopped' ? 'Stopped explicitly.' : 'Script exited unsuccessfully.')
        await this.confirm(execution, state, reason, final.run.exitCode ?? null)
      } catch (error) { this.unknown(execution, error) }
    })().finally(() => { execution.finishing = null })
    return await execution.finishing
  }
  private async confirm(execution: Execution, state: ToolkitConfirmedResult['state'], reason: string | null, exitCode: number | null) {
    const tool = execution.tool, { state: _state, reason: _reason, ...captured } = execution.admission
    const confirmed: ToolkitConfirmedResult = tool.latest?.executionId === execution.admission.executionId ? tool.latest
      : { ...captured, state, reason, endedAt: this.now(), exitCode }
    // Publishing success before durable acknowledgement would discard the old confirmed fact on save failure.
    try {
      await this.args.receipts.save(tool.id, { latestConfirmed: confirmed, admission: execution.admission })
      tool.latest = confirmed; execution.ended = true
      execution.admission.state = 'stopping'; execution.admission.reason = 'Result confirmed; exact Run cleanup pending.'
      this.publish(tool)
      if (execution.port && execution.admission.run) {
        await execution.port.release(ref(execution))
        await execution.port.remove(ref(execution))
      }
      await this.args.receipts.save(tool.id, { latestConfirmed: confirmed, admission: null })
      tool.admission = null; tool.live = null; execution.complete(); this.publish(tool)
    } catch (error) { execution.ended = false; this.unknown(execution, 'Tool result or cleanup is unconfirmed: ' + message(error)) }
  }
  async stop(id: string, executionId: string | null): Promise<ToolkitScriptSnapshot> {
    const tool = await this.load(id)
    if (tool.admission?.executionId !== executionId && !(tool.admission === null && executionId === null)) {
      throw new AgentMuxError('Tool execution changed; stop targets one captured execution.', 'CONFIG_CONFLICT')
    }
    if (!tool.admission) return this.current(tool)
    if (tool.admission.run && !tool.live && !this.closed) {
      await this.recover(tool)
      if (!tool.admission && tool.latest?.executionId === executionId) return this.current(tool)
      if (tool.admission?.executionId !== executionId) throw new AgentMuxError('Tool execution changed during recovery.', 'CONFIG_CONFLICT')
    }
    const execution = tool.live
    if (!execution?.port || !tool.admission.run) throw new AgentMuxError('Tool Run identity is unconfirmed.', 'CONTROL_UNAVAILABLE')
    execution.stopRequested = true; execution.admission.state = 'stopping'; this.publish(tool)
    await execution.port.stop(ref(execution))
    await this.finish(execution)
    // Core Stop releases the old attachment. Its receipt may precede terminal metadata;
    // retain observation of this same Run rather than losing the later authoritative exit.
    if (tool.live === execution && !execution.ended && execution.admission.state === 'stopping') {
      const attached = await this.attach(execution)
      if (attached.run.state !== 'running') await this.finish(execution, attached)
    }
    return this.current(tool)
  }
  async subscribe(id: string, snapshot: Lease['snapshot'], end: Lease['end'], signal: AbortSignal) {
    if (signal.aborted || this.closed) throw new AgentMuxError('Tool reader cancelled or closed.', 'CONTROL_CANCELLED')
    const tool = await this.load(id)
    if (!tool.error && tool.admission?.run && !tool.live && !this.closed) await this.recover(tool)
    if (signal.aborted || this.closed) throw new AgentMuxError('Tool reader cancelled or closed during establishment.', 'CONTROL_CANCELLED')
    let released = false
    const lease: Lease = { snapshot, end, release: () => {
      if (released) return
      released = true; tool.leases.delete(lease); signal.removeEventListener('abort', lease.release)
    } }
    tool.leases.add(lease); signal.addEventListener('abort', lease.release, { once: true })
    if (signal.aborted) lease.release()
    if (!released) {
      try { snapshot(this.current(tool)) } catch (error) { lease.release(); throw error }
    }
    return { dispose: lease.release }
  }
  async dispose(): Promise<void> {
    this.closed = true
    for (const tool of this.tools.values()) {
      for (const lease of [...tool.leases]) { lease.release(); try { lease.end() } catch {} }
      const execution = tool.live
      if (!execution) continue
      execution.stopRequested = true
      if (execution.starting) {
        try { await execution.starting } catch (error) { this.unknown(execution, error) }
      }
      if (execution && !execution.ended && execution.admission.run && execution.port) {
        try { await this.stop(tool.id, execution.admission.executionId) }
        catch (error) { this.unknown(execution, error) }
      }
      if (execution.finishing) await execution.finishing
      if (!execution.uncertain) await execution.done
    }
  }
}
