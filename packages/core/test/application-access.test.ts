import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { fork, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { tmpdir, userInfo } from 'node:os'
import { fileURLToPath } from 'node:url'
import { AgentMuxApplicationAccessOwner } from '../src/application-access-owner.js'
import type { ApplicationAccessProfile, ApplicationAccessOperation, ApplicationAccessPlan, ApplicationAccessConfiguration } from '../src/application-access.js'
import { AgentMuxControlServer } from '../src/control-host.js'
import { LocalExecutionHost } from '../src/execution-host.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

let root: string, owner: AgentMuxApplicationAccessOwner, server: AgentMuxControlServer, profile: ApplicationAccessProfile
let actualRuntime = 'original-runtime'
let failTargetAfterExport = false
const fixture = fileURLToPath(new URL('./fixtures/application-access-connector.mjs',import.meta.url))
const local = new LocalExecutionHost(), principal = {kind:'user' as const,id:'local-test-user'}
const state = async (side: string) => JSON.parse(await readFile(join(root,side+'.json'),'utf8')) as Record<string,any>
async function patch(side: string,changes: Record<string,unknown>) { await writeFile(join(root,side+'.json'),JSON.stringify({...await state(side),...changes}),{mode:0o600}) }
function openOwner() { return new AgentMuxApplicationAccessOwner({path:join(root,'access.sqlite'),async resolveHost(hostId) { if (!['source','target'].includes(hostId)) throw new Error('Wrong Host'); if (hostId==='target' && failTargetAfterExport && (await state('source')).calls?.includes('export')) throw new Error('The original target route owner is unavailable'); return {executionHost:local,runtimeId:actualRuntime,assertCurrent() {}} }}) }
async function cli(action: string[], input = '') { const r=await runCompiledObjectCli(['settings','applications',...action],objectCliEnvironment(root),input); return {...r,body:JSON.parse(r.code===0 ? r.stdout : r.stderr)} }
const result = <T>(value: Awaited<ReturnType<typeof cli>>): T => { expect(value.code,value.stderr).toBe(0); return value.body.result as T }
async function save() { return result<ApplicationAccessConfiguration>(await cli(['configure','profile','--input','-'],JSON.stringify({profile,expectedRevision:null}))) }
async function plan(c: ApplicationAccessConfiguration) { return result<ApplicationAccessPlan>(await cli(['plan',c.profileId,'--revision',c.revision])) }
async function apply(p: ApplicationAccessPlan,id='original-operation') { return result<ApplicationAccessOperation>(await cli(['apply',p.profileId,'--plan',p.planId,'--operation-id',id])) }
beforeEach(async()=> {
  root=await mkdtemp(join(tmpdir(),'amux-application-access-')); actualRuntime='original-runtime'; failTargetAfterExport=false; owner=openOwner()
  for (const side of ['source','target']) await writeFile(join(root,side+'.json'),JSON.stringify({applicationId:'sample-application',accountId:side==='source'?'expected-account':null,scopes:side==='source'?['read','write']:[],revision:0,token:side==='source'?'PRIVATE-MATERIAL-SENTINEL':null}),{mode:0o600})
  const endpoint=(hostId:string)=>({hostId,runtimeId:'original-runtime',osAccount:userInfo().username,command:process.execPath,args:[fixture,join(root,hostId+'.json')]})
  profile={label:'Configured application',applicationId:'sample-application',source:endpoint('source'),target:endpoint('target'),accountId:'expected-account',scopes:['read']}
  server=new AgentMuxControlServer({socketPath:join(root,'control.sock'),coreClients:()=>[],applicationAccess:owner}); await server.start()
})
afterEach(async()=>{await server?.stop();await owner?.dispose();if(root)await rm(root,{recursive:true,force:true})})

it('actual compiled CLI and public owner transfer only selected scope through real child stdin and verify target identity',async()=>{
  const c=await save(),p=await plan(c); expect(p.disposition).toBe('transfer'); expect(p.source.osAccount).toBe(userInfo().username)
  const applied=await apply(p); expect(applied.status).toBe('succeeded'); expect(applied.targetObservation?.accountId).toBe(profile.accountId); expect(applied.targetObservation?.scopes).toEqual(['read'])
  expect((await state('target')).token).toBe('PRIVATE-MATERIAL-SENTINEL'); expect((await state('target')).importAttempts).toBe(1)
  expect((await state('source')).calls).toContain('export'); expect((await state('target')).calls).toContain('verify')
  expect((await apply(p)).operationId).toBe(applied.operationId); expect((await state('target')).importAttempts).toBe(1)
  const listed=await cli(['ls','--host','target']);expect(listed.code).toBe(0);expect(listed.body.result.operations[0].operationId).toBe(applied.operationId)
  expect(JSON.stringify([c,p,applied,listed.body])).not.toContain('PRIVATE-MATERIAL-SENTINEL')
  const db=await readFile(join(root,'access.sqlite'));expect(db.includes(Buffer.from('PRIVATE-MATERIAL-SENTINEL'))).toBe(false)
})
it('a different native-login connector protocol shape reports a target action and never imports',async()=>{
  await patch('target',{mode:'native-login'});const p=await plan(await save());expect(p.disposition).toBe('target-login-required')
  const rejected=await cli(['apply','profile','--plan',p.planId,'--operation-id','refused']);expect(rejected.code).not.toBe(0);expect(rejected.body.error.code).toBe('APPLICATION_ACCESS_PLAN_NOT_APPLICABLE');expect((await state('target')).calls).not.toContain('import')
})
it('target ready under another account is a conflict; read-only plan never exports or overwrites',async()=>{
  await patch('target',{accountId:'someone-else',scopes:['read']});const p=await plan(await save());expect(p.disposition).toBe('conflict');expect((await state('source')).calls).not.toContain('export');expect((await state('target')).accountId).toBe('someone-else')
})
it('stale original revision and wrong Runtime/OS identity refuse only this operation before import',async()=>{
  const c=await save(),p=await plan(c);await patch('target',{revision:1});const stale=await apply(p);expect(stale.status).toBe('failed');expect((await state('target')).calls).not.toContain('import')
  actualRuntime='another-runtime';const runtime=await plan(c);expect(runtime.disposition).toBe('unknown');expect(runtime.target.runtimeId).toBeNull()
  actualRuntime='original-runtime';profile.source.osAccount='not-the-executing-user';const changed=await owner.call('settings.applications.configure',{profileId:'other',profile,expectedRevision:null});const os=await owner.call('settings.applications.plan',{profileId:'other',expectedRevision:changed.revision});expect(os.source.status).toBe('unknown');expect(os.source.osAccount).toBeNull()
})
it('unknown import survives owner restart and deleted configuration, discovers original ID and queries without a second import',async()=>{
  await patch('target',{mode:'lose-import'});const c=await save(),p=await plan(c),original=await apply(p);expect(original.status).toBe('unknown');expect((await state('target')).importAttempts).toBe(1)
  const blocked=await cli(['apply','profile','--plan',p.planId,'--operation-id','another-id']);expect(blocked.code).not.toBe(0);expect(blocked.body.error.code).toBe('APPLICATION_ACCESS_OPERATION_UNRESOLVED')
  await server.stop();await owner.dispose();owner=openOwner();server=new AgentMuxControlServer({socketPath:join(root,'control.sock'),coreClients:()=>[],applicationAccess:owner});await server.start()
  result(await cli(['delete','profile','--revision',c.revision]));const listed=await cli(['ls','--host','target']);expect(listed.body.result.configurations).toEqual([]);expect(listed.body.result.operations[0].operationId).toBe(original.operationId)
  const reconciled=result<ApplicationAccessOperation>(await cli(['operation',original.operationId]));expect((await state('target')).importAttempts).toBe(1);expect(reconciled.status).toBe('succeeded');expect((await state('source')).calls.filter((v:string)=>v==='export')).toHaveLength(1)
  const finished=await cli(['ls','--host','target']);expect(finished.body.result.operations[0].operationId).toBe(original.operationId);expect(finished.body.result.operations[0].status).toBe('succeeded')
  expect(JSON.stringify([original,listed.body,reconciled])).not.toContain('PRIVATE-MATERIAL-SENTINEL')
})
it('import exit success never substitutes for independent exact application-account and scope verification',async()=>{
  await patch('target',{mode:'wrong-verify'});const p=await plan(await save()),op=await apply(p);expect(op.status).toBe('unknown');expect(op.cause?.code).toBe('APPLICATION_ACCESS_TARGET_UNVERIFIED')
  await patch('target',{mode:'missing-scope'});const missing=result<ApplicationAccessOperation>(await cli(['operation',op.operationId]));expect(missing.status).toBe('unknown');expect((await state('target')).importAttempts).toBe(1)
})
it('connector stderr or malformed export never enters public errors or persistent operation metadata',async()=>{
  await patch('source',{mode:'export-failure'});const p=await plan(await save()),op=await apply(p);expect(op.status).toBe('failed');expect(JSON.stringify(op)).not.toContain('PRIVATE-MATERIAL-SENTINEL');expect((await state('target')).calls).not.toContain('import')
  const listed=await cli(['ls']);expect(JSON.stringify(listed.body)).not.toContain('PRIVATE-MATERIAL-SENTINEL')
})
it('only transport-approved user can configure or apply; caller cannot self-approve with fields or labels',async()=>{
  const service=new AgentMuxRpcService({applicationAccess:owner,coreClients:()=>[]})
  await expect(service.call('settings.applications.configure',{profileId:'denied',profile,expectedRevision:null},{})).rejects.toMatchObject({code:'CONTROL_PERMISSION_DENIED'})
  await expect(service.call('settings.applications.configure',{profileId:'denied',profile,expectedRevision:null},{principal,caller:{agentSessionId:'agent',capability:'claimed'}})).rejects.toMatchObject({code:'CONTROL_PERMISSION_DENIED'})
  await expect(service.call('settings.applications.configure',{profileId:'permitted',profile,expectedRevision:null},{principal})).resolves.toMatchObject({profileId:'permitted'})
  await service.dispose()
})
it('reuse performs target verification and original retry recovers it without an import operation',async()=>{
  await patch('target',{accountId:'expected-account',scopes:['read'],token:'already-present',mode:'wrong-verify'})
  const p=await plan(await save());expect(p.disposition).toBe('reuse');const op=await apply(p);expect(op.status).toBe('unknown');expect((await state('target')).calls).not.toContain('import')
  await patch('target',{mode:'portable'});const recovered=result<ApplicationAccessOperation>(await cli(['operation',op.operationId]));expect(recovered.status).toBe('succeeded');expect((await state('target')).calls).not.toContain('operation');expect((await state('target')).calls).not.toContain('import')
})
it('configuration CAS rejects competing writers and Host-filtered listing never borrows another route result',async()=>{
  const c=await save();await apply(await plan(c));const stale=await cli(['configure','profile','--input','-'],JSON.stringify({profile,expectedRevision:null}));expect(stale.code).not.toBe(0);expect(stale.body.error.code).toBe('APPLICATION_ACCESS_CONFIGURATION_CHANGED')
  const changed={...profile,target:{...profile.target,hostId:'new-target'}};result(await cli(['configure','profile','--input','-'],JSON.stringify({profile:changed,expectedRevision:c.revision})))
  const listed=result<{configurations:unknown[];operations:unknown[]}>(await cli(['ls','--host','new-target']));expect(listed.configurations).toHaveLength(1);expect(listed.operations).toEqual([])
})

it('target preflight fails after real source export without import dispatch, so the original failed receipt permits a fresh plan',async()=>{
  const c=await save(),p=await plan(c);failTargetAfterExport=true
  const refused=await apply(p);expect(refused.status).toBe('failed');expect(refused.cause?.code).toBe('APPLICATION_ACCESS_NOT_IMPORTED');expect((await state('source')).calls).toContain('export');expect((await state('target')).calls).not.toContain('import')
  failTargetAfterExport=false;const fresh=await plan(c),succeeded=await apply(fresh,'fresh-operation');expect(succeeded.status).toBe('succeeded');expect((await state('target')).importAttempts).toBe(1)
})

it('malformed response after actual apply remains a protocol unknown, while malformed input is a known pre-admission refusal',async()=>{
  let applied=0
  const service=new AgentMuxRpcService({coreClients:()=>[],applicationAccess:{async call(){applied++;return {operationId:'original',unexpected:'bad-result'} as never}}})
  await expect(service.call('settings.applications.apply',{profileId:'p',planId:'plan',operationId:'original'},{principal})).rejects.toMatchObject({code:'CONTROL_PROTOCOL_ERROR'});expect(applied).toBe(1)
  await expect(service.call('settings.applications.apply',{profileId:'p',planId:'plan',operationId:'other',unexpected:true} as never,{principal})).rejects.toMatchObject({code:'INVALID_CONTROL_REQUEST'});expect(applied).toBe(1)
  await service.dispose()
})

it('independent service process restart preserves an unknown original operation and reconciles without another import',async()=>{
  await server.stop();await owner.dispose();await patch('target',{mode:'lose-import'})
  const processPath=fileURLToPath(new URL('./fixtures/application-access-owner-process.mjs',import.meta.url))
  async function start(){
    const child=fork(processPath,[root],{execArgv:[],stdio:['ignore','ignore','pipe','ipc']})
    const ready=await Promise.race([once(child,'message'),once(child,'exit').then(()=>{throw new Error('Private application owner process exited before IPC ready')})]);expect(ready[0]).toEqual({ready:true,endpoint:join(root,'control.sock')});return child
  }
  async function stop(child:ChildProcess,signal:NodeJS.Signals){if(child.exitCode===null&&child.signalCode===null){const stopped=once(child,'exit');child.kill(signal);await stopped}}
  let child:ChildProcess|undefined
  try {
    child=await start();const c=await save(),p=await plan(c),original=await apply(p);expect(original.status).toBe('unknown');expect((await state('target')).importAttempts).toBe(1)
    await stop(child,'SIGKILL');child=await start()
    const listed=await cli(['ls','--host','target']);expect(listed.body.result.operations[0]).toMatchObject({operationId:original.operationId,status:'unknown'})
    const reconciled=result<ApplicationAccessOperation>(await cli(['operation',original.operationId]));expect((await state('target')).importAttempts).toBe(1);expect((await state('source')).calls.filter((v:string)=>v==='export')).toHaveLength(1);expect(reconciled.status).toBe('succeeded')
  } finally {if(child)await stop(child,'SIGTERM')}
})
it('failed first database opening is released so an explicit next read recovers the exact original data',async()=>{
  const path=join(root,'original-store','access.sqlite'),backup=join(root,'preserved-store'),originalOwner=new AgentMuxApplicationAccessOwner({path,async resolveHost(){throw new Error('No connector should run')}})
  const c=await originalOwner.call('settings.applications.configure',{profileId:'preserved',profile,expectedRevision:null});await originalOwner.dispose()
  await rename(join(root,'original-store'),backup);await writeFile(join(root,'original-store'),'temporary path obstruction')
  const recovered=new AgentMuxApplicationAccessOwner({path,async resolveHost(){throw new Error('No connector should run')}})
  try {
    await expect(recovered.call('settings.applications.ls',{})).rejects.toBeDefined();expect(await readFile(join(root,'original-store'),'utf8')).toBe('temporary path obstruction')
    await rm(join(root,'original-store'));await rename(backup,join(root,'original-store'))
    const listed=await recovered.call('settings.applications.ls',{});expect(listed.configurations).toEqual([c]);expect(listed.operations).toEqual([])
  } finally {await recovered.dispose()}
})
