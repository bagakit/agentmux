import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from '../note-restore/vitest.owning.config.mts'

const root = fileURLToPath(new URL('../../../../../', import.meta.url))
export default defineConfig({
  ...base,
  cacheDir: resolve(root, '.tmp/shared-session-recovery/vite-cache'),
  resolve: { ...base.resolve, alias: [
    { find: /^@agentmux\/client-ui\/components\/(.+)$/, replacement: resolve(root, 'packages/client-ui/src/components/$1.tsx') },
    { find: /^@agentmux\/client-ui\/platform$/, replacement: resolve(root, 'packages/client-ui/src/platform.tsx') },
    { find: /^@agentmux\/client-ui\/(.+)$/, replacement: resolve(root, 'packages/client-ui/src/lib/$1.ts') },
    { find: /^@agentmux\/client-ui$/, replacement: resolve(root, 'packages/client-ui/src/index.ts') },
    ...(base.resolve?.alias ?? [])
  ] },
  test: { ...base.test, include: ['apps/desktop/test/shared-session-recovery.test.tsx'] }
})
