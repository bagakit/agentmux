import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
import original from './performance-capture.config.mts'

export default defineConfig({ ...original, cacheDir: process.env.AGENTMUX_ANIMATIONS_GUI_CACHE ?? resolve(original.root!, '.cache/performance-animations'),
  test: { ...original.test, include: ['apps/desktop/test/performance-animations.test.tsx'],
    globalSetup: [], setupFiles: [], maxWorkers: 1, fileParallelism: false, passWithNoTests: false } })
