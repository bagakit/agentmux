import { defineConfig } from 'vitest/config'
import ui from './vitest.ui.config.mts'
import source from './vitest.config.mjs'
import { fileURLToPath } from 'node:url'

// Exercise the actual Desktop bridge with source-owned Host/Core exports; shared dist is not a test input.
export default defineConfig({ ...ui,
  resolve: { alias: [{ find: '@agentmux/identity/runtime-source', replacement: fileURLToPath(new URL('../../../../../packages/identity/dist/runtime-source.js', import.meta.url)) }, ...source.resolve.alias, ...ui.resolve.alias] },
  test: { ...ui.test, setupFiles: [...ui.test.setupFiles, ...source.test.setupFiles], include: ['test/calendar-schedule-control.test.tsx', 'test/continuous-progress-panel.test.tsx', 'test/continuous-progress-product.test.tsx'] }
})
