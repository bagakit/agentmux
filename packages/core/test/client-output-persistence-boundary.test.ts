import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import { CtxmuxCommandError, type OutputChunk, type RunEvent, type RunInfo } from '@ctxmux/sdk'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { CtxmuxRunAdapter } from '../src/ctxmux-run-adapter.js'
import type { AgentMuxClientEvent, AgentMuxStoredAgentSession } from '../src/types.js'

const execFileAsync = promisify(execFile)
class Events {
  private values: RunEvent[] = []
  private wake: (() => void) | undefined
  private ended = false
  push(value: RunEvent) { this.values.push(value); this.wake?.() }
  close() { this.ended = true; this.wake?.() }
  async *read(): AsyncGenerator<RunEvent> {
    while (true) {
      if (this.values.length) { yield this.values.shift()!; continue }
      if (this.ended) return
      await new Promise<void>(resolve => { this.wake = resolve })
      this.wake = undefined
    }
  }
}
function chunk(start: number, bytes: number[]): OutputChunk {
  return { start_byte:start,end_byte:start+bytes.length,data:Uint8Array.from(bytes) }
}
function stored(id: number, workspacePath: string): AgentMuxStoredAgentSession {
  return { kind:'agent',agentSessionId:`cost-agent-${id}`,providerId:'codex',executorId:'codex',hostId:'local',workspacePath,
    run:{runId:`cost-run-${id}`},retiredRuns:[],hookBindingId:`binding-${id}`.padEnd(43,'A'),hookToken:`token-${id}`.padEnd(43,'B'),
    nativeHandle:{kind:'provider',providerId:'codex',sessionId:`private-native-${id}`},createdAt:1,updatedAt:1 }
}
function sdkTransport(workspacePath: string) {
  const streams: Events[] = []
  let replay: OutputChunk[] = []
  let latest = 0
  let state: RunInfo['state'] = {type:'running'}
  const info = (id: string) => ({ native_service: null, id,spec:{program:'codex',args:[],cwd:workspacePath,env:{}},state,pid:4321,
    latest_output_bytes:latest,first_available_byte:0,applied_input_bytes:0,current_size:{cols:80,rows:24}} as unknown as RunInfo)
  const status = vi.fn(async (id: string) => info(id))
  const attach = vi.fn(async (id: string, after: number) => {
    const stream = new Events(); streams.push(stream)
    return { snapshot:{ terminal: { type: 'not_requested' }, terminal_restore: new Uint8Array(0), resize_revision: 0,run:info(id),replay:{chunks:replay.filter(c=>c.end_byte>after),first_available_byte:0,latest_output_bytes:latest,truncated:false}},
      events:() => stream.read(),close:() => stream.close(),detach:async () => stream.close() }
  })
  const sdk = { attach,status }
  const adapter = new CtxmuxRunAdapter()
  const internals = adapter as unknown as { client: unknown; markConnectionLost(): void }
  internals.client = sdk
  return {adapter,internals,sdk,streams,status,attach,setReplay(chunks: OutputChunk[]) {replay=chunks;latest=chunks.at(-1)?.end_byte??0},
    endRun() {state={type:'exited',code:0,signal:null}},latest }
}
function output(events: AgentMuxClientEvent[]) {
  return events.filter((event): event is Extract<AgentMuxClientEvent,{type:'terminal-output'}> => event.type==='terminal-output')
}

// SDK I/O is controlled. Client, adapter pump, publication and private FileStore/fsync are actual sources.
describe('output transport owns no durable Agent Session reading cursor', () => {
  for (const count of [1,32]) it(`${count} nonempty Sessions: 64 raw batches cause zero Session writes or status RPCs`, async () => {
    const root=await mkdtemp(join(tmpdir(),'agentmux-output-boundary-'))
    const store=new AgentMuxFileAgentSessionStore(join(root,'sessions.json'))
    const client=new AgentMuxClient({store})
    const transport=sdkTransport(root)
    const internal=client as unknown as { kernel:CtxmuxRunAdapter;connected:boolean;registry:{load(host:string):Promise<void>};acceptKernelEvent(event:unknown):void }
    const events:AgentMuxClientEvent[]=[]
    try {
      for (let i=0;i<count;i++) await store.compareAndSwap(null,stored(i,root))
      await internal.registry.load('local');internal.kernel=transport.adapter;internal.connected=true
      transport.adapter.onEvent(event=>internal.acceptKernelEvent(event));client.onEvent(event=>events.push(event))
      const cas=vi.spyOn(store,'compareAndSwap')
      const write=vi.spyOn(store as unknown as {write(doc:unknown):Promise<void>},'write')
      const before=await readFile(store.path)
      await client.reattachAgent('cost-agent-0',0)
      for (let i=0;i<64;i++) transport.streams[0]!.push({type:'output',chunk:chunk(i*4,[0x1b,0x5b,0x6d,0x41+i%26])})
      await vi.waitFor(()=>expect(output(events)).toHaveLength(64))
      expect(output(events).map(e=>[e.evidence.outputByteRange.startByte,e.evidence.outputByteRange.endByte,[...e.dataBytes]]))
        .toEqual(Array.from({length:64},(_,i)=>[i*4,i*4+4,[0x1b,0x5b,0x6d,0x41+i%26]]))
      expect(cas).toHaveBeenCalledTimes(0);expect(write).toHaveBeenCalledTimes(0);expect(transport.status).toHaveBeenCalledTimes(0)
      expect(await readFile(store.path)).toEqual(before)
      expect(client.agentSessions()).toHaveLength(count)
      expect(client.agentSession('cost-agent-0')).not.toHaveProperty('outputCursorBytes')
      expect(transport.adapter.continuationByte('cost-run-0')).toBe(256)
      console.log('OUTPUT_ONLY_COUNTS',JSON.stringify({sessionCount:count,batches:64,rawBytes:256,cas:cas.mock.calls.length,writes:write.mock.calls.length,status:transport.status.mock.calls.length}))
    } finally {await client.dispose();await rm(root,{recursive:true,force:true})}
  })

  it('publishes replay before live and preserves exact Run continuation through wire loss/reentrant notification', async () => {
    const t=sdkTransport('/private/continuation');const seen:number[][]=[]
    t.adapter.onEvent(event=>{if(event.type==='data') {seen.push([event.startByte,event.endByte]);t.internals.markConnectionLost()}})
    try {
      t.setReplay([chunk(0,[1,2,3,4])])
      await t.adapter.attach('run-A',0,snapshot=>{seen.push(...snapshot.replay.map(c=>[c.startByte,c.endByte]))})
      expect(seen).toEqual([[0,4]])
      expect(t.adapter.continuationByte('run-A')).toBe(4)
      t.streams[0]!.push({type:'output',chunk:chunk(4,[5,6])})
      await vi.waitFor(()=>expect(t.adapter.isConnected()).toBe(false))
      expect(seen).toEqual([[0,4],[4,6]])
      expect(t.adapter.continuationByte('run-A')).toBe(6)
      expect(t.adapter.continuationByte('run-B')).toBe(0)
      t.internals.client=t.sdk;t.setReplay([chunk(6,[7,8])])
      await t.adapter.attach('run-A',t.adapter.continuationByte('run-A'),snapshot=>seen.push(...snapshot.replay.map(c=>[c.startByte,c.endByte])))
      expect(t.attach.mock.calls.map(c=>[c[0],c[1]])).toEqual([['run-A',0],['run-A',6]])
      expect(seen).toEqual([[0,4],[4,6],[6,8]])
      expect(t.adapter.continuationByte('run-A')).toBe(8)
      await t.adapter.detach('run-A');expect(t.adapter.continuationByte('run-A')).toBe(0)
    } finally {t.adapter.disconnect()}
  })

  it('replay publication may synchronously lose the wire without reinstalling its closed owner', async () => {
    const t=sdkTransport('/private/replay-reentry');const seen:number[][]=[]
    try {
      t.setReplay([chunk(0,[1,2,3,4])])
      await t.adapter.attach('run-A',0,snapshot=>{
        seen.push(...snapshot.replay.map(c=>[c.startByte,c.endByte]))
        t.internals.markConnectionLost()
      })
      expect(seen).toEqual([[0,4]])
      expect(t.adapter.isConnected()).toBe(false)
      expect(t.adapter.hasAttachment('run-A')).toBe(false)
      expect(t.adapter.continuationByte('run-A')).toBe(4)
      t.internals.client=t.sdk;t.setReplay([chunk(4,[5,6])])
      await t.adapter.attach('run-A',t.adapter.continuationByte('run-A'),snapshot=>seen.push(...snapshot.replay.map(c=>[c.startByte,c.endByte])))
      expect(t.attach.mock.calls.map(c=>[c[0],c[1]])).toEqual([['run-A',0],['run-A',4]])
      expect(seen).toEqual([[0,4],[4,6]])
      expect(t.adapter.hasAttachment('run-A')).toBe(true)
    } finally { t.adapter.disconnect() }
  })

  it('old pump completion cannot clear a replacement owner; terminal facts dispose retained continuation', async () => {
    const t=sdkTransport('/private/owners')
    try {
      t.setReplay([chunk(0,[1,2,3])]);await t.adapter.attach('run-A',0)
      t.adapter.resetConnection();t.internals.client=t.sdk
      t.setReplay([chunk(3,[4,5])]);await t.adapter.attach('run-A',3)
      await Promise.resolve();await Promise.resolve()
      expect(t.adapter.hasAttachment('run-A')).toBe(true)
      expect(t.adapter.continuationByte('run-A')).toBe(5)
      t.streams[1]!.push({type:'output',chunk:chunk(5,[6])})
      await vi.waitFor(()=>expect(t.adapter.continuationByte('run-A')).toBe(6))
      t.adapter.resetConnection();t.internals.client=t.sdk;t.endRun()
      expect((await t.adapter.status('run-A')).state.type).toBe('exited')
      expect(t.adapter.continuationByte('run-A')).toBe(0)
      await t.adapter.detach('run-A')
    } finally {t.adapter.disconnect()}
  })

  it('authoritative missing Run disposes its disconnected continuation without clearing a different Run', async () => {
    const t=sdkTransport('/private/missing')
    try {
      t.setReplay([chunk(0,[1,2,3])]);await t.adapter.attach('run-A',0)
      t.setReplay([chunk(0,[4,5])]);await t.adapter.attach('run-B',0)
      t.adapter.resetConnection();t.internals.client=t.sdk
      t.status.mockRejectedValueOnce(new CtxmuxCommandError('run_not_found', 'Private Run was removed.', 'not_applied'))
      await expect(t.adapter.status('run-A')).rejects.toMatchObject({code:'CTXMUX_run_not_found'})
      expect(t.adapter.continuationByte('run-A')).toBe(0)
      expect(t.adapter.continuationByte('run-B')).toBe(2)
      t.adapter.disconnect();expect(t.adapter.continuationByte('run-B')).toBe(0)
    } finally {t.adapter.disconnect()}
  })

  it('preserves semantic identity/native handle/accepted phase evidence in a fresh OS process without a schema migration', async () => {
    const root=await mkdtemp(join(tmpdir(),'agentmux-output-reload-'));const store=new AgentMuxFileAgentSessionStore(join(root,'sessions.json'))
    try {
      await store.compareAndSwap(null,stored(0,root))
      const first=(await store.load())[0] as AgentMuxStoredAgentSession
      expect(first.agentSessionId).toBe('cost-agent-0')
      const next={...first,updatedAt:10,semanticStatus:{state:'done' as const,source:'native-hook' as const,observedAt:10,stateEnteredAt:10},
        terminalPromptSubmission:{run:first.run,submissionId:'accepted-intent',promptDigest:'digest',outputCursorBytes:128,
          payload:{operationId:'accepted-payload',inputByteRange:{startByte:0,endByte:4},acknowledged:true},
          submit:{operationId:'accepted-enter',inputByteRange:{startByte:4,endByte:5},acknowledged:true}}}
      await store.compareAndSwap(first,next)
      const before=await readFile(store.path)
      const module=fileURLToPath(new URL('../dist/index.js',import.meta.url))
      const script=`import { AgentMuxFileAgentSessionStore, AgentMuxClient } from ${JSON.stringify('file://'+module)};const store=new AgentMuxFileAgentSessionStore(process.argv[1]);const client=new AgentMuxClient({store});await client.registry.load('local');console.log(JSON.stringify(client.agentSession('cost-agent-0')));await client.dispose();`
      const {stdout}=await execFileAsync(process.execPath,['--input-type=module','-e',script,store.path],{timeout:10000,maxBuffer:65536,
        env:{...process.env,CODEX_HOME:join(root,'codex'),AGENTMUX_AGENT_SESSION_STORE:store.path,AGENTMUX_RUNTIME_DIR:join(root,'runtime')}})
      expect(JSON.parse(stdout)).toMatchObject({agentSessionId:first.agentSessionId,run:first.run,nativeHandle:first.nativeHandle,
        semanticStatus:next.semanticStatus,terminalPromptSubmission:next.terminalPromptSubmission})
      expect(JSON.parse(stdout)).not.toHaveProperty('outputCursorBytes')
      expect(await readFile(store.path)).toEqual(before)
    } finally {await rm(root,{recursive:true,force:true})}
  })
})
