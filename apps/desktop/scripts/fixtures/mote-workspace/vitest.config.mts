import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import owning from '../mote-navigation-footer/vitest.owning.config.mts'

export default defineConfig({ ...owning, plugins: [{
  name: 'mote-workspace-production-proof', enforce: 'pre',
  load(id) {
    if (id.split('?')[0] === process.env.MOTE_WORKSPACE_MUTANT_OWNER)
      return readFileSync(process.env.MOTE_WORKSPACE_MUTANT_COPY!, 'utf8')
  },
  transform(source, id) {
    const file = id.split('?')[0]!
    if (process.env.MOTE_WORKSPACE_SOURCE_RECEIPT && !file.includes('/node_modules/') && /\/(apps\/desktop|packages)\//.test(file))
      appendFileSync(process.env.MOTE_WORKSPACE_SOURCE_RECEIPT, JSON.stringify({ path: file, sha256: createHash('sha256').update(source).digest('hex') }) + '\n')
  }
}], test: { ...owning.test,
  setupFiles: [resolve(import.meta.dirname, '../agent-schedules/isolate-core.mjs'), ...owning.test!.setupFiles as string[]],
  include: ['test/mote-workspace.test.tsx', 'test/mote-cooperation.test.tsx', 'test/mote-ideas.test.tsx', 'test/mote-materials-inspection.test.tsx', 'test/mote-daily-work.test.tsx', 'test/mote-memory-profile.test.tsx'],
  passWithNoTests: false, maxWorkers: 1, testTimeout: 15000
} })
