import { afterEach, expect, it, vi } from 'vitest'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as core from '@agentmux/core'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'
import { startAgentMuxHost } from '../src/host.js'

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { try { for (const close of cleanup.splice(0).reverse()) await close() } finally { vi.restoreAllMocks(); vi.unstubAllEnvs() } })

it('the production Host assembles Source directory admission, snapshot and Files over one original resource owner', async () => {
  const original=await rpcOwnerFixture([],core); cleanup.push(original.close); await original.client.dispose()
  const configurationPath=join(original.root,'config.json'), directory=join(original.root,'explicit-project'), socketPath=join(original.root,'host.sock')
  await mkdir(directory); await writeFile(join(directory,'original.txt'),'Production Host original file')
  await writeFile(configurationPath,JSON.stringify({hosts:[{id:'local',kind:'local',label:'B'}],workspaces:[],executors:{},appearance:{}}))
  const originalConfig=await readFile(configurationPath,'utf8')
  const connect=vi.spyOn(core.AgentMuxClient.prototype,'connect').mockImplementationOnce(async function(this: core.AgentMuxClient){
    const inner=this as unknown as typeof original.inner
    await inner.registry.load('local'); inner.connected=true; inner.kernel.isConnected=()=>false
  })
  let host: Awaited<ReturnType<typeof startAgentMuxHost>>
  try { host=await startAgentMuxHost({store:original.store,socketPath,configurationPath,desktopSocketPath:join(original.root,'no-desktop.sock'),mobileBuildDirectory:join(original.root,'no-mobile')}) }
  finally { connect.mockRestore() }
  cleanup.push(()=>host.dispose())
  const rpc=await core.connectAgentMuxRpc({endpoint:{transport:'unix',path:socketPath}}); cleanup.push(()=>rpc.dispose())
  const identity=await rpc.call('runtime.owner.identity',{})
  const observed=await rpc.call('space.folder.inspect',{runtimeId:identity.owner.runtimeId,path:directory})
  expect(observed.resource).not.toBeNull()
  const saved=await rpc.call('space.folder.register',{runtimeId:identity.owner.runtimeId,directory:observed.resource!})
  const snapshot=await rpc.call('app.snapshot',{include:['workspaces']})
  expect(snapshot.workspaces).toContainEqual(expect.objectContaining({workspaceId:saved.workspaceId,path:directory}))
  const result=await rpc.call('file.read',{zoneId:saved.zoneId,path:'original.txt',expectedResource:{hostId:'local',workspaceId:saved.workspaceId,workspacePath:directory}})
  expect(result.result).toMatchObject({status:'read',document:{content:'Production Host original file'}})
  // The same shared owner must also serve the original configured-register shape.
  // A later object spread must not replace it with a config-only resolver.
  const repeated=await rpc.call('space.folder.register',{runtimeId:identity.owner.runtimeId,workspaceId:saved.workspaceId,
    expectedResource:{hostId:'local',workspacePath:directory,projectRootPath:directory}})
  expect(repeated).toMatchObject({reference:saved.reference,zoneId:saved.zoneId,workspaceId:saved.workspaceId,created:false})
  expect(await readFile(configurationPath,'utf8')).toBe(originalConfig)
})
