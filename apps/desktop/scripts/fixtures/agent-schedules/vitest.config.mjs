import { defineConfig } from 'vitest/config'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../../../../../', import.meta.url))
export default defineConfig({ root, plugins: [{ name: 'isolated-production-mutant', enforce: 'pre', load(id) { if (process.env.AGENT_SCHEDULE_MUTANT_OWNER === id.split('?')[0]) return readFileSync(process.env.AGENT_SCHEDULE_MUTANT_COPY, 'utf8') } }], resolve: { alias: { '@agentmux/core': root + 'packages/core/src/index.ts' } }, define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, test: { include: ['apps/desktop/test/agent-schedules.test.ts', 'apps/desktop/test/continuous-progress-loop-manager.test.ts', 'apps/desktop/test/continuous-progress-loop-store.test.ts', 'packages/core/test/client-submit-prompt-run-binding.test.ts', 'packages/core/test/continuous-progress.test.ts', 'packages/core/test/continuous-progress-scheduler.test.ts'], maxWorkers: 1, testTimeout: 20000 } })
