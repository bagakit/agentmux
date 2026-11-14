import { defineConfig } from 'vitest/config'
import base from './outbound-relay.config.mts'
export default defineConfig({ ...base, test: { ...base.test, include: ['apps/host/test/mesh-network-host-lifetime.test.ts', 'apps/host/test/device-authority-admission.test.ts'], maxWorkers: 1, testTimeout: 30000, hookTimeout: 30000, passWithNoTests: false } })
