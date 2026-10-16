import { createHash, randomUUID } from 'node:crypto'
import { AgentMuxError } from '@agentmux/core'
import { parseConnectionSetupAccount, parseConnectionSetupAuthentication, parseConnectionSetupChallenge, parseConnectionSetupOperation, parseConnectionSetupParams, type ConnectionEnrollmentCallContext, type ConnectionSetupAdvance, type ConnectionSetupAuthenticationAction, type ConnectionSetupBegin, type ConnectionSetupInspect, type ConnectionSetupListing, type ConnectionSetupOperation, type ConnectionSetupPort, type ConnectionSetupView } from '@agentmux/core/connections'
import type { ConnectionHost } from './connection-host.js'
import type { EnrollmentSecrets } from './connection-enrollment-adapter.js'
import { SetupApplicationInspection } from './connection-setup-inspection.js'
import { SetupApplicationConfiguration } from './connection-setup-configuration.js'
import type { EnrollmentSetupSnapshot } from './connection-enrollment.js'

type Row = { operation: ConnectionSetupOperation; actor: ConnectionEnrollmentCallContext['actor']; privateRef: string | null }
type PrivateEnvelope = { operationId: string; connectionId: string; attemptId: string; challenge: ConnectionSetupView['challenge']; privateState: string; source?: NonNullable<ConnectionSetupBegin['source']>; sourceAuthAttemptId?: string; localAccount?: ReturnType<typeof parseConnectionSetupAccount> }
type Authentication = NonNullable<ConnectionSetupOperation['authentication']>
type AuthStep = { operationId: string; input: ConnectionSetupAdvance; authentication: Authentication; privateRef: string | null }
export type SetupAuthenticationSource = { stepId: string; attemptId: string; stage: string; privateState: string; captureAuthentication: (privateState: string, childStepId: string) => string }
type AuthEnvelope = PrivateEnvelope & { stepId: string; stage: Authentication['stage']; account: ReturnType<typeof parseConnectionSetupAccount> | null }
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const sameActor = (a: ConnectionEnrollmentCallContext['actor'], b: ConnectionEnrollmentCallContext['actor']) => a.kind === b.kind && a.id === b.id
const failure = (message: string, code = 'CONNECTION_SETUP_UNCONFIRMED') => new AgentMuxError(message, code)
const admitted = (o: ConnectionSetupOperation): ConnectionSetupBegin => ({ operationId: o.operationId, connectionId: o.connectionId, expectedConnectionRevision: o.expectedConnectionRevision, goal: o.goal, ...(o.source ? { source: o.source } : {}) })

/** Finite authentication intent in the original Connection DB. Never owns current bot configuration. */
export class ConnectionSetupHost implements ConnectionSetupPort {
  private closed = false
  private readonly pending = new Map<string, Promise<ConnectionSetupView>>()
  private readonly nativeRequests = new Set<string>()
  private readonly unsettled = new Map<string, PrivateEnvelope>()
  private readonly unsettledAuthentication = new Map<string, AuthEnvelope>()
  private readonly inspection: SetupApplicationInspection
  private readonly configuration: SetupApplicationConfiguration
  constructor(private readonly connections: ConnectionHost, private readonly secrets?: EnrollmentSecrets, private readonly enrollmentSource?: (source: NonNullable<ConnectionSetupBegin['source']>, target: Pick<ConnectionSetupOperation, 'connectionId' | 'adapterId' | 'application'>, context: ConnectionEnrollmentCallContext) => Promise<EnrollmentSetupSnapshot>) {
    connections.database.exec('CREATE TABLE IF NOT EXISTS connection_setup_operation (ordinal INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT UNIQUE NOT NULL, connection_id TEXT NOT NULL, actor_json TEXT NOT NULL, record_json TEXT NOT NULL, private_ref TEXT)')
    connections.database.exec('CREATE INDEX IF NOT EXISTS connection_setup_by_connection ON connection_setup_operation(connection_id,ordinal)')
    connections.database.exec("CREATE INDEX IF NOT EXISTS connection_setup_by_application ON connection_setup_operation(json_extract(record_json,'$.application.domain'),json_extract(record_json,'$.application.appId'))")
    connections.database.exec('CREATE TABLE IF NOT EXISTS connection_setup_auth_step (ordinal INTEGER PRIMARY KEY AUTOINCREMENT, step_id TEXT UNIQUE NOT NULL, operation_id TEXT NOT NULL, action_id TEXT UNIQUE NOT NULL, input_json TEXT NOT NULL, record_json TEXT NOT NULL, private_ref TEXT)')
    connections.database.exec('CREATE INDEX IF NOT EXISTS connection_setup_auth_by_operation ON connection_setup_auth_step(operation_id,ordinal)')
    this.inspection = new SetupApplicationInspection({ connections, secrets, read: id => this.read(id), authority: (context, row) => this.authority(context, row), current: row => this.current(row), snapshot: row => this.authenticationSource(row), acceptAuthentication: (row, field, childStepId, authStepId, ref) => this.acceptAuthentication(row, field, childStepId, authStepId, ref), touch: row => this.touch(row), view: (row, context) => this.view(row, context) })
    this.configuration = new SetupApplicationConfiguration({ connections, secrets, inspection: this.inspection, creator: row => this.creator(row), acceptAuthentication: (row, field, childStepId, authStepId, ref) => this.acceptAuthentication(row, field, childStepId, authStepId, ref), read: id => this.read(id), authority: (context, row) => this.authority(context, row), current: row => this.current(row), touch: row => this.touch(row), view: (row, context) => this.view(row, context) })
  }
  close(): void { this.closed = true; this.nativeRequests.clear(); this.unsettled.clear(); this.unsettledAuthentication.clear(); this.inspection.close(); this.configuration.close() }
  private safe<T>(run: () => T): T {
    try { return run() } catch (error) {
      if (error instanceof AgentMuxError) throw error
      throw failure('The original management request storage is unconfirmed. Retain its identity and inspect it after storage is available. Existing bots and Agents remain available.')
    }
  }
  private read(operationId: string): Row | null {
    return this.safe(() => {
      const row = this.connections.database.prepare('SELECT actor_json,record_json,private_ref FROM connection_setup_operation WHERE operation_id=?').get(operationId)
      if (!row) return null
      const operation = parseConnectionSetupOperation(JSON.parse(String(row.record_json)))
      const latest = this.authStep(operationId)
      if (latest) operation.authentication = latest.authentication
      return { operation, actor: JSON.parse(String(row.actor_json)), privateRef: row.private_ref === null ? null : String(row.private_ref) }
    })
  }
  private async authority(context: ConnectionEnrollmentCallContext, row?: Row | null): Promise<void> {
    if (!context?.actor || !['user', 'device', 'agent'].includes(context.actor.kind) || !context.actor.id || row && !sameActor(row.actor, context.actor)) throw failure('This management request belongs to its original transport-approved actor.', 'CONNECTION_SETUP_AUTHORITY_REQUIRED')
    context.signal?.throwIfAborted(); await context.assertCurrent?.()
    if (this.closed) throw failure('The original management owner is closed. Continue the same request on its executing Host.')
  }
  private authStep(operationId: string, actionId?: string): AuthStep | null {
    return this.safe(() => {
      const row = actionId === undefined
        ? this.connections.database.prepare('SELECT * FROM connection_setup_auth_step WHERE operation_id=? ORDER BY ordinal DESC LIMIT 1').get(operationId)
        : this.connections.database.prepare('SELECT * FROM connection_setup_auth_step WHERE action_id=?').get(actionId)
      if (!row) return null
      const input = parseConnectionSetupParams('connection.setup.advance', JSON.parse(String(row.input_json)))
      const authentication = parseConnectionSetupAuthentication(JSON.parse(String(row.record_json)))
      if (row.operation_id !== operationId || input.operationId !== operationId || row.action_id !== input.decision.actionId || row.step_id !== authentication.stepId) throw failure('The original authentication step has different identity.', 'CONNECTION_OPERATION_CONFLICT')
      return { operationId, input, authentication, privateRef: row.private_ref === null ? null : String(row.private_ref) }
    })
  }
  private actions(row: Row, stage: Authentication['stage'], account: AuthEnvelope['account']): ConnectionSetupAuthenticationAction[] {
    const auth = row.operation.authentication
    if (auth?.request === 'dispatching' && this.nativeRequests.has(auth.stepId)) return []
    if (auth?.request === 'confirmed' && auth.secureStorage !== 'stored') {
      const step = this.authStep(row.operation.operationId)
      return step ? [{ actionId: step.input.decision.actionId, expectedRevision: step.input.expectedRevision, kind: step.input.decision.value === 'confirm' ? 'confirm-account' : step.input.decision.value }] : []
    }
    const kinds: ConnectionSetupAuthenticationAction['kind'][] = stage === 'account' ? ['confirm-account', 'renew'] : ['waiting', 'scanned', 'handoff'].includes(stage) ? ['continue', 'renew'] : ['renew']
    return kinds.map(kind => ({ kind, expectedRevision: row.operation.revision, actionId: 'setup:' + createHash('sha256').update(JSON.stringify({ intent: admitted(row.operation), actor: row.actor, application: row.operation.application, revision: row.operation.revision, attempt: auth?.attemptId ?? row.operation.request.attemptId, account: account ? { userId: account.userId, tenantId: account.tenantId } : null, kind })).digest('hex') }))
  }
  private authEnvelope(value: string | null, row: Row, step: AuthStep): AuthEnvelope | null {
    try {
      if (value === null) return null
      const saved = JSON.parse(value), continuation = typeof saved.authentication === 'string' ? JSON.parse(saved.authentication) : null
      if (continuation && (continuation.binding !== this.authenticationBinding(row) || typeof continuation.childStepId !== 'string' || typeof continuation.sourceRef !== 'string')) return null
      const p = (continuation ? continuation.snapshot : saved) as AuthEnvelope
      if (p.operationId !== row.operation.operationId || p.connectionId !== row.operation.connectionId || p.stepId !== step.authentication.stepId || p.attemptId !== step.authentication.attemptId || typeof p.privateState !== 'string' || p.stage !== step.authentication.stage) return null
      const account = p.account === null ? null : parseConnectionSetupAccount(p.account)
      if (['account', 'confirmed'].includes(p.stage) !== Boolean(account)) return null
      return { operationId: p.operationId, connectionId: p.connectionId, stepId: p.stepId, attemptId: p.attemptId, privateState: p.privateState, stage: p.stage, account, challenge: p.challenge === null ? null : parseConnectionSetupChallenge(p.challenge) }
    } catch { return null }
  }
  private authenticationBinding(row: Row): string {
    return createHash('sha256').update(JSON.stringify({ intent: admitted(row.operation), actor: row.actor, adapterId: row.operation.adapterId, application: row.operation.application })).digest('hex')
  }
  private async authenticationSource(row: Row): Promise<SetupAuthenticationSource | null> {
    const source = this.authStep(row.operation.operationId)
    if (!this.secrets || !source?.privateRef || source.authentication.secureStorage !== 'stored') return null
    const snapshot = this.authEnvelope(await this.secrets.resolve(source.privateRef), row, source)
    if (!snapshot) return null
    return { ...snapshot, captureAuthentication: (privateState, childStepId) => JSON.stringify({ binding: this.authenticationBinding(row), childStepId, sourceRef: source.privateRef, snapshot: { ...snapshot, privateState } }) }
  }
  /** Adopt only this owner's saved field; business children never interpret the authentication schema. */
  private acceptAuthentication(row: Row, field: string | undefined, childStepId: string, authenticationStepId: string, credentialRef: string): void {
    if (field === undefined) return
    const value = JSON.parse(field), original = this.authStep(row.operation.operationId)
    if (value.binding !== this.authenticationBinding(row) || value.childStepId !== childStepId || typeof value.sourceRef !== 'string' || value.snapshot?.stepId !== authenticationStepId) throw failure('The original authentication continuation is unconfirmed. Retain its saved result for local recovery.')
    // A late result still belongs to its child, but cannot replace a newer account or Cookie snapshot.
    if (!original || original.authentication.stepId !== authenticationStepId || !this.current(this.read(row.operation.operationId)!) || original.privateRef !== value.sourceRef) return
    if (!this.authEnvelope(JSON.stringify(value.snapshot), row, original) || value.snapshot.stage !== 'confirmed') throw failure('The original confirmed authentication continuation is unconfirmed. Retain its saved result for local recovery.')
    this.updateAuth(original, () => {}, credentialRef)
  }
  private async authenticationSnapshot(row: Row): Promise<AuthEnvelope | null> {
    if (!this.secrets) return null
    const step = this.authStep(row.operation.operationId)
    if (step) return step.privateRef && step.authentication.secureStorage === 'stored' ? this.authEnvelope(await this.secrets.resolve(step.privateRef), row, step) : null
    const original = row.privateRef ? this.envelope(await this.secrets.resolve(row.privateRef), row) : null
    return original ? { ...original, stepId: original.attemptId, stage: original.localAccount ? 'account' : 'waiting', account: original.localAccount ?? null } : null
  }
  private async authenticationView(row: Row, context: ConnectionEnrollmentCallContext): Promise<ConnectionSetupView> {
    const operation = this.summary(row), auth = operation.authentication!
    let snapshot: AuthEnvelope | null = null
    try { snapshot = await this.authenticationSnapshot(row) } catch { /* Exact snapshot remains unconfirmed, never a fresh platform request. */ }
    await this.authority(context, row)
    if (!this.current(row)) return { operation, challenge: null, reason: 'connection-revised' }
    const fresh = this.read(row.operation.operationId)
    if (!fresh || fresh.operation.revision !== row.operation.revision) return { operation: fresh ? this.summary(fresh) : operation, challenge: null, reason: 'challenge-unavailable' }
    const stage = snapshot?.stage ?? (auth.request === 'dispatching' && this.nativeRequests.has(auth.stepId) ? 'handoff' : 'unknown')
    const challenge = snapshot?.challenge && (snapshot.challenge.expiresAt === null || snapshot.challenge.expiresAt > Date.now()) ? snapshot.challenge : null
    return { operation, challenge, ...(!snapshot ? { reason: 'challenge-unavailable' as const } : {}), continuation: { stage, account: snapshot?.account ?? null, actions: this.actions(row, stage, snapshot?.account ?? null) } }
  }
  private touch(row: Row): void {
    const operation = structuredClone(row.operation); delete operation.authentication; operation.revision++
    const changed = this.connections.database.prepare("UPDATE connection_setup_operation SET record_json=? WHERE operation_id=? AND json_extract(record_json,'$.revision')=?").run(JSON.stringify(operation), operation.operationId, row.operation.revision)
    if (changed.changes !== 1) throw failure('The original authentication intent changed. Read that same request.', 'CONNECTION_OPERATION_CONFLICT')
  }
  private updateAuth(step: AuthStep, change: (auth: Authentication) => void, privateRef = step.privateRef): AuthStep {
    return this.safe(() => {
      const db = this.connections.database, next = structuredClone(step.authentication); change(next); parseConnectionSetupAuthentication(next)
      if (same(next, step.authentication) && privateRef === step.privateRef) return this.authStep(step.operationId, step.input.decision.actionId)!
      db.exec('BEGIN IMMEDIATE')
      try {
        const changed = db.prepare('UPDATE connection_setup_auth_step SET record_json=?,private_ref=? WHERE step_id=? AND record_json=? AND private_ref IS ?').run(JSON.stringify(next), privateRef, next.stepId, JSON.stringify(step.authentication), step.privateRef)
        if (changed.changes !== 1) throw failure('The original authentication step changed. Read it without replacing its identity.', 'CONNECTION_OPERATION_CONFLICT')
        const row = this.read(step.operationId)!
        if (row.operation.authentication?.stepId === next.stepId) this.touch(row)
        db.exec('COMMIT'); return { ...step, authentication: next, privateRef }
      } catch (error) { db.exec('ROLLBACK'); throw error }
    })
  }
  private authSecretOperation(step: AuthStep): string { return `connection-setup-step:${step.authentication.stepId}` }
  private async secureAuthentication(step: AuthStep): Promise<AuthStep> {
    if (!this.secrets || step.authentication.request !== 'confirmed' || step.authentication.secureStorage === 'stored') return step
    try {
      await this.secrets.assertAvailable()
      let saved = await this.secrets.inspect(this.authSecretOperation(step))
      const live = this.unsettledAuthentication.get(step.authentication.stepId)
      if (!saved && live) saved = await this.secrets.store({ operationId: this.authSecretOperation(step), secret: JSON.stringify(live) })
      const row = this.read(step.operationId)!
      if (!saved || !this.authEnvelope(await this.secrets.resolve(saved.credentialRef), row, step)) return step
      step = this.updateAuth(step, auth => { auth.secureStorage = 'stored' }, saved.credentialRef)
      this.unsettledAuthentication.delete(step.authentication.stepId)
      return step
    } catch {
      // Another original reader may have completed this same immutable handoff.
      // Retain its authoritative receipt instead of downgrading it with our stale row.
      const current = this.authStep(step.operationId, step.input.decision.actionId)!
      return current.authentication.secureStorage === 'stored' ? current : this.updateAuth(current, auth => { auth.secureStorage = 'unknown' })
    }
  }
  private async advanceView(step: AuthStep, context: ConnectionEnrollmentCallContext): Promise<ConnectionSetupView> {
    const row = this.read(step.operationId)!
    const state = step.authentication.request === 'dispatching' && !this.nativeRequests.has(step.authentication.stepId) ? 'unknown' : step.authentication.request
    return { ...await this.view(row, context), receipt: { actionId: step.input.decision.actionId, stepId: step.authentication.stepId, state } }
  }
  async advance(value: ConnectionSetupAdvance, context: ConnectionEnrollmentCallContext): Promise<ConnectionSetupView> {
    const input = parseConnectionSetupParams('connection.setup.advance', value)
    let row = this.read(input.operationId)
    if (!row) throw failure('The exact original management request is unknown.', 'UNKNOWN_CONNECTION_OPERATION')
    await this.authority(context, row)
    const configured = await this.configuration.advance(input, context)
    if (configured) return configured
    const inspected = await this.inspection.advance(input, context)
    if (inspected) return inspected
    if (!this.current(row)) throw failure('The exact saved bot revision changed. The original management intent is retained.', 'CONNECTION_REVISION_CONFLICT')
    const key = 'advance:' + input.decision.actionId
    let previous = this.authStep(input.operationId, input.decision.actionId)
    if (previous) {
      if (!same(previous.input, input)) throw failure('This authentication action has different original input.', 'CONNECTION_OPERATION_CONFLICT')
      const running = this.pending.get(key)
      if (running) await running
      previous = this.authStep(input.operationId, input.decision.actionId)!
      // Duplicate delivery can finish only its original local encrypted handoff.
      previous = await this.secureAuthentication(previous)
      return this.advanceView(previous, context)
    }
    const visible = await this.view(row, context)
    const action = visible.continuation?.actions.find(action => action.actionId === input.decision.actionId && action.expectedRevision === input.expectedRevision)
    const kind = input.decision.value === 'confirm' ? 'confirm-account' : input.decision.value
    if (!action || action.kind !== kind) throw failure('This authentication action is stale or has different scope. Read the original request.', 'CONNECTION_SETUP_ACTION_STALE')
    let snapshot: AuthEnvelope | null = null
    try {
      if (!this.secrets) throw new Error()
      await this.secrets.assertAvailable()
      if (kind !== 'renew') snapshot = await this.authenticationSnapshot(row)
    } catch { throw failure('Secure management storage is unavailable. The original request and saved bot remain available.') }
    await this.authority(context, row)
    if (kind !== 'renew' && !snapshot || kind === 'confirm-account' && (snapshot?.stage !== 'account' || !snapshot.account)) throw failure('The exact original account confirmation snapshot is unconfirmed. Retain its original action.')
    const db = this.connections.database
    const admission = this.safe(() => {
      db.exec('BEGIN IMMEDIATE')
      try {
        const existing = this.authStep(input.operationId, input.decision.actionId)
        if (existing) { if (!same(existing.input, input)) throw failure('The authentication action input changed.', 'CONNECTION_OPERATION_CONFLICT'); db.exec('COMMIT'); return { step: existing, claimed: false } }
        row = this.read(input.operationId)!
        if (row.operation.revision !== input.expectedRevision) throw failure('The original action revision changed. Read the same request before continuing.', 'CONNECTION_OPERATION_CONFLICT')
        if (!this.current(row)) throw failure('The exact saved bot changed. The original management intent is retained.', 'CONNECTION_REVISION_CONFLICT')
        const authentication: Authentication = { attemptId: kind === 'renew' ? randomUUID() : snapshot!.attemptId, stepId: randomUUID(), stage: 'handoff', request: 'dispatching', secureStorage: 'not-started' }
        db.prepare('INSERT INTO connection_setup_auth_step(step_id,operation_id,action_id,input_json,record_json) VALUES(?,?,?,?,?)').run(authentication.stepId, input.operationId, input.decision.actionId, JSON.stringify(input), JSON.stringify(authentication))
        this.touch(row); db.exec('COMMIT')
        return { step: { operationId: input.operationId, input, authentication, privateRef: null } as AuthStep, claimed: true }
      } catch (error) { db.exec('ROLLBACK'); throw error }
    })
    let step = admission.step
    // A competing caller may have admitted this same action while private storage yielded.
    const running = this.pending.get(key)
    if (running) { await running; return this.advanceView(this.authStep(input.operationId, input.decision.actionId)!, context) }
    if (!admission.claimed) return this.advanceView(await this.secureAuthentication(step), context)
    if (step.authentication.request !== 'dispatching' || step.authentication.secureStorage !== 'not-started') return this.advanceView(await this.secureAuthentication(step), context)
    const work = this.runAuthentication(step, snapshot, context)
    this.pending.set(key, work)
    try { return await work } finally { this.pending.delete(key) }
  }
  private async runAuthentication(step: AuthStep, source: AuthEnvelope | null, context: ConnectionEnrollmentCallContext): Promise<ConnectionSetupView> {
    const row = this.read(step.operationId)!, adapter = this.connections.registeredAdapter(row.operation.adapterId)?.setup
    await this.authority(context, row)
    if (!this.current(row) || row.operation.authentication?.stepId !== step.authentication.stepId || step.input.decision.value !== 'confirm' && !adapter?.domains.includes(row.operation.application.domain)) return this.advanceView(this.updateAuth(step, a => { a.request = 'unknown'; a.stage = 'unknown' }), context)
    let snapshot: AuthEnvelope | null = null
    const input = { operationId: row.operation.operationId, connectionId: row.operation.connectionId, attemptId: step.authentication.attemptId, application: row.operation.application }
    this.nativeRequests.add(step.authentication.stepId)
    try {
      if (step.input.decision.value === 'confirm') {
        if (!source?.account || source.stage !== 'account') throw new Error()
        snapshot = { ...source, ...input, stepId: step.authentication.stepId, stage: 'confirmed', challenge: null }
      } else if (step.input.decision.value === 'renew') {
        const timeout = AbortSignal.timeout(20_000), signal = context.signal ? AbortSignal.any([context.signal, timeout]) : timeout
        const receipt = await adapter!.begin(input, signal)
        if (receipt.kind === 'challenge') snapshot = { ...input, stepId: step.authentication.stepId, stage: 'waiting', account: null, challenge: parseConnectionSetupChallenge(receipt.challenge), privateState: receipt.privateState }
      } else if (source) {
        const receipt = await adapter!.advance({ ...input, privateState: source.privateState }, context.signal)
        if (receipt.kind === 'progress' && ['waiting', 'scanned', 'handoff', 'account', 'expired'].includes(receipt.stage)) {
          const account = receipt.account === null ? null : parseConnectionSetupAccount(receipt.account)
          const challenge = receipt.challenge === null ? null : parseConnectionSetupChallenge(receipt.challenge)
          if ((receipt.stage === 'account') !== Boolean(account) || !['waiting', 'scanned'].includes(receipt.stage) && challenge !== null) throw new Error()
          snapshot = { ...input, stepId: step.authentication.stepId, stage: receipt.stage, account, challenge, privateState: receipt.privateState }
        }
      }
    } catch { /* This exact claimed step remains unconfirmed; no new platform request repairs it. */ }
    finally { this.nativeRequests.delete(step.authentication.stepId) }
    if (this.closed) return { operation: this.summary(row), challenge: null, reason: 'challenge-unavailable', receipt: { actionId: step.input.decision.actionId, stepId: step.authentication.stepId, state: 'unknown' } }
    if (!snapshot || typeof snapshot.privateState !== 'string') return this.advanceView(this.updateAuth(step, a => { a.request = 'unknown'; a.stage = 'unknown' }), context)
    this.unsettledAuthentication.set(step.authentication.stepId, snapshot)
    step = this.updateAuth(step, a => { a.request = 'confirmed'; a.stage = snapshot!.stage; a.secureStorage = 'storing' })
    return this.advanceView(await this.secureAuthentication(step), context)
  }
  private current(row: Row): boolean {
    const current = this.connections.readConfiguration(row.operation.connectionId)
    return current?.revision === row.operation.expectedConnectionRevision && current.config.adapterId === row.operation.adapterId && same(current.config.application, row.operation.application)
  }
  private save(row: Row, change: (operation: ConnectionSetupOperation) => void, privateRef = row.privateRef): Row {
    return this.safe(() => {
      const operation = structuredClone(row.operation); change(operation)
      if (same(operation, row.operation) && privateRef === row.privateRef) {
        const current = this.read(row.operation.operationId)
        if (!current) throw failure('The original management record is unconfirmed. Retain its identity and inspect it after storage is available.')
        return current
      }
      operation.revision++
      parseConnectionSetupOperation(operation)
      const stored = { ...operation }; delete stored.authentication
      const result = this.connections.database.prepare("UPDATE connection_setup_operation SET record_json=?,private_ref=? WHERE operation_id=? AND json_extract(record_json,'$.revision')=?").run(JSON.stringify(stored), privateRef, operation.operationId, row.operation.revision)
      if (result.changes !== 1) throw failure('The original management request changed. Read that same request before continuing.', 'CONNECTION_OPERATION_CONFLICT')
      return { ...row, operation, privateRef }
    })
  }
  private summary(row: Row): ConnectionSetupOperation {
    const operation = structuredClone(row.operation)
    // A durable preclaim is not a live dispatcher or an ACK. A fresh owner reports
    // the unresolved outcome without rewriting that original claim or replaying it.
    if (operation.request.state === 'dispatching' && !this.nativeRequests.has(operation.request.attemptId!)) {
      operation.request.state = 'unknown'
      operation.reason = 'request-unconfirmed'
    }
    if (operation.authentication?.request === 'dispatching' && !this.nativeRequests.has(operation.authentication.stepId)) {
      operation.authentication.request = 'unknown'; operation.authentication.stage = 'unknown'
    }
    return operation
  }
  private async view(row: Row | null, context: ConnectionEnrollmentCallContext): Promise<ConnectionSetupView> {
    await this.authority(context, row)
    if (!row) return { operation: null, challenge: null }
    const operation = this.summary(row)
    if (!this.current(row)) return { operation, challenge: null, reason: 'connection-revised' }
    if (operation.authentication) return this.authenticationView(row, context)
    if (operation.secureStorage !== 'stored' || !row.privateRef || !this.secrets) return { operation, challenge: null, ...(operation.request.state === 'confirmed' ? { reason: 'challenge-unavailable' as const } : {}), continuation: { stage: 'unknown', account: null, actions: operation.request.state === 'unknown' && !operation.source ? this.actions(row, 'unknown', null) : [] } }
    try {
      const value = await this.secrets.resolve(row.privateRef)
      const envelope = this.envelope(value, row)
      if (!envelope || !envelope.localAccount && (!envelope.challenge || envelope.challenge.expiresAt !== null && envelope.challenge.expiresAt <= Date.now())) return { operation, challenge: null, reason: 'challenge-unavailable' }
      await this.authority(context, row)
      // Credential service calls can yield; a later configuration cannot receive this challenge.
      if (this.closed || !this.current(row)) return { operation, challenge: null, reason: 'connection-revised' }
      const fresh = this.read(row.operation.operationId)
      if (!fresh || fresh.operation.revision !== row.operation.revision) return { operation: fresh ? this.summary(fresh) : operation, challenge: null, reason: 'challenge-unavailable' }
      const account = envelope.localAccount ?? null, stage = account ? 'account' as const : 'waiting' as const
      return { operation, challenge: envelope.challenge, continuation: { stage, account, actions: this.actions(row, stage, account) } }
    } catch { return { operation, challenge: null, reason: 'challenge-unavailable' } }
  }
  private envelope(value: string | null, row: Row): PrivateEnvelope | null {
    try {
      if (value === null) return null
      const p = JSON.parse(value) as PrivateEnvelope
      if (p.operationId !== row.operation.operationId || p.connectionId !== row.operation.connectionId || p.attemptId !== row.operation.request.attemptId || typeof p.privateState !== 'string') return null
      if (row.operation.request.kind === 'enrollment-handoff') {
        if (!row.operation.source || !same(p.source, row.operation.source) || typeof p.sourceAuthAttemptId !== 'string' || !p.sourceAuthAttemptId || p.challenge !== null) return null
        return { operationId: p.operationId, connectionId: p.connectionId, attemptId: p.attemptId, challenge: null, privateState: p.privateState, source: row.operation.source, sourceAuthAttemptId: p.sourceAuthAttemptId, localAccount: parseConnectionSetupAccount(p.localAccount) }
      }
      return { operationId: p.operationId, connectionId: p.connectionId, attemptId: p.attemptId, challenge: parseConnectionSetupChallenge(p.challenge), privateState: p.privateState }
    } catch { return null }
  }
  private secretOperation(row: Row): string { return `connection-setup-auth:${row.operation.request.attemptId!}` }
  private async secure(row: Row, admission?: { context: ConnectionEnrollmentCallContext; source: EnrollmentSetupSnapshot }): Promise<Row> {
    if (!this.secrets || !row.operation.request.attemptId) return row
    try {
      await this.secrets.assertAvailable()
      let saved = await this.secrets.inspect(this.secretOperation(row))
      const live = this.unsettled.get(row.operation.operationId)
      if (!saved && live?.attemptId === row.operation.request.attemptId) {
        if (row.operation.source) {
          // Only a new store needs the still-current source; an existing Vault commit is independent.
          if (!admission) return row
          await this.authority(admission.context, row)
          admission.source.assertCurrent()
          if (!this.current(row)) return row
          const current = this.read(row.operation.operationId)
          if (!current || current.operation.revision !== row.operation.revision || current.operation.request.attemptId !== row.operation.request.attemptId) return current ?? row
        }
        saved = await this.secrets.store({ operationId: this.secretOperation(row), secret: JSON.stringify(live) })
      }
      if (!saved || !this.envelope(await this.secrets.resolve(saved.credentialRef), row)) return row
      row = this.save(row, o => { o.request.state = 'confirmed'; o.secureStorage = 'stored'; delete o.reason }, saved.credentialRef)
      this.unsettled.delete(row.operation.operationId)
      return row
    } catch {
      // A lost secure-store ACK is reconciled only through its original operation, never new QR work.
      return this.save(row, o => { o.secureStorage = 'unknown'; o.reason = 'challenge-unconfirmed' })
    }
  }
  async begin(value: ConnectionSetupBegin, context: ConnectionEnrollmentCallContext): Promise<ConnectionSetupView> {
    const input = parseConnectionSetupParams('connection.setup.begin', value)
    await this.authority(context)
    let row = this.safe(() => {
      const db = this.connections.database; db.exec('BEGIN IMMEDIATE')
      try {
        let row = this.read(input.operationId)
        if (row) {
          if (!sameActor(row.actor, context.actor)) throw failure('The original management request belongs to another actor.', 'CONNECTION_SETUP_AUTHORITY_REQUIRED')
          if (!same(admitted(row.operation), input)) throw failure('This original management request has different input. Inspect it without replacing its identity.', 'CONNECTION_OPERATION_CONFLICT')
        } else {
          const current = this.connections.readConfiguration(input.connectionId)
          if (!current) throw failure('The exact saved bot is unknown.', 'UNKNOWN_CONNECTION')
          if (current.revision !== input.expectedConnectionRevision) throw failure('The exact saved bot revision changed. Read it before admitting a new request.', 'CONNECTION_REVISION_CONFLICT')
          const operation: ConnectionSetupOperation = { ...input, revision: 1, adapterId: current.config.adapterId, application: current.config.application, request: { ...(input.source ? { kind: 'enrollment-handoff' as const } : {}), state: 'not-dispatched', attemptId: null }, secureStorage: 'not-started' }
          parseConnectionSetupOperation(operation)
          db.prepare('INSERT INTO connection_setup_operation(operation_id,connection_id,actor_json,record_json) VALUES(?,?,?,?)').run(input.operationId, input.connectionId, JSON.stringify(context.actor), JSON.stringify(operation))
          row = { operation, actor: { kind: context.actor.kind, id: context.actor.id }, privateRef: null }
        }
        db.exec('COMMIT'); return row
      } catch (error) { db.exec('ROLLBACK'); throw error }
    })
    const running = this.pending.get(input.operationId)
    if (running) { await running; return this.view(this.read(input.operationId), context) }
    const work = this.run(row, context)
    this.pending.set(input.operationId, work)
    try { return await work } finally { this.pending.delete(input.operationId) }
  }
  private async run(original: Row, context: ConnectionEnrollmentCallContext): Promise<ConnectionSetupView> {
    if (original.operation.source) return this.runEnrollment(original, context)
    let row = original
    await this.authority(context, row)
    if (!this.current(row)) return this.view(row, context)
    if (row.operation.request.state !== 'not-dispatched') {
      if (row.operation.secureStorage !== 'stored') row = await this.secure(row)
      return this.view(row, context)
    }
    const adapter = this.connections.registeredAdapter(row.operation.adapterId)?.setup
    if (!adapter?.domains.includes(row.operation.application.domain)) return this.view(this.save(row, o => { o.reason = 'adapter-unavailable' }), context)
    try { if (!this.secrets) throw new Error(); await this.secrets.assertAvailable() }
    catch { return this.view(this.save(row, o => { o.reason = 'secure-storage-unavailable' }), context) }
    await this.authority(context, row)
    if (!this.current(row)) return this.view(row, context)
    row = this.save(row, o => { o.request = { state: 'dispatching', attemptId: randomUUID() }; delete o.reason })
    let receipt: Awaited<ReturnType<typeof adapter.begin>>
    this.nativeRequests.add(row.operation.request.attemptId!)
    try { receipt = await adapter.begin({ operationId: row.operation.operationId, connectionId: row.operation.connectionId, attemptId: row.operation.request.attemptId!, application: row.operation.application }, context.signal) }
    catch { receipt = { kind: 'unknown' } }
    finally { this.nativeRequests.delete(row.operation.request.attemptId!) }
    if (this.closed) return { operation: this.summary(row), challenge: null, reason: 'challenge-unavailable' }
    if (receipt.kind !== 'challenge') return this.view(this.save(row, o => { o.request.state = 'unknown'; o.reason = 'request-unconfirmed' }), context)
    try {
      const envelope: PrivateEnvelope = { operationId: row.operation.operationId, connectionId: row.operation.connectionId, attemptId: row.operation.request.attemptId!, challenge: parseConnectionSetupChallenge(receipt.challenge), privateState: receipt.privateState }
      if (typeof envelope.privateState !== 'string') throw new Error()
      this.unsettled.set(row.operation.operationId, envelope)
      row = this.save(row, o => { o.request.state = 'confirmed'; o.secureStorage = 'storing' })
      row = await this.secure(row)
      return this.view(row, context)
    } catch { return this.view(this.save(row, o => { o.secureStorage = 'unknown'; o.reason = 'challenge-unconfirmed' }), context) }
  }
  private async runEnrollment(original: Row, context: ConnectionEnrollmentCallContext): Promise<ConnectionSetupView> {
    let row = original
    await this.authority(context, row)
    // An admitted local receipt is repaired before asking its old source or adapter anything.
    if (row.operation.request.attemptId && row.operation.secureStorage !== 'stored') row = await this.secure(row)
    await this.authority(context, row)
    if (row.operation.secureStorage === 'stored' || !this.current(row)) return this.view(row, context)
    const continuation = this.connections.registeredAdapter(row.operation.adapterId)?.setup?.enrollmentContinuation
    if (!continuation?.domains.includes(row.operation.application.domain) || !this.enrollmentSource) return this.view(this.save(row, o => { o.reason = 'adapter-unavailable' }), context)
    if (!this.secrets) throw failure('Original secure management storage is unavailable.')
    await this.secrets.assertAvailable()
    await this.authority(context, row)
    if (!this.current(row)) return this.view(row, context)
    if (!row.operation.request.attemptId) row = this.save(row, o => { o.request = { kind: 'enrollment-handoff', state: 'dispatching', attemptId: randomUUID() }; delete o.reason })
    const source = await this.enrollmentSource(row.operation.source!, row.operation, context)
    await this.authority(context, row)
    source.assertCurrent()
    if (!this.current(row)) return this.view(row, context)
    const receipt = await continuation.resume({ operationId: row.operation.operationId, connectionId: row.operation.connectionId, attemptId: row.operation.request.attemptId!, application: row.operation.application, privateState: source.privateState, account: source.account })
    await this.authority(context, row)
    source.assertCurrent()
    if (!this.current(row)) return this.view(row, context)
    const fresh = this.read(row.operation.operationId)
    if (!fresh || fresh.operation.revision !== row.operation.revision || fresh.operation.request.attemptId !== row.operation.request.attemptId) return this.view(fresh, context)
    if (receipt.kind !== 'progress' || receipt.stage !== 'account' || receipt.challenge !== null || !receipt.account || receipt.account.userId !== source.account.userId || receipt.account.tenantId !== source.account.tenantId || typeof receipt.privateState !== 'string' || !receipt.privateState) return this.view(this.save(row, o => { o.request.state = 'unknown'; o.reason = 'request-unconfirmed' }), context)
    const envelope: PrivateEnvelope = { operationId: row.operation.operationId, connectionId: row.operation.connectionId, attemptId: row.operation.request.attemptId!, challenge: null, privateState: receipt.privateState, source: row.operation.source!, sourceAuthAttemptId: source.authAttemptId, localAccount: parseConnectionSetupAccount(receipt.account) }
    this.unsettled.set(row.operation.operationId, envelope)
    row = this.save(row, o => { o.request.state = 'confirmed'; o.secureStorage = 'storing'; delete o.reason })
    return this.view(await this.secure(row, { context, source }), context)
  }
  async inspect(value: ConnectionSetupInspect, context: ConnectionEnrollmentCallContext): Promise<ConnectionSetupView> {
    const input = parseConnectionSetupParams('connection.setup.inspect', value), row = this.read(input.operationId)
    await this.authority(context, row)
    let view = await this.view(row, context)
    if (row && input.applicationInspection) view = await this.inspection.attach(view, row, context, input.applicationInspection)
    return row && input.applicationConfiguration ? this.configuration.attach(view, row, context, input.applicationConfiguration) : view
  }
  /** Historical creation provenance and current authentication identity remain separate facts. */
  private async creator(row: Row): Promise<{ account: ReturnType<typeof parseConnectionSetupAccount>; isCurrent: boolean } | null> {
    if (!row.operation.source || !row.privateRef) return null
    try {
      const account = this.envelope(await this.secrets?.resolve(row.privateRef) ?? null, row)?.localAccount
      if (!account) return null
      let current: AuthEnvelope | null = null
      try { current = await this.authenticationSnapshot(row) } catch { /* A current observation gap does not erase historical creation provenance. */ }
      return { account, isCurrent: current?.stage === 'confirmed' && current.account?.userId === account.userId && current.account.tenantId === account.tenantId }
    } catch { return null }
  }
  async list(value: { connectionId: string; cursor?: string; limit?: number }, context?: ConnectionEnrollmentCallContext): Promise<ConnectionSetupListing> {
    const input = parseConnectionSetupParams('connection.setup.ls', value), limit = input.limit ?? 25
    let before = Number.MAX_SAFE_INTEGER
    if (input.cursor !== undefined) {
      if (!/^[1-9][0-9]*$/u.test(input.cursor) || !Number.isSafeInteger(Number(input.cursor))) throw failure('The original management page cursor is invalid.', 'INVALID_CONNECTION_SETUP_DATA')
      before = Number(input.cursor)
    }
    return this.safe(() => {
      const current = this.connections.readConfiguration(input.connectionId)
      const setup = current && this.connections.registeredAdapter(current.config.adapterId)?.setup
      const support: ConnectionSetupListing['support'] = current ? {
        connectionRevision: current.revision,
        capabilities: [...(setup?.domains.includes(current.config.application.domain) ? ['management-authentication' as const] : []), ...(setup?.applicationInspection?.domains.includes(current.config.application.domain) ? ['application-inspection' as const] : []), ...(setup?.applicationConfiguration?.domains.includes(current.config.application.domain) && typeof setup.applicationConfiguration.messagingCapability === 'function' && typeof setup.applicationConfiguration.enableMessaging === 'function' ? ['messaging-capability' as const] : []), ...(setup?.applicationConfiguration?.domains.includes(current.config.application.domain) && typeof setup.applicationConfiguration.eventTransportCapability === 'function' && typeof setup.applicationConfiguration.usePersistentConnection === 'function' ? ['persistent-event-transport' as const] : []), ...(setup?.applicationConfiguration?.domains.includes(current.config.application.domain) && typeof setup.applicationConfiguration.permissionPlan === 'function' && typeof setup.applicationConfiguration.addApplicationPermissions === 'function' ? ['application-permissions' as const] : []), ...(setup?.applicationConfiguration?.domains.includes(current.config.application.domain) && typeof setup.applicationConfiguration.messageReceptionPlan === 'function' && typeof setup.applicationConfiguration.addMessageReception === 'function' ? ['message-reception' as const] : []), ...(setup?.applicationConfiguration?.domains.includes(current.config.application.domain) && typeof setup.applicationConfiguration.callbackTransportCapability === 'function' && typeof setup.applicationConfiguration.usePersistentCallback === 'function' && typeof setup.applicationConfiguration.cardActionsCapability === 'function' && typeof setup.applicationConfiguration.addCardActions === 'function' ? ['card-actions' as const] : []), ...(setup?.applicationConfiguration?.domains.includes(current.config.application.domain) && typeof setup.applicationConfiguration.publicationPlan === 'function' && typeof setup.applicationConfiguration.createVersion === 'function' && typeof setup.applicationConfiguration.submitVersion === 'function' ? ['application-publication' as const] : []), ...(setup?.enrollmentContinuation?.domains.includes(current.config.application.domain) && typeof setup.enrollmentContinuation.resume === 'function' ? ['enrollment-continuation' as const] : [])]
      } : null
      const actor = context?.actor.kind === 'agent' ? context.actor : undefined
      const rows = this.connections.database.prepare(actor ? "SELECT operation_id,ordinal FROM connection_setup_operation WHERE connection_id=? AND ordinal<? AND json_extract(actor_json,'$.kind')=? AND json_extract(actor_json,'$.id')=? ORDER BY ordinal DESC LIMIT ?" : 'SELECT operation_id,ordinal FROM connection_setup_operation WHERE connection_id=? AND ordinal<? ORDER BY ordinal DESC LIMIT ?').all(...(actor ? [input.connectionId, before, actor.kind, actor.id, limit + 1] : [input.connectionId, before, limit + 1]))
      return { operations: rows.slice(0, limit).map(r => this.summary(this.read(String(r.operation_id))!)), next: rows.length > limit ? String(rows[limit - 1]!.ordinal) : null, support }
    })
  }
}
