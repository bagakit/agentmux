import { defineConfig } from 'vitest/config'
import owning from './vitest.mote-context.config.mts'

export default defineConfig({ ...owning, test: { ...owning.test,
  environment: 'happy-dom',
  include: ['apps/desktop/test/topic-knowledge-ui.test.tsx', 'apps/desktop/test/topic-category-spatial.test.ts'],
  testNamePattern: /keeps a new Topic content identity|opens a new discussion Tab|creates a canonical Topic from the mounted|binds the canonical identity without reclaiming|hydrates content identity/,
  passWithNoTests: false
} })
