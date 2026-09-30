import { defineConfig } from 'vitest/config'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import original from '../../../../../vitest.config'
const root = resolve(import.meta.dirname, '../../../../..')
export default defineConfig({
  ...original, root,
  server: { fs: { allow: [root, ...['core','demand','layout'].map(name => realpathSync(resolve(root,'node_modules/@agentmux',name)))] } },
  cacheDir: resolve(root,'.tmp/focus-timeline-name-width-adjacent-cache'),
  test: { ...original.test, include: ['apps/desktop/test/project-rail-resize.test.tsx','apps/desktop/test/focus-timeline-navigation.test.tsx','apps/desktop/test/recent-focus-timeline.test.tsx'], passWithNoTests: false, fileParallelism: false, maxWorkers: 1 }
})
