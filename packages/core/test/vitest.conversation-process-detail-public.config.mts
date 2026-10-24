import { defineConfig } from 'vitest/config'
import base from './vitest.conversation-process-detail.config.mts'
export default defineConfig({ ...base, cacheDir: '.cache/conversation-process-detail-public', test: { ...base.test, include: ['packages/core/test/conversation-process-detail-public.test.ts'], passWithNoTests: false } })
