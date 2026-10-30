import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { ScratchTopics } from '../src/mote-resources'

let root: string, helper: string
beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'mote-packaged-helper-')))
  helper = join(root, 'workspace-move')
  const compiler = process.platform === 'darwin' ? 'xcrun' : 'cc'
  const args = [...(process.platform === 'darwin' ? ['clang'] : []), '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror',
    resolve(import.meta.dirname, '../native/workspace-move.c'), '-o', helper, ...(process.platform === 'linux' ? ['-lcrypto'] : [])]
  execFileSync(compiler, args)
})
afterAll(async () => { if (root) await rm(root, { recursive: true }) })

it.each(['launcher:leader', 'view:custom-mote'])('uses the Host-supplied native helper for the first original Mote %s', async id => {
  const path = join(root, id.replace(':', '-'), '.agentmux', 'scratch')
  await mkdir(path, { recursive: true })
  const workspace = { id: '__scratch__', hostId: 'local', path }
  const topics = new ScratchTopics({ directoryIdentityHelper: helper })
  const created = await topics.ensureMote(workspace, id)
  expect(created).toMatchObject({ id, kind: 'mote' })
  expect(created.identityDirectoryPath).toBe(created.physicalDirectoryPath)
  expect(JSON.parse(await readFile(join(created.physicalDirectoryPath!, '.agentmux/directory-identity.json'), 'utf8')))
    .toMatchObject({ version: 3, topicId: id })
  const reread = await topics.read(workspace, id)
  expect(reread).toMatchObject({ id, kind: 'mote', identityDirectoryPath: created.identityDirectoryPath,
    physicalDirectoryPath: created.physicalDirectoryPath })
  expect(reread?.readError).toBeUndefined()
})
