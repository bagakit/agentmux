import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { AgentProviderRegistry } from '../../src/agent-provider.js'
import { cursorTrustMarkerPath } from '../../src/providers/cursor-workspace-trust.js'

let root: string, home: string, data: string
const cursor = new AgentProviderRegistry().get('cursor')
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'amx-cursor-trust-')))
  home = join(root, 'mote'); data = join(root, 'private-cursor-data')
  await mkdir(home)
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
const prepare = (workspacePath = home, ownedRoot = home) => cursor.prepareOwnedWorkspaceTrust!({ ownedRoot, workspacePath, env: { CURSOR_DATA_DIR: data } })

it('prepares one real native marker only through the exact owned-home seam and retains existing bytes', async () => {
  const receipt = await prepare()
  expect(receipt).toMatchObject({ status: 'trusted', trustKey: home, configPath: cursorTrustMarkerPath(home, { CURSOR_DATA_DIR: data }) })
  const bytes = await readFile(receipt.configPath!, 'utf8'), record = JSON.parse(bytes)
  expect(record.workspacePath).toBe(home)
  expect(Number.isFinite(Date.parse(record.trustedAt))).toBe(true)
  expect(record).not.toHaveProperty('trustMethod')
  await writeFile(receipt.configPath!, JSON.stringify({ ...record, nativeField: 'preserve' }))
  expect((await prepare()).status).toBe('already-trusted')
  expect(JSON.parse(await readFile(receipt.configPath!, 'utf8')).nativeField).toBe('preserve')
})

it('canonicalizes an exact home alias and respects a relative original data override', async () => {
  const alias = join(root, 'alias')
  await symlink(home, alias)
  const receipt = await cursor.prepareOwnedWorkspaceTrust!({ ownedRoot: home, workspacePath: alias, env: { CURSOR_DATA_DIR: '../relative-data' } })
  expect(receipt).toMatchObject({ status: 'trusted', trustKey: home, configPath: cursorTrustMarkerPath(home, { CURSOR_DATA_DIR: '../relative-data' }) })
})

it.each(['nested', 'escape'])('never grants trust outside the exact home: %s', async shape => {
  const nested = join(home, 'foreign')
  if (shape === 'nested') await mkdir(nested)
  else { const external = join(root, 'external'); await mkdir(external); await symlink(external, nested) }
  expect(await prepare(nested)).toMatchObject({ status: 'not-applicable', code: 'CURSOR_TRUST_HOME_MISMATCH' })
  await expect(readFile(cursorTrustMarkerPath(await realpath(nested), { CURSOR_DATA_DIR: data }))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('reports a real write failure without changing the launch or other configuration', async () => {
  await writeFile(data, 'This is an existing file, not a directory')
  expect(await prepare()).toMatchObject({ status: 'unconfirmed', code: 'CURSOR_TRUST_UNCONFIRMED' })
  expect(await readFile(data, 'utf8')).toBe('This is an existing file, not a directory')
})

it('arbitrates concurrent preparations without replacing the winner record', async () => {
  const receipts = await Promise.all([prepare(), prepare(), prepare()])
  expect(receipts.every(receipt => ['trusted', 'already-trusted'].includes(receipt.status))).toBe(true)
  expect(JSON.parse(await readFile(cursorTrustMarkerPath(home, { CURSOR_DATA_DIR: data }), 'utf8')).workspacePath).toBe(home)
})
