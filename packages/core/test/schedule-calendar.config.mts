import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({ root: resolve(import.meta.dirname, '../../..'), test: {
  include: ['packages/core/test/schedule-calendar.test.ts'], environment: 'node', passWithNoTests: false
} })
