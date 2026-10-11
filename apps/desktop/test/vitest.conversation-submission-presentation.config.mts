import base from './vitest.conversation-source-labels.config.mts'
import { defineConfig } from 'vitest/config'
export default defineConfig({ ...base, cacheDir: '.cache/conversation-submission-presentation', test: { ...base.test,
  include: ['apps/desktop/test/conversation-submission-presentation.test.tsx', 'apps/desktop/test/conversation-source-labels.test.tsx', 'apps/desktop/test/conversation-collected-reply.test.tsx'] } })
