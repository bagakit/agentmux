import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { once } from 'node:events'
import { inspect } from 'node:util'
import type { ChildProcess } from 'node:child_process'
import { CtxmuxClient, type Attachment } from '@ctxmux/sdk'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import { createInputPerformanceRecorder, type InputPerformanceHandle } from '../src/performance-diagnostics.js'
import { headlessFixture, until } from './helpers/headless-runtime-fixture.js'
import { hostedTestClient } from './helpers/hosted-runtime-port.js'
import { RuntimeController } from '../../../apps/desktop/src/main/runtime-controller.js'
import type { AgentMuxClientEvent } from '../src/types.js'
import type { AgentMuxHostedClient } from '../src/hosted-client-contract.js'
import type { SessionControl } from '../../../apps/desktop/src/shared/contracts.js'

vi.mock('electron', () => ({ app: { getPath: () => process.env.AGENTMUX_STATE_DIRECTORY } }))
const cleanup: Array<{ step: string; close(): Promise<void> }> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const { step, close } of cleanup.splice(0).reverse()) {
    try { await close() } catch (error) {
      console.error(`Private Native cleanup (${step}): ${inspect(error, { depth: null })}`)
      errors.push(new Error(`Private Native cleanup (${step}) failed`, { cause: error }))
    }
  }
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (errors.length) throw new AggregateError(errors, 'Private Native attachment cleanup failed', { cause: errors[0] })
})

it('private Native reader loss preserves neighbour Main input and adopted-owner replacement recovers the original output identity', async () => {
  const scope = await headlessFixture(); cleanup.push({ step: 'private Headless fixture', close: () => scope.cleanup() })
  let activatedChild: ChildProcess | undefined
  cleanup.push({ step: 'exact activated child', close: async () => {
    if (!activatedChild || activatedChild.exitCode !== null || activatedChild.signalCode !== null) return
    const ended = once(activatedChild, 'exit')
    activatedChild.kill('SIGTERM'); await ended
  } })
  for (const [key, value] of Object.entries(scope.env)) if (/^(AGENTMUX_|CTXMUX_|HOME$)/u.test(key)) vi.stubEnv(key, value)
  // This is an independently adopted production Core, in this process. Its SDK class
  // is the public package imported above; the separate Headless owner is compiled code.
  const core = new AgentMuxClient({ store: new AgentMuxMemoryAgentSessionStore() })
  cleanup.push({ step: 'adopted Core', close: () => core.dispose() }); await core.connect()
  const native = core.runtimeIdentity()
  expect(native.ownership).toBe('unverified')
  const hosted = await hostedTestClient(core); cleanup.push({ step: 'Hosted consumer', close: () => hosted.dispose() })
  const controller = new RuntimeController(new AgentMuxMemoryAgentSessionStore(), async () => {
    throw new Error('This Main byte consumer already has its exact private Hosted client')
  })
  cleanup.push({ step: 'Main controller', close: () => controller.dispose() })
  const main = controller as unknown as { writeTerminalInput(client: AgentMuxHostedClient,
    control: Extract<SessionControl, { kind: 'terminal' }>, data: string, diagnostic: InputPerformanceHandle, parent: null): Promise<void> }
  const input = createInputPerformanceRecorder()
  const write = async (runId: string, data: string) => {
    const diagnostic = input.begin({ sessionId: null, runId, kind: 'terminal', bytes: Buffer.byteLength(data) })
    await main.writeTerminalInput(hosted.sdk, { kind: 'terminal', hostId: 'local', runId, run: { runId } }, data, diagnostic, null)
  }
  const captures = new Map<string, Attachment>()
  const attach = CtxmuxClient.prototype.attach
  vi.spyOn(CtxmuxClient.prototype, 'attach').mockImplementation(async function (this: CtxmuxClient, ...args) {
    const value = await attach.apply(this, args); captures.set(args[0], value); return value
  })
  const events: AgentMuxClientEvent[] = []; hosted.sdk.onEvent(event => events.push(event))
  const code = "process.stdin.setRawMode(true);process.stdout.write('private-ready:');process.stdin.on('data',b=>process.stdout.write(b));setInterval(()=>{},1000)"
  const first = await hosted.sdk.createTerminal({ createOperationId: 'private-reader-first', workspacePath: scope.root,
    command: process.execPath, args: ['-e', code] })
  const neighbour = await hosted.sdk.createTerminal({ createOperationId: 'private-reader-neighbour', workspacePath: scope.root,
    command: process.execPath, args: ['-e', code] })
  const owned = [first.runId, neighbour.runId]
  cleanup.push({ step: 'exact owned Runs', close: async () => {
    const errors: unknown[] = []
    for (const run of await core.listRuns()) if (owned.includes(run.runId) && run.state === 'running') {
      try { await core.stopTerminal({ runId: run.runId }) } catch (error) { errors.push(new Error(`Private Run ${run.runId} cleanup failed`, { cause: error })) }
    }
    if (errors.length) throw new AggregateError(errors, 'Private exact Run cleanup failed', { cause: errors[0] })
  } })
  await until(() => core.listRuns(), values => values.filter(run => owned.includes(run.runId) && run.latestOutputBytes > 0).length === 2, 'two original private Native PTYs')
  const firstCut = await hosted.sdk.attachTerminal(first.runId, 0, 'raw')
  await hosted.sdk.attachTerminal(neighbour.runId, 0, 'raw')
  const physical = vi.spyOn((core as unknown as { kernel: import('../src/ctxmux-run-adapter.js').CtxmuxRunAdapter }).kernel, 'input')
  const firstReader = captures.get(first.runId)!
  expect(firstReader).toBeDefined()
  firstReader.close() // Public SDK closes this actual Core→Native socket, not a Hosted callback.
  await until(() => events, values => values.some(event => event.type === 'attachment-state' && event.state === 'unavailable' && event.run.runId === first.runId), 'exact original Native reader notice')
  expect(hosted.sdk.runtimeIdentity().instanceId).toBe(native.instanceId)
  await write(neighbour.runId, 'neighbour-after-reader-loss')
  await until(() => events.filter((event): event is Extract<AgentMuxClientEvent, { type: 'terminal-output' }> => event.type === 'terminal-output' && event.run.runId === neighbour.runId).map(event => event.data).join(''), value => value.includes('neighbour-after-reader-loss'), 'Main input and native neighbour echo survive exact reader loss')
  await write(first.runId, 'first-retained-suffix')
  await until(() => core.listRuns(), values => values.find(run => run.runId === first.runId)!.latestOutputBytes > firstCut.run.latestOutputBytes, 'unobserved first output remains Native-owned')
  const refreshed = await hosted.sdk.refreshRunAttachment({ runId: first.runId }, firstCut.run.latestOutputBytes, 'raw')
  expect(Buffer.concat(refreshed.replay.map(chunk => Buffer.from(chunk.dataBytes))).toString()).toBe('first-retained-suffix')
  expect(refreshed.gap).toBeNull(); expect(refreshed.run.pid).toBe(first.pid)
  expect((await core.listRuns()).find(run => run.runId === neighbour.runId)).toMatchObject({ pid: neighbour.pid, state: 'running' })
  expect(events.filter(event => event.type === 'connection-state')).toEqual([])
  const nativeSocket = join(scope.env.AGENTMUX_RUNTIME_DIRECTORY!, 'ctxmux.sock')
  const persistenceRuntime = await new CtxmuxClient({ socketPath: nativeSocket }).runtimeInfo()
  expect(persistenceRuntime.daemonInstanceId).toBe(native.instanceId)
  const persistence = new CtxmuxClient({ socketPath: nativeSocket, expectedRuntimeIdentity: persistenceRuntime })
  const committed = await until(() => persistence.status(first.runId), value =>
    value.durable_output_bytes !== null && value.durable_output_bytes >= refreshed.run.latestOutputBytes,
  'the exact original suffix is committed before Native replacement')
  console.info('PRIVATE_NATIVE_COMMITTED_CUT=' + JSON.stringify({ runId: first.runId,
    originalAfterByte: firstCut.run.latestOutputBytes, deliveredThroughByte: refreshed.run.latestOutputBytes,
    latestOutputBytes: committed.latest_output_bytes, durableOutputBytes: committed.durable_output_bytes }))

  // The semantic owner stays up while this adopted Native actually exits and the
  // fixture starts its replacement on the same durable state. No user process is touched.
  const semanticOwner = scope.owner.ownerInstanceId
  await scope.restartNativeDaemon()
  await until(() => core.runtimeIdentity().instanceId, value => value !== native.instanceId, 'existing Core automatically reconfirms the adopted replacement listener', 20_000)
  expect(scope.owner.ownerInstanceId).toBe(semanticOwner)
  expect(hosted.sdk.runtimeIdentity().instanceId).toBe(native.instanceId)
  // Live observation continues after the suffix already delivered by the exact
  // refresh above. A separate public history read must still recover those bytes.
  const restored = await hosted.sdk.refreshRunAttachment({ runId: first.runId }, refreshed.run.latestOutputBytes, 'raw')
  expect(restored.run.runId).toBe(first.runId)
  expect(restored.run.state).not.toBe('running')
  expect(restored.replay).toEqual([]); expect(restored.gap).toBeNull()
  const retained = await hosted.sdk.readRunReplay({ runId: first.runId }, firstCut.run.latestOutputBytes, 'raw')
  console.info('PRIVATE_NATIVE_RETAINED_CUT=' + JSON.stringify({ runId: retained.run.runId,
    latestOutputBytes: retained.run.latestOutputBytes,
    replayBytes: retained.replay.reduce((sum, chunk) => sum + chunk.dataBytes.byteLength, 0), gap: retained.gap }))
  expect(retained.run).toMatchObject({ runId: first.runId, latestOutputBytes: refreshed.run.latestOutputBytes })
  expect(retained.run.state).not.toBe('running'); expect(retained.gap).toBeNull()
  expect(Buffer.concat(retained.replay.map(chunk => Buffer.from(chunk.dataBytes))).toString()).toBe('first-retained-suffix')
  expect(hosted.sdk.runtimeIdentity().instanceId).toBe(core.runtimeIdentity().instanceId)
  expect(hosted.sdk.runtimeIdentity().instanceId).not.toBe(native.instanceId)
  expect(events.filter(event => event.type === 'connection-state')).toEqual([])
  // A new explicit test Run proves Main consumes the confirmed new Native fence;
  // it does not impersonate process continuity for the ended original Runs.
  const explicit = await hosted.sdk.createTerminal({ createOperationId: 'private-explicit-after-native-replacement', workspacePath: scope.root,
    command: process.execPath, args: ['-e', code] })
  owned.push(explicit.runId)
  await until(() => core.listRuns(), values => values.find(run => run.runId === explicit.runId)!.latestOutputBytes > 0, 'explicit post-replacement test PTY')
  await hosted.sdk.attachTerminal(explicit.runId, 0, 'raw')
  await write(explicit.runId, 'new-fence-from-exact-cut')
  await until(() => events.filter((event): event is Extract<AgentMuxClientEvent, { type: 'terminal-output' }> => event.type === 'terminal-output' && event.run.runId === explicit.runId).map(event => event.data).join(''), value => value.includes('new-fence-from-exact-cut'), 'Main input consumes the replacement Native initial-cut receipt')
  expect(physical.mock.calls).toHaveLength(3)

  // Stop the fixture-owned adopted daemon without starting any replacement. An
  // explicit original Core connect must activate the original durable Runtime itself.
  const adoptedReplacement = core.runtimeIdentity().instanceId
  await scope.stopNativeDaemon()
  await until(() => events, values => values.some(event => event.type === 'attachment-state' && event.state === 'unavailable' && event.run.runId === explicit.runId), 'original adopted daemon loss before explicit reconnect')
  try { await core.connect() }
  finally {
    const activated = (core as unknown as { kernel: { observedActivation: {
      child: ChildProcess; stateDirectory: string; daemonInstanceId: string
    } | null } }).kernel.observedActivation
    // Even a failed post-spawn handshake leaves this exact child alive. Register it
    // for private cleanup before assertions, without assuming another owner's PID.
    if (activated?.stateDirectory === join(scope.env.AGENTMUX_STATE_DIRECTORY!, 'ctxmux')) activatedChild = activated.child
  }
  expect(activatedChild?.pid).toBeGreaterThan(1)
  expect(core.runtimeIdentity().instanceId).not.toBe(adoptedReplacement)
  await hosted.sdk.refreshRunAttachment({ runId: explicit.runId }, 0, 'raw')
  expect(hosted.sdk.runtimeIdentity().instanceId).toBe(core.runtimeIdentity().instanceId)
  const afterExplicit = await hosted.sdk.createTerminal({ createOperationId: 'private-input-after-explicit-activation',
    workspacePath: scope.root, command: process.execPath, args: ['-e', code] })
  owned.push(afterExplicit.runId)
  await until(() => core.listRuns(), values => values.find(run => run.runId === afterExplicit.runId)!.latestOutputBytes > 0, 'explicitly reactivated private Runtime PTY')
  await hosted.sdk.attachTerminal(afterExplicit.runId, 0, 'raw')
  await write(afterExplicit.runId, 'explicit-connect-restored-input')
  await until(() => events.filter((event): event is Extract<AgentMuxClientEvent, { type: 'terminal-output' }> => event.type === 'terminal-output' && event.run.runId === afterExplicit.runId).map(event => event.data).join(''), value => value.includes('explicit-connect-restored-input'), 'Main input after original explicit connect activated Native')
  expect(physical.mock.calls).toHaveLength(4)
  expect(new Set(physical.mock.calls.map(call => call[1].operationId)).size).toBe(4)
  console.info('PRIVATE_NATIVE_ATTACHMENT_PROOF=' + JSON.stringify({ originalNative: native.instanceId,
    replacementNative: core.runtimeIdentity().instanceId, semanticOwner, originalRun: first.runId,
    neighbourRun: neighbour.runId, neighbourPid: neighbour.pid, readerClose: 'public SDK Attachment.close',
    exactCursor: firstCut.run.latestOutputBytes, suffixBytes: Buffer.byteLength('first-retained-suffix'),
    sourceCore: 'production independently adopted Core', consumer: 'original Main writeTerminalInput -> Hosted initial owner -> Core -> official Native',
    exactInputOperations: physical.mock.calls.length, explicitConnectActivated: true, automaticInputReplays: 0 }))
}, 90_000)
