import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxFileAgentSessionStore, loadAgentSessions } from '../src/agent-session-store.js'
import type { AgentSessionHistoryPageOptions } from '../src/types.js'

type Request = { id?: number; method: string; params?: Record<string, unknown> }
const nativeId = 'main-native-id'
const entries = [
  { turnId: 'turn-2', startedAtMs: 100, completedAtMs: 200,
    item: { type: 'agentMessage', id: 'assistant-latest', text: '\n  exact assistant 中\n' } },
  { turnId: 'turn-2', startedAtMs: null, completedAtMs: null,
    item: { type: 'futureActivity', id: 'unknown-activity', nested: { complete: 'never discard', reference: 'native:resource' } } },
  { turnId: 'turn-1', item: { type: 'userMessage', id: 'user-older', content: [
    { type: 'text', text: '\n  exact user 中\n' }, { type: 'image', url: 'https://synthetic.invalid/image.png' },
    { type: 'text', text: 'after image ' }, { type: 'image', fileId: 'native-image-file-id' },
    { type: 'localImage', path: '/synthetic/local.png' }, { type: 'audio', url: 'native:audio' },
    { type: 'localAudio', path: '/synthetic/local.wav' }, { type: 'skill', name: 'skill', path: '/synthetic/SKILL.md' },
    { type: 'mention', name: 'file', path: '/synthetic/file.ts' }
  ] } }
]


type Helper = { pid: number; args: string[]; cwd: string; home: string; deletedEnv: boolean; descendantPid?: number }
async function fixture(
  verify: (owner: { client: AgentMuxClient; store: AgentMuxFileAgentSessionStore;
    read(options?: AgentSessionHistoryPageOptions): ReturnType<AgentMuxClient['sessionHistoryPage']>;
    requests(): Promise<Request[]>; helpers(): Promise<Helper[]>; home: string }) => Promise<void>,
  mode = 'normal'
): Promise<void> {
  const home = await mkdtemp('/tmp/amx-native-stdio-test-')
  const workspace = join(home, 'workspace')
  await mkdir(workspace)
  const script = join(home, 'native-fixture.mjs')
  const requestFile = join(home, 'requests.jsonl')
  const helperFile = join(home, 'helpers.jsonl')
  await writeFile(script, `
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { spawn } from 'node:child_process'
const entries = ${JSON.stringify(entries)}
const nativeId = ${JSON.stringify(nativeId)}
const mode = process.env.AMX_NATIVE_MODE
const descendant=mode==='orphan-descendant'?spawn(process.execPath,['-e','setInterval(()=>{},60000)'],{stdio:'ignore'}):null
descendant?.unref()
appendFileSync(process.env.AMX_HELPER_FILE, JSON.stringify({pid:process.pid,args:process.argv.slice(2),
  cwd:process.cwd(),home:process.env.CODEX_HOME,deletedEnv:!Object.hasOwn(process.env,'AMX_DELETE_ME'),
  ...(descendant?{descendantPid:descendant.pid}:{})})+'\\n')
const input = createInterface({input:process.stdin})
if(mode==='ignore-eof-and-term') { setInterval(()=>{},60000); process.on('SIGTERM',()=>{}) }
input.on('line', line => {
  const request = JSON.parse(line)
  appendFileSync(process.env.AMX_REQUEST_FILE,JSON.stringify(request)+'\\n')
  const send = result => {
    const bytes = Buffer.from(JSON.stringify({id:request.id,result})+'\\n')
    if(mode==='split-unicode') {
      const mid=bytes.indexOf(Buffer.from('中'))+1
      if(mid>0) { process.stdout.write(bytes.subarray(0,mid)); setTimeout(()=>process.stdout.write(bytes.subarray(mid)),1); return }
    }
    process.stdout.write(bytes)
  }
  if(request.method==='initialize') send({userAgent:'synthetic-native-server'})
  else if(request.method==='thread/read') {
    if(mode==='wrong-request-id') { process.stdout.write(JSON.stringify({id:999,result:{thread:{id:nativeId,historyMode:'paginated'}}})+'\\n'); return }
    send({thread:{id:mode==='wrong-identity'?'fork-child-id':nativeId,
      historyMode:mode==='legacy-mode'?'legacy':'paginated',turns:[]}})
  } else if(request.method==='thread/items/list') {
    if(mode==='pending' || mode==='ignore-eof-and-term') return
    if(mode==='early-eof') { process.exit(0); return }
    if(mode==='invalid-utf8') { process.stdout.write(Buffer.from([0xff,10])); return }
    if(mode==='large-stdout') { send({data:[{turnId:'large',item:{type:'agentMessage',id:'large',text:'x'.repeat(4*1024*1024)}}],nextCursor:null}); return }
    if(mode==='large-stderr') { process.stderr.write('x'.repeat(4*1024*1024)); send({data:[],nextCursor:null}); return }
    if(mode==='notification-flood') { for(let i=0;i<2;i++) process.stdout.write(JSON.stringify({method:'synthetic/notice',params:{text:'x'.repeat(2200000)}})+'\\n'); return }
    if(request.params.cursor==='foreign-source-cursor') { process.stdout.write(JSON.stringify({id:request.id,error:{code:-32602,message:'foreign cursor'}})+'\\n'); return }
    if(request.params.cursor==='empty-window') send({data:[],nextCursor:'native-opaque-next'})
    else if(request.params.cursor==='native-opaque-next') send({data:[{turnId:'turn-0',item:{type:'userMessage',id:'oldest-user',content:[{type:'text',text:'earlier complete conversation'}]}}],nextCursor:null})
    else {
      send({data:entries,nextCursor:'native-opaque-next'})
      if(mode==='trailing-malformed') process.stdout.write('{broken JSON\\n')
      if(mode==='trailing-partial') process.stdout.write('{broken JSON')
    }
  }
})
`)
  const requests = async (): Promise<Request[]> => readFile(requestFile, 'utf8')
    .then(text => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)), () => [])
  const helpers = async (): Promise<Helper[]> => readFile(helperFile, 'utf8')
    .then(text => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)), () => [])
  const path = join(home, 'agent-sessions.json')
  const store = new AgentMuxFileAgentSessionStore(path)
  await store.compareAndSwap(null, { kind:'agent',agentSessionId:'main-session',providerId:'codex',executorId:'codex',
    hostId:'local',workspacePath:workspace,run:{runId:'original-run'},retiredRuns:[],outputCursorBytes:100,
    hookBindingId:'synthetic-binding',hookToken:'synthetic-token',createdAt:1,updatedAt:1,
    nativeHandle:{kind:'provider',providerId:'codex',sessionId:nativeId,
      transcriptPath:'/synthetic/untrusted-child-path-is-ignored.jsonl'} })
  const client = new AgentMuxClient({store:new AgentMuxFileAgentSessionStore(path)})
  const invocation: AgentSessionHistoryPageOptions = {commandOverride:process.execPath,
    args:[script,'configured-argument'],env:{CODEX_HOME:home,AMX_NATIVE_MODE:mode,
      AMX_REQUEST_FILE:requestFile,AMX_HELPER_FILE:helperFile,AMX_DELETE_ME:undefined}}
  try {
    await verify({client,store,home,requests,helpers,
      read:options=>client.sessionHistoryPage('main-session',{...invocation,...options})})
    for (const helper of await helpers()) {
      expect(() => process.kill(helper.pid,0)).toThrowError(/ESRCH/)
      if (helper.descendantPid !== undefined) {
        await vi.waitFor(()=>expect(()=>process.kill(helper.descendantPid!,0)).toThrowError(/ESRCH/),{timeout:1000,interval:10})
      }
    }
  } finally {
    await client.dispose()
    for (const helper of await helpers()) {
      try { process.kill(-helper.pid,'SIGKILL') } catch(error) { if((error as NodeJS.ErrnoException).code!=='ESRCH') throw error }
    }
    await rm(home,{recursive:true,force:true})
  }
}

describe('actual public Client to owned native stdio read protocol', () => {
  it('reads exact metadata and two indexed pages with text/resource fidelity and chronological items',async()=>{
    await fixture(async({read,store,requests,helpers,home})=>{
      const first=await read({limit:3})
      expect(first.source).toEqual({providerId:'codex',nativeSessionId:nativeId})
      expect(first.items.map(item=>item.id)).toEqual(['user-older','unknown-activity','assistant-latest'])
      expect(first.items[0]!.contentParts).toEqual([
        {kind:'text',text:'\n  exact user 中\n'},
        {kind:'resource',resourceType:'image',reference:'https://synthetic.invalid/image.png'},
        {kind:'text',text:'after image '},
        {kind:'resource',resourceType:'image',reference:'native-image-file-id'},
        {kind:'resource',resourceType:'image',reference:'/synthetic/local.png'},
        {kind:'resource',resourceType:'audio',reference:'native:audio'},
        {kind:'resource',resourceType:'audio',reference:'/synthetic/local.wav'},
        {kind:'resource',resourceType:'file',reference:'/synthetic/SKILL.md',label:'skill'},
        {kind:'resource',resourceType:'file',reference:'/synthetic/file.ts',label:'file'}
      ])
      expect(first.items[1]).toEqual({id:'unknown-activity',turnId:'turn-2',kind:'activity',title:'futureActivity',
        contentParts:[{kind:'text',text:JSON.stringify(entries[1]!.item,null,2)}]})
      expect(first.items[2]).toMatchObject({kind:'assistant-message',startedAt:100,completedAt:200,
        contentParts:[{kind:'text',text:'\n  exact assistant 中\n'}]})
      const older=await read({limit:3,cursor:first.nextCursor!})
      expect(first.nextCursor).toBe('native-opaque-next')
      expect(older.items.map(item=>item.id)).toEqual(['oldest-user'])
      expect(older.nextCursor).toBeNull()
      const calls=await requests()
      expect(calls.map(request=>request.method)).toEqual([
        'initialize','initialized','thread/read','thread/items/list',
        'initialize','initialized','thread/read','thread/items/list'
      ])
      expect(calls[2]!.params).toEqual({threadId:nativeId,includeTurns:false})
      expect(calls[7]!.params).toEqual({threadId:nativeId,limit:3,sortDirection:'desc',cursor:'native-opaque-next'})
      const owners=await helpers()
      expect(owners).toHaveLength(2)
      expect(owners[0]).toMatchObject({home,cwd:join(home,'workspace'),deletedEnv:true,
        args:['configured-argument','-s','read-only','-a','never','app-server','--stdio']})
      expect(owners[0]!.pid).not.toBe(owners[1]!.pid)
      expect((await loadAgentSessions(store)).map(session=>session.run)).toEqual([{runId:'original-run'}])
    })
  })
  it.each(['wrong-identity','legacy-mode'])('rejects %s metadata before any item read and reaps the helper',async reason=>{
    await fixture(async({read,requests})=>{
      await expect(read()).rejects.toMatchObject({code:reason==='wrong-identity'?'AGENT_SESSION_HISTORY_SOURCE_CHANGED':'AGENT_SESSION_HISTORY_UNSUPPORTED'})
      expect((await requests()).map(request=>request.method)).toEqual(['initialize','initialized','thread/read'])
    },reason)
  })
  it('preserves empty continuation and delegates foreign cursor scope refusal to the native owner',async()=>{
    await fixture(async({read})=>{
      expect(await read({cursor:'empty-window'})).toEqual({agentSessionId:'main-session',
        source:{providerId:'codex',nativeSessionId:nativeId},items:[],nextCursor:'native-opaque-next'})
      await expect(read({cursor:'foreign-source-cursor'})).rejects.toMatchObject({code:'AGENT_SESSION_HISTORY_UNAVAILABLE'})
    })
  })
  it('binds responses to the exact request ID instead of accepting a different read result',async()=>{
    await fixture(async({read})=>{await expect(read()).rejects.toMatchObject({code:'INVALID_AGENT_SESSION_HISTORY_PAGE'})},'wrong-request-id')
  })
  it.each(['large-stdout','large-stderr','notification-flood'])('bounds aggregate actual %s bytes and reaps the helper',async mode=>{
    await fixture(async({read})=>{await expect(read()).rejects.toMatchObject({code:'AGENT_SESSION_HISTORY_TOO_LARGE'})},mode)
  })
  it('decodes UTF-8 carried across native stdout chunks without changing text',async()=>{
    await fixture(async({read})=>{expect((await read()).items[2]!.contentParts).toEqual([{kind:'text',text:'\n  exact assistant 中\n'}])},'split-unicode')
  })
  it('rejects malformed native UTF-8 rather than silently replacing characters',async()=>{
    await fixture(async({read})=>{await expect(read()).rejects.toMatchObject({code:'INVALID_AGENT_SESSION_HISTORY_PAGE'})},'invalid-utf8')
  })
  it.each(['trailing-malformed','trailing-partial'])('rejects a valid last page followed by %s native output before EOF',async mode=>{
    await fixture(async({read})=>{await expect(read()).rejects.toMatchObject({code:'INVALID_AGENT_SESSION_HISTORY_PAGE'})},mode)
  })
  it('reaps a helper-owned descendant after its successful parent has already exited on EOF',async()=>{
    await fixture(async({read,helpers})=>{
      expect((await read()).items.map(item=>item.id)).toEqual(['user-older','unknown-activity','assistant-latest'])
      const owners=await helpers()
      expect(owners).toHaveLength(1)
      expect(owners[0]!.descendantPid).toBeGreaterThan(0)
    },'orphan-descendant')
  })
  it('reports EOF with an outstanding request as a reading failure and keeps the same Session',async()=>{
    await fixture(async({read,store})=>{
      await expect(read()).rejects.toMatchObject({code:'AGENT_SESSION_HISTORY_UNAVAILABLE'})
      expect((await loadAgentSessions(store)).map(session=>session.run)).toEqual([{runId:'original-run'}])
    },'early-eof')
  })
  it('reports a missing configured command without requiring a connected Run',async()=>{
    await fixture(async({read,store,requests})=>{
      await expect(read({commandOverride:'/missing/agentmux-native-helper'})).rejects.toMatchObject({code:'AGENT_SESSION_HISTORY_UNAVAILABLE'})
      expect(await requests()).toEqual([])
      expect((await loadAgentSessions(store)).map(session=>session.run)).toEqual([{runId:'original-run'}])
    })
  })
  it.each(['pending','ignore-eof-and-term'])('disposal aborts and physically reaps a %s helper while keeping the Session',async mode=>{
    await fixture(async({read,client,store,requests,helpers})=>{
      const reading=read()
      const rejection=expect(reading).rejects.toMatchObject({code:'AGENT_SESSION_HISTORY_CANCELLED'})
      await vi.waitFor(async()=>expect((await requests()).at(-1)?.method).toBe('thread/items/list'),{timeout:1000,interval:5})
      const owners=await helpers()
      expect(owners).toHaveLength(1)
      await client.dispose()
      await rejection
      // The Client settles cancellation promptly, but keeps physical capacity until Provider cleanup finishes.
      await vi.waitFor(()=>expect(()=>process.kill(owners[0]!.pid,0)).toThrowError(/ESRCH/),{timeout:4000,interval:10})
      expect((await loadAgentSessions(store)).map(session=>session.nativeHandle?.sessionId)).toEqual([nativeId])
    },mode)
  })
  it('keeps two same-Provider configured native homes isolated on consecutive reads',async()=>{
    await fixture(async({read,helpers,home})=>{
      const other=join(home,'other-native-home')
      await read()
      const first=(await helpers())[0]!
      const env={CODEX_HOME:other,AMX_NATIVE_MODE:'normal',AMX_HELPER_FILE:join(home,'helpers.jsonl'),AMX_REQUEST_FILE:join(home,'requests.jsonl')}
      await read({env})
      const owners=await helpers()
      expect(owners).toHaveLength(2)
      expect(owners.map(owner=>owner.home)).toEqual([home,other])
      expect(owners[0]!.pid).toBe(first.pid)
    })
  })
})
