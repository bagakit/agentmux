import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { auditBundle } from '../scripts/package-macos.mjs'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-bundle-audit-'))
  roots.push(root)
  const app = join(root, 'AgentMux.app')
  const runtime = join(app, 'Contents/Resources/app')
  await mkdir(join(runtime, 'nested'), { recursive: true })
  await mkdir(join(app, 'Contents/Frameworks'), { recursive: true })
  return { root, app, runtime }
}

it('checks runtime paths and permits links that remain inside the bundle', async () => {
  const { app, runtime } = await fixture()
  await writeFile(join(runtime, 'nested/index.js'), 'export const answer = 42')
  await symlink('nested/index.js', join(runtime, 'index.js'))
  await expect(auditBundle(app, { runtimeRoot: runtime, forbidden: ['/private/build-worktree'] })).resolves.toBeUndefined()
  await writeFile(join(runtime, 'nested/index.js'), 'const source = "/private/build-worktree/src"')
  await expect(auditBundle(app, { runtimeRoot: runtime, forbidden: ['/private/build-worktree'] })).rejects.toThrow(/build-machine path/)
})

it('rejects an absolute or escaping symlink while preserving binary-file handling', async () => {
  const { root, app, runtime } = await fixture()
  await writeFile(join(runtime, 'binary'), Buffer.from('\0/private/build-worktree'))
  await expect(auditBundle(app, { runtimeRoot: runtime, forbidden: ['/private/build-worktree'] })).resolves.toBeUndefined()
  const outside = join(root, 'outside')
  await writeFile(outside, 'outside')
  await symlink(outside, join(runtime, 'outside'))
  await expect(auditBundle(app)).rejects.toThrow(/absolute symlink/)
  await unlink(join(runtime, 'outside'))
  await symlink(relative(runtime, outside), join(runtime, 'outside'))
  await expect(auditBundle(app)).rejects.toThrow(/symlink escapes/)
})
