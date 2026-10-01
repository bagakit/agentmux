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
const mutations: Record<string, { path: string; from: string; to: string }> = {
  'ignore-mailbox-visibility': { path: 'components/SessionMailbox.tsx', from: '{ enabled: open && visible }', to: '{ enabled: open }' },
  'ignore-composer-visibility': { path: 'components/AgentSessionComposer.tsx', from: '<SessionMailbox visible={visible}', to: '<SessionMailbox visible={true}' }
}
const mutation = process.env.AGENTMUX_MAILBOX_VISIBILITY_MUTATION
if (mutation && !mutations[mutation]) throw new Error('Unknown Mailbox visibility mutation ' + mutation)
export default defineConfig({ ...original, root, esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
  resolve: { alias: [...aliases, { find: 'react', replacement: resolve(root, 'apps/desktop/node_modules/react') }, { find: 'react-dom', replacement: resolve(root, 'apps/desktop/node_modules/react-dom') }] },
  cacheDir: resolve(root, '.tmp/shared-workbench-mailbox-visibility-20261005/vite-cache'),
  plugins: [...(original.plugins ?? []), { name: 'mailbox-visibility-actual-loaded-source', enforce: 'pre', transform(code, id) {
    const file = id.split('?')[0]!
    if (!(file.startsWith(root + '/apps/desktop/src/') || file.startsWith(root + '/packages/core/src/'))) return
    const before = code, edit = mutation ? mutations[mutation] : undefined
    if (edit && file === resolve(root, 'apps/desktop/src/renderer/src', edit.path)) {
      if (code.split(edit.from).length !== 2) throw new Error('Missing unique Mailbox visibility mutation ' + mutation)
      code = code.replace(edit.from, edit.to)
    }
    const log = process.env.AGENTMUX_MAILBOX_VISIBILITY_LOADED
    if (log) { mkdirSync(dirname(log), { recursive: true }); appendFileSync(log, JSON.stringify({ path: relative(root, file),
      originalSHA256: createHash('sha256').update(before).digest('hex'), sha256: createHash('sha256').update(code).digest('hex'), bytes: Buffer.byteLength(code), ...(before !== code ? { mutation } : {}) }) + '\n') }
    if (before !== code) return { code, map: null }
  } }],
  test: { ...original.test, globalSetup: [], include: ['apps/desktop/test/shared-workbench-mailbox-visibility.test.tsx'],
    passWithNoTests: false, fileParallelism: false, maxWorkers: 1, testTimeout: 15_000 }
})
