// @vitest-environment happy-dom
import {act} from 'react'
import {afterEach, beforeEach, expect, it, vi} from 'vitest'
import {GoalAgentPicker} from '../src/renderer/src/components/GoalAgentPicker'
import {useAppStore} from '../src/renderer/src/store'
import {api} from '../src/renderer/src/lib/api'
import {workspaceProjectId} from '../src/renderer/src/lib/workspace-projects'
import {goalCreationDraftKey} from '../src/renderer/src/lib/goal-agent-selection'
import type {DemandRecord} from '../src/renderer/src/lib/global-demand-board'
import {parseSpaceControlRequest} from '../../../packages/core/src/space-control-parser'
import {composerConfig, composerDOM, composerSession} from './helpers/composer-dom-fixture'
import {chooseField} from './helpers/selection-field'
const dom=composerDOM(), save=vi.fn(), close=vi.fn()
const local=composerConfig.workspaces[0]!, remote={id:'server',kind:'ssh' as const,label:'This Mac',hostname:'controlled.invalid'}, project={id:'remote-project',hostId:'server',name:'Project',path:'/original/remote-project',kind:'folder' as const}
const goal:DemandRecord={id:'original-goal',title:'Original Goal',description:'Keep the original request',status:'in_progress',priority:'normal',projectId:workspaceProjectId(local),projectName:'Project',sessionIds:[],assigneeSessionIds:[],supervisorSessionId:null,createdAt:1,updatedAt:1}
let dispose:(()=>void)|undefined
beforeEach(async()=>{
 window.localStorage.removeItem('agentmux-workbench-v1')
 dispose=await useAppStore.getState().initialize()
 close.mockClear();save.mockReset().mockResolvedValue(false)
 useAppStore.setState({config:{...composerConfig,hosts:[...composerConfig.hosts,remote],workspaces:[local,project]},goalAgentCreationDrafts:{},goalAgentSelectionDrafts:{},agentComposerDrafts:{original:'Retain @relative/file and the unsent task'}})
 vi.spyOn(api.executors,'discover').mockImplementation(async hostId=>({routeHostId:hostId,runtimeId:'runtime-'+hostId,executors:[{executorId:'codex',providerId:'codex',label:'Owned configuration '+hostId,command:'/target/'+hostId+'/codex',source:'registered',configRevision:'revision-'+hostId,availability:'available'},{executorId:'remote-only',providerId:'codex',label:'Remote-only configuration',command:'/target/'+hostId+'/only',source:'registered',configRevision:'only-'+hostId,availability:'available'}]}))
 vi.spyOn(api.hosts,'home').mockImplementation(async host=>({routeHostId:host.id,homeDirectory:host.id==='local'?local.path:project.path}))
})
afterEach(()=>{dispose?.();dispose=undefined})
const picker=()=>dom.render(<GoalAgentPicker demand={goal} role="assignees" onSave={save} onClose={close}/>)
const surface=()=>document.querySelector<HTMLElement>('.goal-agent-picker')!
async function button(text:string){const found=[...surface().querySelectorAll<HTMLButtonElement>('button')].filter(n=>n.textContent?.trim()===text);expect(found).toHaveLength(1);await act(async()=>found[0]!.click())}
async function field(label:string,value:string){await chooseField(surface().querySelector<HTMLElement>(`[aria-label="${label}"]`)!,value)}
async function prepare(mode:string){await button('New Agent');await act(async()=>surface().querySelector<HTMLInputElement>(`input[type=radio][value="${mode}"]`)!.click());await field('Project for this arrangement',mode==='remote-project'||mode==='remote-workspace'?project.id:local.id);if(mode==='remote-agent')await field('Agent runs on',remote.id)}

it.each(['local','remote-project','remote-agent','remote-workspace'])('Goal picker work modes: %s prepares the exact public request while the original relationship owner retains it',async mode=>{
 const control=vi.spyOn(useAppStore.getState(),'executeControl').mockRejectedValue(new Error('Original creation acknowledgement unknown'))
 const launch=vi.spyOn(api.sessions,'launchAgent'),before=useAppStore.getState().agentComposerDrafts
 await picker();await prepare(mode)
 expect(control).not.toHaveBeenCalled();expect(api.hosts.home).not.toHaveBeenCalled();expect(save).not.toHaveBeenCalled()
 await button('Prepare locations');await field('New Session Agent configuration','codex');expect(control).not.toHaveBeenCalled();await button('Create Agent');await vi.waitFor(()=>expect(control).toHaveBeenCalledOnce())
 const request=control.mock.calls[0]![0],retained=useAppStore.getState().goalAgentCreationDrafts[goalCreationDraftKey(goal.id,'assignees')]!
 expect(parseSpaceControlRequest(request)).toEqual(request)
 const resource=mode==='remote-project'||mode==='remote-workspace'?project:local,agent=mode==='remote-agent'?project:mode==='remote-project'?local:resource
 expect(request).toMatchObject({operation:'agent.open',focus:false,content:{kind:'new-agent',executorId:'codex',executionWorkspaceId:agent.id},destination:{spaceId:workspaceProjectId(resource),newTab:true}})
 if(mode==='remote-project'||mode==='remote-agent')expect(request).toHaveProperty('content.toolWorkspaceId',resource.id)
 else expect(request).not.toHaveProperty('content.toolWorkspaceId')
 expect(request).not.toHaveProperty('content.prompt');expect(request).not.toHaveProperty('moteMain')
 expect(retained).toMatchObject({phase:'may-have-dispatched',request});expect(retained.operationId).toBe(request.requestId)
 expect(useAppStore.getState().agentComposerDrafts).toBe(before);expect(save).not.toHaveBeenCalled();expect(launch).not.toHaveBeenCalled()
})
it('Goal picker work modes: an unknown original creation is only inspected after remount, never prepared or dispatched again',async()=>{
 const control=vi.spyOn(useAppStore.getState(),'executeControl').mockRejectedValue(new Error('Original creation acknowledgement unknown'))
 await picker();await prepare('remote-project');await button('Prepare locations');await field('New Session Agent configuration','codex');await button('Create Agent');await vi.waitFor(()=>expect(surface().textContent).toContain('acknowledgement unknown'))
 const original=useAppStore.getState().goalAgentCreationDrafts[goalCreationDraftKey(goal.id,'assignees')]!
 await dom.render(null);await picker();await vi.waitFor(()=>expect(control.mock.calls.some(([request])=>request.operation==='space.inspect')).toBe(true))
 await button('New Agent');await act(async()=>surface().querySelector<HTMLButtonElement>('.goal-agent-picker__receipt button')!.click())
 expect(control.mock.calls.filter(([request])=>request.operation==='agent.open')).toHaveLength(1)
 expect(useAppStore.getState().goalAgentCreationDrafts[goalCreationDraftKey(goal.id,'assignees')]).toBe(original)
 expect(surface().querySelector('.agent-work-setup')).toBeNull();expect(save).not.toHaveBeenCalled()
})
it('Goal picker work modes: the native registered folder receipt selects that exact local Project without moving existing input',async()=>{
 const registered={...local,id:'chosen-folder',name:'Same label',path:'/original/chosen-folder'},before=useAppStore.getState().agentComposerDrafts
 vi.spyOn(api.workspaces,'chooseLocalFolder').mockResolvedValue(registered)
 await picker();await button('New Agent');await button('Choose local folder…')
 expect(useAppStore.getState().config!.workspaces.find(item=>item.id===registered.id)).toEqual(registered)
 expect(surface().querySelector<HTMLButtonElement>('[aria-label="Project for this arrangement"]')!.dataset.value).toBe(registered.id)
 expect(surface().querySelector('.agent-work-ends')?.textContent).toContain(registered.path)
 expect(useAppStore.getState().agentComposerDrafts).toBe(before);expect(save).not.toHaveBeenCalled();expect(close).not.toHaveBeenCalled()
})
it('Goal picker work modes: remote-only configurations belong to the selected Host without a local template',async()=>{
 const control=vi.spyOn(useAppStore.getState(),'executeControl').mockRejectedValue(new Error('Original creation acknowledgement unknown'))
 await picker();await prepare('remote-agent');await button('Prepare locations')
 expect(useAppStore.getState().config!.executors['remote-only']).toBeUndefined()
 await field('New Session Agent configuration','remote-only');await button('Create Agent')
 await vi.waitFor(()=>expect(control).toHaveBeenCalledOnce())
 expect(control.mock.calls[0]![0]).toHaveProperty('content.executorId','remote-only')
 expect(control.mock.calls[0]![0]).toHaveProperty('content.executionWorkspaceId',project.id)
 expect(api.executors.discover).toHaveBeenCalledWith('server')
})
it('Goal picker work modes: identical Executor IDs read the target Host command and editing locations starts no Agent',async()=>{
 const control=vi.spyOn(useAppStore.getState(),'executeControl')
 await picker();await prepare('remote-agent');await button('Prepare locations')
 const trigger=surface().querySelector<HTMLElement>('[aria-label="New Session Agent configuration"]')!
 await act(async()=>trigger.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true})))
 const choice=document.querySelector<HTMLElement>('[role=menuitemradio][data-value="codex"]')!
 expect(choice.textContent).toContain('/target/server/codex');expect(choice.textContent).not.toContain(' · codex')
 await act(async()=>choice.click())
 expect(trigger.textContent).toContain('Owned configuration server')
 await button('Edit locations')
 expect(surface().querySelector<HTMLInputElement>('input[value="remote-agent"]')!.checked).toBe(true)
 expect(surface().querySelector<HTMLButtonElement>('[aria-label="Agent runs on"]')!.dataset.value).toBe('server')
 expect(control).not.toHaveBeenCalled();expect(save).not.toHaveBeenCalled()
})
it('Goal picker work modes: unknown target inventory stays explicit and refreshes only that Host without borrowing local commands',async()=>{
 vi.mocked(api.executors.discover).mockRejectedValueOnce(new Error('Original inventory unavailable'))
 const control=vi.spyOn(useAppStore.getState(),'executeControl')
 await picker();await prepare('remote-agent');await button('Prepare locations')
 await vi.waitFor(()=>expect(surface().textContent).toContain('Agent configurations are unconfirmed'))
 expect(surface().querySelector<HTMLButtonElement>('[aria-label="New Session Agent configuration"]')!.textContent).toContain('Choose a configuration on this Host')
 expect([...surface().querySelectorAll<HTMLButtonElement>('button')].find(n=>n.textContent==='Create Agent')!.disabled).toBe(true)
 await button('Refresh configurations');await field('New Session Agent configuration','remote-only')
 expect(api.executors.discover).toHaveBeenLastCalledWith('server');expect(control).not.toHaveBeenCalled()
})
it('Goal picker work modes: the actual Existing selector shows every nonlocal arrangement and unknown retained identities while confirmed Local stays quiet',async()=>{
 const ordinary={...composerSession('ordinary-remote'),hostId:'server',workspacePath:project.path,control:{...composerSession('ordinary-remote').control,hostId:'server'}}
 const remoteProject={...composerSession('project-remote'),toolExecution:{bindingId:'project-binding',resourceHostId:'server',workspacePath:project.path},workPlacement:{agentHostId:'local',resourceHostId:'server'}}
 const remoteAgent={...ordinary,id:'agent-remote',control:{...ordinary.control,agentSessionId:'agent-remote'},toolExecution:{bindingId:'agent-binding',resourceHostId:'local',workspacePath:local.path},workPlacement:{agentHostId:'server',resourceHostId:'local'}}
 const control=vi.spyOn(useAppStore.getState(),'executeControl'),launch=vi.spyOn(api.sessions,'launchAgent')
 useAppStore.setState({sessions:[composerSession('ordinary-local'),ordinary,remoteProject,remoteAgent]})
 await dom.render(<GoalAgentPicker demand={{...goal,assigneeSessionIds:['unobserved-original']}} role="assignees" onSave={save} onClose={close}/>)
 for(const[id,mode]of [['ordinary-remote','remote-workspace'],['project-remote','remote-project'],['agent-remote','remote-agent'],['unobserved-original','unknown']]){
  const badge=surface().querySelector(`[data-session-id="${id}"] .agent-work-mode-badge`)
  expect(badge?.getAttribute('data-work-mode')).toBe(mode);expect(badge?.hasAttribute('tabindex')).toBe(false)
 }
 expect(surface().querySelector('[data-session-id="ordinary-local"] .agent-work-mode-badge')).toBeNull()
 expect(control).not.toHaveBeenCalled();expect(launch).not.toHaveBeenCalled();expect(save).not.toHaveBeenCalled()
})
