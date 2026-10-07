import { defineConfig } from 'vitest/config'
import owning from './selection-field.config.mts'
export default defineConfig({ ...owning, test: { ...owning.test, include: ['test/selection-local-query.test.tsx', 'test/selection-field.test.tsx'], passWithNoTests: false } })
