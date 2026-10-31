import { defineConfig } from 'vitest/config'
import base from './vitest.mote-context.config.mts'
import { relative, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'

const root = resolve(import.meta.dirname, '../../..'), mutation = process.env.AGENTMUX_STORAGE_OBSERVATION_MUTATION
const adjacent = !!process.env.AGENTMUX_STORAGE_OBSERVATION_ADJACENT
export default defineConfig({ ...base, cacheDir: resolve(root, '.tmp/workbench-storage-observation-' + (mutation ?? 'candidate')),
  plugins: [...base.plugins ?? [], { name: 'storage-observation-consumer', enforce: 'pre', transform(source, id) {
    const file = relative(root, id.split('?')[0]!)
    const original = source
    if (file === 'apps/desktop/scripts/package-semantic-host.mjs') source = source.replace('../../host/dist/macos-service.js', '../../host/src/macos-service.ts')
    let anchor: string | undefined, replacement: string | undefined
    if (file === 'apps/desktop/src/renderer/src/store.ts') {
      if (!adjacent) source = source.replaceAll('__AGENTMUX_WEB_PREVIEW__', 'false')
      if (mutation === 'hide-renderer-pending') {
        anchor = 'userStatePending: persistentWorkbenchStorage.pending()'; replacement = 'userStatePending: false'
      }
      if (mutation === 'trust-equal-spatial') { anchor = '!coreSpatialPersistence.pendingChanges &&'; replacement = '' }
    }
    if (mutation === 'bypass-installer-storage' && file === 'apps/desktop/scripts/package-runtime-upgrade.mjs') {
      anchor = "fail(user?.availability === 'present'"; replacement = "fail(true || user?.availability === 'present'"
    }
    if (mutation === 'hide-main-metadata' && file === 'apps/desktop/src/main/client-observation.ts') {
      anchor = 'return { userState: owner.observe() }'; replacement = 'return {}'
    }
    if (anchor) {
      if (source.split(anchor).length !== 2) throw Error('Missing unique storage observation mutation anchor: ' + mutation)
      source = source.replace(anchor, replacement!)
    }
    if (process.env.AGENTMUX_STORAGE_OBSERVATION_LOADED && ['apps/desktop/src/renderer/src/store.ts',
      'apps/desktop/src/main/client-observation.ts', 'apps/desktop/scripts/package-runtime-upgrade.mjs'].includes(file)) {
      const hash = (value: string) => createHash('sha256').update(value).digest('hex')
      appendFileSync(process.env.AGENTMUX_STORAGE_OBSERVATION_LOADED, JSON.stringify({ file, mutation: mutation ?? null,
        mutated: !!anchor, originalSha256: hash(original), loadedSha256: hash(source) }) + '\n')
    }
    return { code: source, map: null }
  } }],
  test: { ...base.test, ...(adjacent ? { environment: 'happy-dom' } : {}), include: adjacent ? ['apps/desktop/test/workbench-storage-authority.test.ts',
    'apps/desktop/test/desktop-client-observation.test.ts']
    : ['apps/desktop/test/workbench-storage-observation.test.ts', 'apps/desktop/test/package-install-workbench-continuity.test.ts'], passWithNoTests: false }
})
