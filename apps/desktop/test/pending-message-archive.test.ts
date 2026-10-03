import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { useAppStore, agentSteerCanEdit, restorePersistedUiState, type AgentSteerQueueEntry } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import type { AppConfig, SessionSnapshot } from '../src/shared/contracts'
import { sessionServiceNotices } from '../src/renderer/src/lib/session-service-notices'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client'
import { parseAgentMuxControlRequest, parseAgentMuxControlReceipt } from '../../../packages/core/src/control-codec'
import { parsePendingMessage } from '../../../packages/core/src/pending-message-control'
import { AGENTMUX_CLI_COMMANDS } from '../../../packages/core/src/agentmux-cli-commands'
import { AGENTMUX_RPC_CONTROL_METHODS } from '../../../packages/core/src/public-rpc'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc'
import type { AgentTimelineItem } from '@agentmux/core'

const composerConfig: AppConfig = { version:9, hosts:[{id:'local',kind:'local',label:'Local'}], executors:{},
  workspaces:[{id:'workspace',name:'Project',hostId:'local',path:_hygiene_fixturePath("repo"),kind:'folder'}], appearance:{terminalTheme:'graphite'},
  browser:{toolbar:{selectElement:true,screenshot:true,devTools:true,viewport:true,saveBookmark:true,more:true}} }
const session: Extract<SessionSnapshot,{kind:'agent'}> = {id:'archive-session',kind:'agent',providerId:'codex',executorId:'codex',hostId:'local',workspacePath:_hygiene_fixturePath("repo"),
  promptSubmissionPredecessor:null,agentSessionUpdatedAt:1,label:'Agent',createdAt:1,updatedAt:1,latestOutputBytes:0,processState:'running',
  status:{state:'running',source:'run-process',observedAt:1},capabilities:{terminal:true,timeline:'complete-events',permission:'observe',providerResume:true,replyCorrelation:'none'},
  control:{kind:'agent',hostId:'local',agentSessionId:'archive-session',run:{runId:'run-archive-session'}}}
const initial = useAppStore.getState(), sid = session.id
let dispose: (()=>void)|undefined
const known = (id: string): AgentSteerQueueEntry => ({ operationId: id, text: `Original ${id}\nFull tail`,
  runId: session.control.run.runId, promptCondition: null, status: 'queued', enqueuedAt: 100,
  awaitingExplicitSend: true, agentMuxNote: 'Original producer', sourceChannel: 'message-tool' })
const getQueue = () => useAppStore.getState().agentSteerQueues[sid]!
const confirmed = (id: string, overrides: Partial<AgentTimelineItem> = {}): AgentTimelineItem => ({
  id: `prompt:${id}`, agentSessionId: sid, kind: 'user_message', status: 'complete', source: 'user',
  title: 'Original input', content: 'not an identity', createdAt: 1, updatedAt: 1, ...overrides
})
function timeline(item: AgentTimelineItem) {
  useAppStore.getState().applyEvent({type:'core', hostId:'local', event:{ type:'agent-timeline', agentSessionId:sid,
    revision:1, mutation:{type:'append',agentSessionId:sid,item},
    evidence:{source:'user',observedAt:2,run:session.control.run} }})
}
beforeEach(async () => { dispose=await useAppStore.getState().initialize();useAppStore.setState(initial,true); useAppStore.setState({ config:composerConfig,sessions:[session],
  agentSteerQueues:{[sid]:[known('head'),known('second'),known('tail')]},agentSteerInFlight:{},agentSteerInFlightPhase:{},
  timelines:{},agentComposerDrafts:{[sid]:'Keep the bottom draft'} }) })
afterEach(() => {dispose?.();dispose=undefined;useAppStore.setState(initial,true); vi.restoreAllMocks()})

it('archives one exact nonhead record without discarding original input facts, order or draft', async()=>{
  const original=getQueue(), target={...original[1]!,status:'failed' as const,promptCondition:{expectedRun:{runId:'old-run'},afterSubmissionId:'old-submission'},
    execution:'immediate' as const,errorCode:'AGENT_PROMPT_PREPARATION_FAILED',error:'Original cause: input result unknown',runId:'old-run'}
  useAppStore.setState({agentSteerQueues:{[sid]:[original[0]!,target,original[2]!]}})
  const submit=vi.spyOn(api.sessions,'submitPrompt').mockResolvedValue()
  const result=await useAppStore.getState().archiveAgentSteer(sid,target.operationId,target.text,true)
  expect(result).toEqual({changed:true,entry:{...target,archived:true}})
  expect(getQueue()).toEqual([original[0],{...target,archived:true},original[2]])
  expect(sessionServiceNotices(session,getQueue()).some(item=>item.id==='queue')).toBe(false)
  await useAppStore.getState().flushAgentSteerQueue(sid)
  expect(submit).not.toHaveBeenCalled(); expect(agentSteerCanEdit(result.entry)).toBe(false)
  expect(useAppStore.getState().agentComposerDrafts[sid]).toBe('Keep the bottom draft')
})

it('public archive receipt waits for the existing storage owner; failed saving keeps the original archived facts',async()=>{
  const target=getQueue()[1]!
  let release!:()=>void
  const flush=vi.spyOn(api.ui,'requestStorageFlush').mockImplementation(()=>new Promise<void>(resolve=>{release=resolve}))
  let returned=false
  const result=useAppStore.getState().executeControl({schemaVersion:5,requestId:'durable',operation:'message.pending.archive',agentSessionId:sid,pendingId:target.operationId,expectedText:target.text}).then(value=>{returned=true;return value})
  await Promise.resolve();expect(getQueue()[1]).toEqual({...target,archived:true})
  expect(flush).toHaveBeenCalled();expect(returned).toBe(false)
  release();expect(await result).toMatchObject({changed:true,message:{archived:true}})
  flush.mockRejectedValue(new Error('storage owner unavailable'))
  await expect(useAppStore.getState().executeControl({schemaVersion:5,requestId:'restore-durable',operation:'message.pending.restore',agentSessionId:sid,pendingId:target.operationId,expectedText:target.text})).rejects.toThrow('storage owner unavailable')
  expect(getQueue()[1]).toEqual({...target,awaitingExplicitSend:true});expect(useAppStore.getState().workbenchSaveWarning).toContain('storage owner unavailable')
})

it.each([undefined,null,{expectedRun:session.control.run,afterSubmissionId:null}])('archived condition %j never grants background or explicit input',async(condition)=>{
  const {promptCondition:_old,awaitingExplicitSend:_pause,...entry}=known('target')
  const target={...entry,...(condition===undefined?{}:{promptCondition:condition}),execution:'immediate' as const}
  useAppStore.setState({agentSteerQueues:{[sid]:[target]}})
  const submit=vi.spyOn(api.sessions,'submitPrompt').mockResolvedValue()
  vi.spyOn(api.sessions,'refresh').mockResolvedValue(session)
  await useAppStore.getState().archiveAgentSteer(sid,target.operationId,target.text,true)
  await useAppStore.getState().flushAgentSteerQueue(sid,target.operationId)
  await expect(useAppStore.getState().sendQueuedAgentSteer(sid,target.operationId)).rejects.toMatchObject({code:'CONTROL_REQUEST_CONFLICT'})
  expect(submit).not.toHaveBeenCalled();expect(getQueue()).toEqual([{...target,archived:true}])
  expect(()=>useAppStore.getState().editQueuedAgentSteer(sid,target.operationId,target.text,'replacement')).toThrow()
})

it('restores only the original record and waits for explicit Send, including unknown input',async()=>{
  const {promptCondition:_remove,...target}=known('unknown')
  useAppStore.setState({agentSteerQueues:{[sid]:[{...target,archived:true}]}})
  const submit=vi.spyOn(api.sessions,'submitPrompt').mockResolvedValue()
  const restored=await useAppStore.getState().archiveAgentSteer(sid,target.operationId,target.text,false)
  expect(restored).toEqual({changed:true,entry:{...target,awaitingExplicitSend:true}})
  await useAppStore.getState().flushAgentSteerQueue(sid)
  expect(submit).not.toHaveBeenCalled();expect(getQueue()).toEqual([target]);expect(agentSteerCanEdit(restored.entry)).toBe(false)
})

it('Restore adds an explicit pause to a previously automatic entry; an archived unknown head does not block a fresh chosen Send',async()=>{
  const {awaitingExplicitSend:_pause,...original}=known('automatic')
  const target={...original,execution:'immediate' as const}
  const {promptCondition:_unknown,...unknown}=known('unknown-head')
  useAppStore.setState({agentSteerQueues:{[sid]:[unknown,target,known('chosen')]}})
  await useAppStore.getState().archiveAgentSteer(sid,unknown.operationId,unknown.text,true)
  await useAppStore.getState().archiveAgentSteer(sid,target.operationId,target.text,true)
  await useAppStore.getState().archiveAgentSteer(sid,target.operationId,target.text,false)
  const submit=vi.spyOn(api.sessions,'submitPrompt').mockResolvedValue()
  vi.spyOn(api.sessions,'refresh').mockResolvedValue(session)
  await useAppStore.getState().flushAgentSteerQueue(sid)
  expect(submit).not.toHaveBeenCalled();expect(getQueue()[1]).toEqual({...target,awaitingExplicitSend:true})
  await useAppStore.getState().sendQueuedAgentSteer(sid,'chosen')
  expect(submit).toHaveBeenCalledTimes(1);expect(submit.mock.calls[0]!.slice(1,3)).toEqual([known('chosen').text,'chosen'])
  expect(getQueue()).toEqual([{...unknown,archived:true},{...target,awaitingExplicitSend:true}])
})

it.each(['preparing','submitting'] as const)('refuses archive and restore during actual %s without recalling input',async phase=>{
  const before=getQueue(),target=before[1]!
  useAppStore.setState({agentSteerInFlight:{[sid]:target.operationId},agentSteerInFlightPhase:{[sid]:phase}})
  for(const archived of [true,false]) await expect(useAppStore.getState().archiveAgentSteer(sid,target.operationId,target.text,archived)).rejects.toThrow('cannot recall Provider input')
  expect(getQueue()).toBe(before);expect(useAppStore.getState().agentSteerInFlight[sid]).toBe(target.operationId)
})

it('compares exact original text, SID and ID and keeps idempotent archive/restore decisions',async()=>{
  const before=getQueue(),target=before[1]!
  for(const [s,id,text] of [[sid,target.operationId,'stale'],['wrong-sid',target.operationId,target.text],[sid,'wrong-id',target.text]])
    await expect(useAppStore.getState().archiveAgentSteer(s!,id!,text!,true)).rejects.toThrow()
  expect(getQueue()).toBe(before)
  await useAppStore.getState().archiveAgentSteer(sid,target.operationId,target.text,true)
  const archived=getQueue();expect((await useAppStore.getState().archiveAgentSteer(sid,target.operationId,target.text,true)).changed).toBe(false)
  expect(getQueue()).toBe(archived)
  await useAppStore.getState().archiveAgentSteer(sid,target.operationId,target.text,false)
  expect((await useAppStore.getState().archiveAgentSteer(sid,target.operationId,target.text,false)).changed).toBe(false)
})

it('late confirmed original delivery preserves archive across actual reconciliation and persisted roundtrip; Restore refuses replay',async()=>{
  const target=known('confirmed-original');useAppStore.setState({agentSteerQueues:{[sid]:[target]}})
  await useAppStore.getState().archiveAgentSteer(sid,target.operationId,target.text,true)
  timeline(confirmed(target.operationId))
  expect(getQueue()).toEqual([{...target,archived:true}])
  const publicFacts = await useAppStore.getState().executeControl({schemaVersion:5,requestId:'confirmed-archive',operation:'message.pending.ls',agentSessionId:sid})
  expect(publicFacts).toMatchObject({messages:[{pendingId:target.operationId,text:target.text,archived:true,delivery:'confirmed',editable:false}]})
  if (publicFacts.operation !== 'message.pending.ls') throw new Error('Wrong original query result')
  expect(parsePendingMessage(publicFacts.messages[0])).toEqual(publicFacts.messages[0])
  const partialize=useAppStore.persist.getOptions().partialize!
  const persisted=JSON.parse(JSON.stringify(partialize(useAppStore.getState())))
  expect(persisted.agentSteerQueues[sid]).toEqual([{...target,archived:true}])
  const restored=restorePersistedUiState(composerConfig,persisted)
  useAppStore.setState(restored)
  const submit=vi.spyOn(api.sessions,'submitPrompt').mockResolvedValue()
  await useAppStore.getState().flushAgentSteerQueue(sid)
  expect(getQueue()).toEqual([{...target,archived:true}])
  await expect(useAppStore.getState().archiveAgentSteer(sid,target.operationId,target.text,false)).rejects.toThrow('Core confirmed this original input')
  expect(useAppStore.getState().timelines[sid]!.items).toEqual([confirmed(target.operationId)])
  expect(submit).not.toHaveBeenCalled()
})

it('Restore then confirmation returns a defined original business receipt and never auto-dispatches',async()=>{
  const target={...known('restore-race'),archived:true as const};useAppStore.setState({agentSteerQueues:{[sid]:[target]}})
  const submit=vi.spyOn(api.sessions,'submitPrompt').mockResolvedValue()
  const stop=useAppStore.subscribe((now,before)=>{if(before.agentSteerQueues[sid]?.[0]?.archived && !now.agentSteerQueues[sid]?.[0]?.archived) timeline(confirmed(target.operationId))})
  try {
    const result=await useAppStore.getState().executeControl({schemaVersion:5,requestId:'restore-race',operation:'message.pending.restore',agentSessionId:sid,pendingId:target.operationId,expectedText:target.text})
    expect(result).toMatchObject({changed:true,message:{pendingId:target.operationId,text:target.text,archived:false}})
    expect(useAppStore.getState().agentSteerQueues[sid]).toBeUndefined()
    expect(useAppStore.getState().timelines[sid]!.items).toEqual([confirmed(target.operationId)])
    expect(submit).not.toHaveBeenCalled()
  } finally {stop()}
})

it.each([{id:'wrong-id'},{agentSessionId:'other'},{status:'failed' as const},{kind:'assistant_message' as const}])('does not use foreign confirmation %j to refuse Restore',async overrides=>{
  const target={...known('exact'),archived:true as const};useAppStore.setState({agentSteerQueues:{[sid]:[target]}})
  if(overrides.agentSessionId) expect(()=>timeline(confirmed(target.operationId,overrides))).toThrow('another Agent Session')
  else timeline(confirmed(target.operationId,overrides))
  expect((await useAppStore.getState().archiveAgentSteer(sid,target.operationId,target.text,false)).changed).toBe(true)
  expect(getQueue()[0]!.awaitingExplicitSend).toBe(true)
})

it('moves active neighbors without moving or resurrecting an archived record',async()=>{
  const before=getQueue();await useAppStore.getState().archiveAgentSteer(sid,before[1]!.operationId,before[1]!.text,true)
  useAppStore.getState().moveAgentSteer(sid,before[2]!.operationId,'up')
  expect(getQueue()).toEqual([before[2],{...before[1],archived:true},before[0]])
  const now=getQueue();useAppStore.getState().moveAgentSteer(sid,before[1]!.operationId,'up');expect(getQueue()).toBe(now)
})

it('retained archives do not consume the original 100 active slots or disappear from strict public ls',async()=>{
  const archives=Array.from({length:100},(_,i)=>({...known(`archive-${i}`),archived:true as const}))
  useAppStore.setState({agentSteerQueues:{[sid]:archives}})
  const submit=vi.spyOn(api.sessions,'submitPrompt').mockResolvedValue()
  expect(useAppStore.getState().enqueueAgentSteer(sid,'New active intent',undefined,'new-active','manual')).toBe(true)
  const result=await useAppStore.getState().executeControl({schemaVersion:5,requestId:'all-original-records',operation:'message.pending.ls',agentSessionId:sid})
  expect(result.operation).toBe('message.pending.ls')
  const receipt=parseAgentMuxControlReceipt({schemaVersion:5,requestId:'all-original-records',ok:true,operation:'message.pending.ls',result:{agentSessionId:sid,messages:(result as Extract<typeof result,{operation:'message.pending.ls'}>).messages}})
  expect(receipt.ok).toBe(true);expect(getQueue().slice(0,100)).toEqual(archives);expect(getQueue()).toHaveLength(101)
  useAppStore.setState({agentSteerQueues:{[sid]:[...archives,...Array.from({length:100},(_,i)=>known(`active-${i}`))]}})
  const reject=vi.fn();expect(useAppStore.getState().enqueueAgentSteer(sid,'over active cap',reject)).toBe(false)
  expect(reject.mock.calls[0]![0].message).toContain('active message queue is full');expect(submit).not.toHaveBeenCalled()
  await expect(useAppStore.getState().archiveAgentSteer(sid,archives[0]!.operationId,archives[0]!.text,false)).rejects.toThrow('Archive another active message')
  expect(getQueue()[0]).toEqual(archives[0])
})

it('actual archive/restore CLI discovery is nonempty and keeps the original expected-text argument',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'am-archive-help-'))
  try {for(const operation of ['message.pending.archive','message.pending.restore'] as const) {
    const entries=AGENTMUX_CLI_COMMANDS.filter(entry=>entry.method===operation)
    expect(entries).toHaveLength(1);expect(AGENTMUX_RPC_CONTROL_METHODS[operation]).toBe(operation)
    const help=await runCompiledObjectCli(['message','pending',operation.split('.')[2]!, '--help'],objectCliEnvironment(dir))
    expect(help.code).toBe(0);expect(help.stderr).toBe('');expect(help.stdout).toContain('--expected-text');expect(help.stdout).toContain('--pending-id')
  }} finally {await rm(dir,{recursive:true})}
})

it('strict archive requests and results reject missing facts, wrong state and editable archive',()=>{
  const request={schemaVersion:5,requestId:'r',operation:'message.pending.archive',agentSessionId:sid,pendingId:'target',expectedText:'original'}
  expect(parseAgentMuxControlRequest(request)).toEqual(request)
  for(const changed of [{expectedText:undefined},{runId:'forged'},{text:'replacement'}]) expect(()=>parseAgentMuxControlRequest({...request,...changed})).toThrow()
  const message={pendingId:'target',text:'original',runId:session.control.run.runId,enqueuedAt:1,status:'queued',phase:null,editable:false,delivery:'unconfirmed',errorCode:null,error:null,archived:true}
  expect(parsePendingMessage(message)).toEqual(message)
  for(const changed of [{archived:undefined},{archived:'true'},{editable:true},{phase:'submitting'}]) expect(()=>parsePendingMessage({...message,...changed})).toThrow()
  const receipt={schemaVersion:5,requestId:'r',ok:true,operation:'message.pending.archive',result:{agentSessionId:sid,message,changed:true}}
  expect(parseAgentMuxControlReceipt(receipt)).toEqual(receipt)
  expect(()=>parseAgentMuxControlReceipt({...receipt,result:{...receipt.result,message:{...message,archived:false}}})).toThrow()
})

it('both archive and restore require the existing actual transport-approved user/device authority',async()=>{
  const target=getQueue()[1]!,before=getQueue(),service=new AgentMuxRpcService({execute:request=>useAppStore.getState().executeControl(request)})
  try {for(const method of ['message.pending.archive','message.pending.restore'] as const) {
    for(const context of [{},{principal:{kind:'agent',id:'managed'}},{principal:{kind:'user',id:''}},{principal:{kind:'device',id:'device'},caller:{agentSessionId:'managed',capability:'forged'}}])
      await expect(service.call(method,{agentSessionId:sid,pendingId:target.operationId,expectedText:target.text},context as never)).rejects.toMatchObject({code:'AGENT_CAPABILITY_INVALID'})
    expect(getQueue()).toBe(before)
  }} finally {await service.dispose()}
})

it('real Unix JSON-RPC and compiled public CLI archive/restore the same non-first original record without input',async()=>{
  const before=getQueue(),target=before[1]!,directory=await mkdtemp(join(tmpdir(),'amx-archive-'))
  const server=new AgentMuxControlServer({socketPath:join(directory,'control.sock'),execute:request=>useAppStore.getState().executeControl(request)})
  const submit=vi.spyOn(api.sessions,'submitPrompt').mockResolvedValue();await server.start()
  const client=await connectAgentMuxRpc({endpoint:{transport:'unix',path:server.path}})
  async function cli(action:string,args:string[]=[]) {const result=await runCompiledObjectCli(['--endpoint',`unix://${server.path}`,'message','pending',action,'--session',sid,...args],objectCliEnvironment(directory));expect(result.stderr).toBe('');expect(result.code).toBe(0);return JSON.parse(result.stdout).result}
  try {
    const archived=await cli('archive',['--pending-id',target.operationId,'--expected-text',target.text])
    expect(archived).toMatchObject({changed:true,message:{pendingId:target.operationId,text:target.text,archived:true,delivery:'not-submitted',editable:false}})
    const listed=await client.call('message.pending.ls',{agentSessionId:sid});expect(listed.messages.map(entry=>[entry.pendingId,entry.archived])).toEqual([['head',false],['second',true],['tail',false]])
    await expect(client.call('message.pending.send',{agentSessionId:sid,pendingId:target.operationId})).rejects.toMatchObject({code:'CONTROL_REQUEST_CONFLICT'})
    await expect(client.call('message.pending.restore',{agentSessionId:sid,pendingId:target.operationId,expectedText:'stale'})).rejects.toMatchObject({code:'CONTROL_REQUEST_CONFLICT'})
    const restored=await client.call('message.pending.restore',{agentSessionId:sid,pendingId:target.operationId,expectedText:target.text})
    expect(restored).toMatchObject({changed:true,message:{pendingId:target.operationId,archived:false,editable:true}})
    expect((await cli('ls')).messages[1]).toMatchObject({pendingId:target.operationId,archived:false,text:target.text})
    expect((await cli('restore',['--pending-id',target.operationId,'--expected-text',target.text])).changed).toBe(false)
    expect(getQueue()).toEqual(before);expect(submit).not.toHaveBeenCalled()
  } finally {await client.dispose();await server.stop();await rm(directory,{recursive:true})}
},20000)
