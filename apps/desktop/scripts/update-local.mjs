import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { canonicalInstallPath } from './package-identity.mjs'
import { packageMacos, reportInstallTransaction } from './package-macos.mjs'
import { installedUpdateRoute, runtimeReviewMessage } from './local-update-route.mjs'

async function selectAfterBuild() {
  const candidate = JSON.parse(await readFile(join(import.meta.dirname, '../out/renderer/release.json'), 'utf8'))
  const route = await installedUpdateRoute(canonicalInstallPath(homedir()), candidate)
  process.stdout.write(`update_route=${route}\n`)
  if (route === 'runtime-review') throw new Error(runtimeReviewMessage)
  if (route === 'renderer') execFileSync(process.execPath, [join(import.meta.dirname, 'update-renderer.mjs')], { stdio: 'inherit' })
  return route
}

const uiOnly = process.argv.includes('--ui-only')
if (uiOnly) process.stdout.write('update_route=application\n')
try {
  await packageMacos({ selectAfterBuild: uiOnly ? undefined : selectAfterBuild, install: true, onlyApp: true })
} catch (error) {
  if (error.transaction) reportInstallTransaction(error.transaction)
  throw error
}
