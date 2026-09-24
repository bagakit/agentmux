import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..')
const packageRoot = resolve(root, 'packages/core')
const exports = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')).exports
const require = createRequire(resolve(root, 'apps/desktop/package.json'))

// UI tests consume actual Core source exports, preserving the normal git fixture setup.
// They do not rebuild shared dist or establish compiled Core/Native qualification.
export default defineConfig({
  root,
  define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
  resolve: {
    alias: [...['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom/client'].map((key) => ({
      find: new RegExp(`^${key}$`), replacement: require.resolve(key)
    })), ...Object.entries(exports).map(([key, target]) => ({
      find: new RegExp(`^@agentmux/core${key === '.' ? '' : key.slice(1)}$`),
      replacement: resolve(packageRoot, (target as { import: string }).import.replace('./dist/', './src/').replace(/\.js$/, '.ts'))
    })), { find: /^@agentmux\/demand$/, replacement: resolve(root, 'packages/demand/src/index.ts') }]
  },
  test: {
    include: [
      'apps/desktop/test/settings-overview.test.tsx',
      'apps/desktop/test/settings-structure.test.tsx',
      'apps/desktop/test/settings-workbench.test.tsx',
      'apps/desktop/test/settings-draft-conflict.test.tsx',
      'apps/desktop/test/settings-search.test.ts'
    ],
    setupFiles: [resolve(root, 'vitest.setup.ts')],
    maxWorkers: 1
  }
})
