import { defineConfig } from 'vitest/config'
export default defineConfig({
  resolve: { conditions: ['browser', 'import', 'default'] },
  ssr: { noExternal: ['@agentmux/client-ui'], resolve: { conditions: ['browser', 'import', 'default'] } },
  define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
  test: { cache: false, include: ['apps/desktop/test/notebook-page-details-cost.test.tsx'],
    setupFiles: ['./vitest.setup.ts'], restoreMocks: true, clearMocks: true, testTimeout: 15000,
    server: { deps: { inline: ['@agentmux/client-ui'] } }, passWithNoTests: false }
})
