import { defineConfig } from 'vitest/config'
import owning from '../mote-workspace/vitest.config.mts'

export default defineConfig({ ...owning, test: { ...owning.test,
  include: ['test/mote-initial-workface.test.tsx', 'test/workbench-projection-split.test.ts', 'test/topic-empty-workbench.test.tsx', 'test/mote-closed-tab-target.test.tsx', 'test/workbench-occurrence-selection.test.ts', 'test/survey-zone-reference.test.ts'],
  passWithNoTests: false, maxWorkers: 1
} })
