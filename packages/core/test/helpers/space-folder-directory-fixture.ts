import { expect } from 'vitest'
import { mkdir, writeFile, readFile, rename, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentMuxError } from '../../src/errors.js'
import { AgentMuxControlServer } from '../../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../../src/public-rpc-client.js'
import { AgentMuxSpatialStateStore } from '../../src/spatial-state.js'
import { AgentMuxNotesStorage } from '../../src/notes-storage.js'
import { rpcOwnerFixture } from './public-rpc-owner.js'
import { createHostWorkspaceResources } from '../../../../apps/host/src/workspace-resources.js'
import { createHostFolderDirectoryOwner } from '../../../../apps/host/src/folder-directory-owner.js'
import { createHostFolderSpaceResource } from '../../../../apps/host/src/folder-space-resource.js'
import { createHostSnapshotObservation } from '../../../../apps/host/src/snapshot-observation.js'
import { createHostContent } from '../../../../apps/host/src/content-owner.js'

export async function sourceFolderFixture(close: Array<() => unknown | Promise<unknown>>, workspaces: Array<{id:string;hostId:string;path:string;name:string}> = []) {
  const owner = await rpcOwnerFixture(['managed']); close.push(owner.close)
  const root=owner.root, directory=join(root,'selected-folder'), configurationPath=join(root,'config.json'), source={runtimeId:'original-source-B',ownerInstanceId:'original-instance-B'}
  await mkdir(directory); await writeFile(join(directory,'hello.txt'),'Source original file\n')
  await writeFile(configurationPath,JSON.stringify({hosts:[{id:'local',kind:'local',label:'B'}],workspaces,executors:{},appearance:{}}))
  const spatial=new AgentMuxSpatialStateStore(join(root,'spatial.json')), resources=createHostWorkspaceResources(configurationPath,spatial)
  const content=createHostContent({configurationPath,spatial,resources,storage:new AgentMuxNotesStorage(join(root,'notes-location.json'),join(root,'notes'))})
  const server=new AgentMuxControlServer({socketPath:join(root,'rpc.sock'),spatialState:spatial,coreClients:owner.coreClients,
    spatialFolderResource:createHostFolderSpaceResource(configurationPath,resources),spatialFolderDirectory:createHostFolderDirectoryOwner(resources,spatial),
    snapshot:createHostSnapshotObservation(configurationPath,()=>[],resources),...content,
    hostedRuntime:()=>({call:async(method:string,input:{expectedRuntimeId?:string})=>{expect(method).toBe('runtime.owner.identity');return{owner:{...source,protocolVersion:2,processId:process.pid,ctxmux:null,availability:'connected'}}},subscribe:async()=>{throw Error('Whole Host observation is not a Folder prerequisite.')},assertFence:(fence:{runtimeId:string;ownerInstanceId:string})=>{if(fence.runtimeId!==source.runtimeId||fence.ownerInstanceId!==source.ownerInstanceId)throw new AgentMuxError('The original Source instance changed.','RUNTIME_OWNER_MISMATCH')}}) as never})
  await server.start();close.push(()=>server.stop())
  const rpc=await connectAgentMuxRpc({endpoint:{transport:'unix',path:server.path}});close.push(()=>rpc.dispose())
  return {root,directory,configurationPath,source,spatial,resources,rpc,owner,server}
}
