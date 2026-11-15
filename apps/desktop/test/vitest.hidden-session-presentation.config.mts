import { defineConfig } from 'vitest/config'
import base from './vitest.mote-context.config.mts'

export default defineConfig({
  ...base,
  test: { ...base.test, include: ['apps/desktop/test/hidden-session-presentation.test.tsx'], passWithNoTests: false }
})
