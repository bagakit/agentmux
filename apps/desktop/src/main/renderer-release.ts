import { createHash } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { updateRoute, type UpdateIdentity } from '../shared/update-policy.js'

export type RendererRelease = { schema: 1; id: string; identity: UpdateIdentity; files: Record<string, string> }

export async function validateRendererRelease(directory: string, current: UpdateIdentity): Promise<RendererRelease> {
  const release = JSON.parse(await readFile(join(directory, 'release.json'), 'utf8')) as RendererRelease
  if (release.schema !== 1 || !/^[a-f0-9]{64}$/.test(release.id) || updateRoute(current, release.identity) !== 'renderer') {
    throw new Error('Renderer is incompatible with this application. Install the matching application instead.')
  }
  if (!release.files || !release.files['index.html']) throw new Error('Renderer has no index.html')
  const id = createHash('sha256').update(JSON.stringify({ identity: release.identity, files: Object.entries(release.files).sort() })).digest('hex')
  if (release.id !== id) throw new Error('Renderer release identity mismatch')
  const observed = new Set<string>()
  async function verify(path: string): Promise<void> {
    const physical = resolve(directory, path)
    if (!physical.startsWith(resolve(directory) + sep)) throw new Error('Invalid renderer path')
    const info = await lstat(physical)
    if (info.isSymbolicLink()) throw new Error('Renderer releases cannot contain symlinks')
    if (info.isDirectory()) {
      for (const entry of await readdir(physical)) await verify(path ? `${path}/${entry}` : entry)
      return
    }
    if (path === 'release.json') return
    const hash = createHash('sha256').update(await readFile(physical)).digest('hex')
    if (release.files[path] !== hash) throw new Error(`Renderer integrity mismatch: ${path}`)
    observed.add(path)
  }
  for (const name of await readdir(directory)) await verify(name)
  if (observed.size !== Object.keys(release.files).length) throw new Error('Renderer release is incomplete')
  return release
}
