import { useMemo } from 'react'
import { folderDirectoryFacts, type FolderDirectoryFact } from '@agentmux/core/space-folder-resources'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { currentCoreSpatialGraph, useAppStore } from '../store'
import { spaceMountKey } from '../../../shared/space-mount'
import { mountedSpaceTarget, sourceFolderProjectEntry } from '../lib/space-mount-view'
const FolderIcon = semanticIconComponent('object.folder')

/** One projection per accepted graph; no path hashing, per-row RPC or write on observation. */
export function useSourceFolderNavigation(query: string) {
  useAppStore(state => state.spaceZoneBindings)
  const config=useAppStore(state=>state.config), inputs=useAppStore(state=>state.mountedSpaceInputs), graph=currentCoreSpatialGraph()
  const owned=useMemo(()=>graph?folderDirectoryFacts(graph):{folders:[],issues:[]},[graph])
  const locals=config?.hosts.filter(host=>host.kind==='local')??[], carrier=locals.length===1?locals[0]:undefined
  const projects=useMemo(()=>{
    const result=new Map<string,{key:string;folders:FolderDirectoryFact[]}>()
    const configured=new Set(config?.workspaces.map(resource=>JSON.stringify([resource.id,resource.hostId,resource.path,resource.repoPath??resource.path]))??[])
    for(const fact of owned.folders){
      if(configured.has(JSON.stringify([fact.resource.id,fact.resource.hostId,fact.resource.path,fact.resource.repoPath??fact.resource.path])))continue
      if(query.trim()&&![fact.resource.name,fact.resource.path].some(text=>text.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())))continue
      const key=spaceMountKey({runtimeId:fact.runtimeId,spaceId:fact.spaceId})
      try{if(mountedSpaceTarget(inputs,key)&&!sourceFolderProjectEntry(inputs,key))continue}catch{/* Keep unreadable private bytes; explicit opening reports its exact failure. */}
      const project=result.get(key)??{key,folders:[]};project.folders.push(fact);result.set(key,project)
    }
    return [...result.values()]
  },[owned,config?.workspaces,inputs,query])
  return {projects,issues:owned.issues,carrier}
}
/** Original Core resources appear in the ordinary Folders area; only an explicit click opens a private view. */
export function SourceFolderNavigation({navigation}:{navigation:ReturnType<typeof useSourceFolderNavigation>}){
  const selected=useAppStore(state=>state.selectedSpaceMount),reportError=useAppStore(state=>state.reportError)
  function open(fact:FolderDirectoryFact){
    if(!navigation.carrier)return
    try{useAppStore.getState().openSourceFolder({hostId:navigation.carrier.id,reference:{runtimeId:fact.runtimeId,spaceId:fact.spaceId},zoneId:fact.zoneId,workspaceId:fact.resource.id})}
    catch(cause){reportError(cause)}
  }
  function row(fact:FolderDirectoryFact,key:string){return <button key={fact.zoneId} type="button" data-space-entry data-space-nav={JSON.stringify([key,fact.zoneId])} data-space-parent="space:folders" className={`project-rail-row${selected===key?' project-rail-row--active':''}`} aria-current={selected===key?'page':undefined}
    disabled={!navigation.carrier} title={`${fact.resource.path} · Source ${fact.runtimeId}`} onClick={()=>open(fact)}>
    <FolderIcon size={14} aria-hidden="true"/><span className="project-rail-row__identity"><strong>{fact.resource.name}</strong><small>{fact.resource.path}</small></span>
  </button>}
  return <div aria-label="Source Folder projects">
    {navigation.projects.map(project=>project.folders.length===1?row(project.folders[0]!,project.key):<details key={project.key}><summary>{project.folders[0]!.resource.name}</summary>{project.folders.map(fact=>row(fact,project.key))}</details>)}
    {!navigation.carrier&&navigation.projects.length?<p role="status">The original local Source carrier is unconfirmed. Its folders and existing work are retained.</p>:null}
    {navigation.issues.map(issue=><p key={issue.key} role="status">{issue.message}</p>)}
  </div>
}
