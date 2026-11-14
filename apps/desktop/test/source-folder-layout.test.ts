import { afterEach, expect, it } from 'vitest'
import { sourceFolderFixture } from '../../../packages/core/test/helpers/space-folder-directory-fixture'
import { desktopSpatialGraph, desktopBindingsFromSpatial } from '../src/renderer/src/lib/desktop-spatial-state'
import { folderDirectoryFacts, retainFolderDirectoryIdentity } from '@agentmux/core/space-folder-resources'
import type { AppConfig } from '../src/shared/contracts'

const cleanup:Array<()=>unknown|Promise<unknown>>=[]
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close()})
async function source(){
  const f=await sourceFolderFixture(cleanup), observed=await f.rpc.call('space.folder.inspect',{runtimeId:f.source.runtimeId,path:f.directory})
  const saved=await f.rpc.call('space.folder.register',{runtimeId:f.source.runtimeId,directory:observed.resource!})
  return {...f,saved,current:(await f.spatial.read())!}
}
const config:AppConfig={version:9,hosts:[{id:'local',kind:'local',label:'Source'}],workspaces:[],executors:{},appearance:{terminalTheme:'graphite'},browser:{toolbar:{selectElement:true,screenshot:true,devTools:true,viewport:true,saveBookmark:true,more:true}}}

it('an ordinary layout projection retains the original Source Folder kind and project identity without requiring client configuration',async()=>{
  const f=await source(),current=f.current
  const projected=desktopSpatialGraph({config,sessions:[],tabs:{},layouts:{},spatialRequests:{},spaceZoneBindings:desktopBindingsFromSpatial(current.graph,config)},[],current.graph)
  const original=current.graph.spaces.find(space=>space.spaceId===f.saved.reference.spaceId)!
  expect(projected.spaces.find(space=>space.spaceId===f.saved.reference.spaceId)).toMatchObject({spaceId:original.spaceId,hostId:original.hostId,directoryPath:original.directoryPath,kind:original.kind,projectId:original.projectId})
  await f.spatial.commit({expectedRevision:current.revision,graph:projected})
  expect(folderDirectoryFacts((await f.spatial.read())!.graph)).toMatchObject({folders:[{runtimeId:f.source.runtimeId,spaceId:f.saved.reference.spaceId}],issues:[]})
})

it('identity retention touches no label, layout or branch and does not rebuild removed or changed-source entities',async()=>{
  const f=await source(),previous=f.current.graph, projected=structuredClone(previous), space=projected.spaces[0]!,zone=projected.zones[0]!
  space.kind='container';space.projectId=null;space.name='A separately owned label';zone.branch='A separately observed branch'
  const layout=projected.layouts
  retainFolderDirectoryIdentity(projected,previous)
  expect(space).toMatchObject({kind:'folder',projectId:previous.spaces[0]!.projectId,name:'A separately owned label'})
  expect(zone.branch).toBe('A separately observed branch');expect(projected.layouts).toBe(layout)
  const changed=structuredClone(previous);changed.spaces[0]!.hostId='another-source';changed.spaces[0]!.kind='container'
  const bytes=JSON.stringify(changed);retainFolderDirectoryIdentity(changed,previous);expect(JSON.stringify(changed)).toBe(bytes)
  const removed=structuredClone(previous);removed.spaces=[];retainFolderDirectoryIdentity(removed,previous);expect(removed.spaces).toEqual([])
})

it('unknown or already corrupted previous resource facts are not repaired or promoted by an observation',async()=>{
  const f=await source(),previous=structuredClone(f.current.graph);previous.spaces[0]!.kind='container';previous.spaces[0]!.projectId=null
  const projected=structuredClone(previous),bytes=JSON.stringify(projected)
  retainFolderDirectoryIdentity(projected,previous)
  expect(JSON.stringify(projected)).toBe(bytes);expect(folderDirectoryFacts(projected).issues).toHaveLength(1)
  const ordinary=structuredClone(f.current.graph);ordinary.resources={};const target=structuredClone(ordinary);target.spaces[0]!.kind='container'
  const withoutOwned=JSON.stringify(target);retainFolderDirectoryIdentity(target,ordinary);expect(JSON.stringify(target)).toBe(withoutOwned)
})
