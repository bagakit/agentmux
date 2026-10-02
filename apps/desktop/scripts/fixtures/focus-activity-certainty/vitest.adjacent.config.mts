import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../../../vitest.config'
const root = resolve(import.meta.dirname, '../../../../..')
export default defineConfig({ ...original, root, resolve: { conditions: ['browser', 'import', 'default'] },
  ssr: { noExternal: ['@agentmux/client-ui'], resolve: { conditions: ['browser', 'import', 'default'] } },
  cacheDir: resolve(root, '.tmp/focus-activity-certainty-adjacent-cache'),
  test: { ...original.test, include: ['packages/core/test/provider-observation-contract.test.ts',
    'packages/core/test/agent-status-freshness.test.ts', 'apps/desktop/test/provider-observation-consumer.test.tsx',
    'apps/desktop/test/focus-context-cost.test.ts'], passWithNoTests: false, maxWorkers: 1, fileParallelism: false } })
