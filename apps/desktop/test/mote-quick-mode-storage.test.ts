import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ nativeImage: { createFromBuffer: () => { throw Error('Avatar decoding is outside this file read test') } } }))
import { ScratchTopics } from '../src/main/scratch-topics'
import { SCRATCH_WORKSPACE_ID, PMO_TEAMS_TOPIC_ID } from '../src/shared/scratch-topics'
import { serializeMoteQuickMode } from '../src/shared/mote-quick-mode'
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function originalMote() {
  const root = await realpath(await mkdtemp(_hygiene_fixturePath("tmp/amx-quick-storage-"))); roots.push(root)
  await mkdir(join(root,'scratch'))
  const workspace = { id: SCRATCH_WORKSPACE_ID, hostId: 'local', path: join(root,'scratch'), name: 'Motes', kind: 'folder' as const }, owner = new ScratchTopics()
  const mote = await owner.ensureMote(workspace, PMO_TEAMS_TOPIC_ID)
  return { root, workspace, owner, mote, path: join(mote.physicalDirectoryPath!, 'MOTE.md') }
}
it('reads preferences on existing Main Motes without a migration or any source write', async () => {
  const f = await originalMote(), defaults = { executorId: 'executor-id', conversation: { hostId: 'host', sessionId: 'original-core-id', displayWorkspaceId: 'display', groupId: 'group', tabId: 'tab', regionId: 'region' } }
  const source = serializeMoteQuickMode('', defaults) + '# Original additions\nKeep these words.\n'
  const before = await readFile(join(f.mote.physicalDirectoryPath!, 'SOUL.md'), 'utf8')
  await writeFile(f.path,source)
  const names = await readdir(f.mote.physicalDirectoryPath!)
  const listed = await f.owner.list(f.workspace), read = await f.owner.read(f.workspace,PMO_TEAMS_TOPIC_ID)
  expect(read?.quickMode).toMatchObject({ status:'saved', defaults }); expect(listed.find(topic=>topic.id===PMO_TEAMS_TOPIC_ID)?.quickMode).toEqual(read?.quickMode)
  expect(read?.directoryPath).toBe(f.mote.directoryPath); expect(await readFile(f.path,'utf8')).toBe(source)
  expect(await readFile(join(f.mote.physicalDirectoryPath!,'SOUL.md'),'utf8')).toBe(before); expect(await readdir(f.mote.physicalDirectoryPath!)).toEqual(names)
})
it('retains a Mote identity and files when quick configuration is missing, oversized, invalid or a link', async () => {
  const f = await originalMote()
  expect((await f.owner.read(f.workspace,PMO_TEAMS_TOPIC_ID))?.quickMode).toEqual({ status:'missing' })
  for (const source of ['---\nversion: 2\n---\nOriginal content', 'x'.repeat(65537)]) {
    await writeFile(f.path,source); const read = await f.owner.read(f.workspace,PMO_TEAMS_TOPIC_ID)
    expect(read?.quickMode?.status).toBe('unconfirmed'); expect(read?.id).toBe(f.mote.id); expect(await readFile(f.path,'utf8')).toBe(source)
  }
  await rm(f.path); await writeFile(join(f.root,'outside.md'),'Keep this external file.'); await symlink(join(f.root,'outside.md'),f.path)
  const read = await f.owner.read(f.workspace,PMO_TEAMS_TOPIC_ID)
  expect(read?.quickMode?.status).toBe('unconfirmed'); expect(read?.id).toBe(f.mote.id); expect(await readFile(join(f.root,'outside.md'),'utf8')).toBe('Keep this external file.')
})
