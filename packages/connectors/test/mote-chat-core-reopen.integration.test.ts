import { afterEach, expect, it, vi } from 'vitest'
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createHash, createHmac } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { DatabaseSync } from 'node:sqlite'
import ts from 'typescript'
import * as core from '@agentmux/core'
import { headlessFixture, until } from '../../core/test/helpers/headless-runtime-fixture.js'
import { ScratchTopics } from '../../../apps/host/src/mote-resources.js'
import { directoryIdentity, homeZoneId, SCRATCH_WORKSPACE_ID } from '../../../apps/host/src/mote-model.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllEnvs() })
it('retains the same original Mote admission, debit and native Session through a real Core owner process restart and publishes its late generation reply once', async () => {
  const assets = await mkdtemp('/tmp/amx-mote-owner-assets-'); cleanup.push(() => rm(assets, { recursive: true, force: true }))
  const cSource = resolve('packages/core/native/native-socket-peer.c'), listenerSource = resolve('packages/core/src/control-endpoint-listener-worker.ts')
  await promisify(execFile)('cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', cSource, '-o', join(assets, 'native-socket-peer-darwin')])
  await writeFile(join(assets, 'control-endpoint-listener-worker.mjs'), ts.transpileModule(await readFile(listenerSource, 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext } }).outputText)
  vi.stubEnv('MOTE_CHAT_RESTART_ASSETS', assets)
  if (process.env.MOTE_CHAT_RESTART_TRACE) vi.stubEnv('MOTE_CHAT_RESTART_TRACE', resolve(process.env.MOTE_CHAT_RESTART_TRACE))
  vi.stubEnv('AGENTMUX_TEST_OWNER_ENTRY', resolve(import.meta.dirname, 'fixtures/mote-chat-core-owner.mjs'))
  const scope = await headlessFixture({ ownerNodeArgs: ['--experimental-transform-types', '--import', resolve(import.meta.dirname, 'fixtures/mote-chat-core-owner-loader.mjs')] })
  let sid: string | undefined
  cleanup.push(async () => { try { if (sid) { const client = await scope.client(), current = await client.statusAgent(sid); if (current.run.state === 'running') await client.stopAgent(sid, current.session.run) } } finally { await scope.cleanup() } })
  const state = scope.env.AGENTMUX_STATE_DIRECTORY!, workspace = { id: SCRATCH_WORKSPACE_ID, hostId: 'local', path: join(scope.root, 'scratch'), name: 'Original Mote', kind: 'folder' as const }
  await mkdir(workspace.path)
  const topic = await new ScratchTopics().ensureMote(workspace, 'view:core-reopen-original'), target = { spaceId: directoryIdentity('local', topic.identityDirectoryPath!), zoneId: homeZoneId(directoryIdentity('local', topic.identityDirectoryPath!)), expectedResource: { hostId: 'local', workspaceId: workspace.id, workspacePath: workspace.path } }
  await writeFile(join(state, 'original-configuration.json'), JSON.stringify({ workspaces: [workspace], executors: { native: { providerId: 'claude', label: 'Private original socket executable', command: process.execPath,
    args: ['--experimental-transform-types', '--import', resolve(import.meta.dirname, 'fixtures/mote-chat-core-owner-loader.mjs'), resolve(import.meta.dirname, 'fixtures/mote-chat-native-executable.mjs')],
    env: { MOTE_CHAT_RESTART_ASSETS: assets, ...(process.env.MOTE_CHAT_RESTART_TRACE ? { MOTE_CHAT_RESTART_TRACE: process.env.MOTE_CHAT_RESTART_TRACE } : {}) }, injectAgentMuxGuide: false } }, appearance: {} }))
  await writeFile(join(topic.physicalDirectoryPath!, 'MOTE.md'), '---\nversion: 1\ndefaults:\n  executorId: native\n---\nKeep original Mote notes.\n')
  const spatial = new core.AgentMuxSpatialStateStore(join(state, 'spatial-state.json')), previous = await spatial.read()
  await spatial.commit({ expectedRevision: previous?.revision ?? 0, graph: { spaces: [{ spaceId: target.spaceId, kind: 'mote', name: 'Original Mote', hostId: 'local', directoryPath: topic.physicalDirectoryPath!, projectId: null, topicId: topic.id }],
    zones: [{ zoneId: target.zoneId, workspaceId: workspace.id, kind: 'home', hostId: 'local', directoryPath: topic.physicalDirectoryPath!, branch: null }], bindings: [{ spaceId: target.spaceId, zoneId: target.zoneId }], tabs: [], regions: [], layouts: {}, tabLayouts: {}, resources: {} } })
  let rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: scope.socketPath } }); cleanup.push(() => rpc.dispose())
  const application = { domain: 'signed.example', appId: 'original-mote-app' }, connectionId = 'original-bot'
  const secret = await rpc.call('connection.credential.store', { operationId: 'original-secret', secret: 'fixture-signing-key' }, { runtimeFence: { runtimeId: scope.owner.runtimeId, ownerInstanceId: scope.owner.ownerInstanceId } })
  await rpc.call('connection.configure', { operationId: 'original-connection', expectedRevision: null, connection: { connectionId, adapterId: 'signed-room', application, label: 'Original direct protocol', enabled: true, credentialRef: secret.credentialRef } })
  await rpc.call('space.mote.chat.configure', { operationId: 'original-finite-policy', target, expectedRevision: null, expectedConnectionRevision: 1, values: { enabled: true, connection: { connectionId, application }, conversationIdleMs: 60_000, strangerMessageLimit: 1 } })
  const endpoint = () => readFile(join(state, 'direct-endpoint.json'), 'utf8').then(JSON.parse)
  await until(async () => endpoint().catch(() => null), Boolean, 'original registered direct receiver')
  const message = { deliveryKey: 'original-event', recordKey: 'original-message', roomKey: 'original-private-room', person: 'original-guest@example.test', text: 'Original finite private request', addressing: 'broadcast' }
  const post = async () => { const raw = JSON.stringify(message); return fetch((await endpoint()).endpoint, { method: 'POST', headers: { 'x-room-signature': createHmac('sha256', 'fixture-signing-key').update(raw).digest('hex') }, body: raw }) }
  expect((await post()).status).toBe(202)
  const original = await until(async () => (await rpc.call('connection.ingress.ls', { connectionId })).ingresses.find(row => row.externalMessageId === message.recordKey), row => row?.state === 'claimed', 'original direct input claimed')
  const input = original!.input!; sid = input.agentSessionId
  try {
    await until(() => rpc.call('connection.ingress.inspect', { ingressId: original!.ingressId }), row => row.inputReceipt?.admission?.admission?.transport === 'native', 'original legitimate Core native input claim')
  } catch (error) {
    const reader = await scope.client()
    await writeFile('.local/mote-connector-chat/owner-core-reopen-input-diagnosis.json', JSON.stringify({ stage: 'first-original-Core-input',
      ownerPid: scope.ownerProcess.pid, receipt: await rpc.call('connection.ingress.inspect', { ingressId: original!.ingressId }), status: await reader.statusAgent(sid) }, null, 2))
    throw error
  }
  const client = await scope.client(), before = await client.statusAgent(sid), beforeAudience = await rpc.call('space.mote.chat.audience', { target }), beforeHistory = await rpc.call('space.mote.chat.history', { target })
  const originalReceipt = await rpc.call('connection.ingress.inspect', { ingressId: original!.ingressId }), originalClaim = originalReceipt.inputReceipt!.admission!.admission!
  if (originalClaim.transport !== 'native' || before.session.nativeHandle?.kind !== 'provider' || !before.session.nativeHandle.transcriptPath) throw Error('Original native input claim or source is absent')
  const registryDirectory = join(dirname(dirname(dirname(before.session.nativeHandle.transcriptPath))), 'sessions')
  const registryNames = (await readdir(registryDirectory)).filter(name => /^[0-9]+\.json$/u.test(name))
  expect(registryNames).toHaveLength(1)
  const registry = () => readFile(join(registryDirectory, registryNames[0]!), 'utf8').then(text => JSON.parse(text))
  const socketWriter = await registry()
  expect(socketWriter.sessionId).toBe(before.session.nativeHandle.sessionId)
  expect(socketWriter.pid).not.toBe(before.run.pid)
  const consumers = async () => (await readFile(before.session.nativeHandle!.kind === 'provider' ? before.session.nativeHandle!.transcriptPath! : '', 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    .filter(row => row.type === 'attachment' && row.attachment?.source_uuid === originalClaim.native.plan.clientCorrelation)
  await until(consumers, rows => rows.length === 1, 'original native consumer retained the exact Core input correlation')
  expect((await consumers())[0].attachment.prompt).toContain(message.text)
  const rawAdmission = () => { const database = new DatabaseSync(join(state, 'connectors', 'connections.sqlite'), { readOnly: true }); try { return String(database.prepare('SELECT snapshot_json FROM mote_chat_admission WHERE ingress_id=?').get(original!.ingressId)!.snapshot_json) } finally { database.close() } }
  const admission = rawAdmission(), firstPid = scope.ownerProcess.pid, firstOwner = scope.owner, oldEndpoint = await endpoint()
  expect(beforeAudience.people).toMatchObject([{ used: 1, total: 1, remaining: 0 }]); expect(beforeHistory.generations).toHaveLength(1)
  await rpc.dispose(); await scope.restart()
  expect(scope.ownerProcess.pid).not.toBe(firstPid); expect(scope.owner.ownerInstanceId).not.toBe(firstOwner.ownerInstanceId); expect(scope.owner.runtimeId).toBe(firstOwner.runtimeId); expect(scope.owner.ctxmux).toEqual(firstOwner.ctxmux)
  rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: scope.socketPath } })
  const reader = await scope.client(), after = await reader.statusAgent(sid)
  expect(after.session.run).toEqual(before.session.run); expect(after.session.nativeHandle).toEqual(before.session.nativeHandle); expect(after.run.pid).toBe(before.run.pid); expect(after.run.acceptedInputBytes).toBe(before.run.acceptedInputBytes)
  expect(await registry()).toEqual(socketWriter)
  expect(await rpc.call('space.mote.chat.audience', { target })).toEqual(beforeAudience); expect(await rpc.call('space.mote.chat.history', { target })).toEqual(beforeHistory); expect(rawAdmission()).toBe(admission)
  expect(await rpc.call('connection.ingress.authority', { operationId: input.operationId })).toMatchObject({ authority: 'current', ingress: { ingressId: original!.ingressId, input } })
  await until(async () => endpoint().catch(() => null), value => value?.ownerPid === scope.ownerProcess.pid, 'new owner original receiver endpoint')
  const restoredEndpoint = await endpoint()
  const originalConnection = (await rpc.call('connection.inspect', { connectionId })).connection!
  const alias = { ...originalConnection.config, connectionId: 'same-application-alias' }
  await rpc.call('connection.configure', { operationId: 'same-application-alias', expectedRevision: null, connection: alias })
  const policy = (await rpc.call('space.mote.chat.inspect', { target })).configuration!
  await rpc.call('space.mote.chat.configure', { operationId: 'select-same-application-alias', target, expectedRevision: policy.revision, expectedConnectionRevision: 1,
    values: { ...policy.values, connection: { connectionId: alias.connectionId, application } } })
  expect(await rpc.call('connection.ingress.authority', { operationId: input.operationId })).toMatchObject({ authority: 'current', ingress: { ingressId: original!.ingressId, input } })
  await until(async () => endpoint().catch(() => null), value => value?.connectionId === alias.connectionId, 'same-application alias receiver')
  expect((await post()).status).toBe(202)
  expect(await rpc.call('space.mote.chat.audience', { target })).toEqual(beforeAudience)
  expect(await consumers()).toHaveLength(1)
  const source = after.session.nativeHandle
  if (source?.kind !== 'provider' || !source.transcriptPath) throw Error('Original native transcript locator missing')
  const answer = 'Late answer from the original generation after Core owner reopen'
  await appendFile(source.transcriptPath, JSON.stringify({ type: 'assistant', sessionId: source.sessionId, uuid: 'original-generation-late-reply', message: { role: 'assistant', content: [{ type: 'text', text: answer }] } }) + '\n')
  const effects = () => readFile(join(state, 'external-effects.jsonl'), 'utf8').then(raw => raw.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))).catch(() => [])
  await until(effects, rows => rows.some(row => row.request.room === message.roomKey && row.request.text.includes(answer)), 'original generation reply authority after Core restart')
  const replies = (await effects()).filter(row => row.request.text.includes(answer))
  expect(replies).toHaveLength(1); expect(replies[0].ownerPid).toBe(scope.ownerProcess.pid)
  expect(rawAdmission()).toBe(admission)
  expect(await rpc.call('space.mote.chat.audience', { target })).toEqual(beforeAudience)
  expect(await rpc.call('space.mote.chat.history', { target })).toEqual(beforeHistory)
  expect(await consumers()).toHaveLength(1)
  const retainedInput = await rpc.call('connection.ingress.inspect', { ingressId: original!.ingressId })
  expect(retainedInput.ingress?.input).toEqual(input)
  expect(retainedInput.inputReceipt?.admission?.admission?.native?.plan.clientCorrelation).toBe(originalClaim.native.plan.clientCorrelation)
  await rpc.call('connection.configure', { operationId: 'disable-original-connection-after-alias', expectedRevision: originalConnection.revision,
    connection: { ...originalConnection.config, enabled: false } })
  expect((await rpc.call('connection.ingress.authority', { operationId: input.operationId })).authority).toBe('refused')
  if (process.env.MOTE_CHAT_RESTART_PROOF) {
    const sha = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex')
    await writeFile(process.env.MOTE_CHAT_RESTART_PROOF, JSON.stringify({ ownerPids: [firstPid, scope.ownerProcess.pid], originalOwner: firstOwner, restoredOwner: scope.owner,
      testSourceSHA256: await sha(resolve(import.meta.dirname, 'mote-chat-core-reopen.integration.test.ts')), moteChatSourceSHA256: await sha(resolve('packages/connectors/src/mote-chat.ts')),
      receiverEndpoints: [oldEndpoint, restoredEndpoint], selectedAliasEndpoint: await endpoint(), originalInput: input, originalAdmission: JSON.parse(admission), originalInputClaim: originalClaim,
      restoredInputClaim: retainedInput.inputReceipt?.admission?.admission, nativeConsumer: (await consumers())[0], nativeConsumerCount: (await consumers()).length, person: beforeAudience.people[0], generation: beforeHistory.generations[0],
      session: { agentSessionId: sid, originalRun: before.session.run, restoredRun: after.session.run, originalNative: before.session.nativeHandle, restoredNative: after.session.nativeHandle,
        runProcess: { kind: 'ctxmux-wrapper', originalPid: before.run.pid, restoredPid: after.run.pid }, socketWriter: { kind: 'independent-native-socket-producer', pid: socketWriter.pid, sessionId: socketWriter.sessionId, procStart: socketWriter.procStart } },
      originalReply: replies[0], assets: { nativeSourceSHA256: await sha(cSource), nativeBinarySHA256: await sha(join(assets, 'native-socket-peer-darwin')), workerSourceSHA256: await sha(listenerSource), workerBinarySHA256: await sha(join(assets, 'control-endpoint-listener-worker.mjs')) } }, null, 2) + '\n')
  }
}, 90_000)
