import { afterEach, expect, it } from 'vitest'
import { join } from 'node:path'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { headlessFixture, until } from './helpers/headless-runtime-fixture.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
it('reads an actual private Headless/Native through the selected Desktop route and CLI without creating or attaching a Run', async () => {
  const scope = await headlessFixture(); cleanups.push(() => scope.cleanup())
  const client = await scope.client()
  // A private terminal makes the Native inventory nonempty; no user Agent is created or touched.
  await client.createTerminal({ createOperationId: 'monitor-private-terminal', workspacePath: scope.root, command: process.execPath,
    args: ['-e', "process.stdout.write('private-monitor-output');setInterval(()=>{},1000)"] })
  const before = await until(() => client.runtimeResourceSnapshot(), value => value.runCount > 0 && value.retainedOutputBytes > 0, 'nonempty private Native resource inventory')
  const desktop = new AgentMuxControlServer({ socketPath: join(scope.root, 'control.sock'), coreClients: () => [{ hostId: 'private-native', client }] })
  await desktop.start(); cleanups.push(() => desktop.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: desktop.path } }); cleanups.push(() => rpc.dispose())
  const result = await rpc.call('settings.hosts.inspect', { hostId: 'private-native' })
  expect(result.owner).toMatchObject({ state: 'available', value: { runtimeId: scope.owner.runtimeId, ownerInstanceId: scope.owner.ownerInstanceId } })
  expect(result.nativeIdentity).toMatchObject({ state: 'available', value: { instanceId: scope.owner.ctxmux!.instanceId } })
  expect(result.diagnostics).toMatchObject({ state: 'available', value: { ctxmux: { serving: { instanceId: scope.owner.ctxmux!.instanceId } } } })
  expect(result.resources).toMatchObject({ state: 'available', value: { runCount: before.runCount, attachments: before.attachments, retainedOutputBytes: before.retainedOutputBytes } })
  const cli = await runCompiledObjectCli(['settings', 'hosts', 'inspect', '--host', 'private-native'], objectCliEnvironment(scope.root))
  expect(cli.code, cli.stderr).toBe(0)
  expect(JSON.parse(cli.stdout).result.nativeIdentity).toMatchObject({ state: 'available', value: { instanceId: scope.owner.ctxmux!.instanceId } })
  const after = await client.runtimeResourceSnapshot()
  expect(after.runCount).toBe(before.runCount); expect(after.attachments).toBe(before.attachments)
  expect(client.runtimeOwnerIdentity()?.ownerInstanceId).toBe(scope.owner.ownerInstanceId)
}, 60000)
