import { afterEach,expect,it,vi } from 'vitest'
import { copyFile,mkdir,mkdtemp,rm,readFile,writeFile,chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join,resolve } from 'node:path'
import { spawn } from 'node:child_process'
import * as core from '../src/index.js'
import { createWorkspaceLayout,createWorkbenchViewLayout } from '../src/spatial-layout.js'
import { captureExecutorInvocation,readExecutorInvocation } from '../src/agent-executor-invocation.js'
import { cloneSession } from '../src/agent-session-identity.js'
import { nativeHistoryFixture,jsonl } from './fixtures/native-history-session.js'
import { parseRpcAgentSession } from "../src/agent-session-codec.js";
import { headlessFixture,until } from './helpers/headless-runtime-fixture.js'
import { ScratchTopics } from '../../../apps/host/src/mote-resources.js'
import { directoryIdentity,homeZoneId,SCRATCH_WORKSPACE_ID } from '../../../apps/host/src/mote-model.js'
const cleanup:Array<()=>Promise<unknown>>=[]
afterEach(async()=>{try{for(const close of cleanup.splice(0).reverse())await close()}finally{vi.unstubAllEnvs()}})
const loader=resolve(import.meta.dirname,'helpers/executor-origin-node-loader.mjs')
async function cli(f:Awaited<ReturnType<typeof headlessFixture>>,method:string[],input:any){
  return new Promise<any>((yes,no)=>{const child=spawn(process.execPath,['--experimental-transform-types','--import',loader,resolve(import.meta.dirname,'../src/agentmux.ts'),'--endpoint','unix:'+f.socketPath,...method,'--host',input.hostId,'--session',input.agentSessionId,'--source',input.source],{env:f.env,stdio:['pipe','pipe','pipe']});let out='',err='';child.stdout.on('data',data=>out+=data);child.stderr.on('data',data=>err+=data);child.on('error',no);child.on('close',code=>code===0?yes(JSON.parse(out).result):no(new Error(err)));child.stdin.end(JSON.stringify(input))})
}
it('private invocation validates its complete original owner and never enters public Session decoding',()=>{
  const source=captureExecutorInvocation('generic','original','create-original','a'.repeat(64),{commandOverride:'/original',args:['arg'],env:{PRIVATE_SECRET:'value'}})!
  const owner={providerId:'generic',executorId:'original',creation:{createOperationId:'create-original',intentDigest:'a'.repeat(64),executorInvocationDigest:source.digest,initialPrompt:'not-requested' as const}}
  expect(readExecutorInvocation(owner,source.value)?.options.env).toEqual({PRIVATE_SECRET:'value'})
  expect(()=>readExecutorInvocation({...owner,executorId:'another'},source.value)).toThrowError(/original creation execution source/i)
  expect(()=>readExecutorInvocation(owner,{...source.value,executor:{...source.value.executor,options:{env:{PRIVATE_SECRET:'changed'}}}})).toThrowError(/original creation execution source/i)
  expect(readExecutorInvocation({...owner,creation:{...owner.creation,executorInvocationDigest:undefined}},undefined)).toBeUndefined()
  const session={kind:'agent',agentSessionId:'original',providerId:'generic',executorId:'original',hostId:'local',workspacePath:'/private/original',run:{runId:'run'},retiredRuns:[],createdAt:1,updatedAt:1,creation:owner.creation}
  expect(JSON.stringify(cloneSession({...session,executorInvocation:source.value,hookBindingId:'original-binding',hookToken:'original-token'} as any))).not.toContain('PRIVATE_SECRET')
  expect(parseRpcAgentSession(session).creation?.executorInvocationDigest).toBe(source.digest)
  expect(()=>parseRpcAgentSession({...session,executorInvocation:source.value})).toThrow()
})
it('real Host configuredExecutor creation retains its private source for public history and native resume across owner restart',async()=>{
  const previous=process.env.AGENTMUX_TEST_OWNER_ENTRY;process.env.AGENTMUX_TEST_OWNER_ENTRY=resolve(import.meta.dirname,'helpers/executor-origin-host.mjs')
  const ambient=await mkdtemp(join(tmpdir(),'origin-ambient-'));cleanup.push(()=>rm(ambient,{recursive:true,force:true}))
  vi.stubEnv('ORIGIN_PROFILE_ROOT',ambient);vi.stubEnv('ORIGIN_PRIVATE_SENTINEL','unrelated-host-environment')
  let f:Awaited<ReturnType<typeof headlessFixture>>
  try{f=await headlessFixture({ownerNodeArgs:['--experimental-transform-types','--import',loader]})}finally{if(previous===undefined)delete process.env.AGENTMUX_TEST_OWNER_ENTRY;else process.env.AGENTMUX_TEST_OWNER_ENTRY=previous}
  cleanup.push(async()=>{try{const client=await f.client();for(const session of await client.readAgentSessions())await client.stopAgent(session.agentSessionId,session.run)}finally{await f.cleanup()}})
  const workspace={id:SCRATCH_WORKSPACE_ID,hostId:'local',name:'Private origin',path:join(f.root,'scratch'),kind:'folder'};await mkdir(workspace.path)
  const topic=await new ScratchTopics().ensureMote(workspace,'view:origin-private'),spaceId=directoryIdentity('local',topic.identityDirectoryPath!),zoneId=homeZoneId(spaceId)
  const originalCommand=join(f.root,'original-command.mjs');await copyFile(resolve(import.meta.dirname,'helpers/executor-origin-cli.mjs'),originalCommand);await chmod(originalCommand,0o700)
  const profileRoot=join(f.root,'private-executor-profile'),privateSecret='private-original-executor-secret',configurationPath=join(f.env.AGENTMUX_STATE_DIRECTORY!,'original-configuration.json')
  const config={workspaces:[workspace],executors:{original:{providerId:'origin-fixture',label:'Original',command:originalCommand,args:['original-argument'],env:{ORIGIN_PROFILE_ROOT:profileRoot,ORIGIN_PRIVATE_SENTINEL:privateSecret},injectAgentMuxGuide:false}},appearance:{}}
  await writeFile(configurationPath,JSON.stringify(config))
  const spatial=new core.AgentMuxSpatialStateStore(join(f.env.AGENTMUX_STATE_DIRECTORY!,'spatial-state.json')),current=await spatial.read()
  const graph={spaces:[{spaceId,kind:'mote' as const,name:'Private',hostId:'local',directoryPath:topic.physicalDirectoryPath!,projectId:null,topicId:topic.id}],zones:[{zoneId,workspaceId:workspace.id,kind:'home' as const,hostId:'local',directoryPath:topic.physicalDirectoryPath!,branch:null}],bindings:[{spaceId,zoneId}],tabs:[{tabId:'tab',zoneId,workspaceId:workspace.id,name:'Original',regionIds:['region']}],regions:[{tabId:'tab',regionId:'region',kind:'launcher' as const,agentSessionId:null,runId:null,execution:null}],layouts:{[workspace.id]:createWorkspaceLayout('group',['tab'])},tabLayouts:{tab:createWorkbenchViewLayout('region')},resources:{}}
  await spatial.commit({expectedRevision:current?.revision??0,graph})
  const rpc=await core.connectAgentMuxRpc({endpoint:{transport:'unix',path:f.socketPath}});cleanup.push(()=>rpc.dispose())
  const opened=await rpc.call('agent.open',{operationId:'create-original-private-source',content:{kind:'new-agent',executorId:'original',prompt:'Original creation question'},destination:{spaceId,zoneId,tabId:'tab',regionId:'region'},focus:false})
  expect(opened.agent,JSON.stringify(opened)).not.toBeNull();const sid=opened.agent!.agentSessionId;let client=await f.client()
  const before=await until(()=>client.statusAgent(sid),value=>value.run.state==='running','private original process')
  const initial=await client.inspectAgentCreation(sid)
  expect(initial.creation?.executorRevision).toBeUndefined();expect(initial.creation?.persistence).toBeUndefined();expect(initial.creation).toMatchObject({executorInvocationDigest:expect.stringMatching(/^[a-f0-9]{64}$/)})
  expect(JSON.stringify(initial)).not.toContain(privateSecret);expect(JSON.stringify(initial)).not.toContain('executorInvocation"')
  await until(async()=>{try{return await readFile(join(before.session.workspacePath,'.origin-protocol',before.run.pid+'.json'),'utf8')}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return '';throw error}},value=>Boolean(value),'original native process witness')
  const firstHistory=await client.sessionHistoryPage(sid,{refreshNativeSource:true}).then(page=>({page}),error=>({error:{code:error.code,message:error.message}}))
  expect(firstHistory).not.toHaveProperty('error')
  expect(JSON.stringify(firstHistory)).toContain('Original creation question')
  const native=(await client.statusAgent(sid)).session.nativeHandle!
  await writeFile(configurationPath,JSON.stringify({...config,executors:{original:{...config.executors.original,command:'/unrelated-current-command',args:['changed-argument'],env:{ORIGIN_PROFILE_ROOT:join(f.root,'wrong-current-profile'),ORIGIN_PRIVATE_SENTINEL:'changed-secret'}}}}))
  expect(JSON.stringify(await cli(f,['agent','history'],{hostId:'local',agentSessionId:sid,source:'native'}))).toContain('Original creation question')
  await client.writeAgent({agentSessionId:sid,expectedRun:before.session.run,data:'Original manual input',source:'user'})
  await until(()=>client.sessionHistoryPage(sid),value=>JSON.stringify(value).includes('Original manual input'),'original live input history')
  await f.restart();client=await f.client()
  expect((await client.statusAgent(sid)).session.run).toEqual(before.session.run)
  expect((await client.inspectAgentCreation(sid)).creation?.executorInvocationDigest).toBe(initial.creation?.executorInvocationDigest)
  expect(JSON.stringify(await client.sessionHistoryPage(sid))).toContain('Original manual input')
  process.kill(before.run.pid!,'SIGKILL')
  await until(()=>client.statusAgent(sid),value=>value.run.state!=='running','original private process ended')
  const restored=await client.ensureAgentContinuity({agentSessionId:sid,expectedRun:before.session.run,operationId:'restore-original-private-source',trigger:'manual',policy:{continuationEnabled:false,reminderMode:'off'}})
  expect(restored.kind,JSON.stringify(restored)).toBe('resumed')
  const after=await client.statusAgent(sid);expect(after.run.state).toBe('running');expect(after.session.agentSessionId).toBe(sid);expect(after.session.nativeHandle).toEqual(native);expect(after.session.run).not.toEqual(before.session.run)
  expect(JSON.stringify(after)).not.toContain(privateSecret)
  await vi.waitFor(async()=>{
    let witness:any=null
    try{witness=JSON.parse(await readFile(join(after.session.workspacePath,'.origin-protocol',after.run.pid+'.json'),'utf8'))}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
    expect(witness).toMatchObject({pid:after.run.pid,root:profileRoot,command:originalCommand,sessionId:sid})
  },{timeout:3000})
  expect(JSON.stringify(await client.sessionHistoryPage(sid))).toContain('Original manual input')
  await client.stopAgent(sid,after.session.run)
  const inspected=await client.inspectAgentCreation(sid).then(value=>({value}),error=>({error:{code:error.code,message:error.message}}))
  expect(inspected).not.toHaveProperty('error')
  const retired=(inspected as {value:Awaited<ReturnType<typeof client.inspectAgentCreation>>}).value
  expect(retired.kind).toBe('retired-agent');expect(JSON.stringify(retired)).not.toContain(privateSecret);expect(JSON.stringify(retired)).not.toContain('executorInvocation"')
  const retiredHistory=await client.sessionHistoryPage(sid).then(page=>({page}),error=>({error:{code:error.code,message:error.message}}))
  expect(retiredHistory).not.toHaveProperty('error');expect(JSON.stringify(retiredHistory)).toContain('Original manual input')
  if(retired.kind!=='retired-agent')throw Error('Expected the exact original retirement')
  const reopened=await client.reopenAgent({agentSessionId:sid,expectedRetiredAt:retired.observedAt,operationId:'reopen-original-private-source'})
  expect(reopened.nativeHandle).toEqual(native);expect(reopened.creation?.executorInvocationDigest).toBe(initial.creation?.executorInvocationDigest)
  expect(JSON.stringify(reopened)).not.toContain(privateSecret)
  expect(JSON.stringify(await client.sessionHistoryPage(sid))).toContain('Original manual input')
  const consumers=(await readFile(join(profileRoot,'consumers.ndjson'),'utf8')).trim().split('\n').map(line=>JSON.parse(line))
  expect(consumers.length).toBeGreaterThan(2);for(const read of consumers)expect(read).toMatchObject({matched:true,command:originalCommand,args:['original-argument']})
  expect((await spatial.read())!.graph.tabs).toEqual(graph.tabs)
},120000)

it('known partial SDK invocation ignores foreign read overrides while an unknown old source stays independent',async()=>{
  const f=await nativeHistoryFixture('claude',jsonl([{uuid:'user',type:'user',sessionId:'native-main',message:{role:'user',content:'Original private source'}}]));cleanup.push(f.close)
  const source=captureExecutorInvocation(f.session.providerId,f.session.executorId,'original-create','b'.repeat(64),{env:{ORIGINAL_PRIVATE_PROFILE:'original-value'}})!
  const saved=(await f.store.readMetadata(f.session.agentSessionId))!
  await f.store.compareAndSwap(saved,{...saved,creation:{createOperationId:'original-create',intentDigest:'b'.repeat(64),initialPrompt:'not-requested',executorInvocationDigest:source.digest},executorInvocation:source.value})
  const provider=f.client.providers.get('claude'),read=vi.spyOn(provider,'readSessionHistoryPage')
  const metadata=vi.spyOn(f.store,'readMetadata'),originalSource=vi.spyOn(f.store,'readExecutorInvocation')
  const page=await f.client.sessionHistoryPage(f.session.agentSessionId,{commandOverride:'/foreign-command',args:['foreign'],env:{ORIGINAL_PRIVATE_PROFILE:'foreign-value'}})
  expect(JSON.stringify(page)).toContain('Original private source')
  expect(read.mock.calls[0]![0]).toMatchObject({command:provider.executable,args:[],env:{ORIGINAL_PRIVATE_PROFILE:'original-value'}})
  // The pre-existing content-signing read remains one read; original-invocation lookup adds no cumulative metadata read.
  expect(metadata).toHaveBeenCalledTimes(1);expect(originalSource).toHaveBeenCalledOnce()
  const stored=(await f.store.readMetadata(f.session.agentSessionId))!
  await f.store.compareAndSwap(stored,{...stored,executorInvocation:{...source.value,executor:{...source.value.executor,options:{env:{ORIGINAL_PRIVATE_PROFILE:'changed-value'}}}}})
  await expect(f.client.sessionHistoryPage(f.session.agentSessionId)).rejects.toMatchObject({code:'AGENT_EXECUTOR_INVOCATION_UNCONFIRMED'})
  expect(read).toHaveBeenCalledOnce();for(const control of f.controls)expect(control).not.toHaveBeenCalled()
})
