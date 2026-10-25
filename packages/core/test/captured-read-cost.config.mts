import { defineConfig } from 'vitest/config'
import { readFileSync, appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, relative } from 'node:path'
import base from './captured-history-public.vitest.config.mts'
const root = resolve(import.meta.dirname, '../../..'), mutation = process.env.CAPTURED_READ_MUTANT
if (mutation && !['no-index', 'revision', 'cut', 'order'].includes(mutation)) throw Error('Unknown exact captured read mutation')
export default defineConfig({ ...base, cacheDir: resolve(root, '.local/cache/captured-read-cost', mutation ?? 'base'), plugins: [{
  name: 'original-exact-captured-read-source', enforce: 'pre', load(id) {
    const file = id.split('?')[0]!
    if (!file.startsWith(resolve(root, 'packages/core') + '/') || !file.endsWith('.ts')) return null
    const original = readFileSync(file, 'utf8'); let source = original
    if (mutation && file === resolve(root, 'packages/core/src/captured-history.ts')) {
      const block = source.match(/else if \(input\.recordId !== undefined && input\.recordRevision !== undefined\) \{[\s\S]*?\n  \}/u)?.[0]
      if (!block) throw Error('Exact captured read branch did not load')
      const [before, after] = mutation === 'no-index' ? [' INDEXED BY captured_exact_version', ''] : mutation === 'revision' ? ['v.revision=?', '? IS NOT NULL'] : mutation === 'cut' ? ['v.sequence<=?', '? IS NOT NULL'] : ['ORDER BY v.sequence DESC', 'ORDER BY v.sequence ASC']
      if (block.split(before).length !== 2) throw Error('Exact captured read mutation must identify one original predicate')
      source = source.replace(block, block.replace(before, after))
    }
    if (process.env.CAPTURED_READ_LOADED) {
      const hash = (value: string) => createHash('sha256').update(value).digest('hex')
      appendFileSync(process.env.CAPTURED_READ_LOADED, JSON.stringify({ path: relative(root, file), originalSHA256: hash(original), loadedSHA256: hash(source), ...(source !== original ? { mutation } : {}) }) + '\n')
    }
    return source
  }
}], test: { ...base.test, include: ['packages/core/test/captured-read-cost.test.ts'], passWithNoTests: false } })
