// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createMoteApp, moteClick, moteType, settleMoteApp, type MoteAppFixture } from './fixtures/mote-app'
import { defaultAgent, defaultTab, moteTopics, scratchWorkspace, neighborAgent } from './fixtures/mote-workface'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { promptCarrierWaiting } from './helpers/prompt-carrier-receipt'
import { requestPmoTeamsTopicFloatingOpen } from '../src/renderer/src/lib/pmo-teams-topic-floating'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'
import type { MoteDialoguePage } from '@agentmux/core/mote-dialogue'
import { MoteQuickModeDialog } from '../src/renderer/src/components/MoteQuickMode'
import { effectiveMoteQuickSave, type MoteQuickDefaults } from '@agentmux/core/mote-preferences'
const send=useAppStore.getState().send,enqueue=useAppStore.getState().enqueueAgentSteer
let app:MoteAppFixture
const reference={hostId:'local',sessionId:defaultAgent.id,displayWorkspaceId:scratchWorkspace.id,groupId:'mote-group',tabId:defaultTab.id,regionId:defaultTab.layout.activeRegionId}
const page=(target: any, current=reference):MoteDialoguePage=>({main:{target,identity:{hostId:'local',moteId:moteTopics[0]!.id},status:'ready',resource:null,documentRevision:'original-file',roleRevision:'original-role-A',current,issue:null},links:[],incarnation:'original-links',throughSequence:0,next:null,coverage:'linked-sources-only',sourceStatus:'read',sourceIssue:null})
beforeEach(()=>{app=createMoteApp();useAppStore.setState({send,enqueueAgentSteer:enqueue});vi.spyOn(api.files,'readDirectory').mockResolvedValue([]);vi.spyOn(api.continuousProgress,'pauseForInput').mockResolvedValue(undefined)})
afterEach(async()=>{await app.dispose()})
const button=(root:ParentNode,label:string)=>[...root.querySelectorAll<HTMLButtonElement>('button')].find(x=>x.getAttribute('aria-label')===label||x.textContent?.trim()===label)!
it('the real main Composer freezes the original logical role in the persisted queue and actual submission',async()=>{
 const topics=moteTopics.map((t,i)=>i? t:{...t,quickMode:{status:'saved' as const,version:'original-file',defaults:{conversation:reference}}})
 useAppStore.setState({scratchTopicSnapshots:{[scratchWorkspace.id]:{scope:scratchTopicsScope(scratchWorkspace),topics,revision:0,error:null,reading:false}}})
 vi.mocked(api.scratch.listTopics).mockResolvedValue(topics);vi.mocked(api.scratch.readTopic).mockImplementation(async(_w,id)=>topics.find(x=>x.id===id)??null)
 const read=vi.spyOn(api.moteDialogue,'read').mockImplementation(async input=>page(input.target))
 vi.spyOn(api.sessions,'inspectInput').mockResolvedValue(null)
 const submit=vi.spyOn(api.sessions,'submitPrompt').mockImplementation(async(control,_body,id)=>promptCarrierWaiting(control.agentSessionId,control.run.runId,id))
 await app.mount();await act(async()=>requestPmoTeamsTopicFloatingOpen({targetTabId:defaultTab.id,reference}));await settleMoteApp()
 await vi.waitFor(()=>expect(read).toHaveBeenCalled())
 await moteType(app.panel().querySelector('[aria-label="Message Agent"]')!,'保留已确认目标并继续')
 await moteClick(button(app.panel(),'Send'));await vi.waitFor(()=>expect(submit).toHaveBeenCalledTimes(1))
 expect(submit.mock.calls[0]![4]).toMatchObject({moteMain:{target:read.mock.calls[0]![0].target,expectedRoleRevision:'original-role-A'}})
 const original=useAppStore.persist.getOptions().partialize!(useAppStore.getState()).agentSteerQueues![defaultAgent.id]![0]!
 expect(original.moteMain).toEqual(submit.mock.calls[0]![4]!.moteMain)
 expect(original.inputReceipt?.key.agentSessionId).toBe(defaultAgent.id)
 expect(app.launch).not.toHaveBeenCalled();expect(app.stop).not.toHaveBeenCalled()
})
it('a later role cannot rewrite or retarget an existing original operation',()=>{
 const target={spaceId:'original-space',zoneId:'original-zone',expectedResource:{hostId:'local',workspaceId:scratchWorkspace.id,workspacePath:scratchWorkspace.path}}
 const reject=vi.fn(),moteMain={target,expectedRoleRevision:'original-role-A'}
 expect(enqueue(defaultAgent.id,'原输入',reject,'original-main-operation','manual',undefined,{moteMain})).toBe(true)
 expect(enqueue(defaultAgent.id,'原输入',reject,'original-main-operation','manual',undefined,{moteMain:{...moteMain,expectedRoleRevision:'new-role-B'}})).toBe(false)
 expect(useAppStore.getState().agentSteerQueues[defaultAgent.id]![0]!.moteMain).toEqual(moteMain)
 expect(reject).toHaveBeenCalledTimes(1)
})
async function settings(defaults:MoteQuickDefaults={},status:'paused'|'disabled'|'unconfirmed'='paused',schedule:any=null){
 const topic=moteTopics[0]!,scope={topic,workspace:scratchWorkspace,rootPath:topic.directoryPath.slice(scratchWorkspace.path.length+1)}
 const source=(target:any)=>({resource:{...target.expectedResource,zoneId:target.zoneId,zonePath:topic.directoryPath,path:scope.rootPath+'/MOTE.md'},result:{status:'read' as const,document:{path:scope.rootPath+'/MOTE.md',content:'# Original settings',revision:'sha256:'+'b'.repeat(64)}}})
 vi.spyOn(api.motePreferences,'read').mockImplementation(async input=>({...input,status:'ready',source:source(input.target),defaults,choices:{executors:[],conversations:[],destinations:[]},main:true,issue:null,maintenance:{status,schedule,issue:status==='unconfirmed'?'原安排尚未确认':null}} as any))
 const save=vi.spyOn(api.motePreferences,'save').mockImplementation(async(input:any)=>({kind:'quick',target:input.target,operationId:input.operationId,status:'saved',source:{resource:source(input.target).resource,document:source(input.target).result.document,defaults:effectiveMoteQuickSave(input)},message:null}))
 await app.mount(<MoteQuickModeDialog scope={scope} onOpenPath={async()=>{}} onClose={()=>{}} returnFocus={()=>null}/>);await vi.waitFor(()=>expect(document.querySelector<HTMLInputElement>('[aria-label="Heartbeat interval (minutes)"]')?.value).toBe(String((defaults.presence?.intervalMs??1800000)/60000)))
 return {save}
}
async function minutes(value:string){const input=document.querySelector<HTMLInputElement>('[aria-label="Heartbeat interval (minutes)"]')!;await act(async()=>{const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!;setter.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}))})}
it('actual Desktop settings default to 30 minutes, save an edited interval and keep the paused schedule visible',async()=>{
 const f=await settings();expect(document.body.textContent).toContain('Original heartbeat paused')
 await minutes('7');await moteClick(button(document,'Save'));await vi.waitFor(()=>expect(f.save).toHaveBeenCalledTimes(1))
 expect(f.save.mock.calls[0]![0]).toMatchObject({values:{presence:{enabled:true,intervalMs:420000}}})
 expect(document.body.textContent).not.toContain('Last delivery confirmed'); await vi.waitFor(()=>expect(document.body.textContent).not.toContain('unconfirmed. Keep this request'))
})
it('the actual paused-heartbeat button freezes one original resume and only inspects an unknown reply',async()=>{
 const schedule={loopId:'original-paused-heartbeat',hostId:'execution-host',agentSessionId:defaultAgent.id,providerId:'fixture',workspacePath:scratchWorkspace.path,intervalMs:1800000,everyMs:1800000,prompt:'original heartbeat',nextCheckAt:1800000,status:'paused',revision:6}
 await settings({conversation:reference},'paused',schedule)
 const resume=vi.spyOn(api.schedule,'resume').mockRejectedValue(new Error('原恢复回执丢失'))
 const inspect=vi.spyOn(api.schedule,'inspect').mockResolvedValue({schedule:{...schedule,status:'active'},executionScope:'connected-host'} as any)
 await moteClick(button(document,'Resume saved heartbeat'));await vi.waitFor(()=>expect(button(document,'Inspect original resume')).toBeDefined())
 const original=resume.mock.calls[0]![0];expect(original).toMatchObject({scheduleId:schedule.loopId,expectedRevision:6});expect(resume.mock.calls[0]![1]).toBe('local')
 await moteClick(button(document,'Inspect original resume'));expect(resume).toHaveBeenCalledTimes(1);expect(inspect).toHaveBeenCalledExactlyOnceWith({operationId:original.operationId},'local')
 expect(document.body.textContent).toContain('Automatic heartbeat scheduled')
})
it('invalid interval cannot silently save the previous value and unknown maintenance keeps original healthy input',async()=>{
 const f=await settings({presence:{enabled:false,intervalMs:900000}},'unconfirmed')
 await minutes('0');await moteClick(button(document,'Save'));expect(f.save).not.toHaveBeenCalled()
 expect(document.body.textContent).toContain('at least 1');expect(document.body.textContent).toContain('Actual schedule unconfirmed')
 expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toBe('Default unsent')
 expect(app.stop).not.toHaveBeenCalled()
})

vi.mock('electron', () => ({ app: { getAppMetrics: () => [] }, nativeImage: {} }))
import { RuntimeController } from '../src/main/runtime-controller'
it('the real Runtime sends a logical main through its original Host owner with an intact captured packet',async()=>{
 const target={spaceId:'original-space',zoneId:'original-zone',expectedResource:{hostId:'resource-host',workspaceId:'original-workspace',workspacePath:scratchWorkspace.path}}
 const receipt=promptCarrierWaiting(defaultAgent.id,defaultAgent.control.run.runId,'original-runtime-operation')
 const callOriginalCore=vi.fn(async()=>({route:{},record:null,input:receipt}))
 const runtime=Object.assign(Object.create(RuntimeController.prototype),{trackHostOperation:async(_host:string,fn:()=>unknown)=>await fn(),callOriginalCore,connectedClient:vi.fn(()=>{throw Error('logical-main bypass')})})
 const packet={captureId:'original-capture',capability:'opaque-original-proof'} as any
 const result=await runtime.submitPrompt(defaultAgent.control,'原浏览器输入','original-runtime-operation',{expectedRun:defaultAgent.control.run,admissionIntent:{kind:'manual-actor'}},undefined,{execution:'immediate',moteMain:{target,expectedRoleRevision:'original-role'}},true,'原冻结页面上下文','message-tool',packet)
 expect(result).toBe(receipt)
 expect(callOriginalCore).toHaveBeenCalledWith('resource-host','space.mote.dialogue.input.submit',expect.objectContaining({target,expectedRoleRevision:'original-role',input:expect.objectContaining({agentSessionId:defaultAgent.id,expectedRun:defaultAgent.control.run,capturedContext:{reference:packet,agentMuxNote:'原冻结页面上下文'}})}),{transport:'unix'})
 expect(runtime.connectedClient).not.toHaveBeenCalled()
})
it('the real Runtime cannot turn a missing main input receipt into successful send',async()=>{
 const target={spaceId:'original-space',zoneId:'original-zone',expectedResource:{hostId:'local',workspaceId:scratchWorkspace.id,workspacePath:scratchWorkspace.path}}
 const runtime=Object.assign(Object.create(RuntimeController.prototype),{trackHostOperation:async(_host:string,fn:()=>unknown)=>await fn(),callOriginalCore:vi.fn(async()=>({route:{},record:null,input:null}))})
 await expect(runtime.submitPrompt(defaultAgent.control,'原未知输入','original-unknown-operation',{expectedRun:defaultAgent.control.run,admissionIntent:{kind:'manual-actor'}},undefined,{execution:'immediate',moteMain:{target,expectedRoleRevision:'original-role'}},true)).rejects.toMatchObject({code:'MOTE_MAIN_INPUT_UNCONFIRMED'})
 expect(runtime.callOriginalCore).toHaveBeenCalledTimes(1)
})

import { useMoteDialogue } from '@agentmux/client-ui/use-mote-dialogue'
it('a retained hidden reader consumes the same original main observation as its visible presentation',async()=>{
 const target={spaceId:'shared-original-space',zoneId:'shared-original-zone',expectedResource:{hostId:'local',workspaceId:scratchWorkspace.id,workspacePath:scratchWorkspace.path}}
 const read=vi.fn(async()=>page(target))
 function Consumer({visible,slot}:{visible:boolean;slot:string}){const view=useMoteDialogue(read,target,visible);return <output data-dialogue-reader={slot}>{view.page?.main.roleRevision??'unread'}</output>}
 await app.mount(<><Consumer visible slot="visible"/><Consumer visible={false} slot="retained"/></>)
 await vi.waitFor(()=>expect(app.container.querySelector('[data-dialogue-reader="retained"]')?.textContent).toBe('original-role-A'))
 expect(read).toHaveBeenCalledTimes(1)
})

import { DEFAULT_AGENT_CONTINUITY_POLICY } from '@agentmux/core/agent-session-recovery'
import { composeAgentPrompt } from '@agentmux/core/agent-outbound-message'
it.each([false,true])('the original main recovery accepts Host-owned guidance while a mismatched body remains unknown (%s)',async(wrongBody)=>{
 const old={...defaultAgent,processState:'exited' as const},fresh={...defaultAgent,control:{...defaultAgent.control,run:{runId:'original-main-resumed'}}}
 useAppStore.setState({sessions:[old,neighborAgent]})
 const target={spaceId:'original-main-recovery',zoneId:'original-home',expectedResource:{hostId:'local',workspaceId:scratchWorkspace.id,workspacePath:scratchWorkspace.path}},moteMain={target,expectedRoleRevision:'original-main-role'}
 const submit=vi.spyOn(api.sessions,'submitPrompt')
 const recover=vi.spyOn(api.sessions,'recover').mockImplementation(async(_control,_cwd,id,request)=>{
   const input={...request!.input!,agentMuxNote:'Host guidance from its current version',...(wrongBody?{prompt:'Different original body'}:{})}
   const operation={operationId:id!,agentSessionId:old.id,trigger:'input',policy:{...DEFAULT_AGENT_CONTINUITY_POLICY},previousRun:old.control.run,newRun:fresh.control.run,admittedAt:1,observedAt:2,rechecks:0,kind:'resumed',reason:'explicit-request',evidence:{kind:'run-ended',state:'exited',observedAt:1},
    launchInput:{input,prompt:composeAgentPrompt(input.prompt,input.agentMuxNote).text,digest:'original-core-digest',message:{userContent:input.prompt,authorHuman:true,sourceChannel:'message-tool'},delivery:'launch',lifecycleOperationId:'original-launch',state:'launch-carried',key:{kind:'prompt',agentSessionId:old.id,expectedRun:fresh.control.run,submissionId:input.submissionId},receipt:{kind:'runtime-launch',operationId:'original-launch',run:fresh.control.run,observedAt:2}}}
   return{kind:'resumed',session:{...fresh,continuity:operation,continuityOperations:{[id!]:operation}}} as any
 })
 expect(send(old.id,'Original explicit main input',undefined,'manual',undefined,{execution:'immediate',moteMain})).toBe(true)
 await vi.waitFor(()=>{const entry=useAppStore.getState().agentSteerQueues[old.id]?.[0];expect(wrongBody?entry?.awaitingExplicitSend:entry?.resumeInputReceipt?.state).toBe(wrongBody?true:'launch-carried')})
 const entry=useAppStore.getState().agentSteerQueues[old.id]![0]!
 expect(recover.mock.calls[0]![3]?.moteMain).toEqual(moteMain);expect(entry.moteMain).toEqual(moteMain);expect(recover).toHaveBeenCalledTimes(1);expect(submit).not.toHaveBeenCalled()
 if(wrongBody){expect(entry.resumeInputReceipt).toBeUndefined();expect(entry.archived).not.toBe(true)}else expect(entry.archived).toBe(true)
})
