import base from '../scripts/fixtures/browser-operation-feedback/vitest.owning.config.mts'
import { fileURLToPath } from 'node:url'
export default { ...base, resolve: { alias: [...base.resolve.alias,
  { find: /^@agentmux\/core\/(.+)$/, replacement: fileURLToPath(new URL('../../../packages/core/src/$1.ts', import.meta.url)) },
  { find: /^@agentmux\/identity$/, replacement: fileURLToPath(new URL('../../../packages/identity/src/index.ts', import.meta.url)) }
] }, test: { ...base.test, include: [
  'apps/desktop/test/browser-control-feedback.test.ts',
  'apps/desktop/test/browser-operation-feedback.test.ts',
  'apps/desktop/test/browser-page-action-feedback.test.ts'
], passWithNoTests: false, maxWorkers: 1, fileParallelism: false } }
