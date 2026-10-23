import { copyFile, mkdir, rename, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { buildWorkspaceMoveHelper } from '../../host/scripts/build-workspace-move-helper.mjs'
// Desktop ships the same Host-owned native protocol artifact; no second implementation.
const result = await buildWorkspaceMoveHelper()
if (result.supported) {
  const directory = resolve(import.meta.dirname, '../resources/bin'), output = resolve(directory, 'agentmux-workspace-move'), temporary = output + '.' + process.pid + '.tmp'
  await mkdir(directory, { recursive: true })
  try { await copyFile(result.output, temporary); await rename(temporary, output) }
  finally { await rm(temporary, { force: true }) }
}
