import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import * as core from '@agentmux/core'
import { moteConnectionBaseline, type MoteConnectionPreferencesReadResult } from '@agentmux/core/mote-preferences'
import type { MoteConnectionCreate } from '@agentmux/core/mote-connections'
import type { ConnectionAdapter } from '@agentmux/connectors'
import { startAgentMuxHost } from '../src/host.js'
import { ScratchTopics } from '../src/mote-resources.js'
import { directoryIdentity, homeZoneId, SCRATCH_WORKSPACE_ID } from '../src/mote-model.js'
import { OrdinaryWorkspaceFiles, type OrdinaryFileWriteInput } from '../src/ordinary-files.js'
import { parseMoteConnectionMode } from '../src/mote-quick-mode.js'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { imagePng } from '../../desktop/test/fixtures/mote-identity-image.js'

const cleanup: Array<() => void | Promise<void>> = [], facts: unknown[] = []
afterEach(async () => {
  try { for (const close of cleanup.splice(0).reverse()) await close() }
  finally { vi.restoreAllMocks(); vi.unstubAllEnvs() }
})
afterAll(async () => {
  if (process.env.HOST_MOTE_CONNECTION_FACTS) await writeFile(process.env.HOST_MOTE_CONNECTION_FACTS, JSON.stringify({
    schema: 'agentmux.node-mote-connection-consumer.v1', facts,
    scope: 'Actual startAgentMuxHost/Core/Unix SDK/compiled CLI, original ScratchTopics/native identity and File helper, original connection SQLite and parent. Only Runtime byte I/O, platform adapter I/O and explicit post-write ACK faults are controlled. No Desktop service, live platform or Linux qualification.'
  }, null, 2) + '\n')
})
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
const helper = resolve(import.meta.dirname, '../resources/bin/agentmux-workspace-move')

async function fixture() {
  const original = await rpcOwnerFixture([], core)
  cleanup.push(original.close)
  expect((await stat(helper)).isFile()).toBe(true)
  const helperSHA256 = sha(await readFile(helper))
  const workspace = { id: SCRATCH_WORKSPACE_ID, hostId: 'local', name: 'Original Mote workspace', path: join(original.root, 'scratch'), kind: 'folder' }
  await mkdir(workspace.path)
  // The actual framework-free owner publishes/confirms the directory identity.
  // No identity JSON, SOUL marker or Mote fact is fabricated as a positive setup.
  const topics = new ScratchTopics(), topic = await topics.ensureMote(workspace, 'view:node-default-parent')
  const physical = topic.physicalDirectoryPath!, moteFile = join(physical, 'MOTE.md')
  const spaceId = directoryIdentity('local', topic.identityDirectoryPath!), zoneId = homeZoneId(spaceId)
  const target = { spaceId, zoneId, expectedResource: { hostId: 'local', workspaceId: workspace.id, workspacePath: workspace.path } }
  const spatial = new core.AgentMuxSpatialStateStore(join(original.root, 'spatial.json'))
  const graph = { spaces: [{ spaceId, kind: 'mote' as const, name: 'Original Mote', hostId: 'local', directoryPath: physical, projectId: null, topicId: topic.id }],
    zones: [{ zoneId, workspaceId: workspace.id, kind: 'home' as const, hostId: 'local', directoryPath: physical, branch: null }],
    bindings: [{ spaceId, zoneId }], tabs: [], regions: [], layouts: {}, tabLayouts: {}, resources: {} }
  await spatial.commit({ expectedRevision: 0, graph })
  const configurationPath = join(original.root, 'app-config.json')
  const configuration = { hosts: [{ id: 'local', kind: 'local', label: 'Original Host' }], workspaces: [workspace] }
  const configure = async (value = configuration) => writeFile(configurationPath, JSON.stringify(value))
  await configure()
  const counts = { begin: 0, authentication: 0, upload: 0, create: 0, credential: 0 }
  const adapter: ConnectionAdapter = {
    adapterId: 'node-prepared', test: async () => ({ authentication: { state: 'unknown' }, transport: { state: 'unknown' }, intake: { state: 'unknown' }, delivery: { state: 'unknown' } }),
    enrollment: { domains: [{ domain: 'node.example', label: 'Controlled native platform' }],
      begin: async input => { counts.begin++; return { kind: 'authentication', stage: 'waiting', challenge: { qrPayload: 'controlled-private-challenge', expiresAt: null, nextPollAt: 0 }, account: null, privateState: JSON.stringify({ operationId: input.operationId }) } },
      advance: async input => { expect(JSON.parse(input.privateState).operationId).toBe(input.operationId); counts.authentication++; return { kind: 'authentication', stage: 'account', challenge: null, account: { userId: 'original-user', tenantId: 'original-tenant' }, privateState: input.privateState } },
      upload: async input => { counts.upload++; return { kind: 'uploaded', privateState: input.privateState } },
      create: async input => { counts.create++; return { kind: 'created', application: { domain: input.domain, appId: 'created-' + input.connectionId }, privateState: input.privateState } },
      credential: async input => { counts.credential++; return { kind: 'credential', secret: 'synthetic-parent-credential', privateState: input.privateState } }
    }
  }
  let writes = 0, beforeWrite: ((input: OrdinaryFileWriteInput) => Promise<void>) | undefined, loseAck = false
  const originalWrite = OrdinaryWorkspaceFiles.prototype.write
  vi.spyOn(OrdinaryWorkspaceFiles.prototype, 'write').mockImplementation(async function (this: OrdinaryWorkspaceFiles, owner, input) {
    writes++
    await beforeWrite?.(input)
    const result = await originalWrite.call(this, owner, input)
    if (loseAck && result.status === 'written') throw new Error('Controlled lost original File ACK after actual publication')
    return result
  })
  const native = original.inner.kernel
  await original.client.dispose()
  const socketPath = join(original.root, 'host.sock'), desktopSocketPath = join(original.root, 'absent-desktop.sock')
  const directory = join(original.root, 'connections')
  let host: Awaited<ReturnType<typeof startAgentMuxHost>> | undefined
  const stop = async () => { const prior = host; host = undefined; await prior?.dispose() }
  cleanup.push(stop)
  const start = async () => {
    const connect = vi.spyOn(core.AgentMuxClient.prototype, 'connect').mockImplementationOnce(async function (this: core.AgentMuxClient) {
      const inner = this as unknown as typeof original.inner
      await inner.registry.load('local'); inner.connected = true
      for (const name of ['isConnected', 'identity', 'status', 'input', 'observeOutput', 'attach', 'detach', 'stop']) inner.kernel[name] = native[name]
    })
    try {
      host = await startAgentMuxHost({ store: original.store, socketPath, desktopSocketPath,
        mobileBuildDirectory: join(original.root, 'absent-mobile'), connections: { directory, spatial, moteConfigurationPath: configurationPath, adapters: [adapter] } })
      await vi.waitFor(() => expect((host!.client as unknown as typeof original.inner).connected).toBe(true))
    } finally { connect.mockRestore() }
  }
  await start()
  const rpc = async () => { const value = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } }); cleanup.push(() => value.dispose()); return value }
  const cli = async (method: 'read' | 'save', input: unknown) => {
    const result = await runCompiledObjectCli(['--endpoint', 'unix:' + socketPath, 'space', 'mote', 'preferences', method, '--input', '-'],
      objectCliEnvironment(original.root), JSON.stringify(input))
    expect(result.code, result.stdout + result.stderr).toBe(0)
    const receipt = JSON.parse(result.stdout)
    expect(receipt).toMatchObject({ ok: true, operation: 'space.mote.preferences.' + method })
    return receipt.result
  }
  const seed = async (client: core.AgentMuxRpcClient) => {
    const owner = (await client.call('runtime.owner.identity', {})).owner
    const receipt = await client.call('connection.credential.store', { operationId: 'original-seed-credential', secret: 'synthetic-seed-credential' },
      { runtimeFence: { runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId } })
    const connection = { connectionId: 'original-saved-connection', adapterId: adapter.adapterId, application: { domain: 'node.example', appId: 'original-saved-app' }, label: 'Original saved bot', enabled: false, credentialRef: receipt.credentialRef }
    await client.call('connection.configure', { operationId: 'original-seed-connection', expectedRevision: null, connection })
    return { connectionId: connection.connectionId, application: connection.application }
  }
  const read = async (client: core.AgentMuxRpcClient, selected = target) => await client.call('space.mote.preferences.read', { kind: 'connection', target: selected }) as MoteConnectionPreferencesReadResult
  const prepared = (operationId: string): MoteConnectionCreate => ({ operationId, source: { target, preparedFrom: null },
    desired: { name: 'Explicit public bot', description: 'Prepared public description', avatar: { pngDataUrl: 'data:image/png;base64,' + imagePng().toString('base64') } },
    adapterId: adapter.adapterId, domain: 'node.example' })
  const complete = async (client: core.AgentMuxRpcClient, operationId: string) => {
    for (const kind of ['continue-authentication', 'confirm-account', 'create'] as const) {
      const parent = (await client.call('space.mote.connection.inspect', { operationId })).operation!
      const child = await client.call('connection.enrollment.inspect', { operationId: parent.enrollmentOperationId! })
      const choices = child.actions.filter(action => action.kind === kind)
      expect(choices).toHaveLength(1)
      const action = choices[0]!
      if (kind === 'continue-authentication' && child.challenge && child.challenge.nextPollAt > Date.now()) {
        await new Promise(resolve => setTimeout(resolve, child.challenge!.nextPollAt - Date.now()))
      }
      await client.call('space.mote.connection.advance', { operationId, enrollment: { operationId: parent.enrollmentOperationId!, ownRevision: action.ownRevision, decision: { actionId: action.actionId, kind } } })
    }
    return (await client.call('space.mote.connection.inspect', { operationId })).operation!
  }
  return { original, workspace, topic, target, spatial, graph, physical, moteFile, configuration, configure, rpc, read, cli, seed, prepared, complete, stop, start,
    counts, directory, helperSHA256, get writes() { return writes }, set beforeWrite(value: typeof beforeWrite) { beforeWrite = value },
    set loseAck(value: boolean) { loseAck = value }, noDesktop: () => expect(stat(desktopSocketPath)).rejects.toMatchObject({ code: 'ENOENT' }) }
}

it('the actual Node Host and compiled preference CLI share original exclusive creation and revision saves without a Desktop', async () => {
  const f = await fixture(), rpc = await f.rpc(), connection = await f.seed(rpc), first = await f.read(rpc)
  expect(first).toMatchObject({ status: 'ready', source: { result: { status: 'deleted' } } })
  const created = await rpc.call('space.mote.preferences.save', { kind: 'connection', target: f.target, operationId: 'original-exclusive-save', baseline: moteConnectionBaseline(first)!, values: { connection } })
  expect(created).toMatchObject({ status: 'saved', source: { values: { connection } } })
  await appendFile(f.moteFile, '\n# Original notes\nKeep this exact ordinary Markdown.\n')
  const cliRead = await f.cli('read', { kind: 'connection', target: f.target }) as MoteConnectionPreferencesReadResult
  expect(cliRead.source?.result.status).toBe('read')
  const cleared = await f.cli('save', { kind: 'connection', target: f.target, operationId: 'original-cli-cas', baseline: moteConnectionBaseline(cliRead)!, values: { connection: null } })
  expect(cleared.status).toBe('saved')
  const bytes = await readFile(f.moteFile, 'utf8')
  expect(bytes).toContain('# Original notes\nKeep this exact ordinary Markdown.')
  expect(parseMoteConnectionMode(bytes)).toMatchObject({ status: 'valid', values: { connection: null } })
  expect((await f.read(rpc)).source).toMatchObject({ result: { status: 'read', document: { content: bytes, revision: 'sha256:' + sha(bytes) } } })
  expect(f.writes).toBe(2)
  await f.noDesktop()
  // Rich public Note writes keep the original Main route; this internal ordinary
  // File owner must not intercept or publish them when that client is absent.
  const resource = moteConnectionBaseline(await f.read(rpc))!.resource, note = 'Original Note baseline.\n'
  await expect(rpc.call('file.write', { ...f.target, path: 'original.note.md', expectedResource: { ...resource, path: resource.path.replace(/MOTE\.md$/u, 'original.note.md') },
    content: 'Original Note edit.\n', baseContent: note, expectedRevision: 'sha256:' + sha(note), operationId: 'original-note-operation' })).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  expect(f.writes).toBe(2)
  await expect(stat(join(f.physical, 'original.note.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  // Plain catalog reads use this same registered graph. Rich public Note writes
  // above retain their original Desktop owner and cannot use the ordinary leaf.
  expect((await rpc.call('space.ls', { target: {} })).catalog).toEqual(core.spatialCatalog(f.graph))
  expect((await rpc.call('system.endpoint', {})).protocol).toBe('jsonrpc-2.0')
  facts.push({ case: 'actual-sdk-cli-file-chain', helperSHA256: f.helperSHA256, writes: f.writes, finalRevision: 'sha256:' + sha(bytes), noDesktop: true, publicNoteUntouched: true })
})

it('the original preference baseline refuses a later ordinary File revision before any new write', async () => {
  const f = await fixture(), rpc = await f.rpc(), connection = await f.seed(rpc)
  await writeFile(f.moteFile, '---\nversion: 1\n---\n# Original user notes\n')
  const prior = await f.read(rpc), changed = '---\nversion: 1\n---\n# Newer user notes\n'
  expect(prior.status).toBe('ready')
  await writeFile(f.moteFile, changed)
  const result = await rpc.call('space.mote.preferences.save', { kind: 'connection', target: f.target, operationId: 'old-baseline-save', baseline: moteConnectionBaseline(prior)!, values: { connection } })
  expect(result.status).toBe('refused-before-write')
  expect(await readFile(f.moteFile, 'utf8')).toBe(changed)
  expect(f.writes).toBe(0)
  facts.push({ case: 'baseline-conflict', status: result.status, writes: f.writes })
})

it('an actual exclusive File competitor is retained when the original missing-file preference save reaches publication', async () => {
  const f = await fixture(), rpc = await f.rpc(), connection = await f.seed(rpc), prior = await f.read(rpc)
  const competitor = '# Competing original file\n'
  f.beforeWrite = async () => { await writeFile(f.moteFile, competitor, { flag: 'wx' }) }
  const result = await rpc.call('space.mote.preferences.save', { kind: 'connection', target: f.target, operationId: 'original-absent-file-save', baseline: moteConnectionBaseline(prior)!, values: { connection } })
  expect(result.status).toBe('refused-before-write')
  expect(await readFile(f.moteFile, 'utf8')).toBe(competitor)
  expect(f.writes).toBe(1)
  facts.push({ case: 'actual-exclusive-competitor', status: result.status, writes: f.writes })
})

it('a prepared parent freezes its original child and actual default File receipt in the same SQLite owner across reopen', async () => {
  const f = await fixture(), rpc = await f.rpc(), input = f.prepared('original-node-parent')
  const admitted = await rpc.call('space.mote.connection.create', input)
  expect(admitted.snapshot).toMatchObject({ name: input.desired.name, description: input.desired.description, avatarSha256: sha(imagePng()) })
  const completed = await f.complete(rpc, input.operationId)
  expect(completed.defaultLink.state).toBe('saved')
  expect(completed.defaultSave?.observedReceipt).toMatchObject({ status: 'saved', operationId: completed.defaultSave!.params.operationId })
  expect(completed.enrollmentOperationId).toBe(admitted.enrollmentOperationId)
  expect(parseMoteConnectionMode(await readFile(f.moteFile, 'utf8'))).toMatchObject({ status: 'valid', values: { connection: completed.connection } })
  expect(f.counts).toEqual({ begin: 1, authentication: 1, upload: 1, create: 1, credential: 1 })
  const beforeOwner = (await rpc.call('runtime.owner.identity', {})).owner, writes = f.writes
  await rpc.dispose(); await f.stop(); await f.start()
  const next = await f.rpc(), afterOwner = (await next.call('runtime.owner.identity', {})).owner
  expect(afterOwner.runtimeId).toBe(beforeOwner.runtimeId)
  expect(afterOwner.ownerInstanceId).not.toBe(beforeOwner.ownerInstanceId)
  expect((await next.call('space.mote.connection.inspect', { operationId: input.operationId })).operation).toEqual(completed)
  expect(await next.call('space.mote.connection.create', input)).toEqual(completed)
  expect(f.writes).toBe(writes)
  expect(f.counts.create).toBe(1)
  await f.noDesktop()
  facts.push({ case: 'original-parent-default-reopen', operationId: input.operationId, childId: admitted.enrollmentOperationId,
    defaultOperationId: completed.defaultSave!.params.operationId, writes, sameRuntime: true, newInstance: true, platformCreates: f.counts.create })
})

it('a lost actual default File ACK remains unknown across original SQLite reopen and never replays that write', async () => {
  const f = await fixture(), rpc = await f.rpc(), input = f.prepared('original-default-unknown')
  await rpc.call('space.mote.connection.create', input)
  f.loseAck = true
  const completed = await f.complete(rpc, input.operationId)
  expect(completed.defaultLink.state).toBe('unknown')
  expect(completed.defaultSave?.observedReceipt?.status).toBe('unconfirmed')
  expect(parseMoteConnectionMode(await readFile(f.moteFile, 'utf8'))).toMatchObject({ status: 'valid', values: { connection: completed.connection } })
  expect(f.writes).toBe(1)
  await rpc.dispose(); await f.stop(); f.loseAck = false; await f.start()
  const next = await f.rpc()
  expect((await next.call('space.mote.connection.inspect', { operationId: input.operationId })).operation).toEqual(completed)
  const advanced = await next.call('space.mote.connection.advance', { operationId: input.operationId })
  expect(advanced.defaultLink.state).toBe('unknown')
  expect(advanced.defaultSave).toEqual(completed.defaultSave)
  expect(f.writes).toBe(1)
  expect(f.counts.create).toBe(1)
  facts.push({ case: 'actual-published-default-lost-ack', operationId: input.operationId, defaultOperationId: completed.defaultSave!.params.operationId,
    actualFileContainsConnection: true, state: advanced.defaultLink.state, writes: f.writes, platformCreates: f.counts.create })
})

it('fresh configuration and a foreign Host at the same physical path cannot borrow local Mote File IO', async () => {
  const f = await fixture(), rpc = await f.rpc()
  expect((await f.read(rpc)).status).toBe('ready')
  const read = vi.spyOn(OrdinaryWorkspaceFiles.prototype, 'read')
  await f.configure({ ...f.configuration, workspaces: [{ ...f.workspace, path: join(f.original.root, 'another-scratch') }] })
  expect((await f.read(rpc)).status).toBe('unconfirmed')
  expect(read).not.toHaveBeenCalled()
  // An intentionally foreign namespace is a negative input, never a fabricated
  // positive Mote. Its path is a real local path and must not be opened locally.
  await f.configure({ ...f.configuration, workspaces: [{ ...f.workspace, hostId: 'foreign-original-host' }] })
  const state = (await f.spatial.read())!
  await f.spatial.commit({ expectedRevision: state.revision, graph: { ...f.graph,
    spaces: f.graph.spaces.map(space => ({ ...space, hostId: 'foreign-original-host' })), zones: f.graph.zones.map(zone => ({ ...zone, hostId: 'foreign-original-host' })) } })
  const foreign = { ...f.target, expectedResource: { ...f.target.expectedResource, hostId: 'foreign-original-host' } }
  expect((await f.read(rpc, foreign)).status).toBe('unconfirmed')
  await expect(rpc.call('space.mote.connection.create', { ...f.prepared('foreign-node-parent'), source: { target: foreign, preparedFrom: null } })).rejects.toMatchObject({ code: 'MOTE_CONNECTION_SOURCE_UNCONFIRMED' })
  expect(read).not.toHaveBeenCalled()
  expect(f.writes).toBe(0)
  expect(f.counts.begin).toBe(0)
  expect((await rpc.call('system.endpoint', {})).protocol).toBe('jsonrpc-2.0')
  facts.push({ case: 'fresh-config-foreign-host', localReads: read.mock.calls.length, localWrites: f.writes, parentEffects: f.counts.begin, coreAvailable: true })
})
