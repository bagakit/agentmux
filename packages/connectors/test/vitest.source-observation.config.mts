import { defineConfig } from 'vitest/config'
import native from './vitest.channel-history.config.mts'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'

const root = native.root!
const mutations = {
  'closed-means-source-changed': { path: 'packages/core/src/client.ts',
    before: "if (!observationFailureReported) unavailable('AGENT_SESSION_HISTORY_OBSERVATION_UNAVAILABLE',",
    after: "unavailable('AGENT_SESSION_HISTORY_SOURCE_CHANGED'," },
  'drop-safe-observation-code': { path: 'packages/core/src/connection-diagnosis-source.ts',
    before: "'AGENT_SESSION_HISTORY_OBSERVATION_UNAVAILABLE', ", after: '' },
  'drop-opening-failure': { path: 'packages/core/src/client.ts',
    before: "if (nativeFailure && pendingNative?.kind === 'unavailable') onNative(pendingNative)", after: '' }
} as const
const name = process.env.AGENTMUX_TEST_SOURCE_OBSERVATION_MUTANT as keyof typeof mutations | undefined
const change = name ? mutations[name] : undefined
if (name && !change) throw Error('Unknown source observation mutation')
export default defineConfig({ ...native, cacheDir: resolve(root, '.cache/source-observation', name ?? 'positive'), plugins: [{
  name: 'source-observation-loaded-consumer', enforce: 'pre',
  transform(original, id) {
    const path = relative(root, id.split('?')[0]!), loadedFile = process.env.AGENTMUX_TEST_SOURCE_OBSERVATION_LOADED
    let loaded = original
    if (change?.path === path) {
      if (original.split(change.before).length !== 2) throw Error('Exact observation mutation must occur once')
      loaded = original.replace(change.before, change.after)
    }
    if (loadedFile && /^(packages\/(core|connectors)\/src)\/.+\.ts$/u.test(path)) {
      const hash = (value: string) => createHash('sha256').update(value).digest('hex')
      const row = { path, originalSHA256: hash(original), loadedSHA256: hash(loaded), ...(change?.path === path ? { mutation: name } : {}) }
      return { code: "import { appendFileSync as __observationLoaded } from 'node:fs'; __observationLoaded(" + JSON.stringify(loadedFile) + ', ' + JSON.stringify(JSON.stringify(row) + '\n') + ');\n' + loaded, map: null }
    }
    if (loaded !== original) return loaded
  }
}, ...native.plugins!], test: { ...native.test, include: ['packages/connectors/test/source-observation-consumer.test.ts'], maxWorkers: 1, testTimeout: 30000 } })
