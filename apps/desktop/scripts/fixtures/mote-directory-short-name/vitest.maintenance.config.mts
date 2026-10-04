import { defineConfig } from 'vitest/config'
import owning from './vitest.config.mts'
export default defineConfig({ ...owning, test: { ...owning.test, include: ['test/mote-directory-short-maintenance.test.ts', 'test/mote-primary-directory.test.ts', 'test/mote-directory-identity.test.ts'], passWithNoTests: false, maxWorkers: 1, testTimeout: 20000 } })
