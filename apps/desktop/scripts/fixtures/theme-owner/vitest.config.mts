import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
export default defineConfig({
  resolve: { alias: [{ find: /^@agentmux\/client-ui\/theme$/, replacement: resolve(import.meta.dirname, '../../../../../packages/client-ui/src/theme/index.ts') }] },
  define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
  test: { include: ['apps/desktop/test/theme-owner-runtime.test.tsx', 'apps/desktop/test/gallery-appearance.test.tsx', 'apps/desktop/test/settings-draft-conflict.test.tsx'], environment: 'happy-dom', maxWorkers: 1 }
})
