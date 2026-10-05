import { defineConfig, defaultExclude } from 'vitest/config'
export default defineConfig({
  resolve: { conditions: ['browser'] }, ssr: { resolve: { conditions: ['browser'] } },
  define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
  test: { cache: false, include: ['apps/desktop/test/notebook-graph-input-cost.test.tsx'], exclude: defaultExclude,
    setupFiles: ['./vitest.setup.ts'], restoreMocks: true, clearMocks: true, testTimeout: 15000 }
})
