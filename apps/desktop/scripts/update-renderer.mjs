import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { canonicalInstallPath } from './package-identity.mjs'
import { updateRoute } from '../src/shared/update-policy.ts'

const installedApp = canonicalInstallPath(homedir())
const { stdout: bundleId } = await promisify(execFile)('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', join(installedApp, 'Contents/Info.plist')])
const directory = join(homedir(), 'Library/Application Support', bundleId.trim(), 'renderer-updates')
await mkdir(directory, { recursive: true })
const activePath = join(directory, 'active.json')
const previous = await readFile(activePath, 'utf8').then(JSON.parse).catch((error) => {
  if (error.code === 'ENOENT') return { current: null, previous: null }
  throw error
})
const requestedAt = Date.now()
let next
if (process.argv.includes('--rollback')) {
  next = { current: previous.previous, previous: previous.current }
} else {
  const source = resolve(import.meta.dirname, '../out/renderer')
  const bundled = join(canonicalInstallPath(homedir()), 'Contents/Resources/app/out/renderer/release.json')
  const installed = JSON.parse(await readFile(bundled, 'utf8').catch(() => { throw new Error('Install an AgentMux build with frontend-update support first.') }))
  const candidate = JSON.parse(await readFile(join(source, 'release.json'), 'utf8'))
  if (updateRoute(installed.identity, candidate.identity) !== 'renderer') throw new Error('Host or runtime changed: use application installation, not frontend update.')
  if (candidate.id === previous.current) { process.stdout.write('frontend_already_active=true\n'); process.exit(0) }
  const staged = join(directory, `.staging-${randomUUID()}`)
  await cp(source, staged, { recursive: true })
  const destination = join(directory, candidate.id)
  try { await rename(staged, destination) } catch (error) {
    await rm(staged, { recursive: true, force: true })
    if (error.code !== 'EEXIST' && error.code !== 'ENOTEMPTY') throw error
  }
  next = { current: candidate.id, previous: previous.current }
}
const temporary = join(directory, `.active-${randomUUID()}.json`)
await writeFile(temporary, JSON.stringify(next), { mode: 0o600 })
await rename(temporary, activePath)
process.stdout.write(`frontend_update_requested=${next.current ?? 'bundled'}\n`)

let confirmed = false
while (Date.now() - requestedAt < 25_000) {
  const status = await readFile(join(directory, 'status.json'), 'utf8').then(JSON.parse).catch((error) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (status && status.at >= requestedAt && status.requested === next.current) {
    if (status.outcome !== 'applied') throw new Error(`Frontend update rejected: ${status.message}`)
    process.stdout.write(`frontend_update_applied=${status.current ?? 'bundled'}\n`)
    confirmed = true
    break
  }
  await new Promise((resolve) => setTimeout(resolve, 100))
}
if (!confirmed) throw new Error('Frontend update staged, but no running application confirmed readiness. Start AgentMux to apply it; no Agent was stopped.')
