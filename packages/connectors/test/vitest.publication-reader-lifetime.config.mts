import { defineConfig } from 'vitest/config'
import source from './vitest.publication-isolation.config.mts'
import { resolve, relative } from 'node:path'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const root = resolve(import.meta.dirname, '../../..'), mutation = process.env.PUBLICATION_READER_LIFETIME_MUTANT
if (mutation && !['lane-release', 'detail-release', 'gap-release', 'late-release'].includes(mutation)) throw Error('Unknown publication reader lifetime mutation')
export default defineConfig({ ...source, cacheDir: resolve(root, '.cache/publication-reader-lifetime'), plugins: [...source.plugins!, {
  name: 'loaded-publication-reader-lifetime', enforce: 'pre', transform(input, id) {
    const file = relative(root, id.split('?')[0]!)
    if (file !== 'packages/connectors/src/publication-host.ts') return
    let code = input
    const changes = {
      'lane-release': ["for (const view of views) void this.releaseRead(lane.binding, { view })", 'void views'],
      'gap-release': ['return units\n    } finally { await this.releaseRead(binding, reading) }', 'return units\n    } finally { /* inverse: retain anchored reader */ }'],
      'detail-release': ['} finally { await this.releaseRead(binding, reading) }', '} finally { /* inverse: retain completed exact reader */ }'],
      'late-release': ['await this.releaseRead(lane.binding, { view })', 'void view']
    } as const
    const change = mutation ? changes[mutation as keyof typeof changes] : undefined
    if (change) {
      if (!code.includes(change[0])) throw Error('Publication lifetime mutation anchor missing')
      code = code.replaceAll(change[0], change[1])
    }
    if (process.env.PUBLICATION_READER_LIFETIME_LOADED) {
      const sha = (value: string) => createHash('sha256').update(value).digest('hex')
      appendFileSync(process.env.PUBLICATION_READER_LIFETIME_LOADED, JSON.stringify({ file, originalSHA256: sha(input), loadedSHA256: sha(code), mutation: code === input ? null : mutation }) + '\n')
    }
    return code === input ? undefined : { code, map: null }
  }
}], test: { ...source.test, include: ['packages/connectors/test/publication-reader-lifetime.test.ts'], testTimeout: 15000, globalSetup: [], passWithNoTests: false, fileParallelism: false } })
