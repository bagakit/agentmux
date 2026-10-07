import { defineConfig } from 'vitest/config'
import shared from './vitest.owning.config.mts'
export default defineConfig({ ...shared, test: { ...shared.test, include: [
  'apps/desktop/test/agent-information-card.test.tsx',
  'apps/desktop/test/agent-reading-preview.test.tsx'
], passWithNoTests: false } })
