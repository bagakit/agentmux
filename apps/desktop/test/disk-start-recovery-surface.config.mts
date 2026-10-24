import assert from 'node:assert/strict'
import { defineConfig } from 'vitest/config'
import source from './vitest.mote-context.config.mts'
export default defineConfig({ ...source, plugins: [{ name: 'original-storage-wait-mutations', enforce: 'pre', transform(code, id) {
  const mutant = process.env.AGENTMUX_STORAGE_WAIT_MUTANT
  if (!mutant) return
  const changes: Record<string, [string, string, string]> = {
    'duplicate-global-notice': ['lib/session-state.ts',
      'if (core.agentSessionId && isPendingLaunchStorageWait(state.pendingAgentLaunches?.[core.agentSessionId], core.agentSessionId, event)) return null', ''],
    'wrong-host-owner': ['lib/session-state.ts', 'pending.request?.hostId === event.hostId', 'true'],
    'disconnected-pane': ['components/SessionPane.tsx', '!session ? pendingAgentLaunchStorageWait(pendingLaunch, sessionId) : undefined', 'undefined'],
    'queued-wait-resurrection': ['lib/session-state.ts', "if (session?.kind === 'agent' && core.code === 'AGENT_CREATION_WAITING_FOR_STORAGE') return null", ''],
    'stale-wait-after-stop': ['lib/session-state.ts', "latest.event.agentSessionId !== agentSessionId) continue",
      "latest.event.agentSessionId !== agentSessionId || latest.event.code !== 'AGENT_CREATION_WAITING_FOR_STORAGE') continue"]
  }
  const change = changes[mutant]; assert(change, 'Known storage wait mutant')
  if (!id.endsWith(change[0])) return
  assert.equal(code.split(change[1]).length - 1, 1, 'Exact live source mutation')
  process.stderr.write(`MUTATION_APPLIED=${mutant}\n`)
  return { code: code.replace(change[1], change[2]), map: null }
} }], test: { ...source.test, setupFiles: [], globalSetup: [],
  include: ['apps/desktop/test/disk-start-recovery-surface.test.tsx'], passWithNoTests: false, maxWorkers: 1, fileParallelism: false } })
