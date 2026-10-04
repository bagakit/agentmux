import { defineConfig } from 'vitest/config'
import owning from '../mote-navigation-footer/vitest.owning.config.mts'
export default defineConfig({ ...owning, test: { ...owning.test,
  include: ['test/mote-quick-mode.test.tsx', 'test/mote-quick-mode-storage.test.ts', 'test/mote-behavior-document.test.ts', 'test/mote-materials-public-read.test.ts'], passWithNoTests: false } })
