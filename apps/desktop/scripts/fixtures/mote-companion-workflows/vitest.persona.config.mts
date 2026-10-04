import { defineConfig } from 'vitest/config'
import owning from '../mote-navigation-footer/vitest.owning.config.mts'

export default defineConfig({ ...owning, test: { ...owning.test,
  include: ['test/mote-cooperation.test.tsx', 'test/mote-behavior.test.ts', 'test/mote-materials-public-read.test.ts', 'test/mote-materials-inspection.test.tsx', 'test/mote-ideas.test.tsx',
    'test/mote-default-knowledge.test.ts', 'test/space-role-soul-session.test.ts'], passWithNoTests: false } })
