import { mintObjectId } from './object-id.js'
import { createHash } from 'node:crypto'
import { chmod, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { ExecutionHost } from './execution-host.js'
import { AgentMuxError } from './errors.js'
import {
  APPLICATION_ACCESS_SCHEMA, applicationAccessScopes, applicationAccessText, parseApplicationAccessParams,
  parseApplicationAccessProfile, parseApplicationAccessObservation, parseApplicationAccessOperation, parseApplicationAccessPlan,
  type ApplicationAccessConfiguration, type ApplicationAccessEndpoint, type ApplicationAccessMethod,
  type ApplicationAccessObservation, type ApplicationAccessOperation, type ApplicationAccessParameterMap,
  type ApplicationAccessPlan, type ApplicationAccessProfile, type ApplicationAccessResultMap
} from './application-access.js'
import { rpcRecord } from './rpc-data.js'

export type ApplicationAccessResolvedHost = { executionHost: ExecutionHost; runtimeId: string; assertCurrent(): void | Promise<void> }
export type ApplicationAccessOwnerOptions = { path: string; resolveHost(hostId: string): Promise<ApplicationAccessResolvedHost> }
type ImportDispatch = { host: ApplicationAccessResolvedHost; attempted: boolean }
type Journal = { operation: ApplicationAccessOperation; profile: ApplicationAccessProfile; intentDigest: string; importDispatched: boolean }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const identity = ({ hostId, runtimeId, osAccount }: ApplicationAccessEndpoint) => ({ hostId, runtimeId, osAccount })
const targetKey = (p: ApplicationAccessProfile) => digest([p.target.runtimeId, p.target.osAccount, p.applicationId])
const covers = (o: ApplicationAccessObservation, p: ApplicationAccessProfile) => o.status === 'ready' && o.accountId === p.accountId && p.scopes.every(scope => o.scopes.includes(scope))
const safeCause = (code: string, message: string) => ({ code, message })
const failure = (code: string, message: string): never => { throw new AgentMuxError(message, code) }
/** Only opaque transfer material is allowed this bounded in-flight allocation. It is never persisted. */
const MAX_MATERIAL_BYTES = 4 * 1024 * 1024

/** One endpoint-owned application configuration and metadata journal. No Agent/Runtime lifecycle authority. */
export class AgentMuxApplicationAccessOwner {
  private database: Promise<DatabaseSync> | undefined
  private readonly active = new Set<string>()
  constructor(private readonly options: ApplicationAccessOwnerOptions) {}
  private db(): Promise<DatabaseSync> {
    if (this.database) return this.database
    const opening = (async () => {
      await mkdir(dirname(this.options.path), { recursive: true, mode: 0o700 })
      const { DatabaseSync } = await import('node:sqlite'), db = new DatabaseSync(this.options.path)
      try {
        await chmod(this.options.path, 0o600)
        db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;')
        const version = db.prepare('PRAGMA user_version').get() as { user_version: number }
        if (version.user_version !== 0 && version.user_version !== 1) failure('APPLICATION_ACCESS_STORE_UNAVAILABLE', 'The original application access journal uses an unsupported schema. Its records are retained.')
        db.exec(`CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, json TEXT NOT NULL, source_host TEXT NOT NULL, target_host TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS profiles_source ON profiles(source_host); CREATE INDEX IF NOT EXISTS profiles_target ON profiles(target_host);
          CREATE TABLE IF NOT EXISTS plans (id TEXT PRIMARY KEY, json TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS operations (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, profile_id TEXT NOT NULL, target_key TEXT NOT NULL, source_host TEXT NOT NULL, target_host TEXT NOT NULL, status TEXT NOT NULL, json TEXT NOT NULL, is_latest INTEGER NOT NULL DEFAULT 1);
          CREATE INDEX IF NOT EXISTS operation_profile_latest ON operations(profile_id,sequence DESC);
          CREATE INDEX IF NOT EXISTS operation_latest_source ON operations(is_latest,source_host); CREATE INDEX IF NOT EXISTS operation_latest_target ON operations(is_latest,target_host);
          CREATE INDEX IF NOT EXISTS operation_unresolved_target ON operations(target_key,status); CREATE INDEX IF NOT EXISTS operation_status ON operations(status);
          CREATE INDEX IF NOT EXISTS operation_source_status ON operations(source_host,status); CREATE INDEX IF NOT EXISTS operation_target_status ON operations(target_host,status);
          PRAGMA user_version=1;`)
        return db
      } catch (error) { db.close(); throw error }
    })()
    this.database = opening
    void opening.catch(() => { if (this.database === opening) this.database = undefined })
    return opening
  }
  async dispose(): Promise<void> { if (this.database) (await this.database).close() }
  private async configuration(id: string): Promise<ApplicationAccessConfiguration> {
    const row = (await this.db()).prepare('SELECT json FROM profiles WHERE id=?').get(id) as { json: string } | undefined
    if (!row) return failure('APPLICATION_ACCESS_NOT_FOUND', 'The exact application configuration is not registered.')
    const p = JSON.parse(row.json) as ApplicationAccessConfiguration
    return { profileId: applicationAccessText(p.profileId), revision: applicationAccessText(p.revision), profile: parseApplicationAccessProfile(p.profile) }
  }
  private async journal(id: string): Promise<Journal | null> {
    const row = (await this.db()).prepare('SELECT json FROM operations WHERE id=?').get(id) as { json: string } | undefined
    if (!row) return null
    const value = JSON.parse(row.json) as Journal
    return { operation: parseApplicationAccessOperation(value.operation), profile: parseApplicationAccessProfile(value.profile), intentDigest: applicationAccessText(value.intentDigest), importDispatched: value.importDispatched === true }
  }
  private async persist(j: Journal): Promise<void> {
    j.operation.updatedAt = new Date().toISOString()
    const result = (await this.db()).prepare('UPDATE operations SET status=?,json=? WHERE id=?').run(j.operation.status,JSON.stringify(j),j.operation.operationId)
    if (result.changes !== 1) return failure('APPLICATION_ACCESS_STORE_UNAVAILABLE','The original operation record is unavailable. No replacement operation was created.')
  }
  private async list(hostId?: string): Promise<ApplicationAccessResultMap['settings.applications.ls']> {
    const db = await this.db(), rows = (hostId ? db.prepare('SELECT json FROM profiles WHERE source_host=? OR target_host=? ORDER BY id').all(hostId, hostId) : db.prepare('SELECT json FROM profiles ORDER BY id').all()) as { json: string }[]
    const configurations = rows.map(row => JSON.parse(row.json) as ApplicationAccessConfiguration), operations = new Map<string, ApplicationAccessOperation>()
    const latest = (hostId ? db.prepare('SELECT json FROM operations WHERE is_latest=1 AND (source_host=? OR target_host=?)').all(hostId,hostId) : db.prepare('SELECT json FROM operations WHERE is_latest=1').all()) as { json: string }[]
    for (const row of latest) { const j = JSON.parse(row.json) as Journal; operations.set(j.operation.operationId,j.operation) }
    const pending = (hostId ? db.prepare("SELECT json FROM operations WHERE (source_host=? OR target_host=?) AND status IN ('pending','unknown')").all(hostId, hostId) : db.prepare("SELECT json FROM operations WHERE status IN ('pending','unknown')").all()) as { json: string }[]
    for (const row of pending) { const j = JSON.parse(row.json) as Journal; operations.set(j.operation.operationId, j.operation) }
    return { configurations, operations: [...operations.values()].sort((a,b) => b.updatedAt.localeCompare(a.updatedAt)) }
  }
  private async configure(input: ApplicationAccessParameterMap['settings.applications.configure']): Promise<ApplicationAccessConfiguration> {
    const db = await this.db(), prior = db.prepare('SELECT json FROM profiles WHERE id=?').get(input.profileId) as { json: string } | undefined
    if ((prior ? (JSON.parse(prior.json) as ApplicationAccessConfiguration).revision : null) !== input.expectedRevision) return failure('APPLICATION_ACCESS_CONFIGURATION_CHANGED', 'Application configuration changed. Read its current revision before saving.')
    const result = { profileId: input.profileId, revision: digest(input.profile), profile: input.profile }
    db.prepare('INSERT INTO profiles VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json,source_host=excluded.source_host,target_host=excluded.target_host').run(result.profileId, JSON.stringify(result), result.profile.source.hostId, result.profile.target.hostId)
    return result
  }
  private async checkedHost(endpoint: ApplicationAccessEndpoint, signal?: AbortSignal): Promise<ApplicationAccessResolvedHost & { osAccount: string }> {
    signal?.throwIfAborted()
    const host = await this.options.resolveHost(endpoint.hostId)
    if (host.runtimeId !== endpoint.runtimeId) return failure('APPLICATION_ACCESS_RUNTIME_MISMATCH', 'The resolved Host is not the expected original Runtime. Only this application operation was refused.')
    await host.assertCurrent()
    const result = await host.executionHost.run('/usr/bin/id', ['-un'], { ...(signal ? {signal} : {}), maxOutputBytes: 16 * 1024 })
    if (result.exitCode !== 0 || !/^[^\0\r\n]+\n?$/u.test(result.stdout)) return failure('APPLICATION_ACCESS_PLATFORM_UNSUPPORTED', 'The exact execution environment did not provide a POSIX account identity. Existing Agents are retained.')
    const osAccount = result.stdout.replace(/\n$/u, '')
    if (osAccount !== endpoint.osAccount) return failure('APPLICATION_ACCESS_OS_ACCOUNT_MISMATCH', 'The actual POSIX execution account differs from the configured account. Only this application operation was refused.')
    await host.assertCurrent()
    return { ...host, osAccount }
  }
  private async invoke(endpoint: ApplicationAccessEndpoint, profile: ApplicationAccessProfile, action: string, fields: Record<string, unknown>, signal?: AbortSignal, dispatch?: ImportDispatch): Promise<Record<string, unknown>> {
    const host = dispatch?.host ?? await this.checkedHost(endpoint, signal)
    signal?.throwIfAborted()
    await host.assertCurrent()
    const request = { schema: APPLICATION_ACCESS_SCHEMA, action, applicationId: profile.applicationId, accountId: profile.accountId, scopes: profile.scopes, ...fields }
    let result: Awaited<ReturnType<ExecutionHost['run']>>
    try {
      if (dispatch) dispatch.attempted = true
      result = await host.executionHost.run(endpoint.command, endpoint.args, { input: JSON.stringify(request), ...(signal ? {signal} : {}), maxOutputBytes: 8 * 1024 * 1024 }) }
    catch { return failure('APPLICATION_ACCESS_CONNECTOR_UNCONFIRMED', 'The configured application connector result is unconfirmed. Its raw output and input were withheld.') }
    await host.assertCurrent()
    if (result.exitCode !== 0) return failure('APPLICATION_ACCESS_CONNECTOR_FAILED', 'The configured application connector did not confirm this stage. Its raw stdout and stderr were withheld.')
    let body: Record<string, unknown>
    try { body = rpcRecord(JSON.parse(result.stdout)); if (body.schema !== APPLICATION_ACCESS_SCHEMA || body.action !== action || body.applicationId !== profile.applicationId) throw new Error() }
    catch { return failure('APPLICATION_ACCESS_PROTOCOL_ERROR', 'The configured connector did not return the expected machine protocol. Its raw output was withheld.') }
    return body
  }
  private async observe(endpoint: ApplicationAccessEndpoint, profile: ApplicationAccessProfile, action: 'inspect' | 'verify', signal?: AbortSignal): Promise<ApplicationAccessObservation> {
    const unknown: ApplicationAccessObservation = { hostId: endpoint.hostId, runtimeId: null, osAccount: null, applicationId: profile.applicationId, status: 'unknown', accountId: null, scopes: [], revision: null, transferable: false }
    try {
      const host = await this.checkedHost(endpoint, signal)
      unknown.runtimeId = host.runtimeId; unknown.osAccount = host.osAccount
      const body = await this.invoke(endpoint, profile, action, {}, signal)
      const p = rpcRecord(body, ['schema', 'action', 'applicationId', 'status', 'accountId', 'scopes', 'revision', 'transferable'])
      if (!['ready','login-required','unsupported'].includes(p.status as string) || typeof p.transferable !== 'boolean' || p.accountId !== null && typeof p.accountId !== 'string') throw new Error()
      const observation = parseApplicationAccessObservation({ ...unknown, status: p.status, accountId: p.accountId, scopes: p.scopes, revision: p.revision, transferable: p.transferable })
      if (observation.status === 'ready' && !observation.accountId) throw new Error()
      return observation
    } catch (error) {
      signal?.throwIfAborted()
      const code = error instanceof AgentMuxError && error.code.startsWith('APPLICATION_ACCESS_') ? error.code : 'APPLICATION_ACCESS_OBSERVATION_UNKNOWN'
      return { ...unknown, ...(code === 'APPLICATION_ACCESS_PLATFORM_UNSUPPORTED' ? { status: 'unsupported' as const } : {}), cause: safeCause(code, 'The original application identity or scope observation is unconfirmed. Check the selected Host and connector, then inspect again.') }
    }
  }
  private disposition(p: ApplicationAccessProfile, source: ApplicationAccessObservation, target: ApplicationAccessObservation): ApplicationAccessPlan['disposition'] {
    if (source.status === 'unknown' || target.status === 'unknown') return 'unknown'
    if (source.status === 'unsupported' || target.status === 'unsupported') return 'unsupported'
    if (target.accountId !== null && target.accountId !== p.accountId || source.accountId !== null && source.accountId !== p.accountId) return 'conflict'
    if (covers(target, p)) return 'reuse'
    if (!covers(source, p)) return 'source-login-required'
    if (!source.transferable || !target.transferable) return 'target-login-required'
    return 'transfer'
  }
  private async plan(input: ApplicationAccessParameterMap['settings.applications.plan'], signal?: AbortSignal): Promise<ApplicationAccessPlan> {
    const c = await this.configuration(input.profileId)
    if (c.revision !== input.expectedRevision) return failure('APPLICATION_ACCESS_CONFIGURATION_CHANGED', 'Read the current application configuration before planning.')
    const [source,target] = await Promise.all([this.observe(c.profile.source,c.profile,'inspect',signal),this.observe(c.profile.target,c.profile,'inspect',signal)])
    if ((await this.configuration(c.profileId)).revision !== c.revision) return failure('APPLICATION_ACCESS_CONFIGURATION_CHANGED', 'Application configuration changed during observation. Inspect the current configuration again.')
    const result: ApplicationAccessPlan = { planId: mintObjectId(), profileId: c.profileId, configurationRevision: c.revision, createdAt: new Date().toISOString(), source, target, disposition: this.disposition(c.profile,source,target), accountId: c.profile.accountId, scopes: c.profile.scopes }
    ;(await this.db()).prepare('INSERT INTO plans VALUES(?,?)').run(result.planId, JSON.stringify(result))
    return result
  }
  private async apply(input: ApplicationAccessParameterMap['settings.applications.apply'], signal?: AbortSignal): Promise<ApplicationAccessOperation> {
    const existing = await this.journal(input.operationId)
    if (existing) {
      if (existing.operation.profileId !== input.profileId || existing.operation.planId !== input.planId) return failure('APPLICATION_ACCESS_OPERATION_CONFLICT', 'The original operation ID already belongs to another intent. Query that original operation.')
      return existing.operation
    }
    const db = await this.db(), row = db.prepare('SELECT json FROM plans WHERE id=?').get(input.planId) as { json: string } | undefined
    if (!row) return failure('APPLICATION_ACCESS_PLAN_NOT_FOUND', 'The original application plan is unavailable. Create a new read-only plan.')
    const plan = parseApplicationAccessPlan(JSON.parse(row.json)), c = await this.configuration(input.profileId), p = c.profile
    if (plan.profileId !== c.profileId || plan.configurationRevision !== c.revision) return failure('APPLICATION_ACCESS_PLAN_CHANGED', 'The original plan belongs to another application configuration. Inspect the current configuration again.')
    if (plan.disposition !== 'transfer' && plan.disposition !== 'reuse') return failure('APPLICATION_ACCESS_PLAN_NOT_APPLICABLE', 'This plan does not authorize a transfer or verified reuse. Resolve its exact observation first.')
    const admitted = db.prepare('SELECT json FROM operations WHERE id=?').get(input.operationId) as { json: string } | undefined
    if (admitted) {
      const original = (JSON.parse(admitted.json) as Journal).operation
      if (original.profileId !== input.profileId || original.planId !== input.planId) return failure('APPLICATION_ACCESS_OPERATION_CONFLICT','The original operation ID belongs to another intent. Query the original operation.')
      return original
    }
    const pending = db.prepare("SELECT json FROM operations WHERE target_key=? AND status IN ('pending','unknown')").all(targetKey(p)) as { json: string }[]
    if (pending.some(row => (JSON.parse(row.json) as Journal).operation.scopes.some(scope => p.scopes.includes(scope)))) return failure('APPLICATION_ACCESS_OPERATION_UNRESOLVED', 'An original operation for this target application scope is unresolved. Query its original operation ID; do not replay with another ID.')
    const now = new Date().toISOString(), operation: ApplicationAccessOperation = { ...input, configurationRevision: c.revision, applicationId: p.applicationId, source: identity(p.source), target: identity(p.target), accountId: p.accountId, scopes: p.scopes, createdAt: now, updatedAt: now, status: 'pending', stage: 'prepared' }
    const j: Journal = { operation, profile: p, importDispatched: false, intentDigest: digest([input.profileId, input.planId, c.revision, identity(p.source),identity(p.target),p.accountId,p.scopes]) }
    // No await between the exact target conflict read and original operation admission.
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare('UPDATE operations SET is_latest=0 WHERE profile_id=? AND is_latest=1').run(c.profileId)
      db.prepare('INSERT INTO operations(id,profile_id,target_key,source_host,target_host,status,json,is_latest) VALUES(?,?,?,?,?,?,?,1)').run(operation.operationId,c.profileId,targetKey(p),p.source.hostId,p.target.hostId,operation.status,JSON.stringify(j))
      db.exec('COMMIT')
    } catch (error) { db.exec('ROLLBACK'); throw error }
    this.active.add(operation.operationId)
    let importDispatch: ImportDispatch | undefined
    try {
      const [source,target] = await Promise.all([this.observe(p.source,p,'inspect',signal),this.observe(p.target,p,'inspect',signal)])
      if (digest([source,target]) !== digest([plan.source,plan.target]) || (await this.configuration(c.profileId)).revision !== c.revision) return failure('APPLICATION_ACCESS_PLAN_CHANGED', 'The original application identities, scopes or revisions changed. No import was dispatched; inspect again.')
      if (plan.disposition === 'transfer') {
        operation.stage = 'exporting'; await this.persist(j)
        const exported = await this.invoke(p.source,p,'export',{ expectedRevision: source.revision },signal)
        const e = rpcRecord(exported,['schema','action','applicationId','accountId','scopes','revision','materialBase64'])
        if (e.accountId !== p.accountId || digest(applicationAccessScopes(e.scopes)) !== digest(p.scopes) || e.revision !== source.revision || typeof e.materialBase64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(e.materialBase64) || !e.materialBase64.length || Buffer.byteLength(e.materialBase64,'base64') > MAX_MATERIAL_BYTES) return failure('APPLICATION_ACCESS_EXPORT_INVALID', 'The connector did not export the exact account, scope and source revision within the private in-flight material boundary.')
        if ((await this.configuration(c.profileId)).revision !== c.revision) return failure('APPLICATION_ACCESS_CONFIGURATION_CHANGED','Application configuration changed before import. No import was dispatched.')
        importDispatch = { host: await this.checkedHost(p.target,signal), attempted: false }
        operation.stage = 'import-dispatched'; j.importDispatched = true; await this.persist(j)
        const imported = await this.invoke(p.target,p,'import',{ operationId: operation.operationId, intentDigest: j.intentDigest, expectedRevision: target.revision, materialBase64: e.materialBase64 },signal,importDispatch)
        e.materialBase64 = undefined
        const receipt = rpcRecord(imported,['schema','action','applicationId','operationId','intentDigest','status'])
        if (receipt.operationId !== operation.operationId || receipt.intentDigest !== j.intentDigest || !['imported','rejected'].includes(receipt.status as string)) return failure('APPLICATION_ACCESS_IMPORT_UNCONFIRMED','The target import receipt is unconfirmed. Query the original operation without replaying it.')
        if (receipt.status === 'rejected') { operation.status = 'failed'; operation.cause = safeCause('APPLICATION_ACCESS_IMPORT_REJECTED','The target connector rejected this original import and preserved its prior configuration.'); await this.persist(j); return operation }
      }
      await this.verify(j,signal)
    } catch (error) {
      const mayHaveImported = importDispatch?.attempted === true
      if (!mayHaveImported) j.importDispatched = false
      operation.status = mayHaveImported || operation.stage === 'verifying' ? 'unknown' : 'failed'
      operation.cause = safeCause(operation.status === 'unknown' ? 'APPLICATION_ACCESS_IMPORT_UNCONFIRMED' : 'APPLICATION_ACCESS_NOT_IMPORTED', operation.status === 'unknown' ? 'The original target result is unconfirmed. Query this operation; no automatic transfer will be repeated.' : 'The original operation stopped before import dispatch. Inspect the current application configuration and plan again.')
      await this.persist(j)
    } finally { this.active.delete(operation.operationId) }
    return operation
  }
  private async verify(j: Journal, signal?: AbortSignal): Promise<void> {
    j.operation.stage = 'verifying'; await this.persist(j)
    const observed = await this.observe(j.profile.target,j.profile,'verify',signal)
    j.operation.targetObservation = observed
    if (observed.runtimeId === j.profile.target.runtimeId && observed.osAccount === j.profile.target.osAccount && covers(observed,j.profile)) {
      j.operation.status = 'succeeded'; j.operation.stage = 'complete'; delete j.operation.cause
    } else { j.operation.status = 'unknown'; j.operation.cause = safeCause('APPLICATION_ACCESS_TARGET_UNVERIFIED','The exact target account and all requested scopes have not been verified. Query the original operation; no import will be repeated.') }
    await this.persist(j)
  }
  private async inspectOperation(operationId: string, signal?: AbortSignal): Promise<ApplicationAccessOperation> {
    const j = await this.journal(operationId)
    if (!j) return failure('APPLICATION_ACCESS_OPERATION_NOT_FOUND','The exact original application operation is not recorded.')
    if (this.active.has(operationId) || j.operation.status === 'succeeded' || j.operation.status === 'failed') return j.operation
    if (['prepared','exporting'].includes(j.operation.stage)) {
      j.operation.status = 'failed'; j.operation.cause = safeCause('APPLICATION_ACCESS_NOT_IMPORTED','The original owner ended before any import dispatch was recorded. No import was repeated.'); await this.persist(j); return j.operation
    }
    this.active.add(operationId)
    try {
      if (!j.importDispatched) { await this.verify(j,signal); return j.operation }
      const result = await this.invoke(j.profile.target,j.profile,'operation',{operationId,intentDigest:j.intentDigest},signal)
      const r = rpcRecord(result,['schema','action','applicationId','operationId','intentDigest','status'])
      if (r.operationId !== operationId || r.intentDigest !== j.intentDigest || !['imported','rejected','unknown'].includes(r.status as string)) throw new Error()
      if (r.status === 'imported') await this.verify(j,signal)
      else if (r.status === 'rejected') { j.operation.status = 'failed'; j.operation.cause = safeCause('APPLICATION_ACCESS_IMPORT_REJECTED','The target connector confirms that the original import was rejected.'); await this.persist(j) }
      else { j.operation.status = 'unknown'; j.operation.cause = safeCause('APPLICATION_ACCESS_IMPORT_UNCONFIRMED','The target cannot yet confirm the original import. Keep this operation ID and query again.'); await this.persist(j) }
    } catch { j.operation.status = 'unknown'; j.operation.cause = safeCause('APPLICATION_ACCESS_IMPORT_UNCONFIRMED','The original target operation query is unconfirmed. The original record is retained; no import was repeated.'); await this.persist(j) }
    finally { this.active.delete(operationId) }
    return j.operation
  }
  async call<M extends ApplicationAccessMethod>(method: M, value: ApplicationAccessParameterMap[M], signal?: AbortSignal): Promise<ApplicationAccessResultMap[M]> {
    const p = parseApplicationAccessParams(method,value)
    let result: unknown
    if (method === 'settings.applications.ls') result = await this.list((p as ApplicationAccessParameterMap['settings.applications.ls']).hostId)
    else if (method === 'settings.applications.configure') result = await this.configure(p as ApplicationAccessParameterMap['settings.applications.configure'])
    else if (method === 'settings.applications.delete') {
      const input = p as ApplicationAccessParameterMap['settings.applications.delete'], c = await this.configuration(input.profileId)
      if (c.revision !== input.expectedRevision) return failure('APPLICATION_ACCESS_CONFIGURATION_CHANGED','The application configuration changed. Read its current revision before deleting.')
      const deleted = (await this.db()).prepare("DELETE FROM profiles WHERE id=? AND json_extract(json,'$.revision')=?").run(input.profileId,input.expectedRevision)
      if (deleted.changes !== 1) return failure('APPLICATION_ACCESS_CONFIGURATION_CHANGED','The application configuration changed before deletion. Read its current revision.')
      result = { profileId: input.profileId, deleted: true }
    } else if (method === 'settings.applications.plan') result = await this.plan(p as ApplicationAccessParameterMap['settings.applications.plan'],signal)
    else if (method === 'settings.applications.apply') result = await this.apply(p as ApplicationAccessParameterMap['settings.applications.apply'],signal)
    else result = await this.inspectOperation((p as ApplicationAccessParameterMap['settings.applications.operation']).operationId,signal)
    return result as ApplicationAccessResultMap[M]
  }
}
