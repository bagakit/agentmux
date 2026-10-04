import { fixturePath } from './helpers/fixture-values.js'
import { mkdtemp, mkdir, readFile, writeFile, rm, truncate } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxFileAgentSessionStore, loadAgentSessions } from '../src/agent-session-store.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import { readAppServerSessionHistoryRecord } from '../src/providers/app-server-native-history.js'
import { parseSessionHistoryResourceParams, parseSessionHistoryResourceResult, parseSessionHistoryResourceReadResult, SESSION_HISTORY_IMAGE_MAX_BYTES } from '../src/session-history-resource.js'
import { connectHostedAgentMux } from '../src/hosted-client.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { decodeHostedValue, encodeHostedValue } from '../src/hosted-value.js'
import { AGENTMUX_HOSTED_METHODS } from '../src/hosted-client-contract.js'
import { parseAgentMuxCliInvocation, AGENTMUX_CLI_COMMANDS } from '../src/agentmux-cli-commands.js'
import type { AgentSessionHistoryResourceRequest } from '../src/types.js'

const png = process.env.AGENTMUX_IMAGE_FIXTURE_PATH ? await readFile(process.env.AGENTMUX_IMAGE_FIXTURE_PATH) : Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0K8AAAAASUVORK5CYII=', 'base64')
const source = {providerId:'codex',nativeSessionId:'native-image-source'}
const closes: Array<()=>Promise<void>>=[]
afterEach(async()=>{vi.restoreAllMocks();await Promise.all(closes.splice(0).map(close=>close()))})
type Entry={turnId:string;item:{type:string;id:string;content?:unknown[];text?:string}}
async function fixture() {
  const home=await mkdtemp(fixturePath("tmp/amx-image-")),workspace=join(home,'workspace'),image=join(home,'fresh-native-image.png')
  await mkdir(workspace); await writeFile(image,png)
  const data='data:image/png;base64,'+png.toString('base64')
  const entries:Entry[]=[{turnId:'original-turn',item:{type:'userMessage',id:'old-image-record',content:[{type:'localImage',path:image},{type:'image',url:data},{type:'image',url:'https://synthetic.invalid/no-fetch.png'},{type:'image',fileId:'opaque-native-image'},{type:'text',text:'kept original text'}]}}]
  const records=join(home,'entries.json'),log=join(home,'requests.jsonl'),script=join(home,'native.mjs')
  const save=()=>writeFile(records,JSON.stringify({entries,nativeId:source.nativeSessionId}))
  await save()
  await writeFile(script, `import {readFileSync,appendFileSync} from 'node:fs'
import {createInterface} from 'node:readline'
const input=createInterface({input:process.stdin});input.on('line',line=>{
 const request=JSON.parse(line);appendFileSync(process.env.AMX_IMAGE_LOG,JSON.stringify(request)+'\\n')
 if(request.id===undefined)return
 const state=JSON.parse(readFileSync(process.env.AMX_IMAGE_RECORDS,'utf8')),p=request.params??{};let result={}
 if(request.method==='initialize')result={userAgent:'indexed-native-image-fixture'}
 else if(request.method==='thread/read')result={thread:{id:state.nativeId,historyMode:'paginated',turns:[]}}
 else if(request.method==='thread/items/list'){
  const list=state.entries.filter(e=>!p.turnId||e.turnId===p.turnId),index=p.cursor?.type==='item'?list.findIndex(e=>e.item.id===p.cursor.itemId):undefined
  if(index===-1)result={data:[],nextCursor:null}
  else if(p.sortDirection==='asc')result={data:list.slice(index===undefined?0:index+1,(index===undefined?0:index+1)+p.limit),nextCursor:null}
  else {const end=index===undefined?list.length:index;result={data:list.slice(Math.max(0,end-p.limit),end).reverse(),nextCursor:end>p.limit?'opaque-older':null}}
 }
 process.stdout.write(JSON.stringify({id:request.id,result})+'\\n')
})`)
  const providers=new AgentProviderRegistry(),provider={...providers.get('codex')}
  // The fixture Host supplies its executor invocation once; the native reader remains production code.
  const configured={command:process.execPath,args:[script],env:{AMX_IMAGE_RECORDS:records,AMX_IMAGE_LOG:log}}
  const originalPage=provider.readSessionHistoryPage!.bind(provider)
  provider.readSessionHistoryPage=context=>originalPage({...context,...configured})
  provider.readSessionHistoryRecord=context=>readAppServerSessionHistoryRecord({...context,...configured})
  const store=new AgentMuxFileAgentSessionStore(join(home,'sessions.json'))
  await store.compareAndSwap(null,{kind:'agent',agentSessionId:'image-session',providerId:'codex',executorId:'codex',hostId:'local',workspacePath:workspace,
    run:{runId:'original-healthy-run'},retiredRuns:[],hookBindingId:'binding',hookToken:'token',createdAt:1,updatedAt:1,
    nativeHandle:{kind:'provider',providerId:'codex',sessionId:source.nativeSessionId}})
  const client=new AgentMuxClient({store,providers:[provider]})
  vi.spyOn(client,'connect').mockRejectedValue(new Error('A native resource read must never connect Runtime'))
  closes.push(async()=>{await client.dispose();await rm(home,{recursive:true,force:true})})
  const request:AgentSessionHistoryResourceRequest={source,turnId:'original-turn',recordId:'old-image-record',partIndex:0,expectedReference:image}
  return {home,workspace,image,data,client,provider,store,entries,save,records,request,
    requests:async()=>readFile(log,'utf8').then(text=>text.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)),()=>[])}
}

describe('exact native recorded image through the original public Core owner',()=>{
 it('reopens retained original file and inline data after 31 appends without replaying the moving first page',async()=>{
  const h=await fixture(),first=await h.client.sessionHistoryPage('image-session',{limit:30})
  expect(first.items[0]!.id).toBe(h.request.recordId)
  h.entries.push(...Array.from({length:31},(_,i)=>({turnId:'later-turn',item:{type:'agentMessage',id:'later-'+i,text:'later '+i}})))
  await h.save()
  const latest=await h.client.sessionHistoryPage('image-session',{limit:30})
  expect(latest.items.map(i=>i.id)).not.toContain(h.request.recordId)
  expect(first.items[0]!.contentParts[0]).toEqual({kind:'resource',resourceType:'image',reference:h.image})
  const before=(await h.requests()).length
  const resourceReads=[]
  for(const [partIndex,expectedReference] of [[0,h.image],[1,h.data]] as const){
   const response=await h.client.sessionHistoryResource('image-session',{...h.request,partIndex,expectedReference}).then(value=>({value}),error=>({error}))
   expect(response).toHaveProperty('value')
   if(!('value' in response))throw response.error
   const read=response.value
   resourceReads.push(read)
   expect(read).toMatchObject({agentSessionId:'image-session',source,turnId:'original-turn',recordId:'old-image-record',partIndex,reference:expectedReference,
    result:{status:'read',mimeType:'image/png',dataBase64:png.toString('base64'),byteLength:png.length}})
  }
  const targeted=(await h.requests()).slice(before).filter(r=>r.method==='thread/items/list')
  expect(targeted).toHaveLength(4)
  expect(targeted.every(r=>r.params.limit===1&&r.params.turnId==='original-turn')).toBe(true)
  expect(targeted[0].params.cursor).toEqual({type:'item',itemId:'old-image-record'})
  if(process.env.AGENTMUX_IMAGE_EVIDENCE_DIR){
   await mkdir(process.env.AGENTMUX_IMAGE_EVIDENCE_DIR,{recursive:true})
   await writeFile(join(process.env.AGENTMUX_IMAGE_EVIDENCE_DIR,'retained-core-image.json'),JSON.stringify({schema:'agentmux.native-image.actual-read.v1',controlledNativeProtocolFixture:true,vendorWriterClaim:false,firstPage:first,after31Appends:latest,resourceReads,targetedCalls:targeted,sourceImage:process.env.AGENTMUX_IMAGE_FIXTURE_PATH??'embedded-test-png',nativeFixtureFilesRemovedAfterRead:true},null,2))
  }
  expect((await loadAgentSessions(h.store))[0]!.run).toEqual({runId:'original-healthy-run'})
  expect(h.client.connect).not.toHaveBeenCalled()
 })
 it('rejects wrong source, record, turn, part and expectedReference while keeping the original Run',async()=>{
  const h=await fixture()
  for(const patch of [{source:{...source,nativeSessionId:'other'}},{recordId:'other-record'},{turnId:'other-turn'},{partIndex:4},{expectedReference:join(h.home,'unrecorded-file.png')}])
   expect(await h.client.sessionHistoryResource('image-session',{...h.request,...patch}).then(()=>undefined,(error:{code?:string})=>error.code)).toBeTypeOf('string')
  expect((await loadAgentSessions(h.store))[0]!.run).toEqual({runId:'original-healthy-run'})
  expect((await h.client.sessionHistoryResource('image-session',h.request)).result.status).toBe('read')
 })
 it('rejects another Provider record even when its part has the same reference',async()=>{
  const h=await fixture(),read=h.provider.readSessionHistoryRecord!
  h.provider.readSessionHistoryRecord=async context=>({...await read(context),id:'other-record'})
  expect(await h.client.sessionHistoryResource('image-session',h.request).then(()=>undefined,(error:{code?:string})=>error.code)).toBe('UNKNOWN_AGENT_SESSION_HISTORY_RECORD')
 })
 it('bounds file/data bytes, raster dimensions and file type; remote/opaque never auto-fetch',async()=>{
  const h=await fixture()
  for(const [partIndex,expectedReference] of [[0,h.image],[1,h.data]] as const)
   expect((await h.client.sessionHistoryResource('image-session',{...h.request,partIndex,expectedReference,maxBytes:png.length-1})).result).toMatchObject({status:'unavailable',code:'AGENT_SESSION_HISTORY_RESOURCE_TOO_LARGE'})
  await expect(h.client.sessionHistoryResource('image-session',{...h.request,maxBytes:SESSION_HISTORY_IMAGE_MAX_BYTES+1})).rejects.toHaveProperty('code')
  for(const [partIndex,expectedReference] of [[2,'https://synthetic.invalid/no-fetch.png'],[3,'opaque-native-image']] as const)
   expect((await h.client.sessionHistoryResource('image-session',{...h.request,partIndex,expectedReference})).result).toMatchObject({status:'unavailable',code:'AGENT_SESSION_HISTORY_RESOURCE_REFERENCE_UNSUPPORTED'})
  const oversized=join(h.home,'oversized.png');await writeFile(oversized,png);await truncate(oversized,SESSION_HISTORY_IMAGE_MAX_BYTES+1)
  for(const [path,code] of [[oversized,'AGENT_SESSION_HISTORY_RESOURCE_TOO_LARGE'],[h.workspace,'AGENT_SESSION_HISTORY_RESOURCE_NOT_FILE'],[join(h.home,'missing.png'),'AGENT_SESSION_HISTORY_RESOURCE_UNAVAILABLE']] as const){
   h.entries[0]!.item.content![0]={type:'localImage',path};await h.save()
   expect((await h.client.sessionHistoryResource('image-session',{...h.request,expectedReference:path})).result).toMatchObject({status:'unavailable',code})
  }
  await writeFile(h.image,'unsupported raster bytes')
  h.entries[0]!.item.content![0]={type:'localImage',path:h.image};await h.save()
  expect((await h.client.sessionHistoryResource('image-session',h.request)).result).toMatchObject({status:'unavailable',code:'AGENT_SESSION_HISTORY_RESOURCE_FORMAT_UNSUPPORTED'})
  const excessive=Buffer.from(png);excessive.writeUInt32BE(20000,16);await writeFile(h.image,excessive)
  h.entries[0]!.item.content![0]={type:'localImage',path:h.image};await h.save()
  expect((await h.client.sessionHistoryResource('image-session',h.request)).result).toMatchObject({status:'unavailable',code:'AGENT_SESSION_HISTORY_RESOURCE_DECODE_BUDGET'})
 })
 it('returns explicit unavailable for a Provider without exact record capability',async()=>{
  const h=await fixture();delete h.provider.readSessionHistoryRecord
  expect((await h.client.sessionHistoryResource('image-session',h.request)).result).toMatchObject({status:'unavailable',code:'AGENT_SESSION_HISTORY_RECORD_UNSUPPORTED'})
  expect(await h.requests()).toHaveLength(0)
 })
 it('fences source changes after record lookup and retains original history',async()=>{
  const h=await fixture(),read=h.provider.readSessionHistoryRecord!
  h.provider.readSessionHistoryRecord=async context=>{
   const record=await read(context),snapshot=(await loadAgentSessions(h.store))[0]!
   await h.store.compareAndSwap(snapshot,{...snapshot,updatedAt:2,nativeHandle:{kind:'provider',providerId:'codex',sessionId:'changed-source'}})
   return record
  }
  await expect(h.client.sessionHistoryResource('image-session',h.request)).rejects.toMatchObject({code:'AGENT_SESSION_HISTORY_SOURCE_CHANGED'})
  expect((await loadAgentSessions(h.store))[0]!.run).toEqual({runId:'original-healthy-run'})
 })
 it('uses the public RPC and compiled CLI and validates exact typed receipts',async()=>{
  const h=await fixture(),socket=join(h.home,'control.sock')
  const server=new AgentMuxControlServer({coreClients:()=>[{hostId:'local',client:h.client}]},socket)
  await server.start();closes.push(()=>server.stop())
  const rpc=await connectAgentMuxRpc({endpoint:{transport:'unix',path:socket}});closes.push(()=>rpc.dispose())
  const input={hostId:'local',agentSessionId:'image-session',...h.request}
  const response=await rpc.call('agent.history.resource',input).then(value=>({value}),error=>({error}))
  expect(response).toHaveProperty('value')
  if(!('value' in response))throw response.error
  const result=response.value
  expect(result.result.status).toBe('read')
  expect(parseSessionHistoryResourceResult(result,input)).toEqual(result)
  const {hostId,...sdkResult}=result
  expect(parseSessionHistoryResourceReadResult(sdkResult,'image-session',h.request)).toEqual(sdkResult)
  expect(()=>parseSessionHistoryResourceReadResult(result,'image-session',h.request)).toThrow()
  for(const patch of [{recordId:'wrong'},{partIndex:1},{reference:'wrong'},{hostId:'wrong'},{source:{...source,nativeSessionId:'wrong'}}])
   expect(()=>parseSessionHistoryResourceResult({...result,...patch},input)).toThrow()
  await expect(rpc.call('agent.history.resource',{...input,expectedReference:join(h.home,'unrecorded.png')})).rejects.toHaveProperty('code')
  await expect(rpc.call('agent.history.resource',{...input,hostId:'absent-host'})).rejects.toHaveProperty('code')
  expect(()=>parseSessionHistoryResourceParams({...input,path:'/etc/passwd'})).toThrow()
  const json=join(h.home,'resource-input.json');await writeFile(json,JSON.stringify(input))
  const parsed=await parseAgentMuxCliInvocation(['agent','history','resource','--input',json])
  expect(parsed.command.method).toBe('agent.history.resource');expect(parsed.params).toEqual(input)
  expect(AGENTMUX_CLI_COMMANDS.some(c=>c.method==='agent.history.resource')).toBe(true)
  expect(AGENTMUX_HOSTED_METHODS).toContain('sessionHistoryResource')
  const cli=process.env.AGENTMUX_IMAGE_CLI
  if(!cli)throw new Error('An actual private compiled CLI is required; parser-only is not qualification.')
  const nativePage=await h.client.sessionHistoryPage('image-session',{limit:30}),cliReads=[]
  for(const [partIndex,expectedReference] of [[0,h.image],[1,h.data]] as const){
   const request={...input,partIndex,expectedReference},expected=partIndex===0?result:await rpc.call('agent.history.resource',request)
   await writeFile(json,JSON.stringify(request))
   const command=[cli,'--endpoint','unix:'+socket,'agent','history','resource','--input',json]
   const output=await new Promise<{code:number|null;stdout:string;stderr:string}>((resolve,reject)=>{
   const clean=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('AGENTMUX_')&&!key.startsWith('CTXMUX_')))
   const child=spawn(process.execPath,command,{env:clean,stdio:['ignore','pipe','pipe']})
   let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b)
   const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('CLI deadline exceeded'))},10000)
   child.once('error',reject);child.once('close',code=>{clearTimeout(timer);resolve({code,stdout,stderr})})
  })
  expect(output.stderr).toBe('');expect(output.code).toBe(0)
   const cliReceipt=JSON.parse(output.stdout)
   expect(cliReceipt).toMatchObject({ok:true,operation:'agent.history.resource',result:expected})
   cliReads.push({request,command:[process.execPath,...command],exitCode:output.code,receipt:cliReceipt})
  }
  if(process.env.AGENTMUX_IMAGE_EVIDENCE_DIR){
   await mkdir(process.env.AGENTMUX_IMAGE_EVIDENCE_DIR,{recursive:true})
   await writeFile(join(process.env.AGENTMUX_IMAGE_EVIDENCE_DIR,'public-cli-image.json'),JSON.stringify({schema:'agentmux.native-image.actual-read.v1',controlledNativeProtocolFixture:true,vendorWriterClaim:false,nativePage,cliReads,sourceImage:process.env.AGENTMUX_IMAGE_FIXTURE_PATH??'embedded-test-png',nativeFixtureFilesRemovedAfterRead:true},null,2))
  }
  expect(h.client.connect).not.toHaveBeenCalled()
 })
 it('uses the actual Hosted SDK, strict resource codec and Host fence without connecting a Run',async()=>{
  const h=await fixture(),identity={hostId:'local',buildIdentity:'private-unverified-fixture',protocolVersion:1,processId:null,instanceId:'private-unverified-runtime',ownership:'unverified' as const}
  vi.spyOn(h.client,'runtimeIdentity').mockReturnValue(identity)
  let instance='private-image-host-owner'
  const runtime=new AgentMuxHostedRuntimeService(h.client,null,()=>({runtimeId:'private-image-semantic-host',ownerInstanceId:instance,protocolVersion:1,processId:process.pid,ctxmux:identity,availability:'unverified'}))
  const server=new AgentMuxControlServer({coreClients:()=>[{hostId:'local',client:h.client}],hostedRuntime:()=>runtime},join(h.home,'hosted.sock'))
  await server.start();closes.push(()=>server.stop());closes.push(()=>runtime.dispose())
  const rpc=await connectAgentMuxRpc({endpoint:{transport:'unix',path:server.path}});closes.push(()=>rpc.dispose())
  let corrupt=false
  const port={call:async(...args:Parameters<typeof rpc.call>)=>{
   const response=await rpc.call(...args)
   if(corrupt&&args[0]==='runtime.invoke'){
    const value=decodeHostedValue((response as {value:unknown}).value) as Record<string,unknown>
    return {value:encodeHostedValue({...value,recordId:'foreign-resource-record'})}
   }
   return response
  },subscribe:rpc.subscribe.bind(rpc)}
  const hosted=await connectHostedAgentMux({rpc:port as Parameters<typeof connectHostedAgentMux>[0]['rpc'],consumerId:'private-image-consumer'});closes.push(()=>hosted.dispose())
  // Existing Hosted admission probes runtimeProjection; this fixture rejects any actual Runtime connection.
  // Clear that independent observation attempt before measuring native image operations.
  vi.mocked(h.client.connect).mockClear()
  const abort=new AbortController()
  expect((await hosted.sessionHistoryResource('image-session',{...h.request,signal:abort.signal})).result.status).toBe('read')
  const mutable={...h.request,source:{...h.request.source}}
  const originalRead=hosted.sessionHistoryResource('image-session',mutable)
  mutable.source.nativeSessionId='caller-switched-source';mutable.recordId='caller-switched-record';mutable.expectedReference='caller-switched-reference'
  expect((await originalRead).reference).toBe(h.image)
  corrupt=true
  await expect(hosted.sessionHistoryResource('image-session',h.request)).rejects.toMatchObject({code:'CONTROL_PROTOCOL_ERROR'})
  corrupt=false
  const read=h.provider.readSessionHistoryRecord!
  h.provider.readSessionHistoryRecord=async context=>{const record=await read(context);instance='replacement-image-host-owner';return record}
  await expect(hosted.sessionHistoryResource('image-session',h.request)).rejects.toMatchObject({code:'RUNTIME_OWNER_CHANGED'})
  expect(h.client.connect).not.toHaveBeenCalled()
 })
 it('forwards only to the exact semantic Host and rejects a mismatched remote resource receipt',async()=>{
  const h=await fixture(),input={hostId:'remote-host',agentSessionId:'image-session',...h.request}
  const forwardRpc=vi.fn(async(_method,request)=>({hostId:'local',...await h.client.sessionHistoryResource(request.agentSessionId,((({hostId,agentSessionId,...read})=>read)(request)))}))
  const service=new AgentMuxRpcService({coreClients:()=>[{hostId:'remote-host',client:Object.assign(Object.create(h.client),{forwardRpc})}]})
  expect((await service.call('agent.history.resource',input)).hostId).toBe('remote-host')
  expect(forwardRpc.mock.calls[0]![1].hostId).toBe('local')
  const remote=await h.client.sessionHistoryResource('image-session',h.request)
  forwardRpc.mockResolvedValueOnce({...remote,hostId:'different-host'} as never)
  await expect(service.call('agent.history.resource',input)).rejects.toMatchObject({code:'CONTROL_PROTOCOL_ERROR'})
  forwardRpc.mockResolvedValueOnce({...remote,hostId:'local',reference:'another'} as never)
  await expect(service.call('agent.history.resource',input)).rejects.toMatchObject({code:'CONTROL_PROTOCOL_ERROR'})
 })
})
