import { defineConfig } from 'vitest/config'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import ui from './vitest.ui.config.mts'
const root = fileURLToPath(new URL('../../../../../', import.meta.url))
export default defineConfig({ root, plugins: [{ name: 'check-in-loaded-source', enforce: 'pre', transform(source, id) {
  const owner = id.split('?')[0], relative = owner.slice(root.length)
  if (!/^(?:packages\/core\/src\/|apps\/desktop\/src\/)/u.test(relative) || !owner.endsWith('.ts') && !owner.endsWith('.tsx')) return
  const mutant = process.env.AGENT_SCHEDULE_MUTANT_OWNER === owner ? readFileSync(process.env.AGENT_SCHEDULE_MUTANT_COPY, 'utf8') : source
  if (process.env.AGENT_SCHEDULE_CHECKIN_LOADED) appendFileSync(process.env.AGENT_SCHEDULE_CHECKIN_LOADED, JSON.stringify({ path: relative, originalSha256: createHash('sha256').update(source).digest('hex'), loadedSha256: createHash('sha256').update(mutant).digest('hex') }) + '\n')
  if (source !== mutant) return { code: mutant, map: null }
} }], resolve: ui.resolve, define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, test: { setupFiles: ui.test.setupFiles, include: ['apps/desktop/test/agent-schedule-check-in.test.ts', 'apps/desktop/test/calendar-schedule-control.test.tsx', 'packages/core/test/native-source-reconciliation.test.ts'], maxWorkers: 1, passWithNoTests: false, testTimeout: 20000 } })
