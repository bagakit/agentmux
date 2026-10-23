import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { aliases, installedDependency, root } from '../scripts/fixtures/settings-resource-library/environment.mjs'

export default defineConfig({
  root, define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
  resolve: { alias: [
    { find: /^@agentmux\/capsule\/node$/u, replacement: resolve(root, 'packages/capsule/src/node.ts') },
    { find: /^@agentmux\/capsule$/u, replacement: resolve(root, 'packages/capsule/src/index.ts') }, ...aliases
  ] },
  plugins: [{ name: 'capsule-settings-installed-dependencies', enforce: 'pre', resolveId: installedDependency }],
  test: { include: ['apps/desktop/test/capsule-settings.test.tsx', 'apps/desktop/test/capsule-settings-runtime.test.tsx'], setupFiles: [resolve(root, 'vitest.setup.ts')],
    maxWorkers: 1, passWithNoTests: false, testTimeout: 45000 }
})
