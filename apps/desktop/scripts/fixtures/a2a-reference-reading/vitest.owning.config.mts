import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { readingMutations } from './mutations.mjs'

const root = resolve(import.meta.dirname, '../../../../..')
const pkg = JSON.parse(readFileSync(resolve(root, 'packages/core/package.json'), 'utf8'))
const aliases = Object.entries(pkg.exports).flatMap(([name, value]) => {
  const source = resolve(root, 'packages/core/src/' + (value as { import: string }).import.replace('./dist/', '').replace(/\.js$/u, '.ts'))
  const spec = name === '.' ? '@agentmux/core' : '@agentmux/core' + name.slice(1)
  return existsSync(source) ? [{ find: new RegExp('^' + spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'), replacement: source }] : []
})

// This gate consumes the actual local source for all internal packages; it does
// not use another worktree's Core dist or waive its freshness requirement.
export default defineConfig({
  root,
  cacheDir: process.env.AGENTMUX_A2A_REFERENCE_CACHE ?? resolve(root, '.tmp/a2a-reference-reading/vite'),
  define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
  ssr: { noExternal: ['@agentmux/client-ui'], resolve: { conditions: ['browser', 'import', 'default'] } },
  esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
  resolve: { conditions: ['browser', 'import', 'default'], alias: [...aliases,
    { find: /^@agentmux\/identity$/u, replacement: resolve(root, 'packages/identity/src/index.ts') },
    { find: /^react$/u, replacement: resolve(root, 'packages/client-ui/node_modules/react') },
    { find: /^react-dom(?:\/(.*))?$/u, replacement: resolve(root, 'packages/client-ui/node_modules/react-dom') + '/$1' }] },
  plugins: [{ name: 'a2a-reference-actual-compiler-input', enforce: 'pre', transform(code, id) {
    const file = id.split('?')[0]!
    if (!['packages/core/src/', 'packages/client-ui/src/', 'packages/identity/src/', 'apps/desktop/src/',
      'packages/core/test/', 'packages/client-ui/test/', 'apps/desktop/test/', 'apps/desktop/scripts/lib/', 'test/'].some(path => file.startsWith(resolve(root, path) + '/'))) return
    const before = code, mutation = process.env.AGENTMUX_A2A_REFERENCE_MUTATION
    const edit = mutation ? readingMutations.find(item => item.label === mutation) : undefined
    if (mutation && !edit) throw new Error('Unknown A2A reference mutation')
    if (edit && file === resolve(root, edit.path)) {
      if (code.split(edit.before).length !== 2) throw new Error('Missing unique A2A reference mutation target: ' + edit.label)
      code = code.replace(edit.before, edit.after)
    }
    const log = process.env.AGENTMUX_A2A_REFERENCE_LOADED
    if (log) {
      mkdirSync(dirname(log), { recursive: true })
      const hash = (text: string) => createHash('sha256').update(text).digest('hex')
      appendFileSync(log, JSON.stringify({ path: relative(root, file), sourceSHA256: hash(before), compilerInputSHA256: hash(code), bytes: Buffer.byteLength(code),
        ...(code !== before ? { mutation } : {}) }) + '\n')
    }
    if (code !== before) return { code, map: null }
  } }],
  test: { globals: false, passWithNoTests: false, fileParallelism: false, server: { deps: { inline: ['@agentmux/client-ui'] } }, include: [
    'packages/core/test/agent-message-reference-reading.test.ts',
    'packages/core/test/agent-message-render.test.ts',
    'packages/core/test/agent-message-leading-context.test.ts',
    'packages/client-ui/test/a2a-reference-reading.test.tsx',
    'packages/client-ui/test/conversation-leading-context.test.tsx',
    'apps/desktop/test/mailbox-a2a.test.tsx',
    'apps/desktop/test/input-mailbox-body-boundary.test.tsx',
    'apps/desktop/test/session-mailbox-author-boundary.test.tsx'
  ] }
})
