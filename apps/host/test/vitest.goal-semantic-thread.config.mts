import { defineConfig } from 'vitest/config'
import original from './vitest.goal-cross-host.config.mts'
export default defineConfig({ ...original, test: { ...original.test, include: ['apps/host/test/goal-semantic-thread.test.ts'], passWithNoTests: false } })
