import { defineConfig } from 'vitest/config'
import core from './vitest.core.config.mts'
export default defineConfig({ ...core, test: { ...core.test,
  include: ['apps/desktop/test/native-empty-reasoning-reading.test.tsx'] } })
