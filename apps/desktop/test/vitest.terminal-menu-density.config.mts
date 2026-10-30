import { defineConfig } from 'vitest/config'
import source from './vitest.mote-context.config.mts'

export default defineConfig({
  ...source,
  test: { ...source.test, include: ['apps/desktop/test/terminal-menu-density.test.tsx', 'apps/desktop/test/terminal-region-menu-consumer.test.tsx'] }
})
