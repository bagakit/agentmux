import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, relative, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { defineConfig } from 'vitest/config'

const root = resolve(import.meta.dirname, '../../..')
const connectorRequire = createRequire(resolve(root, 'packages/connectors/package.json'))
const variants = {
  'hot-main-file-copy': ['packages/connectors/src/connection-backup.ts', 'const pages = await backup(database, path)', "await (await import('node:fs/promises')).copyFile(database.location()!, path); const pages = 1"],
  'duplicate-owner': ['packages/connectors/src/connection-services.ts', 'if (!native.tryLock(fd))', 'if (false)'],
  'host-drops-close-wait': ['apps/host/src/connections.ts', 'await owner?.close()', 'owner?.close()']
} as const
const mutation = process.env.CONNECTION_BACKUP_MUTANT as keyof typeof variants | undefined
if (mutation && !variants[mutation]) throw Error('Unknown Host connection mutation')
export default defineConfig({ root, plugins: [{ name: 'actual-host-backup-source', enforce: 'pre',
  transform(original, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!/^(?:apps\/host|packages\/(?:core|connectors))\/src\/.+\.[cm]?[jt]s$/u.test(path) && path !== 'apps/host/test/fixtures/connection-backup-native.ts') return
    const selected = mutation && variants[mutation]
    let served = original
    // Only the primitive import is redirected; the wrapper still executes Node's original backup.
    if (path === 'packages/connectors/src/connection-backup.ts') served = served.replace("from 'node:sqlite'", "from '../../../apps/host/test/fixtures/connection-backup-native.js'")
    if (selected && selected[0] === path) {
      if (original.split(selected[1]).length !== 2) throw Error('Host mutation must match one owning expression')
      served = original.replace(selected[1], selected[2])
    }
    if (!process.env.CONNECTION_BACKUP_TRACE) return served === original ? undefined : { code: served, map: null }
    const sha = (value: string) => createHash('sha256').update(value).digest('hex')
    const row = { path, originalSHA: sha(readFileSync(id.split('?')[0]!, 'utf8')), servedSHA: sha(served), ...(selected && selected[0] === path ? { mutation } : {}), ...(path === 'packages/connectors/src/connection-backup.ts' ? { instrumentation: 'node-backup-forward-only' } : {}) }
    return { code: "import { appendFileSync as __hostOwnerLoad } from 'node:fs'; __hostOwnerLoad(" + JSON.stringify(process.env.CONNECTION_BACKUP_TRACE) + ', ' + JSON.stringify(JSON.stringify(row) + '\n') + ');\n' + served, map: null }
  },
  resolveId(source, importer) {
    if (source === 'node:sqlite' && importer?.endsWith('/packages/connectors/src/connection-backup.ts')) return resolve(root, 'apps/host/test/fixtures/connection-backup-native.ts')
    if (source === '@larksuiteoapi/node-sdk' || source === '@discordjs/rest') return connectorRequire.resolve(source)
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
}], test: { include: ['apps/host/test/connection-backup-consumer.test.ts'], environment: 'node', fileParallelism: false,
  passWithNoTests: false, testTimeout: 35_000, hookTimeout: 15_000 } })
