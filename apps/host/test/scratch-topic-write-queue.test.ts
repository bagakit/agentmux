import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ScratchTopics, type ScratchWorkspace } from '../src/mote-resources'
import { directoryIdentity } from '../src/mote-model'
import { SCRATCH_WORKSPACE_ID } from '../src/mote-topic-model'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function scratch(): Promise<ScratchWorkspace> {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'agentmux-topic-writes-'))); roots.push(home)
  const path = join(home, '.agentmux/scratch'); await mkdir(path, { recursive: true })
  return { id: SCRATCH_WORKSPACE_ID, hostId: 'local', path }
}

// The Host composes several Topic owners in one process; each must see the others' writes to the same files.
it('two owners in one process create a new Mote once', async () => {
  const workspace = await scratch(), first = new ScratchTopics(), second = new ScratchTopics()
  const [a, b] = await Promise.all([first.ensureMote(workspace, 'view:shared'), second.ensureMote(workspace, 'view:shared')])
  expect(a.readError).toBeUndefined(); expect(b.readError).toBeUndefined()
  expect(b.identityDirectoryPath).toBe(a.identityDirectoryPath)
})

it('two owners in one process apply one archive request and refuse the stale one', async () => {
  const workspace = await scratch(), first = new ScratchTopics(), second = new ScratchTopics()
  const mote = await first.ensureMote(workspace, 'view:archive')
  const key = directoryIdentity('local', mote.identityDirectoryPath!)
  const results = await Promise.allSettled([first.setMoteArchived(workspace, mote.id, true, key, 'unwritten'),
    second.setMoteArchived(workspace, mote.id, false, key, 'unwritten')])
  const applied = results.filter(result => result.status === 'fulfilled'), refused = results.filter(result => result.status === 'rejected')
  expect(applied).toHaveLength(1)
  expect(refused.map(result => (result as PromiseRejectedResult).reason.message)).toEqual(['Mote archive state changed. Refresh this Mote before retrying.'])
  expect((await second.read(workspace, mote.id))!.moteArchive).toEqual((applied[0] as PromiseFulfilledResult<unknown>).value)
})
