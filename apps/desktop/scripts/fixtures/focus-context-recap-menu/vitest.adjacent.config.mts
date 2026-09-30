import { defineConfig } from 'vitest/config'
import original from '../../../../../vitest.config'
export default defineConfig({ ...original, test: { ...original.test,
  include: ['apps/desktop/test/focus-card-information.test.tsx', 'apps/desktop/test/focus-context-readability.test.tsx', 'apps/desktop/test/focus-context-cost.test.ts', 'apps/desktop/test/agent-roster-menu.test.ts', 'apps/desktop/test/agent-address.test.ts', 'apps/desktop/test/region-context-menu.test.tsx', 'apps/desktop/test/launcher-resume-picker.test.tsx'],
  passWithNoTests: false, fileParallelism: false, maxWorkers: 1
} })
