import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { ScratchTopics } from '../src/main/scratch-topics'
import { scratchMoteTopics, scratchTopicKind } from '../src/renderer/src/lib/scratch-topic-snapshots'
import { scratchWorkspaceFilePath } from '../src/shared/scratch-topics'
import type { WorkspaceRecord } from '../src/shared/contracts'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'mote-cold-read-'))); roots.push(parent)
  const workspace: WorkspaceRecord = { id: '__scratch__', name: 'Scratch', hostId: 'local', path: join(parent, 'scratch'), kind: 'folder' }
  await mkdir(workspace.path)
  return { workspace, owner: new ScratchTopics() }
}
for (const leaf of ['.agents', 'topic.md', '.agentmux/topic-wiki.md']) {
  it(`cold original owner and roster retain canonical Mote when ${leaf} is unavailable, then recover`, async () => {
    const { workspace, owner } = await fixture()
    const original = await owner.ensureMote(workspace, 'launcher:cold')
    const soul = await readFile(join(original.physicalDirectoryPath!, 'SOUL.md'), 'utf8')
    const path = join(original.physicalDirectoryPath!, leaf), held = `${path}.held`
    await rename(path, held)
    // Missing optional Wiki is supported; a non-file exercises an actual read error.
    if (leaf !== '.agents') await mkdir(path)
    const cold = new ScratchTopics(), read = await cold.read(workspace, original.id), list = await cold.list(workspace)
    expect(read).toMatchObject({ id: original.id, kind: 'mote', physicalDirectoryPath: original.physicalDirectoryPath, identityDirectoryPath: original.identityDirectoryPath, confirmedDirectoryPaths: original.confirmedDirectoryPaths })
    expect(read?.readError).toContain(leaf === '.agentmux/topic-wiki.md' ? 'Wiki' : leaf)
    expect(scratchMoteTopics(list).map(t => t.id)).toContain(original.id)
    expect(scratchTopicKind(original.id, list)).toBe('mote')
    expect(scratchWorkspaceFilePath(workspace, list, `${original.directoryPath}/outcome/result.md`)).toBe(`${original.physicalDirectoryPath}/outcome/result.md`)
    expect(await readFile(join(original.physicalDirectoryPath!, 'SOUL.md'), 'utf8')).toBe(soul)
    if (leaf !== '.agents') await rm(path, { recursive: true })
    await rename(held, path)
    expect(await new ScratchTopics().read(workspace, original.id)).toEqual(original)
  })
}
it('cold legacy Mote remains visible with failed ancillary content and archive facts intact', async () => {
  const { workspace } = await fixture(), path = join(workspace.path, 'topic--launcher--legacy')
  await mkdir(join(path, '.agentmux'), { recursive: true }); await writeFile(join(path, 'SOUL.md'), '# My saved personality')
  await writeFile(join(path, 'topic.md'), '# Original name'); await writeFile(join(path, '.agentmux/mote-state.json'), '{"archived":true,"version":"12345678-1234-1234-1234-123456789abc"}')
  const topics = await new ScratchTopics().list(workspace), mote = topics.find(t => t.id === 'launcher:legacy')!
  expect(scratchMoteTopics(topics)).toContain(mote); expect(mote.soul?.content).toBe('# My saved personality')
  expect(mote.readError).toContain('.agents'); expect(mote.title).toBe('Original name')
  expect(mote.moteArchive?.state).toBe('archived')
})
it('unconfirmed personality and invalid short identity are not promoted from a directory name', async () => {
  const { workspace, owner } = await fixture(), ordinary = await owner.ensure(workspace, 'view:ordinary')
  await symlink(join(ordinary.physicalDirectoryPath!, 'topic.md'), join(ordinary.physicalDirectoryPath!, 'SOUL.md'))
  const list = await new ScratchTopics().list(workspace)
  expect(list.find(t => t.id === ordinary.id)?.readError).toContain('SOUL.md')
  expect(scratchTopicKind(ordinary.id, list)).toBe('unknown')
  expect(scratchMoteTopics(list).map(t => t.id)).not.toContain(ordinary.id)
  const original = await owner.ensureMote(workspace, 'launcher:invalid')
  await writeFile(join(original.physicalDirectoryPath!, '.agentmux/directory-identity.json'), '{}')
  const invalid = await new ScratchTopics().list(workspace)
  expect(scratchMoteTopics(invalid).map(t => t.id)).not.toContain(original.id)
  expect(invalid.issues?.length).toBeGreaterThan(0)
})
