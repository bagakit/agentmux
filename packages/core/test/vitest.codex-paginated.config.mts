import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../vitest.config.ts'
const root = resolve(import.meta.dirname, '../../..')
export default defineConfig({ ...original, root, esbuild: { jsx: 'automatic' },
  cacheDir: resolve(root, '.cache/codex-paginated', process.env.AGENTMUX_PAGINATED_MUTANT ?? 'positive'),
  plugins: [{ name: 'paginated-user-actual-source', enforce: 'pre', transform(code, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!/^packages\/core\/(?:src|dist)\/providers\/codex-saved-history\.(?:ts|js)$/u.test(path)) return
    const original = code, mutant = process.env.AGENTMUX_PAGINATED_MUTANT
    const changes: Record<string, [string, string]> = {
      'omit-canonical-user': ['const canonicalUser = paginated &&', 'const canonicalUser = false &&'],
      'override-first-format': ["const paginated = payload.history_mode === 'paginated'", 'const paginated = true'],
      'drop-context-original': ["title = 'Model context'", 'return null']
    }
    if (mutant) {
      const change = changes[mutant]; if (!change) throw Error('Unknown paginated mutation')
      const anchor = change[0]
      const replacement = change[1]
      if (code.split(anchor).length !== 2) throw Error('Missing unique source mutation: ' + mutant + ' in ' + path)
      code = code.replace(anchor, replacement)
    }
    const sha = (value: string) => createHash('sha256').update(value).digest('hex')
    if (process.env.AGENTMUX_PAGINATED_LOADED) appendFileSync(process.env.AGENTMUX_PAGINATED_LOADED,
      JSON.stringify({ path, originalSHA256: sha(original), sha256: sha(code), ...(original === code ? {} : { mutant }) }) + '\n')
    if (original !== code) return { code, map: null }
  } }], test: { ...original.test, globalSetup: [], fileParallelism: false, maxWorkers: 1, passWithNoTests: false,
    include: ['packages/core/test/codex-paginated-user.test.ts',
      ...(process.env.AGENTMUX_PAGINATED_PUBLIC === '1' ? ['packages/client-ui/test/codex-paginated-consumer.test.tsx'] : []),
      ...(process.env.AGENTMUX_PAGINATED_ADJACENT === '1' ? ['packages/core/test/codex-saved-question-request.test.ts'] : [])] } })
