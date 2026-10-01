import { defineConfig } from 'vitest/config'
import original from './vitest.owning.config.mts'
export default defineConfig({ ...original, test: { ...original.test, include: ['apps/desktop/test/focus-context-recap-menu.test.tsx', 'apps/desktop/test/focus-context-card-interaction.test.tsx', 'apps/desktop/test/focus-narrow-filters.test.tsx'], passWithNoTests: false } })
