import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import mainSource from '../src/main/index.ts?raw'
import { AgentMuxClient, AgentMuxControlServer, AgentMuxFileAgentSessionStore, connectAgentMuxRpc } from '@agentmux/core'
import { startAgentMuxHost } from '../../host/src/host'
import { WorkbenchUserStateStore } from '../src/main/workbench-user-state'
import { WorkbenchWindowStore } from '../src/main/workbench-window-store'
import { WorkbenchCloseOwner } from '../src/main/workbench-close-owner'
import { DesktopStorageRecoveryExports } from '../src/main/storage-recovery-exports'
import { recoverWorkbenchBeforeLoad } from '../src/main/workbench-recovery-bootstrap'
import { localRuntimeRecovery } from '../src/main/local-runtime-recovery'

const roots: string[] = [], cleanups: Array<() => Promise<unknown>> = []
const body = JSON.stringify({ version: 1, state: { agentComposerDrafts: { original: 'Original unsent input' }, agentSteerQueues: { original: [{ operationId: 'original-prompt', text: 'Original queued input', status: 'queued', promptCondition: null }] } } }) + '\n'
beforeEach(() => {
  for (const key of Object.keys(process.env)) if (/^(?:AGENTMUX_|CTXMUX_)/u.test(key) && !key.startsWith('AGENTMUX_BOOTSTRAP_')) vi.stubEnv(key, undefined)
  // Only this external Native-connect leaf is controlled. Actual Host, Headless,
  // public Unix storage service and original Main/data owners remain real.
  vi.spyOn(AgentMuxClient.prototype, 'connect').mockRejectedValue(Object.assign(new Error('Controlled private Native observation unavailable'), { code: 'TEST_NATIVE_UNAVAILABLE' }))
})
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })))
})
async function fixture() {
  const root = await mkdtemp('/tmp/amux-data-bootstrap-'); roots.push(root)
  const directory = join(root, 'state'); await mkdir(directory)
  for (const [name, value] of Object.entries({ AGENTMUX_STATE_DIRECTORY: directory, AGENTMUX_RUNTIME_DIRECTORY: root, AGENTMUX_MESSAGE_QUEUE_PATH: join(root, 'messages.ndjson') })) vi.stubEnv(name, value)
  const owners = () => {
    const user = new WorkbenchUserStateStore(join(directory, 'user.json')), windows = new WorkbenchWindowStore(join(directory, 'windows.json')), close = new WorkbenchCloseOwner(user)
    const exports = new DesktopStorageRecoveryExports(join(directory, 'exports'), () => [user.recoverySource(), windows.recoverySource(), close.recoverySource()])
    cleanups.push(async () => exports.dispose())
    return { user, windows, close, exports, stateDirectory: directory, storePath: join(directory, 'sessions.json'), socketPath: join(root, 'host.sock'), desktopSocketPath: join(root, 'desktop.sock') }
  }
  return { root, directory, owners }
}
async function backedUpHost() {
  const f = await fixture(), source = f.owners()
  await writeFile(source.user.path, body, { mode: 0o600 })
  await writeFile(source.windows.path, JSON.stringify({ schema: 'agentmux.workbench-windows.v1', mainWindowId: 'original-native-window', windows: [] }) + '\n', { mode: 0o600 })
  const desktop = new AgentMuxControlServer({ socketPath: source.desktopSocketPath, storageRecoveryExports: source.exports })
  await desktop.start(); cleanups.push(() => desktop.stop())
  const host = await startAgentMuxHost({ store: new AgentMuxFileAgentSessionStore(source.storePath), socketPath: source.socketPath,
    desktopSocketPath: source.desktopSocketPath, mobileBuildDirectory: join(f.root, 'no-mobile-assets'), mobilePort: 0 })
  cleanups.push(() => host.dispose())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: source.socketPath } }); cleanups.push(() => rpc.dispose())
  const generation = (await rpc.call('storage.backup.create', {})).generation
  const listed = (await rpc.call('storage.backup.list', {})).generations
  expect(listed.some(value => value.coverage?.some(member => member.sourceId === 'desktop.workbench' && member.memberId === 'desktop.user-state/document'))).toBe(true)
  await desktop.stop()
  await unlink(source.user.path); await unlink(source.windows.path)
  return { ...f, source, host, rpc, generation }
}

it('actual startHost injects the Main source into Headless and a live original Host restores it before default loads', async () => {
  const f = await backedUpHost(), current = f.owners()
  const result = await recoverWorkbenchBeforeLoad(current)
  const facts = result.operationId ? await f.rpc.call('storage.restore.inspect', { operationId: result.operationId }).then(value => value.operation, error => ({ code: error.code })) : undefined
  expect(result, JSON.stringify({ result, facts })).toMatchObject({ state: 'restored' })
  expect(JSON.parse((await current.user.read())!).state.agentSteerQueues.original[0]).toMatchObject({ operationId: 'original-prompt', awaitingExplicitSend: true })
  expect((await current.windows.load()).state.mainWindowId).toBe('original-native-window')
  expect(AgentMuxClient.prototype.connect).toHaveBeenCalled()
  // Normal repeat startup does only its two primary existence observations.
  expect(await recoverWorkbenchBeforeLoad(current)).toEqual({ state: 'unchanged' })
})

it('a cold data owner restores only original Main members without constructing or connecting a Client', async () => {
  const f = await backedUpHost(); await f.rpc.dispose(); await f.host.dispose()
  const count = vi.mocked(AgentMuxClient.prototype.connect).mock.calls.length, current = f.owners()
  expect(await recoverWorkbenchBeforeLoad(current)).toMatchObject({ state: 'restored' })
  expect(vi.mocked(AgentMuxClient.prototype.connect).mock.calls).toHaveLength(count)
  expect(JSON.parse((await current.user.read())!).state.agentComposerDrafts.original).toBe('Original unsent input')
  expect((await current.windows.load()).state.mainWindowId).toBe('original-native-window')
})

it('Desktop boot restores missing identity from its verified backup and the same Host answers Mesh again', async () => {
  const f = await backedUpHost()
  const identity = join(f.directory, 'semantic-runtime.json')
  const original = await readFile(identity)
  const before = await f.rpc.call('settings.mesh.inspect', {})
  const recovery = localRuntimeRecovery(f.source)
  expect(await recovery.check()).toEqual({ state: 'unchanged' })
  await f.rpc.dispose(); await f.host.dispose()
  await unlink(identity); await unlink(identity + '.original')
  expect(await recovery.check()).toEqual({ state: 'restored' })
  expect(await readFile(identity)).toEqual(original)
  await expect(readFile(f.source.user.path)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await recoverWorkbenchBeforeLoad(f.owners())).toMatchObject({ state: 'restored' })
  expect(JSON.parse((await f.source.user.read())!).state.agentComposerDrafts.original).toBe('Original unsent input')

  const host = await startAgentMuxHost({ store: new AgentMuxFileAgentSessionStore(f.source.storePath), socketPath: f.source.socketPath,
    desktopSocketPath: f.source.desktopSocketPath, mobileBuildDirectory: join(f.root, 'no-mobile-assets'), mobilePort: 0 })
  cleanups.push(() => host.dispose())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: f.source.socketPath } }); cleanups.push(() => rpc.dispose())
  const after = await rpc.call('settings.mesh.inspect', {})
  expect(after.owner.runtimeId).toBe(before.owner.runtimeId)
  expect(after.owner.ownerInstanceId).not.toBe(before.owner.ownerInstanceId)
})

it('Desktop uses a verified earlier backup when the newest identity blob is missing and can recover a later confirmed loss', async () => {
  const f = await backedUpHost(), identity = join(f.directory, 'semantic-runtime.json')
  const original = await readFile(identity, 'utf8')
  await writeFile(identity, original + '\n')
  const latest = (await f.rpc.call('storage.backup.create', {})).generation
  expect(latest.generationId).not.toBe(f.generation.generationId)
  const recoveryDirectory = join(f.directory, 'recovery')
  const manifest = JSON.parse(await readFile(join(recoveryDirectory, 'generations', latest.generationId + '.json'), 'utf8'))
  const canonical = manifest.sources.find((source: { id: string }) => source.id === 'core.semantic').members.find((member: { id: string }) => member.id === 'semantic-runtime.json')
  const custody = manifest.sources.find((source: { id: string }) => source.id === 'core.semantic').members.find((member: { id: string }) => member.id === 'semantic-runtime.json.original')
  expect(canonical.sha256).not.toBe(custody.sha256)
  await f.rpc.dispose(); await f.host.dispose()
  await unlink(join(recoveryDirectory, 'objects', canonical.sha256))

  for (let loss = 0; loss < 2; loss++) {
    await unlink(identity); await unlink(identity + '.original')
    expect(await localRuntimeRecovery(f.source).check()).toEqual({ state: 'restored' })
    expect(await readFile(identity, 'utf8')).toBe(original)
    expect(await readFile(identity + '.original', 'utf8')).toBe(original)
  }
})

it('the App picker keeps a signer-only namespace intact until an original backup is selected', async () => {
  const f = await backedUpHost(), identity = join(f.directory, 'semantic-runtime.json')
  const bytes = await readFile(identity, 'utf8'), original = JSON.parse(bytes)
  const selected = join(f.root, 'original-recovery-file'), wrong = join(f.root, 'wrong-recovery-file')
  const signer = join(f.directory, 'agent-creation-identity.json')
  const signerBytes = JSON.stringify({ schema: 'agentmux.agent-creation-authority.v1', ...original.creationIdentity })
  await f.rpc.dispose(); await f.host.dispose()
  await writeFile(signer, signerBytes, { mode: 0o600 })
  await writeFile(signer + '.original', 'unreadable auxiliary copy', { mode: 0o600 })
  await writeFile(selected, bytes, { mode: 0o600 })
  await writeFile(wrong, JSON.stringify({ ...original, authority: 'wrong-original-binding' }), { mode: 0o600 })
  await unlink(identity); await unlink(identity + '.original')
  await rm(join(f.directory, 'recovery'), { recursive: true })
  const recovery = localRuntimeRecovery(f.source)
  const missing = await recovery.check()
  expect(missing).toMatchObject({ state: 'needs-backup' })
  expect(await recovery.choose(async () => null)).toEqual(missing)
  expect(await recovery.choose(async () => wrong)).toEqual({ state: 'needs-backup', code: 'IDENTITY_BACKUP_UNVERIFIED' })
  await expect(readFile(identity)).rejects.toMatchObject({ code: 'ENOENT' })
  await writeFile(identity, 'unconfirmed target record', { mode: 0o600 })
  const picker = vi.fn(async () => selected)
  expect(await recovery.choose(picker)).toEqual({ state: 'blocked', code: 'IDENTITY_TARGET_UNCONFIRMED' })
  expect(picker).not.toHaveBeenCalled()
  expect(await readFile(identity, 'utf8')).toBe('unconfirmed target record')
  await unlink(identity)
  expect(await recovery.choose(async () => selected)).toEqual({ state: 'restored' })
  expect(await readFile(identity, 'utf8')).toBe(bytes)
  expect(await readFile(signer, 'utf8')).toBe(signerBytes)
})

it('an explicitly unused namespace can initialize while used-but-unconfirmed missing originals retain their write gates', async () => {
  const f = await fixture(), first = f.owners()
  expect(await recoverWorkbenchBeforeLoad(first)).toEqual({ state: 'not-created' })
  expect(await first.user.read()).toBeNull()
  const used = f.owners()
  await writeFile(join(f.directory, 'semantic-runtime.json'), JSON.stringify({ schema: 'agentmux.semantic-runtime.v1', runtimeId: 'original-runtime' }), { mode: 0o600 })
  expect(await recoverWorkbenchBeforeLoad(used)).toMatchObject({ state: 'unavailable', issue: 'DESKTOP_RECOVERY_COVERAGE_UNCONFIRMED' })
  await expect(used.user.read()).rejects.toMatchObject({ code: 'DESKTOP_RECOVERY_SOURCE_UNCONFIRMED' })
  expect(await used.windows.load()).toMatchObject({ writable: false })
})

it('the actual Main buildWindow consumer awaits recovery before its first configuration or native-window work', async () => {
  const file = ts.createSourceFile('index.ts', mainSource, ts.ScriptTarget.Latest, true)
  let functionSource: string | undefined
  const visit = (node: ts.Node) => { if (ts.isFunctionDeclaration(node) && node.name?.text === 'buildWindow') functionSource = node.getText(file); else ts.forEachChild(node, visit) }
  visit(file); expect(functionSource).toBeTypeOf('string')
  let release!: () => void, releaseIdentity!: () => void
  const identityWaiting = new Promise<void>(resolve => { releaseIdentity = resolve })
  const waiting = new Promise<void>(resolve => { release = resolve }), configuration = vi.fn(async () => { throw Error('Controlled next original owner boundary') })
  const recovery = vi.fn(() => waiting)
  const implementation = ts.transpileModule(functionSource!.replaceAll('import.meta.dirname', JSON.stringify(resolve('apps/desktop/src/main'))) + '\nglobalThis.actualBuildWindow = buildWindow', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  const context = { runtimeIdentityRecovery: { check: () => identityWaiting }, recoverWorkbench: recovery, configStore: { get: configuration }, actualBuildWindow: undefined as (() => Promise<void>) | undefined }
  runInNewContext(implementation, context)
  const building = context.actualBuildWindow!(); const observed = building.catch(error => error)
  await Promise.resolve(); await Promise.resolve()
  expect(configuration).not.toHaveBeenCalled()
  expect(recovery).not.toHaveBeenCalled()
  releaseIdentity()
  await Promise.resolve(); await Promise.resolve()
  expect(recovery).toHaveBeenCalledOnce()
  expect(configuration).not.toHaveBeenCalled()
  release()
  expect((await observed).message).toBe('Controlled next original owner boundary')
  expect(configuration).toHaveBeenCalledOnce()
})
