import { defineConfig } from 'vitest/config'
import base from './mesh-network-core.config.mts'
export default defineConfig({ ...base, test: { ...base.test, include: ['apps/host/test/mesh-network-joined.test.ts'], testTimeout: 180000, hookTimeout: 60000, passWithNoTests: false } })
