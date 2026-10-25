import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import isolation from './vitest.publication-isolation.config.mts'

const root = resolve(import.meta.dirname, '../../..'), mutation = process.env.PUBLICATION_DECISION_LOOKUP_MUTANT
if (mutation && !['event-scan', 'failure-scan', 'event-source', 'oldest-event'].includes(mutation)) throw Error('Unknown decision lookup mutation')
export default defineConfig({ ...isolation, cacheDir: resolve(root, '.cache/decision-lookup-cost'), plugins: [{
  name: 'loaded-original-decision-lookup', enforce: 'pre', transform(original, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!/^packages\/(?:core|connectors)\/(?:src|test)\/.+\.tsx?$/u.test(path)) return
    let code = original
    if (mutation && path === 'packages/connectors/src/publication-store.ts') {
      let changed = 0
      code = original.replace(/"SELECT decision_json FROM connector_publication_decision[^"\n]+"/gu, query => {
        const selected = mutation === 'failure-scan' ? query.includes("='failure-record'") : query.includes("='event-representation'")
        if (!selected) return query
        const anchor = mutation === 'oldest-event' ? 'ORDER BY rowid DESC' : "AND source_key='unified'"
        if (query.split(anchor).length !== 2) throw Error('Decision lookup mutation requires its original query')
        changed++
        return query.replace(anchor, mutation === 'oldest-event' ? 'ORDER BY rowid ASC' : mutation === 'event-source' ? '' : "AND (source_key || '')='unified'")
      })
      if (changed !== (mutation === 'failure-scan' ? 1 : 2)) throw Error('Decision lookup mutation requires every original target query')
    }
    const marker = process.env.PUBLICATION_DECISION_LOOKUP_LOADED
    if (marker) {
      const hash = (text: string) => createHash('sha256').update(text).digest('hex')
      const row = { path, originalSHA256: hash(original), loadedSHA256: hash(code), ...(code !== original ? { mutation } : {}) }
      code = "import { appendFileSync as __decisionLookupLoaded } from 'node:fs'; __decisionLookupLoaded(" + JSON.stringify(marker) + ', ' + JSON.stringify(JSON.stringify(row) + '\n') + ');\n' + code
    }
    return code === original ? undefined : { code, map: null }
  }
}, ...isolation.plugins!], test: { ...isolation.test, include: ['packages/connectors/test/publication-worker-consumer.test.ts'],
  testNamePattern: '^decision lookup ', passWithNoTests: false, fileParallelism: false } })
