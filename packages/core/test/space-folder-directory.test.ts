import { afterEach, expect, it, vi } from 'vitest'
import { mkdir, writeFile, readFile, rename, realpath, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { AgentMuxSpatialStateStore } from '../src/spatial-state.js'
import { AgentMuxNotesStorage } from '../src/notes-storage.js'
import { readSpaceSnapshot, observeSpace } from '../src/space-authority-stream.js'
import { folderSpaceFacts } from '../src/space-folder.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { createHostWorkspaceResources } from '../../../apps/host/src/workspace-resources.js'
import { createHostFolderDirectoryOwner } from '../../../apps/host/src/folder-directory-owner.js'
import { createHostFolderSpaceResource } from '../../../apps/host/src/folder-space-resource.js'
import { createHostSnapshotObservation } from '../../../apps/host/src/snapshot-observation.js'
import { createHostContent } from '../../../apps/host/src/content-owner.js'

import { sourceFolderFixture } from './helpers/space-folder-directory-fixture.js'
const close: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const work of close.splice(0).reverse()) await work() })
const fixture = () => sourceFolderFixture(close)
it('the original public Source directory inspection and registration reach shared snapshot and real Files without writing config',async()=>{
  const f=await fixture(),before=await readFile(f.configurationPath,'utf8')
  const inspect=await f.rpc.call('space.folder.inspect',{runtimeId:f.source.runtimeId,path:f.directory})
  expect(inspect.resource).toMatchObject({hostId:'local',workspacePath:f.directory,witness:{realPath:await realpath(f.directory)}})
  expect(inspect.registrations).toEqual([]);expect(await f.spatial.read()).toBeNull()
  const saved=await f.rpc.call('space.folder.register',{runtimeId:f.source.runtimeId,directory:inspect.resource!})
  expect(saved.created).toBe(true);expect(saved.diskDurability).toBe('confirmed');expect(saved.workspaceId).toBeTruthy()
  const snapshot=await readSpaceSnapshot(f.rpc,saved.reference)
  expect(snapshot.scope.zones).toContainEqual(expect.objectContaining({zoneId:saved.zoneId,workspaceId:saved.workspaceId,directoryPath:f.directory}))
  const catalogue=await f.rpc.call('app.snapshot',{include:['workspaces']})
  expect(catalogue.workspaces).toContainEqual(expect.objectContaining({workspaceId:saved.workspaceId,path:f.directory,projectId:saved.reference.spaceId}))
  expect(catalogue.unavailable).toEqual([])
  const file=await f.rpc.call('file.read',{zoneId:saved.zoneId,path:'hello.txt',expectedResource:{hostId:'local',workspaceId:saved.workspaceId,workspacePath:f.directory}})
  expect(file.result).toMatchObject({status:'read',document:{content:'Source original file\n'}})
  expect(await readFile(f.configurationPath,'utf8')).toBe(before)
})
it('a wrong Source Runtime refuses directory observation and admission without creating spatial state',async()=>{
  const f=await fixture()
  await expect(f.rpc.call('space.folder.inspect',{runtimeId:'another-core',path:f.directory})).rejects.toMatchObject({code:'RUNTIME_OWNER_MISMATCH'})
  const observed=await f.rpc.call('space.folder.inspect',{runtimeId:f.source.runtimeId,path:f.directory})
  await expect(f.rpc.call('space.folder.register',{runtimeId:'another-core',directory:observed.resource!})).rejects.toMatchObject({code:'RUNTIME_OWNER_MISMATCH'})
  expect(await f.spatial.read()).toBeNull()
})
it('the new canonical Folder participates in the original scoped public watch and normal business edits',async()=>{
  const f=await fixture(), observed=await f.rpc.call('space.folder.inspect',{runtimeId:f.source.runtimeId,path:f.directory})
  const saved=await f.rpc.call('space.folder.register',{runtimeId:f.source.runtimeId,directory:observed.resource!})
  let latest=await readSpaceSnapshot(f.rpc,saved.reference)
  const reader=await observeSpace(f.rpc,{reference:saved.reference},{onChange:value=>{latest=value}});close.push(()=>reader.dispose())
  await f.rpc.call('space.apply',{reference:saved.reference,expectedRevision:saved.revision,changes:{
    tabs:[{tabId:'original-source-tab',zoneId:saved.zoneId,workspaceId:saved.workspaceId,name:'Source work',regionIds:['original-source-region']}],
    regions:[{regionId:'original-source-region',tabId:'original-source-tab',kind:'launcher',agentSessionId:null,runId:null,execution:{hostId:'local',cwd:f.directory,runtimeId:f.source.runtimeId}}]
  }})
  await vi.waitFor(()=>expect(latest.scope.tabs.map(tab=>tab.tabId)).toContain('original-source-tab'))
  expect(latest.reference).toEqual(saved.reference);expect(latest.scope.zones[0]!.workspaceId).toBe(saved.workspaceId)
  expect(f.owner.inner.kernel.stop).not.toHaveBeenCalled()
})
it('relative directory input never borrows an observer, Agent or Core working directory',async()=>{
  const f=await fixture(), current=await f.rpc.call('space.folder.inspect',{runtimeId:f.source.runtimeId,path:'.'})
  expect(current).toMatchObject({resource:null,registrations:[],issue:{code:'INVALID_CONTROL_REQUEST'}})
  const observed=await f.rpc.call('space.folder.inspect',{runtimeId:f.source.runtimeId,path:f.directory})
  await expect(f.rpc.call('space.folder.register',{runtimeId:f.source.runtimeId,directory:{...observed.resource!,workspacePath:'.',projectRootPath:'.'}})).rejects.toMatchObject({code:'INVALID_CONTROL_REQUEST'})
  expect(await f.spatial.read()).toBeNull()
})
it('a replaced physical directory refuses only the frozen registration and leaves the original directory intact',async()=>{
  const f=await fixture(),observed=await f.rpc.call('space.folder.inspect',{runtimeId:f.source.runtimeId,path:f.directory})
  await rename(f.directory,f.directory+'-original');await mkdir(f.directory)
  await expect(f.rpc.call('space.folder.register',{runtimeId:f.source.runtimeId,directory:observed.resource!})).rejects.toMatchObject({code:'SPACE_DIRECTORY_CHANGED'})
  const current=await f.rpc.call('space.folder.inspect',{runtimeId:f.source.runtimeId,path:f.directory,expectedResource:observed.resource!})
  expect(current.resource).toBeNull();expect(current.issue?.code).toBe('SPACE_DIRECTORY_CHANGED')
  expect(await f.spatial.read()).toBeNull();expect(await readFile(join(f.directory+'-original','hello.txt'),'utf8')).toBe('Source original file\n')
})
it('configured and graph resource identities are reused and an unknown write is inspected without remint or replay',async()=>{
  const f=await fixture(),configured={id:'original-config-workspace',hostId:'local',path:f.directory,name:'Original configured name'}
  await writeFile(f.configurationPath,JSON.stringify({workspaces:[configured],executors:{},appearance:{}}))
  const original=await f.spatial.registerFolder(configured),bytes=await readFile(f.configurationPath,'utf8')
  const observed=await f.rpc.call('space.folder.inspect',{runtimeId:f.source.runtimeId,path:f.directory})
  let writes=0
  await expect((async()=>{writes++;await f.rpc.call('space.folder.register',{runtimeId:f.source.runtimeId,directory:observed.resource!});throw Error('Only the original reply was lost')})()).rejects.toThrow('original reply')
  const current=await f.rpc.call('space.folder.inspect',{runtimeId:f.source.runtimeId,path:f.directory,expectedResource:observed.resource!})
  expect(current.registrations).toHaveLength(1);expect(current.registrations[0]).toMatchObject({reference:{spaceId:original.spaceId},zoneId:original.zoneId,workspaceId:configured.id})
  expect(writes).toBe(1);expect(await readFile(f.configurationPath,'utf8')).toBe(bytes)
  expect((await f.spatial.read())!.graph.spaces).toContainEqual(folderSpaceFacts(configured).space)
})
it('a managed caller cannot admit a new root while its healthy Agent stays available',async()=>{
  const f=await fixture(),observed=await f.rpc.call('space.folder.inspect',{runtimeId:f.source.runtimeId,path:f.directory})
  const managed=await connectAgentMuxRpc({endpoint:{transport:'unix',path:f.server.path},credentials:f.owner.credentials});close.push(()=>managed.dispose())
  await expect(managed.call('space.folder.inspect',{runtimeId:f.source.runtimeId,path:f.directory})).rejects.toMatchObject({code:'CONTROL_PERMISSION_DENIED'})
  await expect(managed.call('space.folder.register',{runtimeId:f.source.runtimeId,directory:observed.resource!})).rejects.toMatchObject({code:'CONTROL_PERMISSION_DENIED'})
  expect(await f.spatial.read()).toBeNull();expect((await f.owner.client.statusAgent('managed')).run.state).toBe('running')
  expect(f.owner.inner.kernel.stop).not.toHaveBeenCalled()
})

it('a missing directory is an explicit unavailable observation, and a symlink replacement cannot select another root',async()=>{
  const f=await fixture()
  const missing=await f.rpc.call('space.folder.inspect',{runtimeId:f.source.runtimeId,path:join(f.root,'not-present')})
  expect(missing).toMatchObject({resource:null,registrations:[],issue:{code:'ENOENT'}})
  const observed=await f.rpc.call('space.folder.inspect',{runtimeId:f.source.runtimeId,path:f.directory})
  await rename(f.directory,f.directory+'-original'); await mkdir(join(f.root,'another-root')); await symlink(join(f.root,'another-root'),f.directory)
  await expect(f.rpc.call('space.folder.register',{runtimeId:f.source.runtimeId,directory:observed.resource!})).rejects.toMatchObject({code:'SPACE_DIRECTORY_CHANGED'})
  expect(await f.spatial.read()).toBeNull()
})

it('ambiguous original resources need an exact original selection and never accept a client-minted Workspace ID',async()=>{
  const f=await fixture()
  await writeFile(f.configurationPath,JSON.stringify({workspaces:['original-one','original-two'].map(id=>({id,hostId:'local',path:f.directory,name:id})),executors:{}}))
  const observed=await f.rpc.call('space.folder.inspect',{runtimeId:f.source.runtimeId,path:f.directory})
  await expect(f.rpc.call('space.folder.register',{runtimeId:f.source.runtimeId,directory:observed.resource!})).rejects.toMatchObject({code:'SPACE_REGISTRATION_AMBIGUOUS'})
  await expect(f.rpc.call('space.folder.register',{runtimeId:f.source.runtimeId,directory:observed.resource!,workspaceId:'client-made-id'})).rejects.toMatchObject({code:'SPACE_RESOURCE_CHANGED'})
  expect(await f.spatial.read()).toBeNull()
  const saved=await f.rpc.call('space.folder.register',{runtimeId:f.source.runtimeId,directory:observed.resource!,workspaceId:'original-two'})
  expect(saved.workspaceId).toBe('original-two')
})

it('an unknown new-directory reply is reconciled with its current canonical facts without a second registration',async()=>{
  const f=await fixture(), before=await readFile(f.configurationPath,'utf8')
  const observed=await f.rpc.call('space.folder.inspect',{runtimeId:f.source.runtimeId,path:f.directory})
  const request={runtimeId:f.source.runtimeId,directory:observed.resource!}; let dispatched=0
  const saved=await (async()=>{dispatched++;return f.rpc.call('space.folder.register',request)})()
  // Only readback is delivered to this consumer after the original ACK is lost.
  const bytes=await readFile(f.spatial.path,'utf8')
  const current=await f.rpc.call('space.folder.inspect',{runtimeId:request.runtimeId,path:request.directory.workspacePath,expectedResource:request.directory})
  expect(current.registrations).toHaveLength(1)
  expect(current.registrations[0]).toMatchObject({reference:saved.reference,zoneId:saved.zoneId,workspaceId:saved.workspaceId})
  expect(current.registrations[0]).not.toHaveProperty('created'); expect(current.registrations[0]).not.toHaveProperty('diskDurability')
  expect(dispatched).toBe(1); expect(await readFile(f.spatial.path,'utf8')).toBe(bytes); expect(await readFile(f.configurationPath,'utf8')).toBe(before)
})

it('a new Core instance at the same semantic Runtime accepts the original directory intent while a stale explicit fence refuses only its call',async()=>{
  const f=await fixture(), old={...f.source}
  const observed=await f.rpc.call('space.folder.inspect',{runtimeId:f.source.runtimeId,path:f.directory})
  f.source.ownerInstanceId='restarted-original-B'
  await expect(f.rpc.call('space.folder.register',{runtimeId:f.source.runtimeId,directory:observed.resource!},{runtimeFence:old})).rejects.toMatchObject({code:'RUNTIME_OWNER_MISMATCH'})
  expect(await f.spatial.read()).toBeNull()
  const saved=await f.rpc.call('space.folder.register',{runtimeId:f.source.runtimeId,directory:observed.resource!})
  expect(saved.source).toEqual(f.source)
})

it('ordinary layout saves preserve owned directory facts and unrelated records without making config or sharing writers',async()=>{
  const f=await fixture(), observed=await f.rpc.call('space.folder.inspect',{runtimeId:f.source.runtimeId,path:f.directory})
  const saved=await f.rpc.call('space.folder.register',{runtimeId:f.source.runtimeId,directory:observed.resource!}), first=(await f.spatial.read())!
  await f.spatial.commit({expectedRevision:first.revision,graph:{...first.graph,resources:{'private-unrelated':{draft:'keep exact original bytes'}}}})
  const current=(await f.spatial.read())!, reopened=new AgentMuxSpatialStateStore(f.spatial.path)
  expect((await reopened.read())!.graph.resources).toEqual(current.graph.resources)
  expect((await f.rpc.call('app.snapshot',{include:['workspaces']})).workspaces).toContainEqual(expect.objectContaining({workspaceId:saved.workspaceId,path:f.directory}))
  expect(current.graph.resources['private-unrelated']).toEqual({draft:'keep exact original bytes'})
})
it('the public bulk layout owner preserves a confirmed same-resource Folder identity when an older client projects an unavailable container',async()=>{
  const f=await fixture(), observed=await f.rpc.call('space.folder.inspect',{runtimeId:f.source.runtimeId,path:f.directory})
  const saved=await f.rpc.call('space.folder.register',{runtimeId:f.source.runtimeId,directory:observed.resource!}), current=(await f.spatial.read())!
  const graph=structuredClone(current.graph), folder=graph.spaces.find(space=>space.spaceId===saved.reference.spaceId)!
  folder.kind='container';folder.projectId=null
  const result=await f.rpc.call('space.commit',{expectedRevision:current.revision,graph})
  expect(result.state.graph.spaces.find(space=>space.spaceId===saved.reference.spaceId)).toMatchObject({kind:'folder',projectId:current.graph.spaces[0]!.projectId})
  expect((await f.rpc.call('app.snapshot',{include:['workspaces']})).workspaces).toContainEqual(expect.objectContaining({workspaceId:saved.workspaceId}))
})

it.skipIf(!process.env.SPACE_FOLDER_CLI)('the real CLI inspects, explicitly registers and reads back the same Source-owned canonical directory',async()=>{
  const f=await fixture()
  const invoke=async(args:string[])=>{
    const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('AGENTMUX_')&&!key.startsWith('CTXMUX_')))
    const child=spawn(process.execPath,[process.env.SPACE_FOLDER_CLI!,'--endpoint','unix:'+f.server.path,...args],{env,stdio:['ignore','pipe','pipe']})
    let stdout='',stderr='';child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data)
    const timer=setTimeout(()=>child.kill('SIGKILL'),12000)
    try{const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)});expect(code,stderr).toBe(0);return JSON.parse(stdout).result}
    finally{clearTimeout(timer)}
  }
  const inspectPath=join(f.root,'inspect-request.json'), registerPath=join(f.root,'original-registration-request.json')
  await writeFile(inspectPath,JSON.stringify({runtimeId:f.source.runtimeId,path:'.'}))
  expect(await invoke(['space','folder','inspect','--input='+inspectPath])).toMatchObject({resource:null,issue:{code:'INVALID_CONTROL_REQUEST'}})
  await writeFile(inspectPath,JSON.stringify({runtimeId:f.source.runtimeId,path:f.directory}))
  const observed=await invoke(['space','folder','inspect','--input='+inspectPath])
  expect(observed.resource.witness.inode).toBeTruthy()
  await writeFile(registerPath,JSON.stringify({runtimeId:f.source.runtimeId,directory:observed.resource}))
  const saved=await invoke(['space','folder','register','--input',registerPath])
  const snapshot=await invoke(['space','snapshot','--runtime',f.source.runtimeId,'--space',saved.reference.spaceId])
  expect(snapshot.scope.zones).toContainEqual(expect.objectContaining({workspaceId:saved.workspaceId,directoryPath:f.directory}))
  await writeFile(inspectPath,JSON.stringify({runtimeId:f.source.runtimeId,path:f.directory,expectedResource:observed.resource}))
  const current=await invoke(['space','folder','inspect','--input='+inspectPath])
  expect(current.registrations).toHaveLength(1);expect(current.registrations[0].reference).toEqual(saved.reference)
})
