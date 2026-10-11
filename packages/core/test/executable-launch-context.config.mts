import { defaultExclude, defineConfig } from 'vitest/config'
import repository from '../../../vitest.config.js'

export default defineConfig({ ...repository, test: { ...repository.test,
  include: ['packages/core/test/executable-launch-context.test.ts', 'packages/core/test/client-executor-availability.test.ts', 'packages/core/test/doctor-unverifiable-vs-missing.test.ts', 'apps/desktop/test/executable-context-control.test.ts'],
  exclude: [...defaultExclude], maxWorkers: 1
} })
