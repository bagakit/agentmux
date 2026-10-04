import { appendFile, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeAll, expect, it } from 'vitest'
import { migrateTopicDirectories, type DirectoryMaintenanceOptions } from '../scripts/migrate-topic-directories.mjs'
import { ScratchTopics } from '../src/main/scratch-topics'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { FileReadOwner } from '../src/main/file-read-owner'
import { observeClientRpcSnapshot } from '../src/main/rpc-client-observations'
import { inspectDirectoryIdentity, normalizeDirectoryIdentity, moteDirectoryName, SCRATCH_DIRECTORY_ALIAS_PENDING_PATH, SCRATCH_DIRECTORY_IDENTITY_PENDING_PATH } from '../src/main/scratch-directory-identity.mjs'
import { scratchIdentityContext, resolveScratchTopicDirectory } from '../src/main/scratch-topic-directories'
import { spatialSources, directoryIdentity, homeZoneId } from '../src/shared/space-addresses'
import { SCRATCH_WORKSPACE_ID, PMO_TEAMS_TOPIC_ID, scratchTopicDirectoryName } from '../src/shared/scratch-topics'
import { controlledNativeImage } from './fixtures/mote-identity-image'
import type { AppConfig, WorkspaceRecord } from '../src/shared/contracts'
const repository = resolve(import.meta.dirname, '../../..'), roots: string[] = []
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
let helper: string
beforeAll(async () => {
  await mkdir(join(repository, '.tmp'), { recursive: true })
  const artifacts = await mkdtemp(join(repository, '.tmp/t2-maintenance-native-')); helper = join(artifacts, 'workspace-move')
  const source = join(repository, 'apps/desktop/native/workspace-move.c')
  execFileSync('xcrun', ['clang', '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', source, '-o', helper])
  if (process.env.AGENTMUX_DIRECTORY_IDENTITY_PROOF) await appendFile(process.env.AGENTMUX_DIRECTORY_IDENTITY_PROOF, JSON.stringify({ consumer: 'actual-native-helper', file: relative(repository, source), sha256: hash(await readFile(source)), helperSha256: hash(await readFile(helper)) }) + '\n')
})
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function fixture(id = 'launcher:maintained', role: 'scratch'|'motes'|'topics' = 'motes') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'amux-t2-'))); roots.push(root)
  await mkdir(join(root, 'scratch'))
  const workspace: WorkspaceRecord = { id: SCRATCH_WORKSPACE_ID, hostId: 'local', kind: 'folder', name: 'Original', path: join(root, 'scratch') }
  const owner = new ScratchTopics(controlledNativeImage), seed = await owner.ensure(workspace, id, undefined, false)
  await mkdir(join(root, role), { recursive: true }); const old = join(root, role, scratchTopicDirectoryName(id))
  if (seed.physicalDirectoryPath !== old) await rename(seed.physicalDirectoryPath!, old)
  await writeFile(join(old, 'SOUL.md'), '# Original personality\n'); await writeFile(join(old, 'note.md'), '# Original Note\n')
  await owner.normalizeDirectoryIdentities(workspace, { helperPath: helper })
  const topic = (await owner.read(workspace, id))!, original = await stat(old, { bigint: true })
  const files = new WorkspaceFiles(() => ({ id: 'local', kind: 'local' }) as never, { primaryMoteWorkspace: async () => workspace })
  const facts = spatialSources({ workspaces: [workspace] } as AppConfig, [topic]), zoneId = homeZoneId(directoryIdentity('local', topic.identityDirectoryPath!))
  const publicFiles = new FileReadOwner({ files, catalog: async () => ({ ...facts, tabs: [], regions: [], locations: [] }), workspace: value => value === workspace.id ? workspace : undefined,
    topicForDirectory: (value, path) => owner.readForDirectory(value, path) })
  const input = { zoneId, path: 'note.md', expectedResource: { hostId: 'local', workspaceId: workspace.id, workspacePath: workspace.path } }
  const run = (nativeOptions?: DirectoryMaintenanceOptions['nativeOptions'], execute = true) => migrateTopicDirectories({ scratchRoot: workspace.path, execute, motesOnly: true, helperPath: helper, ...(nativeOptions ? { nativeOptions } : {}) })
  return { root, workspace, owner, old, id, topic, original, files, publicFiles, input, run, canonical: join(root, 'motes', moteDirectoryName(id)) }
}
async function inventory(root: string): Promise<unknown[]> {
  const rows: unknown[] = []
  async function visit(path: string) {
    const info = await lstat(path, { bigint: true })
    rows.push({ path: relative(root, path), dev: String(info.dev), ino: String(info.ino), mtime: String(info.mtimeNs),
      content: info.isSymbolicLink() ? await readlink(path) : info.isFile() ? hash(await readFile(path)) : null })
    if (info.isDirectory()) for (const name of (await readdir(path)).sort()) await visit(join(path, name))
  }
  await visit(root); return rows
}
it('actual discovery, File reads and both preview entry points write zero bytes or directory entries', async () => {
  const h = await fixture('launcher:preview'), before = await inventory(h.root)
  expect((await h.owner.list(h.workspace)).map(topic => topic.id)).toContain(h.id)
  expect((await h.publicFiles.read(h.input)).result).toMatchObject({ status: 'read' })
  expect((await h.run(undefined, false)).success).toBe(true)
  const report = JSON.parse(execFileSync(process.execPath, [resolve(import.meta.dirname, '../scripts/migrate-topic-directories.mjs'), '--dry-run', '--scratch-root', h.workspace.path, '--helper-path', helper], { encoding: 'utf8' }))
  expect(report.success).toBe(true); expect(report.objects[0].state).toBe('planned')
  expect(await inventory(h.root)).toEqual(before)
})
it('the same original CLI execute and repair entry consume the real native owner without a new command engine', async () => {
  const h = await fixture('launcher:cli'), cli = resolve(import.meta.dirname, '../scripts/migrate-topic-directories.mjs')
  const execute = JSON.parse(execFileSync(process.execPath, [cli, '--execute', '--scratch-root', h.workspace.path, '--helper-path', helper], { encoding: 'utf8' }))
  expect(execute.success).toBe(true); expect(execute.objects[0].state).toBe('migrated')
  const repair = JSON.parse(execFileSync(process.execPath, [cli, '--repair', '--scratch-root', h.workspace.path, '--helper-path', helper], { encoding: 'utf8' }))
  expect(repair.success).toBe(true); expect(repair.objects[0].state).toBe('already-migrated')
  expect((await stat(h.old, { bigint: true })).ino).toBe(h.original.ino)
})
it.each(['scratch','motes','topics'] as const)('original %s Mote is shortened with original ID, inode, assets, Zone and every saved cwd', async role => {
  const h = await fixture('launcher:origin-' + role, role), identity = h.topic.identityDirectoryPath, initial = await readFile(join(h.old, 'note.md'))
  const dry = await h.run(undefined, false); expect(dry.success).toBe(true); expect((await lstat(h.old)).isDirectory()).toBe(true)
  expect(await inspectDirectoryIdentity(h.old, await scratchIdentityContext(h.workspace.path, h.id))).toMatchObject({ needsUpgrade: false })
  const report = await h.run(); expect(report.success, JSON.stringify(report)).toBe(true)
  expect((await stat(h.canonical, { bigint: true })).ino).toBe(h.original.ino)
  expect(await readFile(join(h.old, 'note.md'))).toEqual(initial)
  if (role === 'scratch') expect(await readFile(join(h.root, 'motes', scratchTopicDirectoryName(h.id), 'note.md'))).toEqual(initial)
  const cold = (await new ScratchTopics(controlledNativeImage).read(h.workspace, h.id))!
  expect(cold.identityDirectoryPath).toBe(identity); expect(cold.id).toBe(h.id); expect(cold.readError).toBeUndefined()
  expect((await h.publicFiles.read(h.input)).result).toMatchObject({ status: 'read', document: { content: initial.toString() } })
  expect((await h.run()).success).toBe(true)
})
it('canonical-only configured roots work without a Scratch root; ordinary Topics do not move during startup maintenance', async () => {
  const h = await fixture('launcher:canonical-only'); await rm(h.workspace.path, { recursive: true })
  const plain = join(h.root, 'topics/topic--launcher--plain'); await mkdir(plain); await writeFile(join(plain, 'topic.md'), '# Plain\n')
  const before = (await stat(plain, { bigint: true })).ino
  const report = await h.run(); expect(report.success, JSON.stringify(report)).toBe(true)
  expect((await stat(h.canonical, { bigint: true })).ino).toBe(h.original.ino); expect((await stat(plain, { bigint: true })).ino).toBe(before)
  expect((await lstat(plain)).isDirectory()).toBe(true)
})
it.each(['afterWitness','beforeSwap','afterSwap','beforeFinalize'] as const)('actual %s helper death retains same witnesses, healthy original Files and exact repair', async phase => {
  const h = await fixture('launcher:kill-' + phase)
  const report = await h.run({ [phase]: async child => {
    const fact = await h.owner.readForDirectory(h.workspace, h.old)
    expect(fact).toMatchObject({ id: h.id, identityDirectoryPath: h.topic.identityDirectoryPath }); expect(fact?.readError).toBeTruthy()
    expect((await h.publicFiles.read(h.input)).result).toMatchObject({ status: 'read', document: { content: '# Original Note\n' } })
    child.kill('SIGKILL')
  } })
  expect(report.success).toBe(false); expect(report.objects[0]?.state).toBe('unknown')
  const physical = await resolveScratchTopicDirectory(h.workspace.path, h.id).catch(() => null); expect(physical).toBeTruthy()
  const observed = await inspectDirectoryIdentity(physical!, await scratchIdentityContext(h.workspace.path, h.id))
  expect(observed?.pending?.info.ino).toBe(observed?.current?.info.ino); expect(observed?.aliasPending).toBe(true)
  await expect(normalizeDirectoryIdentity(physical!, await scratchIdentityContext(h.workspace.path, h.id), { helperPath: helper })).rejects.toThrow('relocation')
  expect((await h.publicFiles.read(h.input)).result).toMatchObject({ status: 'read' })
  expect((await h.run()).success).toBe(true); expect((await stat(h.old, { bigint: true })).ino).toBe(h.original.ino)
  expect((await h.owner.read(h.workspace, h.id))?.readError).toBeUndefined()
})
it.each(['source','destination'] as const)('actual %s parent fsync EIO never retires same-operation witnesses', async role => {
  const h = await fixture('launcher:eio-' + role), report = await h.run({ syncFault: role })
  expect(report.success).toBe(false); expect(report.objects[0]?.issue?.message).toContain('errno=5')
  expect((await lstat(join(h.canonical, SCRATCH_DIRECTORY_ALIAS_PENDING_PATH))).isSymbolicLink()).toBe(true)
  expect(await readFile(join(h.canonical, SCRATCH_DIRECTORY_IDENTITY_PENDING_PATH))).toBeTruthy()
  expect((await h.publicFiles.read(h.input)).result).toMatchObject({ status: 'read' })
  expect((await h.run()).success).toBe(true)
})
it('stage creation death without a claimed raw witness stays explicit unknown and retains the original healthy files', async () => {
  const h = await fixture('launcher:incomplete-stage')
  expect((await h.run({ afterStageCreate: child => { child.kill('SIGKILL') } })).success).toBe(false)
  const fact = await h.owner.readForDirectory(h.workspace, h.old)
  expect(fact?.identityDirectoryPath).toBe(h.topic.identityDirectoryPath); expect(fact?.readError).toContain('relocation')
  expect((await h.publicFiles.read(h.input)).result).toMatchObject({ status: 'read' })
  expect((await h.run()).objects[0]?.state).toBe('unknown')
  expect((await lstat(join(h.old, SCRATCH_DIRECTORY_ALIAS_PENDING_PATH))).isSymbolicLink()).toBe(true)
  expect(await readFile(join(h.old, 'note.md'), 'utf8')).toBe('# Original Note\n')
})
it.each(['source','target','parent'] as const)('the actual final syscall window preserves a late %s replacement and refuses stale success', async role => {
  const h = await fixture('launcher:late-' + role, 'topics'), retained = join(h.root, 'retained-' + role), foreign = 'exact later bytes\n'
  const report = await h.run({ lastSwap: async () => {
    if (role === 'source') { await rename(h.old, retained); await mkdir(h.old); await writeFile(join(h.old, 'foreign.md'), foreign) }
    else if (role === 'target') { await rm(h.canonical); await mkdir(h.canonical); await writeFile(join(h.canonical, 'foreign.md'), foreign) }
    else { await rename(dirname(h.canonical), retained); await mkdir(dirname(h.canonical)); await writeFile(join(dirname(h.canonical), 'foreign.md'), foreign) }
  } })
  expect(report.success).toBe(false); expect(report.objects[0]?.state).toBe('unknown')
  const original = role === 'source' ? retained : role === 'target' ? h.canonical : join(retained, basename(h.canonical))
  const later = role === 'source' ? h.canonical : role === 'target' ? h.old : dirname(h.canonical)
  expect(await readFile(join(original, 'note.md'), 'utf8')).toBe('# Original Note\n')
  expect((await stat(original, { bigint: true })).ino).toBe(h.original.ino)
  expect(await readFile(join(later, 'foreign.md'), 'utf8')).toBe(foreign)
  expect(await readFile(join(original, SCRATCH_DIRECTORY_IDENTITY_PENDING_PATH))).toBeTruthy()
  expect((await lstat(join(original, SCRATCH_DIRECTORY_ALIAS_PENDING_PATH))).isSymbolicLink()).toBe(true)
})
it('post-fsync visible parent replacement preserves the original pending operation and every later parent byte', async () => {
  const h = await fixture('launcher:late-finalize', 'topics'), retained = join(h.root, 'retained-motes')
  const report = await h.run({ beforeFinalize: async () => {
    await rename(dirname(h.canonical), retained); await mkdir(dirname(h.canonical)); await writeFile(join(dirname(h.canonical), 'foreign.md'), 'later parent\n')
  } })
  expect(report.success).toBe(false); expect(report.objects[0]?.state).toBe('unknown')
  const original = join(retained, basename(h.canonical))
  await expect(readFile(join(original, SCRATCH_DIRECTORY_IDENTITY_PENDING_PATH))).resolves.toBeTruthy()
  expect(await readFile(join(dirname(h.canonical), 'foreign.md'), 'utf8')).toBe('later parent\n')
})
it('the original startup maintenance owner repairs an interrupted exchange without a stale warning and leaves ordinary Topics in place', async () => {
  const h = await fixture('launcher:startup-repair')
  expect((await h.run({ beforeSwap: child => { child.kill('SIGKILL') } })).success).toBe(false)
  const ordinary = await h.owner.ensure(h.workspace, 'launcher:ordinary', undefined, false)
  const originalPath = join(h.workspace.path, ordinary.directoryPath)
  await rename(ordinary.physicalDirectoryPath!, originalPath)
  const original = (await stat(originalPath, { bigint: true })).ino
  await h.owner.normalizeDirectoryIdentities(h.workspace, { shortenMotes: true, helperPath: helper })
  expect((await h.owner.read(h.workspace, h.id))?.readError).toBeUndefined()
  expect((await stat(originalPath, { bigint: true })).ino).toBe(original)
  expect((await lstat(originalPath)).isDirectory()).toBe(true)
})
it('startup failure before any alias witness remains a public collection service fact while the healthy Mote and Files stay usable', async () => {
  const h = await fixture('launcher:early-maintenance-error')
  await expect(h.owner.normalizeDirectoryIdentities(h.workspace, { shortenMotes: true, helperPath: join(h.root, 'unavailable-private-helper') })).rejects.toThrow('maintenance is unconfirmed')
  const snapshot = await observeClientRpcSnapshot({ workspaces: [h.workspace] } as AppConfig, h.owner, { include: ['motes'] })
  expect(snapshot.unavailable?.length).toBeGreaterThan(0)
  expect(snapshot.motes).toHaveLength(1); expect(snapshot.motes![0]?.readError).toBeUndefined()
  expect((await h.publicFiles.read(h.input)).result).toMatchObject({ status: 'read' })
  const recordPath = join(h.old, '.agentmux/directory-identity.json'), record = JSON.parse(await readFile(recordPath, 'utf8'))
  await writeFile(recordPath, JSON.stringify({ version: 2, identityDirectoryName: record.identityDirectoryName, identityPathHash: record.identityPathHash }) + '\n')
  await expect(h.owner.normalizeDirectoryIdentities(h.workspace, { helperPath: join(h.root, 'unavailable-private-helper') })).rejects.toThrow('maintenance is unconfirmed')
  expect((await observeClientRpcSnapshot({ workspaces: [h.workspace] } as AppConfig, h.owner, { include: ['motes'] })).unavailable).toEqual(expect.arrayContaining(snapshot.unavailable!))
  await h.owner.normalizeDirectoryIdentities(h.workspace, { helperPath: helper })
  expect((await observeClientRpcSnapshot({ workspaces: [h.workspace] } as AppConfig, h.owner, { include: ['motes'] })).unavailable).toEqual(snapshot.unavailable)
  await h.owner.normalizeDirectoryIdentities(h.workspace, { shortenMotes: true, helperPath: helper })
  expect((await observeClientRpcSnapshot({ workspaces: [h.workspace] } as AppConfig, h.owner, { include: ['motes'] })).unavailable).toEqual([])
})
it('equal-text foreign target is never adopted, and incomplete original witnesses remain unknown', async () => {
  const h = await fixture('launcher:foreign-stage')
  const stopped = await h.run({ beforeSwap: child => { child.kill('SIGKILL') } }); expect(stopped.success).toBe(false)
  const stage = join(h.old, SCRATCH_DIRECTORY_ALIAS_PENDING_PATH), text = await readlink(stage)
  await rm(h.canonical); await symlink(text, h.canonical)
  const before = (await lstat(h.canonical, { bigint: true })).ino
  const rejected = await h.run(); expect(rejected.success).toBe(false); expect((await lstat(h.canonical, { bigint: true })).ino).toBe(before)
  expect(await readFile(join(h.old, 'note.md'), 'utf8')).toBe('# Original Note\n')
  await rm(h.canonical); await rm(stage)
  await expect(normalizeDirectoryIdentity(h.old, await scratchIdentityContext(h.workspace.path, h.id), { helperPath: helper })).rejects.toThrow('relocation')
  expect((await h.run()).objects[0]?.state).toBe('unknown')
})
it('a same-text foreign stage arriving inside the real helper window is refused by exact inode without overwriting it', async () => {
  const h = await fixture('launcher:foreign-late-stage'); let foreignInode: bigint | undefined
  const report = await h.run({ beforeSwap: async () => {
    const text = await readlink(h.canonical)
    await rm(h.canonical); await symlink(text, h.canonical)
    foreignInode = (await lstat(h.canonical, { bigint: true })).ino
  } })
  expect(report.success).toBe(false); expect(report.objects[0]?.state).toBe('unknown')
  expect((await lstat(h.canonical, { bigint: true })).ino).toBe(foreignInode)
  expect((await lstat(h.old)).isDirectory()).toBe(true)
  expect(await readFile(join(h.old, 'note.md'), 'utf8')).toBe('# Original Note\n')
  expect(await readFile(join(h.old, SCRATCH_DIRECTORY_IDENTITY_PENDING_PATH))).toBeTruthy()
})
it('real primary deletion protects physical, Scratch and intermediate aliases while internal files and custom Motes remain usable', async () => {
  const h = await fixture(PMO_TEAMS_TOPIC_ID, 'scratch'); expect((await h.run()).success).toBe(true)
  const outer = { ...h.workspace, id: 'registered-parent', path: h.root }
  for (const path of ['motes/' + moteDirectoryName(h.id), 'scratch/' + scratchTopicDirectoryName(h.id), 'motes/' + scratchTopicDirectoryName(h.id)])
    await expect(h.files.delete(outer, path)).rejects.toMatchObject({ code: 'PRIMARY_MOTE_PROTECTED' })
  await h.files.delete(h.workspace, scratchTopicDirectoryName(h.id) + '/note.md')
  const custom = await h.owner.ensureMote(h.workspace, 'launcher:deletable')
  await h.files.delete(h.workspace, custom.directoryPath)
  expect(await readFile(join(h.canonical, 'SOUL.md'), 'utf8')).toBe('# Original personality\n')
  expect(await realpath(h.old)).toBe(h.canonical)
})
it('two actual helpers serialize the same original inode and finish idempotently rather than exchange twice', async () => {
  const h = await fixture('launcher:duplicate'), rootInfo = await stat(h.root, { bigint: true }), saved = (await inspectDirectoryIdentity(h.old, await scratchIdentityContext(h.workspace.path, h.id)))!
  const raw = saved.current!, args = ['--alias-swap', h.root, String(rootInfo.dev), String(rootInfo.ino), 'motes/' + basename(h.old), 'motes/' + basename(h.canonical), String(h.original.dev), String(h.original.ino),
    '--witness', '.agentmux/directory-identity.json', SCRATCH_DIRECTORY_IDENTITY_PENDING_PATH, SCRATCH_DIRECTORY_ALIAS_PENDING_PATH, String(saved.parent.dev), String(saved.parent.ino), String(raw.info.dev), String(raw.info.ino), hash(raw.bytes), '--last-swap-barrier']
  const start = () => spawn(helper, args, { stdio: ['ignore', 'ignore', 'pipe', ...Array(10).fill('pipe')] })
  const first = start(); let second: ReturnType<typeof start> | undefined
  try {
    await once(first.stdio[11]!, 'data'); second = start(); let entered = false; second.stdio[11]!.on('data', () => { entered = true })
    await new Promise(accept => setTimeout(accept, 100)); expect(entered).toBe(false)
    const firstDone = once(first, 'close'), secondDone = once(second, 'close'); (first.stdio[12] as import('node:stream').Writable).end('R')
    expect((await firstDone)[0]).toBe(0); expect((await secondDone)[0]).toBe(0)
    expect((await lstat(h.old)).isSymbolicLink()).toBe(true); expect((await lstat(h.canonical)).isDirectory()).toBe(true)
    expect((await stat(h.old, { bigint: true })).ino).toBe(h.original.ino)
  } finally { if (first.exitCode === null) first.kill('SIGKILL'); if (second?.exitCode === null) second.kill('SIGKILL') }
}, 10000)
