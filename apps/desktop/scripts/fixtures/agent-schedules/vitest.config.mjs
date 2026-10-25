import { defineConfig } from 'vitest/config'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../../../../../', import.meta.url))
const core = JSON.parse(readFileSync(root + 'packages/core/package.json', 'utf8'))
const alias = Object.entries(core.exports).filter(([key, value]) => !key.includes('*') && value.import).map(([key, value]) => ({
  find: key === '.' ? '@agentmux/core' : '@agentmux/core/' + key.slice(2),
  replacement: root + 'packages/core/' + value.import.replace('./dist/', 'src/').replace(/\.js$/, '.ts')
})).sort((a, b) => b.find.length - a.find.length)
const host = JSON.parse(readFileSync(root + 'apps/host/package.json', 'utf8'))
alias.unshift(...Object.entries(host.exports).filter(([key, value]) => !key.includes('*') && value.import).map(([key, value]) => ({
  find: key === '.' ? '@agentmux/host' : '@agentmux/host/' + key.slice(2),
  replacement: root + 'apps/host/' + value.import.replace('./dist/', 'src/').replace(/\.js$/, '.ts')
})).sort((a, b) => b.find.length - a.find.length))
export default defineConfig({ root, plugins: [{ name: 'isolated-production-mutant', enforce: 'pre', load(id) { if (process.env.AGENT_SCHEDULE_MUTANT_OWNER === id.split('?')[0]) return readFileSync(process.env.AGENT_SCHEDULE_MUTANT_COPY, 'utf8') } }], resolve: { alias }, define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, test: { setupFiles: [root + 'apps/desktop/scripts/fixtures/agent-schedules/isolate-core.mjs'], include: ['apps/desktop/test/agent-schedules.test.ts', 'apps/desktop/test/continuous-progress-loop-manager.test.ts', 'apps/desktop/test/continuous-progress-loop-store.test.ts', 'packages/core/test/client-submit-prompt-run-binding.test.ts', 'packages/core/test/continuous-progress.test.ts', 'packages/core/test/continuous-progress-scheduler.test.ts', 'packages/core/test/schedule-cli-discovery.test.ts', 'packages/core/test/schedule-calendar.test.ts', 'apps/desktop/test/schedule-directory-scope.test.ts'], maxWorkers: 1, testTimeout: 20000 } })
