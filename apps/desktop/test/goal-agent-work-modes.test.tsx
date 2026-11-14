// @vitest-environment happy-dom
import {act} from 'react'
import {afterEach, beforeEach, expect, it, vi} from 'vitest'
import {GoalAgentPicker} from '../src/renderer/src/components/GoalAgentPicker'
import {useAppStore} from '../src/renderer/src/store'
import {api} from '../src/renderer/src/lib/api'
import {workspaceProjectId} from '../src/renderer/src/lib/workspace-projects'
import {goalCreationDraftKey} from '../src/renderer/src/lib/goal-agent-selection'
import type {DemandRecord} from '../src/renderer/src/lib/global-demand-board'
import {composerConfig, composerDOM, composerSession} from './helpers/composer-dom-fixture'
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
it('Goal picker work modes: a retained legacy spatial creation remains an inspect-only original request after the Source UI change',async()=>{
 const operationId='original-legacy-creation',request={schemaVersion:5 as const,requestId:operationId,operation:'agent.open' as const,focus:false,
  content:{kind:'new-agent' as const,executorId:'codex',executionWorkspaceId:local.id},destination:{spaceId:workspaceProjectId(local),zoneId:'original-zone',newTab:true as const}}
 const original={goalId:goal.id,role:'assignees' as const,operationId,phase:'may-have-dispatched' as const,request}
 useAppStore.setState({goalAgentCreationDrafts:{[goalCreationDraftKey(goal.id,'assignees')]:original}})
 const control=vi.spyOn(useAppStore.getState(),'executeControl').mockRejectedValue(Error('Original creation observation unavailable'))
 const source=vi.spyOn(api.spaceMounts,'call'),launch=vi.spyOn(api.sessions,'launchAgent')
 await picker();await vi.waitFor(()=>expect(control).toHaveBeenCalled())
 expect(control.mock.calls.every(([value])=>value.operation==='space.inspect'&&'requestId' in value.target&&value.target.requestId===operationId)).toBe(true)
 await button('New Agent');await button('Check original creation')
 expect(control.mock.calls.every(([value])=>value.operation==='space.inspect')).toBe(true)
 expect(useAppStore.getState().goalAgentCreationDrafts[goalCreationDraftKey(goal.id,'assignees')]).toBe(original)
 expect(source).not.toHaveBeenCalled();expect(launch).not.toHaveBeenCalled();expect(save).not.toHaveBeenCalled()
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
  expect(badge?.getAttribute('data-work-mode')).toBe(mode);expect(badge?.getAttribute('tabindex')).toBe('0');expect(badge?.getAttribute('aria-label')).toContain('Run mode')
 }
 expect(surface().querySelector('[data-session-id="ordinary-local"] .agent-work-mode-badge')).toBeNull()
 expect(control).not.toHaveBeenCalled();expect(launch).not.toHaveBeenCalled();expect(save).not.toHaveBeenCalled()
})
