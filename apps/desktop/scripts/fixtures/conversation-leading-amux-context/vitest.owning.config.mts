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
  cacheDir: resolve(root, '.bagakit/feature-tracker/conversation-input-cards-artifacts/T013/cache'),
  plugins: [...(original.plugins ?? []), { name: 'leading-amux-actual-loaded-source', enforce: 'pre', transform(code, id) {
    const file = id.split('?')[0]!
    if (!(file.startsWith(root + '/apps/desktop/src/') || file.startsWith(root + '/packages/core/src/'))) return
    const before = code, mutation = process.env.AGENTMUX_LEADING_AMUX_MUTATION
    const edits: Record<string, [string, string, string]> = {
      'swallow-tail': ['packages/core/src/agent-message-render.ts', 'declaredContexts, body: text.slice(end)', "declaredContexts, body: ''"],
      'consume-indented-continuation': ['packages/core/src/agent-message-render.ts', '/^(?:\\r?\\n)*/u', '/^[\\t\\r\\n ]*/u'],
      'copy-body-only': ['apps/desktop/src/renderer/src/components/ConversationMessage.tsx', "const text = parts.map(partText).filter((t) => t.length > 0).join('\\n')",
        "const text = prefix?.body ?? parts.map(partText).filter((t) => t.length > 0).join('\\n')"]
    }
    const edit = mutation ? edits[mutation] : undefined
    if (mutation && !edit) throw new Error('Unknown leading amux mutation ' + mutation)
    if (edit && file === resolve(root, edit[0])) {
      if (code.split(edit[1]).length !== 2) throw new Error('Missing unique leading amux mutation target ' + mutation)
      code = code.replace(edit[1], edit[2])
    }
    const log = process.env.AGENTMUX_LEADING_AMUX_LOADED
    if (log) { mkdirSync(dirname(log), { recursive: true }); appendFileSync(log, JSON.stringify({ path: relative(root, file),
      originalSHA256: createHash('sha256').update(before).digest('hex'), sha256: createHash('sha256').update(code).digest('hex'), bytes: Buffer.byteLength(code), ...(before !== code ? { mutation } : {}) }) + '\n') }
    if (before !== code) return { code, map: null }
  } }],
  test: { ...original.test, globalSetup: [], include: ['apps/desktop/test/conversation-leading-amux-context.integration.test.tsx'], passWithNoTests: false, fileParallelism: false }
})
