import type { DatabaseSync } from 'node:sqlite'
import type { AgentMuxAgentSession } from './types.js'
import { optionalInputEpoch } from './agent-prompt-condition.js'
import { AgentMuxError } from './errors.js'
export type AgentInputNamespace = Pick<AgentMuxAgentSession, 'inputEpoch' | 'inputRestoration'>
export function parseInputRestoration(value: unknown, epoch: unknown): NonNullable<AgentMuxAgentSession['inputRestoration']> {
  const p=value as Record<string,unknown> | undefined
  if (!p || !epoch || p.reason!=='restored-snapshot' || typeof p.operationId!=='string' || !p.operationId.trim() || /[\0\r\n]/u.test(p.operationId) ||
      typeof p.sourceSHA256!=='string' || !/^[a-f0-9]{64}$/u.test(p.sourceSHA256) || Object.keys(p).some(key=>!['operationId','sourceSHA256','reason'].includes(key)))
    throw new AgentMuxError('The original input restoration source is invalid.', 'INVALID_AGENT_SESSION_STORE')
  return {operationId:p.operationId,sourceSHA256:p.sourceSHA256,reason:'restored-snapshot'}
}
/** Read only. Normal namespaces acquire neither a table nor a synthetic epoch. */
export function readInputNamespace(db: DatabaseSync): AgentInputNamespace {
  const marked=db.prepare('PRAGMA table_info(identity)').all().some(row=>row.name==='input_restore_schema')
  const present=Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='input_namespace'").get())
  if(!marked && !present && Number(db.prepare('PRAGMA user_version').get()?.user_version)<3)return {}
  if(!marked || !present || db.prepare('SELECT input_restore_schema FROM identity').get()?.input_restore_schema!==2)
    throw new AgentMuxError('The original restored input namespace metadata is missing or unconfirmed.', 'INVALID_AGENT_SESSION_STORE')
  if(!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='input_namespace_cuts'").get()) throw new AgentMuxError('The original input cut history is unconfirmed.', 'INVALID_AGENT_SESSION_STORE')
  const rows=db.prepare('SELECT singleton,epoch,restoration FROM input_namespace').all()
  if(rows.length!==1 || rows[0]!.singleton!==1)throw new AgentMuxError('The original input namespace cut is unconfirmed.', 'INVALID_AGENT_SESSION_STORE')
  const inputEpoch=optionalInputEpoch(rows[0]!.epoch).inputEpoch
  const inputRestoration=parseInputRestoration(JSON.parse(String(rows[0]!.restoration)),inputEpoch)
  const latest=db.prepare('SELECT operation_id,epoch,restoration FROM input_namespace_cuts ORDER BY sequence DESC LIMIT 1').get()
  if(!latest || latest.operation_id!==inputRestoration.operationId || latest.epoch!==inputEpoch || latest.restoration!==rows[0]!.restoration) throw new AgentMuxError('The original input cut does not match its durable history.', 'INVALID_AGENT_SESSION_STORE')
  return {...optionalInputEpoch(inputEpoch),inputRestoration}
}
/** Original-owner transaction only. Historical operation retries cannot roll the current cut back. */
export function writeInputNamespace(db: DatabaseSync, value: Required<AgentInputNamespace>): void {
  optionalInputEpoch(value.inputEpoch);parseInputRestoration(value.inputRestoration,value.inputEpoch)
  const current=readInputNamespace(db)
  if(current.inputEpoch){
    const prior=db.prepare('SELECT epoch,restoration FROM input_namespace_cuts WHERE operation_id=?').get(value.inputRestoration.operationId)
    if(prior){
      if(prior.epoch!==value.inputEpoch || prior.restoration!==JSON.stringify(value.inputRestoration)) throw new AgentMuxError('The original input cut operation names another source.', 'STORAGE_RECOVERY_INVALID')
      if(current.inputEpoch!==value.inputEpoch) throw new AgentMuxError('A newer original input cut is current. This historical restoration cannot roll it back.', 'STORAGE_RECOVERY_INPUT_CUT_SUPERSEDED')
      return
    }
  }
  if(!db.prepare('PRAGMA table_info(identity)').all().some(row=>row.name==='input_restore_schema')) db.exec('ALTER TABLE identity ADD COLUMN input_restore_schema INTEGER')
  db.exec('UPDATE identity SET input_restore_schema=2')
  db.exec('CREATE TABLE IF NOT EXISTS input_namespace(singleton INTEGER PRIMARY KEY CHECK(singleton=1),epoch TEXT NOT NULL,restoration TEXT NOT NULL)')
  db.exec('CREATE TABLE IF NOT EXISTS input_namespace_cuts(sequence INTEGER PRIMARY KEY,operation_id TEXT NOT NULL UNIQUE,epoch TEXT NOT NULL UNIQUE,restoration TEXT NOT NULL)')
  db.prepare('INSERT INTO input_namespace_cuts(operation_id,epoch,restoration) VALUES (?,?,?)').run(value.inputRestoration.operationId,value.inputEpoch,JSON.stringify(value.inputRestoration))
  db.prepare('INSERT INTO input_namespace VALUES (1,?,?) ON CONFLICT(singleton) DO UPDATE SET epoch=excluded.epoch,restoration=excluded.restoration').run(value.inputEpoch,JSON.stringify(value.inputRestoration))
}
