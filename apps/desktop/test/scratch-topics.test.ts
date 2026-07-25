import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkspaceRecord } from '../src/shared/contracts.js'
import { ScratchTopics } from '../src/main/scratch-topics.js'
import {
  SCRATCH_WORKSPACE_ID,
  scratchTopicDirectoryName,
  scratchTopicIdFromWorkspacePath,
  workspaceOwnsSessionPath
} from '../src/shared/scratch-topics.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })))
})

async function scratchWorkspace(): Promise<WorkspaceRecord> {
  const path = await mkdtemp(join(tmpdir(), 'agentmux-scratch-topic-'))
  roots.push(path)
  return { id: SCRATCH_WORKSPACE_ID, name: 'Scratch', hostId: 'local', path, kind: 'folder' }
}

describe('filesystem-backed Scratch Topics', () => {
  it('creates one idempotent wiki scaffold for a stable View identity', async () => {
    const workspace = await scratchWorkspace()
    const topics = new ScratchTopics()
    const topicId = 'view:wiki-view'

    const first = await topics.ensure(workspace, topicId)
    const second = await topics.ensure(workspace, topicId)

    expect(second).toEqual(first)
    expect(first).toMatchObject({
      id: topicId,
      directoryPath: 'topic--view--wiki-view',
      topicPath: 'topic--view--wiki-view/topic.md',
      title: 'Untitled Topic'
    })
    expect(await readdir(join(workspace.path, first.directoryPath))).toEqual(
      expect.arrayContaining(['.agents', 'outcome', 'refs', 'topic.md'])
    )
  })

  it('lists every Topic directory from the Scratch filesystem without a View binding', async () => {
    const workspace = await scratchWorkspace()
    const topics = new ScratchTopics()
    await topics.ensure(workspace, 'view:zeta')
    await topics.ensure(workspace, 'launcher:alpha')
    await mkdir(join(workspace.path, 'ordinary-directory'))

    const listed = await topics.list(workspace)

    expect(listed.map((topic) => topic.id)).toEqual(['launcher:alpha', 'view:zeta'])
    expect(listed.map((topic) => topic.directoryPath)).toEqual([
      'topic--launcher--alpha',
      'topic--view--zeta'
    ])
  })

  it('renames only the human title while preserving Topic identity, content, and collaborators', async () => {
    const workspace = await scratchWorkspace()
    const topics = new ScratchTopics()
    const topicId = 'view:stable-owner'
    const prepared = await topics.prepareAgent(workspace, topicId, {
      providerId: 'codex',
      sessionId: 'agent-one'
    })
    const beforeDirectory = prepared.snapshot.directoryPath
    const topicPath = join(workspace.path, prepared.snapshot.topicPath)
    await writeFile(topicPath, '# Before\n\nKeep this summary.\n\n## Context\n\nDurable body.\n')

    const renamed = await topics.renameTitle(workspace, topicId, '  Shared outcome  ')

    expect(renamed).toMatchObject({
      id: topicId,
      directoryPath: beforeDirectory,
      title: 'Shared outcome',
      summary: 'Keep this summary.'
    })
    expect(renamed.collaborators).toEqual([expect.objectContaining({ sessionId: 'agent-one' })])
    expect(await readFile(topicPath, 'utf8')).toBe(
      '# Shared outcome\n\nKeep this summary.\n\n## Context\n\nDurable body.\n'
    )
    expect(await readdir(workspace.path)).toEqual([beforeDirectory])
  })

  it('adds a missing title and rejects invalid titles without changing topic.md', async () => {
    const workspace = await scratchWorkspace()
    const topics = new ScratchTopics()
    const topic = await topics.ensure(workspace, 'launcher:title-validation')
    const topicPath = join(workspace.path, topic.topicPath)
    await writeFile(topicPath, 'Preserve this body.\n')

    await expect(topics.renameTitle(workspace, topic.id, '')).rejects.toThrow('cannot be empty')
    await expect(topics.renameTitle(workspace, topic.id, 'two\nlines')).rejects.toThrow('one line')
    await expect(topics.renameTitle(workspace, topic.id, 'x'.repeat(121))).rejects.toThrow('120 characters')
    expect(await readFile(topicPath, 'utf8')).toBe('Preserve this body.\n')

    await expect(topics.renameTitle(workspace, topic.id, 'Added title')).resolves.toMatchObject({
      id: topic.id,
      title: 'Added title',
      summary: 'Preserve this body.'
    })
    expect(await readFile(topicPath, 'utf8')).toBe('# Added title\n\nPreserve this body.\n')
  })

  it('writes one collaborator identity and supplies the Agent launch context', async () => {
    const workspace = await scratchWorkspace()
    const topics = new ScratchTopics()

    const prepared = await topics.prepareAgent(workspace, 'launcher:topic-owner', {
      providerId: 'codex',
      sessionId: 'agent-one'
    })

    expect(prepared.absolutePath).toBe(join(await realpath(workspace.path), 'topic--launcher--topic-owner'))
    expect(prepared.prompt).toContain('Read topic.md')
    expect(prepared.prompt).toContain('Inspect .agents/')
    expect(prepared.snapshot.collaborators).toEqual([expect.objectContaining({
      providerId: 'codex',
      sessionId: 'agent-one'
    })])
    expect(await readFile(prepared.identityPath, 'utf8')).toContain('shared short memory')
  })

  it('derives Scratch ownership only from a valid direct Topic directory', async () => {
    const workspace = await scratchWorkspace()
    const topicId = 'session:agent-one'
    const topicPath = join(workspace.path, scratchTopicDirectoryName(topicId))

    expect(scratchTopicIdFromWorkspacePath(workspace.path, topicPath)).toBe(topicId)
    expect(workspaceOwnsSessionPath(workspace, {
      hostId: 'local',
      workspacePath: topicPath
    })).toBe(true)
    expect(workspaceOwnsSessionPath(workspace, {
      hostId: 'local',
      workspacePath: join(workspace.path, 'unrelated')
    })).toBe(false)
  })

  it('rejects Topic operations outside the local Scratch workspace', async () => {
    const workspace = await scratchWorkspace()
    const topics = new ScratchTopics()

    await expect(topics.ensure({ ...workspace, id: 'project' }, 'view:one')).rejects.toThrow(
      'only in the local Scratch workspace'
    )
    await expect(topics.ensure(workspace, '../escape')).rejects.toThrow('Invalid Scratch Topic identity')
  })
})
