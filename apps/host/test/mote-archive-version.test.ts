import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ScratchTopics } from '../src/mote-resources'
import { directoryIdentity } from '../src/mote-model'
import { MOTE_STATE_PATH, SCRATCH_WORKSPACE_ID } from '../src/mote-topic-model'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function mote() {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'agentmux-mote-archive-'))); roots.push(home)
  const path = join(home, '.agentmux/scratch'); await mkdir(path, { recursive: true })
  const workspace = { id: SCRATCH_WORKSPACE_ID, hostId: 'local', path }, topics = new ScratchTopics()
  const created = await topics.ensureMote(workspace, 'view:archive')
  return { workspace, topics, created, key: directoryIdentity('local', created.identityDirectoryPath!) }
}

it('archives and restores a Mote with the revision each write returns', async () => {
  const { workspace, topics, created, key } = await mote()
  const archived = await topics.setMoteArchived(workspace, created.id, true, key, 'unwritten')
  expect(archived.state).toBe('archived')
  const restored = await topics.setMoteArchived(workspace, created.id, false, key, archived.version)
  expect(restored.state).toBe('active')
  expect((await topics.read(workspace, created.id))!.moteArchive).toEqual(restored)
})

it('keeps reading an archive state saved with an earlier revision format', async () => {
  const { workspace, topics, created, key } = await mote()
  const saved = '0b6f4a3e-2c1d-4e5f-8a9b-0c1d2e3f4a5b'
  await mkdir(join(created.physicalDirectoryPath!, '.agentmux'), { recursive: true })
  await writeFile(join(created.physicalDirectoryPath!, MOTE_STATE_PATH), JSON.stringify({ archived: true, version: saved }) + '\n')
  expect((await topics.read(workspace, created.id))!.moteArchive).toEqual({ state: 'archived', version: saved })
  expect((await topics.setMoteArchived(workspace, created.id, false, key, saved)).state).toBe('active')
})
