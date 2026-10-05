import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../demand-activity/vitest.config.mts'
const repository = resolve(import.meta.dirname, '../../../../..')
// Read current exported Sources and the installed dependency. No install or dist mutation.
export default defineConfig({ ...original,
  resolve: { ...original.resolve, alias: [
    { find: /^@scure\/base$/, replacement: resolve(repository, 'node_modules/.pnpm/@scure+base@2.2.0/node_modules/@scure/base/index.js') },
    ...(original.resolve?.alias as Array<{ find: RegExp; replacement: string }> ?? [])
  ] },
  test: { ...original.test, include: ['test/mote-daily-goal.test.tsx', 'test/mote-daily-goal-owner.test.ts', 'test/continuous-progress-loop-manager.test.ts'], passWithNoTests: false, maxWorkers: 1 }
})
