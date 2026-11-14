import { defineConfig } from 'vitest/config'
import source from './takeover-flow.config.mts'
export default defineConfig({ ...source, test: { ...source.test,
  include: ['apps/desktop/test/space-create-topic.test.tsx'], passWithNoTests: false } })
