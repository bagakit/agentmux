import { defineConfig } from 'vitest/config'
import original from '../../../../../vitest.config'
export default defineConfig({ ...original, resolve: { conditions: ['browser', 'import', 'default'] },
 ssr: { noExternal: ['@agentmux/client-ui'], resolve: { conditions: ['browser', 'import', 'default'] } },
 test: { ...original.test, include: ['apps/desktop/test/file-explorer-scratch-physical-path.test.tsx',
 'apps/desktop/test/file-explorer-refresh.test.ts', 'apps/desktop/test/file-explorer-foundations.test.ts',
 'apps/desktop/test/file-explorer-open-as-project.integration.test.tsx'], passWithNoTests: false,
 fileParallelism: false, maxWorkers: 1, testTimeout: 15000 } })
