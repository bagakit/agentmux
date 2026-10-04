import { defineConfig } from 'vitest/config'
import base from '../../../vitest.config'
export default defineConfig({ ...base, test: { ...base.test, include: ['apps/desktop/test/inline-agent-link-ipc.test.ts'] } })
