import { readFile, stat } from 'node:fs/promises'
import { join, extname } from 'node:path'

export type ProjectAppearance = { kind: 'repository' | 'directory'; icon: string | null }

/** Use conventional project assets; image-only data URLs never grant the renderer filesystem access. */
export async function projectAppearance(root: string): Promise<ProjectAppearance> {
  const result: ProjectAppearance = { kind: 'directory', icon: null }
  try { await stat(join(root, '.git')); result.kind = 'repository' } catch { /* ordinary folder */ }
  for (const candidate of ['icon.png', 'logo.svg', 'logo.png', 'favicon.ico', 'public/favicon.svg', 'public/favicon.ico', 'public/logo.svg', 'resources/icon-128.png', 'assets/icon.png']) {
    try {
      const path = join(root, candidate)
      const info = await stat(path)
      if (!info.isFile() || info.size > 256 * 1024) continue
      const bytes = await readFile(path)
      const mime = { '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' }[extname(path)]
      if (!mime) continue
      result.icon = `data:${mime};base64,${bytes.toString('base64')}`
      break
    } catch { /* Try the next conventional asset. */ }
  }
  return result
}
