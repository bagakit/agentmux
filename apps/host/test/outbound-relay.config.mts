import { defineConfig } from 'vitest/config'
import base from '../../../packages/core/test/relay-owner-context.config.mts'
export default defineConfig({ ...base, test: { ...base.test, include: ['apps/host/test/outbound-relay.test.ts'], testTimeout: 25000 } })
