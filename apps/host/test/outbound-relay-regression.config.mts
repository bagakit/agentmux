import { defineConfig } from 'vitest/config'
import base from './outbound-relay.config.mts'
export default defineConfig({ ...base, test: { ...base.test, include: ['apps/host/test/outbound-relay.test.ts', 'packages/core/test/relay-host-identity.test.ts', 'packages/core/test/relay-owner-context.test.ts', 'packages/core/test/public-rpc-device-recovery.test.ts'], testTimeout: 30000 } })
