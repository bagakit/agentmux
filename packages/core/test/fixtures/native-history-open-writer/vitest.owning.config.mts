import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../../../vitest.config.ts'

const root = resolve(import.meta.dirname, '../../../../..')
const target = 'packages/core/src/native-history-source-observer.ts'

export default defineConfig({ ...original, root,
  cacheDir: resolve(root, '.bagakit/feature-tracker/terminal-native-followup/core-vite-cache'),
  plugins: [...(original.plugins ?? []), { name: 'native-open-writer-loaded-source', enforce: 'pre', transform(code, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!path.startsWith('packages/core/src/') || !/\.ts$/u.test(path)) return
    const before = code, mutation = process.env.AGENTMUX_NATIVE_OPEN_WRITER_MUTATION
    if (mutation && mutation !== 'parent-only') throw new Error('Unknown native source mutation ' + mutation)
    if (mutation && path === target) {
      const anchor = 'watch(path, { persistent: false }, () => check())'
      if (code.split(anchor).length !== 2) throw new Error('Missing unique exact-file watch')
      code = code.replace(anchor, 'watch(dirname(path), { persistent: false }, () => check())')
    }
    const output = process.env.AGENTMUX_NATIVE_OPEN_WRITER_LOADED
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    if (output) appendFileSync(output, JSON.stringify({ path, originalSHA256: hash(before), sha256: hash(code),
      bytes: Buffer.byteLength(code), ...(before !== code ? { mutation } : {}) }) + '\n')
    if (before !== code) return { code, map: null }
  } }],
  // Every tested public caller imports Core Source; no shared dist build or freshness claim.
  test: { ...original.test, globalSetup: [], include: ['packages/core/test/native-history-open-writer.test.ts'],
    passWithNoTests: false, fileParallelism: false }
})
