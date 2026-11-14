import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { createHash } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { hashPublisherToken } from '@agentmux/relay/gateway'
import { exportPublicKey } from '@agentmux/relay/e2ee'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client.js'
import { loadOrCreateRelayKeyPair } from '../../../packages/core/src/rpc-relay-keypair.js'
import { headlessFixture, until } from '../../../packages/core/test/helpers/headless-runtime-fixture.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { mobileWebFixture } from './helpers/mobile-web-fixture.js'

const cleanup: Array<() => void | Promise<void>> = []
const privateRoots: string[] = []
const privateProcesses: Array<{ role: string; pid: number }> = []
function observeProcess(role: string, pid: number | undefined) {
  if (pid === undefined) throw new Error('Private process has no PID: ' + role)
  privateProcesses.push({ role, pid })
}
function processAlive(pid: number) {
  try { process.kill(pid, 0); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}
afterEach(async () => {
  const failures: unknown[] = []
  for (const close of cleanup.splice(0).reverse()) { try { await close() } catch (error) { failures.push(error) } }
  try { await until(() => privateProcesses.every(value => !processAlive(value.pid)), Boolean, 'only this test topology processes exited', 5000) } catch (error) { failures.push(error) }
  const roots = await Promise.all(privateRoots.splice(0).map(async path => ({ path, absent: await access(path).then(() => false, () => true) })))
  const processes = privateProcesses.splice(0).map(value => ({ ...value, exited: !processAlive(value.pid) }))
  if (roots.some(value => !value.absent)) failures.push(new Error('Private topology root remains after cleanup'))
  await writeFile(resolve('.local/state/outbound-hub-access/t3-native-cleanup.json'), JSON.stringify({
    schema: 'agentmux.outbound-relay-native-cleanup.v1', passed: failures.length === 0, roots, processes,
    failures: failures.map(value => String(value)),
  }, null, 2) + '\n')
  if (failures.length) throw new AggregateError(failures, 'Private outbound topology cleanup failed')
})
async function unusedPort() {
  const socket = createServer(); await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve))
  const address = socket.address(); if (!address || typeof address === 'string') throw Error('Private port did not bind')
  await new Promise<void>(resolve => socket.close(() => resolve())); return address.port
}
async function closeChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const stopped = once(child, 'exit'); child.kill('SIGTERM'); await stopped
}
async function spawnGateway(config: string) {
  const child = spawn(process.execPath, [resolve('packages/relay/bin/agentmux-relay'), 'serve', '--config', config], { stdio: ['ignore', 'pipe', 'pipe'] })
  observeProcess('standalone gateway', child.pid)
  const lines = createInterface({ input: child.stdout! }), errors: string[] = []
  child.stderr!.on('data', value => errors.push(String(value)))
  const ready = Promise.race([
    once(lines, 'line').then(([line]) => JSON.parse(line)),
    once(child, 'exit').then(([code]) => { throw Error('Private gateway exited ' + code + ': ' + errors.join('')) }),
  ])
  cleanup.push(async () => { lines.close(); await closeChild(child) })
  return { child, receipt: await ready }
}
const sha = (value: string) => createHash('sha256').update(value).digest('hex')

it('actual standalone and Core-embedded gateways preserve original Native work through restart and a lost applied prompt reply', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amux-outbound-native-')); privateRoots.push(root); cleanup.push(() => rm(root, { recursive: true, force: true }))
  const clientHome = join(root, 'client-home'); await mkdir(clientHome)
  const key = await loadOrCreateRelayKeyPair(join(clientHome, '.agentmux', 'relay-client-keypair.json'))
  const relayPort = await unusedPort(), endpoint = `127.0.0.1:${relayPort}`, unknownOperation = 'outbound-native-unknown-original'
  const tokenA = 'private-native-publisher-a', tokenB = 'private-native-publisher-b'
  const a = await mobileWebFixture({ nativeRecord: true, outboundRelayTest: { relay: { endpoint, useTls: false }, publisherToken: tokenA,
    allowedClientKeys: [exportPublicKey(key.publicKey)], holdOperationId: unknownOperation } })
  cleanup.push(async () => {
    if (a.native.ownerProcess.exitCode !== null || a.native.ownerProcess.signalCode !== null) {
      await a.native.restart(); observeProcess('publisher A cleanup Core', a.native.ownerProcess.pid)
    }
    await a.close()
  })
  privateRoots.push(a.native.root); observeProcess('publisher A original Core', a.native.ownerProcess.pid); observeProcess('publisher A official ctxmux', a.native.nativeProcessId)
  const b = await mobileWebFixture({ nativeRecord: true, outboundRelayTest: { relay: { endpoint, useTls: false }, publisherToken: tokenB,
    allowedClientKeys: [exportPublicKey(key.publicKey)] } })
  cleanup.push(() => b.close())
  privateRoots.push(b.native.root); observeProcess('publisher B Core', b.native.ownerProcess.pid); observeProcess('publisher B official ctxmux', b.native.nativeProcessId)
  const publishers = [{ serverId: a.info.offer.serverId, tokenHash: hashPublisherToken(tokenA) }, { serverId: b.info.offer.serverId, tokenHash: hashPublisherToken(tokenB) }]
  const config = join(root, 'gateway.json')
  await writeFile(config, JSON.stringify({ host: '127.0.0.1', port: relayPort, publishers }), { mode: 0o600 })
  const standalone = await spawnGateway(config)
  expect(standalone.receipt).toMatchObject({ operation: 'serve', service: 'agentmux-relay', port: relayPort })
  const localA = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: a.native.socketPath } })
  const localB = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: b.native.socketPath } })
  cleanup.push(() => localA.dispose()); cleanup.push(() => localB.dispose())
  const linkA = await until(() => localA.call('device.link', { via: 'gateway' }), value => value.mobileAccess.state === 'connected', 'publisher A actual control connection')
  const linkB = await until(() => localB.call('device.link', { via: 'gateway' }), value => value.mobileAccess.state === 'connected', 'publisher B actual control connection')
  const cliEnv = objectCliEnvironment(root, { HOME: clientHome })
  const cli = (url: string, args: string[]) => runCompiledObjectCli(['--endpoint', url, ...args], cliEnv, '', 30000)
  const inspection = await cli(linkA.url, ['agent', 'inspect', '--session', a.session.agentSessionId])
  expect(inspection.code, inspection.stderr).toBe(0)
  expect(JSON.parse(inspection.stdout).result).toMatchObject({ session: { agentSessionId: a.session.agentSessionId, run: a.session.run } })
  const connect = async (link: typeof linkA) => {
    const { parseConnectionOfferUrl } = await import('@agentmux/relay/offer')
    const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'relay', offer: parseConnectionOfferUrl(link.url)! }, relayKeyPair: key })
    cleanup.push(() => rpc.dispose()); return rpc
  }
  let rpcA = await connect(linkA), rpcB = await connect(linkB)
  const beforeOwnerA = (await rpcA.call('runtime.owner.identity', {})).owner
  const beforeOwnerB = (await rpcB.call('runtime.owner.identity', {})).owner
  expect(beforeOwnerA.ctxmux).not.toBeNull(); expect(beforeOwnerB.ctxmux).not.toBeNull()
  expect(beforeOwnerA.runtimeId).not.toBe(beforeOwnerB.runtimeId)
  const beforeRunA = (await a.client.statusAgent(a.session.agentSessionId)).run
  const beforeRunB = (await b.client.statusAgent(b.session.agentSessionId)).run
  expect(beforeRunA?.pid).toEqual(expect.any(Number)); expect(beforeRunB?.pid).toEqual(expect.any(Number))
  observeProcess('publisher A original Native PTY child', beforeRunA!.pid!); observeProcess('publisher B Native PTY child', beforeRunB!.pid!)
  const output = async () => {
    const replay = await a.client.readRunReplay(a.session.run, 0, 'raw')
    return Buffer.concat(replay.replay.map(frame => Buffer.from(frame.dataBytes))).toString('utf8')
  }
  const nativeMessages = async (fixture = a) => {
    const path = join(fixture.native.env.HOME!, '.codex', 'sessions', 'rollout-' + fixture.session.agentSessionId + '.jsonl')
    return (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      .filter(record => record.type === 'response_item' && record.payload?.type === 'message' && record.payload.role === 'user')
      .map(record => record.payload.content.map((part: { text?: string }) => part.text ?? '').join('')) as string[]
  }
  const stream: string[] = [], endings: unknown[] = []
  const subscription = await rpcA.subscribe('agent.output', { agentSessionId: a.session.agentSessionId, afterByte: 0, follow: true }, {
    onInitial: initial => { expect(initial.run.runId).toBe(a.session.run.runId) },
    onEvent: event => { if (event.type === 'output') stream.push(Buffer.from(event.data.dataBase64, 'base64').toString('utf8')) },
    onEnd: error => endings.push(error),
  })
  cleanup.push(() => subscription.dispose())
  const submit = async (operationId: string, prompt: string, predecessor: string | null) => {
    await until(() => a.client.statusAgent(a.session.agentSessionId), value => value.observation.semantic === 'idle', 'actual Provider hook confirms its initialized idle turn')
    const path = join(root, operationId + '.json')
    await writeFile(path, JSON.stringify({ prompt, expectedRun: a.session.run, afterSubmissionId: predecessor, execution: 'immediate' }))
    return cli(linkA.url, ['agent', 'input', 'submit', '--session', a.session.agentSessionId, '--operation-id', operationId, '--input', path])
  }
  const firstOperation = 'outbound-native-before'
  const first = await submit(firstOperation, 'gateway-before-restart', null)
  expect(first.code, first.stderr).toBe(0)
  const firstKey = JSON.parse(first.stdout).result.key
  expect(firstKey).toMatchObject({ submissionId: firstOperation, agentSessionId: a.session.agentSessionId, expectedRun: a.session.run })
  try {
    const acceptedMessages = await until(() => nativeMessages(), value => value.filter(text => text.includes('gateway-before-restart')).length === 1, 'controlled native CLI accepted the public prompt exactly once')
    const acceptedBody = acceptedMessages.find(text => text.includes('gateway-before-restart'))!
    const acceptedMarker = `codex-submit:${acceptedBody}:accepted`.replaceAll('\r\n', '\n')
    await until(() => stream.join('').replaceAll('\r\n', '\n'), value => value.includes(acceptedMarker), 'actual gateway live subscription includes the exact Native accepted prompt')
  } catch (error) {
    await writeFile(resolve('.local/state/outbound-hub-access/t3-input-stage.json'), JSON.stringify({ first: JSON.parse(first.stdout),
      input: await rpcA.call('agent.input.inspect', { key: firstKey }), nativeMessages: await nativeMessages(), nativeOutput: await output(), stream, endings: endings.map(value => String(value)) }, null, 2) + '\n')
    throw error
  }
  await until(() => nativeMessages(), value => value.filter(text => text.includes('gateway-before-restart')).length === 1, 'controlled native CLI accepted the public prompt exactly once')
  const unknown = submit(unknownOperation, 'gateway-original-unknown', firstOperation)
  const heldPath = join(dirname(a.native.env.AGENTMUX_AGENT_SESSION_STORE!), 'outbound-held-response.json')
  const held = await until(async () => JSON.parse(await readFile(heldPath, 'utf8').catch(() => '{}')),
    value => value.operationId === unknownOperation && value.result?.key?.submissionId === unknownOperation, 'original owner completed selected prompt before response loss')
  await until(() => nativeMessages(), value => value.filter(text => text.includes('gateway-original-unknown')).length === 1, 'real Native applied selected original prompt')
  await closeChild(standalone.child)
  const unknownResult = await unknown
  expect(unknownResult.code).not.toBe(0)
  const unknownReceipt = JSON.parse(unknownResult.stderr)
  expect(unknownReceipt).toMatchObject({ ok: false, operation: 'agent.input.submit', operationId: unknownOperation, error: { code: 'CONTROL_UNAVAILABLE' } })
  await until(() => endings.length, value => value > 0, 'reader ended independently on gateway shutdown')
  expect((await a.client.statusAgent(a.session.agentSessionId)).run).toMatchObject({ runId: a.session.run.runId, pid: beforeRunA!.pid, state: 'running' })
  const restarted = await spawnGateway(config)
  expect(restarted.child.pid).not.toBe(standalone.child.pid)
  await until(() => localA.call('device.link', { via: 'gateway' }), value => value.mobileAccess.state === 'connected', 'original publisher reconnected after gateway restart')
  rpcA = await connect(linkA); rpcB = await connect(linkB)
  expect((await rpcA.call('runtime.owner.identity', {})).owner).toEqual(beforeOwnerA)
  expect((await rpcB.call('runtime.owner.identity', {})).owner).toEqual(beforeOwnerB)
  expect((await localA.call('device.link', { via: 'gateway' })).url).toBe(linkA.url)
  const inspectedInput = await rpcA.call('agent.input.inspect', { key: held.result.key })
  expect(inspectedInput.record ?? inspectedInput.input).not.toBeNull()
  expect(inspectedInput.input?.key ?? inspectedInput.record?.admission?.inputKey).toEqual(held.result.key)
  const accepted = await output()
  expect((await nativeMessages()).filter(text => text.includes('gateway-original-unknown'))).toHaveLength(1)
  const dispatchPath = join(dirname(a.native.env.AGENTMUX_AGENT_SESSION_STORE!), 'outbound-input-dispatch.jsonl')
  const dispatches = (await readFile(dispatchPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  expect(dispatches.filter(value => value.operationId === unknownOperation)).toHaveLength(1)

  // The same original Host route is now carried by a real, independently running Core gateway.
  await closeChild(restarted.child)
  const embeddedPath = join(root, 'embedded-gateway.json')
  await writeFile(embeddedPath, JSON.stringify({ publishers, listen: { host: '127.0.0.1', port: relayPort } }), { mode: 0o600 })
  const ownerKey = 'AGENTMUX_TEST_OWNER_ENTRY', previousOwner = process.env[ownerKey]
  const sourceKey = 'OUTBOUND_RELAY_GATEWAY_TEST_CONFIG', previousSource = process.env[sourceKey]
  process.env[ownerKey] = resolve('apps/host/test/fixtures/relay-gateway-core.mjs'); process.env[sourceKey] = embeddedPath
  let embedded: Awaited<ReturnType<typeof headlessFixture>>
  try { embedded = await headlessFixture() } finally {
    if (previousOwner === undefined) delete process.env[ownerKey]; else process.env[ownerKey] = previousOwner
    if (previousSource === undefined) delete process.env[sourceKey]; else process.env[sourceKey] = previousSource
  }
  cleanup.push(() => embedded.cleanup())
  privateRoots.push(embedded.root); observeProcess('embedded gateway Core', embedded.ownerProcess.pid); observeProcess('embedded gateway official ctxmux', embedded.nativeProcessId)
  const gatewayRpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: embedded.socketPath } }); cleanup.push(() => gatewayRpc.dispose())
  await until(() => gatewayRpc.call('system.relay.inspect', {}), value => value.gateway.state === 'listening', 'actual Core embedded gateway listener')
  expect(embedded.owner.ctxmux).not.toBeNull(); expect(embedded.owner.runtimeId).not.toBe(beforeOwnerA.runtimeId)
  await until(() => localA.call('device.link', { via: 'gateway' }), value => value.mobileAccess.state === 'connected', 'original publisher reached embedded Core gateway')
  const throughCore = await cli(linkA.url, ['agent', 'inspect', '--session', a.session.agentSessionId])
  expect(throughCore.code, throughCore.stderr).toBe(0)
  expect(JSON.parse(throughCore.stdout).result).toMatchObject({ session: { agentSessionId: a.session.agentSessionId, run: a.session.run } })
  rpcA = await connect(linkA); rpcB = await connect(linkB)
  expect((await rpcA.call('runtime.owner.identity', {})).owner).toEqual(beforeOwnerA)
  await a.native.stopOwner()
  const healthyPeer = await cli(linkB.url, ['agent', 'inspect', '--session', b.session.agentSessionId])
  expect(healthyPeer.code, healthyPeer.stderr).toBe(0)
  expect((await rpcB.call('runtime.owner.identity', {})).owner).toEqual(beforeOwnerB)
  expect((await b.client.statusAgent(b.session.agentSessionId)).run).toMatchObject({ runId: b.session.run.runId, pid: beforeRunB!.pid, state: 'running' })
  const embeddedStream: string[] = []
  const embeddedSubscription = await rpcB.subscribe('agent.output', { agentSessionId: b.session.agentSessionId, afterByte: 0, follow: true }, {
    onInitial: initial => { expect(initial.run.runId).toBe(b.session.run.runId) },
    onEvent: event => { if (event.type === 'output') embeddedStream.push(Buffer.from(event.data.dataBase64, 'base64').toString('utf8')) },
  })
  cleanup.push(() => embeddedSubscription.dispose())
  await until(() => b.client.statusAgent(b.session.agentSessionId), value => value.observation.semantic === 'idle', 'unaffected original Provider idle hook through embedded gateway')
  const peerPrompt = 'gateway-peer-through-embedded', peerOperation = 'outbound-native-embedded-peer'
  const peerInput = join(root, 'peer-input.json')
  await writeFile(peerInput, JSON.stringify({ prompt: peerPrompt, expectedRun: b.session.run, afterSubmissionId: null, execution: 'immediate' }))
  const peerWrite = await cli(linkB.url, ['agent', 'input', 'submit', '--session', b.session.agentSessionId, '--operation-id', peerOperation, '--input', peerInput])
  expect(peerWrite.code, peerWrite.stderr).toBe(0)
  expect(JSON.parse(peerWrite.stdout).result.key).toMatchObject({ agentSessionId: b.session.agentSessionId, submissionId: peerOperation, expectedRun: b.session.run })
  const peerMessages = await until(() => nativeMessages(b), value => value.filter(text => text.includes(peerPrompt)).length === 1, 'unaffected Native accepted CLI write through embedded Core gateway')
  const peerMarker = `codex-submit:${peerMessages.find(text => text.includes(peerPrompt))!}:accepted`.replaceAll('\r\n', '\n')
  await until(() => embeddedStream.join('').replaceAll('\r\n', '\n'), value => value.includes(peerMarker), 'independent live SDK stream through embedded Core gateway')
  await a.native.restart()
  observeProcess('publisher A restarted Core', a.native.ownerProcess.pid)
  const restored = await a.native.client()
  expect((await restored.readAgentSession(a.session.agentSessionId))?.run).toEqual(a.session.run)
  const currentLink = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: a.native.socketPath } }); cleanup.push(() => currentLink.dispose())
  await until(() => currentLink.call('device.link', { via: 'gateway' }), value => value.mobileAccess.state === 'connected', 'same original Host republished after its Core restart')
  expect((await currentLink.call('device.link', { via: 'gateway' })).url).toBe(linkA.url)
  expect(a.native.owner.runtimeId).toBe(beforeOwnerA.runtimeId)
  expect(a.native.owner.ownerInstanceId).not.toBe(beforeOwnerA.ownerInstanceId)
  expect(a.native.owner.ctxmux?.instanceId).toBe(beforeOwnerA.ctxmux!.instanceId)
  expect((await restored.statusAgent(a.session.agentSessionId)).run).toMatchObject({ runId: a.session.run.runId, pid: beforeRunA!.pid, state: 'running' })
  const restoredRemote = await connect(linkA)
  const restoredInput = await restoredRemote.call('agent.input.inspect', { key: held.result.key })
  expect(restoredInput.record ?? restoredInput.input).not.toBeNull()
  expect(restoredInput.input?.key ?? restoredInput.record?.admission?.inputKey).toEqual(held.result.key)
  const finalReplay = await restored.readRunReplay(a.session.run, 0, 'raw')
  const finalText = Buffer.concat(finalReplay.replay.map(frame => Buffer.from(frame.dataBytes))).toString('utf8')
  expect((await nativeMessages()).filter(text => text.includes('gateway-original-unknown'))).toHaveLength(1)
  expect((await readFile(dispatchPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(value => value.operationId === unknownOperation)).toHaveLength(1)
  const evidence = { schema: 'agentmux.outbound-relay-native-join.v1', behaviorAssertionsPassed: true,
    topology: { standaloneGatewayProcesses: [standalone.child.pid, restarted.child.pid], embeddedCoreProcess: embedded.ownerProcess.pid,
      publisherProcesses: [a.native.ownerProcess.pid, b.native.ownerProcess.pid], officialNativeProcesses: [a.native.nativeProcessId, b.native.nativeProcessId, embedded.nativeProcessId] },
    original: { runtimeId: beforeOwnerA.runtimeId, nativeInstanceId: beforeOwnerA.ctxmux!.instanceId, sessionId: a.session.agentSessionId, runId: a.session.run.runId, runPid: beforeRunA!.pid,
      serverId: a.info.offer.serverId, daemonPublicKeySHA256: sha(a.info.offer.daemonPublicKeyB64) },
    effects: { unknownOperationId: unknownOperation, originalKey: held.result.key, dispatchCount: 1, nativeAcceptedCount: 1, unknownCliExitCode: unknownResult.code,
      unknownCliReceipt: unknownReceipt, inspectedKeyAfterGatewayRestart: inspectedInput.input?.key ?? inspectedInput.record?.admission?.inputKey,
      inspectedKeyAfterCoreRestart: restoredInput.input?.key ?? restoredInput.record?.admission?.inputKey,
      cliInspectBefore: inspection.code, cliInspectThroughEmbeddedCore: throughCore.code, unaffectedPublisherInspect: healthyPeer.code, liveOutputSeen: true,
      embeddedGatewayCliWrite: peerWrite.code, embeddedGatewayLiveOutputSeen: true, embeddedGatewayLiveOutputSHA256: sha(embeddedStream.join('')),
      exactInputInspectionRetained: (inspectedInput.record ?? inspectedInput.input) !== null && (restoredInput.record ?? restoredInput.input) !== null,
      finalNativeOutputSHA256: sha(finalText), afterGatewayRestartOutputSHA256: sha(accepted) },
    scope: 'Real private official ctxmux daemons and PTY/provider fixture processes, actual Core/Host and compiled CLI. Provider conversation is controlled; no upstream model/network, production Session, CN1 or user home was used.' }
  await writeFile(resolve('.local/state/outbound-hub-access/t3-native-join.json'), JSON.stringify(evidence, null, 2) + '\n')
}, 150000)
