import { cp, mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export async function copyMobile(root) {
  const output = join(root, 'apps/desktop/out/mobile')
  await rm(output, { recursive: true, force: true })
  await mkdir(output, { recursive: true })
  await cp(join(root, 'apps/mobile/dist'), output, { recursive: true })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await copyMobile(resolve(import.meta.dirname, '../../..'))
}
