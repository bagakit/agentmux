import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defaultExclude, defineConfig } from 'vitest/config'

// Resolve the owning workspace graph from this checkout (or the private mutation copy).
// Third-party dependencies may be shared; incidental main-tree dist cannot certify this source.
const root = resolve(import.meta.dirname, '../../..')
const aliases = ['packages/core', 'packages/demand', 'packages/layout', 'packages/git', 'packages/capsule', 'packages/relay', 'packages/diagnostic-evidence', 'apps/host'].flatMap(directory => {
  const manifest = JSON.parse(readFileSync(resolve(root, directory, 'package.json'), 'utf8'))
  return Object.entries(manifest.exports).map(([key, value]: [string, any]) => ({
    find: key === '.' ? manifest.name : manifest.name + key.slice(1),
    replacement: resolve(root, directory, (typeof value === 'string' ? value : value.import)
      .replace('./dist/src/', './src/').replace('./dist/', './src/').replace(/\.js$/, '.ts'))
  }))
}).sort((left, right) => right.find.length - left.find.length)

export default defineConfig({
  root,
  plugins: [{ name: 'git-current-workspace-sources', enforce: 'pre', transform(_source, id) {
    // A copied mutation suite must not follow workspace symlinks back into the author's tree.
    if (/\/(?:packages\/(?:core|demand|layout|git|identity|capsule|relay|diagnostic-evidence|client-ui)|apps\/(?:host|desktop))\/(?:src|dist)\//.test(id)) {
      if (!id.startsWith(root + '/') || /\/dist\//.test(id)) throw new Error('Git tests require current workspace source: ' + id)
    }
  } }],
  define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
  resolve: { alias: [
    { find: /^@agentmux\/identity$/, replacement: resolve(root, 'packages/identity/src/index.ts') },
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
