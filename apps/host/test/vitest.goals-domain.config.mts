import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
import goals from './vitest.mobile-goals.config.mjs'
export default defineConfig({ ...goals, define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
resolve: { ...goals.resolve, alias: [...(goals.resolve!.alias as any[]),
  { find: /^@agentmux\/native-desktop\/image$/u, replacement: resolve(import.meta.dirname, '../../../packages/native-desktop/src/image.ts') },
  { find: /^@agentmux\/native-desktop$/u, replacement: resolve(import.meta.dirname, '../../../packages/native-desktop/src/index.ts') }] },
test: { include: [
  'apps/host/test/agent-automation-boundaries.test.ts',
  'apps/host/test/goal-discussion-intent.test.ts',
  'apps/host/test/goal-dispatch-observation.test.ts',
  'apps/host/test/goal-desktop-watch.test.ts',
  'apps/host/test/goal-runtime-attention.test.ts',
  'apps/host/test/goal-participation-owner.test.ts',
  'apps/desktop/test/goal-host-invalidation.test.ts',
  'apps/desktop/test/continuous-progress-observation.test.tsx',
  'apps/desktop/test/continuous-progress-product.test.tsx',
  'apps/desktop/test/continuous-progress-loop-manager.test.ts',
  'apps/desktop/test/continuous-progress-unified-ingress.test.ts',
  'apps/desktop/test/goal-start-responsibility.test.ts',
  'apps/desktop/test/goal-delegation-attention.test.ts',
  'apps/desktop/test/goal-patrol.test.ts'
], maxWorkers: 1, fileParallelism: false } })
