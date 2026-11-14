// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { WorkspaceSidebar } from '../src/renderer/src/components/WorkspaceSidebar'
import { SourceFolderNavigation, useSourceFolderNavigation } from '../src/renderer/src/components/SourceFolderNavigation'
import { MountedSpaceNavigation } from '../src/renderer/src/components/MountedSpaceNavigation'
import * as store from '../src/renderer/src/store'
import { useAppStore } from '../src/renderer/src/store'
import { openSourceFolderInput, mountedSpaceInput } from '../src/renderer/src/lib/space-mount-view'
import { spaceMountKey } from '../src/shared/space-mount'
import { composerDOM, composerConfig } from './helpers/composer-dom-fixture'
import { sourceFolderFixture } from '../../../packages/core/test/helpers/space-folder-directory-fixture'

const dom=composerDOM(), cleanup:Array<()=>unknown|Promise<unknown>>=[]
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close()})
async function source() {
  const f=await sourceFolderFixture(cleanup), observed=await f.rpc.call('space.folder.inspect',{runtimeId:f.source.runtimeId,path:f.directory})
  const saved=await f.rpc.call('space.folder.register',{runtimeId:f.source.runtimeId,directory:observed.resource!})
  const graph=(await f.spatial.read())!.graph, target={hostId:'local',reference:saved.reference,zoneId:saved.zoneId,workspaceId:saved.workspaceId}, key=spaceMountKey(saved.reference)
  // The external leaf is the accepted Core graph read. All graph data comes from the real Source owner above.
  vi.spyOn(store,'currentCoreSpatialGraph').mockReturnValue(graph)
  useAppStore.setState({config:{...composerConfig,workspaces:[]},mountedSpaceInputs:{},selectedSpaceMount:null,collapsedProjectGroups:{}})
  return {...f,saved,graph,target,key}
}
function Navigation(){const navigation=useSourceFolderNavigation('');return <><MountedSpaceNavigation query=""/><SourceFolderNavigation navigation={navigation}/></>}


it('a new Source Folder reaches the ordinary Sidebar without config injection, and only its explicit click opens the exact private view',async()=>{
  const f=await source(), before=useAppStore.getState(), originalInput=before.mountedSpaceInputs, config=before.config
  const disk=await readFile(f.configurationPath,'utf8')
  await dom.render(<WorkspaceSidebar/>)
  expect(dom.container.querySelector('[data-folder-host="local"] [aria-label="Source Folder projects"]')?.textContent).toContain('selected-folder')
  expect(dom.container.textContent).not.toContain('Open a folder to get started.')
  expect(useAppStore.getState().mountedSpaceInputs).toBe(originalInput)
  expect(useAppStore.getState().tabs).toBe(before.tabs);expect(useAppStore.getState().config).toBe(config)
  await dom.click('[aria-label="Source Folder projects"] button')
  const current=useAppStore.getState()
  expect(current.selectedSpaceMount).toBe(f.key)
  expect(mountedSpaceInput(current.mountedSpaceInputs,f.key)).toMatchObject({target:f.target,navigation:'project'})
  expect(current.tabs).toBe(before.tabs);expect(current.layouts).toBe(before.layouts)
  expect(current.config!.workspaces).toEqual([]);expect(await readFile(f.configurationPath,'utf8')).toBe(disk)
  const file=await f.rpc.call('file.read',{zoneId:f.saved.zoneId,path:'hello.txt',expectedResource:{hostId:'local',workspaceId:f.saved.workspaceId,workspacePath:f.directory}})
  expect(file.result).toMatchObject({status:'read',document:{content:'Source original file\n'}})
})

it('explicit project promotion preserves the same private draft, member operation, opaque neighbours and avoids a second mounted row',async()=>{
  const f=await source(), member={kind:'space-member-input',target:f.target,drafts:{original:'Keep original draft'},memberInputs:{original:{operationId:'original-input-OP',text:'Keep bytes'}},opaque:{future:[1,2]}}
  const neighbour={kind:'future-version',bytes:'unaltered'}
  useAppStore.setState({mountedSpaceInputs:{[f.key]:member,neighbour}})
  await dom.render(<Navigation/>)
  expect(dom.container.querySelectorAll('[aria-label="Source Folder projects"] button')).toHaveLength(1)
  await dom.click('[aria-label="Source Folder projects"] button')
  const result=useAppStore.getState().mountedSpaceInputs as Record<string,unknown>
  expect(result[f.key]).toEqual({...member,kind:undefined,navigation:'project'})
  expect(result.neighbour).toBe(neighbour)
  expect(dom.container.querySelector('[aria-label="Mounted Spaces"]')).toBeNull()
  expect(dom.container.querySelectorAll('[aria-label="Source Folder projects"] button')).toHaveLength(1)
  // An existing explicit mount stays one mounted row until the user's explicit project promotion.
  await act(async()=>useAppStore.setState({mountedSpaceInputs:{[f.key]:{target:f.target,drafts:{original:'Retained'}}}}))
  expect(dom.container.querySelectorAll('[data-mounted-space-nav]')).toHaveLength(1)
  expect(dom.container.querySelectorAll('[aria-label="Source Folder projects"] button')).toHaveLength(0)
})

it('configured same-resource rows are not duplicated and a future private fragment is retained on a refused explicit promotion',async()=>{
  const f=await source()
  useAppStore.setState({config:{...composerConfig,workspaces:[{id:f.saved.workspaceId,name:'Configured original',hostId:'local',path:f.directory,kind:'folder'}]}})
  await dom.render(<WorkspaceSidebar/>)
  expect(dom.container.querySelectorAll('[aria-label="Source Folder projects"] button')).toHaveLength(0)
  expect(dom.container.textContent).toContain('Configured original')
  expect(useAppStore.getState().config!.workspaces[0]!.name).toBe('Configured original')
  const opaque={[f.key]:{kind:'unknown-future',target:f.target,drafts:{keep:'unchanged'}}}
  expect(()=>openSourceFolderInput(opaque,f.target)).toThrow('unreadable')
  expect(opaque[f.key]!.drafts.keep).toBe('unchanged')
  const futureDecoration={[f.key]:{target:f.target,navigation:'future-style',drafts:{keep:'original input'},memberInputs:{original:{operationId:'retained-OP'}}}}
  // Presentation metadata cannot revoke readable input or its exact control locator.
  expect(mountedSpaceInput(futureDecoration,f.key)?.drafts.keep).toBe('original input')
  expect(futureDecoration[f.key]!.memberInputs.original.operationId).toBe('retained-OP')
})
