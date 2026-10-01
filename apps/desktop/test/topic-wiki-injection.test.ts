import { mkdir, mkdtemp, rm, writeFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { ScratchTopics } from '../src/main/scratch-topics.js'
import type { WorkspaceRecord } from '../src/shared/contracts.js'
import { DEFAULT_TOPIC_WIKI, SCRATCH_TOPIC_WIKI_PATH, SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

describe('Topic Wiki injection', () => {
  it('injects the current enabled Wiki with its version and omits disabled content', async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), 'agentmux-topic-wiki-injection-')))
    roots.push(parent)
    const path = join(parent, 'scratch'); await mkdir(path)
    const workspace: WorkspaceRecord = { id: SCRATCH_WORKSPACE_ID, name: 'Scratch', hostId: 'local', path, kind: 'folder' }
    const topics = new ScratchTopics()
    const topic = await topics.ensure(workspace, 'launcher:leader')
    const wikiPath = join(topic.physicalDirectoryPath!, SCRATCH_TOPIC_WIKI_PATH)
    await writeFile(wikiPath, `${DEFAULT_TOPIC_WIKI}\nUse a receipt.\n`)
    const edited = await topics.read(workspace, topic.id)
    expect(edited?.wiki?.updatedAt).toEqual(expect.any(Number))
    expect((await topics.prepareAgent(workspace, topic.id, { providerId: 'codex', sessionId: 'enabled' })).prompt).toContain('Use a receipt.')
    await topics.setWikiEnabled(workspace, topic.id, false)
    expect((await topics.prepareAgent(workspace, topic.id, { providerId: 'codex', sessionId: 'disabled' })).prompt).not.toContain('Use a receipt.')
  })
})
