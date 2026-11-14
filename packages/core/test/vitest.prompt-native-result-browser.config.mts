import { defineConfig } from 'vitest/config'
import source from './vitest.prompt-native-result.config.mts'
export default defineConfig({ ...source, test: { ...source.test,
  include: ['packages/core/test/prompt-native-result-browser.test.ts'], passWithNoTests: false } })
