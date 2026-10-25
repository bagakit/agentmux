import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import isolation from './vitest.publication-isolation.config.mts'

const root = resolve(import.meta.dirname, '../../..'), mutation = process.env.PUBLICATION_CARD_RECOVERY_MUTANT
if (mutation && !['no-index', 'cross-revision'].includes(mutation)) throw Error('Unknown card recovery mutation')
export default defineConfig({ ...isolation, cacheDir: resolve(root, '.cache/card-recovery-cost'), plugins: [{
  name: 'loaded-original-card-recovery', enforce: 'pre', transform(original, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!/^packages\/(?:core|connectors)\/(?:src|test)\/.+\.tsx?$/u.test(path)) return
    let code = original
    if (mutation && path === 'packages/connectors/src/publication-store.ts') {
      const method = original.match(/  unconfirmedCards\([\s\S]*?\n  \}/u)?.[0]
      const anchor = mutation === 'no-index' ? ' INDEXED BY connector_publication_card_preparation' : 'binding_revision=?'
      if (!method || method.split(anchor).length !== 2) throw Error('Card recovery mutation requires its exact original owner')
      code = original.replace(method, method.replace(anchor, mutation === 'no-index' ? '' : '? IS NOT NULL'))
    }
    const marker = process.env.PUBLICATION_CARD_RECOVERY_LOADED
    if (marker) {
      const hash = (text: string) => createHash('sha256').update(text).digest('hex')
      const row = { path, originalSHA256: hash(original), loadedSHA256: hash(code), ...(code !== original ? { mutation } : {}) }
      code = "import { appendFileSync as __cardRecoveryLoaded } from 'node:fs'; __cardRecoveryLoaded(" + JSON.stringify(marker) + ', ' + JSON.stringify(JSON.stringify(row) + '\n') + ');\n' + code
    }
    return code === original ? undefined : { code, map: null }
  }
}, ...isolation.plugins!], test: { ...isolation.test, include: ['packages/connectors/test/publication-worker-consumer.test.ts'],
  testNamePattern: '^card recovery ', passWithNoTests: false, fileParallelism: false } })
