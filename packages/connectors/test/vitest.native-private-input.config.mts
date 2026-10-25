import { defineConfig } from 'vitest/config'
import native from './vitest.mote-host.config.mts'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
const root = native.root!
export default defineConfig({ ...native, cacheDir: resolve(root, '.cache/native-private-input', process.env.AGENTMUX_TEST_NATIVE_PRIVATE_MUTATION ?? 'positive'), plugins: [{
  name: 'native-private-input-consumer', enforce: 'pre',
  transform(original, id) {
    const path = relative(root, id.split('?')[0]!)
    let loaded = original, mutation: string | undefined
    if (process.env.AGENTMUX_TEST_NATIVE_PRIVATE_MUTATION && path === 'packages/connectors/src/connection-services.ts') {
      const before = "? { kind: 'session-conversation' as const } : undefined"
      if (process.env.AGENTMUX_TEST_NATIVE_PRIVATE_MUTATION !== 'manual-private-input' || original.split(before).length !== 2) throw Error('Exact original private input branch required')
      loaded = original.replace(before, "? { kind: 'manual-actor' as const } : undefined"); mutation = 'manual-private-input'
    }
    if (process.env.AGENTMUX_TEST_NATIVE_PRIVATE_LOADED && path.endsWith('.ts') && /^(packages\/(core|connectors)\/src|apps\/host\/src)\//u.test(path)) {
      const hash = (text: string) => createHash('sha256').update(text).digest('hex')
      const row = { path, originalSHA256: hash(original), loadedSHA256: hash(loaded), ...(mutation ? { mutation } : {}) }
      return { code: "import { appendFileSync as __nativePrivateLoaded } from 'node:fs'; __nativePrivateLoaded(" + JSON.stringify(process.env.AGENTMUX_TEST_NATIVE_PRIVATE_LOADED) + ', ' + JSON.stringify(JSON.stringify(row) + '\n') + ');\n' + loaded, map: null }
    }
    if (mutation) return loaded
  }
}, ...native.plugins!], test: { ...native.test, include: ['packages/connectors/test/native-private-input.integration.test.ts'], maxWorkers: 1, testTimeout: 30000 } })
