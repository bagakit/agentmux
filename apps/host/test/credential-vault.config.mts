import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { credentialSource } from './credential-source.mjs'
const root = resolve(import.meta.dirname, '../../..')
export default defineConfig({ root, plugins: [{ name: 'private-credential-owner-source', enforce: 'pre',
  transform(original, id) {
    const loaded = credentialSource(root, id, original); if (!loaded) return
    if (!process.env.AGENTMUX_CREDENTIAL_SOURCE_REPORT) return { code: loaded.contents, map: null }
    return { code: "import { appendFileSync as __credentialLoad } from 'node:fs'; __credentialLoad(" + JSON.stringify(process.env.AGENTMUX_CREDENTIAL_SOURCE_REPORT) + ', ' + JSON.stringify(JSON.stringify(loaded.receipt) + '\n') + ');\n' + loaded.contents, map: null }
  },
  resolveId(source, importer) {
    if (source === '@agentmux/core') return resolve(root, 'packages/core/src/index.ts')
    if (source === '@agentmux/connectors') return resolve(root, 'packages/connectors/src/index.ts')
    if (source.startsWith('@agentmux/core/')) {
      const entry = JSON.parse(readFileSync(resolve(root, 'packages/core/package.json'), 'utf8')).exports['./' + source.slice('@agentmux/core/'.length)]?.import
      if (typeof entry === 'string' && entry.startsWith('./dist/')) return resolve(root, 'packages/core/src', entry.slice(7).replace(/\.js$/u, '.ts'))
    }
    if (!importer || !source.startsWith('.')) return
    const dist = resolve(dirname(importer), source).match(/\/packages\/(core|connectors)\/dist\/(.+)\.js$/u)
    if (dist) return resolve(root, 'packages', dist[1]!, 'src', dist[2]! + '.ts')
  }
}], test: { include: ['apps/host/test/credential-vault.test.ts', 'apps/host/test/credential-process-consumer.test.ts', 'apps/desktop/test/connector-secrets-async.test.ts'], environment: 'node', fileParallelism: false, passWithNoTests: false, testTimeout: 30_000, hookTimeout: 15_000 } })
