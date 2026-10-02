// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createWorkspaceLayout } from '@agentmux/layout'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { executionFocusPresentation } from '../src/renderer/src/lib/focus-tab-projection'
import { spatialCatalog } from '../src/renderer/src/lib/space-agent-control'
import { formatTabAddress } from '../src/renderer/src/lib/agent-address'
import { requestPmoTeamsTopicFloatingOpen, requestPmoTeamsTopicFloatingPreview, requestPmoTeamsTopicFloatingClose, readPmoTeamsTopicFloatingState, usePmoTeamsTopicFloatingState } from '../src/renderer/src/lib/pmo-teams-topic-floating'
import { SCRATCH_WORKSPACE_ID, PMO_TEAMS_TOPIC_ID } from '../src/shared/scratch-topics'
import { seedMoteWorkface, executionAgent, customAgent, customMoteId, quietMoteId, ordinaryTopicId, moteTopics, savedMoteKey } from './fixtures/mote-workface'
vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: () => null }))
vi.mock('../src/renderer/src/components/RecentFocusTimeline', () => ({ RecentFocusTimeline: () => null }))
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
const baseline = useAppStore.getState(), sourceId = 'exact-complete-tab', sourceRegion = 'exact-source-region'
const reference = { displayWorkspaceId: 'project', groupId: 'exact-project-group', tabId: sourceId, regionId: sourceRegion }
let root: Root, host: HTMLDivElement, launch: ReturnType<typeof vi.fn>
const button = (label: string) => host.querySelector<HTMLButtonElement>(`.focus-toolbar [aria-label="${label}"]`)!
const choice = () => button('Choose Chat Mote')
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
async function menu() {
 await act(async () => choice().dispatchEvent(new KeyboardEvent('keydown', { key:'ArrowDown', bubbles:true, cancelable:true })))
 await settle()
 expect(document.querySelector('[role="menu"] .focus-chat-mote-menu__item')).toBeTruthy()
}
async function select(id: string) {
 await menu(); const item=document.querySelector<HTMLElement>(`[data-chat-mote-id="${id}"]`)!; expect(item).toBeTruthy()
 await act(async () => item.click()); await settle()
}
const discussions = () => Object.values(useAppStore.getState().tabs).filter(tab => tab.id.startsWith('launcher:'))
async function mount() {
 host=document.createElement('div');document.body.append(host);root=createRoot(host)
 const state=useAppStore.getState()
 const presentation=executionFocusPresentation(state.agentFocus.execution,state.tabs,spatialCatalog(state,moteTopics), () => {})
 await act(async () => root.render(<GlobalFocusSurface presentation={presentation} regionOnly />))
 await settle()
}
async function unmount() { await act(async () => root.unmount());host.remove();document.getElementById('agentmux-window-overlay-host')?.remove() }
beforeEach(() => {
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);localStorage.clear();useAppStore.setState(baseline,true);seedMoteWorkface()
 const state=useAppStore.getState(), source=createWorkbenchTab(sourceId,{kind:'agent',phase:'attached',workspaceId:'project',regionId:sourceRegion,sessionId:executionAgent.id},'Inspect this complete Tab')
 const custom={...customAgent,executorId:'analyst'}
 launch=vi.fn(async()=>{})
 const topics=moteTopics.map(topic=>topic.id===quietMoteId?{...topic,moteArchive:{state:'archived' as const,version:'archive-v1'}}:topic)
 useAppStore.setState({config:{...state.config!,executors:{...state.config!.executors,analyst:{...state.config!.executors.fixture!,label:'Analyst exact executor'}}},
 sessions:state.sessions.map(session=>session.id===custom.id?custom:session),tabs:{...state.tabs,[source.id]:source},
 layouts:{...state.layouts,project:createWorkspaceLayout(reference.groupId,[source.id])},mainSurface:'agents',
 agentFocus:{...state.agentFocus,execution:{sessionId:executionAgent.id,history:[],reference}},launchAgent:launch,
 scratchTopicSnapshots:{...state.scratchTopicSnapshots,[SCRATCH_WORKSPACE_ID]:{...state.scratchTopicSnapshots[SCRATCH_WORKSPACE_ID]!,topics}},
 agentComposerDrafts:{...state.agentComposerDrafts,[sourceRegion]:'Exact source unsent'}})
 vi.spyOn(api.scratch,'ensureMote').mockImplementation(async(_workspace,id)=>topics.find(topic=>topic.id===id)!)
 vi.spyOn(api.scratch,'listTopics').mockResolvedValue(topics)
})
afterEach(async()=>{if(root)await unmount();localStorage.clear();vi.restoreAllMocks();useAppStore.setState(baseline,true)})
it('selects a real Mote with no navigation, send, launch, identity, draft or floating retarget side effects',async()=>{
 await mount();const before=useAppStore.getState(),floating=readPmoTeamsTopicFloatingState(),open=vi.spyOn(before,'openScratchTopic')
 await select(customMoteId)
 expect(choice().dataset.focusChatTopic).toBe(customMoteId)
 expect(JSON.parse(localStorage.getItem(savedMoteKey)!)).toMatchObject({focusChatTopicId:customMoteId})
 for(const key of ['open','preview','targetTopicId','targetTabId'] as const)expect(readPmoTeamsTopicFloatingState()![key]).toBe(floating![key])
 const after=useAppStore.getState()
 for(const key of ['tabs','layouts','sessions','agentFocus','agentComposerDrafts','activeWorkspaceId','mainSurface'] as const)expect(after[key]).toBe(before[key])
 expect(open).not.toHaveBeenCalled();expect(api.scratch.ensureMote).not.toHaveBeenCalled();expect(launch).not.toHaveBeenCalled()
})
it('remounts the original floating owner from durable exact choice without copying a preference',async()=>{
 await mount();await select(customMoteId);await unmount();expect(readPmoTeamsTopicFloatingState()).toBeNull()
 await mount();expect(choice().dataset.focusChatTopic).toBe(customMoteId)
})
it('keeps archived Motes marked/selectable and ordinary Topics absent',async()=>{
 await mount();await menu()
 expect(document.querySelector(`[data-chat-mote-id="${quietMoteId}"]`)?.textContent).toContain('Archived')
 expect(document.querySelector(`[data-chat-mote-id="${ordinaryTopicId}"]`)).toBeNull()
 await act(async()=>document.querySelector<HTMLElement>(`[data-chat-mote-id="${quietMoteId}"]`)!.click())
 expect(choice().dataset.focusChatTopic).toBe(quietMoteId);expect(api.scratch.ensureMote).not.toHaveBeenCalled()
})
it('uses the old dynamic floating recipient only before an explicit choice and captures its exact executor',async()=>{
 await mount();await act(async()=>requestPmoTeamsTopicFloatingOpen({targetTopicId:customMoteId,targetTabId:'custom-tab'}))
 expect(choice().dataset.focusChatTopic).toBe(customMoteId)
 await act(async()=>button('Chat about this tab with Mote').click());await settle()
 expect(api.scratch.ensureMote).toHaveBeenCalledExactlyOnceWith(SCRATCH_WORKSPACE_ID,customMoteId)
 expect(launch).toHaveBeenCalledWith('analyst',expect.stringContaining(formatTabAddress(sourceId)),'mote-group',expect.anything(),undefined,undefined,undefined)
})
it('sends an explicit recipient through its own Tab/executor instead of the different floating target',async()=>{
 await mount();await select(customMoteId)
 await act(async()=>requestPmoTeamsTopicFloatingOpen({targetTopicId:PMO_TEAMS_TOPIC_ID,targetTabId:'default-tab'}))
 const before=useAppStore.getState();await act(async()=>button('Chat about this tab with Mote').click());await settle()
 expect(api.scratch.ensureMote).toHaveBeenCalledExactlyOnceWith(SCRATCH_WORKSPACE_ID,customMoteId)
 expect(launch).toHaveBeenCalledWith('analyst',expect.stringContaining(formatTabAddress(sourceId)),'mote-group',expect.anything(),undefined,undefined,undefined)
 expect(useAppStore.getState().tabs[sourceId]).toBe(before.tabs[sourceId]);expect(useAppStore.getState().sessions).toBe(before.sessions)
 for(const [id,draft]of Object.entries(before.agentComposerDrafts))expect(useAppStore.getState().agentComposerDrafts[id]).toBe(draft)
})
it.each(['missing','read-error','ordinary'] as const)('keeps %s selected identity and only refuses that unconfirmed send',async(kind)=>{
 const id=kind==='missing'?'launcher:removed':kind==='ordinary'?ordinaryTopicId:customMoteId
 localStorage.setItem(savedMoteKey,JSON.stringify({open:false,focusChatTopicId:id}))
 if(kind==='read-error'){const state=useAppStore.getState();useAppStore.setState({scratchTopicSnapshots:{...state.scratchTopicSnapshots,[SCRATCH_WORKSPACE_ID]:{...state.scratchTopicSnapshots[SCRATCH_WORKSPACE_ID]!,topics:moteTopics.map(topic=>topic.id===id?{...topic,readError:'Filesystem identity unreadable'}:topic)}}})}
 await mount();expect(choice().dataset.focusChatTopic).toBe(id);expect(choice().textContent).toContain('Unconfirmed Mote')
 const before=useAppStore.getState();await act(async()=>button('Chat about this tab with Mote').click())
 expect(api.scratch.ensureMote).not.toHaveBeenCalled();expect(discussions()).toHaveLength(0);expect(useAppStore.getState().tabs).toBe(before.tabs)
 expect(useAppStore.getState().error).toContain('identity is unconfirmed')
 await select(PMO_TEAMS_TOPIC_ID);expect(choice().dataset.focusChatTopic).toBe(PMO_TEAMS_TOPIC_ID)
})
it.each(['throw','malformed','empty','invalid-id'] as const)('keeps %s preference reads unknown through incidental size persistence and recovers by explicit selection',async(kind)=>{
 if(kind==='malformed')localStorage.setItem(savedMoteKey,'{broken')
 if(kind==='empty')localStorage.setItem(savedMoteKey,'')
 if(kind==='invalid-id')localStorage.setItem(savedMoteKey,JSON.stringify({focusChatTopicId:123}))
 let restoreGet=()=>{}
 if(kind==='throw'){const get=vi.spyOn(window.localStorage,'getItem').mockImplementation(()=>{throw new Error('storage unreadable')});restoreGet=()=>get.mockRestore()}
 await mount();restoreGet();expect(choice().textContent).toContain('Unconfirmed Mote')
 await act(async()=>button('Chat about this tab with Mote').click());expect(api.scratch.ensureMote).not.toHaveBeenCalled()
 let update!:ReturnType<typeof usePmoTeamsTopicFloatingState>[1]
 function SizeOwner(){const [,set]=usePmoTeamsTopicFloatingState();update=set;return null}
 const slot=document.createElement('div'),sizeRoot=createRoot(slot);await act(async()=>sizeRoot.render(createElement(SizeOwner)))
 await act(async()=>update({size:{width:610,height:400}}));await act(async()=>sizeRoot.unmount())
 expect(JSON.parse(localStorage.getItem(savedMoteKey)!)).toMatchObject({focusChatTopicId:null,size:{width:610,height:400}})
 await unmount();await mount();expect(choice().textContent).toContain('Unconfirmed Mote')
 await select(customMoteId);expect(choice().dataset.focusChatTopic).toBe(customMoteId)
})

it('isolates a damaged Chat field while restoring the original pinned floating identity and dimensions',async()=>{
 localStorage.setItem(savedMoteKey,JSON.stringify({open:true,targetTopicId:customMoteId,targetTabId:'custom-tab',railMode:'avatars',size:{width:610,height:400},focusChatTopicId:123}))
 await mount();expect(readPmoTeamsTopicFloatingState()).toMatchObject({open:true,targetTopicId:customMoteId,targetTabId:'custom-tab',railMode:'avatars',size:{width:610,height:400},focusChatTopicId:null})
 expect(choice().textContent).toContain('Unconfirmed Mote');expect(choice().title).not.toContain('null')
 await act(async()=>button('Chat about this tab with Mote').click());expect(api.scratch.ensureMote).not.toHaveBeenCalled()
 await select(PMO_TEAMS_TOPIC_ID);expect(readPmoTeamsTopicFloatingState()).toMatchObject({open:true,targetTopicId:customMoteId,targetTabId:'custom-tab',size:{width:610,height:400},focusChatTopicId:PMO_TEAMS_TOPIC_ID})
})
it('retains a known failed save, avoids hover writes and retries the same selected ID',async()=>{
 await mount();const set=vi.spyOn(window.localStorage,'setItem').mockImplementation(()=>{throw new Error('storage full')})
 await select(customMoteId);expect(choice().dataset.focusChatTopic).toBe(customMoteId);expect(choice().title).toContain('could not be saved')
 set.mockRestore();const retry=vi.spyOn(window.localStorage,'setItem')
 await act(async()=>requestPmoTeamsTopicFloatingPreview());expect(retry).not.toHaveBeenCalled()
 await menu();expect(document.querySelector('.focus-chat-mote-menu [role="status"]')?.textContent).toContain('could not be saved');expect(retry).not.toHaveBeenCalled()
 await act(async()=>document.querySelector<HTMLElement>(`[data-chat-mote-id="${customMoteId}"]`)!.click());await settle()
 expect(retry).toHaveBeenCalledExactlyOnceWith(savedMoteKey,expect.any(String));expect(choice().title).not.toContain('could not be saved')
 expect(JSON.parse(localStorage.getItem(savedMoteKey)!)).toMatchObject({focusChatTopicId:customMoteId});expect(api.scratch.ensureMote).not.toHaveBeenCalled()
})
it('keeps Primary Chat healthy when directory observation is unavailable',async()=>{
 await mount();await act(async()=>useAppStore.setState({scratchTopicSnapshots:{}}))
 expect(choice().dataset.focusChatTopic).toBe(PMO_TEAMS_TOPIC_ID);expect(choice().textContent).not.toContain('Unconfirmed')
 await act(async()=>button('Chat about this tab with Mote').click());await settle()
 expect(api.scratch.ensureMote).toHaveBeenCalledExactlyOnceWith(SCRATCH_WORKSPACE_ID,PMO_TEAMS_TOPIC_ID)
})
it('allows next-choice changes while pending but never retargets or duplicates the captured request or steals late focus',async()=>{
 let release!:(value:typeof moteTopics[number])=>void
 vi.mocked(api.scratch.ensureMote).mockImplementation(()=>new Promise(resolve=>{release=resolve}))
 await mount();await select(customMoteId)
 await act(async()=>{button('Chat about this tab with Mote').click();button('Chat about this tab with Mote').click()})
 expect(button('Chat about this tab with Mote').disabled).toBe(true);expect(choice().disabled).toBe(false)
 await select(PMO_TEAMS_TOPIC_ID);expect(choice().dataset.focusChatTopic).toBe(PMO_TEAMS_TOPIC_ID)
 const later=document.createElement('input');document.body.append(later)
 await act(async()=>{requestPmoTeamsTopicFloatingClose({restoreFocus:false});useAppStore.setState({mainSurface:'board'});later.focus()})
 await act(async()=>release(moteTopics.find(topic=>topic.id===customMoteId)!));await settle()
 expect(api.scratch.ensureMote).toHaveBeenCalledExactlyOnceWith(SCRATCH_WORKSPACE_ID,customMoteId);expect(discussions()).toHaveLength(1)
 expect(launch).toHaveBeenCalledWith('analyst',expect.stringContaining(formatTabAddress(sourceId)),'mote-group',expect.anything(),undefined,undefined,undefined)
 expect(document.activeElement).toBe(later);expect(useAppStore.getState().mainSurface).toBe('board');later.remove()
})
it('returns Escape to the exact chooser without overriding a later independent focus',async()=>{
 await mount();choice().focus();await menu();const content=document.querySelector<HTMLElement>('[role="menu"]')!
 await act(async()=>content.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})));await settle()
 expect(document.activeElement).toBe(choice())
 await menu();const later=document.createElement('input');document.body.append(later)
 await act(async()=>{document.querySelector<HTMLElement>('[role="menu"]')!.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));later.focus()});await settle()
 expect(document.activeElement).toBe(later);later.remove()
})
it('200 unrelated output revisions neither reread directory/history nor rebuild mounted menu identities/Run controls',async()=>{
 await mount();await menu();const items=[...document.querySelectorAll('[data-chat-mote-id]')],before=useAppStore.getState(),controls=before.sessions.map(session=>session.control)
 const reads=vi.mocked(api.scratch.listTopics).mock.calls.length,history=vi.spyOn(api.sessions,'historyPage')
 for(let index=0;index<200;index++)await act(async()=>useAppStore.setState(state=>({sessions:state.sessions.map(session=>session.id==='ordinary-agent'?{...session,latestOutputBytes:index+1}:session)})))
 expect(api.scratch.listTopics).toHaveBeenCalledTimes(reads);expect(history).not.toHaveBeenCalled()
 expect([...document.querySelectorAll('[data-chat-mote-id]')]).toHaveLength(items.length);for(const [index,item]of [...document.querySelectorAll('[data-chat-mote-id]')].entries())expect(item).toBe(items[index])
 expect(useAppStore.getState().sessions.map(session=>session.control)).toEqual(controls);expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
})
