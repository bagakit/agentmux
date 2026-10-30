import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { payloadUpdateIdentity } from './update-identity.mjs'

/** The normal build publishes only after all of its outputs have completed. */
export async function writeRendererRelease(root) {
  const directory = join(root, 'apps/desktop/out/renderer'), files = {}
  async function visit(path = '') {
    for (const entry of await readdir(join(directory, path), { withFileTypes: true })) {
      const name = path ? `${path}/${entry.name}` : entry.name
      if (entry.isDirectory()) await visit(name)
      else if (name !== 'release.json') files[name] = createHash('sha256').update(await readFile(join(directory, name))).digest('hex')
    }
  }
  await visit()
  const identity = await payloadUpdateIdentity(root)
  const id = createHash('sha256').update(JSON.stringify({ identity, files: Object.entries(files).sort() })).digest('hex')
  const release = { schema: 1, id, identity, files }
  await writeFile(join(directory, 'release.json'), JSON.stringify(release))
  process.stdout.write(`renderer_release=${id}\n`)
  return release
}
