import { createHash } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
export const lifecycleRecoveryMutations = {
  'authority-permanent-failure': { path: 'apps/host/src/host.ts', before: '.finally(() => { authorityOpening = undefined })', after: '.finally(() => {})', target: 'Host lifecycle restores the original device authority and public link without replacing healthy input' },
  'authority-remints-after-failure': { path: 'apps/host/src/host.ts', before: 'const createIfMissing = !authorityAttempted', after: 'const createIfMissing = true', target: 'Host lifecycle never mints an identity when the failed original file is absent' },
  'route-abandons-recovery': { path: 'apps/host/src/configured-host-clients.ts', before: 'if (previous && accepted()) retryObservation()', after: 'void previous', target: 'Host lifecycle repairs only the failed original SSH route and cancels a stale candidate' },
  'dispose-loses-failure': { path: 'apps/host/src/host.ts', before: 'return disposal ??= (async () => { clearInterval(retryMobile); await closeResources() })()', after: 'if (disposal) return Promise.resolve(); return disposal = (async () => { clearInterval(retryMobile); await closeResources() })()', target: 'Host lifecycle repeats the same disposal outcome without replaying resource effects' }
}
export function instrumentLifecycleRecovery(source, path, surface) {
  if (!/^(?:apps\/host|packages\/[^/]+)\/src\/.+\.(?:ts|tsx|mjs)$/u.test(path)) return source
  const original = source, mutant = process.env.HOST_LIFECYCLE_MUTANT
  if (mutant && !Object.hasOwn(lifecycleRecoveryMutations, mutant)) throw Error('Unknown Host lifecycle mutation')
  const change = mutant && lifecycleRecoveryMutations[mutant]
  if (change?.path === path) {
    if (source.split(change.before).length !== 2) throw Error('Host lifecycle mutation must select one exact owning expression')
    source = source.replace(change.before, change.after)
  }
  if (process.env.HOST_LIFECYCLE_LOADED) {
    const sha = value => createHash('sha256').update(value).digest('hex')
    const row = { path, surface, originalSHA256: sha(original), loadedSHA256: sha(source), ...(source === original ? {} : { mutant }) }
    const offset = source.startsWith('#!') ? source.indexOf('\n') + 1 : 0
    source = source.slice(0, offset) + "import { appendFileSync as __hostLifecycleLoaded } from 'node:fs'; __hostLifecycleLoaded(" + JSON.stringify(process.env.HOST_LIFECYCLE_LOADED) + ',' + JSON.stringify(JSON.stringify(row) + '\n') + ');\n' + source.slice(offset)
  }
  return source
}
/** The workspace's declared source export, never an implicit reuse of local dist. */
export function lifecycleSource(root, specifier) {
  if (specifier === '@agentmux/identity/runtime-source') return process.env.HOST_LIFECYCLE_IDENTITY_SOURCE
  const matched = /^@agentmux\/([^/]+)(.*)$/u.exec(specifier)
  if (!matched) return
  const directory = resolve(root, matched[1] === 'host' ? 'apps/host' : 'packages/' + matched[1])
  const manifest = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8')), key = matched[2] ? '.' + matched[2] : '.'
  let value = manifest.exports?.[key], substitution
  if (!value) for (const [pattern, item] of Object.entries(manifest.exports ?? {}).sort(([a], [b]) => b.length - a.length)) {
    const [prefix, suffix] = pattern.split('*')
    if (pattern.includes('*') && key.startsWith(prefix) && key.endsWith(suffix)) { value = item; substitution = key.slice(prefix.length, suffix ? -suffix.length : undefined); break }
  }
  let entry = typeof value === 'string' ? value : value?.types?.startsWith('./src/') ? value.types : value?.import
  if (substitution !== undefined) entry = entry?.replace('*', substitution)
  if (typeof entry !== 'string') throw Error('The declared workspace source export is unavailable: ' + specifier)
  const file = resolve(directory, entry.replace(/^\.\/dist\/(?:src\/)?/u, './src/').replace(/\.js$/u, '.ts'))
  if (existsSync(file)) return file
  if (existsSync(file.replace(/\.ts$/u, '.tsx'))) return file.replace(/\.ts$/u, '.tsx')
  throw Error('The declared workspace source is unavailable: ' + specifier)
}
