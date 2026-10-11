import { createHash, randomUUID } from 'node:crypto'
import { AgentMuxError } from '@agentmux/core'
import { parseConnectionSetupAccount, parseConnectionSetupAuthentication, parseConnectionSetupChallenge, parseConnectionSetupOperation, parseConnectionSetupParams, type ConnectionEnrollmentCallContext, type ConnectionSetupAdvance, type ConnectionSetupAction, type ConnectionSetupBegin, type ConnectionSetupListing, type ConnectionSetupOperation, type ConnectionSetupPort, type ConnectionSetupView } from '@agentmux/core/connections'
import type { ConnectionHost } from './connection-host.js'
import type { EnrollmentSecrets } from './connection-enrollment-adapter.js'

type Row = { operation: ConnectionSetupOperation; actor: ConnectionEnrollmentCallContext['actor']; privateRef: string | null }
type PrivateEnvelope = { operationId: string; connectionId: string; attemptId: string; challenge: ConnectionSetupView['challenge']; privateState: string }
type Authentication = NonNullable<ConnectionSetupOperation['authentication']>
type AuthStep = { operationId: string; input: ConnectionSetupAdvance; authentication: Authentication; privateRef: string | null }
type AuthEnvelope = PrivateEnvelope & { stepId: string; stage: Authentication['stage']; account: ReturnType<typeof parseConnectionSetupAccount> | null }
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const sameActor = (a: ConnectionEnrollmentCallContext['actor'], b: ConnectionEnrollmentCallContext['actor']) => a.kind === b.kind && a.id === b.id
const failure = (message: string, code = 'CONNECTION_SETUP_UNCONFIRMED') => new AgentMuxError(message, code)
const admitted = (o: ConnectionSetupOperation): ConnectionSetupBegin => ({ operationId: o.operationId, connectionId: o.connectionId, expectedConnectionRevision: o.expectedConnectionRevision, goal: o.goal })

/** Finite authentication intent in the original Connection DB. Never owns current bot configuration. */
export class ConnectionSetupHost implements ConnectionSetupPort {
  private closed = false
  private readonly pending = new Map<string, Promise<ConnectionSetupView>>()
  private readonly nativeRequests = new Set<string>()
  private readonly unsettled = new Map<string, PrivateEnvelope>()
  private readonly unsettledAuthentication = new Map<string, AuthEnvelope>()
  constructor(private readonly connections: ConnectionHost, private readonly secrets?: EnrollmentSecrets) {
    connections.database.exec('CREATE TABLE IF NOT EXISTS connection_setup_operation (ordinal INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT UNIQUE NOT NULL, connection_id TEXT NOT NULL, actor_json TEXT NOT NULL, record_json TEXT NOT NULL, private_ref TEXT)')
    connections.database.exec('CREATE INDEX IF NOT EXISTS connection_setup_by_connection ON connection_setup_operation(connection_id,ordinal)')
    connections.database.exec('CREATE TABLE IF NOT EXISTS connection_setup_auth_step (ordinal INTEGER PRIMARY KEY AUTOINCREMENT, step_id TEXT UNIQUE NOT NULL, operation_id TEXT NOT NULL, action_id TEXT UNIQUE NOT NULL, input_json TEXT NOT NULL, record_json TEXT NOT NULL, private_ref TEXT)')
    connections.database.exec('CREATE INDEX IF NOT EXISTS connection_setup_auth_by_operation ON connection_setup_auth_step(operation_id,ordinal)')
  }
  close(): void { this.closed = true; this.nativeRequests.clear(); this.unsettled.clear(); this.unsettledAuthentication.clear() }
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
    if (!context?.actor || !['user', 'device'].includes(context.actor.kind) || !context.actor.id || row && !sameActor(row.actor, context.actor)) throw failure('This management request belongs to its original transport-approved actor.', 'CONNECTION_SETUP_AUTHORITY_REQUIRED')
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
  private actions(row: Row, stage: Authentication['stage'], account: AuthEnvelope['account']): ConnectionSetupAction[] {
    const auth = row.operation.authentication
    if (auth?.request === 'dispatching' && this.nativeRequests.has(auth.stepId)) return []
    if (auth?.request === 'confirmed' && auth.secureStorage !== 'stored') {
      const step = this.authStep(row.operation.operationId)
      return step ? [{ actionId: step.input.decision.actionId, expectedRevision: step.input.expectedRevision, kind: step.input.decision.value === 'confirm' ? 'confirm-account' : step.input.decision.value }] : []
    }
    const kinds: ConnectionSetupAction['kind'][] = stage === 'account' ? ['confirm-account', 'renew'] : ['waiting', 'scanned', 'handoff'].includes(stage) ? ['continue', 'renew'] : ['renew']
    return kinds.map(kind => ({ kind, expectedRevision: row.operation.revision, actionId: 'setup:' + createHash('sha256').update(JSON.stringify({ intent: admitted(row.operation), actor: row.actor, application: row.operation.application, revision: row.operation.revision, attempt: auth?.attemptId ?? row.operation.request.attemptId, account: account ? { userId: account.userId, tenantId: account.tenantId } : null, kind })).digest('hex') }))
  }
  private authEnvelope(value: string | null, row: Row, step: AuthStep): AuthEnvelope | null {
    try {
      if (value === null) return null
      const p = JSON.parse(value) as AuthEnvelope
      if (p.operationId !== row.operation.operationId || p.connectionId !== row.operation.connectionId || p.stepId !== step.authentication.stepId || p.attemptId !== step.authentication.attemptId || typeof p.privateState !== 'string' || p.stage !== step.authentication.stage) return null
      const account = p.account === null ? null : parseConnectionSetupAccount(p.account)
      if (['account', 'confirmed'].includes(p.stage) !== Boolean(account)) return null
      return { operationId: p.operationId, connectionId: p.connectionId, stepId: p.stepId, attemptId: p.attemptId, privateState: p.privateState, stage: p.stage, account, challenge: p.challenge === null ? null : parseConnectionSetupChallenge(p.challenge) }
    } catch { return null }
  }
  private async authenticationSnapshot(row: Row): Promise<AuthEnvelope | null> {
    if (!this.secrets) return null
    const step = this.authStep(row.operation.operationId)
    if (step) return step.privateRef && step.authentication.secureStorage === 'stored' ? this.authEnvelope(await this.secrets.resolve(step.privateRef), row, step) : null
    const original = row.privateRef ? this.envelope(await this.secrets.resolve(row.privateRef), row) : null
    return original ? { ...original, stepId: original.attemptId, stage: 'waiting', account: null } : null
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
    if (!this.current(row) || row.operation.authentication?.stepId !== step.authentication.stepId || !adapter?.domains.includes(row.operation.application.domain)) return this.advanceView(this.updateAuth(step, a => { a.request = 'unknown'; a.stage = 'unknown' }), context)
    let snapshot: AuthEnvelope | null = null
    const input = { operationId: row.operation.operationId, connectionId: row.operation.connectionId, attemptId: step.authentication.attemptId, application: row.operation.application }
    this.nativeRequests.add(step.authentication.stepId)
    try {
      if (step.input.decision.value === 'confirm') {
        if (!source?.account || source.stage !== 'account') throw new Error()
        snapshot = { ...source, ...input, stepId: step.authentication.stepId, stage: 'confirmed', challenge: null }
      } else if (step.input.decision.value === 'renew') {
        const timeout = AbortSignal.timeout(20_000), signal = context.signal ? AbortSignal.any([context.signal, timeout]) : timeout
        const receipt = await adapter.begin(input, signal)
        if (receipt.kind === 'challenge') snapshot = { ...input, stepId: step.authentication.stepId, stage: 'waiting', account: null, challenge: parseConnectionSetupChallenge(receipt.challenge), privateState: receipt.privateState }
      } else if (source) {
        const receipt = await adapter.advance({ ...input, privateState: source.privateState }, context.signal)
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
    if (operation.secureStorage !== 'stored' || !row.privateRef || !this.secrets) return { operation, challenge: null, ...(operation.request.state === 'confirmed' ? { reason: 'challenge-unavailable' as const } : {}), continuation: { stage: 'unknown', account: null, actions: operation.request.state === 'unknown' ? this.actions(row, 'unknown', null) : [] } }
    try {
      const value = await this.secrets.resolve(row.privateRef)
      const envelope = this.envelope(value, row)
      if (!envelope?.challenge || envelope.challenge.expiresAt !== null && envelope.challenge.expiresAt <= Date.now()) return { operation, challenge: null, reason: 'challenge-unavailable' }
      await this.authority(context, row)
      // Credential service calls can yield; a later configuration cannot receive this challenge.
      if (this.closed || !this.current(row)) return { operation, challenge: null, reason: 'connection-revised' }
      const fresh = this.read(row.operation.operationId)
      if (!fresh || fresh.operation.revision !== row.operation.revision) return { operation: fresh ? this.summary(fresh) : operation, challenge: null, reason: 'challenge-unavailable' }
      return { operation, challenge: envelope.challenge, continuation: { stage: 'waiting', account: null, actions: this.actions(row, 'waiting', null) } }
    } catch { return { operation, challenge: null, reason: 'challenge-unavailable' } }
  }
  private envelope(value: string | null, row: Row): PrivateEnvelope | null {
    try {
      if (value === null) return null
      const p = JSON.parse(value) as PrivateEnvelope
      if (p.operationId !== row.operation.operationId || p.connectionId !== row.operation.connectionId || p.attemptId !== row.operation.request.attemptId || typeof p.privateState !== 'string') return null
      return { operationId: p.operationId, connectionId: p.connectionId, attemptId: p.attemptId, challenge: parseConnectionSetupChallenge(p.challenge), privateState: p.privateState }
    } catch { return null }
  }
  private secretOperation(row: Row): string { return `connection-setup-auth:${row.operation.request.attemptId!}` }
  private async secure(row: Row): Promise<Row> {
    if (!this.secrets || !row.operation.request.attemptId) return row
    try {
      await this.secrets.assertAvailable()
      let saved = await this.secrets.inspect(this.secretOperation(row))
      const live = this.unsettled.get(row.operation.operationId)
      if (!saved && live?.attemptId === row.operation.request.attemptId) saved = await this.secrets.store({ operationId: this.secretOperation(row), secret: JSON.stringify(live) })
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
          const operation: ConnectionSetupOperation = { ...input, revision: 1, adapterId: current.config.adapterId, application: current.config.application, request: { state: 'not-dispatched', attemptId: null }, secureStorage: 'not-started' }
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
  async inspect(value: { operationId: string }, context: ConnectionEnrollmentCallContext): Promise<ConnectionSetupView> {
    const input = parseConnectionSetupParams('connection.setup.inspect', value), row = this.read(input.operationId)
    await this.authority(context, row)
    return this.view(row, context)
  }
  async list(value: { connectionId: string; cursor?: string; limit?: number }): Promise<ConnectionSetupListing> {
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
        capabilities: setup?.domains.includes(current.config.application.domain) ? ['management-authentication'] : []
      } : null
      const rows = this.connections.database.prepare('SELECT operation_id,ordinal FROM connection_setup_operation WHERE connection_id=? AND ordinal<? ORDER BY ordinal DESC LIMIT ?').all(input.connectionId, before, limit + 1)
      return { operations: rows.slice(0, limit).map(r => this.summary(this.read(String(r.operation_id))!)), next: rows.length > limit ? String(rows[limit - 1]!.ordinal) : null, support }
    })
  }
}
