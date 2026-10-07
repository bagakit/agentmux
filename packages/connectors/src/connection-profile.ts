import { createHash } from 'node:crypto'
import { AgentMuxError } from '@agentmux/core'
import { parseConnectionConfig, parseConnectionProfileParams, parseConnectionProfileOperation, parseConnectionProfileObservation, type ConnectionConfig, type ConnectionEnrollmentCallContext, type ConnectionProfileOperation, type ConnectionProfilePort, type ConnectionProfileGet, type ConnectionProfileSync, type ConnectionProfileObservation, type ConnectionProfileReason } from '@agentmux/core/connections'
import type { ConnectionHost, SecretPort } from './connection-host.js'
import { ProfilePreparationError } from './connection-profile-adapter.js'
import type { ProfileEffect, ProfileUploadEffect, ProfilePreparedRequest } from './connection-profile-adapter.js'

type Step = 'upload' | 'patch'
type Row = { input: ConnectionProfileSync; config: ConnectionConfig; actor: ConnectionEnrollmentCallContext['actor']; operation: ConnectionProfileOperation; uploadWire: ProfilePreparedRequest | null; patchWire: ProfilePreparedRequest | null; avatarUrl: string | null }
const activeApplicationWrites = new Map<string, object>()
type Settlement = { step: Step; wire: ProfilePreparedRequest; effect: ProfileUploadEffect | ProfileEffect }
const error = (message: string, code = 'CONNECTION_PROFILE_UNCONFIRMED') => new AgentMuxError(message, code)
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
/** Finite original upload/PATCH journal; no publication, background worker or second profile truth. */
export class ConnectionProfileHost implements ConnectionProfilePort {
  private closed = false
  private readonly live = new Map<string, Promise<ConnectionProfileOperation>>()
  private readonly settlements = new Map<string, Settlement>()
  constructor(private readonly connections: ConnectionHost, private readonly secrets: SecretPort) {
    connections.database.exec(`CREATE TABLE IF NOT EXISTS connection_profile_operation (
      ordinal INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL UNIQUE, connection_id TEXT NOT NULL,
      input_json TEXT NOT NULL, config_json TEXT NOT NULL, actor_json TEXT NOT NULL, record_json TEXT NOT NULL,
      upload_wire TEXT, patch_wire TEXT, avatar_url TEXT);
      CREATE INDEX IF NOT EXISTS connection_profile_connection ON connection_profile_operation(connection_id, ordinal);`)
  }
  private safe<T>(fn: () => T): T { try { return fn() } catch(e) { if(e instanceof AgentMuxError) throw e; throw error('Profile storage cannot confirm this original operation. Existing connections remain available; inspect the same operation.') } }
  private read(id: string): Row | null {
    const r = this.connections.database.prepare('SELECT * FROM connection_profile_operation WHERE operation_id=?').get(id)
    if(!r) return null
    return { input:parseConnectionProfileParams('connection.profile.sync',JSON.parse(String(r.input_json))), config:parseConnectionConfig(JSON.parse(String(r.config_json))), actor:JSON.parse(String(r.actor_json)), operation:parseConnectionProfileOperation(JSON.parse(String(r.record_json))), uploadWire:r.upload_wire?JSON.parse(String(r.upload_wire)):null, patchWire:r.patch_wire?JSON.parse(String(r.patch_wire)):null, avatarUrl:r.avatar_url===null?null:String(r.avatar_url) }
  }
  private projection(row: Row): ConnectionProfileOperation {
    const op = structuredClone(row.operation)
    for(const step of ['upload','patch'] as const) if(op[step].state==='dispatching'){op[step].state='unknown';op.reason=this.settlements.has(row.input.operationId)?'storage-unconfirmed':'effect-unconfirmed'}
    return parseConnectionProfileOperation(op)
  }
  private save(row: Row): void {
    parseConnectionProfileOperation(row.operation)
    this.connections.database.prepare('UPDATE connection_profile_operation SET record_json=?,upload_wire=?,patch_wire=?,avatar_url=? WHERE operation_id=?').run(JSON.stringify(row.operation),row.uploadWire?JSON.stringify(row.uploadWire):null,row.patchWire?JSON.stringify(row.patchWire):null,row.avatarUrl,row.input.operationId)
  }
  private assertActor(row: Row, context: ConnectionEnrollmentCallContext): void { if(!same(row.actor,context.actor)) throw error('Only the original trusted actor may advance this profile operation.','CONTROL_PERMISSION_DENIED') }
  private async authority(context?: ConnectionEnrollmentCallContext): Promise<void> { if(this.closed) throw error('The original profile owner is closed.');context?.signal?.throwIfAborted();await context?.assertCurrent?.();if(this.closed)throw error('The original profile owner is closed.');context?.signal?.throwIfAborted() }
  private current(row: Row): boolean { const c=this.connections.readConfiguration(row.input.connectionId);return c?.revision===row.input.expectedConnectionRevision&&same(c.config,row.config) }
  private reason(row: Row, reason: ConnectionProfileReason): ConnectionProfileOperation { this.safe(()=>this.connections.database.prepare("UPDATE connection_profile_operation SET record_json=json_set(record_json,'$.reason',?) WHERE operation_id=?").run(reason,row.input.operationId));return this.projection(this.safe(()=>this.read(row.input.operationId))!) }
  async inspect(value: {operationId:string}) { const i=parseConnectionProfileParams('connection.profile.inspect',value);return this.safe(()=>{const r=this.read(i.operationId);return {operation:r?this.projection(r):null}}) }
  async list(value: {connectionId:string;cursor?:string;limit?:number}) {
    const i=parseConnectionProfileParams('connection.profile.ls',value), limit=i.limit??25
    let before=Number.MAX_SAFE_INTEGER
    if(i.cursor!==undefined){if(!/^[1-9][0-9]*$/u.test(i.cursor)||!Number.isSafeInteger(Number(i.cursor)))throw error('The original profile page cursor is invalid.','INVALID_CONNECTION_PROFILE_DATA');before=Number(i.cursor)}
    return this.safe(()=>{const rows=this.connections.database.prepare('SELECT operation_id,ordinal FROM connection_profile_operation WHERE connection_id=? AND ordinal<? ORDER BY ordinal DESC LIMIT ?').all(i.connectionId,before,limit+1);return {operations:rows.slice(0,limit).map(r=>this.projection(this.read(String(r.operation_id))!)),next:rows.length>limit?String(rows[limit-1]!.ordinal):null}})
  }
  private unknown(input: ConnectionProfileGet, config:ConnectionConfig, reason:ConnectionProfileReason):ConnectionProfileObservation { return {connectionId:input.connectionId,connectionRevision:input.expectedConnectionRevision,application:config.application,language:null,state:'unknown',profile:null,metadata:null,botId:null,onlineVersionId:null,reviewingVersionId:null,version:null,reason} }
  async get(value:ConnectionProfileGet,context?:ConnectionEnrollmentCallContext):Promise<ConnectionProfileObservation> {
    const i=parseConnectionProfileParams('connection.profile.get',value);await this.authority(context)
    const c=this.connections.readConfiguration(i.connectionId);if(!c)throw error('The exact connection is unknown.','UNKNOWN_CONNECTION')
    if(c.revision!==i.expectedConnectionRevision)return this.unknown(i,c.config,'connection-revised')
    const adapter=this.connections.registeredAdapter(c.config.adapterId)?.profile
    if(!adapter)return this.unknown(i,c.config,'adapter-unavailable')
    let credential:string|null;try{credential=await this.secrets.resolve(c.config.credentialRef)}catch{return this.unknown(i,c.config,'credential-unavailable')}
    if(!credential)return this.unknown(i,c.config,'credential-unavailable')
    await this.authority(context)
    if(this.connections.readConfiguration(i.connectionId)?.revision!==c.revision)return this.unknown(i,c.config,'connection-revised')
    try {
      const observed=parseConnectionProfileObservation(await adapter.get(c.config,c.revision,credential,context?.signal))
      if(observed.connectionId!==i.connectionId||observed.connectionRevision!==c.revision||!same(observed.application,c.config.application))return this.unknown(i,c.config,'online-unconfirmed')
      if(this.closed||this.connections.readConfiguration(i.connectionId)?.revision!==c.revision)return this.unknown(i,c.config,'connection-revised')
      return observed
    } catch {return this.unknown(i,c.config,'online-unconfirmed')}
  }
  async sync(value:ConnectionProfileSync,context:ConnectionEnrollmentCallContext):Promise<ConnectionProfileOperation> {
    const input=parseConnectionProfileParams('connection.profile.sync',value);await this.authority(context)
    this.safe(()=>{
      const db=this.connections.database;db.exec('BEGIN IMMEDIATE')
      try {
        const old=this.read(input.operationId)
        if(old){this.assertActor(old,context);if(!same(old.input,input))throw error('This original profile operation has different input. Inspect it without replacing its identity.','CONNECTION_OPERATION_CONFLICT')}
        else {
          const c=this.connections.readConfiguration(input.connectionId)
          if(!c)throw error('The exact connection is unknown.','UNKNOWN_CONNECTION')
          if(c.revision!==input.expectedConnectionRevision)throw error('The exact connection revision changed. Read it before making a new explicit profile request.','CONNECTION_REVISION_CONFLICT')
          const avatar=input.desired.avatar
          const op:ConnectionProfileOperation={operationId:input.operationId,connectionId:input.connectionId,connectionRevision:c.revision,application:c.config.application,language:null,fields:[...(input.desired.name!==undefined?['name' as const]:[]),...(input.desired.description!==undefined?['description' as const]:[]),...(avatar?['avatar' as const]:[])],desired:{...(input.desired.name===undefined?{}:{name:input.desired.name}),...(input.desired.description===undefined?{}:{description:input.desired.description}),...(avatar?{avatarSha256:createHash('sha256').update(Buffer.from(avatar.pngDataUrl.slice(22),'base64')).digest('hex')}:{})},upload:{state:avatar?'not-dispatched':'not-required'},patch:{state:'not-dispatched'},publication:'not-requested',online:null}
          parseConnectionProfileOperation(op)
          db.prepare('INSERT INTO connection_profile_operation(operation_id,connection_id,input_json,config_json,actor_json,record_json) VALUES(?,?,?,?,?,?)').run(input.operationId,input.connectionId,JSON.stringify(input),JSON.stringify(c.config),JSON.stringify(context.actor),JSON.stringify(op))
        }
        db.exec('COMMIT')
      }catch(e){db.exec('ROLLBACK');throw e}
    })
    return this.advance({operationId:input.operationId},context)
  }
  async advance(value:{operationId:string},context:ConnectionEnrollmentCallContext):Promise<ConnectionProfileOperation> {
    const i=parseConnectionProfileParams('connection.profile.advance',value);await this.authority(context)
    const row=this.safe(()=>this.read(i.operationId));if(!row)throw error('The original profile operation is unknown.','UNKNOWN_CONNECTION_PROFILE_OPERATION');this.assertActor(row,context)
    const live=this.live.get(i.operationId);if(live)return this.projection(row)
    const work=this.run(i.operationId,context);this.live.set(i.operationId,work)
    try{return await work}finally{if(this.live.get(i.operationId)===work)this.live.delete(i.operationId)}
  }
  private settle(id:string,settlement:Settlement):void {
    this.safe(()=>{
      const db=this.connections.database;db.exec('BEGIN IMMEDIATE')
      try {
      const row=this.read(id)!;const wire=settlement.step==='upload'?row.uploadWire:row.patchWire
      if(row.operation[settlement.step].state!=='dispatching'||!same(wire,settlement.wire)){db.exec('COMMIT');return}
      const effect=settlement.effect
      row.operation[settlement.step]={state:effect.state};delete row.operation.reason
      if(effect.state==='confirmed'){
        if(settlement.step==='upload'){
          const avatarUrl=(effect as Extract<ProfileUploadEffect,{state:'confirmed'}>).avatarUrl
          const u=new URL(avatarUrl);if(u.protocol!=='https:'||u.username||u.password)throw error('The original avatar receipt is unconfirmed.')
          row.avatarUrl=avatarUrl
        } else row.operation.publication='platform-review-required'
      }else row.operation.reason=effect.reason
      this.save(row);db.exec('COMMIT')
      }catch(e){db.exec('ROLLBACK');throw e}
    })
  }
  private claim(id:string,step:Step,wire:ProfilePreparedRequest):Row|null {
    return this.safe(()=>{const db=this.connections.database;db.exec('BEGIN IMMEDIATE');try{
      const row=this.read(id)!;if(this.closed||row.operation[step].state!=='not-dispatched'||!this.current(row)){db.exec('COMMIT');return null}
      row.operation[step]={state:'dispatching'};delete row.operation.reason
      if(step==='upload')row.uploadWire=wire;else {row.patchWire=wire;row.operation.language=wire.language??null}
      this.save(row);db.exec('COMMIT');return row
    }catch(e){db.exec('ROLLBACK');throw e}})
  }
  private async run(id:string,context:ConnectionEnrollmentCallContext):Promise<ConnectionProfileOperation> {
    const settlement=this.settlements.get(id)
    if(settlement){try{this.settle(id,settlement);this.settlements.delete(id)}catch{return this.projection(this.safe(()=>this.read(id))!)}}
    let row=this.safe(()=>this.read(id))!
    if(!this.current(row))return this.reason(row,'connection-revised')
    const adapter=this.connections.registeredAdapter(row.config.adapterId)?.profile
    if(!adapter)return this.reason(row,'adapter-unavailable')
    let credential:string|null;try{credential=await this.secrets.resolve(row.config.credentialRef)}catch{return this.reason(row,'credential-unavailable')}
    if(!credential)return this.reason(row,'credential-unavailable')
    for(const step of ['upload','patch'] as const){
      row=this.safe(()=>this.read(id))!
      if(step==='patch'&&row.operation.upload.state!=='confirmed'&&row.operation.upload.state!=='not-required')break
      if(row.operation[step].state!=='not-dispatched')continue
      await this.authority(context)
      let wire:ProfilePreparedRequest
      try{wire=await (step==='upload'?adapter.prepareUpload(row.config,row.input.desired.avatar!.pngDataUrl):adapter.preparePatch(row.config,{...(row.input.desired.name===undefined?{}:{name:row.input.desired.name}),...(row.input.desired.description===undefined?{}:{description:row.input.desired.description})},row.avatarUrl??undefined,credential,context.signal));if(!wire.format||typeof wire.body!=='string')throw error('Unconfirmed prepared profile request.')}
      catch(e){return this.reason(row,e instanceof ProfilePreparationError?e.reason:'source-unconfirmed')}
      await this.authority(context)
      const applicationKey=JSON.stringify(row.config.application), token={}
      if(step==='patch'&&activeApplicationWrites.has(applicationKey))return this.reason(row,'effect-unconfirmed')
      if(step==='patch')activeApplicationWrites.set(applicationKey,token)
      let claimed:Row|null
      try{claimed=this.claim(id,step,wire)}catch(e){if(activeApplicationWrites.get(applicationKey)===token)activeApplicationWrites.delete(applicationKey);throw e}
      if(!claimed){if(activeApplicationWrites.get(applicationKey)===token)activeApplicationWrites.delete(applicationKey);break}
      let effect:ProfileUploadEffect|ProfileEffect
      try{effect=step==='upload'?await adapter.upload(claimed.config,wire,credential,context.signal):await adapter.patch(claimed.config,wire,credential,context.signal)}catch{effect={state:'unknown',reason:'effect-unconfirmed'}}
      finally{if(activeApplicationWrites.get(applicationKey)===token)activeApplicationWrites.delete(applicationKey)}
      const saved:Settlement={step,wire,effect}
      if(this.closed)return this.projection(claimed)
      this.settlements.set(id,saved)
      try{this.settle(id,saved);this.settlements.delete(id)}catch{return this.projection(this.safe(()=>this.read(id))!)}
    }
    row=this.safe(()=>this.read(id))!
    const online=await this.get({connectionId:row.input.connectionId,expectedConnectionRevision:row.input.expectedConnectionRevision},context)
    if(!this.closed){this.safe(()=>this.connections.database.prepare("UPDATE connection_profile_operation SET record_json=json_set(record_json,'$.online',json(?)) WHERE operation_id=?").run(JSON.stringify(online),id));row=this.safe(()=>this.read(id))!}
    return this.projection(row)
  }
  close():void {this.closed=true;this.settlements.clear()}
}
