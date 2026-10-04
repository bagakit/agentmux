import { appendFile, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import ts from 'typescript'
import { createRequire } from 'node:module'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { objectCliEnvironment } from '../../../packages/core/test/helpers/object-cli-rpc'
import { afterEach, expect, it, vi } from 'vitest'
import { ScratchTopics } from '../src/main/scratch-topics'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { scratchDirectoryIdentity, scratchIdentityContext } from '../src/main/scratch-topic-directories'
import { directoryIdentityRecord, normalizeDirectoryIdentity, moteDirectoryName, SCRATCH_DIRECTORY_IDENTITY_PATH, SCRATCH_DIRECTORY_IDENTITY_PENDING_PATH } from '../src/main/scratch-directory-identity.mjs'
import { observeClientRpcSnapshot } from '../src/main/rpc-client-observations'
import { originalTopicAddress, directoryIdentity, homeZoneId, spatialSources } from '../src/shared/space-addresses'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, scratchTopicDirectoryName } from '../src/shared/scratch-topics'
import type { AppConfig, WorkspaceRecord } from '../src/shared/contracts'
import { controlledNativeImage, imageInput, imagePng } from './fixtures/mote-identity-image'
import { migrateTopicDirectories } from '../scripts/migrate-topic-directories.mjs'
import { parseRpcNativeResult } from '../../../packages/core/src/rpc-native-codec'

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture(id = 'view:original') {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'mote-identity-'))); roots.push(home)
  const path = join(home, '.agentmux/scratch'); await mkdir(path, { recursive: true })
  const workspace: WorkspaceRecord = { id: SCRATCH_WORKSPACE_ID, name: 'Topics', kind: 'folder', hostId: 'local', path }
  const topics = new ScratchTopics(controlledNativeImage), ordinary = await topics.ensure(workspace, id, undefined, false)
  const oldDirectory = join(home, '.agentmux/motes', scratchTopicDirectoryName(id)); await mkdir(join(home, '.agentmux/motes'), { recursive: true })
  await rename(ordinary.physicalDirectoryPath!, oldDirectory); await writeFile(join(oldDirectory, 'SOUL.md'), '# Existing Mote\n')
  const mote = (await topics.read(workspace, id))!
  const directory = mote.physicalDirectoryPath!, original = join(path, mote.directoryPath)
  const record = join(directory, SCRATCH_DIRECTORY_IDENTITY_PATH), config = { workspaces: [workspace] } as AppConfig
  return { home, workspace, topics, mote, directory, original, record, config }
}
async function v1(h: Awaited<ReturnType<typeof fixture>>) { await writeFile(h.record, JSON.stringify({ version: 1, identityDirectoryPath: h.original }) + '\n') }
async function helper(h: Awaited<ReturnType<typeof fixture>>) {
  const path = join(h.home, 'workspace-move')
  execFileSync('xcrun', ['clang', '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', resolve(import.meta.dirname, '../native/workspace-move.c'), '-o', path])
  return path
}

it('new actual migrations save only relative full-ID v3 metadata while keeping the original content, inode, avatar and archive keys', async () => {
  const h = await fixture(), helperPath = await helper(h)
  await rename(h.directory, h.original)
  const key = directoryIdentity('local', h.original), before = await h.topics.read(h.workspace, h.mote.id)
  expect(before?.identityDirectoryPath).toBe(h.original)
  const avatar = await h.topics.saveAvatar(h.workspace, h.mote.id, imageInput(), key)
  const archive = await h.topics.setMoteArchived(h.workspace, h.mote.id, true, key, 'unwritten')
  const content = await readFile(join(h.original, 'SOUL.md')), inode = (await stat(h.original)).ino
  const result = await migrateTopicDirectories({ home: h.home, execute: true, helperPath })
  expect(result.success).toBe(true)
  const bytes = await readFile(h.record, 'utf8')
  expect(JSON.parse(bytes)).toEqual(directoryIdentityRecord({ topicId: h.mote.id, roots: { scratch: [h.workspace.path], topics: [join(h.home, '.agentmux/topics')], motes: [join(h.home, '.agentmux/motes')] }, original: h.original }))
  expect(bytes).not.toContain(h.home)
  expect(JSON.parse(bytes).identityDirectoryName).toBe(h.mote.directoryPath)
  const after = await h.topics.read(h.workspace, h.mote.id)
  expect(after).toMatchObject({ identityDirectoryPath: h.original, physicalDirectoryPath: join(h.home, '.agentmux/motes', moteDirectoryName(h.mote.id)), moteArchive: archive })
  expect(after?.readError).toBeUndefined()
  expect((await stat(h.directory)).ino).toBe(inode)
  expect(await readFile(join(h.directory, 'SOUL.md'))).toEqual(content)
  expect(await h.topics.readAvatar(h.workspace, h.mote.id, avatar, key)).toMatchObject({ width: 256, height: 256 })
}, 20_000)

it.each([false, true])('repairs canonical old records with deleted or retained legacy alias, stays readonly in preview and idempotent; alias=%s', async alias => {
  const h = await fixture(), helperPath = await helper(h); await v1(h)
  if (alias) await symlink('../motes/' + h.mote.directoryPath, h.original)
  const before = await readFile(h.record), soul = await readFile(join(h.directory, 'SOUL.md')), inode = (await stat(h.directory)).ino
  const dry = await migrateTopicDirectories({ home: h.home })
  expect(dry.success).toBe(true); expect(await readFile(h.record)).toEqual(before)
  const first = await migrateTopicDirectories({ home: h.home, execute: true, helperPath })
  expect(first.success).toBe(true)
  const upgraded = await readFile(h.record), updated = await stat(h.record)
  expect(JSON.parse(upgraded.toString())).toEqual(directoryIdentityRecord({ topicId: h.mote.id, roots: { scratch: [h.workspace.path], topics: [join(h.home, '.agentmux/topics')], motes: [join(h.home, '.agentmux/motes')] }, original: h.original }))
  const second = await migrateTopicDirectories({ home: h.home, execute: true, helperPath })
  expect(second.success).toBe(true); expect(await readFile(h.record)).toEqual(upgraded)
  expect((await stat(h.record)).ino).toBe(updated.ino); expect((await stat(h.record)).mtimeMs).toBe(updated.mtimeMs)
  expect((await stat(h.directory)).ino).toBe(inode); expect(await readFile(join(h.directory, 'SOUL.md'))).toEqual(soul)
  expect((await new ScratchTopics().read(h.workspace, h.mote.id))?.identityDirectoryPath).toBe(h.original)
})

it('cold write-before ENOSPC retains exact old identity and real SOUL Mote classification through original readonly public consumption', async () => {
  const h = await fixture(); await v1(h)
  const key = directoryIdentity('local', h.original), old = await readFile(h.record), soul = await readFile(join(h.directory, 'SOUL.md'))
  const cold = new ScratchTopics(controlledNativeImage)
  await expect(cold.normalizeDirectoryIdentities(h.workspace, { beforeWrite: () => { throw Object.assign(new Error('Private fixture disk capacity failure'), { code: 'ENOSPC' }) } }))
    .rejects.toThrow('ENOSPC')
  await expect(scratchDirectoryIdentity(h.workspace.path, h.mote.id, h.directory)).rejects.toMatchObject({ code: 'DIRECTORY_IDENTITY_UPGRADE_REQUIRED' })
  const snapshot = (await cold.list(h.workspace))[0]!
  expect(snapshot).toMatchObject({ id: h.mote.id, identityDirectoryPath: h.original, physicalDirectoryPath: h.directory, soul: { content: soul.toString() } })
  expect(snapshot.readError).toContain('upgrade is unconfirmed')
  expect(originalTopicAddress(h.workspace, snapshot, {})).toEqual({ spaceId: key, zoneId: homeZoneId(key) })
  const avatar = await cold.saveAvatar(h.workspace, h.mote.id, imageInput(imagePng()), key)
  expect(await cold.readAvatar(h.workspace, h.mote.id, avatar, key)).toMatchObject({ width: 256, height: 256 })
  const files = new WorkspaceFiles(() => ({ id: 'local', kind: 'local' }) as never)
  expect(await files.read(h.workspace, h.mote.directoryPath + '/SOUL.md')).toMatchObject({ status: 'read', document: { content: soul.toString() } })
  const observe = vi.spyOn(cold, 'normalizeDirectoryIdentities'), ensure = vi.spyOn(cold, 'ensureMote')
  const projected = await observeClientRpcSnapshot(h.config, cold, { include: ['motes'], topicId: h.mote.id })
  expect(projected.motes).toHaveLength(1)
  expect(projected.motes![0]).toMatchObject({ kind: 'mote', spaceId: key, path: h.directory, readError: snapshot.readError })
  expect(projected.unavailable?.length).toBeGreaterThan(0)
  expect(projected.motes![0]).not.toHaveProperty('identityPathHash')
  expect(projected.motes![0]).not.toHaveProperty('identityDirectoryPath')
  const publicReceipt = { projects: [], workspaces: [], topics: [], motes: [], spaces: [], zones: [], executors: [], agents: [], sessions: [], goals: [], decisions: [], activity: [], unavailable: [], ...projected }
  expect(parseRpcNativeResult('app.snapshot', publicReceipt, {})).toEqual(publicReceipt)
  expect(observe).not.toHaveBeenCalled(); expect(ensure).not.toHaveBeenCalled()
  expect(await readFile(h.record)).toEqual(old); expect(await readFile(join(h.directory, 'SOUL.md'))).toEqual(soul)
  await cold.normalizeDirectoryIdentities(h.workspace)
  expect((await cold.read(h.workspace, h.mote.id))?.readError).toBeUndefined()
})

it.each(['wrong-root', 'wrong-name', 'wrong-hash', 'extra-field', 'absolute-name', 'oversized'])('invalid %s retains real Mote content but cannot mint a physical identity or accept an avatar action', async shape => {
  const h = await fixture()
  const value: Record<string, unknown> = directoryIdentityRecord({ topicId: h.mote.id, roots: { scratch: [h.workspace.path], topics: [join(h.home, '.agentmux/topics')], motes: [join(h.home, '.agentmux/motes')] }, original: h.original })
  if (shape === 'wrong-root') Object.assign(value, directoryIdentityRecord(join(h.home, 'other', h.mote.directoryPath)))
  if (shape === 'wrong-name') value.identityDirectoryName = scratchTopicDirectoryName('view:other')
  if (shape === 'wrong-hash') value.identityPathHash = '0'.repeat(64)
  if (shape === 'extra-field') value.unexpected = true
  if (shape === 'absolute-name') value.identityDirectoryName = h.original
  let bytes = JSON.stringify(value)
  if (shape === 'oversized') bytes += ' '.repeat(4097)
  await writeFile(h.record, bytes)
  const old = await readFile(h.record), snapshot = (await h.topics.read(h.workspace, h.mote.id))!
  expect(snapshot.soul?.content.length).toBeGreaterThan(0); expect(snapshot.readError).toBeTruthy()
  expect(snapshot.identityDirectoryPath).toBeUndefined(); expect(snapshot.physicalDirectoryPath).toBe(h.directory)
  expect(originalTopicAddress(h.workspace, snapshot, {})).toBeNull()
  const originalKey = directoryIdentity('local', h.original), zoneId = homeZoneId(originalKey)
  const binding = { [zoneId]: { spaceId: originalKey, workspaceId: h.workspace.id, topicId: h.mote.id, contentKind: 'mote' as const } }
  expect(originalTopicAddress(h.workspace, snapshot, binding)).toEqual({ spaceId: originalKey, zoneId })
  expect(spatialSources(h.config, [snapshot]).spaces.some(space => space.spaceId === directoryIdentity('local', h.directory))).toBe(false)
  const publicFacts = await observeClientRpcSnapshot(h.config, h.topics, { include: ['motes'] })
  expect(publicFacts.motes).toHaveLength(1); expect(publicFacts.motes![0]).toMatchObject({ kind: 'mote', spaceId: null, path: h.directory })
  await expect(h.topics.saveAvatar(h.workspace, h.mote.id, imageInput(), originalKey)).rejects.toBeTruthy()
  await expect(normalizeDirectoryIdentity(h.directory, await scratchIdentityContext(h.workspace.path, h.mote.id))).rejects.toBeTruthy()
  expect(await readFile(h.record)).toEqual(old)
})

it('metadata links never authorize rewriting external bytes', async () => {
  const h = await fixture(), outside = join(h.home, 'outside.json'), external = JSON.stringify(directoryIdentityRecord({ topicId: h.mote.id, roots: { scratch: [h.workspace.path], topics: [join(h.home, '.agentmux/topics')], motes: [join(h.home, '.agentmux/motes')] }, original: h.original }))
  await writeFile(outside, external); await symlink(outside, h.record)
  await expect(normalizeDirectoryIdentity(h.directory, await scratchIdentityContext(h.workspace.path, h.mote.id))).rejects.toBeTruthy()
  expect((await h.topics.read(h.workspace, h.mote.id))?.identityDirectoryPath).toBeUndefined()
  expect(await readFile(outside, 'utf8')).toBe(external)
})

it('record changes before replacement retain later bytes instead of overwriting a concurrent fact', async () => {
  const h = await fixture(); await v1(h)
  const newer = JSON.stringify(directoryIdentityRecord({ topicId: h.mote.id, roots: { scratch: [h.workspace.path], topics: [join(h.home, '.agentmux/topics')], motes: [join(h.home, '.agentmux/motes')] }, original: h.original }))
  await expect(normalizeDirectoryIdentity(h.directory, await scratchIdentityContext(h.workspace.path, h.mote.id), { beforeReplace: async () => { await writeFile(h.record, newer) } })).rejects.toThrow('changed before saving')
  expect(await readFile(h.record, 'utf8')).toBe(newer)
})

it('lost flush confirmation keeps exact identity and content; the next explicit repair confirms the same full-ID v3 bytes', async () => {
  const h = await fixture(); await v1(h)
  const originalBytes = await readFile(h.record, 'utf8'), soul = await readFile(join(h.directory, 'SOUL.md'))
  await expect(normalizeDirectoryIdentity(h.directory, await scratchIdentityContext(h.workspace.path, h.mote.id), { afterReplace: () => { throw Object.assign(new Error('Private fixture parent flush failure'), { code: 'EIO' }) } }))
    .rejects.toMatchObject({ code: 'DIRECTORY_IDENTITY_WRITE_UNKNOWN', replacementApplied: true, originalBytes })
  await expect(scratchDirectoryIdentity(h.workspace.path, h.mote.id, h.directory)).rejects.toMatchObject({ code: 'DIRECTORY_IDENTITY_UPGRADE_REQUIRED' })
  const cold = new ScratchTopics(controlledNativeImage), snapshot = await cold.read(h.workspace, h.mote.id)
  expect(snapshot?.identityDirectoryPath).toBe(h.original); expect(snapshot?.readError).toContain('upgrade is unconfirmed')
  const facts = await observeClientRpcSnapshot(h.config, cold, { include: ['motes'] })
  expect(facts.motes![0]?.readError).toBeTruthy(); expect(facts.motes![0]?.spaceId).toBe(directoryIdentity('local', h.original))
  expect(await readFile(join(h.directory, SCRATCH_DIRECTORY_IDENTITY_PENDING_PATH), 'utf8')).toBe(originalBytes)
  const retained = await readFile(h.record)
  expect(await normalizeDirectoryIdentity(h.directory, await scratchIdentityContext(h.workspace.path, h.mote.id))).toEqual({ state: 'upgraded' })
  expect((await cold.read(h.workspace, h.mote.id))?.readError).toBeUndefined()
  expect(await readFile(h.record)).toEqual(retained); expect(await readFile(join(h.directory, 'SOUL.md'))).toEqual(soul)
})

it('canonical primary/custom creations without a legacy marker retain their physical identities', async () => {
  const h = await fixture(PMO_TEAMS_TOPIC_ID), custom = await h.topics.ensureMote(h.workspace, 'view:new-custom')
  await h.topics.normalizeDirectoryIdentities(h.workspace)
  for (const mote of [h.mote, custom]) {
    expect((await h.topics.read(h.workspace, mote.id))?.identityDirectoryPath).toBe(mote.physicalDirectoryPath)
    expect(JSON.parse(await readFile(join(mote.physicalDirectoryPath!, SCRATCH_DIRECTORY_IDENTITY_PATH), 'utf8'))).toMatchObject({ version: 3, topicId: mote.id })
  }
})


it('actual public service and fresh Source CLI preserve a cold Mote recovery warning, then observe explicit repair without writing during snapshot', async () => {
  const h = await fixture(); await v1(h)
  const cold = new ScratchTopics(), normalize = vi.spyOn(cold, 'normalizeDirectoryIdentities')
  const cli = join(h.home, 'agentmux.mjs')
  const require = createRequire(resolve(import.meta.dirname, '../../../packages/core/package.json'))
  const { build } = await import(/* @vite-ignore */ require.resolve('esbuild'))
  await symlink(resolve(import.meta.dirname, '../../../packages/core/node_modules'), join(h.home, 'node_modules'))
  const built = await build({ metafile: true, entryPoints: [resolve(import.meta.dirname, '../../../packages/core/src/agentmux.ts')], outfile: cli,
    bundle: true, packages: 'external', platform: 'node', format: 'esm', logLevel: 'silent',
    alias: { '@agentmux/demand/goals': resolve(import.meta.dirname, '../../../packages/demand/src/goals.ts'), '@agentmux/demand': resolve(import.meta.dirname, '../../../packages/demand/src/index.ts') } })
  if (process.env.AGENTMUX_DIRECTORY_IDENTITY_PROOF) {
    const repository = resolve(import.meta.dirname, '../../..')
    const { createHash } = await import('node:crypto')
    const inputs = await Promise.all(Object.keys(built.metafile.inputs).filter(file => !file.includes('node_modules/')).map(async file => {
      const absolute = resolve(file), path = relative(repository, absolute)
      return { consumer: 'actual-source-cli-bundle', file: path, sha256: createHash('sha256').update(await readFile(absolute)).digest('hex') }
    }))
    await appendFile(process.env.AGENTMUX_DIRECTORY_IDENTITY_PROOF, inputs.map(row => JSON.stringify(row)).join('\n') + '\n')
  }
  const server = new AgentMuxControlServer({ socketPath: join(h.home, 'control.sock'), coreClients: () => [],
    snapshot: params => observeClientRpcSnapshot(h.config, cold, params) })
  await server.start()
  const run = async () => await new Promise<{ code: number | null; stdout: string; stderr: string }>((accept, reject) => {
    const child = spawn(process.execPath, [cli, 'app', 'snapshot', '--include', 'motes'], { env: objectCliEnvironment(h.home) })
    let stdout = '', stderr = ''
    child.stdout.on('data', value => { stdout += value }); child.stderr.on('data', value => { stderr += value })
    child.once('error', reject); child.once('close', code => accept({ code, stdout, stderr }))
  })
  try {
    const before = await readFile(h.record), first = await run()
    expect(first.code, first.stderr).toBe(0)
    const facts = JSON.parse(first.stdout)
    expect(facts.operation).toBe('app.snapshot')
    expect(facts.result.motes).toHaveLength(1)
    expect(facts.result.motes[0]).toMatchObject({ kind: 'mote', spaceId: directoryIdentity('local', h.original), path: h.directory })
    expect(facts.result.motes[0].readError).toContain('upgrade is unconfirmed')
    expect(facts.result.unavailable.length).toBeGreaterThan(0)
    expect(normalize).not.toHaveBeenCalled(); expect(await readFile(h.record)).toEqual(before)
    await cold.normalizeDirectoryIdentities(h.workspace)
    const fresh = await run(); expect(fresh.code, fresh.stderr).toBe(0)
    const repaired = JSON.parse(fresh.stdout)
    expect(repaired.result.motes[0].spaceId).toBe(facts.result.motes[0].spaceId)
    expect(repaired.result.motes[0].readError).toBeUndefined(); expect(repaired.result.unavailable).toEqual([])
  } finally { await server.stop() }
}, 20_000)

it('executes the original IPC startup statements: committed Runtime/input is never held by pending or failed metadata maintenance', async () => {
  const source = await readFile(resolve(import.meta.dirname, '../src/main/ipc.ts'), 'utf8')
  if (process.env.AGENTMUX_DIRECTORY_IDENTITY_PROOF) {
    const { createHash } = await import('node:crypto')
    await appendFile(process.env.AGENTMUX_DIRECTORY_IDENTITY_PROOF, JSON.stringify({ consumer: 'actual-startup-statements', file: 'apps/desktop/src/main/ipc.ts', sha256: createHash('sha256').update(source).digest('hex') }) + '\n')
  }
  const file = ts.createSourceFile('ipc.ts', source, ts.ScriptTarget.Latest, true)
  const register = file.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === 'registerIpc') as ts.FunctionDeclaration
  expect(register?.body).toBeTruthy()
  const statements = [...register.body!.statements]
  const start = statements.findIndex(statement => statement.getText(file).startsWith('args.runtime.commit(initialRuntime)'))
  const end = statements.findIndex((statement, index) => index > start && statement.getText(file).startsWith('if (initialBindingError)'))
  expect(start).toBeGreaterThan(-1); expect(end).toBeGreaterThan(start)
  const originalStatements = statements.slice(start, end).map(statement => statement.getText(file)).join('\n')
  const compiled = ts.transpileModule(originalStatements, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  const execute = new AsyncFunction('args', 'config', 'initialRuntime', 'SCRATCH_WORKSPACE_ID', 'process', compiled)
  const events: string[] = [], warnings: string[] = []
  let rejectWrite!: (error: Error) => void
  const pending = new Promise<void>((_, reject) => { rejectWrite = reject })
  const args = { runtime: { commit: () => events.push('input-ready') }, scratchTopics: { normalizeDirectoryIdentities: (_workspace: unknown, options: unknown) => {
    expect(options).toEqual({ shortenMotes: true })
    events.push('metadata-write'); return pending
  } } }
  const config = { workspaces: [{ id: SCRATCH_WORKSPACE_ID }] }
  const startResult = execute(args, config, {}, SCRATCH_WORKSPACE_ID, { stderr: { write: (text: string) => warnings.push(text) } })
  const returned = await Promise.race([startResult.then(() => true, () => false), new Promise(accept => setTimeout(() => accept(false), 100))])
  expect(returned).toBe(true)
  expect(events).toEqual(['input-ready', 'metadata-write'])
  rejectWrite(Object.assign(new Error('Private fixture ENOSPC'), { code: 'ENOSPC' }))
  await new Promise(accept => setImmediate(accept))
  expect(events[0]).toBe('input-ready'); expect(warnings.join('')).toContain('ENOSPC')
})

it.each(['bytes', 'inode'])('real native last-check window retains a later %s record and refuses the stale publication', async shape => {
  const h = await fixture(); await v1(h)
  const newer = JSON.stringify(directoryIdentityRecord({ topicId: h.mote.id, roots: { scratch: [h.workspace.path], topics: [join(h.home, '.agentmux/topics')], motes: [join(h.home, '.agentmux/motes')] }, original: h.original })) + '\n\n'
  await expect(normalizeDirectoryIdentity(h.directory, await scratchIdentityContext(h.workspace.path, h.mote.id), { beforeCommit: async () => {
    if (shape === 'bytes') await writeFile(h.record, newer)
    else { const replacement = join(h.directory, '.agentmux/later.json'); await writeFile(replacement, newer); await rename(replacement, h.record) }
  } })).rejects.toThrow('claimed-conflict')
  expect(await readFile(h.record, 'utf8')).toBe(newer)
  await expect(readFile(join(h.directory, SCRATCH_DIRECTORY_IDENTITY_PENDING_PATH))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('a real native last-check metadata-parent replacement never redirects the write into the new directory', async () => {
  const h = await fixture(); await v1(h)
  const oldParent = join(h.directory, '.agentmux-retained'), original = await readFile(h.record), newer = 'new parent keeps its exact bytes\n'
  await expect(normalizeDirectoryIdentity(h.directory, await scratchIdentityContext(h.workspace.path, h.mote.id), { beforeCommit: async () => {
    await rename(join(h.directory, '.agentmux'), oldParent); await mkdir(join(h.directory, '.agentmux')); await writeFile(h.record, newer)
  } })).rejects.toThrow('parent-changed')
  expect(await readFile(h.record, 'utf8')).toBe(newer)
  expect(await readFile(join(oldParent, 'directory-identity.json'))).toEqual(original)
})

it('a real native last-check object replacement preserves the foreign object and keeps the original witness with the original object', async () => {
  const h = await fixture(); await v1(h)
  const retained = h.directory + '-retained', newer = 'foreign object keeps its exact bytes\n', soul = await readFile(join(h.directory, 'SOUL.md'))
  await expect(normalizeDirectoryIdentity(h.directory, await scratchIdentityContext(h.workspace.path, h.mote.id), { beforeCommit: async () => {
    await rename(h.directory, retained); await mkdir(join(h.directory, '.agentmux'), { recursive: true }); await writeFile(h.record, newer)
  } })).rejects.toThrow('visible-object-changed')
  expect(await readFile(h.record, 'utf8')).toBe(newer)
  expect(await readFile(join(retained, 'SOUL.md'))).toEqual(soul)
  expect(JSON.parse(await readFile(join(retained, SCRATCH_DIRECTORY_IDENTITY_PENDING_PATH), 'utf8')).identityDirectoryPath).toBe(h.original)
})

it('actual helper termination after claim retains a cold original identity and healthy files; explicit repair resumes without a physical identity guess', async () => {
  const h = await fixture(); await v1(h)
  const original = await readFile(h.record), soul = await readFile(join(h.directory, 'SOUL.md'))
  await expect(normalizeDirectoryIdentity(h.directory, await scratchIdentityContext(h.workspace.path, h.mote.id), { afterClaim: () => { throw new Error('Private fixture interrupts the claimed helper') } }))
    .rejects.toMatchObject({ code: 'DIRECTORY_IDENTITY_WRITE_UNKNOWN', helperSignal: 'SIGKILL' })
  await expect(readFile(h.record)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(join(h.directory, SCRATCH_DIRECTORY_IDENTITY_PENDING_PATH))).toEqual(original)
  const cold = new ScratchTopics(controlledNativeImage), snapshot = (await cold.read(h.workspace, h.mote.id))!
  expect(snapshot.identityDirectoryPath).toBe(h.original); expect(snapshot.readError).toContain('upgrade is unconfirmed')
  const facts = await observeClientRpcSnapshot(h.config, cold, { include: ['motes'] })
  expect(facts.motes![0]).toMatchObject({ kind: 'mote', spaceId: directoryIdentity('local', h.original), readError: snapshot.readError })
  expect(await readFile(join(h.directory, 'SOUL.md'))).toEqual(soul)
  await normalizeDirectoryIdentity(h.directory, await scratchIdentityContext(h.workspace.path, h.mote.id))
  expect((await cold.read(h.workspace, h.mote.id))?.readError).toBeUndefined()
  expect(JSON.parse(await readFile(h.record, 'utf8'))).toEqual(directoryIdentityRecord({ topicId: h.mote.id, roots: { scratch: [h.workspace.path], topics: [join(h.home, '.agentmux/topics')], motes: [join(h.home, '.agentmux/motes')] }, original: h.original }))
})

it('no-replace publication keeps both a competing current record and the original pending witness', async () => {
  const h = await fixture(); await v1(h)
  const original = await readFile(h.record), newer = 'competing current bytes\n'
  await expect(normalizeDirectoryIdentity(h.directory, await scratchIdentityContext(h.workspace.path, h.mote.id), { afterClaim: async () => { await writeFile(h.record, newer) } }))
    .rejects.toMatchObject({ code: 'DIRECTORY_IDENTITY_WRITE_UNKNOWN' })
  expect(await readFile(h.record, 'utf8')).toBe(newer)
  expect(await readFile(join(h.directory, SCRATCH_DIRECTORY_IDENTITY_PENDING_PATH))).toEqual(original)
  const snapshot = (await h.topics.read(h.workspace, h.mote.id))!
  expect(snapshot.soul?.content).toBeTruthy(); expect(snapshot.readError).toBeTruthy()
  expect(originalTopicAddress(h.workspace, snapshot, {})).toBeNull()
})

it.each(['pending', 'current'])('last-check confirmation preserves later %s bytes and retains the unconfirmed original operation', async target => {
  const h = await fixture(); await v1(h)
  const newer = 'late confirmation bytes\n', path = target === 'pending' ? join(h.directory, SCRATCH_DIRECTORY_IDENTITY_PENDING_PATH) : h.record
  await expect(normalizeDirectoryIdentity(h.directory, await scratchIdentityContext(h.workspace.path, h.mote.id), { beforeConfirm: async () => { await writeFile(path, newer) } }))
    .rejects.toMatchObject({ code: 'DIRECTORY_IDENTITY_WRITE_UNKNOWN' })
  expect(await readFile(path, 'utf8')).toBe(newer)
  if (target === 'current') expect(JSON.parse(await readFile(join(h.directory, SCRATCH_DIRECTORY_IDENTITY_PENDING_PATH), 'utf8')).identityDirectoryPath).toBe(h.original)
})

it('an unfinished stage without either original record stays unknown rather than becoming a new canonical identity', async () => {
  const h = await fixture()
  await writeFile(join(h.directory, '.agentmux/directory-identity.fixture.tmp'), JSON.stringify(directoryIdentityRecord({ topicId: h.mote.id, roots: { scratch: [h.workspace.path], topics: [join(h.home, '.agentmux/topics')], motes: [join(h.home, '.agentmux/motes')] }, original: h.original })))
  const snapshot = (await h.topics.read(h.workspace, h.mote.id))!
  expect(snapshot.soul?.content).toBeTruthy(); expect(snapshot.readError).toContain('witness is unavailable')
  expect(snapshot.identityDirectoryPath).toBeUndefined(); expect(originalTopicAddress(h.workspace, snapshot, {})).toBeNull()
})

it('injected native publish fsync EIO preserves pending through cold service reads until explicit durability repair', async () => {
  const h = await fixture(); await v1(h)
  const original = await readFile(h.record), soul = await readFile(join(h.directory, 'SOUL.md'))
  let failure: unknown
  await normalizeDirectoryIdentity(h.directory, await scratchIdentityContext(h.workspace.path, h.mote.id), { publicationSyncFault: true }).catch(error => { failure = error })
  expect(JSON.parse(await readFile(h.record, 'utf8'))).toEqual(directoryIdentityRecord({ topicId: h.mote.id, roots: { scratch: [h.workspace.path], topics: [join(h.home, '.agentmux/topics')], motes: [join(h.home, '.agentmux/motes')] }, original: h.original }))
  expect(await readFile(join(h.directory, SCRATCH_DIRECTORY_IDENTITY_PENDING_PATH)).catch(() => null)).toEqual(original)
  expect(failure).toMatchObject({ code: 'DIRECTORY_IDENTITY_WRITE_UNKNOWN', cause: { message: expect.stringContaining('errno=5 operation=file-publish-sync') } })
  const cold = new ScratchTopics(controlledNativeImage), snapshot = (await cold.read(h.workspace, h.mote.id))!
  expect(snapshot.identityDirectoryPath).toBe(h.original); expect(snapshot.readError).toContain('upgrade is unconfirmed')
  expect(await readFile(join(h.directory, 'SOUL.md'))).toEqual(soul)
  const facts = await observeClientRpcSnapshot(h.config, cold, { include: ['motes'] })
  expect(facts.motes![0]).toMatchObject({ kind: 'mote', spaceId: directoryIdentity('local', h.original), readError: snapshot.readError })
  expect(facts.unavailable?.length).toBeGreaterThan(0)
  const retained = await readFile(h.record), inode = (await stat(h.record)).ino
  await normalizeDirectoryIdentity(h.directory, await scratchIdentityContext(h.workspace.path, h.mote.id))
  expect(await readFile(h.record)).toEqual(retained); expect((await stat(h.record)).ino).toBe(inode)
  expect((await cold.read(h.workspace, h.mote.id))?.readError).toBeUndefined()
  await expect(readFile(join(h.directory, SCRATCH_DIRECTORY_IDENTITY_PENDING_PATH))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('a later valid pending witness after claim is retained instead of being adopted for cleanup in the old attempt', async () => {
  const h = await fixture(); await v1(h)
  const newer = JSON.stringify({ version: 1, identityDirectoryPath: h.original }, null, 2) + '\n'
  await expect(normalizeDirectoryIdentity(h.directory, await scratchIdentityContext(h.workspace.path, h.mote.id), { afterClaim: async () => {
    await writeFile(join(h.directory, SCRATCH_DIRECTORY_IDENTITY_PENDING_PATH), newer)
  } })).rejects.toMatchObject({ code: 'DIRECTORY_IDENTITY_WRITE_UNKNOWN' })
  expect(await readFile(join(h.directory, SCRATCH_DIRECTORY_IDENTITY_PENDING_PATH), 'utf8')).toBe(newer)
  expect((await h.topics.read(h.workspace, h.mote.id))?.readError).toContain('upgrade is unconfirmed')
  // A fresh explicit repair can use the exact newly inspected witness without rewriting current.
  const current = await readFile(h.record)
  await normalizeDirectoryIdentity(h.directory, await scratchIdentityContext(h.workspace.path, h.mote.id))
  expect(await readFile(h.record)).toEqual(current)
})
