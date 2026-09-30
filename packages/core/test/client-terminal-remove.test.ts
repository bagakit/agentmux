import { expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import type { AgentMuxAgentSessionRegistry } from '../src/agent-session-registry.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'

it('public terminal removal refuses both current and retired Agent bindings without changing their durable facts',async()=>{
  const store=new AgentMuxMemoryAgentSessionStore()
  const session:AgentMuxStoredAgentSession={kind:'agent',agentSessionId:'semantic-guard',providerId:'codex',executorId:'codex',hostId:'local',
    workspacePath:'/private/toolkit-remove',run:{runId:'current-agent'},retiredRuns:[{runId:'retired-agent'}],
    hookBindingId:'binding',hookToken:'token',createdAt:1,updatedAt:1}
  await store.compareAndSwap(null,session)
  const client=new AgentMuxClient({store}),inner=client as unknown as {connected:boolean;registry:AgentMuxAgentSessionRegistry;kernel:{remove(id:string):Promise<void>;isConnected():boolean}}
  await inner.registry.load('local');inner.connected=true
  const remove=vi.spyOn(inner.kernel,'remove').mockResolvedValue(undefined)
  const connected=vi.spyOn(inner.kernel,'isConnected').mockReturnValue(true)
  try {
    const codes=[]
    for(const runId of ['current-agent','retired-agent']) {
      codes.push(await client.removeTerminal({runId}).then(()=>null,error=>error.code))
    }
    expect(codes).toEqual(['RUN_KIND_MISMATCH','RUN_KIND_MISMATCH'])
    expect(remove).not.toHaveBeenCalled();expect(await store.load()).toEqual([session])
    await expect(client.removeTerminal({runId:'actual-terminal'})).resolves.toBeUndefined()
    expect(remove.mock.calls).toEqual([['actual-terminal']])
  } finally {remove.mockRestore();connected.mockRestore();await client.dispose()}
})

it('successful terminal retirement releases only its exact metadata while failed removal preserves authoritative facts',async()=>{
  const client=new AgentMuxClient({store:new AgentMuxMemoryAgentSessionStore()})
  const inner=client as unknown as {connected:boolean;kernel:{remove(id:string):Promise<void>;isConnected():boolean};
    runPids:Map<string,number>;endedRuns:Map<string,unknown>;stopRequestedRuns:Set<string>}
  inner.connected=true
  const connected=vi.spyOn(inner.kernel,'isConnected').mockReturnValue(true)
  const remove=vi.spyOn(inner.kernel,'remove').mockResolvedValue(undefined)
  inner.runPids.set('healthy-agent',7);inner.endedRuns.set('retired-agent',{kind:'completed'})
  inner.stopRequestedRuns.add('healthy-agent')
  try {
    for(let n=0;n<10;n++) {
      const id='terminal-'+n
      inner.runPids.set(id,100+n);inner.endedRuns.set(id,{kind:'user-stopped'});inner.stopRequestedRuns.add(id)
      await expect(client.removeTerminal({runId:id})).resolves.toBeUndefined()
      expect([...inner.runPids]).toEqual([['healthy-agent',7]])
      expect([...inner.endedRuns]).toEqual([['retired-agent',{kind:'completed'}]])
      expect([...inner.stopRequestedRuns]).toEqual(['healthy-agent'])
    }
    inner.runPids.set('pinned',20);inner.endedRuns.set('pinned',{kind:'user-stopped'});inner.stopRequestedRuns.add('pinned')
    remove.mockRejectedValueOnce(Object.assign(new Error('Run pinned'),{code:'CTXMUX_backend_unavailable'}))
    await expect(client.removeTerminal({runId:'pinned'})).rejects.toMatchObject({code:'CTXMUX_backend_unavailable'})
    expect([...inner.runPids]).toEqual([['healthy-agent',7],['pinned',20]])
    expect([...inner.endedRuns]).toEqual([['retired-agent',{kind:'completed'}],['pinned',{kind:'user-stopped'}]])
    expect([...inner.stopRequestedRuns]).toEqual(['healthy-agent','pinned'])
    expect(remove.mock.calls).toHaveLength(11)
  } finally {remove.mockRestore();connected.mockRestore();await client.dispose()}
})
