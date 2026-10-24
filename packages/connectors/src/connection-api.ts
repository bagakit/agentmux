import { AgentMuxError } from '@agentmux/core'
import { connectionApiRequestDigest, parseConnectionApiIdentity, parseConnectionApiOperation, parseConnectionApiParams,
  type ConnectionApiCallContext, type ConnectionApiIdentity, type ConnectionApiJson, type ConnectionApiOperation, type ConnectionApiPort, type ConnectionApiRequestInput,
  type RoomBinding, type RoomBindingListInput } from '@agentmux/core/connections'
import type { ConnectionHost } from './connection-host.js'
import { ConnectionApiRedaction } from './connection-api-redaction.js'

type IdentityBindings = {
  list(input: RoomBindingListInput): Promise<{ bindings: RoomBinding[] }>
  /** Original group/Mote owner resolves current policy; displayed pause is never an authority detector. */
  current(bindingId: string): RoomBinding | null
}
type Stored = { actor: string; digest: string; operation: ConnectionApiOperation }
const fail = (code: string, message: string): never => { throw new AgentMuxError(message, code) }
const sameApplication = (a: RoomBinding['application'], b: RoomBinding['application']) => a.domain === b.domain && a.appId === b.appId
/** One original native business effect. Its unknown durable claim is inspect-only, never a retry queue. */
export class ConnectionApiHost implements ConnectionApiPort {
  constructor(private readonly connections: ConnectionHost, private readonly bindings: IdentityBindings) {
    this.storage(() => connections.database.exec('CREATE TABLE IF NOT EXISTS connection_api_operation (operation_id TEXT PRIMARY KEY, actor_json TEXT NOT NULL, request_digest TEXT NOT NULL, result_json TEXT NOT NULL)'))
  }
  private storage<T>(read: () => T): T {
    try { return read() }
    catch (error) { if (error instanceof AgentMuxError) throw error; return fail('CONNECTION_API_STORAGE_UNAVAILABLE', 'The original native API receipt store is unavailable. Keep original operation IDs; existing Agents remain available.') }
  }
  private actor(context: ConnectionApiCallContext): string {
    if (!context?.actor || !['agent', 'user', 'device'].includes(context.actor.kind) || !context.actor.id || context.actor.kind === 'agent' && (!context.session || context.session.agentSessionId !== context.actor.id)) fail('CONTROL_PERMISSION_DENIED', 'Native API access requires its original authenticated actor.')
    return JSON.stringify([context.actor.kind, context.actor.id, context.session?.hostId ?? null])
  }
  private owned(binding: RoomBinding, context: ConnectionApiCallContext): boolean {
    return context.actor.kind !== 'agent' || context.session?.agentSessionId === binding.agentSessionId && context.session.hostId === binding.executionHostId
  }
  private identity(bindingId: string, context: ConnectionApiCallContext): ConnectionApiIdentity | null {
    const binding = this.bindings.current(bindingId)
    if (!binding || binding.state === 'detached' || !this.owned(binding, context)) return null
    const connection = this.connections.readConfiguration(binding.connectionId)
    if (!connection?.config.enabled || !sameApplication(binding.application, connection.config.application)) return null
    const adapter = this.connections.apiAdapter(connection.config.adapterId)
    if (!adapter) return null
    return parseConnectionApiIdentity({ bindingId, bindingRevision: binding.revision, connectionId: binding.connectionId, connectionRevision: connection.revision,
      adapterId: connection.config.adapterId, application: connection.config.application, label: connection.config.label,
      executionHostId: binding.executionHostId, agentSessionId: binding.agentSessionId, ...(binding.executionRuntimeId ? { executionRuntimeId: binding.executionRuntimeId } : {}), externalConversationId: binding.externalConversationId, api: adapter.description })
  }
  async identities(value: { agentSessionId: string }, context: ConnectionApiCallContext): Promise<{ identities: ConnectionApiIdentity[] }> {
    const input = parseConnectionApiParams('connection.api.identities', value)
    this.actor(context); await context.assertCurrent?.()
    if (context.actor.kind === 'agent' && context.actor.id !== input.agentSessionId) fail('CONTROL_PERMISSION_DENIED', 'An Agent can discover only its own original bound identities.')
    const { bindings } = await this.bindings.list({ ...input, ...(context.session ? { executionHostId: context.session.hostId } : {}) })
    await context.assertCurrent?.()
    return { identities: bindings.map(binding => this.identity(binding.bindingId, context)).filter((identity): identity is ConnectionApiIdentity => identity !== null) }
  }
  private read(operationId: string): Stored | null {
    const row = this.storage(() => this.connections.database.prepare('SELECT actor_json,request_digest,result_json FROM connection_api_operation WHERE operation_id=?').get(operationId))
    return row ? { actor: String(row.actor_json), digest: String(row.request_digest), operation: parseConnectionApiOperation(JSON.parse(String(row.result_json))) } : null
  }
  private original(stored: Stored, actor: string, digest?: string): ConnectionApiOperation {
    if (stored.actor !== actor) fail('CONTROL_PERMISSION_DENIED', 'Only the original actor can inspect this native API operation.')
    if (digest !== undefined && stored.digest !== digest) fail('CONNECTION_API_OPERATION_CONFLICT', 'This operation ID already records another original request. Inspect it without resending.')
    return stored.operation
  }
  async inspect(value: { operationId: string }, context: ConnectionApiCallContext): Promise<{ operation: ConnectionApiOperation | null }> {
    const input = parseConnectionApiParams('connection.api.inspect', value), actor = this.actor(context)
    await context.assertCurrent?.()
    const saved = this.read(input.operationId)
    return { operation: saved ? this.original(saved, actor) : null }
  }
  private exact(input: ConnectionApiRequestInput, context: ConnectionApiCallContext): ConnectionApiIdentity {
    const identity = this.identity(input.identity.bindingId, context)
    if (!identity) return fail('CONNECTION_API_IDENTITY_UNAVAILABLE', 'This exact bound identity does not currently authorize a new native API operation.')
    const expected = input.identity
    if (identity.bindingRevision !== expected.bindingRevision || identity.connectionId !== expected.connectionId || identity.connectionRevision !== expected.connectionRevision) fail('CONNECTION_API_IDENTITY_CHANGED', 'This bound identity changed. Discover the original current identity before starting a new operation.')
    return identity
  }
  async request(value: ConnectionApiRequestInput, context: ConnectionApiCallContext): Promise<ConnectionApiOperation> {
    const input = parseConnectionApiParams('connection.api.request', value), actor = this.actor(context), digest = connectionApiRequestDigest(input)
    await context.assertCurrent?.()
    const saved = this.read(input.operationId)
    if (saved) return this.original(saved, actor, digest)
    const identity = this.exact(input, context), adapter = this.connections.apiAdapter(identity.adapterId)!
    adapter.validate(input.request)
    let credential: string | null
    try { credential = await this.connections.resolveCredential(identity.connectionId) }
    catch { return fail('CONNECTION_API_CREDENTIAL_UNAVAILABLE', 'The original Host credential is unavailable. No native business request was admitted.') }
    if (!credential) return fail('CONNECTION_API_CREDENTIAL_UNAVAILABLE', 'The original Host credential is unavailable. No native business request was admitted.')
    await context.assertCurrent?.()
    const redaction = new ConnectionApiRedaction(); redaction.protect(credential)
    const admission = this.storage(() => {
      this.connections.database.exec('BEGIN IMMEDIATE')
      try {
        const existing = this.read(input.operationId)
        if (existing) { const duplicate = this.original(existing, actor, digest); this.connections.database.exec('COMMIT'); return { duplicate } }
        // The final exact owner read and durable claim share one linearization point, including other DB writers.
        const current = this.exact(input, context), config = this.connections.readConfiguration(current.connectionId)!.config
        // Only safe target metadata and the full intent digest are durable. Private bodies/resources stay with the caller.
        const metadata = redaction.sanitize({ identity: current, request: { method: input.request.method, path: input.request.path, digest } } as unknown as ConnectionApiJson).value as unknown as Pick<ConnectionApiOperation, 'identity' | 'request'>
        const original = parseConnectionApiOperation({ operationId: input.operationId, ...metadata, state: 'unknown' })
        // Admission occurs once, after exact authority/credential checks, before the native SDK business call.
        this.connections.database.prepare('INSERT INTO connection_api_operation(operation_id,actor_json,request_digest,result_json) VALUES(?,?,?,?)').run(input.operationId, actor, digest, JSON.stringify(original))
        this.connections.database.exec('COMMIT')
        return { original, config }
      } catch (error) { this.connections.database.exec('ROLLBACK'); throw error }
    })
    if ('duplicate' in admission) return admission.duplicate!
    const { original, config } = admission
    let outcome: ConnectionApiOperation
    try {
      const result = await adapter.request(config, credential, input.request, { protect: value => redaction.protect(value) })
      // Adapter response is bounded JSON/empty; validate before walking, never serialize a raw SDK error/body fallback.
      const checked = parseConnectionApiOperation({ ...original, state: 'responded', response: { ...result, redacted: false } })
      if (checked.state !== 'responded') throw new Error('Unexpected original response state')
      const safe = redaction.sanitize(checked.response.body as unknown as ConnectionApiJson)
      outcome = parseConnectionApiOperation({ ...original, state: 'responded', response: { status: checked.response.status, body: safe.value, redacted: safe.redacted } })
    } catch {
      outcome = { ...original, state: 'unknown', code: 'CONNECTION_API_OUTCOME_UNKNOWN' }
    }
    try { this.connections.database.prepare('UPDATE connection_api_operation SET result_json=? WHERE operation_id=? AND actor_json=? AND request_digest=?').run(JSON.stringify(outcome), input.operationId, actor, digest) }
    catch { fail('CONNECTION_API_RECEIPT_UNAVAILABLE', 'The original request was admitted, but its final receipt could not be saved. Inspect this same operation ID; do not resend.') }
    return outcome
  }
}
