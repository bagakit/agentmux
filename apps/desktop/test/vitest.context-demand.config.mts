import { defineConfig } from 'vitest/config'
import original from './vitest.composer-tools-first-presentation.config.mts'

// Keep the maintained real Workspace fixture and exact-source mutation binding.
export default defineConfig({
  ...original,
  test: {
    ...original.test,
    include: [
      'apps/desktop/test/composer-tools-first-presentation.test.tsx',
      'apps/desktop/test/agent-context-hover.test.tsx'
    ],
    exclude: [], passWithNoTests: false
  }
})
