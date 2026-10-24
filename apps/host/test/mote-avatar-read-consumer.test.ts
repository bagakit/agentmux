import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import * as core from '@agentmux/core'
import { avatarSeriesCanonical, type MoteAvatarSeriesChoice } from '@agentmux/core/mote-avatar-series'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { imagePng } from '../../desktop/test/fixtures/mote-identity-image.js'
import { startAgentMuxHost } from '../src/host.js'
import { ScratchTopics } from '../src/mote-resources.js'
import { directoryIdentity, SCRATCH_WORKSPACE_ID } from '../src/mote-model.js'
import { saveObjectAvatarFile } from '../src/object-avatar-files.js'
import { moteAvatarOperationDirectory, savedMoteAvatarSnapshot } from '../src/mote-avatar-state.js'

const cleanup: Array<() => void | Promise<void>> = [], facts: unknown[] = []
afterEach(async () => { try { for (const close of cleanup.splice(0).reverse()) await close() } finally { vi.restoreAllMocks(); vi.unstubAllEnvs() } })
afterAll(async () => { if (process.env.MOTE_AVATAR_FACTS) await writeFile(process.env.MOTE_AVATAR_FACTS, JSON.stringify({
  schema: 'agentmux.default-host-avatar-read.v1', scope: 'Actual default startAgentMuxHost, original native Mote identity, immutable PNG owner, strict public Unix RPC and compiled CLI. Synthetic resources, controlled Runtime connectivity only; no live App, assets, SSH or account.', facts
}, null, 2) + '\n') })
const digest = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex')

async function fixture() {
  const original = await rpcOwnerFixture(['original-avatar-agent'], core)
  cleanup.push(original.close)
  const workspace = { id: SCRATCH_WORKSPACE_ID, hostId: 'local', path: join(await realpath(original.root), 'homes') }
  await mkdir(workspace.path)
  const topics = new ScratchTopics(), topic = await topics.ensureMote(workspace, 'view:original-avatar')
  const target = { workspaceId: workspace.id, topicId: topic.id, objectKey: directoryIdentity('local', topic.identityDirectoryPath!) }
  const directory = topic.physicalDirectoryPath!, png = imagePng(), ref = await saveObjectAvatarFile(directory, png)
  const configurationPath = join(original.root, 'original-app-config.json'), hostingPath = join(original.root, 'original-host-routes.json'),
    socketPath = join(original.root, 'host.sock'), desktopPath = join(original.root, 'desktop.sock'), connectionDirectory = join(original.root, 'connections')
  const config = { workspaces: [workspace], appearance: { spaceObjectIcons: { [target.objectKey]: ref as unknown }, spaceObjectIconRevisions: { [target.objectKey]: 'original-publication' } } }
  const save = () => writeFile(configurationPath, JSON.stringify(config))
  await save(); await writeFile(hostingPath, JSON.stringify({ hosts: [{ id: 'local', kind: 'local', label: 'Original Host' }] }))
  await mkdir(connectionDirectory, { mode: 0o700 }); await original.client.dispose()
  let host: Awaited<ReturnType<typeof startAgentMuxHost>> | undefined
  async function start() {
    const connect = vi.spyOn(core.AgentMuxClient.prototype, 'connect').mockImplementationOnce(async function () {
      const inner = this as unknown as typeof original.inner
      await inner.registry.load('local'); inner.connected = true
      for (const key of ['status', 'identity', 'input', 'observeOutput', 'attach', 'detach', 'stop']) inner.kernel[key] = original.inner.kernel[key]
      inner.kernel.isConnected = () => false
    })
    try {
      host = await startAgentMuxHost({ store: original.store, socketPath, desktopSocketPath: desktopPath,
        configurationPath: hostingPath, connections: { directory: connectionDirectory, adapters: [], moteConfigurationPath: configurationPath },
        mobileBuildDirectory: join(original.root, 'absent-mobile-assets') })
      await vi.waitFor(() => expect((host!.client as unknown as { connected: boolean }).connected).toBe(true))
    } finally { connect.mockRestore() }
  }
  async function stop() { const previous = host; host = undefined; await previous?.dispose() }
  cleanup.push(stop); await start()
  const call = async <M extends core.AgentMuxRpcMethod>(method: M, params: core.AgentMuxRpcParams<M>) => {
    const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } })
    try { return await rpc.call(method, params) } finally { await rpc.dispose() }
  }
  const read = (input = target, operationId?: string) => call('space.mote.avatar.read', { target: input, ...(operationId ? { operationId } : {}) })
  return { original, workspace, target, directory, png, ref, config, save, read, call, start, stop, socketPath, desktopPath,
    current: () => host!, configurationPath, assetPath: join(directory, '.agentmux', 'avatars', ref.fileName) }
}

it('default Host reads the exact saved Mote PNG through public RPC and compiled CLI, then reopens the same unknown save receipt', async () => {
  const f = await fixture()
  const choice: MoteAvatarSeriesChoice = { kind: 'series', image: f.ref,
    source: { origin: 'user', seriesId: 'original-series', entryId: 'original-entry', revision: 'sha256:' + 'a'.repeat(64) },
    definition: { kind: 'glb', file: 'original.glb' }, parameters: { kind: 'glb', mode: 'original', roughness: .5, color: '#102030', morphs: {}, yaw: 0 } }
  f.config.appearance.spaceObjectIcons[f.target.objectKey] = choice; await f.save()
  const operation = { operationId: 'original-avatar-save', requestHash: 'sha256:' + 'b'.repeat(64), phase: 'publication-unknown' as const, durability: 'unknown' as const, choice }
  const receiptPath = join(await moteAvatarOperationDirectory(f.directory, true), operation.operationId + '.json')
  await writeFile(receiptPath, JSON.stringify({ schema: 'agentmux.avatar-operation.v1', target: f.target, operation }))
  const configBefore = await readFile(f.configurationPath), receiptBefore = await readFile(receiptPath)
  const first = await f.read(f.target, operation.operationId)
  expect(first).toMatchObject({ target: f.target, choice, operation, image: { width: 256, height: 256 }, source: { state: 'unavailable' }, issues: [] })
  expect(first.image?.dataUrl).toBe('data:image/png;base64,' + f.png.toString('base64'))
  expect(first.revision).toBe(savedMoteAvatarSnapshot(f.config.appearance, f.target.objectKey).revision)
  const expectedRevision = 'sha256:' + digest(avatarSeriesCanonical({ present: true, value: choice, publication: 'original-publication' }))
  expect(first.revision).toBe(expectedRevision)
  await expect(stat(f.desktopPath)).rejects.toMatchObject({ code: 'ENOENT' })
  const loader = pathToFileURL(join(import.meta.dirname, 'fixtures/avatar-cli-loaded.mjs')).href
  const cli = await runCompiledObjectCli(['--endpoint', 'unix:' + f.socketPath, 'space', 'mote', 'avatar', 'read', '--input', '-'],
    objectCliEnvironment(f.original.root, { pnpm_config_verify_deps_before_run: 'false', NODE_OPTIONS: [process.env.NODE_OPTIONS, '--import', loader].filter(Boolean).join(' ') }),
    JSON.stringify({ target: f.target, operationId: operation.operationId }))
  expect(cli.code, cli.stdout + cli.stderr).toBe(0)
  expect(JSON.parse(cli.stdout).result).toEqual(first)
  const owner = await f.call('runtime.owner.identity', {})
  await f.stop(); await f.start()
  const reopened = await f.read(f.target, operation.operationId)
  expect(reopened).toEqual(first)
  const current = await f.call('runtime.owner.identity', {})
  expect(current.owner.runtimeId).toBe(owner.owner.runtimeId); expect(current.owner.ownerInstanceId).not.toBe(owner.owner.ownerInstanceId)
  expect(await readFile(f.configurationPath)).toEqual(configBefore); expect(await readFile(receiptPath)).toEqual(receiptBefore)
  expect(f.original.inner.kernel.input).not.toHaveBeenCalled(); expect(f.original.inner.kernel.stop).not.toHaveBeenCalled()
  facts.push({ case: 'default-rpc-cli-reopen', exactTarget: f.target, sourceRevision: first.revision, pngSHA256: digest(f.png), originalOperation: operation,
    sameRuntime: true, newInstance: true, sameReceipt: true, sameChoice: true, distinctHostingAndMoteConfiguration: true, desktopAbsent: true, inputEffects: 0, cliExit: cli.code })
})

it('rejects a foreign Mote object and remote resource while keeping the original PNG, Session and local read available', async () => {
  const f = await fixture(), original = await f.read()
  expect(original.image?.dataUrl).toBe('data:image/png;base64,' + f.png.toString('base64'))
  const foreign = { ...f.target, objectKey: directoryIdentity('local', join(f.original.root, 'different-mote')) }
  f.config.appearance.spaceObjectIcons[foreign.objectKey] = f.ref; await f.save()
  await expect(f.read(foreign)).rejects.toThrow('original object directory changed')
  f.config.workspaces[0]!.hostId = 'another-original-host'; await f.save()
  await expect(f.read()).rejects.toMatchObject({ code: 'MOTE_AVATAR_SOURCE_UNCONFIRMED' })
  f.config.workspaces[0]!.hostId = 'local'; await f.save()
  expect((await f.read()).image).toEqual(original.image)
  expect((await f.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: 'original-avatar-agent' } })).session.agentSessionId).toBe('original-avatar-agent')
  expect(f.original.inner.kernel.input).not.toHaveBeenCalled(); expect(f.original.inner.kernel.stop).not.toHaveBeenCalled()
  facts.push({ case: 'foreign-object', exactTarget: f.target, foreignTarget: foreign, validOriginalImage: true, foreignReadRefused: true, remoteResourceRefused: true, originalSessionRetained: true })
})

it('reports a missing, corrupt or non-crop PNG without changing the saved choice and recovers the same read after repair', async () => {
  const f = await fixture(), before = await f.read(), configBefore = await readFile(f.configurationPath)
  await unlink(f.assetPath)
  const missing = await f.read(); expect(missing.image).toBeUndefined(); expect(missing.choice).toEqual(f.ref); expect(missing.issues.length).toBeGreaterThan(0)
  await writeFile(f.assetPath, imagePng(256, 256, [190, 20, 10]))
  const corrupt = await f.read(); expect(corrupt.image).toBeUndefined(); expect(corrupt.issues.join(' ')).toContain('do not match')
  await unlink(f.assetPath); await symlink(join(f.original.root, 'not-an-avatar'), f.assetPath)
  const linked = await f.read(); expect(linked.image).toBeUndefined(); expect(linked.source?.state).toBe('unavailable')
  await unlink(f.assetPath); await writeFile(f.assetPath, f.png)
  expect(await f.read()).toEqual(before)
  const small = await saveObjectAvatarFile(f.directory, imagePng(16, 16))
  f.config.appearance.spaceObjectIcons[f.target.objectKey] = small; await f.save()
  const wrongSize = await f.read(); expect(wrongSize.image).toBeUndefined(); expect(wrongSize.issues.join(' ')).toContain('256 pixel')
  f.config.appearance.spaceObjectIcons[f.target.objectKey] = 'rocket'; await f.save()
  await expect(f.read()).rejects.toMatchObject({ code: 'MOTE_AVATAR_SOURCE_UNAVAILABLE' })
  f.config.appearance.spaceObjectIcons[f.target.objectKey] = f.ref; await f.save()
  expect(await readFile(f.configurationPath)).toEqual(configBefore)
  expect(await f.read()).toEqual(before)
  facts.push({ case: 'optional-avatar-failure', missing: missing.source, corrupt: corrupt.source, symlink: linked.source, wrongSize: wrongSize.source, unsupportedChoiceRetained: true, sameReadRecovered: true })
})

it('leaves avatar save and series with their original Desktop owner instead of intercepting them in the PNG reader', async () => {
  const f = await fixture(), current = await f.read(), calls: string[] = []
  const server = new core.AgentMuxControlServer({ socketPath: f.desktopPath, coreClients: () => [], moteAvatars: {
    call: async (method, params) => {
      calls.push(method)
      if (method === 'space.mote.avatar.list') return { roots: [], series: [], issues: [] } as never
      if (method === 'space.mote.avatar.save') return { state: 'unknown', issue: 'Original editor save receipt remains unconfirmed.', current } as never
      throw Error('Unexpected original editor method ' + method + JSON.stringify(params))
    }
  } }); await server.start(); cleanup.push(() => server.stop())
  expect(await f.call('space.mote.avatar.list', {})).toEqual({ roots: [], series: [], issues: [] })
  const saved = await f.call('space.mote.avatar.save', { target: f.target, operationId: 'original-editor-operation', beforeRevision: current.revision,
    source: { origin: 'user', seriesId: 'original-series', entryId: 'original-entry', revision: 'sha256:' + 'a'.repeat(64) },
    definition: { kind: 'image', file: 'original.png' }, parameters: { kind: 'image', zoom: 1, offsetX: 0, offsetY: 0 }, pngDataUrl: current.image!.dataUrl })
  expect(saved.state).toBe('unknown'); expect(saved.current.choice).toEqual(f.ref)
  expect(calls).toEqual(['space.mote.avatar.list', 'space.mote.avatar.save'])
  expect(await f.read()).toEqual(current)
  facts.push({ case: 'original-editor-routing', originalMethods: calls, saveState: saved.state, pngReadUnchanged: true })
})
