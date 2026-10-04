import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import { NativeSqliteHistoryReader } from '../src/native-sqlite-history-reader.js'
import { observeNativeSqliteHistory } from '../src/native-sqlite-history-observer.js'
import type { AgentMuxStoredAgentSession, AgentSessionHistoryObservation, AgentProviderSessionHistoryObservationContext } from '../src/types.js'

it('public observation survives a concurrent same-identity WAL commit during native revision reading', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amux-public-sqlite-'))
  const path = join(root, 'store.db'), writer = new DatabaseSync(path)
  writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); INSERT INTO meta VALUES('revision','first'); PRAGMA wal_checkpoint(TRUNCATE)")
  const before = await stat(path, {bigint:true})
  const commit = (value:string) => writer.prepare("UPDATE meta SET value=? WHERE key='revision'").run(value)
  let concurrent = false, context!:AgentProviderSessionHistoryObservationContext
  const store = new AgentMuxMemoryAgentSessionStore()
  const session:AgentMuxStoredAgentSession={kind:'agent',agentSessionId:'peer-sqlite',providerId:'codex',executorId:'codex',hostId:'local',workspacePath:root,run:{runId:'read-only-retained'},retiredRuns:[],hookBindingId:'controlled',hookToken:'controlled',createdAt:1,updatedAt:1,nativeHandle:{kind:'provider',providerId:'codex',sessionId:'controlled-native',transcriptPath:path}}
  await store.compareAndSwap(null,session)
  const storedBefore = await store.load()
  const base = new AgentProviderRegistry().get('codex')
  const client = new AgentMuxClient({store,providers:[{...base,observeSessionHistory: async value => {
    context=value
    return observeNativeSqliteHistory(value,path,async () => {
      const reader = await NativeSqliteHistoryReader.open(path,value.signal)
      try {
        const row=await reader.get("SELECT value FROM meta WHERE key='revision'")
        if(concurrent){concurrent=false;commit('native commit during verification')}
        await reader.verifyUnchanged()
        return String(row![0])
      } finally {await reader.close()}
    })
  }}]})
  const kernel=Reflect.get(client,'kernel')
  const controls=['connect','start','input','resize','stop','attach','status'].map(name=>vi.spyOn(kernel,name).mockImplementation(()=>{throw new Error('Forbidden read-only control '+name)}))
  const events:AgentSessionHistoryObservation[]=[]
  let handle:Awaited<ReturnType<typeof client.observeSessionHistory>>|undefined
  try {
    handle=await client.observeSessionHistory(session.agentSessionId,event=>events.push(event))
    await new Promise(done=>setTimeout(done,60))
    concurrent=true;commit('second')
    await expect.poll(()=>events.some(e=>e.kind==='unavailable')).toBe(true)
    const after=await stat(path,{bigint:true})
    expect([String(after.dev),String(after.ino)]).toEqual([String(before.dev),String(before.ino)])
    commit('third stable native revision')
    await new Promise(done=>setTimeout(done,100))
    expect(await store.load()).toEqual(storedBefore)
    expect(controls.map(value=>value.mock.calls.length)).toEqual([0,0,0,0,0,0,0])
    expect(context.signal.aborted,'same physical DB with a concurrent WAL commit must keep the original public watch recoverable').toBe(false)
    await expect.poll(()=>events.some(e=>e.kind==='invalidated')).toBe(true)
  } finally {handle?.dispose();await client.dispose();writer.close();await rm(root,{recursive:true,force:true})}
})
