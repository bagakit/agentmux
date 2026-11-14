import { defineConfig } from 'vitest/config'
import source from './restored-future-input.config.mts'
export default defineConfig({ ...source, test: { ...source.test, include: ['apps/host/test/retained-start-future-input.test.ts'], testTimeout: 30000 } })
