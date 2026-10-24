import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentMuxAgentSession, AgentSessionHistoryPage } from '@agentmux/core'
import { AgentMuxMemoryAgentSessionStore } from '@agentmux/core'
import { RuntimeController } from '../src/main/runtime-controller'
import type { SessionSnapshot, AgentSessionControl, AppConfig } from '../src/shared/contracts'
import { nativeBindingKey, projectNativeSourceFacts } from '../src/shared/agent-native-source'
import { reduceRuntimeEvent, runtimeDiagnosticNotice, type SessionProjectionState } from '../src/renderer/src/lib/session-state'
import { AgentRegionHeader } from '../src/renderer/src/components/AgentRegionHeader'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
const control: AgentSessionControl = { kind: 'agent', hostId: 'local', agentSessionId: 'same-session', run: { runId: 'same-run' } }
const old = { kind: 'provider' as const, providerId: 'codex' as const, sessionId: 'original-native', transcriptPath: _hygiene_fixturePath("private/old.jsonl") }
const candidate = { ...old, sessionId: 'candidate-native', transcriptPath: _hygiene_fixturePath("private/new.jsonl") }
const observation = { state: 'changed' as const, run: control.run, observedAt: 100, reason: 'Unique current main native record differs.' }
const confirmation = { operationId: 'confirmed-operation', run: control.run, previousNativeHandle: old, nativeHandle: candidate, observedAt: 200, candidateObservedAt: 100 }
function session(extra = {}): Extract<SessionSnapshot, {kind:'agent'}> { return { id: control.agentSessionId, kind:'agent', providerId:'codex', executorId:'private', hostId:'local', workspacePath:_hygiene_fixturePath("private"), label:'Private Agent', createdAt:1, updatedAt:50, agentSessionUpdatedAt:50, capabilities:{}, nativeHandle:old, nativeSessionId:old.sessionId, control, processState:'running', latestOutputBytes:0, status:{state:'running',source:'run-process',observedAt:1}, ...extra } as any }
function core(extra = {}): AgentMuxAgentSession { return { kind:'agent', agentSessionId:control.agentSessionId, providerId:'codex', executorId:'private', hostId:'local', workspacePath:_hygiene_fixturePath("private"), run:control.run, retiredRuns:[], createdAt:1, updatedAt:101, nativeHandle:old, ...extra } as any }
function project(before: ReturnType<typeof session>, incoming: AgentMuxAgentSession) { return reduceRuntimeEvent({ sessions:[before],timelines:{} } as SessionProjectionState, { type:'core',hostId:'local',event:{ type:'agent-session', session:incoming } }).sessions[0] as ReturnType<typeof session> }
const page = (id = old.sessionId, cursor: string | null = 'original-cursor'): AgentSessionHistoryPage => ({ agentSessionId:control.agentSessionId, source:{providerId:'codex',nativeSessionId:id}, items:[{id:`${id}-item`,kind:'user-message',contentParts:[{kind:'text',text:`History ${id}`}]}],nextCursor:cursor })
const initialStore=useAppStore.getState()
let root:Root, host:HTMLDivElement
beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true; host=document.createElement('div');document.body.append(host);root=createRoot(host); useAppStore.setState({...initialStore,sessions:[session()],timelines:{},refreshSession:vi.fn().mockResolvedValue(session())},true); vi.spyOn(api.sessions,'historyPage').mockImplementation(async()=>page()); vi.spyOn(api.sessions,'observeHistory').mockImplementation(async()=>({source:page((useAppStore.getState().sessions[0] as any).nativeHandle.sessionId).source,dispose:vi.fn()}) as any) })
afterEach(async()=>{await act(async()=>root.unmount());host.remove();useAppStore.setState(initialStore,true);vi.restoreAllMocks()})
async function render(element: any) { await act(async()=>root.render(element)) }
async function click(text:string) { const element=[...document.querySelectorAll<HTMLElement>('[role=menuitem],button')].find(one=>one.textContent?.trim()===text);expect(element,`Missing ${text}`).toBeTruthy();await act(async()=>element!.click()) }
async function menu(value: ReturnType<typeof session>,readOnly=false,openDetails=true) { await render(createElement(AgentRegionHeader,{name:'Private Agent',executorLabel:'Private',sessionId:value.id,sessionKind:'agent',executionHost:{label:'This Mac',id:'local',kind:'local',cwd:_hygiene_fixturePath("private"),configured:true},regionId:'original-region',readOnly,onHistory:undefined,nativeSession:value}));const trigger=document.querySelector<HTMLButtonElement>('.agent-region-header__more')!;await act(async()=>{trigger.focus();trigger.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}))}); if(!openDetails)return; const details=[...document.querySelectorAll<HTMLElement>('[role=menuitem]')].find(node=>node.textContent?.trim()==='Session details')!; expect(details).toBeTruthy(); await act(async()=>{details.focus();details.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))}) }
async function closeMenu() {
 const trigger=document.querySelector<HTMLButtonElement>('.agent-region-header__more')!
 await act(async()=>document.querySelector('[data-menu-entry=more]')!.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})))
 // Radix restores the original trigger in its deferred unmount focus event.
 await act(async()=>{await vi.waitFor(()=>expect(document.activeElement).toBe(trigger))})
 expect(document.querySelector('[role=menu]')).toBeNull()
}
it('mirrors exact changed/unknown facts and clears candidate and confirmation on authoritative removal',()=>{
 const changed=project(session(),core({observedNativeHandle:candidate,nativeSourceObservation:observation}));expect(changed.observedNativeHandle).toEqual(candidate);expect(changed.nativeSourceObservation).toEqual(observation)
 const unknown=project(changed,core({updatedAt:102,nativeSourceObservation:{...observation,state:'unknown'}}));expect(unknown.nativeSourceObservation?.state).toBe('unknown');expect(unknown.observedNativeHandle).toBeUndefined();expect(unknown.nativeHandle).toEqual(old)
 const quiet=project(unknown,core({updatedAt:103}));expect(quiet.nativeSourceObservation).toBeUndefined();expect(quiet.nativeHandle).toEqual(old)
 expect(projectNativeSourceFacts(core({nativeConfirmation:confirmation})).nativeConfirmation).toEqual(confirmation)
})
it('accepts same-Run confirmed source with cleared semantic revision, preserves disconnected and rejects stale authority',()=>{
 const previous=session({semanticStatus:{state:'waiting',source:'native-hook',observedAt:40,currentActivityRevision:19},status:{state:'waiting',source:'native-hook',observedAt:40}})
 const incoming=core({nativeHandle:candidate,nativeConfirmation:confirmation,updatedAt:200})
 const next=project(previous,incoming);expect(next.nativeHandle).toEqual(candidate);expect(next.nativeConfirmation).toEqual(confirmation);expect(next.semanticStatus).toBeUndefined();expect(next.status.state).toBe('running');expect(next.control).toEqual(control)
 expect(project({...previous,status:{state:'disconnected',source:'run-process',observedAt:45}},incoming).status.state).toBe('disconnected')
 expect(project(next,core({updatedAt:199}))).toBe(next)
 expect(project(previous,core({semanticStatus:{state:'done',source:'native-hook',observedAt:100,currentActivityRevision:1}}))).toBe(previous)
 expect(nativeBindingKey(session({nativeHandle:old,nativeConfirmation:{...confirmation,operationId:'second'}}))).not.toBe(nativeBindingKey(previous))
})
it('routes only exact persisted native observations to the Region service window, retaining other diagnostics',()=>{
 const diagnostic=(code:string,run=control.run)=>({type:'core' as const,hostId:'local',event:{type:'agent-error' as const,agentSessionId:control.agentSessionId,code,message:'Original diagnostic',evidence:{source:'agentmux' as const,run,observedAt:101}}})
 for(const state of ['changed','unknown','ambiguous'] as const)for(const code of ['AGENT_NATIVE_SOURCE_UNCONFIRMED','AGENT_NATIVE_IDENTITY_UNCONFIRMED'])expect(runtimeDiagnosticNotice({sessions:[session({nativeSourceObservation:{...observation,state}})]},diagnostic(code))).toBeNull()
 expect(runtimeDiagnosticNotice({sessions:[session()]},diagnostic('AGENT_NATIVE_SOURCE_UNCONFIRMED'))?.message).toContain('Original diagnostic')
 expect(runtimeDiagnosticNotice({sessions:[session({nativeSourceObservation:{...observation,run:{runId:'old-run'}}})]},diagnostic('AGENT_NATIVE_SOURCE_UNCONFIRMED'))?.message).toContain('Original diagnostic')
 for(const code of ['PRIVATE_ACK_LOST','AGENT_NATIVE_IDENTITY_PERSIST_FAILED'])expect(runtimeDiagnosticNotice({sessions:[session({nativeSourceObservation:observation})]},diagnostic(code))?.message).toContain('Original diagnostic')
})
it('shows a corner label and exact two-step confirmation; cancellation writes nothing',async()=>{
 const confirm=vi.spyOn(api.sessions,'confirmNativeSession').mockResolvedValue({session:core({nativeHandle:candidate}),confirmation,persisted:true,current:true})
 await menu(session({observedNativeHandle:candidate,nativeSourceObservation:observation}));expect(document.querySelector('[data-native-source-marker]')?.textContent).toBe('Source changed');expect(confirm).not.toHaveBeenCalled();await click('Review source change…');expect(document.querySelector('[data-native-source-review]')?.textContent).toContain(old.sessionId);expect(document.querySelector('[data-native-source-review]')?.textContent).toContain(candidate.sessionId);await click('Cancel source change');expect(confirm).not.toHaveBeenCalled();await click('Review source change…');await click('Confirm this native source');expect(confirm).toHaveBeenCalledOnce();expect(confirm.mock.calls[0]?.[0]).toEqual(control);expect(confirm.mock.calls[0]?.[1]).toMatchObject({agentSessionId:control.agentSessionId,expectedRun:control.run,expectedNativeHandle:old,candidateNativeHandle:candidate,expectedObservationAt:100});expect(confirm.mock.calls[0]?.[1].operationId).toBeTruthy()
})
it('unknown cannot invent a candidate and rechecks the true source even if history reading fails',async()=>{
 vi.mocked(api.sessions.historyPage).mockRejectedValueOnce(new Error('Reader unavailable after discovery'))
 await menu(session({nativeSourceObservation:{...observation,state:'unknown'}}),false,false);expect(document.querySelector('[data-native-source-check]')?.closest('[role=menu]')?.classList.contains('agent-region-menu')).toBe(true);expect(document.querySelector('[data-native-source-marker]')?.textContent).toBe('Source unknown');expect(document.body.textContent).not.toContain('Review source change…');await click('Check native source');expect(api.sessions.historyPage).toHaveBeenCalledWith(control,{refreshNativeSource:true,limit:1});expect(useAppStore.getState().refreshSession).toHaveBeenCalledWith(control.agentSessionId);expect(document.body.textContent).toContain('Reader unavailable after discovery')
})
it.each([undefined,old])('offers real discovery without guessing a changed source for %j',async handle=>{ await menu(session({nativeHandle:handle}),false,false);expect(document.querySelector('[data-native-source-marker]')).toBeNull();expect(document.body.textContent).toContain('Check native source');await click('Check native source');expect(api.sessions.historyPage).toHaveBeenCalledWith(control,{refreshNativeSource:true,limit:1}) })
it('keeps a stale reviewed payload exact and reports Core CAS refusal without adopting it',async()=>{
 const confirm=vi.spyOn(api.sessions,'confirmNativeSession').mockRejectedValue(new Error('Observation changed; review the current candidate'))
 await menu(session({observedNativeHandle:candidate,nativeSourceObservation:observation}));await click('Review source change…');await render(createElement(AgentRegionHeader,{name:'Private Agent',executorLabel:'Private',sessionId:control.agentSessionId,sessionKind:'agent',executionHost:{label:'This Mac',id:'local',kind:'local',cwd:_hygiene_fixturePath("private"),configured:true},regionId:'original-region',readOnly:false,onHistory:undefined,nativeSession:session({observedNativeHandle:{...candidate,sessionId:'newer-candidate'},nativeSourceObservation:{...observation,observedAt:101}})}));await click('Confirm this native source');expect(confirm.mock.calls[0]?.[1].candidateNativeHandle).toEqual(candidate);expect(document.body.textContent).toContain('Observation changed');expect(useAppStore.getState().sessions.find(value=>value.kind==='agent')?.nativeHandle).toEqual(old)
})
it('retains a reviewed operation and uncertain confirmation when the menu closes, then retries the same identity',async()=>{
 const confirm=vi.spyOn(api.sessions,'confirmNativeSession').mockRejectedValueOnce(new Error('Confirmation receipt unavailable')).mockResolvedValueOnce({session:core({nativeHandle:candidate}),confirmation,persisted:true,current:true})
 const source=session({observedNativeHandle:candidate,nativeSourceObservation:observation})
 await menu(source);await click('Review source change…');await click('Confirm this native source')
 const first=confirm.mock.calls[0]?.[1]
 expect(document.body.textContent).toContain('Confirmation receipt unavailable')
 await closeMenu()
 await menu(source)
 expect(document.body.textContent).toContain('Confirmation receipt unavailable')
 expect(document.querySelector('[data-native-source-review]')?.textContent).toContain(candidate.sessionId)
 await click('Confirm this native source');expect(confirm.mock.calls[1]?.[1]).toEqual(first)
})
it('reports a historical repeat without claiming the current binding was changed',async()=>{
 vi.spyOn(api.sessions,'confirmNativeSession').mockResolvedValue({session:core({nativeHandle:{...candidate,sessionId:'today'}}),confirmation,persisted:true,current:false});await menu(session({observedNativeHandle:candidate,nativeSourceObservation:observation}));await click('Review source change…');await click('Confirm this native source');expect(document.body.textContent).toContain('earlier confirmation is retained');expect(document.body.textContent).not.toContain('Conversation target confirmed.')
})
async function mainOwner(){
 const controller=new RuntimeController(new AgentMuxMemoryAgentSessionStore(),async()=>{throw new Error('Unexpected host creation')})
 const client={connect:vi.fn().mockResolvedValue(undefined),sessionHistorySources:vi.fn().mockResolvedValue([{agentSessionId:control.agentSessionId,history:{providerId:'codex',executorId:'private',workspacePath:_hygiene_fixturePath("private")}}]),sessionHistoryPage:vi.fn().mockResolvedValue(page()),confirmAgentNativeSession:vi.fn().mockResolvedValue({session:core(),confirmation,persisted:true,current:false})}
 ;(controller as any).hosts.set('local',{client,config:{id:'local',kind:'local',label:'Private'},historyObservationDisposers:new Set()})
 const config:AppConfig={...await api.config.get(),executors:{private:{label:'Private',injectAgentMuxGuide:false,providerId:'codex',command:_hygiene_fixturePath("trusted/native"),args:['--trusted'],env:{PRIVATE:'trusted'}}}}
 return{controller,client,config}
}
it('Main forwards only page/source options with its trusted executor and never connects a Run to read',async()=>{
 const f=await mainOwner();await f.controller.sessionHistoryPage(control,{refreshNativeSource:true,limit:1,commandOverride:_hygiene_fixturePath("evil"),env:{SECRET:'evil'}} as any,f.config);expect(f.client.sessionHistoryPage).toHaveBeenLastCalledWith(control.agentSessionId,{refreshNativeSource:true,limit:1,commandOverride:_hygiene_fixturePath("trusted/native"),args:['--trusted'],env:{PRIVATE:'trusted'}});await f.controller.sessionHistoryPage(control,{nativeSource:'previous',cursor:'old-source-cursor'},f.config);expect(f.client.sessionHistoryPage).toHaveBeenLastCalledWith(control.agentSessionId,{nativeSource:'previous',cursor:'old-source-cursor',commandOverride:_hygiene_fixturePath("trusted/native"),args:['--trusted'],env:{PRIVATE:'trusted'}});expect(f.client.connect).not.toHaveBeenCalled()
})
it('Main confirms only the exact Session/Run and preserves Core current:false receipt semantics',async()=>{
 const f=await mainOwner(),input={agentSessionId:control.agentSessionId,expectedRun:control.run,expectedNativeHandle:old,candidateNativeHandle:candidate,expectedObservationAt:100,operationId:'manual-exact'}
 await expect(f.controller.confirmNativeSession(control,input)).resolves.toMatchObject({current:false,persisted:true});expect(f.client.confirmAgentNativeSession).toHaveBeenCalledExactlyOnceWith(input);await expect(f.controller.confirmNativeSession({...control,agentSessionId:'foreign'},input)).rejects.toThrow('exact Session');await expect(f.controller.confirmNativeSession({...control,run:{runId:'foreign'}},input)).rejects.toThrow('exact Session');expect(f.client.confirmAgentNativeSession).toHaveBeenCalledOnce()
})

const ambiguous = { ...observation, state: 'ambiguous' as const, reason: 'Verified Run members; frontend selection is not reported.', candidates: [old, candidate] }
const selectedBinding = { source: 'user-selected' as const, run: control.run, observedAt: 200 }
it('keeps keyboard focus in the same menu across candidate review, cancellation and confirmation', async () => {
 const confirm=vi.spyOn(api.sessions,'confirmNativeSession').mockResolvedValue({session:core({nativeHandle:candidate}),confirmation,persisted:true,current:true})
 await menu(session({nativeSourceObservation:ambiguous}))
 const item=(label:string)=>[...document.querySelectorAll<HTMLElement>('[role=menuitem]')].find(node=>node.textContent?.trim()===label)!
 const details=item('Choose target: '+candidate.sessionId).closest<HTMLElement>('[role=menu]')!
 expect(details).not.toBeNull()
 expect(item('Check native source').closest('[role=menu]')).not.toBe(details)
 const activate=async(label:string)=>{const row=item(label);expect(row).toBeTruthy();await act(async()=>{row.focus();row.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))})}
 await activate('Choose target: '+candidate.sessionId)
 expect(document.activeElement).toBe(details)
 await act(async()=>details.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true})))
 await act(async()=>{await vi.waitFor(()=>expect(document.activeElement).toBe(item('Confirm this native source')))})
 await activate('Cancel source change')
 expect(document.activeElement).toBe(details)
 expect(confirm).not.toHaveBeenCalled()
 await activate('Choose target: '+candidate.sessionId)
 await activate('Confirm this native source')
 expect(document.activeElement).toBe(details)
 expect(confirm).toHaveBeenCalledOnce()
 await closeMenu()
})
it('projects the selected target independently of an unknown frontend and clears it only on authoritative removal', () => {
 const source = core({nativeBinding:selectedBinding,nativeHandle:candidate,nativeSourceObservation:ambiguous})
 const projected = project(session(),source)
 expect(projectNativeSourceFacts(source).nativeBinding).toEqual(selectedBinding)
 expect(projected.nativeBinding).toEqual(selectedBinding)
 expect(projected.nativeSourceObservation).toEqual(ambiguous)
 expect(projected.control).toEqual(control)
 expect(project(projected,core({updatedAt:202})).nativeBinding).toBeUndefined()
})
it('offers each verified Run member including the retained target, and cancellation sends nothing', async () => {
 const confirm=vi.spyOn(api.sessions,'confirmNativeSession').mockResolvedValue({session:core({nativeBinding:selectedBinding}),confirmation:{...confirmation,nativeHandle:old,basis:'run-main-candidate'},persisted:true,current:true})
 await menu(session({nativeSourceObservation:ambiguous}))
 expect(document.body.textContent).toContain('Choose target: '+old.sessionId)
 expect(document.body.textContent).toContain('Choose target: '+candidate.sessionId)
 await click('Choose target: '+candidate.sessionId)
 expect(document.querySelector('[data-native-source-review]')?.textContent).toContain('Confirm conversation target?')
 expect(document.querySelector('[data-native-source-review]')?.textContent).toContain(candidate.sessionId)
 await click('Cancel source change');expect(confirm).not.toHaveBeenCalled()
 await click('Choose target: '+old.sessionId);await click('Confirm this native source')
 expect(confirm).toHaveBeenCalledOnce()
 expect(confirm.mock.calls[0]?.[1]).toMatchObject({expectedNativeHandle:old,candidateNativeHandle:old,expectedRun:control.run,expectedObservationAt:ambiguous.observedAt,operationId:expect.any(String)})
})
it('keeps the chosen Run member and frozen original operation across new candidates and an uncertain receipt', async () => {
 const confirm=vi.spyOn(api.sessions,'confirmNativeSession').mockRejectedValueOnce(new Error('Receipt unavailable; preserve the original operation')).mockResolvedValueOnce({session:core({nativeHandle:candidate,nativeBinding:selectedBinding}),confirmation,persisted:true,current:true})
 await menu(session({nativeSourceObservation:ambiguous}))
 await click('Choose target: '+candidate.sessionId);await click('Confirm this native source')
 const original=confirm.mock.calls[0]?.[1]
 expect(original).toMatchObject({expectedNativeHandle:old,candidateNativeHandle:candidate,expectedObservationAt:ambiguous.observedAt,operationId:expect.any(String)})
 await closeMenu()
 await menu(session({nativeSourceObservation:{...ambiguous,observedAt:101,candidates:[old,{...candidate,sessionId:'another-main'}]}}))
 expect(document.querySelector('[data-native-source-review]')?.textContent).toContain(candidate.sessionId)
 await click('Confirm this native source')
 expect(confirm.mock.calls[1]?.[1]).toEqual(original)
})
it('shows the explicitly selected target while retaining the frontend unknown explanation and the ability to choose back', async () => {
 await menu(session({nativeHandle:candidate,nativeBinding:selectedBinding,nativeSourceObservation:ambiguous}))
 expect(document.querySelector('[data-native-source-marker]')?.textContent).toBe('Target selected')
 expect(document.body.textContent).toContain('Terminal selection is not reported.')
 expect(document.body.textContent).toContain('Choose target: '+old.sessionId)
 expect(document.body.textContent).not.toContain('retained source is pending confirmation')
 expect(document.querySelector('.agent-region-header')?.getAttribute('data-agent-session-id')).toBe(control.agentSessionId)
})

it.each(['old-run','read-only'] as const)('does not offer target adoption outside the original editable Region: %s', async reason => {
 const confirm=vi.spyOn(api.sessions,'confirmNativeSession')
 await menu(session({nativeSourceObservation:reason==='old-run'?{...ambiguous,run:{runId:'another-run'}}:ambiguous}),reason==='read-only')
 expect(document.body.textContent).not.toContain('Choose target:')
 expect(document.body.textContent).not.toContain('Confirm this native source')
 expect(confirm).not.toHaveBeenCalled()
})
