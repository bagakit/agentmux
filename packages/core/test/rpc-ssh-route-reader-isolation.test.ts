import { afterEach, expect, it, vi } from 'vitest'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { headlessFixture } from './helpers/headless-runtime-fixture.js'
import { sshRouteFixture } from './helpers/ssh-route-fixture.js'
const closes: Array<() => Promise<void>> = []
afterEach(async () => { for(const close of closes.splice(0).reverse()) await close(); vi.unstubAllEnvs(); vi.restoreAllMocks() })
it.skipIf(process.env.AGENTMUX_REAL_SSH_ROUTE_E2E !== '1')('an arbitrary reader end callback cannot throw after route persistence or prevent a peer from settling', async () => {
  const scope = await headlessFixture(); closes.push(scope.cleanup)
  const ssh = await sshRouteFixture(); closes.push(ssh.cleanup)
  const first = await ssh.route(), second = await ssh.route(); vi.stubEnv('PATH',ssh.root+':'+process.env.PATH)
  const endpoint = { transport: 'ssh' as const, host: first.hostname, user: first.user, port: first.port, identityFile: first.identityFile, command: first.remoteCommand, socketPath: scope.socketPath }
  const rpc = await connectAgentMuxRpc({ endpoint }); closes.push(() => rpc.dispose())
  const fence = { runtimeId: scope.owner.runtimeId, ownerInstanceId: scope.owner.ownerInstanceId }
  const bad = vi.fn(() => { throw new Error('This public reader is broken') }), peer = vi.fn(), warning = vi.spyOn(console,'warn').mockImplementation(() => {})
  await rpc.subscribe('runtime.events',{ consumerId: 'bad-reader', fence },{onInitial:()=>{},onEvent:()=>{},onEnd:bad})
  await rpc.subscribe('runtime.events',{ consumerId: 'healthy-reader', fence },{onInitial:()=>{},onEvent:()=>{},onEnd:peer})
  const prepared = await rpc.prepareSshRoute({ ...endpoint, port: second.port },scope.owner.runtimeId)
  prepared.assertCurrent(); expect(() => prepared.activate()).not.toThrow()
  expect(bad).toHaveBeenCalledOnce(); expect(peer).toHaveBeenCalledOnce(); expect(warning).toHaveBeenCalledOnce()
  expect((await rpc.call('runtime.owner.identity',{expectedRuntimeId:scope.owner.runtimeId})).owner.runtimeId).toBe(scope.owner.runtimeId)
},60_000)
