import { defineConfig } from 'vitest/config'
import original from './vitest.owning.config.mts'
export default defineConfig({ ...original, test: { ...original.test, include: ['apps/desktop/test/focus-lane-information.test.tsx', 'apps/desktop/test/focus-card-information.test.tsx', 'apps/desktop/test/focus-project-lanes.test.ts', 'apps/desktop/test/mote-directory-focus.test.ts', 'apps/desktop/test/mote-icon-identity.test.tsx'], passWithNoTests: false, maxWorkers: 1, fileParallelism: false } })
