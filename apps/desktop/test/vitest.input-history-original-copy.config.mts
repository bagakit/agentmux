import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from './vitest.activity-current-signatures.config.mts'
import { candidateModule } from '../scripts/candidate-package-resolve.mjs'

const root = resolve(import.meta.dirname, '../../..')
const owner = 'packages/client-ui/src/lib/input-history-text.ts'
const selected = process.env.AGENTMUX_ORIGINAL_COPY_MUTATION ?? ''
if (selected && selected !== 'readable-as-original') throw new Error('Unknown original-copy mutation: ' + selected)

export default defineConfig({ ...base, root,
  cacheDir: resolve(root, '.cache/input-history-original-copy-' + (selected || 'positive')),
  resolve: { ...base.resolve, conditions: ['module', 'import', 'default'] },
  ssr: { ...base.ssr, resolve: { conditions: ['module', 'import', 'default'] } },
  plugins: [...base.plugins ?? [], { name: 'original-history-copy-inputs', enforce: 'pre', transform(source, id) {
    const file = id.split('?')[0]!
    if (!isAbsolute(file)) return
    const actual = candidateModule(root, file)
    if (!actual.startsWith(root + '/') || actual.includes('/node_modules/')) return
    const path = relative(root, actual), query = id.includes('?') ? id.slice(id.indexOf('?')) : ''
    const kind = !query && /\.(?:[cm]?[jt]sx?)$/u.test(path) ? 'module' : 'resource'
    const applied = selected !== '' && kind === 'module' && path === owner
    let loaded = source
    if (applied) {
      const from = 'return { text, originalText, attachments }'
      if (source.split(from).length !== 2) throw new Error('Original-copy mutation requires one exact helper return site')
      loaded = source.replace(from, 'return { text, originalText: text, attachments }')
    }
    if (process.env.AGENTMUX_ORIGINAL_COPY_LOADED) {
      const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
      appendFileSync(process.env.AGENTMUX_ORIGINAL_COPY_LOADED, JSON.stringify({ path, kind, query,
        fileSHA256: sha(readFileSync(actual)), originalSHA256: sha(source), loadedSHA256: sha(loaded),
        mutation: applied ? selected : null }) + '\n')
    }
    return applied ? loaded : undefined
  } }],
  test: { ...base.test, environment: 'happy-dom', setupFiles: ['apps/mobile/test/device-locks.ts'],
    include: ['apps/desktop/test/composer-input-history-races.test.tsx', 'apps/mobile/test/mobile-input-history.test.tsx'],
    testNamePattern: /actual (?:Composer|Mobile Surface) copies original native wire and fills readable (?:answers|range) through Hosted and Core$/u,
    fileParallelism: false, maxWorkers: 1, passWithNoTests: false, testTimeout: 20_000 }
})
