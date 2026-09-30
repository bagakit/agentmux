import { chmod, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ScratchTopics } from '../src/main/scratch-topics'
import { directoryIdentity } from '../src/shared/space-addresses'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, MOTE_STATE_PATH, scratchTopicDirectoryName } from '../src/shared/scratch-topics'
import { scratchMoteTopics, scratchTopicKind } from '../src/renderer/src/lib/scratch-topic-snapshots'
import type { AgentMuxPreloadApi } from '../src/shared/contracts'

const transport = vi.hoisted(() => ({ api: undefined as AgentMuxPreloadApi | undefined, invoke: vi.fn<(...values: unknown[]) => Promise<unknown>>() }))
vi.mock('electron', () => ({ nativeImage: {}, webFrame: {}, ipcRenderer: { invoke: transport.invoke },
  contextBridge: { exposeInMainWorld(_name: string, api: AgentMuxPreloadApi) { transport.api = api } } }))

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), 'mote-archive-')); roots.push(path)
  const workspace = { id: SCRATCH_WORKSPACE_ID, hostId: 'local', path, name: 'Topics', kind: 'folder' as const }
  const service = new ScratchTopics()
  for (const id of [PMO_TEAMS_TOPIC_ID, 'view:analyst', 'view:quiet']) await service.ensureMote(workspace, id)
  await service.ensure(workspace, 'view:ordinary')
  const id = 'view:analyst', directory = join(path, scratchTopicDirectoryName(id)), key = directoryIdentity(workspace.hostId, directory)
  return { workspace, service, id, directory, key }
}
it('real archive and restore retain four original directory objects, all user files and idempotent ensure across new service owners', async () => {
  const { workspace, service, id, directory, key } = await fixture()
  const names = ['SOUL.md', 'topic.md', '.agentmux/topic-wiki.md', '.agentmux/topic-wiki.json', 'outcome/keep.txt', '.agentmux/avatars/keep.png']
  await mkdir(join(directory, '.agentmux/avatars')); await writeFile(join(directory, 'outcome/keep.txt'), 'Original outcome'); await writeFile(join(directory, '.agentmux/avatars/keep.png'), 'Original asset')
  const before = await Promise.all(names.map(name => readFile(join(directory, name))))
  const initial = await service.list(workspace)
  expect(initial.map(topic => topic.id)).toEqual(['launcher:leader', 'view:analyst', 'view:ordinary', 'view:quiet'])
  expect(scratchMoteTopics(initial).map(topic => topic.id)).toEqual(['launcher:leader', 'view:analyst', 'view:quiet'])
  const archived = await service.setMoteArchived(workspace, id, true, key, 'unwritten')
  expect(archived.state).toBe('archived'); expect(archived.version).not.toBe('unwritten')
  expect((await new ScratchTopics().read(workspace, id))?.moteArchive).toEqual(archived)
  expect((await service.ensureMote(workspace, id)).moteArchive).toEqual(archived)
  expect(scratchMoteTopics(await service.list(workspace)).map(topic => topic.id)).toEqual(['launcher:leader', 'view:analyst', 'view:quiet'])
  const restored = await new ScratchTopics().setMoteArchived(workspace, id, false, key, archived.version)
  expect(restored.state).toBe('active'); expect(restored.version).not.toBe(archived.version)
  expect((await new ScratchTopics().read(workspace, id))?.moteArchive).toEqual(restored)
  expect(await Promise.all(names.map(name => readFile(join(directory, name))))).toEqual(before)
  expect(await readdir(join(directory, '.agentmux'))).not.toContain('mote-state.json.tmp')
})
it('final service refuses primary, ordinary Topics, missing objects, stale locator and nonlocal requests before archive writes', async () => {
  const { workspace, service, id, key, directory } = await fixture()
  await expect(service.setMoteArchived(workspace, PMO_TEAMS_TOPIC_ID, true,
    directoryIdentity('local', join(workspace.path, scratchTopicDirectoryName(PMO_TEAMS_TOPIC_ID))), 'primary')).rejects.toThrow('primary')
  for (const other of ['view:ordinary', 'view:missing']) await expect(service.setMoteArchived(workspace, other, true,
    directoryIdentity('local', join(workspace.path, scratchTopicDirectoryName(other))), 'unwritten')).rejects.toThrow()
  await expect(service.setMoteArchived({ ...workspace, path: workspace.path + '-replacement' }, id, true, key, 'unwritten')).rejects.toThrow('changed')
  await expect(service.setMoteArchived({ ...workspace, hostId: 'remote' }, id, true, key, 'unwritten')).rejects.toThrow()
  await expect(readFile(join(directory, MOTE_STATE_PATH))).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await service.read(workspace, PMO_TEAMS_TOPIC_ID))?.moteArchive).toEqual({ state: 'active', version: 'primary' })
})
it('fresh unique generations reject a late ABA expected version and concurrent same-object stale writes', async () => {
  const { workspace, service, id, key } = await fixture()
  const firstActive = await service.setMoteArchived(workspace, id, false, key, 'unwritten')
  const archived = await service.setMoteArchived(workspace, id, true, key, firstActive.version)
  const restored = await service.setMoteArchived(workspace, id, false, key, archived.version)
  expect(restored.version).not.toBe(firstActive.version)
  await expect(service.setMoteArchived(workspace, id, true, key, firstActive.version)).rejects.toThrow('changed')
  const a = service.setMoteArchived(workspace, id, true, key, restored.version)
  const b = service.setMoteArchived(workspace, id, false, key, restored.version)
  const results = await Promise.allSettled([a, b])
  expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected'])
  const confirmed = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
  expect(confirmed).toHaveLength(1)
  expect((await service.read(workspace, id))?.moteArchive).toEqual(confirmed[0])
})
it('bad archive metadata stays independently unknown while SOUL and Mote classification remain confirmed', async () => {
  const { workspace, service, id, directory, key } = await fixture()
  for (const content of ['bad-json', '{"archived":false}', '{"archived":"false","version":"bad"}']) {
    await writeFile(join(directory, MOTE_STATE_PATH), content)
    const topic = (await service.read(workspace, id))!
    expect(topic.moteArchive?.state).toBe('unknown'); expect(topic.readError).toBeUndefined()
    expect(topic.soul?.content.length).toBeGreaterThan(0); expect(scratchTopicKind(id, [topic])).toBe('mote')
    expect(scratchMoteTopics([topic]).map(one => one.id)).toEqual([PMO_TEAMS_TOPIC_ID, id])
    await expect(service.setMoteArchived(workspace, id, true, key, 'unwritten')).rejects.toThrow('unconfirmed')
    expect(await readFile(join(directory, MOTE_STATE_PATH), 'utf8')).toBe(content)
  }
})
it('regular directory and leaf guards preserve symlink targets and unconfirmed files without optimistic mutation', async () => {
  const { workspace, service, id, directory, key } = await fixture()
  const outside = join(workspace.path, 'outside.json'); await writeFile(outside, 'Original bytes')
  await symlink(outside, join(directory, MOTE_STATE_PATH))
  expect((await service.read(workspace, id))?.moteArchive?.state).toBe('unknown')
  await expect(service.setMoteArchived(workspace, id, true, key, 'unwritten')).rejects.toThrow('unconfirmed')
  expect(await readFile(outside, 'utf8')).toBe('Original bytes')
  await rm(join(directory, '.agentmux'), { recursive: true }); await mkdir(join(workspace.path, 'outside'))
  await symlink(join(workspace.path, 'outside'), join(directory, '.agentmux'))
  await expect(service.setMoteArchived(workspace, id, true, key, 'unwritten')).rejects.toThrow('unconfirmed')
  expect(await readdir(join(workspace.path, 'outside'))).toEqual([])
})
it('archive commits inspect only the original Mote and metadata, independent of Wiki and collaborator reads', async () => {
  const { workspace, service, id, directory, key } = await fixture()
  await rm(join(directory, '.agents'), { recursive: true })
  await rm(join(directory, '.agentmux/topic-wiki.md')); await mkdir(join(directory, '.agentmux/topic-wiki.md'))
  await expect(service.read(workspace, id)).rejects.toThrow()
  const archived = await service.setMoteArchived(workspace, id, true, key, 'unwritten')
  expect(archived.state).toBe('archived')
  expect(JSON.parse(await readFile(join(directory, MOTE_STATE_PATH), 'utf8'))).toEqual({ archived: true, version: archived.version })
})
it('real atomic write failure retains the saved archived bytes and permits Restore only after directory writes become available', async () => {
  const { workspace, service, id, directory, key } = await fixture()
  const archived = await service.setMoteArchived(workspace, id, true, key, 'unwritten')
  const bytes = await readFile(join(directory, MOTE_STATE_PATH)), metadata = join(directory, '.agentmux')
  await chmod(metadata, 0o500)
  try {
    await expect(service.setMoteArchived(workspace, id, false, key, archived.version)).rejects.toMatchObject({ code: 'EACCES' })
    expect(await readFile(join(directory, MOTE_STATE_PATH))).toEqual(bytes)
    expect((await service.read(workspace, id))?.moteArchive).toEqual(archived)
  } finally { await chmod(metadata, 0o700) }
  expect((await service.setMoteArchived(workspace, id, false, key, archived.version)).state).toBe('active')
})
it('the real preload carries explicit identity and version through its typed archive invoke to the original filesystem owner', async () => {
  const { workspace, service, id, key } = await fixture()
  await import('../src/preload/index')
  expect(transport.api).toBeDefined()
  transport.invoke.mockReset(); transport.invoke.mockImplementation(async (channel, workspaceId, topicId, archived, objectKey, version) => {
    expect(channel).toBe('scratch:setMoteArchived'); expect(workspaceId).toBe(workspace.id)
    return service.setMoteArchived(workspace, topicId as string, archived as boolean, objectKey as string, version as string)
  })
  const fact = await transport.api!.scratch.setMoteArchived(workspace.id, id, true, key, 'unwritten')
  expect(transport.invoke).toHaveBeenCalledWith('scratch:setMoteArchived', workspace.id, id, true, key, 'unwritten')
  expect((await service.read(workspace, id))?.moteArchive).toEqual(fact)
  expect(fact.state).toBe('archived')
})
it('primary abnormal archive metadata is honestly unknown while the same protected primary remains discoverable and its bytes are preserved', async () => {
  const { workspace, service } = await fixture(), directory = join(workspace.path, scratchTopicDirectoryName(PMO_TEAMS_TOPIC_ID)), file = join(directory, MOTE_STATE_PATH)
  const soul = await readFile(join(directory, 'SOUL.md'))
  for (const bytes of ['{"archived":true,"version":"00000000-0000-0000-0000-000000000000"}', 'bad-primary-json']) {
    await writeFile(file, bytes)
    const topic = (await service.read(workspace, PMO_TEAMS_TOPIC_ID))!
    expect(topic.moteArchive?.state).toBe('unknown'); expect(topic.readError).toBeUndefined()
    expect(scratchMoteTopics([topic])[0]?.id).toBe(PMO_TEAMS_TOPIC_ID)
    expect(await readFile(file, 'utf8')).toBe(bytes)
  }
  const outside = join(workspace.path, 'outside-primary-state'); await writeFile(outside, 'Original primary metadata target')
  await rm(file); await symlink(outside, file)
  expect((await service.read(workspace, PMO_TEAMS_TOPIC_ID))?.moteArchive?.state).toBe('unknown')
  expect(await readFile(outside, 'utf8')).toBe('Original primary metadata target')
  expect(await readFile(join(directory, 'SOUL.md'))).toEqual(soul)
})
