import { createHash, randomUUID } from 'node:crypto'
import { AgentMuxError } from '@agentmux/core'
import { parseConnectionSetupConfigurationReceipt, parseConnectionSetupParams, type ConnectionEnrollmentCallContext, type ConnectionSetupAdvance, type ConnectionSetupConfigurationAction, type ConnectionSetupConfigurationReceipt, type ConnectionSetupInspect, type ConnectionSetupOperation, type ConnectionSetupView } from '@agentmux/core/connections'
import type { ConnectionHost } from './connection-host.js'
import type { EnrollmentSecrets } from './connection-enrollment-adapter.js'
import type { SetupApplicationInspection, SetupMessagingSource } from './connection-setup-inspection.js'

type Parent = { operation: ConnectionSetupOperation; actor: ConnectionEnrollmentCallContext['actor']; privateRef: string | null }
type Child = { receipt: ConnectionSetupConfigurationReceipt; authenticationStepId: string; recoveryActionId: string; privateRef: string | null }
type Envelope = { binding: string; stepId: string; privateState: string }
type Owner = {
  connections: ConnectionHost; secrets: EnrollmentSecrets | undefined; inspection: SetupApplicationInspection
  read(id: string): Parent | null
  authority(context: ConnectionEnrollmentCallContext, row: Parent): Promise<void>
  current(row: Parent): boolean
  touch(row: Parent): void
  view(row: Parent, context: ConnectionEnrollmentCallContext): Promise<ConnectionSetupView>
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const failure = (message: string, code = 'CONNECTION_SETUP_UNCONFIRMED') => new AgentMuxError(message, code)
const effect = 'enable-messaging'

/** Explicit finite effect children in the original setup journal. No current configuration Store. */
export class SetupApplicationConfiguration {
  private closed = false
  private readonly pending = new Map<string, Promise<ConnectionSetupView>>()
  private readonly live = new Set<string>()
  private readonly unsettled = new Map<string, Envelope>()
  constructor(private readonly owner: Owner) {}
  close(): void { this.closed = true; this.live.clear(); this.unsettled.clear() }
  private safe<T>(work: () => T): T {
    try { return work() } catch (error) {
      if (error instanceof AgentMuxError) throw error
      throw failure('The original configuration request journal is unconfirmed. Retain its identity and inspect it on its executing Host. Existing bots, platform continuation and Agents remain available.')
    }
  }
  private decode(record: Record<string, unknown>): Child {
    const value = JSON.parse(String(record.record_json)), receipt = parseConnectionSetupConfigurationReceipt(value.receipt)
    const recovery = parseConnectionSetupParams('connection.setup.advance', { ...receipt.input, decision: { actionId: value.recoveryActionId, value: 'continue' } })
    if (value.effect !== effect || record.step_id !== receipt.stepId || record.operation_id !== receipt.input.operationId || record.action_id !== receipt.input.decision.actionId || record.recovery_action_id !== recovery.decision.actionId || typeof value.authenticationStepId !== 'string' || !value.authenticationStepId) throw failure('This original configuration effect has different identity.', 'CONNECTION_OPERATION_CONFLICT')
    return { receipt, authenticationStepId: value.authenticationStepId, recoveryActionId: recovery.decision.actionId, privateRef: record.private_ref === null ? null : String(record.private_ref) }
  }
  private find(operationId: string, selector?: { stepId?: string; actionId?: string }): Child | null {
    return this.safe(() => {
      const db = this.owner.connections.database
      const record = selector?.stepId ? db.prepare("SELECT * FROM connection_setup_inspection WHERE operation_id=? AND json_extract(record_json,'$.effect')=? AND step_id=?").get(operationId, effect, selector.stepId)
        : selector?.actionId ? db.prepare("SELECT * FROM connection_setup_inspection WHERE operation_id=? AND json_extract(record_json,'$.effect')=? AND (action_id=? OR recovery_action_id=?)").get(operationId, effect, selector.actionId, selector.actionId)
          : db.prepare("SELECT * FROM connection_setup_inspection WHERE operation_id=? AND json_extract(record_json,'$.effect')=? ORDER BY ordinal DESC LIMIT 1").get(operationId, effect)
      return record ? this.decode(record) : null
    })
  }
  private summary(child: Child): ConnectionSetupConfigurationReceipt {
    const result = structuredClone(child.receipt)
    if (result.request === 'dispatching' && !this.live.has(result.stepId)) result.request = 'unknown'
    return result
  }
  private binding(row: Parent, child: Child): string {
    const o = row.operation
    return digest({ operationId: o.operationId, connectionId: o.connectionId, revision: o.expectedConnectionRevision, application: o.application, adapterId: o.adapterId, goal: o.goal, actor: row.actor, effect, desired: true, authenticationStepId: child.authenticationStepId, sourceStepId: child.receipt.sourceStepId })
  }
  private envelope(value: string | null, row: Parent, child: Child): Envelope | null {
    try {
      const parsed = value === null ? null : JSON.parse(value) as Envelope
      return parsed && parsed.binding === this.binding(row, child) && parsed.stepId === child.receipt.stepId && typeof parsed.privateState === 'string' ? parsed : null
    } catch { return null }
  }
  private adapter(row: Parent) {
    const adapter = this.owner.connections.registeredAdapter(row.operation.adapterId)?.setup?.applicationConfiguration
    return adapter?.domains.includes(row.operation.application.domain) && typeof adapter.messagingCapability === 'function' && typeof adapter.enableMessaging === 'function' ? adapter : null
  }
  private targetFact(row: Parent, unresolved: boolean): string | null {
    return this.safe(() => {
      // Relevant local application facts only, including aliases and ordinary new-setup routes.
      // This journal cannot assert distributed or external exactly-once behavior.
      const filter = unresolved
        ? "json_extract(i.record_json,'$.effect')='enable-messaging' AND (json_extract(i.record_json,'$.receipt.request') IS NOT 'confirmed' OR json_extract(i.record_json,'$.receipt.secureStorage') IS NOT 'stored')"
        : "(json_extract(i.record_json,'$.effect')='enable-messaging' OR json_extract(i.record_json,'$.receipt.subject')='bot-settings')"
      const record = this.owner.connections.database.prepare(`SELECT i.step_id FROM connection_setup_inspection i JOIN connection_setup_operation p ON p.operation_id=i.operation_id WHERE json_extract(p.record_json,'$.application.domain')=? AND json_extract(p.record_json,'$.application.appId')=? AND ${filter} ORDER BY i.ordinal DESC LIMIT 1`).get(row.operation.application.domain, row.operation.application.appId)
      return record ? String(record.step_id) : null
    })
  }
  private currentSource(row: Parent, source: SetupMessagingSource, admittedStepId?: string): boolean {
    return this.owner.current(row) && this.owner.inspection.messagingSourceCurrent(row, source) && this.targetFact(row, false) === (admittedStepId ?? source.receipt.stepId)
  }
  private originalTarget(row: Parent, stepId: string): NonNullable<ConnectionSetupView['applicationConfiguration']>['unresolved'] {
    return this.safe(() => {
      const record = this.owner.connections.database.prepare('SELECT operation_id FROM connection_setup_inspection WHERE step_id=?').get(stepId)
      const parent = record ? this.owner.read(String(record.operation_id)) : null
      // Another actor's private history is never disclosed through a shared application alias.
      return parent && parent.actor.kind === row.actor.kind && parent.actor.id === row.actor.id ? { operationId: parent.operation.operationId, connectionId: parent.operation.connectionId, stepId } : undefined
    })
  }
  private action(row: Parent, source: SetupMessagingSource): ConnectionSetupConfigurationAction {
    return { kind: effect, expectedRevision: row.operation.revision, actionId: 'setup-enable:' + digest({ operation: row.operation, actor: row.actor, sourceStepId: source.receipt.stepId, authenticationStepId: source.authenticationStepId, desired: true }) }
  }
  async attach(base: ConnectionSetupView, row: Parent, context: ConnectionEnrollmentCallContext, selector: NonNullable<ConnectionSetupInspect['applicationConfiguration']> = {}): Promise<ConnectionSetupView> {
    await this.owner.authority(context, row)
    const limit = selector.limit ?? 25, before = selector.cursor === undefined ? Number.MAX_SAFE_INTEGER : Number(selector.cursor)
    if (!Number.isSafeInteger(before) || before < 1 || selector.cursor !== undefined && !/^[1-9][0-9]*$/u.test(selector.cursor)) throw failure('The original configuration history cursor is invalid.', 'INVALID_CONNECTION_SETUP_DATA')
    const records = this.safe(() => this.owner.connections.database.prepare("SELECT * FROM connection_setup_inspection WHERE operation_id=? AND json_extract(record_json,'$.effect')=? AND ordinal<? ORDER BY ordinal DESC LIMIT ?").all(row.operation.operationId, effect, before, limit + 1))
    const selected = this.find(row.operation.operationId, selector.selectedStepId ? { stepId: selector.selectedStepId } : undefined)
    const actions: ConnectionSetupConfigurationAction[] = []
    if (selected?.receipt.request === 'confirmed' && selected.receipt.secureStorage !== 'stored') actions.push({ kind: 'recover-configuration-effect', actionId: selected.recoveryActionId, expectedRevision: selected.receipt.input.expectedRevision })
    let source: SetupMessagingSource | null = null
    let capability: NonNullable<ConnectionSetupView['applicationConfiguration']>['capability'] = 'unknown'
    let reason: NonNullable<ConnectionSetupView['applicationConfiguration']>['reason'] = 'source-unconfirmed'
    const adapter = this.adapter(row)
    if (!adapter) reason = 'adapter-unavailable'
    else {
      source = await this.owner.inspection.messagingSource(row)
      if (source) {
        try { capability = await adapter.messagingCapability(source.originalReadState) } catch { /* Keep this source unconfirmed. */ }
        if (!['enabled', 'disabled', 'unknown'].includes(capability)) capability = 'unknown'
      }
    }
    await this.owner.authority(context, row)
    const fresh = this.owner.read(row.operation.operationId)!
    if (!source || !this.currentSource(fresh, source) || base.operation?.authentication?.stepId !== source.authenticationStepId || base.reason === 'connection-revised') { source = null; capability = 'unknown' }
    else if (capability !== 'unknown') reason = undefined
    const unresolved = this.targetFact(fresh, true)
    if (unresolved) reason = 'original-effect-unconfirmed'
    if (source && capability === 'disabled' && !unresolved && !this.find(row.operation.operationId) && this.adapter(fresh) === adapter && base.operation?.revision === fresh.operation.revision) actions.push(this.action(fresh, source))
    const original = unresolved ? this.originalTarget(fresh, unresolved) : undefined
    return { ...base, applicationConfiguration: { effects: records.slice(0, limit).map(record => this.summary(this.decode(record))), next: records.length > limit ? String(records[limit - 1]!.ordinal) : null, selected: selected ? this.summary(selected) : null, source: source?.receipt ?? null, capability, actions, ...(original ? { unresolved: original } : {}), ...(reason ? { reason } : {}) } }
  }
  private update(row: Parent, child: Child, change: Partial<Pick<ConnectionSetupConfigurationReceipt, 'request' | 'secureStorage'>>, privateRef = child.privateRef): Child {
    return this.safe(() => {
      const next = { ...child, receipt: parseConnectionSetupConfigurationReceipt({ ...child.receipt, ...change }), privateRef }
      const record = (c: Child) => JSON.stringify({ effect, receipt: c.receipt, authenticationStepId: c.authenticationStepId, recoveryActionId: c.recoveryActionId })
      if (record(next) === record(child) && privateRef === child.privateRef) return child
      const db = this.owner.connections.database
      db.exec('BEGIN IMMEDIATE')
      try {
        const changed = db.prepare('UPDATE connection_setup_inspection SET record_json=?,private_ref=? WHERE step_id=? AND record_json=? AND private_ref IS ?').run(record(next), privateRef, child.receipt.stepId, record(child), child.privateRef)
        if (changed.changes !== 1) throw failure('This original configuration receipt changed. Read that same request.', 'CONNECTION_OPERATION_CONFLICT')
        this.owner.touch(this.owner.read(row.operation.operationId)!)
        db.exec('COMMIT'); return next
      } catch (error) { db.exec('ROLLBACK'); throw error }
    })
  }
  private async secure(row: Parent, child: Child): Promise<Child> {
    const secrets = this.owner.secrets
    if (!secrets || child.receipt.request !== 'confirmed' || child.receipt.secureStorage === 'stored') return child
    try {
      await secrets.assertAvailable()
      const operationId = 'connection-setup-effect:' + child.receipt.stepId
      let saved = await secrets.inspect(operationId)
      const original = this.unsettled.get(child.receipt.stepId)
      if (!saved && original) saved = await secrets.store({ operationId, secret: JSON.stringify(original) })
      if (!saved || !this.envelope(await secrets.resolve(saved.credentialRef), row, child)) return child
      child = this.update(row, this.find(row.operation.operationId, { stepId: child.receipt.stepId })!, { secureStorage: 'stored' }, saved.credentialRef)
      this.unsettled.delete(child.receipt.stepId)
      return child
    } catch {
      const fresh = this.find(row.operation.operationId, { stepId: child.receipt.stepId })!
      return fresh.receipt.secureStorage === 'stored' ? fresh : this.update(row, fresh, { secureStorage: 'unknown' })
    }
  }
  private async result(row: Parent, child: Child, input: ConnectionSetupAdvance, context: ConnectionEnrollmentCallContext): Promise<ConnectionSetupView> {
    const current = this.owner.read(row.operation.operationId)!
    return { ...await this.attach(await this.owner.view(current, context), current, context, { selectedStepId: child.receipt.stepId }), receipt: { actionId: input.decision.actionId, stepId: child.receipt.stepId, state: this.summary(child).request } }
  }
  async advance(input: ConnectionSetupAdvance, context: ConnectionEnrollmentCallContext): Promise<ConnectionSetupView | null> {
    const row = this.owner.read(input.operationId)!
    await this.owner.authority(context, row)
    let previous = this.find(input.operationId, { actionId: input.decision.actionId })
    const repeat = async (child: Child) => {
      const expected = input.decision.actionId === child.recoveryActionId ? { ...child.receipt.input, decision: { actionId: child.recoveryActionId, value: 'continue' } } : child.receipt.input
      if (!same(expected, input)) throw failure('This effect action has different frozen original input.', 'CONNECTION_OPERATION_CONFLICT')
      const running = this.pending.get(child.receipt.stepId); if (running) await running
      child = this.find(input.operationId, { stepId: child.receipt.stepId })!
      return this.result(row, await this.secure(row, child), input, context)
    }
    // The original actor's local secure ACK is independent of all current native eligibility.
    if (previous) return repeat(previous)
    if (!input.decision.actionId.startsWith('setup-enable:')) return null
    const adapter = this.adapter(row), source = await this.owner.inspection.messagingSource(row)
    let capability = 'unknown'
    if (adapter && source) { try { capability = await adapter.messagingCapability(source.originalReadState) } catch { /* No native request. */ } }
    await this.owner.authority(context, row)
    previous = this.find(input.operationId, { actionId: input.decision.actionId })
    if (previous) return repeat(previous)
    const db = this.owner.connections.database
    const admission = this.safe(() => {
      db.exec('BEGIN IMMEDIATE')
      try {
        const existing = this.find(input.operationId, { actionId: input.decision.actionId })
        if (existing) { db.exec('COMMIT'); return { child: existing, claimed: false } }
        const fresh = this.owner.read(input.operationId)!
        if (!source || !adapter || capability !== 'disabled' || this.adapter(fresh) !== adapter || !this.currentSource(fresh, source) || this.targetFact(fresh, true) || this.find(input.operationId) || input.decision.value !== 'confirm' || fresh.operation.revision !== input.expectedRevision || this.action(fresh, source).actionId !== input.decision.actionId) throw failure('This exact enable-only action has no current original source or has an unresolved prior effect. Read that same request and current bot settings; platform continuation and existing bots remain available.', 'CONNECTION_SETUP_ACTION_STALE')
        const receipt: ConnectionSetupConfigurationReceipt = { effect, stepId: randomUUID(), sourceStepId: source.receipt.stepId, input, request: 'dispatching', secureStorage: 'not-started' }
        const child: Child = { receipt, authenticationStepId: source.authenticationStepId, recoveryActionId: 'setup-effect-recover:' + digest(receipt), privateRef: null }
        db.prepare('INSERT INTO connection_setup_inspection(step_id,operation_id,action_id,recovery_action_id,record_json) VALUES(?,?,?,?,?)').run(receipt.stepId, input.operationId, input.decision.actionId, child.recoveryActionId, JSON.stringify({ effect, receipt, authenticationStepId: child.authenticationStepId, recoveryActionId: child.recoveryActionId }))
        this.owner.touch(fresh); db.exec('COMMIT'); return { child, claimed: true }
      } catch (error) { db.exec('ROLLBACK'); throw error }
    })
    if (!admission.claimed) return repeat(admission.child)
    const child = admission.child
    this.live.add(child.receipt.stepId)
    const work = this.run(row, child, source!, input, context)
    this.pending.set(child.receipt.stepId, work)
    try { return await work } finally { this.live.delete(child.receipt.stepId); this.pending.delete(child.receipt.stepId) }
  }
  private async run(row: Parent, child: Child, source: SetupMessagingSource, input: ConnectionSetupAdvance, context: ConnectionEnrollmentCallContext): Promise<ConnectionSetupView> {
    let original: Envelope | null = null
    try {
      const adapter = this.adapter(row)
      const assertCurrent = () => {
        context.signal?.throwIfAborted()
        const fresh = this.owner.read(input.operationId)!
        if (this.closed || this.adapter(fresh) !== adapter || !this.currentSource(fresh, source, child.receipt.stepId)) throw failure('The original configuration source changed before its native request.')
      }
      assertCurrent()
      const result = await adapter!.enableMessaging({ operationId: input.operationId, connectionId: row.operation.connectionId, attemptId: source.attemptId, application: row.operation.application, privateState: source.privateState, assertCurrent }, context.signal)
      if (result.kind === 'accepted' && typeof result.privateState === 'string') original = { binding: this.binding(row, child), stepId: child.receipt.stepId, privateState: result.privateState }
    } catch { /* Only this original request is unconfirmed; never replay it or infer health. */ }
    if (this.closed) return { operation: row.operation, challenge: null, reason: 'challenge-unavailable', receipt: { actionId: input.decision.actionId, stepId: child.receipt.stepId, state: 'unknown' } }
    if (!original) child = this.update(row, child, { request: 'unknown' })
    else {
      this.unsettled.set(child.receipt.stepId, original)
      child = this.update(row, child, { request: 'confirmed', secureStorage: 'storing' })
      child = await this.secure(row, child)
    }
    return this.result(row, child, input, context)
  }
}
