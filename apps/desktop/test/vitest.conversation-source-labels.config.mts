import base from './vitest.conversation-unified-consumers.config.mts'
import { defineConfig } from 'vitest/config'
export default defineConfig({...base,cacheDir:'.cache/conversation-source-labels',test:{...base.test,include:['apps/desktop/test/conversation-source-labels.test.tsx']}})
