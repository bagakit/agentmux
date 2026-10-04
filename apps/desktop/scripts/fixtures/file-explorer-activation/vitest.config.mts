import { defineConfig } from 'vitest/config'
import original from '../../../../../vitest.config'
export default defineConfig({ ...original, resolve: { conditions: ['browser', 'import', 'default'] },
  ssr: { noExternal: ['@agentmux/client-ui'], resolve: { conditions: ['browser', 'import', 'default'] } },
  test: { ...original.test, include: ['apps/desktop/test/file-explorer-activation.test.tsx', 'apps/desktop/test/explorer-redesign.test.tsx',
    'apps/desktop/test/explorer-editing-polish.test.tsx', 'apps/desktop/test/workface-explorer-scope.test.tsx',
    'apps/desktop/test/region-caret-focus.test.ts', 'apps/desktop/test/workface-file-open-control.test.tsx'], fileParallelism: false, maxWorkers: 1, passWithNoTests: false } })
