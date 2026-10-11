import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { consumeJsonReadEntry, type JsonReadAssembly, parseAgentSessionHistoryReadPage } from '../src/session-history-read-codec.js'
import type { AgentSessionHistoryReadInput } from '../src/session-history-reader.js'
import { capturedStorageRecords, capturedStorageSession, writeCapturedLegacyFixture } from './helpers/captured-history-fixture.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'


const cleanups: Array<()=>Promise<void>>=[]
afterEach(async()=>{for(const close of cleanups.splice(0).reverse())await close();vi.restoreAllMocks()})
async function fixture(legacy=true) {
  const root=await mkdtemp(join(tmpdir(),'captured-public-'))
  cleanups.push(()=>rm(root,{recursive:true,force:true}))
  const store=new AgentMuxFileAgentSessionStore(join(root,'sessions.json')),session=capturedStorageSession(root)
  await store.compareAndSwap(null,session)
  const original=legacy?await writeCapturedLegacyFixture(store.path,capturedStorageRecords()):undefined
  const client=new AgentMuxClient({store});cleanups.push(()=>client.dispose())
  const controls=['connect','startAgentSession','resumeAgentSession','stopAgentSession','sendAgentMessage']
    .filter(key=>typeof(client as unknown as Record<string,unknown>)[key]==='function')
    .map(key=>vi.spyOn(client,key as 'connect'))
  const server=new AgentMuxControlServer({socketPath:join(root,'control.sock'),coreClients:()=>[{hostId:'local',client}]})
  await server.start();cleanups.push(()=>server.stop())
  const reference={hostId:'local',agentSessionId:session.agentSessionId}
  return {root,store,session,client,original,reference,controls,cli:async(extra:string[]=[])=>{
    const raw=await runCompiledObjectCli(['agent','history','--host','local','--session',session.agentSessionId,'--source','captured','--limit','100','--max-bytes','131072',...extra],objectCliEnvironment(root))
    expect(raw.code,raw.stderr).toBe(0);expect(raw.stderr).toBe('')
    return JSON.parse(raw.stdout).result
  }}
}

it('real public SDK/RPC/compiled CLI read every original captured fact beyond the retained window',async()=>{
  const f=await fixture(),expected=f.original!.expected.slice().reverse()
  const snapshot=await f.client.sessionTimeline(f.session.agentSessionId)
  expect(snapshot.items).toHaveLength(600)
  expect(snapshot.items.some(item=>item.id===expected.at(-1)!.id)).toBe(false)
  let cursor:string|undefined,all:unknown[]=[],pages=0
  do {
    const page=await f.cli(cursor?['--cursor',cursor]:[])
    const input:AgentSessionHistoryReadInput={...f.reference,source:'captured',limit:100,maxBytes:131072,...(cursor?{cursor}:{})}
    expect(parseAgentSessionHistoryReadPage(page,input)).toEqual(page)
    expect(page.capturedStream.origin).toBe('retained-prefix')
    expect(page.items.length).toBeGreaterThan(0)
    all.push(...page.items.map((entry:{kind:string;item:unknown})=>{expect(entry.kind).toBe('item');return entry.item}))
    cursor=page.nextCursor??undefined;pages++;expect(pages).toBeLessThan(12)
  } while(cursor)
  expect(all).toEqual(expected);expect(pages).toBeGreaterThan(6)
  const first=await f.client.readAgentSessionHistory({...f.reference,source:'captured',limit:1})
  await f.store.applyTimelineMutation({type:'append',agentSessionId:f.session.agentSessionId,item:{...expected[0]!,id:'later-original-record',createdAt:_historyFixtureEpoch(0, 30, 0),updatedAt:_historyFixtureEpoch(0, 30, 0)}})
  const second=await f.client.readAgentSessionHistory({...f.reference,source:'captured',limit:1,cursor:first.nextCursor!})
  expect(second.items).toEqual([{kind:'item',item:expected[1]}]);expect(second.revision).toBe(first.revision)
  expect(second.capturedStream).toEqual(first.capturedStream)
  for(const control of f.controls)expect(control).not.toHaveBeenCalled()
  expect(await f.store.readMetadata(f.session.agentSessionId)).toEqual(f.session)
},60000)

it('actual raw/text/input queries page the original fixed cut and reconstruct a full large field',async()=>{
  const f=await fixture(),request={...f.reference,source:'captured' as const,kind:'text' as const,query:'original input 0',scanLimit:100,limit:1}
  const load=vi.spyOn(f.client,'sessionTimeline')
  let read=await f.client.readAgentSessionHistory(request),examined=read.scan!.examined
  while(!read.items.length&&read.nextCursor){read=await f.client.readAgentSessionHistory({...request,cursor:read.nextCursor});examined+=read.scan!.examined}
  expect(examined).toBeGreaterThan(600)
  expect(read.items).toMatchObject([{kind:'item',item:{id:'opaque/tool:0#中',toolInput:'original input 0',toolOutput:'  exact completion 中🙂\n  '}}])
  expect(load).not.toHaveBeenCalled()
  const inputRequest={...f.reference,source:'captured' as const,kind:'user-message' as const,query:'exact original 0',scanLimit:100,limit:1}
  let input=await f.client.readAgentSessionHistory(inputRequest),inputExamined=input.scan!.examined
  while(!input.userMessages!.length&&input.nextCursor){input=await f.client.readAgentSessionHistory({...inputRequest,cursor:input.nextCursor});inputExamined+=input.scan!.examined}
  expect(inputExamined).toBeGreaterThan(600)
  expect(input.userMessages).toMatchObject([{rawId:'opaque/user:0#中',author:{kind:'human'},publicContent:'confirmed',content:f.original!.expected[0]!.content}])
  const body=' complete original 中🙂\n'.repeat(3000)
  await f.store.applyTimelineMutation({type:'append',agentSessionId:f.session.agentSessionId,item:{id:'large-original',agentSessionId:f.session.agentSessionId,kind:'user_message',source:'user',status:'complete',title:'Original input',content:body,createdAt:_historyFixtureEpoch(0, 40, 0),updatedAt:_historyFixtureEpoch(0, 40, 0),authorHuman:true}})
  const bytes:Buffer[]=[];let cursor:string|undefined,total=0,digest='',complete=false,pending:JsonReadAssembly|undefined
  for(let count=0;count<100;count++){
    const input={...f.reference,source:'captured' as const,limit:1,maxBytes:4096,...(cursor?{cursor}:{})}
    const page=await f.client.readAgentSessionHistory(input)
    expect(parseAgentSessionHistoryReadPage(page,input)).toEqual(page)
    const scopeKey=JSON.stringify([page.hostId,page.agentSessionId,page.source,page.revision]),entry=page.items[0]!
    if(pending)expect(()=>consumeJsonReadEntry({scopeKey:scopeKey+'another-source',entry,pending,maxTotalBytes:128*1024})).toThrow(/changed scope/)
    if(entry.kind==='fragment'){
      expect(()=>consumeJsonReadEntry({scopeKey,entry:{...entry,offsetBytes:entry.offsetBytes+1},...(pending?{pending}:{}),maxTotalBytes:128*1024})).toThrow(/changed scope/)
      const chunk=Buffer.from(entry.dataBase64,'base64')
      if(entry.offsetBytes+chunk.length===entry.totalBytes){chunk[0]=chunk[0]!^1;expect(()=>consumeJsonReadEntry({scopeKey,entry:{...entry,dataBase64:chunk.toString('base64')},...(pending?{pending}:{}),maxTotalBytes:128*1024})).toThrow(/integrity/)}
    }
    const assembled=consumeJsonReadEntry({scopeKey,entry,...(pending?{pending}:{}),maxTotalBytes:128*1024})
    if(assembled.kind==='pending')pending=assembled.pending
    else {expect(assembled.value).toMatchObject({id:'large-original',content:body});pending=undefined}
    const fragment=page.items[0]!;expect(fragment.kind).toBe('fragment');if(fragment.kind!=='fragment')throw new Error('Expected original bounded fragment')
    expect(fragment.offsetBytes).toBe(total);digest||=fragment.sha256;expect(fragment.sha256).toBe(digest)
    const next=Buffer.from(fragment.dataBase64,'base64');expect(next.length).toBeGreaterThan(0);bytes.push(next);total+=next.length;cursor=page.nextCursor??undefined
    if(total===fragment.totalBytes){complete=true;break}
  }
  expect(complete).toBe(true);expect(pending).toBeUndefined()
  const full=Buffer.concat(bytes);expect(createHash('sha256').update(full).digest('hex')).toBe(digest);expect(JSON.parse(full.toString()).content).toBe(body)
  for(const control of f.controls)expect(control).not.toHaveBeenCalled()
},60000)
