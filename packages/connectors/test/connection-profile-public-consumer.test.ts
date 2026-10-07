import { afterEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { AgentMuxRpcService } from '@agentmux/core'
import { ConnectionHost, ConnectionProfileHost, type ConnectionProfileAdapter, type ProfileEffect } from '@agentmux/connectors'
import { parseConnectionProfileOperation, parseConnectionProfileResult } from '@agentmux/core/connections'
import { profileFixture, profilePng, profileDataUrl, originalI18n } from './fixtures/connection-profile.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../core/test/helpers/object-cli-rpc.js'

const cleanup:Array<()=>void|Promise<void>>=[]
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();vi.restoreAllMocks()})
async function fixture(options:Parameters<typeof profileFixture>[0]={}){const f=await profileFixture(options);cleanup.push(f.close);return f}
const result=(r:{code:number|null;stdout:string;stderr:string})=>{expect(r.code,r.stdout+r.stderr).toBe(0);return JSON.parse(r.stdout).result}

it('uses actual default Desktop SDK, encrypted credential and compiled CLI, freezing bytes before separate upload and PATCH',async()=>{
  const f=await fixture()
  expect(result(await f.cli(['ls','--connection',f.input.connectionId])).operations).toEqual([]);expect(f.calls).toHaveLength(0)
  const saved=result(await f.cli(['sync','--input','-'],f.input))
  expect(saved).toMatchObject({operationId:f.input.operationId,language:'zh_cn',upload:{state:'confirmed'},patch:{state:'confirmed'},publication:'platform-review-required',desired:{avatarSha256:createHash('sha256').update(profilePng).digest('hex')}})
  expect(saved.online).toMatchObject({profile:{name:'Online name',description:'Exact online description'},metadata:{description:'Draft metadata description'},onlineVersionId:'online-original',version:{versionId:'online-original',status:'approved'}})
  expect(f.effects.map(e=>[e.kind,e.preclaimed])).toEqual([['upload',true],['patch',true]])
  expect(Buffer.from((f.effects[0]!.data as {avatar:Buffer}).avatar)).toEqual(profilePng)
  expect(f.effects[1]!.data).toEqual({i18ns:[originalI18n[0],{i18n_key:'zh_cn',name:'Desired name',description:'Desired description'}],avatar_url:'https://images.example.invalid/upload.png'})
  expect(f.calls.some(r=>r.url?.endsWith('/publish'))).toBe(false)
  expect(result(await f.cli(['get','--connection',f.input.connectionId,'--revision','1'])).profile.description).toBe('Exact online description')
  const before=f.calls.length
  expect((await f.sdk.call('connection.profile.inspect',{operationId:f.input.operationId})).operation).toEqual(saved)
  expect(result(await f.cli(['ls','--connection',f.input.connectionId])).operations).toEqual([saved]);expect(f.calls).toHaveLength(before)
  expect(await f.sdk.call('connection.profile.sync',f.input)).toEqual(saved);expect(f.effects).toHaveLength(2)
  expect(JSON.stringify(saved)).not.toContain('private-profile-secret');expect(JSON.stringify(saved)).not.toContain(profileDataUrl)
  expect(JSON.stringify(saved)).not.toContain('feishu-profile-base-v1')
  await f.closeOwner();await f.reopen()
  expect(result(await f.cli(['inspect','--operation-id',f.input.operationId])).operation).toEqual(saved)
  expect((await f.sdk.call('connection.ls',{})).connections).toHaveLength(1)
},30_000)

it('uses a signed alternate protocol through the same public owner and preserves operation identity and trusted authority',async()=>{
  const f=await fixture({generic:true})
  const op=result(await f.cli(['sync','--input','-'],f.input));expect(op.patch.state).toBe('confirmed');expect(f.effects.every(e=>e.preclaimed)).toBe(true)
  await expect(f.sdk.call('connection.profile.sync',{...f.input,desired:{name:'Changed'}})).rejects.toMatchObject({code:'CONNECTION_OPERATION_CONFLICT'})
  const service=new AgentMuxRpcService({connections:f.services.connections});cleanup.push(()=>service.dispose())
  await expect(service.call('connection.profile.advance',{operationId:f.input.operationId},{})).rejects.toMatchObject({code:'CONTROL_PERMISSION_DENIED'})
  await expect(service.call('connection.profile.advance',{operationId:f.input.operationId},{principal:{kind:'user',id:'another-user'}})).rejects.toMatchObject({code:'CONTROL_PERMISSION_DENIED'})
  expect((await f.cli(['sync','--input','-'],{...f.input,authenticated:true})).code).not.toBe(0)
  expect(f.effects).toHaveLength(2)
  expect(()=>parseConnectionProfileOperation({...op,prepared:'private-native-wire'})).toThrow()
  expect(()=>parseConnectionProfileResult('connection.profile.inspect',{operation:{...op,operationId:'foreign'}},{operationId:f.input.operationId})).toThrow()
},30_000)

it.each(['upload','patch'] as const)('retains unknown %s and does not re-effect it on advance or database reopen',async step=>{
  const f=await fixture({generic:true,profile:{[step]:vi.fn(async()=>{throw new Error('private unsafe platform diagnostic')})}})
  const input=step==='patch'?{...f.input,desired:{name:'Original desired'}}:f.input
  const op=await f.sdk.call('connection.profile.sync',input);expect(op[step].state).toBe('unknown');expect(op.reason).toBe('effect-unconfirmed')
  expect(JSON.stringify(op)).not.toContain('unsafe')
  await f.sdk.call('connection.profile.advance',{operationId:input.operationId});expect(f.profile[step]).toHaveBeenCalledTimes(1)
  await f.closeOwner();await f.reopen();expect((await f.sdk.call('connection.profile.inspect',{operationId:input.operationId})).operation?.[step].state).toBe('unknown')
  await f.sdk.call('connection.profile.advance',{operationId:input.operationId});expect(f.profile[step]).toHaveBeenCalledTimes(1)
},30_000)

it('does not block an independent identity or local inspect while another original effect is waiting',async()=>{
  let release!:(v:{state:'confirmed'})=>void
  const f=await fixture({generic:true,profile:{patch:vi.fn<ConnectionProfileAdapter['patch']>(async(config)=>config.connectionId==='profile-connection'?new Promise<ProfileEffect>(r=>{release=r}):{state:'confirmed'})}})
  const pending=f.sdk.call('connection.profile.sync',{...f.input,desired:{name:'First'}})
  await vi.waitFor(()=>expect(f.profile.patch).toHaveBeenCalledTimes(1))
  expect((await f.sdk.call('connection.profile.inspect',{operationId:f.input.operationId})).operation?.patch.state).toBe('unknown')
  await f.sdk.call('connection.configure',{operationId:'alias-configure',expectedRevision:null,connection:{...f.config,connectionId:'same-app-alias'}})
  const alias=await f.sdk.call('connection.profile.sync',{...f.input,operationId:'alias-profile',connectionId:'same-app-alias',desired:{name:'Next original write'}})
  expect(alias.patch.state).toBe('not-dispatched');expect(alias.reason).toBe('effect-unconfirmed');expect(f.profile.patch).toHaveBeenCalledTimes(1)
  const saved=await f.sdk.call('connection.configure',{operationId:'second-configure',expectedRevision:null,connection:{...f.config,connectionId:'second-connection',application:{...f.config.application,appId:'second-app'}}})
  const second=await f.sdk.call('connection.profile.sync',{...f.input,operationId:'second-profile',connectionId:saved.connection.config.connectionId,desired:{name:'Second'}})
  expect(second.patch.state).toBe('confirmed');release({state:'confirmed'});expect((await pending).patch.state).toBe('confirmed')
  expect((await f.sdk.call('connection.profile.advance',{operationId:'alias-profile'})).patch.state).toBe('confirmed');expect(f.profile.patch).toHaveBeenCalledTimes(3)
},30_000)

it('rechecks exact revision and current authority after preparation without borrowing IM availability',async()=>{
  const f=await fixture({generic:true})
  await f.sdk.call('connection.configure',{operationId:'disabled-configure',expectedRevision:1,connection:{...f.config,enabled:false}})
  expect((await f.sdk.call('connection.profile.sync',{...f.input,expectedConnectionRevision:2,desired:{name:'Manage a disabled receiver'}})).patch.state).toBe('confirmed')
  const next={...f.input,operationId:'later-profile',expectedConnectionRevision:2,desired:{name:'Later'}}
  const old=f.profile.preparePatch
  f.profile.preparePatch=async(...args)=>{const wire=await old(...args);await f.sdk.call('connection.configure',{operationId:'changed-configure',expectedRevision:2,connection:{...f.config,enabled:false,label:'Changed label'}});return wire}
  const retained=await f.sdk.call('connection.profile.sync',next);expect(retained.patch.state).toBe('not-dispatched');expect(retained.online?.reason).toBe('connection-revised')
  expect(f.profile.patch).toHaveBeenCalledTimes(1)
},30_000)

it('recovers an original live settlement after storage failure without another upload, and keeps pages scoped',async()=>{
  let fail=false
  const f=await fixture({generic:true,profile:{upload:vi.fn<ConnectionProfileAdapter['upload']>(async()=>{fail=true;return {state:'confirmed',avatarUrl:'https://images.example.invalid/original.png'}})}})
  const db=f.services.database!,prepare=db.prepare.bind(db)
  vi.spyOn(db,'prepare').mockImplementation(sql=>{if(fail&&sql.startsWith('UPDATE connection_profile_operation SET record_json=')){fail=false;throw new Error('private store outage')};return prepare(sql)})
  const uncertain=await f.sdk.call('connection.profile.sync',f.input);expect(uncertain.upload.state).toBe('unknown')
  const done=await f.sdk.call('connection.profile.advance',{operationId:f.input.operationId});expect(done.patch.state).toBe('confirmed');expect(f.profile.upload).toHaveBeenCalledTimes(1)
  for(const operationId of ['profile-second','profile-third'])await f.sdk.call('connection.profile.sync',{...f.input,operationId,desired:{name:operationId}})
  const page=result(await f.cli(['ls','--connection',f.input.connectionId,'--limit','1']));expect(page.operations[0].operationId).toBe('profile-third')
  const next=result(await f.cli(['ls','--connection',f.input.connectionId,'--limit','1','--cursor',page.next]));expect(next.operations[0].operationId).toBe('profile-second')
  expect((await f.cli(['ls','--connection',f.input.connectionId,'--limit','0'])).code).not.toBe(0)
},30_000)

it.each(['upload','patch'] as const)('keeps preclaimed %s unknown after real child death and a new CLI owner without replay',async mode=>{
  const root=await mkdtemp(join(tmpdir(),'profile-child-'));cleanup.push(()=>rm(root,{recursive:true,force:true}))
  const socket=join(root,'owner.sock')
  const start=async(fault:string)=>{
    const child=fork(new URL('./fixtures/connection-profile-owner.mjs',import.meta.url),[root,fault],{execArgv:['--experimental-transform-types'],env:objectCliEnvironment(root),stdio:['ignore','pipe','pipe','ipc']})
    let stderr='';child.stderr!.on('data',s=>{stderr+=s})
    cleanup.push(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await once(child,'exit')}})
    await new Promise<void>((resolve,reject)=>{child.on('message',m=>{if((m as {kind:string}).kind==='ready')resolve()});child.once('exit',()=>reject(new Error(stderr||'Child exited before ready')))})
    return child
  }
  const cli=(args:string[],body?:unknown)=>runCompiledObjectCli(['--endpoint','unix:'+socket,'connection','profile',...args],objectCliEnvironment(root),body===undefined?'':JSON.stringify(body))
  const child=await start(mode),applied=new Promise<void>(r=>child.on('message',m=>{if((m as {kind:string}).kind==='effect-applied')r()}))
  const input={operationId:'child-profile',connectionId:'child-connection',expectedConnectionRevision:1,desired:mode==='upload'?{avatar:{pngDataUrl:profileDataUrl}}:{name:'Original child name'}}
  const pending=cli(['sync','--input','-'],input);await applied;child.kill('SIGKILL');await once(child,'exit');expect((await pending).code).not.toBe(0)
  await start('observe')
  const original=result(await cli(['inspect','--operation-id',input.operationId])).operation
  expect(original[mode].state).toBe('unknown');expect(original.connectionId).toBe(input.connectionId)
  expect(result(await cli(['ls','--connection',input.connectionId])).operations).toEqual([original])
  const advanced=result(await cli(['advance','--operation-id',input.operationId]));expect(advanced[mode].state).toBe('unknown')
  expect((await readFile(join(root,'effects'),'utf8')).trim().split('\n')).toHaveLength(1)
  const db=new DatabaseSync(join(root,'connections.sqlite'),{readOnly:true});try{const row=db.prepare('SELECT record_json,upload_wire,patch_wire FROM connection_profile_operation WHERE operation_id=?').get(input.operationId)!;expect(JSON.parse(String(row.record_json))[mode].state).toBe('dispatching');expect(row[mode+'_wire']).not.toBeNull()}finally{db.close()}
},30_000)


it('rejects unsafe original Host projections through the real public SDK and keeps optional profile storage failure local',async()=>{
  const f=await fixture({generic:true})
  const execute=f.services.database!.exec.bind(f.services.database!)
  const fault=vi.spyOn(f.services.database!,'exec').mockImplementation(sql=>{if(sql.includes('CREATE TABLE IF NOT EXISTS connection_profile_operation'))throw new Error('Private profile DDL detail');return execute(sql)})
  await expect(f.sdk.call('connection.profile.ls',{connectionId:f.input.connectionId})).rejects.toMatchObject({code:'CONNECTION_PROFILE_UNAVAILABLE'})
  expect((await f.sdk.call('connection.ls',{})).connections).toHaveLength(1)
  fault.mockRestore()
  await f.sdk.call('connection.profile.sync',f.input)
  const inspect=ConnectionProfileHost.prototype.inspect
  vi.spyOn(ConnectionProfileHost.prototype,'inspect').mockImplementation(async function(this:ConnectionProfileHost,input){const r=await inspect.call(this,input);return {operation:r.operation?{...r.operation,prepared:'private-native-request'}:null}})
  let rejected:unknown
  try{await f.sdk.call('connection.profile.inspect',{operationId:f.input.operationId})}catch(error){rejected=error}
  expect(rejected,'The original public service must reject private wire fields').toMatchObject({code:'INVALID_CONNECTION_PROFILE_DATA'})
  const shared=new DatabaseSync(':memory:'),owner=new ConnectionHost({database:shared,secrets:{resolve:async()=>null}})
  owner.close();await expect(owner.profile!.list({connectionId:'original'})).rejects.toMatchObject({code:'CONNECTION_PROFILE_UNAVAILABLE'})
  expect(shared.prepare('SELECT 1 AS retained').get()).toEqual({retained:1});shared.close()
},30_000)
