import { defineConfig } from 'vitest/config'
import base from './storage-recovery-capture.config.mts'
export default defineConfig({ ...base, test: { ...base.test, include: ['packages/core/test/storage-restore.test.ts'], testTimeout: 30000 } })
