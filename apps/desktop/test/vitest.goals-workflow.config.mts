import { resolve } from 'node:path'
import original from '../scripts/fixtures/demand-current-work/vitest.config.mts'

const repository = resolve(import.meta.dirname, '../../..')
// Current Core/Host/Demand owners; Native I/O is controlled by the discussion fixture.
export default { ...original, resolve: { ...original.resolve, alias: [
  { find: /^@agentmux\/identity\/runtime-source$/u, replacement: resolve(repository, 'packages/identity/dist/runtime-source.js') },
  { find: /^@agentmux\/host\/(.+)$/u, replacement: resolve(repository, 'apps/host/src/$1.ts') },
  ...(original.resolve?.alias as Array<{ find: RegExp; replacement: string }> ?? [])
] }, test: { ...original.test, root: repository,
  include: [
    'apps/desktop/test/goals-alignment-workflow.test.tsx', 'apps/desktop/test/goals-intake-surface.test.tsx',
    'apps/desktop/test/goal-consensus-icon-feedback.test.tsx', 'apps/desktop/test/goal-evidence-cli.test.ts',
    'apps/desktop/test/goals-page-maturity.test.tsx', 'apps/desktop/test/goal-stale-read-ordering.test.tsx',
    'apps/desktop/test/goal-properties-civil-date.test.tsx', 'apps/desktop/test/goal-delegation-work.test.tsx',
    'apps/desktop/test/global-board-demand-workspace.test.tsx'
  ],
  maxWorkers: 1, fileParallelism: false, passWithNoTests: false } }
