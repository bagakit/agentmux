import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import owning from '../agent-schedules/vitest.ui.config.mts'
export default defineConfig({ ...owning, plugins: [...owning.plugins!, { name: 'calendar-actual-loaded-source', enforce: 'pre', transform(source, id) {
  const file = id.split('?')[0]!
  if (process.env.MOTE_CALENDAR_SOURCE_RECEIPT && !file.includes('/node_modules/') && /\/(apps\/desktop|packages)\//.test(file))
    appendFileSync(process.env.MOTE_CALENDAR_SOURCE_RECEIPT, JSON.stringify({ path: file, sha256: createHash('sha256').update(source).digest('hex') }) + '\n')
} }], test: { ...owning.test,
  setupFiles: [resolve(import.meta.dirname, '../agent-schedules/isolate-core.mjs'), ...owning.test!.setupFiles as string[]],
  include: ['test/calendar-schedule-control.test.tsx', 'test/continuous-progress-panel.test.tsx', 'test/mote-calendar.test.tsx', 'test/mote-ideas.test.tsx'],
  passWithNoTests: false, maxWorkers: 1, testTimeout: 20000
} })
