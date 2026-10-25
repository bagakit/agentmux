import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.PUBLICATION_ISOLATION_MUTANT, marker = process.env.PUBLICATION_ISOLATION_LOADED
export const mutations = {
  selection: ['packages/connectors/src/publication-store.ts', "AND original.state='pending'", "AND original.state='pending' AND NOT EXISTS (SELECT 1 FROM connector_publication_operation blocker WHERE blocker.binding_id=original.binding_id AND blocker.binding_revision=original.binding_revision AND blocker.state IN ('unknown','dispatching'))"],
  claim: ['packages/connectors/src/publication-store.ts', 'first.operationId !== expectedOperationId', 'false'],
  dependency: ['packages/connectors/src/publication-store.ts', 'AND earlier.ordinal<original.ordinal', 'AND 0'],
  inspection: ['packages/connectors/src/publication-host.ts', 'if (lane.inspection || lane.abort.signal.aborted || this.closed) return', 'if (lane.abort.signal.aborted || this.closed) return'],
  timeout: ['packages/connectors/src/publication-host.ts', 'await this.until(observation, signal)', 'await observation'],
  aggregate: ['packages/connectors/src/publication-store.ts', "if (this.database.prepare(\"SELECT 1 FROM connector_publication_operation", "if (false && this.database.prepare(\"SELECT 1 FROM connector_publication_operation"],
  caption: ['packages/connectors/src/publication-store.ts', "AND NOT (earlier.state='not-applied' AND json_extract(earlier.operation_json,'$.payload.kind') IN ('image','file'))", ''],
  resources_blocking: ['packages/connectors/src/publication-host.ts', 'this.recoverContent(lane, adapter)', 'this.recoverContent(lane, adapter); await Promise.all(lane.contentReads?.values() ?? [])'],
  resource_cancel: ['packages/connectors/src/publication-host.ts', 'await this.until(this.resolve(reference, [unit], signal, binding, adapter, gap.part), signal)', 'await this.resolve(reference, [unit], signal, binding, adapter, gap.part)'],
  resource_part: ['packages/connectors/src/publication-host.ts', 'JSON.stringify([publicationPartKey(gap.part), gap.part.recordRevision])', 'JSON.stringify([conversationRecordId(gap.part.record), gap.part.recordRevision])'],
  resource_anchor: ['packages/connectors/src/publication-store.ts', " || gap.reason === 'resource-unavailable' && d.gap.reason === 'version-unavailable'", ''],
  resource_cache: ['packages/connectors/src/publication-store.ts', 'if (gap) return', 'if (true) return']
} as const
if (mutation && !(mutation in mutations)) throw Error('Unknown publication isolation mutation')
export default defineConfig({ root, cacheDir: resolve(root, '.cache/publication-isolation'), plugins: [{ name: 'actual-publication-isolation-owner', enforce: 'pre',
  transform(original, id) {
    const path = relative(root, id.split('?')[0]!), selected = mutations[mutation as keyof typeof mutations]
    if (!/^packages\/(?:core|connectors)\/(?:src|test)\/.+\.tsx?$/u.test(path) && !/^apps\/desktop\/test\/.+\.tsx?$/u.test(path) && path !== 'packages/connectors/src/connection-services.ts') return
    let code = original
    if (selected?.[0] === path) {
      if (code.split(selected[1]).length !== 2) throw Error('Publication isolation mutation anchor missing or ambiguous')
      code = code.replace(selected[1], selected[2])
    }
    if (!marker) return code === original ? undefined : { code, map: null }
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    const row = JSON.stringify({ path, originalSHA256: hash(original), loadedSHA256: hash(code), ...(code !== original ? { mutation } : {}) })
    return { code: "import { appendFileSync as __markPublicationIsolation } from 'node:fs'; __markPublicationIsolation(" + JSON.stringify(marker) + ', ' + JSON.stringify(row + '\n') + ');\n' + code, map: null }
  },
  resolveId(source, importer) {
    if (source === '@agentmux/core') return resolve(root, 'packages/core/src/index.ts')
    if (source === '@agentmux/connectors') return resolve(root, 'packages/connectors/src/index.ts')
    if (source.startsWith('@agentmux/core/')) {
      const exports = JSON.parse(readFileSync(resolve(root, 'packages/core/package.json'), 'utf8')).exports
      const entry = exports['./' + source.slice('@agentmux/core/'.length)]?.import as string | undefined
      if (entry?.startsWith('./dist/')) return resolve(root, 'packages/core/src', entry.slice('./dist/'.length).replace(/\.js$/u, '.ts'))
    }
    if (!importer || !source.startsWith('.')) return
    const match = resolve(dirname(importer), source).match(/\/packages\/(core|connectors)\/dist\/(.+)\.js$/u)
    if (match) return resolve(root, 'packages', match[1]!, 'src', match[2]! + '.ts')
  }
}], test: { include: [process.env.PUBLICATION_ISOLATION_RESOURCES ? 'packages/connectors/test/recorded-{image,file}-publication-consumer.test.ts' : 'packages/connectors/test/{publication-isolation-consumer,publication-worker-consumer,durable-publication,conversation-sharing-scope,native-content-eligibility-consumer,unified-publication}.test.ts'], environment: 'node',
  globalSetup: [], passWithNoTests: false, fileParallelism: false, testTimeout: 30_000 } })
