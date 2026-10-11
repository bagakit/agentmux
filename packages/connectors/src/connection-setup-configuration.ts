import { createHash, randomUUID } from 'node:crypto'
import { AgentMuxError } from '@agentmux/core'
import { connectionSetupConfigurationSubject, connectionSetupPermissionActionPurpose, parseConnectionSetupPermissionReview, parseConnectionSetupConfigurationReceipt, parseConnectionSetupParams, type ConnectionEnrollmentCallContext, type ConnectionSetupAdvance, type ConnectionSetupConfigurationEffect, type ConnectionSetupScalarEffect, type ConnectionSetupPermissionPurpose, type ConnectionSetupConfigurationAction, type ConnectionSetupConfigurationReceipt, type ConnectionSetupInspect, type ConnectionSetupOperation, type ConnectionSetupView } from '@agentmux/core/connections'
import type { ConnectionHost } from './connection-host.js'
import type { SetupPermissionPlan } from './connection-setup-adapter.js'
import type { EnrollmentSecrets } from './connection-enrollment-adapter.js'
import type { SetupApplicationInspection, SetupConfigurationSource } from './connection-setup-inspection.js'

type Parent = { operation: ConnectionSetupOperation; actor: ConnectionEnrollmentCallContext['actor']; privateRef: string | null }
type Child = { receipt: ConnectionSetupConfigurationReceipt; authenticationStepId: string; recoveryActionId: string; privateRef: string | null; permissionIntentDigest?: string }
type PermissionSources = { catalog: SetupConfigurationSource; applied: SetupConfigurationSource }
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
    if (value.effect !== receipt.effect || record.step_id !== receipt.stepId || record.operation_id !== receipt.input.operationId || record.action_id !== receipt.input.decision.actionId || record.recovery_action_id !== recovery.decision.actionId || typeof value.authenticationStepId !== 'string' || !value.authenticationStepId) throw failure('This original configuration effect has different identity.', 'CONNECTION_OPERATION_CONFLICT')
    if (receipt.effect === 'add-application-permissions' && (typeof value.permissionIntentDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(value.permissionIntentDigest))) throw failure('This original permission intent is unconfirmed.', 'CONNECTION_OPERATION_CONFLICT')
    return { receipt, authenticationStepId: value.authenticationStepId, recoveryActionId: recovery.decision.actionId, privateRef: record.private_ref === null ? null : String(record.private_ref), ...(receipt.effect === 'add-application-permissions' ? { permissionIntentDigest: value.permissionIntentDigest } : {}) }
  }
  private find(operationId: string, selector: { effect?: ConnectionSetupConfigurationEffect; stepId?: string; actionId?: string }): Child | null {
    return this.safe(() => {
      const filters = ["operation_id=?", "json_extract(record_json,'$.effect') IN ('enable-messaging','use-persistent-connection','add-application-permissions')"], values: string[] = [operationId]
      if (selector.effect) { filters.push("json_extract(record_json,'$.effect')=?"); values.push(selector.effect) }
      if (selector.stepId) { filters.push('step_id=?'); values.push(selector.stepId) }
      if (selector.actionId) { filters.push('(action_id=? OR recovery_action_id=?)'); values.push(selector.actionId, selector.actionId) }
      const record = this.owner.connections.database.prepare('SELECT * FROM connection_setup_inspection WHERE ' + filters.join(' AND ') + ' ORDER BY ordinal DESC LIMIT 1').get(...values)
      return record ? this.decode(record) : null
    })
  }
  private summary(child: Child): ConnectionSetupConfigurationReceipt {
    const result = structuredClone(child.receipt)
    if (result.request === 'dispatching' && !this.live.has(result.stepId)) result.request = 'unknown'
    return result
  }
  private binding(row: Parent, child: Child): string {
    const o = row.operation, effect = child.receipt.effect
    if (child.receipt.effect === 'add-application-permissions') return digest({ operationId: o.operationId, connectionId: o.connectionId, revision: o.expectedConnectionRevision, application: o.application, adapterId: o.adapterId, goal: o.goal, actor: row.actor, effect, desired: { purpose: child.receipt.purpose, scopeNames: child.receipt.scopeNames, nativeIntentDigest: child.permissionIntentDigest }, authenticationStepId: child.authenticationStepId, sourceStepIds: child.receipt.sourceStepIds })
    return digest({ operationId: o.operationId, connectionId: o.connectionId, revision: o.expectedConnectionRevision, application: o.application, adapterId: o.adapterId, goal: o.goal, actor: row.actor, effect, desired: effect === 'enable-messaging' ? true : 'persistent-connection', authenticationStepId: child.authenticationStepId, sourceStepId: child.receipt.sourceStepId })
  }
  private envelope(value: string | null, row: Parent, child: Child): Envelope | null {
    try {
      const parsed = value === null ? null : JSON.parse(value) as Envelope
      return parsed && parsed.binding === this.binding(row, child) && parsed.stepId === child.receipt.stepId && typeof parsed.privateState === 'string' ? parsed : null
    } catch { return null }
  }
  private adapter(row: Parent, effect: ConnectionSetupConfigurationEffect) {
    const adapter = this.owner.connections.registeredAdapter(row.operation.adapterId)?.setup?.applicationConfiguration
    if (effect === 'add-application-permissions') return adapter?.domains.includes(row.operation.application.domain) && typeof adapter.permissionPlan === 'function' && typeof adapter.addApplicationPermissions === 'function' ? adapter : null
    return adapter?.domains.includes(row.operation.application.domain) && (effect === 'enable-messaging' ? typeof adapter.messagingCapability === 'function' && typeof adapter.enableMessaging === 'function' : typeof adapter.eventTransportCapability === 'function' && typeof adapter.usePersistentConnection === 'function') ? adapter : null
  }
  private targetFact(row: Parent, effect: ConnectionSetupConfigurationEffect, unresolved: boolean): string | null {
    return this.safe(() => {
      // Only this app, effect and original source subject participate; independent effects stay available.
      const filter = unresolved
        ? "json_extract(i.record_json,'$.effect')=? AND (json_extract(i.record_json,'$.receipt.request') IS NOT 'confirmed' OR json_extract(i.record_json,'$.receipt.secureStorage') IS NOT 'stored')"
        : "(json_extract(i.record_json,'$.effect')=? OR (json_extract(i.record_json,'$.effect') IS NULL AND json_extract(i.record_json,'$.receipt.subject')=?))"
      if (!unresolved && effect === 'add-application-permissions') {
        const record = this.owner.connections.database.prepare(`SELECT i.step_id FROM connection_setup_inspection i JOIN connection_setup_operation p ON p.operation_id=i.operation_id WHERE json_extract(p.record_json,'$.application.domain')=? AND json_extract(p.record_json,'$.application.appId')=? AND (json_extract(i.record_json,'$.effect')=? OR (json_extract(i.record_json,'$.effect') IS NULL AND json_extract(i.record_json,'$.receipt.subject') IN ('permission-catalog','application-permissions'))) ORDER BY i.ordinal DESC LIMIT 1`).get(row.operation.application.domain, row.operation.application.appId, effect)
        return record ? String(record.step_id) : null
      }
      const values = [row.operation.application.domain, row.operation.application.appId, effect, ...(unresolved ? [] : [connectionSetupConfigurationSubject(effect as ConnectionSetupScalarEffect)])]
      const record = this.owner.connections.database.prepare(`SELECT i.step_id FROM connection_setup_inspection i JOIN connection_setup_operation p ON p.operation_id=i.operation_id WHERE json_extract(p.record_json,'$.application.domain')=? AND json_extract(p.record_json,'$.application.appId')=? AND ${filter} ORDER BY i.ordinal DESC LIMIT 1`).get(...values)
      return record ? String(record.step_id) : null
    })
  }
  private currentSource(row: Parent, source: SetupConfigurationSource, effect: ConnectionSetupScalarEffect, admittedStepId?: string): boolean {
    return source.receipt.subject === connectionSetupConfigurationSubject(effect) && this.owner.current(row) && this.owner.inspection.configurationSourceCurrent(row, source) && this.targetFact(row, effect, false) === (admittedStepId ?? source.receipt.stepId)
  }
  private originalTarget(row: Parent, stepId: string): NonNullable<ConnectionSetupView['applicationConfiguration']>['unresolved'] {
    return this.safe(() => {
      const record = this.owner.connections.database.prepare('SELECT operation_id FROM connection_setup_inspection WHERE step_id=?').get(stepId)
      const parent = record ? this.owner.read(String(record.operation_id)) : null
      // Another actor's private history is never disclosed through a shared application alias.
      return parent && parent.actor.kind === row.actor.kind && parent.actor.id === row.actor.id ? { operationId: parent.operation.operationId, connectionId: parent.operation.connectionId, stepId } : undefined
    })
  }
  private action(row: Parent, source: SetupConfigurationSource, effect: ConnectionSetupScalarEffect): ConnectionSetupConfigurationAction {
    return { kind: effect, expectedRevision: row.operation.revision, actionId: (effect === 'enable-messaging' ? 'setup-enable:' : 'setup-persistent:') + digest({ operation: row.operation, actor: row.actor, sourceStepId: source.receipt.stepId, authenticationStepId: source.authenticationStepId, desired: effect === 'enable-messaging' ? true : 'persistent-connection' }) }
  }
  async attach(base: ConnectionSetupView, row: Parent, context: ConnectionEnrollmentCallContext, selector: NonNullable<ConnectionSetupInspect['applicationConfiguration']>): Promise<ConnectionSetupView> {
    if (selector.effect === 'add-application-permissions') return this.attachPermissions(base, row, context, selector)
    await this.owner.authority(context, row)
    const effect = selector.effect, subject = connectionSetupConfigurationSubject(effect)
    const limit = selector.limit ?? 25, before = selector.cursor === undefined ? Number.MAX_SAFE_INTEGER : Number(selector.cursor)
    if (!Number.isSafeInteger(before) || before < 1 || selector.cursor !== undefined && !/^[1-9][0-9]*$/u.test(selector.cursor)) throw failure('The original configuration history cursor is invalid.', 'INVALID_CONNECTION_SETUP_DATA')
    const records = this.safe(() => this.owner.connections.database.prepare("SELECT * FROM connection_setup_inspection WHERE operation_id=? AND json_extract(record_json,'$.effect')=? AND ordinal<? ORDER BY ordinal DESC LIMIT ?").all(row.operation.operationId, effect, before, limit + 1))
    const selected = this.find(row.operation.operationId, selector.selectedStepId ? { effect, stepId: selector.selectedStepId } : { effect })
    const actions: ConnectionSetupConfigurationAction[] = []
    if (selected?.receipt.request === 'confirmed' && selected.receipt.secureStorage !== 'stored') actions.push({ kind: 'recover-configuration-effect', actionId: selected.recoveryActionId, expectedRevision: selected.receipt.input.expectedRevision })
    let source: SetupConfigurationSource | null = null
    let capability: NonNullable<ConnectionSetupView['applicationConfiguration']>['capability'] = 'unknown'
    let reason: NonNullable<ConnectionSetupView['applicationConfiguration']>['reason'] = 'source-unconfirmed'
    const adapter = this.adapter(row, effect)
    if (!adapter) reason = 'adapter-unavailable'
    else {
      source = await this.owner.inspection.configurationSource(row, connectionSetupConfigurationSubject(effect))
      if (source) {
        try { capability = await (effect === 'enable-messaging' ? adapter.messagingCapability(source.originalReadState) : adapter.eventTransportCapability(source.originalReadState)) } catch { /* Keep this source unconfirmed. */ }
        if (!['enabled', 'disabled', 'unknown'].includes(capability)) capability = 'unknown'
      }
    }
    await this.owner.authority(context, row)
    const fresh = this.owner.read(row.operation.operationId)!
    if (!source || !this.currentSource(fresh, source, effect) || base.operation?.authentication?.stepId !== source.authenticationStepId || base.reason === 'connection-revised') { source = null; capability = 'unknown' }
    else if (capability !== 'unknown') reason = undefined
    const unresolved = this.targetFact(fresh, effect, true)
    if (unresolved) reason = 'original-effect-unconfirmed'
    if (source && capability === 'disabled' && !unresolved && !this.find(row.operation.operationId, { effect }) && this.adapter(fresh, effect) === adapter && base.operation?.revision === fresh.operation.revision) actions.push(this.action(fresh, source, effect))
    const original = unresolved ? this.originalTarget(fresh, unresolved) : undefined
    return { ...base, applicationConfiguration: { effect, subject, effects: records.slice(0, limit).map(record => this.summary(this.decode(record))), next: records.length > limit ? String(records[limit - 1]!.ordinal) : null, selected: selected ? this.summary(selected) : null, source: source?.receipt ?? null, capability, actions, ...(original ? { unresolved: original } : {}), ...(reason ? { reason } : {}) } }
  }
  private update(row: Parent, child: Child, change: Partial<Pick<ConnectionSetupConfigurationReceipt, 'request' | 'secureStorage'>> & { requiresDataRangeConfiguration?: boolean | null }, privateRef = child.privateRef): Child {
    return this.safe(() => {
      const next = { ...child, receipt: parseConnectionSetupConfigurationReceipt({ ...child.receipt, ...change }), privateRef }
      const record = (c: Child) => JSON.stringify({ effect: c.receipt.effect, receipt: c.receipt, authenticationStepId: c.authenticationStepId, recoveryActionId: c.recoveryActionId, ...(c.receipt.effect === 'add-application-permissions' ? { permissionIntentDigest: c.permissionIntentDigest } : {}) })
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
    return { ...await this.attach(await this.owner.view(current, context), current, context, { effect: child.receipt.effect, ...(child.receipt.effect === 'add-application-permissions' ? { purpose: child.receipt.purpose } : {}), selectedStepId: child.receipt.stepId } as NonNullable<ConnectionSetupInspect['applicationConfiguration']>), receipt: { actionId: input.decision.actionId, stepId: child.receipt.stepId, state: this.summary(child).request } }
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
    if (input.decision.actionId.startsWith('setup-permissions:')) return this.advancePermissions(row, input, context)
    const effect: ConnectionSetupScalarEffect | null = input.decision.actionId.startsWith('setup-enable:') ? 'enable-messaging' : input.decision.actionId.startsWith('setup-persistent:') ? 'use-persistent-connection' : null
    if (!effect) return null
    const adapter = this.adapter(row, effect), source = await this.owner.inspection.configurationSource(row, connectionSetupConfigurationSubject(effect))
    let capability = 'unknown'
    if (adapter && source) { try { capability = await (effect === 'enable-messaging' ? adapter.messagingCapability(source.originalReadState) : adapter.eventTransportCapability(source.originalReadState)) } catch { /* No native request. */ } }
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
        if (!source || !adapter || capability !== 'disabled' || this.adapter(fresh, effect) !== adapter || !this.currentSource(fresh, source, effect) || this.targetFact(fresh, effect, true) || this.find(input.operationId, { effect }) || input.decision.value !== 'confirm' || fresh.operation.revision !== input.expectedRevision || this.action(fresh, source, effect).actionId !== input.decision.actionId) throw failure('This exact scalar action has no current original source or has an unresolved prior effect. Read that same request and current setting; platform continuation and existing bots remain available.', 'CONNECTION_SETUP_ACTION_STALE')
        const receipt: ConnectionSetupConfigurationReceipt = { effect, stepId: randomUUID(), sourceStepId: source.receipt.stepId, input, request: 'dispatching', secureStorage: 'not-started' }
        const child: Child = { receipt, authenticationStepId: source.authenticationStepId, recoveryActionId: 'setup-effect-recover:' + digest(receipt), privateRef: null }
        db.prepare('INSERT INTO connection_setup_inspection(step_id,operation_id,action_id,recovery_action_id,record_json) VALUES(?,?,?,?,?)').run(receipt.stepId, input.operationId, input.decision.actionId, child.recoveryActionId, JSON.stringify({ effect, receipt, authenticationStepId: child.authenticationStepId, recoveryActionId: child.recoveryActionId }))
        this.owner.touch(fresh); db.exec('COMMIT'); return { child, claimed: true }
      } catch (error) { db.exec('ROLLBACK'); throw error }
    })
    if (!admission.claimed) return repeat(admission.child)
    const child = admission.child
    this.live.add(child.receipt.stepId)
    const work = this.run(row, child, source!, input, context, effect)
    this.pending.set(child.receipt.stepId, work)
    try { return await work } finally { this.live.delete(child.receipt.stepId); this.pending.delete(child.receipt.stepId) }
  }
  private permissionSourcesCurrent(row: Parent, sources: PermissionSources, admittedStepId?: string): boolean {
    const latest = this.targetFact(row, 'add-application-permissions', false)
    const original = (subject: string) => this.safe(() => this.owner.connections.database.prepare("SELECT i.step_id FROM connection_setup_inspection i JOIN connection_setup_operation p ON p.operation_id=i.operation_id WHERE json_extract(p.record_json,'$.application.domain')=? AND json_extract(p.record_json,'$.application.appId')=? AND json_extract(i.record_json,'$.effect') IS NULL AND json_extract(i.record_json,'$.receipt.subject')=? ORDER BY i.ordinal DESC LIMIT 1").get(row.operation.application.domain, row.operation.application.appId, subject)?.step_id)
    const lastEffect = this.safe(() => this.owner.connections.database.prepare("SELECT i.step_id,i.ordinal FROM connection_setup_inspection i JOIN connection_setup_operation p ON p.operation_id=i.operation_id WHERE json_extract(p.record_json,'$.application.domain')=? AND json_extract(p.record_json,'$.application.appId')=? AND json_extract(i.record_json,'$.effect')='add-application-permissions' ORDER BY i.ordinal DESC LIMIT 1").get(row.operation.application.domain, row.operation.application.appId))
    const applied = this.safe(() => this.owner.connections.database.prepare('SELECT ordinal FROM connection_setup_inspection WHERE step_id=?').get(sources.applied.receipt.stepId))
    // A directory refresh cannot make the pre-write applied snapshot current. The admitted child keeps its own source fence.
    if (lastEffect && (admittedStepId ? lastEffect.step_id !== admittedStepId : !applied || Number(applied.ordinal) <= Number(lastEffect.ordinal))) return false
    return original('permission-catalog') === sources.catalog.receipt.stepId && original('application-permissions') === sources.applied.receipt.stepId && this.owner.current(row) && sources.catalog.authenticationStepId === sources.applied.authenticationStepId && sources.catalog.attemptId === sources.applied.attemptId && this.owner.inspection.configurationSourceCurrent(row, sources.catalog) && this.owner.inspection.configurationSourceCurrent(row, sources.applied) && (admittedStepId ? latest === admittedStepId : latest === sources.catalog.receipt.stepId || latest === sources.applied.receipt.stepId)
  }
  private async permissionSources(row: Parent) {
    const catalog = await this.owner.inspection.configurationSource(row, 'permission-catalog')
    const applied = await this.owner.inspection.configurationSource(row, 'application-permissions')
    return { catalog, applied }
  }
  private async permissionPlan(row: Parent, sources: PermissionSources, purpose: ConnectionSetupPermissionPurpose): Promise<SetupPermissionPlan | null> {
    try {
      const result = await this.adapter(row, 'add-application-permissions')?.permissionPlan(sources.catalog.originalReadState, sources.applied.originalReadState, purpose)
      if (!result) return null
      const review = parseConnectionSetupPermissionReview(result.review)
      if (!Array.isArray(result.appScopeIDs) || result.appScopeIDs.some(id => !(typeof id === 'string' && id.length > 0 || typeof id === 'number' && Number.isSafeInteger(id))) || new Set(result.appScopeIDs).size !== result.appScopeIDs.length || result.appScopeIDs.length !== (review.reason ? 0 : review.permissions.filter(p => p.state === 'missing').length)) return null
      return { review, appScopeIDs: result.appScopeIDs }
    } catch { return null }
  }
  private permissionIntent(purpose: ConnectionSetupPermissionPurpose, plan: SetupPermissionPlan) {
    return { purpose, scopeNames: plan.review.permissions.filter(p => p.state === 'missing').map(p => p.name), appScopeIDs: plan.appScopeIDs }
  }
  private permissionAction(row: Parent, sources: PermissionSources, purpose: ConnectionSetupPermissionPurpose, plan: SetupPermissionPlan): ConnectionSetupConfigurationAction {
    return { kind: 'add-application-permissions', expectedRevision: row.operation.revision, actionId: 'setup-permissions:' + purpose + ':' + digest({ operation: row.operation, actor: row.actor, sourceStepIds: { catalog: sources.catalog.receipt.stepId, applied: sources.applied.receipt.stepId }, authenticationStepId: sources.catalog.authenticationStepId, desired: this.permissionIntent(purpose, plan) }) }
  }
  private async attachPermissions(base: ConnectionSetupView, row: Parent, context: ConnectionEnrollmentCallContext, selector: Extract<NonNullable<ConnectionSetupInspect['applicationConfiguration']>, { effect: 'add-application-permissions' }>): Promise<ConnectionSetupView> {
    await this.owner.authority(context, row)
    const effect = selector.effect, purpose = selector.purpose, limit = selector.limit ?? 25, before = selector.cursor === undefined ? Number.MAX_SAFE_INTEGER : Number(selector.cursor)
    if (!Number.isSafeInteger(before) || before < 1 || selector.cursor !== undefined && !/^[1-9][0-9]*$/u.test(selector.cursor)) throw failure('The original configuration history cursor is invalid.', 'INVALID_CONNECTION_SETUP_DATA')
    const records = this.safe(() => this.owner.connections.database.prepare("SELECT * FROM connection_setup_inspection WHERE operation_id=? AND json_extract(record_json,'$.effect')=? AND ordinal<? ORDER BY ordinal DESC LIMIT ?").all(row.operation.operationId, effect, before, limit + 1))
    const selected = this.find(row.operation.operationId, selector.selectedStepId ? { effect, stepId: selector.selectedStepId } : { effect })
    const actions: ConnectionSetupConfigurationAction[] = []
    if (selected?.receipt.request === 'confirmed' && selected.receipt.secureStorage !== 'stored') actions.push({ kind: 'recover-configuration-effect', actionId: selected.recoveryActionId, expectedRevision: selected.receipt.input.expectedRevision })
    const adapter = this.adapter(row, effect), partial = await this.permissionSources(row)
    let sources = partial.catalog && partial.applied ? { catalog: partial.catalog, applied: partial.applied } : null
    let plan = sources && adapter ? await this.permissionPlan(row, sources, purpose) : null
    await this.owner.authority(context, row)
    const fresh = this.owner.read(row.operation.operationId)!
    const qualified = base.reason !== 'connection-revised' && base.operation?.authentication?.stepId === fresh.operation.authentication?.stepId
    if (!sources || !qualified || !this.permissionSourcesCurrent(fresh, sources)) { sources = null; plan = null }
    const current = (source: SetupConfigurationSource | null) => qualified && source && this.owner.inspection.configurationSourceCurrent(fresh, source) ? source.receipt : null
    let capability: 'unknown' | 'enabled' | 'disabled' = plan && !plan.review.reason ? plan.appScopeIDs.length ? 'disabled' : 'enabled' : 'unknown'
    let reason: NonNullable<ConnectionSetupView['applicationConfiguration']>['reason'] = !adapter ? 'adapter-unavailable' : capability === 'unknown' ? 'source-unconfirmed' : undefined
    const unresolved = this.targetFact(fresh, effect, true)
    if (unresolved) reason = 'original-effect-unconfirmed'
    if (sources && plan && capability === 'disabled' && !unresolved && this.adapter(fresh, effect) === adapter && base.operation?.revision === fresh.operation.revision) actions.push(this.permissionAction(fresh, sources, purpose, plan))
    const original = unresolved ? this.originalTarget(fresh, unresolved) : undefined
    return { ...base, applicationConfiguration: { effect, subject: 'application-permissions', purpose, effects: records.slice(0, limit).map(record => this.summary(this.decode(record))), next: records.length > limit ? String(records[limit - 1]!.ordinal) : null, selected: selected ? this.summary(selected) : null, sources: { catalog: current(partial.catalog), applied: current(partial.applied) }, review: plan?.review ?? null, capability, actions, ...(reason ? { reason } : {}), ...(original ? { unresolved: original } : {}) } }
  }
  private async advancePermissions(row: Parent, input: ConnectionSetupAdvance, context: ConnectionEnrollmentCallContext): Promise<ConnectionSetupView> {
    // Finite owner-generated machine IDs encode the explicit purpose; no display string or stored UI selection is consulted.
    const purpose = connectionSetupPermissionActionPurpose(input.decision.actionId)
    const partial = await this.permissionSources(row), sources = partial.catalog && partial.applied ? { catalog: partial.catalog, applied: partial.applied } : null
    const adapter = this.adapter(row, 'add-application-permissions'), plan = purpose && sources && adapter ? await this.permissionPlan(row, sources, purpose) : null
    await this.owner.authority(context, row)
    const previous = this.find(input.operationId, { actionId: input.decision.actionId })
    if (previous) {
      if (!same(previous.receipt.input, input)) throw failure('This permission action has different original input.', 'CONNECTION_OPERATION_CONFLICT')
      const pending = this.pending.get(previous.receipt.stepId); if (pending) await pending
      return this.result(row, await this.secure(row, this.find(input.operationId, { stepId: previous.receipt.stepId })!), input, context)
    }
    const db = this.owner.connections.database
    const admission = this.safe(() => {
      db.exec('BEGIN IMMEDIATE')
      try {
        const existing = this.find(input.operationId, { actionId: input.decision.actionId })
        if (existing) { db.exec('COMMIT'); return { child: existing, claimed: false } }
        const fresh = this.owner.read(input.operationId)!
        if (!purpose || !sources || !plan || plan.review.reason || !plan.appScopeIDs.length || this.adapter(fresh, 'add-application-permissions') !== adapter || !this.permissionSourcesCurrent(fresh, sources) || this.targetFact(fresh, 'add-application-permissions', true) || input.expectedRevision !== fresh.operation.revision || input.decision.value !== 'confirm' || this.permissionAction(fresh, sources, purpose, plan).actionId !== input.decision.actionId) throw failure('This exact permission addition has no current two-source review or has an unconfirmed original request. Keep that result; independent bot settings remain available.', 'CONNECTION_SETUP_ACTION_STALE')
        const intent = this.permissionIntent(purpose, plan)
        const receipt: ConnectionSetupConfigurationReceipt = { effect: 'add-application-permissions', stepId: randomUUID(), input, request: 'dispatching', secureStorage: 'not-started', purpose, sourceStepIds: { catalog: sources.catalog.receipt.stepId, applied: sources.applied.receipt.stepId }, scopeNames: intent.scopeNames, requiresDataRangeConfiguration: null }
        const child: Child = { receipt, authenticationStepId: sources.catalog.authenticationStepId, recoveryActionId: 'setup-effect-recover:' + digest(receipt), privateRef: null, permissionIntentDigest: digest(intent) }
        db.prepare('INSERT INTO connection_setup_inspection(step_id,operation_id,action_id,recovery_action_id,record_json) VALUES(?,?,?,?,?)').run(receipt.stepId, input.operationId, input.decision.actionId, child.recoveryActionId, JSON.stringify({ effect: receipt.effect, receipt, authenticationStepId: child.authenticationStepId, recoveryActionId: child.recoveryActionId, permissionIntentDigest: child.permissionIntentDigest }))
        this.owner.touch(fresh); db.exec('COMMIT'); return { child, claimed: true }
      } catch (error) { db.exec('ROLLBACK'); throw error }
    })
    const child = admission.child
    if (!admission.claimed) {
      if (!same(child.receipt.input, input)) throw failure('This permission action has different original input.', 'CONNECTION_OPERATION_CONFLICT')
      const pending = this.pending.get(child.receipt.stepId); if (pending) await pending
      return this.result(row, await this.secure(row, this.find(input.operationId, { stepId: child.receipt.stepId })!), input, context)
    }
    this.live.add(child.receipt.stepId)
    const work = this.runPermissions(row, child, sources!, plan!, input, context)
    this.pending.set(child.receipt.stepId, work)
    try { return await work } finally { this.live.delete(child.receipt.stepId); this.pending.delete(child.receipt.stepId) }
  }
  private async runPermissions(row: Parent, child: Child, sources: PermissionSources, plan: SetupPermissionPlan, input: ConnectionSetupAdvance, context: ConnectionEnrollmentCallContext): Promise<ConnectionSetupView> {
    let original: Envelope | null = null, requiresDataRangeConfiguration: boolean | null = null
    try {
      const adapter = this.adapter(row, 'add-application-permissions')
      const assertCurrent = () => {
        context.signal?.throwIfAborted()
        const fresh = this.owner.read(input.operationId)!
        if (this.closed || this.adapter(fresh, 'add-application-permissions') !== adapter || !this.permissionSourcesCurrent(fresh, sources, child.receipt.stepId)) throw failure('The exact original permission sources changed before dispatch.')
      }
      assertCurrent()
      const result = await adapter!.addApplicationPermissions({ operationId: input.operationId, connectionId: row.operation.connectionId, attemptId: sources.catalog.attemptId, application: row.operation.application, privateState: sources.catalog.privateState, appScopeIDs: plan.appScopeIDs, assertCurrent }, context.signal)
      if (result.kind === 'accepted' && typeof result.privateState === 'string') { original = { binding: this.binding(row, child), stepId: child.receipt.stepId, privateState: result.privateState }; requiresDataRangeConfiguration = typeof result.requiresDataRangeConfiguration === 'boolean' ? result.requiresDataRangeConfiguration : null }
    } catch { /* Preserve only this original unknown effect; never replay it. */ }
    if (this.closed) return { operation: row.operation, challenge: null, reason: 'challenge-unavailable', receipt: { actionId: input.decision.actionId, stepId: child.receipt.stepId, state: 'unknown' } }
    if (!original) child = this.update(row, child, { request: 'unknown' })
    else { this.unsettled.set(child.receipt.stepId, original); child = this.update(row, child, { request: 'confirmed', secureStorage: 'storing', requiresDataRangeConfiguration }); child = await this.secure(row, child) }
    return this.result(row, child, input, context)
  }
  private async run(row: Parent, child: Child, source: SetupConfigurationSource, input: ConnectionSetupAdvance, context: ConnectionEnrollmentCallContext, effect: ConnectionSetupScalarEffect): Promise<ConnectionSetupView> {
    let original: Envelope | null = null
    try {
      const adapter = this.adapter(row, effect)
      const assertCurrent = () => {
        context.signal?.throwIfAborted()
        const fresh = this.owner.read(input.operationId)!
        if (this.closed || this.adapter(fresh, effect) !== adapter || !this.currentSource(fresh, source, effect, child.receipt.stepId)) throw failure('The original configuration source changed before its native request.')
      }
      assertCurrent()
      const result = await (effect === 'enable-messaging' ? adapter!.enableMessaging : adapter!.usePersistentConnection)({ operationId: input.operationId, connectionId: row.operation.connectionId, attemptId: source.attemptId, application: row.operation.application, privateState: source.privateState, assertCurrent }, context.signal)
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
