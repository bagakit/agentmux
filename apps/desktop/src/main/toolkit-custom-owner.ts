import { mintObjectId } from '@agentmux/core/object-id'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { AgentMuxError, type AgentMuxClientEvent, type AgentMuxRunAttachment } from '@agentmux/core'
import { parseToolkitSnapshot, parseToolkitRunInput, parseToolkitActionInput, TOOLKIT_TEXT_MAX_BYTES, TOOLKIT_TEXT_MAX_JSON_BYTES,
  type ToolkitAdmission, type ToolkitConfirmedResult, type ToolkitRunInput,
  type ToolkitExecution, type ToolkitScriptSnapshot, type ToolkitDisplaySnapshot, type ToolkitToolDefinition, type ToolkitToolConfiguration, type ToolkitSnapshot } from '@agentmux/core/control'
import type { AppConfig } from '../shared/contracts.js'
import type { ConfigOwner } from './config-owner.js'
import { findToolkitTool, toolkitTools } from './toolkit-config.js'
import type { ToolkitRunPort } from './toolkit-run-port.js'
import type { ToolkitReceiptStore } from './toolkit-receipt-store.js'
import { captureToolkitPackage, readToolkitPackageSnapshot, writeToolkitPackageSnapshot, removeToolkitPackageSnapshot, type CapturedToolkitPackage } from './toolkit-package.js'

type Lease = { snapshot(value: ToolkitSnapshot): void; end(error?: Error): void; release(): void }
type Tool = { id: string; loading: Promise<void> | null; latest: ToolkitConfirmedResult | null; admission: ToolkitAdmission | null
  error: string | null; sourceError: string | null; definition: ToolkitToolDefinition | null; sequence: number; leases: Set<Lease>; live: Execution | null
  parent: Tool | null; display: Tool | null; displayReaders: number; saving: Promise<void>; successful: ToolkitConfirmedResult | null
  evaluationRequest: Promise<ToolkitSnapshot> | null }
type Execution = { capture: CapturedToolkitPackage | null; tool: Tool; admission: ToolkitAdmission; port: ToolkitRunPort | null; cursor: number; rawBytes: number
  decoder: TextDecoder; replayText: string | null; failure: string | null; creating: boolean; attaching: boolean; ended: boolean; stopRequested: boolean
  terminalHint: boolean; uncertain: boolean; done: Promise<void>; complete(): void
  finishing: Promise<'running' | void> | null; starting: Promise<void> | null; stopSubmission: Promise<void> | null }
type LaneReceipt = { latestConfirmed: ToolkitConfirmedResult | null; admission: ToolkitAdmission | null; lastSucceeded?: ToolkitConfirmedResult }
type Receipt = LaneReceipt & { display?: LaneReceipt }
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
    openRunPort(): Promise<ToolkitRunPort>; runner: string; env: Record<string, string>; snapshotRoot?: string; bundled?: () => ToolkitToolDefinition[]; now?: () => number }) {}
  private now() { return (this.args.now ?? Date.now)() }
  private configurations() { return [...(this.args.bundled?.() ?? []), ...toolkitTools(this.args.config.current)] }
  private configuration(id: string) { return this.configurationFrom(this.args.config.current, id) }
  private configurationFrom(current: AppConfig, id: string) {
    return this.args.bundled?.().find(tool => tool.id === id) ?? findToolkitTool(current, id)
  }
  private newTool(id: string, parent: Tool | null = null): Tool {
    return { id, parent, display: null, displayReaders: 0, saving: Promise.resolve(), successful: null, evaluationRequest: null, loading: null,
      latest: null, admission: null, error: null, sourceError: null, definition: null, sequence: 0, leases: new Set(), live: null }
  }
  private displayTool(tool: Tool): Tool { return tool.display ??= this.newTool(tool.id, tool) }
  private state(tool: Tool, definition: ToolkitToolDefinition) {
    return tool.error || tool.parent && tool.sourceError ? 'unknown' as const : tool.admission?.state ?? (!definition.enabled ? 'disabled' as const : tool.latest?.state ?? 'idle' as const)
  }
  private displaySnapshot(tool: Tool, definition: ToolkitToolDefinition): ToolkitDisplaySnapshot {
    return { state: this.state(tool, definition), reason: tool.error ?? tool.sourceError ?? tool.admission?.reason ?? tool.latest?.reason ?? null,
      admission: tool.admission, latestConfirmed: tool.latest, sequence: tool.sequence,
      ...(tool.successful && tool.latest?.state !== 'succeeded' ? { lastSucceeded: tool.successful } : {}) }
  }
  private scriptSnapshot(tool: Tool, definition: ToolkitToolDefinition): ToolkitScriptSnapshot {
    const display = definition.display || tool.display?.admission || tool.display?.latest || tool.display?.error
      ? this.displaySnapshot(this.displayTool(tool), definition) : undefined
    return structuredClone({ schema: 'agentmux.toolkit.v1', kind: 'script', toolId: tool.id, definition,
      state: this.state(tool, definition),
      reason: tool.error ?? tool.admission?.reason ?? tool.latest?.reason ?? null, admission: tool.admission,
      latestConfirmed: tool.latest, consumerCount: tool.leases.size, sequence: tool.sequence, ...(display ? { display } : {}) })
  }
  /** Output publication consumes captured facts, never the live filesystem. */
  private current(tool: Tool): ToolkitSnapshot {
    tool = tool.parent ?? tool
    const record = this.configuration(tool.id)
    if (!('kind' in record)) return this.scriptSnapshot(tool, record)
    if (!tool.sourceError && tool.definition?.package?.configRevision === record.revision) return this.scriptSnapshot(tool, tool.definition)
    const retained = tool.admission?.definition ?? tool.latest?.definition ?? tool.display?.admission?.definition ??
      tool.display?.latest?.definition ?? tool.display?.successful?.definition
    return structuredClone({ schema: 'agentmux.toolkit.v1', kind: 'package-unavailable', toolId: tool.id,
      configuration: record, reason: tool.sourceError ?? 'Package source has not been inspected.',
      retained: retained ? this.scriptSnapshot(tool, retained) : null })
  }
  private async resolve(tool: Tool): Promise<{ record: ToolkitToolConfiguration | ToolkitToolDefinition; definition: ToolkitToolDefinition; capture: CapturedToolkitPackage | null }> {
    const record = this.configuration(tool.id)
    if (!('kind' in record)) return { record, definition: record, capture: null }
    try {
      const capture = await captureToolkitPackage(record)
      if (this.configuration(tool.id).revision !== record.revision) throw new AgentMuxError('Tool configuration changed while reading its package.', 'CONFIG_CONFLICT')
      tool.definition = capture.definition; tool.sourceError = null
      return { record, definition: capture.definition, capture }
    } catch (error) {
      tool.sourceError = message(error)
      if (error instanceof AgentMuxError && ['CONFIG_CONFLICT', 'SETTING_RESOURCE_NOT_FOUND'].includes(error.code)) throw error
      throw new AgentMuxError('Package source is unavailable: ' + tool.sourceError, 'TOOLKIT_PACKAGE_UNAVAILABLE')
    }
  }
  private publish(tool: Tool) {
    tool.sequence++
    if (tool.parent) { this.publish(tool.parent); return }
    if (!tool.leases.size) return
    const value = this.current(tool)
    for (const lease of [...tool.leases]) try { lease.snapshot(value) } catch { lease.release() }
  }
  configurationChanged() {
    const ids = new Set(this.configurations().map(tool => tool.id))
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
    this.configuration(id)
    let tool = this.tools.get(id)
    if (!tool) {
      tool = this.newTool(id)
      this.tools.set(id, tool)
    }
    const value = tool
    if (!value.loading) value.loading = (async () => {
      try {
        const receipt = await this.args.receipts.read(id)
        if (receipt === null) return
        if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) ||
            !Object.hasOwn(receipt, 'admission') || !Object.hasOwn(receipt, 'latestConfirmed') ||
            Object.keys(receipt).some(key => !['admission', 'latestConfirmed', 'display'].includes(key))) {
          throw new AgentMuxError('Tool receipt is invalid.', 'CONTROL_PROTOCOL_ERROR')
        }
        const saved = receipt as Receipt
        const record = this.configuration(id)
        const definition = saved.admission?.definition ?? saved.latestConfirmed?.definition ??
          saved.display?.admission?.definition ?? saved.display?.latestConfirmed?.definition ?? (!('kind' in record) ? record : null)
        if (!definition) throw new AgentMuxError('Tool receipt has no captured definition.', 'CONTROL_PROTOCOL_ERROR')
        const parsed = parseToolkitSnapshot({ ...this.scriptSnapshot(value, definition), admission: saved.admission,
          latestConfirmed: saved.latestConfirmed, state: saved.admission?.state ?? saved.latestConfirmed?.state ?? 'idle',
          ...(saved.display ? { display: { ...saved.display, state: saved.display.admission?.state ?? saved.display.latestConfirmed?.state ?? 'idle',
            reason: saved.display.admission?.reason ?? saved.display.latestConfirmed?.reason ?? null, sequence: 0 } } : {}) })
        if (parsed.kind !== 'script') throw new AgentMuxError('Tool receipt has another kind.', 'CONTROL_PROTOCOL_ERROR')
        value.latest = parsed.latestConfirmed; value.admission = parsed.admission
        if (value.admission) value.admission = { ...value.admission, state: 'unknown', reason: 'Execution restored; exact Run outcome needs confirmation.' }
        if (parsed.display) {
          const display = this.displayTool(value)
          display.latest = parsed.display.latestConfirmed; display.admission = parsed.display.admission
          display.successful = parsed.display.latestConfirmed?.state === 'succeeded' ? parsed.display.latestConfirmed : parsed.display.lastSucceeded ?? null
          if (display.admission) display.admission = { ...display.admission, state: 'unknown', reason: 'Display evaluation restored; exact Run outcome needs confirmation.' }
        }
      } catch (error) { value.error = 'Tool receipt is unconfirmed: ' + message(error) }
    })()
    await value.loading
    this.configuration(id)
    return value
  }
  async guardDelete(id: string): Promise<void> {
    const tool = await this.load(id)
    if (tool.error || tool.admission || tool.display?.admission || tool.display?.error) throw new AgentMuxError(`Tool “${id}” has an in-use or unconfirmed execution.`, 'SETTING_RESOURCE_IN_USE')
  }
  async get(id: string): Promise<ToolkitSnapshot> {
    const tool = await this.load(id)
    if (!tool.error && tool.admission?.run && !tool.live && !this.closed) await this.recover(tool)
    if (tool.display?.admission?.run && !tool.display.live && !this.closed) await this.recover(tool.display)
    await this.resolve(tool).catch(() => {})
    return this.current(tool)
  }
  async script(id: string) {
    const tool = await this.load(id)
    const { definition } = await this.resolve(tool)
    return { toolId: id, path: definition.package ? join(definition.package.path, definition.package.entry) : null, sha256: createHash('sha256').update(definition.script).digest('hex'), text: definition.script }
  }
  private execution(tool: Tool, admission: ToolkitAdmission): Execution {
    let complete!: () => void
    const done = new Promise<void>(resolve => { complete = resolve })
    return { capture: null, tool, admission, port: null, cursor: 0, rawBytes: 0, decoder: new TextDecoder('utf-8', { fatal: true }), replayText: null,
      failure: null, creating: false, attaching: false, ended: false, stopRequested: false, terminalHint: false, uncertain: false,
      done, complete, finishing: null, starting: null, stopSubmission: null }
  }
  private receipt(tool: Tool, replacement?: { lane: Tool; value: LaneReceipt }): Receipt {
    const facts = (lane: Tool): LaneReceipt => {
      const value = replacement?.lane === lane ? replacement.value : { latestConfirmed: lane.latest, admission: lane.admission }
      return { ...value, ...(lane.parent && lane.successful && value.latestConfirmed?.state !== 'succeeded' ? { lastSucceeded: lane.successful } : {}) }
    }
    return structuredClone({ ...facts(tool), ...(tool.display ? { display: facts(tool.display) } : {}) })
  }
  /** Both lanes share one durable commit queue; one confirmation cannot overwrite the other. */
  private async save(tool: Tool, value?: LaneReceipt, committed?: () => void): Promise<void> {
    const root = tool.parent ?? tool
    const write = root.saving.then(async () => {
      await this.args.receipts.save(root.id, this.receipt(root, value ? { lane: tool, value } : undefined))
      committed?.()
    })
    root.saving = write.catch(() => {})
    await write
  }
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
  async run(id: string, rawInput: unknown, signal: AbortSignal): Promise<ToolkitSnapshot> {
    return await this.admit(id, parseToolkitRunInput(rawInput), null, signal)
  }
  async evaluate(id: string, rawInput: unknown, signal: AbortSignal): Promise<ToolkitSnapshot> {
    const root = await this.load(id), tool = this.displayTool(root)
    if (signal.aborted) throw new AgentMuxError('Display reader cancelled before evaluation.', 'CONTROL_CANCELLED')
    if (rawInput !== undefined) return await this.evaluateLane(root, tool, rawInput, signal)
    if (tool.evaluationRequest) return await tool.evaluationRequest
    // Coalesce before source capture or the admission queue; independent
    // consumers cannot accidentally turn one display intent into two requests.
    const request = Promise.resolve().then(() => this.evaluateLane(root, tool, undefined, new AbortController().signal))
    tool.evaluationRequest = request
    try { return await request } finally { if (tool.evaluationRequest === request) tool.evaluationRequest = null }
  }
  private async evaluateLane(root: Tool, tool: Tool, rawInput: unknown, signal: AbortSignal): Promise<ToolkitSnapshot> {
    const id = root.id
    if (root.error) throw new AgentMuxError(root.error + '; the original receipt is retained unchanged.', 'CONTROL_UNAVAILABLE')
    const pinned = rawInput === undefined ? undefined : parseToolkitRunInput(rawInput)
    if (pinned && tool.admission && !this.repeat(tool, pinned, null)) throw new AgentMuxError('Display evaluation targets another in-use request.', 'CONFIG_CONFLICT')
    if (tool.live?.starting) { await tool.live.starting; return this.current(root) }
    if (tool.admission?.run) {
      if (!tool.live && !this.closed) await this.recover(tool)
      // One evaluation request observes the original admitted Run, even if it
      // finishes while being reattached. It never starts a replacement then.
      return this.current(root)
    }
    if (tool.admission) {
      // Original captured files remain the authority even when the editable
      // package is missing or changed. Do not gate this on a fresh source read.
      return await this.admit(id, pinned ?? { invocationId: tool.admission.invocationId,
        expectedRevision: tool.admission.definition.revision, expectedLatestExecutionId: tool.admission.expectedLatestExecutionId }, null, signal, true)
    }
    const resolved = await this.resolve(root)
    if (tool.live?.starting) { await tool.live.starting; return this.current(root) }
    if (!tool.admission && !resolved.definition.display) throw new AgentMuxError('Tool has no display evaluation entry.', 'SETTING_RESOURCE_NOT_FOUND')
    tool.sourceError = null
    const input = pinned ?? { invocationId: mintObjectId(), expectedRevision: resolved.definition.revision, expectedLatestExecutionId: tool.latest?.executionId ?? null }
    return await this.admit(id, input, null, signal, true)
  }
  async action(id: string, actionId: string, rawInput: unknown, signal: AbortSignal): Promise<ToolkitSnapshot> {
    const input = parseToolkitActionInput(rawInput)
    return await this.admit(id, { invocationId: input.invocationId, expectedRevision: input.expectedRevision,
      expectedLatestExecutionId: input.sourceExecutionId }, { id: actionId, sourceExecutionId: input.sourceExecutionId,
      expectedAdmissionExecutionId: input.expectedAdmissionExecutionId }, signal)
  }
  private async admit(id: string, input: ToolkitRunInput, action: NonNullable<ToolkitExecution['action']> | null, signal: AbortSignal, display = false): Promise<ToolkitSnapshot> {
    const root = await this.load(id), tool = display ? this.displayTool(root) : root
    const repeated = await this.args.config.inspect(current => {
      const record = this.configurationFrom(current, id)
      const fact = tool.admission?.invocationId === input.invocationId ? tool.admission : tool.latest?.invocationId === input.invocationId ? tool.latest : null
      if (fact && fact !== tool.admission && ('kind' in record ? fact.definition.package?.configRevision : fact.definition.revision) !== record.revision) {
        throw new AgentMuxError('Invocation belongs to a previous tool configuration.', 'CONFIG_CONFLICT')
      }
      return this.repeat(tool, input, action)
    })
    if (repeated) {
      // Only an explicit repeat of the complete original request can continue a
      // creation whose reply was lost. Passive get/watch never dispatch create.
      if (!tool.error && tool.admission?.invocationId === input.invocationId && tool.admission.run === null && !this.closed) {
        if (tool.live?.starting) await tool.live.starting
        else if (tool.admission.state === 'unknown') {
          const retained = this.execution(tool, tool.admission)
          tool.live = retained; retained.replayText = ''
          retained.admission.state = 'pending'; retained.admission.reason = 'Continuing the original request.'
          retained.starting = Promise.resolve().then(async () => {
            try { await this.save(tool); await this.start(retained, true) }
            catch (error) { this.unknown(retained, error) }
          }).finally(() => { retained.starting = null })
          this.publish(tool)
          await retained.starting
        }
      }
      return this.current(tool)
    }
    // Filesystem work is outside the configuration commit queue.
    const resolved = await this.resolve(root)
    let execution: Execution | null = null
    await this.args.config.inspect(current => {
      if (signal.aborted) throw new AgentMuxError('Tool admission cancelled.', 'CONTROL_CANCELLED')
      if (this.closed) throw new AgentMuxError('Toolkit owner is closed.', 'CONTROL_UNAVAILABLE')
      const record = this.configurationFrom(current, id), definition = resolved.definition
      if (record.revision !== resolved.record.revision) throw new AgentMuxError('Tool configuration changed during package capture.', 'CONFIG_CONFLICT')
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
      if (display && !definition.display) throw new AgentMuxError('Tool has no display evaluation entry.', 'SETTING_RESOURCE_NOT_FOUND')
      if (action) this.savedAction(definition, action.id)
      let executionId: string
      do { executionId = mintObjectId() } while ([...this.tools.values()].flatMap(known => [known, ...(known.display ? [known.display] : [])])
        .some(known => known.latest?.executionId === executionId || known.admission?.executionId === executionId))
      const admission: ToolkitAdmission = { executionId, invocationId: input.invocationId,
        definition: structuredClone(definition), expectedLatestExecutionId: input.expectedLatestExecutionId, action,
        target: { workspacePath: definition.workspacePath }, run: null, startedAt: this.now(), text: '', state: 'pending', reason: null }
      tool.admission = admission
      execution = this.execution(tool, admission); execution.capture = resolved.capture; tool.live = execution
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
  private async start(execution: Execution, retained = false): Promise<void> {
    try {
      execution.port = await this.args.openRunPort()
      if (this.closed) {
        if (retained) this.unknown(execution, 'Owner closed before the original request could be confirmed.')
        else await this.confirm(execution, 'stopped', 'Owner closed before the script started.', null)
        return
      }
      const definition = execution.admission.definition
      const program = execution.tool.parent ? definition.display! : execution.admission.action ? this.savedAction(definition, execution.admission.action.id) : definition
      let args = ['--input-type=module', '--eval', program.script, '--', ...program.args]
      if (definition.package) {
        if (!this.args.snapshotRoot) throw new AgentMuxError('Package snapshot owner is unavailable.', 'TOOLKIT_PACKAGE_UNAVAILABLE')
        const directory = retained
          ? await readToolkitPackageSnapshot(this.args.snapshotRoot, execution.admission.executionId, definition)
          : await writeToolkitPackageSnapshot(this.args.snapshotRoot, execution.admission.executionId, execution.capture!)
        const entry = execution.tool.parent ? definition.package.displayEntry! : execution.admission.action
          ? definition.package.actionEntries.find(entry => entry.id === execution.admission.action!.id)!.entry
          : definition.package.entry
        args = [join(directory, entry), ...program.args]
        execution.capture = null
      }
      if (this.closed) {
        if (retained) this.unknown(execution, 'Owner closed before the original request could be confirmed.')
        else await this.confirm(execution, 'stopped', 'Owner closed before the script started.', null)
        return
      }
      // A failed create may still have admitted a Run; only confirmed outcomes permit cleanup.
      execution.creating = true
      const run = await execution.port.create({ createOperationId: execution.admission.executionId,
        workspacePath: definition.workspacePath, command: this.args.runner,
        args, env: this.args.env, cols: 80, rows: 24 },
        event => this.accept(execution, event))
      execution.admission.run = { hostId: 'local', runId: run.runId }; execution.creating = false
      await this.save(execution.tool)
      const attached = await this.attach(execution)
      if (execution.ended || execution.tool.live !== execution || execution.uncertain) return
      if (attached.run.state !== 'running') await this.finish(execution, attached)
      else if (this.closed || execution.stopRequested || execution.failure) await this.stopLane(execution.tool, execution.admission.executionId)
      else { execution.admission.state = 'running'; this.publish(execution.tool) }
    } catch (error) {
      if (retained || execution.creating || execution.admission.run) this.unknown(execution, error)
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
        else if (this.closed || execution.failure || execution.stopRequested) await this.stopLane(tool, execution.admission.executionId)
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
  private async requireObservationOwner(execution: Execution): Promise<void> {
    if (execution.tool.live === execution && !execution.ended && !this.closed) return
    // A replacement execution owns its own observation. Only this still
    // current, closing owner may release the attachment it just acquired.
    if (this.closed && execution.tool.live === execution && !execution.ended) await execution.port!.release(ref(execution))
    throw new AgentMuxError('Tool observation owner changed during attachment.', 'CONTROL_CANCELLED')
  }
  private async attach(execution: Execution, requireCurrentObserver = false): Promise<AgentMuxRunAttachment> {
    execution.attaching = true
    try {
      let attached = await execution.port!.attach(ref(execution), 0, event => this.accept(execution, event))
      if (requireCurrentObserver) await this.requireObservationOwner(execution)
      this.snapshot(execution, attached)
      if (execution.terminalHint && attached.run.state === 'running') {
        execution.terminalHint = false
        attached = await execution.port!.replay(ref(execution), execution.cursor)
        if (requireCurrentObserver) await this.requireObservationOwner(execution)
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
      if (execution.port && execution.admission.run) void this.stopLane(execution.tool, execution.admission.executionId).catch(stopError => this.unknown(execution, stopError))
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
  private async finish(execution: Execution, initial?: AgentMuxRunAttachment): Promise<'running' | void> {
    if (execution.ended || execution.tool.live !== execution) return
    if (execution.finishing) return await execution.finishing
    execution.finishing = (async () => {
      try {
        const final = initial ?? await execution.port!.replay(ref(execution), execution.cursor)
        if (execution.tool.live !== execution || execution.ended) return
        this.snapshot(execution, final)
        if (final.run.state === 'running') return 'running' as const
        if (execution.cursor !== final.run.latestOutputBytes) throw new AgentMuxError('Tool terminal output is incomplete.', 'CONTROL_PROTOCOL_ERROR')
        if (!execution.failure) {
          try { this.append(execution, execution.decoder.decode()) }
          catch (error) { execution.failure = message(error) }
        }
        this.restoreText(execution, final)
        // An exit event can arrive inside Core Stop, before its acceptance is known.
        // Wait only for that submission, never for Stop's later call back into finish.
        try { await execution.stopSubmission } catch { /* Rejected Stop leaves the natural terminal fact authoritative. */ }
        if (execution.tool.live !== execution || execution.ended) return
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
      await this.save(tool, { latestConfirmed: confirmed, admission: execution.admission }, () => {
        tool.latest = confirmed; execution.ended = true
        if (tool.parent && confirmed.state === 'succeeded') tool.successful = confirmed
        execution.admission.state = 'stopping'; execution.admission.reason = 'Result confirmed; exact Run cleanup pending.'
      })
      this.publish(tool)
      if (execution.port && execution.admission.run) {
        await execution.port.release(ref(execution))
        await execution.port.remove(ref(execution))
      }
      await this.save(tool, { latestConfirmed: confirmed, admission: null }, () => {
        tool.admission = null; tool.live = null; execution.capture = null; execution.complete()
      })
      this.publish(tool)
      // Cleanup failure retains only an owned cache; it cannot turn a confirmed result into an unknown Run.
      if (execution.admission.definition.package && this.args.snapshotRoot) {
        await removeToolkitPackageSnapshot(this.args.snapshotRoot, execution.admission.executionId, execution.admission.definition.package.contentSHA256).catch(error => {
          console.warn("Confirmed Toolkit execution cache cleanup failed:", message(error))
        })
      }
    } catch (error) { execution.ended = false; this.unknown(execution, 'Tool result or cleanup is unconfirmed: ' + message(error)) }
  }
  async stop(id: string, executionId: string | null): Promise<ToolkitSnapshot> {
    const root = await this.load(id)
    const tool = root.display?.admission?.executionId === executionId ? root.display : root
    return await this.stopLane(tool, executionId)
  }
  private async stopLane(tool: Tool, executionId: string | null): Promise<ToolkitSnapshot> {
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
    if (execution?.ended) {
      if (execution.finishing) await execution.finishing
      return this.current(tool)
    }
    if (!execution?.port || !tool.admission.run) throw new AgentMuxError('Tool Run identity is unconfirmed.', 'CONTROL_UNAVAILABLE')
    if (!execution.stopRequested) {
      // Register before invoking the port: it may synchronously publish an exit.
      execution.stopSubmission ??= Promise.resolve().then(async () => {
        await execution.port!.stop(ref(execution))
        execution.stopRequested = true
      })
      const submission = execution.stopSubmission
      execution.admission.state = 'stopping'; execution.admission.reason = 'Stop confirmation pending.'; this.publish(tool)
      try { await submission }
      catch (error) {
        const observedState = await this.finish(execution)
        if (execution.ended && tool.admission === null && tool.latest?.executionId === execution.admission.executionId) return this.current(tool)
        if (tool.live !== execution) throw error
        const observed = this.current(tool)
        const observedScript = observed.kind === 'package-unavailable' ? observed.retained : observed.kind === 'script' ? observed : null
        const outcome = observedScript?.state === 'unknown' ? observedScript.reason : null
        const reason = 'Stop unconfirmed: ' + message(error) + (outcome ? '; ' + outcome : '')
        this.unknown(execution, reason)
        // Core Stop detaches before submission, including a rejected one.
        // Restore only the same confirmed live Run's observation, once; the
        // original Stop remains rejected and no new execution is admitted.
        if (observedState === 'running' && !this.closed) {
          try {
            const attached = await this.attach(execution, true)
            if (tool.live === execution && !execution.ended && !this.closed && attached.run.state !== 'running') await this.finish(execution, attached)
          } catch (observationError) { this.unknown(execution, reason + '; observation unconfirmed: ' + message(observationError)) }
        }
        throw error
      } finally { if (execution.stopSubmission === submission) execution.stopSubmission = null }
    }
    await this.finish(execution)
    // Core Stop releases the old attachment. Its receipt may precede terminal metadata;
    // retain observation of this same Run rather than losing the later authoritative exit.
    if (tool.live === execution && !execution.ended && execution.admission.state === 'stopping') {
      const attached = await this.attach(execution)
      if (attached.run.state !== 'running') await this.finish(execution, attached)
    }
    return this.current(tool)
  }
  async subscribe(id: string, snapshot: Lease['snapshot'], end: Lease['end'], signal: AbortSignal, options?: { evaluateOnDisplay?: boolean }) {
    if (signal.aborted || this.closed) throw new AgentMuxError('Tool reader cancelled or closed.', 'CONTROL_CANCELLED')
    const tool = await this.load(id)
    if (!tool.error && tool.admission?.run && !tool.live && !this.closed) await this.recover(tool)
    const resolved = await this.resolve(tool).catch(() => null)
    if (signal.aborted || this.closed) throw new AgentMuxError('Tool reader cancelled or closed during establishment.', 'CONTROL_CANCELLED')
    let released = false
    const evaluates = options?.evaluateOnDisplay === true && Boolean(resolved?.definition.display || tool.display?.admission?.definition.display)
    const firstDisplayReader = evaluates && tool.displayReaders++ === 0
    const lease: Lease = { snapshot, end, release: () => {
      if (released) return
      released = true; tool.leases.delete(lease); signal.removeEventListener('abort', lease.release)
      if (evaluates) --tool.displayReaders
    } }
    tool.leases.add(lease); signal.addEventListener('abort', lease.release, { once: true })
    if (signal.aborted) lease.release()
    if (!released) {
      try { snapshot(this.current(tool)) } catch (error) { lease.release(); throw error }
      if (firstDisplayReader) void this.evaluate(id, undefined, new AbortController().signal).catch(error => {
        // Keep the reader and the original ordinary execution available.
        const display = this.displayTool(tool)
        if (!display.admission) { display.sourceError = 'Display evaluation unavailable: ' + message(error); this.publish(display) }
      })
    }
    return { dispose: lease.release }
  }
  async dispose(): Promise<void> {
    this.closed = true
    for (const tool of [...this.tools.values()].flatMap(value => [value, ...(value.display ? [value.display] : [])])) {
      for (const lease of [...tool.leases]) { lease.release(); try { lease.end() } catch {} }
      const execution = tool.live
      if (!execution) continue
      if (execution.starting) {
        try { await execution.starting } catch (error) { this.unknown(execution, error) }
      }
      if (execution && !execution.ended && execution.admission.run && execution.port) {
        try { await this.stopLane(tool, execution.admission.executionId) }
        catch (error) { this.unknown(execution, error) }
      }
      if (execution.finishing) await execution.finishing
      if (!execution.uncertain) await execution.done
    }
  }
}
