import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const root = resolve(import.meta.dirname, '../../..')
const activity = 'packages/core/src/agent-session-recovery/continuity-activity.ts'
const policy = 'packages/core/src/agent-session-recovery/continuity-policy.ts'
const attempt = 'packages/core/src/agent-session-recovery/continuity-attempt.ts'
const mutations: Record<string, Array<[string, string, string]>> = {
  'skip-native-end': [[activity, 'if (nativeObservedAt !== undefined) return nativeObservedAt', 'if (false) return nativeObservedAt']],
  'observer-time': [[activity, 'agentNativeTurnEnd(session, status.nativeTurnId)?.nativeObservedAt', 'agentNativeTurnEnd(session, status.nativeTurnId)?.observedAt']],
  'ignore-native-scope': [[activity, 'agentNativeTurnEnd(session, status.nativeTurnId)?.nativeObservedAt', 'session.nativeTurnEnds?.turns[status.nativeTurnId!]?.nativeObservedAt']],
  'ignore-consumed': [[policy, "if (status.state === 'done' && status.idleEvidenceConsumed)", 'if (false)']],
  'ignore-accepted-done-time': [[policy, "return { kind: 'resume', reason: 'confirmed-idle', interruptedWorking: false }", "return status.stateEnteredAt === undefined ? { kind: 'pending', reason: 'idle-unknown' } : { kind: 'resume', reason: 'confirmed-idle', interruptedWorking: false }"]],
  'skip-consumer': [[attempt, 'const lastActivityAt = agentContinuityLastActivityAt(current)', 'const lastActivityAt = undefined']]
}

export default defineConfig({ root, cacheDir: resolve(root, '.local/cache/startup-recovery-activity'), plugins: [{
  name: 'startup-recovery-activity-proof', enforce: 'pre', transform(code, id) {
    const path = relative(root, id.split('?')[0]!)
    if (![activity, policy, attempt].includes(path)) return
    const original = code, mutation = process.env.AMX_STARTUP_ACTIVITY_MUTATION
    if (mutation) {
      const edits = mutations[mutation]
      if (!edits) throw new Error('Unknown activity mutation: ' + mutation)
      for (const [target, anchor, replacement] of edits) if (path === target) {
        if (code.split(anchor).length !== 2) throw new Error('Mutation anchor not unique: ' + mutation)
        code = code.replace(anchor, replacement)
      }
    }
    if (process.env.AMX_STARTUP_ACTIVITY_LOADED) appendFileSync(process.env.AMX_STARTUP_ACTIVITY_LOADED,
      JSON.stringify({ path, originalSHA256: createHash('sha256').update(original).digest('hex'),
        sha256: createHash('sha256').update(code).digest('hex'), ...(code !== original ? { mutation } : {}) }) + '\n')
    if (code !== original) return { code, map: null }
  }
}], test: { include: ['packages/core/test/startup-recovery-activity.test.ts', 'packages/core/test/agent-semantic-state-entry.test.ts',
  'packages/core/test/agent-session-continuity.test.ts'], passWithNoTests: false, fileParallelism: false, maxWorkers: 1,
  testTimeout: 20_000, hookTimeout: 15_000 } })
