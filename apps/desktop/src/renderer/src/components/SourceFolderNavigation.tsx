import { useMemo } from 'react'
import { folderDirectoryFacts, type FolderDirectoryFact } from '@agentmux/core/space-folder-resources'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { currentCoreSpatialGraph, useAppStore } from '../store'
import { spaceMountKey } from '../../../shared/space-mount'
import type { WorkspaceRecord } from '../../../shared/contracts'
import { mountedSpaceInput, mountedSpaceInputs, mountedSpaceTarget } from '../lib/space-mount-view'
import { originalSourceWorkspaceId } from '../lib/original-space-navigation'
const FolderIcon = semanticIconComponent('object.folder')
type SourceFolderFact = Omit<FolderDirectoryFact, 'directory'> & { directory?: FolderDirectoryFact['directory'] | undefined; carrierHostId?: string | undefined }

function targetFor(fact: SourceFolderFact, hostId = fact.carrierHostId ?? 'local') {
  return { hostId, reference: { runtimeId: fact.runtimeId, spaceId: fact.spaceId }, zoneId: fact.zoneId, workspaceId: fact.resource.id }
}
export function sourceFolderMatchesWorkspace(fact: SourceFolderFact, workspace: Pick<WorkspaceRecord, 'id' | 'hostId' | 'path' | 'repoPath'>): boolean {
  return fact.resource.id === workspace.id && fact.resource.path === workspace.path && (fact.resource.repoPath ?? fact.resource.path) === (workspace.repoPath ?? workspace.path) &&
    (fact.carrierHostId ?? fact.resource.hostId) === workspace.hostId
}
/** Original Core Folder facts are the only ownership source; mounts and paths never create a second project catalogue. */
export function useSourceFolderNavigation(query: string) {
  useAppStore(state => state.spaceZoneBindings)
  const config=useAppStore(state=>state.config),inputs=useAppStore(state=>state.mountedSpaceInputs),graph=currentCoreSpatialGraph()
  const owned=useMemo(()=>graph?folderDirectoryFacts(graph):{folders:[],issues:[]},[graph])
  const sourceFacts=useMemo(()=>{
    const folders: SourceFolderFact[]=[...owned.folders],known=new Set(folders.map(fact=>JSON.stringify([fact.runtimeId,fact.spaceId,fact.zoneId,fact.resource.id])))
    try { for(const key of Object.keys(mountedSpaceInputs(inputs))) {
      try {
        const target=mountedSpaceTarget(inputs,key),resource=target&&mountedSpaceInput(inputs,key)?.resource
        if(!target||!resource||target.workspaceId!==resource.id)continue
        const identity=JSON.stringify([target.reference.runtimeId,target.reference.spaceId,target.zoneId,resource.id])
        if(known.has(identity))continue
        known.add(identity);folders.push({runtimeId:target.reference.runtimeId,spaceId:target.reference.spaceId,zoneId:target.zoneId,resource,carrierHostId:target.hostId})
      } catch { /* This opaque entry stays untouched; other original Folder facts remain navigable. */ }
    } } catch { /* Unreadable private fragments stay opaque and never become project ownership guesses. */ }
    return {folders,issues:owned.issues}
  },[owned,inputs])
  const locals=config?.hosts.filter(host=>host.kind==='local')??[],carrier=locals.length===1?locals[0]:undefined
  const byWorkspace=useMemo(()=>{
    const result=new Map<string,SourceFolderFact[]>()
    for(const fact of sourceFacts.folders){const facts=result.get(fact.resource.id)??[];facts.push(fact);result.set(fact.resource.id,facts)}
    return result
  },[sourceFacts])
  const projects=useMemo(()=>{
    const result=new Map<string,{key:string;folders:SourceFolderFact[]}>()
    for(const fact of sourceFacts.folders){
      if(config?.workspaces.some(workspace=>sourceFolderMatchesWorkspace(fact,workspace)))continue
      if(query.trim()&&![fact.resource.name,fact.resource.path].some(text=>text.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())))continue
      const key=spaceMountKey({runtimeId:fact.runtimeId,spaceId:fact.spaceId}),project=result.get(key)??{key,folders:[]};project.folders.push(fact);result.set(key,project)
    }
    return [...result.values()]
  },[sourceFacts,config?.workspaces,query])
  const forHost=(hostId:string)=>projects.map(project=>({...project,folders:project.folders.filter(fact=>(fact.carrierHostId??'local')===hostId)})).filter(project=>project.folders.length>0)
  return {projects,forHost,byWorkspace,issues:sourceFacts.issues,carrier}
}
/** Unconfigured Core-owned Folders join the same ordinary project partition and WorkspaceWorkbench. */
export function SourceFolderNavigation({navigation,hostId='local'}:{navigation:ReturnType<typeof useSourceFolderNavigation>;hostId?:string}){
  const activeWorkspaceId=useAppStore(state=>state.activeWorkspaceId),selection=useAppStore(state=>state.workbenchSpaceSelection),reportError=useAppStore(state=>state.reportError)
  function open(fact:SourceFolderFact){
    const carrierHostId=fact.carrierHostId??navigation.carrier?.id
    if(!carrierHostId)return
    try{useAppStore.getState().openOriginalSpaceLocation({target:targetFor(fact,carrierHostId),resource:fact.resource})}
    catch(cause){reportError(cause)}
  }
  function row(fact:SourceFolderFact,key:string){
    const active=(activeWorkspaceId===fact.resource.id||activeWorkspaceId===originalSourceWorkspaceId(targetFor(fact)))&&selection?.spaceId===fact.spaceId&&selection.zoneId===fact.zoneId&&selection.sourceRuntimeId===fact.runtimeId
    return <button key={fact.zoneId} type="button" data-space-entry data-space-nav={JSON.stringify([key,fact.zoneId])} data-space-parent="space:folders" className={`project-rail-row${active?' project-rail-row--active':''}`} aria-current={active?'page':undefined}
      disabled={!(fact.carrierHostId??navigation.carrier?.id)} title={`${fact.resource.path} · Source ${fact.runtimeId}`} onClick={()=>open(fact)}>
      <FolderIcon size={14} aria-hidden="true"/><span className="project-rail-row__identity"><strong>{fact.resource.name}</strong><small>{fact.resource.path}</small></span>
    </button>
  }
  return <div aria-label="Source Folder projects">
    {navigation.forHost(hostId).map(project=>project.folders.length===1?row(project.folders[0]!,project.key):<details key={project.key}><summary>{project.folders[0]!.resource.name}</summary>{project.folders.map(fact=>row(fact,project.key))}</details>)}
    {!navigation.carrier&&navigation.projects.length?<p role="status">The original local Source carrier is unconfirmed. Its folders and existing work are retained.</p>:null}
    {navigation.issues.map(issue=><p key={issue.key} role="status">{issue.message}</p>)}
  </div>
}
