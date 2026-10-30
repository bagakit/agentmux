import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from './vitest.publication-isolation.config.mts'

const mutation = process.env.PUBLICATION_SCOPE_MUTANT, marker = process.env.PUBLICATION_SCOPE_LOADED
if (mutation && !['outside-scope', 'erase-genuine'].includes(mutation)) throw Error('Unknown scope mutation')
export default defineConfig({ ...base, cacheDir: resolve('.cache/publication-scope-coverage'), plugins: [...(base.plugins ?? []), { name: 'loaded-publication-scope-owner', enforce: 'pre',
  transform(source, id) {
    if (relative(process.cwd(), id.split('?')[0]!) !== 'packages/connectors/src/publication-store.ts') return
    const anchor = "if (boundary.scope.publication === 'future-native-user-facing') {"
    if (source.split(anchor).length !== 2) throw Error('Scope owner anchor missing or ambiguous')
    const code = mutation ? source.replace(anchor, mutation === 'outside-scope' ? 'if (false) {' : 'if (true) {') : source
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    const row = { path: 'packages/connectors/src/publication-store.ts', originalSHA256: hash(source), loadedSHA256: hash(code), ...(mutation ? { mutation } : {}) }
    return { code: marker ? "import { appendFileSync as __markScope } from 'node:fs'; __markScope(" + JSON.stringify(marker) + ', ' + JSON.stringify(JSON.stringify(row) + '\n') + ');\n' + code : code, map: null }
  }
}], test: { ...base.test, include: ['packages/connectors/test/publication-scope-coverage.test.ts', 'packages/connectors/test/durable-publication.test.ts'],
  testNamePattern: mutation ? (mutation === 'outside-scope' ? 'default Host restores original future-native-user-facing scope' : 'default Host restores original future-shared-conversation scope') :
    'default Host restores original|resolves only the exact historical|commits every required original speech|native failure at frontier persistence|a missing original text resource',
  fileParallelism: false, passWithNoTests: false, testTimeout: 30_000 } })
