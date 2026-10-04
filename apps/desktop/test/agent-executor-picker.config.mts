import { defineConfig } from 'vitest/config'
import owning from './selection-field.config.mts'
export default defineConfig({ ...owning, test: { ...owning.test, include: ['test/mote-executor-identity.test.tsx', 'test/agent-executor-picker.test.tsx', 'test/mote-quick-mode.test.tsx', 'test/selection-field.test.tsx'], passWithNoTests: false } })
