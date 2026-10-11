import { createHash, randomUUID } from 'node:crypto'
import { AgentMuxError } from '@agentmux/core'
import { connectionSetupPublicationSubjects, parseConnectionSetupPublicationReview, connectionSetupConfigurationSubject, connectionSetupPermissionActionPurpose, parseConnectionSetupMessageReceptionReview, parseConnectionSetupPermissionReview, parseConnectionSetupConfigurationReceipt, parseConnectionSetupParams, type ConnectionEnrollmentCallContext, type ConnectionSetupAdvance, type ConnectionSetupConfigurationEffect, type ConnectionSetupScalarEffect, type ConnectionSetupPublicationEffect, type ConnectionSetupPublicationDraft, type ConnectionSetupAccount, type ConnectionSetupSubmissionResponse, type ConnectionSetupPermissionPurpose, type ConnectionSetupConfigurationAction, type ConnectionSetupConfigurationReceipt, type ConnectionSetupInspect, type ConnectionSetupOperation, type ConnectionSetupView } from '@agentmux/core/connections'
import type { ConnectionHost } from './connection-host.js'
import type { SetupMessageReceptionPlan, SetupPermissionPlan, SetupPublicationPlan } from './connection-setup-adapter.js'
import type { EnrollmentSecrets } from './connection-enrollment-adapter.js'
import type { SetupApplicationInspection, SetupConfigurationSource } from './connection-setup-inspection.js'

type Parent = { operation: ConnectionSetupOperation; actor: ConnectionEnrollmentCallContext['actor']; privateRef: string | null }
type Child = { receipt: ConnectionSetupConfigurationReceipt; authenticationStepId: string; recoveryActionId: string; privateRef: string | null; permissionIntentDigest?: string; receptionIntentDigest?: string; publicationIntentDigest?: string }
type PublicationSources = Record<string, SetupConfigurationSource>
type PublicationSelector = Extract<NonNullable<ConnectionSetupInspect['applicationConfiguration']>, { effect: ConnectionSetupPublicationEffect }>
const publicationEffect = (effect: string): effect is ConnectionSetupPublicationEffect => effect === 'create-application-version' || effect === 'submit-application-version'
type ReceptionSources = { catalog: SetupConfigurationSource; settings: SetupConfigurationSource }
type PermissionSources = { catalog: SetupConfigurationSource; applied: SetupConfigurationSource }
type Envelope = { binding: string; stepId: string; privateState: string }
type Owner = {
  connections: ConnectionHost; secrets: EnrollmentSecrets | undefined; inspection: SetupApplicationInspection
  read(id: string): Parent | null
  authority(context: ConnectionEnrollmentCallContext, row: Parent): Promise<void>
  current(row: Parent): boolean
  creator(row: Parent): Promise<ConnectionSetupAccount | null>
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
    if (receipt.effect === 'add-message-reception' && (typeof value.receptionIntentDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(value.receptionIntentDigest))) throw failure('This original message-reception intent is unconfirmed.', 'CONNECTION_OPERATION_CONFLICT')
    if (publicationEffect(receipt.effect) && (typeof value.publicationIntentDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(value.publicationIntentDigest))) throw failure('This original publication intent is unconfirmed.', 'CONNECTION_OPERATION_CONFLICT')
    return { receipt, authenticationStepId: value.authenticationStepId, recoveryActionId: recovery.decision.actionId, privateRef: record.private_ref === null ? null : String(record.private_ref), ...(receipt.effect === 'add-application-permissions' ? { permissionIntentDigest: value.permissionIntentDigest } : {}), ...(receipt.effect === 'add-message-reception' ? { receptionIntentDigest: value.receptionIntentDigest } : {}), ...(publicationEffect(receipt.effect) ? { publicationIntentDigest: value.publicationIntentDigest } : {}) }
  }
  private find(operationId: string, selector: { effect?: ConnectionSetupConfigurationEffect; stepId?: string; actionId?: string }): Child | null {
    return this.safe(() => {
      const filters = ["operation_id=?", "json_extract(record_json,'$.effect') IN ('enable-messaging','use-persistent-connection','add-application-permissions','add-message-reception','create-application-version','submit-application-version')"], values: string[] = [operationId]
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
    if (child.receipt.effect === 'create-application-version' || child.receipt.effect === 'submit-application-version') return digest({ operationId: o.operationId, connectionId: o.connectionId, revision: o.expectedConnectionRevision, application: o.application, adapterId: o.adapterId, goal: o.goal, actor: row.actor, effect, draft: child.receipt.input.publicationDraft, nativeIntentDigest: child.publicationIntentDigest, authenticationStepId: child.authenticationStepId, sourceStepIds: child.receipt.sourceStepIds, versionId: child.receipt.versionId, submission: child.receipt.submission })
    if (child.receipt.effect === 'add-message-reception') return digest({ operationId: o.operationId, connectionId: o.connectionId, revision: o.expectedConnectionRevision, application: o.application, adapterId: o.adapterId, goal: o.goal, actor: row.actor, effect, desired: { messageReception: true, transport: child.receipt.transport, nativeIntentDigest: child.receptionIntentDigest }, authenticationStepId: child.authenticationStepId, sourceStepIds: child.receipt.sourceStepIds })
    if (child.receipt.effect === 'add-application-permissions') return digest({ operationId: o.operationId, connectionId: o.connectionId, revision: o.expectedConnectionRevision, application: o.application, adapterId: o.adapterId, goal: o.goal, actor: row.actor, effect, desired: { purpose: child.receipt.purpose, scopeNames: child.receipt.scopeNames, nativeIntentDigest: child.permissionIntentDigest }, authenticationStepId: child.authenticationStepId, sourceStepIds: child.receipt.sourceStepIds })
    const scalar = child.receipt as Extract<ConnectionSetupConfigurationReceipt, { effect: ConnectionSetupScalarEffect }>
    return digest({ operationId: o.operationId, connectionId: o.connectionId, revision: o.expectedConnectionRevision, application: o.application, adapterId: o.adapterId, goal: o.goal, actor: row.actor, effect, desired: effect === 'enable-messaging' ? true : 'persistent-connection', authenticationStepId: child.authenticationStepId, sourceStepId: scalar.sourceStepId })
  }
  private envelope(value: string | null, row: Parent, child: Child): Envelope | null {
    try {
      const parsed = value === null ? null : JSON.parse(value) as Envelope
      return parsed && parsed.binding === this.binding(row, child) && parsed.stepId === child.receipt.stepId && typeof parsed.privateState === 'string' ? parsed : null
    } catch { return null }
  }
  private adapter(row: Parent, effect: ConnectionSetupConfigurationEffect) {
    const adapter = this.owner.connections.registeredAdapter(row.operation.adapterId)?.setup?.applicationConfiguration
    if (publicationEffect(effect)) return adapter?.domains.includes(row.operation.application.domain) && typeof adapter.publicationPlan === 'function' && typeof adapter.createVersion === 'function' && typeof adapter.submitVersion === 'function' ? adapter : null
    if (effect === 'add-message-reception') return adapter?.domains.includes(row.operation.application.domain) && typeof adapter.messageReceptionPlan === 'function' && typeof adapter.addMessageReception === 'function' ? adapter : null
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
    return (effect !== 'use-persistent-connection' || this.eventSettingsCurrent(row, source, admittedStepId)) && source.receipt.subject === connectionSetupConfigurationSubject(effect) && this.owner.current(row) && this.owner.inspection.configurationSourceCurrent(row, source) && this.targetFact(row, effect, false) === (admittedStepId ?? source.receipt.stepId)
  }
  /** These two concrete writers carry the same event delivery field. Catalog reads cannot refresh it. */
  private eventSettingsCurrent(row: Parent, source: SetupConfigurationSource, admittedStepId?: string): boolean {
    return this.safe(() => {
      const writer = this.owner.connections.database.prepare("SELECT i.step_id,i.ordinal FROM connection_setup_inspection i JOIN connection_setup_operation p ON p.operation_id=i.operation_id WHERE json_extract(p.record_json,'$.application.domain')=? AND json_extract(p.record_json,'$.application.appId')=? AND json_extract(i.record_json,'$.effect') IN ('use-persistent-connection','add-message-reception') ORDER BY i.ordinal DESC LIMIT 1").get(row.operation.application.domain, row.operation.application.appId)
      const current = this.owner.connections.database.prepare('SELECT ordinal FROM connection_setup_inspection WHERE step_id=?').get(source.receipt.stepId)
      return !writer || (admittedStepId ? writer.step_id === admittedStepId : Boolean(current && Number(current.ordinal) > Number(writer.ordinal)))
    })
  }
  private receptionSourceCurrent(row: Parent, source: SetupConfigurationSource, admittedStepId?: string): boolean {
    if (source.receipt.subject !== 'event-catalog' && source.receipt.subject !== 'event-settings' || !this.owner.current(row) || !this.owner.inspection.configurationSourceCurrent(row, source)) return false
    const latest = this.safe(() => this.owner.connections.database.prepare("SELECT i.step_id FROM connection_setup_inspection i JOIN connection_setup_operation p ON p.operation_id=i.operation_id WHERE json_extract(p.record_json,'$.application.domain')=? AND json_extract(p.record_json,'$.application.appId')=? AND json_extract(i.record_json,'$.effect') IS NULL AND json_extract(i.record_json,'$.receipt.subject')=? ORDER BY i.ordinal DESC LIMIT 1").get(row.operation.application.domain, row.operation.application.appId, source.receipt.subject)?.step_id)
    return latest === source.receipt.stepId && (source.receipt.subject !== 'event-settings' || this.eventSettingsCurrent(row, source, admittedStepId))
  }
  private receptionSourcesCurrent(row: Parent, sources: ReceptionSources, admittedStepId?: string): boolean {
    return sources.catalog.authenticationStepId === sources.settings.authenticationStepId && sources.catalog.attemptId === sources.settings.attemptId && this.receptionSourceCurrent(row, sources.catalog, admittedStepId) && this.receptionSourceCurrent(row, sources.settings, admittedStepId)
  }
  private compatibleOriginalMode(row: Parent): boolean {
    const unresolved = this.targetFact(row, 'use-persistent-connection', true)
    if (!unresolved) return true
    return this.safe(() => {
      const record = this.owner.connections.database.prepare('SELECT * FROM connection_setup_inspection WHERE step_id=?').get(unresolved)
      const child = record ? this.decode(record) : null
      // The original finite scalar's immutable desired is persistent delivery, as defined by its adapter command.
      // This permits a distinct add+carry intent, never retries or ACKs that original switch.
      return child?.receipt.effect === 'use-persistent-connection' && child.receipt.input.decision.value === 'confirm' && child.receipt.input.decision.actionId.startsWith('setup-persistent:')
    })
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
    if (publicationEffect(selector.effect)) return this.attachPublication(base, row, context, selector as PublicationSelector)
    if (selector.effect === 'add-message-reception') return this.attachReception(base, row, context, selector)
    if (selector.effect === 'add-application-permissions') return this.attachPermissions(base, row, context, selector)
    await this.owner.authority(context, row)
    const effect = selector.effect as ConnectionSetupScalarEffect, subject = connectionSetupConfigurationSubject(effect)
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
  private update(row: Parent, child: Child, change: Partial<Pick<ConnectionSetupConfigurationReceipt, 'request' | 'secureStorage'>> & { requiresDataRangeConfiguration?: boolean | null; versionId?: string | null; submission?: ConnectionSetupSubmissionResponse | null }, privateRef = child.privateRef): Child {
    return this.safe(() => {
      const next = { ...child, receipt: parseConnectionSetupConfigurationReceipt({ ...child.receipt, ...change }), privateRef }
      const record = (c: Child) => JSON.stringify({ effect: c.receipt.effect, receipt: c.receipt, authenticationStepId: c.authenticationStepId, recoveryActionId: c.recoveryActionId, ...(c.receipt.effect === 'add-application-permissions' ? { permissionIntentDigest: c.permissionIntentDigest } : {}), ...(c.receipt.effect === 'add-message-reception' ? { receptionIntentDigest: c.receptionIntentDigest } : {}), ...(publicationEffect(c.receipt.effect) ? { publicationIntentDigest: c.publicationIntentDigest } : {}) })
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
    return { ...await this.attach(await this.owner.view(current, context), current, context, { effect: child.receipt.effect, ...(child.receipt.effect === 'add-application-permissions' ? { purpose: child.receipt.purpose } : {}), ...(publicationEffect(child.receipt.effect) ? { draft: child.receipt.input.publicationDraft } : {}), selectedStepId: child.receipt.stepId } as NonNullable<ConnectionSetupInspect['applicationConfiguration']>), receipt: { actionId: input.decision.actionId, stepId: child.receipt.stepId, state: this.summary(child).request } }
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
    if (input.decision.actionId.startsWith('setup-publish-create:') || input.decision.actionId.startsWith('setup-publish-submit:')) return this.advancePublication(row, input, context)
    if (input.decision.actionId.startsWith('setup-reception:')) return this.advanceReception(row, input, context)
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
  /** The same exact subject and writer epoch qualify partial references and complete reviews. */
  private publicationSourceCurrent(row: Parent, source: SetupConfigurationSource, admittedStepId?: string): boolean {
    if (!source.receipt.subject.startsWith('publication-') || !this.owner.current(row) || !this.owner.inspection.configurationSourceCurrent(row, source)) return false
    return this.safe(() => {
      const db = this.owner.connections.database, subject = source.receipt.subject
      const version = subject === 'publication-version' ? " AND json_extract(i.record_json,'$.receipt.versionId')=?" : ''
      const current = db.prepare("SELECT i.step_id,i.ordinal FROM connection_setup_inspection i JOIN connection_setup_operation p ON p.operation_id=i.operation_id WHERE json_extract(p.record_json,'$.application.domain')=? AND json_extract(p.record_json,'$.application.appId')=? AND json_extract(i.record_json,'$.effect') IS NULL AND json_extract(i.record_json,'$.receipt.subject')=?" + version + ' ORDER BY i.ordinal DESC LIMIT 1').get(row.operation.application.domain, row.operation.application.appId, subject, ...(subject === 'publication-version' ? [source.receipt.versionId!] : []))
      if (current?.step_id !== source.receipt.stepId) return false
      const effects = subject === 'publication-visibility' || subject === 'publication-sharing' ? "json_extract(i.record_json,'$.effect')='submit-application-version'" : subject === 'publication-pending' ? "json_extract(i.record_json,'$.effect') IS NOT NULL" : subject === 'publication-versions' || subject === 'publication-version' ? "json_extract(i.record_json,'$.effect') IN ('create-application-version','submit-application-version')" : null
      if (!effects) return true
      const writer = db.prepare("SELECT i.step_id,i.ordinal FROM connection_setup_inspection i JOIN connection_setup_operation p ON p.operation_id=i.operation_id WHERE json_extract(p.record_json,'$.application.domain')=? AND json_extract(p.record_json,'$.application.appId')=? AND " + effects + ' ORDER BY i.ordinal DESC LIMIT 1').get(row.operation.application.domain, row.operation.application.appId)
      return !writer || writer.step_id === admittedStepId || Number(current.ordinal) > Number(writer.ordinal)
    })
  }
  private publicationSourcesCurrent(row: Parent, sources: PublicationSources, effect: ConnectionSetupPublicationEffect, admittedStepId?: string): boolean {
    const values = Object.values(sources), first = values[0]
    return !!first && values.length === connectionSetupPublicationSubjects(effect).length && values.every(source => source.authenticationStepId === first.authenticationStepId && source.attemptId === first.attemptId && this.publicationSourceCurrent(row, source, admittedStepId))
  }
  private async publicationSources(row: Parent, effect: ConnectionSetupPublicationEffect, draft: ConnectionSetupPublicationDraft | null): Promise<PublicationSources> {
    const sources: PublicationSources = {}
    for (const subject of connectionSetupPublicationSubjects(effect)) {
      if (subject === 'publication-version' && draft?.kind !== 'submit-version') continue
      const source = await this.owner.inspection.configurationSource(row, subject, draft?.kind === 'submit-version' ? draft.versionId : undefined)
      if (source) sources[subject.slice(12)] = source
    }
    return sources
  }
  private async publicationPlan(row: Parent, sources: PublicationSources, effect: ConnectionSetupPublicationEffect, draft: ConnectionSetupPublicationDraft | null): Promise<SetupPublicationPlan | null> {
    if (!Object.keys(sources).length) return null
    try {
      const creator = await this.owner.creator(row)
      const plan = await this.adapter(row, effect)?.publicationPlan(effect, Object.fromEntries(Object.entries(sources).map(([key, value]) => [key, value.originalReadState])), draft, creator)
      if (!plan || plan.privateIntent !== null && (typeof plan.privateIntent !== 'string' || !plan.privateIntent)) return null
      const review = parseConnectionSetupPublicationReview(plan.review)
      if (plan.privateIntent && (!draft || review.issues.length)) return null
      return { review, privateIntent: plan.privateIntent }
    } catch { return null }
  }
  private publicationFact(row: Parent, effect: ConnectionSetupPublicationEffect, draft: ConnectionSetupPublicationDraft | null): string | null {
    return this.safe(() => {
      const filter = effect === 'submit-application-version' ? " AND json_extract(i.record_json,'$.receipt.input.publicationDraft.versionId')=?" : ''
      const record = this.owner.connections.database.prepare("SELECT i.step_id FROM connection_setup_inspection i JOIN connection_setup_operation p ON p.operation_id=i.operation_id WHERE json_extract(p.record_json,'$.application.domain')=? AND json_extract(p.record_json,'$.application.appId')=? AND json_extract(i.record_json,'$.effect')=? AND (json_extract(i.record_json,'$.receipt.request') IS NOT 'confirmed' OR json_extract(i.record_json,'$.receipt.secureStorage') IS NOT 'stored' OR (json_extract(i.record_json,'$.effect')='submit-application-version' AND json_extract(i.record_json,'$.receipt.submission.outcome')='unknown'))" + filter + ' ORDER BY i.ordinal DESC LIMIT 1').get(row.operation.application.domain, row.operation.application.appId, effect, ...(effect === 'submit-application-version' ? [draft?.kind === 'submit-version' ? draft.versionId : ''] : []))
      return record ? String(record.step_id) : null
    })
  }
  private publicationAction(row: Parent, sources: PublicationSources, effect: ConnectionSetupPublicationEffect, draft: ConnectionSetupPublicationDraft, plan: SetupPublicationPlan): ConnectionSetupConfigurationAction {
    return { kind: effect, expectedRevision: row.operation.revision, actionId: (effect === 'create-application-version' ? 'setup-publish-create:' : 'setup-publish-submit:') + digest({ operation: row.operation, actor: row.actor, sourceStepIds: Object.fromEntries(Object.entries(sources).map(([key, source]) => [key, source.receipt.stepId])), authenticationStepId: Object.values(sources)[0]!.authenticationStepId, draft, nativeIntentDigest: digest(plan.privateIntent) }) }
  }
  private async attachPublication(base: ConnectionSetupView, row: Parent, context: ConnectionEnrollmentCallContext, selector: PublicationSelector): Promise<ConnectionSetupView> {
    await this.owner.authority(context, row)
    const effect = selector.effect, draft = selector.draft ?? null, limit = selector.limit ?? 25, before = selector.cursor === undefined ? Number.MAX_SAFE_INTEGER : Number(selector.cursor)
    if (!Number.isSafeInteger(before) || before < 1 || selector.cursor !== undefined && !/^[1-9][0-9]*$/u.test(selector.cursor)) throw failure('The original publication history cursor is invalid.', 'INVALID_CONNECTION_SETUP_DATA')
    const records = this.safe(() => this.owner.connections.database.prepare("SELECT * FROM connection_setup_inspection WHERE operation_id=? AND json_extract(record_json,'$.effect')=? AND ordinal<? ORDER BY ordinal DESC LIMIT ?").all(row.operation.operationId, effect, before, limit + 1))
    const selected = this.find(row.operation.operationId, selector.selectedStepId ? { effect, stepId: selector.selectedStepId } : { effect }), actions: ConnectionSetupConfigurationAction[] = []
    if (selected?.receipt.request === 'confirmed' && selected.receipt.secureStorage !== 'stored') actions.push({ kind: 'recover-configuration-effect', actionId: selected.recoveryActionId, expectedRevision: selected.receipt.input.expectedRevision })
    const adapter = this.adapter(row, effect), partial = await this.publicationSources(row, effect, draft)
    let plan = adapter ? await this.publicationPlan(row, partial, effect, draft) : null
    await this.owner.authority(context, row)
    const fresh = this.owner.read(row.operation.operationId)!, qualified = base.reason !== 'connection-revised' && base.operation?.authentication?.stepId === fresh.operation.authentication?.stepId
    const sources = Object.fromEntries(Object.entries(partial).filter(([, source]) => qualified && this.publicationSourceCurrent(fresh, source)).map(([key, source]) => [key, source.receipt]))
    if (!qualified || !Object.values(partial).every(source => this.publicationSourceCurrent(fresh, source))) plan = null
    const complete = qualified && this.publicationSourcesCurrent(fresh, partial, effect)
    const capability = complete && plan && draft && plan.privateIntent ? 'disabled' : 'unknown'
    let reason: NonNullable<ConnectionSetupView['applicationConfiguration']>['reason'] = !adapter ? 'adapter-unavailable' : capability === 'unknown' ? 'source-unconfirmed' : undefined
    const unresolved = this.publicationFact(fresh, effect, draft)
    if (unresolved) reason = 'original-effect-unconfirmed'
    if (draft && plan?.privateIntent && complete && !unresolved && this.adapter(fresh, effect) === adapter && base.operation?.revision === fresh.operation.revision) actions.push(this.publicationAction(fresh, partial, effect, draft, plan))
    const original = unresolved ? this.originalTarget(fresh, unresolved) : undefined
    return { ...base, applicationConfiguration: { effect, subject: effect === 'create-application-version' ? 'publication-pending' : 'publication-version', effects: records.slice(0, limit).map(record => this.summary(this.decode(record))), next: records.length > limit ? String(records[limit - 1]!.ordinal) : null, selected: selected ? this.summary(selected) : null, sources, draft, review: plan?.review ?? null, capability, actions, ...(reason ? { reason } : {}), ...(original ? { unresolved: original } : {}) } }
  }
  private async advancePublication(row: Parent, input: ConnectionSetupAdvance, context: ConnectionEnrollmentCallContext): Promise<ConnectionSetupView> {
    const effect = input.decision.actionId.startsWith('setup-publish-create:') ? 'create-application-version' : 'submit-application-version', draft = input.publicationDraft ?? null
    const sources = await this.publicationSources(row, effect, draft), adapter = this.adapter(row, effect), plan = adapter ? await this.publicationPlan(row, sources, effect, draft) : null
    await this.owner.authority(context, row)
    const db = this.owner.connections.database
    const admission = this.safe(() => {
      db.exec('BEGIN IMMEDIATE')
      try {
        const existing = this.find(input.operationId, { actionId: input.decision.actionId })
        if (existing) { db.exec('COMMIT'); return { child: existing, claimed: false } }
        const fresh = this.owner.read(input.operationId)!
        if (!draft || !plan?.privateIntent || this.adapter(fresh, effect) !== adapter || !this.publicationSourcesCurrent(fresh, sources, effect) || this.publicationFact(fresh, effect, draft) || input.expectedRevision !== fresh.operation.revision || input.decision.value !== 'confirm' || this.publicationAction(fresh, sources, effect, draft, plan).actionId !== input.decision.actionId) throw failure('This publication action no longer has its exact current sources, draft and original authority. Keep the original result; independent configuration and Agents remain available.', 'CONNECTION_SETUP_ACTION_STALE')
        const receipt: ConnectionSetupConfigurationReceipt = { effect, stepId: randomUUID(), input, request: 'dispatching', secureStorage: 'not-started', sourceStepIds: Object.fromEntries(Object.entries(sources).map(([key, source]) => [key, source.receipt.stepId])), versionId: draft.kind === 'submit-version' ? draft.versionId : null, submission: null }
        const child: Child = { receipt, authenticationStepId: Object.values(sources)[0]!.authenticationStepId, recoveryActionId: 'setup-effect-recover:' + digest(receipt), privateRef: null, publicationIntentDigest: digest(plan.privateIntent) }
        db.prepare('INSERT INTO connection_setup_inspection(step_id,operation_id,action_id,recovery_action_id,record_json) VALUES(?,?,?,?,?)').run(receipt.stepId, input.operationId, input.decision.actionId, child.recoveryActionId, JSON.stringify({ effect, receipt, authenticationStepId: child.authenticationStepId, recoveryActionId: child.recoveryActionId, publicationIntentDigest: child.publicationIntentDigest }))
        this.owner.touch(fresh); db.exec('COMMIT'); return { child, claimed: true }
      } catch (error) { db.exec('ROLLBACK'); throw error }
    })
    let child = admission.child
    if (!admission.claimed) {
      if (!same(child.receipt.input, input)) throw failure('This publication action has different original input.', 'CONNECTION_OPERATION_CONFLICT')
      const pending = this.pending.get(child.receipt.stepId); if (pending) await pending
      return this.result(row, await this.secure(row, this.find(input.operationId, { stepId: child.receipt.stepId })!), input, context)
    }
    const work = async () => {
      let original: Envelope | null = null
      try {
        const assertCurrent = () => {
          context.signal?.throwIfAborted()
          const fresh = this.owner.read(input.operationId)!
          if (this.closed || this.adapter(fresh, effect) !== adapter || !this.publicationSourcesCurrent(fresh, sources, effect, child.receipt.stepId)) throw failure('The original publication sources changed before dispatch.')
        }
        assertCurrent()
        const source = Object.values(sources)[0]!
        const result = await (effect === 'create-application-version' ? adapter!.createVersion : adapter!.submitVersion)({ operationId: input.operationId, connectionId: row.operation.connectionId, attemptId: source.attemptId, application: row.operation.application, privateState: source.privateState, privateIntent: plan!.privateIntent!, assertCurrent }, context.signal)
        if (result.kind === 'accepted' && typeof result.privateState === 'string' && typeof result.versionId === 'string' && result.versionId && (draft?.kind !== 'submit-version' || draft.versionId === result.versionId)) {
          child = this.update(row, child, { request: 'confirmed', secureStorage: 'storing', versionId: result.versionId, submission: result.submission })
          original = { binding: this.binding(row, child), stepId: child.receipt.stepId, privateState: result.privateState }
        }
      } catch { /* Retain the exact unconfirmed request. No list matching or replay. */ }
      if (this.closed) return { operation: row.operation, challenge: null, reason: 'challenge-unavailable' as const, receipt: { actionId: input.decision.actionId, stepId: child.receipt.stepId, state: 'unknown' as const } }
      if (!original) child = this.update(row, child, { request: 'unknown' })
      else { this.unsettled.set(child.receipt.stepId, original); child = await this.secure(row, child) }
      return this.result(row, child, input, context)
    }
    this.live.add(child.receipt.stepId)
    const running = work(); this.pending.set(child.receipt.stepId, running)
    try { return await running } finally { this.live.delete(child.receipt.stepId); this.pending.delete(child.receipt.stepId) }
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
  private async receptionSources(row: Parent) {
    const catalog = await this.owner.inspection.configurationSource(row, 'event-catalog')
    const settings = await this.owner.inspection.configurationSource(row, 'event-settings')
    return { catalog, settings }
  }
  private async receptionPlan(row: Parent, sources: ReceptionSources): Promise<SetupMessageReceptionPlan | null> {
    try {
      const plan = await this.adapter(row, 'add-message-reception')?.messageReceptionPlan(sources.catalog.originalReadState, sources.settings.originalReadState)
      if (!plan) return null
      const review = parseConnectionSetupMessageReceptionReview(plan.review)
      if (plan.privateIntent !== null && (typeof plan.privateIntent !== 'string' || !plan.privateIntent || review.reason || review.reception !== 'missing' || review.transport !== 'persistent-connection')) return null
      return { review, privateIntent: plan.privateIntent }
    } catch { return null }
  }
  private receptionAction(row: Parent, sources: ReceptionSources, plan: SetupMessageReceptionPlan): ConnectionSetupConfigurationAction {
    return { kind: 'add-message-reception', expectedRevision: row.operation.revision, actionId: 'setup-reception:' + digest({ operation: row.operation, actor: row.actor, sourceStepIds: { catalog: sources.catalog.receipt.stepId, settings: sources.settings.receipt.stepId }, authenticationStepId: sources.catalog.authenticationStepId, desired: { messageReception: true, transport: 'persistent-connection', nativeIntentDigest: digest(plan.privateIntent) } }) }
  }
  private async attachReception(base: ConnectionSetupView, row: Parent, context: ConnectionEnrollmentCallContext, selector: Extract<NonNullable<ConnectionSetupInspect['applicationConfiguration']>, { effect: 'add-message-reception' }>): Promise<ConnectionSetupView> {
    await this.owner.authority(context, row)
    const effect = selector.effect, limit = selector.limit ?? 25, before = selector.cursor === undefined ? Number.MAX_SAFE_INTEGER : Number(selector.cursor)
    if (!Number.isSafeInteger(before) || before < 1 || selector.cursor !== undefined && !/^[1-9][0-9]*$/u.test(selector.cursor)) throw failure('The original configuration history cursor is invalid.', 'INVALID_CONNECTION_SETUP_DATA')
    const records = this.safe(() => this.owner.connections.database.prepare("SELECT * FROM connection_setup_inspection WHERE operation_id=? AND json_extract(record_json,'$.effect')=? AND ordinal<? ORDER BY ordinal DESC LIMIT ?").all(row.operation.operationId, effect, before, limit + 1))
    const selected = this.find(row.operation.operationId, selector.selectedStepId ? { effect, stepId: selector.selectedStepId } : { effect })
    const actions: ConnectionSetupConfigurationAction[] = []
    if (selected?.receipt.request === 'confirmed' && selected.receipt.secureStorage !== 'stored') actions.push({ kind: 'recover-configuration-effect', actionId: selected.recoveryActionId, expectedRevision: selected.receipt.input.expectedRevision })
    const adapter = this.adapter(row, effect), partial = await this.receptionSources(row)
    let sources = partial.catalog && partial.settings ? { catalog: partial.catalog, settings: partial.settings } : null
    let plan = sources && adapter ? await this.receptionPlan(row, sources) : null
    await this.owner.authority(context, row)
    const fresh = this.owner.read(row.operation.operationId)!
    const qualified = base.reason !== 'connection-revised' && base.operation?.authentication?.stepId === fresh.operation.authentication?.stepId
    if (!sources || !qualified || !this.receptionSourcesCurrent(fresh, sources)) { sources = null; plan = null }
    const current = (source: SetupConfigurationSource | null) => qualified && source && this.receptionSourceCurrent(fresh, source) ? source.receipt : null
    const capability = plan && !plan.review.reason ? plan.review.reception === 'subscribed' ? 'enabled' : plan.review.reception === 'missing' ? 'disabled' : 'unknown' : 'unknown'
    let reason: NonNullable<ConnectionSetupView['applicationConfiguration']>['reason'] = !adapter ? 'adapter-unavailable' : capability === 'unknown' ? 'source-unconfirmed' : undefined
    const unresolved = this.targetFact(fresh, effect, true)
    if (unresolved) reason = 'original-effect-unconfirmed'
    if (sources && plan?.privateIntent && capability === 'disabled' && !unresolved && this.compatibleOriginalMode(fresh) && this.adapter(fresh, effect) === adapter && base.operation?.revision === fresh.operation.revision) actions.push(this.receptionAction(fresh, sources, plan))
    const original = unresolved ? this.originalTarget(fresh, unresolved) : undefined
    return { ...base, applicationConfiguration: { effect, subject: 'event-settings', effects: records.slice(0, limit).map(record => this.summary(this.decode(record))), next: records.length > limit ? String(records[limit - 1]!.ordinal) : null, selected: selected ? this.summary(selected) : null, sources: { catalog: current(partial.catalog), settings: current(partial.settings) }, review: plan?.review ?? null, capability, actions, ...(reason ? { reason } : {}), ...(original ? { unresolved: original } : {}) } }
  }
  private async advanceReception(row: Parent, input: ConnectionSetupAdvance, context: ConnectionEnrollmentCallContext): Promise<ConnectionSetupView> {
    const partial = await this.receptionSources(row), sources = partial.catalog && partial.settings ? { catalog: partial.catalog, settings: partial.settings } : null
    const adapter = this.adapter(row, 'add-message-reception'), plan = sources && adapter ? await this.receptionPlan(row, sources) : null
    await this.owner.authority(context, row)
    const db = this.owner.connections.database
    const admission = this.safe(() => {
      db.exec('BEGIN IMMEDIATE')
      try {
        const existing = this.find(input.operationId, { actionId: input.decision.actionId })
        if (existing) { db.exec('COMMIT'); return { child: existing, claimed: false } }
        const fresh = this.owner.read(input.operationId)!
        if (!sources || !plan?.privateIntent || plan.review.reason || this.adapter(fresh, 'add-message-reception') !== adapter || !this.receptionSourcesCurrent(fresh, sources) || !this.compatibleOriginalMode(fresh) || this.targetFact(fresh, 'add-message-reception', true) || input.expectedRevision !== fresh.operation.revision || input.decision.value !== 'confirm' || this.receptionAction(fresh, sources, plan).actionId !== input.decision.actionId) throw failure('This exact message-reception addition has no current two-source review or retains an unconfirmed original addition. Keep that result; independent bot and permission settings remain available.', 'CONNECTION_SETUP_ACTION_STALE')
        const receipt: ConnectionSetupConfigurationReceipt = { effect: 'add-message-reception', stepId: randomUUID(), input, request: 'dispatching', secureStorage: 'not-started', sourceStepIds: { catalog: sources.catalog.receipt.stepId, settings: sources.settings.receipt.stepId }, transport: 'persistent-connection' }
        const child: Child = { receipt, authenticationStepId: sources.catalog.authenticationStepId, recoveryActionId: 'setup-effect-recover:' + digest(receipt), privateRef: null, receptionIntentDigest: digest(plan.privateIntent) }
        db.prepare('INSERT INTO connection_setup_inspection(step_id,operation_id,action_id,recovery_action_id,record_json) VALUES(?,?,?,?,?)').run(receipt.stepId, input.operationId, input.decision.actionId, child.recoveryActionId, JSON.stringify({ effect: receipt.effect, receipt, authenticationStepId: child.authenticationStepId, recoveryActionId: child.recoveryActionId, receptionIntentDigest: child.receptionIntentDigest }))
        this.owner.touch(fresh); db.exec('COMMIT'); return { child, claimed: true }
      } catch (error) { db.exec('ROLLBACK'); throw error }
    })
    const child = admission.child
    if (!admission.claimed) {
      if (!same(child.receipt.input, input)) throw failure('This message-reception action has different original input.', 'CONNECTION_OPERATION_CONFLICT')
      const pending = this.pending.get(child.receipt.stepId); if (pending) await pending
      return this.result(row, await this.secure(row, this.find(input.operationId, { stepId: child.receipt.stepId })!), input, context)
    }
    this.live.add(child.receipt.stepId)
    const work = this.runReception(row, child, sources!, plan!, input, context)
    this.pending.set(child.receipt.stepId, work)
    try { return await work } finally { this.live.delete(child.receipt.stepId); this.pending.delete(child.receipt.stepId) }
  }
  private async runReception(row: Parent, child: Child, sources: ReceptionSources, plan: SetupMessageReceptionPlan, input: ConnectionSetupAdvance, context: ConnectionEnrollmentCallContext): Promise<ConnectionSetupView> {
    let original: Envelope | null = null
    try {
      const adapter = this.adapter(row, 'add-message-reception')
      const assertCurrent = () => {
        context.signal?.throwIfAborted()
        const fresh = this.owner.read(input.operationId)!
        if (this.closed || this.adapter(fresh, 'add-message-reception') !== adapter || !this.receptionSourcesCurrent(fresh, sources, child.receipt.stepId) || !this.compatibleOriginalMode(fresh)) throw failure('The exact original message-reception sources changed before dispatch.')
      }
      assertCurrent()
      const result = await adapter!.addMessageReception({ operationId: input.operationId, connectionId: row.operation.connectionId, attemptId: sources.catalog.attemptId, application: row.operation.application, privateState: sources.catalog.privateState, privateIntent: plan.privateIntent!, assertCurrent }, context.signal)
      if (result.kind === 'accepted' && typeof result.privateState === 'string') original = { binding: this.binding(row, child), stepId: child.receipt.stepId, privateState: result.privateState }
    } catch { /* Preserve only this original unknown addition; never retry it as another action. */ }
    if (this.closed) return { operation: row.operation, challenge: null, reason: 'challenge-unavailable', receipt: { actionId: input.decision.actionId, stepId: child.receipt.stepId, state: 'unknown' } }
    if (!original) child = this.update(row, child, { request: 'unknown' })
    else { this.unsettled.set(child.receipt.stepId, original); child = this.update(row, child, { request: 'confirmed', secureStorage: 'storing' }); child = await this.secure(row, child) }
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
