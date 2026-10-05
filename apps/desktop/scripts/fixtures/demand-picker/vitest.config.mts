import { defineConfig } from 'vitest/config'
import original from '../demand-activity/vitest.config.mts'
export default defineConfig({ ...original, test: { ...original.test, include: ['test/mote-daily-goal.test.tsx'], passWithNoTests: false } })
