import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ScratchTopics } from '../src/main/scratch-topics'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { SCRATCH_WORKSPACE_ID, PMO_TEAMS_TOPIC_ID, scratchTopicDirectoryName } from '../src/shared/scratch-topics'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), 'mote-primary-')); roots.push(parent)
  const path = join(parent, 'topics'); await mkdir(path)
  const workspace = { id: SCRATCH_WORKSPACE_ID, hostId: 'local', path, name: 'Space', kind: 'folder' as const }
  const host = { id: 'local', kind: 'local' as const }
  const topics = new ScratchTopics(), files = new WorkspaceFiles(() => host as never, { primaryMoteWorkspace: async () => workspace })
  return { parent, workspace, topics, files, directory: scratchTopicDirectoryName(PMO_TEAMS_TOPIC_ID) }
}
it('uses the real idempotent primary owner and preserves nonempty SOUL, Wiki, avatars and user data on repeated ensure', async () => {
  const { workspace, topics, directory } = await fixture()
  const first = await topics.ensureMote(workspace, PMO_TEAMS_TOPIC_ID)
  expect(first.id).toBe(PMO_TEAMS_TOPIC_ID); expect(first.soul?.content.length).toBeGreaterThan(0)
  const data = { 'SOUL.md': 'My personality', '.agentmux/wiki.md': 'Original instructions', 'user.txt': 'Keep this file', '.agentmux/avatar-user.png': 'Original avatar' }
  for (const [name, bytes] of Object.entries(data)) await writeFile(join(workspace.path, directory, name), bytes)
  await topics.ensureMote(workspace, PMO_TEAMS_TOPIC_ID)
  const retained = await Promise.all(Object.keys(data).map(name => readFile(join(workspace.path, directory, name), 'utf8')))
  expect(retained).toEqual(Object.values(data))
})
it('final real delete protects the primary root and ancestor through parent and symlink workspace spellings', async () => {
  const { parent, workspace, topics, files, directory } = await fixture()
  await topics.ensureMote(workspace, PMO_TEAMS_TOPIC_ID)
  const retained = await readFile(join(workspace.path, directory, 'SOUL.md'))
  await expect(files.delete(workspace, directory)).rejects.toMatchObject({ code: 'PRIMARY_MOTE_PROTECTED' })
  const outer = { ...workspace, id: 'registered-parent', path: parent }
  await expect(files.delete(outer, 'topics')).rejects.toMatchObject({ code: 'PRIMARY_MOTE_PROTECTED' })
  await symlink(workspace.path, join(parent, 'alias'))
  const alias = { ...workspace, id: 'other-alias', path: join(parent, 'alias') }
  await expect(files.delete(alias, directory)).rejects.toMatchObject({ code: 'PRIMARY_MOTE_PROTECTED' })
  expect(await readFile(join(workspace.path, directory, 'SOUL.md'))).toEqual(retained)
})
it('move refuses a protected source, ancestor and destination before the old atomic helper, with explicit primary reason', async () => {
  const { parent, workspace, topics, files, directory } = await fixture()
  await topics.ensureMote(workspace, PMO_TEAMS_TOPIC_ID); await writeFile(join(workspace.path, 'replacement'), 'other')
  const move = (owner: typeof workspace, source: string, destination: string) => files.move(owner, owner, { source: { workspaceId: owner.id, path: source }, destination: { workspaceId: owner.id, path: destination } })
  for (const [owner, source, destination] of [[workspace, directory, 'renamed'], [workspace, 'replacement', directory], [{ ...workspace, id: 'parent', path: parent }, 'topics', 'new-topics']] as const) {
    expect(await move(owner, source, destination)).toMatchObject({ status: 'error', code: 'PRIMARY_MOTE_PROTECTED', finalLocation: 'source' })
  }
  expect(await readFile(join(workspace.path, 'replacement'), 'utf8')).toBe('other')
  await access(join(workspace.path, directory, 'SOUL.md'))
})
it('real deletion still permits internal data, custom Motes, prefix siblings and a different host identity', async () => {
  const { workspace, topics, files, directory } = await fixture()
  await topics.ensureMote(workspace, PMO_TEAMS_TOPIC_ID)
  const custom = await topics.ensureMote(workspace, 'view:custom')
  await writeFile(join(workspace.path, directory, 'user.txt'), 'delete this')
  await files.delete(workspace, directory + '/user.txt')
  await files.delete(workspace, custom.directoryPath)
  await mkdir(join(workspace.path, directory + '-sibling')); await files.delete(workspace, directory + '-sibling')
  const other = await mkdtemp(join(tmpdir(), 'mote-other-host-')); roots.push(other); await mkdir(join(other, directory))
  await files.delete({ ...workspace, id: 'other', hostId: 'other-local', path: other }, directory)
  await access(join(workspace.path, directory, 'SOUL.md'))
  await expect(access(join(workspace.path, custom.directoryPath))).rejects.toThrow()
  await expect(access(join(other, directory))).rejects.toThrow()
})
it('actual unlink of an internal self-link or unrelated leaf alias remains legal without touching its primary target', async () => {
  const { parent, workspace, topics, files, directory } = await fixture()
  await topics.ensureMote(workspace, PMO_TEAMS_TOPIC_ID)
  const primary = join(workspace.path, directory), soul = await readFile(join(primary, 'SOUL.md'))
  await symlink(primary, join(primary, 'self-link'))
  await files.delete(workspace, directory + '/self-link')
  await symlink(primary, join(workspace.path, 'unrelated-link'))
  await files.delete(workspace, 'unrelated-link')
  expect(await readFile(join(primary, 'SOUL.md'))).toEqual(soul)
  const configAlias = join(parent, 'configured-root'); await symlink(workspace.path, configAlias)
  const aliased = { ...workspace, path: configAlias }
  const aliasFiles = new WorkspaceFiles(() => ({ kind: 'local' }) as never, { primaryMoteWorkspace: async () => aliased })
  const parentOwner = { ...workspace, id: 'parent', path: parent }
  await expect(aliasFiles.delete(parentOwner, 'configured-root')).rejects.toMatchObject({ code: 'PRIMARY_MOTE_PROTECTED' })
  await expect(aliasFiles.delete(workspace, directory)).rejects.toMatchObject({ code: 'PRIMARY_MOTE_PROTECTED' })
  expect(await readFile(join(configAlias, directory, 'SOUL.md'))).toEqual(soul)
})
it('the existing atomic move owner still moves internal files, custom Motes and prefix siblings under primary protection', async () => {
  const { workspace, topics, files, directory } = await fixture()
  await topics.ensureMote(workspace, PMO_TEAMS_TOPIC_ID)
  const custom = await topics.ensureMote(workspace, 'view:move-custom')
  await writeFile(join(workspace.path, directory, 'inside.txt'), 'Original inner file')
  await mkdir(join(workspace.path, directory + '-move-sibling'))
  const move = (source: string, destination: string) => files.move(workspace, workspace, { source: { workspaceId: workspace.id, path: source }, destination: { workspaceId: workspace.id, path: destination } })
  expect(await move(directory + '/inside.txt', directory + '/renamed.txt')).toEqual({ status: 'moved' })
  expect(await move(custom.directoryPath, 'renamed-custom')).toEqual({ status: 'moved' })
  expect(await move(directory + '-move-sibling', 'renamed-sibling')).toEqual({ status: 'moved' })
  expect(await readFile(join(workspace.path, directory, 'renamed.txt'), 'utf8')).toBe('Original inner file')
  expect(await readFile(join(workspace.path, 'renamed-custom', 'SOUL.md'), 'utf8')).not.toBe('')
  await access(join(workspace.path, directory, 'SOUL.md'))
})
