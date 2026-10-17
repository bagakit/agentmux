import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import current from '../../../test/vitest.mote-context.config.mts'
const root = resolve(import.meta.dirname, '../../../../..')
export default defineConfig({
  ...current, root, cacheDir: resolve(root, '.tmp/mote-context-budget-cache'),
  plugins: [...(current.plugins ?? []), { name: 'mote-budget-production-mutant', enforce: 'pre',
    transform(code, id) {
      if (process.env.MOTE_BOUNDARY_MUTANT_OWNER && id.split('?')[0] === resolve(root, process.env.MOTE_BOUNDARY_MUTANT_OWNER)) {
        return { code: readFileSync(process.env.MOTE_BOUNDARY_MUTANT_COPY!, 'utf8'), map: null }
      }
    }
  }],
  test: { ...current.test, setupFiles: [resolve(root, 'apps/desktop/scripts/fixtures/agent-schedules/isolate-core.mjs')],
    include: ['apps/desktop/test/mote-context-files.test.ts', 'apps/desktop/test/mote-default-knowledge.test.ts',
      'apps/desktop/test/scratch-topics.test.ts', 'apps/desktop/test/topic-wiki-injection.test.ts',
      'packages/core/test/agent-outbound-message.test.ts', 'packages/core/test/remote-initial-creation.test.ts'],
    testTimeout: 30000, hookTimeout: 30000 }
})
