import { access, mkdir, mkdtemp, readFile, readlink, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ScratchTopics } from '../src/main/scratch-topics'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { resolveScratchTopicDirectory } from '../src/main/scratch-topic-directories'
import { directoryIdentity, homeZoneId, spatialSources } from '../src/shared/space-addresses'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, scratchTopicDirectoryName, scratchTopicIdFromWorkspacePath, workspaceOwnsSessionPath } from '../src/shared/scratch-topics'
import type { AppConfig, WorkspaceRecord } from '../src/shared/contracts'
import { controlledNativeImage, imageInput, imagePng } from './fixtures/mote-identity-image'
import { migrateTopicDirectories } from '../scripts/migrate-topic-directories.mjs'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'agentmux-directory-consumer-'))); roots.push(home)
  const path = join(home, '.agentmux/scratch'); await mkdir(path, { recursive: true })
  const workspace: WorkspaceRecord = { id: SCRATCH_WORKSPACE_ID, name: 'Topics', hostId: 'local', kind: 'folder', path }
  const topics = new ScratchTopics(controlledNativeImage)
  const files = new WorkspaceFiles(() => ({ id: 'local', kind: 'local' }) as never, { primaryMoteWorkspace: async () => workspace })
  return { home, workspace, topics, files }
}
async function legacy(h: Awaited<ReturnType<typeof fixture>>, id: string, mote = false) {
  const created = mote ? await h.topics.ensureMote(h.workspace, id) : await h.topics.ensure(h.workspace, id)
  const directory = join(h.workspace.path, scratchTopicDirectoryName(id))
  await rename(created.physicalDirectoryPath!, directory)
  return (await h.topics.read(h.workspace, id))!
}

it('new Topic, primary and custom Mote creation use separate canonical homes and the real prepare caller', async () => {
  const h = await fixture()
  const ordinary = await h.topics.ensure(h.workspace, 'view:ordinary')
  const primary = await h.topics.ensure(h.workspace, PMO_TEAMS_TOPIC_ID)
  const custom = await h.topics.ensureMote(h.workspace, 'view:custom')
  expect(ordinary.physicalDirectoryPath).toBe(join(h.home, '.agentmux/topics', ordinary.directoryPath))
  for (const mote of [primary, custom]) {
    expect(mote.physicalDirectoryPath).toBe(join(h.home, '.agentmux/motes', mote.directoryPath))
    expect(mote.identityDirectoryPath).toBe(mote.physicalDirectoryPath)
    expect(mote.soul?.content.length).toBeGreaterThan(0)
    expect((await h.topics.prepareAgent(h.workspace, mote.id, { providerId: 'codex', sessionId: 'new-cwd' })).absolutePath).toBe(mote.physicalDirectoryPath)
    await expect(access(join(h.workspace.path, mote.directoryPath))).rejects.toMatchObject({ code: 'ENOENT' })
  }
  expect((await h.topics.list(h.workspace)).map(topic => topic.id)).toEqual(['launcher:leader', 'view:custom', 'view:ordinary'])
  expect((await h.files.readDirectory(h.workspace, '')).map(entry => entry.path)).toEqual(expect.arrayContaining([ordinary.directoryPath, primary.directoryPath, custom.directoryPath]))
})

it('migration preserves old durable Space, Zone, avatar and archive identity after the legacy alias is removed', async () => {
  const h = await fixture(), original = await legacy(h, 'view:retained', true)
  const key = directoryIdentity('local', original.identityDirectoryPath!)
  const avatar = await h.topics.saveAvatar(h.workspace, original.id, imageInput(imagePng()), key)
  const archived = await h.topics.setMoteArchived(h.workspace, original.id, true, key, 'unwritten')
  const inode = (await stat(original.physicalDirectoryPath!, { bigint: true })).ino
  const report = await migrateTopicDirectories({ home: h.home, execute: true })
  expect(report.success).toBe(true)
  expect(await readlink(original.physicalDirectoryPath!)).toBe('../motes/' + original.directoryPath)
  const current = (await h.topics.read(h.workspace, original.id))!
  expect(current.identityDirectoryPath).toBe(original.identityDirectoryPath)
  expect((await stat(current.physicalDirectoryPath!, { bigint: true })).ino).toBe(inode)
  expect(current.moteArchive).toEqual(archived)
  expect(await h.topics.readAvatar(h.workspace, original.id, avatar, key)).toMatchObject({ width: 256, height: 256 })
  await rm(original.physicalDirectoryPath!)
  const after = (await h.topics.list(h.workspace)).find(topic => topic.id === original.id)!
  expect(after.identityDirectoryPath).toBe(original.identityDirectoryPath)
  expect(after.moteArchive).toEqual(archived)
  const config = { workspaces: [h.workspace] } as AppConfig
  const zone = homeZoneId(key)
  const facts = spatialSources(config, [after], { [zone]: { spaceId: key, workspaceId: h.workspace.id } }, [{ workspaceId: h.workspace.id, space: { spaceId: key, zoneId: zone } }])
  expect(facts.spaces.find(space => space.spaceId === key)).toMatchObject({ directoryPath: current.physicalDirectoryPath, kind: 'mote', topicId: original.id })
  expect(facts.zones.find(item => item.zoneId === zone)).toMatchObject({ kind: 'home', directoryPath: current.physicalDirectoryPath })
  expect((await h.topics.readAvatar(h.workspace, original.id, avatar, key)).dataUrl.length).toBeGreaterThan(30)
})

it('the production file owner edits canonical objects through unchanged logical document paths and confines writes', async () => {
  const h = await fixture(), mote = await h.topics.ensureMote(h.workspace, 'view:file-owner')
  const path = mote.directoryPath + '/topic.md'
  const result = await h.files.read(h.workspace, path)
  expect(result.status).toBe('read')
  if (result.status !== 'read') throw new Error('The original document was not read.')
  expect(await h.files.write(h.workspace, { path, content: '# Saved through the original file owner\n', expectedRevision: result.document.revision })).toMatchObject({ status: 'written' })
  expect(await readFile(join(mote.physicalDirectoryPath!, 'topic.md'), 'utf8')).toContain('Saved through the original file owner')
  await h.files.create(h.workspace, { path: mote.directoryPath + '/refs/new.md', kind: 'file' })
  expect(await h.files.localPathForReveal(h.workspace, path)).toBe(join(mote.physicalDirectoryPath!, 'topic.md'))
  expect(await h.files.localPathForSystemOpen(h.workspace, path)).toBe(join(mote.physicalDirectoryPath!, 'topic.md'))
  const outside = join(h.home, '.agentmux/outside'); await mkdir(outside); await writeFile(join(outside, 'secret.md'), 'Preserve these bytes')
  await symlink(outside, join(mote.physicalDirectoryPath!, 'escape'))
  const escaping = mote.directoryPath + '/escape/secret.md'
  await expect(h.files.create(h.workspace, { path: mote.directoryPath + '/escape/new.md', kind: 'file' })).rejects.toThrow('escapes')
  expect(await h.files.write(h.workspace, { path: escaping, content: 'overwrite', expectedRevision: null })).toMatchObject({ status: 'error' })
  expect(await readFile(join(outside, 'secret.md'), 'utf8')).toBe('Preserve these bytes')
  // The existing explicit read-only link capability still works.
  expect(await h.files.read(h.workspace, escaping)).toMatchObject({ status: 'read', document: { content: 'Preserve these bytes' } })
})

it('cross-home material moves retain atomic no-replace and primary Mote protection', async () => {
  const h = await fixture()
  const topic = await h.topics.ensure(h.workspace, 'view:topic-move')
  const mote = await h.topics.ensureMote(h.workspace, 'view:mote-move')
  await writeFile(join(topic.physicalDirectoryPath!, 'refs/one.md'), 'Move the same file')
  const from = topic.directoryPath + '/refs/one.md', to = mote.directoryPath + '/refs/one.md'
  const move = () => h.files.move(h.workspace, h.workspace, { source: { workspaceId: h.workspace.id, path: from }, destination: { workspaceId: h.workspace.id, path: to } })
  expect(await move()).toEqual({ status: 'moved' })
  expect(await readFile(join(mote.physicalDirectoryPath!, 'refs/one.md'), 'utf8')).toBe('Move the same file')
  await writeFile(join(topic.physicalDirectoryPath!, 'refs/one.md'), 'Keep competitor')
  expect(await move()).toMatchObject({ status: 'error', finalLocation: 'source' })
  expect(await readFile(join(topic.physicalDirectoryPath!, 'refs/one.md'), 'utf8')).toBe('Keep competitor')
  const primary = await h.topics.ensureMote(h.workspace, PMO_TEAMS_TOPIC_ID)
  await expect(h.files.delete(h.workspace, primary.directoryPath)).rejects.toMatchObject({ code: 'PRIMARY_MOTE_PROTECTED' })
  await expect(h.files.delete({ ...h.workspace, id: 'parent', path: join(h.home, '.agentmux') }, 'motes/' + primary.directoryPath)).rejects.toMatchObject({ code: 'PRIMARY_MOTE_PROTECTED' })
  await access(join(primary.physicalDirectoryPath!, 'SOUL.md'))
})

it('exact canonical and retained cwd parsing preserves original Session ownership without accepting unrelated descendants', async () => {
  const h = await fixture(), id = 'view:identity', name = scratchTopicDirectoryName(id)
  for (const kind of ['scratch', 'topics', 'motes']) {
    const workspacePath = join(h.home, '.agentmux', kind, name)
    expect(scratchTopicIdFromWorkspacePath(h.workspace.path, workspacePath)).toBe(id)
    expect(workspaceOwnsSessionPath(h.workspace, { hostId: 'local', workspacePath })).toBe(true)
    expect(workspaceOwnsSessionPath(h.workspace, { hostId: 'elsewhere', workspacePath })).toBe(false)
    expect(scratchTopicIdFromWorkspacePath(h.workspace.path, workspacePath + '/refs')).toBeNull()
  }
  expect(scratchTopicIdFromWorkspacePath(h.workspace.path, join(h.home, '.agentmux/unrelated', name))).toBeNull()
})

it('duplicate homes, forged aliases and broken identity records stay visible without changing data or identity', async () => {
  const h = await fixture(), original = await legacy(h, 'view:unsafe', true)
  expect((await migrateTopicDirectories({ home: h.home, execute: true })).success).toBe(true)
  const current = (await h.topics.read(h.workspace, original.id))!
  const record = join(current.physicalDirectoryPath!, '.agentmux/directory-identity.json')
  const before = await readFile(join(current.physicalDirectoryPath!, 'SOUL.md'))
  await writeFile(record, JSON.stringify({ version: 1, identityDirectoryPath: current.physicalDirectoryPath }))
  expect((await h.topics.list(h.workspace)).find(topic => topic.id === original.id)?.readError).toContain('identity is unconfirmed')
  expect((await h.topics.read(h.workspace, original.id))?.readError).toContain('identity is unconfirmed')
  expect((await h.topics.read(h.workspace, original.id))?.soul?.content).toBe(before.toString())
  await writeFile(record, JSON.stringify({ version: 1, identityDirectoryPath: original.identityDirectoryPath }))
  await mkdir(join(h.home, '.agentmux/topics', original.directoryPath), { recursive: true })
  await expect(resolveScratchTopicDirectory(h.workspace.path, original.id)).rejects.toThrow('conflict')
  await rm(join(h.home, '.agentmux/topics', original.directoryPath), { recursive: true })
  await rm(original.physicalDirectoryPath!); await symlink(h.home, original.physicalDirectoryPath!)
  await expect(resolveScratchTopicDirectory(h.workspace.path, original.id)).rejects.toThrow('escapes')
  expect(await readFile(join(current.physicalDirectoryPath!, 'SOUL.md'))).toEqual(before)
})
