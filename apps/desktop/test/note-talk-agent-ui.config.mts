import { defineConfig, defaultExclude } from 'vitest/config'
export default defineConfig({
  resolve: { conditions: ['browser'] }, ssr: { resolve: { conditions: ['browser'] } },
  define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
  test: { cache: false, include: ['apps/desktop/test/note-talk-agent-ui.test.tsx'], exclude: defaultExclude, setupFiles: ['./vitest.setup.ts'],
    restoreMocks: true, clearMocks: true, testTimeout: 15000, hookTimeout: 15000 }
})
