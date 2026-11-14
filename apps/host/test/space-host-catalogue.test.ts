import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import * as core from '@agentmux/core'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'
import { startAgentMuxHost } from '../src/host.js'
const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { try { for (const close of cleanup.splice(0).reverse()) await close() } finally { vi.restoreAllMocks(); vi.unstubAllEnvs() } })

it('the actual headless Host serves its original configured Agent choices without Desktop or a whole Host probe', async () => {
  const original = await rpcOwnerFixture([], core); cleanup.push(original.close); await original.client.dispose()
  const configurationPath = join(original.root, 'config.json'), socketPath = join(original.root, 'host.sock')
  const hosts = [{id:'local',kind:'local',label:'Original B'},{id:'D-in-B',kind:'ssh',label:'Original D',hostname:'private-proof-D',runtimeId:'original-d-runtime'}]
  const config = {hosts,workspaces:[],executors:{},appearance:{}}
  await writeFile(configurationPath, JSON.stringify(config))
  const connect = vi.spyOn(core.AgentMuxClient.prototype, 'connect').mockImplementationOnce(async function () {
    const inner = this as unknown as typeof original.inner
    await inner.registry.load('local'); inner.connected = true; inner.kernel.isConnected = () => false
  })
  let host: Awaited<ReturnType<typeof startAgentMuxHost>>
  try { host = await startAgentMuxHost({store:original.store,socketPath,configurationPath,desktopSocketPath:join(original.root,'no-desktop.sock'),mobileBuildDirectory:join(original.root,'no-mobile')}) }
  finally { connect.mockRestore() }
  cleanup.push(()=>host.dispose())
  const rpc = await core.connectAgentMuxRpc({endpoint:{transport:'unix',path:socketPath}});cleanup.push(()=>rpc.dispose())
  const before = await readFile(configurationPath,'utf8')
  await expect(rpc.call('settings.hosts.ls',{})).resolves.toEqual({hosts})
  expect(await readFile(configurationPath,'utf8')).toBe(before)
  // A topology read does not qualify every executor or repair an unrelated field.
  const renamed = hosts.map(value=>value.id==='D-in-B'?{...value,label:'Original D renamed'}:value)
  await writeFile(configurationPath,JSON.stringify({...config,hosts:renamed,executors:'unrelated invalid executor metadata'}))
  await expect(rpc.call('settings.hosts.ls',{})).resolves.toEqual({hosts:renamed})
  expect((await rpc.call('runtime.owner.identity',{})).owner.runtimeId).toBeTruthy()
})
