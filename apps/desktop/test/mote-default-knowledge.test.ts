import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { ScratchTopics } from '../src/main/scratch-topics'
import type { WorkspaceRecord } from '../src/shared/contracts'
import {
  DEFAULT_MOTE_SOUL, DEFAULT_PMO_TEAMS_TOPIC_WIKI, DEFAULT_TOPIC_WIKI,
  MOTE_COORDINATION_ROLE, MOTE_SOUL_PATH, PMO_TEAMS_TOPIC_ID,
  SCRATCH_TOPIC_WIKI_PATH, SCRATCH_WORKSPACE_ID
} from '../src/shared/scratch-topics'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agentmux-default-knowledge-')))
  roots.push(root)
  const workspace: WorkspaceRecord = { id: SCRATCH_WORKSPACE_ID, name: 'Topics', hostId: 'local', path: root, kind: 'folder' }
  return { root, workspace, topics: new ScratchTopics() }
}

it('delivers new primary defaults and exactly one app-owned role through the actual prepare consumer', async () => {
  const h = await fixture()
  const primary = await h.topics.ensure(h.workspace, PMO_TEAMS_TOPIC_ID)
  expect(primary.soul?.content).toBe(DEFAULT_MOTE_SOUL)
  expect(primary.wiki?.content).toBe(DEFAULT_PMO_TEAMS_TOPIC_WIKI)
  const prepared = await h.topics.prepareAgent(h.workspace, primary.id, { providerId: 'codex', sessionId: 'default-primary' })
  expect(prepared.prompt.length).toBeGreaterThan(1500)
  expect(prepared.prompt).toContain('Read topic.md and the relevant durable notes before asking the user to repeat an established decision.')
  expect(prepared.prompt).toContain('Read back a saved change before saying it is remembered.')
  expect(prepared.prompt).toContain('no particular memory filename or taxonomy is required.')
  expect(prepared.prompt).toContain('do not claim to have inherited unseen conversation, running tools or another Agent\'s context.')
  expect(prepared.prompt.split(MOTE_COORDINATION_ROLE)).toHaveLength(2)
  expect(prepared.absolutePath).toBe(join(h.root, primary.directoryPath))
  expect(await readFile(join(h.root, primary.directoryPath, MOTE_SOUL_PATH), 'utf8')).toBe(DEFAULT_MOTE_SOUL)
})

it('keeps custom Mote Topic Wiki and ordinary Topic defaults on their original owners', async () => {
  const h = await fixture()
  const custom = await h.topics.ensureMote(h.workspace, 'launcher:default-custom')
  const plain = await h.topics.ensure(h.workspace, 'launcher:ordinary-context')
  expect(custom.soul?.content).toBe(DEFAULT_MOTE_SOUL)
  expect(custom.wiki?.content).toBe(DEFAULT_TOPIC_WIKI)
  expect(plain.soul).toBeUndefined()
  expect(plain.wiki?.content).toBe(DEFAULT_TOPIC_WIKI)
  await h.topics.setWikiEnabled(h.workspace, custom.id, false)
  const prepared = await h.topics.prepareAgent(h.workspace, custom.id, { providerId: 'codex', sessionId: 'disabled-wiki' })
  expect(prepared.prompt).toContain(DEFAULT_MOTE_SOUL)
  expect(prepared.prompt.split(MOTE_COORDINATION_ROLE)).toHaveLength(2)
  expect(prepared.prompt).toContain('Topic Wiki injection is disabled')
  const ordinary = await h.topics.prepareAgent(h.workspace, plain.id, { providerId: 'codex', sessionId: 'ordinary' })
  expect(ordinary.prompt.length).toBeGreaterThan(200)
  expect(ordinary.prompt).not.toContain(DEFAULT_MOTE_SOUL)
  expect(ordinary.prompt).not.toContain(MOTE_COORDINATION_ROLE)
})

it('preserves both edited homes and intentionally repeated user Wiki byte-for-byte after owner recreation', async () => {
  const h = await fixture()
  const ids = [PMO_TEAMS_TOPIC_ID, 'launcher:existing-custom']
  const retained: Array<{ id: string; soul: string; wiki: string; directory: string; result: string }> = []
  for (const id of ids) {
    const mote = await h.topics.ensureMote(h.workspace, id)
    const directory = join(h.root, mote.directoryPath)
    const soul = '# SOUL\n\nUser personality for ' + id + '.\n'
    const wiki = '# User Guide\n\n' + MOTE_COORDINATION_ROLE + '\n\nKeep my local receipt.\n'
    const result = 'User result and original source ' + id + '\n'
    await writeFile(join(directory, MOTE_SOUL_PATH), soul)
    await writeFile(join(directory, SCRATCH_TOPIC_WIKI_PATH), wiki)
    await writeFile(join(directory, 'outcome', 'retained.md'), result)
    retained.push({ id, soul, wiki, directory, result })
  }
  expect(retained).toHaveLength(2)
  const reopened = new ScratchTopics()
  for (const old of retained) {
    const snapshot = await reopened.ensureMote(h.workspace, old.id)
    expect(snapshot.soul?.content).toBe(old.soul)
    expect(snapshot.wiki?.content).toBe(old.wiki)
    expect(await readFile(join(old.directory, MOTE_SOUL_PATH), 'utf8')).toBe(old.soul)
    expect(await readFile(join(old.directory, SCRATCH_TOPIC_WIKI_PATH), 'utf8')).toBe(old.wiki)
    expect(await readFile(join(old.directory, 'outcome', 'retained.md'), 'utf8')).toBe(old.result)
    const prepared = await reopened.prepareAgent(h.workspace, old.id, { providerId: 'codex', sessionId: 'retained-' + old.id.split(':')[1] })
    expect(prepared.prompt).toContain(old.soul)
    expect(prepared.prompt).toContain(old.wiki)
    // User-authored repeats are preserved rather than silently cleaned.
    expect(prepared.prompt.split(MOTE_COORDINATION_ROLE)).toHaveLength(3)
  }
})

it('changes the primary Wiki only on explicit reset and keeps saved personality and custom defaults', async () => {
  const h = await fixture()
  const primary = await h.topics.ensureMote(h.workspace, PMO_TEAMS_TOPIC_ID)
  const directory = join(h.root, primary.directoryPath)
  const savedSoul = '# SOUL\n\nRetain this user personality.\n'
  const savedWiki = '# User Wiki\n\nKeep it until I explicitly reset.\n'
  await writeFile(join(directory, MOTE_SOUL_PATH), savedSoul)
  await writeFile(join(directory, SCRATCH_TOPIC_WIKI_PATH), savedWiki)
  expect((await h.topics.ensure(h.workspace, primary.id)).wiki?.content).toBe(savedWiki)
  const reset = await h.topics.resetWiki(h.workspace, primary.id)
  expect(reset.wiki).toMatchObject({ content: DEFAULT_PMO_TEAMS_TOPIC_WIKI, source: 'default', enabled: true })
  expect(reset.soul?.content).toBe(savedSoul)
  const prepared = await h.topics.prepareAgent(h.workspace, primary.id, { providerId: 'codex', sessionId: 'reset-primary' })
  expect(prepared.prompt.split(MOTE_COORDINATION_ROLE)).toHaveLength(2)
  expect(prepared.prompt).toContain(savedSoul)
  const custom = await h.topics.ensureMote(h.workspace, 'launcher:reset-custom')
  expect((await h.topics.resetWiki(h.workspace, custom.id)).wiki?.content).toBe(DEFAULT_TOPIC_WIKI)
})
