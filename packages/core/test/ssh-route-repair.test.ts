import { afterEach, expect, it, vi } from 'vitest'
import { resolve, join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { connectSshAgentMux } from '../src/runtime-client.js'
import { headlessFixture, until } from './helpers/headless-runtime-fixture.js'
import { sshRouteFixture } from './helpers/ssh-route-fixture.js'
import type { AgentMuxClientEvent, AgentSessionHistoryObservation } from '../src/types.js'
const closes: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.unstubAllEnvs() })

it.skipIf(process.env.AGENTMUX_REAL_SSH_ROUTE_E2E !== '1')('repairs a broken authenticated SSH route while original consumers, Run PID, history and ordered readers survive', async () => {
  const scope = await headlessFixture(); closes.push(scope.cleanup)
  const ssh = await sshRouteFixture(); closes.push(ssh.cleanup)
  const first = await ssh.route(), second = await ssh.route()
  vi.stubEnv('PATH', ssh.root + ':' + process.env.PATH)
  const target = { ...first, hostId: 'remote', remoteSocketPath: scope.socketPath }
  const client = await connectSshAgentMux({ expectedRuntimeId: scope.owner.runtimeId, target })
  closes.push(() => client.dispose())
  const other = await connectSshAgentMux({ expectedRuntimeId: scope.owner.runtimeId, target: { ...target, ...second } })
  closes.push(() => other.dispose())
  const events: AgentMuxClientEvent[] = [], otherEvents: AgentMuxClientEvent[] = []
  client.onEvent(event => events.push(event)); other.onEvent(event => otherEvents.push(event))
  const run = await client.createTerminal({ createOperationId: 'original-terminal', workspacePath: scope.root, command: process.execPath,
    args: ['-e', "process.stdin.setRawMode(true);process.stdout.write('ready');process.stdin.on('data',b=>process.stdout.write(b));setInterval(()=>{},1000)"] })
  await until(() => client.listRuns(), values => values.some(value => value.runId === run.runId && value.latestOutputBytes === 5), 'ready original Run')
  await client.attachTerminal(run.runId, 5); await other.attachTerminal(run.runId, 5)
  const session = await client.createAgent({ providerId: 'codex', executorId: 'codex', workspacePath: scope.root,
    createOperationId: 'original-session', env: { AGENTMUX_FAKE_NATIVE_RECORD: '1' }, commandOverride: resolve(import.meta.dirname, 'fixtures/fake-codex-cli.mjs') })
  await until(() => client.agentSession(session.agentSessionId), value => value.nativeHandle?.kind === 'provider', 'original native handle')
  const historyEvents: AgentSessionHistoryObservation[] = []
  const history = await client.observeSessionHistory(session.agentSessionId, event => historyEvents.push(event)); closes.push(async () => history.dispose())
  await until(() => historyEvents.length, count => count > 0, 'original history watch')
  const agentRun = (await client.listRuns()).find(value => value.runId === session.run.runId)!
  const nativeHandle = client.agentSession(session.agentSessionId).nativeHandle
  const native = client.runtimeIdentity(), originalOwner = client.runtimeOwnerIdentity()!
  await client.writeTerminal(run, { operationId: 'before', ownerInstanceId: native.instanceId, expectedByte: 0, data: 'A' })
  await until(output, text => text === 'A', 'first ordered byte')
  const oldPid = (await ssh.channelPids())[0]!
  first.stop(); process.kill(oldPid, 'SIGTERM')
  const prepared = await client.prepareRoute({ ...target, ...second })
  expect(prepared.owner.runtimeId).toBe(originalOwner.runtimeId)
  prepared.assertCurrent(); prepared.activate()
  await until(() => events, values => values.some(value => value.type === 'connection-state' && value.state === 'restored'), 'original event reader restored')
  await until(() => events, values => values.some(value => value.type === 'attachment-state' && value.state === 'restored' && value.run.runId === run.runId), 'original Attachment restored')
  const frontier = historyEvents.length
  await until(() => historyEvents.length, count => count > frontier, 'same history intent resumed')
  expect((await client.listRuns()).find(value => value.runId === run.runId)).toMatchObject({ pid: run.pid, state: 'running', acceptedInputBytes: 1 })
  await client.writeTerminal(run, { operationId: 'after', ownerInstanceId: native.instanceId, expectedByte: 1, data: 'B' })
  await until(output, text => text === 'AB', 'same reader exact ordered bytes')
  await until(() => otherEvents.filter(value => value.type === 'terminal-output' && value.run.runId === run.runId).map(value => value.data).join(''), text => text === 'AB', 'independent reader remains intact')
  await other.releaseRunAttachment(run)
  await client.writeTerminal(run, { operationId: 'independent', ownerInstanceId: native.instanceId, expectedByte: 2, data: 'C' })
  await until(output, text => text === 'ABC', 'releasing peer cannot revoke retained reader')
  const cancelled = new AbortController(); cancelled.abort()
  await expect(client.prepareRoute({ ...target, ...second }, cancelled.signal)).rejects.toMatchObject({ code: 'CONTROL_CANCELLED' })
  const stale = await client.prepareRoute({ ...target, ...second })
  client.setRemoteCommand(second.remoteCommand)
  expect(() => stale.assertCurrent()).toThrow(); await stale.dispose()
  expect(client.agentSession(session.agentSessionId)).toMatchObject({ run: session.run, nativeHandle })
  expect((await client.listRuns()).find(value => value.runId === session.run.runId)).toMatchObject({ pid: agentRun.pid, state: 'running' })
  const wrong = await headlessFixture(); closes.push(wrong.cleanup)
  await expect(client.prepareRoute({ ...target, ...second, remoteSocketPath: wrong.socketPath })).rejects.toMatchObject({ code: 'RUNTIME_OWNER_MISMATCH' })
  await expect(client.prepareRoute({ ...target, ...second, user: 'nonexistent-agentmux-user' })).rejects.toThrow()
  expect((await client.listRuns()).find(value => value.runId === run.runId)).toMatchObject({ pid: run.pid, acceptedInputBytes: 3 })
  await scope.failInput({ disposition: 'unknown', confirmedInputBytes: 1 })
  await expect(client.writeTerminal(run, { operationId: 'unknown-input', ownerInstanceId: native.instanceId, expectedByte: 3, data: 'D' })).rejects.toMatchObject({ controlFailure: { disposition: 'unknown' } })
  const renewal = await client.prepareRoute({ ...target, ...second }); renewal.assertCurrent(); renewal.activate()
  await until(() => client.listRuns(), values => values.some(value => value.runId === run.runId), 'route renewal')
  expect(await scope.inputFailureCalls()).toEqual(['unknown-input'])
  expect((await client.listRuns()).find(value => value.runId === run.runId)).toMatchObject({ acceptedInputBytes: 4 })
  // A real semantic owner process restart keeps the same Native Run and durable Session.
  await scope.restart()
  await until(async () => { try { await client.connect(); return client.runtimeOwnerIdentity() } catch { return null } }, owner => owner?.ownerInstanceId === scope.owner.ownerInstanceId, 'same Runtime after real owner restart')
  expect(client.agentSession(session.agentSessionId)).toMatchObject({ agentSessionId: session.agentSessionId, run: session.run, nativeHandle })
  expect((await client.listRuns()).find(value => value.runId === session.run.runId)).toMatchObject({ pid: agentRun.pid, state: 'running' })
  expect((await client.listRuns()).find(value => value.runId === run.runId)).toMatchObject({ pid: run.pid, state: 'running', acceptedInputBytes: 4 })
  const replay = await client.readRunReplay(run, 0, 'raw')
  const retainedBytes = Buffer.concat(replay.replay.map(value => Buffer.from(value.dataBytes))).toString()
  expect(retainedBytes).toContain('ABCD')
  if (process.env.AGENTMUX_ROUTE_PROOF_DIRECTORY) await writeFile(join(process.env.AGENTMUX_ROUTE_PROOF_DIRECTORY, 'native-openssh-receipt.json'), JSON.stringify({
    schema: 'agentmux.remote-route-proof.v1', actualOpenSsh: true, strictPrivateHostKeys: true, twoRoutes: [first.port, second.port],
    runtimeId: originalOwner.runtimeId, ownerBefore: originalOwner.ownerInstanceId, ownerAfterRestart: scope.owner.ownerInstanceId,
    native, terminal: { runId: run.runId, pid: run.pid, acceptedInputBytes: 4, orderedObserved: output(), retainedBytes },
    session: { agentSessionId: session.agentSessionId, runId: session.run.runId, pid: agentRun.pid, nativeHandle },
    independentReaders: 2, historyChanges: historyEvents.length, unknownInputCalls: await scope.inputFailureCalls(),
    rejectedWrongRuntime: true, rejectedWrongSshAccount: true, cancelledCandidate: true, staleCandidate: true,
    originalRouteUnavailable: true, realOwnerRestart: true
  }, null, 2))
  await client.stopAgent(session.agentSessionId, session.run); await client.stopTerminal(run)
  function output() { return events.filter(value => value.type === 'terminal-output' && value.run.runId === run.runId).map(value => value.data).join('') }
}, 120_000)
