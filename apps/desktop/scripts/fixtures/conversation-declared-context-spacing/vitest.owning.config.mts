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
  cacheDir: resolve(root, '.bagakit/feature-tracker/conversation-input-cards-artifacts/T014/cache'),
  plugins: [...(original.plugins ?? []), { name: 'context-spacing-actual-loaded-source', enforce: 'pre', transform(code, id) {
    const file = id.split('?')[0]!
    if (!(file.startsWith(root + '/apps/desktop/src/') || file.startsWith(root + '/packages/core/src/'))) return
    const before = code, mutation = process.env.AGENTMUX_CONTEXT_SPACING_MUTATION
    const edits: Record<string, [string, string, string, number]> = {
      'bypass-separator-display': ['apps/desktop/src/renderer/src/components/ConversationMessage.tsx', "prefix.body.replace(/^(?:\\r?\\n){1,2}/u, '')", 'prefix.body', 1],
      'remove-fallback-class': ['apps/desktop/src/renderer/src/components/AgentMarkdown.tsx', "className={className ? `${className} md-paragraph` : 'md-paragraph'}", 'className={className}', 2],
      'trim-start-display': ['apps/desktop/src/renderer/src/components/ConversationMessage.tsx', "prefix.body.replace(/^(?:\\r?\\n){1,2}/u, '')", 'prefix.body.trimStart()', 1]
    }
    const edit = mutation ? edits[mutation] : undefined
    if (mutation && !edit) throw new Error('Unknown context spacing mutation ' + mutation)
    if (edit && file === resolve(root, edit[0])) {
      if (code.split(edit[1]).length !== edit[3] + 1) throw new Error('Missing unique context spacing mutation target ' + mutation)
      code = code.replaceAll(edit[1], edit[2])
    }
    const log = process.env.AGENTMUX_CONTEXT_SPACING_LOADED
    if (log) { mkdirSync(dirname(log), { recursive: true }); appendFileSync(log, JSON.stringify({ path: relative(root, file),
      originalSHA256: createHash('sha256').update(before).digest('hex'), sha256: createHash('sha256').update(code).digest('hex'), bytes: Buffer.byteLength(code), ...(before !== code ? { mutation } : {}) }) + '\n') }
    if (before !== code) return { code, map: null }
  } }],
  test: { ...original.test, globalSetup: [], include: ['apps/desktop/test/conversation-declared-context-spacing.integration.test.tsx'], passWithNoTests: false, fileParallelism: false }
})
