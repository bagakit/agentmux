import { defineConfig } from 'vitest/config'
import base from './outbound-relay.config.mts'
export default defineConfig({ ...base, test: { ...base.test, include: ['apps/host/test/outbound-relay-native.test.ts'], maxWorkers: 1, testTimeout: 150000, hookTimeout: 45000, passWithNoTests: false } })
