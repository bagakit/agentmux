import { defineConfig } from 'vitest/config'
import base from './hook-postcommit-observation.vitest.config.mts'
export default defineConfig({ ...base, test: { ...base.test, include: ['packages/core/test/session-resumed-interruption.test.ts', 'packages/core/test/session-recovery-interruption.test.ts'], passWithNoTests: false, testTimeout: 20_000 } })
