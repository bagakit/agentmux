import { createHash } from 'node:crypto'
import { workspaceSourceExport } from '../../../packages/core/test/helpers/workspace-source-export.mjs'
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
  return workspaceSourceExport(root, specifier)
}
