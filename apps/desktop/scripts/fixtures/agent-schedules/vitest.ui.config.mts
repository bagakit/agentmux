import { readFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'
import owning from '../mote-navigation-footer/vitest.owning.config.mts'

export default defineConfig({ ...owning,
  plugins: [{ name: 'isolated-schedule-ui-mutant', enforce: 'pre', load(id) {
    if (process.env.AGENT_SCHEDULE_MUTANT_OWNER === id.split('?')[0]) return readFileSync(process.env.AGENT_SCHEDULE_MUTANT_COPY!, 'utf8')
  } }],
  test: { ...owning.test, include: ['test/calendar-schedule-control.test.tsx', 'test/continuous-progress-panel.test.tsx'], testTimeout: 15000 } })
