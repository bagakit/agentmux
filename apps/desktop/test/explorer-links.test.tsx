import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { LocalExecutionHost } from '../../../packages/core/src/execution-host'
import type { WorkspaceRecord } from '../src/shared/contracts'
import { readFileSync } from 'node:fs'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
it('shows ignored files with Git rules and follows links at their original tree path without allowing cycles or writes outside', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'amx-links-')); roots.push(fixture)
  const root = join(fixture, 'project'), target = join(fixture, 'target')
  await mkdir(root); await mkdir(target)
  execFileSync('git', ['init', '-q', root])
  await writeFile(join(root, '.gitignore'), '*.log\n!keep.log\nnode_modules/\n')
  await writeFile(join(root, 'skip.log'), 'ignored'); await writeFile(join(root, 'keep.log'), 'visible')
  await mkdir(join(root, 'node_modules')); await writeFile(join(root, 'node_modules/item'), 'module')
  await writeFile(join(target, 'file.txt'), 'linked content')
  await symlink(target, join(root, 'linked-dir')); await symlink(join(target, 'file.txt'), join(root, 'linked-file'))
  await symlink(join(target, 'missing'), join(root, 'broken')); await symlink(root, join(root, 'cycle'))
  const host = new LocalExecutionHost()
  const files = new WorkspaceFiles(() => host)
  const workspace: WorkspaceRecord = { id: 'w', hostId: 'local', path: root, name: 'Project', kind: 'folder' }
  try {
    const entries = await files.readDirectory(workspace, '')
    expect(entries.find((entry) => entry.name === 'skip.log')?.ignored).toBe(true)
    expect(entries.find((entry) => entry.name === 'keep.log')?.ignored).not.toBe(true)
    expect(entries.find((entry) => entry.name === 'node_modules')).toMatchObject({ ignored: true, isDirectory: true })
    expect(entries.find((entry) => entry.name === 'linked-dir')).toMatchObject({ isDirectory: true, isSymlink: true, linkTarget: target })
    expect(entries.find((entry) => entry.name === 'linked-file')).toMatchObject({ isDirectory: false, isSymlink: true })
    expect(entries.find((entry) => entry.name === 'broken')?.linkIssue).toBe('unavailable')
    expect(await files.readDirectory(workspace, 'linked-dir')).toContainEqual({ name: 'file.txt', path: 'linked-dir/file.txt', isDirectory: false, isSymlink: false })
    expect(await files.read(workspace, 'linked-file')).toMatchObject({ status: 'read', document: { content: 'linked content' } })
    await expect(files.readDirectory(workspace, 'cycle')).rejects.toThrow('cycle')
    await expect(files.readDirectory(workspace, '../target')).rejects.toThrow('escapes')
    expect(await files.write(workspace, { path: 'linked-dir/file.txt', content: 'no', expectedRevision: null })).toMatchObject({ status: 'error' })
  } finally { await files.dispose(); await host.dispose() }
})
it('production Explorer consumes ignore facts and renders typed link icons instead of a text badge', () => {
  const source = readFileSync(new URL('../src/renderer/src/components/FileExplorer.tsx', import.meta.url), 'utf8')
  expect(source.length).toBeGreaterThan(0)
  expect(source).toContain('node.ignored')
  expect(source).toContain('Directory symbolic link')
  expect(source).toContain('<Link2')
  expect(source).not.toContain('>link</span>')
  expect(source).not.toContain('!node.isDirectory && !node.isSymlink')
})
