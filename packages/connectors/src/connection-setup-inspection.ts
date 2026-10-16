import { createHash, randomUUID } from 'node:crypto'
import { AgentMuxError } from '@agentmux/core'
import { CONNECTION_SETUP_READ_ACTIONS, parseConnectionSetupReadSummary, parseConnectionSetupInspectionReceipt, parseConnectionSetupParams, type ConnectionEnrollmentCallContext, type ConnectionSetupAdvance, type ConnectionSetupInspect, type ConnectionSetupInspectionAction, type ConnectionSetupInspectionReceipt, type ConnectionSetupOperation, type ConnectionSetupReadSubject, type ConnectionSetupReadSummary, type ConnectionSetupView } from '@agentmux/core/connections'
import type { ConnectionHost } from './connection-host.js'
import type { SetupAuthenticationSource } from './connection-setup.js'
import type { EnrollmentSecrets } from './connection-enrollment-adapter.js'

type Parent = { operation: ConnectionSetupOperation; actor: ConnectionEnrollmentCallContext['actor']; privateRef: string | null }
type Snapshot = SetupAuthenticationSource
type Child = { receipt: ConnectionSetupInspectionReceipt; authenticationStepId: string; recoveryActionId: string; privateRef: string | null }
type Envelope = { binding: string; stepId: string; applicationInfoReadPermission?: 'confirmed' | 'unknown'; readResult?: ConnectionSetupReadSummary; privateState?: string; authentication?: string }
export type SetupConfigurationSource = { receipt: ConnectionSetupInspectionReceipt & { subject: ConnectionSetupReadSubject }; authenticationStepId: string; attemptId: string; privateState: string; originalReadState: string; captureAuthentication: SetupAuthenticationSource['captureAuthentication'] }
type Owner = {
  connections: ConnectionHost; secrets: EnrollmentSecrets | undefined
  read(id: string): Parent | null
  authority(context: ConnectionEnrollmentCallContext, row: Parent): Promise<void>
  current(row: Parent): boolean
  snapshot(row: Parent): Promise<Snapshot | null>
  acceptAuthentication(row: Parent, field: string | undefined, childStepId: string, authenticationStepId: string, credentialRef: string): void
  touch(row: Parent): void
  view(row: Parent, context: ConnectionEnrollmentCallContext): Promise<ConnectionSetupView>
}
const readSubjects = Object.keys(CONNECTION_SETUP_READ_ACTIONS) as ConnectionSetupReadSubject[]
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const failure = (message: string, code = 'CONNECTION_SETUP_UNCONFIRMED') => new AgentMuxError(message, code)
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** Finite children of the original setup journal, never another configuration or auth owner. */
export class SetupApplicationInspection {
  private closed = false
  private readonly pending = new Map<string, Promise<ConnectionSetupView>>()
  private readonly live = new Set<string>()
  private readonly unsettled = new Map<string, Envelope>()
  constructor(private readonly owner: Owner) {
    owner.connections.database.exec('CREATE TABLE IF NOT EXISTS connection_setup_inspection (ordinal INTEGER PRIMARY KEY AUTOINCREMENT, step_id TEXT UNIQUE NOT NULL, operation_id TEXT NOT NULL, action_id TEXT UNIQUE NOT NULL, recovery_action_id TEXT UNIQUE NOT NULL, record_json TEXT NOT NULL, private_ref TEXT)')
    owner.connections.database.exec('CREATE INDEX IF NOT EXISTS connection_setup_inspection_by_operation ON connection_setup_inspection(operation_id,ordinal)')
  }
  close(): void { this.closed = true; this.live.clear(); this.unsettled.clear() }
  private safe<T>(work: () => T): T {
    try { return work() } catch (error) {
      if (error instanceof AgentMuxError) throw error
      throw failure('The original application observation storage is unconfirmed. Retain its identity and inspect it on its executing Host. Existing bots and Agents remain available.')
    }
  }
  private decode(row: Record<string, unknown>): Child {
    const value = JSON.parse(String(row.record_json)), receipt = parseConnectionSetupInspectionReceipt(value.receipt)
    const recovery = parseConnectionSetupParams('connection.setup.advance', { ...receipt.input, decision: { actionId: value.recoveryActionId, value: 'continue' } })
    if (row.step_id !== receipt.stepId || row.operation_id !== receipt.input.operationId || row.action_id !== receipt.input.decision.actionId || row.recovery_action_id !== recovery.decision.actionId || typeof value.authenticationStepId !== 'string' || !value.authenticationStepId) throw failure('This original observation has different identity.', 'CONNECTION_OPERATION_CONFLICT')
    return { receipt, authenticationStepId: value.authenticationStepId, recoveryActionId: recovery.decision.actionId, privateRef: row.private_ref === null ? null : String(row.private_ref) }
  }
  private find(operationId: string, selector?: { stepId?: string; actionId?: string }): Child | null {
    return this.safe(() => {
      const db = this.owner.connections.database
      const row = selector?.stepId ? db.prepare("SELECT * FROM connection_setup_inspection WHERE operation_id=? AND json_extract(record_json,'$.effect') IS NULL AND step_id=?").get(operationId, selector.stepId)
        : selector?.actionId ? db.prepare("SELECT * FROM connection_setup_inspection WHERE operation_id=? AND json_extract(record_json,'$.effect') IS NULL AND (action_id=? OR recovery_action_id=?)").get(operationId, selector.actionId, selector.actionId)
          : db.prepare("SELECT * FROM connection_setup_inspection WHERE operation_id=? AND json_extract(record_json,'$.effect') IS NULL ORDER BY ordinal DESC LIMIT 1").get(operationId)
      return row ? this.decode(row) : null
    })
  }
  private summary(child: Child): ConnectionSetupInspectionReceipt {
    const receipt = structuredClone(child.receipt)
    if (receipt.request === 'dispatching' && !this.live.has(receipt.stepId)) receipt.request = 'unknown'
    return receipt
  }
  private binding(row: Parent, child: Child): string {
    const o = row.operation
    return digest({ operationId: o.operationId, connectionId: o.connectionId, revision: o.expectedConnectionRevision, adapterId: o.adapterId, application: o.application, goal: o.goal, actor: row.actor, authenticationStepId: child.authenticationStepId, ...(child.receipt.subject ? { subject: child.receipt.subject } : {}), ...(child.receipt.subject === 'publication-version' ? { versionId: child.receipt.versionId } : {}) })
  }
  private envelope(value: string | null, row: Parent, child: Child): Envelope | null {
    try {
      if (value === null) return null
      const p = JSON.parse(value) as Envelope
      if (p.binding !== this.binding(row, child) || p.stepId !== child.receipt.stepId || (p.privateState !== undefined && typeof p.privateState !== 'string' || p.authentication !== undefined && typeof p.authentication !== 'string')) return null
      if (child.receipt.request !== 'confirmed') return p.privateState === undefined && typeof p.authentication === 'string' ? p : null
      if (typeof p.privateState !== 'string') return null
      if (child.receipt.subject) {
        const summary = parseConnectionSetupReadSummary(p.readResult)
        return summary.subject === child.receipt.subject && (summary.subject !== 'publication-version' || summary.versionId === child.receipt.versionId) && p.applicationInfoReadPermission === undefined ? { ...p, readResult: summary } : null
      }
      return p.readResult === undefined && ['confirmed', 'unknown'].includes(p.applicationInfoReadPermission ?? '') ? p : null
    } catch { return null }
  }
  private currentAuthentication(row: Parent): boolean {
    const a = row.operation.authentication
    return this.owner.current(row) && a?.stage === 'confirmed' && a.request === 'confirmed' && a.secureStorage === 'stored'
  }
  private eligible(row: Parent, subject?: ConnectionSetupReadSubject): boolean {
    const adapter = this.owner.connections.registeredAdapter(row.operation.adapterId)?.setup?.applicationInspection
    return this.currentAuthentication(row) && Boolean(adapter?.domains.includes(row.operation.application.domain)) && (!subject || typeof adapter?.read === 'function')
  }
  private async source(row: Parent): Promise<Snapshot | null> {
    if (!this.currentAuthentication(row)) return null
    try {
      const snapshot = await this.owner.snapshot(row), fresh = this.owner.read(row.operation.operationId)
      return snapshot?.stage === 'confirmed' && fresh && this.currentAuthentication(fresh) && fresh.operation.authentication?.stepId === snapshot.stepId ? snapshot : null
    } catch { return null }
  }
  private latestConfigurationRead(row: Parent, subject: ConnectionSetupReadSubject, versionId?: string): Child | null {
    return this.safe(() => {
      const version = subject === 'publication-version' ? " AND json_extract(record_json,'$.receipt.versionId')=?" : ''
      const record = this.owner.connections.database.prepare("SELECT * FROM connection_setup_inspection WHERE operation_id=? AND json_extract(record_json,'$.effect') IS NULL AND json_extract(record_json,'$.receipt.subject')=?" + version + ' ORDER BY ordinal DESC LIMIT 1').get(row.operation.operationId, subject, ...(subject === 'publication-version' ? [versionId ?? ''] : []))
      return record ? this.decode(record) : null
    })
  }
  /** Pure journal predicate; selection of an older public receipt never supplies this source. */
  configurationSourceCurrent(row: Parent, source: SetupConfigurationSource): boolean {
    const latest = this.latestConfigurationRead(row, source.receipt.subject, source.receipt.versionId)
    return this.currentAuthentication(row) && row.operation.authentication?.stepId === source.authenticationStepId && latest?.receipt.stepId === source.receipt.stepId && latest.receipt.request === 'confirmed' && latest.receipt.secureStorage === 'stored'
  }
  /** Original authenticated raw read, retained only inside the Host/adapter boundary. */
  async configurationSource(row: Parent, subject: ConnectionSetupReadSubject, versionId?: string): Promise<SetupConfigurationSource | null> {
    const authentication = await this.source(row), child = this.latestConfigurationRead(row, subject, versionId)
    if (!authentication || child?.receipt.subject !== subject || child.authenticationStepId !== authentication.stepId || child.receipt.request !== 'confirmed' || child.receipt.secureStorage !== 'stored' || !child.privateRef) return null
    try {
      const original = this.envelope(await this.owner.secrets?.resolve(child.privateRef) ?? null, row, child)
      if (!original) return null
      const source: SetupConfigurationSource = { receipt: { ...structuredClone(child.receipt), subject }, authenticationStepId: authentication.stepId, attemptId: authentication.attemptId, privateState: authentication.privateState, originalReadState: original.privateState!, captureAuthentication: authentication.captureAuthentication }
      return this.configurationSourceCurrent(this.owner.read(row.operation.operationId)!, source) ? source : null
    } catch { return null }
  }
  private newAction(row: Parent, subject?: ConnectionSetupReadSubject, versionId?: string): ConnectionSetupInspectionAction {
    if (subject === 'publication-version') return { kind: 'read-publication-version', versionId: versionId!, expectedRevision: row.operation.revision, actionId: 'setup-version-read:' + digest({ binding: row.operation, actor: row.actor, previous: this.find(row.operation.operationId)?.receipt.stepId ?? null, subject, versionId }) }
    return { kind: subject ? CONNECTION_SETUP_READ_ACTIONS[subject] : 'inspect-application', expectedRevision: row.operation.revision, actionId: (subject ? 'setup-read:' : 'setup-inspect:') + digest({ binding: row.operation, actor: row.actor, previous: this.find(row.operation.operationId)?.receipt.stepId ?? null, ...(subject ? { subject } : {}) }) }
  }
  async view(row: Parent, context: ConnectionEnrollmentCallContext, selector: NonNullable<ConnectionSetupInspect['applicationInspection']> = {}): Promise<NonNullable<ConnectionSetupView['applicationInspection']>> {
    await this.owner.authority(context, row)
    const limit = selector.limit ?? 25, before = selector.cursor === undefined ? Number.MAX_SAFE_INTEGER : Number(selector.cursor)
    if (!Number.isSafeInteger(before) || before < 1 || selector.cursor !== undefined && !/^[1-9][0-9]*$/u.test(selector.cursor)) throw failure('The original observation cursor is invalid.', 'INVALID_CONNECTION_SETUP_DATA')
    const page = this.safe(() => this.owner.connections.database.prepare("SELECT * FROM connection_setup_inspection WHERE operation_id=? AND json_extract(record_json,'$.effect') IS NULL AND ordinal<? ORDER BY ordinal DESC LIMIT ?").all(row.operation.operationId, before, limit + 1))
    const selected = this.find(row.operation.operationId, selector.selectedStepId ? { stepId: selector.selectedStepId } : undefined)
    let permission: 'confirmed' | 'unknown' = 'unknown'
    let readResult: ConnectionSetupReadSummary | undefined
    const source = await this.source(row)
    if (source && selected?.authenticationStepId === source.stepId && selected.receipt.request === 'confirmed' && selected.receipt.secureStorage === 'stored' && selected.privateRef) {
      try {
        const result = this.envelope(await this.owner.secrets?.resolve(selected.privateRef) ?? null, row, selected)
        permission = result?.applicationInfoReadPermission ?? 'unknown'; readResult = result?.readResult
      } catch { /* Preserve the original safe receipt. */ }
    }
    await this.owner.authority(context, row)
    const fresh = this.owner.read(row.operation.operationId)!
    const current = source && this.currentAuthentication(fresh) && fresh.operation.authentication?.stepId === source.stepId
    if (!current) { permission = 'unknown'; readResult = undefined }
    const actions: ConnectionSetupInspectionAction[] = []
    if (selected && ['confirmed', 'unknown'].includes(selected.receipt.request) && ['storing', 'unknown'].includes(selected.receipt.secureStorage)) actions.push({ kind: 'recover-application-inspection', actionId: selected.recoveryActionId, expectedRevision: selected.receipt.input.expectedRevision })
    if (current && this.eligible(fresh)) {
      actions.push(this.newAction(fresh))
      for (const subject of readSubjects) if (this.eligible(fresh, subject)) actions.push(this.newAction(fresh, subject))
      if (selector.versionId && this.eligible(fresh, 'publication-version')) actions.push(this.newAction(fresh, 'publication-version', selector.versionId))
    }
    return { observations: page.slice(0, limit).map(r => this.summary(this.decode(r))), next: page.length > limit ? String(page[limit - 1]!.ordinal) : null, selected: selected ? this.summary(selected) : null, applicationInfoReadPermission: permission, ...(readResult ? { readResult } : {}), actions }
  }
  async attach(base: ConnectionSetupView, row: Parent, context: ConnectionEnrollmentCallContext, selector: NonNullable<ConnectionSetupInspect['applicationInspection']>): Promise<ConnectionSetupView> {
    const inspection = await this.view(row, context, selector)
    const child = inspection.selected && this.find(row.operation.operationId, { stepId: inspection.selected.stepId }), fresh = this.owner.read(row.operation.operationId)!
    const auth = base.operation?.authentication
    if (auth?.stepId !== fresh.operation.authentication?.stepId || auth?.stage !== 'confirmed' || auth.request !== 'confirmed' || auth.secureStorage !== 'stored') inspection.actions = inspection.actions.filter(action => action.kind === 'recover-application-inspection')
    // Joining two local reads must not attach a new account's permission to an old account view.
    if (!child || base.operation?.authentication?.stepId !== child.authenticationStepId || !this.currentAuthentication(fresh) || fresh.operation.authentication?.stepId !== child.authenticationStepId) { inspection.applicationInfoReadPermission = 'unknown'; delete inspection.readResult }
    return { ...base, applicationInspection: inspection }
  }
  private update(child: Child, change: Partial<Pick<ConnectionSetupInspectionReceipt, 'request' | 'secureStorage'>>, privateRef = child.privateRef): Child {
    return this.safe(() => {
      const next = { ...child, receipt: parseConnectionSetupInspectionReceipt({ ...child.receipt, ...change }), privateRef }
      const record = (c: Child) => JSON.stringify({ receipt: c.receipt, authenticationStepId: c.authenticationStepId, recoveryActionId: c.recoveryActionId })
      if (record(next) === record(child) && privateRef === child.privateRef) return child
      const changed = this.owner.connections.database.prepare('UPDATE connection_setup_inspection SET record_json=?,private_ref=? WHERE step_id=? AND record_json=? AND private_ref IS ?').run(record(next), privateRef, child.receipt.stepId, record(child), child.privateRef)
      if (changed.changes !== 1) return this.find(child.receipt.input.operationId, { stepId: child.receipt.stepId })!
      return next
    })
  }
  private async secure(row: Parent, child: Child): Promise<Child> {
    const secrets = this.owner.secrets
    if (!secrets || !['confirmed', 'unknown'].includes(child.receipt.request) || child.receipt.secureStorage === 'stored' || child.receipt.secureStorage === 'not-started') return child
    try {
      await secrets.assertAvailable()
      const operationId = 'connection-setup-inspection:' + child.receipt.stepId
      let saved = await secrets.inspect(operationId)
      const value = this.unsettled.get(child.receipt.stepId)
      if (!saved && value) saved = await secrets.store({ operationId, secret: JSON.stringify(value) })
      if (!saved) return child
      const envelope = this.envelope(await secrets.resolve(saved.credentialRef), row, child)
      if (!envelope) return child
      this.owner.acceptAuthentication(row, envelope.authentication, child.receipt.stepId, child.authenticationStepId, saved.credentialRef)
      child = this.update(this.find(row.operation.operationId, { stepId: child.receipt.stepId })!, { secureStorage: 'stored' }, saved.credentialRef)
      this.unsettled.delete(child.receipt.stepId)
      return child
    } catch {
      const fresh = this.find(row.operation.operationId, { stepId: child.receipt.stepId })!
      return fresh.receipt.secureStorage === 'stored' ? fresh : this.update(fresh, { secureStorage: 'unknown' })
    }
  }
  private async result(child: Child, input: ConnectionSetupAdvance, context: ConnectionEnrollmentCallContext): Promise<ConnectionSetupView> {
    const row = this.owner.read(input.operationId)!
    return { ...await this.attach(await this.owner.view(row, context), row, context, { selectedStepId: child.receipt.stepId }), receipt: { actionId: input.decision.actionId, stepId: child.receipt.stepId, state: this.summary(child).request } }
  }
  async advance(input: ConnectionSetupAdvance, context: ConnectionEnrollmentCallContext): Promise<ConnectionSetupView | null> {
    const row = this.owner.read(input.operationId)!
    await this.owner.authority(context, row)
    let original = this.find(input.operationId, { actionId: input.decision.actionId })
    const repeat = async (child: Child) => {
      const expected = input.decision.actionId === child.recoveryActionId ? { ...child.receipt.input, decision: { actionId: child.recoveryActionId, value: 'continue' } } : child.receipt.input
      if (!same(input, expected)) throw failure('This observation action has different frozen original input.', 'CONNECTION_OPERATION_CONFLICT')
      const running = this.pending.get(child.receipt.stepId); if (running) await running
      child = this.find(input.operationId, { stepId: child.receipt.stepId })!
      return this.result(await this.secure(row, child), input, context)
    }
    // Original local recovery precedes all current-auth, revision and adapter predicates.
    if (original) return repeat(original)
    const subject = input.versionId ? 'publication-version' : readSubjects.find(subject => this.newAction(row, subject).actionId === input.decision.actionId)
    const action = this.newAction(row, subject, input.versionId)
    if (input.decision.actionId !== action.actionId) return null
    if (input.expectedRevision !== action.expectedRevision || input.decision.value !== 'continue') throw failure('This offered application observation action is stale.', 'CONNECTION_SETUP_ACTION_STALE')
    const source = await this.source(row)
    await this.owner.authority(context, row)
    original = this.find(input.operationId, { actionId: input.decision.actionId })
    if (original) return repeat(original)
    if (!source || !this.eligible(this.owner.read(input.operationId)!, subject)) throw failure('The exact current confirmed management snapshot is unconfirmed. Retain the original observation; existing bots and local recovery remain available.')
    const db = this.owner.connections.database
    const admission = this.safe(() => {
      db.exec('BEGIN IMMEDIATE')
      try {
        const existing = this.find(input.operationId, { actionId: input.decision.actionId })
        if (existing) { db.exec('COMMIT'); return { child: existing, claimed: false } }
        const fresh = this.owner.read(input.operationId)!
        if (!this.eligible(fresh, subject) || fresh.operation.authentication?.stepId !== source.stepId || fresh.operation.revision !== input.expectedRevision || this.newAction(fresh, subject, input.versionId).actionId !== input.decision.actionId) throw failure('The original observation target or authentication changed.', 'CONNECTION_SETUP_ACTION_STALE')
        const receipt: ConnectionSetupInspectionReceipt = { stepId: randomUUID(), input, request: 'dispatching', secureStorage: 'not-started', ...(subject ? { subject } : {}), ...(subject === 'publication-version' ? { versionId: input.versionId } : {}) }
        const child: Child = { receipt, authenticationStepId: source.stepId, recoveryActionId: 'setup-inspection-recover:' + digest(receipt), privateRef: null }
        db.prepare('INSERT INTO connection_setup_inspection(step_id,operation_id,action_id,recovery_action_id,record_json) VALUES(?,?,?,?,?)').run(receipt.stepId, input.operationId, input.decision.actionId, child.recoveryActionId, JSON.stringify({ receipt, authenticationStepId: child.authenticationStepId, recoveryActionId: child.recoveryActionId }))
        this.owner.touch(fresh); db.exec('COMMIT'); return { child, claimed: true }
      } catch (error) { db.exec('ROLLBACK'); throw error }
    })
    if (!admission.claimed) return repeat(admission.child)
    this.live.add(admission.child.receipt.stepId)
    const work = this.run(row, admission.child, source, input, context)
    this.pending.set(admission.child.receipt.stepId, work)
    try { return await work } finally { this.pending.delete(admission.child.receipt.stepId); this.live.delete(admission.child.receipt.stepId) }
  }
  private async run(row: Parent, child: Child, source: Snapshot, input: ConnectionSetupAdvance, context: ConnectionEnrollmentCallContext): Promise<ConnectionSetupView> {
    let value: Envelope | null = null
    let authentication: string | undefined
    try {
      await this.owner.authority(context, row)
      const fresh = this.owner.read(input.operationId)!, adapter = this.owner.connections.registeredAdapter(row.operation.adapterId)?.setup?.applicationInspection
      if (this.eligible(fresh, child.receipt.subject) && fresh.operation.authentication?.stepId === source.stepId && adapter) {
        const target = { operationId: input.operationId, connectionId: row.operation.connectionId, attemptId: source.attemptId, application: row.operation.application, privateState: source.privateState }
        if (child.receipt.subject && adapter.read) {
          const receipt = await adapter.read({ ...target, subject: child.receipt.subject, ...(child.receipt.subject === 'publication-version' ? { versionId: child.receipt.versionId } : {}) }, context.signal)
          if (typeof receipt.authentication === 'string') authentication = source.captureAuthentication(receipt.authentication, child.receipt.stepId)
          if (receipt.kind === 'observed' && typeof receipt.privateState === 'string') {
            const readResult = parseConnectionSetupReadSummary(receipt.readResult)
            if (readResult.subject === child.receipt.subject && (readResult.subject !== 'publication-version' || readResult.versionId === child.receipt.versionId)) value = { binding: this.binding(row, child), stepId: child.receipt.stepId, readResult, privateState: receipt.privateState }
          }
        } else if (!child.receipt.subject) {
          const receipt = await adapter.inspect(target, context.signal)
          if (typeof receipt.authentication === 'string') authentication = source.captureAuthentication(receipt.authentication, child.receipt.stepId)
          if (receipt.kind === 'observed' && ['confirmed', 'unknown'].includes(receipt.applicationInfoReadPermission) && typeof receipt.privateState === 'string') value = { binding: this.binding(row, child), stepId: child.receipt.stepId, applicationInfoReadPermission: receipt.applicationInfoReadPermission, privateState: receipt.privateState }
        }
      }
    } catch { /* Keep this exact preclaim unknown. No native replay or health inference. */ }
    if (this.closed) return { operation: row.operation, challenge: null, reason: 'challenge-unavailable', receipt: { actionId: input.decision.actionId, stepId: child.receipt.stepId, state: 'unknown' } }
    if (!value && !authentication) child = this.update(child, { request: 'unknown' })
    else {
      const confirmed = Boolean(value)
      value = { ...(value ?? { binding: this.binding(row, child), stepId: child.receipt.stepId }), ...(authentication ? { authentication } : {}) }
      this.unsettled.set(child.receipt.stepId, value)
      child = this.update(child, { request: confirmed ? 'confirmed' : 'unknown', secureStorage: 'storing' })
      child = await this.secure(row, child)
    }
    return this.result(child, input, context)
  }
}
