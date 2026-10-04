import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defaultExclude, defineConfig } from 'vitest/config'

// This task consumes current sources, including the new neutral package, rather than incidental dist.
const root = resolve(import.meta.dirname, '../../..')
const core = JSON.parse(readFileSync(resolve(root, 'packages/core/package.json'), 'utf8'))
const aliases = Object.entries(core.exports).map(([key, value]: [string, any]) => ({
  find: new RegExp('^' + (key === '.' ? '@agentmux/core' : '@agentmux/core/' + key.slice(2)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'),
  replacement: resolve(root, 'packages/core', value.import.replace('./dist/', './src/').replace(/\.js$/, '.ts'))
}))

export default defineConfig({
  root,
  define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
  resolve: { alias: [
    { find: /^@agentmux\/git\/types$/, replacement: resolve(root, 'packages/git/src/types.ts') },
    { find: /^@agentmux\/git$/, replacement: resolve(root, 'packages/git/src/index.ts') },
    ...aliases
  ], conditions: ['browser', 'import', 'default'] },
  ssr: { noExternal: ['@agentmux/client-ui', '@agentmux/git'], resolve: { conditions: ['browser', 'import', 'default'] } },
  test: {
    include: ['{apps,packages,test}/**/*.{test,spec}.?(c|m)[jt]s?(x)'],
    exclude: [...defaultExclude, '.worktrees/**', '.claude/worktrees/**'],
    setupFiles: [resolve(root, 'vitest.setup.ts')],
    passWithNoTests: false,
    fileParallelism: false,
    maxWorkers: 1
  }
})
