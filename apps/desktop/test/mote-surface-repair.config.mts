import { defineConfig } from 'vitest/config'
import owning from './selection-field.config.mts'
export default defineConfig({ ...owning, test: { ...owning.test, include: [
  'test/mote-conversation-mode.test.tsx', 'test/mote-details-cost.test.tsx', 'test/mote-floating-profile.test.tsx'
], passWithNoTests: false } })
