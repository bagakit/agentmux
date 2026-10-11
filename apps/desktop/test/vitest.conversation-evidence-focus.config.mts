import base from './vitest.conversation-evidence-labels.config.mts'
import { defineConfig } from 'vitest/config'
export default defineConfig({ ...base, test: { ...base.test,
  include: ['apps/desktop/test/focus-conversation-timeline.test.tsx', 'apps/desktop/test/focus-timeline-conversation-records.test.tsx'],
  testNamePattern: 'the real Focus preview consumes Core observation|the actual Focus consumer labels one retained Core observation'
} })
