// @vitest-environment happy-dom
import { act } from 'react'
import { mkdtemp, rm, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer, connectAgentMuxRpc } from '../../../packages/core/src/control-host'
import { createMoteApp, settleMoteApp, type MoteAppFixture } from './fixtures/mote-app'
import { defaultAgent, defaultTab, neighborAgent, neighborTab, ordinaryTab, scratchWorkspace } from './fixtures/mote-workface'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { formatGoalAddress } from '@agentmux/core/sharing'
import { parseAgentMuxControlRequest } from '@agentmux/core'
import { originalTopicAddress } from '../src/shared/space-addresses'
import { moteTopics } from './fixtures/mote-workface'
import { DEFAULT_AGENT_CONTINUITY_POLICY } from '@agentmux/core/agent-session-recovery'

let app:MoteAppFixture|undefined
afterEach(async()=>{await app?.dispose();app=undefined})

it.each(['mote','ordinary'] as const)('current SDK and complete App focus a known %s without waiting for unrelated directory discovery',async kind=>{
  app=createMoteApp()
  const original=useAppStore.getState()
  vi.spyOn(api.moteDialogue,'read').mockImplementation(async({target})=>({main:{target,identity:{hostId:'local',moteId:moteTopics[0]!.id},status:'ready',resource:null,documentRevision:'original-file',roleRevision:'original-role',current:{hostId:'local',sessionId:defaultAgent.id,displayWorkspaceId:scratchWorkspace.id,groupId:'mote-group',tabId:defaultTab.id,regionId:defaultTab.layout.activeRegionId},issue:null},links:[],incarnation:'original-focus-links',throughSequence:0,next:null,coverage:'linked-sources-only',sourceStatus:'read',sourceIssue:null}))
  useAppStore.setState({viewModes:{[defaultAgent.id]:'activity',[ordinaryTab.regions[ordinaryTab.layout.activeRegionId]!.sessionId]:'activity'},sessions:original.sessions.map(item=>item.id===defaultAgent.id?{...defaultAgent,processState:'exited',continuity:{operationId:'original-no-native',agentSessionId:defaultAgent.id,previousRun:defaultAgent.control.run,trigger:'manual',policy:{...DEFAULT_AGENT_CONTINUITY_POLICY},admittedAt:1,observedAt:1,rechecks:0,kind:'unavailable',reason:'native-handle-unavailable',evidence:{kind:'run-ended',state:'exited',observedAt:1}}}:item)})
  await app.mount();await settleMoteApp()
  const editor=document.createElement('textarea');editor.value='Original authored input';document.body.append(editor);editor.focus();editor.setSelectionRange(4,12)
  const before=useAppStore.getState(),tab=kind==='mote'?defaultTab:ordinaryTab,regionId=tab.layout.activeRegionId
  let release!:()=>void
  const held=new Promise<[]>((resolve)=>{release=()=>resolve([])})
  const directory=vi.mocked(api.scratch.listTopics).mockImplementation(()=>held)
  directory.mockClear()
  const lifecycle=[vi.spyOn(api.sessions,'resume'),vi.spyOn(api.spatial,'openAgent'),vi.spyOn(api.moteDialogue,'advanceSetup'),vi.spyOn(api.sessions,'submitPrompt')]
  const root=await mkdtemp(join(tmpdir(),'agentmux-focus-owner-')),executions:string[]=[]
  const server=new AgentMuxControlServer({socketPath:join(root,'control.sock'),coreClients:()=>[],execute:async request=>{
    executions.push(request.operation)
    let result!:ReturnType<typeof before.executeControl>
    await act(async()=>{result=useAppStore.getState().executeControl(request);await Promise.resolve()})
    return await result
  }})
  await server.start();const rpc=await connectAgentMuxRpc({endpoint:{transport:'unix',path:server.path}})
  let request:Promise<unknown>|undefined
  try{
    request=rpc.call('app.focus',{target:{kind:'space',displayWorkspaceId:scratchWorkspace.id,groupId:'mote-group',tabId:tab.id,regionId},inputPolicy:'preserve',expectedAgentSessionId:tab.regions[regionId]!.sessionId,expectedAgentHostId:'local'})
    await vi.waitFor(()=>expect(executions).toEqual(['focus']))
    expect(directory).not.toHaveBeenCalled()
    await expect(request).resolves.toMatchObject({input:{policy:'preserve'}})
    const result=await request as any
    expect(result.navigation.state).not.toBe('rejected')
    expect(result.navigation.selection.space).toMatchObject({tabId:tab.id,regionId,groupId:'mote-group'})
    await settleMoteApp()
    expect(app.container.querySelector('[data-activity-session="'+(kind==='mote'?defaultAgent.id:tab.regions[regionId]!.sessionId)+'"]')).not.toBeNull()
    expect(document.activeElement).toBe(editor);expect(editor.value).toBe('Original authored input');expect([editor.selectionStart,editor.selectionEnd]).toEqual([4,12])
    expect(useAppStore.getState().agentComposerDrafts).toEqual(before.agentComposerDrafts)
    expect(useAppStore.getState().sessions.find(item=>item.id===defaultAgent.id)?.processState).toBe('exited')
    for(const spy of lifecycle)expect(spy).not.toHaveBeenCalled()
    expect(useAppStore.getState().tabs).toEqual(before.tabs)
  }finally{editor.remove();release();await request?.catch(()=>{});await rpc.dispose();await server.stop();await rm(root,{recursive:true,force:true});await expect(access(root)).rejects.toMatchObject({code:'ENOENT'})}
})


it.each(['missing','mismatched'] as const)('an unobserved target is not admitted from %s Topic observations',async condition=>{
  app=createMoteApp();await app.mount();await settleMoteApp()
  const before=useAppStore.getState(),ghost={id:'view:unobserved',title:'Unobserved resource',summary:'',collaborators:[],directoryPath:scratchWorkspace.path+'/unobserved',identityDirectoryPath:scratchWorkspace.path+'/unobserved',topicPath:scratchWorkspace.path+'/unobserved/topic.md'}
  const target=originalTopicAddress(scratchWorkspace,ghost,{})!
  useAppStore.setState({scratchTopicSnapshots:condition==='missing'?{}:{[scratchWorkspace.id]:{scope:JSON.stringify(['different-host',scratchWorkspace.path]),revision:1,topics:[ghost],error:null,reading:false}}})
  const read=vi.mocked(api.scratch.listTopics).mockRejectedValue(new Error('Directory discovery is independent'));read.mockClear()
  let result:any;await act(async()=>{result=await useAppStore.getState().executeControl(parseAgentMuxControlRequest({schemaVersion:5,requestId:'unobserved-focus',operation:'focus',target:{kind:'space',spaceId:target.spaceId},inputPolicy:'preserve'}))})
  expect(result.navigation.state).toBe('rejected');expect(result.issues.length).toBeGreaterThan(0)
  expect(useAppStore.getState().workbenchSpaceSelection).toBe(before.workbenchSpaceSelection);expect(useAppStore.getState().tabs).toBe(before.tabs);expect(read).not.toHaveBeenCalled()
})

it.each(['wrong-host','wrong-session','cancelled'] as const)('exact original focus retains work for %s',async variant=>{
  app=createMoteApp();await app.mount();await settleMoteApp();const before=useAppStore.getState(),signal=new AbortController()
  if(variant==='cancelled')signal.abort()
  const request=parseAgentMuxControlRequest({schemaVersion:5,requestId:'guarded-focus',operation:'focus',target:{kind:'space',displayWorkspaceId:scratchWorkspace.id,groupId:'mote-group',tabId:neighborTab.id,regionId:neighborTab.layout.activeRegionId},inputPolicy:'preserve',expectedAgentSessionId:variant==='wrong-session'?'another-session':neighborAgent.id,expectedAgentHostId:variant==='wrong-host'?'another-host':'local'})
  if(variant==='cancelled')await expect(before.executeControl(request,signal.signal)).rejects.toMatchObject({code:'CONTROL_CANCELLED'})
  else{let result:any;await act(async()=>{result=await before.executeControl(request)});expect(result.navigation.state).toBe('rejected');expect(result.issues.map((x:any)=>x.code)).toContain('AGENT_LOCATION_CHANGED')}
  expect(useAppStore.getState().workbenchSpaceSelection).toBe(before.workbenchSpaceSelection);expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
})

it.each(['later-selection','leave-and-return'] as const)('a necessary original Goal read cannot overwrite %s',async variant=>{
  app=createMoteApp();await app.mount();await settleMoteApp();const before=useAppStore.getState()
  let release!:(value:any)=>void;const read=vi.spyOn(api.goals,'execute').mockImplementationOnce(()=>new Promise(resolve=>{release=resolve}))
  let pending!:ReturnType<typeof before.executeControl>
  await act(async()=>{pending=before.executeControl(parseAgentMuxControlRequest({schemaVersion:5,requestId:'original-goal-read',operation:'focus',target:{kind:'goal',goalId:'original-goal',runtimeId:'original-runtime',namespace:'private'},inputPolicy:'preserve'}));await Promise.resolve()})
  expect(read).toHaveBeenCalledOnce()
  await act(async()=>{useAppStore.setState({mainSurface:'agents'});if(variant==='leave-and-return')useAppStore.setState({mainSurface:before.mainSurface})})
  const later=useAppStore.getState()
  await act(async()=>release({operation:'demand.show',demand:originalGoal}))
  const result=await pending
  expect(result.operation).toBe('focus');if(result.operation!=='focus')return
  expect(result.navigation.state).toBe('rejected');expect(result.issues.map(x=>x.code)).toContain('NAVIGATION_CHANGED')
  expect(useAppStore.getState().mainSurface).toBe(later.mainSurface);expect(useAppStore.getState().tabs).toBe(before.tabs);expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
})

const originalGoal={id:'original-goal',title:'Original Goal',description:'',status:'in_progress',priority:'normal',executorId:null,projectId:null,projectName:null,sessionIds:[],assigneeSessionIds:[],supervisorSessionId:null,participations:[],createdAt:1,updatedAt:1,activities:[],decisions:[],tags:[],plannedStartAt:null,targetAt:null,parentDemandId:null,address:{runtimeId:'original-runtime',namespace:'private',uri:formatGoalAddress('original-goal','original-runtime','private')}}

it('cancellation while an original Goal source is pending never selects it when the valid reply arrives',async()=>{
  app=createMoteApp();await app.mount();await settleMoteApp();const before=useAppStore.getState(),signal=new AbortController()
  let release!:(value:any)=>void;vi.spyOn(api.goals,'execute').mockImplementationOnce(()=>new Promise(resolve=>{release=resolve}))
  let pending!:ReturnType<typeof before.executeControl>
  await act(async()=>{pending=before.executeControl(parseAgentMuxControlRequest({schemaVersion:5,requestId:'cancelled-source',operation:'focus',target:{kind:'goal',goalId:'original-goal',runtimeId:'original-runtime',namespace:'private'},inputPolicy:'preserve'}),signal.signal);await Promise.resolve()})
  await act(async()=>{signal.abort();release({operation:'demand.show',demand:originalGoal})})
  const result=await pending;expect(result.operation).toBe('focus');if(result.operation!=='focus')return
  expect(result.navigation.state).toBe('rejected');expect(result.issues.map(x=>x.code)).toContain('CONTROL_CANCELLED')
  expect(useAppStore.getState().mainSurface).toBe(before.mainSurface);expect(useAppStore.getState().workbenchSpaceSelection).toBe(before.workbenchSpaceSelection)
})
