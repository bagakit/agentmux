import { defineConfig } from 'vitest/config'
import owning from './selection-field.config.mts'
export default defineConfig({ ...owning, test: { ...owning.test, include: ['test/mote-session-recovery.test.tsx', 'test/mote-startup-recovery.test.ts', 'test/mote-quick-mode.test.tsx'], passWithNoTests: false } })
