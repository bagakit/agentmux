import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ScratchTopics } from '../src/mote-resources.js'
import { SCRATCH_WORKSPACE_ID } from '../src/mote-topic-model.js'
import { createHostSnapshotObservation, observeClientRpcSnapshot } from '../src/snapshot-observation.js'
import { topicContentSpaceId } from '../src/topic-categories.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function hostFixture() {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'host-snapshot-'))); roots.push(parent)
  const repo = join(parent, 'repo'), scratchPath = join(parent, 'scratch')
  await Promise.all([mkdir(repo), mkdir(scratchPath)])
  const scratch = { id: SCRATCH_WORKSPACE_ID, hostId: 'local', name: 'Topics', path: scratchPath }
  const workspaces = [{ id: 'repo', hostId: 'local', name: 'Repo', path: repo, kind: 'folder' }, scratch]
  const configurationPath = join(parent, 'configuration.json')
  await writeFile(configurationPath, JSON.stringify({ workspaces, executors: {} }))
  return { configurationPath, workspaces, scratch, topics: new ScratchTopics() }
}

describe('app.snapshot over the Host configuration file and Topic owner', () => {
  it('serves the same projection the desktop GUI serves, read from the original configuration file', async () => {
    const f = await hostFixture()
    const topic = await f.topics.ensure(f.scratch, 'view:topic')
    const mote = await f.topics.ensureMote(f.scratch, 'view:mote')
    const observed = await createHostSnapshotObservation(f.configurationPath)({})
    expect(observed).toEqual(await observeClientRpcSnapshot({ workspaces: f.workspaces }, new ScratchTopics(), {}))
    expect(observed.workspaces!.map(workspace => [workspace.workspaceId, workspace.kind])).toEqual([['repo', 'folder'], [SCRATCH_WORKSPACE_ID, 'folder']])
    expect(observed.topics!.map(item => [item.id, item.kind, item.spaceId]).sort()).toEqual([
      ['view:mote', 'mote', topicContentSpaceId(f.scratch, mote)], ['view:topic', 'topic', topicContentSpaceId(f.scratch, topic)]])
    expect(observed.motes!.map(item => item.id)).toEqual(['view:mote'])
    expect(observed.unavailable).toEqual([])
  })

  it('keeps a confirmed Mote whose other files cannot be read, and names the failed read', async () => {
    const f = await hostFixture()
    const mote = await f.topics.ensureMote(f.scratch, 'view:mote')
    const topicFile = join(mote.physicalDirectoryPath!, 'topic.md')
    await rm(topicFile); await mkdir(topicFile)
    const observed = await createHostSnapshotObservation(f.configurationPath)({ include: ['motes'] })
    expect(observed.motes).toEqual([expect.objectContaining({ id: 'view:mote', kind: 'mote', readError: expect.stringContaining('topic.md: ') })])
    expect(observed.unavailable).toEqual([{ source: 'motes', code: 'TOPIC_FILESYSTEM_UNAVAILABLE',
      message: expect.stringMatching(/^view:mote: topic\.md: /), recovery: 'Read this exact Topic again after its original files are available.' }])
  })

  it('needs no configuration for sources it does not project, and does not guess them without it', async () => {
    const observe = createHostSnapshotObservation(undefined)
    expect(await observe({ include: ['agents', 'sessions'] })).toEqual({ unavailable: [] })
    await expect(observe({ include: ['topics'] })).rejects.toThrow('The original configuration metadata is unavailable.')
  })

  it('reports a Topic owner collection warning on both Topic sources instead of hiding it', async () => {
    const f = await hostFixture()
    const listed = Object.assign([], { issues: ['A damaged directory record was retained.'] })
    const observed = await observeClientRpcSnapshot({ workspaces: f.workspaces }, { list: async () => listed }, {})
    expect(observed.topics).toEqual([]); expect(observed.motes).toEqual([])
    expect(observed.unavailable).toEqual(['topics', 'motes'].map(source => ({ source, code: 'TOPIC_FILESYSTEM_UNAVAILABLE',
      message: 'A damaged directory record was retained.', recovery: 'Inspect the original directory record and retry its original repair.' })))
  })

  it('names no content Space that two Topics claim', async () => {
    const f = await hostFixture()
    const claimed = join(f.scratch.path, 'topic--claimed')
    const snapshot = (id: string, identityDirectoryPath?: string) => ({ id, directoryPath: `topic--${id}`, topicPath: `topic--${id}/topic.md`,
      title: id, summary: '', collaborators: [], ...(identityDirectoryPath ? { identityDirectoryPath } : {}) })
    const observed = await observeClientRpcSnapshot({ workspaces: f.workspaces },
      { list: async () => [snapshot('one', claimed), snapshot('two', claimed), snapshot('three')] }, { include: ['topics'] })
    expect(observed.topics!.map(topic => [topic.id, topic.spaceId])).toEqual([['one', null], ['two', null],
      ['three', topicContentSpaceId(f.scratch, snapshot('three'))]])
  })
})
