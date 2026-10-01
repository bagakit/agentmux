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
  cacheDir: resolve(root, '.bagakit/feature-tracker/terminal-native-user-intake-2026-10-05/t002/vite-cache'),
  plugins: [...(original.plugins ?? []), { name: 'native-first-window-actual-loaded-source', enforce: 'pre', transform(code, id) {
    const file = id.split('?')[0]!
    if (!(file.startsWith(root + '/apps/desktop/src/') || file.startsWith(root + '/packages/core/src/'))) return
    const before = code, mutation = process.env.AGENTMUX_FIRST_WINDOW_MUTATION
    const edits: Record<string, [string, string]> = {
      'bypass-first-window': ["if (mode === 'initial' || mode === 'replace') {", 'if (false) {'],
      'remove-user-stop': ["!items.some(item => item.kind === 'user-message')", 'true'],
      'bypass-window-budget': ['if (!withinWindow(combined)) {', 'if (false) {']
    }
    if (mutation && !edits[mutation]) throw new Error('Unknown first-window mutation ' + mutation)
    if (mutation && file === resolve(root, 'apps/desktop/src/renderer/src/lib/session-user-messages.ts')) {
      const edit = edits[mutation]!
      if (code.split(edit[0]).length !== 2) throw new Error('Missing unique first-window mutation ' + mutation)
      code = code.replace(edit[0], edit[1])
    }
    const log = process.env.AGENTMUX_FIRST_WINDOW_LOADED
    if (log) { mkdirSync(dirname(log), { recursive: true }); appendFileSync(log, JSON.stringify({ path: relative(root, file),
      originalSHA256: createHash('sha256').update(before).digest('hex'), sha256: createHash('sha256').update(code).digest('hex'), bytes: Buffer.byteLength(code), ...(before !== code ? { mutation } : {}) }) + '\n') }
    if (before !== code) return { code, map: null }
  } }],
  test: { ...original.test, globalSetup: [], include: ['apps/desktop/test/conversation-native-first-window.integration.test.tsx'],
    passWithNoTests: false, fileParallelism: false, testTimeout: 15_000 }
})
