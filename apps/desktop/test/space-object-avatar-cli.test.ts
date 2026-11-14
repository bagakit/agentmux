import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { WorkbenchUserStateStore } from '../src/main/workbench-user-state.js'
import { moteAvatarOperationDirectory } from '@agentmux/host/mote-avatar-state'
import { avatarSeriesCanonical } from '@agentmux/core/mote-avatar-series'
import { afterEach, expect, it, vi } from 'vitest'
import * as core from '@agentmux/core'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'
import { ObjectCliProbe, objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { startAgentMuxHost } from '../../host/src/host.js'
import { TopicKnowledgeOwner } from '@agentmux/host/topic-knowledge'
import { TopicSpatialOwner } from '@agentmux/host/topic-spatial-owner'
import { SCRATCH_WORKSPACE_ID, directoryIdentity } from '@agentmux/host/mote-model'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import { ConfigOwner } from '../src/main/config-owner.js'
import { ConfigStore, DEFAULT_CONFIG } from '../src/main/config-store.js'
import { WorkspaceFiles } from '../src/main/workspace-files.js'
import { ScratchTopics } from '../src/main/scratch-topics.js'
import { SpaceObjectImages } from '../src/main/space-object-images.js'
import { SpaceObjectAvatarOwner } from '../src/main/space-object-avatar.js'
import { createSpaceObjectAvatarResolver } from '../src/main/space-object-avatar-target.js'
import { createMoteAvatarWriter } from '../src/main/mote-avatar-writer.js'
import { MoteAvatarControl } from '../src/main/mote-avatar-control.js'
import { MoteAvatarSeriesOwner } from '../src/main/mote-avatar-series.js'
import { desktopRpcMethods } from '../src/main/desktop-rpc-exposure.js'
import { controlledNativeImage, imagePng, imageInput } from './fixtures/mote-identity-image.js'
vi.mock('electron', () => ({ app: { getPath: () => '/private-avatar-fixture' }, nativeTheme: { shouldUseDarkColors: true }, nativeImage: { createFromBuffer: (bytes: Buffer) => controlledNativeImage(bytes) } }))

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => {
  const failures: unknown[] = []
  for (const close of cleanup.splice(0).reverse()) try { await close() } catch (error) { failures.push(error) }
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (failures.length) throw new AggregateError(failures, 'Private avatar consumer cleanup failed')
})
async function fixture() {
  const original = await rpcOwnerFixture(['actor-a', 'actor-b', 'retained'], core); cleanup.push(original.close)
  const workspace = { id: SCRATCH_WORKSPACE_ID, name: 'Private Topics', hostId: 'local', kind: 'folder' as const, path: join(await realpath(original.root), 'scratch') }; await mkdir(workspace.path)
  const configStore = new ConfigStore(join(original.root, 'config.json'))
  let config = await configStore.save({ ...structuredClone(DEFAULT_CONFIG), workspaces: [workspace] })
  const configOwner = new ConfigOwner({ read: () => config, save: next => configStore.save(next), publish: next => { config = next } })
  const state = new AgentMuxSpatialStateStore(join(original.root, 'spatial.json')), scratch = new ScratchTopics(controlledNativeImage)
  const files = new WorkspaceFiles(() => ({ kind: 'local' } as core.ExecutionHost))
  const topics = new TopicKnowledgeOwner(scratch, files, () => workspace)
  topics.setSpatialPort(new TopicSpatialOwner({ state, workspace: () => workspace, topics: () => topics.listTopicSnapshots(), categories: () => topics.listCategories(), ensureDefaultCategory: () => topics.ensureDefaultCategoryContent() }))
  const { category } = await topics.call('topic.category.create', { categoryId: '11111111-1111-4111-8111-111111111111', title: 'Original Category' })
  const { topic } = await topics.call('topic.create', { topicId: 'view:original-avatar', title: 'Original Topic', categoryId: category.categoryId })
  const images = new SpaceObjectImages(async target => target.kind === 'category' ? topics.categoryAppearanceDirectory(target.categoryId, target.objectKey)
    : { hostId: workspace.hostId, directoryPath: await topics.topicAppearanceDirectory(target.workspaceId, target.topicId, target.objectKey) }, controlledNativeImage)
  const owner = new SpaceObjectAvatarOwner(configOwner, configStore, images, createSpaceObjectAvatarResolver(configOwner, topics, state))
  const builtinRoot = join(original.root, 'builtin'), userRoot = join(original.root, 'avatars'), series = join(userRoot, 'original-series')
  await mkdir(builtinRoot); await mkdir(series, { recursive: true }); await writeFile(join(series, 'original.png'), imagePng())
  const sources = new MoteAvatarSeriesOwner({ builtinRoot, userRoot }, controlledNativeImage)
  const moteWriter = createMoteAvatarWriter(configOwner, sources, scratch, configStore), moteAvatars = new MoteAvatarControl(sources, moteWriter)
  vi.stubEnv('AGENTMUX_SPATIAL_STATE_STORE', join(original.root, 'spatial.json'))
  const native = original.inner.kernel; await original.client.dispose()
  const connect = vi.spyOn(core.AgentMuxClient.prototype, 'connect').mockImplementationOnce(async function () {
    const inner = this as unknown as typeof original.inner
    await inner.registry.load('local'); inner.connected = true
    for (const name of ['connect', 'isConnected', 'status', 'identity', 'input', 'openInput', 'observeOutput', 'attach', 'detach', 'stop']) inner.kernel[name] = native[name]
  })
  const socket = join(original.root, 'control.sock'), desktopSocket = join(original.root, 'desktop.sock')
  let host: Awaited<ReturnType<typeof startAgentMuxHost>>
  try {
    host = await startAgentMuxHost({ store: original.store, socketPath: socket, desktopSocketPath: desktopSocket, configurationPath: configStore.filePath, mobileBuildDirectory: join(original.root, 'absent-mobile') })
    cleanup.push(() => host.dispose()); await vi.waitFor(() => expect((host.client as unknown as typeof original.inner).connected).toBe(true))
  } finally { connect.mockRestore() }
  const desktop = new core.AgentMuxControlServer({ socketPath: desktopSocket, exposedMethods: desktopRpcMethods(),
    forwardingPeer: { authoritySocketPath: socket }, coreClients: () => [{ hostId: 'local', client: host.client }], objectAvatars: owner, moteAvatars, topics })
  await desktop.start(); cleanup.push(() => desktop.stop())
  const cli = (action: 'read' | 'save', input: unknown, actor = 'actor-a') => runCompiledObjectCli(['space', 'object', 'avatar', action, '--input', '-'],
    objectCliEnvironment(original.root, { AGENTMUX_RPC_ENDPOINT: 'unix:' + socket, AGENTMUX_AGENT_SESSION_ID: actor, AGENTMUX_AGENT_CAPABILITY: original.credentials.capability }), JSON.stringify(input))
  const read = async (target: core.SpaceObjectImageTarget, operationId?: string) => {
    const value = await cli('read', { target, ...(operationId ? { operationId } : {}) }); expect(value.code, value.stderr).toBe(0)
    return JSON.parse(value.stdout).result as core.SpaceObjectAvatarRead
  }
  return { original, host, native, sources, moteWriter, moteAvatars, configStore, configOwner, state, scratch, topics, images, owner, desktop, socket, cli, read, workspace, category, topic,
    categoryTarget: { kind: 'category' as const, categoryId: category.categoryId, objectKey: category.spaceId },
    topicTarget: { kind: 'topic' as const, workspaceId: topic.workspaceId!, topicId: topic.topicId, objectKey: topic.contentIdentity! } }
}

it('compiled CLI traverses actual Host/Desktop and original content/PNG/ConfigOwner for Category and Topic publication with fixed actor and exact operation', async () => {
  const f = await fixture(), sessions = await readFile(f.original.store.path)
  const discovered = await runCompiledObjectCli(['topic', 'inspect', '--topic', f.topic.topicId],
    objectCliEnvironment(f.original.root, { AGENTMUX_RPC_ENDPOINT: 'unix:' + f.socket, AGENTMUX_AGENT_SESSION_ID: 'actor-a', AGENTMUX_AGENT_CAPABILITY: f.original.credentials.capability }))
  expect(discovered.code, discovered.stderr).toBe(0)
  const fact = JSON.parse(discovered.stdout).result.topic
  expect(fact).toMatchObject({ workspaceId: f.workspace.id, contentKind: 'topic' }); expect(fact.contentIdentity).toEqual(expect.any(String))
  f.topicTarget = { kind: 'topic', workspaceId: fact.workspaceId, topicId: fact.topicId, objectKey: fact.contentIdentity }
  for (const [index, target] of [f.categoryTarget, f.topicTarget].entries()) {
    const before = await f.read(target), operationId = 'original-avatar-' + index
    const request = { target, operationId, beforeRevision: before.revision, choice: { kind: 'png', dataUrl: imageInput().dataUrl } }
    const saved = await f.cli('save', request)
    expect(saved.code, saved.stderr).toBe(0)
    const result = JSON.parse(saved.stdout).result as core.SpaceObjectAvatarResult
    expect(result.mode).toBe('asset-publication'); expect(result.state).toBe('saved')
    if (result.mode !== 'asset-publication') throw new Error('Wrong publication kind')
    expect(result.operation).toMatchObject({ operationId, actor: { kind: 'agent', id: 'actor-a', hostId: 'local', runId: 'run-actor-a' }, actorAvailability: 'available', phase: 'published', durability: 'confirmed' })
    expect(result.current.image).toMatchObject({ width: 256, height: 256, dataUrl: imageInput().dataUrl })
    const rejected = await f.cli('save', request, 'actor-b')
    expect(rejected.code, rejected.stderr).toBe(0); expect(JSON.parse(rejected.stdout).result.state).toBe('refused')
    const read = await f.read(target, operationId)
    expect(read.operation?.actor?.id).toBe('actor-a'); expect(read.readerIdentity).toMatchObject({ kind: 'agent', id: 'actor-a' });
    const other = await f.cli('read', { target, operationId }, 'actor-b'); expect(other.code, other.stderr).toBe(0); expect(JSON.parse(other.stdout).result).toMatchObject({ readerIdentity: { id: 'actor-b' }, operation: { actor: { id: 'actor-a' } } });
    if (index === 0 && process.env.AGENTMUX_TEST_AVATAR_HISTORY_OUTPUT) await writeFile(process.env.AGENTMUX_TEST_AVATAR_HISTORY_OUTPUT, JSON.stringify({ request, read: JSON.parse(other.stdout).result, origin: 'Actual isolated compiled CLI→Host→Desktop read as actor-b of actor-a publication', observedAt: Date.now() }))
    expect(read.image?.dataUrl).toBe(imageInput().dataUrl)
    const saves = vi.spyOn(f.configStore, 'save'); await f.read(target, operationId); expect(saves).not.toHaveBeenCalled(); saves.mockRestore()
  }
  expect(await readFile(f.original.store.path)).toEqual(sessions)
  await f.host.client.writeAgent({ agentSessionId: 'retained', expectedRun: { runId: 'run-retained' }, data: 'healthy original input', source: 'user' })
  expect(f.original.rawInput).toHaveBeenCalled(); expect(f.native.stop).not.toHaveBeenCalled()
})

async function rejectForeignSavedReceipt(command: string[], request: { operationId: string }, result: Record<string, any>) {
  for (const corruption of ['actor', 'hash'] as const) {
    const invalid = structuredClone(result)
    const operation = invalid.operation
    if (corruption === 'actor') {
      operation.actor = { ...operation.actor, id: 'another-original-actor' }
      operation.requestHash = core.avatarRequestHash(request, operation.actor)
    } else operation.requestHash = core.avatarRequestHash({ ...request, beforeRevision: 'another-baseline' }, operation.actor)
    // Top receipt is corrupted; current still contains the genuine original publication.
    const probe = new ObjectCliProbe(() => invalid); await probe.start(); cleanup.push(() => probe.stop())
    const observed = await probe.run([...command, '--input', '-'], JSON.stringify(request), { AGENTMUX_RPC_ENDPOINT: 'unix:' + probe.socketPath })
    expect(observed.code, corruption + ': ' + observed.stdout).not.toBe(0)
    expect(observed.stderr).toContain('CONTROL_PROTOCOL_ERROR')
  }
}

it('compiled CLI rejects saved avatar responses for a different original actor or complete request while preserving foreign historical reads', async () => {
  const f = await fixture(), before = await f.read(f.categoryTarget)
  const request = { target: f.categoryTarget, operationId: 'saved-codec-original', beforeRevision: before.revision, choice: { kind: 'png', dataUrl: imageInput().dataUrl } }
  const saved = await f.cli('save', request); expect(saved.code, saved.stderr).toBe(0)
  await rejectForeignSavedReceipt(['space', 'object', 'avatar', 'save'], request, JSON.parse(saved.stdout).result)
  const other = await f.cli('read', { target: request.target, operationId: request.operationId }, 'actor-b')
  expect(other.code, other.stderr).toBe(0); expect(JSON.parse(other.stdout).result.operation.actor.id).toBe('actor-a')
})

it('icon/reset CAS is independent of image support and a wrong exact target or stale baseline never publishes', async () => {
  const f = await fixture(), before = await f.read(f.categoryTarget)
  const icon = await f.cli('save', { target: f.categoryTarget, beforeRevision: before.revision, choice: 'book' })
  expect(icon.code, icon.stderr).toBe(0); expect(JSON.parse(icon.stdout).result).toMatchObject({ mode: 'configuration-only', state: 'saved', current: { choice: 'book' } })
  expect(JSON.parse(icon.stdout).result).not.toHaveProperty('operation')
  const stale = await f.cli('save', { target: f.categoryTarget, beforeRevision: before.revision, choice: null })
  expect(stale.code, stale.stderr).toBe(0); expect(JSON.parse(stale.stdout).result.state).toBe('refused')
  const wrong = await f.cli('save', { target: { ...f.categoryTarget, objectKey: f.topicTarget.objectKey }, beforeRevision: before.revision, choice: 'brain' })
  expect(wrong.code).not.toBe(0)
  const current = await f.read(f.categoryTarget)
  expect((await f.cli('save', { target: f.categoryTarget, beforeRevision: current.revision, choice: null })).code).toBe(0)
  expect((await f.read(f.categoryTarget)).choice).toBeNull()
  const spatial = (await f.state.read())!, graph = structuredClone(spatial.graph)
  const canonical = graph.zones.find(zone => { const resource = graph.resources['zone:' + zone.zoneId] as Record<string, unknown> | undefined; return resource?.topicId === f.topicTarget.topicId })!
  const alias = 'additional-topic-display-zone'; graph.zones.push({ ...canonical, zoneId: alias }); graph.resources['zone:' + alias] = structuredClone(graph.resources['zone:' + canonical.zoneId]!)
  await f.state.commit({ expectedRevision: spatial.revision, graph })
  expect((await f.read(f.topicTarget)).target).toEqual(f.topicTarget)
})


it('a failed original confirmation stays unknown across actual process reopen; reads and repeated original operations do not republish or overwrite later choices', async () => {
  const f = await fixture(), before = await f.read(f.categoryTarget)
  const request = { target: f.categoryTarget, operationId: 'unknown-original', beforeRevision: before.revision, choice: { kind: 'png' as const, dataUrl: imageInput().dataUrl } }
  const userPath = join(f.original.root, 'workbench.json'), users = new WorkbenchUserStateStore(userPath)
  const workface = JSON.stringify({ version: 1, state: { tabs: [{ id: 'original-tab', regionId: 'original-region', agentSessionId: 'retained' }], agentComposerDrafts: { 'original-region': 'unsent original draft' } } })
  await users.write(workface); await users.keepObjectAvatarRequest(request)
  vi.spyOn(f.configStore, 'confirmSaved').mockRejectedValueOnce(new Error('original directory fsync failed'))
  const failed = await f.cli('save', request)
  expect(failed.code, failed.stderr).toBe(0)
  expect(JSON.parse(failed.stdout).result).toMatchObject({ state: 'unknown', operation: { phase: 'publication-unknown', durability: 'unknown' } })
  const published = await f.read(f.categoryTarget, request.operationId)
  expect(published.choice).toMatchObject({ kind: 'image' }); expect(published.image?.dataUrl).toBe(imageInput().dataUrl)
  const icon = await f.cli('save', { target: request.target, beforeRevision: published.revision, choice: 'book' })
  expect(JSON.parse(icon.stdout).result.state).toBe('saved')
  const finalConfig = await readFile(join(f.original.root, 'config.json')), directory = await f.images.directory(request.target)
  const journal = join(await moteAvatarOperationDirectory(directory), request.operationId + '.json'), originalJournal = await readFile(journal)
  const worker = await workerFile()
  const observed = await child(worker, [join(f.original.root, 'config.json'), join(f.original.root, 'spatial.json'), userPath, JSON.stringify(request)])
  expect(observed.pid).not.toBe(process.pid)
  expect(observed.result).toMatchObject({ state: 'unknown', operation: { phase: 'publication-unknown', actor: { id: 'actor-a' } }, current: { choice: 'book' } })
  expect(observed.read.operation.phase).toBe('publication-unknown')
  expect(observed.requests[0].request).toEqual(request); expect(observed.workface).toBe(workface)
  expect(observed.unchangedByAvatar).toBe(true); expect(JSON.parse(await readFile(join(f.original.root, 'config.json'), 'utf8')).appearance).toEqual(JSON.parse(finalConfig.toString()).appearance); expect(await readFile(journal)).toEqual(originalJournal)
})

it('an unconfirmed publication marker before configuration commit never reapplies the original request, even when its baseline still matches after restart', async () => {
  const f = await fixture(), before = await f.read(f.categoryTarget)
  const request = { target: f.categoryTarget, operationId: 'unknown-before-config', beforeRevision: before.revision, choice: { kind: 'png' as const, dataUrl: imageInput().dataUrl } }
  const store = vi.spyOn(f.configStore, 'save').mockRejectedValueOnce(new Error('configuration replace was not acknowledged'))
  const value = await f.cli('save', request)
  expect(value.code, value.stderr).toBe(0)
  expect(JSON.parse(value.stdout).result).toMatchObject({ state: 'unknown', operation: { phase: 'publication-unknown' }, current: { choice: null, revision: before.revision } })
  store.mockClear()
  const repeat = await f.cli('save', request)
  expect(repeat.code, repeat.stderr).toBe(0); expect(JSON.parse(repeat.stdout).result).toMatchObject({ state: 'unknown', current: { choice: null } })
  expect(store).not.toHaveBeenCalled()
  const userPath = join(f.original.root, 'workbench.json'), users = new WorkbenchUserStateStore(userPath)
  await users.write(JSON.stringify({ version: 1, state: { agentComposerDrafts: { original: 'unsent' } } })); await users.keepObjectAvatarRequest(request)
  const reopened = await child(await workerFile(), [f.configStore.filePath, join(f.original.root, 'spatial.json'), userPath, JSON.stringify(request)])
  expect(reopened.result).toMatchObject({ state: 'unknown', current: { choice: null } }); expect(reopened.unchangedByAvatar).toBe(true)
  expect((await f.read(request.target)).choice).toBeNull()
})

it('the original target/CAS and PNG validation refuse malformed assets and preserve later state and unrelated content', async () => {
  const f = await fixture(), before = await f.read(f.topicTarget)
  const assets = vi.spyOn(f.images, 'save')
  const blocked = assets.mockImplementationOnce(async () => {
    await f.configOwner.update(value => ({ ...value, appearance: { ...value.appearance, spaceObjectIcons: { ...value.appearance.spaceObjectIcons, [f.topicTarget.objectKey]: 'book' } } }))
    return await SpaceObjectImages.prototype.save.call(f.images, f.topicTarget, imageInput())
  })
  const raced = await f.cli('save', { target: f.topicTarget, operationId: 'concurrent-original', beforeRevision: before.revision, choice: { kind: 'png', dataUrl: imageInput().dataUrl } })
  expect(JSON.parse(raced.stdout).result).toMatchObject({ state: 'unknown', current: { choice: 'book' } })
  expect(blocked).toHaveBeenCalledTimes(1); assets.mockRestore()
  for (const [index, png] of [Buffer.from('not a PNG'), imagePng(1, 1)].entries()) {
    const now = await f.read(f.topicTarget)
    const bad = await f.cli('save', { target: f.topicTarget, operationId: 'bad-png-' + index, beforeRevision: now.revision, choice: { kind: 'png', dataUrl: imageInput(png).dataUrl } })
    expect(bad.code, bad.stderr).toBe(0); expect(JSON.parse(bad.stdout).result.state).toBe('unknown')
    expect((await f.read(f.topicTarget)).choice).toBe('book')
  }
})

it('actorless original receipts remain unattributed; old intent cannot be adopted or resumed by the present actor', async () => {
  const f = await fixture(), before = await f.read(f.categoryTarget), directory = await f.images.directory(f.categoryTarget)
  const request = { target: f.categoryTarget, operationId: 'legacy-original', beforeRevision: before.revision, choice: { kind: 'png', dataUrl: imageInput().dataUrl } }
  const journal = join(await moteAvatarOperationDirectory(directory, true), request.operationId + '.json')
  const operation = { operationId: request.operationId, requestHash: 'sha256:' + createHash('sha256').update(avatarSeriesCanonical(request)).digest('hex'), phase: 'intent', durability: 'unknown' }
  const bytes = JSON.stringify({ schema: 'agentmux.avatar-operation.v1', target: request.target, operation })
  await writeFile(journal, bytes)
  const save = vi.spyOn(f.images, 'save')
  const value = await f.cli('save', request)
  expect(value.code, value.stderr).toBe(0); expect(JSON.parse(value.stdout).result).toMatchObject({ state: 'refused', operation: { actorAvailability: 'unavailable' } })
  expect((await f.read(request.target, request.operationId)).operation).not.toHaveProperty('actor')
  expect(save).not.toHaveBeenCalled(); expect(await readFile(journal, 'utf8')).toBe(bytes)
})

it('request custody keeps exact earlier unknown requests and root workface saves never read or encode their PNG members', async () => {
  const f = await fixture(), before = await f.read(f.categoryTarget), path = join(f.original.root, 'workbench.json')
  const reads: string[] = [], writes: string[] = []
  const owner = new WorkbenchUserStateStore(path, { read: async (path, encoding) => { reads.push(path); return readFile(path, encoding) }, write: async (path, body, options) => { writes.push(path); return core.durableWriteFile(path, body, options) } })
  const first = { target: f.categoryTarget, operationId: 'first-original', beforeRevision: before.revision, choice: { kind: 'png' as const, dataUrl: imageInput().dataUrl } }
  await owner.keepObjectAvatarRequest(first)
  await owner.keepObjectAvatarRequest({ ...first, operationId: 'second-original' })
  await expect(owner.keepObjectAvatarRequest({ ...first, beforeRevision: 'sha256:' + '1'.repeat(64) })).rejects.toThrow('another original request')
  expect((await owner.readObjectAvatarRequests(first.target)).map(value => value.request.operationId)).toEqual(['first-original', 'second-original'])
  reads.length = 0; writes.length = 0
  await owner.write(JSON.stringify({ version: 1, state: { agentComposerDrafts: { original: 'later draft' } } }))
  expect(reads.every(value => !value.includes('.object-avatar-requests'))).toBe(true)
  expect(writes.every(value => !value.includes('.object-avatar-requests'))).toBe(true)
  await owner.retireObjectAvatarRequest(first)
  expect((await owner.readObjectAvatarRequests(first.target)).map(value => value.request.operationId)).toEqual(['second-original'])
})

it('a retained remote Category still permits ordinary icon/reset while local PNG publication is explicitly unsupported', async () => {
  const f = await fixture(), original = (await f.state.read())!, target = { kind: 'category' as const, categoryId: f.categoryTarget.categoryId, objectKey: directoryIdentity('remote-original-host', '/original/category') }
  const graph = structuredClone(original.graph), originalSpace = graph.spaces.find(value => value.spaceId === f.categoryTarget.objectKey)!
  graph.spaces.push({ ...originalSpace, spaceId: target.objectKey })
  graph.resources['space:' + target.objectKey] = { ...graph.resources['space:' + f.categoryTarget.objectKey] as object, categoryId: target.categoryId, spaceId: target.objectKey, hostId: 'remote-original-host', directoryPath: '/original/category' }
  await f.state.commit({ expectedRevision: original.revision, graph })
  expect((await f.read(f.categoryTarget)).target).toEqual(f.categoryTarget)
  const local = vi.spyOn(f.images, 'directory'), before = await f.read(target)
  expect(before.localCapability.state).toBe('unsupported')
  const icon = await f.cli('save', { target, beforeRevision: before.revision, choice: 'book' })
  expect(icon.code, icon.stderr).toBe(0); expect(JSON.parse(icon.stdout).result).toMatchObject({ mode: 'configuration-only', state: 'saved', current: { choice: 'book' } })
  const current = await f.read(target)
  const png = await f.cli('save', { target, operationId: 'remote-unsupported', beforeRevision: current.revision, choice: { kind: 'png', dataUrl: imageInput().dataUrl } })
  expect(png.code).not.toBe(0); expect(png.stderr).toContain('AVATAR_LOCAL_IMAGE_UNSUPPORTED')
  expect(local).not.toHaveBeenCalled(); expect((await f.read(target)).choice).toBe('book')
})

it('the original Mote public save receives the trusted actor too; legacy series receipts keep original unavailable attribution and never resume', async () => {
  const f = await fixture(), mote = await f.scratch.ensureMote(f.workspace, 'view:original-mote')
  const target = { workspaceId: f.workspace.id, topicId: mote.id, objectKey: directoryIdentity('local', mote.identityDirectoryPath!) }
  const cli = (action: string, input: unknown, actor = 'actor-a') => runCompiledObjectCli(['space', 'mote', 'avatar', action, '--input', '-'],
    objectCliEnvironment(f.original.root, { AGENTMUX_RPC_ENDPOINT: 'unix:' + join(f.original.root, 'control.sock'), AGENTMUX_AGENT_SESSION_ID: actor, AGENTMUX_AGENT_CAPABILITY: f.original.credentials.capability }), JSON.stringify(input))
  const before = await cli('read', { target }); expect(before.code, before.stderr).toBe(0)
  const prepared = await f.sources.preview({ source: { origin: 'user', seriesId: 'original-series', entryId: 'original.png' } })
  const request = { target, operationId: 'original-mote-avatar', beforeRevision: JSON.parse(before.stdout).result.revision,
    source: prepared.source, definition: prepared.definition, parameters: { kind: 'image', zoom: 1, offsetX: 0, offsetY: 0 }, pngDataUrl: imageInput().dataUrl }
  const saved = await cli('save', request)
  expect(saved.code, saved.stderr).toBe(0); expect(JSON.parse(saved.stdout).result).toMatchObject({ state: 'saved', operation: { actor: { kind: 'agent', id: 'actor-a' }, phase: 'published' } })
  expect(JSON.parse(saved.stdout).result.current.readerIdentity).toMatchObject({ kind: 'agent', id: 'actor-a' })
  const other = await cli('read', { target, operationId: request.operationId }, 'actor-b'); expect(other.code, other.stderr).toBe(0); expect(JSON.parse(other.stdout).result).toMatchObject({ readerIdentity: { id: 'actor-b' }, operation: { actor: { id: 'actor-a' } } })
  const current = await f.moteWriter.read(target); expect(current).not.toHaveProperty('readerIdentity')
  await rejectForeignSavedReceipt(['space', 'mote', 'avatar', 'save'], request, JSON.parse(saved.stdout).result)
  const legacy = { ...request, operationId: 'actorless-old-mote', beforeRevision: current.revision }
  const directory = await moteAvatarOperationDirectory(await f.scratch.avatarTargetDirectory(f.workspace, mote.id, target.objectKey), true)
  for (const phase of ['intent', 'publication-unknown', 'published'] as const) {
    const operationId = legacy.operationId + '-' + phase, original = { ...legacy, operationId }
    const operation = { operationId, requestHash: 'sha256:' + createHash('sha256').update(avatarSeriesCanonical(original)).digest('hex'), phase, durability: phase === 'published' ? 'confirmed' : 'unknown', ...(phase !== 'intent' ? { choice: current.choice } : {}) }
    const path = join(directory, operationId + '.json'), bytes = JSON.stringify({ schema: 'agentmux.avatar-operation.v1', target, operation }); await writeFile(path, bytes)
    const value = await cli('save', original); expect(value.code, value.stderr).toBe(0)
    expect(JSON.parse(value.stdout).result).toMatchObject({ state: phase === 'intent' ? 'refused' : 'unknown', operation: { actorAvailability: 'unavailable' } })
    expect(JSON.parse(value.stdout).result.operation).not.toHaveProperty('actor'); expect(await readFile(path, 'utf8')).toBe(bytes)
  }
})

let worker: Promise<string> | undefined
function workerFile(): Promise<string> {
  return worker ??= (async () => {
    const directory = resolve('apps/desktop/.tmp/t014-process'); await mkdir(directory, { recursive: true })
    const file = join(directory, 'worker.mjs'), electron = join(directory, 'electron.mjs')
    await writeFile(electron, `export const nativeTheme={shouldUseDarkColors:true}; export const nativeImage={createFromBuffer(){throw Error('Use the exact controlled native port')}}; export const app={getPath(){return process.env.T014_PRIVATE_HOME}};`)
    const { build } = createRequire(resolve('packages/core/package.json'))('esbuild') as typeof import('esbuild')
    await build({ stdin: { resolveDir: process.cwd(), contents: `
      import {readFile} from 'node:fs/promises';
      import { ConfigStore } from './apps/desktop/src/main/config-store.ts';
      import { ConfigOwner } from './apps/desktop/src/main/config-owner.ts';
      import { SpaceObjectAvatarOwner } from './apps/desktop/src/main/space-object-avatar.ts';
      import { createSpaceObjectAvatarResolver } from './apps/desktop/src/main/space-object-avatar-target.ts';
      import { SpaceObjectImages } from './apps/desktop/src/main/space-object-images.ts';
      import { WorkbenchUserStateStore } from './apps/desktop/src/main/workbench-user-state.ts';
      import { controlledNativeImage } from './apps/desktop/test/fixtures/mote-identity-image.ts';
      import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state';
      const [configPath, spatialPath, userPath, bytes]=process.argv.slice(2), request=JSON.parse(bytes);
      const store=new ConfigStore(configPath); let config=await store.get();
      const configOwner=new ConfigOwner({read:()=>config,save:value=>store.save(value),publish:value=>{config=value}});
      const resolver=createSpaceObjectAvatarResolver(configOwner, {categoryAppearanceDirectory(){throw Error('Original graph required')},topicAppearanceDirectory(){throw Error('Original graph required')}},new AgentMuxSpatialStateStore(spatialPath));
      const images=new SpaceObjectImages(resolver,controlledNativeImage),owner=new SpaceObjectAvatarOwner(configOwner,store,images,resolver),user=new WorkbenchUserStateStore(userPath);
      const beforeBytes=await readFile(configPath);
      const context={actor:{kind:'agent',id:'actor-a',hostId:'local',runId:'run-actor-a'},async assertCurrent(){}};
      const read=await owner.call('space.object.avatar.read',{target:request.target,operationId:request.operationId},context);
      const result=await owner.call('space.object.avatar.save',request,context);
      console.log(JSON.stringify({pid:process.pid,unchangedByAvatar:beforeBytes.equals(await readFile(configPath)),read,result,requests:await user.readObjectAvatarRequests(request.target),workface:await user.read()}));
    ` }, outfile: file, platform: 'node', format: 'esm', bundle: true, packages: 'external', alias: { electron }, logLevel: 'silent' })
    return file
  })()
}
function child(worker: string, args: string[]): Promise<any> {
  return new Promise((yes, no) => {
    const proc = spawn(process.execPath, [worker, ...args], { env: { ...process.env, T014_PRIVATE_HOME: resolve(args[0]!, '..') }, stdio: ['ignore', 'pipe', 'pipe'] }); let out = '', err = ''
    proc.stdout.on('data', value => { out += value }); proc.stderr.on('data', value => { err += value }); proc.on('error', no)
    proc.on('close', code => code ? no(new Error('Private avatar process failed: ' + err)) : yes(JSON.parse(out)))
  })
}
