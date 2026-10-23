import { resolve } from 'node:path'
import base from './hook-postcommit-observation.vitest.config.mts'
const mutation = process.env.AGENTMUX_RECOVERY_MODULE_MUTATION
if (mutation && mutation !== 'unknown-as-missing') throw new Error('Unknown recovery module mutation')
export default { ...base, resolve: { alias: [{ find: '@agentmux/identity/runtime-source', replacement: resolve(import.meta.dirname, '../../identity/dist/runtime-source.js') }, ...base.resolve.alias] }, plugins: mutation ? [{ name: 'actual-recovery-owner-mutation', enforce: 'pre' as const,
  transform(code: string, id: string) {
    if (id.split('?')[0] !== resolve(import.meta.dirname, '../src/agent-session-recovery/service.ts')) return
    const original = "if (!(error instanceof AgentMuxError && error.code === 'CTXMUX_run_not_found')) {"
    if (code.split(original).length !== 2) throw new Error('Recovery mutation must match the actual owner exactly once')
    return { code: code.replace(original, 'if (false) {'), map: null }
  }
}] : [], test: { ...base.test, include: ['packages/core/test/agent-session-recovery-module.test.ts'], passWithNoTests: false, maxWorkers: 1 } }
