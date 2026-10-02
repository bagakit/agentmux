import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentProviderRegistry, type AgentProvider } from '../src/agent-provider.js'
import { AgentMuxFileAgentSessionStore, loadAgentSessions } from '../src/agent-session-store.js'
import { nativeProcessFiles } from '../src/agent-native-process.js'
import * as runner from '../src/process-runner.js'
import type { CtxmuxRunAdapter } from '../src/ctxmux-run-adapter.js'
import type { AgentMuxClientEvent, AgentMuxStoredAgentSession, AgentProviderNativeSessionDiscoveryContext } from '../src/types.js'

const SID = 'private-native-owner', NATIVE = 'exact-native-main', RUN = 'same-original-run'
const BODY = '\n  Genuine recorded final 原文\n'
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.restoreAllMocks() })

async function succeeds<T>(operation: Promise<T>): Promise<T> {
  const outcome: { value?: T; error?: unknown } = await operation.then(value => ({ value }), error => ({ error }))
  expect(outcome).not.toHaveProperty('error')
  return outcome.value!
}

async function fixture(provider?: AgentProvider, contents?: Array<{ source: unknown; id?: string; raw?: string }>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'amx-native-reconciliation-')))
  const records = contents ?? [{ source: 'cli' }, { source: { subagent: { thread_spawn: { parent_thread_id: NATIVE } } }, id: 'native-child' }]
  const files = await Promise.all(records.map(async (record, index) => {
    const path = join(root, `rollout-owned-${index}.jsonl`)
    await writeFile(path, record.raw ?? JSON.stringify({ type: 'session_meta', payload: { id: record.id ?? NATIVE, source: record.source } }) + '\n')
    return path
  }))
  const holder = spawn(process.execPath, ['-e', `const fs=require('fs'); for(const p of process.argv.slice(1)) fs.openSync(p,'r'); console.log(process.pid);setInterval(()=>{},1000);`, ...files], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  await once(holder.stdout!, 'data')
  const processId = holder.pid!
  const nativeProvider = provider ?? new AgentProviderRegistry().get('codex')
  const store = new AgentMuxFileAgentSessionStore(join(root, 'sessions.json'))
  const session: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: SID, providerId: nativeProvider.id,
    executorId: nativeProvider.id, hostId: 'local', workspacePath: root, run: { runId: RUN }, retiredRuns: [],
    hookBindingId: 'private-binding', hookToken: 'private-token', createdAt: 1, updatedAt: 1 }
  const oldFile = join(root, 'rollout-retained-old.jsonl')
  await writeFile(oldFile, JSON.stringify({type:'session_meta',payload:{id:'retained-old',source:'cli'}})+'\n')
  session.nativeHandle = {kind:'provider',providerId:nativeProvider.id,sessionId:'retained-old',transcriptPath:oldFile}
  await store.compareAndSwap(null, session)
  const client = new AgentMuxClient({ store, providers: [nativeProvider] })
  const kernel = Reflect.get(client, 'kernel') as CtxmuxRunAdapter
  const registry = Reflect.get(client, 'registry') as { load(hostId: string): Promise<void> }
  await registry.load('local'); Reflect.set(client, 'connected', true)
  vi.spyOn(kernel, 'isConnected').mockReturnValue(true)
  const run = { runId: RUN, state: { type: 'running' }, pid: processId, workspacePath: root, acceptedInputBytes: 0 }
  const status = vi.spyOn(kernel, 'status').mockResolvedValue(run as Awaited<ReturnType<CtxmuxRunAdapter['status']>>)
  const controls = (['connect', 'start', 'resize', 'stop', 'attach'] as const).map(name => vi.spyOn(kernel, name).mockImplementation(() => { throw new Error('Forbidden Run control: ' + name) }))
  const events: AgentMuxClientEvent[] = []; client.onEvent(event => events.push(event))
  const producer = join(root, 'read-only-producer.mjs')
  const nativeInput = [{ turnId: 'real-turn', item: { type: 'userMessage', id: 'user-1', content: [{ type: 'text', text: BODY }] } },
    { turnId: 'real-turn', item: { type: 'agentMessage', id: 'progress-1', phase: 'commentary', text: 'Recorded progress' } },
    { turnId: 'real-turn', item: { type: 'agentMessage', id: 'final-1', phase: 'final_answer', text: BODY } },
    { turnId: 'real-turn', item: { type: 'userMessage', id: 'user-2', content: [{ type: 'text', text: BODY }] } }]
  const requests = join(root, 'requests.jsonl')
  await writeFile(producer, `import {appendFileSync} from 'node:fs';import {createInterface} from 'node:readline';
const data=${JSON.stringify(nativeInput)};createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);appendFileSync(${JSON.stringify(requests)},line+'\\n'); const send=result=>process.stdout.write(JSON.stringify({id:r.id,result})+'\\n');if(r.method==='initialize')send({userAgent:'controlled-readonly'});else if(r.method==='thread/read')send({thread:{id:r.params.threadId,historyMode:'paginated'}});else if(r.method==='thread/items/list')send({data:r.params.threadId==='retained-old' ? [{turnId:'old-turn',item:{type:'agentMessage',id:'old-final',phase:'final_answer',text:'Older readable answer'}}] : r.params.cursor ? []:[...data].reverse(),nextCursor:r.params.cursor ? null:'actual-opaque-earlier'});});`)
  const options = { commandOverride: process.execPath, args: [producer] }
  cleanups.push(async () => {
    await client.dispose(); if (holder.exitCode === null && holder.signalCode === null) { const end = once(holder, 'exit'); holder.kill('SIGTERM'); await end }
    for (const control of controls) expect(control).not.toHaveBeenCalled()
    await rm(root, { recursive: true, force: true })
  })
  return { root, files, oldFile, holder, processId, store, client, kernel, status, run, session, events, options, nativeInput,
    read: () => client.sessionHistoryPage(SID, options) }
}


it('reconciles an existing different retained locator with the original Run current main before observing or reading', async()=>{
 const f=await fixture(), changes:unknown[]=[]
 const observe=await f.client.observeSessionHistory(SID,value=>changes.push(value),f.options)
 const page=await succeeds(f.read())
 expect(observe.source.nativeSessionId).toBe(NATIVE)
 expect(page.source).toEqual(observe.source)
 expect(page.items[2]).toMatchObject({id:'final-1',kind:'assistant-message',messagePhase:'final',contentParts:[{kind:'text',text:BODY}]})
 expect((await loadAgentSessions(f.store))[0]!.nativeHandle?.sessionId).toBe(NATIVE)
 observe.dispose()
})

it('explicit current Page reads an existing different verified source without needing an observer',async()=>{
 const f=await fixture()
 const page=await succeeds(f.client.sessionHistoryPage(SID,{...f.options,refreshNativeSource:true}))
 expect(page.source.nativeSessionId).toBe(NATIVE)
 expect(page.items[2]?.id).toBe('final-1')
})

it('borrows the existing observation witness across save-only failure, invalidation and Pages without faking durable identity',async()=>{
 const f=await fixture(), before=await readFile(join(f.root,'sessions.json'))
 vi.spyOn(f.store,'compareAndSwap').mockRejectedValue(Object.assign(new Error('owned save-only failure'),{code:'ENOSPC'}))
 const discover=vi.spyOn(f.client.providers.get('codex'),'discoverNativeSession'),changes:unknown[]=[]
 const observer=await succeeds(f.client.observeSessionHistory(SID,value=>changes.push(value),f.options))
 expect(observer.source.nativeSessionId).toBe(NATIVE)
 const page=await succeeds(f.read())
 expect(page.source).toEqual(observer.source);expect(page.items[2]?.id).toBe('final-1')
 await appendFile(f.files[0]!,'{"type":"event_msg"}\n')
 await vi.waitFor(()=>expect(changes.length).toBeGreaterThan(0))
 expect((await succeeds(f.read())).source).toEqual(observer.source)
 expect(discover).toHaveBeenCalledOnce()
 expect(await readFile(join(f.root,'sessions.json'))).toEqual(before)
 expect(f.events.some(event=>event.type==='agent-error' && event.code==='AGENT_NATIVE_IDENTITY_PERSIST_FAILED')).toBe(true)
 expect(f.client.agentSession(SID).nativeHandle?.sessionId).toBe('retained-old')
 const proof=process.env.AMX_CURRENT_PROOF
 if(proof){await mkdir(proof,{recursive:true});await writeFile(join(proof,'save-failed-public-page.json'),JSON.stringify(page,null,2)+'\n');await writeFile(join(proof,'save-failed-events.json'),JSON.stringify(f.events,null,2)+'\n')}
 observer.dispose()
 const restored=await succeeds(f.read())
 expect(restored.source.nativeSessionId).toBe('retained-old')
 expect(restored.items[0]?.id).toBe('old-final')
})

it('keeps no-observer explicit-current read available through operation-local witness when save fails',async()=>{
 const f=await fixture(),before=await readFile(join(f.root,'sessions.json'))
 vi.spyOn(f.store,'compareAndSwap').mockRejectedValue(Object.assign(new Error('save-only'),{code:'EIO'}))
 const current=await succeeds(f.client.sessionHistoryPage(SID,{...f.options,refreshNativeSource:true}))
 expect(current.source.nativeSessionId).toBe(NATIVE);expect(current.items[2]?.id).toBe('final-1')
 expect(await readFile(join(f.root,'sessions.json'))).toEqual(before)
 const os=vi.spyOn(runner,'runProcess')
 expect((await succeeds(f.read())).source.nativeSessionId).toBe('retained-old')
 expect(os).not.toHaveBeenCalled()
})

it('never discovers again on ordinary current Pages or opaque earlier pages after durable acquisition',async()=>{
 const f=await fixture(),observer=await f.client.observeSessionHistory(SID,()=>{},f.options)
 const os=vi.spyOn(runner,'runProcess')
 const page=await succeeds(f.read()),again=await succeeds(f.read())
 expect(page.source).toEqual(observer.source);expect(again.items[2]?.id).toBe('final-1')
 const earlier=await succeeds(f.client.sessionHistoryPage(SID,{...f.options,cursor:page.nextCursor!}))
 expect(earlier.source).toEqual(page.source);expect(earlier.items).toEqual([])
 expect(os).not.toHaveBeenCalled();observer.dispose()
 const proof=process.env.AMX_CURRENT_PROOF
 if(proof){await mkdir(proof,{recursive:true});await writeFile(join(proof,'public-page.json'),JSON.stringify(page,null,2)+'\n');await writeFile(join(proof,'producer-input.json'),JSON.stringify(f.nativeInput,null,2)+'\n');await writeFile(join(proof,'events.json'),JSON.stringify(f.events,null,2)+'\n')}
})

it.each(['absent','throw','several mains','only child','unknown metadata','missing tool','partial frame'])('retains known reading and healthy input with an honest diagnostic when current source is %s',async kind=>{
 const codex=new AgentProviderRegistry().get('codex')
 const provider:AgentProvider={...codex,...(kind==='absent'?{discoverNativeSession:async()=>null}:kind==='throw'?{discoverNativeSession:async()=>{throw new Error('Owned observation failed')}}:{})}
 const records=kind==='several mains'?[{source:'cli'},{source:'cli',id:'other-main'}]:kind==='only child'?[{source:{subagent:{thread_spawn:{parent_thread_id:NATIVE}}},id:'child'}]:kind==='unknown metadata'?[{source:'unknown'}]:undefined
 const f=await fixture(provider,records),original=f.client.agentSession(SID)
 if(kind==='missing tool'||kind==='partial frame'){
  const actual=runner.runProcess
  vi.spyOn(runner,'runProcess').mockImplementation(async(command,args,options)=>{
   if(command==='lsof'){
    if(kind==='missing tool')throw Object.assign(new Error('no lsof'),{code:'ENOENT'})
    const result=await actual(command,args,options);return {...result,stdout:result.stdout.slice(0,-2)}
   }
   return actual(command,args,options)
  })
 }
 const observer=await succeeds(f.client.observeSessionHistory(SID,()=>{},f.options)),page=await succeeds(f.read())
 expect(page.source.nativeSessionId).toBe('retained-old');expect(observer.source).toEqual(page.source)
 expect(page.items[0]?.id).toBe('old-final')
 expect(f.client.agentSession(SID)).toEqual(original)
 expect(f.events.some(event=>event.type==='agent-error' && event.code==='AGENT_NATIVE_SOURCE_UNCONFIRMED')).toBe(true)
 observer.dispose()
})

it.each(['run','host','pid','epoch','different-handle','inode'])('does not replace or read a changed %s while resolving an existing locator',async change=>{
 const codex=new AgentProviderRegistry().get('codex')
 const provider:AgentProvider={...codex,async discoverNativeSession(context){
  const result=await codex.discoverNativeSession!(context)
  if(change==='pid')f.status.mockResolvedValue({...f.run,pid:f.processId+1} as Awaited<ReturnType<CtxmuxRunAdapter['status']>>)
  else if(change==='epoch')Reflect.set(f.client,'connectionEpoch',42)
  else if(change==='inode'){await rm(f.files[0]!);await writeFile(f.files[0]!,JSON.stringify({type:'session_meta',payload:{id:NATIVE,source:'cli'}})+'\n')}
  else{const current=(await loadAgentSessions(f.store))[0]!;await f.store.compareAndSwap(current,{...current,...(change==='run'?{run:{runId:'other-run'}}:{}),...(change==='host'?{hostId:'other-host'}:{}),...(change==='different-handle'?{nativeHandle:{kind:'provider',providerId:'codex',sessionId:'concurrent-other'}}:{})})}
  return result
 }}
 const f=await fixture(provider)
 if(change==='inode'){
  const page=await succeeds(f.client.sessionHistoryPage(SID,{...f.options,refreshNativeSource:true}))
  expect(page.source.nativeSessionId).toBe('retained-old')
 }else await expect(f.client.sessionHistoryPage(SID,{...f.options,refreshNativeSource:true})).rejects.toMatchObject({code:'AGENT_SESSION_HISTORY_SOURCE_CHANGED'})
 expect((await loadAgentSessions(f.store))[0]!.nativeHandle?.sessionId).not.toBe(NATIVE)
})

it('keeps known disconnected and remote history readable without Runtime or local inspection',async()=>{
 const f=await fixture(),os=vi.spyOn(runner,'runProcess')
 vi.mocked(f.kernel.isConnected).mockReturnValue(false)
 const page=await succeeds(f.client.sessionHistoryPage(SID,{...f.options,refreshNativeSource:true}))
 expect(page.items[0]?.id).toBe('old-final')
 const observer=await succeeds(f.client.observeSessionHistory(SID,()=>{},f.options));observer.dispose()
 const current=(await loadAgentSessions(f.store))[0]!
 await f.store.compareAndSwap(current,{...current,hostId:'remote'})
 expect((await succeeds(f.read())).items[0]?.id).toBe('old-final')
 expect(os).not.toHaveBeenCalled()
})

it('keeps known retired history readable without discovering any live process',async()=>{
 const f=await fixture()
 const reservation={kind:'stop' as const,reservationId:'owned-retirement',ownerId:'owned-only',ownerPid:process.pid,agentSessionId:SID,expectedRun:{runId:RUN},operationId:'owned-retire',expiresAt:Date.now()+60000,stopOperation:{daemonInstance:'private-instance',operationKey:'owned-stop',runId:RUN}}
 await f.store.reserveLifecycle(reservation);await f.store.commitLifecycle(reservation,null)
 const os=vi.spyOn(runner,'runProcess')
 expect((await succeeds(f.client.sessionHistoryPage(SID,{...f.options,refreshNativeSource:true}))).items[0]?.id).toBe('old-final')
 const observer=await succeeds(f.client.observeSessionHistory(SID,()=>{},f.options));observer.dispose()
 expect(os).not.toHaveBeenCalled()
})

it.each(['claude','pi'])('uses the same current-source resolver for generic %s native Reader and watcher',async id=>{
 const builtin=new AgentProviderRegistry().get(id)
 const provider:AgentProvider={...builtin,async discoverNativeSession(context:AgentProviderNativeSessionDiscoveryContext){
  return {handle:{kind:'provider',providerId:id,sessionId:NATIVE,transcriptPath:join(context.workspacePath,'generic.jsonl')},async assertCurrent(){}}
 }}
 const f=await fixture(provider),file=join(f.root,'generic.jsonl')
 const record=id==='claude'?{type:'assistant',uuid:'generic-current',sessionId:NATIVE,message:{role:'assistant',content:[{type:'text',text:BODY}]}}:{type:'message',id:'generic-current',parentId:null,message:{role:'assistant',content:[{type:'text',text:BODY}]}}
 await writeFile(file,(id==='pi'?JSON.stringify({type:'session',version:3,id:NATIVE,cwd:f.root})+'\n':'')+JSON.stringify(record)+'\n')
 const observer=await succeeds(f.client.observeSessionHistory(SID,()=>{})),page=await succeeds(f.client.sessionHistoryPage(SID))
 expect(page.source).toEqual(observer.source);expect(page.items[0]).toMatchObject({id:'generic-current',kind:'assistant-message',contentParts:[{kind:'text',text:BODY}]})
 observer.dispose()
})

it('rejects explicit current-source with an earlier cursor before any OS discovery or Reader work',async()=>{
 const f=await fixture(),os=vi.spyOn(runner,'runProcess')
 await expect(f.client.sessionHistoryPage(SID,{...f.options,cursor:'old-opaque',refreshNativeSource:true})).rejects.toMatchObject({code:'INVALID_AGENT_SESSION_HISTORY_OPTIONS'})
 expect((await succeeds(f.read())).items[0]?.id).toBe('old-final');expect(os).not.toHaveBeenCalled()
})

it('keeps durable current records readable if Runtime disappears during the actual successful CAS',async()=>{
 const f=await fixture(),actual=f.store.compareAndSwap.bind(f.store)
 vi.spyOn(f.store,'compareAndSwap').mockImplementation(async(...args)=>{
  await actual(...args)
  if(args[1]?.nativeHandle?.sessionId===NATIVE){expect((await loadAgentSessions(f.store))[0]!.nativeHandle?.sessionId).toBe(NATIVE);vi.mocked(f.kernel.isConnected).mockReturnValue(false);Reflect.set(f.client,'connected',false)}
 })
 expect((await succeeds(f.client.sessionHistoryPage(SID,{...f.options,refreshNativeSource:true}))).items[2]?.id).toBe('final-1')
})

it('rejects the read that outlives its temporary observer without losing retained reading',async()=>{
 const codex=new AgentProviderRegistry().get('codex')
 let entered!:()=>void,release!:()=>void
 const waiting=new Promise<void>(resolve=>{entered=resolve}),gate=new Promise<void>(resolve=>{release=resolve})
 const provider:AgentProvider={...codex,async readSessionHistoryPage(context){
  const page=await codex.readSessionHistoryPage!(context)
  if(context.source.nativeSessionId===NATIVE){entered();await gate}
  return page
 }}
 const f=await fixture(provider)
 vi.spyOn(f.store,'compareAndSwap').mockRejectedValue(Object.assign(new Error('save-only'),{code:'ENOSPC'}))
 const observer=await succeeds(f.client.observeSessionHistory(SID,()=>{},f.options))
 const read=f.read();await waiting;observer.dispose();release()
 await expect(read).rejects.toMatchObject({code:'AGENT_SESSION_HISTORY_SOURCE_CHANGED'})
 expect((await succeeds(f.read())).items[0]?.id).toBe('old-final')
})

it.each(['run','different-handle'])('refuses temporary witness reuse after a %s change',async change=>{
 const f=await fixture(),actual=f.store.compareAndSwap.bind(f.store)
 vi.spyOn(f.store,'compareAndSwap').mockRejectedValueOnce(Object.assign(new Error('save-only'),{code:'EIO'}))
 const observer=await succeeds(f.client.observeSessionHistory(SID,()=>{},f.options))
 const old=(await loadAgentSessions(f.store))[0]!
 await actual(old,{...old,...(change==='run'?{run:{runId:'other-run'}}:{nativeHandle:{kind:'provider',providerId:'codex',sessionId:'other-confirmed',transcriptPath:f.oldFile}})})
 await expect(f.read()).rejects.toMatchObject({code:'AGENT_SESSION_HISTORY_SOURCE_CHANGED'})
 observer.dispose()
})

it('never selects disagreeing temporary observations by arrival order',async()=>{
 const codex=new AgentProviderRegistry().get('codex');let count=0
 const provider:AgentProvider={...codex,async discoverNativeSession(context){
  const id=count++===0?NATIVE:'another-current'
  return {handle:{kind:'provider',providerId:'codex',sessionId:id,transcriptPath:join(context.workspacePath,'claimed-'+id+'.jsonl')},async assertCurrent(){}}
 }}
 const f=await fixture(provider)
 await writeFile(join(f.root,'claimed-'+NATIVE+'.jsonl'),'')
 await writeFile(join(f.root,'claimed-another-current.jsonl'),'')
 vi.spyOn(f.store,'compareAndSwap').mockRejectedValue(Object.assign(new Error('save-only'),{code:'EIO'}))
 const first=await succeeds(f.client.observeSessionHistory(SID,()=>{},f.options)),second=await succeeds(f.client.observeSessionHistory(SID,()=>{},f.options))
 expect(first.source).not.toEqual(second.source)
 await expect(f.read()).rejects.toMatchObject({code:'AGENT_SESSION_HISTORY_SOURCE_CHANGED'})
 first.dispose();second.dispose()
})

it('releases a cancelled current-source acquisition before binding or observation reuse',async()=>{
 const codex=new AgentProviderRegistry().get('codex'),controller=new AbortController()
 const provider:AgentProvider={...codex,async discoverNativeSession(context){const found=await codex.discoverNativeSession!(context);controller.abort();return found}}
 const f=await fixture(provider)
 await expect(f.client.observeSessionHistory(SID,()=>{},{...f.options,signal:controller.signal})).rejects.toBeInstanceOf(Error)
 expect((await loadAgentSessions(f.store))[0]!.nativeHandle?.sessionId).toBe('retained-old')
 expect((await succeeds(f.read())).items[0]?.id).toBe('old-final')
})

it('ends the temporary Runtime prerequisite once another owner really saves the exact current source',async()=>{
 const f=await fixture(),actual=f.store.compareAndSwap.bind(f.store)
 vi.spyOn(f.store,'compareAndSwap').mockRejectedValueOnce(Object.assign(new Error('save-only'),{code:'EIO'}))
 const observer=await succeeds(f.client.observeSessionHistory(SID,()=>{},f.options)),old=(await loadAgentSessions(f.store))[0]!
 await actual(old,{...old,nativeHandle:{kind:'provider',providerId:'codex',sessionId:NATIVE,transcriptPath:f.files[0]!}})
 vi.mocked(f.kernel.isConnected).mockReturnValue(false);Reflect.set(f.client,'connected',false)
 expect((await succeeds(f.read())).items[2]?.id).toBe('final-1')
 const os=vi.spyOn(runner,'runProcess')
 expect((await succeeds(f.read())).source).toEqual(observer.source);expect(os).not.toHaveBeenCalled()
 observer.dispose()
})


it('invalidates the original temporary observation after durable B then durable A, instead of borrowing its original A fence again', async () => {
  const codex = new AgentProviderRegistry().get('codex')
  let discovery = 0
  const provider: AgentProvider = {
    ...codex,
    async discoverNativeSession(context) {
      const id = discovery++ < 2 ? NATIVE : 'retained-old'
      return {
        handle: {
          kind: 'provider', providerId: 'codex', sessionId: id,
          transcriptPath: join(context.workspacePath, id === NATIVE ? 'rollout-owned-0.jsonl' : 'rollout-retained-old.jsonl')
        },
        async assertCurrent() {}
      }
    }
  }
  const f = await fixture(provider)
  vi.spyOn(f.store, 'compareAndSwap').mockRejectedValueOnce(Object.assign(new Error('owned save-only'), { code: 'EIO' }))
  const changes: Array<{ kind: string; code?: string }> = []
  const temporaryB = await succeeds(f.client.observeSessionHistory(SID, event => changes.push(event), f.options))
  expect(temporaryB.source.nativeSessionId).toBe(NATIVE)
  expect((await loadAgentSessions(f.store))[0]!.nativeHandle?.sessionId).toBe('retained-old')

  const durableB = await succeeds(f.client.observeSessionHistory(SID, () => {}, f.options))
  expect(durableB.source.nativeSessionId).toBe(NATIVE)
  expect((await loadAgentSessions(f.store))[0]!.nativeHandle?.sessionId).toBe(NATIVE)

  const currentA = await succeeds(f.client.observeSessionHistory(SID, () => {}, f.options))
  expect(currentA.source.nativeSessionId).toBe('retained-old')
  expect((await loadAgentSessions(f.store))[0]!.nativeHandle?.sessionId).toBe('retained-old')
  const page = await succeeds(f.read())
  if (process.env.AMX_ABA_PROOF) {
    await writeFile(process.env.AMX_ABA_PROOF, JSON.stringify({
      sources: { temporaryB: temporaryB.source, durableB: durableB.source, currentA: currentA.source },
      retained: (await loadAgentSessions(f.store))[0]!.nativeHandle,
      page,
      oldObserverChanges: changes,
      acceptedEvents: f.events
    }, null, 2) + '\n')
  }
  expect(page.source).toEqual(currentA.source)
  expect(page.items[0]?.id).toBe('old-final')
  expect(changes.some(event => event.kind === 'unavailable' && event.code === 'AGENT_SESSION_HISTORY_SOURCE_CHANGED')).toBe(true)
  temporaryB.dispose(); durableB.dispose(); currentA.dispose()
})
