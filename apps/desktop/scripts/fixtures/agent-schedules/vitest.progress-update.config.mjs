import { defineConfig } from 'vitest/config'
import base from './vitest.config.mjs'

export default defineConfig({ ...base, test: { ...base.test, include: ['apps/desktop/test/continuous-progress-loop-manager.test.ts', 'apps/desktop/test/continuous-progress-update-cli.test.ts'] } })
