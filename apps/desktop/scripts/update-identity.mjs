import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

export async function hashTree(root, paths) {
  const hash = createHash('sha256')
  async function visit(path) {
    const entries = await readdir(path, { withFileTypes: true }).catch((error) => {
      if (error.code === 'ENOTDIR') return null
      throw error
    })
    if (entries) {
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) await visit(join(path, entry.name))
    } else {
      hash.update(relative(root, path)); hash.update('\0'); hash.update(await readFile(path)); hash.update('\0')
    }
  }
  for (const path of paths) await visit(join(root, path))
  return hash.digest('hex')
}

export async function sourceUpdateIdentity(root) {
  return {
    shell: await hashTree(root, [
      'apps/desktop/src/main', 'apps/desktop/src/preload', 'apps/desktop/src/shared',
      'apps/desktop/package.json', 'apps/desktop/electron.vite.config.ts', 'apps/desktop/scripts',
      'packages/core/src', 'packages/core/package.json', 'packages/core/scripts', 'packages/core/bin',
      'pnpm-lock.yaml'
    ]),
    ctxmux: await hashTree(root, ['packages/core/vendor/ctxmux'])
  }
}
