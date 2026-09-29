import { defineConfig } from 'vitest/config'
import promptsConfig from '../settings-prompts/vitest.config.mts'

export default defineConfig({
  ...promptsConfig,
  test: {
    ...promptsConfig.test,
    include: [
      ...promptsConfig.test!.include!,
      'apps/desktop/test/settings-liquid-selection.test.tsx',
      'apps/desktop/test/settings-prompts-liquid.test.tsx'
    ]
  }
})
