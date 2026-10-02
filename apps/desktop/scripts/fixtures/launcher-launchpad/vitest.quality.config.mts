import { defineConfig } from 'vitest/config'
import base from '../mote-navigation-footer/vitest.owning.config.mts'
export default defineConfig({ ...base, esbuild: { jsx: 'automatic' }, test: { ...base.test,
  include: ['test/launcher-product-targets.test.tsx', 'test/launcher-input-ownership.test.tsx', 'test/launcher-empty-group-inputs.test.tsx', 'test/launcher-utility-quality.test.tsx',
    'test/launcher-entry-polish.test.tsx', 'test/launcher-resume-picker.test.tsx', 'test/launcher-mote-create.test.tsx',
    'test/mote-archive-interaction.test.tsx', 'test/launcher-submit.test.ts'],
  exclude: [], passWithNoTests: false, maxWorkers: 1 } })
