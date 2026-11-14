import base from './conversation-detail-settings.config.mts'
import { defineConfig } from 'vitest/config'
export default defineConfig({ ...base, cacheDir: '.cache/conversation-detail-editor', test: { ...base.test,
 include: ['apps/desktop/test/conversation-detail-editor.test.tsx'], passWithNoTests:false } })
