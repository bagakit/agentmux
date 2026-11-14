import { createHash } from 'node:crypto'
import { backup, DatabaseSync } from 'node:sqlite'
import { lstat, mkdir, rm, chmod } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { readInputNamespace, writeInputNamespace } from './agent-input-epoch.js'
import { AgentMuxError } from './errors.js'
import { normalizeStoredAgentSession } from './agent-session-store.js'
import { initializeLegacyClosedCreationSchema, readCurrentSessionDatabase, syncSessionDatabase } from './agent-session-database.js'
import { hashRecoveryFile, requireRecoverySpace } from './storage-recovery.js'

export type SessionInputRestorePreparation = {
  sourcePath: string
  /** A fresh private staging directory. It is never the original live namespace. */
  stagingPath: string
  operationId: string
  expectedIncarnation: string
}
export type RestoredInputSelector = { agentSessionId: string; operationId?: string; reason: string }
export type SessionInputRestorePrepared =
  | { state: 'unavailable'; selectors: RestoredInputSelector[] }
  | { state: 'prepared'; file: string; incarnation: string; sourceVersion: number; inputEpoch: string; sourceSHA256: string;
      heldInitialInputs: number; heldFutureIntents: number }

function invalid(message: string): never { throw new AgentMuxError(message, 'STORAGE_RECOVERY_INVALID') }
function identity(value: string): boolean { return typeof value === 'string' && !!value.trim() && value.length <= 512 && !/[\0\r\n]/u.test(value) }

/** Exact original FileStore candidate preparation. The caller owns source admission/publication. */
export async function prepareSessionInputRestore(livePath: string, input: SessionInputRestorePreparation): Promise<SessionInputRestorePrepared> {
  if (!isAbsolute(input.sourcePath) || !isAbsolute(input.stagingPath) || !identity(input.operationId) || !identity(input.expectedIncarnation) ||
      resolve(input.sourcePath) === resolve(livePath) || resolve(input.stagingPath) === resolve(livePath) ||
      resolve(input.stagingPath) === resolve(input.sourcePath)) invalid('Recovery preparation requires the exact qualified source and a fresh isolated staging directory.')
  const attributes = await lstat(input.sourcePath)
  if (!attributes.isFile() || attributes.isSymbolicLink()) invalid('The original recovery SQLite source must be a regular file.')
  const before = await hashRecoveryFile(input.sourcePath)
  const source = await readCurrentSessionDatabase(input.sourcePath, { readOnly: true })
  if (!source) invalid('The original Session SQLite source is missing.')
  let created = false
  try {
    const incarnation = String(source.prepare('SELECT incarnation FROM identity').get()!.incarnation)
    const sourceVersion = Number(source.prepare('PRAGMA user_version').get()?.user_version)
    readInputNamespace(source)
    if (incarnation !== input.expectedIncarnation || source.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') invalid('The recovery source does not confirm the exact original database incarnation.')
    const selectors=sessionInputRestoreSelectors(source)
    if (selectors.length) return { state: 'unavailable', selectors }
    // mkdir is exclusive: backup must never overwrite another candidate, source, or live path.
    await mkdir(input.stagingPath, { mode: 0o700 }); created = true
    await requireRecoverySpace(input.stagingPath, BigInt(attributes.size))
    const file = join(input.stagingPath, 'database.sqlite')
    await backup(source, file); await chmod(file, 0o600)
    const after = await hashRecoveryFile(input.sourcePath)
    if (after.sha256 !== before.sha256 || after.bytes !== before.bytes) invalid('The qualified original snapshot changed during preparation.')
    const namespace=recoveryInputNamespace(incarnation,input.operationId,before.sha256)
    const {inputEpoch}=namespace
    let heldInitialInputs=0,heldFutureIntents=0
    const candidate = new DatabaseSync(file)
    try {
      candidate.exec('PRAGMA synchronous=FULL; BEGIN IMMEDIATE')
      ;({heldInitialInputs,heldFutureIntents}=holdSessionInputRestore(candidate,namespace))
      candidate.exec('COMMIT')
      if (candidate.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok' || candidate.prepare('SELECT incarnation FROM identity').get()?.incarnation !== incarnation) invalid('The held candidate failed its original identity check.')
    } finally { candidate.close() }
    await syncSessionDatabase(file)
    return { state: 'prepared', file, incarnation, sourceVersion, inputEpoch, sourceSHA256: before.sha256, heldInitialInputs, heldFutureIntents }
  } catch (error) {
    if (created) await rm(input.stagingPath, { recursive: true, force: true })
    throw error
  } finally { source.close() }
}

export function sessionInputRestoreSelectors(db: DatabaseSync): RestoredInputSelector[] {
  const selectors: RestoredInputSelector[] = []
  for (const row of db.prepare('SELECT id,json FROM reservations').all()) {
      const value = JSON.parse(String(row.json))
      selectors.push({ agentSessionId: String(row.id), operationId: value.operationId, reason: 'prepared-lifecycle-hold-unavailable' })
    }
  const sessions = db.prepare('SELECT id,json FROM sessions').all().map(row => ({ id: String(row.id), raw: JSON.parse(String(row.json)) }))
  for (const { id, raw } of sessions) {
      const session = normalizeStoredAgentSession(raw)
      if (session.initialInput?.state === 'prepared' && (session.initialInput.delivery !== 'post-launch' || !session.initialInput.key))
        selectors.push({ agentSessionId: id, operationId: session.initialInput.lifecycleOperationId, reason: 'prepared-launch-input-hold-unavailable' })
    for (const operation of Object.values(session.continuityOperations ?? {})) {
        if (operation.supervision && !['settled', 'cancelled'].includes(operation.supervision.phase) ||
            operation.nextActionAt !== undefined && !operation.supervision && !operation.action ||
            operation.recoveryDelivery && !['accepted', 'not-applied', 'superseded'].includes(operation.recoveryDelivery.phase) ||
            operation.launchInput?.state === 'prepared') selectors.push({ agentSessionId: id, operationId: operation.operationId, reason: 'continuity-input-hold-unavailable' })
      }
    }
  return selectors
}

export function recoveryInputNamespace(incarnation:string,operationId:string,sourceSHA256:string) {
 if(!identity(operationId)||!identity(incarnation)||!/^[a-f0-9]{64}$/u.test(sourceSHA256))invalid('The original input cut source is invalid.')
 const inputEpoch='restore:'+createHash('sha256').update(JSON.stringify([incarnation,operationId,sourceSHA256])).digest('base64url')
 return {inputEpoch,inputRestoration:{operationId,sourceSHA256,reason:'restored-snapshot' as const}}
}

/** Called under the original Store transaction and original Session prompt leases. */
export function holdSessionInputRestore(db:DatabaseSync,namespace:ReturnType<typeof recoveryInputNamespace>) {
 initializeLegacyClosedCreationSchema(db)
 writeInputNamespace(db,namespace)
 db.exec('PRAGMA user_version=3')
 let heldInitialInputs=0,heldFutureIntents=0
 const update=db.prepare('UPDATE sessions SET json=? WHERE id=?')
 for(const row of db.prepare('SELECT id,json FROM sessions').all()){
  const raw=JSON.parse(String(row.json)),next={...raw,...namespace}
  if(next.initialInput?.state==='prepared'){next.initialInput={...next.initialInput,state:'unknown'};heldInitialInputs++}
  normalizeStoredAgentSession(next);update.run(JSON.stringify(next),row.id!)
 }
 const updateFuture=db.prepare('UPDATE future_intents SET json=? WHERE session_id=? AND intent_id=?')
 for(const row of db.prepare('SELECT session_id,intent_id,json FROM future_intents').all()){
  const intent=JSON.parse(String(row.json))
  if(intent.active===true){updateFuture.run(JSON.stringify({...intent,active:false}),row.session_id!,row.intent_id!);heldFutureIntents++}
 }
 return {heldInitialInputs,heldFutureIntents}
}
