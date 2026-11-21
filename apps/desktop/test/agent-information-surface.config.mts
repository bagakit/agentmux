import { defineConfig } from 'vitest/config'
import base from './vitest.ui-controls-owning.config.mts'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
export default defineConfig({ ...base, resolve: { ...base.resolve, alias: [
  { find: /^@agentmux\/identity\/runtime-source$/, replacement: resolve(realpathSync(resolve(root, 'packages/core/node_modules/@agentmux/identity')), 'dist/runtime-source.js') },
  ...base.resolve!.alias as []
] }, test: { ...base.test, environment: 'happy-dom', include: ['apps/desktop/test/agent-information-surface.test.tsx',
  'apps/desktop/test/agent-status-prompt-actions.test.tsx', 'apps/desktop/test/composer-session-controls.test.tsx'],
  passWithNoTests: false, fileParallelism: false, maxWorkers: 1, testTimeout: 15000 } })
