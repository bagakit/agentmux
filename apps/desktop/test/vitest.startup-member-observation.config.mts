import { defineConfig } from 'vitest/config'
import source from './vitest.mote-context.config.mts'
export default defineConfig({ ...source, test: { ...source.test, setupFiles: [], globalSetup: [],
  include: ['apps/desktop/test/space-mount-preload.test.ts'], passWithNoTests: false } })
