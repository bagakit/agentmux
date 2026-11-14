import { copyFile, mkdir, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// TypeScript emits modules; their relative stylesheet and image imports retain
// the source layout. Keep those assets in the same layout in the built package.
const source = fileURLToPath(new URL('../src/', import.meta.url))
const target = fileURLToPath(new URL('../dist/', import.meta.url))
for (const entry of await readdir(source, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || /\.(?:[cm]?[jt]sx?|map)$/.test(entry.name)) continue
  const relative = join(entry.parentPath.slice(source.length), entry.name)
  const output = join(target, relative)
  await mkdir(dirname(output), { recursive: true })
  await copyFile(join(source, relative), output)
}
