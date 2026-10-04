import { fixturePath as _hygiene_fixturePath, fixtureTime as _hygiene_fixtureTime } from "../scripts/lib/fixture-values.mjs"
import { mkdir, mkdtemp, readFile, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppConfig } from '../src/shared/contracts.js'
import { SCRATCH_WORKSPACE_ID, MOTE_SOUL_PATH, SCRATCH_TOPIC_WIKI_PATH } from '../src/shared/scratch-topics.js'
import { directoryIdentity } from '../src/shared/space-addresses.js'
import { moteDirectoryName } from '../src/main/scratch-directory-identity.mjs'
import { ScratchTopics } from '../src/main/scratch-topics.js'
import { SCRATCH_DIRECTORY_IDENTITY_PATH } from '../src/main/scratch-topic-directories.js'
import { observeClientRpcSnapshot } from '../src/main/rpc-client-observations.js'
import { parseRpcNativeResult } from '../../../packages/core/src/rpc-native-codec.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'rpc-topics-'))); roots.push(parent)
  const root = join(parent, 'scratch'); await mkdir(root)
  const config = { workspaces: [
    { id: 'repo', hostId: 'local', name: 'Repo', path: _hygiene_fixturePath("repo"), kind: 'folder' },
    { id: 'branch', hostId: 'local', name: 'Branch', path: _hygiene_fixturePath("repo/work/one"), repoPath: _hygiene_fixturePath("repo"), branch: 'one', kind: 'worktree' },
    { id: SCRATCH_WORKSPACE_ID, hostId: 'local', name: 'Topics', path: root, kind: 'folder' }
  ] } as AppConfig
  return { parent, root, config, owner: new ScratchTopics() }
}

describe('public RPC client metadata from its original filesystem and config owners', () => {
  it('reads actual independent Topic/Mote files and raw user SOUL/Wiki without writing them', async () => {
    const { config, owner, parent } = await fixture()
    const workspace = config.workspaces[2]!
    const topic = await owner.ensure(workspace, 'view:topic')
    const mote = await owner.ensureMote(workspace, 'view:mote')
    const motePath = join(parent, 'motes', moteDirectoryName(mote.id))
    const topicPath = join(parent, 'topics', topic.directoryPath)
    expect(mote.physicalDirectoryPath).toBe(motePath)
    expect(topic.physicalDirectoryPath).toBe(topicPath)
    const soulPath = join(motePath, MOTE_SOUL_PATH)
    const wikiPath = join(motePath, SCRATCH_TOPIC_WIKI_PATH)
    await writeFile(soulPath, '# My identity\nKeep my personality.\n')
    await writeFile(wikiPath, '# My guide\nKeep my process.\n')
    const wikiTimeSeconds = Math.floor(_hygiene_fixtureTime() / 1000) + 0.1255
    await utimes(wikiPath, wikiTimeSeconds, wikiTimeSeconds)
    const wikiUpdatedAt = (await stat(wikiPath)).mtimeMs
    expect(Number.isInteger(wikiUpdatedAt)).toBe(false)
    const before = await Promise.all([readFile(soulPath), readFile(wikiPath)])
    const listed = vi.spyOn(owner, 'list'), ensure = vi.spyOn(owner, 'ensure'), ensureMote = vi.spyOn(owner, 'ensureMote')
    const observed = await observeClientRpcSnapshot(config, owner, {})
    expect(observed.topics).toHaveLength(2); expect(observed.motes).toHaveLength(1)
    expect(observed.motes![0]).toMatchObject({ id: 'view:mote', topicId: 'view:mote', workspaceId: SCRATCH_WORKSPACE_ID,
      kind: 'mote', path: motePath, spaceId: directoryIdentity('local', motePath), directoryPath: mote.directoryPath,
      topicPath: mote.topicPath, soul: { content: before[0]!.toString() }, wiki: { content: before[1]!.toString(), source: 'user' } })
    expect(observed.topics!.find(item => item.id === topic.id)).toMatchObject({ kind: 'topic', path: topicPath,
      spaceId: directoryIdentity('local', topicPath), directoryPath: topic.directoryPath, topicPath: topic.topicPath })
    expect(observed.workspaces).toHaveLength(3)
    expect(observed.unavailable).toEqual([])
    const snapshot = { projects: [], executors: [], agents: [], sessions: [], goals: [], decisions: [], activity: [],
      spaces: [], zones: [], ...observed }
    expect(() => parseRpcNativeResult('app.snapshot', snapshot, {})).not.toThrow()
    const decoded = parseRpcNativeResult('app.snapshot', snapshot, {})
    expect(decoded).toEqual(snapshot)
    expect(observed.motes![0]!.wiki!.updatedAt).toBe(wikiUpdatedAt)
    expect(await Promise.all([readFile(soulPath), readFile(wikiPath)])).toEqual(before)
    expect(listed).toHaveBeenCalledTimes(1); expect(ensure).not.toHaveBeenCalled(); expect(ensureMote).not.toHaveBeenCalled()
  })

  it('projects relocated Mote files through the strict codec while retaining their original Space and logical references', async () => {
    const { config, owner, parent, root } = await fixture()
    const workspace = config.workspaces[2]!
    const mote = await owner.ensureMote(workspace, 'view:retained')
    const physicalPath = join(parent, 'motes', moteDirectoryName(mote.id))
    const identityPath = join(root, mote.directoryPath)
    const identityRecord = join(physicalPath, SCRATCH_DIRECTORY_IDENTITY_PATH)
    await mkdir(join(physicalPath, '.agentmux'), { recursive: true })
    await writeFile(identityRecord, JSON.stringify({ version: 1, identityDirectoryPath: identityPath }))
    const soulPath = join(physicalPath, MOTE_SOUL_PATH), wikiPath = join(physicalPath, SCRATCH_TOPIC_WIKI_PATH)
    await writeFile(soulPath, '# Original personality\nKeep my exact instructions.\n')
    await writeFile(wikiPath, '# Original guide\nKeep my exact notes.\n')
    const before = await Promise.all([readFile(identityRecord), readFile(soulPath), readFile(wikiPath)])
    const listed = vi.spyOn(owner, 'list'), ensure = vi.spyOn(owner, 'ensure'), ensureMote = vi.spyOn(owner, 'ensureMote')
    const observed = await observeClientRpcSnapshot(config, owner, { topicId: mote.id })
    expect(observed.topics).toHaveLength(1); expect(observed.motes).toHaveLength(1)
    expect(listed.mock.results).toHaveLength(1)
    const originals = await listed.mock.results[0]!.value
    expect(originals).toHaveLength(1)
    expect(originals[0]).toMatchObject({ id: mote.id, identityDirectoryPath: identityPath, physicalDirectoryPath: physicalPath })
    expect(observed.motes![0]).toMatchObject({ id: mote.id, topicId: mote.id, path: physicalPath,
      spaceId: directoryIdentity('local', identityPath), directoryPath: mote.directoryPath, topicPath: mote.topicPath,
      soul: { path: mote.soul!.path, content: before[1]!.toString() },
      wiki: { path: mote.wiki!.path, content: before[2]!.toString() }, moteArchive: mote.moteArchive })
    const snapshot = { projects: [], executors: [], agents: [], sessions: [], goals: [], decisions: [], activity: [],
      spaces: [], zones: [], ...observed }
    expect(() => parseRpcNativeResult('app.snapshot', snapshot, {})).not.toThrow()
    expect(parseRpcNativeResult('app.snapshot', snapshot, {})).toEqual(snapshot)
    expect(observed.motes![0]).not.toHaveProperty('physicalDirectoryPath')
    expect(observed.motes![0]).not.toHaveProperty('identityDirectoryPath')
    expect(await Promise.all([readFile(identityRecord), readFile(soulPath), readFile(wikiPath)])).toEqual(before)
    expect(ensure).not.toHaveBeenCalled(); expect(ensureMote).not.toHaveBeenCalled()
  })

  it('uses exact resource Project and Workspace filters without deriving a Topic membership', async () => {
    const { config, owner } = await fixture()
    const list = vi.spyOn(owner, 'list')
    const project = await observeClientRpcSnapshot(config, owner, { projectId: directoryIdentity('local', _hygiene_fixturePath("repo")) })
    expect(project.workspaces!.map(item => (item as { workspaceId: string }).workspaceId)).toEqual(['repo', 'branch'])
    expect(project.topics).toEqual([]); expect(project.motes).toEqual([])
    const workspace = await observeClientRpcSnapshot(config, owner, { include: ['workspaces'], workspaceId: 'branch' })
    expect(workspace.workspaces).toEqual([{ workspaceId: 'branch', hostId: 'local', name: 'Branch', projectId: directoryIdentity('local', _hygiene_fixturePath("repo")),
      path: _hygiene_fixturePath("repo/work/one"), kind: 'worktree', repoPath: _hygiene_fixturePath("repo"), branch: 'one' }])
    expect(list).not.toHaveBeenCalled()
  })

  it('reports a missing Topics owner as unknown while preserving configured Project resources', async () => {
    const { config, owner } = await fixture()
    config.workspaces = config.workspaces.filter(workspace => workspace.id !== SCRATCH_WORKSPACE_ID)
    const list = vi.spyOn(owner, 'list')
    const observed = await observeClientRpcSnapshot(config, owner, {})
    expect(observed.workspaces).toHaveLength(2)
    expect(observed.topics).toBeUndefined(); expect(observed.motes).toBeUndefined()
    expect(observed.unavailable).toEqual(['topics', 'motes'].map(source => ({ source, code: 'TOPIC_WORKSPACE_UNAVAILABLE',
      message: 'The original Topics filesystem Workspace is not configured.', recovery: 'Configure the original Topics Workspace, then read this source again.' })))
    expect(list).not.toHaveBeenCalled()
  })

  it('reports a failed filesystem source while preserving nonempty config observations', async () => {
    const { config } = await fixture()
    const observed = await observeClientRpcSnapshot(config, { list: async () => { throw new Error('Original files are unreadable.') } }, {})
    expect(observed.workspaces).toHaveLength(3)
    expect(observed.topics).toBeUndefined(); expect(observed.motes).toBeUndefined()
    expect(observed.unavailable).toEqual(['topics', 'motes'].map(source => ({ source, code: 'TOPIC_FILESYSTEM_UNAVAILABLE',
      message: 'Original files are unreadable.', recovery: 'Restore the original Topics filesystem owner, then read this source again.' })))
  })

  it('keeps an unreadable Topic explicit and never turns its unknown kind into a known Mote absence', async () => {
    const { config } = await fixture()
    const observed = await observeClientRpcSnapshot(config, { list: async () => [{ id: 'view:broken', directoryPath: 'topic--view--broken',
      topicPath: 'topic--view--broken/topic.md', title: 'Broken', summary: '', collaborators: [], readError: 'Cannot read files.' }] }, { include: ['motes'] })
    expect(observed.motes).toEqual([])
    expect(observed.unavailable).toEqual([{ source: 'motes', code: 'TOPIC_FILESYSTEM_UNAVAILABLE', message: 'view:broken: Cannot read files.',
      recovery: 'Read this exact Topic again after its original files are available.' }])
  })
})
