import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

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
  esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
  resolve: { conditions: ['browser', 'import', 'default'], alias: [...aliases,
    { find: /^@agentmux\/identity$/u, replacement: resolve(root, 'packages/identity/src/index.ts') },
    { find: /^react$/u, replacement: resolve(root, 'packages/client-ui/node_modules/react') },
    { find: /^react-dom(?:\/(.*))?$/u, replacement: resolve(root, 'packages/client-ui/node_modules/react-dom') + '/$1' }] },
  test: { globals: false, passWithNoTests: false, fileParallelism: false, include: [
    'packages/core/test/agent-message-reference-reading.test.ts',
    'packages/core/test/agent-message-render.test.ts',
    'packages/core/test/agent-message-leading-context.test.ts'
  ] }
})
