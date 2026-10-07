import { randomUUID } from 'node:crypto'
import { AgentMuxError } from '@agentmux/core'
import { parseConnectionParams, parseConnectionResult, parseConnectionEnrollmentChallenge, parseConnectionEnrollmentOperation, parseConnectionEnrollmentParams, type ConnectionEnrollmentBeginInput, type ConnectionEnrollmentCallContext, type ConnectionEnrollmentCapability, type ConnectionEnrollmentListInput, type ConnectionEnrollmentOperation, type ConnectionEnrollmentOperationInput, type ConnectionEnrollmentPort } from '@agentmux/core/connections'
import type { ConnectionHost } from './connection-host.js'
import type { ConnectionEnrollmentAdapter, EnrollmentAdapterInput, EnrollmentChallengeReceipt, EnrollmentSecrets } from './connection-enrollment-adapter.js'
import { ConnectionEnrollmentStore, type EnrollmentRow } from './connection-enrollment-store.js'

type Application = NonNullable<ConnectionEnrollmentOperation['application']>
type Snapshot = { privateState: string; challenge: NonNullable<ConnectionEnrollmentOperation['challenge']> }
/** Durable enrollment on the original connection owner, never a Runtime or polling scheduler. */
export class ConnectionEnrollmentHost implements ConnectionEnrollmentPort {
  private readonly store: ConnectionEnrollmentStore
  private readonly pending = new Map<string, Promise<ConnectionEnrollmentOperation>>()
  private readonly owner = randomUUID()
  private readonly unsettledCredentials = new Map<string, { attemptId: string; application: Application; secret: string }>()
  private readonly unsettledSnapshots = new Map<string, { attemptId: string; snapshot: Snapshot }>()
  private closed = false
  constructor(private readonly options: { connections: ConnectionHost; secrets?: EnrollmentSecrets }) { this.store = new ConnectionEnrollmentStore(options.connections) }
  close(): void { this.closed = true; this.unsettledCredentials.clear(); this.unsettledSnapshots.clear() }
  private current(): void { if (this.closed) throw new AgentMuxError('The original enrollment owner is closed. Inspect the original operation on its Host.', 'CONNECTION_ENROLLMENT_UNAVAILABLE') }
  private async authority(row: EnrollmentRow | null, context: ConnectionEnrollmentCallContext): Promise<void> {
    this.current()
    if (!context.actor || !['user', 'device'].includes(context.actor.kind) || typeof context.actor.id !== 'string' || !context.actor.id || row && (row.actor.kind !== context.actor.kind || row.actor.id !== context.actor.id)) throw new AgentMuxError('Enrollment requires its original trusted human authority.', 'CONTROL_PERMISSION_DENIED')
    context.signal?.throwIfAborted(); await context.assertCurrent?.(); this.current()
  }
  private async secure(): Promise<EnrollmentSecrets> {
    const secrets = this.options.secrets
    if (!secrets) throw new AgentMuxError('Secure enrollment storage is unavailable on this Host.', 'CONNECTION_CREDENTIAL_UNAVAILABLE')
    await secrets.assertAvailable(); return secrets
  }
  private adapter(row: EnrollmentRow): ConnectionEnrollmentAdapter | undefined {
    const adapter = this.options.connections.registeredAdapter(row.operation.adapterId)?.enrollment
    return adapter?.domains.some(d => d.domain === row.operation.domain) ? adapter : undefined
  }
  async list(value: ConnectionEnrollmentListInput) {
    this.current(); const input = parseConnectionEnrollmentParams('connection.enrollment.ls', value)
    let available = true; try { await this.secure() } catch { available = false }
    const capabilities: ConnectionEnrollmentCapability[] = this.options.connections.enrollmentAdapters().flatMap(a => a.enrollment!.domains.map(d => ({ adapterId: a.adapterId, ...d, availability: available ? 'available' as const : 'unavailable' as const, ...(available ? {} : { reason: 'secure-storage-unavailable' as const }) })))
    return { ...this.store.page(input.cursor, input.limit ?? 25), capabilities }
  }
  async inspect(value: ConnectionEnrollmentOperationInput) { this.current(); const input = parseConnectionEnrollmentParams('connection.enrollment.inspect', value); return { operation: this.store.read(input.operationId)?.operation ?? null } }
  private join(operationId: string, call: () => Promise<ConnectionEnrollmentOperation>): Promise<ConnectionEnrollmentOperation> {
    const active = this.pending.get(operationId); if (active) return active
    const work = call().finally(() => this.pending.delete(operationId)); this.pending.set(operationId, work); return work
  }
  async begin(value: ConnectionEnrollmentBeginInput, context: ConnectionEnrollmentCallContext): Promise<ConnectionEnrollmentOperation> {
    const input = parseConnectionEnrollmentParams('connection.enrollment.begin', value)
    await this.authority(this.store.read(input.operationId), context)
    const row = this.store.admit(input, context.actor)
    return this.join(input.operationId, async () => {
      if (row.attemptId || row.operation.authorization !== 'not-started') return this.store.read(input.operationId)!.operation
      const adapter = this.adapter(row)
      if (!adapter) return this.store.update(input.operationId, r => { r.operation.reason = 'adapter-unavailable' }).operation
      try { await this.secure() } catch { return this.store.update(input.operationId, r => { r.operation.reason = 'secure-storage-unavailable' }).operation }
      await this.authority(row, context)
      const claim = this.store.claim(input.operationId, 'begin', this.owner, row)
      if (!claim.claimed) return claim.row.operation
      try {
        const receipt = await adapter.begin(this.adapterInput(claim.row), context.signal)
        if (this.closed) return claim.row.operation
        if (receipt.kind === 'pending') return await this.pendingReceipt(claim.row, receipt)
        if (receipt.kind === 'not-applied') return this.store.settle(input.operationId, claim.row.attemptId!, r => { r.operation.authorization = 'denied'; r.operation.challenge = null; r.operation.reason = 'platform-not-applied' }).operation
      } catch { /* Claimed begin may already have created an application. Never replay it. */ }
      return this.store.read(input.operationId)!.operation
    })
  }
  async advance(value: ConnectionEnrollmentOperationInput, context: ConnectionEnrollmentCallContext): Promise<ConnectionEnrollmentOperation> {
    const input = parseConnectionEnrollmentParams('connection.enrollment.advance', value), original = this.store.read(input.operationId)
    await this.authority(original, context)
    if (!original) throw new AgentMuxError('The original enrollment operation is unknown.', 'UNKNOWN_CONNECTION_ENROLLMENT')
    return this.join(input.operationId, async () => {
      let row = this.store.read(input.operationId)!
      if (row.operation.configuration === 'configured') return row.operation
      // A validated live response survives a temporary preliminary journal failure.
      const liveCredential = this.unsettledCredentials.get(input.operationId)
      if (row.operation.authorization === 'unknown' && liveCredential?.attemptId === row.attemptId && row.attemptKind === 'poll') {
        try {
          row = this.store.settle(input.operationId, row.attemptId!, r => { r.operation.authorization = 'authorized'; r.operation.application = liveCredential.application; r.operation.challenge = null; r.operation.credential = 'storing'; delete r.operation.reason })
        } catch { return row.operation }
        return row.operation.authorization === 'authorized' ? await this.configure(row, context) : row.operation
      }
      // Local secure handoff recovery is explicit and never repeats a platform request.
      if (row.operation.authorization === 'unknown' && row.snapshotOperationId) {
        try {
          const secrets = await this.secure(), saved = await secrets.inspect(row.snapshotOperationId)
          const live = this.unsettledSnapshots.get(input.operationId)
          const restored = saved ?? (live?.attemptId === row.attemptId ? await secrets.store({ operationId: row.snapshotOperationId, secret: JSON.stringify(live.snapshot) }) : null)
          if (restored) {
            const raw = await secrets.resolve(restored.credentialRef), snapshot = raw ? this.snapshot(raw) : null
            if (snapshot) row = this.store.settle(input.operationId, row.attemptId!, r => { r.privateRef = restored.credentialRef; r.operation.authorization = 'pending'; r.operation.challenge = snapshot.challenge; delete r.operation.reason })
          }
          if (row.operation.authorization === 'pending') this.unsettledSnapshots.delete(input.operationId)
        } catch { return row.operation }
        return row.operation // A recovered pending receipt needs a separate explicit advance to poll.
      }
      if (row.operation.authorization === 'authorized') return await this.configure(row, context)
      if (row.operation.authorization !== 'pending' || !row.operation.challenge || Date.now() < row.operation.challenge.nextPollAt) return row.operation
      const adapter = this.adapter(row)
      if (!adapter) return this.store.update(input.operationId, r => { r.operation.reason = 'adapter-unavailable' }).operation
      let secrets: EnrollmentSecrets, snapshot: Snapshot
      try {
        secrets = await this.secure(); const raw = row.privateRef ? await secrets.resolve(row.privateRef) : null
        if (!raw) throw new Error('Private state missing')
        snapshot = this.snapshot(raw)
      } catch { return this.store.update(input.operationId, r => { r.operation.reason = 'secure-storage-unavailable' }).operation }
      await this.authority(row, context)
      const claim = this.store.claim(input.operationId, 'poll', this.owner, row)
      if (!claim.claimed) return claim.row.operation
      try {
        const receipt = await adapter.poll({ ...this.adapterInput(claim.row), privateState: snapshot.privateState }, context.signal)
        if (this.closed) return claim.row.operation
        if (receipt.kind === 'pending') return await this.pendingReceipt(claim.row, receipt)
        if (receipt.kind === 'authorized') {
          if (typeof receipt.secret !== 'string' || !receipt.secret) throw new Error('Invalid credential')
          // Preserve the non-secret application fact before awaiting the secure credential commit.
          parseConnectionEnrollmentOperation({ ...claim.row.operation, authorization: 'authorized', application: receipt.application, credential: 'storing' })
          this.unsettledCredentials.set(input.operationId, { attemptId: claim.row.attemptId!, application: receipt.application, secret: receipt.secret })
          row = this.store.settle(input.operationId, claim.row.attemptId!, r => { r.operation.authorization = 'authorized'; r.operation.challenge = null; r.operation.application = receipt.application; r.operation.credential = 'storing'; delete r.operation.reason })
          if (row.operation.authorization !== 'authorized' || row.attemptId !== claim.row.attemptId) return row.operation
          try { await secrets.store({ operationId: row.credentialOperationId, secret: receipt.secret }); this.unsettledCredentials.delete(input.operationId) }
          catch { return this.store.update(input.operationId, r => { r.operation.credential = 'unknown'; r.operation.reason = 'credential-unconfirmed' }, row.attemptId!).operation }
          if (this.closed) return row.operation
          row = this.store.update(input.operationId, r => { r.operation.credential = 'stored' }, row.attemptId!)
          return await this.configure(row, context)
        }
        if (receipt.kind === 'denied' || receipt.kind === 'expired') return this.store.settle(input.operationId, claim.row.attemptId!, r => { r.operation.authorization = receipt.kind as 'denied' | 'expired'; r.operation.challenge = null; r.operation.reason = receipt.kind === 'denied' ? 'platform-denied' : 'platform-expired' }).operation
      } catch { /* One-time poll delivery may have happened; its durable claim stays unknown. */ }
      return this.store.read(input.operationId)!.operation
    })
  }
  private adapterInput(row: EnrollmentRow): EnrollmentAdapterInput { const { operationId, connectionId, domain, label, preset } = row.operation; return { operationId, connectionId, domain, label, ...(preset ? { preset } : {}), attemptId: row.attemptId! } }
  private snapshot(raw: string): Snapshot {
    const p = JSON.parse(raw) as Snapshot
    if (typeof p.privateState !== 'string' || !p.privateState) throw new Error('Invalid private snapshot')
    return { privateState: p.privateState, challenge: parseConnectionEnrollmentChallenge(p.challenge) }
  }
  private async pendingReceipt(row: EnrollmentRow, receipt: EnrollmentChallengeReceipt): Promise<ConnectionEnrollmentOperation> {
    if (typeof receipt.privateState !== 'string' || !receipt.privateState || receipt.expiresInMs !== null && (!Number.isSafeInteger(receipt.expiresInMs) || receipt.expiresInMs < 0) || !Number.isSafeInteger(receipt.pollIntervalMs) || receipt.pollIntervalMs < 0) throw new Error('Invalid original challenge')
    const now = Date.now(), prior = row.operation.challenge?.expiresAt
    const receivedExpiry = receipt.expiresInMs === null ? null : now + receipt.expiresInMs
    const challenge = parseConnectionEnrollmentChallenge({ verificationUrl: receipt.verificationUrl, ...(receipt.userCode === undefined ? {} : { userCode: receipt.userCode }), expiresAt: prior !== null && prior !== undefined ? receivedExpiry === null ? prior : Math.min(prior, receivedExpiry) : receivedExpiry, nextPollAt: now + receipt.pollIntervalMs })
    const snapshot = { privateState: receipt.privateState, challenge }
    this.unsettledSnapshots.set(row.operation.operationId, { attemptId: row.attemptId!, snapshot })
    const secrets = await this.secure(), saved = await secrets.store({ operationId: row.snapshotOperationId!, secret: JSON.stringify(snapshot) })
    this.unsettledSnapshots.delete(row.operation.operationId)
    this.current()
    return this.store.settle(row.operation.operationId, row.attemptId!, r => { r.privateRef = saved.credentialRef; r.operation.authorization = 'pending'; r.operation.challenge = challenge; delete r.operation.reason }).operation
  }
  private async configure(row: EnrollmentRow, context: ConnectionEnrollmentCallContext): Promise<ConnectionEnrollmentOperation> {
    const operationId = row.operation.operationId
    try {
      const secrets = await this.secure()
      let credential = await secrets.inspect(row.credentialOperationId)
      const live = this.unsettledCredentials.get(operationId)
      if (!credential && live?.attemptId === row.attemptId) credential = await secrets.store({ operationId: row.credentialOperationId, secret: live.secret })
      this.current()
      if (credential) this.unsettledCredentials.delete(operationId)
      if (!credential || !row.operation.application) return this.store.update(operationId, r => { r.operation.credential = 'unknown'; r.operation.reason = 'credential-unconfirmed' }).operation
      row = this.store.update(operationId, r => { r.operation.credential = 'stored'; r.operation.configuration = 'saving' })
      await this.authority(row, context)
      const intended = parseConnectionParams('connection.configure', { operationId: row.configureOperationId, expectedRevision: null, connection: { connectionId: row.operation.connectionId, adapterId: row.operation.adapterId, application: row.operation.application!, label: row.operation.label, credentialRef: credential.credentialRef, enabled: true } })
      const original = await this.options.connections.inspect({ operationId: row.configureOperationId })
      const configured = parseConnectionResult('connection.configure', original.operation ?? await this.options.connections.configure(intended), intended)
      this.current()
      return this.store.update(operationId, r => { r.operation.configuration = 'configured'; r.operation.configured = configured; delete r.operation.reason }).operation
    } catch (error) {
      if (this.closed) return row.operation
      return this.store.update(operationId, r => { r.operation.configuration = error instanceof AgentMuxError && ['CONNECTION_IDENTITY_CONFLICT', 'CONNECTION_REVISION_CONFLICT'].includes(error.code) ? 'refused' : 'unknown'; r.operation.reason = r.operation.configuration === 'refused' ? 'connection-conflict' : 'configuration-unconfirmed' }).operation
    }
  }
}
