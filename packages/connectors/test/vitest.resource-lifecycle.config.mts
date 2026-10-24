import { defineConfig } from 'vitest/config'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const changes = {
  retirement: ['connection-host.ts', 'else adapter?.releaseConnection?.(connectionId)', 'else void connectionId'],
  sweepers: ['adapters/discord/client.ts', 'rest.clearHashSweeper(); rest.clearHandlerSweeper()', 'void rest'],
  retention: ['connection-host.ts', 'return current?.enabled === true && current.adapterId === adapter.adapterId', 'return true'],
  consumers: ['adapters/discord/client.ts', 'if (retain) current.consumers.add(config.connectionId)', 'current.consumers.add(config.connectionId)'],
  lazy: ['platform-adapters.ts', 'close: () => { feishuClosed = true; feishuRetention = () => false; feishuAdapter?.close() }', 'close: () => { feishuClosed = true; feishuRetention = () => false; void feishu() }']
} as const
export default defineConfig({ root, cacheDir: resolve(root, '.cache/connector-resource-lifecycle'), plugins: [{
  name: 'connector-resource-product-source', enforce: 'pre',
  transform(code, id) {
    if (!id.startsWith(resolve(root, 'packages/connectors/src') + '/')) return
    const mutant = process.env.CONNECTOR_RESOURCE_MUTANT
    const change = changes[mutant as keyof typeof changes]
    let loaded = code, applied = false
    if (change && id.endsWith('/' + change[0])) {
      if (code.split(change[1]).length !== 2) throw Error('The exact connector resource mutation must load once')
      loaded = code.replace(change[1], change[2]); applied = true
    }
    if (process.env.CONNECTOR_RESOURCE_LOADED) {
      const sha = (value: string) => createHash('sha256').update(value).digest('hex')
      appendFileSync(process.env.CONNECTOR_RESOURCE_LOADED, JSON.stringify({ path: id.slice(root.length + 1), originalSHA256: sha(code), loadedSHA256: sha(loaded), ...(applied ? { mutant } : {}) }) + '\n')
    }
    if (applied) return loaded
  },
  resolveId(source, importer) {
    if (source === '@agentmux/core') return resolve(root, 'packages/core/src/index.ts')
    if (source === '@agentmux/connectors') return resolve(root, 'packages/connectors/src/index.ts')
    for (const pkg of ['core', 'connectors']) if (source.startsWith('@agentmux/' + pkg + '/')) {
      const entry = JSON.parse(readFileSync(resolve(root, 'packages', pkg, 'package.json'), 'utf8')).exports['./' + source.slice(('@agentmux/' + pkg + '/').length)]?.import
      if (entry?.startsWith('./dist/')) return resolve(root, 'packages', pkg, 'src', entry.slice('./dist/'.length).replace(/\.js$/u, '.ts'))
    }
    if (!importer || !source.startsWith('.')) return
    const match = resolve(dirname(importer), source).match(/\/packages\/(core|connectors)\/dist\/(.+)\.js$/u)
    if (match) return resolve(root, 'packages', match[1]!, 'src', match[2]! + '.ts')
  }
}], test: { include: ['packages/connectors/test/connection-client-lifecycle.test.ts', 'packages/connectors/test/connection-adapter-loading.test.ts', 'packages/connectors/test/feishu-client.test.ts'], environment: 'node', globalSetup: [], passWithNoTests: false, fileParallelism: false, testTimeout: 10000 } })
