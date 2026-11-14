import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, readdir, rename, symlink, writeFile, stat, unlink, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
const { build } = createRequire(new URL('../package.json', import.meta.url))('esbuild')
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import * as core from '@agentmux/core'
import { startAgentMuxHost } from '../src/host.js'
import { FilePathMutations } from '../src/file-path-mutations.js'
import { OrdinaryWorkspaceFiles } from '../src/ordinary-files.js'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import type { FileMkdirParams, FileMutationInspectParams } from '@agentmux/core/files'

const diskFault = vi.hoisted(() => ({ directory: '', failAt: 0, opened: 0 }))
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, open: async (path: any, ...args: any[]) => {
    const handle = await (fs.open as any)(path, ...args)
    if (String(path) === diskFault.directory && args[0] === 'r' && ++diskFault.opened === diskFault.failAt)
      handle.sync = async () => { throw new Error('Injected original mutation directory ACK failure') }
    return handle
  } }
})

const cleanup: Array<() => unknown | Promise<unknown>> = [], facts: unknown[] = []
const helper = resolve('apps/host/resources/bin/agentmux-workspace-move')
const agent = { actor: { kind: 'agent' as const, id: 'original-files-agent' }, callerHostId: 'local' }
beforeAll(async () => { await promisify(execFile)(process.execPath, [resolve('apps/host/scripts/build-workspace-move-helper.mjs')]) })
afterAll(async () => { if (process.env.AGENTMUX_FILE_PATH_EVIDENCE) await writeFile(process.env.AGENTMUX_FILE_PATH_EVIDENCE, JSON.stringify({ schema: 'agentmux.file-path-proof.v1', platform: process.platform, facts }, null, 2) + '\n') })
afterEach(async () => { diskFault.directory = ''; diskFault.failAt = 0; diskFault.opened = 0; for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

const operationDirectory = (root: string, operationId: string) => join(root, 'file-path-mutations', createHash('sha256').update(operationId).digest('hex'))
const operationRecord = (root: string, operationId: string) => join(operationDirectory(root, operationId), 'request.json')

async function fixture(options: { beforePathPublish?: () => Promise<void>; beforePathRename?: () => Promise<void>; pathMutationFault?: string } = {}) {
  const original = await rpcOwnerFixture([agent.actor.id, 'other-files-agent'], core); cleanup.push(original.close)
  const root = join(original.root, 'workspace'); await mkdir(root)
  const workspace = { id: 'original-files', hostId: 'local', path: root, name: 'Original files' }
  const ordinary = new OrdinaryWorkspaceFiles({ helperPath: helper, ...options })
  const owner = new FilePathMutations({ directory: join(original.root, 'file-path-mutations'), files: ordinary, noteLease: work => work() })
  const descriptor = (path: string) => ({ hostId: 'local', workspaceId: workspace.id, workspacePath: root, zoneId: 'original-files-zone', zonePath: root, path })
  const request = async (path: string, operationId: string): Promise<FileMkdirParams> => {
    const observed = await owner.stat(workspace, path)
    return { zoneId: 'original-files-zone', path, expectedResource: descriptor(path), operationId, expectedAbsent: true, expected: { root: observed.root, parent: observed.parent } }
  }
  const inspect = (input: FileMkdirParams): FileMutationInspectParams => ({ zoneId: input.zoneId, path: input.path, operationId: input.operationId, expectedResource: input.expectedResource })
  return { original, root, workspace, ordinary, owner, descriptor, request, inspect }
}

async function hostFixture(physicalName?: string) {
  const f = await fixture()
  if (physicalName) { const root = join(f.original.root, physicalName); await rename(f.root, root); f.root = root; f.workspace.path = root }
  const spatial = new core.AgentMuxSpatialStateStore()
  const notes = join(f.original.root, 'private-notes'); await mkdir(notes); await mkdir(join(f.original.root, 'state'), { recursive: true })
  await writeFile(join(f.original.root, 'state/notes-location.json'), JSON.stringify({ schemaVersion: 1, directory: notes, operations: {}, pending: null }))
  await spatial.commit({ expectedRevision: 0, graph: {
    spaces: [{ spaceId: 'original-files-space', kind: 'folder', name: 'Private Files', hostId: 'local', directoryPath: f.root, projectId: 'original-files-space' }],
    zones: [{ zoneId: 'original-files-zone', workspaceId: f.workspace.id, kind: 'directory', hostId: 'local', directoryPath: f.root, branch: null }],
    bindings: [{ spaceId: 'original-files-space', zoneId: 'original-files-zone' }], tabs: [], regions: [], layouts: {}, tabLayouts: {}, resources: {}
  } })
  const configurationPath = join(f.original.root, 'configuration.json')
  await writeFile(configurationPath, JSON.stringify({ hosts: [{ id: 'local', kind: 'local', label: 'Private' }], workspaces: [f.workspace] }))
  const native = f.original.inner.kernel; await f.original.client.dispose()
  const connect = vi.spyOn(core.AgentMuxClient.prototype, 'connect').mockImplementationOnce(async function () {
    const inner = this as unknown as typeof f.original.inner
    await inner.registry.load('local'); inner.connected = true
    for (const name of ['isConnected', 'status', 'identity', 'input', 'observeOutput', 'attach', 'detach', 'stop']) inner.kernel[name] = native[name]
  })
  const socketPath = join(f.original.root, 'host.sock')
  let host: Awaited<ReturnType<typeof startAgentMuxHost>>
  try {
    host = await startAgentMuxHost({ store: f.original.store, configurationPath, socketPath, desktopSocketPath: join(f.original.root, 'absent-desktop.sock'), mobileBuildDirectory: join(f.original.root, 'absent-mobile') })
    cleanup.push(() => host.dispose())
    await vi.waitFor(() => expect((host.client as unknown as typeof f.original.inner).connected).toBe(true))
  } finally { connect.mockRestore() }
  const env = objectCliEnvironment(f.original.root, { AGENTMUX_AGENT_SESSION_ID: agent.actor.id, AGENTMUX_AGENT_CAPABILITY: f.original.capability })
  const cli = async (action: string[], input: unknown, who = agent.actor.id) => {
    const result = await runCompiledObjectCli(['--endpoint', 'unix:' + socketPath, 'file', ...action, '--input', '-'],
      { ...env, AGENTMUX_AGENT_SESSION_ID: who }, JSON.stringify(input))
    return { ...result, body: result.stdout ? JSON.parse(result.stdout) : undefined }
  }
  return { ...f, host, cli, configurationPath }
}

it('compiled CLI consumes actual Host resource mapping, native stat/mkdir and original operation inspection without touching Run/cwd', async () => {
  const f = await hostFixture(), beforeSessions = await readFile(f.original.store.path)
  const read = { zoneId: 'original-files-zone', path: 'New directory', expectedResource: { hostId: 'local', workspaceId: f.workspace.id, workspacePath: f.root } }
  const stat = await f.cli(['stat'], read)
  expect(stat.code, stat.stderr).toBe(0)
  expect(stat.body.result.result).toMatchObject({ status: 'observed', observation: { entry: { kind: 'absent' }, implementation: { platform: process.platform, stat: 'native', mkdir: 'native-no-replace' } } })
  const observed = stat.body.result, input: FileMkdirParams = { ...read, operationId: 'host-original-mkdir', expectedResource: observed.resource, expectedAbsent: true,
    expected: { root: observed.result.observation.root, parent: observed.result.observation.parent } }
  const created = await f.cli(['mkdir'], input)
  expect(created.code, created.stderr).toBe(0)
  expect(created.body.result).toMatchObject({ operationId: input.operationId, resource: input.expectedResource,
    result: { action: 'mkdir', filesystem: 'created', durability: 'confirmed' } })
  const after = await f.cli(['stat'], read)
  expect(after.body.result.result.observation.entry).toMatchObject({ kind: 'directory', witness: created.body.result.result.createdWitness })
  const query = f.inspect(input), found = await f.cli(['mutation', 'inspect'], query)
  expect(found.code, found.stderr).toBe(0)
  expect(found.body.result.result).toMatchObject({ filesystem: 'created', durability: 'unconfirmed', original: input })
  expect((await f.cli(['mutation', 'inspect'], query, 'other-files-agent')).code).toBe(1)
  expect((await f.cli(['mkdir'], { ...input, operationId: input.operationId, path: 'other', expectedResource: { ...input.expectedResource, path: 'other' } })).code).toBe(1)
  for (const resource of [{ ...read.expectedResource, hostId: 'wrong-host' }, { ...read.expectedResource, workspaceId: 'wrong-workspace' }, { ...read.expectedResource, workspacePath: join(f.root, 'wrong-root') }])
    expect((await f.cli(['stat'], { ...read, expectedResource: resource })).code).toBe(1)
  const bytes = await readFile(f.original.store.path)
  expect(bytes).toEqual(beforeSessions); expect(nativeStop(f)).not.toHaveBeenCalled()
  facts.push({ scenario: 'compiled-cli-host-native', operationId: input.operationId, resource: input.expectedResource,
    createdWitness: created.body.result.result.createdWitness, originalRunStoreUnchanged: true, agentStopCalls: 0 })
})

function nativeStop(f: Awaited<ReturnType<typeof fixture>>) { return f.original.inner.kernel.stop as ReturnType<typeof vi.fn> }

it('native scope CAS refuses a replaced parent, a late symlink and an occupied destination', async () => {
  const f = await fixture(); await mkdir(join(f.root, 'parent'))
  const replaced = await f.request('parent/replaced', 'original-replaced-parent')
  await rename(join(f.root, 'parent'), join(f.root, 'old-parent')); await mkdir(join(f.root, 'parent'))
  expect((await f.owner.mkdir(f.workspace, replaced, agent)).result).toMatchObject({ filesystem: 'not-applied', code: 'FILE_PATH_SCOPE_CONFLICT' })
  const late = await fixture({ beforePathPublish: async () => {
    await rename(join(late.root, 'parent'), join(late.root, 'original-parent'))
    await symlink(join(late.original.root, 'external'), join(late.root, 'parent'))
  } }); await mkdir(join(late.root, 'parent')); await mkdir(join(late.original.root, 'external'))
  const lateInput = await late.request('parent/child', 'late-symlink')
  expect((await late.owner.mkdir(late.workspace, lateInput, agent)).result).toMatchObject({ filesystem: 'not-applied', code: 'FILE_PATH_SCOPE_CONFLICT' })
  expect(await readdir(join(late.original.root, 'external'))).toEqual([])
  const occupied = await fixture({ beforePathPublish: async () => { await writeFile(join(occupied.root, 'target'), 'keep later occupant') } })
  const occupiedInput = await occupied.request('target', 'later-occupant')
  expect((await occupied.owner.mkdir(occupied.workspace, occupiedInput, agent)).result).toMatchObject({ filesystem: 'not-applied', code: 'FILE_PATH_OCCUPIED' })
  expect(await readFile(join(occupied.root, 'target'), 'utf8')).toBe('keep later occupant')
})

it('producer crash preserves exact original identity for read-only inspection and never dispatches another mkdir', async () => {
  const f = await fixture({ pathMutationFault: 'after-publish-crash' }), input = await f.request('original', 'crashed-original')
  const producer = vi.spyOn(f.ordinary, 'mkdirPath')
  expect((await f.owner.mkdir(f.workspace, input, agent)).result.filesystem).toBe('unknown')
  const found = await f.owner.inspect(f.inspect(input), agent, f.workspace)
  expect(found.result).toMatchObject({ filesystem: 'created', durability: 'unconfirmed', original: input })
  const originalWitness = 'createdWitness' in found.result ? found.result.createdWitness : undefined
  expect((await f.owner.mkdir(f.workspace, input, agent)).result).toMatchObject({ filesystem: 'created', createdWitness: originalWitness })
  expect(producer).toHaveBeenCalledTimes(1)
  await expect(f.owner.inspect(f.inspect(input), { ...agent, callerHostId: 'other-host' }, f.workspace)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  facts.push({ scenario: 'producer-crash-no-replay', operationId: input.operationId, originalWitness, mkdirProducerCalls: producer.mock.calls.length })
})


it('prepared and producer-save ACK failures never release publication, while a final record ACK failure retains the actual effect', async () => {
  for (const failAt of [1, 2, 3]) {
    const f = await fixture(), input = await f.request('original', 'ack-failure-' + failAt)
    const producer = vi.spyOn(f.ordinary, 'mkdirPath')
    diskFault.directory = operationDirectory(f.original.root, input.operationId); diskFault.failAt = failAt; diskFault.opened = 0
    const result = await f.owner.mkdir(f.workspace, input, agent)
    expect(result.result.durability).toBe('unconfirmed')
    expect(result.result.filesystem).toBe(failAt === 3 ? 'created' : 'unknown')
    expect(producer).toHaveBeenCalledTimes(failAt === 1 ? 0 : 1)
    if (failAt < 3) await expect(stat(join(f.root, 'original'))).rejects.toMatchObject({ code: 'ENOENT' })
    else expect((await stat(join(f.root, 'original'))).isDirectory()).toBe(true)
    diskFault.failAt = 0
    const recordPath = join(diskFault.directory, 'request.json')
    const originalBytes = await readFile(recordPath)
    const inspected = await f.owner.inspect(f.inspect(input), agent, f.workspace)
    expect(inspected.result).toMatchObject({ durability: 'unconfirmed', original: input })
    await f.owner.mkdir(f.workspace, input, agent)
    expect(producer).toHaveBeenCalledTimes(failAt === 1 ? 0 : 1)
    expect(await readFile(recordPath)).toEqual(originalBytes)
    facts.push({ scenario: 'record-ack-failure', failAt, producerCalls: producer.mock.calls.length, filesystem: result.result.filesystem, originalRequestRetained: true })
  }
})

it('Workspace marker bytes cannot forge the original producer identity or authorize replay', async () => {
  const f = await fixture({ pathMutationFault: 'after-stage-crash' }), input = await f.request('target', 'trusted-producer-original')
  const producer = vi.spyOn(f.ordinary, 'mkdirPath')
  expect((await f.owner.mkdir(f.workspace, input, agent)).result.filesystem).toBe('unknown')
  const record = JSON.parse(await readFile(operationRecord(f.original.root, input.operationId), 'utf8'))
  expect(record.producer.entry).toMatchObject({ device: expect.any(String), inode: expect.any(String), birthtimeNs: expect.any(String) })
  await mkdir(join(f.root, 'target'))
  const replacement = await f.owner.stat(f.workspace, 'target')
  // These are deliberately untrusted Workspace files, not the Host's original record.
  await writeFile(join(f.root, record.stage, 'request'), record.digest)
  await writeFile(join(f.root, record.stage, 'identity'), JSON.stringify(replacement.entry))
  await writeFile(join(f.root, record.stage, 'entry', 'keep source.txt'), 'keep original staged directory data')
  expect((await f.owner.inspect(f.inspect(input), agent, f.workspace)).result.filesystem).toBe('unknown')
  expect((await f.owner.mkdir(f.workspace, input, agent)).result.filesystem).toBe('unknown')
  expect(producer).toHaveBeenCalledTimes(1)
  expect(await readFile(join(f.root, record.stage, 'entry', 'keep source.txt'), 'utf8')).toBe('keep original staged directory data')
  expect((await readdir(join(f.root, 'target')))).toEqual([])
})


async function privateOwnerProcess(f: Awaited<ReturnType<typeof fixture>>, input: FileMkdirParams) {
  const inputPath = join(f.original.root, 'request.json'), bundle = join(f.original.root, 'owner-process.mjs')
  await writeFile(inputPath, JSON.stringify(input))
  await symlink(resolve('apps/host/node_modules'), join(f.original.root, 'node_modules'), 'dir')
  await build({ stdin: { resolveDir: process.cwd(), contents: `
    import {readFile,appendFile,mkdir} from 'node:fs/promises'; import {join} from 'node:path';
    import {AgentMuxNotebookStore} from '@agentmux/core/notebook-store';
    import {FilePathMutations} from './apps/host/src/file-path-mutations.ts';
    import {OrdinaryWorkspaceFiles} from './apps/host/src/ordinary-files.ts';
    const [home,helper,mode]=process.argv.slice(2),input=JSON.parse(await readFile(join(home,'request.json'),'utf8'));
    const actor={actor:{kind:'agent',id:'original-files-agent'},callerHostId:'local'};
    const workspace={id:input.expectedResource.workspaceId,hostId:'local',path:input.expectedResource.workspacePath};
    await mkdir(join(home,'private-notes'),{recursive:true});
    const notes=new AgentMuxNotebookStore(join(home,'private-notes/notebook.root.json'));
    const files=new OrdinaryWorkspaceFiles({helperPath:helper,...(mode==='create'?{pathMutationFault:'after-publish-crash'}:{})});
    const native=files.mkdirPath.bind(files);files.mkdirPath=async(...args)=>{await appendFile(join(home,'native-calls.txt'),'producer\\n');return native(...args)};
    const owner=new FilePathMutations({directory:join(home,'file-path-mutations'),files,noteLease:work=>notes.runWithWriteLease(work)});
    const query={operationId:input.operationId,zoneId:input.zoneId,path:input.path,expectedResource:input.expectedResource};
    const result=mode==='create'||mode==='success'?await owner.mkdir(workspace,input,actor):await owner.inspect(query,actor,workspace);
    const repeated=mode==='reopen'||mode==='missing'?await owner.mkdir(workspace,input,actor):null;
    const fresh=mode==='missing'?await owner.mkdir(workspace,{...input,operationId:input.operationId+'-fresh'},actor):null;
    process.stdout.write(JSON.stringify({result,repeated,fresh,calls:await readFile(join(home,'native-calls.txt'),'utf8')}));
  ` }, outfile: bundle, bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node24' })
  return async (mode: string) => JSON.parse((await promisify(execFile)(process.execPath, [bundle, f.original.root, helper, mode], { env: objectCliEnvironment(f.original.root) })).stdout)
}

it('the real original owner reopens its retained operation in another process without a second native producer or losing later file data', async () => {
  const f = await fixture(), input = await f.request('process-original', 'process-original-op')
  const run = await privateOwnerProcess(f, input), counter = join(f.original.root, 'native-calls.txt')
  const first = await run('create'); expect(first.result.result.filesystem).toBe('unknown')
  const recordPath = operationRecord(f.original.root, input.operationId)
  const originalBytes = await readFile(recordPath), record = JSON.parse(originalBytes.toString('utf8'))
  await writeFile(join(f.root, 'process-original', 'keep newer file.txt'), 'keep later file data')
  const reopened = await run('reopen')
  expect(reopened.result.result).toMatchObject({ filesystem: 'created', durability: 'unconfirmed', original: input,
    createdWitness: { device: record.producer.entry.device, inode: record.producer.entry.inode, birthtimeNs: record.producer.entry.birthtimeNs } })
  expect(reopened.repeated.result.filesystem).toBe('created')
  expect(await readFile(counter, 'utf8')).toBe(first.calls)
  expect(await readFile(recordPath)).toEqual(originalBytes)
  expect(await readFile(join(f.root, 'process-original', 'keep newer file.txt'), 'utf8')).toBe('keep later file data')
  facts.push({ scenario: 'private-original-owner-process-reopen', operationId: input.operationId, actor: record.actor, callerHostId: record.callerHostId,
    originalEntry: record.producer.entry, recordBytesUnchanged: true, secondProcessDidNotRedispatch: true, laterFileDataPreserved: true })
})

it('actual Host directory mutations borrow the original Note lease while ordinary path reads remain available', async () => {
  const f = await hostFixture(), notes = new core.AgentMuxNotebookStore()
  let release!: () => void, entered!: () => void
  const held = new Promise<void>(done => { release = done }), ready = new Promise<void>(done => { entered = done })
  const holding = notes.runWithWriteLease(async () => { entered(); await held })
  await ready
  const read = { zoneId: 'original-files-zone', path: 'leased-directory', expectedResource: { hostId: 'local', workspaceId: f.workspace.id, workspacePath: f.root } }
  const observed = await f.cli(['stat'], read); expect(observed.code, observed.stderr).toBe(0)
  const input: FileMkdirParams = { ...read, expectedResource: observed.body.result.resource, operationId: 'original-note-lease', expectedAbsent: true,
    expected: { root: observed.body.result.result.observation.root, parent: observed.body.result.result.observation.parent } }
  let settled = false
  const creating = f.cli(['mkdir'], input).then(value => { settled = true; return value })
  try {
    await vi.waitFor(async () => expect((await readdir(join(f.original.root, 'file-path-mutations'))).length).toBeGreaterThan(0))
    expect(settled).toBe(false)
    await expect(stat(join(f.root, 'leased-directory'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await f.cli(['stat'], read)).body.result.result.status).toBe('observed')
    const ordinaryRead = { ...read, path: 'ordinary.txt' }, ordinary = await f.cli(['stat'], ordinaryRead)
    const written = await f.cli(['create'], { ...ordinaryRead, expectedResource: ordinary.body.result.resource, expectedRevision: null, content: 'ordinary write stays available' })
    expect(written.code, written.stderr).toBe(0); expect(written.body.result.result.status).toBe('written')
    expect(await readFile(join(f.root, 'ordinary.txt'), 'utf8')).toBe('ordinary write stays available')
  } finally { release(); await holding }
  const created = await creating
  expect(created.code, created.stderr).toBe(0); expect(created.body.result.result.filesystem).toBe('created')
})


it('a retained mutation inspects its original physical namespace after a Workspace alias changes', async () => {
  const f = await fixture({ pathMutationFault: 'after-publish-crash' }), alias = join(f.original.root, 'workspace-alias')
  await symlink(f.root, alias, 'dir')
  const workspace = { ...f.workspace, path: alias }, observed = await f.owner.stat(workspace, 'original')
  const input: FileMkdirParams = { operationId: 'original-alias-op', zoneId: 'original-files-zone', path: 'original', expectedAbsent: true,
    expectedResource: { ...f.descriptor('original'), workspacePath: alias, zonePath: alias }, expected: { root: observed.root, parent: observed.parent } }
  const producer = vi.spyOn(f.ordinary, 'mkdirPath')
  expect((await f.owner.mkdir(workspace, input, agent)).result.filesystem).toBe('unknown')
  const replacement = join(f.original.root, 'replacement-root'); await mkdir(replacement)
  await rename(alias, alias + '.old'); await symlink(replacement, alias, 'dir')
  const found = await f.owner.inspect(f.inspect(input), agent, workspace)
  expect(found.result.filesystem).toBe('created')
  expect((await f.owner.mkdir(workspace, input, agent)).result.filesystem).toBe('created')
  expect(producer).toHaveBeenCalledTimes(1)
  expect((await readdir(replacement))).toEqual([])
  expect((await stat(join(f.root, 'original'))).isDirectory()).toBe(true)
})


it('native no-replace preserves a later empty directory identity', async () => {
  let before: Awaited<ReturnType<typeof stat>> | undefined
  const f = await fixture({ beforePathPublish: async () => {
    await mkdir(join(f.root, 'target')); before = await stat(join(f.root, 'target'))
  } }), input = await f.request('target', 'later-empty-directory')
  expect((await f.owner.mkdir(f.workspace, input, agent)).result).toMatchObject({ filesystem: 'not-applied', code: 'FILE_PATH_OCCUPIED' })
  const after = await stat(join(f.root, 'target'))
  expect(after.ino).toBe(before!.ino); expect(after.birthtimeMs).toBe(before!.birthtimeMs)
})


it('the final native publication uses the original pinned parent and stage after a last-instruction namespace replacement', async () => {
  let fakeStage = ''
  const f = await fixture({ beforePathRename: async () => {
    const parent = join(f.root, 'parent'), old = join(f.root, 'original-parent')
    await rename(parent, old); await mkdir(parent)
    fakeStage = (await readdir(old)).find(name => name.startsWith('.agentmux-mkdir-'))!
    expect(fakeStage).toBeTruthy()
    await mkdir(join(parent, fakeStage, 'entry'), { recursive: true })
    await writeFile(join(parent, fakeStage, 'entry', 'keep replacement.txt'), 'unapproved replacement producer')
  } })
  await mkdir(join(f.root, 'parent'))
  const input = await f.request('parent/target', 'last-instruction-parent')
  const result = await f.owner.mkdir(f.workspace, input, agent)
  expect(result.result.filesystem).toBe('unknown')
  const record = JSON.parse(await readFile(operationRecord(f.original.root, input.operationId), 'utf8'))
  await expect(stat(join(f.root, 'parent', 'target'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(join(f.root, 'parent', fakeStage, 'entry', 'keep replacement.txt'), 'utf8')).toBe('unapproved replacement producer')
  const original = await stat(join(f.root, 'original-parent', 'target'), { bigint: true })
  expect(original.ino.toString()).toBe(record.producer.entry.inode)
  expect(original.dev.toString()).toBe(record.producer.entry.device)
  expect((await f.owner.inspect(f.inspect(input), agent, f.workspace)).result.filesystem).toBe('unknown')
  facts.push({ scenario: 'final-publish-pinned-fds', operationId: input.operationId, originalMovedParent: true, replacementStageUntouched: true, replacementTargetAbsent: true, filesystem: 'unknown' })
})

it('compiled CLI and a reopened owner preserve physical newline and backslash paths and multiline diagnostics', async () => {
  const f = await hostFixture('physical\nroot\\part')
  const physicalParent = 'physical\nparent\\part'
  await mkdir(join(f.root, physicalParent)); await symlink(physicalParent, join(f.root, 'alias'), 'dir')
  const read = { zoneId: 'original-files-zone', path: 'alias/child', expectedResource: { hostId: 'local', workspaceId: f.workspace.id, workspacePath: f.root } }
  const observed = await f.cli(['stat'], read)
  expect(observed.code, observed.stderr).toBe(0)
  expect(observed.body.result.resource.workspacePath).toBe(f.root)
  expect(observed.body.result.result.observation.parentPath).toBe(physicalParent)
  const input: FileMkdirParams = { ...read, operationId: 'physical-data-original', expectedResource: observed.body.result.resource, expectedAbsent: true,
    expected: { root: observed.body.result.result.observation.root, parent: observed.body.result.result.observation.parent } }
  const created = await f.cli(['mkdir'], input)
  expect(created.code, created.stderr).toBe(0); expect(created.body.result.result.filesystem).toBe('created')
  const recordPath = operationRecord(f.original.root, input.operationId), bytes = await readFile(recordPath), record = JSON.parse(bytes.toString('utf8'))
  expect(record.producer.location).toEqual({ root: await realpath(f.root), path: physicalParent + '/child' })
  const inspected = await f.cli(['mutation', 'inspect'], f.inspect(input))
  expect(inspected.code, inspected.stderr).toBe(0); expect(inspected.body.result.result.original).toEqual(input)
  const run = await privateOwnerProcess(f, input)
  // Reopening reads the original settled record; it does not call the native producer.
  await writeFile(join(f.original.root, 'native-calls.txt'), '')
  const reopened = await run('reopen')
  expect(reopened.result.result.original).toEqual(input); expect(reopened.calls).toBe('')
  expect(await readFile(recordPath)).toEqual(bytes)
  const files = await import('@agentmux/core/files')
  const diagnostic = { resource: observed.body.result.resource, result: { status: 'unknown', code: 'EIO', message: 'Original first line\n' + '原诊断😀'.repeat(20000) } }
  expect(files.parseFileStatResult(diagnostic, read)).toEqual(diagnostic)
  expect(files.parseFilePathMutationReceipt({ action: 'mkdir', phase: 'prepared', filesystem: 'unknown', durability: 'unconfirmed', code: 'EIO', message: diagnostic.result.message }).message).toBe(diagnostic.result.message)
  expect(() => files.parseFileStatResult({ ...diagnostic, result: { ...diagnostic.result, code: 'bad\ncode' } }, read)).toThrow()
  expect(() => files.parseFileStatResult({ ...observed.body.result, result: { ...observed.body.result.result, observation: { ...observed.body.result.result.observation, parentPath: 'bad\0path' } } }, read)).toThrow()
  facts.push({ scenario: 'physical-path-data-cli-reopen', operationId: input.operationId, resource: input.expectedResource, producerLocation: record.producer.location, multilineDiagnosticPreserved: true, noReopenRedispatch: true })
})

it('a durable admission with a missing or corrupt request member never authorizes a second producer after process reopen', async () => {
  for (const corruption of ['missing', 'corrupt']) {
    const f = await fixture(), input = await f.request('original', 'admission-' + corruption), run = await privateOwnerProcess(f, input)
    const first = await run('success')
    expect(first.result.result).toMatchObject({ filesystem: 'created', durability: 'confirmed' })
    const recordPath = operationRecord(f.original.root, input.operationId)
    expect((await readdir(f.root))).toEqual(['original']) // Original private stage has been retired.
    await rename(join(f.root, 'original'), join(f.root, 'original-kept'))
    await writeFile(join(f.root, 'original-kept', 'keep later.txt'), 'later data')
    if (corruption === 'missing') await unlink(recordPath)
    else await writeFile(recordPath, '{original corrupt bytes')
    const reopened = await run('missing')
    expect(reopened.result.result).toMatchObject({ phase: 'unavailable', filesystem: 'unknown', code: 'FILE_MUTATION_RECORD_UNAVAILABLE' })
    expect(reopened.repeated.result).toMatchObject({ filesystem: 'unknown', code: 'FILE_MUTATION_RECORD_UNAVAILABLE' })
    expect(reopened.fresh.result).toMatchObject({ filesystem: 'created', durability: 'confirmed' })
    expect(reopened.calls).toBe(first.calls + 'producer\n') // Only the independent explicitly new operation dispatched.
    expect(await readFile(join(f.root, 'original-kept', 'keep later.txt'), 'utf8')).toBe('later data')
    if (corruption === 'missing') await expect(stat(recordPath)).rejects.toMatchObject({ code: 'ENOENT' })
    else expect(await readFile(recordPath, 'utf8')).toBe('{original corrupt bytes')
    expect((await stat(operationDirectory(f.original.root, input.operationId))).isDirectory()).toBe(true)
    facts.push({ scenario: 'admission-member-' + corruption + '-private-reopen', operationId: input.operationId, originalProducerCount: 1, replayProducerCount: 0, independentProducerCount: 1, originalDataKept: true })
  }
})
