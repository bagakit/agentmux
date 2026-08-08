import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { sourceUpdateIdentity } from './update-identity.mjs'

const root = resolve(import.meta.dirname, '../../..')
const directory = join(root, 'apps/desktop/out/renderer')
const files = {}
async function visit(path = '') {
  for (const entry of await readdir(join(directory, path), { withFileTypes: true })) {
    const name = path ? `${path}/${entry.name}` : entry.name
    if (entry.isDirectory()) await visit(name)
    else if (name !== 'release.json') files[name] = createHash('sha256').update(await readFile(join(directory, name))).digest('hex')
  }
}
await visit()
const identity = await sourceUpdateIdentity(root)
const id = createHash('sha256').update(JSON.stringify({ identity, files: Object.entries(files).sort() })).digest('hex')
await writeFile(join(directory, 'release.json'), JSON.stringify({ schema: 1, id, identity, files }))
process.stdout.write(`renderer_release=${id}\n`)
