import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { canonicalInstallPath } from './package-identity.mjs'
import { updateRoute } from '../src/shared/update-policy.ts'

const bundled = join(canonicalInstallPath(homedir()), 'Contents/Resources/app/out/renderer/release.json')
const candidate = JSON.parse(await readFile(join(import.meta.dirname, '../out/renderer/release.json'), 'utf8'))
const installed = await readFile(bundled, 'utf8').then(JSON.parse).catch((error) => {
  if (error.code === 'ENOENT') return null
  throw error
})
// The installer independently compares actual runtime binaries, including first loader adoption.
const route = installed ? updateRoute(installed.identity, candidate.identity) : 'application'
if (route === 'runtime-review') throw new Error('ctxmux changed. Assess Run compatibility and Provider resume before installing; no application or Agent was stopped.')
process.stdout.write(`update_route=${route}\n`)
const script = route === 'renderer' ? 'update-renderer.mjs' : 'package-macos.mjs'
const result = spawnSync(process.execPath, [join(import.meta.dirname, script), ...(route === 'application' ? ['--install'] : [])], { stdio: 'inherit' })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
