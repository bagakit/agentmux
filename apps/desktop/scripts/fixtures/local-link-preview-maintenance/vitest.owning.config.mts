import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { sourceAliases as desktopSourceAliases } from '../bookmark-local-link/vitest.owning.config.mts'
const repository = resolve(import.meta.dirname, '../../../../..')
export const sourceAliases = desktopSourceAliases
export default defineConfig({
  root: repository, resolve: { alias: sourceAliases, conditions: ['browser', 'development', 'import', 'default'] }, define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
  test: { include: ['apps/desktop/test/markdown*.test.ts*', 'apps/desktop/test/agent-markdown*.test.ts*', 'apps/desktop/test/file-preview-open.test.tsx',
    'apps/desktop/test/terminal-path-link.test.ts', 'apps/desktop/test/conversation-image*.test.tsx', 'apps/desktop/test/pasted-image-read.test.ts'],
    setupFiles: [resolve(repository, 'vitest.setup.ts')], server: { deps: { inline: ['@agentmux/client-ui'] } },
    passWithNoTests: false, maxWorkers: 1, fileParallelism: false, testTimeout: 45000 },
  cacheDir: resolve(repository, '.tmp/local-link-preview-maintenance/cache')
})
