import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { staleDistComplaint } from '../../../vitest.dist-freshness'
import owning from './mote-session-recovery.config.mts'

const repository = resolve(import.meta.dirname, '../../..')
const identityIssue = await staleDistComplaint(resolve(repository, 'packages/identity'), 'dist/runtime-source.js')
if (identityIssue) throw Error(identityIssue)
const caller = 'apps/desktop/src/renderer/src/lib/mote-session-recovery.ts'
const owners = [caller, 'apps/desktop/src/renderer/src/store.ts', 'packages/core/src/agent-session-recovery/continuity-attempt.ts',
  'packages/core/src/agent-session-recovery/continuity-policy.ts', 'packages/core/src/agent-session-recovery/supervisor.ts']
export default defineConfig({ ...owning, resolve: { ...owning.resolve, alias: [
  { find: /^@agentmux\/identity\/runtime-source$/, replacement: resolve(repository, 'packages/identity/dist/runtime-source.js') },
  ...owning.resolve!.alias as import('vite').Alias[]
] }, plugins: [...owning.plugins ?? [], {
  name: 'mote-startup-original-core-consumer', enforce: 'pre', transform(source, id) {
    const path = relative(repository, id.split('?')[0]!)
    if (!owners.includes(path)) return
    const before = source, mutation = process.env.AMX_MOTE_STARTUP_MUTATION
    if (path === caller && mutation) {
      if (mutation !== 'old-startup-alias') throw Error('Unknown Mote startup mutation: ' + mutation)
      const anchor = "recoverOriginal(session, eligible, 'startup',"
      if (source.split(anchor).length !== 2) throw Error('Mote startup mutation anchor is not unique')
      source = source.replace(anchor, "recoverOriginal(session, eligible, mode === 'ordinary' ? 'startup' : 'workspace-startup',")
    }
    if (process.env.AMX_MOTE_STARTUP_LOADED) appendFileSync(process.env.AMX_MOTE_STARTUP_LOADED,
      JSON.stringify({ path, originalSHA256: createHash('sha256').update(before).digest('hex'),
        sha256: createHash('sha256').update(source).digest('hex'), ...(source !== before ? { mutation } : {}) }) + '\n')
    if (source !== before) return { code: source, map: null }
  }
}], test: { ...owning.test, include: ['test/mote-startup-continuity-consumer.test.tsx', 'test/mote-session-recovery.test.tsx',
  'test/mote-startup-recovery.test.ts', 'test/mote-quick-mode.test.tsx'], passWithNoTests: false, fileParallelism: false, maxWorkers: 1 } })
