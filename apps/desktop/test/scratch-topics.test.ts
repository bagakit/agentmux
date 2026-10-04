import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceRecord } from '../src/shared/contracts.js'
import { DEFAULT_MOTE_BEHAVIOR, MOTE_BEHAVIOR_PATH, serializeMoteBehaviorDocument } from '../src/shared/mote-behavior.js'
import { ScratchTopics } from '../src/main/scratch-topics.js'
import {
  DEFAULT_TOPIC_WIKI,
  SCRATCH_TOPIC_WIKI_PATH,
  SCRATCH_TOPIC_WIKI_STATE_PATH,
  SCRATCH_WORKSPACE_ID,
  scratchTopicDirectoryName,
  scratchTopicIdFromWorkspacePath,
  workspaceOwnsSessionPath
} from '../src/shared/scratch-topics.js'

const fault = vi.hoisted(() => ({ withheld: false }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, open: vi.fn(async (...args: Parameters<typeof actual.open>) => {
    if (fault.withheld && String(args[0]).endsWith('/BEHAVIOR.md')) {
      fault.withheld = false
      throw Object.assign(new Error('Controlled initial file admission failure'), { code: 'EACCES' })
    }
    return actual.open(...args)
  }) }
})
const roots: string[] = []

afterEach(async () => {
  fault.withheld = false
  await Promise.all(roots.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })))
})

async function scratchWorkspace(): Promise<WorkspaceRecord> {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'agentmux-scratch-topic-')))
  roots.push(parent)
  const path = join(parent, 'scratch'); await mkdir(path)
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
      physicalDirectoryPath: join(await realpath(dirname(workspace.path)), 'topics', 'topic--view--wiki-view'),
      title: 'Untitled Topic'
    })
    expect(await readdir(first.physicalDirectoryPath!)).toEqual(
      expect.arrayContaining(['.agents', '.agentmux', 'outcome', 'refs', 'topic.md'])
    )
  })

  it('persists Wiki version, updatedAt, enabled state, and reset semantics', async () => {
    const workspace = await scratchWorkspace()
    const topics = new ScratchTopics()
    const topic = await topics.ensure(workspace, 'view:wiki-state')
    const wikiPath = join(topic.physicalDirectoryPath!, SCRATCH_TOPIC_WIKI_PATH)
    const statePath = join(topic.physicalDirectoryPath!, SCRATCH_TOPIC_WIKI_STATE_PATH)
    await writeFile(wikiPath, `${DEFAULT_TOPIC_WIKI}\nUser rule: keep receipts.\n`)

    const edited = await topics.read(workspace, topic.id)
    expect(edited?.wiki).toMatchObject({ source: 'user', enabled: true })
    expect(edited?.wiki?.updatedAt).toEqual(expect.any(Number))
    expect(edited?.wiki?.version).not.toBe(topic.wiki?.version)

    const disabled = await topics.setWikiEnabled(workspace, topic.id, false)
    expect(disabled.wiki?.enabled).toBe(false)
    expect(await readFile(statePath, 'utf8')).toContain('false')
    const preparedDisabled = await topics.prepareAgent(workspace, topic.id, { providerId: 'codex', sessionId: 'disabled' })
    expect(preparedDisabled.prompt).toContain('Topic Wiki injection is disabled')
    expect(preparedDisabled.prompt).not.toContain('User rule: keep receipts.')

    const reset = await topics.resetWiki(workspace, topic.id)
    expect(reset.wiki).toMatchObject({ source: 'default', enabled: true, content: DEFAULT_TOPIC_WIKI })
    const preparedReset = await topics.prepareAgent(workspace, topic.id, { providerId: 'codex', sessionId: 'reset' })
    expect(preparedReset.prompt).toContain(`Topic Wiki injection (version ${reset.wiki?.version}`)
    expect(preparedReset.prompt).toContain('High-risk or ambiguous writes require user confirmation.')
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
    const topicPath = join(prepared.snapshot.physicalDirectoryPath!, 'topic.md')
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
    expect(await readdir(dirname(renamed.physicalDirectoryPath!))).toEqual([beforeDirectory])
    expect(await readdir(workspace.path)).toEqual([])
  })

  it('adds a missing title and rejects invalid titles without changing topic.md', async () => {
    const workspace = await scratchWorkspace()
    const topics = new ScratchTopics()
    const topic = await topics.ensure(workspace, 'launcher:title-validation')
    const topicPath = join(topic.physicalDirectoryPath!, 'topic.md')
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

    expect(prepared.absolutePath).toBe(join(await realpath(dirname(workspace.path)), 'topics', 'topic--launcher--topic-owner'))
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

it('creates original behavior defaults once and reads custom Mote behavior into each new Session preparation', async () => {
  const workspace = await scratchWorkspace(), owner = new ScratchTopics()
  const mote = await owner.ensureMote(workspace, 'launcher:behavior-original')
  const file = join(mote.physicalDirectoryPath!, MOTE_BEHAVIOR_PATH)
  expect(await readFile(file, 'utf8')).toBe(DEFAULT_MOTE_BEHAVIOR)
  expect(mote.soul?.content).toContain('[BEHAVIOR.md](./BEHAVIOR.md)')
  const saved = serializeMoteBehaviorDocument(DEFAULT_MOTE_BEHAVIOR, { engagement: 'I', information: 'N', decisions: 'T', approach: 'P', custom: '## Project habits\nKeep my original examples.\n' })
  await writeFile(file, saved)
  const first = await owner.prepareAgent(workspace, mote.id, { providerId: 'codex', sessionId: 'behavior-a' })
  expect(first.prompt).toContain('Saved behavior from BEHAVIOR.md (version ')
  expect(first.prompt).toContain('MBTI style: INTP'); expect(first.prompt).toContain('Keep my original examples.')
  await writeFile(file, saved.replace('version: 1', 'version: 2'))
  const second = await owner.prepareAgent(workspace, mote.id, { providerId: 'codex', sessionId: 'behavior-b' })
  expect(second.prompt).toContain('BEHAVIOR.md is unconfirmed'); expect(second.prompt).not.toContain('MBTI style: INTP')
  expect(first.prompt).toContain('MBTI style: INTP'); expect(second.absolutePath).toBe(first.absolutePath)
  expect((await owner.read(workspace, mote.id))?.id).toBe(mote.id)
})

it('retries the same owner observed partial Mote behavior scaffold without rewriting original files', async () => {
  const workspace = await scratchWorkspace(), owner = new ScratchTopics()
  fault.withheld = true
  await expect(owner.ensureMote(workspace, 'launcher:behavior-retry')).rejects.toThrow('Controlled initial file admission failure')
  const retained = await owner.read(workspace, 'launcher:behavior-retry')
  expect(retained?.kind).toBe('mote')
  expect(retained?.soul?.content).toContain('[BEHAVIOR.md](./BEHAVIOR.md)')
  const resumed = await owner.ensureMote(workspace, 'launcher:behavior-retry')
  expect(resumed.id).toBe(retained!.id)
  expect(await readFile(join(resumed.physicalDirectoryPath!, 'BEHAVIOR.md'), 'utf8')).toBe(DEFAULT_MOTE_BEHAVIOR)
  expect(resumed.soul).toEqual(retained!.soul)
})
