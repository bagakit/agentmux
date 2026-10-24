import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from './static-avatar-consumer.config.mts'

const root = original.root!, mutation = process.env.MOTE_NATIVE_COVERAGE_MUTANT
if (mutation && mutation !== 'ignore-native-coverage') throw Error('Unknown native coverage mutation')
export default defineConfig({ ...original, cacheDir: resolve(root, '.cache/mote-native-coverage'), plugins: [{
  name: 'current-native-coverage-consumer', enforce: 'pre', resolveId(source) {
    if (source.startsWith('@agentmux/host/')) return resolve(root, 'apps/host/src', source.slice('@agentmux/host/'.length) + '.ts')
  }, transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!/^(?:packages\/(?:core|connectors)|apps\/host)\/(?:src|test)\/.*\.(?:ts|mts)$/u.test(path)) return
    let loaded = source
    if (mutation && path === 'packages/connectors/src/publication-host.ts') {
      const before = 'const failure = nativeFailure ?? lane.watch?.failure'
      if (source.split(before).length !== 2) throw Error('Exact current native coverage owner must load once')
      loaded = source.replace(before, 'const failure = lane.watch?.failure')
    }
    if (process.env.MOTE_NATIVE_COVERAGE_LOADED) {
      const sha = (value: string) => createHash('sha256').update(value).digest('hex')
      const row = JSON.stringify({ path, originalSHA256: sha(source), loadedSHA256: sha(loaded), ...(source !== loaded ? { mutation } : {}) })
      return { code: "import { appendFileSync as __nativeCoverageLoaded } from 'node:fs'; __nativeCoverageLoaded(" +
        JSON.stringify(process.env.MOTE_NATIVE_COVERAGE_LOADED) + ', ' + JSON.stringify(row + '\n') + ');\n' + loaded, map: null }
    }
    return source === loaded ? undefined : { code: loaded, map: null }
  }
}, ...original.plugins!], test: { ...original.test, include: ['apps/host/test/mote-native-coverage-consumer.test.ts',
  'packages/connectors/test/native-content-eligibility-consumer.test.ts'], testTimeout: 30_000 } })
