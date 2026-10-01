import { fixtureCivil as _hygiene_fixtureCivil } from "../../lib/fixture-values.mjs"
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../../../vitest.config'

const root = resolve(import.meta.dirname, '../../../../..')
const pkg = JSON.parse(readFileSync(resolve(root, 'packages/core/package.json'), 'utf8'))
const aliases = Object.entries(pkg.exports).flatMap(([name, value]) => {
  const source = resolve(root, 'packages/core/src/' + (value as { import: string }).import.replace('./dist/', '').replace(/\.js$/u, '.ts'))
  const spec = name === '.' ? '@agentmux/core' : '@agentmux/core' + name.slice(1)
  return existsSync(source) ? [{ find: new RegExp('^' + spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'), replacement: source }] : []
})
export default defineConfig({ ...original, root, esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
  resolve: { alias: [...aliases, { find: 'react', replacement: resolve(root, 'apps/desktop/node_modules/react') }, { find: 'react-dom', replacement: resolve(root, 'apps/desktop/node_modules/react-dom') }] },
  cacheDir: resolve(root, (".bagakit/feature-tracker/terminal-native-followup-" + _hygiene_fixtureCivil(10, 5) + "/ui-vite-cache")),
  plugins: [...(original.plugins ?? []), { name: 'native-first-window-actual-loaded-source', enforce: 'pre', transform(code, id) {
    const file = id.split('?')[0]!
    if (!(file.startsWith(root + '/apps/desktop/src/') || file.startsWith(root + '/packages/core/src/'))) return
    const before = code, mutation = process.env.AGENTMUX_OPEN_WRITER_MUTATION
    if (mutation && mutation !== 'parent-only') throw new Error('Unknown open-writer mutation ' + mutation)
    if (mutation && file === resolve(root, 'packages/core/src/native-history-source-observer.ts')) {
      const anchor = 'watch(path, { persistent: false }, () => check())'
      if (code.split(anchor).length !== 2) throw new Error('Missing unique exact-file watch mutation anchor')
      code = code.replace(anchor, "watch(dirname(path), { persistent: false }, (_event, filename) => { if (filename?.toString() === basename(path)) check() })")
    }
    const log = process.env.AGENTMUX_OPEN_WRITER_LOADED
    if (log) { mkdirSync(dirname(log), { recursive: true }); appendFileSync(log, JSON.stringify({ path: relative(root, file),
      originalSHA256: createHash('sha256').update(before).digest('hex'), sha256: createHash('sha256').update(code).digest('hex'), bytes: Buffer.byteLength(code), ...(before !== code ? { mutation } : {}) }) + '\n') }
    if (before !== code) return { code, map: null }
  } }],
  test: { ...original.test, globalSetup: [], include: ['apps/desktop/test/conversation-native-open-writer.integration.test.tsx'],
    passWithNoTests: false, fileParallelism: false, testTimeout: 15_000 }
})
