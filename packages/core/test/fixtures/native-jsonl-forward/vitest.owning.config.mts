import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const root = resolve(import.meta.dirname, '../../../../..')
const core = resolve(root, 'packages/core')
const sourceAliases = Object.entries(JSON.parse(readFileSync(resolve(core, 'package.json'), 'utf8')).exports)
  .map(([key, value]) => ({ find: `@agentmux/core${key === '.' ? '' : key.slice(1)}`,
    replacement: resolve(core, (typeof value === 'string' ? value : (value as { import: string }).import)
      .replace('./dist/', './src/').replace(/\.js$/u, '.ts')) }))
  .sort((left, right) => right.find.length - left.find.length)

export default defineConfig({ root, resolve: { alias: sourceAliases },
  cacheDir: resolve(root, '.cache/native-jsonl-forward', process.env.AGENTMUX_FORWARD_MUTATION ?? 'positive'),
  plugins: [{ name: 'native-forward-source-evidence', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    if (path !== 'packages/core/src/native-jsonl-history-reader.ts') return
    const mutation = process.env.AGENTMUX_FORWARD_MUTATION
    let changed = source
    if (mutation) {
      if (mutation !== 'overlapping-reads') throw new Error('Unknown native forward mutation')
      const anchor = 'const block = await this.blockStartingAt(position)'
      if (source.split(anchor).length !== 3) throw new Error('Both original forward delimiter consumers must be loaded')
      changed = source.replaceAll(anchor, 'const block = await this.read(position, Math.min(64 * 1024, this.cut - position))')
    }
    const receipt = process.env.AGENTMUX_FORWARD_SOURCE_RECEIPT
    if (receipt) appendFileSync(receipt, JSON.stringify({ path, mutation: mutation ?? null,
      original: createHash('sha256').update(source).digest('hex'), loaded: createHash('sha256').update(changed).digest('hex') }) + '\n')
    if (changed !== source) return { code: changed, map: null }
  } }],
  test: { include: ['packages/core/test/native-jsonl-history-reader.test.ts', 'packages/core/test/native-session-catalog-resume.test.ts'],
    setupFiles: [resolve(root, 'vitest.setup.ts')], passWithNoTests: false,
    maxWorkers: 1, fileParallelism: false, testTimeout: 20000, hookTimeout: 15000 }
})
